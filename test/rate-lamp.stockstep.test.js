import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStockStep } from '../lib/rate-lamp.js';

test('A4: a total-stock jump ≥ stepMult·kStable is a floor-step', () => {
  const prefix = [{ cacheRead: 100000, cacheCreation: 0 }, { cacheRead: 132000, cacheCreation: 0 }];
  assert.equal(detectStockStep(prefix, 940, { stepMult: 8 }), true);  // Δtotal 32000 ≥ 7520
});
test('A4: a normal step is NOT a floor-step', () => {
  const prefix = [{ cacheRead: 100000, cacheCreation: 0 }, { cacheRead: 100940, cacheCreation: 0 }];
  assert.equal(detectStockStep(prefix, 940, { stepMult: 8 }), false);
});
test('detectStockStep guards short/invalid input', () => {
  assert.equal(detectStockStep([], 940), false);
  assert.equal(detectStockStep([{ cacheRead: 1, cacheCreation: 0 }], 940), false);
  assert.equal(detectStockStep([{}, {}], 0), false);
});
test('round-6 GPT#4: a step EARLIER in a multi-call Stop window is caught even if the final hop is normal', () => {
  // window of 3 calls (foldedSeq 5,6,7): 5→6 is a big step (+32000), 6→7 is normal (+940).
  // Old last-pair-only logic saw only 6→7 → false. Window scan must catch the 5→6 step → true.
  const prefix = [
    { foldedSeq: 4, cacheRead: 100000, cacheCreation: 0 }, // pre-window baseline (anchor at seq 4)
    { foldedSeq: 5, cacheRead: 100000, cacheCreation: 0 },
    { foldedSeq: 6, cacheRead: 132000, cacheCreation: 0 }, // +32000 step mid-window
    { foldedSeq: 7, cacheRead: 132940, cacheCreation: 0 }, // normal final hop
  ];
  assert.equal(detectStockStep(prefix, 940, { stepMult: 8, sinceFoldedSeq: 4 }), true,
    'ANY adjacent step in the window suppresses, not only the last pair');
});
test('round-6 GPT#4: sinceFoldedSeq bounds the window — an OLD step before the anchor does not count', () => {
  const prefix = [
    { foldedSeq: 1, cacheRead: 50000, cacheCreation: 0 },
    { foldedSeq: 2, cacheRead: 90000, cacheCreation: 0 }, // +40000 step, but BEFORE the anchor (seq 5)
    { foldedSeq: 6, cacheRead: 90500, cacheCreation: 0 }, // in-window, normal
    { foldedSeq: 7, cacheRead: 91000, cacheCreation: 0 },
  ];
  assert.equal(detectStockStep(prefix, 940, { stepMult: 8, sinceFoldedSeq: 5 }), false,
    'a step in a PRIOR window (already settled) must not re-suppress this window');
});
test('round-7 GPT#3: no call newer than sinceFoldedSeq → false, never scans all history', () => {
  // sinceFoldedSeq ≥ every foldedSeq → the current Stop window is empty. Must return false, NOT fall
  // through to scanning the whole prefix (which contains a big +40000 step already settled last window).
  const prefix = [
    { foldedSeq: 1, cacheRead: 100000, cacheCreation: 0 },
    { foldedSeq: 2, cacheRead: 140000, cacheCreation: 0 }, // +40000 step, but already before the anchor
  ];
  assert.equal(detectStockStep(prefix, 940, { stepMult: 8, sinceFoldedSeq: 2 }), false,
    'empty window (findIndex→-1) → false, does not re-scan settled history');
});
