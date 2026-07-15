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
