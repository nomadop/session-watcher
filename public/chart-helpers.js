// Pure helpers for the decision chart's cache-miss markers. No DOM / Chart.js dependency, so they run
// under `node --test` as well as in the browser (public/ is served statically → index.html imports).

// Max over the PRIMARY decision y-series — effective-L and Lthreshold — floored at 1 (GPT final-review
// #4: the promise is deliberately scoped to these two, not "every visible series"). The extrapolation
// line (dataset 2) runs between s.L and Lthreshold so it never exceeds this max. The aux LstarFit line
// (dataset 3) CAN exceed it, but it is a per-status scalar (not in `hist`) and is hidden by default —
// opt-in via the 辅助 L* checkbox. So the red miss line spans the full plot in the default view; only
// when a user toggles the aux line on AND it sits above Lthreshold is the marker slightly short — a
// cosmetic, opt-in edge, accepted. A for-loop — NEVER Math.max(...arr) — because a spread over a
// multi-thousand-point history overflows the JS argument limit and throws RangeError (gemini review).
export function computeYMax(hist) {
  let yMax = 1;
  for (const p of hist) {
    // ER-5: server already resolved effectiveL into p.L; client must not re-derive the miss rule.
    const eL = Number.isFinite(p.L) ? p.L : 0;
    if (eL > yMax) yMax = eL;
    const lt = p.Lthreshold ?? 0;
    if (lt > yMax) yMax = lt;
  }
  return yMax;
}

// R5-1: sticky deep-water latch for the dashboard lamp (spec §10.9). DISPLAY ONLY: never gates settlement.
// Body duplicated from lib/deep-water-display.js (the server's SSOT) so this browser-served file has no
// cross-directory import that breaks static serving. Keep in sync manually; the server module is authoritative.
export function deepWaterDisplay(prevLatched, { L_read, L_exit_fullCarry, cRatio, B_rebuild }) {
  if (!(L_exit_fullCarry > 0) || !Number.isFinite(L_read)) return false;
  const hyst = Math.max(2048, 0.02 * cRatio * B_rebuild);
  if (prevLatched) return L_read >= L_exit_fullCarry - hyst;
  return L_read >= L_exit_fullCarry;
}

// Projection line helper (spec §6.1): compute two endpoints from last data point extending at slope.
// Pure function — closure vars (lastGEma) passed explicitly so this can run under node --test.
// Returns [] when no meaningful projection can be drawn (empty points or zero slope).
export function buildProjectionData(points, lastGEma, currentRatchetX, currentRatchetY) {
  if (points.length === 0) return [];
  const slope = (lastGEma > 0) ? lastGEma : (points[points.length - 1]?.kAvg > 0 ? points[points.length - 1].kAvg : 0);
  if (slope <= 0) return [];

  const lastTurn = points.length;
  const lastL = points[points.length - 1].L;

  // Ensure projection has visible length (spec §6.1 edge case)
  let effectiveRatchetX = currentRatchetX;
  if (effectiveRatchetX - lastTurn < 5) {
    effectiveRatchetX = lastTurn + 20;
  }

  const projectedY = lastL + slope * (effectiveRatchetX - lastTurn);
  const clampedY = Math.min(projectedY, currentRatchetY);

  // When Y is clamped, shorten X to the true intercept so the visual slope stays accurate
  const endX = (clampedY < projectedY)
    ? lastTurn + (clampedY - lastL) / slope
    : effectiveRatchetX;

  return [
    { x: lastTurn, y: lastL },
    { x: endX, y: clampedY },
  ];
}

// Three points per miss row: bottom (y:0), top (y:yMax), and a null separator so Chart.js does NOT
// connect one vertical's top to the next vertical's bottom (a slanted line). Every point carries
// historyIndex so the tooltip can map a marker point (whose dataIndex is the marker-array position,
// 3× the history index) back to the source history row.
export function buildMissMarkers(hist, yMax) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    // Fix #2: x-axis is 1-based (min:1, labels are turn numbers), so offset by +1 to align markers
    if (hist[i].miss) out.push({ x: i + 1, y: 0, historyIndex: i }, { x: i + 1, y: yMax, historyIndex: i }, { x: i + 1, y: null, historyIndex: i });
  }
  return out;
}
