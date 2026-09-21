import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { RESERVED_OUTPUT, CTX_SAFETY_MARGIN } from '../lib/constants.js';

// Named reads and injected policy. Reads derive from one Engine snapshot and the epoch model policy; the
// Engine holds no CTP, reads no file, and knows no harness tool.

const DEFAULT_POLICIES = { 'model-a': { cRatio: 10, contextCapacity: 1_000_000 } };
const FALLBACK_POLICY = { cRatio: 3, contextCapacity: 500_000 };

function makeEngine({ policies = DEFAULT_POLICIES, resolveModelPolicy, resolveResourcePolicy } = {}) {
  return createMeasurementEngine({
    resolveModelPolicy: resolveModelPolicy ?? (modelId => policies[modelId] ?? FALLBACK_POLICY),
    resolveResourcePolicy: resolveResourcePolicy ?? (() => ({ selectedByDefault: true, defaultDiscardReason: null })),
  });
}

const usage = (over = {}) => ({ input: 0, output: 1, cacheRead: 1000, cacheWrite: 0, ...over });
const step = (id, use = usage(), extra = {}) => ({
  type: 'step', id, model: 'model-a', timestamp: 1, usage: use, ...extra,
});
const effect = (impacts, over = {}) => ({
  type: 'effect', access: 'read', overheadTokens: 0, spentTokens: 0, impacts, ...over,
});
// The fragment key of a whole-content snapshot is a projection-local value the Engine never interprets,
// so this one is arbitrary on purpose.
const whole = (resourceKey, tokens) => ({
  resourceKey, mutation: { kind: 'replace-fragments', fragments: [{ key: 'snapshot', tokens }] },
});
const lines = (resourceKey, pairs) => ({
  resourceKey, mutation: { kind: 'merge-fragments', fragments: pairs.map(([key, tokens]) => ({ key, tokens })) },
});

test('[delta] epoch model fixes reads after a later step changes model', () => {
  const engine = makeEngine({
    policies: {
      'model-a': { cRatio: 1, contextCapacity: 1000, pricing: { input: 1 } },
      'model-b': { cRatio: 9, contextCapacity: 9000, pricing: { input: 9 } },
    },
  });
  engine.ingest([step('m1', usage(), { model: 'model-a' })]);
  engine.ingest([step('m2', usage(), { model: 'model-b' })]);
  assert.equal(engine.getStatus().cRatio, 1);
  assert.equal(engine.getStatus().model, 'model-a');
});

// The other half of the same row: the epoch model is fixed WITHIN an epoch, and an explicit epoch RESETS it.
// Without the reset half, a value that merely never changed would satisfy the first assertion — so this one
// discriminates by making the post-epoch first model differ from BOTH the pre-epoch epoch model and the
// pre-epoch latest model, and by checking the policy the reads resolve moves with it.
test('[delta] an explicit epoch resets the model that reads resolve', () => {
  const engine = makeEngine({
    policies: {
      'model-a': { cRatio: 1, contextCapacity: 1000, pricing: { input: 1 } },
      'model-b': { cRatio: 9, contextCapacity: 9000, pricing: { input: 9 } },
      'model-c': { cRatio: 5, contextCapacity: 5000, pricing: { input: 5 } },
    },
  });
  // Epoch one opens on model-a and later measures model-b, so the epoch model is fixed at model-a.
  engine.ingest([step('m1', usage(), { model: 'model-a' })]);
  engine.ingest([step('m2', usage(), { model: 'model-b' })]);
  assert.equal(engine.getStatus().model, 'model-a', 'precondition: fixed within the epoch');
  assert.equal(engine.getStatus().cRatio, 1);

  // An explicit epoch, then a first measured step on a THIRD model. Reads must follow model-c: neither the
  // old epoch model (model-a) nor the latest model of the previous epoch (model-b) may survive the boundary.
  engine.ingest([{ type: 'epoch' }]);
  engine.ingest([step('m3', usage(), { model: 'model-c' })]);
  assert.equal(engine.getStatus().model, 'model-c', 'the epoch reset the model reads resolve');
  assert.equal(engine.getStatus().cRatio, 5, 'and the policy those reads resolve moved with it');

  // Fixed again inside the NEW epoch: a later step does not move it back.
  engine.ingest([step('m4', usage(), { model: 'model-b' })]);
  assert.equal(engine.getStatus().model, 'model-c');
  assert.equal(engine.getStatus().cRatio, 5);
});

// Constructed directly rather than through `makeEngine`, which supplies each resolver: what this pins is
// the diagnosis a composition missing a resolver gets, and the helper would supply what this case withholds.
test('an Engine constructed without a resource policy resolver fails at construction and names the resolver', () => {
  assert.throws(() => createMeasurementEngine({ resolveModelPolicy: () => FALLBACK_POLICY }),
    /measurement engine invariant: resolveResourcePolicy must be a function/);
});

test('the Engine exposes exactly its named operations, and getCurrentCtp is not one of them', () => {
  const engine = makeEngine();
  assert.deepEqual(Object.keys(engine).sort(), [
    'closeCurrentSegment', 'getBucketData', 'getHandoffMeasurement', 'getHistory', 'getStatus',
    'ingest', 'readRateLampFrame', 'refreshReadPolicies', 'replaceResourceOverrides',
  ]);
  assert.equal(engine.getCurrentCtp, undefined);
});

test('a missing or invalid model policy uses the injected default for reads and segment finalization and emits a diagnostic', () => {
  const engine = makeEngine({ policies: {} });
  const result = engine.ingest([step('m1', usage(), { model: 'model-unknown' })]);
  assert.equal(result.newCalls, 1);
  assert.equal(engine.getStatus().cRatio, FALLBACK_POLICY.cRatio, 'the resolver default answers for an unknown model');
  assert.equal(result.diagnostics.length, 0, 'a resolver that answers needs no diagnostic');

  const broken = makeEngine({
    resolveModelPolicy: modelId => (modelId === null ? FALLBACK_POLICY : { cRatio: 'ten', contextCapacity: null }),
  });
  const brokenResult = broken.ingest([step('m1')]);
  assert.equal(brokenResult.newCalls, 1, 'the core transition was accepted');
  assert.equal(brokenResult.diagnostics.length, 1);
  assert.equal(brokenResult.diagnostics[0].code, 'model_policy_invalid');
  assert.equal(broken.getStatus().cRatio, FALLBACK_POLICY.cRatio);
  const [closed] = broken.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.cRatio, FALLBACK_POLICY.cRatio, 'finalization reads the same effective policy');
});

test('a missing or invalid resource policy defaults to selected with no discard reason and emits a diagnostic', () => {
  const engine = makeEngine({ resolveResourcePolicy: () => ({ selected: 'yes' }) });
  engine.ingest([step('m1')]);
  const result = engine.ingest([effect([whole('r1', 400)], { spentTokens: 400 })]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'resource_policy_invalid');
  const [row] = engine.getBucketData().paths;
  assert.equal(row.defaultSelected, true);
  assert.equal(row.defaultDiscardReason, null);
  assert.equal(engine.getStatus().bDefault, 1400, 'a defaulted resource still counts toward the position basis');
});

test('resolver failure happens after the accepted core transition and never rolls measurement state back', () => {
  const engine = makeEngine({
    resolveModelPolicy: () => { throw new Error('policy source unavailable'); },
    resolveResourcePolicy: () => { throw new Error('policy source unavailable'); },
  });
  const stepResult = engine.ingest([step('m1', { input: 0, output: 2, cacheRead: 1000, cacheWrite: 0 })]);
  assert.equal(stepResult.newCalls, 1);
  assert.equal(engine.getStatus().L, 1000);
  assert.equal(engine.getStatus().cRatio, null, 'no usable policy leaves the model-dependent read unavailable');
  assert.equal(engine.getStatus().rateLamp.reliable, false);
  assert.ok(stepResult.diagnostics.some(d => d.code === 'model_policy_failed'));

  const effectResult = engine.ingest([effect([whole('r1', 400)], { spentTokens: 400 })]);
  assert.deepEqual(effectResult.newResourceKeys, ['r1']);
  assert.equal(engine.getBucketData().paths[0].tokens, 400, 'the resident mutation stands');
  assert.ok(effectResult.diagnostics.some(d => d.code === 'resource_policy_failed'));
});

test('a user override beats the resource policy default', () => {
  const engine = makeEngine({
    resolveResourcePolicy: resourceKey => (resourceKey === 'ignored'
      ? { selectedByDefault: false, defaultDiscardReason: 'gitignored' }
      : { selectedByDefault: true, defaultDiscardReason: null }),
  });
  engine.ingest([step('m1')]);
  engine.ingest([effect([whole('kept', 100), whole('ignored', 200)], { spentTokens: 300 })]);
  assert.equal(engine.getStatus().bDefault, 1100, 'the ignored resource is outside the position basis');
  assert.equal(engine.getBucketData().paths.find(p => p.path === 'ignored').defaultDiscardReason, 'gitignored');

  assert.deepEqual(engine.replaceResourceOverrides({ ignored: 'include', kept: 'exclude' }),
    { changed: true, warnings: [], diagnostics: [] });
  assert.equal(engine.getStatus().bDefault, 1200);
  assert.equal(engine.getBucketData().paths.find(p => p.path === 'ignored').userOverride, 'include');
  assert.equal(engine.getBucketData().paths.find(p => p.path === 'ignored').defaultDiscardReason, 'gitignored',
    'the override does not rewrite the policy default it beats');
});

test('replaceResourceOverrides warns on invalid and unknown entries and reports the effective change', () => {
  const engine = makeEngine();
  engine.ingest([step('m1')]);
  engine.ingest([effect([whole('kept', 100)], { spentTokens: 100 })]);

  const result = engine.replaceResourceOverrides({ kept: 'maybe', missing: 'include', '': 'exclude' });
  assert.equal(result.changed, false, 'no entry survived, so the effective set did not change');
  assert.deepEqual(result.warnings, [
    { code: 'invalid_override_value', resourceKey: 'kept', value: 'maybe' },
    { code: 'unknown_resource', resourceKey: 'missing', value: 'include' },
    { code: 'unknown_resource', resourceKey: '', value: 'exclude' },
  ]);
  assert.equal(engine.getBucketData().paths[0].userOverride, null);

  assert.equal(engine.replaceResourceOverrides({ kept: 'exclude' }).changed, true);
  assert.equal(engine.replaceResourceOverrides({ kept: 'exclude' }).changed, false, 'an identical set is no change');
  assert.throws(() => engine.replaceResourceOverrides(null), /invariant/);
});

test('manual and inferred overrides share one set that whole-set replacement rewrites, and an epoch clears it', () => {
  const engine = makeEngine();
  engine.ingest([step('m1')]);
  engine.ingest([effect([whole('a', 100), whole('b', 200)], { spentTokens: 300 })]);

  engine.replaceResourceOverrides({ a: 'exclude' });                 // a manual decision
  engine.replaceResourceOverrides({ a: 'exclude', b: 'exclude' });   // inference merged in by the caller
  assert.equal(engine.getStatus().bDefault, 1000);

  engine.replaceResourceOverrides({ b: 'exclude' });                 // omitted entries are removed
  assert.equal(engine.getBucketData().paths.find(p => p.path === 'a').userOverride, null);
  assert.equal(engine.getStatus().bDefault, 1100);

  engine.ingest([{ type: 'epoch' }]);
  engine.ingest([step('m2')]);
  engine.ingest([effect([whole('b', 200)], { spentTokens: 200 })]);
  assert.equal(engine.getBucketData().paths.find(p => p.path === 'b').userOverride, null,
    'the override set is current-epoch state');
  assert.equal(engine.getStatus().bDefault, 1200);
});

test('refreshReadPolicies reports changed only when a named read changes', () => {
  let cRatio = 10;
  let discardReason = null;
  const engine = makeEngine({
    resolveModelPolicy: () => ({ cRatio, contextCapacity: 1_000_000 }),
    resolveResourcePolicy: () => ({ selectedByDefault: discardReason === null, defaultDiscardReason: discardReason }),
  });
  engine.ingest([step('m1')]);
  engine.ingest([effect([whole('r1', 400)], { spentTokens: 400 })]);

  assert.deepEqual(engine.refreshReadPolicies(), { changed: false, diagnostics: [] });

  cRatio = 12.5;
  assert.equal(engine.refreshReadPolicies().changed, true);
  assert.equal(engine.getStatus().cRatio, 12.5);
  assert.equal(engine.refreshReadPolicies().changed, false);

  discardReason = 'outside_project';
  assert.equal(engine.refreshReadPolicies().changed, true);
  assert.equal(engine.getBucketData().paths[0].defaultDiscardReason, 'outside_project');
  assert.equal(engine.getStatus().bDefault, 1000);
  assert.equal(engine.refreshReadPolicies().changed, false);
});

test('getBucketData exposes pure re-reads with detached policy selection, line numbers, and snapshot state', () => {
  const engine = makeEngine();
  engine.ingest([step('m1')]);
  engine.ingest([effect([whole('r1', 300)], { spentTokens: 300 })]);
  engine.ingest([effect([whole('r1', 300)], { spentTokens: 300 })]);
  engine.ingest([effect([whole('r1', 300)], { spentTokens: 300 })]);
  engine.ingest([effect([lines('r2', [[4, 10], [2, 20]])], { spentTokens: 30 })]);

  const bucket = engine.getBucketData();
  const first = bucket.paths.find(p => p.path === 'r1');
  assert.equal(first.pureRereads, 2);
  assert.equal(first.fullSnapshot, true);
  assert.deepEqual(first.lineNumbers, []);
  assert.equal(first.defaultSelected, true);
  assert.equal(first.defaultDiscardReason, null);
  const second = bucket.paths.find(p => p.path === 'r2');
  assert.equal(second.pureRereads, 0);
  assert.equal(second.fullSnapshot, false);
  assert.deepEqual(second.lineNumbers, [2, 4]);

  first.lineNumbers.push(99);
  first.pureRereads = 0;
  second.defaultSelected = false;
  const reread = engine.getBucketData();
  assert.equal(reread.paths.find(p => p.path === 'r1').pureRereads, 2);
  assert.deepEqual(reread.paths.find(p => p.path === 'r2').lineNumbers, [2, 4]);
  assert.equal(reread.paths.find(p => p.path === 'r2').defaultSelected, true);
});

test('getHandoffMeasurement returns its complete detached shape from the same snapshot the status read uses', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 0, output: 1, cacheRead: 1000, cacheWrite: 0 })]);
  engine.ingest([effect([lines('r1', [[2, 200], [1, 100]])], { spentTokens: 300 })]);
  engine.ingest([effect([whole('r2', 50)], { spentTokens: 50 })]);

  const status = engine.getStatus();
  const measurement = engine.getHandoffMeasurement();
  assert.deepEqual(measurement, {
    segment: 0,
    turnSeq: 1,
    epochModel: 'model-a',
    measurement: {
      L: status.L, B: status.B, bDefault: status.bDefault, g: status.g, mf: status.mf, br: status.br,
      x: status.x, dhat: status.dhat, cRatio: status.cRatio, dead: 1000, sessionFloor: 1000,
    },
    paths: [
      { path: 'r1', tokens: 300, lastTurn: 1, fullSnapshot: false, lineNumbers: [1, 2] },
      { path: 'r2', tokens: 50, lastTurn: 1, fullSnapshot: true, lineNumbers: [] },
    ],
  });

  measurement.paths.push({ path: 'poison', tokens: 1 });
  measurement.measurement.dead = -1;
  assert.equal(engine.getHandoffMeasurement().paths.length, 2);
  assert.equal(engine.getHandoffMeasurement().measurement.dead, 1000);
});

test('the Engine is the single authority for both the epoch model and the current epoch latest measured model', () => {
  const engine = makeEngine({
    policies: { 'model-a': { cRatio: 10, contextCapacity: 1_000_000 }, 'model-b': { cRatio: 4, contextCapacity: 200_000 } },
  });
  engine.ingest([step('m1', usage(), { model: 'model-a' })]);
  engine.ingest([step('m2', usage({ cacheRead: 2000 }), { model: 'model-b' })]);

  assert.equal(engine.getStatus().model, 'model-a');
  assert.equal(engine.getStatus().latestMeasuredModel, 'model-b');
  assert.equal(engine.getHandoffMeasurement().epochModel, 'model-a');
  assert.equal(engine.getStatus().rateLamp.L_cap, 1_000_000 - RESERVED_OUTPUT - CTX_SAFETY_MARGIN,
    'context capacity follows the epoch model too');

  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.epochModel, 'model-a');
  assert.equal(engine.getStatus().latestMeasuredModel, null, 'the latest measured model is current-epoch state');

  engine.ingest([step('m3', usage(), { model: 'model-b' })]);
  assert.equal(engine.getStatus().model, 'model-b');
  assert.equal(engine.getStatus().latestMeasuredModel, 'model-b');
});

test('readRateLampFrame carries one coherent status, progress, and sample snapshot and no mutable internals', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', usage({ cacheRead: 10_000 }))]);
  engine.ingest([{ type: 'turn-boundary' }]);
  engine.ingest([step('m2', usage({ cacheRead: 14_000 }))]);

  const frame = engine.readRateLampFrame(0);
  assert.deepEqual(Object.keys(frame).sort(), ['foldedCallSeq', 'progress', 'samples', 'status', 'turnSeq']);
  assert.equal(frame.streamRevision, undefined, 'stream continuity is process-local to the application');
  assert.deepEqual(frame.status, engine.getStatus().rateLamp);
  assert.deepEqual(frame.progress, { segment: 0, measuredCalls: 2, sinceFoldedSeq: 0 });
  assert.equal(frame.turnSeq, 2);
  assert.equal(frame.foldedCallSeq, 2);
  assert.deepEqual(frame.samples.map(s => [s.seq, s.turnSeq, s.L_read, s.reliable]), [
    [1, 1, 10_000, true],
    [2, 2, 14_000, true],
  ]);
  for (const sample of frame.samples) assert.ok(Number.isFinite(sample.burnRate));

  assert.deepEqual(engine.readRateLampFrame(1).samples.map(s => s.seq), [2]);
  assert.deepEqual(engine.readRateLampFrame(2).samples, []);

  frame.status.reliable = false;
  frame.progress.measuredCalls = 99;
  frame.samples[0].L_read = -1;
  const reread = engine.readRateLampFrame(0);
  assert.equal(reread.status.reliable, true);
  assert.equal(reread.progress.measuredCalls, 2);
  assert.equal(reread.samples[0].L_read, 10_000);

  const unreliable = makeEngine();
  unreliable.ingest([step('n1', { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 })]);
  const cold = unreliable.readRateLampFrame(0);
  assert.equal(cold.status.reliable, false);
  assert.equal(cold.status.unavailableReason, 'insufficient_data');
  assert.deepEqual(cold.samples.map(s => [s.seq, s.reliable, s.unavailableReason]), [[1, false, 'insufficient_data']]);
});
