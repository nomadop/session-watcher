# Turn Notes

Write continuity notes that help the next session find the turns it needs to continue the same line of work. Reading and filling the two files is the `protocol` that `get_turn_skeleton` returns; this file governs content only.

## Reading the skeleton

The skeleton is a sequence of turn blocks. Each block opens with a head row carrying a `T` line ordinal and a `U :` label, followed by sampled assistant rows. A block whose turn did assistant work of its own then closes with an aggregate row and a labelled `NOTE[T]: ____` slot. A block that closes without that pair asks for no note, and its rows may still include an assistant one — a bare command echo and the harness's acknowledgement of the user's own local command both reach you this way.

Example block:

```
T   12 | U   : 所以你的意思是当前行为没处理 harness U 吗？
T   18 | A   : 查了两处，harness U 只在 scripts/ 两条互不一致的正则里…
T   26 | A   : …所以按 turn 采样，护栏落在 turn 的行数上而不是行长度上。
      | A×5 · 7 tools: bookmark-service.js,turn.js
      | NOTE[12]: ____
```

**Use the skeleton to locate each turn in the available conversation.** Its assistant excerpts and tool aggregate locate the turn, not replace its evidence. Write from the messages and results available in context. Record only what they state or show; do not infer missing events or reconstruct internal reasoning.

**A turn runs from its `U` head to the row before the next block's `U` head.** A sub-agent's returned result, a tool result, a skill payload — none of these opens a turn; the block's last `A` row is the last thing this turn said, and the note covers everything up to it.

## What to write in each note

The note covers what the **assistant** did in that turn, at the length the turn earns: a one-line span yields a one-clause note. Never restate the user's message: the `U` row already carries it and the user's decision, so open on the assistant's first act.

Per turn the next session decides: pull this turn in full, or move on. The note carries the bearing; the turn carries the evidence.

Register: a commit message body — terse, fragments correct. The note is itself the searched text, so compression drops function words and keeps the subject: copy commands, identifiers, numbers, versions and error strings EXACTLY, because they are both the record and the words a later query is made of. A number is copied from a row of the turn, never recounted; a tally you cannot point at, leave out. "fix notes.md append seam — heading glued onto unterminated body line", not "I went ahead and fixed the seam".

**Write what no retrieval holds.** Retrieval is by name or by pulling this turn, and the note treats each differently.

A **named artifact** the turn left behind — a commit, a plan, a backlog row, an ADR, a step the skill prescribes — is reachable by its name from anywhere, so what it carries the note leaves to it: an identifier the commit message names is the commit's, and the note writes the sha. Write choices, rejected alternatives and reasons that the available conversation explicitly states and the artifact does not hold.
  "adopt W_amber=0.4; reject 0.6 — overshoot already absorbed by W coordinate"
  "reject per-episode quota — starves small classes; switch to global joint selection"

**What only this turn's rows hold** — a review's return, a probe script and what it measured, a fact established or ruled out by reading, an error string, a user correction — reaches a later reader only if this note makes them pull the turn. Carry its bearing: what came back, what was found, what was done with it.

**Close every note on where the turn's last row left things**: committed or not, what returned before it and what was done with it, what was handed to the user.

Write each note in the dominant language of its turn.

Keep every **scope word** — negation, restriction, condition: not / never / only / except / if, 不 / 没 / 只 / 若. A dropped scope word inverts the reader's decision. This overrides brevity.
