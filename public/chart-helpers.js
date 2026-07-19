// Pure helpers for the decision chart's cache-miss markers. No DOM / Chart.js dependency, so they run
// under `node --test` as well as in the browser (public/ is served statically → index.html imports).

// Y-axis ratchet constants (spec §2 #10)
export const RATCHET_Y_INIT = 200000;
export const RATCHET_Y_CAP = 1000000;

// Compute the next Y ratchet ceiling given current ceiling and data max.
// Triggers when yMax > 80% of current ceiling; steps by 1.5×.
// Monotonically increasing (never shrinks). Capped at RATCHET_Y_CAP.
export function computeYRatchet(currentRatchetY, yMax) {
  let r = currentRatchetY;
  while (r < RATCHET_Y_CAP && yMax > r * 0.8) {
    r = Math.min(Math.ceil(r * 1.5), RATCHET_Y_CAP);
  }
  return r;
}

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
  const slope = (lastGEma > 0) ? lastGEma : (points[points.length - 1]?.g > 0 ? points[points.length - 1].g : 0);
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

// Bill-regret at a preview position: br = mf*(u-1)^2/(2u) where u = (x-1)/dhat.
// Guards u<=0 (undefined/degenerate) by returning 0, matching the call-site behaviour in
// both heroDiptych and depthAux before this was extracted.
export function computePreviewBr(mf, u) {
  if (u <= 0) return 0;
  return mf * (u - 1) * (u - 1) / (2 * u);
}

// §10.4 miss-marker demotion: small triangles at x-axis (6px), semi-transparent.
// One point per miss at y=0 — rendered as triangle pointStyle by the dataset config.
// Each point carries historyIndex so the tooltip can map back to the source history row.
export function buildMissMarkers(hist) {
  const out = [];
  for (let i = 0; i < hist.length; i++) {
    if (hist[i].miss) out.push({ x: i + 1, y: 0, historyIndex: i });
  }
  return out;
}
