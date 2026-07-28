---
name: sw-load
description: "Use BEFORE calling load_handoff MCP directly. Triggers: user provides a handoff token, user asks to resume/continue previous work, session-start output mentions a handoff, or you are about to call load_handoff for any reason."
---

# Session Watcher Load Handoff

Restore a previous session's handoff package into context so work can resume.

## Steps

0. **Resolve the token** — check these sources in order:
   - Skill `args` (if invoked with a token directly).
   - The user's message (e.g. `handoff：some-token-here`).
   - System-reminder containing `[Session Watcher] Handoff available (token: <token>, ...)` — extract the token from that line.

1. **Load the handoff via MCP `load_handoff` tool:**
   - Token known (single): call `load_handoff` with `load_token` → proceed directly.
   - Multiple tokens in system-reminder: list them with age/task preview, ask the user which to load.
   - Query search: call `load_handoff` with `query` → present results, user picks.
   - Auto-match: call `load_handoff` with no args → present what was found, user confirms before proceeding.

   Only the token-known path skips user confirmation — query and auto-match always require the user to confirm which handoff to load.
   If `found: false` → inform user the token is expired/invalid, ask for direction.

   Fallback (MCP unavailable or returns error): resolve the server URL from session-start additionalContext (`Session Watcher server: http://...`) or latest state file in `~/.session-watcher/`, then use `curl -s '<url>/api/handoff/load?load_token=<token>'`.

2. **Read kept paths** — you MUST see [`PATHS.md`](PATHS.md) for resolution and read-strategy rules.

3. **Orient via bookmarks** — if `bookmark_index` / `recent_user_intents` present in the load response:
   - Scan bookmark_index for the work trajectory (what was being built/fixed)
   - Scan recent_user_intents for the user's actual asks
   - If a bookmark looks critical but the summary doesn't cover it: call `get_bookmark_detail` with that turn_index for ±3 turn context
   - Don't drill every bookmark — only when the summary leaves a gap

4. **Load skills** — if `skills_to_keep` present, invoke each via the Skill tool.

5. **Present loaded context to user:**
   - Objective (1 line)
   - Working state (from what you actually read — confirm or correct the summary's claims)
   - Next task + entry points
   - Blockers/risks

6. **Invoke suggested skills** from `next_task` if applicable — ask user confirmation first.

7. **Report to user:** "Handoff loaded. Token: `<token>`."
   Report `next_task` and `path_loaded`. If there is any critical `bookmark`, note to user.
   You MUST ensure the user has acknowledged the loaded context and confirmed the next steps before proceeding.

### Completion criterion

Done when: kept paths are in context, you presented the state to the user (in your own words, based on what you read — not echoing the summary verbatim), and the user has enough context to give direction.
