// public/lib/format.js — shared formatters
const PLACEHOLDER = '—';

/** A token count rounded whole, grouped by thousands and followed by the `tok` unit, the way the host's stat dialogs print one; the placeholder unless it is finite. */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return PLACEHOLDER;
  return `${Math.round(n).toLocaleString('en-US')} tok`;
}

export function formatX(x) {
  if (x == null) return '—';
  return x.toFixed(2) + '×';
}

/** `br` as its floor percent; the placeholder unless it is finite and non-negative. */
export function formatBr(br) {
  if (!Number.isFinite(br) || br < 0) return PLACEHOLDER;
  return `${Math.floor(br * 100)}%`;
}

/** `u` to one decimal; the placeholder unless it is finite. */
export function formatU(u) {
  if (!Number.isFinite(u)) return PLACEHOLDER;
  return u.toFixed(1);
}

/** `gEma` as a token count under `renderDelta`'s availability rule: the placeholder unless it is finite and at least one. */
export function formatDelta(gEma) {
  if (!Number.isFinite(gEma) || gEma < 1) return PLACEHOLDER;
  return formatTokens(gEma);
}

/** The wallet clock's phase as the floor percent of the phase clamped as `renderMeterV3` clamps it. */
export function phasePercent(phase) {
  return Math.floor(Math.min(0.999999, Math.max(0, phase)) * 100);
}

/** `phasePercent` with its percent sign; the placeholder unless the phase is finite. */
export function formatPhase(phase) {
  if (!Number.isFinite(phase)) return PLACEHOLDER;
  return `${phasePercent(phase)}%`;
}
