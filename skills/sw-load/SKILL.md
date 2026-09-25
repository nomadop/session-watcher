---
name: sw-load
description: "Use when the user provides a handoff token, asks to resume or continue previous work, the session-start output announces a handoff, or you are about to call load_handoff."
---

# Session Watcher Load Handoff

Restore a previous session's handoff package into context so work can resume.

## Steps

1. **Load the handoff.** Resolve a token from the skill `args`, from the user's message, or from the session-start reminder `[Session Watcher] Handoff available (token: <token>, ...)`. Then call the MCP `load_handoff` tool, whose schema carries the three ways in.

   A token you were handed is the one path that proceeds without asking. Any other way in — a free-text match, an auto-match, or several tokens offered at once — means listing what came back with each one's age and task preview and letting the user pick before you go on. Nothing found → tell the user the token is expired or invalid, and ask for direction.

   Fallback, when MCP is unavailable or errors: take the server URL from the session-start line `[Session Watcher] Server: http://...`, or from the newest state file under `~/.session-watcher/`, then `curl -s '<url>/api/handoff/load?load_token=<token>'`.

2. **Read the kept paths.** Each entry is `{path, lines?, symbols?, resolvedSymbols?}`. Relative paths resolve against CWD, then `project_dir`; never against the plugin or skill directory.

   One strategy per entry, the first row that applies:

   | Entry has | Read with |
   |---|---|
   | `lines` | `Read(file, offset=start, limit=end-start+1)` per range |
   | `resolvedSymbols` only | the same, over the `(lines a-b)` each string carries; a string reporting the symbol not found → its `originally at lines` range |
   | neither | `Read(file)` |

   A range read is `Read` with `offset`/`limit`, or `sed -n 'a,bp'` where Bash is the reading tool. Issue every read for every entry in one message — each further turn re-reads the whole accumulated context.

   Unresolvable path → tell the user, skip. Empty `paths_to_keep` → ask the user what they are working on.

3. **Place the summary in its lineage.** `lineage` runs oldest to newest, one headline per session; the injected page holds the newest turns and is already in context. From the page, list the turns whose `A:` note bears on the next task, by their `S{k}:{T}` address; a cut `U:` row is held in full at that row of the transcript the session header names. When a headline bears on the next task and the page does not reach that session, call `turn_page` with that session's label as `before`. That list is what step 5 reports; it is not a verification pass.

4. **Load the kept skills** — invoke each name in `skills_to_keep` via the Skill tool. A skill named only in the summary text is invoked after the user agrees.

5. **Present, then hold.** One `git status --short && git log -1 --oneline`, then write, from the kept paths and that output:
   - Objective, one line
   - Working state — each claim the summary makes about the current state, set against what the kept paths and the git output show: matches, differs (say how), or reaches neither (say unverified)
   - Next task and its entry points
   - Blockers and risks
   - The kept paths now in context, the turns from step 3 with their addresses, and the load token you used

   Then stop and wait for the user to confirm or correct it. Everything else — greps, `gh`, reads outside the kept set, the next task's own first act — begins after the reply.

### Completion criterion

Done when the kept paths are in context, the state is presented in the shape step 5 gives, and the user has replied confirming or correcting it.
