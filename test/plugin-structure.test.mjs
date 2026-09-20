import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const executable = (rel) => { fs.accessSync(path.join(ROOT, rel), fs.constants.X_OK); return true; };

test('plugin manifest is valid', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(m.name, 'jev');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
  assert.equal(m.license, 'MIT');
});

test('marketplace lists the plugin at the repo root', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'jev');
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, 'jev');
  assert.equal(m.plugins[0].source, './');
});

test('package.json is ESM with no dependencies and no lockfile', () => {
  const p = readJson('package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(exists('package-lock.json'), false);
});

test('hooks.json wires the three hooks through the launcher with timeouts', () => {
  const h = readJson('hooks/hooks.json').hooks;
  const pre = h.PreToolUse.map((g) => [g.matcher, g.hooks[0].command]);
  assert.deepEqual(pre, [
    ['Agent', '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" route-agent'],
    ['Bash', '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" gate-bash'],
  ]);
  assert.equal(h.UserPromptSubmit[0].hooks[0].command, '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" triage-prompt');
  for (const group of [...h.PreToolUse, ...h.UserPromptSubmit]) {
    for (const hook of group.hooks) {
      assert.equal(hook.type, 'command');
      assert.equal(hook.timeout, 15);
      const name = hook.command.split(' ').at(-1);
      assert.ok(exists(`hooks/${name}.mjs`), name);
    }
  }
});

test('.mcp.json points at the launcher and launchers are executable', () => {
  const m = readJson('.mcp.json');
  assert.equal(m.mcpServers.jev.command, '${CLAUDE_PLUGIN_ROOT}/bin/jev-mcp');
  assert.ok(executable('bin/jev-mcp'));
  assert.ok(executable('hooks/run-hook.sh'));
  assert.ok(exists('lib/find-node.sh'));
  assert.ok(exists('server/mcp.mjs'));
});

test('skills have the required frontmatter', () => {
  const decisions = fs.readFileSync(path.join(ROOT, 'skills/jev-decisions/SKILL.md'), 'utf8');
  assert.match(decisions, /^---\nname: jev-decisions\n/);
  assert.match(decisions, /\nuser-invocable: false\n/);
  const description = decisions.match(/\ndescription: (.+)\n/)[1];
  assert.ok(description.length <= 1024, `description too long: ${description.length}`);
  const status = fs.readFileSync(path.join(ROOT, 'skills/status/SKILL.md'), 'utf8');
  assert.match(status, /^---\nname: status\n/);
  assert.match(status, /\ndisable-model-invocation: true\n/);
  assert.ok(status.includes('scripts/status.mjs'));
});

test('no file in the plugin contains a TypeSafe key', () => {
  const skip = new Set(['.git', 'node_modules', 'docs']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (skip.has(d.name) ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/TYPESAFE_API_KEY\s*[:=]\s*["']?ts[-_][A-Za-z0-9]{8,}/.test(text), `possible key in ${file}`);
  }
});

test('no hook can ever print an allow decision', () => {
  const dir = path.join(ROOT, 'hooks');
  const hooks = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(hooks.length >= 3, 'expected the three hook scripts');
  for (const file of hooks) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8')
      .split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
    assert.ok(!code.includes('"allow"'), `${file} must never emit "allow"`);
    assert.ok(!code.includes("'allow'"), `${file} must never emit 'allow'`);
  }
});

const hasClaude = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('claude plugin validate passes', { skip: !hasClaude && 'claude CLI not on PATH' }, () => {
  const out = execFileSync('claude', ['plugin', 'validate', '.'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.match(out, /Validation passed/);
});

test('claude plugin validate passes for the plugin manifest', { skip: !hasClaude && 'claude CLI not on PATH' }, () => {
  const out = execFileSync('claude', ['plugin', 'validate', '.claude-plugin/plugin.json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.match(out, /Validation passed/);
});
