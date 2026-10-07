// Statusline render helpers v3 — new layout; no carousel, no calibrating branch.
// Pure render, no DOM/IO. Runs under `node --test`.

import { lampZone } from './bill-regret.js';

// The meter's bar cells. Shared so the empty bar the inactive branch prints stays the width of the
// filled one it stands in for.
const BAR_WIDTH = 10;

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
const LAMP_EMOJI = { white: "⚪", green: "🟢", amber: "🟡", red: "🔴" };

export function renderLamp(br, opts) {
  return LAMP_EMOJI[lampZone(br, opts)];
}

// ── renderBr: br decimal → fixed-width display string ─────────────────────────────────────────────
export function renderBr(br) {
  if (!Number.isFinite(br) || br < 0) return "b---%";
  const pct = Math.floor(br * 100);
  if (pct > 99) return "b+99%";
  return `b+${String(pct).padStart(2, '0')}%`;
}

// ── renderMeterV3: BAR_WIDTH bar cells + padded percent ───────────────────────────────────────────
// Total visual: `▓▓▓▓▓▓░░░░63%` — the bar abuts the percent, right-padded to a fixed field.
// The clamp bounds an out-of-range phase and passes NaN through. Upstream, `validateLedgerState`
// admits only a finite phase in [0, 1) and `validateRateLampSample` only finite increments;
// `formatLine` reads the in-process status, so no JSON round-trip turns a NaN into null here.
export function renderMeterV3(walletPhase) {
  const phase = Math.min(0.999999, Math.max(0, walletPhase ?? 0));
  const pct = Math.floor(phase * 100);
  const filled = Math.floor(phase * BAR_WIDTH);
  const bar = "▓".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  return `${bar}${(pct + '%').padEnd(3)}`;
}

// ── renderBackstopProgress: the wallet clock's phase, rendered by renderMeterV3's own bar+percent ──
// Inactive (no reliable merge or no matching ledger) → the same bar, held empty, with the
// percent slot blanked rather than showing a stale or fabricated phase.
export function renderBackstopProgress(rl) {
  const rm = rl?.rentMeter;
  if (!rm?.depthActive) return `${"░".repeat(BAR_WIDTH)}--%`;
  return renderMeterV3(rm.depthProgress);
}

// ── renderU: the stamped causal u; never derived from the instantaneous read ──────────────────────
export function renderU(rl) {
  const u = rl?.u;
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

// ── formatLine: unified entry point ───────────────────────────────────────────────────────────────
export function formatLine(s) {
  const rl = s.rateLamp;
  if (!rl?.reliable) {
    // v3: no calibrating carousel — a neutral measuring line until B>0 and g anchored.
    return `⚪ measuring… · ${tagOf(s.model)}`;
  }
  const lamp = renderLamp(rl.br, { u: rl.u, mf: rl.mf });
  const meter = renderBackstopProgress(rl);
  const br = renderBr(rl.br);
  const u = renderU(rl);
  const delta = renderDelta(rl.gEma);
  const lb = renderLB(s.L, s.bDefault ?? s.B);
  const tag = tagOf(s.model);
  let line = `${lamp} ${meter} · ${br} ${u} · ${delta} ${lb} · ${tag}`;
  const alertMsg = renderAlertLine(rl);
  if (alertMsg) line += `\n↻ ${alertMsg}`;
  return line;
}

// ── Test reset helpers ────────────────────────────────────────────────────────────────────────────
export function _resetRenderState() {
  // no stateful render state remains (perTurnBillCount removed in v3)
}

