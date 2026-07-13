// H-pt4/B9 extraction PARITY: lib/deep-water-display.js is the server SSOT; public/chart-helpers.js
// carries a browser-safe duplicate (no cross-directory import). Both must produce identical results
// on every documented behavior (enter-at-exit, leave-only-past-deadband, degenerate guards, 2048 floor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepWaterDisplay as fromLib } from '../lib/deep-water-display.js';
import { deepWaterDisplay as fromChartHelpers } from '../public/chart-helpers.js';

test('extraction parity: chart-helpers deepWaterDisplay is behaviorally identical to lib copy', () => {
  const cases = [
    [false, { L_read: 399999, L_exit_fullCarry: 400000, cRatio: 10, B_rebuild: 250000 }],
    [false, { L_read: 400000, L_exit_fullCarry: 400000, cRatio: 10, B_rebuild: 250000 }],
    [true, { L_read: 350001, L_exit_fullCarry: 400000, cRatio: 10, B_rebuild: 250000 }],
    [true, { L_read: 300000, L_exit_fullCarry: 400000, cRatio: 10, B_rebuild: 250000 }],
    [true, { L_read: NaN, L_exit_fullCarry: 400000, cRatio: 10, B_rebuild: 250000 }],
    [false, { L_read: 5, L_exit_fullCarry: 0, cRatio: 10, B_rebuild: 250000 }],
  ];
  for (const [prevLatched, args] of cases) {
    assert.equal(fromChartHelpers(prevLatched, args), fromLib(prevLatched, args),
      `parity: prevLatched=${prevLatched} L_read=${args.L_read}`);
  }
});

test('parity: sticky latch — enter at exit, leave only past a full RATE_EXIT_HYST (matches the source)', () => {
  const cRatio = 10, B_rebuild = 250000;          // hyst = max(2048, 0.02·10·250000) = 50000
  const L_exit = 400000;
  const hyst = Math.max(2048, 0.02 * cRatio * B_rebuild);
  assert.equal(hyst, 50000, 'precondition: the 0.02·cRatio·B_rebuild branch (not the 2048 floor)');
  const args = (L_read) => ({ L_read, L_exit_fullCarry: L_exit, cRatio, B_rebuild });

  assert.equal(fromLib(false, args(L_exit - 1)), false, 'unlatched: just under exit stays false');
  assert.equal(fromLib(false, args(L_exit)), true, 'unlatched: latches true at L_read === L_exit');
  assert.equal(fromLib(true, args(L_exit - 0.5 * hyst)), true, 'latched: a sub-hysteresis dip keeps the lamp on');
  assert.equal(fromLib(true, args(L_exit - 2 * hyst)), false, 'latched: dropping past a full RATE_EXIT_HYST turns it off');
  assert.equal(fromLib(true, args(L_exit - hyst)), true, 'latched: the deadband edge (L_exit - hyst) is inclusive');
});

test('parity: the 2048 floor branch', () => {
  const floorArgs = (L_read) => ({ L_read, L_exit_fullCarry: 10000, cRatio: 1, B_rebuild: 1 });
  assert.equal(Math.max(2048, 0.02 * 1 * 1), 2048, 'precondition: floor branch active');
  assert.equal(fromLib(true, floorArgs(10000 - 1000)), true, 'floor: a 1000 dip < 2048 keeps it on');
  assert.equal(fromLib(true, floorArgs(10000 - 3000)), false, 'floor: a 3000 dip > 2048 drops it');
});

test('parity: degenerate guards — non-positive exit line or non-finite L_read → false, never a throw', () => {
  const cRatio = 10, B_rebuild = 250000;
  assert.equal(fromLib(true, { L_read: NaN, L_exit_fullCarry: 400000, cRatio, B_rebuild }), false, 'non-finite L_read → false');
  assert.equal(fromLib(true, { L_read: 5, L_exit_fullCarry: 0, cRatio, B_rebuild }), false, 'non-positive exit line → false');
  assert.equal(fromLib(false, { L_read: 5, L_exit_fullCarry: -1, cRatio, B_rebuild }), false, 'negative exit line → false');
});

test('parity: PURE — same inputs give same output and the arg object is not mutated', () => {
  const args = { L_read: 399000, L_exit_fullCarry: 400000, cRatio: 10, B_rebuild: 250000 };
  const snapshot = JSON.parse(JSON.stringify(args));
  assert.equal(fromLib(true, args), fromLib(true, args), 'referentially transparent');
  assert.deepEqual(args, snapshot, 'input object not mutated');
});
