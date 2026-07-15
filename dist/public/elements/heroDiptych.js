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
function sampleCurve(minX, maxX, R, xSweet, nPoints = SAMPLE_POINTS) {
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
    // No y-clamp: Chart.js clips to chartArea naturally, so the curve
    // exits the top smoothly instead of drawing a flat line at yMax.
    points.push({ x: xVal, y: eoqCost(xVal, R, xSweet) });
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

const ZONE_LABELS = { green: 'Valley', warmup: 'Warming up', amber: 'Bill climbing', red: 'High premium', wall: 'At wall', calibrating: 'Calibrating' };

/**
 * Determine verdict text from current br (bill premium) vs zones.
 * Left arm (x < xSweet) has high br too, but it's dropping naturally —
 * different messaging than the right arm where br is climbing.
 */
function positionVerdict(br, x, wallP, xSweet) {
  if (!Number.isFinite(br)) return { zone: 'calibrating', caption: 'Calibrating…' };
  if (x >= wallP) return { zone: 'wall', caption: 'Bill premium ≥ 25% — consider restarting now.' };

  // Left arm: cost is high but falling — session warming up, no action needed
  if (Number.isFinite(xSweet) && x < xSweet) {
    if (br >= 0.10) return { zone: 'warmup', caption: 'Warming up — cost is high but dropping each turn. Keep going.' };
    return { zone: 'green', caption: 'Approaching sweet spot — cost falling naturally.' };
  }

  // Right arm: cost is rising — the usual br thresholds apply
  if (br >= 0.25) return { zone: 'red', caption: 'Bill premium ≥ 25% — consider restarting now.' };
  if (br >= 0.10) return { zone: 'amber', caption: 'Bill climbing — paying 10–24% extra. Finish the task, then restart.' };
  if (br >= 0.01) return { zone: 'green', caption: 'In the valley — bill impact near zero. No pressure.' };
  return { zone: 'green', caption: 'Sweet spot — minimum cost, no waste.' };
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
      <span class="eoq-u">u = <b class="sw-hero-uval">—</b> · <span class="sw-hero-mf">movable —%</span></span>
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
    const xBrAmberL = rl.xBrAmberL;
    const xSweet = rl.xSweet;
    const xBrAmberR = rl.xBrAmberR;
    const xBrRedR = rl.xBrRedR;
    const wallP = rl.wallP ?? (1 + R);

    const viewport = computeEoqViewport({ xBrAmberR, xSweet, xBrRedR, wallP, xCurrent: x, previousDomainMax });
    previousDomainMax = viewport.mainDomain.max;

    // Legacy domain object for backward compat with verticalLine datasets
    const domain = { minX: viewport.mainDomain.min, maxX: viewport.mainDomain.max, overflow: viewport.isPastWall ? 'right' : 'none' };

    // Y-max: use cost at entry as anchor
    const xEntryFallback = xBrAmberL > 1.01 ? xBrAmberL : 1.2;
    const costAtEntry = eoqCost(xEntryFallback, R, xSweet);
    const costAtWall = eoqCost(wallP, R, xSweet);
    const yMax = Math.max(costAtEntry, costAtWall) * 1.3;
    // Sample from domain min (not 1) so curve fills the focused viewport
    const curveData = sampleCurve(viewport.mainDomain.min, viewport.mainDomain.max, R, xSweet, SAMPLE_POINTS);
    const costAtX = x > 1 ? eoqCost(x, R, xSweet) : null;

    // u = (x - 1) / dhat — EOQ normalized coordinate (matches statusline renderU)
    const dhat = rl.dhat;
    const u = (Number.isFinite(dhat) && dhat > 0 && x > 1) ? (x - 1) / dhat : null;

    return { R, x, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP, domain, curveData, yMax, costAtX, viewport, u };
  }

  function buildChart(rl, capabilities, status) {
    const landmarksAvailable = capabilities?.eoqLandmarks?.available === true;
    if (!landmarksAvailable) {
      if (chart) { chart.destroy(); chart = null; }
      uvalEl.textContent = '—';
      return;
    }

    const { R, x, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP } = { R: rl.C_RATIO, x: rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1), xBrAmberL: rl.xBrAmberL, xSweet: rl.xSweet, xBrAmberR: rl.xBrAmberR, xBrRedR: rl.xBrRedR, wallP: rl.wallP ?? (1 + rl.C_RATIO) };

    const validation = validateLandmarks({ xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP });
    if (!validation.ok) {
      if (chart) { chart.destroy(); chart = null; }
      uvalEl.textContent = '—';
      return;
    }

    const { domain, curveData, yMax, costAtX, u } = computeChartData(rl);
    uvalEl.textContent = u != null ? u.toFixed(1) : '—';

    // mf display in topbar
    const mfEl = container.querySelector('.sw-hero-mf');
    if (mfEl && Number.isFinite(status?.rateLamp?.mf)) {
      mfEl.textContent = `movable ${Math.floor(status.rateLamp.mf * 100)}%`;
    }

    // Fix #6: if chart already exists with valid landmarks, update datasets in-place instead of
    // destroy+rebuild. With a 2s poll on an active session this prevents a destroy+rebuild every tick.
    if (chart) {
      chart.data.datasets[0].data = curveData;
      chart.data.datasets[1].data = Number.isFinite(xBrAmberL) ? [{ x: xBrAmberL, y: 0 }, { x: xBrAmberL, y: yMax }] : [];
      chart.data.datasets[2].data = [{ x: xSweet, y: 0 }, { x: xSweet, y: yMax }];
      chart.data.datasets[3].data = [{ x: xBrAmberR, y: 0 }, { x: xBrAmberR, y: yMax }];
      chart.data.datasets[4].data = Number.isFinite(xBrRedR) ? [{ x: xBrRedR, y: 0 }, { x: xBrRedR, y: yMax }] : [];
      chart.data.datasets[5].data = costAtX != null ? [{ x: Math.min(x, domain.maxX), y: costAtX }] : [];
      // 6: horizontal line at current cost level
      chart.data.datasets[6].data = costAtX != null
        ? [{ x: domain.minX, y: costAtX }, { x: Math.min(x, domain.maxX), y: costAtX }]
        : [];
      chart.options.scales.x.min = domain.minX;
      chart.options.scales.x.max = domain.maxX;
      chart.options.scales.y.min = -yMax * 0.06;
      chart.options.scales.y.max = yMax;
      // Update br label stored in plugin config
      chart.options.plugins.brLabel.br = status?.rateLamp?.br;
      chart.options.plugins.brLabel.costAtX = costAtX;
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
        // 1: br=-10% left arm vertical (entry color)
        verticalLine(Number.isFinite(xBrAmberL) ? xBrAmberL : -1, yMax, cssVar(container, '--zone-entry', '#6cc6f0'), [3, 4]),
        // 2: br=0 sweet vertical
        verticalLine(xSweet, yMax, cssVar(container, '--zone-sweet', '#4fe0b0'), [3, 4]),
        // 3: br=+10% right arm vertical (deep/amber color)
        verticalLine(xBrAmberR, yMax, cssVar(container, '--zone-deep', '#ffc24d'), [3, 4], 1.4),
        // 4: br=+25% red threshold vertical (wall color)
        verticalLine(Number.isFinite(xBrRedR) ? xBrRedR : -1, yMax, cssVar(container, '--zone-wall', '#ff7566'), [3, 4], 1.4),
        // 5: current x marker (amber dot on curve) — drawn last (top layer)
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
        // 6: horizontal line at current cost level (from y-axis to current dot)
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

      ];

      // Plugin: draw br% label at the current cost level on the y-axis + "bill premium" axis title
      const brLabelPlugin = {
        id: 'brLabel',
        afterDraw(chartInstance) {
          const opts = chartInstance.options.plugins.brLabel;
          if (!opts || !Number.isFinite(opts.br)) return;
          const { ctx } = chartInstance;
          const yScale = chartInstance.scales.y;
          const xScale = chartInstance.scales.x;
          const rawYPx = yScale.getPixelForValue(opts.costAtX);
          const yPx = Math.max(yScale.top + 10, Math.min(yScale.bottom - 4, rawYPx));

          const labelX = xScale.left - 4;
          ctx.save();
          ctx.font = '500 11px "JetBrains Mono", monospace';
          ctx.textAlign = 'right';
          ctx.textBaseline = 'middle';

          // Y-axis title: "bill premium" (drawn vertically at top-left)
          ctx.font = '400 9px "JetBrains Mono", monospace';
          ctx.fillStyle = getComputedStyle(chartInstance.canvas).getPropertyValue('--text-secondary')?.trim() || '#aaa';
          ctx.save();
          ctx.translate(xScale.left - 30, yScale.top + (yScale.bottom - yScale.top) / 2);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = 'center';
          ctx.fillText('bill premium', 0, 0);
          ctx.restore();

          // Current br label: pure XX%
          ctx.font = '500 11px "JetBrains Mono", monospace';
          const brPct = Math.floor(opts.br * 100);
          const label = `${brPct}%`;
          const color = opts.br >= 0.25
            ? (getComputedStyle(chartInstance.canvas).getPropertyValue('--zone-red')?.trim() || '#ff5252')
            : opts.br >= 0.10
              ? (getComputedStyle(chartInstance.canvas).getPropertyValue('--amber')?.trim() || '#ffc24d')
              : (getComputedStyle(chartInstance.canvas).getPropertyValue('--zone-sweet')?.trim() || '#4fe0b0');
          ctx.fillStyle = color;
          ctx.fillText(label, labelX, yPx);

          ctx.restore();
        },
      };

      chart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        plugins: [brLabelPlugin],
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
            brLabel: { br: status?.rateLamp?.br, costAtX },
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
              min: -yMax * 0.06,
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
    const verdict = positionVerdict(status?.rateLamp?.br, x, wallP, xSweet);
    verdictPill.textContent = ZONE_LABELS[verdict.zone] ?? verdict.zone;
    verdictText.innerHTML = verdict.caption;
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
      rl.xBrAmberR === prevEntry &&
      rl.xSweet === prevSweet &&
      rl.xBrRedR === prevExit
    ) return;
    prevX = newX; prevR = newR; prevEntry = rl.xBrAmberR; prevSweet = rl.xSweet; prevExit = rl.xBrRedR;
    buildChart(rl, capabilities, snapshot?.status);
  }

  function destroy() {
    if (chart) { chart.destroy(); chart = null; }
    container.remove();
    verdictRow.remove();
  }

  return { update, destroy };
}
