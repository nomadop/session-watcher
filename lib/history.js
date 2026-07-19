// v3 (spec §3.3): a history point is now a PURE read of the folded-call record — B_at_call/g_at_call
// are computed once by Stream B (fold), so there is no per-prefix baseline recompute here. arr/fitWindow/
// latchStore are retained in the signature (getHistory's memo machinery passes them) but unused.
// eslint-disable-next-line no-unused-vars
export function computeHistoryPoint(w, c, _arr, _lockedModel, _fitWindow, _latchStore) {
  const B = Number.isFinite(c.B_at_call) ? c.B_at_call : 0;
  // x = load/baseline ratio; default 1 when baseline is unknown (B=0) so the chart stays neutral
  const x = B > 0 ? c.L / B : 1;
  return {
    ts: c.ts, segment: c.segment, L: c.L, B, x,
    g: Number.isFinite(c.g_at_call) ? c.g_at_call : 0,
    miss: c.miss === true, cacheRead: c.cacheRead, cacheCreation: c.cacheCreation,
    turnSeq: c.turnSeq, foldedSeq: c.foldedSeq,
  };
}

export function getHistory(w, fitWindowOverride) {
  const fitWindow = fitWindowOverride ?? w.fitWindow;
  // one point per folded call, cumulative L*/k recomputed per segment prefix — via the SAME
  // _baselineAndKavg pipeline getStatus uses, so the last point of the current segment matches
  // getStatus exactly (baselineSeq/knee/kAvg + empty-seq guard all inherited).
  //
  // H1 memoization. History point `i` is a PURE function of its segment's calls [0..i];
  // appending a later call never changes an earlier point. So a cached prefix is reusable ONLY when
  // ALL of these hold — any single mismatch → full rebuild (today's proven O(n²) code path):
  //   • fitWindow matches the cache's fitWindow      (retained cache-key guard: ER-2/Task 10 retired
  //                                                     the kFit chain — emitted points are now
  //                                                     fitWindow-independent, so this only forces a
  //                                                     harmless rebuild-to-identical-bytes on a window
  //                                                     switch; kept so a future per-window field can
  //                                                     re-key safely without touching this path)
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
