import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMiss } from '../lib/l-measure.js';

test('classifyMiss: cold start (prevL=0) never a miss', () => {
  assert.equal(classifyMiss({ cacheRead: 0, totalStock: 5000, prevL: 0, prevTotalStock: 0 }), false);
});

test('classifyMiss: full miss — cr drops to 0, stock preserved', () => {
  // Cache fully evicted: cr=0, but totalStock preserved via cc/input.
  assert.equal(classifyMiss({ cacheRead: 0, totalStock: 82000, prevL: 80000, prevTotalStock: 80000 }), true);
});

test('classifyMiss: partial miss — cr drops >5% while stock preserved', () => {
  // cacheRead dropped from 80000 to 40000 (50% drop), totalStock stable.
  assert.equal(classifyMiss({ cacheRead: 40000, totalStock: 82000, prevL: 80000, prevTotalStock: 80000 }), true);
  // cacheRead dropped from 29450 to 15307 (48% drop) — the real bug case.
  assert.equal(classifyMiss({ cacheRead: 15307, totalStock: 32078, prevL: 29450, prevTotalStock: 31437 }), true);
});

test('classifyMiss: compaction (totalStock also drops) → not a miss', () => {
  // Both cr and totalStock drop → segment boundary, not cache eviction.
  assert.equal(classifyMiss({ cacheRead: 6000, totalStock: 6000, prevL: 80000, prevTotalStock: 80000 }), false);
});

test('classifyMiss: /clear (both collapse) → not a miss', () => {
  assert.equal(classifyMiss({ cacheRead: 0, totalStock: 500, prevL: 80000, prevTotalStock: 80000 }), false);
});

test('classifyMiss: healthy row (cacheRead near prevL) → not a miss', () => {
  // Normal growth: cr=9800 vs prevL=10000 → ratio=0.98 > 0.95 → not a miss.
  assert.equal(classifyMiss({ cacheRead: 9800, totalStock: 10200, prevL: 10000, prevTotalStock: 10000 }), false);
});

test('classifyMiss: tiny drop within noise threshold → not a miss', () => {
  // 2% drop (DeepSeek quantization noise): 98000 → 96000
  assert.equal(classifyMiss({ cacheRead: 96000, totalStock: 100000, prevL: 98000, prevTotalStock: 98500 }), false);
});

test('classifyMiss: exactly at 0.95 boundary → not a miss (must be strictly below)', () => {
  // cr = prevL * 0.95 exactly → not < → not a miss
  assert.equal(classifyMiss({ cacheRead: 9500, totalStock: 10200, prevL: 10000, prevTotalStock: 10000 }), false);
});
