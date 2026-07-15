// test/chart-helpers.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeYMax, buildMissMarkers, buildProjectionData } from '../public/chart-helpers.js';

test('computeYMax uses only L (ignores Lthreshold), floored at 1', () => {
  const hist = [ { L: 50000, Lthreshold: 60000 }, { L: 80000, Lthreshold: 70000 } ];
  assert.equal(computeYMax(hist), 80000, 'max over L only');
  // Verify Lthreshold is truly excluded even when it exceeds max(L)
  const hist2 = [ { L: 30000, Lthreshold: 500000 }, { L: 40000, Lthreshold: 600000 } ];
  assert.equal(computeYMax(hist2), 40000, 'Lthreshold ignored even when much larger');
});

// ER-5: the server always resolves effectiveL into p.L (computeHistoryPoint always emits a finite L),
// so the client no longer re-derives from cacheRead. A point carrying ONLY cacheRead (no p.L) is an
// impossible production shape; computeYMax now reads p.L directly and therefore does NOT count it.
// (Previously this asserted the cacheRead fallback === 42000; that fallback is exactly what ER-5 removes.)
test('computeYMax reads p.L directly (ER-5) and floors at 1 for empty/zero', () => {
  assert.equal(computeYMax([{ L: 42000 }]), 42000, 'p.L read directly');
  assert.equal(computeYMax([{ cacheRead: 42000 }]), 1, 'ER-5: no p.L → NOT re-derived from cacheRead');
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
  // first miss at history-index 1 → x: 2 (1-based, aligned to the chart axis min:1 with turn labels)
  // Fix #2: x was previously 0-based (x: i), now 1-based (x: i+1) to align with the chart's x-axis
  assert.deepEqual(m[0], { x: 2, y: 0, historyIndex: 1 });
  assert.deepEqual(m[1], { x: 2, y: 90000, historyIndex: 1 });
  assert.deepEqual(m[2], { x: 2, y: null, historyIndex: 1 });
  // second miss at history-index 3 → x: 4
  assert.equal(m[3].x, 4); assert.equal(m[3].historyIndex, 3);
  assert.equal(m[5].y, null, 'null separator prevents a cross-miss slanted line');
});

test('buildMissMarkers is empty when no miss rows (DeepSeek structural no-op path)', () => {
  const hist = [ { miss: false }, { miss: false } ];
  assert.deepEqual(buildMissMarkers(hist, 1000), [], 'no miss → no markers → no red line');
});


// --- buildProjectionData (spec §6.1: dashed projection from last point at gEma slope) ---

test('buildProjectionData returns empty array for empty points', () => {
  assert.deepEqual(buildProjectionData([], 0, 100, 200000), []);
});

test('buildProjectionData returns empty array when slope is zero', () => {
  const points = [{ L: 50000, kAvg: 0 }];
  assert.deepEqual(buildProjectionData(points, 0, 100, 200000), [], 'zero gEma and zero kAvg → no projection');
});

test('buildProjectionData uses lastGEma as slope when positive', () => {
  const points = [{ L: 50000, kAvg: 3000 }, { L: 60000, kAvg: 5000 }];
  const result = buildProjectionData(points, 8000, 100, 200000);
  assert.equal(result.length, 2, 'two endpoints');
  assert.equal(result[0].x, 2, 'starts at last turn (1-based)');
  assert.equal(result[0].y, 60000, 'starts at last L');
  // projectedY = 60000 + 8000 * (100 - 2) = 844000, clamped to ratchetY=200000
  // When Y clamped, X shortened to true intercept: 2 + (200000 - 60000) / 8000 = 19.5
  assert.equal(result[1].y, 200000, 'clamped to ratchetY');
  assert.equal(result[1].x, 19.5, 'X shortened to true slope intercept at ratchetY');
});

test('buildProjectionData falls back to last kAvg when lastGEma is not positive', () => {
  const points = [{ L: 50000, kAvg: 3000 }, { L: 60000, kAvg: 4000 }];
  const result = buildProjectionData(points, 0, 100, 200000);
  assert.equal(result.length, 2);
  // slope = last kAvg = 4000; projectedY = 60000 + 4000 * (100 - 2) = 60000 + 392000 = 452000, clamped to 200000
  assert.equal(result[1].y, 200000, 'clamped to ratchetY');
});

test('buildProjectionData extends ratchetX when less than 5 turns ahead of last point', () => {
  // 10 points, ratchetX = 12 → effectiveRatchetX - lastTurn = 12 - 10 = 2 < 5 → extend to lastTurn + 20 = 30
  const points = Array.from({ length: 10 }, (_, i) => ({ L: 10000 + i * 1000, kAvg: 1000 }));
  const result = buildProjectionData(points, 2000, 12, 200000);
  assert.equal(result[1].x, 30, 'extended to lastTurn + 20 when ratchetX is too close');
  // projectedY = 19000 + 2000 * (30 - 10) = 19000 + 40000 = 59000
  assert.equal(result[1].y, 59000, 'projected Y not clamped when below ratchetY');
});

test('buildProjectionData does not exceed ratchetY', () => {
  const points = [{ L: 180000, kAvg: 50000 }];
  const result = buildProjectionData(points, 50000, 100, 200000);
  assert.equal(result[1].y, 200000, 'Y clamped to ratchetY');
});

