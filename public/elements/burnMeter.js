// public/elements/burnMeter.js — Taxi-meter style burn progress (spec §2 #3)
// Fill bar + "~N turns" + odometer + pulse
// Capabilities gating: billingLedger → fill, breakEvenTurns → "~N turns"
// Element contract: mount(root, ctx) → { update(snapshot), destroy() }

const PULSE_DURATION_MS = 600;

export function mount(root, _ctx) {
  const container = document.createElement('div');
  container.className = 'sw-burn-meter';
  container.innerHTML = `
    <div>
      <span class="lab">Carry rent</span>
      <div class="sub">break-even meter · Karlin 1990</div>
    </div>
    <div class="sw-burn-turns">—<small> turns</small></div>
    <div class="sw-burn-meter-lab">until holding costs one restart · fills at <b class="sw-burn-rate-text">burn —/turn</b></div>
    <div class="sw-burn-bar-wrap">
      <div class="sw-burn-fill" style="width:0%;"></div>
    </div>
    <div class="sw-burn-cap">
      <span class="sw-burn-cap-left">this cycle —</span>
      <span>fills to 1.00 = one restart</span>
    </div>
    <div class="sw-burn-odometer">
      <span class="sw-burn-odo-digits"></span>
      <span class="olab">restarts burned (odometer)</span>
    </div>
    <div class="sw-burn-pulse" style="display:none;"></div>
  `;
  root.appendChild(container);

  const turnsEl = container.querySelector('.sw-burn-turns');
  const rateText = container.querySelector('.sw-burn-rate-text');
  const fillEl = container.querySelector('.sw-burn-fill');
  const barWrap = container.querySelector('.sw-burn-bar-wrap');
  const capLeft = container.querySelector('.sw-burn-cap-left');
  const odometerDigits = container.querySelector('.sw-burn-odo-digits');
  const pulseEl = container.querySelector('.sw-burn-pulse');

  let pulseTimeout = null;
  let lastPulseTurnSeq = null;

  function triggerPulse(burnRate) {
    pulseEl.textContent = `↑ rent +${burnRate != null ? burnRate.toFixed(2) : '—'}/turn · context growing`;
    pulseEl.style.display = '';
    barWrap.style.boxShadow = '0 0 8px 2px rgba(255,194,77,0.4)';
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulseTimeout = setTimeout(() => {
      barWrap.style.boxShadow = '';
      pulseEl.style.display = 'none';
      pulseTimeout = null;
    }, PULSE_DURATION_MS);
  }

  function renderOdometer(count) {
    // Render each digit of count as a separate "roll" span
    const digits = String(count).padStart(3, '0').split('');
    odometerDigits.innerHTML = digits
      .map(d => `<span class="roll">${d}</span>`)
      .join('');
  }

  function update(snapshot) {
    const rl = snapshot?.status?.rateLamp;
    const capabilities = snapshot?.capabilities;

    const burnRate = rl?.burnRate ?? rl?.kAvg ?? null;

    // "~N turns" label — gated by breakEvenTurns
    if (capabilities?.breakEvenTurns?.available && Number.isFinite(rl?.hBreak)) {
      const n = Math.ceil(rl.hBreak);
      turnsEl.innerHTML = `~${n}<small> turns</small>`;
    } else {
      turnsEl.innerHTML = `—<small> turns</small>`;
    }

    // Burn rate label
    if (burnRate != null) {
      rateText.textContent = `burn ${burnRate.toFixed(2)}/turn`;
    } else {
      rateText.textContent = 'burn —/turn';
    }

    // Fill bar — gated by billingLedger
    if (capabilities?.billingLedger?.available && rl?.billProgress != null) {
      const pct = Math.max(0, Math.min(100, rl.billProgress * 100));
      fillEl.style.width = `${pct.toFixed(1)}%`;
      capLeft.textContent = `this cycle ${rl.billProgress.toFixed(2)}`;
    } else {
      fillEl.style.width = '0%';
      capLeft.textContent = 'this cycle —';
    }

    // Odometer — billCycleCount (always displayed if present)
    const cycleCount = rl?.billCycleCount ?? 0;
    renderOdometer(cycleCount);

    // Pulse — when lastBillEvent.turnSeq matches currentTurnSeq and hasn't been pulsed yet
    if (rl?.lastBillEvent && rl.lastBillEvent.turnSeq === rl.currentTurnSeq) {
      if (lastPulseTurnSeq !== rl.currentTurnSeq) {
        lastPulseTurnSeq = rl.currentTurnSeq;
        triggerPulse(burnRate);
      }
    }
  }

  function destroy() {
    if (pulseTimeout) { clearTimeout(pulseTimeout); pulseTimeout = null; }
    container.remove();
  }

  return { update, destroy };
}
