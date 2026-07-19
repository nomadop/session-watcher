import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';

// Initialize a fresh SQLite store for each test to isolate persistence from ~/.session-watcher.
let _storeDir;
beforeEach(() => {
  _storeDir = mkdtempSync(join(tmpdir(), 'sw-rl-mgr-'));
  initStore(join(_storeDir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(_storeDir, { recursive: true, force: true });
});

import { resolveLedgerForKey, mergeLedgerIntoStatus, recordBillEvent,
  advanceRateLampToCurrent, setLiveLedger, getLiveLedger, _resetRateLampManagerForTest,
  _setRateLampManagerTestHooks, flushPendingPersistsSync, sweepStaleLedgers,
  getDebugCounters } from '../lib/rate-lamp-manager.js';
import { freshLedger, saveRateLampState, stateKeyOf, applyFoldedCallSample } from '../lib/rate-lamp-store.js';

// KEY is the real state key stateKeyForStatus computes for segment 0 in v3 (only segment + schema).
// The pure resolveLedgerForKey/merge tests treat it as an opaque key string; the advance tests need it
// to EQUAL advanceRateLampToCurrent's computed currentKey so the ledger is reused, not reset.
const KEY = stateKeyOf({ segmentId: 0, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
const SID = 'sid-manager-test';
// reducer sample helper (New#3 re-anchor tests) — field is L_read (effectiveL), never cacheRead.
const rs = (seq, burnRate, L_read, turnSeq = 1) => ({ seq, reliable: true, burnRate, L_read, turnSeq });

// fakeWatcher: a stub that mimics the SessionWatcher surface advanceRateLampToCurrent consumes. getStatus()
// returns a reliable-latched rateLamp whose {segment,model,C_RATIO,fingerprint,L_cap} compute to KEY, so a
// same-key ledger is reused. rateLampSamplesSince/rateLampSeqSamplesSince return the provided `samples`.
function fakeWatcher({ turnSeq, foldedSeq, samples = [], reliable = true, unavailableReason,
  cRatio = 10, kStable = 940, gEma = 940, L_read = 300000, L_cap = 1000000, baselineTotal = 250000,
  model = 'opus', segment = 0, fingerprint = 'fp-A' } = {}) {
  return {
    _turnSeq: turnSeq,
    _foldedCallSeq: foldedSeq,
    poll() { return { changed: false, newCalls: 0 }; },
    getStatus() {
      const rateLamp = reliable
        ? { reliable: true, C_RATIO: cRatio, L_cap, L_read, B_post: baselineTotal, B_rebuild: baselineTotal, kStable, gEma }
        : { reliable: false, unavailableReason };
      return { segment, model, baseline: { fingerprint, total: baselineTotal }, rateLamp };
    },
    rateLampSamplesSince() { return samples; },
    rateLampSeqSamplesSince() { return samples; },
  };
}

test('R2-3: fresh ledger (no persisted) anchors at CURRENT seq, does NOT catch up history', () => {
  const led = resolveLedgerForKey(null, { currentKey: KEY, watcherFoldedSeq: 20, watcherTurnSeq: 4, kStableFrozen: 940, lReadNow: 250000 });
  assert.equal(led.stateKey, KEY);
  assert.equal(led.lastAppliedFoldedCallSeq, 20, 'anchored at current seq — the next drain only sees seq>20');
  assert.equal(led.billProgress, 0, 'no retroactive integration of the existing 20-call history');
  assert.equal(led.billAnchorLRead, 250000);
  assert.equal(led.kStableFrozen, 940);
});

test('R2-1: same key + watcher seq ≥ lastApplied → reuse (continue integrating); cursor synced AFTER the advance', () => {
  // C2-1/Option-1: the reuse branch no longer PRE-JUMPS currentTurnSeq to the watcher turn — currentTurnSeq
  // now means "last-integrated/open turn" so the edge-settle loop can walk it forward and settle the ended
  // turn from the persisted cursor. The pure resolve therefore leaves currentTurnSeq at the persisted value.
  const persisted = { ...freshLedger(KEY, 940), lastAppliedFoldedCallSeq: 12, billProgress: 0.4, currentTurnSeq: 3 };
  const led = resolveLedgerForKey(persisted, { currentKey: KEY, watcherFoldedSeq: 12, watcherTurnSeq: 5, kStableFrozen: 940, lReadNow: 300000 });
  assert.equal(led.billProgress, 0.4, 'reused, not reset');
  assert.equal(led.lastAppliedFoldedCallSeq, 12);
  assert.equal(led.pausedReason, null);
  assert.equal(led.currentTurnSeq, 3, 'C2-1: reuse does NOT pre-jump currentTurnSeq (was 5) — it stays at the persisted open turn');

  // R2-1 must STILL protect the TTL/pulse cursor: at the END of an advance the trailing syncLedgerTurn
  // brings currentTurnSeq up to the watcher turn (so mergeLedgerIntoStatus's lastBillEvent.turnSeq ===
  // currentTurnSeq TTL read can be evaluated) AND zeros ΔW on the real advance. Prove it through the full
  // advance path with NO new eligible samples (the exact zero-integration case the old pre-jump covered).
  _resetRateLampManagerForTest();
  const SIDR = 'sid-r2-1-trailing-sync';
  setLiveLedger(SIDR, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 3,
    billProgress: 0.4 });
  const w = fakeWatcher({ turnSeq: 5, foldedSeq: 12, samples: [] });
  const { ledger } = advanceRateLampToCurrent(w, SIDR, { forcePoll: false });
  assert.equal(ledger.currentTurnSeq, 5, 'TTL/pulse cursor reaches the watcher turn at the END of the advance (trailing sync)');
  assert.equal(ledger.billProgress, 0.4, 'no integration happened — billProgress untouched');
});

test('New#3: same key but watcher seq < lastApplied → in-place re-anchor (NOT a stuck seq_history_mismatch pause)', () => {
  const persisted = { ...freshLedger(KEY, 940), lastAppliedFoldedCallSeq: 20, billProgress: 0.4,
    billCycleCount: 5, lastBurnRate: 1.3, currentTurnSeq: 6 };
  const led = resolveLedgerForKey(persisted, { currentKey: KEY, watcherFoldedSeq: 10, watcherTurnSeq: 9, kStableFrozen: 940, lReadNow: 100000 });
  assert.equal(led.pausedReason, null, 'deadlock broken: mismatch no longer wedges the ledger');
  assert.equal(led.billCycleCount, 5, 'lifetime billCycleCount PRESERVED');
  assert.equal(led.billProgress, 0.4, 'billProgress remainder preserved for seamless continuity');
  assert.equal(led.lastAppliedFoldedCallSeq, 10, 're-anchored to the CURRENT watcher folded seq');
  assert.equal(led.billAnchorFoldedCallSeq, 10, 'bill anchor folded seq re-anchored to now');
  assert.equal(led.billAnchorLRead, 100000, 'bill anchor L_read re-anchored to lReadNow');
  assert.equal(led.lastBurnRate, null, 'lastBurnRate nulled (P0-5 no-catch-up)');
  assert.equal(led.stateKey, KEY, 'stateKey unchanged');
  assert.equal(led.kStableFrozen, 940, 'frozen k_stable kept');
});

test('New#3: no double-settlement after re-anchor — historical seq≤now are no-ops; integration resumes clean', () => {
  const persisted = { ...freshLedger(KEY, 940), lastAppliedFoldedCallSeq: 20, billProgress: 0.4,
    billCycleCount: 5, lastBurnRate: 1.3, currentTurnSeq: 6 };
  let led = resolveLedgerForKey(persisted, { currentKey: KEY, watcherFoldedSeq: 10, watcherTurnSeq: 9, kStableFrozen: 940, lReadNow: 100000 });
  // Re-feeding calls at or below the re-anchored cursor (seq ≤ 10) must be idempotent no-ops — the pause
  // guarded against re-integrating already-settled calls, and the re-anchor keeps that protection.
  for (const seq of [5, 8, 10]) led = applyFoldedCallSample(led, rs(seq, 5.0, 100000 + seq, 9));
  assert.equal(led.billCycleCount, 5, 'no new bill from historical (already-settled) calls');
  assert.equal(led.lastAppliedFoldedCallSeq, 10, 'cursor unmoved by ≤-cursor replays');
  // The first genuinely-new call re-anchors lastBurnRate only (recovering first frame), no catch-up bill.
  led = applyFoldedCallSample(led, rs(11, 5.0, 150000, 9));
  assert.equal(led.billCycleCount, 5, 'first new call after re-anchor re-anchors, does NOT integrate a lump (P0-5)');
  assert.equal(led.lastBurnRate, 5.0, 'lastBurnRate re-anchored from the first new call');
  // A subsequent new call now integrates normally — proves the ledger is live again, not wedged.
  led = applyFoldedCallSample(led, rs(12, 5.0, 200000, 9)); // trap 5.0 → several crossings
  assert.ok(led.billCycleCount > 5, 'integration resumed on the next new call — deadlock is truly broken');
});

// A raw same-key/older-seq path that previously produced a hard mismatch pause is exercised in the two
// New#3 tests above; the pre-fix pause behavior is retired by the fix-wave re-anchor.

test('New#3 residual: a stale pre-fix seq_history_mismatch ledger (seq caught up) SELF-HEALS on advance', () => {
  // Reviewer's Minor: resolveLedgerForKey no longer CREATES this pause, but a ledger persisted by a pre-fix
  // binary can still carry pausedReason:'seq_history_mismatch' on disk. If its seq has since caught up
  // (watcherFoldedSeq >= lastApplied) the resolver takes the REUSE branch, so the pause is not re-anchored
  // away — it must be healed by the reducer instead. Removing the two `pausedReason !== 'seq_history_mismatch'`
  // drain gates makes the reliable drain reach the reducer's recovering branch, which clears ANY paused reason
  // on the first reliable sample. Pre-fix (gates present) this ledger stayed wedged until a segment change.
  //
  // CRITICAL: lastBurnRate is set NON-NULL (1.3) to match the REAL pre-fix ledger shape — pre-fix
  // resolveLedgerForKey stamped `{ ...persisted, pausedReason }`, preserving persisted.lastBurnRate. If the
  // seed left it null (as freshLedger does), the reducer's `recovering = pausedReason!=null || lastBurnRate==null`
  // would be true for the WRONG reason and the test would still pass even if the `pausedReason!=null` clause
  // were deleted. With lastBurnRate non-null, the heal hinges SOLELY on the pausedReason clause — and a
  // fall-through-to-integration bug would surface as a phantom bill (billCycleCount≠7) rather than a clean heal.
  _resetRateLampManagerForTest();
  const SIDH = 'sid-stale-mismatch';
  saveRateLampState(SIDH, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12,
    currentTurnSeq: 5, billProgress: 0.4, billCycleCount: 7, lastBurnRate: 1.3, lastAppliedLRead: 250000,
    pausedReason: 'seq_history_mismatch' });
  // Fresh process: seq has caught up (foldedSeq 13 > lastApplied 12) and a NEW reliable call (seq 13) arrives.
  const w = fakeWatcher({ turnSeq: 6, foldedSeq: 13, samples: [rs(13, 5.0, 300000, 6)] });
  const { ledger } = advanceRateLampToCurrent(w, SIDH, { forcePoll: false });
  assert.equal(ledger.pausedReason, null, 'stale seq_history_mismatch cleared by the reducer recovering branch — not wedged');
  assert.equal(ledger.billCycleCount, 7, 'lifetime counter preserved; recovering first-frame did NOT integrate a stale-rate trapezoid (no phantom bill)');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 13, 'cursor advanced onto the new reliable call');
  assert.equal(ledger.lastBurnRate, 5.0, 'lastBurnRate re-anchored from the healing sample (stale 1.3 discarded)');
});

test('New#3 residual: an UNRELIABLE frame on a stale seq_history_mismatch ledger overwrites the reason, no corruption', () => {
  // Case (b): the unreliable / not-yet-latched branch now also drains a stale-mismatch ledger (gate removed).
  // A seq-only unreliable sample must OVERWRITE pausedReason with the unavailable reason and advance the
  // cursor — never integrate, never wedge. When a reliable frame later returns, the recovering branch clears it.
  _resetRateLampManagerForTest();
  const SIDU = 'sid-stale-mismatch-unreliable';
  saveRateLampState(SIDU, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12,
    currentTurnSeq: 5, billProgress: 0.4, billCycleCount: 7, lastBurnRate: 1.3, pausedReason: 'seq_history_mismatch' });
  // Unreliable frame: getStatus().rateLamp.reliable === false; a seq-only sample at seq 13 (unreliable).
  const w = fakeWatcher({ turnSeq: 6, foldedSeq: 13, reliable: false, unavailableReason: 'metrics_unreliable',
    samples: [{ seq: 13, reliable: false, unavailableReason: 'metrics_unreliable', turnSeq: 6 }] });
  const { ledger } = advanceRateLampToCurrent(w, SIDU, { forcePoll: false });
  assert.equal(ledger.pausedReason, 'metrics_unreliable', 'stale seq_history_mismatch overwritten by the current unreliable reason — not preserved/wedged');
  assert.equal(ledger.billCycleCount, 7, 'unreliable drain never integrates → lifetime counter untouched');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 13, 'cursor advanced by the seq-only unreliable sample');
});

test('R2-1: key mismatch → reset fresh anchored at current seq', () => {
  const persisted = { ...freshLedger('k-OLD', 700), lastAppliedFoldedCallSeq: 50, billProgress: 0.9 };
  const led = resolveLedgerForKey(persisted, { currentKey: KEY, watcherFoldedSeq: 8, watcherTurnSeq: 2, kStableFrozen: 940, lReadNow: 200000 });
  assert.equal(led.stateKey, KEY);
  assert.equal(led.billProgress, 0, 'new billing epoch');
  assert.equal(led.lastAppliedFoldedCallSeq, 8);
  assert.equal(led.kStableFrozen, 940, 'froze the NEW segment k_stable');
});

test('R2-4: mergeLedgerIntoStatus refuses a stale-key ledger (no ghost billProgress)', () => {
  const status = { rateLamp: { reliable: true, billProgress: undefined } };
  const stale = { ...freshLedger('k-OLD', 940), billProgress: 0.7, stateKey: 'k-OLD' };
  const merged = mergeLedgerIntoStatus({ ...status }, stale, KEY);
  assert.equal(merged.rateLamp.billProgress, undefined, 'stale key → not merged');
  const fresh = { ...freshLedger(KEY, 940), billProgress: 0.33, stateKey: KEY };
  const merged2 = mergeLedgerIntoStatus({ rateLamp: { reliable: true } }, fresh, KEY);
  assert.equal(merged2.rateLamp.billProgress, 0.33, 'matching key → merged');
});

test('R2-7: recordBillEvent stamps a TTL-able pulse; stale event not shown next turn', () => {
  let led = freshLedger(KEY, 940);
  led = recordBillEvent(led, { kind: 'non_idle_burn', billCount: 2, deltaL: 5000, delivery: 'statusline_pulse' }, 7);
  assert.equal(led.lastBillEvent.turnSeq, 7);
  // reader compares against current turnSeq; same-turn shows, later turn expires (asserted in Task 7)
  assert.equal(led.lastBillEvent.kind, 'non_idle_burn');
});

// --- round-6 A-group: turnSeq / TTL lifecycle (gemini#1 + GPT#1 + GPT#5) ---
// These exercise advanceRateLampToCurrent against a fake watcher; call _resetRateLampManagerForTest()
// in t.beforeEach so the module-level _ledgers Map does not bleed between tests (GPT#7).

test('R6-A1 (gemini#1): a zero-eligible-call turn advances currentTurnSeq', () => {
  _resetRateLampManagerForTest();
  // fake watcher: reliable-latched, but rateLampSamplesSince returns [] (no new eligible call this turn),
  // and _turnSeq has advanced from the persisted ledger's currentTurnSeq.
  const w = fakeWatcher({ turnSeq: 8, foldedSeq: 12, samples: [] });
  setLiveLedger(SID, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 7,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 1, deltaL: 3000, delivery: 'statusline_pulse', turnSeq: 7 } });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.currentTurnSeq, 8, 'currentTurnSeq followed the real turn even though nothing integrated');
  // → the Task-7 TTL (event.turnSeq===currentTurnSeq) now MISMATCHES the turn-7 pulse → it stops rendering.
  assert.notEqual(ledger.lastBillEvent.turnSeq, ledger.currentTurnSeq, 'stale pulse expires on the empty new turn');
});

test('R6-A3 (GPT#5): a DISK-hydrated ledger clears lastBillEvent/lastStopEvent (pulses do not survive restart)', () => {
  _resetRateLampManagerForTest();
  // persist a ledger carrying a stop event at turnSeq 5, then simulate a fresh process (empty _ledgers) —
  // first advance must hydrate from disk with the pulse/alert CLEARED.
  saveRateLampState(SID, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 5,
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message: 'old', billCount: 0, turnSeq: 5 } });
  const w = fakeWatcher({ turnSeq: 0, foldedSeq: 3, samples: [] }); // restart: watcher turnSeq starts at 0
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.lastStopEvent, null, 'GPT#5: stop alert did not resurrect across the process boundary');
  assert.equal(ledger.lastBillEvent, null, 'bill pulse also cleared on disk hydrate');
});

test('R6-A2 (GPT#1): restart hydrates watcher._turnSeq monotonically from ledger.currentTurnSeq', () => {
  _resetRateLampManagerForTest();
  saveRateLampState(SID, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 50 });
  const w = fakeWatcher({ turnSeq: 1, foldedSeq: 3, samples: [] }); // Task 2.7 rebuild under-counted to 1
  advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.ok(w._turnSeq >= 50, 'watcher._turnSeq raised to at least the persisted currentTurnSeq — never goes backwards');
});

// --- #6 (fix wave): per-poll disk write gated on an actual ledger change ---
// The poll loop calls advanceRateLampToCurrent once per second. Pre-fix it wrote the checkpoint to disk
// UNCONDITIONALLY every call (~86k identical rewrites/day/session). The SSE emit was already gated on
// `changed`; only the redundant no-op disk write is eliminated here. We OBSERVE writes via the
// getDebugCounters().diskWrites counter (reset by _resetRateLampManagerForTest) — SQLite-compatible,
// no file-sentinel needed.

test('#6: first poll advance writes, a second no-change advance does NOT rewrite the checkpoint', () => {
  _resetRateLampManagerForTest();                              // clears _ledgers, write-elision cache, AND counters
  const SID6 = 'sid-poll-gate';
  // Seed the store only (saveRateLampState bypasses the elision cache), mimicking a fresh process whose first
  // poll hydrates from the store. reliable-latched watcher, NO new folded calls, turn unchanged between calls.
  saveRateLampState(SID6, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4 });
  const w = fakeWatcher({ turnSeq: 5, foldedSeq: 12, samples: [] });
  advanceRateLampToCurrent(w, SID6, { forcePoll: false });     // first advance: cache miss → WRITES, primes cache
  flushPendingPersistsSync();                                  // flush write-behind so counter reflects the write
  const writesAfterFirst = getDebugCounters().diskWrites;
  assert.ok(writesAfterFirst >= 1, 'first advance wrote the checkpoint (diskWrites incremented)');
  advanceRateLampToCurrent(w, SID6, { forcePoll: false });     // no new call, no turn change → must NOT write
  flushPendingPersistsSync();                                  // flush: if anything was enqueued, it fires now
  assert.equal(getDebugCounters().diskWrites, writesAfterFirst, 'a no-op poll advance did not rewrite the checkpoint (gate works)');
});

test('#6: an advance that DOES change the ledger still writes (gate never suppresses a real change)', () => {
  _resetRateLampManagerForTest();
  const SID6 = 'sid-poll-gate-change';
  // First: latch with no new call to prime the store + gate snapshot.
  const wIdle = fakeWatcher({ turnSeq: 5, foldedSeq: 12, samples: [] });
  setLiveLedger(SID6, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4, lastBurnRate: 0.5 });
  advanceRateLampToCurrent(wIdle, SID6, { forcePoll: false });
  flushPendingPersistsSync(); // C5a: write-behind flush
  const writesBeforeChange = getDebugCounters().diskWrites;
  // Now a genuinely new folded call (seq 13) arrives → the ledger integrates and MUST be persisted.
  const wNew = fakeWatcher({ turnSeq: 6, foldedSeq: 13,
    samples: [{ seq: 13, reliable: true, burnRate: 0.9, L_read: 320000, turnSeq: 6 }] });
  const { ledger } = advanceRateLampToCurrent(wNew, SID6, { forcePoll: false });
  flushPendingPersistsSync(); // C5a: write-behind → flush to verify the write happens
  assert.ok(getDebugCounters().diskWrites > writesBeforeChange, 'a real ledger change wrote the checkpoint (gate did not suppress it)');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 13, 'the new call was integrated (cursor advanced)');
});

// --- Task 8 (B4-server): rentMeter render object ---

test('mergeLedgerIntoStatus builds rentMeter render object when reliable', () => {
  // Fixture: a reliable rateLamp status with br-family fields populated.
  // backstopLapCount=1 (< 3 → depthHot false), dwBillsSinceLastAlert=2, hasDeepWaterGateFired=true.
  const cRatio = 10, gEma = 940, B = 250000, dhat = 0.35, mf = 0.5;
  const status = {
    rateLamp: {
      reliable: true,
      C_RATIO: cRatio,
      gEma,
      B_post: B,
      B_rebuild: B,
      dhat,
      mf,
      burnRate: 0.25,
      billProgress: 0.6,
      xSweet: 1 + dhat,
      L_read: 300000,
      // Task 7 fields
      dwBillsSinceLastAlert: 2,
      hasDeepWaterGateFired: true,
      backstopLapCount: 1,
    },
  };
  const ledger = {
    ...freshLedger(KEY, 940),
    stateKey: KEY,
    billProgress: 0.6,
    billCycleCount: 3,
    dwBillsSinceLastAlert: 2,
    hasDeepWaterGateFired: true,
    backstopLapCount: 1,
  };
  mergeLedgerIntoStatus(status, ledger, KEY);
  const rm = status.rateLamp.rentMeter;
  assert.ok(rm, 'rentMeter present after reliable merge');
  // cycleProgress = billProgress
  assert.equal(rm.cycleProgress, 0.6, 'cycleProgress === ledger.billProgress');
  // rentRate = burnRate
  assert.equal(rm.rentRate, 0.25, 'rentRate === burnRate');
  // sweetRentRate = dhat / cRatio
  assert.ok(Math.abs(rm.sweetRentRate - dhat / cRatio) < 1e-12, 'sweetRentRate === dhat/cRatio');
  // depthActive = hasDeepWaterGateFired
  assert.equal(rm.depthActive, true, 'depthActive === hasDeepWaterGateFired');
  // depthProgress clamped [0,1]
  assert.ok(rm.depthProgress >= 0 && rm.depthProgress <= 1, 'depthProgress in [0,1]');
  // depthHot = backstopLapCount >= 3
  assert.equal(rm.depthHot, false, 'depthHot false when lapCount(1) < 3');
  // backstopLapCount mirrored
  assert.equal(rm.backstopLapCount, 1, 'backstopLapCount mirrored from rateLamp');
  // backstopInterval is a finite number (mf > 0 so backstopIntervalFor returns a real number)
  assert.ok(Number.isFinite(rm.backstopInterval), 'backstopInterval is finite');

  // Verify depthHot=true when lapCount >= 3
  const status2 = {
    rateLamp: { ...status.rateLamp, backstopLapCount: 3, dwBillsSinceLastAlert: 5 },
  };
  const ledger2 = { ...ledger, backstopLapCount: 3, dwBillsSinceLastAlert: 5 };
  mergeLedgerIntoStatus(status2, ledger2, KEY);
  assert.equal(status2.rateLamp.rentMeter.depthHot, true, 'depthHot true when lapCount(3) >= 3');
});

test('rentMeter is present with null-safe defaults when status is unreliable', () => {
  const status = { rateLamp: { reliable: false } };
  mergeLedgerIntoStatus(status, null, 'k');
  assert.ok(status.rateLamp.rentMeter, 'rentMeter present even when unreliable');
  assert.equal(status.rateLamp.rentMeter.depthActive, false, 'depthActive defaults false');
  assert.equal(status.rateLamp.rentMeter.cycleProgress, 0, 'cycleProgress defaults 0');
  assert.equal(status.rateLamp.rentMeter.rentRate, null, 'rentRate defaults null');
  assert.equal(status.rateLamp.rentMeter.sweetRentRate, null, 'sweetRentRate defaults null');
  assert.equal(status.rateLamp.rentMeter.depthProgress, 0, 'depthProgress defaults 0');
  assert.equal(status.rateLamp.rentMeter.backstopInterval, null, 'backstopInterval defaults null');
  assert.equal(status.rateLamp.rentMeter.backstopLapCount, 0, 'backstopLapCount defaults 0');
  assert.equal(status.rateLamp.rentMeter.depthHot, false, 'depthHot defaults false');
});

test('rentMeter: depthProgress clamped to 1 when dwBills >= backstopInterval', () => {
  // Large dwBillsSinceLastAlert exceeds interval → clamp to 1
  const cRatio = 10, gEma = 940, B = 250000, dhat = 0.35, mf = 0.5;
  const status = {
    rateLamp: {
      reliable: true, C_RATIO: cRatio, gEma, B_post: B, B_rebuild: B,
      dhat, mf, burnRate: 0.3, billProgress: 0.4, xSweet: 1 + dhat, L_read: 290000,
      dwBillsSinceLastAlert: 99999, hasDeepWaterGateFired: false, backstopLapCount: 0,
    },
  };
  const ledger = { ...freshLedger(KEY, 940), stateKey: KEY, billProgress: 0.4,
    dwBillsSinceLastAlert: 99999, hasDeepWaterGateFired: false, backstopLapCount: 0 };
  mergeLedgerIntoStatus(status, ledger, KEY);
  assert.equal(status.rateLamp.rentMeter.depthProgress, 1, 'depthProgress clamped to 1 when overflow');
});

test('RV-C8: sweepStaleLedgers evicts entries older than TTL', () => {
  _resetRateLampManagerForTest();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  let now = 1_000_000_000_000;
  // Suppress disk writes (setLiveLedger calls persistLedger internally)
  _setRateLampManagerTestHooks({ nowMono: () => now, writer: () => {} });

  // Set two sessions (writer hook suppresses disk I/O)
  setLiveLedger('session-old', { stateKey: 'k1', ledgerRevision: 1 });
  setLiveLedger('session-new', { stateKey: 'k2', ledgerRevision: 1 });

  // Advance time past TTL
  now += SEVEN_DAYS_MS + 1000;

  // Touch session-new (simulates active use)
  getLiveLedger('session-new'); // access refreshes timestamp

  // Sweep
  const evicted = sweepStaleLedgers();
  assert.equal(evicted, 1, 'one stale ledger evicted');
  assert.equal(getLiveLedger('session-old'), null, 'old session gone');
  assert.ok(getLiveLedger('session-new') !== null, 'new session retained');
});
