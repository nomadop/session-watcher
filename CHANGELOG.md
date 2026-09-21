# Changelog

## 0.7.1 (2026-09-21) — Harness projection decoupling and causal position

### Architecture

- **The harness is now the only Claude-Code-aware layer** — transcript rows, content blocks, byte cursors and branch topology stop at a source driver that emits normalized observations. Measurement, dialogue history, turn records and handoff read those observations and carry no transcript format, row shape or native tool name, so a second agent needs a harness rather than a fork.
- **The measurement engine is portable** — it owns calls, epochs, turns, resident content, resource overrides and segment closure, and reaches no filesystem, store, HTTP or native tool name.

### Measurement

- **An epoch opens only for a root that has a call behind it** — a root carrying no measured call no longer starts a segment, and a row's call is read per row, so the root that carries the first one is the root that opens.
- **Residual candidates are credited with the stock growth of their own interval** — the residual total now follows the stock channel instead of drifting from it, so the bucket panel's unattributed remainder reflects the growth that actually arrived while those candidates were pending.

### Attribution

- **A Bash read is attributed to the file it names** — `cat`, `head`, numbered `grep` and the `sed -n` range shapes become path effects when the read is the whole command, with `cd`/`echo`/function preambles stripped first and a multi-segment `sed` spec keyed from its own segments. Reads that used to land in the residual bucket now appear against their files in B and the bucket panel.
- **A compound Bash read chain becomes one effect per locatable block** — a `&&`/`;` chain of reads credits each file it names instead of the whole chain going to residual, refusing the chain when a mid-chain read fails or a directory change is unreadable.

### Pricing

- **The C ratio is keyed by the prompt-cache lifetime the host declares** — where a provider prices cache lifetimes apart, the write-to-read ratio follows the declared lifetime rather than one constant, so the sweet spot and bp reflect what the session is actually billed.

### Handoff

- **A load carries the lineage behind it** — `load_handoff` now returns one headline per session in the lineage alongside the turn page, so a successor sees the chain of sessions it inherits rather than only the most recent summary.
- **A turn page boundary may name a lineage session** — a page can start at a session boundary instead of a turn, which is what a lineage with a session carrying no turn of its own requires.

### Changed

- **Segment boundaries come from transcript topology alone** — a drop in reported token totals no longer starts one, however steep. The absolute dust allowance that survives is the miss classifier's stock-preservation tolerance and nothing else.
- **A sidechain row is dropped before interpretation** — it yields no evidence of any kind, so it no longer contributes path attribution either, and its identifiers never reach topology.
- **Model-dependent reads follow the epoch's first measured call**, not the most recent one; a new epoch clears the binding for the next call to fix. A tool result that arrives late is priced by the policy in force when its call was issued.
- **Path spend counts tool effects only** — text and thinking emitted between tools is no longer attributed to a path.
- **An error the system cannot classify as an unreadable or malformed source is fatal to the owner** — it reports, releases what it holds without archiving the open segment, and exits nonzero, instead of dropping the offending entry and continuing with silently incomplete state. The transcript is untouched, so a fresh owner rebuilds from it.
- **A turn boundary survives a context reset** — a user turn already announced still opens its turn on the far side.
- **Rotation and shutdown settle the rate lamp** — a successful rotation reanchors the new session's ledger before any later call, and normal shutdown flushes pending billing progress before the store closes. Neither integrates restored samples.

### Fixed

- **A rewind stops observing the branch it left behind** — the live root is the one whose subtree holds the newest write, and acceptance stops there. Previously the abandoned branch stayed observed: its usage rows folded into phantom steps and the active leaf could resolve from a branch the conversation no longer reaches.
- **A root readmitted by a later write reports a stale branch** — a root rejected on the advance that carried its row is no longer silently readmitted with no advance left to open its boundary, which had let the snapshot and incremental paths disagree about an epoch boundary and could carry `dead`/B across a real reset.

### Removed

- **History Bookmarks** — the routes (`PUT /api/bookmark`, `/api/bookmark/detail`, `/api/bookmark/messages`) now return 404, store CRUD is gone, and a fresh store no longer creates the table. This supersedes 0.7.0's note that the routes behind the retired MCP tool remained callable.
- **`ctpOvershootRatio`** — absent from status, bucket data and archived profile snapshots.
- **`foldErrors`** — absent from status, together with the per-entry recovery path that produced it.

---

## 0.7.0 (2026-09-06) — Turn history

### Handoff

- **A handoff carries its turns** — `load_handoff` now returns a page of the recent turns behind the summary, each excerpt addressed by the transcript row it came from, so a successor can read the full row instead of trusting a truncated quote.
- **Turn records** — `get_turn_skeleton` renders the capture epoch one block per turn and `submit_turn_notes` takes the producing session's notes back through the slots it defines. Records persist with their own search index and retire with the handoff that keeps them alive.

### Reading the history

- **`turn_page`** — page a loaded handoff's lineage, newest first
- **`turn_search`** — find a literal that occurs verbatim in the transcripts behind it
- **`turn_locate`** — find candidate turn ranges when the remembered wording is uncertain

  All three resolve their own lineage from the handoff delivered into the calling session, so none takes a lineage identifier; a session that has loaded nothing is told so rather than offered a guess.

### Dashboard

- **History drawer** — a read-only drawer on the history chart: one collapsible section per session in the lineage with the wayfinder headline it shows in place of its rows, the stored user text and note for each turn, and client-side substring search. One snapshot per open, no write path.

### Fixes

- **Segment boundaries no longer fire on a small stock dip** — with no new root UUID in the topology, a reset now requires `totalStock` to fall past a floor relative to the stock it judges (`SEGMENT_DROP_FRACTION`) rather than past a fixed absolute one. A reset replaces the whole conversation prefix, so a shallow dip is not one. The fallback reads that single quantity and nothing else.
- **A failed segment archive no longer stops the fold** — store resolution moved inside the guarded block, so an archival failure degrades to "the segment still rotates, the sweep retries" instead of propagating out through `foldCall` and ending measurement for the session.

### Removed

- **`get_bookmark_detail`** — the MCP tool is retired. The REST routes behind it (`/api/bookmark/detail`, `/api/bookmark/messages`, `PUT /api/bookmark`) remain callable.

---

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
