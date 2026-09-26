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
  const tier = tierAnswer.choice;
  if (confidence < cfg.routerMinConfidence) {
    return { tier, model: null, reason: 'low_confidence', confidence, stakes: stakesScore };
  }
  // Work where a mistake is costly stays on the session model, whatever tier it looks like.
  if (stakesScore !== null && stakesScore >= cfg.routerMaxStakes) {
    return { tier, model: null, reason: 'high_stakes', confidence, stakes: stakesScore };
  }
  const model = cfg.routerTiers[tier] ?? null;
  return { tier, model, reason: model ? 'routed' : 'inherit', confidence, stakes: stakesScore };
}

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
  // WARN is null by default: no advisory notes unless explicitly enabled. Advise mode, which never
  // prompts, falls back to the ask threshold so it still reports the commands that would have asked.
  const warned = WARN !== null && WARN !== undefined && score >= WARN;
  let decision = 'none';
  if (gateMode === 'deny') {
    if (score >= DENY) decision = 'deny';
    else if (score >= ASK) decision = 'ask';
    else if (warned) decision = 'advise';
  } else if (gateMode === 'ask') {
    if (score >= ASK) decision = 'ask';
    else if (warned) decision = 'advise';
  } else if (score >= (WARN ?? ASK)) {
    decision = 'advise';
  }
  return { decision, score, reason: formatGateReason(answers) };
}
