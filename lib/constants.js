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
  DW_TURN_BACKSTOP: 2, // ΔW_turn ≥ 2 single-turn backstop threshold (§2.8), tunable
};

// v2.2-C settledTurnSummaries ring caps (spec §3.2/§3.6). SOFT reclaims normally at the append site;
// HARD is the corrupt-unbounded-growth sanity cap AND the validator's length gate (single source of
// truth — the validator's length CAP must equal the writer's ADD-site trim LIMIT, else a legitimately
// trimmed ring trips the over-LIMIT reject in validateLedgerState → whole-ledger WIPE). C1-2 migrates
// SETTLED_SUMMARY_HARD_LIMIT out of ledger-schema.js's module-local copy to here; the RECENT_*/PENDING_*
// caps are migrated here by C3-2.
export const SETTLED_SUMMARY_SOFT_LIMIT = 64;
export const SETTLED_SUMMARY_HARD_LIMIT = 512;

// v2.2-C3 ring/queue caps (spec §3.4a). Single source of truth — ledger-schema.js imports these.
export const RECENT_STOP_EVENTS_LIMIT = 32;
export const RECENT_PROCESSED_HOOK_IDS_LIMIT = 128;
export const PENDING_STOP_EVALUATIONS_LIMIT = 64;
export const PENDING_STOP_TTL_MS = 600_000; // 10 min — see A8 clock rule on expirePending
export const PENDING_MAX_TURN_DISTANCE = 2; // A24 slide-forward sanity cap

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

// v2.2-C4: bounded incremental advance budget caps for the Stop route.
// maxMs: secondary guard (per-boundary time check). maxBytes: hard bound on read chunk size.
export const STOP_ADVANCE_MAX_MS = 150;
export const STOP_ADVANCE_MAX_BYTES = 524288; // 512KB

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

export default CONSTANTS;
