// public/demo-app.js — static snapshot replay (no server needed)
// Loads pre-baked snapshots.json and feeds frames through the same store → elements pipeline.

// Intercept fetch to mock API endpoints that dashboard elements call directly
const _realFetch = window.fetch;
window.fetch = function(url, opts) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    // Mock /api/pricing (GET)
    if (url === '/api/pricing' && (!opts || opts.method === 'GET' || !opts.method)) {
      return Promise.resolve(new Response(JSON.stringify({
        effective: { ratio: 12.5, readToWrite: 0.08, source: 'preset', readPrice: 0.3, writePrice: 3.75 },
        saved: null,
        modelDefault: { model: 'sonnet-4.6', ratio: 12.5, readPrice: null, writePrice: null },
        presets: [
          { id: 'opus-4.8', label: 'Claude Opus 4.8', readPrice: 0.5, writePrice: 6.25 },
          { id: 'sonnet-5', label: 'Claude Sonnet 5', readPrice: 0.2, writePrice: 2.5 },
          { id: 'sonnet-4.6', label: 'Claude Sonnet 4.6', readPrice: 0.3, writePrice: 3.75 },
          { id: 'haiku-4.5', label: 'Claude Haiku 4.5', readPrice: 0.1, writePrice: 1.25 },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    // Mock POST/DELETE to pricing (no-op success)
    if (url === '/api/pricing') {
      return Promise.resolve(new Response(JSON.stringify({
        effective: { ratio: 12.5, readToWrite: 0.08, source: 'preset', readPrice: 0.3, writePrice: 3.75 },
        saved: null,
        modelDefault: { model: 'sonnet-4.6', ratio: 12.5, readPrice: null, writePrice: null },
        presets: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    // Catch-all for any other /api/* — return empty success
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  return _realFetch.apply(this, arguments);
};

import { createStore } from './lib/store.js';
import { buildCapabilities } from './lib/featureDetect.js';
import { mount as mountHistoryChart } from './elements/historyChart.js';
import { mount as mountHeroDiptych } from './elements/heroDiptych.js';
import { mount as mountDepthAux } from './elements/depthAux.js';
import { mount as mountBurnMeter } from './elements/burnMeter.js';
import { mount as mountPricingChip } from './elements/pricingChip.js';
import { mount as mountChrome } from './elements/chrome.js';
import { mount as mountThemeChip } from './elements/themeChip.js';
import { mount as mountBucketPanel } from './elements/bucketPanel.js';
import { mount as mountTerms } from './elements/terms.js';

const store = createStore();

// Fake transport that satisfies the interface elements expect
const transport = {
  connectionState: 'replay',
  bucketState: { isFetching: false, consecutiveFailures: 0, lastSuccessAt: Date.now() },
  onData() { return () => {}; },
  onTick() { return () => {}; },
  onStateChange() { return () => {}; },
  onBucketState() { return () => {}; },
  refresh() {},
  start() {},
  destroy() {},
};

const elements = [];

function registerElement(mountFn, slotId) {
  elements.push({ mountFn, slotId, instance: null });
}

function mountAll() {
  const ctx = { transport, store };
  for (const el of elements) {
    const root = document.getElementById(el.slotId);
    if (root) el.instance = el.mountFn(root, ctx);
  }
  store.subscribe((snapshot) => {
    for (const el of elements) {
      try { el.instance?.update(snapshot); }
      catch (err) { console.error(`[sw-demo] ${el.slotId} update failed`, err); }
    }
  });

  // Theme change support
  document.addEventListener('sw-theme-change', () => {
    for (const el of elements) {
      try { el.instance?.destroy(); } catch {}
      const root = document.getElementById(el.slotId);
      if (root) {
        el.instance = el.mountFn(root, ctx);
        const snap = store.getSnapshot();
        if (snap) try { el.instance?.update(snap); } catch {}
      }
    }
  });
}

// Element registrations (same as app.js)
registerElement(mountChrome, 'sw-chrome');
registerElement(mountThemeChip, 'sw-chrome');
registerElement(mountPricingChip, 'sw-chrome');
registerElement(mountBucketPanel, 'sw-buckets');
registerElement(mountTerms, 'sw-terms');
registerElement(mountHeroDiptych, 'sw-hero');
registerElement(mountDepthAux, 'sw-hero');
registerElement(mountBurnMeter, 'sw-hero');
registerElement(mountHistoryChart, 'sw-history');

async function startDemo() {
  // Load snapshots
  const res = await fetch('./snapshots.json');
  if (!res.ok) {
    document.body.innerHTML = '<p style="color:red;padding:2rem">Failed to load snapshots.json — run: node scripts/bake-demo-snapshots.mjs</p>';
    return;
  }
  const data = await res.json();
  const { frames, histories } = data;

  // Speed control via URL param: ?speed=300 (ms per frame), default 500
  const params = new URLSearchParams(location.search);
  const intervalMs = Math.max(100, parseInt(params.get('speed') || '500', 10));

  mountAll();

  let i = 0;
  let timer = null;
  let paused = false;

  function advance() {
    if (i >= frames.length) {
      // Reached end — stop playback
      paused = true;
      if (timer) { clearInterval(timer); timer = null; }
      updateControls();
      return;
    }
    const status = frames[i];
    // Reconstruct full history: all prior segments + current segment sliced to _histLen
    const curSeg = status.segment ?? 0;
    let frameHistory = [];
    for (const [segKey, segHist] of Object.entries(histories)) {
      const segNum = Number(segKey);
      if (segNum < curSeg) {
        frameHistory = frameHistory.concat(segHist);
      } else if (segNum === curSeg) {
        frameHistory = frameHistory.concat(segHist.slice(0, status._histLen || 0));
      }
    }
    // Extract bucket data baked into this frame
    const bucketData = status._bucketData || null;
    const capabilities = buildCapabilities(status);
    store.update(status, frameHistory, capabilities, bucketData);
    i++;
    updateControls();
  }

  // --- Playback controls UI ---
  const controls = document.createElement('div');
  controls.className = 'sw-demo-controls';
  controls.innerHTML = `
    <button id="sw-demo-pause" title="Pause/Resume">⏸</button>
    <button id="sw-demo-prev" title="Previous frame">⏮</button>
    <button id="sw-demo-next" title="Next frame">⏭</button>
    <span id="sw-demo-info"></span>
  `;
  document.body.appendChild(controls);

  // Minimal styling for controls
  const style = document.createElement('style');
  style.textContent = `
    .sw-demo-controls {
      position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 0.5rem;
      background: var(--sw-bg-panel, #1a1d23); border: 1px solid var(--sw-border, #2a2d35);
      border-radius: 8px; padding: 0.4rem 1rem; z-index: 9999;
      font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
      color: var(--sw-text-secondary, #8b8f96);
    }
    .sw-demo-controls button {
      background: none; border: none; color: inherit; cursor: pointer;
      font-size: 1.1rem; padding: 0.2rem 0.4rem; border-radius: 4px;
    }
    .sw-demo-controls button:hover { background: var(--sw-border, #2a2d35); }
  `;
  document.head.appendChild(style);

  const pauseBtn = document.getElementById('sw-demo-pause');
  const prevBtn = document.getElementById('sw-demo-prev');
  const nextBtn = document.getElementById('sw-demo-next');
  const infoSpan = document.getElementById('sw-demo-info');

  function updateControls() {
    const frameIdx = Math.max(0, Math.min(i - 1, frames.length - 1));
    const frame = frames[frameIdx];
    const step = frame._replay?.step || (frameIdx + 1);
    const total = frame._replay?.total || frames.length;
    const done = i >= frames.length;
    infoSpan.textContent = done ? `${total}/${total} · done` : `${step}/${total} · ${intervalMs}ms`;
    pauseBtn.textContent = paused ? '▶' : '⏸';
  }

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    if (paused) { clearInterval(timer); timer = null; }
    else {
      // If at end, restart from beginning
      if (i >= frames.length) i = 0;
      timer = setInterval(advance, intervalMs);
    }
    updateControls();
  });

  prevBtn.addEventListener('click', () => {
    if (i > 1) { i -= 2; advance(); }
    else if (i === 1) { i = 0; advance(); }
  });

  nextBtn.addEventListener('click', () => {
    advance();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === 'ArrowLeft' || e.key === 'j') { prevBtn.click(); }
    else if (e.key === 'ArrowRight' || e.key === 'l') { nextBtn.click(); }
  });

  // Show first frame immediately
  advance();

  // Start auto-advance
  timer = setInterval(advance, intervalMs);
}

startDemo();
