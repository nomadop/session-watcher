// The read side of the inner monitor (`dsh/src/inner-monitor-read.js`): the projection folded over the attempt records and carriers `test/helpers/dsh-events.js` builds, the rows derived from the folded state and the live entries of the registry, and the access the channel reads those rows through over a real registry and real sessions, and the details of an attempt through over the facts a log holds, over the real record and stream readers of the checkout `SW_DSH_CHECKOUT` names. Without the checkout every case skips.
// What a real seal writes into the projection and the details is the seal's cases (`test/dsh.inner-seal.test.js`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createInnerMonitor } from '../dsh/src/inner-monitor.js';
import { MAX_CARRIER_EVIDENCE } from '../lib/inner-seal/call-record.js';
import { innerQuote } from '../lib/inner-seal/quote.js';

// The policy the quotes below are priced under, the one each page then names.
const PRESET = 'E2';
import { parentMetaParts, quoteFactsOf } from '../dsh/src/client/monitor-model.js';
import { exportSession } from '../dsh/src/client/monitor-export.js';
import { CARRIED_WORDING, carriedNote } from '../lib/carried-evidence.js';
import { CARRIER_TABLE } from '../lib/harness/dsh/carrier-table.js';
import { INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE } from '../dsh/src/inner-seal.js';
import {
  heldInContext, innerMonitorProjection, isMonitorInput, rowsOf, createMonitorAccess, MONITOR_PROJECTION_KEY, PREVIEW_SOURCE_CHARS,
} from '../dsh/src/inner-monitor-read.js';
import {
  assistantMessage, attempt, compactCheckpoint, compactionPrune, ignorableEvent, innerAttempt, innerCall, innerEnd, innerSealCarrier, loadFollowUp, loadPayload, loadReads, prunedResult, requestHeader, toolCall, toolResult,
  turnStart, userMessage,
} from './helpers/dsh-events.js';
import { newSession } from './helpers/dsh-mode-kit.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const LIBS = {
  session: 'packages/core/session/lib/index.js',
  llm: 'packages/llm/llm/lib/index.js',
};
const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : Object.values(LIBS).find(path => !existsSync(join(CHECKOUT, path)))?.replace(/^/, 'SW_DSH_CHECKOUT names no ') ?? false;

const [sessionPackage, llmPackage] = skip ? [] : await Promise.all(Object.values(LIBS).map(path => import(pathToFileURL(join(CHECKOUT, path)).href)));

// The values the read side takes of DSH: the record reader of `dsh-session` and the stream readers of `dsh-llm`, as `innerKit` supplies them.
const kit = skip ? null : {
  pluginRecordOf: sessionPackage.pluginRecordOf,
  assembleAssistantStream: llmPackage.assembleAssistantStream,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
};
const projection = skip ? null : innerMonitorProjection(kit);

// The state the registry's fold reaches over `events`: `init`, then `apply` per event.
const fold = (events, header) => events.reduce((state, event) => projection.apply(state, event), projection.init(header));
const rowsFor = (events, live = []) => rowsOf(fold(events), live, kit);

// The compact stream the real accumulator keeps of `chunks`, a tick apart.
function streamOf(chunks) {
  const accumulator = new llmPackage.AssistantStreamAccumulator();
  chunks.forEach((chunk, tick) => accumulator.push({ time: 1_700_000_000_000 + tick, chunk }));
  return accumulator.snapshot();
}

const textChunks = text => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
];
const USAGE_CHUNK = { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 950, cacheReadTokens: 800 } };
const USAGE = { input: 120, output: 30, cacheRead: 800, cacheWrite: 0 };
const STOP = { type: 'finish', reason: { kind: 'stop' } };
// A summary response that ran to its stop: the text, then the usage and the finish.
const answer = text => streamOf([...textChunks(text), USAGE_CHUNK, STOP]);

const PROMPT = 'Write concise continuity notes for the listed parts of this ongoing task.';
const SUMMARIES = '{"1":"one","2":"two","3":"three"}';
const CALL_ENDED_AT = 1_700_000_100_000;

const slotsOf = count => Array.from({ length: count }, (_, index) => ({ seqs: [index], text: `summary ${index + 1}` }));

// The facts of one seal as the seal writes them, the events it summarizes first: the start, the call that names it, the prune and the carrier that cites the call.
function sealOf({ tail = PROMPT, stream = answer(SUMMARIES), slots = 3, quote } = {}) {
  const source = [userMessage({ text: 'please work' }), assistantMessage({ text: 'reply 1' }), assistantMessage({ text: 'reply 2' })];
  const range = source.map(event => event.seq);
  const start = innerAttempt({ range, tail, quote });
  const call = innerCall({ range, tail, stream, endedAt: CALL_ENDED_AT, attempt: start.seq });
  const prune = compactionPrune(source[0]);
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, prune.seq, ...range], slots: slotsOf(slots) });
  return { source, range, start, call, prune, carrier };
}

test('a sealed attempt folds to a committed row: the start, the call, the prune and the carrier give its slots, times, response and usage, and the source events and the prune change nothing', { skip }, () => {
  const { source, range, start, call, prune, carrier } = sealOf();

  const rows = rowsFor([...source, start, call, prune, carrier]);

  assert.deepEqual(rows, [{
    id: start.seq,
    revision: carrier.seq,
    status: 'committed',
    startedAt: start.time,
    endedAt: carrier.time,
    range: { first: range[0], last: range.at(-1), count: range.length },
    reason: null,
    slots: 3,
    call: { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: PROMPT, output: SUMMARIES, outputDisplay: 'one\ntwo\nthree', usage: USAGE },
    contextChange: { before: null, after: null, delta: null, miss: null },
    trigger: null,
    stepN: null,
    cRatio: null,
    epoch: 0,
  }]);
});

test('a valid call with no carrier is not a committed seal: an attempt with only its start, or with its start and a call that finished, reads unknown', { skip }, () => {
  const { source, start, call } = sealOf();

  const [started] = rowsFor([...source, start]);
  const [called] = rowsFor([...source, start, call]);

  assert.equal(started?.status, 'unknown');
  assert.equal(called?.status, 'unknown');
  assert.equal(called?.call.state, 'received', 'the call itself did finish');
  assert.equal(called?.slots, null);
  assert.equal(called?.endedAt, null);
});

// Quotes as the seal records them, the `innerQuote` snapshots of a quote left of its reference, one right of it, and one whose trigger is the retired `hard`, which is no quote the monitor reads.
const QUOTE_FIELDS = { lA: 40000, bEst: 120, cEst: 2400, sEst: 37480, cRatio: 30, fee: 5000, kappa: 1.1 };
const QUOTES = {
  inside: { n: 8, ...QUOTE_FIELDS, nRef: 15, N: 21.96, jRef: 28.87, q: 1.04, arm: 'left', trigger: 'quote' },
  beyond: { n: 20, ...QUOTE_FIELDS, nRef: 1, N: 2.16, jRef: 10.1, q: 2.19, arm: 'right', trigger: 'quote' },
  hard: { n: 24, ...QUOTE_FIELDS, cRatio: null, nRef: null, N: null, jRef: null, q: null, arm: null, trigger: 'hard' },
};

test('the quote an attempt record keeps folds with it: the row carries the deviation q and the kappa the snapshot holds, a value the quote has none of null, while an attempt recorded without a quote has none and is not reconstructed', { skip }, () => {
  const rowOf = (quote, { failed = false } = {}) => {
    const { source, start, call, prune, carrier } = sealOf({ quote });
    return rowsFor(failed ? [...source, start, innerEnd({ attempt: start.seq, outcome: 'failed', reason: 'refused' })] : [...source, start, call, prune, carrier])[0];
  };
  assert.deepEqual(rowOf(QUOTES.inside).trigger, { q: 1.04, kappa: 1.1 });
  assert.deepEqual([QUOTES.inside, QUOTES.beyond, undefined].map(quote => rowOf(quote).stepN), [8, 20, null], 'the step count is the quote\'s n, and none for an attempt recorded without a quote');
  assert.deepEqual([QUOTES.inside, QUOTES.beyond, undefined].map(quote => rowOf(quote).cRatio), [30, 30, null], 'the price ratio is the quote\'s own, none where there is no quote');
  assert.deepEqual(rowOf(QUOTES.beyond).trigger, { q: 2.19, kappa: 1.1 }, 'a q at or above kappa is carried as it is');
  const hard = rowOf(QUOTES.hard, { failed: true });
  assert.deepEqual([hard.trigger, hard.stepN, hard.cRatio], [null, null, null], 'a quote with trigger `hard` reads as no quote');
  assert.equal(hard.status, 'failed', 'the quote leaves the status as the facts give it');
  assert.deepEqual(rowOf(undefined).trigger, null, 'an attempt recorded before the quote');
});

// What the producer's quote becomes down the read chain: the quote `innerQuote` prices is recorded, folded, read as a row, worded by the model the page and the Markdown export share, and listed with its kappa and preset.
test('a quote the producer prices reaches the read side with the kappa and the preset it was priced under: the row carries its q and kappa, the shared model words them, the export lists them and the page\'s facts show that kappa and preset', { skip }, async () => {
  const t = (key, params) => (params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`);
  const estimateOf = (n, lA) => ({ n, lA, bEst: 0, cEst: 200 * n, sEst: lA - 200 * n });
  const quotes = {
    // q is above the retired fixed 1.1 and under the kappa this quote was compared with.
    underKappa: innerQuote({ n: 8, estimate: estimateOf(8, 18000), cRatio: 40, preset: PRESET }),
    rightAbove: innerQuote({ n: 8, estimate: estimateOf(8, 200_000), cRatio: 30, preset: PRESET }),
    lowRatio: innerQuote({ n: 8, estimate: estimateOf(8, 300_000), cRatio: 12.5, preset: PRESET }),
    late: innerQuote({ n: 30, estimate: estimateOf(30, 1_000_000), cRatio: 30, preset: PRESET }),
  };
  const read = quote => {
    const { source, start, call, prune, carrier } = sealOf({ quote });
    const events = [...source, start, call, prune, carrier];
    return { row: rowsFor(events)[0], recorded: fold(events).attempts[0].quote };
  };
  const rows = Object.fromEntries(Object.entries(quotes).map(([name, quote]) => [name, read(quote)]));
  for (const [name, quote] of Object.entries(quotes)) {
    assert.equal(quote.trigger, 'quote', name);
    assert.deepEqual(rows[name].recorded, quote, `${name}: the snapshot is kept as the producer made it`);
  }
  for (const [name, quote] of Object.entries(quotes)) assert.deepEqual(rows[name].row.trigger, { q: quote.q, kappa: quote.kappa }, name);
  assert.ok(Number.isFinite(quotes.underKappa.q) && Number.isFinite(quotes.underKappa.kappa), 'the values are numbers the producer priced');

  const parts = name => parentMetaParts(rows[name].row, 9_999, t);
  assert.deepEqual(['underKappa', 'rightAbove', 'late'].map(name => parts(name)[2].text), ['monitor.meta.estimate(q=1.14)', 'monitor.meta.estimate(q=1.36)', 'monitor.meta.estimate(q=4.92)']);
  assert.deepEqual(['underKappa', 'lowRatio'].map(name => parts(name)[2].title), ['monitor.meta.estimate.kappa.title(kappa=1.15)', 'monitor.meta.estimate.kappa.title(kappa=0.95)']);
  assert.deepEqual(['underKappa', 'rightAbove', 'lowRatio', 'late'].map(name => parts(name)[2].attention), [undefined, undefined, undefined, undefined], 'no deviation is a warning');
  const factOf = (name, key) => quoteFactsOf(rows[name].recorded, t).find(([term]) => term === key)[1];
  assert.deepEqual(['underKappa', 'rightAbove', 'lowRatio'].map(name => factOf(name, 'monitor.quote.kappa')), ['1.146', '1.099', '0.952']);
  assert.deepEqual(['underKappa', 'rightAbove', 'lowRatio', 'late'].map(name => factOf(name, 'monitor.quote.preset')), Array(4).fill(`monitor.quote.preset.${PRESET}`), 'the preset the producer recorded reaches the page');

  const exported = await exportSession({ reader: { rows: async () => ({ attempts: [rows.underKappa.row, rows.rightAbove.row].map((row, index) => ({ ...row, id: index + 1 })) }) }, t, now: 9_999 });
  const [first, second] = exported.trim().split('\n');
  assert.ok(first.includes('monitor.meta.estimate(q=1.14)'), first);
  assert.ok(second.includes('monitor.meta.estimate(q=1.36)'), second);
});

test('each attempt carries the epoch it began in, the count of epoch boundaries folded before its first record: a committed and a failed attempt alike, and one whose call is recorded after a boundary keeps the epoch it began in', { skip }, () => {
  const first = sealOf();
  const toSecond = compactCheckpoint({ startSeq: first.source[0].seq, endSeq: first.carrier.seq });
  const second = sealOf();
  const failedStart = innerAttempt({ range: second.range, tail: PROMPT });
  const failedEnd = innerEnd({ attempt: failedStart.seq, outcome: 'failed', reason: 'refused' });
  const crossing = innerAttempt({ range: second.range, tail: PROMPT });
  const toThird = compactCheckpoint({ startSeq: second.source[0].seq, endSeq: failedEnd.seq });
  const crossingCall = innerCall({ range: second.range, tail: PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: crossing.seq });

  const events = [
    ...first.source, first.start, first.call, first.prune, first.carrier, toSecond,
    ...second.source, second.start, second.call, second.prune, second.carrier, failedStart, failedEnd, crossing, toThird, crossingCall,
  ];

  assert.deepEqual(rowsFor(events).map(row => [row.id, row.epoch]), [
    [first.start.seq, 0], [second.start.seq, 1], [failedStart.seq, 1], [crossing.seq, 1],
  ]);
});

// The entry the registry keeps of an attempt in flight, as `monitor.live` answers it: `stream()` is the accumulator's snapshot as it stands.
const entryOf = (start, { phase = 'generating', endedAt = null, stream = [] } = {}) => ({
  attempt: start.seq, phase, endedAt, request: start.data.request, tools: undefined, stream: () => stream,
});

test('an end record decides a failed or cancelled status and gives its reason, the call that came before it kept as it finished', { skip }, () => {
  for (const [outcome, reason] of [['failed', 'inner seal of session s failed: the summary text is not a JSON object of 3 strings keyed "1" to "3"'], ['cancelled', 'user']]) {
    const { source, start, call } = sealOf({ stream: answer('not a summary') });
    const end = innerEnd({ attempt: start.seq, outcome, reason });

    const [row] = rowsFor([...source, start, call, end]);

    assert.equal(row?.status, outcome);
    assert.equal(row?.reason, reason);
    assert.equal(row?.endedAt, end.time, 'the terminal fact\'s time');
    assert.equal(row?.revision, end.seq);
    assert.equal(row?.slots, null);
    assert.deepEqual(row?.call, { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: PROMPT, output: 'not a summary', outputDisplay: 'not a summary', usage: USAGE });
  }
});

test('a start and a failed end with no call and no live entry still show the start\'s C tail as the input, cut at PREVIEW_SOURCE_CHARS, and the call as absent', { skip }, () => {
  const tail = 'x'.repeat(PREVIEW_SOURCE_CHARS + 40);
  const { source, start } = sealOf({ tail });
  const end = innerEnd({ attempt: start.seq, reason: 'no adapter for this route' });

  const [row] = rowsFor([...source, start, end]);

  assert.equal(row?.status, 'failed');
  assert.equal(row?.reason, 'no adapter for this route');
  assert.deepEqual(row?.call, {
    state: 'absent', endedAt: null, finish: null, thrown: null, input: tail.slice(0, PREVIEW_SOURCE_CHARS), output: null, outputDisplay: null, usage: null,
  });
});

test('the call is received where a finish chunk was observed and an error where none was, a recorded thrown message shown beside either and deciding neither, and a live entry that has finished reads as its recorded call will', { skip }, () => {
  const partial = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: '{"1":"one"' }];
  const cases = [
    ['a stream that threw before a finish chunk', { stream: streamOf(partial), thrown: 'the connection reset' }, 'error', 'the connection reset'],
    ['a stream that threw after its finish chunk', { stream: answer(SUMMARIES), thrown: 'the connection reset' }, 'received', 'the connection reset'],
    ['a stream with no finish chunk', { stream: streamOf(partial) }, 'error', null],
    ['a stream that ran to its stop', { stream: answer(SUMMARIES) }, 'received', null],
  ];
  for (const [why, { stream, thrown }, state, message] of cases) {
    const { source, range, start } = sealOf();
    const call = innerCall({ range, tail: PROMPT, stream, endedAt: CALL_ENDED_AT, attempt: start.seq, ...(thrown === undefined ? {} : { thrown }) });
    const end = innerEnd({ attempt: start.seq, reason: 'the summary stream threw: the connection reset' });

    const [recorded] = rowsFor([...source, start, call]);
    const [ended] = rowsFor([...source, start, call, end]);
    const [live] = rowsFor([...source, start], [entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT, stream })]);

    assert.equal(recorded?.call.state, state, why);
    assert.equal(recorded?.call.thrown, message, why);
    assert.equal(live?.call.state, state, `${why}: the live entry reads the stream as its recorded call is read`);
    assert.deepEqual([ended?.status, ended?.reason, ended?.call.state], ['failed', end.data.reason, state], `${why}: the end record alone decides the attempt`);
  }
});

test('the status is the first that holds of the carrier, the end record, a live entry, else unknown: an end beats a registry that still lists the attempt, and a carrier beats both', { skip }, () => {
  const { source, start, call, prune, carrier } = sealOf();
  const end = innerEnd({ attempt: start.seq, reason: 'the log was cut' });
  const generating = entryOf(start);
  const validating = entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT });
  const statusOf = (events, live) => rowsFor([...source, ...events], live)[0]?.status;

  assert.equal(statusOf([start], []), 'unknown');
  assert.equal(statusOf([start], [generating]), 'generating');
  assert.equal(statusOf([start, call], [validating]), 'validating');
  assert.equal(statusOf([start, call, end], [validating]), 'failed', 'an end beats a live entry');
  assert.equal(statusOf([start, call, prune, carrier], [validating]), 'committed', 'a carrier beats a live entry');
  assert.equal(statusOf([start, call, end, prune, carrier], []), 'committed', 'a carrier beats an end');
  const [both] = rowsFor([...source, start, call, end, prune, carrier]);
  assert.equal(both?.reason, null, 'the end\'s reason is not the committed row\'s');
  assert.equal(both?.endedAt, carrier.time, 'the carrier is the terminal fact');
});

test('a call that names no attempt of the log makes no row, a carrier citing it commits nothing, and a call that joins an attempt with a start leaves the start\'s prompt as the input', { skip }, () => {
  const { source, range, prune } = sealOf();
  // A call with no `attempt`, as a seal from before the monitor wrote it, and one that names an attempt the log never started.
  const old = innerCall({ range, tail: 'an older prompt', stream: answer(SUMMARIES) });
  const orphan = innerCall({ range, tail: 'a call of a lost start', stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: old.seq - 1 });
  const carrier = innerSealCarrier({ sourceEventSeqs: [old.seq, prune.seq, ...range], slots: slotsOf(2) });

  assert.deepEqual(rowsFor([...source, old, orphan]), []);
  assert.deepEqual(rowsFor([...source, old, orphan, prune, carrier]), []);

  const next = sealOf({ tail: 'the start\'s prompt' });
  const rewritten = innerCall({ range: next.range, tail: 'the call\'s prompt', stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: next.start.seq });
  const rows = rowsFor([...source, old, ...next.source, next.start, rewritten]);
  assert.deepEqual(rows.map(row => [row.id, row.call.input]), [[next.start.seq, 'the start\'s prompt']]);
});

const BLOCK_START = { type: 'block-start', index: 0, blockType: 'text' };
const delta = text => ({ type: 'text-delta', index: 0, text });

test('a live entry adds the response as it streams to the call of its attempt, generating with the text so far and validating with the call\'s end time, and no stream update moves the revision', { skip }, () => {
  const { source, start } = sealOf();
  const first = streamOf([BLOCK_START, delta('{"1":"one",')]);
  const second = streamOf([BLOCK_START, delta('{"1":"one",'), delta('"2":"two"}')]);

  const [early] = rowsFor([...source, start], [entryOf(start, { stream: first })]);
  const [later] = rowsFor([...source, start], [entryOf(start, { stream: second })]);
  const [done] = rowsFor([...source, start], [entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT, stream: answer(SUMMARIES) })]);
  const [cut] = rowsFor([...source, start], [entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT, stream: first })]);

  assert.deepEqual(early?.call, { state: 'generating', endedAt: null, finish: null, thrown: null, input: PROMPT, output: '{"1":"one",', outputDisplay: '{"1":"one",', usage: null });
  assert.equal(later?.call.output, '{"1":"one","2":"two"}');
  assert.deepEqual([early?.revision, later?.revision], [start.seq, start.seq], 'the stream moves the response, not the revision');
  assert.equal(done?.status, 'validating');
  assert.deepEqual(done?.call, { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: PROMPT, output: SUMMARIES, outputDisplay: 'one\ntwo\nthree', usage: USAGE });
  assert.equal(cut?.call.state, 'error', 'a response that ended with no finish chunk');
});

test('a recorded call is read as recorded whatever a live entry streams, and a live entry of an attempt the log does not hold makes no row', { skip }, () => {
  const { source, start, call } = sealOf();
  const live = entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT + 5, stream: streamOf([BLOCK_START, delta('streaming')]) });

  const [row] = rowsFor([...source, start, call], [live]);

  assert.deepEqual(row?.call, { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: PROMPT, output: SUMMARIES, outputDisplay: 'one\ntwo\nthree', usage: USAGE });
  assert.deepEqual(rowsFor([...source], [live]), []);
});

test('a response that does not assemble has no text but keeps its finish and usage, recorded or live, and a response longer than PREVIEW_SOURCE_CHARS is cut to it', { skip }, () => {
  // An image block that never closed: the assembler of DSH refuses it.
  const unclosed = streamOf([{ type: 'block-start', index: 0, blockType: 'image' }, USAGE_CHUNK, STOP]);
  const { source, start, call } = sealOf({ stream: unclosed });
  const long = 'y'.repeat(PREVIEW_SOURCE_CHARS + 30);
  const lengthy = sealOf({ stream: answer(long) });

  const [recorded] = rowsFor([...source, start, call]);
  const [live] = rowsFor([...source, start], [entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT, stream: unclosed })]);
  const [cutRecorded] = rowsFor([...lengthy.source, lengthy.start, lengthy.call]);
  const [cutLive] = rowsFor([...source, start], [entryOf(start, { stream: streamOf([BLOCK_START, delta(long)]) })]);

  for (const row of [recorded, live]) {
    assert.deepEqual(row?.call, { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: PROMPT, output: null, outputDisplay: null, usage: USAGE });
  }
  assert.equal(cutRecorded?.call.output, long.slice(0, PREVIEW_SOURCE_CHARS));
  assert.equal(cutLive?.call.output, long.slice(0, PREVIEW_SOURCE_CHARS));
});

test('a response that is a complete JSON object of strings reads as its strings one to a line in key order beside the raw output, recorded or live, with the display cut after the strings are decoded', { skip }, () => {
  const { source, start, call } = sealOf({ stream: answer('{"1":"alpha","2":"beta\\nline"}') });
  const [recorded] = rowsFor([...source, start, call]);
  const [live] = rowsFor([...source, start], [entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT, stream: answer('{"1":"alpha","2":"beta\\nline"}') })]);

  assert.equal(recorded?.call.output, '{"1":"alpha","2":"beta\\nline"}', 'the raw output is the response text');
  assert.equal(recorded?.call.outputDisplay, 'alpha\nbeta\nline');
  assert.equal(live?.call.outputDisplay, 'alpha\nbeta\nline', 'a live entry reads as the recorded call will');

  // Three 200-character strings: the JSON is longer than the preview limit, the decoded text is cut where the limit falls.
  const [a, b, c] = ['a', 'b', 'c'].map(letter => letter.repeat(200));
  const lengthy = sealOf({ stream: answer(JSON.stringify({ 1: a, 2: b, 3: c })) });
  const [cut] = rowsFor([...lengthy.source, lengthy.start, lengthy.call]);
  assert.equal(cut?.call.output, JSON.stringify({ 1: a, 2: b, 3: c }).slice(0, PREVIEW_SOURCE_CHARS));
  assert.equal(cut?.call.outputDisplay, `${a}\n${b}\n${'c'.repeat(PREVIEW_SOURCE_CHARS - 402)}`, 'cut after decoding, not parsed from the cut text');
});

test('a response that is no complete JSON object of strings shows as the raw output: partial, an array, other JSON, mixed or nested values and text, and one that does not assemble has no display', { skip }, () => {
  const displayOf = (text) => {
    const { source, start, call } = sealOf({ stream: answer(text) });
    return rowsFor([...source, start, call])[0]?.call;
  };
  for (const text of ['{"1":"one",', '{"1":"one","2":"tw', '["x"]', '{"a":["x"]}', '"x"', '{"1":"x","2":1}', '{"1":["x"]}', '{"1":{"a":"x"}}', 'null', 'not json', '{"1":"x"} trailing', '']) {
    assert.equal(displayOf(text)?.outputDisplay, text, JSON.stringify(text));
  }
  assert.equal(displayOf('{"1":"{\\"k\\":[\\"v\\"]}"}')?.outputDisplay, '{"k":["v"]}', 'one layer only: the string is not parsed again');
  assert.equal(displayOf('{}')?.outputDisplay, '', 'an empty object has no lines');

  const unclosed = streamOf([{ type: 'block-start', index: 0, blockType: 'image' }, USAGE_CHUNK, STOP]);
  const { source, start, call } = sealOf({ stream: unclosed });
  const [row] = rowsFor([...source, start, call]);
  assert.deepEqual([row?.call.output, row?.call.outputDisplay], [null, null]);

  const streaming = streamOf([BLOCK_START, delta('{"1":"one",')]);
  assert.equal(rowsFor([...source, start], [entryOf(start, { stream: streaming })])[0]?.call.outputDisplay, '{"1":"one",', 'a response still generating');
  const closed = streamOf([BLOCK_START, delta('{"1":"one",'), delta('"2":"two"}')]);
  assert.equal(rowsFor([...source, start], [entryOf(start, { stream: closed })])[0]?.call.outputDisplay, 'one\ntwo', 'the moment the object is complete');
});

test('the prompt is the text blocks of the C tail end to end, and the reason and the thrown message are cut to PREVIEW_SOURCE_CHARS as the prompt and the response are', { skip }, () => {
  const { source, range, start } = sealOf();
  start.data.request.messages.tail.content = [{ type: 'text', text: 'ab' }, { type: 'file', attachment: { attachmentId: 'a', name: 'f', bytes: 1 } }, { type: 'text', text: 'cd' }];
  const call = innerCall({ range, stream: answer(SUMMARIES), attempt: start.seq, thrown: 't'.repeat(PREVIEW_SOURCE_CHARS + 30) });
  const end = innerEnd({ attempt: start.seq, reason: 'r'.repeat(PREVIEW_SOURCE_CHARS + 30) });

  const [row] = rowsFor([...source, start, call, end]);

  assert.equal(row?.call.input, 'abcd');
  assert.equal(row?.call.thrown, 't'.repeat(PREVIEW_SOURCE_CHARS));
  assert.equal(row?.reason, 'r'.repeat(PREVIEW_SOURCE_CHARS));
});

test('the revision is the greatest seq of the start, call, end and carrier facts folded so far: a call, an end or a carrier moves it, an event of no concern does not', { skip }, () => {
  const { source, start, call, prune, carrier } = sealOf();
  const end = innerEnd({ attempt: start.seq });
  const noise = () => [turnStart(), assistantMessage({ text: 'a later reply' }), ignorableEvent({ type: 'plugin:other/thing', data: { v: 1 } }), userMessage({ text: 'a later ask' })];
  const revisionAfter = events => rowsFor([...source, ...events])[0]?.revision;

  assert.equal(revisionAfter([start]), start.seq);
  assert.equal(revisionAfter([start, ...noise()]), start.seq);
  assert.equal(revisionAfter([start, ...noise(), call, ...noise()]), call.seq);
  assert.equal(revisionAfter([start, call, ...noise(), end, ...noise()]), end.seq);
  assert.equal(revisionAfter([start, call, prune, ...noise(), carrier]), carrier.seq);
});

test('the projection is keyed session-watcher/inner-monitor, versioned, and starts from a new empty state each time', { skip }, () => {
  assert.equal(projection.key, 'session-watcher/inner-monitor');
  assert.equal(MONITOR_PROJECTION_KEY, projection.key);
  assert.equal(projection.stateVersion, 16, 'the version of the state that holds injected text sources');
  assert.deepEqual(projection.init(), { attempts: [], handoffs: [], lastMainUsage: null, settlementBefore: null, lastCheckpointToken: null, lastCheckpointCalls: 0, openCalls: 0, postSeal: null, verbatimSeqs: [], sessionId: null, source: { epoch: 0, headDone: false, points: [], carriers: [] } });
  assert.notEqual(projection.init(), projection.init());
});

test('an attempt record and an inner-seal carrier are the signal inputs `isMonitorInput` accepts, while a main call is folded by the projection and signals nothing', { skip }, () => {
  const { start, call, carrier } = sealOf();
  for (const event of [start, call, innerEnd({ attempt: start.seq }), carrier]) assert.equal(isMonitorInput(event), true, event.type);
  for (const event of [
    turnStart(), assistantMessage({ text: 'reply' }), userMessage({ text: 'ask' }), userMessage({ kind: 'session-watcher-load' }),
    ignorableEvent({ type: 'plugin:session-watcher/inner-mode', data: { v: 1, enabled: true } }),
  ]) assert.equal(isMonitorInput(event), false, `${event.type}: not a signal input, whether or not the projection folds it`);
});

function dispatchedStep(calls, { step = 1, text } = {}) {
  return [assistantMessage({ toolCalls: calls, step, text }), ...calls.map(({ id, ...args }) => toolCall({ ...args, callId: id, step }))];
}

const eventsOfSeal = ({ source, start, call, prune, carrier }) => [...source, start, call, prune, carrier];

function sealSteps(...steps) {
  const slots = steps.map(source => ({ seqs: source.filter(event => event.type !== 'tool/call').map(event => event.seq), text: 'step summary' }));
  const range = slots.flatMap(slot => slot.seqs);
  const start = innerAttempt({ range });
  const call = innerCall({ range, attempt: start.seq });
  const prune = compactionPrune(steps[0][0]);
  return [start, call, prune, innerSealCarrier({ sourceEventSeqs: [call.seq, prune.seq, ...range], slots })];
}

test('state warnings land on the next seal’s existing slots, using the first main request rather than the first successful retry', { skip }, async () => {
  const seal = sealOf();
  const base = eventsOfSeal(seal);
  const git = { id: 'git', name: 'bash', arguments: '{"command":"git status --short && git log -1 --oneline"}' };
  const list = { id: 'agents', name: 'list_agents' };
  const todo = { id: 'todo', name: 'todo_write', arguments: '{"todos":[{"content":"continue","status":"in_progress"}]}' };
  const read = { id: 'read', name: 'read' };
  const rowsAfter = async tail => {
    const { access, id, reads } = detailsOver([...base, ...tail]);
    const { attempts } = await access.rows(id);
    assert.deepEqual(reads, [], 'listing warnings needs no detail or full-log read');
    return attempts;
  };
  const only = dispatchedStep([git], { text: 'Checking.' });
  const failed = attempt({ finish: { kind: 'error' } });
  for (const [lead, step, expected] of [
    [[], only, ['state-check']],
    [[], dispatchedStep([read, list, todo]), ['state-mixed', 'state-write']],
    [[], dispatchedStep([{ id: 'cwd', name: 'working_directory', arguments: '{"cd":"src"}' }]), ['state-write']],
    [[failed], dispatchedStep([git]), undefined],
    [[], dispatchedStep([{ ...git, arguments: '{"command":"git status && git add ."}' }]), undefined],
    [[assistantMessage({ text: 'First.' })], dispatchedStep([git], { step: 2 }), undefined],
    [[], only.slice(0, 1), undefined],
  ]) {
    const [previous] = await rowsAfter([...lead, ...step]);
    assert.equal(previous.slotWarnings, undefined, 'an unsealed call does not warn on the previous parent');
    assert.equal(previous.marks, undefined, 'the list no longer exposes standalone call rows');
    const [old, next] = await rowsAfter([...lead, ...step, ...sealSteps(step)]);
    assert.deepEqual([old.slotWarnings, next.slotWarnings], [undefined, expected === undefined ? undefined : { [step[0].seq]: expected }]);
  }
});

test('recall warnings follow the slot that seals the call, not the prior seal or the recall target', { skip }, async () => {
  const oldMessage = userMessage({ text: 'older epoch' });
  const oldHandoff = loadPayload();
  const old = sealOf();
  const checkpoint = compactCheckpoint({ startSeq: oldMessage.seq, endSeq: old.carrier.seq });
  const first = sealOf();
  const injected = first.source[0].seq;
  first.carrier.data.source.verbatimSeqs = [injected];
  const later = sealOf();
  later.carrier.data.source.verbatimSeqs = [later.source[0].seq];
  const legacy = sealOf();
  const recall = (id, seq, extra = {}) => ({ id, name: 'sw_event_read', arguments: JSON.stringify({ seq, ...extra }) });
  const local = dispatchedStep([recall('local', injected, { session_id: 's-detail' })], { step: 2 });
  const failed = toolResult({ callId: 'local', step: 2, isError: true, text: 'read denied' });
  const direct = dispatchedStep([recall('handoff', oldHandoff.seq), recall('carrier', old.carrier.seq)], { step: 3 });
  const unmarked = dispatchedStep([
    recall('old', oldMessage.seq),
    recall('peer', injected, { session_id: 'other' }),
    recall('legacy', legacy.source[0].seq),
    recall('neighbor only', injected + 1, { before: 1 }),
  ], { step: 4 });
  const base = [
    oldMessage, oldHandoff, ...eventsOfSeal(old), checkpoint, ...eventsOfSeal(first), ...eventsOfSeal(later), ...eventsOfSeal(legacy),
    ...local, failed, ...direct, ...unmarked,
  ];
  const second = sealSteps([...local, failed], direct, unmarked);
  const boundary = compactCheckpoint({ startSeq: checkpoint.seq, endSeq: second.at(-1).seq });
  const beforeFirstSeal = dispatchedStep([recall('no owner', old.carrier.seq)], { step: 5 });
  const newEpochSeal = sealSteps(beforeFirstSeal);
  const afterBoundary = dispatchedStep([recall('previous epoch text', injected)], { step: 6 });
  const { access, id, reads } = detailsOver([...base, ...second, boundary, ...beforeFirstSeal, ...newEpochSeal, ...afterBoundary, ...sealSteps(afterBoundary)]);
  const { attempts, handoffs } = await access.rows(id);
  assert.deepEqual(reads, [], 'listing warnings needs no full-log read');
  assert.deepEqual(handoffs.map(row => row.slotWarnings), [undefined], 'the handoff target is not warned');
  assert.deepEqual(attempts.map(row => row.slotWarnings), [undefined, undefined, undefined, undefined, {
    [local[0].seq]: ['verbatim-recall'],
    [direct[0].seq]: ['handoff-recall', 'carrier-recall'],
  }, undefined, undefined], 'a later carrier does not hide an earlier carrier’s verbatim text in the same epoch');
});

test('a read by the native tool name warns the slot that seals it as the DSH tool name does, for a verbatim, a carrier and a handoff target', { skip }, async () => {
  const handoff = loadPayload();
  const first = sealOf();
  const injected = first.source[0].seq;
  first.carrier.data.source.verbatimSeqs = [injected];
  const read = (id, seq) => ({ id, name: 'session_event_read', arguments: JSON.stringify({ seq }) });
  const step = dispatchedStep([read('verbatim', injected), read('carrier', first.carrier.seq), read('handoff', handoff.seq)], { step: 2 });
  const { access, id } = detailsOver([handoff, ...eventsOfSeal(first), ...step, ...sealSteps(step)]);
  const { attempts } = await access.rows(id);
  assert.deepEqual(attempts.map(row => row.slotWarnings), [undefined, { [step[0].seq]: ['verbatim-recall', 'carrier-recall', 'handoff-recall'] }]);
});

test('an event is held in context as a carrier, a handoff payload, the load’s read message and follow-up or verbatim text of the open epoch, and not as a summarized source or anything of an earlier epoch', { skip }, () => {
  const oldHandoff = loadPayload();
  const oldReads = loadReads();
  const oldFollowUp = loadFollowUp();
  const old = sealOf();
  old.carrier.data.source.verbatimSeqs = [old.source[0].seq];
  const checkpoint = compactCheckpoint({ startSeq: oldHandoff.seq, endSeq: old.carrier.seq });
  const handoff = loadPayload();
  const reads = loadReads();
  const followUp = loadFollowUp();
  const current = sealOf();
  current.carrier.data.source.verbatimSeqs = [current.source[0].seq];
  const state = fold([oldHandoff, oldReads, oldFollowUp, ...eventsOfSeal(old), checkpoint, handoff, reads, followUp, ...eventsOfSeal(current)]);

  for (const [why, seq, held] of [
    ['the open epoch’s carrier', current.carrier.seq, true],
    ['the open epoch’s handoff payload', handoff.seq, true],
    ['the open epoch’s load read message', reads.seq, true],
    ['the open epoch’s load follow-up', followUp.seq, true],
    ['verbatim text the open epoch’s carrier holds', current.source[0].seq, true],
    ['a source the carrier summarizes', current.source[1].seq, false],
    ['an earlier epoch’s carrier', old.carrier.seq, false],
    ['an earlier epoch’s handoff payload', oldHandoff.seq, false],
    ['an earlier epoch’s load read message', oldReads.seq, false],
    ['an earlier epoch’s load follow-up', oldFollowUp.seq, false],
    ['verbatim text of an earlier epoch', old.source[0].seq, false],
  ]) assert.equal(heldInContext(state, seq), held, why);
});

test('recall warns for verbatim text sealed from a stock checkpoint’s retained tail', { skip }, async () => {
  const earlier = userMessage({ text: 'replaced prefix' });
  const keptTail = userMessage({ text: 'retained original' });
  const checkpoint = compactCheckpoint({ startSeq: earlier.seq, endSeq: earlier.seq });
  const worked = assistantMessage({ text: 'worked after the checkpoint' });
  const firstSeal = sealSteps([keptTail], [worked]);
  const carrier = firstSeal.at(-1);
  carrier.data.source.slots[0].text = 'user: retained original';
  carrier.data.source.verbatimSeqs = [keptTail.seq];
  const recall = dispatchedStep([{ id: 'kept-tail', name: 'sw_event_read', arguments: JSON.stringify({ seq: keptTail.seq }) }], { step: 2 });
  const { access, id } = detailsOver([earlier, keptTail, checkpoint, worked, ...firstSeal, ...recall, ...sealSteps(recall)]);

  const { attempts } = await access.rows(id);
  assert.deepEqual(attempts.map(row => row.slotWarnings), [undefined, { [recall[0].seq]: ['verbatim-recall'] }]);
});

// ── The main calls around a committed seal ───────────────────────────────────────────────────────────────

// DSH's token usage as an `assistant/message` carries it.
const tokens = (input, output, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });

// A seal over a turn that ends in a main call, with the main calls `after` following the carrier. `earlier` is a main call before the last one; `last` is the last one's usage (`false`: the turn has no main call), `after` a list of usages, `undefined` for a call that reported none.
function sealAround({ earlier, last, after = [] } = {}) {
  const ask = userMessage({ text: 'please work' });
  const calls = [];
  if (earlier !== undefined) calls.push(assistantMessage({ text: 'early', usage: earlier }));
  if (last !== false) calls.push(assistantMessage({ text: 'reply', ...(last === undefined ? {} : { usage: last }) }));
  const range = [ask.seq, ...calls.map(event => event.seq)];
  const start = innerAttempt({ range, tail: PROMPT });
  const call = innerCall({ range, tail: PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: start.seq });
  const prune = compactionPrune(ask);
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, prune.seq, ...range], slots: slotsOf(3) });
  const later = after.map(usage => assistantMessage({ text: 'next', ...(usage === undefined ? {} : { usage }) }));
  return { source: [ask, ...calls], start, call, prune, carrier, later, log: [ask, ...calls, start, call, prune, carrier, ...later] };
}

test('the context change of a committed seal is the first main call after its carrier less the last main call before it, which counts its own output while the later call\'s output counts for nothing', { skip }, async () => {
  const BEFORE = tokens(100, 20, 300, 40);
  // The stock before is 100+20+300+40=460, the stock after input+cacheRead+cacheWrite.
  for (const [name, after, expected] of [
    ['an increase', tokens(500, 90, 200, 10), { before: 460, after: 710, delta: 250, miss: 510 }],
    ['the same output made much larger', tokens(500, 9_000, 200, 10), { before: 460, after: 710, delta: 250, miss: 510 }],
    ['a decrease', tokens(200, 5, 200, 10), { before: 460, after: 410, delta: -50, miss: 210 }],
    ['no change', tokens(400, 0, 50, 10), { before: 460, after: 460, delta: 0, miss: 410 }],
  ]) {
    const { log, later } = sealAround({ last: BEFORE, after: [after, tokens(1, 1)] });
    const [row] = rowsFor(log);
    assert.deepEqual(row.contextChange, expected, name);
    assert.equal(row.revision, later[0].seq, `${name}: the call that fixed the after moves the revision`);
  }

  const { start, log } = sealAround({ last: BEFORE, after: [tokens(500, 90, 200, 10)] });
  const detail = await detailsOver(log).access.call('s-detail', start.seq);
  assert.deepEqual(detail?.row.contextChange, { before: 460, after: 710, delta: 250, miss: 510 }, 'the call detail carries the same change');
});

test('a committed seal before its first main call has an after that is missing and a revision the carrier\'s, and the call that comes then moves the revision once', { skip }, () => {
  const { log, carrier, later } = sealAround({ last: tokens(100, 20, 300, 40), after: [tokens(500, 90, 200, 10)] });
  const [waiting] = rowsFor(log.slice(0, log.indexOf(later[0])));
  assert.deepEqual(waiting.contextChange, { before: 460, after: null, delta: null, miss: null });
  assert.equal(waiting.revision, carrier.seq);
  assert.equal(rowsFor(log)[0].revision, later[0].seq);
});

test('the first main call after the carrier fixes the after even when it reports no usage or an invalid one, and a later call with usage does not fill it', { skip }, () => {
  for (const [name, first] of [['no usage', undefined], ['an invalid usage', { inputTokens: 'many', outputTokens: 1 }]]) {
    const { log, later } = sealAround({ last: tokens(100, 20, 300, 40), after: [first, tokens(500, 1)] });
    const [row] = rowsFor(log);
    assert.deepEqual(row.contextChange, { before: 460, after: null, delta: null, miss: null }, name);
    assert.equal(row.revision, later[0].seq, `${name}: the revision stays at the call that fixed it`);
  }
});

test('a main call the measurement reads no usage of is the first call after the carrier all the same, and its after is missing', { skip }, () => {
  // A call whose message carries no id: the reducer refuses the event whole, so the measurement has no point of it.
  const { log, later } = sealAround({ last: tokens(100, 20, 300, 40), after: [tokens(500, 90, 200, 10), tokens(600, 1)] });
  later[0].data.message.id = undefined;
  const [row] = rowsFor(log);
  assert.deepEqual(row.contextChange, { before: 460, after: null, delta: null, miss: null });
  assert.equal(row.revision, later[0].seq);
});

test('a true epoch between the carrier and the next main call leaves the seal waiting: the call of the new epoch is no post of a chain it does not belong to', { skip }, () => {
  const { log, carrier, later } = sealAround({ last: tokens(100, 20, 300, 40), after: [tokens(500, 90, 200, 10)] });
  const checkpoint = compactCheckpoint({ startSeq: carrier.seq, endSeq: carrier.seq });
  const [row] = rowsFor([...log.slice(0, log.indexOf(later[0])), checkpoint, later[0]]);
  assert.deepEqual(row.contextChange, { before: 460, after: null, delta: null, miss: null });
  assert.equal(row.revision, carrier.seq, 'no call moves the revision');
});

test('two committed seals with no main call between them share the first call after them', { skip }, () => {
  const first = sealAround({ last: tokens(100, 20, 300, 40) });
  const ask = userMessage({ text: 'ask again' });
  const startTwo = innerAttempt({ range: [ask.seq], tail: PROMPT });
  const callTwo = innerCall({ range: [ask.seq], tail: PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: startTwo.seq });
  const pruneTwo = compactionPrune(ask);
  const carrierTwo = innerSealCarrier({ sourceEventSeqs: [callTwo.seq, pruneTwo.seq, ask.seq], slots: slotsOf(1) });
  const next = assistantMessage({ text: 'next', usage: tokens(500, 90, 200, 10) });

  const rows = rowsFor([...first.log, ask, startTwo, callTwo, pruneTwo, carrierTwo, next]);
  assert.deepEqual(rows.map(row => [row.contextChange.after, row.contextChange.miss, row.revision]), [[710, 510, next.seq], [710, 510, next.seq]]);
});

test('the last main call before the attempt fixes the before, so one without usage leaves it missing and an earlier call with usage is not looked back to; a turn with no main call has none', { skip }, () => {
  const cases = [
    ['no usage', sealAround({ earlier: tokens(100, 20, 300, 40), last: undefined, after: [tokens(500, 90)] })],
    ['an invalid usage', sealAround({ earlier: tokens(100, 20, 300, 40), last: { inputTokens: 'many', outputTokens: 1 }, after: [tokens(500, 90)] })],
    ['no main call', sealAround({ last: false, after: [tokens(500, 90)] })],
  ];
  for (const [name, { log }] of cases) assert.deepEqual(rowsFor(log)[0].contextChange, { before: null, after: 500, delta: null, miss: 500 }, name);
  assert.deepEqual(rowsFor(sealAround({ earlier: tokens(1, 1), last: tokens(100, 20, 300, 40), after: [tokens(500, 90)] }).log)[0].contextChange.before, 460, 'the later of two calls');
  assert.equal(rowsFor(sealAround({ last: tokens(1, 1), after: [{ inputTokens: 5, outputTokens: 1 }] }).log)[0].contextChange.miss, 5, 'a bucket the provider did not report counts for nothing'); 
});

test('only a committed seal has a context change: one that is started, called, failed or cancelled has none whatever main calls follow', { skip }, () => {
  const { source, start, call, later } = sealAround({ last: tokens(100, 20), after: [tokens(500, 90)] });
  const failed = innerEnd({ attempt: start.seq, reason: 'x' });
  const cancelled = innerEnd({ attempt: start.seq, outcome: 'cancelled', reason: 'user' });
  for (const events of [[start], [start, call], [start, call, failed], [start, call, cancelled]]) {
    assert.equal(rowsFor([...source, ...events, ...later])[0].contextChange, null);
  }
});

test('the state keeps the last main call across the records that amend an attempt, and each seal takes its before from the call last before its own start', { skip }, () => {
  const first = sealAround({ last: tokens(100, 20, 300, 40), after: [tokens(500, 90, 200, 10)] });
  const middle = assistantMessage({ text: 'between', usage: tokens(1, 2, 3, 4) });
  const ask = userMessage({ text: 'ask again' });
  const startTwo = innerAttempt({ range: [ask.seq], tail: PROMPT });
  const callTwo = innerCall({ range: [ask.seq], tail: PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: startTwo.seq });
  const pruneTwo = compactionPrune(ask);
  const carrierTwo = innerSealCarrier({ sourceEventSeqs: [callTwo.seq, pruneTwo.seq, ask.seq], slots: slotsOf(1) });
  const final = assistantMessage({ text: 'last', usage: tokens(7, 8, 9, 10) });
  const events = [...first.log, middle, ask, startTwo, callTwo, pruneTwo, carrierTwo, final];

  const state = fold(events);
  assert.deepEqual(state.lastMainUsage, { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 });
  assert.deepEqual(state.attempts.map(attempt => attempt.before), [460, 10], 'the second seal\'s before is the call between the seals: 1+2+3+4');
  assert.deepEqual(rowsOf(state, [], kit).map(row => row.contextChange), [{ before: 460, after: 710, delta: 250, miss: 510 }, { before: 10, after: 26, delta: 16, miss: 17 }]);
});

test('an event that is no input, or a record the log does not mark ignorable, leaves the state as it was, the same reference', { skip }, () => {
  const { source, start, call } = sealOf();
  const state = fold([...source, start, call]);
  const unmarked = { ...innerEnd({ attempt: start.seq }) };
  delete unmarked.ignorable;

  for (const event of [
    turnStart(), userMessage({ text: 'ask' }), userMessage({ kind: 'session-watcher-load' }),
    ignorableEvent({ type: 'plugin:other/thing', data: { v: 1 } }), unmarked,
  ]) assert.equal(projection.apply(state, event), state, event.type);
});

// The same event with `change` made to a copy of it.
const changed = (event, change) => {
  const copy = structuredClone(event);
  change(copy);
  return copy;
};

test('a record of the wrong shape is ignored and not thrown at: the state comes back as it was', { skip }, () => {
  const { source, start, call, prune, carrier } = sealOf();
  const end = innerEnd({ attempt: start.seq });
  const state = fold([...source, start, call]);
  const malformed = [
    ['a start with no range', changed(start, e => { delete e.data.range; })],
    ['a start whose range is text', changed(start, e => { e.data.range = 'all'; })],
    ['a start whose range holds a negative seq', changed(start, e => { e.data.range.first = -1; })],
    ['a start of another version', changed(start, e => { e.data.v = 2; })],
    ['a start with no request', changed(start, e => { delete e.data.request; })],
    ['a start whose tail is not a message', changed(start, e => { e.data.request.messages.tail = 'text'; })],
    ['a start whose tail is an object that holds no message content', changed(start, e => { e.data.request.messages.tail = { role: 'user', content: 'text' }; })],
    ['a start whose tail is an empty object', changed(start, e => { e.data.request.messages.tail = {}; })],
    ['a start with no data', changed(start, e => { e.data = null; })],
    ['a call whose stream is not a list', changed(call, e => { e.data.stream = 'text'; })],
    ['a call whose stream holds a record that is none', changed(call, e => { e.data.stream = [null]; })],
    ['a call with an empty range', changed(call, e => { e.data.range = []; })],
    ['a call whose range holds text', changed(call, e => { e.data.range = ['a']; })],
    ['a call whose thrown is not a message', changed(call, e => { e.data.thrown = 'text'; })],
    ['a call of another version', changed(call, e => { e.data.v = 2; })],
    ['an end of an outcome the monitor never writes', changed(end, e => { e.data.outcome = 'weird'; })],
    ['an end with no reason', changed(end, e => { delete e.data.reason; })],
    ['an end whose attempt is text', changed(end, e => { e.data.attempt = 'x'; })],
    ['an end that names no attempt', changed(end, e => { e.data.attempt = start.seq + 1000; })],
    ['an end of another version', changed(end, e => { e.data.v = 2; })],
    ['a carrier with no slots', changed(carrier, e => { delete e.data.source.slots; })],
    ['a carrier that cites nothing', changed(carrier, e => { e.sourceEventSeqs = []; })],
    ['a carrier whose first cited seq is text', changed(carrier, e => { e.sourceEventSeqs = ['a', prune.seq]; })],
    ['a carrier that cites no call of the log', changed(carrier, e => { e.sourceEventSeqs = [call.seq + 1000, prune.seq]; })],
    ['an event with no seq', changed(end, e => { delete e.seq; })],
    ['an event whose time is not a number', changed(end, e => { e.time = 'now'; })],
  ];

  for (const [why, event] of malformed) {
    assert.doesNotThrow(() => projection.apply(state, event), why);
    const next = projection.apply(state, event);
    // The monitor makes nothing of the record. A carrier the reducer reads is the Source facts' all the same, whatever the monitor holds of it.
    assert.equal(next.attempts, state.attempts, why);
    assert.equal(next.lastMainUsage, state.lastMainUsage, why);
    if (next.source !== state.source) assert.equal(next.source.carriers.length, state.source.carriers.length + 1, why);
  }
  assert.equal(projection.apply(state, changed(start, e => { e.data.v = 2; })), state, 'a record that is no input at all is the same state');
});

test('a call whose C tail is no message still folds: the fold never reads the call\'s tail, so the row is the call the stream says whatever shape the tail has', { skip }, () => {
  const { source, start, call, prune, carrier } = sealOf();
  const expected = rowsFor([...source, start, call, prune, carrier])[0];
  const tails = {
    'content that is text': { role: 'user', content: 'text' },
    'an empty object': {},
    'a message of another role and blocks': { role: 'assistant', content: [{ type: 'unknown' }] },
  };
  for (const [why, tail] of Object.entries(tails)) {
    const odd = changed(call, (e) => { e.data.input.tail = tail; });
    const state = fold([...source, start, odd, prune, carrier]);
    assert.notEqual(state.attempts[0].call, null, `${why}: the call is folded into the state`);
    assert.deepEqual(rowsOf(state, [], kit)[0], expected, `${why}: the row is the one the call with a message tail gives`);
  }
});

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

test('the fold changes neither the state nor the event it is given, and a row shares nothing with the state it was read from', { skip }, () => {
  const { source, start, call, prune, carrier } = sealOf();
  const events = [...source, start, call, prune, carrier];
  const expected = rowsFor(events);
  const frozen = structuredClone(events).map(deepFreeze);
  const states = [deepFreeze(projection.init())];
  for (const event of frozen) states.push(deepFreeze(projection.apply(states.at(-1), event)));
  const snapshots = states.map(state => structuredClone(state));

  assert.deepEqual(rowsOf(states.at(-1), [], kit), expected, 'the same rows over frozen events and states');
  assert.deepEqual(states, snapshots, 'an earlier state is what it was');

  const [row] = rowsOf(states.at(-1), [], kit);
  row.range.first = -1;
  row.call.usage.input = -1;
  assert.deepEqual(rowsOf(states.at(-1), [], kit), expected, 'a row\'s nested values are its own');
});

// Attempts of every kind in one log: sealed, failed after a call, cancelled with no call, a call that names no attempt, and one still waiting for a terminal fact.
function mixedLog() {
  const sealed = sealOf();
  const failed = sealOf({ stream: answer('not a summary') });
  const cancelled = sealOf();
  const old = sealOf();
  const oldCall = innerCall({ range: old.range, tail: 'an older prompt', stream: answer(SUMMARIES) });
  const oldCarrier = innerSealCarrier({ sourceEventSeqs: [oldCall.seq, old.prune.seq, ...old.range], slots: slotsOf(2) });
  const waiting = sealOf();
  return [
    ...sealed.source, sealed.start, sealed.call, sealed.prune, sealed.carrier,
    ...failed.source, failed.start, failed.call, innerEnd({ attempt: failed.start.seq, reason: 'the summary text is not a JSON object' }),
    ...cancelled.source, cancelled.start, innerEnd({ attempt: cancelled.start.seq, outcome: 'cancelled', reason: 'user' }),
    ...old.source, oldCall, old.prune, oldCarrier,
    ...waiting.source, waiting.start, waiting.call,
  ];
}

test('the state is plain JSON the schema accepts: a state persisted after any prefix of the log and folded on with the rest reaches the state of folding the log whole', { skip }, () => {
  const events = mixedLog();
  const whole = fold(events);
  assert.equal(whole.attempts.length, 4);

  for (let cut = 0; cut <= events.length; cut += 1) {
    const persisted = JSON.parse(JSON.stringify(fold(events.slice(0, cut))));
    const resumed = events.slice(cut).reduce((state, event) => projection.apply(state, event), projection.stateSchema.parse(persisted));
    assert.deepEqual(resumed, whole, `persisted after ${cut} events`);
  }
});

test('the state schema accepts the states the fold reaches and refuses any other persisted value', { skip }, () => {
  const { source, start, call, carrier } = sealOf({ quote: QUOTES.inside });
  const end = innerEnd({ attempt: start.seq, reason: 'a stray end' });
  const good = fold([...source, start, call, end, carrier]);
  assert.deepEqual(projection.stateSchema.parse(structuredClone(good)), good, 'an attempt that holds every fact');
  assert.deepEqual(projection.stateSchema.parse(projection.init()), { attempts: [], handoffs: [], lastMainUsage: null, settlementBefore: null, lastCheckpointToken: null, lastCheckpointCalls: 0, openCalls: 0, postSeal: null, verbatimSeqs: [], sessionId: null, source: { epoch: 0, headDone: false, points: [], carriers: [] } });

  for (const [why, change] of [
    ['an id that is not a seq', attempt => { attempt.id = -1; }],
    ['a start time that is text', attempt => { attempt.startedAt = 'now'; }],
    ['a start time that is null, which no fold reaches', attempt => { attempt.startedAt = null; }],
    ['a range with no count', attempt => { delete attempt.range.count; }],
    ['an input that is not text', attempt => { attempt.input = 7; }],
    ['a call with no seq', attempt => { delete attempt.call.seq; }],
    ['a call whose end time is text', attempt => { attempt.call.endedAt = 'late'; }],
    ['a call whose usage lacks a bucket', attempt => { delete attempt.call.usage.cacheWrite; }],
    ['a call whose finish is a number', attempt => { attempt.call.finish = 7; }],
    ['a call whose output is a number', attempt => { attempt.call.output = 7; }],
    ['a call whose display is a number', attempt => { attempt.call.outputDisplay = 7; }],
    ['a call persisted before the display, which has none', attempt => { delete attempt.call.outputDisplay; }],
    ['an end of an outcome the fold never reaches', attempt => { attempt.end.outcome = 'weird'; }],
    ['an end with no reason', attempt => { delete attempt.end.reason; }],
    ['a carrier whose slot count is text', attempt => { attempt.carrier.slots = 'many'; }],
    ['an attempt that lacks its end', attempt => { delete attempt.end; }],
    ['a before that is text', attempt => { attempt.before = 'many'; }],
    ['an attempt that lacks its before', attempt => { delete attempt.before; }],
    ['an attempt persisted before the quote, which has none', attempt => { delete attempt.quote; }],
    ['a quote whose q is text', attempt => { attempt.quote.q = 'high'; }],
    ['a quote of a trigger the seal never takes', attempt => { attempt.quote.trigger = 'soft'; }],
    ['a quote of the retired hard trigger', attempt => { attempt.quote.trigger = 'hard'; }],
  ]) {
    const bad = structuredClone(good);
    change(bad.attempts[0]);
    assert.throws(() => projection.stateSchema.parse(bad), why);
  }
  const settled = fold([...source, start, call, carrier, assistantMessage({ text: 'next', usage: { inputTokens: 5, outputTokens: 1 } })]);
  assert.deepEqual(projection.stateSchema.parse(structuredClone(settled)), settled, 'a carrier whose post is fixed and a last main call');
  for (const [why, change] of [
    ['facts that lack', value => { delete value.source; }],
    ['an epoch that is text', value => { value.source.epoch = 'one'; }],
    ['a head flag that is text', value => { value.source.headDone = 'yes'; }],
    ['a point of a role the fold never gives', value => { value.source.points.push({ seq: 1, role: 'last' }); }],
    ['a point with no seq', value => { value.source.points.push({ role: 'head' }); }],
    ['a carrier with no post field', value => { delete value.source.carriers[0].post; }],
    ['a post with no seq', value => { value.source.carriers[0].post = { usage: null }; }],
    ['a post whose usage lacks a bucket', value => { value.source.carriers[0].post = { seq: 1, usage: { input: 1, output: 1, cacheRead: 1 } }; }],
  ]) {
    const bad = structuredClone(settled);
    change(bad);
    assert.throws(() => projection.stateSchema.parse(bad), why);
  }
  for (const lastMainUsage of [undefined, 7, { input: 1 }, { seq: 1, usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }]) {
    assert.throws(() => projection.stateSchema.parse({ ...structuredClone(good), lastMainUsage }), JSON.stringify(lastMainUsage) ?? 'undefined');
  }
  for (const value of [undefined, null, 'on', [], {}, { attempts: 'none' }, { attempts: [null] }, { attempts: [[]] }, { attempts: [] }]) {
    assert.throws(() => projection.stateSchema.parse(value), JSON.stringify(value) ?? 'undefined');
  }
});

// ── The access the channel reads the rows through ─────────────────────────────────────────────────────────

const TAIL_MESSAGE = { role: 'user', content: [{ type: 'text', text: PROMPT }] };

// What `dispatch` is handed for a request of `sessionId` whose stream reads as `stream()`.
const requestFor = (sessionId, stream) => ({
  options: { provider: 'deepseek', model: 'deepseek-v4-pro', purpose: 'inner-compaction', sessionId, messages: [TAIL_MESSAGE] },
  input: { throughSeq: 7, headerSeq: null, tail: TAIL_MESSAGE },
  stream,
});

// The access over the instances the host holds, reading the projection as the registry's handle folds it over a session's log, and a real registry of attempts in flight that appends through DSH's own record function; `reads` keeps the id of each session whose projection was read.
function accessOver(...instances) {
  const reads = [];
  const monitor = createInnerMonitor({ appendPluginRecord: sessionPackage.appendPluginRecord, publish: () => {} });
  const access = createMonitorAccess({
    sessionOf: id => instances.find(session => session.id === id),
    readMonitor: (session) => {
      reads.push(session.id);
      return session.snapshotEvents().reduce((state, event) => projection.apply(state, event), projection.init());
    },
    live: sessionId => monitor.live(sessionId),
    kit,
    readSession: async () => { throw new Error('the rows read no log'); },
    readStored: async () => undefined,
  });
  return { access, monitor, reads };
}

test('rows answers undefined for a session the host holds no instance of and stores no log of, reading nothing for it, and { attempts, handoffs } for one it holds, both empty while the session has none', { skip }, async () => {
  const held = newSession('s-held');
  const { access, reads } = accessOver(held);

  assert.equal(await access.rows('s-not-held'), undefined);
  assert.deepEqual(reads, []);
  assert.deepEqual(await access.rows(held.id), { attempts: [], handoffs: [] });
  assert.deepEqual(reads, ['s-held']);
});

test('the rows merge the attempts the projection folded from the session\'s log with the attempts in flight in the registry: generating with the response so far, validating once the call ended, failed by its end record once the entry is gone', { skip }, async () => {
  const session = newSession('s-flight');
  const { access, monitor } = accessOver(session);
  let snapshot = streamOf([BLOCK_START, delta('{"1":"one",')]);
  const attempt = monitor.begin(session, { range: [5, 6, 7], quote: QUOTES.inside });

  attempt.dispatch(requestFor(session.id, () => snapshot));
  const started = session.snapshotEvents().at(-1);
  assert.equal(started.type, INNER_ATTEMPT_RECORD_TYPE);
  const row = {
    id: started.seq, revision: started.seq, status: 'generating', startedAt: started.time, endedAt: null,
    range: { first: 5, last: 7, count: 3 }, reason: null, slots: null,
    call: { state: 'generating', endedAt: null, finish: null, thrown: null, input: PROMPT, output: '{"1":"one",', outputDisplay: '{"1":"one",', usage: null },
    contextChange: null, trigger: { q: 1.04, kappa: 1.1 }, stepN: 8, cRatio: 30, epoch: 0,
  };
  assert.deepEqual(await access.rows(session.id), { attempts: [row], handoffs: [] });

  snapshot = streamOf([BLOCK_START, delta('{"1":"one",'), delta('"2":"two"}')]);
  assert.deepEqual(await access.rows(session.id), { attempts: [{ ...row, call: { ...row.call, output: '{"1":"one","2":"two"}', outputDisplay: 'one\ntwo' } }], handoffs: [] }, 'the stream moves the response and nothing else');

  snapshot = answer(SUMMARIES);
  attempt.responded({ endedAt: CALL_ENDED_AT });
  assert.deepEqual(await access.rows(session.id), {
    attempts: [{
      ...row, status: 'validating',
      call: { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: PROMPT, output: SUMMARIES, outputDisplay: 'one\ntwo\nthree', usage: USAGE },
    }],
    handoffs: [],
  });

  attempt.failed(new Error('the summary text is not a JSON object of 3 strings keyed "1" to "3"'), { cancelled: false, cancelReason: undefined });
  const end = session.snapshotEvents().at(-1);
  assert.equal(end.type, INNER_END_RECORD_TYPE);
  assert.deepEqual(await access.rows(session.id), {
    attempts: [{
      ...row, revision: end.seq, status: 'failed', endedAt: end.time, reason: 'the summary text is not a JSON object of 3 strings keyed "1" to "3"',
      call: { state: 'absent', endedAt: null, finish: null, thrown: null, input: PROMPT, output: null, outputDisplay: null, usage: null },
    }],
    handoffs: [],
  });
});

test('a session\'s rows carry the attempts of that session alone, in flight or recorded', { skip }, async () => {
  const first = newSession('s-first');
  const second = newSession('s-second');
  const idle = newSession('s-idle');
  const { access, monitor } = accessOver(first, second, idle);
  const flying = monitor.begin(first, { range: [5, 6, 7], quote: QUOTES.inside });
  flying.dispatch(requestFor(first.id, () => []));
  const done = monitor.begin(second, { range: [8, 9], quote: QUOTES.inside });
  done.dispatch(requestFor(second.id, () => []));
  done.failed(new Error('the summary failed'), { cancelled: false, cancelReason: undefined });

  assert.deepEqual((await access.rows(first.id)).attempts.map(row => [row.id, row.status]), [[first.snapshotEvents().at(-1).seq, 'generating']]);
  assert.deepEqual((await access.rows(second.id)).attempts.map(row => [row.id, row.status]), [[second.snapshotEvents().at(-2).seq, 'failed']]);
  assert.deepEqual(await access.rows(idle.id), { attempts: [], handoffs: [] });
});

test('a failing projection read is not caught by the access: the error reaches its caller', { skip }, async () => {
  const held = newSession('s-failing');
  const access = createMonitorAccess({
    sessionOf: () => held, readMonitor: () => { throw new Error('the projection could not be read'); }, live: () => [], kit,
    readSession: async () => { throw new Error('the rows read no log'); }, readStored: async () => undefined,
  });

  await assert.rejects(access.rows(held.id), /the projection could not be read/);
});

test('a session the host holds reads its instance and its registry and never its stored log, while one it does not hold reads one snapshot of its stored log with nothing in flight: the stale entry of a released session shows no attempt generating', { skip }, async () => {
  const flying = newSession('s-flying');
  const released = newSession('s-released');
  const monitor = createInnerMonitor({ appendPluginRecord: sessionPackage.appendPluginRecord, publish: () => {} });
  monitor.begin(flying, { range: [5, 6, 7], quote: QUOTES.inside }).dispatch(requestFor(flying.id, () => streamOf([BLOCK_START, delta('{"1":"one",')])));
  monitor.begin(released, { range: [5, 6, 7], quote: QUOTES.inside }).dispatch(requestFor(released.id, () => streamOf([BLOCK_START, delta('{"1":"stale')])));
  assert.equal(monitor.live(released.id).length, 1, 'the registry still lists the released session\'s attempt');
  const storedReads = [];
  const access = createMonitorAccess({
    sessionOf: id => (id === flying.id ? flying : undefined),
    readMonitor: session => fold(session.snapshotEvents()),
    live: sessionId => monitor.live(sessionId),
    kit,
    readSession: async () => { throw new Error('a held session reads the registry\'s entry, not a log'); },
    readStored: async (sessionId) => {
      storedReads.push(sessionId);
      if (sessionId !== released.id) return undefined;
      const events = released.snapshotEvents();
      return { state: fold(events), events };
    },
  });

  const [held] = (await access.rows(flying.id)).attempts;
  assert.deepEqual([held.status, held.call.state, held.call.output], ['generating', 'generating', '{"1":"one",']);
  const detail = await access.call(flying.id, held.id);
  assert.deepEqual([detail.response.live, detail.row.status], [true, 'generating'], 'the entry\'s response as it streams');
  assert.deepEqual(storedReads, [], 'a held session never reads a stored log');

  const [cold] = (await access.rows(released.id)).attempts;
  assert.deepEqual([cold.status, cold.call.state, cold.call.output], ['unknown', 'absent', null]);
  assert.deepEqual(storedReads, [released.id]);
  assert.equal(await access.rows('s-nowhere'), undefined, 'a session that is neither held nor stored');
});

// ── The access's details ─────────────────────────────────────────────────────────────────────────────────

const TOOLS = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }];
const LONG_PROMPT = `${PROMPT} ${'x'.repeat(PREVIEW_SOURCE_CHARS + 60)}`;

// A request header event that defines `tools`, as the log keeps it ahead of the first request.
function headerOf(tools) {
  const header = requestHeader();
  return { ...header, data: { ...header.data, header: { ...header.data.header, ...(tools === undefined ? {} : { tools }) } } };
}

// A conversation of two counted steps: the header, the ask, a reply that calls `read`, the result and the pruner's replacement of it, and a last reply; the surface the call saw is the ask, the first reply, the replacement and the last reply.
// The row of the list as a call's detail carries it: every field of the row but the call's display, which only the list shows.
const detailRowOf = ({ call: { outputDisplay, ...call }, ...row }) => ({ ...row, call });

function conversation({ withTools = true, askText = 'please work', calls = [{ id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' }] } = {}) {
  const header = headerOf(withTools ? TOOLS : undefined);
  const ask = userMessage({ text: askText });
  const first = assistantMessage({ text: 'reading', toolCalls: calls, step: 1 });
  const original = toolResult({ callId: 'call-1', text: 'the whole file', step: 1 });
  const replacement = prunedResult(original, { text: 'file pruned' });
  const last = assistantMessage({ text: 'done', step: 2 });
  const range = [ask.seq, first.seq, replacement.seq, last.seq];
  const slots = [
    { seqs: [ask.seq], text: 'asked for work' },
    { seqs: [first.seq, original.seq, replacement.seq], text: 'read the file' },
    { seqs: [last.seq], text: 'finished' },
  ];
  return { header, ask, first, original, replacement, last, source: [ask, first, original, replacement, last], range, slots };
}

// The start, the call that names it, the prune and the carrier of a seal over `conv`, the carrier's B being `changes` when given; `conv.header` is not among them.
function sealedOver(conv, { tail = LONG_PROMPT, stream = answer(SUMMARIES), slots = conv.slots, changes, carrierCache, request = { headerSeq: conv.header.seq, tools: { count: TOOLS.length } } } = {}) {
  const start = innerAttempt({ range: conv.range, tail, request });
  const call = innerCall({ range: conv.range, tail, stream, endedAt: CALL_ENDED_AT, attempt: start.seq, carrierCache });
  const prune = compactionPrune(conv.ask);
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, prune.seq, ...conv.range, conv.original.seq], slots, changes });
  return { start, call, prune, carrier };
}

// The access over the log `events`: the projection's state is the fold of the whole log and `readSession` answers a copy of `read`, the whole log unless given, as the service does; `reads` keeps the id of each session read. The session the access holds has no member to read the log through, so any use of one would throw.
function detailsOver(events, { live = [], readSession, read = events } = {}) {
  const reads = [];
  const held = { id: 's-detail' };
  Object.defineProperty(held, 'surface', { get() { throw new Error('the current surface was read'); } });
  const access = createMonitorAccess({
    sessionOf: id => (id === held.id ? held : undefined),
    readMonitor: () => fold(events, held),
    live: () => live,
    kit,
    readSession: readSession ?? (async (sessionId) => {
      reads.push(sessionId);
      return { session: { id: sessionId }, inheritedEventCount: 0, events: structuredClone(read) };
    }),
    readStored: async () => undefined,
    nextTaskOf: () => null,
  });
  return { access, reads, id: held.id };
}

test('the call of a recorded attempt answers the row the list shows with the ids of its facts and its timing, from one read of the session log', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const log = [conv.header, ...conv.source, start, call, prune, carrier];
  const { access, reads, id } = detailsOver(log);

  const detail = await access.call(id, start.seq);

  assert.deepEqual(detail?.ids, { start: start.seq, call: call.seq, end: null, carrier: carrier.seq });
  assert.deepEqual(detail?.row, detailRowOf(rowsFor(log)[0]), 'the list\'s row with every field it had, the list-only display left out');
  assert.deepEqual(detail?.timing, {
    attempt: { startedAt: start.time, endedAt: carrier.time }, call: { startedAt: start.time, endedAt: CALL_ENDED_AT },
  });
  assert.deepEqual(reads, [id], 'one read of the log');
});

test('the call\'s detail carries the quote its attempt record keeps, in flight and recorded alike and over a state resumed from its JSON, and null for an attempt recorded without one, beside the B its carrier committed', { skip }, async () => {
  const conv = conversation();
  const quoted = sealedOver(conv);
  const start = innerAttempt({ range: conv.range, tail: LONG_PROMPT, request: { headerSeq: conv.header.seq, tools: { count: TOOLS.length } }, quote: QUOTES.beyond });
  const call = { ...quoted.call, data: { ...quoted.call.data, attempt: start.seq } };
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, quoted.prune.seq, ...conv.range, conv.original.seq], slots: conv.slots, changes: { paths: [{ path: '/r/a.txt', displayPath: '/r/a.txt', totalLines: 1, state: 'readable', write: [[1, 'one']] }] } });
  const log = [conv.header, ...conv.source, start, call, quoted.prune, carrier];

  const recorded = await detailsOver(log).access.call('s-detail', start.seq);
  assert.deepEqual(recorded.quote, QUOTES.beyond);
  assert.notEqual(recorded.carried, null, 'the committed B stands apart from the quote\'s estimate');
  const inFlight = detailsOver([conv.header, ...conv.source, start], { live: [entryOf(start)] });
  assert.deepEqual((await inFlight.access.call(inFlight.id, start.seq)).quote, QUOTES.beyond, 'in flight');

  for (let cut = 0; cut <= log.length; cut += 1) {
    const persisted = JSON.parse(JSON.stringify(fold(log.slice(0, cut))));
    const resumed = log.slice(cut).reduce((state, event) => projection.apply(state, event), projection.stateSchema.parse(persisted));
    assert.deepEqual(rowsOf(resumed, [], kit), rowsFor(log), `resumed after ${cut} events`);
    assert.deepEqual(resumed.attempts[0].quote, QUOTES.beyond);
  }

  const bare = sealedOver(conversation());
  const bareLog = [conv.header, ...conv.source, bare.start, bare.call, bare.prune, bare.carrier];
  const before = await detailsOver(bareLog).access.call('s-detail', bare.start.seq);
  assert.equal(before.quote, null, 'no quote is made up for an attempt recorded without one');
});

test('a quote that holds the todo estimate of an earlier seal is read as recorded beside one without it, which no field is made up for: both fold, persist, resume and answer in the call\'s detail, under the state version the monitor already had', { skip }, async () => {
  const conv = conversation();
  const quotes = [QUOTES.beyond, { ...QUOTES.inside, todoEst: 80 }];
  assert.equal(Object.hasOwn(quotes[0], 'todoEst'), false, 'the current record has no todo estimate');
  for (const quote of quotes) {
    const quoted = sealedOver(conv);
    const start = innerAttempt({ range: conv.range, tail: LONG_PROMPT, request: { headerSeq: conv.header.seq, tools: { count: TOOLS.length } }, quote });
    const call = { ...quoted.call, data: { ...quoted.call.data, attempt: start.seq } };
    const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, quoted.prune.seq, ...conv.range, conv.original.seq], slots: conv.slots });
    const log = [conv.header, ...conv.source, start, call, quoted.prune, carrier];

    assert.deepEqual((await detailsOver(log).access.call('s-detail', start.seq)).quote, quote);
    const persisted = JSON.parse(JSON.stringify(fold(log)));
    assert.deepEqual(projection.stateSchema.parse(persisted).attempts[0].quote, quote, 'a persisted state holds the quote as recorded');
    assert.deepEqual(rowsFor(log)[0].trigger, { q: quote.q, kappa: quote.kappa });
  }
});

test('the call of a committed attempt carries B, the evidence its carrier changes: the text its source renders, that text\'s fixed opening and the evidence as structure, withdrawals and removals included, read from the same one read of the log; a carrier that changes none has it null', { skip }, async () => {
  const conv = conversation();
  const changes = {
    paths: [{ path: '/r/a.txt', displayPath: '/shown/a.txt', totalLines: 9, state: 'readable', write: [[1, 'one'], [2, 'two']], withdraw: [3] }],
    removed: ['/r/gone.txt'],
    skills: [{ name: 'tdd', text: 'Test first.' }],
  };
  const W = CARRIED_WORDING;
  const sealed = sealedOver(conv, { changes });
  const log = [conv.header, ...conv.source, sealed.start, sealed.call, sealed.prune, sealed.carrier];
  const { access, id, reads } = detailsOver(log);

  const detail = await access.call(id, sealed.start.seq);

  assert.deepEqual(detail?.carried, {
    text: [carriedNote(CARRIER_TABLE), '/shown/a.txt (total lines: 9)\n1: one\n2: two', W.skill('tdd', 'Test first.')].join('\n\n'),
    note: carriedNote(CARRIER_TABLE),
    files: [{
      path: '/shown/a.txt', total: 9, state: 'readable', reason: null,
      runs: [{ offset: 1, lines: [{ number: 1, text: 'one' }, { number: 2, text: 'two' }] }],
      withdrawn: [{ first: 3, last: 3 }],
    }],
    removed: ['/r/gone.txt'],
    skills: [{ name: 'tdd', text: 'Test first.' }],
  });
  assert.deepEqual(reads, [id], 'the carrier comes from the one read of the log');

  const plain = sealedOver(conv);
  const bare = detailsOver([conv.header, ...conv.source, plain.start, plain.call, plain.prune, plain.carrier]);
  assert.equal((await bare.access.call(bare.id, plain.start.seq))?.carried, null, 'a carrier that changes no evidence');
});

test('the call of a committed attempt whose carrier only withdraws lines or removes paths still carries that evidence, with no B text: the monitor shows what the model is no longer told', { skip }, async () => {
  const conv = conversation();
  const changes = {
    paths: [{ path: '/r/a.txt', displayPath: '/shown/a.txt', withdraw: [3, 4] }],
    removed: ['/r/gone.txt'],
  };
  const sealed = sealedOver(conv, { changes });
  const { access, id } = detailsOver([conv.header, ...conv.source, sealed.start, sealed.call, sealed.prune, sealed.carrier]);

  assert.deepEqual((await access.call(id, sealed.start.seq))?.carried, {
    text: null,
    note: carriedNote(CARRIER_TABLE),
    files: [{ path: '/shown/a.txt', total: null, state: null, reason: null, runs: [], withdrawn: [{ first: 3, last: 4 }] }],
    removed: ['/r/gone.txt'],
    skills: [],
  });
});

test('the call of an attempt with no carrier, in flight or not, carries no B and the carrier is not looked for: a start, a finished call, a failed end and a registry entry', { skip }, async () => {
  const conv = conversation();
  const { start, call } = sealedOver(conv);
  const end = innerEnd({ attempt: start.seq, reason: 'the log was cut' });
  const flying = { attempt: start.seq, phase: 'generating', endedAt: null, request: start.data.request, tools: TOOLS, stream: () => answer(SUMMARIES) };
  const cases = [
    ['an attempt with only its start', [start], []],
    ['a finished call and no carrier', [start, call], []],
    ['a failed attempt', [start, call, end], []],
    ['an attempt in flight', [start], [flying]],
  ];

  for (const [why, facts, live] of cases) {
    const { access, id } = detailsOver([conv.header, ...conv.source, ...facts], { live });
    const detail = await access.call(id, start.seq);
    assert.equal(detail?.carried, null, why);
    assert.deepEqual(detail?.ids.carrier, null, why);
  }
});

test('the call of a committed attempt rejects where its carrier cannot be found or read, as the slots do: a carrier the log does not hold, one that is another event, one without its slots, and a read that rejects', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const log = [conv.header, ...conv.source, start, call, prune, carrier];
  const noSlots = { ...carrier, data: { ...carrier.data, source: { ...carrier.data.source, slots: undefined } } };

  for (const [why, events] of [
    ['a carrier the log does not hold', log.filter(event => event.seq !== carrier.seq)],
    ['a carrier that is another event', log.map(event => (event.seq === carrier.seq ? { ...userMessage({ text: 'plain' }), seq: carrier.seq } : event))],
    ['a carrier without its slots', log.map(event => (event.seq === carrier.seq ? noSlots : event))],
  ]) {
    const { access, id } = detailsOver(log, { read: events });
    await assert.rejects(access.call(id, start.seq), /inner-seal carrier at seq/, why);
  }

  const refusing = detailsOver(log, { readSession: async () => { throw new Error('the log could not be read'); } });
  await assert.rejects(refusing.access.call(refusing.id, start.seq), /the log could not be read/);
});

test('the details carry no list display: a recorded or live call\'s row has every field of the list\'s row but the call\'s outputDisplay, a slot\'s detail has no inputDisplay, and nothing the details held before is cut', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv, { stream: answer('{"1":"alpha","2":"beta"}') });
  const log = [conv.header, ...conv.source, start, call, prune, carrier];
  const { access, id } = detailsOver(log);
  const listed = rowsFor(log)[0];
  assert.equal(listed.call.outputDisplay, 'alpha\nbeta', 'the list has the display');

  const recorded = await access.call(id, start.seq);
  assert.equal('outputDisplay' in recorded.row.call, false);
  assert.deepEqual(Object.keys(recorded.row.call).sort(), ['endedAt', 'finish', 'input', 'output', 'state', 'thrown', 'usage']);
  assert.deepEqual(recorded.row, { ...listed, call: { state: 'received', endedAt: CALL_ENDED_AT, finish: 'stop', thrown: null, input: LONG_PROMPT.slice(0, PREVIEW_SOURCE_CHARS), output: '{"1":"alpha","2":"beta"}', usage: USAGE } });
  assert.deepEqual(recorded.response.blocks, [{ type: 'text', text: '{"1":"alpha","2":"beta"}' }]);

  const lengthyText = JSON.stringify({ 1: 'a'.repeat(300), 2: 'b'.repeat(300) });
  const lengthy = answer(lengthyText);
  const liveEntry = entryOf(start, { phase: 'validating', endedAt: CALL_ENDED_AT, stream: lengthy });
  const live = await detailsOver([conv.header, ...conv.source, start], { live: [liveEntry] }).access.call('s-detail', start.seq);
  assert.equal('outputDisplay' in live.row.call, false);
  assert.equal(live.row.call.output, lengthyText.slice(0, PREVIEW_SOURCE_CHARS), 'the output is the list\'s cut text as before');
  assert.equal(live.response.blocks[0].text, lengthyText, 'the response keeps the whole text');

  const slot = await access.slot(id, start.seq, conv.first.seq);
  assert.equal('inputDisplay' in slot, false);
});

test('the request of a recorded attempt is the start record\'s display with the C tail in full and, beside the count of tools it sent, their definitions from the request header it names', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const detail = await access.call(id, start.seq);

  assert.deepEqual(detail?.request, { ...start.data.request, tools: { count: 1, definitions: TOOLS } });
  assert.equal(detail?.request.messages.tail.content[0].text, LONG_PROMPT, 'the tail is not cut to the row\'s preview');
  assert.ok(LONG_PROMPT.length > PREVIEW_SOURCE_CHARS);
});

test('a request that sent no tools shows the display as recorded, and one whose tool definitions cannot be found shows its count with no definitions and the reason, a header missing from the log being no read failure', { skip }, async () => {
  const bare = conversation({ withTools: false });
  const barely = sealedOver(bare, { request: { headerSeq: bare.header.seq } });
  const none = detailsOver([bare.header, ...bare.source, barely.start, barely.call, barely.prune, barely.carrier]);
  assert.deepEqual((await none.access.call(none.id, barely.start.seq))?.request, barely.start.data.request, 'no tools key where the request sent none');

  const conv = conversation();
  const cases = [
    ['a header seq the log lacks', { headerSeq: 9999, tools: { count: 2 } }, /seq 9999/],
    ['a header seq of an event that is no request header', { headerSeq: conv.ask.seq, tools: { count: 2 } }, new RegExp(`seq ${conv.ask.seq}\\b`)],
    ['no header seq', { headerSeq: null, tools: { count: 2 } }, /no request header/],
    ['a header that defines no tools', { headerSeq: bare.header.seq, tools: { count: 2 } }, new RegExp(`seq ${bare.header.seq}\\b`)],
  ];
  for (const [why, request, reason] of cases) {
    const { start, call, prune, carrier } = sealedOver(conv, { request });
    const { access, id } = detailsOver([conv.header, bare.header, ...conv.source, start, call, prune, carrier]);

    const detail = await access.call(id, start.seq);

    assert.deepEqual({ ...detail?.request.tools, reason: undefined }, { count: 2, definitions: null, reason: undefined }, why);
    assert.match(detail?.request.tools.reason, reason, why);
    assert.deepEqual({ ...detail?.request, tools: undefined }, { ...start.data.request, tools: undefined }, `${why}: the rest of the display is as recorded`);
  }
});

// The log of a committed attempt over `conv` whose call recorded `stream`.
function committedLog(conv, stream, options = {}) {
  const { start, call, prune, carrier } = sealedOver(conv, { stream, ...options });
  return { start, call, prune, carrier, log: [conv.header, ...conv.source, start, call, prune, carrier] };
}

test('the response of a recorded call is its compact stream as recorded, the blocks the assembler reads from it, its finish chunk, the time of its first record and the usage both as the reducer folds it and as streamed', { skip }, async () => {
  const { start, call, log } = committedLog(conversation(), answer(SUMMARIES));
  const { access, id } = detailsOver(log);

  const detail = await access.call(id, start.seq);

  assert.deepEqual(detail?.response, {
    live: false, blocks: [{ type: 'text', text: SUMMARIES }], error: null, stream: call.data.stream, finish: STOP, firstAt: 1_700_000_000_000,
  });
  assert.deepEqual(detail?.usage, { folded: USAGE, raw: USAGE_CHUNK });
});

test('a response the assembler cannot read keeps its stream, finish and usage and shows the error instead of blocks, one that streamed a tool call shows the call as data, and a stream with no usage chunk folds to none', { skip }, async () => {
  const unclosed = streamOf([{ type: 'block-start', index: 0, blockType: 'image' }, USAGE_CHUNK, STOP]);
  const toolChunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-9', name: 'read', argumentsDelta: '{"file_path":"a.js"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-9', name: 'read', arguments: '{"file_path":"a.js"}' } },
  ];
  const calling = streamOf([...toolChunks, { type: 'finish', reason: { kind: 'tool-calls' } }]);
  const truncated = streamOf([...toolChunks, { type: 'finish', reason: { kind: 'max-tokens' } }]);
  const quiet = streamOf([...textChunks(SUMMARIES), STOP]);

  const read = async (stream) => {
    const { start, log } = committedLog(conversation(), stream);
    const { access, id } = detailsOver(log);
    return access.call(id, start.seq);
  };
  const broken = await read(unclosed);
  assert.equal(broken?.response.blocks, null);
  assert.match(broken?.response.error, /incomplete block/);
  assert.deepEqual([broken?.response.stream, broken?.response.finish, broken?.usage], [unclosed, STOP, { folded: USAGE, raw: USAGE_CHUNK }]);

  const tool = await read(calling);
  assert.deepEqual(tool?.response.blocks, [{ type: 'tool-call', id: 'call-9', name: 'read', arguments: '{"file_path":"a.js"}' }]);
  assert.equal(tool?.response.error, null);

  const cut = await read(truncated);
  assert.deepEqual(cut?.response.blocks, [], 'the assembler drops the call of a response cut at its token limit');
  assert.deepEqual(cut?.response.stream, truncated, 'while the stream as recorded keeps it');
  assert.equal(cut?.response.finish.reason.kind, 'max-tokens');

  const unreported = await read(quiet);
  assert.deepEqual(unreported?.usage, { folded: null, raw: null });
});

test('the request of an attempt with a start record is the start\'s display alone: nothing of its call record\'s selection or tail is merged in', { skip }, async () => {
  const conv = conversation();
  const { start } = sealedOver(conv, { tail: 'the start\'s prompt' });
  const call = innerCall({ range: conv.range, tail: 'the call\'s prompt', stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: start.seq });
  call.data.selection = { provider: 'another', model: 'another-model', reasoningEffort: 'low' };
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call]);

  const detail = await access.call(id, start.seq);

  assert.deepEqual(detail?.request, { ...start.data.request, tools: { count: 1, definitions: TOOLS } });
  assert.equal(detail?.request.messages.tail.content[0].text, 'the start\'s prompt');
  assert.equal('selection' in detail.request, false);
});

test('the call of an attempt the monitor holds none of rejects, a call record naming none included, and its carrier opens no attempt', { skip }, async () => {
  const conv = conversation();
  // A seal from before the monitor: the call alone, with neither `attempt` nor `endedAt`.
  const old = innerCall({ range: conv.range, tail: LONG_PROMPT, stream: answer(SUMMARIES) });
  const prune = compactionPrune(conv.ask);
  const carrier = innerSealCarrier({ sourceEventSeqs: [old.seq, prune.seq, ...conv.range, conv.original.seq], slots: conv.slots });
  const { access, id } = detailsOver([conv.header, ...conv.source, old, prune, carrier]);

  assert.deepEqual((await access.rows(id)).attempts, []);
  await assert.rejects(access.call(id, old.seq), /the inner monitor holds no attempt/);
});

test('an attempt with only its start, or with its start and a failed end and no call, still shows the request the start recorded and answers no response and no usage', { skip }, async () => {
  const conv = conversation();
  const { start } = sealedOver(conv);
  const end = innerEnd({ attempt: start.seq, reason: 'no adapter for this route' });

  const waiting = detailsOver([conv.header, ...conv.source, start]);
  const unknown = await waiting.access.call(waiting.id, start.seq);
  const refused = detailsOver([conv.header, ...conv.source, start, end]);
  const failed = await refused.access.call(refused.id, start.seq);

  for (const detail of [unknown, failed]) {
    assert.deepEqual(detail?.request, { ...start.data.request, tools: { count: 1, definitions: TOOLS } });
    assert.equal(detail?.response, null);
    assert.equal(detail?.usage, null);
    assert.equal(detail?.row.call.state, 'absent');
  }
  assert.deepEqual([unknown?.row.status, unknown?.ids.end, unknown?.timing.attempt.endedAt], ['unknown', null, null]);

  // An attempt that stopped after its call was recorded is unknown all the same, and its call is there to read.
  const call = innerCall({ range: conv.range, tail: LONG_PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: start.seq });
  const stopped = detailsOver([conv.header, ...conv.source, start, call]);
  const recorded = await stopped.access.call(stopped.id, start.seq);
  assert.deepEqual([recorded?.row.status, recorded?.row.call.state, recorded?.response.live, recorded?.response.blocks], ['unknown', 'received', false, [{ type: 'text', text: SUMMARIES }]]);
  assert.deepEqual(recorded?.ids, { start: start.seq, call: call.seq, end: null, carrier: null });
  assert.deepEqual([failed?.row.status, failed?.row.reason, failed?.ids.end, failed?.timing.attempt.endedAt], ['failed', 'no adapter for this route', end.seq, end.time]);
});

test('the row of a call carries the whole failure text where the list\'s row carries a preview: the end record\'s reason and the call record\'s thrown message, in a call whose finish was observed as in one whose was not', { skip }, async () => {
  const reason = `inner seal of session s failed: ${'r'.repeat(PREVIEW_SOURCE_CHARS + 80)}`;
  const thrown = `the connection reset: ${'t'.repeat(PREVIEW_SOURCE_CHARS + 80)}`;
  const partial = streamOf([BLOCK_START, delta('{"1":"one"')]);
  for (const [why, stream, state, outcome] of [
    ['a stream that threw after its finish chunk', answer(SUMMARIES), 'received', 'failed'],
    ['a stream that threw before one', partial, 'error', 'cancelled'],
  ]) {
    const conv = conversation();
    const { start } = sealedOver(conv);
    const call = innerCall({ range: conv.range, tail: LONG_PROMPT, stream, endedAt: CALL_ENDED_AT, attempt: start.seq, thrown });
    const end = innerEnd({ attempt: start.seq, outcome, reason });
    const log = [conv.header, ...conv.source, start, call, end];
    const { access, id } = detailsOver(log);

    const detail = await access.call(id, start.seq);
    const [listed] = rowsFor(log);

    assert.equal(listed.reason, reason.slice(0, PREVIEW_SOURCE_CHARS), `${why}: the list shows a preview`);
    assert.equal(listed.call.thrown, thrown.slice(0, PREVIEW_SOURCE_CHARS), why);
    assert.equal(detail?.row.reason, reason, why);
    assert.equal(detail?.row.call.thrown, thrown, why);
    assert.deepEqual({ ...detail?.row, reason: null, call: { ...detail?.row.call, thrown: null } }, { ...detailRowOf(listed), reason: null, call: { ...detailRowOf(listed).call, thrown: null } }, `${why}: the rest of the row is the list\'s`);
    assert.deepEqual([detail?.row.status, detail?.row.call.state], [outcome, state], `${why}: the transport state is the stream\'s finish alone`);
  }
});

test('the call of an attempt in flight answers its request, response and usage from the registry\'s entry and its start time from the folded start: it reads no log, asks the session for no event and samples no clock', { skip }, async (t) => {
  const conv = conversation();
  const { start } = sealedOver(conv);
  const log = [conv.header, ...conv.source, start];
  const streaming = streamOf([BLOCK_START, delta('{"1":"one",')]);
  const entry = { attempt: start.seq, phase: 'generating', endedAt: null, request: start.data.request, tools: TOOLS, stream: () => streaming };
  const { access, id } = detailsOver(log, { live: [entry], readSession: async () => { throw new Error('the log was read'); } });
  const clock = t.mock.method(Date, 'now', () => { throw new Error('the clock was sampled'); });
  let generating;
  let validating;
  try {
    generating = await access.call(id, start.seq);
    entry.phase = 'validating';
    entry.endedAt = CALL_ENDED_AT;
    entry.stream = () => answer(SUMMARIES);
    validating = await access.call(id, start.seq);
  } finally {
    clock.mock.restore();
  }

  assert.deepEqual(generating?.request, { ...start.data.request, tools: { count: 1, definitions: TOOLS } });
  assert.deepEqual(generating?.response, {
    live: true, blocks: [{ type: 'text', text: '{"1":"one",' }], error: null, stream: streaming, finish: null, firstAt: 1_700_000_000_000,
  });
  assert.deepEqual(generating?.usage, { folded: null, raw: null });
  assert.deepEqual(generating?.ids, { start: start.seq, call: null, end: null, carrier: null });
  assert.deepEqual(generating?.timing, { attempt: { startedAt: start.time, endedAt: null }, call: { startedAt: start.time, endedAt: null } });
  assert.deepEqual([generating?.row.status, generating?.row.call.state, generating?.row.call.output], ['generating', 'generating', '{"1":"one",']);

  assert.equal(validating?.response.live, true);
  assert.deepEqual(validating?.response.blocks, [{ type: 'text', text: SUMMARIES }]);
  assert.deepEqual(validating?.usage, { folded: USAGE, raw: USAGE_CHUNK });
  assert.deepEqual(validating?.timing, { attempt: { startedAt: start.time, endedAt: null }, call: { startedAt: start.time, endedAt: CALL_ENDED_AT } });
  assert.deepEqual([validating?.row.status, validating?.row.call.state], ['validating', 'received']);
});

test('a session the host holds no instance of answers undefined without a read, and an address or a fact the monitor cannot find, or a read that fails, rejects instead: an attempt it holds none of, a read that rejects, and a start, call or end record the log does not hold at its seq', { skip }, async () => {
  const conv = conversation();
  const { start } = sealedOver(conv);
  const call = innerCall({ range: conv.range, tail: LONG_PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: start.seq });
  const end = innerEnd({ attempt: start.seq, reason: 'the summary text is not a JSON object of 3 strings keyed "1" to "3"' });
  const log = [conv.header, ...conv.source, start, call, end];
  const without = seq => log.filter(event => event.seq !== seq);
  const other = (seq, event) => log.map(each => (each.seq === seq ? { ...event, seq } : each));

  const held = detailsOver(log);
  assert.equal(await held.access.call('s-not-held', start.seq), undefined);
  assert.deepEqual(held.reads, []);
  await assert.rejects(held.access.call(held.id, start.seq + 1000), /no attempt/);
  assert.deepEqual(held.reads, [], 'an address the monitor holds nothing at is refused before the log is read');
  assert.equal((await held.access.call(held.id, start.seq))?.row.status, 'failed');

  const refusing = detailsOver(log, { readSession: async () => { throw new Error('the log could not be read'); } });
  await assert.rejects(refusing.access.call(refusing.id, start.seq), /the log could not be read/);
  for (const [why, events, pattern] of [
    ['the start record', without(start.seq), /inner-attempt record at seq/],
    ['the call record', without(call.seq), /inner-call record at seq/],
    ['the end record', without(end.seq), /inner-end record at seq/],
    ['a start record that is another event', other(start.seq, userMessage({ text: 'not a record' })), /inner-attempt record at seq/],
  ]) {
    const { access, id } = detailsOver(log, { read: events });
    await assert.rejects(access.call(id, start.seq), pattern, why);
  }
});

const NOT_COMMITTED = { kind: 'not_committed' };

test('slots and slot answer the closed not_committed outcome for an attempt without a carrier, whatever else it holds, and read no log for it: unknown, in flight, failed and cancelled, a finished call with a valid-looking notes object among them', { skip }, async () => {
  const conv = conversation();
  const { start, call } = sealedOver(conv);
  const end = innerEnd({ attempt: start.seq, reason: 'the log was cut' });
  const cancelled = innerEnd({ attempt: start.seq, outcome: 'cancelled', reason: 'user' });
  const flying = (phase, endedAt = null) => ({
    attempt: start.seq, phase, endedAt, request: start.data.request, tools: TOOLS, stream: () => answer(SUMMARIES),
  });
  const cases = [
    ['an attempt with only its start', [start], []],
    ['a finished call of three summaries and no carrier', [start, call], []],
    ['an attempt generating', [start], [flying('generating')]],
    ['an attempt validating beside its recorded call', [start, call], [flying('validating', CALL_ENDED_AT)]],
    ['a failed attempt', [start, call, end], []],
    ['a cancelled attempt with no call', [start, cancelled], []],
  ];

  for (const [why, facts, live] of cases) {
    const { access, id, reads } = detailsOver([conv.header, ...conv.source, ...facts], { live });
    assert.deepEqual(await access.slots(id, start.seq), NOT_COMMITTED, why);
    assert.deepEqual(await access.slot(id, start.seq, conv.ask.seq), NOT_COMMITTED, why);
    assert.deepEqual(reads, [], `${why}: the log was not read`);
  }
});

test('slots and slot answer undefined for a session the host holds no instance of and reject for an attempt the monitor holds none of, before any read', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id, reads } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  assert.equal(await access.slots('s-not-held', start.seq), undefined);
  assert.equal(await access.slot('s-not-held', start.seq, conv.ask.seq), undefined);
  await assert.rejects(access.slots(id, start.seq + 1000), /no attempt/);
  await assert.rejects(access.slot(id, start.seq + 1000, conv.ask.seq), /no attempt/);
  assert.deepEqual(reads, []);
});

test('the slots of a committed attempt are the carrier\'s, each keyed by its first seq with the counted step among its events, a preview of the sources the call saw, its C string and the source of its first event, and nothing else', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id, reads } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const listed = await access.slots(id, start.seq);

  assert.deepEqual(listed, {
    slots: [
      { key: conv.ask.seq, turn: null, step: null, source: { type: 'user/message', kind: 'user', category: 'user' }, input: 'please work', inputDisplay: 'please work', output: 'asked for work' },
      { key: conv.first.seq, turn: 1, step: 1, source: { type: 'assistant/message', kind: 'model', category: 'assistant' }, input: 'reading\nread {"file_path":"a.js"}\nfile pruned', inputDisplay: 'reading\nread\nfile pruned', output: 'read the file' },
      { key: conv.last.seq, turn: 1, step: 2, source: { type: 'assistant/message', kind: 'model', category: 'assistant' }, input: 'done', inputDisplay: 'done', output: 'finished' },
    ],
  });
  assert.deepEqual(reads, [id], 'one read');
});

test('a slot lists its source beside a display of it that names each structured tool call as the bucket does, by its name and detail, and the raw input stays as it was', { skip }, async () => {
  const calls = [
    { id: 'c-1', name: 'bash', arguments: JSON.stringify({ command: 'git -C /repo status' }) },
    { id: 'c-2', name: 'bash', arguments: JSON.stringify({ command: 'wc -l a.md' }) },
    { id: 'c-3', name: 'bash', arguments: JSON.stringify({ command: 'ssh alice@10.0.0.1' }) },
    { id: 'c-4', name: 'bash', arguments: JSON.stringify({ command: 'cat /Users/alice/notes.txt' }) },
    { id: 'c-5', name: 'mcp__figma__get_node', arguments: '{"id":"1:2"}' },
    { id: 'c-6', name: 'read', arguments: '{"file_path":"a.js"}' },
    { id: 'c-7', name: 'read', arguments: '' },
    { id: 'c-8', name: 'read', arguments: '{"file_path"' },
    { id: 'c-9', name: 'bash', arguments: '{}' },
    { id: 'c-10', name: 'bash', arguments: 'null' },
    { id: 'c-11', name: 'bash', arguments: '"git status"' },
    { id: 'c-12', name: 'subagent', arguments: '{"prompt":"go"}' },
    { id: 'c-13', name: undefined, arguments: '{"a":1}' },
  ];
  const conv = conversation({ calls });
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const { slots } = await access.slots(id, start.seq);

  assert.equal(slots[1].inputDisplay, [
    'reading', 'git status', 'wc a.md', 'ssh ***@<ip>', 'cat ~/notes.txt', 'figma__get_node', 'read', 'read', 'read',
    '(bash)', '(bash)', '(bash)', 'subagent', '{"a":1}', 'file pruned',
  ].join('\n'));
  assert.equal(slots[1].input.startsWith('reading\nbash {"command":"git -C /repo status"}\nbash {"command":"wc -l a.md"}'), true, 'the input is the raw name and arguments');
  assert.deepEqual([slots[0].inputDisplay, slots[2].inputDisplay], ['please work', 'done'], 'a source with no tool call displays as its input');
});

test('the display of a slot\'s source is cut at PREVIEW_SOURCE_CHARS after the calls are named, the way its input is cut', { skip }, async () => {
  const calls = Array.from({ length: 150 }, (_, index) => ({ id: `c-${index}`, name: 'read', arguments: JSON.stringify({ file_path: `/w/file-${index}.js` }) }));
  const conv = conversation({ calls });
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const { slots } = await access.slots(id, start.seq);

  assert.equal(slots[1].inputDisplay, `reading\n${Array(150).fill('read').join('\n')}\nfile pruned`.slice(0, PREVIEW_SOURCE_CHARS));
  assert.equal(slots[1].input.length, PREVIEW_SOURCE_CHARS);
});

test('an empty C string is a valid slot and no failure, listed with the empty output; the list keeps a long source cut at PREVIEW_SOURCE_CHARS and a long C string whole', { skip }, async () => {
  const conv = conversation({ askText: 'q'.repeat(PREVIEW_SOURCE_CHARS + 20) });
  const long = 'z'.repeat(PREVIEW_SOURCE_CHARS + 20);
  const slots = [{ seqs: [conv.ask.seq], text: '' }, { seqs: [conv.last.seq], text: long }];
  const { start, call, prune, carrier } = sealedOver(conv, { slots });
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const { slots: listed } = await access.slots(id, start.seq);

  assert.deepEqual(listed.map(({ output }) => output), ['', long]);
  assert.equal(listed[0].input, 'q'.repeat(PREVIEW_SOURCE_CHARS));
  assert.equal(listed[0].inputDisplay, 'q'.repeat(PREVIEW_SOURCE_CHARS));
});

test('a slot\'s detail is its C string in full and its source events in the slot\'s order, the sources the call saw visible by the call record\'s range and the original a pruner replaced, which the carrier cites all the same, not', { skip }, async () => {
  const conv = conversation();
  const long = 'c'.repeat(PREVIEW_SOURCE_CHARS + 40);
  const slots = [conv.slots[0], { ...conv.slots[1], text: long }, conv.slots[2]];
  const { start, call, prune, carrier } = sealedOver(conv, { slots });
  assert.ok(carrier.sourceEventSeqs.includes(conv.original.seq), 'the carrier cites the original');
  const { access, id, reads } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const detail = await access.slot(id, start.seq, conv.first.seq);

  assert.deepEqual([detail?.key, detail?.seqs, detail?.turn, detail?.step, detail?.c], [conv.first.seq, conv.slots[1].seqs, 1, 1, long]);
  assert.deepEqual(detail?.events.map(({ seq, type, visible }) => [seq, type, visible]), [
    [conv.first.seq, 'assistant/message', true], [conv.original.seq, 'tool/result', false], [conv.replacement.seq, 'tool/result', true],
  ]);
  assert.deepEqual(detail?.events[0].blocks, [
    { type: 'text', text: 'reading' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"a.js"}' },
  ]);
  assert.deepEqual(detail?.events[1].blocks, [{ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: 'the whole file' }] }]);
  assert.deepEqual(detail?.events[2].blocks, [{ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: 'file pruned' }] }]);
  assert.deepEqual(detail?.events.map(event => event.raw), [conv.first, conv.original, conv.replacement]);
  assert.deepEqual(reads, [id], 'one read');
});

test('a slot\'s number is its place among the carrier\'s slots, counted from one, and not its key', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const details = await Promise.all([conv.ask, conv.first, conv.last].map(event => access.slot(id, start.seq, event.seq)));

  assert.deepEqual(details.map(detail => [detail?.key, detail?.number]), [[conv.ask.seq, 1], [conv.first.seq, 2], [conv.last.seq, 3]]);
});

test('a result a pruner replaced more than once shows the original the slot names and the final replacement, visible by the range alone, with no node in between, and only the replacement in the slot\'s input preview', { skip }, async () => {
  const conv = conversation();
  const once = prunedResult(conv.original, { text: 'pruned once' });
  const twice = prunedResult(once, { text: 'pruned twice' });
  // The surface the call saw held the second replacement alone; the slot names the original and that replacement, as the seal's slots do.
  const range = [conv.ask.seq, conv.first.seq, twice.seq, conv.last.seq];
  const slots = [{ seqs: [conv.first.seq, conv.original.seq, twice.seq], text: 'read the file' }];
  const start = innerAttempt({ range, tail: LONG_PROMPT, request: { headerSeq: conv.header.seq, tools: { count: 1 } } });
  const call = innerCall({ range, tail: LONG_PROMPT, stream: answer(SUMMARIES), endedAt: CALL_ENDED_AT, attempt: start.seq });
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, ...range, conv.original.seq], slots });
  const { access, id } = detailsOver([conv.header, ...conv.source, once, twice, start, call, carrier]);

  const detail = await access.slot(id, start.seq, conv.first.seq);
  const { slots: listed } = await access.slots(id, start.seq);

  assert.deepEqual(detail?.events.map(({ seq, visible }) => [seq, visible]), [[conv.first.seq, true], [conv.original.seq, false], [twice.seq, true]]);
  assert.deepEqual(detail?.events[2].blocks, [{ type: 'tool-result', callId: 'call-1', isError: false, blocks: [{ type: 'text', text: 'pruned twice' }] }]);
  assert.equal(listed[0].input, 'reading\nread {"file_path":"a.js"}\npruned twice');
});

test('an empty content node of the range is visible with no blocks and no failure, in the slot\'s detail and in its row, whose input preview is then empty', { skip }, async () => {
  const conv = conversation();
  conv.ask.data.content = [];
  const { start, call, prune, carrier } = sealedOver(conv);
  const { access, id } = detailsOver([conv.header, ...conv.source, start, call, prune, carrier]);

  const detail = await access.slot(id, start.seq, conv.ask.seq);
  const { slots } = await access.slots(id, start.seq);

  assert.deepEqual(detail?.events.map(({ seq, visible, blocks }) => [seq, visible, blocks]), [[conv.ask.seq, true, []]]);
  assert.deepEqual(detail && [detail.c, detail.turn, detail.step], ['asked for work', null, null]);
  assert.deepEqual([slots[0].input, slots[0].output], ['', 'asked for work']);
});

test('slots and slot reject where the committed facts cannot be found or read: a slot no carrier slot starts at, a carrier or call record the log does not hold, a source event it lacks and a read that rejects, a slot beside a missing source still readable', { skip }, async () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv);
  const log = [conv.header, ...conv.source, start, call, prune, carrier];
  const without = seq => log.filter(event => event.seq !== seq);

  const held = detailsOver(log);
  await assert.rejects(held.access.slot(held.id, start.seq, conv.original.seq), /holds no slot/, 'a seq inside a slot is no slot key');
  await assert.rejects(held.access.slot(held.id, start.seq, 9999), /holds no slot/);

  const refusing = detailsOver(log, { readSession: async () => { throw new Error('the log could not be read'); } });
  await assert.rejects(refusing.access.slots(refusing.id, start.seq), /the log could not be read/);
  await assert.rejects(refusing.access.slot(refusing.id, start.seq, conv.ask.seq), /the log could not be read/);

  for (const [why, events, pattern] of [
    ['the carrier', without(carrier.seq), /inner-seal carrier at seq/],
    ['the call record', without(call.seq), /inner-call record at seq/],
    ['a carrier that is another event', log.map(event => (event.seq === carrier.seq ? { ...userMessage({ text: 'plain' }), seq: carrier.seq } : event)), /inner-seal carrier at seq/],
  ]) {
    const { access, id } = detailsOver(log, { read: events });
    await assert.rejects(access.slots(id, start.seq), pattern, why);
    await assert.rejects(access.slot(id, start.seq, conv.ask.seq), pattern, why);
  }

  const lacking = detailsOver(log, { read: without(conv.original.seq) });
  await assert.rejects(lacking.access.slots(lacking.id, start.seq), /holds no event at seq/);
  await assert.rejects(lacking.access.slot(lacking.id, start.seq, conv.first.seq), /holds no event at seq/);
  assert.deepEqual((await lacking.access.slot(lacking.id, start.seq, conv.last.seq))?.events.map(event => event.seq), [conv.last.seq], 'the other slots do not need it');
});

test('the counted step of a slot is the step of a non-empty assistant message among its events and no other event\'s turn and step: a result that carries one but follows no counted reply in its slot has none', { skip }, async () => {
  const conv = conversation();
  const orphan = toolResult({ callId: 'call-9', text: 'a late result', turn: 1, step: 9 });
  const slots = [{ seqs: [orphan.seq], text: 'a result' }, ...conv.slots];
  const { start, call, prune, carrier } = sealedOver(conv, { slots });
  const { access, id } = detailsOver([conv.header, ...conv.source, orphan, start, call, prune, carrier]);

  const { slots: listed } = await access.slots(id, start.seq);
  const detail = await access.slot(id, start.seq, orphan.seq);

  assert.deepEqual(listed.slice(0, 2).map(({ key, turn, step }) => [key, turn, step]), [[orphan.seq, null, null], [conv.ask.seq, null, null]]);
  assert.deepEqual([listed[2].turn, listed[2].step], [1, 1]);
  assert.deepEqual([detail?.turn, detail?.step], [null, null]);
  assert.deepEqual(detail?.events.map(({ seq, visible }) => [seq, visible]), [[orphan.seq, false]], 'a source the range does not hold is not visible');
});

test('a slot carries the source of its first source event as the log records it, the event type beside the producer kind of its message, in the list and in the detail alike, with no further read and no claim for the slot\'s other events', { skip }, async () => {
  const conv = conversation();
  const orphan = toolResult({ callId: 'call-9', text: 'a late result', turn: 1, step: 9 });
  const injected = userMessage({ text: 'a context the harness added', kind: 'runtime-context' });
  const unsourced = userMessage({ text: 'a message without a recorded source' });
  delete unsourced.data.source;
  const slots = [{ seqs: [orphan.seq], text: 'a result' }, { seqs: [injected.seq], text: 'a context' }, { seqs: [unsourced.seq], text: 'bare' }, ...conv.slots];
  const { start, call, prune, carrier } = sealedOver(conv, { slots });
  const { access, id, reads } = detailsOver([conv.header, ...conv.source, orphan, injected, unsourced, start, call, prune, carrier]);

  const { slots: listed } = await access.slots(id, start.seq);
  const details = await Promise.all(listed.map(slot => access.slot(id, start.seq, slot.key)));

  const sources = [
    { type: 'tool/result', kind: 'tool', category: 'tool' },
    { type: 'user/message', kind: 'runtime-context', category: 'injected' },
    { type: 'user/message', kind: null, category: 'other' },
    { type: 'user/message', kind: 'user', category: 'user' },
    { type: 'assistant/message', kind: 'model', category: 'assistant' },
    { type: 'assistant/message', kind: 'model', category: 'assistant' },
  ];
  assert.deepEqual(listed.map(slot => slot.source), sources);
  assert.deepEqual(details.map(detail => detail?.source), sources, 'the detail names the same source as the list');
  assert.deepEqual(details[4]?.events.map(event => event.type), ['assistant/message', 'tool/result', 'tool/result'], 'the step slot holds events of other types, which its source does not claim');
  assert.deepEqual(reads, [id, ...listed.map(() => id)], 'the list and each detail read the log once, as before');
});

test('a call that recorded the carrier cache evidence of its request shows it in order in its row and its detail, and the evidence a record does not hold in the structure of a bounded list of results with a count, or never held, is no field of the row: the call reads as not observed', { skip }, async () => {
  const conv = conversation();
  const evidence = { results: [{ result: 'skipped', reason: 'no-native-point' }, { result: 'added' }, { result: 'native' }], omitted: 2 };
  const observed = sealedOver(conv, { carrierCache: evidence });
  const log = [conv.header, ...conv.source, observed.start, observed.call, observed.prune, observed.carrier];
  const [row] = rowsFor(log);
  assert.deepEqual(row.call.carrierCache, evidence);
  const { access, id } = detailsOver(log);
  assert.deepEqual((await access.call(id, observed.start.seq)).row.call.carrierCache, evidence);

  // A row owns its nested values: the state is the registry's.
  row.call.carrierCache.results.push({ result: 'added' });
  assert.deepEqual(rowsFor(log)[0].call.carrierCache, evidence);

  const noStructure = {
    'an earlier record that never held it': undefined,
    'a list past the bound': { results: Array.from({ length: MAX_CARRIER_EVIDENCE + 1 }, () => ({ result: 'added' })), omitted: 0 },
    'an empty list': { results: [], omitted: 0 },
    'an omitted count that is no count': { results: [{ result: 'added' }], omitted: -1 },
    'a list that is no list': { results: 'added', omitted: 0 },
    'a result with no result text': { results: [{ reason: 'no-native-point' }], omitted: 0 },
    'a result whose result is no text': { results: [{ result: 1 }], omitted: 0 },
    'a reason that is no text': { results: [{ result: 'skipped', reason: 3 }], omitted: 0 },
  };
  for (const [label, carrierCache] of Object.entries(noStructure)) {
    const seal = sealedOver(conv, { carrierCache });
    const events = [conv.header, ...conv.source, seal.start, seal.call, seal.prune, seal.carrier];
    const [shown] = rowsFor(events);
    assert.equal('carrierCache' in shown.call, false, label);
    assert.equal(shown.call.state, 'received', `${label}: the rest of the call is read as before`);
    const detail = await detailsOver(events).access.call('s-detail', seal.start.seq);
    assert.equal('carrierCache' in detail.row.call, false, label);
  }
});

test('evidence in the structure the record shell checks is shown whatever its words: a result or a reason outside the adapter\'s vocabulary, a skip with no reason, and a result with a member of its own, reach the row, the detail and the persisted state as the record holds them', { skip }, async () => {
  const conv = conversation();
  const outside = { results: [{ result: 'reused' }, { result: 'skipped', reason: 'the key was wrong' }, { result: 'skipped' }, { result: 'added', body: 'a prompt' }], omitted: 0 };
  const seal = sealedOver(conv, { carrierCache: outside });
  const log = [conv.header, ...conv.source, seal.start, seal.call, seal.prune, seal.carrier];
  assert.deepEqual(rowsFor(log)[0].call.carrierCache, outside);
  assert.deepEqual((await detailsOver(log).access.call('s-detail', seal.start.seq)).row.call.carrierCache, outside);
  const state = fold(log);
  assert.deepEqual(state.attempts[0].call.carrierCache, outside);
  assert.deepEqual(projection.stateSchema.parse(structuredClone(state)), state);
});

test('a state persisted before the evidence existed seeds a fold that reads it, and a state holding evidence in the structure the shell checks is read back as persisted while one holding any other is refused', { skip }, () => {
  const conv = conversation();
  const { start, call, prune, carrier } = sealedOver(conv, { carrierCache: { results: [{ result: 'added' }], omitted: 0 } });
  const plain = sealedOver(conv);
  const withEvidence = fold([conv.header, ...conv.source, start, call, prune, carrier]);
  const without = fold([conv.header, ...conv.source, plain.start, plain.call, plain.prune, plain.carrier]);
  assert.deepEqual(projection.stateSchema.parse(structuredClone(withEvidence)), withEvidence);
  assert.deepEqual(projection.stateSchema.parse(structuredClone(without)), without);
  const damaged = structuredClone(withEvidence);
  damaged.attempts[0].call.carrierCache = { results: [{}], omitted: 0 };
  assert.throws(() => projection.stateSchema.parse(damaged));
});
