import { freshLedger, applyFoldedCallSample, advanceGateAndBackstop, stateKeyForStatus, loadRateLampState, saveRateLampState, pushStopEventRing } from './rate-lamp-store.js';
import { cRatioFor } from './extract.js';                 // G3: objective C_RATIO fallback (unreliable frame omits the mirror field)
import { validateLedgerState } from './ledger-schema.js';
import { nucleus } from './landmarks.js';
import { computeMovableFrac, computeBr, isInDeepWater, xRightFromBr, xLeftFromBr, BR_AMBER, BR_RED, backstopIntervalFor } from './bill-regret.js';
import { COALESCED_PERSIST_MS, DEPTH_HOT_LAP_COUNT } from './constants.js';
import { existsSync as _probeExists, appendFileSync as _probeAppend } from 'node:fs';

// ── Depth probe (expires 2026-07-25, kill: touch /tmp/sw-depth-probe/off) ───
const _PROBE_OFF = Date.now() > new Date('2026-07-25T00:00:00Z').getTime() || _probeExists('/tmp/sw-depth-probe/off');
function _dProbe(msg) {
  if (_PROBE_OFF) return;
  try { _probeAppend('/tmp/sw-depth-probe/depth.log', `${new Date().toISOString()} ${msg}\n`); } catch {}
}
// ── Cycle probe (same expiry/kill, shared log) ───
function _cProbe(msg) {
  if (_PROBE_OFF) return;
  try { _probeAppend('/tmp/sw-depth-probe/depth.log', `${new Date().toISOString()} ${msg}\n`); } catch {}
}

// Frontend render contract (spec invariant 10): rentMeter is ALWAYS present so the UI never shows a
// stale frame. Reliable path overwrites the fields; unreliable/mismatch keeps this default.
const RENT_METER_DEFAULT = () => ({
  cycleProgress: 0, rentRate: null, sweetRentRate: null,
  depthActive: false, depthProgress: 0,
  backstopInterval: null, backstopLapCount: 0, depthHot: false,
});

// In-memory single writer (round-2 Option A). One ledger per session lives here; the file is a
// checkpoint. Poll loop, Stop route, and /api/status all mutate/read ONLY through this module — no
// other code does an independent file load-modify-save (that races: a stale poll save resurrects a
// bill the Stop route just cleared → duplicate settlement, round-2 GPT#10).
const _ledgers = new Map(); // sessionId → ledger (authoritative live copy)
// RV-C8: TTL-based eviction tracking for long-running daemon processes (no memory leak across sessions)
const _ledgerLastAccess = new Map(); // sessionId → monotonic timestamp of last access
const LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — aligned with sweepStaleState
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
    // ENOSPC pause: skip this sid (its write-behind is blocked; recovery probed below)
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

  // ENOSPC recovery probe: retry paused sessions each tick (post-v3 fix — Stop route no longer probes)
  for (const sid of _enospcPaused) {
    try {
      const ledger = _ledgers.get(sid);
      if (!ledger) { _enospcPaused.delete(sid); continue; }
      persistLedger(sid, ledger, { force: true });
      clearEnospcPause(sid);
    } catch { /* still blocked — try again next tick */ }
  }
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

// Called before a synchronous write to eliminate the coalesced-persist interleave window.
export function cancelCoalescedPersist(sessionId) {
  _pendingPersistSids.delete(sessionId);
}

// Query ENOSPC pause state (exported for tests + debug endpoint in server.js)
export function isEnospcPaused(sessionId) { return _enospcPaused.has(sessionId); }

// Clear ENOSPC pause (called after a successful probe force-write)
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

// Advance the ledger's turn cursor. Used in resolve-reuse + unreliable-drain.
function syncLedgerTurn(ledger, watcherTurnSeq) {
  const prev = ledger.currentTurnSeq ?? 0;
  if (watcherTurnSeq > prev) return { ...ledger, currentTurnSeq: watcherTurnSeq };
  return { ...ledger, currentTurnSeq: Math.max(prev, watcherTurnSeq) };
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
    lastBurnRate: null,
    lastAppliedLRead: null,
    pausedReason: null,
  };
}

export function resolveLedgerForKey(persisted, { currentKey, watcherFoldedSeq, watcherTurnSeq, kStableFrozen, lReadNow }) {
  const anchorFresh = () => {
    const s = freshLedger(currentKey, kStableFrozen);
    s.lastAppliedFoldedCallSeq = watcherFoldedSeq;
    s.billAnchorFoldedCallSeq = watcherFoldedSeq;
    s.billAnchorLRead = lReadNow;
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
  // reuse — continue integrating. Return persisted unchanged; the advance loop advances
  // currentTurnSeq per-sample and the trailing sync catches up any remaining gap.
  return { ...persisted };
}

// stateKey-guarded merge (round-2 GPT#4). Only a matching-key ledger's fields reach status.
// v3: br-family derived from LIVE B and g (status.rateLamp.{B_post, gEma}) — kStableFrozen/baseline.total retired.
export function mergeLedgerIntoStatus(status, ledger, currentKey) {
  // Spec invariant 10: rentMeter ALWAYS present so the UI never renders a stale frame.
  // Set the null-safe default BEFORE any early return; the reliable path overwrites it below.
  status.rateLamp = status.rateLamp || {};
  if (!status.rateLamp.rentMeter) status.rateLamp.rentMeter = RENT_METER_DEFAULT();

  if (!(status.rateLamp?.reliable) || !ledger || ledger.stateKey !== currentKey) {
    status.rateLamp.dhat = status.rateLamp.dhat ?? null;
    return status;
  }
  // WHY: billing is segment-scoped; no stateKey gate beyond the match above (spec section 6.3).
  status.rateLamp.billProgress = ledger.billProgress;
  status.rateLamp.billingCycle = { progress: ledger.billProgress };
  status.rateLamp.billCycleCount = ledger.billCycleCount ?? 0;
  status.rateLamp.currentTurnSeq = ledger.currentTurnSeq;
  if (ledger.lastBillEvent) status.rateLamp.lastBillEvent = ledger.lastBillEvent;
  // Condition-cleared: lastStopEvent is visible until the next human turn boundary clears it.
  if (ledger.lastStopEvent) status.rateLamp.lastStopEvent = ledger.lastStopEvent;
  status.rateLamp.dwBillsSinceLastAlert = ledger.dwBillsSinceLastAlert ?? 0;
  status.rateLamp.hasDeepWaterGateFired = ledger.hasDeepWaterGateFired === true;
  status.rateLamp.backstopLapCount = ledger.backstopLapCount ?? 0;

  // ── PROBE: display merge (expires 2026-07-25, kill: touch /tmp/sw-depth-probe/off) ──
  if (!_PROBE_OFF && ledger.hasDeepWaterGateFired && ledger.dwBillsSinceLastAlert > 0) {
    const _int = (status.rateLamp.mf > 0) ? backstopIntervalFor(status.rateLamp.mf, BR_AMBER) : null;
    const _prog = _int ? Math.min(1, ledger.dwBillsSinceLastAlert / _int) : '?';
    _dProbe(`[display] billCycle=${ledger.billCycleCount} dwBills=${ledger.dwBillsSinceLastAlert}/${_int?.toFixed(1) ?? '?'} progress=${typeof _prog === 'number' ? _prog.toFixed(2) : _prog} laps=${ledger.backstopLapCount} billProgress=${ledger.billProgress?.toFixed(3)}`);
  }

  enrichStatusLandmarks(status);
  return status;
}

// Pure computation: derive dashboard landmarks + rentMeter from rateLamp fields.
// No ledger dependency — can be called standalone (e.g. replay) or after ledger injection.
export function enrichStatusLandmarks(status) {
  status.rateLamp = status.rateLamp || {};
  if (!status.rateLamp.rentMeter) status.rateLamp.rentMeter = RENT_METER_DEFAULT();

  const B = (status.rateLamp.B_default > 0 ? status.rateLamp.B_default : status.rateLamp.B_post), cRatio = status.rateLamp.C_RATIO, g = status.rateLamp.gEma;
  if (!(B > 0 && cRatio > 0 && g > 0)) return status;

  const dhat = status.rateLamp.dhat ?? nucleus(cRatio, g, B);
  const mf = status.rateLamp.mf ?? computeMovableFrac(cRatio, B, g);
  status.rateLamp.dhat = dhat; status.rateLamp.mf = mf;
  if (dhat > 0 && mf > 0) {
    if (!Number.isFinite(status.rateLamp.br)) {
      const x = status.rateLamp.L_read / B;
      status.rateLamp.br = computeBr(x, dhat, mf);
    }
    status.rateLamp.xBrAmberR = xRightFromBr(BR_AMBER, dhat, mf);
    status.rateLamp.xBrAmberL = xLeftFromBr(BR_AMBER, dhat, mf);
    status.rateLamp.xBrRedR = xRightFromBr(BR_RED, dhat, mf);
  }
  status.rateLamp.xSweet = status.rateLamp.xSweet ?? (1 + dhat);
  status.rateLamp.wallP = 1 + cRatio;
  status.rateLamp.lBase = B;

  // rentMeter: dual-bar UI render state (spec invariant 10).
  const interval = backstopIntervalFor(status.rateLamp.mf, BR_AMBER);
  const dwBills = status.rateLamp.dwBillsSinceLastAlert ?? 0;
  const depthProgress = Number.isFinite(interval) && interval > 0
    ? Math.min(1, Math.max(0, dwBills / interval)) : 0;
  const sweetRentRate = (Number.isFinite(dhat) && cRatio > 0) ? dhat / cRatio : null;
  const liveBurnRate = Number.isFinite(status.burnRate) ? status.burnRate
    : (Number.isFinite(status.rateLamp.burnRate) ? status.rateLamp.burnRate : null);
  status.rateLamp.rentMeter = {
    cycleProgress: status.rateLamp.billProgress ?? 0,
    rentRate: liveBurnRate,
    sweetRentRate,
    depthActive: status.rateLamp.hasDeepWaterGateFired === true,
    depthProgress,
    backstopInterval: Number.isFinite(interval) ? interval : null,
    backstopLapCount: status.rateLamp.backstopLapCount ?? 0,
    depthHot: (status.rateLamp.backstopLapCount ?? 0) >= DEPTH_HOT_LAP_COUNT,
  };
  return status;
}

export function recordBillEvent(ledger, bill, turnSeq) {
  if (!bill) return ledger;
  return { ...ledger, lastBillEvent: { kind: bill.kind, billCount: bill.billCount, deltaL: bill.deltaL, delivery: bill.delivery, turnSeq } };
}

// Persist the FULL resolved Stop message so a subsequent GET /api/status can surface it.
// Condition-cleared: the advance loop nulls lastStopEvent on the next human turn boundary.
export function recordStopEvent(ledger, resolved, seq) {
  if (!resolved || resolved.delivery !== 'stop_hook') return ledger;
  const stopEvent = { kind: resolved.kind, delivery: resolved.delivery, message: resolved.message, billCount: resolved.billCount ?? 0, seq };
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
// the transcript, so this is belt-and-suspenders; it guarantees gate prev.turnSeq
// stays sane even if the rebuild under-counts). Pure-ish: mutates the watcher counter + returns the ledger.
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
        if (watcher._turnSeq > l.currentTurnSeq) l.currentTurnSeq = watcher._turnSeq;
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
  const bPos = status.rateLamp.B_default > 0 ? status.rateLamp.B_default : status.rateLamp.B_post;
  const samples = watcher.rateLampSamplesSince(ledger.lastAppliedFoldedCallSeq, {
    B_post: bPos, B_rebuild: bPos, cRatio: status.rateLamp.C_RATIO,
    reliable: true,
  });

  // ONE mutation per advance (B2): clone + diff run once, not per sample. Atomic — a mid-batch throw discards
  // the draft, leaving the prior ledger + replay cursor untouched. Content-derived `changed` still holds: an
  // advance with no new bytes leaves the draft identical → mutateLedger returns the original, no revision bump.
  // Budget cap (loopOpts): maxMs is a secondary time guard between boundaries.
  const startMs = loopOpts ? performance.now() : 0;
  let budgetExhausted = false;

  // Pre-compute deep-water quantities for per-call gate/backstop (Change A: no turn boundaries).
  const B_post = status.rateLamp?.B_post;
  const B_gate = (status.rateLamp?.B_default > 0 ? status.rateLamp.B_default : null) ?? B_post;
  const cRatioGate = Number.isFinite(status.rateLamp?.C_RATIO) ? status.rateLamp.C_RATIO : cRatioFor(status.model);
  const gGate = status.rateLamp?.gEma;
  const mfGate = (gGate > 0 && B_gate > 0 && cRatioGate > 0) ? computeMovableFrac(cRatioGate, B_gate, gGate) : 0;
  const dhatGate = (gGate > 0 && B_gate > 0 && cRatioGate > 0) ? nucleus(cRatioGate, gGate, B_gate) : 0;

  ledger = mutateLedger(ledger, 'advance-events', (l) => {
    // Snapshot the pre-batch event ref so we only clear events the user has had a chance to see
    // (events fired within THIS batch are not yet visible to any external reader).
    const preExistingStopEvent = l.lastStopEvent;
    for (const s of samples) {
      // Budget check: if elapsed time exceeds maxMs, stop before the next event
      if (loopOpts && (performance.now() - startMs > loopOpts.maxMs)) { budgetExhausted = true; break; }
      // Human turn boundary clear: user sent a new message → they've seen the statusline alert.
      // Only clear events that existed BEFORE this batch — events fired within the batch haven't
      // been externally visible yet (no poll/GET between mutateLedger entry and exit).
      if (s.turnSeq > l.currentTurnSeq && l.lastStopEvent && l.lastStopEvent === preExistingStopEvent) l.lastStopEvent = null;
      // Per-turn cursor update: advance currentTurnSeq when the turn changes.
      if (s.turnSeq > l.currentTurnSeq) l.currentTurnSeq = s.turnSeq;
      // Integrate this call (applyFoldedCallSample is pure; assign in place).
      const _prevCycle = l.billCycleCount;
      Object.assign(l, applyFoldedCallSample(l, s));
      const cycled = l.billCycleCount - _prevCycle;
      // ── PROBE: cycle tick (expires 2026-07-25, kill: touch /tmp/sw-depth-probe/off) ──
      if (!_PROBE_OFF && cycled > 0) {
        _cProbe(`[cycle] bill=${l.billCycleCount} progress=${l.billProgress?.toFixed(3)} br=${l.lastBurnRate?.toFixed(3) ?? '?'} seq=${s.seq} turn=${s.turnSeq} inDeep=${l.hasDeepWaterGateFired} dwBills=${l.dwBillsSinceLastAlert}`);
      }
      // Per-call gate/backstop: advance on EVERY API call (gate counts calls, not cycles).
      if (B_gate > 0) {
        const x = s.L_read / B_gate;
        const br = (dhatGate > 0 && mfGate > 0) ? computeBr(x, dhatGate, mfGate) : 0;
        const inDeep = isInDeepWater(x, 1 + dhatGate, br);
        const { fired, kind } = advanceGateAndBackstop(l, { inDeepWater: inDeep, billCycleIncrement: cycled, mf: mfGate });
        if (fired) {
          const message = kind === 'gate'
            ? 'Session Watcher: bill-regret above amber and holding. Consider restart/compact at the next natural boundary.'
            : `Backstop lap ${l.backstopLapCount}: session in deep water`;
          const stopEvent = { kind, delivery: 'reader_path', message, billCount: kind === 'gate' ? 0 : l.backstopLapCount, seq: s.seq };
          l.lastStopEvent = stopEvent;
          pushStopEventRing(l, stopEvent);
        }
      }
    }
    // Trailing turn-cursor sync: advance to the watcher's current turn (for display label).
    if (!budgetExhausted && watcher._turnSeq > l.currentTurnSeq) {
      l.currentTurnSeq = watcher._turnSeq;
    }
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

export function getLiveLedger(sessionId) {
  const ledger = _ledgers.get(sessionId) ?? null;
  if (ledger) _ledgerLastAccess.set(sessionId, _nowMono());
  return ledger;
}
// Explicit set-and-persist. force:true so a deliberate push always lands on disk,
// AND updates the write-elision cache so the next poll advance with the same ledger correctly elides.
// C5a: this IS the ENOSPC recovery probe (B6). If the session is paused and this succeeds → clear pause.
// If it throws → re-throw (the caller's catch keeps the pause).
export function setLiveLedger(sessionId, ledger) {
  _ledgers.set(sessionId, ledger);
  _ledgerLastAccess.set(sessionId, _nowMono());
  persistLedger(sessionId, ledger, { force: true });
  // Successful force-write: if this session was in ENOSPC pause, the probe succeeded → clear
  if (_enospcPaused.has(sessionId)) {
    clearEnospcPause(sessionId);
  }
}

// Exported for future use. Current architecture is single-session-per-process:
// the daemon exits when the session ends, so _ledgers never accumulates.
// When v3 introduces multi-session daemons, wire this into the periodic
// sweepStaleState timer (server.js) or call on setLiveLedger with throttling.

// RV-C8: sweep stale ledgers that haven't been accessed within LEDGER_TTL_MS (7 days).
// Returns the count of evicted entries. Called by sweepStaleState or a periodic timer in long-running daemons.
export function sweepStaleLedgers() {
  const now = _nowMono();
  let evicted = 0;
  for (const [sid, lastAccess] of _ledgerLastAccess) {
    if (now - lastAccess > LEDGER_TTL_MS) {
      _ledgers.delete(sid);
      _ledgerLastAccess.delete(sid);
      _lastPersistedRevision.delete(sid);
      _lastSaved.delete(sid);
      _pendingPersistSids.delete(sid);
      evicted++;
    }
  }
  return evicted;
}

// v2.2-C3 (E4): the single durable-commit entry for synchronous mutations. Synchronous (D-def2 no-await).
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
  _ledgerLastAccess.clear();
  _lastSaved.clear();
  _lastPersistedRevision.clear();
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
}

// Expose counters for the debug endpoint (read-only snapshot)
export function getDebugCounters() { return { ..._counters }; }

// SIGINT/SIGTERM flush (round-2 gemini 二.1). Per-iteration try/catch (final-review gemini#3): one
// failing save (disk full / bad path for a single session) must NOT abort the flush for the others.
export function flushAll() {
  for (const [sid, l] of _ledgers) {
    try { saveRateLampState(sid, l); } catch { /* best-effort on shutdown; a stale checkpoint reconstructs on next poll */ }
  }
}
