// The shared SessionWatcher application Interface, driven entirely through fakes: a fake Engine,
// Measurement Projection, Store and DialogueSource. What is under test here is the application's own
// ownership — frame transitions, which runtime a batch reaches, when a segment closes, what the archive
// call receives, and the exact shape of every named read. Measurement itself belongs to the Engine tests
// and native interpretation to the Projection's, so nothing here asserts a token number.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../lib/session-watcher.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

const EMPTY_INGEST = { newCalls: 0, revisedCalls: 0, newResourceKeys: [], closedSegments: [], diagnostics: [] };

function closedSegment(over = {}) {
  return {
    segment: 0,
    epochModel: 'model-a',
    steps: [{ id: 's1', foldedSeq: 1, timestamp: 500, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }],
    metrics: { bTotal: 10, lPeak: 20, cRatio: 12.5, turns: 2 },
    paths: [{ path: '/repo/a.js', tokens: 7 }],
    ...over,
  };
}

// One Engine whose ingest answer is scripted per record type and whose reads return fixed detached values.
function makeEngine(script = {}) {
  const engine = {
    id: script.id ?? 'engine',
    ingested: [],
    closeCalls: 0,
    overrideReplacements: [],
    refreshes: 0,
    bucket: script.bucket ?? { dead: 0, paths: [], residual: [], totalB: 0, totalL: 0, bDefault: 0, totalResidualRaw: 0, totalResidual: 0, currentTurnSeq: 0, segment: 0 },
    status: script.status ?? {},
    ingest(records) {
      engine.ingested.push(...records);
      const answer = script.ingest ? script.ingest(records, engine) : null;
      return { ...EMPTY_INGEST, newResourceKeys: [], closedSegments: [], diagnostics: [], ...(answer || {}) };
    },
    closeCurrentSegment() {
      engine.closeCalls += 1;
      if (script.closeThrows) throw new Error('engine finalization failed');
      const answer = script.close ? script.close(engine) : null;
      return { closedSegments: [], diagnostics: [], ...(answer || {}) };
    },
    getStatus() {
      return {
        L: 100, B: 80, bDefault: 70, g: 5, x: 1.4, dhat: 0.2, xSweet: 1.2, u: 2, pp: 0.25,
        mf: 0.3, br: 0.11, model: 'epoch-model', latestMeasuredModel: 'latest-model', cRatio: 12.5,
        segment: 3, apiCalls: 2, turnSeq: 9, usage: null,
        rateLamp: { reliable: true, basis: 'fullCarry' },
        ...engine.status,
      };
    },
    getHistory() {
      return [{
        ts: 1000, segment: 0, L: 10, B: 5, x: 2, bDefault: 4, u: 2, pp: 0.25, g: 1, miss: false,
        cacheRead: 3, cacheWrite: 4, turnSeq: 1, foldedSeq: 1,
      }];
    },
    getBucketData() { return structuredClone(engine.bucket); },
    getHandoffMeasurement() {
      return script.handoffMeasurement ?? {
        segment: 3, turnSeq: 9, epochModel: 'epoch-model',
        measurement: { L: 100, B: 80, bDefault: 70, g: 5, mf: 0.3, br: 0.11, u: 2, pp: 0.25, x: 1.4, dhat: 0.2, cRatio: 12.5, dead: 40, sessionFloor: 45 },
        paths: [],
      };
    },
    readRateLampFrame(sinceFoldedSeq) {
      return { status: { reliable: true }, progress: { segment: 3, measuredCalls: 2, sinceFoldedSeq }, samples: [], turnSeq: 9, foldedCallSeq: 4 };
    },
    replaceResourceOverrides(overrides) {
      engine.overrideReplacements.push(overrides);
      return { changed: true, warnings: script.overrideWarnings ?? [], diagnostics: [] };
    },
    refreshReadPolicies() { engine.refreshes += 1; return { changed: true, diagnostics: [] }; },
  };
  return engine;
}

// One Projection that records every observation it saw and every finishSegment call.
function makeProjection(locator, script = {}) {
  const projection = {
    locator,
    seen: [],
    finishes: [],
    project(observation) {
      if (script.projectThrowsOn && script.projectThrowsOn(observation)) throw new Error('projection invariant');
      projection.seen.push(observation);
      const answer = script.project ? script.project(observation, projection) : null;
      return { records: [], diagnostics: [], ...(answer || {}) };
    },
    finishSegment(closed, options) {
      projection.finishes.push({ closed, options });
      const answer = script.finish ? script.finish(closed, projection) : null;
      return { artifact: closed == null ? null : { captureSource: 'cc-live', payload: { steps: [], events: [] } }, diagnostics: [], ...(answer || {}) };
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
    findPendingHandoffsByProject() { return { status: 'none' }; },
    deliverHandoffByToken() { return null; },
    listTurnNotes() { return []; },
    upsertTurnNotes() {},
  };
  return store;
}

const NOOP_POLICY = { resolve: () => ({ selectedByDefault: true, defaultDiscardReason: null }), infer: () => ({}) };

function makeEnrichment(script = {}) {
  const enrichment = {
    warmed: [],
    warm(keys) { enrichment.warmed.push(keys); },
    activeSymbols: script.activeSymbols ?? (() => null),
    symbolRanges: script.symbolRanges ?? (() => null),
    async resolveSymbols() { return { parsed: false, resolved: [], stale: [] }; },
  };
  return enrichment;
}

const REQUIRED = () => ({
  sessionId: 'sid',
  sourceLocator: null,
  projectId: '/repo',
  projectRoot: '/repo',
  turnNotesRoot: '/state/turn-notes',
  resourcePolicy: NOOP_POLICY,
  resourceEnrichment: makeEnrichment(),
  handoffComposition: {},
  loaderVersion: '9.9.9',
  store: makeStore(),
  dialogueSource: { read: () => ({ status: 'unavailable', observations: [] }) },
  dialogueProjection: {},
  createEngine: () => makeEngine(),
  createMeasurementProjection: (locator) => makeProjection(locator),
  modelPolicyFor: () => ({ ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 200000, pricing: {} }),
  now: () => 7000,
});

function build(over = {}) {
  return new SessionWatcher({ ...REQUIRED(), ...over });
}

const appendFrame = (batches = [], over = {}) => ({ transition: 'append', batches, sourceObserved: false, captureMode: 'live', ...over });
const replaceFrame = (locator, batches = [], over = {}) => ({ transition: 'replace', sourceLocator: locator, batches, sourceObserved: true, captureMode: 'live', ...over });
const rotateFrame = (sessionId, locator, batches = [], over = {}) => ({ transition: 'rotate', sessionId, sourceLocator: locator, batches, sourceObserved: false, captureMode: 'live', ...over });

// ── Construction ─────────────────────────────────────────────────────────────

describe('construction', () => {
  for (const key of ['store', 'dialogueProjection', 'dialogueSource', 'resourcePolicy', 'resourceEnrichment', 'handoffComposition', 'loaderVersion']) {
    test(`construction requires ${key}`, () => {
      const deps = REQUIRED();
      delete deps[key];
      assert.throws(() => new SessionWatcher(deps), /session watcher invariant/);
    });
  }

  test('construction requires the dialogue Source to expose a callable read', () => {
    assert.throws(() => new SessionWatcher({ ...REQUIRED(), dialogueSource: { read: 'not-callable' } }),
      /session watcher invariant: dialogueSource is required and exposes read/);
  });

  test('a null sourceLocator reaches the factory unchanged and a later replace installs a non-null one', () => {
    const locators = [];
    const watcher = build({
      sourceLocator: null,
      createMeasurementProjection: (locator) => { locators.push(locator); return makeProjection(locator); },
    });
    assert.deepEqual(locators, [null]);
    // Every named read works against a locator-less runtime.
    assert.equal(typeof watcher.getStatus().L, 'number');
    assert.ok(Array.isArray(watcher.getHistory()));
    assert.ok(Array.isArray(watcher.getBucketData().paths));
    assert.equal(typeof watcher.getTerminalSnapshot().b_total, 'number');
    assert.equal(watcher.getStatus().sourceLocator, null);
    watcher.applyHarnessFrame(replaceFrame('/t/second.jsonl'));
    assert.deepEqual(locators, [null, '/t/second.jsonl']);
    assert.equal(watcher.getStatus().sourceLocator, '/t/second.jsonl');
  });
});

// ── Frame transitions ────────────────────────────────────────────────────────

describe('applyHarnessFrame', () => {
  test('append, replace and rotate frames are accepted', () => {
    const watcher = build();
    assert.deepEqual(Object.keys(watcher.applyHarnessFrame(appendFrame())).sort(), ['changed', 'diagnostics']);
    assert.deepEqual(Object.keys(watcher.applyHarnessFrame(replaceFrame('/t/a.jsonl'))).sort(), ['changed', 'diagnostics']);
    assert.deepEqual(Object.keys(watcher.applyHarnessFrame(rotateFrame('sid-2', '/t/b.jsonl'))).sort(), ['changed', 'diagnostics']);
  });

  test('changed is newCalls > 0 || revisedCalls > 0 || runtimeReplaced', () => {
    const observation = { type: 'usage' };
    const newCall = build({
      createEngine: () => makeEngine({ ingest: () => ({ newCalls: 1 }) }),
      createMeasurementProjection: (l) => makeProjection(l, { project: () => ({ records: [{ type: 'step' }] }) }),
    });
    assert.equal(newCall.applyHarnessFrame(appendFrame([[observation]])).changed, true);

    const revised = build({
      createEngine: () => makeEngine({ ingest: () => ({ revisedCalls: 1 }) }),
      createMeasurementProjection: (l) => makeProjection(l, { project: () => ({ records: [{ type: 'step' }] }) }),
    });
    assert.equal(revised.applyHarnessFrame(appendFrame([[observation]])).changed, true);

    const quiet = build();
    assert.equal(quiet.applyHarnessFrame(appendFrame([[observation]])).changed, false);
    // A replace changed the runtime even with no batches at all.
    assert.equal(quiet.applyHarnessFrame(replaceFrame('/t/a.jsonl')).changed, true);
    assert.equal(quiet.applyHarnessFrame(rotateFrame('sid-2', '/t/b.jsonl')).changed, false);
  });

  test('closeCurrentSegment returns exactly { diagnostics }', () => {
    const watcher = build();
    assert.deepEqual(Object.keys(watcher.closeCurrentSegment()), ['diagnostics']);
  });

  test('append reuses the current Projection while replace creates a fresh Engine and Projection before its batches', () => {
    const engines = [];
    const projections = [];
    const watcher = build({
      createEngine: () => { const e = makeEngine({ id: `engine-${engines.length}` }); engines.push(e); return e; },
      createMeasurementProjection: (locator) => { const p = makeProjection(locator); projections.push(p); return p; },
    });
    watcher.applyHarnessFrame(appendFrame([[{ type: 'text', tag: 'first' }]]));
    assert.equal(projections.length, 1, 'append reuses the construction Projection');
    assert.deepEqual(projections[0].seen.map(o => o.tag), ['first']);

    watcher.applyHarnessFrame(replaceFrame('/t/new.jsonl', [[{ type: 'text', tag: 'second' }]]));
    assert.equal(projections.length, 2);
    assert.equal(engines.length, 2);
    assert.equal(projections[1].locator, '/t/new.jsonl');
    assert.deepEqual(projections[1].seen.map(o => o.tag), ['second'], 'the replacement Projection saw the frame batches');
    assert.deepEqual(projections[0].seen.map(o => o.tag), ['first'], 'the replaced Projection saw none of them');
  });

  test('rotate creates its candidate before closing the old segment through the old Projection', () => {
    const order = [];
    const projections = [];
    const watcher = build({
      createEngine: () => makeEngine({ close: () => ({ closedSegments: [closedSegment()] }) }),
      createMeasurementProjection: (locator) => {
        order.push(`create:${locator}`);
        const p = makeProjection(locator, { finish: () => { order.push(`finish:${locator}`); return {}; } });
        projections.push(p);
        return p;
      },
    });
    order.length = 0;
    watcher.applyHarnessFrame(rotateFrame('sid-2', '/t/rotated.jsonl', [[{ type: 'text', tag: 'after' }]]));
    assert.deepEqual(order, ['create:/t/rotated.jsonl', 'finish:null'],
      'the candidate exists before the old Projection finishes the closing segment');
    assert.deepEqual(projections[1].seen.map(o => o.tag), ['after'], 'candidate batches land on the installed candidate');
    // Without this the closing segment could go null and both assertions above would still hold, leaving a
    // case that only re-covers the null path.
    assert.equal(projections[0].finishes[0].closed?.segment, 0,
      'the old Projection finished a real closing segment, so the artifact it derives is a present one');
  });

  test('rotate closes the old segment before changing session and locator', () => {
    const seen = [];
    const watcher = build({
      sessionId: 'sid-old',
      sourceLocator: '/t/old.jsonl',
      createEngine: () => makeEngine({ close: () => ({ closedSegments: [closedSegment({ segment: 4 })] }) }),
      store: (() => {
        const store = makeStore();
        const inner = store.archiveSegmentProfile.bind(store);
        store.archiveSegmentProfile = (sessionId, segment, snapshot, paths) => { seen.push(sessionId); return inner(sessionId, segment, snapshot, paths); };
        return store;
      })(),
    });
    watcher.applyHarnessFrame(rotateFrame('sid-new', '/t/new.jsonl'));
    assert.deepEqual(seen, ['sid-old'], 'the dying segment is archived under the old session id');
    assert.equal(watcher.getStatus().sourceLocator, '/t/new.jsonl');
  });

  test('failed rotate finalization discards the candidate and leaves the old session, locator and runtime intact', () => {
    const projections = [];
    const watcher = build({
      sessionId: 'sid-old',
      sourceLocator: '/t/old.jsonl',
      createEngine: () => makeEngine({ closeThrows: true }),
      createMeasurementProjection: (locator) => { const p = makeProjection(locator); projections.push(p); return p; },
    });
    assert.throws(() => watcher.applyHarnessFrame(rotateFrame('sid-new', '/t/new.jsonl', [[{ type: 'text' }]])), /engine finalization failed/);
    assert.equal(watcher.getStatus().sourceLocator, '/t/old.jsonl');
    assert.equal(projections.length, 2, 'the candidate was created');
    assert.deepEqual(projections[1].seen, [], 'the discarded candidate projected nothing');
    // The old runtime still answers, and a later append still lands on the original Projection.
    watcher.applyHarnessFrame(appendFrame([[{ type: 'text', tag: 'later' }]]));
    assert.deepEqual(projections[0].seen.map(o => o.tag), ['later']);
  });

  test('successful rotate retains the Engine and installs the candidate identity', () => {
    const engines = [];
    const watcher = build({
      createEngine: () => { const e = makeEngine({ close: () => ({ closedSegments: [closedSegment()] }) }); engines.push(e); return e; },
    });
    const before = engines.length;
    watcher.applyHarnessFrame(rotateFrame('sid-2', '/t/b.jsonl', [[{ type: 'text', tag: 'fresh' }]]));
    assert.equal(engines.length, before, 'rotate keeps the Engine and its history');
    assert.equal(engines[0].closeCalls, 1);
  });

  test('successful epoch, rotate and explicit close each finish the closing segment once; an empty Engine result passes null', () => {
    const epochProjection = [];
    const epoch = build({
      createEngine: () => makeEngine({ ingest: (records) => (records[0].type === 'epoch' ? { closedSegments: [closedSegment()] } : {}) }),
      createMeasurementProjection: (l) => { const p = makeProjection(l, { project: () => ({ records: [{ type: 'epoch' }] }) }); epochProjection.push(p); return p; },
    });
    epoch.applyHarnessFrame(appendFrame([[{ type: 'epoch-boundary' }]]));
    assert.equal(epochProjection[0].finishes.length, 1);
    assert.equal(epochProjection[0].finishes[0].closed.segment, 0);
    assert.deepEqual(epochProjection[0].finishes[0].options, { captureMode: 'live' });

    const emptyProjection = [];
    const empty = build({
      createEngine: () => makeEngine(),
      createMeasurementProjection: (l) => { const p = makeProjection(l); emptyProjection.push(p); return p; },
    });
    empty.closeCurrentSegment();
    assert.equal(emptyProjection[0].finishes.length, 1);
    assert.equal(emptyProjection[0].finishes[0].closed, null, 'an empty Engine result passes null');
  });

  test('successful replace and rotate increment streamRevision; append only on the first observed source', () => {
    const watcher = build();
    const revision = () => watcher.readRateLampFrame(0).streamRevision;
    const start = revision();
    watcher.applyHarnessFrame(appendFrame([], { sourceObserved: false }));
    assert.equal(revision(), start, 'an unobserved append does not move the revision');
    watcher.applyHarnessFrame(appendFrame([], { sourceObserved: true }));
    assert.equal(revision(), start + 1, 'the first observed source moves it');
    watcher.applyHarnessFrame(appendFrame([], { sourceObserved: true }));
    assert.equal(revision(), start + 1, 'a later observed append does not');
    watcher.applyHarnessFrame(replaceFrame('/t/a.jsonl'));
    assert.equal(revision(), start + 2);
    watcher.applyHarnessFrame(rotateFrame('sid-2', '/t/b.jsonl'));
    assert.equal(revision(), start + 3);
  });

  test('sourceObserved latches for append and replace and resets from the rotate frame', () => {
    const watcher = build({ createEngine: () => makeEngine({ status: { apiCalls: 0, rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } } }) });
    assert.equal(watcher.getStatus().rateLamp.unavailableReason, 'no_transcript');
    watcher.applyHarnessFrame(appendFrame([], { sourceObserved: true }));
    assert.equal(watcher.getStatus().rateLamp.unavailableReason, 'insufficient_data');
    watcher.applyHarnessFrame(appendFrame([], { sourceObserved: false }));
    assert.equal(watcher.getStatus().rateLamp.unavailableReason, 'insufficient_data', 'the latch survives an unobserved append');
    watcher.applyHarnessFrame(rotateFrame('sid-2', '/t/b.jsonl', [], { sourceObserved: false }));
    assert.equal(watcher.getStatus().rateLamp.unavailableReason, 'no_transcript', 'rotate resets it from the frame');
  });

  test('sourceObserved true with zero batches changes no_transcript to insufficient_data', () => {
    const watcher = build({ createEngine: () => makeEngine({ status: { apiCalls: 0, rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } } }) });
    watcher.applyHarnessFrame(replaceFrame('/t/a.jsonl', [], { sourceObserved: true }));
    assert.equal(watcher.getStatus().rateLamp.unavailableReason, 'insufficient_data');
  });

  test('Engine and Projection diagnostics retain their order and object identity', () => {
    const p1 = { scope: 'projection', code: 'p1', message: 'p1' };
    const e1 = { scope: 'engine', code: 'e1', message: 'e1' };
    const p2 = { scope: 'projection', code: 'p2', message: 'p2' };
    let call = 0;
    const watcher = build({
      createEngine: () => makeEngine({ ingest: () => ({ diagnostics: [e1] }) }),
      createMeasurementProjection: (l) => makeProjection(l, {
        project: () => (call++ === 0 ? { records: [{ type: 'step' }], diagnostics: [p1] } : { records: [], diagnostics: [p2] }),
      }),
    });
    const { diagnostics } = watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }, { type: 'tool-use' }]]));
    assert.equal(diagnostics.length, 3);
    assert.equal(diagnostics[0], p1);
    assert.equal(diagnostics[1], e1);
    assert.equal(diagnostics[2], p2);
  });
});

// ── Resource-policy flush scheduling ─────────────────────────────────────────

describe('resource-policy flush scheduling', () => {
  function flushHarness(over = {}) {
    const flushes = [];
    const policy = {
      resolve: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
      infer: (input) => { flushes.push(input.newResourceKeys.slice()); return {}; },
    };
    const enrichment = makeEnrichment();
    const watcher = build({
      resourcePolicy: policy,
      resourceEnrichment: enrichment,
      ...over,
    });
    return { watcher, flushes, enrichment };
  }

  test('inference flushes before each epoch closes, before rotate, before explicit close, and at frame end', () => {
    let step = 0;
    const { watcher, flushes } = flushHarness({
      createEngine: () => makeEngine({
        ingest: (records) => (records[0].type === 'step' ? { newResourceKeys: [`/repo/f${step++}.js`] } : {}),
        close: () => ({ closedSegments: [closedSegment()] }),
      }),
      createMeasurementProjection: (l) => makeProjection(l, {
        project: (observation) => ({ records: [observation.type === 'epoch-boundary' ? { type: 'epoch' } : { type: 'step' }] }),
      }),
    });
    watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }, { type: 'epoch-boundary' }, { type: 'usage' }]]));
    assert.deepEqual(flushes, [['/repo/f0.js'], ['/repo/f1.js']],
      'one flush before the epoch record, one at frame end for the still-open epoch');

    flushes.length = 0;
    watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }]]));
    watcher.applyHarnessFrame(rotateFrame('sid-2', '/t/b.jsonl'));
    assert.deepEqual(flushes, [['/repo/f2.js']], 'rotate flushes the open epoch before closing it');

    flushes.length = 0;
    watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }]]));
    watcher.closeCurrentSegment();
    assert.deepEqual(flushes, [['/repo/f3.js']], 'explicit close flushes first');
  });

  test('replace discards pending resource-policy keys with the replaced Engine', () => {
    const { watcher, flushes } = flushHarness({
      createEngine: () => makeEngine({ ingest: (records) => (records[0].type === 'step' ? { newResourceKeys: ['/repo/discarded.js'] } : {}) }),
      createMeasurementProjection: (l) => makeProjection(l, { project: () => ({ records: [{ type: 'step' }] }) }),
    });
    // A frame whose transition is replace: its own batches' keys flush at frame end, and nothing from a
    // prior frame survives. Drive one append that leaves a pending key, then a replace with no batches.
    watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }]]));
    flushes.length = 0;
    watcher.applyHarnessFrame(replaceFrame('/t/a.jsonl'));
    assert.deepEqual(flushes, [], 'the pending keys went with the replaced Engine');
  });

  test('a flush hands the pending keys unchanged to resourceEnrichment.warm', () => {
    const { watcher, enrichment } = flushHarness({
      createEngine: () => makeEngine({ ingest: (records) => (records[0].type === 'step' ? { newResourceKeys: ['/repo/a.py', 'skill:brainstorming'] } : {}) }),
      createMeasurementProjection: (l) => makeProjection(l, { project: () => ({ records: [{ type: 'step' }] }) }),
    });
    watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }]]));
    assert.deepEqual(enrichment.warmed, [['/repo/a.py', 'skill:brainstorming']]);
  });

  test('Engine defaults and sibling inference read the same injected resource-policy semantics', () => {
    const seen = { resolve: [], infer: [] };
    const policy = {
      resolve: (key) => { seen.resolve.push(key); return { selectedByDefault: !key.includes('/vendor/'), defaultDiscardReason: key.includes('/vendor/') ? 'gitignore' : null }; },
      infer: (input) => { seen.infer.push(input); return {}; },
    };
    let resolveInjected = null;
    const watcher = build({
      resourcePolicy: policy,
      createEngine: ({ resolveResourcePolicy }) => {
        resolveInjected = resolveResourcePolicy;
        return makeEngine({ ingest: (records) => (records[0].type === 'step' ? { newResourceKeys: ['/repo/vendor/x.js'] } : {}) });
      },
      createMeasurementProjection: (l) => makeProjection(l, { project: () => ({ records: [{ type: 'step' }] }) }),
    });
    assert.equal(typeof resolveInjected, 'function', 'the Engine receives a resource-policy resolver');
    assert.deepEqual(resolveInjected('/repo/vendor/x.js'), { selectedByDefault: false, defaultDiscardReason: 'gitignore' });
    watcher.applyHarnessFrame(appendFrame([[{ type: 'usage' }]]));
    assert.equal(seen.infer.length, 1);
    assert.deepEqual(seen.infer[0].newResourceKeys, ['/repo/vendor/x.js']);
  });
});

// ── Archival ─────────────────────────────────────────────────────────────────

describe('segment archival', () => {
  function archiveHarness(over = {}, closed = closedSegment()) {
    const store = makeStore(over.storeScript ?? {});
    const projections = [];
    const watcher = build({
      sessionId: 'sid-a',
      projectId: '/proj',
      store,
      createEngine: () => makeEngine({ close: () => ({ closedSegments: [closed] }) }),
      createMeasurementProjection: (l) => { const p = makeProjection(l); projections.push(p); return p; },
      ...over.deps,
    });
    return { watcher, store, projections };
  }

  test('live archival uses the injected now() for archivedAt', () => {
    const { watcher, store } = archiveHarness();
    watcher.closeCurrentSegment();
    assert.equal(store.profiles[0].snapshot.archivedAt, 7000);
    assert.equal(store.profiles[0].snapshot.archiveSource, 'live');
  });

  test('replay archival uses the final valid closed-step timestamp and falls back to now()', () => {
    const withTimes = closedSegment({
      steps: [
        { id: 'a', foldedSeq: 1, timestamp: 111, usage: {} },
        { id: 'b', foldedSeq: 2, timestamp: 222, usage: {} },
        { id: 'c', foldedSeq: 3, timestamp: null, usage: {} },
      ],
    });
    const first = archiveHarness({}, withTimes);
    first.watcher.closeCurrentSegment({ captureMode: 'replay' });
    assert.equal(first.store.profiles[0].snapshot.archivedAt, 222);
    assert.equal(first.store.profiles[0].snapshot.archiveSource, 'replay');

    const noTimes = archiveHarness({}, closedSegment({ steps: [{ id: 'a', foldedSeq: 1, timestamp: null, usage: {} }] }));
    noTimes.watcher.closeCurrentSegment({ captureMode: 'replay' });
    assert.equal(noTimes.store.profiles[0].snapshot.archivedAt, 7000);
  });

  test('the profile archive is passed to the Store as exact sessionId, segment, snapshot and paths arguments', () => {
    const closed = closedSegment({ segment: 6, epochModel: 'model-z', metrics: { bTotal: 11, lPeak: 22, cRatio: 9 }, paths: [{ path: '/proj/x.js', tokens: 3 }] });
    const { watcher, store } = archiveHarness({}, closed);
    watcher.closeCurrentSegment();
    assert.equal(store.profiles.length, 1);
    assert.equal(store.profiles[0].sessionId, 'sid-a');
    assert.equal(store.profiles[0].segment, 6);
    assert.deepEqual(store.profiles[0].snapshot, {
      bTotal: 11, lPeak: 22, cRatio: 9, model: 'model-z', projectId: '/proj', archiveSource: 'live', archivedAt: 7000,
    });
    assert.deepEqual(store.profiles[0].paths, [{ path: '/proj/x.js', tokens: 3 }]);
  });

  for (const profileStatus of ['archived', 'already_archived']) {
    test(`a ${profileStatus} profile result passes a present telemetry artifact once by object identity`, () => {
      const { watcher, store, projections } = archiveHarness({ storeScript: { profileStatus } }, closedSegment({ segment: 2 }));
      watcher.closeCurrentSegment();
      assert.equal(store.telemetry.length, 1);
      assert.equal(store.telemetry[0].sessionId, 'sid-a');
      assert.equal(store.telemetry[0].segment, 2);
      const produced = projections[0].finishes[0];
      assert.ok(produced, 'the closing Projection produced the artifact');
      assert.equal(store.telemetry[0].artifact.captureSource, 'cc-live');
      assert.deepEqual(Object.keys(store.telemetry[0].artifact).sort(), ['captureSource', 'payload']);
    });
  }
});

// ── Named reads ──────────────────────────────────────────────────────────────

describe('named reads', () => {
  test('[delta] CTP overshoot telemetry is absent from status, bucket data, and profile snapshot', () => {
    const watcher = build({
      createEngine: () => makeEngine({ bucket: { dead: 5, paths: [], residual: [], totalB: 5, totalL: 5, bDefault: 5, totalResidualRaw: 0, totalResidual: 0, currentTurnSeq: 1, segment: 0 } }),
    });
    assert.equal('ctpOvershootRatio' in watcher.getStatus(), false);
    assert.equal('ctpOvershootRatio' in watcher.getBucketData(), false);
    assert.equal('ctp_overshoot_ratio' in watcher.getTerminalSnapshot(), false);
  });

  test('[delta] status omits foldErrors with the retired per-entry recovery path', () => {
    assert.equal('foldErrors' in build().getStatus(), false);
  });

  test('getTerminalSnapshot deep-matches its exact snake_case shape', () => {
    const bucket = {
      dead: 40,
      paths: [{ path: '/repo/a.js', tokens: 30, lastTurn: 1, lastCallSeq: 1, totalSpent: 30, churn: 1, efficiency: 100, readCount: 1, editCount: 0, touchSeqs: [], pureRereads: 0, defaultSelected: true, defaultDiscardReason: null, userOverride: null, lineNumbers: [1, 2], fullSnapshot: false }],
      residual: [], totalB: 55, totalL: 100, bDefault: 70, totalResidualRaw: 45, totalResidual: 45, currentTurnSeq: 9, segment: 3,
    };
    const watcher = build({ createEngine: () => makeEngine({ bucket, status: { B: 55, L: 100 } }) });
    const snapshot = watcher.getTerminalSnapshot();
    assert.deepEqual(snapshot, {
      b_total: 70, g_final: 5, l_peak: 100, c_ratio: 12.5, turns: 9, mf: 0.3, br_exit: 0.11,
      paths: [{ path: '/repo/a.js', tokens: 30 }], model: 'latest-model', segment: 3,
    });
    // In a capped fixture the uncapped b_total exceeds the reported B, while l_peak is the terminal L.
    assert.ok(snapshot.b_total > watcher.getStatus().B, 'uncapped b_total exceeds the capped status B');
    assert.equal(snapshot.l_peak, watcher.getStatus().L);
  });

  test('getStatus maps the latest measured model and keeps the retained field set', () => {
    const status = build().getStatus();
    assert.equal(status.model, 'latest-model');
    assert.deepEqual(Object.keys(status), [
      'L', 'B', 'bDefault', 'g', 'x', 'dhat', 'xSweet', 'u', 'pp', 'mf', 'br',
      'model', 'cRatio', 'segment', 'apiCalls', 'uptime', 'rateLamp', 'sourceLocator',
    ]);
  });

  test('getHistory keeps the retained point shape', () => {
    const watcher = build();
    const points = watcher.getHistory();
    // No `x`: the row's `L` is total stock while a stamped `x` is read against the belief on the cacheRead
    // basis, so the two could never be divided into each other. The Engine's own row still carries both, and
    // published nowhere it invites no division; what leaves is the served pair.
    assert.deepEqual(points, [{
      ts: '1970-01-01T00:00:01.000Z', segment: 0, L: 10, B: 5, g: 1, miss: false,
      bDefault: 4, u: 2, pp: 0.25,
      cacheRead: 3, cacheCreation: 4, turnSeq: 1, foldedSeq: 1,
    }]);
  });

  test('a history point reports its time as source ISO text a since-filter can parse', () => {
    const stamped = (ts, foldedSeq) => ({
      ts, segment: 0, L: 10, B: 5, x: 2, g: 1, miss: false, cacheRead: 3, cacheWrite: 4, turnSeq: 1, foldedSeq,
    });
    const watcher = build({
      createEngine: () => {
        const engine = makeEngine();
        engine.getHistory = () => [
          stamped(Date.parse('2026-07-01T00:00:00Z'), 1),
          stamped(Date.parse('2026-07-01T00:00:05Z'), 2),
          stamped(null, 3),
        ];
        return engine;
      },
    });
    const points = watcher.getHistory();
    assert.deepEqual(points.map(point => point.ts),
      ['2026-07-01T00:00:00.000Z', '2026-07-01T00:00:05.000Z', null]);
    // The retained route filter compares parsed times, which only works on the text form.
    const cutoff = Date.parse('2026-07-01T00:00:03Z');
    const kept = points.filter(point => Date.parse(point.ts) >= cutoff);
    assert.deepEqual(kept.map(point => point.foldedSeq), [2]);
  });

  test('cRatio is finite before the first measured step and follows a ratio override immediately', () => {
    // The Engine has no epoch policy until a step lands, so it reports null; the read model resolves the
    // displayed model's own policy, which is what the C ratio has always been from the first poll.
    const DEFAULT_RATIO = 11;
    const OVERRIDE_RATIO = 47;
    const watcher = build({
      modelPolicyFor: (modelId) => ({
        ctp: { ascii: 3, cjk: 1, version: 1 },
        cRatio: modelId ? 99 : DEFAULT_RATIO,
        contextCapacity: 200000, pricing: {},
      }),
      createEngine: () => makeEngine({
        status: { cRatio: null, latestMeasuredModel: null, apiCalls: 0, rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } },
      }),
    });
    assert.equal(watcher.getStatus().cRatio, DEFAULT_RATIO);
    assert.equal(watcher.getTerminalSnapshot().c_ratio, DEFAULT_RATIO);
    watcher.setRatioOverride(OVERRIDE_RATIO);
    assert.equal(watcher.getStatus().cRatio, OVERRIDE_RATIO, 'an override is visible before any step');
    assert.equal(watcher.getTerminalSnapshot().c_ratio, OVERRIDE_RATIO);
    watcher.setRatioOverride(null);
    assert.equal(watcher.getStatus().cRatio, DEFAULT_RATIO);
  });

  test('a resolved epoch policy is never masked by the read-model ratio', () => {
    const watcher = build({
      modelPolicyFor: () => ({ ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 11, contextCapacity: 1, pricing: {} }),
      createEngine: () => makeEngine({ status: { cRatio: 12.5, latestMeasuredModel: 'latest-model' } }),
    });
    assert.equal(watcher.getStatus().cRatio, 12.5);
    assert.equal(watcher.getTerminalSnapshot().c_ratio, 12.5);
  });

  test('getBucketData splits skills, groups residuals, and omits internal lineNumbers and fullSnapshot', () => {
    const row = (over) => ({
      path: '/repo/a.js', tokens: 30, lastTurn: 1, lastCallSeq: 2, totalSpent: 40, churn: 1.33,
      efficiency: 75, readCount: 2, editCount: 0, touchSeqs: [1, 2], pureRereads: 1,
      defaultSelected: true, defaultDiscardReason: null, userOverride: null,
      lineNumbers: [1, 2, 3], fullSnapshot: false, ...over,
    });
    const bucket = {
      dead: 40,
      paths: [row({}), row({ path: 'skill:brainstorming', tokens: 20 }), row({ path: '/repo/vendor/b.js', tokens: 10, defaultSelected: false, defaultDiscardReason: 'gitignore' })],
      residual: [
        { groupKey: 'npm test', tokens: 12.4, count: 2, lastTurn: 3, lastCallSeq: 4, touchSeqs: [3], meta: { kind: 'bash', detail: 'suite' } },
        { groupKey: 'serena.find', tokens: 9.6, count: 1, lastTurn: 2, lastCallSeq: 2, touchSeqs: [2], meta: { kind: 'mcp' } },
        { groupKey: 'agent:ab12', tokens: 5, count: 1, lastTurn: 1, lastCallSeq: 1, touchSeqs: [1], meta: { kind: 'agent', detail: 'explore' } },
        { groupKey: 'dust', tokens: 0.2, count: 1, lastTurn: 1, lastCallSeq: 1, touchSeqs: [], meta: { kind: 'bash' } },
      ],
      totalB: 55, totalL: 100, bDefault: 70, totalResidualRaw: 45, totalResidual: 45, currentTurnSeq: 9, segment: 3,
    };
    const enrichment = makeEnrichment({ activeSymbols: ({ path }) => (path === '/repo/a.js' ? ['alpha'] : ['never']) });
    const watcher = build({ resourceEnrichment: enrichment, createEngine: () => makeEngine({ bucket }) });

    const plain = watcher.getBucketData();
    assert.deepEqual(Object.keys(plain), [
      'dead', 'skills', 'paths', 'residual', 'totalB', 'totalL', 'bDefault',
      'totalResidualRaw', 'totalResidual', 'currentTurnSeq', 'segment',
    ]);
    assert.deepEqual(plain.skills.map(s => s.name), ['brainstorming']);
    assert.equal('path' in plain.skills[0], false, 'a skill row carries a name, not a path');
    assert.deepEqual(plain.paths.map(p => p.path), ['/repo/a.js', '/repo/vendor/b.js']);
    for (const entry of [...plain.paths, ...plain.skills]) {
      assert.equal('lineNumbers' in entry, false);
      assert.equal('fullSnapshot' in entry, false);
    }
    assert.deepEqual(plain.residual.bash, [{ name: 'npm test', detail: 'suite', tokens: 12, count: 2, lastTurn: 3, lastCallSeq: 4, touchSeqs: [3] }]);
    assert.deepEqual(plain.residual.mcp, [{ tool: 'serena.find', tokens: 10, count: 1, lastTurn: 2, lastCallSeq: 2, touchSeqs: [2] }]);
    assert.deepEqual(plain.residual.agent, [{ name: 'agent:ab12', detail: 'explore', tokens: 5, count: 1, lastTurn: 1, lastCallSeq: 1, touchSeqs: [1] }]);
    assert.equal(plain.paths[0].activeSymbols, undefined, 'symbols are not computed unless asked for');

    const enriched = watcher.getBucketData({ includeSymbols: true });
    assert.deepEqual(enriched.paths[0].activeSymbols, ['alpha']);
    assert.equal('activeSymbols' in enriched.paths[1], false, 'a non-default-selected row is never enriched');
    assert.equal('activeSymbols' in enriched.skills[0], false, 'a skill row is never enriched');
  });

  test('every public read is detached', () => {
    const bucket = {
      dead: 40,
      paths: [{ path: '/repo/a.js', tokens: 30, lastTurn: 1, lastCallSeq: 2, totalSpent: 30, churn: 1, efficiency: 100, readCount: 1, editCount: 0, touchSeqs: [1], pureRereads: 0, defaultSelected: true, defaultDiscardReason: null, userOverride: null, lineNumbers: [], fullSnapshot: true }],
      residual: [], totalB: 55, totalL: 100, bDefault: 70, totalResidualRaw: 45, totalResidual: 45, currentTurnSeq: 9, segment: 3,
    };
    const watcher = build({ createEngine: () => makeEngine({ bucket }) });
    const first = watcher.getBucketData();
    first.paths[0].tokens = -1;
    first.paths.length = 0;
    assert.equal(watcher.getBucketData().paths[0].tokens, 30);
    const status = watcher.getStatus();
    status.rateLamp.reliable = 'mutated';
    assert.equal(watcher.getStatus().rateLamp.reliable, true);
    const history = watcher.getHistory();
    history.length = 0;
    assert.equal(watcher.getHistory().length, 1);
    const snapshot = watcher.getTerminalSnapshot();
    snapshot.paths.length = 0;
    assert.equal(watcher.getTerminalSnapshot().paths.length, 1);
  });

  test('readRateLampFrame adds the application-owned streamRevision to the coherent Engine frame', () => {
    const watcher = build();
    const frame = watcher.readRateLampFrame(2);
    assert.equal(frame.progress.sinceFoldedSeq, 2);
    assert.equal(typeof frame.streamRevision, 'number');
    assert.equal(frame.turnSeq, 9);
  });

  test('setRatioOverride refreshes Engine reads without rebuilding state or moving streamRevision', () => {
    const engines = [];
    const watcher = build({ createEngine: () => { const e = makeEngine(); engines.push(e); return e; } });
    const before = watcher.readRateLampFrame(0).streamRevision;
    watcher.setRatioOverride(50);
    assert.equal(engines.length, 1, 'no measurement rebuild');
    assert.equal(engines[0].refreshes, 1);
    assert.equal(watcher.readRateLampFrame(0).streamRevision, before);
    watcher.setRatioOverride(null);
    assert.equal(engines[0].refreshes, 2);
  });

  test('the effective model-policy resolver replaces only cRatio and is shared with every Projection', () => {
    const resolvers = [];
    let engineResolver = null;
    const watcher = build({
      modelPolicyFor: (modelId) => ({ ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 111, pricing: { model: modelId } }),
      createEngine: ({ resolveModelPolicy }) => { engineResolver = resolveModelPolicy; return makeEngine(); },
      createMeasurementProjection: (locator, resolveModelPolicy) => { resolvers.push(resolveModelPolicy); return makeProjection(locator); },
    });
    assert.equal(resolvers.length, 1);
    assert.equal(resolvers[0], engineResolver, 'Engine and Projection share one resolver');
    assert.deepEqual(engineResolver('m'), { ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 111, pricing: { model: 'm' } });
    watcher.setRatioOverride(77);
    assert.equal(engineResolver('m').cRatio, 77, 'only cRatio changes');
    assert.equal(engineResolver('m').contextCapacity, 111);
    watcher.applyHarnessFrame(replaceFrame('/t/a.jsonl'));
    assert.equal(resolvers[1], engineResolver, 'the replacement Projection gets the same resolver');
  });

  test('a policy whose CTP carries no calibration version falls back to the default policy', () => {
    const DEFAULT = { ctp: { ascii: 3, cjk: 1, version: 4 }, cRatio: 10, contextCapacity: 111, pricing: {} };
    let engineResolver = null;
    const watcher = build({
      // The named model's CTP is missing its version, so no consumer may price a step with it.
      modelPolicyFor: (modelId) => (modelId
        ? { ctp: { ascii: 9, cjk: 9 }, cRatio: 7, contextCapacity: 5, pricing: {} }
        : DEFAULT),
      createEngine: ({ resolveModelPolicy }) => { engineResolver = resolveModelPolicy; return makeEngine(); },
    });
    assert.deepEqual(engineResolver('some-model'), DEFAULT);
    assert.deepEqual(watcher.getCurrentCtp(), DEFAULT.ctp);
  });

  test('a throwing model-policy resolver falls back to the default policy', () => {
    const DEFAULT = { ctp: { ascii: 3, cjk: 1, version: 1 }, cRatio: 10, contextCapacity: 111, pricing: {} };
    let engineResolver = null;
    build({
      modelPolicyFor: (modelId) => { if (modelId) throw new Error('policy table unavailable'); return DEFAULT; },
      createEngine: ({ resolveModelPolicy }) => { engineResolver = resolveModelPolicy; return makeEngine(); },
    });
    assert.deepEqual(engineResolver('some-model'), DEFAULT);
  });

  test('getCurrentModel reads the latest measured step model and getCurrentCtp resolves it', () => {
    const watcher = build({
      modelPolicyFor: (modelId) => ({ ctp: { ascii: modelId === 'latest-model' ? 4 : 3, cjk: 1, version: 5 }, cRatio: 10, contextCapacity: 1, pricing: {} }),
    });
    assert.equal(watcher.getCurrentModel(), 'latest-model');
    assert.deepEqual(watcher.getCurrentCtp(), { ascii: 4, cjk: 1, version: 5 });
  });

  test('replaceUserOverrides delegates whole-set replacement and returns the Engine warnings', () => {
    const engines = [];
    const watcher = build({
      createEngine: () => { const e = makeEngine({ overrideWarnings: [{ code: 'unknown_resource', resourceKey: 'x', value: 'include' }] }); engines.push(e); return e; },
    });
    const result = watcher.replaceUserOverrides({ '/repo/a.js': 'exclude' });
    assert.deepEqual(engines[0].overrideReplacements, [{ '/repo/a.js': 'exclude' }]);
    assert.equal(result.changed, true);
    assert.deepEqual(result.warnings, [{ code: 'unknown_resource', resourceKey: 'x', value: 'include' }]);
  });

  // The two model reads are deliberately different sources: a status display wants the latest measured
  // identity, while every model-DEPENDENT value — the C ratio, the pricing wire, and the key a per-model
  // override is stored under — resolves from the epoch model. Collapsing them would move an override's key
  // mid-epoch.
  test('getEpochModel is the epoch model and getCurrentModel the latest measured one', () => {
    const watcher = build();
    assert.equal(watcher.getEpochModel(), 'epoch-model');
    assert.equal(watcher.getCurrentModel(), 'latest-model');
    // And the epoch model is NOT a member of the status result: that shape is compared key-for-key, so
    // widening it would itself be a wire change.
    assert.equal('epochModel' in watcher.getStatus(), false);
    assert.equal(watcher.getStatus().model, 'latest-model', 'status keeps the display identity');
  });

  test('host code receives no resource-policy getter or private-state forwarder', () => {
    const watcher = build();
    const surface = new Set();
    for (let proto = watcher; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      // Private state and helpers carry the repo's underscore prefix; what a host may reach is the rest.
      for (const name of Object.getOwnPropertyNames(proto)) if (!name.startsWith('_')) surface.add(name);
    }
    surface.delete('constructor');
    assert.deepEqual([...surface].sort(), [
      'applyHarnessFrame', 'closeCurrentSegment', 'deliverHandoff', 'getBucketData', 'getCurrentCtp',
      'getCurrentModel', 'getEpochModel', 'getHistory', 'getStatus', 'getTerminalSnapshot', 'getTurnSkeleton',
      'prepareHandoff', 'readRateLampFrame', 'readScenario', 'replaceUserOverrides', 'searchHandoffs',
      'setRatioOverride', 'submitTurnNotes',
    ]);
  });
});

// ── Turn Notes ───────────────────────────────────────────────────────────────

describe('Turn Note orchestration', () => {
  test('Turn Note files are created only below the injected turnNotesRoot; a commit removes the epoch directory and a retryable failure keeps it', async () => {
    const { mkdtempSync, rmSync, existsSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'sw-tn-root-'));
    try {
      // One captured turn plus the asking turn the capture helper always drops.
      const line = (ordinal, id, text) => ({
        kind: 'visible', sourceOrdinal: ordinal, sourceEntryId: id, timestamp: ordinal * 10,
        message: { role: 'human', text },
      });
      const turnOf = (ordinal, id) => ({
        sourceOrdinal: ordinal, sourceEntryId: id, timestamp: ordinal * 10, cleanedU: `ask ${ordinal}`,
        classification: 'HEAD', lines: [line(ordinal, id, `ask ${ordinal}`), { kind: 'visible', sourceOrdinal: ordinal + 1, sourceEntryId: `${id}-a`, timestamp: ordinal * 10 + 1, message: { role: 'assistant', text: 'done' } }],
        hasAssistantActivity: true,
      });
      const dialogueProjection = {
        project: () => ({ folds: [] }),
        groupTurns: () => [turnOf(4, 'anchor-1'), turnOf(6, 'anchor-2')],
      };
      const dialogueSource = { read: () => ({ status: 'ok', observations: [] }) };
      let committed = 0;
      const store = makeStore();
      store.upsertTurnNotes = () => { committed += 1; if (committed === 1) throw new Error('db down'); };
      const watcher = build({
        turnNotesRoot: root,
        sourceLocator: '/t/session.jsonl',
        dialogueSource,
        dialogueProjection,
        store,
      });
      const skeleton = watcher.getTurnSkeleton();
      assert.ok(skeleton.skeleton_path.startsWith(root + '/'), 'skeleton lives under the injected root');
      assert.ok(skeleton.notes_path.startsWith(root + '/'), 'notes live under the injected root');
      assert.equal(readdirSync(root).length, 1);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(skeleton.notes_path, '## NOTE[4]\n\nthe note body\n');
      const failed = watcher.submitTurnNotes({ snapshot_id: skeleton.snapshot_id });
      assert.equal(failed.committed, false);
      assert.equal(failed.retryable, true);
      assert.ok(existsSync(skeleton.notes_path), 'a retryable failure retains the epoch directory');
      const ok = watcher.submitTurnNotes({ snapshot_id: skeleton.snapshot_id });
      assert.equal(ok.committed, true);
      assert.equal(existsSync(skeleton.notes_path), false, 'a successful submission removes the epoch directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
