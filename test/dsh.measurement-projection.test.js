// DSH Measurement Projection: the thin Adapter over the shared Measurement Projection, driven with the DSH
// interpreters and the observations the DSH reducer produces from synthetic event sequences.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDshMeasurementProjection } from '../lib/harness/dsh/measurement-projection.js';
import { reduceDshEvent, reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../lib/constants.js';
import { assistantMessage, toolResult, reusedCallIdAcrossSteps, REUSED_CALL_ID_FILES } from './helpers/dsh-events.js';
import { dshRig, filesUnder } from './helpers/attribution-fixtures.js';

// The files the log of the reused call id reads, under the session directory the Projection is built with.
const { interpreters } = dshRig({ files: filesUnder('/repo', REUSED_CALL_ID_FILES), cwd: '/repo' });

function makeProjection() {
  return createDshMeasurementProjection({
    cwd: '/repo',
    projectRoot: '/repo',
    resolveModelPolicy: modelId => modelPolicyFor(modelId, DEFAULT_CACHE_TTL),
    ...interpreters,
  });
}

const recordsOf = (projection, observations) =>
  observations.flatMap(observation => projection.project(observation).records);

const SKILL_TEXT = ['<skill_content name="tdd">', '# Test-Driven Development', 'Red, then green.', '</skill_content>']
  .join('\n');

describe('DSH Measurement Projection', () => {
  test('finishSegment stamps dsh-live and dsh-replay', () => {
    const closed = { segment: 0, steps: [] };
    assert.equal(makeProjection().finishSegment(closed, { captureMode: 'live' }).artifact.captureSource, 'dsh-live');
    assert.equal(makeProjection().finishSegment(closed, { captureMode: 'replay' }).artifact.captureSource,
      'dsh-replay');
  });

  test('a task-notification observation is an invariant failure here', () => {
    assert.throws(() => makeProjection().project({ type: 'task-notification', text: 'finished' }),
      /^Error: dsh measurement projection invariant: unsupported observation type: task-notification$/);
  });

  test('a skill result completes its call and a later skill payload observation produces nothing', () => {
    const projection = makeProjection();
    const issued = reduceDshEvent(assistantMessage({
      toolCalls: [{ id: 'call_skill', name: 'skill', arguments: JSON.stringify({ name: 'tdd' }) }],
    })).observations;
    const answered = reduceDshEvent(toolResult({ callId: 'call_skill', text: SKILL_TEXT })).observations;
    const effects = recordsOf(projection, [...issued, ...answered]).filter(record => record.type === 'effect');
    assert.deepEqual(effects.flatMap(effect => effect.impacts.map(impact => impact.resourceKey)), ['skill:tdd']);

    const { toolUseId } = issued.find(observation => observation.type === 'tool-use');
    assert.deepEqual(projection.project({ type: 'skill-payload', toolUseId, text: 'late payload' }),
      { records: [], diagnostics: [] });
  });

  test('a provider call id reused across steps completes two calls', () => {
    const projection = makeProjection();
    const observations = reduceDshSnapshot(reusedCallIdAcrossSteps()).batches.flat();
    const effects = recordsOf(projection, observations).filter(record => record.type === 'effect');
    assert.deepEqual(effects.flatMap(effect => effect.impacts.map(impact => impact.resourceKey)),
      ['/repo/src/a.js', '/repo/src/b.js']);
  });

  test('the diagnostic scope is dsh-measurement-projection', () => {
    const { artifact, diagnostics } = makeProjection().finishSegment({ segment: 0, steps: null });
    assert.equal(artifact, null);
    assert.deepEqual(diagnostics.map(({ scope, code }) => ({ scope, code })),
      [{ scope: 'dsh-measurement-projection', code: 'segment_telemetry_join_failed' }]);
  });

  test('the interpreters receive the scratch and frame context project was given, beside the DSH context', () => {
    const calls = [];
    const projection = createDshMeasurementProjection({
      cwd: '/repo',
      projectRoot: '/repo',
      resolveModelPolicy: modelId => modelPolicyFor(modelId, DEFAULT_CACHE_TTL),
      interpretToolUse(observation, context, run) {
        calls.push({ phase: 'use', context, run });
        return { pending: { toolUseId: observation.toolUseId }, effects: [], residuals: [], telemetry: null };
      },
      completeToolResult(pending, observation, context, run) {
        calls.push({ phase: 'result', context, run });
        return { effects: [], residuals: [], telemetry: null, skillContinuation: null };
      },
    });
    const issued = reduceDshEvent(assistantMessage({
      toolCalls: [{ id: 'call_read', name: 'read', arguments: JSON.stringify({ path: 'src/a.js' }) }],
    })).observations;
    const answered = reduceDshEvent(toolResult({ callId: 'call_read', text: 'const a = 1;' })).observations;
    const frameCtx = { recall: () => null, remember: () => {} };
    for (const observation of [...issued, ...answered]) projection.project(observation, frameCtx);

    assert.deepEqual(calls.map(call => call.phase), ['use', 'result']);
    for (const call of calls) {
      assert.equal(call.run.frameCtx, frameCtx);
      assert.equal(call.run.scratch, calls[0].run.scratch);
      assert.equal(call.context.sessionCwd, '/repo');
      assert.ok(!('scratch' in call.context) && !('frameCtx' in call.context));
    }
    assert.ok(calls[0].run.scratch instanceof Map);
  });
});
