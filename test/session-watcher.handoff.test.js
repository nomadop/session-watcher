// Handoff preparation, search and delivery as SessionWatcher operations, with the REAL Store as the
// oracle: every assertion is either a field of the retained wire shape or a row the Store does or does not
// hold afterwards. The measurement side is a fake Engine — a handoff's contract is about the payload it
// carries and the delivery binding it writes, not about how B was computed.
import test, { describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionWatcher } from '../lib/session-watcher.js';
import { createHandoffComposition } from '../lib/handoff.js';
import { createResourcePolicy } from '../lib/resource-policy.js';
import { createResourceEnrichment } from '../lib/resource-enrichment.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { openStore, closeStore } from '../lib/store.js';

let dir;
let project;
let stores;

const DOC = ['# Alpha', '', 'alpha body', '', '# Beta', '', 'beta body', ''].join('\n');

// A fixed clock, but one inside the auto-match TTL window: an expired handoff is invisible to auto-match,
// so a hard-coded epoch far in the past would make every auto-match case vacuous.
const NOW = Date.now();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-hoint-'));
  project = join(dir, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  writeFileSync(join(project, 'notes.md'), DOC);
  stores = [];
});
afterEach(() => {
  for (const store of stores) { try { closeStore(store); } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

const MEASUREMENT = {
  segment: 2,
  turnSeq: 14,
  epochModel: 'claude-opus-4-8',
  measurement: { L: 90000, B: 60000, bDefault: 55000, g: 900, gBar: 700, mf: 0.3, br: 0.12, u: 3, pp: 0.31, x: 1.6, dhat: 0.2, cRatio: 12.5, dead: 42000, sessionFloor: 45000 },
  paths: [],
};

// The kept scenario's rate: the fake answers from the overrides it was handed, so a what-if that read the
// default rate, or built the wrong scenario, is visible in the stored stat.
let scenarioCalls = [];
const scenarioRateFor = (overrides) => 1000 + 10 * Object.values(overrides).filter(v => v === 'exclude').length + Object.values(overrides).filter(v => v === 'include').length;

function fakeEngine(measurement) {
  return {
    readScenario: (overrides) => { scenarioCalls.push(overrides); return { reliable: true, gBar: scenarioRateFor(overrides) }; },
    ingest: () => ({ newCalls: 0, revisedCalls: 0, newResourceKeys: [], closedSegments: [], diagnostics: [] }),
    closeCurrentSegment: () => ({ closedSegments: [], diagnostics: [] }),
    getStatus: () => ({ L: 90000, B: 60000, bDefault: 55000, g: 900, x: 1.6, dhat: 0.2, xSweet: 1.2, u: 3, pp: 0.31, mf: 0.3, br: 0.12, model: 'claude-opus-4-8', latestMeasuredModel: 'claude-opus-4-8', cRatio: 12.5, segment: measurement.segment, apiCalls: 4, turnSeq: measurement.turnSeq, usage: null, rateLamp: { reliable: true, B_default: 55000 } }),
    getHistory: () => [],
    getBucketData: () => ({ dead: 42000, paths: [], residual: [], totalB: 60000, totalL: 90000, bDefault: 55000, totalResidualRaw: 30000, totalResidual: 30000, currentTurnSeq: measurement.turnSeq, segment: measurement.segment }),
    getHandoffMeasurement: () => structuredClone(measurement),
    readRateLampFrame: () => ({ status: {}, progress: {}, samples: [], turnSeq: measurement.turnSeq, foldedCallSeq: 4 }),
    replaceResourceOverrides: () => ({ changed: false, warnings: [], diagnostics: [] }),
    refreshReadPolicies: () => ({ changed: false, diagnostics: [] }),
  };
}

let tokenSeq = 0;
function compose({ sessionId = 'sid-producer', store, measurement = MEASUREMENT, projectId = null, policyVersion = null } = {}) {
  const own = store ?? openStore(join(dir, `store-${stores.length}.sqlite`));
  if (!store) stores.push(own);
  const watcher = new SessionWatcher({
    sessionId,
    sourceLocator: join(dir, `${sessionId}.jsonl`),
    projectId: projectId ?? project,
    projectRoot: project,
    turnNotesRoot: join(dir, 'turn-notes'),
    resourcePolicy: createResourcePolicy({ projectRoot: project, isIgnored: null }),
    resourceEnrichment: createResourceEnrichment({}),
    handoffComposition: createHandoffComposition({ now: () => NOW, randomInt: () => (tokenSeq++) % 256 }),
    loaderVersion: '9.9.9',
    store: own,
    dialogueSource: { read: async () => ({ status: 'unavailable', observations: [] }) },
    dialogueProjection: {},
    createEngine: () => fakeEngine(measurement),
    createMeasurementProjection: () => ({ project: () => ({ records: [], diagnostics: [] }), finishSegment: () => ({ artifact: null, diagnostics: [] }) }),
    // An INJECTED policy version, when a test supplies one: the stored CTP generation must be whatever the
    // composition's own resolver reports, never a number written at the call site. No consumer supplies a
    // fallback, so a resolver that answers 7 must put 7 in the row.
    modelPolicyFor: policyVersion == null
      ? modelPolicyFor
      : (modelId) => {
        const base = modelPolicyFor(modelId);
        return { ...base, ctp: { ...base.ctp, version: policyVersion } };
      },
    now: () => NOW,
  });
  return { watcher, store: own };
}

const measurementWith = (paths) => ({ ...MEASUREMENT, paths });

const countHandoffs = (store) => store._db.prepare('SELECT COUNT(*) c FROM handoff').get().c;
const countLoads = (store) => store._db.prepare('SELECT COUNT(*) c FROM handoff_load').get().c;
const handoffRow = (store, token) => store._db.prepare('SELECT * FROM handoff WHERE load_token=?').get(token);

describe('prepareHandoff', () => {
  test('a prepared handoff answers with the retained ready shape and persists its payload', () => {
    const { watcher, store } = compose({
      measurement: measurementWith([
        { path: join(project, 'src/a.js'), tokens: 400, lastTurn: 12, fullSnapshot: false, lineNumbers: [1, 2, 3] },
        { path: join(project, 'src/gone.js'), tokens: 100, lastTurn: 3, fullSnapshot: false, lineNumbers: [9] },
      ]),
    });
    const result = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'src/a.js' }],
      skillsToKeep: ['sw-handoff', 'sw-handoff'],
      summary: 'carry the auth refactor over',
      nextTask: 'finish token refresh',
      observedSegment: 2,
    });
    assert.equal(result.status, 'ready');
    assert.deepEqual(Object.keys(result).sort(), [
      'discarded_tokens', 'instruction', 'invalid_paths', 'kept_paths', 'kept_tokens',
      'load_token', 'status', 'summary_tokens', 'unknown_paths',
    ]);
    assert.equal(result.kept_paths, 1);
    assert.equal(result.kept_tokens, 400);
    assert.equal(result.discarded_tokens, 100);
    assert.ok(result.summary_tokens > 0);
    assert.deepEqual(result.unknown_paths, []);
    assert.deepEqual(result.invalid_paths, []);
    assert.match(result.instruction, /context reset the host offers/);
    assert.ok(result.instruction.includes(result.load_token));

    const row = handoffRow(store, result.load_token);
    assert.equal(row.session_id, 'sid-producer');
    assert.equal(row.segment, 2);
    assert.equal(row.summary, 'carry the auth refactor over');
    assert.equal(row.next_task, 'finish token refresh');
    assert.equal(row.prepared_at_turn, 14);
    assert.equal(row.project_id, project);
    assert.equal(row.transcript_path, join(dir, 'sid-producer.jsonl'));
    const payload = JSON.parse(row.paths_to_keep);
    assert.deepEqual(payload.skills, ['sw-handoff'], 'skills are de-duplicated');
    assert.equal(payload.paths.length, 1);
    assert.equal(payload.paths[0].path, 'src/a.js');
    assert.equal(payload.paths[0].match_status, 'exact');
    assert.deepEqual(payload.paths[0].lines, [[1, 3]], 'bucket line coverage is injected as ranges');
    assert.equal(payload.paths[0].selected_line_count, 3);
    assert.equal(payload.paths[0].total_line_count, 3);
    assert.equal(typeof payload.paths[0].hp, 'string');
    const snapshot = JSON.parse(row.bucket_snapshot);
    assert.equal(snapshot.v, 1);
    assert.equal(snapshot.ctp_version, modelPolicyFor('claude-opus-4-8').ctp.version, 'the epoch model CTP version is stored');
    assert.equal(snapshot.total_candidates, 2);
    assert.equal(snapshot.root, project);
    const previous = JSON.parse(row.previous_stats);
    assert.equal(previous.b_full, 60000);
    // The selected basis, not the full belief: the two differ in this fixture, so a basis that fell back to
    // the full belief is visible here.
    assert.equal(previous.b_default, 55000);
    assert.equal(previous.dead, 42000);
    assert.equal(previous.session_floor, 45000);
    // The STAMPED pp, not a re-derivation from x and dhat: this fixture's pp disagrees with what those two
    // would yield, so a recomputing exit stat is visible here.
    assert.equal(previous.pp_exit, MEASUREMENT.measurement.pp);
    // The rate the fold runs on, not the smoothed g: the fixture carries both, so a stat reading the wrong
    // one is visible here.
    assert.equal(previous.g, 700);
    const prepared = JSON.parse(row.prepared_stats);
    assert.equal(prepared.b_kept, 400 + 45000);
    // The what-if's rate is the KEPT scenario's: the kept file carried, every other file left out as excess.
    assert.deepEqual(scenarioCalls.at(-1), { [join(project, 'src/a.js')]: 'include', [join(project, 'src/gone.js')]: 'exclude' });
    assert.equal(prepared.g, scenarioRateFor(scenarioCalls.at(-1)));
    assert.notEqual(prepared.g, previous.g, 'the exit stat keeps the default scenario\'s rate');
  });

  test('a stale observed segment is rejected without a write', () => {
    const { watcher, store } = compose();
    const result = watcher.prepareHandoff({ pathsToKeep: [], summary: 'x', observedSegment: 1 });
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'stale_bucket_summary');
    assert.equal(countHandoffs(store), 0);
  });

  test('input validation rejects before any write', () => {
    const { watcher, store } = compose();
    assert.equal(watcher.prepareHandoff({ pathsToKeep: 'nope', summary: 'x' }).error, 'invalid_paths_to_keep');
    assert.equal(watcher.prepareHandoff({ pathsToKeep: [], summary: '' }).error, 'summary_required');
    assert.equal(watcher.prepareHandoff({ pathsToKeep: [], summary: 'x'.repeat(10001) }).error, 'summary_too_long');
    assert.equal(watcher.prepareHandoff({ pathsToKeep: [], summary: 'x', nextTask: 'y'.repeat(2001) }).error, 'next_task_too_long');
    assert.equal(watcher.prepareHandoff({ pathsToKeep: Array.from({ length: 51 }, () => ({ path: 'a.js' })), summary: 'x' }).error, 'too_many_paths');

    // A new handoff names both inputs itself; the instruction answers with the way out of either gap.
    const noPaths = watcher.prepareHandoff({ summary: 'x' });
    const noSummary = watcher.prepareHandoff({ pathsToKeep: [] });
    assert.equal(noPaths.error, 'paths_to_keep_required');
    assert.equal(noSummary.error, 'summary_required');
    for (const result of [noPaths, noSummary]) {
      assert.equal(result.status, 'error');
      assert.match(result.instruction, /load_token/);
      assert.match(result.instruction, /paths_to_keep/);
    }
    assert.equal(noPaths.instruction, noSummary.instruction);
    assert.equal(watcher.prepareHandoff({ pathsToKeep: null, summary: 'x' }).error, 'paths_to_keep_required');
    assert.equal(watcher.prepareHandoff({ pathsToKeep: [], summary: null }).error, 'summary_required');
    assert.equal(watcher.prepareHandoff({}).error, 'paths_to_keep_required', 'paths_to_keep is judged before summary');
    assert.equal(watcher.prepareHandoff().error, 'paths_to_keep_required');
    assert.equal(watcher.prepareHandoff({ pathsToKeep: 'nope' }).error, 'invalid_paths_to_keep', 'a passed paths_to_keep is judged before a missing summary');
    assert.equal(countHandoffs(store), 0);
  });

  test('an empty next task is stored as NULL and the reply is otherwise the one an omitted next task gets', () => {
    const { watcher, store } = compose();
    const omitted = watcher.prepareHandoff({ pathsToKeep: [], summary: 'same words' });
    assert.equal(omitted.status, 'ready');
    const empty = watcher.prepareHandoff({ pathsToKeep: [], summary: 'same words', nextTask: '' });
    assert.equal(empty.status, 'ready');
    assert.equal(handoffRow(store, empty.load_token).next_task, null);
    assert.equal(handoffRow(store, omitted.load_token).next_task, null);
    const { load_token: _a, instruction: _b, ...omittedRest } = omitted;
    const { load_token: _c, instruction: _d, ...emptyRest } = empty;
    assert.deepEqual(emptyRest, omittedRest);
    assert.equal(countHandoffs(store), 2);
  });

  test('an unknown kept path is reported and an escaping one is invalid', () => {
    const { watcher } = compose({ measurement: measurementWith([{ path: join(project, 'src/a.js'), tokens: 400, lastTurn: 12, fullSnapshot: false, lineNumbers: [1] }]) });
    const result = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'src/missing.js' }, { path: '../outside.js' }],
      summary: 'keep something', observedSegment: 2,
    });
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.unknown_paths, ['src/missing.js']);
    assert.deepEqual(result.invalid_paths, [{ path: '../outside.js' }]);
  });

  test('a secret in the summary never reaches the stored row or the token', () => {
    const { watcher, store } = compose();
    const result = watcher.prepareHandoff({ pathsToKeep: [], summary: 'token is sk-abcdefghijklmnopqrstuv now', observedSegment: 2 });
    const row = handoffRow(store, result.load_token);
    assert.equal(row.summary.includes('sk-abcdefghij'), false);
    assert.match(row.summary, /\[REDACTED\]/);
    assert.equal(result.load_token.includes('sk'), false);
  });

  test('re-issuing against an existing token revises it in place', () => {
    const { watcher, store } = compose();
    const first = watcher.prepareHandoff({ pathsToKeep: [], summary: 'first summary', observedSegment: 2 });
    const again = watcher.prepareHandoff({ pathsToKeep: [], summary: 'second summary', observedSegment: 2, loadToken: first.load_token });
    assert.equal(again.load_token, first.load_token);
    assert.equal(countHandoffs(store), 1);
    assert.equal(handoffRow(store, first.load_token).summary, 'second summary');
  });

  test('an unknown token is reported rather than silently minting a new handoff', () => {
    const { watcher, store } = compose();
    const result = watcher.prepareHandoff({ pathsToKeep: [], summary: 'x', observedSegment: 2, loadToken: 'no-such-token' });
    assert.equal(result.error, 'token_not_found');
    assert.equal(countHandoffs(store), 0);
  });

  test('kept symbols become stored symbol ranges', () => {
    const { watcher, store } = compose({
      measurement: measurementWith([{ path: join(project, 'notes.md'), tokens: 200, lastTurn: 9, fullSnapshot: false, lineNumbers: [1, 2, 3] }]),
    });
    const result = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha'] }], summary: 'keep the alpha section', observedSegment: 2,
    });
    const entry = JSON.parse(handoffRow(store, result.load_token).paths_to_keep)[0]
      ?? JSON.parse(handoffRow(store, result.load_token).paths_to_keep).paths[0];
    assert.ok(entry.symbolRanges, 'symbol ranges replaced the bare symbol names');
    assert.deepEqual(Object.keys(entry.symbolRanges), ['Alpha']);
    assert.equal(entry.symbols, undefined);
  });

  // A whole-content resource holds every line it was READ with, so its coverage is the file's lines as of the
  // read — never empty. Symbol ranges are computed against that coverage on one unconditional route; only the
  // `entry.lines` injection is gated on the flag.
  test('a whole-content snapshot captures symbol ranges from its own read-time coverage', () => {
    const wholeCoverage = DOC.split('\n').map((unused, index) => index + 1);
    const { watcher, store } = compose({
      measurement: measurementWith([{ path: join(project, 'notes.md'), tokens: 200, lastTurn: 9, fullSnapshot: true, lineNumbers: wholeCoverage }]),
    });
    const result = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha', 'Beta'] }], summary: 'keep both sections', observedSegment: 2,
    });
    const stored = JSON.parse(handoffRow(store, result.load_token).paths_to_keep);
    const entry = Array.isArray(stored) ? stored[0] : stored.paths[0];
    assert.deepEqual(Object.keys(entry.symbolRanges).sort(), ['Alpha', 'Beta']);
    assert.equal(entry.lines, undefined, 'a whole-content snapshot injects no line ranges');
  });

  // The discriminator. The file is EDITED AFTER the read, so the read-time coverage and the file's current
  // line count disagree — and only then can the two candidate coverages be told apart. Ranges must follow the
  // lines the READ saw: the file's text is read at prepare time while the coverage is from then, which is
  // exactly what the baseline did. Computing them from the file's current length instead would reach the
  // appended section, which was never in this resource's coverage.
  test('symbol ranges follow the read-time coverage after the file grows, not the file\'s current length', () => {
    // The read saw only the Alpha section: lines 1-4 of the original document.
    const readTimeCoverage = [1, 2, 3, 4];
    // Then a Gamma section is appended, so the file on disk is longer than anything the read covered.
    writeFileSync(join(project, 'notes.md'), `${DOC}# Gamma\n\ngamma body\n`);

    const { watcher, store } = compose({
      measurement: measurementWith([{ path: join(project, 'notes.md'), tokens: 200, lastTurn: 9, fullSnapshot: true, lineNumbers: readTimeCoverage }]),
    });
    const result = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha', 'Beta', 'Gamma'] }],
      summary: 'kept after an edit', observedSegment: 2,
    });
    const stored = JSON.parse(handoffRow(store, result.load_token).paths_to_keep);
    const entry = Array.isArray(stored) ? stored[0] : stored.paths[0];
    assert.deepEqual(Object.keys(entry.symbolRanges), ['Alpha'],
      'only the symbol the read-time coverage actually reaches is captured');
    // Beta and Gamma sit outside the covered lines. Substituting the file's own complete coverage would have
    // captured all three, which is the difference this pins.
    assert.equal('Beta' in entry.symbolRanges, false);
    assert.equal('Gamma' in entry.symbolRanges, false);
  });

  // The empty-coverage case, unchanged from the baseline on both sides: a resource carrying no line keys at all
  // yields no symbol ranges. Removing the null substitution must not introduce a fallback here.
  test('a kept path whose resource carries no line coverage yields no symbol ranges', () => {
    const { watcher, store } = compose({
      measurement: measurementWith([{ path: join(project, 'notes.md'), tokens: 200, lastTurn: 9, fullSnapshot: true, lineNumbers: [] }]),
    });
    const result = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha', 'Beta'] }], summary: 'no coverage', observedSegment: 2,
    });
    const stored = JSON.parse(handoffRow(store, result.load_token).paths_to_keep);
    const entry = Array.isArray(stored) ? stored[0] : stored.paths[0];
    assert.equal(entry.symbolRanges, undefined, 'no coverage captures no range');
    assert.deepEqual(entry.symbols, ['Alpha', 'Beta'], 'and the requested symbols survive un-replaced');
  });
});

// A patch is exercised by a second watcher over the first one's store: another sessionId (so its
// `transcript_path` differs), another project, another model (so the same text weighs another
// `summary_tokens`) and a measurement that differs in every input a unit recomputes. A column a patch did not
// select can then only stay identical by being carried, never by being recomputed to the same value.
describe('prepareHandoff patch', () => {
  const TEXT_COLUMNS = ['summary', 'next_task', 'summary_tokens', 'search_terms'];
  const PATHS_COLUMNS = [
    'paths_to_keep', 'kept_tokens', 'discarded_tokens', 'prepared_at_turn', 'previous_stats', 'prepared_stats',
    'bucket_snapshot', 'transcript_path',
  ];
  const IDENTITY_COLUMNS = ['session_id', 'segment', 'project_id', 'created_at', 'load_token'];
  const pick = (row, columns) => Object.fromEntries(columns.map(column => [column, row[column]]));
  const omit = (row, columns) => Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));
  const payloadOf = (row) => {
    const parsed = JSON.parse(row.paths_to_keep);
    return Array.isArray(parsed) ? { entries: parsed, skills: [] } : { entries: parsed.paths, skills: parsed.skills };
  };

  const STORED_SKILLS = ['sw-handoff', 'sw-load'];
  const STORED_KEEP = () => [{ path: 'src/a.js' }, { path: 'notes.md', symbols: ['Alpha'] }];
  const STORED_SUMMARY = 'carry the auth refactor over';
  const STORED_NEXT_TASK = 'finish token refresh 令牌刷新';
  const otherProject = () => join(dir, 'other-project');

  const producerMeasurement = () => ({
    ...measurementWith([
      { path: join(project, 'src/a.js'), tokens: 400, lastTurn: 12, fullSnapshot: false, lineNumbers: [1, 2, 3] },
      { path: join(project, 'notes.md'), tokens: 200, lastTurn: 9, fullSnapshot: false, lineNumbers: [1, 2, 3] },
      { path: join(project, 'src/gone.js'), tokens: 100, lastTurn: 3, fullSnapshot: false, lineNumbers: [9] },
    ]),
  });

  // A model on another CTP_TABLE row, another segment and turn, another B and L, other kept-file tokens
  // (their sum included) and other line coverage, plus a second `a.js` that a bare `a.js` collides with.
  const patcherMeasurement = () => ({
    segment: 3,
    turnSeq: 31,
    epochModel: 'deepseek-v4-pro',
    measurement: { ...MEASUREMENT.measurement, L: 140000, B: 80000, bDefault: 72000, gBar: 900, mf: 0.4, br: 0.2, pp: 0.4, dead: 43000, sessionFloor: 46000 },
    paths: [
      { path: join(project, 'src/a.js'), tokens: 900, lastTurn: 30, fullSnapshot: false, lineNumbers: [1, 2] },
      { path: join(project, 'notes.md'), tokens: 450, lastTurn: 28, fullSnapshot: false, lineNumbers: [1, 2, 3, 4] },
      { path: join(project, 'src/gone.js'), tokens: 120, lastTurn: 5, fullSnapshot: false, lineNumbers: [9] },
      { path: join(project, 'lib/a.js'), tokens: 150, lastTurn: 20, fullSnapshot: false, lineNumbers: [1] },
    ],
  });

  function fixture({ skills = STORED_SKILLS } = {}) {
    const producer = compose({ sessionId: 'sid-producer', measurement: producerMeasurement() });
    const patcher = compose({ sessionId: 'sid-patcher', store: producer.store, measurement: patcherMeasurement(), projectId: otherProject() });
    const prepared = producer.watcher.prepareHandoff({
      pathsToKeep: STORED_KEEP(), skillsToKeep: skills, summary: STORED_SUMMARY, nextTask: STORED_NEXT_TASK, observedSegment: 2,
    });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    const token = prepared.load_token;
    return { producer, patcher, store: producer.store, token, before: () => handoffRow(producer.store, token) };
  }

  // What create mode stores under the patcher's policy and measurement: the oracle for a recomputed unit.
  function createdByPatcher(input) {
    const reference = compose({ sessionId: 'sid-patcher', measurement: patcherMeasurement(), projectId: otherProject() });
    const out = reference.watcher.prepareHandoff(input);
    assert.equal(out.status, 'ready', JSON.stringify(out));
    return { reply: out, row: handoffRow(reference.store, out.load_token) };
  }

  test('the two measurements differ in every column a unit recomputes', () => {
    const { before } = fixture();
    const created = createdByPatcher({
      pathsToKeep: STORED_KEEP(), skillsToKeep: STORED_SKILLS, summary: STORED_SUMMARY, nextTask: STORED_NEXT_TASK,
    }).row;
    for (const column of ['summary_tokens', 'kept_tokens', 'discarded_tokens', 'prepared_at_turn', 'previous_stats', 'prepared_stats', 'bucket_snapshot', 'transcript_path']) {
      assert.notEqual(created[column], before()[column], `${column} would move if a unit recomputed it`);
    }
    assert.notDeepEqual(payloadOf(created).entries, payloadOf(before()).entries, 'the entries would move if they were re-derived');
  });

  test('a summary patch changes the text unit and nothing else, and keeps its token', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const summary = '认证中间件重构 and the quarantine of the payment gateway';
    const oracle = createdByPatcher({ pathsToKeep: [], summary, nextTask: STORED_NEXT_TASK }).row;
    const reply = patcher.watcher.prepareHandoff({ loadToken: token, summary });
    const after = before();

    assert.equal(reply.status, 'ready', JSON.stringify(reply));
    assert.deepEqual(Object.keys(reply).sort(), [
      'discarded_tokens', 'instruction', 'kept_paths', 'kept_tokens', 'load_token', 'patched', 'status', 'summary_tokens',
    ]);
    assert.equal(reply.load_token, token);
    assert.deepEqual(reply.patched, ['summary']);
    assert.equal(reply.kept_paths, payloadOf(stored).entries.length);
    assert.equal(reply.kept_tokens, stored.kept_tokens);
    assert.equal(reply.discarded_tokens, stored.discarded_tokens);
    assert.equal(reply.summary_tokens, after.summary_tokens);
    assert.ok(reply.instruction.includes(token));

    assert.deepEqual(omit(after, TEXT_COLUMNS), omit(stored, TEXT_COLUMNS), 'only the text unit moved');
    assert.equal(after.summary, summary);
    assert.equal(after.next_task, STORED_NEXT_TASK);
    assert.equal(after.summary_tokens, oracle.summary_tokens);
    assert.equal(after.search_terms, oracle.search_terms);
    assert.notEqual(after.search_terms, stored.search_terms);
    assert.equal(countHandoffs(patcher.store), 1);
  });

  test('a secret in a patched summary or next task never reaches the stored row', () => {
    const { patcher, token, before } = fixture();
    const reply = patcher.watcher.prepareHandoff({
      loadToken: token, summary: 'token is sk-abcdefghijklmnopqrstuv now', nextTask: 'use ghp_abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(reply.status, 'ready');
    const after = before();
    assert.match(after.summary, /\[REDACTED\]/);
    assert.match(after.next_task, /\[REDACTED\]/);
    assert.equal(after.summary.includes('sk-abcdefghij'), false);
    assert.equal(after.next_task.includes('ghp_abcdefghij'), false);
  });

  test('a next task patch re-weighs the stored summary and rebuilds the search terms; an empty one clears it', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const nextTask = '修复令牌刷新逻辑';
    const oracle = createdByPatcher({ pathsToKeep: [], summary: STORED_SUMMARY, nextTask }).row;
    const reply = patcher.watcher.prepareHandoff({ loadToken: token, nextTask });
    const after = before();

    assert.deepEqual(reply.patched, ['next_task']);
    assert.deepEqual(omit(after, TEXT_COLUMNS), omit(stored, TEXT_COLUMNS));
    assert.equal(after.summary, STORED_SUMMARY, 'the summary was not passed');
    assert.equal(after.next_task, nextTask);
    assert.equal(after.search_terms, oracle.search_terms);
    assert.notEqual(after.search_terms, stored.search_terms);
    assert.equal(after.summary_tokens, oracle.summary_tokens, 'weighed under the calling watcher\'s policy');
    assert.notEqual(after.summary_tokens, stored.summary_tokens);

    const cleared = patcher.watcher.prepareHandoff({ loadToken: token, nextTask: '' });
    assert.deepEqual(cleared.patched, ['next_task']);
    assert.equal(before().next_task, null);
    assert.equal(before().summary, STORED_SUMMARY);
    assert.equal(before().search_terms, createdByPatcher({ pathsToKeep: [], summary: STORED_SUMMARY }).row.search_terms);
  });

  test('a paths patch re-measures the paths unit as create mode does and keeps the text unit and the skills', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const keep = [{ path: 'a.js' }, { path: 'notes.md', symbols: ['Alpha'] }, { path: 'src/missing.js' }, { path: '../outside.js' }];
    const created = createdByPatcher({ pathsToKeep: keep, skillsToKeep: STORED_SKILLS, summary: STORED_SUMMARY, nextTask: STORED_NEXT_TASK });
    const reply = patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: keep });
    const after = before();

    assert.equal(reply.status, 'ready', JSON.stringify(reply));
    assert.deepEqual(reply.patched, ['paths_to_keep']);
    assert.deepEqual(pick(after, PATHS_COLUMNS), pick({ ...created.row, transcript_path: join(dir, 'sid-patcher.jsonl') }, PATHS_COLUMNS));
    assert.equal(after.transcript_path, join(dir, 'sid-patcher.jsonl'));
    assert.deepEqual(payloadOf(after).skills, STORED_SKILLS, 'the stored skills ride along');
    assert.equal(after.summary_tokens, stored.summary_tokens, 'the stored summary was not re-weighed under the new policy');
    assert.deepEqual(omit(after, PATHS_COLUMNS), omit(stored, PATHS_COLUMNS), 'the text unit was not recomputed');

    for (const key of ['kept_paths', 'kept_tokens', 'discarded_tokens', 'unknown_paths', 'invalid_paths', 'resolved_paths']) {
      assert.deepEqual(reply[key], created.reply[key], key);
    }
    assert.deepEqual(reply.unknown_paths, ['src/missing.js']);
    assert.deepEqual(reply.invalid_paths, [{ path: '../outside.js' }]);
    assert.equal(reply.resolved_paths.length, 1, 'the bare a.js resolved by suffix');
    assert.equal(reply.summary_tokens, stored.summary_tokens);
    assert.deepEqual(Object.keys(reply).sort(), [
      'discarded_tokens', 'instruction', 'invalid_paths', 'kept_paths', 'kept_tokens', 'load_token', 'patched', 'resolved_paths',
      'status', 'summary_tokens', 'unknown_paths',
    ]);
  });

  test('a paths patch without a resolved suffix leaves resolved_paths out of the reply', () => {
    const { patcher, token } = fixture();
    const reply = patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: [{ path: 'src/a.js' }] });
    assert.equal(reply.status, 'ready');
    assert.equal('resolved_paths' in reply, false);
    assert.deepEqual(reply.unknown_paths, []);
    assert.deepEqual(reply.invalid_paths, []);
  });

  test('a skills patch rewrites only the skills and writes every entry back as stored', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const storedPayload = payloadOf(stored);
    assert.ok(storedPayload.entries.some(entry => entry.symbolRanges), 'precondition: an entry carries symbol ranges');

    const reply = patcher.watcher.prepareHandoff({ loadToken: token, skillsToKeep: ['only-this', 'only-this'] });
    const after = before();
    assert.deepEqual(reply.patched, ['skills_to_keep']);
    assert.deepEqual(omit(after, ['paths_to_keep']), omit(stored, ['paths_to_keep']), 'no measured or text column moved');
    assert.equal(after.paths_to_keep, JSON.stringify({ paths: storedPayload.entries, skills: ['only-this'] }), 'the entries are the stored bytes');
    assert.equal(reply.kept_paths, storedPayload.entries.length);
    assert.equal(reply.kept_tokens, stored.kept_tokens);
    assert.equal(reply.discarded_tokens, stored.discarded_tokens);
    assert.equal(reply.summary_tokens, stored.summary_tokens);
    assert.equal('unknown_paths' in reply, false);
    assert.equal('invalid_paths' in reply, false);

    const cleared = patcher.watcher.prepareHandoff({ loadToken: token, skillsToKeep: [] });
    assert.deepEqual(cleared.patched, ['skills_to_keep']);
    assert.equal(before().paths_to_keep, JSON.stringify(storedPayload.entries), 'no skills returns the plain array shape');
    assert.deepEqual(omit(before(), ['paths_to_keep']), omit(stored, ['paths_to_keep']));
  });

  test('a patch over a skill-less stored payload reads the plain array shape and writes it back', () => {
    const plainFixture = () => {
      const f = fixture({ skills: [] });
      const stored = f.before();
      const entries = JSON.parse(stored.paths_to_keep);
      assert.ok(Array.isArray(entries) && entries.length > 0, 'precondition: a plain array of entries');
      return { ...f, stored, entries };
    };

    const text = plainFixture();
    const summaryReply = text.patcher.watcher.prepareHandoff({ loadToken: text.token, summary: 'a summary over plain entries' });
    assert.deepEqual(summaryReply.patched, ['summary']);
    assert.equal(summaryReply.kept_paths, text.entries.length);
    assert.equal(text.before().paths_to_keep, text.stored.paths_to_keep, 'the stored bytes are untouched');

    const skills = plainFixture();
    const skillsReply = skills.patcher.watcher.prepareHandoff({ loadToken: skills.token, skillsToKeep: ['x'] });
    assert.deepEqual(skillsReply.patched, ['skills_to_keep']);
    assert.equal(skillsReply.kept_paths, skills.entries.length);
    assert.equal(skills.before().paths_to_keep, JSON.stringify({ paths: skills.entries, skills: ['x'] }));
    assert.deepEqual(omit(skills.before(), ['paths_to_keep']), omit(skills.stored, ['paths_to_keep']), 'no other column moved');

    const paths = plainFixture();
    const pathsReply = paths.patcher.watcher.prepareHandoff({ loadToken: paths.token, pathsToKeep: [{ path: 'notes.md' }] });
    assert.deepEqual(pathsReply.patched, ['paths_to_keep']);
    assert.ok(Array.isArray(JSON.parse(paths.before().paths_to_keep)), 'no skills keeps the plain array shape');
  });

  test('a call passing both paths and skills takes the passed skills', () => {
    const { patcher, token, before } = fixture();
    const reply = patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: [{ path: 'src/a.js' }], skillsToKeep: ['passed-skill'] });
    assert.deepEqual(reply.patched, ['paths_to_keep', 'skills_to_keep']);
    assert.deepEqual(payloadOf(before()).skills, ['passed-skill']);
    assert.deepEqual(payloadOf(before()).entries.map(entry => entry.path), ['src/a.js']);
  });

  test('a call selects the union of what it passes and never writes the row\'s identity', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const summary = 'a union of the text and paths units';
    const keep = [{ path: 'notes.md' }];
    const created = createdByPatcher({ pathsToKeep: keep, skillsToKeep: STORED_SKILLS, summary, nextTask: STORED_NEXT_TASK });
    const reply = patcher.watcher.prepareHandoff({
      skillsToKeep: STORED_SKILLS, pathsToKeep: keep, nextTask: STORED_NEXT_TASK, summary, loadToken: token, observedSegment: 3,
    });
    const after = before();

    assert.deepEqual(reply.patched, ['summary', 'next_task', 'paths_to_keep', 'skills_to_keep'], 'in the order of the contract');
    assert.deepEqual(pick(after, IDENTITY_COLUMNS), pick(stored, IDENTITY_COLUMNS));
    assert.equal(after.session_id, 'sid-producer', 'the patching watcher is not the row\'s owner');
    assert.equal(after.project_id, project);
    assert.equal(after.segment, 2);
    assert.equal(after.load_token, token, 'the token survives a summary change');
    for (const column of [...TEXT_COLUMNS, ...PATHS_COLUMNS.filter(column => column !== 'transcript_path')]) {
      assert.deepEqual(after[column], created.row[column], column);
    }
    assert.equal(after.transcript_path, join(dir, 'sid-patcher.jsonl'));
    assert.equal(countHandoffs(patcher.store), 1);
  });

  test('an explicit null is not passed, and an empty token is no token', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const text = patcher.watcher.prepareHandoff({ loadToken: token, summary: 'only words', nextTask: null, pathsToKeep: null, skillsToKeep: null });
    assert.deepEqual(text.patched, ['summary']);
    assert.equal(before().next_task, STORED_NEXT_TASK, 'a null next task clears nothing');
    assert.equal(before().paths_to_keep, stored.paths_to_keep);

    const paths = patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: [{ path: 'notes.md' }], summary: null, skillsToKeep: null });
    assert.deepEqual(paths.patched, ['paths_to_keep']);
    assert.deepEqual(payloadOf(before()).skills, STORED_SKILLS, 'a null skills_to_keep keeps the stored skills');

    const next = patcher.watcher.prepareHandoff({ loadToken: token, summary: null, nextTask: 'a later task' });
    assert.deepEqual(next.patched, ['next_task']);
    assert.equal(before().summary, 'only words', 'a null summary keeps the stored summary');

    const created = patcher.watcher.prepareHandoff({ loadToken: '', pathsToKeep: [], summary: 'a new handoff' });
    assert.equal(created.status, 'ready');
    assert.notEqual(created.load_token, token);
    assert.equal('patched' in created, false);
    assert.equal(countHandoffs(patcher.store), 2);
  });

  test('a patch passing nothing answers nothing_to_patch and leaves the row alone', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    for (const input of [{ loadToken: token }, { loadToken: token, observedSegment: 3 }, { loadToken: token, summary: null, pathsToKeep: undefined }]) {
      const reply = patcher.watcher.prepareHandoff(input);
      assert.equal(reply.status, 'error');
      assert.equal(reply.error, 'nothing_to_patch');
      assert.equal(reply.instruction, 'Pass at least one of summary, next_task, paths_to_keep, skills_to_keep.');
    }
    assert.deepEqual(before(), stored);
  });

  test('a patch is checked as create mode checks it, and an error writes nothing', () => {
    const { patcher, token, before } = fixture();
    const stored = before();
    const answer = (input) => patcher.watcher.prepareHandoff({ loadToken: token, ...input }).error;
    assert.equal(answer({ summary: '' }), 'summary_required');
    assert.equal(answer({ summary: 'x'.repeat(10001) }), 'summary_too_long');
    assert.equal(answer({ pathsToKeep: 'nope' }), 'invalid_paths_to_keep');
    assert.equal(answer({ pathsToKeep: Array.from({ length: 51 }, () => ({ path: 'a.js' })) }), 'too_many_paths');
    assert.equal(answer({ nextTask: 'y'.repeat(2001) }), 'next_task_too_long');
    assert.equal(answer({ summary: 'fine', pathsToKeep: 'nope' }), 'invalid_paths_to_keep', 'one bad value stops the whole patch');
    assert.equal(answer({ observedSegment: 2, summary: 'fine' }), 'stale_bucket_summary', 'the patcher\'s segment is 3');
    assert.deepEqual(before(), stored);
    assert.equal(countHandoffs(patcher.store), 1);
  });

  test('an unknown token answers token_not_found before any input is validated', () => {
    const { patcher } = fixture();
    for (const input of [{}, { pathsToKeep: 'nope', summary: '' }, { summary: 'x'.repeat(10001) }]) {
      const reply = patcher.watcher.prepareHandoff({ loadToken: 'no-such-token', ...input });
      assert.equal(reply.error, 'token_not_found', JSON.stringify(input));
    }
    assert.equal(patcher.watcher.prepareHandoff({ loadToken: 'no-such-token', observedSegment: 99 }).error, 'stale_bucket_summary',
      'the observed segment is checked before the mode is read');
    assert.equal(countHandoffs(patcher.store), 1);
  });

  describe('a delivered token', () => {
    async function delivered() {
      const f = fixture();
      const consumer = compose({ sessionId: 'sid-consumer', store: f.store }).watcher;
      assert.equal((await consumer.deliverHandoff({ loadToken: f.token })).found, true);
      assert.notEqual(f.before().delivered_at, null);
      return f;
    }

    test('with a partial argument set answers the create-mode error and adds no row', async () => {
      const { patcher, token, store, before } = await delivered();
      const stored = before();
      const answer = (input) => patcher.watcher.prepareHandoff({ loadToken: token, ...input }).error;
      assert.equal(answer({ summary: 'x' }), 'paths_to_keep_required');
      assert.equal(answer({ nextTask: 'x' }), 'paths_to_keep_required');
      assert.equal(answer({ skillsToKeep: [] }), 'paths_to_keep_required');
      assert.equal(answer({ pathsToKeep: [] }), 'summary_required');
      assert.equal(answer({}), 'paths_to_keep_required');
      assert.equal(countHandoffs(store), 1);
      assert.deepEqual(before(), stored);
    });

    test('with both parameters inserts a new row under a new token and carries nothing over', async () => {
      const { patcher, token, store, before } = await delivered();
      const stored = before();
      const reply = patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: [], summary: 'a fresh handoff' });
      assert.equal(reply.status, 'ready', JSON.stringify(reply));
      assert.notEqual(reply.load_token, token);
      assert.equal('patched' in reply, false, 'a create-mode reply has no patched');
      assert.equal(countHandoffs(store), 2);
      assert.deepEqual(before(), stored, 'the delivered row is immutable');
      const created = handoffRow(store, reply.load_token);
      assert.equal(created.next_task, null);
      assert.deepEqual(payloadOf(created), { entries: [], skills: [] });
      assert.equal(created.session_id, 'sid-patcher');
      assert.equal(created.delivered_at, null);
    });
  });

  test('a patch whose write finds the row delivered in the meantime falls to create mode', (t) => {
    const { patcher, token, store, before } = fixture();
    const stored = before();

    t.mock.method(store, 'updateHandoff', () => false, { times: 1 });
    const partial = patcher.watcher.prepareHandoff({ loadToken: token, summary: 'a summary only' });
    assert.equal(partial.error, 'paths_to_keep_required');
    assert.equal(countHandoffs(store), 1);

    t.mock.method(store, 'updateHandoff', () => false, { times: 1 });
    const whole = patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: [], summary: 'both parameters' });
    assert.equal(whole.status, 'ready');
    assert.notEqual(whole.load_token, token);
    assert.equal('patched' in whole, false);
    assert.equal(countHandoffs(store), 2);
    assert.deepEqual(before(), stored, 'the row the patch missed is untouched');
  });

  test('after a summary patch the handoff answers to its new words and no longer to its old ones; a skills patch changes nothing', (t) => {
    const { producer, patcher, token, store } = fixture();
    if (!store.ftsAvailable) return t.skip('FTS5 unavailable');
    const search = (query) => producer.watcher.searchHandoffs({ query });
    assert.equal(search('refactor').found, true, 'precondition: the old word finds the handoff');
    const beforeSkills = search('refactor');

    patcher.watcher.prepareHandoff({ loadToken: token, skillsToKeep: ['only-this'] });
    assert.deepEqual(search('refactor'), beforeSkills);

    patcher.watcher.prepareHandoff({ loadToken: token, summary: 'quarantine the payment gateway' });
    const found = search('gateway');
    assert.equal(found.found, true);
    assert.deepEqual(found.results.map(result => result.load_token), [token]);
    assert.deepEqual(search('refactor'), { found: false });
  });

  test('a patch over a stored payload that does not parse throws and writes nothing', () => {
    const { patcher, token, store, before } = fixture();
    store._db.prepare('UPDATE handoff SET paths_to_keep = ? WHERE load_token = ?').run('{not json', token);
    const stored = before();
    assert.throws(() => patcher.watcher.prepareHandoff({ loadToken: token, summary: 'a new summary' }), SyntaxError);
    assert.throws(() => patcher.watcher.prepareHandoff({ loadToken: token, skillsToKeep: ['x'] }), SyntaxError);
    assert.throws(() => patcher.watcher.prepareHandoff({ loadToken: token, pathsToKeep: [] }), SyntaxError);
    assert.deepEqual(before(), stored);
  });
});

describe('searchHandoffs', () => {
  test('a search returns the retained shape and performs no write', () => {
    const { watcher, store } = compose();
    const prepared = watcher.prepareHandoff({ pathsToKeep: [], summary: 'refactor the auth middleware', nextTask: 'fix token refresh', observedSegment: 2 });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const before = countLoads(store);
    const found = consumer.searchHandoffs({ query: 'middleware' });
    assert.equal(countLoads(store), before, 'search never records a delivery attempt');
    assert.equal(handoffRow(store, prepared.load_token).delivered_at, null, 'search never stamps a delivery');
    if (found.found) {
      assert.equal(found.mode, 'search');
      assert.deepEqual(Object.keys(found.results[0]).sort(), ['created_at', 'load_token', 'next_task', 'summary_preview']);
      assert.match(found.instruction, /load_handoff/);
    } else {
      assert.deepEqual(found, { found: false });
    }
  });

  test('a query with no match answers found false', () => {
    const { watcher, store } = compose();
    watcher.prepareHandoff({ pathsToKeep: [], summary: 'refactor the auth middleware', observedSegment: 2 });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const result = consumer.searchHandoffs({ query: 'zzzunmatchedzzz' });
    assert.equal(result.found, false);
  });
});

describe('deliverHandoff', () => {
  test('an explicit token delivers the retained wire shape and binds the primary consumer', async () => {
    const { watcher, store } = compose({
      measurement: measurementWith([{ path: join(project, 'notes.md'), tokens: 200, lastTurn: 9, fullSnapshot: false, lineNumbers: [1, 2, 3] }]),
    });
    const prepared = watcher.prepareHandoff({
      pathsToKeep: [{ path: 'notes.md', symbols: ['Alpha'] }],
      skillsToKeep: ['sw-handoff'],
      summary: 'carry over the alpha work', nextTask: 'do beta next', observedSegment: 2,
    });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const delivered = await consumer.deliverHandoff({ loadToken: prepared.load_token });
    assert.equal(delivered.found, true);
    assert.equal(delivered.load_token, prepared.load_token);
    assert.equal(delivered.summary, 'carry over the alpha work');
    assert.equal(delivered.created_at, NOW);
    assert.equal(delivered.project_dir, project);
    assert.deepEqual(delivered.skills_to_keep, ['sw-handoff']);
    assert.equal(typeof delivered.handoff_id, 'number');
    assert.equal(delivered.paths_to_keep.length, 1);
    const entry = delivered.paths_to_keep[0];
    assert.deepEqual(Object.keys(entry).sort(), ['lines', 'path', 'resolvedSymbols']);
    assert.equal(entry.symbolRanges, undefined, 'the agent sees resolved output, not raw ranges');
    assert.ok(entry.resolvedSymbols.some(line => line.includes('Alpha')));

    const row = handoffRow(store, prepared.load_token);
    assert.equal(row.delivered_session_id, 'sid-consumer');
    assert.equal(row.loader_version, '9.9.9');
    assert.equal(row.delivered_segment, 2);
    assert.equal(countLoads(store), 1);
    const stored = JSON.parse(row.paths_to_keep);
    assert.equal('hl' in stored.paths[0], true, 'the primary consumer stamped its own content hash');
  });

  test('a same-session retry recomposes the response and records a second attempt', async () => {
    const { watcher, store } = compose();
    const prepared = watcher.prepareHandoff({ pathsToKeep: [], summary: 'retry me', observedSegment: 2 });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const first = await consumer.deliverHandoff({ loadToken: prepared.load_token });
    const second = await consumer.deliverHandoff({ loadToken: prepared.load_token });
    assert.deepEqual(second, first, 'the response is recomposed identically');
    assert.ok(countLoads(store) >= 1, 'handoff_load records the delivery attempt');
    assert.equal(handoffRow(store, prepared.load_token).delivered_session_id, 'sid-consumer',
      'the first primary binding is the one that stands');
  });

  test('an unknown token answers found false', async () => {
    const { watcher } = compose();
    assert.deepEqual(await watcher.deliverHandoff({ loadToken: 'no-such-token' }), { found: false });
  });

  test('auto-match with a unique pending handoff delivers it', async () => {
    const { watcher, store } = compose();
    const prepared = watcher.prepareHandoff({ pathsToKeep: [], summary: 'the only pending one', observedSegment: 2 });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const delivered = await consumer.deliverHandoff();
    assert.equal(delivered.found, true);
    assert.equal(delivered.load_token, prepared.load_token);
    assert.equal(handoffRow(store, prepared.load_token).delivered_session_id, 'sid-consumer');
  });

  test('auto-match with nothing pending performs no write', async () => {
    const { watcher, store } = compose({ sessionId: 'sid-consumer' });
    assert.deepEqual(await watcher.deliverHandoff(), { found: false });
    assert.equal(countLoads(store), 0);
  });

  test('auto-match ambiguity lists candidates and performs no write', async () => {
    const { watcher, store } = compose();
    const first = watcher.prepareHandoff({ pathsToKeep: [], summary: 'first pending', nextTask: 'do the first thing', observedSegment: 2 });
    const second = watcher.prepareHandoff({ pathsToKeep: [], summary: 'second pending', nextTask: 'do the second thing', observedSegment: 2 });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const result = await consumer.deliverHandoff();
    assert.equal(result.found, false);
    assert.equal(result.ambiguous, true);
    assert.deepEqual(result.candidates.map(c => c.load_token).sort(), [first.load_token, second.load_token].sort());
    assert.deepEqual(Object.keys(result.candidates[0]).sort(), ['created_at', 'load_token', 'next_task_preview']);
    assert.equal(countLoads(store), 0, 'an ambiguous auto-match writes nothing');
    assert.equal(handoffRow(store, first.load_token).delivered_at, null);
    assert.equal(handoffRow(store, second.load_token).delivered_at, null);
  });

  test('auto-match without a project identity answers found false', async () => {
    const { watcher, store } = compose({ projectId: '' });
    assert.deepEqual(await watcher.deliverHandoff(), { found: false });
    assert.equal(countLoads(store), 0);
  });

  test('an unavailable delivery write is reported as retryable', async () => {
    const { watcher, store } = compose();
    const prepared = watcher.prepareHandoff({ pathsToKeep: [], summary: 'will fail delivery', observedSegment: 2 });
    const consumer = compose({ sessionId: 'sid-consumer', store }).watcher;
    const original = store._stmts.insertHandoffLoad;
    store._stmts.insertHandoffLoad = { run() { throw new Error('injected'); } };
    try {
      const result = await consumer.deliverHandoff({ loadToken: prepared.load_token });
      assert.deepEqual(result, { ok: false, error: 'handoff_delivery_unavailable', retryable: true });
    } finally { store._stmts.insertHandoffLoad = original; }
    assert.equal(handoffRow(store, prepared.load_token).delivered_at, null, 'the delivery unit rolled back whole');
  });
});

// The CTP generation a prepared handoff stores is the EPOCH MODEL's, taken from the composition's own resolver.
// Injecting a version the real table never uses is what proves no consumer substitutes a fallback or a
// hard-coded constant: if anything but the resolver answered, the row could not read 7.
test('prepareHandoff persists the injected policy version as bucket_snapshot.ctp_version', () => {
  const { watcher, store } = compose({ policyVersion: 7 });
  const out = watcher.prepareHandoff({
    pathsToKeep: [], skillsToKeep: [], summary: 'injected policy version', nextTask: null,
  });
  assert.equal(out.status, 'ready', JSON.stringify(out));
  const row = store._db.prepare('SELECT bucket_snapshot FROM handoff WHERE load_token = ?').get(out.load_token);
  const snapshot = JSON.parse(row.bucket_snapshot);
  assert.equal(snapshot.ctp_version, 7, 'the stored generation is the resolver\'s answer');
  // And it is not merely the real table's value by coincidence: the injected version differs from it.
  assert.notEqual(7, modelPolicyFor('claude-opus-4-8').ctp.version,
    'precondition: 7 is not what the real policy table reports, so this cannot pass by accident');
});
