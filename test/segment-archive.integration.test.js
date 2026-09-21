// Segment archival end to end: the real shared SessionWatcher, the real portable Engine, the real Claude
// Code Measurement Projection, and a real Store on a temp database, wired only through constructor
// injection. What is asserted is what a closed segment PERSISTS — profile row, path rows, step usage,
// path events, and telemetry status — because that is the surface a later reader and the compensating
// sweep both consume.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionWatcher } from '../lib/session-watcher.js';
import { createResourcePolicy } from '../lib/resource-policy.js';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { createClaudeCodeMeasurementProjection } from '../lib/harness/claude-code/measurement-projection.js';
import {
  interpretClaudeCodeToolUse, completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload, interpretClaudeCodeTaskNotification,
} from '../lib/harness/claude-code/native-tools.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { openStore, closeStore } from '../lib/store.js';
import {
  ts, chain, usage, userMessage, assistantObservation, assistantToolUse, toolResult, compactSummary,
} from './helpers/transcript-fixtures.js';

const PROJECT = '/repo';
const LOAD_TOOL = 'mcp__plugin_session-watcher_session-watcher__load_handoff';

let dir;
let stores;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-segarchint-')); stores = []; });
afterEach(() => {
  for (const store of stores) { try { closeStore(store); } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

const NO_ENRICHMENT = {
  warm: () => {}, activeSymbols: () => null, symbolRanges: () => null,
  resolveSymbols: async () => ({ parsed: false, readable: false, resolved: [], stale: [] }),
};

let dbSeq = 0;
// A fresh Projection, Engine, SessionWatcher and Store per call: nothing here is shared across tests.
function compose({ sessionId = 'sid-archive', now = () => 9_000_000 } = {}) {
  const store = openStore(join(dir, `store-${++dbSeq}.sqlite`));
  stores.push(store);
  const watcher = new SessionWatcher({
    sessionId,
    sourceLocator: '/t/session.jsonl',
    projectId: PROJECT,
    projectRoot: PROJECT,
    turnNotesRoot: join(dir, 'turn-notes'),
    resourcePolicy: createResourcePolicy({ projectRoot: PROJECT, isIgnored: null }),
    resourceEnrichment: NO_ENRICHMENT,
    handoffComposition: {},
    loaderVersion: '1.0.0',
    store,
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
    now,
  });
  return { watcher, store, sessionId };
}

function observationsOf(entries) {
  const buffer = Buffer.from(entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  return reduceClaudeCodeSnapshot(readClaudeCodeRows(buffer, { atEof: true }).rows).observations;
}

const apply = (watcher, entries, over = {}) => watcher.applyHarnessFrame({
  transition: 'append', batches: [observationsOf(entries)], sourceObserved: true, captureMode: 'live', ...over,
});

const numbered = (lines) => Array.from({ length: lines }, (_, i) => `${i + 1}\tconst v${i} = ${i};`).join('\n');

// ── Shared observation builders ──────────────────────────────────────────────

// One issuing row with three unique tool uses — a Read, a Grep and an explicit load_handoff — carrying its
// higher-total usage, plus each tool's successful result. The named tests below reuse it.
function issuingStepWithThreeTools({ loadToken }) {
  const blocks = [
    { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/repo/src/a.js' } },
    { type: 'tool_use', id: 'tu-grep', name: 'Grep', input: { pattern: 'const' } },
    { type: 'tool_use', id: 'tu-load', name: LOAD_TOOL, input: { load_token: loadToken } },
  ];
  return [
    assistantObservation({
      uuid: 'a-issue', messageId: 'm-issue', blocks, timestamp: ts(2),
      model: 'claude-opus-4-8', usage: usage({ input: 300, output: 40, cacheRead: 24000, cacheWrite: 900 }),
    }),
    toolResult({ uuid: 'r-read', parentUuid: 'a-issue', toolUseId: 'tu-read', content: numbered(18), timestamp: ts(3) }),
    toolResult({ uuid: 'r-grep', parentUuid: 'r-read', toolUseId: 'tu-grep', content: '/repo/src/b.js:1:const b = 1;\n/repo/src/b.js:2:const c = 2;', timestamp: ts(3) }),
    toolResult({ uuid: 'r-load', parentUuid: 'r-grep', toolUseId: 'tu-load', content: 'handoff loaded', timestamp: ts(3) }),
  ];
}

const coldStep = () => assistantObservation({
  uuid: 'a-cold', messageId: 'm-cold', blocks: [], timestamp: ts(1),
  model: 'claude-opus-4-8', usage: usage({ input: 20000, output: 10, cacheRead: 0, cacheWrite: 0 }),
});

const epochAt = (second) => compactSummary({ uuid: `compact-${second}`, timestamp: ts(second) });

const stepRows = (store, sessionId, segment) => store._db
  .prepare('SELECT * FROM profile_step_usage WHERE session_id=? AND segment=? ORDER BY folded_seq').all(sessionId, segment);
const eventRows = (store, sessionId, segment) => store._db
  .prepare('SELECT * FROM profile_path_event WHERE session_id=? AND segment=? ORDER BY folded_seq, event_ordinal').all(sessionId, segment);
const pathRows = (store, sessionId, segment) => store._db
  .prepare('SELECT path, tokens FROM profile_paths WHERE session_id=? AND segment=? ORDER BY path').all(sessionId, segment);
const telemetryStatus = (store, sessionId, segment) => store._db
  .prepare('SELECT telemetry_status, capture_source FROM profile WHERE session_id=? AND segment=?').get(sessionId, segment);

describe('archived step facts', () => {
  test('[delta] archived step tool count includes every unique tool_use block of the issuing step', () => {
    const { watcher, store, sessionId } = compose();
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      coldStep(),
      ...issuingStepWithThreeTools({ loadToken: 'carry-lyric-gear' }),
      epochAt(9),
      assistantObservation({ uuid: 'a-next', messageId: 'm-next', blocks: [], timestamp: ts(10), model: 'claude-opus-4-8', usage: usage({ cacheRead: 5000, output: 5 }) }),
    ]));
    const steps = stepRows(store, sessionId, 0);
    const issuing = steps[steps.length - 1];
    assert.equal(issuing.tool_calls, 3, `the issuing step's three unique tool uses are archived, got ${JSON.stringify(steps.map(s => s.tool_calls))}`);
    assert.ok(eventRows(store, sessionId, 0).length > 0, 'the issuing step also archived its path events');
    assert.equal(telemetryStatus(store, sessionId, 0).telemetry_status, 'complete');
  });

  test('[delta] a load token on a lower-total usage revision is archived with its issuing step', () => {
    const { watcher, store, sessionId } = compose();
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      coldStep(),
      // The winner carries no token; a later, LOWER-total revision of the same logical message carries it.
      assistantObservation({
        uuid: 'a-issue', messageId: 'm-issue', blocks: [], timestamp: ts(2),
        model: 'claude-opus-4-8', usage: usage({ input: 300, output: 400, cacheRead: 24000, cacheWrite: 900 }),
      }),
      assistantToolUse({
        uuid: 'a-issue-rev', messageId: 'm-issue', toolUseId: 'tu-load', name: LOAD_TOOL,
        input: { load_token: 'carry-lyric-gear' }, timestamp: ts(3),
        model: 'claude-opus-4-8', usage: usage({ input: 300, output: 1, cacheRead: 24000, cacheWrite: 900 }),
      }),
      toolResult({ uuid: 'r-load', parentUuid: 'a-issue-rev', toolUseId: 'tu-load', content: 'handoff loaded', timestamp: ts(4) }),
      epochAt(9),
      assistantObservation({ uuid: 'a-next', messageId: 'm-next', blocks: [], timestamp: ts(10), model: 'claude-opus-4-8', usage: usage({ cacheRead: 5000, output: 5 }) }),
    ]));
    const steps = stepRows(store, sessionId, 0);
    const issuing = steps[steps.length - 1];
    assert.equal(issuing.output, 400, 'the higher-total revision remains the archived winner');
    assert.equal(issuing.cache_read, 24000);
    assert.equal(issuing.cache_creation, 900);
    assert.equal(issuing.input, 300);
    assert.equal(issuing.load_token, 'carry-lyric-gear');
  });

  test('[delta] a successful tool result whose issuing row has rejected usage updates resident state without archiving a path event', () => {
    const { watcher, store, sessionId } = compose();
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      coldStep(),
      // A row whose usage carries an explicit null in a known bucket is not a measured step at all, so the
      // step this Read issues from never exists — while the read content is still resident.
      {
        type: 'assistant', uuid: 'a-null', parentUuid: null, isSidechain: false, timestamp: ts(2),
        message: {
          id: 'm-null', role: 'assistant', model: 'claude-opus-4-8',
          usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: 'tu-null', name: 'Read', input: { file_path: '/repo/src/rejected.js' } }],
        },
      },
      toolResult({ uuid: 'r-null', parentUuid: 'a-null', toolUseId: 'tu-null', content: numbered(30), timestamp: ts(3) }),
      epochAt(9),
      assistantObservation({ uuid: 'a-next', messageId: 'm-next', blocks: [], timestamp: ts(10), model: 'claude-opus-4-8', usage: usage({ cacheRead: 5000, output: 5 }) }),
    ]));
    const steps = stepRows(store, sessionId, 0);
    assert.equal(steps.length, 1, 'only the accepted step is archived');
    assert.equal(steps[0].input, 20000);
    const events = eventRows(store, sessionId, 0);
    assert.deepEqual(events.filter(e => e.path.endsWith('rejected.js')), [],
      'the Read has no issuing accepted step, so it archives no path event');
    const paths = pathRows(store, sessionId, 0);
    assert.ok(paths.some(row => row.path === '/repo/src/rejected.js' && row.tokens > 0),
      `the Read effect is still resident in the archived paths, got ${JSON.stringify(paths)}`);
    const profile = store.getProfileSegments(sessionId).find(row => row.segment === 0);
    let sum = 0;
    for (const row of paths) sum += row.tokens;
    assert.ok(profile.bTotal >= sum, 'b_total holds the belief the archived paths sum into');
    assert.ok(profile.bTotal > 20000, 'b_total includes the Read effect on top of the cold-start floor');
  });
});

describe('profile snapshot path order', () => {
  test('[delta] archived profile snapshot paths are token-descending while path content and profile_paths stay unchanged', () => {
    const { watcher, store, sessionId } = compose();
    // The SMALLER resource is read FIRST, so arrival order and token order disagree: a snapshot in arrival
    // order would put `small.js` at the head.
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      coldStep(),
      assistantObservation({
        uuid: 'a-reads', messageId: 'm-reads', timestamp: ts(2), model: 'claude-opus-4-8',
        usage: usage({ input: 200, output: 20, cacheRead: 21000, cacheWrite: 500 }),
        blocks: [
          { type: 'tool_use', id: 'tu-small', name: 'Read', input: { file_path: '/repo/small.js' } },
          { type: 'tool_use', id: 'tu-large', name: 'Read', input: { file_path: '/repo/large.js' } },
        ],
      }),
      toolResult({ uuid: 'r-small', parentUuid: 'a-reads', toolUseId: 'tu-small', content: numbered(6), timestamp: ts(3) }),
      toolResult({ uuid: 'r-large', parentUuid: 'r-small', toolUseId: 'tu-large', content: numbered(90), timestamp: ts(3) }),
      assistantObservation({ uuid: 'a-settle', messageId: 'm-settle', blocks: [], timestamp: ts(4), model: 'claude-opus-4-8', usage: usage({ input: 200, output: 10, cacheRead: 26000, cacheWrite: 500 }) }),
    ]));

    const snapshot = watcher.getTerminalSnapshot();
    const names = snapshot.paths.map(row => row.path);
    assert.deepEqual(names, ['/repo/large.js', '/repo/small.js'],
      'the snapshot leads with the largest resource, not with the one that arrived first');
    for (let i = 1; i < snapshot.paths.length; i++) {
      assert.ok(snapshot.paths[i - 1].tokens >= snapshot.paths[i].tokens, 'strictly non-increasing tokens');
    }
    // Content is the same set the bucket read reports — a reorder must move nothing but position.
    const bucketContent = new Map(watcher.getBucketData().paths.map(row => [row.path, row.tokens]));
    assert.deepEqual(new Map(snapshot.paths.map(row => [row.path, row.tokens])), bucketContent,
      'every path keeps its own token count');
    assert.equal(snapshot.b_total, snapshot.paths.reduce((sum, row) => sum + row.tokens, 0) + watcher.getBucketData().dead,
      'the snapshot total is still the belief its own rows sum into');

    // The archived rows are unchanged: the same paths, and tokens that still reconcile against the archived
    // belief the finalizer froze.
    watcher.closeCurrentSegment();
    const archived = pathRows(store, sessionId, 0);
    assert.deepEqual(archived.map(row => row.path), ['/repo/large.js', '/repo/small.js'].sort(),
      'the archived path set is unchanged');
    const profile = store.getProfileSegments(sessionId).find(row => row.segment === 0);
    const archivedSum = archived.reduce((sum, row) => sum + row.tokens, 0);
    assert.ok(Math.abs(profile.bTotal - (profile.lFloor + archivedSum)) < 1e-9,
      `archived b_total reconciles against its own path rows, got ${profile.bTotal} vs ${profile.lFloor + archivedSum}`);
  });
});

describe('telemetry status', () => {
  test('a segment with steps and no path event is complete_empty', () => {
    const { watcher, store, sessionId } = compose();
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      coldStep(),
      assistantObservation({ uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(2), model: 'claude-opus-4-8', usage: usage({ cacheRead: 21000, output: 5 }) }),
    ]));
    watcher.closeCurrentSegment();
    assert.equal(eventRows(store, sessionId, 0).length, 0);
    assert.equal(telemetryStatus(store, sessionId, 0).telemetry_status, 'complete_empty');
  });

  test('a replay close records replay provenance on both halves', () => {
    const { watcher, store, sessionId } = compose();
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      coldStep(),
    ]), { captureMode: 'replay' });
    watcher.closeCurrentSegment({ captureMode: 'replay' });
    const status = telemetryStatus(store, sessionId, 0);
    assert.equal(status.capture_source, 'cc-replay');
    assert.equal(store.getProfileSegments(sessionId)[0].archiveSource, 'replay');
  });
});

describe('profile field coverage', () => {
  test('a closed segment carrying distinct sentinel metrics reaches every profile column', () => {
    // Sentinels rather than fixture-derived numbers: each column is asserted to hold ITS value, so a
    // transposed pair or a dropped field cannot pass. The archive context carries its own sentinels too.
    const store = openStore(join(dir, 'sentinel.sqlite'));
    stores.push(store);
    const closed = {
      segment: 4,
      epochModel: 'sentinel-model',
      steps: [{ id: 'sentinel-step', foldedSeq: 11, timestamp: 121212, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }],
      metrics: {
        lFloor: 31, bTotal: 32, lPeak: 33, gFinal: 34, oAvg: 35, cRatio: 36, turns: 37,
        durationMs: 38, totalTokensRead: 39, mf: 0.41, ppExit: 0.42, brExit: 0.43, brPeak: 0.44,
        ppPeak: 0.45, p0: 46, bAxis: 47, xAxis: 48, gMin: 49, turnAtBrAmber: 50,
      },
      paths: [{ path: '/repo/sentinel.js', tokens: 51 }],
    };
    const watcher = new SessionWatcher({
      sessionId: 'sid-sentinel',
      sourceLocator: '/t/sentinel.jsonl',
      projectId: '/sentinel-project',
      projectRoot: PROJECT,
      turnNotesRoot: join(dir, 'turn-notes'),
      resourcePolicy: createResourcePolicy({ projectRoot: PROJECT, isIgnored: null }),
      resourceEnrichment: NO_ENRICHMENT,
      handoffComposition: {},
      loaderVersion: '1.0.0',
      store,
      dialogueSource: { read: () => ({ status: 'unavailable', observations: [] }) },
      dialogueProjection: {},
      createEngine: () => ({
        ingest: () => ({ newCalls: 0, revisedCalls: 0, newResourceKeys: [], closedSegments: [], diagnostics: [] }),
        closeCurrentSegment: () => ({ closedSegments: [closed], diagnostics: [] }),
        getStatus: () => ({ rateLamp: { reliable: false, unavailableReason: 'insufficient_data' }, apiCalls: 0, segment: 4, turnSeq: 0, latestMeasuredModel: null }),
        getHistory: () => [],
        getBucketData: () => ({ dead: 0, paths: [], residual: [], totalB: 0, totalL: 0, bDefault: 0, totalResidualRaw: 0, totalResidual: 0, currentTurnSeq: 0, segment: 4 }),
        getHandoffMeasurement: () => ({ segment: 4, turnSeq: 0, epochModel: null, measurement: {}, paths: [] }),
        readRateLampFrame: () => ({ status: {}, progress: {}, samples: [], turnSeq: 0, foldedCallSeq: 0 }),
        replaceResourceOverrides: () => ({ changed: false, warnings: [], diagnostics: [] }),
        refreshReadPolicies: () => ({ changed: false, diagnostics: [] }),
      }),
      createMeasurementProjection: () => ({
        project: () => ({ records: [], diagnostics: [] }),
        finishSegment: (closedSegment) => ({
          artifact: closedSegment == null ? null : {
            captureSource: 'cc-live',
            payload: {
              steps: [{ foldedSeq: 11, ts: 121212, input: 1, output: 2, cacheRead: 3, cacheCreation: 4, toolCalls: 7, loadToken: 'sentinel-token' }],
              events: [{ foldedSeq: 11, eventOrdinal: 0, path: '/repo/sentinel.js', rawPath: 'sentinel.js', toolType: 'Read', isFullRead: 1 }],
            },
          },
          diagnostics: [],
        }),
      }),
      modelPolicyFor,
      now: () => 777_777,
    });
    assert.deepEqual(watcher.closeCurrentSegment().diagnostics, []);

    const row = store._db.prepare('SELECT * FROM profile WHERE session_id=? AND segment=?').get('sid-sentinel', 4);
    assert.deepEqual({ ...row }, {
      session_id: 'sid-sentinel', segment: 4, archived_at: 777777, model: 'sentinel-model',
      project_id: '/sentinel-project', l_floor: 31, b_total: 32, l_peak: 33, g_final: 34, o_avg: 35,
      c_ratio: 36, turns: 37, duration_ms: 38, total_tokens_read: 39, mf: 0.41, pp_exit: 0.42,
      br_exit: 0.43, br_peak: 0.44, pp_peak: 0.45, p0: 46, b_axis: 47, x_axis: 48, g_min: 49,
      turn_at_br_amber: 50, archive_source: 'live', archive_priority: 3,
      telemetry_status: 'complete', capture_source: 'cc-live',
    });
    for (const [column, value] of Object.entries(row)) {
      assert.notEqual(value, null, `profile.${column} arrived null`);
    }
    assert.deepEqual(pathRows(store, 'sid-sentinel', 4).map(row => ({ ...row })), [{ path: '/repo/sentinel.js', tokens: 51 }]);
    const steps = stepRows(store, 'sid-sentinel', 4);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].tool_calls, 7);
    assert.equal(steps[0].load_token, 'sentinel-token');
    for (const [column, value] of Object.entries(steps[0])) {
      assert.notEqual(value, null, `profile_step_usage.${column} arrived null`);
    }
    for (const [column, value] of Object.entries(eventRows(store, 'sid-sentinel', 4)[0])) {
      assert.notEqual(value, null, `profile_path_event.${column} arrived null`);
    }
  });
});

describe('multi-segment sessions', () => {
  test('each dead segment is archived on the live path and its own peaks accumulate', () => {
    const { watcher, store, sessionId } = compose({ sessionId: 'sid-multi' });
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(1), model: 'claude-opus-4-8', usage: usage({ input: 100, cacheRead: 50000, cacheWrite: 2000, output: 10 }) }),
      assistantObservation({ uuid: 'a2', messageId: 'm2', blocks: [], timestamp: ts(2), model: 'claude-opus-4-8', usage: usage({ input: 100, cacheRead: 90000, cacheWrite: 2000, output: 10 }) }),
      epochAt(3),
      assistantObservation({ uuid: 'a3', messageId: 'm3', blocks: [], timestamp: ts(4), model: 'claude-opus-4-8', usage: usage({ input: 100, cacheRead: 5000, cacheWrite: 2000, output: 10 }) }),
      assistantObservation({ uuid: 'a4', messageId: 'm4', blocks: [], timestamp: ts(5), model: 'claude-opus-4-8', usage: usage({ input: 100, cacheRead: 20000, cacheWrite: 2000, output: 10 }) }),
      epochAt(6),
    ]));
    const segments = store.getProfileSegments('sid-multi');
    const first = segments.find(row => row.segment === 0);
    assert.ok(first, `the dying segment is archived, got ${JSON.stringify(segments.map(s => s.segment))}`);
    assert.equal(first.archiveSource, 'live');
    assert.ok(first.lPeak >= 90000, 'the segment-local L peak is captured');
    assert.ok(first.totalTokensRead > 0, 'total_tokens_read accumulates per call');
    // Exact, because the second segment's peak is the reseed: without it the peak carried over and this
    // segment would archive the first one's, which is higher than any L this segment ever read.
    const second = segments.find(row => row.segment === 1);
    assert.equal(second.lPeak, 20000, 'a fresh segment reseeds its own L peak');
    assert.equal(segments.length, 2, 'the still-open segment is not archived');
    assert.equal(sessionId, 'sid-multi');
  });

  test('no later frame re-archives an already closed segment', () => {
    const { watcher, store } = compose({ sessionId: 'sid-idem' });
    apply(watcher, chain([
      userMessage({ uuid: 'u0', text: 'go', timestamp: ts(0) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(1), model: 'claude-opus-4-8', usage: usage({ input: 100, cacheRead: 50000, cacheWrite: 2000, output: 10 }) }),
      epochAt(2),
      assistantObservation({ uuid: 'a2', messageId: 'm2', blocks: [], timestamp: ts(3), model: 'claude-opus-4-8', usage: usage({ input: 100, cacheRead: 5000, cacheWrite: 2000, output: 10 }) }),
    ]));
    const before = store.getProfileSegments('sid-idem').length;
    watcher.applyHarnessFrame({ transition: 'append', batches: [], sourceObserved: true, captureMode: 'live' });
    assert.equal(store.getProfileSegments('sid-idem').length, before);
  });
});
