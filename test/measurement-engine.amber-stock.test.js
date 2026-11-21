import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { amberStockOf } from '../lib/measurement/position.js';
import { BR_AMBER } from '../lib/bill-regret.js';
import { thresholdLinesOf } from '../public/elements/historyChart.js';

// The amber exit of a closed segment, in stock units, on the segment's last history point: the segment's end
// fit read at the stock that point plots. The expectation is the chart's own conversion
// (`thresholdLinesOf` over the lamp the segment ended with), so nothing here restates its algebra.

const R = 10;
function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy: () => ({ cRatio: R, contextCapacity: 1_000_000 }),
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}
const usage = (cacheRead, input = 0, cacheWrite = 0) => ({ input, output: 1, cacheRead, cacheWrite });
const step = (id, use) => ({ type: 'step', id, model: 'model-a', timestamp: 1, usage: use });
const EPOCH = { type: 'epoch' };

// Cached reads whose growth carries the fold's u past 1 on the ninth step, a right-arm fit with a reference.
const LONG = [1000, 1600, 2300, 3100, 4000, 5000, 6100, 7300, 8600];
const steps = (reads, from = 0) => reads.map((cacheRead, index) => step(`s${from + index}`, usage(cacheRead)));
// The fit's reading of the segment that has just ended: the lamp the status carried before the epoch record closed it.
const lampOf = engine => engine.getStatus().rateLamp;
const exitOf = (lamp, anchor) => thresholdLinesOf(lamp, lamp.B_default, anchor).exit;
const keyOf = point => Object.hasOwn(point, 'amberStockL');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('the last point of a closed segment carries the fit\'s amber exit as the chart converts it, anchored at the stock that point plots', () => {
  const engine = makeEngine();
  engine.ingest(steps(LONG));
  const lamp = lampOf(engine);
  assert.equal(lamp.reference.provisional, false, 'precondition: a fit past the left arm');
  engine.ingest([EPOCH]);
  const history = engine.getHistory();
  const last = history.at(-1);
  assert.equal(last.amberStockL, exitOf(lamp, last.L));
  assert.ok(Number.isFinite(last.amberStockL));
  assert.ok(last.amberStockL > last.L, 'the segment never reached the line, and the fit that holds keeps it');
});

test('only the last point of the closed segment has the key: the open segment\'s points and the earlier points of the closed one have none', () => {
  const engine = makeEngine();
  engine.ingest(steps(LONG));
  assert.ok(engine.getHistory().every(point => !keyOf(point)), 'an open segment carries none');
  engine.ingest([EPOCH]);
  engine.ingest(steps([1000, 1500], 100));
  const history = engine.getHistory();
  assert.deepEqual(history.map(keyOf), [...LONG.slice(1).map(() => false), true, false, false]);
  assert.equal(history.length, LONG.length + 2);
});

test('the anchor is the stock the point plots: a last step that reports input beside its cache read moves the line by the stock\'s excess over the fixed L', () => {
  const engine = makeEngine();
  engine.ingest([...steps(LONG.slice(0, -1)), step('last', usage(8600, 700, 300))]);
  const lamp = lampOf(engine);
  const fixedL = engine.getStatus().L;
  engine.ingest([EPOCH]);
  const last = engine.getHistory().at(-1);
  assert.equal(fixedL, 8600, 'the measurement\'s L is the cache read');
  assert.equal(last.L, 9600, 'the plotted stock adds the uncached input and the cache write');
  assert.equal(last.amberStockL, exitOf(lamp, 9600));
  assert.notEqual(last.amberStockL, exitOf(lamp, fixedL));
  near(last.amberStockL - exitOf(lamp, fixedL), 1000);
});

test('a last step that missed the cache anchors at its stock, not at the cache read it reports', () => {
  const engine = makeEngine();
  engine.ingest([...steps(LONG.slice(0, -1)), step('missed', usage(100, 9000))]);
  assert.equal(engine.getHistory().at(-1).miss, true, 'precondition: the step is a miss');
  const lamp = lampOf(engine);
  engine.ingest([EPOCH]);
  const last = engine.getHistory().at(-1);
  assert.equal(last.L, 9100);
  assert.equal(last.amberStockL, exitOf(lamp, 9100));
  assert.notEqual(last.amberStockL, exitOf(lamp, 100));
});

test('a value is not moved by later segments: more calls and more closes leave it and every earlier point as they were, and each later segment carries its own', () => {
  const engine = makeEngine();
  engine.ingest(steps(LONG));
  engine.ingest([EPOCH]);
  const closed = engine.getHistory();
  engine.ingest(steps(LONG.map(read => read + 500), 100));
  const second = lampOf(engine);
  engine.ingest([EPOCH]);
  engine.ingest(steps([1000, 1500, 2000], 200));
  const history = engine.getHistory();
  assert.deepEqual(history.slice(0, closed.length), closed);
  const secondLast = history[closed.length + LONG.length - 1];
  assert.equal(secondLast.segment, 1);
  assert.equal(secondLast.amberStockL, exitOf(second, secondLast.L));
  assert.notEqual(secondLast.amberStockL, closed.at(-1).amberStockL);
  assert.deepEqual(history.slice(closed.length + LONG.length).map(keyOf), [false, false, false]);
});

test('a second Engine fed the same records gives the same value, whether the segment is closed by an epoch record or by closeCurrentSegment', () => {
  const records = steps(LONG);
  const byEpoch = makeEngine();
  byEpoch.ingest([...records, EPOCH]);
  const again = makeEngine();
  again.ingest([...records, EPOCH]);
  const byClose = makeEngine();
  byClose.ingest(records);
  byClose.closeCurrentSegment();
  assert.deepEqual(again.getHistory(), byEpoch.getHistory());
  assert.deepEqual(byClose.getHistory(), byEpoch.getHistory());
  assert.ok(Number.isFinite(byClose.getHistory().at(-1).amberStockL));
});

test('a closed segment whose last point already stands past the amber line keeps the line, which lies below that stock', () => {
  const engine = makeEngine();
  engine.ingest(steps([...LONG, 14000, 22000, 32000, 45000, 60000]));
  const lamp = lampOf(engine);
  assert.equal(lamp.reference.provisional, false, 'precondition: a fit past the left arm');
  assert.ok(lamp.br >= BR_AMBER, 'precondition: the segment has reached the amber level');
  engine.ingest([EPOCH]);
  const last = engine.getHistory().at(-1);
  assert.equal(last.amberStockL, exitOf(lamp, last.L));
  assert.ok(last.amberStockL < last.L);
});

test('a segment that ends on the left arm carries null on its last point: the line it would draw is provisional', () => {
  const engine = makeEngine();
  engine.ingest(steps(LONG.slice(0, 5)));
  const lamp = lampOf(engine);
  assert.equal(lamp.reference.provisional, true, 'precondition: u is below one');
  assert.ok(Number.isFinite(exitOf(lamp, 4000)), 'the chart would draw it');
  engine.ingest([EPOCH]);
  const last = engine.getHistory().at(-1);
  assert.equal(last.amberStockL, null);
  assert.ok(keyOf(last));
});

test('a segment whose fit is unavailable carries null: no reference to read, or a last call with no stock of its own', () => {
  const noFit = makeEngine();
  noFit.ingest(steps([1000, 1500, 2000]));
  assert.equal(lampOf(noFit).reference, null, 'precondition: one distinct u is no fit');
  noFit.ingest([EPOCH]);
  assert.equal(noFit.getHistory().at(-1).amberStockL, null);

  const tail = makeEngine();
  tail.ingest([...steps(LONG), step('z', usage(0))]);
  assert.equal(lampOf(tail).reliable, false, 'precondition: a stockless tail step takes the read away');
  tail.ingest([EPOCH]);
  const history = tail.getHistory();
  assert.equal(history.at(-1).amberStockL, null);
  assert.deepEqual(history.map(keyOf), [...LONG.map(() => false), true]);
});

test('a segment with no calls closes without a point, and an epoch record after it annotates nothing', () => {
  const engine = makeEngine();
  engine.ingest([EPOCH, ...steps(LONG), EPOCH, EPOCH]);
  const history = engine.getHistory();
  assert.equal(history.length, LONG.length);
  assert.equal(history.filter(keyOf).length, 1);
});

test('amberStockOf reads the amber landmark at the anchor along the reference skeleton and refuses what cannot be read', () => {
  const reference = { a: 3.1, d: 0.7 };
  const source = { reference, u: 1.4, xBrAmberR: 6, bDefault: 75595 };
  assert.equal(amberStockOf(source, 425969), 425969 + 75595 * (6 - (3.1 + 0.7 * 1.4)));
  assert.equal(amberStockOf({ ...source, xBrAmberR: reference.a + reference.d * 1.4 }, 425969), 425969, 'a landmark at the current position is the anchor itself');
  for (const [why, over] of [
    ['no reference', { reference: null }],
    ['an absent reference', { reference: undefined }],
    ['a zero basis', { bDefault: 0 }],
    ['a negative basis', { bDefault: -1 }],
    ['an unbounded basis', { bDefault: Infinity }],
    ['a missing basis', { bDefault: undefined }],
    ['no landmark', { xBrAmberR: null }],
    ['a landmark that is no number', { xBrAmberR: Number.NaN }],
    ['no position', { u: null }],
    ['a position that is no number', { u: Number.NaN }],
  ]) assert.equal(amberStockOf({ ...source, ...over }, 425969), null, why);
});
