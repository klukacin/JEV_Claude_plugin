import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { startMcp } from './helpers/spawn.mjs';
import { isMainModule } from '../server/mcp.mjs';

let backend;
let mcp;
before(async () => {
  backend = await startMockBackend();
  mcp = startMcp({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url });
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'jev');
  assert.ok(init.result.instructions.includes('Jev'));
  mcp.notify('notifications/initialized');
});
after(async () => { await mcp.close(); await backend.close(); });

test('tools/list exposes the core tools with object schemas and read-only annotations', async () => {
  const res = await mcp.request('tools/list');
  const names = res.result.tools.map((t) => t.name);
  for (const n of ['decide', 'choose', 'score', 'check']) assert.ok(names.includes(n), n);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, t.name);
    assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: true });
  }
});

test('choose returns the winner with probabilities and confidence', async () => {
  backend.setAnswers({ result: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.88 } });
  const r = await mcp.call('choose', { state: 'My card was charged twice', instructions: 'What is this about?', options: { billing: 'money', technical: 'bugs' } });
  assert.equal(r.isError, false);
  assert.deepEqual(r.json, { choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.88 });
  const sent = backend.requests.at(-1).body;
  assert.deepEqual(sent.questions, { result: { type: 'choice', instructions: 'What is this about?', criteria: { billing: 'money', technical: 'bugs' } } });
  assert.equal(sent.model, 'jev-latest');
});

test('score returns the fractional score, nearest level, and legend', async () => {
  backend.setAnswers({ result: { type: 'score', score: 1.3, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, legend: { 0: 'low', 1: 'mid', 2: 'high' }, confidence: 0.54 } });
  const r = await mcp.call('score', { state: 'x', instructions: 'How urgent?', levels: ['low', 'mid', 'high'], model: 'jev-preview' });
  assert.deepEqual(r.json, { score: 1.3, max: 2, nearest_level: 1, nearest_level_description: 'mid', legend: { 0: 'low', 1: 'mid', 2: 'high' }, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, confidence: 0.54 });
  assert.equal(backend.requests.at(-1).body.model, 'jev-preview');
});

test('check returns probability and likely flag, passing criteria through', async () => {
  backend.setAnswers({ result: { type: 'noul', noul: 0.72 } });
  const r = await mcp.call('check', { state: 'x', instructions: 'Is it urgent?', criteria: { true: 'yes', false: 'no' } });
  assert.deepEqual(r.json, { probability: 0.72, likely: true });
  assert.deepEqual(backend.requests.at(-1).body.questions.result.criteria, { true: 'yes', false: 'no' });
});

test('decide returns the raw answers and validates first', async () => {
  backend.setAnswers(null);
  const r = await mcp.call('decide', { state: { a: 1 }, questions: { u: { type: 'noul', instructions: 'q' }, k: { type: 'choice', instructions: 'q', criteria: { x: '', y: '' } } } });
  assert.equal(r.json.answers.u.noul, 0.5);
  assert.equal(r.json.answers.k.choice, 'x');
  assert.equal(r.json.model, 'jev-latest');
  const bad = await mcp.call('decide', { state: 'x', questions: { k: { type: 'choice', instructions: 'q' } } });
  assert.equal(bad.isError, true);
  assert.ok(bad.text.includes('k: choice needs criteria'));
  const empty = await mcp.call('decide', { state: 'x', questions: {} });
  assert.ok(empty.isError && empty.text.includes('non-empty'));
});

test('validation failures from the API surface as tool errors', async () => {
  const r = await mcp.call('check', { state: 'has __FAIL__ marker', instructions: 'q' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('422'));
});

test('without a key the server still starts and tools explain how to set one', async () => {
  const bare = startMcp({ JEV_BASE_URL: backend.url });
  try {
    await bare.request('initialize', { protocolVersion: '2025-06-18' });
    const r = await bare.call('check', { state: 'x', instructions: 'q' });
    assert.equal(r.isError, true);
    assert.ok(r.text.includes('TYPESAFE_API_KEY'));
  } finally {
    await bare.close();
  }
});

test('isMainModule returns true for real path, false for unrelated path, false for falsy', () => {
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const mcp = path.join(ROOT, 'server', 'mcp.mjs');
  assert.equal(isMainModule(mcp, import.meta.url), false); // different file
  assert.equal(isMainModule(mcp, new URL('file:///' + mcp)), true); // same file as URL
  assert.equal(isMainModule(null, import.meta.url), false); // falsy argv1
  assert.equal(isMainModule(undefined, import.meta.url), false); // falsy argv1
});

test('isMainModule works through symlinks', async () => {
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const tmp = fs.mkdtempSync(path.join('/tmp', 'jev-symlink-'));
  try {
    // Create a symlink to the server directory
    const serverLinkDir = path.join(tmp, 'server-link');
    fs.symlinkSync(path.join(ROOT, 'server'), serverLinkDir);
    const symlinkMcp = path.join(serverLinkDir, 'mcp.mjs');

    // Spawn node with the symlinked mcp.mjs
    const child = spawn('node', [symlinkMcp], {
      env: { ...process.env, TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    // Send initialize request
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }) + '\n');

    // Wait for response
    await new Promise((resolve) => {
      const checkResponse = () => {
        if (stdout.includes('serverInfo')) {
          child.kill();
          resolve();
        } else {
          setTimeout(checkResponse, 50);
        }
      };
      setTimeout(checkResponse, 50);
    });

    assert.ok(stdout.includes('serverInfo'), 'server should respond through symlink');
    assert.ok(stderr.includes('jev mcp ready'), 'startup message should be on stderr');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
