// Ordered close and failure behaviour of the shared SessionWatcher. Every case here is about what the
// application does when one of its collaborators refuses: which order the archival steps run in, which
// diagnostics reach the caller's own result, and what the next segment inherits. The Projection fake
// models the real sidecar lifecycle — facts accumulate per observation and `finishSegment` swaps in a new
// sidecar — because the assertions about the next segment's telemetry are exactly about that swap.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../lib/session-watcher.js';

const NOOP_POLICY = { resolve: () => ({ selectedByDefault: true, defaultDiscardReason: null }), infer: () => ({}) };
const ENRICHMENT = { warm: () => {}, activeSymbols: () => null, symbolRanges: () => null, resolveSymbols: async () => ({ resolved: [], stale: [] }) };

function closedSegment(over = {}) {
  return {
    segment: 0,
    epochModel: 'model-a',
    steps: [{ id: 's1', foldedSeq: 1, timestamp: 500, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }],
    metrics: { bTotal: 10, lPeak: 20 },
    paths: [],
    ...over,
  };
}

// An Engine whose ingest and close answers come from a script, recording every record it ever saw.
function makeEngine(script = {}) {
  const engine = {
    records: [],
    closeCalls: 0,
    ingest(records) {
      engine.records.push(...records);
      const answer = script.ingest ? script.ingest(records, engine) : null;
      return { newCalls: 0, revisedCalls: 0, newResourceKeys: [], closedSegments: [], diagnostics: [], ...(answer || {}) };
    },
    closeCurrentSegment() {
      engine.closeCalls += 1;
      if (script.closeThrows) throw new Error('engine finalization failed');
      const answer = script.close ? script.close(engine) : null;
      return { closedSegments: [], diagnostics: [], ...(answer || {}) };
    },
    getStatus: () => ({ L: 0, B: 0, bDefault: 0, g: 1, x: 1, dhat: null, xSweet: null, u: null, pp: null, mf: null, br: null, model: null, latestMeasuredModel: null, cRatio: null, segment: 0, apiCalls: 0, turnSeq: 0, usage: null, rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } }),
    getHistory: () => [],
    getBucketData: () => ({ dead: 0, paths: [], residual: [], totalB: 0, totalL: 0, bDefault: 0, totalResidualRaw: 0, totalResidual: 0, currentTurnSeq: 0, segment: 0 }),
    getHandoffMeasurement: () => ({ segment: 0, turnSeq: 0, epochModel: null, measurement: {}, paths: [] }),
    readRateLampFrame: () => ({ status: {}, progress: {}, samples: [], turnSeq: 0, foldedCallSeq: 0 }),
    replaceResourceOverrides: () => ({ changed: false, warnings: [], diagnostics: [] }),
    refreshReadPolicies: () => ({ changed: false, diagnostics: [] }),
  };
  return engine;
}

// A Projection with the real sidecar lifecycle: `project` appends this observation's tag to the live
// sidecar; `finishSegment` installs a new sidecar and reports the closing one.
function makeProjection(locator, script = {}) {
  let sidecar = [];
  const projection = {
    locator,
    seen: [],
    finishes: [],
    liveSidecar: () => sidecar.slice(),
    project(observation) {
      if (script.projectThrowsOn && script.projectThrowsOn(observation)) throw new Error('projection invariant');
      projection.seen.push(observation.tag ?? observation.type);
      // A boundary is the segment marker, not a fact of it; everything else the segment observes is.
      if (observation.tag && observation.type !== 'epoch-boundary') sidecar.push(observation.tag);
      const answer = script.project ? script.project(observation) : null;
      return { records: [], diagnostics: [], ...(answer || {}) };
    },
    finishSegment(closed, options) {
      const closing = sidecar;
      sidecar = [];
      projection.finishes.push({ closed, options, consumed: closing.slice() });
      if (script.joinFails) {
        return { artifact: null, diagnostics: [{ scope: 'projection', code: 'segment_telemetry_join_failed', message: 'join failed' }] };
      }
      if (closed == null) return { artifact: null, diagnostics: [] };
      return { artifact: { captureSource: 'cc-live', payload: { steps: closing.slice(), events: [] } }, diagnostics: [] };
    },
  };
  return projection;
}

function makeStore(script = {}) {
  const store = {
    profiles: [],
    telemetry: [],
    archiveSegmentProfile(sessionId, segment, snapshot, paths) {
      store.profiles.push({ sessionId, segment, snapshot, paths });
      if (script.profileThrows) throw new Error('profile persistence failed');
      return { status: script.profileStatus ?? 'archived' };
    },
    archiveSegmentTelemetry(sessionId, segment, artifact) {
      store.telemetry.push({ sessionId, segment, artifact });
      if (script.telemetryThrows) throw new Error('telemetry persistence failed');
      return { status: script.telemetryStatus ?? 'complete' };
    },
    findPendingHandoffsByProject: () => ({ status: 'none' }),
    deliverHandoffByToken: () => null,
    listTurnNotes: () => [],
    upsertTurnNotes: () => {},
  };
  return store;
}

function build(over = {}) {
  const store = over.store ?? makeStore();
  const projections = [];
  const engines = [];
  const watcher = new SessionWatcher({
    sessionId: 'sid',
    sourceLocator: '/t/a.jsonl',
    projectId: '/proj',
    projectRoot: '/proj',
    turnNotesRoot: '/state/turn-notes',
    resourcePolicy: NOOP_POLICY,
    resourceEnrichment: ENRICHMENT,
    handoffComposition: {},
    loaderVersion: '1.0.0',
    store,
    dialogueSource: { read: () => ({ status: 'unavailable', observations: [] }) },
    dialogueProjection: {},
    createEngine: () => { const e = makeEngine(over.engineScript ?? {}); engines.push(e); return e; },
    createMeasurementProjection: (locator) => { const p = makeProjection(locator, over.projectionScript ?? {}); projections.push(p); return p; },
    modelPolicyFor: () => ({ ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 1, pricing: {} }),
    now: () => 4242,
  });
  return { watcher, store, projections, engines };
}

const append = (batches, over = {}) => ({ transition: 'append', batches, sourceObserved: true, captureMode: 'live', ...over });

// Projection scripts that turn a tagged observation into one record type.
const epochOn = (tag) => (observation) => ({ records: [observation.tag === tag ? { type: 'epoch' } : { type: 'step' }] });

describe('ordered processing', () => {
  test('batches and their observations are processed in source order', () => {
    const { watcher, projections, engines } = build({
      projectionScript: { project: (o) => ({ records: [{ type: 'step', id: o.tag }] }) },
    });
    watcher.applyHarnessFrame(append([
      [{ type: 'usage', tag: 'a1' }, { type: 'usage', tag: 'a2' }],
      [{ type: 'usage', tag: 'b1' }],
    ]));
    assert.deepEqual(projections[0].seen, ['a1', 'a2', 'b1']);
    assert.deepEqual(engines[0].records.map(r => r.id), ['a1', 'a2', 'b1']);
  });

  test('Engine ingest() and explicit closeCurrentSegment() results enter the same closed-segment consumer', () => {
    const { watcher, store, projections } = build({
      engineScript: {
        ingest: (records) => (records[0].type === 'epoch' ? { closedSegments: [closedSegment({ segment: 1 })] } : {}),
        close: () => ({ closedSegments: [closedSegment({ segment: 2 })] }),
      },
      projectionScript: { project: epochOn('boundary') },
    });
    watcher.applyHarnessFrame(append([[{ type: 'epoch-boundary', tag: 'boundary' }]]));
    watcher.closeCurrentSegment();
    assert.deepEqual(store.profiles.map(p => p.segment), [1, 2]);
    assert.deepEqual(store.telemetry.map(t => t.segment), [1, 2]);
    assert.deepEqual(projections[0].finishes.map(f => f.closed.segment), [1, 2]);
  });

  test('a Projection exception propagates and no later observation in the frame is projected', () => {
    const { watcher, projections, engines } = build({
      projectionScript: {
        projectThrowsOn: (o) => o.tag === 'boom',
        project: (o) => ({ records: [{ type: 'step', id: o.tag }] }),
      },
    });
    assert.throws(() => watcher.applyHarnessFrame(append([
      [{ type: 'usage', tag: 'first' }, { type: 'usage', tag: 'boom' }, { type: 'usage', tag: 'never' }],
      [{ type: 'usage', tag: 'also-never' }],
    ])), /projection invariant/);
    assert.deepEqual(projections[0].seen, ['first']);
    assert.deepEqual(engines[0].records.map(r => r.id), ['first']);
  });

  test('a reentrant applyHarnessFrame throws, changes no state, and leaves a later call working', () => {
    let watcherRef = null;
    let reentryError = null;
    const { watcher, projections } = build({
      projectionScript: {
        project: (o) => {
          if (o.tag === 'reenter') {
            try { watcherRef.applyHarnessFrame(append([[{ type: 'usage', tag: 'inner' }]])); }
            catch (error) { reentryError = error; }
          }
          return { records: [] };
        },
      },
    });
    watcherRef = watcher;
    watcher.applyHarnessFrame(append([[{ type: 'usage', tag: 'reenter' }]]));
    assert.match(reentryError.message, /reentrant/);
    assert.deepEqual(projections[0].seen, ['reenter'], 'the inner frame projected nothing');
    watcher.applyHarnessFrame(append([[{ type: 'usage', tag: 'after' }]]));
    assert.deepEqual(projections[0].seen, ['reenter', 'after'], 'a later call still works');
  });

  test('terminal closeCurrentSegment is not represented as a source frame', () => {
    const { watcher, engines, projections } = build({ engineScript: { close: () => ({ closedSegments: [closedSegment()] }) } });
    watcher.closeCurrentSegment();
    assert.deepEqual(engines[0].records, [], 'no epoch record was synthesized');
    assert.deepEqual(projections[0].seen, [], 'no observation was projected');
    assert.equal(engines[0].closeCalls, 1);
  });
});

describe('finalization failure', () => {
  test('blocking Engine finalization failure throws, leaves the epoch open, emits no artifact, and leaves the closing sidecar unconsumed', () => {
    const { watcher, store, projections } = build({ engineScript: { closeThrows: true } });
    watcher.applyHarnessFrame(append([[{ type: 'usage', tag: 'fact' }]]));
    assert.throws(() => watcher.closeCurrentSegment(), /engine finalization failed/);
    assert.deepEqual(projections[0].finishes, [], 'finishSegment was never called');
    assert.deepEqual(projections[0].liveSidecar(), ['fact'], 'the closing sidecar stays unconsumed');
    assert.deepEqual(store.profiles, []);
    assert.deepEqual(store.telemetry, []);
  });

  const emptyClose = { close: () => ({ closedSegments: [] }), ingest: (records) => (records[0].type === 'epoch' ? { closedSegments: [] } : {}) };

  test('a tool-use without usage followed by an empty epoch consumes the closing sidecar, emits no archive, and leaves the next segment clean', () => {
    const { watcher, store, projections } = build({ engineScript: emptyClose, projectionScript: { project: epochOn('boundary') } });
    watcher.applyHarnessFrame(append([[{ type: 'tool-use', tag: 'orphan-tool' }, { type: 'epoch-boundary', tag: 'boundary' }]]));
    assert.equal(projections[0].finishes.length, 1);
    assert.equal(projections[0].finishes[0].closed, null);
    assert.deepEqual(projections[0].finishes[0].consumed, ['orphan-tool'], 'the closing sidecar was consumed');
    assert.deepEqual(store.profiles, []);
    assert.deepEqual(store.telemetry, []);
    assert.deepEqual(projections[0].liveSidecar(), [], 'the next segment starts with an empty sidecar');
  });

  test('consecutive empty epochs and an empty terminal close each consume the closing sidecar and emit no archive', () => {
    const { watcher, store, projections } = build({ engineScript: emptyClose, projectionScript: { project: epochOn('boundary') } });
    watcher.applyHarnessFrame(append([[{ type: 'epoch-boundary', tag: 'boundary' }, { type: 'epoch-boundary', tag: 'boundary' }]]));
    watcher.closeCurrentSegment();
    assert.deepEqual(projections[0].finishes.map(f => f.closed), [null, null, null]);
    assert.deepEqual(store.profiles, []);
    assert.deepEqual(store.telemetry, []);
  });

  test('the next non-empty segment carries none of a discarded segment\'s telemetry', () => {
    let closed = false;
    const { watcher, store, projections } = build({
      engineScript: {
        ingest: (records) => (records[0].type === 'epoch' ? { closedSegments: [] } : {}),
        close: () => { closed = true; return { closedSegments: [closedSegment({ segment: 5 })] }; },
      },
      projectionScript: { project: epochOn('boundary') },
    });
    watcher.applyHarnessFrame(append([[{ type: 'tool-use', tag: 'old-fact' }, { type: 'epoch-boundary', tag: 'boundary' }, { type: 'tool-use', tag: 'new-fact' }]]));
    watcher.closeCurrentSegment();
    assert.equal(closed, true);
    assert.deepEqual(store.telemetry[0].artifact.payload.steps, ['new-fact']);
  });
});

describe('archival order and persistence failure', () => {
  function orderedHarness(storeScript = {}) {
    const order = [];
    const store = makeStore(storeScript);
    const wrappedProfile = store.archiveSegmentProfile.bind(store);
    const wrappedTelemetry = store.archiveSegmentTelemetry.bind(store);
    store.archiveSegmentProfile = (...args) => { order.push('profile'); return wrappedProfile(...args); };
    store.archiveSegmentTelemetry = (...args) => { order.push('telemetry'); return wrappedTelemetry(...args); };
    const harness = build({
      store,
      engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
      projectionScript: {
        joinFails: storeScript.joinFails === true,
        finishOrder: order,
      },
    });
    // The Projection fake records its own step in the same list.
    const projection = harness.projections[0];
    const innerFinish = projection.finishSegment.bind(projection);
    projection.finishSegment = (...args) => { order.push('finishSegment'); return innerFinish(...args); };
    return { ...harness, order, store };
  }

  test('successful archival orders finishSegment, profile persistence and telemetry persistence', () => {
    const { watcher, order } = orderedHarness();
    watcher.closeCurrentSegment();
    assert.deepEqual(order, ['finishSegment', 'profile', 'telemetry']);
  });

  test('sidecar join failure reaches the returned diagnostics and does not block profile persistence', () => {
    const { watcher, store } = build({
      engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
      projectionScript: { joinFails: true },
    });
    const { diagnostics } = watcher.closeCurrentSegment();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'segment_telemetry_join_failed');
    assert.equal(store.profiles.length, 1, 'the profile was still persisted');
    assert.deepEqual(store.telemetry, [], 'no artifact means no telemetry call');
  });

  test('profile persistence failure skips telemetry persistence, reports a diagnostic, and leaves the next segment clean', () => {
    const store = makeStore({ profileThrows: true });
    const { watcher, projections } = build({
      store,
      engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
    });
    watcher.applyHarnessFrame(append([[{ type: 'tool-use', tag: 'closing-fact' }]]));
    const { diagnostics } = watcher.closeCurrentSegment();
    assert.deepEqual(store.telemetry, []);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].scope, 'session-watcher');
    assert.match(diagnostics[0].code, /profile/);
    assert.deepEqual(projections[0].liveSidecar(), [], 'the closing facts are gone from the next segment');
  });

  for (const profileStatus of ['archived', 'already_archived']) {
    test(`a ${profileStatus} profile result attempts a present telemetry artifact exactly once`, () => {
      const { watcher, store } = build({
        store: makeStore({ profileStatus }),
        engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
      });
      watcher.closeCurrentSegment();
      assert.equal(store.telemetry.length, 1);
    });
  }

  for (const telemetryStatus of ['complete', 'complete_empty', 'skipped_stale']) {
    test(`a ${telemetryStatus} telemetry result reports no diagnostic`, () => {
      const { watcher } = build({
        store: makeStore({ telemetryStatus }),
        engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
      });
      assert.deepEqual(watcher.closeCurrentSegment().diagnostics, []);
    });
  }

  test('a failed_retryable telemetry result reports a diagnostic and leaves the next segment clean', () => {
    const { watcher, projections } = build({
      store: makeStore({ telemetryStatus: 'failed_retryable' }),
      engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
    });
    watcher.applyHarnessFrame(append([[{ type: 'tool-use', tag: 'closing-fact' }]]));
    const { diagnostics } = watcher.closeCurrentSegment();
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].scope, 'session-watcher');
    assert.match(diagnostics[0].code, /telemetry/);
    assert.deepEqual(projections[0].liveSidecar(), []);
  });

  test('a thrown telemetry persistence error reports a diagnostic and does not propagate', () => {
    const { watcher } = build({
      store: makeStore({ telemetryThrows: true }),
      engineScript: { close: () => ({ closedSegments: [closedSegment({ segment: 3 })] }) },
    });
    const { diagnostics } = watcher.closeCurrentSegment();
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].code, /telemetry/);
  });
});
