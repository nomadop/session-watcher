// Ledger/sample schema guards (review GPT#12). A load that returns a half-corrupt object silently
// mis-drives the ledger; validate on every load and treat any failure as "no saved state" (fresh).
const numFields = ['billProgress','billCycleCount','billAnchorLRead','billAnchorTurnSeq',
  'billAnchorFoldedCallSeq','lastAppliedFoldedCallSeq','currentTurnSeq','currentTurnDeltaW',
  'pendingBillCountSinceBoundary','cacheExpiryCount','kStableFrozen'];

const intFields = ['billCycleCount','billAnchorTurnSeq','billAnchorFoldedCallSeq',
  'lastAppliedFoldedCallSeq','currentTurnSeq','pendingBillCountSinceBoundary','cacheExpiryCount'];
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
  if (obj.schemaVersion !== 1) return null;
  if (typeof obj.stateKey !== 'string') return null;
  if (obj.billingBasis !== 'fullCarry') return null;
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
