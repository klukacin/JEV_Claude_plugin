import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';
import { mergeKey } from '../scripts/set-key.mjs';

let backend;
before(async () => { backend = await startMockBackend(); });
after(() => backend.close());

test('mergeKey creates, preserves, and replaces', () => {
  assert.equal(mergeKey('', 'k1'), '{\n  "env": {\n    "TYPESAFE_API_KEY": "k1"\n  }\n}\n');
  const existing = JSON.stringify({ hooks: { Stop: [] }, env: { OTHER: '1', TYPESAFE_API_KEY: 'old' }, theme: 'dark' });
  const merged = JSON.parse(mergeKey(existing, 'new'));
  assert.deepEqual(merged, { hooks: { Stop: [] }, env: { OTHER: '1', TYPESAFE_API_KEY: 'new' }, theme: 'dark' });
  assert.throws(() => mergeKey('[]', 'k'), /not a JSON object/);
  assert.throws(() => mergeKey('{bad', 'k'), /JSON/);
});

test('writes the key into the settings file, keeps a backup, verifies against the API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-setkey-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }));
  const r = await runScript('scripts/set-key.mjs', { args: ['--stdin'], input: 'sk-live-1234\n', env: { CLAUDE_SETTINGS_PATH: file, JEV_BASE_URL: backend.url } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark', env: { TYPESAFE_API_KEY: 'sk-live-1234' } });
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.bak-')));
  assert.ok(r.stdout.includes(file));
  assert.ok(!r.stdout.includes('sk-live-1234'));
  assert.equal(backend.requests.at(-1).headers.authorization, 'Bearer sk-live-1234');
});

test('rejected key is not written; --no-verify skips the check; empty key fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-setkey-'));
  const file = path.join(dir, 'settings.json');
  backend.queue(401, 'nope');
  const bad = await runScript('scripts/set-key.mjs', { args: ['--stdin'], input: 'bad\n', env: { CLAUDE_SETTINGS_PATH: file, JEV_BASE_URL: backend.url } });
  assert.equal(bad.code, 1);
  assert.equal(fs.existsSync(file), false);
  const skip = await runScript('scripts/set-key.mjs', { args: ['--stdin', '--no-verify'], input: 'unchecked\n', env: { CLAUDE_SETTINGS_PATH: file, JEV_BASE_URL: 'http://127.0.0.1:9' } });
  assert.equal(skip.code, 0, skip.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.TYPESAFE_API_KEY, 'unchecked');
  const empty = await runScript('scripts/set-key.mjs', { args: ['--stdin'], input: '\n', env: { CLAUDE_SETTINGS_PATH: file } });
  assert.equal(empty.code, 1);
});
