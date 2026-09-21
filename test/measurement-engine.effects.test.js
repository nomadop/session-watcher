import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { createResidentLedger, TOUCH_HISTORY_MAX, TOUCH_HISTORY_KEEP }
  from '../lib/measurement/resident-ledger.js';

// Resident mutations, spend/touch accounting and residual grouping. All inputs are plain record
// literals: the resident ledger sees opaque resource keys, resource-local fragment keys and numbers.

function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy: () => ({ cRatio: 10, contextCapacity: 1_000_000 }),
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}

const step = (id, use, extra = {}) => ({
  type: 'step', id, model: 'model-a', timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...use }, ...extra,
});
const stock = (id, cacheRead, over = {}) => step(id, { cacheRead, ...over });
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
const adjust = (resourceKey, deltaTokens) => ({
  resourceKey, mutation: { kind: 'adjust-total', deltaTokens },
});
const residual = (groupKey, weight = 1, over = {}) => ({
  type: 'residual', groupKey, weight, hadError: false, meta: { kind: 'bash' }, ...over,
});
const row = (engine, path) => engine.getBucketData().paths.find(p => p.path === path);
const group = (engine, groupKey) => engine.getBucketData().residual.find(r => r.groupKey === groupKey);

test('closing an empty segment emits no artifact and advances the segment', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.closeCurrentSegment(), { closedSegments: [], diagnostics: [] });
  assert.equal(engine.getStatus().segment, 1);
  // an effect alone is not a measured segment either
  engine.ingest([effect([whole('r1', 100)], { spentTokens: 100 })]);
  assert.deepEqual(engine.closeCurrentSegment(), { closedSegments: [], diagnostics: [] });
  assert.equal(engine.getStatus().segment, 2);
});

test('replace-fragments resets fragments and adjustment', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([lines('r1', [[1, 10], [2, 20], [3, 30]])], { overheadTokens: 5, spentTokens: 60 })]);
  engine.ingest([effect([adjust('r1', -25)], { access: 'write', spentTokens: 25 })]);
  assert.equal(row(engine, 'r1').tokens, 10 + 20 + 30 + 5 - 25);

  engine.ingest([effect([whole('r1', 7)], { overheadTokens: 3, spentTokens: 10 })]);
  assert.equal(row(engine, 'r1').tokens, 10, 'fragments and the signed adjustment are both replaced');
  assert.deepEqual(row(engine, 'r1').lineNumbers, [], 'a non-numeric fragment key is no line coverage');
  assert.equal(row(engine, 'r1').fullSnapshot, true);
});

test('merge-fragments upserts by resource-local natural key', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([lines('r1', [[1, 10], [2, 20]])], { spentTokens: 30 })]);
  engine.ingest([effect([lines('r1', [[2, 200], [9, 5]])], { spentTokens: 205 })]);
  assert.equal(row(engine, 'r1').tokens, 10 + 200 + 5);
  assert.deepEqual(row(engine, 'r1').lineNumbers, [1, 2, 9]);
  assert.equal(row(engine, 'r1').fullSnapshot, false);
});

test('adjust-total takes a signed delta, allocates no effect overhead, keeps spend independent of it, preserves prior overhead, and clamps reads at zero', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([lines('r1', [[1, 10]])], { overheadTokens: 5, spentTokens: 100 })]);
  assert.equal(row(engine, 'r1').tokens, 15);
  assert.equal(row(engine, 'r1').totalSpent, 100);

  engine.ingest([effect([adjust('r1', 60)], { access: 'write', overheadTokens: 999, spentTokens: 20 })]);
  assert.equal(row(engine, 'r1').tokens, 75, 'the signed delta lands, the effect overhead does not, and the prior overhead stays');
  assert.equal(row(engine, 'r1').totalSpent, 120, 'spend is the effect spend, not the delta');

  engine.ingest([effect([adjust('r1', -5000)], { access: 'write', spentTokens: 10 })]);
  assert.equal(row(engine, 'r1'), undefined, 'a resource read down past zero clamps out of the bucket');
  engine.ingest([effect([adjust('r1', 5000)], { access: 'write', spentTokens: 10 })]);
  assert.equal(row(engine, 'r1').tokens, 75, 'the clamp is a read, not a write: the signed debt is intact');
});

test('one impact receives all overhead and spend', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([lines('r1', [[1, 100]])], { overheadTokens: 40, spentTokens: 210 })]);
  assert.equal(row(engine, 'r1').tokens, 140);
  assert.equal(row(engine, 'r1').totalSpent, 210);
});

test('multiple impacts split overhead evenly and spend proportionally', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([lines('big', [[1, 300]]), lines('small', [[1, 100]])],
    { overheadTokens: 40, spentTokens: 660 })]);
  assert.equal(row(engine, 'big').tokens, 320, 'overhead halves');
  assert.equal(row(engine, 'small').tokens, 120);
  // 660 × 320/440 and 660 × 120/440: an even split would charge each 330
  assert.equal(row(engine, 'big').totalSpent, 480, 'spend follows each resource injected share');
  assert.equal(row(engine, 'small').totalSpent, 180);
});

test('a multi-impact read stamps each resource once; a write with no resource-total change stamps the same cursors', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000), { type: 'turn-boundary' }, stock('m2', 2000)]);
  engine.ingest([effect([lines('r1', [[1, 10]]), lines('r2', [[1, 20]])], { spentTokens: 30 })]);

  for (const key of ['r1', 'r2']) {
    assert.equal(row(engine, key).readCount, 1);
    assert.equal(row(engine, key).editCount, 0);
    assert.deepEqual(row(engine, key).touchSeqs, [{ seq: 2, mode: 'r' }]);
    assert.equal(row(engine, key).lastTurn, 2);
    assert.equal(row(engine, key).lastCallSeq, 2);
  }

  engine.ingest([effect([adjust('r1', 0)], { access: 'write', spentTokens: 4 })]);
  assert.equal(row(engine, 'r1').tokens, 10, 'the resource total did not move');
  assert.equal(row(engine, 'r1').editCount, 1);
  assert.equal(row(engine, 'r1').readCount, 1);
  assert.deepEqual(row(engine, 'r1').touchSeqs, [{ seq: 2, mode: 'r' }, { seq: 2, mode: 'w' }]);
  assert.equal(row(engine, 'r1').lastTurn, 2);
  assert.equal(row(engine, 'r1').lastCallSeq, 2);
});

test('accumulated spend is never rounded away, only rounded at read time', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([whole('r1', 100)], { spentTokens: 0.49 })]);
  assert.equal(row(engine, 'r1').totalSpent, 100);
  assert.equal(row(engine, 'r1').churn, 1);

  engine.ingest([effect([whole('r1', 0.1)], { spentTokens: 0.49 })]);
  assert.equal(row(engine, 'r1').totalSpent, 1);
  assert.equal(row(engine, 'r1').churn, 10);
  assert.equal(row(engine, 'r1').efficiency, 10);
});

test('whole-content reads establish eligibility and count pure re-reads; other reads preserve it and a write clears it', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);

  engine.ingest([effect([whole('r1', 0)], { spentTokens: 1 })]);         // zero-token snapshot: eligible
  engine.ingest([effect([whole('r1', 50)], { spentTokens: 50 })]);       // positive re-read: counts
  assert.equal(row(engine, 'r1').pureRereads, 1);

  engine.ingest([effect([lines('r1', [[1, 5]])], { spentTokens: 5 })]);  // partial read preserves eligibility
  engine.ingest([effect([whole('r1', 60)], { spentTokens: 60 })]);       // different content still counts
  assert.equal(row(engine, 'r1').pureRereads, 2);

  engine.ingest([effect([adjust('r1', 0)], { access: 'write', spentTokens: 1 })]);
  engine.ingest([effect([whole('r1', 60)], { spentTokens: 60 })]);
  assert.equal(row(engine, 'r1').pureRereads, 2, 'an accepted write with zero net change clears eligibility');
  engine.ingest([effect([whole('r1', 60)], { spentTokens: 60 })]);
  assert.equal(row(engine, 'r1').pureRereads, 3);
});

test('duplicate fragment keys in one impact fail the invariant', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  assert.throws(() => engine.ingest([effect([lines('r1', [[1, 10], [1, 20]])], { spentTokens: 30 })]), /invariant/);
  assert.equal(row(engine, 'r1'), undefined, 'a rejected effect mutates nothing');
});

test('an unsupported mutation fails the invariant', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  assert.throws(() => engine.ingest([effect([
    { resourceKey: 'r1', mutation: { kind: 'replace-total', tokens: 5 } },
  ])]), /invariant/);
  assert.throws(() => engine.ingest([effect([
    lines('ok', [[1, 1]]),
    { resourceKey: 'r2', mutation: { kind: 'replace-total', tokens: 5 } },
  ])]), /invariant/);
  assert.equal(row(engine, 'ok'), undefined, 'a later invalid impact rejects the whole effect');
});

test('newResourceKeys lists only first creation', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  const first = engine.ingest([effect([lines('r1', [[1, 10]]), lines('r2', [[1, 10]])], { spentTokens: 20 })]);
  assert.deepEqual(first.newResourceKeys, ['r1', 'r2']);
  const again = engine.ingest([effect([lines('r1', [[2, 10]]), lines('r3', [[1, 10]])], { spentTokens: 20 })]);
  assert.deepEqual(again.newResourceKeys, ['r3']);
});

test('applyEffect returns detached growth and creation facts for every resource it changes', () => {
  const ledger = createResidentLedger();
  const applied = ledger.applyEffect(
    effect([lines('r1', [[1, 100]]), lines('r2', [[1, 40]])], { overheadTokens: 20, spentTokens: 160 }),
    { turn: 3, foldedSeq: 7 },
  );
  assert.deepEqual(Object.keys(applied).sort(), ['diagnostics', 'newResourceKeys', 'positiveResourceDeltas']);
  assert.deepEqual(applied.newResourceKeys, ['r1', 'r2']);
  assert.deepEqual(applied.positiveResourceDeltas, [
    { resourceKey: 'r1', growth: 110 },
    { resourceKey: 'r2', growth: 50 },
  ]);
  applied.newResourceKeys.push('poison');
  applied.positiveResourceDeltas[0].growth = -1;

  const second = ledger.applyEffect(
    effect([lines('r1', [[2, 5]]), whole('r2', 1)], { overheadTokens: 20, spentTokens: 6 }),
    { turn: 3, foldedSeq: 8 },
  );
  assert.deepEqual(second.newResourceKeys, []);
  assert.deepEqual(second.positiveResourceDeltas, [{ resourceKey: 'r1', growth: 5 }],
    'only whole-effect net growth counts, so the shrunk resource is absent');
});

test('a residual record enters the pending set without mutating the resident ledger', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([whole('r1', 100)], { spentTokens: 100 })]);
  const before = engine.getBucketData();
  engine.ingest([residual('g1', 5)]);
  const after = engine.getBucketData();
  assert.deepEqual(after.paths, before.paths);
  assert.deepEqual(after.residual, []);
  assert.equal(after.totalB, before.totalB);
});

test("the next accepted new step distributes the interval's unplaced growth by weight and clears the pending set", () => {
  const byWeight = makeEngine();
  byWeight.ingest([stock('m1', 10_000)]);
  byWeight.ingest([residual('a', 30), residual('b', 10)]);
  // stock grew with nothing resident to place it on: the whole interval is unplaced
  byWeight.ingest([stock('m2', 14_000)]);
  assert.equal(group(byWeight, 'a').tokens, 3000);
  assert.equal(group(byWeight, 'b').tokens, 1000);

  byWeight.ingest([stock('m3', 18_000)]);                 // pending was cleared: no further allocation
  assert.equal(group(byWeight, 'a').tokens, 3000);
  assert.equal(group(byWeight, 'b').tokens, 1000);

  const evenly = makeEngine();
  evenly.ingest([stock('n1', 10_000)]);
  evenly.ingest([residual('a', 0), residual('b', 0)]);
  evenly.ingest([stock('n2', 14_000)]);
  assert.equal(group(evenly, 'a').tokens, 2000);
  assert.equal(group(evenly, 'b').tokens, 2000);
});

test('an accepted revision neither allocates nor clears pending residuals', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([residual('a', 1)]);
  engine.ingest([stock('m1', 10_000, { output: 9 })]);     // accepted revision
  assert.equal(group(engine, 'a'), undefined, 'no allocation');
  engine.ingest([stock('m2', 14_000)]);
  assert.equal(group(engine, 'a').tokens, 4000, 'the candidate survived the revision');
});

test('residual candidates are credited with the stock growth of their own interval, not the cacheRead lag', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([residual('a', 1)]);
  // new content parks in cacheWrite first, so ΔcacheRead is flat while total stock advances
  engine.ingest([step('m2', { cacheRead: 10_000, cacheWrite: 4_000 })]);
  assert.equal(group(engine, 'a').tokens, 4000, 'the candidate takes the interval it completed in');

  engine.ingest([residual('b', 1)]);
  // the prefix catch-up carries the previous interval's bytes while this interval adds its own
  engine.ingest([step('m3', { cacheRead: 14_000, cacheWrite: 3_000 })]);
  assert.equal(group(engine, 'a').tokens, 4000, 'the earlier group does not receive the lagged 4000');
  assert.equal(group(engine, 'b').tokens, 3000, 'the later group receives its own interval');
});

test('a candidate completed in the interval after a cache miss is still allocated', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([stock('m2', 14_000)]);
  // cacheRead collapses while stock is preserved: a miss, whose L is its total stock
  engine.ingest([step('m3', { input: 2_000, cacheRead: 1_000, cacheWrite: 13_000 })]);
  engine.ingest([residual('a', 1)]);
  // the prefix is rebuilt to the miss step's stock, so ΔL is flat while the interval itself grew
  engine.ingest([step('m4', { cacheRead: 16_000, cacheWrite: 500 })]);
  assert.equal(group(engine, 'a').tokens, 500);
});

test('residual allocation changes neither the uncapped resident total nor the per-resource delta map', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([effect([whole('r1', 1000)], { spentTokens: 1000 })]);
  engine.ingest([residual('a', 1)]);
  engine.ingest([stock('m2', 14_000)]);                   // ΔL exceeds Δresident, so nothing is banked; the interval's unplaced stock growth is paid to the candidate

  assert.ok(group(engine, 'a').tokens > 0);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 11_000, 'the residual group is outside B and outside settlement');
  assert.deepEqual(closed.paths, [{ path: 'r1', tokens: 1000 }]);
});

test('successful epoch and close discard pending residuals', () => {
  const viaEpoch = makeEngine();
  viaEpoch.ingest([stock('m1', 10_000), residual('a', 1), { type: 'epoch' }]);
  viaEpoch.ingest([stock('m2', 10_000), stock('m3', 14_000)]);
  assert.equal(group(viaEpoch, 'a'), undefined);

  const viaClose = makeEngine();
  viaClose.ingest([stock('m1', 10_000), residual('a', 1)]);
  viaClose.closeCurrentSegment();
  viaClose.ingest([stock('m2', 10_000), stock('m3', 14_000)]);
  assert.equal(group(viaClose, 'a'), undefined);
});

test('each allocation stamps its own candidate cursors, error mode, and metadata', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([residual('a', 1, { hadError: true, meta: { kind: 'mcp', detail: 'first' } })]);
  engine.ingest([stock('m2', 14_000)]);

  const allocated = group(engine, 'a');
  assert.equal(allocated.tokens, 4000);
  assert.equal(allocated.count, 1);
  assert.deepEqual(allocated.touchSeqs, [{ seq: 1, mode: 'e' }]);
  assert.equal(allocated.lastTurn, 1);
  assert.equal(allocated.lastCallSeq, 1);
  assert.deepEqual(allocated.meta, { kind: 'mcp', detail: 'first' });
  assert.equal(group(engine, 'b'), undefined, 'allocation selects the group by exact key');
});

test('two same-group candidates recorded in one interval both land, in pending order, at their own cursors', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([
    residual('a', 1, { hadError: false, meta: { kind: 'bash', detail: 'earlier' } }),
    residual('a', 1, { hadError: true, meta: { kind: 'bash', detail: 'later' } }),
  ]);
  engine.ingest([{ type: 'turn-boundary' }]);
  engine.ingest([stock('m2', 14_000)]);

  const allocated = group(engine, 'a');
  assert.equal(engine.getStatus().turnSeq, 2, 'the consuming step opened the next turn');
  assert.equal(allocated.count, 2);
  assert.deepEqual(allocated.touchSeqs, [{ seq: 1, mode: 'w' }, { seq: 1, mode: 'e' }]);
  assert.equal(allocated.lastTurn, 1);
  assert.equal(allocated.lastCallSeq, 1);
  assert.deepEqual(allocated.meta, { kind: 'bash', detail: 'later' }, 'metadata is replaced wholesale');
  assert.equal(allocated.tokens, 4000);
});

test('a zero-growth interval leaves an existing group untouched and still clears pending', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([residual('a', 1, { meta: { kind: 'bash', detail: 'kept' } })]);
  engine.ingest([stock('m2', 14_000)]);
  const before = group(engine, 'a');

  engine.ingest([residual('a', 1, { hadError: true, meta: { kind: 'bash', detail: 'dropped' } })]);
  engine.ingest([stock('m3', 14_000)]);                   // flat stock → nothing to place
  assert.deepEqual(group(engine, 'a'), before);

  engine.ingest([stock('m4', 18_000)]);                   // the cleared candidate is not resurrected
  assert.deepEqual(group(engine, 'a'), before);
});

test('resource and residual touch histories keep the newest folded-sequence suffix', () => {
  const engine = makeEngine();
  engine.ingest([stock('m0', 10_000)]);
  let cacheRead = 10_000;
  for (let i = 1; i <= TOUCH_HISTORY_MAX + 1; i++) {
    engine.ingest([
      effect([lines('r1', [[i, 1]])], { spentTokens: 1 }),
      residual('a', 1),
    ]);
    cacheRead += 10_000;
    engine.ingest([stock('m' + i, cacheRead)]);
  }
  const expected = Array.from({ length: TOUCH_HISTORY_KEEP }, (_, i) => TOUCH_HISTORY_MAX + 2 - TOUCH_HISTORY_KEEP + i);
  assert.deepEqual(row(engine, 'r1').touchSeqs.map(t => t.seq), expected);
  assert.deepEqual(group(engine, 'a').touchSeqs.map(t => t.seq), expected);
  assert.equal(group(engine, 'a').count, TOUCH_HISTORY_MAX + 1, 'the count is not a touch-history length');
});

test('an effect carries no step reference, so step revisions cannot reorder its application', () => {
  const revisionFirst = makeEngine();
  revisionFirst.ingest([stock('m1', 10_000)]);
  revisionFirst.ingest([stock('m1', 12_000)]);
  revisionFirst.ingest([effect([lines('r1', [[1, 10]])], { spentTokens: 10 })]);

  const effectFirst = makeEngine();
  effectFirst.ingest([stock('m1', 10_000)]);
  effectFirst.ingest([effect([lines('r1', [[1, 10]])], { spentTokens: 10 })]);
  effectFirst.ingest([stock('m1', 12_000)]);

  assert.deepEqual(revisionFirst.getBucketData().paths, effectFirst.getBucketData().paths);
});
