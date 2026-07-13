import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJsonAtomic, safeSessionId } from './atomic-store.js';
import { validateLedgerState, validateRateLampSample } from './ledger-schema.js';

const SCHEMA_VERSION = 1;

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
    s.pausedReason = sample.unavailableReason || 'metrics_unreliable';
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
