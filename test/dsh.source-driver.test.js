// test/dsh.source-driver.test.js — the DSH source driver: a session's snapshot and its live events as the
// HarnessFrames `SessionWatcher.applyHarnessFrame` consumes, with reducer diagnostics handed to the sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import {
  userMessage, assistantMessage, toolCall, toolResult, turnStart, turnEnd, stepStart, stepEnd, unknownEvent,
  sessionLog, innerSealCarrier,
} from './helpers/dsh-events.js';

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
