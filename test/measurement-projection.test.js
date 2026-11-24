// Shared Measurement Projection: the per-epoch phase machine and the Segment Telemetry sidecar under the
// scope and capture labels a Harness Adapter hands in. Fake interpreters answer in the interpreter
// Interface's own shapes, so no harness's native interpretation is under test here.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMeasurementProjection } from '../lib/measurement-projection.js';

const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-12, `${message} ${actual} ≈ ${expected}`.trim());

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

  test('a main-call fact yields no record, and each usage step names the main call it belongs to, counted across epochs and segments', () => {
    const projection = makeProjection();
    const mainCall = { type: 'main-call', sourceOrdinal: 1 };
    const usage = id => ({
      type: 'usage', messageId: id, model: 'fake-model', timestamp: 1000, provenance: 'assistant', sourceOrdinal: 1,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    const ordinalOf = id => projection.project(usage(id)).records[0].mainCallOrdinal;

    assert.deepEqual(projection.project(mainCall), { records: [], diagnostics: [] });
    assert.equal(ordinalOf('msg-a'), 1);
    // The second main call reported no usage, as a withdrawn or a quiet one: it still counts.
    projection.project(mainCall);
    projection.project(mainCall);
    assert.equal(ordinalOf('msg-b'), 3);
    projection.project(epochBoundary());
    projection.project(mainCall);
    assert.equal(ordinalOf('msg-c'), 4, 'an epoch does not restart the count');
    projection.finishSegment({ segment: 1, steps: [closedStep('msg-c', 1)] }, { captureMode: 'live' });
    projection.project(mainCall);
    assert.equal(ordinalOf('msg-d'), 5, 'finishing a segment does not either');

    const other = makeProjection();
    other.project(mainCall);
    assert.equal(other.project(usage('msg-a')).records[0].mainCallOrdinal, 1, 'another Projection counts from its own start');
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

  describe('an effects-only result', () => {
    // A completion that charges an effect and a residual, so what an effects-only result drops is visible.
    const withResidual = pending => ({
      ...completeToolResult(pending),
      residuals: [{ groupKey: 'FakeRead', weight: 7, hadError: false, meta: { kind: 'tool', detail: null } }],
    });
    const typesOf = projected => projected.records.map(record => record.type);

    test('emits the completion\'s effects and no residual', () => {
      const projection = makeProjection({ completeToolResult: withResidual });
      projection.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }));
      assert.deepEqual(typesOf(projection.project(toolResult({ toolUseId: 't1' }))), ['effect', 'residual'],
        'control: the same result charges both');

      projection.project(toolUse({ toolUseId: 't2', messageId: 'msg-a', path: 'a.js' }));
      const projected = projection.project({ ...toolResult({ toolUseId: 't2' }), effectsOnly: true });
      assert.deepEqual(typesOf(projected), ['effect']);
      assert.equal(projected.records[0].impacts[0].resourceKey, 'a.js');
    });

    test('held before its use, it still emits effects and no residual when the use releases it', () => {
      const projection = makeProjection({ completeToolResult: withResidual });
      assert.deepEqual(projection.project({ ...toolResult({ toolUseId: 't1' }), effectsOnly: true }).records, []);
      assert.deepEqual(typesOf(projection.project(toolUse({ toolUseId: 't1', messageId: 'msg-a', path: 'a.js' }))),
        ['effect']);
    });
  });

  describe('the expected recall share', () => {
    // A main call as the Source states it, with its verdict (`pure`, `other` or `unknown`) and the recall bill it states, and the usage step of its own request.
    const call = (verdict, recall) => ({ type: 'main-call', sourceOrdinal: 1, ...(verdict === undefined ? {} : { verdict }), ...(recall === undefined ? {} : { recall }) });
    const usage = id => ({
      type: 'usage', messageId: id, model: 'fake-model', timestamp: 1000, provenance: 'assistant', sourceOrdinal: 1,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    });
    // The step record of a main call that reports a usage, after the call's own fact.
    const stepOf = (projection, verdict, id, recall) => {
      projection.project(call(verdict, recall));
      return projection.project(usage(id)).records[0];
    };
    // The decay of one classified main call, from the half-life the contract names: a weight halves over 32 of them.
    const alpha = 1 - 2 ** (-1 / 32);

    test('a classified call moves the share its successors read: pure counts 1, other 0, unknown is skipped, from the zero before the first, and no call reads its own', () => {
      const projection = makeProjection();
      const read = [
        stepOf(projection, 'pure', 'm1'),
        stepOf(projection, 'other', 'm2'),
        stepOf(projection, 'unknown', 'm3'),
        stepOf(projection, 'pure', 'm4'),
        stepOf(projection, 'other', 'm5'),
      ].map(record => record.p);
      const afterFirst = alpha;
      const afterSecond = (1 - alpha) * afterFirst;
      const afterFourth = (1 - alpha) * afterSecond + alpha;
      assert.equal(read[0], undefined, 'the first call has no classified predecessor, and its own pure is read by none of its points');
      near(read[1], afterFirst);
      near(read[2], afterSecond);
      near(read[3], afterSecond, 'the unknown call leaves the share where it stood');
      near(read[4], afterFourth);
    });

    test('an unknown call before the first classified one leaves the share absent, and a call that classifies other first reads a share of zero', () => {
      const projection = makeProjection();
      assert.equal(stepOf(projection, 'unknown', 'm1').p, undefined);
      assert.equal(stepOf(projection, 'other', 'm2').p, undefined, 'the call that classifies first has no estimate at its own point');
      assert.equal(stepOf(projection, 'pure', 'm3').p, 0, 'zero is an estimate, not an absence');
    });

    test('the share advances on main calls, not on usage steps: a call that reported none, and a pure call whose bill is unknown, count as they are', () => {
      const projection = makeProjection();
      projection.project(call('pure', { net: null }));
      projection.project(call('pure'));
      near(stepOf(projection, 'other', 'm1').p, alpha + (1 - alpha) * alpha, 'two pure calls, neither with a usage or with a bill');
    });

    test('a Source that classifies no call states no share: nothing is carried until the first verdict, and the facts that carry none move nothing', () => {
      const projection = makeProjection();
      assert.equal(stepOf(projection, undefined, 'm1').p, undefined);
      assert.equal(stepOf(projection, 'pure', 'm2').p, undefined);
      near(stepOf(projection, undefined, 'm3').p, alpha, 'a call with no verdict reads the share and leaves it');
      near(stepOf(projection, 'other', 'm4').p, alpha);
    });

    test('a true epoch restarts the estimate and keeps the count of main calls; finishing a segment alone does not', () => {
      const projection = makeProjection();
      stepOf(projection, 'pure', 'm1');
      projection.finishSegment({ segment: 1, steps: [closedStep('m1', 1)] }, { captureMode: 'live' });
      near(stepOf(projection, 'pure', 'm2').p, alpha, 'finishing a segment is no epoch');
      projection.project(epochBoundary());
      const first = stepOf(projection, 'other', 'm3');
      assert.equal(first.p, undefined, 'a new epoch has no classified call yet');
      assert.equal(first.mainCallOrdinal, 3, 'the count of main calls runs on');
      assert.equal(stepOf(projection, 'pure', 'm4').p, 0);
    });

    test('two Projections hold two estimates', () => {
      const first = makeProjection();
      const second = makeProjection();
      stepOf(first, 'pure', 'm1');
      assert.equal(stepOf(second, 'pure', 'm1').p, undefined);
    });

    test('a request with a bill rides the next usage step with the bills of the calls that reported none; one with no bill rides none', () => {
      const projection = makeProjection();
      projection.project(call('pure', { net: 3 }));
      projection.project(call('unknown', { net: null }));
      const step = stepOf(projection, 'pure', 'm1', { net: 4 });
      assert.deepEqual(step.recall, { priced: 2, net: 7 });
      assert.equal('recall' in stepOf(projection, 'pure', 'm2', { net: null }), false);
      assert.equal('recall' in stepOf(projection, 'other', 'm3'), false);
    });
  });
});
