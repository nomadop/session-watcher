// Resource-policy flush scheduling and grammar prewarm through the real composition: the shared
// SessionWatcher, the portable Engine, the Claude Code Measurement Projection, and one real Resource
// Policy. What is asserted is WHEN the application reads the resource snapshot and WHAT it hands the
// Engine and the enrichment afterwards — the selection rule itself belongs to test/resource-policy.test.js.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../lib/session-watcher.js';
import { createResourcePolicy } from '../lib/resource-policy.js';
import { createResourceEnrichment } from '../lib/resource-enrichment.js';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { createClaudeCodeMeasurementProjection } from '../lib/harness/claude-code/measurement-projection.js';
import {
  interpretClaudeCodeToolUse, completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload, interpretClaudeCodeTaskNotification,
} from '../lib/harness/claude-code/native-tools.js';
import { readClaudeCodeRows, createClaudeCodeObservationReducer } from '../lib/harness/claude-code/transcript-observation.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import {
  ts, chain, usage, userMessage, assistantToolUse, assistantObservation, toolResult, compactSummary,
} from './helpers/transcript-fixtures.js';

const PROJECT = '/repo';

// One incremental reducer per composed watcher, so a boundary that must be a NON-FIRST topology root stays
// one across successive frames — a fresh snapshot per frame would read it as the session origin instead.
function makeFeeder() {
  const reducer = createClaudeCodeObservationReducer();
  let ordinal = 1;
  let lastUuid = null;
  return function batchesOf(entries) {
    const linked = chain(entries);
    if (lastUuid && linked.length > 0 && linked[0].parentUuid == null && linked[0].isCompactSummary !== true) {
      linked[0].parentUuid = lastUuid;
    }
    if (linked.length > 0) lastUuid = linked[linked.length - 1].uuid;
    const buffer = Buffer.from(linked.map(entry => JSON.stringify(entry) + '\n').join(''));
    const read = readClaudeCodeRows(buffer, { sourceOrdinal: ordinal, atEof: true });
    ordinal = read.nextSourceOrdinal;
    return reducer.append(read.rows).batches;
  };
}

function inertStore() {
  return {
    profiles: [], telemetry: [],
    archiveSegmentProfile(sessionId, segment, snapshot, paths) { this.profiles.push({ sessionId, segment, snapshot, paths }); return { status: 'archived' }; },
    archiveSegmentTelemetry(sessionId, segment, artifact) { this.telemetry.push({ sessionId, segment, artifact }); return { status: 'complete' }; },
    findPendingHandoffsByProject: () => ({ status: 'none' }),
    deliverHandoffByToken: () => null,
    listTurnNotes: () => [],
    upsertTurnNotes: () => {},
  };
}

function compose({ isIgnored = null, manualOverrides = null } = {}) {
  const real = createResourcePolicy({ projectRoot: PROJECT, isIgnored });
  const inferCalls = [];
  const policy = {
    resolve: real.resolve,
    infer: (input) => { inferCalls.push({ newResourceKeys: input.newResourceKeys.slice(), resourceKeys: input.resourceKeys.slice(), overrides: { ...input.overrides } }); return real.infer(input); },
  };
  // The REAL Resource Enrichment over an injected warmer, so what the warmer receives is the extension the
  // enrichment derived rather than one the assertion re-derived from the key it is asserting.
  const warmedKeys = [];
  const warmedExtensions = [];
  const realEnrichment = createResourceEnrichment({ warmer: (ext) => { warmedExtensions.push(ext); } });
  const enrichment = {
    ...realEnrichment,
    warm: (keys) => { warmedKeys.push(keys.slice()); return realEnrichment.warm(keys); },
  };
  const watcher = new SessionWatcher({
    sessionId: 'sid-workspace',
    sourceLocator: '/t/session.jsonl',
    projectId: PROJECT,
    projectRoot: PROJECT,
    turnNotesRoot: '/state/turn-notes',
    resourcePolicy: policy,
    resourceEnrichment: enrichment,
    handoffComposition: {},
    loaderVersion: '1.0.0',
    store: inertStore(),
    dialogueSource: { read: () => ({ status: 'unavailable', observations: [] }) },
    dialogueProjection: {},
    createEngine: createMeasurementEngine,
    createMeasurementProjection: (locator, resolveModelPolicy) => createClaudeCodeMeasurementProjection({
      cwd: PROJECT, projectRoot: PROJECT, sourceLocator: locator, resolveModelPolicy,
      interpretToolUse: interpretClaudeCodeToolUse,
      completeToolResult: completeClaudeCodeToolResult,
      interpretSkillPayload: interpretClaudeCodeSkillPayload,
      interpretTaskNotification: interpretClaudeCodeTaskNotification,
    }),
    modelPolicyFor,
    now: () => 1000,
  });
  if (manualOverrides) watcher.replaceUserOverrides(manualOverrides);
  return { watcher, inferCalls, warmedKeys, warmedExtensions, feed: makeFeeder() };
}

const frame = (batches, over = {}) => ({
  transition: 'append', batches, sourceObserved: true, captureMode: 'live', ...over,
});

let seq = 0;
const nextId = () => `n${++seq}`;

// One assistant row that reads `path` whole, plus its tool result. The row carries usage so the step is
// measured, which is what makes the resource key a NEW key of the current Engine epoch.
function readStep(path, { cacheRead, lines = 12 } = {}) {
  const id = nextId();
  const body = Array.from({ length: lines }, (_, i) => `${i + 1}\tconst v${i} = ${i};`).join('\n');
  return [
    assistantToolUse({
      uuid: `a-${id}`, messageId: `m-${id}`, toolUseId: `t-${id}`, name: 'Read',
      input: { file_path: path }, timestamp: ts(seq % 60), usage: usage({ cacheRead, output: 5 }),
    }),
    toolResult({ uuid: `u-${id}`, parentUuid: `a-${id}`, toolUseId: `t-${id}`, content: body, timestamp: ts(seq % 60) }),
  ];
}

// A multi-file Grep whose result names two files and whose issuing row carries usage.
function grepStep(paths, { cacheRead } = {}) {
  const id = nextId();
  const body = paths.flatMap(p => [`${p}:1:import os`, `${p}:2:print(os.name)`]).join('\n');
  return [
    assistantToolUse({
      uuid: `a-${id}`, messageId: `m-${id}`, toolUseId: `t-${id}`, name: 'Grep',
      input: { pattern: 'import' }, timestamp: ts(seq % 60), usage: usage({ cacheRead, output: 5 }),
    }),
    toolResult({ uuid: `u-${id}`, parentUuid: `a-${id}`, toolUseId: `t-${id}`, content: body, timestamp: ts(seq % 60) }),
  ];
}

const plainStep = (cacheRead) => {
  const id = nextId();
  return [assistantObservation({
    uuid: `a-${id}`, messageId: `m-${id}`, blocks: [], timestamp: ts(seq % 60),
    model: 'claude-opus-4-8', usage: usage({ cacheRead, output: 5 }),
  })];
};

describe('flush scheduling', () => {
  test('[delta] sibling overrides use one complete resource snapshot per Engine-epoch flush', () => {
    // One startup frame contains multiple epochs; one epoch spans multiple frames.
    const { watcher, inferCalls, feed } = compose();
    const startup = feed([
      userMessage({ uuid: 'u0', text: 'start', timestamp: ts(0) }),
      ...readStep('/repo/src/one.js', { cacheRead: 20000 }),
      ...readStep('/repo/src/two.js', { cacheRead: 21000 }),
      compactSummary({ uuid: 'compact-1', timestamp: ts(5) }),
      ...readStep('/repo/lib/three.js', { cacheRead: 22000 }),
    ]);
    watcher.applyHarnessFrame(frame(startup));
    assert.equal(inferCalls.length, 2, 'one flush before the epoch record, one at frame end');
    assert.deepEqual(inferCalls[0].newResourceKeys, ['/repo/src/one.js', '/repo/src/two.js'],
      'both of the first epoch\'s new keys arrive in one flush');
    assert.ok(inferCalls[0].resourceKeys.includes('/repo/src/one.js') && inferCalls[0].resourceKeys.includes('/repo/src/two.js'),
      'the one snapshot the flush reads already holds every batch-mate');
    assert.deepEqual(inferCalls[1].newResourceKeys, ['/repo/lib/three.js']);
    assert.equal(inferCalls[1].resourceKeys.includes('/repo/src/one.js'), false,
      'the epoch cleared the resident set, so the second flush sees only its own epoch');

    // The same epoch continued by a second frame flushes again, with only that frame's new keys.
    const later = feed([
      userMessage({ uuid: 'u9', text: 'more', timestamp: ts(10) }),
      ...readStep('/repo/lib/four.js', { cacheRead: 23000 }),
    ]);
    watcher.applyHarnessFrame(frame(later));
    assert.equal(inferCalls.length, 3);
    assert.deepEqual(inferCalls[2].newResourceKeys, ['/repo/lib/four.js']);
    assert.ok(inferCalls[2].resourceKeys.includes('/repo/lib/three.js'),
      'the continuing epoch\'s snapshot still holds the resource its earlier frame added');
  });

  test('a frame with no new resource key takes no snapshot at all', () => {
    const { watcher, inferCalls, feed } = compose();
    watcher.applyHarnessFrame(frame(feed([
      userMessage({ uuid: 'u0', text: 'start', timestamp: ts(0) }),
      ...plainStep(20000),
    ])));
    assert.deepEqual(inferCalls, []);
  });

  test('manual and inferred entries merge into one set, and a later replaceUserOverrides replaces the whole set', () => {
    const { watcher, feed } = compose({ isIgnored: (rel) => rel.startsWith('vendor/') });
    watcher.applyHarnessFrame(frame(feed([
      userMessage({ uuid: 'u0', text: 'start', timestamp: ts(0) }),
      ...readStep('/repo/vendor/a.js', { cacheRead: 20000 }),
      ...readStep('/repo/src/keep.js', { cacheRead: 21000 }),
    ])));
    const overrideOf = (path) => watcher.getBucketData().paths.find(p => p.path === path)?.userOverride ?? null;
    watcher.replaceUserOverrides({ '/repo/vendor/a.js': 'include' });
    assert.equal(overrideOf('/repo/vendor/a.js'), 'include', 'a manual entry lands');

    // A second vendor sibling arriving now inherits the manual include through inference, and both
    // entries live in one set.
    watcher.applyHarnessFrame(frame(feed([
      userMessage({ uuid: 'u1', text: 'more', timestamp: ts(3) }),
      ...readStep('/repo/vendor/b.js', { cacheRead: 22000 }),
    ])));
    assert.equal(overrideOf('/repo/vendor/a.js'), 'include', 'the manual entry survived the flush');
    assert.equal(overrideOf('/repo/vendor/b.js'), 'include', 'the inferred entry joined the same set');

    watcher.replaceUserOverrides({ '/repo/src/keep.js': 'exclude' });
    assert.equal(overrideOf('/repo/vendor/a.js'), null, 'whole-set replacement dropped both prior entries');
    assert.equal(overrideOf('/repo/vendor/b.js'), null);
    assert.equal(overrideOf('/repo/src/keep.js'), 'exclude');
  });

  test('an append retains the override set while an epoch, an explicit close, a replace and a rotate clear it', () => {
    const overrideOf = (watcher, path) => watcher.getBucketData().paths.find(p => p.path === path)?.userOverride ?? null;
    // Each case gets its own watcher AND its own reducer: an override set is epoch-local, so the seeded
    // state has to be reachable independently in every one of them.
    const seeded = () => {
      const composition = compose();
      composition.watcher.applyHarnessFrame(frame(composition.feed([
        userMessage({ uuid: `s${++seq}`, text: 'start', timestamp: ts(0) }),
        ...readStep('/repo/src/kept.js', { cacheRead: 20000 }),
      ])));
      composition.watcher.replaceUserOverrides({ '/repo/src/kept.js': 'exclude' });
      assert.equal(overrideOf(composition.watcher, '/repo/src/kept.js'), 'exclude');
      return composition;
    };

    const appended = seeded();
    appended.watcher.applyHarnessFrame(frame(appended.feed([...plainStep(24000)])));
    assert.equal(overrideOf(appended.watcher, '/repo/src/kept.js'), 'exclude', 'append retains it');

    const epoched = seeded();
    epoched.watcher.applyHarnessFrame(frame(epoched.feed([
      compactSummary({ uuid: `c${++seq}`, timestamp: ts(6) }),
      ...plainStep(9000),
    ])));
    assert.equal(overrideOf(epoched.watcher, '/repo/src/kept.js'), null, 'an epoch cleared it through the Engine finalizer');

    const closed = seeded();
    closed.watcher.closeCurrentSegment();
    assert.equal(overrideOf(closed.watcher, '/repo/src/kept.js'), null, 'an explicit close cleared it');

    const replaced = seeded();
    replaced.watcher.applyHarnessFrame({ transition: 'replace', sourceLocator: '/t/next.jsonl', batches: [], sourceObserved: true, captureMode: 'live' });
    assert.equal(overrideOf(replaced.watcher, '/repo/src/kept.js'), null, 'a replace installed a fresh Engine');

    const rewound = seeded();
    rewound.watcher.applyHarnessFrame({ transition: 'replace', sourceLocator: '/t/session.jsonl', batches: [], sourceObserved: true, captureMode: 'replay' });
    assert.equal(overrideOf(rewound.watcher, '/repo/src/kept.js'), null, 'a rewind is a replace and clears it too');

    const rotated = seeded();
    rotated.watcher.applyHarnessFrame({ transition: 'rotate', sessionId: 'sid-2', sourceLocator: '/t/rotated.jsonl', batches: [], sourceObserved: false, captureMode: 'live' });
    assert.equal(overrideOf(rotated.watcher, '/repo/src/kept.js'), null, 'a rotation cleared it through the Engine finalizer');
  });
});

describe('grammar prewarm', () => {
  test('[delta] grep-discovered file resources request grammar prewarm', () => {
    // Feed a grep-only .py resource and assert the injected warmer receives '.py'.
    const { watcher, warmedKeys, warmedExtensions, feed } = compose();
    watcher.applyHarnessFrame(frame(feed([
      userMessage({ uuid: 'g0', text: 'search', timestamp: ts(0) }),
      ...grepStep(['/repo/pkg/mod.py'], { cacheRead: 20000 }),
    ])));
    assert.ok(warmedKeys.flat().includes('/repo/pkg/mod.py'),
      `the grep-discovered resource reached warm(), got ${JSON.stringify(warmedKeys)}`);
    assert.deepEqual(warmedExtensions, ['.py'],
      `the warmer received the Python extension, got ${JSON.stringify(warmedExtensions)}`);
  });

  test('a flush hands every new key of the epoch to the warmer once', () => {
    const { watcher, warmedKeys, warmedExtensions, feed } = compose();
    watcher.applyHarnessFrame(frame(feed([
      userMessage({ uuid: 'w0', text: 'start', timestamp: ts(0) }),
      ...readStep('/repo/src/a.js', { cacheRead: 20000 }),
      ...readStep('/repo/src/b.js', { cacheRead: 21000 }),
    ])));
    assert.deepEqual(warmedKeys, [['/repo/src/a.js', '/repo/src/b.js']]);
    assert.deepEqual(warmedExtensions, ['.js', '.js']);
  });
});
