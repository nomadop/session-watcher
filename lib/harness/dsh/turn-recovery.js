// lib/harness/dsh/turn-recovery.js — every sentence that names what a DSH locator and `T` denote: the turn page's first line and the search and locate hit sentences.
//
// They name the Source's own wire field and the row numbering a reader will use, so they belong to the Harness that decides what a locator and an ordinal denote: shared Turn History prints the Source label it was handed and describes neither.
// Each session's `T` is that session's event `seq`, the address `EVENT_READ_TOOL` dereferences with the session id.
// Each sentence states what to do next and the mechanism that makes it the right move.

import { EVENT_READ_TOOL } from './event-read.js';

const NOTICE = 'Historical turns are the record of what happened; read them for detail the handoff '
  + 'summary leaves out. Each session header names that session\'s id, and a row\'s T is that session\'s event '
  + `seq; read it in full with ${EVENT_READ_TOOL}(session_id, T).`;

const SEARCH_HIT = 'line is the event seq a match sits in, span the events of its fold from its '
  + `anchor to its results, and transcript_path the session id; read ${EVENT_READ_TOOL} with `
  + 'transcript_path as session_id and line as seq for the full event. An entry\'s scope names its turn: '
  + 'pass it as scope to search that turn alone, or as turn_page\'s before to read the history leading up '
  + 'to it.';

const LOCATE_HIT = 'A hit\'s transcript_path is the session id that holds its turn at event T of its '
  + `scope; read ${EVENT_READ_TOOL} with transcript_path as session_id and T as seq for the full event. `
  + 'The other entries are the turns adjacent to a hit. Pass a scope as turn_search\'s scope to search that '
  + "turn for a literal, or as turn_page's before to read the history leading up to it.";

/**
 * The three DSH turn-recovery sentences. Each names `EVENT_READ_TOOL` as the way to dereference an address this harness's rows carry, and the hit sentences keep the same next step — `scope`, `before` — the Claude Code sentences give.
 *
 * @returns {{ notice: string, searchHit: string, locateHit: string }}
 */
export function createDshTurnRecovery() {
  return { notice: NOTICE, searchHit: SEARCH_HIT, locateHit: LOCATE_HIT };
}
