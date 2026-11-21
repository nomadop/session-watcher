// lib/inner-seal/quote.js — the inner seal's quote: the estimate of what sealing the current A would save, and the bounded decision the seal takes on it, with the check of its snapshot as the attempt record keeps it. The quote is a heuristic engineering estimate at the decision point, not a bill and not a causal phase.
import { charsToTokens } from '../token-estimate.js';

/**
 * The quote's fixed parameters, chosen rather than measured: below `minSteps` counted steps no quote is taken; C is estimated at `cPerStep` per counted step; `fee` is the fixed fee a seal pays at write price.
 */
export const INNER_QUOTE = Object.freeze({ minSteps: 8, cPerStep: 200, fee: 10000 });

// The price ratio at which the left arm's tolerance has no price compensation, and the shift in its weight b = (ρ − anchor)/(ρ + shift).
const KAPPA_PRICE_ANCHOR = 25;
const KAPPA_WEIGHT_SHIFT = 23;

/**
 * The tolerance presets, κ = 1 + α·η_ρ(n)^p + b_ρ·H(α·η_25(n)^p), the formula of `docs/research/2026-11-16-inner-compaction-kappa-presets.md`. A preset is a start-early to wait-long scale, not a measure of what the seal compresses.
 */
export const KAPPA_PRESETS = Object.freeze({
  E2: Object.freeze({ p: 3, alpha: 19 }),
  W2: Object.freeze({ p: 4, alpha: 9.032 }),
  M2: Object.freeze({ p: 4, alpha: 2.456 }),
  S3: Object.freeze({ p: 5, alpha: 0.7706 }),
  X3: Object.freeze({ p: 5, alpha: 0.22 }),
});

// x^p by repeated multiplication: each product is one correctly rounded step, so κ does not depend on an engine's pow.
const powInt = (x, p) => {
  let power = x;
  for (let step = 1; step < p; step += 1) power *= x;
  return power;
};

// η_ρ(n) = (ρ − 1)·c·n/(ρ·K₀): K₀ the fixed `fee`, c the per-step C.
const etaOf = (n, cRatio) => (cRatio - 1) * INNER_QUOTE.cPerStep * n / (cRatio * INNER_QUOTE.fee);

/**
 * The left arm's tolerance κ for a range of `n` counted steps at the cache write/read price ratio `cRatio` under `preset`, as the research record defines it, used as it stands for any finite ratio: under the price anchor the compensation is negative and κ can fall under 1, which no left quote clears; nothing clamps it. H(D) = 2D/(√(D(D+2)) + D) is the record's stable form of √(D(D+2)) − D, zero where D is. A ratio for which the expression is not a finite number gives that number, left to the caller.
 */
export function kappaOf(n, cRatio, { p, alpha }) {
  const anchored = alpha * powInt(etaOf(n, KAPPA_PRICE_ANCHOR), p);
  const compensation = anchored > 0 ? 2 * anchored / (Math.sqrt(anchored * (anchored + 2)) + anchored) : 0;
  const weight = (cRatio - KAPPA_PRICE_ANCHOR) / (cRatio + KAPPA_WEIGHT_SHIFT);
  return 1 + alpha * powInt(etaOf(n, cRatio), p) + weight * compensation;
}

/**
 * The estimate of the current A of `n` counted steps, every text priced by the session's model policy's calibrated pair `ctp` through the authoritative chars→tokens estimator: `lA` the sum of the tokens of each of `texts`, the request text of each message the harness derives from the range's events (an event that derives none has none), `bEst` the tokens of `bText`, the text of the B changes a carrier would carry (null where it carries none, which is no tokens), `cEst` C at `INNER_QUOTE.cPerStep` per counted step, which also covers the carrier's text outside B, the state block included, `sEst` the savings `lA − bEst − cEst`.
 * @param {{ n: number, texts: string[], bText: (string|null), ctp: { ascii: number, cjk: number } }} options
 */
export function estimateInnerA({ n, texts, bText, ctp }) {
  const lA = texts.reduce((sum, text) => sum + charsToTokens(text, ctp), 0);
  const bEst = charsToTokens(bText, ctp);
  const cEst = INNER_QUOTE.cPerStep * n;
  return { n, lA, bEst, cEst, sEst: lA - bEst - cEst };
}

const NO_RESULT = Object.freeze({ nRef: null, N: null, jRef: null, q: null, arm: null });

// The results over a valid S > 0: F = ρK₀ + (ρ−1)B + R with R the summary call's read of the history, already at the cache-read price and so not multiplied by ρ, nRef = F/S, V = (ρ−1)C/S, N = nRef + V, jRef = 2√(n·nRef) + V, q = (n+N)/jRef; N is never ceiled. Any result that is not finite, or a reference that is not positive, leaves the quote without one.
function resultsOf(n, { bEst, cEst, sEst }, cRatio, readCost) {
  const fixed = cRatio * INNER_QUOTE.fee + (cRatio - 1) * bEst + readCost;
  const nRef = fixed / sEst;
  const v = (cRatio - 1) * cEst / sEst;
  const N = nRef + v;
  const jRef = 2 * Math.sqrt(n * nRef) + v;
  const q = (n + N) / jRef;
  if (![nRef, N, jRef, q].every(Number.isFinite) || !(jRef > 0)) return null;
  return { nRef, N, jRef, q, arm: n >= nRef ? 'right' : 'left' };
}

/**
 * The quote of sealing a current A of `n` counted steps at the price ratio `cRatio` under `KAPPA_PRESETS[preset]` and its decision, as one plain snapshot: the estimate's `n, lA, bEst, cEst, sEst` (null where `estimate` is null, the estimate having failed), the session's `cRatio` (null where it could not be read), the `fee` it was priced under, the `kappa` the left arm was compared with (the named preset's, null where the ratio is missing or κ is not a finite number), the `preset` id it was priced under (the id handed in, recorded whatever the quote found), the results `nRef, N, jRef, q` and the `arm`, `left` or `right` of the reference, `summaryReadCost` where the quote used one, and `trigger`.
 * `summaryReadCost` is the estimate of the one read of the active history the summary call makes, in tokens at the cache-read price, a hit not promised: a finite non-negative number joins the fixed load as it stands, `fee` unchanged, for both arms' one reference. Any other value, missing included, leaves the quote as it is without a read and the snapshot without the member; so does a quote with no results.
 * `trigger` is `quote` from `INNER_QUOTE.minSteps` on where the quote has results and `n` is at or right of `nRef` (the right arm, whatever q) or `q` is under `kappa` (the left arm, strictly); otherwise null, the seal declined. No step count attempts a seal whatever the quote.
 * The results are null where the estimate failed, the ratio is missing, the savings are not positive or a result or κ is not a finite number. No missing value is read as a zero, and none stands in for a κ that cannot be computed.
 */
export function innerQuote({ n, estimate, cRatio, preset, summaryReadCost }) {
  const ratio = Number.isFinite(cRatio) ? cRatio : null;
  const priced = ratio === null ? NaN : kappaOf(n, ratio, KAPPA_PRESETS[preset]);
  const kappa = Number.isFinite(priced) ? priced : null;
  const priceable = estimate !== null && ratio !== null && estimate.sEst > 0;
  const read = Number.isFinite(summaryReadCost) && summaryReadCost >= 0 ? summaryReadCost : null;
  const found = priceable ? resultsOf(n, estimate, ratio, read ?? 0) : null;
  const results = kappa === null ? null : found;
  const quoted = results !== null && n >= INNER_QUOTE.minSteps && (results.arm === 'right' || results.q < kappa);
  return {
    n,
    lA: estimate?.lA ?? null, bEst: estimate?.bEst ?? null, cEst: estimate?.cEst ?? null, sEst: estimate?.sEst ?? null,
    cRatio: ratio, fee: INNER_QUOTE.fee, kappa, preset,
    ...(results ?? NO_RESULT),
    ...(results !== null && read !== null ? { summaryReadCost: read } : {}),
    trigger: quoted ? 'quote' : null,
  };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = value => Number.isSafeInteger(value) && value >= 0;
const orNull = holds => value => value === null || holds(value);

/** The members of a snapshot that are a finite number or null: the estimate's and the results', each null where the quote has none. */
export const QUOTE_QUANTITIES = ['lA', 'bEst', 'cEst', 'sEst', 'cRatio', 'nRef', 'N', 'jRef', 'q'];

/**
 * Whether `value` is a snapshot of a triggered quote as `innerQuote` answers it: the counted steps a count, the quantities of `QUOTE_QUANTITIES` finite or null, the fee and the kappa finite, the arm `left`, `right` or null, the trigger `quote`. One of any other shape is none; members beyond these, `preset` among them, are not read.
 */
export function isQuote(value) {
  return isObject(value) && isSeq(value.n) && QUOTE_QUANTITIES.every(key => orNull(Number.isFinite)(value[key]))
    && Number.isFinite(value.fee) && Number.isFinite(value.kappa) && [null, 'left', 'right'].includes(value.arm)
    && value.trigger === 'quote';
}
