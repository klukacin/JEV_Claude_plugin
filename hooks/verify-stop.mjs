#!/usr/bin/env node
// hooks/verify-stop.mjs — Stop and SubagentStop: when a turn edited project code, ran nothing to check it
// afterwards, and the final report still claims success, ask the agent to run the checks. Never blocks;
// one nudge per stop sequence (stop_hook_active guards against loops).
import { runHook } from '../lib/hook-io.mjs';
import { readTail, parseEntries, currentTurn, analyzeTurn, handbackReport, turnCwd } from '../lib/transcript.mjs';
import { buildVerify, decideVerify, formatVerifyNudge } from '../lib/questions.mjs';
import { preview } from '../lib/util.mjs';

const EVENTS = new Set(['Stop', 'SubagentStop']);

runHook('verify-stop', async ({ input, cfg, client, log }) => {
  if (!cfg.verify || !client) return null;
  const event = input.hook_event_name;
  if (!EVENTS.has(event)) return null;
  if (input.stop_hook_active) {
    log({ decision: 'skip_already_continued', event });
    return null;
  }
  const transcriptPath = event === 'SubagentStop' ? input.agent_transcript_path : input.transcript_path;
  const turn = currentTurn(parseEntries(readTail(transcriptPath)));
  // In auto mode a subagent delivers its report through SubagentHandback; judge that, not the closing text.
  const reply = String(handbackReport(turn) ?? input.last_assistant_message ?? '').trim();
  if (reply.length < 20) return null;
  const analysis = analyzeTurn(turn, { cwd: turnCwd(turn) ?? input.cwd });
  if (analysis.edits.length === 0) return null;
  if (analysis.verifiedAfterEdit) {
    log({ decision: 'verified', event, verification: analysis.verification, edits: analysis.edits.length });
    return null;
  }
  const res = await client.systemOne(buildVerify({ reply }), { timeoutMs: cfg.hookTimeoutMs });
  const d = decideVerify(res.answers, cfg);
  log({ decision: d.nudge ? 'nudged' : 'claim_ok', event, claim: d.claim, admits: d.admits, edits: analysis.edits.length, preview: preview(reply) });
  if (!d.nudge) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: formatVerifyNudge(analysis.edits) } };
});
