// test/lineage-headlines.test.js — the bound on the headlines a load carries, the grammar of the
// positions that read the collapsed ones back, and the selection those positions make over a list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundLineageHeadlines,
  parseLineagePositions,
  selectLineagePositions,
} from '../lib/lineage-headlines.js';
import { estimateWireTokens } from '../lib/turn-history-budget.js';
import {
  DEFAULT_CTP,
  HANDOFF_MAX_NEXT_TASK_CHARS,
  LINEAGE_HEADLINE_TOKEN_BUDGET,
} from '../lib/constants.js';

const entry = (k, headline) => ({ label: 'S' + k, headline });
const cost = (entries) => estimateWireTokens({ lineage: entries }, DEFAULT_CTP);
const kept = (result) => result.filter((e) => !e.omitted);
const omittedRuns = (result) => result.filter((e) => e.omitted);

// A headline of a chosen size, so a budget lands between two entries instead of on one by luck.
const headline = (n) => 'task '.repeat(n).trim();

// Every list below is oldest to newest, as a load's lineage is.
const consecutive = (n) => Array.from({ length: n }, (_, i) => entry(i + 1, headline(i + 4)));
// Positions 3, 7 and 11 have no entry, as a member whose window holds no rows leaves none.
const gapped = [1, 2, 4, 5, 6, 8, 9, 10, 12].map((k) => entry(k, headline(k + 3)));

// ── The bound ──────────────────────────────────────────────────────────────────

test('a list that fits is returned deep-equal and marks no entry omitted', () => {
  const list = consecutive(4);
  const result = boundLineageHeadlines(list);
  assert.deepEqual(result, list);
  assert.equal(result.some((e) => 'omitted' in e), false);
});

test('an empty list answers an empty list', () => {
  assert.deepEqual(boundLineageHeadlines([]), []);
  assert.deepEqual(boundLineageHeadlines([], 0), []);
});

test('over the budget one run covers the oldest entries and the newest suffix follows it', () => {
  const list = consecutive(6);
  const result = boundLineageHeadlines(list, cost(list.slice(3)));
  assert.deepEqual(result, [
    { label: 'S1-S3', omitted: true },
    ...list.slice(3),
  ]);
});

test('a run of one entry keeps its own label', () => {
  const list = [7, 8, 9].map((k) => entry(k, headline(k)));
  const result = boundLineageHeadlines(list, cost(list.slice(1)));
  assert.deepEqual(result, [{ label: 'S7', omitted: true }, list[1], list[2]]);
});

test('entries absent from the numbering split the omitted entries into runs', () => {
  const list = [1, 2, 4, 5, 6].map((k) => entry(k, headline(k + 3)));
  // S4 and everything older is omitted; S3 has no entry, so S1-S2 and S4 cannot join.
  const result = boundLineageHeadlines(list, cost(list.slice(3)));
  assert.deepEqual(result, [
    { label: 'S1-S2', omitted: true },
    { label: 'S4', omitted: true },
    list[3],
    list[4],
  ]);
});

test('at every budget from the newest entry alone to the whole list the kept entries are the longest suffix that fits', () => {
  for (const list of [consecutive(7), gapped]) {
    const newest = cost(list.slice(-1));
    const whole = cost(list);
    for (let budget = newest; budget <= whole; budget++) {
      const result = boundLineageHeadlines(list, budget);
      const keep = kept(result);
      assert.ok(keep.length >= 1, `budget ${budget} keeps the newest entry`);
      assert.deepEqual(keep, list.slice(list.length - keep.length), `budget ${budget} keeps a suffix`);
      assert.ok(cost(keep) <= budget, `budget ${budget} holds the kept entries`);
      assert.equal(result.length - keep.length, result.findIndex((e) => !e.omitted),
        `budget ${budget} puts every run before the kept entries`);
      if (keep.length < list.length) {
        const older = list[list.length - keep.length - 1];
        assert.ok(cost([older, ...keep]) > budget, `budget ${budget} cannot take ${older.label} as well`);
      }
    }
  }
});

test('a budget equal to the whole list\'s cost returns the list deep-equal', () => {
  for (const list of [consecutive(7), gapped]) {
    assert.deepEqual(boundLineageHeadlines(list, cost(list)), list);
  }
});

test('the runs stand outside the budget: the newest entry is kept however many runs precede it', () => {
  const list = [1, 3, 5, 7, 9, 11].map((k) => entry(k, headline(6)));
  const budget = cost(list.slice(-1));
  const result = boundLineageHeadlines(list, budget);
  assert.deepEqual(result, [
    ...[1, 3, 5, 7, 9].map((k) => ({ label: 'S' + k, omitted: true })),
    list[5],
  ]);
  assert.ok(cost(kept(result)) <= budget);
  assert.ok(cost(result) > budget, 'the field as sent exceeds the budget by its runs');
});

test('an entry too large for the budget stops the fill, and the smaller older entries stay omitted', () => {
  const list = [
    entry(1, headline(3)), entry(2, headline(3)),
    entry(3, headline(300)),
    entry(4, headline(3)), entry(5, headline(3)),
  ];
  // The budget holds all four small entries, were the large one between them not counted.
  const budget = cost([list[0], list[1], list[3], list[4]]);
  assert.ok(cost(list.slice(2)) > budget);
  assert.deepEqual(boundLineageHeadlines(list, budget), [
    { label: 'S1-S3', omitted: true },
    list[3],
    list[4],
  ]);
});

test('when not even the newest entry fits the result is the omitted runs alone, whatever they cost', () => {
  const list = [1, 2, 4, 5].map((k) => entry(k, headline(20)));
  const runs = [{ label: 'S1-S2', omitted: true }, { label: 'S4-S5', omitted: true }];
  assert.deepEqual(boundLineageHeadlines(list, cost(list.slice(-1)) - 1), runs);
  assert.deepEqual(boundLineageHeadlines(list, 0), runs);
  assert.ok(cost(runs) > 0, 'at a budget of nothing the runs alone still exceed it');
});

test('a kept entry has exactly the shape label and headline', () => {
  const result = boundLineageHeadlines(consecutive(6), cost(consecutive(6).slice(4)));
  for (const e of kept(result)) assert.deepEqual(Object.keys(e).sort(), ['headline', 'label']);
  for (const e of omittedRuns(result)) assert.deepEqual(Object.keys(e).sort(), ['label', 'omitted']);
});

test('the input array and its entries are not mutated', () => {
  const list = gapped;
  const before = structuredClone(list);
  boundLineageHeadlines(list, cost(list.slice(-2)));
  boundLineageHeadlines(list, 0);
  boundLineageHeadlines(list);
  assert.deepEqual(list, before);
});

// ── The budget constant ────────────────────────────────────────────────────────

test('the budget covers one entry whose headline is a CJK next_task of the cap\'s length', () => {
  const dearest = entry(99, '字'.repeat(HANDOFF_MAX_NEXT_TASK_CHARS));
  assert.ok(estimateWireTokens({ lineage: [dearest] }, DEFAULT_CTP) <= LINEAGE_HEADLINE_TOKEN_BUDGET);
  assert.deepEqual(boundLineageHeadlines([dearest]), [dearest]);
});

// ── The position grammar ───────────────────────────────────────────────────────

test('parseLineagePositions answers from-to pairs for a string that obeys the grammar', () => {
  assert.deepEqual(parseLineagePositions('3'), [[3, 3]]);
  assert.deepEqual(parseLineagePositions('2-5'), [[2, 5]]);
  assert.deepEqual(parseLineagePositions('1,4-6'), [[1, 1], [4, 6]]);
  assert.deepEqual(parseLineagePositions('2-5,4-9'), [[2, 5], [4, 9]]);
  assert.deepEqual(parseLineagePositions('7,7'), [[7, 7], [7, 7]]);
  assert.deepEqual(parseLineagePositions('4-4'), [[4, 4]]);
});

test('parseLineagePositions answers null for anything the grammar does not accept', () => {
  for (const text of [
    '', ' 3', '3 ', '3\n', 'S3', 'S2-S5', '0', '03', '0-3', '3-2', '1,,2', '1-', '-3', '3,', ',3',
    '1 - 2', '1, 2', '1-2-3', 'a', '1.5', '-1', '+1', '１',
    undefined, null, 3, ['3'], { toString: () => '3' },
  ]) {
    assert.equal(parseLineagePositions(text), null, JSON.stringify(text));
  }
});

// ── The position selection ─────────────────────────────────────────────────────

const select = (list, k) => selectLineagePositions(list, parseLineagePositions(k));

test('a range selects the entries inside it, oldest to newest', () => {
  const list = consecutive(5);
  assert.deepEqual(select(list, '2-3'), [list[1], list[2]]);
  assert.deepEqual(select(list, '4'), [list[3]]);
});

test('items select in list order, whatever order they are named in', () => {
  const list = consecutive(5);
  assert.deepEqual(select(list, '5,1'), [list[0], list[4]]);
});

test('overlapping and repeated items answer each entry once', () => {
  const list = consecutive(8);
  assert.deepEqual(select(list, '2-5,4-8'), list.slice(1));
  assert.deepEqual(select(list, '7,7'), [list[6]]);
});

test('a position beyond the list answers null', () => {
  const list = consecutive(5);
  assert.equal(select(list, '6'), null);
  assert.equal(select(list, '5-6'), null);
  assert.equal(select(list, '1,9'), null);
  assert.equal(select([], '1'), null);
});

test('a position that falls on a gap answers null for the whole selection', () => {
  const list = [1, 2, 4].map((k) => entry(k, headline(k)));
  assert.equal(select(list, '2-4'), null);
  assert.equal(select(list, '3'), null);
  assert.equal(select(list, '1,3'), null);
  assert.deepEqual(select(list, '1-2,4'), list);
});

test('a range far beyond the list is refused by count, without walking its integers', () => {
  const list = consecutive(5);
  assert.equal(select(list, '1-99999999999999'), null);
  assert.equal(select(list, '99999999999998-99999999999999'), null);
});

test('the selection holds the input entries unchanged and never marks one omitted', () => {
  const list = consecutive(5);
  const before = structuredClone(list);
  const picked = select(list, '1-5');
  assert.deepEqual(picked, before);
  assert.equal(picked.some((e) => 'omitted' in e), false);
  assert.deepEqual(list, before);
});

// ── The chain a load's runs and the tool share ─────────────────────────────────

test('each omitted run of a bounded list reads back through the grammar and the selection', () => {
  const list = gapped;
  let checked = 0;
  let sawTwoRuns = false;
  for (let budget = 0; budget <= cost(list); budget++) {
    const result = boundLineageHeadlines(list, budget);
    const runs = omittedRuns(result);
    if (runs.length === 2) sawTwoRuns = true;
    const selected = [];
    for (const run of runs) {
      const k = run.label.replaceAll('S', '');
      const ranges = parseLineagePositions(k);
      assert.notEqual(ranges, null, `budget ${budget}: ${run.label} parses`);
      const picked = selectLineagePositions(list, ranges);
      assert.notEqual(picked, null, `budget ${budget}: ${run.label} selects`);
      selected.push(...picked);
      checked++;
    }
    const keptLabels = new Set(kept(result).map((e) => e.label));
    assert.deepEqual(selected, list.filter((e) => !keptLabels.has(e.label)),
      `budget ${budget}: the runs read back exactly the entries the result does not keep`);
  }
  assert.ok(sawTwoRuns, 'a budget in the sweep yields two omitted runs');
  assert.ok(checked > 0, 'the sweep checks at least one run');
});
