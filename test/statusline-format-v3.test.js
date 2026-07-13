import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderLamp, renderMeterV3, renderBillCount, renderCountdown,
  renderU, renderDelta, renderLB, renderAlertLine, renderCalibratingV3,
  formatLine, _resetRenderState, _resetCarousel,
} from '../lib/statusline-format.js';

// === renderLamp ===
test('renderLamp below_entry → ⚪', () => assert.equal(renderLamp('below_entry', false), '⚪'));
test('renderLamp sweet → 🟢', () => assert.equal(renderLamp('entry_to_sweet', false), '🟢'));
test('renderLamp above_exit → 🟡', () => assert.equal(renderLamp('above_exit', false), '🟡'));
test('renderLamp deep override → 🟡', () => assert.equal(renderLamp('sweet_to_exit', true), '🟡'));

// === renderBillCount (fixed width ×NN) ===
test('renderBillCount 0 → "× 0"', () => assert.equal(renderBillCount(0), '× 0'));
test('renderBillCount 3 → "× 3"', () => assert.equal(renderBillCount(3), '× 3'));
test('renderBillCount 12 → "×12"', () => assert.equal(renderBillCount(12), '×12'));

// === renderCountdown (fixed 4-char) ===
test('renderCountdown ---t when no rate', () => assert.equal(renderCountdown({ targetL: 100000 }, 50000), '---t'));
test('renderCountdown ---t when target is NaN', () => assert.equal(renderCountdown({ targetL: NaN, deltaLPerTurn: 3000 }, 50000), '---t'));
test('renderCountdown ~00t when target <= L', () => assert.equal(renderCountdown({ targetL: 50000, deltaLPerTurn: 3000 }, 60000), '~00t'));
test('renderCountdown +99t when n > 99', () => assert.equal(renderCountdown({ targetL: 500000, deltaLPerTurn: 1000 }, 50000), '+99t'));
test('renderCountdown ~08t normal', () => assert.equal(renderCountdown({ targetL: 100000, deltaLPerTurn: 3000 }, 76000), '~08t'));

// === renderU ===
test('renderU normal → u1.2', () => assert.equal(renderU({ x_display: 1.5, dhat: 0.4167 }), 'u1.2'));
test('renderU non-finite → u---', () => assert.equal(renderU({ x_display: NaN, dhat: 0.4 }), 'u---'));
test('renderU dhat=0 → u---', () => assert.equal(renderU({ x_display: 1.5, dhat: 0 }), 'u---'));

// === renderDelta ===
test('renderDelta no data → Δ----', () => { _resetRenderState(); assert.equal(renderDelta(50000), 'Δ----'); });
test('renderDelta 3.2k', () => { _resetRenderState(); renderDelta(50000); assert.equal(renderDelta(53200), 'Δ3.2k'); });

// === renderAlertLine ===
test('renderAlertLine null when no event', () => assert.equal(renderAlertLine({ currentTurnSeq: 5 }), null));
test('renderAlertLine null when expired', () => assert.equal(renderAlertLine({ currentTurnSeq: 5, lastStopEvent: { turnSeq: 4, message: 'x' } }), null));
test('renderAlertLine returns message when active', () => assert.equal(renderAlertLine({ currentTurnSeq: 5, lastStopEvent: { turnSeq: 5, message: 'Rate wall: ...' } }), 'Rate wall: ...'));

// === calibration carousel ===
test('no_transcript renders ⚠️', () => {
  const s = { model: 'claude-opus-4-8', port: 38017, calibratingReason: 'no_transcript' };
  const gate = { reason: 'no_transcript', hardUnavailable: true };
  const line = renderCalibratingV3(s, gate, { now: 0 });
  assert.ok(line.includes('⚠️'));
  assert.ok(!line.includes('🟢'));
});

test('carousel advances at 2s boundary', () => {
  _resetCarousel();
  const s = { model: 'claude-opus-4-8', port: 38017, L: 12000, calibratingReason: 'insufficient_data', baseline: null };
  const gate = { reason: 'insufficient_data', hardUnavailable: false };
  const l1 = renderCalibratingV3(s, gate, { now: 0 });
  const l2 = renderCalibratingV3(s, gate, { now: 1999 });
  const l3 = renderCalibratingV3(s, gate, { now: 2000 });
  // Use full emoji match (not character class) to avoid surrogate-pair issues
  const lamp = (line) => {
    if (line.includes('⚪')) return '⚪';
    if (line.includes('🟢')) return '🟢';
    if (line.includes('🟡')) return '🟡';
    return null;
  };
  assert.equal(lamp(l1), lamp(l2), 'no advance before 2s');
  assert.notEqual(lamp(l2), lamp(l3), 'advances at 2s');
});

// === formatLine integration ===
test('formatLine reliable: 4-group layout, no [sw] tag', () => {
  _resetRenderState(); _resetCarousel();
  const s = {
    model: 'claude-opus-4-8', port: 38017, L: 156000,
    metricsReliable: true, calibratingReason: null,
    rateLamp: {
      reliable: true, billProgress: 0.63, billCycleCount: 3,
      band: 'entry_to_sweet', x_display: 2.8, dhat: 0.4167,
      xEntry: 1.2, xExit: 2.0, L_read: 156000, lBase: 55000,
      L_cap: 960000, inDeepWater: false, deepWaterDisplayLatched: false,
      targetL: 110000, deltaLPerTurn: 3000, currentTurnSeq: 5,
    },
    baseline: { total: 55000 },
  };
  // Seed renderDelta so Δ is not ----
  renderDelta(150000);
  const line = formatLine(s);
  assert.ok(!line.includes('['), 'no tag');
  assert.ok(line.includes('🟢'));
  assert.ok(line.includes('63%'));
  assert.ok(line.includes(' · '));
  assert.ok(line.includes('opus'));
  assert.ok(!line.includes(':38017'), 'port not in formatLine output (server appends URL)');
  assert.ok(!line.includes('\n'), 'single line');
});

test('formatLine with alert: two lines', () => {
  _resetRenderState(); _resetCarousel();
  const s = {
    model: 'claude-opus-4-8', port: 38017, L: 200000,
    metricsReliable: true, calibratingReason: null,
    rateLamp: {
      reliable: true, billProgress: 0.91, billCycleCount: 7,
      band: 'above_exit', x_display: 3.6, dhat: 0.4167,
      xEntry: 1.2, xExit: 2.0, L_read: 200000, lBase: 55000,
      L_cap: 960000, inDeepWater: true, deepWaterDisplayLatched: true,
      targetL: 960000, deltaLPerTurn: 5000, currentTurnSeq: 8,
      lastStopEvent: { turnSeq: 8, message: 'Rate wall: one more call costs a full restart.' },
    },
    baseline: { total: 55000 },
  };
  const line = formatLine(s);
  const lines = line.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('🟡'));
  assert.ok(lines[1].startsWith('↻'));
});

// === NaN guards ===
test('renderDelta(NaN) returns Δ---- and does not corrupt state', () => {
  _resetRenderState();
  // Seed with valid value
  renderDelta(50000);
  renderDelta(53000);
  // Now pass NaN — should return fallback without corrupting state
  assert.equal(renderDelta(NaN), 'Δ----');
  // Subsequent valid call should still work (state not corrupted)
  const result = renderDelta(56000);
  assert.ok(result.startsWith('Δ'), 'still produces delta prefix');
  assert.ok(!result.includes('NaN'), 'no NaN in output');
});

test('renderCountdown returns ---t when L is NaN', () => {
  assert.equal(renderCountdown({ targetL: 100000, deltaLPerTurn: 3000 }, NaN), '---t');
});

// === Fix 1: Band clamping (frozen-axis invariant) ===
test('formatLine clamps band: above_exit with deep=false shows green not yellow', () => {
  _resetRenderState(); _resetCarousel();
  const s = {
    model: 'claude-opus-4-8', port: 38017, L: 200000,
    metricsReliable: true, calibratingReason: null,
    rateLamp: {
      reliable: true, billProgress: 0.8, billCycleCount: 5,
      band: 'above_exit', // kAvg says above_exit
      x_display: 2.5, dhat: 0.4167, xEntry: 1.2, xExit: 2.0,
      L_read: 200000, lBase: 55000, L_cap: 960000,
      inDeepWater: false, deepWaterDisplayLatched: false, // frozen axis says NOT deep
      targetL: 960000, deltaLPerTurn: 3000, currentTurnSeq: 5,
    },
    baseline: { total: 55000 },
  };
  const line = formatLine(s);
  assert.ok(line.includes('\u{1F7E2}'), 'frozen axis NOT deep must show green, not yellow');
  assert.ok(!line.includes('\u{1F7E1}'));
});

// === Fix 2: perTurnBillCount segment reset ===
test('formatLine: billCycleCount segment reset does not produce negative bill count', () => {
  _resetRenderState(); _resetCarousel();
  // Seed: turn 5, count=10
  const s1 = {
    model: 'claude-opus-4-8', port: 38017, L: 150000,
    metricsReliable: true, calibratingReason: null,
    rateLamp: {
      reliable: true, billProgress: 0.5, billCycleCount: 10,
      band: 'entry_to_sweet', x_display: 2.0, dhat: 0.4167,
      xEntry: 1.2, xExit: 2.0, L_read: 150000, lBase: 55000,
      L_cap: 960000, inDeepWater: false, deepWaterDisplayLatched: false,
      targetL: 960000, deltaLPerTurn: 3000, currentTurnSeq: 5,
    },
    baseline: { total: 55000 },
  };
  formatLine(s1); // seeds _baseBillCount=10
  // Second call same turn, count=12 → normal +2
  s1.rateLamp.billCycleCount = 12;
  s1.L = 151000;
  formatLine(s1);
  // Segment reset: count drops to 2, same turn
  s1.rateLamp.billCycleCount = 2;
  s1.L = 152000;
  const line = formatLine(s1);
  // Should show "x 0" (re-anchored), NOT a negative
  assert.ok(!line.includes('×-'), 'bill count must never be negative after segment reset');
});

// === Fix 6: renderDelta no spike on calibrating→reliable transition ===
test('renderDelta no spike on calibrating to reliable transition', () => {
  _resetRenderState(); _resetCarousel();
  // Simulate calibrating calls (formatLine goes into calibrating path, calling renderDelta with L)
  const calibrating = {
    model: 'claude-opus-4-8', port: 38017, L: 50000,
    calibratingReason: 'insufficient_data',
    baseline: null,
    rateLamp: {},
  };
  formatLine(calibrating); // seeds renderDelta with L=50000
  // More calibrating with higher L
  calibrating.L = 80000;
  formatLine(calibrating);
  calibrating.L = 100000;
  formatLine(calibrating);
  // Now transition to reliable with a much higher L
  _resetCarousel();
  const reliable = {
    model: 'claude-opus-4-8', port: 38017, L: 150000,
    metricsReliable: true, calibratingReason: null,
    rateLamp: {
      reliable: true, billProgress: 0.5, billCycleCount: 3,
      band: 'entry_to_sweet', x_display: 2.0, dhat: 0.4167,
      xEntry: 1.2, xExit: 2.0, L_read: 150000, lBase: 55000,
      L_cap: 960000, inDeepWater: false, deepWaterDisplayLatched: false,
      targetL: 960000, deltaLPerTurn: 3000, currentTurnSeq: 5,
    },
    baseline: { total: 55000 },
  };
  const line = formatLine(reliable);
  // Delta should be ---- (reset) not a huge spike
  assert.ok(line.includes('Δ----'), 'first reliable call after calibrating should show no delta');
});
