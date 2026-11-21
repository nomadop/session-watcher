// lib/inner-seal/end-record.js — the end record: the plugin record an attempt leaves when it fails or is cancelled.
// This module owns its name, its shape, its construction and its check; the writer builds the record here and the reader checks it here. The host adapter puts the log's plugin-record namespace before the name to make the record's type.

/** The end record's name, without the log's plugin-record namespace. */
export const END_RECORD_NAME = 'inner-end';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSeq = value => Number.isSafeInteger(value) && value >= 0;
const isText = value => typeof value === 'string';

/**
 * The data of an end record: its version, the seq of the attempt record it ends, how it ended and why, as given.
 * @param {{ attempt: number, outcome: 'failed'|'cancelled', reason: string }} end
 */
export const endRecordOf = ({ attempt, outcome, reason }) => ({ v: 1, attempt, outcome, reason });

/** Whether `data` is an end record's data: its version, a seq for the attempt, an outcome of `failed` or `cancelled`, and a text reason. */
export const isEndRecord = data => isObject(data) && data.v === 1 && isSeq(data.attempt)
  && (data.outcome === 'failed' || data.outcome === 'cancelled') && isText(data.reason);
