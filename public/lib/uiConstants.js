export const DONUT_CIRCUMFERENCE = 88;      // 2πr for r=14
export const AUTO_COLLAPSE_THRESHOLD = 5;   // dirs with >5 children start collapsed
export const GHOST_OPACITY = 0.3;           // original curve opacity when ghost active
export const HOVER_LINE_COLOR = '#6cc6f0';  // --sky; history hover linkage line
export const COPY_FEEDBACK_MS = 1500;       // "✓ Copied" duration
export const MIN_B_PREVIEW = 1000;          // floor for B_preview
export const OTHERS_DRIFT_WARN_PCT = 0.02;  // |others_raw| negative beyond this × L → console.warn
export const MAG_VISIBLE_TICKS = 5;         // magazine tail depth ticks shown (mirrors lib/constants MAG_VISIBLE_TICKS)

// v3 churn tier thresholds (mirrors lib/constants.js — single source of truth lives there)
export const CHURN_ELEVATED_THRESHOLD = 3.0;    // amber tier (path name + minibar)
export const CHURN_STRUGGLING_THRESHOLD = 5.0;  // coral tier + dir propagation
export const CHURN_STRUGGLING_REREADS = 2;      // min pure re-reads for struggling
export const WASTE_FLOOR = 2500;                 // absolute token-waste gate for coral tier + dir propagation
export const MAX_TOUCH_MARKERS = 64;             // max dashed touch lines in history chart hover
