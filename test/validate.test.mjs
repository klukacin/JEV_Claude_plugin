import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestion, validateQuestions } from '../lib/validate.mjs';

test('accepts well-formed questions of each type', () => {
  assert.equal(validateQuestion({ type: 'noul', instructions: 'Is it red?' }), true);
  assert.equal(validateQuestion({ type: 'noul', instructions: 'Is it red?', criteria: { true: 'red', false: 'not red' } }), true);
  assert.equal(validateQuestion({ type: 'choice', instructions: { ask: 'which' }, criteria: { a: 'A', b: null } }), true);
  assert.equal(validateQuestion({ type: 'score', instructions: ['x'], criteria: ['lo', { summary: 'hi' }] }), true);
});

test('rejects malformed questions with the id in the message', () => {
  const bad = [
    [null, /q1: must be an object/],
    [{ type: 'maybe', instructions: 'x' }, /q1: type must be/],
    [{ type: 'noul', instructions: '  ' }, /q1: instructions/],
    [{ type: 'choice', instructions: 'x' }, /q1: choice needs criteria/],
    [{ type: 'choice', instructions: 'x', criteria: {} }, /q1: choice needs criteria/],
    [{ type: 'choice', instructions: 'x', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, '']))}, /q1: choice supports at most 255/],
    [{ type: 'score', instructions: 'x', criteria: ['only'] }, /q1: score needs criteria/],
    [{ type: 'score', instructions: 'x', criteria: Array(11).fill('l') }, /q1: score needs criteria/],
    [{ type: 'noul', instructions: 'x', criteria: 'yes' }, /q1: noul criteria/],
  ];
  for (const [q, re] of bad) assert.throws(() => validateQuestion(q, 'q1'), re);
});

test('validateQuestions needs a non-empty object', () => {
  assert.throws(() => validateQuestions({}), /non-empty object/);
  assert.throws(() => validateQuestions([]), /non-empty object/);
  assert.throws(() => validateQuestions({ a: { type: 'score', instructions: 'x', criteria: [] } }), /a: score needs criteria/);
  assert.equal(validateQuestions({ a: { type: 'noul', instructions: 'x' } }), true);
});
