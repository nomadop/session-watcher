import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineFingerprint, makeLatchEntry } from '../lib/latch.js';

test('baselineFingerprint is a pure deterministic function of dead/taskCtx/kneeTurn', () => {
  const a = { dead: 30000, taskCtx: 25000, kneeTurn: 6, latchIndex: 6, latchCallId: 'x', segmentStartCallId: 's' };
  const b = { dead: 30000, taskCtx: 25000, kneeTurn: 6, latchIndex: 9, latchCallId: 'y', segmentStartCallId: 's' };
  assert.equal(baselineFingerprint(a), baselineFingerprint(b),
    'same baseline inputs → same fingerprint (latchIndex/callId do NOT affect it)');
});

test('baselineFingerprint changes when kneeTurn-only changes (it is the kAvg denominator → gate x*)', () => {
  const base = { dead: 30000, taskCtx: 25000, kneeTurn: 6 };
  const kneeMoved = { dead: 30000, taskCtx: 25000, kneeTurn: 7 };
  assert.notEqual(baselineFingerprint(base), baselineFingerprint(kneeMoved));
});

test('baselineFingerprint(null) → null (not latched → ledger paused)', () => {
  assert.equal(baselineFingerprint(null), null);
});

test('baselineFingerprint distinguishes dead and taskCtx (no field collision)', () => {
  const x = { dead: 100, taskCtx: 200, kneeTurn: 3 };
  const y = { dead: 200, taskCtx: 100, kneeTurn: 3 };
  assert.notEqual(baselineFingerprint(x), baselineFingerprint(y),
    'swapping dead/taskCtx must not collide');
});
