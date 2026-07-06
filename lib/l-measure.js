import { CONSTANTS } from './constants.js';

// The SOLE accessor for a call's authoritative L. Normal rows: L === cacheRead. Detected miss rows:
// L === cacheRead + cacheCreation (stock reconstruction). When `L` is absent (a record written before
// this field existed, or a hot-reload mid-write) it falls back to raw cacheRead — provider-INDEPENDENT
// backward-compat; every provider's normal row still satisfies L === cacheRead. Used everywhere
// metrics / baseline / history read L, EXCEPT the three raw-cacheRead carve-outs (kFit tail,
// segmentation total, dashboard raw display) — see the plan's Global Constraints. Null-safe: a
// nullish record yields 0 (never throws), though internal callers always pass a real record.
export function effectiveL(c) { return Number.isFinite(c?.L) ? c.L : (c?.cacheRead ?? 0); }

// Threshold-free, PROVIDER-AGNOSTIC cache-miss detection (spec §3.1 / §3.7 revised). All three
// criteria are dimensionless ratios; there is NO absolute token constant AND NO vendor-name gate — the
// gate on `providerOf==='claude'` was dropped (user ruling: "claude 不能保证是孤例，需要保证鲁棒性"),
// because it is a STRUCTURAL property (does cacheCreation carry re-cacheable stock), not a vendor fact,
// and a renamed/rehosted Claude would slip a name-regex. The 3 criteria test that structure directly:
//   • criterion 1 (cr/total < 0.5) is a structural no-op on any provider that reports cacheCreation≡0
//     (e.g. DeepSeek: total = cr → ratio 1.0 → never fires) — so no allowlist is needed.
//   • criterion 2 bounds the reconstructed L=total near the segment peak, so even a hypothetical
//     unknown provider reporting large non-re-cacheable cacheCreation can't fabricate a wild L.
// peakReadBefore === 0 (cold start / segment-first row) makes criterion 3 false for free, excluding
// cold-start without a magic number and protecting the b = dead/L_base anchor.
// (General solution if a counterexample ever appears — spec §3.7: add criterion 4 "next row's cacheRead
// recovers to ≈ cr+cc". NOT implemented in v1.1; criteria 1–3 cover every observed case.)
export function classifyMiss({ cacheRead, cacheCreation, peakTotalBefore, peakReadBefore }) {
  const total = cacheRead + cacheCreation;
  return total > 0 && cacheRead < total * CONSTANTS.MISS_READ_RESIDUAL            // 1. read collapsed (self-judging ratio)
    && peakTotalBefore > 0 && total >= peakTotalBefore * CONSTANTS.MISS_TOTAL_KEEP // 2. total stock preserved (not /clear)
    && peakReadBefore > 0 && cacheRead < peakReadBefore * CONSTANTS.MISS_READ_RESIDUAL; // 3. fell from an ESTABLISHED read peak
}
