# Changelog

## 0.6.0 (2026-07-28) — Post-v3 feature release

### Measurement

- **Holt double-exponential smoothing** for g — 14.5% lower tracking error, 1.2 frames faster regime response (428-session corpus validated). Replaces raw EMA; no threshold recalibration needed.
- **B-L phase lag carry** — deferred settlement handles read-time B overshoot without distorting position metrics.

### Adapters & Coverage

- **Serena adapter** — 8 tool adapters (find_symbol, get_symbols_overview, find_referencing_symbols, read_memory + replace_content, replace_symbol_body, insert_before/after_symbol). Closes 31% measurement blind spot for symbol-aware editing.
- **Symbol outline** — tree-sitter extraction (JS/TS/Python) + markdown heading fast-path. Integrated into bucket data and handoff symbolRanges for precise carry-set selection.

### Handoff & Context

- **Bookmark index** — MMR-selected representative assistant turns + user intent extraction from transcript. Gives the next session "what were we discussing" context beyond file fragments.
- **bDefault override** — Apply/Reset in the bucket panel lets you adjust the position basis in real time. Sibling inference propagates decisions to new paths. Full metric chain (x/dhat/br/statusline) follows immediately.

### Documentation

- **Wiki site** — build-pages pipeline generates GitHub Pages docs: Concepts, Cookbook, How It Works, Guarantees. Machine-readable `llms-preamble.md` for LLM onboarding.

### Fixes

- Statusline `b` now shows bDefault (position basis) instead of B_full
- Empty session dashboard shows skeleton/placeholder states instead of "—" grid
- Windows path tree collapse fixed — canonicalizePath outputs posix separators

---

## 0.5.4 (2026-07-23) — Initial public Show HN release

### Highlights

- Replay an anonymized built-in Claude Code session
- Replay a local Claude Code JSONL transcript
- Live context-cost dashboard and statusline
- User-controlled context buckets
- Handoff package and reload workflow
- Local per-step and path-event telemetry groundwork

### Fixes

- Fix `isMain` detection via `realpathSync` for `npx` symlink resolution
- Fix WAL warnings on `:memory:` databases
- Dedup identical message IDs in replay indexing (Claude retries)
- Switch `demo` command to static snapshots (no fixture needed)
- Expand read buffer for long-line tolerance (512→8192)

### Current boundaries

- Claude Code transcripts only
- Restart and bucket decisions remain human-controlled
- No D/C or automated carry-set optimizer
- No transcript or telemetry upload

---

## 0.5.0 (2026-07-23)

### Plugin

- npm package `@nomadop/session-watcher` with `npx session-watcher` CLI
- MCP plugin with `SessionStart` hook auto-launch
- Demo command with built-in anonymized transcript
- Replay command for local JSONL transcripts
- GitHub Pages landing page with hosted static demo

### Core

- ALPHA_EMA tuned to 0.12 (effective window ~8 turns) via corpus sweep
- Handoff telemetry: carry-staleness tracking, loader versioning
- Context bucket tree: per-path B_rebuild attribution
- BR_default / BR_selected comparison for bucket decisions

---

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
