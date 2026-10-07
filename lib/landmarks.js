// dhat = √(2·cRatio·g/bDefault): the instantaneous position scale, reported beside
// x_display as a diagnostic. A non-positive input has no scale to report, so it reads 0.
export function nucleus(cRatio, g, bDefault) {
  if (cRatio <= 0 || g <= 0 || bDefault <= 0) return 0;
  return Math.sqrt(2 * cRatio * g / bDefault);
}
