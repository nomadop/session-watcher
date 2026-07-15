// public/elements/chrome.js — Title bar + identity + connection indicator (spec §2 #13)
// Shows: "Session Watcher" title, segment/uptime, connection state dot
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

const CONNECTION_STATES = {
  connecting:    { color: '#eab308', label: 'connecting' },    // yellow
  'sse-live':    { color: '#22c55e', label: 'SSE live' },      // green
  polling:       { color: '#3b82f6', label: 'polling' },       // blue
  disconnected:  { color: '#ef4444', label: 'disconnected' },  // red
};

function formatUptime(startedAt) {
  if (!startedAt) return null;
  const seconds = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  // Fix #12: new Date("invalid").getTime() → NaN → Math.floor(NaN/1000) → NaN; NaN < 0 is false, so
  // a garbage startedAt would previously pass through and produce "NaNh NaNm". Guard with isFinite.
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function mount(root, ctx) {
  const { transport } = ctx;

  // ── DOM Construction ────────────────────────────────────────────────────────

  const bar = document.createElement('div');
  bar.className = 'sw-chrome-bar';

  bar.innerHTML = `
    <span class="sw-chrome-mark">SW</span>
    <b class="sw-chrome-title">Session Watcher</b>
    <span class="sw-chrome-tag">Range</span>
    <span class="sw-chrome-spacer"></span>
    <span class="sw-chrome-conn">
      <span class="sw-chrome-conn-dot" aria-hidden="true"></span>
      <span class="sw-chrome-conn-label">connecting</span>
    </span>
    <span class="sw-chrome-meta"></span>
  `;

  root.appendChild(bar);

  const dot = bar.querySelector('.sw-chrome-conn-dot');
  const connLabel = bar.querySelector('.sw-chrome-conn-label');
  const connWrap = bar.querySelector('.sw-chrome-conn');
  const meta = bar.querySelector('.sw-chrome-meta');

  // Fix #3: stop-banner for lastStopEvent alerts (wall/gate/empty_burn).
  // Inserted AFTER #sw-chrome (between chrome bar and hero) so it gets its own row.
  const bannerEl = document.createElement('div');
  bannerEl.className = 'sw-chrome-stop-banner';
  bannerEl.hidden = true;
  root.parentNode.insertBefore(bannerEl, root.nextSibling);

  // ── Connection state ────────────────────────────────────────────────────────

  function applyConnectionState(state) {
    const cfg = CONNECTION_STATES[state] || { color: '#94a3b8', label: state };
    dot.style.background = cfg.color;
    dot.style.boxShadow = `0 0 7px ${cfg.color}`;
    connLabel.textContent = cfg.label;
    // Update the badge color to reflect state
    if (state === 'sse-live') {
      connWrap.style.color = 'var(--mint)';
      connWrap.style.background = 'rgba(79,224,176,0.1)';
      connWrap.style.borderColor = 'var(--mint-dim)';
    } else if (state === 'disconnected') {
      connWrap.style.color = 'var(--coral)';
      connWrap.style.background = 'rgba(255,117,102,0.1)';
      connWrap.style.borderColor = 'rgba(255,117,102,0.4)';
    } else {
      connWrap.style.color = '';
      connWrap.style.background = '';
      connWrap.style.borderColor = '';
    }
  }

  // Read initial state at mount
  applyConnectionState(transport.connectionState);

  // Subscribe to state changes
  const unsubscribe = transport.onStateChange((state) => {
    applyConnectionState(state);
  });

  // ── Uptime via SSE tick ─────────────────────────────────────────────────────

  // Track segment separately so tick can render uptime without a full snapshot
  let lastSegment = null;
  let lastUptime = null;

  function renderMeta() {
    const parts = [];
    if (lastSegment != null) parts.push(`seg ${lastSegment}`);
    if (lastUptime != null && Number.isFinite(lastUptime)) {
      const seconds = Math.floor(lastUptime);
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      parts.push(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`);
    }
    meta.textContent = parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  const unsubTick = transport.onTick((uptime) => {
    lastUptime = uptime;
    renderMeta();
  });

  // ── Snapshot update ─────────────────────────────────────────────────────────

  function update(snapshot) {
    const status = snapshot?.status;
    if (!status) {
      meta.textContent = '';
      bannerEl.hidden = true;
      return;
    }

    // Update segment from snapshot
    if (status.segment != null) {
      lastSegment = status.segment;
    } else if (snapshot?.status?.rateLamp?.billCycleCount != null) {
      lastSegment = snapshot.status.rateLamp.billCycleCount;
    }

    // Sync uptime from snapshot (calibrate with server value)
    if (status.uptime != null && Number.isFinite(status.uptime)) {
      lastUptime = status.uptime;
    } else if (status.startedAt) {
      const ut = formatUptime(status.startedAt);
      if (ut) lastUptime = Math.floor((Date.now() - new Date(status.startedAt).getTime()) / 1000);
    }
    renderMeta();

    // Fix #3: stop-banner — show when lastStopEvent is for the current turn
    const rl = snapshot?.status?.rateLamp;
    const stopEvt = rl?.lastStopEvent;
    if (stopEvt && stopEvt.turnSeq === rl.currentTurnSeq) {
      bannerEl.textContent = `⚠ ${stopEvt.kind}: ${stopEvt.message}`;
      bannerEl.hidden = false;
    } else {
      bannerEl.hidden = true;
    }
  }

  function destroy() {
    unsubscribe();
    unsubTick();
    bar.remove();
    bannerEl.remove();
  }

  return { update, destroy };
}
