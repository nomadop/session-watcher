import { computeFullCarryBurnRate } from '../rate-lamp.js';
import { BR_AMBER, BR_RED, uAtBr, uLeftAtBr } from '../bill-regret.js';

// Stepwise fold of position frames under a resource selector; `integratePath` is its batch form. Left-endpoint,
// right-continuous: the interval ending at frame k is priced at the state frame k−1 recorded, so a path
// arriving at frame k first moves the position at frame k+1. A frame carries the interval it closes as
// `growth` — the stock's increment and, apart from it, each resource's delta over the same interval — and the
// fold derives the rate under its own selector. Nothing here knows the Engine, the wire or any clock.

function baselineOf(dead, carried, selector) {
  let sum = dead;
  for (const [resourceKey, tokens] of carried) if (selector(resourceKey)) sum += tokens;
  return sum;
}

export function createPathFold({ dead, R, selector }) {
  const carried = new Map();
  let u = 0, lambda = 0, F = 0;
  // The rate in force: the running mean, over the intervals the frames have closed, of the stock growth that
  // landed outside this scenario's baseline. A resource the selector carries enters the bill through B, so
  // its growth is taken out; one it leaves behind is excess that pays rent, so its growth stays in. The mean
  // carries no smoothing parameter, and a level filter's lag would enter the integral once per interval and
  // never be re-read.
  let growthSum = 0, intervals = 0;
  let prev = null;
  function absorb(growth) {
    if (!growth) return;
    let excess = growth.stock;
    for (const [resourceKey, delta] of growth.resources) if (selector(resourceKey)) excess -= delta;
    growthSum += Math.max(0, excess);
    intervals += 1;
  }
  const rate = () => (intervals > 0 ? growthSum / intervals : 0);
  return {
    rate,
    push(frame) {
      for (const [resourceKey, tokens] of frame.resourceTokens) carried.set(resourceKey, tokens);
      const B = baselineOf(dead, carried, selector);
      const x = frame.L / B;
      if (prev === null) {
        absorb(frame.growth);
        prev = { B, g: rate(), L: frame.L };
        return { seq: frame.seq, bDefault: B, x, u: 0, pp: null, mf: null, mfLocal: null, br: null, deltaW: null };
      }
      u += Math.sqrt(prev.g / (2 * R * prev.B));
      const V = Math.sqrt(2 * R * prev.B * prev.g);
      lambda += V;
      F += prev.B + R * prev.g;
      // The interval's own exchange fraction, priced at its left endpoint: the rent ledger converts this
      // interval's rent at the rate in force when it was paid, where the lamp reads the path-weighted mf.
      const mfLocal = V / (prev.B + R * prev.g + V);
      // The rate is zero until the segment has realized any growth, and u = 0 is the left asymptote: the
      // penalty stays open there instead of dividing by zero.
      const pp = u > 0 ? (u - 1) * (u - 1) / (2 * u) : null;
      const mf = lambda / (F + lambda);
      const br = pp === null ? null : mf * pp;
      let deltaW = null;
      if (prev.B > 0) {
        const rPrev = computeFullCarryBurnRate({ L_read: prev.L, B_post: prev.B, B_rebuild: prev.B, cRatio: R });
        const rNow = computeFullCarryBurnRate({ L_read: frame.L, B_post: B, B_rebuild: prev.B, cRatio: R });
        deltaW = 0.5 * (rPrev + rNow);
      }
      absorb(frame.growth);
      prev = { B, g: rate(), L: frame.L };
      return { seq: frame.seq, bDefault: B, x, u, pp, mf, mfLocal, br, deltaW };
    },
  };
}

export function integratePath(frames, opts) {
  const fold = createPathFold(opts);
  const points = frames.map(frame => fold.push(frame));
  return { points, gBar: fold.rate() };
}

export function fitAffine(points) {
  const fitted = [];
  let su = 0;
  const distinct = new Set();
  for (const p of points) {
    if (p.pp === null) continue;
    fitted.push(p); su += p.u; distinct.add(p.u);
  }
  if (distinct.size < 2) return null;
  // Moments about the mean u and about a data point's x, not raw sums: the raw-moment slope numerator
  // cancels to rounding dust on a flat trajectory, and a dust-sized positive slope stands as a reference whose
  // wall lies at an astronomical u. Offsetting x by a fitted point makes a flat trajectory's covariance
  // exactly zero.
  const n = fitted.length, uMean = su / n, x0 = fitted[0].x;
  let suu = 0, sux = 0, sx = 0;
  for (const p of fitted) {
    const du = p.u - uMean;
    suu += du * du; sux += du * (p.x - x0); sx += p.x;
  }
  const d = sux / suu;
  // Finite as well as positive: an overflowed slope would leave a non-null reference standing while every
  // landmark `landmarksOf` evaluates on it comes out NaN — the mixed state all-or-nothing forbids.
  if (!(Number.isFinite(d) && d > 0)) return null;
  return { a: sx / n - d * uMean, d };
}

export function landmarksOf(reference, mf) {
  if (!reference || !(Number.isFinite(mf) && mf > 0)) {
    return { xSweet: null, xBrAmberL: null, xBrAmberR: null, xBrRedR: null };
  }
  const xAt = (u) => reference.a + reference.d * u;
  return {
    xSweet: xAt(1),
    xBrAmberL: xAt(uLeftAtBr(mf, BR_AMBER)),
    xBrAmberR: xAt(uAtBr(mf, BR_AMBER)),
    xBrRedR: xAt(uAtBr(mf, BR_RED)),
  };
}
