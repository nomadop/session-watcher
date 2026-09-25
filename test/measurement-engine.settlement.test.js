import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { G_FLOOR } from '../lib/constants.js';

// Deferred settlement, anchoring, and g estimation at the Engine Interface. Every input is a plain
// record literal; the observable channels are the named reads and the frozen closed segment.

function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy: () => ({ cRatio: 10, contextCapacity: 1_000_000 }),
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}

const step = (id, use, extra = {}) => ({
  type: 'step', id, model: 'model-a', timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...use }, ...extra,
});
const stock = (id, cacheRead, over = {}) => step(id, { cacheRead, ...over });
const effect = (impacts, over = {}) => ({
  type: 'effect', access: 'read', overheadTokens: 0, spentTokens: 0, impacts, ...over,
});
const wholeContent = (resourceKey, tokens) => ({
  resourceKey, mutation: { kind: 'replace-fragments', fragments: [{ key: 'whole-content', tokens }] },
});
const residual = (groupKey, weight = 1, over = {}) => ({
  type: 'residual', groupKey, weight, hadError: false, meta: { kind: 'bash' }, ...over,
});
const residualTokens = (engine, groupKey) => {
  const row = engine.getBucketData().residual.find(r => r.groupKey === groupKey);
  return row ? row.tokens : 0;
};
const resourceTokens = (engine, path) => {
  const row = engine.getBucketData().paths.find(p => p.path === path);
  return row ? row.tokens : 0;
};

test('a zero-stock first step and its revisions leave the epoch unanchored', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { output: 5 })]);
  assert.equal(engine.getBucketData().dead, 0);
  engine.ingest([step('m1', { output: 40 })]);
  assert.equal(engine.getBucketData().dead, 0);

  engine.ingest([step('m2', { input: 5, cacheRead: 40, cacheWrite: 10 })]);
  assert.equal(engine.getBucketData().dead, 55, 'dead anchors at the whole first-step stock: input + cacheRead + cacheWrite');
});

test('a step recorded before the settlement cursor exists carries no position, and the anchoring step is the first stamped', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { output: 5 }), stock('m2', 5000), stock('m3', 9000)]);
  const history = engine.getHistory();
  const [preAnchor, anchoring] = history;
  assert.equal(preAnchor.u, null, 'a frame priced against a zero baseline is not stamped at all');
  assert.equal(preAnchor.pp, null);
  assert.equal(preAnchor.bDefault, null);
  assert.ok(Number.isFinite(anchoring.u), 'the anchoring step is where the fold starts');
  assert.ok(history.slice(1).every(p => Number.isFinite(p.u)));
});

test('the first positive-stock step establishes settlement cursors, clears pre-cursor resource growth, and performs no settlement', () => {
  const engine = makeEngine();
  engine.ingest([effect([wholeContent('r1', 1000)], { spentTokens: 1000 })]);
  engine.ingest([stock('m1', 5000)]);

  assert.equal(engine.getStatus().g, G_FLOOR, 'the anchoring step runs no settlement');
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 6000, 'pre-cursor growth was never banked, so nothing is corrected out');

  const later = makeEngine();
  later.ingest([stock('m1', 5000), stock('m2', 9000)]);
  assert.notEqual(later.getStatus().g, G_FLOOR, 'each later accepted new step runs settlement once');
});

test('an accepted revision does not settle or move the settlement cursors', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 1000)]);
  engine.ingest([effect([wholeContent('r1', 500)], { spentTokens: 500 })]);
  engine.ingest([stock('m1', 1200)]);            // accepted revision: higher total, later L
  engine.ingest([stock('m2', 3000)]);

  // With the cursor left at L = totalStock = 1000 and resident total 1000, m2 sees ΔtotalStock 2000 and
  // Δresident 500, so g = 0.06·1500 + 0.94·100. A revision that had moved the cursor would feed 1800.
  assert.ok(Math.abs(engine.getStatus().g - 184) < 1e-9, `expected g ≈ 184, got ${engine.getStatus().g}`);
});

test('the next accepted new step consumes the per-resource delta map once', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([effect([wholeContent('r1', 1000)], { spentTokens: 1000 })]);
  engine.ingest([stock('m1', 10_000, { output: 5 })]);   // revision: must not consume the map
  engine.ingest([stock('m2', 10_000)]);                  // banks r1's 1000
  engine.ingest([effect([wholeContent('r2', 300)], { spentTokens: 300 })]);
  engine.ingest([stock('m3', 10_000)]);                  // banks r2's 300 only

  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 10_000, 'both banks are corrected out at close');
  assert.deepEqual(closed.paths, [], 'a stale delta map would spread r1 credit onto r2 and leave it resident');
});

test("[delta] accepted effects contribute every affected resource's positive growth to deferred settlement", () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  // a small initial effect, then a larger whole-content replacement of the same resource
  engine.ingest([effect([wholeContent('r1', 40)], { spentTokens: 40 })]);
  engine.ingest([effect([wholeContent('r1', 5000)], { spentTokens: 5000 })]);
  engine.ingest([residual('ls', 10)]);
  // the content parks in cacheWrite while B is credited: the ledger banks it, and the co-located
  // candidate sees no unplaced growth
  engine.ingest([step('m2', { cacheRead: 10_000, cacheWrite: 5_000 })]);

  assert.equal(residualTokens(engine, 'ls'), 0, 'the banked lag is not charged to a co-located residual');
  assert.equal(resourceTokens(engine, 'r1'), 5000, 'the resource retains the replacement payload');

  engine.ingest([residual('ls2', 10)]);
  // the prefix catches up: the ledger retires, stock does not move, no residual
  engine.ingest([step('m3', { cacheRead: 15_000 })]);

  assert.equal(residualTokens(engine, 'ls2'), 0, 'catch-up ΔL retires the ledger');
  assert.equal(resourceTokens(engine, 'r1'), 5000);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 15_000, 'a fully retired ledger corrects nothing at close');
});

test('every positively growing resource in a multi-resource effect enters settlement', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([effect([wholeContent('r1', 1000), wholeContent('r2', 1000)], { spentTokens: 2000 })]);
  engine.ingest([stock('m2', 10_000)]);
  let closed = engine.closeCurrentSegment().closedSegments[0];
  assert.equal(closed.metrics.bTotal, 10_000, 'both growths banked, so both are corrected out');
  assert.deepEqual(closed.paths, []);

  // a shrinking co-impact contributes nothing: only s2's growth can absorb the next surplus
  const mixed = makeEngine();
  mixed.ingest([stock('n1', 10_000)]);
  mixed.ingest([effect([wholeContent('s1', 2000)], { spentTokens: 2000 })]);
  mixed.ingest([stock('n2', 10_000)]);           // banks s1's 2000
  mixed.ingest([effect([wholeContent('s1', 1000), wholeContent('s2', 3000)], { spentTokens: 3000 })]);
  mixed.ingest([stock('n3', 10_000)]);           // Δresident 2000 banks against s2's growth alone
  closed = mixed.closeCurrentSegment().closedSegments[0];
  assert.deepEqual(closed.paths, [{ path: 's2', tokens: 1000 }]);
  assert.equal(closed.metrics.bTotal, 11_000);
});

test('phase lag banks and retires once, including same-step bank and retirement', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 20_000)]);
  engine.ingest([effect([wholeContent('a', 10_000)], { spentTokens: 10_000 })]);
  engine.ingest([residual('ls-a', 5)]);
  engine.ingest([stock('m2', 20_000, { cacheWrite: 10_000 })]);   // banks a; ΔL is 0
  assert.equal(residualTokens(engine, 'ls-a'), 0);

  engine.ingest([effect([wholeContent('b', 10_000)], { spentTokens: 10_000 })]);
  engine.ingest([residual('ls-b', 5)]);
  // same step: ΔL confirms a's batch while b's credit arrives
  engine.ingest([stock('m3', 30_000, { cacheWrite: 10_000 })]);
  assert.equal(residualTokens(engine, 'ls-b'), 0, 'same-step bank and retirement must not double-count ΔL');

  engine.ingest([residual('ls-c', 5)]);
  engine.ingest([stock('m4', 40_000)]);
  assert.equal(residualTokens(engine, 'ls-c'), 0);
  assert.equal(resourceTokens(engine, 'a'), 10_000);
  assert.equal(resourceTokens(engine, 'b'), 10_000);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 40_000, 'every bank retired, so close corrects nothing');
});

test('positive ΔL and ΔtotalStock count only growth above the session floor while the previous value sits below it', () => {
  const engine = makeEngine();
  engine.ingest([step('m1', { output: 5, cacheWrite: 44_000 })]);   // floor 44000, L 0
  engine.ingest([stock('m2', 44_000, { cacheWrite: 8000 })]);       // stock 52000, g hits the delta cap
  assert.equal(engine.getStatus().g, 350);
  engine.ingest([stock('m3', 43_000)]);                             // released cache write: stock falls below the floor
  assert.ok(Math.abs(engine.getStatus().g - 329) < 1e-9, `expected g ≈ 329, got ${engine.getStatus().g}`);

  engine.ingest([residual('ls', 1)]);
  engine.ingest([stock('m4', 46_000)]);
  // recovery counts 46000 − 44000, not 46000 − 43000: g = 0.06·2000 + 0.94·329
  assert.ok(Math.abs(engine.getStatus().g - 429.26) < 1e-9, `expected g ≈ 429.26, got ${engine.getStatus().g}`);
  assert.ok(Math.abs(residualTokens(engine, 'ls') - 2000) < 1e-9,
    `ΔL above the floor is 2000, got ${residualTokens(engine, 'ls')}`);
  assert.equal(engine.getStatus().segment, 0, 'a stock drop opens no epoch');
});

test('g receives max(0, ΔtotalStock − Δ uncapped resident total)', () => {
  const cacheWriteOnly = makeEngine();
  cacheWriteOnly.ingest([stock('m1', 10_000)]);
  cacheWriteOnly.ingest([stock('m2', 10_000, { cacheWrite: 5000 })]);
  // cacheRead is flat, so ΔL is 0 while ΔtotalStock is 5000: the step hits the delta cap
  assert.equal(cacheWriteOnly.getStatus().g, 350);

  const absorbed = makeEngine();
  absorbed.ingest([stock('m1', 10_000)]);
  absorbed.ingest([effect([wholeContent('r1', 5000)], { spentTokens: 5000 })]);
  absorbed.ingest([stock('m2', 10_000, { cacheWrite: 5000 })]);
  assert.equal(absorbed.getStatus().g, G_FLOOR, 'rebuildable growth is subtracted before g sees it');
});

// g measures the growth no resource accounts for, so it has to subtract the UNFILTERED resident total.
// Selection is a display and position-basis concern: a resource the user excluded is still resident in
// the model's context, so charging g for it would report growth that was in fact rebuildable.
test('g subtracts the unfiltered resident total, so an override cannot move it', () => {
  const build = () => {
    const engine = makeEngine();
    engine.ingest([stock('m1', 10_000)]);
    engine.ingest([effect([wholeContent('/r1', 5000)], { spentTokens: 5000 })]);
    return engine;
  };
  const plain = build();
  plain.ingest([stock('m2', 10_000, { cacheWrite: 5000 })]);

  const overridden = build();
  overridden.replaceResourceOverrides({ '/r1': 'exclude' });
  overridden.ingest([stock('m2', 10_000, { cacheWrite: 5000 })]);

  assert.equal(overridden.getBucketData().bDefault, overridden.getBucketData().dead,
    'precondition: the excluded resource left the selected basis');
  assert.ok(overridden.getBucketData().totalB > overridden.getBucketData().bDefault,
    'precondition: it is still resident in the unfiltered total');
  assert.equal(overridden.getStatus().g, plain.getStatus().g,
    'g is fed by the unfiltered resident total, not the selected basis');
  assert.equal(overridden.getStatus().g, G_FLOOR, 'and that growth was fully absorbed as rebuildable');
});

test('every named measurement read applies G_FLOOR', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([stock('m2', 10_000)]);   // zero g input drives the raw EMA below the floor

  assert.equal(engine.getStatus().g, G_FLOOR);
  assert.equal(engine.getStatus().rateLamp.gEma, G_FLOOR);
  assert.equal(engine.getHistory().at(-1).g, G_FLOOR);
  assert.equal(engine.readRateLampFrame(0).status.gEma, G_FLOOR);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.gFinal, G_FLOOR);
  assert.equal(closed.metrics.gMin, G_FLOOR);
});

test('cold start and successful epoch or explicit close seed the next segment at G_FLOOR', () => {
  const engine = makeEngine();
  assert.equal(engine.getStatus().g, G_FLOOR, 'cold start');

  engine.ingest([stock('m1', 10_000), stock('m2', 100_000)]);
  assert.ok(engine.getStatus().g > G_FLOOR);
  engine.ingest([{ type: 'epoch' }]);
  assert.equal(engine.getStatus().g, G_FLOOR, 'successful epoch');

  engine.ingest([stock('m3', 10_000), stock('m4', 100_000)]);
  assert.ok(engine.getStatus().g > G_FLOOR);
  engine.closeCurrentSegment();
  assert.equal(engine.getStatus().g, G_FLOOR, 'successful explicit close');
});

test('bucket data reports the belief uncapped before a positive-stock settlement cursor exists, and getStatus().B is the last step capped by the cursor stock', () => {
  const engine = makeEngine();
  engine.ingest([effect([wholeContent('r1', 5000)], { spentTokens: 5000 })]);
  assert.equal(engine.getBucketData().totalB, 5000, 'no cursor yet: the belief is reported uncapped');

  engine.ingest([stock('m1', 1000)]);
  assert.equal(engine.getStatus().B, 1000, 'min(uncapped resident total, cursor total stock)');
  assert.equal(engine.getBucketData().totalB, 1000);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 6000, 'the frozen segment total is the uncapped belief');
});

test('settlement banks the complete B surplus, leaving no per-resource attribution shortfall', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  // three resources touched by three effects inside one settlement interval
  engine.ingest([effect([wholeContent('r1', 900), wholeContent('r2', 100)], { spentTokens: 1000 })]);
  engine.ingest([effect([wholeContent('r1', 1100)], { spentTokens: 200 })]);
  engine.ingest([effect([wholeContent('r3', 4000)], { spentTokens: 4000 })]);
  engine.ingest([stock('m2', 10_000)]);

  // Σ banked === the whole B surplus: every resident token the interval added is corrected out at close.
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 10_000);
  assert.deepEqual(closed.paths, []);
});

test('close applies corrections before computing bTotal from the corrected uncapped resident total', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  engine.ingest([effect([wholeContent('r1', 4000)], { spentTokens: 4000 })]);
  engine.ingest([stock('m2', 12_000)]);   // ΔL 2000 retires half; 2000 stays banked

  assert.equal(engine.getStatus().B, 12_000, 'the live belief keeps its full credit');
  assert.equal(resourceTokens(engine, 'r1'), 4000);
  const [closed] = engine.closeCurrentSegment().closedSegments;
  assert.equal(closed.metrics.bTotal, 12_000, 'dead 10000 plus r1 corrected from 4000 down to 2000');
  assert.deepEqual(closed.paths, [{ path: 'r1', tokens: 2000 }]);
});

test('finalization failure leaves the open segment unchanged', () => {
  const engine = makeEngine();
  engine.ingest([stock('m1', 10_000)]);
  // metadata a Projection must supply as JSON-compatible data; a function cannot be detached
  engine.ingest([residual('ls', 1, { meta: { render: () => 'not data' } })]);
  engine.ingest([stock('m2', 12_000)]);

  const before = engine.getStatus();
  assert.throws(() => engine.closeCurrentSegment());
  const after = engine.getStatus();
  assert.equal(after.segment, before.segment, 'the segment did not advance');
  assert.equal(after.apiCalls, before.apiCalls);
  assert.equal(after.L, before.L);
  assert.equal(engine.ingest([stock('m3', 13_000)]).newCalls, 1, 'the open segment still accepts records');
});
