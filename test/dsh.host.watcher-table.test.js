// The DSH host's watcher table over the production composition: one `SessionWatcher` per session through the bootstrap snapshot, the live feed, failure and disposal, over a temporary store the process singleton holds.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWatcherTable } from '../dsh/src/watcher-table.js';
import { createModelNames } from '../dsh/src/model-names.js';
import { composeWatcher } from '../dsh/src/composition.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { sourceFactOf } from '../lib/harness/dsh/inner-source.js';
import { initStore, getStore, closeStoreGlobal } from '../lib/store.js';
import {
  getLiveLedger, isEnospcPaused, _resetRateLampManagerForTest,
} from '../lib/rate-lamp-manager.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL, LONG_CACHE_TTL } from '../lib/constants.js';
import {
  reusedCallIdAcrossSteps, FIRST_STEP_END, toolResult, sessionLog, compactCheckpoint,
  turnStart, userMessage, requestHeader, stepStart, assistantMessage, stepEnd, turnEnd, loadMessage,
} from './helpers/dsh-events.js';
import { readResultText } from './helpers/attribution-fixtures.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-table-'));
  initStore(join(dir, 'store.sqlite'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const sessionOf = id => ({ id, header: { cwd: '/repo' } });

// A `readSession` whose every call the test settles by session id.
function fakeReader() {
  const pending = new Map();
  const calls = [];
  return {
    calls,
    readSession(sessionId) {
      calls.push(sessionId);
      return new Promise((resolve, reject) => pending.set(sessionId, { resolve, reject }));
    },
    settle(sessionId, events) { pending.get(sessionId).resolve({ session: {}, inheritedEventCount: 0, events }); },
    reject(sessionId, error) { pending.get(sessionId).reject(error); },
  };
}

// A table over `composeWatcher` and the temporary store, under the handed `modelNames` or the table's own default; `composed` keeps what each `compose` returned, by session id, and `adapt` may replace members of the composition before the table receives it.
function buildTable({ cacheTtlFor, modelNames, adapt = composition => composition, store = () => getStore() } = {}) {
  const reader = fakeReader();
  const composed = new Map();
  const table = createWatcherTable({
    readSession: reader.readSession,
    ...(cacheTtlFor ? { cacheTtlFor } : {}),
    ...(modelNames ? { modelNames } : {}),
    compose: ({ sessionId, cwd, cacheTtl }) => {
      const composition = adapt(composeWatcher({
        sessionId, cwd, cacheTtl, store: store(), turnNotesRoot: join(dir, 'turn-notes'), readSession: reader.readSession, isIgnored: null,
      }), sessionId);
      composed.set(sessionId, composition);
      return composition;
    },
  });
  return { table, reader, composed };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

// Stderr captured for the case, restored after it.
function captureStderr(t) {
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = realError; });
  return lines;
}

// Every unhandled rejection between the call and the read, read after a `setImmediate` turn.
function watchUnhandledRejections(t) {
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  return rejections;
}

const lineOf = line => {
  const match = /^(\S+) \[([^\]]+)\] ([^:]+): (.*)$/.exec(line);
  return match && { sessionId: match[1], scope: match[2], code: match[3], message: match[4] };
};

const linesFor = (lines, sessionId) => lines.map(lineOf).filter(line => line?.sessionId === sessionId);

const archivedSources = sessionId => getStore()._db
  .prepare('SELECT segment, capture_source FROM profile WHERE session_id = ? ORDER BY segment')
  .all(sessionId).map(row => ({ ...row }));

const sumOf = (points, field) => points.reduce((sum, point) => sum + point[field], 0);

// The predicate `test/dsh.fixtures.application.test.js` `every event fed live after an empty snapshot` holds two entry modes to, between two watchers.
function assertMeasuresAlike(actual, expected) {
  const history = actual.getHistory();
  const reference = expected.getHistory();
  assert.equal(history.length, reference.length, 'measured calls');
  for (const field of ['L', 'cacheRead', 'cacheCreation']) {
    assert.equal(sumOf(history, field), sumOf(reference, field), field);
  }
  assert.equal(actual.getStatus().segment, expected.getStatus().segment, 'segment');
  assert.equal(actual.getStatus().model, expected.getStatus().model, 'model');
  assert.equal(JSON.stringify(actual.getBucketData()), JSON.stringify(expected.getBucketData()), 'bucket data');
}

// The log under a Claude model whose row prices a long lifetime apart from its default one, each `assistant/message` in turn on the route `routes` names, the last route repeating.
const CLAUDE_MODEL = 'claude-opus-5-5';
function claudeLog(routes) {
  let index = 0;
  return reusedCallIdAcrossSteps().map(event => {
    if (event.type !== 'assistant/message') return event;
    const provider = routes[Math.min(index++, routes.length - 1)];
    const source = { ...event.data.message.source, model: CLAUDE_MODEL, provider };
    return { ...event, data: { ...event.data, message: { ...event.data.message, source } } };
  });
}

test('ensure from three callers creates one watcher and one readSession', async () => {
  let composes = 0;
  const { table, reader, composed } = buildTable({ adapt: composition => { composes += 1; return composition; } });
  // The load-time enumeration, `session/created` and the first `session/event` each ensure the session.
  table.ensure(sessionOf('s-one'));
  table.ensure(sessionOf('s-one'));
  table.ensure(sessionOf('s-one'));
  assert.deepEqual(reader.calls, ['s-one']);
  assert.equal(composes, 1);

  reader.settle('s-one', reusedCallIdAcrossSteps());
  await settled();
  table.ensure(sessionOf('s-one'));
  assert.deepEqual(reader.calls, ['s-one'], 'a live entry starts no second read');
  assert.equal(table.get('s-one').watcher, composed.get('s-one').watcher);
});

test('a snapshot installs as one replay frame and queued events past its tail become live frames', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-boot'));
  for (const event of log) table.feed('s-boot', event);
  reader.settle('s-boot', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  const entry = table.get('s-boot');
  assert.equal(entry.state, 'live');

  const { watcher: reference } = composeWatcher({
    sessionId: 's-reference', cwd: '/repo', cacheTtl: () => null, store: getStore(), turnNotesRoot: join(dir, 'turn-notes'),
    readSession: async () => ({ events: log }), isIgnored: null,
  });
  const driver = createDshSourceDriver({ sessionId: 's-reference', onDiagnostics: () => {} });
  reference.applyHarnessFrame(driver.install(log));
  assert.equal(reference.getHistory().length, 2, 'the reference measures both calls');
  assertMeasuresAlike(entry.watcher, reference);
});

test('a rejected readSession fails the watcher, later events are not fed and another watcher\'s frames still apply', async (t) => {
  const lines = captureStderr(t);
  const rejections = watchUnhandledRejections(t);
  const log = reusedCallIdAcrossSteps();
  const { table, reader, composed } = buildTable();
  table.ensure(sessionOf('s-rejected'));
  table.ensure(sessionOf('s-other'));
  reader.reject('s-rejected', new Error('snapshot unavailable'));
  reader.settle('s-other', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  assert.deepEqual(table.get('s-rejected'), {
    state: 'failed',
    diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'snapshot unavailable' },
  });
  assert.equal(getLiveLedger('s-rejected'), null);
  assert.deepEqual(linesFor(lines, 's-rejected'), [{
    sessionId: 's-rejected', scope: 'dsh-host', code: 'read_session_rejected', message: 'snapshot unavailable',
  }]);

  for (const event of log) table.feed('s-rejected', event);
  for (const event of log.slice(FIRST_STEP_END + 1)) table.feed('s-other', event);
  assert.equal(composed.get('s-rejected').watcher.getHistory().length, 0);
  assert.equal(table.get('s-rejected').state, 'failed');
  assert.equal(table.get('s-other').watcher.getHistory().length, 2, 'the other watcher measured its live call');

  table.dispose('s-rejected');
  assert.deepEqual(table.get('s-rejected'), { state: 'unobserved' }, 'a disposed failed watcher is removed');

  await settled();
  assert.deepEqual(rejections, []);
});

test('a throwing frame path fails the watcher with frame_application_failed', async (t) => {
  const lines = captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  let throwNext = false;
  const { table, reader, composed } = buildTable({
    adapt: composition => {
      const { watcher } = composition;
      const apply = watcher.applyHarnessFrame.bind(watcher);
      watcher.applyHarnessFrame = (frame) => {
        if (throwNext) { throwNext = false; throw new Error('frame broke'); }
        return apply(frame);
      };
      return composition;
    },
  });
  table.ensure(sessionOf('s-frame'));
  reader.settle('s-frame', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  assert.notEqual(getLiveLedger('s-frame'), null, 'the installed snapshot advanced the Rate Lamp');

  table.feed('s-frame', log[FIRST_STEP_END + 1]);
  throwNext = true;
  table.feed('s-frame', log[FIRST_STEP_END + 2]);
  const failure = { scope: 'dsh-host', code: 'frame_application_failed', message: 'frame broke' };
  assert.deepEqual(table.get('s-frame'), { state: 'failed', diagnostic: failure });
  assert.equal(getLiveLedger('s-frame'), null);
  assert.deepEqual(linesFor(lines, 's-frame'), [{ sessionId: 's-frame', ...failure }]);

  const measured = composed.get('s-frame').watcher.getHistory().length;
  for (const event of log.slice(FIRST_STEP_END + 2)) table.feed('s-frame', event);
  assert.equal(composed.get('s-frame').watcher.getHistory().length, measured, 'later events are not fed');
});

test('a Rate Lamp advance that throws writes a handler_failed line and the watcher stays live', async (t) => {
  const lines = captureStderr(t);
  const { table, reader } = buildTable({
    adapt: composition => {
      composition.watcher.readRateLampFrame = () => { throw new Error('lamp broke'); };
      return composition;
    },
  });
  table.ensure(sessionOf('s-lamp'));
  reader.settle('s-lamp', []);
  await settled();
  const failure = { sessionId: 's-lamp', scope: 'dsh-host', code: 'handler_failed', message: 'lamp broke' };
  assert.deepEqual(linesFor(lines, 's-lamp'), [failure], 'the empty snapshot installs as one frame');

  for (const event of reusedCallIdAcrossSteps()) table.feed('s-lamp', event);
  const entry = table.get('s-lamp');
  assert.equal(entry.state, 'live');
  assert.equal(entry.watcher.getHistory().length, 2, 'every frame stands');
  for (const line of linesFor(lines, 's-lamp')) assert.deepEqual(line, failure);
});

test('dispose of a live watcher archives live and releases the session', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-live'));
  reader.settle('s-live', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  for (const event of log.slice(FIRST_STEP_END + 1)) table.feed('s-live', event);
  const ledger = getLiveLedger('s-live');
  assert.notEqual(ledger, null);

  table.dispose('s-live');
  assert.deepEqual(archivedSources('s-live'), [{ segment: 0, capture_source: 'dsh-live' }]);
  assert.equal(getLiveLedger('s-live'), null);
  assert.equal(isEnospcPaused('s-live'), false);
  assert.deepEqual(getStore().load('s-live', 'ledger'), JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(table.get('s-live'), { state: 'unobserved' });
  assert.deepEqual(table.live(), []);
});

test('a live entry that applied no append frame archives as dsh-replay on dispose and on disposeAll', async () => {
  const { table, reader } = buildTable();
  for (const id of ['s-settled-a', 's-settled-b']) {
    table.ensure(sessionOf(id));
    reader.settle(id, reusedCallIdAcrossSteps());
  }
  await settled();
  table.dispose('s-settled-a');
  assert.deepEqual(archivedSources('s-settled-a'), [{ segment: 0, capture_source: 'dsh-replay' }]);
  table.disposeAll();
  assert.deepEqual(archivedSources('s-settled-b'), [{ segment: 0, capture_source: 'dsh-replay' }]);
});

test('an entry that applied a fed append frame archives as dsh-live', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-fed'));
  reader.settle('s-fed', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  for (const event of log.slice(FIRST_STEP_END + 1)) table.feed('s-fed', event);
  table.dispose('s-fed');
  assert.deepEqual(archivedSources('s-fed'), [{ segment: 0, capture_source: 'dsh-live' }]);
});

test('dispose before the snapshot marks, and the snapshot then installs, drains, archives as live and removes', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader, composed } = buildTable();
  table.ensure(sessionOf('s-marked'));
  for (const event of log) table.feed('s-marked', event);
  table.dispose('s-marked');
  assert.deepEqual(table.get('s-marked'), { state: 'bootstrapping' });

  reader.settle('s-marked', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  assert.equal(composed.get('s-marked').watcher.getHistory().length, 2, 'the queued call was drained');
  assert.deepEqual(archivedSources('s-marked'), [{ segment: 0, capture_source: 'dsh-live' }]);
  assert.deepEqual(table.get('s-marked'), { state: 'unobserved' });
  assert.equal(getLiveLedger('s-marked'), null);
  table.feed('s-marked', log.at(-1));
  assert.deepEqual(table.get('s-marked'), { state: 'unobserved' });

  table.ensure(sessionOf('s-marked-rejected'));
  table.dispose('s-marked-rejected');
  reader.reject('s-marked-rejected', new Error('snapshot unavailable'));
  await settled();
  assert.deepEqual(table.get('s-marked-rejected'), { state: 'unobserved' });
  assert.deepEqual(archivedSources('s-marked-rejected'), []);
});

test('an entry disposed while bootstrapping whose drain applied no frame archives as dsh-replay', async () => {
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-marked-settled'));
  table.dispose('s-marked-settled');
  reader.settle('s-marked-settled', reusedCallIdAcrossSteps());
  await settled();
  assert.deepEqual(archivedSources('s-marked-settled'), [{ segment: 0, capture_source: 'dsh-replay' }]);
  assert.deepEqual(table.get('s-marked-settled'), { state: 'unobserved' });
});

test('a throw in the replay archival after the mark ends as a handler_failed line and no rejection', async (t) => {
  const lines = captureStderr(t);
  const rejections = watchUnhandledRejections(t);
  const { table, reader } = buildTable({
    adapt: composition => {
      composition.watcher.closeCurrentSegment = () => { throw new Error('archive broke'); };
      return composition;
    },
  });
  table.ensure(sessionOf('s-archive'));
  const orphaned = assert.rejects(table.waitLive('s-archive', new AbortController().signal),
    error => error instanceof Error && error.message.includes('s-archive'),
    'the removed entry\'s waiter gets the missing-entry Error');
  table.dispose('s-archive');
  reader.settle('s-archive', reusedCallIdAcrossSteps());
  await settled();

  await orphaned;
  assert.deepEqual(table.get('s-archive'), { state: 'unobserved' });
  assert.equal(getLiveLedger('s-archive'), null);
  assert.deepEqual(linesFor(lines, 's-archive'), [{
    sessionId: 's-archive', scope: 'dsh-host', code: 'handler_failed', message: 'archive broke',
  }]);
  await settled();
  assert.deepEqual(rejections, []);
});

test('every reducer diagnostic and every application diagnostic is one stderr line with the session id', async (t) => {
  const lines = captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable({
    store: () => Object.create(getStore(), {
      archiveSegmentProfile: { value: () => { throw new Error('disk full'); } },
    }),
  });
  table.ensure(sessionOf('s-diag'));
  reader.settle('s-diag', log);
  await settled();

  const unpaired = () => {
    const event = toolResult({ callId: 'call_read', text: 'export const a = 1;' });
    delete event.data.message.toolCallId;
    return event;
  };
  table.feed('s-diag', { ...unpaired(), seq: log.length });
  table.feed('s-diag', { ...unpaired(), seq: log.length + 1 });
  const reducerLines = linesFor(lines, 's-diag');
  assert.equal(reducerLines.length, 2, `one line per reducer diagnostic; saw ${JSON.stringify(lines)}`);
  for (const line of reducerLines) {
    assert.equal(line.scope, 'dsh-transcript-observation');
    assert.equal(line.code, 'shape-violation');
    assert.match(line.message, /tool\/result/);
  }

  const assertPersistFailed = (applicationLines) => {
    assert.equal(applicationLines.length, 1, `one line per application diagnostic; saw ${JSON.stringify(lines)}`);
    assert.equal(applicationLines[0].scope, 'session-watcher');
    assert.equal(applicationLines[0].code, 'segment_profile_persist_failed');
    assert.match(applicationLines[0].message, /disk full/);
  };
  const continued = sessionLog([
    ...log, compactCheckpoint({ startSeq: log[0].seq, endSeq: log.at(-1).seq }), ...reusedCallIdAcrossSteps(),
  ]);
  for (const event of continued.slice(log.length)) table.feed('s-diag', { ...event, seq: event.seq + 2 });
  assert.equal(table.get('s-diag').watcher.getStatus().segment, 1, 'a live frame closed the segment');
  assertPersistFailed(linesFor(lines, 's-diag').slice(2));

  table.dispose('s-diag');
  assertPersistFailed(linesFor(lines, 's-diag').slice(3));

  table.ensure(sessionOf('s-diag-marked'));
  table.dispose('s-diag-marked');
  reader.settle('s-diag-marked', log);
  await settled();
  assertPersistFailed(linesFor(lines, 's-diag-marked'));
});

test('a live watcher\'s diagnostics never reach get', async (t) => {
  captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-quiet'));
  reader.settle('s-quiet', log);
  await settled();
  const event = toolResult({ callId: 'call_read', text: 'export const a = 1;' });
  delete event.data.message.toolCallId;
  table.feed('s-quiet', { ...event, seq: log.length });

  const entry = table.get('s-quiet');
  assert.equal(entry.state, 'live');
  assert.equal(Object.hasOwn(entry, 'diagnostic'), false);
});

test('waitLive resolves with the live entry after install, rejects with an Error carrying the diagnostic\'s message on failed, with an abort on a cancelled signal and with the missing-entry Error when a marked entry is archived and removed', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader, composed } = buildTable();

  table.ensure(sessionOf('s-wait'));
  const kept = new AbortController();
  const cancelled = new AbortController();
  const waiting = table.waitLive('s-wait', kept.signal);
  const aborted = table.waitLive('s-wait', cancelled.signal);
  cancelled.abort();
  await assert.rejects(aborted, error => error instanceof Error && error.cause === cancelled.signal.reason);
  await assert.rejects(table.waitLive('s-wait', cancelled.signal),
    error => error instanceof Error && error.cause === cancelled.signal.reason, 'a signal already aborted');
  reader.settle('s-wait', log);
  const entry = await waiting;
  const { watcher, dialogueSource, dialogueProjection } = composed.get('s-wait');
  assert.equal(entry.state, 'live');
  assert.equal(entry.watcher, watcher);
  assert.equal(entry.dialogueSource, dialogueSource);
  assert.equal(entry.dialogueProjection, dialogueProjection);
  assert.equal((await table.waitLive('s-wait', kept.signal)).watcher, watcher, 'a live entry answers at once');

  table.ensure(sessionOf('s-wait-failed'));
  const failing = table.waitLive('s-wait-failed', new AbortController().signal);
  reader.reject('s-wait-failed', new Error('snapshot unavailable'));
  await assert.rejects(failing, error => error instanceof Error && error.message === 'snapshot unavailable');
  await assert.rejects(table.waitLive('s-wait-failed', new AbortController().signal),
    error => error instanceof Error && error.message === 'snapshot unavailable');

  table.ensure(sessionOf('s-wait-marked'));
  const orphaned = table.waitLive('s-wait-marked', new AbortController().signal);
  table.dispose('s-wait-marked');
  reader.settle('s-wait-marked', log);
  const missing = error => error instanceof Error && error.message.includes('s-wait-marked');
  await assert.rejects(orphaned, missing);
  await assert.rejects(table.waitLive('s-wait-marked', new AbortController().signal), missing);
});

test('disposeAll archives every live watcher and one throwing dispose does not stop the rest', async (t) => {
  const lines = captureStderr(t);
  const { table, reader } = buildTable({
    adapt: (composition, sessionId) => {
      if (sessionId === 's-all-b') composition.watcher.closeCurrentSegment = () => { throw new Error('archive broke'); };
      return composition;
    },
  });
  const log = reusedCallIdAcrossSteps();
  for (const id of ['s-all-a', 's-all-b', 's-all-c']) {
    table.ensure(sessionOf(id));
    reader.settle(id, log.slice(0, FIRST_STEP_END + 1));
  }
  await settled();
  for (const id of ['s-all-a', 's-all-b', 's-all-c']) {
    for (const event of log.slice(FIRST_STEP_END + 1)) table.feed(id, event);
  }
  for (const id of ['s-all-a', 's-all-b', 's-all-c']) assert.notEqual(getLiveLedger(id), null, id);

  table.disposeAll();
  for (const id of ['s-all-a', 's-all-c']) {
    assert.deepEqual(archivedSources(id), [{ segment: 0, capture_source: 'dsh-live' }], id);
    assert.deepEqual(table.get(id), { state: 'unobserved' }, id);
  }
  assert.deepEqual(table.get('s-all-b'), { state: 'unobserved' });
  assert.equal(getLiveLedger('s-all-b'), null);
  assert.equal(isEnospcPaused('s-all-b'), false);
  assert.deepEqual(linesFor(lines, 's-all-b'), [{
    sessionId: 's-all-b', scope: 'dsh-host', code: 'handler_failed', message: 'archive broke',
  }]);
  assert.deepEqual(table.live(), []);
});

test('an ensure after disposeAll throws and plants no entry', async () => {
  let composes = 0;
  const { table, reader } = buildTable({ adapt: composition => { composes += 1; return composition; } });
  table.disposeAll();
  assert.throws(() => table.ensure(sessionOf('s-late')), { message: 'the watcher table is closed' });
  assert.deepEqual(table.get('s-late'), { state: 'unobserved' });
  assert.equal(composes, 0);
  assert.deepEqual(reader.calls, []);
});

test('the policy follows the route\'s declared lifetime', async () => {
  const longRow = modelPolicyFor(CLAUDE_MODEL, LONG_CACHE_TTL).cRatio;
  const defaultRow = modelPolicyFor(CLAUDE_MODEL, DEFAULT_CACHE_TTL).cRatio;
  assert.notEqual(longRow, defaultRow, 'the model prices the two lifetimes apart');
  const { table, reader } = buildTable({ cacheTtlFor: route => (route === 'route-long' ? LONG_CACHE_TTL : null) });

  table.ensure(sessionOf('s-long'));
  table.ensure(sessionOf('s-default'));
  reader.settle('s-long', []);
  reader.settle('s-default', []);
  await settled();
  for (const event of claudeLog(['route-long'])) table.feed('s-long', event);
  for (const event of claudeLog(['route-default'])) table.feed('s-default', event);
  assert.equal(table.get('s-long').watcher.getStatus().cRatio, longRow);
  assert.equal(table.get('s-long').cacheTtl, LONG_CACHE_TTL);
  assert.equal(table.get('s-default').watcher.getStatus().cRatio, defaultRow);

  table.ensure(sessionOf('s-snapshot'));
  reader.settle('s-snapshot', claudeLog(['route-default', 'route-long']));
  await settled();
  assert.equal(table.get('s-snapshot').watcher.getStatus().cRatio, longRow);
});

// Every session id the table's change listener hears, in order.
function listen(table) {
  const heard = [];
  table.onChange(sessionId => heard.push(sessionId));
  return heard;
}

// The log's frame-yielding events past the first step: the second call and its read result.
const SECOND_CALL = FIRST_STEP_END + 2;
const SECOND_RESULT = FIRST_STEP_END + 4;

test('onChange hears the entry turn live, each applied append frame, its failure and its removal, once each', async (t) => {
  captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  let throwNext = false;
  const { table, reader } = buildTable({
    adapt: composition => {
      const { watcher } = composition;
      const apply = watcher.applyHarnessFrame.bind(watcher);
      watcher.applyHarnessFrame = (frame) => {
        if (throwNext) throw new Error('frame broke');
        return apply(frame);
      };
      return composition;
    },
  });
  const heard = listen(table);
  table.ensure(sessionOf('s-change'));
  table.ensure(sessionOf('s-live-removed'));
  reader.settle('s-change', log.slice(0, FIRST_STEP_END + 1));
  reader.settle('s-live-removed', log);
  await settled();
  assert.deepEqual(heard, ['s-change', 's-live-removed'], 'each entry turned live');

  heard.length = 0;
  for (const event of log.slice(FIRST_STEP_END + 1, SECOND_RESULT + 1)) table.feed('s-change', event);
  assert.deepEqual(heard, ['s-change', 's-change'], 'the call and its result each applied a frame');

  heard.length = 0;
  throwNext = true;
  table.feed('s-change', userMessageOf(log));
  assert.equal(table.get('s-change').state, 'failed');
  assert.deepEqual(heard, ['s-change'], 'the failure, and no frame notification for the event that failed it');

  heard.length = 0;
  table.dispose('s-change');
  table.dispose('s-live-removed');
  assert.deepEqual(heard, ['s-change', 's-live-removed'], 'a failed and a live entry each notify their removal');
  table.dispose('s-change');
  assert.deepEqual(heard, ['s-change', 's-live-removed'], 'a removed entry notifies nothing more');
});

// The log's user message, re-sequenced past its tail so a live feed reduces it again.
function userMessageOf(log) {
  const message = log.find(event => event.type === 'user/message');
  return { ...message, seq: log.at(-1).seq + 1 };
}

test('an event that reduces to no frame and an event queued while bootstrapping notify nothing', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  const heard = listen(table);
  table.ensure(sessionOf('s-quiet'));
  for (const event of log.slice(0, SECOND_CALL + 1)) table.feed('s-quiet', event);
  assert.deepEqual(heard, [], 'queued events notify nothing');

  reader.settle('s-quiet', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  assert.equal(table.get('s-quiet').watcher.getHistory().length, 2, 'the queued call was drained');
  assert.deepEqual(heard, ['s-quiet'], 'the drained frames are covered by the live notification');

  table.feed('s-quiet', log[SECOND_CALL + 1]);
  assert.equal(log[SECOND_CALL + 1].type, 'tool/call');
  assert.deepEqual(heard, ['s-quiet'], 'an event that reduces to no frame notifies nothing');
  table.feed('s-quiet', log[SECOND_RESULT]);
  assert.deepEqual(heard, ['s-quiet', 's-quiet'], 'the next frame notifies');
});

test('a throwing listener writes a handler_failed line and the entry stays live', async (t) => {
  const lines = captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.onChange(() => { throw new Error('listener broke'); });
  const heard = listen(table);
  table.ensure(sessionOf('s-listener'));
  reader.settle('s-listener', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  for (const event of log.slice(FIRST_STEP_END + 1)) table.feed('s-listener', event);

  const failure = { sessionId: 's-listener', scope: 'dsh-host', code: 'handler_failed', message: 'listener broke' };
  assert.deepEqual(linesFor(lines, 's-listener'), [failure, failure, failure], 'the live notification and both frames');
  assert.equal(table.get('s-listener').state, 'live');
  assert.equal(table.get('s-listener').watcher.getHistory().length, 2, 'every frame stands');
  assert.deepEqual(heard, ['s-listener', 's-listener', 's-listener'], 'the other listener still hears every change');
});

test('an entry disposed while bootstrapping notifies its removal once when its snapshot arrives', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  const heard = listen(table);
  table.ensure(sessionOf('s-marked'));
  table.dispose('s-marked');
  assert.deepEqual(heard, []);

  reader.settle('s-marked', log);
  await settled();
  assert.deepEqual(table.get('s-marked'), { state: 'unobserved' });
  assert.deepEqual(heard, ['s-marked']);
});

const PROVIDER = 'deepseek';
const MODEL = 'deepseek-v4-pro';
const MODEL_NAME = 'DeepSeek V4 Pro';
const OTHER_MODEL = 'deepseek-v4-flash';

// The production model names over a resolve the test settles: one deferred per pair, fulfilled with the llm service's `{ provider, id, name }` or rejected with its `NO_ADAPTER` Error when the test chooses; `calls` records every resolve.
function controlledNames() {
  const deferreds = new Map();
  const calls = [];
  const deferredOf = (provider, id) => {
    const key = `${provider}/${id}`;
    if (!deferreds.has(key)) deferreds.set(key, Promise.withResolvers());
    return deferreds.get(key);
  };
  return {
    modelNames: createModelNames({
      resolve: (provider, id) => {
        calls.push([provider, id]);
        return deferredOf(provider, id).promise;
      },
    }),
    calls,
    fulfil(provider, id, name) { deferredOf(provider, id).resolve({ provider, id, name }); },
    reject(provider, id) {
      deferredOf(provider, id).reject(Object.assign(new Error(`no adapter for provider "${provider}"`), { code: 'NO_ADAPTER' }));
    },
  };
}

// One turn of two measured steps under one model, each step opened by its request header.
function namedLog(model = MODEL) {
  return sessionLog([
    turnStart(), userMessage({ text: 'Compare the two modules.' }),
    requestHeader({ model }), stepStart({ step: 1 }),
    assistantMessage({
      step: 1, model, text: 'The first module exports a constant.',
      usage: { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 },
    }),
    stepEnd({ step: 1 }),
    requestHeader({ model }), stepStart({ step: 2 }),
    assistantMessage({
      step: 2, model, text: 'The second module exports a default.',
      usage: { inputTokens: 2, outputTokens: 40, totalTokens: 9752, cacheReadTokens: 9600, cacheWriteTokens: 110 },
    }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

// The index of the log's first event of `type`.
const firstOf = (log, type) => log.findIndex(event => event.type === type);

test('a snapshot whose header and message name a pair installs once the pair resolves, with the message measured under its name', async () => {
  const names = controlledNames();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-named'));
  reader.settle('s-named', namedLog());
  await settled();
  assert.deepEqual(table.get('s-named'), { state: 'bootstrapping' }, 'the install waits for the warm-up');
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);

  names.fulfil(PROVIDER, MODEL, MODEL_NAME);
  await settled();
  const entry = table.get('s-named');
  assert.equal(entry.state, 'live');
  assert.equal(entry.watcher.getHistory().length, 2);
  assert.equal(entry.watcher.getEpochModel(), MODEL_NAME);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);
});

test('a message received while bootstrapping whose header is in the snapshot is fed mapped after the install', async () => {
  const names = controlledNames();
  const log = namedLog();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-queued'));
  for (const event of log) table.feed('s-queued', event);
  reader.settle('s-queued', log.slice(0, firstOf(log, 'assistant/message')));
  await settled();
  assert.deepEqual(table.get('s-queued'), { state: 'bootstrapping' });

  names.fulfil(PROVIDER, MODEL, MODEL_NAME);
  await settled();
  const { watcher } = table.get('s-queued');
  assert.equal(watcher.getHistory().length, 2, 'both queued calls were drained');
  assert.equal(watcher.getEpochModel(), MODEL_NAME);
  assert.equal(watcher.getCurrentModel(), MODEL_NAME);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);
});

test('a header received while bootstrapping for a pair the snapshot does not name warms it at once and holds the install until it resolves', async () => {
  const names = controlledNames();
  const log = namedLog();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-header'));
  for (const event of log) table.feed('s-header', event);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]], 'the fed header started the resolve');

  reader.settle('s-header', log.slice(0, firstOf(log, 'request/header')));
  await settled();
  assert.deepEqual(table.get('s-header'), { state: 'bootstrapping' }, 'the install waits for the queued pair');

  names.fulfil(PROVIDER, MODEL, MODEL_NAME);
  await settled();
  const { state, watcher } = table.get('s-header');
  assert.equal(state, 'live');
  assert.equal(watcher.getHistory().length, 2);
  assert.equal(watcher.getEpochModel(), MODEL_NAME);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);
});

test('a disposal during the warm-up archives the snapshot and the queued calls and removes the entry once', async () => {
  const names = controlledNames();
  const log = namedLog();
  const { table, reader, composed } = buildTable({ modelNames: names.modelNames });
  const heard = listen(table);
  table.ensure(sessionOf('s-warm-disposed'));
  for (const event of log) table.feed('s-warm-disposed', event);
  reader.settle('s-warm-disposed', log.slice(0, firstOf(log, 'step/end') + 1));
  await settled();
  table.dispose('s-warm-disposed');
  assert.deepEqual(table.get('s-warm-disposed'), { state: 'bootstrapping' });
  assert.deepEqual(heard, []);

  names.fulfil(PROVIDER, MODEL, MODEL_NAME);
  await settled();
  const { watcher } = composed.get('s-warm-disposed');
  assert.equal(watcher.getHistory().length, 2, 'the queued call was drained before the archive');
  assert.deepEqual(archivedSources('s-warm-disposed'), [{ segment: 0, capture_source: 'dsh-live' }]);
  assert.deepEqual(getStore()._db.prepare('SELECT model FROM profile WHERE session_id = ?').all('s-warm-disposed')
    .map(row => row.model), [MODEL_NAME]);
  assert.deepEqual(table.get('s-warm-disposed'), { state: 'unobserved' });
  assert.deepEqual(heard, ['s-warm-disposed']);
  assert.equal(getLiveLedger('s-warm-disposed'), null);
});

test('a rejected readSession fails the entry as read_session_rejected while a fed header\'s warm-up is in flight', async (t) => {
  captureStderr(t);
  const names = controlledNames();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-read-rejected'));
  table.feed('s-read-rejected', namedLog()[firstOf(namedLog(), 'request/header')]);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);
  reader.reject('s-read-rejected', new Error('snapshot unavailable'));
  await settled();
  assert.deepEqual(table.get('s-read-rejected'), {
    state: 'failed',
    diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'snapshot unavailable' },
  });
});

test('a header on a live entry warms its pair and the following message is fed mapped', async () => {
  const names = controlledNames();
  const log = namedLog();
  const header = firstOf(log, 'request/header');
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-live-header'));
  reader.settle('s-live-header', log.slice(0, header));
  await settled();
  assert.equal(table.get('s-live-header').state, 'live');
  assert.deepEqual(names.calls, []);

  table.feed('s-live-header', log[header]);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);
  names.fulfil(PROVIDER, MODEL, MODEL_NAME);
  await settled();
  for (const event of log.slice(header + 1)) table.feed('s-live-header', event);
  const { watcher } = table.get('s-live-header');
  assert.equal(watcher.getHistory().length, 2);
  assert.equal(watcher.getEpochModel(), MODEL_NAME);
  assert.equal(watcher.getCurrentModel(), MODEL_NAME);
});

test('a message whose pair never resolved is fed under its id', async () => {
  const names = controlledNames();
  const log = namedLog();
  const header = firstOf(log, 'request/header');
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-unresolved'));
  reader.settle('s-unresolved', log.slice(0, header));
  await settled();
  for (const event of log.slice(header)) table.feed('s-unresolved', event);
  const { state, watcher } = table.get('s-unresolved');
  assert.equal(state, 'live');
  assert.equal(watcher.getHistory().length, 2);
  assert.equal(watcher.getEpochModel(), MODEL);
  assert.deepEqual(names.calls, [[PROVIDER, MODEL]]);
});

test('a rejected warm-up never fails the entry, at the install or on the live path', async (t) => {
  const lines = captureStderr(t);
  const rejections = watchUnhandledRejections(t);
  const names = controlledNames();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-warm-rejected'));
  reader.settle('s-warm-rejected', namedLog());
  await settled();
  names.reject(PROVIDER, MODEL);
  await settled();
  const entry = table.get('s-warm-rejected');
  assert.equal(entry.state, 'live');
  assert.equal(entry.watcher.getEpochModel(), MODEL);

  const live = sessionLog([...namedLog(), ...namedLog(OTHER_MODEL)]).slice(namedLog().length);
  table.feed('s-warm-rejected', live[firstOf(live, 'request/header')]);
  names.reject(PROVIDER, OTHER_MODEL);
  await settled();
  for (const event of live.slice(firstOf(live, 'request/header') + 1)) table.feed('s-warm-rejected', event);
  assert.equal(table.get('s-warm-rejected').state, 'live');
  assert.equal(entry.watcher.getCurrentModel(), OTHER_MODEL);
  assert.deepEqual(linesFor(lines, 's-warm-rejected'), []);
  await settled();
  assert.deepEqual(rejections, []);
});

test('a failure that lands during the warm-up stops the bootstrap, which installs nothing', async (t) => {
  captureStderr(t);
  const names = controlledNames();
  const log = namedLog();
  let broken = false;
  const { table, reader, composed } = buildTable({
    modelNames: names.modelNames,
    cacheTtlFor: () => { if (broken) throw new Error('route read broke'); return null; },
  });
  const cut = firstOf(log, 'step/end') + 1;
  table.ensure(sessionOf('s-warm-failed'));
  reader.settle('s-warm-failed', log.slice(0, cut));
  await settled();
  broken = true;
  table.feed('s-warm-failed', log[firstOf(log.slice(cut), 'assistant/message') + cut]);
  assert.deepEqual(table.get('s-warm-failed'), {
    state: 'failed', diagnostic: { scope: 'dsh-host', code: 'frame_application_failed', message: 'route read broke' },
  });

  broken = false;
  names.fulfil(PROVIDER, MODEL, MODEL_NAME);
  await settled();
  assert.equal(table.get('s-warm-failed').state, 'failed');
  assert.equal(composed.get('s-warm-failed').watcher.getHistory().length, 0, 'the snapshot never installed');
});

// A route whose id falls under the fallback chars-per-token row and whose catalog name falls under a calibrated one, so a kept file's row is priced apart under each.
const LOAD_PROVIDER = 'bedrock';
const LOAD_ID = 'us.raw-load-route';
const LOAD_NAME = 'claude-load-route';

const KEPT_LINES = {
  first: ['export function first() {', '  return "the first kept module body";', '}'],
  second: ['export function second() {', '  return "the second kept module body";', '}'],
};

// A load reading the whole of the kept file `name` under the temporary directory, priced under `model`; `serial` keeps its call ids its own.
function keptLoad(name, { model = LOAD_ID, serial = name } = {}) {
  const path = join(dir, `${name}.txt`);
  writeFileSync(path, `${KEPT_LINES[name].join('\n')}\n`);
  return loadMessage({
    route: { provider: LOAD_PROVIDER, model },
    calls: [{
      id: `sw-load-${serial}-1`, name: 'read', arguments: JSON.stringify({ file_path: path, offset: 1, limit: 40 }),
      text: readResultText(path, KEPT_LINES[name]),
    }],
  });
}

const loadHeader = () => {
  const built = requestHeader();
  return { ...built, data: { ...built.data, header: { config: { provider: LOAD_PROVIDER, model: LOAD_ID } } } };
};

// The bucket data of a watcher fed `events` live after an empty snapshot under no model names: the oracle for an entry that measured those events with the routes they carry.
async function bucketsOf(sessionId, events) {
  const { table, reader } = buildTable();
  table.ensure(sessionOf(sessionId));
  reader.settle(sessionId, []);
  await settled();
  for (const event of events) table.feed(sessionId, event);
  return JSON.stringify(table.get(sessionId).watcher.getBucketData());
}

const bucketsOfEntry = (table, sessionId) => JSON.stringify(table.get(sessionId).watcher.getBucketData());

test('a snapshot whose only pair is a load route installs once the pair resolves, with the load priced under its name', async () => {
  const names = controlledNames();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  const log = sessionLog([keptLoad('first')]);
  table.ensure(sessionOf('s-load-named'));
  reader.settle('s-load-named', log);
  await settled();
  assert.deepEqual(table.get('s-load-named'), { state: 'bootstrapping' }, 'the install waits for the load route');
  assert.deepEqual(names.calls, [[LOAD_PROVIDER, LOAD_ID]]);

  names.fulfil(LOAD_PROVIDER, LOAD_ID, LOAD_NAME);
  await settled();
  assert.equal(table.get('s-load-named').state, 'live');
  const named = sessionLog([keptLoad('first', { model: LOAD_NAME })]);
  assert.equal(bucketsOfEntry(table, 's-load-named'), await bucketsOf('s-load-reference-named', named));
  assert.notEqual(bucketsOfEntry(table, 's-load-named'), await bucketsOf('s-load-reference-raw', log), 'the two rows price apart');
});

test('a live load fed while its header\'s resolve is pending stays under the id, and one fed after the resolve settles maps', async () => {
  const names = controlledNames();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-load-live'));
  reader.settle('s-load-live', []);
  await settled();
  const [header, early, late] = sessionLog([loadHeader(), keptLoad('first'), keptLoad('second')]);
  table.feed('s-load-live', header);
  assert.deepEqual(names.calls, [[LOAD_PROVIDER, LOAD_ID]]);
  table.feed('s-load-live', early);

  names.fulfil(LOAD_PROVIDER, LOAD_ID, LOAD_NAME);
  await settled();
  table.feed('s-load-live', late);
  const mappedLate = { ...late, data: { ...late.data, source: { ...late.data.source, route: { provider: LOAD_PROVIDER, model: LOAD_NAME } } } };
  assert.equal(bucketsOfEntry(table, 's-load-live'), await bucketsOf('s-load-live-reference', [header, early, mappedLate]));
  assert.deepEqual(names.calls, [[LOAD_PROVIDER, LOAD_ID]]);
});

test('a live load maps under a pair another session on the host resolved, without a header of its own', async () => {
  const names = controlledNames();
  const { table, reader } = buildTable({ modelNames: names.modelNames });
  table.ensure(sessionOf('s-load-resolver'));
  reader.settle('s-load-resolver', sessionLog([loadHeader()]));
  await settled();
  names.fulfil(LOAD_PROVIDER, LOAD_ID, LOAD_NAME);
  await settled();
  table.ensure(sessionOf('s-load-borrower'));
  reader.settle('s-load-borrower', []);
  await settled();

  const [load] = sessionLog([keptLoad('first')]);
  table.feed('s-load-borrower', load);
  const named = { ...load, data: { ...load.data, source: { ...load.data.source, route: { provider: LOAD_PROVIDER, model: LOAD_NAME } } } };
  assert.equal(bucketsOfEntry(table, 's-load-borrower'), await bucketsOf('s-load-borrower-reference', [named]));
  assert.deepEqual(names.calls, [[LOAD_PROVIDER, LOAD_ID]]);
});

// ── The source-fact index ───────────────────────────────────────────────────────────────────────────────────

// The index `sourceFactOf` builds from a whole log, the one an entry's index must equal.
const factsOf = log => new Map(log.map(event => [event.seq, sourceFactOf(event)]));

test('a bootstrap snapshot makes the source index of its events, and a session the table lacks has none', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  assert.equal(table.sourceFacts('s-none'), null);
  table.ensure(sessionOf('s-index'));
  assert.equal(table.sourceFacts('s-index'), null, 'unready until the snapshot has merged');

  reader.settle('s-index', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  assert.deepEqual(table.sourceFacts('s-index'), factsOf(log.slice(0, FIRST_STEP_END + 1)));
  assert.ok([...table.sourceFacts('s-index').values()].some(fact => fact.step !== null), 'the facts of the snapshot are not all empty');
});

test('a live entry adds each fed event to the source index', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-live-index'));
  reader.settle('s-live-index', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  for (const event of log.slice(FIRST_STEP_END + 1)) table.feed('s-live-index', event);

  assert.equal(table.get('s-live-index').state, 'live');
  assert.deepEqual(table.sourceFacts('s-live-index'), factsOf(log));
});

test('the index of a snapshot with the events fed before it arrived, overlapping it or not, equals the index of the whole log', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-overlap'));
  // The first event of a session is fed to the entry it ensures, after the snapshot read it started already holds it.
  for (const event of log.slice(FIRST_STEP_END - 1)) table.feed('s-overlap', event);
  assert.equal(table.sourceFacts('s-overlap'), null, 'fed events alone do not make the index ready');

  reader.settle('s-overlap', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  assert.equal(table.get('s-overlap').state, 'live');
  assert.deepEqual(table.sourceFacts('s-overlap'), factsOf(log));
});

test('events fed after the measurement failed still reach the source index', async (t) => {
  captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  let throwNext = false;
  const { table, reader } = buildTable({
    adapt: composition => {
      const { watcher } = composition;
      const apply = watcher.applyHarnessFrame.bind(watcher);
      watcher.applyHarnessFrame = (frame) => {
        if (throwNext) { throwNext = false; throw new Error('frame broke'); }
        return apply(frame);
      };
      return composition;
    },
  });
  table.ensure(sessionOf('s-failed-index'));
  reader.settle('s-failed-index', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  table.feed('s-failed-index', log[FIRST_STEP_END + 1]);
  throwNext = true;
  table.feed('s-failed-index', log[FIRST_STEP_END + 2]);
  assert.equal(table.get('s-failed-index').state, 'failed');

  for (const event of log.slice(FIRST_STEP_END + 3)) table.feed('s-failed-index', event);

  assert.deepEqual(table.sourceFacts('s-failed-index'), factsOf(log));
});

test('the snapshot merge makes the index ready before the model-name warm-up has settled', async () => {
  const log = reusedCallIdAcrossSteps();
  const warming = Promise.withResolvers();
  const { table, reader } = buildTable({
    modelNames: { warm: () => warming.promise, pairsOf: () => [], mapEvent: event => event },
  });
  table.ensure(sessionOf('s-warming'));

  reader.settle('s-warming', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  assert.deepEqual(table.get('s-warming'), { state: 'bootstrapping' }, 'the measurement is still waiting for the names');
  assert.deepEqual(table.sourceFacts('s-warming'), factsOf(log.slice(0, FIRST_STEP_END + 1)));
  warming.resolve([]);
  await settled();
  assert.equal(table.get('s-warming').state, 'live');
});

test('a snapshot whose measurement install fails leaves the index ready', async (t) => {
  captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable({
    adapt: composition => {
      composition.watcher.applyHarnessFrame = () => { throw new Error('install broke'); };
      return composition;
    },
  });
  table.ensure(sessionOf('s-install-failed'));

  reader.settle('s-install-failed', log.slice(0, FIRST_STEP_END + 1));
  await settled();

  assert.equal(table.get('s-install-failed').state, 'failed');
  assert.deepEqual(table.sourceFacts('s-install-failed'), factsOf(log.slice(0, FIRST_STEP_END + 1)));
  table.feed('s-install-failed', log[FIRST_STEP_END + 1]);
  assert.deepEqual(table.sourceFacts('s-install-failed'), factsOf(log.slice(0, FIRST_STEP_END + 2)));
});

test('a rejected initial snapshot leaves the index unready and diagnosed, fed events do not make it ready and nothing retries, until an entry rebuilt from a read that succeeds', async (t) => {
  const lines = captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-unavailable'));
  reader.reject('s-unavailable', new Error('snapshot unavailable'));
  await settled();

  for (const event of log) table.feed('s-unavailable', event);
  await settled();

  assert.equal(table.get('s-unavailable').state, 'failed');
  assert.equal(table.sourceFacts('s-unavailable'), null);
  assert.deepEqual(linesFor(lines, 's-unavailable'), [{
    sessionId: 's-unavailable', scope: 'dsh-host', code: 'read_session_rejected', message: 'snapshot unavailable',
  }]);
  assert.deepEqual(reader.calls, ['s-unavailable'], 'the failed read is not retried');

  table.dispose('s-unavailable');
  table.ensure(sessionOf('s-unavailable'));
  reader.settle('s-unavailable', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  assert.deepEqual(table.sourceFacts('s-unavailable'), factsOf(log.slice(0, FIRST_STEP_END + 1)), 'the rebuilt entry holds the facts of its own read alone');
});

test('a disposed entry drops its index, whether it was live or still bootstrapping', async () => {
  const log = reusedCallIdAcrossSteps();
  const { table, reader } = buildTable();
  table.ensure(sessionOf('s-gone'));
  reader.settle('s-gone', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  assert.notEqual(table.sourceFacts('s-gone'), null);

  table.dispose('s-gone');
  assert.equal(table.sourceFacts('s-gone'), null);
  table.ensure(sessionOf('s-gone'));
  reader.settle('s-gone', []);
  await settled();
  assert.deepEqual(table.sourceFacts('s-gone'), new Map(), 'none of the disposed entry\'s facts come back');

  table.ensure(sessionOf('s-gone-early'));
  table.dispose('s-gone-early');
  reader.settle('s-gone-early', log.slice(0, FIRST_STEP_END + 1));
  await settled();
  assert.equal(table.sourceFacts('s-gone-early'), null);
});

// ── The held view ───────────────────────────────────────────────────────────────────────────────────────────

test('an entry answers its own composition\'s held view of a slice and a range whether its measurement is bootstrapping, live or failed, and a session the table lacks has none', async (t) => {
  captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const calls = [];
  const { table, reader } = buildTable({
    adapt: (composition, sessionId) => ({
      ...composition, heldView: (events, range) => { calls.push([sessionId, events, range]); return { sessionId }; },
    }),
  });
  const range = [3, 4, 5];
  assert.equal(table.heldView('s-none', log, range), null);
  table.ensure(sessionOf('s-held'));
  table.ensure(sessionOf('s-held-failed'));
  assert.deepEqual(table.heldView('s-held', log, range), { sessionId: 's-held' }, 'bootstrapping');
  reader.settle('s-held', log);
  reader.reject('s-held-failed', new Error('read refused'));
  await settled();
  assert.equal(table.get('s-held').state, 'live');
  assert.equal(table.get('s-held-failed').state, 'failed');
  assert.deepEqual(table.heldView('s-held', log, range), { sessionId: 's-held' }, 'live');
  assert.deepEqual(table.heldView('s-held-failed', log, range), { sessionId: 's-held-failed' }, 'failed');
  assert.ok(calls.every(([, events, seqs]) => events === log && seqs === range), 'the slice and the range reach the view as they are');
  table.dispose('s-held');
  assert.equal(table.heldView('s-held', log, range), null, 'disposal drops it with the entry');
});
