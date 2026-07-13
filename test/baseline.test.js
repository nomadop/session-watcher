// test/baseline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKnee } from '../lib/baseline.js';

// Warmup: steep loading for 6 rounds, then a stable ~940/round climb.
function syntheticSeq() {
  const seq = [42000]; // dead bottom (cold start)
  const warmupDeltas = [9000, 8000, 7000, 3000, 1500, 900]; // ~6 rounds loading
  for (const d of warmupDeltas) seq.push(seq[seq.length - 1] + d);
  for (let i = 0; i < 40; i++) seq.push(seq[seq.length - 1] + 940); // stable
  return seq;
}

test('detectKnee finds warmup end and measures task ctx', () => {
  const seq = syntheticSeq();
  const { kneeTurn, taskCtx } = detectKnee(seq);
  assert.ok(kneeTurn >= 3 && kneeTurn <= 14, `kneeTurn ${kneeTurn} in warmup range`);
  // task ctx = cacheRead at knee - dead bottom; should be the summed warmup deltas region
  assert.ok(taskCtx > 10000 && taskCtx < 35000, `taskCtx ${taskCtx} plausible`);
});

test('detectKnee never returns knee before KNEE_MIN_TURN', () => {
  const { kneeTurn } = detectKnee([42000, 42100, 42200, 42300, 42400]);
  assert.ok(kneeTurn >= 3);
});

// #12: a knee that sits within the FINAL 2-3 deltas must be detected. Steep loading
// (6000..2000) then it stabilizes at 200/round for the last 3 deltas ONLY. deltas =
// [6000,5000,4000,3000,2000,200,200,200]; back-half median 200 → bg = 1.75*200 = 350.
// The only all-below-bg window starts at t=5 and is a 3-delta TAIL window. Pre-fix the
// scan breaks at t=5 (window < LOOKAHEAD) and returns the early fallback (turn 3).
test('detectKnee finds a knee that sits within the final 2-3 deltas (#12)', () => {
  const dead = 40000;
  const deltas = [6000, 5000, 4000, 3000, 2000, 200, 200, 200];
  const seq = [dead];
  for (const d of deltas) seq.push(seq[seq.length - 1] + d);
  const { kneeTurn, taskCtx } = detectKnee(seq);
  assert.equal(kneeTurn, 5, `tail knee at turn 5 (got ${kneeTurn})`);
  assert.equal(taskCtx, seq[5] - dead);
});

// #12 fallback preserved: a sequence with recurring large jumps (no stable region) has
// NO all-below-bg window at ANY position — including the new shorter tail windows — so
// the loop must fall through to the fallback (earliest allowed turn), not fire spuriously.
test('detectKnee falls back to KNEE_MIN_TURN when there is no knee (steep throughout)', () => {
  const dead = 40000;
  const deltas = [10000, 100, 10000, 100, 10000, 100, 10000, 100];
  const seq = [dead];
  for (const d of deltas) seq.push(seq[seq.length - 1] + d);
  const { kneeTurn } = detectKnee(seq);
  assert.equal(kneeTurn, 3, `no-knee → fallback turn 3 (got ${kneeTurn})`);
});

// #12 regression: a knee well BEFORE the tail (full LOOKAHEAD window available) must be
// UNCHANGED by the tail-window edit. deltas = [8000,6000,4000,2000, then 10×800];
// back-half median 800 → bg = 1400. First all-below-bg 4-window starts at t=4.
test('detectKnee leaves a mid-sequence knee unchanged (#12 regression)', () => {
  const dead = 40000;
  const deltas = [8000, 6000, 4000, 2000, 800, 800, 800, 800, 800, 800, 800, 800, 800, 800];
  const seq = [dead];
  for (const d of deltas) seq.push(seq[seq.length - 1] + d);
  const { kneeTurn } = detectKnee(seq);
  assert.equal(kneeTurn, 4, `mid knee at turn 4 (got ${kneeTurn})`);
});

test('detectKnee flags a real knee (window-hit branch) as isRealKnee=true', () => {
  const seq = syntheticSeq(); // warmup then long stable tail → a genuine knee exists
  const { isRealKnee } = detectKnee(seq);
  assert.equal(isRealKnee, true, 'a genuine warmup→stable knee is a real knee');
});

test('detectKnee flags the fallback ladder as isRealKnee=false', () => {
  // OSCILLATING deltas (big/small alternating) → no all-below-bg LOOKAHEAD window → fallback fires.
  // NOTE: CONSTANT deltas do NOT work here — detectKnee's `bg` is self-scaling (1.75 × median delta),
  // so a run of equal deltas puts EVERY delta below bg and the real-knee branch fires (isRealKnee=true).
  // This mirrors the existing passing fallback fixture at baseline.test.js (`[10000,100,10000,100,…]`),
  // which is the proven no-knee shape. (Verified against the current detectKnee.)
  const seq = [1000];
  for (const d of [10000, 100, 10000, 100, 10000, 100]) seq.push(seq[seq.length - 1] + d);
  const { isRealKnee } = detectKnee(seq);
  assert.equal(isRealKnee, false, 'oscillating deltas → no stable window → fallback → isRealKnee false');
});

test('detectKnee returns stableMedian on the real-knee branch (spec §3.4 / A2)', () => {
  const seq = syntheticSeq(); // warmup then ~940/round stable climb
  const r = detectKnee(seq);
  assert.equal(r.isRealKnee, true);
  assert.ok(Number.isFinite(r.stableMedian) && r.stableMedian > 0,
    'stableMedian exposed and positive');
  // it equals kneeBgMult-free median of back-half deltas → in the stable ~940 band
  assert.ok(r.stableMedian > 500 && r.stableMedian < 1500, 'stableMedian tracks the stable delta band');
});

test('detectKnee returns stableMedian on the fallback (no-knee) branch too', () => {
  const steep = [1000, 20000, 45000, 80000]; // never stabilizes → fallback
  const r = detectKnee(steep);
  assert.equal(r.isRealKnee, false);
  assert.ok(Number.isFinite(r.stableMedian) && r.stableMedian > 0,
    'fallback branch also carries a finite stableMedian (never undefined)');
});

test('detectKnee kneeTurn/taskCtx are unchanged by adding the flag (regression)', () => {
  const seq = syntheticSeq();
  const { kneeTurn, taskCtx } = detectKnee(seq);
  assert.ok(kneeTurn >= 3 && kneeTurn <= 14, `kneeTurn ${kneeTurn} unchanged range`);
  assert.ok(taskCtx > 10000 && taskCtx < 35000, `taskCtx ${taskCtx} unchanged range`);
});
