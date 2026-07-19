export const CONSTANTS = {
  EFFICIENCY_MULT: 2,
  // Cache-miss denoise (v1.1) — dimensionless ratios ONLY, cross-project/cross-environment stable.
  // A miss row: cacheRead collapses below MISS_READ_RESIDUAL of both its own total and the segment's
  // established read peak, while total stock stays >= MISS_TOTAL_KEEP of the segment peak. Empirical:
  // real miss read/total ≡ 0.0; normal p5 = 0.926 — a wide gap, any 0.05–0.5 splits them (spec §3.1.1).
  MISS_B_FRACTION: 0.8,
  MISS_TOTAL_KEEP: 0.7,
  DW_TURN_BACKSTOP: 2, // ΔW_turn ≥ 2 single-turn backstop threshold (§2.8), tunable
};

// Ring/queue caps for ledger arrays.
export const RECENT_STOP_EVENTS_LIMIT = 32;
export const RECENT_PROCESSED_HOOK_IDS_LIMIT = 128;
// PENDING_MAX_TURN_DISTANCE: used by fold.js for tool_use residual expiry (different from Stop pending TTL).
export const PENDING_MAX_TURN_DISTANCE = 2;

// C_m/C_h = cache-write price ÷ cache-read price. Verified: Claude family = 12.5,
// DeepSeek v4-flash = 50, v4-pro = 120. Unknown models fall back by tier substring, never zero.
export const C_RATIO_TABLE = [
  { match: /claude|opus|sonnet|haiku/i, ratio: 12.5 },
  { match: /deepseek.*pro/i, ratio: 120 },
  { match: /deepseek/i, ratio: 50 },
];
export const DEFAULT_C_RATIO = 10;

// Pricing presets — structure defined here, data maintained by user (spec §10.1).
// Each entry: { id, label, readPrice: $/1M cache-read, writePrice: $/1M cache-write (5min) }
// ratio = writePrice / readPrice = C_RATIO used by the EOQ model.
// At least one entry required for tests to validate preset source/drift detection.
export const MODEL_PRICING_PRESETS = [
  {
    id: "opus-4.8",
    label: "Claude Opus 4.8",
    readPrice: 0.5,
    writePrice: 6.25,
  },
  { id: "sonnet-5", label: "Claude Sonnet 5", readPrice: 0.2, writePrice: 2.5 },
  {
    id: "sonnet-4.6",
    label: "Claude Sonnet 4.6",
    readPrice: 0.3,
    writePrice: 3.75,
  },
  {
    id: "haiku-4.5",
    label: "Claude Haiku 4.5",
    readPrice: 0.1,
    writePrice: 1.25,
  },
  { id: "fable-5", label: "Claude Fable 5", readPrice: 1.0, writePrice: 12.5 },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek v4 Flash",
    readPrice: 0.02,
    writePrice: 1.0,
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek v4 Pro",
    readPrice: 0.025,
    writePrice: 3.0,
  },
];

// Max context window in tokens by model family. 1M for extended-context models.
export const CONTEXT_WINDOW_TABLE = [
  { match: /test-short-window/i, window: 200_000 }, // test-only vehicle for cap-binding tests
  { match: /1m|-1m|opus-4-8/i, window: 1_000_000 },
  { match: /claude|opus|sonnet|haiku/i, window: 1_000_000 },
  { match: /deepseek/i, window: 1_000_000 },
];
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export const RESERVED_OUTPUT = 32_000; // tokens reserved for model output
export const CTX_SAFETY_MARGIN = 8_000; // headroom before hard window cap

// v2.2-C4b: boundary precheck head-cap constants (spec §4.3).
// PRECHECK_LONG_LINE_BYTES: lines exceeding this threshold scan only the head slice.
// PRECHECK_HEAD_CAP_BYTES: max bytes to scan for boundary markers on long lines.
export const PRECHECK_LONG_LINE_BYTES = 1048576; // 1MB
export const PRECHECK_HEAD_CAP_BYTES = 8192;

// v2.2-C5a: coalesced write-behind flush interval. The reader path schedules a dirty sid for
// flushing; the coalesced timer fires at most this often and re-reads the LIVE ledger at flush
// time (red line #5: never a captured snapshot). 2s balances disk I/O reduction (~30x fewer
// writes at 1Hz polling) against staleness window on crash.
export const COALESCED_PERSIST_MS = 2000;

// v2.2-C5b: adaptive keepalive idle gate threshold (monotonic, performance.now()).
// When no SSE clients are connected AND the last advance happened less than this many ms ago,
// the poll timer tick early-returns (skips redundant work). When SSE clients ARE connected the
// tick always runs (they need push updates). 5s chosen: longer than the 1s poll interval (so
// the gate fires after >=5 idle ticks), short enough that a reconnecting dashboard sees fresh
// data within one gate window.
export const IDLE_HEARTBEAT_MS = 5000;

// ── v3 continuous-B measurement layer (spec §9) ──────────────────────────────
// Model-prefix → chars-per-token lookup. Two-CTP: ASCII and CJK have different
// tokenizer efficiency. Empirically calibrated (reports/2026-07-14-ctp-cross-provider-measurement.md):
// a flat 3.2 underestimates B by 28% on Claude and 50%+ on CJK-heavy content.
// New providers: add one row + run scripts/verify-read-cjk-ctp.js.
export const CTP_TABLE = {
  claude:   { ascii: 2.45, cjk: 0.59 }, // Anthropic tokenizer (n=5881)
  deepseek: { ascii: 3.24, cjk: 0.94 }, // DeepSeek tokenizer (n=5265)
};
export const DEFAULT_CTP = { ascii: 3.0, cjk: 1.0 }; // conservative fallback for uncalibrated models

// Per-tool framing tokens (JSON wrapper cost per invocation, not file content). Spec §2.1 table.
export const TOOL_OVERHEAD = { Read: 40, Write: 90, Edit: 85, Bash: 10, Grep: 40 };

// Known-ASCII extensions: charsToTokens skips the CJK regex scan (fast path). Spec §2.3.
export const ASCII_EXTS = ['.js', '.ts', '.tsx', '.jsx', '.css', '.scss', '.json', '.yaml', '.toml', '.env'];

export const DEPTH_HOT_LAP_COUNT = 3;   // backstop lap count at which depth bar → coral (display, spec §5)
export const MAG_VISIBLE_TICKS = 5;     // magazine tick slots; overflow shown as +N (display, spec §5)

// v3 churn tier thresholds (spec §2.3 — struggling detection, display gates).
export const CHURN_ELEVATED_THRESHOLD = 3.0;    // display: amber tier (path name + minibar)
export const CHURN_STRUGGLING_THRESHOLD = 5.0;   // display: coral tier + dir propagation
export const CHURN_STRUGGLING_REREADS = 2;       // display: min pure re-reads for struggling
export const WASTE_FLOOR = 2500;                 // display: absolute token-waste gate for coral tier + dir propagation

export const ALPHA_EMA = 0.03;            // EMA smoothing — the sole tuning knob (spec §2.4)
export const G_FLOOR = 100;               // g lower clamp — prevents dhat=0 division / cold-start silence
export const MISS_B_FRACTION = 0.8;       // (legacy, kept for reference) old prevB-based threshold
export const MISS_TOTAL_KEEP = 0.7;       // (legacy, kept for reference) old prevB-based threshold
export const MISS_CR_DROP = 0.95;         // classifyMiss: cacheRead < prevL × this → cache evicted (spec §4.2)
export const SEGMENT_DROP_EPSILON = 100;  // any totalStock drop > this → segment reset (spec §6.6)
export const NOTIFY_DWELL = 3;            // consecutive deep-water API calls before gate fires (spec §6.2)
export const BR_HYST = 0.02;              // notification re-arm deadband (spec §6.2)
export const CTP_OVERSHOOT_WARN = 0.05;   // dashboard calibration hint when ctpOvershoot/L exceeds this

export default CONSTANTS;
