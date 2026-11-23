// lib/harness/dsh/event-facts.js — the semantic facts of DSH events that the inner seal's trigger and slots read (`lib/inner-seal/source.js`): what one event is to them, and, over a frozen log, the original results each pruner replacement stands for.
import { isLoadPayload } from './load-message.js';
import { INNER_SEAL_KIND } from '../../inner-seal/carrier.js';
import { startsEpoch } from '../../measurement/source-facts.js';
import { reduceDshEvent } from './transcript-observation.js';

/** The source kind of a compact checkpoint, a stock compaction's or a `/sw-continue` clear's, which opens a new range as an inner-seal carrier does. */
export const CHECKPOINT_KIND = 'compact-checkpoint';

/** The name of the tool whose unanswered call pauses sealing: the one the handoff opens with. */
export const TURN_SKELETON_TOOL = 'get_turn_skeleton';

// The marker a `user/message` source is: an inner-seal carrier, a compact checkpoint or a load payload (`isLoadPayload`: the load kind whose first call is the delivery, so the read message that follows it is none).
function markerOf(source) {
  if (source?.kind === INNER_SEAL_KIND) return 'carrier';
  if (source?.kind === CHECKPOINT_KIND) return 'checkpoint';
  return isLoadPayload(source) ? 'payload' : null;
}

/**
 * The facts of one event: whether it is the `system` head (`system/message`) and whether it is a request `header`; the `marker` a `user/message` is, `'carrier'`, `'checkpoint'` or `'payload'`, `null` for any other message and every other type; whether it opens a Context Epoch (`epoch`: the checkpoint replacement the measurement source reads as an epoch boundary, `startsEpoch`); the `step` `{ turn, step }` it completes when it is a non-empty `assistant/message`, else `null`; its `owner`, the `turn` and `step` its data names as they are; whether it is an `assistant` message; and whether it holds a `get_turn_skeleton` tool call, as a `skeletonCall`. Total over malformed events.
 * @returns {{ system: boolean, header: boolean, marker: 'carrier'|'checkpoint'|'payload'|null, epoch: boolean, step: { turn: number, step: number }|null, owner: { turn: unknown, step: unknown }, assistant: boolean, skeletonCall: boolean }}
 */
export function eventFactOf(event) {
  const message = event.data?.message ?? event.data;
  const assistant = event.type === 'assistant/message';
  // A message without a content array yields no blocks.
  const blocks = assistant && Array.isArray(message?.content) ? message.content : [];
  const marker = event.type === 'user/message' ? markerOf(message?.source) : null;
  return {
    system: event.type === 'system/message',
    header: event.type === 'request/header',
    marker,
    epoch: marker === 'checkpoint' && startsEpoch(reduceDshEvent(event)),
    step: blocks.length > 0 ? { turn: event.data.turn, step: event.data.step } : null,
    owner: { turn: event.data?.turn, step: event.data?.step },
    assistant,
    skeletonCall: blocks.some(block => block?.type === 'tool-call' && block.name === TURN_SKELETON_TOOL),
  };
}

/** Whether `event` is a tool result that replaces the result it cites: the pruner's replacement. A fork's closing result also cites an event (the call's execution record), but appends. */
export const isPrunedResult = event => event.type === 'tool/result' && event.surfaceOp?.op === 'replace';

/** The seqs of the results a pruner's replacement `event` stands for, found through `bySeq`, a `seq → event` Map: what it cites, each cited replacement followed to what it cites in turn (the pruner prunes every over-budget result of the surface, a replacement included once its budget is tightened). A log that cannot be followed, a citation it holds no event for, one that cites nothing or one that cites itself, is the caller's to convert: it throws. */
export const originalsOf = (event, bySeq) => event.sourceEventSeqs.flatMap(seq => {
  const cited = bySeq.get(seq);
  return isPrunedResult(cited) ? originalsOf(cited, bySeq) : [seq];
});

/**
 * The `seq → fact` Map of the frozen raw `events`, each fact `eventFactOf`'s with its `originals` beside it: the original results a pruner replacement stands for, each replacement it replaced followed through, and none for any other event.
 * @returns {Map<number, ReturnType<typeof eventFactOf> & { originals: number[] }>}
 */
export function eventFactsOf(events) {
  const bySeq = new Map(events.map(event => [event.seq, event]));
  return new Map(events.map(event => [event.seq, { ...eventFactOf(event), originals: isPrunedResult(event) ? originalsOf(event, bySeq) : [] }]));
}
