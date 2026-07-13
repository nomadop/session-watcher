import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJsonAtomic, safeSessionId } from './atomic-store.js';
import { validateLedgerState, validateRateLampSample } from './ledger-schema.js';
import { SETTLED_SUMMARY_SOFT_LIMIT, SETTLED_SUMMARY_HARD_LIMIT, RECENT_STOP_EVENTS_LIMIT, RECENT_PROCESSED_HOOK_IDS_LIMIT, PENDING_STOP_EVALUATIONS_LIMIT, PENDING_STOP_TTL_MS, PENDING_MAX_TURN_DISTANCE } from './constants.js';
import { resolveStopMessage } from './stop-message.js';

// The ledger's serialized version FIELD (spec §5.2 C-1). Bumped 1→2 for the v2.2-C per-turn settlement
// engine's 8 new fields. `validateLedgerState` HARD-gates `schemaVersion !== 2 → null`, so a stale v1 disk
// ledger is judged foreign → loadRateLampState null → freshLedger degrade (H-C: NO migration, NO .bak; the
// session ledger is a per-session transient that re-calibrates a short span, not a persistent asset).
// NOTE: this is the ledger's `.schemaVersion` FIELD — do NOT confuse it with stateKeyForStatus's FIXED
// segment-identity discriminator constant (still 1 below), which does NOT distinguish v1 from v2.
const SCHEMA_VERSION = 2;

// State key (spec §4.4). xExit is DELIBERATELY absent (§2.3: frozen k_stable makes it a segment
// constant already covered by segmentId+baselineFingerprint). Order-stable JSON of the fields.
export function stateKeyOf({ segmentId, model, cRatio, baselineFingerprint, contextCap, schemaVersion = SCHEMA_VERSION }) {
  return JSON.stringify([segmentId, model, cRatio, baselineFingerprint, contextCap, schemaVersion]);
}

// #10 (fix wave): the SAME state-key arg object was built at three sites (manager advance, /api/status,
// Stop route) — all reading segment/model/C_RATIO/fingerprint/L_cap off a status-like object. One helper
// so the key can never drift between them. Byte-identical to the former inlinings (schemaVersion pinned
// to 1 exactly as all three did). Callers keep their own `reliable` guard — this only builds the key.
export function stateKeyForStatus(status) {
  return stateKeyOf({
    segmentId: status.segment,
    model: status.model,
    cRatio: status.rateLamp.C_RATIO,
    baselineFingerprint: status.baseline?.fingerprint ?? null,
    contextCap: status.rateLamp.L_cap,
    schemaVersion: 1,
  });
}

export function freshLedger(stateKey, kStableFrozen = 0) {
  return {
    schemaVersion: SCHEMA_VERSION, stateKey, billingBasis: 'fullCarry',
    billProgress: 0, billCycleCount: 0,
    billAnchorLRead: 0, billAnchorTurnSeq: 0, billAnchorFoldedCallSeq: 0,
    lastBurnRate: null, lastAppliedFoldedCallSeq: 0, lastAppliedLRead: null,
    currentTurnSeq: 0, currentTurnDeltaW: 0, pendingBillCountSinceBoundary: 0,
    pausedReason: null, cacheExpiryCount: 0,
    kStableFrozen,   // GPT#11: frozen at segment establishment; same-key restart reuses it (no xExit drift)
    lastBillEvent: null, // round-2 GPT#7: TTL pulse channel for statusline (kind/billCount/deltaL/delivery/turnSeq)
    lastStopEvent: null, // final-review GPT#2: full resolved Stop-message channel (only UI home w/ no OS notify)
    // v2.2-C fields (schema v2). All serialized EXCEPT lastPersistedRevision (process-only, set in hydrate).
    // `schemaVersion` above IS the version field (spec's `ledgerSchemaVersion` = same concept, one name).
    // No field here is READ by settle/alert this sub-batch (C1-1): behavior/metric output byte-identical.
    settledThroughTurnSeq: 0, alertEvaluatedThroughTurnSeq: 0, ledgerRevision: 0,
    pendingStopEvaluations: [], settledTurnSummaries: [], recentStopEvents: [], recentProcessedHookEventIds: [],
    deepWaterDisplayLatched: false,   // RV-C16 server-side region-lamp latch (PRODUCED here, WRITTEN in C2-1, consumed in A2)
  };
}

// R5 GPT#3: a corrupt `prev` must yield a state that ITSELF re-validates — otherwise a `{...prev,
// pausedReason}` "shell" whose billProgress is (say) 1.2 is STILL schema-invalid, so under the in-memory
// single writer it stays wedged paused in _ledgers until process restart (the disk-load path self-heals
// by treating null as fresh, but the live copy does not reload). Rebuild a clean paused ledger, preserving
// only the safely-reusable stateKey, and freeze whatever kStable we can salvage (guarded >0 downstream).
function invalidPausedLedger(prev) {
  const stateKey = (prev && typeof prev === 'object' && typeof prev.stateKey === 'string') ? prev.stateKey : '__invalid__';
  const kStable = (prev && Number.isFinite(prev.kStableFrozen) && prev.kStableFrozen >= 0) ? prev.kStableFrozen : 0;
  const s = freshLedger(stateKey, kStable);
  s.pausedReason = 'invalid_sample';
  return s;
}

// DRY helper: push a stop event onto the recentStopEvents ring (mutable, in-place on a draft/ledger).
// Ensures the array exists, appends, trims to RECENT_STOP_EVENTS_LIMIT. Used by drainPendingStopEvaluations,
// the stop-enqueue commit in server.js, and recordStopEvent.
export function pushStopEventRing(ledgerOrDraft, evt) {
  if (!ledgerOrDraft.recentStopEvents) ledgerOrDraft.recentStopEvents = [];
  ledgerOrDraft.recentStopEvents.push(evt);
  if (ledgerOrDraft.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) {
    ledgerOrDraft.recentStopEvents.splice(0, ledgerOrDraft.recentStopEvents.length - RECENT_STOP_EVENTS_LIMIT);
  }
}

// Event-sourced reducer (spec §4.4 applyFoldedCallSample). PURE — returns a new state, no I/O.
// sample: { seq, reliable, unavailableReason?, burnRate, L_read, turnSeq }. L_read is effectiveL — the
// field name is the guard (review GPT#1): a cacheRead-named sample is a bug (fails Task 2.5 validator).
export function applyFoldedCallSample(prev, sample) {
  // Validate on entry (round-2 GPT + final-review GPT#5): a malformed STATE or SAMPLE pauses rather than
  // corrupting the ledger. Validate `prev` first — a half-corrupt ledger (billProgress≥1, negative seq,
  // bad pausedReason) must not be integrated onto. Return a minimally-safe paused shell, not the bad state.
  if (!validateLedgerState(prev)) return invalidPausedLedger(prev); // R5 GPT#3: return a RE-VALIDATING paused state
  const s = { ...prev };
  // The field guard here is what makes a `cacheRead`-named sample a hard error, not a silent no-op.
  if (!validateRateLampSample(sample)) { s.pausedReason = 'invalid_sample'; return s; }

  // Idempotency / gap checks run for BOTH reliable and unreliable samples so seq stays continuous.
  // In-place-fold defense (round-2 GPT#9, FOLD-LITE): if an ALREADY-applied seq reappears with a
  // CHANGED L_read (an in-place fold mutated a call the ledger already integrated), we cannot silently
  // re-integrate — pause instead of drifting. The only real in-place fold is output-only (does not
  // change effectiveL — pinned by Task 0's FU-B1-coupling value test), so this fires only on an
  // unexpected cr/cc rewrite (UNREACHABLE for Claude/DeepSeek; full replay stays deferred to M8).
  if (sample.seq === s.lastAppliedFoldedCallSeq && sample.reliable
      && Number.isFinite(s.lastAppliedLRead) && Number.isFinite(sample.L_read)
      && sample.L_read !== s.lastAppliedLRead) {
    s.pausedReason = 'folded_call_mutated'; return s;
  }
  if (sample.seq <= s.lastAppliedFoldedCallSeq) return s;                 // idempotent no-op (P0-2)
  if (s.lastAppliedFoldedCallSeq !== 0 && sample.seq !== s.lastAppliedFoldedCallSeq + 1) {
    // record the seq; do not integrate across the gap. round-7 GPT (low-pri): also advance lastAppliedLRead
    // when the gap sample carries one, so a repeat of this same gap sample stays a clean idempotent no-op
    // rather than tripping the folded_call_mutated L-compare against a STALE prior-applied L. Unreachable on
    // the live manager path (it only emits foldedSeq>sinceSeq once) — reducer-robustness only.
    s.pausedReason = 'folded_seq_gap';
    s.lastAppliedFoldedCallSeq = sample.seq;
    if (sample.reliable && Number.isFinite(sample.L_read)) s.lastAppliedLRead = sample.L_read;
    return s;
  }

  // Per-turn ΔW reset (A3): zero currentTurnDeltaW when the turn changes, BEFORE this call's trapezoid.
  if (sample.turnSeq !== s.currentTurnSeq) { s.currentTurnSeq = sample.turnSeq; s.currentTurnDeltaW = 0; }

  // Unreliable sample: ADVANCE the seq cursor (A2), pause, freeze lastBurnRate — no integration.
  if (!sample.reliable) {
    s.pausedReason = sample.unavailableReason || 'insufficient_data';
    s.lastBurnRate = null;                    // force a clean re-anchor on recovery (P0-5)
    s.lastAppliedFoldedCallSeq = sample.seq;
    return s;
  }

  const br = Number.isFinite(sample.burnRate) ? Math.max(0, sample.burnRate) : 0;

  // First frame after (re)anchor: only re-anchor lastBurnRate, do NOT integrate (P0-5 no catch-up).
  const recovering = s.pausedReason != null || s.lastBurnRate == null;
  if (recovering) {
    s.pausedReason = null;
    s.lastBurnRate = br;
    s.lastAppliedFoldedCallSeq = sample.seq;
    s.lastAppliedLRead = sample.L_read;         // round-2 GPT#9: remember the applied L for mutation detection
    // R5 GPT#7: set ALL three anchor fields together on the first anchor (R2-12) — billAnchorTurnSeq was
    // omitted here and in the manager's anchorFresh, leaving the pulse-event window / restart-debug anchor at 0.
    if (s.billAnchorFoldedCallSeq === 0) { s.billAnchorLRead = sample.L_read; s.billAnchorFoldedCallSeq = sample.seq; s.billAnchorTurnSeq = sample.turnSeq; }
    return s;
  }

  const trap = 0.5 * (s.lastBurnRate + br);
  // §float — the stored remainder MUST stay < 1 ("[0,1) metronome" invariant). We enforce that with
  // FLOOR-on-store, not round. The crossing test and every −=1 run on the UNROUNDED running value: a
  // Math.round anywhere in this path can push a remainder in [0.9999995, 1) UP to exactly 1.0, which
  // (a) re-enters the loop for a phantom extra bill and (b) inflates currentTurnDeltaW to a whole
  // integer, tripping the ΔW backstop one call early. Floor cannot round up, so both stay honest. The
  // floor bias is downward and bounded by 1e-6 per settlement — conservative by design: bill counts
  // under-count rather than over, and the backstop fires late rather than early.
  let next = s.billProgress + trap;
  while (next >= 1) {
    next -= 1;                                  // subtract on the unrounded running value — no round here
    s.pendingBillCountSinceBoundary += 1;
    s.billCycleCount += 1;
  }
  s.billProgress = Math.floor(next * 1e6) / 1e6;               // floor keeps the remainder < 1 by construction
  s.currentTurnDeltaW = Math.floor((s.currentTurnDeltaW + trap) * 1e6) / 1e6;
  s.lastBurnRate = br;
  s.lastAppliedFoldedCallSeq = sample.seq;
  s.lastAppliedLRead = sample.L_read;           // round-2 GPT#9: applied-L snapshot for in-place-fold defense
  return s;
}

// Batch settlement + channel routing at a Stop boundary (spec §3.3 / §4.4 multi-bill batch, P0-3/P0-4).
// Returns { state, bill|null }. ONE bill message per boundary carrying billCount; anchor updated once.
// L_readNow is effectiveL (never raw cacheRead) — a miss row RAISES L_read, so ΔL is positive and is
// NOT mistaken for a cache-expiry negative jump (review GPT#1 regression test).
export function settleBatchAtBoundary(prev, { L_readNow, kStable, inDeepWater, foldedSeqNow, turnSeqNow }) {
  // final-review GPT#5: validate the ledger state at the settle entry too — never settle a corrupt ledger.
  // R5 GPT#3: the paused state returned here must itself re-validate (same reason as the reducer entry).
  if (!validateLedgerState(prev)) {
    return { state: invalidPausedLedger(prev), bill: null };
  }
  const s = { ...prev };
  const pending = s.pendingBillCountSinceBoundary;
  if (pending <= 0) return { state: s, bill: null };

  const deltaL = L_readNow - s.billAnchorLRead;
  // Re-anchor helper — updates ALL three anchor fields together (round-2 GPT#12: billAnchorTurnSeq /
  // billAnchorFoldedCallSeq were declared but never maintained; they scope the pulse-event window +
  // restart debug, so they must move with billAnchorLRead).
  const reanchor = () => {
    s.billAnchorLRead = L_readNow;
    if (Number.isFinite(foldedSeqNow)) s.billAnchorFoldedCallSeq = foldedSeqNow;
    if (Number.isFinite(turnSeqNow)) s.billAnchorTurnSeq = turnSeqNow;
    s.pendingBillCountSinceBoundary = 0;
  };

  // L_read negative jump (cache-expiry transient that slipped past effectiveL) — pause, never fire
  // empty_burn, do not roll back billProgress. Presentation is CALIBRATING / cache-unstable, NOT the
  // "ctx growing" non_idle copy (round-2 GPT#13 — a negative jump is the opposite of growing).
  if (deltaL < 0) {
    s.pausedReason = 'cache_unstable';
    s.cacheExpiryCount += 1;
    reanchor();
    return { state: s, bill: { kind: 'cache_unstable', delivery: 'statusline_pulse', billCount: pending, deltaL, degraded: 'cache_unstable' } };
  }

  const isEmpty = deltaL < kStable;
  const kind = isEmpty ? 'empty_burn' : 'non_idle_burn';
  // empty_burn only hooks in deep water (§3.7); shallow/sweet water routes to statusline (gate owns it).
  const delivery = (kind === 'empty_burn' && inDeepWater) ? 'stop_hook' : 'statusline_pulse';

  reanchor();                                   // anchor updated ONCE per batch (all three fields)
  return { state: s, bill: { kind, delivery, billCount: pending, deltaL } };
}

// ── v2.2-C per-turn meter settlement (spec §3.2/§3.3). ────────────────────────────────────────────
// NEW SIBLING of settleBatchAtBoundary — NOT a replacement, NOT a delegate. settleBatchAtBoundary above is
// kept VERBATIM (v2.1 body) so the C0-1 golden oracle + the Stop route see byte-identical {state,bill}.
// This sibling is what the C2 reader loop calls at EVERY turn boundary. Differences from settleBatchAtBoundary
// (user-adjudicated option A — why this is a sibling, not a delegation): this fn (a) ALWAYS runs the meter
// half every boundary (no `pending<=0` early return — a zero-call turn still re-anchors + zeros + appends),
// (b) zeros currentTurnDeltaW, (c) appends an immutable turn summary, (d) produces NO alert routing decision
// (returns a `billKindAtBoundary` SNAPSHOT in the summary instead). The old settleBatchAtBoundary does NONE
// of (a)–(c) — literal delegation would change the frozen oracle's {state} (non-zero currentTurnDeltaW, empty
// settledTurnSummaries), re-reddening a one-task-old safety net. C4 later removes settleBatchAtBoundary.
//
// PURE — returns { state, summary }; no I/O. `inDeepWater` is the BOUNDARY's state (F4): the CALLER derives
// it from THIS boundary's L_readNow (C2 reader loop), never a single live "now" flag — this fn only snapshots
// the arg into inDeepWaterAtBoundary. `hBreakAtBoundary` is derived here from lastBurnRate.
export function settleMeterAtBoundary(prev, { L_readNow, kStable, foldedSeqNow, turnSeqNow, endedTurnSeq, inDeepWater }) {
  // Same entry guard as settleBatchAtBoundary: never settle a corrupt ledger; the paused state re-validates.
  if (!validateLedgerState(prev)) return { state: invalidPausedLedger(prev), summary: null };
  // turnSeq-idempotent dedup gate (spec §3.3): a boundary already settled (by the reader OR the Stop-route
  // fallback, whichever arrived first) is a CLEAN no-op — no re-anchor, no double summary, no deltaW re-zero.
  // Primary guard for exactly-once; the C2 loop's `currentTurnSeq > settledThroughTurnSeq` is belt-and-braces.
  if (endedTurnSeq <= prev.settledThroughTurnSeq) return { state: prev, summary: null };
  const s = { ...prev };

  // Capture the pre-reanchor meter state — every summary field reads the boundary as it was BEFORE we advance.
  const anchorBefore = s.billAnchorLRead;
  const foldedCallSeqStart = s.billAnchorFoldedCallSeq;                         // the anchor's folded seq (before)
  const foldedCallSeqEnd = Number.isFinite(foldedSeqNow) ? foldedSeqNow : s.lastAppliedFoldedCallSeq;
  const deltaW = L_readNow - anchorBefore;                                      // may be NEGATIVE (cache_unstable)
  const deltaL = deltaW;                                                        // same quantity (kept named for the kind branches)
  const billProgressBefore = s.billProgress;
  const billCycleCountIncrement = s.pendingBillCountSinceBoundary;              // bills accrued this window (settleBatch's billCount)

  // Re-anchor helper — identical to settleBatchAtBoundary's: all three anchor fields move together.
  const reanchor = () => {
    s.billAnchorLRead = L_readNow;
    if (Number.isFinite(foldedSeqNow)) s.billAnchorFoldedCallSeq = foldedSeqNow;
    if (Number.isFinite(turnSeqNow)) s.billAnchorTurnSeq = turnSeqNow;
    s.pendingBillCountSinceBoundary = 0;
  };

  // billKindAtBoundary (B3 snapshot). deltaL = L_readNow - anchorBefore (the same quantity used for deltaW).
  let billKindAtBoundary;
  if (deltaL < 0) {
    // negative-jump / cache-expiry pause — the meter records it EXACTLY as settleBatchAtBoundary does
    // (pausedReason + cacheExpiryCount), so a per-turn settle of a cache-unstable boundary behaves the same.
    billKindAtBoundary = 'cache_unstable';
    s.pausedReason = 'cache_unstable';
    s.cacheExpiryCount += 1;
  } else if (deltaL < kStable) {
    billKindAtBoundary = 'empty_burn';         // little new context this cycle
  } else {
    billKindAtBoundary = 'non_idle_burn';
  }
  // zero-call turn: no folded call landed in this turn (start===end) → no bill cycle could have crossed →
  // null kind (the 串轮 marker). NOTE this is the folded-seq equality, NOT deltaW===0 (a real call with no L
  // growth is also deltaW 0 but is a genuine non_idle/empty boundary that CAN carry a kind — spec §3.4a).
  if (foldedCallSeqStart === foldedCallSeqEnd) billKindAtBoundary = null;
  // H-pt6 (round-6): pre-calibration degrade guard. Before k_stable calibrates (frozen ≤0 or NaN) NO boundary
  // may carry an alertable kind — clears ONLY billKindAtBoundary; does NOT skip the meter anchor advance
  // (that still happens below). Degrade correctness (consistent with the v1.1 latch / B1 _metricsReliable
  // philosophy), and it stops the pseudocode from literally emitting a groundless non_idle.
  if (!Number.isFinite(kStable) || kStable <= 0) billKindAtBoundary = null;

  reanchor();                                   // advance the anchor every boundary (per-turn engine, §3.3)
  s.currentTurnDeltaW = 0;                       // zero the per-turn ΔW — alert judgment reads the summary, not this

  // hBreakAtBoundary from lastBurnRate (rate-lamp.js: burnRate>0 ? 1/burnRate : Infinity), degrading to null
  // when no rate is known. Validator accepts null OR >0 (Infinity = never-break-even).
  const hBreakAtBoundary = Number.isFinite(s.lastBurnRate)
    ? (s.lastBurnRate > 0 ? 1 / s.lastBurnRate : Infinity)
    : null;

  // Immutable-by-convention turn summary (spec §3.2 shape, field order pinned). Deliberately NOT Object.freeze:
  // validateLedgerState VALIDATE-AND-TOLERATE back-fills a summary's display fields in place (`billProgress*
  // → NaN`, `hBreak → null`) rather than wiping the whole ledger; freezing would turn that graceful degrade
  // into a strict-mode throw. Ours are always in-domain (so the back-fill never fires), but immutability here
  // is a discipline (never mutate a summary in place), not a hard freeze — keeps the tolerate path throw-free.
  const summary = {
    turnSeq: endedTurnSeq,
    foldedCallSeqStart,
    foldedCallSeqEnd,
    deltaW,
    billProgressBefore,
    billProgressAfter: s.billProgress,          // settle never touches billProgress → equal to before (byte-identical)
    billCycleCountIncrement,
    inDeepWaterAtBoundary: inDeepWater === true, // F4 snapshot of the caller-derived boundary flag (strict bool for the validator)
    hBreakAtBoundary,
    billKindAtBoundary,
  };

  const state = appendSettledTurnSummary(s, summary);
  return { state, summary };
}

// Push a summary onto the settledTurnSummaries ring, then hard-cap trim at the ADD site. The trim LIMIT is
// SETTLED_SUMMARY_HARD_LIMIT — the SAME constant validateLedgerState caps length at (single source of truth
// via constants.js): if the writer trimmed to a DIFFERENT value, a legitimately-trimmed ring would trip the
// validator's over-LIMIT reject → whole-ledger WIPE. Evicts OLDEST (ring). This is only the corrupt-unbounded
// -growth backstop; the softer, reference-aware reclaim is gcSettledTurnSummaries (which needs a watermark
// this fn does not have, so append does NOT call it). PURE — new array, prev's array untouched.
export function appendSettledTurnSummary(ledger, summary) {
  const summaries = [...ledger.settledTurnSummaries, summary];
  if (summaries.length > SETTLED_SUMMARY_HARD_LIMIT) {
    summaries.splice(0, summaries.length - SETTLED_SUMMARY_HARD_LIMIT);        // drop the oldest overflow
  }
  return { ...ledger, settledTurnSummaries: summaries };
}

// Soft reclaim of old settled summaries (spec §3.2 GC, round-5 G9). Deletes ONLY summaries below the pure
// TURN-watermark bound `minRequiredTurnSeq` (which the caller computes as the min over every consumer —
// alertEvaluatedThroughTurnSeq+1, each pending's beforeSettledThroughTurnSeq+1, min recentStopEvents turnSeq).
// Because that bound already excludes every referenced turn, dropping `turnSeq < minRequiredTurnSeq` is the
// reference guard — a summary any pending/stop-event could still need is never evicted (even if that keeps the
// ring temporarily above the soft limit; never orphan a pending). NO minPendingFoldedCallSeq term (E2 left it
// sourceless — pending carries only beforeSettledThroughTurnSeq). Only reclaims once past the soft limit; the
// hard cap is enforced at the append site. PURE.
export function gcSettledTurnSummaries(ledger, { minRequiredTurnSeq } = {}) {
  const summaries = ledger.settledTurnSummaries || [];
  if (summaries.length <= SETTLED_SUMMARY_SOFT_LIMIT) return ledger;           // under soft limit → normal, nothing to reclaim
  const bound = Number.isFinite(minRequiredTurnSeq) ? minRequiredTurnSeq : 0;
  const kept = summaries.filter((sm) => sm.turnSeq >= bound);                  // reference guard baked into `bound` (G9)
  if (kept.length === summaries.length) return ledger;                         // all referenced → temporarily exceed soft
  return { ...ledger, settledTurnSummaries: kept };
}

// Persistence (atomic + schema-guarded load, GPT#12). Path: ${CLAUDE_PLUGIN_DATA}/rate-lamp-state/<sid>.json
// else ~/.session-watcher/rate-lamp/. A corrupt/half-valid file → validateLedgerState returns null →
// caller treats as "no saved state" (silent fresh), never crashes.
function pathFor(sessionId) {
  const base = process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, 'rate-lamp-state')
    : join(homedir(), '.session-watcher', 'rate-lamp');
  return join(base, `${safeSessionId(sessionId || 'default')}.json`); // round-6 GPT#3b: no path traversal
}
export function loadRateLampState(sessionId) {
  try { return validateLedgerState(JSON.parse(readFileSync(pathFor(sessionId), 'utf8'))); } catch { return null; }
}
export function saveRateLampState(sessionId, state) { writeJsonAtomic(pathFor(sessionId), state); }

// ─── C3-2: Pending Stop evaluation helpers (spec §3.4a) ───────────────────────

/**
 * settleableDistanceAfterWatermark (E9 — named pure fn).
 * Counts the number of SETTLEABLE (non-zero-call) summary turns between the watermark and the
 * candidate summary's turnSeq. A zero-call turn has foldedCallSeqStart === foldedCallSeqEnd (NOT deltaW===0).
 * A MISSING turn (gap in the turnSeq sequence) makes the distance unbounded → Infinity → expire.
 */
export function settleableDistanceAfterWatermark(summaries, watermarkTurnSeq, candidateTurnSeq) {
  // Summaries between (watermark, candidateTurnSeq) exclusive on both ends — we need the turns AFTER
  // the watermark but BEFORE the candidate that tell us how far the candidate is from the watermark.
  // We need ALL turns in (watermark, candidateTurnSeq) to be represented — a missing turn → Infinity.
  const between = summaries.filter(s => s.turnSeq > watermarkTurnSeq && s.turnSeq < candidateTurnSeq);
  // Check for missing turns in the dense sequence (watermark+1 .. candidateTurnSeq-1)
  const expectedCount = candidateTurnSeq - watermarkTurnSeq - 1;
  if (between.length < expectedCount) return Infinity;  // a MISSING turn → unbounded
  // Count settleable (non-zero-call) turns between watermark and candidate (exclusive)
  const settleableBetween = between.filter(s => s.foldedCallSeqStart !== s.foldedCallSeqEnd).length;
  // The candidate itself is settleable if it's non-zero-call
  const candidateSummary = summaries.find(s => s.turnSeq === candidateTurnSeq);
  const candidateSettleable = candidateSummary && candidateSummary.foldedCallSeqStart !== candidateSummary.foldedCallSeqEnd ? 1 : 0;
  return settleableBetween + candidateSettleable;
}

/**
 * matchPendingToSummary(ledger) — match pending Stop evaluations to committed summaries.
 * Returns { assigned: [{hookEventId, summaryTurnSeq}], remainingPending: [...], expired: [...] }
 */
export function matchPendingToSummary(ledger) {
  const pending = [...(ledger.pendingStopEvaluations || [])];
  const summaries = [...(ledger.settledTurnSummaries || [])];
  // Stable sort pending by (requestedAtWallMs, enqueueSeq, hookEventId)
  pending.sort((a, b) => (a.requestedAtWallMs - b.requestedAtWallMs) || (a.enqueueSeq - b.enqueueSeq) || a.hookEventId.localeCompare(b.hookEventId));
  // Stable sort summaries by (turnSeq, foldedCallSeqEnd)
  summaries.sort((a, b) => (a.turnSeq - b.turnSeq) || (a.foldedCallSeqEnd - b.foldedCallSeqEnd));

  const assigned = [];
  const expired = [];
  const remainingPending = [];
  const usedSummaryKeys = new Set(); // turnSeq values already claimed
  const usedWatermarks = new Set();  // E2 blind-merge: one summary per watermark

  for (const p of pending) {
    // E2 blind-merge: if another pending with the SAME watermark was already assigned, expire this one
    if (usedWatermarks.has(p.beforeSettledThroughTurnSeq)) {
      expired.push(p);
      continue;
    }
    // Find the first unused summary with turnSeq > watermark
    let matched = false;
    for (const s of summaries) {
      if (s.turnSeq <= p.beforeSettledThroughTurnSeq) continue;
      const key = s.turnSeq;
      if (usedSummaryKeys.has(key)) continue;
      // A24 slide-forward cap: if distance exceeds PENDING_MAX_TURN_DISTANCE, expire
      const dist = settleableDistanceAfterWatermark(summaries, p.beforeSettledThroughTurnSeq, s.turnSeq);
      if (dist > PENDING_MAX_TURN_DISTANCE) {
        expired.push(p);
        matched = true; // signals "handled" — don't add to remaining
        break;
      }
      // Match
      assigned.push({ hookEventId: p.hookEventId, summaryTurnSeq: s.turnSeq });
      usedSummaryKeys.add(key);
      usedWatermarks.add(p.beforeSettledThroughTurnSeq);
      matched = true;
      break;
    }
    if (!matched) {
      remainingPending.push(p);
    }
  }
  return { assigned, remainingPending, expired };
}

/**
 * enqueuePending — append a watermark record to pendingStopEvaluations.
 * B7 backpressure: if array is full, returns {ok:false}; caller MUST return 503.
 * enqueueSeq is computed internally (GPT-pt3), NOT a caller arg.
 */
export function enqueuePending(ledger, { hookEventId, requestedAtWallMs, requestedAtMonoMs, processNonce, beforeSettledThroughTurnSeq }) {
  const arr = ledger.pendingStopEvaluations || [];
  if (arr.length >= PENDING_STOP_EVALUATIONS_LIMIT) return { ok: false };
  const enqueueSeq = 1 + Math.max(-1, ...arr.map(p => p.enqueueSeq));
  arr.push({
    hookEventId, requestedAtWallMs, requestedAtMonoMs, processNonce,
    beforeSettledThroughTurnSeq, assignedTurnSeq: null, status: 'pending', enqueueSeq,
  });
  return { ok: true };
}

/**
 * hasProcessedHookId (B12) — check if a hookEventId is in the recentProcessedHookEventIds ring.
 */
export function hasProcessedHookId(ledger, id) {
  return (ledger.recentProcessedHookEventIds || []).includes(id);
}

/**
 * appendProcessedHookId (B12) — push id onto recentProcessedHookEventIds ring (dedup-guarded, trimmed).
 */
export function appendProcessedHookId(ledger, id) {
  if (!ledger.recentProcessedHookEventIds) ledger.recentProcessedHookEventIds = [];
  const arr = ledger.recentProcessedHookEventIds;
  if (arr.includes(id)) return; // dedup guard
  arr.push(id);
  if (arr.length > RECENT_PROCESSED_HOOK_IDS_LIMIT) arr.splice(0, arr.length - RECENT_PROCESSED_HOOK_IDS_LIMIT);
}

/**
 * alreadyAccepted(hookEventId, ledger) — dedup check: id in processedIds OR in live pending.
 */
export function alreadyAccepted(hookEventId, ledger) {
  if (hasProcessedHookId(ledger, hookEventId)) return true;
  return (ledger.pendingStopEvaluations || []).some(p => p.hookEventId === hookEventId);
}

/**
 * expirePending — REMOVE pending entries past TTL. Returns removed entries for diagnostics.
 * A8 clock: same-process → mono TTL; cross-process (hydrated) → wall-clock freshness gate.
 * Tombstone-free: expired entries are SPLICED OUT, never marked and left.
 */
export function expirePending(ledger, { nowMono, nowWall, processNonce }) {
  const arr = ledger.pendingStopEvaluations || [];
  const removed = [];
  const kept = [];
  for (const p of arr) {
    let expired = false;
    if (p.processNonce === processNonce) {
      // Same process → monotonic TTL
      if (Number.isFinite(p.requestedAtMonoMs) && (nowMono - p.requestedAtMonoMs > PENDING_STOP_TTL_MS)) expired = true;
    } else {
      // Cross-process (hydrated) → wall-clock freshness gate
      if (nowWall - p.requestedAtWallMs >= PENDING_STOP_TTL_MS) expired = true;
    }
    if (expired) removed.push(p);
    else kept.push(p);
  }
  ledger.pendingStopEvaluations = kept;
  return removed;
}

/**
 * chooseCurrentStopSummary(draft) — hook-gap reconciliation (F1/H-A).
 * Marks committed summaries with turnSeq > alertEvaluatedThroughTurnSeq that have NO pending
 * as `skipped_no_stop_event` and advances alertEvaluatedThroughTurnSeq. Never fires the open turn.
 * MUST be called inside commitLedgerMutationSync (mutates draft in place).
 */
export function chooseCurrentStopSummary(draft) {
  const summaries = draft.settledTurnSummaries || [];
  const pending = draft.pendingStopEvaluations || [];
  // Summaries beyond the alert cursor that have no pending targeting them
  let maxEvaluated = draft.alertEvaluatedThroughTurnSeq || 0;
  for (const s of summaries) {
    if (s.turnSeq <= maxEvaluated) continue;
    // A summary has a pending if any pending's watermark is such that s.turnSeq > watermark
    // (i.e. the pending could potentially match this summary). But more precisely: a pending
    // targets a summary when summary.turnSeq > pending.beforeSettledThroughTurnSeq. So any
    // pending with watermark < s.turnSeq covers this summary.
    const hasPending = pending.some(p => s.turnSeq > p.beforeSettledThroughTurnSeq);
    if (!hasPending) {
      // No Stop ever arrived for this turn — mark skipped, advance cursor
      maxEvaluated = s.turnSeq;
    } else {
      // A pending exists — don't skip, stop scanning (let drain handle it)
      break;
    }
  }
  draft.alertEvaluatedThroughTurnSeq = maxEvaluated;
}

/**
 * resolveStopMessageFromSummary(summary) — B3 adapter.
 * Maps the SNAPSHOTTED billKindAtBoundary + inDeepWaterAtBoundary directly and calls resolveStopMessage
 * with burnRate/stockStep/gateResult ABSENT. A deferred drain can only resolve empty_burn/non_idle/cache_unstable.
 */
export function resolveStopMessageFromSummary(summary) {
  if (!summary || summary.billKindAtBoundary == null) return null;
  // Build a bill-like object from the snapshotted boundary values
  const kind = summary.billKindAtBoundary;
  const inDeepWater = summary.inDeepWaterAtBoundary === true;
  // empty_burn only hooks in deep water; shallow → statusline_pulse (same logic as settleBatchAtBoundary)
  const delivery = (kind === 'empty_burn' && inDeepWater) ? 'stop_hook' : 'statusline_pulse';
  const bill = { kind, delivery, billCount: summary.billCycleCountIncrement || 0, deltaL: summary.deltaW };
  return resolveStopMessage({ gateResult: null, bill, burnRate: 0, dwTurn: 0, stockStep: false });
}
