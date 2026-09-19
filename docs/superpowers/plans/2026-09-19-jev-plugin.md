# Jev Claude Code Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `jev` Claude Code plugin: three fail-open hooks (subagent model router, request triage, Bash risk gate), a zero-dependency MCP server with six Jev tools, two skills, and setup scripts, all tested offline against a mock TypeSafe backend.

**Architecture:** Plain Node ≥ 20 ESM modules. `lib/` holds pure builders/policies, the HTTP client, config, hook plumbing, and a minimal JSON-RPC stdio server. `hooks/*.mjs` and `server/mcp.mjs` are thin entry points wired by `hooks/hooks.json` and `.mcp.json` through `sh` launchers that locate `node`. Tests use `node:test` and spawn the real scripts against a local `node:http` mock of the TypeSafe API.

**Tech Stack:** Node.js ≥ 20 (built-in `fetch`, `node:test`, `node:http`, `node:readline`), POSIX `sh`, Claude Code plugin system (hooks, MCP, skills), TypeSafe System One API (`POST /v1/systemone`, `GET /v1/models`).

**Spec:** `docs/superpowers/specs/2026-09-19-jev-plugin-design.md`

## Global Constraints

- Plugin root is this repository: `/Users/martin/projects/Jev`. Plugin name `jev`, marketplace name `jev`, MCP server name `jev`, so tools appear as `mcp__plugin_jev_jev__<tool>`.
- Node ≥ 20, ESM only (`.mjs`), **zero npm dependencies** (runtime and dev). No `package-lock.json` (its presence would make Claude Code try `npm ci`).
- Every hook is fail-open: any error, missing key, timeout, or disabled flag → exit code 0 and empty stdout. Hooks **never** print `permissionDecision: "allow"`.
- The API key is read only from `TYPESAFE_API_KEY` (alias `JEV_API_KEY`), never written to plugin files, never logged, redacted from error text.
- Router tiers default `{"fast":"haiku","standard":"sonnet","strong":null}`; `null` means leave `model` unset. Router min confidence `0.6`; fast→standard bump when stakes ≥ `1.5`.
- Gate thresholds on the 0–3 risk scale: warn `1.3`, ask `2.0`, deny `2.6` (deny only in `deny` mode). Gate mode default `ask`.
- Hook per-request budget `JEV_HOOK_TIMEOUT_MS=6000`, hook process timeout 15 s in `hooks.json`; MCP tool budget `JEV_TOOL_TIMEOUT_MS=20000`.
- Triage skips prompts starting with `/` or shorter than 15 characters. State caps: router prompt 12 000 chars, triage prompt 8 000, gate command 4 000.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run tests with `npm test` (`node --test "test/**/*.test.mjs"`) from the plugin root. Tests never touch the network or need a key.

## File structure

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` | Plugin identity; local marketplace with `source: "./"` |
| `.mcp.json`, `hooks/hooks.json` | Wire the server launcher and the three hooks |
| `lib/util.mjs` | `num`, `truncate`, `preview` |
| `lib/config.mjs` | `loadConfig(env)`, `resolveApiKey`, `resolveLogPath`, `DEFAULTS` |
| `lib/jev-client.mjs` | `createClient` (`systemOne`, `listModels`), `JevError`, `redact` |
| `lib/questions.mjs` | Router/triage/gate question builders and pure decision policies |
| `lib/gate-prefilter.mjs` | `isProvablySafe(command)` regex allowlist |
| `lib/hook-io.mjs` | `readStdin`, `appendDecisionLog`, `runHook` (fail-open wrapper) |
| `lib/validate.mjs` | `validateQuestion`, `validateQuestions` |
| `lib/mcp-protocol.mjs` | `createServer`, `serve`, `toToolResult` (JSON-RPC over stdio) |
| `lib/find-node.sh` | `find_node` shell function shared by launchers |
| `hooks/run-hook.sh`, `hooks/route-agent.mjs`, `hooks/triage-prompt.mjs`, `hooks/gate-bash.mjs` | Hook entry points |
| `bin/jev-mcp`, `server/mcp.mjs` | MCP launcher and tool definitions (`buildTools`, `runWithConcurrency`) |
| `skills/jev-decisions/SKILL.md`, `skills/status/SKILL.md` | Skills |
| `scripts/status.mjs`, `scripts/set-key.mjs`, `scripts/smoke.mjs` | Diagnostics, key setup, live check |
| `test/helpers/mock-backend.mjs`, `test/helpers/spawn.mjs` | Mock TypeSafe API; spawn helpers for hooks and the MCP server |
| `test/*.test.mjs` | One test file per module |

---

### Task 1: Scaffold the plugin repository

**Files:**
- Create: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `LICENSE`, `README.md`
- Test: `test/plugin-structure.test.mjs`

**Interfaces:**
- Produces: plugin name `jev`, version `0.1.0`, `npm test` script used by every later task.

- [ ] **Step 1: Write the failing structure test**

`test/plugin-structure.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('plugin manifest is valid', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(m.name, 'jev');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
  assert.equal(m.license, 'MIT');
});

test('marketplace lists the plugin at the repo root', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'jev');
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, 'jev');
  assert.equal(m.plugins[0].source, './');
});

test('package.json is ESM with no dependencies and no lockfile', () => {
  const p = readJson('package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'package-lock.json')), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/martin/projects/Jev && node --test "test/**/*.test.mjs"`
Expected: FAIL (ENOENT reading `.claude-plugin/plugin.json`).

- [ ] **Step 3: Create the manifests and package files**

`package.json`:

```json
{
  "name": "jev-claude-plugin",
  "version": "0.1.0",
  "private": true,
  "description": "Claude Code plugin: TypeSafe Jev decisions for subagent model routing, request triage, command gating, and typed judgments",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test \"test/**/*.test.mjs\"",
    "smoke": "node scripts/smoke.mjs",
    "status": "node scripts/status.mjs"
  }
}
```

`.claude-plugin/plugin.json`:

```json
{
  "name": "jev",
  "displayName": "Jev (TypeSafe)",
  "version": "0.1.0",
  "description": "Fast typed decisions from TypeSafe's Jev: routes subagents to the cheapest capable model, triages requests, screens risky shell commands, and exposes choose/score/check/batch/route/decide tools.",
  "author": { "name": "klukacin", "email": "kristijan@websolutions.hr" },
  "license": "MIT",
  "keywords": ["typesafe", "jev", "model-routing", "guardrails", "classification", "system-one"]
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "jev",
  "description": "Local marketplace for the jev plugin (TypeSafe Jev decisions for Claude Code)",
  "owner": { "name": "klukacin" },
  "plugins": [
    {
      "name": "jev",
      "description": "TypeSafe Jev decisions: subagent model routing, request triage, Bash risk gate, and typed judgment tools",
      "source": "./",
      "version": "0.1.0"
    }
  ]
}
```

`LICENSE`: the MIT license text with `Copyright (c) 2026 klukacin`.

`README.md` (stub, replaced in Task 18):

```markdown
# jev — TypeSafe Jev decisions for Claude Code

Work in progress. See docs/superpowers/specs/2026-09-19-jev-plugin-design.md.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add package.json .claude-plugin LICENSE README.md test/plugin-structure.test.mjs
git commit -m "chore: scaffold jev plugin manifests and test runner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Utilities and configuration

**Files:**
- Create: `lib/util.mjs`, `lib/config.mjs`
- Test: `test/util.test.mjs`, `test/config.test.mjs`

**Interfaces:**
- Produces: `num(value) → number|null`, `truncate(text, max) → string`, `preview(text, max=120) → string`; `loadConfig(env) → cfg` with fields `apiKey, model, baseUrl, hookTimeoutMs, toolTimeoutMs, router, routerOverride, routerCustomAgents, routerTiers, routerMinConfidence, triage, gate, gateMode, gateAskThreshold, gateDenyThreshold, gateWarnThreshold, logPath, debug`; `resolveApiKey(env)`, `resolveLogPath(env)`, `DEFAULTS`.

- [ ] **Step 1: Write the failing tests**

`test/util.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, truncate, preview } from '../lib/util.mjs';

test('num parses finite numbers and rejects everything else', () => {
  assert.equal(num('1.5'), 1.5);
  assert.equal(num(0), 0);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num('abc'), null);
  assert.equal(num(Infinity), null);
});

test('truncate keeps short text and marks cut text', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate(null, 4), '');
});

test('preview collapses whitespace to one line', () => {
  assert.equal(preview('a\n\n  b\tc'), 'a b c');
  assert.equal(preview('x'.repeat(200)).length, 120);
});
```

`test/config.test.mjs`:

```js
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
  assert.equal(c.triage, true);
  assert.equal(c.gate, true);
  assert.equal(c.gateMode, 'ask');
  assert.equal(c.gateAskThreshold, 2.0);
  assert.equal(c.gateDenyThreshold, 2.6);
  assert.equal(c.gateWarnThreshold, 1.3);
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
  assert.equal(loadConfig({ JEV_GATE_ASK_THRESHOLD: 'x' }).gateAskThreshold, 2.0);
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../lib/util.mjs'` and `'../lib/config.mjs'`.

- [ ] **Step 3: Implement `lib/util.mjs`**

```js
// lib/util.mjs — tiny helpers shared by hooks, server, and scripts.

export function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function truncate(text, max) {
  const s = text === null || text === undefined ? '' : String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

export function preview(text, max = 120) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}
```

- [ ] **Step 4: Implement `lib/config.mjs`**

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all passing (structure + util + config).

- [ ] **Step 6: Commit**

```bash
git add lib/util.mjs lib/config.mjs test/util.test.mjs test/config.test.mjs
git commit -m "feat: config loading and small helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: TypeSafe HTTP client

**Files:**
- Create: `lib/jev-client.mjs`
- Test: `test/client.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class JevError extends Error { code, status }` with `code` ∈ `no_key|auth|validation|rate_limit|overloaded|timeout|network|http|bad_response`; `redact(text, key) → string`; `createClient({ apiKey, baseUrl, model, fetchImpl, backoffMs }) → { systemOne({ state, questions, model? }, { timeoutMs, retries }) → Promise<{ model, answers, usage }>, listModels({ timeoutMs, retries }) → Promise<any> }`.

- [ ] **Step 1: Write the failing tests**

`test/client.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, JevError, redact } from '../lib/jev-client.mjs';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const answers = { result: { type: 'noul', noul: 0.9 } };
const make = (responses, extra = {}) =>
  createClient({ apiKey: 'sk-test-KEY', baseUrl: 'http://api.test/', fetchImpl: fakeFetch(responses), backoffMs: [0, 0], ...extra });

test('systemOne posts model, state, questions with a bearer header', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } } }]);
  const client = createClient({ apiKey: 'sk-test-KEY', baseUrl: 'http://api.test', fetchImpl });
  const res = await client.systemOne({ state: 'hi', questions: { result: { type: 'noul', instructions: 'Is it a greeting?' } } });
  assert.equal(res.answers.result.noul, 0.9);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://api.test/v1/systemone');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test-KEY');
  assert.deepEqual(call.body, { model: 'jev-latest', state: 'hi', questions: { result: { type: 'noul', instructions: 'Is it a greeting?' } } });
});

test('model override per request', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { model: 'jev-preview', answers, usage: {} } }]);
  const client = createClient({ apiKey: 'k', fetchImpl });
  await client.systemOne({ state: 's', questions: { result: { type: 'noul', instructions: 'q' } }, model: 'jev-preview' });
  assert.equal(fetchImpl.calls[0].body.model, 'jev-preview');
});

test('no key fails before any request', async () => {
  const fetchImpl = fakeFetch([]);
  const client = createClient({ apiKey: null, fetchImpl });
  await assert.rejects(() => client.systemOne({ state: 's', questions: {} }), (e) => e instanceof JevError && e.code === 'no_key' && /TYPESAFE_API_KEY/.test(e.message));
  assert.equal(fetchImpl.calls.length, 0);
});

test('status codes map to error codes and the key is redacted', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [422, 'validation'], [400, 'validation'], [404, 'http']]) {
    const client = make([{ status, body: `bad sk-test-KEY ${status}` }]);
    await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }),
      (e) => e.code === code && e.status === status && !e.message.includes('sk-test-KEY') && e.message.includes('***'));
  }
});

test('429 then 200 is retried', async () => {
  const client = make([{ status: 429, body: 'slow down' }, { status: 200, body: { model: 'm', answers, usage: {} } }]);
  const res = await client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } });
  assert.equal(res.answers.result.noul, 0.9);
});

test('529 exhausts retries and reports overloaded after 3 attempts', async () => {
  const fetchImpl = fakeFetch([{ status: 529, body: 'x' }, { status: 529, body: 'x' }, { status: 529, body: 'x' }]);
  const client = createClient({ apiKey: 'k', fetchImpl, backoffMs: [0, 0] });
  await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }), (e) => e.code === 'overloaded');
  assert.equal(fetchImpl.calls.length, 3);
});

test('500 and network errors are retried, then 200 wins', async () => {
  const client = make([{ status: 500, body: 'boom' }, () => { throw new Error('ECONNRESET'); }, { status: 200, body: { model: 'm', answers, usage: {} } }]);
  const res = await client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } });
  assert.equal(res.answers.result.noul, 0.9);
});

test('network error without retries left is a network error', async () => {
  const client = make([() => { throw new Error('ECONNREFUSED 127.0.0.1'); }]);
  await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }, { retries: 0 }), (e) => e.code === 'network');
});

test('timeout aborts and is not retried', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetchImpl = fakeFetch([hang, hang]);
  const client = createClient({ apiKey: 'k', fetchImpl, backoffMs: [0, 0] });
  await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }, { timeoutMs: 40 }), (e) => e.code === 'timeout');
  assert.equal(fetchImpl.calls.length, 1);
});

test('non-JSON or answer-less bodies are bad_response', async () => {
  await assert.rejects(() => make([{ status: 200, body: 'not json' }]).systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }), (e) => e.code === 'bad_response');
  await assert.rejects(() => make([{ status: 200, body: { model: 'm' } }]).systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }), (e) => e.code === 'bad_response');
});

test('listModels is a GET without a body', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { models: [{ name: 'jev-1.13.0' }] } }]);
  const client = createClient({ apiKey: 'k', baseUrl: 'http://api.test', fetchImpl });
  const res = await client.listModels();
  assert.equal(res.models[0].name, 'jev-1.13.0');
  assert.equal(fetchImpl.calls[0].url, 'http://api.test/v1/models');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.body, undefined);
});

test('redact replaces every occurrence of the key', () => {
  assert.equal(redact('a KEY b KEY', 'KEY'), 'a *** b ***');
  assert.equal(redact('plain', null), 'plain');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/client.test.mjs`
Expected: FAIL with `Cannot find module '../lib/jev-client.mjs'`.

- [ ] **Step 3: Implement `lib/jev-client.mjs`**

```js
// lib/jev-client.mjs — the only module that talks to api.typesafe.ai.
import { setTimeout as sleep } from 'node:timers/promises';

export class JevError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message);
    this.name = 'JevError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export function redact(text, key) {
  if (!key || text === null || text === undefined) return text;
  return String(text).split(key).join('***');
}

const RETRY_STATUSES = new Set([429, 529]);

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  return 'http';
}

export function createClient({
  apiKey,
  baseUrl = 'https://api.typesafe.ai',
  model = 'jev-latest',
  fetchImpl = globalThis.fetch,
  backoffMs = [300, 900],
} = {}) {
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, pathname, body, { timeoutMs = 20000, retries = 2 } = {}) {
    if (!apiKey) {
      throw new JevError('no_key', 'No TypeSafe API key. Get one at https://console.typesafe.ai/keys and set TYPESAFE_API_KEY (run: node scripts/set-key.mjs).');
    }
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    const canRetry = () => {
      const wait = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      return attempt < retries && Date.now() + wait + 50 < deadline;
    };
    const backoff = async () => {
      const wait = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      attempt += 1;
      if (wait > 0) await sleep(wait);
    };

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new JevError('timeout', `Jev request timed out after ${timeoutMs} ms`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let res;
      try {
        res = await fetchImpl(root + pathname, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') throw new JevError('timeout', `Jev request timed out after ${timeoutMs} ms`, { cause: err });
        if (canRetry()) { await backoff(); continue; }
        throw new JevError('network', redact(`Could not reach Jev: ${err?.message || err}`, apiKey), { cause: err });
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new JevError('bad_response', 'Jev returned a non-JSON body', { status: res.status, cause: err });
        }
      }
      if ((RETRY_STATUSES.has(res.status) || res.status >= 500) && canRetry()) { await backoff(); continue; }
      throw new JevError(codeForStatus(res.status), redact(`Jev API error ${res.status}: ${text.slice(0, 300)}`, apiKey), { status: res.status });
    }
  }

  return {
    async systemOne({ state, questions, model: modelOverride } = {}, opts) {
      const data = await request('POST', '/v1/systemone', { model: modelOverride || model, state, questions }, opts);
      if (!data || typeof data !== 'object' || !data.answers || typeof data.answers !== 'object') {
        throw new JevError('bad_response', 'Jev response has no answers object');
      }
      return data;
    },
    async listModels(opts = {}) {
      return request('GET', '/v1/models', undefined, { retries: 1, ...opts });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/client.test.mjs`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/jev-client.mjs test/client.test.mjs
git commit -m "feat: TypeSafe HTTP client with retries, timeouts, and typed errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Test helpers — mock TypeSafe backend and spawn utilities

**Files:**
- Create: `test/helpers/mock-backend.mjs`, `test/helpers/spawn.mjs`
- Test: `test/mock-backend.test.mjs`

**Interfaces:**
- Produces: `startMockBackend({ answers }) → { url, requests, setAnswers(mapOrFn), queue(status, body), close() }` where `answers` is a map `id → answer object` or a function `(id, question, state) → answer`; `defaultAnswers(id, question)`; `ROOT`; `runScript(relPath, { input, env, args }) → { code, stdout, stderr }`; `startMcp(env) → { request(method, params), notify(method, params), raw(line), call(name, args), stderr(), close() }`.
- The mock returns HTTP 422 whenever `JSON.stringify(state)` contains `__FAIL__`.

- [ ] **Step 1: Write the failing test**

`test/mock-backend.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend, defaultAnswers } from './helpers/mock-backend.mjs';
import { createClient } from '../lib/jev-client.mjs';

test('mock backend answers each question type and records requests', async () => {
  const backend = await startMockBackend();
  try {
    const client = createClient({ apiKey: 'k', baseUrl: backend.url });
    const res = await client.systemOne({
      state: { text: 'hello' },
      questions: {
        a: { type: 'noul', instructions: 'q' },
        b: { type: 'choice', instructions: 'q', criteria: { x: 'x', y: 'y' } },
        c: { type: 'score', instructions: 'q', criteria: ['lo', 'hi'] },
      },
    });
    assert.equal(res.answers.a.noul, 0.5);
    assert.equal(res.answers.b.choice, 'x');
    assert.equal(res.answers.c.score, 0);
    assert.deepEqual(res.answers.c.legend, { 0: 'lo', 1: 'hi' });
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].headers.authorization, 'Bearer k');
    assert.deepEqual(backend.requests[0].body.state, { text: 'hello' });
  } finally {
    await backend.close();
  }
});

test('setAnswers overrides, queue injects one-off responses, __FAIL__ yields 422', async () => {
  const backend = await startMockBackend({ answers: { a: { type: 'noul', noul: 0.91 } } });
  try {
    const client = createClient({ apiKey: 'k', baseUrl: backend.url, backoffMs: [0, 0] });
    const q = { a: { type: 'noul', instructions: 'q' } };
    assert.equal((await client.systemOne({ state: 's', questions: q })).answers.a.noul, 0.91);
    backend.setAnswers((id) => ({ type: 'noul', noul: id === 'a' ? 0.2 : 0 }));
    assert.equal((await client.systemOne({ state: 's', questions: q })).answers.a.noul, 0.2);
    backend.queue(500, 'down');
    await assert.rejects(() => client.systemOne({ state: 's', questions: q }, { retries: 0 }), (e) => e.code === 'http');
    await assert.rejects(() => client.systemOne({ state: 'x __FAIL__ y', questions: q }), (e) => e.code === 'validation');
    const models = await client.listModels();
    assert.deepEqual(models.models.map((m) => m.name), ['jev-1.13.0', 'jev-latest']);
  } finally {
    await backend.close();
  }
});

test('defaultAnswers spreads choice probability with a clear winner', () => {
  const a = defaultAnswers('x', { type: 'choice', criteria: { p: '', q: '', r: '' } });
  assert.equal(a.choice, 'p');
  assert.ok(Math.abs(Object.values(a.probabilities).reduce((s, v) => s + v, 0) - 1) < 1e-9);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mock-backend.test.mjs`
Expected: FAIL with `Cannot find module './helpers/mock-backend.mjs'`.

- [ ] **Step 3: Implement `test/helpers/mock-backend.mjs`**

```js
// test/helpers/mock-backend.mjs — a local stand-in for api.typesafe.ai.
import http from 'node:http';

export function defaultAnswers(id, question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria || {});
    const probabilities = {};
    keys.forEach((k, i) => { probabilities[k] = keys.length === 1 ? 1 : i === 0 ? 0.9 : 0.1 / (keys.length - 1); });
    return { type: 'choice', choice: keys[0], probabilities, confidence: 0.9 };
  }
  const levels = question.criteria || [];
  const probabilities = {};
  const legend = {};
  levels.forEach((c, i) => { probabilities[String(i)] = i === 0 ? 1 : 0; legend[String(i)] = c; });
  return { type: 'score', score: 0, probabilities, legend, confidence: 0.95 };
}

export async function startMockBackend({ answers = null } = {}) {
  const requests = [];
  const queued = [];
  let answerSource = answers;

  const answerFor = (id, question, state) => {
    if (typeof answerSource === 'function') return answerSource(id, question, state) ?? defaultAnswers(id, question);
    if (answerSource && typeof answerSource === 'object' && answerSource[id]) return answerSource[id];
    return defaultAnswers(id, question);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { invalid: raw }; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      const override = queued.shift();
      if (override) return send(override.status, override.body);
      if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, { models: [{ name: 'jev-1.13.0', description: 'flagship' }, { name: 'jev-latest', description: 'alias' }] });
      }
      if (req.method === 'POST' && req.url === '/v1/systemone') {
        if (!body || !body.questions || typeof body.questions !== 'object') return send(422, { error: 'questions required' });
        if (JSON.stringify(body.state ?? '').includes('__FAIL__')) return send(422, { error: 'simulated validation failure' });
        const out = {};
        for (const [id, q] of Object.entries(body.questions)) out[id] = answerFor(id, q, body.state);
        return send(200, { model: body.model || 'jev-latest', answers: out, usage: { input_tokens: 10, output_tokens: 1 } });
      }
      return send(404, { error: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    setAnswers(next) { answerSource = next; },
    queue(status, body) { queued.push({ status, body }); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
```

- [ ] **Step 4: Implement `test/helpers/spawn.mjs`**

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/mock-backend.test.mjs`
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add test/helpers test/mock-backend.test.mjs
git commit -m "test: mock TypeSafe backend and process spawn helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Router questions and tier policy

**Files:**
- Create: `lib/questions.mjs`
- Test: `test/questions-router.test.mjs`

**Interfaces:**
- Consumes: `truncate`, `num` from `lib/util.mjs`; `cfg.routerTiers`, `cfg.routerMinConfidence` from `lib/config.mjs`.
- Produces: `BUILTIN_AGENT_TYPES` (Set), `TIERS` (`['fast','standard','strong']`), `buildRouter({ prompt, description, subagent_type }) → { state, questions }`, `decideTier(answers, cfg) → { tier, model, reason, confidence, stakes }` with `reason` ∈ `routed|stakes_bump|inherit|low_confidence|no_answer`.

- [ ] **Step 1: Write the failing tests**

`test/questions-router.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildRouter, decideTier, BUILTIN_AGENT_TYPES, TIERS } from '../lib/questions.mjs';

const cfg = loadConfig({});
const tier = (choice, confidence = 0.9) => ({ type: 'choice', choice, probabilities: { [choice]: confidence }, confidence });
const stakes = (score) => ({ type: 'score', score, confidence: 0.8, probabilities: {}, legend: {} });

test('buildRouter shapes state and asks tier + stakes', () => {
  const { state, questions } = buildRouter({ prompt: 'Find usages of foo', description: 'Find foo', subagent_type: 'Explore' });
  assert.deepEqual(state, { task: 'Find usages of foo', summary: 'Find foo', agent_type: 'Explore' });
  assert.equal(questions.tier.type, 'choice');
  assert.deepEqual(Object.keys(questions.tier.criteria), TIERS);
  assert.equal(questions.stakes.type, 'score');
  assert.equal(questions.stakes.criteria.length, 3);
  assert.ok(buildRouter({ prompt: 'x'.repeat(20000) }).state.task.length <= 12000);
  assert.equal(buildRouter({}).state.agent_type, 'general-purpose');
});

test('confident fast task routes to haiku', () => {
  assert.deepEqual(decideTier({ tier: tier('fast'), stakes: stakes(0.3) }, cfg),
    { tier: 'fast', model: 'haiku', reason: 'routed', confidence: 0.9, stakes: 0.3 });
});

test('standard routes to sonnet, strong leaves model unset', () => {
  assert.equal(decideTier({ tier: tier('standard'), stakes: stakes(1) }, cfg).model, 'sonnet');
  const strong = decideTier({ tier: tier('strong'), stakes: stakes(2) }, cfg);
  assert.equal(strong.model, null);
  assert.equal(strong.reason, 'inherit');
});

test('low confidence never routes', () => {
  const d = decideTier({ tier: tier('fast', 0.59), stakes: stakes(0) }, cfg);
  assert.equal(d.model, null);
  assert.equal(d.reason, 'low_confidence');
  assert.equal(decideTier({ tier: tier('fast', 0.6), stakes: stakes(0) }, cfg).model, 'haiku');
});

test('fast with high stakes bumps to standard', () => {
  const d = decideTier({ tier: tier('fast'), stakes: stakes(1.5) }, cfg);
  assert.equal(d.tier, 'standard');
  assert.equal(d.model, 'sonnet');
  assert.equal(d.reason, 'stakes_bump');
  assert.equal(decideTier({ tier: tier('fast'), stakes: stakes(1.49) }, cfg).model, 'haiku');
});

test('missing or unknown answers give no_answer', () => {
  assert.equal(decideTier({}, cfg).reason, 'no_answer');
  assert.equal(decideTier({ tier: tier('turbo') }, cfg).reason, 'no_answer');
  assert.equal(decideTier({ tier: tier('fast') }, cfg).model, 'haiku');
});

test('custom tier map is honoured', () => {
  const custom = loadConfig({ JEV_ROUTER_TIERS: '{"strong":"opus","fast":null}' });
  assert.equal(decideTier({ tier: tier('strong'), stakes: stakes(2) }, custom).model, 'opus');
  assert.equal(decideTier({ tier: tier('fast'), stakes: stakes(0) }, custom).reason, 'inherit');
});

test('built-in agent types', () => {
  for (const t of ['general-purpose', 'Explore', 'Plan', 'claude']) assert.ok(BUILTIN_AGENT_TYPES.has(t));
  assert.equal(BUILTIN_AGENT_TYPES.has('code-reviewer'), false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/questions-router.test.mjs`
Expected: FAIL with `Cannot find module '../lib/questions.mjs'`.

- [ ] **Step 3: Implement the router part of `lib/questions.mjs`**

```js
// lib/questions.mjs — question builders and pure decision policies. No I/O here.
import path from 'node:path';
import { num, truncate } from './util.mjs';

// ---------------------------------------------------------------- router
export const BUILTIN_AGENT_TYPES = new Set(['general-purpose', 'Explore', 'Plan', 'claude']);
export const TIERS = ['fast', 'standard', 'strong'];

export function buildRouter({ prompt = '', description = '', subagent_type = '' } = {}) {
  return {
    state: {
      task: truncate(prompt, 12000),
      summary: truncate(description, 500),
      agent_type: subagent_type || 'general-purpose',
    },
    questions: {
      tier: {
        type: 'choice',
        instructions: 'Choose the least costly model tier that can complete this delegated task well on the first attempt.',
        criteria: {
          fast: 'Mechanical or narrowly specified work: find files or symbols, read and summarize known files, run a command and report its output, apply a precisely described small edit, rename or format. Little judgment needed.',
          standard: 'Ordinary engineering work needing judgment across several files: implement a described feature, write tests, fix a bug with a known cause, research a question in the codebase and recommend.',
          strong: 'Hard or high-stakes work: architecture or design decisions, debugging with unknown cause across systems, security-sensitive or data-loss-prone changes, subtle concurrency or performance reasoning, work where a wrong answer is expensive.',
        },
      },
      stakes: {
        type: 'score',
        instructions: 'How costly is it if this task is done slightly wrong?',
        criteria: [
          'Trivial: a mistake is easily noticed and redone.',
          'Moderate: a mistake wastes some time or needs a fix later.',
          'High: a mistake could corrupt work, mislead a decision, or be hard to detect.',
        ],
      },
    },
  };
}

export function decideTier(answers, cfg) {
  const tierAnswer = answers?.tier;
  const stakesScore = num(answers?.stakes?.score);
  if (!tierAnswer || !TIERS.includes(tierAnswer.choice)) {
    return { tier: null, model: null, reason: 'no_answer', confidence: 0, stakes: stakesScore };
  }
  const confidence = num(tierAnswer.confidence) ?? 0;
  let tier = tierAnswer.choice;
  if (confidence < cfg.routerMinConfidence) {
    return { tier, model: null, reason: 'low_confidence', confidence, stakes: stakesScore };
  }
  let reason = 'routed';
  if (tier === 'fast' && stakesScore !== null && stakesScore >= 1.5) {
    tier = 'standard';
    reason = 'stakes_bump';
  }
  const model = cfg.routerTiers[tier] ?? null;
  return { tier, model, reason: model ? reason : 'inherit', confidence, stakes: stakesScore };
}
```

(`path` is imported now because the gate builder in Task 7 uses it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/questions-router.test.mjs`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/questions.mjs test/questions-router.test.mjs
git commit -m "feat: router questions and tier policy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Triage questions, guidance, and formatting

**Files:**
- Modify: `lib/questions.mjs` (append)
- Test: `test/questions-triage.test.mjs`

**Interfaces:**
- Produces: `buildTriage({ prompt }) → { state, questions }` with question ids `kind, complexity, needs_live_browser, needs_web, risk`; `triageGuidance(answers) → string`; `formatTriage(answers) → string` (≤ 400 chars, first line starts with `[Jev triage]`).

- [ ] **Step 1: Write the failing tests**

`test/questions-triage.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriage, triageGuidance, formatTriage } from '../lib/questions.mjs';

const answers = (over = {}) => ({
  kind: { type: 'choice', choice: 'debugging', probabilities: { debugging: 0.78, feature: 0.1 }, confidence: 0.7 },
  complexity: { type: 'score', score: 2.4, confidence: 0.66, probabilities: {}, legend: {} },
  needs_live_browser: { type: 'noul', noul: 0.06 },
  needs_web: { type: 'noul', noul: 0.81 },
  risk: { type: 'score', score: 1.1, confidence: 0.6, probabilities: {}, legend: {} },
  ...over,
});

test('buildTriage asks the five questions over the trimmed prompt', () => {
  const { state, questions } = buildTriage({ prompt: '  Fix the login bug  ' });
  assert.deepEqual(state, { user_request: 'Fix the login bug' });
  assert.deepEqual(Object.keys(questions), ['kind', 'complexity', 'needs_live_browser', 'needs_web', 'risk']);
  assert.deepEqual(Object.keys(questions.kind.criteria), ['question', 'small_change', 'feature', 'debugging', 'research', 'ops', 'other']);
  assert.equal(questions.complexity.criteria.length, 4);
  assert.equal(questions.risk.criteria.length, 3);
  assert.equal(questions.needs_live_browser.type, 'noul');
  assert.ok(buildTriage({ prompt: 'x'.repeat(9000) }).state.user_request.length <= 8000);
});

test('guidance rules fire on thresholds', () => {
  assert.equal(triageGuidance(answers()),
    'Hard task: plan first and keep it on the main model. Prefer WebSearch/WebFetch; a browser is not needed.');
  assert.equal(triageGuidance(answers({ complexity: { score: 0.7 }, needs_web: { noul: 0.1 } })),
    'Routine task: act directly, no extended planning.');
  assert.equal(triageGuidance(answers({ complexity: { score: 1.5 }, needs_live_browser: { noul: 0.6 } })),
    'Real browser interaction is likely needed; use the browser tools.');
  assert.equal(triageGuidance(answers({ complexity: { score: 1.5 }, needs_web: { noul: 0.3 }, kind: { choice: 'research' }, risk: { score: 1.5 } })),
    'Delegate broad exploration to Explore subagents (fast tier). Elevated risk: confirm destructive steps with the user first.');
  assert.equal(triageGuidance({}), '');
});

test('formatTriage renders the summary line and guidance under 400 chars', () => {
  const text = formatTriage(answers());
  assert.equal(text,
    '[Jev triage] kind=debugging (p=0.78) · complexity=2.4/3 (conf 0.66) · live browser 0.06 · web info 0.81 · risk 1.1/2\n' +
    'Hard task: plan first and keep it on the main model. Prefer WebSearch/WebFetch; a browser is not needed.');
  assert.ok(text.length <= 400);
  assert.equal(formatTriage({}), '[Jev triage] kind=? (p=?) · complexity=?/3 (conf ?) · live browser ? · web info ? · risk ?/2');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/questions-triage.test.mjs`
Expected: FAIL with `buildTriage is not a function` (or missing export).

- [ ] **Step 3: Append the triage part to `lib/questions.mjs`**

```js
// ---------------------------------------------------------------- triage
export function buildTriage({ prompt = '' } = {}) {
  return {
    state: { user_request: truncate(String(prompt).trim(), 8000) },
    questions: {
      kind: {
        type: 'choice',
        instructions: 'What kind of work does this request primarily ask for?',
        criteria: {
          question: 'Explain, answer, or advise. No changes to files or systems are expected.',
          small_change: 'A small, well-localized edit: a typo, a rename, a config tweak, one function.',
          feature: 'Build or extend functionality across one or more files.',
          debugging: 'Find the cause of a bug, failure, or unexpected behavior and fix it.',
          research: 'Explore or investigate a codebase, a library, or the web and report back.',
          ops: 'Run, deploy, install, migrate, or configure infrastructure or environments.',
          other: 'None of the above.',
        },
      },
      complexity: {
        type: 'score',
        instructions: 'How much reasoning and coordination does this request need?',
        criteria: [
          'Trivial: a single obvious step.',
          'Routine: familiar work with a clear path.',
          'Substantial: several steps with some ambiguity or design choices.',
          'Hard: open-ended, multi-system, or needs careful architectural or debugging reasoning.',
        ],
      },
      needs_live_browser: {
        type: 'noul',
        instructions: 'Does completing this request require operating a real web browser: clicking, typing into forms, logging in, or using a JavaScript-rendered app? Fetching a static page or calling an API does not count.',
        criteria: {
          true: 'The task needs interactive control of a live web page or web app.',
          false: 'No browser interaction is needed, or a plain HTTP fetch would do.',
        },
      },
      needs_web: {
        type: 'noul',
        instructions: 'Does this request need information from the internet that is unlikely to be in the local project or in general programming knowledge, such as recent releases, live data, or third-party documentation?',
      },
      risk: {
        type: 'score',
        instructions: 'If this request were carried out carelessly, how bad could the outcome be?',
        criteria: [
          'Harmless: any mistake is easily undone.',
          'Some risk: a mistake could waste time or need cleanup.',
          'Serious: a mistake could lose data, break production, leak secrets, or affect other people.',
        ],
      },
    },
  };
}

export function triageGuidance(answers) {
  const tips = [];
  const complexity = num(answers?.complexity?.score);
  const browser = num(answers?.needs_live_browser?.noul);
  const web = num(answers?.needs_web?.noul);
  const risk = num(answers?.risk?.score);
  const kind = answers?.kind?.choice;
  if (complexity !== null && complexity >= 2.3) tips.push('Hard task: plan first and keep it on the main model.');
  else if (complexity !== null && complexity <= 0.7) tips.push('Routine task: act directly, no extended planning.');
  if (browser !== null && browser >= 0.6) tips.push('Real browser interaction is likely needed; use the browser tools.');
  else if (browser !== null && browser <= 0.2 && web !== null && web >= 0.6) tips.push('Prefer WebSearch/WebFetch; a browser is not needed.');
  if (kind === 'research') tips.push('Delegate broad exploration to Explore subagents (fast tier).');
  if (risk !== null && risk >= 1.5) tips.push('Elevated risk: confirm destructive steps with the user first.');
  return tips.join(' ');
}

const fmt = (value, digits = 2) => (value === null ? '?' : Number(value).toFixed(digits));

export function formatTriage(answers) {
  const kind = answers?.kind;
  const kindProb = kind?.choice ? num(kind.probabilities?.[kind.choice]) : null;
  const line = `[Jev triage] kind=${kind?.choice ?? '?'} (p=${fmt(kindProb)})`
    + ` · complexity=${fmt(num(answers?.complexity?.score), 1)}/3 (conf ${fmt(num(answers?.complexity?.confidence))})`
    + ` · live browser ${fmt(num(answers?.needs_live_browser?.noul))}`
    + ` · web info ${fmt(num(answers?.needs_web?.noul))}`
    + ` · risk ${fmt(num(answers?.risk?.score), 1)}/2`;
  const guidance = triageGuidance(answers);
  return truncate(guidance ? `${line}\n${guidance}` : line, 400);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/questions-triage.test.mjs test/questions-router.test.mjs`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/questions.mjs test/questions-triage.test.mjs
git commit -m "feat: triage questions, guidance rules, and context formatting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Gate questions and decision policy

**Files:**
- Modify: `lib/questions.mjs` (append)
- Test: `test/questions-gate.test.mjs`

**Interfaces:**
- Produces: `GATE_LEVELS` (4 strings), `GATE_LABELS` (`['safe','low','needs review','dangerous']`), `buildGate({ command, description, cwd }) → { state, questions }` with ids `risk, irreversible, external`; `decideGate(answers, cfg) → { decision: 'ask'|'deny'|'advise'|'none', score, reason }`; `formatGateReason(answers) → string` starting with `Jev risk <score>/3 (<label>)`.

- [ ] **Step 1: Write the failing tests**

`test/questions-gate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../lib/config.mjs';
import { buildGate, decideGate, formatGateReason, GATE_LEVELS, GATE_LABELS } from '../lib/questions.mjs';

const answers = (score, irreversible = 0.83, external = 0.12) => ({
  risk: { type: 'score', score, confidence: 0.7, probabilities: {}, legend: {} },
  irreversible: { type: 'noul', noul: irreversible },
  external: { type: 'noul', noul: external },
});
const ask = loadConfig({});
const deny = loadConfig({ JEV_GATE_MODE: 'deny' });
const advise = loadConfig({ JEV_GATE_MODE: 'advise' });

test('buildGate sends command, intent, and directory name only', () => {
  const { state, questions } = buildGate({ command: 'rm -rf dist', description: 'clean build', cwd: '/Users/x/proj' });
  assert.deepEqual(state, { command: 'rm -rf dist', stated_intent: 'clean build', working_directory: 'proj' });
  assert.deepEqual(Object.keys(questions), ['risk', 'irreversible', 'external']);
  assert.equal(questions.risk.criteria, GATE_LEVELS);
  assert.equal(GATE_LEVELS.length, 4);
  assert.equal(GATE_LABELS.length, 4);
  assert.equal(buildGate({ command: 'x' }).state.working_directory, '');
  assert.ok(buildGate({ command: 'y'.repeat(5000) }).state.command.length <= 4000);
});

test('ask mode: none below warn, advise between, ask at and above ask threshold', () => {
  assert.equal(decideGate(answers(1.29), ask).decision, 'none');
  assert.equal(decideGate(answers(1.3), ask).decision, 'advise');
  assert.equal(decideGate(answers(1.99), ask).decision, 'advise');
  assert.equal(decideGate(answers(2.0), ask).decision, 'ask');
  assert.equal(decideGate(answers(2.9), ask).decision, 'ask');
});

test('deny mode adds deny at the deny threshold', () => {
  assert.equal(decideGate(answers(2.59), deny).decision, 'ask');
  assert.equal(decideGate(answers(2.6), deny).decision, 'deny');
  assert.equal(decideGate(answers(1.5), deny).decision, 'advise');
  assert.equal(decideGate(answers(0.2), deny).decision, 'none');
});

test('advise mode never asks or denies', () => {
  assert.equal(decideGate(answers(3), advise).decision, 'advise');
  assert.equal(decideGate(answers(1.3), advise).decision, 'advise');
  assert.equal(decideGate(answers(1.2), advise).decision, 'none');
});

test('custom thresholds and missing score', () => {
  const custom = loadConfig({ JEV_GATE_ASK_THRESHOLD: '1.0', JEV_GATE_WARN_THRESHOLD: '0.5' });
  assert.equal(decideGate(answers(1.0), custom).decision, 'ask');
  assert.equal(decideGate(answers(0.5), custom).decision, 'advise');
  assert.deepEqual(decideGate({}, ask), { decision: 'none', score: null, reason: '' });
});

test('reason text names the score, label, probabilities, and level description', () => {
  const r = formatGateReason(answers(2.6));
  assert.ok(r.startsWith('Jev risk 2.6/3 (dangerous) · irreversible 0.83 · external 0.12 · Dangerous:'), r);
  assert.ok(formatGateReason(answers(1.4)).startsWith('Jev risk 1.4/3 (low)'));
  assert.ok(formatGateReason(answers(1.5)).startsWith('Jev risk 1.5/3 (needs review)'));
  assert.equal(decideGate(answers(2.6), ask).reason, r);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/questions-gate.test.mjs`
Expected: FAIL with missing export `buildGate`.

- [ ] **Step 3: Append the gate part to `lib/questions.mjs`**

```js
// ---------------------------------------------------------------- gate
export const GATE_LEVELS = [
  'Safe: read-only, builds, tests, or output that changes nothing outside a scratch area.',
  'Low: changes project files in a way that is easy to undo with git or by re-running.',
  'Needs review: deletes or overwrites files, rewrites git history, pushes to a shared remote, installs or removes software system-wide, changes configuration or permissions, or sends data to an external service.',
  'Dangerous: could destroy unrecoverable data, affect production systems or other people, expose secrets, or damage the machine.',
];
export const GATE_LABELS = ['safe', 'low', 'needs review', 'dangerous'];

export function buildGate({ command = '', description = '', cwd = '' } = {}) {
  return {
    state: {
      command: truncate(command, 4000),
      stated_intent: truncate(description, 500),
      working_directory: cwd ? path.basename(cwd) : '',
    },
    questions: {
      risk: {
        type: 'score',
        instructions: 'How risky is it to run this shell command automatically, without a human checking it first?',
        criteria: GATE_LEVELS,
      },
      irreversible: {
        type: 'noul',
        instructions: 'Would the effects of this command be hard or impossible to undo?',
      },
      external: {
        type: 'noul',
        instructions: 'Does this command send data to, or change state on, a system outside this machine, such as a remote git repository, a cloud service, a database server, a deployment target, or a third-party API?',
      },
    },
  };
}

export function formatGateReason(answers) {
  const score = num(answers?.risk?.score);
  const idx = Math.min(GATE_LEVELS.length - 1, Math.max(0, Math.round(score ?? 0)));
  const irr = num(answers?.irreversible?.noul);
  const ext = num(answers?.external?.noul);
  return `Jev risk ${fmt(score, 1)}/3 (${GATE_LABELS[idx]}) · irreversible ${fmt(irr)} · external ${fmt(ext)} · ${GATE_LEVELS[idx]}`;
}

export function decideGate(answers, cfg) {
  const score = num(answers?.risk?.score);
  if (score === null) return { decision: 'none', score: null, reason: '' };
  const { gateMode, gateAskThreshold: ASK, gateDenyThreshold: DENY, gateWarnThreshold: WARN } = cfg;
  let decision = 'none';
  if (gateMode === 'deny') {
    if (score >= DENY) decision = 'deny';
    else if (score >= ASK) decision = 'ask';
    else if (score >= WARN) decision = 'advise';
  } else if (gateMode === 'ask') {
    if (score >= ASK) decision = 'ask';
    else if (score >= WARN) decision = 'advise';
  } else if (score >= WARN) {
    decision = 'advise';
  }
  return { decision, score, reason: formatGateReason(answers) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/questions.mjs test/questions-gate.test.mjs
git commit -m "feat: gate questions and ask/deny/advise policy

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Command prefilter (provably safe commands skip Jev)

**Files:**
- Create: `lib/gate-prefilter.mjs`
- Test: `test/prefilter.test.mjs`

**Interfaces:**
- Produces: `isProvablySafe(command) → boolean`. Returns `true` only for read-only listing/inspection commands, harmless git queries, and a short list of project test/build runners. Everything else returns `false` and goes to Jev. (This refines spec §5.3 by allowlisting `npm test`, `npm run test|build|lint|typecheck|check`, `node --test`, `pytest`, `cargo test|build|check|clippy`, `go test|build|vet`, so the most common runners never pay the round trip.)

- [ ] **Step 1: Write the failing tests**

`test/prefilter.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProvablySafe } from '../lib/gate-prefilter.mjs';

const SAFE = [
  'ls -la', 'cat package.json', 'head -n 40 lib/a.mjs', 'tail -f /var/log/x.log', 'wc -l *.md | sort',
  'git status', 'git log --oneline -5', 'git diff HEAD~1 -- lib', 'git show HEAD:README.md', 'git blame lib/a.mjs',
  'git branch --show-current', 'git branch -a', 'git stash list', 'git remote -v', 'git tag', 'git tag -l "v*"',
  'git config user.name', 'git config --get remote.origin.url', 'git rev-parse HEAD', 'git ls-files',
  'grep -rn "TODO" src', 'rg -n foo --glob "*.ts"', 'find . -name "*.mjs" -not -path "*/node_modules/*"',
  'cd /tmp/proj && ls', 'FOO=1 BAR=2 env', 'pwd', 'which node', 'echo hello', 'printf "%s\\n" a', 'date', 'uname -a',
  'jq .name package.json', 'sed -n \'1,120p\' lib/a.mjs', 'sed -n 5p f.txt', 'awk \'{print $1}\' f.txt',
  'cat a.txt 2>/dev/null', 'ls >/dev/null 2>&1', 'ls &>/dev/null', 'diff a b', 'stat f', 'du -sh .', 'df -h', 'tree -L 2',
  'npm test', 'npm t', 'npm run test', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm ls', 'npm view react version',
  'npm audit', 'node --test test/', 'node --version', 'node --check lib/a.mjs', 'npx tsc --noEmit', 'npx eslint src',
  'npx prettier --check src', 'npx vitest run', 'npx jest', 'pytest -q', 'python3 -m pytest', 'python3 --version',
  'cargo test', 'cargo build', 'cargo check', 'cargo clippy', 'go test ./...', 'go build ./...', 'go vet ./...',
  'pip3 list', 'bun test', 'claude --version', '/usr/bin/ls -1', 'git log --oneline | head -20', 'sort f.txt | uniq',
];

const UNSAFE = [
  '', '   ', 'rm -rf dist', 'git push origin main', 'git push --force', 'git reset --hard', 'git checkout -- .',
  'git branch -D x', 'git branch feature', 'git branch -m old new', 'git stash pop', 'git stash', 'git tag v1.0',
  'git tag -d v1', 'git remote add origin x', 'git config user.name "x"', 'git config --unset a.b', 'git log --output=x',
  'git reflog expire --all', 'npm install lodash', 'npm run deploy', 'npm run dev', 'npm audit fix', 'npm publish',
  'npx create-react-app x', 'npx prettier src', 'npx eslint --fix src', 'npx vitest', 'sed -i "s/a/b/" f',
  'sed -n \'/foo/p\' f', 'awk \'{system("rm x")}\' f', 'cat a > b', 'echo x >> file', 'ls > out.txt',
  'find . -name "*.log" -delete', 'find . -exec rm {} \;', 'find . -execdir sh -c x \;', 'curl https://x',
  'curl -X POST https://x -d @f', 'wget https://x', 'sudo ls', 'ls | xargs rm', 'node -e "process.exit()"',
  'node script.js', 'python3 script.py', 'python3 -c "print(1)"', 'make deploy', 'make', './deploy.sh', 'sh run.sh',
  'bash -c "ls"', 'mkdir -p x', 'touch a', 'cp a b', 'mv a b', 'echo $(rm x)', 'ls `rm x`', 'ls; rm b', 'ls && rm b',
  'kill -9 1', 'ls &', 'env FOO=1 rm x', 'sort -o out f', 'sort --output=out f', 'uniq in out', 'tee f', 'open .',
  'docker compose up', 'kubectl apply -f x', 'terraform apply', 'aws s3 rm s3://x', 'gh pr merge 1', 'ssh host',
  'chmod -R 777 .', 'brew install x', 'pip3 install x', 'cargo publish', 'go run main.go', 'bun run dev', 'claude -p hi',
];

test('provably safe commands are recognised', () => {
  for (const cmd of SAFE) assert.equal(isProvablySafe(cmd), true, `expected safe: ${cmd}`);
});

test('everything else goes to Jev', () => {
  for (const cmd of UNSAFE) assert.equal(isProvablySafe(cmd), false, `expected unsafe: ${cmd}`);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/prefilter.test.mjs`
Expected: FAIL with `Cannot find module '../lib/gate-prefilter.mjs'`.

- [ ] **Step 3: Implement `lib/gate-prefilter.mjs`**

```js
// lib/gate-prefilter.mjs — decides which Bash commands are so obviously read-only that
// asking Jev would only add latency. Conservative by design: when unsure, return false.

const SAFE_BINARIES = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'pwd', 'which', 'type', 'echo', 'printf',
  'printenv', 'date', 'uname', 'whoami', 'id', 'file', 'stat', 'du', 'df', 'tree', 'jq', 'cut', 'tr', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'test', '[', 'diff', 'cmp', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'pytest',
]);

const GIT_QUERIES = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'describe', 'ls-files', 'ls-tree', 'shortlog', 'cat-file', 'count-objects']);
const GIT_BRANCH_FLAGS = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '-l', '--show-current', '--merged', '--no-merged']);
const GIT_BRANCH_PREFIXES = ['--sort=', '--format=', '--contains', '--merged=', '--no-merged=', '--points-at'];
const GIT_TAG_FORBIDDEN = new Set(['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '-F', '-u']);
const NPM_QUERIES = new Set(['--version', '-v', 'ls', 'list', 'll', 'la', 'view', 'info', 'show', 'v', 'outdated', 'why', 'explain', 'root', 'prefix', 'ping', 'search', 'help']);
const NPM_RUN_SAFE = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'format:check', 'lint:check', 'test:unit']);
const CARGO_SAFE = new Set(['test', 'build', 'check', 'clippy', '--version', '-V', 'tree', 'metadata']);
const GO_SAFE = new Set(['test', 'build', 'vet', 'version', 'env', 'list']);
const PIP_SAFE = new Set(['list', 'show', '--version', '-V', 'index', 'freeze', 'check']);
const FIND_FORBIDDEN = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

function hasUnsafeRedirect(cmd) {
  const re = /\d*(>>|&>|>)\s*(&?\S*)/g;
  let m;
  while ((m = re.exec(cmd))) {
    const target = m[2];
    if (target === '&1' || target === '&2' || target === '/dev/null') continue;
    return true;
  }
  return false;
}

function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function gitIsSafe(args) {
  const [sub, ...rest] = args;
  if (!sub) return false;
  if (GIT_QUERIES.has(sub)) return !rest.some((a) => a.startsWith('--output'));
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_FLAGS.has(a) || GIT_BRANCH_PREFIXES.some((p) => a.startsWith(p)));
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show';
  if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url';
  if (sub === 'tag') {
    if (rest.length === 0) return true;
    if (rest.some((a) => GIT_TAG_FORBIDDEN.has(a))) return false;
    return rest.includes('-l') || rest.includes('--list');
  }
  if (sub === 'reflog') return rest.length === 0 || rest[0] === 'show';
  if (sub === 'config') {
    if (rest.some((a) => ['--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--remove-section', '--rename-section'].includes(a))) return false;
    if (rest.includes('--list') || rest.includes('-l') || rest.some((a) => a.startsWith('--get'))) return true;
    return rest.filter((a) => !a.startsWith('-')).length === 1;
  }
  return false;
}

function segmentIsSafe(segment) {
  const tokens = tokenize(segment);
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (tokens.length === 0) return false;
  const [bin, ...args] = tokens;
  const base = bin.replace(/^.*\//, '');
  switch (base) {
    case 'cd': return true;
    case 'env': return args.length === 0;
    case 'git': return gitIsSafe(args);
    case 'find': return !args.some((a) => FIND_FORBIDDEN.test(a));
    case 'sed': return args[0] === '-n' && args.length >= 2 && /^\d+(,\d+)?p$/.test(args[1]) && !args.includes('-i');
    case 'awk': return !/system\s*\(/.test(segment) && !/\bgetline\b/.test(segment);
    case 'sort': return !args.some((a) => a === '-o' || a.startsWith('--output'));
    case 'uniq': return args.filter((a) => !a.startsWith('-')).length <= 1;
    case 'npm':
      if (args[0] === 'test' || args[0] === 't') return true;
      if (args[0] === 'run' || args[0] === 'run-script') return NPM_RUN_SAFE.has(args[1]);
      if (args[0] === 'audit') return args[1] !== 'fix';
      return NPM_QUERIES.has(args[0]);
    case 'npx':
      if (args[0] === 'tsc' || args[0] === 'jest') return true;
      if (args[0] === 'eslint') return !args.includes('--fix');
      if (args[0] === 'prettier') return args.includes('--check') || args.includes('-c');
      if (args[0] === 'vitest') return args[1] === 'run';
      return false;
    case 'node': return ['--version', '-v', '--test', '--check', '-c'].includes(args[0]);
    case 'python':
    case 'python3': return ['--version', '-V'].includes(args[0]) || (args[0] === '-m' && args[1] === 'pytest');
    case 'cargo': return CARGO_SAFE.has(args[0]);
    case 'go': return GO_SAFE.has(args[0]);
    case 'pip':
    case 'pip3': return PIP_SAFE.has(args[0]);
    case 'bun': return args[0] === '--version' || args[0] === 'test';
    case 'claude': return args[0] === '--version';
    default: return SAFE_BINARIES.has(base);
  }
}

export function isProvablySafe(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return false;
  if (/\$\(|`/.test(cmd)) return false;
  if (/(^|\s)(sudo|doas)(\s|$)/.test(cmd)) return false;
  if (hasUnsafeRedirect(cmd)) return false;
  if (/(^|\s)&(\s|$)/.test(cmd)) return false;
  const segments = cmd.split(/\|\|?|&&|;|\n/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(segmentIsSafe);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/prefilter.test.mjs`
Expected: 2 passing. If a listed command fails, fix the rule (not the table) unless the table entry contradicts the "read-only" principle.

- [ ] **Step 5: Commit**

```bash
git add lib/gate-prefilter.mjs test/prefilter.test.mjs
git commit -m "feat: regex prefilter so read-only commands skip the Jev gate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Hook plumbing — stdin, decision log, fail-open runner

**Files:**
- Create: `lib/hook-io.mjs`
- Test: `test/hook-io.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` (Task 2), `createClient`, `redact` (Task 3).
- Produces: `readStdin(stream, { timeoutMs }) → Promise<string>`; `appendDecisionLog(logPath, entry)` (never throws); `runHook(name, handler, { env, stdin, stdout, stderr, exit }) → Promise<void>` where `handler({ input, cfg, client, log }) → object|null`. `client` is `null` when no key is configured. Output object is printed as one JSON line; `exit(0)` is always called.

- [ ] **Step 1: Write the failing tests**

`test/hook-io.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/hook-io.test.mjs`
Expected: FAIL with `Cannot find module '../lib/hook-io.mjs'`.

- [ ] **Step 3: Implement `lib/hook-io.mjs`**

```js
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
    stdout.write(`${JSON.stringify(output)}\n`, () => exit(0));
  } else {
    exit(0);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/hook-io.test.mjs`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/hook-io.mjs test/hook-io.test.mjs
git commit -m "feat: fail-open hook runner with decision log

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Subagent model router hook, launcher, and hooks.json

**Files:**
- Create: `lib/find-node.sh`, `hooks/run-hook.sh`, `hooks/hooks.json`, `hooks/route-agent.mjs`
- Test: `test/hooks-route.test.mjs`

**Interfaces:**
- Consumes: `runHook` (Task 9), `buildRouter`, `decideTier`, `BUILTIN_AGENT_TYPES` (Task 5), `preview` (Task 2), `startMockBackend`, `runScript` (Task 4).
- Produces: `hooks/run-hook.sh <name>` executes `hooks/<name>.mjs` with a discovered `node`; `find_node` shell function printing a node path (exit 1 if none). Hook output on success: `{ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...tool_input, model }, additionalContext } }`.

- [ ] **Step 1: Write the failing tests**

`test/hooks-route.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript, ROOT } from './helpers/spawn.mjs';

let backend;
before(async () => { backend = await startMockBackend({ answers: routed('fast', 0.9, 0.2) }); });
after(() => backend.close());

function routed(choice, confidence, stakes) {
  return {
    tier: { type: 'choice', choice, probabilities: { [choice]: confidence }, confidence },
    stakes: { type: 'score', score: stakes, confidence: 0.9, probabilities: {}, legend: {} },
  };
}

const input = (toolInput = {}, extra = {}) => JSON.stringify({
  session_id: 's1', cwd: '/tmp/proj', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1',
  tool_input: { prompt: 'Find every usage of parseConfig in src and list the files', description: 'Find parseConfig usages', subagent_type: 'Explore', ...toolInput },
  ...extra,
});

const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'test-key', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

test('routes a mechanical Explore task to haiku and keeps every other field', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/route-agent.mjs', { input: input(), env: env() });
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.deepEqual(out.hookSpecificOutput.updatedInput, {
    prompt: 'Find every usage of parseConfig in src and list the files', description: 'Find parseConfig usages', subagent_type: 'Explore', model: 'haiku',
  });
  assert.equal(out.hookSpecificOutput.additionalContext, 'Jev routed this subagent to haiku (tier=fast, p=0.90, stakes=0.2).');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(backend.requests.length, 1);
  assert.equal(backend.requests[0].body.state.agent_type, 'Explore');
  assert.ok(backend.requests[0].body.questions.tier);
});

test('respects an explicit model unless override is on', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input({ model: 'opus' }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const out = parse(await runScript('hooks/route-agent.mjs', { input: input({ model: 'opus' }), env: env({ JEV_ROUTER_OVERRIDE: '1' }) }));
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('skips custom subagent types unless enabled', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input({ subagent_type: 'code-reviewer' }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const out = parse(await runScript('hooks/route-agent.mjs', { input: input({ subagent_type: 'code-reviewer' }), env: env({ JEV_ROUTER_CUSTOM_AGENTS: '1' }) }));
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'haiku');
});

test('low confidence, strong tier, disabled router, other tools, missing key → no output', async () => {
  backend.setAnswers(routed('fast', 0.4, 0));
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input(), env: env() })), null);
  backend.setAnswers(routed('strong', 0.95, 2));
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input(), env: env() })), null);
  backend.setAnswers(routed('fast', 0.9, 0.2));
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input(), env: env({ JEV_ROUTER: '0' }) })), null);
  assert.equal(parse(await runScript('hooks/route-agent.mjs', { input: input({}, { tool_name: 'Bash' }), env: env() })), null);
  const noKey = await runScript('hooks/route-agent.mjs', { input: input(), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.code, 0);
  assert.equal(noKey.stdout, '');
});

test('backend down or failing is fail-open with exit 0', async () => {
  const down = await runScript('hooks/route-agent.mjs', { input: input(), env: env({ JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '500' }) });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, '');
  backend.queue(500, 'x'); backend.queue(500, 'x'); backend.queue(500, 'x');
  const failing = await runScript('hooks/route-agent.mjs', { input: input(), env: env({ JEV_HOOK_TIMEOUT_MS: '2000' }) });
  assert.equal(failing.code, 0);
  assert.equal(failing.stdout, '');
});

test('run-hook.sh finds node and runs the hook; unknown name is silent', async () => {
  const r = await runScript(path.join(ROOT, 'hooks/run-hook.sh'), { command: 'sh', args: ['route-agent'], input: input(), env: env() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(parse(r).hookSpecificOutput.updatedInput.model, 'haiku');
  const unknown = await runScript(path.join(ROOT, 'hooks/run-hook.sh'), { command: 'sh', args: ['nope'], input: input(), env: env() });
  assert.equal(unknown.code, 0);
  assert.equal(unknown.stdout, '');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/hooks-route.test.mjs`
Expected: FAIL (`hooks/route-agent.mjs` does not exist; node reports `Cannot find module`).

- [ ] **Step 3: Create `lib/find-node.sh`**

```sh
#!/bin/sh
# lib/find-node.sh — sourced by launchers. find_node prints a node binary path or exits 1.
# The desktop app runs hooks with a minimal PATH, so Homebrew and version managers are probed too.
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.bun/bin/node"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  for dir in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/share/fnm/node-versions/*/installation/bin "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin; do
    if [ -x "$dir/node" ]; then
      echo "$dir/node"
      return 0
    fi
  done
  return 1
}
```

- [ ] **Step 4: Create `hooks/run-hook.sh`**

```sh
#!/bin/sh
# hooks/run-hook.sh <hook-name> — runs hooks/<hook-name>.mjs with a discovered node.
# Fail-open: if node or the hook is missing, exit 0 with no output so the tool call proceeds.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/lib/find-node.sh"
NODE="$(find_node)" || exit 0
HOOK="$ROOT/hooks/$1.mjs"
[ -n "$1" ] && [ -f "$HOOK" ] || exit 0
exec "$NODE" "$HOOK"
```

Then: `chmod +x hooks/run-hook.sh lib/find-node.sh`.

- [ ] **Step 5: Create `hooks/hooks.json`**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\" route-agent",
            "timeout": 15,
            "statusMessage": "Jev: choosing subagent model"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\" gate-bash",
            "timeout": 15,
            "statusMessage": "Jev: screening command"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh\" triage-prompt",
            "timeout": 15,
            "statusMessage": "Jev: triaging request"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 6: Create `hooks/route-agent.mjs`**

```js
#!/usr/bin/env node
// hooks/route-agent.mjs — PreToolUse(Agent): pick the cheapest capable model tier for a delegated task.
import { runHook } from '../lib/hook-io.mjs';
import { buildRouter, decideTier, BUILTIN_AGENT_TYPES } from '../lib/questions.mjs';
import { preview } from '../lib/util.mjs';

runHook('route-agent', async ({ input, cfg, client, log }) => {
  if (!cfg.router || !client) return null;
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Agent') return null;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  if (toolInput.model && !cfg.routerOverride) {
    log({ decision: 'skip_explicit_model', model: toolInput.model });
    return null;
  }
  const agentType = toolInput.subagent_type || 'general-purpose';
  if (!BUILTIN_AGENT_TYPES.has(agentType) && !cfg.routerCustomAgents) {
    log({ decision: 'skip_custom_agent', agent_type: agentType });
    return null;
  }
  const { state, questions } = buildRouter({ prompt: toolInput.prompt, description: toolInput.description, subagent_type: agentType });
  const res = await client.systemOne({ state, questions }, { timeoutMs: cfg.hookTimeoutMs });
  const d = decideTier(res.answers, cfg);
  log({ decision: d.reason, tier: d.tier, model: d.model, confidence: d.confidence, stakes: d.stakes, preview: preview(toolInput.description || toolInput.prompt) });
  if (!d.model) return null;
  const stakesText = d.stakes === null ? '' : `, stakes=${d.stakes.toFixed(1)}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...toolInput, model: d.model },
      additionalContext: `Jev routed this subagent to ${d.model} (tier=${d.tier}, p=${d.confidence.toFixed(2)}${stakesText}).`,
    },
  };
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `node --test test/hooks-route.test.mjs`
Expected: 6 passing.

- [ ] **Step 8: Commit**

```bash
git add lib/find-node.sh hooks/run-hook.sh hooks/hooks.json hooks/route-agent.mjs test/hooks-route.test.mjs
git commit -m "feat: subagent model router hook with node launcher and hooks.json

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Request triage hook

**Files:**
- Create: `hooks/triage-prompt.mjs`
- Test: `test/hooks-triage.test.mjs`

**Interfaces:**
- Consumes: `runHook`, `buildTriage`, `formatTriage`, `num`, `preview`.
- Produces: output `{ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }` or nothing.

- [ ] **Step 1: Write the failing tests**

`test/hooks-triage.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';

let backend;
before(async () => {
  backend = await startMockBackend({ answers: {
    kind: { type: 'choice', choice: 'debugging', probabilities: { debugging: 0.78 }, confidence: 0.7 },
    complexity: { type: 'score', score: 2.4, confidence: 0.66, probabilities: {}, legend: {} },
    needs_live_browser: { type: 'noul', noul: 0.06 },
    needs_web: { type: 'noul', noul: 0.81 },
    risk: { type: 'score', score: 1.1, confidence: 0.6, probabilities: {}, legend: {} },
  } });
});
after(() => backend.close());

const input = (prompt) => JSON.stringify({ session_id: 's', cwd: '/tmp', hook_event_name: 'UserPromptSubmit', prompt });
const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

test('a real request gets a triage note', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/triage-prompt.mjs', { input: input('The login page throws 500 after deploy, find out why and fix it'), env: env() });
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(out.hookSpecificOutput.additionalContext,
    '[Jev triage] kind=debugging (p=0.78) · complexity=2.4/3 (conf 0.66) · live browser 0.06 · web info 0.81 · risk 1.1/2\n'
    + 'Hard task: plan first and keep it on the main model. Prefer WebSearch/WebFetch; a browser is not needed.');
  assert.equal(backend.requests[0].body.state.user_request, 'The login page throws 500 after deploy, find out why and fix it');
});

test('slash commands, short prompts, disabled triage, wrong event, missing key → no output', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input('/jev:status now please'), env: env() })), null);
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input('ok thanks'), env: env() })), null);
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: input('Please refactor the whole auth module'), env: env({ JEV_TRIAGE: '0' }) })), null);
  assert.equal(parse(await runScript('hooks/triage-prompt.mjs', { input: JSON.stringify({ hook_event_name: 'PreToolUse', prompt: 'Please refactor the whole auth module' }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const noKey = await runScript('hooks/triage-prompt.mjs', { input: input('Please refactor the whole auth module'), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.code, 0);
  assert.equal(noKey.stdout, '');
});

test('backend failure is fail-open', async () => {
  const r = await runScript('hooks/triage-prompt.mjs', { input: input('Please refactor the whole auth module'), env: env({ JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '300' }) });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/hooks-triage.test.mjs`
Expected: FAIL (`hooks/triage-prompt.mjs` missing).

- [ ] **Step 3: Create `hooks/triage-prompt.mjs`**

```js
#!/usr/bin/env node
// hooks/triage-prompt.mjs — UserPromptSubmit: fast System-One read of the request, injected as advice.
import { runHook } from '../lib/hook-io.mjs';
import { buildTriage, formatTriage } from '../lib/questions.mjs';
import { num, preview } from '../lib/util.mjs';

runHook('triage-prompt', async ({ input, cfg, client, log }) => {
  if (!cfg.triage || !client) return null;
  if (input.hook_event_name !== 'UserPromptSubmit') return null;
  const prompt = String(input.prompt ?? '').trim();
  if (prompt.length < 15 || prompt.startsWith('/')) {
    log({ decision: 'skip_short_or_command' });
    return null;
  }
  const { state, questions } = buildTriage({ prompt });
  const res = await client.systemOne({ state, questions }, { timeoutMs: cfg.hookTimeoutMs });
  const text = formatTriage(res.answers);
  log({
    decision: 'triaged',
    kind: res.answers.kind?.choice ?? null,
    complexity: num(res.answers.complexity?.score),
    risk: num(res.answers.risk?.score),
    browser: num(res.answers.needs_live_browser?.noul),
    preview: preview(prompt),
  });
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/hooks-triage.test.mjs`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add hooks/triage-prompt.mjs test/hooks-triage.test.mjs
git commit -m "feat: request triage hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Bash risk gate hook

**Files:**
- Create: `hooks/gate-bash.mjs`
- Test: `test/hooks-gate.test.mjs`

**Interfaces:**
- Consumes: `runHook`, `isProvablySafe` (Task 8), `buildGate`, `decideGate` (Task 7), `preview`.
- Produces: `ask`/`deny` → `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }`; `advise` → `{ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[Jev gate] …' } }`; otherwise nothing.

- [ ] **Step 1: Write the failing tests**

`test/hooks-gate.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';

let backend;
before(async () => { backend = await startMockBackend({ answers: risk(2.6) }); });
after(() => backend.close());

function risk(score, irreversible = 0.83, external = 0.12) {
  return {
    risk: { type: 'score', score, confidence: 0.7, probabilities: {}, legend: {} },
    irreversible: { type: 'noul', noul: irreversible },
    external: { type: 'noul', noul: external },
  };
}
const input = (command, description = 'clean up') => JSON.stringify({
  session_id: 's', cwd: '/Users/x/proj', permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't',
  tool_input: { command, description },
});
const env = (extra = {}) => ({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url, ...extra });
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

test('dangerous command asks in the default mode with a Jev reason', async () => {
  backend.requests.length = 0;
  const r = await runScript('hooks/gate-bash.mjs', { input: input('rm -rf ~/projects/old'), env: env() });
  assert.equal(r.code, 0, r.stderr);
  const out = parse(r);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.startsWith('Jev risk 2.6/3 (dangerous) · irreversible 0.83 · external 0.12 · Dangerous:'));
  assert.deepEqual(backend.requests[0].body.state, { command: 'rm -rf ~/projects/old', stated_intent: 'clean up', working_directory: 'proj' });
  assert.ok(!r.stdout.includes('"allow"'));
});

test('provably safe commands never call Jev', async () => {
  backend.requests.length = 0;
  for (const cmd of ['ls -la', 'git status', 'npm test', 'cat README.md | head -20']) {
    assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input(cmd), env: env() })), null, cmd);
  }
  assert.equal(backend.requests.length, 0);
});

test('moderate risk becomes advice, low risk nothing', async () => {
  backend.setAnswers(risk(1.5));
  const out = parse(await runScript('hooks/gate-bash.mjs', { input: input('sed -i "s/a/b/" config.yml'), env: env() }));
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(out.hookSpecificOutput.additionalContext.startsWith('[Jev gate] Jev risk 1.5/3 (needs review)'));
  backend.setAnswers(risk(0.3));
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('npm install'), env: env() })), null);
  backend.setAnswers(risk(2.6));
});

test('deny and advise modes', async () => {
  backend.setAnswers(risk(2.7));
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('git push --force origin main'), env: env({ JEV_GATE_MODE: 'deny' }) })).hookSpecificOutput.permissionDecision, 'deny');
  const advised = parse(await runScript('hooks/gate-bash.mjs', { input: input('git push --force origin main'), env: env({ JEV_GATE_MODE: 'advise' }) }));
  assert.equal(advised.hookSpecificOutput.permissionDecision, undefined);
  assert.ok(advised.hookSpecificOutput.additionalContext.startsWith('[Jev gate] Jev risk 2.7/3 (dangerous)'));
  backend.setAnswers(risk(2.6));
});

test('disabled gate, empty command, wrong tool, missing key, backend down → nothing, exit 0', async () => {
  backend.requests.length = 0;
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('rm -rf x'), env: env({ JEV_GATE: '0' }) })), null);
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: input('   '), env: env() })), null);
  assert.equal(parse(await runScript('hooks/gate-bash.mjs', { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'x' } }), env: env() })), null);
  assert.equal(backend.requests.length, 0);
  const noKey = await runScript('hooks/gate-bash.mjs', { input: input('rm -rf x'), env: { JEV_BASE_URL: backend.url } });
  assert.equal(noKey.stdout, '');
  const down = await runScript('hooks/gate-bash.mjs', { input: input('rm -rf x'), env: env({ JEV_BASE_URL: 'http://127.0.0.1:9', JEV_HOOK_TIMEOUT_MS: '300' }) });
  assert.equal(down.code, 0);
  assert.equal(down.stdout, '');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/hooks-gate.test.mjs`
Expected: FAIL (`hooks/gate-bash.mjs` missing).

- [ ] **Step 3: Create `hooks/gate-bash.mjs`**

```js
#!/usr/bin/env node
// hooks/gate-bash.mjs — PreToolUse(Bash): risk-screen commands. Never returns "allow".
import { runHook } from '../lib/hook-io.mjs';
import { isProvablySafe } from '../lib/gate-prefilter.mjs';
import { buildGate, decideGate } from '../lib/questions.mjs';
import { preview } from '../lib/util.mjs';

runHook('gate-bash', async ({ input, cfg, client, log }) => {
  if (!cfg.gate || !client) return null;
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return null;
  const command = String(input.tool_input?.command ?? '');
  if (!command.trim()) return null;
  if (isProvablySafe(command)) {
    log({ decision: 'prefilter_safe', preview: preview(command) });
    return null;
  }
  const { state, questions } = buildGate({ command, description: input.tool_input?.description, cwd: input.cwd });
  const res = await client.systemOne({ state, questions }, { timeoutMs: cfg.hookTimeoutMs });
  const g = decideGate(res.answers, cfg);
  log({ decision: g.decision, score: g.score, preview: preview(command) });
  if (g.decision === 'ask' || g.decision === 'deny') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: g.decision, permissionDecisionReason: g.reason } };
  }
  if (g.decision === 'advise') {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `[Jev gate] ${g.reason}. Double-check this command's effects before relying on its result.` } };
  }
  return null;
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add hooks/gate-bash.mjs test/hooks-gate.test.mjs
git commit -m "feat: Bash risk gate hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Question validation and the minimal MCP protocol layer

**Files:**
- Create: `lib/validate.mjs`, `lib/mcp-protocol.mjs`
- Test: `test/validate.test.mjs`, `test/mcp-protocol.test.mjs`

**Interfaces:**
- Produces: `validateQuestion(q, id) → true` (throws `Error` with `<id>: …` message), `validateQuestions(questions) → true`; `SUPPORTED_PROTOCOLS`; `toToolResult(value)`; `createServer({ name, version, instructions, tools }) → { name, version, instructions, tools, handle(msg) → Promise<response|response[]|null> }` where each tool is `{ name, description, inputSchema, annotations?, handler(args) → Promise<any> }`; `serve(server, { input, output, onEnd })` reads newline-delimited JSON-RPC from `input` and writes responses to `output`.

- [ ] **Step 1: Write the failing tests**

`test/validate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestion, validateQuestions } from '../lib/validate.mjs';

test('accepts well-formed questions of each type', () => {
  assert.equal(validateQuestion({ type: 'noul', instructions: 'Is it red?' }), true);
  assert.equal(validateQuestion({ type: 'noul', instructions: 'Is it red?', criteria: { true: 'red', false: 'not red' } }), true);
  assert.equal(validateQuestion({ type: 'choice', instructions: { ask: 'which' }, criteria: { a: 'A', b: null } }), true);
  assert.equal(validateQuestion({ type: 'score', instructions: ['x'], criteria: ['lo', { summary: 'hi' }] }), true);
});

test('rejects malformed questions with the id in the message', () => {
  const bad = [
    [null, /q1: must be an object/],
    [{ type: 'maybe', instructions: 'x' }, /q1: type must be/],
    [{ type: 'noul', instructions: '  ' }, /q1: instructions/],
    [{ type: 'choice', instructions: 'x' }, /q1: choice needs criteria/],
    [{ type: 'choice', instructions: 'x', criteria: {} }, /q1: choice needs criteria/],
    [{ type: 'choice', instructions: 'x', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, '']))}, /q1: choice supports at most 255/],
    [{ type: 'score', instructions: 'x', criteria: ['only'] }, /q1: score needs criteria/],
    [{ type: 'score', instructions: 'x', criteria: Array(11).fill('l') }, /q1: score needs criteria/],
    [{ type: 'noul', instructions: 'x', criteria: 'yes' }, /q1: noul criteria/],
  ];
  for (const [q, re] of bad) assert.throws(() => validateQuestion(q, 'q1'), re);
});

test('validateQuestions needs a non-empty object', () => {
  assert.throws(() => validateQuestions({}), /non-empty object/);
  assert.throws(() => validateQuestions([]), /non-empty object/);
  assert.throws(() => validateQuestions({ a: { type: 'score', instructions: 'x', criteria: [] } }), /a: score needs criteria/);
  assert.equal(validateQuestions({ a: { type: 'noul', instructions: 'x' } }), true);
});
```

`test/mcp-protocol.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer, serve, toToolResult, SUPPORTED_PROTOCOLS } from '../lib/mcp-protocol.mjs';

const tools = [
  { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { x: { type: 'string' } } }, annotations: { readOnlyHint: true }, handler: async ({ x }) => ({ x }) },
  { name: 'boom', description: 'boom', inputSchema: { type: 'object' }, handler: async () => { throw new Error('kaboom'); } },
  { name: 'raw', description: 'raw', inputSchema: { type: 'object' }, handler: async () => ({ content: [{ type: 'text', text: 'already shaped' }] }) },
];
const server = createServer({ name: 'jev', version: '0.1.0', instructions: 'use me', tools });
const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('initialize echoes a supported protocol version and advertises tools', async () => {
  const res = await server.handle(req(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
  assert.deepEqual(res, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'jev', version: '0.1.0' }, instructions: 'use me' } });
  const other = await server.handle(req(2, 'initialize', { protocolVersion: '1999-01-01' }));
  assert.equal(other.result.protocolVersion, SUPPORTED_PROTOCOLS[0]);
});

test('ping, tools/list, notifications', async () => {
  assert.deepEqual(await server.handle(req(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
  const list = await server.handle(req(4, 'tools/list'));
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom', 'raw']);
  assert.deepEqual(list.result.tools[0].annotations, { readOnlyHint: true });
  assert.equal(list.result.tools[1].annotations, undefined);
  assert.equal(list.result.tools[0].handler, undefined);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await server.handle({ jsonrpc: '2.0', id: 9, result: {} }), null);
});

test('tools/call success, tool error, unknown tool, unknown method, invalid request', async () => {
  const ok = await server.handle(req(5, 'tools/call', { name: 'echo', arguments: { x: 'hi' } }));
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: JSON.stringify({ x: 'hi' }, null, 2) }] });
  const err = await server.handle(req(6, 'tools/call', { name: 'boom', arguments: {} }));
  assert.deepEqual(err.result, { content: [{ type: 'text', text: 'Error: kaboom' }], isError: true });
  const raw = await server.handle(req(7, 'tools/call', { name: 'raw' }));
  assert.equal(raw.result.content[0].text, 'already shaped');
  assert.equal((await server.handle(req(8, 'tools/call', { name: 'nope' }))).error.code, -32602);
  assert.equal((await server.handle(req(9, 'resources/list'))).error.code, -32601);
  assert.equal((await server.handle('junk')).error.code, -32600);
});

test('batch arrays are answered element by element', async () => {
  const res = await server.handle([req(10, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, req(11, 'ping')]);
  assert.deepEqual(res.map((r) => r.id), [10, 11]);
  assert.equal(await server.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
});

test('toToolResult wraps plain values', () => {
  assert.deepEqual(toToolResult('text'), { content: [{ type: 'text', text: 'text' }] });
  assert.deepEqual(toToolResult({ a: 1 }), { content: [{ type: 'text', text: '{\n  "a": 1\n}' }] });
});

test('serve reads lines and writes responses, reports parse errors', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  serve(server, { input, output, onEnd: () => { closed = true; } });
  const lines = [];
  output.on('data', (chunk) => { for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); });
  input.write(`${JSON.stringify(req(1, 'ping'))}\n`);
  input.write('this is not json\n');
  input.write('\n');
  input.write(`${JSON.stringify(req(2, 'tools/call', { name: 'echo', arguments: { x: 'y' } }))}\n`);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lines.find((l) => l.id === 1), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(lines.find((l) => l.id === null).error.code, -32700);
  assert.equal(JSON.parse(lines.find((l) => l.id === 2).result.content[0].text).x, 'y');
  input.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/validate.test.mjs test/mcp-protocol.test.mjs`
Expected: FAIL with missing modules.

- [ ] **Step 3: Implement `lib/validate.mjs`**

```js
// lib/validate.mjs — checks question shapes before they are sent, so errors name the field, not a 422.
const TYPES = new Set(['noul', 'choice', 'score']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateQuestion(q, id = 'question') {
  if (!isPlainObject(q)) throw new Error(`${id}: must be an object with type and instructions`);
  if (!TYPES.has(q.type)) throw new Error(`${id}: type must be noul, choice, or score`);
  const ins = q.instructions;
  const ok = (typeof ins === 'string' && ins.trim().length > 0) || isPlainObject(ins) || (Array.isArray(ins) && ins.length > 0);
  if (!ok) throw new Error(`${id}: instructions must be a non-empty string, object, or array`);
  if (q.type === 'choice') {
    if (!isPlainObject(q.criteria) || Object.keys(q.criteria).length < 1) throw new Error(`${id}: choice needs criteria as a map of option -> description`);
    if (Object.keys(q.criteria).length > 255) throw new Error(`${id}: choice supports at most 255 options`);
  }
  if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) {
    throw new Error(`${id}: score needs criteria as an ordered array of 2-10 level descriptions`);
  }
  if (q.type === 'noul' && q.criteria !== undefined && !isPlainObject(q.criteria)) {
    throw new Error(`${id}: noul criteria must be an object with optional true/false descriptions`);
  }
  return true;
}

export function validateQuestions(questions) {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) throw new Error('questions must be a non-empty object of id -> question');
  for (const [id, q] of Object.entries(questions)) validateQuestion(q, id);
  return true;
}
```

- [ ] **Step 4: Implement `lib/mcp-protocol.mjs`**

```js
// lib/mcp-protocol.mjs — the subset of MCP a tools-only stdio server needs. Newline-delimited JSON-RPC 2.0.
// Stdout carries only protocol frames; anything human-readable goes to stderr.
import readline from 'node:readline';

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export function toToolResult(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function createServer({ name, version, instructions = '', tools = [] }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function handleOne(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
    const { id, method, params } = msg;
    if (typeof method !== 'string') return null;
    if (id === undefined || id === null) return null;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const result = {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name, version },
        };
        if (instructions) result.instructions = instructions;
        return rpcResult(id, result);
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: tools.map(({ name: toolName, description, inputSchema, annotations }) => ({
            name: toolName, description, inputSchema, ...(annotations ? { annotations } : {}),
          })),
        });
      case 'tools/call': {
        const tool = byName.get(params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          return rpcResult(id, toToolResult(await tool.handler(params?.arguments ?? {})));
        } catch (err) {
          return rpcResult(id, { content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    name,
    version,
    instructions,
    tools,
    async handle(msg) {
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map(handleOne))).filter(Boolean);
        return out.length ? out : null;
      }
      return handleOne(msg);
    },
  };
}

export function serve(server, { input = process.stdin, output = process.stdout, onEnd = () => process.exit(0) } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const write = (obj) => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      write(rpcError(null, -32700, 'Parse error'));
      return;
    }
    server.handle(msg).then(write, (err) => write(rpcError(msg?.id ?? null, -32603, `Internal error: ${err?.message || err}`)));
  });
  rl.on('close', onEnd);
  return rl;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/validate.test.mjs test/mcp-protocol.test.mjs`
Expected: 9 passing.

- [ ] **Step 6: Commit**

```bash
git add lib/validate.mjs lib/mcp-protocol.mjs test/validate.test.mjs test/mcp-protocol.test.mjs
git commit -m "feat: question validation and minimal MCP stdio protocol layer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: MCP server with decide, choose, score, check

**Files:**
- Create: `server/mcp.mjs`, `bin/jev-mcp`, `.mcp.json`
- Test: `test/mcp-server.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `createClient`, `createServer`, `serve`, `validateQuestion(s)`, `num`, `startMcp` (Task 4).
- Produces: `SERVER_VERSION`, `INSTRUCTIONS`, `buildTools({ client, cfg }) → tool[]` (Task 15 appends `batch` and `route`), `main()`; `bin/jev-mcp` launcher; `.mcp.json` registering server `jev`.

- [ ] **Step 1: Write the failing tests**

`test/mcp-server.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { startMcp } from './helpers/spawn.mjs';

let backend;
let mcp;
before(async () => {
  backend = await startMockBackend();
  mcp = startMcp({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url });
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'jev');
  assert.ok(init.result.instructions.includes('Jev'));
  mcp.notify('notifications/initialized');
});
after(async () => { await mcp.close(); await backend.close(); });

test('tools/list exposes the core tools with object schemas and read-only annotations', async () => {
  const res = await mcp.request('tools/list');
  const names = res.result.tools.map((t) => t.name);
  for (const n of ['decide', 'choose', 'score', 'check']) assert.ok(names.includes(n), n);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40, t.name);
    assert.deepEqual(t.annotations, { readOnlyHint: true, openWorldHint: true });
  }
});

test('choose returns the winner with probabilities and confidence', async () => {
  backend.setAnswers({ result: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.88 } });
  const r = await mcp.call('choose', { state: 'My card was charged twice', instructions: 'What is this about?', options: { billing: 'money', technical: 'bugs' } });
  assert.equal(r.isError, false);
  assert.deepEqual(r.json, { choice: 'billing', probabilities: { billing: 0.9, technical: 0.1 }, confidence: 0.88 });
  const sent = backend.requests.at(-1).body;
  assert.deepEqual(sent.questions, { result: { type: 'choice', instructions: 'What is this about?', criteria: { billing: 'money', technical: 'bugs' } } });
  assert.equal(sent.model, 'jev-latest');
});

test('score returns the fractional score, nearest level, and legend', async () => {
  backend.setAnswers({ result: { type: 'score', score: 1.3, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, legend: { 0: 'low', 1: 'mid', 2: 'high' }, confidence: 0.54 } });
  const r = await mcp.call('score', { state: 'x', instructions: 'How urgent?', levels: ['low', 'mid', 'high'], model: 'jev-preview' });
  assert.deepEqual(r.json, { score: 1.3, max: 2, nearest_level: 1, nearest_level_description: 'mid', legend: { 0: 'low', 1: 'mid', 2: 'high' }, probabilities: { 0: 0, 1: 0.7, 2: 0.3 }, confidence: 0.54 });
  assert.equal(backend.requests.at(-1).body.model, 'jev-preview');
});

test('check returns probability and likely flag, passing criteria through', async () => {
  backend.setAnswers({ result: { type: 'noul', noul: 0.72 } });
  const r = await mcp.call('check', { state: 'x', instructions: 'Is it urgent?', criteria: { true: 'yes', false: 'no' } });
  assert.deepEqual(r.json, { probability: 0.72, likely: true });
  assert.deepEqual(backend.requests.at(-1).body.questions.result.criteria, { true: 'yes', false: 'no' });
});

test('decide returns the raw answers and validates first', async () => {
  backend.setAnswers(null);
  const r = await mcp.call('decide', { state: { a: 1 }, questions: { u: { type: 'noul', instructions: 'q' }, k: { type: 'choice', instructions: 'q', criteria: { x: '', y: '' } } } });
  assert.equal(r.json.answers.u.noul, 0.5);
  assert.equal(r.json.answers.k.choice, 'x');
  assert.equal(r.json.model, 'jev-latest');
  const bad = await mcp.call('decide', { state: 'x', questions: { k: { type: 'choice', instructions: 'q' } } });
  assert.equal(bad.isError, true);
  assert.ok(bad.text.includes('k: choice needs criteria'));
  const empty = await mcp.call('decide', { state: 'x', questions: {} });
  assert.ok(empty.isError && empty.text.includes('non-empty'));
});

test('validation failures from the API surface as tool errors', async () => {
  const r = await mcp.call('check', { state: 'has __FAIL__ marker', instructions: 'q' });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('422'));
});

test('without a key the server still starts and tools explain how to set one', async () => {
  const bare = startMcp({ JEV_BASE_URL: backend.url });
  try {
    await bare.request('initialize', { protocolVersion: '2025-06-18' });
    const r = await bare.call('check', { state: 'x', instructions: 'q' });
    assert.equal(r.isError, true);
    assert.ok(r.text.includes('TYPESAFE_API_KEY'));
  } finally {
    await bare.close();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/mcp-server.test.mjs`
Expected: FAIL (server file missing; requests time out or spawn errors).

- [ ] **Step 3: Create `server/mcp.mjs`**

```js
#!/usr/bin/env node
// server/mcp.mjs — the jev MCP server: Jev's three primitives as tools, plus batch and route.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { createClient } from '../lib/jev-client.mjs';
import { createServer, serve } from '../lib/mcp-protocol.mjs';
import { validateQuestion, validateQuestions } from '../lib/validate.mjs';
import { buildRouter, decideTier } from '../lib/questions.mjs';
import { num } from '../lib/util.mjs';

export const SERVER_VERSION = '0.1.0';
export const INSTRUCTIONS = 'Jev (TypeSafe System One) returns typed answers with calibrated probabilities in about 200 ms: choose one option, place on an ordered scale, or answer yes/no. Use it for judgments whose possible answers can be listed up front, for classifying or ranking many items the same way, and for picking a model tier for a subtask. Never for generating text or code. Calls send the supplied state to TypeSafe and are billed to the configured key.';

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };
const STATE = { type: ['string', 'object', 'array'], description: 'What to judge: plain text, or a JSON object/array with named fields. Send only what the questions need.' };
const INSTR = { type: ['string', 'object', 'array'], description: 'The judgment to make, stated as the exact condition or question. A string, or an object/array with definitions, contrasts, and examples.' };
const MODEL = { type: 'string', description: 'Jev model id; defaults to the configured model (jev-latest).' };
export const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'noul = probability a yes/no condition holds; choice = one option from criteria; score = probability-weighted position on ordered criteria levels.' },
    instructions: INSTR,
    criteria: { description: 'noul: optional {"true": "...", "false": "..."}; choice (required): map of option -> description, up to 255; score (required): ordered array of 2-10 level descriptions, low to high.' },
  },
  required: ['type', 'instructions'],
};

export async function runWithConcurrency(fns, limit) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const i = next++;
      results[i] = await fns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, fns.length)) }, worker));
  return results;
}

export function buildTools({ client, cfg }) {
  const call = (req) => client.systemOne(req, { timeoutMs: cfg.toolTimeoutMs });

  return [
    {
      name: 'decide',
      description: 'Ask Jev several typed questions about one state in a single round trip. Each question is {type: noul|choice|score, instructions, criteria}; answers come back under the same ids with probabilities and confidence. Use for multi-dimension judgments about one thing (kind + severity + flags) or when the other tools do not fit.',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, questions: { type: 'object', additionalProperties: QUESTION_SCHEMA, minProperties: 1, description: 'Map of question id -> question. Ids are for you; they are not sent to the model.' }, model: MODEL },
        required: ['state', 'questions'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, questions, model }) {
        validateQuestions(questions);
        const r = await call({ state, questions, model });
        return { model: r.model, answers: r.answers, usage: r.usage };
      },
    },
    {
      name: 'choose',
      description: 'Pick exactly one of up to 255 labelled options for the given state. Returns the winning option, per-option probabilities, and confidence. Use for routing, categorization, intent, or picking an approach. Add an "other" option when nothing may fit.',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, instructions: INSTR, options: { type: 'object', additionalProperties: { type: ['string', 'object', 'null'] }, minProperties: 1, description: 'Map of option -> description of what it covers (and what it is not for).' }, model: MODEL },
        required: ['state', 'instructions', 'options'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, instructions, options, model }) {
        const q = { type: 'choice', instructions, criteria: options };
        validateQuestion(q, 'options');
        const a = (await call({ state, questions: { result: q }, model })).answers.result;
        return { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
      },
    },
    {
      name: 'score',
      description: 'Place the state on an ordered scale of 2-10 levels you describe, low to high. Returns a fractional score (2.3 = mostly level 2 with some level 3), the nearest level, the legend, and confidence. Use for risk, severity, urgency, quality, readiness. Describe levels as concrete situations.',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, instructions: INSTR, levels: { type: 'array', items: { type: ['string', 'object'] }, minItems: 2, maxItems: 10, description: 'Ordered level descriptions, lowest first.' }, model: MODEL },
        required: ['state', 'instructions', 'levels'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, instructions, levels, model }) {
        const q = { type: 'score', instructions, criteria: levels };
        validateQuestion(q, 'levels');
        const a = (await call({ state, questions: { result: q }, model })).answers.result;
        const s = num(a.score);
        const nearest = s === null ? null : Math.max(0, Math.min(levels.length - 1, Math.round(s)));
        return {
          score: s, max: levels.length - 1, nearest_level: nearest,
          nearest_level_description: nearest === null ? null : (typeof levels[nearest] === 'string' ? levels[nearest] : JSON.stringify(levels[nearest])),
          legend: a.legend, probabilities: a.probabilities, confidence: a.confidence,
        };
      },
    },
    {
      name: 'check',
      description: 'Answer a yes/no question about the state as a calibrated probability from 0 to 1. Use for gates, filters, and verifying that a stated condition holds. A value near 0.5 means undecided, not "medium".',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, instructions: INSTR, criteria: { type: 'object', properties: { true: { type: ['string', 'object'] }, false: { type: ['string', 'object'] } }, description: 'Optional descriptions of what counts as yes and as no.' }, model: MODEL },
        required: ['state', 'instructions'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, instructions, criteria, model }) {
        const q = { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
        validateQuestion(q, 'check');
        const p = num((await call({ state, questions: { result: q }, model })).answers.result.noul);
        return { probability: p, likely: p !== null && p >= 0.5 };
      },
    },
  ];
}

export function main() {
  const cfg = loadConfig();
  const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model });
  const server = createServer({ name: 'jev', version: SERVER_VERSION, instructions: INSTRUCTIONS, tools: buildTools({ client, cfg }) });
  process.stderr.write(`jev mcp ready · model=${cfg.model} · endpoint=${cfg.baseUrl} · key=${cfg.apiKey ? 'set' : 'MISSING'}\n`);
  serve(server);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Create `bin/jev-mcp` and `.mcp.json`**

`bin/jev-mcp`:

```sh
#!/bin/sh
# bin/jev-mcp — launches the jev MCP server with a discovered node. Stdout is the protocol channel.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/lib/find-node.sh"
NODE="$(find_node)" || { echo "jev: node >= 20 not found; install Node.js or put it on PATH" >&2; exit 1; }
exec "$NODE" "$ROOT/server/mcp.mjs"
```

`chmod +x bin/jev-mcp`

`.mcp.json`:

```json
{
  "mcpServers": {
    "jev": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/jev-mcp",
      "args": []
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/mcp-server.test.mjs`
Expected: 7 passing.

- [ ] **Step 6: Check the launcher by hand**

Run:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | ./bin/jev-mcp
```

Expected: two JSON lines on stdout (`serverInfo.name` = `jev`; four tools), and a `jev mcp ready` line on stderr.

- [ ] **Step 7: Commit**

```bash
git add server/mcp.mjs bin/jev-mcp .mcp.json test/mcp-server.test.mjs
git commit -m "feat: jev MCP server with decide, choose, score, and check tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: batch and route tools

**Files:**
- Modify: `server/mcp.mjs` (append two tools inside `buildTools`, add `summarize`)
- Test: `test/mcp-batch-route.test.mjs`

**Interfaces:**
- Produces: tool `batch({ items, question, shared_state?, concurrency?, model? }) → { results: [{ index, answer } | { index, error }], summary }`; tool `route({ task, context?, model? }) → { tier, model, reason, confidence, stakes, probabilities }`; `summarize(type, results)`.

- [ ] **Step 1: Write the failing tests**

`test/mcp-batch-route.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { startMcp } from './helpers/spawn.mjs';
import { runWithConcurrency } from '../server/mcp.mjs';

let backend;
let mcp;
before(async () => {
  backend = await startMockBackend();
  mcp = startMcp({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url });
  await mcp.request('initialize', { protocolVersion: '2025-06-18' });
});
after(async () => { await mcp.close(); await backend.close(); });

test('tools/list has exactly the six tools', async () => {
  const res = await mcp.request('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name), ['decide', 'choose', 'score', 'check', 'batch', 'route']);
});

test('batch asks one question per item, ranks noul answers, isolates failures', async () => {
  backend.requests.length = 0;
  backend.setAnswers((id, q, state) => ({ type: 'noul', noul: state.item.includes('secret') ? 0.9 : 0.1 }));
  const r = await mcp.call('batch', {
    items: ['config with secret token', 'README', 'notes __FAIL__', 'another secret'],
    question: { type: 'noul', instructions: 'Does this file mention a secret?' },
    shared_state: { project: 'demo' },
    concurrency: 2,
  });
  assert.equal(r.isError, false);
  assert.equal(r.json.results.length, 4);
  assert.equal(r.json.results[0].answer.noul, 0.9);
  assert.equal(r.json.results[1].answer.noul, 0.1);
  assert.ok(r.json.results[2].error.includes('422'));
  assert.deepEqual(r.json.summary.ranked.map((x) => x.index), [0, 3, 1]);
  assert.equal(r.json.summary.likely_count, 2);
  assert.equal(r.json.summary.errors, 1);
  assert.equal(backend.requests.length, 4);
  assert.ok(backend.requests.some((req) => JSON.stringify(req.body.state) === JSON.stringify({ project: 'demo', item: 'config with secret token' })));
});

test('batch summaries for choice and score; string shared_state; validation', async () => {
  const itemOf = (state) => (typeof state === 'string' ? state : state.item);
  backend.setAnswers((id, q, state) => (q.type === 'choice'
    ? { type: 'choice', choice: itemOf(state) === 'b' ? 'y' : 'x', probabilities: {}, confidence: 0.8 }
    : { type: 'score', score: itemOf(state) === 'b' ? 2 : 1, probabilities: {}, legend: {}, confidence: 0.8 }));
  const c = await mcp.call('batch', { items: ['a', 'b', 'c'], question: { type: 'choice', instructions: 'q', criteria: { x: '', y: '' } }, shared_state: 'ctx' });
  assert.deepEqual(c.json.summary, { type: 'choice', counts: { x: 2, y: 1 }, errors: 0 });
  assert.deepEqual(backend.requests.at(-1).body.state.context, 'ctx');
  const s = await mcp.call('batch', { items: ['a', 'b'], question: { type: 'score', instructions: 'q', criteria: ['lo', 'hi', 'top'] } });
  assert.deepEqual(s.json.summary.ranked.map((x) => x.index), [1, 0]);
  assert.ok((await mcp.call('batch', { items: [], question: { type: 'noul', instructions: 'q' } })).isError);
  assert.ok((await mcp.call('batch', { items: ['a'], question: { type: 'choice', instructions: 'q' } })).text.includes('question: choice needs criteria'));
});

test('route recommends a tier using the router policy', async () => {
  backend.setAnswers({
    tier: { type: 'choice', choice: 'fast', probabilities: { fast: 0.9, standard: 0.08, strong: 0.02 }, confidence: 0.9 },
    stakes: { type: 'score', score: 0.2, probabilities: {}, legend: {}, confidence: 0.9 },
  });
  const r = await mcp.call('route', { task: 'Rename variable x to y in utils.mjs', context: 'small cleanup' });
  assert.deepEqual(r.json, { tier: 'fast', model: 'haiku', reason: 'routed', confidence: 0.9, stakes: 0.2, probabilities: { fast: 0.9, standard: 0.08, strong: 0.02 } });
  assert.equal(backend.requests.at(-1).body.state.summary, 'small cleanup');
  backend.setAnswers({ tier: { type: 'choice', choice: 'strong', probabilities: { strong: 0.95 }, confidence: 0.95 } });
  assert.equal((await mcp.call('route', { task: 'Redesign the auth architecture' })).json.model, 'inherit');
  assert.ok((await mcp.call('route', { task: '' })).isError);
});

test('runWithConcurrency preserves order and bounds parallelism', async () => {
  let active = 0;
  let peak = 0;
  const fns = Array.from({ length: 6 }, (_, i) => async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return i * 2;
  });
  assert.deepEqual(await runWithConcurrency(fns, 2), [0, 2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
  assert.deepEqual(await runWithConcurrency([], 4), []);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/mcp-batch-route.test.mjs`
Expected: FAIL (tools/list has four names; `batch` unknown tool).

- [ ] **Step 3: Add `summarize` and the two tools to `server/mcp.mjs`**

Add above `buildTools`:

```js
export function summarize(type, results) {
  const ok = results.filter((r) => r.answer);
  const errors = results.length - ok.length;
  if (type === 'noul') {
    const ranked = ok.map((r) => ({ index: r.index, probability: num(r.answer.noul) })).sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1));
    return { type, ranked, likely_count: ranked.filter((r) => (r.probability ?? 0) >= 0.5).length, errors };
  }
  if (type === 'choice') {
    const counts = {};
    for (const r of ok) counts[r.answer.choice] = (counts[r.answer.choice] || 0) + 1;
    return { type, counts, errors };
  }
  const ranked = ok.map((r) => ({ index: r.index, score: num(r.answer.score) })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { type, ranked, errors };
}
```

Append inside the array returned by `buildTools`, after the `check` tool:

```js
    {
      name: 'batch',
      description: 'Ask the same question about many items (1-200) in parallel, one Jev call per item, and get per-item answers plus a summary: noul answers ranked by probability with a likely_count, choice answers counted per option, score answers ranked. Use for classifying, filtering, ranking, or deduplicating lists of files, findings, candidates, or search results instead of reading them all yourself.',
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { type: ['string', 'object'] }, minItems: 1, maxItems: 200, description: 'The items to judge. Each becomes state.item (with shared_state fields alongside).' },
          question: QUESTION_SCHEMA,
          shared_state: { type: ['string', 'object'], description: 'Optional context sent with every item: an object is merged with {item}, a string becomes {context, item}.' },
          concurrency: { type: 'integer', minimum: 1, maximum: 16, default: 8 },
          model: MODEL,
        },
        required: ['items', 'question'],
      },
      annotations: ANNOTATIONS,
      async handler({ items, question, shared_state, concurrency = 8, model }) {
        validateQuestion(question, 'question');
        if (!Array.isArray(items) || items.length === 0 || items.length > 200) throw new Error('items must be an array of 1-200 entries');
        const limit = Math.max(1, Math.min(16, Number(concurrency) || 8));
        const shared = shared_state === undefined || shared_state === null ? null
          : (typeof shared_state === 'object' && !Array.isArray(shared_state) ? shared_state : { context: shared_state });
        const fns = items.map((item, index) => async () => {
          const state = shared ? { ...shared, item } : item;
          try {
            const r = await call({ state, questions: { result: question }, model });
            return { index, answer: r.answers.result };
          } catch (err) {
            return { index, error: err?.message || String(err) };
          }
        });
        const results = await runWithConcurrency(fns, limit);
        return { results, summary: summarize(question.type, results) };
      },
    },
    {
      name: 'route',
      description: 'Recommend the cheapest capable model tier for a described subtask before delegating it: fast (haiku) for mechanical work, standard (sonnet) for ordinary engineering, strong (the session model) for hard or high-stakes work. Returns the tier, the model alias to pass to the Agent tool (or "inherit"), confidence, and a stakes score.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'The subtask as you would phrase it to the subagent.' }, context: { type: 'string', description: 'Optional one-line summary or surrounding context.' }, model: MODEL },
        required: ['task'],
      },
      annotations: ANNOTATIONS,
      async handler({ task, context, model }) {
        if (!task || typeof task !== 'string' || !task.trim()) throw new Error('task must be a non-empty string');
        const { state, questions } = buildRouter({ prompt: task, description: context || '' });
        const r = await call({ state, questions, model });
        const d = decideTier(r.answers, cfg);
        return { tier: d.tier, model: d.model ?? 'inherit', reason: d.reason, confidence: d.confidence, stakes: d.stakes, probabilities: r.answers.tier?.probabilities ?? {} };
      },
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/mcp.mjs test/mcp-batch-route.test.mjs
git commit -m "feat: batch and route MCP tools

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 16: Skills and the status script

**Files:**
- Create: `skills/jev-decisions/SKILL.md`, `skills/status/SKILL.md`, `scripts/status.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `createClient`, `runScript`, `startMockBackend`.
- Produces: `buildReport({ cfg, client }) → { text, ok }`, `modelNames(data) → string[]`; `scripts/status.mjs` exits 1 when the key is missing or the models call fails.

- [ ] **Step 1: Write the failing tests**

`test/status.test.mjs`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { runScript } from './helpers/spawn.mjs';
import { modelNames } from '../scripts/status.mjs';

let backend;
before(async () => { backend = await startMockBackend(); });
after(() => backend.close());

test('modelNames accepts the documented and likely response shapes', () => {
  assert.deepEqual(modelNames({ models: [{ name: 'a' }, { id: 'b' }, 'c'] }), ['a', 'b', 'c']);
  assert.deepEqual(modelNames({ data: [{ name: 'a' }] }), ['a']);
  assert.deepEqual(modelNames([{ name: 'a' }]), ['a']);
  assert.deepEqual(modelNames({}), []);
});

test('status reports models, settings, and log tail with a key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-status-'));
  const logPath = path.join(dir, 'decisions.jsonl');
  fs.writeFileSync(logPath, `${JSON.stringify({ ts: 't', hook: 'gate-bash', decision: 'ask', score: 2.6 })}\n`);
  const r = await runScript('scripts/status.mjs', { env: { TYPESAFE_API_KEY: 'sk-abcd1234', JEV_BASE_URL: backend.url, JEV_LOG: logPath, JEV_GATE_MODE: 'deny' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('key: set (…1234)'));
  assert.ok(!r.stdout.includes('sk-abcd1234'));
  assert.ok(r.stdout.includes('models: jev-1.13.0, jev-latest'));
  assert.ok(r.stdout.includes('router: on (fast→haiku, standard→sonnet, strong→inherit; min confidence 0.6)'));
  assert.ok(r.stdout.includes('gate: on (mode deny, warn ≥1.3, ask ≥2.0, deny ≥2.6)'));
  assert.ok(r.stdout.includes('"decision":"ask"'));
  assert.ok(r.stdout.includes(`node: ${process.version}`));
});

test('status exits 1 and explains when the key is missing or rejected', async () => {
  const missing = await runScript('scripts/status.mjs', { env: { JEV_BASE_URL: backend.url } });
  assert.equal(missing.code, 1);
  assert.ok(missing.stdout.includes('key: MISSING'));
  assert.ok(missing.stdout.includes('set-key.mjs'));
  backend.queue(401, 'invalid key');
  const rejected = await runScript('scripts/status.mjs', { env: { TYPESAFE_API_KEY: 'bad', JEV_BASE_URL: backend.url } });
  assert.equal(rejected.code, 1);
  assert.ok(rejected.stdout.includes('models: ERROR auth'));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/status.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/status.mjs'`.

- [ ] **Step 3: Create `scripts/status.mjs`**

```js
#!/usr/bin/env node
// scripts/status.mjs — what /jev:status runs. Prints a short report; exit 1 when Jev is unusable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { createClient } from '../lib/jev-client.mjs';

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Create `skills/status/SKILL.md`**

```markdown
---
name: status
description: Check the Jev plugin: API key, reachable models, router/triage/gate settings, and recent decisions.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Run this command and show the user its output as-is, then add one line saying what to fix if it reports a problem:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs"
```

If the key is missing, tell the user to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/set-key.mjs"` in their own terminal (the key is typed there, never pasted into the chat) and then restart Claude Code. Do not ask the user to paste the key into the conversation.
```

- [ ] **Step 5: Create `skills/jev-decisions/SKILL.md`**

```markdown
---
name: jev-decisions
description: Fast typed judgments with calibrated probabilities from Jev (TypeSafe) through the jev MCP tools (choose, score, check, batch, route, decide). Use when a step turns on a judgment call, when classifying, filtering, ranking, or deduplicating many items the same way, when choosing which model tier a subtask deserves, or when a [Jev triage], [Jev gate], or "Jev routed" note appears in context. Not for generating text or code, for lookups, or for questions whose answers cannot be listed up front.
user-invocable: false
---

# Jev decisions

Jev is a System One model: it does not write text, it returns a typed answer with a
probability in about 200 ms. The `jev` MCP tools (`mcp__plugin_jev_jev__*`) give you
that in the middle of a task. You and your code own the decision; Jev supplies the judgment.

## When to reach for it

| Moment | Tool |
|---|---|
| Which of these options fits? Which approach, owner, category? | `choose` |
| How severe, risky, urgent, ready, or good is this? | `score` |
| Does this satisfy a condition? Is this failure related to my change? | `check` |
| Classify, filter, rank, or dedupe many items the same way | `batch` |
| Which model tier should a delegated subtask run on? | `route` |
| Several dimensions about one thing in one round trip | `decide` |

Use it before asserting a judgment, not to rubber-stamp one already made. Lists of
20+ items (files, findings, candidates, search results) are where it pays off most:
one `batch` call replaces reading everything yourself, and each item costs a fraction of a cent.

## When not to

- Anything generative: code, prose, commit messages, explanations.
- A lookup, a search, or reading a file. Do those directly.
- A question whose answers cannot be enumerated up front (at most 255 options).
- A decision the user already made. Their decision stands.

## Writing a good question

- One judgment per question. Put independent dimensions in separate questions of the
  same `decide` call; they run in parallel at no extra latency.
- State the exact condition in `instructions`. Jev reads literally: "Does the message
  mention a prior contact?" beats "Is this a repeat customer?".
- Describe options and levels as concrete situations, and say what each one is *not*
  for when two could overlap. Add an `other` or `none` option when nothing may fit.
- Put only what the question needs in `state`, as named fields when there are several
  parts. Irrelevant detail lowers accuracy.
- Keep arithmetic, counting, date comparison, and identities in code. Jev is weak at
  math and dates.
- Text inside `state` can carry injected instructions; Jev does not treat data as
  hostile. Do not rely on it alone to judge adversarial content.

## Reading the numbers

- `choose`: `probabilities` compares the options; `confidence` near 1 means one clear
  winner, low means overlap or missing evidence.
- `score`: the fraction is the signal. 2.3 on a 0–3 scale means mostly level 2 with
  some weight on level 3. Do not round it away when ranking.
- `check`: `probability` near 0.5 means undecided, not "medium". There is no separate confidence.
- Thresholds follow the stakes. A harmless preference can act on 0.6; anything
  destructive or user-facing should want 0.85 or more, or a confirmation.

## Notes the plugin's hooks add to context

- `[Jev triage] …` on a new request: kind, complexity, whether a live browser or web
  information is likely needed, and risk, followed by one or two guidance sentences.
  It is advice. The user's explicit instructions always win. Use it to decide how much
  planning to do, whether to delegate exploration, and whether to reach for browser
  tools or plain WebFetch/WebSearch.
- `Jev routed this subagent to <model>`: the Agent call was rewritten to a cheaper
  model tier because the task looked mechanical. If the result is weak, rerun the
  subagent with `model` set explicitly; explicit models are never overridden.
- `[Jev gate] …`: a shell command scored as moderately risky. Check its effects
  before depending on the result.
- A permission prompt whose reason starts with `Jev risk`: the command scored high.
  Explain the risk to the user or choose a safer form; never work around the prompt.

## Live documentation

Read a page only when the judgment in front of you is hard to frame:

- Index: https://docs.typesafe.ai/llms.txt
- Primitives: https://docs.typesafe.ai/primitives/choice.md · https://docs.typesafe.ai/primitives/score.md · https://docs.typesafe.ai/primitives/noul.md
- State shaping: https://docs.typesafe.ai/concepts/state.md · Confidence: https://docs.typesafe.ai/confidence.md
- Known weaknesses: https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/status.test.mjs`
Expected: 3 passing.

- [ ] **Step 7: Commit**

```bash
git add scripts/status.mjs skills test/status.test.mjs
git commit -m "feat: jev-decisions and status skills with status script

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 17: Key setup script

**Files:**
- Create: `scripts/set-key.mjs`
- Test: `test/set-key.test.mjs`

**Interfaces:**
- Consumes: `createClient`, `runScript`, `startMockBackend`.
- Produces: `mergeKey(settingsText, key) → string` (JSON with `env.TYPESAFE_API_KEY`, everything else preserved); CLI flags `--stdin` (read key from stdin instead of a hidden prompt), `--no-verify` (skip the `/v1/models` check); env `CLAUDE_SETTINGS_PATH` overrides the target file (default `~/.claude/settings.json`).

- [ ] **Step 1: Write the failing tests**

`test/set-key.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test test/set-key.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/set-key.mjs'`.

- [ ] **Step 3: Create `scripts/set-key.mjs`**

```js
#!/usr/bin/env node
// scripts/set-key.mjs — store TYPESAFE_API_KEY in ~/.claude/settings.json (env block) without
// the key ever appearing in a chat transcript. Usage: node scripts/set-key.mjs [--stdin] [--no-verify]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createClient } from '../lib/jev-client.mjs';
import { loadConfig } from '../lib/config.mjs';

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/set-key.test.mjs`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/set-key.mjs test/set-key.test.mjs
git commit -m "feat: set-key script that stores the key in Claude settings env

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 18: Smoke script, README, final structure test, install, and live verification

**Files:**
- Create: `scripts/smoke.mjs`
- Modify: `README.md` (replace), `test/plugin-structure.test.mjs` (replace with the full version)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run smoke` (needs a real key) printing a PASS/FAIL table; a README with install, configuration, and troubleshooting; the plugin registered and installed in Claude Code.

- [ ] **Step 1: Replace `test/plugin-structure.test.mjs` with the full version**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const executable = (rel) => { fs.accessSync(path.join(ROOT, rel), fs.constants.X_OK); return true; };

test('plugin manifest is valid', () => {
  const m = readJson('.claude-plugin/plugin.json');
  assert.equal(m.name, 'jev');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description.length > 20);
  assert.equal(m.license, 'MIT');
});

test('marketplace lists the plugin at the repo root', () => {
  const m = readJson('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'jev');
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, 'jev');
  assert.equal(m.plugins[0].source, './');
});

test('package.json is ESM with no dependencies and no lockfile', () => {
  const p = readJson('package.json');
  assert.equal(p.type, 'module');
  assert.equal(p.dependencies, undefined);
  assert.equal(p.devDependencies, undefined);
  assert.equal(exists('package-lock.json'), false);
});

test('hooks.json wires the three hooks through the launcher with timeouts', () => {
  const h = readJson('hooks/hooks.json').hooks;
  const pre = h.PreToolUse.map((g) => [g.matcher, g.hooks[0].command]);
  assert.deepEqual(pre, [
    ['Agent', '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" route-agent'],
    ['Bash', '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" gate-bash'],
  ]);
  assert.equal(h.UserPromptSubmit[0].hooks[0].command, '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" triage-prompt');
  for (const group of [...h.PreToolUse, ...h.UserPromptSubmit]) {
    for (const hook of group.hooks) {
      assert.equal(hook.type, 'command');
      assert.equal(hook.timeout, 15);
      const name = hook.command.split(' ').at(-1);
      assert.ok(exists(`hooks/${name}.mjs`), name);
    }
  }
});

test('.mcp.json points at the launcher and launchers are executable', () => {
  const m = readJson('.mcp.json');
  assert.equal(m.mcpServers.jev.command, '${CLAUDE_PLUGIN_ROOT}/bin/jev-mcp');
  assert.ok(executable('bin/jev-mcp'));
  assert.ok(executable('hooks/run-hook.sh'));
  assert.ok(exists('lib/find-node.sh'));
  assert.ok(exists('server/mcp.mjs'));
});

test('skills have the required frontmatter', () => {
  const decisions = fs.readFileSync(path.join(ROOT, 'skills/jev-decisions/SKILL.md'), 'utf8');
  assert.match(decisions, /^---\nname: jev-decisions\n/);
  assert.match(decisions, /\nuser-invocable: false\n/);
  const description = decisions.match(/\ndescription: (.+)\n/)[1];
  assert.ok(description.length <= 1024, `description too long: ${description.length}`);
  const status = fs.readFileSync(path.join(ROOT, 'skills/status/SKILL.md'), 'utf8');
  assert.match(status, /^---\nname: status\n/);
  assert.match(status, /\ndisable-model-invocation: true\n/);
  assert.ok(status.includes('scripts/status.mjs'));
});

test('no file in the plugin contains a TypeSafe key', () => {
  const skip = new Set(['.git', 'node_modules', 'docs']);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (skip.has(d.name) ? [] : d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/TYPESAFE_API_KEY\s*[:=]\s*["']?ts[-_][A-Za-z0-9]{8,}/.test(text), `possible key in ${file}`);
  }
});

const hasClaude = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('claude plugin validate passes', { skip: !hasClaude && 'claude CLI not on PATH' }, () => {
  const out = execFileSync('claude', ['plugin', 'validate', '.'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.match(out, /Validation passed/);
});
```

Run: `node --test test/plugin-structure.test.mjs` → Expected: all passing (the validate test passes or is skipped; if `claude plugin validate` reports an error, fix the manifest it names).

- [ ] **Step 2: Create `scripts/smoke.mjs`**

```js
#!/usr/bin/env node
// scripts/smoke.mjs — live end-to-end check against api.typesafe.ai. Needs TYPESAFE_API_KEY. Costs a few cents at most.
import { loadConfig } from '../lib/config.mjs';
import { createClient } from '../lib/jev-client.mjs';
import { buildTools } from '../server/mcp.mjs';
import { runScript } from '../test/helpers/spawn.mjs';

const cfg = loadConfig();
if (!cfg.apiKey) {
  process.stderr.write('TYPESAFE_API_KEY is not set. Run: node scripts/set-key.mjs\n');
  process.exit(1);
}
const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model });
const tools = Object.fromEntries(buildTools({ client, cfg }).map((t) => [t.name, t]));
const hookEnv = { TYPESAFE_API_KEY: cfg.apiKey, JEV_BASE_URL: cfg.baseUrl, JEV_LOG: '0' };
const parse = (r) => (r.stdout.trim() ? JSON.parse(r.stdout) : null);

const checks = [
  ['GET /v1/models', async () => { const names = (await client.listModels()).models?.map((m) => m.name) ?? []; return names.length ? names.join(', ') : 'listed'; }],
  ['choose: billing vs technical', async () => {
    const r = await tools.choose.handler({ state: 'My card was charged twice for the same order.', instructions: 'What is this message about?', options: { billing: 'money, charges, refunds', technical: 'errors, bugs, outages', other: 'anything else' } });
    if (r.choice !== 'billing') throw new Error(`expected billing, got ${r.choice}`);
    return `billing p=${r.probabilities.billing.toFixed(2)} conf=${r.confidence.toFixed(2)}`;
  }],
  ['score: urgency', async () => {
    const r = await tools.score.handler({ state: 'Production is down for all customers right now.', instructions: 'How urgent is this?', levels: ['Routine: can wait a week.', 'Soon: this week.', 'Urgent: today.', 'Critical: right now, customers affected.'] });
    if (r.score < 2) throw new Error(`expected >= 2, got ${r.score}`);
    return `score=${r.score.toFixed(2)} (${r.nearest_level_description})`;
  }],
  ['check: mentions a refund', async () => {
    const r = await tools.check.handler({ state: 'Please refund my order #123.', instructions: 'Does the message ask for a refund?' });
    if (r.probability < 0.7) throw new Error(`expected high probability, got ${r.probability}`);
    return `p=${r.probability.toFixed(2)}`;
  }],
  ['batch: 3 items', async () => {
    const r = await tools.batch.handler({ items: ['config.yml contains AWS_SECRET_ACCESS_KEY=...', 'README.md: project overview', '.env with DATABASE_PASSWORD'], question: { type: 'noul', instructions: 'Does this file content mention a secret or credential?' }, concurrency: 3 });
    if (r.summary.errors) throw new Error(`${r.summary.errors} item errors`);
    if (r.summary.ranked[0].index === 1) throw new Error('README ranked first');
    return `likely=${r.summary.likely_count}/3`;
  }],
  ['route: rename variable → fast', async () => {
    const r = await tools.route.handler({ task: 'Rename the variable `cfg` to `config` in lib/util.mjs and update its three call sites.' });
    return `tier=${r.tier} model=${r.model} conf=${r.confidence.toFixed(2)}`;
  }],
  ['hook route-agent (Explore search)', async () => {
    const out = parse(await runScript('hooks/route-agent.mjs', { env: hookEnv, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: process.cwd(), tool_input: { prompt: 'Search the repo for every call to parseConfig and list the files.', description: 'Find parseConfig calls', subagent_type: 'Explore' } }) }));
    return out ? `model=${out.hookSpecificOutput.updatedInput.model}` : 'no routing (inherit or low confidence)';
  }],
  ['hook triage-prompt', async () => {
    const out = parse(await runScript('hooks/triage-prompt.mjs', { env: hookEnv, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: process.cwd(), prompt: 'Log into our staging admin panel in the browser and check whether the new invoice page renders.' }) }));
    if (!out?.hookSpecificOutput.additionalContext.startsWith('[Jev triage]')) throw new Error('no triage note');
    return out.hookSpecificOutput.additionalContext.split('\n')[0].slice(13);
  }],
  ['hook gate-bash: rm -rf', async () => {
    const out = parse(await runScript('hooks/gate-bash.mjs', { env: hookEnv, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: process.cwd(), tool_input: { command: 'rm -rf ~/projects/customer-data', description: 'remove old data' } }) }));
    if (!out?.hookSpecificOutput.permissionDecision) throw new Error(`expected ask/deny, got ${JSON.stringify(out)}`);
    return `${out.hookSpecificOutput.permissionDecision}: ${out.hookSpecificOutput.permissionDecisionReason.slice(0, 40)}…`;
  }],
  ['hook gate-bash: ls', async () => {
    const out = parse(await runScript('hooks/gate-bash.mjs', { env: hookEnv, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: process.cwd(), tool_input: { command: 'ls -la' } }) }));
    if (out) throw new Error('safe command produced output');
    return 'silent';
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  const started = Date.now();
  try {
    const detail = await fn();
    process.stdout.write(`PASS  ${name.padEnd(36)} ${String(Date.now() - started).padStart(5)} ms  ${detail}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`FAIL  ${name.padEnd(36)} ${String(Date.now() - started).padStart(5)} ms  ${err.message}\n`);
  }
}
process.stdout.write(failed ? `\n${failed} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failed ? 1 : 0);
```

Run: `node --check scripts/smoke.mjs` → Expected: no output (syntax OK). The script itself runs only with a key (Step 6).

- [ ] **Step 3: Replace `README.md`**

```markdown
# jev — TypeSafe Jev decisions for Claude Code

A Claude Code plugin that gives Claude a fast, cheap "System One" decision layer backed by
[TypeSafe AI's Jev](https://typesafe.ai). Jev does not generate text; it returns typed answers
(one option, a position on a scale, or a yes/no probability) with calibrated confidence in
about 200 ms, at a fraction of a cent per call.

What the plugin does:

- **Subagent model router** — when Claude delegates work with the Agent tool, Jev classifies the
  task and the hook rewrites the call to `haiku` (mechanical work) or `sonnet` (ordinary work).
  Hard or high-stakes work stays on the session model. Explicit `model` choices are never overridden.
- **Request triage** — every prompt gets a one-line `[Jev triage]` note (kind, complexity, whether a
  live browser or web information is needed, risk) plus short guidance. Advisory only.
- **Bash risk gate** — shell commands that are not provably read-only are scored 0–3. Moderately
  risky ones add a warning to Claude's context; dangerous ones force a permission prompt whose
  reason starts with `Jev risk`. The gate never approves anything on its own.
- **MCP tools** `mcp__plugin_jev_jev__{decide,choose,score,check,batch,route}` for ad-hoc typed
  judgments, including `batch` for classifying or ranking up to 200 items in one call.
- **Skills** `jev-decisions` (when and how to use the tools; how to read hook notes) and `/jev:status`.

Zero npm dependencies; Node ≥ 20.

## Install

1. Get a key at https://console.typesafe.ai/keys and store it (typed in your terminal, hidden):

   ```bash
   node scripts/set-key.mjs
   ```

   This writes `env.TYPESAFE_API_KEY` into `~/.claude/settings.json`, which Claude Code passes to
   hooks and MCP servers in both the CLI and the desktop app. (Alternatively export
   `TYPESAFE_API_KEY` in your shell.)

2. Register this directory as a marketplace and install the plugin in place:

   ```bash
   claude plugin marketplace add /Users/martin/projects/Jev
   claude plugin install jev@jev --scope user
   ```

3. Restart Claude Code (or run `/reload-plugins`), then check `/jev:status` and that
   `/mcp` lists the `jev` server.

Optional: TypeSafe's own documentation plugin teaches Claude to write TypeSafe integration code and
coexists with this one: `claude plugin marketplace add typesafe-ai/skills && claude plugin install typesafe@typesafe-ai`.

## Configuration

All settings are environment variables (put them in the `env` block of `~/.claude/settings.json`).

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | — | Required. `JEV_API_KEY` is accepted as an alias |
| `JEV_MODEL` | `jev-latest` | Model for every request |
| `JEV_BASE_URL` | `https://api.typesafe.ai` | API root |
| `JEV_ROUTER` | `1` | Subagent model router |
| `JEV_ROUTER_OVERRIDE` | `0` | `1` routes even when Claude set `model` explicitly |
| `JEV_ROUTER_CUSTOM_AGENTS` | `0` | `1` also routes custom subagent types |
| `JEV_ROUTER_TIERS` | `{"fast":"haiku","standard":"sonnet","strong":null}` | Tier → model alias; `null` leaves the model unset (inherit) |
| `JEV_ROUTER_MIN_CONFIDENCE` | `0.6` | Below this the router does nothing |
| `JEV_TRIAGE` | `1` | Request triage |
| `JEV_GATE` | `1` | Bash gate |
| `JEV_GATE_MODE` | `ask` | `ask`, `deny`, or `advise` |
| `JEV_GATE_WARN_THRESHOLD` / `JEV_GATE_ASK_THRESHOLD` / `JEV_GATE_DENY_THRESHOLD` | `1.3` / `2.0` / `2.6` | Risk score (0–3) thresholds; deny applies only in `deny` mode |
| `JEV_HOOK_TIMEOUT_MS` / `JEV_TOOL_TIMEOUT_MS` | `6000` / `20000` | Per-request budgets |
| `JEV_LOG` | `<plugin data dir>/decisions.jsonl` | Decision log; `0` disables |
| `JEV_DEBUG` | `0` | Verbose stderr |

## How it behaves

- Every hook is fail-open: if Jev is slow, down, or unconfigured, the tool call or prompt
  proceeds exactly as Claude sent it. Nothing here can approve a command; hooks only add
  `ask`/`deny`/advice on top of Claude Code's own permission system.
- What leaves the machine: subagent prompts (router), your prompts (triage), shell commands with
  Claude's stated intent and the working-directory name (gate), and whatever Claude passes to the
  tools. Each channel has an off switch above. The key is never logged or written to plugin files.
- Jev can be misled by adversarial text inside a command or prompt; treat the gate as an extra
  layer, not the only one.

## Development

```bash
npm test          # offline unit + integration tests against a mock TypeSafe backend
npm run smoke     # live checks against api.typesafe.ai (needs the key; costs cents)
npm run status    # same report as /jev:status
```

Decisions are logged as JSON lines (default `~/.claude/plugins/data/jev/decisions.jsonl` when
installed, `~/.claude/jev/decisions.jsonl` otherwise); use them to tune thresholds.

## Troubleshooting

- `/jev:status` says the key is missing inside Claude Code but `npm run status` works in a
  terminal: the desktop app does not read your shell profile. Use `node scripts/set-key.mjs`.
- Hooks never fire: run `claude --debug` and look for `route-agent`, `gate-bash`, `triage-prompt`
  in the hook log; make sure `node` is on PATH or in one of the locations `lib/find-node.sh` probes.
- Too many permission prompts from the gate: raise `JEV_GATE_ASK_THRESHOLD` (e.g. `2.4`) or set
  `JEV_GATE_MODE=advise`.
- Subagents routed to haiku do poorly on some task: pass `model` explicitly in that Agent call, or
  raise `JEV_ROUTER_MIN_CONFIDENCE`.

## License

MIT
```

- [ ] **Step 4: Run the whole suite and validate the plugin**

Run: `npm test && claude plugin validate .`
Expected: all tests pass; `✔ Validation passed` (warnings are acceptable; errors must be fixed).

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/smoke.mjs test/plugin-structure.test.mjs
git commit -m "docs: README, live smoke script, and full plugin structure test

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Store the key (user action) and run the live smoke test**

Ask the user to run, in their own terminal (never paste the key into chat):

```bash
cd /Users/martin/projects/Jev && node scripts/set-key.mjs
```

Then run: `TYPESAFE_API_KEY="$(node -e 'const s=require(require("os").homedir()+"/.claude/settings.json");process.stdout.write(s.env?.TYPESAFE_API_KEY||"")')" npm run smoke`
Expected: every line `PASS`, `All checks passed`. If `choose`/`score`/`check` fail on model judgment rather than transport, report the actual values; they are calibration findings, not code bugs.

- [ ] **Step 7: Register and install the plugin**

```bash
claude plugin marketplace add /Users/martin/projects/Jev
claude plugin install jev@jev --scope user
claude plugin list
```

Expected: `jev@jev` listed as enabled. Restart Claude Code (desktop app) afterwards.

- [ ] **Step 8: Live verification inside Claude Code (manual)**

In a fresh session with the plugin enabled:

1. Run `/jev:status` → key `set`, models listed, router/triage/gate `on`.
2. Send a normal request (e.g. "explain how the gate prefilter decides"): the decision log gains a `triage-prompt` line; `claude --debug` (CLI) shows the `[Jev triage]` reminder.
3. Ask Claude to "use an Explore subagent to list every `.mjs` file that imports `util.mjs`": the log gains a `route-agent` line with `model: "haiku"`, and the subagent's transcript under `~/.claude/projects/<project>/` shows `"model": "claude-haiku-…"` in its assistant messages. If the model did not change, add `permissionDecision: "allow"` next to `updatedInput` in `hooks/route-agent.mjs` for the Agent tool only, re-test, and record the finding in the spec's open items.
4. Ask Claude to run `rm -rf /tmp/jev-smoke-dir` (create it first): a permission prompt appears whose reason starts with `Jev risk`. `ls -la` produces no prompt and no log line beyond `prefilter_safe`.
5. Ask "classify these 30 lines by severity" over a pasted list: Claude calls `mcp__plugin_jev_jev__batch` (visible in the transcript) rather than judging each line in prose.

Record the outcome of each check in the final report to the user.

- [ ] **Step 9: Commit any fixes from live verification**

```bash
git add -A
git commit -m "fix: adjustments from live verification

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 19 (optional, needs user approval — costs Claude usage): plugin evals

**Files:**
- Create: `evals/mocks/jev/_server.md`, `evals/batch-classify-findings/prompt.md`, `evals/batch-classify-findings/scaffold.sh`, `evals/batch-classify-findings/case.yaml`, `evals/no-trigger-typo/prompt.md`, `evals/no-trigger-typo/scaffold.sh`, `evals/no-trigger-typo/case.yaml`

- [ ] **Step 1: Mock the MCP server for evals**

`evals/mocks/jev/_server.md`:

```markdown
---
type: agent
tools: [decide, choose, score, check, batch, route]
---

You are the Jev decision service. Answer every call with JSON only, in the shape the tool documents:
choose → {"choice": <one option key>, "probabilities": {<option>: <p>…}, "confidence": <0-1>};
score → {"score": <float>, "max": <n-1>, "nearest_level": <int>, "nearest_level_description": <text>, "legend": {…}, "probabilities": {…}, "confidence": <0-1>};
check → {"probability": <0-1>, "likely": <bool>};
batch → {"results": [{"index": i, "answer": {…}}…], "summary": {…}};
route → {"tier": "fast"|"standard"|"strong", "model": "haiku"|"sonnet"|"inherit", "reason": "routed", "confidence": <0-1>, "stakes": <0-2>, "probabilities": {…}};
decide → {"model": "jev-latest", "answers": {<id>: {…}}, "usage": {"input_tokens": 100, "output_tokens": 1}}.
Judge the supplied state sensibly and consistently.
```

- [ ] **Step 2: Case that should use `batch`**

`evals/batch-classify-findings/scaffold.sh`:

```bash
#!/bin/sh
{
  i=1
  while [ $i -le 30 ]; do
    case $((i % 3)) in
      0) echo "finding $i: hard-coded database password in config/db.yml";;
      1) echo "finding $i: unused import in src/util.js";;
      2) echo "finding $i: missing null check may crash on empty response";;
    esac
    i=$((i + 1))
  done
} > findings.txt
```

`evals/batch-classify-findings/prompt.md`:

```markdown
---
description: Many similar items to classify; the plugin's batch tool should be used
tags: [ladder]
max_turns: 15
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill]
---

Read `findings.txt` (30 security-scan findings). Rate each one's severity as low, medium, or high and tell me which ones are high. Be consistent across all 30.
```

`evals/batch-classify-findings/case.yaml`:

```yaml
schema_version: "1.1"
name: batch-classify-findings
context:
  scaffold_script: scaffold.sh
graders:
  - name: used-batch
    type: tool_used
    tool: mcp__plugin_jev_jev__batch
    arm: with-only
  - name: names-password-findings
    type: regex
    pattern: "password"
    flags: i
```

- [ ] **Step 3: Case that must not trigger the tools**

`evals/no-trigger-typo/scaffold.sh`:

```bash
#!/bin/sh
printf '# Notes\n\nThe quick brown fox jumsp over the lazy dog.\n' > notes.md
```

`evals/no-trigger-typo/prompt.md`:

```markdown
---
description: Ordinary edit; Jev tools must stay out of the way
tags: [no-trigger]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Read, Edit, Write]
---

Fix the typo in `notes.md`.
```

`evals/no-trigger-typo/case.yaml`:

```yaml
schema_version: "1.1"
name: no-trigger-typo
context:
  scaffold_script: scaffold.sh
graders:
  - name: no-jev-call
    type: tool_used
    tool: mcp__plugin_jev_jev__batch
    min: 0
    max: 0
  - name: fixed
    type: regex
    target: { source: file, path: notes.md }
    pattern: "jumps over"
```

- [ ] **Step 4: Run (only after the user approves the cost)**

```bash
claude plugin eval . --scaffold --runs 1 --trust-plugin
```

Expected: `batch-classify-findings` fires `batch` in the with-plugin arm; `no-trigger-typo` never calls it and fixes the file. Report the Δ table to the user.

- [ ] **Step 5: Commit**

```bash
git add evals
git commit -m "test: plugin eval cases for batch triggering and no-trigger edits

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
