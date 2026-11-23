// dsh/src/inner-monitor-read.js — the monitor projection and the read side of attempts, handoffs and settlements.
// The kit supplies the DSH record and stream readers; the session reader supplies the log.
import { callUsageOf, foldInputOf, isMainCall } from '../../lib/harness/dsh/transcript-observation.js';
import { callSeqOf } from '../../lib/inner-seal/carrier.js';
import { attemptQuoteOf, isAttemptRecord } from '../../lib/inner-seal/attempt-record.js';
import { isCallRecord, isCarrierCache } from '../../lib/inner-seal/call-record.js';
import { isEndRecord } from '../../lib/inner-seal/end-record.js';
import { isQuote } from '../../lib/inner-seal/quote.js';
import { CARRIER_TABLE, carriesEvidence, stateOperationOf } from '../../lib/harness/dsh/carrier-table.js';
import { carriedEvidence, carriedNote, renderCarried } from '../../lib/carried-evidence.js';
import { eventFactOf } from '../../lib/harness/dsh/event-facts.js';
import { eventReadTargetOf } from '../../lib/harness/dsh/event-read.js';
import { LOAD_MESSAGE_KIND, isLoadPayload, loadCallsOf } from '../../lib/harness/dsh/load-message.js';
import { eventDisplayText, eventPreviewText, slotSourceOf, sourceEventView } from '../../lib/harness/dsh/inner-monitor-source.js';
import {
  foldSourceFacts, initialSourceFacts, isSourceFacts, startsEpoch,
} from '../../lib/measurement/source-facts.js';
import { stockOf, uncachedOf } from '../../lib/measurement/usage.js';
import { newestMemberOf, parseTurnPage } from '../../lib/turn-page.js';
import { checkpointTokenOf, loadedTokenOf } from './handoff-text.js';
import { settlementRecallOf } from './monitor-settlement-recall.js';
import { slotToolsOf, STATE_WARNING, OLD_ATTRIBUTION_WARNING } from './inner-monitor-tools.js';
import { INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE, messageOf } from './inner-seal.js';

/** The projection key the registry keeps the attempts' summaries under. */
export const MONITOR_PROJECTION_KEY = 'session-watcher/inner-monitor';
/** The longest text a summary or a slot row keeps of a prompt, a response, a reason, a thrown message or a source; the record at the seq the summary names holds the whole. */
export const PREVIEW_SOURCE_CHARS = 500;

const RECORD_TYPES = [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE];
const USAGE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];

const isUserMessage = event => event.type === 'user/message';
const isCarrier = event => eventFactOf(event).marker === 'carrier';

// The text of the first text block of a message's content, undefined where it has none.
const firstTextOf = message => (Array.isArray(message?.content) ? message.content.find(block => block?.type === 'text')?.text : undefined);

// The three messages of a handoff load, as `/sw-load` and `/sw-continue` leave them: the payload, which holds the delivery as the `load_handoff` call; the read message, a well-formed load message of other calls; and the follow-up, which opens by naming the loaded token.
const isHandoffPayload = event => isUserMessage(event) && isLoadPayload(event.data?.source);
const isHandoffReads = event => isUserMessage(event) && event.data?.source?.kind === LOAD_MESSAGE_KIND && !isLoadPayload(event.data.source) && loadCallsOf(event.data) !== null;
const isHandoffFollowUp = event => isUserMessage(event) && loadedTokenOf(firstTextOf(event.data)) !== null;
// A compact checkpoint, which `/sw-continue` leaves in front of the load that follows the clear.
const isCheckpoint = event => eventFactOf(event).marker === 'checkpoint';

/** Whether an event signals the monitor without inspecting its projected state. */
export const isMonitorInput = event => RECORD_TYPES.includes(event.type) || isCarrier(event)
  || isHandoffPayload(event) || isHandoffReads(event) || isHandoffFollowUp(event);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = value => Number.isSafeInteger(value) && value >= 0;
const isText = value => typeof value === 'string';
const isMessage = value => isObject(value) && Array.isArray(value.content);
const orNull = holds => value => value === null || holds(value);

// A read the seal committed on a slot as having returned mostly lines its epoch already held: the fact is the carrier's, whatever the counts say against any later threshold.
const isOldRead = value => isObject(value) && isText(value.toolUseId) && isSeq(value.seq) && isSeq(value.oldLines) && isSeq(value.newLines);
// The old reads of a carrier slot that read as reads; a slot's field that is no list holds none.
const oldReadsOf = slot => (Array.isArray(slot?.oldReads) ? slot.oldReads.filter(isOldRead) : []);

const isCarrierShape = event => Array.isArray(event.sourceEventSeqs) && isSeq(callSeqOf(event.sourceEventSeqs)) && Array.isArray(event.data.source.slots);

const bounded = text => (text.length > PREVIEW_SOURCE_CHARS ? text.slice(0, PREVIEW_SOURCE_CHARS) : text);

// The text of a message's text blocks end to end, bounded.
const messageTextOf = message => bounded(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));

// The whole text of a stream's assembled text blocks; null for a stream DSH's assembler does not assemble.
function responseTextOf(stream, kit) {
  try {
    return kit.assembleAssistantStream(stream).blocks().filter(block => block.type === 'text').map(block => block.text).join('');
  } catch {
    return null;
  }
}

// What a list shows of a response: the strings of a complete JSON object of strings, one to a line in its key order, the text itself for anything else, partial or not JSON included. One layer only; the values are not read again.
function displayOf(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return text;
  const values = Object.values(parsed);
  return values.every(isText) ? values.join('\n') : text;
}

// What the page reads of one call's stream: its response text bounded and as a list shows it, bounded after the strings are decoded, the kind of its finish chunk and its usage as the reducer reads it.
function streamSummaryOf(stream, kit) {
  const text = responseTextOf(stream, kit);
  return {
    output: text === null ? null : bounded(text),
    outputDisplay: text === null ? null : bounded(displayOf(text)),
    finish: kit.lastAssistantStreamChunk(stream, 'finish')?.reason?.kind ?? null,
    usage: callUsageOf(kit.lastAssistantStreamChunk(stream, 'usage')?.usage),
  };
}

// The state with `change` made to the attempt at `at`, the others as they were; with no attempt at `at`, the state itself.
const amended = (state, at, change) => (at < 0 ? state : { ...state, attempts: state.attempts.map((each, index) => (index === at ? { ...each, ...change } : each)) });

const contextOfUsage = usage => (usage === null ? null : stockOf(usage) + usage.output);
const beforeOf = ({ lastMainUsage }) => contextOfUsage(lastMainUsage);

const isSettlementNoise = ({ data }) => data?.interrupted === true && data.usage === undefined;

// The state with `change` made to the newest handoff, the others as they were.
const amendedLast = (state, change) => ({ ...state, handoffs: state.handoffs.map((each, index) => (index === state.handoffs.length - 1 ? { ...each, ...change } : each)) });

// The monitor's own display count of main calls: each non-empty main call counts once, which `eventFactOf` shows as a `step`. It is no step of `innerSource`, whose `stepN` counts the distinct `turn:step` of the nodes in a range, and the two are not the same number.
const callsAfter = (calls, event) => (eventFactOf(event).step === null ? calls : calls + 1);

// A main call is the last one before the next attempt or continue starts, which their `before` reads. Which call is the first after a carrier is the Source facts' to say (`foldSourceFacts`), not this fold's; the first one after a continue's payload is this fold's own: it fixes that handoff's `after`, with the usage the call reported or none.
function foldMainCall(state, event) {
  const { seq, data } = event;
  const usage = callUsageOf(data?.usage);
  const next = {
    ...state, lastMainUsage: usage, openCalls: callsAfter(state.openCalls, event),
    settlementBefore: isSettlementNoise(event) ? state.settlementBefore : contextOfUsage(usage),
  };
  const last = state.handoffs.at(-1);
  if (last?.type !== 'continue' || last.after !== null) return next;
  return amendedLast(next, { after: { seq, stock: usage === null ? null : stockOf(usage), miss: usage === null ? null : uncachedOf(usage) } });
}

// The post of the carrier the committed attempt holds, as the Source facts give it: the first main call after the carrier in its epoch, with the stock and the uncached tokens of the usage the measurement reads of it; null while no main call follows, `{ seq, stock: null, miss: null }` where that call has no usage the measurement reads.
function afterOf({ carriers }, attempt) {
  if (attempt.carrier === null) return null;
  const post = carriers.find(each => each.seq === attempt.carrier.seq)?.post ?? null;
  return post === null ? null : { seq: post.seq, stock: post.usage === null ? null : stockOf(post.usage), miss: post.usage === null ? null : uncachedOf(post.usage) };
}

const withAfter = (state, attempt) => ({ ...attempt, after: afterOf(state.source, attempt) });

// The record's C tail is a DSH message, which only this adapter reads: a record whose tail is none is none of the fold's.
function foldStart(state, { seq, time, data }) {
  if (!isAttemptRecord(data)) return state;
  const { tail } = data.request.messages;
  if (!isMessage(tail)) return state;
  const { first, last, count } = data.range;
  const before = beforeOf(state);
  const attempt = {
    id: seq, startedAt: time, range: { first, last, count }, input: messageTextOf(tail), call: null, end: null, carrier: null,
    before, quote: attemptQuoteOf(data), epoch: state.source.epoch,
    ...(before === null && state.settlementBefore !== null ? { estimatedBefore: state.settlementBefore } : {}),
  };
  return { ...state, attempts: [...state.attempts, attempt] };
}

function foldCall(state, { seq, data }, kit) {
  if (!isCallRecord(data)) return state;
  const call = {
    seq, endedAt: Number.isFinite(data.endedAt) ? data.endedAt : null,
    thrown: data.thrown === undefined ? null : bounded(data.thrown.message), ...streamSummaryOf(data.stream, kit),
    // The field is the call's own only in the structure the call record checks (`isCarrierCache`); a record that never held it, or holds anything else, reads as not observed.
    ...(isCarrierCache(data.carrierCache) ? { carrierCache: evidenceCopy(data.carrierCache) } : {}),
  };
  return amended(state, state.attempts.findIndex(each => each.id === data.attempt), { call });
}

function foldEnd(state, { seq, time, data }) {
  if (!isEndRecord(data)) return state;
  const end = { seq, time, outcome: data.outcome, reason: bounded(data.reason) };
  return amended(state, state.attempts.findIndex(each => each.id === data.attempt), { end });
}

// A carrier of any shape ends the calls being counted; only one of the shape the monitor reads is any attempt's.
function foldCarrier(state, event) {
  const sealed = { ...state, openCalls: 0, settlementBefore: null, postSeal: null };
  if (!isCarrierShape(event)) return sealed;
  const { slots, verbatimSeqs } = event.data.source;
  if (event.surfaceOp?.op === 'replace' && Array.isArray(verbatimSeqs)) {
    sealed.verbatimSeqs = [...state.verbatimSeqs, ...verbatimSeqs.filter(isSeq)];
  }
  const at = sealed.attempts.findIndex(each => each.call?.seq === callSeqOf(event.sourceEventSeqs));
  if (at < 0) return sealed;
  const carrier = { seq: event.seq, time: event.time, slots: slots.length };
  const slotWarnings = {};
  const slotDispatches = {};
  const pending = state.postSeal?.pending ?? {};
  for (const slot of slots) {
    const seqs = slot?.seqs;
    if (!Array.isArray(seqs) || seqs.length === 0 || !seqs.every(isSeq)) continue;
    const dispatches = seqs.flatMap(seq => pending[seq] ?? []);
    const warnings = new Set(dispatches.map(({ kind }) => kind));
    if (oldReadsOf(slot).length > 0) warnings.add(OLD_ATTRIBUTION_WARNING);
    if (warnings.size > 0) slotWarnings[seqs[0]] = [...warnings];
    if (dispatches.length > 0) slotDispatches[seqs[0]] = dispatches;
  }
  return amended({ ...sealed, postSeal: { first: true, request: null, pending: {} } }, at, {
    carrier, ...(Object.keys(slotWarnings).length > 0 && { slotWarnings }), ...(Object.keys(slotDispatches).length > 0 && { slotDispatches }),
  });
}

// A tool dispatch is log-only; its assistant message is the address the carrier's slot retains.
function foldPostSealRequest(state, event) {
  const { postSeal } = state;
  if (postSeal === null) return state;
  const { turn, step, message } = event.data ?? {};
  const count = Array.isArray(message?.content) ? message.content.filter(block => block?.type === 'tool-call').length : 0;
  const request = isMainCall(event) && isSeq(turn) && isSeq(step) && count > 0
    ? { seq: event.seq, turn, step, count, first: postSeal.first } : null;
  if (!postSeal.first && request === null && postSeal.request === null) return state;
  return { ...state, postSeal: { ...postSeal, first: false, request } };
}

function recallWarningOf(state, call) {
  const target = eventReadTargetOf(call.data);
  if (target === undefined || (target.sessionId !== undefined && target.sessionId !== state.sessionId) || target.seq >= call.seq) return;
  if (state.handoffs.some(handoff => handoff.id === target.seq)) return 'handoff-recall';
  if (state.source.carriers.some(carrier => carrier.seq === target.seq)) return 'carrier-recall';
  if (state.verbatimSeqs.includes(target.seq)) return 'verbatim-recall';
}

/** Whether the event at `seq` of the session `state` folds is in the model's context whole: a carrier or a handoff payload of the open epoch, the read message and the follow-up of such a handoff's load, or a source whose text a carrier of the open epoch holds verbatim. Unlike `recallWarningOf`, which flags a read of a carrier or payload of any epoch, it keeps to the open epoch, since a clear takes the earlier ones out of the context and reading them is then the only way back. */
export function heldInContext(state, seq) {
  const { epoch } = state.source;
  return state.verbatimSeqs.includes(seq)
    || state.source.carriers.some(carrier => carrier.seq === seq && carrier.epoch === epoch)
    || state.handoffs.some(handoff => handoff.epoch === epoch && (handoff.id === seq || handoff.readSeq === seq || handoff.followSeq === seq));
}

function stateWarningOf(request, call) {
  if (!request.first) return;
  const operation = stateOperationOf(call);
  if (operation !== undefined) return operation === 'write' ? STATE_WARNING.write : request.count === 1 ? STATE_WARNING.check : STATE_WARNING.mixed;
}

function foldToolCall(state, event) {
  const { postSeal } = state;
  const request = postSeal?.request;
  if (!request || request.turn !== event.data?.turn || request.step !== event.data?.step) return state;
  const warning = recallWarningOf(state, event) ?? stateWarningOf(request, event.data);
  if (warning === undefined) return state;
  const dispatches = postSeal.pending[request.seq] ?? [];
  return { ...state, postSeal: { ...postSeal, pending: { ...postSeal.pending, [request.seq]: [...dispatches, { kind: warning, seq: event.seq }] } } };
}

// What a payload message holds: the JSON of its `load_handoff` call, which has to name a token; null for a message that holds no such delivery.
function payloadOf(message) {
  let payload;
  try {
    payload = JSON.parse(loadCallsOf(message)?.[0]?.text);
  } catch {
    return null;
  }
  return isObject(payload) && isText(payload.load_token) ? payload : null;
}

// The position a lineage label names, `S{k}` as k and an omitted run `S{a}-S{b}` as b; none for any other label.
const LABEL_POSITION = /^S(\d+)(?:-S(\d+))?$/;
const positionOf = (entry) => {
  const match = isText(entry?.label) ? LABEL_POSITION.exec(entry.label) : null;
  return match === null ? [] : [Number(match[2] ?? match[1])].filter(isSeq);
};
// The number of the session a handoff is loaded into: one past the greatest position its lineage names; null where it names none.
function lineageNumberOf(lineage) {
  const positions = Array.isArray(lineage) ? lineage.flatMap(positionOf) : [];
  return positions.length === 0 ? null : Math.max(...positions) + 1;
}

// A load or continue is born at its payload message: the token and the counts it carries, and for a continue the context before it, which its first main call after fixes the context after. The read message and the follow-up that come later attach to the newest row alone.
function foldPayload(state, { seq, time, data }) {
  const payload = payloadOf(data);
  if (payload === null) return state;
  const type = state.lastCheckpointToken === payload.load_token ? 'continue' : 'load';
  const handoff = {
    id: seq, time, type, token: payload.load_token,
    handoffId: isSeq(payload.handoff_id) ? payload.handoff_id : null,
    createdAt: Number.isFinite(payload.created_at) ? payload.created_at : null,
    epoch: state.source.epoch,
    kept: Array.isArray(payload.paths_to_keep) ? payload.paths_to_keep.length : null,
    skills: Array.isArray(payload.skills_to_keep) ? payload.skills_to_keep.length : 0,
    lineage: lineageNumberOf(payload.lineage),
    read: null, readSeq: null, followSeq: null,
    before: type === 'continue' ? beforeOf(state) : null,
    after: null,
    tailCalls: type === 'continue' ? state.lastCheckpointCalls : null,
  };
  return { ...state, handoffs: [...state.handoffs, handoff] };
}

// The read message of the newest row, when it has seen neither a read message nor its follow-up yet.
function foldReads(state, { seq, data }) {
  const last = state.handoffs.at(-1);
  if (last === undefined || last.readSeq !== null || last.followSeq !== null) return state;
  return amendedLast(state, { read: loadCallsOf(data).filter(call => call.name === 'read').length, readSeq: seq });
}

// The follow-up of the newest row: a message after it that opens by naming its token, a later one replacing an earlier.
function foldFollowUp(state, { seq, data }) {
  const last = state.handoffs.at(-1);
  if (last === undefined || loadedTokenOf(firstTextOf(data)) !== last.token) return state;
  return amendedLast(state, { followSeq: seq });
}

// The token of the nearest checkpoint `/sw-continue` left, null for a checkpoint of any other text: the payload that follows is a continue when it names the same token. A checkpoint ends the calls being counted whatever its text, and keeps them for that payload.
function foldCheckpoint(state, { data }) {
  return { ...state, lastCheckpointToken: checkpointTokenOf(firstTextOf(data)), lastCheckpointCalls: state.openCalls, openCalls: 0 };
}

// The persisted state seeds a fold only when it is the list of attempt summaries the fold builds; any other value is refused with an error.
const isRange = value => isObject(value) && isSeq(value.first) && isSeq(value.last) && isSeq(value.count);
const isUsageState = value => isObject(value) && USAGE_FIELDS.every(field => Number.isFinite(value[field]));
const isCallState = value => isObject(value) && isSeq(value.seq) && orNull(Number.isFinite)(value.endedAt) && orNull(isText)(value.thrown)
  && orNull(isText)(value.output) && orNull(isText)(value.outputDisplay) && orNull(isText)(value.finish) && orNull(isUsageState)(value.usage)
  && (value.carrierCache === undefined || isCarrierCache(value.carrierCache));
const isEndState = value => isObject(value) && isSeq(value.seq) && Number.isFinite(value.time)
  && (value.outcome === 'failed' || value.outcome === 'cancelled') && isText(value.reason);
const isCarrierState = value => isObject(value) && isSeq(value.seq) && Number.isFinite(value.time) && isSeq(value.slots);
const isAfterState = value => isObject(value) && isSeq(value.seq) && orNull(Number.isFinite)(value.stock) && orNull(Number.isFinite)(value.miss);
const isHandoffState = value => isObject(value) && isSeq(value.id) && Number.isFinite(value.time) && (value.type === 'load' || value.type === 'continue')
  && isText(value.token) && orNull(isSeq)(value.handoffId) && orNull(Number.isFinite)(value.createdAt) && isSeq(value.epoch) && orNull(isSeq)(value.kept)
  && isSeq(value.skills) && orNull(isSeq)(value.lineage) && orNull(isSeq)(value.read) && orNull(isSeq)(value.readSeq) && orNull(isSeq)(value.followSeq)
  && orNull(Number.isFinite)(value.before) && orNull(isAfterState)(value.after) && orNull(isSeq)(value.tailCalls);
const isWarningsBySeq = value => isObject(value) && Object.entries(value).every(([seq, warnings]) => String(Number(seq)) === seq && isSeq(Number(seq))
  && Array.isArray(warnings) && warnings.length > 0 && warnings.every(isText));
const isDispatchesBySeq = value => isObject(value) && Object.entries(value).every(([seq, dispatches]) => String(Number(seq)) === seq && isSeq(Number(seq))
  && Array.isArray(dispatches) && dispatches.length > 0 && dispatches.every(dispatch => isObject(dispatch) && isText(dispatch.kind) && isSeq(dispatch.seq)));
const isAttemptState = value => isObject(value) && isSeq(value.id) && Number.isFinite(value.startedAt) && isRange(value.range)
  && isText(value.input) && orNull(isCallState)(value.call) && orNull(isEndState)(value.end) && orNull(isCarrierState)(value.carrier)
  && orNull(Number.isFinite)(value.before) && (value.estimatedBefore === undefined || Number.isFinite(value.estimatedBefore))
  && orNull(isQuote)(value.quote) && isSeq(value.epoch)
  && (value.slotWarnings === undefined || isWarningsBySeq(value.slotWarnings))
  && (value.slotDispatches === undefined || isDispatchesBySeq(value.slotDispatches));
const isPostSealRequest = orNull(value => isObject(value) && isSeq(value.seq) && isSeq(value.turn) && isSeq(value.step) && isSeq(value.count) && typeof value.first === 'boolean');
const isPostSeal = orNull(value => isObject(value) && typeof value.first === 'boolean' && isPostSealRequest(value.request) && isDispatchesBySeq(value.pending));

const stateSchema = {
  parse(value) {
    if (!isObject(value) || !Array.isArray(value.attempts) || !value.attempts.every(isAttemptState) || !orNull(isUsageState)(value.lastMainUsage) || !isSourceFacts(value.source)
      || !Array.isArray(value.handoffs) || !value.handoffs.every(isHandoffState) || !orNull(isText)(value.lastCheckpointToken)
      || !isSeq(value.lastCheckpointCalls) || !isSeq(value.openCalls) || !orNull(Number.isFinite)(value.settlementBefore)
      || !isPostSeal(value.postSeal) || !orNull(isText)(value.sessionId)
      || !Array.isArray(value.verbatimSeqs) || !value.verbatimSeqs.every(isSeq)) {
      throw new Error('invalid inner monitor state');
    }
    return value;
  },
};

/**
 * The host-only projection of the attempts of the inner seal and of the handoffs a session loaded.
 * The state keeps one summary per attempt in log order, keyed by the seq of its first record. `lastMainUsage` is the last main call's usage as `callUsageOf` reads it; `source` is the measurement source fold over the same events. `handoffs` holds one summary per load and `lastCheckpointToken` is the token of the nearest checkpoint where `checkpointTokenOf` finds one. `openCalls` counts non-empty main calls after the latest carrier or checkpoint and `lastCheckpointCalls` is the count the nearest checkpoint ended. Neither count is the `stepN` of `innerSource`; a checkpoint's retained tail already precedes it in the log.
 * `verbatimSeqs` holds the original text sources recorded by carriers committed in the open epoch. After a carrier commits, `postSeal` tracks the main requests, with a failed settlement counting as the first request too. Each classified `tool/call` dispatch waits as `{ kind, seq }`, its kind and its own event seq, by the dispatching assistant message's seq until a carrier commits a slot that contains that message; the slot then keeps its kinds as `slotWarnings` and those dispatches as `slotDispatches`, which the slot detail alone reads to place each warning on the call it names, with no classification run again. `sessionId` distinguishes local recall targets from other sessions.
 * `before` is the context of the last main call before the attempt began (its input, cache and output buckets, summed), a display apart from the measurement. A committed attempt's `after` is read from `source` and is none of this fold's choosing: null until a main call follows the carrier in its epoch, then `{ seq, stock, miss }` of the first one (its `seq` moves the row's `revision`, which `before`, a count of a call that precedes the attempt, has no need of), `stock` the sum of its input and cache buckets and `miss` its uncached input plus cache writes, each null where the measurement reads no usage of that call; neither looks past the call it names.
 * `settlementBefore` is the same context reading for the last main call after the most recent carrier or epoch boundary, skipping only interrupted calls that reported no usage. A retained call without valid usage clears it. Where `before` is missing, the attempt keeps this reading as `estimatedBefore` if available.
 * `epoch` is the count of Context Epoch boundaries the Source facts had folded when the attempt's first record arrived, so an attempt belongs to the epoch it began in, whichever epoch its later records land in.
 * `startedAt` is the event time of the attempt record, `input` the text of the C tail and `quote` the `innerQuote` snapshot the record keeps, as recorded, null where it keeps none of that shape: no later fact fills it in.
 * `call`, `end` and `carrier` stay null until their record is folded, and each holds the seq of the record that carries the whole body: `call` is `{ seq, endedAt, thrown, output, outputDisplay, finish, usage }`, `thrown` the message of an error thrown while its stream was consumed or assembled, `output` the text of the response `kit` assembles from its stream and `outputDisplay` that text as a list shows it, `finish` the kind of its finish chunk and `usage` as `callUsageOf` reads it, each null where there is none; `end` is `{ seq, time, outcome, reason }`; `carrier` keeps its seq, time and slot count.
 * A handoff summary is `{ id, time, type, token, handoffId, createdAt, epoch, kept, skills, lineage, read, readSeq, followSeq, before, after, tailCalls }`, born at a payload message (`payloadOf`: the JSON of its `load_handoff` call, which names a token; any other payload makes no row), `id` its seq and `time` its event time. `type` is `continue` when `lastCheckpointToken` equals the payload's token and `load` otherwise, the checkpoint staying in place, so a later load of the same token reads as a continue until another checkpoint comes. `handoffId`, `createdAt`, `kept`, `skills` and `lineage` are the payload's own facts (`handoffRowsOf` says which), `epoch` the count of epoch boundaries folded before the payload, and the state keeps no summary, file text, lineage or turn page: the log at the payload's seq holds them whole.
 * The read message and the follow-up that come after the payload attach to the newest row alone: the first read message, while neither it nor the follow-up has come, sets `read`, the count of its `read` calls, and `readSeq`; the latest message after the payload that opens by naming the row's token (`loadedTokenOf`) sets `followSeq`. `before` and `after` belong to a continue: `before` is the context of the last main call before the payload as `beforeOf` reads it, and `after` the first main call after it, `{ seq, stock, miss }` as an attempt's, each null where there is none, a load's always. `tailCalls` is a continue's `lastCheckpointCalls` as of its payload, null for a load.
 * Every text of an attempt the state keeps is cut to `PREVIEW_SOURCE_CHARS`; `outputDisplay` is cut after its strings are decoded, from the whole text. The tokens a handoff row and the last checkpoint keep are the store's generated load tokens, kept whole.
 * The fold is pure and writes nothing; for an event that changes nothing it answers the state it was given. That is every event that is neither a main call, a compact checkpoint nor an input, a record of any other shape, and a call or an end that names no attempt of the state; a carrier of any shape answers a new state, as it ends the calls being counted. A record the kit cannot read, as a stream holding records that are none, is left unread rather than thrown.
 *
 * @param {{ pluginRecordOf: (event: object) => ({ type: string, seq: number, time: number, data: unknown } | undefined),
 *   assembleAssistantStream: (stream: object[]) => { blocks: () => object[] },
 *   lastAssistantStreamChunk: (stream: object[], type: string) => (object|undefined) }} kit
 */
export function innerMonitorProjection(kit) {
  const fold = (state, event) => {
    if (isMainCall(event)) return foldMainCall(foldPostSealRequest(state, event), event);
    if (event.type === 'assistant/attempt') return foldPostSealRequest(state, event);
    if (isCarrier(event)) return foldCarrier(state, event);
    if (isHandoffPayload(event)) return foldPayload(state, event);
    if (isHandoffReads(event)) return foldReads(state, event);
    if (isHandoffFollowUp(event)) return foldFollowUp(state, event);
    if (isCheckpoint(event)) return foldCheckpoint(state, event);
    const record = kit.pluginRecordOf(event);
    switch (record?.type) {
      case INNER_ATTEMPT_RECORD_TYPE: return foldStart(state, record);
      case INNER_CALL_RECORD_TYPE: return foldCall(state, record, kit);
      case INNER_END_RECORD_TYPE: return foldEnd(state, record);
      default: return state;
    }
  };
  return {
    key: MONITOR_PROJECTION_KEY,
    stateVersion: 18,
    stateSchema,
    init: header => ({ attempts: [], lastMainUsage: null, settlementBefore: null, source: initialSourceFacts(), handoffs: [], lastCheckpointToken: null, lastCheckpointCalls: 0, openCalls: 0, postSeal: null, verbatimSeqs: [], sessionId: header?.id ?? null }),
    apply(state, event) {
      if (!isSeq(event.seq) || !Number.isFinite(event.time)) return state;
      try {
        if (event.type === 'tool/call') return foldToolCall(state, event);
        const source = foldSourceFacts(state.source, foldInputOf(event));
        const folded = isMonitorInput(event) || isMainCall(event) || event.type === 'assistant/attempt' || isCheckpoint(event) ? fold(state, event) : state;
        if (source === state.source) return folded;
        return source.epoch === state.source.epoch ? { ...folded, source } : { ...folded, source, settlementBefore: null, postSeal: null, verbatimSeqs: [] };
      } catch {
        return state;
      }
    },
  };
}

// A row owns its nested values: the state is the registry's, read again by every row after it.
const usageCopy = usage => (usage === null ? null : { ...usage });
const evidenceCopy = ({ results, omitted }) => ({ results: results.map(result => ({ ...result })), omitted });

// The call of a row: the recorded call, else the response of the live entry as it streams, else absent.
function callRowOf({ call, input }, entry, kit) {
  if (call !== null) {
    return {
      state: call.finish === null ? 'error' : 'received',
      endedAt: call.endedAt, finish: call.finish, thrown: call.thrown, input, output: call.output, outputDisplay: call.outputDisplay, usage: usageCopy(call.usage),
      ...(call.carrierCache === undefined ? {} : { carrierCache: evidenceCopy(call.carrierCache) }),
    };
  }
  if (entry === undefined) return { state: 'absent', endedAt: null, finish: null, thrown: null, input, output: null, outputDisplay: null, usage: null };
  const { output, outputDisplay, finish, usage } = streamSummaryOf(entry.stream(), kit);
  return {
    state: entry.phase === 'generating' ? 'generating' : finish === null ? 'error' : 'received',
    endedAt: entry.endedAt, finish, thrown: null, input, output, outputDisplay, usage,
  };
}

// The context a committed seal moved: the stock before it, the stock of the first main call after it, their difference and the tokens of that call the cache did not serve, each null where it is missing.
function contextChangeOf({ before, after }) {
  const stock = after?.stock ?? null;
  return { before, after: stock, delta: before === null || stock === null ? null : stock - before, miss: after?.miss ?? null };
}

// What the list shows of the quote an attempt triggered on: the deviation q it priced and the kappa it was compared with; null for an attempt recorded without a quote.
const triggerOf = quote => (quote === null ? null : { q: quote.q, kappa: quote.kappa });

function rowOf(attempt, entry, kit) {
  return {
    id: attempt.id,
    revision: Math.max(attempt.id, attempt.call?.seq ?? 0, attempt.end?.seq ?? 0, attempt.carrier?.seq ?? 0, attempt.after?.seq ?? 0),
    status: attempt.carrier !== null ? 'committed' : attempt.end?.outcome ?? entry?.phase ?? 'unknown',
    startedAt: attempt.startedAt,
    endedAt: (attempt.carrier ?? attempt.end)?.time ?? null,
    range: { ...attempt.range },
    reason: attempt.carrier === null ? attempt.end?.reason ?? null : null,
    slots: attempt.carrier?.slots ?? null,
    call: callRowOf(attempt, entry, kit),
    contextChange: attempt.carrier === null ? null : contextChangeOf(attempt),
    trigger: triggerOf(attempt.quote),
    stepN: attempt.quote?.n ?? null,
    cRatio: attempt.quote?.cRatio ?? null,
    epoch: attempt.epoch,
  };
}

/**
 * The rows of the attempts `state` folds, ascending by id: `{ id, revision, status, startedAt, endedAt, range, reason, slots, call, contextChange, trigger, stepN, cRatio, epoch }`.
 * `live` is the registry's entries of the session, `kit` the stream readers of `innerMonitorProjection`.
 * `status` is the first that holds of: a carrier, `committed`; an end record, its outcome, `failed` or `cancelled`; a live entry, its phase, `generating` or `validating`; else `unknown`. `revision` is the greatest seq of the facts folded for the attempt, the main call that fixed its `after` included, so a live entry's stream does not move it.
 * `endedAt` is the event time of the carrier or end record the status rests on, `reason` the text of that end record, `slots` the count of the carrier's, each null where the status has none.
 * `trigger` is null for an attempt recorded without a quote, else `{ q, kappa }`: the quote's deviation and the tolerance it was compared with. It is read from the snapshot alone and decides no status. `stepN` is the quote's `n`, the counted steps of the range the attempt summarizes, null for an attempt recorded without a quote. `cRatio` is the quote's own, the cache write-to-read price ratio it was priced under, null where it could not be read and for an attempt recorded without a quote. `epoch` is the attempt's own, the zero-based count of epoch boundaries before its first record.
 * `contextChange` is null unless the attempt committed, else `{ before, after, delta, miss }`: the context before the seal, the stock of the first main call after it, `after - before` and the tokens of that call the cache did not serve, each null where its main call is missing or reported no valid usage.
 * The list supplies `estimatedBefore` separately where a committed attempt recorded it. `slotWarnings` maps the affected committed slots' keys to their warning kinds: the post-seal ones waiting for the slot that holds the dispatching message and `old-attribution` for a slot whose carrier keeps `oldReads`, the seal's own record of file reads that returned mostly lines their epoch already held, which the fold reads without checking its counts again. The list can mark a collapsed group without reading the slots.
 * `call` is `{ state, endedAt, finish, thrown, input, output, outputDisplay, usage }`: `thrown` is the message of an error thrown while the call's stream was consumed or assembled, `input` the prompt and `output` the response text, `outputDisplay` that text as a list shows it (a complete JSON object of strings as its strings, one to a line; any other text as it is; null where `output` is), and a field with nothing to read is null, `input` apart. `state` reads the transport alone: `received` where a finish chunk was observed and `error` where none was, whatever `thrown` says. With no call recorded, a live entry's stream is read as it stands: `generating` until the stream ends, then as a recorded call is; with neither, the call is `absent`.
 * A live entry of an attempt the state does not hold makes no row.
 */
export function rowsOf(state, live, kit) {
  return state.attempts.map((attempt) => {
    const row = rowOf(withAfter(state, attempt), live.find(entry => entry.attempt === attempt.id), kit);
    if (row.status === 'committed' && attempt.estimatedBefore !== undefined) row.estimatedBefore = attempt.estimatedBefore;
    if (attempt.slotWarnings !== undefined) row.slotWarnings = Object.fromEntries(Object.entries(attempt.slotWarnings).map(([key, warnings]) => [key, [...warnings]]));
    return row;
  });
}

// The row of a handoff: its bounded facts, the context change of a continue, and the next task its store row holds, read now and cut to the preview limit; none where the payload names no handoff id or the store has no such row.
function handoffRowOf(handoff, nextTaskOf) {
  const nextTask = handoff.handoffId === null ? null : nextTaskOf(handoff.handoffId);
  return {
    id: handoff.id,
    revision: Math.max(handoff.id, handoff.readSeq ?? 0, handoff.followSeq ?? 0, handoff.after?.seq ?? 0),
    type: handoff.type,
    token: handoff.token,
    time: handoff.time,
    createdAt: handoff.createdAt,
    epoch: handoff.epoch,
    kept: handoff.kept,
    read: handoff.read,
    skills: handoff.skills,
    lineage: handoff.lineage,
    contextChange: handoff.type === 'continue' ? contextChangeOf(handoff) : null,
    tailCalls: handoff.tailCalls,
    nextTask: isText(nextTask) ? bounded(nextTask) : null,
  };
}

/**
 * The rows of the handoffs `state` folds, ascending by id: `{ id, revision, type, token, time, createdAt, epoch, kept, read, skills, lineage, contextChange, tailCalls, nextTask }`.
 * `id` is the seq of the payload message, the `load_handoff` call of the load. `revision` is the greatest seq among the payload, its read message, its follow-up and, for a continue, the main call that fixed its `after`.
 * `type` is `continue` when the nearest `/sw-continue` checkpoint before the payload names the payload's token, else `load`. `token` is the payload's `load_token`, `time` the event time of the payload and `createdAt` the payload's `created_at`, epoch milliseconds, null where it has none.
 * `epoch` is the count of Context Epoch boundaries before the payload. `kept` is the count of the payload's `paths_to_keep`, null where it has none, `read` the count of the read message's `read` calls, null where the load has no read message, and `skills` the count of its `skills_to_keep`, zero where it has none.
 * `lineage` is the number of the session the handoff is loaded into: one past the greatest position the payload's lineage labels name, an omitted run `S{a}-S{b}` by `b`; null where it names none.
 * `contextChange` is null for a load, which records no context before or after, and `{ before, after, delta, miss }` for a continue, as `rowsOf` states it for a committed seal: the context of the last main call before the payload, the stock of the first main call after it, their difference and the tokens of that call the cache did not serve, each null where its call is missing or reported no valid usage.
 * `tailCalls` is null for a load, and for a continue the calls of the cleared segment after the last inner-seal carrier or compact checkpoint before the clear, zero where none follow it; the state's `openCalls` says what counts as a call.
 * `nextTask` is the text the store holds under the payload's `handoff_id` (`nextTaskOf`), cut to `PREVIEW_SOURCE_CHARS`; null where the payload carries no id or the store has none.
 */
export function handoffRowsOf(state, nextTaskOf) {
  return state.handoffs.map(handoff => handoffRowOf(handoff, nextTaskOf));
}

// The attempt of `state` that `id` names; an address the monitor holds nothing at is the caller's to convert.
function attemptOf(state, id) {
  const attempt = state.attempts.find(each => each.id === id);
  if (attempt === undefined) throw new Error(`the inner monitor holds no attempt ${id}`);
  return withAfter(state, attempt);
}

// The events of the session's log by seq.
const logOf = ({ events }) => new Map(events.map(event => [event.seq, event]));

// The event of the log at `seq`; a log that holds none there is the caller's to convert.
function loggedEvent(log, seq) {
  const event = log.get(seq);
  if (event === undefined) throw new Error(`the session log holds no event at seq ${seq}`);
  return event;
}

// The data of the record of `type` at `seq`; a log that holds none there is the caller's to convert.
function recordOf(log, seq, type, kit) {
  const record = log.has(seq) ? kit.pluginRecordOf(log.get(seq)) : undefined;
  if (record?.type !== type) throw new Error(`the session log holds no ${type} record at seq ${seq}`);
  return record.data;
}

// The definitions of the tools a request sent, from the request header at `headerSeq`, else null with the reason there are none to show.
function definitionsOf(log, headerSeq) {
  if (!isSeq(headerSeq)) return { definitions: null, reason: 'the request names no request header' };
  const event = log.get(headerSeq);
  if (event?.type !== 'request/header') return { definitions: null, reason: `the log holds no request header at seq ${headerSeq}` };
  const tools = event.data?.header?.tools;
  return Array.isArray(tools) ? { definitions: tools } : { definitions: null, reason: `the request header at seq ${headerSeq} defines no tools` };
}

// The request of an attempt is the attempt record's display, its tool count beside the definitions of those tools that `tools()` finds.
const requestOf = (display, tools) => (display.tools === undefined ? display : { ...display, tools: { ...display.tools, ...tools() } });

// The row as a call's detail carries it: every field of the list's row but the call's display, which only the list shows.
const detailRowOf = ({ call: { outputDisplay, ...call }, ...row }) => ({ ...row, call });

// The row with the whole text of the failure its preview cut: the end record's reason, which the row has only of an attempt that did not commit, and the call record's thrown message.
const wholeRow = (row, end, call) => detailRowOf({
  ...row,
  reason: end === null ? row.reason : end.reason,
  call: { ...row.call, thrown: call?.thrown === undefined ? row.call.thrown : call.thrown.message },
});

const timeOfRecord = record => (record.type === 'chunk' ? record.time : record.time0);

// What a page shows of a stream: its compact records as they are, the blocks the assembler reads from them (null with the error's text where it refuses), its finish chunk and the time of its first record.
function responseOf(stream, kit, live) {
  let blocks = null;
  let error = null;
  try {
    blocks = kit.assembleAssistantStream(stream).blocks();
  } catch (thrown) {
    error = messageOf(thrown);
  }
  const first = stream.length === 0 ? null : timeOfRecord(stream[0]);
  return { live, blocks, error, stream, finish: kit.lastAssistantStreamChunk(stream, 'finish') ?? null, firstAt: Number.isFinite(first) ? first : null };
}

// The usage of a stream both as the reducer folds it and as its chunk streamed.
function usageOfStream(stream, kit) {
  const chunk = kit.lastAssistantStreamChunk(stream, 'usage') ?? null;
  return { folded: callUsageOf(chunk?.usage), raw: chunk };
}

const idsOf = attempt => ({
  start: attempt.id, call: attempt.call?.seq ?? null, end: attempt.end?.seq ?? null, carrier: attempt.carrier?.seq ?? null,
});

const timingOf = row => ({ attempt: { startedAt: row.startedAt, endedAt: row.endedAt }, call: { startedAt: row.startedAt, endedAt: row.call.endedAt } });

// The quote the attempt record kept, the row's own copy; null for an attempt recorded without one.
const quoteOf = ({ quote }) => (quote === null ? null : { ...quote });

// The call of an attempt in flight, wholly from its entry: one snapshot of the stream serves the row and the response, and nothing reads the log.
function liveCall(attempt, entry, kit) {
  const stream = entry.stream();
  const row = rowOf(attempt, { ...entry, stream: () => stream }, kit);
  return {
    row: detailRowOf(row),
    ids: idsOf(attempt),
    request: requestOf(entry.request, () => ({ definitions: entry.tools })),
    response: responseOf(stream, kit, true),
    usage: usageOfStream(stream, kit),
    timing: timingOf(row),
    carried: null,
    quote: quoteOf(attempt),
  };
}

// The call of an attempt with no entry, from the records the one read of the log holds at the seqs the folded facts name.
function recordedCall(attempt, log, kit) {
  const row = rowOf(attempt, undefined, kit);
  const start = recordOf(log, attempt.id, INNER_ATTEMPT_RECORD_TYPE, kit);
  const call = attempt.call === null ? null : recordOf(log, attempt.call.seq, INNER_CALL_RECORD_TYPE, kit);
  const end = row.reason === null ? null : recordOf(log, attempt.end.seq, INNER_END_RECORD_TYPE, kit);
  const ids = idsOf(attempt);
  return {
    row: wholeRow(row, end, call),
    ids,
    request: requestOf(start.request, () => definitionsOf(log, start.request.headerSeq)),
    response: call === null ? null : responseOf(call.stream, kit, false),
    usage: call === null ? null : usageOfStream(call.stream, kit),
    timing: timingOf(row),
    carried: ids.carrier === null ? null : carriedDetailOf(carrierAt(log, ids.carrier).data.source),
    quote: quoteOf(attempt),
  };
}

// B of a carrier's source: the text it renders, null where B renders none, that text's fixed opening paragraph and the evidence the source changes as structure, which holds what B does not print; null where the source changes none.
function carriedDetailOf(source) {
  const evidence = carriedEvidence(source);
  return evidence === null ? null : { text: renderCarried(source, CARRIER_TABLE), note: carriedNote(CARRIER_TABLE), ...evidence };
}

// The carrier of the log at `seq`; a log that holds none there, or an event of another shape, is the caller's to convert.
function carrierAt(log, seq) {
  const carrier = log.get(seq);
  if (carrier === undefined || !isCarrier(carrier) || !isCarrierShape(carrier)) throw new Error(`the session log holds no inner-seal carrier at seq ${seq}`);
  return carrier;
}

// What a committed attempt's slots are made of, over the log: the slots of its carrier, never of its call, the seqs of the range its call saw and the stream of that call, the summary the carrier cites.
function committedOf(attempt, log, kit) {
  const { slots } = carrierAt(log, attempt.carrier.seq).data.source;
  const call = recordOf(log, attempt.call.seq, INNER_CALL_RECORD_TYPE, kit);
  return { slots, range: new Set(call.range), summary: { seq: attempt.call.seq, stream: call.stream } };
}

// A slot's address, its first seq and seqs, the counted step among its events and the type, producer kind and category of its first event, with the events themselves.
function placeOf(slot, log) {
  const events = slot.seqs.map(seq => loggedEvent(log, seq));
  const step = events.map(event => eventFactOf(event).step).find(counted => counted !== null) ?? null;
  return { key: slot.seqs[0], seqs: slot.seqs, turn: step?.turn ?? null, step: step?.step ?? null, source: slotSourceOf(events[0]), events };
}

// The estimate a carrier slot kept of its original text: a finite non-negative number, a zero included, else none; a slot of an older carrier keeps none.
const sourceTokensOf = slot => (Number.isFinite(slot?.sourceTokens) && slot.sourceTokens >= 0 ? slot.sourceTokens : null);

// The events of a carrier slot over the log, null where the slot's seqs do not read as a list or the log lacks one of them: whether such a slot holds a main call cannot be said.
function eventsOfSlot(slot, log) {
  const events = Array.isArray(slot?.seqs) ? slot.seqs.map(seq => log.get(seq)) : null;
  return events === null || events.includes(undefined) ? null : events;
}

// The measured usage of a slot's own call and of the one after it: the next slot's main call that has any, else the summary call the carrier cites, which the committed attempt's own call record gives, last usage chunk of its stream. A slot that cannot be read before one with a main call leaves the next unconfirmed (null), never skipped or taken for the summary.
function usageOfSlot({ slots, at, events, log, summary, kit }) {
  const own = events.find(isMainCall);
  const current = own === undefined ? null : { seq: own.seq, usage: callUsageOf(own.data?.usage) };
  return { current, next: own === undefined ? null : nextCallOf(slots.slice(at + 1), log, summary, kit), sourceTokens: sourceTokensOf(slots[at]) };
}

function nextCallOf(later, log, summary, kit) {
  for (const slot of later) {
    const events = eventsOfSlot(slot, log);
    if (events === null) return null;
    const call = events.find(isMainCall);
    if (call !== undefined) return { kind: 'main', seq: call.seq, usage: callUsageOf(call.data?.usage) };
  }
  return { kind: 'summary', seq: summary.seq, usage: usageOfStream(summary.stream, kit).folded };
}

const NOT_COMMITTED = Object.freeze({ kind: 'not_committed' });
const NOT_TARGET = Object.freeze({ kind: 'not_target' });

// The handoff of `state` that `id`, a payload's seq, names; an address the monitor holds nothing at is the caller's to convert.
function handoffOf(state, id) {
  const handoff = state.handoffs.find(each => each.id === id);
  if (handoff === undefined) throw new Error(`the inner monitor holds no handoff ${id}`);
  return handoff;
}

// The continue of `state` that `id` names: only a clear cuts a segment off, so a load is the caller's to convert, as an address the monitor holds nothing at is.
function clearingOf(state, id) {
  const handoff = handoffOf(state, id);
  if (handoff.type !== 'continue') throw new Error(`the handoff ${id} is no /sw-continue clear`);
  return handoff;
}

// An attempt as it stood at the cut: a record that landed after it is not yet there, so a seal that commits later is an attempt in flight, as the list had it before.
const atCut = (attempt, cut) => ({
  ...attempt,
  call: attempt.call !== null && attempt.call.seq <= cut ? attempt.call : null,
  end: attempt.end !== null && attempt.end.seq <= cut ? attempt.end : null,
  carrier: attempt.carrier !== null && attempt.carrier.seq <= cut ? attempt.carrier : null,
});

// The pricing inputs of a segment's attempts at the cut (`id, status, epoch, contextChange, estimatedBefore, call.usage, stepN, cRatio`), every attempt that had begun, so that its place among them is the list's.
const pricingOf = (state, segment, kit, cut) => rowsOf({
  ...state, attempts: state.attempts.filter(attempt => attempt.epoch === segment && attempt.id <= cut).map(attempt => atCut(attempt, cut)),
}, [], kit).map(({ id, status, epoch, contextChange, estimatedBefore, call, stepN, cRatio }) => ({ id, status, epoch, contextChange, estimatedBefore, call: { usage: call.usage }, stepN, cRatio }));

// The segment's events up to the cut `through`, a seq the log may run past.
function segmentEventsOf(log, segment, through) {
  const events = [];
  let epoch = 0;
  for (const event of log.values()) {
    if (startsEpoch(foldInputOf(event))) epoch += 1;
    if (epoch > segment || event.seq > through) break;
    if (epoch === segment) events.push(event);
  }
  return events;
}

// A segment at a cut: the calls of its main-call steps, the pricing inputs and tail its settlement needs, the report-only recall evidence and the recall activity, all of the one fold of the log up to `through`, so that a read at the segment's last event and the same segment read after its clear answer alike. Move a mark off an excluded call without moving the Source's post: a later carrier or epoch boundary ends the chart's search for a landing.
function settlementEvidenceOf(state, log, sessionId, segment, kit, { tailCalls, through = Number.POSITIVE_INFINITY } = {}) {
  const events = segmentEventsOf(log, segment, through);
  const cut = events.at(-1)?.seq ?? -1;
  const attempts = state.attempts.filter(attempt => attempt.epoch === segment && attempt.carrier !== null && attempt.carrier.seq <= cut);
  // A call after the cut is none of its seal's.
  const postByAttempt = new Map(attempts.map((attempt) => {
    const seq = afterOf(state.source, attempt)?.seq;
    return [attempt.id, seq <= cut ? seq : undefined];
  }));
  const posts = new Set(postByAttempt.values());
  const calls = [];
  let pendingPost = false;
  let countedTail = 0;
  const lastCarrier = attempts.at(-1)?.carrier.seq ?? -1;
  for (const event of events) {
    if (isCarrier(event)) pendingPost = false;
    if (!isMainCall(event)) continue;
    if (event.seq > lastCarrier) countedTail = callsAfter(countedTail, event);
    pendingPost ||= posts.has(event.seq);
    if (isSettlementNoise(event)) continue;
    const usage = callUsageOf(event.data?.usage);
    calls.push({ seq: event.seq, stock: usage === null ? null : stockOf(usage), post: pendingPost });
    pendingPost = false;
  }
  const tail = tailCalls ?? countedTail;
  const { recall, activity } = settlementRecallOf({ events, log, attempts, postByAttempt, tailCalls: tail, sessionId, isNoise: isSettlementNoise });
  return {
    epoch: segment + 1, attempts: pricingOf(state, segment, kit, cut), tailCalls: tail, calls, cut: { segment, through: cut },
    ...(recall === undefined ? {} : { recall }), ...(activity === undefined ? {} : { activity }),
  };
}

// The text of an original event, the text blocks of its message end to end, null where it holds none; the whole text, bounded by nothing but the log.
function plainTextOf(event) {
  const content = (event.data?.message ?? event.data)?.content;
  const text = Array.isArray(content) ? content.filter(block => block?.type === 'text' && isText(block.text)).map(block => block.text).join('') : '';
  return text === '' ? null : text;
}

// The files a read message shows. One whose source carries `paths` lists the files the evidence changes, each by its display path with the line count and the lines its entry records; one with none, an older log's, lists the file each `read` call's logical arguments name, with no line count and no lines. Arguments that do not parse or name no file are the caller's to convert.
function filesOf(message) {
  if (carriesEvidence(message.source)) return (carriedEvidence(message.source)?.files ?? []).map(({ path, total, state, runs }) => ({ path, total: state === 'empty' ? 0 : total, runs }));
  return loadCallsOf(message).filter(call => call.name === 'read').map((call) => {
    const { file_path: path } = JSON.parse(call.arguments);
    if (typeof path !== 'string') throw new Error(`the read call ${call.id} of the load read message names no file`);
    return { path, total: null, runs: [] };
  });
}

// The whole text of the follow-up at `seq`; an event of another shape is the caller's to convert.
function followUpAt(log, seq) {
  const text = firstTextOf(loggedEvent(log, seq).data);
  if (!isText(text)) throw new Error(`the session log holds no follow-up text at seq ${seq}`);
  return text;
}

// A handoff's detail from the log at the seqs its folded facts name: the payload, the read message and the follow-up, whole.
function handoffDetailOf(handoff, row, log) {
  const payload = payloadOf(loggedEvent(log, handoff.id).data);
  if (payload === null) throw new Error(`the session log holds no load payload at seq ${handoff.id}`);
  let files = [];
  if (handoff.readSeq !== null) {
    const reads = loggedEvent(log, handoff.readSeq).data;
    if (loadCallsOf(reads) === null) throw new Error(`the session log holds no load read message at seq ${handoff.readSeq}`);
    files = filesOf(reads);
  }
  const turnPage = isText(payload.turn_page) ? payload.turn_page : null;
  return {
    row,
    summary: payload.summary,
    files,
    lineage: Array.isArray(payload.lineage) ? payload.lineage : null,
    turnPage,
    turns: parseTurnPage(newestMemberOf(turnPage)),
    followUp: handoff.followSeq === null ? null : followUpAt(log, handoff.followSeq),
  };
}

/**
 * The attempts and handoffs as the RPC channel reads them by session id.
 * `rows(sessionId)` answers `{ attempts, handoffs }`, the `rowsOf` rows over the projection's state of the session and the registry's live entries of it, and the `handoffRowsOf` rows over the same state, each ascending by id, the two lists apart.
 * `handoff(sessionId, id)` answers the detail of the handoff whose payload message is at seq `id`, `{ row, summary, files, lineage, turnPage, turns, followUp }`, read from the log at the seqs the folded facts name: `row` is the row of `handoffRowsOf`; `summary` the payload's whole summary; `files` one `{ path, total, runs }` per file the read message's `paths` change, in the order of `carriedEvidence`, the path its display path, the file's line count, zero for an empty file and else the count its entry records with the lines it writes, and those lines as `runs`, each `{ offset, lines: [{ number, text }] }` a stretch of consecutive lines; a read message with no `paths` lists one file per `read` call, in call order, the path its logical arguments name, with a null line count and no runs; an empty list where the load has no read message; `lineage` the payload's lineage as sent, null where it has none; `turnPage` the payload's `turn_page` text whole, null where it has none; `turns` the records of the newest lineage member of that text (`newestMemberOf`) read by `parseTurnPage`, `[{ address, user, note }]` in page order, the older members' records left out and none added in their place; `followUp` the whole text of the follow-up, null where the load has none.
 * `settlement(sessionId, id)` and `currentSettlement(sessionId)` answer one segment at one cut as `{ epoch, attempts, tailCalls, calls, cut, recall?, activity? }`: the continue whose payload message is at seq `id` cleared the segment `handoff.epoch − 1`, read up to its last event; the current one is the latest epoch of one stored snapshot (`readStored`, held or not), up to the snapshot's last event. `epoch` is the segment's display number, `attempts` the pricing inputs of its attempts that had begun by the cut (`id, status, epoch, contextChange, estimatedBefore, call.usage, stepN, cRatio`), a record that landed after it not yet there, so that a seal that commits later is an attempt in flight, `tailCalls` the main calls after its last carrier (a continue's own count for a clear, counted from the log for the current one), and `calls` the segment's main calls in log order, `{ seq, stock, post }`, excluding interrupted calls that reported no usage. `stock` is the input and cache stock of the call's usage as read by `callUsageOf`, or null where it reads none. `post` marks the Source's first call behind the carrier of a committed attempt of that segment (`afterOf`). If that call was excluded, the mark moves to the next retained call, if any, before the next carrier or epoch boundary; neither the movement nor the absence of a mark changes the attempt's readings. A chart can align these marks with the rows in order only when each carrier has a mark of its own. `cut` is `{ segment, through }`, the segment's index and the seq of the last event the answer read, which `settlementTarget` takes back.
 * `recall` is the report-only evidence of `settlementRecallOf` from that segment's log. `activity` is its recall activity, absent where the segment holds no committed seal: the judged and pure settlement steps after the first seal, whether those counts are proved to cover the axis, and the original events the pure steps read back, each with its landing on the axis and its reads; no text. A client that finds none is reading an answer of a host that does not send it.
 * `settlementTarget(sessionId, { segment, through, seq })` answers `{ seq, type, text }` of the original event at `seq` where the segment `segment` read up to `through` confirms it as a recall target, `text` the text blocks of the event end to end and null where it holds none, and the closed `{ kind: 'not_target' }` where it confirms none. It reads one stored snapshot and folds the same evidence at that cut, so the log running on adds nothing; it keeps nothing.
 * `call(sessionId, attempt)` answers `{ row, ids, request, response, usage, timing, carried, quote }` of the attempt whose id is `attempt`, `slots(sessionId, attempt)` answers `{ slots: [{ key, turn, step, source, input, inputDisplay, output }] }` and `slot(sessionId, attempt, key)` answers `{ key, number, seqs, turn, step, source, c, events: [{ seq, type, visible, blocks, raw }], tools, usage }` of the slot that starts at the seq `key`.
 * The other reads use the held instance's projection, live entries and log when available. Otherwise they use `readStored` without live entries, so an attempt with no terminal record reads `unknown`. All reads answer `undefined` for a session that is neither held nor stored, independently of the measurement. A failed read is the caller's to convert: an attempt the monitor holds none of, a record, carrier or event the log lacks at a seq a fact names, a carrier of another shape, a slot no carrier slot starts at, a handoff the monitor holds none of and a load asked for its settlement, a payload, read message or follow-up the log lacks or holds in another shape at a seq a fact names, a read call of a read message with no `paths` whose arguments do not parse or name no file, and a rejected `readSession` all reject. A request header the log lacks is no failure, as `call` says.
 * `call` of an attempt with a live entry reads that entry alone: its request display with the tools it sent, its stream as it stands and the times of the folded facts, with no read of the log and no clock. Otherwise it reads the log once, for the attempt record, the call record, where its row shows a reason the end record and where the attempt committed its carrier, each at the seq the folded facts name; `response` and `usage` are null while no call is recorded.
 * `ids` are the seqs of the start, call, end and carrier facts, each but the start null where there is none. `row` omits the list's `estimatedBefore`, `slotWarnings` and the call's `outputDisplay`; its `reason` and its call's `thrown` are the whole text of the end and call records where the list cuts them.
 * `request` is the attempt record's request display with the whole C tail and, beside the count of tools it sent, `definitions`: the tools of the request header the display names, else null with a `reason`.
 * `response` is `{ live, blocks, error, stream, finish, firstAt }`: the compact stream as recorded or streamed, the blocks the assembler reads from it (null with `error` where it refuses), its finish chunk and the time of its first record. `usage` is `{ folded, raw }`: `callUsageOf` of the stream's usage chunk and the chunk. `timing` is `{ attempt, call }`, each the `{ startedAt, endedAt }` of the folded facts, the call starting when the attempt does. `carried` is B of the carrier of a committed attempt: `{ text, note, files, removed, skills }`, `text` the `renderCarried` of its source, null where B renders none, `note` the fixed paragraph that text opens with and `files`, `removed` and `skills` the evidence as `carriedEvidence` states it: what the carrier changes beyond the carriers before it, the withdrawals, removals and readable states B does not print included. It is null where the carrier changes none, for an attempt with no carrier and for one with a live entry, which reads no log. `quote` is the quote of the folded attempt, in flight or not, the estimate the seal triggered on before its summary and never the B its carrier committed; null where the attempt record kept none.
 * `slots` and `slot` answer the closed `{ kind: 'not_committed' }` for an attempt with no carrier, whatever its call holds: only a carrier is evidence that a seal committed. A slot is the carrier's: `key` its first seq, `turn` and `step` the counted step among its events (`eventFactOf`), else null, `source` the `{ type, kind, category }` of its first event (`slotSourceOf`, `kind` null where the message records none, `category` the class the client names it by), which says nothing of the slot's other events, `number` its place among the carrier's slots, counted from one (it is no reference to the numbering of the summary request), `c` its C string and `output` that same whole text, so an empty `output` is an empty C string, which is no failure. `input` is the cut text of its events the call saw, in the slot's order, `inputDisplay` the same with each structured tool call named by `eventDisplayText`. The list names no seqs: the detail `slot` carries the slot's seqs.
 * An event is `visible` when its seq is in the range its call record keeps, the surface the call saw; the current surface and the carrier's cited sources decide nothing. The original a pruner replaced is not, and no node between replacements is added.
 * `tools` is `slotToolsOf`'s answer over the slot's own events and the one read of the log, `{ warnings, calls }` (`dsh/src/inner-monitor-tools.js`): one card per structured tool call of the slot's assistant messages, paired with the original result by the turn- and step-qualified identity the reducer names, and the warnings the fold's facts place on the cards. It is empty for a slot with no call, no result and no warning. No attachment is read and no result text is copied beside the events that hold it.
 * `usage` is `{ current, next, sourceTokens }`, read from the same one read of the log. `current` is `{ seq, usage }` of the slot's own main call, the first `assistant/message` among its events whatever event opens the slot, null where it has none, `usage` as `callUsageOf` reads it or null. `next` is null where `current` is, else `{ kind, seq, usage }` of the call after it: the first main call among the events of the carrier's later slots, in their order (`kind` `main`, a call with no usage still the one), and where none follows, the committed attempt's own summary call, the call record the carrier cites (`kind` `summary`, `usage` the last usage chunk of its stream as `callUsageOf` reads it); a later slot whose events cannot be told from the log leaves it null, never skipped and never taken for the summary, and fails nothing of the read. `sourceTokens` is the estimate the carrier's slot kept of its original text, a zero included, null for a carrier that kept none or a value that is no finite non-negative number.
 *
 * @param {{ sessionOf: (id: string) => (object|undefined), readMonitor: (session: object) => { attempts: object[], handoffs: object[] },
 *   live: (sessionId: string) => object[], kit: object, readSession: (sessionId: string) => Promise<{ events: object[] }>,
 *   nextTaskOf: (handoffId: number) => (string|null),
 *   readStored: (sessionId: string) => Promise<{ state: { attempts: object[], handoffs: object[] }, events: object[] }|undefined> }} options `nextTaskOf` is the next task the store holds under a handoff id, null where it holds none, read at each `rows`; `readMonitor` is the projection's state of a held session, `live` the registry's entries of a session id, `kit` the record and stream readers of `innerMonitorProjection`, `readSession` the session service's read of a whole log, called on the service, and `readStored` one snapshot of the session log with its state folded under the projection, `undefined` where the session is neither held nor stored
 */
export function createMonitorAccess({ sessionOf, readMonitor, live, kit, readSession, readStored, nextTaskOf }) {
  // What one request reads of the session, all of one source. A session the host holds an instance of gives that instance's state, the registry's entries and, when the request needs it, a read of its log. One it holds none of gives the one snapshot of its stored log, which the state is folded from and the log is read from, with nothing in flight. `undefined` for a session that is neither.
  async function factsOf(sessionId) {
    const session = sessionOf(sessionId);
    if (session !== undefined) return { state: readMonitor(session), entries: live(sessionId), log: async () => logOf(await readSession(sessionId)) };
    const stored = await readStored(sessionId);
    if (stored === undefined) return undefined;
    const log = logOf(stored);
    return { state: stored.state, entries: [], log: async () => log };
  }

  return {
    async rows(sessionId) {
      const facts = await factsOf(sessionId);
      return facts === undefined ? undefined : { attempts: rowsOf(facts.state, facts.entries, kit), handoffs: handoffRowsOf(facts.state, nextTaskOf) };
    },
    async handoff(sessionId, id) {
      const facts = await factsOf(sessionId);
      if (facts === undefined) return undefined;
      const handoff = handoffOf(facts.state, id);
      return handoffDetailOf(handoff, handoffRowOf(handoff, nextTaskOf), await facts.log());
    },
    async settlement(sessionId, id) {
      const facts = await factsOf(sessionId);
      if (facts === undefined) return undefined;
      const handoff = clearingOf(facts.state, id);
      return settlementEvidenceOf(facts.state, await facts.log(), sessionId, handoff.epoch - 1, kit, { tailCalls: handoff.tailCalls });
    },
    async currentSettlement(sessionId) {
      // Do not combine a live projection with a log taken at another cut.
      const snapshot = await readStored(sessionId);
      if (snapshot === undefined) return undefined;
      return settlementEvidenceOf(snapshot.state, logOf(snapshot), sessionId, snapshot.state.source.epoch, kit);
    },
    async settlementTarget(sessionId, { segment, through, seq }) {
      const snapshot = await readStored(sessionId);
      if (snapshot === undefined) return undefined;
      const log = logOf(snapshot);
      const target = settlementEvidenceOf(snapshot.state, log, sessionId, segment, kit, { through }).activity?.targets.find(each => each.seq === seq);
      return target === undefined ? NOT_TARGET : { seq, type: target.type, text: plainTextOf(log.get(seq)) };
    },
    async call(sessionId, id) {
      const facts = await factsOf(sessionId);
      if (facts === undefined) return undefined;
      const attempt = attemptOf(facts.state, id);
      const entry = facts.entries.find(each => each.attempt === attempt.id);
      return entry === undefined ? recordedCall(attempt, await facts.log(), kit) : liveCall(attempt, entry, kit);
    },
    async slots(sessionId, id) {
      const facts = await factsOf(sessionId);
      if (facts === undefined) return undefined;
      const attempt = attemptOf(facts.state, id);
      if (attempt.carrier === null) return NOT_COMMITTED;
      const log = await facts.log();
      const { slots, range } = committedOf(attempt, log, kit);
      return {
        slots: slots.map((slot) => {
          const { events, seqs, ...place } = placeOf(slot, log);
          const seen = events.filter(event => range.has(event.seq));
          const joined = texts => texts.filter(text => text !== '').join('\n');
          return { ...place, input: bounded(joined(seen.map(eventPreviewText))), inputDisplay: bounded(joined(seen.map(eventDisplayText))), output: slot.text };
        }),
      };
    },
    async slot(sessionId, id, key) {
      const facts = await factsOf(sessionId);
      if (facts === undefined) return undefined;
      const attempt = attemptOf(facts.state, id);
      if (attempt.carrier === null) return NOT_COMMITTED;
      const log = await facts.log();
      const { slots, range, summary } = committedOf(attempt, log, kit);
      const at = slots.findIndex(each => each.seqs[0] === key);
      if (at < 0) throw new Error(`the carrier of attempt ${id} holds no slot ${key}`);
      const slot = slots[at];
      const { events, ...place } = placeOf(slot, log);
      const tools = slotToolsOf({
        events, range, log, kinds: attempt.slotWarnings?.[key] ?? [], dispatches: attempt.slotDispatches?.[key] ?? [], oldReads: oldReadsOf(slot),
      });
      return {
        ...place, number: at + 1, c: slot.text, events: events.map(event => sourceEventView(event, { visible: range.has(event.seq) })), tools,
        usage: usageOfSlot({ slots, at, events, log, summary, kit }),
      };
    },
  };
}
