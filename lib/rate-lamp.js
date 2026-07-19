import { G_FLOOR } from './constants.js';
import { computeMovableFrac, computeBr } from './bill-regret.js';
import { nucleus } from './landmarks.js';

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

// v3 (spec §2.2/§6.1): instant rate-lamp bundle from continuous B and g. No frozen kStable, no xExit.
export function computeRateLampInstant({ L_read, B, g, cRatio, lCap }) {
  if (!(B > 0) || !(cRatio > 0)) return { reliable: false, unavailableReason: 'invalid_baseline' };
  const geff = g > 0 ? g : G_FLOOR; // G_FLOOR guard (caller passes gEffective; defensive)
  const burnRate = computeFullCarryBurnRate({ L_read, B_post: B, B_rebuild: B, cRatio });
  if (!Number.isFinite(burnRate)) return { reliable: false, unavailableReason: 'invalid_baseline' };
  const x = L_read / B;
  const dhat = nucleus(cRatio, geff, B);           // sqrt(2·cRatio·g/B)
  const mf = computeMovableFrac(cRatio, B, geff);  // (cRatio, lBase→B, kStable→g)
  const br = (dhat > 0 && Number.isFinite(mf)) ? computeBr(x, dhat, mf) : NaN;
  return {
    reliable: true, basis: 'fullCarry',
    L_read, L_cap: lCap, B_post: B, B_rebuild: B, lBase: B, C_RATIO: cRatio,
    x_display: x, burnRate, hBreak: burnRate > 0 ? 1 / burnRate : Infinity,
    dhat, xSweet: 1 + dhat, mf, br,
    rateWall: computeRateWall({ B_post: B, B_rebuild: B, cRatio, lCap }),
  };
}
