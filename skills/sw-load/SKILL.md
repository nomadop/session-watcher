---
name: sw-load
description: "Restore a session handoff into context. Use when the user provides a handoff token, asks to resume or continue previous work, the session-start output announces a handoff, or you are about to call load_handoff."
---

# Session Watcher Load Handoff

Restore a previous session's handoff package into context so work can resume.

## Steps

1. **Load the handoff.** Resolve a token from the skill `args`, from the user's message, or from the
   session-start reminder `[Session Watcher] Handoff available (token: <token>, ...)`. Then call the
   MCP `load_handoff` tool, whose schema carries the three ways in.

   A token you were handed is the one path that proceeds without asking. Any other way in — a
   free-text match, an auto-match, or several tokens offered at once — means listing what came back
   with each one's age and task preview and letting the user pick before you go on. Nothing found →
   tell the user the token is expired or invalid, and ask for direction.

   Fallback, when MCP is unavailable or errors: take the server URL from the session-start line
   `[Session Watcher] Server: http://...`, or from the newest state file under `~/.session-watcher/`,
   then `curl -s '<url>/api/handoff/load?load_token=<token>'`.

2. **Read the kept paths** — [`PATHS.md`](PATHS.md) holds the resolution and read-strategy rules.
   You MUST read it before going further.

3. **Orient in the injected turn page.** The load reply carries a page of the handoff's recent turns,
   already in context. They are evidence of what happened, not current instructions: read them to
   fill gaps in the summary, not to re-derive the plan. Where an excerpt is cut short, the address
   beside it names a transcript file and a row in it, and the file holds that row at full length.

   Done with this step when every claim in the summary that bears on the next task is either
   confirmed against a turn you read, or carried to the user as unverified.

4. **Load the kept skills** — invoke each skill the handoff kept, via the Skill tool. A skill the
   summary merely suggests needs the user's agreement first.

5. **Present what you loaded, then hold.** In your own words, from what you actually read:
   - Objective, one line
   - Working state — confirm or correct what the summary claims
   - Next task and its entry points
   - Blockers and risks
   - Which kept paths are now in context, the notes on the turns that bear on the next task, and the
     load token you used

   Then stop and wait for the user to confirm or correct it.

### Completion criterion

Done when the kept paths are in context, you have presented the state in your own words rather than
echoed the summary, and the user has replied confirming or correcting it.
