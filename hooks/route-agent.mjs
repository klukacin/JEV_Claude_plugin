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
