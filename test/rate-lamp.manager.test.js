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

import { mergeLedgerIntoStatus, enrichStatusLandmarks,
  advanceRateLampToCurrent, setLiveLedger, getLiveLedger, _resetRateLampManagerForTest,
  flushPendingPersistsSync, getDebugCounters } from '../lib/rate-lamp-manager.js';
import { freshLedger, saveRateLampState, loadRateLampState, stateKeyOf } from '../lib/rate-lamp-store.js';
import { walletIntervalFor, BR_AMBER } from '../lib/bill-regret.js';
import { DEPTH_HOT_LAP_COUNT } from '../lib/constants.js';

// KEY is the real state key stateKeyForStatus computes for segment 0 in v3 (only segment + schema).
// The pure resolveLedgerForKey/merge tests treat it as an opaque key string; the advance tests need it
// to EQUAL advanceRateLampToCurrent's computed currentKey so the ledger is reused, not reset.
const KEY = stateKeyOf({ segmentId: 0, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
const SID = 'sid-manager-test';
// Reducer sample helper. A sample carries the increment the Engine STAMPED on the interval ending at it,
// plus the movable fraction that interval was priced at — never a rate the ledger has to re-derive.
const rs = (seq, deltaW, L_read, turnSeq = 1, mf = 0.3) => ({ seq, reliable: true, deltaW, mf, L_read, turnSeq });

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
          B_default: baselineTotal, bDefault: baselineTotal, gEma,
          mf: 0.3, u: 1.2, pp: 0.02, br: 0.006,
          xSweet: 1.5, xBrAmberL: 1.2, xBrAmberR: 2.0, xBrRedR: 2.6,
          reference: { a: 0.9, d: 0.6, provisional: false } }
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
    ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 0,
    billProgress: 0.42, billCycleCount: 7, currentTurnSeq: 3,
  });
  const history = [rs(1, 5.0, 100000, 1), rs(2, 5.0, 200000, 2), rs(3, 5.0, 300000, 3)];
  const w = frameSource({ turnSeq: 3, foldedSeq: 3, samples: history });

  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.billProgress, 0.42, 'the persisted integral is the sole accumulated-integral authority');
  assert.equal(ledger.billCycleCount, 7, 'and the lifetime cycle count survives with it');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 3, 'the cursor anchored at the frame TAIL — the history is skipped');

  // The first contiguous sample AFTER the reanchored tail integrates its own increment; so does the next.
  const first = advanceRateLampToCurrent(
    frameSource({ turnSeq: 4, foldedSeq: 4, samples: [rs(4, 0.1, 310000, 4)] }), SID, { forcePoll: false });
  assert.ok(Math.abs(first.ledger.billProgress - 0.52) < 1e-9, 'the first later sample integrates its own deltaW');
  const second = advanceRateLampToCurrent(
    frameSource({ turnSeq: 5, foldedSeq: 5, samples: [rs(5, 0.1, 320000, 5)] }), SID, { forcePoll: false });
  assert.ok(Math.abs(second.ledger.billProgress - 0.62) < 1e-9, 'and the next one integrates onto it');
});

test('a NONMATCHING ledger on an unseen revision uses fresh state', () => {
  _resetRateLampManagerForTest();
  saveRateLampState(SID, {
    ...freshLedger(stateKeyOf({ segmentId: 99, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 })),
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
  setLiveLedger(SID, { ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5 });
  // Settle the revision first: the very first frame of a session is always a discontinuity.
  settleRevision(frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] }), SID);

  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 6, foldedSeq: 14, samples: [rs(13, 0.2, 300000, 6), rs(14, 0.2, 310000, 6)] }),
    SID, { forcePoll: false });
  assert.equal(ledger.lastAppliedFoldedCallSeq, 14, 'both contiguous samples drained');
  assert.ok(Math.abs(ledger.billProgress - 0.4) < 1e-9, 'and both increments integrated');
});

test('a folded-call sequence gap takes the same reanchor path and preserves the integral', () => {
  _resetRateLampManagerForTest();
  setLiveLedger(SID, {
    ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 40,
    billProgress: 0.3, billCycleCount: 2,
  });
  settleRevision(frameSource({ turnSeq: 5, foldedSeq: 40, samples: [] }), SID);

  // The frame's cursor is BEHIND the ledger's: a rebuilt stream cannot continue the one already integrated.
  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 5, foldedSeq: 12, samples: [rs(11, 5.0, 200000, 5)] }), SID, { forcePoll: false });
  assert.equal(ledger.billProgress, 0.3, 'accumulated spend survives the gap');
  assert.equal(ledger.billCycleCount, 2);
  assert.equal(ledger.lastAppliedFoldedCallSeq, 12, 're-anchored at the frame tail, so nothing replays');
});

test('an UNRELIABLE frame preserves both integrals, pauses and moves the cursor to the frame tail', () => {
  _resetRateLampManagerForTest();
  const src = frameSource({ turnSeq: 1, foldedSeq: 3, samples: [rs(1, 0.3, 1000), rs(2, 0.3, 2000), rs(3, 0.3, 3000)] });
  settleRevision(src, SID);
  advanceRateLampToCurrent(frameSource({ turnSeq: 1, foldedSeq: 6, samples: [rs(4, 0.3, 4000), rs(5, 0.3, 5000), rs(6, 0.3, 6000)] }), SID);
  const before = getLiveLedger(SID);
  assert.ok(before.billProgress > 0);
  const { ledger } = advanceRateLampToCurrent(frameSource({ turnSeq: 2, foldedSeq: 9, reliable: false, unavailableReason: 'insufficient_data' }), SID);
  assert.equal(ledger.billProgress, before.billProgress);
  assert.equal(ledger.walletPhase, before.walletPhase);
  assert.equal(ledger.pausedReason, 'insufficient_data');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 9);
  assert.equal(ledger.currentTurnSeq, 2, 'the turn cursor still follows the frame');
});

test('the first sample after a reanchor integrates: no anchor frame is consumed', () => {
  _resetRateLampManagerForTest();
  const src = frameSource({ turnSeq: 1, foldedSeq: 2, samples: [rs(1, 0.3, 1000), rs(2, 0.3, 2000)] });
  settleRevision(src, SID);
  const { ledger } = advanceRateLampToCurrent(frameSource({ turnSeq: 1, foldedSeq: 3, samples: [rs(3, 0.4, 3000)] }), SID);
  assert.ok(Math.abs(ledger.billProgress - 0.4) < 1e-9, 'the first contiguous sample after the reanchored tail integrates its own deltaW');
});

test('one stop event per wallet rollover, cleared by the next human turn boundary', () => {
  _resetRateLampManagerForTest();
  const mf = 0.4;
  const interval = walletIntervalFor(mf, BR_AMBER);
  settleRevision(frameSource({ turnSeq: 1, foldedSeq: 1, samples: [rs(1, 0.1, 1000, 1, mf)] }), SID);
  let { ledger } = advanceRateLampToCurrent(frameSource({ turnSeq: 1, foldedSeq: 2, samples: [rs(2, interval * 1.1, 2000, 1, mf)] }), SID);
  assert.equal(ledger.walletLapCount, 1);
  assert.equal(ledger.lastStopEvent.kind, 'backstop');
  assert.equal(ledger.lastStopEvent.billCount, 1);
  ({ ledger } = advanceRateLampToCurrent(frameSource({ turnSeq: 2, foldedSeq: 3, samples: [rs(3, 0.01, 3000, 2, mf)] }), SID));
  assert.equal(ledger.lastStopEvent, null);
});

test('reanchor preserves both clocks on a key match', () => {
  _resetRateLampManagerForTest();
  const mf = 0.4;
  settleRevision(frameSource({ turnSeq: 1, foldedSeq: 1, samples: [rs(1, 0.1, 1000, 1, mf)] }), SID);
  advanceRateLampToCurrent(frameSource({ turnSeq: 1, foldedSeq: 2, samples: [rs(2, 0.6, 2000, 1, mf)] }), SID);
  const before = getLiveLedger(SID);
  const { ledger } = advanceRateLampToCurrent(frameSource({ turnSeq: 1, foldedSeq: 2, samples: [], streamRevision: 2 }), SID);
  assert.equal(ledger.billProgress, before.billProgress);
  assert.equal(ledger.walletPhase, before.walletPhase);
  assert.equal(ledger.walletLapCount, before.walletLapCount);
});

test('R2-4: mergeLedgerIntoStatus refuses a stale-key ledger (no ghost billProgress)', () => {
  const status = { rateLamp: { reliable: true, billProgress: undefined } };
  const stale = { ...freshLedger('k-OLD'), billProgress: 0.7, stateKey: 'k-OLD' };
  const merged = mergeLedgerIntoStatus({ ...status }, stale, KEY);
  assert.equal(merged.rateLamp.billProgress, undefined, 'stale key → not merged');
  const fresh = { ...freshLedger(KEY), billProgress: 0.33, stateKey: KEY };
  const merged2 = mergeLedgerIntoStatus({ rateLamp: { reliable: true } }, fresh, KEY);
  assert.equal(merged2.rateLamp.billProgress, 0.33, 'matching key → merged');
});

// --- round-6 A-group: turnSeq / TTL lifecycle (gemini#1 + GPT#1 + GPT#5) ---
// These exercise advanceRateLampToCurrent against a fake watcher; call _resetRateLampManagerForTest()
// in t.beforeEach so the module-level _ledgers Map does not bleed between tests (GPT#7).

test('R6-A1 (gemini#1): a zero-sample frame still assigns the frame turn', () => {
  _resetRateLampManagerForTest();
  // Settle the revision FIRST: a session's first frame is always a discontinuity, and a discontinuity moves
  // the cursor outright — which would prove a different thing than the assignment this test is about.
  settleRevision(frameSource({ turnSeq: 7, foldedSeq: 12, samples: [] }), SID);
  setLiveLedger(SID, {
    ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 7,
  });

  // Reliable, no new eligible call, and the Engine turn has moved. The assignment happens after EVERY frame.
  const { ledger } = advanceRateLampToCurrent(
    frameSource({ turnSeq: 8, foldedSeq: 12, samples: [] }), SID, { forcePoll: false });
  assert.equal(ledger.currentTurnSeq, 8, 'currentTurnSeq followed the frame turn even though nothing integrated');
});

test('R6-A3 (GPT#5): a restart carries no stop alert across its first advance', () => {
  _resetRateLampManagerForTest();
  // Persist a ledger carrying a stop alert, then simulate a fresh process (empty _ledgers). The stream
  // revision is process-local too, so this first advance both hydrates and re-anchors, and each of those
  // clears the alert on its own. This case pins their CONJUNCTION and is its only guard: delete either
  // clear and it stays green, delete both and it reds.
  saveRateLampState(SID, { ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 5,
    lastStopEvent: { kind: 'backstop', delivery: 'reader_path', message: 'old', billCount: 0, seq: 3 } });
  const w = frameSource({ turnSeq: 0, foldedSeq: 3, samples: [] }); // restart: watcher turnSeq starts at 0
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(ledger.lastStopEvent, null, 'GPT#5: stop alert did not resurrect across the process boundary');
});

// R6-A2 is DELETED. It pinned hydration raising the watcher's turn counter from the persisted cursor, and
// hydration may no longer modify Engine or application state at all: Engine state is the only `turnSeq`
// authority, and the persisted `currentTurnSeq` is a consumer cursor that FOLLOWS the frame. A rebuild can
// legitimately land on a lower turn than the ledger last saw, so the cursor is permitted to decrease.
test('the persisted turn cursor follows the frame and may decrease', () => {
  _resetRateLampManagerForTest();
  saveRateLampState(SID, { ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 50 });
  const w = frameSource({ turnSeq: 1, foldedSeq: 3, samples: [] });
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  assert.equal(w.readRateLampFrame(0).turnSeq, 1, 'the Engine turn is untouched by hydration');
  assert.equal(ledger.currentTurnSeq, 1, 'the ledger cursor took the frame turn, downwards');
});

// --- per-poll disk write gated on an actual ledger change ---
// advanceRateLampToCurrent runs on every tick past the idle gate, so without the gate an unchanged ledger
// would be rewritten every tick. The gate covers the disk write alone — the SSE emit has its own `changed`
// gate. Writes are OBSERVED through getDebugCounters().diskWrites (reset by _resetRateLampManagerForTest) —
// SQLite-compatible, no file sentinel needed.

test('first poll advance writes, a second no-change advance does NOT rewrite the checkpoint', () => {
  _resetRateLampManagerForTest();                              // clears _ledgers, write-elision cache, AND counters
  const SID6 = 'sid-poll-gate';
  // Seed the store only (saveRateLampState bypasses the elision cache), mimicking a fresh process whose first
  // poll hydrates from the store. reliable-latched watcher, NO new folded calls, turn unchanged between calls.
  saveRateLampState(SID6, { ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4 });
  const w = frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] });
  advanceRateLampToCurrent(w, SID6, { forcePoll: false });     // first advance: cache miss → WRITES, primes cache
  flushPendingPersistsSync();                                  // flush write-behind so counter reflects the write
  const writesAfterFirst = getDebugCounters().diskWrites;
  assert.ok(writesAfterFirst >= 1, 'first advance wrote the checkpoint (diskWrites incremented)');
  advanceRateLampToCurrent(w, SID6, { forcePoll: false });     // no new call, no turn change → must NOT write
  flushPendingPersistsSync();                                  // flush: if anything was enqueued, it fires now
  assert.equal(getDebugCounters().diskWrites, writesAfterFirst, 'a no-op poll advance did not rewrite the checkpoint (gate works)');
});

test('an advance that DOES change the ledger still writes (gate never suppresses a real change)', () => {
  _resetRateLampManagerForTest();
  const SID6 = 'sid-poll-gate-change';
  // First: latch with no new call to prime the store + gate snapshot.
  const wIdle = frameSource({ turnSeq: 5, foldedSeq: 12, samples: [] });
  setLiveLedger(SID6, { ...freshLedger(KEY), stateKey: KEY, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, billProgress: 0.4 });
  advanceRateLampToCurrent(wIdle, SID6, { forcePoll: false });
  flushPendingPersistsSync(); // C5a: write-behind flush
  const writesBeforeChange = getDebugCounters().diskWrites;
  // Now a genuinely new folded call (seq 13) arrives → the ledger integrates and MUST be persisted.
  const wNew = frameSource({ turnSeq: 6, foldedSeq: 13, samples: [rs(13, 0.09, 320000, 6)] });
  const { ledger } = advanceRateLampToCurrent(wNew, SID6, { forcePoll: false });
  flushPendingPersistsSync(); // C5a: write-behind → flush to verify the write happens
  assert.ok(getDebugCounters().diskWrites > writesBeforeChange, 'a real ledger change wrote the checkpoint (gate did not suppress it)');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 13, 'the new call was integrated (cursor advanced)');
});

// --- rentMeter render object ---

test('mergeLedgerIntoStatus maps the ledger onto the wire and builds rentMeter from the wallet clock', () => {
  const status = { rateLamp: { reliable: true, C_RATIO: 10, L_read: 300000, B_post: 250000, B_rebuild: 250000, B_default: 250000, gEma: 940, mf: 0.4, mfLocal: 0.25 } };
  const ledger = { ...freshLedger(KEY), billProgress: 0.35, billCycleCount: 4, walletPhase: 0.6, walletLapCount: 3, currentTurnSeq: 7 };
  mergeLedgerIntoStatus(status, ledger, KEY);
  const rl = status.rateLamp, rm = rl.rentMeter;
  assert.equal(rl.billProgress, 0.35);
  assert.equal(rm.cycleProgress, 0.35);
  assert.equal(rm.depthActive, true);
  assert.equal(rm.depthProgress, 0.6);
  // The interval shown is the wallet clock's own unit: the local exchange rate the samples integrate at, not
  // the path-weighted mf the lamp reads.
  assert.equal(rm.backstopInterval, walletIntervalFor(0.25, BR_AMBER));
  assert.equal(rm.backstopLapCount, 3);
  assert.equal(rm.depthHot, 3 >= DEPTH_HOT_LAP_COUNT);
  for (const gone of ['rentRate', 'sweetRentRate']) assert.equal(gone in rm, false, gone);
  for (const gone of ['hasDeepWaterGateFired', 'dwBillsSinceLastAlert', 'inDeepWater', 'deepWaterDisplayLatched', 'lBase', 'backstopLapCount']) assert.equal(gone in rl, false, gone);
  assert.equal(rl.wallP, 11);
});

test('enrichStatusLandmarks fills only wallP and computes no landmark', () => {
  const status = { rateLamp: { reliable: true, C_RATIO: 10, L_read: 300000, B_post: 250000, B_default: 240000, gEma: 940 } };
  enrichStatusLandmarks(status);
  assert.equal(status.rateLamp.wallP, 11);
  for (const absent of ['lBase', 'xSweet', 'xBrAmberL', 'xBrAmberR', 'xBrRedR', 'dhat', 'mf', 'br']) assert.equal(absent in status.rateLamp, false, absent);
});

test('rentMeter is present with null-safe defaults when status is unreliable', () => {
  const status = { rateLamp: { reliable: false } };
  mergeLedgerIntoStatus(status, null, 'k');
  assert.ok(status.rateLamp.rentMeter, 'rentMeter present even when unreliable');
  assert.equal(status.rateLamp.rentMeter.depthActive, false, 'depthActive defaults false');
  assert.equal(status.rateLamp.rentMeter.cycleProgress, 0, 'cycleProgress defaults 0');
  assert.equal(status.rateLamp.rentMeter.depthProgress, 0, 'depthProgress defaults 0');
  assert.equal(status.rateLamp.rentMeter.backstopInterval, null, 'backstopInterval defaults null');
  assert.equal(status.rateLamp.rentMeter.backstopLapCount, 0, 'backstopLapCount defaults 0');
  assert.equal(status.rateLamp.rentMeter.depthHot, false, 'depthHot defaults false');
});

// ── Manager-level round trip ─────────────────────────────────────────────────

test('a ledger this manager persisted reloads with every schema field intact', () => {
  _resetRateLampManagerForTest();
  settleRevision(frameSource({ turnSeq: 1, foldedSeq: 1, samples: [rs(1, 0.1, 1000)] }), SID);
  advanceRateLampToCurrent(frameSource({ turnSeq: 1, foldedSeq: 2, samples: [rs(2, 0.6, 2000)] }), SID);
  flushPendingPersistsSync();
  const live = getLiveLedger(SID);
  assert.equal(live.billProgress, 0.6, 'precondition: the contiguous sample integrated its stamped increment');
  const disk = loadRateLampState(SID);
  assert.deepEqual(disk, live);
  assert.equal(disk.schemaVersion, 3);
});
