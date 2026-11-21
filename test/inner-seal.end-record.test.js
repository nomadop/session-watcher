// The end record (`lib/inner-seal/end-record.js`): the plugin record an attempt leaves when it fails or is cancelled, built and checked by its one owner.
import test from 'node:test';
import assert from 'node:assert/strict';

import { END_RECORD_NAME, endRecordOf, isEndRecord } from '../lib/inner-seal/end-record.js';

test('the end record is named without the log\'s plugin-record namespace', () => {
  assert.equal(END_RECORD_NAME, 'inner-end');
});

test('an end record is built with its version, attempt, outcome and reason as given, and reads back through the log\'s JSON', () => {
  for (const outcome of ['failed', 'cancelled']) {
    const record = endRecordOf({ attempt: 10, outcome, reason: 'the summary was not valid' });
    assert.deepEqual(record, { v: 1, attempt: 10, outcome, reason: 'the summary was not valid' });
    assert.equal(isEndRecord(record), true, outcome);
    assert.equal(isEndRecord(JSON.parse(JSON.stringify(record))), true, outcome);
  }
});

test('a reason that is empty text is a reason', () => {
  assert.equal(isEndRecord(endRecordOf({ attempt: 0, outcome: 'cancelled', reason: '' })), true);
});

test('a record whose shell is broken is no end record', () => {
  const record = endRecordOf({ attempt: 10, outcome: 'failed', reason: 'refused' });
  const changed = change => Object.assign({}, record, change);
  const { reason, ...withoutReason } = record;
  const broken = {
    'no data': null,
    'data that is text': 'text',
    'a list': [],
    'another version': changed({ v: 2 }),
    'no version': changed({ v: undefined }),
    'an attempt that is text': changed({ attempt: '10' }),
    'a negative attempt': changed({ attempt: -1 }),
    'a fractional attempt': changed({ attempt: 1.5 }),
    'no attempt': changed({ attempt: undefined }),
    'an outcome the monitor never writes': changed({ outcome: 'weird' }),
    'no outcome': changed({ outcome: undefined }),
    'a reason that is no text': changed({ reason: 3 }),
    'no reason': withoutReason,
  };
  for (const [why, data] of Object.entries(broken)) assert.equal(isEndRecord(data), false, why);
});
