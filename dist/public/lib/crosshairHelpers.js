// public/lib/crosshairHelpers.js — Pure helper functions for the history chart DOM crosshair.
// No DOM / Chart.js dependency — safe to import in node --test and in the browser.

/**
 * Compute the crosshair label text for a given snapped turn.
 *
 * @param {number} snappedTurn  - 1-based integer turn under the cursor
 * @param {Array}  currentPoints - data points for the visible segment ({ L, kAvg, ... }[])
 * @param {number|null} lastGEma - per-call EMA growth rate (tokens/call); null or <= 0 triggers kAvg fallback
 * @returns {string|null} label text, or null when no label can be shown
 */
export function computeCrosshairLabel(snappedTurn, currentPoints, lastGEma) {
  const lastDataTurn = currentPoints.length;

  if (snappedTurn <= lastDataTurn && currentPoints[snappedTurn - 1]) {
    const l = currentPoints[snappedTurn - 1].L;
    return `turn ${snappedTurn} · L=${Math.round(l / 1000)}k`;
  }

  // Projection region
  if (lastDataTurn === 0) return null;

  const slope = (lastGEma > 0)
    ? lastGEma
    : (currentPoints[lastDataTurn - 1]?.kAvg > 0 ? currentPoints[lastDataTurn - 1].kAvg : 0);

  if (slope <= 0) return null;

  const lastL = currentPoints[lastDataTurn - 1].L;
  const projL = lastL + slope * (snappedTurn - lastDataTurn);
  return `projected L=${Math.round(projL / 1000)}k`;
}

/**
 * Compute the horizontal offset (px) for the crosshair label so it doesn't overflow the right edge.
 *
 * @param {number} pixelX      - x pixel of the crosshair line (canvas-local)
 * @param {number} caRight     - chart.chartArea.right pixel
 * @param {number} labelWidth  - offsetWidth of the label element
 * @returns {number} pixel offset to add to pixelX for label placement
 */
export function computeLabelOffset(pixelX, caRight, labelWidth) {
  const fromRight = caRight - pixelX;
  return (fromRight < 80) ? -(labelWidth + 6) : 6;
}
