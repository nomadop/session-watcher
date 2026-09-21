// Instantaneous burn rate, carry-aware (spec §3.1 general form). max(0,·) clamps below-floor to 0.
export function computeFullCarryBurnRate({ L_read, B_post, B_rebuild, cRatio }) {
  if (!(B_rebuild > 0) || !(cRatio > 0)) return NaN; // guarded by reliable gate upstream
  return Math.max(0, L_read - B_post) / (cRatio * B_rebuild);
}
