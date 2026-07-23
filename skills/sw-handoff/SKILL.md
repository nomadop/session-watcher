---
name: sw-handoff
description: Use when the user runs /sw-handoff or wants to carry over context before /clear — prepares a structured handoff (keep/discard file decision + summary + next task) and returns a load token for the next segment.
---

# Session Watcher Handoff

Prepare a handoff package so the next session can resume with minimal re-reading.

## Steps

1. **Fetch bucket data** via MCP `get_bucket_summary` tool.

   If `metrics.br < 0.05` AND few turns: note "Context is still light — handoff may not be necessary yet, but proceeding as requested."

2. **Select paths** — decide keep vs discard per entry:

   **If the user provides `keep: path1, path2, ...`** (e.g. from the dashboard panel): use that list directly as the kept paths. Anything not listed is implicitly discarded. You may add CLAUDE.md or other essential config files if missing from the list.

   **Otherwise** (no explicit keep list): decide per entry:
   - KEEP: related to next_task; high `last_active_turn`; core config/schema; tests under active debugging.
   - KEEP (override): excluded-by-default files critical for next_task (exclusion ≠ discard).
   - DISCARD: stale/unrelated; generated files (node_modules, dist); one-shot output.

   Each entry is `{path, symbols?}`

3. **Select skills** — `skills_to_keep`: only skills actively guiding the workflow or required by next_task. Skip one-shot completed skills. Never include `sw-load` — it drives the load flow itself and is always invoked automatically. If the user's `keep:` list includes skill names, use those directly.

4. **Write the summary** following [`SUMMARY.md`](SUMMARY.md) exactly. Redact secrets as `[REDACTED]`

5. **Prepare** via MCP `prepare_handoff` tool with:
   - `paths_to_keep`: array from step 2
   - `skills_to_keep`: array from step 3
   - `summary`: from step 4
   - `next_task`: what comes next. **Default:** if the user doesn't specify, infer from the current conversation — continue the work in progress (the task being actively worked on, not a generic description).
   - `observed_segment`: segment value from step 1

   Check `resolved_paths` in the response — if the server picked wrong, re-issue with the absolute path.

   **Update in place:** to revise an existing handoff (fix paths, update summary), pass `load_token` of the existing handoff. The server overwrites that record instead of creating a new one.

   Fallback (MCP unavailable): resolve the server URL from session-start additionalContext (`Session Watcher server: http://...`) and use `curl -s -X POST '<url>/api/handoff/prepare'` with the same JSON body.

6. **Report to user:** "Handoff prepared. Token: `<token>`. `/clear` when ready."
   Report `carry_over_pct` and `preparedStats` gate position. If `carry_over_pct > 60%`, note the carry is heavy.

### Completion criterion

Done when: prepare returned 200 with a `load_token`, you relayed it plus stats to the user, and the user acknowledged.
