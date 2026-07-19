import { CONSTANTS, SEGMENT_DROP_EPSILON, MISS_CR_DROP } from './constants.js';

// The SOLE accessor for a call's authoritative L. Normal rows: L === cacheRead. Detected miss rows:
// L === cacheRead + cacheCreation (stock reconstruction). When `L` is absent (a record written before
// this field existed, or a hot-reload mid-write) it falls back to raw cacheRead — provider-INDEPENDENT
// backward-compat; every provider's normal row still satisfies L === cacheRead. Used everywhere
// metrics / baseline / history read L, EXCEPT the three raw-cacheRead carve-outs (kFit tail,
// segmentation total, dashboard raw display) — see the plan's Global Constraints. Null-safe: a
// nullish record yields 0 (never throws), though internal callers always pass a real record.
export function effectiveL(c) { return Number.isFinite(c?.L) ? c.L : (c?.cacheRead ?? 0); }

// v3.1 (spec §4): structural cache-miss detection against prevL (the previous row's effective L —
// directly observed, not estimated). The old prevB-based detector suffered from systematic B drift
// (B ≈ 0.5×L due to CTP underestimation and dedup), making the threshold too loose.
// Two dimensionless criteria using only directly-observed values:
//   1. crDropped: cacheRead fell below prevL·MISS_CR_DROP (0.95) → cache partially/fully evicted.
//   2. stockPreserved: totalStock still >= prevTotalStock − ε → content is still present, only cache
//      state changed (not a compact/clear which drops everything).
// Corpus-validated: 759 true misses caught, 0 false positives across 102K calls (both providers).
// prevL<=0 (cold start / segment first row) → never a miss (protects the dead/L_base anchor).
export function classifyMiss({ cacheRead, totalStock, prevL, prevTotalStock }) {
  if (!(prevL > 0)) return false;
  const crDropped = cacheRead < prevL * MISS_CR_DROP;
  const stockPreserved = totalStock >= prevTotalStock - SEGMENT_DROP_EPSILON;
  return crDropped && stockPreserved;
}
