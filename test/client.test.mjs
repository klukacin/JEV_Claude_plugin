import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, JevError, redact } from '../lib/jev-client.mjs';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

const answers = { result: { type: 'noul', noul: 0.9 } };
const make = (responses, extra = {}) =>
  createClient({ apiKey: 'sk-test-KEY', baseUrl: 'http://api.test/', fetchImpl: fakeFetch(responses), backoffMs: [0, 0], ...extra });

test('systemOne posts model, state, questions with a bearer header', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { model: 'jev-1.13.0', answers, usage: { input_tokens: 5, output_tokens: 1 } } }]);
  const client = createClient({ apiKey: 'sk-test-KEY', baseUrl: 'http://api.test', fetchImpl });
  const res = await client.systemOne({ state: 'hi', questions: { result: { type: 'noul', instructions: 'Is it a greeting?' } } });
  assert.equal(res.answers.result.noul, 0.9);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://api.test/v1/systemone');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test-KEY');
  assert.deepEqual(call.body, { model: 'jev-latest', state: 'hi', questions: { result: { type: 'noul', instructions: 'Is it a greeting?' } } });
});

test('model override per request', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { model: 'jev-preview', answers, usage: {} } }]);
  const client = createClient({ apiKey: 'k', fetchImpl });
  await client.systemOne({ state: 's', questions: { result: { type: 'noul', instructions: 'q' } }, model: 'jev-preview' });
  assert.equal(fetchImpl.calls[0].body.model, 'jev-preview');
});

test('no key fails before any request', async () => {
  const fetchImpl = fakeFetch([]);
  const client = createClient({ apiKey: null, fetchImpl });
  await assert.rejects(() => client.systemOne({ state: 's', questions: {} }), (e) => e instanceof JevError && e.code === 'no_key' && /TYPESAFE_API_KEY/.test(e.message));
  assert.equal(fetchImpl.calls.length, 0);
});

test('status codes map to error codes and the key is redacted', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [422, 'validation'], [400, 'validation'], [404, 'http']]) {
    const client = make([{ status, body: `bad sk-test-KEY ${status}` }]);
    await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }),
      (e) => e.code === code && e.status === status && !e.message.includes('sk-test-KEY') && e.message.includes('***'));
  }
});

test('429 then 200 is retried', async () => {
  const client = make([{ status: 429, body: 'slow down' }, { status: 200, body: { model: 'm', answers, usage: {} } }]);
  const res = await client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } });
  assert.equal(res.answers.result.noul, 0.9);
});

test('529 exhausts retries and reports overloaded after 3 attempts', async () => {
  const fetchImpl = fakeFetch([{ status: 529, body: 'x' }, { status: 529, body: 'x' }, { status: 529, body: 'x' }]);
  const client = createClient({ apiKey: 'k', fetchImpl, backoffMs: [0, 0] });
  await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }), (e) => e.code === 'overloaded');
  assert.equal(fetchImpl.calls.length, 3);
});

test('500 and network errors are retried, then 200 wins', async () => {
  const client = make([{ status: 500, body: 'boom' }, () => { throw new Error('ECONNRESET'); }, { status: 200, body: { model: 'm', answers, usage: {} } }]);
  const res = await client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } });
  assert.equal(res.answers.result.noul, 0.9);
});

test('network error without retries left is a network error', async () => {
  const client = make([() => { throw new Error('ECONNREFUSED 127.0.0.1'); }]);
  await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }, { retries: 0 }), (e) => e.code === 'network');
});

test('timeout aborts and is not retried', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const fetchImpl = fakeFetch([hang, hang]);
  const client = createClient({ apiKey: 'k', fetchImpl, backoffMs: [0, 0] });
  await assert.rejects(() => client.systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }, { timeoutMs: 40 }), (e) => e.code === 'timeout');
  assert.equal(fetchImpl.calls.length, 1);
});

test('non-JSON or answer-less bodies are bad_response', async () => {
  await assert.rejects(() => make([{ status: 200, body: 'not json' }]).systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }), (e) => e.code === 'bad_response');
  await assert.rejects(() => make([{ status: 200, body: { model: 'm' } }]).systemOne({ state: 's', questions: { r: { type: 'noul', instructions: 'q' } } }), (e) => e.code === 'bad_response');
});

test('listModels is a GET without a body', async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: { models: [{ name: 'jev-1.13.0' }] } }]);
  const client = createClient({ apiKey: 'k', baseUrl: 'http://api.test', fetchImpl });
  const res = await client.listModels();
  assert.equal(res.models[0].name, 'jev-1.13.0');
  assert.equal(fetchImpl.calls[0].url, 'http://api.test/v1/models');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.body, undefined);
});

test('redact replaces every occurrence of the key', () => {
  assert.equal(redact('a KEY b KEY', 'KEY'), 'a *** b ***');
  assert.equal(redact('plain', null), 'plain');
});
