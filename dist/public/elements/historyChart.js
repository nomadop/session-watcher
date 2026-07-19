// public/elements/historyChart.js — Per-segment paged history chart (spec §2 #4, #10, #12)
// Renders L trajectory + projection + miss markers per segment.
// Groups flat /api/history array by segment field client-side.

import { computeYMax, buildMissMarkers, buildProjectionData, computeYRatchet, RATCHET_Y_INIT } from '../chart-helpers.js';
import { computeCrosshairLabel, computeLabelOffset } from '../lib/crosshairHelpers.js';
import { HOVER_LINE_COLOR, MAX_TOUCH_MARKERS } from '../lib/uiConstants.js';
import { computePreviewLandmarks } from './heroDiptych.js';

/** Resolve a CSS custom property to its computed value, with fallback. */
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}

// X-axis ratchet (still 2× doubling — horizontal space is less constrained)
const RATCHET_X_INIT = 100;

function nextXRatchet(current) {
  return current * 2;
}

/**
 * Group a flat history array into a Map<segmentIndex, points[]>
 */
function groupBySegment(history) {
  const map = new Map();
  for (const p of history) {
    const seg = p.segment ?? 0;
    if (!map.has(seg)) map.set(seg, []);
    map.get(seg).push(p);
  }
  return map;
}

/**
 * fitColdStart: v3's computeHistoryPoint never emits kAvg, so the original cold-start
 * backfill logic (which keyed on kAvg===0) is a permanent no-op. Return input unchanged.
 */
function fitColdStart(points) {
  return points;
}

/**
 * Pick the single "next threshold" line to display based on current L.
 * Priority: entry (green) → amber (yellow) → red (stays visible once passed).
 * Returns {value, color, label} or null.
 */
function pickThresholdLine(currentL, entryL, exitL, redL, colors) {
  if (entryL != null && currentL < entryL) {
    return { value: entryL, color: colors.mint, label: `entry ${Math.round(entryL / 1000)}k` };
  }
  if (exitL != null && currentL < exitL) {
    return { value: exitL, color: colors.amber, label: `b10 ${Math.round(exitL / 1000)}k` };
  }
  // Red line: always visible once past amber (stays as reference even when crossed)
  if (redL != null) {
    return { value: redL, color: colors.coral, label: `b25 ${Math.round(redL / 1000)}k` };
  }
  if (exitL != null) {
    return { value: exitL, color: colors.amber, label: `b10 ${Math.round(exitL / 1000)}k` };
  }
  return null;
}

/**
 * Build Chart.js configuration for a single segment
 */
function buildChartConfig(points, ratchetX, ratchetY, thresholdLine, colors) {
  // Fix #10: miss markers span the full y-axis (ratchetY), not just yMax from current data.
  // After a ratchet-up, ratchetY may exceed computeYMax — using yMax would leave markers half-height.
  // computeYMax is still used by computeRatchet (called before buildChartConfig), not needed here.
  // X labels are 1-based turn numbers
  const labels = points.map((_, i) => i + 1);
  const lData = points.map(p => p.L);
  // Amber dot at the current (last) point — matches mockup's endpoint marker
  const lPointRadius = points.map((_, i) => i === points.length - 1 ? 4 : 0);
  const lPointColor = points.map((_, i) => i === points.length - 1 ? colors.amber : 'transparent');
  // Single "next threshold" line — collapses entry/amber/red into one visible line
  const thresholdData = thresholdLine
    ? [{ x: 1, y: thresholdLine.value }, { x: ratchetX, y: thresholdLine.value }]
    : [];
  const thresholdColor = thresholdLine?.color ?? colors.amber;
  const missMarkers = buildMissMarkers(points);

  // Inline plugin: draw label for the single threshold line
  const thresholdLabelPlugin = {
    id: 'thresholdLabels',
    afterDatasetsDraw(chart) {
      const ds = chart.data.datasets[1];
      if (!ds || !ds.data || ds.data.length === 0) return;
      const last = ds.data[ds.data.length - 1];
      const val = typeof last === 'object' ? last.y : last;
      if (val == null || !Number.isFinite(val)) return;
      const yScale = chart.scales.y;
      if (val > yScale.max) return;
      const ca = chart.chartArea;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.fillStyle = ds.borderColor;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(chart._thresholdLabel ?? '', ca.right - 4, yScale.getPixelForValue(val) - 3);
      ctx.restore();
    },
  };

  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'L (tokens)',
          data: lData,
          borderColor: colors.mint,
          backgroundColor: colors.mintBg,
          borderWidth: 1.8,
          pointRadius: lPointRadius,
          pointBackgroundColor: lPointColor,
          pointBorderColor: lPointColor,
          fill: false,
          tension: 0,
        },
        {
          label: 'threshold',
          data: thresholdData,
          borderColor: thresholdColor,
          borderWidth: 1.3,
          borderDash: [4, 5],
          pointRadius: 0,
          fill: false,
          tension: 0,
          parsing: false,
          spanGaps: true,
        },
        {
          id: 'projection',
          label: 'projection',
          data: [],  // populated by mount()'s rebuildChart/updateChart
          borderColor: colors.txtDim,
          borderWidth: 1.3,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
          tension: 0,
          parsing: false,
          spanGaps: true,
        },
        {
          id: 'missMarkers',
          label: 'Cache miss',
          data: missMarkers,
          borderColor: colors.coralAlpha,
          backgroundColor: colors.coralAlpha,
          pointStyle: 'triangle',
          pointRadius: 6,
          pointBorderWidth: 0,
          showLine: false,
          fill: false,
          parsing: false,
        },
      ],
    },
    plugins: [thresholdLabelPlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: {
          type: 'linear',
          min: 1,
          max: ratchetX,
          title: { display: false },
        },
        y: {
          type: 'linear',
          min: 0,
          max: ratchetY,
          title: { display: false },
        },
      },
    },
  };
}

/**
 * mount(root, ctx) — history chart element
 */
export function mount(root, ctx) {
  // State
  let segments = new Map();      // segmentIndex → points[]
  let segmentKeys = [];          // sorted segment indices
  let currentPage = 0;           // index into segmentKeys
  let follow = true;             // auto-advance to latest segment
  let chart = null;
  let ratchetX = RATCHET_X_INIT;
  let ratchetY = RATCHET_Y_INIT;
  let entryLineL = null;         // left-arm entry line (xBrAmberL * lBase, br=-10%)
  let exitLineL = null;          // v2.1 deep-water line (L_exit_fullCarry from rateLamp, br=10%)
  let redLineL = null;           // br=25% threshold line (xBrRedR * lBase)
  // Saved copies: restored when navigating back to live segment (update() hasn't fired yet)
  let _savedEntryLineL = null;
  let _savedExitLineL = null;
  let _savedRedLineL = null;
  let lastGEma = null;           // per-call EMA growth rate (gEma from rateLamp)
  let lastCRatio = null;         // C_RATIO (cache cost ratio) from rateLamp
  let lastLRead = null;          // current L_read from rateLamp
  let lastLBase = null;          // current lBase from rateLamp
  let previewB = null;           // non-null ⇔ bucket preview active
  let hoverTouchMap = null;      // Map<localSeq, 'r'|'w'> — active during path-bucket hover for L-line coloring

  // DOM structure
  root.innerHTML = `
    <h3 class="sw-history-header">Usage history
      <span class="pager">
        <button class="sw-history-prev" disabled>‹</button>
        segment <b class="sw-history-page-num">—</b> / <span class="sw-history-page-total">—</span>
        <button class="sw-history-next" disabled>›</button>
      </span>
    </h3>
    <div class="sw-history-subtitle">Raw context tokens (L) across turns in this segment · axis auto-ranges</div>
    <div class="sw-history-container">
      <canvas class="sw-history-canvas"></canvas>
      <div class="sw-history-crosshair" style="display:none;">
        <div class="sw-crosshair-line"></div>
        <div class="sw-crosshair-label"></div>
      </div>
    </div>
    <div class="sw-history-legend">
      <span><i class="sw-legend-l"></i>L tokens</span>
      <span><i class="sw-legend-threshold"></i>next threshold</span>
      <span><i class="sw-legend-proj"></i>projection</span>
      <span><i class="sw-legend-miss"></i>cache miss</span>
    </div>
    <div class="sw-history-footnote">
      <span>calls <b class="sw-fn-calls">—</b></span>
      <span>gₑ <b class="sw-fn-g">—</b></span>
      <span>L <b class="sw-fn-l">—</b></span>
      <span>B <b class="sw-fn-base">—</b></span>
    </div>
  `;

  const canvas = root.querySelector('.sw-history-canvas');
  const crosshairEl = root.querySelector('.sw-history-crosshair');
  const crosshairLine = root.querySelector('.sw-crosshair-line');
  const crosshairLabel = root.querySelector('.sw-crosshair-label');
  const prevBtn = root.querySelector('.sw-history-prev');
  const nextBtn = root.querySelector('.sw-history-next');
  const pageNumEl = root.querySelector('.sw-history-page-num');
  const pageTotalEl = root.querySelector('.sw-history-page-total');
  const fnG = root.querySelector('.sw-fn-g');
  const fnCalls = root.querySelector('.sw-fn-calls');
  const fnL = root.querySelector('.sw-fn-l');
  const fnBase = root.querySelector('.sw-fn-base');

  // Hover line overlay — created in the chart container (relative positioned)
  const container = root.querySelector('.sw-history-container');
  const hoverLineEl = document.createElement('div');
  hoverLineEl.className = 'sw-history-hoverline';
  hoverLineEl.style.cssText = `display:none;position:absolute;top:0;height:100%;border-left:1px dashed ${HOVER_LINE_COLOR};pointer-events:none;`;
  const hoverLineTag = document.createElement('span');
  hoverLineTag.style.cssText = 'position:absolute;top:0;left:2px;font-size:9px;font-family:"JetBrains Mono",monospace;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis;color:' + HOVER_LINE_COLOR + ';';
  hoverLineEl.appendChild(hoverLineTag);
  container.appendChild(hoverLineEl);

  // Touch-marker line pool: reusable dashed lines for touchSeqs multi-marker (capped at MAX_TOUCH_MARKERS)
  const touchLinePool = [];
  function getTouchLine(index, color) {
    if (index >= touchLinePool.length) {
      const el = document.createElement('div');
      el.className = 'sw-history-touchline';
      el.style.cssText = 'display:none;position:absolute;top:0;height:100%;border-left:1px dashed;pointer-events:none;z-index:1;opacity:0.35;';
      container.appendChild(el);
      touchLinePool.push(el);
    }
    const el = touchLinePool[index];
    el.style.borderLeftColor = color;
    return el;
  }
  function hideTouchLines() {
    for (const el of touchLinePool) el.style.display = 'none';
  }

  // currentPoints ref for sw-bucket-hover handler — updated whenever chart is rebuilt/updated
  let currentPoints = [];

  // Theme colors — read once at mount, refreshed on theme switch (destroy+remount)
  const mint = cssVar(root, '--mint', '#4fe0b0');
  const amber = cssVar(root, '--amber', '#ffc24d');
  const coral = cssVar(root, '--coral', '#ff7566');
  const txtDim = cssVar(root, '--txt-dim', '#93a1ab');
  const sky = cssVar(root, '--sky', '#49c5e0');
  const colors = {
    mint,
    mintBg: mint.startsWith('#') ? mint + '0F' : 'rgba(79,224,176,0.06)',
    mintDim: mint.startsWith('#') ? mint + '22' : 'rgba(79,224,176,0.13)',
    amber,
    coral,
    coralAlpha: coral.startsWith('#') ? coral + '80' : 'rgba(255,117,102,0.5)',
    sky,
    txtDim,
  };

  // Apply theme colors to legend swatches
  root.querySelector('.sw-legend-l').style.background = mint;
  const threshSwatch = root.querySelector('.sw-legend-threshold');
  threshSwatch.style.cssText = `height:1.5px;border-top:2px dashed ${amber};background:none;width:14px;`;
  const missSwatch = root.querySelector('.sw-legend-miss');
  missSwatch.style.cssText = `width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:7px solid ${coral};background:none;border-radius:0;`;
  const projSwatch = root.querySelector('.sw-legend-proj');
  projSwatch.style.cssText = `border-top:2px dashed ${txtDim};background:none;width:14px;height:1.5px;`;

  // Navigation handlers
  const handlePrev = () => {
    if (currentPage > 0) {
      currentPage--;
      follow = (currentPage === segmentKeys.length - 1);
      rebuildChart();
    }
  };

  const handleNext = () => {
    if (currentPage < segmentKeys.length - 1) {
      currentPage++;
      follow = (currentPage === segmentKeys.length - 1);
      rebuildChart();
    }
  };

  prevBtn.addEventListener('click', handlePrev);
  nextBtn.addEventListener('click', handleNext);

  // ── Crosshair ─────────────────────────────────────────────────────────────────
  let lastSnappedTurn = null;

  function onChartMouseMove(e) {
    if (!chart) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const ca = chart.chartArea;
    if (!ca || mouseX < ca.left || mouseX > ca.right) {
      crosshairEl.style.display = 'none';
      lastSnappedTurn = null;
      return;
    }

    const xValue = chart.scales.x.getValueForPixel(mouseX);
    const snappedTurn = Math.max(1, Math.round(xValue));

    // Only update DOM when snapped index changes (avoid thrashing on sub-pixel moves)
    if (snappedTurn === lastSnappedTurn) return;
    lastSnappedTurn = snappedTurn;

    // Get data for label
    const currentPoints = segmentKeys.length > 0 ? (segments.get(segmentKeys[currentPage]) || []) : [];
    const labelText = computeCrosshairLabel(snappedTurn, currentPoints, lastGEma);

    if (labelText === null) {
      crosshairEl.style.display = 'none';
      return;
    }

    // Make visible before measuring offsetWidth (hidden element returns 0)
    crosshairEl.style.display = '';

    // Position line — getPixelForValue returns canvas-local coords (already includes ca.left offset).
    // The overlay shares the same parent as canvas, so pixel values map directly.
    const pixelX = chart.scales.x.getPixelForValue(snappedTurn);
    crosshairLine.style.left = `${pixelX}px`;
    crosshairLine.style.top = `${ca.top}px`;
    crosshairLine.style.height = `${ca.bottom - ca.top}px`;

    // Position label (flip if near right edge)
    crosshairLabel.textContent = labelText;
    const labelOffset = computeLabelOffset(pixelX, ca.right, crosshairLabel.offsetWidth);
    crosshairLabel.style.left = `${pixelX + labelOffset}px`;

    // Snap label y to data point
    const lastDataTurn = currentPoints.length;
    let yPx;
    if (snappedTurn <= lastDataTurn && currentPoints[snappedTurn - 1]) {
      yPx = chart.scales.y.getPixelForValue(currentPoints[snappedTurn - 1].L);
    } else {
      const slope = (lastGEma > 0) ? lastGEma : (currentPoints[lastDataTurn - 1]?.g || 0);
      const lastL = currentPoints[lastDataTurn - 1]?.L || 0;
      yPx = chart.scales.y.getPixelForValue(lastL + slope * (snappedTurn - lastDataTurn));
    }
    const clampedY = Math.max(ca.top, Math.min(ca.bottom - 20, yPx - 10));
    crosshairLabel.style.top = `${clampedY}px`;

    // Show white dot at snapped turn via chart point arrays
    const ds0 = chart.data.datasets[0];
    const prevHighlight = ds0._crosshairIdx;
    const idx = snappedTurn - 1; // 0-based index into pointRadius/Color arrays
    const isDataPoint = idx >= 0 && idx < lastDataTurn;
    const isCurrent = idx === lastDataTurn - 1;

    // Restore previous highlight
    if (prevHighlight != null && prevHighlight !== idx) {
      ds0.pointRadius[prevHighlight] = prevHighlight === lastDataTurn - 1 ? 4 : 0;
      ds0.pointBackgroundColor[prevHighlight] = prevHighlight === lastDataTurn - 1 ? colors.amber : 'transparent';
    }

    // Apply white dot at snapped index (or turn current amber to white)
    if (isDataPoint) {
      ds0.pointRadius[idx] = 4;
      ds0.pointBackgroundColor[idx] = '#ffffff';
      ds0._crosshairIdx = idx;
      chart.update('none');
    } else {
      ds0._crosshairIdx = null;
      if (prevHighlight != null) chart.update('none');
    }
  }

  function onChartMouseLeave() {
    crosshairEl.style.display = 'none';
    lastSnappedTurn = null;
    // Restore crosshair-highlighted point
    if (chart) {
      const ds0 = chart.data.datasets[0];
      const idx = ds0._crosshairIdx;
      if (idx != null) {
        const lastDataTurn = ds0.pointRadius?.length || 0;
        ds0.pointRadius[idx] = idx === lastDataTurn - 1 ? 4 : 0;
        ds0.pointBackgroundColor[idx] = idx === lastDataTurn - 1 ? colors.amber : 'transparent';
        ds0._crosshairIdx = null;
        chart.update('none');
      }
    }
  }

  canvas.addEventListener('mousemove', onChartMouseMove);
  canvas.addEventListener('mouseleave', onChartMouseLeave);
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Bucket hover linkage line (§10.2) ────────────────────────────────────────
  function onBucketHover(e) {
    const { lastCallSeq, name, touchSeqs, tier, group } = e.detail || {};
    if (lastCallSeq == null || !chart) {
      hoverLineEl.style.display = 'none';
      hideTouchLines();
      if (hoverTouchMap) { hoverTouchMap = null; chart?.update('none'); }
      return;
    }
    // lastCallSeq is a global foldedCallSeq that never resets at segment boundaries.
    // The chart x-axis uses segment-local 1-based indices. Convert by subtracting
    // the offset of this segment's first point in the global sequence.
    const segOffset = currentPoints.length > 0
      ? (currentPoints[0].foldedSeq ?? 1) - 1
      : 0;
    const localSeq = lastCallSeq - segOffset;

    // Primary hover line (last call seq)
    if (localSeq >= 1 && localSeq <= currentPoints.length) {
      const px = chart.scales.x.getPixelForValue(localSeq);
      const ca = chart.chartArea;
      hoverLineEl.style.display = '';
      hoverLineEl.style.left = `${px}px`;
      hoverLineEl.style.top = `${ca.top}px`;
      hoverLineEl.style.height = `${ca.bottom - ca.top}px`;
      const truncated = touchSeqs && touchSeqs.length > MAX_TOUCH_MARKERS;
      const baseName = name ? name.split('/').pop() || name : '';
      hoverLineTag.textContent = truncated ? `${baseName} (last ${MAX_TOUCH_MARKERS})` : baseName;
    } else {
      hoverLineEl.style.display = 'none';
    }

    // Tool buckets (output group): show dashed vertical lines at each touchSeq position.
    // Path buckets: use L-line segment coloring instead (dimmed non-touched segments).
    hideTouchLines();
    if (group === 'output' && touchSeqs && touchSeqs.length > 0 && chart) {
      const shown = touchSeqs.slice(-MAX_TOUCH_MARKERS);
      const tierColor = tier === 'coral' ? colors.coral : tier === 'amber' ? colors.amber : colors.mint;
      const ca = chart.chartArea;
      let lineIdx = 0;
      for (const entry of shown) {
        const seq = typeof entry === 'number' ? entry : entry.seq;
        const local = seq - segOffset;
        if (local < 1 || local > currentPoints.length) continue;
        const px = chart.scales.x.getPixelForValue(local);
        const el = getTouchLine(lineIdx++, tierColor);
        el.style.display = '';
        el.style.left = `${px}px`;
        el.style.top = `${ca.top}px`;
        el.style.height = `${ca.bottom - ca.top}px`;
      }
      // No L-line coloring for tool buckets
      if (hoverTouchMap) { hoverTouchMap = null; chart.update('none'); }
    } else {
      // Path buckets: L-line segment coloring
      const newMap = new Map();
      if (touchSeqs && touchSeqs.length > 0) {
        for (const entry of touchSeqs) {
          const seq = typeof entry === 'number' ? entry : entry.seq;
          const mode = typeof entry === 'object' ? entry.mode : null;
          const local = seq - segOffset;
          if (local >= 1 && local <= currentPoints.length) {
            if (mode === 'w' || !newMap.has(local)) newMap.set(local, mode);
          }
        }
      }
      hoverTouchMap = newMap.size > 0 ? newMap : null;
      chart.update('none');
    }
  }

  document.addEventListener('sw-bucket-hover', onBucketHover);
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Bucket preview → threshold line update (§10.3) ───────────────────────────
  /** Recompute threshold lines from stored previewB + latest g/R/L. */
  function applyPreviewThresholds() {
    if (!previewB || lastCRatio == null || lastGEma == null || lastLRead == null) return;
    const prev = computePreviewLandmarks({
      B_preview: previewB, R: lastCRatio, g: lastGEma, L: lastLRead, mf: null,
    });
    entryLineL = prev.xAmberL * previewB;
    exitLineL = prev.xAmberR * previewB;
    redLineL = prev.xRedR * previewB;
  }

  function onBucketPreview(e) {
    const detail = e.detail ?? null;
    const dirty = detail?.dirty;
    const B_preview = detail?.B_preview;

    // Preview thresholds only apply on the live segment — historical segments have no threshold lines.
    if (!follow) return;

    if (dirty && B_preview > 0 && lastCRatio != null && lastGEma != null && lastLRead != null) {
      previewB = B_preview;
      applyPreviewThresholds();
    } else if (!dirty && previewB) {
      previewB = null;
      // Revert: recompute from actual state
      if (lastLBase > 0 && lastCRatio != null && lastGEma != null && lastLRead != null) {
        const actual = computePreviewLandmarks({
          B_preview: lastLBase, R: lastCRatio, g: lastGEma, L: lastLRead, mf: null,
        });
        entryLineL = actual.xAmberL * lastLBase;
        exitLineL = actual.xAmberR * lastLBase;
        redLineL = actual.xRedR * lastLBase;
      }
    } else {
      return; // no change needed
    }

    // Redraw threshold line immediately
    if (!chart) return;
    const currentL = currentPoints.length > 0 ? currentPoints[currentPoints.length - 1]?.L ?? 0 : 0;
    const tLine = pickThresholdLine(currentL, entryLineL, exitLineL, redLineL, colors);
    const thresholdData = tLine
      ? [{ x: 1, y: tLine.value }, { x: ratchetX, y: tLine.value }]
      : [];
    chart.data.datasets[1].data = thresholdData;
    chart.data.datasets[1].borderColor = tLine?.color ?? colors.amber;
    chart._thresholdLabel = tLine?.label ?? '';
    chart.update('none');
  }

  document.addEventListener('sw-bucket-preview', onBucketPreview);
  // ─────────────────────────────────────────────────────────────────────────────

  function updateControls() {
    const total = segmentKeys.length;
    prevBtn.disabled = currentPage <= 0;
    nextBtn.disabled = currentPage >= total - 1;
    if (total > 0) {
      pageNumEl.textContent = currentPage + 1;
      pageTotalEl.textContent = total;
    } else {
      pageNumEl.textContent = '—';
      pageTotalEl.textContent = '—';
    }
  }

  function updateFootnote(points) {
    if (!points || points.length === 0) {
      fnG.textContent = '—';
      fnCalls.textContent = '—';
      fnL.textContent = '—';
      fnBase.textContent = '—';
      return;
    }
    const last = points[points.length - 1];
    const gVal = (lastGEma >= 1) ? lastGEma : last?.g;
    fnG.textContent = gVal != null ? Math.round(gVal).toLocaleString() : '—';
    fnCalls.textContent = points.length;
    fnL.textContent = lastLRead != null ? `${Math.round(lastLRead / 1000)}k` : '—';
    fnBase.textContent = lastLBase != null ? `${Math.round(lastLBase / 1000)}k` : '—';
  }

  function computeRatchet(points) {
    // Y ratchet: 80% trigger, 1.5× step (imported from chart-helpers)
    const yMax = computeYMax(points);
    ratchetY = computeYRatchet(ratchetY, yMax);
    // X ratchet: only grow
    const xMax = points.length;
    while (ratchetX < xMax) {
      ratchetX = nextXRatchet(ratchetX);
    }
  }

  function rebuildChart() {
    // Destroy existing chart (spec §5.7: cross-segment = destroy + rebuild)
    if (chart) {
      chart.destroy();
      chart = null;
    }
    hoverTouchMap = null; // clear stale L-line coloring from previous segment
    // Reset ratchets on segment change; clear thresholds only when paging to a
    // historical segment (follow=false) — on the live segment, update() has
    // already set them from the current rateLamp before calling rebuildChart().
    ratchetX = RATCHET_X_INIT;
    ratchetY = RATCHET_Y_INIT;
    if (!follow) {
      entryLineL = null;
      exitLineL = null;
      redLineL = null;
      previewB = null; // clear stale preview so update() won't re-apply thresholds
    } else {
      // Returning to live segment via navigation: restore thresholds from last snapshot
      // (they were nulled when we paged away; update() hasn't fired yet to repopulate).
      entryLineL = _savedEntryLineL;
      exitLineL = _savedExitLineL;
      redLineL = _savedRedLineL;
    }

    const raw = segmentKeys.length > 0 ? (segments.get(segmentKeys[currentPage]) || []) : [];
    const points = fitColdStart(raw);
    currentPoints = points;
    if (points.length === 0) {
      updateControls();
      updateFootnote(points);
      return;
    }

    computeRatchet(points);
    const currentL = points[points.length - 1]?.L ?? 0;
    const tLine = pickThresholdLine(currentL, entryLineL, exitLineL, redLineL, colors);
    const config = buildChartConfig(points, ratchetX, ratchetY, tLine, colors);
    chart = new Chart(canvas, config);
    chart._thresholdLabel = tLine?.label ?? '';

    // L-line segment coloring: when a path bucket is hovered, dim non-touched segments
    // so that only the touched positions stand out (read=sky, write=amber, rest=dimmed).
    chart.data.datasets[0].segment = {
      borderColor: (ctx) => {
        if (!hoverTouchMap) return colors.mint;
        const mode = hoverTouchMap.get(ctx.p1DataIndex + 1);
        if (mode === 'w') return colors.amber;
        if (mode === 'r') return colors.sky;
        return colors.mintDim;
      },
    };

    // Inject projection data (needs closure vars not available in buildChartConfig)
    const projDs = chart.data.datasets.find(d => d.id === 'projection');
    if (projDs) {
      projDs.data = buildProjectionData(points, lastGEma, ratchetX, ratchetY);
      chart.options.scales.x.max = Math.max(ratchetX, projDs.data?.[1]?.x ?? 0);
      chart.update('none');
    }

    // Expose chart instance for e2e
    if (window.__SW_dashboard) window.__SW_dashboard.charts.history = chart;

    updateControls();
    updateFootnote(points);
    lastSnappedTurn = null;
  }

  function updateChart(points) {
    if (!chart || !points || points.length === 0) return;

    // Ratchet axes (only grow within page)
    const prevRX = ratchetX;
    const prevRY = ratchetY;
    computeRatchet(points);

    // Fix #10: use ratchetY (actual axis height) for miss markers, not computeYMax (current data height).
    // After a ratchet-up ratchetY may exceed the data max — markers must span the full visible axis.
    const labels = points.map((_, i) => i + 1);
    const lData = points.map(p => p.L);
    const lPointRadius = points.map((_, i) => i === points.length - 1 ? 4 : 0);
    const lPointColor = points.map((_, i) => i === points.length - 1 ? colors.amber : 'transparent');
    // Single "next threshold" line
    const currentL = points[points.length - 1]?.L ?? 0;
    const tLine = pickThresholdLine(currentL, entryLineL, exitLineL, redLineL, colors);
    const thresholdData = tLine
      ? [{ x: 1, y: tLine.value }, { x: ratchetX, y: tLine.value }]
      : [];
    const missMarkers = buildMissMarkers(points);

    chart.data.labels = labels;
    chart.data.datasets[0].data = lData;
    chart.data.datasets[0].pointRadius = lPointRadius;
    chart.data.datasets[0].pointBackgroundColor = lPointColor;
    chart.data.datasets[0].pointBorderColor = lPointColor;
    // Re-apply crosshair highlight if active
    const hiIdx = chart.data.datasets[0]._crosshairIdx;
    if (hiIdx != null && hiIdx < lPointRadius.length) {
      lPointRadius[hiIdx] = 4;
      lPointColor[hiIdx] = '#ffffff';
    }
    chart.data.datasets[1].data = thresholdData;
    chart.data.datasets[1].borderColor = tLine?.color ?? colors.amber;
    chart._thresholdLabel = tLine?.label ?? '';

    // Projection (id-based lookup)
    const projDs = chart.data.datasets.find(d => d.id === 'projection');
    if (projDs) {
      projDs.data = buildProjectionData(points, lastGEma, ratchetX, ratchetY);
    }

    const missDs = chart.data.datasets.find(d => d.id === 'missMarkers');
    if (missDs) missDs.data = missMarkers;

    // x-axis max: max(ratchetX, projection endpoint) — shrinks back when projection disappears
    const projEndX = projDs?.data?.[1]?.x ?? 0;
    chart.options.scales.x.max = Math.max(ratchetX, projEndX);
    if (ratchetY !== prevRY) chart.options.scales.y.max = ratchetY;

    currentPoints = points;
    chart.update('none'); // spec §5.7: same-segment = update('none')
    updateControls();
    updateFootnote(points);
  }

  function update(snapshot) {
    const rl = snapshot?.status?.rateLamp;
    // Threshold lines: during preview, recompute from previewB + latest inputs;
    // otherwise use server-provided landmarks directly.
    if (previewB) {
      applyPreviewThresholds();
    } else {
      // Always compute and cache threshold values from the latest rateLamp snapshot.
      if (rl?.xBrAmberL != null && Number.isFinite(rl.xBrAmberL) && rl?.lBase > 0) {
        _savedEntryLineL = rl.xBrAmberL * rl.lBase;
      }
      if (rl?.xBrAmberR != null && Number.isFinite(rl.xBrAmberR) && rl?.lBase > 0) {
        _savedExitLineL = rl.xBrAmberR * rl.lBase;
      } else if (rl?.L_exit_fullCarry != null && Number.isFinite(rl.L_exit_fullCarry)) {
        _savedExitLineL = rl.L_exit_fullCarry;
      }
      if (rl?.xBrRedR != null && Number.isFinite(rl.xBrRedR) && rl?.lBase > 0) {
        _savedRedLineL = rl.xBrRedR * rl.lBase;
      }
      // Only apply to the active render vars when on the live segment.
      // Historical segments must not show live threshold lines.
      if (follow) {
        entryLineL = _savedEntryLineL;
        exitLineL = _savedExitLineL;
        redLineL = _savedRedLineL;
      }
    }
    if (rl?.gEma != null && Number.isFinite(rl.gEma)) {
      lastGEma = rl.gEma;
    }
    if (rl?.C_RATIO != null && Number.isFinite(rl.C_RATIO)) lastCRatio = rl.C_RATIO;
    if (rl?.L_read != null && Number.isFinite(rl.L_read)) lastLRead = rl.L_read;
    if (rl?.lBase != null && Number.isFinite(rl.lBase)) lastLBase = rl.lBase;
    const history = snapshot.history || [];
    const newSegments = groupBySegment(history);
    const newKeys = Array.from(newSegments.keys()).sort((a, b) => a - b);

    // Detect if segments changed structurally
    const keysChanged = newKeys.length !== segmentKeys.length ||
      newKeys.some((k, i) => k !== segmentKeys[i]);

    segments = newSegments;
    segmentKeys = newKeys;

    if (segmentKeys.length === 0) {
      if (chart) { chart.destroy(); chart = null; }
      updateControls();
      updateFootnote([]);
      return;
    }

    // Follow-current logic
    if (follow || keysChanged) {
      const latestPage = segmentKeys.length - 1;
      if (follow) {
        if (currentPage !== latestPage) {
          currentPage = latestPage;
          rebuildChart();
          return;
        }
      } else if (keysChanged) {
        // Clamp currentPage if segments were removed
        if (currentPage >= segmentKeys.length) {
          currentPage = segmentKeys.length - 1;
          follow = true;
          rebuildChart();
          return;
        }
      }
    }

    const points = fitColdStart(segments.get(segmentKeys[currentPage]) || []);

    // If no chart yet, build it
    if (!chart) {
      rebuildChart();
      return;
    }

    // Same-segment update
    updateChart(points);
  }

  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
    prevBtn.removeEventListener('click', handlePrev);
    nextBtn.removeEventListener('click', handleNext);
    canvas.removeEventListener('mousemove', onChartMouseMove);
    canvas.removeEventListener('mouseleave', onChartMouseLeave);
    document.removeEventListener('sw-bucket-hover', onBucketHover);
    document.removeEventListener('sw-bucket-preview', onBucketPreview);
    root.innerHTML = '';
  }

  return { update, destroy };
}
