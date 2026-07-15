// Pure helpers for the decision chart's cache-miss markers. No DOM / Chart.js dependency, so they run
// under `node --test` as well as in the browser (public/ is served statically → index.html imports).

// Max over the PRIMARY decision y-series — effective-L only — floored at 1.
// Lthreshold is excluded: on large R it dwarfs actual L data and flattens the line;
// the exit threshold line is allowed to clip at the chart top. A for-loop — NEVER
// Math.max(...arr) — because a spread over a
// multi-thousand-point history overflows the JS argument limit and throws RangeError (gemini review).
export function computeYMax(hist) {
  let yMax = 1;
  for (const p of hist) {
    // ER-5: server already resolved effectiveL into p.L; client must not re-derive the miss rule.
    const eL = Number.isFinite(p.L) ? p.L : 0;
    if (eL > yMax) yMax = eL;
    // Lthreshold excluded from Y-axis sizing — on large R it dwarfs actual L data,
    // flattening the line. The exit threshold line is allowed to clip at chart top.
  }
  return yMax;
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
