import { cRatioFor, contextWindowFor } from './extract.js';
import { RESERVED_OUTPUT, CTX_SAFETY_MARGIN } from './constants.js';
import { lStar, phi, paybackP, theilSen } from './metrics.js';

// getHistory endpoint memoization (H1), extracted from SessionWatcher. Both functions take the watcher
// instance `w` and call w._baselineAndKavg — the SAME per-point pipeline getStatus uses — so the last
// point of the current segment still matches getStatus exactly (QF1). SessionWatcher keeps a thin
// getHistory delegator. Pure code motion — no behavior change.

// One history point for call `c`, given `arr` = the FULL prefix of its segment up to and including
// `c` (identical to what today's loop passes to _baselineAndKavg), `lockedModel` = the segment's
// creation model, and `fitWindow`. A point is a PURE function of (arr, lockedModel, fitWindow), so
// computing it once and caching it is output-identical to recomputing it — this purity is exactly
// what makes the getHistory memoization safe. Extracted verbatim from the old inline loop body.
export function computeHistoryPoint(w, c, arr, lockedModel, fitWindow, latchStore) {
  const { baseline, L, kAvg } = w._baselineAndKavg(arr, { latchStore });
  const total = baseline.total;
  const cRatio = w.ratioOverride ?? cRatioFor(lockedModel);
  const kFitSlope = theilSen(arr.slice(-fitWindow).map(x => x.cacheRead));
  const Lstar = lStar(total, cRatio, kAvg);
  // #9: emit the CAPPED decision line so the chart matches getStatus's red-line decision.
  // Lcap uses the SAME segment-locked model as cRatio above (ratio and cap must agree); when
  // the context window binds (Lcap < Lstar) the statusbar restarts at Lthreshold while the old
  // chart plotted uncapped Lstar → visible contradiction. Lstar is KEPT as an aux/reference line.
  const Lcap = contextWindowFor(lockedModel) - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;
  const Lthreshold = Math.min(Lstar, Lcap);
  return {
    ts: c.ts, segment: c.segment, L,
    Lstar, Lthreshold, kAvg, kFitSlope,
    paybackP: paybackP(L, total), phi: phi(L, total, cRatio, kAvg),
    miss: c.miss === true, cacheRead: c.cacheRead, cacheCreation: c.cacheCreation,
  };
}

export function getHistory(w, fitWindowOverride) {
  const fitWindow = fitWindowOverride ?? w.fitWindow;
  // one point per folded call, cumulative L*/k recomputed per segment prefix — via the SAME
  // _baselineAndKavg pipeline getStatus uses, so the last point of the current segment matches
  // getStatus exactly (baselineSeq/knee/kAvg + empty-seq guard all inherited).
  //
  // H1 memoization. History point `i` is a PURE function of (its segment's calls [0..i], fitWindow);
  // appending a later call never changes an earlier point. So a cached prefix is reusable ONLY when
  // ALL of these hold — any single mismatch → full rebuild (today's proven O(n²) code path):
  //   • fitWindow matches the cache's fitWindow      (theilSen tail window differs per point)
  //   • _foldRev matches                              (hazard #1: an in-place fold rewrote a call an
  //                                                     already-emitted point depends on; length is
  //                                                     unchanged so only the rev counter catches it)
  //   • _calls.length >= cache.count                  (hazard #2: a shrink/rotation-rebuild left the
  //                                                     cached tail longer than _calls → stale)
  // (injectedDead/ratioOverride are fixed at construction — constant, need no check.)
  // On reuse we keep the cached points + per-segment accumulators (bySeg/lockedModelBySeg) and
  // compute ONLY the appended tail (_calls beyond cache.count), so the arrays passed to
  // _baselineAndKavg are the same full segment prefixes as a cold build → identical output.
  const cache = w._historyCache;
  const canReuse = cache !== null
    && cache.fitWindow === fitWindow
    && cache.foldRev === w._foldRev
    && w._calls.length >= cache.count;

  let out, bySeg, lockedModelBySeg, latchBySeg, start;
  if (canReuse) {
    out = cache.points;
    bySeg = cache.bySeg;
    // C_RATIO is segment-locked (spec invariant): the model captured at each segment's creation —
    // the first call folded into that segment, matching how _foldCall locks _segmentModel — NOT
    // each call's own c.model. A mid-segment model change must not make the chart's L* jump.
    lockedModelBySeg = cache.lockedModelBySeg;
    latchBySeg = cache.latchBySeg;
    start = cache.count;
  } else {
    out = [];
    bySeg = new Map();
    lockedModelBySeg = new Map();
    latchBySeg = new Map();
    start = 0;
  }

  for (let i = start; i < w._calls.length; i++) {
    const c = w._calls[i];
    if (!bySeg.has(c.segment)) bySeg.set(c.segment, []);
    if (!lockedModelBySeg.has(c.segment)) lockedModelBySeg.set(c.segment, c.model);
    const arr = bySeg.get(c.segment); arr.push(c);
    out.push(computeHistoryPoint(w, c, arr, lockedModelBySeg.get(c.segment), fitWindow, latchBySeg));
  }

  w._historyCache = {
    points: out, count: w._calls.length, fitWindow,
    foldRev: w._foldRev, bySeg, lockedModelBySeg, latchBySeg,
  };
  // Return a shallow copy of the container, NOT the live cache array: the reuse path pushes the
  // next poll's tail onto `out`, so handing back `out` directly would let a previously-returned
  // reference grow in place — a behavior change from the old always-fresh-array getHistory. The
  // point objects are deep-immutable (all primitive fields), so sharing them is safe; only the
  // array needs isolating. Cost is an O(n) pointer copy — same order as the tail recompute,
  // negligible against the O(n²·log n) this whole change removes.
  return out.slice();
}
