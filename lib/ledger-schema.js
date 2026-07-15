// Ledger/sample schema guards (review GPT#12). A load that returns a half-corrupt object silently
// mis-drives the ledger; validate on every load and treat any failure as "no saved state" (fresh).
import { SETTLED_SUMMARY_HARD_LIMIT, RECENT_STOP_EVENTS_LIMIT, RECENT_PROCESSED_HOOK_IDS_LIMIT, PENDING_STOP_EVALUATIONS_LIMIT } from './constants.js';

const numFields = ['billProgress','billCycleCount','billAnchorLRead','billAnchorTurnSeq',
  'billAnchorFoldedCallSeq','lastAppliedFoldedCallSeq','currentTurnSeq','currentTurnDeltaW',
  'pendingBillCountSinceBoundary','cacheExpiryCount','kStableFrozen'];

const intFields = ['billCycleCount','billAnchorTurnSeq','billAnchorFoldedCallSeq',
  'lastAppliedFoldedCallSeq','currentTurnSeq','pendingBillCountSinceBoundary','cacheExpiryCount',
  // v2.2-C (schema v2): monotonic settlement cursors + mutation counter, all non-negative ints.
  'settledThroughTurnSeq','alertEvaluatedThroughTurnSeq','ledgerRevision'];

// v2.2-C ring/queue caps: ALL imported from lib/constants.js (single source of truth — the validator's
// length CAP must equal the writer's ADD-site trim LIMIT, else a legitimately-trimmed ring trips the
// over-LIMIT reject here → whole-ledger WIPE). C3-2 completed the migration of all three remaining caps.

// billKindAtBoundary enum (B3): the SNAPSHOTTED bill kind a settle emits, or null (pre-calibration / no bill).
const SUMMARY_BILL_KINDS = new Set([null, 'empty_burn', 'non_idle_burn', 'cache_unstable']);

// billProgress domain: NaN (legal — billProgress is NaN before calibration completes) OR finite in [0,1).
// Used for the summary's display-only billProgressBefore/After trio (validate-and-tolerate, not hard-reject).
function isNaNOrUnitInterval(x) { return Number.isNaN(x) || (Number.isFinite(x) && x >= 0 && x < 1); }
// pausedReason enum. MUST include every value the reducer can write — including the unreliable
// reasons `computeRateLampInstant` emits (`invalid_baseline`/`insufficient_data`), which the manager's
// seq-only unreliable drain (Task 3.5, F-1) passes straight into pausedReason. Omitting them (round-3
// GPT#1) makes a LEGAL unreliable drain produce a state its own validator rejects → next load treats a
// valid ledger as corrupt. Keep the specific reason (better debug signal than normalizing to one value).
// NOTE (New#3 fix wave): `seq_history_mismatch` is NO LONGER WRITTEN by anyone (resolveLedgerForKey now
// re-anchors instead of pausing; the reducer never wrote it). It is retained here READ-ONLY for pre-fix
// disk-ledger MIGRATION: a ledger persisted by an older binary can still carry it, and rejecting it would
// treat that ledger as corrupt → fresh → billCycleCount N→0 (the exact jump the fix avoids). Do NOT prune.
const PAUSE_REASONS = new Set([null, 'folded_seq_gap', 'metrics_unreliable', 'invalid_baseline',
  'insufficient_data', 'cache_unstable', 'seq_history_mismatch', 'invalid_sample', 'folded_call_mutated']);

export function validateLedgerState(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // HARD version gate (H-C): only schema v2 is accepted. A v1 (or any non-2) disk ledger is judged foreign
  // and returns null → loadRateLampState null → freshLedger degrade. NO v1 accept, NO v1 back-fill, NO
  // migration, NO .bak — the session ledger is a per-session transient (re-calibrates a short span). This
  // gate is the WHOLE v1-reject mechanism (stateKey's fixed version discriminator does NOT distinguish v1↔v2).
  if (obj.schemaVersion !== 2) return null;
  if (typeof obj.stateKey !== 'string') return null;
  if (obj.billingBasis !== 'fullCarry') return null;
  // v2-local tolerant normalization (round-9 GPT-pt8): a genuinely-v2 ledger written by THIS build always
  // carries all 8 new fields, but a partial-write / older-v2 file may miss one. Back-fill the default BEFORE
  // the range checks (arrays [], the two cursors + revision 0, deepWaterDisplayLatched false). This is
  // HYDRATE-TIME normalization on the returned object only — it is NOT a v1 migration, does NOT go through
  // mutateLedger, does NOT bump ledgerRevision, and does NOT schedule a write (so it never trips the C5a
  // escaped-mutation dead-letter). If a later REAL mutation occurs it persists the normalized content then.
  if (obj.settledThroughTurnSeq === undefined) obj.settledThroughTurnSeq = 0;
  if (obj.alertEvaluatedThroughTurnSeq === undefined) obj.alertEvaluatedThroughTurnSeq = obj.settledThroughTurnSeq;
  if (obj.ledgerRevision === undefined) obj.ledgerRevision = 0;
  if (obj.pendingStopEvaluations === undefined) obj.pendingStopEvaluations = [];
  if (obj.settledTurnSummaries === undefined) obj.settledTurnSummaries = [];
  if (obj.recentStopEvents === undefined) obj.recentStopEvents = [];
  if (obj.recentProcessedHookEventIds === undefined) obj.recentProcessedHookEventIds = [];
  // DEPRECATED (br-migration): field kept for backward-compat with old persisted ledgers
  // but is no longer consumed by display/gate logic.
  if (typeof obj.deepWaterDisplayLatched !== 'boolean') obj.deepWaterDisplayLatched = false; // non-boolean → back-fill false
  for (const f of numFields) if (!Number.isFinite(obj[f])) return null;
  // Range checks (round-2 GPT#11): finiteness alone let a corrupt-but-finite file drive the ledger.
  if (!(obj.billProgress >= 0 && obj.billProgress < 1)) return null;         // [0,1) metronome invariant
  for (const f of intFields) if (!Number.isInteger(obj[f]) || obj[f] < 0) return null; // non-negative ints
  // round-8 GPT#3: the remaining continuous fields are physically non-negative — a token stock
  // (billAnchorLRead), an accumulated per-turn ΔW (currentTurnDeltaW ≥ 0 by construction), and a frozen
  // k_stable (kStableFrozen ≥ 0; 0 is the tolerated degraded value — see the note below — but a NEGATIVE
  // value is corruption). finiteness alone let a corrupt-but-finite negative through.
  for (const f of ['billAnchorLRead', 'currentTurnDeltaW', 'kStableFrozen']) if (obj[f] < 0) return null;
  if (!PAUSE_REASONS.has(obj.pausedReason)) return null;                      // enum, not any string
  // NOTE (final-review reconciliation): we deliberately do NOT reject `kStableFrozen === 0` on an active
  // ledger. That cross-field rule was over-strict — it collided with GPT#5's "reducer validates prev on
  // entry" (a mid-integration ledger built from freshLedger(k=0) would then be rejected), AND kStableFrozen
  // degrades gracefully everywhere it is read (the reducer never reads it; settle takes kStable as an arg;
  // the manager guards `kStableFrozen > 0` before computing xExit). So 0 is a benign degradation, not a
  // corruption that needs a hard reject. The value IS always positive in production (frozen from a latched
  // k_stable ≥ K_FLOOR), so this only ever relaxes the guard for tests / edge frames.
  // lastBurnRate / lastAppliedLRead are number|null, and both non-negative when present (round-8 GPT#3:
  // burnRate is max(0,·) at source and L_read is a token count — a negative here is corruption, not a value).
  if (obj.lastBurnRate !== null && !(Number.isFinite(obj.lastBurnRate) && obj.lastBurnRate >= 0)) return null;
  if (obj.lastAppliedLRead != null && !(Number.isFinite(obj.lastAppliedLRead) && obj.lastAppliedLRead >= 0)) return null;
  // lastBillEvent / lastStopEvent are null | object (round-2 GPT#7 / final-review GPT#2); tolerate absent
  // (legacy state) but reject a bad type.
  if (obj.lastBillEvent != null && typeof obj.lastBillEvent !== 'object') return null;
  if (obj.lastStopEvent != null && typeof obj.lastStopEvent !== 'object') return null;
  // R5 GPT#8 (contract semantics): this is VALIDATE-AND-TOLERATE, NOT normalize-to-locked-shape. A legacy
  // object missing lastAppliedLRead/lastBillEvent/lastStopEvent is returned AS-IS (fields simply absent),
  // not back-filled to null. This is safe because EVERY reader is nullish-safe (`ledger.lastBillEvent`,
  // `?? 0`, `if (ledger.lastStopEvent)` etc.) — see mergeLedgerIntoStatus / recordStopEvent / formatLine.
  // A future normalizeLedgerState() that back-fills the full shape is optional cleanup, not required here;
  // do NOT rely on a validated object HAVING these keys — guard for them.

  // v2.2-C array validation (spec §3.2 / invariant #17): length ≤ LIMIT + PER-ELEMENT field ranges, not
  // merely element-is-object. A corrupt LOAD-BEARING element rejects the WHOLE ledger (→ null → fresh),
  // same as any other range failure. This sub-batch never populates these arrays, so in practice the guard
  // only trips on a hand-crafted / foreign disk file — but it is the mechanism C1/C3 rely on the moment
  // they start filling the arrays (define the gate before the writers exist).
  if (!Array.isArray(obj.settledTurnSummaries) || obj.settledTurnSummaries.length > SETTLED_SUMMARY_HARD_LIMIT) return null;
  for (const e of obj.settledTurnSummaries) {
    if (!e || typeof e !== 'object') return null;
    if (!Number.isInteger(e.turnSeq) || e.turnSeq < 0) return null;
    if (!Number.isInteger(e.foldedCallSeqStart) || e.foldedCallSeqStart < 0) return null;
    if (!Number.isInteger(e.foldedCallSeqEnd) || e.foldedCallSeqEnd < e.foldedCallSeqStart) return null;
    if (!Number.isFinite(e.deltaW)) return null;                          // ANY sign — a cache_unstable boundary is NEGATIVE (NOT ≥0)
    if (!Number.isInteger(e.billCycleCountIncrement) || e.billCycleCountIncrement < 0) return null;
    if (typeof e.inDeepWaterAtBoundary !== 'boolean') return null;
    if (!SUMMARY_BILL_KINDS.has(e.billKindAtBoundary)) return null;       // B3 snapshotted kind enum
    // VALIDATE-AND-TOLERATE (R5/F3): the three display-only fields (never fire-gating) back-fill on a bad
    // value rather than wiping the whole ledger — a corrupt display input must not cost the account its
    // alert history (误报-adjacent). billProgress*→NaN, hBreakAtBoundary→null.
    if (!isNaNOrUnitInterval(e.billProgressBefore)) e.billProgressBefore = NaN;
    if (!isNaNOrUnitInterval(e.billProgressAfter)) e.billProgressAfter = NaN;
    if (!(e.hBreakAtBoundary === null || e.hBreakAtBoundary > 0)) e.hBreakAtBoundary = null; // null OR >0 (Infinity = never-break-even OK)
  }
  if (!Array.isArray(obj.pendingStopEvaluations) || obj.pendingStopEvaluations.length > PENDING_STOP_EVALUATIONS_LIMIT) return null;
  for (const e of obj.pendingStopEvaluations) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.hookEventId !== 'string') return null;
    if (!Number.isInteger(e.beforeSettledThroughTurnSeq) || e.beforeSettledThroughTurnSeq < 0) return null;
    if (!Number.isFinite(e.requestedAtWallMs)) return null;
    if (!Number.isInteger(e.enqueueSeq) || e.enqueueSeq < 0) return null;
    if (e.status !== 'pending') return null;                             // J-Gpt2 tombstone-free: 'pending' is the ONLY legal persisted status
    // requestedAtMonoMs / processNonce are OPTIONAL (mono valid same-process only) — no validation here.
  }
  if (!Array.isArray(obj.recentStopEvents) || obj.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) return null;
  for (const e of obj.recentStopEvents) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.kind !== 'string') return null;
    if (!Number.isInteger(e.turnSeq) || e.turnSeq < 0) return null;
  }
  if (!Array.isArray(obj.recentProcessedHookEventIds) || obj.recentProcessedHookEventIds.length > RECENT_PROCESSED_HOOK_IDS_LIMIT) return null;
  for (const id of obj.recentProcessedHookEventIds) if (typeof id !== 'string') return null;

  return obj;
}

export function validateRateLampSample(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.reliable !== 'boolean') return false;
  // round-3 GPT#8: seq/turnSeq must be NON-NEGATIVE integers — reject at the schema layer, not rely on
  // the reducer's `seq <= lastApplied` to swallow a negative seq.
  if (!Number.isInteger(obj.seq) || obj.seq < 0) return false;
  if (!Number.isInteger(obj.turnSeq) || obj.turnSeq < 0) return false;
  if (obj.reliable) {
    // round-8 GPT#3: both must be finite AND non-negative — L_read is a token count and burnRate is
    // max(0,·) at source, so a negative is corruption. (Field is L_read, NOT cacheRead — Task 2.5 lock.)
    if (!(Number.isFinite(obj.burnRate) && obj.burnRate >= 0)) return false;
    if (!(Number.isFinite(obj.L_read) && obj.L_read >= 0)) return false;
  }
  return true;
}
