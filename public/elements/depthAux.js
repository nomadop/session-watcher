// public/elements/depthAux.js — Full-domain [1, wallP] overview bar with viewport frame (spec §3)
import { computeEoqViewport, computeLandmarkPositions, validateLandmarks } from '../lib/xScale.js';
import { computePreviewLandmarks } from './heroDiptych.js';
import { MIN_B_PREVIEW } from '../lib/uiConstants.js';
import { computePreviewBr } from '../chart-helpers.js';

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
        <div class="sw-aux-marker sw-aux-marker-amber" style="display:none;"></div>
        <div class="sw-aux-marker sw-aux-marker-mint" style="display:none;"></div>
      </div>
    </div>
  `;
  root.appendChild(container);

  const barWrap = container.querySelector('.sw-aux-bar-wrap');
  const gradientEl = container.querySelector('.sw-aux-gradient');
  const frameEl = container.querySelector('.sw-aux-viewport-frame');
  const amberMarkerEl = container.querySelector('.sw-aux-marker-amber');
  const mintMarkerEl = container.querySelector('.sw-aux-marker-mint');
  const ticksEl = container.querySelector('.sw-aux-ticks');

  // Overlap threshold in pixels — matches heroDiptych DOT_OVERLAP_THRESHOLD_PX (4px).
  // offsetLeft gives position relative to the offsetParent (the bar container), which is
  // exactly what we want; no layout thrashing vs getBoundingClientRect.
  const MARKER_OVERLAP_PX = 4;

  function markersOverlap() {
    return Math.abs(amberMarkerEl.offsetLeft - mintMarkerEl.offsetLeft) < MARKER_OVERLAP_PX;
  }

  function handleMarkerClick(clickedGroup) {
    if (markersOverlap()) {
      // Toggle when overlapping (same logic as heroDiptych dotsOverlap)
      activeGroup = activeGroup === 'mint' ? 'amber' : 'mint';
    } else {
      activeGroup = clickedGroup;
    }
    document.dispatchEvent(new CustomEvent('sw-active-group', { detail: { activeGroup } }));
    if (lastSnapshot) renderBar(lastSnapshot);
  }

  amberMarkerEl.addEventListener('click', () => handleMarkerClick('amber'));
  mintMarkerEl.addEventListener('click', () => handleMarkerClick('mint'));

  let resizeObserver = null;
  let previousDomainMax = null;
  let prevSegment = null;
  let previewState = null;
  let lastSnapshot = null;
  let activeGroup = 'amber';

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
      amberMarkerEl.style.display = 'none';
      mintMarkerEl.style.display = 'none';
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

    // Ghost-aware viewport expansion (syncs with heroDiptych)
    let previewGroup = undefined;
    let prevLandmarks = null;
    if (previewState?.dirty && previewState?.B_preview) {
      const g = rl.gEma ?? rl.g ?? 0;
      const L = rl.L_read ?? 0;
      prevLandmarks = computePreviewLandmarks({ B_preview: previewState.B_preview, R, g, L, mf: rl.mf });
      previewGroup = { xRedR: prevLandmarks.xRedR, x: prevLandmarks.x };
    }

    const viewport = computeEoqViewport({ xBrAmberR, xSweet, xBrRedR, wallP, xCurrent: x, previousDomainMax, previewGroup });
    // Only actual data advances ratchet (ghost expansion is ephemeral).
    // actualDomainMax is the pre-ghost domain max, so it's safe to use directly.
    previousDomainMax = viewport.actualDomainMax;

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

    // Dual markers: amber (current) + mint (preview)
    const overviewRange = viewport.overviewDomain.max - viewport.overviewDomain.min;
    const toPct = (xVal) => overviewRange > 0
      ? Math.max(0, Math.min(100, ((xVal - viewport.overviewDomain.min) / overviewRange) * 100))
      : 0;

    const amberPct = toPct(x);
    const dirty = !!(previewGroup && prevLandmarks);

    // Amber marker — always visible
    amberMarkerEl.style.display = '';
    amberMarkerEl.style.left = `${amberPct.toFixed(1)}%`;
    amberMarkerEl.style.opacity = (dirty && activeGroup === 'mint') ? '0.35' : '1';
    amberMarkerEl.style.pointerEvents = dirty ? 'auto' : 'none';

    // Mint marker — only when preview dirty
    if (dirty) {
      const mintPct = toPct(prevLandmarks.x);
      mintMarkerEl.style.display = '';
      mintMarkerEl.style.left = `${mintPct.toFixed(1)}%`;
      mintMarkerEl.style.opacity = activeGroup === 'amber' ? '0.35' : '1';
      mintMarkerEl.style.pointerEvents = 'auto';
    } else {
      mintMarkerEl.style.display = 'none';
    }

    // Flag label — only on active marker
    const activeX = (activeGroup === 'mint' && dirty) ? prevLandmarks.x : x;
    const activeMarkerEl = (activeGroup === 'mint' && dirty) ? mintMarkerEl : amberMarkerEl;
    const inactiveMarkerEl = (activeGroup === 'mint' && dirty) ? amberMarkerEl : mintMarkerEl;

    // Compute br for active group
    let brVal = snapshot?.status?.rateLamp?.br;
    if (activeGroup === 'mint' && prevLandmarks) {
      const dhat = prevLandmarks.dhat;
      if (dhat > 0 && prevLandmarks.x > 1) {
        const mf = prevLandmarks.mf ?? rl.mf ?? 0.3;
        const u = (prevLandmarks.x - 1) / dhat;
        brVal = computePreviewBr(mf, u);
      }
    }

    const brSuffix = Number.isFinite(brVal) ? ` · b+${Math.floor(brVal * 100)}%` : '';
    const flagText = activeX >= wallP
      ? `x <b>${activeX.toFixed(2)}×</b> · past wall`
      : `x <b>${activeX.toFixed(2)}×</b>${brSuffix}`;
    activeMarkerEl.innerHTML = `<span class="sw-aux-flag">${flagText}</span>`;
    inactiveMarkerEl.innerHTML = '';

    syncToChartArea();
  }

  function onBucketPreview(e) {
    previewState = e.detail ?? null;
    if (lastSnapshot) renderBar(lastSnapshot);
  }

  function onActiveGroup(e) {
    const newGroup = e.detail?.activeGroup ?? 'amber';
    if (newGroup === activeGroup) return;
    activeGroup = newGroup;
    if (lastSnapshot) renderBar(lastSnapshot);
  }

  document.addEventListener('sw-bucket-preview', onBucketPreview);
  document.addEventListener('sw-active-group', onActiveGroup);

  function update(snapshot) {
    lastSnapshot = snapshot;
    if (!resizeObserver) setupResizeObserver();
    renderBar(snapshot);
  }

  function destroy() {
    document.removeEventListener('sw-bucket-preview', onBucketPreview);
    document.removeEventListener('sw-active-group', onActiveGroup);
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    container.remove();
  }

  return { update, destroy };
}
