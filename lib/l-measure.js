import { CONSTANTS, SEGMENT_DROP_EPSILON, MISS_CR_DROP } from './constants.js';

// v3.1 (spec §4): structural cache-miss detection against prevL (the previous row's measured L —
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
