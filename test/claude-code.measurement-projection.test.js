// Claude Code Measurement Projection: normalized observations become MeasurementRecords, native tool
// correlation lives here, and nothing but records and diagnostics crosses the seam. Every fixture drives
// the real Transcript Observation reducer, so the observations under test are the ones the source produces.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';

import { createClaudeCodeMeasurementProjection } from '../lib/harness/claude-code/measurement-projection.js';
import {
  interpretClaudeCodeToolUse,
  completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload,
  interpretClaudeCodeTaskNotification,
} from '../lib/harness/claude-code/native-tools.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';
import { charsToTokens } from '../lib/token-estimate.js';
import { TOOL_OVERHEAD } from '../lib/constants.js';
import {
  ts, chain, usage, userMessage, assistantObservation, assistantToolUse, toolResult, skillPayloadRow,
  compactSummary,
} from './helpers/transcript-fixtures.js';

// Fixed injected policies rather than the shipped model table: the Projection's contract is that each step
// is priced with the policy its own model resolved to, and two deliberately different CTP pairs are what
// make a cross-bound price visible.
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

function observationsOf(entries) {
  const buffer = Buffer.from(entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  return reduceClaudeCodeSnapshot(readClaudeCodeRows(buffer, { atEof: true }).rows).observations;
}

function run(projection, observations) {
  const records = [];
  const diagnostics = [];
  for (const observation of observations) {
    const result = projection.project(observation);
    records.push(...result.records);
    diagnostics.push(...result.diagnostics);
  }
  return { records, diagnostics };
}

// Drives a run and, at each `epoch` record, hands the Projection the closed segment the caller queued for
// it — the sequence the application performs after a successful Engine epoch.
function runWithCloses(projection, observations, closedSegments, { captureMode = 'live' } = {}) {
  const records = [];
  const diagnostics = [];
  const artifacts = [];
  const queued = [...closedSegments];
  for (const observation of observations) {
    const result = projection.project(observation);
    records.push(...result.records);
    diagnostics.push(...result.diagnostics);
    for (const record of result.records) {
      if (record.type !== 'epoch') continue;
      artifacts.push(projection.finishSegment(queued.length > 0 ? queued.shift() : null, { captureMode }));
    }
  }
  return { records, diagnostics, artifacts };
}

// The reducer's own namespaced identity for a native message id, read off the step it produces rather than
// restated here: the namespace belongs to Transcript Observation.
function stepIdOf(nativeMessageId) {
  const observations = observationsOf(chain([
    userMessage({ uuid: 'probe-u', text: 'probe', timestamp: ts(0) }),
    assistantObservation({
      uuid: 'probe-a', messageId: nativeMessageId, blocks: [], timestamp: ts(0),
      model: FAST_MODEL, usage: usage({ input: 1, cacheRead: 1 }),
    }),
  ]));
  return observations.find(observation => observation.type === 'usage').messageId;
}

// One closed step in the Engine's frozen shape.
function closedStep(nativeMessageId, foldedSeq) {
  return {
    id: stepIdOf(nativeMessageId),
    foldedSeq,
    timestamp: foldedSeq * 1000,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  };
}

function recordsOfType(records, type) {
  return records.filter(record => record.type === type);
}

function onlyRecordOfType(records, type) {
  const found = recordsOfType(records, type);
  assert.equal(found.length, 1, `exactly one ${type} record`);
  return found[0];
}

function lineTokens(ctp) {
  return READ_LINES.reduce((sum, line) => sum + charsToTokens(line, ctp), 0);
}

// The tokens one effect's first impact attributes to its resource. Every fragment snapshot keys by source
// line, so a resource's priced total is the sum across its fragments rather than a single synthetic entry.
function fragmentTotal(effect) {
  return effect.impacts[0].mutation.fragments.reduce((sum, fragment) => sum + fragment.tokens, 0);
}

function readToolUse({ uuid, messageId, toolUseId, timestamp, model = FAST_MODEL, filePath = 'lib/a.js', withUsage = true, text = null }) {
  return assistantToolUse({
    uuid, messageId, toolUseId, name: 'Read', input: { file_path: filePath }, timestamp, model, text,
    usage: withUsage ? STEP_USAGE : undefined,
  });
}

function skillToolUse({ uuid, messageId, toolUseId, timestamp, model = FAST_MODEL }) {
  return assistantToolUse({
    uuid, messageId, toolUseId, name: 'Skill', input: { skill: 'sw-handoff' }, timestamp, model,
    usage: STEP_USAGE,
  });
}

describe('Claude Code Measurement Projection', () => {
  // Constructed directly rather than through `makeProjection`, which supplies every interpreter: what this
  // pins is the diagnosis a composition omitting one gets, and the helper would fill the omission in.
  test('a Projection constructed without a task-notification interpreter fails at construction and names it', () => {
    assert.throws(() => createClaudeCodeMeasurementProjection({
      cwd: '/repo',
      projectRoot: '/repo',
      sourceLocator: '/transcripts/session.jsonl',
      resolveModelPolicy,
      interpretToolUse: interpretClaudeCodeToolUse,
      completeToolResult: completeClaudeCodeToolResult,
      interpretSkillPayload: interpretClaudeCodeSkillPayload,
    }), /claude code measurement projection invariant: interpretTaskNotification must be a function/);
  });

  test('epoch-boundary maps to one epoch record', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'start', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [{ type: 'text', text: 'ok' }], timestamp: ts(2),
        model: FAST_MODEL, usage: STEP_USAGE,
      }),
      compactSummary({ uuid: 'c1', timestamp: ts(3) }),
      userMessage({ uuid: 'u2', text: 'continue', timestamp: ts(4) }),
    ]));
    const { records } = run(makeProjection(), observations);
    assert.deepEqual(recordsOfType(records, 'epoch'), [{ type: 'epoch' }]);
  });

  test('a compact summary keeps its topology root inside one chain', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'before', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(2), model: FAST_MODEL, usage: STEP_USAGE,
      }),
      compactSummary({ uuid: 'c1', timestamp: ts(3) }),
      userMessage({ uuid: 'u2', text: 'after', timestamp: ts(4) }),
      assistantObservation({
        uuid: 'a2', messageId: 'm2', blocks: [], timestamp: ts(5), model: FAST_MODEL, usage: STEP_USAGE,
      }),
    ]));
    const { records } = run(makeProjection(), observations);
    assert.deepEqual(recordsOfType(records, 'epoch'), [{ type: 'epoch' }]);
    assert.equal(recordsOfType(records, 'step').length, 2, 'the rows after the summary stay on the chain');
  });

  test('turn-boundary maps to one turn-boundary record', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'one human turn', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [{ type: 'text', text: 'ok' }], timestamp: ts(2),
        model: FAST_MODEL, usage: STEP_USAGE,
      }),
    ]));
    const { records } = run(makeProjection(), observations);
    assert.deepEqual(recordsOfType(records, 'turn-boundary'), [{ type: 'turn-boundary' }]);
  });

  test('canonical usage maps to one step', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [{ type: 'text', text: 'answer' }], timestamp: ts(2),
        model: SLOW_MODEL, usage: STEP_USAGE,
      }),
    ]));
    const usageObservation = observations.find(observation => observation.type === 'usage');
    const { records } = run(makeProjection(), observations);
    const step = onlyRecordOfType(records, 'step');
    assert.equal(step.id, usageObservation.messageId);
    assert.equal(step.model, SLOW_MODEL);
    assert.equal(step.timestamp, usageObservation.timestamp);
  });

  test('usage buckets map to input, output, cacheRead and cacheWrite', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(2),
        model: FAST_MODEL, usage: usage({ input: 7, output: 11, cacheRead: 13, cacheWrite: 17 }),
      }),
    ]));
    const { records } = run(makeProjection(), observations);
    assert.deepEqual(onlyRecordOfType(records, 'step').usage,
      { input: 7, output: 11, cacheRead: 13, cacheWrite: 17 });
  });

  test('text-only observations produce no measurement record', () => {
    const observations = observationsOf(chain([
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1), model: FAST_MODEL,
        blocks: [{ type: 'text', text: 'reasoning aloud' }, { type: 'thinking', thinking: 'quietly' }],
      }),
    ]));
    assert.ok(observations.some(observation => observation.type === 'text'), 'the run carries a text observation');
    const { records, diagnostics } = run(makeProjection(), observations);
    assert.deepEqual(records, []);
    assert.deepEqual(diagnostics, []);
  });

  test('diagnostics may accompany records', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'resume', timestamp: ts(1) }),
      assistantToolUse({
        uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: LOAD_TOOL, input: { load_token: 'tk-first' },
        timestamp: ts(2), model: FAST_MODEL, usage: STEP_USAGE,
      }),
      assistantToolUse({
        uuid: 'a2', messageId: 'm1', toolUseId: 't2', name: LOAD_TOOL, input: {},
        timestamp: ts(3), model: FAST_MODEL, usage: STEP_USAGE,
      }),
      toolResult({ uuid: 'r2', parentUuid: 'a2', toolUseId: 't2', content: '{"load_token":"tk-second"}', timestamp: ts(4) }),
    ]));
    const projection = makeProjection();
    let conflicting = null;
    for (const observation of observations) {
      const result = projection.project(observation);
      if (result.diagnostics.length > 0) conflicting = result;
    }
    assert.ok(conflicting, 'one project call reported a diagnostic');
    assert.equal(conflicting.diagnostics.length, 1);
    assert.equal(conflicting.diagnostics[0].code, 'multiple_load_tokens');
    assert.equal(recordsOfType(conflicting.records, 'residual').length, 1,
      'the same call still emitted its residual candidate');
  });

  test('a Projection invariant failure throws', () => {
    const projection = makeProjection();
    assert.throws(() => projection.project({ type: 'not-an-observation-type' }),
      /claude code measurement projection invariant/);
    assert.throws(() => projection.project(null), /claude code measurement projection invariant/);
  });

  test('a task-notification observation produces exactly one Agent residual candidate without tool correlation', () => {
    const notification = '<task-notification><task-id>abcdef1234-99</task-id>'
      + '<summary>Agent "explore" finished</summary></task-notification>';
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'delegate', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', messageId: 'm1', blocks: [], timestamp: ts(2), model: FAST_MODEL, usage: STEP_USAGE,
      }),
      userMessage({ uuid: 'n1', text: notification, timestamp: ts(3) }),
    ]));
    const projection = makeProjection();
    const { records } = run(projection, observations);
    const residual = onlyRecordOfType(records, 'residual');
    assert.equal(residual.groupKey, 'agent:abcdef12');
    assert.equal(residual.meta.kind, 'agent');
    assert.equal(residual.hadError, false);
    assert.equal(residual.weight, notification.length);
    // No correlation and no sidecar entry: the closed step carries no tool use and no path event.
    const { artifact } = projection.finishSegment({ segment: 1, steps: [closedStep('m1', 1)] }, { captureMode: 'live' });
    assert.deepEqual(artifact.payload.events, []);
    assert.equal(artifact.payload.steps[0].toolCalls, 0);
  });

  test('an empty native completion deletes its correlation and emits no measurement record', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      // A short single-line result is a harness hint, not file content: the adapter computes no update.
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: 'File is empty', timestamp: ts(3) }),
    ]));
    const projection = makeProjection();
    const { records } = run(projection, observations);
    assert.deepEqual(recordsOfType(records, 'effect'), []);
    assert.deepEqual(recordsOfType(records, 'residual'), []);
    const late = projection.project({
      type: 'tool-result', toolUseId: 't1', content: READ_RESULT, isError: undefined,
      resultMeta: { annotation: undefined }, sourceOrdinal: 9, sourceEntryId: 'r9', timestamp: 9000,
      provenance: 'harness',
    });
    assert.deepEqual(late.records, [], 'the correlation was deleted, not left armed');
  });

  test('duplicate tool results are first-result-wins', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
      toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 't1', content: READ_RESULT + '\n4\tconst delta = 4;', timestamp: ts(4) }),
    ]));
    const projection = makeProjection();
    const perResult = [];
    for (const observation of observations) {
      const result = projection.project(observation);
      if (observation.type === 'tool-result') perResult.push(result.records);
    }
    assert.equal(perResult.length, 2, 'both results were observed');
    assert.equal(recordsOfType(perResult[0], 'effect').length, 1);
    assert.deepEqual(perResult[1], [], 'the second result of one tool use emits nothing');
  });

  test('pending correlations stay Projection-local and clear on epoch', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      compactSummary({ uuid: 'c1', timestamp: ts(3) }),
      userMessage({ uuid: 'u2', text: 'after the compact', timestamp: ts(4) }),
    ]));
    const projection = makeProjection();
    const perObservation = new Map();
    for (const observation of observations) perObservation.set(observation, projection.project(observation));
    const toolUse = [...perObservation.keys()].find(observation => observation.type === 'tool-use');
    const epoch = [...perObservation.keys()].find(observation => observation.type === 'epoch-boundary');
    assert.deepEqual(perObservation.get(toolUse).records, [], 'a pending correlation reaches no Engine record');
    assert.deepEqual(perObservation.get(epoch).records, [{ type: 'epoch' }]);
  });

  test('a result arriving after its issuing epoch was closed is a no-op', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      compactSummary({ uuid: 'c1', timestamp: ts(3) }),
      toolResult({ uuid: 'r1', parentUuid: 'c1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(4) }),
    ]));
    const projection = makeProjection();
    let lateResult = null;
    for (const observation of observations) {
      const result = projection.project(observation);
      if (observation.type === 'tool-result') lateResult = result;
    }
    assert.ok(lateResult, 'the late result was observed');
    assert.deepEqual(lateResult.records, []);
    assert.deepEqual(lateResult.diagnostics, []);
  });

  test('an epoch clears pending correlation and retains the closing telemetry sidecar for finishSegment', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
      compactSummary({ uuid: 'c1', timestamp: ts(4) }),
      userMessage({ uuid: 'u2', text: 'after the compact', timestamp: ts(5) }),
    ]));
    const projection = makeProjection();
    const closing = { segment: 1, steps: [closedStep('m1', 1)] };
    const { artifacts } = runWithCloses(projection, observations, [closing]);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].artifact.payload.steps[0].toolCalls, 1);
    assert.equal(artifacts[0].artifact.payload.events.length, 1);
    // The sidecar the epoch handed over is gone: joining the same closed segment again finds no facts.
    const again = projection.finishSegment(closing, { captureMode: 'live' });
    assert.equal(again.artifact.payload.steps[0].toolCalls, 0);
    assert.deepEqual(again.artifact.payload.events, []);
  });

  test('AskUserQuestion results produce no measurement turn boundary', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'which option?', timestamp: ts(1) }),
      assistantToolUse({
        uuid: 'a1', messageId: 'm1', toolUseId: 't1', name: 'AskUserQuestion',
        input: { questions: [{ question: 'pick one' }] }, timestamp: ts(2), model: FAST_MODEL, usage: STEP_USAGE,
      }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: '{"answer":"the second one"}', timestamp: ts(3) }),
    ]));
    const projection = makeProjection();
    const perObservation = [];
    for (const observation of observations) perObservation.push([observation, projection.project(observation)]);
    const [, resultOfResult] = perObservation.find(([observation]) => observation.type === 'tool-result');
    assert.deepEqual(resultOfResult.records, []);
    const all = perObservation.flatMap(([, result]) => result.records);
    assert.deepEqual(recordsOfType(all, 'turn-boundary'), [{ type: 'turn-boundary' }],
      'only the human row opens a turn');
  });

  test('a successful Skill result emits the initial effect and leaves one minimal payload continuation', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: 'the real skill body', timestamp: ts(4) }),
      skillPayloadRow({ uuid: 'p2', parentUuid: 'p1', sourceToolUseID: 't1', text: 'a second payload', timestamp: ts(5) }),
    ]));
    const projection = makeProjection();
    const byObservation = [];
    for (const observation of observations) byObservation.push([observation, projection.project(observation)]);
    const effects = byObservation.flatMap(([, result]) => recordsOfType(result.records, 'effect'));
    assert.equal(effects.length, 2, 'the launch confirmation and exactly one payload');
    assert.equal(effects[0].impacts[0].mutation.fragments[0].tokens, charsToTokens(SKILL_LAUNCH, FAST_CTP));
    assert.equal(effects[1].impacts[0].mutation.fragments[0].tokens, charsToTokens('the real skill body', FAST_CTP));
    const payloads = byObservation.filter(([observation]) => observation.type === 'skill-payload');
    assert.equal(payloads.length, 2, 'both payload rows were observed');
    assert.deepEqual(payloads[1][1].records, [], 'the continuation was consumed once');
  });

  test('a failed Skill result leaves no payload continuation', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: 'skill not found', isError: true, timestamp: ts(3) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: 'body that follows nothing', timestamp: ts(4) }),
    ]));
    const { records } = run(makeProjection(), observations);
    assert.deepEqual(recordsOfType(records, 'effect'), []);
  });

  test('a matching non-empty Skill payload consumes the continuation and emits an ordinary replace-fragments effect', () => {
    const payloadText = 'skill body with several words in it';
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: payloadText, timestamp: ts(4) }),
    ]));
    const projection = makeProjection();
    let payloadRecords = null;
    for (const observation of observations) {
      const result = projection.project(observation);
      if (observation.type === 'skill-payload') payloadRecords = result.records;
    }
    assert.equal(payloadRecords.length, 1);
    const effect = payloadRecords[0];
    assert.equal(effect.type, 'effect');
    assert.equal(effect.access, 'read');
    assert.equal(effect.spentTokens, 0);
    assert.equal(effect.overheadTokens, TOOL_OVERHEAD.Read);
    assert.equal(effect.impacts.length, 1);
    assert.equal(effect.impacts[0].resourceKey, 'skill:sw-handoff');
    assert.equal(effect.impacts[0].mutation.kind, 'replace-fragments');
    assert.equal(effect.impacts[0].mutation.fragments.length, 1);
    assert.equal(effect.impacts[0].mutation.fragments[0].tokens, charsToTokens(payloadText, FAST_CTP));
  });

  test('a missing Skill payload leaves the initial effect unchanged', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      userMessage({ uuid: 'u2', text: 'no payload ever arrives', timestamp: ts(4) }),
    ]));
    const { records } = run(makeProjection(), observations);
    const effects = recordsOfType(records, 'effect');
    assert.equal(effects.length, 1);
    assert.equal(effects[0].impacts[0].mutation.fragments[0].tokens, charsToTokens(SKILL_LAUNCH, FAST_CTP));
  });

  test('duplicate result and payload observations are first-wins', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(3) }),
      toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 't1', content: SKILL_LAUNCH + ' again', timestamp: ts(4) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r2', sourceToolUseID: 't1', text: 'first payload', timestamp: ts(5) }),
      skillPayloadRow({ uuid: 'p2', parentUuid: 'p1', sourceToolUseID: 't1', text: 'second payload', timestamp: ts(6) }),
    ]));
    const projection = makeProjection();
    const results = [];
    for (const observation of observations) results.push([observation, projection.project(observation)]);
    const resultRecords = results.filter(([observation]) => observation.type === 'tool-result').map(([, r]) => r.records);
    const payloadRecords = results.filter(([observation]) => observation.type === 'skill-payload').map(([, r]) => r.records);
    assert.equal(recordsOfType(resultRecords[0], 'effect').length, 1);
    assert.deepEqual(resultRecords[1], []);
    assert.equal(recordsOfType(payloadRecords[0], 'effect').length, 1);
    assert.equal(payloadRecords[0][0].impacts[0].mutation.fragments[0].tokens,
      charsToTokens('first payload', FAST_CTP));
    assert.deepEqual(payloadRecords[1], []);
  });

  test('a null sourceLocator constructs and resolves no transcript directory', () => {
    const entries = chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), filePath: 'lib/a.js' }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
    ]);
    const withoutLocator = makeProjection({ cwd: null, projectRoot: '/only-project-root', sourceLocator: null });
    const resolved = run(withoutLocator, observationsOf(entries));
    assert.equal(onlyRecordOfType(resolved.records, 'effect').impacts[0].resourceKey, '/only-project-root/lib/a.js');

    // With a locator and nothing else, the transcript's own directory is the last-resort base.
    const withLocator = makeProjection({ cwd: null, projectRoot: null, sourceLocator: '/transcripts/session.jsonl' });
    const fallback = run(withLocator, observationsOf(entries));
    assert.equal(onlyRecordOfType(fallback.records, 'effect').impacts[0].resourceKey, '/transcripts/lib/a.js');

    // With no directory at all, the key stays path-shaped: no base is invented from the host process.
    const bare = makeProjection({ cwd: null, projectRoot: null, sourceLocator: null });
    const unanchored = run(bare, observationsOf(entries));
    const key = onlyRecordOfType(unanchored.records, 'effect').impacts[0].resourceKey;
    assert.equal(key, '/lib/a.js');
    assert.notEqual(key, nodePath.resolve('lib/a.js'), 'the host working directory is not a base');
  });

  test('an empty session cwd falls through to the project root', () => {
    const entries = chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), filePath: 'lib/a.js' }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
    ]);
    const projection = makeProjection({ cwd: '', projectRoot: '/only-project-root', sourceLocator: '/transcripts/session.jsonl' });
    const { records } = run(projection, observationsOf(entries));
    assert.equal(onlyRecordOfType(records, 'effect').impacts[0].resourceKey, '/only-project-root/lib/a.js');
  });

  test('a Skill payload arriving before its result leaves the correlation armed', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'run the skill', timestamp: ts(1) }),
      skillToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2) }),
      // A payload row ahead of the result it belongs to: the entry is still awaiting that result.
      skillPayloadRow({ uuid: 'p0', parentUuid: 'a1', sourceToolUseID: 't1', text: 'early body', timestamp: ts(3) }),
      toolResult({ uuid: 'r1', parentUuid: 'p0', toolUseId: 't1', content: SKILL_LAUNCH, timestamp: ts(4) }),
      skillPayloadRow({ uuid: 'p1', parentUuid: 'r1', sourceToolUseID: 't1', text: 'the real body', timestamp: ts(5) }),
    ]));
    const projection = makeProjection();
    const seen = [];
    for (const observation of observations) seen.push([observation, projection.project(observation)]);
    const payloads = seen.filter(([observation]) => observation.type === 'skill-payload');
    const [, resultOfResult] = seen.find(([observation]) => observation.type === 'tool-result');
    assert.deepEqual(payloads[0][1].records, [], 'the early payload emits nothing');
    assert.equal(recordsOfType(resultOfResult.records, 'effect').length, 1,
      'the correlation stayed armed, so its result still completes');
    assert.equal(payloads[1][1].records[0].impacts[0].mutation.fragments[0].tokens,
      charsToTokens('the real body', FAST_CTP));
  });

  test('[delta] epoch-first tool-use binds to its own later usage step', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'before the compact', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a0', messageId: 'm0', blocks: [{ type: 'text', text: 'done' }], timestamp: ts(2),
        model: FAST_MODEL, usage: STEP_USAGE,
      }),
      compactSummary({ uuid: 'c1', timestamp: ts(3) }),
      // The new epoch's first row carries a tool use and no usage of its own.
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(4), withUsage: false }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(5) }),
      // Its usage arrives afterwards, on a later row of the same logical message.
      assistantObservation({
        uuid: 'a2', messageId: 'm1', blocks: [{ type: 'text', text: 'read it' }], timestamp: ts(6),
        model: FAST_MODEL, usage: STEP_USAGE,
      }),
    ]));
    const projection = makeProjection();
    const closingFirst = { segment: 1, steps: [closedStep('m0', 1)] };
    const { artifacts } = runWithCloses(projection, observations, [closingFirst]);
    assert.equal(artifacts.length, 1);
    const beforeCompact = artifacts[0].artifact.payload;
    assert.deepEqual(beforeCompact.events, [], 'the epoch-first tool use did not bind to the last pre-epoch step');
    assert.equal(beforeCompact.steps[0].toolCalls, 0);

    const closingSecond = { segment: 2, steps: [closedStep('m1', 2)] };
    const after = projection.finishSegment(closingSecond, { captureMode: 'live' }).artifact.payload;
    assert.equal(after.steps[0].toolCalls, 1);
    assert.deepEqual(after.events, [{
      foldedSeq: 2, eventOrdinal: 0, path: '/repo/lib/a.js', rawPath: 'lib/a.js', toolType: 'Read', isFullRead: 1,
    }]);
  });

  test('[delta] adjacent tool rows do not cross-bind messageId or model', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read both', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), model: FAST_MODEL, filePath: 'lib/a.js' }),
      readToolUse({ uuid: 'a2', messageId: 'm2', toolUseId: 't2', timestamp: ts(3), model: SLOW_MODEL, filePath: 'lib/b.js' }),
      // The results arrive out of issue order, so neither can borrow the other's row facts.
      toolResult({ uuid: 'r2', parentUuid: 'a2', toolUseId: 't2', content: READ_RESULT, timestamp: ts(4) }),
      toolResult({ uuid: 'r1', parentUuid: 'r2', toolUseId: 't1', content: READ_RESULT, timestamp: ts(5) }),
    ]));
    const projection = makeProjection();
    const { records } = run(projection, observations);
    const effects = recordsOfType(records, 'effect');
    assert.equal(effects.length, 2);
    const byResource = new Map(effects.map(effect => [effect.impacts[0].resourceKey, effect]));
    // A whole-content snapshot keys ONE fragment per source line, so the resource's priced total is the sum of
    // its fragments. What this pins is unchanged: each effect was priced with its OWN issuing policy's CTP.
    assert.equal(fragmentTotal(byResource.get('/repo/lib/b.js')), lineTokens(SLOW_CTP));
    assert.equal(fragmentTotal(byResource.get('/repo/lib/a.js')), lineTokens(FAST_CTP));
    assert.notEqual(lineTokens(SLOW_CTP), lineTokens(FAST_CTP), 'the two policies price the same text differently');

    const closed = { segment: 1, steps: [closedStep('m1', 1), closedStep('m2', 2)] };
    const payload = projection.finishSegment(closed, { captureMode: 'live' }).artifact.payload;
    assert.deepEqual(payload.steps.map(step => [step.foldedSeq, step.toolCalls]), [[1, 1], [2, 1]]);
    assert.deepEqual(payload.events.map(event => [event.foldedSeq, event.eventOrdinal, event.path]),
      [[1, 0, '/repo/lib/a.js'], [2, 0, '/repo/lib/b.js']]);
  });

  test('[delta] delayed result uses the issuing policy after the model changes', () => {
    const observations = observationsOf(chain([
      userMessage({ uuid: 'u1', text: 'read it', timestamp: ts(1) }),
      readToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 't1', timestamp: ts(2), model: FAST_MODEL }),
      // A later step on a different model: the session's current policy is no longer the issuing one.
      assistantObservation({
        uuid: 'a2', messageId: 'm2', blocks: [{ type: 'text', text: 'switched model' }], timestamp: ts(3),
        model: SLOW_MODEL, usage: STEP_USAGE,
      }),
      toolResult({ uuid: 'r1', parentUuid: 'a2', toolUseId: 't1', content: READ_RESULT, timestamp: ts(4) }),
    ]));
    const { records } = run(makeProjection(), observations);
    const effect = onlyRecordOfType(records, 'effect');
    assert.equal(fragmentTotal(effect), lineTokens(FAST_CTP));
    assert.notEqual(lineTokens(FAST_CTP), lineTokens(SLOW_CTP), 'the two policies price the same text differently');
  });

  test('[delta] path spend excludes inter-tool text and thinking', () => {
    // One entry, two tool uses on one path, with the text and thinking blocks between them: the shape the
    // retired same-path attribution keyed on.
    function entriesFor({ reasoning }) {
      return chain([
        userMessage({ uuid: 'u1', text: 'read it twice', timestamp: ts(1) }),
        assistantObservation({
          uuid: 'a1', messageId: 'm1', timestamp: ts(2), model: FAST_MODEL, usage: STEP_USAGE,
          blocks: [
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'lib/a.js' } },
            ...(reasoning
              ? [{ type: 'text', text: 'a long stretch of reasoning about the very same file'.repeat(4) },
                { type: 'thinking', thinking: 'more thinking about the very same file'.repeat(4) }]
              : []),
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'lib/a.js' } },
          ],
        }),
        toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: READ_RESULT, timestamp: ts(3) }),
        toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 't2', content: READ_RESULT, timestamp: ts(5) }),
      ]);
    }
    const plain = run(makeProjection(), observationsOf(entriesFor({ reasoning: false })));
    const withReasoning = run(makeProjection(), observationsOf(entriesFor({ reasoning: true })));
    const spendOf = ({ records }) => recordsOfType(records, 'effect').map(effect => effect.spentTokens);
    assert.deepEqual(spendOf(withReasoning), spendOf(plain));
    assert.equal(spendOf(plain).length, 2);
    assert.deepEqual(withReasoning.records, plain.records,
      'inter-tool text and thinking change no measurement record');
  });
});
