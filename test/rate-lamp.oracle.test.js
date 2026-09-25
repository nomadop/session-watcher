import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLedger, stateKeyOf, applyFoldedCallSample, drainFrame } from '../lib/rate-lamp-store.js';
import { walletIntervalFor, BR_AMBER } from '../lib/bill-regret.js';

const KEY = stateKeyOf({ segmentId: 0, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
const rs = (seq, deltaW, mf = 0.3, turnSeq = 1) => ({ seq, reliable: true, deltaW, mf, L_read: 1000 * seq, turnSeq });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('fast clock: deltaW accumulates, each unit crossed settles one cycle, the remainder is stored as computed', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.5));
  near(s.billProgress, 0.5); assert.equal(s.billCycleCount, 0);
  s = applyFoldedCallSample(s, rs(2, 0.7));
  near(s.billProgress, 0.2); assert.equal(s.billCycleCount, 1);
  s = applyFoldedCallSample(s, rs(3, 2.3));
  near(s.billProgress, 0.5); assert.equal(s.billCycleCount, 3);
});

test('both remainders are stored as computed, not quantized', () => {
  const s = applyFoldedCallSample(freshLedger(KEY), rs(1, 1 / 3, 0.4));
  assert.equal(s.billProgress, 1 / 3);
  assert.equal(s.walletPhase, (1 / 3) / walletIntervalFor(0.4, BR_AMBER));
});

test('the ledger after a sample depends on deltaW and mf only', () => {
  const a = applyFoldedCallSample(freshLedger(KEY), { seq: 1, reliable: true, turnSeq: 1, L_read: 1000, deltaW: 0.4, mf: 0.3 });
  const b = applyFoldedCallSample(freshLedger(KEY), { seq: 1, reliable: true, turnSeq: 1, L_read: 900000, deltaW: 0.4, mf: 0.3 });
  assert.deepEqual(a, b);
});

test('wallet clock: walletPhase advances by deltaW / walletIntervalFor(mf) and rolls into walletLapCount', () => {
  const mf = 0.4, interval = walletIntervalFor(mf, BR_AMBER);
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, interval / 2, mf));
  near(s.walletPhase, 0.5); assert.equal(s.walletLapCount, 0);
  s = applyFoldedCallSample(s, rs(2, interval * 1.75, mf));
  near(s.walletPhase, 0.25); assert.equal(s.walletLapCount, 2);
});

test('the wallet clock does not advance when mf is not finite and positive; the fast clock still does', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.4, null));
  near(s.billProgress, 0.4); assert.equal(s.walletPhase, 0); assert.equal(s.walletLapCount, 0);
  s = applyFoldedCallSample(s, rs(2, 0.4, 0));
  assert.equal(s.walletPhase, 0);
});

test('a null deltaW advances the cursor and integrates nothing; an integrating sample clears pausedReason', () => {
  let s = { ...freshLedger(KEY), pausedReason: 'insufficient_data' };
  s = applyFoldedCallSample(s, rs(1, null, null));
  assert.equal(s.lastAppliedFoldedCallSeq, 1); assert.equal(s.billProgress, 0);
  assert.equal(s.pausedReason, 'insufficient_data');
  s = applyFoldedCallSample(s, rs(2, 0.3));
  assert.equal(s.pausedReason, null); near(s.billProgress, 0.3);
});

test('idempotence and gap: a repeated seq is a no-op, a gap pauses and integrates nothing', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.3));
  const again = applyFoldedCallSample(s, rs(1, 0.9));
  assert.deepEqual(again, s);
  s = applyFoldedCallSample(s, rs(5, 0.9));
  assert.equal(s.pausedReason, 'folded_seq_gap'); assert.equal(s.lastAppliedFoldedCallSeq, 5); near(s.billProgress, 0.3);
});

test('an unreliable sample advances the cursor, pauses with its reason and keeps both integrals', () => {
  let s = applyFoldedCallSample(freshLedger(KEY), rs(1, 0.3));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, turnSeq: 1, L_read: 0, unavailableReason: 'insufficient_data' });
  assert.equal(s.pausedReason, 'insufficient_data'); assert.equal(s.lastAppliedFoldedCallSeq, 2); near(s.billProgress, 0.3);
});

test('both remainders stay in [0, 1) and lap + phase never decreases over a long random drive', () => {
  let s = freshLedger(KEY), prevWallet = 0;
  for (let seq = 1; seq <= 500; seq++) {
    const mf = 0.2 + (seq % 7) * 0.03;
    s = applyFoldedCallSample(s, rs(seq, (seq * 37 % 101) / 40, mf));
    assert.ok(s.billProgress >= 0 && s.billProgress < 1);
    assert.ok(s.walletPhase >= 0 && s.walletPhase < 1);
    assert.ok(s.walletLapCount + s.walletPhase >= prevWallet);
    prevWallet = s.walletLapCount + s.walletPhase;
  }
});

test('drainFrame: one event per rollover, two rollovers in one sample give two laps and one event with the final count', () => {
  const mf = 0.4, interval = walletIntervalFor(mf, BR_AMBER);
  const ledger = freshLedger(KEY);
  drainFrame(ledger, { turnSeq: 1, samples: [rs(1, interval * 0.5, mf), rs(2, interval * 2.1, mf)] });
  assert.equal(ledger.walletLapCount, 2);
  assert.equal(ledger.lastStopEvent.kind, 'backstop');
  assert.equal(ledger.lastStopEvent.billCount, 2);
  assert.equal(ledger.lastStopEvent.seq, 2);
  assert.equal(ledger.recentStopEvents.length, 1);
  assert.match(ledger.lastStopEvent.message, /Carry rent reminder 2:/);
  assert.equal(ledger.currentTurnSeq, 1);
});

test('drainFrame: a human turn boundary clears only an event present before the frame', () => {
  const mf = 0.4, interval = walletIntervalFor(mf, BR_AMBER);
  const ledger = freshLedger(KEY);
  drainFrame(ledger, { turnSeq: 1, samples: [rs(1, interval * 1.2, mf, 1)] });
  assert.ok(ledger.lastStopEvent);
  drainFrame(ledger, { turnSeq: 2, samples: [rs(2, 0.01, mf, 2)] });
  assert.equal(ledger.lastStopEvent, null, 'the pre-existing event was seen and cleared');
  drainFrame(ledger, { turnSeq: 3, samples: [rs(3, interval * 1.2, mf, 3), rs(4, 0.01, mf, 4)] });
  assert.ok(ledger.lastStopEvent, 'an event fired inside this frame survives a later sample of the same frame');
  assert.equal(ledger.currentTurnSeq, 3);
});
