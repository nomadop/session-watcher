// lib/inner-seal/attempt-record.js — the attempt record: the plugin record an inner seal's summary request leaves as it is dispatched.
// This module owns its name, its shape, its construction and the check of its shell; the writer builds the record here and the reader checks it here. The host adapter puts the log's plugin-record namespace before the name to make the record's type.
// `request` is the request display the host adapter builds: carried as it was built, apart from the shell the reader needs, the C tail as an object. The message shape of that tail is the adapter's to read.
import { isQuote } from './quote.js';

/** The attempt record's name, without the log's plugin-record namespace. */
export const ATTEMPT_RECORD_NAME = 'inner-attempt';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = value => Number.isSafeInteger(value) && value >= 0;

/**
 * The data of an attempt record: its version, the `range` of seqs the attempt summarizes, the `request` the summary request shows and the `quote` the seal triggered on, as given.
 * @param {{ range: { first: number, last: number, count: number }, request: { messages: { tail: object } }, quote: object }} attempt
 */
export const attemptRecordOf = ({ range, request, quote }) => ({ v: 1, range, request, quote });

/** Whether `data` is an attempt record's data: its version, a range of three seqs, and a request whose messages hold the C tail as an object. The rest of the request is not read. */
export const isAttemptRecord = data => isObject(data) && data.v === 1
  && isObject(data.range) && isSeq(data.range.first) && isSeq(data.range.last) && isSeq(data.range.count)
  && isObject(data.request) && isObject(data.request.messages) && isObject(data.request.messages.tail);

/** The quote an attempt record keeps, as recorded; null where it keeps none of the shape of `isQuote`, which leaves the record itself valid. */
export const attemptQuoteOf = data => (isQuote(data.quote) ? data.quote : null);
