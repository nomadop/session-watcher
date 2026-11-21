// The attempt record (`lib/inner-seal/attempt-record.js`): the plugin record an inner seal's summary request leaves as it is dispatched, built and checked by its one owner. The record's shell is checked here; the request it shows is carried as the writer built it, and the message shape of its C tail is the host adapter's to read.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ATTEMPT_RECORD_NAME, attemptQuoteOf, attemptRecordOf, isAttemptRecord } from '../lib/inner-seal/attempt-record.js';

const TAIL = { role: 'user', content: [{ type: 'text', text: 'Write concise continuity notes.' }] };
const QUOTE = {
  n: 8, lA: 40000, bEst: 120, cEst: 2400, sEst: 37480, cRatio: 30, fee: 5000, kappa: 1.1,
  nRef: 15, N: 21.96, jRef: 28.87, q: 1.04, arm: 'left', trigger: 'quote',
};

const recordOf = (overrides = {}) => attemptRecordOf({
  range: { first: 3, last: 5, count: 3 },
  request: {
    options: { provider: 'p', model: 'm', purpose: 'inner-compaction', sessionId: 's' },
    messages: { count: 4, tail: TAIL },
    throughSeq: 5,
    headerSeq: null,
  },
  quote: QUOTE,
  ...overrides,
});

// A record with `change` made to a copy of its data.
const changed = (change) => {
  const data = structuredClone(recordOf());
  change(data);
  return data;
};

test('the attempt record is named without the log\'s plugin-record namespace', () => {
  assert.equal(ATTEMPT_RECORD_NAME, 'inner-attempt');
});

test('an attempt record is built with its version, range, request and quote as given, and reads back through the log\'s JSON', () => {
  const record = recordOf();
  assert.deepEqual(record, {
    v: 1,
    range: { first: 3, last: 5, count: 3 },
    request: {
      options: { provider: 'p', model: 'm', purpose: 'inner-compaction', sessionId: 's' },
      messages: { count: 4, tail: TAIL },
      throughSeq: 5,
      headerSeq: null,
    },
    quote: QUOTE,
  });
  assert.equal(isAttemptRecord(record), true);
  assert.equal(isAttemptRecord(JSON.parse(JSON.stringify(record))), true);
  assert.deepEqual(attemptQuoteOf(JSON.parse(JSON.stringify(record))), QUOTE);
});

test('a record whose shell is broken is no attempt record', () => {
  const broken = {
    'no data': null,
    'data that is no object': 'text',
    'an array': [],
    'another version': changed((data) => { data.v = 2; }),
    'no version': changed((data) => { delete data.v; }),
    'no range': changed((data) => { delete data.range; }),
    'a range that is text': changed((data) => { data.range = 'all'; }),
    'a range with no first': changed((data) => { delete data.range.first; }),
    'a range with a negative last': changed((data) => { data.range.last = -1; }),
    'a range with a fractional count': changed((data) => { data.range.count = 1.5; }),
    'a range whose first is text': changed((data) => { data.range.first = '3'; }),
    'no request': changed((data) => { delete data.request; }),
    'a request that is text': changed((data) => { data.request = 'text'; }),
    'a request with no messages': changed((data) => { delete data.request.messages; }),
    'messages that are a list': changed((data) => { data.request.messages = []; }),
    'messages with no tail': changed((data) => { delete data.request.messages.tail; }),
    'a tail that is text': changed((data) => { data.request.messages.tail = 'text'; }),
    'a tail that is null': changed((data) => { data.request.messages.tail = null; }),
    'a tail that is a list': changed((data) => { data.request.messages.tail = [TAIL]; }),
  };
  for (const [why, data] of Object.entries(broken)) assert.equal(isAttemptRecord(data), false, why);
});

test('the request is carried as the writer built it: its other parts and the message shape of its tail are not checked', () => {
  const opaque = {
    'a tail with content that is no block list': changed((data) => { data.request.messages.tail = { role: 'user', content: 'text' }; }),
    'a tail with nothing in it': changed((data) => { data.request.messages.tail = {}; }),
    'options that are text': changed((data) => { data.request.options = 'p/m'; }),
    'no options': changed((data) => { delete data.request.options; }),
    'a throughSeq and headerSeq that are no seqs': changed((data) => { data.request.throughSeq = 'x'; data.request.headerSeq = -3; }),
    'a message count that is no count': changed((data) => { data.request.messages.count = 'many'; }),
    'tools of any shape': changed((data) => { data.request.tools = { count: 'two' }; data.request.toolHistory = 7; }),
  };
  for (const [why, data] of Object.entries(opaque)) assert.equal(isAttemptRecord(data), true, why);
});

test('the quote an attempt record keeps is read through the quote check: one of any other shape, or none, reads as null and does not invalidate the record', () => {
  assert.deepEqual(attemptQuoteOf(recordOf()), QUOTE);
  const others = {
    'no quote': changed((data) => { delete data.quote; }),
    'a quote that is text': changed((data) => { data.quote = 'quote'; }),
    'a quote of the retired hard trigger': changed((data) => { data.quote.trigger = 'hard'; }),
    'a quote with no trigger': changed((data) => { data.quote.trigger = null; }),
    'a quote whose quantity is text': changed((data) => { data.quote.q = 'high'; }),
    'a quote whose step count is negative': changed((data) => { data.quote.n = -1; }),
  };
  for (const [why, data] of Object.entries(others)) {
    assert.equal(attemptQuoteOf(data), null, why);
    assert.equal(isAttemptRecord(data), true, `${why}: the record is still an attempt record`);
  }
});
