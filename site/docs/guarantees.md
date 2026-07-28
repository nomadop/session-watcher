# Guarantees

Stable externally-observable behavior of the measurement system. Implementation may change; these guarantees hold across versions.

---

## Input Contract

The measurement system requires a stream of structured events. The current implementation consumes Claude Code JSONL transcripts; the input schema below describes the logical contract that any future adapter would fulfill.

**Usage snapshot:** Each API interaction produces a snapshot containing:

- A token breakdown with at minimum: input, output, cache-read, and cache-write counts (additional categories such as reasoning may be present depending on the provider)
- An optional primary key (for dedup); when absent, a fallback key may be used; when both are absent the snapshot is treated as unique
- An optional sidechain flag (marks sub-agent or parallel work that should not count toward main-context measurement)
- A timestamp and model identifier

**Context-reset signal:** A structural indicator that the context window has been cleared or compacted. This may come from transcript topology or from a totalStock drop. The measurement system uses it to trigger segment boundaries.

**Tool-event stream:** File operations (reads, writes, edits) with their content, used to compute per-path token contributions to B. Each event carries a path and enough content to estimate token cost at ingestion time.

---

## Measurement Invariants

Given correct input, the measurement layer guarantees:

**Folding:** When multiple snapshots share the same primary key, only the revision with the highest total token count is retained. Earlier or partial revisions are silently replaced. A fold revision never triggers a segment boundary.

**Segment isolation:** On context-reset, all accumulated state resets: B rebuilds from zero, g returns to floor, the deferred ledger clears, and the rate lamp starts a fresh billing cycle. Cross-segment history is preserved for visualization but does not contaminate current measurements.

**Token-at-Ingestion:** Per-path token estimates are computed once at write time using a model-specific conversion ratio. Values are never retroactively recomputed — changes in calibration or file content only affect future observations.

**Settlement:** When B grows faster than L (cache-creation credited before cache-read materializes), the surplus is absorbed by a deferred ledger rather than appearing as false residual growth. When L catches up, the ledger retires. Any balance un-retired at segment end is treated as estimation error and corrected out of the path totals.

**Sidechain exclusion:** Snapshots marked as sidechain do not contribute to L, g, segmentation triggers, or turn counting. Path attribution still processes sidechain file events (B may increase) because rebuild cost must track all file access regardless of origin.

---

## Output Semantics

The system publishes a status snapshot after each measurement cycle. Consumers can rely on:

**Position constraint:** The public field `B` never exceeds `totalStock`. This cap is a transient display guard during cache-creation lag; it self-releases once the provider's cache catches up. Internal decision math uses B_default (the filtered subset), falling back to B_full when B_default is zero.

**Baseline validity gate:** The system requires `B_full > 0 AND cRatio > 0` to produce meaningful cost metrics. When either condition fails:

- `x` = 1 (fallback, not null)
- `dhat`, `xSweet`, `mf`, `bp`, `rentRate` = null
- `g` returns at least the floor value (independent of baseline)
- Lamp state reports `no_transcript` or `insufficient_data`

Since the system overhead floor is set from the very first usage snapshot, B_full becomes positive on the first interaction — no file operations are required.

**Left-arm whitening:** When `x < xSweet`, bp for gating purposes is null. No gate consumer (deep-water detection, rate-lamp boundary, notification trigger) fires on the left arm. A session that has not reached the sweet spot is not "overstaying."

**Deep-water predicate:** The system reports deep-water state if and only if `x >= xSweet AND bp >= BP_AMBER`. Notifications require this state to be sustained, not merely instantaneous — the gate debounces transient spikes. The conjunction ensures that only right-arm positions with material premium trigger alerts.

**Rate-lamp integration:** The billing ledger integrates rentRate over time via trapezoidal accumulation. Alerts fire on sustained cost (bill-cycle crossings), not on instantaneous bp spikes. The backstop interval adapts to mf — higher stakes shorten it; lower stakes lengthen it.

---

## Persistence Boundary

**Segment profiles:** On each segment boundary and at shutdown, a summary profile is archived to persistent storage. This includes exit metrics (B, L peak, g, bp, mf, turns, duration) — enough to reconstruct cross-segment trends.

**Per-call time series:** The full call-by-call history lives only in process memory. On resume, the system replays the transcript from byte zero to rebuild this state. If the transcript file is lost, per-call history is unrecoverable; only the archived segment profiles remain.

**Rate-lamp ledger:** The billing ledger is persisted independently via periodic checkpoints. An unclean exit may lose recent state. On restart, the system loads the last valid checkpoint; if none is usable, it starts a fresh ledger.

---

## Hook Behavior

The session-start hook fires on `startup`, `resume`, `clear`, and `compact`. Its observable effects:

**Handoff discovery:** On `startup` and `clear`, the hook queries persistent storage for undelivered handoffs belonging to the current project. When found, it injects a reminder into the session context containing the load token, age, and task preview. On `resume`, handoff discovery is skipped — the session already has context.

**Server rotation:** When the hook detects a session-id mismatch (new session connecting to a running server), it issues a rotation request. The server archives the current segment and switches to the new transcript. If rotation fails, a fallback context is injected instructing the agent to call `rotate_session` manually.

**Bounded best-effort:** The hook always exits zero and its execution is capped by the host's command timeout. Any failure (database unavailable, server unreachable, parse error) is silently absorbed — the session starts with or without measurement context.

---

## MCP Tools

Stable commands exposed to the agent:

| Tool | Purpose |
|------|---------|
| `start_watcher` | Ensure measurement is active; returns server endpoint |
| `stop_watcher` | Request measurement shutdown (may be a no-op when lifecycle is process-bound) |
| `watcher_status` | Query whether the measurement server is reachable |
| `get_bucket_summary` | Per-path token breakdown (B composition) |
| `prepare_handoff` | Package paths + summary for the next session |
| `load_handoff` | Retrieve a handoff package by token or search |
| `get_bookmark_detail` | Drill into a specific turn from the bookmark index |
| `rotate_session` | Switch the server to a new session/transcript |

---

## Degradation

**Transcript missing:** The system reports white lamp with reason `no_transcript`. Cost-model outputs fall back to their defined invalid-state defaults. Measurement resumes automatically when the transcript becomes available.

**Transcript corrupt or unparseable:** Partially readable content is processed up to the last valid entry. Corrupt trailing bytes are skipped. Metrics reflect only the successfully parsed portion.

**Database unavailable:** Persistence failures during operation (handoff discovery, segment archival, bookmark writes) degrade independently — each fails open without stopping measurement.

**Server unreachable during rotation:** The hook injects fallback context instructing the agent to call `rotate_session` manually.
