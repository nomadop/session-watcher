import { CONSTANTS } from './constants.js';

// k_stable static clamp (spec §3.4). Two-sided, no behavioral decay.
export function clampKStable(raw) {
  if (!Number.isFinite(raw)) return CONSTANTS.K_FLOOR;
  return Math.min(CONSTANTS.K_CEIL, Math.max(CONSTANTS.K_FLOOR, raw));
}

// The landmark-nucleus coefficient in the spec §3.7 handover formula x_exit = 1 + 2·Δ̂_stable.
// Named (not a bare literal) so the "2" reads as the formula's nucleus, not a magic number. Do not retune.
const EXIT_NUCLEUS = 2;

// Handover boundary x_exit from the FROZEN k_stable (spec §3.7) — a segment constant, NOT kAvg.
// Δ̂_stable = √(2·cRatio·k_stable/lBase); x_exit = 1 + 2·Δ̂_stable. Non-positive inputs → 1.
export function computeXExitFromKStable(cRatio, kStable, lBase) {
  if (cRatio <= 0 || kStable <= 0 || lBase <= 0) return 1;
  return 1 + EXIT_NUCLEUS * Math.sqrt(2 * cRatio * kStable / lBase);
}

// #11 (fix wave): the xExit → L_exit_fullCarry → inDeepWater derivation, extracted from the two sites that
// duplicated it (mergeLedgerIntoStatus in the manager, and computeRateLampInstant below). Pure; wraps
// computeXExitFromKStable as its nucleus. Behavior is identical to both former inlinings.
export function deriveFrozenExit(cRatio, kStable, lBase, L_read) {
  const xExit = computeXExitFromKStable(cRatio, kStable, lBase); // always fullCarry axis (§3.7)
  const L_exit_fullCarry = xExit * lBase;
  return { xExit, L_exit_fullCarry, inDeepWater: L_read >= L_exit_fullCarry };
}

// Instantaneous burn rate, carry-aware (spec §3.1 general form). max(0,·) clamps below-floor to 0.
export function computeFullCarryBurnRate({ L_read, B_post, B_rebuild, cRatio }) {
  if (!(B_rebuild > 0) || !(cRatio > 0)) return NaN; // guarded by reliable gate upstream
  return Math.max(0, L_read - B_post) / (cRatio * B_rebuild);
}

// Rate wall (burnRate=1) and its reachability vs the context cap (spec §3.6). Unreachable → the hard
// wall is attributed to context_cap (large R degrades to a window-capacity wall, no R classification).
export function computeRateWall({ B_post, B_rebuild, cRatio, lCap }) {
  const L = B_post + cRatio * B_rebuild;
  const reachable = L < lCap;
  return {
    L,
    x_display: B_rebuild > 0 ? L / B_rebuild : 0, // display axis; wall x = 1 + cRatio for fullCarry
    reachableBeforeContextCap: reachable,
    reasonIfNotReachable: reachable ? null : 'context_cap',
  };
}

// A4 (spec §0′-A4 / §23.5): detect a mature floor-step — a single-call total-stock jump large enough
// to spike x/burnRate while the frozen L_base stays low (a big dependency injected into context).
// LOOSE, recall-biased SUPPRESSION gate (NOT a tooth-pitch): on the detected step-turn the caller
// downgrades the ACTIVE Stop hook (WALL / ΔW backstop) to neutral non_idle presentation; billProgress
// still accrues (real rent is never dropped). stepMult is a PROVISIONAL, non-load-bearing knob (§23.8:
// precision/recall — never hard-code a "correct" N). v3 adds hysteresis + a pawl action here to turn
// this into a real L_base ratchet; then the spike vanishes at source and this degrades to a safety net.
// NOTE (review GPT#14): this computes the total-stock delta DIRECTLY; it does NOT call classifyMiss
// (that classifier answers a different question — "is this a cache miss" — and would misfire here).
// round-6 GPT#4: a Stop window can contain MULTIPLE folded calls (per-call integration). A step that
// happened mid-window (e.g. call 1→2) with a normal final hop (call 2→3) would be MISSED if we only
// compared the last adjacent pair — the WALL/ΔW suppression would then wrongly fire. Scan EVERY adjacent
// total-stock delta in the window and return true if ANY meets the threshold. `sinceFoldedSeq` bounds the
// window to the current Stop boundary (calls with foldedSeq > billAnchorFoldedCallSeq); omit it to scan
// the whole prefix (the caller normally passes it).
export function detectStockStep(prefix, frozenKStable, { stepMult = 8, sinceFoldedSeq = -Infinity } = {}) {
  if (!Array.isArray(prefix) || !(frozenKStable > 0)) return false;
  // window = calls newer than the boundary anchor; keep the ONE call at/just-before the anchor as the
  // left edge so a step landing on the window's first call is still measured against its predecessor.
  const idx = prefix.findIndex(c => (c.foldedSeq ?? 0) > sinceFoldedSeq);
  // round-7 GPT#3: NO call is newer than the anchor (findIndex → -1) means the current Stop window is
  // EMPTY — return false, do NOT fall through to scanning all history (that would let an already-settled
  // historical step re-suppress WALL/ΔW on a window with no new calls). idx===0 = whole prefix is in-window.
  if (idx === -1) return false;
  const window = idx === 0 ? prefix : prefix.slice(idx - 1); // include the pre-window call as the baseline
  if (window.length < 2) return false;
  const threshold = stepMult * frozenKStable;
  for (let i = 1; i < window.length; i++) {
    const totalNow = (window[i].cacheRead ?? 0) + (window[i].cacheCreation ?? 0);
    const totalPrev = (window[i - 1].cacheRead ?? 0) + (window[i - 1].cacheCreation ?? 0);
    if (totalNow - totalPrev >= threshold) return true; // ANY adjacent step in the window suppresses
  }
  return false;
}

// Pure instantaneous bundle (spec §4.1). NO ledger state (billProgress/nextBillEta live in the store).
// reliable=false → return ONLY { reliable, unavailableReason }, no numerics.
// scenario ∈ 'fullCarry' | 'deadOnly'. fullCarry: B_post=B_rebuild=lBase. deadOnly: =lDead.
export function computeRateLampInstant(snap, { scenario }) {
  const { L_read, lBase, lDead, cRatio, lCap, kStable, kStableReliable, baselineValid } = snap;
  if (baselineValid === false || !(lBase > 0) || !(cRatio > 0)) {
    return { reliable: false, unavailableReason: 'invalid_baseline' };
  }
  if (!kStableReliable || !(kStable > 0)) {
    return { reliable: false, unavailableReason: 'insufficient_data' };
  }
  const B = scenario === 'deadOnly' ? lDead : lBase;
  if (!(B > 0)) return { reliable: false, unavailableReason: 'invalid_baseline' };

  const burnRate = computeFullCarryBurnRate({ L_read, B_post: B, B_rebuild: B, cRatio });
  if (!Number.isFinite(burnRate)) return { reliable: false, unavailableReason: 'invalid_baseline' };
  const hBreak = burnRate > 0 ? 1 / burnRate : Infinity;
  const { xExit, L_exit_fullCarry, inDeepWater } = deriveFrozenExit(cRatio, kStable, lBase, L_read); // #11: shared derivation

  return {
    reliable: true,
    basis: scenario,
    L_read, L_cap: lCap, B_post: B, B_rebuild: B, C_RATIO: cRatio,
    x_display: lBase > 0 ? L_read / lBase : 1, // display axis only (§10.1#14)
    burnRate, hBreak,
    xExit, L_exit_fullCarry, inDeepWater,
    rateWall: computeRateWall({ B_post: B, B_rebuild: B, cRatio, lCap }),
  };
}
