// public/elements/heroDiptych.js — EOQ U-curve chart + position display
// Dual-landmarks redesign: two complete curve groups (default + preview) with activation toggle.
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

import { computeEoqViewport, validateLandmarks } from '../lib/xScale.js';
import { MIN_B_PREVIEW } from '../lib/uiConstants.js';
import { computePreviewBr } from '../chart-helpers.js';

const SAMPLE_POINTS = 50;

// Dual-group activation styling (spec §6.2)
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
  inactiveCurve:    50,
  inactiveLandmark: 45,
  activeCurve:      30,
  activeLandmark:   25,
  brLine:           15,
  inactiveDot:      10,
  activeDot:         0,
};

/** Resolve a CSS custom property to its computed value, with fallback. */
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}

/**
 * EOQ average cost per turn (renewal-reward):
 *   C(x) = A/(x-1) + (x-1)/(2R)
 * where A = (xSweet-1)^2 / (2R), ensuring minimum at x = xSweet.
 */
function eoqCost(x, R, xSweet) {
  const d = x - 1;
  const dSweet = xSweet - 1;
  const A = dSweet * dSweet / (2 * R);
  if (d <= 0) return Infinity;
  return A / d + d / (2 * R);
}

/**
 * Sample the EOQ curve with log-spaced x values (dense near left arm asymptote).
 */
function sampleCurve(minX, maxX, R, xSweet, nPoints = SAMPLE_POINTS) {
  const points = [];
  const dMin = minX - 1;
  const dMax = maxX - 1;
  const logMin = Math.log(Math.max(dMin, 0.001));
  const logMax = Math.log(dMax);
  for (let i = 0; i < nPoints; i++) {
    const t = i / (nPoints - 1);
    const d = Math.exp(logMin + t * (logMax - logMin));
    const xVal = 1 + d;
    points.push({ x: xVal, y: eoqCost(xVal, R, xSweet) });
  }
  return points;
}

/**
 * Compute preview landmarks from a candidate B_preview token budget.
 * Pure helper — exported for unit testing.
 */
export function computePreviewLandmarks({ B_preview, R, g, L, mf: mfOverride }) {
  const B = Math.max(MIN_B_PREVIEW, B_preview || 0);
  const dhat = Math.sqrt(2 * R * g / B);
  const xSweet = 1 + dhat;
  const x = L / B;
  // Recompute mf from B_preview (same formula as lib/bill-regret.js computeMovableFrac)
  let mf;
  if (R > 0 && B > 0 && g > 0) {
    const arm = Math.sqrt(2 * R * B * g);
    mf = arm / (arm + B + R * g);
  } else {
    mf = mfOverride ?? 0.3;
  }
  // Amber/red positions from br formula (both arms)
  const safeMf = mf > 0 ? mf : 0.01;
  const uAmberR = solveUForBr(safeMf, 0.10);
  const uRed = solveUForBr(safeMf, 0.25);
  const xAmberR = 1 + uAmberR * dhat;
  const xRedR = 1 + uRed * dhat;
  // Left arm: u = (1+p) - √(p²+2p)
  const pAmber = 0.10 / safeMf;
  const discAmber = pAmber * pAmber + 2 * pAmber;
  const uAmberL = (1 + pAmber) - Math.sqrt(discAmber);
  const xAmberL = 1 + uAmberL * dhat;
  return { dhat, xSweet, x, xAmberL, xAmberR, xRedR, mf };
}

/** Solve u for a target br given mf: br = mf*(u-1)^2/(2u) */
function solveUForBr(mf, brTarget) {
  const a = mf;
  const b = -(2 * mf + 2 * brTarget);
  const c = mf;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 3;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

/**
 * Convert a color string to rgba with the given alpha.
 * Handles #rrggbb, #rrggbbaa, and rgba(...) forms.
 */
function colorWithAlpha(color, alpha) {
  if (!color) return `rgba(79,224,176,${alpha})`;
  if (color.startsWith('rgba(')) {
    return color.replace(/,\s*[\d.]+\s*\)$/, `, ${alpha})`);
  }
  if (color.startsWith('rgb(')) {
    return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1, 7);
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  return color;
}

const ZONE_LABELS = { green: 'Valley', warmup: 'Warming up', amber: 'Bill climbing', red: 'High premium', wall: 'At wall', calibrating: 'Calibrating' };

function positionVerdict(br, x, wallP, xSweet) {
  if (!Number.isFinite(br)) return { zone: 'calibrating', caption: 'Calibrating…' };
  if (x >= wallP) return { zone: 'wall', caption: 'Bill premium ≥ 25% — consider restarting now.' };
  if (Number.isFinite(xSweet) && x < xSweet) {
    if (br >= 0.10) return { zone: 'warmup', caption: 'Warming up — cost is high but dropping each turn. Keep going.' };
    return { zone: 'green', caption: 'Approaching sweet spot — cost falling naturally.' };
  }
  if (br >= 0.25) return { zone: 'red', caption: 'Bill premium ≥ 25% — consider restarting now.' };
  if (br >= 0.10) return { zone: 'amber', caption: 'Bill climbing — paying 10–24% extra. Finish the task, then restart.' };
  if (br >= 0.01) return { zone: 'green', caption: 'In the valley — bill impact near zero. No pressure.' };
  return { zone: 'green', caption: 'Sweet spot — minimum cost, no waste.' };
}

export function mount(root, _ctx) {
  // Prev-state for no-change-skip guard in update()
  let prevX, prevR, prevEntry, prevSweet, prevExit;
  let previousActualDomainMax = null;
  let prevSegment = null;

  // Dual-group state (spec §6.3)
  let activeGroup = 'amber'; // 'amber' | 'mint'

  // Create DOM
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
      <canvas class="sw-hero-canvas"></canvas>
    </div>
  `;
  root.appendChild(container);

  const verdictRow = document.createElement('div');
  verdictRow.className = 'sw-hero-verdict-row';
  verdictRow.innerHTML = `<span class="pill sw-verdict-pill">—</span><p class="sw-verdict-text">—</p>`;
  root.appendChild(verdictRow);

  const canvas = container.querySelector('.sw-hero-canvas');
  const uvalEl = container.querySelector('.sw-hero-uval');
  const groupPillEl = container.querySelector('.sw-hero-group-pill');
  const mfEl = container.querySelector('.sw-hero-mf');
  const verdictPill = verdictRow.querySelector('.sw-verdict-pill');
  const verdictText = verdictRow.querySelector('.sw-verdict-text');

  let chart = null;

  // Ghost preview state — set by sw-bucket-preview event; survives poll-driven re-renders.
  let previewState = null;
  let lastRl = null;

  // Theme colors resolved once on first chart build
  let mintColor, amberColor, sweetColor, entryColor, deepColor, wallColor;

  function resolveColors() {
    mintColor = cssVar(container, '--mint', '#4fe0b0');
    amberColor = cssVar(container, '--amber', '#ffc24d');
    sweetColor = cssVar(container, '--zone-sweet', '#4fe0b0');
    entryColor = cssVar(container, '--zone-entry', '#6cc6f0');
    deepColor = cssVar(container, '--zone-deep', '#ffc24d');
    wallColor = cssVar(container, '--zone-wall', '#ff7566');
  }

  /**
   * Build datasets for one group (amber or mint).
   * Returns an array of Chart.js dataset configs with _sw* metadata.
   */
  function buildGroupDatasets(groupId, { curveData, xSweet, xAmberL, xAmberR, xRedR, x, costAtX, yMax, R, domainMin, isActive }) {
    const op = isActive ? ACTIVE_OPACITY : INACTIVE_OPACITY;
    const lw = isActive ? ACTIVE_LINE_WIDTH : INACTIVE_LINE_WIDTH;
    const lmW = isActive ? ACTIVE_LANDMARK_WIDTH : INACTIVE_LANDMARK_WIDTH;
    const dotR = isActive ? ACTIVE_DOT_RADIUS : INACTIVE_DOT_RADIUS;
    const dotColor = groupId === 'amber' ? amberColor : mintColor;
    const curveOrder = isActive ? ORDER.activeCurve : ORDER.inactiveCurve;
    const lmOrder = isActive ? ORDER.activeLandmark : ORDER.inactiveLandmark;
    const dotOrder = isActive ? ORDER.activeDot : ORDER.inactiveDot;
    const dash = isActive ? [] : INACTIVE_DASH;

    const datasets = [];

    // Curve
    datasets.push({
      data: curveData,
      borderColor: colorWithAlpha(mintColor, op),
      backgroundColor: isActive ? colorWithAlpha(mintColor, op * 0.06) : 'transparent',
      borderWidth: lw,
      borderDash: dash,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointHitRadius: 0,
      fill: isActive,
      tension: 0.3,
      parsing: false,
      order: curveOrder,
      _swId: `${groupId}.curve`,
      _swGroup: groupId,
      _swRole: 'curve',
      _swLandmark: null,
    });

    // Sweet vertical
    datasets.push({
      data: [{ x: xSweet, y: 0 }, { x: xSweet, y: yMax }],
      borderColor: colorWithAlpha(sweetColor, op * 0.7),
      borderWidth: lmW,
      borderDash: [4, 4],
      pointRadius: 0,
      pointHitRadius: 0,
      showLine: true,
      fill: false,
      parsing: false,
      order: lmOrder,
      _swId: `${groupId}.sweet`,
      _swGroup: groupId,
      _swRole: 'landmark',
      _swLandmark: 'sweet',
    });

    // Amber-L vertical (entry line)
    if (Number.isFinite(xAmberL) && xAmberL > 1.01) {
      datasets.push({
        data: [{ x: xAmberL, y: 0 }, { x: xAmberL, y: yMax }],
        borderColor: colorWithAlpha(entryColor, op * 0.7),
        borderWidth: lmW,
        borderDash: [3, 4],
        pointRadius: 0,
        pointHitRadius: 0,
        showLine: true,
        fill: false,
        parsing: false,
        order: lmOrder,
        _swId: `${groupId}.amberL`,
        _swGroup: groupId,
        _swRole: 'landmark',
        _swLandmark: 'amberL',
      });
    }

    // Amber-R vertical
    if (Number.isFinite(xAmberR)) {
      datasets.push({
        data: [{ x: xAmberR, y: 0 }, { x: xAmberR, y: yMax }],
        borderColor: colorWithAlpha(deepColor, op * 0.7),
        borderWidth: lmW,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHitRadius: 0,
        showLine: true,
        fill: false,
        parsing: false,
        order: lmOrder,
        _swId: `${groupId}.amberR`,
        _swGroup: groupId,
        _swRole: 'landmark',
        _swLandmark: 'amberR',
      });
    }

    // Red-R vertical
    if (Number.isFinite(xRedR)) {
      datasets.push({
        data: [{ x: xRedR, y: 0 }, { x: xRedR, y: yMax }],
        borderColor: colorWithAlpha(wallColor, op * 0.7),
        borderWidth: lmW,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHitRadius: 0,
        showLine: true,
        fill: false,
        parsing: false,
        order: lmOrder,
        _swId: `${groupId}.redR`,
        _swGroup: groupId,
        _swRole: 'landmark',
        _swLandmark: 'redR',
      });
    }

    // Position dot
    if (costAtX != null) {
      datasets.push({
        data: [{ x: Math.min(x, curveData[curveData.length - 1]?.x ?? x), y: costAtX }],
        borderColor: colorWithAlpha(dotColor, op),
        backgroundColor: colorWithAlpha(dotColor, op),
        pointRadius: dotR,
        pointHoverRadius: dotR + 2,
        pointHitRadius: DOT_HIT_RADIUS,
        pointBorderWidth: 0,
        showLine: false,
        parsing: false,
        order: dotOrder,
        _swId: `${groupId}.dot`,
        _swGroup: groupId,
        _swRole: 'dot',
        _swLandmark: null,
      });
    }

    // Horizontal br reference line (only for active group)
    if (isActive && costAtX != null) {
      const brColor = groupId === 'amber' ? amberColor : mintColor;
      datasets.push({
        data: [{ x: domainMin, y: costAtX }, { x: Math.min(x, curveData[curveData.length - 1]?.x ?? x), y: costAtX }],
        borderColor: colorWithAlpha(brColor, 0.5),
        borderWidth: 1,
        borderDash: [3, 3],
        pointRadius: 0,
        pointHitRadius: 0,
        showLine: true,
        fill: false,
        parsing: false,
        order: ORDER.brLine,
        _swId: `${groupId}.brLine`,
        _swGroup: groupId,
        _swRole: 'brLine',
        _swLandmark: null,
      });
    }

    return datasets;
  }

  /**
   * Update topbar: group pill + u value + mf%, following activeGroup.
   */
  function updateTopbar(defaultU, defaultMf) {
    const dirty = previewState?.dirty;

    // Group pill visibility
    if (dirty) {
      groupPillEl.style.display = '';
      groupPillEl.textContent = activeGroup === 'mint' ? 'preview' : 'default';
      groupPillEl.className = `sw-hero-group-pill pill-${activeGroup}`;
    } else {
      groupPillEl.style.display = 'none';
    }

    // u and mf follow active group
    if (dirty && activeGroup === 'mint' && previewState?.B_preview && lastRl) {
      const R = lastRl.C_RATIO;
      const g = lastRl.gEma ?? lastRl.g ?? 0;
      const L = lastRl.L_read ?? 0;
      const prev = computePreviewLandmarks({ B_preview: previewState.B_preview, R, g, L, mf: lastRl.mf });
      const previewU = (prev.dhat > 0 && prev.x > 1) ? (prev.x - 1) / prev.dhat : null;
      uvalEl.textContent = previewU != null ? previewU.toFixed(1) : '—';
      if (Number.isFinite(prev.mf)) mfEl.textContent = `movable ${Math.floor(prev.mf * 100)}%`;
    } else {
      uvalEl.textContent = defaultU != null ? defaultU.toFixed(1) : '—';
      if (Number.isFinite(defaultMf)) mfEl.textContent = `movable ${Math.floor(defaultMf * 100)}%`;
    }
  }

  /**
   * Render chart in dual state (dirty=true) or single state (dirty=false).
   * Replaces the old applyGhost() — builds complete dataset arrays from scratch.
   */
  function renderDualState() {
    if (!chart || !lastRl) return;

    const R = lastRl.C_RATIO;
    const x = lastRl.lBase > 0 ? lastRl.L_read / lastRl.lBase : (lastRl.x_display ?? 1);
    const xSweet = lastRl.xSweet;
    const xBrAmberL = lastRl.xBrAmberL;
    const xBrAmberR = lastRl.xBrAmberR;
    const xBrRedR = lastRl.xBrRedR;
    const wallP = lastRl.wallP ?? (1 + R);

    const dirty = previewState?.dirty;

    // Compute preview landmarks if dirty
    let prevLandmarks = null;
    if (dirty && previewState?.B_preview) {
      const g = lastRl.gEma ?? lastRl.g ?? 0;
      const L = lastRl.L_read ?? 0;
      prevLandmarks = computePreviewLandmarks({ B_preview: previewState.B_preview, R, g, L, mf: lastRl.mf });
    }

    // Viewport: ghost-aware expansion via previewGroup param
    const viewport = computeEoqViewport({
      xBrAmberR,
      xSweet,
      xBrRedR,
      wallP,
      xCurrent: x,
      previousDomainMax: previousActualDomainMax,
      previewGroup: prevLandmarks ? { xRedR: prevLandmarks.xRedR, x: prevLandmarks.x } : undefined,
    });
    // Only actual data advances the ratchet (spec §3.3).
    // actualDomainMax is the pre-ghost domain max computed in the same call, no second invocation needed.
    previousActualDomainMax = viewport.actualDomainMax;

    const domain = viewport.mainDomain;

    // Y-max: always use the same base formula as non-dirty (entry/wall * 1.3)
    // so U-curve bottom stays stable across dirty toggle.
    const costAtX = x > 1 ? eoqCost(x, R, xSweet) : null;
    const xEntryFallback = lastRl.xBrAmberL > 1.01 ? lastRl.xBrAmberL : 1.2;
    const costAtEntry = eoqCost(xEntryFallback, R, xSweet);
    const costAtWall = eoqCost(wallP, R, xSweet);
    let yMax = Math.max(costAtEntry, costAtWall) * 1.3;
    // If preview dot is higher than base yMax, expand just enough to fit it
    if (prevLandmarks) {
      const costPrev = prevLandmarks.x > 1 ? eoqCost(prevLandmarks.x, R, prevLandmarks.xSweet) : 0;
      if (costPrev > yMax) yMax = costPrev * 1.1;
    }

    // Sample curves
    const amberCurveData = sampleCurve(domain.min, domain.max, R, xSweet, SAMPLE_POINTS);

    // Build amber group (default state)
    const amberDatasets = buildGroupDatasets('amber', {
      curveData: amberCurveData,
      xSweet,
      xAmberL: xBrAmberL,
      xAmberR: xBrAmberR,
      xRedR: xBrRedR,
      x,
      costAtX,
      yMax,
      R,
      domainMin: domain.min,
      isActive: activeGroup === 'amber',
    });

    let allDatasets = [...amberDatasets];

    // Build mint group (preview state) if dirty
    if (dirty && prevLandmarks) {
      const mintCurveData = sampleCurve(domain.min, domain.max, R, prevLandmarks.xSweet, SAMPLE_POINTS);
      const costAtPreview = prevLandmarks.x > 1 ? eoqCost(prevLandmarks.x, R, prevLandmarks.xSweet) : null;

      const mintDatasets = buildGroupDatasets('mint', {
        curveData: mintCurveData,
        xSweet: prevLandmarks.xSweet,
        xAmberL: prevLandmarks.xAmberL,
        xAmberR: prevLandmarks.xAmberR,
        xRedR: prevLandmarks.xRedR,
        x: prevLandmarks.x,
        costAtX: costAtPreview,
        yMax,
        R,
        domainMin: domain.min,
        isActive: activeGroup === 'mint',
      });

      allDatasets = [...allDatasets, ...mintDatasets];
    }

    // Determine active group's cost + br for brLabel
    let activeCostAtX = costAtX;
    let activeBr = lastRl.br ?? lastRl.billRegret ?? null;
    if (activeGroup === 'mint' && prevLandmarks) {
      activeCostAtX = prevLandmarks.x > 1 ? eoqCost(prevLandmarks.x, R, prevLandmarks.xSweet) : null;
      const mf = prevLandmarks.mf ?? lastRl.mf ?? 0.3;
      const dhat = prevLandmarks.dhat;
      if (dhat > 0 && prevLandmarks.x > 1) {
        const u = (prevLandmarks.x - 1) / dhat;
        activeBr = computePreviewBr(mf, u);
      }
    }

    // Apply to chart
    chart.data.datasets = allDatasets;
    chart.options.scales.x.min = domain.min;
    chart.options.scales.x.max = domain.max;
    chart.options.scales.y.min = -yMax * 0.06;
    chart.options.scales.y.max = yMax;
    if (chart.options.plugins.brLabel) {
      chart.options.plugins.brLabel.br = activeBr;
      chart.options.plugins.brLabel.costAtX = activeCostAtX;
    }
    chart.update();

    // Update topbar to reflect active group
    const dhat = lastRl.dhat;
    const defaultU = (Number.isFinite(dhat) && dhat > 0 && x > 1) ? (x - 1) / dhat : null;
    updateTopbar(defaultU, lastRl.mf);
  }

  /**
   * Check if amber and mint dots overlap (within DOT_OVERLAP_THRESHOLD_PX).
   */
  function dotsOverlap() {
    if (!chart) return false;
    const metas = chart.data.datasets.map((_, i) => chart.getDatasetMeta(i));
    let amberPt = null, mintPt = null;
    for (let i = 0; i < chart.data.datasets.length; i++) {
      const ds = chart.data.datasets[i];
      if (ds._swRole !== 'dot') continue;
      const el = metas[i].data[0];
      if (!el) continue;
      if (ds._swGroup === 'amber') amberPt = { x: el.x, y: el.y };
      if (ds._swGroup === 'mint') mintPt = { x: el.x, y: el.y };
    }
    if (!amberPt || !mintPt) return false;
    const dx = amberPt.x - mintPt.x;
    const dy = amberPt.y - mintPt.y;
    return Math.sqrt(dx * dx + dy * dy) < DOT_OVERLAP_THRESHOLD_PX;
  }

  /**
   * Handle chart click — activation toggle on dots only.
   */
  function handleChartClick(evt) {
    if (!chart) return;
    const hits = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
    const dotHit = hits.find(({ datasetIndex }) =>
      chart.data.datasets[datasetIndex]?._swRole === 'dot'
    );
    if (!dotHit) return;

    const group = chart.data.datasets[dotHit.datasetIndex]._swGroup;

    if (dotsOverlap()) {
      activeGroup = activeGroup === 'mint' ? 'amber' : 'mint';
    } else {
      activeGroup = group;
    }
    document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    renderDualState();
  }

  function computeChartData(rl) {
    const R = rl.C_RATIO;
    const x = rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1);
    const xBrAmberL = rl.xBrAmberL;
    const xSweet = rl.xSweet;
    const xBrAmberR = rl.xBrAmberR;
    const xBrRedR = rl.xBrRedR;
    const wallP = rl.wallP ?? (1 + R);

    const viewport = computeEoqViewport({ xBrAmberR, xSweet, xBrRedR, wallP, xCurrent: x, previousDomainMax: previousActualDomainMax });
    previousActualDomainMax = viewport.mainDomain.max;

    const domain = { minX: viewport.mainDomain.min, maxX: viewport.mainDomain.max, overflow: viewport.isPastWall ? 'right' : 'none' };

    const xEntryFallback = xBrAmberL > 1.01 ? xBrAmberL : 1.2;
    const costAtEntry = eoqCost(xEntryFallback, R, xSweet);
    const costAtWall = eoqCost(wallP, R, xSweet);
    const yMax = Math.max(costAtEntry, costAtWall) * 1.3;
    const curveData = sampleCurve(viewport.mainDomain.min, viewport.mainDomain.max, R, xSweet, SAMPLE_POINTS);
    const costAtX = x > 1 ? eoqCost(x, R, xSweet) : null;

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

    const { R, x, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP } = {
      R: rl.C_RATIO,
      x: rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1),
      xBrAmberL: rl.xBrAmberL,
      xSweet: rl.xSweet,
      xBrAmberR: rl.xBrAmberR,
      xBrRedR: rl.xBrRedR,
      wallP: rl.wallP ?? (1 + rl.C_RATIO),
    };

    const validation = validateLandmarks({ xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP });
    if (!validation.ok) {
      if (chart) { chart.destroy(); chart = null; }
      uvalEl.textContent = '—';
      return;
    }

    const { domain, curveData, yMax, costAtX, u } = computeChartData(rl);
    updateTopbar(u, status?.rateLamp?.mf);

    if (!chart) {
      // Resolve theme colors once
      resolveColors();

      // Initial datasets — single amber group (non-dirty default state)
      const initDatasets = buildGroupDatasets('amber', {
        curveData,
        xSweet,
        xAmberL: xBrAmberL,
        xAmberR: xBrAmberR,
        xRedR: xBrRedR,
        x,
        costAtX,
        yMax,
        R,
        domainMin: domain.minX,
        isActive: true,
      });

      // Plugin: draw br% label at current cost level on y-axis + "bill premium" axis title
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
        data: { datasets: initDatasets },
        plugins: [brLabelPlugin],
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: true,
              filter: (tooltipItem) => {
                return chart.data.datasets[tooltipItem.datasetIndex]?._swRole === 'dot';
              },
              callbacks: {
                label: (ctx) => {
                  const group = chart.data.datasets[ctx.datasetIndex]._swGroup;
                  return group === 'amber' ? 'Current state' : 'Preview state';
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
          onClick: handleChartClick,
        },
      });

      // Expose chart for depthAux ResizeObserver sync and e2e
      if (window.__SW_dashboard) window.__SW_dashboard.charts.hero = chart;

      // If entering buildChart with an active preview (race: event fired before first poll),
      // apply dual state on the freshly created chart.
      if (previewState?.dirty) {
        renderDualState();
      }
    } else {
      // Chart exists — incremental update
      if (previewState?.dirty) {
        // Dirty: rebuild both groups via renderDualState
        renderDualState();
      } else {
        // Non-dirty: update single amber group in-place (stable yMax, no jumps)
        const datasets = buildGroupDatasets('amber', {
          curveData,
          xSweet,
          xAmberL: xBrAmberL,
          xAmberR: xBrAmberR,
          xRedR: xBrRedR,
          x,
          costAtX,
          yMax,
          R,
          domainMin: domain.minX,
          isActive: true,
        });
        chart.data.datasets = datasets;
        chart.options.scales.x.min = domain.minX;
        chart.options.scales.x.max = domain.maxX;
        chart.options.scales.y.min = -yMax * 0.06;
        chart.options.scales.y.max = yMax;
        if (chart.options.plugins.brLabel) {
          chart.options.plugins.brLabel.br = status?.rateLamp?.br;
          chart.options.plugins.brLabel.costAtX = costAtX;
        }
        chart.update('none');
      }
    }

    // Update verdict row
    const verdict = positionVerdict(status?.rateLamp?.br, x, wallP, xSweet);
    verdictPill.textContent = ZONE_LABELS[verdict.zone] ?? verdict.zone;
    verdictText.innerHTML = verdict.caption;
  }

  function onBucketPreview(e) {
    const detail = e.detail ?? null;
    const wasDirty = previewState?.dirty;
    previewState = detail;

    if (detail?.dirty && !wasDirty) {
      // Entering dirty: activate mint (show user the result of their action)
      activeGroup = 'mint';
      document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    } else if (!detail?.dirty && wasDirty) {
      // Leaving dirty: revert to amber
      activeGroup = 'amber';
      document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    }
    // dirty → dirty: activeGroup unchanged (user's choice preserved)

    renderDualState();
  }

  function onExternalActiveGroup(e) {
    const newGroup = e.detail?.activeGroup;
    if (!newGroup || newGroup === activeGroup) return;
    activeGroup = newGroup;
    renderDualState();
  }

  document.addEventListener('sw-bucket-preview', onBucketPreview);
  document.addEventListener('sw-active-group', onExternalActiveGroup);

  function update(snapshot) {
    const currentSegment = snapshot?.status?.segment ?? null;
    let segmentChanged = false;
    if (currentSegment !== prevSegment) {
      previousActualDomainMax = null;
      prevSegment = currentSegment;
      segmentChanged = true;
    }

    const rl = snapshot?.status?.rateLamp;
    const capabilities = snapshot?.capabilities;
    if (!rl) return;
    const newX = rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1);
    if (!Number.isFinite(newX)) return;
    const newR = rl.C_RATIO;
    if (!Number.isFinite(newR)) return;
    lastRl = rl;  // Always cache latest for preview/topbar computations
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
    document.removeEventListener('sw-bucket-preview', onBucketPreview);
    document.removeEventListener('sw-active-group', onExternalActiveGroup);
    if (chart) { chart.destroy(); chart = null; }
    container.remove();
    verdictRow.remove();
  }

  return { update, destroy };
}
