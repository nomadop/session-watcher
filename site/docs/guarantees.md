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

**Context-reset signal:** A structural indicator that the context window has been cleared or compacted. It comes from transcript topology alone — a drop in reported token totals is not one, however steep. The measurement system uses it to trigger segment boundaries.

**Tool-event stream:** File operations (reads, writes, edits) with their content, used to compute per-path token contributions to B. Each event carries a path and enough content to estimate token cost at ingestion time.

---

## Measurement Invariants

Given correct input, the measurement layer guarantees:

**Folding:** When multiple snapshots share the same primary key, only the revision with the highest total token count is retained. Earlier or partial revisions are silently replaced. A fold revision never triggers a segment boundary.

**Segment isolation:** On context-reset, the accumulated cost state resets: B rebuilds from zero, g returns to floor, the deferred ledger clears, the model a segment's reads resolve against is cleared for the next call to fix, and the rate lamp starts a fresh billing cycle. What survives is the turn count and an unconsumed turn boundary, so a user turn already announced still opens its turn on the far side of the reset. Cross-segment history is preserved for visualization but does not contaminate current measurements.

**Token-at-Ingestion:** Per-path token estimates are computed once at write time using a model-specific conversion ratio. Values are never retroactively recomputed — changes in calibration or file content only affect future observations.

**Settlement:** When B grows faster than L (cache-creation credited before cache-read materializes), the surplus is banked in a deferred ledger as credit L has yet to confirm, and retires as L catches up. Any balance un-retired at segment end is treated as estimation error and corrected out of the path totals.

**Sidechain exclusion:** A row marked as sidechain is a self-contained sub-agent context and is dropped before interpretation, so it yields no evidence of any kind: it contributes to L, g, segmentation triggers, turn counting and path attribution alike not at all, and its identifiers never reach topology.

---

## Output Semantics

The system publishes a status snapshot after each measurement cycle. Consumers can rely on:

**Position constraint:** The public field `B` never exceeds `totalStock`. This cap is a transient display guard during cache-creation lag; it self-releases once the provider's cache catches up. Internal decision math uses B_default (the filtered subset) as its position basis.

**Baseline validity gate:** The system requires a positive position basis (B_default) AND `cRatio > 0` to produce meaningful cost metrics. When either condition fails:

- `x` = 1 (fallback, not null)
- `u`, `pp`, `mf`, `br`, `dhat`, `xSweet` = null, and the reference skeleton is absent, which withdraws every position landmark with it
- `g` returns at least the floor value (independent of baseline)
- Lamp state reports `no_transcript` or `insufficient_data`

Since the system overhead floor is set from the very first usage snapshot and is itself part of B_default, B_default becomes positive on the first interaction — no file operations are required.

**Left-arm silence:** Which arm the session is on is decided by normalized position, never by the position ratio against xSweet. Before the sweet spot the lamp shows white until the position reaches the mirror image of the amber boundary and green from there on; the warning and critical zones are right-arm states only, so a session that has not reached the sweet spot is never coloured as "overstaying."

**Restart reminder:** The reminder is raised by the rent ledger and by nothing else. Each measured call adds its rent increment to a wallet phase scaled by the reminder interval, and a call whose increment carries that phase across a lap boundary raises a reminder stamped with the lap count reached and wraps the phase, so a call that crosses several boundaries is announced by that stamp rather than by a reminder per lap. Rent already accumulated is settled: a revaluation — by a baseline change, a change of selected files, or a price change — withdraws no reminder already raised and rewinds no phase already advanced.

**Rate-lamp integration:** One rent increment per measured call, formed by trapezoidal accumulation across the call's interval, feeds two counters: a bill cycle, which is display only and triggers nothing, and the wallet phase, whose lap boundary is what raises the reminder. Reminders therefore follow accumulated cost rather than an instantaneous bp spike. The reminder interval adapts to mf — higher stakes shorten it; lower stakes lengthen it.

---

## Persistence Boundary

**Segment profiles:** On each segment boundary and at shutdown, a summary profile is archived to persistent storage. This includes exit metrics (B, L peak, g, br, mf, turns, duration) — enough to reconstruct cross-segment trends.

**Per-call time series:** The full call-by-call history lives only in process memory. On resume, the system reconstructs it by re-reading the transcript from byte zero — the same interpretation the live path applies, so the rebuilt series is the one live observation would have produced. If the transcript file is lost, per-call history is unrecoverable; only the archived segment profiles remain.

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
| `get_turn_skeleton` | Render the turns of the capture epoch, one block per turn, as the slots a note can fill |
| `submit_turn_notes` | Return the producing session's notes through the slots the skeleton defines |
| `prepare_handoff` | Package paths + summary for the next session |
| `load_handoff` | Retrieve a handoff package by token or search |
| `rotate_session` | Switch the server to a new session/transcript |
| `turn_page` | Read a page of the history turns carried by the loaded handoff, newest first |
| `turn_search` | Find a literal that occurs verbatim in the transcripts behind the loaded handoff |
| `turn_locate` | Find which turn ranges mention a remembered term, when the source wording is unknown |

The three history tools resolve their own lineage from the handoff delivered into the calling session, so none of them accepts a lineage identifier: a session that has loaded nothing is told so rather than offered a guess. Paging is deterministic and needs no query; the two query tools are distinguished by what the caller actually remembers. Every search or locate result names what to do with it — follow a hit, narrow a truncated match set, or switch tools on a miss — while a page that was built simply arrives.

---

## Degradation

**Transcript missing:** The system reports white lamp with reason `no_transcript`. Cost-model outputs fall back to their defined invalid-state defaults. Measurement resumes automatically when the transcript becomes available.

**Transcript corrupt or unparseable:** Partially readable content is processed up to the last valid entry. Corrupt trailing bytes are skipped. Metrics reflect only the successfully parsed portion.

**Database unavailable:** Persistence failures during operation (handoff discovery, segment archival, turn-record writes) degrade independently — each fails open without stopping measurement.

**Interpretation fails outright:** An error the system cannot classify as an unreadable or malformed source is treated as a defect rather than absorbed: measurement stops, the owner reports the error, releases what it holds without archiving the open segment, and exits nonzero. The transcript is left untouched, so a fresh owner rebuilds from it.

**Server unreachable during rotation:** The hook injects fallback context instructing the agent to call `rotate_session` manually.
