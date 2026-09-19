// lib/hook-io.mjs — everything a hook needs besides its own decision logic.
// Invariant: runHook always ends with exit(0); an error means "no output", never a block.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createClient, redact } from './jev-client.mjs';

export function readStdin(stream = process.stdin, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    if (stream.isTTY) return finish();
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

export function appendDecisionLog(logPath, entry) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break a hook.
  }
}

export async function runHook(name, handler, {
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
} = {}) {
  const cfg = loadConfig(env);
  const started = Date.now();
  const log = (entry) => appendDecisionLog(cfg.logPath, {
    ts: new Date().toISOString(), hook: name, latency_ms: Date.now() - started, ...entry,
  });
  let output = null;
  try {
    const raw = await readStdin(stdin, { timeoutMs: 1500 });
    const input = raw.trim() ? JSON.parse(raw) : null;
    if (input && typeof input === 'object') {
      const client = cfg.apiKey ? createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model }) : null;
      output = await handler({ input, cfg, client, log });
    }
  } catch (err) {
    const message = redact(String(err?.message || err), cfg.apiKey);
    if (cfg.debug) stderr.write(`[jev:${name}] ${message}\n`);
    log({ decision: 'error', error: message });
    output = null;
  }
  if (output) {
    await new Promise((resolve) => {
      stdout.write(`${JSON.stringify(output)}\n`, () => {
        exit(0);
        resolve();
      });
    });
  } else {
    exit(0);
  }
}
