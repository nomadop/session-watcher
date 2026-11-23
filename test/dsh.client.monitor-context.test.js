// The context page of the settlement drawer: its display model, `monitor-context-model.js` (the series of the cleared segment's calls aligned with the compactions, the line from the session's history, the stock chart's geometry and texts, the cache section's arithmetic and the view state), and its view, `monitor-context.js`.
// The fixtures are written by hand to the shape the host's `inner-monitor/settlement` endpoint answers and `settlementsOf` gives; the arithmetic of the cache section is checked against figures worked out by hand from the mockup's `cacheModel`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  amberLineOf, seriesOf, crossingsOf, stockScaleOf, stockGeometryOf, callAtX, cursorOf, nearestDrawn, cursorKeyAt, sealStepAt, readoutOf,
  cacheOf, netAt, crossingShareOf, lamGeometryOf, shareReadoutOf, contextPageOf, createContextState, reduceContext, isFoldOpen,
} from '../dsh/src/client/monitor-context-model.js';
import { ContextView, ContextPage } from '../dsh/src/client/monitor-context.js';
import { en, zh } from '../dsh/src/client/locales.js';
import { DEFAULT_CHART_WIDTH } from '../dsh/src/client/monitor-state.js';

const localized = dictionary => (key, params) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]));
const t = localized(zh);

/** A compaction of a settlement as `settlementsOf` has it, with the fields the page reads: its ordinal, its figures where it has them, its rebuild and the context it cut. */
const row = (ordinal, { saved = null, cost = null, rebuild = null, cut = null } = {}) => ({
  id: ordinal, ordinal, saved, cost, before: cut === null ? null : 10_000, after: cut === null ? null : 10_000 - cut, cut, follow: 0, sealAt: 0, costRebuild: rebuild, needed: null, gap: null,
});
const call = (seq, stock, post = false) => ({ seq, stock, post });

// Three compactions, the second without figures but with a cut and the third (its ordinal skips the third) with neither, over eight calls of which the fourth and the seventh report no usage and the seventh is the third compaction's first call after its carrier.
const ROWS = [row(1, { saved: 900, cost: 300, rebuild: 100, cut: 100 }), row(2, { cut: 50 }), row(4)];
const CALLS = [call(10, 1000), call(11, 1100, true), call(12, 1200), call(13, null), call(14, 1300, true), call(15, 1400), call(16, null, true), call(17, 1500)];

// ── The series ───────────────────────────────────────────────────────────────

test('the series numbers every call, null-stock ones included, and sets the n-th mark on the n-th row by the order of the rows, whatever their ordinals', () => {
  const series = seriesOf(ROWS, CALLS);
  assert.equal(series.count, 8);
  assert.deepEqual(series.calls.map(each => each.at), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(series.calls.map(each => each.ordinal), [null, 1, null, null, 2, null, 4, null]);
  assert.deepEqual(series.calls.map(each => each.seq), [10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(series.drawn.map(each => each.at), [1, 2, 3, 5, 6, 8], 'a call that reported no usage is on the axis and not drawn');
  assert.deepEqual(series.seals, [{ ordinal: 1, at: 2, land: 2 }, { ordinal: 2, at: 5, land: 5 }, { ordinal: 4, at: 7, land: 8 }], 'a compaction whose first call reported no stock still has its seal there, and its jump lands on the next call drawn');
  assert.equal(series.peak.at, 8);
});

test('the marks and the rows align only when they are as many: another count leaves no series, and so does a series that draws no call', () => {
  assert.equal(seriesOf(ROWS, CALLS.slice(0, 5)), null, 'fewer marks than rows');
  assert.equal(seriesOf(ROWS, [...CALLS, call(18, 1600, true)]), null, 'more marks than rows');
  assert.equal(seriesOf(ROWS, []), null, 'no call');
  assert.equal(seriesOf(ROWS.slice(0, 2), CALLS.slice(0, 5)) !== null, true, 'as many marks as rows');
  assert.equal(seriesOf([row(1, { cut: 5 })], [call(1, null, true), call(2, null)]), null, 'no call with a stock to draw');
});

test('the stock the segment would have had uncompressed is the call\'s stock and the cut of every compaction with a known cut so far, those with no figures included, a cut that is not positive adding none', () => {
  const series = seriesOf(ROWS, CALLS);
  assert.deepEqual(series.calls.map(each => each.uncompressed), [1000, 1200, 1300, null, 1450, 1550, null, 1650], 'the second compaction has no figures and its cut of 50 counts from its call; the third has no cut and adds none');
  const shrunk = seriesOf([row(1, { cut: -400 }), row(2, { cut: 0 })], [call(1, 900), call(2, 800, true), call(3, 700, true), call(4, 600)]);
  assert.deepEqual(shrunk.calls.map(each => each.uncompressed), [900, 800, 700, 600], 'a compaction that grew the context adds nothing');
  assert.deepEqual(seriesOf([row(1, { cut: 70 })], [call(1, 500), call(2, 500, true)]).calls.map(each => each.uncompressed), [500, 570], 'it accrues from the call after the carrier itself');
});

test('a mark whose call reports no stock still accrues its cut for the calls after it', () => {
  const series = seriesOf([row(1, { cut: 300 })], [call(1, 100), call(2, null, true), call(3, 120)]);
  assert.deepEqual(series.calls.map(each => each.uncompressed), [100, null, 420]);
});

// ── The line, from the history ───────────────────────────────────────────────

const live = history => ({ kind: 'live', snapshot: { history } });
const point = (segment, extra = {}) => ({ segment, L: 1000, ...extra });

test('the line is the amber stock of the point of the cleared segment, which the history marks by one fewer than the settlement\'s epoch, wherever in the history that point stands', () => {
  const history = [point(0), point(1, { amberStockL: 4321.5 }), point(1), point(2)];
  assert.equal(amberLineOf(live(history), 2), 4321.5, 'the point is not the last of the history, and not the last of the segment');
  assert.equal(amberLineOf(live([point(2, { amberStockL: 77 }), point(0, { amberStockL: 88 }), point(1, { amberStockL: 99 })]), 2), 99, 'the points of other segments carry theirs');
  assert.equal(amberLineOf(live([point(0, { amberStockL: 88 })]), 1), 88, 'the first segment is epoch 1');
  assert.equal(amberLineOf(live([point(1, { amberStockL: 99 })]), 1), null, 'epoch 1 is segment 0');
});

test('there is no line where the point has none, holds null, is absent, or the history or the live answer is', () => {
  assert.equal(amberLineOf(live([point(1, { amberStockL: null })]), 2), null, 'the Engine\'s fit did not hold');
  assert.equal(amberLineOf(live([point(1)]), 2), null, 'the key is not on the point');
  assert.equal(amberLineOf(live([point(1, { amberStockL: undefined })]), 2), null, 'the key holds nothing');
  assert.equal(amberLineOf(live([point(3, { amberStockL: 5 })]), 2), null, 'no point of the segment');
  assert.equal(amberLineOf(live([]), 2), null);
  assert.equal(amberLineOf({ kind: 'live', snapshot: {} }, 2), null, 'no history');
  assert.equal(amberLineOf({ kind: 'live', snapshot: { history: null } }, 2), null);
  assert.equal(amberLineOf({ kind: 'live', snapshot: { history: [point(1, { amberStockL: Number.NaN })] } }, 2), null);
  assert.equal(amberLineOf(null, 2), null, 'no answer yet');
  assert.equal(amberLineOf({ kind: 'state', state: 'bootstrapping' }, 2), null);
  assert.equal(amberLineOf({ kind: 'unreachable', message: 'x' }, 2), null);
  assert.equal(amberLineOf({ kind: 'state', snapshot: { history: [point(1, { amberStockL: 5 })] } }, 2), null, 'only a live answer is read');
});

test('the line is read from the point that has the key, not from the first point of the segment that has none', () => {
  const history = [point(1), point(1, { amberStockL: 6000 })];
  assert.equal(amberLineOf(live(history), 2), 6000);
});

// ── The crossings and the scale ──────────────────────────────────────────────

test('the actual stock crosses the line at the first call drawn over it and the uncompressed stock at the first whose uncompressed stock is over it, each strictly over, and a call without a stock crosses nowhere', () => {
  const series = seriesOf(ROWS, CALLS);
  const at = crossing => crossing?.at ?? null;
  assert.deepEqual([at(crossingsOf(series, 1450).uncompressed), at(crossingsOf(series, 1450).actual)], [6, 8], 'the uncompressed stock of the fifth call equals the line and is not over it');
  assert.deepEqual([at(crossingsOf(series, 1500).uncompressed), at(crossingsOf(series, 1500).actual)], [6, null], 'the stock the actual line reaches is the line itself');
  assert.deepEqual([at(crossingsOf(series, 1499).uncompressed), at(crossingsOf(series, 1499).actual)], [6, 8]);
  assert.deepEqual([at(crossingsOf(series, 1100).uncompressed), at(crossingsOf(series, 1100).actual)], [2, 3], 'at 1100 the second call\'s actual stock is on the line');
  assert.deepEqual(crossingsOf(series, null), { uncompressed: null, actual: null });
  const gap = seriesOf([row(1, { cut: 9000 })], [call(1, 100), call(2, null, true), call(3, 100)]);
  assert.equal(crossingsOf(gap, 5000).uncompressed.at, 3, 'the call that reported nothing is passed over');
});

test('the scale ignores the uncompressed peak and leaves room above the actual peak', () => {
  const series = seriesOf([row(1, { cut: 5000 })], [call(1, 1000), call(2, 1000, true)]);
  assert.deepEqual(stockScaleOf(series), { step: 500, top: 1500, ticks: [0, 500, 1000, 1500] });
  const flat = seriesOf([row(1, { cut: 0 })], [call(1, 0), call(2, 0, true)]);
  assert.equal(stockScaleOf(flat).top > 0, true, 'a segment that never reported a stock above zero still has a scale');
  const hair = seriesOf([row(1, { cut: 0 })], [call(1, 18867.924528320757), call(2, 18867.924528320757, true)]);
  assert.deepEqual(stockScaleOf(hair), { step: 5000, top: 20000, ticks: [0, 5000, 10000, 15000, 20000] }, 'a fourth of the room is a round step and a hair over, which the step still reaches');
});

// ── The geometry ─────────────────────────────────────────────────────────────

const SCALE_ROWS = [row(1, { cut: 250 }), row(2, { cut: 500 })];
const SCALE_CALLS = [call(1, 1000), call(2, 1000, true), call(3, 1000), call(4, 1000, true), call(5, 1000)];
const geometryOf = (line, width = 392, rows = SCALE_ROWS, calls = SCALE_CALLS, translate = t) => stockGeometryOf(seriesOf(rows, calls), line, width, translate);

test('the chart rings the calls of the chosen target\'s reads where it draws them, and none for a call it has no point of', () => {
  const g = stockGeometryOf(seriesOf(SCALE_ROWS, SCALE_CALLS), null, 392, t, [2, 5, 9]);
  assert.deepEqual(g.rings.map(({ at, x, y }) => [at, x, y]), [[2, 125.5, 74], [5, 382, 74]], 'a read of no call of the chart is no ring');
  assert.deepEqual(stockGeometryOf(seriesOf(SCALE_ROWS, SCALE_CALLS), null, 392, t).rings, [], 'none chosen, none ringed');
  const silent = stockGeometryOf(seriesOf([row(1, { cut: 5 })], [call(1, 1000), call(2, null, true), call(3, 1200)]), null, 392, t, [2]);
  assert.deepEqual(silent.rings, [], 'a call that reports no stock has no point');
});

test('the stock chart puts the calls evenly over the plot and the stock by its share of the top, from the plot\'s foot', () => {
  const g = geometryOf(1200);
  assert.deepEqual([g.width, g.height, g.left, g.plotWidth, g.plotTop, g.plotHeight], [392, 224, 40, 342, 14, 180]);
  assert.deepEqual(g.ticks, [
    { value: 0, label: '0', y: 194 }, { value: 500, label: '500', y: 134 },
    { value: 1000, label: '1.0k', y: 74 }, { value: 1500, label: '1.5k', y: 14 },
  ]);
  assert.equal(g.actual, 'M40.0,74.0 L125.5,74.0 L211.0,74.0 L296.5,74.0 L382.0,74.0');
  assert.equal(g.uncompressed, 'M40.0,74.0 L125.5,44.0 L211.0,44.0 L296.5,-16.0 L382.0,-16.0');
  assert.deepEqual(g.seals.map(seal => [seal.at, seal.x, seal.ordinal]), [[2, 125.5, 1], [4, 296.5, 2]]);
  assert.deepEqual(g.line, { y: 50, label: { text: '渐深线 1.2k', x: 44, y: 63, anchor: 'start' } });
  assert.deepEqual(g.uncompressedCross, { at: 2, x: 125.5, y: 44, d: 'M125.5,39 L130.5,44 L125.5,49 L120.5,44 Z', label: { text: '未压缩：第 2 次越线', x: 133.5, y: 37, anchor: 'start' } });
  assert.equal(g.actualCross, null);
  assert.equal(g.axisPath, 'M40,14 V194 H382');
  assert.deepEqual(g.hit, { x: 40, y: 14, width: 342, height: 166 });
  assert.deepEqual(g.points.map(each => [each.at, each.x, each.y, each.uncompressedY]), [[1, 40, 74, 74], [2, 125.5, 74, 44], [3, 211, 74, 44], [4, 296.5, 74, -16], [5, 382, 74, -16]]);
});

test('the plot is taller as the chart is wider, and the narrowest plot keeps its width at least', () => {
  assert.deepEqual([300, 392, 700].map(width => geometryOf(1200, width).plotHeight), [150, 180, 210]);
  assert.deepEqual([300, 392, 700].map(width => geometryOf(1200, width).plotWidth), [250, 342, 650]);
  assert.deepEqual([339, 340, 599, 600].map(width => geometryOf(null, width).plotHeight), [150, 180, 180, 210]);
  const narrow = geometryOf(1200, 100);
  assert.equal(narrow.plotWidth, 150);
  assert.equal(narrow.width, 200, 'the picture is as wide as its plot and margins need');
});

test('the steps along the axis are at a round number of calls, one call apart where there are few, and the unit stands at the plot\'s right foot', () => {
  const ticksOf = count => geometryOf(null, 392, [row(1, { cut: 1 })], Array.from({ length: count }, (_, at) => call(at + 1, 1000 + at, at === 1))).xTicks.map(tick => tick.label);
  assert.deepEqual(ticksOf(5), ['1', '2', '3', '4', '5']);
  assert.deepEqual(ticksOf(2), ['1', '2'], 'never a fraction of a call');
  assert.deepEqual(ticksOf(20), ['5', '10', '15', '20']);
  assert.deepEqual(ticksOf(143), ['50', '100']);
  assert.deepEqual(ticksOf(449), ['100', '200', '300', '400']);
  assert.deepEqual(ticksOf(62), ['10', '20', '30', '40', '50', '60'], 'six steps of ten, not three of twenty: the axis aims at seven marks');
  const g = geometryOf(null);
  assert.deepEqual(g.xUnit, { x: 382, y: 219, text: '第 N 次调用 →' });
  assert.deepEqual(g.xTicks.slice(0, 2), [{ x: 40, label: '1' }, { x: 125.5, label: '2' }]);
});

test('a label flips to the other side of its point where it would leave the plot, the estimate of its width counting a wide character wider', () => {
  const near = geometryOf(1200);
  assert.equal(near.uncompressedCross.label.anchor, 'start');
  const edge = geometryOf(1200, 392, [row(1, { cut: 250 })], [call(1, 1000), call(2, 1000), call(3, 1000, true)]);
  assert.equal(edge.uncompressedCross.x, 382);
  assert.deepEqual([edge.uncompressedCross.label.anchor, edge.uncompressedCross.label.x], ['end', 390], 'it would run to 497 from 390, so it ends at the point and 8 off it');
  const first = geometryOf(500, 392, [row(1, { cut: 5000 })], [call(1, 800, true), call(2, 800), call(3, 400)]);
  assert.equal(first.actualCross.at, 1);
  assert.deepEqual([first.actualCross.label.anchor, first.actualCross.label.x], ['start', 34], 'ending at 34 it would start left of the plot');
  const wide = geometryOf(1200, 392, [row(1, { cut: 250 })], [call(1, 1000), call(2, 1000), call(3, 1000), call(4, 1000, true), call(5, 1000)]);
  assert.deepEqual([wide.uncompressedCross.x, wide.uncompressedCross.label.x, wide.uncompressedCross.label.anchor], [296.5, 304.5, 'end'], 'its text would run to 411 counting its ideographs at their own width, and to 373 counting them as narrow');
  const ascii = geometryOf(1200, 392, [row(1, { cut: 250 })], [call(1, 1000), call(2, 1000), call(3, 1000, true)], localized(en));
  assert.equal(ascii.uncompressedCross.label.anchor, 'end');
});

test('an absent or off-scale deepening line does not change the scale and has no plotted annotations', () => {
  const g = geometryOf(null);
  assert.equal(g.line, null);
  assert.equal(g.uncompressedCross, null);
  assert.equal(g.actualCross, null);
  assert.equal(g.ticks.at(-1).value, 1500);
  assert.deepEqual(geometryOf(1600), g, 'the off-scale line has no effect on the plot');
  assert.equal(geometryOf(1300).uncompressedCross, null, 'the crossing call is above the plot even though the threshold is in range');
  const numbers = JSON.stringify(g);
  assert.equal(/NaN|Infinity|null,null/.test(numbers), false);
});

test('the actual line crosses the line where the stock goes over it and the crossing is marked and named there', () => {
  const g = geometryOf(950, 392, [row(1, { cut: 100 })], [call(1, 900), call(2, 900, true), call(3, 1000)]);
  assert.equal(g.uncompressedCross.at, 2);
  assert.equal(g.actualCross.at, 3);
  assert.equal(g.actualCross.label.text, '实际：第 3 次越线');
  assert.equal(g.actualCross.label.anchor, 'end');
  assert.deepEqual(g.actualCross.label.x, g.actualCross.x - 6);
});

test('calls that report no stock are not drawn: the lines pass over them and the cursor has no point there', () => {
  const g = stockGeometryOf(seriesOf(ROWS, CALLS), null, 392, t);
  assert.deepEqual(g.points.map(each => each.at), [1, 2, 3, 5, 6, 8]);
  assert.equal(g.actual.split(' L').length, 6);
  assert.equal(g.seals.some(seal => seal.at === 7), true, 'the seal of a null-stock call is on the axis at its call');
  assert.equal(g.seals.find(seal => seal.at === 7).x, 333.1);
});

// ── The cursor ───────────────────────────────────────────────────────────────

test('the pointer is at the call nearest its place on the plot, and at the nearest call drawn where that one reports no stock', () => {
  const series = seriesOf(ROWS, CALLS);
  const g = stockGeometryOf(series, null, 392, t);
  const stepX = 342 / 7;
  assert.equal(callAtX(g, series, 40), 1);
  assert.equal(callAtX(g, series, 40 + 2 * stepX), 3);
  assert.equal(callAtX(g, series, 40 + 3 * stepX + 1), 3, 'the fourth call is none: the nearest drawn is the third, before it');
  assert.equal(callAtX(g, series, 40 + 3 * stepX - 1), 3);
  assert.equal(callAtX(g, series, 40 + 3.8 * stepX), 5, 'a place nearer the fifth');
  assert.equal(callAtX(g, series, 40 + 6 * stepX), 6, 'the seventh is none; the sixth and the eighth are as near and the earlier wins');
  assert.equal(callAtX(g, series, -50), 1);
  assert.equal(callAtX(g, series, 9999), 8);
  assert.equal(nearestDrawn(series, 4), 3);
  assert.equal(nearestDrawn(series, 7), 6);
  assert.equal(nearestDrawn(series, 8), 8);
  const single = seriesOf([row(1, { cut: 1 })], [call(1, 100, true)]);
  assert.equal(callAtX(stockGeometryOf(single, null, 392, t), single, 200), 1);
});

test('the keys move the cursor over the drawn calls: one at a time, ten with shift, to either end, and by the compactions, none moving it past an end', () => {
  const series = seriesOf(ROWS, CALLS);
  const key = (cursor, name, shift = false) => cursorKeyAt(series, cursor, name, shift);
  assert.equal(key(1, 'ArrowRight'), 2);
  assert.equal(key(3, 'ArrowRight'), 5, 'the fourth call is passed over');
  assert.equal(key(5, 'ArrowLeft'), 3);
  assert.equal(key(1, 'ArrowLeft'), 1);
  assert.equal(key(8, 'ArrowRight'), 8);
  assert.equal(key(1, 'ArrowRight', true), 8, 'ten drawn calls on, clamped to the last');
  assert.equal(key(8, 'ArrowLeft', true), 1);
  assert.equal(key(3, 'Home'), 1);
  assert.equal(key(3, 'End'), 8);
  assert.equal(key(null, 'ArrowRight'), 1, 'with no cursor yet the first key puts it on the first call');
  assert.equal(key(null, 'ArrowLeft'), 1);
  assert.equal(key(1, 'PageDown'), 2);
  assert.equal(key(2, 'PageUp'), 8, 'before the first seal it wraps to the last, whose first call after it reported nothing');
  assert.equal(key(1, 'a'), null, 'any other key is not the cursor\'s');
  assert.equal(key(1, 'Tab'), null);
  const long = seriesOf([row(1, { cut: 1 })], Array.from({ length: 25 }, (_, at) => call(at + 1, at === 2 ? null : 1000 + at, at === 6)));
  const far = (cursor, name, shift) => cursorKeyAt(long, cursor, name, shift);
  assert.equal(far(1, 'ArrowRight', true), 12, 'ten drawn calls on, the one that reported nothing not counted');
  assert.equal(far(13, 'ArrowLeft', true), 2, 'ten drawn calls back, over the one that reported nothing');
  assert.equal(far(1, 'ArrowRight', false), 2);
  assert.equal(far(25, 'ArrowLeft', true), 15);
  assert.equal(far(20, 'ArrowRight', true), 25, 'clamped to the last');
});

test('the compactions are stepped to from the call the readout shows, which a hover sets over the cursor, and from the cursor where nothing is shown apart from it', () => {
  const series = seriesOf(ROWS, CALLS);
  const page = (cursor, name, shown) => cursorKeyAt(series, cursor, name, false, shown);
  assert.equal(page(1, 'PageDown', 5), 8, 'from the shown call 5, past the seal that lands on it, not from the cursor');
  assert.equal(page(1, 'PageDown', 1), 2);
  assert.equal(page(1, 'PageDown', undefined), 2, 'with nothing else shown, from the cursor');
  assert.equal(page(1, 'PageUp', 6), 5, 'from the shown call 6, back to the seal before it, not from the cursor');
  assert.equal(page(1, 'PageUp', undefined), 8, 'from the cursor, which no seal is before: round to the last');
  assert.equal(page(8, 'PageDown', 3), 5);
  assert.equal(page(3, 'PageUp', 8), 5);
  assert.equal(cursorKeyAt(series, null, 'PageDown', false, 5), 8, 'a hover shows a call before any cursor is placed');
  assert.equal(page(8, 'ArrowRight', 3), 8, 'the arrows keep to the cursor');
});

test('a jump to the next or previous compaction goes by the call each lands on, wraps round and starts at the ends with no cursor', () => {
  const series = seriesOf(ROWS, CALLS);
  const step = (current, direction) => sealStepAt(series, current, direction);
  assert.deepEqual([null, 1, 2, 3, 5, 8].map(current => step(current, 1)), [2, 2, 5, 5, 8, 2]);
  assert.deepEqual([null, 1, 2, 5, 6, 8].map(current => step(current, -1)), [8, 8, 8, 2, 5, 5]);
  assert.equal(step(8, -1), 5, 'a cursor on a landing is past that seal, not on it');
  assert.equal(step(8, 1), 2);
});

test('the cursor marks both curves where visible, including beyond the crossing, and omits the off-scale point', () => {
  const g = geometryOf(1200);
  assert.deepEqual(cursorOf(g, 1), { x: 40, y: 74, uncompressedY: 74 });
  assert.deepEqual(cursorOf(g, 2), { x: 125.5, y: 74, uncompressedY: 44 });
  assert.deepEqual(cursorOf(g, 3), { x: 211, y: 74, uncompressedY: 44 });
  assert.deepEqual(cursorOf(g, 4), { x: 296.5, y: 74, uncompressedY: null });
  assert.equal(cursorOf(g, null), null);
  const edge = geometryOf(null, 392, [row(1, { cut: 5001 })], [call(1, 10000), call(2, 9999, true), call(3, 10000)]);
  assert.equal(cursorOf(edge, 2).uncompressedY, edge.plotTop, 'a point on the axis limit is visible');
  assert.equal(cursorOf(edge, 3).uncompressedY, null, 'a point above the axis limit stays off-scale even if its pixel rounds to the edge');
});

test('the readout identifies the call and gives both stocks, including past the crossing, and the deepening line if present', () => {
  const series = seriesOf(ROWS, CALLS);
  assert.equal(readoutOf(series, 1450, null, t), null);
  assert.deepEqual(readoutOf(series, 1450, 5, t), ['第 5/8 次调用 · seq 14 · 压缩 #2 后首次', '实际 1,300 · 未压缩 1,450 · 渐深线 1,450']);
  assert.deepEqual(readoutOf(series, 1450, 8, t), ['第 8/8 次调用 · seq 17', '实际 1,500 · 未压缩 1,650 · 渐深线 1,450']);
  assert.deepEqual(readoutOf(series, null, 8, t), ['第 8/8 次调用 · seq 17', '实际 1,500 · 未压缩 1,650']);
  assert.deepEqual(readoutOf(series, 1450, 6, t), ['第 6/8 次调用 · seq 15', '实际 1,400 · 未压缩 1,550 · 渐深线 1,450']);
  assert.deepEqual(readoutOf(series, 1450, 2, localized(en)), ['Call 2/8 · seq 11 · first after compaction #1', 'Actual 1,100 · Uncompressed 1,200 · Deepening line 1,450']);
});

// ── The cache section ────────────────────────────────────────────────────────

// Two compactions with figures and one without: saved 1500 at cost 1000, 500 of it the cache rebuild, so the net is +500 with the rebuild counted in full and +1000 with it not counted.
const CACHE_ROWS = [row(1, { saved: 1000, cost: 300, rebuild: 100, cut: 10 }), row(2, { saved: 500, cost: 700, rebuild: 400, cut: 10 }), row(3, { cut: 10 })];
// The rebuild turns a net of +520 into −400: saved 1200 at cost 1600, 920 of it the rebuild.
const FLIPPING_ROWS = [row(1, { saved: 1000, cost: 1500, rebuild: 900, cut: 1 }), row(2, { saved: 200, cost: 100, rebuild: 20, cut: 1 })];

test('the sums are over the compactions with figures, the net at none of the rebuild extra is saved less the summary parts and at all of it less the rebuild too', () => {
  const cache = cacheOf(CACHE_ROWS);
  assert.deepEqual([cache.rebuild, cache.net0, cache.net1], [500, 1000, 500]);
  assert.deepEqual(cache.rows.map(each => [each.ordinal, each.known, each.rebuild, each.share]), [[2, true, 400, 0.8], [1, true, 100, 0.2], [3, false, null, null]], 'by the rebuild, the greatest first, those without figures last and out of the shares');
  assert.equal(cache.max, 400);
  const flipping = cacheOf(FLIPPING_ROWS);
  assert.deepEqual([flipping.rebuild, flipping.net0, flipping.net1], [920, 520, -400]);
});

test('equal rebuilds keep the order of the compactions and every share of the rebuild adds up to the whole', () => {
  const cache = cacheOf([row(1, { saved: 50, cost: 20, rebuild: 10, cut: 1 }), row(2, { saved: 50, cost: 20, rebuild: 10, cut: 1 }), row(3, { saved: 50, cost: 30, rebuild: 10, cut: 1 })]);
  assert.deepEqual(cache.rows.map(each => each.ordinal), [1, 2, 3]);
  assert.equal(Math.abs(cache.rows.reduce((sum, each) => sum + each.share, 0) - 1) < 1e-12, true);
});

test('the net at a share of the rebuild extra is the net with none of it less that share of the rebuild', () => {
  const cache = cacheOf(CACHE_ROWS);
  assert.equal(netAt(cache, 0), 1000);
  assert.equal(netAt(cache, 1), 500);
  assert.equal(netAt(cache, 0.4), 800);
  assert.equal(netAt(cache, 0.25), 875);
  const total = cacheOf(FLIPPING_ROWS);
  assert.equal(netAt(total, 1), 1200 - 1600, 'the settlement\'s own net');
});

test('the break-even share exists only where the net is positive without the rebuild extra and negative with all of it', () => {
  const share = rows => crossingShareOf(cacheOf(rows));
  assert.equal(Math.abs(share(FLIPPING_ROWS) - 520 / 920) < 1e-12, true);
  assert.equal(share(CACHE_ROWS), null, 'positive with all of it');
  assert.equal(share([row(1, { saved: 100, cost: 300, rebuild: 100, cut: 1 })]), null, 'negative with none of it: not a crossing of the rebuild');
  assert.equal(share([row(1, { saved: 200, cost: 300, rebuild: 100, cut: 1 })]), null, 'zero without the extra');
  assert.equal(share([row(1, { saved: 300, cost: 300, rebuild: 100, cut: 1 })]), null, 'zero with all of it, not under it');
  assert.equal(share([row(1, { saved: 299, cost: 300, rebuild: 100, cut: 1 })]) !== null, true, 'just under zero');
  assert.equal(share([row(1, { saved: 500, cost: 300, rebuild: 0, cut: 1 })]), null, 'no rebuild at all');
  assert.equal(Math.abs(netAt(cacheOf(FLIPPING_ROWS), share(FLIPPING_ROWS))) < 1e-9, true);
});

test('the slider\'s readout says the share counted and the net at it, in words at its two ends, and is the spoken value of the slider', () => {
  const cache = cacheOf(CACHE_ROWS);
  assert.equal(shareReadoutOf(cache, 1, t), '重建多付按实际计 → 盈亏 +500');
  assert.equal(shareReadoutOf(cache, 0, t), '重建多付不计 → 盈亏 +1,000');
  assert.equal(shareReadoutOf(cache, 0.4, t), '重建多付按 40% 计 → 盈亏 +800');
  assert.equal(shareReadoutOf(cache, 0.07, t), '重建多付按 7% 计 → 盈亏 +965');
  assert.equal(shareReadoutOf(cacheOf(FLIPPING_ROWS), 0.5, t), '重建多付按 50% 计 → 盈亏 +60');
  assert.equal(shareReadoutOf(cacheOf(FLIPPING_ROWS), 1, t), '重建多付按实际计 → 盈亏 −400');
  assert.equal(shareReadoutOf(cache, 1, localized(en)), 'Rebuild overpay counted as it is → net +500');
});

test('the line chart of the net draws the net from none of the rebuild extra to all of it, the end values at its ends, the break-even point and the slider\'s cursor between them', () => {
  const flipping = cacheOf(FLIPPING_ROWS);
  const g = lamGeometryOf(flipping, 0.25, 320);
  assert.deepEqual([g.width, g.height], [320, 156]);
  assert.deepEqual(g.grid.map(tick => [tick.x, tick.label, tick.anchor]), [[10, '0%', 'start'], [85, '25%', 'middle'], [160, '50%', 'middle'], [235, '75%', 'middle'], [310, '100%', 'end']]);
  assert.deepEqual(g.title, { x: 160, y: 154 });
  // The domain is from −400 less a fifth of the span to 520 plus a fifth of it, on a plot 108 tall from y 14.
  const span = 920;
  const low = -400 - 0.2 * span;
  const high = 520 + 0.2 * span;
  const y = value => 14 + (high - value) / (high - low) * 108;
  const r1 = value => Math.round(value * 10) / 10;
  assert.deepEqual(g.zero, { x1: 10, x2: 310, y: r1(y(0)), labelX: 12, labelY: r1(y(0) + 11) }, 'the zero label goes under the line where a net is below it');
  const split = 520 / 920 * 300 + 10;
  assert.deepEqual(g.segments.map(segment => segment.tone), ['pos', 'neg']);
  assert.equal(g.segments[0].points, `10.0,${y(520).toFixed(1)} ${split.toFixed(1)},${y(0).toFixed(1)}`);
  assert.equal(g.segments[1].points, `${split.toFixed(1)},${y(0).toFixed(1)} 310.0,${y(-400).toFixed(1)}`);
  assert.deepEqual(g.crossing, { x: r1(split), y: r1(y(0)), d: `M${r1(split)} ${r1(r1(y(0)) - 5)}l5 5l-5 5l-5-5z` });
  assert.deepEqual(g.ends, [
    { kind: 'none', x: 10, y: r1(y(520)), r: 4, label: { text: '+520', x: 10, y: r1(y(520) - 8), anchor: 'start' } },
    { kind: 'all', x: 310, y: r1(y(-400)), r: 4.5, label: { text: '−400', x: 310, y: r1(y(-400) + 16), anchor: 'end' } },
  ]);
  assert.deepEqual(g.cursor, { x: 85, y: r1(y(netAt(flipping, 0.25))) });
  assert.deepEqual(g.guide, { top: 14, bottom: 122 });
});

test('the line chart has one segment and no break-even point where the net does not cross zero, and no cursor at its two ends', () => {
  const g = lamGeometryOf(cacheOf(CACHE_ROWS), 1, 320);
  assert.deepEqual(g.segments.map(segment => segment.tone), ['pos']);
  assert.equal(g.crossing, null);
  assert.equal(g.cursor, null, 'at an end the point already shows it');
  assert.equal(lamGeometryOf(cacheOf(CACHE_ROWS), 0, 320).cursor, null);
  assert.equal(lamGeometryOf(cacheOf(CACHE_ROWS), 0.004, 320).cursor, null);
  assert.equal(lamGeometryOf(cacheOf(CACHE_ROWS), 0.005, 320).cursor !== null, true);
  assert.equal(lamGeometryOf(cacheOf(CACHE_ROWS), 0.995, 320).cursor !== null, true);
  assert.equal(lamGeometryOf(cacheOf(CACHE_ROWS), 0.996, 320).cursor, null);
  assert.equal(g.zero.labelY, Math.round((g.zero.y - 3) * 10) / 10, 'above the line where both nets are above it');
  const losing = lamGeometryOf(cacheOf([row(1, { saved: 100, cost: 300, rebuild: 100, cut: 1 })]), 1, 320);
  assert.deepEqual(losing.segments.map(segment => segment.tone), ['neg']);
  assert.equal(losing.crossing, null);
  const touching = lamGeometryOf(cacheOf([row(1, { saved: 100, cost: 100, rebuild: 10, cut: 1 })]), 1, 320);
  assert.equal(JSON.stringify(touching).includes('NaN'), false, 'a net that ends at zero has a domain');
});

test('a plot too narrow for the chart keeps the least width', () => {
  assert.equal(lamGeometryOf(cacheOf(CACHE_ROWS), 1, 20).width, 80);
});

// ── The page ─────────────────────────────────────────────────────────────────

const SETTLEMENT = { epoch: 2, count: 3, steps: 7, saved: 1000, cost: 300, rows: ROWS };
const ready = calls => ({ kind: 'ready', value: { calls } });

test('the page says the count of compactions and, once the series is read, of the calls, and the chart says what it draws: the facts line, the spoken label and the legend\'s assumption', () => {
  const page = contextPageOf(SETTLEMENT, ready(CALLS), 1450, t);
  assert.equal(page.count, '压缩 3 次');
  assert.equal(page.calls, '主调用 8 次');
  assert.equal(page.loading, false);
  assert.equal(page.stock.facts, '实际最高 1.5k · 渐深线 1.5k · 未压缩第 6 次调用越线');
  assert.equal(page.stock.label, '输入存量随第 N 次调用变化：实线是实际，最高 1.5k；虚线是未压缩；渐深线 1.5k，未压缩第 6 次调用越线，实际第 8 次调用越线。左右方向键移动游标，PageUp/PageDown 跳到上/下一次压缩。');
  assert.equal(page.stock.line, 1450);
  const noLine = contextPageOf(SETTLEMENT, ready(CALLS), null, t);
  assert.equal(noLine.stock.facts, '实际最高 1.5k');
  assert.equal(noLine.stock.label, '输入存量随第 N 次调用变化：实线是实际，最高 1.5k；虚线是未压缩。左右方向键移动游标，PageUp/PageDown 跳到上/下一次压缩。');
  assert.equal(contextPageOf(SETTLEMENT, ready(CALLS), 1500, t).stock.facts, '实际最高 1.5k · 渐深线 1.5k · 未压缩第 6 次调用越线', 'the actual line only reaches it');
  assert.equal(contextPageOf(SETTLEMENT, ready(CALLS), 9000, t).stock.facts, '实际最高 1.5k · 渐深线 9.0k', 'no crossing to name');
});

test('every state but a ready, aligned series has no stock chart: loading says it is loading, and a failed read, an unavailable one, an unaligned one and one with nothing to draw say nothing', () => {
  const loading = contextPageOf(SETTLEMENT, null, 1450, t);
  assert.deepEqual([loading.loading, loading.stock, loading.calls], [true, null, null]);
  for (const result of [{ kind: 'unavailable' }, { kind: 'unreachable', message: 'x' }, ready(CALLS.slice(0, 3)), ready([]), ready(CALLS.map(each => ({ ...each, stock: null })))]) {
    const page = contextPageOf(SETTLEMENT, result, 1450, t);
    assert.deepEqual([page.loading, page.stock, page.calls], [false, null, null], JSON.stringify(result).slice(0, 40));
    assert.equal(page.count, '压缩 3 次');
    assert.notEqual(page.cache, null, 'the cache section needs no calls');
  }
});

test('the trial reads the rows alone: the same whatever the answer of the series or the line', () => {
  const settled = { ...SETTLEMENT, rows: CACHE_ROWS };
  const base = contextPageOf(settled, null, null, t).cache;
  for (const [result, line] of [[{ kind: 'unavailable' }, null], [{ kind: 'unreachable', message: 'x' }, 5], [ready([call(1, 5)]), 5]]) {
    assert.deepEqual(contextPageOf(settled, result, line, t).cache.chart, base.chart);
    assert.deepEqual(contextPageOf(settled, result, line, t).cache.crossing, base.crossing);
  }
  assert.equal('share' in base, false, 'the share of the rebuild is the composition\'s');
  assert.equal('net' in base, false);
});

// A ready answer carries the recall activity; the rows are the list's (an answer that prices them is the recall model's test).
const evidence = (calls, recall) => ({ kind: 'ready', value: { calls, activity: { covered: true, judged: 4, pure: 1, targets: [] }, ...(recall === undefined ? {} : { recall }) } });

test('the composition is of the report: the summaries and the rebuild of the priced compactions and the recall requests net of the rebuild they already counted, the total the report\'s cost', () => {
  const settled = { ...SETTLEMENT, rows: CACHE_ROWS, saved: 1500, cost: 1000 };
  const recall = { steps: [{ at: 3, seq: 9, usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 0 }, ratio: 2 }], cuts: [] };

  const { composition } = contextPageOf(settled, evidence([], recall), null, t);

  assert.deepEqual(composition.items.map(({ key, value, text, percent }) => [key, value, text, percent]), [
    ['summary', 500, '500', '48.1%'], ['rebuild', 500, '500', '48.1%'], ['recall', 40, '40', '3.8%'],
  ]);
  assert.deepEqual(composition.total, { value: 1040, text: '1,040' });
  const quiet = contextPageOf(settled, evidence([]), null, t).composition;
  assert.deepEqual(quiet.items.map(({ value }) => value), [500, 500, 0], 'a segment with no recall step has a recall net of zero, which is known');
  assert.deepEqual(quiet.total, { value: 1000, text: '1,000' });
});

test('with no evidence the composition shows the two items of the list\'s own figures, no total and no share: the loading, failed and older answers alike', () => {
  const settled = { ...SETTLEMENT, rows: CACHE_ROWS };
  for (const result of [null, { kind: 'unavailable' }, { kind: 'unreachable', message: 'x' }, ready(CALLS)]) {
    const { composition } = contextPageOf(settled, result, null, t);
    assert.equal(composition.total, null);
    assert.deepEqual(composition.items.map(({ value, percent }) => [value, percent]), [[500, null], [500, null], [null, null]], JSON.stringify(result)?.slice(0, 30));
  }
});

test('the crossing sentence is worded with the share and shown only where the rebuild turns a positive net negative, the chart\'s spoken text carrying it', () => {
  const flipping = contextPageOf({ ...SETTLEMENT, rows: FLIPPING_ROWS }, null, null, t).cache;
  assert.equal(flipping.crossing, '重建多付的部分只要降到 56.5% 以下，本段净额转正');
  assert.equal(flipping.chart.label, '重建多付不计入时盈亏 +520，按实际计入时 −400。重建多付的部分只要降到 56.5% 以下，本段净额转正。');
  const positive = contextPageOf({ ...SETTLEMENT, rows: CACHE_ROWS }, null, null, t).cache;
  assert.equal(positive.crossing, null);
  assert.equal(positive.chart.label, '重建多付不计入时盈亏 +1.0k，按实际计入时 +500。');
  assert.equal(contextPageOf({ ...SETTLEMENT, rows: FLIPPING_ROWS }, null, null, localized(en)).cache.crossing, 'The net turns positive once the rebuild overpay falls below 56.5%');
});

test('the list of the compactions is ordered by the rebuild with the shares and amounts as texts, those without figures last as dashes, and with a series each row names the call it jumps to', () => {
  const settled = { ...SETTLEMENT, rows: [row(1, { saved: 1000, cost: 300, rebuild: 100, cut: 10 }), row(2, { saved: 500, cost: 700, rebuild: 400, cut: 10 }), row(3, { cut: 10 })] };
  const calls = [call(1, 1000), call(2, 900, true), call(3, 950, true), call(4, null, true), call(5, 970)];
  const { list } = contextPageOf(settled, ready(calls), null, t).cache;
  assert.deepEqual(list.map(each => [each.ordinal, each.known, each.bar, each.rebuild, each.share, each.jump]), [
    [2, true, '100.00', '400', { text: '80.0%', title: '80.0%' }, 3],
    [1, true, '25.00', '100', { text: '20.0%', title: '20.0%' }, 2],
    [3, false, null, null, null, 5],
  ]);
  assert.deepEqual(list.map(each => each.label), [
    '压缩 #2，重建多付 400，占比 80.0%，定位到图上第 3 次调用',
    '压缩 #1，重建多付 100，占比 20.0%，定位到图上第 2 次调用',
    '压缩 #3，无数据，定位到图上第 5 次调用',
  ]);
  const plain = contextPageOf(settled, { kind: 'unavailable' }, null, t).cache.list;
  assert.deepEqual(plain.map(each => each.jump), [null, null, null], 'with no chart there is nothing to jump to');
  assert.deepEqual(plain.map(each => each.ordinal), [2, 1, 3]);
  const big = contextPageOf({ ...SETTLEMENT, rows: [row(1, { saved: 9_000_000, cost: 1_234_567, rebuild: 1_234_567, cut: 1 })] }, null, null, t).cache.list[0];
  assert.equal(big.rebuild, '1,234,567');
});

test('with no rebuild at all the trial has no chart and no list, and the composition\'s rebuild is nothing', () => {
  const page = contextPageOf({ ...SETTLEMENT, rows: [row(1, { saved: 500, cost: 300, rebuild: 0, cut: 1 })] }, evidence([]), null, t);
  assert.equal(page.cache.chart, null);
  assert.equal(page.cache.list, null);
  assert.deepEqual(page.composition.items.map(({ key, text, percent }) => [key, text, percent]), [['summary', '300', '100.0%'], ['rebuild', '0', '0.0%'], ['recall', '0', '0.0%']]);
});

// ── The view state ───────────────────────────────────────────────────────────

test('a new page has no cursor, no hover, the whole rebuild counted and every fold shut; a press or a move sets the cursor and clears the hover, and only a change of the hover makes a new state', () => {
  const state = createContextState();
  assert.deepEqual(state, { cursor: null, hover: null, target: null, expanded: false, share: 1, folds: { rows: false, trial: false, note: false } });
  const hovered = reduceContext(state, { type: 'hover', at: 4 });
  assert.equal(hovered.hover, 4);
  assert.equal(reduceContext(hovered, { type: 'hover', at: 4 }), hovered, 'the same place is no change');
  assert.equal(reduceContext(state, { type: 'leave' }), state, 'nothing to leave');
  assert.equal(reduceContext(hovered, { type: 'leave' }).hover, null);
  const placed = reduceContext(hovered, { type: 'cursor', at: 6 });
  assert.deepEqual([placed.cursor, placed.hover], [6, null]);
  assert.equal(reduceContext(placed, { type: 'hover', at: 2 }).cursor, 6, 'a hover does not move the cursor');
  assert.equal(reduceContext(state, { type: 'share', value: 0.4 }).share, 0.4);
  const folded = reduceContext(reduceContext(state, { type: 'fold', name: 'rows', open: true }), { type: 'fold', name: 'note', open: true });
  assert.deepEqual([isFoldOpen(folded, 'rows'), isFoldOpen(folded, 'note')], [true, true]);
  assert.equal(isFoldOpen(reduceContext(folded, { type: 'fold', name: 'rows', open: false }), 'rows'), false);
  assert.equal(isFoldOpen(reduceContext(folded, { type: 'fold', name: 'rows', open: false }), 'note'), true, 'one fold leaves the other');
  assert.equal(reduceContext(state, { type: 'nothing' }), state);
});

test('a target is chosen and chosen again to leave it, a choice shuts the text the last one opened, and the other state stays as it was', () => {
  const state = reduceContext(reduceContext(createContextState(), { type: 'cursor', at: 3 }), { type: 'share', value: 0.4 });
  assert.deepEqual([state.target, state.expanded], [null, false]);
  const chosen = reduceContext(state, { type: 'target', seq: 128 });
  assert.deepEqual([chosen.target, chosen.cursor, chosen.share], [128, 3, 0.4]);
  const opened = reduceContext(chosen, { type: 'expand' });
  assert.equal(opened.expanded, true);
  assert.equal(reduceContext(opened, { type: 'expand' }).expanded, false, 'the same button shuts it');
  assert.deepEqual([reduceContext(opened, { type: 'target', seq: 241 }).target, reduceContext(opened, { type: 'target', seq: 241 }).expanded], [241, false]);
  assert.deepEqual([reduceContext(opened, { type: 'target', seq: 128 }).target, reduceContext(opened, { type: 'target', seq: 128 }).expanded], [null, false], 'chosen again it leaves');
  assert.deepEqual(state, { ...createContextState(), cursor: 3, share: 0.4 }, 'never changed in place');
});

// ── The view ─────────────────────────────────────────────────────────────────

const noop = () => {};
// Three compactions, the third without figures, over seven calls; the rebuild turns the net of +520 into −400.
const VIEW_ROWS = [row(1, { saved: 1000, cost: 1500, rebuild: 900, cut: 100 }), row(2, { saved: 200, cost: 100, rebuild: 20, cut: 50 }), row(3, { cut: 10 })];
const VIEW_CALLS = [call(1, 1000), call(2, 1100, true), call(3, 1200), call(4, 1250, true), call(5, 1300), call(6, 1350, true), call(7, 1400)];
const VIEW = { epoch: 2, count: 3, steps: 9, saved: 1200, cost: 1600, rows: VIEW_ROWS };
const view = (result, { line = 1300, state = createContextState(), translate = t, width = 392, lamWidth = 300, graphWidth = 392, text = null, dispatch = noop, settlement = VIEW } = {}) => renderToString(React.createElement(ContextView, {
  model: contextPageOf(settlement, result, line, translate), state, dispatch, width, lamWidth, graphWidth, chartRef: null, lamRef: null, graphRef: null, text, t: translate,
}));
const tagsOf = (html, className) => [...html.matchAll(new RegExp(`<[a-z0-9]+\\s[^>]*class="${className}"[^>]*>`, 'g'))].map(([tag]) => tag);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const withClass = (html, className) => [...html.matchAll(new RegExp(`<([a-z0-9]+)\\s[^>]*class="${className}"[^>]*>(.*?)</\\1>`, 'gs'))].map(match => match[2]);
const textOf = html => html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

test('a ready page is the readout waiting for a cursor, the count line, the chart with its heading, seal buttons, facts and legend, the cache section, the note and the unit once', () => {
  const html = view(ready(VIEW_CALLS));
  assert.equal(textOf(withClass(html, 'sw-cx-read')[0]), '悬停输入存量图，或聚焦后按 ← →（按住 Shift 加大步长；PageUp/PageDown 跳到压缩处）。');
  assert.match(html, /<div class="sw-cx-read" aria-live="polite">/);
  assert.equal(textOf(withClass(html, 'sw-cx-ctx')[0]), '压缩 3 次 · 主调用 7 次');
  assert.equal(textOf(withClass(html, 'sw-cx-h')[0]), '输入存量‹ 压缩 ›');
  assert.deepEqual([...html.matchAll(/<button type="button" class="sw-cx-btn"[^>]*aria-label="([^"]*)"/g)].map(match => match[1]), ['上一次压缩', '下一次压缩']);
  assert.equal(textOf(withClass(html, 'sw-cx-facts')[0]), '实际最高 1.4k · 渐深线 1.3k · 未压缩第 4 次调用越线');
  const svg = tagsOf(html, 'sw-cx-svg')[0];
  assert.deepEqual([attr(svg, 'role'), attr(svg, 'aria-roledescription'), attr(svg, 'tabindex'), attr(svg, 'width'), attr(svg, 'viewBox')], ['group', '折线图', '0', '392', '0 0 392 224']);
  assert.equal(attr(svg, 'aria-label').startsWith('输入存量随第 N 次调用变化'), true);
  assert.equal(attr(svg, 'aria-label'), contextPageOf(VIEW, ready(VIEW_CALLS), 1300, t).stock.label);
  assert.deepEqual([...withClass(html, 'sw-cx-legend')[0].matchAll(/<li>(.*?)<\/li>/g)].map(match => textOf(match[1])), ['实际', '未压缩 假设：除封存外增长不变', '压缩']);
  assert.equal(attr(tagsOf(html, 'sw-cx-legend')[0], 'aria-label'), '图例');
  assert.equal(html.includes('<pre'), false);
  assert.equal([...html.matchAll(/单位：读价 token/g)].length, 1, 'the unit once');
  assert.equal(tagsOf(html, 'sw-cx-unit').length, 1);
  assert.match(html, /<details class="sw-cx-note"><summary>说明<\/summary>/);
  assert.match(html, /渐深线：按本段末的测量拟合出的输入存量位置；实际存量越过它，就进入「渐深」区。/);
  assert.equal(html.includes('sw-mon-notice'), false);
});

test('the chart draws the lines and marks the model gives: the actual line, the dashed uncompressed one, the line and its crossings, the seals with their hit areas, the axes and the hit area over the plot', () => {
  const html = view(ready(VIEW_CALLS));
  const g = stockGeometryOf(seriesOf(VIEW_ROWS, VIEW_CALLS), 1300, 392, t);
  const [svg] = withClass(html, 'sw-cx-chartbox');
  assert.equal(svg.includes(`d="${g.actual}"`), true);
  assert.equal(/class="sw-cx-actual"/.test(svg) && /class="sw-cx-uncompressed"/.test(svg), true);
  const dashed = attr(tagsOf(svg, 'sw-cx-uncompressed')[0], 'd');
  assert.equal(dashed, g.uncompressed);
  assert.equal(dashed.split(' L').at(-1).split(',')[0], '382.0', 'the dashed line reaches the final call after crossing the deepening line');
  assert.equal(svg.includes(`d="${g.uncompressedCross.d}"`), true);
  assert.equal(tagsOf(svg, 'sw-cx-actualcross').length, 1);
  assert.equal(tagsOf(svg, 'sw-cx-warnline').length, 1, 'the line, dotted');
  assert.equal(tagsOf(svg, 'sw-cx-sealline').length, 3);
  assert.equal(tagsOf(svg, 'sw-cx-seal').length, 3);
  assert.equal(tagsOf(svg, 'sw-cx-sealhit').length, 3);
  const hit = tagsOf(svg, 'sw-cx-hit')[0];
  assert.deepEqual(['x', 'y', 'width', 'height'].map(name => attr(hit, name)), ['40', '14', '342', '166']);
  assert.equal(attr(tagsOf(svg, 'sw-cx-axis')[0], 'd'), 'M40,14 V194 H382');
  const [, titleX, titleY] = /<text class="sw-cx-lbl" x="([\d.]+)" y="([\d.]+)">输入存量 ↑<\/text>/.exec(svg);
  assert.deepEqual([Number(titleX), Number(titleY) < g.plotTop], [g.left, true], 'the axis title starts over the plot\'s left edge and above it, clear of the scale\'s labels, which end at the edge');
  const texts = [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map(match => textOf(match[1]));
  for (const word of ['输入存量 ↑', '渐深线 1.3k', '未压缩：第 4 次越线', '实际：第 6 次越线', '第 N 次调用 →', '0']) assert.equal(texts.includes(word), true, word);
  assert.equal(svg.includes('NaN'), false);
  assert.equal(/<(?:button|a|input)\b/.test(svg), false);
});

test('the actual peak fixes the vertical axis and the dashed line is clipped to the plot', () => {
  const settlement = { ...VIEW, count: 1, rows: [row(1, { cut: 200 })] };
  const calls = [call(1, 1000), call(2, 1100, true), call(3, 1400), call(4, 1000), call(5, 1400)];
  const html = view(ready(calls), { settlement, line: 1250 });
  const [svg] = withClass(html, 'sw-cx-chartbox');
  assert.ok(withClass(svg, 'sw-cx-lbl').includes('1.5k'), 'the actual peak of 1400 sets the scale');
  assert.ok(!withClass(svg, 'sw-cx-lbl').includes('2.0k'), 'the dashed peak of 1600 does not raise the scale');
  const [, viewport, path] = /(<svg\b[^>]*>)(<path\b[^>]*class="sw-cx-uncompressed"[^>]*>)/.exec(svg) ?? [];
  assert.ok(viewport, 'only the dashed line is in a clipped viewport');
  assert.deepEqual(['x', 'y', 'width', 'height', 'viewBox', 'overflow'].map(name => attr(viewport, name)), ['40', '14', '342', '180', '40 14 342 180', 'hidden']);
  assert.equal(attr(path, 'd'), 'M40.0,74.0 L125.5,38.0 L211.0,2.0 L296.5,50.0 L382.0,2.0', 'the line can return to the plot without flattening the parts outside it');
  assert.ok(svg.includes('未压缩：第 2 次越线'), 'the in-range deepening crossing still has its label');
});

test('with no line the chart draws none, names no crossing and has no note', () => {
  const html = view(ready(VIEW_CALLS), { line: null });
  assert.equal(textOf(withClass(html, 'sw-cx-facts')[0]), '实际最高 1.4k');
  assert.equal(html.includes('sw-cx-warnline'), false);
  assert.equal(html.includes('渐深线'), false);
  assert.equal(html.includes('sw-cx-note'), false);
  assert.equal(html.includes('sw-cx-uncompressed'), true, 'the uncompressed line runs the whole series');
  assert.equal(tagsOf(html, 'sw-cx-unit').length, 1);
});

test('while the series is read a notice takes the chart\'s place with the composition and the unit under it; a read that failed, an unavailable one and an unaligned one leave nothing in its place', () => {
  const loading = view(null);
  assert.match(loading, /<p class="sw-mon-notice" data-sw-monitor-notice="context-loading" role="status">正在读取详情…<\/p>/);
  assert.equal(textOf(withClass(loading, 'sw-cx-ctx')[0]), '压缩 3 次');
  for (const marker of ['sw-cx-svg', 'sw-cx-read', 'sw-cx-legend', 'sw-cx-facts', 'sw-cx-note']) assert.equal(loading.includes(marker), false, marker);
  assert.equal(loading.includes('sw-cx-comp'), true);
  assert.equal(tagsOf(loading, 'sw-cx-unit').length, 1);
  for (const result of [{ kind: 'unavailable' }, { kind: 'unreachable', message: 'x' }, ready(VIEW_CALLS.slice(0, 4))]) {
    const html = view(result);
    assert.equal(html.includes('sw-mon-notice'), false, JSON.stringify(result));
    for (const marker of ['sw-cx-svg', 'sw-cx-read', 'sw-cx-legend', 'sw-cx-facts', 'sw-cx-note']) assert.equal(html.includes(marker), false, marker);
    assert.equal(textOf(withClass(html, 'sw-cx-ctx')[0]), '压缩 3 次');
    assert.equal(html.includes('sw-cx-comp'), true);
    assert.equal(tagsOf(html, 'sw-cx-unit').length, 1);
  }
});

test('the composition is the three parts over one total, a bar of their shares and a list of each part\'s amount and share, whatever the series', () => {
  for (const result of [evidence(VIEW_CALLS), evidence([]), evidence(VIEW_CALLS.slice(0, 3))]) {
    const html = view(result);
    const section = html.slice(html.indexOf('<section class="sw-cx-comp"'), html.indexOf('</section>', html.indexOf('<section class="sw-cx-comp"')));
    assert.match(section, /<section class="sw-cx-comp" aria-label="结算成本构成">/);
    assert.equal(textOf(withClass(section, 'sw-cx-comp-total')[0]), '合计 1,600');
    assert.deepEqual([...section.matchAll(/<i class="sw-cx-seg" data-key="(\w+)" style="width:([^"]*)">/g)].map(match => [match[1], match[2]]), [['summary', '42.50%'], ['rebuild', '57.50%'], ['recall', '0.00%']]);
    assert.deepEqual([...section.matchAll(/<li class="sw-cx-comp-row" data-key="(\w+)">(.*?)<\/li>/g)].map(match => [match[1], textOf(match[2].replace(/<\/span>/g, ' ')).trim()]), [
      ['summary', '压缩摘要 680 42.5%'], ['rebuild', '缓存重建 920 57.5%'], ['recall', '召回请求净增 0 0.0%'],
    ]);
  }
});

test('without evidence the composition says what it has and gives no total, no bar and no share', () => {
  for (const result of [ready(VIEW_CALLS), null, { kind: 'unavailable' }]) {
    const html = view(result);
    assert.equal(html.includes('sw-cx-comp-total'), false, JSON.stringify(result)?.slice(0, 30));
    assert.equal(html.includes('sw-cx-stack'), false);
    assert.deepEqual([...html.matchAll(/<li class="sw-cx-comp-row" data-key="(\w+)">(.*?)<\/li>/g)].map(match => [match[1], textOf(match[2].replace(/<\/span>/g, ' ')).trim()]), [
      ['summary', '压缩摘要 680 —'], ['rebuild', '缓存重建 920 —'], ['recall', '召回请求净增 — —'],
    ]);
  }
});

test('the trial is a fold shut to begin with: the line chart in a card with the slider, its readout and the break-even sentence, which no figure above depends on', () => {
  for (const result of [ready(VIEW_CALLS), null, { kind: 'unavailable' }]) {
    const html = view(result);
    const trial = html.slice(html.indexOf('<details class="sw-cx-trial"'));
    assert.match(trial, /^<details class="sw-cx-trial"><summary>重建试算<\/summary>/);
    const chart = /<div class="sw-cx-lamchart" role="img" aria-label="([^"]*)">/.exec(trial);
    assert.equal(chart[1].replace(/&#x27;/g, '\''), '重建多付不计入时盈亏 +520，按实际计入时 −400。重建多付的部分只要降到 56.5% 以下，本段净额转正。');
    const slider = /<input\b[^>]*class="sw-cx-slider"[^>]*>/.exec(trial)[0];
    assert.deepEqual(['type', 'min', 'max', 'step', 'value', 'aria-valuetext', 'id'].map(name => attr(slider, name)), ['range', '0', '1', '0.01', '1', '重建多付按实际计 → 盈亏 −400', 'sw-cx-share']);
    assert.match(trial, /<label for="sw-cx-share">重建多付<\/label>/);
    assert.equal(textOf(withClass(trial, 'sw-cx-rd')[0]), '重建多付按实际计 → 盈亏 −400');
    assert.equal(textOf(withClass(trial, 'sw-cx-thr')[0]), '重建多付的部分只要降到 56.5% 以下，本段净额转正');
  }
  const opened = view(null, { state: reduceContext(createContextState(), { type: 'fold', name: 'trial', open: true }) });
  assert.match(opened, /<details class="sw-cx-trial" open="">/);
  assert.match(view(null), /<details class="sw-cx-rows"><summary>各次压缩的重建多付<\/summary>/);
});

test('the trial moves with the share and nothing above it does: the composition is the same at every share', () => {
  const at = share => view(evidence(VIEW_CALLS), { state: reduceContext(createContextState(), { type: 'share', value: share }) });
  const composition = html => html.slice(html.indexOf('<section class="sw-cx-comp"'), html.indexOf('</section>', html.indexOf('<section class="sw-cx-comp"')));
  assert.equal(composition(at(0)), composition(at(1)));
  assert.notEqual(textOf(withClass(at(0), 'sw-cx-rd')[0]), textOf(withClass(at(1), 'sw-cx-rd')[0]));
});

test('the chart of the trial shows the sign of the net by its text and the tone by a class, the sentence is absent where the net does not turn, and no rebuild means no trial and no list', () => {
  const winning = view(null, { settlement: { ...VIEW, rows: [row(1, { saved: 1000, cost: 300, rebuild: 100, cut: 100 })] } });
  assert.equal(winning.includes('sw-cx-thr'), false);
  assert.equal(attr(/<div class="sw-cx-lamchart"[^>]*>/.exec(winning)[0], 'aria-label'), '重建多付不计入时盈亏 +800，按实际计入时 +700。');
  assert.match(winning, /<polyline class="sw-cx-net sw-cx-pos"/);
  const none = view(null, { settlement: { ...VIEW, rows: [row(1, { saved: 500, cost: 300, rebuild: 0, cut: 100 })] } });
  assert.equal(none.includes('sw-cx-trial'), false, 'no rebuild, no trial');
  assert.equal(none.includes('sw-cx-lamchart'), false);
  assert.equal(none.includes('sw-cx-slider'), false);
  assert.equal(none.includes('sw-cx-rows'), false, 'and no list');
});

test('the slider and its readout follow the share the state holds, and the line chart carries the cursor for it', () => {
  const html = view(null, { state: reduceContext(createContextState(), { type: 'share', value: 0.4 }) });
  const slider = /<input\b[^>]*class="sw-cx-slider"[^>]*>/.exec(html)[0];
  assert.deepEqual([attr(slider, 'value'), attr(slider, 'aria-valuetext')], ['0.4', '重建多付按 40% 计 → 盈亏 +152']);
  assert.equal(textOf(withClass(html, 'sw-cx-rd')[0]), '重建多付按 40% 计 → 盈亏 +152');
  assert.equal(tagsOf(html, 'sw-cx-lamcursor').length, 1);
  assert.equal(tagsOf(view(null), 'sw-cx-lamcursor').length, 0);
});

test('the list holds a row for each compaction by its rebuild, a button that names where it jumps to with a chart, and a plain row without one', () => {
  const state = reduceContext(createContextState(), { type: 'fold', name: 'rows', open: true });
  const html = view(ready(VIEW_CALLS), { state });
  assert.match(html, /<details class="sw-cx-rows" open="">/);
  const list = html.slice(html.indexOf('role="list"'));
  assert.equal(list.includes('aria-hidden="true"><span>#</span><span></span><span>重建多付</span><span>占比</span>'), true, 'the header');
  assert.deepEqual([...list.matchAll(/<button type="button" class="sw-cx-rr"[^>]*aria-label="([^"]*)"/g)].map(match => match[1]), [
    '压缩 #1，重建多付 900，占比 97.8%，定位到图上第 2 次调用',
    '压缩 #2，重建多付 20，占比 2.2%，定位到图上第 4 次调用',
    '压缩 #3，无数据，定位到图上第 6 次调用',
  ]);
  assert.deepEqual([...list.matchAll(/<button type="button" class="sw-cx-rr"[^>]*>(.*?)<\/button>/g)].map(match => textOf(match[1].replace(/<\/span>/g, ' ')).trim()), ['#1  900 97.8%', '#2  20 2.2%', '#3  — —']);
  assert.deepEqual([...list.matchAll(/<i style="width:([^"]*)">/g)].map(match => match[1]), ['100.00%', '2.22%']);
  const plain = view({ kind: 'unavailable' }, { state });
  assert.equal(plain.includes('sw-cx-rr"'), true);
  assert.equal(/<button[^>]*sw-cx-rr/.test(plain), false);
  assert.deepEqual([...plain.matchAll(/<div class="sw-cx-rr">(.*?)<\/div>/g)].map(match => textOf(match[1].replace(/<\/span>/g, ' ')).trim()), ['#1  900 97.8%', '#2  20 2.2%', '#3  — —']);
});

test('a cursor puts the readout and a line with its points on the chart, and a hover takes the readout over from it', () => {
  const placed = reduceContext(createContextState(), { type: 'cursor', at: 4 });
  const html = view(ready(VIEW_CALLS), { state: placed });
  assert.deepEqual([...withClass(html, 'sw-cx-read')[0].matchAll(/<span class="sw-cx-r[^"]*">(.*?)<\/span>/g)].map(match => textOf(match[1])), ['第 4/7 次调用 · seq 4 · 压缩 #2 后首次', '实际 1,250 · 未压缩 1,400 · 渐深线 1,300']);
  assert.equal(tagsOf(html, 'sw-cx-cur').length, 1);
  assert.deepEqual([tagsOf(html, 'sw-cx-curdot').length, tagsOf(html, 'sw-cx-curdot sw-cx-curp').length], [1, 1], 'a point on the actual line and one on the uncompressed line');
  const hovered = view(ready(VIEW_CALLS), { state: reduceContext(placed, { type: 'hover', at: 7 }) });
  assert.deepEqual([...withClass(hovered, 'sw-cx-read')[0].matchAll(/<span class="sw-cx-r[^"]*">(.*?)<\/span>/g)].map(match => textOf(match[1])), ['第 7/7 次调用 · seq 7', '实际 1,400 · 未压缩 1,560 · 渐深线 1,300'], 'past the crossing');
  assert.deepEqual([tagsOf(hovered, 'sw-cx-curdot').length, tagsOf(hovered, 'sw-cx-curdot sw-cx-curp').length], [1, 0], 'the off-scale point is read but not drawn');
  assert.equal(tagsOf(view(ready(VIEW_CALLS)), 'sw-cx-cur').length, 0, 'no cursor, no line');
});

// The view is a function over its props with no hook, so its element tree is read by calling the function components in it.
const expand = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
};
const findAll = (node, test, found = []) => {
  if (Array.isArray(node)) node.forEach(child => findAll(child, test, found));
  else if (node !== null && typeof node === 'object') {
    if (test(node)) found.push(node);
    findAll(node.props?.children, test, found);
  }
  return found;
};
function treeOf({ state = createContextState(), result = ready(VIEW_CALLS), line = 1300 } = {}) {
  const dispatched = [];
  const tree = expand(ContextView({ model: contextPageOf(VIEW, result, line, t), state, dispatch: action => dispatched.push(action), width: 392, lamWidth: 300, graphWidth: 392, chartRef: null, lamRef: null, graphRef: null, t }));
  return { tree, dispatched, all: className => findAll(tree, node => node.props?.className === className) };
}
const GEOMETRY = stockGeometryOf(seriesOf(VIEW_ROWS, VIEW_CALLS), 1300, 392, t);
// A pointer event over the chart, `x` along it, the chart drawn 100 from the window's left edge at the width it is drawn at.
const pointerAt = (x, scale = 1) => ({ clientX: 100 + x * scale, currentTarget: { ownerSVGElement: { getBoundingClientRect: () => ({ left: 100, width: GEOMETRY.width * scale }) } } });

test('the pointer over the plot hovers the drawn call nearest it, leaving the chart clears it and a press places the cursor, the place read in the chart\'s own scale', () => {
  const { all, dispatched } = treeOf();
  const [hit] = all('sw-cx-hit');
  const xOfCall = at => GEOMETRY.points.find(point => point.at === at).x;
  hit.props.onPointerMove(pointerAt(xOfCall(3) + 1));
  hit.props.onPointerMove(pointerAt(xOfCall(6)));
  hit.props.onClick(pointerAt(xOfCall(2)));
  hit.props.onPointerMove(pointerAt(xOfCall(5), 0.5));
  all('sw-cx-svg')[0].props.onPointerLeave();
  assert.deepEqual(dispatched, [{ type: 'hover', at: 3 }, { type: 'hover', at: 6 }, { type: 'cursor', at: 2 }, { type: 'hover', at: 5 }, { type: 'leave' }]);
});

test('a seal\'s hit area places the cursor on the call its jump lands on, and the two buttons step to the next and the previous compaction from the call the readout shows', () => {
  const seals = treeOf();
  seals.all('sw-cx-sealhit').forEach(node => node.props.onClick());
  assert.deepEqual(seals.dispatched, [{ type: 'cursor', at: 2 }, { type: 'cursor', at: 4 }, { type: 'cursor', at: 6 }]);
  const step = (state) => {
    const { all, dispatched } = treeOf({ state });
    const [previous, next] = all('sw-cx-btn');
    previous.props.onClick();
    next.props.onClick();
    return dispatched.map(action => action.at);
  };
  assert.deepEqual(step(createContextState()), [6, 2], 'with no cursor the buttons start from the ends');
  assert.deepEqual(step(reduceContext(createContextState(), { type: 'cursor', at: 3 })), [2, 4]);
  assert.deepEqual(step(reduceContext(reduceContext(createContextState(), { type: 'cursor', at: 3 }), { type: 'hover', at: 5 })), [4, 6], 'from the hovered call');
  const [previous, next] = treeOf().all('sw-cx-btn');
  assert.deepEqual([previous.props['aria-label'], next.props['aria-label']], ['上一次压缩', '下一次压缩']);
});

test('the chart takes the keys that move its cursor and the focus that places it, and stops the keys it takes and no others', () => {
  const press = (state, key, shiftKey = false) => {
    const { all, dispatched } = treeOf({ state });
    const prevented = [];
    all('sw-cx-svg')[0].props.onKeyDown({ key, shiftKey, preventDefault: () => prevented.push(key) });
    return { actions: dispatched, prevented };
  };
  const at = cursor => reduceContext(createContextState(), { type: 'cursor', at: cursor });
  assert.deepEqual(press(at(3), 'ArrowRight'), { actions: [{ type: 'cursor', at: 4 }], prevented: ['ArrowRight'] });
  assert.deepEqual(press(at(3), 'ArrowLeft', true), { actions: [{ type: 'cursor', at: 1 }], prevented: ['ArrowLeft'] });
  assert.deepEqual(press(at(3), 'End').actions, [{ type: 'cursor', at: 7 }]);
  assert.deepEqual(press(at(3), 'Home').actions, [{ type: 'cursor', at: 1 }]);
  assert.deepEqual(press(at(3), 'PageDown').actions, [{ type: 'cursor', at: 4 }]);
  assert.deepEqual(press(at(3), 'PageUp').actions, [{ type: 'cursor', at: 2 }]);
  assert.deepEqual(press(createContextState(), 'ArrowRight').actions, [{ type: 'cursor', at: 1 }]);
  assert.deepEqual(press(reduceContext(at(3), { type: 'hover', at: 5 }), 'PageUp').actions, [{ type: 'cursor', at: 4 }], 'the compactions are stepped from the call the readout shows');
  assert.deepEqual(press(reduceContext(at(3), { type: 'hover', at: 5 }), 'PageDown').actions, [{ type: 'cursor', at: 6 }]);
  assert.deepEqual(press(reduceContext(at(3), { type: 'hover', at: 5 }), 'ArrowRight').actions, [{ type: 'cursor', at: 4 }], 'the arrows from the cursor');
  assert.deepEqual(press(at(3), 'a'), { actions: [], prevented: [] });
  assert.deepEqual(press(at(3), 'Tab'), { actions: [], prevented: [] });
  const focused = (state) => {
    const { all, dispatched } = treeOf({ state });
    all('sw-cx-svg')[0].props.onFocus();
    return dispatched;
  };
  assert.deepEqual(focused(createContextState()), [{ type: 'cursor', at: 1 }], 'a first focus places the cursor on the first call');
  assert.deepEqual(focused(at(3)), [], 'a later one leaves it');
});

test('a press on a row of the list jumps to its call, the slider sets the share and a fold records how it was opened', () => {
  const state = reduceContext(createContextState(), { type: 'fold', name: 'rows', open: true });
  const { all, dispatched, tree } = treeOf({ state });
  all('sw-cx-rr').forEach(node => node.props.onClick());
  assert.deepEqual(dispatched, [{ type: 'cursor', at: 2 }, { type: 'cursor', at: 4 }, { type: 'cursor', at: 6 }]);
  const [slider] = all('sw-cx-slider');
  slider.props.onChange({ currentTarget: { value: '0.35' } });
  const [rows] = findAll(tree, node => node.props?.className === 'sw-cx-rows');
  rows.props.onToggle({ currentTarget: { open: false } });
  const [note] = findAll(tree, node => node.props?.className === 'sw-cx-note');
  note.props.onToggle({ currentTarget: { open: true } });
  assert.deepEqual(dispatched.slice(3), [{ type: 'share', value: 0.35 }, { type: 'fold', name: 'rows', open: false }, { type: 'fold', name: 'note', open: true }]);
  assert.equal(rows.props.open, true);
  assert.equal(note.props.open, false);
  const noted = treeOf({ state: reduceContext(createContextState(), { type: 'fold', name: 'note', open: true }) });
  const [openNote] = findAll(noted.tree, node => node.props?.className === 'sw-cx-note');
  const [shutRows] = findAll(noted.tree, node => node.props?.className === 'sw-cx-rows');
  assert.deepEqual([openNote.props.open, shutRows.props.open], [true, false], 'each fold shows the state of its own');
  const plain = treeOf({ result: { kind: 'unavailable' } });
  assert.equal(plain.all('sw-cx-rr').length, 3);
  assert.equal(plain.all('sw-cx-rr').every(node => node.type === 'div' && node.props.onClick === undefined), true, 'with no chart a row jumps nowhere');
});

// ── The page ─────────────────────────────────────────────────────────────────

/** A handle that answers `result` and records what is asked of it. */
function handleAt(result, touched, name) {
  return { get result() { touched.push(`${name}.result`); return result; }, subscribe: () => { touched.push(`${name}.subscribe`); return () => {}; } };
}
function pageOf(result, sessionResult, touched = []) {
  const monitor = { resource: (identity) => { touched.push(['resource', identity]); return handleAt(result, touched, 'resource'); } };
  const session = handleAt(sessionResult, touched, 'session');
  return renderToString(React.createElement(ContextPage, { settlement: VIEW, handoffId: 9, monitor, session, t }));
}

test('the page reads the settlement\'s resource by the handoff id and the line from the session, and draws the chart at the default width where none was measured', () => {
  const touched = [];
  const html = pageOf(evidence(VIEW_CALLS), live([point(1, { amberStockL: 1300 })]), touched);
  assert.deepEqual(touched.filter(each => Array.isArray(each)), [['resource', { endpoint: 'inner-monitor/settlement', handoff: 9 }]]);
  assert.equal(touched.includes('session.result'), true);
  assert.equal(attr(tagsOf(html, 'sw-cx-svg')[0], 'width'), String(DEFAULT_CHART_WIDTH));
  assert.equal(textOf(withClass(html, 'sw-cx-facts')[0]), '实际最高 1.4k · 渐深线 1.3k · 未压缩第 4 次调用越线');
  assert.equal(html, view(evidence(VIEW_CALLS), { width: DEFAULT_CHART_WIDTH, lamWidth: DEFAULT_CHART_WIDTH, graphWidth: DEFAULT_CHART_WIDTH }), 'the same markup as the view over that width');
});

test('the page has no line where the session has none to give, and says it is reading while the series is', () => {
  for (const sessionResult of [null, { kind: 'state', state: 'unobserved' }, { kind: 'unreachable', message: 'x' }, live([]), live([point(1)]), live([point(1, { amberStockL: null })])]) {
    const html = pageOf(ready(VIEW_CALLS), sessionResult);
    assert.equal(html.includes('sw-cx-warnline'), false, JSON.stringify(sessionResult));
    assert.equal(textOf(withClass(html, 'sw-cx-facts')[0]), '实际最高 1.4k');
  }
  const loading = pageOf(null, live([point(1, { amberStockL: 1300 })]));
  assert.equal(loading.includes('data-sw-monitor-notice="context-loading"'), true);
});

test('the context page keeps the trial of the list\'s rebuild and says the adjusted settlement is unavailable when its settlement resource fails', () => {
  const html = pageOf({ kind: 'unreachable', message: 'offline' }, null);
  assert.match(html, /data-sw-monitor-notice="recall-unavailable"/);
  assert.equal(html.includes('sw-cx-comp-total'), false, 'no total of an unadjusted report');
  assert.match(html, /重建多付不计入时盈亏 \+520，按实际计入时 −400。/);
});

test('the context page uses the recall-adjusted net for its cache comparison without revising measured stock', () => {
  const result = evidence(VIEW_CALLS, { steps: [{ at: 3, seq: 3, resident: 35 }], cuts: [] });
  const html = pageOf(result, live([point(1, { amberStockL: 1300 })]));
  assert.match(html, /重建多付不计入时盈亏 \+485，按实际计入时 −435。/);
  assert.equal(textOf(withClass(html, 'sw-cx-facts')[0]), '实际最高 1.4k · 渐深线 1.3k · 未压缩第 4 次调用越线');
});

// ── The recall targets ───────────────────────────────────────────────────────

// The seals of VIEW stand after steps 3, 5 and 7 of nine; the first target's original is at step 2, in `#0`, and it is read at steps 4 and 8, whose requests are calls 4 and 7 of the chart; the second has no landing and one read whose request the chart has no call of.
const SEALED_VIEW = { ...VIEW, rows: VIEW_ROWS.map((each, at) => ({ ...each, sealAt: [3, 5, 7][at] })) };
const TARGETS = [
  { seq: 40, type: 'user/message', at: 2, reads: [{ at: 4, seq: 4 }, { at: 8, seq: 7 }] },
  { seq: 41, type: 'tool/result', at: null, reads: [{ at: 6, seq: 99 }] },
];
const withTargets = (targets, calls = VIEW_CALLS) => ({ kind: 'ready', value: { calls, activity: { covered: true, judged: 5, pure: 2, targets } } });
const targetView = (options = {}) => view(options.result ?? withTargets(TARGETS), { settlement: SEALED_VIEW, ...options });
const chosen = seq => reduceContext(createContextState(), { type: 'target', seq });
const sectionOf = html => html.slice(html.indexOf('<section class="sw-rc"'), html.indexOf('</section>', html.indexOf('<section class="sw-rc"')));

test('the targets are one row each on the settlement axis of the whole segment: the axis with the seals and the zones, and for each row its name, its reads and a track with the original\'s ring and a dot for each read', () => {
  const section = sectionOf(targetView());
  assert.equal(textOf(withClass(section, 'sw-cx-h')[0]), '召回目标2 个目标 · 1 个跨封存重复');
  assert.deepEqual([...section.matchAll(/<button type="button" class="sw-rc-row" data-seq="(\d+)" aria-pressed="(\w+)" aria-label="([^"]*)">/g)].map(match => [match[1], match[2], match[3]]), [
    ['40', 'false', '事件 #40 用户消息，回读 2 步'], ['41', 'false', '事件 #41 工具结果，回读 1 步'],
  ]);
  const [axis, ...tracks] = section.split('<svg class="sw-rc-').slice(1);
  assert.deepEqual([...axis.matchAll(/class="sw-rc-lbl"[^>]*>([^<]*)</g)].map(match => match[1]), ['#0', '#1', '#2', '#3'], 'the zone of each seal, the first the one before it');
  assert.equal([...axis.matchAll(/<line class="sw-rc-seal"/g)].length, 3);
  assert.deepEqual(tracks.map(track => [[...track.matchAll(/class="sw-rc-ring"/g)].length, [...track.matchAll(/class="sw-rc-dot"/g)].length]), [[1, 2], [0, 1]], 'no landing, no ring');
  assert.deepEqual([...section.matchAll(/<small>([^<]*)<\/small>/g)].map(match => match[1]), ['回读 2 步', '回读 1 步']);
  assert.equal(section.includes('sw-rc-panel'), false, 'nothing chosen, no panel');
});

test('the number of seals is the answer\'s: a segment of one seal and one of many draw as many lines, and a narrow chart keeps its tracks at its own width', () => {
  const one = sectionOf(view(withTargets(TARGETS), { settlement: { ...VIEW, rows: [{ ...VIEW_ROWS[0], sealAt: 4 }] } }));
  assert.equal([...one.matchAll(/<line class="sw-rc-seal"/g)].length, 3, 'the axis and the track of each of the two rows, one line of the one seal in each');
  const rows = Array.from({ length: 12 }, (_, at) => ({ ...row(at + 1, { saved: 10, cost: 5, rebuild: 1, cut: 1 }), sealAt: at + 1 }));
  const many = sectionOf(view(withTargets(TARGETS), { settlement: { ...VIEW, steps: 12, rows } }));
  assert.equal([...many.matchAll(/<line class="sw-rc-seal"/g)].length, 12 * 3);
  const narrow = sectionOf(targetView({ graphWidth: 240 }));
  assert.deepEqual([...narrow.matchAll(/<svg class="sw-rc-(?:axis|track)" width="(\d+)"/g)].map(match => match[1]), ['240', '240', '240']);
});

test('a chosen row is pressed and its panel says what it is, where its original stands and the steps that read it, a read being a button to its call only where the chart has that call, which the chart rings', () => {
  const html = targetView({ state: chosen(40) });
  assert.match(sectionOf(html), /data-seq="40" aria-pressed="true"/);
  assert.match(sectionOf(html), /data-seq="41" aria-pressed="false"/);
  const panel = html.slice(html.indexOf('<div class="sw-rc-panel"'));
  assert.equal(textOf(withClass(panel, 'sw-rc-title')[0]), '事件 #40 用户消息');
  assert.equal(textOf(withClass(panel, 'sw-rc-landing')[0]), '原事件在第 2 步（#0 首封存前）');
  assert.deepEqual([...panel.matchAll(/<button type="button" class="sw-rc-read" aria-label="([^"]*)">([^<]*)</g)].map(match => [match[1], match[2]]), [['第 4 步，定位到图上第 4 次调用', '第 4 步'], ['第 8 步，定位到图上第 7 次调用', '第 8 步']]);
  assert.equal(tagsOf(html, 'sw-cx-ring').length, 2, 'the calls the reads link to');
  const other = targetView({ state: chosen(41) });
  assert.equal(textOf(withClass(other, 'sw-rc-landing')[0]), '原事件位置不明', 'no landing is said, not guessed');
  assert.equal(tagsOf(other, 'sw-cx-ring').length, 0, 'a read with no call of the chart rings none and is no button');
  assert.equal(/<button[^>]*sw-rc-read/.test(other), false);
  assert.equal(textOf(withClass(other, 'sw-rc-read')[0]), '第 6 步');
  assert.equal(tagsOf(targetView(), 'sw-cx-ring').length, 0, 'none chosen, none ringed');
});

test('the text of the chosen target shows what the read is: loading, failed, none, whole where short, an excerpt with the button that shows the rest and a button that takes it back', () => {
  const read = text => ({ kind: 'ready', value: { seq: 40, type: 'user/message', text } });
  const panelOf = (text, state = chosen(40)) => { const html = targetView({ state, text }); return html.slice(html.indexOf('<div class="sw-rc-panel"')); };
  assert.match(panelOf(null), /data-sw-monitor-notice="recall-text-loading"/);
  assert.match(panelOf({ kind: 'unreachable', message: 'boom' }), /原文读取失败：boom/);
  assert.match(panelOf({ kind: 'unavailable' }), /data-sw-monitor-notice="recall-text-failed"/);
  assert.match(panelOf(read(null)), /data-sw-recall-text="none">该事件没有文字/);
  assert.equal(panelOf(read(null)).includes('sw-rc-more'), false, 'no text, nothing to expand');
  const short = panelOf(read('请把结算页改成分段展示'));
  assert.match(short, /<pre class="sw-rc-text" data-sw-recall-text="whole">请把结算页改成分段展示<\/pre>/);
  assert.equal(short.includes('sw-rc-more'), false);
  const long = '字'.repeat(300);
  const excerpt = panelOf(read(long));
  assert.match(excerpt, new RegExp(`<pre class="sw-rc-text" data-sw-recall-text="excerpt">${'字'.repeat(280)}…</pre>`));
  assert.match(excerpt, /<button type="button" class="sw-rc-more" aria-expanded="false">展开全文（300 字）<\/button>/);
  const whole = panelOf(read(long), reduceContext(chosen(40), { type: 'expand' }));
  assert.match(whole, new RegExp(`<pre class="sw-rc-text" data-sw-recall-text="whole">${long}</pre>`));
  assert.match(whole, /aria-expanded="true">收起<\/button>/);
  assert.equal(panelOf(read('<b>&</b>')).includes('<b>&amp;</b>'), false, 'the text is text: set through React, escaped');
});

test('a press on a row chooses its target, a press on a read that has a call places the cursor on it, and the expand button asks to expand', () => {
  const dispatched = [];
  const tree = expand(ContextView({
    model: contextPageOf(SEALED_VIEW, withTargets(TARGETS), 1300, t), state: chosen(40), dispatch: action => dispatched.push(action), width: 392, lamWidth: 300, graphWidth: 392,
    chartRef: null, lamRef: null, graphRef: null, text: { kind: 'ready', value: { seq: 40, type: 'user/message', text: '字'.repeat(300) } }, t,
  }));
  const rows = findAll(tree, node => node.type === 'button' && node.props.className === 'sw-rc-row');
  rows[1].props.onClick();
  const reads = findAll(tree, node => node.type === 'button' && node.props.className === 'sw-rc-read');
  reads[1].props.onClick();
  findAll(tree, node => node.type === 'button' && node.props.className === 'sw-rc-more')[0].props.onClick();
  assert.deepEqual(dispatched, [{ type: 'target', seq: 41 }, { type: 'cursor', at: 7 }, { type: 'expand' }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(reads.map(node => node.props['aria-label']), ['第 4 步，定位到图上第 4 次调用', '第 8 步，定位到图上第 7 次调用']);
});

test('the section is there only for evidence the page can place on an axis: no answer, a failed one, an older host\'s and a segment with no compaction have none, and a segment confirmed to hold no target says so', () => {
  for (const result of [null, { kind: 'unavailable' }, ready(VIEW_CALLS)]) assert.equal(view(result, { settlement: SEALED_VIEW }).includes('sw-rc'), false, JSON.stringify(result)?.slice(0, 30));
  const none = targetView({ result: withTargets([]) });
  assert.match(none, /<p class="sw-mon-note" data-sw-recall="none">未观察到召回目标<\/p>/);
  assert.equal(none.includes('sw-rc-list'), false);
  assert.equal(textOf(withClass(sectionOf(none), 'sw-cx-h')[0]), '召回目标0 个目标');
});

test('a segment with a target read after more than one seal says so beside the count', () => {
  const html = targetView({ result: withTargets([{ seq: 40, type: 'user/message', at: 2, reads: [{ at: 4, seq: 4 }, { at: 8, seq: 7 }] }]) });
  assert.equal(textOf(withClass(sectionOf(html), 'sw-cx-h')[0]), '召回目标1 个目标 · 1 个跨封存重复');
});

// ── The words ────────────────────────────────────────────────────────────────

test('every text the page asks for, whichever of its states it draws, has a text in both locales', () => {
  const asked = new Set();
  const spy = (key, params) => { asked.add(key); return localized(zh)(key, params); };
  const statesOf = cursor => [
    createContextState(),
    reduceContext(reduceContext(reduceContext(createContextState(), { type: 'cursor', at: cursor }), { type: 'fold', name: 'rows', open: true }), { type: 'share', value: 0.4 }),
    reduceContext(createContextState(), { type: 'share', value: 0 }),
  ];
  const settlements = [VIEW, { ...VIEW, rows: [row(1, { saved: 1000, cost: 300, rebuild: 100, cut: 100 })] }, { ...VIEW, rows: [row(1, { saved: 500, cost: 300, rebuild: 0, cut: 100 })] }];
  for (const settlement of settlements) {
    const calls = settlement === VIEW ? VIEW_CALLS : [call(1, 900), call(2, 1000, true), call(3, 1100)];
    for (const result of [ready(calls), null, { kind: 'unavailable' }]) {
      for (const state of statesOf(calls.length > 3 ? 4 : 2)) {
        for (const line of [1300, null, 100]) view(result, { settlement, state, line, translate: spy });
      }
    }
  }
  const noStock = contextPageOf(VIEW, ready(VIEW_CALLS), 1300, spy);
  readoutOf(noStock.stock.series, 1300, 5, spy);
  shareReadoutOf(noStock.cache.sums, 0.5, spy);
  for (const dictionary of [zh, en]) {
    for (const key of asked) assert.equal(typeof dictionary[key], 'string', key);
  }
  assert.equal(asked.size > 0, true);
  assert.equal(asked.has('monitor.context.cache.crossing'), true);
  assert.equal(asked.has('monitor.context.cache.row.labelNone'), true);
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of asked) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key);
});

test('the English page words the same figures with the same placeholders', () => {
  const html = view(evidence(VIEW_CALLS), { translate: localized(en) });
  assert.match(html, /Settlement cost/);
  assert.match(html, /Total 1,600/);
  assert.match(html, /Rebuild overpay trial/);
  assert.match(html, /Rebuild overpay counted as it is → net −400/);
  assert.equal(html.includes('Deepening line 1.3k'), true);
  assert.equal(html.includes('The net turns positive once the rebuild overpay falls below 56.5%'), true);
  assert.equal(html.includes('undefined'), false);
});
