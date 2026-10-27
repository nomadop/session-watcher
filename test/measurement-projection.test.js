// Shared Measurement Projection: the per-epoch phase machine and the Segment Telemetry sidecar under the
// scope and capture labels a Harness Adapter hands in. Fake interpreters answer in the interpreter
// Interface's own shapes, so no harness's native interpretation is under test here.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMeasurementProjection } from '../lib/measurement-projection.js';

// The correlation a use arms carries its path, and its completion prices that path and reports it on the
// issuing step, so every effect and path event names the call it completed.
function interpretToolUse(observation) {
  const { toolUseId, messageId: issuingStepId } = observation;
  return {
    pending: { toolUseId, issuingStepId, path: observation.input.path },
    effects: [],
    residuals: [],
    telemetry: { toolUseId, issuingStepId, loadToken: null, pathEvents: [] },
  };
}

function completeToolResult(pending) {
  const { toolUseId, issuingStepId, path } = pending;
  return {
    effects: [{
      access: 'read',
      overheadTokens: 0,
      spentTokens: 1,
      impacts: [{
        resourceKey: path,
        mutation: { kind: 'replace-fragments', fragments: [{ key: 1, tokens: 1 }] },
      }],
    }],
    residuals: [],
    telemetry: {
      toolUseId, issuingStepId, loadToken: null,
      pathEvents: [{ path, rawPath: path, toolType: 'FakeRead', isFullRead: 1 }],
    },
    skillContinuation: null,
  };
}

function makeProjection(overrides = {}) {
  return createMeasurementProjection({
    scope: 'fake-measurement-projection',
    context: {},
    captureSources: { live: 'fake-live', replay: 'fake-replay' },
    interpretToolUse,
    completeToolResult,
    ...overrides,
  });
}

function toolUse({ toolUseId, messageId, path }) {
  return {
    type: 'tool-use', messageId, model: 'fake-model', cwd: null, toolUseId, name: 'FakeRead', input: { path },
    sourceOrdinal: 1, sourceEntryId: `${messageId}:use`, timestamp: 1000, provenance: 'assistant',
  };
}

function toolResult({ toolUseId }) {
  return {
    type: 'tool-result', toolUseId, content: 'fake result', isError: false,
    sourceOrdinal: 2, sourceEntryId: `${toolUseId}:result`, timestamp: 2000, provenance: 'harness',
  };
}

// The fake interpreters above, wrapped to record what each call received as `(context, run)`: `run` is the
// third argument, the per-epoch scratch and the frame context the Projection hands native interpretation.
function recordingInterpreters() {
  const calls = [];
  return {
    calls,
    interpretToolUse(observation, context, run) {
      calls.push({ phase: 'use', toolUseId: observation.toolUseId, context, run });
      return interpretToolUse(observation);
    },
    completeToolResult(pending, observation, context, run) {
      calls.push({ phase: 'result', toolUseId: observation.toolUseId, context, run });
      return completeToolResult(pending);
    },
  };
}

function epochBoundary() {
  return {
    type: 'epoch-boundary', sourceOrdinal: 3, sourceEntryId: 'epoch', timestamp: 3000, provenance: 'harness',
  };
}

// One closed step in the Engine's frozen shape.
function closedStep(id, foldedSeq) {
  return {
    id,
    foldedSeq,
    timestamp: foldedSeq * 1000,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  };
}

describe('shared Measurement Projection', () => {
  test('finishSegment stamps the live and replay capture sources it was given', () => {
    const closed = { segment: 1, steps: [closedStep('msg-a', 1)] };
    const projection = makeProjection();
    const stamped = captureMode => projection.finishSegment(closed, { captureMode }).artifact.captureSource;
    assert.equal(stamped('live'), 'fake-live');
    assert.equal(stamped('replay'), 'fake-replay');
  });

  test('an invariant message spells the scope with spaces', () => {
    const projection = makeProjection({ scope: 'x-y' });
    assert.throws(() => projection.project(null), { message: /^x y invariant: / });
  });

  test('a result for a completed call produces no record', () => {
    const projection = makeProjection();
    projection.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }));
    assert.deepEqual(projection.project(toolResult({ toolUseId: 't1' })).records.map(record => record.type),
      ['effect'], 'control: the first result completes the call and charges it');
    assert.deepEqual(projection.project(toolResult({ toolUseId: 't1' })).records, []);
  });

  test('task-notification is not a shared observation type', () => {
    const notification = {
      type: 'task-notification', text: '<task-notification><task-id>abc</task-id></task-notification>',
      sourceOrdinal: 1, sourceEntryId: 'n1', timestamp: 1000, provenance: 'harness',
    };
    assert.throws(() => makeProjection().project(notification),
      { message: /invariant: unsupported observation type: task-notification$/ });
  });

  test('two Projections share no pairing state and no sidecar', () => {
    const first = makeProjection();
    const second = makeProjection();
    // Both instances close a segment naming both issuing steps, so a fact that crossed instances would
    // surface as a tool call on the other instance's row.
    const closed = { segment: 1, steps: [closedStep('msg-a', 1), closedStep('msg-b', 2)] };

    first.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }));
    second.project(toolUse({ toolUseId: 't1', messageId: 'msg-b', path: 'b.js' }));
    second.project(epochBoundary());

    const firstResult = first.project(toolResult({ toolUseId: 't1' }));
    assert.deepEqual(firstResult.records.map(record => [record.type, record.impacts[0].resourceKey]),
      [['effect', 'a.js']], 'the first still completes its own call');
    assert.deepEqual(second.project(toolResult({ toolUseId: 't1' })).records, [],
      'the epoch in the second ended the second call');
    const secondPayload = second.finishSegment(closed, { captureMode: 'live' }).artifact.payload;
    const firstPayload = first.finishSegment(closed, { captureMode: 'live' }).artifact.payload;

    assert.deepEqual(firstPayload.steps.map(step => [step.foldedSeq, step.toolCalls]), [[1, 1], [2, 0]]);
    assert.deepEqual(firstPayload.events.map(event => [event.foldedSeq, event.path]), [[1, 'a.js']]);
    assert.deepEqual(secondPayload.steps.map(step => [step.foldedSeq, step.toolCalls]), [[1, 0], [2, 1]]);
    assert.deepEqual(secondPayload.events, []);
  });

  describe('per-epoch scratch and frame context', () => {
    test('scratch is one Map within an epoch, and a fresh one after an epoch boundary and after finishSegment', () => {
      const recording = recordingInterpreters();
      const projection = makeProjection(recording);
      projection.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }));
      projection.project(toolResult({ toolUseId: 't1' }));
      projection.project(toolUse({ toolUseId: 't2', messageId: 'msg-a', path: 'b.js' }));
      projection.project(epochBoundary());
      projection.project(toolUse({ toolUseId: 't3', messageId: 'msg-b', path: 'c.js' }));
      projection.finishSegment({ segment: 1, steps: [closedStep('msg-b', 1)] }, { captureMode: 'live' });
      projection.project(toolUse({ toolUseId: 't4', messageId: 'msg-c', path: 'd.js' }));

      const scratches = recording.calls.map(call => call.run.scratch);
      assert.ok(scratches.every(scratch => scratch instanceof Map));
      assert.equal(scratches[1], scratches[0], 'a result sees the scratch its use saw');
      assert.equal(scratches[2], scratches[0], 'a later use in the same epoch sees it too');
      assert.notEqual(scratches[3], scratches[0], 'the epoch boundary ends the epoch the scratch belongs to');
      assert.notEqual(scratches[4], scratches[3], 'finishSegment ends it as well');
      assert.notEqual(scratches[4], scratches[0]);
    });

    test('two Projections hold two scratches', () => {
      const recording = recordingInterpreters();
      const first = makeProjection(recording);
      const second = makeProjection(recording);
      first.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }));
      second.project(toolUse({ toolUseId: 't1', messageId: 'msg-b', path: 'b.js' }));

      const [firstScratch, secondScratch] = recording.calls.map(call => call.run.scratch);
      assert.notEqual(secondScratch, firstScratch, 'Projections alive together hold their own scratches, or sessions would cross-contaminate');
    });

    test('an interpreter reads back what it wrote into the scratch within an epoch and finds it empty after', () => {
      const seenBefore = [];
      const projection = makeProjection({
        interpretToolUse(observation, context, { scratch }) {
          seenBefore.push(scratch.size);
          scratch.set(observation.toolUseId, true);
          return interpretToolUse(observation);
        },
      });
      projection.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }));
      projection.project(toolUse({ toolUseId: 't2', messageId: 'msg-a', path: 'b.js' }));
      projection.project(epochBoundary());
      projection.project(toolUse({ toolUseId: 't3', messageId: 'msg-b', path: 'c.js' }));
      assert.deepEqual(seenBefore, [0, 1, 0]);
    });

    test('both interpreters receive the frame context of the project call that reached them, outside context', () => {
      const recording = recordingInterpreters();
      const context = { marker: 'host-context' };
      const projection = makeProjection({ ...recording, context });
      const useFrame = { recall: () => null };
      const resultFrame = { recall: () => null, remember: () => {} };
      projection.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }), useFrame);
      projection.project(toolResult({ toolUseId: 't1' }), resultFrame);

      const [use, result] = recording.calls;
      assert.equal(use.run.frameCtx, useFrame);
      assert.equal(result.run.frameCtx, resultFrame, 'the completion takes the frame that carries the result');
      assert.deepEqual(Object.keys(use.run).sort(), ['frameCtx', 'scratch']);
      assert.equal(use.context, context);
      assert.equal(result.context, context);
      assert.deepEqual(context, { marker: 'host-context' }, 'neither scratch nor the frame context enters context');
    });

    test('a held result completes with the frame that triggers completion, not the frame that held it', () => {
      const recording = recordingInterpreters();
      const projection = makeProjection(recording);
      const heldFrame = { recall: () => 'held-frame' };
      const triggerFrame = { recall: () => 'trigger-frame' };

      const held = projection.project(toolResult({ toolUseId: 't1' }), heldFrame);
      assert.deepEqual(held.records, []);
      assert.deepEqual(recording.calls, [], 'a result before its use reaches no interpreter');

      const completed = projection.project(
        toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }), triggerFrame);
      assert.equal(completed.records.length, 1, 'control: the use releases the held result');
      assert.deepEqual(recording.calls.map(call => [call.phase, call.run.frameCtx]),
        [['use', triggerFrame], ['result', triggerFrame]]);
      assert.equal(recording.calls[1].run.scratch, recording.calls[0].run.scratch);
    });
  });
});
