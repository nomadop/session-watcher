export const CONSTANTS = {
  EFFICIENCY_MULT: 2,
  FIT_WINDOW_DEFAULT: 20,
  KNEE_BG_MULT: 1.75,
  KNEE_MIN_TURN: 3,
  RESIDUAL_MAX: 0.3,
  BASELINE_CONF_MIN: 0.75,
  // Cache-miss denoise (v1.1) — dimensionless ratios ONLY, cross-project/cross-environment stable.
  // A miss row: cacheRead collapses below MISS_READ_RESIDUAL of both its own total and the segment's
  // established read peak, while total stock stays >= MISS_TOTAL_KEEP of the segment peak. Empirical:
  // real miss read/total ≡ 0.0; normal p5 = 0.926 — a wide gap, any 0.05–0.5 splits them (spec §3.1.1).
  MISS_READ_RESIDUAL: 0.5,
  MISS_TOTAL_KEEP: 0.7,
  // k_stable static clamp (spec §3.4 / §10.1#6). PROVISIONAL, tunable (§9 non-core UX knob):
  // K_FLOOR stops k_stable→0 (which would make empty_burn near-impossible and collapse xExit→1);
  // K_CEIL stops a knee-adjacent code-dump from freezing k_stable absurdly high (→ every normal
  // small step reads <k_stable → chronic false empty_burn). Static clamp ONLY — no behavioral decay
  // (rejected: reintroduces drift into a frozen quantity). Typical stable delta ≈ 940 tok/call.
  K_FLOOR: 50,
  K_CEIL: 5000,
  DW_TURN_BACKSTOP: 2,   // ΔW_turn ≥ 2 single-turn backstop threshold (§2.8), tunable
};

// C_m/C_h = base-input price ÷ cache-read price. Verified: Claude family = 10,
// DeepSeek v4-flash = 50. Unknown models fall back by tier substring, never zero.
export const C_RATIO_TABLE = [
  { match: /claude|opus|sonnet|haiku/i, ratio: 10 },
  { match: /deepseek/i, ratio: 50 },
];
export const DEFAULT_C_RATIO = 10;

// Max context window in tokens by model family. 1M for extended-context models.
export const CONTEXT_WINDOW_TABLE = [
  { match: /1m|-1m|opus-4-8/i, window: 1_000_000 },
  { match: /claude|opus|sonnet|haiku/i, window: 200_000 },
  { match: /deepseek/i, window: 1_000_000 },
];
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export const RESERVED_OUTPUT = 32_000;   // tokens reserved for model output
export const CTX_SAFETY_MARGIN = 8_000;  // headroom before hard window cap

export default CONSTANTS;
