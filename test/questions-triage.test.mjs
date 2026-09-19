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
