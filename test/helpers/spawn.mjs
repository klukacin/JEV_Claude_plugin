// test/helpers/spawn.mjs — run hooks/scripts/server as child processes with a clean env.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('JEV_') || key === 'TYPESAFE_API_KEY' || key.startsWith('CLAUDE_PLUGIN_')) delete env[key];
  }
  return { ...env, JEV_LOG: '0', ...extra };
}

export function runScript(relPath, { input = '', env = {}, args = [], command = process.execPath } = {}) {
  return new Promise((resolve, reject) => {
    const file = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
    const child = spawn(command, [file, ...args], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function startMcp(env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server/mcp.mjs')], { env: cleanEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const lines = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      lines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    }
  });
  child.stderr.on('data', (c) => { stderr += c; });

  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`)); }, 15000).unref();
    });
  };

  return {
    request,
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    raw(line) { child.stdin.write(`${line}\n`); },
    lines,
    async call(name, args = {}) {
      const msg = await request('tools/call', { name, arguments: args });
      if (msg.error) throw new Error(`rpc error ${msg.error.code}: ${msg.error.message}`);
      const text = msg.result.content?.[0]?.text ?? '';
      return { isError: Boolean(msg.result.isError), text, json: msg.result.isError ? null : JSON.parse(text) };
    },
    stderr: () => stderr,
    close() {
      return new Promise((resolve) => {
        child.on('close', resolve);
        child.stdin.end();
        setTimeout(() => child.kill(), 1000).unref();
      });
    },
  };
}
