---
name: sw-handoff
description: Use when the user runs /sw-handoff or wants to carry over context before /clear — prepares a structured handoff (keep/discard file decision + summary + next task) and returns a load token for the next segment.
---

# Session Watcher Handoff

Prepare a handoff package so the next session can resume with minimal re-reading.

## Steps

1. **Get turn skeleton** via MCP `get_turn_skeleton {}` → `{ snapshot_id, skeleton_path, notes_path, protocol }`. Follow the `protocol` sentence it returns; it states how the two files are filled.

2. **Produce turn notes** you MUST follow [`NOTES.md`](NOTES.md) exactly for what each note says. Write them inline — do not delegate to a subagent.

3. **Submit notes** via MCP `submit_turn_notes { snapshot_id }`. The server reads `notes_path` itself.

   - **`invalid_notes`** — each `issues` entry names a `t`, and each one is one section of `notes_path`. Edit those sections and submit again, at most **three** times (four submissions in all). If the last one still rejects, stop and report to the user; do not loop.
   
   The other three codes stop this run. Report the error to the user and take no further step:
   - **`stale_snapshot`** — snapshot is no longer current. Stop: report to the user; do not re-fetch the skeleton or re-produce notes.
   - **`invalid_snapshot`** — the capture's source identity or required metadata is invalid, including a transcript that cannot be read. Stop: report to the user.
   - **`storage_unavailable`** (`retryable: true`) — store temporarily unavailable. Stop: report to the user; they may re-run the skill when ready.

4. **Fetch bucket data** via MCP `get_bucket_summary` tool.

   If `metrics.br < 0.05` AND few turns: note "Context is still light — handoff may not be necessary yet, but proceeding as requested."

5. **Select paths to keep** — for each path in the bucket summary:
   - Decide keep or discard based on relevance to `next_task`
   - If the path has `userOverride`, apply the user's decision (keep/discard)
   - If the path has `activeSymbols`, select which symbols to keep (these are verified — no guessing needed)
   - Pass kept symbol names in `paths_to_keep[].symbols`

6. **Select skills** — `skills_to_keep`: only skills actively guiding the workflow or required by next_task. Skip one-shot completed skills. Never include `sw-load` — it drives the load flow itself and is always invoked automatically. If the user's `keep:` list includes skill names, use those directly.

7. **Write the summary** you MUST following [`SUMMARY.md`](SUMMARY.md) exactly. Redact secrets as `[REDACTED]`

8. **Prepare** via MCP `prepare_handoff` tool with:
   - `paths_to_keep`: array from step 5
   - `skills_to_keep`: array from step 6
   - `summary`: from step 7
   - `next_task`: what comes next. **Default:** if the user doesn't specify, infer from the current conversation — continue the work in progress (the task being actively worked on, not a generic description).
   - `observed_segment`: segment value from step 4

   Check `resolved_paths` in the response — if the server picked wrong, re-issue with the absolute path.

   **Revise an existing handoff** (fix paths, update summary): pass its `load_token` and report whichever `load_token` comes back — an undelivered handoff keeps its token, a delivered one is immutable so the revision arrives under a new one.

   Fallback (MCP unavailable): take the server URL from the session-start line `[Session Watcher] Server: http://...` and use `curl -s -X POST '<url>/api/handoff/prepare'` with the same JSON body.

9. **Report to user:** "Handoff prepared. Kept `<kept_tokens>` tokens. Token: `<token>`. `/clear` when ready."

### Completion criterion

Done when: prepare returned 200 with a `load_token`, you relayed it to the user, and the user acknowledged.
