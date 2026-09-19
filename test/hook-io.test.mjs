import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { readStdin, appendDecisionLog, runHook } from '../lib/hook-io.mjs';

function collector() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, text: () => text };
}

async function run(handler, { input, env = {} } = {}) {
  const out = collector();
  const err = collector();
  let exitCode = null;
  await runHook('test-hook', handler, {
    env: { JEV_LOG: '0', ...env },
    stdin: Readable.from(input === undefined ? [] : [input]),
    stdout: out.stream,
    stderr: err.stream,
    exit: (code) => { exitCode = code; },
  });
  return { stdout: out.text(), stderr: err.text(), exitCode };
}

test('readStdin returns everything and resolves empty on timeout', async () => {
  assert.equal(await readStdin(Readable.from(['{"a":', '1}']), { timeoutMs: 500 }), '{"a":1}');
  const never = new Readable({ read() {} });
  assert.equal(await readStdin(never, { timeoutMs: 30 }), '');
});

test('handler output is printed as one JSON line and exit(0) is called', async () => {
  const r = await run(async ({ input }) => ({ echo: input.tool_name }), { input: '{"tool_name":"Bash"}' });
  assert.equal(r.stdout, '{"echo":"Bash"}\n');
  assert.equal(r.exitCode, 0);
});

test('null output prints nothing; invalid JSON and empty stdin print nothing', async () => {
  assert.equal((await run(async () => null, { input: '{}' })).stdout, '');
  assert.equal((await run(async () => ({ x: 1 }), { input: 'not json' })).stdout, '');
  assert.equal((await run(async () => ({ x: 1 }), { input: '' })).stdout, '');
});

test('a throwing handler is fail-open and the key never reaches stderr', async () => {
  const r = await run(async () => { throw new Error('boom sk-secret-123'); }, { input: '{}', env: { TYPESAFE_API_KEY: 'sk-secret-123', JEV_DEBUG: '1' } });
  assert.equal(r.stdout, '');
  assert.equal(r.exitCode, 0);
  assert.ok(r.stderr.includes('boom ***'), r.stderr);
  assert.ok(!r.stderr.includes('sk-secret-123'));
});

test('client is null without a key and present with one', async () => {
  let seen;
  await run(async ({ client, cfg }) => { seen = { client, model: cfg.model }; return null; }, { input: '{}' });
  assert.equal(seen.client, null);
  await run(async ({ client }) => { seen = client; return null; }, { input: '{}', env: { TYPESAFE_API_KEY: 'k' } });
  assert.equal(typeof seen.systemOne, 'function');
});

test('decision log appends JSON lines with hook name and latency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-log-'));
  const logPath = path.join(dir, 'nested', 'decisions.jsonl');
  await run(async ({ log }) => { log({ decision: 'routed', model: 'haiku' }); return null; }, { input: '{}', env: { JEV_LOG: logPath } });
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].hook, 'test-hook');
  assert.equal(lines[0].decision, 'routed');
  assert.equal(typeof lines[0].latency_ms, 'number');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  appendDecisionLog('/dev/null/impossible/x.jsonl', { a: 1 });
  appendDecisionLog(null, { a: 1 });
});

test('circular object in handler output is fail-open: no output, error logged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-log-'));
  const logPath = path.join(dir, 'circular.jsonl');
  const r = await run(async () => {
    const obj = { x: 1 };
    obj.self = obj;
    return obj;
  }, { input: '{}', env: { JEV_LOG: logPath } });
  assert.equal(r.stdout, '');
  assert.equal(r.exitCode, 0);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].decision, 'error');
});

test('handler returning plain string or number prints nothing', async () => {
  assert.equal((await run(async () => 'string output', { input: '{}' })).stdout, '');
  assert.equal((await run(async () => 42, { input: '{}' })).stdout, '');
  assert.equal((await run(async () => true, { input: '{}' })).stdout, '');
});

test('debug stderr write is flushed before exit is called', async () => {
  let stderrTextAtExit = '';
  const out = collector();
  const err = collector();
  let capturedExitCode = null;
  await runHook('test-hook', async () => { throw new Error('boom secret-key'); }, {
    env: { JEV_LOG: '0', TYPESAFE_API_KEY: 'secret-key', JEV_DEBUG: '1' },
    stdin: Readable.from(['{}' ]),
    stdout: out.stream,
    stderr: err.stream,
    exit: (code) => {
      stderrTextAtExit = err.text();
      capturedExitCode = code;
    },
  });
  assert.equal(capturedExitCode, 0);
  assert.ok(stderrTextAtExit.includes('boom ***'), stderrTextAtExit);
});
