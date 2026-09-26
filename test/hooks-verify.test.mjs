import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';
import { buildVerify, decideVerify } from '../lib/questions.mjs';
import { loadConfig } from '../lib/config.mjs';

let backend;
let dir;
before(async () => {
  backend = await startMockBackend({ answers: claim(0.92, 0.05) });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-verify-'));
});
after(async () => {
  await backend.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function claim(claims, admits) {
  return { claims_verified: { type: 'noul', noul: claims }, admits_unverified: { type: 'noul', noul: admits } };
}

const CWD = '/work/app';
const tool = (name, toolInput) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: toolInput }] } });
const edit = (file) => tool('Edit', { file_path: path.join(CWD, file), old_string: 'a', new_string: 'b' });
const bash = (command) => tool('Bash', { command });
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });

let n = 0;
function transcript(entries) {
  const file = path.join(dir, `t${n++}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const REPLY = 'I updated the payment matcher and the tests pass. Everything works now.';
const input = (file, extra = {}) => JSON.stringify({
  session_id: 's', cwd: CWD, hook_event_name: 'Stop', transcript_path: file,
  stop_hook_active: false, last_assistant_message: REPLY, background_tasks: [], session_crons: [], ...extra,
});
const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'sk-test-verify-key', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);
const run = (file, extra, envExtra) => runScript('hooks/verify-stop.mjs', { input: input(file, extra), env: env(envExtra) });

test('buildVerify sends only the tail of the reply and asks two yes/no questions', () => {
  const { state, questions } = buildVerify({ reply: `${'x'.repeat(6000)} tests pass` });
  assert.ok(state.assistant_reply.length <= 4000);
  assert.ok(state.assistant_reply.endsWith('tests pass'));
  assert.deepEqual(Object.keys(questions), ['claims_verified', 'admits_unverified']);
  assert.equal(questions.claims_verified.type, 'noul');
  const cfg = loadConfig({});
  assert.deepEqual(decideVerify(claim(0.7, 0.49), cfg), { nudge: true, claim: 0.7, admits: 0.49 });
  assert.equal(decideVerify(claim(0.69, 0), cfg).nudge, false);
  assert.equal(decideVerify(claim(0.95, 0.5), cfg).nudge, false);
  assert.equal(decideVerify({}, cfg).nudge, false);
});

test('edited code, no test afterwards, and a verification claim → Stop feedback naming the files', async () => {
  backend.requests.length = 0;
  const file = transcript([prompt('fix the matcher'), edit('src/match.ts'), edit('src/match.test.ts')]);
  const r = await run(file);
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'Stop');
  const text = out.hookSpecificOutput.additionalContext;
  assert.ok(text.startsWith('[Jev verify]'), text);
  assert.ok(text.includes('src/match.ts') && text.includes('src/match.test.ts'), text);
  assert.equal(out.decision, undefined, 'feedback, not a block');
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.requests[0].body.state.assistant_reply, REPLY);
});

test('verification after the last edit, no edits, delegated or browser checks → no Jev call', async () => {
  backend.requests.length = 0;
  for (const entries of [
    [prompt('fix'), edit('src/a.ts'), bash('npm test')],
    [prompt('look'), bash('ls -la'), bash('git status')],
    [prompt('fix'), edit('src/a.ts'), tool('Agent', { prompt: 'run the test suite' })],
    [prompt('fix'), edit('src/a.ts'), tool('mcp__Claude_Browser__computer', { action: 'screenshot' })],
    [prompt('docs'), edit('README.md')],
    [prompt('old'), edit('src/old.ts'), prompt('now just explain it')],
  ]) {
    assert.equal(parse(await run(transcript(entries))), null, JSON.stringify(entries.at(-1)));
  }
  assert.equal(backend.requests.length, 0);
});

test('SubagentStop reads the subagent transcript and keeps the subagent working', async () => {
  backend.requests.length = 0;
  const sub = transcript([prompt('implement the matcher in a worktree'), edit('src/match.ts')]);
  const r = await runScript('hooks/verify-stop.mjs', {
    input: input('/nonexistent/main.jsonl', { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'general-purpose', agent_transcript_path: sub }),
    env: env(),
  });
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStop');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('src/match.ts'));
  assert.equal(backend.requests.length, 1);
});

test('a SubagentHandback report is judged instead of the closing text', async () => {
  backend.requests.length = 0;
  const handback = tool('SubagentHandback', { message: 'Implemented the matcher; the full test suite passes.' });
  const sub = transcript([prompt('implement'), edit('src/match.ts'), handback]);
  await runScript('hooks/verify-stop.mjs', {
    input: input('/nonexistent/main.jsonl', { hook_event_name: 'SubagentStop', agent_transcript_path: sub, last_assistant_message: '' }),
    env: env(),
  });
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.requests[0].body.state.assistant_reply, 'Implemented the matcher; the full test suite passes.');
});

test('internal agents (empty agent_type) and a missing subagent transcript are skipped', async () => {
  backend.requests.length = 0;
  const sub = transcript([prompt('suggest'), edit('src/match.ts')]);
  const internal = await runScript('hooks/verify-stop.mjs', { input: input('/nonexistent/main.jsonl', { hook_event_name: 'SubagentStop', agent_type: '', agent_transcript_path: sub }), env: env() });
  assert.equal(internal.stdout, '');
  const missing = await runScript('hooks/verify-stop.mjs', { input: input('/nonexistent/main.jsonl', { hook_event_name: 'SubagentStop', agent_type: 'general-purpose' }), env: env() });
  assert.equal(missing.code, 0);
  assert.equal(missing.stdout, '');
  assert.equal(backend.requests.length, 0);
});

test('a test run before the last edit does not count', async () => {
  backend.requests.length = 0;
  const out = parse(await run(transcript([prompt('fix'), edit('src/a.ts'), bash('npm test'), edit('src/a.ts')])));
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith('[Jev verify]'));
  assert.equal(backend.requests.length, 1);
});

test('honest replies and low-confidence claims pass through', async () => {
  const file = transcript([prompt('fix'), edit('src/a.ts')]);
  backend.setAnswers(claim(0.9, 0.8));
  assert.equal(parse(await run(file)), null);
  backend.setAnswers(claim(0.3, 0.1));
  assert.equal(parse(await run(file)), null);
  backend.setAnswers(claim(0.92, 0.05));
});

test('loop guard, disabled flag, missing key, missing transcript, short reply, backend down → nothing, exit 0', async () => {
  backend.requests.length = 0;
  const file = transcript([prompt('fix'), edit('src/a.ts')]);
  assert.equal(parse(await run(file, { stop_hook_active: true })), null);
  assert.equal(parse(await run(file, {}, { JEV_VERIFY: '0' })), null);
  assert.equal(parse(await run(file, { last_assistant_message: 'ok' })), null);
  assert.equal(parse(await run('/nonexistent/t.jsonl')), null);
  assert.equal(parse(await run(file, { hook_event_name: 'PreToolUse' })), null);
  assert.equal(backend.requests.length, 0);
  const noKey = await runScript('hooks/verify-stop.mjs', { input: input(file), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.stdout, '');
  const down = await run(file, {}, { JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '300' });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, '');
});
