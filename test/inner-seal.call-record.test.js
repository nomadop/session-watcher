// The call record (`lib/inner-seal/call-record.js`): the plugin record an inner seal leaves for each auxiliary call whose stream it consumed, built and checked by its one owner. The record's shell is checked here; its `stream` and the C tail of its `input` are the host's payload, carried as they were built, and the carrier cache evidence is checked as a bounded list of results, not against any adapter's vocabulary.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CALL_RECORD_NAME, MAX_CARRIER_EVIDENCE, callRecordOf, isCallRecord, isCarrierCache } from '../lib/inner-seal/call-record.js';

const TAIL = { role: 'user', content: [{ type: 'text', text: 'Write concise continuity notes.' }] };
const STREAM = [{ type: 'chunk', time: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }];
const EVIDENCE = { results: [{ result: 'skipped', reason: 'no-native-point' }, { result: 'added' }, { result: 'native' }], omitted: 2 };

const callOf = (extra = {}) => callRecordOf({
  purpose: 'inner-compaction',
  selection: { provider: 'p', model: 'm' },
  input: { throughSeq: 5, headerSeq: 2, tail: TAIL },
  range: [3, 4, 5],
  stream: STREAM,
  endedAt: 1_700_000_100_000,
  ...extra,
});

// A call record with `change` made to a copy of its data.
const changed = (change, extra) => {
  const data = structuredClone(callOf(extra));
  change(data);
  return data;
};

const evidenceOf = results => ({ results, omitted: 0 });

test('the call record is named without the log\'s plugin-record namespace', () => {
  assert.equal(CALL_RECORD_NAME, 'inner-call');
});

test('a call record is built with its version and members as given, the optional ones only where given, and reads back through the log\'s JSON', () => {
  const bare = callOf();
  assert.deepEqual(bare, {
    v: 1, purpose: 'inner-compaction', selection: { provider: 'p', model: 'm' },
    input: { throughSeq: 5, headerSeq: 2, tail: TAIL }, range: [3, 4, 5], stream: STREAM, endedAt: 1_700_000_100_000,
  });
  assert.equal(isCallRecord(bare), true);

  const whole = callOf({ attempt: 9, carrierCache: EVIDENCE, thrown: { message: 'the stream broke' } });
  assert.deepEqual(whole, { ...bare, attempt: 9, carrierCache: EVIDENCE, thrown: { message: 'the stream broke' } });
  assert.equal(isCallRecord(JSON.parse(JSON.stringify(whole))), true);
});

test('an optional member given as none is no member of the record, as an explicit undefined would make the log\'s append throw', () => {
  const record = callOf({ attempt: null, carrierCache: null, thrown: undefined });
  assert.deepEqual(Object.keys(record).sort(), ['endedAt', 'input', 'purpose', 'range', 'selection', 'stream', 'v']);
  assert.equal(Object.values(record).includes(undefined), false);
  assert.equal(JSON.stringify(record), JSON.stringify(callOf()));
});

test('a record whose shell is broken is no call record', () => {
  const broken = {
    'no data': null,
    'data that is text': 'text',
    'a list': [],
    'another version': changed((data) => { data.v = 2; }),
    'no range': changed((data) => { delete data.range; }),
    'an empty range': changed((data) => { data.range = []; }),
    'a range that is text': changed((data) => { data.range = 'all'; }),
    'a range holding text': changed((data) => { data.range = ['a']; }),
    'a range holding a negative seq': changed((data) => { data.range = [3, -1]; }),
    'no stream': changed((data) => { delete data.stream; }),
    'a stream that is text': changed((data) => { data.stream = 'text'; }),
    'a stream that is an object': changed((data) => { data.stream = {}; }),
    'no input': changed((data) => { delete data.input; }),
    'an input that is text': changed((data) => { data.input = 'text'; }),
    'an input with no tail': changed((data) => { delete data.input.tail; }),
    'a tail that is text': changed((data) => { data.input.tail = 'text'; }),
    'a tail that is null': changed((data) => { data.input.tail = null; }),
    'a tail that is a list': changed((data) => { data.input.tail = [TAIL]; }),
    'a thrown that is text': changed((data) => { data.thrown = 'text'; }),
    'a thrown whose message is no text': changed((data) => { data.thrown = { message: 1 }; }),
    'a thrown with no message': changed((data) => { data.thrown = {}; }),
  };
  for (const [why, data] of Object.entries(broken)) assert.equal(isCallRecord(data), false, why);
});

test('the stream and the C tail are carried as the host built them: what is inside them, and the other members of the input, are not checked', () => {
  const opaque = {
    'a stream of any records': changed((data) => { data.stream = [null, 3, 'text', { type: 'unknown' }]; }),
    'an empty stream': changed((data) => { data.stream = []; }),
    'a tail that is no message': changed((data) => { data.input.tail = { role: 'user', content: 'text' }; }),
    'a tail with nothing in it': changed((data) => { data.input.tail = {}; }),
    'an input beside its tail that holds no seqs': changed((data) => { data.input.throughSeq = 'x'; data.input.headerSeq = -4; }),
    'an input with only its tail': changed((data) => { data.input = { tail: TAIL }; }),
  };
  for (const [why, data] of Object.entries(opaque)) assert.equal(isCallRecord(data), true, why);
});

test('a malformed carrier cache does not make the call record malformed: the evidence is a field of its own', () => {
  assert.equal(isCallRecord(changed((data) => { data.carrierCache = { results: [], omitted: -1 }; })), true);
  assert.equal(isCallRecord(changed((data) => { data.carrierCache = 'added'; })), true);
});

test('the evidence of a request is one to the bound results, each with text for its result and, where it has one, for its reason, and a count of those left out', () => {
  assert.equal(Number.isSafeInteger(MAX_CARRIER_EVIDENCE) && MAX_CARRIER_EVIDENCE > 0, true);
  assert.equal(isCarrierCache(EVIDENCE), true);
  assert.equal(isCarrierCache(JSON.parse(JSON.stringify(EVIDENCE))), true);
  assert.equal(isCarrierCache(evidenceOf([{ result: 'added' }])), true, 'one result');
  assert.equal(isCarrierCache(evidenceOf(Array.from({ length: MAX_CARRIER_EVIDENCE }, () => ({ result: 'added' })))), true, 'the bound, as many as the bound');
  assert.equal(isCarrierCache({ results: [{ result: 'added' }], omitted: 1_000_000 }), true, 'a count of any size');
});

test('the evidence is no judge of the adapter\'s vocabulary: a result or a reason of any text, and a result with no reason beside a skip, is carried', () => {
  assert.equal(isCarrierCache(evidenceOf([{ result: 'reused' }])), true, 'a result outside the adapter\'s');
  assert.equal(isCarrierCache(evidenceOf([{ result: 'skipped', reason: 'the key was wrong' }])), true, 'a reason outside the adapter\'s');
  assert.equal(isCarrierCache(evidenceOf([{ result: 'skipped' }])), true, 'a skip with no reason');
  assert.equal(isCarrierCache(evidenceOf([{ result: 'added', body: 'a prompt' }])), true, 'a result with a member of its own is carried as it is');
});

test('evidence that is not a bounded list of results with a count is none', () => {
  const none = {
    'no evidence': undefined,
    'null': null,
    'text': 'added',
    'a list': [{ result: 'added' }],
    'results that are no list': { results: 'added', omitted: 0 },
    'no results': { omitted: 0 },
    'an empty list': evidenceOf([]),
    'a list past the bound': evidenceOf(Array.from({ length: MAX_CARRIER_EVIDENCE + 1 }, () => ({ result: 'added' }))),
    'a result that is text': evidenceOf(['added']),
    'a result that is null': evidenceOf([null]),
    'a result that is a list': evidenceOf([['added']]),
    'a result with no result text': evidenceOf([{}]),
    'a result with no result text but a reason': evidenceOf([{ reason: 'no-native-point' }]),
    'a result whose result is no text': evidenceOf([{ result: 1 }]),
    'a reason that is no text': evidenceOf([{ result: 'skipped', reason: 3 }]),
    'a good result beside a broken one': evidenceOf([{ result: 'added' }, { result: null }]),
    'no count': { results: [{ result: 'added' }] },
    'a negative count': { results: [{ result: 'added' }], omitted: -1 },
    'a fractional count': { results: [{ result: 'added' }], omitted: 1.5 },
    'a count that is text': { results: [{ result: 'added' }], omitted: '0' },
    'a count that is not finite': { results: [{ result: 'added' }], omitted: Infinity },
  };
  for (const [why, value] of Object.entries(none)) assert.equal(isCarrierCache(value), false, why);
});
