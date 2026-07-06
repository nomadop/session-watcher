// Shared statistical helpers. Single source of truth for the median used by
// baseline knee detection, the metricsReliable residual gate, and Theil-Sen.
// Empty/non-array input returns 0 (matches the historical baseline/watcher
// contract so no caller sees a behavior change).
export function median(nums) {
  if (!Array.isArray(nums) || !nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b); // spread → never mutate the input
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}
