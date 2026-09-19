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
