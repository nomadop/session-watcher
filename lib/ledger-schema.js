// Ledger/sample schema guards. A load that returns a half-corrupt object silently
// mis-drives the ledger; validate on every load and treat any failure as "no saved state" (fresh).
import { RECENT_STOP_EVENTS_LIMIT, RECENT_PROCESSED_HOOK_IDS_LIMIT } from './constants.js';

// The ledger's serialized version, owned here because the gate below is what makes a value the accepted
// one. `freshLedger` stamps this same constant, so the stamping and the accepting side cannot disagree
// (test/rate-lamp.mutate-ledger.test.js `a freshly minted ledger passes validateLedgerState`).
export const SCHEMA_VERSION = 3;

const numFields = ['billProgress', 'billCycleCount', 'walletPhase', 'walletLapCount',
  'lastAppliedFoldedCallSeq', 'currentTurnSeq', 'cacheExpiryCount'];
const intFields = ['billCycleCount', 'walletLapCount', 'lastAppliedFoldedCallSeq', 'currentTurnSeq',
  'cacheExpiryCount', 'ledgerRevision'];

// pausedReason enum. MUST include every value the reducer can write.
const PAUSE_REASONS = new Set([null, 'folded_seq_gap', 'metrics_unreliable', 'invalid_baseline',
  'insufficient_data', 'cache_unstable', 'seq_history_mismatch', 'invalid_sample']);

// Only the current schema is accepted: a disk ledger of any other version is foreign and degrades to a
// fresh ledger — no migration, no back-fill, no .bak. The loss is affordable because the session ledger
// is a per-session transient that re-calibrates over a short span, not a persistent asset (H-C).
export function validateLedgerState(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof obj.stateKey !== 'string') return null;
  if (obj.billingBasis !== 'fullCarry') return null;
  if (obj.ledgerRevision === undefined) obj.ledgerRevision = 0;
  if (obj.recentStopEvents === undefined) obj.recentStopEvents = [];
  if (obj.recentProcessedHookEventIds === undefined) obj.recentProcessedHookEventIds = [];
  for (const f of numFields) if (!Number.isFinite(obj[f])) return null;
  if (!(obj.billProgress >= 0 && obj.billProgress < 1)) return null;
  if (!(obj.walletPhase >= 0 && obj.walletPhase < 1)) return null;
  for (const f of intFields) if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  if (!PAUSE_REASONS.has(obj.pausedReason)) return null;
  if (obj.lastStopEvent != null && typeof obj.lastStopEvent !== 'object') return null;
  if (!Array.isArray(obj.recentStopEvents) || obj.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) return null;
  for (const e of obj.recentStopEvents) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.kind !== 'string') return null;
  }
  if (!Array.isArray(obj.recentProcessedHookEventIds) || obj.recentProcessedHookEventIds.length > RECENT_PROCESSED_HOOK_IDS_LIMIT) return null;
  for (const id of obj.recentProcessedHookEventIds) if (typeof id !== 'string') return null;
  return obj;
}

export function validateRateLampSample(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.reliable !== 'boolean') return false;
  // seq/turnSeq are NON-NEGATIVE integers, rejected at the schema layer rather than left to the reducer's
  // `seq <= lastApplied` comparison, which would swallow a negative seq instead of reporting it.
  if (!Number.isInteger(obj.seq) || obj.seq < 0) return false;
  if (!Number.isInteger(obj.turnSeq) || obj.turnSeq < 0) return false;
  if (obj.reliable) {
    // L_read is a token count and deltaW is a non-negative increment, so a negative is corruption. Both
    // deltaW and mf are finite-or-null: null is the segment's first frame, which has no increment to stamp.
    // The field name is itself the guard: a sample that names a raw usage field where `L_read` belongs fails
    // here instead of integrating (test/rate-lamp.ledger.test.js `a malformed (cacheRead-named) sample`).
    if (!(Number.isFinite(obj.L_read) && obj.L_read >= 0)) return false;
    if (obj.deltaW !== null && !(Number.isFinite(obj.deltaW) && obj.deltaW >= 0)) return false;
    if (obj.mf !== null && !Number.isFinite(obj.mf)) return false;
  }
  return true;
}
