// public/elements/depthAux.js — Full-domain [1, wallP] overview bar with viewport frame (spec §3)
import { computeEoqViewport, computeLandmarkPositions, validateLandmarks } from '../lib/xScale.js';

/** Resolve a CSS custom property to its computed value, with fallback. */
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name)?.trim();
  return v || fallback;
}

export function mount(root, _ctx) {
  const container = document.createElement('div');
  container.className = 'sw-depth-aux';
  container.innerHTML = `
    <div class="sw-aux-bar-outer" style="position:relative;">
      <div class="sw-aux-bar-wrap">
        <div class="sw-aux-gradient"></div>
        <div class="sw-aux-viewport-frame"></div>
        <div class="sw-aux-ticks" style="position:absolute;top:0;bottom:0;left:0;right:0;pointer-events:none;overflow:visible;"></div>
        <div class="sw-aux-marker" style="display:none;"></div>
      </div>
    </div>
  `;
  root.appendChild(container);

  const barWrap = container.querySelector('.sw-aux-bar-wrap');
  const gradientEl = container.querySelector('.sw-aux-gradient');
  const frameEl = container.querySelector('.sw-aux-viewport-frame');
  const markerEl = container.querySelector('.sw-aux-marker');
  const ticksEl = container.querySelector('.sw-aux-ticks');

  let resizeObserver = null;
  let previousDomainMax = null;
  let prevSegment = null;

  function syncToChartArea() {
    const heroChart = window.__SW_dashboard?.charts?.hero;
    if (!heroChart?.chartArea) return;
    const ca = heroChart.chartArea;
    barWrap.style.marginLeft = `${ca.left}px`;
    barWrap.style.width = `${ca.width}px`;
  }

  function setupResizeObserver() {
    const heroCanvas = document.querySelector('.sw-hero-diptych .sw-hero-canvas');
    if (!heroCanvas) return;
    resizeObserver = new ResizeObserver(() => syncToChartArea());
    resizeObserver.observe(heroCanvas);
  }

  // Theme colors for gradient
  const zoneShallow = cssVar(container, '--zone-shallow', '#3f8a6a');
  const zoneSweet = cssVar(container, '--zone-sweet', '#4fe0b0');
  const zoneDeep = cssVar(container, '--zone-deep', '#ffc24d');
  const zoneWall = cssVar(container, '--zone-wall', '#ff7566');

  function buildZonesGradient(entryPct, sweetPct, exitPct, wallPct) {
    return `linear-gradient(90deg, ${zoneShallow} 0%, ${zoneSweet} ${sweetPct}%, ${zoneDeep} ${exitPct}%, ${zoneWall} ${wallPct}%)`;
  }

  function buildLabelsHTML(entryPct, sweetPct, exitPct, wallPct, barWidth) {
    // Two-end-mounted + middle flat strategy (spec §3.3)
    const labels = [];
    // External left: "shallow"
    labels.push(`<span class="sw-aux-label-ext-left">shallow</span>`);
    // External right: "wall"
    labels.push(`<span class="sw-aux-label-ext-right">wall</span>`);
    // Internal: sweet and deep (only if bar wide enough)
    if (barWidth >= 120) {
      const sweetMid = ((entryPct + exitPct) / 2).toFixed(1);
      const deepMid = ((exitPct + wallPct) / 2).toFixed(1);
      labels.push(`<span class="sw-aux-zone-label" style="left:${sweetMid}%;color:#052018">sweet</span>`);
      labels.push(`<span class="sw-aux-zone-label" style="left:${deepMid}%;color:#3a2a08">deep</span>`);
    }
    return labels.join('');
  }

  function renderBar(snapshot) {
    const rl = snapshot?.status?.rateLamp;
    const capabilities = snapshot?.capabilities;
    const available = capabilities?.eoqLandmarks?.available === true;

    if (!available || !rl) {
      gradientEl.style.background = 'none';
      markerEl.style.display = 'none';
      frameEl.style.display = 'none';
      ticksEl.innerHTML = '';
      barWrap.style.display = 'none';
      return;
    }

    barWrap.style.display = '';

    const R = rl.C_RATIO;
    const x = rl.lBase > 0 ? rl.L_read / rl.lBase : (rl.x_display ?? 1);
    const xBrAmberL = rl.xBrAmberL;
    const xSweet = rl.xSweet;
    const xBrAmberR = rl.xBrAmberR;
    const xBrRedR = rl.xBrRedR;
    const wallP = rl.wallP ?? (1 + R);

    const validation = validateLandmarks({ xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP });
    if (!validation.ok) {
      barWrap.style.display = 'none';
      return;
    }

    // Segment change resets ratchet — uses snapshot.status.segment (always in API response)
    const currentSegment = snapshot?.status?.segment ?? null;
    if (currentSegment !== prevSegment) {
      previousDomainMax = null;
      prevSegment = currentSegment;
    }

    const viewport = computeEoqViewport({ xBrAmberR, xSweet, xBrRedR, wallP, xCurrent: x, previousDomainMax });
    previousDomainMax = viewport.mainDomain.max;

    // Overview always uses [1, wallP] domain for gradient + labels
    const overviewDomain = { minX: viewport.overviewDomain.min, maxX: viewport.overviewDomain.max };
    const positions = computeLandmarkPositions({ domain: overviewDomain, xBrAmberL, xSweet, xBrAmberR, xBrRedR, wallP, x });

    // Gradient: shallow→sweet→deep(at br25%)→wall
    gradientEl.style.background = buildZonesGradient(
      positions.brAmberLPct, positions.sweetPct, positions.brRedRPct, positions.wallPct
    );

    // Viewport frame (spec §3.2)
    frameEl.style.display = '';
    frameEl.style.left = `${viewport.viewportPct.left.toFixed(1)}%`;
    frameEl.style.width = `${(viewport.viewportPct.right - viewport.viewportPct.left).toFixed(1)}%`;

    // Labels
    const barWidth = barWrap.offsetWidth || 200;
    ticksEl.innerHTML = buildLabelsHTML(
      positions.brAmberLPct, positions.sweetPct, positions.brRedRPct, positions.wallPct, barWidth
    );

    // Marker + flag (x + br suffix — spec §3.5)
    markerEl.style.display = '';
    markerEl.style.left = `${viewport.markerPct.toFixed(1)}%`;
    const brVal = snapshot?.status?.rateLamp?.br;
    const brSuffix = Number.isFinite(brVal) ? ` · b+${Math.floor(brVal * 100)}%` : '';
    const flagText = viewport.isPastWall
      ? `x <b>${x.toFixed(2)}×</b> · past wall`
      : `x <b>${x.toFixed(2)}×</b>${brSuffix}`;
    markerEl.innerHTML = `<span class="sw-aux-flag">${flagText}</span>`;

    syncToChartArea();
  }

  function update(snapshot) {
    if (!resizeObserver) setupResizeObserver();
    renderBar(snapshot);
  }

  function destroy() {
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    container.remove();
  }

  return { update, destroy };
}
