// lib/transcript.mjs — reads the tail of a Claude Code transcript (JSONL) and summarises the current
// turn: which project files were edited and whether anything verified them after the last edit.
// Everything here fails soft: an unreadable transcript is an empty turn, and doubtful cases count as
// verified, because a missed nudge is cheaper than a wrong "you ran no test".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allHeads } from './shell-words.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);
const BROWSER_TOOL = /^mcp__(Claude_Browser|claude-in-chrome|Claude_Code_iOS_Simulator|playwright|puppeteer)/i;
// Harness-generated user entries that are not a person's request.
// A slash command the user typed (<command-name>) is a request and does start a turn.
const SYSTEM_PROMPT = /^(<(task-notification|agent-message|local-command-[\w-]+|bash-(input|stdout|stderr))\b|\[Request interrupted|This session is being continued|Stop hook feedback|Caveat: The messages below)/;
const MAX_PARSE = 32768;
const END = String.raw`(?=[\s;&|)'"]|$)`;

// Runner invocations recognised anywhere in a command segment.
const RUNNER = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\b[^|;&\n]{0,120}?\s(run\s+)?(test|t|check|verify|typecheck|type-check|lint|build|e2e|ci)([:_-][\w:-]*)?${END}`,
  String.raw`\b(npm|pnpm|yarn|bun)\b[^|;&\n]{0,120}?\srun\s+(tsc|vitest|jest|mocha|playwright|cypress|eslint|biome|vue-tsc|svelte-check)${END}`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest|mypy)\b`,
  String.raw`\bgo\s+(test|vet|build)\b`,
  String.raw`\bcargo\s+(test|nextest|check|clippy|build)\b`,
  String.raw`\b(mvn|gradle|gradlew)\b[^|;&\n]{0,120}\b(test|verify|check|build)\b`,
  String.raw`\bdotnet\s+(test|build)\b`,
  String.raw`\b(rake|mix|deno|swift)\s+test\b`,
  String.raw`\bphp\s+artisan\s+test\b`,
  String.raw`\bxcodebuild\b[^|;&\n]{0,200}\b(test|build)\b`,
  String.raw`\bmake\s+(test|check|verify|build)\b`,
  String.raw`\b(turbo|nx|just|task|composer)\b[^|;&\n]{0,80}\b(test|check|build|lint|typecheck)\b`,
  String.raw`\bcurl\b[^|;&\n]{0,300}\b(localhost|127\.0\.0\.1)\b`,
  // Applying SQL files to a (scratch) database is how schema and migration files get checked.
  String.raw`\b(psql|sqlite3|mysql|mariadb)\b[^|;&\n]{0,300}(\s-f\s*\S+\.sql\b|<\s*\S+\.sql\b)`,
].join('|'));
// Test and check tools recognised only as the command word (so `grep jest package.json` is not a run).
const VERIFY_TOOLS = new Set(['vitest', 'jest', 'mocha', 'ava', 'playwright', 'cypress', 'pytest', 'tox', 'nox', 'rspec', 'phpunit', 'pest', 'tsc', 'eslint', 'ruff', 'mypy', 'pyright', 'biome', 'stylelint', 'golangci-lint', 'swiftlint', 'rubocop', 'flake8', 'pylint', 'vue-tsc', 'svelte-check']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'deno', 'bun', 'tsx', 'ts-node', 'ruby', 'php', 'perl', 'go']);
const TEST_SCRIPT = /^(test|tests|check|e2e|verify)[\w.-]*\.(sh|mjs|js|ts|py)$/;

export function readTail(file, maxBytes = 4 * 1024 * 1024) {
  try {
    if (!file) return '';
    const resolved = String(file).replace(/^~(?=\/|$)/, os.homedir());
    const { size } = fs.statSync(resolved);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(resolved, 'r');
    try {
      fs.readSync(fd, buf, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  }
}

export function parseEntries(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn or foreign line; skip it.
    }
  }
  return entries;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

// A message a person sent. Newer transcripts mark them with origin.kind === 'human'; entries without an
// origin (older transcripts, a subagent's task prompt) fall back to excluding known harness messages.
function isBoundary(entry) {
  if (entry?.type !== 'user' || entry.isMeta) return false;
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return false;
  const text = textOf(content).trim();
  if (!text) return false;
  if (entry.origin && typeof entry.origin.kind === 'string') return entry.origin.kind === 'human';
  return !SYSTEM_PROMPT.test(text);
}

export function currentTurn(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isBoundary(entries[i])) return entries.slice(i + 1);
  }
  return entries.slice();
}

function toolUses(entries) {
  const uses = [];
  for (const entry of entries) {
    if (entry?.type !== 'assistant') continue;
    for (const block of entry.message?.content || []) {
      if (block?.type === 'tool_use') uses.push(block);
    }
  }
  return uses;
}

// The report a subagent delivered through the SubagentHandback tool (auto mode), if any.
export function handbackReport(turn) {
  const handback = toolUses(turn).filter((u) => u.name === 'SubagentHandback').at(-1);
  const message = handback?.input?.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

// Working directories recorded on transcript entries (a worktree for isolated agents).
export function turnCwd(turn) {
  for (let i = turn.length - 1; i >= 0; i--) {
    if (typeof turn[i]?.cwd === 'string' && turn[i].cwd) return turn[i].cwd;
  }
  return null;
}

export function firstCwd(turn) {
  for (const entry of turn) {
    if (typeof entry?.cwd === 'string' && entry.cwd) return entry.cwd;
  }
  return null;
}

function realish(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return path.resolve(p);
    }
  }
}

function projectFile(filePath, roots) {
  if (!filePath) return null;
  for (const root of roots) {
    const base = realish(path.resolve(root));
    const abs = realish(path.resolve(root, String(filePath)));
    const rel = path.relative(base, abs);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    return rel.split(path.sep).join('/');
  }
  return null;
}

const TOOL_HOSTS = new Set(['npx', 'bunx', 'pnpm', 'yarn', 'npm']);
// Package management mentions tool names without running them (`npm install eslint`).
const PACKAGE_COMMANDS = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'ci', 'update', 'up', 'upgrade', 'view', 'info', 'show', 'ls', 'list', 'why', 'outdated', 'link', 'unlink', 'pack', 'publish', 'init', 'create', 'dlx', 'audit', 'dedupe', 'prune']);
const LAUNCHERS = new Set([...INTERPRETERS, ...TOOL_HOSTS, 'uv', 'poetry']);

function bashVerifies(command, edits) {
  if (RUNNER.test(command)) return true;
  // Huge commands (generated files written with printf or heredocs) are not test runs; skip parsing.
  if (command.length > MAX_PARSE) return false;
  const heads = allHeads(command);
  for (const words of heads) {
    const base = words[0].split('/').pop();
    const next = words.slice(1).find((a) => !a.startsWith('-'));
    if (VERIFY_TOOLS.has(base)) return true;
    // `pnpm --filter web vitest run`, `npx nx vitest`, `docker compose exec web pytest`
    if (TOOL_HOSTS.has(base) && !PACKAGE_COMMANDS.has(next) && words.slice(1).some((w) => VERIFY_TOOLS.has(w))) return true;
    if (base === 'docker' && /\b(exec|run)\b/.test(words.join(' ')) && words.some((w) => VERIFY_TOOLS.has(w))) return true;
    if (TEST_SCRIPT.test(base)) return true;
    if (INTERPRETERS.has(base) && next && TEST_SCRIPT.test(next.split('/').pop())) return true;
  }
  // Running the file that was just edited (a script, a hook, a module import) exercises it.
  const runsSomething = heads.some((words) => LAUNCHERS.has(words[0].split('/').pop()) || words[0].includes('/'));
  if (!runsSomething) return false;
  return edits.some((rel) => {
    if (command.includes(rel)) return true;
    const name = rel.split('/').pop();
    return name.length >= 5 && name.includes('.') && command.includes(name);
  });
}

export function analyzeTurn(turn, { cwd, roots } = {}) {
  const bases = [...new Set((roots ?? [cwd]).filter(Boolean))];
  const uses = toolUses(turn);
  const edits = [];
  let lastEdit = -1;
  uses.forEach((use, i) => {
    if (!EDIT_TOOLS.has(use.name)) return;
    const rel = projectFile(use.input?.file_path ?? use.input?.notebook_path, bases);
    if (!rel || DOC_FILE.test(rel)) return;
    if (!edits.includes(rel)) edits.push(rel);
    lastEdit = i;
  });
  let verification = null;
  if (lastEdit >= 0) {
    for (const use of uses.slice(lastEdit + 1)) {
      if (use.name === 'Bash' && bashVerifies(String(use.input?.command ?? ''), edits)) { verification = 'bash'; break; }
      if (BROWSER_TOOL.test(use.name)) { verification = 'browser'; break; }
      if (DELEGATION_TOOLS.has(use.name)) { verification = 'delegated'; break; }
    }
  }
  return { edits, verifiedAfterEdit: verification !== null, verification };
}
