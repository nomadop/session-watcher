// lib/inner-seal/read-block-record.js — the read block record: the plugin record the read guard leaves when a `read` result it replaced with an error reached the model.
// This module owns its name, its shape, its construction and its check; the writer (`dsh/src/read-guard.js`) builds the record here, and its readers, the inner monitor's fold (`dsh/src/inner-monitor-read.js`) and the recall judge (`lib/harness/dsh/recall-judge.js`), apply `isReadBlockRecord`. The host adapter puts the log's plugin-record namespace before the name to make the record's type.
// It names the call the way the log does, by turn, step and the model's call id, and the lines the read would have returned; it holds no file text.

/** The read block record's name, without the log's plugin-record namespace. */
export const READ_BLOCK_RECORD_NAME = 'inner-read-block';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIndex = value => Number.isSafeInteger(value) && value >= 0;
const isText = value => typeof value === 'string' && value !== '';

/**
 * The data of a read block record: its version, the `turn`, `step` and `callId` of the blocked call, the `path` as the model gave it and the `first` and `last` line the read returned, as given.
 * @param {{ turn: number, step: number, callId: string, path: string, first: number, last: number }} block
 */
export const readBlockRecordOf = ({ turn, step, callId, path, first, last }) => ({ v: 1, turn, step, callId, path, first, last });

/** Whether `data` is a read block record's data: its version, a turn and a step, a call id and a path, and a first and last line in order. */
export const isReadBlockRecord = data => isObject(data) && data.v === 1
  && isIndex(data.turn) && isIndex(data.step) && isText(data.callId) && isText(data.path)
  && isIndex(data.first) && isIndex(data.last) && data.first <= data.last;
