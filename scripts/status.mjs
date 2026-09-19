#!/usr/bin/env node
// scripts/status.mjs — what /jev:status runs. Prints a short report; exit 1 when Jev is unusable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { createClient } from '../lib/jev-client.mjs';
import { isMainModule } from '../server/mcp.mjs';

export function modelNames(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
  return list.map((m) => (typeof m === 'string' ? m : m?.name || m?.id)).filter(Boolean);
}

const onOff = (v) => (v ? 'on' : 'off');
const tierName = (v) => (v === null || v === undefined ? 'inherit' : v);

export async function buildReport({ cfg, client }) {
  const lines = ['Jev plugin status'];
  let ok = Boolean(cfg.apiKey);
  lines.push(`  key: ${cfg.apiKey ? `set (…${cfg.apiKey.slice(-4)})` : 'MISSING — run: node scripts/set-key.mjs (or set TYPESAFE_API_KEY in ~/.claude/settings.json env)'}`);
  lines.push(`  endpoint: ${cfg.baseUrl} · model: ${cfg.model}`);
  if (cfg.apiKey) {
    try {
      const names = modelNames(await client.listModels({ timeoutMs: 10000 }));
      lines.push(`  models: ${names.length ? names.join(', ') : '(none listed)'}`);
    } catch (err) {
      ok = false;
      lines.push(`  models: ERROR ${err.code || 'unknown'}: ${err.message}`);
    }
  }
  const t = cfg.routerTiers;
  lines.push(`  router: ${onOff(cfg.router)} (fast→${tierName(t.fast)}, standard→${tierName(t.standard)}, strong→${tierName(t.strong)}; min confidence ${cfg.routerMinConfidence}${cfg.routerOverride ? '; override on' : ''}${cfg.routerCustomAgents ? '; custom agents on' : ''})`);
  lines.push(`  triage: ${onOff(cfg.triage)}`);
  const th = (v) => Number(v).toFixed(1);
  const denyText = cfg.gateMode === 'deny' ? `, deny ≥${th(cfg.gateDenyThreshold)}` : '';
  lines.push(`  gate: ${onOff(cfg.gate)} (mode ${cfg.gateMode}, warn ≥${th(cfg.gateWarnThreshold)}, ask ≥${th(cfg.gateAskThreshold)}${denyText})`);
  lines.push(`  log: ${cfg.logPath || 'off'}`);
  if (cfg.logPath && fs.existsSync(cfg.logPath)) {
    const tail = fs.readFileSync(cfg.logPath, 'utf8').trim().split('\n').slice(-10);
    for (const line of tail) lines.push(`    ${line}`);
  }
  lines.push(`  node: ${process.version}`);
  return { text: lines.join('\n'), ok };
}

async function main() {
  const cfg = loadConfig();
  const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model });
  const { text, ok } = await buildReport({ cfg, client });
  process.stdout.write(`${text}\n`);
  process.exitCode = ok ? 0 : 1;
}

if (isMainModule(process.argv[1], import.meta.url)) main();
