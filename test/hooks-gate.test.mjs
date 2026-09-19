import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';

let backend;
before(async () => { backend = await startMockBackend({ answers: risk(2.6) }); });
after(() => backend.close());

function risk(score, irreversible = 0.83, external = 0.12) {
  return {
    risk: { type: 'score', score, confidence: 0.7, probabilities: {}, legend: {} },
    irreversible: { type: 'noul', noul: irreversible },
    external: { type: 'noul', noul: external },
  };
}
const input = (command, description = 'clean up') => JSON.stringify({
  session_id: 's', cwd: '/Users/x/proj', permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't',
  tool_input: { command, description },
});
const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

test('dangerous command asks in the default mode with a Jev reason', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/gate-bash.mjs', { input: input('rm -rf ~/projects/old'), env: env() });
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.startsWith('Jev risk 2.6/3 (dangerous) · irreversible 0.83 · external 0.12 · Dangerous:'));
  assert.deepEqual(backend.requests[0].body.state, { command: 'rm -rf ~/projects/old', stated_intent: 'clean up', working_directory: 'proj' });
  assert.ok(!r.stdout.includes('"allow"'));
});

test('provably safe commands never call Jev', async () => {
  backend.requests.length = 0;
  for (const cmd of ['ls -la', 'git status', 'npm test', 'cat README.md | head -20']) {
    assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input(cmd), env: env() })), null, cmd);
  }
  assert.equal(backend.requests.length, 0);
});

test('moderate risk becomes advice, low risk nothing', async () => {
  backend.setAnswers(risk(1.5));
  const out = parse(await runScript('hooks/gate-bash.mjs', { input: input('sed -i "s/a/b/" config.yml'), env: env() }));
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith('[Jev gate] Jev risk 1.5/3 (needs review)'));
  backend.setAnswers(risk(0.3));
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('npm install'), env: env() })), null);
  backend.setAnswers(risk(2.6));
});

test('deny and advise modes', async () => {
  backend.setAnswers(risk(2.7));
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('git push --force origin main'), env: env({ JEV_GATE_MODE: 'deny' }) })).hookSpecificOutput.permissionDecision, 'deny');
  const advised = parse(await runScript('hooks/gate-bash.mjs', { input: input('git push --force origin main'), env: env({ JEV_GATE_MODE: 'advise' }) }));
  assert.equal(advised.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(advised.hookSpecificOutput.additionalContext.startsWith('[Jev gate] Jev risk 2.7/3 (dangerous)'));
  backend.setAnswers(risk(2.6));
});

test('disabled gate, empty command, wrong tool, missing key, backend down → nothing, exit 0', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('rm -rf x'), env: env({ JEV_GATE: '0' }) })), null);
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('   '), env: env() })), null);
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'x' } }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const noKey = await runScript('hooks/gate-bash.mjs', { input: input('rm -rf x'), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.stdout, '');
  const down = await runScript('hooks/gate-bash.mjs', { input: input('rm -rf x'), env: env({ JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '300' }) });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, '');
});
