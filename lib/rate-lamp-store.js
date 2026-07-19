import { getStore } from './store.js';
import { validateLedgerState, validateRateLampSample } from './ledger-schema.js';
import { RECENT_STOP_EVENTS_LIMIT, NOTIFY_DWELL } from './constants.js';
import { backstopIntervalFor, BR_AMBER } from './bill-regret.js';

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

// v3 (spec §5 #8 / §6.3): segment boundary is the ONLY billing reset trigger. Key on segment + schema
// only — a mid-segment model/ratio change no longer resets the meter (baselineFingerprint retired).
export function stateKeyForStatus(status) {
  return stateKeyOf({ segmentId: status.segment, model: null, cRatio: null,
    baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
}

export function freshLedger(stateKey, kStableFrozen = 0) {
  return {
    schemaVersion: SCHEMA_VERSION, stateKey, billingBasis: 'fullCarry',
    billProgress: 0, billCycleCount: 0,
    billAnchorLRead: 0, billAnchorFoldedCallSeq: 0,
    lastBurnRate: null, lastAppliedFoldedCallSeq: 0, lastAppliedLRead: null,
    currentTurnSeq: 0,
    hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0, deepWaterDwell: 0, deepWaterDwellCycled: 0,
    pausedReason: null, cacheExpiryCount: 0,
    kStableFrozen,
    lastBillEvent: null,
    lastStopEvent: null, // condition-cleared: visible until next human turn boundary
    ledgerRevision: 0,
    recentStopEvents: [], recentProcessedHookEventIds: [],
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

  // Per-turn cursor update: advance currentTurnSeq when the turn changes.
  if (sample.turnSeq !== s.currentTurnSeq) { s.currentTurnSeq = sample.turnSeq; }

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
    if (s.billAnchorFoldedCallSeq === 0) { s.billAnchorLRead = sample.L_read; s.billAnchorFoldedCallSeq = sample.seq; }
    return s;
  }

  const trap = 0.5 * (s.lastBurnRate + br);
  // §float — the stored remainder MUST stay < 1 ("[0,1) metronome" invariant). We enforce that with
  // FLOOR-on-store, not round. The crossing test and every −=1 run on the UNROUNDED running value: a
  // Math.round anywhere in this path can push a remainder in [0.9999995, 1) UP to exactly 1.0, which
  // re-enters the loop for a phantom extra bill. Floor cannot round up, so it stays honest. The
  // floor bias is downward and bounded by 1e-6 per settlement — conservative by design: bill counts
  // under-count rather than over, and the backstop fires late rather than early.
  let next = s.billProgress + trap;
  while (next >= 1) {
    next -= 1;
    s.billCycleCount += 1;
  }
  s.billProgress = Math.floor(next * 1e6) / 1e6;               // floor keeps the remainder < 1 by construction
  s.lastBurnRate = br;
  s.lastAppliedFoldedCallSeq = sample.seq;
  s.lastAppliedLRead = sample.L_read;           // round-2 GPT#9: applied-L snapshot for in-place-fold defense
  return s;
}

// Per-call gate arm + backstop accumulator (Change A: replaces boundary-based settle).
// Called once per API call by the manager advance loop. The gate requires TWO independent
// conditions: (a) NOTIFY_DWELL consecutive API calls in deep water, AND (b) at least one
// cycle crossing during that consecutive run. This debounces against hovering near the
// deep-water line with no real cost accumulation.
// Mutates draft in place; returns { fired, kind? } (kind is 'gate' or 'backstop' when fired).
export function advanceGateAndBackstop(draft, { inDeepWater, billCycleIncrement, mf }) {
  // Gate arm (dwell): count consecutive deep-water API calls + track if any cycled
  if (!draft.hasDeepWaterGateFired) {
    if (inDeepWater) {
      draft.deepWaterDwell = (draft.deepWaterDwell || 0) + 1;
      draft.deepWaterDwellCycled = (draft.deepWaterDwellCycled || 0) + billCycleIncrement;
      if (draft.deepWaterDwell >= NOTIFY_DWELL && draft.deepWaterDwellCycled > 0) {
        draft.hasDeepWaterGateFired = true;
        draft.dwBillsSinceLastAlert = 0;
        return { fired: true, kind: 'gate' };
      }
    } else {
      draft.deepWaterDwell = 0;
      draft.deepWaterDwellCycled = 0;
    }
    return { fired: false };
  }
  // Backstop accumulator (only when gate armed + in deep water)
  if (!inDeepWater) return { fired: false };
  draft.dwBillsSinceLastAlert += billCycleIncrement;
  if (mf > 0) {
    const interval = backstopIntervalFor(mf, BR_AMBER);
    if (Number.isFinite(interval) && interval > 0 && draft.dwBillsSinceLastAlert >= interval) {
      draft.dwBillsSinceLastAlert = 0;
      draft.backstopLapCount += 1;
      return { fired: true, kind: 'backstop' };
    }
  }
  return { fired: false };
}


// Persistence (SQLite-backed, schema-guarded load). A missing or corrupt entry → validateLedgerState
// returns null → caller treats as "no saved state" (silent fresh), never crashes.
export function loadRateLampState(sessionId) {
  try { return validateLedgerState(getStore().load(sessionId, 'ledger')); } catch { return null; }
}
export function saveRateLampState(sessionId, state) { getStore().save(sessionId, 'ledger', state); }



// Backstop fire decision (spec §3.3, Stop path). Runs INSIDE the Stop route's atomic commit. Reads
// LIVE mf (recomputed O(1)). gateJustFired arms the backstop and zeros the accumulator (mutual
// exclusion with the gate). On threshold: reset accumulator + increment lap. Pure-ish: mutates draft.
export function decideBackstop(draft, { gateJustFired, mf }) {
  if (gateJustFired) {
    draft.hasDeepWaterGateFired = true;
    draft.dwBillsSinceLastAlert = 0;
    return { notify: false };
  }
  if (!draft.hasDeepWaterGateFired) return { notify: false };
  const interval = backstopIntervalFor(mf, BR_AMBER);
  if (!Number.isFinite(interval)) return { notify: false };
  if (draft.dwBillsSinceLastAlert >= interval) {
    draft.dwBillsSinceLastAlert = 0;
    draft.backstopLapCount += 1;
    return { notify: true };
  }
  return { notify: false };
}

// Non-mutating probe: returns { notify } indicating whether backstop WOULD fire, without touching
// the draft. Used by the Stop route to determine priority BEFORE committing state mutations — fixes
// the bug where decideBackstop consumed the accumulator even when a higher-priority message (wall)
// won resolution, silently losing the backstop lap.
export function probeBackstop(draft, { gateJustFired, mf }) {
  if (gateJustFired) return { notify: false };
  if (!draft.hasDeepWaterGateFired) return { notify: false };
  const interval = backstopIntervalFor(mf, BR_AMBER);
  if (!Number.isFinite(interval)) return { notify: false };
  if (draft.dwBillsSinceLastAlert >= interval) return { notify: true };
  return { notify: false };
}

// Commit backstop fire mutations: reset accumulator + increment lap. Called ONLY when backstop
// actually wins message priority (i.e. resolveStopMessage chose 'backstop'). Also handles the
// gateJustFired arm unconditionally (gate always wins priority, so its mutations are always safe).
export function commitBackstopFire(draft, { gateJustFired }) {
  if (gateJustFired) {
    draft.hasDeepWaterGateFired = true;
    draft.dwBillsSinceLastAlert = 0;
    return;
  }
  // Only called when backstop won → threshold is met, apply the fire.
  draft.dwBillsSinceLastAlert = 0;
  draft.backstopLapCount += 1;
}
