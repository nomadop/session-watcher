import { getStore } from './store.js';
import { SCHEMA_VERSION, validateLedgerState, validateRateLampSample } from './ledger-schema.js';
import { RECENT_STOP_EVENTS_LIMIT } from './constants.js';
import { walletIntervalFor, BR_AMBER } from './bill-regret.js';

// State key (spec §4.4). Order-stable JSON of the named fields, and only those: a quantity this parameter
// set does not name — xExit among them — reaches the key through nothing. Its `schemaVersion` is a
// segment-identity discriminator independent of the ledger's own version: `stateKeyForStatus` pins a fixed
// value, so a `SCHEMA_VERSION` bump moves no key, and it is `validateLedgerState` that rejects the disk
// ledger as foreign and degrades it to a fresh one.
export function stateKeyOf({ segmentId, model, cRatio, baselineFingerprint, contextCap, schemaVersion }) {
  return JSON.stringify([segmentId, model, cRatio, baselineFingerprint, contextCap, schemaVersion]);
}

// v3 (spec §5 #8 / §6.3): segment boundary is the ONLY billing reset trigger. Key on segment + schema
// only — a mid-segment model/ratio change no longer resets the meter (baselineFingerprint retired).
export function stateKeyForStatus(status) {
  return stateKeyOf({ segmentId: status.segment, model: null, cRatio: null,
    baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
}

export function freshLedger(stateKey) {
  return {
    schemaVersion: SCHEMA_VERSION, stateKey, billingBasis: 'fullCarry',
    billProgress: 0, billCycleCount: 0,
    walletPhase: 0, walletLapCount: 0,
    lastAppliedFoldedCallSeq: 0, currentTurnSeq: 0,
    pausedReason: null, cacheExpiryCount: 0,
    lastStopEvent: null, // condition-cleared: visible until the next human turn boundary
    ledgerRevision: 0,
    recentStopEvents: [], recentProcessedHookEventIds: [],
  };
}

// R5 GPT#3: a corrupt `prev` must yield a state that ITSELF re-validates — otherwise a `{...prev,
// pausedReason}` "shell" whose billProgress is (say) 1.2 is STILL schema-invalid, so under the in-memory
// single writer it stays wedged paused in _ledgers until process restart (the disk-load path self-heals
// by treating null as fresh, but the live copy does not reload). Rebuild a clean paused ledger, preserving
// only the safely-reusable stateKey.
function invalidPausedLedger(prev) {
  const stateKey = (prev && typeof prev === 'object' && typeof prev.stateKey === 'string') ? prev.stateKey : '__invalid__';
  const s = freshLedger(stateKey);
  s.pausedReason = 'invalid_sample';
  return s;
}

// DRY helper: push a stop event onto the recentStopEvents ring (mutable, in-place on a draft/ledger).
// Ensures the array exists, appends, trims to RECENT_STOP_EVENTS_LIMIT. A fired stop event reaches the ring
// only through here, so no caller re-implements the eviction.
export function pushStopEventRing(ledgerOrDraft, evt) {
  if (!ledgerOrDraft.recentStopEvents) ledgerOrDraft.recentStopEvents = [];
  ledgerOrDraft.recentStopEvents.push(evt);
  if (ledgerOrDraft.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) {
    ledgerOrDraft.recentStopEvents.splice(0, ledgerOrDraft.recentStopEvents.length - RECENT_STOP_EVENTS_LIMIT);
  }
}

// Two clocks over one stamped increment. The fast clock counts rebuild-equivalents of avoidable rent; the
// wallet clock counts amber wallet intervals at the sample's own exchange rate. Neither reads a position.
// PURE — returns a new state, no I/O. A malformed STATE or SAMPLE pauses rather than corrupting the ledger,
// and `prev` is validated FIRST so a half-corrupt ledger is never integrated onto.
export function applyFoldedCallSample(prev, sample) {
  if (!validateLedgerState(prev)) return invalidPausedLedger(prev);
  const s = { ...prev };
  // The field guard here is what makes a `cacheRead`-named sample a hard error, not a silent no-op.
  if (!validateRateLampSample(sample)) { s.pausedReason = 'invalid_sample'; return s; }
  // Idempotency / gap checks run for BOTH reliable and unreliable samples so seq stays continuous.
  if (sample.seq <= s.lastAppliedFoldedCallSeq) return s;
  if (s.lastAppliedFoldedCallSeq !== 0 && sample.seq !== s.lastAppliedFoldedCallSeq + 1) {
    // Record the seq; do not integrate across the gap.
    s.pausedReason = 'folded_seq_gap';
    s.lastAppliedFoldedCallSeq = sample.seq;
    return s;
  }
  // No turn-cursor update here. Engine state is the only `turnSeq` authority and the persisted
  // `currentTurnSeq` is a consumer cursor `drainFrame` assigns from the frame after EVERY frame, zero-sample
  // frames included — so a second writer in the reducer could only disagree with it between samples.
  s.lastAppliedFoldedCallSeq = sample.seq;
  if (!sample.reliable) { s.pausedReason = sample.unavailableReason || 'insufficient_data'; return s; }
  if (sample.deltaW === null) return s;
  s.pausedReason = null;
  // Both remainders are stored AS COMPUTED. The crossing test and every −=1 run on the unrounded running
  // value: a round on store can lift a remainder just under the unit up to it, re-entering the settle loop
  // for a phantom extra cycle.
  let bill = s.billProgress + sample.deltaW;
  while (bill >= 1) { bill -= 1; s.billCycleCount += 1; }
  s.billProgress = bill;
  // `walletIntervalFor` maps a non-positive or non-finite mf to Infinity, so a sample carrying no exchange
  // rate divides to zero and the wallet clock holds where it stands — no branch has to say so.
  const interval = walletIntervalFor(sample.mf, BR_AMBER);
  let phase = s.walletPhase + sample.deltaW / interval;
  while (phase >= 1) { phase -= 1; s.walletLapCount += 1; }
  s.walletPhase = phase;
  return s;
}

// Applies a frame's samples to a ledger draft in seq order and turns each wallet rollover into the stop
// event the reader path shows. A human turn boundary clears only an event that existed before the frame:
// one fired inside the frame is not yet visible to any reader.
export function drainFrame(ledger, frame) {
  const preExisting = ledger.lastStopEvent;
  for (const sample of frame.samples) {
    if (!(sample.seq > ledger.lastAppliedFoldedCallSeq)) continue;
    if (sample.turnSeq > ledger.currentTurnSeq && ledger.lastStopEvent && ledger.lastStopEvent === preExisting) {
      ledger.lastStopEvent = null;
    }
    const lapsBefore = ledger.walletLapCount;
    Object.assign(ledger, applyFoldedCallSample(ledger, sample));
    if (ledger.walletLapCount > lapsBefore) {
      const event = {
        kind: 'backstop', delivery: 'reader_path',
        message: `Carry rent reminder ${ledger.walletLapCount}: accumulated rent reached the reminder point. Consider restart/compact at the next natural boundary.`,
        billCount: ledger.walletLapCount, seq: sample.seq,
      };
      ledger.lastStopEvent = event;
      pushStopEventRing(ledger, event);
    }
  }
  ledger.currentTurnSeq = frame.turnSeq;
}

// Persistence (SQLite-backed, schema-guarded load). A missing or corrupt entry → validateLedgerState
// returns null → caller treats as "no saved state" (silent fresh), never crashes.
export function loadRateLampState(sessionId) {
  try { return validateLedgerState(getStore().load(sessionId, 'ledger')); } catch { return null; }
}
export function saveRateLampState(sessionId, state) { getStore().save(sessionId, 'ledger', state); }
