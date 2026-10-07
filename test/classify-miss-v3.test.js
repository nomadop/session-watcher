import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMiss } from '../lib/l-measure.js';

test('classifyMiss: cold start (prevL=0) never a miss', () => {
  assert.equal(classifyMiss({ cacheRead: 0, prevL: 0 }), false);
});

test('classifyMiss: full miss — cr drops to 0', () => {
  assert.equal(classifyMiss({ cacheRead: 0, prevL: 80000 }), true);
});

test('classifyMiss: partial miss — cr drops >5%', () => {
  // cacheRead dropped from 80000 to 40000 (50% drop).
  assert.equal(classifyMiss({ cacheRead: 40000, prevL: 80000 }), true);
  // cacheRead dropped from 29450 to 15307 (48% drop) — the real bug case.
  assert.equal(classifyMiss({ cacheRead: 15307, prevL: 29450 }), true);
});

test('classifyMiss: a cache-read collapse is a miss whatever the total stock does', () => {
  // A compact or /clear opens an epoch, and the Engine classifies no epoch's first step
  // (test/measurement-engine.contract.test.js `first step after an epoch is not a miss`).
  assert.equal(classifyMiss({ cacheRead: 6000, prevL: 80000 }), true);
  assert.equal(classifyMiss({ cacheRead: 0, prevL: 80000 }), true);
});

test('classifyMiss: healthy row (cacheRead near prevL) → not a miss', () => {
  // Normal growth: cr=9800 vs prevL=10000 → ratio=0.98 > 0.95 → not a miss.
  assert.equal(classifyMiss({ cacheRead: 9800, prevL: 10000 }), false);
});

test('classifyMiss: tiny drop within noise threshold → not a miss', () => {
  // 2% drop (DeepSeek quantization noise): 98000 → 96000
  assert.equal(classifyMiss({ cacheRead: 96000, prevL: 98000 }), false);
});

test('classifyMiss: exactly at 0.95 boundary → not a miss (must be strictly below)', () => {
  // cr = prevL * 0.95 exactly → not < → not a miss
  assert.equal(classifyMiss({ cacheRead: 9500, prevL: 10000 }), false);
});
