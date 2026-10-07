// test/dsh.source-driver.test.js — the DSH source driver: a session's snapshot and its live events as the
// HarnessFrames `SessionWatcher.applyHarnessFrame` consumes, with reducer diagnostics handed to the sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import {
  userMessage, assistantMessage, toolCall, toolResult, turnStart, turnEnd, stepStart, stepEnd, unknownEvent,
  sessionLog,
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
      [[3, 'tool-use'], [3, 'usage']],
      [[5, 'tool-result']],
      [[8, 'text'], [8, 'usage']],
    ],
  });
  assert.deepEqual(reported, []);
});

test('snapshot diagnostics reach the sink at install', () => {
  const unmetered = assistantMessage({ text: 'Done.', usage: { inputTokens: 3, outputTokens: null } });
  const events = sessionLog([userMessage({ text: 'Where is parse defined?' }), unpairedResult(), unmetered]);
  const { driver, reported } = recordingDriver();
  assert.deepEqual(readFrame(driver.install(events)), {
    ...REPLAY, batches: [[[0, 'turn-boundary'], [0, 'text']]],
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
  assert.deepEqual(driver.drain().map(readFrame), [{ ...LIVE, batches: [[[3, 'text'], [3, 'usage']]] }]);
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
    { ...LIVE, batches: [[[3, 'tool-use'], [3, 'usage']]] },
    { ...LIVE, batches: [[[5, 'tool-result']]] },
    { ...LIVE, batches: [[[8, 'text'], [8, 'usage']]] },
  ]);
});

test('an event fed between install and drain leaves drain in seq order behind the earlier queue', () => {
  const events = session();
  const { driver } = recordingDriver();
  for (const event of events.slice(3, 6)) driver.feed(event);
  driver.install(events.slice(0, 3));
  for (const event of events.slice(6, 9)) assert.equal(driver.feed(event), null, event.type);
  assert.deepEqual(driver.drain().map(readFrame), [
    { ...LIVE, batches: [[[3, 'tool-use'], [3, 'usage']]] },
    { ...LIVE, batches: [[[5, 'tool-result']]] },
    { ...LIVE, batches: [[[8, 'text'], [8, 'usage']]] },
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
    { ...LIVE, batches: [[[8, 'text'], [8, 'usage']]] },
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

// --- Invariants ---

test('install twice, drain before install or a missing diagnostics sink fails the invariant', () => {
  const { driver } = recordingDriver();
  driver.install([]);
  assert.throws(() => driver.install([]), /dsh source driver invariant/);
  assert.throws(() => recordingDriver().driver.drain(), /dsh source driver invariant/);
  assert.throws(() => createDshSourceDriver({ sessionId: SESSION_ID }), /dsh source driver invariant/);
});
