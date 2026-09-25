import test from 'node:test';
import assert from 'node:assert/strict';
import { createPathFold, integratePath, fitAffine, landmarksOf } from '../lib/measurement/position.js';
import { computeFullCarryBurnRate } from '../lib/rate-lamp.js';
import { computeMovableFrac } from '../lib/bill-regret.js';
import { nucleus } from '../lib/landmarks.js';

const DEAD = 1000, R = 10;
const all = () => true;
// `g` is the interval's stock growth; `grown` names the resources whose growth is part of it. A null `g` is a
// frame that closes no interval, as the Engine's first frame of a segment.
const frame = (seq, L, g, tokens = {}, grown = {}) => ({
  seq, L,
  growth: g === null ? null : { stock: g, resources: new Map(Object.entries(grown)) },
  resourceTokens: new Map(Object.entries(tokens)),
});
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const fold = (frames, selector = all) => integratePath(frames, { dead: DEAD, R, selector }).points;

// Constant g, L growing by g per frame from x_0 = 1.
const steady = (n, g = 100) => Array.from({ length: n }, (_, i) => frame(i + 1, DEAD + i * g, g));

test('the first frame has u = 0, x and bDefault set, and null pp/mf/br/deltaW', () => {
  const [p0] = fold(steady(3));
  assert.deepEqual(p0, { seq: 1, bDefault: DEAD, x: 1, u: 0, pp: null, mf: null, mfLocal: null, br: null, deltaW: null });
});

test('mfLocal is the single-endpoint exchange fraction priced at the interval\'s left endpoint, zero under a zero rate', () => {
  const pts = fold([frame(1, DEAD, null), frame(2, DEAD + 50, 100, { r: 500 }), frame(3, DEAD + 150, 100), frame(4, DEAD + 250, 100)]);
  assert.equal(pts[1].mfLocal, 0);
  near(pts[2].mfLocal, computeMovableFrac(R, DEAD + 500, 100));
  near(pts[3].mfLocal, computeMovableFrac(R, DEAD + 500, 100));
  assert.notEqual(pts[3].mfLocal, pts[3].mf, 'the path-weighted mf still carries the first interval');
});

test('a zero rate leaves u at 0 with pp and br null while mf and deltaW still accrue', () => {
  // The Engine's first frame closes no interval, so the rate is zero until an interval of realized growth
  // has settled, and the fold must hold the left asymptote open rather than divide by u = 0.
  const [, p1, p2, p3] = fold([frame(1, DEAD, null), frame(2, DEAD + 50, 0), frame(3, DEAD + 100, 100), frame(4, DEAD + 200, 100)]);
  for (const p of [p1, p2]) {
    assert.equal(p.u, 0); assert.equal(p.pp, null); assert.equal(p.br, null); assert.equal(p.mf, 0);
  }
  near(p1.deltaW, 0.5 * (0 + 50 / (R * DEAD)));
  assert.ok(p3.u > 0 && Number.isFinite(p3.pp) && Number.isFinite(p3.br));
});

test('historical causality: an effect at frame t changes no u/pp at or before t', () => {
  const base = steady(6);
  const withEffect = steady(6);
  withEffect[2] = frame(3, base[2].L, base[2].g, { r: 500 });
  const a = fold(base), b = fold(withEffect);
  for (let i = 0; i <= 2; i++) { assert.equal(b[i].u, a[i].u); assert.equal(b[i].pp, a[i].pp); }
  assert.notEqual(b[3].u, a[3].u, 'the interval after the effect is priced at the new baseline');
});

test('arrival continuity: ΔL = ΔB leaves that frame\'s u and pp unchanged', () => {
  const base = steady(4);
  const shifted = steady(4);
  shifted[2] = frame(3, base[2].L + 500, base[2].g, { r: 500 });
  const a = fold(base), b = fold(shifted);
  assert.equal(b[2].u, a[2].u);
  assert.equal(b[2].pp, a[2].pp);
});

test('future deceleration: a larger B yields a smaller Δu; u never decreases', () => {
  const small = fold(steady(4));
  const large = fold([frame(1, DEAD, 100, { r: 4000 }), ...steady(4).slice(1)]);
  assert.ok(large[1].u - large[0].u < small[1].u - small[0].u);
  for (const pts of [small, large]) for (let i = 1; i < pts.length; i++) assert.ok(pts[i].u >= pts[i - 1].u);
});

test('steady-state degeneration: u_path = u_inst, m_T = computeMovableFrac, pp is the EOQ shape', () => {
  const g = 100, frames = steady(8, g), pts = fold(frames);
  const dhat = nucleus(R, g, DEAD);
  for (let k = 1; k < pts.length; k++) {
    const x = frames[k].L / DEAD;
    near(pts[k].u, (x - 1) / dhat);
    near(pts[k].mf, computeMovableFrac(R, DEAD, g));
    near(pts[k].pp, (pts[k].u - 1) ** 2 / (2 * pts[k].u));
    near(pts[k].br, pts[k].mf * pts[k].pp);
  }
});

test('online update: a new frame changes no earlier point', () => {
  const frames = steady(6);
  const full = fold(frames), prefix = fold(frames.slice(0, 4));
  assert.deepEqual(full.slice(0, 4), prefix);
});

test('left arm: pp falls with every frame while u < 1, and mf never exceeds the AM-GM bound', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const frames = [];
  let L = DEAD;
  for (let i = 1; i <= 200; i++) {
    const g = 50 + Math.floor(rnd() * 3000);
    L += g;
    frames.push(frame(i, L, g, rnd() < 0.1 ? { [`r${i}`]: Math.floor(rnd() * 20000) } : {}));
  }
  const pts = fold(frames);
  for (let k = 2; k < pts.length; k++) {
    if (pts[k].u < 1) assert.ok(pts[k].pp < pts[k - 1].pp, `pp falls at ${k}`);
    assert.ok(pts[k].mf <= 1 / (1 + Math.SQRT2) + 1e-12, `mf bound at ${k}`);
  }
});

test('createPathFold pushed one frame at a time yields the points integratePath returns', () => {
  const frames = [frame(1, DEAD, 100, { r: 500 }), frame(2, DEAD + 100, 100), frame(3, DEAD + 250, 150, { r: 900 }), frame(4, DEAD + 400, 150)];
  const stepwise = createPathFold({ dead: DEAD, R, selector: all });
  assert.deepEqual(frames.map(f => stepwise.push(f)), fold(frames));
});

test('deltaW under constant B_S equals the trapezoid over computeFullCarryBurnRate, value for value', () => {
  const frames = steady(5), pts = fold(frames);
  const r = (L) => computeFullCarryBurnRate({ L_read: L, B_post: DEAD, B_rebuild: DEAD, cRatio: R });
  for (let k = 1; k < pts.length; k++) near(pts[k].deltaW, 0.5 * (r(frames[k - 1].L) + r(frames[k].L)));
});

test('deltaW: ΔL = ΔB leaves the interval unchanged; a higher B_S at both endpoints at equal L does not increase it; the left endpoint prices it', () => {
  const base = fold(steady(3));
  const shifted = steady(3); shifted[2] = frame(3, shifted[2].L + 500, 100, { r: 500 });
  near(fold(shifted)[2].deltaW, base[2].deltaW);
  const raised = steady(3); raised[0] = frame(1, DEAD + 3000, 100, { r: 700 }); raised[1] = frame(2, DEAD + 3100, 100); raised[2] = frame(3, DEAD + 3200, 100);
  const plain = [frame(1, DEAD + 3000, 100), frame(2, DEAD + 3100, 100), frame(3, DEAD + 3200, 100)];
  assert.ok(fold(raised)[2].deltaW <= fold(plain)[2].deltaW);
  // Both terms of the trapezoid take the LEFT endpoint's baseline as the rebuild cost, and only a carried
  // resource lifting that baseline off `dead` can tell — test/position.test.js `under constant B_S` prices a
  // path where the two coincide, and the ordering above holds even where the left endpoint has dropped out
  // of the pricing entirely.
  const rRaised = (L) => computeFullCarryBurnRate({ L_read: L, B_post: DEAD + 700, B_rebuild: DEAD + 700, cRatio: R });
  near(fold(raised)[2].deltaW, 0.5 * (rRaised(DEAD + 3100) + rRaised(DEAD + 3200)));
});

test('a resource excluded by the selector contributes nothing; a resource carries forward from its latest frame', () => {
  const frames = [frame(1, DEAD, 100, { r: 500 }), frame(2, DEAD + 100, 100), frame(3, DEAD + 200, 100)];
  const included = fold(frames), excluded = fold(frames, key => key !== 'r');
  assert.equal(included[2].bDefault, DEAD + 500);
  assert.equal(excluded[2].bDefault, DEAD);
});

test('the rate is the mean of stock growth net of the SELECTED resources\' growth: excluding a resource makes its growth excess', () => {
  // Every interval the stock grows by 300, of which resource r accounts for 200.
  const frames = [
    frame(1, DEAD, null, { r: 1000 }),
    frame(2, DEAD + 300, 300, { r: 1200 }, { r: 200 }),
    frame(3, DEAD + 600, 300, { r: 1400 }, { r: 200 }),
    frame(4, DEAD + 900, 300, { r: 1600 }, { r: 200 }),
  ];
  const included = integratePath(frames, { dead: DEAD, R, selector: all });
  const excluded = integratePath(frames, { dead: DEAD, R, selector: key => key !== 'r' });
  assert.equal(included.gBar, 100);
  assert.equal(excluded.gBar, 300);
  // The interval ending at frame 3 is priced at the rate in force after frame 2, under each scenario's own B.
  near(included.points[2].u, Math.sqrt(100 / (2 * R * (DEAD + 1200))));
  near(excluded.points[2].u, Math.sqrt(300 / (2 * R * DEAD)));
  // A resource that SHRINKS while selected adds its release to the rate, as the Engine's net resident delta does.
  const shrink = [frame(1, DEAD, null, { r: 1000 }), frame(2, DEAD + 100, 100, { r: 700 }, { r: -300 })];
  assert.equal(integratePath(shrink, { dead: DEAD, R, selector: all }).gBar, 400);
  assert.equal(integratePath(shrink, { dead: DEAD, R, selector: key => key !== 'r' }).gBar, 100);
});

test('an interval whose selected growth exceeds the stock growth counts as zero, and a frame without growth leaves the rate where it stands', () => {
  const stepwise = createPathFold({ dead: DEAD, R, selector: all });
  stepwise.push(frame(1, DEAD, null));
  assert.equal(stepwise.rate(), 0);
  stepwise.push(frame(2, DEAD + 100, 100, { r: 500 }, { r: 500 }));
  assert.equal(stepwise.rate(), 0, 'growth placed on a selected resource is not excess');
  stepwise.push(frame(3, DEAD + 400, 300));
  assert.equal(stepwise.rate(), 150);
  stepwise.push(frame(4, DEAD + 400, null));
  assert.equal(stepwise.rate(), 150);
});

test('fitAffine is OLS of x on u over points after the first frame, not anchored through the last', () => {
  const pts = [
    { u: 0, x: 99, pp: null },
    { u: 1, x: 5, pp: 0 }, { u: 2, x: 8, pp: 0.25 }, { u: 3, x: 11, pp: 2 / 3 },
  ];
  assert.deepEqual(fitAffine(pts), { a: 2, d: 3 });
  const off = [...pts, { u: 4, x: 20, pp: 1.125 }];
  const fit = fitAffine(off);
  assert.ok(fit.d > 3 && fit.a + fit.d * 4 !== 20, 'the last point keeps a residual');
});

test('fitAffine returns null when the points share a single u, or when d is not a positive finite number', () => {
  assert.equal(fitAffine([{ u: 1, x: 2, pp: 0 }]), null);
  assert.equal(fitAffine([{ u: 1, x: 2, pp: 0 }, { u: 1, x: 3, pp: 0 }]), null);
  // The mean of three equal u can round off u itself, leaving a positive spread about the mean with no spread
  // in the data; against a falling x the slope then lands finite and positive, so the distinct set is the
  // sole guard refusing this fit. Both literals are load-bearing witnesses — a u whose triple sum is exact
  // would leave the spread at 0, and a rising x would leave the slope negative, each refused by another guard.
  assert.equal(fitAffine([{ u: 0.1, x: 3, pp: 0 }, { u: 0.1, x: 2, pp: 0 }, { u: 0.1, x: 1, pp: 0 }]), null);
  // A flat trajectory has an exactly zero slope: x = L / B held while the segment's realized mean growth keeps
  // u advancing is an ordinary idle stretch, and a dust-sized positive slope would send the wall's u, and the
  // hero's y range with it, off to the horizon.
  const flat = []; for (let i = 1; i <= 12; i++) flat.push({ u: 0.17 * i, x: 1.1, pp: 0 });
  assert.equal(fitAffine(flat), null);
  assert.equal(fitAffine([{ u: 1, x: 5, pp: 0 }, { u: 2, x: 4, pp: 0.25 }]), null);
  assert.equal(fitAffine([{ u: 0, x: -1e308, pp: 0 }, { u: 1, x: 1e308, pp: 0 }]), null);
});

test('landmarksOf returns every landmark ordered and finite, or every landmark null without a reference or a positive finite mf', () => {
  const marks = landmarksOf({ a: 1, d: 0.5 }, 0.3);
  assert.equal(marks.xSweet, 1.5);
  assert.ok(marks.xBrAmberL < marks.xSweet && marks.xSweet < marks.xBrAmberR && marks.xBrAmberR < marks.xBrRedR);
  const nulls = { xSweet: null, xBrAmberL: null, xBrAmberR: null, xBrRedR: null };
  assert.deepEqual(landmarksOf(null, 0.3), nulls);
  assert.deepEqual(landmarksOf({ a: 1, d: 0.5 }, null), nulls);
  assert.deepEqual(landmarksOf({ a: 1, d: 0.5 }, 0), nulls);
});
