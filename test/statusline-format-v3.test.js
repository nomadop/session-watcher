import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLB, renderDelta, renderLamp, renderBackstopProgress, renderU, renderMeterV3 } from '../lib/statusline-format.js';
import { uLeftAtBr, BR_AMBER } from '../lib/bill-regret.js';

test('renderLB uses B as denominator label', () => {
  assert.ok(renderLB(142000, 25300).includes('b25')); // L142k/b25.3k form
});

test('renderDelta shows g_ema, no kAvg fallback', () => {
  assert.ok(renderDelta(940).startsWith('Δ'));
  assert.equal(renderDelta(null), 'Δ----');
});

test('renderLamp arms by u: left arm white below the amber-left root, green at or above it', () => {
  const mf = 0.3, left = uLeftAtBr(mf, BR_AMBER);
  assert.equal(renderLamp(0.15, { u: left - 0.05, mf }), '⚪');
  assert.equal(renderLamp(0.05, { u: left + 0.05, mf }), '🟢');
  assert.equal(renderLamp(0.3, { u: 2, mf }), '🔴');
  assert.equal(renderLamp(0.15, { u: 2, mf }), '🟡');
  assert.equal(renderLamp(0.01, { u: 1.2, mf }), '🟢');
  assert.equal(renderLamp(null, { u: 0, mf: null }), '⚪', 'the first frame');
});

test('renderU prints the stamped u', () => {
  assert.equal(renderU({ u: 1.234 }), 'u1.2');
  assert.equal(renderU({ u: null }), 'u---');
  assert.equal(renderU({ x_display: 2, dhat: 0.5 }), 'u---', 'nothing is derived from the instantaneous read');
});

test('renderBackstopProgress renders the wallet phase as the bar, --% while inactive', () => {
  assert.equal(renderBackstopProgress({ rentMeter: { depthActive: false, depthProgress: 0 } }), '░░░░░░░░░░--%');
  assert.equal(renderBackstopProgress({ rentMeter: { depthActive: true, depthProgress: 0.37 } }), '▓▓▓░░░░░░░37%');
  assert.equal(renderBackstopProgress({}), '░░░░░░░░░░--%');
});
