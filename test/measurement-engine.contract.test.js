import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';

// Step, turn, epoch and usage contract of the portable Measurement Engine. Records are plain literals:
// the Engine accepts normalized numeric facts, so no harness fixture or tool name appears here.

const MODEL_POLICIES = {
  'model-a': { cRatio: 10, contextCapacity: 1_000_000 },
  'model-b': { cRatio: 4, contextCapacity: 200_000 },
};
const DEFAULT_POLICY = { cRatio: 10, contextCapacity: 1_000_000 };

function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy: (modelId) => MODEL_POLICIES[modelId] ?? DEFAULT_POLICY,
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}

const usage = (over = {}) => ({ input: 0, output: 1, cacheRead: 100, cacheWrite: 0, ...over });
const step = (id, use = usage(), extra = {}) => ({
  type: 'step', id, model: 'model-a', timestamp: 1, usage: use, ...extra,
});
const effect = (impacts, over = {}) => ({
  type: 'effect', access: 'read', overheadTokens: 0, spentTokens: 0, impacts, ...over,
});
const wholeContent = (resourceKey, tokens) => ({
  resourceKey, mutation: { kind: 'replace-fragments', fragments: [{ key: 'whole-content', tokens }] },
});

test('[delta] accepted revision replaces all usage buckets with signed aggregate deltas', () => {
  const first = { input: 10, output: 4, cacheRead: 100, cacheWrite: 0 };
  const revised = { input: 8, output: 5, cacheRead: 200, cacheWrite: 0 };
  const next = { input: 0, output: 6, cacheRead: 300, cacheWrite: 0 };
  const engine = makeEngine();
  engine.ingest([step('m1', first)]);
  const result = engine.ingest([step('m1', revised, { timestamp: 2 })]);

  assert.equal(result.newCalls, 0);
  assert.equal(result.revisedCalls, 1);
  assert.deepEqual(engine.getStatus().usage, revised);

  engine.ingest([step('m2', next, { timestamp: 3 })]);
  const [closed] = engine.closeCurrentSegment().closedSegments;

  assert.deepEqual(closed.steps.map(s => s.usage), [revised, next]);
  assert.equal(closed.metrics.oAvg, 5.5);
  assert.equal(closed.metrics.totalTokensRead, 8);
});

test('accepted revision keeps the first measurement point', () => {
  const engine = makeEngine();
  engine.ingest([
    step('m1', { input: 10, output: 1, cacheRead: 100, cacheWrite: 0 }, { timestamp: 1 }),
    step('m2', { input: 10, output: 1, cacheRead: 200, cacheWrite: 0 }, { timestamp: 2 }),
  ]);
  const beforeStatus = engine.getStatus();
  const beforePoint = engine.getHistory().at(-1);
  const beforeSamples = engine.readRateLampFrame(0).samples;
  const revised = { input: 200, output: 2, cacheRead: 20, cacheWrite: 0 };

  const result = engine.ingest([step('m2', revised, { timestamp: 3 })]);
  const afterPoint = engine.getHistory().at(-1);

  assert.equal(result.revisedCalls, 1);
  assert.equal(engine.getStatus().L, beforeStatus.L);
  assert.equal(afterPoint.L, 220);
  assert.equal(afterPoint.B, beforePoint.B);
  assert.equal(afterPoint.g, beforePoint.g);
  assert.equal(afterPoint.miss, beforePoint.miss);
  assert.equal(afterPoint.turnSeq, beforePoint.turnSeq);
  assert.equal(afterPoint.foldedSeq, beforePoint.foldedSeq);
  assert.deepEqual(engine.readRateLampFrame(0).samples, beforeSamples);

  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.deepEqual(closed.steps[1].usage, revised);
  assert.equal(closed.steps[1].timestamp, 3);
  assert.equal(closed.metrics.lPeak, beforeStatus.L);
  assert.equal(closed.metrics.gFinal, beforeStatus.g);
});

test('[delta] epoch retains the pending turn boundary', () => {
  const engine = makeEngine();
  engine.ingest([step('m1'), { type: 'turn-boundary' }, { type: 'epoch' }]);
  engine.ingest([step('m2')]);
  assert.equal(engine.getStatus().turnSeq, 2);
});

test('[delta] miss L is total stock', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 0, output: 1, cacheRead: 100, cacheWrite: 0 })]);
  engine.ingest([step('m2', { input: 20, output: 1, cacheRead: 0, cacheWrite: 80 })]);
  assert.equal(engine.getStatus().L, 100);
  assert.deepEqual(engine.getHistory().map(point => point.miss), [false, true]);
});

test('the first measured step establishes turn one without a prior boundary', () => {
  const engine = makeEngine();
  assert.equal(engine.getStatus().turnSeq, 0);
  engine.ingest([step('m1')]);
  assert.equal(engine.getStatus().turnSeq, 1);
  assert.equal(engine.getHistory().at(-1).turnSeq, 1);
});

test('repeated turn boundaries coalesce into one turn', () => {
  const engine = makeEngine();
  engine.ingest([step('m1')]);
  engine.ingest([
    { type: 'turn-boundary' },
    { type: 'turn-boundary' },
    { type: 'turn-boundary' },
    step('m2'),
  ]);
  assert.equal(engine.getStatus().turnSeq, 2);
});

// A turn is not a call: one assistant turn routinely issues several API calls, and only a boundary between
// them opens a new turn. Numbering per step instead would make every turn-scoped read a per-call read.
test('two new steps with no boundary between them share one turn', () => {
  const engine = makeEngine();
  engine.ingest([step('m1')]);
  engine.ingest([step('m2')]);
  const points = engine.getHistory();

  assert.equal(engine.getStatus().turnSeq, 1);
  assert.deepEqual(points.slice(-2).map(p => p.turnSeq), [1, 1]);
  engine.ingest([{ type: 'turn-boundary' }, step('m3')]);
  assert.equal(engine.getHistory().at(-1).turnSeq, 2);
});

test('a boundary without a later new step creates no turn', () => {
  const engine = makeEngine();
  engine.ingest([step('m1'), { type: 'turn-boundary' }]);
  assert.equal(engine.getStatus().turnSeq, 1);
  // a revision, an effect and a residual all leave the pending bit unconsumed
  engine.ingest([
    step('m1', usage({ output: 9 })),
    effect([wholeContent('r1', 10)]),
    { type: 'residual', groupKey: 'g1', weight: 1, hadError: false, meta: {} },
  ]);
  assert.equal(engine.getStatus().turnSeq, 1);
  engine.ingest([step('m2')]);
  assert.equal(engine.getStatus().turnSeq, 2);
});

test('an epoch clears the step namespace and segment-local resident and residual state while retaining process history', () => {
  const engine = makeEngine();
  engine.ingest([
    step('m1', { input: 0, output: 1, cacheRead: 1000, cacheWrite: 0 }),
    effect([wholeContent('r1', 500)]),
    { type: 'residual', groupKey: 'g1', weight: 1, hadError: false, meta: {} },
  ]);
  const before = engine.getStatus();
  assert.equal(before.segment, 0);
  assert.ok(engine.getBucketData().paths.length > 0);

  engine.ingest([{ type: 'epoch' }]);
  const afterEpoch = engine.getStatus();
  assert.equal(afterEpoch.segment, 1);
  assert.equal(afterEpoch.turnSeq, before.turnSeq, 'turn sequence is process-local');
  assert.deepEqual(engine.getBucketData().paths, [], 'resident state is segment-local');
  assert.deepEqual(engine.getBucketData().residual, []);
  assert.equal(engine.getBucketData().dead, 0);
  assert.equal(engine.getHistory().length, 1, 'closed history is retained');

  // the id namespace is cleared, so the same id names a NEW call in the new epoch
  const result = engine.ingest([step('m1', { input: 0, output: 1, cacheRead: 2000, cacheWrite: 0 })]);
  assert.equal(result.newCalls, 1);
  assert.equal(result.revisedCalls, 0);
  assert.equal(engine.getHistory().length, 2);
  assert.equal(engine.getHistory().at(-1).foldedSeq, 2, 'folded sequence is process-local');
});

test('an equal-total revision is accepted', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 10, output: 10, cacheRead: 100, cacheWrite: 0 })]);
  const equal = { input: 20, output: 0, cacheRead: 100, cacheWrite: 0 };
  const result = engine.ingest([step('m1', equal, { timestamp: 7 })]);
  assert.equal(result.revisedCalls, 1);
  assert.equal(result.diagnostics.length, 0);
  assert.deepEqual(engine.getStatus().usage, equal);
});

test('a lower-total revision is ignored and adds a diagnostic', () => {
  const engine = makeEngine();
  const accepted = { input: 10, output: 10, cacheRead: 100, cacheWrite: 0 };
  engine.ingest([step('m1', accepted)]);
  const result = engine.ingest([step('m1', { input: 0, output: 1, cacheRead: 100, cacheWrite: 0 })]);
  assert.equal(result.revisedCalls, 0);
  assert.equal(result.newCalls, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(engine.getStatus().usage, accepted);
});

test('a model conflict is diagnosed while an otherwise acceptable usage revision still applies', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 0, output: 1, cacheRead: 100, cacheWrite: 0 })]);
  const revised = { input: 0, output: 2, cacheRead: 300, cacheWrite: 0 };
  const result = engine.ingest([step('m1', revised, { model: 'model-b' })]);
  assert.equal(result.revisedCalls, 1);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(engine.getStatus().usage, revised);
  assert.equal(engine.getStatus().model, 'model-a', 'the accepted model is immutable');
  assert.equal(engine.getStatus().cRatio, 10);
});

test('effects, residuals, boundaries, epochs, and lower revisions change neither call counter', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 0, output: 5, cacheRead: 100, cacheWrite: 0 })]);
  const result = engine.ingest([
    effect([wholeContent('r1', 10)]),
    { type: 'residual', groupKey: 'g1', weight: 1, hadError: false, meta: {} },
    { type: 'turn-boundary' },
    step('m1', { input: 0, output: 1, cacheRead: 1, cacheWrite: 0 }),
    { type: 'epoch' },
  ]);
  assert.equal(result.newCalls, 0);
  assert.equal(result.revisedCalls, 0);
});

test('finite fractional token values are accepted', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 0.5, output: 0.25, cacheRead: 10.125, cacheWrite: 0 })]);
  assert.equal(engine.getStatus().L, 10.125);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.totalTokensRead, 0.5);
  assert.equal(closed.metrics.oAvg, 0.25);
  assert.equal(closed.metrics.lFloor, 10.625);
});

test('extra record members are ignored', () => {
  const engine = makeEngine();
  const result = engine.ingest([
    { ...step('m1'), nativeRow: { anything: true }, sourceOrdinal: 12 },
    { type: 'turn-boundary', extra: 'ignored' },
  ]);
  assert.equal(result.newCalls, 1);
  assert.equal(result.diagnostics.length, 0);
});

test('null usage fails the invariant rather than creating an empty step', () => {
  const engine = makeEngine();
  assert.throws(() => engine.ingest([step('m1', null)]), /invariant/);
  assert.equal(engine.getStatus().apiCalls, 0);
});

test('a non-finite usage bucket fails the invariant', () => {
  const engine = makeEngine();
  assert.throws(() => engine.ingest([step('m1', { input: 0, output: 1, cacheRead: NaN, cacheWrite: 0 })]), /invariant/);
  assert.throws(() => engine.ingest([step('m2', { input: 0, output: 1, cacheRead: Infinity, cacheWrite: 0 })]), /invariant/);
  assert.throws(() => engine.ingest([step('m3', { input: 0, output: 1, cacheWrite: 0 })]), /invariant/);
  assert.equal(engine.getStatus().apiCalls, 0);
});

test('an invalid discriminant throws as an internal invariant failure', () => {
  const engine = makeEngine();
  assert.throws(() => engine.ingest([{ type: 'eviction' }]), /invariant/);
  assert.throws(() => engine.ingest([{ type: 'step', id: '', model: 'model-a', timestamp: 1, usage: usage() }]), /invariant/);
  assert.throws(() => engine.ingest([null]), /invariant/);
});

test('epoch and explicit close over equivalent Engine state produce the same detached closed segment', () => {
  const records = [
    step('m1', { input: 5, output: 3, cacheRead: 1000, cacheWrite: 0 }, { timestamp: 10 }),
    effect([wholeContent('r1', 400)], { spentTokens: 500 }),
    { type: 'turn-boundary' },
    step('m2', { input: 5, output: 7, cacheRead: 1400, cacheWrite: 0 }, { timestamp: 40 }),
  ];
  const viaEpoch = makeEngine();
  viaEpoch.ingest(records);
  const [epochClosed] = viaEpoch.ingest([{ type: 'epoch' }]).closedSegments;

  const viaClose = makeEngine();
  viaClose.ingest(records);
  const [explicitClosed] = viaClose.closeCurrentSegment().closedSegments;

  assert.deepEqual(epochClosed, explicitClosed);
});

test('a closed segment freezes every specified metric with no missing member', () => {
  const engine = makeEngine();
  engine.ingest([
    step('m1', { input: 0, output: 3, cacheRead: 0, cacheWrite: 1000 }, { timestamp: 1000 }),
    step('m2', { input: 5, output: 7, cacheRead: 4000, cacheWrite: 0 }, { timestamp: 5000 }),
  ]);
  const [closed] = engine.closeCurrentSegment().closedSegments;

  assert.deepEqual(Object.keys(closed).sort(), ['epochModel', 'metrics', 'paths', 'segment', 'steps']);
  assert.equal(closed.segment, 0);
  assert.equal(closed.epochModel, 'model-a');
  assert.deepEqual(Object.keys(closed.metrics).sort(), [
    'bAxis', 'bTotal', 'brExit', 'brPeak', 'cRatio', 'durationMs', 'gFinal', 'gMin', 'lFloor',
    'lPeak', 'mf', 'oAvg', 'p0', 'ppExit', 'ppPeak', 'totalTokensRead', 'turnAtBrAmber', 'turns', 'xAxis',
  ]);
  for (const [name, value] of Object.entries(closed.metrics)) {
    assert.notEqual(value, undefined, `metric ${name} must be present`);
  }
  assert.equal(closed.metrics.durationMs, 4000);
  assert.equal(closed.metrics.turns, 1);
  assert.equal(closed.metrics.lFloor, 1000);
  assert.equal(closed.metrics.bTotal, 1000);
  assert.equal(closed.metrics.lPeak, 4000);
  assert.equal(closed.metrics.xAxis, 4);
});

test('an early lPeak, brPeak, or ppPeak above its exit value remains frozen', () => {
  const engine = makeEngine();
  // One settled interval of growth ahead of the spike, so the fold's rate is positive when the spike's own
  // interval is priced and the spike lands as a stamped peak.
  engine.ingest([step('m1', { input: 1000, output: 1, cacheRead: 0, cacheWrite: 0 })]);
  engine.ingest([step('m2', { input: 0, output: 1, cacheRead: 1200, cacheWrite: 0 })]);
  engine.ingest([step('m3', { input: 0, output: 1, cacheRead: 50_000, cacheWrite: 0 })]);
  engine.ingest([step('m4', { input: 0, output: 1, cacheRead: 1300, cacheWrite: 0 })]);
  const [closed] = engine.closeCurrentSegment().closedSegments;

  assert.equal(closed.metrics.lPeak, 50_000);
  assert.ok(closed.metrics.lPeak > closed.metrics.bTotal);
  assert.ok(closed.metrics.brPeak > closed.metrics.brExit,
    `brPeak ${closed.metrics.brPeak} must stay above brExit ${closed.metrics.brExit}`);
  assert.ok(closed.metrics.ppPeak > closed.metrics.ppExit,
    `ppPeak ${closed.metrics.ppPeak} must stay above ppExit ${closed.metrics.ppExit}`);
});

test('return values and named reads are detached', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { input: 0, output: 1, cacheRead: 1000, cacheWrite: 0 })]);
  engine.ingest([effect([wholeContent('r1', 400)], { spentTokens: 400 })]);

  const status = engine.getStatus();
  status.rateLamp.br = 999;
  status.usage.output = 999;
  assert.notEqual(engine.getStatus().rateLamp.br, 999);
  assert.notEqual(engine.getStatus().usage.output, 999);

  const history = engine.getHistory();
  history.push({ poisoned: true });
  history[0].L = -1;
  assert.equal(engine.getHistory().length, 1);
  assert.notEqual(engine.getHistory()[0].L, -1);

  const bucket = engine.getBucketData();
  bucket.paths.push({ path: 'poison', tokens: 1 });
  bucket.paths[0].tokens = -1;
  assert.equal(engine.getBucketData().paths.length, 1);
  assert.notEqual(engine.getBucketData().paths[0].tokens, -1);

  const frame = engine.readRateLampFrame(0);
  frame.samples.push({ seq: 99 });
  assert.equal(engine.readRateLampFrame(0).samples.length, 1);

  const closeResult = engine.closeCurrentSegment();
  closeResult.closedSegments[0].paths[0].tokens = -1;
  closeResult.closedSegments.push({ poisoned: true });
  assert.equal(engine.getStatus().segment, 1);
});
