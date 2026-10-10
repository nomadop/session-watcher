# Changelog

## 0.9.1 (2026-10-10) — The status reading and the handoff patch

### DSH plugin

- **`prepare_handoff` patches an undelivered handoff** — given the `load_token` of an undelivered handoff it changes only the parameters it is passed, and the others keep their stored values. A new handoff must pass `summary` and `paths_to_keep`; a call missing either gets an error naming the recovery action. Revising no longer clears an omitted `next_task` or `skills_to_keep`; pass `""` or `[]` to clear.
- **`watcher_status` reads a session's current reading** — it takes an optional `sessionId` naming any session the host has run or persisted, the calling session by default, and replies `{ running: true, sessionId, reading }`. `reading` carries the lamp, the wallet clock's phase, `br`, `u`, `gEma`, `L`, `B`, the model and the alert, the quantities the statusline shows; while the session is still measuring, `reliable` is false and `lamp`, `phase`, `br`, `u`, `gEma` and `alert` are null, with `model`, `L` and `B` still reported. A settled session is rebuilt first, as the tab does, and a session the host has neither running nor persisted is a tool error.

### Claude Code

- **`prepare_handoff` patches an undelivered handoff** — given the `load_token` of an undelivered handoff it changes only the parameters it is passed, and the others keep their stored values. A new handoff must pass `summary` and `paths_to_keep`; a call missing either gets an error naming the recovery action. Revising no longer clears an omitted `next_task` or `skills_to_keep`; pass `""` or `[]` to clear.
- **`watcher_status` carries the session's current reading** — the reply is `{ running: true, url, sessionId, reading }`, `sessionId` being the session the watcher currently follows and `reading` the same quantities the DSH reply carries.
- **`watcher_status`, `get_bucket_summary`, `prepare_handoff` and `load_handoff` lose their `sessionId` parameter** — a caller still sending it gets its own session's answer as before, the undeclared key being dropped.
- **The probe's `mcp` event no longer carries `session_id_arg`.**

---

## 0.9.0 (2026-10-07) — Session Watcher for DSH

### DSH plugin

- **`@nomadop/session-watcher-dsh` brings Session Watcher to DeepSeek Harness** — `dsh plugin --profile <name> add @nomadop/session-watcher-dsh` loads it into a DSH profile. It keeps one watcher per session, subagent sessions included, reads each session from the host's event log, and shares its store under `~/.session-watcher` with the Claude Code plugin.
- **The Session Watcher tab** — a view in the conversation view strip mounts the dashboard's elements for that session: the hero chart, the depth bar, the cycle and reminder bars, the history chart and drawer, the bucket panel and the pricing chip. It is refreshed by the host's change signal and pulls its readings over the plugin's `/session-watcher` RPC channel. A badge in its top row names the signal stream's state while that is not live, and otherwise the state of a read that is not live — being read, not observed, failed or unreachable — while the elements stay mounted without a reading. The tab follows the host's chat column width and paints a light palette under a light host theme. Its texts, and the dock's, come in English and Simplified Chinese and follow the host's locale.
- **The composer dock** — a pill below the composer shows a lamp ring (the alert clock's progress as its arc, the lamp's zone at its core) with the bill premium, an arrow for the arm and a corner badge counting the alert clock's laps, or one short word while the lamp has no reading; clicking it opens the position, the context stock, the alert clock and the latest alert. It reads the same readings as the tab.
- **A session is read on demand** — a settled session, or one from before a host restart, has its watcher built the first time the tab or the dock asks for it, so it reads there like a running one; a session the host has not persisted answers as not observed.
- **The tools** — the Claude Code MCP tool set minus `rotate_session`, each answering for the calling agent's own session. `watcher_status` carries no URL; the readings are in the tab and the dock.
- **The skills** — `sw-handoff`, `sw-load` and `sw-explain` ship with the package and are registered with the host.
- **Handoff across sessions** — an agent that starts or resumes receives a message listing the pending handoffs other sessions prepared for its project, the same text the Claude Code SessionStart hook shows. Turn addresses name a session and an event `seq`, and the turn tools point at `session_event_read` to read one in full.
- **The Turn Notes are written under the system temp directory** — DSH's `workspace-write` sandbox admits it, so the agent's write of the notes file asks for no approval.
- **`session-watcher replay` plays back a DSH session log** — a `session.v4.jsonl.zstd` or a plaintext `session.v4.jsonl` from the host's session store, on the dashboard it plays a Claude Code transcript on.
- **A DSH model call is measured under its catalog name** — the host resolves each call's provider and model id through the `llm` service and measures the call under the catalog `name` of that pair, under the id where none resolves. A pricing override saved under a model id has to be saved again under the name to apply to a DSH session, and a catalog name without the model family in it prices under the defaults where its id would have matched a row.

### Claude Code

- **A cache miss is a cache-read collapse alone** — a step is a miss when its cache read falls below a fixed fraction of the previous step's L, whether or not the total stock held, and a miss measures its L from the total stock. A step whose read collapsed while the stock also fell used to count as no miss and measure L from the collapsed read, so for the sessions that have one, that step's L and the position ratio built on it change, and with them the fitted reference, the landmarks and the bill progress.
- **A tool result written ahead of its call is held and charged when the call arrives** — the transcript does not order a result after its call, and a result that found no call before it charged nothing. A tool call id names one call for the epoch: it is charged once, at its first result, whether that result is written before or after the call, a revision of the call that follows its result arms nothing, and an empty id names no call. A file read whose result was written ahead of its call reaches its file's total, and B, g and the bucket panel follow for the sessions that have one.
- **`start_watcher` and `stop_watcher` are retired** — the dashboard server runs inside the MCP process for the life of the session, so `start_watcher` only reported its URL and `stop_watcher` answered that nothing was stopped; `watcher_status` reports whether the watcher is running and its URL.
- **`load_handoff` declares that it writes** — a delivery binds the handoff to the loading session and records the load, so the tool is annotated as not read-only and its description no longer says it is a pure read.
- **The history chart's threshold line follows the group the hero shows** — while a bucket selection is being previewed, the line is the preview's only when the hero shows the preview group, and selecting the default group on the hero or the depth bar moves the line back with it.
- **A failed rotation answers with JSON** — `POST /api/rotate` answers status 500 with `{"error":"internal"}` where Express's HTML error page came back, and writes the cause of a failed candidate source to stderr whatever `SW_DEBUG` says.
- **The replayed ledger's cycle count is reported** — `/api/status?debug=1` during a playback carries the playback ledger's bill cycle count as `cycleCountInSegment`, where it carried zero.
- **An application diagnostic reaches stderr once per code without `SW_DEBUG`** — the first occurrence of each code in an owner, from a live frame, the terminal close, the ratio refresh or a reconstruction sweep, is written; its repeats wait for `SW_DEBUG`.
- **`sw-load` reads a kept path without a line range from its opening** — an entry carrying neither `lines` nor resolved symbols loads the opening of its file and places the symbols it names with `grep -n`, where it read the whole file; the load summary reports where those symbols sit.
- **`turn_search` names tokens seen verbatim as the way to retry a miss** — when no transcript holds the literal, its reply tells the agent to search a shorter fragment or a token seen verbatim, an id, a path or a commit hash, or to call `turn_locate`.
- **The `prepare_handoff` reply no longer names `/clear`** — its instruction, like the skills' text, describes the context reset the host offers.
- **The bucket payload gains `residual.tool`** — `/api/buckets` carries the key, always empty under Claude Code.
- **`get_bucket_summary` answers the handoff decision's view of the buckets** — each file or skill row carries its path or name, token size, read and edit counts, default selection with its reason where one applies, the user's override and its active symbols, beside the session id, the segment and `br`; the per-touch history, spend ratios, totals, residual groups and the other metrics the dashboard panels render stay on `/api/buckets`, and sizes are whole tokens.
- **A model id is matched against the calibrated tokenizer rows by pattern** — an id the old bare-prefix test missed, for example one with a vendor prefix or different letter case, now has its file and tool token sizes estimated with the characters-per-token ratio of the tokenizer it names, rather than the conservative default.
- **A handoff load cut off by shutdown fails** — when the store closes while the load waits on symbol resolution, the reply takes the route's error path instead of a successful reply carrying `turn_page_error`.
- **The skills and the `watcher_status`, `get_bucket_summary`, `prepare_handoff` and `submit_turn_notes` tool descriptions are reworded** so they hold for both hosts, and `sw-handoff` and `sw-load` no longer fall back to the dashboard's HTTP routes with `curl` when the tools are unavailable.
- **The `session-watcher demo` page's depth bar aligns to the hero chart** — it spans the hero chart's plot area, as it does on the dashboard.
- **The status payload carries the lamp's zone** — `/api/status` and the `POST /api/user-overrides` reply carry `lamp`, the statusline lamp's zone, null while measuring.
- **A segment closed at shutdown with no live update since its last rebuild archives as a replay** — the rebuild at startup, or the one after a rewind the live poll found; the segment is recorded as `cc-replay` and stamped with its last measured step's time, where it was recorded as `cc-live` and stamped at shutdown.
- **Pricing during a playback follows the playback** — while a transcript plays back, `/api/pricing`, the pricing chip and a price saved or cleared there use the playback's epoch model, and a `--ratio` given on the command line, or a price saved or cleared during the playback, prices the playback's readings. Starting or stopping a playback re-applies the saved price to the live session, so a price saved or cleared during a playback under the live session's own model reaches it when the playback stops.
- **`session-watcher replay`'s wording covers both hosts** — the help line names a DSH session log beside a Claude Code transcript, the extension warning accepts `.jsonl`, `.jsonl.gz` and `.zstd`, and the no-usage error no longer says that only Claude Code transcripts are supported.
- **The hero chart's axis title and red-zone gutter label follow the theme** — they read the theme's `--txt-dim` and `--coral` where they read two variables no theme defines and painted fixed fallback colours.

Every other Claude Code output is unchanged.

---

## 0.8.0 (2026-09-25) — Causal position and the wallet clock

### Measurement

- **Position is read from the path the session travelled** — `u` accumulates each settled interval's share of a restart cycle at that interval's baseline and realized mean growth, so it only moves forward: loading more files changes how fast it advances from then on, not the distance already covered. `pp`, `mf` and bp are read at that position rather than from a snapshot of the current L and B.
- **Landmarks come from a reference skeleton fitted over the path** — `rateLamp.reference` relates the position ratio to `u` across the segment's stamped points, and the sweet spot, both amber boundaries and the red boundary are read off it, so they move together as the fit sharpens. `xSweet` is that skeleton at `u = 1`; `dhat` stays as a diagnostic that nothing in the lamp, verdict or reminder reads.
- **The arm is decided by `u`** — the lamp whitens on the left arm below the mirrored amber boundary and turns amber or red on the right arm only.

### Reminder

- **The restart reminder runs on the wallet clock** — the reminder bar fills with each call's rent increment over an interval set by that interval's exchange fraction, and the call that fills it raises a reminder stamped with the lap count reached. It reads accumulated rent alone, so no change of position, baseline or file selection can move or retract it. The threshold gate on bp, its dwell and the deep-water predicate are gone.

### Dashboard and statusline

- **Position preview** — `POST /api/preview` re-folds the session's history under a candidate include/exclude selection and returns the candidate path, landmarks and premium without applying anything; a transcript replay refuses it. The bucket panel previews a selection through it before applying.
- **The statusline carries the reminder bar as its only meter**, a bar and a percentage, with a reminder on a second line; the `n/N` backstop count is gone. The lamp arms by `u`.
- **The depth bar and the history chart** take their landmarks and threshold lines from the server and the same projection the hero draws on, and the hero names the premium axis on every frame, idle frames included.
- **The demo replays a current session** — `public/snapshots.json` is baked through Transcript Playback from the same routes the dashboard reads, so the demo shows the status shape this release serves.

### Attribution

- **A parallel batch's results are accepted with their calls** — a tool result that is a sibling leaf of the chain is admitted because its call is on the chain, so the file it read reaches its bucket instead of the residual, and a result admitted this way opens no epoch.
- **A Bash residual is named after its command**, not after the separator behind it.

### Pricing

- **Opus 5.5 has its own C ratio row.**

### Removed

- **`burnRate`** — absent from status together with the rent rate it carried; the rate wall `wallP` is now defined as the position where one more call's avoidable rent equals a complete rebuild.
- **The deep-water gate state** — the ledger no longer carries the dwell counters, and a ledger written by an earlier version is rebuilt from the transcript.

---

## 0.7.1 (2026-09-21) — Harness projection decoupling and Bash read attribution

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
