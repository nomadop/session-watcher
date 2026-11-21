// lib/inner-seal/call-record.js — the call record: the plugin record an inner seal leaves for each auxiliary call whose stream it consumed.
// This module owns its name, its shape, its construction and the check of its shell, with the check of the carrier cache evidence a call may carry; the writer builds the record here and the reader checks it here. The host adapter puts the log's plugin-record namespace before the name to make the record's type.
// `stream` and the C tail of `input` are the host's payload: carried as they were built, never read inside. The evidence is checked as a bounded list of results with a count of those left out; what the results say is the adapter's vocabulary, which this module does not know.

/** The call record's name, without the log's plugin-record namespace. */
export const CALL_RECORD_NAME = 'inner-call';

/** The most results the evidence of one request holds; the ones after it are counted in `omitted`. */
export const MAX_CARRIER_EVIDENCE = 8;

/** The uncached share of a recorded call's input above which the host writes its diagnostic. */
export const UNCACHED_SHARE_ALERT = 1 / 2;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = value => Number.isSafeInteger(value) && value >= 0;
const isText = value => typeof value === 'string';

/**
 * The data of a call record: its version and the members given. `attempt`, `carrierCache` and `thrown` are members only where given, a member given as undefined or null being none, as the log's append throws on an explicit undefined.
 * `input` is `{ throughSeq, headerSeq, tail }` as the request was sent, `range` the seqs the call summarized, `stream` its compact stream, `endedAt` the time its stream iteration ended, `attempt` the seq of the attempt record the call names, `carrierCache` the evidence of the request's cache points as `{ results, omitted }` and `thrown` `{ message }` of an error thrown while the stream was consumed or assembled.
 * @param {{ purpose: string, selection: { provider: string, model: string, reasoningEffort?: string }, input: { tail: object },
 *   range: number[], stream: object[], endedAt: number, attempt?: (number|null), carrierCache?: (object|null), thrown?: { message: string } }} call
 */
export function callRecordOf({ purpose, selection, input, range, stream, endedAt, attempt, carrierCache, thrown }) {
  return {
    v: 1, purpose, selection, input, range, stream, endedAt,
    ...(carrierCache == null ? {} : { carrierCache }),
    ...(thrown == null ? {} : { thrown }),
    ...(attempt == null ? {} : { attempt }),
  };
}

/** Whether `data` is a call record's data: its version, a range of seqs that is not empty, a stream that is a list, an input holding the C tail as an object, and a `thrown` that is none or holds a text message. What is inside the stream and the tail, and the rest of the input, are not read. */
export const isCallRecord = data => isObject(data) && data.v === 1
  && Array.isArray(data.range) && data.range.length > 0 && data.range.every(isSeq) && Array.isArray(data.stream)
  && isObject(data.input) && isObject(data.input.tail)
  && (data.thrown === undefined || (isObject(data.thrown) && isText(data.thrown.message)));

const isCarrierResult = value => isObject(value) && isText(value.result) && (value.reason === undefined || isText(value.reason));

/** Whether `value` is the carrier cache evidence of one request in the structure the record holds: `results`, one to `MAX_CARRIER_EVIDENCE` results each with a text `result` and, where it has one, a text `reason`, and `omitted`, the count of the results left out. */
export const isCarrierCache = value => isObject(value) && Array.isArray(value.results)
  && value.results.length > 0 && value.results.length <= MAX_CARRIER_EVIDENCE && value.results.every(isCarrierResult)
  && Number.isSafeInteger(value.omitted) && value.omitted >= 0;
