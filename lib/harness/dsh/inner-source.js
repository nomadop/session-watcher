// lib/harness/dsh/inner-source.js — the unsealed source of an inner-compaction session: the few facts the trigger and the auxiliary call read from one event, the frontier, range, step count and pause those facts decide over the surface's node order, the request headers the facts name, and the slots the frozen raw slice gives the summary.
//
// The surface's node order places the range and its steps, and the log's append order (the seq) picks the frontier among the marker nodes: a stock checkpoint that keeps a tail sits before nodes of lower seq, and those older markers are ordinary source behind it. The range starts after the frontier and after the initial prefix, whichever is later. The initial prefix is the leading nodes the loop admitted ahead of the first request header of the surface's Context Epoch, the system prompt, the original task, a load's payload and reads and the harness contexts that request carried: the epoch of a new session opens at its log's start, the epoch of a cleared one at its newest replacing checkpoint, so a header an earlier epoch logged, or a series header that changes no content, moves neither.
import { isLoadPayload } from './load-message.js';
import { INNER_SEAL_KIND } from './inner-seal-message.js';
import { startsEpoch } from './source-facts.js';
import { reduceDshEvent } from './transcript-observation.js';

/** The source kind of a compact checkpoint, a stock compaction's or a `/sw-continue` clear's, which opens a new range as an inner-seal carrier does. */
export const CHECKPOINT_KIND = 'compact-checkpoint';

/** The name of the tool whose unanswered call pauses sealing: the one the handoff opens with. */
export const TURN_SKELETON_TOOL = 'get_turn_skeleton';

const stepKey = ({ turn, step }) => `${turn}:${step}`;

/**
 * The facts of one event the trigger and the call record's header read: its `type`; the `kind` of its message's source, `null` when it has none; whether it is a load `payload` message (`isLoadPayload`: the load kind whose first call is the delivery, so the read message that follows it is not one); whether it opens a Context Epoch (`epoch`: the checkpoint replacement the measurement source reads as an epoch boundary, `startsEpoch`); the `step` `{ turn, step }` it completes when it is a non-empty `assistant/message`, else `null`; and whether it holds a `get_turn_skeleton` tool call, as a `skeletonCall`.
 * @returns {{ type: string, kind: string|null, payload: boolean, epoch: boolean, step: { turn: number, step: number }|null, skeletonCall: boolean }}
 */
export function sourceFactOf(event) {
  const message = event.data?.message ?? event.data;
  // A message without a content array yields no blocks.
  const blocks = event.type === 'assistant/message' && Array.isArray(message?.content) ? message.content : [];
  return {
    type: event.type,
    kind: message?.source?.kind ?? null,
    payload: isLoadPayload(message?.source),
    epoch: message?.source?.kind === CHECKPOINT_KIND && startsEpoch(reduceDshEvent(event)),
    step: blocks.length > 0 ? { turn: event.data.turn, step: event.data.step } : null,
    skeletonCall: blocks.some(block => block?.type === 'tool-call' && block.name === TURN_SKELETON_TOOL),
  };
}

// The seq among the `request/header` facts of `facts` that is the greatest when `latest`, else the least above `above`, whatever order the Map was filled in; `null` when none is.
function headerSeq(facts, latest, above = -1) {
  let found = null;
  for (const [seq, fact] of facts) {
    if (fact.type === 'request/header' && seq > above && (found === null || (latest ? seq > found : seq < found))) found = seq;
  }
  return found;
}

// How many leading `nodes` are the initial prefix: a system prompt at the head whatever its seq, which an in-history normalization can replace later; through the newest checkpoint that opens a Context Epoch, when the surface holds one, which the clear or the compaction wrote behind that head; then the nodes appended after the epoch opened and before its first request header, which the loop logs after it has admitted everything the request carries, a later task and a later context landing behind it. A node of lower seq than the opening checkpoint, a stock checkpoint's kept tail, ends the prefix there. Without such a header the epoch shows no first request, and only what precedes it counts.
function initialPrefixLength(facts, nodes) {
  let length = nodes.length > 0 && facts.get(nodes[0]).type === 'system/message' ? 1 : 0;
  let opened = -1;
  nodes.forEach((seq, index) => {
    if (facts.get(seq).epoch && seq > opened) {
      opened = seq;
      length = Math.max(length, index + 1);
    }
  });
  const first = headerSeq(facts, false, opened);
  if (first === null) return length;
  while (length < nodes.length && nodes[length] > opened && nodes[length] < first) length += 1;
  return length;
}

/**
 * The unsealed source over the surface `nodes` (the seqs in model-visible order) and the `facts` (a `seq → sourceFactOf` Map holding every node): the `frontier`, the seq of the marker node appended last to the log (an inner-seal carrier, a checkpoint, or a load payload that is no part of the initial prefix), `null` when none has been; the `range`, the nodes after the frontier's position and after the initial prefix; `stepN`, the steps whose non-empty assistant message is a node of the range; and whether the range is `paused`, a skeleton call of the range having no payload node after it. All of it is computed from the arguments at every call.
 * @returns {{ frontier: number|null, range: number[], stepN: number, paused: boolean }}
 */
export function innerSource(facts, nodes) {
  const prefix = initialPrefixLength(facts, nodes);
  let at = -1;
  nodes.forEach((seq, index) => {
    const { kind, payload } = facts.get(seq);
    const marker = kind === INNER_SEAL_KIND || kind === CHECKPOINT_KIND || (payload && index >= prefix);
    if (marker && (at < 0 || seq > nodes[at])) at = index;
  });
  const range = nodes.slice(Math.max(prefix, at + 1));
  const steps = new Set(range.map(seq => facts.get(seq).step).filter(step => step !== null).map(stepKey));
  const lastCall = range.findLastIndex(seq => facts.get(seq).skeletonCall);
  const lastPayload = range.findLastIndex(seq => facts.get(seq).payload);
  return { frontier: at < 0 ? null : nodes[at], range, stepN: steps.size, paused: lastCall > lastPayload };
}

/**
 * The seq of the request header the next request sends: the greatest seq among the `facts` (a `seq → sourceFactOf` Map) whose `type` is `request/header`, whatever order the Map was filled in; `null` when none is.
 * @returns {number|null}
 */
export function headerSeqOf(facts) {
  return headerSeq(facts, true);
}

// A tool result that replaces the result it cites: the pruner's replacement. A fork's closing result also cites an event (the call's execution record), but appends.
const isPrunedResult = event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace';

// The results a pruner's replacement stands for: what it cites, each cited replacement followed to what it cites in turn (the pruner prunes every over-budget result of the surface, a replacement included once its budget is tightened).
const originalsOf = (event, bySeq) => event.sourceEventSeqs.flatMap(seq => {
  const cited = bySeq.get(seq);
  return isPrunedResult(cited) ? originalsOf(cited, bySeq) : [seq];
});

/**
 * The original results that the pruner replacements among `seqs` stand for, over the frozen raw `events`, each replacement followed through the replacements it replaced; a seq that is no pruner replacement adds nothing.
 * @returns {number[]}
 */
export function prunedOriginals(events, seqs) {
  const bySeq = new Map(events.map(event => [event.seq, event]));
  return seqs.flatMap(seq => (isPrunedResult(bySeq.get(seq)) ? originalsOf(bySeq.get(seq), bySeq) : []));
}

/**
 * The slots of the `range` (a selection of `nodes`, which supply the order) over the frozen raw `events`, each `{ seqs, step? }` in the events' own seqs. A counted step, one whose non-empty assistant message is selected, is one slot, `step` its `{ turn, step }`, of every selected node whose event carries that turn and step: its assistant message, its settled tool results, the developer and system messages of its step. It sits where its first selected node does and keeps its nodes in surface order. Every other node is a slot of its own without `step`, anchored to its own seq and never expanded to what it replaced; an assistant message left over is empty and makes no slot. A pruner's replacement is preceded in its slot by the original result it stands for, found through the replacements it replaced; the replacements in between are not slot sources.
 * @returns {{ seqs: number[], step?: { turn: number, step: number } }[]}
 */
export function skeletonSlots(events, nodes, range) {
  const bySeq = new Map(events.map(event => [event.seq, event]));
  const selected = new Set(range);
  const sources = nodes.filter(seq => selected.has(seq)).map(seq => bySeq.get(seq));
  const counted = new Set(sources.map(event => sourceFactOf(event).step).filter(step => step !== null).map(stepKey));
  const slots = [];
  const stepSlots = new Map();
  for (const event of sources) {
    const key = stepKey(event.data);
    const seqs = [...(isPrunedResult(event) ? originalsOf(event, bySeq) : []), event.seq];
    if (!counted.has(key)) {
      if (event.type !== 'assistant/message') slots.push({ seqs });
    } else if (stepSlots.has(key)) {
      stepSlots.get(key).seqs.push(...seqs);
    } else {
      const slot = { seqs, step: { turn: event.data.turn, step: event.data.step } };
      stepSlots.set(key, slot);
      slots.push(slot);
    }
  }
  return slots;
}
