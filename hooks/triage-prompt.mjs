#!/usr/bin/env node
// hooks/triage-prompt.mjs — UserPromptSubmit: fast System-One read of the request, injected as advice.
import { runHook } from '../lib/hook-io.mjs';
import { buildTriage, formatTriage } from '../lib/questions.mjs';
import { num, preview } from '../lib/util.mjs';

const SYSTEM_MESSAGE = /^(<(task-notification|agent-message|command-name|command-message|local-command-[\w-]+|bash-(input|stdout|stderr)|user-prompt-submit-hook)\b|\[Request interrupted|Another Claude session sent a message|This session is being continued|Caveat: The messages below)/;

runHook('triage-prompt', async ({ input, cfg, client, log }) => {
  if (!cfg.triage || !client) return null;
  if (input.hook_event_name !== 'UserPromptSubmit') return null;
  const prompt = String(input.prompt ?? '').trim();
  if (prompt.length < 15 || prompt.startsWith('/')) {
    log({ decision: 'skip_short_or_command' });
    return null;
  }
  // Background-agent notifications, agent hand-backs, and local-command echoes arrive as prompts too;
  // they are not requests from the user and triaging them only adds noise to Claude's context. A real
  // request may carry leading <system-reminder> blocks; triage the text after them.
  const request = prompt.replace(/^(\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/, '').trim();
  if (SYSTEM_MESSAGE.test(request) || /<(task-notification|agent-message)\b/.test(request.slice(0, 400))) {
    log({ decision: 'skip_system_message', preview: preview(prompt) });
    return null;
  }
  if (request.length < 15) {
    log({ decision: 'skip_short_or_command' });
    return null;
  }
  const { state, questions } = buildTriage({ prompt: request });
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
