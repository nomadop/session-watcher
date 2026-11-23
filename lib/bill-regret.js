// lib/bill-regret.js
// The bill-regret algebra: br = mf × pp, with pp = (u−1)²/(2u) read at the causal position u. pp(u) equals
// pp(1/u) and is minimized at u = 1, so a br target's left and right arms are reciprocal roots of the same
// quadratic: `uAtBr` is the right root, `uLeftAtBr` the left, `walletIntervalFor` the wallet clock's unit
// built from the right root, and BR_AMBER/BR_RED the bounds `lampZone` reads the lamp's zone by. The fold in
// `lib/measurement/position.js` stamps br and places every x landmark from these roots, the status wire and
// `lib/statusline-format.js` carry the zone, and
// the single-endpoint `computeMovableFrac`/`computeBr`/`computePp` serve the kept-bucket what-if in
// `lib/handoff.js`, which has no fold of its own to read a causal position from. `wallPositionFor` states
// the rate wall from the price ratio alone.

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

// The pp term of `computeBr` on its own: the fraction br divides by mf, read at the instantaneous
// position `(x−1)/dhat` rather than at the fold's causal u, which is why its consumer is the handoff
// what-if and not any path that has a stamp to read.
export function computePp(x, dhat) {
  if (!Number.isFinite(x) || !Number.isFinite(dhat) || dhat <= 0) return null;
  const u = (x - 1) / dhat;
  if (!Number.isFinite(u) || u <= 0) return null;
  return (u - 1) * (u - 1) / (2 * u);
}

// The right root of mf·(u−1)²/(2u) = brTarget; mf is a FRACTION (0.3, not 30%).
// NOTE: In the ordinary model, where every call is one slot of the interval's rent, AM-GM gives mf ≤ 1/(1+√2)
// (equality at L = cRatio·k), which bounds u_amber from below. A priced recall request (`CONTEXT.md` Recall Request)
// is no such slot, so the path's estimate ranges over [0, 1] and nothing here clamps it; the interval GROWS as mf
// shrinks and is shortest at mf = 1. A clamp would break invariant 6 (higher mf → shorter interval is correct —
// remind more when movable fraction is high).
export function uAtBr(mf, brTarget) {
  if (!Number.isFinite(mf) || mf <= 0) return Infinity;
  if (!Number.isFinite(brTarget)) return Infinity;   // non-finite target → safe degrade (never fires)
  if (brTarget <= 0) return 1;                        // genuinely-≤0 finite target → degenerate root
  const a = mf;
  const b = -(2 * mf + 2 * brTarget);
  const c = mf;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;   // mf too small to reach brTarget
  return (-b + Math.sqrt(disc)) / (2 * a);
}

// The wallet clock's unit: one lap is u_amber²/2 of accumulated rent. On a static cycle (constant baseline,
// growth and ratio, rate established, initial stock at the baseline) the bill accumulated on the way to
// position u is u² (g/B/dhat/cRatio cancel in the integral), so the second lap lands on the amber right root
// and lap k on u_amber·√(k/2).
export function walletIntervalFor(mf, brTarget) {
  const u = uAtBr(mf, brTarget);
  if (!Number.isFinite(u)) return Infinity;
  return u * u / 2;   // no lower clamp: the interval's own floor is its value at the greatest mf, in uAtBr's note
}

// The left root of the same quadratic: in u² − (2+2p)u + 1 = 0 the roots multiply to the constant term.
export function uLeftAtBr(mf, brTarget) {
  return 1 / uAtBr(mf, brTarget);
}

// The lamp's zone at a stamped position. The left arm (u below the sweet spot) is white until the amber-left
// root and green from it; the right arm is zoned by br against BR_RED and BR_AMBER.
export function lampZone(br, { u, mf }) {
  if (!Number.isFinite(br)) return 'white';
  if (u < 1) return u >= uLeftAtBr(mf, BR_AMBER) ? 'green' : 'white';
  if (br >= BR_RED)   return 'red';
  if (br >= BR_AMBER) return 'amber';
  return 'green';
}

// The rate wall: the position where one more call's avoidable rent equals a whole rebuild. Its readers gate
// differently — `enrichStatusLandmarks` on a positive baseline and ratio, the Engine's scenario read on the
// fold's own reliability — so each keeps its own guard and only the position itself lives here.
export function wallPositionFor(cRatio) {
  return 1 + cRatio;
}
