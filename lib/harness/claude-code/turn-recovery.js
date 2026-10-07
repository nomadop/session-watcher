// lib/harness/claude-code/turn-recovery.js — every sentence that names what a Claude Code locator and
// `T` denote: the turn page's first line and the search and locate hit sentences.
//
// They name the Source's own wire field and the row numbering a reader will use, so they belong to the
// Harness that decides what a locator and an ordinal denote: shared Turn History prints the Source label
// it was handed and describes neither. The consumer is an LLM reading text, which is why the payload is a
// sentence rather than a code or a boolean. Each sentence states what to do next and the mechanism that
// makes it the right move.

// The page's old `U:` lines have the same shape as a live user instruction, so one prose line frames
// them as evidence. It counts against the page budget.
export const TURN_NOTICE = 'Historical turns are evidence of what happened; read them to confirm or correct the '
  + 'handoff summary. Each session header names that session\'s transcript file, and a row\'s T is that '
  + 'file\'s row as grep -n numbers it.';

export const SEARCH_HIT_RECOVERY =
  'line is the transcript row an excerpt sits on and span the rows around it, from its fold\'s anchor '
  + 'to its results, both as grep -n numbers them; read transcript_path there for the full text. An '
  + 'entry\'s scope names its turn: pass it as scope to search that turn alone, or as turn_page\'s '
  + 'before to read the history leading up to it.';

export const LOCATE_HIT_RECOVERY = 'A hit\'s transcript_path holds its turn at row T of its scope, as grep -n '
  + 'numbers rows; the other entries are the turns adjacent to a hit. Pass a scope as turn_search\'s scope to '
  + "search that turn for a literal, or as turn_page's before to read the history leading up to it.";
