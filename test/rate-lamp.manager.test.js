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

import { mergeLedgerIntoStatus,
  advanceRateLampToCurrent, setLiveLedger, getLiveLedger, _resetRateLampManagerForTest,
  flushPendingPersistsSync, getDebugCounters } from '../lib/rate-lamp-manager.js';
import { freshLedger, saveRateLampState, loadRateLampState, stateKeyOf } from '../lib/rate-lamp-store.js';

// KEY is the real state key stateKeyForStatus computes for segment 0 in v3 (only segment + schema).
// The pure resolveLedgerForKey/merge tests treat it as an opaque key string; the advance tests need it
// to EQUAL advanceRateLampToCurrent's computed currentKey so the ledger is reused, not reset.
const KEY = stateKeyOf({ segmentId: 0, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
const SID = 'sid-manager-test';
// reducer sample helper (New#3 re-anchor tests) — field is L_read, the step's measured L, never cacheRead.
const rs = (seq, burnRate, L_read, turnSeq = 1) => ({ seq, reliable: true, burnRate, L_read, turnSeq });

// The manager's ONLY input is one coherent frame, so the fake exposes exactly `readRateLampFrame` and its
// return SHAPE matches the real method's: status, progress, samples, the Engine turn, the folded cursor and
// the process-local stream revision. Nothing here has a `poll`, a private field, or a second sample method —
// the manager cannot reach any of those any more, and a fake that offered them would teach the wrong contract.
function frameSource({
  turnSeq, foldedSeq, samples = [], reliable = true, unavailableReason,
  cRatio = 10, gEma = 940, L_read = 300000, L_cap = 1000000, baselineTotal = 250000,
  segment = 0, streamRevision = 1,
} = {}) {
  return {
    readRateLampFrame(sinceFoldedSeq) {
      const status = reliable
        ? { reliable: true, C_RATIO: cRatio, L_cap, L_read, B_post: baselineTotal, B_rebuild: baselineTotal,
          B_default: baselineTotal, gEma }
        : { reliable: false, unavailableReason };
      return {
        status,
        progress: { segment, measuredCalls: samples.length, sinceFoldedSeq },
        samples,
        turnSeq,
        foldedCallSeq: foldedSeq,
        streamRevision,
      };
    },
  };
}

// The revision the manager has already SEEN for a session. A first frame is always an unseen revision, which
// is a discontinuity — so a test that means to exercise the ordinary contiguous drain has to get past that
// first frame before asserting on integration.
function settleRevision(source, sid) {
  advanceRateLampToCurrent(source, sid, { forcePoll: false });
}

// ── Stream continuity ────────────────────────────────────────────────────────
// A `streamRevision` change is sample-stream discontinuity, independently of capture mode and of state-key
// equality. It is what a replace, a rotate, and the append that first observes a Source all produce, and it
// is what makes a fresh process skip the history its persisted integral already covers.

test('a first, unseen revision on a MATCHING ledger preserves the integral and skips the frame history', () => {
  _resetRateLampManagerForTest();
  // A cold start: the persisted ledger matches the current segment and already carries accumulated spend,
  // and the frame arrives holding the whole startup history.
  saveRateLampState(SID, {
    ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 0,
    billProgress: 0.42, billCycleCount: 7, currentTurnSeq: 3,
  });
  const history = [rs(1, 5.0, 100000, 1), rs(2, 5.0, 200000, 2), rs(3, 5.0, 300000, 3)];
  const w = frameSource({ turnSeq: 3, foldedSeq: 3, samples: history });

  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.billProgress, 0.42, 'the persisted integral is the sole accumulated-integral authority');
  assert.equal(ledger.billCycleCount, 7, 'and the lifetime cycle count survives with it');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 3, 'the cursor anchored at the frame TAIL — the history is skipped');
  assert.equal(ledger.lastBurnRate, null, 'the burn anchor is cleared, so nothing integrates across the break');

  // The first LATER reliable call establishes the new anchor; the second performs one integration.
  const first = advanceRateLampToCurrent(
    frameSource({ turnSeq: 4, foldedSeq: 4, samples: [rs(4, 0.5, 310000, 4)] }), SID, { forcePoll: false });
  assert.equal(first.ledger.billProgress, 0.42, 'the first new call only anchors');
  assert.equal(first.ledger.lastBurnRate, 0.5, 'and it is the anchor');
  const second = advanceRateLampToCurrent(
    frameSource({ turnSeq: 5, foldedSeq: 5, samples: [rs(5, 0.5, 320000, 5)] }), SID, { forcePoll: false });
  assert.ok(second.ledger.billProgress > 0.42, 'the second call integrates exactly one trapezoid');
});

test('a NONMATCHING ledger on an unseen revision uses fresh state', () => {
  _resetRateLampManagerForTest();
  saveRateLampState(SID, {
    ...freshLedger(stateKeyOf({ segmentId: 99, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 }), 0),
    lastAppliedFoldedCallSeq: 9, billProgress: 0.8, billCycleCount: 4,
  });
  const w = frameSource({ turnSeq: 2, foldedSeq: 4, samples: [rs(4, 5.0, 300000, 2)] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.stateKey, KEY, 're-keyed to the current segment');
  assert.equal(ledger.billProgress, 0, 'a nonmatching ledger contributes no integral');
  assert.equal(ledger.billCycleCount, 0);
  assert.equal(ledger.lastAppliedFoldedCallSeq, 4, 'anchored at the frame tail');
});

test('an UNCHANGED revision drains contiguous new samples and integrates them', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, { ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5 });
  // Settle the revision first: the very first frame of a session is always a discontinuity.
  settleRevision(frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] }), SID);

  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 6, foldedSeq: 14, samples: [rs(13, 0.5, 300000, 6), rs(14, 0.5, 310000, 6)] }),
    SID, { forcePoll: false });
  assert.equal(ledger.lastAppliedFoldedCallSeq, 14, 'both contiguous samples drained');
  assert.ok(ledger.billProgress > 0, 'and the second one integrated against the first');
});

test('a folded-call sequence gap takes the same reanchor path and preserves the integral', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, {
    ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 40,
    billProgress: 0.3, billCycleCount: 2, lastBurnRate: 0.9,
  });
  settleRevision(frameSource({ turnSeq: 5, foldedSeq: 40, samples: [] }), SID);

  // The frame's cursor is BEHIND the ledger's: a rebuilt stream cannot continue the one already integrated.
  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 5, foldedSeq: 12, samples: [rs(11, 5.0, 200000, 5)] }), SID, { forcePoll: false });
  assert.equal(ledger.billProgress, 0.3, 'accumulated spend survives the gap');
  assert.equal(ledger.billCycleCount, 2);
  assert.equal(ledger.lastAppliedFoldedCallSeq, 12, 're-anchored at the frame tail, so nothing replays');
  assert.equal(ledger.lastBurnRate, null, 'the burn anchor is cleared');
});

test('an UNRELIABLE frame preserves the integral and clears the burn anchor', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, {
    ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 12,
    billProgress: 0.55, billCycleCount: 3, lastBurnRate: 0.7,
  });
  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 6, foldedSeq: 13, reliable: false, unavailableReason: 'insufficient_data' }),
    SID, { forcePoll: false });
  assert.equal(ledger.billProgress, 0.55, 'the integral is untouched');
  assert.equal(ledger.billCycleCount, 3);
  assert.equal(ledger.lastBurnRate, null, 'the anchor is cleared so recovery re-anchors');
  assert.equal(ledger.pausedReason, 'insufficient_data');
  assert.equal(ledger.currentTurnSeq, 6, 'the turn cursor still follows the frame');
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

// --- round-6 A-group: turnSeq / TTL lifecycle (gemini#1 + GPT#1 + GPT#5) ---
// These exercise advanceRateLampToCurrent against a fake watcher; call _resetRateLampManagerForTest()
// in t.beforeEach so the module-level _ledgers Map does not bleed between tests (GPT#7).

test('R6-A1 (gemini#1): a zero-sample frame still assigns the frame turn', () => {
  _resetRateLampManagerForTest();
  // Settle the revision FIRST: a session's first frame is always a discontinuity, and a discontinuity clears
  // the pulse outright — which would prove a different thing than the TTL this test is about.
  settleRevision(frameSource({ turnSeq: 7, foldedSeq: 12, samples: [] }), SID);
  // Now seed the pulse on the settled stream, at the turn the ledger currently sits on.
  setLiveLedger(SID, {
    ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 7,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 1, deltaL: 3000, delivery: 'statusline_pulse', turnSeq: 7 },
  });

  // Reliable, no new eligible call, and the Engine turn has moved. The assignment happens after EVERY frame.
  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 8, foldedSeq: 12, samples: [] }), SID, { forcePoll: false });
  assert.equal(ledger.currentTurnSeq, 8, 'currentTurnSeq followed the frame turn even though nothing integrated');
});

test('R6-A3 (GPT#5): a restart carries neither pulse across its first advance', () => {
  _resetRateLampManagerForTest();
  // Persist a ledger carrying both pulses, then simulate a fresh process (empty _ledgers). The stream
  // revision is process-local too, so this first advance both hydrates and re-anchors, and each of those
  // clears the pulses on its own. This case pins their CONJUNCTION and is its only guard: delete either
  // clear and it stays green, delete both and it reds.
  saveRateLampState(SID, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 5,
    lastBillEvent: { kind: 'non_idle_burn', billCount: 1, deltaL: 3000, delivery: 'statusline_pulse', turnSeq: 5 },
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message: 'old', billCount: 0, turnSeq: 5 } });
  const w = frameSource({ turnSeq: 0, foldedSeq: 3, samples: [] }); // restart: watcher turnSeq starts at 0
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.lastStopEvent, null, 'GPT#5: stop alert did not resurrect across the process boundary');
  assert.equal(ledger.lastBillEvent, null, 'the bill pulse did not resurrect either');
});

// R6-A2 is DELETED. It pinned hydration raising the watcher's turn counter from the persisted cursor, and
// hydration may no longer modify Engine or application state at all: Engine state is the only `turnSeq`
// authority, and the persisted `currentTurnSeq` is a consumer cursor that FOLLOWS the frame. A rebuild can
// legitimately land on a lower turn than the ledger last saw, so the cursor is permitted to decrease.
test('the persisted turn cursor follows the frame and may decrease', () => {
  _resetRateLampManagerForTest();
  saveRateLampState(SID, { ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 50 });
  const w = frameSource({ turnSeq: 1, foldedSeq: 3, samples: [] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(w.readRateLampFrame(0).turnSeq, 1, 'the Engine turn is untouched by hydration');
  assert.equal(ledger.currentTurnSeq, 1, 'the ledger cursor took the frame turn, downwards');
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
  const w = frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] });
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
  const wIdle = frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] });
  setLiveLedger(SID6, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4, lastBurnRate: 0.5 });
  advanceRateLampToCurrent(wIdle, SID6, { forcePoll: false });
  flushPendingPersistsSync(); // C5a: write-behind flush
  const writesBeforeChange = getDebugCounters().diskWrites;
  // Now a genuinely new folded call (seq 13) arrives → the ledger integrates and MUST be persisted.
  const wNew = frameSource({ turnSeq: 6, foldedSeq: 13,
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

// ── Manager-level round trip ─────────────────────────────────────────────────

test('a ledger this manager persisted reloads with every schema-v2 field intact', () => {
  _resetRateLampManagerForTest();
  const SIDR = 'sid-roundtrip';
  saveRateLampState(SIDR, { ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 0 });
  // Settle the revision on an EMPTY frame: a first frame is a discontinuity, and its samples would be skipped.
  settleRevision(frameSource({ turnSeq: 0, foldedSeq: 0, samples: [] }), SIDR);
  // The first later reliable call establishes the anchor; the second is the one that integrates.
  advanceRateLampToCurrent(
    frameSource({ turnSeq: 1, foldedSeq: 1, samples: [rs(1, 0.6, 100000, 1)] }), SIDR, { forcePoll: false });
  advanceRateLampToCurrent(
    frameSource({ turnSeq: 2, foldedSeq: 2, samples: [rs(2, 0.6, 200000, 2)] }), SIDR, { forcePoll: false });
  flushPendingPersistsSync();
  const persisted = getLiveLedger(SIDR);
  assert.ok(persisted.billProgress > 0, 'precondition: something was actually integrated');

  // A fresh process state: the in-memory copy is gone and the disk copy is the only authority.
  _resetRateLampManagerForTest();
  const reloaded = loadRateLampState(SIDR);
  assert.ok(reloaded, 'the persisted ledger reloads through its own validator');
  assert.equal(reloaded.billProgress, persisted.billProgress);
  assert.equal(reloaded.billCycleCount, persisted.billCycleCount);
  for (const field of Object.keys(freshLedger(KEY, 0))) {
    assert.ok(field in reloaded, `schema-v2 field ${field} survived the round trip`);
  }
});

test('a non-null pausedReason takes the recovering branch on the next reliable sample and integrates nothing', () => {
  _resetRateLampManagerForTest();
  const SIDP = 'sid-paused';
  setLiveLedger(SIDP, {
    ...freshLedger(KEY, 0), stateKey: KEY, lastAppliedFoldedCallSeq: 12,
    billProgress: 0.33, pausedReason: 'insufficient_data', lastBurnRate: null,
  });
  settleRevision(frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] }), SIDP);

  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 6, foldedSeq: 13, samples: [rs(13, 0.9, 300000, 6)] }), SIDP, { forcePoll: false });
  assert.equal(ledger.pausedReason, null, 'the recovering branch cleared the pause');
  assert.equal(ledger.billProgress, 0.33, 'and integrated nothing — it only re-anchored');
  assert.equal(ledger.lastBurnRate, 0.9, 'the recovered sample IS the new anchor');
});
