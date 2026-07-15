// public/lib/xScale.js — single truth source for x→position mapping

export function computeLandmarkPositions({ domain, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP, x }) {
  const { minX, maxX } = domain;
  const range = maxX - minX;
  if (range <= 0) return { markerPct: 0, brAmberLPct: 0, sweetPct: 0, brAmberRPct: 0, brRedRPct: 0, wallPct: 100, gradientStops: [], clamped: true, overflow: 'left' };
  const toPct = (v) => Math.max(0, Math.min(100, ((v - minX) / range) * 100));
  const safeX = Number.isFinite(x) ? x : 0;
  let markerPct, clamped = false, overflow = 'none';
  if (safeX < minX) { markerPct = 0; clamped = true; overflow = 'left'; }
  else if (safeX > maxX) { markerPct = 100; clamped = true; overflow = 'right'; }
  else { markerPct = toPct(safeX); }
  const brAmberLPct = Number.isFinite(xBrAmberL) ? toPct(xBrAmberL) : 0;
  const sweetPct = toPct(xSweet);
  const brAmberRPct = toPct(xBrAmberR);
  const brRedRPct = Number.isFinite(xBrRedR) ? toPct(xBrRedR) : toPct(wallP);
  const wallPct = toPct(wallP);
  const gradientStops = [
    { pct: 0, color: 'var(--zone-shallow)' }, { pct: brAmberLPct, color: 'var(--zone-entry)' },
    { pct: sweetPct, color: 'var(--zone-sweet)' }, { pct: brRedRPct, color: 'var(--zone-deep)' },
    { pct: wallPct, color: 'var(--zone-wall)' },
  ];
  return { markerPct, brAmberLPct, sweetPct, brAmberRPct, brRedRPct, wallPct, gradientStops, clamped, overflow };
}

export function validateLandmarks({ xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP }) {
  for (const v of [xSweet, xBrAmberR, wallP]) {
    if (!Number.isFinite(v)) return { ok: false, reason: 'landmark contains NaN or Infinity' };
  }
  // xBrAmberL can be NaN when mf is very low (disc < 0); optional
  if (!(xSweet <= xBrAmberR && xBrAmberR <= wallP))
    return { ok: false, reason: 'landmarks not monotonic' };
  if (Number.isFinite(xBrRedR) && xBrRedR < xBrAmberR)
    return { ok: false, reason: 'xBrRedR < xBrAmberR' };
  return { ok: true, reason: null };
}

/**
 * Unified EOQ viewport computation (spec §11).
 * Single source of truth for main chart domain, overview positions, viewport frame.
 */
export function computeEoqViewport({ xBrAmberR, xSweet, xBrRedR, wallP, xCurrent, previousDomainMax }) {
  // NaN/undefined guard — all numeric inputs sanitized to safe defaults
  const safeWall = Number.isFinite(wallP) && wallP > 1 ? wallP : 2;
  const safeAmberR = Number.isFinite(xBrAmberR) ? xBrAmberR : 1;
  const safeRedR = Number.isFinite(xBrRedR) ? xBrRedR : safeAmberR;
  const safeCurrent = Number.isFinite(xCurrent) ? xCurrent : 1;

  // Main domain: start from 1 so marker is always inside the viewport
  let min = 1;
  const rawMax = Math.max(safeRedR, safeCurrent) * 1.2;
  let max = Math.min(safeWall, rawMax);

  // Ratchet: only expand within same segment
  if (previousDomainMax != null && Number.isFinite(previousDomainMax)) {
    max = Math.max(previousDomainMax, max);
  }

  // Clamp max to wallP (ratchet could exceed if previousDomainMax was set before wallP shrank)
  max = Math.min(max, safeWall);

  // Minimum span guard (spec §11.3) — also must not exceed wallP
  if (max - min < 0.3) {
    max = Math.min(min + 0.3, safeWall);
    // If still too narrow (wall is very close to 1), widen min downward
    if (max - min < 0.3) min = Math.max(1, max - 0.3);
  }

  const mainDomain = { min, max };
  const overviewDomain = { min: 1, max: safeWall };

  // Linear mapping for viewport frame (spec §11.2) — clamped to [0, 100]
  const range = safeWall - 1;
  const viewportPct = {
    left: Math.max(0, Math.min(100, ((mainDomain.min - 1) / range) * 100)),
    right: Math.max(0, Math.min(100, ((mainDomain.max - 1) / range) * 100)),
  };

  // Marker position (clamped to [0, 100])
  const rawMarkerPct = ((safeCurrent - 1) / range) * 100;
  const markerPct = Math.max(0, Math.min(100, rawMarkerPct));

  const isPastWall = safeCurrent > safeWall;

  return { mainDomain, overviewDomain, viewportPct, markerPct, isPastWall };
}
