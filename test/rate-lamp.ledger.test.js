import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshLedger, stateKeyOf, applyFoldedCallSample, settleBatchAtBoundary,
  saveRateLampState, loadRateLampState } from '../lib/rate-lamp-store.js';
import { validateLedgerState } from '../lib/ledger-schema.js'; // R5 GPT#3: assert paused-state re-validates
import { initStore, closeStoreGlobal } from '../lib/store.js';

let _storeDir;
beforeEach(() => {
  _storeDir = mkdtempSync(join(tmpdir(), 'sw-rl-ledger-'));
  initStore(join(_storeDir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(_storeDir, { recursive: true, force: true });
});

const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'd30000|t25000|k6|T', contextCap: 1000000, schemaVersion: 1 });
// sample helper — field is L_read (effectiveL), NEVER cacheRead (Task 2.5 locked contract).
const rs = (seq, burnRate, L_read, turnSeq = 1) => ({ seq, reliable: true, burnRate, L_read, turnSeq });

test('5: trapezoidal integration billProgress += ½(prev+now), not rectangular', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000, 3)); // first frame: anchor only, no integration (turnSeq=3)
  assert.equal(s.billProgress, 0);
  assert.equal(s.billAnchorTurnSeq, 3, 'R5 GPT#7: first-frame anchor sets billAnchorTurnSeq alongside L/foldedSeq');
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000, 3));
  assert.ok(Math.abs(s.billProgress - 0.5 * (0.2 + 0.4)) < 1e-9, 'trapezoid ½(0.2+0.4)=0.3');
});

test('6: first frame after fresh anchors lastBurnRate + all three anchor fields, integrates nothing (no rectangular head)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.9, 5000, 2));
  assert.equal(s.billProgress, 0, 'a lone first frame never integrates (rectangular head would give 0.9)');
  assert.equal(s.lastBurnRate, 0.9, 'first frame re-anchors lastBurnRate');
  assert.equal(s.billAnchorLRead, 5000);
  assert.equal(s.billAnchorFoldedCallSeq, 1);
  assert.equal(s.billAnchorTurnSeq, 2);
  assert.equal(s.lastAppliedFoldedCallSeq, 1);
});

test('7 + 9: billProgress ≥ 1 settles and −=1 keeping remainder (not reset to 0)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1.2, 1000));
  s = applyFoldedCallSample(s, rs(2, 1.2, 2000)); // ½(1.2+1.2)=1.2 → cross once, remainder ≈0.2
  assert.equal(s.pendingBillCountSinceBoundary, 1);
  // floor-on-store (#1/#2 fix): 1.2-1 = 0.19999999999999996 → floor(·1e6)/1e6 = 0.199999 (≤1e-6 low).
  assert.equal(s.billProgress, 0.199999, 'remainder kept (floored, not zeroed)');
});

test('8: one turn with N calls crossing >1 settles multiple times', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 2.0, 1000, 5));
  s = applyFoldedCallSample(s, rs(2, 2.0, 2000, 5)); // trapezoid 2.0 → 2 crossings
  assert.equal(s.pendingBillCountSinceBoundary, 2);
});

test('10/11: billCycleCount is a LIFETIME counter — survives a boundary settle while pendingSinceBoundary resets', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 2.0, 1000)); // anchor at L_read=1000
  s = applyFoldedCallSample(s, rs(2, 2.0, 2000)); // trap 2.0 → 2 crossings
  assert.equal(s.billCycleCount, 2);
  assert.equal(s.pendingBillCountSinceBoundary, 2);
  // settle at a boundary: pendingSinceBoundary resets to 0, billCycleCount is untouched (lifetime).
  const settled = settleBatchAtBoundary({ ...s }, { L_readNow: 50000, kStable: 940, inDeepWater: false });
  assert.equal(settled.state.pendingBillCountSinceBoundary, 0, 'boundary settle clears the since-boundary counter');
  assert.equal(settled.state.billCycleCount, 2, 'lifetime billCycleCount is not cleared by a settle');
  // resume integrating on the settled state → billCycleCount keeps climbing, pending restarts from 0.
  let s2 = applyFoldedCallSample(settled.state, rs(3, 2.0, 60000)); // trap ½(2.0+2.0)=2.0 → 2 more
  assert.equal(s2.billCycleCount, 4, 'lifetime counter accumulated across the boundary');
  assert.equal(s2.pendingBillCountSinceBoundary, 2, 'since-boundary counter restarted after the settle');
});

test('45: duplicate foldedCallSeq (seq ≤ lastApplied) → no-op', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000));
  const snap = { ...s };
  const replayed = applyFoldedCallSample(s, rs(2, 0.4, 2000)); // same seq again
  assert.deepEqual(replayed, snap, 'idempotent no-op on replayed seq');
});

test('46: foldedCallSeq gap → pause(folded_seq_gap), no cross-gap integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, rs(3, 0.9, 5000)); // gap (expected 2)
  assert.equal(s.pausedReason, 'folded_seq_gap');
  assert.equal(s.billProgress, 0, 'did not integrate across the gap');
});

test('47: reliable recovery first frame re-anchors only, no catch-up integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'metrics_unreliable', turnSeq: 1 }); // round-2: unreliable sample carries turnSeq (schema requires it)
  assert.equal(s.pausedReason, 'metrics_unreliable');
  const before = s.billProgress;
  s = applyFoldedCallSample(s, rs(3, 0.8, 4000)); // recovery: re-anchor, no integrate
  assert.equal(s.billProgress, before, 'recovery frame only re-anchors lastBurnRate');
  s = applyFoldedCallSample(s, rs(4, 0.8, 5000)); // now integrates
  assert.ok(s.billProgress > before);
});

test('48: batch ΔL is measured over the WHOLE batch from billAnchorLRead, not the last call only', () => {
  let s = freshLedger(KEY);
  s.billAnchorLRead = 10000;
  s.pendingBillCountSinceBoundary = 3;
  // even though the last call sat at 10500 (ΔL=500 < k), the batch window is anchor→now = 12000-10000
  const busy = settleBatchAtBoundary({ ...s }, { L_readNow: 12000, kStable: 940, inDeepWater: true });
  assert.equal(busy.bill.deltaL, 2000, 'ΔL spans the whole batch (12000-10000), not just the tail call');
  assert.equal(busy.bill.kind, 'non_idle_burn', '2000 ≥ 940 → non_idle over the batch window');
  assert.equal(busy.bill.billCount, 3, 'one message carries the full batch billCount');
});

test('49: −=1 applies round(billProgress, 6) (no long-tail float drift)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1/3, 1000));
  s = applyFoldedCallSample(s, rs(2, 1/3 + 2, 2000)); // force a crossing with irrational-ish sum
  assert.equal(s.billProgress, Math.round(s.billProgress * 1e6) / 1e6);
});

test('R5 GPT#2: billProgress landing at 0.9999996 must NOT round up to a premature bill', () => {
  // The OLD code did round6(billProgress + trap) BEFORE the `>= 1` test. 0.9999996·1e6 = 999999.6 → rounds
  // to 1000000 → 1.0, so a value genuinely BELOW 1 fired a bill one call early. Construct exactly that value.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.9999992, 1000)); // anchor: lastBurnRate = 0.9999992, no integration
  s = applyFoldedCallSample(s, rs(2, 1.0, 2000));       // trap = ½(0.9999992 + 1.0) = 0.9999996
  assert.equal(s.pendingBillCountSinceBoundary, 0, 'no premature bill: 0.9999996 < 1, must not be rounded up first');
  assert.ok(s.billProgress < 1 && s.billProgress > 0.9999, 'remainder retained un-rounded-up');
});

test('R5 GPT#2: a genuine crossing still settles exactly one bill (regression guard)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1.0, 1000));
  s = applyFoldedCallSample(s, rs(2, 1.4, 2000)); // trap = ½(1.0+1.4) = 1.2 → next 1.2 ≥ 1 → one bill, rem ≈0.2
  assert.equal(s.pendingBillCountSinceBoundary, 1);
  assert.equal(s.billProgress, 0.199999, 'remainder ≈0.2, floored on store (#1/#2 fix)');
});

// --- #1/#2 (fix wave): a remainder in [0.9999995,1) must not up-round INSIDE the settle loop ---

test('#1/#2: remainder 0.9999996 settles EXACTLY one bill (round6 inside the loop double-billed)', () => {
  // REPRO: prior remainder 0.7, both burn rates 1.2999996 → trap = ½(1.2999996+1.2999996) = 1.2999996,
  // next = 0.7 + 1.2999996 = 1.9999996. Pre-fix `next = round6(next - 1)` rounds 0.9999996 → 1.0, so the
  // while-loop iterates a SECOND time (phantom bill) and lands at remainder 0. Floor-on-store subtracts on
  // the unrounded running value and stores floor(0.9999996) = 0.999999 (< 1) — exactly one bill.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0, 1000, 4));   // anchor: lastBurnRate=0, no integration
  s.billProgress = 0.7;                               // force the exact boundary state
  s.lastBurnRate = 1.2999996;
  const beforePending = s.pendingBillCountSinceBoundary;
  const beforeCycles = s.billCycleCount;
  s = applyFoldedCallSample(s, rs(2, 1.2999996, 1100, 4)); // trap 1.2999996 → next 1.9999996
  assert.equal(s.pendingBillCountSinceBoundary - beforePending, 1, 'EXACTLY one bill (1.9999996 crosses 1 once)');
  assert.equal(s.billCycleCount - beforeCycles, 1, 'lifetime billCycleCount advances by exactly one');
  assert.equal(s.billProgress, 0.999999, 'floored remainder: floor(0.9999996·1e6)=999999 → 0.999999');
  assert.ok(s.billProgress < 1, 'stored remainder is < 1 by construction (floor never rounds up)');
});

test('#1/#2: currentTurnDeltaW 1.9999996 stays < DW_TURN_BACKSTOP (round6 inflated it to 2.0)', () => {
  // ΔW backstop fires at dwTurn >= 2 (stop-message.js). Pre-fix `round6(currentTurnDeltaW + trap)` rounds
  // 1.9999996 → 2.0, tripping dw_backstop one call early. Floor stores 1.999999, below the threshold.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0, 1000, 7));   // anchor at turn 7
  s.lastBurnRate = 1.2999996;
  s.currentTurnDeltaW = 0.7;                          // prior in-turn ΔW; same turn ⇒ not reset
  s = applyFoldedCallSample(s, rs(2, 1.2999996, 1100, 7)); // trap 1.2999996 → 0.7 + 1.2999996 = 1.9999996
  assert.equal(s.currentTurnDeltaW, 1.999999, 'floored ΔW: floor(1.9999996·1e6)=1999999 → 1.999999');
  assert.ok(s.currentTurnDeltaW < 2, 'stays below DW_TURN_BACKSTOP=2 — no false dw_backstop one call early');
});

test('15/16 + 48: batch settle routes empty_burn vs non_idle_burn by ΔL_window over the whole batch', () => {
  let s = freshLedger(KEY);
  s.billAnchorLRead = 100000;
  s.pendingBillCountSinceBoundary = 2;
  const empty = settleBatchAtBoundary({ ...s }, { L_readNow: 100300, kStable: 940, inDeepWater: true });
  assert.equal(empty.bill.kind, 'empty_burn');       // ΔL=300 < 940
  assert.equal(empty.bill.delivery, 'stop_hook');
  assert.equal(empty.bill.billCount, 2, 'one message with billCount, not two');
  const busy = settleBatchAtBoundary({ ...s }, { L_readNow: 105000, kStable: 940, inDeepWater: true });
  assert.equal(busy.bill.kind, 'non_idle_burn');     // ΔL=5000 ≥ 940
  assert.equal(busy.bill.delivery, 'statusline_pulse');
});

test('25: empty_burn suppressed outside deep water (x<xExit) unless ΔW backstop', () => {
  let s = freshLedger(KEY);
  s.billAnchorLRead = 100000; s.pendingBillCountSinceBoundary = 1;
  const shallow = settleBatchAtBoundary({ ...s }, { L_readNow: 100100, kStable: 940, inDeepWater: false });
  assert.notEqual(shallow.bill.delivery, 'stop_hook', 'shallow water: empty_burn does not hook');
});

test('40: settle with no pending bills → null bill, anchor untouched (nothing to settle)', () => {
  let s = freshLedger(KEY);
  s.billAnchorLRead = 77000; // pendingBillCountSinceBoundary stays 0
  const r = settleBatchAtBoundary({ ...s }, { L_readNow: 90000, kStable: 940, inDeepWater: true });
  assert.equal(r.bill, null, 'no pending bills → no message');
  assert.equal(r.state.billAnchorLRead, 77000, 'anchor is not moved when there is nothing to settle');
});

test('41/42: L_read negative jump → pause(cache_unstable), no empty_burn hook, no rollback', () => {
  let s = freshLedger(KEY);
  s.billAnchorLRead = 100000; s.pendingBillCountSinceBoundary = 1;
  s.billProgress = 0.4;
  const neg = settleBatchAtBoundary({ ...s }, { L_readNow: 60000, kStable: 940, inDeepWater: true });
  assert.equal(neg.state.pausedReason, 'cache_unstable');
  assert.notEqual(neg.bill?.delivery, 'stop_hook', 'negative ΔL must NOT fire empty_burn');
  assert.ok(neg.state.billProgress >= 0.4, 'billProgress does not roll backward');
  assert.equal(neg.state.cacheExpiryCount, 1);
  assert.equal(neg.bill.degraded, 'cache_unstable', 'a degraded bill is emitted, tagged cache_unstable');
});

test('43: settle re-anchors ALL THREE anchor fields (L_read + foldedSeq + turnSeq) once per batch', () => {
  let s = freshLedger(KEY);
  s.billAnchorLRead = 100000; s.billAnchorFoldedCallSeq = 5; s.billAnchorTurnSeq = 2;
  s.pendingBillCountSinceBoundary = 1;
  const r = settleBatchAtBoundary({ ...s }, { L_readNow: 108000, kStable: 940, inDeepWater: false, foldedSeqNow: 20, turnSeqNow: 8 });
  assert.equal(r.state.billAnchorLRead, 108000, 'anchor L_read moves to now');
  assert.equal(r.state.billAnchorFoldedCallSeq, 20, 'anchor foldedSeq moves with L_read (round-2 GPT#12)');
  assert.equal(r.state.billAnchorTurnSeq, 8, 'anchor turnSeq moves with L_read (round-2 GPT#12)');
  assert.equal(r.state.pendingBillCountSinceBoundary, 0);
});

// --- Review-added regression tests (GPT#1 miss-row, A1 multi-call poll, A2/A3) ---

test('REVIEW A1: N samples in one batch integrate per-call (not one lump), no gap', () => {
  let s = freshLedger(KEY);
  // simulate a poll that ingested 4 new calls: feed 4 samples seq 1..4 in order
  for (let i = 1; i <= 4; i++) s = applyFoldedCallSample(s, rs(i, 0.3, 1000 * i, 1));
  assert.equal(s.pausedReason, null, 'no folded_seq_gap when fed per-call');
  assert.equal(s.lastAppliedFoldedCallSeq, 4);
  assert.ok(s.billProgress > 0, 'integrated the middle calls, did not first-frame-drop them');
});

test('REVIEW A2: unreliable sample ADVANCES seq so recovery is not a spurious gap', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'metrics_unreliable', turnSeq: 1 });
  assert.equal(s.lastAppliedFoldedCallSeq, 2, 'unreliable sample advanced the seq cursor');
  s = applyFoldedCallSample(s, rs(3, 0.8, 4000)); // seq 3 = lastApplied+1 → recovery re-anchor, NOT gap
  assert.equal(s.pausedReason, null, 'clean recovery, no folded_seq_gap');
});

test('REVIEW A2: an unreliable sample freezes lastBurnRate → null AND carries its unavailableReason through', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.5, 1000));
  assert.equal(s.lastBurnRate, 0.5);
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'invalid_baseline', turnSeq: 1 });
  assert.equal(s.lastBurnRate, null, 'lastBurnRate zeroed to force a clean re-anchor on recovery (P0-5)');
  assert.equal(s.pausedReason, 'invalid_baseline', 'the specific unavailableReason is preserved (schema allows it)');
  assert.ok(validateLedgerState(s), 'an unreliable-drain paused state still re-validates (schema PAUSE_REASONS covers invalid_baseline)');
});

test('REVIEW A3: currentTurnDeltaW resets per turn (ΔW backstop does not accumulate across turns)', () => {
  let s = freshLedger(KEY);
  // turn 1: two calls, ΔW≈1.1
  s = applyFoldedCallSample(s, rs(1, 0.5, 1000, 1));
  s = applyFoldedCallSample(s, rs(2, 1.7, 2000, 1)); // trap 1.1
  const dwTurn1 = s.currentTurnDeltaW;
  assert.ok(Math.abs(dwTurn1 - 1.1) < 1e-6);
  // turn 2: anchor at turn boundary, then a call — currentTurnDeltaW must have reset, not carried 1.1
  s = applyFoldedCallSample(s, rs(3, 0.1, 3000, 2));
  assert.ok(s.currentTurnDeltaW < 1.1, 'turn 2 ΔW started from 0, did not carry turn 1');
});

test('REVIEW GPT#1: miss row (raw cacheRead drops, effectiveL rises) uses L_read → no cache_unstable', () => {
  // The ledger only ever sees L_read (effectiveL). A miss row has HIGHER L_read than the prior anchor,
  // so ΔL_window is POSITIVE — it must NOT be mistaken for a cache-expiry negative jump.
  let s = freshLedger(KEY);
  s.billAnchorLRead = 200000; s.pendingBillCountSinceBoundary = 1;
  // miss row: raw cacheRead would be ~0 but effectiveL = cacheRead+cacheCreation = 260000 (rises)
  const bill = settleBatchAtBoundary({ ...s }, { L_readNow: 260000, kStable: 940, inDeepWater: true });
  assert.notEqual(bill.state.pausedReason, 'cache_unstable', 'miss row is NOT a negative jump when read via L_read');
  assert.equal(bill.bill.kind, 'non_idle_burn'); // ΔL=60000 ≥ 940
});

test('R2-9: an already-applied seq reappearing with a CHANGED L_read → pause(folded_call_mutated)', () => {
  // R5 GPT#4: this is a REDUCER-ONLY defense. It fires only when a same-seq sample is re-fed directly; the
  // live manager (rateLampSamplesSince) only ever emits foldedSeq>sinceSeq, so this branch is unreachable
  // from the manager path by design — no manager-level same-seq re-check is added (see R2-9/F-7 notes).
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000)); // seq 2 applied at L_read=2000
  const mutated = applyFoldedCallSample(s, rs(2, 0.4, 9999)); // same seq, DIFFERENT L_read
  assert.equal(mutated.pausedReason, 'folded_call_mutated', 'in-place mutation of an integrated call is not silently swallowed');
  const same = applyFoldedCallSample(s, rs(2, 0.4, 2000)); // same seq, SAME L_read → idempotent no-op
  assert.equal(same.pausedReason, null);
});

test('R2-11: a malformed (cacheRead-named) sample → pause(invalid_sample), no integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  const bad = applyFoldedCallSample(s, { seq: 2, reliable: true, burnRate: 0.4, cacheRead: 2000, turnSeq: 1 });
  assert.equal(bad.pausedReason, 'invalid_sample');
  assert.equal(bad.billProgress, 0, 'did not integrate a sample that failed the schema guard');
});

test('final-review GPT#5 + R5 GPT#3: a CORRUPT prev → pause(invalid_sample) AND the returned state itself re-validates', () => {
  const corrupt = { ...freshLedger(KEY, 940), billProgress: 1.2 }; // out of [0,1)
  const r1 = applyFoldedCallSample(corrupt, rs(5, 0.4, 2000));
  assert.equal(r1.pausedReason, 'invalid_sample', 'reducer validates prev, does not integrate onto a corrupt ledger');
  assert.ok(validateLedgerState(r1), 'R5 GPT#3: the returned paused state is NOT still corrupt (no wedged-in-memory paused ledger)');
  assert.equal(r1.stateKey, KEY, 'preserves the reusable stateKey');
  const r2 = settleBatchAtBoundary({ ...corrupt, pendingBillCountSinceBoundary: 1 }, { L_readNow: 5000, kStable: 940, inDeepWater: true });
  assert.equal(r2.bill, null, 'settle refuses a corrupt ledger');
  assert.equal(r2.state.pausedReason, 'invalid_sample');
  assert.ok(validateLedgerState(r2.state), 'R5 GPT#3: settle also returns a re-validating paused state');
});

test('35: stateKeyOf is sensitive to model, cRatio and contextCap (all baseline-scope fields reset the ledger)', () => {
  const base = { segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'A', contextCap: 1e6, schemaVersion: 1 };
  const k0 = stateKeyOf(base);
  assert.notEqual(k0, stateKeyOf({ ...base, model: 'sonnet' }), 'model change → new key');
  assert.notEqual(k0, stateKeyOf({ ...base, cRatio: 5 }), 'cRatio change → new key');
  assert.notEqual(k0, stateKeyOf({ ...base, contextCap: 200000 }), 'contextCap change → new key');
  assert.notEqual(k0, stateKeyOf({ ...base, segmentId: 1 }), 'segmentId change → new key');
  assert.equal(k0, stateKeyOf({ ...base }), 'same inputs → same key (deterministic, order-stable)');
});

test('36/37: state key change resets; xExit is NOT in the key', () => {
  const k1 = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'A', contextCap: 1e6, schemaVersion: 1 });
  const k2 = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'B', contextCap: 1e6, schemaVersion: 1 });
  assert.notEqual(k1, k2, 'baselineFingerprint change → different key → reset');
  // xExit is not a parameter of stateKeyOf at all — cannot influence the key.
  assert.ok(!/xExit/i.test(stateKeyOf.toString()));
});

test('GPT#11: freshLedger freezes kStableFrozen at creation (segment constant, reused on same-key restart)', () => {
  const s = freshLedger(KEY, 940);
  assert.equal(s.kStableFrozen, 940, 'k_stable frozen into the ledger at creation');
  assert.equal(freshLedger(KEY).kStableFrozen, 0, 'default frozen k_stable is 0 (benign degradation)');
});

test('50: single ledger — deadOnly is counterfactual only (store has no deadOnly ledger)', () => {
  // stateKeyOf/freshLedger/applyFoldedCallSample take no scenario param → structurally single-ledger.
  const s = freshLedger(KEY);
  assert.equal(s.billingBasis, 'fullCarry');
  assert.equal('deadOnlyBillProgress' in s, false);
});

test('GPT#12: persistence round-trips a valid ledger and a corrupt/foreign entry loads as null (silent fresh)', () => {
  // store is already initialized by beforeEach — just use it directly
  const s = freshLedger(KEY, 940);
  saveRateLampState('sess-A', s);
  assert.deepEqual(loadRateLampState('sess-A'), s, 'a valid saved ledger round-trips through validateLedgerState');
  // a value that fails the schema (validateLedgerState → null) must load as null, never crash.
  saveRateLampState('sess-B', { not: 'a ledger' });
  assert.equal(loadRateLampState('sess-B'), null, 'a schema-invalid entry loads as null (treated as no saved state)');
  // a never-written session loads as null too (getStore().load returns null → catch → null).
  assert.equal(loadRateLampState('sess-missing'), null, 'no entry → null, no throw');
});
