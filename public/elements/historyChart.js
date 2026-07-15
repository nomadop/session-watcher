// public/elements/historyChart.js — Per-segment paged history chart (spec §2 #4, #10, #12)
// Renders L trajectory + L* exit line + miss markers per segment.
// Groups flat /api/history array by segment field client-side.

import { computeYMax, buildMissMarkers, buildProjectionData } from '../chart-helpers.js';
import { computeCrosshairLabel, computeLabelOffset } from '../lib/crosshairHelpers.js';

/** Resolve a CSS custom property to its computed value, with fallback. */
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}

// Ratchet defaults (spec §2 #10)
const RATCHET_Y_INIT = 200000;
const RATCHET_Y_CAP = 1000000;
const RATCHET_X_INIT = 100;

function nextYRatchet(current) {
  const next = current * 2;
  return next > RATCHET_Y_CAP ? RATCHET_Y_CAP : next;
}

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
 * Fit cold-start points (kAvg=0, baseline not yet latched) at the start of a segment.
 * Instead of showing the raw L=0→baseline jump, backfill cold-start L values with the
 * first valid point's L (flat line at baseline level), so the chart starts level and
 * only shows real incremental growth.
 */
function fitColdStart(points) {
  if (points.length === 0) return points;
  let firstValid = 0;
  while (firstValid < points.length && (points[firstValid].kAvg == null || (points[firstValid].kAvg === 0 && points[firstValid].L === 0))) {
    firstValid++;
  }
  if (firstValid === 0 || firstValid >= points.length) return points;
  const baseL = points[firstValid].L;
  return points.map((p, i) => i < firstValid ? { ...p, L: baseL } : p);
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
  // After a ratchet-up, ratchetY may be 2× computeYMax — using yMax would leave markers half-height.
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
  const missMarkers = buildMissMarkers(points, ratchetY);

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
          label: 'Cache miss',
          data: missMarkers,
          borderColor: colors.coralAlpha,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          showLine: true,
          parsing: false,
          spanGaps: false,
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
  let lastGEma = null;           // per-call EMA growth rate (gEma from rateLamp)
  let lastLRead = null;          // current L_read from rateLamp
  let lastLBase = null;          // current lBase from rateLamp

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
      <span><i class="sw-legend-miss"></i>cache miss</span>
      <span><i class="sw-legend-proj"></i>projection</span>
    </div>
    <div class="sw-history-footnote">
      <span><b class="sw-fn-kavg">—</b> kAvg</span>
      <span><b class="sw-fn-g">—</b> gₑ</span>
      <span>calls <b class="sw-fn-calls">—</b></span>
      <span>L <b class="sw-fn-l">—</b></span>
      <span>base <b class="sw-fn-base">—</b></span>
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
  const fnKavg = root.querySelector('.sw-fn-kavg');
  const fnG = root.querySelector('.sw-fn-g');
  const fnCalls = root.querySelector('.sw-fn-calls');
  const fnL = root.querySelector('.sw-fn-l');
  const fnBase = root.querySelector('.sw-fn-base');

  // Theme colors — read once at mount, refreshed on theme switch (destroy+remount)
  const mint = cssVar(root, '--mint', '#4fe0b0');
  const amber = cssVar(root, '--amber', '#ffc24d');
  const coral = cssVar(root, '--coral', '#ff7566');
  const txtDim = cssVar(root, '--txt-dim', '#93a1ab');
  const colors = {
    mint,
    mintBg: mint.startsWith('#') ? mint + '0F' : 'rgba(79,224,176,0.06)',
    amber,
    coral,
    coralAlpha: coral.startsWith('#') ? coral + 'CC' : 'rgba(255,117,102,0.8)',
    txtDim,
  };

  // Apply theme colors to legend swatches
  root.querySelector('.sw-legend-l').style.background = mint;
  const threshSwatch = root.querySelector('.sw-legend-threshold');
  threshSwatch.style.cssText = `height:1.5px;border-top:2px dashed ${amber};background:none;width:14px;`;
  root.querySelector('.sw-legend-miss').style.background = coral;
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
      const slope = (lastGEma > 0) ? lastGEma : (currentPoints[lastDataTurn - 1]?.kAvg || 0);
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
      fnKavg.textContent = '—';
      fnG.textContent = '—';
      fnCalls.textContent = '—';
      fnL.textContent = '—';
      fnBase.textContent = '—';
      return;
    }
    const last = points[points.length - 1];
    fnKavg.textContent = last.kAvg != null ? Math.round(last.kAvg).toLocaleString() : '—';
    const gVal = (lastGEma >= 1) ? lastGEma : last?.kAvg;
    fnG.textContent = gVal != null ? Math.round(gVal).toLocaleString() : '—';
    fnCalls.textContent = points.length;
    fnL.textContent = lastLRead != null ? `${Math.round(lastLRead / 1000)}k` : '—';
    fnBase.textContent = lastLBase != null ? `${Math.round(lastLBase / 1000)}k` : '—';
  }

  function computeRatchet(points) {
    // Y ratchet: only grow
    const yMax = computeYMax(points);
    while (ratchetY < yMax && ratchetY < RATCHET_Y_CAP) {
      ratchetY = nextYRatchet(ratchetY);
    }
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
    // Reset ratchets on segment change; clear thresholds only when paging to a
    // historical segment (follow=false) — on the live segment, update() has
    // already set them from the current rateLamp before calling rebuildChart().
    ratchetX = RATCHET_X_INIT;
    ratchetY = RATCHET_Y_INIT;
    if (!follow) {
      entryLineL = null;
      exitLineL = null;
      redLineL = null;
    }

    const raw = segmentKeys.length > 0 ? (segments.get(segmentKeys[currentPage]) || []) : [];
    const points = fitColdStart(raw);
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

    // Inject projection data (spec §6.1 — needs closure vars, not available in buildChartConfig)
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
    // After a ratchet-up ratchetY may be 2× the data max — markers must span the full visible axis.
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
    const missMarkers = buildMissMarkers(points, ratchetY);

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
    chart.data.datasets[2].data = missMarkers;

    // Projection (id-based lookup — spec §6.1)
    const projDs = chart.data.datasets.find(d => d.id === 'projection');
    if (projDs) {
      const projData = buildProjectionData(points, lastGEma, ratchetX, ratchetY);
      projDs.data = projData;
    }

    // x-axis max: always = max(ratchetX, projection endpoint) — shrinks back when projection disappears
    const projEndX = projDs?.data?.[1]?.x ?? 0;
    chart.options.scales.x.max = Math.max(ratchetX, projEndX);
    if (ratchetY !== prevRY) chart.options.scales.y.max = ratchetY;

    chart.update('none'); // spec §5.7: same-segment = update('none')
    updateControls();
    updateFootnote(points);
  }

  function update(snapshot) {
    const rl = snapshot?.status?.rateLamp;
    // Threshold lines: entry (left arm), exit (br=10%), red (br=25%)
    if (rl?.xBrAmberL != null && Number.isFinite(rl.xBrAmberL) && rl?.lBase > 0) {
      entryLineL = rl.xBrAmberL * rl.lBase;
    }
    if (rl?.xBrAmberR != null && Number.isFinite(rl.xBrAmberR) && rl?.lBase > 0) {
      exitLineL = rl.xBrAmberR * rl.lBase;
    } else if (rl?.L_exit_fullCarry != null && Number.isFinite(rl.L_exit_fullCarry)) {
      exitLineL = rl.L_exit_fullCarry; // fallback before mf is available
    }
    if (rl?.xBrRedR != null && Number.isFinite(rl.xBrRedR) && rl?.lBase > 0) {
      redLineL = rl.xBrRedR * rl.lBase;
    }
    if (rl?.gEma != null && Number.isFinite(rl.gEma)) {
      lastGEma = rl.gEma;
    }
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
    root.innerHTML = '';
  }

  return { update, destroy };
}
