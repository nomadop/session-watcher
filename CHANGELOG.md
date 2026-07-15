# Changelog

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
