import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript, ROOT } from './helpers/spawn.mjs';

let backend;
before(async () => { backend = await startMockBackend({ answers: routed('fast', 0.9, 0.2) }); });
after(() => backend.close());

function routed(choice, confidence, stakes) {
  return {
    tier: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence },
    stakes: { type: 'score', score: stakes, confidence: 0.9, probabilities: {}, legend: {} },
  };
}

const input = (toolInput = {}, extra = {}) => JSON.stringify({
  session_id: 's1', cwd: '/tmp/proj', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
  tool_input: { prompt: 'Find every usage of parseConfig in src and list the files', description: 'Find parseConfig usages', subagent_type: 'Explore', ...toolInput },
  ...extra,
});

const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'test-key', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

test('routes a mechanical Explore task to haiku and keeps every other field', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/route-agent.mjs', { input: input(), env: env() });
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    prompt: 'Find every usage of parseConfig in src and list the files', description: 'Find parseConfig usages', subagent_type: 'Explore', model: 'haiku',
  });
  assert.equal(out.hookSpecificOutput.additionalContext, 'Jev routed this subagent to haiku (tier=fast, p=0.90, stakes=0.2).');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.requests[0].body.state.agent_type, 'Explore');
  assert.ok(backend.requests[0].body.questions.tier);
});

test('respects an explicit model unless override is on', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input({ model: 'opus' }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const out = parse(await runScript('hooks/route-agent.mjs', { input: input({ model: 'opus' }), env: env({ JEV_ROUTER_OVERRIDE: '1' }) }));
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('skips custom subagent types unless enabled', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input({ subagent_type: 'code-reviewer' }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const out = parse(await runScript('hooks/route-agent.mjs', { input: input({ subagent_type: 'code-reviewer' }), env: env({ JEV_ROUTER_CUSTOM_AGENTS: '1' }) }));
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('low confidence, strong tier, disabled router, other tools, missing key → no output', async () => {
  backend.setAnswers(routed('fast', 0.4, 0));
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input(), env: env() })), null);
  backend.setAnswers(routed('strong', 0.95, 2));
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input(), env: env() })), null);
  backend.setAnswers(routed('fast', 0.9, 0.2));
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input(), env: env({ JEV_ROUTER: '0' }) })), null);
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input({}, { tool_name: 'Bash' }), env: env() })), null);
  const noKey = await runScript('hooks/route-agent.mjs', { input: input(), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.code, 0);
  assert.equal(noKey.stdout, '');
});

test('backend down or failing is fail-open with exit 0', async () => {
  const down = await runScript('hooks/route-agent.mjs', { input: input(), env: env({ JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '500' }) });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, '');
  backend.queue(500, 'x'); backend.queue(500, 'x'); backend.queue(500, 'x');
  const failing = await runScript('hooks/route-agent.mjs', { input: input(), env: env({ JEV_HOOK_TIMEOUT_MS: '2000' }) });
  assert.equal(failing.code, 0);
  assert.equal(failing.stdout, '');
});

test('run-hook.sh finds node and runs the hook; unknown name is silent', async () => {
  const r = await runScript(path.join(ROOT, 'hooks/run-hook.sh'), { command: 'sh', args: ['route-agent'], input: input(), env: env() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(parse(r).hookSpecificOutput.updatedInput.model, 'haiku');
  const unknown = await runScript(path.join(ROOT, 'hooks/run-hook.sh'), { command: 'sh', args: ['nope'], input: input(), env: env() });
  assert.equal(unknown.code, 0);
  assert.equal(unknown.stdout, '');
});
