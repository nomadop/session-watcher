// dsh/src/inner-quote.js — the inner seal's quote: the estimate of what sealing the current A would save, and the bounded decision the seal takes on it. The quote is a heuristic engineering estimate at the decision point, not a bill and not a causal phase.
// It knows no Cordis and imports no DSH package: the session's messages and its model policy's calibrated pair reach it by parameter.
import { INNER_SEAL_KIND, renderCarried, renderCarrier } from '../../lib/harness/dsh/inner-seal-message.js';
import { charsToTokens } from '../../lib/token-estimate.js';

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

// The text of a content block as the request carries it: a text or reasoning block its text, a call its name and arguments, any other block its JSON.
const blockText = block => (block.type === 'text' || block.type === 'reasoning' ? block.text
  : block.type === 'tool-call' ? `${block.name}${block.arguments}` : JSON.stringify(block));

// The tokens of a message's blocks under `ctp`; the counts add, so the blocks are priced as one text.
const messageTokens = (message, ctp) => charsToTokens(message.content.map(blockText).join(''), ctp);

// B as a carrier of the changes `carried` renders it: the text block `renderCarrier` appends last, its blank-line opening included, so the carrier's own framing and C stay out of it.
const bTokens = (carried, ctp) => (renderCarried(carried) === null ? 0
  : charsToTokens(renderCarrier({ kind: INNER_SEAL_KIND, v: 1, slots: [], ...carried }).at(-1).text, ctp));

/**
 * The estimate of the current A of `n` counted steps over the seqs of `range`, every text priced by the session's model policy's calibrated pair `ctp` through the authoritative chars→tokens estimator: `lA` the sum over the range's seqs of the tokens of the message `messageOf(seq)` derives (null for a node that derives none), `bEst` the tokens of the B block a carrier of the B changes `carried` (an `omitShown` answer) renders, `cEst` C at `INNER_QUOTE.cPerStep` per counted step, which also covers the carrier's text outside B, the state block included, `sEst` the savings `lA − bEst − cEst`.
 * @param {{ n: number, range: number[], messageOf: (seq: number) => (object|null), carried: object, ctp: { ascii: number, cjk: number } }} options
 */
export function estimateInnerA({ n, range, messageOf, carried, ctp }) {
  const lA = range.reduce((sum, seq) => {
    const message = messageOf(seq);
    return message === null ? sum : sum + messageTokens(message, ctp);
  }, 0);
  const bEst = bTokens(carried, ctp);
  const cEst = INNER_QUOTE.cPerStep * n;
  return { n, lA, bEst, cEst, sEst: lA - bEst - cEst };
}

const NO_RESULT = Object.freeze({ nRef: null, N: null, jRef: null, q: null, arm: null });

// The results over a valid S > 0: F₀ = ρK₀ + (ρ−1)B, nRef = F₀/S, V = (ρ−1)C/S, N = nRef + V, jRef = 2√(n·nRef) + V, q = (n+N)/jRef; N is never ceiled. Any result that is not finite, or a reference that is not positive, leaves the quote without one.
function resultsOf(n, { bEst, cEst, sEst }, cRatio) {
  const f0 = cRatio * INNER_QUOTE.fee + (cRatio - 1) * bEst;
  const nRef = f0 / sEst;
  const v = (cRatio - 1) * cEst / sEst;
  const N = nRef + v;
  const jRef = 2 * Math.sqrt(n * nRef) + v;
  const q = (n + N) / jRef;
  if (![nRef, N, jRef, q].every(Number.isFinite) || !(jRef > 0)) return null;
  return { nRef, N, jRef, q, arm: n >= nRef ? 'right' : 'left' };
}

// Why the quote has no results, null where it has them.
function missingOf(estimate, cRatio) {
  if (estimate === null) return 'estimate_failed';
  if (!Number.isFinite(cRatio)) return 'ratio_unavailable';
  if (!(estimate.sEst > 0)) return 'non_positive_savings';
  return null;
}

/**
 * The quote of sealing a current A of `n` counted steps at the price ratio `cRatio` under `KAPPA_PRESETS[preset]` and its decision, as one plain snapshot: the estimate's `n, lA, bEst, cEst, sEst` (null where `estimate` is null, the estimate having failed), the session's `cRatio` (null where it could not be read), the `fee` it was priced under, the `kappa` the left arm was compared with (the named preset's, null where the ratio is missing or κ is not a finite number), the `preset` id it was priced under (the id handed in, recorded whatever the quote found), the results `nRef, N, jRef, q` and the `arm`, `left` or `right` of the reference, and `trigger`.
 * `trigger` is `quote` from `INNER_QUOTE.minSteps` on where the quote has results and `n` is at or right of `nRef` (the right arm, whatever q) or `q` is under `kappa` (the left arm, strictly); otherwise null, the seal declined. No step count attempts a seal whatever the quote.
 * `missing` names why the results are null: `estimate_failed`, `ratio_unavailable`, `non_positive_savings` or `undefined_result` (a result or κ that is not a finite number); null where they are not. No missing value is read as a zero, and none stands in for a κ that cannot be computed.
 */
export function innerQuote({ n, estimate, cRatio, preset }) {
  const ratio = Number.isFinite(cRatio) ? cRatio : null;
  const priced = ratio === null ? NaN : kappaOf(n, ratio, KAPPA_PRESETS[preset]);
  const kappa = Number.isFinite(priced) ? priced : null;
  let missing = missingOf(estimate, ratio);
  let results = missing === null ? resultsOf(n, estimate, ratio) : null;
  if (missing === null && (results === null || kappa === null)) {
    missing = 'undefined_result';
    results = null;
  }
  const quoted = results !== null && n >= INNER_QUOTE.minSteps && (results.arm === 'right' || results.q < kappa);
  return {
    n,
    lA: estimate?.lA ?? null, bEst: estimate?.bEst ?? null, cEst: estimate?.cEst ?? null, sEst: estimate?.sEst ?? null,
    cRatio: ratio, fee: INNER_QUOTE.fee, kappa, preset,
    ...(results ?? NO_RESULT),
    trigger: quoted ? 'quote' : null, missing,
  };
}
