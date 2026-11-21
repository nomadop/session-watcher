// lib/measurement/source-fold.js — the measurement source fold.
// Takes a harness adapter's per-event inputs one by one and keeps each event's batch, so a carrier can rewrite the batches
// of the source it seals into what the measurement still takes of them. Which usage a seal leaves standing is the
// source facts' to say (`source-facts.js`), the same facts the inner monitor reads. Each main call also leads its batch
// with a `main-call` fact the seal keeps whole, so the measurement counts the calls a seal replaced and the calls that
// reported no usage as the calls they were. The fold reads Observation types and the canonical usage alone; reducing
// an event into its input is the adapter's, and the Dialogue side reads the adapter's reducer directly and never sees a
// seal or a fact.
import { foldSourceFacts, initialSourceFacts, qualifiedCalls } from './source-facts.js';

// What a sealed event still gives the measurement: the main call it was, its tool calls and their results as
// effects alone, in the order they were made; its turn boundary and its text belong to the context the seal replaced,
// and so does its usage unless the source facts still select it as a stage point.
function sealedBatch(batch, selected) {
  return batch.flatMap((observation) => {
    if (observation.type === 'tool-result') return [observation.effectsOnly ? observation : { ...observation, effectsOnly: true }];
    if (observation.type === 'usage') return selected ? [observation] : [];
    return ['main-call', 'tool-use', 'epoch-boundary'].includes(observation.type) ? [observation] : [];
  });
}

const changed = (before, after) => before.length !== after.length || before.some((observation, index) => observation !== after[index]);

/**
 * A fold over one session's events in log order, each given as the adapter's input `{ seq, observations, diagnostics,
 * sealed?, mainCall }`: the event's Observations and diagnostics, the seqs a carrier seals, and whether the event is a
 * main call.
 *
 * - `push(input)` answers `{ batch, rewound, diagnostics }`: `batch` the input's Observations, null when it yields
 *   none; `diagnostics` the input's. A main call (`input.mainCall`) leads its batch with
 *   `{ type: 'main-call', sourceOrdinal: input.seq }`, whatever its usage holds, so a call whose usage is missing or
 *   malformed still yields that batch; an input that is no main call and yields no Observation gives none. A carrier
 *   rewrites each kept batch from the last epoch boundary on whose event seq it seals: the main-call fact and tool
 *   uses stay, tool results are marked `effectsOnly`, every other Observation but the boundary goes, the usage of a
 *   stage point excepted: the epoch's head and the first main call behind each carrier stand through every seal, and
 *   the unsealed calls stand until a carrier lists them. `rewound` is true only when a batch changed.
 * - `batches()` the kept batches in log order, a batch left empty by a seal left out.
 * - `qualifiedCalls()` how many of the open epoch's kept usages stand ahead of the first one a carrier has not listed yet (`qualifiedCalls` of the source facts), at the cut of the last input pushed.
 *
 * @returns {{ push: (input: { seq: number, observations: object[], diagnostics: object[], sealed?: number[], mainCall: boolean }) =>
 *   { batch: object[]|null, rewound: boolean, diagnostics: object[] },
 *   batches: () => object[][], qualifiedCalls: () => number }}
 */
export function createSourceFold() {
  const kept = [];
  // A seal rewrites the open epoch only: what an earlier epoch measured stays as its segment closed.
  let epochStart = 0;
  let facts = initialSourceFacts();

  function push(input) {
    const { observations, diagnostics, sealed = [] } = input;
    facts = foldSourceFacts(facts, input);
    let rewound = false;
    if (sealed.length > 0) {
      const listed = new Set(sealed);
      const selected = new Set(facts.points.map(point => point.seq));
      for (let index = epochStart; index < kept.length; index += 1) {
        if (!listed.has(kept[index].seq)) continue;
        const next = sealedBatch(kept[index].batch, selected.has(kept[index].seq));
        if (!changed(kept[index].batch, next)) continue;
        kept[index].batch = next;
        rewound = true;
      }
    }
    const batch = input.mainCall ? [{ type: 'main-call', sourceOrdinal: input.seq }, ...observations] : observations;
    if (batch.length === 0) return { batch: null, rewound, diagnostics };
    if (batch.some(observation => observation.type === 'epoch-boundary')) epochStart = kept.length;
    kept.push({ seq: input.seq, batch });
    return { batch, rewound, diagnostics };
  }

  function batches() {
    return kept.map(entry => entry.batch).filter(batch => batch.length > 0);
  }

  return { push, batches, qualifiedCalls: () => qualifiedCalls(facts) };
}
