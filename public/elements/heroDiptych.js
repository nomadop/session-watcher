// public/elements/heroDiptych.js — EOQ U-curve chart + position display (spec §2 #1/#2/#5/#6)
// Chart.js line chart with landmark vertical lines + current-x marker.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

import { computeEoqViewport, validateLandmarks } from '../lib/xScale.js';

const SAMPLE_POINTS = 50;

/** Resolve a CSS custom property to its computed value, with fallback. */
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}

/**
 * EOQ average cost per turn (renewal-reward, fig-eoq-curve.tex form):
 *   C(x) = A/(x-1) + (x-1)/(2R)
 * where A = (xSweet-1)^2 / (2R), ensuring minimum at x = xSweet.
 * Left arm = restart cost amortized (decays as 1/(x-1))
 * Right arm = average holding cost (grows linearly)
 * @param {number} x — position on x-axis (L/lBase), must be > 1
 * @param {number} R — effective ratio (C_RATIO)
 * @param {number} xSweet — sweet-spot position (curve minimum)
 */
function eoqCost(x, R, xSweet) {
  const d = x - 1;
  const dSweet = xSweet - 1;
  const A = dSweet * dSweet / (2 * R);
  if (d <= 0) return Infinity;
  return A / d + d / (2 * R);
}

/**
 * Sample the EOQ curve with denser sampling near x=1 (left arm asymptote).
 * Uses logarithmic spacing in the (x-1) domain so the 1/(x-1) rise is well-resolved.
 */
function sampleCurve(minX, maxX, R, xSweet, nPoints = SAMPLE_POINTS, yClamp = Infinity) {
  const points = [];
  // Map [0,1] → [minX, maxX] with log-spacing in (x-1) to cluster points near left arm
  const dMin = minX - 1;  // e.g. 0.005
  const dMax = maxX - 1;  // e.g. 10
  const logMin = Math.log(Math.max(dMin, 0.001));
  const logMax = Math.log(dMax);
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    const d = Math.exp(logMin + t * (logMax - logMin));
    const xVal = 1 + d;
    points.push({ x: xVal, y: Math.min(eoqCost(xVal, R, xSweet), yClamp) });
  }
  return points;
}

/**
 * Build a vertical line dataset (dashed) at a given x position
 */
function verticalLine(xVal, yMax, color, dash = [4, 4], lineWidth = 1.5) {
  return {
    data: [{ x: xVal, y: 0 }, { x: xVal, y: yMax }],
    borderColor: color,
    borderWidth: lineWidth,
    borderDash: dash,
    pointRadius: 0,
    fill: false,
    showLine: true,
    parsing: false,
    spanGaps: false,
  };
}

/**
 * Determine verdict text from current position vs landmarks
 */
function positionVerdict(x, xEntry, xSweet, xExit, wallP) {
  if (x < xEntry) return { zone: 'hold', caption: 'Hold — below entry' };
  if (x < xSweet) return { zone: 'approaching', caption: 'Approaching sweet spot' };
  if (x < xExit) return { zone: 'sweet', caption: 'In sweet zone' };
  if (x < wallP) return { zone: 'deep', caption: 'Deep — past exit' };
  return { zone: 'wall', caption: 'At wall' };
}

export function mount(root, _ctx) {
  // Prev-state for no-change-skip guard in update()
  let prevX, prevR, prevEntry, prevSweet, prevExit;
  let previousDomainMax = null;
  let prevSegment = null;

  // Create DOM sub-container for this element within #sw-hero
  const container = document.createElement('div');
  container.className = 'sw-hero-diptych';
  container.innerHTML = `
    <div class="eoq-top">
      <div>
        <span class="lab">Position</span>
        <div class="sub">cost-rate valley · Harris 1913</div>
      </div>
      <span class="eoq-u">u = <b class="sw-hero-uval">—</b></span>
    </div>
    <div class="sw-hero-chart-wrap">
      <canvas class="sw-hero-canvas"></canvas>
    </div>
  `;
  root.appendChild(container);

  // Verdict row — spans full hero width (appended last; grid-column: 1/-1 applied in CSS)
  const verdictRow = document.createElement('div');
  verdictRow.className = 'sw-hero-verdict-row';
  verdictRow.innerHTML = `<span class="pill sw-verdict-pill">—</span><p class="sw-verdict-text">—</p>`;
  root.appendChild(verdictRow);

  const canvas = container.querySelector('.sw-hero-canvas');
  const uvalEl = container.querySelector('.sw-hero-uval');
  const verdictPill = verdictRow.querySelector('.sw-verdict-pill');
  const verdictText = verdictRow.querySelector('.sw-verdict-text');

  let chart = null;

  /**
   * Compute chart data (curve, yMax, domain) without creating/updating the Chart instance.
   * Extracted so the incremental update path can reuse the same computation.
   */
  function computeChartData(rl) {
    const R = rl.C_RATIO;
    const x = rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1);
    const xEntry = rl.xEntry;
    const xSweet = rl.xSweet;
    const xExit = rl.xExit;
    const wallP = rl.wallP ?? (1 + R);

    const viewport = computeEoqViewport({ xEntry, xSweet, xExit, wallP, xCurrent: x, previousDomainMax });
    previousDomainMax = viewport.mainDomain.max;

    // Legacy domain object for backward compat with verticalLine datasets
    const domain = { minX: viewport.mainDomain.min, maxX: viewport.mainDomain.max, overflow: viewport.isPastWall ? 'right' : 'none' };

    // Y-max: use cost at entry as anchor
    const costAtEntry = xEntry > 1.01 ? eoqCost(xEntry, R, xSweet) : eoqCost(1.2, R, xSweet);
    const costAtWall = eoqCost(wallP, R, xSweet);
    const yMax = Math.max(costAtEntry, costAtWall) * 1.3;
    // Sample from domain min (not 1) so curve fills the focused viewport
    const curveData = sampleCurve(viewport.mainDomain.min, viewport.mainDomain.max, R, xSweet, SAMPLE_POINTS, yMax);
    const rawCostAtX = x > 1 ? eoqCost(x, R, xSweet) : null;
    const costAtX = rawCostAtX != null ? Math.min(rawCostAtX, yMax) : null;

    // u = (x - 1) / dhat — EOQ normalized coordinate (matches statusline renderU)
    const dhat = rl.dhat;
    const u = (Number.isFinite(dhat) && dhat > 0 && x > 1) ? (x - 1) / dhat : null;

    // pp% — cost premium over sweet-spot minimum (movable cost only)
    const costAtSweet = eoqCost(xSweet, R, xSweet);
    const pp = (costAtX != null && costAtSweet > 0) ? (costAtX / costAtSweet - 1) * 100 : null;

    return { R, x, xEntry, xSweet, xExit, wallP, domain, curveData, yMax, costAtX, costAtSweet, viewport, u, pp };
  }

  function buildChart(rl, capabilities) {
    const landmarksAvailable = capabilities?.eoqLandmarks?.available === true;
    if (!landmarksAvailable) {
      if (chart) { chart.destroy(); chart = null; }
      uvalEl.textContent = '—';
      return;
    }

    const { R, x, xEntry, xSweet, xExit, wallP } = { R: rl.C_RATIO, x: rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1), xEntry: rl.xEntry, xSweet: rl.xSweet, xExit: rl.xExit, wallP: rl.wallP ?? (1 + rl.C_RATIO) };

    const validation = validateLandmarks({ xEntry, xSweet, xExit, wallP });
    if (!validation.ok) {
      if (chart) { chart.destroy(); chart = null; }
      uvalEl.textContent = '—';
      return;
    }

    const { domain, curveData, yMax, costAtX, costAtSweet, u, pp } = computeChartData(rl);
    uvalEl.textContent = u != null ? u.toFixed(1) : '—';

    // Fix #6: if chart already exists with valid landmarks, update datasets in-place instead of
    // destroy+rebuild. With a 2s poll on an active session this prevents a destroy+rebuild every tick.
    if (chart) {
      chart.data.datasets[0].data = curveData;
      chart.data.datasets[1].data = [{ x: xEntry, y: 0 }, { x: xEntry, y: yMax }];
      chart.data.datasets[2].data = [{ x: xSweet, y: 0 }, { x: xSweet, y: yMax }];
      chart.data.datasets[3].data = [{ x: xExit, y: 0 }, { x: xExit, y: yMax }];
      chart.data.datasets[4].data = costAtX != null ? [{ x: Math.min(x, domain.maxX), y: costAtX }] : [];
      // 5: horizontal line at current cost level
      chart.data.datasets[5].data = costAtX != null
        ? [{ x: domain.minX, y: costAtX }, { x: Math.min(x, domain.maxX), y: costAtX }]
        : [];
      // 6: horizontal line at sweet-spot cost (min baseline)
      chart.data.datasets[6].data = [{ x: domain.minX, y: costAtSweet }, { x: domain.maxX, y: costAtSweet }];
      chart.options.scales.x.min = domain.minX;
      chart.options.scales.x.max = domain.maxX;
      chart.options.scales.y.max = yMax;
      // Update pp label stored in plugin config
      chart.options.plugins.ppLabel.pp = pp;
      chart.options.plugins.ppLabel.costAtX = costAtX;
      chart.options.plugins.ppLabel.costAtSweet = costAtSweet;
      chart.update('none');
    } else {
      // Theme colors for chart datasets
      const mintColor = cssVar(container, '--mint', '#4fe0b0');
      const amberColor = cssVar(container, '--amber', '#ffc24d');

      // Datasets
      const datasets = [
        // 0: EOQ U-curve
        {
          label: 'EOQ cost',
          data: curveData,
          borderColor: mintColor,
          backgroundColor: mintColor.startsWith('#') ? mintColor + '14' : 'rgba(79,224,176,0.08)',
          borderWidth: 2.5,
          pointRadius: 0,
          fill: true,
          tension: 0.3,
          parsing: false,
        },
        // 1: xEntry vertical
        verticalLine(xEntry, yMax, cssVar(container, '--zone-entry', '#6cc6f0'), [3, 4]),
        // 2: xSweet vertical
        verticalLine(xSweet, yMax, cssVar(container, '--zone-sweet', '#4fe0b0'), [3, 4]),
        // 3: xExit vertical
        verticalLine(xExit, yMax, cssVar(container, '--zone-deep', '#ffc24d'), [3, 4], 1.4),
        // 4: current x marker (amber dot on curve) — drawn last (top layer)
        {
          data: costAtX != null ? [{ x: Math.min(x, domain.maxX), y: costAtX }] : [],
          borderColor: amberColor,
          backgroundColor: amberColor,
          pointRadius: 6.5,
          pointHoverRadius: 8,
          pointBorderWidth: 0,
          showLine: false,
          parsing: false,
          order: -1,
        },
        // 5: horizontal line at current cost level (from y-axis to current dot)
        {
          data: costAtX != null
            ? [{ x: domain.minX, y: costAtX }, { x: Math.min(x, domain.maxX), y: costAtX }]
            : [],
          borderColor: amberColor.startsWith('#') ? amberColor + '88' : 'rgba(255,194,77,0.53)',
          borderWidth: 1.2,
          borderDash: [3, 3],
          pointRadius: 0,
          fill: false,
          showLine: true,
          parsing: false,
        },
        // 6: horizontal line at sweet-spot cost (min baseline, faint)
        {
          data: [{ x: domain.minX, y: costAtSweet }, { x: domain.maxX, y: costAtSweet }],
          borderColor: (() => { const c = cssVar(container, '--zone-sweet', '#4fe0b0'); return c.startsWith('#') ? c + '55' : 'rgba(79,224,176,0.33)'; })(),
          borderWidth: 1,
          borderDash: [2, 4],
          pointRadius: 0,
          fill: false,
          showLine: true,
          parsing: false,
        },
      ];

      // Plugin: draw +pp% label at the current cost level on the y-axis
      const ppLabelPlugin = {
        id: 'ppLabel',
        afterDraw(chartInstance) {
          const opts = chartInstance.options.plugins.ppLabel;
          if (!opts || opts.pp == null || opts.costAtX == null) return;
          const { ctx } = chartInstance;
          const yScale = chartInstance.scales.y;
          const xScale = chartInstance.scales.x;
          const yPx = yScale.getPixelForValue(opts.costAtX);
          const ySweetPx = yScale.getPixelForValue(opts.costAtSweet ?? 0);

          // Draw labels in the y-axis tick area (replaces native ticks)
          const labelX = xScale.left - 4;
          ctx.save();
          ctx.font = '500 11px "JetBrains Mono", monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';

          // Current cost label: 'min' at sweet spot, '+pp%' otherwise
          const label = opts.pp < 0.5 ? 'min' : `+${Math.round(opts.pp)}%`;
          ctx.fillStyle = opts.pp < 0.5
            ? getComputedStyle(chartInstance.canvas).getPropertyValue('--zone-sweet')?.trim() || '#4fe0b0'
            : getComputedStyle(chartInstance.canvas).getPropertyValue('--amber')?.trim() || '#ffc24d';
          ctx.fillText(label, labelX, yPx);

          // 'min' label at sweet baseline when current is above sweet
          if (opts.pp >= 0.5) {
            const sweetColor = getComputedStyle(chartInstance.canvas).getPropertyValue('--zone-sweet')?.trim() || '#4fe0b0';
            ctx.fillStyle = sweetColor.startsWith('#') ? sweetColor + 'aa' : 'rgba(79,224,176,0.67)';
            ctx.fillText('min', labelX, ySweetPx);
          }
          ctx.restore();
        },
      };

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        plugins: [ppLabelPlugin],
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
            ppLabel: { pp, costAtX, costAtSweet },
          },
          scales: {
            x: {
              type: 'linear',
              min: domain.minX,
              max: domain.maxX,
              title: { display: false },
            },
            y: {
              type: 'linear',
              min: 0,
              max: yMax,
              title: { display: false },
              ticks: { callback: () => '    ', font: { size: 11, family: '"JetBrains Mono", monospace' } },
              grid: { display: false },
            },
          },
        },
      });

      // Expose chart for depthAux ResizeObserver sync and e2e
      if (window.__SW_dashboard) window.__SW_dashboard.charts.hero = chart;
    }

    // Update verdict row
    const verdict = positionVerdict(x, xEntry, xSweet, xExit, wallP);
    const zoneLabels = {
      hold: 'Shallow water', approaching: 'Approaching sweet', sweet: 'Sweet zone',
      deep: 'Deep water', wall: 'At the wall',
    };
    const zoneDescs = {
      hold: 'Below the entry line — context is cheap. No pressure to restart.',
      approaching: 'Approaching the sweet spot — optimal cache efficiency zone ahead.',
      sweet: 'In the sweet zone — cost-rate valley. Ideal position.',
      deep: 'Just past the exit line — but here the marginal cost is still nearly flat, so <b>hold on the task, not the money</b>. The bill only starts to bite as you climb toward the wall.',
      wall: 'At the wall — holding one more turn costs as much as a full restart. <b>Consider compacting now</b>.',
    };
    verdictPill.textContent = zoneLabels[verdict.zone] || verdict.caption;
    verdictText.innerHTML = zoneDescs[verdict.zone] || verdict.caption;
  }

  function update(snapshot) {
    // Segment change resets ratchet — uses snapshot.status.segment (available in all API responses)
    const currentSegment = snapshot?.status?.segment ?? null;
    let segmentChanged = false;
    if (currentSegment !== prevSegment) {
      previousDomainMax = null;
      prevSegment = currentSegment;
      segmentChanged = true;
    }

    const rl = snapshot?.status?.rateLamp;
    const capabilities = snapshot?.capabilities;
    if (!rl) return;
    const newX = rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1);
    // Fix #11: NaN defeats the skip-guard — NaN === NaN is false, so every tick rebuilds the chart.
    // Guard early: if lBase=0 and x_display is undefined, newX = NaN. Same for C_RATIO being absent.
    if (!Number.isFinite(newX)) return;
    const newR = rl.C_RATIO;
    if (!Number.isFinite(newR)) return;
    if (
      !segmentChanged &&
      newX === prevX &&
      newR === prevR &&
      rl.xEntry === prevEntry &&
      rl.xSweet === prevSweet &&
      rl.xExit === prevExit
    ) return;
    prevX = newX; prevR = newR; prevEntry = rl.xEntry; prevSweet = rl.xSweet; prevExit = rl.xExit;
    buildChart(rl, capabilities);
  }

  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
    container.remove();
    verdictRow.remove();
  }

  return { update, destroy };
}
