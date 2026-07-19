import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLB, renderDelta, renderLamp, renderBackstopProgress } from '../lib/statusline-format.js';

test('renderLB uses B as denominator label', () => {
  assert.ok(renderLB(142000, 25300).includes('b25')); // L142k/b25.3k form
});

test('renderDelta shows g_ema, no kAvg fallback', () => {
  assert.ok(renderDelta(940).startsWith('Δ'));
  assert.equal(renderDelta(null), 'Δ----');
});

test('renderLamp: br thresholds without calibrating param', () => {
  assert.equal(renderLamp(0.3, { x: 2, xSweet: 1.1 }), '🔴');
  assert.equal(renderLamp(0.15, { x: 2, xSweet: 1.1 }), '🟡');
  assert.equal(renderLamp(0.01, { x: 1.05, xSweet: 1.1 }), '⚪'); // left arm (x<xSweet) whitening
});

test('renderBackstopProgress shows -/- before gate fires', () => {
  assert.equal(renderBackstopProgress({ hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, mf: 0.4 }), '-/-');
});

test('renderBackstopProgress shows n/N after gate, capped below denom', () => {
  // mf=0.4 → interval 4.0 → denom 4. numer = min(3, floor(3)) = 3.
  assert.equal(renderBackstopProgress({ hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 3, mf: 0.4 }), '3/4');
});

test('renderBackstopProgress never shows N/N (numer capped at denom-1)', () => {
  assert.equal(renderBackstopProgress({ hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 4, mf: 0.4 }), '3/4');
});

test('renderBackstopProgress denom floors at 1 for degenerate mf', () => {
  const s = renderBackstopProgress({ hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 0, mf: 0 });
  // mf=0 → interval Infinity → denom max(1, round(Inf)) → guard to -/- (no meaningful reminder).
  assert.equal(s, '-/-');
});
