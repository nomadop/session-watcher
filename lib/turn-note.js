// lib/turn-note.js — Turn Note capture: the current-epoch suffix, the Turns it covers, the validations a
// capture must pass, and the Turn Record rows a submission writes.
//
// One helper answers "which Turns is this capture about", so the skeleton and the submission cannot see
// different Turn sets. Nothing here reads a Source, a file or the Store: observations, parsed note
// sections and existing Turn Records all arrive as data, so a caller can order its own reads and writes
// around the validations below.
import { enumerateDialogueLines } from './dialogue-fold.js';
import { buildSearchTerms, slotKeysOf, storedUText } from './turn.js';
import { charsToTokens } from './token-estimate.js';
import { DEFAULT_CTP, NOTE_TOKEN_LIMIT } from './constants.js';

/**
 * The Turns of the current Context Epoch, with the Turn that is asking for the skeleton excluded.
 *
 * The epoch suffix is the observations strictly after the final `epoch-boundary`, or the whole list when
 * the Source holds no boundary. The final Turn is excluded whole and unconditionally, so a tool pair
 * appended to it while the producer writes notes cannot move the fingerprint.
 *
 * @param {{ observations: object[], dialogueProjection: object }} args
 * @returns {{ turns: object[] }}
 */
export function captureCurrentEpochTurns({ observations, dialogueProjection }) {
  let boundaryAt = -1;
  for (let i = 0; i < observations.length; i++) {
    if (observations[i].type === 'epoch-boundary') boundaryAt = i;
  }
  const { folds } = dialogueProjection.project(observations.slice(boundaryAt + 1));
  const turns = dialogueProjection.groupTurns(enumerateDialogueLines(folds));
  return { turns: turns.slice(0, -1) };
}

/**
 * Can this capture be persisted at all? A Turn Record is keyed on (session, `anchor_uuid`) and ordered on
 * `source_timestamp`, so a head with no identity, no time, or an identity another head in the same capture
 * already claims makes the whole batch unstorable. The caller rejects such a capture before writing
 * anything, rather than letting the UNIQUE constraint decide halfway through.
 *
 * @param {object[]} turns - captureCurrentEpochTurns output
 * @returns {boolean}
 */
export function captureIsPersistable(turns) {
  const seen = new Set();
  for (const turn of turns) {
    if (!turn.sourceEntryId || turn.timestamp == null) return false;
    if (seen.has(turn.sourceEntryId)) return false;
    seen.add(turn.sourceEntryId);
  }
  return true;
}

/**
 * Everything wrong with one submission, as the issue list its wire carries.
 *
 * Validation is COVERAGE, not correspondence: every slot this capture asks for must carry a note, and the
 * notes file may hold anything else. A slot is covered by a section in the file OR by a Turn Record the
 * Store already holds for its Turn — which is what makes a re-submitted epoch commit once its directory has
 * been retired. The judgement is the ROW's existence and never its note's content: a note-less Turn's note
 * is a legitimate null, so reading content here would report such a slot missing forever.
 *
 * A file that is absent, unreadable or structurally wrong needs no failure class of its own: it yields no
 * section for a slot, and that is already a missing note.
 *
 * @param {{ turns: object[], sections: Map<string, string>, storedNotes: Map<string, string|null> }} args
 * @returns {{t: number, message: string}[]}
 */
export function collectNoteIssues({ turns, sections, storedNotes }) {
  const covered = new Set(turns
    .filter(turn => storedNotes.has(turn.sourceEntryId))
    .map(turn => String(turn.sourceOrdinal)));
  const issues = [];
  for (const key of slotKeysOf(turns)) {
    const note = sections.get(key);
    if (!note) {
      if (!covered.has(key)) issues.push({ t: Number(key), message: 'missing note for this NOTE slot' });
      continue;
    }
    // Over the cap the submission is rejected whole; a note is never truncated. Only a note arriving from
    // the file is measured — a stored one passed this same gate when it was first stored.
    if (Math.round(charsToTokens(note, DEFAULT_CTP)) > NOTE_TOKEN_LIMIT) {
      issues.push({ t: Number(key), message: `note exceeds ${NOTE_TOKEN_LIMIT} tokens` });
    }
  }
  return issues;
}

/**
 * The Turn Record rows one submission writes. Every captured Turn gets a row, as `CONTEXT.md` Turn Record
 * requires — a note-less Turn's NULL is supplied here rather than inferred from the absence of a key, so
 * the queue keeps its shape. The head's `sourceEntryId` and timestamp are what the Turn Note columns
 * `anchor_uuid` and `source_timestamp` hold.
 *
 * The note is the file's section where it has one, else whatever is already stored: the file is the
 * incoming edit and the Store is the base, so a slot the Store alone covers keeps its note instead of
 * being blanked by a re-submission — idempotent rather than lossy.
 *
 * @param {{ turns: object[], sections: Map<string, string>, storedNotes: Map<string, string|null>,
 *           sessionId: string }} args
 * @returns {object[]} rows for upsertTurnNotes
 */
export function buildTurnNoteRows({ turns, sections, storedNotes, sessionId }) {
  return turns.map(turn => {
    const { uText, uOriginalChars } = storedUText(turn.cleanedU);
    const note = sections.get(String(turn.sourceOrdinal)) || storedNotes.get(turn.sourceEntryId) || null;
    return {
      sourceSessionId: sessionId,
      anchorUuid: turn.sourceEntryId,
      uText,
      uOriginalChars,
      note,
      searchTerms: buildSearchTerms({ uText, note, turn }),
      sourceTimestamp: turn.timestamp,
    };
  });
}
