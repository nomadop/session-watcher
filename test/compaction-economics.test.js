// The compaction economics, `public/lib/compactionEconomics.js`: the display ordinals of the attempts, the payback progress and the status it shows, the settlement of a cleared segment and the unexpected cache rebuild, read from the monitor's rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ordinalsOf, paybackOf, settlementsOf, paybackCurveOf, unexpectedMissOf, shownStatusOf,
} from '../public/lib/compactionEconomics.js';
import {
  attemptRow, handoffRow, failedRow, progressRow, CUT, NO_USAGE, paying, rebuilt, clearing,
} from './helpers/dsh-monitor-wire.js';

test('an attempt\'s display ordinal is its place among the attempts of its segment, counted from one, whatever its seq', () => {
  const attempts = [attemptRow(3), failedRow(17), progressRow(40, 'generating')];
  assert.deepEqual(ordinalsOf(attempts), { 3: { epoch: 1, ordinal: 1 }, 17: { epoch: 1, ordinal: 2 }, 40: { epoch: 1, ordinal: 3 } });
  assert.deepEqual(ordinalsOf([]), {});
  const withUnknown = [attemptRow(5), attemptRow(9, { status: 'unknown', slots: null, endedAt: null })];
  assert.deepEqual(ordinalsOf(withUnknown), { 5: { epoch: 1, ordinal: 1 }, 9: { epoch: 1, ordinal: 2 } }, 'an attempt with no terminal evidence counts like any other');
});

test('the ordinal restarts at one in each segment, a segment is the host\'s boundary count plus one, and a segment with no attempt keeps its number unused', () => {
  const attempts = [0, 0, 1, 1, 3].map((epoch, at) => attemptRow(10 + at, { epoch }));
  assert.deepEqual(Object.values(ordinalsOf(attempts)).map(({ epoch, ordinal }) => [epoch, ordinal]), [[1, 1], [1, 2], [2, 1], [2, 2], [4, 1]], 'the segments skipped by no attempt are not renumbered');
  const { epoch: _, ...older } = attemptRow(7);
  assert.deepEqual(ordinalsOf([older, attemptRow(8, { epoch: 0 })]), { 7: { epoch: 1, ordinal: 1 }, 8: { epoch: 1, ordinal: 2 } }, 'a row from a host that sends no segment reads as the first');
});

const paidIds = attempts => attempts.filter(attempt => shownStatusOf(attempt, paybackOf(attempts)) === 'paid').map(({ id }) => id).sort((a, b) => a - b);
const percentsOf = attempts => Object.fromEntries(paybackOf(attempts));

test('a committed compaction has paid back once the steps that followed it in its segment save what its summary call and its rebuild cost, those of the compactions after it, never its own', () => {
  assert.deepEqual(paidIds([paying(1), paying(2, { stepN: 1 }), paying(3, { stepN: 1 })]), [1], 'two later steps cover the cost exactly, which is enough; one does not, and the last has none after it');
  assert.deepEqual(paidIds([paying(1, { stepN: 99 }), paying(2, { stepN: 1 })]), [], 'its own step count is steps before it');
  assert.deepEqual(paidIds([paying(1), paying(2, { stepN: 2 })]), [1]);
  assert.deepEqual(paidIds([paying(1), paying(2, { stepN: 1 }), paying(3, { stepN: 5 })]), [1, 2], 'the steps of every later compaction add up');
  assert.equal(paybackOf([]).size, 0);
});

test('only the later compactions of the same segment count, and only the committed ones: a failed, cancelled or running attempt adds none of its steps, a later segment none, and a missing step count reads as none', () => {
  const later = (overrides = {}) => [paying(1), paying(2, { stepN: 2, ...overrides })];
  assert.deepEqual(paidIds(later()), [1], 'the control');
  for (const status of ['failed', 'cancelled', 'generating', 'validating', 'unknown']) assert.deepEqual(paidIds(later({ status, slots: null })), [], status);
  assert.deepEqual(paidIds(later({ epoch: 1 })), [], 'the steps of the next segment are not the segment\'s');
  assert.deepEqual(paidIds([paying(1, { epoch: 1 }), paying(2, { stepN: 2, epoch: 0 })]), [], 'a segment before it either');
  assert.deepEqual(paidIds(later({ stepN: null })), []);
  assert.deepEqual(paidIds(later({ stepN: undefined })), []);
  for (const stepN of [null, NaN, 'many']) assert.deepEqual(paidIds([paying(1), paying(2, { stepN }), paying(3, { stepN: 2 })]), [1, 2], `a row whose steps are ${String(stepN)} leaves the others' steps as they are`);
  const { epoch: _, ...older } = paying(1);
  assert.deepEqual(paidIds([older, paying(2, { stepN: 2 })]), [1], 'a row from a host that sends no segment is in the first');
});

test('what the compaction cost and what it saved must both be known: no cut, no measured rebuild, no usage of its summary call or no price ratio, and a compaction that is not committed, has not paid back', () => {
  const next = attemptRow(2, { stepN: 100 });
  assert.deepEqual(paidIds([paying(1), next]), [1], 'the control');
  const unpaid = overrides => paidIds([paying(1, overrides), next]);
  assert.deepEqual(unpaid({ contextChange: null }), []);
  assert.deepEqual(unpaid({ contextChange: { ...CUT, delta: null } }), []);
  assert.deepEqual(unpaid({ contextChange: { ...CUT, delta: 0 } }), [], 'a context that did not shrink saves nothing');
  assert.deepEqual(unpaid({ contextChange: { ...CUT, delta: 250 } }), [], 'nor one that grew');
  assert.deepEqual(unpaid({ contextChange: { ...CUT, miss: null } }), []);
  assert.deepEqual(unpaid({ contextChange: { ...CUT, miss: undefined } }), []);
  assert.deepEqual(unpaid({ call: { usage: null } }), []);
  assert.deepEqual(unpaid({ cRatio: null }), []);
  assert.deepEqual(unpaid({ cRatio: undefined }), [], 'a row from a host that sends none');
  for (const status of ['failed', 'cancelled', 'generating', 'validating', 'unknown']) assert.deepEqual(unpaid({ status, slots: null }), [], status);
});

test('whether a compaction paid back does not depend on the order the rows arrive in', () => {
  const attempts = [paying(1), paying(2, { stepN: 1 }), paying(3, { stepN: 1 }), paying(4, { stepN: 3, epoch: 1 })];
  assert.deepEqual(paidIds(attempts), [1]);
  assert.deepEqual(paidIds([...attempts].reverse()), [1]);
});

test('the progress of a committed compaction is the share of its cost the later steps of its segment saved, in whole percent and without a ceiling, none for an attempt that is not committed', () => {
  assert.deepEqual(percentsOf([paying(1), paying(2, { stepN: 1 }), paying(3, { stepN: 1 })]), { 1: 100, 2: 50, 3: 0 }, 'a step saves half of what the compaction cost; the last compaction has no step after it');
  assert.deepEqual(percentsOf([paying(1), paying(2, { stepN: 5 })]), { 1: 250, 2: 0 }, 'it keeps rising past a whole');
  assert.deepEqual(percentsOf([paying(1), paying(2, { stepN: 1 }), failedRow(3), progressRow(4, 'generating')]), { 1: 50, 2: 0 }, 'a failed or running attempt has no progress of its own and adds no steps');
  assert.equal(paybackOf([failedRow(3)]).has(3), false);
});

test('the cost of a compaction is what its summary call spent and what the next call rebuilt: the tokens the cache served at read price, the others at write price, the rebuild beyond read price, and the output not at all', () => {
  const halfOf = (usage, miss = 0) => paybackOf([
    paying(1, { cRatio: 2, contextChange: { before: 1_000, after: 900, delta: -100, miss }, call: { usage: { ...NO_USAGE, ...usage } } }), attemptRow(2, { stepN: 1 }),
  ]).get(1);
  assert.equal(halfOf({ cacheRead: 200 }), 50, 'a cost of 200 against a saving of 100: the cache read at read price');
  assert.equal(halfOf({ input: 100 }), 50, 'an uncached input at write price');
  assert.equal(halfOf({ cacheWrite: 100 }), 50, 'a cache write at write price');
  assert.equal(halfOf({ cacheRead: 200, output: 99_999 }), 50, 'the output is not priced');
  assert.equal(halfOf({}, 200), 50, 'the rebuild beyond read price, (2 − 1) × 200');
  assert.equal(halfOf({ cacheRead: 100 }, 100), 50, 'the call and the rebuild add');
});

test('the progress is rounded down on the exact figures, so it reads a whole only for a compaction that paid back', () => {
  const costing = (delta, overrides = {}) => paying(1, { contextChange: { before: 100_000, after: 26_000, delta, miss: 8_000 }, ...overrides });
  const later = attemptRow(2, { stepN: 3 });
  assert.equal(paybackOf([costing(-49_333), later]).get(1), 99, '147999 of 148000');
  assert.equal(paybackOf([costing(-49_334), later]).get(1), 100);
  const small = (delta, steps) => paybackOf([paying(1, { contextChange: { before: 200, after: 100, delta, miss: 0 }, cRatio: 2, call: { usage: { ...NO_USAGE, cacheRead: 100 } } }), attemptRow(2, { stepN: steps })]).get(1);
  assert.equal(small(-57, 1), 57, 'a cost of 100 and a saving of 57, where 0.57 × 100 falls short of 57');
  assert.equal(small(-1, 1), 1);
});

test('the progress is none where what the compaction cost or saved is not known, and nothing where the context did not shrink', () => {
  const next = attemptRow(2, { stepN: 100 });
  assert.equal(paybackOf([paying(1), next]).get(1), 5_000, 'the control');
  const of = overrides => paybackOf([paying(1, overrides), next]).get(1);
  for (const overrides of [
    { contextChange: null }, { contextChange: { ...CUT, delta: null } }, { contextChange: { ...CUT, miss: null } }, { contextChange: { ...CUT, miss: undefined } },
    { call: { usage: null } }, { cRatio: null }, { cRatio: undefined },
    { cRatio: 0, call: { usage: NO_USAGE } }, { cRatio: 1, call: { usage: NO_USAGE } },
  ]) assert.equal(of(overrides), null, JSON.stringify(overrides));
  assert.equal(of({ contextChange: { ...CUT, delta: 0 } }), 0, 'a context that did not shrink saves nothing');
  assert.equal(of({ contextChange: { ...CUT, delta: 250 } }), 0, 'nor one that grew, which shows no negative progress');
});

test('the status a row shows is paid for a compaction whose progress is a whole and its own status otherwise', () => {
  const at = percent => new Map([[1, percent]]);
  assert.equal(shownStatusOf(paying(1), at(100)), 'paid');
  assert.equal(shownStatusOf(paying(1), at(250)), 'paid');
  assert.equal(shownStatusOf(paying(1), at(99)), 'committed');
  assert.equal(shownStatusOf(paying(1), at(null)), 'committed');
  assert.equal(shownStatusOf(paying(1), new Map()), 'committed');
  assert.equal(shownStatusOf(paying(2), at(100)), 'committed');
  assert.equal(shownStatusOf(failedRow(3), new Map([[3, 100]])), 'failed', 'only a committed compaction can have paid back');
});

const warnedIds = attempts => [...unexpectedMissOf(attempts)].sort((a, b) => a - b);

test('a cache rebuild is unexpected when it exceeds the context\'s growth since the previous compaction of its segment by more than 30 percent of that compaction\'s context', () => {
  const after = (grown, miss) => [rebuilt(1, 10_000, 0), rebuilt(2, 10_000 + grown, miss)];
  assert.deepEqual(warnedIds(after(2_000, 2_004)), [], 'a rebuild a little above the growth is within the tolerance');
  assert.deepEqual(warnedIds(after(2_000, 5_000)), [], 'a shortfall of exactly 30 percent of 10000 is not past it');
  assert.deepEqual(warnedIds(after(2_000, 5_001)), [2], 'one token past it is');
  assert.deepEqual(warnedIds(after(-2_000, 1_000)), [], 'a context that shrank has a negative growth, and the shortfall 3000 is not past it either');
  assert.deepEqual(warnedIds(after(-2_000, 1_001)), [2]);
  assert.deepEqual(warnedIds(after(5_000, 0)), [], 'a rebuild below the growth never warns');
  assert.deepEqual(warnedIds(after(0, 10_000)), [2], 'a rebuild of the whole context against none grown');
});

test('only a committed compaction after another of its own segment can warn, the previous one being the nearest committed one whatever its own rebuild was', () => {
  assert.deepEqual(warnedIds([rebuilt(1, 10_000, 9_999)]), [], 'the first of a segment has none to compare with');
  assert.deepEqual(warnedIds([rebuilt(1, 10_000, 0, { epoch: 0 }), rebuilt(2, 10_000, 9_999, { epoch: 1 })]), [], 'the previous compaction of another segment is none');
  const { epoch: _, ...older } = rebuilt(1, 10_000, 0);
  assert.deepEqual(warnedIds([older, rebuilt(2, 10_000, 9_999, { epoch: undefined })]), [2], 'a row from a host that sends no segment is in the first');
  assert.deepEqual(warnedIds([rebuilt(1, 10_000, 0), failedRow(2), rebuilt(3, 12_000, 9_000)]), [3], 'a failed attempt between them is skipped');
  const noise = status => [rebuilt(1, 10_000, 0), rebuilt(2, 50_000, 0, { status, slots: null }), rebuilt(3, 12_000, 4_000)];
  for (const status of ['failed', 'cancelled', 'generating', 'validating', 'unknown']) assert.deepEqual(warnedIds(noise(status)), [], `${status}: neither warned nor the previous`);
  assert.deepEqual(warnedIds([rebuilt(1, 10_000, 0), rebuilt(2, 11_000, 50_000), rebuilt(3, 12_000, 1_004)]), [2], 'a warned compaction is the previous one all the same, and an ordinary rebuild after it is none');
});

test('what the comparison needs must be known: the context after both compactions, the rebuild of this one and a context after the previous one that is not none', () => {
  assert.deepEqual(warnedIds([rebuilt(1, 10_000, 0), rebuilt(2, 12_000, 9_000)]), [2], 'the control');
  const of = overrides => warnedIds([rebuilt(1, 10_000, 0), rebuilt(2, 12_000, 9_000, overrides)]);
  assert.deepEqual(of({ contextChange: null }), []);
  assert.deepEqual(of({ contextChange: undefined }), []);
  assert.deepEqual(of({ contextChange: { before: 11_000, after: null, delta: null, miss: 9_000 } }), [], 'no context after it');
  assert.deepEqual(of({ contextChange: { before: 5_000, after: 4_000, delta: -1_000, miss: null } }), [], 'no rebuild, which is not a rebuild of none');
  assert.deepEqual(of({ contextChange: { before: 11_000, after: 12_000, delta: 1_000 } }), [], 'a row from a host that sends none');
  const from = overrides => warnedIds([rebuilt(1, 10_000, 0, overrides), rebuilt(2, 2_000, 9_000)]);
  assert.deepEqual(from({}), [2], 'the control');
  assert.deepEqual(from({ contextChange: null }), []);
  assert.deepEqual(from({ contextChange: { before: 11_000, after: null, delta: null, miss: 0 } }), [], 'no context after the previous one');
  assert.deepEqual(from({ contextChange: { before: 1_000, after: 0, delta: -1_000, miss: 0 } }), [], 'a context of none has no share to take');
  assert.deepEqual(warnedIds([rebuilt(1, 10_000, 0), rebuilt(2, 11_000, 0, { contextChange: { before: 11_000, after: null, delta: null, miss: 0 } }), rebuilt(3, 12_000, 9_000)]), [], 'the previous one is the nearest, not the nearest that is known');
});

test('whether a rebuild is unexpected does not depend on the order the rows arrive in', () => {
  const attempts = [rebuilt(1, 10_000, 0), rebuilt(2, 12_000, 9_000), rebuilt(3, 13_000, 1_004), rebuilt(4, 5_000, 90_000, { epoch: 1 })];
  assert.deepEqual(warnedIds(attempts), [2]);
  assert.deepEqual(warnedIds([...attempts].reverse()), [2]);
  assert.deepEqual(warnedIds([]), []);
});

const percentsWith = (attempts, handoffs) => Object.fromEntries(paybackOf(attempts, handoffs));

test('the steps a clear cut off count for every compaction of the segment it cleared, on top of the steps of the compactions after it, so the progress reads what the whole run earned', () => {
  const segment = [paying(1), paying(2, { stepN: 1 })];
  assert.deepEqual(percentsOf(segment), { 1: 50, 2: 0 }, 'the control: no handoff');
  assert.deepEqual(percentsWith(segment, [clearing(5, 1, 2)]), { 1: 150, 2: 100 }, 'two steps after the last compaction add to the one step after the first');
  assert.deepEqual(percentsWith(segment, [clearing(5, 1, 0)]), { 1: 50, 2: 0 }, 'a clear that cut off no step adds none');
  assert.equal(shownStatusOf(segment[1], paybackOf(segment, [clearing(5, 1, 2)])), 'paid', 'the last compaction of a cleared segment can have paid back');
  assert.equal(shownStatusOf(segment[1], paybackOf(segment, [])), 'committed');
  assert.deepEqual(percentsWith(segment, undefined), percentsOf(segment), 'no list of handoffs is none');
});

test('only a continue counts, the first of its segment, and only the segment it cleared: a load, a clear of another segment, a count it does not have and a failed attempt add nothing', () => {
  const segment = [paying(1), paying(2, { stepN: 1 })];
  const unchanged = { 1: 50, 2: 0 };
  assert.deepEqual(percentsWith(segment, [handoffRow(5, { epoch: 1 })]), unchanged, 'a load');
  assert.deepEqual(percentsWith(segment, [handoffRow(5, { epoch: 1, tailCalls: 2 })]), unchanged, 'a load that carries a count is still a load');
  assert.deepEqual(percentsWith(segment, [clearing(5, 2, 2)]), unchanged, 'the clear of the next segment');
  assert.deepEqual(percentsWith(segment, [clearing(5, 0, 2)]), unchanged, 'a continue that cleared no segment');
  for (const tailCalls of [null, undefined, NaN, 'many']) assert.deepEqual(percentsWith(segment, [clearing(5, 1, tailCalls)]), unchanged, `a count of ${String(tailCalls)}`);
  assert.deepEqual(percentsWith(segment, [clearing(9, 1, 7), clearing(5, 1, 2)]), { 1: 150, 2: 100 }, 'of two continues of one segment, the first by id, whatever the order they come in');
  const both = [...segment, paying(3, { epoch: 1 }), paying(4, { epoch: 1, stepN: 1 }), failedRow(6)];
  assert.deepEqual(percentsWith(both, [clearing(5, 1, 2)]), { 1: 150, 2: 100, 3: 50, 4: 0 }, 'the next segment does not take the steps of the clear before it, and a failed attempt has no progress');
});

test('a segment a continue cleared settles into its compactions\' own savings and costs, in the order of their ids, and the totals of those whose savings and costs are known', () => {
  const segment = [paying(1), paying(2, { stepN: 1 })];
  const settled = settlementsOf(segment, [clearing(5, 1, 2)]);
  assert.deepEqual([...settled.keys()], [5], 'keyed by the handoff id');
  assert.deepEqual(settled.get(5), {
    epoch: 1,
    count: 2,
    steps: 11,
    saved: 370_000,
    cost: 296_000,
    rows: [
      { id: 1, ordinal: 1, saved: 222_000, cost: 148_000, before: 100_000, after: 26_000, cut: 74_000, follow: 3, sealAt: 8, costRebuild: 88_000, needed: 2, gap: -1 },
      { id: 2, ordinal: 2, saved: 148_000, cost: 148_000, before: 100_000, after: 26_000, cut: 74_000, follow: 2, sealAt: 9, costRebuild: 88_000, needed: 2, gap: 0 },
    ],
  });
  assert.equal(settlementsOf([], []).size, 0);
  assert.deepEqual(settlementsOf([...segment].reverse(), [clearing(5, 1, 2)]).get(5).rows.map(row => row.id), [1, 2], 'by id, not by arrival');
});

test('a settlement names the segment as its compactions\' titles do, and each compaction by its place in it, whichever segment it is', () => {
  const attempts = [paying(1), paying(2, { epoch: 2 }), paying(3, { epoch: 2, stepN: 1 })];
  const settled = settlementsOf(attempts, [clearing(5, 1, 1), clearing(9, 3, 4)]);
  assert.deepEqual([...settled.keys()], [5, 9]);
  assert.deepEqual([settled.get(5).epoch, settled.get(5).rows.map(row => row.ordinal)], [1, [1]]);
  assert.deepEqual([settled.get(9).epoch, settled.get(9).rows.map(row => row.ordinal)], [3, [1, 2]]);
  const ordinals = ordinalsOf(attempts);
  assert.deepEqual(settled.get(9).rows.map(row => [row.id, ordinals[row.id].epoch, ordinals[row.id].ordinal]), [[2, 3, 1], [3, 3, 2]], 'the title the compaction\'s own row shows');
});

test('there is no settlement for a load, for a segment no clear cut, for a segment of no committed compaction, for one whose compactions all lack a saving or a cost, or for a second continue of a segment', () => {
  const segment = [paying(1), paying(2, { stepN: 1 })];
  assert.equal(settlementsOf(segment, [handoffRow(5, { epoch: 1 })]).size, 0, 'a load');
  assert.equal(settlementsOf(segment, [clearing(5, 2, 2)]).size, 0, 'the segment after');
  assert.equal(settlementsOf(segment, [clearing(5, 0, 2)]).size, 0);
  assert.equal(settlementsOf([failedRow(1), progressRow(2, 'generating')], [clearing(5, 1, 2)]).size, 0, 'no committed compaction');
  assert.equal(settlementsOf([paying(1, { cRatio: null }), paying(2, { call: { usage: null } })], [clearing(5, 1, 2)]).size, 0, 'none whose figures are all known');
  assert.deepEqual([...settlementsOf(segment, [clearing(5, 1, 2), clearing(9, 1, 3)]).keys()], [5], 'the first continue of the segment alone');
});

test('a compaction whose saving or cost is not known stays in the settlement\'s rows and its count with neither figure, and in none of its totals; an attempt that did not commit is in none', () => {
  const attempts = [paying(1), failedRow(2), paying(3, { stepN: 1, cRatio: null }), paying(4, { stepN: 1 }), progressRow(6, 'generating')];
  const settlement = settlementsOf(attempts, [clearing(9, 1, 2)]).get(9);
  assert.equal(settlement.count, 3, 'the committed compactions, those without figures included');
  assert.deepEqual(settlement.rows, [
    { id: 1, ordinal: 1, saved: 296_000, cost: 148_000, before: 100_000, after: 26_000, cut: 74_000, follow: 4, sealAt: 8, costRebuild: 88_000, needed: 2, gap: -2 },
    { id: 3, ordinal: 3, saved: null, cost: null, before: 100_000, after: 26_000, cut: 74_000, follow: 3, sealAt: 9, costRebuild: null, needed: null, gap: null },
    { id: 4, ordinal: 4, saved: 148_000, cost: 148_000, before: 100_000, after: 26_000, cut: 74_000, follow: 2, sealAt: 10, costRebuild: 88_000, needed: 2, gap: 0 },
  ], 'a compaction keeps the place its own row shows, a failed one before it taking one');
  assert.deepEqual([settlement.saved, settlement.cost], [444_000, 296_000], 'the totals add up those with figures');
});

test('a settlement\'s steps are the whole run of its segment: the steps of its committed compactions, those without figures included, and the steps the first clear cut off after the segment\'s last carrier or checkpoint', () => {
  const attempts = [paying(1, { stepN: 3 }), paying(2, { stepN: 4, cRatio: null }), paying(3, { stepN: null }), paying(4, { stepN: 'many' }), paying(5, { stepN: 2, epoch: 1 }), { ...failedRow(6), stepN: 50 }, { ...progressRow(7, 'generating'), stepN: 60 }, paying(8, { stepN: NaN }), paying(10, { stepN: Infinity })];
  const settled = settlementsOf(attempts, [clearing(9, 1, 5), clearing(12, 1, 99)]);
  assert.equal(settled.get(9).steps, 12, '3 and 4 of the compactions, none of those without a count, a failed or a running attempt or the next segment, and the 5 the clear cut off');
});

test('a settlement\'s figures are the progress\'s own: a context that did not shrink saves nothing, and what the progress reads from the same compaction is its saving over its cost', () => {
  const attempts = [paying(1, { contextChange: { ...CUT, delta: 250 } }), paying(2, { stepN: 1 })];
  const handoffs = [clearing(5, 1, 2)];
  const settlement = settlementsOf(attempts, handoffs).get(5);
  assert.deepEqual(settlement.rows.map(row => [row.saved, row.cost]), [[0, 148_000], [148_000, 148_000]]);
  const progress = paybackOf(attempts, handoffs);
  assert.deepEqual(settlement.rows.map(row => Math.floor(row.saved * 100 / row.cost)), [progress.get(1), progress.get(2)]);
});

test('a row from a host that sends no segment is in the first segment, for the progress and the settlement alike', () => {
  const bare = attempt => { const { epoch: _, ...older } = attempt; return older; };
  const segment = [bare(paying(1)), bare(paying(2, { stepN: 1 }))];
  const handoffs = [clearing(5, 1, 2)];
  assert.deepEqual(percentsWith(segment, handoffs), { 1: 150, 2: 100 });
  const settlement = settlementsOf(segment, handoffs).get(5);
  assert.deepEqual(settlement.rows.map(row => [row.id, row.ordinal, row.saved]), [[1, 1, 222_000], [2, 2, 148_000]]);
});

test('a continue row from a host that sends no step count settles as though it cut none off, and the host\'s rows without handoffs keep reading as before', () => {
  const segment = [paying(1), paying(2, { stepN: 1 })];
  const { tailCalls: _, ...older } = clearing(5, 1, 2);
  assert.deepEqual(percentsWith(segment, [older]), percentsOf(segment));
  assert.equal(settlementsOf(segment, [older]).get(5).saved, 74_000);
  assert.equal(settlementsOf(segment, [older]).get(5).steps, 9);
});

// A compaction that cut `cut` tokens, its context change consistent as the host derives it (`delta` is `after − before`) and its rebuild `miss` tokens.
const cutting = (id, cut, overrides = {}) => paying(id, { contextChange: { before: 100_000, after: 100_000 - cut, delta: -cut, miss: 8_000 }, ...overrides });
const rowsAt = (attempts, tail) => settlementsOf(attempts, [clearing(5, 1, tail)]).get(5).rows;

test('a settlement row says where its compaction stood: the context before and after it and what it cut, the steps after it and the step it sealed at, the two parts of its cost and the steps it needed to pay back against those it had', () => {
  const [first, last] = rowsAt([paying(1), paying(2, { stepN: 1 })], 2);
  assert.deepEqual([first.before, first.after, first.cut], [100_000, 26_000, 74_000]);
  assert.deepEqual([first.follow, first.sealAt], [3, 8], 'the one step of the compaction after it and the two the clear cut off; 8 steps ran before it');
  assert.equal(first.costRebuild, 88_000, '(12 − 1) × 8000 for the rebuild, of the 148000 the compaction cost');
  assert.deepEqual([first.needed, first.gap], [2, -1], '148000 over 74000 a step, one step more than it needed');
  assert.deepEqual([last.follow, last.sealAt, last.needed, last.gap], [2, 9, 2, 0], 'the last compaction has the clear\'s steps alone');
});

test('the steps a compaction needed are its whole cost over what it cut a step, rounded up, and none where it cut nothing: unbounded, with no gap', () => {
  const needed = (cut, overrides) => rowsAt([cutting(1, cut, overrides), paying(2, { stepN: 1 })], 0)[0];
  assert.equal(needed(50_000).needed, 3, '148000 over 50000, rounded up');
  assert.equal(needed(148_000).needed, 1);
  assert.equal(needed(148_001).needed, 1);
  assert.equal(needed(1).needed, 148_000);
  const flat = needed(0);
  assert.deepEqual([flat.saved, flat.needed, flat.gap, flat.cut], [0, Infinity, null, 0]);
  const grew = needed(-5_000);
  assert.deepEqual([grew.saved, grew.needed, grew.gap, grew.cut], [0, Infinity, null, -5_000], 'a context that grew saves nothing and keeps the cut it had');
  const fractional = needed(74_000, { cRatio: 12.5, contextChange: { before: 100_000, after: 26_000, delta: -74_000, miss: 8_001 } });
  assert.equal(fractional.needed, 3, 'a cost of 152511.5, which reads 152512, over 74000, rounded up');
});

test('the steps a compaction needed are counted over the cost as it is shown, rounded to a whole number: a cost that rounds to the cut needs one step', () => {
  const costing = cost => rowsAt([cutting(1, 74_000, { call: { usage: { input: 0, cacheRead: cost, cacheWrite: 0 } }, contextChange: { before: 100_000, after: 26_000, delta: -74_000, miss: 0 } }), paying(2, { stepN: 1 })], 0)[0];
  assert.equal(costing(74_000.4).cost, 74_000.4, 'the row keeps the cost as it was priced');
  assert.equal(costing(74_000.4).needed, 1, '74000.4 reads 74000, which one step of 74000 pays back');
  assert.equal(costing(74_000.5).needed, 2, 'and 74000.5 reads 74001, which it does not');
});

test('a row whose cost or saving is not known keeps the context it saw and the steps around it, and needs and differs by nothing', () => {
  const noRatio = rowsAt([paying(1, { cRatio: null }), paying(2, { stepN: 1 })], 2)[0];
  assert.deepEqual([noRatio.saved, noRatio.cost, noRatio.costRebuild, noRatio.needed, noRatio.gap], [null, null, null, null, null]);
  assert.deepEqual([noRatio.before, noRatio.after, noRatio.cut, noRatio.follow, noRatio.sealAt], [100_000, 26_000, 74_000, 3, 8]);
  const noContext = rowsAt([paying(1, { contextChange: { before: null, after: null, delta: null, miss: 8_000 } }), paying(2, { stepN: 1 }), paying(3, { stepN: 4 })], 2)[0];
  assert.deepEqual([noContext.before, noContext.after, noContext.cut, noContext.saved, noContext.needed, noContext.gap], [null, null, null, null, null, null]);
  assert.deepEqual([noContext.follow, noContext.sealAt], [7, 8], 'the steps of the two compactions after it and the two of the clear');
  const half = rowsAt([paying(1, { contextChange: { before: 100_000, after: null, delta: null, miss: 8_000 } }), paying(2)], 0)[0];
  assert.deepEqual([half.before, half.after, half.cut], [100_000, null, null], 'a cut needs both ends');
  const bare = rowsAt([paying(1, { contextChange: undefined }), paying(2)], 0)[0];
  assert.deepEqual([bare.before, bare.after, bare.cut, bare.saved, bare.cost], [null, null, null, null, null], 'a row from a host that sends no context change');
  const noEnds = rowsAt([paying(1, { contextChange: { before: null, after: null, delta: -74_000, miss: 8_000 } }), paying(2, { stepN: 1 })], 2)[0];
  assert.deepEqual([noEnds.saved, noEnds.cost, noEnds.cut], [222_000, 148_000, null], 'its figures are known without the context around the seal');
  assert.deepEqual([noEnds.needed, noEnds.gap], [null, null], 'a cut that is not known is a number of steps that is not known, not one that never ends');
});

test('the steps after a compaction are those of the compactions after it in its segment, none counting a missing step count, and the steps the clear cut off after the last: the figure its saving is made of', () => {
  const attempts = [paying(1, { stepN: 3 }), paying(2, { stepN: null }), paying(3, { stepN: 4, cRatio: null }), paying(4, { stepN: 6 })];
  const rows = rowsAt(attempts, 5);
  assert.deepEqual(rows.map(row => row.follow), [15, 15, 11, 5], 'no step count reads as none, a compaction with no figures still adds its steps');
  assert.deepEqual(rows.map(row => row.sealAt), [3, 3, 7, 13], 'the steps that ran up to and with it, its own among them');
  assert.equal(rows.at(-1).follow, 5, 'the last has the clear\'s count alone');
  for (const row of rows) assert.equal(row.sealAt + row.follow, 18, 'every row\'s seal and the steps after it are the segment\'s whole run');
  assert.deepEqual(rowsAt([paying(1, { stepN: 3 }), paying(2, { stepN: 4 })], 0).map(row => row.follow), [4, 0], 'a clear that cut off no step leaves the last compaction none');
  assert.deepEqual(rowsAt([paying(1), paying(2, { stepN: 'many' })], 2).map(row => row.follow), [2, 2], 'a step count that is no number');
});

test('the steps after a compaction are those of its segment alone, whichever segment the others run in, and a clear of one segment adds nothing to another', () => {
  const attempts = [paying(1, { stepN: 3 }), paying(2, { stepN: 4 }), paying(3, { stepN: 5, epoch: 1 }), paying(4, { stepN: 7, epoch: 1 })];
  const settled = settlementsOf(attempts, [clearing(5, 1, 2), clearing(9, 2, 6)]);
  assert.deepEqual(settled.get(5).rows.map(row => [row.follow, row.sealAt]), [[6, 3], [2, 7]]);
  assert.deepEqual(settled.get(9).rows.map(row => [row.follow, row.sealAt]), [[13, 5], [6, 12]]);
  assert.deepEqual([settled.get(5).steps, settled.get(9).steps], [9, 18]);
});

test('what a known row saved is the steps after it times what it cut, and nothing where it cut nothing or grew the context', () => {
  const attempts = [cutting(1, 74_000, { stepN: 3 }), cutting(2, 5_000, { stepN: 2 }), cutting(3, 0, { stepN: 4 }), cutting(4, -9_000, { stepN: 1 }), cutting(5, 12_345, { cRatio: 12.5, stepN: 6 }), paying(6, { cRatio: null, stepN: 2 }), cutting(7, 20_000)];
  const rows = rowsAt(attempts, 3);
  const known = rows.filter(row => row.saved !== null);
  assert.equal(known.length, 6);
  for (const row of known) assert.equal(row.saved, row.follow * Math.max(0, row.cut), `row ${row.id}`);
  assert.deepEqual(rows.find(row => row.id === 3).saved, 0);
  assert.deepEqual(rows.find(row => row.id === 6).saved, null);
  assert.deepEqual(known.map(row => row.saved).reduce((sum, saved) => sum + saved, 0), settlementsOf(attempts, [clearing(5, 1, 3)]).get(5).saved, 'the settlement sums the known rows as before');
});

// A settlement row as `paybackCurveOf` reads it.
const sealed = (sealAt, cost, cut, overrides = {}) => ({ sealAt, saved: 0, cost, cut, needed: 1, ...overrides });

test('the cumulative net of a segment is nothing until the first seal, drops by the whole cost at the step a seal lands on and rises by the cut at every step after it', () => {
  const curve = paybackCurveOf({ steps: 10, rows: [sealed(4, 100, 30)] });
  assert.deepEqual(curve.net, [0, 0, 0, 0, -100, -70, -40, -10, 20, 50, 80]);
  assert.equal(curve.steps, 10);
  assert.deepEqual(curve.lowest, { value: -100, at: 4 });
  assert.deepEqual(curve.below, [[4, 7]]);
  assert.deepEqual(curve.seals, [4]);
});

test('a compaction that cut nothing never earns back, so the net stays at its lowest to the segment\'s end, which a range below zero runs to, and the first lowest step is the lowest', () => {
  const flat = paybackCurveOf({ steps: 6, rows: [sealed(3, 40, 0)] });
  assert.deepEqual(flat.net, [0, 0, 0, -40, -40, -40, -40]);
  assert.deepEqual(flat.lowest, { value: -40, at: 3 }, 'the first of equal minima');
  assert.deepEqual(flat.below, [[3, 6]]);
  const shrinking = paybackCurveOf({ steps: 6, rows: [sealed(3, 40, -5)] });
  assert.deepEqual(shrinking.net, flat.net, 'a context that grew earns nothing and costs nothing more');
  assert.deepEqual(paybackCurveOf({ steps: 6, rows: [sealed(3, 40, null)] }).net, flat.net, 'nor one whose cut is not known');
});

test('the steps below zero are each run of steps whose net is under it, a later seal opening a new one', () => {
  const curve = paybackCurveOf({ steps: 8, rows: [sealed(2, 10, 20), sealed(6, 100, 0)] });
  assert.deepEqual(curve.net, [0, 0, -10, 10, 30, 50, -30, -10, 10]);
  assert.deepEqual(curve.below, [[2, 2], [6, 7]]);
  assert.deepEqual(curve.lowest, { value: -30, at: 6 });
  assert.deepEqual(paybackCurveOf({ steps: 3, rows: [sealed(0, 10, 20)] }).below, [[0, 0]], 'a seal on the first step');
  assert.deepEqual(paybackCurveOf({ steps: 4, rows: [sealed(1, 20, 20)] }).below, [[1, 1]], 'zero is not below zero: 20 earned of 20 spent at the second step');
});

test('the seals apply in the order of their steps, and of their rows at one step, whatever order the rows come in', () => {
  const rows = [sealed(6, 100, 0), sealed(2, 10, 20), sealed(2, 5, 1)];
  const curve = paybackCurveOf({ steps: 8, rows });
  assert.deepEqual(curve.net, [0, 0, -15, 6, 27, 48, -31, -10, 11]);
  assert.deepEqual(curve.seals, [2, 2, 6], 'ascending');
  assert.deepEqual(paybackCurveOf({ steps: 8, rows: [...rows].reverse() }).net, curve.net);
  assert.deepEqual(rows.map(row => row.sealAt), [6, 2, 2], 'the rows are not reordered');
});

test('a compaction whose cost or saving is not known sits on the curve as a seal and adds nothing to it', () => {
  const unknown = { sealAt: 1, saved: null, cost: null, cut: 50, needed: null };
  const curve = paybackCurveOf({ steps: 5, rows: [unknown, sealed(3, 10, 5)] });
  assert.deepEqual(curve.net, [0, 0, 0, -10, -5, 0]);
  assert.deepEqual(curve.seals, [1, 3]);
  assert.deepEqual(curve.below, [[3, 4]]);
});

test('the median of the steps the compactions needed is of the finite ones and needs three of them', () => {
  const medianOf = (...neededs) => paybackCurveOf({ steps: 5, rows: neededs.map(needed => sealed(1, 1, 1, { needed })) }).medianNeeded;
  assert.equal(medianOf(5, 1, 9), 5);
  assert.equal(medianOf(2, 4, 6, 10), 5, 'the mean of the middle two');
  assert.equal(medianOf(3, 7), null);
  assert.equal(medianOf(3, Infinity, 7), null, 'an unbounded one is not a number of steps');
  assert.equal(medianOf(3, null, 7), null, 'nor one that is not known');
  assert.equal(medianOf(3, Infinity, 7, null, 11), 7);
  assert.equal(medianOf(), null);
});

test('the net at the segment\'s end is what the known compactions saved less what they cost, and the curve of a segment nothing sealed in is flat', () => {
  const attempts = [cutting(1, 74_000, { stepN: 3, cRatio: 12.5, contextChange: { before: 100_000, after: 26_000, delta: -74_000, miss: 8_001 } }), paying(2, { cRatio: null, stepN: 5 }), cutting(3, 31_000, { stepN: 2 }), cutting(4, 0, { stepN: 1 })];
  const settlement = settlementsOf(attempts, [clearing(5, 1, 4)]).get(5);
  const curve = paybackCurveOf(settlement);
  assert.equal(curve.net.length, settlement.steps + 1);
  assert.ok(Math.abs(curve.net.at(-1) - (settlement.saved - settlement.cost)) < 1e-6, `${curve.net.at(-1)} against ${settlement.saved - settlement.cost}`);
  assert.deepEqual(curve.seals, settlement.rows.map(row => row.sealAt), 'every row has its seal, those of unknown figures included');
  assert.equal(paybackCurveOf({ steps: 4, rows: [] }).net.every(value => value === 0), true);
  assert.deepEqual(paybackCurveOf({ steps: 4, rows: [] }).lowest, { value: 0, at: 0 });
  assert.deepEqual(paybackCurveOf({ steps: 4, rows: [] }).below, []);
});

test('a segment that ran no step has the one point of the seals that landed on it', () => {
  const curve = paybackCurveOf({ steps: 0, rows: [sealed(0, 10, 3)] });
  assert.deepEqual(curve.net, [-10]);
  assert.deepEqual(curve.lowest, { value: -10, at: 0 });
  assert.deepEqual(curve.below, [[0, 0]]);
});
