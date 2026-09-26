import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, DEFAULTS } from '../lib/config.mjs';

test('defaults when nothing is set', () => {
  const c = loadConfig({});
  assert.equal(c.apiKey, null);
  assert.equal(c.model, 'jev-latest');
  assert.equal(c.baseUrl, 'https://api.typesafe.ai');
  assert.equal(c.hookTimeoutMs, 6000);
  assert.equal(c.toolTimeoutMs, 20000);
  assert.equal(c.router, true);
  assert.equal(c.routerOverride, false);
  assert.equal(c.routerCustomAgents, false);
  assert.deepEqual(c.routerTiers, { fast: 'haiku', standard: 'sonnet', strong: null });
  assert.equal(c.routerMinConfidence, 0.6);
  assert.equal(c.routerMaxStakes, 1.5);
  assert.equal(c.triage, true);
  assert.equal(c.gate, true);
  assert.equal(c.gateMode, 'ask');
  assert.equal(c.gateAskThreshold, 2.6);
  assert.equal(c.gateDenyThreshold, 2.8);
  assert.equal(c.gateWarnThreshold, null);
  assert.equal(c.gateSignals, true);
  assert.equal(c.verify, true);
  assert.equal(c.verifyThreshold, 0.7);
  assert.ok(c.logPath.endsWith('/.claude/jev/decisions.jsonl'));
  assert.equal(c.debug, false);
});

test('api key aliases and trimming', () => {
  assert.equal(loadConfig({ JEV_API_KEY: ' k ' }).apiKey, 'k');
  assert.equal(loadConfig({ TYPESAFE_API_KEY: 'a', JEV_API_KEY: 'b' }).apiKey, 'a');
  assert.equal(loadConfig({ TYPESAFE_API_KEY: '   ' }).apiKey, null);
});

test('flags accept 0, false, no, off', () => {
  for (const v of ['0', 'false', 'no', 'off', 'OFF']) {
    assert.equal(loadConfig({ JEV_ROUTER: v }).router, false, v);
  }
  assert.equal(loadConfig({ JEV_ROUTER: '1' }).router, true);
  assert.equal(loadConfig({ JEV_ROUTER_OVERRIDE: 'true' }).routerOverride, true);
});

test('tier map merges over defaults and ignores garbage', () => {
  assert.deepEqual(loadConfig({ JEV_ROUTER_TIERS: '{"strong":"opus"}' }).routerTiers,
    { fast: 'haiku', standard: 'sonnet', strong: 'opus' });
  assert.deepEqual(loadConfig({ JEV_ROUTER_TIERS: 'nope' }).routerTiers, DEFAULTS.routerTiers);
  assert.equal(loadConfig({ JEV_ROUTER_TIERS: '{"fast":5}' }).routerTiers.fast, 'haiku');
  assert.equal(loadConfig({ JEV_ROUTER_TIERS: '{"standard":null}' }).routerTiers.standard, null);
});

test('numbers and modes fall back when invalid', () => {
  assert.equal(loadConfig({ JEV_GATE_ASK_THRESHOLD: 'x' }).gateAskThreshold, 2.6);
  assert.equal(loadConfig({ JEV_GATE_WARN_THRESHOLD: '1.3' }).gateWarnThreshold, 1.3);
  assert.equal(loadConfig({ JEV_GATE_WARN_THRESHOLD: 'off' }).gateWarnThreshold, null);
  assert.equal(loadConfig({ JEV_GATE_SIGNALS: '0' }).gateSignals, false);
  assert.equal(loadConfig({ JEV_ROUTER_MAX_STAKES: '2' }).routerMaxStakes, 2);
  assert.equal(loadConfig({ JEV_VERIFY: 'off', JEV_VERIFY_THRESHOLD: '0.8' }).verify, false);
  assert.equal(loadConfig({ JEV_VERIFY_THRESHOLD: '0.8' }).verifyThreshold, 0.8);
  assert.equal(loadConfig({ JEV_GATE_ASK_THRESHOLD: '1.7' }).gateAskThreshold, 1.7);
  assert.equal(loadConfig({ JEV_GATE_MODE: 'DENY' }).gateMode, 'deny');
  assert.equal(loadConfig({ JEV_GATE_MODE: 'yolo' }).gateMode, 'ask');
});

test('base url loses trailing slashes', () => {
  assert.equal(loadConfig({ JEV_BASE_URL: 'http://127.0.0.1:9/' }).baseUrl, 'http://127.0.0.1:9');
});

test('log path honours CLAUDE_PLUGIN_DATA, JEV_LOG, and JEV_LOG=0', () => {
  assert.equal(loadConfig({ CLAUDE_PLUGIN_DATA: '/tmp/pd' }).logPath, '/tmp/pd/decisions.jsonl');
  assert.equal(loadConfig({ JEV_LOG: '/tmp/x.jsonl' }).logPath, '/tmp/x.jsonl');
  assert.equal(loadConfig({ JEV_LOG: '0' }).logPath, null);
});
