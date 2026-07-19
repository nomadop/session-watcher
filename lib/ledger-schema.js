// Ledger/sample schema guards (review GPT#12). A load that returns a half-corrupt object silently
// mis-drives the ledger; validate on every load and treat any failure as "no saved state" (fresh).
import { RECENT_STOP_EVENTS_LIMIT, RECENT_PROCESSED_HOOK_IDS_LIMIT } from './constants.js';

const numFields = ['billProgress','billCycleCount','billAnchorLRead',
  'billAnchorFoldedCallSeq','lastAppliedFoldedCallSeq','currentTurnSeq',
  'cacheExpiryCount','kStableFrozen'];

const intFields = ['billCycleCount','billAnchorFoldedCallSeq',
  'lastAppliedFoldedCallSeq','currentTurnSeq','cacheExpiryCount',
  'ledgerRevision'];

// pausedReason enum. MUST include every value the reducer can write.
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
  // Tolerant normalization: back-fill fields that may be absent in older persisted ledgers.
  if (obj.ledgerRevision === undefined) obj.ledgerRevision = 0;
  if (obj.recentStopEvents === undefined) obj.recentStopEvents = [];
  if (obj.recentProcessedHookEventIds === undefined) obj.recentProcessedHookEventIds = [];
  for (const f of numFields) if (!Number.isFinite(obj[f])) return null;
  if (!(obj.billProgress >= 0 && obj.billProgress < 1)) return null;         // [0,1) metronome invariant
  for (const f of intFields) if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  for (const f of ['billAnchorLRead', 'kStableFrozen']) if (obj[f] < 0) return null;
  // Backstop fields: back-fill on hydrate for old ledgers missing them.
  if (typeof obj.hasDeepWaterGateFired !== 'boolean') obj.hasDeepWaterGateFired = false;
  if (obj.deepWaterDwell === undefined) obj.deepWaterDwell = 0;
  if (!(Number.isInteger(obj.deepWaterDwell) && obj.deepWaterDwell >= 0)) obj.deepWaterDwell = 0;
  if (obj.deepWaterDwellCycled === undefined) obj.deepWaterDwellCycled = 0;
  if (!(Number.isInteger(obj.deepWaterDwellCycled) && obj.deepWaterDwellCycled >= 0)) obj.deepWaterDwellCycled = 0;
  for (const f of ['dwBillsSinceLastAlert', 'backstopLapCount']) {
    if (obj[f] === undefined) obj[f] = 0;
  }
  if (!(Number.isFinite(obj.dwBillsSinceLastAlert) && obj.dwBillsSinceLastAlert >= 0)) return null;
  if (!(Number.isInteger(obj.backstopLapCount) && obj.backstopLapCount >= 0)) return null;
  if (!PAUSE_REASONS.has(obj.pausedReason)) return null;
  if (obj.lastBurnRate !== null && !(Number.isFinite(obj.lastBurnRate) && obj.lastBurnRate >= 0)) return null;
  if (obj.lastAppliedLRead != null && !(Number.isFinite(obj.lastAppliedLRead) && obj.lastAppliedLRead >= 0)) return null;
  if (obj.lastBillEvent != null && typeof obj.lastBillEvent !== 'object') return null;
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
