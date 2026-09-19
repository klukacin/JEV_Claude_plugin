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
