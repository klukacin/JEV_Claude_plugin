import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';
import { modelNames } from '../scripts/status.mjs';

let backend;
before(async () => { backend = await startMockBackend(); });
after(() => backend.close());

test('modelNames accepts the documented and likely response shapes', () => {
  assert.deepEqual(modelNames({ models: [{ name: 'a' }, { id: 'b' }, 'c'] }), ['a', 'b', 'c']);
  assert.deepEqual(modelNames({ data: [{ name: 'a' }] }), ['a']);
  assert.deepEqual(modelNames([{ name: 'a' }]), ['a']);
  assert.deepEqual(modelNames({}), []);
});

test('status reports models, settings, and log tail with a key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-status-'));
  const logPath = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(logPath, `${JSON.stringify({ ts: 't', hook: 'gate-bash', decision: 'ask', score: 2.6 })}\n`);
  const r = await runScript('scripts/status.mjs', { env: { TYPESAFE_API_KEY: 'sk-abcd1234', JEV_BASE_URL: backend.url, JEV_LOG: logPath, JEV_GATE_MODE: 'deny' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('key: set (…1234)'));
  assert.ok(!r.stdout.includes('sk-abcd1234'));
  assert.ok(r.stdout.includes('models: jev-1.13.0, jev-latest'));
  assert.ok(r.stdout.includes('router: on (fast→haiku, standard→sonnet, strong→inherit; min confidence 0.6; stakes ≥1.5 keep session model)'), r.stdout);
  assert.ok(r.stdout.includes('gate: on (mode deny, warn off, ask ≥2.6, deny ≥2.8; risk signals only)'), r.stdout);
  assert.ok(r.stdout.includes('"decision":"ask"'));
  assert.ok(r.stdout.includes(`node: ${process.version}`));
});

test('status exits 1 and explains when the key is missing or rejected', async () => {
  const missing = await runScript('scripts/status.mjs', { env: { JEV_BASE_URL: backend.url } });
  assert.equal(missing.code, 1);
  assert.ok(missing.stdout.includes('key: MISSING'));
  assert.ok(missing.stdout.includes('set-key.mjs'));
  backend.queue(401, 'invalid key');
  const rejected = await runScript('scripts/status.mjs', { env: { TYPESAFE_API_KEY: 'bad', JEV_BASE_URL: backend.url } });
  assert.equal(rejected.code, 1);
  assert.ok(rejected.stdout.includes('models: ERROR auth'));
});

test('status reads only the tail of large log files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-status-large-'));
  const logPath = path.join(dir, 'decisions.jsonl');
  const lines = [];
  lines.push(JSON.stringify({ ts: '1', hook: 'start', decision: 'first-line' }));
  for (let i = 0; i < 19999; i++) {
    lines.push(JSON.stringify({ ts: `${i}`, hook: 'test', decision: `line-${i}` }));
  }
  lines.push(JSON.stringify({ ts: '20000', hook: 'end', decision: 'last-line' }));
  fs.writeFileSync(logPath, lines.join('\n') + '\n');
  const r = await runScript('scripts/status.mjs', { env: { TYPESAFE_API_KEY: 'sk-test1234', JEV_BASE_URL: backend.url, JEV_LOG: logPath } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('"decision":"last-line"'), 'last line should be in output');
  assert.ok(!r.stdout.includes('"decision":"first-line"'), 'first line should not be in output');
});
