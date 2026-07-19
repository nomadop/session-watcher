// Statusline render helpers v3 — new layout; no carousel, no calibrating branch.
// Pure render, no DOM/IO. Runs under `node --test`.

import { BR_AMBER, BR_RED, backstopIntervalFor } from './bill-regret.js';

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

// ── renderBackstopProgress: n/N backstop progress (spec §3.4) ─────────────────────────────────────
// Before gate → -/- (fixed 3 chars, no layout jump). denom = max(1, round(interval)); numer =
// min(denom-1, floor(dwBills)) so it never displays N/N (backstop fires at the exact threshold).
// Infinite interval (mf<=0) → -/- (no meaningful reminder).
export function renderBackstopProgress(rl) {
  if (!rl?.hasDeepWaterGateFired) return '-/-';
  const interval = backstopIntervalFor(rl.mf, BR_AMBER);
  if (!Number.isFinite(interval)) return '-/-';
  const denom = Math.max(1, Math.round(interval));
  const numer = Math.min(denom - 1, Math.floor(rl.dwBillsSinceLastAlert ?? 0));
  return `${numer}/${denom}`;
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

// ── renderDelta: g_ema only; no kAvg fallback (v3 anchors delta to g_ema from fold stream B) ──────
export function renderDelta(gEma) {
  const d = Number.isFinite(gEma) && gEma >= 1 ? gEma : null;
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

// ── renderLB: L and B (baseline) as compact numbers; "b" prefix denotes B denominator ────────────
export function renderLB(L, B) {
  return (`L${kFmt(L)}/b${kFmt(B)}`).padEnd(11);
}

// ── renderAlertLine: second line alert ────────────────────────────────────────────────────────────
export function renderAlertLine(rl) {
  const stop = rl?.lastStopEvent;
  if (!stop) return null;
  return stop.message;
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
  const rl = s.rateLamp;
  if (!rl?.reliable) {
    // v3: no calibrating carousel — a neutral measuring line until B>0 and g anchored.
    return `⚪ measuring… · ${tagOf(s.model)}`;
  }
  const lamp = renderLamp(rl.br, { x: rl.x_display, xSweet: rl.xSweet, xBrAmberL: rl.xBrAmberL });
  const meter = renderMeterV3(rl.billProgress);
  const bill = renderBackstopProgress(rl);
  const br = renderBr(rl.br);
  const u = renderU(rl);
  const delta = renderDelta(rl.gEma);
  const lb = renderLB(s.L, s.B);
  const tag = tagOf(s.model);
  let line = `${lamp} ${meter} ${bill} · ${br} ${u} · ${delta} ${lb} · ${tag}`;
  const alertMsg = renderAlertLine(rl);
  if (alertMsg) line += `\n↻ ${alertMsg}`;
  return line;
}

// ── Test reset helpers ────────────────────────────────────────────────────────────────────────────
export function _resetRenderState() {
  // no stateful render state remains (perTurnBillCount removed in v3)
}

