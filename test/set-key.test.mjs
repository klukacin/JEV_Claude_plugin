import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';
import { mergeKey } from '../scripts/set-key.mjs';

let backend;
const createdDirs = [];
before(async () => { backend = await startMockBackend(); });
after(() => {
  backend.close();
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
  createdDirs.push(dir);
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
  createdDirs.push(dir);
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

test('enforces 0600 mode on the settings file and its backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-setkey-'));
  createdDirs.push(dir);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }), { mode: 0o644 });
  const r = await runScript('scripts/set-key.mjs', { args: ['--stdin', '--no-verify'], input: 'test-key\n', env: { CLAUDE_SETTINGS_PATH: file, JEV_BASE_URL: 'http://127.0.0.1:9' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600, 'settings file should be 0600');
  const backupFile = fs.readdirSync(dir).find((f) => f.startsWith('settings.json.bak-'));
  assert.ok(backupFile, 'backup file should exist');
  assert.equal((fs.statSync(path.join(dir, backupFile)).mode & 0o777), 0o600, 'backup file should be 0600');
});
