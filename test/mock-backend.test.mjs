import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMockBackend, defaultAnswers } from './helpers/mock-backend.mjs';
import { createClient } from '../lib/jev-client.mjs';

test('mock backend answers each question type and records requests', async () => {
  const backend = await startMockBackend();
  try {
    const client = createClient({ apiKey: 'k', baseUrl: backend.url });
    const res = await client.systemOne({
      state: { text: 'hello' },
      questions: {
        a: { type: 'noul', instructions: 'q' },
        b: { type: 'choice', instructions: 'q', criteria: { x: 'x', y: 'y' } },
        c: { type: 'score', instructions: 'q', criteria: ['lo', 'hi'] },
      },
    });
    assert.equal(res.answers.a.noul, 0.5);
    assert.equal(res.answers.b.choice, 'x');
    assert.equal(res.answers.c.score, 0);
    assert.deepEqual(res.answers.c.legend, { 0: 'lo', 1: 'hi' });
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].headers.authorization, 'Bearer k');
    assert.deepEqual(backend.requests[0].body.state, { text: 'hello' });
  } finally {
    await backend.close();
  }
});

test('setAnswers overrides, queue injects one-off responses, __FAIL__ yields 422', async () => {
  const backend = await startMockBackend({ answers: { a: { type: 'noul', noul: 0.91 } } });
  try {
    const client = createClient({ apiKey: 'k', baseUrl: backend.url, backoffMs: [0, 0] });
    const q = { a: { type: 'noul', instructions: 'q' } };
    assert.equal((await client.systemOne({ state: 's', questions: q })).answers.a.noul, 0.91);
    backend.setAnswers((id) => ({ type: 'noul', noul: id === 'a' ? 0.2 : 0 }));
    assert.equal((await client.systemOne({ state: 's', questions: q })).answers.a.noul, 0.2);
    backend.queue(500, 'down');
    await assert.rejects(() => client.systemOne({ state: 's', questions: q }, { retries: 0 }), (e) => e.code === 'http');
    await assert.rejects(() => client.systemOne({ state: 'x __FAIL__ y', questions: q }), (e) => e.code === 'validation');
    const models = await client.listModels();
    assert.deepEqual(models.models.map((m) => m.name), ['jev-1.13.0', 'jev-latest']);
  } finally {
    await backend.close();
  }
});

test('defaultAnswers spreads choice probability with a clear winner', () => {
  const a = defaultAnswers('x', { type: 'choice', criteria: { p: '', q: '', r: '' } });
  assert.equal(a.choice, 'p');
  assert.ok(Math.abs(Object.values(a.probabilities).reduce((s, v) => s + v, 0) - 1) < 1e-9);
});
