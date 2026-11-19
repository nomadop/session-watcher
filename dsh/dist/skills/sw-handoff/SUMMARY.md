# Handoff Summary Template

Write a concise checkpoint so the next session can continue the same line of work after the context reset. Use the state and decisions shown in the available conversation; do not infer missing events or reconstruct internal reasoning.

Two principles govern what goes in the summary:

1. **State, not history.** The next session needs where we ARE and how to RESUME. Commits record what happened — reference them by hash, don't retell them.
2. **Underivable only.** If git log, grep, reading the code, or a turn note you just wrote answers it, leave it out. The summary carries user intent, choices and reasons already stated, and conversation-only state.

Use these section headers exactly. Write `(none)` for empty sections — never omit or pad.

---

## Objective

[One sentence: the goal we're working toward.]

## Working state

[High-level only — paths_to_keep already tells the next session which files/symbols to read. Here: how the pieces connect, current behavior vs intended, remaining gap. No file:function lists, no "we did X".]

## Discussion context

[User-side and unresolved context — a turn note records what the assistant did, not what it was told. Write `(none)` if there is no such context.]

- **User corrections**: where the user redirected approach, and what they said
- **Constraints from conversation**: verbal rules not yet in code or CLAUDE.md
- **Open questions**: unresolved points needing user input

## Active constraints

[Invariants the next session must respect, including locked interfaces. Include an already-stated reason when it affects how to apply a constraint.]

## Blockers / risks

[Only unresolved items affecting next_task.]
