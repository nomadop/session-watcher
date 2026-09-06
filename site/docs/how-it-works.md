# How It Works

Session Watcher is a real-time instrumentation layer for Claude Code sessions. It observes the transcript as it grows, derives position and cost metrics per API call, and delivers them to a browser dashboard. This page describes the logical pipeline, the session lifecycle, and why each stage produces correct results.

## Pipeline

A single API call flows through these stages:

```
Claude Code session
    │
    ▼  writes usage rows into a local transcript
┌──────────────────────────────────────────────┐
│  Incremental read                             │
│  Only new bytes since last poll are consumed  │
└──────────────────────────────────────────────┘
    │
    ▼  parse, build branch topology, find active path
┌──────────────────────────────────────────────┐
│  Fold                                         │
│  Deduplicate by message ID (idempotent),      │
│  detect segment boundaries                    │
└──────────────────────────────────────────────┘
    │
    ▼  one valid usage snapshot per API call
┌──────────────────────────────────────────────┐
│  Measurement                                  │
│  ├─ Baseline (B): per-path token accounting   │
│  ├─ Position (L): effective context length    │
│  ├─ Growth (g): smoothed residual rate        │
│  ├─ Settlement: absorb cache-timing noise     │
│  └─ Cost model: dhat, bp, mf from EOQ theory │
└──────────────────────────────────────────────┘
    │
    ▼  assembled status snapshot
┌──────────────────────────────────────────────┐
│  Rate lamp                                    │
│  Integrate rentRate into billing ledger,      │
│  evaluate gate and backstop triggers          │
└──────────────────────────────────────────────┘
    │
    ▼  push to connected clients
┌──────────────────────────────────────────────┐
│  Dashboard                                    │
│  Browser fetches status on each data event,   │
│  renders gauges and history chart             │
└──────────────────────────────────────────────┘
```

**Why this works:**

- **Incremental read** ensures no data is missed or double-counted regardless of how fast the transcript grows.
- **Idempotent folding** means streaming revisions of the same call never create duplicate entries — only the final snapshot survives.
- **Segment scoping** resets metrics on each context boundary so stale history from a previous context never contaminates current measurements.
- **Settlement** absorbs the timing gap between cache-creation and cache-read: B is credited ahead of L during the lag, and the deferred ledger prevents that gap from appearing as false growth. Any ledger balance un-retired at segment end is treated as estimation error and corrected out of the buckets.
- **Growth smoothing (g)** uses Holt double-exponential tracking (level + trend) on the settled residual. This converges faster than a simple EMA when the growth regime shifts, and the floor prevents cold-start division-by-zero without suppressing alerts once the session advances past the floor-derived sweet spot.
- **Cost chain** maps the session to an EOQ inventory cycle: the fixed restart cost is cRatio × baseline (analogous to the order cost per batch), the per-token cache-read price is the holding cost, growth rate g is the demand rate, and session length in calls is the order quantity. The nucleus (dhat) is the resulting optimal cycle scale; the sweet spot is where amortized restart cost equals accumulated holding cost. This mapping produces a single dimensionless premium (bp) that is comparable across models and session sizes.
- **Rate lamp integration** converts instantaneous bp into a cumulative bill-cycle count, so alerts fire based on sustained cost accumulation rather than momentary spikes.

## Session Lifecycle

### 1. Hook (session-start)

Claude Code fires a hook on startup, resume, clear, or compact. The hook discovers the running server, hands it the transcript path, and injects any pending handoff tokens into the session context.

### 2. Server bootstrap

The MCP entrypoint starts a watcher instance, an HTTP server on a loopback port, and writes a discovery file so that hooks and the statusline can locate it. The server lifecycle is tied to the Claude Code process.

On resume (or any fresh process start with an existing transcript), the watcher replays the transcript from byte zero — reconstructing the full call history, measurement state, and segment boundaries from the file alone. This is how per-call time series data survives a process restart without requiring a separate persistent store for it.

### 3. Polling

A timer drives the pipeline at regular intervals:

1. **Late resolution** — if the transcript did not exist at startup, retry each tick.
2. **Idle gate** — skip ticks when no clients are connected and nothing changed recently.
3. **Poll** — run the full pipeline (read → fold → measure).
4. **Rate-lamp advance** — integrate new samples into the billing ledger.
5. **Broadcast** — notify connected browsers that fresh data is available.

### 4. Segmentation

A segment is a contiguous stretch of context between resets. Boundaries are detected by topology (a new root UUID from `/compact` or `/continue`) or, as a fallback, by a totalStock drop large relative to the stock itself — a reset replaces the whole conversation prefix, so a small dip is not one. The fallback judges that one quantity and nothing else: cache-read alone lags behind the context it stands for, and whether the prefix survived is a single question.

On boundary: finalize settlement, archive the segment for history, and reset all metrics to initial state. This ensures the cost model always reflects the current context, not a mixture of old and new.

### 5. Session rotation

When Claude Code restarts within a grace window, the hook sends the new session-id. The server archives the current segment, switches to the new transcript, and updates its discovery file.

### 6. Shutdown

On termination or idle timeout: stop timers, close connections, archive the final segment, and remove the discovery file. Segment archival persists profile summaries to SQLite — enough to reconstruct cross-segment trends but not the full per-call time series, which lives only in the current process memory.

## Handoff

When a session ends, the agent can package its working context for the next session. The handoff mechanism bridges the gap between `/clear` (which destroys in-memory context) and the new session (which starts empty).

1. The agent selects which file paths and symbols are essential for the next task — guided by the per-path token weights from B. It writes a structured summary (current state and intent, not history) and submits the package. The server persists this package on its own; nothing about the conversation is selected automatically.

2. On `/clear`, the session-start hook fires for the new session. The hook queries persistent storage, finds the undelivered handoff for this project, and injects a reminder into the session context containing the load token, age, and task preview. The load skill reads this reminder and initiates the restore flow.

3. The load skill extracts the token from the injected reminder, retrieves the handoff package, and reads the kept paths using the cheapest strategy available (symbol line ranges when present, full file otherwise). As these files are read, they flow through the normal pipeline — fold processes them, path attribution adds them to B — so the baseline naturally rebuilds to reflect the carried context. The response also carries a page of the history turns behind the handoff — the newest ones that fit a fixed budget, each a user request carrying the note written for it where the turn had one — plus a cursor for the next page, whose presence proves more history remains while its absence does not prove none does. Three read tools go further into that same history: page deeper, search a literal that occurs verbatim, or locate the turn ranges that mention a remembered term. Each resolves the lineage from the handoff this session loaded, so none of them takes a lineage identifier.

**Why this works**

- **B recovers from disk state, not snapshots.** The handoff carries path references, not cached token counts. If a file was deleted or changed since prepare, B reflects reality — stale entries do not inflate the baseline.
- **Hook injection eliminates manual token passing.** The user does not need to remember or copy a token. The hook discovers and injects it; the agent picks it up on the first interaction.
- **Turn notes preserve trajectory without bulk.** Rather than predicting which turns will matter later, the system records every history turn at the moment the handoff is prepared — each with the note written for it, and a turn with no assistant work of its own recorded without one — then delivers the newest of them as a page under a fixed token budget. What does not fit stays reachable through the read tools instead of being guessed at up front, so the handoff package stays small without discarding the trail that led to it.
