// lib/harness/dsh/history-turn-rules.js — the DSH History Turn rules and the Dialogue Adapter that binds
// them.
//
// Each rule answers with a classification and a text; the shared Turn Head constructor copies every source
// fact from the line the rule won on, so no coordinate is chosen here.

import { ABSORB, PASS, groupTurns } from '../../turn.js';
import { projectDialogue } from '../../dialogue-fold.js';
import { askAnswersOf } from './ask-result.js';

// ─── The human rule ──────────────────────────────────────────────────────────

/**
 * The DSH rule for a visible human line: `HEAD` with its trimmed text, `ABSORB` when that is empty, `PASS` on
 * every other line. The reducer gives a turn boundary and a text to a `kind: 'user'` message alone
 * (test/dsh.transcript-observation.test.js `any other user/message kind yields nothing`), so the rule reads
 * no `source.kind`; DSH echoes no session-ending command, so it answers no `ACK`.
 *
 * @returns {function} a HistoryTurnHeadRule
 */
export function createDshHumanHeadRule() {
  return (line) => {
    if (line.kind !== 'visible' || line.message.role !== 'human') return PASS;
    const text = line.message.text.trim();
    return text === '' ? ABSORB : { kind: 'HEAD', text };
  };
}

// ─── The Ask rule ────────────────────────────────────────────────────────────

/** The tool whose answered calls head a History Turn. */
export const ASK_TOOL_NAME = 'ask_user_question';

/**
 * The DSH rule for an answered question. An `ask_user_question` tool line `HEAD`s with its answer text
 * trimmed: each answer's `selected` entries and its non-empty `custom`, in answer order, one per line, as
 * `askAnswersOf` reads the result. An error result, a result that reads as no answer (a malformed answer
 * voids the whole result) and a blank answer text `ABSORB`: the question ratified nothing, so it is
 * `CONTEXT.md` Absorbed Harness Evidence. Every other line `PASS`es.
 *
 * It runs after pairing, so the line it judges carries the answering result; the Turn Head takes its
 * address from the line, whose source coordinates are those of the `assistant/message` that asked.
 *
 * @returns {function} a HistoryTurnHeadRule
 */
export function createDshAskHeadRule() {
  return (line) => {
    if (line.kind !== 'tool' || line.tool.name !== ASK_TOOL_NAME) return PASS;
    if (line.tool.isError === true) return ABSORB;
    const text = askAnswersOf(line.tool.result)
      .flatMap(({ selected, custom }) => (custom ? [...selected, custom] : selected))
      .join('\n').trim();
    return text === '' ? ABSORB : { kind: 'HEAD', text };
  };
}

// ─── The bound Dialogue Adapter ──────────────────────────────────────────────

/**
 * The one DSH Dialogue Adapter, its rule order fixed here: the human rule, then the Ask rule.
 *
 * It attaches no resource key: every pair leaves `project` with empty `resourceKeys`, which Turn History fills at
 * capture through the injected `resourceKeysOf`.
 *
 * @returns {{ project: function, groupTurns: function }}
 */
export function createDshDialogueProjection() {
  const rules = [
    createDshHumanHeadRule(),
    createDshAskHeadRule(),
  ];
  return {
    project(observations) {
      return projectDialogue(observations);
    },
    groupTurns(lines) {
      return groupTurns(lines, rules);
    },
  };
}
