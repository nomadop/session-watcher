// Dual-bar rent meter (spec §3.4). Renders from status.rateLamp.rentMeter — NO re-derivation of
// notification/backstop logic (spec invariant 10). Cycle bar = micro timescale (billProgress); depth
// bar = macro (deep-water backstop progress), disabled until gate fires.
import { MAG_VISIBLE_TICKS } from '../lib/uiConstants.js';  // mirror of lib/constants MAG_VISIBLE_TICKS (5)

export function mount(root, _ctx) {
  const container = document.createElement('div');
  container.className = 'sw-burn-meter';
  container.innerHTML = `
    <div>
      <span class="lab">Carry rent</span>
      <div class="sub">break-even meter · Karlin 1990</div>
    </div>
    <div class="bar-group cycle-group">
      <span class="bar-name">cycle</span>
      <div class="bar-inline">
        <div class="bar-track"><div class="bar-fill cycle" style="width:0%"></div></div>
        <div class="bar-tail"><span class="bar-inline-value">—</span></div>
      </div>
      <div class="bar-detail">rent <span class="hl">—</span>/turn (sweet: —)</div>
    </div>
    <div class="bar-group depth-group disabled">
      <span class="bar-name">depth</span>
      <div class="bar-with-mag">
        <div class="bar-track">
          <div class="bar-fill depth" style="width:0%"></div>
          <div class="bar-ticks"></div>
        </div>
        <div class="mag-tail"><div class="mag-ticks"></div></div>
      </div>
      <div class="bar-detail">awaiting gate · reminder inactive</div>
    </div>
  `;
  root.appendChild(container);

  const cycleFill = container.querySelector('.bar-fill.cycle');
  const cycleValue = container.querySelector('.cycle-group .bar-inline-value');
  const cycleDetail = container.querySelector('.cycle-group .bar-detail');
  const depthGroup = container.querySelector('.depth-group');
  const depthFill = container.querySelector('.bar-fill.depth');
  const depthTicks = container.querySelector('.bar-ticks');
  const magTicks = container.querySelector('.mag-ticks');
  const depthDetail = container.querySelector('.depth-group .bar-detail');

  let _prevTickCount = -1;
  function renderTickSegments(n) {
    const count = Math.max(0, Math.min(20, Math.round(n) || 0));
    if (count === _prevTickCount) return;
    _prevTickCount = count;
    depthTicks.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const seg = document.createElement('div');
      seg.className = 'bar-tick-segment';
      depthTicks.appendChild(seg);
    }
  }

  let _prevMagKey = null;
  function renderMagazine(lapCount, hot) {
    const spent = Math.max(0, lapCount || 0);
    const visible = Math.min(spent, MAG_VISIBLE_TICKS);
    const key = `${spent}:${hot}`;
    if (key === _prevMagKey) return;
    _prevMagKey = key;
    magTicks.innerHTML = '';
    for (let i = 0; i < MAG_VISIBLE_TICKS; i++) {
      const t = document.createElement('div');
      t.className = 'mag-tick' + (i < visible ? ' spent' : '') + (i < visible && hot ? ' hot' : '');
      magTicks.appendChild(t);
    }
    // existing overflow node
    let ov = container.querySelector('.mag-overflow');
    if (spent > MAG_VISIBLE_TICKS) {
      if (!ov) { ov = document.createElement('span'); ov.className = 'mag-overflow'; container.querySelector('.mag-tail').appendChild(ov); }
      ov.textContent = `+${spent - MAG_VISIBLE_TICKS}`;
    } else if (ov) { ov.remove(); }
  }

  // Null-safe default so a missing rentMeter (server always sends one now, but be defensive) resets the
  // frame instead of leaving a stale bar (review fold, GPT #15).
  const EMPTY_RM = { cycleProgress: 0, rentRate: null, sweetRentRate: null, depthActive: false, depthProgress: 0, backstopInterval: null, backstopLapCount: 0, depthHot: false };

  function update(snapshot) {
    const rm = snapshot?.status?.rateLamp?.rentMeter || EMPTY_RM;
    const cyclePct = Math.round(Math.min(1, Math.max(0, rm.cycleProgress ?? 0)) * 100);
    cycleFill.style.width = `${cyclePct}%`;
    cycleValue.textContent = `${cyclePct}%`;
    const rent = Number.isFinite(rm.rentRate) ? rm.rentRate.toFixed(2) : '—';
    const sweet = Number.isFinite(rm.sweetRentRate) ? rm.sweetRentRate.toFixed(2) : '—';
    cycleDetail.innerHTML = `rent <span class="hl">${rent}</span>/turn (sweet: ${sweet})`;

    if (rm.depthActive) {
      depthGroup.classList.remove('disabled');
      const depthPct = Math.round(Math.min(1, Math.max(0, rm.depthProgress ?? 0)) * 100);
      depthFill.className = 'bar-fill ' + (rm.depthHot ? 'depth-hot' : 'depth');
      depthFill.style.width = `${depthPct}%`;
      renderTickSegments(rm.backstopInterval);
      renderMagazine(rm.backstopLapCount, rm.depthHot);
      const denom = Number.isFinite(rm.backstopInterval) ? Math.max(1, Math.round(rm.backstopInterval)) : '—';
      depthDetail.textContent = (rm.backstopLapCount > 0)
        ? `${(rm.depthProgress ?? 0).toFixed(1)}× amber depth`
        : `next reminder at ${denom} deep-water cycles`;
    } else {
      depthGroup.classList.add('disabled');
      depthFill.style.width = '0%';
      renderTickSegments(0);
      renderMagazine(0, false);
      depthDetail.textContent = 'awaiting gate · reminder inactive';
    }
  }

  function destroy() { container.remove(); }
  return { update, destroy };
}
