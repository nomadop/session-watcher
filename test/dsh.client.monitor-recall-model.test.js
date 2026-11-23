// What the settlement drawer shows of recall: the evidence an answer gives, the settlement priced from it, the cost composition, the share of pure recall steps and the target graph, `monitor-recall-model.js`.
// The answers are written by hand to the shape the host's settlement endpoints give; the figures are worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seriesOf } from '../dsh/src/client/monitor-context-model.js';
import {
  evidenceOf, settlementViewOf, compositionOf, shareOf, targetGraphOf, linkOf, selectionOf, excerptOf,
} from '../dsh/src/client/monitor-recall-model.js';
import { settlementForSegment } from '../public/lib/compactionEconomics.js';
import { zh } from '../dsh/src/client/locales.js';

const t = (key, params) => zh[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]));

// A committed attempt as the answers carry it: a summary call that cost 100 + 2 × 50 = 200 read-price tokens priced at ratio 2, its first call after the seal missing 30 tokens (a rebuild of 30), and the cut it made.
const attempt = (id, { stepN, cut = 100, miss = 30, usage = { input: 50, output: 5, cacheRead: 100, cacheWrite: 0 } } = {}) => ({
  id, status: 'committed', epoch: 0, contextChange: { before: 1000, after: 1000 - cut, delta: -cut, miss }, call: { usage }, stepN, cRatio: 2,
});
const ACTIVITY = { covered: true, judged: 10, pure: 4, targets: [] };
const answer = (over = {}) => ({
  epoch: 1, attempts: [attempt(10, { stepN: 4 }), attempt(20, { stepN: 4 })], tailCalls: 2, calls: [], cut: { segment: 0, through: 99 }, activity: ACTIVITY, ...over,
});
const ready = value => ({ kind: 'ready', value });

// ── The evidence ─────────────────────────────────────────────────────────────

test('an answer is evidence by what it holds: none yet, a failure, an older host\'s answer with no activity, or a ready one', () => {
  assert.deepEqual(evidenceOf(null), { state: 'pending' });
  assert.deepEqual(evidenceOf(undefined), { state: 'pending' });
  assert.deepEqual(evidenceOf({ kind: 'unavailable' }), { state: 'unavailable' });
  assert.deepEqual(evidenceOf({ kind: 'unreachable', message: 'x' }), { state: 'unavailable' });
  assert.deepEqual(evidenceOf(ready({ calls: [], recall: { steps: [], cuts: [] } })), { state: 'old' }, 'recall without activity adjusts nothing');
  assert.deepEqual(evidenceOf(ready(answer({ activity: { covered: 'yes', judged: 1, pure: 0, targets: [] } }))), { state: 'old' });
  assert.deepEqual(evidenceOf(ready(answer({ activity: { covered: true, judged: 1, pure: 0, targets: [{ seq: 1, type: 'user/message', at: 1, reads: [{ at: 'x', seq: 2 }] }] } }))), { state: 'old' }, 'a read that is no step');
  const value = answer({ recall: { steps: [], cuts: [] } });
  assert.deepEqual(evidenceOf(ready(value)), { state: 'ready', activity: ACTIVITY, recall: { steps: [], cuts: [] } });
  assert.equal(evidenceOf(ready(answer())).recall, undefined, 'a segment with no recall to adjust by');
});

test('the two drawers price one answer alike: from its own attempts at its cut, the listed settlement only where the answer holds no pricing inputs', () => {
  const listed = settlementForSegment([attempt(10, { stepN: 3 })], { epoch: 1, tailCalls: 1 });
  const value = answer();
  const priced = settlementForSegment(value.attempts, { epoch: 1, tailCalls: 2 });

  assert.deepEqual(settlementViewOf(listed, ready(value)).base, priced);
  assert.deepEqual(settlementViewOf(null, ready(value)).base, priced, 'the current drawer has no list');
  assert.equal(settlementViewOf(listed, null).base, listed, 'before the answer');
  assert.equal(settlementViewOf(listed, { kind: 'unreachable', message: 'x' }).base, listed);
  assert.equal(settlementViewOf(listed, ready({ calls: [] })).base, listed, 'an answer without pricing inputs');
  assert.equal(settlementViewOf(null, ready(answer())).priced, true);
  assert.equal(settlementViewOf(null, null).base, null);
  assert.equal(settlementViewOf(null, ready({ calls: [] })).base, null, 'an answer without pricing inputs');
});

const UNPRICED = { ...attempt(10, { stepN: 3 }), contextChange: null };

test('an answer that prices nothing prices nothing: the list\'s figures of another cut are not shown beside its evidence, and its adjustments are not applied to them', () => {
  const listed = settlementForSegment([attempt(10, { stepN: 3 })], { epoch: 1, tailCalls: 1 });
  const recall = { steps: [{ at: 7, seq: 70, usage: { input: 20, output: 3, cacheRead: 40, cacheWrite: 0 }, ratio: 2 }], cuts: [] };
  const targets = [{ seq: 5, type: 'user/message', at: 2, reads: [{ at: 7, seq: 70 }] }];
  const view = settlementViewOf(listed, ready(answer({ attempts: [UNPRICED], tailCalls: 1, recall, activity: { covered: true, judged: 4, pure: 1, targets } })));

  assert.equal(listed.rows[0].saved === null, false, 'the list has figures for it');
  assert.equal(view.evidence.state, 'ready');
  assert.deepEqual([view.priced, view.adjusted, view.curve], [false, false, null]);
  assert.equal(view.report, view.base, 'nothing to adjust');
  assert.equal(view.report.recall, undefined, 'no recall cost counted over compactions with no cost');
  assert.deepEqual(view.base.rows.map(({ id, ordinal, saved, cost }) => [id, ordinal, saved, cost]), [[10, listed.rows[0].ordinal, null, null]], 'the compaction of the list stays, its figures are the answer\'s: none');
  assert.deepEqual(shareOf(view.evidence), { pure: 1, judged: 4, percent: '25.0%' }, 'the rate does not wait for the figures');
  assert.equal(targetGraphOf(view, null, 392, t).rows.length, 1, 'the target stays usable');
});

test('a ready answer adjusts the report by its recall evidence and any other answer leaves it as priced', () => {
  const recall = { steps: [{ at: 7, seq: 70, usage: { input: 20, output: 3, cacheRead: 40, cacheWrite: 0 }, ratio: 2 }], cuts: [] };
  const adjusted = settlementViewOf(null, ready(answer({ recall })));
  const plain = settlementViewOf(null, ready(answer()));
  const old = settlementViewOf(null, ready({ ...answer(), activity: undefined, recall }));

  assert.equal(adjusted.report.cost - plain.report.cost, 40 + 2 * 20);
  assert.equal(plain.report, plain.base, 'a ready answer with nothing to adjust by');
  assert.deepEqual([adjusted.adjusted, plain.adjusted, old.adjusted], [true, true, false]);
  assert.equal(old.curve, null, 'no unadjusted curve to draw');
  assert.equal(old.report, old.base, 'recall of an older host is not applied');
  assert.deepEqual(adjusted.curve, settlementViewOf(null, ready(answer({ recall }))).curve);
  assert.equal(adjusted.curve.steps, 10);
});

// ── The composition ──────────────────────────────────────────────────────────

// Two priced compactions cost 200 + 30 = 230 each (a rebuild of 30 at ratio 2: (2 − 1) × 30); a third has no figures.
test('the composition is the summary calls, the cache rebuilds and the recall requests beyond the rebuild already counted, each over the report\'s cost', () => {
  const recall = { steps: [{ at: 9, seq: 90, usage: { input: 20, output: 3, cacheRead: 40, cacheWrite: 10 }, ratio: 2, post: 10 }], cuts: [] };
  const view = settlementViewOf(null, ready(answer({ attempts: [attempt(10, { stepN: 4 }), attempt(20, { stepN: 4 }), { ...attempt(30, { stepN: 1 }), contextChange: null }], recall })));
  const composition = compositionOf(view.report, true);

  // Summary calls: 100 + 2 × 50 = 200 each. The recall request costs 40 + 2 × (20 + 10) = 100 and its seal's rebuild of 30 is already counted.
  assert.deepEqual(composition.items.map(({ key, value }) => [key, value]), [['summary', 400], ['rebuild', 60], ['recall', 70]]);
  assert.equal(composition.total.value, 530, 'the report\'s cost');
  assert.equal(view.report.cost, 530);
  assert.deepEqual(composition.items.map(({ text }) => text), ['400', '60', '70']);
  assert.equal(composition.total.text, '530');
  assert.deepEqual(composition.items.map(({ percent }) => percent), ['75.5%', '11.3%', '13.2%']);
});

test('a partial report is a subtotal: its figures and total stand and no share of it is given', () => {
  const recall = { steps: [{ at: 9, seq: 90, usage: { input: 20, output: 3, cacheRead: 40, cacheWrite: 10 }, ratio: 2, post: 10 }, { at: 10, seq: 100, usage: null, ratio: 2 }], cuts: [] };
  const view = settlementViewOf(null, ready(answer({ recall })));
  const composition = compositionOf(view.report, view.adjusted);

  assert.equal(view.report.recall.partial, true);
  assert.deepEqual(composition.items.map(({ key, text }) => [key, text]), [['summary', '400'], ['rebuild', '60'], ['recall', '70']]);
  assert.equal(composition.total.text, '530');
  assert.deepEqual(composition.items.map(({ share, percent }) => [share, percent]), [[null, null], [null, null], [null, null]]);
  const complete = settlementViewOf(null, ready(answer({ recall: { ...recall, steps: recall.steps.slice(0, 1) } })));
  assert.equal(compositionOf(complete.report, complete.adjusted).items[0].percent, '75.5%', 'the same steps without the one that could not be priced');
});

test('the shown numbers of the composition add up to the shown total whichever way the figures round, and the shares are of the unrounded ones', () => {
  const report = {
    cost: 301.2, rows: [{ saved: 1, cost: 200.8, costRebuild: 100.4 }], recall: { requests: 100.4, overlap: 0 },
  };

  const composition = compositionOf(report, true);

  assert.deepEqual([composition.total.text, ...composition.items.map(({ text }) => text)], ['301', '101', '100', '100'], 'the rebuild and the recall round as they are and the summary is what the rounded total leaves');
  assert.equal(composition.items.reduce((sum, { text }) => sum + Number(text), 0), Number(composition.total.text));
  assert.deepEqual(composition.items.map(({ percent }) => percent), ['33.3%', '33.3%', '33.3%'], 'the shares are of the unrounded figures');
});

test('without evidence the recall item and the total are not known and no share is given, and a total that is none gives none either', () => {
  const view = settlementViewOf(null, ready(answer({ activity: undefined })));
  const composition = compositionOf(view.report, view.adjusted);

  assert.equal(composition.total, null);
  assert.deepEqual(composition.items.map(({ key, value, text, percent }) => [key, value, text, percent]), [['summary', 400, '400', null], ['rebuild', 60, '60', null], ['recall', null, null, null]]);
  const none = compositionOf({ cost: 0, rows: [], recall: undefined }, true);
  assert.deepEqual(none.items.map(({ value, percent }) => [value, percent]), [[0, null], [0, null], [0, null]], 'a cost of nothing is no total to give shares of, and no share is zero');
  assert.equal(compositionOf({ cost: Number.NaN, rows: [], recall: undefined }, true).items[0].percent, null);
});

// ── The share ────────────────────────────────────────────────────────────────

test('the share is the pure steps over the judged steps once the axis is proved covered, and 0% only for a segment that is confirmed to hold none', () => {
  const evidence = (activity, state = 'ready') => ({ state, activity });
  assert.deepEqual(shareOf(evidence({ covered: true, judged: 8, pure: 3, targets: [] })), { pure: 3, judged: 8, percent: '37.5%' });
  assert.deepEqual(shareOf(evidence({ covered: true, judged: 8, pure: 0, targets: [] })), { pure: 0, judged: 8, percent: '0.0%' });
  assert.equal(shareOf(evidence({ covered: false, judged: 8, pure: 3, targets: [] })), null, 'coverage not proved');
  assert.equal(shareOf(evidence({ covered: true, judged: 0, pure: 0, targets: [] })), null, 'no judged step to share over');
  for (const state of ['pending', 'unavailable', 'old']) assert.equal(shareOf({ state }), null, state);
});

test('missing prices leave the share alone: it rests on the evidence of the steps, not on the figures', () => {
  const view = settlementViewOf(null, ready(answer({ attempts: [{ ...attempt(10, { stepN: 4 }), contextChange: null }] })));
  assert.equal(view.priced, false);
  assert.deepEqual(shareOf(view.evidence), { pure: 4, judged: 10, percent: '40.0%' });
});

// ── The target graph ─────────────────────────────────────────────────────────

// Three seals over a segment of 80 steps, at 10, 25 and 60: step 10 and before is `#0`. The plot is 368 wide at 392 and lies 12 from the left, so step n is at 12 + (n − 0.5) × 4.6 and a seal after step n at 12 + n × 4.6.
const SEALED = [10, 25, 60];
const sealedAnswer = (targets, over = {}) => answer({
  attempts: SEALED.map((end, at) => attempt(10 * (at + 1), { stepN: end - (SEALED[at - 1] ?? 0) })),
  tailCalls: 20,
  activity: { covered: true, judged: 40, pure: 6, targets },
  ...over,
});
const target = (seq, type, at, reads) => ({ seq, type, at, reads: reads.map(read => ({ at: read, seq: seq * 10 + read })) });
const graphOf = (targets, { width = 392, series = null, over } = {}) => targetGraphOf(settlementViewOf(null, ready(sealedAnswer(targets, over))), series, width, t);

test('the graph has a row for each target on the settlement axis, the seals as its lines and `#0` as the band before the first, from any count of seals', () => {
  const graph = graphOf([target(128, 'user/message', 3, [30, 66]), target(241, 'tool/result', null, [12])]);

  assert.deepEqual([graph.width, graph.plotLeft, graph.plotWidth], [392, 12, 368]);
  assert.deepEqual(graph.seals.map(({ ordinal, at, x }) => [ordinal, at, x]), [[1, 10, 58], [2, 25, 127], [3, 60, 288]]);
  assert.deepEqual(graph.zero, { x0: 12, x1: 58, label: '#0' });
  assert.deepEqual(graph.zones.map(({ label, x }) => [label, x]), [['#0', 12], ['#1', 58], ['#2', 127], ['#3', 288]]);
  assert.deepEqual(graph.rows.map(({ seq, name, count }) => [seq, name, count]), [[128, '用户消息', 2], [241, '工具结果', 1]]);
  assert.deepEqual(graph.rows[0].ring, { at: 3, x: 23.5, zero: true });
  assert.deepEqual(graph.rows[0].dots.map(({ at, seq, x }) => [at, seq, x]), [[30, 1310, 147.7], [66, 1346, 313.3]]);
  assert.equal(graph.rows[1].ring, null, 'no evidence of where the original stands: no mark, none guessed from its seq');
});

test('the number of seals is the answer\'s, never a fixed one, and labels keep to the seals that leave them room', () => {
  const none = targetGraphOf(settlementViewOf(null, ready(answer({ attempts: [], activity: { covered: true, judged: 0, pure: 0, targets: [] } }))), null, 392, t);
  assert.equal(none, null, 'no priced compaction, no axis');
  const many = Array.from({ length: 30 }, (_, at) => attempt(10 * (at + 1), { stepN: 2 }));
  const graph = targetGraphOf(settlementViewOf(null, ready(answer({ attempts: many, tailCalls: 20, activity: { covered: true, judged: 40, pure: 0, targets: [target(5, 'user/message', 1, [])] } }))), null, 392, t);

  assert.equal(graph.seals.length, 30);
  assert.ok(graph.zones.length < 31 && graph.zones.length > 1);
  assert.deepEqual(graph.zones.map(zone => zone.x), [...graph.zones.map(zone => zone.x)].sort((a, b) => a - b));
  graph.zones.slice(1).forEach((zone, at) => assert.ok(zone.x - graph.zones[at].x >= 18, 'room for the label before'));
  const one = targetGraphOf(settlementViewOf(null, ready(answer({ attempts: [attempt(10, { stepN: 4 })], tailCalls: 6, activity: ACTIVITY }))), null, 392, t);
  assert.deepEqual(one.seals.map(({ at }) => at), [4]);
  assert.deepEqual(one.zones.map(({ label }) => label), ['#0', '#1']);
});

test('a narrow chart keeps every x inside the plot and its width at least the plot\'s minimum', () => {
  const graph = graphOf([target(1, 'user/message', 80, [80])], { width: 200 });
  assert.equal(graph.plotWidth, 176);
  assert.ok(graph.rows[0].dots[0].x <= graph.plotLeft + graph.plotWidth);
  const tiny = graphOf([target(1, 'user/message', 1, [1])], { width: 60 });
  assert.equal(tiny.plotWidth, 150, 'never narrower than the plot can draw');
});

test('a read links to the call of the stock chart that has the same request and a stock, and to no other: not the nearest call, not one with no stock', () => {
  const series = seriesOf([], [{ seq: 1310, stock: 500, post: false }, { seq: 1346, stock: null, post: false }, { seq: 7, stock: 90, post: false }]);
  const graph = graphOf([target(128, 'user/message', 3, [4, 30, 66])], { series });

  assert.deepEqual(graph.rows[0].dots.map(({ at, call }) => [at, call]), [[4, null], [30, 1], [66, null]], 'a request of no call of the chart, and one whose call reports no stock');
  assert.equal(linkOf({ at: 30, seq: 1310 }, null), null, 'no chart, no call');
  assert.equal(linkOf({ at: 30, seq: 1311 }, series), null, 'a seq one off is no match');
});

test('the graph counts the targets that are read after more than one seal and gives every row an accessible name', () => {
  const graph = graphOf([target(1, 'user/message', 2, [11, 12]), target(2, 'user/message', 2, [12, 30]), target(3, 'assistant/message', 2, [30, 31, 70])]);

  assert.equal(graph.count, 3);
  assert.equal(graph.repeated, 2, 'the reads of two targets stand in the steps of more than one seal');
  assert.equal(graph.rows[0].label, '事件 #1 用户消息，回读 2 步');
  assert.equal(graph.rows[2].name, '助手消息');
  assert.equal(graphOf([target(9, 'plugin/other', null, [])]).rows[0].name, 'plugin/other', 'a type with no name is its own');
});

test('the graph is no graph without ready evidence, and a segment confirmed to hold no target has none to draw', () => {
  const view = settlementViewOf(null, ready(sealedAnswer([])));
  assert.deepEqual(targetGraphOf(view, null, 392, t).rows, []);
  for (const result of [null, { kind: 'unreachable', message: 'x' }, ready({ ...sealedAnswer([]), activity: undefined })]) {
    assert.equal(targetGraphOf(settlementViewOf(null, result), null, 392, t), null);
  }
});

test('a chosen target is described by where its original stands and where it was read, a read pointing at its call only where the chart has it', () => {
  const series = seriesOf([], [{ seq: 1310, stock: 500, post: false }]);
  const graph = graphOf([target(128, 'user/message', 3, [30, 66]), target(241, 'tool/result', null, []), target(7, 'tool/result', 40, [66])], { series });

  assert.deepEqual(selectionOf(graph, 128, t), { seq: 128, title: '事件 #128 用户消息', landing: '原事件在第 3 步（#0 首封存前）', reads: [{ at: 30, label: '第 30 步', call: 1 }, { at: 66, label: '第 66 步', call: null }] });
  assert.deepEqual(selectionOf(graph, 241, t), { seq: 241, title: '事件 #241 工具结果', landing: '原事件位置不明', reads: [] });
  assert.equal(selectionOf(graph, 7, t).landing, '原事件在第 40 步（#2）');
  assert.equal(selectionOf(graph, 999, t), null, 'a seq that is no row of the graph');
  assert.equal(selectionOf(graph, null, t), null);
});

test('a text is shown by an excerpt first and the whole on request, and none where the event holds none', () => {
  assert.deepEqual(excerptOf('short', 10), { text: 'short', hidden: 0 });
  assert.deepEqual(excerptOf('abcdefghij', 10), { text: 'abcdefghij', hidden: 0 }, 'a text of exactly the limit is whole');
  assert.deepEqual(excerptOf('abcdefghijk', 10), { text: 'abcdefghij', hidden: 1 });
  assert.deepEqual(excerptOf('\u{1F600}'.repeat(4), 3), { text: '\u{1F600}'.repeat(3), hidden: 1 }, 'cut between characters, not inside one');
  assert.equal(excerptOf(null, 10), null);
  assert.equal(excerptOf('', 10), null);
});
