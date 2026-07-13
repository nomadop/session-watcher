// public/lib/xScale.js — single truth source for x→position mapping

export function computeLandmarkPositions({ domain, xEntry, xSweet, xExit, wallP, x }) {
  const { minX, maxX } = domain;
  const range = maxX - minX;
  if (range <= 0) return { markerPct: 0, entryPct: 0, sweetPct: 0, exitPct: 0, wallPct: 100, gradientStops: [], clamped: true, overflow: 'left' };
  const toPct = (v) => Math.max(0, Math.min(100, ((v - minX) / range) * 100));
  const safeX = Number.isFinite(x) ? x : 0;
  let markerPct, clamped = false, overflow = 'none';
  if (safeX < minX) { markerPct = 0; clamped = true; overflow = 'left'; }
  else if (safeX > maxX) { markerPct = 100; clamped = true; overflow = 'right'; }
  else { markerPct = toPct(safeX); }
  const entryPct = toPct(xEntry), sweetPct = toPct(xSweet), exitPct = toPct(xExit), wallPct = toPct(wallP);
  const gradientStops = [
    { pct: 0, color: 'var(--zone-shallow)' }, { pct: entryPct, color: 'var(--zone-entry)' },
    { pct: sweetPct, color: 'var(--zone-sweet)' }, { pct: exitPct, color: 'var(--zone-deep)' },
    { pct: wallPct, color: 'var(--zone-wall)' },
  ];
  return { markerPct, entryPct, sweetPct, exitPct, wallPct, gradientStops, clamped, overflow };
}

export function validateLandmarks({ xEntry, xSweet, xExit, wallP }) {
  for (const v of [xEntry, xSweet, xExit, wallP]) {
    if (!Number.isFinite(v)) return { ok: false, reason: 'landmark contains NaN or Infinity' };
  }
  if (!(xEntry <= xSweet && xSweet <= xExit && xExit <= wallP))
    return { ok: false, reason: 'landmarks not monotonic' };
  return { ok: true, reason: null };
}

/**
 * Unified EOQ viewport computation (spec §11).
 * Single source of truth for main chart domain, overview positions, viewport frame.
 */
export function computeEoqViewport({ xEntry, xSweet, xExit, wallP, xCurrent, previousDomainMax }) {
  // NaN/undefined guard — all numeric inputs sanitized to safe defaults
  const safeWall = Number.isFinite(wallP) && wallP > 1 ? wallP : 2;
  const safeEntry = Number.isFinite(xEntry) ? xEntry : 1;
  const safeExit = Number.isFinite(xExit) ? xExit : safeEntry;
  const safeCurrent = Number.isFinite(xCurrent) ? xCurrent : 1;

  // Main domain: focused around landmarks
  let min = Math.max(1, safeEntry * 0.85);
  const rawMax = Math.max(safeExit, safeCurrent) * 1.2;
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
