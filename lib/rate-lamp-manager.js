import { freshLedger, applyFoldedCallSample, advanceGateAndBackstop, stateKeyForStatus, loadRateLampState, saveRateLampState, pushStopEventRing } from './rate-lamp-store.js';
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
// A MATCHING ledger keeps `billProgress` and `billCycleCount`: the accumulated integral is what the persisted
// ledger is authoritative for, and the cycle count is a lifetime counter with a dashboard display, so
// resetting either would surface as a jump the user's spend never made. Everything positional re-anchors to
// NOW, and the burn anchor is cleared so the first later reliable call anchors instead of integrating a
// trapezoid across the discontinuity.
function reanchorLedger(persisted, { currentKey, frameTailSeq, frameTurnSeq, frameLRead, kStableFrozen }) {
  const matches = persisted && persisted.stateKey === currentKey;
  const base = matches ? { ...persisted } : freshLedger(currentKey, kStableFrozen);
  return {
    ...base,
    stateKey: currentKey,
    // PRESERVED on a match: billProgress, billCycleCount, kStableFrozen.
    // The folded cursor moves to the frame TAIL, which is what skips this frame's samples.
    lastAppliedFoldedCallSeq: frameTailSeq,
    billAnchorFoldedCallSeq: frameTailSeq,
    // The anchor's L is SEEDED from the frame, not zeroed: the reducer owns this field's runtime semantics
    // and the manager only seeds it when it independently selects an anchor. A zero here would make the
    // first later integration measure its interval from an L the session never had.
    billAnchorLRead: Number.isFinite(frameLRead) ? frameLRead : 0,
    lastBurnRate: null,
    lastAppliedLRead: null,
    pausedReason: null,
    // A pulse is an in-process single-turn signal. Carrying `lastStopEvent` across a discontinuity would
    // re-render an alert for context this stream no longer contains; `lastBillEvent` has no reader since its
    // publisher retired, and is cleared with it so the shape a later reader meets stays the live one.
    lastBillEvent: null,
    lastStopEvent: null,
    currentTurnSeq: frameTurnSeq,
  };
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
// On a DISK load, clear `lastBillEvent`/`lastStopEvent`: a pulse is an in-process, single-turn signal. The
// schema version is unchanged across the pulse publisher's retirement, so a ledger written by an earlier
// build is still loadable and can still carry a value here. `reanchorLedger` clears both again; which of the
// two a given path reaches is carried by `DEAD-BACKSTOP-FUNCTIONS` in
// `docs/2026-07-03-session-watcher-deferred-minors.md`, along with what no test holds.
function hydrateLedger(sessionId) {
  const live = _ledgers.get(sessionId);
  if (live) return live;                                   // in-memory: already pulse-correct
  const disk = loadRateLampState(sessionId);               // one-time disk hydrate
  if (!disk) return null;
  const cleaned = { ...disk, lastBillEvent: null, lastStopEvent: null };
  // Seed the process-only lastPersistedRevision to the loaded ledgerRevision so the C5a persist gate starts
  // from the actual on-disk revision. NO v1 back-fill and NO .bak: loadRateLampState already ran
  // validateLedgerState, which returns null for any non-v2 ledger, so a null load means the caller builds a
  // freshLedger. Nothing here copies or migrates the old file.
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

  // An UNRELIABLE or invalid frame preserves the accumulated integral and clears the burn anchor: the
  // integral is durable spend, while an anchor across an unmeasurable stretch would integrate a trapezoid
  // over a gap. Reliability comes only from the current frame — `hasObservedSource` is not an input.
  if (!reliable) {
    if (!ledger) return { ledger: null, status: frame.status, bill: null };
    ledger = mutateLedger(ledger, 'unreliable-frame', (l) => {
      l.pausedReason = frame.status?.unavailableReason || 'insufficient_data';
      l.lastBurnRate = null;
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
  const kStableFrozen = 0;   // retired quantity; the ledger field survives as a dead storage slot

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

  let samples = frame.samples;
  if (revisionChanged || sequenceGap || !ledger || ledger.stateKey !== currentKey) {
    ledger = reanchorLedger(ledger, {
      currentKey, frameTailSeq: frame.foldedCallSeq, frameTurnSeq: frame.turnSeq,
      frameLRead: frame.status.L_read, kStableFrozen,
    });
    // The current frame's samples are SKIPPED: the cursor now sits at their tail. The first later reliable
    // call establishes the new burn anchor.
    samples = [];
    // Recorded once the in-memory reanchor has succeeded, WITHOUT waiting for persistence: a write-behind
    // failure must not make the next frame reanchor a second time and skip live samples.
    _lastSeenRevision.set(sessionId, frame.streamRevision);
  }

  // Pre-compute the deep-water quantities the per-call gate/backstop reads. One frame, one basis.
  const status = frame.status;
  const bPos = status.B_default > 0 ? status.B_default : status.B_post;
  const cRatioGate = Number.isFinite(status.C_RATIO) ? status.C_RATIO : 0;
  const gGate = status.gEma;
  const mfGate = (gGate > 0 && bPos > 0 && cRatioGate > 0) ? computeMovableFrac(cRatioGate, bPos, gGate) : 0;
  const dhatGate = (gGate > 0 && bPos > 0 && cRatioGate > 0) ? nucleus(cRatioGate, gGate, bPos) : 0;

  // ONE mutation per advance (B2): the clone and the content diff run once, not per sample. Atomic — a
  // mid-batch throw discards the draft and leaves the prior ledger and its cursor untouched.
  ledger = mutateLedger(ledger, 'advance-events', (l) => {
    // Snapshot the pre-batch event ref so only events the user has had a chance to see are cleared; one
    // fired inside THIS batch is not yet visible to any external reader.
    const preExistingStopEvent = l.lastStopEvent;
    for (const s of samples) {
      // Only CONTIGUOUS new samples drain while the revision is unchanged.
      if (!(s.seq > l.lastAppliedFoldedCallSeq)) continue;
      // Human turn boundary clear: the user sent a new message, so they have seen the statusline alert.
      if (s.turnSeq > l.currentTurnSeq && l.lastStopEvent && l.lastStopEvent === preExistingStopEvent) l.lastStopEvent = null;
      const _prevCycle = l.billCycleCount;
      Object.assign(l, applyFoldedCallSample(l, s));
      const cycled = l.billCycleCount - _prevCycle;
      if (!_PROBE_OFF && cycled > 0) {
        _cProbe(`[cycle] bill=${l.billCycleCount} progress=${l.billProgress?.toFixed(3)} br=${l.lastBurnRate?.toFixed(3) ?? '?'} seq=${s.seq} turn=${s.turnSeq} inDeep=${l.hasDeepWaterGateFired} dwBills=${l.dwBillsSinceLastAlert}`);
      }
      // Per-call gate/backstop: advances on EVERY API call (the gate counts calls, not cycles).
      if (bPos > 0) {
        const x = s.L_read / bPos;
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
    // The Engine turn, assigned after EVERY frame including a zero-sample one, and permitted to decrease.
    l.currentTurnSeq = frame.turnSeq;
  });

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

// round-6 GPT#7: test-only reset of the module singleton. `node --test` runs files in one process and the
// _ledgers Map would otherwise bleed live ledgers between tests → order-dependent flakes. Tests call this
// in beforeEach; production never does. (Underscore-prefixed = not part of the public runtime contract.)
// C5a: also clears coalesced timer, pending sids, ENOSPC pause state, counters, and test hooks.
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

// SIGINT/SIGTERM flush (round-2 gemini 二.1). Per-iteration try/catch (final-review gemini#3): one
// failing save (disk full / bad path for a single session) must NOT abort the flush for the others.
export function flushAll() {
  for (const [sid, l] of _ledgers) {
    try { saveRateLampState(sid, l); } catch { /* best-effort on shutdown; a stale checkpoint reconstructs on next poll */ }
  }
}
