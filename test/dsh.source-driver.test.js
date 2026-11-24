// test/dsh.source-driver.test.js — the DSH source driver: a session's snapshot and its live events as the
// HarnessFrames `SessionWatcher.applyHarnessFrame` consumes, with reducer diagnostics handed to the sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import {
  userMessage, assistantMessage, toolCall, toolResult, turnStart, turnEnd, stepStart, stepEnd, unknownEvent,
  sessionLog, innerSealCarrier,
} from './helpers/dsh-events.js';
import { createMonitorAccess } from '../dsh/src/inner-monitor-read.js';
import {
  SESSION, accessOver, clear, fold, kit, opening, pricedSeal, readCall, stepOf, tokens,
} from './helpers/dsh-settlement.js';
import { dshRig } from './helpers/attribution-fixtures.js';

const SESSION_ID = 'session-a';
const USAGE = {
  inputTokens: 5, outputTokens: 80, totalTokens: 9_725, cacheReadTokens: 9_600, cacheWriteTokens: 40,
};
const REPLAY = { transition: 'replace', sourceLocator: SESSION_ID, sourceObserved: true, captureMode: 'replay' };
const LIVE = { transition: 'append', sourceObserved: true, captureMode: 'live' };

// A driver whose sink records every diagnostics array it is handed, in call order.
function recordingDriver() {
  const reported = [];
  const driver = createDshSourceDriver({
    sessionId: SESSION_ID, onDiagnostics: diagnostics => reported.push(diagnostics),
  });
  return { driver, reported };
}

// A frame with each Observation read as its event's seq beside its type.
const coordinates = batch => batch.map(observation => [observation.sourceOrdinal, observation.type]);
const readFrame = ({ batches, ...frame }) => ({ ...frame, batches: batches.map(coordinates) });

// Each array the sink was handed, as each diagnostic's code beside the seq its message names.
const readReported = reported => reported.map(diagnostics => diagnostics.map(
  ({ code, message }) => [code, /\bseq (\d+)\b/.exec(message)?.[1]],
));

// One turn: the question, a step that reads a file and gets its result, and a step that answers.
function session() {
  const read = { id: 'call_read', name: 'read', arguments: '{"file_path":"src/parse.js"}' };
  return sessionLog([
    turnStart(),
    userMessage({ text: 'Where is parse defined?' }),
    stepStart({ step: 1 }),
    assistantMessage({ step: 1, toolCalls: [read], usage: USAGE }),
    toolCall({ step: 1, callId: read.id, name: read.name, arguments: read.arguments }),
    toolResult({ step: 1, callId: read.id, text: 'export function parse() {}' }),
    stepEnd({ step: 1 }),
    stepStart({ step: 2 }),
    assistantMessage({ step: 2, text: 'In src/parse.js.', usage: USAGE }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

// A tool result without the call id it answers, a known type out of its DSH shape.
function unpairedResult() {
  const event = toolResult({ callId: 'call_read', text: 'export function parse() {}' });
  delete event.data.message.toolCallId;
  return event;
}

// --- Snapshot ---

test('install yields one replace frame in replay mode whose locator is the session id', () => {
  const { driver, reported } = recordingDriver();
  assert.deepEqual(readFrame(driver.install(session())), {
    ...REPLAY,
    batches: [
      [[1, 'turn-boundary'], [1, 'text']],
      [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
      [[5, 'tool-result']],
      [[8, 'main-call'], [8, 'text'], [8, 'usage']],
    ],
  });
  assert.deepEqual(reported, []);
});

test('snapshot diagnostics reach the sink at install', () => {
  const unmetered = assistantMessage({ text: 'Done.', usage: { inputTokens: 3, outputTokens: null } });
  const events = sessionLog([userMessage({ text: 'Where is parse defined?' }), unpairedResult(), unmetered]);
  const { driver, reported } = recordingDriver();
  assert.deepEqual(readFrame(driver.install(events)), {
    ...REPLAY, batches: [[[0, 'turn-boundary'], [0, 'text']], [[2, 'main-call']]],
  });
  assert.deepEqual(readReported(reported), [[['shape-violation', '1'], ['shape-violation', '2']]]);
});

// --- Bootstrap queue ---

test('events fed before install are queued and drain drops those the snapshot already covers', () => {
  const events = sessionLog([
    turnStart(),
    userMessage({ text: 'Where is parse defined?' }),
    unpairedResult(),
    assistantMessage({ text: 'In src/parse.js.', usage: USAGE }),
    turnEnd(),
  ]);
  const { driver, reported } = recordingDriver();
  for (const event of events.slice(1)) assert.equal(driver.feed(event), null, event.type);
  driver.install(events.slice(0, 3));
  assert.deepEqual(driver.drain().map(readFrame), [{ ...LIVE, batches: [[[3, 'main-call'], [3, 'text'], [3, 'usage']]] }]);
  // The snapshot reports the malformed result once; its queued copy is dropped without being reduced.
  assert.deepEqual(readReported(reported), [[['shape-violation', '2']]]);
});

test('an empty snapshot covers nothing, so drain keeps a queued seq 0 event', () => {
  const [question] = sessionLog([userMessage({ text: 'Where is parse defined?' })]);
  const { driver } = recordingDriver();
  assert.equal(driver.feed(question), null);
  assert.deepEqual(readFrame(driver.install([])), { ...REPLAY, batches: [] });
  assert.deepEqual(driver.drain().map(readFrame), [{ ...LIVE, batches: [[[0, 'turn-boundary'], [0, 'text']]] }]);
});

test('drained events become one live append frame each in seq order', () => {
  const events = session();
  const { driver } = recordingDriver();
  for (const event of events.slice(2)) driver.feed(event);
  driver.install(events.slice(0, 2));
  assert.deepEqual(driver.drain().map(readFrame), [
    { ...LIVE, batches: [[[3, 'main-call'], [3, 'tool-use'], [3, 'usage']]] },
    { ...LIVE, batches: [[[5, 'tool-result']]] },
    { ...LIVE, batches: [[[8, 'main-call'], [8, 'text'], [8, 'usage']]] },
  ]);
});

test('an event fed between install and drain leaves drain in seq order behind the earlier queue', () => {
  const events = session();
  const { driver } = recordingDriver();
  for (const event of events.slice(3, 6)) driver.feed(event);
  driver.install(events.slice(0, 3));
  for (const event of events.slice(6, 9)) assert.equal(driver.feed(event), null, event.type);
  assert.deepEqual(driver.drain().map(readFrame), [
    { ...LIVE, batches: [[[3, 'main-call'], [3, 'tool-use'], [3, 'usage']]] },
    { ...LIVE, batches: [[[5, 'tool-result']]] },
    { ...LIVE, batches: [[[8, 'main-call'], [8, 'text'], [8, 'usage']]] },
  ]);
});

// --- Live events ---

test('after drain feed yields frames directly', () => {
  const events = session();
  const { driver } = recordingDriver();
  driver.install(events.slice(0, 5));
  driver.drain();
  const frames = events.slice(5).map(event => driver.feed(event));
  assert.deepEqual(frames.map(frame => frame && readFrame(frame)), [
    { ...LIVE, batches: [[[5, 'tool-result']]] },
    null,
    null,
    { ...LIVE, batches: [[[8, 'main-call'], [8, 'text'], [8, 'usage']]] },
    null,
    null,
  ]);
});

test('an event without observations yields no frame', () => {
  const events = sessionLog([
    turnStart(), stepStart(), userMessage({ text: 'Injected context.', kind: 'session-watcher' }),
    unknownEvent(), stepEnd(), turnEnd(),
  ]);
  const { driver, reported } = recordingDriver();
  for (const event of events.slice(0, 3)) driver.feed(event);
  driver.install([]);
  assert.deepEqual(driver.drain(), []);
  for (const event of events.slice(3)) assert.equal(driver.feed(event), null, event.type);
  assert.deepEqual(reported, []);
});

test('a shape violation yields no frame and its diagnostic reaches the sink', () => {
  const [queued, live] = sessionLog([unpairedResult(), unpairedResult()]);
  const { driver, reported } = recordingDriver();
  driver.feed(queued);
  driver.install([]);
  assert.deepEqual(driver.drain(), []);
  assert.deepEqual(readReported(reported), [[['shape-violation', '0']]]);
  assert.equal(driver.feed(live), null);
  assert.deepEqual(readReported(reported), [[['shape-violation', '0']], [['shape-violation', '1']]]);
  const [[{ scope, code }]] = reported;
  assert.deepEqual({ scope, code }, { scope: 'dsh-transcript-observation', code: 'shape-violation' });
});

// --- Inner seals ---

// The session's turn with a carrier after its first step that withdraws the question and that step, but for the usage of the epoch's first call.
function sealedSession() {
  const read = { id: 'call_read', name: 'read', arguments: '{"file_path":"src/parse.js"}' };
  const head = [
    turnStart(),
    userMessage({ text: 'Where is parse defined?' }),
    stepStart({ step: 1 }),
    assistantMessage({ step: 1, toolCalls: [read], usage: USAGE }),
    toolCall({ step: 1, callId: read.id, name: read.name, arguments: read.arguments }),
    toolResult({ step: 1, callId: read.id, text: 'export function parse() {}' }),
    stepEnd({ step: 1 }),
  ];
  return sessionLog([
    ...head,
    innerSealCarrier({ sourceEventSeqs: head.slice(1).map(event => event.seq) }),
    stepStart({ step: 2 }),
    assistantMessage({ step: 2, text: 'In src/parse.js.', usage: USAGE }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

const WITHDRAWN = [[[3, 'main-call'], [3, 'tool-use'], [3, 'usage']], [[5, 'tool-result']]];

test('install folds a carrier in the snapshot into its one replace frame', () => {
  const { driver, reported } = recordingDriver();
  const frame = driver.install(sealedSession());
  assert.deepEqual(readFrame(frame), { ...REPLAY, batches: [...WITHDRAWN, [[9, 'main-call'], [9, 'text'], [9, 'usage']]] });
  assert.equal(frame.batches[1][0].effectsOnly, true);
  assert.deepEqual(reported, []);
});

test('a live carrier yields a replay replace of the folded batches, and later events append live', () => {
  const events = sealedSession();
  const { driver } = recordingDriver();
  driver.install(events.slice(0, 7));
  driver.drain();
  const frames = events.slice(7).map(event => driver.feed(event));
  assert.deepEqual(frames.map(frame => frame && readFrame(frame)), [
    { ...REPLAY, batches: WITHDRAWN },
    null,
    { ...LIVE, batches: [[[9, 'main-call'], [9, 'text'], [9, 'usage']]] },
    null,
    null,
  ]);
  assert.equal(frames[0].batches[1][0].effectsOnly, true);
});

test('a carrier drained from the bootstrap queue rewinds as a live one does', () => {
  const events = sealedSession();
  const { driver } = recordingDriver();
  for (const event of events.slice(5)) driver.feed(event);
  driver.install(events.slice(0, 5));
  assert.deepEqual(driver.drain().map(readFrame), [
    { ...LIVE, batches: [[[5, 'tool-result']]] },
    { ...REPLAY, batches: WITHDRAWN },
    { ...LIVE, batches: [[[9, 'main-call'], [9, 'text'], [9, 'usage']]] },
  ]);
});

// Several seals, with the input a request carries after a carrier in front of the call it is followed by: the head, the call behind each carrier and an unsealed call.
function resealedSession() {
  const read = n => ({ id: `call_read_${n}`, name: 'read', arguments: '{"file_path":"src/parse.js"}' });
  const usage = n => ({ ...USAGE, cacheReadTokens: 1_000 * n });
  const first = [turnStart(), userMessage({ text: 'Where is parse defined?' }), assistantMessage({ step: 1, toolCalls: [read(1)], usage: usage(1) }), toolResult({ step: 1, callId: 'call_read_1', text: 'export function parse() {}' }), assistantMessage({ step: 2, text: 'Looking.', usage: usage(2) })];
  const second = [userMessage({ text: 'ctx', kind: 'runtime-context' }), assistantMessage({ step: 3, toolCalls: [read(3)], usage: usage(3) }), toolResult({ step: 3, callId: 'call_read_3', text: 'export function parse() {}' }), assistantMessage({ step: 4, text: 'Found.', usage: usage(4) })];
  const firstSeal = innerSealCarrier({ sourceEventSeqs: first.slice(2).map(event => event.seq) });
  const secondSeal = innerSealCarrier({ sourceEventSeqs: second.map(event => event.seq) });
  return sessionLog([...first, firstSeal, ...second, secondSeal, userMessage({ text: 'ctx', kind: 'runtime-context' }), assistantMessage({ step: 5, text: 'Done.', usage: usage(5) })]);
}

const cacheReadsOf = frame => frame.batches.flat().filter(observation => observation.type === 'usage').map(observation => observation.usage.cacheRead);

test('the live feed, the snapshot and the bootstrap queue of the same cut stand on the same selected usages, the head and the call behind each carrier among them', () => {
  const events = resealedSession();
  const sealAt = events.findLastIndex(event => event.data?.source?.kind === 'session-watcher-inner-seal');

  const live = recordingDriver().driver;
  live.install(events.slice(0, 3));
  live.drain();
  const frames = events.slice(3).map(event => live.feed(event));
  const cold = recordingDriver().driver.install(events);
  const queued = recordingDriver().driver;
  for (const event of events.slice(2)) queued.feed(event);
  queued.install(events.slice(0, 2));
  const drained = queued.drain();

  // The first seal's post and the head stay through the second seal, whose own range took the calls between.
  assert.deepEqual(cacheReadsOf(frames[sealAt - 3]), [1_000, 3_000]);
  assert.deepEqual(cacheReadsOf(cold), [1_000, 3_000, 5_000], 'the unsealed call after the second carrier is a point of the cut');
  assert.deepEqual(readFrame(drained.findLast(frame => frame.transition === 'replace')).batches, readFrame(frames[sealAt - 3]).batches);
  assert.deepEqual(readFrame(cold).batches, [...readFrame(frames[sealAt - 3]).batches, ...frames.slice(sealAt - 2).filter(Boolean).flatMap(frame => readFrame(frame).batches)]);
});

// --- Invariants ---

test('install twice, drain before install or a missing diagnostics sink fails the invariant', () => {
  const { driver } = recordingDriver();
  driver.install([]);
  assert.throws(() => driver.install([]), /dsh source driver invariant/);
  assert.throws(() => recordingDriver().driver.drain(), /dsh source driver invariant/);
  assert.throws(() => createDshSourceDriver({ sessionId: SESSION_ID }), /dsh source driver invariant/);
});

// --- Qualified calls ---

// A head, two calls a carrier seals, the post behind it and a call after the post, under a header that only turns the session on.
function qualifiedSession() {
  const usage = cacheReadTokens => ({ ...USAGE, cacheReadTokens });
  const head = assistantMessage({ step: 1, text: 'Head.', usage: usage(10_000) });
  const first = assistantMessage({ step: 2, text: 'First.', usage: usage(12_000) });
  const second = assistantMessage({ step: 3, text: 'Second.', usage: usage(14_000) });
  const carrier = innerSealCarrier({ sourceEventSeqs: [first.seq, second.seq] });
  const post = assistantMessage({ step: 4, text: 'Post.', usage: usage(11_000) });
  const pending = assistantMessage({ step: 5, text: 'Pending.', usage: usage(13_000) });
  return { prefix: [turnStart(), userMessage({ text: 'Work.' }), head], queued: [first, second, carrier, post, pending] };
}

test('a driver whose caller asks for qualified calls puts the count of its cut on every frame, the replace of a carrier included', () => {
  const { prefix, queued } = qualifiedSession();
  const driver = createDshSourceDriver({ sessionId: SESSION_ID, onDiagnostics: () => {}, qualifyCalls: () => true });
  driver.install(sessionLog(prefix));
  driver.drain();
  const frames = queued.map(event => driver.feed(event));
  assert.deepEqual(frames.map(frame => frame && [frame.transition, frame.qualifiedCalls]), [
    ['append', 1], ['append', 1], ['replace', 1], ['append', 2], ['append', 2],
  ]);
});

test('the count is the frame\'s own cut: frames drained from the bootstrap queue carry what they stood at, not what the queue ends at', () => {
  const { prefix, queued } = qualifiedSession();
  const events = sessionLog([...prefix, ...queued]);
  const driver = createDshSourceDriver({ sessionId: SESSION_ID, onDiagnostics: () => {}, qualifyCalls: () => true });
  for (const event of events.slice(prefix.length)) driver.feed(event);
  assert.equal(driver.install(events.slice(0, prefix.length)).qualifiedCalls, 1);
  assert.deepEqual(driver.drain().map(frame => [frame.transition, frame.qualifiedCalls]), [
    ['append', 1], ['append', 1], ['replace', 1], ['append', 2], ['append', 2],
  ]);
});

test('the install frame carries the count of the whole snapshot\'s cut', () => {
  const { prefix, queued } = qualifiedSession();
  const driver = createDshSourceDriver({ sessionId: SESSION_ID, onDiagnostics: () => {}, qualifyCalls: () => true });
  assert.equal(driver.install(sessionLog([...prefix, ...queued])).qualifiedCalls, 2);
});

test('the caller is asked when each frame is made, so a mode chosen after the install qualifies the first call behind it, and a driver asked for none puts no count on any', () => {
  const { prefix, queued } = qualifiedSession();
  let asked = false;
  const driver = createDshSourceDriver({ sessionId: SESSION_ID, onDiagnostics: () => {}, qualifyCalls: () => asked });
  assert.equal('qualifiedCalls' in driver.install(sessionLog(prefix)), false);
  driver.drain();
  assert.equal('qualifiedCalls' in driver.feed(queued[0]), false);
  asked = true;
  assert.equal(driver.feed(queued[1]).qualifiedCalls, 1);
  const { driver: plain } = recordingDriver();
  const { prefix: again, queued: more } = qualifiedSession();
  plain.install(sessionLog(again));
  plain.drain();
  assert.deepEqual(more.map(event => plain.feed(event)).filter(frame => frame !== null).map(frame => 'qualifiedCalls' in frame), [false, false, false, false, false]);
});

// ── Recall on the Source's frames ────────────────────────────────────────────
// A request that only reads back events of its own session is priced on its main-call fact, over the one judgement the monitor's settlement makes of it; the facts' identity is the request's own seq.

const recallDriver = () => createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
// Every main-call fact that states a recall, as `[seq, recall]`.
const recallsOf = batches => batches.flat().filter(observation => observation.type === 'main-call' && observation.recall !== undefined).map(observation => [observation.sourceOrdinal, observation.recall]);
const coldRecalls = events => recallsOf(recallDriver().install(events).batches);
// Every main-call fact that states what its request is, as `[seq, verdict]`.
const verdictsOf = batches => batches.flat().filter(observation => observation.type === 'main-call' && observation.verdict !== undefined).map(observation => [observation.sourceOrdinal, observation.verdict]);
const coldVerdicts = events => verdictsOf(recallDriver().install(events).batches);

// The calls a frame sequence leaves the Source holding: a replace frame replaces them and an append adds its batch.
function applied(frames) {
  let batches = [];
  for (const frame of frames) batches = frame.transition === 'replace' ? frame.batches : [...batches, ...frame.batches];
  return batches;
}

test('a request that only reads events back is priced on its own fact after the first seal, the call behind the seal net of the rebuild the seal paid, and the monitor\'s settlement judges the same requests pure', async () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const refused = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)], isError: true, answer: 'Error: already in your context' });
  const log = [...events, ...post.events, ...refused.events];

  // The seal's recorded ratio is 2, so a call of 20 uncached and 600 cached tokens costs 600 + 2·20; the call behind the seal paid its (2 − 1)·20 rebuild with the seal.
  assert.deepEqual(coldRecalls(log), [[post.request.seq, { net: 620 }], [refused.request.seq, { net: 640 }]]);

  const { recall } = await accessOver(log).currentSettlement(SESSION);
  assert.deepEqual(recall.steps.map(step => [step.seq, step.post !== undefined]), [[post.request.seq, true], [refused.request.seq, false]]);
});

test('a seal whose attempt record holds no message tail is a seal the monitor shows no attempt of, and the requests behind it are priced on no fact', async () => {
  const { ask, events, sealed } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const log = [...events, ...post.events];
  assert.deepEqual(coldRecalls(log), [[post.request.seq, { net: 620 }]]);
  assert.equal((await accessOver(log).currentSettlement(SESSION)).recall.steps.filter(step => 'usage' in step).length, 1);

  sealed.start.data.request.messages.tail = { role: 'user', content: 'not a list of blocks' };
  assert.deepEqual(coldRecalls(log), []);
  const { recall } = await accessOver(log).currentSettlement(SESSION);
  assert.deepEqual(recall?.steps.filter(step => 'usage' in step) ?? [], []);
});

test('a request that is no recall is priced on no fact: one aborted before dispatch, one never started, a mixed one, one with no tool, and a read before the first seal', async () => {
  const early = stepOf({ turn: 1, step: 0, calls: [readCall('e', 0)] });
  const { ask, events } = opening();
  const skipped = stepOf({
    turn: 2, step: 1, calls: [readCall('a', ask.seq)], isError: true, answer: 'Error: tool call aborted before dispatch',
    error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
  });
  const unstarted = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)], dispatch: false, isError: true, answer: 'Error: not started' });
  const mixed = stepOf({ turn: 2, step: 4, calls: [readCall('d', ask.seq), { id: 'e', name: 'read', arguments: JSON.stringify({ file_path: 'b.js' }) }] });
  const plain = stepOf({ turn: 2, step: 5, text: 'plain' });
  const log = [...early.events, ...events, ...skipped.events, ...unstarted.events, ...mixed.events, ...plain.events];

  assert.deepEqual(coldRecalls(log), []);
  const { recall } = await accessOver(log).currentSettlement(SESSION);
  assert.deepEqual(recall?.steps.filter(step => 'usage' in step) ?? [], []);
});

test('a request of reads the guard blocked is stated as a recall once every call has its record, the Source built live and cold alike, and no fact states it before or without one', () => {
  const { events } = opening();
  const file = id => ({ id, name: 'read', arguments: JSON.stringify({ file_path: 'a.js' }) });
  const both = stepOf({ turn: 2, step: 1, calls: [file('a'), file('b')], blocked: ['a', 'b'], isError: true, answer: 'Error: already in your context' });
  const half = stepOf({ turn: 2, step: 2, calls: [file('c'), file('d')], blocked: ['c'] });
  const log = [...events, ...both.events, ...half.events];
  // The seal's recorded ratio is 2: the call behind the seal pays 600 + 2·20 less the (2 − 1)·20 rebuild the seal paid.
  assert.deepEqual(coldRecalls(log), [[both.request.seq, { net: 620 }]]);

  const driver = recallDriver();
  const seen = [driver.install(events)];
  driver.drain();
  const held = new Map();
  for (const event of [...both.events, ...half.events]) {
    const frame = driver.feed(event);
    if (frame !== null) seen.push(frame);
    held.set(event.seq, recallsOf(applied(seen)));
  }
  assert.deepEqual(held.get(both.dispatched[1].seq), [], 'a request whose reads have no record yet is an ordinary one');
  assert.deepEqual(held.get(both.records[0].seq), [], 'one record of two leaves it so');
  assert.deepEqual(held.get(both.records[1].seq), [[both.request.seq, { net: 620 }]], 'the last record states the recall');
  assert.deepEqual(held.get(half.end.seq), [[both.request.seq, { net: 620 }]], 'a read with no record keeps its request ordinary');
  assert.deepEqual(recallsOf(applied(seen)), coldRecalls(log));
});

test('a call behind the seal that reported no usage keeps the seal\'s rebuild: its own bill is unknown and no later call is deducted in its place', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  delete post.request.data.usage;
  const later = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)] });

  assert.deepEqual(coldRecalls([...events, ...post.events, ...later.events]), [[post.request.seq, { net: null }], [later.request.seq, { net: 640 }]]);
  assert.deepEqual(coldVerdicts([...events, ...post.events, ...later.events]), [[post.request.seq, 'pure'], [later.request.seq, 'pure']], 'the call with no usage is a recall request of unknown bill all the same');
});

test('a request the reducer rejects whole has no usage in the measurement, so it keeps the seal\'s rebuild as an unknown bill whatever its raw event reports, and a call that does carry a usage is priced as before', () => {
  const { ask, events } = opening();
  const rejected = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  // The raw event reports a valid usage, but a model that is no string fails the reducer's shape check and no usage Observation is admitted.
  rejected.request.data.message.source.model = 42;
  const later = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)] });

  assert.deepEqual(coldRecalls([...events, ...rejected.events, ...later.events]), [[rejected.request.seq, { net: null }], [later.request.seq, { net: 640 }]]);
  assert.deepEqual(coldVerdicts([...events, ...rejected.events, ...later.events]), [[rejected.request.seq, 'pure'], [later.request.seq, 'pure']]);
});

test('the facts belong to the request\'s seq: a clear whose tail count the log does not bear leaves the report with no step to place it on, and the facts as they are', async () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const cleared = clear('amber-falcon', { from: ask, to: post.request });
  const log = [...events, ...post.events, ...cleared.events];
  const state = fold(log);
  state.handoffs = state.handoffs.map(handoff => ({ ...handoff, tailCalls: 2 }));
  const access = createMonitorAccess({
    sessionOf: () => ({}), readMonitor: () => state, live: () => [], kit, readSession: async () => ({ events: log }), readStored: async () => undefined, nextTaskOf: () => null,
  });

  const { recall } = await access.settlement(SESSION, cleared.payload.seq);

  assert.equal(recall.partial, true);
  assert.deepEqual(recall.steps, []);
  assert.deepEqual(coldRecalls(log), [[post.request.seq, { net: 620 }]]);
});

test('a clear starts the recall facts over: a new epoch with no seal prices nothing, whatever seal and ratio the epoch before it ended on', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const cleared = clear('amber-falcon', { from: ask, to: post.request });
  const fresh = stepOf({ turn: 3, step: 1, text: 'a fresh start' });
  const reread = stepOf({ turn: 3, step: 2, calls: [readCall('b', fresh.request.seq)] });

  // The first epoch's own request is priced on the seal it follows; the new epoch has none, so a read of its own event is an ordinary call.
  assert.deepEqual(coldRecalls([...events, ...post.events, ...cleared.events, ...fresh.events, ...reread.events]), [[post.request.seq, { net: 620 }]]);
});

test('a clear starts the recall facts over: a new epoch that is sealed counts a read of its own events and no read of the epoch before it', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const cleared = clear('amber-falcon', { from: ask, to: post.request });
  const second = stepOf({ turn: 3, step: 1, admit: ['the next task'], text: 'working', usage: tokens(100, 30, 900) });
  const sealed = pricedSeal([second.admitted[0], second.request], 1);
  const older = stepOf({ turn: 3, step: 2, calls: [readCall('c', ask.seq)] });
  const own = stepOf({ turn: 3, step: 3, calls: [readCall('d', second.request.seq)] });

  // The call behind the new seal reads the epoch before it, which no call of this one can recall, and keeps the seal's rebuild with it; the next reads an event of its own epoch and pays its whole bill.
  assert.deepEqual(
    coldRecalls([...events, ...post.events, ...cleared.events, ...second.events, ...sealed.events, ...older.events, ...own.events]),
    [[post.request.seq, { net: 620 }], [own.request.seq, { net: 640 }]],
  );
});

test('a request that may yet prove a recall is stated as one of unknown bill, and only the evidence that settles it replays the Source: the dispatch that proves it, the answer that frees it, none of an ordinary call or of a dispatch that leaves it open', () => {
  const { ask, events } = opening();
  const two = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq), readCall('b', ask.seq)] });
  const cancelled = stepOf({
    turn: 2, step: 2, calls: [readCall('c', ask.seq)], dispatch: false, isError: true, answer: 'Error: tool call aborted before dispatch',
    error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
  });
  const ordinary = stepOf({ turn: 2, step: 3, calls: [{ id: 'file', name: 'read', arguments: '{"file_path":"b.js"}' }], text: 'working' });
  const driver = recallDriver();
  const seen = [driver.install(events)];
  driver.drain();

  const fed = [...two.events, ...cancelled.events, ...ordinary.events];
  const held = new Map();
  const replays = [];
  for (const event of fed) {
    const frame = driver.feed(event);
    if (frame !== null) seen.push(frame);
    if (frame?.transition === 'replace') replays.push(event.seq);
    held.set(event.seq, recallsOf(applied(seen)));
  }
  const unknown = seq => [seq, { net: null }];
  // The call behind the seal is the first of the two, and the seal's recorded ratio is 2: 600 + 2·20 less the (2 − 1)·20 rebuild the seal paid.
  assert.deepEqual(held.get(two.request.seq), [unknown(two.request.seq)], 'the request is stated as a recall whose bill is unknown, in its own slot');
  assert.deepEqual(held.get(two.dispatched[0].seq), [unknown(two.request.seq)], 'a dispatch that leaves it open leaves the fact as it is');
  assert.deepEqual(held.get(two.dispatched[1].seq), [[two.request.seq, { net: 620 }]]);
  assert.deepEqual(held.get(cancelled.request.seq), [[two.request.seq, { net: 620 }], unknown(cancelled.request.seq)]);
  assert.deepEqual(held.get(cancelled.answers[0].seq), [[two.request.seq, { net: 620 }]], 'an answer with no dispatch frees the request: it is no recall');
  assert.deepEqual(held.get(ordinary.request.seq), [[two.request.seq, { net: 620 }]], 'a call that reads no event of the epoch states nothing, then or after');
  assert.deepEqual(replays, [two.dispatched[1].seq, cancelled.answers[0].seq]);
});

test('the Source built live and the one read cold at the same cut hold the same facts, late proof included', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const refused = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)], isError: true, answer: 'Error: already in your context' });
  const log = [...events, ...post.events, ...refused.events];
  const cut = events.length;

  const live = recallDriver();
  const frames = [live.install(log.slice(0, cut))];
  live.drain();
  for (const event of log.slice(cut)) {
    const frame = live.feed(event);
    if (frame !== null) frames.push(frame);
  }
  assert.deepEqual(recallsOf(applied(frames)), coldRecalls(log));
  assert.equal(recallsOf(applied(frames)).length, 2);
});

// ── The verdict on the Source's frames ───────────────────────────────────────
// Behind the first seal, each main call states what its request is as a recall: `pure`, `other` or `unknown`, one reading the monitor's settlement shares, and independent of the call's bill. The production Projection turns those facts into the share each measured point reads.

// The decay of one classified main call from its half-life of 32.
const ALPHA = 1 - 2 ** (-1 / 32);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ''} ${actual} ≈ ${expected}`.trim());

// The measured points the production Projection reads off a sequence of frames, a replace frame starting a fresh Projection as a watcher does: the share and the main call's ordinal by the seq of the request the step belongs to.
function pointsOf(frames) {
  let projection = null;
  let points = new Map();
  for (const frame of frames) {
    if (frame.transition === 'replace') {
      projection = dshRig().projection;
      points = new Map();
    }
    for (const observation of frame.batches.flat()) {
      for (const record of projection.project(observation, {}).records) {
        if (record.type === 'step') points.set(Number(/(\d+)$/.exec(record.id)[1]), { p: record.p, ordinal: record.mainCallOrdinal });
      }
    }
  }
  return points;
}
const shareAt = (points, request) => points.get(request.seq).p;
const coldPoints = events => pointsOf([recallDriver().install(events)]);

// The frames a driver gives a log fed live behind its first `cut` events, as `{ frames, replays }` with the seqs of the events whose frame replaced the Source.
function liveFrames(log, cut) {
  const driver = recallDriver();
  const frames = [driver.install(log.slice(0, cut))];
  driver.drain();
  const replays = [];
  for (const event of log.slice(cut)) {
    const frame = driver.feed(event);
    if (frame === null) continue;
    frames.push(frame);
    if (frame.transition === 'replace') replays.push(event.seq);
  }
  return { frames, replays };
}

test('every main call behind the first seal states what its request is, whatever its bill: a recall, one that is none and one that may still prove one, the call behind the seal and a call with no usage among them', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const ordinary = stepOf({ turn: 2, step: 2, text: 'working' });
  const mixed = stepOf({ turn: 2, step: 3, calls: [readCall('b', ask.seq), { id: 'file', name: 'read', arguments: '{"file_path":"b.js"}' }] });
  const open = stepOf({ turn: 2, step: 4, calls: [readCall('c', ask.seq)], dispatch: false, results: false });
  const quiet = stepOf({ turn: 2, step: 5, calls: [readCall('d', ask.seq)] });
  delete quiet.request.data.usage;
  const log = [...events, ...post.events, ...ordinary.events, ...mixed.events, ...open.events, ...quiet.events];

  assert.deepEqual(coldVerdicts(log), [
    [post.request.seq, 'pure'], [ordinary.request.seq, 'other'], [mixed.request.seq, 'other'], [open.request.seq, 'unknown'], [quiet.request.seq, 'pure'],
  ], 'the head stands before the seal and states none');
  assert.deepEqual(coldRecalls(log), [[post.request.seq, { net: 620 }], [open.request.seq, { net: null }], [quiet.request.seq, { net: null }]], 'the bills are as they were');
});

test('a seal that recorded no quote still lets its calls be classified: a recall behind it is pure with no bill, a call that is none is other', () => {
  const { ask, events, sealed } = opening();
  delete sealed.start.data.quote;
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const ordinary = stepOf({ turn: 2, step: 2, text: 'working' });
  const log = [...events, ...post.events, ...ordinary.events];
  assert.deepEqual(coldVerdicts(log), [[post.request.seq, 'pure'], [ordinary.request.seq, 'other']]);
  assert.deepEqual(coldRecalls(log), [[post.request.seq, { net: null }]]);
  near(shareAt(coldPoints(log), ordinary.request), ALPHA, 'the recall with no bill counts once');
});

test('a read before the first seal and a seal the log does not show whole classify nothing, and the Source states no share for them', () => {
  const early = stepOf({ turn: 1, step: 0, calls: [readCall('e', 0)] });
  const { ask, events, sealed } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  assert.deepEqual(coldVerdicts([...early.events, ...events, ...post.events]), [[post.request.seq, 'pure']]);
  sealed.start.data.request.messages.tail = { role: 'user', content: 'not a list of blocks' };
  assert.deepEqual(coldVerdicts([...early.events, ...events, ...post.events]), []);
  for (const point of coldPoints([...early.events, ...events, ...post.events]).values()) assert.equal(point.p, undefined);
});

test('a request that proves a recall on a bill that stays unknown replays the Source on the verdict alone, and its successors read it from the next main call', () => {
  const { ask, events, sealed } = opening();
  delete sealed.start.data.quote;
  const first = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const two = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq), readCall('c', ask.seq)] });
  const next = stepOf({ turn: 2, step: 3, text: 'working' });
  const log = [...events, ...first.events, ...two.events, ...next.events];
  const cut = events.length;

  const { frames, replays } = liveFrames(log, cut);
  // The dispatch of a lone read proves its request and the second of two does: the bill is unknown on both sides of each, so only the verdict says it moved, and the first of two leaves the request open.
  assert.deepEqual(replays, [first.dispatched[0].seq, two.dispatched[1].seq]);
  assert.deepEqual(verdictsOf(applied(frames)), [[first.request.seq, 'pure'], [two.request.seq, 'pure'], [next.request.seq, 'other']]);
  const points = pointsOf(frames);
  assert.equal(shareAt(points, first.request), undefined, 'the call behind the seal has no classified call before it');
  near(shareAt(points, two.request), ALPHA, 'its own point reads the share before its own verdict, which the proof does not backfill');
  near(shareAt(points, next.request), (1 - ALPHA) * ALPHA + ALPHA, 'the next main call is the first to count it');
  assert.deepEqual([...points], [...coldPoints(log)], 'the Source built live and the one read cold at the same cut hold the same shares');
});

test('a read the guard blocks is classified other until its record arrives and pure after, with no quote to price it, and the next main call is the first to read the change', () => {
  const { events, sealed } = opening();
  delete sealed.start.data.quote;
  const file = { id: 'a', name: 'read', arguments: JSON.stringify({ file_path: 'a.js' }) };
  const before = stepOf({ turn: 2, step: 1, text: 'working' });
  const guarded = stepOf({ turn: 2, step: 2, calls: [file], blocked: ['a'], isError: true, answer: 'Error: already in your context' });
  const next = stepOf({ turn: 2, step: 3, text: 'working' });
  const log = [...events, ...before.events, ...guarded.events, ...next.events];

  const driver = recallDriver();
  const frames = [driver.install(events)];
  driver.drain();
  const seen = new Map();
  const replays = [];
  for (const event of [...before.events, ...guarded.events, ...next.events]) {
    const frame = driver.feed(event);
    if (frame !== null) frames.push(frame);
    if (frame?.transition === 'replace') replays.push(event.seq);
    seen.set(event.seq, verdictsOf(applied(frames)));
  }
  assert.deepEqual(seen.get(guarded.dispatched[0].seq).at(-1), [guarded.request.seq, 'other'], 'a read of a file is no recall until the guard says so');
  assert.deepEqual(seen.get(guarded.records[0].seq).at(-1), [guarded.request.seq, 'pure']);
  assert.deepEqual(replays, [guarded.records[0].seq]);
  const points = pointsOf(frames);
  near(shareAt(points, guarded.request), 0, 'the call before it was other');
  near(shareAt(points, next.request), (1 - ALPHA) * 0 + ALPHA, 'the blocked read counts as pure from the next call on');
  assert.deepEqual([...points], [...coldPoints(log)]);
});

test('a classification and a bill that do not change replay nothing: an ordinary call\'s tool events, a dispatch that leaves a request unknown, and an answer that frees nothing', () => {
  const { ask, events } = opening();
  const ordinary = stepOf({ turn: 2, step: 1, calls: [{ id: 'file', name: 'read', arguments: '{"file_path":"b.js"}' }], text: 'working' });
  const two = stepOf({ turn: 2, step: 2, calls: [readCall('a', ask.seq), readCall('b', ask.seq)] });
  const { replays } = liveFrames([...events, ...ordinary.events, ...two.events], events.length);
  assert.deepEqual(replays, [two.dispatched[1].seq], 'only the dispatch that proves the request replays');
});

test('a later seal withdraws a call\'s usage and keeps its verdict and its place in the order the share reads', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const work = stepOf({ turn: 2, step: 2, text: 'working' });
  const later = stepOf({ turn: 2, step: 3, text: 'working again' });
  const second = pricedSeal([post.request, work.request], 2);
  const after = stepOf({ turn: 2, step: 4, text: 'after the second seal' });
  const log = [...events, ...post.events, ...work.events, ...later.events, ...second.events, ...after.events];

  const cold = recallDriver().install(log);
  assert.deepEqual(verdictsOf(cold.batches), [[post.request.seq, 'pure'], [work.request.seq, 'other'], [later.request.seq, 'other'], [after.request.seq, 'other']]);
  const points = pointsOf([cold]);
  assert.equal(points.has(work.request.seq), false, 'the withdrawn call keeps no point');
  near(shareAt(points, after.request), (1 - ALPHA) * (1 - ALPHA) * ALPHA, 'the share runs through the withdrawn calls and the second seal restarts nothing');
});

test('a call that reported no usage and a call whose stock is zero take their places in the order of the share, and the call after them reads it', () => {
  const { ask, events } = opening();
  const first = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const quiet = stepOf({ turn: 2, step: 2, text: 'quiet' });
  delete quiet.request.data.usage;
  const empty = stepOf({ turn: 2, step: 3, text: 'empty', usage: tokens(0, 5, 0, 0) });
  const last = stepOf({ turn: 2, step: 4, text: 'last' });
  const points = coldPoints([...events, ...first.events, ...quiet.events, ...empty.events, ...last.events]);
  near(shareAt(points, empty.request), (1 - ALPHA) * ALPHA, 'the quiet call counted as other');
  near(shareAt(points, last.request), (1 - ALPHA) * (1 - ALPHA) * ALPHA, 'and so did the one with no stock');
  assert.deepEqual([first, empty, last].map(each => points.get(each.request.seq).ordinal), [2, 4, 5], 'the count of main calls is the lifetime one');
});

test('a clear starts the share over: the first classified call of the new epoch reads no estimate, and the epoch before it stays out of it', () => {
  const { ask, events } = opening();
  const post = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const cleared = clear('amber-falcon', { from: ask, to: post.request });
  const second = stepOf({ turn: 3, step: 1, admit: ['the next task'], text: 'working', usage: tokens(100, 30, 900) });
  const sealed = pricedSeal([second.admitted[0], second.request], 1);
  const older = stepOf({ turn: 3, step: 2, calls: [readCall('c', ask.seq)] });
  const own = stepOf({ turn: 3, step: 3, calls: [readCall('d', second.request.seq)] });
  const last = stepOf({ turn: 3, step: 4, text: 'last' });
  const points = coldPoints([...events, ...post.events, ...cleared.events, ...second.events, ...sealed.events, ...older.events, ...own.events, ...last.events]);

  assert.equal(shareAt(points, post.request), undefined);
  assert.equal(shareAt(points, second.request), undefined, 'a new epoch with no seal has no classified call');
  assert.equal(shareAt(points, older.request), undefined, 'a read of the epoch before is other, and the first classified call reads nothing');
  assert.equal(shareAt(points, own.request), 0, 'zero is an estimate: the call before it was other, and the pure call of the epoch before is out of it');
  near(shareAt(points, last.request), ALPHA, 'one other call and then a pure one: the weight of the pure one');
  assert.equal(points.get(last.request.seq).ordinal > points.get(post.request.seq).ordinal, true, 'the count of main calls runs on');
});
