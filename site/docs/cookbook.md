# Cookbook

This page collects operational scenarios and guidance for interpreting Session Watcher output. For formal definitions of all terms below, see the Concepts page. For behavioral guarantees, see the Guarantees page.

## Scope and Limits

- Session Watcher is a **cost-timing guardrail**, not a quality evaluator. A metric says you are overpaying — it cannot say the model is degraded or the output is worse.
- All conclusions depend on the accuracy of the cache-pricing model (cRatio) for the current provider. If pricing changes, the sweet spot and bp shift accordingly.
- B, g, and all derived quantities (dhat, xSweet, bp, mf) are measured estimates with defined invalid states. When baseline is invalid the system reports fallback values, not guesses.
- The tool does not decide or execute restarts. It surfaces cost position; the human decides whether to continue, hand off, or restart.

## Lamp / bp Interpretation

**Scenario: bp stuck at red or amber for many turns.**
The session has been running beyond the efficient operating zone for an extended period. bp is an instantaneous snapshot recomputed each observation from the current L, B, g, and cRatio — it can decrease if conditions change (e.g., B grows while L stays constant, or g drops). If bp stays elevated for many turns, the session is persistently in an inefficient region. Consider preparing a handoff and restarting. If the task is nearly complete, finishing may cost less than the overhead of a fresh context rebuild. Note that billProgress (the meter bar) is the truly accumulated quantity — it integrates rent rate over time within each billing cycle and never decreases within a cycle.

**Scenario: White lamp displays throughout the session.**
White indicates one of three states. (1) `no_transcript` — the watcher cannot locate or open the transcript file; verify the path configuration. (2) `insufficient_data` — the transcript exists but no usage rows have been ingested yet (the first API call has not been folded). Since the system overhead floor is set from the very first usage row, this state resolves on the first model interaction — no file reads are required. (3) Healthy low-pressure zone — measurement is reliable, but x is below both the sweet spot and the left-arm amber boundary. This is a normal, efficient state (the session has not yet grown enough for the penalty function to engage). To distinguish these causes, check the reason or reliability field in the status output rather than interpreting white solely as a data-quality problem.

**Scenario: mf seems low (~20–30%).**
The movable fraction represents how much of the context bill is timing-sensitive. In practice mf typically ranges from about 20% to the theoretical ceiling of ~41%. Values in the low 20s mean that most cost is fixed overhead — timing optimization has limited leverage. Handoff value is reduced but not zero; bp still fires when the positional penalty is large enough. A persistently low mf means the session is carry-heavy (large B relative to growth), which is normal for sessions that loaded many files early.

**Scenario: Understanding the two progress bars.**
The statusline shows two bars side by side. The **cycle bar** (10-char `▓░` + percent) shows how far through the current billing cycle you are. It fills by integrating rent rate; when full it wraps to zero and increments the cycle count. A fast-filling bar means high rent rate. It is purely diagnostic — it does not trigger anything.

The **depth bar** (n/N in the statusline, graphical bar in the dashboard) is the decision reminder. It only activates once bp has stayed above amber long enough to fire the deep-water gate. After that, n counts billing cycles completed in deep water; N is the backstop interval (adapts to mf — shorter when restart value is high). When n reaches N, the backstop notification fires and n resets. The depth bar tells you "you have been overspending long enough — it is time to act."

**Scenario: bp seems wrong for what you are doing.**
bp is only as good as B_default. If B_default does not reflect the files you actually need for the current task, bp will be miscalibrated. Common cases: (1) the session loaded many large files early that are no longer relevant — B_default is inflated, bp appears lower than reality. (2) Critical working files are gitignored or outside the project — B_default understates the real carry, bp appears higher than warranted. Before trusting an amber/red signal (or an unexpectedly green one), sanity-check the bucket panel: does B_default match what you would actually carry into a new session? If not, adjust includes/excludes first.

**Scenario: Provider switch causes a bp jump.**
Switching models mid-session changes cRatio (the cache-write-to-cache-read price ratio). Since bp depends on cRatio through mf and dhat, a ratio change recalculates the cost geometry instantly. The jump is not an error — it reflects genuine repricing of the session under new economics. If the new model has a lower cache-write/cache-read ratio, the sweet spot moves inward and the session may enter amber sooner; if higher, the session gets more room before penalty engages.


## When to Restart

**Scenario: bp crosses amber (the first threshold).**
Amber signals that the instantaneous timing-sensitive cost premium has reached a noticeable level. This is a suggestion, not a command. If a natural stopping point exists (task boundary, topic shift), this is a good time to prepare a handoff. If mid-task, weigh the cost of context rebuilding against the ongoing overspend.

**Scenario: bp crosses red (the higher threshold).**
Red means the overspend fraction is substantially higher. However, red does not mean "restart immediately." If the current task will complete in a few more turns, finishing is usually cheaper than the disruption cost of a handoff plus the tokens spent rebuilding context in a new session. Red is most actionable at natural task boundaries.

**Scenario: Mid-task bp is red but work is nearly done.**
Finish the task. The marginal cost of a few more turns at elevated bp is typically less than the fixed cost of preparing a handoff, starting a new session, loading context, and re-orienting. Use bp red as a signal to avoid starting additional unrelated tasks in this session.

**Scenario: The session sits in a flat valley just past sweet.**
When u (the normalized position) is only moderately above 1, the overspend grows slowly. The cost function is quadratic near the sweet spot, so a 2x deviation in u from sweet costs only about 25% additional bill on the timing-sensitive fraction. Flat valleys are efficient enough to continue working through.

**Scenario: Applying a fixed token policy ("restart at 200k tokens").**
Fixed-token restart policies ignore the session's actual economics. A session with high g (rapid growth) reaches amber at a higher L than one with low g — higher g increases dhat (the characteristic scale), which pushes the sweet spot and amber threshold further out, giving more room before the premium engages. A session with low mf (mostly dead weight) may never benefit from restart regardless of total size. Use bp directly — it already integrates L, B, g, and cRatio into a single actionable signal.


## Measurement Bias and Conservative Assumptions

**Scenario: B_default excludes gitignored files, but the session works with them.**
B_default reflects only the files that pass the inclusion filter (not gitignored, not user-excluded). If your session heavily relies on files that are excluded from baseline, B_default understates the true required carry. The session will appear to have a higher premium than it actually deserves. Use the include override mechanism to add critical paths so the measurement accounts for them.

**Scenario: Residual is large — is it all waste?**
The residual bucket (L minus B) captures everything not attributed to tracked file paths: reasoning history, tool output, conversation structure, and ephemeral working memory. (System prompts and tool definitions are part of the system overhead floor, which is already included in B — they do not appear in the residual.) Much of this is productive context, not waste. A large residual is normal for tool-heavy sessions. The metric does not judge the value of residual content — only that it exists and contributes to cost.

**Scenario: g is climbing but the session feels productive.**
The growth rate g measures how fast new content arrives relative to the baseline. It does not distinguish productive growth (new files being explored, code being written) from thrashing (repeated failed attempts generating tool output). A high g means cost is accumulating quickly regardless of cause. If the growth is productive, the session is efficiently using expensive context; bp still applies as the cost signal.

**Scenario: mf seems capped below 50%.**
The movable fraction has a theoretical ceiling around 41.4% (the AM-GM bound). This is by construction: even in the worst case, timing optimization can affect at most this fraction of total bill. However, bp itself is NOT bounded by this ceiling. Since bp equals mf multiplied by the positional penalty pp, and pp is unbounded (it grows without limit as u deviates from 1), bp can exceed any fixed value in a sufficiently extended session. The mf bound limits only the movable-fraction component, not the overall bill premium.

**Scenario: Detected cache miss during the session.**
When a cache miss is detected (cacheRead drops while total context stock is preserved), L is reconstructed as cacheRead plus cacheCreation — it does not drop to near zero. The miss detection logic in the fold stream classifies this pattern and applies stock reconstruction, so the metrics see a continuous L rather than a transient cliff. A topology change (non-first null-parent root UUID, indicating /compact or /continue) is the primary segmentation signal, not a cache miss. A secondary fallback fires only on a totalStock drop past a floor relative to the stock it judges (a quarter of it), and that stock is the only field it reads. New files entering the B bucket do NOT trigger segment boundaries. Undetected misses (patterns that do not match the miss classifier) are not explicitly handled, but are rare in practice.

**Scenario: "Metric says amber but the session feels fine" / "Metric says green but output quality dropped."**
Session Watcher measures cost geometry, not output quality. Amber/red means you are paying more than optimal timing would require — the model may still be performing well. Conversely, green means cost is efficient — but the model could be producing poor output due to task difficulty, prompt issues, or capability limits. Never use lamp state as a quality proxy.


## Handoff Operations

Shortest path: `/sw-handoff` → `/clear` → `/sw-load`.

**Scenario: Verifying carry quality after loading a handoff.**
After `load_handoff`, the agent receives the handoff package: a list of kept paths (projected to path, symbol names with current line numbers, and stale/missing markers) and a summary. The response does NOT include actual file content — the agent must read kept paths itself. To verify carry quality, read the kept paths and confirm they still exist and contain the expected content. Hash validation exists internally (the server stamps content hashes at load time for telemetry) but is not exposed in the agent-visible response. B_default recovery depends on which kept files are still readable when the agent accesses them in the new session.

**Scenario: Handoff completed but new session B is lower than expected.**
`load_handoff` retrieves the handoff package but does not validate file existence or fail on missing files. Files that have been deleted, renamed, or moved since prepare time will still appear in the returned paths list — the shortfall surfaces only when the agent (or the fold stream) attempts to read those files and finds them absent. This is expected: B reflects actual current file state, not the historical snapshot from prepare time. To diagnose, compare the paths in the loaded package against what exists on disk.

**Scenario: Choosing which paths to keep during prepare.**
The `prepare_handoff` tool accepts a `paths_to_keep` list. Focus on files that are central to the next task — files you will read or edit in the continuation. The server auto-populates token weights from B_rebuild data. Carrying too many paths inflates B without proportional value; carrying too few means the new session must rediscover context. Aim for the minimal set that lets the next session avoid re-reading core files.

**Scenario: Understanding the load token.**
The load token is a human-readable semantic identifier (two content words plus a random suffix, e.g., `refactor-baseline-elk`) generated from the handoff's next_task field. Use it to retrieve a specific handoff with `load_handoff`. Tokens are unique within a project's handoff store. If you lose the token, use the free-text `query` parameter to search by summary content.


## Configuration and Operations

**Scenario: Reading the statusline fields.**
The statusline displays (left to right): lamp emoji (white/green/yellow/red), meter bar (10-char progress within the current bill cycle, wraps on each cycle completion), backstop progress (n/N — number of completed bill cycles since last alert vs the backstop interval in bill-cycle-counts), bp percentage, u value (normalized position), delta (growth rate g), L/B ratio, and model tag. When the rate lamp is not yet reliable, a neutral "measuring..." line appears instead.

**Scenario: Excluding or including specific files.**
User overrides control which files count toward B_default. Excluding a file removes it from the baseline denominator — the session appears to be carrying less, and bp may increase (same L, lower B). Including a gitignored or previously-excluded file adds it to the baseline — bp may decrease. Overrides propagate to sibling files in the same directory through inference when the directory shows unanimous inclusion or exclusion state.

**Scenario: How long until metrics become reliable after session start.**
The `baselineValid` gate requires `B_full > 0` and `cRatio > 0`. Since the system overhead floor is set from the very first usage row (as `max(cacheRead, cacheCreation, input)`), B_full becomes positive immediately on the first model interaction — no file reads are required. The transition from white (measuring) to a computed lamp can therefore happen on the very first usage row. Before that first usage, the system shows white with reason `insufficient_data`. Sessions with no transcript at all show white with reason `no_transcript`.

**Scenario: Dashboard vs statusline — same data source?**
Yes. Both the browser dashboard (served via the built-in HTTP server) and the CLI statusline (rendered by the hook into the terminal status area) read from the same `getStatus()` output on the watcher instance. The dashboard uses SSE for event notification (`tick` and `scan` messages), then fetches full snapshots via REST (`/api/status`, `/api/history`, `/api/buckets`) on each `scan` event; polling is the fallback trigger when SSE is unavailable. The statusline formats a compact single-line summary of the same fields. They always reflect the same underlying state, though the dashboard may show historical chart data that the statusline cannot.
