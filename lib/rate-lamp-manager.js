import { freshLedger, applyFoldedCallSample, stateKeyForStatus, loadRateLampState, saveRateLampState } from './rate-lamp-store.js';
import { deriveFrozenExit } from './rate-lamp.js';

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

// The single persistence entry inside the manager (single-writer invariant). Gated: writes only when the
// serialized ledger differs from what we last wrote for this session, UNLESS force is set. `force` is used
// by the explicit set-and-persist paths (setLiveLedger from the Stop route) so a caller that deliberately
// pushes a ledger always lands on disk; the per-poll advance path leaves force off so a no-op poll elides.
function persistLedger(sessionId, ledger, { force = false } = {}) {
  const serialized = JSON.stringify(ledger);
  if (!force && _lastSaved.get(sessionId) === serialized) return; // identical to last write → skip the redundant rewrite
  saveRateLampState(sessionId, ledger);
  _lastSaved.set(sessionId, serialized);
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
  // reuse — continue integrating (GPT#1). round-6 gemini#1 / round-7 GPT#1: sync the turn cursor (and
  // zero ΔW on a real advance) even here, so a turn with zero eligible folded calls still advances the
  // cursor (UI TTL expires the stale pulse) AND does not carry the prior turn's ΔW into a false backstop.
  return syncLedgerTurn({ ...persisted }, watcherTurnSeq);
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
    // final-review GPT#4: the TTL read compares lastBillEvent.turnSeq === currentTurnSeq, so
    // currentTurnSeq MUST reach status — else the pulse TTL cannot be evaluated and pulses never show.
    status.rateLamp.currentTurnSeq = ledger.currentTurnSeq;
    if (ledger.lastBillEvent) status.rateLamp.lastBillEvent = ledger.lastBillEvent;
    // final-review GPT#2: the FULL resolved Stop message (wall / dw_backstop / empty_burn / gate),
    // not just the bill pulse — with no OS notification, this is the ONLY UI home for the alert text.
    if (ledger.lastStopEvent) status.rateLamp.lastStopEvent = ledger.lastStopEvent;
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
  return { ...ledger, lastStopEvent: { kind: resolved.kind, delivery: resolved.delivery, message: resolved.message, billCount: resolved.billCount ?? 0, turnSeq } };
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
  _ledgers.set(sessionId, cleaned);
  return cleaned;
}

// The ONE mutating entry (round-2 GPT#2/#6, final-review GPT#1). forcePoll:true for the Stop route
// (GPT#6 — must ingest the just-ended turn before judging). Drains EVERY new folded call, reliable or
// NOT: the unreliable branch does NOT early-return (final-review GPT#1 — that was the 3rd recurrence of
// the drain-gated-on-reliable bug). Overrides xExit from the FROZEN k_stable (GPT#5).
export function advanceRateLampToCurrent(watcher, sessionId, { forcePoll = false } = {}) {
  if (forcePoll) watcher.poll();
  const status = watcher.getStatus();
  const reliableLatched = status.rateLamp?.reliable === true;

  // UNRELIABLE / not-yet-latched frame (final-review GPT#1): we cannot recompute the state key (the
  // instant bundle omits C_RATIO/L_cap when unreliable), so we do NOT reset/re-key. But if a ledger
  // ALREADY exists we MUST still advance its seq cursor with seq-only unreliable samples, or recovery
  // hits a false folded_seq_gap. A pre-latch frame with no ledger yet simply has nothing to advance
  // (the fresh ledger will anchor at the current seq when the latch closes — R2-3).
  if (!reliableLatched) {
    let ledger = hydrateLedger(watcher, sessionId);
    // No seq_history_mismatch special-case (was: `&& pausedReason !== 'seq_history_mismatch'`).
    // resolveLedgerForKey now RE-ANCHORS on a seq mismatch instead of setting a terminal pause, so this
    // reason is only ever seen on a ledger persisted by a pre-fix binary. Draining seq-only unreliable
    // samples overwrites it with the unreliable reason + advances the cursor; the reliable recovering
    // branch then clears it — self-healing, never terminal.
    if (ledger) {
      const reason = status.rateLamp?.unavailableReason || 'metrics_unreliable';
      const seqSamples = watcher.rateLampSeqSamplesSince(ledger.lastAppliedFoldedCallSeq, { unavailableReason: reason });
      for (const s of seqSamples) ledger = applyFoldedCallSample(ledger, s); // seq-only: advances cursor, pauses, no integration
      // round-6 gemini#1 / round-7 GPT#1: sync the turn cursor (zero ΔW on a real advance) even when nothing integrated.
      ledger = syncLedgerTurn(ledger, watcher._turnSeq);
      _ledgers.set(sessionId, ledger);
      persistLedger(sessionId, ledger); // #6: gated — a seq-only unreliable frame that changed nothing elides the write
    }
    return { ledger: ledger ?? null, status, bill: null };
  }

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
  for (const s of samples) ledger = applyFoldedCallSample(ledger, s);

  // round-6 gemini#1: UNCONDITIONAL turn-cursor sync before checkpoint. resolveLedgerForKey already ran
  // syncLedgerTurn (zeroing ΔW if the turn advanced) BEFORE the reducer, and the reducer's A3 reset owns
  // ΔW for any integrated sample this turn — so here we ONLY pin the cursor forward, we must NOT zero ΔW
  // again (that would erase a legitimate current-turn ΔW the reducer just accumulated). Cursor-only Math.max.
  ledger = { ...ledger, currentTurnSeq: Math.max(ledger.currentTurnSeq ?? 0, watcher._turnSeq) };

  _ledgers.set(sessionId, ledger);
  persistLedger(sessionId, ledger); // #6: gated — an unchanged poll (no new call, no turn advance) elides the redundant write
  // xExit override + event merge via the SAME mergeLedgerIntoStatus the /api/status route uses (round-3
  // GPT#2 — one source for frozen-xExit so the Stop route's `status` and the API can never drift).
  mergeLedgerIntoStatus(status, ledger, currentKey);
  return { ledger, status, bill: null };
}

export function getLiveLedger(sessionId) { return _ledgers.get(sessionId) ?? null; }
// #6: the Stop route's explicit set-and-persist. force:true so a deliberate push always lands on disk,
// AND updates the write-elision cache so the next poll advance with the same ledger correctly elides.
export function setLiveLedger(sessionId, ledger) { _ledgers.set(sessionId, ledger); persistLedger(sessionId, ledger, { force: true }); }
// round-6 GPT#7: test-only reset of the module singleton. `node --test` runs files in one process and the
// _ledgers Map would otherwise bleed live ledgers between tests → order-dependent flakes. Tests call this
// in beforeEach; production never does. (Underscore-prefixed = not part of the public runtime contract.)
export function _resetRateLampManagerForTest() { _ledgers.clear(); _lastSaved.clear(); }
// SIGINT/SIGTERM flush (round-2 gemini 二.1). Per-iteration try/catch (final-review gemini#3): one
// failing save (disk full / bad path for a single session) must NOT abort the flush for the others.
export function flushAll() {
  for (const [sid, l] of _ledgers) {
    try { saveRateLampState(sid, l); } catch { /* best-effort on shutdown; a stale checkpoint reconstructs on next poll */ }
  }
}
