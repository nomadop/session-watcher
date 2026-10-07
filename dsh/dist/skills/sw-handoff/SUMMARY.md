# Handoff Summary Template

Two principles govern what goes in the summary:

1. **State, not history.** The next session needs where we ARE and how to RESUME. Commits record what happened — reference them by hash, don't retell them.
2. **Underivable only.** If git log, grep, reading the code, or a turn note you just wrote answers it, leave it out. The summary carries intent, reasoning, and conversation-only state.

Use these section headers exactly. Write `(none)` for empty sections — never omit or pad.

---

## Objective

[One sentence: the goal we're working toward.]

## Working state

[High-level only — paths_to_keep already tells the next session which files/symbols to read. Here: how the pieces connect, current behavior vs intended, remaining gap. No file:function lists, no "we did X".]

## Discussion context

[User-side and unresolved context — a turn note records what the assistant did, not what it was told. Omit entirely if the session was purely mechanical.]

- **User corrections**: where the user redirected approach, and what they said
- **Constraints from conversation**: verbal rules not yet in code or CLAUDE.md
- **Open questions**: unresolved points needing user input

## Active constraints

[Invariants the next session must respect — the choice and 1-line WHY. Locked interfaces.]

## Blockers / risks

[Only unresolved items affecting next_task.]
