#!/usr/bin/env node
// scripts/set-key.mjs — store TYPESAFE_API_KEY in ~/.claude/settings.json (env block) without
// the key ever appearing in a chat transcript. Usage: node scripts/set-key.mjs [--stdin] [--no-verify]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createClient } from '../lib/jev-client.mjs';
import { loadConfig } from '../lib/config.mjs';
import { isMainModule } from '../server/mcp.mjs';

export function mergeKey(settingsText, key) {
  let settings = {};
  if (settingsText && settingsText.trim()) settings = JSON.parse(settingsText);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings file is not a JSON object');
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  settings.env = { ...env, TYPESAFE_API_KEY: key };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function readAll(stream) {
  return new Promise((resolve) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (c) => { data += c; });
    stream.on('end', () => resolve(data));
    stream.on('error', () => resolve(data));
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) write(s); };
    rl.question(question, (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const file = process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
  const key = args.includes('--stdin') ? (await readAll(process.stdin)).trim() : await promptHidden('TypeSafe API key (input hidden): ');
  if (!key) fail('No key entered.');
  if (!args.includes('--no-verify')) {
    const cfg = loadConfig();
    const client = createClient({ apiKey: key, baseUrl: cfg.baseUrl });
    try {
      await client.listModels({ timeoutMs: 10000 });
    } catch (err) {
      fail(`Key check failed (${err.code || 'error'}): ${err.message}\nNothing was written. Use --no-verify to store it anyway.`);
    }
  }
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let merged;
  try {
    merged = mergeKey(existing, key);
  } catch (err) {
    fail(`Cannot update ${file}: ${err.message}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existing) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  fs.writeFileSync(file, merged, { mode: 0o600 });
  process.stdout.write(`Saved TYPESAFE_API_KEY to ${file} (env block). Restart Claude Code to apply.\n`);
}

if (isMainModule(process.argv[1], import.meta.url)) main();
