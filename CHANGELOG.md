# Changelog

## 0.4.0 (2026-07-19)

### V3 Measurement Rewrite

- **Continuous-B measurement**: real-time token budget tracking via per-path B_rebuild map, replacing latch/baseline/metrics pipeline
- **g EMA backpressure**: exponential moving average of growth rate replaces discrete stock-step calibration
- **Six built-in tool adapters**: file-read detection, MCP display-name extraction, command redaction
- **Segment detection via topology signal**: null-parent root on active path replaces heuristic stock-drop
- **Compact-fork replay**: `replayActivePath()` folds each subtree into separate segments for history paging

### Dashboard & UI

- **Bucket panel**: interactive 3-group tree (skills / paths / tools) with donut, overlay preview, compact-instruction generator
- **Dual-bar rent meter**: cycle + depth replaces single odometer
- **U-curve dual landmarks**: two curve groups with ghost-linkage activation toggle
- **History chart**: hover linkage, threshold line from bucket preview, Y-axis ratchet, segment-local mapping

### Notification & Status

- **Amber-baseline backstop**: replaces dwTurn; n/N progress in statusline
- **Rate-lamp per-call depth meter**: removes turn-boundary settle delay
- **Dwell-time notify gate**: conditions gate on API call count not cycle ticks
- **Retire Stop hook**: warn.js removed, condition-cleared stop events handled via statusline

### Robustness

- **gitignore-aware B_default**: annotation drives position basis (x/dhat/br)
- **Pure-reread detection + churn tiers**: per-path totalSpent/churn tracking
- **Miss detection on prevL**: replaces prevB-based detection (directly observed)
- **Same-path reasoning attribution**: display-only, degradable

### Specs & Design

- **Post-v3 handoff design**: segment-level archival, dual-path (live/replay), semantic token generation, FTS5 search, GC replay

## 0.3.0 (2026-07-13)

### Plugin Release

- **Plugin packaging**: marketplace manifest + esbuild bundle — installable via `claude plugin marketplace add nomadop/session-watcher` + `claude plugin install session-watcher@session-watcher`
- **Active-leaf-only filtering (M9+H2)**: fold output contains only records from the active branch path; abandoned fork/rewind branches are excluded
- **UTF-8 safety (H3)**: `StringDecoder` prevents multi-byte codepoint corruption across read boundaries
- **TTL eviction (RV-C8)**: `_ledgers` Map bounded with 7-day TTL
- **deepWaterDisplay parity guard (V22-D6)**: golden test prevents lib/public copy drift

### Internal

- Two-phase poll processing (parse batch → determine active leaf → fold)
- Unified `resetFoldState` helper for rotation/fork/rewind
- Ancestor-based fork detection (prevents false replay on linear append)
- Head-cap optimization for `"uuid"` check on large lines
- Cycle guards in `isAncestorOf`, `resolveActivePath`, `detectActiveLeaf`

## 0.2.0 (2026-07-11)

Rate-lamp billing system, statusline unified refactor, dashboard v2.

## 0.1.0 (2026-07-02)

Initial implementation: fold engine, baseline detection, MCP tools, dashboard.
