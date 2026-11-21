// lib/inner-seal/source.js — the unsealed source of an inner-compaction session: the frontier, range, step count and pause that the semantic event facts decide over the surface's node order, the request header they name, and the slots of a range.
//
// The facts are the harness adapter's, each fact of a frozen log carrying beside it the `originals` of a pruner replacement; this module reads nothing else. The surface's node order places the range and its steps, and the log's append order (the seq) picks the frontier among the marker nodes: a stock checkpoint that keeps a tail sits before nodes of lower seq, and those older markers are ordinary source behind it. The range starts after the frontier and after the initial prefix, whichever is later. The initial prefix is the leading nodes the loop admitted ahead of the first request header of the surface's Context Epoch, the system prompt, the original task, a load's payload and reads and the harness contexts that request carried: the epoch of a new session opens at its log's start, the epoch of a cleared one at its newest epoch-opening checkpoint, so a header an earlier epoch logged, or a series header that changes no content, moves neither.

const stepKey = ({ turn, step }) => `${turn}:${step}`;

/**
 * The seq among the `header` facts of `facts` (a `seq → fact` Map) that is the greatest when `latest`, else the least above `above`, whatever order the Map was filled in; `null` when none is.
 * @param {Map<number, { header: boolean }>} facts
 * @param {{ latest: boolean, above?: number }} options
 * @returns {number|null}
 */
export function headerSeqIn(facts, { latest, above }) {
  let found = null;
  for (const [seq, fact] of facts) {
    if (!fact.header || (!latest && seq <= above)) continue;
    if (found === null || (latest ? seq > found : seq < found)) found = seq;
  }
  return found;
}

// How many leading `nodes` are the initial prefix: a system head at the start whatever its seq, which an in-history normalization can replace later; through the newest epoch-opening checkpoint, when the surface holds one, which the clear or the compaction wrote behind that head; then the nodes appended after the epoch opened and before its first request header, which the loop logs after it has admitted everything the request carries, a later task and a later context landing behind it. A node of lower seq than the opening checkpoint, a stock checkpoint's kept tail, ends the prefix there. Without such a header the epoch shows no first request, and only what precedes it counts.
function initialPrefixLength(facts, nodes) {
  let length = nodes.length > 0 && facts.get(nodes[0]).system ? 1 : 0;
  let opened = -1;
  nodes.forEach((seq, index) => {
    if (facts.get(seq).epoch && seq > opened) {
      opened = seq;
      length = Math.max(length, index + 1);
    }
  });
  const first = headerSeqIn(facts, { latest: false, above: opened });
  if (first === null) return length;
  while (length < nodes.length && nodes[length] > opened && nodes[length] < first) length += 1;
  return length;
}

/**
 * The unsealed source over the surface `nodes` (the seqs in model-visible order) and the `facts` (a `seq → fact` Map holding every node): the `frontier`, the seq of the marker node appended last to the log (a carrier, a checkpoint, or a payload that is no part of the initial prefix), `null` when none has been; the `range`, the nodes after the frontier's position and after the initial prefix; `stepN`, the steps whose completing message is a node of the range; and whether the range is `paused`, a skeleton call of the range having no payload node after it. All of it is computed from the arguments at every call.
 * @returns {{ frontier: number|null, range: number[], stepN: number, paused: boolean }}
 */
export function innerSource(facts, nodes) {
  const prefix = initialPrefixLength(facts, nodes);
  let at = -1;
  nodes.forEach((seq, index) => {
    const { marker } = facts.get(seq);
    if (marker !== null && (marker !== 'payload' || index >= prefix) && (at < 0 || seq > nodes[at])) at = index;
  });
  const range = nodes.slice(Math.max(prefix, at + 1));
  const steps = new Set(range.map(seq => facts.get(seq).step).filter(step => step !== null).map(stepKey));
  const lastCall = range.findLastIndex(seq => facts.get(seq).skeletonCall);
  const lastPayload = range.findLastIndex(seq => facts.get(seq).marker === 'payload');
  return { frontier: at < 0 ? null : nodes[at], range, stepN: steps.size, paused: lastCall > lastPayload };
}

/**
 * The slots of the `range` (a selection of `nodes`, which supply the order) over the frozen `facts`, each `{ seqs, step? }` in the events' own seqs. A counted step, one whose completing message is selected, is one slot, `step` its `{ turn, step }`, of every selected node it owns: its assistant message, its settled tool results, the developer and system messages of its step. It sits where its first selected node does and keeps its nodes in surface order. Every other node is a slot of its own without `step`, anchored to its own seq and never expanded to what it replaced; an assistant message left over is empty and makes no slot. A pruner's replacement is preceded in its slot by the `originals` it stands for; the replacements in between are not slot sources.
 * @returns {{ seqs: number[], step?: { turn: number, step: number } }[]}
 */
export function skeletonSlots(facts, nodes, range) {
  const selected = new Set(range);
  const sources = nodes.filter(seq => selected.has(seq));
  const counted = new Set(sources.map(seq => facts.get(seq).step).filter(step => step !== null).map(stepKey));
  const slots = [];
  const stepSlots = new Map();
  for (const seq of sources) {
    const { owner, assistant, originals } = facts.get(seq);
    const key = stepKey(owner);
    const seqs = [...originals, seq];
    if (!counted.has(key)) {
      if (!assistant) slots.push({ seqs });
    } else if (stepSlots.has(key)) {
      stepSlots.get(key).seqs.push(...seqs);
    } else {
      const slot = { seqs, step: { turn: owner.turn, step: owner.step } };
      stepSlots.set(key, slot);
      slots.push(slot);
    }
  }
  return slots;
}
