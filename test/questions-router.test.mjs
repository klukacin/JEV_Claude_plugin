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
  const strong = decideTier({ tier: tier('strong'), stakes: stakes(1) }, cfg);
  assert.equal(strong.model, null);
  assert.equal(strong.reason, 'inherit');
});

test('low confidence never routes', () => {
  const d = decideTier({ tier: tier('fast', 0.59), stakes: stakes(0) }, cfg);
  assert.equal(d.model, null);
  assert.equal(d.reason, 'low_confidence');
  assert.equal(decideTier({ tier: tier('fast', 0.6), stakes: stakes(0) }, cfg).model, 'haiku');
});

test('high stakes keep the session model for every tier', () => {
  for (const t of ['fast', 'standard']) {
    const d = decideTier({ tier: tier(t), stakes: stakes(1.5) }, cfg);
    assert.equal(d.model, null, t);
    assert.equal(d.reason, 'high_stakes', t);
    assert.equal(d.tier, t);
  }
  assert.equal(decideTier({ tier: tier('fast'), stakes: stakes(1.49) }, cfg).model, 'haiku');
  assert.equal(decideTier({ tier: tier('standard'), stakes: stakes(1.99) }, cfg).model, null);
  const relaxed = loadConfig({ JEV_ROUTER_MAX_STAKES: '2.1' });
  assert.equal(decideTier({ tier: tier('standard'), stakes: stakes(1.99) }, relaxed).model, 'sonnet');
});

test('missing or unknown answers give no_answer', () => {
  assert.equal(decideTier({}, cfg).reason, 'no_answer');
  assert.equal(decideTier({ tier: tier('turbo') }, cfg).reason, 'no_answer');
  assert.equal(decideTier({ tier: tier('fast') }, cfg).model, 'haiku');
});

test('custom tier map is honoured', () => {
  const custom = loadConfig({ JEV_ROUTER_TIERS: '{"strong":"opus","fast":null}' });
  assert.equal(decideTier({ tier: tier('strong'), stakes: stakes(1) }, custom).model, 'opus');
  assert.equal(decideTier({ tier: tier('fast'), stakes: stakes(0) }, custom).reason, 'inherit');
});

test('built-in agent types', () => {
  for (const t of ['general-purpose', 'Explore', 'Plan', 'claude']) assert.ok(BUILTIN_AGENT_TYPES.has(t));
  assert.equal(BUILTIN_AGENT_TYPES.has('code-reviewer'), false);
});
