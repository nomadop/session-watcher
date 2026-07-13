import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GPT#7: point the ledger checkpoint dir at a temp CLAUDE_PLUGIN_DATA so the disk-touching advance
// tests (setLiveLedger / saveRateLampState / the disk-hydrate) never write into the real ~/.session-watcher.
// pathFor() in the store reads process.env lazily per-call, so setting it before the tests run is enough.
const TMP = mkdtempSync(join(tmpdir(), 'sw-rl-mgr-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { resolveLedgerForKey, mergeLedgerIntoStatus, recordBillEvent,
  advanceRateLampToCurrent, setLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { freshLedger, saveRateLampState, stateKeyOf, applyFoldedCallSample } from '../lib/rate-lamp-store.js';

// KEY is the real state key the fakeWatcher's snapshot computes (segment/model/cRatio/fingerprint/cap).
// The pure resolveLedgerForKey/merge tests treat it as an opaque key string; the advance tests need it
// to EQUAL advanceRateLampToCurrent's computed currentKey so the ledger is reused, not reset.
const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'fp-A', contextCap: 1000000, schemaVersion: 1 });
const SID = 'sid-manager-test';
// reducer sample helper (New#3 re-anchor tests) — field is L_read (effectiveL), never cacheRead.
const rs = (seq, burnRate, L_read, turnSeq = 1) => ({ seq, reliable: true, burnRate, L_read, turnSeq });

// fakeWatcher: a stub that mimics the SessionWatcher surface advanceRateLampToCurrent consumes. getStatus()
// returns a reliable-latched rateLamp whose {segment,model,C_RATIO,fingerprint,L_cap} compute to KEY, so a
// same-key ledger is reused. rateLampSamplesSince/rateLampSeqSamplesSince return the provided `samples`.
function fakeWatcher({ turnSeq, foldedSeq, samples = [], reliable = true, unavailableReason,
  cRatio = 10, kStable = 940, L_read = 300000, L_cap = 1000000, baselineTotal = 250000,
  model = 'opus', segment = 0, fingerprint = 'fp-A' } = {}) {
  return {
    _turnSeq: turnSeq,
    _foldedCallSeq: foldedSeq,
    poll() { return { changed: false, newCalls: 0 }; },
    getStatus() {
      const rateLamp = reliable
        ? { reliable: true, C_RATIO: cRatio, L_cap, L_read, B_post: baselineTotal, B_rebuild: baselineTotal, kStable }
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
  assert.equal(led.billAnchorTurnSeq, 4, 'R5 GPT#7: billAnchorTurnSeq set at anchor, not left at 0');
  assert.equal(led.kStableFrozen, 940);
});

test('R2-1: same key + watcher seq ≥ lastApplied → reuse (continue integrating)', () => {
  const persisted = { ...freshLedger(KEY, 940), lastAppliedFoldedCallSeq: 12, billProgress: 0.4, currentTurnSeq: 3 };
  const led = resolveLedgerForKey(persisted, { currentKey: KEY, watcherFoldedSeq: 12, watcherTurnSeq: 5, kStableFrozen: 940, lReadNow: 300000 });
  assert.equal(led.billProgress, 0.4, 'reused, not reset');
  assert.equal(led.lastAppliedFoldedCallSeq, 12);
  assert.equal(led.pausedReason, null);
  assert.equal(led.currentTurnSeq, 5, 'round-6 gemini#1: reuse SYNCS currentTurnSeq to the watcher turn even with no integration');
});

test('New#3: same key but watcher seq < lastApplied → in-place re-anchor (NOT a stuck seq_history_mismatch pause)', () => {
  // Pre-fix this branch set pausedReason:'seq_history_mismatch', which BOTH drain gates in
  // advanceRateLampToCurrent refuse — and the only code that clears pausedReason (the reducer's recovering
  // branch) is exactly what those gates prevent. So the pause never self-cleared: billing + ΔW/stock alerts
  // silently lost until the segment changed. Fix: re-anchor in place, preserving the lifetime cycleCount and
  // the billProgress remainder, moving the seq/anchors to NOW, clearing pending + the pause.
  const persisted = { ...freshLedger(KEY, 940), lastAppliedFoldedCallSeq: 20, billProgress: 0.4,
    billCycleCount: 5, pendingBillCountSinceBoundary: 3, lastBurnRate: 1.3, currentTurnSeq: 6 };
  const led = resolveLedgerForKey(persisted, { currentKey: KEY, watcherFoldedSeq: 10, watcherTurnSeq: 9, kStableFrozen: 940, lReadNow: 100000 });
  assert.equal(led.pausedReason, null, 'deadlock broken: mismatch no longer wedges the ledger');
  assert.equal(led.billCycleCount, 5, 'lifetime billCycleCount PRESERVED (planned dashboard N→0 jump avoided)');
  assert.equal(led.billProgress, 0.4, 'billProgress remainder preserved for seamless continuity');
  assert.equal(led.lastAppliedFoldedCallSeq, 10, 're-anchored to the CURRENT watcher folded seq (from-now, no replay)');
  assert.equal(led.billAnchorFoldedCallSeq, 10, 'bill anchor folded seq re-anchored to now');
  assert.equal(led.billAnchorLRead, 100000, 'bill anchor L_read re-anchored to lReadNow');
  assert.equal(led.billAnchorTurnSeq, 9, 'bill anchor turn seq re-anchored to the current watcher turn');
  assert.equal(led.pendingBillCountSinceBoundary, 0, 'pending across the seq break cleared (untrustworthy → no phantom Stop bill)');
  assert.equal(led.lastBurnRate, null, 'lastBurnRate nulled so the first post-re-anchor call re-anchors (P0-5 no-catch-up), not integrate a stale-rate trapezoid');
  assert.equal(led.stateKey, KEY, 'stateKey unchanged — the precondition to reach this branch');
  assert.equal(led.kStableFrozen, 940, 'frozen k_stable kept');
});

test('New#3: no double-settlement after re-anchor — historical seq≤now are no-ops; integration resumes clean', () => {
  const persisted = { ...freshLedger(KEY, 940), lastAppliedFoldedCallSeq: 20, billProgress: 0.4,
    billCycleCount: 5, pendingBillCountSinceBoundary: 3, lastBurnRate: 1.3, currentTurnSeq: 6 };
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
  assert.equal(led.billAnchorTurnSeq, 2, 'R5 GPT#7: reset also anchors billAnchorTurnSeq at current turn');
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

test('R6-A1 (gemini#1) + R7-1 (GPT#1): a zero-eligible-call turn advances currentTurnSeq AND zeroes currentTurnDeltaW', () => {
  _resetRateLampManagerForTest();
  // fake watcher: reliable-latched, but rateLampSamplesSince returns [] (no new eligible call this turn),
  // and _turnSeq has advanced from the persisted ledger's currentTurnSeq. The prior turn left a high ΔW.
  const w = fakeWatcher({ turnSeq: 8, foldedSeq: 12, samples: [] });
  setLiveLedger(SID, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 7,
    currentTurnDeltaW: 1.9,  // prior turn's ΔW, near the DW_TURN_BACKSTOP=2 threshold
    lastBillEvent: { kind: 'non_idle_burn', billCount: 1, deltaL: 3000, delivery: 'statusline_pulse', turnSeq: 7 } });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.currentTurnSeq, 8, 'currentTurnSeq followed the real turn even though nothing integrated');
  assert.equal(ledger.currentTurnDeltaW, 0, 'R7-1: prior turn ΔW zeroed on the real advance — no leaked dw_backstop next turn');
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
// `changed`; only the redundant no-op disk write is eliminated here. We OBSERVE writes by deleting the
// checkpoint file after the first (real) write and asserting whether a subsequent advance recreates it.
const LEDGER_FILE = (sid) => join(TMP, 'rate-lamp-state', `${sid}.json`);

test('#6: first poll advance writes, a second no-change advance does NOT rewrite the checkpoint', () => {
  _resetRateLampManagerForTest();                              // clears _ledgers AND the write-elision cache
  const SID6 = 'sid-poll-gate';
  // Seed the DISK only (saveRateLampState bypasses the elision cache), mimicking a fresh process whose first
  // poll hydrates from disk. reliable-latched watcher, NO new folded calls, turn unchanged between calls.
  saveRateLampState(SID6, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4 });
  const w = fakeWatcher({ turnSeq: 5, foldedSeq: 12, samples: [] });
  advanceRateLampToCurrent(w, SID6, { forcePoll: false });     // first advance: cache miss → WRITES, primes cache
  assert.ok(existsSync(LEDGER_FILE(SID6)), 'first advance wrote the checkpoint');
  rmSync(LEDGER_FILE(SID6), { force: true });                  // sentinel: any subsequent write recreates it
  advanceRateLampToCurrent(w, SID6, { forcePoll: false });     // no new call, no turn change → must NOT write
  assert.equal(existsSync(LEDGER_FILE(SID6)), false, 'a no-op poll advance did not rewrite the checkpoint (gate works)');
});

test('#6: an advance that DOES change the ledger still writes (gate never suppresses a real change)', () => {
  _resetRateLampManagerForTest();
  const SID6 = 'sid-poll-gate-change';
  // First: latch with no new call to prime the file + gate snapshot.
  const wIdle = fakeWatcher({ turnSeq: 5, foldedSeq: 12, samples: [] });
  setLiveLedger(SID6, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4, lastBurnRate: 0.5 });
  advanceRateLampToCurrent(wIdle, SID6, { forcePoll: false });
  rmSync(LEDGER_FILE(SID6), { force: true });                  // sentinel
  // Now a genuinely new folded call (seq 13) arrives → the ledger integrates and MUST be persisted.
  const wNew = fakeWatcher({ turnSeq: 6, foldedSeq: 13,
    samples: [{ seq: 13, reliable: true, burnRate: 0.9, L_read: 320000, turnSeq: 6 }] });
  const { ledger } = advanceRateLampToCurrent(wNew, SID6, { forcePoll: false });
  assert.ok(existsSync(LEDGER_FILE(SID6)), 'a real ledger change wrote the checkpoint (gate did not suppress it)');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 13, 'the new call was integrated (cursor advanced)');
});
