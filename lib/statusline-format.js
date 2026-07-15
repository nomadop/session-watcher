// Statusline render helpers v3 — new layout with carousel, u/Δ/br, alert second line.
// Pure render, no DOM/IO. Runs under `node --test`.

import { BR_AMBER, BR_RED } from './bill-regret.js';

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

// ── renderLamp: br value + opts → emoji ───────────────────────────────────────────────────────────
export function renderLamp(br, opts) {
  if (opts?.calibrating) return "⚪";
  if (!Number.isFinite(br)) return "⚪";
  // Left arm: before entry (x < xBrAmberL) = white; between entry and sweet = green
  if (opts?.x != null && opts?.xSweet != null && opts.x < opts.xSweet) {
    if (opts.xBrAmberL != null && opts.x >= opts.xBrAmberL) return "🟢";
    return "⚪";
  }
  if (br >= BR_RED)   return "🔴";
  if (br >= BR_AMBER) return "🟡";
  return "🟢";
}

// ── renderBr: br decimal → fixed-width display string ─────────────────────────────────────────────
export function renderBr(br) {
  if (!Number.isFinite(br) || br < 0) return "b---%";
  const pct = Math.floor(br * 100);
  if (pct > 99) return "b+99%";
  return `b+${String(pct).padStart(2, '0')}%`;
}

// ── renderMeterV3: 10-char bar + space + 3-char percent ───────────────────────────────────────────
// Total visual: `▮▮▮▮▮▮░░░░ 63%` (bar space percent). Space-padded percent.
export function renderMeterV3(billProgress) {
  const bp = Math.min(0.999999, Math.max(0, billProgress ?? 0));
  const pct = Math.floor(bp * 100);
  const filled = Math.floor(bp * 10);
  const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
  return `${bar}${(pct + '%').padEnd(3)}`;
}

// ── renderBillCount: × + 2-char space-padded number (capped at 99 for fixed 3-char width) ─────────
export function renderBillCount(count) {
  const n = Math.min(count ?? 0, 99);
  return (`×${n}`).padEnd(3);
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

// ── renderDelta: prefers gEma (per-call EMA), falls back to kAvgFallback ─────────────────────────
export function renderDelta(gEma, kAvgFallback) {
  const d = Number.isFinite(gEma) && gEma >= 1 ? gEma : (Number.isFinite(kAvgFallback) && kAvgFallback >= 1 ? kAvgFallback : null);
  if (d === null) return 'Δ----';
  let val;
  if (d >= 1000) {
    const k = d / 1000;
    val = k >= 100 ? `${Math.min(Math.round(k), 999)}k` : `${k.toFixed(1)}k`;
  } else {
    val = String(Math.round(d));
  }
  return (`Δ${val}`).padEnd(5);
}

// ── renderLB: L and baseline as compact numbers ───────────────────────────────────────────────────
export function renderLB(L, baseline) {
  return (`L${kFmt(L)}/b${kFmt(baseline)}`).padEnd(11);
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
  const countdown = "b---%";
  const u = "u---";

  // Δ and L/b: show if data available (calibrating: no gEma yet, pass null + kAvg)
  const delta = Number.isFinite(s.kAvg) ? renderDelta(null, s.kAvg) : "Δ----";
  const lb = Number.isFinite(s.L) ? renderLB(s.L, s.baseline?.total) : "";

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

  // Transition from calibrating → reliable: no longer needs EMA reset (kAvg is stateless)
  if (_wasCalibrating) {
    _wasCalibrating = false;
  }

  // Full layout: 灯 bar %% ×N · br u · Δ L/b · model
  const rl = s.rateLamp;
  const lamp = renderLamp(rl.br, { calibrating: !rl.reliable, x: rl.x_display, xSweet: rl.xSweet, xBrAmberL: rl.xBrAmberL });
  const meter = renderMeterV3(rl.billProgress);
  const turnBill = perTurnBillCount(rl.currentTurnSeq, rl.billCycleCount ?? 0);
  const bill = renderBillCount(turnBill);
  const br = renderBr(rl.br);
  const u = renderU(rl);
  const delta = renderDelta(rl.gEma, s.kAvg);
  const lb = renderLB(s.L, s.baseline?.total);
  const tag = tagOf(s.model);

  let line = `${lamp} ${meter} ${bill} · ${br} ${u} · ${delta} ${lb} · ${tag}`;

  // Alert second line
  const alertMsg = renderAlertLine(rl);
  if (alertMsg) {
    line += `\n↻ ${alertMsg}`;
  }

  return line;
}

// ── Test reset helpers ────────────────────────────────────────────────────────────────────────────
export function _resetRenderState() {
  _prevTurnSeq = null;
  _baseBillCount = 0;
  _wasCalibrating = true;
}

export function _resetCarousel() {
  _carouselFrame = 2; // first advance (2+1)%3=0 → starts at ⚪
  _lastFrameTime = -Infinity;
}

