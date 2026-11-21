// test/measurement-usage.test.js — the two sums every consumer takes of a call's canonical usage: the stock its request carried and the tokens the cache did not serve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockOf, uncachedOf } from '../lib/measurement/usage.js';

const usage = { input: 100, output: 7, cacheRead: 20_000, cacheWrite: 3_000 };

test('the stock of a call is its input and both cache buckets, never its output', () => {
  assert.equal(stockOf(usage), 23_100);
  assert.equal(stockOf({ ...usage, output: 0 }), 23_100);
});

test('the uncached tokens of a call are its input and what it wrote to the cache, never what the cache served', () => {
  assert.equal(uncachedOf(usage), 3_100);
  assert.equal(uncachedOf({ ...usage, cacheRead: 0 }), 3_100);
  assert.equal(uncachedOf({ input: 0, output: 0, cacheRead: 5, cacheWrite: 0 }), 0);
});
