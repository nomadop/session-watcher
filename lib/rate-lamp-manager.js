import { freshLedger, drainFrame, stateKeyForStatus, loadRateLampState, saveRateLampState } from './rate-lamp-store.js';
import { BR_AMBER, walletIntervalFor, wallPositionFor } from './bill-regret.js';
import { COALESCED_PERSIST_MS, DEPTH_HOT_LAP_COUNT } from './constants.js';

// Frontend render contract (spec invariant 10): rentMeter is ALWAYS present so the UI never shows a
// stale frame. Reliable path overwrites the fields; unreliable/mismatch keeps this default.
const RENT_METER_DEFAULT = () => ({
  cycleProgress: 0, depthActive: false, depthProgress: 0,
  backstopInterval: null, backstopLapCount: 0, depthHot: false,
});

// In-memory single writer. One ledger per session lives here; the file is a checkpoint. Poll loop, Stop
// route, and /api/status all mutate/read ONLY through this module — no other code does an independent file
// load-modify-save (that races: a stale poll save resurrects a bill the Stop route just cleared, which
// settles it twice).
const _ledgers = new Map(); // sessionId → ledger (authoritative live copy)
// Per-session snapshot of the LAST serialization written to disk. advanceRateLampToCurrent runs on every
// tick past the idle gate, so an unchanged ledger would re-write an identical checkpoint every tick.
// persistLedger() below compares the new serialization to this snapshot and skips the disk write when they
// match — the ledger stays the source of truth, saveRateLampState stays the ONLY writer, and the write still
// happens on every REAL change (new call, turn advance, settle, pause).
const _lastSaved = new Map(); // sessionId → JSON string last persisted (write-elision cache)
// Per-session snapshot of the ledgerRevision last known to be on disk. PROCESS-ONLY — NEVER serialized into
// the ledger (freshLedger omits it; validateLedgerState never reads it). Seeded on a disk hydrate to the
// loaded ledgerRevision; the persist-time revision gate reads it to reject a stale write-behind snapshot
// that would clobber a newer alert.
const _lastPersistedRevision = new Map(); // sessionId → last-persisted ledgerRevision (process-only)
// The last `streamRevision` this manager SAW per session. It lives beside `_ledgers` and is PROCESS-ONLY:
// stream continuity is a property of this process's view of the sample stream, not of the durable integral,
// so it is never serialized. Hydration deliberately does NOT initialize it — a fresh process must treat its
// first frame as a discontinuity and skip the history the persisted integral already covers, rather than
// re-integrating it.
const _lastSeenRevision = new Map(); // sessionId → last seen streamRevision (process-only)

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

// Test-injection seams (A20): override the coalesced timer's writer and scheduler.
let _testWriter = null;   // (path, obj) => void — replaces saveRateLampState
let _testScheduler = null; // (fn, ms) => timerRef — replaces setInterval

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

// Query ENOSPC pause state (exported for tests + debug endpoint in server.js)
export function isEnospcPaused(sessionId) { return _enospcPaused.has(sessionId); }

// Clear ENOSPC pause, manager-internal: the pause is engaged by the persist path's own disk failure and
// cleared where a force-write proves the disk answers again.
function clearEnospcPause(sessionId) {
  _enospcPaused.delete(sessionId);
  _counters.enospcRecoveries++;
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

// The reanchor every sample-stream discontinuity takes. Two things reach it: a `streamRevision` change (a
// replace, a rotate, or the append that first observes a Source) and a folded-call sequence gap. Both mean
// the samples this frame carries do not continue the ones the ledger already integrated, so replaying them
// would settle the same context twice.
//
// A MATCHING ledger keeps both clocks: the accumulated integral is what the persisted ledger is
// authoritative for, and the cycle and lap counters are lifetime counters with a dashboard display, so
// resetting any of them would surface as a jump the user's spend never made. Only the cursor re-anchors.
function reanchorLedger(persisted, { currentKey, frameTailSeq, frameTurnSeq }) {
  const matches = persisted && persisted.stateKey === currentKey;
  const base = matches ? { ...persisted } : freshLedger(currentKey);
  return {
    ...base,
    stateKey: currentKey,
    // PRESERVED on a match: billProgress, billCycleCount, walletPhase, walletLapCount.
    // The folded cursor moves to the frame TAIL, which is what skips this frame's samples.
    lastAppliedFoldedCallSeq: frameTailSeq,
    pausedReason: null,
    // A pulse is an in-process single-turn signal. Carrying `lastStopEvent` across a discontinuity would
    // re-render an alert for context this stream no longer contains.
    lastStopEvent: null,
    currentTurnSeq: frameTurnSeq,
  };
}

// stateKey-guarded merge. Only a matching-key ledger's fields reach status. The br family
// arrives already computed on the frame's status — the Engine is its sole producer — so nothing here
// derives a position quantity; the wallet clock is the only thing this maps onto the wire.
export function mergeLedgerIntoStatus(status, ledger, currentKey) {
  // rentMeter is ALWAYS present so the UI never renders a stale frame.
  status.rateLamp = status.rateLamp || {};
  if (!status.rateLamp.rentMeter) status.rateLamp.rentMeter = RENT_METER_DEFAULT();
  if (!(status.rateLamp?.reliable) || !ledger || ledger.stateKey !== currentKey) {
    status.rateLamp.dhat = status.rateLamp.dhat ?? null;
    return status;
  }
  const rl = status.rateLamp;
  rl.billProgress = ledger.billProgress;
  rl.billingCycle = { progress: ledger.billProgress };
  rl.billCycleCount = ledger.billCycleCount ?? 0;
  rl.currentTurnSeq = ledger.currentTurnSeq;
  // Condition-cleared: lastStopEvent is visible until the next human turn boundary clears it.
  if (ledger.lastStopEvent) rl.lastStopEvent = ledger.lastStopEvent;
  const interval = walletIntervalFor(rl.mfLocal, BR_AMBER);
  rl.rentMeter = {
    cycleProgress: ledger.billProgress,
    depthActive: true,
    depthProgress: ledger.walletPhase,
    backstopInterval: Number.isFinite(interval) ? interval : null,
    backstopLapCount: ledger.walletLapCount,
    depthHot: ledger.walletLapCount >= DEPTH_HOT_LAP_COUNT,
  };
  enrichStatusLandmarks(status);
  return status;
}

// The one wire quantity that is a function of the price ratio alone, so no ledger reaches it; a known
// baseline still gates it. `mergeLedgerIntoStatus` is the only caller, on the path where a ledger was
// accepted; the export is for test/rate-lamp.manager.test.js `fills only wallP`, which pins that it adds
// no landmark.
export function enrichStatusLandmarks(status) {
  status.rateLamp = status.rateLamp || {};
  if (!status.rateLamp.rentMeter) status.rateLamp.rentMeter = RENT_METER_DEFAULT();
  const rl = status.rateLamp;
  const B = rl.B_default > 0 ? rl.B_default : rl.B_post;
  if (!(B > 0 && rl.C_RATIO > 0)) return status;
  rl.wallP = wallPositionFor(rl.C_RATIO);
  return status;
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

// Hydrate the live ledger for a session: the in-memory copy when present, else a one-time disk load.
//
// Hydration NEVER modifies Engine or application state. It used to raise the watcher's turn counter from the
// persisted cursor; Engine state is the only `turnSeq` authority now, and the persisted `currentTurnSeq` is a
// consumer cursor that follows the frame rather than leading it.
//
// On a DISK load, clear `lastStopEvent`: a pulse is an in-process, single-turn signal, and a checkpoint
// written before the process boundary describes context this stream no longer contains. `reanchorLedger`
// clears it again; which of the two a given path reaches is carried by `DEAD-BACKSTOP-FUNCTIONS` in
// `docs/2026-07-03-session-watcher-deferred-minors.md`, along with what no test holds.
function hydrateLedger(sessionId) {
  const live = _ledgers.get(sessionId);
  if (live) return live;                                   // in-memory: already pulse-correct
  const disk = loadRateLampState(sessionId);               // one-time disk hydrate
  if (!disk) return null;
  const cleaned = { ...disk, lastStopEvent: null };
  // Seed the process-only lastPersistedRevision to the loaded ledgerRevision so the persist gate starts from
  // the actual on-disk revision. No back-fill and no .bak: loadRateLampState already ran validateLedgerState,
  // which accepts only the current schema version, so a ledger written under any other one loads as a null
  // and the caller builds a freshLedger. Nothing here copies or migrates the old file.
  _lastPersistedRevision.set(sessionId, cleaned.ledgerRevision ?? 0);
  _ledgers.set(sessionId, cleaned);
  return cleaned;
}

// The ONE mutating entry. It reads exactly one coherent frame from the shared application and decides on it:
// the frame carries the lamp status, how far measurement has advanced, each new per-call sample, the Engine
// turn, the folded-call cursor and the process-local `streamRevision`. Nothing here reads a watcher field,
// polls a Source, or mutates measurement state.
export function advanceRateLampToCurrent(watcher, sessionId, { forcePoll = false } = {}) {
  void forcePoll;   // no consumer drives a Source from here: acquisition is the host's, in its own poll tick
  let ledger = hydrateLedger(sessionId);
  // One frame, read from the cursor the ledger has already integrated to.
  const frame = watcher.readRateLampFrame(ledger ? ledger.lastAppliedFoldedCallSeq : 0);
  const reliable = frame.status?.reliable === true;

  // An UNRELIABLE or invalid frame preserves both integrals and pauses. Reliability comes only from the
  // current frame — `hasObservedSource` is not an input.
  if (!reliable) {
    if (!ledger) return { ledger: null, status: frame.status, bill: null };
    ledger = mutateLedger(ledger, 'unreliable-frame', (l) => {
      l.pausedReason = frame.status?.unavailableReason || 'insufficient_data';
      l.lastAppliedFoldedCallSeq = frame.foldedCallSeq;
      // Assigned after EVERY frame, zero-sample frames included, and permitted to DECREASE: the Engine is
      // the turn authority and a rebuild can legitimately land on a lower turn than the ledger last saw.
      l.currentTurnSeq = frame.turnSeq;
    });
    _ledgers.set(sessionId, ledger);
    schedulePersist(sessionId);
    return { ledger, status: frame.status, bill: null };
  }

  const currentKey = stateKeyForStatus({ segment: frame.progress.segment });

  // Stream continuity. The manager retains the last seen revision per session in PROCESS memory: a missing
  // value and a different one are both a revision change, which is what makes a fresh process treat its
  // first frame as a discontinuity and skip the history the persisted integral already covers.
  const seenRevision = _lastSeenRevision.get(sessionId);
  const revisionChanged = seenRevision !== frame.streamRevision;
  // A sequence gap takes the SAME path: the ledger's cursor is ahead of what this frame can continue.
  const sequenceGap = ledger != null && frame.foldedCallSeq < ledger.lastAppliedFoldedCallSeq;
  if (sequenceGap && process.env.SW_DEBUG) {
    console.error('[rate-lamp] seq mismatch → re-anchored, cycleCount preserved');
  }

  let drained = frame;
  if (revisionChanged || sequenceGap || !ledger || ledger.stateKey !== currentKey) {
    ledger = reanchorLedger(ledger, { currentKey, frameTailSeq: frame.foldedCallSeq, frameTurnSeq: frame.turnSeq });
    // The current frame's samples are SKIPPED: the cursor now sits at their tail.
    drained = { ...frame, samples: [] };
    // Recorded once the in-memory reanchor has succeeded, WITHOUT waiting for persistence: a write-behind
    // failure must not make the next frame reanchor a second time and skip live samples.
    _lastSeenRevision.set(sessionId, frame.streamRevision);
  }

  // ONE mutation per advance: the clone and the content diff run once, not per sample. Atomic — a mid-batch
  // throw discards the draft and leaves the prior ledger and its cursor untouched.
  ledger = mutateLedger(ledger, 'advance-events', (l) => drainFrame(l, drained));

  _ledgers.set(sessionId, ledger);
  schedulePersist(sessionId);
  return { ledger, status: frame.status, bill: null };
}

export function getLiveLedger(sessionId) {
  return _ledgers.get(sessionId) ?? null;
}
// Explicit set-and-persist. force:true so a deliberate push always lands on disk,
// AND updates the write-elision cache so the next poll advance with the same ledger correctly elides.
// C5a: this IS the ENOSPC recovery probe (B6). If the session is paused and this succeeds → clear pause.
// If it throws → re-throw (the caller's catch keeps the pause).
export function setLiveLedger(sessionId, ledger) {
  _ledgers.set(sessionId, ledger);
  persistLedger(sessionId, ledger, { force: true });
  // Successful force-write: if this session was in ENOSPC pause, the probe succeeded → clear
  if (_enospcPaused.has(sessionId)) {
    clearEnospcPause(sessionId);
  }
}

// v2.2-C5a (A20): test-injection seams. Override the coalesced timer's writer and scheduler.
// Tests MUST call _resetRateLampManagerForTest in t.after() to avoid cross-test pollution.
export function _setRateLampManagerTestHooks({ writer, scheduler } = {}) {
  if (writer !== undefined) _testWriter = writer;
  if (scheduler !== undefined) _testScheduler = scheduler;
}

// Test-only reset of the module singleton. `node --test` runs files in one process and the _ledgers Map would
// otherwise bleed live ledgers between tests → order-dependent flakes. Tests call this in beforeEach;
// production never does. (Underscore-prefixed = not part of the public runtime contract.) It also clears the
// coalesced timer, pending sids, ENOSPC pause state, counters, and test hooks.
export function _resetRateLampManagerForTest() {
  _ledgers.clear();
  _lastSaved.clear();
  _lastPersistedRevision.clear();
  _lastSeenRevision.clear();
  _pendingPersistSids.clear();
  _enospcPaused.clear();
  if (_coalescedTimer && !_testScheduler) { clearInterval(_coalescedTimer); }
  _coalescedTimer = null;
  _testWriter = null;
  _testScheduler = null;
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

// SIGINT/SIGTERM flush. Per-iteration try/catch: one failing save (disk full / bad path for a single
// session) must NOT abort the flush for the others.
export function flushAll() {
  for (const [sid, l] of _ledgers) {
    try { saveRateLampState(sid, l); } catch { /* best-effort on shutdown; a stale checkpoint reconstructs on next poll */ }
  }
}
