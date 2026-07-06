import { CONSTANTS } from './constants.js';
import { median } from './stats.js';

export function theilSen(ys) {
  if (!Array.isArray(ys) || ys.length < 2) return 0; // <2 points → 0, before any median
  const slopes = [];
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      slopes.push((ys[j] - ys[i]) / (j - i));
    }
  }
  return median(slopes);
}

export function nStar(cRatio, lBase, g) {
  if (g <= 0) return Infinity;
  return Math.sqrt(2 * cRatio * lBase / g);
}

export function lStar(lBase, cRatio, kAvg, M = CONSTANTS.EFFICIENCY_MULT) {
  if (kAvg <= 0) return lBase;
  return lBase + M * Math.sqrt(2 * cRatio * lBase * kAvg);
}

export function rho(cRatio, kAvg, lBase) {
  if (lBase <= 0) return 0;
  return cRatio * kAvg / lBase;
}

export function phi(L, lBase, cRatio, kAvg) {
  const denom = lBase + cRatio * kAvg;
  if (denom <= 0) return 1;
  return Math.max(1, (L + cRatio * kAvg) / denom);
}

export function paybackP(L, lBase) {
  if (lBase <= 0) return 0;
  return Math.max(0, L / lBase - 1);
}

export function timingWeight(rhoVal) {
  if (rhoVal <= 0) return 0;
  const s = Math.sqrt(2 * rhoVal);
  return s / (s + 1 + rhoVal);
}

export function regret(nNow, nStarVal) {
  if (nNow <= 0 || nStarVal <= 0) return 0;
  const u = nNow / nStarVal;
  return (u + 1 / u) / 2 - 1;
}

export function etaCalls(Lthreshold, L, kFitSlope) {
  if (kFitSlope <= 0) return null;
  if (L >= Lthreshold) return 0; // frozen past the line
  return Math.ceil((Lthreshold - L) / kFitSlope);
}
