import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the ledger checkpoint dir at a temp CLAUDE_PLUGIN_DATA so the disk-touching advance tests below
// (persistLedger / disk-hydrate) never write into the real ~/.session-watcher. pathFor() reads the env
// lazily per-call, so setting it before the tests run is enough.
const TMP = mkdtempSync(join(tmpdir(), 'sw-rl-settle-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { freshLedger, stateKeyOf, applyFoldedCallSample, settleMeterAtBoundary, settleBatchAtBoundary } from '../lib/rate-lamp-store.js';
import { advanceRateLampToCurrent, setLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';

const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 2 });
const rs = (seq, br, L, turnSeq) => ({ seq, reliable: true, burnRate: br, L_read: L, turnSeq });

// ── Reader-loop test seam (the A20 seam): a stub SessionWatcher whose getStatus() computes to KEY so a
// same-key ledger is reused, and whose rateLampSamplesSince returns the injected `samples`. baselineTotal
// (= status.baseline.total, the fullCarry B_rebuild) and kStable feed the F4 boundary inDeepWater + the
// H-pt4 latch. NB: this stub returns `samples` regardless of sinceSeq — for cross-poll (#5) construct a
// FRESH stub per poll with only that poll's (seq-monotone) samples.
function fakeWatcher({ turnSeq, foldedSeq, samples = [], kStable = 940, baselineTotal = 250000,
  model = 'opus', L_read = 300000, L_cap = 1_000_000, segment = 0, fingerprint = 'f' } = {}) {
  return {
    _turnSeq: turnSeq, _foldedCallSeq: foldedSeq,
    poll() { return { changed: false, newCalls: 0 }; },
    getStatus() {
      return { segment, model, baseline: { fingerprint, total: baselineTotal },
        rateLamp: { reliable: true, C_RATIO: 10, L_cap, L_read, B_post: baselineTotal, B_rebuild: baselineTotal, kStable } };
    },
    rateLampSamplesSince() { return samples; },
    rateLampSeqSamplesSince() { return samples; },
  };
}
// The KEY the fakeWatcher's snapshot computes (stateKeyForStatus pins schemaVersion:1 in the KEY string,
// independent of the ledger's schemaVersion:2 field). A live ledger must carry THIS stateKey to be reused.
const WKEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 1 });
// A reused live ledger seeded at a chosen open turn, ready to integrate from seq 0. lastBurnRate:null so the
// first sample re-anchors (billAnchorLRead ← that call's L), matching the real from-now anchor path.
const seedLedger = (currentTurnSeq, kStableFrozen = 940) => ({
  ...freshLedger(WKEY, kStableFrozen), stateKey: WKEY, currentTurnSeq, settledThroughTurnSeq: currentTurnSeq - 1,
  lastAppliedFoldedCallSeq: 0, lastAppliedLRead: null, lastBurnRate: null,
});
const SID = 'sid-settle-summary';
const summaryFor = (ledger, turnSeq) => ledger.settledTurnSummaries.find((s) => s.turnSeq === turnSeq);

test('C1-2: settleMeterAtBoundary appends an immutable summary with deltaW = L_readNow - anchorBefore', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000, 1));
  s = applyFoldedCallSample(s, rs(2, 0.4, 3000, 1));
  const anchorBefore = s.billAnchorLRead;                       // capture BEFORE settle re-anchors
  const { state, summary } = settleMeterAtBoundary(s, { L_readNow: 3000, kStable: 500, foldedSeqNow: 2, turnSeqNow: 2, endedTurnSeq: 1, inDeepWater: false });
  assert.equal(summary.turnSeq, 1);
  assert.equal(summary.deltaW, 3000 - anchorBefore, 'deltaW = L_readNow - anchorBefore (not the re-anchored value)');
  assert.equal(summary.billKindAtBoundary, 'non_idle_burn', 'deltaL 2000 ≥ kStable 500 ⟹ non_idle, snapshotted');
  assert.equal(state.settledTurnSummaries.length, 1);
  assert.equal(state.currentTurnDeltaW, 0, 'currentTurnDeltaW zeroed after settle');
});

test('C1-2: zero-call turn STILL appends a summary (foldedCallSeqStart===End, deltaW===0)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000, 1)); // anchor
  // No new calls in turn 2 — settle the empty turn 2.
  const { state, summary } = settleMeterAtBoundary(s, { L_readNow: 1000, kStable: 500, foldedSeqNow: 1, turnSeqNow: 2, endedTurnSeq: 2, inDeepWater: false });
  assert.equal(summary.turnSeq, 2);
  assert.equal(summary.deltaW, 0);
  assert.equal(summary.foldedCallSeqStart, summary.foldedCallSeqEnd, 'zero-call ⟹ start===end');
  assert.equal(state.settledTurnSummaries.length, 1, 'zero-call turn is NOT skipped (串轮 guard)');
});

test('C1-2/H-pt6: pre-calibration boundary (kStable NaN or ≤0) emits NO alertable kind (billKindAtBoundary null)', () => {
  // Degrade guard: before k_stable calibrates, no boundary may carry an alertable kind. This clears ONLY
  // billKindAtBoundary — the meter anchor advance is unaffected (existing behavior). Consistent with the
  // v1.1 latch / B1 _metricsReliable "unreliable ⟹ degrade" philosophy; also stops an implementer from
  // literally emitting a groundless non_idle from the pseudocode.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000, 1));
  s = applyFoldedCallSample(s, rs(2, 0.4, 9000, 1));            // big deltaL that WOULD be non_idle if calibrated
  const frozen = settleMeterAtBoundary(s, { L_readNow: 9000, kStable: 0, foldedSeqNow: 2, turnSeqNow: 2, endedTurnSeq: 1, inDeepWater: false });
  assert.equal(frozen.summary.billKindAtBoundary, null, 'kStable<=0 ⟹ null kind, no empty_burn/non_idle');
  const nan = settleMeterAtBoundary(s, { L_readNow: 9000, kStable: NaN, foldedSeqNow: 2, turnSeqNow: 2, endedTurnSeq: 1, inDeepWater: false });
  assert.equal(nan.summary.billKindAtBoundary, null, 'kStable NaN ⟹ null kind');
  assert.equal(frozen.state.settledTurnSummaries.length, 1, 'anchor advance / summary append NOT skipped by the guard');
});

test('C1-2: billProgress byte-identical to old settleBatchAtBoundary', () => {
  // RUNNABLE (Global Constraint line 18 gate — must actually assert, not comment-only). Drive the SAME
  // sample sequence through both the new settleMeterAtBoundary and the retained settleBatchAtBoundary.
  const samples = [
    { seq: 1, turnSeq: 1, reliable: true, L_read: 1000, burnRate: 0.4 },
    { seq: 2, turnSeq: 1, reliable: true, L_read: 1800, burnRate: 0.7 },
    { seq: 3, turnSeq: 2, reliable: true, L_read: 3000, burnRate: 0.9 },
  ];
  let a = freshLedger(KEY, 500), b = freshLedger(KEY, 500);
  for (const s of samples) { a = applyFoldedCallSample(a, s); b = applyFoldedCallSample(b, s); }
  const viaNew = settleMeterAtBoundary(a, { L_readNow: 3000, kStable: 500, foldedSeqNow: 3, turnSeqNow: 3, endedTurnSeq: 2, inDeepWater: false }).state;
  const viaOld = settleBatchAtBoundary(b, { L_readNow: 3000, kStable: 500, foldedSeqNow: 3, turnSeqNow: 3, inDeepWater: false }).state;
  assert.equal(viaNew.billProgress, viaOld.billProgress, 'billProgress byte-identical');
  assert.equal(viaNew.billCycleCount, viaOld.billCycleCount, 'billCycleCount byte-identical');
});

// ── C2-1 reader-loop tests (the 6 implementation-note specs). These drive advanceRateLampToCurrent's
// edge-by-edge settle through the fakeWatcher seam — the coverage the C1-2 reviewer deferred to C2. ──

test('C2-1 #1: one advance spanning 3 turns settles each ended turn IN ORDER; billCycleCount accumulates', () => {
  _resetRateLampManagerForTest();
  // burnRate 2.0 → each integrated call crosses the metronome exactly twice (trap 2.0 → 2 bills).
  setLiveLedger(SID, seedLedger(1));
  const w = fakeWatcher({ turnSeq: 3, foldedSeq: 4, samples: [
    rs(1, 2.0, 100000, 1), rs(2, 2.0, 120000, 1),   // turn 1: burn 100000 → 120000
    rs(3, 2.0, 150000, 2),                            // turn 2 opens (settles turn 1); boundary L 120000
    rs(4, 2.0, 200000, 3),                            // turn 3 opens (settles turn 2); boundary L 150000
  ] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.settledThroughTurnSeq, 2, 'turns 1,2 ended+settled; turn 3 is current/open');
  assert.equal(ledger.currentTurnSeq, 3, 'cursor advanced to the open turn via the trailing sync');
  assert.equal(ledger.settledTurnSummaries.length, 2, 'one summary per ENDED turn (1 and 2), in order');
  assert.deepEqual(ledger.settledTurnSummaries.map((s) => s.turnSeq), [1, 2], 'summaries ordered 1 then 2 (NEVER only the last)');
  assert.equal(summaryFor(ledger, 1).deltaW, 20000, 'turn 1 deltaW = 120000 − 100000');
  assert.equal(summaryFor(ledger, 2).deltaW, 30000, 'turn 2 deltaW = 150000 − 120000 (re-anchored per turn)');
  assert.equal(summaryFor(ledger, 1).billCycleCountIncrement, 2, 'turn 1 accrued 2 bill cycles');
  assert.equal(summaryFor(ledger, 2).billCycleCountIncrement, 2, 'turn 2 accrued 2 bill cycles');
  assert.equal(ledger.billCycleCount, 6, 'billCycleCount accumulates with no loss (2+2 settled + 2 open)');
});

test('C2-1 #2: turnSeq dedup — settling turn N a second time (Stop fallback) is a clean no-op', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, seedLedger(1));
  const w = fakeWatcher({ turnSeq: 2, foldedSeq: 3, samples: [
    rs(1, 2.0, 100000, 1), rs(2, 2.0, 120000, 1), rs(3, 2.0, 150000, 2),  // reader settles turn 1
  ] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.settledThroughTurnSeq, 1, 'reader settled turn 1');
  const cyclesAfterReader = ledger.billCycleCount;
  const summariesAfterReader = ledger.settledTurnSummaries.length;
  // Stop-style fallback settle of the SAME turn 1 → dedup gate (endedTurnSeq <= settledThroughTurnSeq) no-ops.
  const dup = settleMeterAtBoundary(ledger, { L_readNow: 130000, kStable: 940, foldedSeqNow: 2, turnSeqNow: 2, endedTurnSeq: 1, inDeepWater: false });
  assert.equal(dup.summary, null, 'second settle of turn 1 returns no summary (dedup)');
  assert.equal(dup.state, ledger, 'dedup returns the ledger untouched (no re-anchor, no re-zero)');
  assert.equal(dup.state.billCycleCount, cyclesAfterReader, 'billCycleCount unchanged by the duplicate settle');
  assert.equal(dup.state.settledTurnSummaries.length, summariesAfterReader, 'no second summary appended');
});

test('C2-1 #3: stale read N→N+3 apportions per-turn deltaW correctly (not just final billProgress)', () => {
  _resetRateLampManagerForTest();
  // burnRate 1.0 → each integrated call crosses exactly once (trap 1.0 → 1 bill).
  setLiveLedger(SID, seedLedger(1));
  const w = fakeWatcher({ turnSeq: 4, foldedSeq: 5, samples: [
    rs(1, 1.0, 100000, 1), rs(2, 1.0, 110000, 1),   // turn 1: Δ 10000
    rs(3, 1.0, 140000, 2),                            // turn 2: Δ 30000
    rs(4, 1.0, 200000, 3),                            // turn 3: Δ 60000
    rs(5, 1.0, 250000, 4),                            // turn 4 opens (settles turn 3)
  ] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.settledThroughTurnSeq, 3, 'turns 1,2,3 settled; turn 4 open');
  assert.equal(summaryFor(ledger, 1).deltaW, 10000, 'turn 1 deltaW individually correct');
  assert.equal(summaryFor(ledger, 2).deltaW, 30000, 'turn 2 deltaW individually correct (each turn re-anchored)');
  assert.equal(summaryFor(ledger, 3).deltaW, 60000, 'turn 3 deltaW individually correct');
  assert.equal(summaryFor(ledger, 1).billCycleCountIncrement, 1, 'turn 1 accrued 1 bill');
  assert.equal(summaryFor(ledger, 2).billCycleCountIncrement, 1, 'turn 2 accrued 1 bill');
  assert.equal(summaryFor(ledger, 3).billCycleCountIncrement, 1, 'turn 3 accrued 1 bill');
  assert.equal(ledger.billCycleCount, 4, 'total = 1+1+1 settled + 1 open (no double counting, no loss)');
});

test('C2-1 #4: a MID-STREAM zero-call turn is settled via the reader path and emits a summary (串轮 guard)', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, seedLedger(1));
  // turnSeq gap: samples carry turn 1 (two calls), then turn 3 — turn 2 has ZERO eligible calls.
  const w = fakeWatcher({ turnSeq: 3, foldedSeq: 3, samples: [
    rs(1, 1.0, 100000, 1), rs(2, 1.0, 130000, 1),   // turn 1 real burn
    rs(3, 1.0, 180000, 3),                            // JUMPS to turn 3 — turn 2 never lands on a sample
  ] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.settledThroughTurnSeq, 2, 'the gap turn 2 was walked one-per-iteration and settled');
  assert.deepEqual(ledger.settledTurnSummaries.map((s) => s.turnSeq), [1, 2], 'BOTH turn 1 and the zero-call turn 2 produced a summary');
  const s2 = summaryFor(ledger, 2);
  assert.equal(s2.deltaW, 0, 'zero-call turn 2: deltaW === 0');
  assert.equal(s2.foldedCallSeqStart, s2.foldedCallSeqEnd, 'zero-call ⟹ foldedCallSeqStart === foldedCallSeqEnd (串轮 marker)');
  assert.equal(s2.billKindAtBoundary, null, 'zero-call ⟹ null kind (no alertable burn synthesized)');
  assert.ok(summaryFor(ledger, 1).deltaW > 0, 'turn 1 still carries its real burn (not swallowed by the gap walk)');
});

test('C2-1 #5: CROSS-POLL boundary settles with the REAL deltaW read from the PERSISTED cursor, not 0 (A1)', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, seedLedger(5));                  // open turn 5
  // Poll ①: only turn-5 calls arrive — NO boundary yet, so turn 5 is NOT settled; the persisted cursor
  // (lastAppliedLRead) holds turn 5's last-call L (150000).
  const poll1 = fakeWatcher({ turnSeq: 5, foldedSeq: 2, samples: [
    rs(1, 1.0, 100000, 5), rs(2, 1.0, 150000, 5),
  ] });
  const r1 = advanceRateLampToCurrent(poll1, SID, { forcePoll: false });
  assert.equal(r1.ledger.settledThroughTurnSeq, 4, 'turn 5 NOT settled in poll ① (no boundary seen)');
  assert.equal(r1.ledger.lastAppliedLRead, 150000, 'persisted cursor holds turn 5 last-call L across the poll gap');
  // Poll ②: turn 6 opens — the boundary is first seen NOW. The edge-settle reads the PERSISTED cursor.
  const poll2 = fakeWatcher({ turnSeq: 6, foldedSeq: 3, samples: [ rs(3, 1.0, 220000, 6) ] });
  const { ledger } = advanceRateLampToCurrent(poll2, SID, { forcePoll: false });
  assert.equal(ledger.settledThroughTurnSeq, 5, 'turn 5 settled in poll ②');
  const s5 = summaryFor(ledger, 5);
  assert.equal(s5.deltaW, 50000, 'deltaW = 150000 − 100000 = REAL burn (persisted cursor), NOT 0');
  assert.ok(s5.deltaW > 0, 'A1: a loop-local prev would be null here → deltaW 0; the persisted cursor is the real burn');
  assert.notEqual(s5.billKindAtBoundary, 'empty_burn', 'a real cross-poll burn is NOT misclassified empty_burn (no false stop_hook)');
  assert.equal(s5.billKindAtBoundary, 'non_idle_burn', 'real burn 50000 ≥ kStable 940 ⟹ non_idle');
});

test('C2-1 #6: per-committed-boundary display latch update uses deepWaterDisplay hysteresis (H-pt4)', () => {
  _resetRateLampManagerForTest();
  // L_exit_fullCarry = (1 + 2·√(2·10·940/250000))·250000 ≈ 387113; hyst = max(2048, 0.02·10·250000) = 50000.
  const lBase = 250000;
  const xExit = 1 + 2 * Math.sqrt(2 * 10 * 940 / lBase);
  const L_exit = xExit * lBase;
  const hyst = 50000;
  assert.ok(420000 > L_exit, 'precondition: enter boundary L is above the exit line');
  assert.ok(360000 < L_exit && 360000 >= L_exit - hyst, 'precondition: recede boundary L sits INSIDE the deadband');
  assert.ok(!(360000 >= L_exit), 'precondition: a RAW compare would drop the latch at 360000 — hysteresis must not');

  setLiveLedger(SID, seedLedger(1));
  // Poll ①: turn 1 climbs to 420000 (above exit) → boundary crosses → latch enters true.
  const poll1 = fakeWatcher({ turnSeq: 2, foldedSeq: 3, baselineTotal: lBase, samples: [
    rs(1, 0.1, 410000, 1), rs(2, 0.1, 420000, 1), rs(3, 0.1, 425000, 2),
  ] });
  const r1 = advanceRateLampToCurrent(poll1, SID, { forcePoll: false });
  assert.equal(r1.ledger.deepWaterDisplayLatched, true, 'latch ENTERS true on the committed boundary crossing the exit line');
  // Poll ②: a cache-expiry dip recedes turn 2 to 360000 — INSIDE the deadband. Hysteresis keeps it latched.
  const poll2 = fakeWatcher({ turnSeq: 3, foldedSeq: 5, baselineTotal: lBase, samples: [
    rs(4, 0.1, 360000, 2), rs(5, 0.1, 365000, 3),
  ] });
  const { ledger } = advanceRateLampToCurrent(poll2, SID, { forcePoll: false });
  assert.equal(ledger.deepWaterDisplayLatched, true, 'receding only INTO the deadband keeps it latched (hysteresis, no flicker — a raw compare would drop it)');
});
