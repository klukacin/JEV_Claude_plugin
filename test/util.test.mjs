import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num, truncate, preview } from '../lib/util.mjs';

test('num parses finite numbers and rejects everything else', () => {
  assert.equal(num('1.5'), 1.5);
  assert.equal(num(0), 0);
  assert.equal(num(''), null);
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num('abc'), null);
  assert.equal(num(Infinity), null);
});

test('truncate keeps short text and marks cut text', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate(null, 4), '');
});

test('preview collapses whitespace to one line', () => {
  assert.equal(preview('a\n\n  b\tc'), 'a b c');
  assert.equal(preview('x'.repeat(200)).length, 120);
});
