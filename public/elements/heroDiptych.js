// public/elements/heroDiptych.js — the causal position placed on the reference skeleton, and the position verdict
// Vertical geometry is y = 1 + pp (the C/C_min identity). A default group and a preview group, with an
// activation toggle; the preview group is built from a scenario object the server folded, never locally.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

import { computeEoqViewport, projectedX } from '../lib/xScale.js';

const SAMPLE_POINTS = 50;
const Y_HEADROOM = 1.3;

const ACTIVE_OPACITY = 1.0;
const INACTIVE_OPACITY = 0.25;
const ACTIVE_LINE_WIDTH = 2.5;
const INACTIVE_LINE_WIDTH = 1.2;
const ACTIVE_DOT_RADIUS = 7;
const INACTIVE_DOT_RADIUS = 4.5;
const DOT_HIT_RADIUS = 15;
const ACTIVE_LANDMARK_WIDTH = 1.6;
const INACTIVE_LANDMARK_WIDTH = 1.0;
const INACTIVE_DASH = [6, 4];
const DOT_OVERLAP_THRESHOLD_PX = 4;

// Draw order: lower number = rendered later = on top
const ORDER = {
  inactiveReference: 50, inactiveLandmark: 45,
  activeReference: 30, activeLandmark: 25,
  wall: 15, inactiveDot: 10, activeDot: 0,
};

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}

function colorWithAlpha(color, alpha) {
  if (!color) return `rgba(79,224,176,${alpha})`;
  if (color.startsWith('rgba(')) return color.replace(/,\s*[\d.]+\s*\)$/, `, ${alpha})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  if (color.startsWith('#')) {
    const hex = color.slice(1, 7);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  return color;
}

/** Reference curve height at x: 1 + φ((x − a)/d), φ(u) = (u−1)²/(2u). Null at or left of the asymptote. */
export function referenceY(x, reference) {
  const u = (x - reference.a) / reference.d;
  if (!(u > 0)) return null;
  return 1 + (u - 1) * (u - 1) / (2 * u);
}

/** Sample the reference from minX, or from just right of the asymptote a when minX is not, up to maxX, dense near
 *  the asymptote. */
export function sampleReference(reference, minX, maxX, nPoints = SAMPLE_POINTS) {
  const start = minX;
  const span = maxX - reference.a;
  if (!(span > 0)) return [];
  const logMin = Math.log(Math.max(start - reference.a, span * 1e-3));
  const logMax = Math.log(span);
  const points = [];
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    const x = reference.a + Math.exp(logMin + t * (logMax - logMin));
    const y = referenceY(x, reference);
    if (y !== null) points.push({ x, y });
  }
  return points;
}

// The only rule that turns a frame — the status or a scenario's last frame — into the dot: its causal position
// placed on the reference, `projectedX`, at height 1 + pp. The measured x retreats whenever a read widens the
// baseline while u only advances, so it reaches the chart as the dot's residual alone. A frame carries no pp until
// the position has been measured against a base, and without a reference there is nothing to place a point on;
// either way the frame is real and draws no dot.
const chartPoint = (p, reference) => {
  const x = projectedX(reference, p.u);
  return x !== null && Number.isFinite(p.pp) ? { x, y: 1 + p.pp } : null;
};

/** y range: the larger of the reference heights at the amber-left root and the wall, with headroom; without a
 *  reference nothing is drawn but the wall, and the unit height bounds it. */
export function yMaxOf({ reference, xBrAmberL, wallP }) {
  const candidates = [];
  if (reference) {
    if (Number.isFinite(xBrAmberL)) { const y = referenceY(xBrAmberL, reference); if (y !== null) candidates.push(y); }
    const yWall = referenceY(wallP, reference); if (yWall !== null) candidates.push(yWall);
  }
  if (candidates.length === 0) candidates.push(1);
  return Math.max(...candidates) * Y_HEADROOM;
}

const ZONE_LABELS = { green: 'Valley', left: 'Left arm', amber: 'Amber', red: 'Red', wall: 'At wall', calibrating: 'Calibrating' };

// Captions state position: the arm and the premium band. The left arm promises the position penalty's descent
// (u never decreases, φ falls on the left arm) and nothing about br, whose path scale can rise while pp
// falls. No band claims the sweet spot itself: br = mf · pp, so a small movable fraction makes br small at
// any u. Advice lives in the rent ledger's reminder; the wall, an action-layer fact, keeps its prompt.
export function positionVerdict(br, u, x, wallP) {
  if (!Number.isFinite(br)) return { zone: 'calibrating', caption: 'Calibrating…' };
  if (x >= wallP) return { zone: 'wall', caption: 'At the cost wall — carrying the excess one more call costs as much as a full rebuild. Consider restarting now.' };
  if (u < 1) {
    if (br >= 0.10) return { zone: 'left', caption: 'Left of the sweet spot — position penalty falls with every call.' };
    return { zone: 'green', caption: 'Left of the sweet spot — bill premium within the valley.' };
  }
  if (br >= 0.25) return { zone: 'red', caption: 'Past the sweet spot — bill premium above red.' };
  if (br >= 0.10) return { zone: 'amber', caption: 'Past the sweet spot — bill premium above amber.' };
  return { zone: 'green', caption: 'Past the sweet spot — bill premium within the valley.' };
}

const fourLandmarks = (src) => (src.xSweet == null ? null
  : { xSweet: src.xSweet, xBrAmberL: src.xBrAmberL, xBrAmberR: src.xBrAmberR, xBrRedR: src.xBrRedR });

/** The default group: server facts only. `available` gates the reference and landmarks, and with them the dot. */
export function groupModelFromStatus(rl, available) {
  const reference = available && rl.reference ? rl.reference : null;
  const x = rl.x_display;
  const dot = chartPoint({ u: rl.u, pp: rl.pp }, reference);
  return {
    dot, wallP: rl.wallP ?? (1 + rl.C_RATIO), reference,
    landmarks: available ? fourLandmarks(rl) : null,
    u: rl.u, mf: rl.mf, br: rl.br, x,
    residual: dot && Number.isFinite(x) ? x - dot.x : null,
  };
}

/** The preview group: the scenario object as the server folded it. */
export function groupModelFromScenario(scenario, wallP) {
  if (!scenario || scenario.reliable !== true) return null;
  const reference = scenario.reference ?? null;
  // The scenario's last frame: its position places the dot, its measured x serves the verdict and the residual.
  const last = (scenario.trajectory ?? []).at(-1) ?? null;
  const dot = last ? chartPoint(last, reference) : null;
  return {
    dot, wallP, reference,
    landmarks: fourLandmarks(scenario),
    u: scenario.u, mf: scenario.mf, br: scenario.br, x: last ? last.x : null,
    residual: dot && last && Number.isFinite(last.x) ? last.x - dot.x : null,
  };
}

/**
 * The group actually drawn. A preview is shown only once its scenario places a position: a scenario is reliable
 * whenever the default one is, so one whose own fit was refused arrives carrying no reference and no dot, and
 * drawing it in the default group's place would withdraw the curve, the dot and the premium label the default
 * group still has. `markerModel` in `depthAux.js` keys its own marker on the same placed position.
 */
export function shownGroupOf(activeGroup, mint) {
  return activeGroup === 'mint' && mint?.dot ? 'mint' : 'amber';
}

export function mount(root, _ctx) {
  let previousActualDomainMax = null;
  let prevSegment = null;
  let activeGroup = 'amber'; // 'amber' | 'mint'
  let previewState = null;   // { dirty, scenario } from sw-bucket-preview
  let lastSnapshot = null;

  const container = document.createElement('div');
  container.className = 'sw-hero-diptych';
  container.innerHTML = `
    <div class="eoq-top">
      <div>
        <span class="lab">Position</span>
        <div class="sub">cost-rate valley · Harris 1913</div>
      </div>
      <span class="eoq-u"><span class="sw-hero-group-pill" style="display:none;"></span>u = <b class="sw-hero-uval">—</b> · <span class="sw-hero-mf">movable —%</span></span>
    </div>
    <div class="sw-hero-chart-wrap">
      <div class="sw-hero-placeholder hidden"></div>
      <canvas class="sw-hero-canvas"></canvas>
    </div>
  `;
  root.appendChild(container);

  const verdictRow = document.createElement('div');
  verdictRow.className = 'sw-hero-verdict-row';
  verdictRow.innerHTML = `<span class="pill sw-verdict-pill">idle</span><p class="sw-verdict-text">Position tracking begins after the first API call.</p>`;
  root.appendChild(verdictRow);

  const canvas = container.querySelector('.sw-hero-canvas');
  const uvalEl = container.querySelector('.sw-hero-uval');
  const groupPillEl = container.querySelector('.sw-hero-group-pill');
  const mfEl = container.querySelector('.sw-hero-mf');
  const verdictPill = verdictRow.querySelector('.sw-verdict-pill');
  const verdictText = verdictRow.querySelector('.sw-verdict-text');

  let mintColor, amberColor, sweetColor, entryColor, deepColor, wallColor;
  function resolveColors() {
    mintColor = cssVar(container, '--mint', '#4fe0b0');
    amberColor = cssVar(container, '--amber', '#ffc24d');
    sweetColor = cssVar(container, '--zone-sweet', '#4fe0b0');
    entryColor = cssVar(container, '--zone-entry', '#6cc6f0');
    deepColor = cssVar(container, '--zone-deep', '#ffc24d');
    wallColor = cssVar(container, '--zone-wall', '#ff7566');
  }
  resolveColors();

  const brLabelPlugin = {
    id: 'brLabel',
    afterDraw(chartInstance) {
      const opts = chartInstance.options.plugins.brLabel;
      if (!opts) return;
      const { ctx } = chartInstance;
      const yScale = chartInstance.scales.y, xScale = chartInstance.scales.x;
      ctx.save();
      ctx.font = '400 9px "JetBrains Mono", monospace';
      ctx.fillStyle = getComputedStyle(chartInstance.canvas).getPropertyValue('--text-secondary')?.trim() || '#aaa';
      ctx.save();
      ctx.translate(xScale.left - 30, yScale.top + (yScale.bottom - yScale.top) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText('bill premium', 0, 0);
      ctx.restore();
      // The axis name says what the gutter measures, so it is drawn wherever the chart is — the idle frame's empty
      // coordinate area included, where the y ticks render blank and nothing else would name them.
      if (!Number.isFinite(opts.br) || !Number.isFinite(opts.y)) { ctx.restore(); return; }
      const yPx = Math.max(yScale.top + 10, Math.min(yScale.bottom - 4, yScale.getPixelForValue(opts.y)));
      ctx.font = '500 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const color = opts.br >= 0.25
        ? (getComputedStyle(chartInstance.canvas).getPropertyValue('--zone-red')?.trim() || '#ff5252')
        : opts.br >= 0.10
          ? (getComputedStyle(chartInstance.canvas).getPropertyValue('--amber')?.trim() || '#ffc24d')
          : (getComputedStyle(chartInstance.canvas).getPropertyValue('--zone-sweet')?.trim() || '#4fe0b0');
      ctx.fillStyle = color;
      ctx.fillText(`${Math.floor(opts.br * 100)}%`, xScale.left - 4, yPx);
      ctx.restore();
    },
  };

  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    plugins: [brLabelPlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          filter: (item) => chart.data.datasets[item.datasetIndex]?._swRole === 'dot',
          callbacks: {
            label: (item) => {
              const ds = chart.data.datasets[item.datasetIndex];
              const who = ds._swGroup === 'amber' ? 'Current state' : 'Preview state';
              return Number.isFinite(ds._swResidual) ? `${who} · residual ${ds._swResidual.toFixed(3)}` : who;
            },
            title: () => '',
          },
          displayColors: false,
          backgroundColor: 'rgba(20, 26, 30, 0.9)',
          bodyFont: { family: '"JetBrains Mono", monospace', size: 11 },
          bodyColor: '#eef3f6',
          padding: { x: 8, y: 5 },
          cornerRadius: 6,
        },
        brLabel: { br: null, y: null },
      },
      scales: {
        x: { type: 'linear', min: 0.8, max: 5, title: { display: false } },
        y: { type: 'linear', min: 0.94, max: 2, title: { display: false }, ticks: { callback: () => '    ', font: { size: 11, family: '"JetBrains Mono", monospace' } }, grid: { display: false } },
      },
      onClick: handleChartClick,
    },
  });
  if (window.__SW_dashboard) window.__SW_dashboard.charts.hero = chart;

  function vertical(groupId, key, x, yMax, color, dash, width, order, role) {
    return {
      data: [{ x, y: 0 }, { x, y: yMax }],
      borderColor: color, borderWidth: width, borderDash: dash,
      pointRadius: 0, pointHitRadius: 0, showLine: true, fill: false, parsing: false, order,
      _swId: `${groupId}.${key}`, _swGroup: groupId, _swRole: role, _swLandmark: key,
    };
  }

  /** Datasets for a group: reference (if any, filled to the floor when active), landmark verticals (if any), wall, dot. */
  function buildGroupDatasets(groupId, model, { domainMin, domainMax, yMax, isActive }) {
    const op = isActive ? ACTIVE_OPACITY : INACTIVE_OPACITY;
    const lw = isActive ? ACTIVE_LINE_WIDTH : INACTIVE_LINE_WIDTH;
    const lmW = isActive ? ACTIVE_LANDMARK_WIDTH : INACTIVE_LANDMARK_WIDTH;
    const dotR = isActive ? ACTIVE_DOT_RADIUS : INACTIVE_DOT_RADIUS;
    const groupColor = groupId === 'amber' ? amberColor : mintColor;
    const datasets = [];

    if (model.reference) {
      datasets.push({
        data: sampleReference(model.reference, domainMin, domainMax),
        borderColor: colorWithAlpha(mintColor, op * 0.8),
        backgroundColor: isActive ? colorWithAlpha(mintColor, op * 0.06) : 'transparent',
        borderWidth: lw * 0.8,
        borderDash: isActive ? [] : INACTIVE_DASH,
        pointRadius: 0, pointHoverRadius: 0, pointHitRadius: 0, fill: isActive ? 'start' : false, tension: 0.3, parsing: false,
        order: isActive ? ORDER.activeReference : ORDER.inactiveReference,
        _swId: `${groupId}.reference`, _swGroup: groupId, _swRole: 'reference', _swLandmark: null,
      });
    }

    if (model.landmarks) {
      const lmOrder = isActive ? ORDER.activeLandmark : ORDER.inactiveLandmark;
      const { xSweet, xBrAmberL, xBrAmberR, xBrRedR } = model.landmarks;
      datasets.push(vertical(groupId, 'sweet', xSweet, yMax, colorWithAlpha(sweetColor, op * 0.7), [4, 4], lmW, lmOrder, 'landmark'));
      datasets.push(vertical(groupId, 'amberL', xBrAmberL, yMax, colorWithAlpha(entryColor, op * 0.7), [3, 4], lmW, lmOrder, 'landmark'));
      datasets.push(vertical(groupId, 'amberR', xBrAmberR, yMax, colorWithAlpha(deepColor, op * 0.7), [4, 4], lmW, lmOrder, 'landmark'));
      datasets.push(vertical(groupId, 'redR', xBrRedR, yMax, colorWithAlpha(wallColor, op * 0.7), [4, 4], lmW, lmOrder, 'landmark'));
    }

    datasets.push(vertical(groupId, 'wall', model.wallP, yMax, colorWithAlpha(wallColor, op), [], lmW, ORDER.wall, 'wall'));

    if (model.dot) {
      datasets.push({
        data: [model.dot],
        borderColor: colorWithAlpha(groupColor, op), backgroundColor: colorWithAlpha(groupColor, op),
        pointRadius: dotR, pointHoverRadius: dotR + 2, pointHitRadius: DOT_HIT_RADIUS, pointBorderWidth: 0,
        showLine: false, parsing: false,
        order: isActive ? ORDER.activeDot : ORDER.inactiveDot,
        _swId: `${groupId}.dot`, _swGroup: groupId, _swRole: 'dot', _swLandmark: null, _swResidual: model.residual,
      });
    }
    return datasets;
  }

  // `shownGroup` is the group actually drawn; `activeGroup` is the user's choice and can name a mint group
  // that has no scenario yet, so the pill reads the former.
  function updateTopbar(model, shownGroup) {
    const dirty = previewState?.dirty === true;
    if (dirty) {
      groupPillEl.style.display = '';
      groupPillEl.textContent = shownGroup === 'mint' ? 'preview' : 'default';
      groupPillEl.className = `sw-hero-group-pill pill-${shownGroup}`;
    } else {
      groupPillEl.style.display = 'none';
    }
    uvalEl.textContent = Number.isFinite(model?.u) ? model.u.toFixed(1) : '—';
    mfEl.textContent = Number.isFinite(model?.mf) ? `movable ${Math.floor(model.mf * 100)}%` : 'movable —%';
  }

  function showIdle() {
    chart.data.datasets = [];
    chart.options.plugins.brLabel.br = null;
    chart.update('none');
    updateTopbar(null, 'amber');
    verdictPill.textContent = 'idle';
    verdictText.textContent = 'Position tracking begins after the first API call.';
  }

  /** Rebuild every dataset in place from the last snapshot and the current preview state. */
  function render() {
    const status = lastSnapshot?.status;
    const rl = status?.rateLamp;
    if (!rl?.reliable) { showIdle(); return; }
    const available = lastSnapshot?.capabilities?.eoqLandmarks?.available === true;
    const amber = groupModelFromStatus(rl, available);
    const mint = previewState?.dirty ? groupModelFromScenario(previewState.scenario, amber.wallP) : null;
    const shown = shownGroupOf(activeGroup, mint);
    const active = shown === 'mint' ? mint : amber;

    // The window opens at the default reference's asymptote and follows the point as drawn — the position placed
    // on the reference — holding the right edge it reached while there is no point to draw, the calibrating chart's
    // case among them. A preview's reference may start elsewhere; the axis stays the default group's.
    const viewport = computeEoqViewport({
      wallP: amber.wallP, xCurrent: amber.dot ? amber.dot.x : null, origin: amber.reference?.a,
      previousDomainMax: previousActualDomainMax, previewX: mint?.dot ? mint.dot.x : null,
    });
    // Only actual data advances the ratchet; the preview expansion is ephemeral.
    previousActualDomainMax = viewport.actualDomainMax;
    const domain = viewport.mainDomain;
    const yMax = Math.max(
      yMaxOf({ reference: amber.reference, xBrAmberL: amber.landmarks?.xBrAmberL, wallP: amber.wallP }),
      mint ? yMaxOf({ reference: mint.reference, xBrAmberL: mint.landmarks?.xBrAmberL, wallP: mint.wallP }) : 0,
    );

    let datasets = buildGroupDatasets('amber', amber, { domainMin: domain.min, domainMax: domain.max, yMax, isActive: shown === 'amber' });
    if (mint) datasets = [...datasets, ...buildGroupDatasets('mint', mint, { domainMin: domain.min, domainMax: domain.max, yMax, isActive: shown === 'mint' })];

    chart.data.datasets = datasets;
    chart.options.scales.x.min = domain.min;
    chart.options.scales.x.max = domain.max;
    chart.options.scales.y.min = 1 - yMax * 0.06;
    chart.options.scales.y.max = yMax;
    chart.options.plugins.brLabel.br = active.br;
    chart.options.plugins.brLabel.y = active.dot ? active.dot.y : null;
    chart.update('none');

    updateTopbar(active, shown);
    const verdict = positionVerdict(active.br, active.u, active.x, active.wallP);
    verdictPill.textContent = ZONE_LABELS[verdict.zone] ?? verdict.zone;
    verdictText.textContent = verdict.caption;
  }

  function dotsOverlap() {
    let amberPt = null, mintPt = null;
    chart.data.datasets.forEach((ds, i) => {
      if (ds._swRole !== 'dot') return;
      const el = chart.getDatasetMeta(i).data[0];
      if (!el) return;
      if (ds._swGroup === 'amber') amberPt = { x: el.x, y: el.y };
      if (ds._swGroup === 'mint') mintPt = { x: el.x, y: el.y };
    });
    if (!amberPt || !mintPt) return false;
    return Math.hypot(amberPt.x - mintPt.x, amberPt.y - mintPt.y) < DOT_OVERLAP_THRESHOLD_PX;
  }

  function handleChartClick(evt) {
    const hits = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
    const dotHit = hits.find(({ datasetIndex }) => chart.data.datasets[datasetIndex]?._swRole === 'dot');
    if (!dotHit) return;
    const group = chart.data.datasets[dotHit.datasetIndex]._swGroup;
    activeGroup = dotsOverlap() ? (activeGroup === 'mint' ? 'amber' : 'mint') : group;
    document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    render();
  }

  function onBucketPreview(e) {
    const detail = e.detail ?? null;
    const wasDirty = previewState?.dirty === true;
    previewState = detail;
    if (detail?.dirty && !wasDirty) {
      activeGroup = 'mint';
      document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    } else if (!detail?.dirty && wasDirty) {
      activeGroup = 'amber';
      document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    }
    render();
  }

  function onExternalActiveGroup(e) {
    const newGroup = e.detail?.activeGroup;
    if (!newGroup || newGroup === activeGroup) return;
    activeGroup = newGroup;
    render();
  }

  document.addEventListener('sw-bucket-preview', onBucketPreview);
  document.addEventListener('sw-active-group', onExternalActiveGroup);

  function update(snapshot) {
    const currentSegment = snapshot?.status?.segment ?? null;
    if (currentSegment !== prevSegment) { previousActualDomainMax = null; prevSegment = currentSegment; }
    lastSnapshot = snapshot;
    render();
  }

  function destroy() {
    document.removeEventListener('sw-bucket-preview', onBucketPreview);
    document.removeEventListener('sw-active-group', onExternalActiveGroup);
    chart.destroy();
    container.remove();
    verdictRow.remove();
  }

  return { update, destroy };
}
