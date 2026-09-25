---
name: sw-handoff
description: Use when the user runs /sw-handoff or wants to carry over context before /clear — prepares a structured handoff (keep/discard file decision + summary + next task) and returns a load token for the next segment.
---

# Session Watcher Handoff

Prepare a handoff package so the next session can resume without re-reading what its first task needs, and without carrying what that task will not open.

## Steps

1. **Get turn skeleton** via MCP `get_turn_skeleton {}` → `{ snapshot_id, skeleton_path, notes_path, protocol }`. Follow the `protocol` sentence it returns; it states how the two files are filled.

   - **The call fails** — an error instead of that shape, whatever its cause. Stop this run: report to the user that the turn skeleton could not be captured; do not produce or submit notes, and do not go on to `prepare_handoff`.

2. **Produce turn notes** you MUST follow [`NOTES.md`](NOTES.md) exactly for what each note says. Write them inline — do not delegate to a subagent.

3. **Submit notes** via MCP `submit_turn_notes { snapshot_id }`. The server reads `notes_path` itself.

   - **`invalid_notes`** — each `issues` entry names a `t`, and each one is one section of `notes_path`. Edit those sections and submit again, at most **three** times (four submissions in all). If the last one still rejects, stop and report to the user; do not loop.
   
   The other three codes stop this run. Report the error to the user and take no further step:
   - **`stale_snapshot`** — snapshot is no longer current. Stop: report to the user; do not re-fetch the skeleton or re-produce notes.
   - **`invalid_snapshot`** — the capture's source identity or required metadata is invalid, including a transcript that cannot be read. Stop: report to the user.
   - **`storage_unavailable`** (`retryable: true`) — store temporarily unavailable. Stop: report to the user; they may re-run the skill when ready.

4. **Fetch bucket data** via MCP `get_bucket_summary` tool.

   If `metrics.br < 0.05` AND few turns: note "Context is still light — handoff may not be necessary yet, but proceeding as requested."

5. **Select paths to keep.** The kept set is what the next task must have in hand before it can act. Candidates are the bucket summary plus any path this segment used that the bucket lacks. For each candidate, name the act of `next_task` that opens it; a candidate with no such act is not kept, whatever this segment did with it.
   - The repo outlives `/clear` and the conversation does not, so a file the next session can read on demand is kept only where that first act needs it in hand: the file the task edits, the test that guards it, the artifact under discussion.
   - A blob under review is read by its reviewer, so what the next task needs is the review's return and the sources it cites.
   - Read each candidate's `tokens` from the bucket summary and total them before prepare. Where one path carries more than half that total, state which act needs all of it, or keep its `symbols` alone.

   Always: `userOverride` decides that path; a `keep:` list in the arguments is kept verbatim; symbols come from `activeSymbols` into `paths_to_keep[].symbols`; memories, `CONTEXT.md`, `CLAUDE.md` stay off the list.

   Before prepare, tell the user the kept total, each kept path with the act that opens it, and every edited or repeatedly read bucket path left out.

6. **Select skills** — `skills_to_keep`: only skills actively guiding the workflow or required by next_task. Skip one-shot completed skills. Never include `sw-load` — it drives the load flow itself and is always invoked automatically. If the user's `keep:` list includes skill names, use those directly.

7. **Write the summary** you MUST following [`SUMMARY.md`](SUMMARY.md) exactly. Redact secrets as `[REDACTED]`

8. **Prepare** via MCP `prepare_handoff` tool with:
   - `paths_to_keep`: array from step 5
   - `skills_to_keep`: array from step 6
   - `summary`: from step 7
   - `next_task`: the user's stated next step if the arguments give one; otherwise the line of work this segment was on, not a single step of it.
   - `observed_segment`: segment value from step 4

   Check `resolved_paths` in the response — if the server picked wrong, re-issue with the absolute path.

   **Revise an existing handoff** (fix paths, update summary): pass its `load_token` and report whichever `load_token` comes back — an undelivered handoff keeps its token, a delivered one is immutable so the revision arrives under a new one.

   Fallback (MCP unavailable): take the server URL from the session-start line `[Session Watcher] Server: http://...` and use `curl -s -X POST '<url>/api/handoff/prepare'` with the same JSON body.

9. **Report to user:** "Handoff prepared. Kept `<kept_tokens>` tokens. Token: `<token>`. `/clear` when ready."

### Completion criterion

Done when: prepare returned 200 with a `load_token`, you relayed it to the user, and the user acknowledged.
