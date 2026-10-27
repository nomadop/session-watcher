// The frame context the shared SessionWatcher builds for each frame: the attribution store bound to the
// session the frame belongs to, handed to native interpretation through the Projection. The real shared
// Projection runs here with interpreters that do what a consumer of the frame context does — ask for the
// record of the call and offer one to be kept — so what is asserted is what reaches the store and the Engine,
// and what a store failure turns into on the frame.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../lib/session-watcher.js';
import { createMeasurementProjection } from '../lib/measurement-projection.js';

const NOOP_POLICY = { resolve: () => ({ selectedByDefault: true, defaultDiscardReason: null }), infer: () => ({}) };
const ENRICHMENT = { warm: () => {} };
const STORED_RECORD = { v: 1, effects: [], residual: null };

// An Engine that keeps what it ingested; nothing here closes a segment, so nothing else of it is read.
function makeEngine() {
  const engine = {
    records: [],
    ingest(records) {
      engine.records.push(...records);
      return { newCalls: 0, revisedCalls: 0, newResourceKeys: [], closedSegments: [], diagnostics: [] };
    },
    closeCurrentSegment: () => ({ closedSegments: [], diagnostics: [] }),
  };
  return engine;
}

// The two attribution methods in the real store's shapes: a recall answers the record object or null, a
// remember answers nothing. A throw happens after the call is logged, so a failed attempt is still visible
// in `calls` while `recorded` holds only what was kept.
function makeStore({ recallThrows = false, rememberThrows = false, recalled = null } = {}) {
  const store = {
    calls: [],
    recorded: [],
    recallAttribution(sessionId, toolUseId) {
      store.calls.push({ method: 'recall', sessionId, toolUseId });
      if (recallThrows) throw new Error('database is locked');
      return recalled;
    },
    rememberAttribution(sessionId, toolUseId, record) {
      store.calls.push({ method: 'remember', sessionId, toolUseId });
      if (rememberThrows) throw new Error('disk I/O error');
      store.recorded.push({ sessionId, toolUseId, record });
    },
  };
  return store;
}

// A call's interpretation as the first consumer of the frame context performs it: recall, then offer a
// record. An absent context reads as an empty one, as the spec has it. What it saw of the context is logged,
// and the effect it returns is how a record that still ingests shows up in the Engine.
function probeInterpreters(probes) {
  return {
    interpretToolUse(observation, context, { frameCtx = {} }) {
      const { toolUseId } = observation;
      const recalled = frameCtx.recall?.(toolUseId) ?? null;
      frameCtx.remember?.(toolUseId, { v: 1, effects: [], residual: null, via: toolUseId });
      probes.push({
        toolUseId,
        recalled,
        hasRecall: typeof frameCtx.recall === 'function',
        hasRemember: typeof frameCtx.remember === 'function',
      });
      return {
        pending: null,
        effects: [{
          access: 'read',
          overheadTokens: 0,
          spentTokens: 1,
          impacts: [{
            resourceKey: `/repo/${toolUseId}.js`,
            mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 1 }] },
          }],
        }],
        residuals: [],
        telemetry: null,
      };
    },
  };
}

function build({ sessionId = 'sid-a', store = makeStore() } = {}) {
  const engine = makeEngine();
  const probes = [];
  const watcher = new SessionWatcher({
    sessionId,
    sourceLocator: '/t/a.jsonl',
    projectId: '/proj',
    projectRoot: '/proj',
    turnNotesRoot: '/state/turn-notes',
    resourcePolicy: NOOP_POLICY,
    resourceEnrichment: ENRICHMENT,
    handoffComposition: {},
    loaderVersion: '1.0.0',
    store,
    dialogueSource: { read: async () => ({ status: 'unavailable', observations: [] }) },
    dialogueProjection: {},
    createEngine: () => engine,
    createMeasurementProjection: () => createMeasurementProjection({
      scope: 'probe-measurement-projection',
      context: {},
      captureSources: { live: 'probe-live', replay: 'probe-replay' },
      ...probeInterpreters(probes),
    }),
    modelPolicyFor: () => ({ ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 1, pricing: {} }),
    now: () => 4242,
  });
  return { watcher, store, engine, probes };
}

const toolUse = toolUseId => ({ type: 'tool-use', toolUseId, messageId: 'msg-1' });

const frame = (toolUseIds, over = {}) => ({
  transition: 'append',
  batches: [toolUseIds.map(toolUse)],
  sourceObserved: true,
  captureMode: 'live',
  ...over,
});

const effectKeys = engine => engine.records.filter(record => record.type === 'effect')
  .map(record => record.impacts[0].resourceKey);

describe('which frames can write an attribution record', () => {
  const FRAMES = [
    ['append and live', { transition: 'append', captureMode: 'live' }, true],
    ['append and replay', { transition: 'append', captureMode: 'replay' }, false],
    ['append with no captureMode', { transition: 'append', captureMode: undefined }, false],
    ['replace claiming live', { transition: 'replace', captureMode: 'live', sourceLocator: '/t/b.jsonl' }, false],
    ['replace and replay', { transition: 'replace', captureMode: 'replay', sourceLocator: '/t/b.jsonl' }, false],
    ['rotate', { transition: 'rotate', captureMode: 'live', sessionId: 'sid-b', sourceLocator: '/t/b.jsonl' }, false],
  ];
  for (const [name, over, writes] of FRAMES) {
    test(`${name}: recall${writes ? ' and remember' : ' only'}`, () => {
      const { watcher, store, probes } = build({ store: makeStore({ recalled: STORED_RECORD }) });
      watcher.applyHarnessFrame(frame(['t1'], over));

      const sessionId = over.transition === 'rotate' ? 'sid-b' : 'sid-a';
      assert.deepEqual(store.calls.map(call => call.method), writes ? ['recall', 'remember'] : ['recall']);
      assert.ok(store.calls.every(call => call.sessionId === sessionId && call.toolUseId === 't1'));
      assert.deepEqual(probes.map(({ hasRecall, hasRemember }) => [hasRecall, hasRemember]), [[true, writes]]);
      assert.deepEqual(probes[0].recalled, STORED_RECORD, 'the store answers the interpreter');
      assert.deepEqual(store.recorded.map(kept => kept.record.via), writes ? ['t1'] : []);
    });
  }
});

describe('the session a frame is bound to', () => {
  test('a rotate binds its own batches and the live appends after it to the new session', () => {
    const { watcher, store } = build();
    watcher.applyHarnessFrame(frame(['t1']));
    watcher.applyHarnessFrame(frame(['t2'], { transition: 'rotate', sessionId: 'sid-b', sourceLocator: '/t/b.jsonl' }));
    watcher.applyHarnessFrame(frame(['t3']));

    assert.deepEqual(store.calls, [
      { method: 'recall', sessionId: 'sid-a', toolUseId: 't1' },
      { method: 'remember', sessionId: 'sid-a', toolUseId: 't1' },
      { method: 'recall', sessionId: 'sid-b', toolUseId: 't2' },
      { method: 'recall', sessionId: 'sid-b', toolUseId: 't3' },
      { method: 'remember', sessionId: 'sid-b', toolUseId: 't3' },
    ]);
  });

  for (const empty of [null, '']) {
    test(`a watcher with session ${JSON.stringify(empty)} makes no store call until a rotate names one`, () => {
      const { watcher, store, engine, probes } = build({ sessionId: empty });
      watcher.applyHarnessFrame(frame(['t1']));

      assert.deepEqual(store.calls, []);
      assert.deepEqual(probes.map(({ hasRecall, hasRemember }) => [hasRecall, hasRemember]), [[false, false]]);
      assert.deepEqual(effectKeys(engine), ['/repo/t1.js'], 'the frame still ingests');

      watcher.applyHarnessFrame(frame([], { transition: 'rotate', sessionId: 'sid-b', sourceLocator: '/t/b.jsonl' }));
      watcher.applyHarnessFrame(frame(['t2']));
      assert.deepEqual(store.calls.map(call => [call.method, call.sessionId]),
        [['recall', 'sid-b'], ['remember', 'sid-b']]);
    });
  }
});

describe('a store failure on a frame', () => {
  test('a throwing recall is a miss plus a diagnostic, and the frame ingests', () => {
    const { watcher, store, engine, probes } = build({ store: makeStore({ recallThrows: true }) });
    const result = watcher.applyHarnessFrame(frame(['t1', 't2']));

    assert.deepEqual(probes.map(probe => probe.recalled), [null, null]);
    assert.deepEqual(effectKeys(engine), ['/repo/t1.js', '/repo/t2.js']);
    assert.deepEqual(result.diagnostics.map(({ scope, code }) => [scope, code]),
      [['session-watcher', 'attribution_recall_failed'], ['session-watcher', 'attribution_recall_failed']]);
    assert.match(result.diagnostics[0].message, /database is locked/);
    assert.deepEqual(store.recorded.map(kept => kept.toolUseId), ['t1', 't2'], 'a miss still lets the call be kept');
  });

  test('a throwing remember writes nothing and is a diagnostic, and the frame ingests', () => {
    const { watcher, store, engine } = build({ store: makeStore({ rememberThrows: true }) });
    const result = watcher.applyHarnessFrame(frame(['t1', 't2']));

    assert.deepEqual(store.recorded, []);
    assert.equal(store.calls.filter(call => call.method === 'remember').length, 2, 'each write was attempted');
    assert.deepEqual(effectKeys(engine), ['/repo/t1.js', '/repo/t2.js']);
    assert.deepEqual(result.diagnostics.map(({ scope, code }) => [scope, code]),
      [['session-watcher', 'attribution_remember_failed'], ['session-watcher', 'attribution_remember_failed']]);
    assert.match(result.diagnostics[0].message, /disk I\/O error/);
  });

  test('a healthy store leaves the frame with no diagnostic', () => {
    const { watcher } = build();
    assert.deepEqual(watcher.applyHarnessFrame(frame(['t1'])).diagnostics, []);
  });
});
