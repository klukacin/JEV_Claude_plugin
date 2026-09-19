import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend } from './helpers/mock-backend.mjs';
import { startMcp } from './helpers/spawn.mjs';
import { runWithConcurrency } from '../server/mcp.mjs';

let backend;
let mcp;
before(async () => {
  backend = await startMockBackend();
  mcp = startMcp({ TYPESAFE_API_KEY: 'k', JEV_BASE_URL: backend.url });
  await mcp.request('initialize', { protocolVersion: '2025-06-18' });
});
after(async () => { await mcp.close(); await backend.close(); });

test('tools/list has exactly the six tools', async () => {
  const res = await mcp.request('tools/list');
  assert.deepEqual(res.result.tools.map((t) => t.name), ['decide', 'choose', 'score', 'check', 'batch', 'route']);
});

test('batch asks one question per item, ranks noul answers, isolates failures', async () => {
  backend.requests.length = 0;
  backend.setAnswers((id, q, state) => ({ type: 'noul', noul: state.item.includes('secret') ? 0.9 : 0.1 }));
  const r = await mcp.call('batch', {
    items: ['config with secret token', 'README', 'notes __FAIL__', 'another secret'],
    question: { type: 'noul', instructions: 'Does this file mention a secret?' },
    shared_state: { project: 'demo' },
    concurrency: 2,
  });
  assert.equal(r.isError, false);
  assert.equal(r.json.results.length, 4);
  assert.equal(r.json.results[0].answer.noul, 0.9);
  assert.equal(r.json.results[1].answer.noul, 0.1);
  assert.ok(r.json.results[2].error.includes('422'));
  assert.deepEqual(r.json.summary.ranked.map((x) => x.index), [0, 3, 1]);
  assert.equal(r.json.summary.likely_count, 2);
  assert.equal(r.json.summary.errors, 1);
  assert.equal(backend.requests.length, 4);
  assert.ok(backend.requests.some((req) => JSON.stringify(req.body.state) === JSON.stringify({ project: 'demo', item: 'config with secret token' })));
});

test('batch summaries for choice and score; string shared_state; validation', async () => {
  const itemOf = (state) => (typeof state === 'string' ? state : state.item);
  backend.setAnswers((id, q, state) => (q.type === 'choice'
    ? { type: 'choice', choice: itemOf(state) === 'b' ? 'y' : 'x', probabilities: {}, confidence: 0.8 }
    : { type: 'score', score: itemOf(state) === 'b' ? 2 : 1, probabilities: {}, legend: {}, confidence: 0.8 }));
  const c = await mcp.call('batch', { items: ['a', 'b', 'c'], question: { type: 'choice', instructions: 'q', criteria: { x: '', y: '' } }, shared_state: 'ctx' });
  assert.deepEqual(c.json.summary, { type: 'choice', counts: { x: 2, y: 1 }, errors: 0 });
  assert.deepEqual(backend.requests.at(-1).body.state.context, 'ctx');
  const s = await mcp.call('batch', { items: ['a', 'b'], question: { type: 'score', instructions: 'q', criteria: ['lo', 'hi', 'top'] } });
  assert.deepEqual(s.json.summary.ranked.map((x) => x.index), [1, 0]);
  assert.ok((await mcp.call('batch', { items: [], question: { type: 'noul', instructions: 'q' } })).isError);
  assert.ok((await mcp.call('batch', { items: ['a'], question: { type: 'choice', instructions: 'q' } })).text.includes('question: choice needs criteria'));
});

test('route recommends a tier using the router policy', async () => {
  backend.setAnswers({
    tier: { type: 'choice', choice: 'fast', probabilities: { fast: 0.9, standard: 0.08, strong: 0.02 }, confidence: 0.9 },
    stakes: { type: 'score', score: 0.2, probabilities: {}, legend: {}, confidence: 0.9 },
  });
  const r = await mcp.call('route', { task: 'Rename variable x to y in utils.mjs', context: 'small cleanup' });
  assert.deepEqual(r.json, { tier: 'fast', model: 'haiku', reason: 'routed', confidence: 0.9, stakes: 0.2, probabilities: { fast: 0.9, standard: 0.08, strong: 0.02 } });
  assert.equal(backend.requests.at(-1).body.state.summary, 'small cleanup');
  backend.setAnswers({ tier: { type: 'choice', choice: 'strong', probabilities: { strong: 0.95 }, confidence: 0.95 } });
  assert.equal((await mcp.call('route', { task: 'Redesign the auth architecture' })).json.model, 'inherit');
  assert.ok((await mcp.call('route', { task: '' })).isError);
});

test('runWithConcurrency preserves order and bounds parallelism', async () => {
  let active = 0;
  let peak = 0;
  const fns = Array.from({ length: 6 }, (_, i) => async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return i * 2;
  });
  assert.deepEqual(await runWithConcurrency(fns, 2), [0, 2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
  assert.deepEqual(await runWithConcurrency([], 4), []);
});
