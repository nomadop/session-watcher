// lib/harness/dsh/history-turn-rules.js — the DSH History Turn rules and the Dialogue Adapter that binds
// them.
//
// Each rule answers with a classification and a text; the shared Turn Head constructor copies every source
// fact from the line the rule won on, so no coordinate is chosen here.

import { isAbsolute, normalize, resolve } from 'node:path';
import { ABSORB, PASS, groupTurns } from '../../turn.js';
import { projectDialogue } from '../../dialogue-fold.js';
import { resolveDshToolTarget } from './native-tools.js';

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

const ASK_TOOL_NAME = 'ask_user_question';

// `ask_user_question` renders its value, `{ answers: [{ id, selected, custom? }] }`, as the result's JSON
// text. A result that parses to no such value holds no answer.
function answerText(result) {
  let value;
  try {
    value = JSON.parse(result);
  } catch {
    return '';
  }
  const lines = [];
  for (const answer of Array.isArray(value?.answers) ? value.answers : []) {
    if (Array.isArray(answer?.selected)) lines.push(...answer.selected);
    if (answer?.custom) lines.push(answer.custom);
  }
  return lines.join('\n');
}

/**
 * The DSH rule for an answered question. An `ask_user_question` tool line `HEAD`s with its answer text
 * trimmed: each answer's `selected` entries and its non-empty `custom`, in answer order, one per line. An error result, a
 * result that parses to no answer, and a blank answer text `ABSORB`: the question ratified nothing, so it
 * is `CONTEXT.md` Absorbed Harness Evidence. Every other line `PASS`es.
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
    const text = answerText(line.tool.result).trim();
    return text === '' ? ABSORB : { kind: 'HEAD', text };
  };
}

// ─── The bound Dialogue Adapter ──────────────────────────────────────────────

/**
 * The one DSH Dialogue Adapter, its rule order fixed here: the human rule, then the Ask rule.
 *
 * After pairing it resolves each tool pair's native target once and attaches the nullable `resourceKey`
 * shared Turn History reads.
 *
 * @param {{ sessionCwd: string|null }} deps - the session directory a relative target resolves against
 * @returns {{ project: function, groupTurns: function }}
 */
export function createDshDialogueProjection({ sessionCwd }) {
  const context = { path: { isAbsolute, resolve, normalize }, sessionCwd };
  const rules = [
    createDshHumanHeadRule(),
    createDshAskHeadRule(),
  ];
  return {
    project(observations) {
      const { folds } = projectDialogue(observations);
      for (const fold of folds) {
        for (const pair of fold.toolPairs) {
          pair.resourceKey = resolveDshToolTarget(pair, context);
        }
      }
      return { folds };
    },
    groupTurns(lines) {
      return groupTurns(lines, rules);
    },
  };
}
