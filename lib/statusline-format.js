// Statusline render helpers v3 — new layout with carousel, u/Δ/countdown, alert second line.
// Pure render, no DOM/IO. Runs under `node --test`.

// ── Model tag (unchanged) ──────────────────────────────────────────────────────────────────────────
export const tagOf = (model) => {
  const m = model || "";
  return m ? m.match(/opus|sonnet|haiku|deepseek/i)?.[0] || m : "model";
};

// ── Compact number formatter ───────────────────────────────────────────────────────────────────────
const kFmt = (n) => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return (n / 1000).toFixed(0) + "k";
  return String(n);
};

// ── BAND_LAMP (v3: below_entry → ⚪, no label field) ───────────────────────────────────────────────
const BAND_LAMP = {
  below_entry: "⚪",
  entry_to_sweet: "🟢",
  sweet_to_exit: "🟢",
  above_exit: "🟡",
};

// ── renderLamp: band + deep override → emoji ──────────────────────────────────────────────────────
export function renderLamp(band, deepOverride) {
  if (deepOverride) return "🟡";
  return BAND_LAMP[band] ?? "⚪";
}

// ── renderMeterV3: 10-char bar + space + 3-char percent ───────────────────────────────────────────
// Total visual: `▮▮▮▮▮▮░░░░ 63%` (bar space percent). Space-padded percent.
export function renderMeterV3(billProgress) {
  const bp = Math.min(0.999999, Math.max(0, billProgress ?? 0));
  const pct = Math.floor(bp * 100);
  const filled = Math.floor(bp * 10);
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  const pctStr = String(pct).padStart(3, " ");
  return `${bar} ${pctStr}%`;
}

// ── renderBillCount: × + 2-char space-padded number (capped at 99 for fixed 3-char width) ─────────
export function renderBillCount(count) {
  const n = Math.min(count ?? 0, 99);
  if (n >= 10) return `×${n}`;
  return `× ${n}`;
}

// ── renderCountdown: fixed 4-char `---t`/`~08t`/`+99t`/`~00t` ────────────────────────────────────
export function renderCountdown(rl, L) {
  const target = rl?.targetL;
  const rate = rl?.deltaLPerTurn;
  if (!Number.isFinite(target) || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(L)) return "---t";
  if (target <= L) return "~00t";
  const n = Math.ceil((target - L) / rate);
  if (n > 99) return "+99t";
  return `~${String(n).padStart(2, "0")}t`;
}

// ── renderU: u = (x_display - 1) / dhat ──────────────────────────────────────────────────────────
export function renderU(rl) {
  const x = rl?.x_display;
  const dhat = rl?.dhat;
  if (!Number.isFinite(x) || !Number.isFinite(dhat) || dhat <= 0) return "u---";
  const u = (x - 1) / dhat;
  if (!Number.isFinite(u)) return "u---";
  return `u${u.toFixed(1)}`;
}

// ── renderDelta: module-level EMA of L changes ────────────────────────────────────────────────────
let _prevL = null;
let _smoothDelta = null;
const DELTA_ALPHA = 0.3;

export function renderDelta(L) {
  if (!Number.isFinite(L)) return "Δ----";
  if (_prevL === null) {
    _prevL = L;
    return "Δ----";
  }
  const raw = Math.abs(L - _prevL);
  _prevL = L;
  if (_smoothDelta === null) {
    _smoothDelta = raw;
  } else {
    _smoothDelta = DELTA_ALPHA * raw + (1 - DELTA_ALPHA) * _smoothDelta;
  }
  // Format: Δ + 4-char value (fixed 5-char total)
  // Ranges: Δ---- | Δ 800 | Δ3.2k | Δ 12k | Δ120k
  const d = _smoothDelta;
  if (d < 1) return "Δ----";
  if (d >= 100000) {
    const kVal = Math.min(Math.round(d / 1000), 999);
    return `Δ${kVal}k`;
  }
  if (d >= 10000) {
    const kVal = String(Math.round(d / 1000));
    return `Δ${kVal.padStart(3, " ")}k`;
  }
  if (d >= 1000) {
    const s = (d / 1000).toFixed(1);
    if (s.length <= 3) return `Δ${s}k`; // "3.2k" = 4 chars after Δ
    // rounded to "10.0" — fall through to integer k format
    return `Δ${String(Math.round(d / 1000)).padStart(3, " ")}k`;
  }
  return `Δ${String(Math.round(d)).padStart(4, " ")}`;
}

// ── renderLB: L and baseline as compact numbers ───────────────────────────────────────────────────
export function renderLB(L, baseline) {
  const lStr = kFmt(L);
  const bStr = kFmt(baseline);
  return `L ${lStr}/b ${bStr}`;
}

// ── renderAlertLine: second line alert ────────────────────────────────────────────────────────────
export function renderAlertLine(rl) {
  const stop = rl?.lastStopEvent;
  if (!stop || stop.turnSeq !== rl.currentTurnSeq) return null;
  return stop.message;
}

// ── Carousel lamp (calibration) ───────────────────────────────────────────────────────────────────
const CAROUSEL_FRAMES = ["⚪", "🟢", "🟡"];
let _carouselFrame = 2;
let _lastFrameTime = -Infinity;

function getCarouselLamp(now) {
  if (now - _lastFrameTime >= 2000) {
    _lastFrameTime = now;
    _carouselFrame = (_carouselFrame + 1) % CAROUSEL_FRAMES.length;
  }
  return CAROUSEL_FRAMES[_carouselFrame];
}

// ── renderCalibratingV3: progressive fill by reason ───────────────────────────────────────────────
export function renderCalibratingV3(s, gate, { now } = {}) {
  const timestamp = now ?? Date.now();
  const tag = tagOf(s.model);

  if (gate.hardUnavailable || gate.reason === "no_transcript") {
    // Fixed ⚠️, no carousel
    return `⚠️ no transcript found ${tag}`;
  }

  // Carousel for other calibrating reasons
  const lamp = getCarouselLamp(timestamp);

  // Progressive fill: placeholder bar/%%/×N + ---t/u--- then available Δ/L/b
  const meter = renderMeterV3(0);       // ░░░░░░░░░░  0%
  const bill = renderBillCount(0);      // × 0
  const countdown = "---t";
  const u = "u---";

  // Δ and L/b: show if data available
  const delta = Number.isFinite(s.L) ? renderDelta(s.L) : "Δ----";
  let lb = "";
  if (Number.isFinite(s.L)) {
    const bStr = (s.baseline?.total != null && Number.isFinite(s.baseline.total))
      ? `b ${kFmt(s.baseline.total)}`
      : "b —";
    lb = `L ${kFmt(s.L)}/${bStr}`;
  }

  // 4-group layout with placeholders (same structure as reliable path, minus :port)
  let line = `${lamp} ${meter} ${bill} · ${countdown} ${u} · ${delta} ${lb} · ${tag}`;
  return line;
}

// ── Calibrating→reliable transition flag (Fix 6: prevent delta spike) ─────────────────────────────
let _wasCalibrating = true;

// ── Per-turn bill count (module-level state) ──────────────────────────────────────────────────────
let _prevTurnSeq = null;
let _baseBillCount = 0;

function perTurnBillCount(currentTurnSeq, billCycleCount) {
  if (_prevTurnSeq === null) {
    // First call ever: base = current count, display = 0
    _prevTurnSeq = currentTurnSeq;
    _baseBillCount = billCycleCount;
    return 0;
  }
  if (currentTurnSeq !== _prevTurnSeq) {
    // Turn changed: base = current count at moment of new turn
    _prevTurnSeq = currentTurnSeq;
    _baseBillCount = billCycleCount;
    return 0;
  }
  // Segment reset: billCycleCount dropped below base → re-anchor
  if (billCycleCount < _baseBillCount) {
    _baseBillCount = billCycleCount;
    return 0;
  }
  return billCycleCount - _baseBillCount;
}

// ── Reliability gate (kept from v2.2) ─────────────────────────────────────────────────────────────
export function renderReliability(s) {
  const cr = s.calibratingReason ?? null;
  return {
    hardUnavailable: cr === "no_transcript",
    reason: cr,
  };
}

// ── formatLine: unified entry point ───────────────────────────────────────────────────────────────
export function formatLine(s) {
  const gate = renderReliability(s);

  // Calibrating paths
  if (gate.hardUnavailable) { _wasCalibrating = true; return renderCalibratingV3(s, gate, { now: Date.now() }); }
  if (gate.reason != null) { _wasCalibrating = true; return renderCalibratingV3(s, gate, { now: Date.now() }); }
  if (!s.rateLamp?.reliable) { _wasCalibrating = true; return renderCalibratingV3(s, gate, { now: Date.now() }); }

  // Transition from calibrating → reliable: reset delta EMA to avoid spike
  if (_wasCalibrating) {
    _prevL = null;
    _smoothDelta = null;
    _wasCalibrating = false;
  }

  // Full layout: 灯 bar %% ×N · ~Nt u · Δ L/b · model URL
  const rl = s.rateLamp;
  const deep = rl.inDeepWater === true || rl.deepWaterDisplayLatched === true;
  // Clamp: if frozen axis says not deep, band cannot show above_exit (v2.2 frozen-axis invariant)
  const clampedBand = deep ? 'above_exit' : (rl.band === 'above_exit' ? 'sweet_to_exit' : rl.band);
  const lamp = renderLamp(clampedBand, deep);
  const meter = renderMeterV3(rl.billProgress);
  const turnBill = perTurnBillCount(rl.currentTurnSeq, rl.billCycleCount ?? 0);
  const bill = renderBillCount(turnBill);
  const countdown = renderCountdown(rl, s.L);
  const u = renderU(rl);
  const delta = renderDelta(s.L);
  const lb = renderLB(s.L, s.baseline?.total);
  const tag = tagOf(s.model);

  let line = `${lamp} ${meter} ${bill} · ${countdown} ${u} · ${delta} ${lb} · ${tag}`;

  // Alert second line
  const alertMsg = renderAlertLine(rl);
  if (alertMsg) {
    line += `\n↻ ${alertMsg}`;
  }

  return line;
}

// ── Test reset helpers ────────────────────────────────────────────────────────────────────────────
export function _resetRenderState() {
  _prevL = null;
  _smoothDelta = null;
  _prevTurnSeq = null;
  _baseBillCount = 0;
  _wasCalibrating = true;
}

export function _resetCarousel() {
  _carouselFrame = 2; // first advance (2+1)%3=0 → starts at ⚪
  _lastFrameTime = -Infinity;
}

