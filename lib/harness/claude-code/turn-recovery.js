// lib/harness/claude-code/turn-recovery.js — the Claude Code recovery sentence for a search hit.
//
// It names the Source's own wire field and the row numbering a reader will use, so it belongs to the
// Harness that decides what a locator and an ordinal denote: shared Turn History prints the Source label
// it was handed and describes neither. The consumer is an LLM reading text, which is why the payload is a
// sentence rather than a code or a boolean. Each sentence states what to do next and the mechanism that
// makes it the right move.

export const SEARCH_HIT_RECOVERY =
  'line is the transcript row an excerpt sits on and span the rows around it, from its fold\'s anchor '
  + 'to its results, both as grep -n numbers them; read transcript_path there for the full text. An '
  + 'entry\'s scope names its turn: pass it as scope to search that turn alone, or as turn_page\'s '
  + 'before to read the history leading up to it.';
