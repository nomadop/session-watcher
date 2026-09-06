# Turn Notes

What each note says. Reading and filling the two files is the `protocol` that `get_turn_skeleton` returns; this file governs content only.

## Reading the skeleton

The skeleton is a sequence of turn blocks. Each block opens with a head row carrying a `T` line ordinal and a `U :` label, followed by sampled assistant rows. A block whose turn did assistant work of its own then closes with an aggregate row and a labelled `NOTE[T]: ____` slot. A block that closes without that pair asks for no note, and its rows may still include an assistant one — a bare command echo and the harness's acknowledgement of the user's own local command both reach you this way. Fill exactly the slots you are given; the notes file holds a heading for each and for nothing else.

Example block:

```
T   12 | U   : 所以你的意思是当前行为没处理 harness U 吗？
T   18 | A   : 查了两处，harness U 只在 scripts/ 两条互不一致的正则里…
T   26 | A   : …所以按 turn 采样，护栏落在 turn 的行数上而不是行长度上。
      | A×5 · 7 tools: bookmark-service.js,turn.js
      | NOTE[12]: ____
```

**The skeleton anchors your own context; it is not the evidence.** You are the agent that lived these turns, so their full text is already in your context. Work block by block: read its `T` and its head- and tail-cut rows, locate that turn in your context, and write the note from the whole turn you find there.

**Assistant text is sampled, not complete.** At most two assistant messages appear per block — the first head-cut, the last tail-cut — and the aggregate row reports how many there really were (`A×5`), the tool-call count and the basenames those calls touched. Where it reports more than the block shows, those messages are yours to recall and the note covers them.

**The aggregate row is mechanical.** Its counts and basenames come from the tool trace, not from assistant prose. Reflect them only when their outcome matters.

## What to write in each note

The note covers what the **assistant** did in that turn — the whole turn, not only its anchored rows — at the length the turn earns: a one-line span yields a one-clause note. Never restate the user's message.

Reader: a fresh agent that will never see this conversation. Per turn its only decision is: pull this turn in full, or move on. The note carries the bearing; the turn carries the evidence.

Register: a commit message body — terse, fragments correct. The note is itself the searched text, so compression drops function words and keeps the subject: copy commands, identifiers, numbers, versions and error strings EXACTLY, because they are both the record and the words a later query is made of. "fix notes.md append seam — heading glued onto unterminated body line", not "I went ahead and fixed the seam".

**Write what no retrieval holds.** A later pull returns the turn's messages and the inputs and results of its tool calls, so restating them buys nothing — and the aggregate row's paths are indexed without the note. What no pull returns is what the work added up to: what was chosen, what was turned down, and the reason.
  "adopt W_amber=0.4; reject 0.6 — overshoot already absorbed by W coordinate"
  "reject per-episode quota — starves small classes; switch to global joint selection"

Write each note in the dominant language of its turn.

Keep every not / never / no / only / except / 不 / 别 / 只. A dropped scope word inverts the reader's decision. This overrides brevity.
