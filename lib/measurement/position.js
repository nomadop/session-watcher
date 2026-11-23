import { computeFullCarryBurnRate } from '../rate-lamp.js';
import { BR_AMBER, BR_RED, uAtBr, uLeftAtBr } from '../bill-regret.js';

// Stepwise fold of position frames under a resource selector; `integratePath` is its batch form. Left-endpoint,
// right-continuous: the interval ending at frame k is priced at the state frame k−1 recorded, so a path
// arriving at frame k first moves the position at frame k+1. A frame carries the interval it closes as
// `growth` — the stock's increment and, apart from it, each resource's delta over the same interval — and the
// fold derives the rate under its own selector. The interval spans the main calls between the `mainCallOrdinal`s of
// its two frames, and what it adds to u, Λ, F and deltaW weighs by that span. A frame may also carry `recall` for the
// interval it closes: how many of the spanned calls are extra requests that only read events back and have a bill
// (`priced`), the sum of those bills in read-price units (`net`), and how many have none the Source can establish
// (`unpriced`). A priced request pays its bill beside the ordinary slots of the other calls, in place of its own
// slot. Nothing here knows the Engine, the wire or any clock.

function baselineOf(dead, carried, selector) {
  let sum = dead;
  for (const [resourceKey, tokens] of carried) if (selector(resourceKey)) sum += tokens;
  return sum;
}

// The main calls the interval between two frames spans: the difference of their ordinals where both carry one,
// else a single call, as a frame of a Source that states no main call stands for one.
export function mainCallsBetween(prevOrdinal, ordinal) {
  return prevOrdinal > 0 && ordinal > 0 ? ordinal - prevOrdinal : 1;
}

export function createPathFold({ dead, R, selector }) {
  const carried = new Map();
  let u = 0, lambda = 0, F = 0;
  // The rates in force. Both are a non-negative part, taken once, of a signed sum over every closed interval, over the
  // main calls those intervals span: `gPhys` of the resident growth alone — the stock's increment outside the
  // selector's baseline, a resource the selector carries entering the bill through B and one it leaves behind
  // paying rent — and `gBar` of that growth plus the drift of the recall bill per main call (below). A ratio of sums
  // carries no smoothing parameter, and a level filter's lag would enter the integral once per interval and never be
  // re-read.
  let physical = 0, combined = 0, spanned = 0;
  // The recall bill per main call of the latest closed interval, `A / m`, which the next interval's is compared with.
  // An ordinary path holds none, so the comparison starts from zero; an interval with a request whose price is unknown
  // is neither zero nor a base, so the one after it has nothing to compare with.
  let recallPerCall = 0;
  let prev = null;
  function absorb(frame, calls, closes) {
    const { growth, recall } = frame;
    if (!growth) return;
    let excess = growth.stock;
    for (const [resourceKey, delta] of growth.resources) if (selector(resourceKey)) excess -= delta;
    let drift = excess;
    if (closes) {
      if ((recall?.unpriced ?? 0) > 0) {
        recallPerCall = null;
      } else {
        const bill = (recall?.net ?? 0) / calls;
        if (recallPerCall !== null) drift += bill - recallPerCall;
        recallPerCall = bill;
      }
    }
    physical += excess;
    combined += drift;
    spanned += calls;
  }
  const rate = () => (spanned > 0 ? Math.max(0, combined) / spanned : 0);
  const physicalRate = () => (spanned > 0 ? Math.max(0, physical) / spanned : 0);
  return {
    rate,
    physicalRate,
    push(frame) {
      const calls = mainCallsBetween(prev?.ordinal, frame.mainCallOrdinal);
      for (const [resourceKey, tokens] of frame.resourceTokens) carried.set(resourceKey, tokens);
      const B = baselineOf(dead, carried, selector);
      const x = frame.L / B;
      if (prev === null) {
        absorb(frame, calls, false);
        prev = { B, g: rate(), gPhys: physicalRate(), L: frame.L, ordinal: frame.mainCallOrdinal };
        return { seq: frame.seq, bDefault: B, x, u: 0, pp: null, mf: null, mfLocal: null, br: null, deltaW: null };
      }
      // The extra requests the interval holds are priced whole and take the place of their own ordinary slots, so the
      // fixed part is the ordinary slots', and a request never pays the rent of its slot beside its own bill.
      const slots = calls - (frame.recall?.priced ?? 0);
      u += calls * Math.sqrt(prev.g / (2 * R * prev.B));
      const V = Math.sqrt(2 * R * prev.B * prev.g);
      const lambdaHere = calls * V;
      const fixedHere = slots * (prev.B + R * prev.gPhys);
      lambda += lambdaHere;
      F += fixedHere;
      // The interval's own exchange fraction, priced at its left endpoint: the rent ledger converts this
      // interval's rent at the rate in force when it was paid, where the lamp reads the path-weighted mf. A part
      // with nothing to move has no share, and an interval of extra requests alone owns no fixed part either.
      const mfLocal = lambdaHere > 0 ? lambdaHere / (fixedHere + lambdaHere) : 0;
      // The rate is zero until the segment has realized any growth, and u = 0 is the left asymptote: the
      // penalty stays open there instead of dividing by zero.
      const pp = u > 0 ? (u - 1) * (u - 1) / (2 * u) : null;
      const mf = lambda > 0 ? lambda / (F + lambda) : 0;
      const br = pp === null ? null : mf * pp;
      let deltaW = null;
      if (prev.B > 0) {
        const rPrev = computeFullCarryBurnRate({ L_read: prev.L, B_post: prev.B, B_rebuild: prev.B, cRatio: R });
        const rNow = computeFullCarryBurnRate({ L_read: frame.L, B_post: B, B_rebuild: prev.B, cRatio: R });
        deltaW = slots * (0.5 * (rPrev + rNow)) + (frame.recall?.net ?? 0) / (R * prev.B);
      }
      absorb(frame, calls, true);
      prev = { B, g: rate(), gPhys: physicalRate(), L: frame.L, ordinal: frame.mainCallOrdinal };
      return { seq: frame.seq, bDefault: B, x, u, pp, mf, mfLocal, br, deltaW };
    },
  };
}

export function integratePath(frames, opts) {
  const fold = createPathFold(opts);
  const points = frames.map(frame => fold.push(frame));
  return { points, gBar: fold.rate(), gPhys: fold.physicalRate() };
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

// The reference skeleton x ≈ a + d·u.
const xOn = (reference, u) => reference.a + reference.d * u;

export function landmarksOf(reference, mf) {
  if (!reference || !(Number.isFinite(mf) && mf > 0)) {
    return { xSweet: null, xBrAmberL: null, xBrAmberR: null, xBrRedR: null };
  }
  const xAt = (u) => xOn(reference, u);
  return {
    xSweet: xAt(1),
    xBrAmberL: xAt(uLeftAtBr(mf, BR_AMBER)),
    xBrAmberR: xAt(uAtBr(mf, BR_AMBER)),
    xBrRedR: xAt(uAtBr(mf, BR_RED)),
  };
}

// The right-arm amber landmark in stock units: `anchorL`, the stock plotted at position `u`, moved by the
// landmark's distance from that position on the skeleton and priced at `bDefault` per unit of x, since
// x = L / B_default. Null where the fit, the position, the landmark or the basis is not a usable number.
export function amberStockOf({ reference, u, xBrAmberR, bDefault }, anchorL) {
  if (!reference || !Number.isFinite(u) || !Number.isFinite(xBrAmberR) || !(Number.isFinite(bDefault) && bDefault > 0)) return null;
  return anchorL + bDefault * (xBrAmberR - xOn(reference, u));
}
