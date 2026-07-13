import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampKStable, computeXExitFromKStable, computeFullCarryBurnRate,
  computeRateWall, computeRateLampInstant,
} from '../lib/rate-lamp.js';
import { CONSTANTS } from '../lib/constants.js';

const R = 10, LBASE = 55000, K = 940;

test('1: burnRate=(x−1)/cRatio; hBreak=1/burnRate; product=1 (fullCarry)', () => {
  const L = 2 * LBASE; // x=2
  const br = computeFullCarryBurnRate({ L_read: L, B_post: LBASE, B_rebuild: LBASE, cRatio: R });
  assert.ok(Math.abs(br - (2 - 1) / R) < 1e-9);
  assert.ok(Math.abs(br * (1 / br) - 1) < 1e-12);
});

test('2: carry-aware — deadOnly burnRate > fullCarry at same L', () => {
  const L = 2 * LBASE, lDead = 0.25 * LBASE;
  const full = computeFullCarryBurnRate({ L_read: L, B_post: LBASE, B_rebuild: LBASE, cRatio: R });
  const dead = computeFullCarryBurnRate({ L_read: L, B_post: lDead, B_rebuild: lDead, cRatio: R });
  assert.ok(dead > full, 'smaller B_rebuild denominator + larger numerator → higher burnRate');
});

test('3: invalid baseline → reliable=false, invalid_baseline', () => {
  const bad = computeRateLampInstant(
    { L_read: 1e5, lBase: 0, lDead: 0, cRatio: R, lCap: 960000, kStable: K, kStableReliable: true, baselineValid: false },
    { scenario: 'fullCarry' });
  assert.equal(bad.reliable, false);
  assert.equal(bad.unavailableReason, 'invalid_baseline');
  assert.equal(bad.burnRate, undefined, 'no numerics emitted when unreliable');
});

test('4: x=1+cRatio → burnRate=1 (WALL position); x<1 → burnRate=0 (clamp)', () => {
  const wallL = (1 + R) * LBASE;
  const br = computeFullCarryBurnRate({ L_read: wallL, B_post: LBASE, B_rebuild: LBASE, cRatio: R });
  assert.ok(Math.abs(br - 1) < 1e-9);
  const below = computeFullCarryBurnRate({ L_read: 0.5 * LBASE, B_post: LBASE, B_rebuild: LBASE, cRatio: R });
  assert.equal(below, 0, 'max(0,·) clamps below-floor to 0');
});

test('20 + 22b/22c: k_stable clamp', () => {
  assert.equal(clampKStable(940), 940, 'in-band untouched');
  assert.equal(clampKStable(0), CONSTANTS.K_FLOOR, '22b: →0 floored');
  assert.equal(clampKStable(1e9), CONSTANTS.K_CEIL, '22c: inflated ceiled');
});

test('23 + 26: xExit uses k_stable; R>R_crit wall after exit', () => {
  const xExit = computeXExitFromKStable(R, clampKStable(K), LBASE);
  assert.ok(Math.abs(xExit - (1 + 2 * Math.sqrt(2 * R * K / LBASE))) < 1e-9);
  assert.ok(xExit > 1 && xExit < 1 + R, 'exit sits left of the wall x=1+R');
});

test('27–28: rateWall reachability → context_cap fallback', () => {
  const lCap = 960000;
  const reachable = computeRateWall({ B_post: LBASE, B_rebuild: LBASE, cRatio: R, lCap }); // wall at 605k < 960k
  assert.equal(reachable.reachableBeforeContextCap, true);
  assert.equal(reachable.reasonIfNotReachable, null);
  const big = computeRateWall({ B_post: LBASE, B_rebuild: LBASE, cRatio: 50, lCap: 128000 }); // wall 2.8M > cap
  assert.equal(big.reachableBeforeContextCap, false);
  assert.equal(big.reasonIfNotReachable, 'context_cap');
});

test('computeRateLampInstant reliable bundle carries the §4.1 fields', () => {
  const inst = computeRateLampInstant(
    { L_read: 260000, lBase: LBASE, lDead: 0.25 * LBASE, cRatio: R, lCap: 960000,
      kStable: K, kStableReliable: true, baselineValid: true },
    { scenario: 'fullCarry' });
  assert.equal(inst.reliable, true);
  for (const f of ['basis','L_read','L_cap','B_post','B_rebuild','C_RATIO','x_display','burnRate',
                   'hBreak','xExit','L_exit_fullCarry','inDeepWater','rateWall']) {
    assert.ok(f in inst, `field ${f} present`);
  }
  assert.equal(inst.basis, 'fullCarry');
  assert.equal(inst.inDeepWater, inst.L_read >= inst.L_exit_fullCarry);
});

test('22d: kStable missing → reliable=false, insufficient_data (no kAvg/kFit fallback)', () => {
  const inst = computeRateLampInstant(
    { L_read: 260000, lBase: LBASE, lDead: 0.25 * LBASE, cRatio: R, lCap: 960000,
      kStable: null, kStableReliable: false, baselineValid: true },
    { scenario: 'fullCarry' });
  assert.equal(inst.reliable, false);
  assert.equal(inst.unavailableReason, 'insufficient_data');
});
