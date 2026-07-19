// test/rate-lamp.oracle.test.js — per-call reducer golden path (validates applyFoldedCallSample)
// Ensures the reducer's metronome + cycle counting remains byte-identical after Change A.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLedger, stateKeyOf, applyFoldedCallSample } from '../lib/rate-lamp-store.js';

const KEY = stateKeyOf({ segmentId: 0, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
const rs = (seq, br, L, turnSeq = 1) => ({ seq, reliable: true, burnRate: br, L_read: L, turnSeq });

test('golden: per-call reducer billProgress/billCycleCount matches hand-computed trapezoid', () => {
  let s = freshLedger(KEY, 500);
  // First call re-anchors (recovering: lastBurnRate null)
  s = applyFoldedCallSample(s, rs(1, 0.4, 1000));
  assert.equal(s.billCycleCount, 0, 'first call re-anchors only');
  assert.equal(s.lastBurnRate, 0.4);
  // Second call: trap = 0.5*(0.4+0.6) = 0.5 → billProgress = 0.5
  s = applyFoldedCallSample(s, rs(2, 0.6, 2000));
  assert.ok(Math.abs(s.billProgress - 0.5) < 1e-5, `billProgress=0.5, got ${s.billProgress}`);
  assert.equal(s.billCycleCount, 0);
  // Third call: trap = 0.5*(0.6+0.8) = 0.7 → 0.5+0.7 = 1.2 → crosses → billProgress ≈ 0.2, cycle=1
  s = applyFoldedCallSample(s, rs(3, 0.8, 3000));
  assert.ok(Math.abs(s.billProgress - 0.2) < 1e-5, `billProgress≈0.2, got ${s.billProgress}`);
  assert.equal(s.billCycleCount, 1);
});

test('golden: high burn rate (trap > 2) crosses multiple cycles per call', () => {
  let s = freshLedger(KEY, 500);
  s = applyFoldedCallSample(s, rs(1, 5.0, 1000)); // re-anchor
  // trap = 0.5*(5.0+5.0) = 5.0 → 5 crossings
  s = applyFoldedCallSample(s, rs(2, 5.0, 2000));
  assert.equal(s.billCycleCount, 5, '5 cycles from trap=5.0');
  assert.ok(s.billProgress < 1);
});

test('golden: idempotency — same seq is no-op', () => {
  let s = freshLedger(KEY, 500);
  s = applyFoldedCallSample(s, rs(1, 0.4, 1000));
  const before = { ...s };
  s = applyFoldedCallSample(s, rs(1, 0.4, 1000));
  assert.equal(s.billCycleCount, before.billCycleCount);
  assert.equal(s.billProgress, before.billProgress);
});

test('golden: seq gap pauses', () => {
  let s = freshLedger(KEY, 500);
  s = applyFoldedCallSample(s, rs(1, 0.4, 1000));
  s = applyFoldedCallSample(s, rs(3, 0.4, 1000)); // gap: 1→3
  assert.equal(s.pausedReason, 'folded_seq_gap');
});
