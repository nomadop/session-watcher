// The payback page of the settlement drawer: its display model, `monitor-settlement-model.js`, and its view, `monitor-settlement.js`, rendered to a string over that model.
// A server render proves the markup and the attributes the style and the screen reader read; the buttons' handlers are called over the element tree to show which action each hands the reducer, and the measuring of the chart's width, which a ref callback does, is not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { paybackCurveOf } from '../public/lib/compactionEconomics.js';
import {
  settlementPageOf, sortRows, curveGeometryOf, createPaybackState, reducePayback,
} from '../dsh/src/client/monitor-settlement-model.js';
import { DEFAULT_CHART_WIDTH } from '../dsh/src/client/monitor-state.js';
import { PaybackView, PaybackPage } from '../dsh/src/client/monitor-settlement.js';
import { en, zh } from '../dsh/src/client/locales.js';
import { paying } from './helpers/dsh-monitor-wire.js';

const localized = dictionary => (key, params) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]));
const t = localized(zh);
const textOf = html => html.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** A compaction of a settlement as `settlementsOf` has it, built from the figures the page reads: it cut `cut` tokens off a context of 100000 and cost `cost`, `rebuild` of it the cache's. */
function knownRow(ordinal, { steps, sealAt, cost, cut, rebuild = cost / 4 }) {
  const follow = steps - sealAt;
  const needed = cut > 0 ? Math.ceil(Math.round(cost) / cut) : Infinity;
  return {
    id: ordinal, ordinal, saved: follow * Math.max(0, cut), cost, before: 100_000, after: 100_000 - cut, cut, follow, sealAt, costRebuild: rebuild, needed, gap: Number.isFinite(needed) ? needed - follow : null,
  };
}
const unknownRow = (ordinal, { steps, sealAt, cut }) => ({
  id: ordinal, ordinal, saved: null, cost: null, before: 100_000, after: 100_000 - cut, cut, follow: steps - sealAt, sealAt, costRebuild: null, needed: null, gap: null,
});
function settlementOf(steps, rows, epoch = 1) {
  const known = rows.filter(row => row.saved !== null);
  return { epoch, count: rows.length, steps, saved: known.reduce((sum, row) => sum + row.saved, 0), cost: known.reduce((sum, row) => sum + row.cost, 0), rows };
}

// A segment of 20 steps whose five compactions show each shape of a row's plot: the steps it took beyond what it needed, none of its figures known, nothing cut so never paid back, the steps it still lacked within the segment, and the steps it lacked beyond it.
const FIVE = settlementOf(20, [
  knownRow(1, { steps: 20, sealAt: 5, cost: 30_000, cut: 10_000, rebuild: 10_000 }),
  unknownRow(2, { steps: 20, sealAt: 10, cut: 5_000 }),
  knownRow(3, { steps: 20, sealAt: 15, cost: 12_345.6, cut: 0, rebuild: 5_000.4 }),
  knownRow(4, { steps: 20, sealAt: 16, cost: 24_000, cut: 2_000, rebuild: 4_000 }),
  knownRow(5, { steps: 20, sealAt: 20, cost: 40_000, cut: 1_000, rebuild: 8_000 }),
]);
// One compaction sealed at step 4 of 10 that cost 100 and cut 30 a step: the net is 0 up to step 3, −100 at 4, then rises by 30 a step.
const SINGLE = settlementOf(10, [knownRow(1, { steps: 10, sealAt: 4, cost: 100, cut: 30, rebuild: 40 })]);
// The same compaction in a segment of 40 steps, which climbs to +980: past `CLIP_DEPTH_RATIO` times its depth.
const CLIMBING = settlementOf(40, [knownRow(1, { steps: 40, sealAt: 4, cost: 100, cut: 30, rebuild: 40 })]);

// Only an adjusted settlement is shown: these tests of the figures read it from an answer that is evidence of recall (the activity here has a judged step to its share), the status pages are tested apart.
const ACTIVITY = { covered: true, judged: 8, pure: 3, targets: [] };
const READY = { kind: 'ready', value: { calls: [], activity: ACTIVITY } };
const pageOf = (settlement, translate = t) => settlementPageOf(settlement, translate, READY);
const geometryOf = (settlement, width, clipped = false) => curveGeometryOf(paybackCurveOf(settlement), width, clipped, t);

// ── The header and the facts ──────────────────────────────────────────────────

test('the header shows the settlement totals in compact notation and keeps the compaction count, steps and payback percentage', () => {
  assert.deepEqual(pageOf(FIVE).header, ['压缩 5 次', '步数 20', '节省 158.0k', '成本 106.3k', '盈亏 +51.7k', '回本 148%']);
  assert.deepEqual(pageOf(SINGLE).header, ['压缩 1 次', '步数 10', '节省 180', '成本 100', '盈亏 +80', '回本 180%']);
  assert.deepEqual(pageOf(SINGLE, (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join(',')})`)).header.slice(2, 5), ['monitor.settlement.saved(180)', 'monitor.settlement.cost(100)', 'monitor.settlement.net(+80)'], 'the texts of the list\'s own parts');
});

test('the formula precedes the lowest net with its step, the steps below zero and the median of the steps needed', () => {
  assert.deepEqual(pageOf(FIVE).facts, ['盈亏 +51.7k ≈ 节省 158.0k − 成本 106.3k', '最低 −30.0k（第 5 步）', '低于 0：第 5–7 步', '回本所需步数中位 12 步']);
  assert.deepEqual(pageOf(SINGLE).facts, ['盈亏 +80 = 节省 180 − 成本 100', '最低 −100（第 4 步）', '低于 0：第 4–7 步']);
});

test('the steps below zero are named by their runs, a run of one step by that step and a run that lasts to the end of the segment by where it starts, joined by the locale\'s separator', () => {
  const rows = [knownRow(1, { steps: 8, sealAt: 2, cost: 10, cut: 20 }), knownRow(2, { steps: 8, sealAt: 6, cost: 100, cut: 0 })];
  assert.deepEqual(pageOf(settlementOf(8, rows)).facts.at(-1), '低于 0：第 2 步、第 6–7 步', 'two runs, the first of one step');
  assert.deepEqual(pageOf(settlementOf(8, [knownRow(1, { steps: 8, sealAt: 3, cost: 40, cut: 0 })])).facts.at(-1), '低于 0：第 3 步起至段末');
  assert.deepEqual(pageOf(settlementOf(8, [knownRow(1, { steps: 8, sealAt: 8, cost: 40, cut: 0 })])).facts.at(-1), '低于 0：第 8 步', 'a run of one step at the end is that step');
  assert.deepEqual(pageOf(settlementOf(8, rows), localized(en)).facts.at(-1), 'Below 0: step 2, steps 6–7');
});

test('the chart is spoken in one text: the lowest net, the steps below zero and the end net, and when seal costs are counted', () => {
  assert.equal(pageOf(SINGLE).chart.label, '累计盈亏曲线。最低 −100（第 4 步）。低于 0：第 4–7 步。段末 +80。压缩成本在封存步计入。');
  assert.equal(pageOf(FIVE).chart.label, '累计盈亏曲线。最低 −30.0k（第 5 步）。低于 0：第 5–7 步。段末 +51.7k。压缩成本在封存步计入。');
  assert.equal(pageOf(SINGLE, localized(en)).chart.label, 'Cumulative net curve. Lowest −100 (step 4). Below 0: steps 4–7. End +80. Each compaction’s cost is counted at its seal.', 'the locale joins the sentences');
});

test('the chart says it includes adjustments only where the answer has recall to adjust by', () => {
  const recall = { steps: [{ at: 5, seq: 50, usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 0 }, ratio: 2 }], cuts: [] };
  const withRecall = settlementPageOf(SINGLE, t, { kind: 'ready', value: { calls: [], activity: ACTIVITY, recall } });
  assert.ok(withRecall.chart.label.endsWith(zh['monitor.payback.chart.recallTail']));
  assert.ok(pageOf(SINGLE).chart.label.endsWith(zh['monitor.payback.chart.tail']), 'a ready answer with nothing to adjust by');
});

test('the axis may be clipped only when the curve goes above `CLIP_DEPTH_RATIO` times the depth of its lowest point', () => {
  assert.equal(pageOf(SINGLE).chart.clippable, false, 'a top of 80 over a depth of 100');
  assert.equal(pageOf(FIVE).chart.clippable, false);
  assert.equal(pageOf(CLIMBING).chart.clippable, true, 'a top of 980 over a depth of 100');
  // A compaction sealed at the first step costs 100 and rises by 100 a step: the net at step n is 100 n − 100, and the depth 100.
  const at = (cost, steps) => pageOf(settlementOf(steps, [knownRow(1, { steps, sealAt: 0, cost, cut: 100 })])).chart.clippable;
  assert.equal(at(100, 5), false, 'a top of 400 at step 5 is exactly `CLIP_DEPTH_RATIO` times the depth of 100');
  assert.equal(at(100, 6), true, 'a top of 500 is over it');
  assert.equal(at(100, 3), false);
});

// ── The rows ─────────────────────────────────────────────────────────────────

test('a row says in its label how many steps the compaction took, how many it needed and by how much they differ, the dash for a figure it has none of and the unbounded sign for a compaction that never pays back', () => {
  assert.deepEqual(pageOf(FIVE).rows.map(row => row.label), [
    '压缩 #1：实际 15 步，需要 3 步，相差 −12',
    '压缩 #2：实际 10 步，需要 —',
    '压缩 #3：实际 5 步，需要 ∞',
    '压缩 #4：实际 4 步，需要 12 步，相差 +8',
    '压缩 #5：实际 0 步，需要 40 步，相差 +40',
  ]);
  assert.equal(pageOf(FIVE, localized(en)).rows[0].label, 'Compaction #1: 15 steps taken, 3 steps needed, gap −12');
});

test('a row\'s three numbers are the steps taken, the steps needed and the gap, a dash where it is not known, the unbounded sign for the steps a compaction that cut nothing needed, and the gap signed', () => {
  assert.deepEqual(pageOf(FIVE).rows.map(row => row.cells), [
    { actual: '15', needed: '3', gap: '−12' },
    { actual: '10', needed: '—', gap: '—' },
    { actual: '5', needed: '∞', gap: '—' },
    { actual: '4', needed: '12', gap: '+8' },
    { actual: '0', needed: '40', gap: '+40' },
  ]);
  const zero = pageOf(settlementOf(20, [knownRow(1, { steps: 20, sealAt: 5, cost: 30_000, cut: 2_000 })])).rows[0];
  assert.deepEqual([zero.cells.needed, zero.cells.gap], ['15', '0'], 'a gap of none has no sign');
});

test('a row\'s plot puts the steps taken as a line with an end mark, the steps needed as a diamond, and between them the steps beyond what was needed or the steps still missing, each as a share of the segment', () => {
  const plots = pageOf(FIVE).rows.map(row => row.plot);
  assert.deepEqual(plots[0], { end: 75, diamond: 15, surplus: { left: 15, width: 60 }, missing: null, beyond: null, unbounded: false }, 'needed 3 of the 15 taken');
  assert.deepEqual(plots[3], { end: 20, diamond: 60, surplus: null, missing: { left: 20, width: 40 }, beyond: null, unbounded: false }, 'needed 12 of the 20 steps, 4 taken');
  assert.deepEqual(plots[4], { end: 0, diamond: null, surplus: null, missing: null, beyond: { left: 0, label: '40' }, unbounded: false }, 'needed 40 of the segment\'s 20: the line runs off the plot with the number');
  assert.deepEqual(plots[2], { end: 25, diamond: null, surplus: null, missing: null, beyond: null, unbounded: true }, 'a mark for what has no end');
  assert.deepEqual(plots[1], { end: 50, diamond: null, surplus: null, missing: null, beyond: null, unbounded: false }, 'no figures: the line and its end');
  const plotOf = (steps, sealAt, cut) => pageOf(settlementOf(steps, [knownRow(1, { steps, sealAt, cost: 30_000, cut })])).rows[0].plot;
  assert.deepEqual(plotOf(20, 5, 2_000), { end: 75, diamond: 75, surplus: null, missing: null, beyond: null, unbounded: false }, 'needed 15 of 15 taken: the diamond sits on the end, no step beyond');
  assert.deepEqual(plotOf(20, 0, 1_500), { end: 100, diamond: 100, surplus: null, missing: null, beyond: null, unbounded: false }, 'needed 20 of 20');
  assert.deepEqual(plotOf(20, 19, 1_500).missing, { left: 5, width: 95 }, 'needed 20 of the segment\'s 20 with 1 taken: within the plot');
  assert.deepEqual(plotOf(20, 19, 1_428).beyond, { left: 5, label: '22' }, 'needed 22: beyond it');
});

test('the appendix keeps known cost and step counts even when a compaction has no before/after reading', () => {
  const noCut = { ...knownRow(1, { steps: 20, sealAt: 10, cost: 30_000, cut: 5_000, rebuild: 10_000 }), before: null, after: null, cut: null, needed: null, gap: null };
  const page = pageOf(settlementOf(20, [noCut]));
  assert.deepEqual(page.rows[0].cells, { actual: '10', needed: '—', gap: '—' });
  assert.equal(page.rows[0].label, '压缩 #1：实际 10 步，需要 —');
  assert.deepEqual(page.appendix.rows[0].cells, ['#1', '10', '—', '30,000', '20,000', '10,000', '—', '10', '—', '—', '−30,000']);
});

test('the rows are in the order of their ordinals, or those with a gap first by the gap, the largest first and equal gaps by ordinal, then the rest in their order', () => {
  const rows = pageOf(FIVE).rows;
  assert.deepEqual(sortRows(rows, 'ordinal').map(row => row.ordinal), [1, 2, 3, 4, 5]);
  assert.deepEqual(sortRows(rows, 'gap').map(row => row.ordinal), [5, 4, 1, 2, 3], 'the gaps +40, +8, −12, then the rows with none');
  const tied = pageOf(settlementOf(20, [
    knownRow(1, { steps: 20, sealAt: 4, cost: 1_000, cut: 100 }),
    knownRow(2, { steps: 20, sealAt: 8, cost: 1_300, cut: 100 }),
    knownRow(3, { steps: 20, sealAt: 12, cost: 1_000, cut: 100 }),
    knownRow(4, { steps: 20, sealAt: 15, cost: 1_300, cut: 100 }),
  ])).rows;
  assert.deepEqual(tied.map(row => row.cells.gap), ['−6', '+1', '+2', '+8'], 'needed 10 and 13 against 16, 12, 8 and 5 taken');
  assert.deepEqual(sortRows(tied, 'gap').map(row => row.ordinal), [4, 3, 2, 1]);
  const equal = pageOf(settlementOf(20, [knownRow(1, { steps: 20, sealAt: 4, cost: 1_000, cut: 100 }), knownRow(2, { steps: 20, sealAt: 4, cost: 1_000, cut: 100 }), knownRow(3, { steps: 20, sealAt: 4, cost: 1_000, cut: 100 })])).rows;
  assert.deepEqual(sortRows(equal, 'gap').map(row => row.ordinal), [1, 2, 3], 'equal gaps keep the order of the ordinals');
  assert.deepEqual(sortRows([...equal].reverse(), 'gap').map(row => row.ordinal), [1, 2, 3], 'whatever order they come in');
  assert.deepEqual(rows.map(row => row.ordinal), [1, 2, 3, 4, 5], 'a sort leaves the model\'s rows as they are');
});

test('the axis over the rows is the first step, the middle of the segment and its last step', () => {
  assert.deepEqual(pageOf(FIVE).axis, { mid: '10', end: '20 步' });
  assert.deepEqual(pageOf(SINGLE).axis, { mid: '5', end: '10 步' });
  assert.equal(pageOf(settlementOf(217, [knownRow(1, { steps: 217, sealAt: 4, cost: 100, cut: 30 })])).axis.mid, '109', 'rounded');
});

// ── The appendix ─────────────────────────────────────────────────────────────

test('the appendix lists compactions in ordinal order with the readings, cost and its parts, and net at the seal step', () => {
  const { appendix } = pageOf(FIVE);
  assert.deepEqual(appendix.head, ['#k', '封存步', '压缩前后', '成本', '摘要调用', '缓存重建', '每步节省', '实际', '需要', '相差', '累计盈亏']);
  assert.deepEqual(appendix.rows.map(row => row.cells), [
    ['#1', '5', '100,000 → 90,000', '30,000', '20,000', '10,000', '10,000', '15', '3', '−12', '−30,000'],
    ['#2', '10', '100,000 → 95,000', '—', '—', '—', '—', '10', '—', '—', '—'],
    ['#3', '15', '100,000 → 100,000', '12,346', '7,346', '5,000', '0', '5', '∞', '—', '+57,654'],
    ['#4', '16', '100,000 → 98,000', '24,000', '20,000', '4,000', '2,000', '4', '12', '+8', '+43,654'],
    ['#5', '20', '100,000 → 99,000', '40,000', '32,000', '8,000', '1,000', '0', '40', '+40', '+51,654'],
  ]);
  assert.deepEqual(appendix.rows.map(row => row.unknown), [false, true, false, false, false]);
});

// ── The curve's geometry ─────────────────────────────────────────────────────

test('the curve is drawn as its points over the plot, the net at a step by the step\'s share of the plot\'s width and the value\'s share of the height between the lowest net and the highest, with the zero line and the area under and over it', () => {
  const g = geometryOf(SINGLE, 392);
  assert.deepEqual([g.width, g.height, g.gutter, g.plotWidth, g.plotHeight], [392, 206, 34, 352, 170]);
  assert.equal(g.line, 'M34.0,80.9L69.2,80.9L104.4,80.9L139.6,80.9L174.8,162.0L210.0,137.7L245.2,113.3L280.4,89.0L315.6,64.7L350.8,40.3L386.0,16.0');
  assert.equal(g.area, `${g.line}L386.0,80.9L34.0,80.9Z`);
  assert.equal(g.zeroY, 80.9);
  assert.deepEqual(g.clips, { plot: { x: 34, y: 0, width: 352, height: 170 }, above: { x: 0, y: 0, width: 392, height: 80.9 }, below: { x: 0, y: 80.9, width: 392, height: 89.1 } });
  assert.deepEqual(g.ticks, [
    { value: 0, label: '0', y: 80.9, grid: false, clip: false },
    { value: -100, label: '−100', y: 162, grid: true, clip: false },
    { value: 80, label: '+80', y: 16, grid: true, clip: false },
  ]);
  assert.equal(g.clipNote, null);
});

test('the seals are marks in a lane under the plot, one at the step of each compaction, whether or not its figures are known', () => {
  const g = geometryOf(settlementOf(10, [knownRow(1, { steps: 10, sealAt: 2, cost: 100, cut: 30 }), unknownRow(2, { steps: 10, sealAt: 5, cut: 10 })]), 392);
  assert.deepEqual(g.lane.seals, [104.4, 210]);
  assert.deepEqual([g.lane.y, g.lane.height, g.lane.label, g.labelX, g.lane.labelY], [174, 12, '封存', 29, 183]);
  assert.deepEqual(geometryOf(SINGLE, 392).lane.seals, [174.8]);
});

test('the lowest point is marked and named beside it, to its right while it lies in the left half of the plot and to its left in the right half, and the end of the segment is marked and named above it where the net rose', () => {
  const g = geometryOf(SINGLE, 392);
  assert.deepEqual(g.lowest, { x: 174.8, y: 162, label: { text: '最低 −100', x: 181.8, y: 166, anchor: 'start' } });
  assert.deepEqual(g.end, { x: 386, y: 16, above: false, label: { text: '段末 +80', x: 379, y: 11, anchor: 'end' } });
  const right = geometryOf(settlementOf(10, [knownRow(1, { steps: 10, sealAt: 8, cost: 100, cut: 30 })]), 392);
  assert.deepEqual(right.lowest, { x: 315.6, y: 162, label: { text: '最低 −100', x: 308.6, y: 166, anchor: 'end' } }, 'at step 8 of 10 the lowest point lies in the right half, its label 7 off the point');
});

test('the end label sits below the end point where the net fell at the last step, and gives way where it would cover the lowest label', () => {
  const down = geometryOf(settlementOf(10, [knownRow(1, { steps: 10, sealAt: 10, cost: 100, cut: 0 })]), 392);
  assert.deepEqual(down.lowest, { x: 386, y: 162, label: { text: '最低 −100', x: 379, y: 166, anchor: 'end' } });
  assert.equal(down.end.label, null, 'the end is the lowest point and its label would lie over the lowest label');
  assert.deepEqual([down.end.x, down.end.y], [386, 162], 'its mark stays');
  const fell = geometryOf(settlementOf(12, [knownRow(1, { steps: 12, sealAt: 2, cost: 1_000, cut: 200 }), knownRow(2, { steps: 12, sealAt: 12, cost: 1_000, cut: 0 })]), 392);
  assert.equal(fell.end.label.y, Math.round((fell.end.y + 14) * 10) / 10, 'below the point where the last step fell, from 800 to 0');
  const rose = geometryOf(settlementOf(12, [knownRow(1, { steps: 12, sealAt: 2, cost: 1_000, cut: 200 })]), 392);
  assert.equal(rose.end.label.y, Math.max(rose.end.y - 7, 11), 'above it where it rose');
});

test('a label is kept inside the plot\'s left edge and the chart\'s right edge', () => {
  const toRight = geometryOf(SINGLE, 120).lowest;
  assert.deepEqual([toRight.label.anchor, toRight.label.x], ['start', 72.6], 'its text would run to 120.4 from 73, so it starts at 72.6');
  const toLeft = geometryOf(settlementOf(10, [knownRow(1, { steps: 10, sealAt: 8, cost: 100, cut: 30 })]), 90).lowest;
  assert.deepEqual([toLeft.label.anchor, toLeft.label.x], ['end', 81.4], 'its text would start at 19.6 left of the plot\'s 34, so its box starts there and ends at 81.4');
});

test('a clipped axis tops at `CLIP_TOP_RATIO` times the depth, the curve above it is cut and the end above it is an arrow with an upward label, and the note names the step the curve first goes over', () => {
  const g = geometryOf(CLIMBING, 392, true);
  assert.deepEqual(g.ticks, [
    { value: 0, label: '0', y: 120.3, grid: false, clip: false },
    { value: -100, label: '−100', y: 162, grid: true, clip: false },
    { value: 250, label: '+250', y: 16, grid: true, clip: true },
  ]);
  assert.equal(g.clipNote, '纵轴截断于 +250，曲线自第 16 步起超出。');
  assert.deepEqual(g.end, { x: 386, y: null, above: true, arrow: 'M382,21h8l-4,-7z', label: { text: '段末 +980 ↑', x: 379, y: 26, anchor: 'end' } });
  const full = geometryOf(CLIMBING, 392, false);
  assert.deepEqual(full.ticks.map(tick => tick.label), ['0', '−100', '+980']);
  assert.equal(full.clipNote, null);
  assert.deepEqual(full.end, { x: 386, y: 16, above: false, label: { text: '段末 +980', x: 379, y: 11, anchor: 'end' } });
  assert.equal(full.ticks.some(tick => tick.clip), false);
});

test('the plot is taller as the chart is wider and the gutter wide enough for the widest label of the axis', () => {
  assert.deepEqual([300, 392, 700].map(width => geometryOf(SINGLE, width).plotHeight), [150, 170, 200]);
  assert.deepEqual([300, 392, 700].map(width => geometryOf(SINGLE, width).height), [186, 206, 236], 'the plot, the lane and the row of steps');
  const deep = geometryOf(settlementOf(10, [knownRow(1, { steps: 10, sealAt: 2, cost: 10_000_000, cut: 3_000_000 })]), 392);
  assert.deepEqual(deep.ticks.map(tick => tick.label), ['0', '−10.0m', '+14.0m']);
  assert.deepEqual([deep.gutter, deep.plotWidth], [43, 343], 'six characters of the axis label, 5 off the axis');
  assert.equal(deep.labelX, 38);
  assert.equal(deep.lowest.label.text, '最低 −10.0m', 'the marks\' labels read in compact counts as the axis does');
  assert.equal(deep.end.label.text, '段末 +14.0m');
});

test('the steps along the plot are at the nicest step that keeps a tick `TICK_MIN_PX` apart, the last step added where it lies at least `END_TICK_MIN_PX` from the one before', () => {
  const geometryAt = steps => geometryOf(settlementOf(steps, [knownRow(1, { steps, sealAt: 1, cost: 100, cut: 1 })]), 392);
  const ticksOf = steps => geometryAt(steps).steps.ticks.map(tick => tick.label);
  assert.deepEqual(ticksOf(10), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.deepEqual(ticksOf(217), ['0', '25', '50', '75', '100', '125', '150', '175', '200'], 'the last step lies 27.6 from 200');
  assert.equal(ticksOf(220).at(-1), '220', 'and here 32');
  assert.equal(ticksOf(220).length, 10);
  const g = geometryAt(217);
  assert.deepEqual([g.steps.unit, g.steps.unitX, g.steps.y], ['步', 0, 202]);
  assert.deepEqual(g.steps.ticks.slice(0, 2).map(tick => tick.x), [34, 74.6]);
});

test('a chart narrower than its gutter and margin has a plot of no width and no negative size to draw', () => {
  for (const width of [0, 20, 40]) {
    const g = geometryOf(SINGLE, width);
    assert.equal(g.plotWidth, 0, `a chart ${width} wide`);
    assert.equal(g.clips.plot.width, 0);
    assert.equal(g.clips.above.width >= 0 && g.clips.below.width >= 0, true);
  }
});

test('a segment of no step draws without a number out of range', () => {
  const settlement = settlementOf(0, [knownRow(1, { steps: 0, sealAt: 0, cost: 10, cut: 3 })]);
  const g = geometryOf(settlement, 392);
  const numbers = (value) => {
    if (typeof value === 'number') return [value];
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(numbers);
    return [];
  };
  assert.equal(numbers(g).every(Number.isFinite), true);
  assert.equal(g.line, 'M34.0,162.0');
  assert.deepEqual(g.steps.ticks, [{ x: 34, label: '0' }]);
  const { plot } = pageOf(settlement).rows[0];
  assert.deepEqual([plot.end, plot.beyond.left], [0, 0], 'the plot of a segment of no step is its one end');
});

// ── The view state ───────────────────────────────────────────────────────────

test('a new page sorts by ordinal and clips the axis; controls can change either without mutating the state', () => {
  const state = createPaybackState();
  assert.deepEqual(state, { sort: 'ordinal', full: false });
  assert.equal(reducePayback(state, { type: 'sort', sort: 'gap' }).sort, 'gap');
  assert.equal(reducePayback(reducePayback(state, { type: 'axis' }), { type: 'axis' }).full, false);
  assert.equal(reducePayback(state, { type: 'axis' }).full, true);
  assert.equal(reducePayback(state, { type: 'nothing' }), state);
  assert.deepEqual(state, { sort: 'ordinal', full: false }, 'never changed in place');
});

// ── The view ─────────────────────────────────────────────────────────────────

const noop = () => {};
const view = (settlement, { state = createPaybackState(), width = 392, translate = t, dispatch = noop, result = READY } = {}) => renderToString(React.createElement(PaybackView, { model: settlementPageOf(settlement, translate, result), state, dispatch, width, t: translate }));
const tagsOf = (html, className) => [...html.matchAll(new RegExp(`<[a-z0-9]+\\s[^>]*class="${className}"[^>]*>`, 'g'))].map(([tag]) => tag);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const withClass = (html, className) => [...html.matchAll(new RegExp(`<([a-z0-9]+)\\s[^>]*class="${className}"[^>]*>(.*?)</\\1>`, 'gs'))].map(match => match[2]);

test('a new page is the header and facts, the curve with its axis, the plot rows, the appendix folded and the unit once, and it holds no preformatted block and no total', () => {
  const html = view(FIVE);
  assert.deepEqual([...withClass(html, 'sw-pb-head')[0].matchAll(/<span>(.*?)<\/span>/g)].map(match => match[1]), ['压缩 5 次 ·', '步数 20 ·', '节省 158.0k ·', '成本 106.3k ·', '盈亏 +51.7k ·', '回本 148%']);
  assert.deepEqual([...withClass(html, 'sw-pb-facts')[0].matchAll(/<p>(.*?)<\/p>/g)].map(match => match[1]), ['盈亏 +51.7k ≈ 节省 158.0k − 成本 106.3k', '最低 −30.0k（第 5 步）', '低于 0：第 5–7 步', '回本所需步数中位 12 步']);
  assert.equal(withClass(html, 'sw-pb-facts')[0].includes('<b'), false, 'plain text, no emphasis in a fact');
  assert.equal(html.includes('<pre'), false);
  assert.equal(html.includes('合计'), false);
  assert.equal([...html.matchAll(/单位：读价 token/g)].length, 1, 'the unit once');
  assert.equal(tagsOf(html, 'sw-pb-unit').length, 1);
  assert.match(html, /<details class="sw-pb-table">/, 'the appendix starts folded');
});

test('the curve is one picture: an image with the spoken text, its own ids, no control but the axis button, and the text of the lowest and end marks inside', () => {
  const html = view(SINGLE);
  const svg = /<svg\b[^>]*>/.exec(html)[0];
  assert.equal(attr(svg, 'role'), 'img');
  assert.equal(attr(svg, 'aria-label'), pageOf(SINGLE).chart.label);
  assert.deepEqual([attr(svg, 'width'), attr(svg, 'viewBox')], ['392', '0 0 392 206']);
  assert.match(html, /<pattern id="sw-pb-hatch"/);
  for (const id of ['sw-pb-plot-clip', 'sw-pb-above-clip', 'sw-pb-below-clip']) assert.match(html, new RegExp(`<clipPath id="${id}"`));
  assert.equal(/<svg\b.*<(?:button|a|input)\b/s.test(html.slice(html.indexOf('<svg'), html.indexOf('</svg>'))), false, 'nothing inside it to press');
  assert.equal(/onclick|onmouse|tabindex/i.test(html.slice(html.indexOf('<svg'), html.indexOf('</svg>'))), false);
  const svgText = textOf(html.slice(html.indexOf('<svg'), html.indexOf('</svg>')).replace(/<\/text>/g, ' </text>'));
  for (const word of ['最低 −100', '段末 +80', '封存', '0', '−100', '+80', '步']) assert.ok(svgText.includes(word), word);
  assert.equal(html.includes('sw-pb-axisbtn'), false, 'a curve that cannot be clipped has no button for it');
  assert.equal(html.includes('sw-pb-note'), false);
});

test('a curve that can be clipped has the axis button, pressed once the axis is full, and the note while it is clipped', () => {
  const clipped = view(CLIMBING);
  const [button] = tagsOf(clipped, 'sw-pb-axisbtn');
  assert.equal(attr(button, 'aria-pressed'), 'false');
  assert.match(clipped, /<button[^>]*class="sw-pb-axisbtn"[^>]*>纵轴：截断<\/button>/);
  assert.equal(textOf(withClass(clipped, 'sw-pb-note')[0]), '纵轴截断于 +250，曲线自第 16 步起超出。');
  assert.equal(clipped.includes('M382,21h8l-4,-7z'), true, 'the arrow of the end above the axis');
  const full = view(CLIMBING, { state: reducePayback(createPaybackState(), { type: 'axis' }) });
  assert.equal(attr(tagsOf(full, 'sw-pb-axisbtn')[0], 'aria-pressed'), 'true');
  assert.match(full, /<button[^>]*class="sw-pb-axisbtn"[^>]*>纵轴：完整<\/button>/);
  assert.equal(full.includes('sw-pb-note'), false);
  assert.equal(full.includes('M382,21h8l-4,-7z'), false);
  assert.match(full, /段末 \+980</);
});

test('each plot row is named by its step counts, and a row without figures is marked and its numbers muted', () => {
  const html = view(FIVE);
  const rows = tagsOf(html, 'sw-pb-li');
  assert.deepEqual(rows.map(tag => attr(tag, 'aria-label')), [
    '压缩 #1：实际 15 步，需要 3 步，相差 −12', '压缩 #2：实际 10 步，需要 —', '压缩 #3：实际 5 步，需要 ∞', '压缩 #4：实际 4 步，需要 12 步，相差 +8', '压缩 #5：实际 0 步，需要 40 步，相差 +40',
  ]);
  assert.deepEqual(rows.map(tag => attr(tag, 'data-unknown') !== undefined), [false, true, false, false, false]);
  const list = /<ul\b[^>]*>/.exec(html)[0];
  assert.equal(attr(list, 'aria-label'), '分段 #1 各次压缩的实际步数与需要步数');
  const unknown = withClass(html, 'sw-pb-li')[1];
  assert.deepEqual([...unknown.matchAll(/<span class="sw-pb-num"( data-muted="")?><small>(.*?)<\/small>(.*?)<\/span>/g)].map(match => [match[1] !== undefined, match[2], match[3]]), [[true, '实际', '10'], [true, '需要', '—'], [true, '相差', '—']]);
  const known = withClass(html, 'sw-pb-li')[0];
  assert.deepEqual([...known.matchAll(/<span class="sw-pb-num">(?:<small>.*?<\/small>)(.*?)<\/span>/g)].map(match => match[1]), ['15', '3', '−12']);
});

test('a row\'s plot is marks in a share of the plot: the line and its end, the diamond, the steps beyond or missing, the arrow and number of what lies past the plot and the sign of what has no end', () => {
  const plots = withClass(view(FIVE), 'sw-pb-plot');
  assert.equal(plots.length, 5);
  assert.equal(plots[0], '<i class="sw-pb-line" style="width:75%"></i><i class="sw-pb-surplus" style="left:15%;width:60%"></i><b class="sw-pb-end" style="left:75%"></b><b class="sw-pb-dia" style="left:15%"></b>');
  assert.equal(plots[1], '<i class="sw-pb-line" style="width:50%"></i><b class="sw-pb-end" style="left:50%"></b>');
  assert.equal(plots[2], '<i class="sw-pb-line" style="width:25%"></i><b class="sw-pb-end" style="left:25%"></b><em class="sw-pb-inf" style="left:25%">∞</em>');
  assert.equal(plots[3], '<i class="sw-pb-line" style="width:20%"></i><b class="sw-pb-end" style="left:20%"></b><i class="sw-pb-missing" style="left:20%;width:40%"></i><b class="sw-pb-dia" style="left:60%"></b>');
  assert.equal(plots[4], '<i class="sw-pb-line" style="width:0%"></i><b class="sw-pb-end" style="left:0%"></b><i class="sw-pb-missing" style="left:0%;right:7px"></i><b class="sw-pb-arrow"></b><em class="sw-pb-over">40</em>');
  assert.equal(/<span class="sw-pb-plot" aria-hidden="true">/.test(view(FIVE)), true, 'the numbers beside it carry what it shows');
});

test('payback abbreviates its formula and keeps the whole token figures and per-seal detail in the folded appendix only', () => {
  const html = view(FIVE);
  const [body, appendix] = html.split('<details class="sw-pb-table">');
  assert.match(body, /盈亏 \+51\.7k ≈ 节省 158\.0k − 成本 106\.3k/);
  assert.doesNotMatch(body, /51,654|158,000|106,346|100,000|90,000/);
  assert.doesNotMatch(body, /aria-expanded=/, 'the plot rows do not open their own detail');
  assert.match(appendix, /^<summary>附录：完整读数<\/summary>/);
  assert.match(appendix, /<th scope="row">盈亏 \+51,654<\/th><td>=<\/td><td>节省 158,000 − 成本 106,346<\/td>/);
  assert.match(appendix, /<td>100,000 → 90,000<\/td>/);
});

test('the sort buttons say which sort is on, and the rows follow it with the rows and their numbers the same', () => {
  const rowsOf = html => [...html.matchAll(/<li class="sw-pb-li"[^>]*aria-label="压缩 #(\d)/g)].map(match => Number(match[1]));
  const ordered = view(FIVE);
  assert.deepEqual(rowsOf(ordered), [1, 2, 3, 4, 5]);
  assert.deepEqual(tagsOf(ordered, 'sw-pb-sortbtn').map(tag => attr(tag, 'aria-pressed')), ['true', 'false']);
  const byGap = view(FIVE, { state: reducePayback(createPaybackState(), { type: 'sort', sort: 'gap' }) });
  assert.deepEqual(rowsOf(byGap), [5, 4, 1, 2, 3]);
  assert.deepEqual(tagsOf(byGap, 'sw-pb-sortbtn').map(tag => attr(tag, 'aria-pressed')), ['false', 'true']);
  assert.deepEqual(withClass(byGap, 'sw-pb-sortbtn'), ['#k', '相差 大→小']);
});

test('the legend names the four marks and the axis over the rows its columns, the gap\'s with its meaning as the tooltip', () => {
  const html = view(FIVE);
  assert.deepEqual(withClass(html, 'sw-pb-keys')[0].match(/<\/i>([^<]*)</g).map(text => text.slice(4, -1)), ['实际步数', '需要步数', '尚缺的步', '超出的步']);
  const axis = withClass(html, 'sw-pb-axis')[0];
  assert.deepEqual([...axis.matchAll(/<span class="sw-pb-(?:idh|num)"[^>]*>(.*?)<\/span>/g)].map(match => match[1]), ['#k', '实际', '需要', '相差']);
  assert.match(axis, /<span class="sw-pb-num" title="相差 = 需要 − 实际">相差<\/span>/);
  assert.deepEqual([...axis.matchAll(/<span class="sw-pb-tick[^"]*">(.*?)<\/span>/g)].map(match => match[1]), ['0', '10', '20 步']);
});

test('the compaction table in the appendix has row headers and can scroll sideways from the keyboard', () => {
  const html = view(FIVE);
  const scroller = /<div class="sw-pb-scroll"[^>]*>/.exec(html)[0];
  assert.equal(attr(scroller, 'tabindex'), '0');
  assert.equal(attr(scroller, 'aria-label'), '逐次压缩明细，可横向滚动');
  assert.match(html, /<table class="sw-pb-tbl" aria-label="逐次压缩明细">/);
  assert.match(html, /<tr data-unknown=""><th scope="row">#2<\/th><td>10<\/td><td>100,000 → 95,000<\/td><td>—<\/td>/);
});

test('the sort and axis controls dispatch their actions; the appendix uses the browser’s own disclosure', () => {
  const dispatched = [];
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
  const tree = expand(PaybackView({ model: settlementPageOf(CLIMBING, t, READY), state: createPaybackState(), dispatch: action => dispatched.push(action), width: 392, t }));
  const press = className => findAll(tree, node => node.props?.className === className);
  press('sw-pb-axisbtn')[0].props.onClick();
  press('sw-pb-sortbtn').forEach(node => node.props.onClick());
  assert.deepEqual(dispatched, [{ type: 'axis' }, { type: 'sort', sort: 'ordinal' }, { type: 'sort', sort: 'gap' }]);
  assert.equal(press('sw-pb-table').length, 1);
  assert.equal(press('sw-pb-table')[0].props.onToggle, undefined, 'the table keeps its own open state');
});

// An answer carries the recall activity unless the test says it is an older host's.
const monitorWithSettlement = value => ({ resource: () => ({ subscribe: () => () => {}, result: { kind: 'ready', value: { activity: ACTIVITY, ...value } } }) });

test('the page draws at the default width where no width was measured, which a server render has none of, and holds the same markup as the view over that width', () => {
  const html = renderToString(React.createElement(PaybackPage, { settlement: SINGLE, monitor: monitorWithSettlement({ calls: [] }), handoffId: 31, t }));
  assert.equal(attr(/<svg\b[^>]*>/.exec(html)[0], 'width'), String(DEFAULT_CHART_WIDTH));
  assert.equal(html.includes('sw-pb-chart'), true);
  assert.equal(html, view(SINGLE, { width: DEFAULT_CHART_WIDTH, result: { kind: 'ready', value: { calls: [], activity: ACTIVITY } } }));
});

test('the payback page charges a pure event-read request once, removes its credit and resident rent, and does not earn the same copy again when sealed', () => {
  const settlement = settlementOf(6, [
    knownRow(1, { steps: 6, sealAt: 1, cost: 5_000, cut: 10_000, rebuild: 1_000 }),
    knownRow(2, { steps: 6, sealAt: 4, cost: 4_000, cut: 3_000, rebuild: 500 }),
  ]);
  const recall = {
    steps: [
      { at: 2, seq: 18, usage: { input: 500, cacheRead: 4_000, cacheWrite: 500, output: 99 }, ratio: 2, post: 1 },
      { at: 3, seq: 23, resident: 800 }, { at: 4, seq: 24, resident: 800 },
    ],
    cuts: [{ id: 2, tokens: 800 }],
  };
  const monitor = monitorWithSettlement({ calls: [], recall });
  const html = renderToString(React.createElement(PaybackPage, { settlement, monitor, handoffId: 31, t }));
  const [body, appendix] = html.split('<details class="sw-pb-table">');
  assert.match(textOf(body), /节省 42\.8k.*成本 14\.0k.*盈亏 \+28\.8k.*回本 305%/);
  assert.ok(body.includes('盈亏 +28.8k ≈ 节省 42.8k − 成本 14.0k'));
  assert.ok(body.includes('节省 42.8k ≈ 原压缩节省 56.0k − 召回步节省 10.0k − 结果驻留冲减 1.6k − 后继封存节省修正 1.6k'));
  assert.ok(body.includes('成本 14.0k ≈ 原压缩成本 9.0k + 召回请求成本 6.0k − 已计入的缓存重建 1.0k'));
  assert.match(body, /最低 −10\.0k（第 2 步）/);
  assert.match(body, /段末 \+28\.8k/);
  const english = renderToString(React.createElement(PaybackPage, { settlement, monitor, handoffId: 31, t: localized(en) })).split('<details class="sw-pb-table">')[0];
  assert.ok(english.includes('Net +28.8k ≈ Saved 42.8k − Cost 14.0k'));
  assert.ok(english.includes('Saved 42.8k ≈ Base savings 56.0k − Recall-step savings 10.0k − Resident recall results 1.6k − Later-seal savings adjustment 1.6k'));
  assert.ok(english.includes('Cost 14.0k ≈ Base cost 9.0k + Recall request cost 6.0k − Cache rebuild already counted 1.0k'));
  assert.match(appendix, /<td>100,000 → 97,000<\/td>.*?<td>2,200（召回修正后）<\/td>/s);
  assert.match(appendix, /<th scope="row">成本 14,000<\/th><td>=<\/td><td>原压缩成本 9,000 \+ 召回请求成本 6,000 − 已计入的缓存重建 1,000<\/td>/);
  assert.equal(settlement.rows[1].cut, 3_000, 'the original list settlement is unchanged');
});

test('the payback formula identifies rounded terms without presenting them as an exact sum', () => {
  const settlement = settlementOf(3, [knownRow(1, { steps: 3, sealAt: 1, cost: 10.4, cut: 20, rebuild: 0 })]);
  const monitor = monitorWithSettlement({ calls: [], recall: {
    steps: [{ at: 2, seq: 18, usage: { input: 0, cacheRead: 0, cacheWrite: 1, output: 0 }, ratio: 1.4 }], cuts: [],
  } });
  const html = renderToString(React.createElement(PaybackPage, { settlement, monitor, handoffId: 31, t }));
  assert.ok(textOf(html).includes('盈亏 +8 = 节省 20 − 成本 12'));
  assert.ok(textOf(html).includes('成本 12 ≈ 原压缩成本 10 + 召回请求成本 1 − 已计入的缓存重建 0'));
});

// ── The share of pure recall steps ──────────────────────────────────────────

const shareText = html => textOf(/<p class="sw-pb-share">(.*?)<\/p>/.exec(html)?.[1] ?? '');
const pageWith = (value, settlement = SINGLE) => renderToString(React.createElement(PaybackPage, {
  settlement, monitor: { resource: () => ({ subscribe: () => () => {}, result: value }) }, handoffId: 31, t,
}));
const answerOf = activity => ({ kind: 'ready', value: { calls: [], ...(activity === undefined ? {} : { activity }) } });

test('the payback page shows the share of pure recall steps once the evidence proves its axis, and a dash where it does not; no evidence, no line', () => {
  assert.equal(shareText(pageWith(answerOf({ covered: true, judged: 8, pure: 3, targets: [] }))), '纯召回步占比 37.5%（3/8 步）');
  assert.equal(shareText(pageWith(answerOf({ covered: true, judged: 8, pure: 0, targets: [] }))), '纯召回步占比 0.0%（0/8 步）', 'confirmed to hold none');
  assert.equal(shareText(pageWith(answerOf({ covered: false, judged: 8, pure: 3, targets: [] }))), '纯召回步占比 —', 'coverage not proved');
  assert.equal(shareText(pageWith(answerOf({ covered: true, judged: 0, pure: 0, targets: [] }))), '纯召回步占比 —', 'nothing judged to share over');
  for (const value of [null, { kind: 'unreachable', message: 'x' }, { kind: 'unavailable' }, answerOf(undefined)]) {
    assert.equal(pageWith(value).includes('sw-pb-share'), false, JSON.stringify(value)?.slice(0, 30));
  }
});

test('the share does not wait for the figures: a settlement whose compactions are not all priced has it all the same', () => {
  const half = settlementOf(10, [knownRow(1, { steps: 10, sealAt: 3, cost: 100, cut: 30 }), unknownRow(2, { steps: 10, sealAt: 6, cut: 5 })]);
  assert.equal(shareText(pageWith(answerOf({ covered: true, judged: 4, pure: 1, targets: [] }), half)), '纯召回步占比 25.0%（1/4 步）');
});

// What a page of figures is made of: the header, the formula facts, the curve, the plot rows, the appendix and the unit.
const FIGURES = ['sw-pb-head', 'sw-pb-facts', 'sw-pb-chart', 'sw-pb-curve', 'sw-pb-list', 'sw-pb-equations', 'sw-pb-table', 'sw-pb-unit'];

test('only an adjusted settlement is shown: a page whose answer is not yet there, failed or an older host\'s says its status and nothing of the unadjusted figures', () => {
  const statuses = [[null, 'recall-pending'], [{ kind: 'unreachable', message: 'x' }, 'recall-unavailable'], [{ kind: 'unavailable' }, 'recall-unavailable'], [answerOf(undefined), 'recall-unavailable']];
  for (const [value, status] of statuses) {
    const html = pageWith(value);
    assert.match(html, new RegExp(`data-sw-monitor-notice="${status}"`), status);
    for (const name of FIGURES) assert.equal(html.includes(name), false, `${status} ${name}`);
    const bare = view(SINGLE, { result: value });
    for (const name of FIGURES) assert.equal(bare.includes(name), false, `${status} ${name} of the view`);
  }
  const ready = pageWith(answerOf(ACTIVITY));
  for (const name of FIGURES) assert.equal(ready.includes(name), true, name);
  assert.equal(ready.includes('data-sw-monitor-notice'), false, 'an adjusted page with every step priced says nothing');
});

test('a page adjusted by partial recall evidence keeps the figures it has and says so; one whose answer prices no compaction shows its rate and a status, no figure', () => {
  const partial = { ...answerOf(ACTIVITY), value: { calls: [], activity: ACTIVITY, recall: { steps: [{ at: 5, seq: 50, usage: null, ratio: 2 }], cuts: [] } } };
  const html = pageWith(partial);
  assert.match(html, /data-sw-monitor-notice="recall-partial"/);
  for (const name of ['sw-pb-head', 'sw-pb-chart', 'sw-pb-list']) assert.equal(html.includes(name), true, name);
  const unpriced = pageWith({ kind: 'ready', value: { epoch: 1, attempts: [paying(1, { stepN: 3, contextChange: null })], tailCalls: 3, calls: [], cut: { segment: 0, through: 50 }, activity: ACTIVITY } });
  assert.match(unpriced, /data-sw-monitor-notice="recall-unpriced"/);
  assert.equal(shareText(unpriced), '纯召回步占比 37.5%（3/8 步）');
  for (const name of FIGURES) assert.equal(unpriced.includes(name), false, name);
});

test('the page prices from the answer\'s own attempts at its cut where it has them, as the current drawer does', () => {
  const value = { epoch: 1, attempts: [paying(1, { stepN: 3 }), paying(2, { stepN: 4 })], tailCalls: 3, calls: [], cut: { segment: 0, through: 50 }, activity: ACTIVITY };
  const html = pageWith({ kind: 'ready', value }, SINGLE);
  assert.match(textOf(html), /压缩 2 次/);
  assert.match(textOf(html), /步数 10/);
});

// ── The words ────────────────────────────────────────────────────────────────

test('every text the page asks for, whichever of its shapes it draws, has a text in both locales', () => {
  const asked = new Set();
  const spy = (key, params) => { asked.add(key); return localized(zh)(key, params); };
  for (const settlement of [FIVE, SINGLE, CLIMBING, settlementOf(8, [knownRow(1, { steps: 8, sealAt: 2, cost: 10, cut: 20 }), knownRow(2, { steps: 8, sealAt: 6, cost: 100, cut: 0 })]), settlementOf(8, [knownRow(1, { steps: 8, sealAt: 3, cost: 40, cut: 0 })])]) {
    const model = settlementPageOf(settlement, spy, READY);
    const state = createPaybackState();
    renderToString(React.createElement(PaybackView, { model, state, dispatch: noop, width: 392, t: spy }));
    renderToString(React.createElement(PaybackView, { model, state: reducePayback(state, { type: 'axis' }), dispatch: noop, width: 392, t: spy }));
    renderToString(React.createElement(PaybackPage, { settlement, monitor: monitorWithSettlement({ calls: [] }), handoffId: 31, t: spy }));
    for (const activity of [{ covered: false, judged: 0, pure: 0, targets: [] }, undefined]) {
      renderToString(React.createElement(PaybackPage, { settlement, monitor: { resource: () => ({ subscribe: () => () => {}, result: answerOf(activity) }) }, handoffId: 31, t: spy }));
    }
  }
  assert.equal(asked.has('monitor.payback.chart.separator'), true, 'the page asked for texts at all');
  for (const key of asked) {
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
    assert.equal(typeof en[key], 'string', `en ${key}`);
  }
  assert.equal(asked.has('monitor.settlement.total'), false);
});
