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

// A causal position's place on the reference skeleton `x ≈ a + d·u`: where the hero draws its dot and path, where
// the aux bar sets its markers, and what both frame the window on. The measured x reaches the chart as the dot's
// residual and the verdict's wall test alone.
export function projectedX(reference, u) {
  return reference && Number.isFinite(u) ? reference.a + reference.d * u : null;
}

// Where the point sits in the window it has widened: the span ahead of it is its own distance from the origin over
// this fraction, less that distance.
const LOCK_FRACTION = 0.75;

/**
 * The x window the hero chart and the aux bar share. It starts at `origin` — the reference's asymptote, where u = 0
 * and the segment began, so the left arm hugs the axis; the baseline itself when there is no reference — and opens
 * to √wallP. It widens once the point passes `LOCK_FRACTION` of it, to `origin + (x − origin) / LOCK_FRACTION` so the
 * point sits at that fraction; `previousDomainMax` carries the window across frames, so a retreating point leaves it
 * standing. √wallP floors the right edge rather than the span, so with an origin sitting right of it a point right of
 * that origin opens a window no wider than its own distance from the origin divided by `LOCK_FRACTION`, until the
 * ratchet carries a wider one. A `previewX` widens the visible window by the same rule for one frame without entering
 * the ratchet. The signature takes no landmark: a landmark right of the window stays clipped until the point carries
 * the window out to it.
 */
export function computeEoqViewport({ wallP, xCurrent, previousDomainMax, previewX, origin }) {
  const safeWall = Number.isFinite(wallP) && wallP > 1 ? wallP : 2;
  const min = Number.isFinite(origin) ? origin : 1;
  const locked = (x) => (Number.isFinite(x) ? min + (x - min) / LOCK_FRACTION : -Infinity);

  const carried = Number.isFinite(previousDomainMax) ? previousDomainMax : -Infinity;
  let max = Math.min(Math.max(Math.sqrt(safeWall), carried, locked(xCurrent)), safeWall);

  const actualDomainMax = max;
  max = Math.min(Math.max(max, locked(previewX)), safeWall);

  const mainDomain = { min, max };
  const overviewDomain = { min: 1, max: safeWall };

  // Linear mapping for viewport frame — clamped to [0, 100]
  const range = safeWall - 1;
  const viewportPct = {
    left: Math.max(0, Math.min(100, ((mainDomain.min - 1) / range) * 100)),
    right: Math.max(0, Math.min(100, ((mainDomain.max - 1) / range) * 100)),
  };

  // Marker position (clamped to [0, 100])
  const safeCurrent = Number.isFinite(xCurrent) ? xCurrent : 1;
  const markerPct = Math.max(0, Math.min(100, ((safeCurrent - 1) / range) * 100));

  const isPastWall = safeCurrent > safeWall;

  return { mainDomain, overviewDomain, viewportPct, markerPct, isPastWall, actualDomainMax };
}
