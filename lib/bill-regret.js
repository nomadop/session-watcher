// lib/bill-regret.js
// Centralizes all bill_regret (br) computation.
// br = mf × pp_frac, where pp_frac = (u-1)²/(2u), u = (x-1)/dhat.
// Symmetric around u=1 (= xSweet = 1+dhat): left arm u<1, right arm u>1.

export const BR_AMBER = 0.10;
export const BR_RED   = 0.25;

export function computeMovableFrac(cRatio, lBase, kStable) {
  if (!(cRatio > 0) || !(lBase > 0) || !(kStable > 0)) return NaN;
  const arm = Math.sqrt(2 * cRatio * lBase * kStable);
  return arm / (arm + lBase + cRatio * kStable);
}

export function computeBr(x, dhat, mf) {
  const d = x - 1;
  if (!(d > 0) || !(dhat > 0) || !(mf >= 0)) return NaN;
  const u = d / dhat;
  const ppFrac = (u - 1) * (u - 1) / (2 * u); // (u-1)²/(2u), symmetric around u=1
  return mf * ppFrac; // no clamp needed: (u-1)² ≥ 0 and u > 0 ⟹ ppFrac ≥ 0
}

export function xRightFromBr(brTarget, dhat, mf) {
  if (!(brTarget >= 0) || !(dhat > 0) || !(mf > 0)) return NaN;
  const p = brTarget / mf; // pp as fraction
  // Solve (u-1)²/(2u) = p → u² - (2+2p)u + 1 = 0 → u = (1+p) ± √(p²+2p)
  const disc = p * p + 2 * p;
  const uRight = (1 + p) + Math.sqrt(disc);
  return 1 + uRight * dhat;
}

export function xLeftFromBr(brTarget, dhat, mf) {
  if (!(brTarget >= 0) || !(dhat > 0) || !(mf > 0)) return NaN;
  const p = brTarget / mf; // pp as fraction
  // Solve (u-1)²/(2u) = p → u² - (2+2p)u + 1 = 0 → u = (1+p) - √(p²+2p)
  const disc = p * p + 2 * p;
  const uLeft = (1 + p) - Math.sqrt(disc);
  return 1 + uLeft * dhat;
}

// SSOT arm detection (spec §3.1). computeBr is symmetric around u=1: on the left arm (x < xSweet)
// br explodes as u→0, which would false-fire the gate at cold start. Every notification consumer
// (watcher inDeepWater, server gate snapshot, rate-lamp-manager boundary) routes through these two
// helpers — never an inline `br >= BR_AMBER` check. Display br in getStatus() keeps its true value.
export function isInDeepWater(x, xSweet, br) {
  if (!Number.isFinite(br) || !Number.isFinite(x) || !Number.isFinite(xSweet)) return false;
  if (x < xSweet) return false;   // left arm — never deep water
  return br >= BR_AMBER;
}

// null (not NaN) so JSON serialization is clean; evaluateGate treats br===null as not_reliable → dwell 0.
export function brForGate(x, xSweet, br) {
  if (!Number.isFinite(x) || !Number.isFinite(xSweet)) return null;
  if (x < xSweet) return null;    // left arm whitened for gate evaluation
  return Number.isFinite(br) ? br : null;
}

// Amber-baseline backstop interval (spec §3.3). From session start to br=amber the accumulated bill
// count = u_amber² (all of g/B/dhat/cRatio cancel in the integral), giving an mf-adaptive interval.
// Solve mf·(u-1)²/(2u) = brTarget for the larger root. mf is a FRACTION (0.3, not 30%).
// NOTE: no floor is applied. By AM-GM mf ≤ 1/(1+√2) ≈ 0.414 (equality at L = cRatio·k), so u_amber ≥ 2
// and the interval is naturally ≥ ~4 at the busiest; it GROWS as mf shrinks. Clamping to max(4,·) would
// break invariant 6 (higher mf → shorter interval is correct — remind more when movable fraction is high).
export function uAtBr(mf, brTarget) {
  if (!Number.isFinite(mf) || mf <= 0) return Infinity;
  if (!Number.isFinite(brTarget)) return Infinity;   // non-finite target → safe degrade (never fires)
  if (brTarget <= 0) return 1;                        // genuinely-≤0 finite target → degenerate root
  const a = mf;
  const b = -(2 * mf + 2 * brTarget);
  const c = mf;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;   // mf too small to reach brTarget
  return (-b + Math.sqrt(disc)) / (2 * a);
}

export function backstopIntervalFor(mf, brTarget) {
  const u = uAtBr(mf, brTarget);
  if (!Number.isFinite(u)) return Infinity;
  return u * u;   // NO Math.max(4, …) — see note above.
}
