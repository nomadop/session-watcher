// Segment Telemetry sidecar: the Projection-owned side channel that carries each issuing step's tool-use
// count, its first load token, and its path events, and joins them to a closed segment once. No telemetry
// fact may alter Engine measurement, so every case here drives the real Engine alongside the Projection.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeCodeMeasurementProjection } from '../lib/harness/claude-code/measurement-projection.js';
import {
  interpretClaudeCodeToolUse,
  completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload,
  interpretClaudeCodeTaskNotification,
} from '../lib/harness/claude-code/native-tools.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { charsToTokens } from '../lib/token-estimate.js';
import {
  ts, chain, usage, userMessage, assistantObservation, assistantToolUse, toolResult, skillPayloadRow,
} from './helpers/transcript-fixtures.js';

const FAST_MODEL = 'test-model-fast';
const SLOW_MODEL = 'test-model-slow';
const POLICIES = {
  [FAST_MODEL]: { ctp: { ascii: 4, cjk: 2, version: 9 }, cRatio: 12.5, contextCapacity: 200000 },
  [SLOW_MODEL]: { ctp: { ascii: 2, cjk: 1, version: 9 }, cRatio: 10, contextCapacity: 100000 },
};
const FAST_CTP = POLICIES[FAST_MODEL].ctp;
const SLOW_CTP = POLICIES[SLOW_MODEL].ctp;

function resolveModelPolicy(modelId) {
  return POLICIES[modelId] ?? POLICIES[FAST_MODEL];
}

const LOAD_TOOL = 'mcp__plugin_session-watcher_session-watcher__load_handoff';
const READ_LINES = ['1\tconst alpha = 1;', '2\tconst beta = 2;', '3\tconst gamma = 3;'];
const READ_RESULT = READ_LINES.join('\n');
const SKILL_LAUNCH = 'Launching skill: sw-handoff';
const STEP_USAGE = usage({ input: 7, output: 11, cacheRead: 13, cacheWrite: 17 });

function makeProjection(overrides = {}) {
  return createClaudeCodeMeasurementProjection({
    cwd: '/repo',
    projectRoot: '/repo',
    sourceLocator: '/transcripts/session.jsonl',
    resolveModelPolicy,
    interpretToolUse: interpretClaudeCodeToolUse,
    completeToolResult: completeClaudeCodeToolResult,
    interpretSkillPayload: interpretClaudeCodeSkillPayload,
    interpretTaskNotification: interpretClaudeCodeTaskNotification,
    ...overrides,
  });
}

function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy,
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}

function observationsOf(entries) {
  const buffer = Buffer.from(entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  return reduceClaudeCodeSnapshot(readClaudeCodeRows(buffer, { atEof: true }).rows).observations;
}

// One Projection bound to one Engine, driven the way the application drives them: every projected record
// reaches the Engine in order, and a closed segment goes straight back to the sidecar that produced its
// facts.
function harness({ captureMode = 'live' } = {}) {
  const projection = makeProjection();
  const engine = makeEngine();
  const records = [];
  const diagnostics = [];
  const artifacts = [];

  function feed(entries) {
    const perObservation = [];
    for (const observation of observationsOf(entries)) {
      const projected = projection.project(observation);
      records.push(...projected.records);
      diagnostics.push(...projected.diagnostics);
      perObservation.push([observation, projected]);
      const ingested = engine.ingest(projected.records);
      if (projected.records.some(record => record.type === 'epoch')) {
        artifacts.push(projection.finishSegment(ingested.closedSegments[0] ?? null, { captureMode }));
      }
    }
    return perObservation;
  }

  function close(options = { captureMode }) {
    const { closedSegments } = engine.closeCurrentSegment();
    const finished = projection.finishSegment(closedSegments[0] ?? null, options);
    artifacts.push(finished);
    return finished;
  }

  return { projection, engine, records, diagnostics, artifacts, feed, close };
}

function recordsOfType(records, type) {
  return records.filter(record => record.type === type);
}

function effectsOf(perObservation, observationType) {
  return perObservation
    .filter(([observation]) => observation.type === observationType)
    .map(([, projected]) => recordsOfType(projected.records, 'effect'));
}

function readToolUse({ uuid, messageId, toolUseId, timestamp, model = FAST_MODEL, filePath = 'lib/a.js', withUsage = true }) {
  return assistantToolUse({
    uuid, messageId, toolUseId, name: 'Read', input: { file_path: filePath }, timestamp, model,
    usage: withUsage ? STEP_USAGE : undefined,
  });
}

function skillToolUse({ uuid, messageId, toolUseId, timestamp, model = FAST_MODEL }) {
  return assistantToolUse({
    uuid, messageId, toolUseId, name: 'Skill', input: { skill: 'sw-handoff' }, timestamp, model,
    usage: STEP_USAGE,
  });
}

function loadToolUse({ uuid, messageId, toolUseId, timestamp, token = null }) {
  return assistantToolUse({
    uuid, messageId, toolUseId, name: LOAD_TOOL, input: token ? { load_token: token } : {},
    timestamp, model: FAST_MODEL, usage: STEP_USAGE,
  });
}

describe('Segment Telemetry sidecar', () => {
  test('the full Skill flow is await-result then await-skill-payload then deleted', () => {
    const driven = harness();
    const seen = driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: 'the real skill body', timestamp: ts(4) }),
      skillPayloadRow({ uuid: 'p2', parentUuid: 'p1', sourceToolUseID: 't1', text: 'a later payload', timestamp: ts(5) }),
    ]));
    const resultEffects = effectsOf(seen, 'tool-result');
    const payloadEffects = effectsOf(seen, 'skill-payload');
    assert.equal(resultEffects[0].length, 1, 'await-result completed into the initial effect');
    assert.equal(payloadEffects[0].length, 1, 'await-skill-payload completed into the replacement');
    assert.deepEqual(payloadEffects[1], [], 'the entry is deleted, so a later payload finds nothing');
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps.length, 1);
    assert.equal(payload.steps[0].toolCalls, 1, 'the Skill tool use counted once');
  });

  test('an empty skill-payload deletes the continuation and a later non-empty payload emits nothing', () => {
    const driven = harness();
    const seen = driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: '', timestamp: ts(4) }),
      skillPayloadRow({ uuid: 'p2', parentUuid: 'p1', sourceToolUseID: 't1', text: 'arrives too late', timestamp: ts(5) }),
    ]));
    const payloads = seen.filter(([observation]) => observation.type === 'skill-payload');
    assert.equal(payloads.length, 2, 'both payload rows were observed');
    assert.deepEqual(payloads[0][1].records, []);
    assert.deepEqual(payloads[1][1].records, []);
    assert.equal(recordsOfType(driven.records, 'effect').length, 1, 'only the launch confirmation priced anything');
  });

  test('a delayed Skill payload uses the issuing policy after the model changes', () => {
    const payloadText = 'skill body that outlives the model switch';
    const driven = harness();
    const seen = driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), model: FAST_MODEL }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      assistantObservation({
        uuid: 'a2', messageId: 'm2', blocks: [{ type: 'text', text: 'switched model' }], timestamp: ts(4),
        model: SLOW_MODEL, usage: STEP_USAGE,
      }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'a2', sourceToolUseID: 't1', text: payloadText, timestamp: ts(5) }),
    ]));
    const [payloadEffects] = effectsOf(seen, 'skill-payload');
    assert.equal(payloadEffects.length, 1);
    assert.equal(payloadEffects[0].impacts[0].mutation.fragments[0].tokens, charsToTokens(payloadText, FAST_CTP));
    assert.notEqual(charsToTokens(payloadText, FAST_CTP), charsToTokens(payloadText, SLOW_CTP),
      'the two policies price the same text differently');
  });

  test('a failed Skill result creates no continuation', () => {
    const driven = harness();
    const seen = driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: 'skill not found', isError: true, timestamp: ts(3) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: 'orphan body', timestamp: ts(4) }),
    ]));
    assert.deepEqual(effectsOf(seen, 'tool-result')[0], []);
    assert.deepEqual(effectsOf(seen, 'skill-payload')[0], []);
    assert.equal(driven.close().artifact.payload.steps[0].toolCalls, 1, 'the failed call still counted');
  });

  test('duplicate Skill results and payloads are first-wins', () => {
    const driven = harness();
    const seen = driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 't1', content: SKILL_LAUNCH + ' twice', timestamp: ts(4) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r2', sourceToolUseID: 't1', text: 'first body', timestamp: ts(5) }),
      skillPayloadRow({ uuid: 'p2', parentUuid: 'p1', sourceToolUseID: 't1', text: 'second body', timestamp: ts(6) }),
    ]));
    const resultEffects = effectsOf(seen, 'tool-result');
    const payloadEffects = effectsOf(seen, 'skill-payload');
    assert.equal(resultEffects[0].length, 1);
    assert.deepEqual(resultEffects[1], []);
    assert.equal(payloadEffects[0][0].impacts[0].mutation.fragments[0].tokens,
      charsToTokens('first body', FAST_CTP));
    assert.deepEqual(payloadEffects[1], []);
  });

  test('a missing Skill payload leaves the initial effect', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      userMessage({ uuid: 'u2', text: 'nothing follows', timestamp: ts(4) }),
    ]));
    const effects = recordsOfType(driven.records, 'effect');
    assert.equal(effects.length, 1);
    assert.equal(effects[0].impacts[0].mutation.fragments[0].tokens, charsToTokens(SKILL_LAUNCH, FAST_CTP));
  });

  test('multiple tool-use blocks in later revisions of one logical message all count', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read three files', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), filePath: 'lib/a.js' }),
      readToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't2', timestamp: ts(3), filePath: 'lib/b.js' }),
      readToolUse({ uuid: 'a3', messageId: 'm1', toolUseId: 't3', timestamp: ts(4), filePath: 'lib/c.js' }),
    ]));
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps.length, 1, 'one logical message is one step');
    assert.equal(payload.steps[0].toolCalls, 3);
  });

  test('tool-use facts on a lower-total usage revision enter the sidecar while Engine usage stays unchanged', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'resume', timestamp: ts(1) }),
      assistantToolUse({
        uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'Read', input: { file_path: 'lib/a.js' },
        timestamp: ts(2), model: FAST_MODEL, usage: usage({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }),
      }),
      loadToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't2', timestamp: ts(3), token: 'tk-late' }),
    ]));
    // The second row of this logical message carries a lower usage total: the Engine keeps the higher one.
    const [step] = driven.close().artifact.payload.steps;
    assert.deepEqual(
      [step.input, step.output, step.cacheRead, step.cacheCreation],
      [10, 20, 300, 40],
    );
    assert.equal(step.toolCalls, 2, 'both tool uses entered the sidecar');
    assert.equal(step.loadToken, 'tk-late', 'the lower revision still contributed its load token');
  });

  test('duplicate native tool-use IDs count once', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      readToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't1', timestamp: ts(3) }),
      toolResult({ uuid: 'r1', parentUuid: 'a2', toolUseId: 't1', content: READ_RESULT, timestamp: ts(4) }),
    ]));
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps[0].toolCalls, 1);
  });

  test('explicit load token is first-wins', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'resume', timestamp: ts(1) }),
      loadToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), token: 'tk-first' }),
      loadToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't2', timestamp: ts(3), token: 'tk-second' }),
    ]));
    assert.equal(driven.close().artifact.payload.steps[0].loadToken, 'tk-first');
    assert.deepEqual(driven.diagnostics.map(entry => entry.code), ['multiple_load_tokens']);
  });

  test('a twice-revised foldedSeq retains its max-token snapshot', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [{ type: 'text', text: 'one' }], timestamp: ts(2),
        model: FAST_MODEL, usage: usage({ input: 1, output: 1, cacheRead: 50, cacheWrite: 10 }),
      }),
      assistantObservation({
        uuid: 'a2', messageId: 'm1', blocks: [{ type: 'text', text: 'two' }], timestamp: ts(3),
        model: FAST_MODEL, usage: usage({ input: 1, output: 200, cacheRead: 50, cacheWrite: 10 }),
      }),
      assistantObservation({
        uuid: 'a3', messageId: 'm1', blocks: [{ type: 'text', text: 'three' }], timestamp: ts(4),
        model: FAST_MODEL, usage: usage({ input: 1, output: 100, cacheRead: 50, cacheWrite: 10 }),
      }),
    ]));
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps.length, 1);
    assert.deepEqual(
      [payload.steps[0].foldedSeq, payload.steps[0].output],
      [1, 200],
    );
  });

  test('auto-match load token can arrive on a later result', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'resume', timestamp: ts(1) }),
      loadToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      // A later step lands before the load result comes back.
      assistantObservation({
        uuid: 'a2', messageId: 'm2', blocks: [{ type: 'text', text: 'meanwhile' }], timestamp: ts(3),
        model: FAST_MODEL, usage: usage({ input: 5, output: 5, cacheRead: 400, cacheWrite: 5 }),
      }),
      toolResult({ uuid: 'r1', parentUuid: 'a2', toolUseId: 't1', content: '{"load_token":"tk-resolved"}', timestamp: ts(4) }),
    ]));
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps.length, 2);
    assert.deepEqual(payload.steps.map(step => step.loadToken), ['tk-resolved', null],
      'the resolved token lands on the issuing step, not the current one');
  });

  test('facts whose step is absent from the closed segment are discarded', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      // This logical message never carries usage, so it never becomes a measured step.
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), withUsage: false }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
      assistantObservation({
        uuid: 'a2', messageId: 'm2', blocks: [{ type: 'text', text: 'measured' }], timestamp: ts(4),
        model: FAST_MODEL, usage: STEP_USAGE,
      }),
    ]));
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps.length, 1);
    assert.equal(payload.steps[0].toolCalls, 0);
    assert.deepEqual(payload.events, []);
  });

  test('finishSegment opens an empty sidecar before joining closing facts', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
    ]));
    const first = driven.close().artifact.payload;
    assert.equal(first.steps[0].toolCalls, 1);
    assert.equal(first.events.length, 1);
    // Facts observed after the close belong to the new sidecar and to the next segment alone.
    driven.feed(chain([
      userMessage({ uuid: 'u2', text: 'read the other one', timestamp: ts(4) }),
      readToolUse({ uuid: 'a2', messageId: 'm2', toolUseId: 't2', timestamp: ts(5), filePath: 'lib/b.js' }),
      toolResult({ uuid: 'r2', parentUuid: 'a2', toolUseId: 't2', content: READ_RESULT, timestamp: ts(6) }),
    ]));
    const second = driven.close().artifact.payload;
    assert.equal(second.steps.length, 1, 'the closed segment holds only the new step');
    assert.equal(second.steps[0].toolCalls, 1);
    assert.deepEqual(second.events.map(event => event.path), ['/repo/lib/b.js']);
  });

  test('finishSegment(null, options) discards closing facts and returns artifact null', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
    ]));
    const discarded = driven.projection.finishSegment(null, { captureMode: 'live' });
    assert.equal(discarded.artifact, null);
    assert.deepEqual(discarded.diagnostics, []);
    // The discarded facts do not reappear in the next join.
    const payload = driven.close().artifact.payload;
    assert.equal(payload.steps[0].toolCalls, 0);
    assert.deepEqual(payload.events, []);
  });

  test('the detached artifact carries every unique issuing-step tool use and its path events without a Store', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read then run', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
      assistantToolUse({
        uuid: 'a2', messageId: 'm2', toolUseId: 't2', name: 'Bash', input: { command: 'npm test' },
        timestamp: ts(4), model: FAST_MODEL, usage: usage({ input: 5, output: 5, cacheRead: 400, cacheWrite: 5 }),
      }),
      toolResult({ uuid: 'r2', parentUuid: 'a2', toolUseId: 't2', content: 'all tests pass', timestamp: ts(5) }),
    ]));
    const finished = driven.close();
    assert.equal(finished.artifact.captureSource, 'cc-live');
    const payload = finished.artifact.payload;
    assert.deepEqual(payload.steps.map(step => [step.foldedSeq, step.toolCalls]), [[1, 1], [2, 1]]);
    assert.deepEqual(payload.events, [{
      foldedSeq: 1, eventOrdinal: 0, path: '/repo/lib/a.js', rawPath: 'lib/a.js', toolType: 'Read', isFullRead: 1,
    }]);
    // Detached: mutating the returned value cannot reach the Projection's own state.
    payload.steps[0].toolCalls = 99;
    payload.events.length = 0;
    driven.feed(chain([
      userMessage({ uuid: 'u3', text: 'read again', timestamp: ts(6) }),
      readToolUse({ uuid: 'a3', messageId: 'm3', toolUseId: 't3', timestamp: ts(7), filePath: 'lib/c.js' }),
      toolResult({ uuid: 'r3', parentUuid: 'a3', toolUseId: 't3', content: READ_RESULT, timestamp: ts(8) }),
    ]));
    const next = driven.close().artifact.payload;
    assert.deepEqual(next.steps.map(step => step.toolCalls), [1]);
    assert.deepEqual(next.events.map(event => event.eventOrdinal), [0]);
  });

  test('join failure returns a diagnostic and leaves the new sidecar active', () => {
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
    ]));
    const broken = driven.projection.finishSegment({ segment: 1, steps: null }, { captureMode: 'live' });
    assert.equal(broken.artifact, null);
    assert.equal(broken.diagnostics.length, 1);
    assert.equal(broken.diagnostics[0].code, 'segment_telemetry_join_failed');
    // The sidecar the failed join opened is live: later facts still reach the next artifact.
    driven.feed(chain([
      userMessage({ uuid: 'u2', text: 'read the other one', timestamp: ts(4) }),
      readToolUse({ uuid: 'a2', messageId: 'm2', toolUseId: 't2', timestamp: ts(5), filePath: 'lib/b.js' }),
      toolResult({ uuid: 'r2', parentUuid: 'a2', toolUseId: 't2', content: READ_RESULT, timestamp: ts(6) }),
    ]));
    const payload = driven.close().artifact.payload;
    assert.deepEqual(payload.events.map(event => event.path), ['/repo/lib/b.js']);
  });

  test('finishSegment with no epoch observation leaves no armed correlation', () => {
    // The rotate and terminal-close shape: the segment boundary arrives as a `finishSegment` call, with no
    // `epoch-boundary` observation anywhere in the source.
    const driven = harness();
    driven.feed(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
    ]));
    driven.close();
    const late = driven.projection.project({
      type: 'tool-result', toolUseId: 't1', content: READ_RESULT, isError: undefined,
      resultMeta: { annotation: undefined }, sourceOrdinal: 9, sourceEntryId: 'r9', timestamp: 9000,
      provenance: 'harness',
    });
    assert.deepEqual(late.records, [], 'a result whose segment already closed completes nothing');
  });

  test('captureMode live maps to cc-live and replay maps to cc-replay', () => {
    function captureSourceFor(captureMode) {
      const driven = harness({ captureMode });
      driven.feed(chain([
        userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
        assistantObservation({
          uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(2), model: FAST_MODEL, usage: STEP_USAGE,
        }),
      ]));
      return driven.close({ captureMode }).artifact.captureSource;
    }
    assert.equal(captureSourceFor('live'), 'cc-live');
    assert.equal(captureSourceFor('replay'), 'cc-replay');
  });
});
