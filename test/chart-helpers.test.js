// test/chart-helpers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeYMax, buildMissMarkers } from '../public/chart-helpers.js';

test('computeYMax spans effectiveL and Lthreshold, floored at 1', () => {
  const hist = [ { L: 50000, Lthreshold: 60000 }, { L: 80000, Lthreshold: 70000 } ];
  assert.equal(computeYMax(hist), 80000, 'max over L and Lthreshold');
});

test('computeYMax uses cacheRead when L absent, and floors at 1 for empty/zero', () => {
  assert.equal(computeYMax([{ cacheRead: 42000 }]), 42000, 'falls back to cacheRead');
  assert.equal(computeYMax([]), 1, 'empty history floored at 1');
  assert.equal(computeYMax([{ L: 0, Lthreshold: 0 }]), 1, 'all-zero floored at 1');
});

test('computeYMax does NOT throw RangeError on a very long history (no spread) — gemini #1', () => {
  const big = Array.from({ length: 200000 }, (_, i) => ({ L: i, Lthreshold: 0 }));
  assert.equal(computeYMax(big), 199999, 'for-loop handles 200k points without a call-stack blowup');
});

test('buildMissMarkers emits 3 points per miss: (x,0),(x,yMax),(x,null), all with historyIndex', () => {
  const hist = [ { miss: false }, { miss: true }, { miss: false }, { miss: true } ];
  const m = buildMissMarkers(hist, 90000);
  assert.equal(m.length, 6, '2 miss rows × 3 points');
  // first miss at index 1
  assert.deepEqual(m[0], { x: 1, y: 0, historyIndex: 1 });
  assert.deepEqual(m[1], { x: 1, y: 90000, historyIndex: 1 });
  assert.deepEqual(m[2], { x: 1, y: null, historyIndex: 1 });
  // second miss at index 3
  assert.equal(m[3].x, 3); assert.equal(m[3].historyIndex, 3);
  assert.equal(m[5].y, null, 'null separator prevents a cross-miss slanted line');
});

test('buildMissMarkers is empty when no miss rows (DeepSeek structural no-op path)', () => {
  const hist = [ { miss: false }, { miss: false } ];
  assert.deepEqual(buildMissMarkers(hist, 1000), [], 'no miss → no markers → no red line');
});
