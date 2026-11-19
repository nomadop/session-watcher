// lib/harness/dsh/source-fold.js — the DSH measurement source fold.
// Reduces a session's events one by one and keeps each event's batch, so an inner-seal carrier can rewrite the batches
// of the source it withdraws into what the measurement still takes of them. Which usage a withdrawal leaves standing
// is the source facts' to say (`source-facts.js`), the same facts the inner monitor reads. Each main call also leads
// its batch with a `main-call` fact the withdrawal keeps whole, so the measurement counts the calls a seal replaced
// and the calls that reported no usage as the calls they were. The Dialogue side reads the reducer directly and never
// sees a withdrawal or a fact.

import { reduceDshEvent } from './transcript-observation.js';
import { foldSourceFacts, initialSourceFacts, isMainCall, qualifiedCalls } from './source-facts.js';

// What a withdrawn event still gives the measurement: the main call it was, its tool calls and their results as
// effects alone, in the order they were made; its turn boundary and its text belong to the context the seal replaced,
// and so does its usage unless the source facts still select it as a stage point.
function withdrawn(batch, selected) {
  return batch.flatMap((observation) => {
    if (observation.type === 'tool-result') return [observation.effectsOnly ? observation : { ...observation, effectsOnly: true }];
    if (observation.type === 'usage') return selected ? [observation] : [];
    return ['main-call', 'tool-use', 'epoch-boundary'].includes(observation.type) ? [observation] : [];
  });
}

const changed = (before, after) => before.length !== after.length || before.some((observation, index) => observation !== after[index]);

/**
 * A fold over one session's events in log order.
 *
 * - `push(event)` reduces the event and answers `{ batch, rewound, diagnostics }`: `batch` its Observations, null when
 *   it yields none; `diagnostics` the reducer's. A main call (`isMainCall` of the source facts) leads its batch with
 *   `{ type: 'main-call', sourceOrdinal }`, whatever its usage holds, so a message whose usage is missing or
 *   malformed still yields that batch; an attempt, a stream chunk and a message with no seq give none. A withdrawal
 *   rewrites each kept batch from the last epoch boundary on whose event seq it lists: the main-call fact and tool
 *   uses stay, tool results are marked `effectsOnly`, every other Observation but the boundary goes, the usage of a
 *   stage point excepted: the epoch's head and the first main call behind each carrier stand through every seal, and
 *   the unsealed calls stand until a carrier lists them. `rewound` is true only when a batch changed.
 * - `batches()` the kept batches in log order, a batch left empty by a withdrawal left out.
 * - `qualifiedCalls()` how many of the open epoch's kept usages stand ahead of the first one a carrier has not listed yet (`qualifiedCalls` of the source facts), at the cut of the last event pushed.
 *
 * @returns {{ push: (event: object) => { batch: object[]|null, rewound: boolean, diagnostics: object[] },
 *   batches: () => object[][], qualifiedCalls: () => number }}
 */
export function createDshSourceFold() {
  const kept = [];
  // A withdrawal rewrites the open epoch only: what an earlier epoch measured stays as its segment closed.
  let epochStart = 0;
  let facts = initialSourceFacts();

  function push(event) {
    const reduced = reduceDshEvent(event);
    const { observations, diagnostics, withdraws = [] } = reduced;
    facts = foldSourceFacts(facts, event, reduced);
    let rewound = false;
    if (withdraws.length > 0) {
      const listed = new Set(withdraws);
      const selected = new Set(facts.points.map(point => point.seq));
      for (let index = epochStart; index < kept.length; index += 1) {
        if (!listed.has(kept[index].seq)) continue;
        const next = withdrawn(kept[index].batch, selected.has(kept[index].seq));
        if (!changed(kept[index].batch, next)) continue;
        kept[index].batch = next;
        rewound = true;
      }
    }
    const batch = isMainCall(event) ? [{ type: 'main-call', sourceOrdinal: event.seq }, ...observations] : observations;
    if (batch.length === 0) return { batch: null, rewound, diagnostics };
    if (batch.some(observation => observation.type === 'epoch-boundary')) epochStart = kept.length;
    kept.push({ seq: event.seq, batch });
    return { batch, rewound, diagnostics };
  }

  function batches() {
    return kept.map(entry => entry.batch).filter(batch => batch.length > 0);
  }

  return { push, batches, qualifiedCalls: () => qualifiedCalls(facts) };
}
