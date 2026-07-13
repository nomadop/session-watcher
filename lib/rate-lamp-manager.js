import { freshLedger, applyFoldedCallSample, settleMeterAtBoundary, stateKeyForStatus, loadRateLampState, saveRateLampState, matchPendingToSummary, expirePending, resolveStopMessageFromSummary, chooseCurrentStopSummary, pushStopEventRing } from './rate-lamp-store.js';
import { deriveFrozenExit } from './rate-lamp.js';
import { cRatioFor } from './extract.js';                 // G3: objective C_RATIO fallback (unreliable frame omits the mirror field)
import { deepWaterDisplay } from './deep-water-display.js'; // H-pt4/B9: DISPLAY hysteresis latch (extracted from public/chart-helpers.js)
import { validateLedgerState } from './ledger-schema.js';
import { landmarksFor, bandOf } from './landmarks.js';    // A2: kAvg-axis band for the region lamp (shallow↔sweet only)
import { STOP_ADVANCE_MAX_MS, STOP_ADVANCE_MAX_BYTES, COALESCED_PERSIST_MS } from './constants.js';

// ── Per-call EMA (alpha=0.5): tracks recent growth rate per API call ──────────
const EMA_ALPHA = 0.5;
const _perCallEma = new Map(); // currentKey → { prevL, ema, callsSinceAnchor, lastSeq }

/**
 * Pure function operating on a mutable state object.
 * Updates the per-call EMA given a new L reading.
 * Returns the current EMA value (or null if only seeding on first call).
 * Negative ΔL is clamped to 0 (context doesn't shrink in normal operation).
 */
export function updatePerCallEma(state, { L }) {
  if (!Number.isFinite(L)) return state.ema;
  if (state.prevL === null) {
    // First call: seed only
    state.prevL = L;
    state.callsSinceAnchor = 1;
    return null;
  }
  const delta = Math.max(0, L - state.prevL);
  state.prevL = L;
  state.callsSinceAnchor++;
  if (state.ema === null) {
    state.ema = delta; // first delta = initial EMA
  } else {
    state.ema = EMA_ALPHA * delta + (1 - EMA_ALPHA) * state.ema;
  }
  return state.ema;
}


export function computeTargetL({ band, lBase, xEntry, xExit, lCap }) {
  if (!Number.isFinite(lBase) || !Number.isFinite(lCap)) return null;
  let target = null;
  if (band === 'below_entry') {
    if (!Number.isFinite(xEntry)) return null;
    target = lBase * xEntry;
  } else if (band === 'entry_to_sweet' || band === 'sweet_to_exit') {
    if (!Number.isFinite(xExit)) return null;
    target = lBase * xExit;
  } else if (band === 'above_exit') {
    target = lCap;
  } else {
    return null;
  }
  return Math.min(target, lCap);
}

// In-memory single writer (round-2 Option A). One ledger per session lives here; the file is a
// checkpoint. Poll loop, Stop route, and /api/status all mutate/read ONLY through this module — no
// other code does an independent file load-modify-save (that races: a stale poll save resurrects a
// bill the Stop route just cleared → duplicate settlement, round-2 GPT#10).
const _ledgers = new Map(); // sessionId → ledger (authoritative live copy)
// #6 (fix wave): per-session snapshot of the LAST serialization written to disk. advanceRateLampToCurrent
// runs once per poll (~1 Hz); pre-fix it re-wrote an identical checkpoint every call (~86k no-op
// rewrites/day/session). persistLedger() below compares the new serialization to this snapshot and skips
// the disk write when they match — the ledger stays the source of truth, writeJsonAtomic stays the ONLY
// writer, and the write still happens on every REAL change (new call, turn advance, settle, pause).
const _lastSaved = new Map(); // sessionId → JSON string last persisted (write-elision cache)
// v2.2-C (schema v2): per-session snapshot of the ledgerRevision last known to be on disk. PROCESS-ONLY —
// NEVER serialized into the ledger (freshLedger omits it; validateLedgerState never reads it). Seeded on a
// disk hydrate to the loaded ledgerRevision; the C5a persist-time revision gate (a later sub-batch) reads
// it to reject a stale write-behind snapshot that would clobber a newer alert. C1-1 only PRODUCES the map.
const _lastPersistedRevision = new Map(); // sessionId → last-persisted ledgerRevision (process-only)

// v2.2-C5a: coalesced write-behind infrastructure.
// pendingPersistSids records ONLY the sid (red line #5: NEVER a captured snapshot). The coalesced timer
// re-reads _ledgers.get(sid) at flush time so it always writes the LATEST state.
const _pendingPersistSids = new Set();
// ENOSPC pause state: a session enters pause when a persist throw is caught. While paused, schedulePersist
// skips the sid. The Stop route's force-write acts as the recovery probe (B6: no new timer).
const _enospcPaused = new Set(); // sessionId → paused (disk failure engaged)

// Observability counters (C5a step 4): O(1) integer increments, debug-only, NEVER MCP.
const _counters = {
  diskWrites: 0,
  coalesceHits: 0,       // schedulePersist calls that joined an existing pending
  coalesceMisses: 0,     // schedulePersist calls that added a new pending
  revisionGateBlocks: 0, // writes refused by the revision gate
  enospcEngagements: 0,
  enospcRecoveries: 0,
  // Step 4 counters (spec-required):
  stopAdvanceAttemptCount: 0,     // boundedIncrementalAdvance entries
  stopAdvanceCaughtUpCount: 0,    // advance completed (caughtUp === true)
  stopAdvanceTimeoutCount: 0,     // advance broke on maxMs budget
  stopAdvanceMaxBytesHitCount: 0, // not applicable in poll-based mode (always 0)
  pendingCreatedCount: 0,         // enqueuePending calls that succeeded
  pendingDrainedCount: 0,         // assigned matches in drainPendingStopEvaluations
  pendingExpiredCount: 0,         // expired entries in drainPendingStopEvaluations
};

// Test-injection seams (A20): override the coalesced timer's writer, scheduler, and clock.
let _testWriter = null;   // (path, obj) => void — replaces saveRateLampState
let _testScheduler = null; // (fn, ms) => timerRef — replaces setInterval
let _testNowMono = null;  // () => number — replaces performance.now for TTL/mono judgments
// Internal accessor: production uses performance.now(); tests can override via _setRateLampManagerTestHooks
function _nowMono() { return _testNowMono ? _testNowMono() : performance.now(); }

// The actual coalesced timer ref (module-level singleton)
let _coalescedTimer = null;

function _startCoalescedTimer() {
  if (_coalescedTimer) return; // already running
  const schedulerFn = _testScheduler || setInterval;
  _coalescedTimer = schedulerFn(_flushCoalescedPersist, COALESCED_PERSIST_MS);
  if (_coalescedTimer && typeof _coalescedTimer.unref === 'function') _coalescedTimer.unref();
}

// B11: the entire timer callback body is wrapped in try/catch — a JSON.stringify/write throw inside a
// setInterval callback would otherwise escape to the event loop and crash the process.
function _flushCoalescedPersist() {
  for (const sid of _pendingPersistSids) {
    // ENOSPC pause: skip this sid (its write-behind is blocked; recovery rides the Stop force-write)
    if (_enospcPaused.has(sid)) continue;
    try {
      const ledger = _ledgers.get(sid);
      if (!ledger) { _pendingPersistSids.delete(sid); continue; }
      persistLedger(sid, ledger); // write-elision + revision gate apply normally
    } catch (e) {
      // Disk failure → engage ENOSPC pause for this session (non-MCP diagnostic)
      _enospcPaused.add(sid);
      _counters.enospcEngagements++;
      if (process.env.SW_DEBUG) console.error(`[rate-lamp] ENOSPC pause engaged for ${sid}:`, e.message);
    }
  }
  _pendingPersistSids.clear();
}

// Test/shutdown helper: synchronously flush all pending persists NOW (no timer wait).
// Used by existing tests that assert on file existence after advance, and by flushAll on shutdown.
export function flushPendingPersistsSync() { _flushCoalescedPersist(); }

// The coalesced write-behind entry (spec §5.2, C5a): marks the sid dirty. At the next timer tick, the
// flush re-reads _ledgers.get(sid) — NEVER captures a snapshot (red line #5).
export function schedulePersist(sessionId) {
  if (_enospcPaused.has(sessionId)) return; // paused session: write-behind blocked (safe: recomputable)
  if (_pendingPersistSids.has(sessionId)) {
    _counters.coalesceHits++;
  } else {
    _counters.coalesceMisses++;
    _pendingPersistSids.add(sessionId);
  }
  _startCoalescedTimer();
}

// Stop route calls this before its synchronous alert write to eliminate the interleave window.
export function cancelCoalescedPersist(sessionId) {
  _pendingPersistSids.delete(sessionId);
}

// Query ENOSPC pause state (exported for tests + the /api/notify-gate ENOSPC probe branch in server.js)
export function isEnospcPaused(sessionId) { return _enospcPaused.has(sessionId); }

// Clear ENOSPC pause (called after a successful probe force-write in the Stop route)
export function clearEnospcPause(sessionId) {
  _enospcPaused.delete(sessionId);
  _counters.enospcRecoveries++;
}

// Re-engage ENOSPC pause (called when drain-after-probe re-hits disk failure — round-8 GPT-pt5)
export function engageEnospcPause(sessionId) {
  _enospcPaused.add(sessionId);
  _counters.enospcEngagements++;
}

// The single persistence entry inside the manager (single-writer invariant). Gated: writes only when the
// serialized ledger differs from what we last wrote for this session, UNLESS force is set. `force` is used
// by the explicit set-and-persist paths (setLiveLedger from the Stop route) so a caller that deliberately
// pushes a ledger always lands on disk; the per-poll advance path leaves force off so a no-op poll elides.
// C5a revision gate: refuses to write a revision <= the last-persisted revision (intra-process only).
export function persistLedger(sessionId, ledger, { force = false } = {}) {
  // C5a revision gate (intra-process only, C-corr-1): refuse a stale write-behind snapshot
  const ledgerRev = ledger.ledgerRevision ?? 0;
  const lastPersistedRev = _lastPersistedRevision.get(sessionId) ?? 0;
  if (!force && ledgerRev < lastPersistedRev) {
    // Stale write — the normal coalesce race (low-noise warn). Never MCP.
    _counters.revisionGateBlocks++;
    if (process.env.SW_DEBUG) console.error(`[rate-lamp] revision gate: refusing rev ${ledgerRev} <= last-persisted ${lastPersistedRev} for ${sessionId}`);
    return;
  }
  if (ledgerRev === lastPersistedRev && !force) {
    // Same revision, not forced: check for escaped mutation (B5/H-C dead-letter diagnostic).
    // If content DIFFERS from _lastSaved yet carries the same revision → mutateLedger was bypassed
    // (an invariant breach). Emit a LOUD diagnostic (always, not just SW_DEBUG) and refuse the write.
    const savedContent = _lastSaved.get(sessionId);
    if (savedContent !== undefined) {
      if (JSON.stringify(ledger) !== savedContent) {
        _counters.revisionGateBlocks++;
        console.error(`[rate-lamp] DEAD-LETTER: escaped mutation for ${sessionId} — content differs at same revision ${ledgerRev}. mutateLedger was bypassed (invariant breach).`);
      }
      return; // same revision + previously saved: refuse (either content matches → no-op, or dead-letter → block)
    }
    // No previous save at this revision: fall through to first-write path (normal for fresh sessions)
  }

  // C-corr-2: re-stringify AFTER the revision gate check. persistLedger always serializes the ledger
  // it receives — the caller (mutateLedger) has already bumped ledgerRevision, so this string is fresh.
  const serialized = JSON.stringify(ledger);
  if (!force && _lastSaved.get(sessionId) === serialized) return; // identical to last write → skip the redundant rewrite

  // Perform the actual write (through test seam or production path)
  if (_testWriter) {
    _testWriter(sessionId, ledger);
  } else {
    saveRateLampState(sessionId, ledger);
  }
  _lastSaved.set(sessionId, serialized);
  _lastPersistedRevision.set(sessionId, ledgerRev);
  _counters.diskWrites++;
}

// round-7 GPT#1: advance the ledger's turn cursor WITHOUT running the reducer, and — crucially — zero
// currentTurnDeltaW when the turn actually moves forward. The reducer's A3 per-turn ΔW reset only fires
// on an INTEGRATED sample; a real turn with zero rate-lamp-eligible folded calls never reaches the reducer,
// so without this the PRIOR turn's currentTurnDeltaW leaks into the new turn and the Stop route can read it
// as `dwTurn` → a spurious `dw_backstop`. Every "no-reducer turn sync" site (resolve reuse/mismatch branch +
// the advance final sync) MUST go through this so the invariant holds in one place.
function syncLedgerTurn(ledger, watcherTurnSeq) {
  const prev = ledger.currentTurnSeq ?? 0;
  if (watcherTurnSeq > prev) return { ...ledger, currentTurnSeq: watcherTurnSeq, currentTurnDeltaW: 0 };
  return { ...ledger, currentTurnSeq: Math.max(prev, watcherTurnSeq) };
}

// DRY helper: the same 3-line if/else turn-cursor sync used in mutateLedger callbacks.
// Mutates `l` in place (l is a mutateLedger draft).
function syncTurnCursorOnDraft(l, targetTurnSeq) {
  const prev = l.currentTurnSeq ?? 0;
  if (targetTurnSeq > prev) { l.currentTurnSeq = targetTurnSeq; l.currentTurnDeltaW = 0; }
  else { l.currentTurnSeq = Math.max(prev, targetTurnSeq); }
}

// Pure key resolution (round-2 GPT#1/#3). NEVER integrates — only positions the ledger.
// New#3 (fix wave): break the seq_history_mismatch deadlock by re-anchoring the ledger in place instead
// of parking it in a pause that nothing clears. Distinct from anchorFresh (which zeroes billCycleCount):
// here billCycleCount is a LIFETIME counter with a planned dashboard display, so a silent reset would
// surface as an N→0 jump on restart — we PRESERVE it, and keep billProgress for seamless continuity.
// Everything else re-anchors to NOW so integration resumes from the next genuinely-new call with no
// replay of already-settled history (the double-settlement the pause guarded against).
function reanchorOnMismatch(persisted, { watcherFoldedSeq, watcherTurnSeq, lReadNow }) {
  if (process.env.SW_DEBUG) console.error('[rate-lamp] seq mismatch → re-anchored, cycleCount preserved');
  return {
    ...persisted,
    // PRESERVED: billCycleCount (lifetime/dashboard) + billProgress (remainder continuity) + kStableFrozen + stateKey.
    lastAppliedFoldedCallSeq: watcherFoldedSeq, // from-now integration, no catch-up (P0-5)
    billAnchorFoldedCallSeq: watcherFoldedSeq,
    billAnchorLRead: lReadNow,
    billAnchorTurnSeq: watcherTurnSeq,
    pendingBillCountSinceBoundary: 0,           // pending across a seq break is untrustworthy → drop it (no phantom Stop bill)
    // Null lastBurnRate AND lastAppliedLRead, exactly as anchorFresh/freshLedger leave them: the next call
    // then takes the reducer's recovering first-frame (re-anchor only, no stale-rate trapezoid → P0-5),
    // and nulling lastAppliedLRead also makes any same-seq robustness re-feed a clean idempotent no-op
    // rather than a spurious folded_call_mutated pause against an L that belonged to the pre-break seq.
    lastBurnRate: null,
    lastAppliedLRead: null,
    pausedReason: null,                         // the deadlock break itself
  };
}

export function resolveLedgerForKey(persisted, { currentKey, watcherFoldedSeq, watcherTurnSeq, kStableFrozen, lReadNow }) {
  const anchorFresh = () => {
    const s = freshLedger(currentKey, kStableFrozen);
    s.lastAppliedFoldedCallSeq = watcherFoldedSeq;   // anchor at NOW — no catch-up of history (GPT#3)
    s.billAnchorFoldedCallSeq = watcherFoldedSeq;
    s.billAnchorLRead = lReadNow;
    s.billAnchorTurnSeq = watcherTurnSeq;            // R5 GPT#7: all three anchor fields set together (R2-12) — was left at 0
    s.currentTurnSeq = watcherTurnSeq;
    return s;
  };
  if (!persisted || persisted.stateKey !== currentKey) return anchorFresh();        // reset / first latch
  if (watcherFoldedSeq < persisted.lastAppliedFoldedCallSeq) {                       // truncated transcript / fold change
    // New#3 (fix wave): the watcher-rebuilt seq is BEHIND the ledger → the OLD code paused with
    // 'seq_history_mismatch'. That pause was RIGHT to refuse replaying already-settled calls (double
    // settlement), but it was a DEADLOCK: both drain gates in advanceRateLampToCurrent skip a
    // 'seq_history_mismatch' ledger, and the only code that clears pausedReason (the reducer's recovering
    // branch) sits behind those very gates. So within a segment it NEVER self-cleared — all billing and
    // ΔW/stock alerts were silently lost until the segment changed. Fix: RE-ANCHOR in place. We keep the
    // no-replay protection (anchors move to NOW, lastBurnRate nulled so the next call re-anchors rather
    // than integrating a stale-rate trapezoid — P0-5), but we break the deadlock by clearing the pause.
    const reanchored = reanchorOnMismatch(persisted, { watcherFoldedSeq, watcherTurnSeq, lReadNow });
    return syncLedgerTurn(reanchored, watcherTurnSeq);
  }
  // reuse — continue integrating (GPT#1). C2-1/Option-1: DROP the pre-jump of currentTurnSeq to the
  // watcher turn here. currentTurnSeq now MEANS "the last-integrated / still-open turn": the edge-settle
  // loop in advanceRateLampToCurrent walks it forward ONE turn per boundary, settling the ENDED turn from
  // the persisted cursor. Pre-jumping it to watcher._turnSeq before the loop made the loop guard
  // (`currentTurnSeq < s.turnSeq && currentTurnSeq > settledThroughTurnSeq`) already false, so the just-
  // ended turn NEVER settled. Return persisted UNCHANGED; the trailing syncLedgerTurn AFTER the advance
  // still re-establishes the TTL/pulse cursor + zeros ΔW on a zero-sample turn (R6-A1/R7-1 preserved).
  // (anchorFresh + the reanchorOnMismatch→syncLedgerTurn branch legitimately set currentTurnSeq to the
  // anchor turn and are LEFT UNCHANGED — those are (re)anchor points, not the reuse continuation.)
  return { ...persisted };
}

// stateKey-guarded merge (round-2 GPT#4). Only a matching-key ledger's fields reach status.
export function mergeLedgerIntoStatus(status, ledger, currentKey) {
  if (status.rateLamp?.reliable && ledger && ledger.stateKey === currentKey) {
    // xExit override from FROZEN k_stable (round-3 GPT#2): this MUST live here, not only in
    // advanceRateLampToCurrent — /api/status calls getStatus()+mergeLedgerIntoStatus (NOT the manager's
    // returned status), so without this the API/statusline/dashboard would show a live-stableMedian xExit
    // while the Stop route uses the frozen one → the two surfaces drift. Single source = the merge.
    if (ledger.kStableFrozen > 0 && status.baseline?.total > 0) {
      // #11: same derivation as computeRateLampInstant, via the shared helper (single source for frozen xExit).
      const { xExit, L_exit_fullCarry, inDeepWater } = deriveFrozenExit(
        status.rateLamp.C_RATIO, ledger.kStableFrozen, status.baseline.total, status.rateLamp.L_read);
      status.rateLamp.kStable = ledger.kStableFrozen;
      status.rateLamp.xExit = xExit;
      status.rateLamp.L_exit_fullCarry = L_exit_fullCarry;
      status.rateLamp.inDeepWater = inDeepWater;
    }
    status.rateLamp.billProgress = ledger.billProgress;
    status.rateLamp.billingCycle = { progress: ledger.billProgress };
    // v2.2-A2: surface billCycleCount (lifetime STOCK, displayed as ×N in the meter cluster).
    status.rateLamp.billCycleCount = ledger.billCycleCount ?? 0;
    // v2.2-A2 RV-C16: surface deepWaterDisplayLatched (read straight off the ledger — do NOT recompute).
    // renderPosition reads this for the 问题1 frozen-axis deep decision.
    status.rateLamp.deepWaterDisplayLatched = ledger.deepWaterDisplayLatched ?? false;
    // v2.2-A2: surface lBase (baseline.total) for the L/b display suffix.
    status.rateLamp.lBase = status.baseline?.total;
    // v2.2-A2: surface band (kAvg axis) for the shallow↔sweet split in renderPosition.
    // bandOf uses the kAvg-axis landmarks (NOT the frozen k_stable — see 问题1: the deep boundary
    // is handled by the frozen latch, band is consumed ONLY for shallow↔sweet).
    const lBase = status.baseline?.total;
    const kAvg = status.kAvg;
    const cRatio = status.rateLamp.C_RATIO;
    if (lBase > 0 && kAvg > 0 && cRatio > 0) {
      const x = status.rateLamp.L_read / lBase;
      const lm = landmarksFor(cRatio, kAvg, lBase, lBase); // fullCarry landmarks (kAvg axis)
      status.rateLamp.band = bandOf(x, lm);

      // Post-v2.2: expose landmarks for u_display + countdown
      // dhat uses frozen kStable so u=2 ≡ xExit ≡ yellow lamp (lamp/u alignment)
      const kS = ledger.kStableFrozen;
      status.rateLamp.dhat = (kS > 0) ? Math.sqrt(2 * cRatio * kS / lBase) : lm.dhat;
      status.rateLamp.xEntry = lm.xEntry;
      status.rateLamp.xSweet = lm.xSweet;
      status.rateLamp.wallP = 1 + cRatio;

      // Post-v2.2: compute targetL for ~Nt countdown
      // Deep-water override: target is the rent-wall (burnRate=1 point), capped by the
      // physical context ceiling. The wall = lBase*(1+cRatio) for fullCarry; this is
      // typically far beyond L_read, giving a large countdown ("still far from the wall").
      const lCap = status.rateLamp.L_cap ?? status.Lcap ?? 960000;
      if (status.rateLamp.inDeepWater || status.rateLamp.deepWaterDisplayLatched) {
        const wallL = lBase + cRatio * lBase; // = lBase * (1 + cRatio), the rent-wall
        status.rateLamp.targetL = Math.min(wallL, lCap);
      } else {
        status.rateLamp.targetL = computeTargetL({
          band: status.rateLamp.band,
          lBase,
          xEntry: lm.xEntry,
          xExit: status.rateLamp.xExit,
          lCap,
        });
      }
    }
    // final-review GPT#4: the TTL read compares lastBillEvent.turnSeq === currentTurnSeq, so
    // currentTurnSeq MUST reach status — else the pulse TTL cannot be evaluated and pulses never show.
    status.rateLamp.currentTurnSeq = ledger.currentTurnSeq;
    if (ledger.lastBillEvent) status.rateLamp.lastBillEvent = ledger.lastBillEvent;
    // final-review GPT#2: the FULL resolved Stop message (wall / dw_backstop / empty_burn / gate),
    // not just the bill pulse — with no OS notification, this is the ONLY UI home for the alert text.
    if (ledger.lastStopEvent) status.rateLamp.lastStopEvent = ledger.lastStopEvent;

    // Post-v2.2: kAvg passthrough (replaces the old per-turn EMA)
    status.rateLamp.kAvg = status.kAvg ?? null;

    // Per-call EMA (alpha=0.5): tracks recent growth rate, falls back to kAvg during bootstrap.
    // Keyed by currentKey (stable within a segment+model); resets on segment change (acceptable).
    let emaState = _perCallEma.get(currentKey);
    if (!emaState) { emaState = { prevL: null, ema: null, callsSinceAnchor: 0, lastSeq: 0 }; _perCallEma.set(currentKey, emaState); }
    const seq = ledger.lastAppliedFoldedCallSeq ?? 0;
    if (seq > emaState.lastSeq) {
      // New call(s) arrived — update EMA (one step per merge, using current L)
      updatePerCallEma(emaState, { L: status.rateLamp.L_read });
      emaState.lastSeq = seq;
    }
    status.rateLamp.gEma = emaState.ema;
  } else {
    status.rateLamp = status.rateLamp || {};
    status.rateLamp.kAvg = null;
    status.rateLamp.targetL = null;
    status.rateLamp.dhat = null;
    status.rateLamp.xEntry = null;
  }
  return status;
}

export function recordBillEvent(ledger, bill, turnSeq) {
  if (!bill) return ledger;
  return { ...ledger, lastBillEvent: { kind: bill.kind, billCount: bill.billCount, deltaL: bill.deltaL, delivery: bill.delivery, turnSeq } };
}

// final-review GPT#2: persist the FULL resolved Stop message so a subsequent GET /api/status can surface
// it (warn.sh discards the POST response; with no OS notify this is the alert's only delivery channel).
// TTL-scoped by turnSeq exactly like lastBillEvent. `resolved` is resolveStopMessage's return (or null).
// round-3 GPT#3 (UI dedup): record ONLY stop_hook-delivery events here. A statusline_pulse resolution
// (non_idle_burn / cache_unstable) is already carried by lastBillEvent — recording it as a stop event too
// would let the renderer show BOTH a bill pulse AND a "prominent alert" for the same turn, violating the
// single merged-presentation goal. So lastStopEvent ⟺ "there is a stop_hook-grade alert this turn".
export function recordStopEvent(ledger, resolved, turnSeq) {
  if (!resolved || resolved.delivery !== 'stop_hook') return ledger;
  const stopEvent = { kind: resolved.kind, delivery: resolved.delivery, message: resolved.message, billCount: resolved.billCount ?? 0, turnSeq };
  const copy = { ...ledger, lastStopEvent: stopEvent };
  pushStopEventRing(copy, stopEvent);
  return copy;
}

// The SINGLE mutation entry (spec §5.2 C-1). Every mutating helper goes through this so ledgerRevision
// can never be forgotten (the "gate looks present but is silently bypassed" bug). `changed` is derived
// from CONTENT (stringify before/after), NOT the caller-supplied `reason` — so revision monotonicity
// never depends on caller discipline (the C5a revision gate is the anti-alert-loss guard). `reason` is a
// diagnostic label only. The `after` string here is the PRE-bump content diff — it MUST NOT be reused for
// persist (it lacks the bumped revision); persistLedger re-stringifies after the bump (C-corr-2).
export function mutateLedger(ledger, reason, fn) {
  const before = JSON.stringify(ledger);
  const draft = structuredClone(ledger);      // Node≥18 global, zero-dep. Deep clone: no array aliasing,
                                              // and (unlike JSON round-trip) preserves NaN/Infinity/undefined.
  fn(draft);
  const after = JSON.stringify(draft);
  if (after === before) return ledger;        // no-op: original returned untouched, revision unchanged
  draft.ledgerRevision = (ledger.ledgerRevision ?? 0) + 1;
  return draft;
}

// Hydrate the live ledger for a session: memory copy if present, else a one-time disk load. round-6 A3
// (GPT#5): on a DISK load (i.e. first touch this process — not in _ledgers yet) CLEAR lastBillEvent/
// lastStopEvent. A pulse/alert is an in-process, single-turn signal; without this a persisted event whose
// `turnSeq === currentTurnSeq` (which A2 keeps monotonic across restart) would re-render after a restart,
// resurrecting a stale alert. round-6 A2 (GPT#1): also hydrate watcher._turnSeq monotonically from the
// persisted ledger so a restart can never move turnSeq backwards vs the ledger (Task 2.7 rebuilds it from
// the transcript, so this is belt-and-suspenders; it guarantees currentTurnDeltaW resets / gate prev.turnSeq
// stay sane even if the rebuild under-counts). Pure-ish: mutates the watcher counter + returns the ledger.
function hydrateLedger(watcher, sessionId) {
  const live = _ledgers.get(sessionId);
  if (live) return live;                                   // in-memory: already pulse-correct
  const disk = loadRateLampState(sessionId);               // one-time disk hydrate
  if (!disk) return null;
  if (Number.isInteger(disk.currentTurnSeq)) {
    watcher._turnSeq = Math.max(watcher._turnSeq ?? 0, disk.currentTurnSeq); // A2: never go backwards
  }
  const cleaned = { ...disk, lastBillEvent: null, lastStopEvent: null };     // A3: pulses do not survive a restart
  // v2.2-C: seed the process-only lastPersistedRevision to the loaded ledgerRevision so the C5a persist
  // gate starts from the actual on-disk revision. NO v1 back-fill / NO .bak (H-C): loadRateLampState already
  // ran validateLedgerState, which returns null for any non-v2 (or stateKey-foreign) ledger → a null load
  // means the caller builds a freshLedger. Nothing here copies or migrates the old file.
  _lastPersistedRevision.set(sessionId, cleaned.ledgerRevision ?? 0);
  _ledgers.set(sessionId, cleaned);
  return cleaned;
}

// C4-1 (G5/H-A): shared per-boundary settle helper. The ONE settle path: both advanceRateLampToCurrent's
// while-loop and boundedIncrementalAdvance's replay loop call this SAME body for each ended turn at its
// boundary. Mutates `l` in place (it's already inside a mutateLedger draft). `status` provides the segment-
// frozen quantities (baseline.total, rateLamp.C_RATIO, model) that F4/G3 derivations need.
function settleEndedTurnBoundary(l, { endedTurnSeq, status }) {
  // Boundary values = the ended turn's LAST call, read from the PERSISTED cursor.
  // WIPE-PATH GUARD (C1-2 carry-forward #2): fall back to billAnchorLRead when lastAppliedLRead is null.
  const lReadAtBoundary = Number.isFinite(l.lastAppliedLRead) ? l.lastAppliedLRead : l.billAnchorLRead;
  const seqAtBoundary = l.lastAppliedFoldedCallSeq;
  // F4: derive inDeepWater from THIS boundary's lReadAtBoundary, NOT the single live l.inDeepWater.
  const lBaseB = status.baseline?.total;
  // G3: C_RATIO fallback to objective source cRatioFor(status.model)
  const cRatioB = Number.isFinite(status.rateLamp?.C_RATIO) ? status.rateLamp.C_RATIO : cRatioFor(status.model);
  const frozenExit = (l.kStableFrozen > 0 && lBaseB > 0)
    ? deriveFrozenExit(cRatioB, l.kStableFrozen, lBaseB, lReadAtBoundary) : null;
  const inDeepWaterAtBoundary = frozenExit ? frozenExit.inDeepWater : false;
  const { state } = settleMeterAtBoundary(l, {
    L_readNow: lReadAtBoundary, kStable: l.kStableFrozen, foldedSeqNow: seqAtBoundary,
    turnSeqNow: endedTurnSeq + 1, endedTurnSeq, inDeepWater: inDeepWaterAtBoundary });
  Object.assign(l, state);
  // H-pt4: update the DISPLAY hysteresis latch once per COMMITTED boundary.
  if (frozenExit) {
    l.deepWaterDisplayLatched = deepWaterDisplay(l.deepWaterDisplayLatched, {
      L_read: lReadAtBoundary, L_exit_fullCarry: frozenExit.L_exit_fullCarry,
      cRatio: cRatioB, B_rebuild: lBaseB });
  }
  l.settledThroughTurnSeq = endedTurnSeq;
  l.currentTurnSeq = endedTurnSeq + 1;
}

// DRY-3: shared skeleton for both advance paths. Differences are injected via {doPoll, persist, loopOpts}.
// The two public exports (advanceRateLampToCurrent, boundedIncrementalAdvance) are thin wrappers.
function _advanceCore(watcher, sessionId, { doPoll, persist, loopOpts }) {
  // 1. Poll if requested (forcePoll for the reader; unconditional for the Stop route — GPT#6)
  if (doPoll) watcher.poll();

  // 2. G4: ONE getStatus() call — returned as `status` so the caller reuses it (D3 invariant).
  const status = watcher.getStatus();
  const reliableLatched = status.rateLamp?.reliable === true;

  // 3. UNRELIABLE / not-yet-latched frame (final-review GPT#1): we cannot recompute the state key (the
  // instant bundle omits C_RATIO/L_cap when unreliable), so we do NOT reset/re-key. But if a ledger
  // ALREADY exists we MUST still advance its seq cursor with seq-only unreliable samples, or recovery
  // hits a false folded_seq_gap. A pre-latch frame with no ledger yet simply has nothing to advance
  // (the fresh ledger will anchor at the current seq when the latch closes — R2-3).
  // No seq_history_mismatch special-case (was: `&& pausedReason !== 'seq_history_mismatch'`).
  // resolveLedgerForKey now RE-ANCHORS on a seq mismatch instead of setting a terminal pause, so this
  // reason is only ever seen on a ledger persisted by a pre-fix binary. Draining seq-only unreliable
  // samples overwrites it with the unreliable reason + advances the cursor; the reliable recovering
  // branch then clears it — self-healing, never terminal.
  if (!reliableLatched) {
    let ledger = hydrateLedger(watcher, sessionId);
    if (ledger) {
      const reason = status.rateLamp?.unavailableReason || 'insufficient_data';
      const seqSamples = watcher.rateLampSeqSamplesSince(ledger.lastAppliedFoldedCallSeq, { unavailableReason: reason });
      // Wrap unreliable drain + turn-cursor sync in mutateLedger (final-review I-1: all content changes
      // must bump revision so the dead-letter diagnostic stays trustworthy).
      ledger = mutateLedger(ledger, 'unreliable-drain', (l) => {
        for (const s of seqSamples) Object.assign(l, applyFoldedCallSample(l, s)); // seq-only: advances cursor, pauses
        // round-6 gemini#1 / round-7 GPT#1: sync the turn cursor (zero ΔW on a real advance)
        syncTurnCursorOnDraft(l, watcher._turnSeq);
      });
      _ledgers.set(sessionId, ledger);
      persist(sessionId, ledger);
    }
    return { ledger: ledger ?? null, status, budgetExhausted: false };
  }

  // 4. RELIABLE branch
  const currentKey = stateKeyForStatus(status); // #10: shared state-key builder (was an inlined arg object)
  const kStableFrozen = status.rateLamp.kStable ?? 0;

  let ledger = hydrateLedger(watcher, sessionId);                                  // hydrate once (pulse-clear + turnSeq A2/A3)
  ledger = resolveLedgerForKey(ledger, { currentKey, watcherFoldedSeq: watcher._foldedCallSeq,
    watcherTurnSeq: watcher._turnSeq, kStableFrozen, lReadNow: status.rateLamp.L_read });

  // one reducer call per NEW folded call (A1). This frame is reliable (guarded above). Each sample's
  // turnSeq is per-RECORD (Task 2.7), so a multi-turn poll integrates each call under its own turn.
  // No seq_history_mismatch gate (was: `if (pausedReason !== 'seq_history_mismatch')`): a fresh mismatch
  // is now re-anchored (not paused) upstream in resolveLedgerForKey, and a stale mismatch from a pre-fix
  // ledger is healed HERE — the reducer's recovering branch (pausedReason != null) clears it on the first
  // reliable sample. Gating the reducer out was exactly what made the pause terminal (New#3).
  const samples = watcher.rateLampSamplesSince(ledger.lastAppliedFoldedCallSeq, {
    B_post: status.rateLamp.B_post, B_rebuild: status.rateLamp.B_rebuild, cRatio: status.rateLamp.C_RATIO,
    reliable: true,
  });

  // ONE mutation per advance (B2): clone + diff run once, not per sample. Atomic — a mid-batch throw discards
  // the draft, leaving the prior ledger + replay cursor untouched. Content-derived `changed` still holds: an
  // advance with no new bytes leaves the draft identical → mutateLedger returns the original, no revision bump.
  // Budget cap (loopOpts): maxMs is a secondary time guard between boundaries.
  const startMs = loopOpts ? performance.now() : 0;
  let budgetExhausted = false;
  ledger = mutateLedger(ledger, 'advance-events', (l) => {
    for (const s of samples) {
      // Budget check: if elapsed time exceeds maxMs, stop before the next event
      if (loopOpts && (performance.now() - startMs > loopOpts.maxMs)) { budgetExhausted = true; break; }
      // Ordered event stream (spec §3.3): settle EACH turn boundary in order BEFORE integrating the new-turn
      // sample. Advance one turn per iteration so a zero-call / gap turn still settles + emits a summary.
      while (l.currentTurnSeq < s.turnSeq && l.currentTurnSeq > l.settledThroughTurnSeq) {
        settleEndedTurnBoundary(l, { endedTurnSeq: l.currentTurnSeq, status });
      }
      // Integrate this call under its own turn (A6/spec §5.2 C-1): applyFoldedCallSample is pure; assign in place.
      Object.assign(l, applyFoldedCallSample(l, s));
    }
    // Trailing turn-cursor sync (C2-1/Option-1, replaces the old Math.max cursor-only bump). Inside
    // mutateLedger so revision is bumped if content changes (final-review I-1: syncLedgerTurn outside
    // mutateLedger bypassed revision bump → violated the every-content-change-bumps-revision invariant).
    // Advances currentTurnSeq to watcher._turnSeq AND zeros ΔW when the turn actually moved — so a turn
    // that ADVANCED with zero rate-lamp-eligible calls still lands its cursor forward and clears ΔW.
    // Guard on !budgetExhausted — after budget break, unprocessed samples may still accumulate deltaW;
    // jumping currentTurnSeq past them would zero their contribution via the ΔW reset.
    if (!budgetExhausted) syncTurnCursorOnDraft(l, watcher._turnSeq);
  });

  _ledgers.set(sessionId, ledger);
  persist(sessionId, ledger);

  // G2 offset-commit: assign watcher._offset ONLY after mutateLedger succeeded.
  // For now (poll-based path), the offset is implicitly tracked by the watcher's _offset via poll().
  // The explicit file-read offset staging will be used when the direct-file-read optimization lands.

  // xExit override + event merge via the SAME mergeLedgerIntoStatus the /api/status route uses (round-3
  // GPT#2 — one source for frozen-xExit so the Stop route's `status` and the API can never drift).
  mergeLedgerIntoStatus(status, ledger, currentKey);
  return { ledger, status, budgetExhausted };
}

// The ONE mutating entry (round-2 GPT#2/#6, final-review GPT#1). forcePoll:true for the Stop route
// (GPT#6 — must ingest the just-ended turn before judging). Drains EVERY new folded call, reliable or
// NOT: the unreliable branch does NOT early-return (final-review GPT#1 — that was the 3rd recurrence of
// the drain-gated-on-reliable bug). Overrides xExit from the FROZEN k_stable (GPT#5).
export function advanceRateLampToCurrent(watcher, sessionId, { forcePoll = false } = {}) {
  const { ledger, status } = _advanceCore(watcher, sessionId, {
    doPoll: forcePoll,
    persist: (sid, _l) => schedulePersist(sid),  // C5a: write-behind (async); flush re-reads at timer tick
    loopOpts: null,  // no budget cap
  });
  return { ledger, status, bill: null };
}

// v2.2-C4-1: Budget-capped incremental advance for the Stop route. Reads the ALREADY-FLUSHED events
// via watcher.poll() (keeps the poll loop's single-read architecture), then processes samples in a
// budget-capped loop. Returns {caughtUp: boolean, status}. Under H-A: settles NOTHING for the open
// turn — no bill, no provisionalStopSettle, no synthetic summary. The open turn pends unconditionally.
// Offset-commit contract (G2): watcher._offset assigned ONLY AFTER mutateLedger returns successfully.
// G4: ONE getStatus() call — returned as `status` so the route reuses it (D3 invariant).
export function boundedIncrementalAdvance(watcher, sessionId, { maxMs = STOP_ADVANCE_MAX_MS, maxBytes = STOP_ADVANCE_MAX_BYTES } = {}) {
  _counters.stopAdvanceAttemptCount++;
  const { status, budgetExhausted } = _advanceCore(watcher, sessionId, {
    doPoll: true,  // always poll (single-read architecture)
    persist: (sid, l) => persistLedger(sid, l),  // synchronous persist
    loopOpts: { maxMs },
  });
  if (budgetExhausted) _counters.stopAdvanceTimeoutCount++;
  else _counters.stopAdvanceCaughtUpCount++;
  return { caughtUp: !budgetExhausted, status };
}

export function getLiveLedger(sessionId) { return _ledgers.get(sessionId) ?? null; }
// #6: the Stop route's explicit set-and-persist. force:true so a deliberate push always lands on disk,
// AND updates the write-elision cache so the next poll advance with the same ledger correctly elides.
// C5a: this IS the ENOSPC recovery probe (B6). If the session is paused and this succeeds → clear pause.
// If it throws → re-throw (the route's A12 catch returns 503 persist_failed and keeps the pause).
export function setLiveLedger(sessionId, ledger) {
  _ledgers.set(sessionId, ledger);
  persistLedger(sessionId, ledger, { force: true });
  // Successful force-write: if this session was in ENOSPC pause, the probe succeeded → clear
  if (_enospcPaused.has(sessionId)) {
    clearEnospcPause(sessionId);
  }
}

// v2.2-C3 (E4): the single durable-commit entry for Stop-route mutations. Synchronous (D-def2 no-await).
// On persistLedger throw, _ledgers.set is NOT reached → mutation atomically never-happened (structuredClone
// left the prior ref untouched). Let the throw propagate so the route's A12 catch returns 503 persist_failed.
export function commitLedgerMutationSync(sessionId, reason, fn) {
  const current = _ledgers.get(sessionId);
  const draft = mutateLedger(current, reason, fn);
  if (draft === current) return current; // no-op: fn produced no change → skip validate/persist/set
  const validated = validateLedgerState(draft);
  if (!validated) throw new Error(`commitLedgerMutationSync: validateLedgerState rejected draft (reason: ${reason})`);
  // C5a: cancel coalesced persist before synchronous write (no interleave window)
  cancelCoalescedPersist(sessionId);
  persistLedger(sessionId, validated, { force: true });
  _ledgers.set(sessionId, validated);
  return validated;
}

// v2.2-C3: Process-stable nonce for same-process pending identification (A8 clock rule).
// Captured at module load — all pendings enqueued by THIS process share it.
const processNonce = performance.now();

// v2.2-C3: drain pending Stop evaluations off reader-committed summaries.
// Expire → match → for each assigned resolve from BOUNDARY snapshot (B3) → recordStopEvent → advance alertEvaluatedThroughTurnSeq.
// ALL inside a single commitLedgerMutationSync — the final commit sets pendingStopEvaluations = remainingPending (tombstone-free).
export function drainPendingStopEvaluations(sessionId) {
  const ledger = _ledgers.get(sessionId);
  if (!ledger) return;
  commitLedgerMutationSync(sessionId, 'drain-pending-stop', (draft) => {
    // 1. Expire past-TTL entries (A8 three-clock)
    const nowMono = _nowMono();
    const nowWall = Date.now();
    const ttlExpired = expirePending(draft, { nowMono, nowWall, processNonce });

    // 2. Match remaining pending to committed summaries
    const { assigned, remainingPending, expired: matchExpired } = matchPendingToSummary(draft);

    // Step 4 counters: track drained + expired
    _counters.pendingDrainedCount += assigned.length;
    _counters.pendingExpiredCount += ttlExpired.length + (matchExpired?.length || 0);

    // 3. For each assigned: resolve from boundary snapshot (B3) + recordStopEvent + advance cursor
    const summaries = draft.settledTurnSummaries || [];
    let alertCursor = draft.alertEvaluatedThroughTurnSeq || 0;
    for (const a of assigned) {
      const summary = summaries.find(s => s.turnSeq === a.summaryTurnSeq);
      if (!summary) continue;
      const resolved = resolveStopMessageFromSummary(summary);
      // recordStopEvent-style: push stop_hook events onto recentStopEvents + lastStopEvent
      if (resolved && resolved.delivery === 'stop_hook') {
        const stopEvt = { kind: resolved.kind, delivery: resolved.delivery, message: resolved.message, billCount: resolved.billCount ?? 0, turnSeq: a.summaryTurnSeq };
        draft.lastStopEvent = stopEvt;
        pushStopEventRing(draft, stopEvt);
      }
      // Advance alertEvaluatedThroughTurnSeq unconditionally on a match (matched ⟹ evaluated)
      alertCursor = Math.max(alertCursor, a.summaryTurnSeq);
    }
    draft.alertEvaluatedThroughTurnSeq = alertCursor;

    // 4. Rebuild pending array to LIVE survivors only (tombstone-free)
    draft.pendingStopEvaluations = remainingPending;
  });
}

export { processNonce as _processNonce };  // exposed for tests only

// v2.2-C5a (A20): test-injection seams. Override the coalesced timer's writer, scheduler, and clock.
// Tests MUST call _resetRateLampManagerForTest in t.after() to avoid cross-test pollution.
export function _setRateLampManagerTestHooks({ nowMono, writer, scheduler } = {}) {
  if (nowMono !== undefined) _testNowMono = nowMono;
  if (writer !== undefined) _testWriter = writer;
  if (scheduler !== undefined) _testScheduler = scheduler;
}

// round-6 GPT#7: test-only reset of the module singleton. `node --test` runs files in one process and the
// _ledgers Map would otherwise bleed live ledgers between tests → order-dependent flakes. Tests call this
// in beforeEach; production never does. (Underscore-prefixed = not part of the public runtime contract.)
// C5a: also clears coalesced timer, pending sids, ENOSPC pause state, counters, and test hooks.
export function _resetRateLampManagerForTest() {
  _ledgers.clear();
  _lastSaved.clear();
  _lastPersistedRevision.clear();
  _perCallEma.clear();
  _pendingPersistSids.clear();
  _enospcPaused.clear();
  if (_coalescedTimer && !_testScheduler) { clearInterval(_coalescedTimer); }
  _coalescedTimer = null;
  _testWriter = null;
  _testScheduler = null;
  _testNowMono = null;
  // Reset counters
  _counters.diskWrites = 0;
  _counters.coalesceHits = 0;
  _counters.coalesceMisses = 0;
  _counters.revisionGateBlocks = 0;
  _counters.enospcEngagements = 0;
  _counters.enospcRecoveries = 0;
  _counters.stopAdvanceAttemptCount = 0;
  _counters.stopAdvanceCaughtUpCount = 0;
  _counters.stopAdvanceTimeoutCount = 0;
  _counters.stopAdvanceMaxBytesHitCount = 0;
  _counters.pendingCreatedCount = 0;
  _counters.pendingDrainedCount = 0;
  _counters.pendingExpiredCount = 0;
}

// Expose counters for the debug endpoint (read-only snapshot)
export function getDebugCounters() { return { ..._counters }; }

// Increment a named counter (used by server.js for pendingCreatedCount which fires in the route's atomic commit)
export function incrementCounter(name) { if (name in _counters) _counters[name]++; }

// SIGINT/SIGTERM flush (round-2 gemini 二.1). Per-iteration try/catch (final-review gemini#3): one
// failing save (disk full / bad path for a single session) must NOT abort the flush for the others.
export function flushAll() {
  for (const [sid, l] of _ledgers) {
    try { saveRateLampState(sid, l); } catch { /* best-effort on shutdown; a stale checkpoint reconstructs on next poll */ }
  }
}
