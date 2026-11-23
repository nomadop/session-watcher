// dsh/src/inner-monitor-tools.js — the tool calls of one committed slot as the monitor's detail shows them: the structured calls and results of the slot's own source events, paired by the call identity the DSH reducer qualifies, and the warnings the seal's facts place on them.
// Pure over the slot's events, the log's map the slot read already holds and the facts the fold kept; nothing is read, matched again or written.
import { OLD_SHARE_ABOVE } from '../../lib/old-attribution.js';
import { isPrunedResult, originalsOf } from '../../lib/harness/dsh/event-facts.js';
import { toolCallsOf, toolResultOf } from '../../lib/harness/dsh/inner-monitor-source.js';
import { dispatchedCallIdOf } from '../../lib/harness/dsh/transcript-observation.js';

/** The kinds of slot warning that read the first request after a seal as a whole step: a state check alone, one among other calls and a state write. */
export const STATE_WARNING = Object.freeze({ check: 'state-check', mixed: 'state-mixed', write: 'state-write' });
/** The kind of slot warning a carrier's old reads raise. */
export const OLD_ATTRIBUTION_WARNING = 'old-attribution';

const STEP_LEVEL = Object.values(STATE_WARNING);
const THRESHOLD_PERCENT = Math.round(OLD_SHARE_ABOVE * 100);

// The items of `list` by `key`; a key several items share holds them all.
function groupBy(list, key) {
  const groups = new Map();
  for (const item of list) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

// A call and a result pair only when each is the one record of its identity in the slot: an id more than one record carries names no single call, and none of them is guessed at.
const soleOf = (groups, id) => (groups.get(id)?.length === 1 ? groups.get(id)[0] : null);

// Whether the replacement `event` stands for the result at `seq`, by the sources each replacement cites; a citation the log cannot follow confirms nothing.
function standsFor(event, seq, log) {
  try {
    return originalsOf(event, log).includes(seq);
  } catch {
    return false;
  }
}

// The share of its determinable lines a read returned old, whole percent rounded down; `over` marks a share strictly above the hit threshold whose whole percent is no more than it, which the page words as above it. A read with no determinable line has no share.
function shareOf({ oldLines, newLines }) {
  const total = oldLines + newLines;
  if (total === 0) return { percent: null, over: false };
  const percent = Math.floor(oldLines * 100 / total);
  return { percent, over: oldLines / total > OLD_SHARE_ABOVE && percent <= THRESHOLD_PERCENT };
}

const warn = (card, warning) => { if (!card.warnings.some(({ kind }) => kind === warning.kind)) card.warnings.push(warning); };

/**
 * The tools of a slot: `{ warnings, calls }`. `calls` holds one card per `tool-call` block of the slot's assistant messages, in the order the blocks were issued, then one card per result of the slot no call of the slot answers: `{ id, name, input, result, pruned, warnings }`.
 * `id` is the call's qualified identity, `name` and `input` (the block's raw arguments) are null on a card of a result alone, and `result` is `{ seq, error, empty }` of the original result the call is paired with, null where the slot records none. A card with no result and a card with no call are told from a failed or an empty call by those nulls alone.
 * `pruned` is `{ seq }` of the pruner's replacement the summary call saw in place of the card's original, null for none: the one replacement of the slot that the range holds and whose cited sources lead to the card's result. The replacement is no result and no call of its own, and its text is not copied: the slot's events hold it.
 * A card's `warnings` are the slot's own, each kind once: `{ kind }` of a dispatch the fold classified (`dispatches`, `{ kind, seq }` of the `tool/call` event) when that event's turn, step and call id name the card's call and its name and arguments are the block's own, and `{ kind: 'old-attribution', oldLines, newLines, percent, over }` of an old read of the carrier (`oldReads`) when it names both the card's call identity and its original result's seq. The top-level `warnings` are the slot's `kinds` the cards do not hold whole: those of the whole step, and each kind with an occurrence no card took.
 *
 * @param {{ events: object[], range: Set<number>, log: Map<number, object>, kinds: string[], dispatches: { kind: string, seq: number }[], oldReads: object[] }} slot the slot's source events in its order, the seqs the summary call saw, the log by seq, the kinds the slot warns of, and its classified dispatches and valid old reads
 */
export function slotToolsOf({ events, range, log, kinds, dispatches, oldReads }) {
  const calls = events.flatMap(toolCallsOf);
  const results = events.flatMap((event) => {
    const result = toolResultOf(event);
    return result === null ? [] : [{ ...result, seq: event.seq }];
  });
  const callsById = groupBy(calls, ({ id }) => id);
  const resultsById = groupBy(results, ({ id }) => id);
  const resultOf = (id) => {
    const result = soleOf(callsById, id) === null ? null : soleOf(resultsById, id);
    return result === null ? null : { seq: result.seq, error: result.error, empty: result.empty };
  };
  const replacements = events.filter(event => isPrunedResult(event) && range.has(event.seq));
  const prunedOf = (result) => {
    const seen = result === null ? [] : replacements.filter(event => standsFor(event, result.seq, log));
    return seen.length === 1 ? { seq: seen[0].seq } : null;
  };
  const cards = calls.map((call) => {
    const result = resultOf(call.id);
    return { id: call.id, name: call.name, input: call.arguments, result, pruned: prunedOf(result), warnings: [] };
  });
  const paired = new Set(cards.map(card => card.result?.seq));
  const lone = results.filter(({ seq }) => !paired.has(seq))
    .map(({ id, seq, error, empty }) => ({ id, name: null, input: null, result: { seq, error, empty }, pruned: prunedOf({ seq }), warnings: [] }));
  const all = [...cards, ...lone];

  const unplaced = new Set();
  const settle = (kind, card, warning) => {
    if (card === null) unplaced.add(kind);
    else warn(card, warning);
  };
  for (const { kind, seq } of dispatches) {
    const dispatched = log.get(seq);
    const id = dispatchedCallIdOf(dispatched);
    const holders = cards.filter(card => card.id === id);
    const [holder] = holders;
    const exact = holders.length === 1 && holder.name === dispatched.data.name && holder.input === dispatched.data.arguments;
    settle(kind, exact ? holder : null, { kind });
  }
  for (const hit of oldReads) {
    settle(OLD_ATTRIBUTION_WARNING, all.find(card => card.id === hit.toolUseId && card.result?.seq === hit.seq) ?? null,
      { kind: OLD_ATTRIBUTION_WARNING, oldLines: hit.oldLines, newLines: hit.newLines, ...shareOf(hit) });
  }
  const warnings = kinds.filter(kind => STEP_LEVEL.includes(kind) || unplaced.has(kind));
  return { warnings, calls: all };
}
