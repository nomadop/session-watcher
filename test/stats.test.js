// test/stats.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../lib/stats.js';

test('median: odd length returns the middle of the sorted copy', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median: even length returns the average of the two middles', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('median: single element returns that element', () => {
  assert.equal(median([5]), 5);
});

test('median: empty array returns 0 (empty-input contract)', () => {
  assert.equal(median([]), 0);
});

test('median: non-array input returns 0 (null / undefined guard)', () => {
  assert.equal(median(null), 0);
  assert.equal(median(undefined), 0);
});

test('median: does not mutate the input (order unchanged after call)', () => {
  const input = [3, 1, 2];
  const snapshot = [...input];
  median(input);
  assert.deepEqual(input, snapshot);
});
