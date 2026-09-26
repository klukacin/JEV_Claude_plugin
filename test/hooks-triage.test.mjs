import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';

let backend;
before(async () => {
  backend = await startMockBackend({ answers: {
    kind: { type: 'choice', choice: 'debugging', probabilities: { debugging: 0.78 }, confidence: 0.7 },
    complexity: { type: 'score', score: 2.4, confidence: 0.66, probabilities: {}, legend: {} },
    needs_live_browser: { type: 'noul', noul: 0.06 },
    needs_web: { type: 'noul', noul: 0.81 },
    risk: { type: 'score', score: 1.1, confidence: 0.6, probabilities: {}, legend: {} },
  } });
});
after(() => backend.close());

const input = (prompt) => JSON.stringify({ session_id: 's', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt });
const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

test('a real request gets a triage note', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/triage-prompt.mjs', { input: input('The login page throws 500 after deploy, find out why and fix it'), env: env() });
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext,
    '[Jev triage] kind=debugging (p=0.78) · complexity=2.4/3 (conf 0.66) · live browser 0.06 · web info 0.81 · risk 1.1/2\n'
    + 'Hard task: plan first and keep it on the main model. Prefer WebSearch/WebFetch; a browser is not needed.');
  assert.equal(backend.requests[0].body.state.user_request, 'The login page throws 500 after deploy, find out why and fix it');
});

test('slash commands, short prompts, disabled triage, wrong event, missing key → no output', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input('/jev:status now please'), env: env() })), null);
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input('ok thanks'), env: env() })), null);
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input('Please refactor the whole auth module'), env: env({ JEV_TRIAGE: '0' }) })), null);
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: JSON.stringify({ hook_event_name: 'PreToolUse', prompt: 'Please refactor the whole auth module' }), env: env() })), null);
  for (const system of [
    'Another Claude session sent a message while you were working:\n<agent-message from="a7">report</agent-message>',
    '[Request interrupted by user] and more words here',
    '<task-notification> <task-id>a03df3dc5ac081940</task-id> <status>completed</status> </task-notification>',
    '<system-reminder>Background agent finished.</system-reminder>\n<task-notification> <task-id>a1</task-id> </task-notification>',
    '<command-name>/model</command-name> <command-args>claude-opus-5-5</command-args>',
    '<local-command-stdout>Set model to claude-opus-5-5</local-command-stdout>',
  ]) {
    assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input(system), env: env() })), null, system);
  }
  assert.equal(backend.requests.length, 0);
  const noKey = await runScript('hooks/triage-prompt.mjs', { input: input('Please refactor the whole auth module'), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.code, 0);
  assert.equal(noKey.stdout, '');
});

test('backend failure is fail-open', async () => {
  const r = await runScript('hooks/triage-prompt.mjs', { input: input('Please refactor the whole auth module'), env: env({ JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '300' }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('a real request that starts with system-reminder blocks is triaged on the text after them', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/triage-prompt.mjs', { input: input('<system-reminder>Codebase notes</system-reminder>\nThe login page throws 500 after deploy, find out why'), env: env() });
  assert.ok(parse(r).hookSpecificOutput.additionalContext.startsWith('[Jev triage]'));
  assert.equal(backend.requests[0].body.state.user_request, 'The login page throws 500 after deploy, find out why');
});
