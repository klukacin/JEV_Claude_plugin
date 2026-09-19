// lib/config.mjs — every setting comes from environment variables; see README "Configuration".
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIERS = Object.freeze({ fast: 'haiku', standard: 'sonnet', strong: null });

export const DEFAULTS = Object.freeze({
  model: 'jev-latest',
  baseUrl: 'https://api.typesafe.ai',
  hookTimeoutMs: 6000,
  toolTimeoutMs: 20000,
  router: true,
  routerOverride: false,
  routerCustomAgents: false,
  routerTiers: DEFAULT_TIERS,
  routerMinConfidence: 0.6,
  triage: true,
  gate: true,
  gateMode: 'ask',
  gateAskThreshold: 2.0,
  gateDenyThreshold: 2.6,
  gateWarnThreshold: 1.3,
  debug: false,
});

const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

function flag(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !FALSE_WORDS.has(String(value).trim().toLowerCase());
}

function number(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tiers(value) {
  const out = { ...DEFAULT_TIERS };
  if (!value) return out;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const tier of Object.keys(DEFAULT_TIERS)) {
    if (!(tier in parsed)) continue;
    const v = parsed[tier];
    if (v === null || (typeof v === 'string' && v.trim())) out[tier] = v;
  }
  return out;
}

export function resolveApiKey(env = process.env) {
  const key = String(env.TYPESAFE_API_KEY || env.JEV_API_KEY || '').trim();
  return key ? key : null;
}

export function resolveLogPath(env = process.env) {
  const raw = env.JEV_LOG;
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  if (raw) return raw;
  const base = env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'jev');
  return path.join(base, 'decisions.jsonl');
}

export function loadConfig(env = process.env) {
  const mode = String(env.JEV_GATE_MODE || DEFAULTS.gateMode).trim().toLowerCase();
  return {
    apiKey: resolveApiKey(env),
    model: env.JEV_MODEL || DEFAULTS.model,
    baseUrl: String(env.JEV_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    hookTimeoutMs: number(env.JEV_HOOK_TIMEOUT_MS, DEFAULTS.hookTimeoutMs),
    toolTimeoutMs: number(env.JEV_TOOL_TIMEOUT_MS, DEFAULTS.toolTimeoutMs),
    router: flag(env.JEV_ROUTER, DEFAULTS.router),
    routerOverride: flag(env.JEV_ROUTER_OVERRIDE, DEFAULTS.routerOverride),
    routerCustomAgents: flag(env.JEV_ROUTER_CUSTOM_AGENTS, DEFAULTS.routerCustomAgents),
    routerTiers: tiers(env.JEV_ROUTER_TIERS),
    routerMinConfidence: number(env.JEV_ROUTER_MIN_CONFIDENCE, DEFAULTS.routerMinConfidence),
    triage: flag(env.JEV_TRIAGE, DEFAULTS.triage),
    gate: flag(env.JEV_GATE, DEFAULTS.gate),
    gateMode: ['ask', 'deny', 'advise'].includes(mode) ? mode : DEFAULTS.gateMode,
    gateAskThreshold: number(env.JEV_GATE_ASK_THRESHOLD, DEFAULTS.gateAskThreshold),
    gateDenyThreshold: number(env.JEV_GATE_DENY_THRESHOLD, DEFAULTS.gateDenyThreshold),
    gateWarnThreshold: number(env.JEV_GATE_WARN_THRESHOLD, DEFAULTS.gateWarnThreshold),
    logPath: resolveLogPath(env),
    debug: flag(env.JEV_DEBUG, DEFAULTS.debug),
  };
}
