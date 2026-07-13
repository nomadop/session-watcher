// H-pt4/B9: the pure display-hysteresis deep-water latch, extracted VERBATIM from
// public/chart-helpers.js#deepWaterDisplay so a core server module (lib/rate-lamp-manager.js) no longer
// reverse-depends on a browser-oriented file. public/chart-helpers.js now RE-EXPORTS this copy (single
// SSOT — one body). No DOM / Chart.js dependency, so it runs under `node --test` and in the browser.
//
// R5-1: sticky deep-water latch for the region lamp (spec §10.9 / §23.3). Enter at the exit line; leave
// only after dropping a full RATE_EXIT_HYST below it, so a sub-hysteresis cache-expiry dip does not
// flicker the lamp. PURE — the caller persists prevLatched across boundaries. DISPLAY ONLY (§23.3): this
// is orthogonal to BOTH the measurement-layer L_base latch (lib/latch.js) and the v3 floor-step ratchet;
// it never gates settlement. RATE_EXIT_HYST = max(2048, 0.02·C_RATIO·B_rebuild).
export function deepWaterDisplay(prevLatched, { L_read, L_exit_fullCarry, cRatio, B_rebuild }) {
  if (!(L_exit_fullCarry > 0) || !Number.isFinite(L_read)) return false;
  const hyst = Math.max(2048, 0.02 * cRatio * B_rebuild);
  if (prevLatched) return L_read >= L_exit_fullCarry - hyst; // leave only past the deadband
  return L_read >= L_exit_fullCarry;                          // enter at the exit line
}
