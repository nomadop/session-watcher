// The read block record (`lib/inner-seal/read-block-record.js`): what the read guard writes for a block that reached the model, and what its reader accepts.
import test from 'node:test';
import assert from 'node:assert/strict';

import { isReadBlockRecord, READ_BLOCK_RECORD_NAME, readBlockRecordOf } from '../lib/inner-seal/read-block-record.js';

const BLOCK = { turn: 2, step: 1, callId: 'call-3', path: 'src/a.js', first: 4, last: 9 };

test('the record the writer builds is the one the reader accepts, and holds the call, the path and the lines alone', () => {
  const record = readBlockRecordOf({ ...BLOCK, text: 'file text that must not be kept' });
  assert.deepEqual(record, { v: 1, ...BLOCK });
  assert.ok(isReadBlockRecord(record));
  assert.equal(typeof READ_BLOCK_RECORD_NAME, 'string');
});

test('a record of another version, shape or order of lines is no read block record', () => {
  const record = readBlockRecordOf(BLOCK);
  for (const broken of [
    { ...record, v: 2 }, { ...record, turn: -1 }, { ...record, step: 1.5 }, { ...record, callId: '' }, { ...record, path: 7 },
    { ...record, first: 9, last: 4 }, { ...record, last: undefined }, null, [], 'record',
  ]) assert.equal(isReadBlockRecord(broken), false, JSON.stringify(broken));
  assert.ok(isReadBlockRecord({ ...record, first: 4, last: 4 }), 'a read of one line');
});
