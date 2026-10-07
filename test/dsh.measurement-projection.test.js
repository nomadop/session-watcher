// DSH Measurement Projection: the thin Adapter over the shared Measurement Projection, driven with the DSH
// interpreters and the observations the DSH reducer produces from synthetic event sequences.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDshMeasurementProjection } from '../lib/harness/dsh/measurement-projection.js';
import { interpretDshToolUse, completeDshToolResult } from '../lib/harness/dsh/native-tools.js';
import { reduceDshEvent, reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../lib/constants.js';
import { assistantMessage, toolResult, reusedCallIdAcrossSteps } from './helpers/dsh-events.js';

function makeProjection() {
  return createDshMeasurementProjection({
    cwd: '/repo',
    projectRoot: '/repo',
    resolveModelPolicy: modelId => modelPolicyFor(modelId, DEFAULT_CACHE_TTL),
    interpretToolUse: interpretDshToolUse,
    completeToolResult: completeDshToolResult,
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
});
