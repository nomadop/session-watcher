// test/helpers/dsh-settlement.js — one session's settlement fixtures over `dsh-events.js`: the monitor's access over a synthetic log, a priced seal, a `/sw-continue` clear and the recall steps a segment holds, in the record shapes DSH writes.
import { createMonitorAccess, innerMonitorProjection } from '../../dsh/src/inner-monitor-read.js';
import {
  assistantMessage, continueCheckpoint, innerAttempt, innerCall, innerEnd, innerSealCarrier, loadFollowUp, loadPayload, readBlockRecord, stepEnd, stepStart, toolCall, toolResult, userMessage,
} from './dsh-events.js';

export const SESSION = 's-settlement-recall';

export const kit = {
  pluginRecordOf: event => (event.ignorable === true && event.type.startsWith('plugin:')
    ? { type: event.type, seq: event.seq, time: event.time, data: event.data }
    : undefined),
  assembleAssistantStream: () => { throw new Error('the fixture records no stream'); },
  lastAssistantStreamChunk: (stream, type) => stream.findLast(record => record.type === 'chunk' && record.chunk.type === type)?.chunk,
};
const projection = innerMonitorProjection(kit);
export const fold = events => events.reduce((state, event) => projection.apply(state, event), projection.init());

/** DSH's token usage as an `assistant/message` carries it. */
export const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

/** The access over one session's events, read as a session the host holds none of (`readStored`) or as a held one (`readSession` for the log). */
export function accessOver(events, { held = false } = {}) {
  return createMonitorAccess({
    sessionOf: id => (held && id === SESSION ? {} : undefined),
    readMonitor: () => fold(events),
    live: () => [],
    kit,
    readSession: async () => ({ events }),
    readStored: async id => (id === SESSION ? { state: fold(events), events } : undefined),
    nextTaskOf: () => null,
  });
}

/** A committed seal over `range` (events) that its quote prices as `n` counted steps at the price ratio `cRatio`: the attempt record, the call record and the carrier. */
export function pricedSeal(range, n = range.length, { cRatio = 2 } = {}) {
  const seqs = range.map(event => event.seq);
  const start = innerAttempt({
    range: seqs,
    quote: { n, lA: 40_000, bEst: 0, cEst: 1600, sEst: 38_400, cRatio, fee: 10_000, kappa: 1.1, nRef: 0.52, N: 0.56, jRef: 4.12, q: 2.07, arm: 'right', trigger: 'quote' },
  });
  const call = innerCall({
    range: seqs, attempt: start.seq, endedAt: 1_700_000_100_000,
    stream: [{ type: 'chunk', time: range.at(-1).time, chunk: { type: 'usage', usage: tokens(20, 10, 60) } }],
  });
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, ...seqs], slots: [{ seqs: [seqs[0]], text: 'summary' }] });
  return { start, carrier, events: [start, call, carrier] };
}

/** A seal that failed: its attempt and end records, no carrier. */
export function failedSeal(range) {
  const start = innerAttempt({ range: range.map(event => event.seq) });
  return { start, events: [start, innerEnd({ attempt: start.seq })] };
}

/** The clear `/sw-continue` leaves behind a segment: the checkpoint that opens the next epoch, the load payload naming its token and the follow-up. */
export function clear(token, { from, to, handoffId = 7 }) {
  // Built in log order, so the seqs ascend as the events are listed.
  const checkpoint = continueCheckpoint({ token, startSeq: from.seq, endSeq: to.seq });
  const payload = loadPayload({ token, handoffId });
  return { payload, events: [checkpoint, payload, loadFollowUp({ token })] };
}

/** A direct read of the event `seq`, as the model requests it, of `name` (`sw_event_read` unless given). */
export const readCall = (id, seq, { name = 'sw_event_read', sessionId } = {}) => ({
  id, name, arguments: JSON.stringify({ seq, ...(sessionId === undefined ? {} : { session_id: sessionId }) }),
});

/**
 * One step as the loop logs it: `step/start`, the user messages `admit` (texts) the step admits, the model request (an `assistant/message` of `calls`), then for each call its dispatch and its result unless `results` says otherwise.
 * `answer` is each result's text, `isError` marks every result a failure and `dispatch: false` leaves the dispatches out; `blocked` names the calls the read guard blocked, whose records stand between the dispatches and the results.
 */
export function stepOf({
  turn, step, admit = [], calls = [], text, usage = tokens(20, 5, 600), answer = 'abcdefghijkl', isError = false, dispatch = true, results = true, error, blocked = [],
} = {}) {
  const start = stepStart({ turn, step });
  const admitted = admit.map(each => userMessage({ text: each }));
  const request = assistantMessage({ turn, step, text, toolCalls: calls, usage });
  const dispatched = dispatch ? calls.map(({ id, name, arguments: args }) => toolCall({ turn, step, callId: id, name, arguments: args })) : [];
  const records = blocked.map(callId => readBlockRecord({ turn, step, callId }));
  const answers = results ? calls.map(({ id }) => toolResult({ turn, step, callId: id, text: answer, isError, ...(error === undefined ? {} : { error }) })) : [];
  const end = stepEnd({ turn, step });
  return { start, admitted, request, dispatched, records, answers, end, events: [start, ...admitted, request, ...dispatched, ...records, ...answers, end] };
}

// Step 1 of turn 1 admits the task and answers it with a file read, and a seal sums that step up: the settlement's first range, `#0`. Everything a test adds comes after it.
export function opening() {
  const readFile = { id: 'file', name: 'read', arguments: JSON.stringify({ file_path: 'a.js' }) };
  const head = stepOf({ turn: 1, step: 1, admit: ['please work'], calls: [readFile], text: 'working', usage: tokens(100, 30, 900), answer: 'file text' });
  const [ask] = head.admitted;
  const sealed = pricedSeal([ask, head.request], 1);
  return { head, ask, sealed, events: [...head.events, ...sealed.events] };
}
