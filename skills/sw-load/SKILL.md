---
name: sw-load
description: "Use when the user provides a handoff token, asks to resume or continue previous work, the host's handoff notice announces a handoff, or you are about to call load_handoff."
---

# Session Watcher Load Handoff

Restore a previous session's handoff package into context so work can resume.

## Steps

1. **Load the handoff.** Resolve a token from the skill `args`, from the user's message, or from the host's own handoff notice, which names pending handoffs by token: the Claude Code SessionStart hook's additionalContext. Then call the `load_handoff` tool, whose schema carries the three ways in.

   A token you were handed is the one path that proceeds without asking. Any other way in — a free-text match, an auto-match, or several tokens offered at once — means listing what came back with each one's age and task preview and letting the user pick before you go on. Nothing found → tell the user the token is expired or invalid, and ask for direction.

2. **Read the kept paths.** Relative paths resolve against CWD, then `project_dir`.

   One strategy per entry, the first row that applies:

   | Entry has | Read at load |
   |---|---|
   | `lines` | each range |
   | `resolvedSymbols` | the `(lines a-b)` each string carries |
   | neither | the file's first 40 lines; with `symbols`, also `grep -n` each name in the file to place the entry points |

   Each read is the host's file-reading tool over a line range of the kept file. Each call names one file. Issue every read for every entry in one message — each further turn re-reads the whole accumulated context.

   Unresolvable path → tell the user, skip. Empty `paths_to_keep` → ask the user what they are working on.

3. **Take the payload as the task's state.** The summary, the kept files and the newest turns in the payload are the established current state of the task, which the work builds on without checking or restating it. When a step needs a detail they leave out, `turn_page` reads older turns (an `S{k}:{T}` cursor or an `S{k}` label as `before`) and `lineage_headlines` the headlines of an omitted run (its numbers as `k`, `S2-S5` being `2-5`).

4. **Load the kept skills** — invoke each name in `skills_to_keep` through the host's skill tool.

5. **Present, then hold.** Write:
   - Objective, one line
   - Working state, as the summary states it
   - Next task and its entry points — the `neither` entries with where their symbols sit
   - Blockers and risks
   - The kept paths now in context and the load token you used

   Then stop and wait for the user to confirm or correct it. The next task's first act begins after the reply.

### Completion criterion

Done when the kept paths are in context, the state is presented in the shape step 5 gives, and the user has replied confirming or correcting it.
