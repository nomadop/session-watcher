import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uAtBr, backstopIntervalFor, BR_AMBER } from '../lib/bill-regret.js';
import { advanceGateAndBackstop } from '../lib/rate-lamp-store.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('uAtBr numerical correctness at BR_AMBER', () => {
  near(uAtBr(0.20, BR_AMBER), 2.62);
  near(uAtBr(0.30, BR_AMBER), 2.22);
  near(uAtBr(0.40, BR_AMBER), 2.00);
});

test('backstopIntervalFor = uAmber squared', () => {
  near(backstopIntervalFor(0.20, BR_AMBER), 6.85);
  near(backstopIntervalFor(0.30, BR_AMBER), 4.91);
  near(backstopIntervalFor(0.40, BR_AMBER), 4.00);
});

test('uAtBr guards: mf<=0 → Infinity; finite brTarget<=0 → 1; non-finite brTarget → Infinity', () => {
  assert.equal(uAtBr(0, BR_AMBER), Infinity);
  assert.equal(uAtBr(-1, BR_AMBER), Infinity);
  assert.equal(uAtBr(0.3, 0), 1);          // genuinely-zero finite target: degenerate but finite
  assert.equal(uAtBr(0.3, -0.5), 1);       // negative finite target: clamp to 1
  assert.equal(uAtBr(0.3, NaN), Infinity); // non-finite target → safe degrade (never fires), NOT 1
  assert.equal(uAtBr(NaN, BR_AMBER), Infinity);
});

test('interval never clamped: high mf gives shorter interval (invariant 6), no floor at 4', () => {
  // mf cannot exceed ~0.414 physically, but if a test feeds 0.414 the interval is ~4.0 — the natural min.
  near(backstopIntervalFor(0.414, BR_AMBER), 4.0, 0.1);
  // A smaller mf yields a LARGER interval — monotonic, never floored.
  assert.ok(backstopIntervalFor(0.20, BR_AMBER) > backstopIntervalFor(0.40, BR_AMBER));
});

test('backstopIntervalFor Infinity when interval unreachable (mf=0)', () => {
  assert.equal(backstopIntervalFor(0, BR_AMBER), Infinity);
});

// ── accumulator (reader path) ──
const mkDraft = () => ({ hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0, deepWaterDwell: 0, deepWaterDwellCycled: 0 });

test('accumulator inactive before gate fires', () => {
  const d = mkDraft();
  advanceGateAndBackstop(d, { inDeepWater: true, billCycleIncrement: 100 });
  assert.equal(d.dwBillsSinceLastAlert, 0);
});

test('sweet-zone boundaries do NOT advance the accumulator', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true };
  advanceGateAndBackstop(d, { inDeepWater: false, billCycleIncrement: 10 });
  assert.equal(d.dwBillsSinceLastAlert, 0);
});

test('accumulator advances by REAL bill increment (batch of 3 adds 3, not 1)', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true };
  advanceGateAndBackstop(d, { inDeepWater: true, billCycleIncrement: 3 });
  assert.equal(d.dwBillsSinceLastAlert, 3);
});

test('reader-path backstop fire: accumulator reaches interval → lap increments', () => {
  // Setup: gate already fired, dwBills just below threshold
  const mf = 0.3;  // backstopIntervalFor(0.3, 0.10) ≈ 4.9 → fires when dwBills reaches interval
  const interval = backstopIntervalFor(mf, BR_AMBER);
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: Math.floor(interval) - 1,  // one bill short
    backstopLapCount: 0,
  };
  // Advance with 2 bill cycles → crosses threshold
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 2, mf });
  assert.equal(fired, true, 'fired signal returned');
  assert.equal(draft.backstopLapCount, 1, 'lap must increment when accumulator crosses interval');
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'accumulator must reset after fire');
});

test('reader-path backstop fire: accumulator below interval → no fire', () => {
  const mf = 0.3;
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 1,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf });
  assert.equal(fired, false, 'fired signal is false');
  assert.equal(draft.backstopLapCount, 0, 'no fire when below interval');
  assert.equal(draft.dwBillsSinceLastAlert, 2, 'accumulator advances');
});

test('reader-path backstop fire: mf=0 skips fire check but still accumulates', () => {
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 100, // well past any threshold
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf: 0 });
  assert.equal(fired, false, 'no fire when mf=0');
  assert.equal(draft.backstopLapCount, 0, 'lap not incremented');
  assert.equal(draft.dwBillsSinceLastAlert, 101, 'accumulator still advances');
});

test('reader-path backstop fire: multi-lap accumulation', () => {
  const mf = 0.3;
  const interval = backstopIntervalFor(mf, BR_AMBER);
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 0,
    backstopLapCount: 0,
  };
  // Accumulate to first fire
  for (let i = 0; i < Math.ceil(interval); i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf });
  }
  assert.equal(draft.backstopLapCount, 1, 'first lap fires');
  // Accumulate to second fire
  for (let i = 0; i < Math.ceil(interval); i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf });
  }
  assert.equal(draft.backstopLapCount, 2, 'second lap fires');
});

test('reader-path backstop fire: returns fired=true on threshold crossing', () => {
  const mf = 0.3;
  const interval = backstopIntervalFor(mf, BR_AMBER);
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: Math.floor(interval) - 1,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 2, mf });
  assert.equal(fired, true, 'fired signal is true on threshold crossing');
});

test('reader-path backstop fire: gate not fired → no accumulation, fired=false', () => {
  const draft = {
    hasDeepWaterGateFired: false,
    dwBillsSinceLastAlert: 0,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 5, mf: 0.3 });
  assert.equal(fired, false);
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'no accumulation without gate');
});

test('reader-path backstop fire: not in deep water → no accumulation, fired=false', () => {
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 100,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: false, billCycleIncrement: 5, mf: 0.3 });
  assert.equal(fired, false);
  assert.equal(draft.dwBillsSinceLastAlert, 100, 'no change when not in deep water');
});
