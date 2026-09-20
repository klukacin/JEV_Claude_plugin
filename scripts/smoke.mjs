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
