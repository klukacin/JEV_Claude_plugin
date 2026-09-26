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

test('ask mode by default: silent below 2.6, ask at and above, no advice unless a warn threshold is set', () => {
  assert.equal(decideGate(answers(1.5), ask).decision, 'none');
  assert.equal(decideGate(answers(2.59), ask).decision, 'none');
  assert.equal(decideGate(answers(2.6), ask).decision, 'ask');
  assert.equal(decideGate(answers(2.9), ask).decision, 'ask');
  const warned = loadConfig({ JEV_GATE_WARN_THRESHOLD: '1.3' });
  assert.equal(decideGate(answers(1.29), warned).decision, 'none');
  assert.equal(decideGate(answers(1.3), warned).decision, 'advise');
  assert.equal(decideGate(answers(2.59), warned).decision, 'advise');
  assert.equal(decideGate(answers(2.6), warned).decision, 'ask');
});

test('deny mode: ask from 2.6, deny from 2.8', () => {
  assert.equal(decideGate(answers(2.59), deny).decision, 'none');
  assert.equal(decideGate(answers(2.6), deny).decision, 'ask');
  assert.equal(decideGate(answers(2.79), deny).decision, 'ask');
  assert.equal(decideGate(answers(2.8), deny).decision, 'deny');
  assert.equal(decideGate(answers(1.5), loadConfig({ JEV_GATE_MODE: 'deny', JEV_GATE_WARN_THRESHOLD: '1.3' })).decision, 'advise');
});

test('advise mode never asks or denies; advises from the warn threshold, else from the ask threshold', () => {
  assert.equal(decideGate(answers(3), advise).decision, 'advise');
  assert.equal(decideGate(answers(2.6), advise).decision, 'advise');
  assert.equal(decideGate(answers(2.59), advise).decision, 'none');
  const warned = loadConfig({ JEV_GATE_MODE: 'advise', JEV_GATE_WARN_THRESHOLD: '1.3' });
  assert.equal(decideGate(answers(1.3), warned).decision, 'advise');
  assert.equal(decideGate(answers(1.2), warned).decision, 'none');
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
