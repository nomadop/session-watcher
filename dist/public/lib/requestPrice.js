// public/lib/requestPrice.js — the two-price valuation of one request's canonical usage, in read-price units: the one place that formula and the rebuild premium live. The browser's settlement report (`compactionEconomics.js`) and the measurement's recall facts (`lib/harness/dsh/recall-facts.js`) price a request through it, so the report and the measurement cannot value one request two ways. It is a pure leaf that imports nothing.

/**
 * What a request cost with the cache priced at `ratio` times the read price for what it wrote or missed: `cacheRead + ratio·(input + cacheWrite)`, the output not priced. Null where a bucket or the ratio is not a finite number.
 * @param {{ input: number, cacheRead: number, cacheWrite: number }|null|undefined} usage the canonical usage
 * @param {number} ratio
 */
export function requestCostOf(usage, ratio) {
  const { input, cacheRead, cacheWrite } = usage ?? {};
  if (![input, cacheRead, cacheWrite, ratio].every(Number.isFinite)) return null;
  return cacheRead + ratio * (input + cacheWrite);
}

/** What `miss` tokens the cache did not serve cost above the read price they would have cost cached: `(ratio − 1)·miss`, the premium of rebuilding them. */
export const rebuildPremiumOf = (miss, ratio) => (ratio - 1) * miss;
