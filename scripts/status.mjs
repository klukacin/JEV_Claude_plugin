#!/usr/bin/env node
// scripts/status.mjs — what /jev:status runs. Prints a short report; exit 1 when Jev is unusable.
import fs from 'node:fs';
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
  lines.push(`  router: ${onOff(cfg.router)} (fast→${tierName(t.fast)}, standard→${tierName(t.standard)}, strong→${tierName(t.strong)}; min confidence ${cfg.routerMinConfidence}; stakes ≥${cfg.routerMaxStakes} keep session model${cfg.routerOverride ? '; override on' : ''}${cfg.routerCustomAgents ? '; custom agents on' : ''})`);
  lines.push(`  triage: ${onOff(cfg.triage)}`);
  const th = (v) => Number(v).toFixed(1);
  const denyText = cfg.gateMode === 'deny' ? `, deny ≥${th(cfg.gateDenyThreshold)}` : '';
  const signalText = cfg.gateSignals ? 'risk signals only' : 'every command';
  const thresholds = cfg.gateMode === 'advise'
    ? `notes ≥${th(cfg.gateWarnThreshold ?? cfg.gateAskThreshold)}, never prompts`
    : `${cfg.gateWarnThreshold === null ? 'warn off' : `warn ≥${th(cfg.gateWarnThreshold)}`}, ask ≥${th(cfg.gateAskThreshold)}${denyText}`;
  lines.push(`  gate: ${onOff(cfg.gate)} (mode ${cfg.gateMode}, ${thresholds}; ${signalText})`);
  lines.push(`  verify: ${onOff(cfg.verify)} (nudge when a claim scores ≥${cfg.verifyThreshold} after unverified edits)`);
  lines.push(`  log: ${cfg.logPath || 'off'}`);
  if (cfg.logPath && fs.existsSync(cfg.logPath)) {
    try {
      const stats = fs.statSync(cfg.logPath);
      const readSize = Math.min(stats.size, 65536);
      const startPos = Math.max(0, stats.size - readSize);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(cfg.logPath, 'r');
      fs.readSync(fd, buf, 0, readSize, startPos);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      if (startPos > 0) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline !== -1) text = text.substring(firstNewline + 1);
      }
      const tail = text.trim().split('\n').slice(-10).filter(Boolean);
      for (const line of tail) lines.push(`    ${line}`);
    } catch (err) {
      lines.push(`    (log unreadable: ${err.message})`);
    }
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
