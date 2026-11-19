// The monitor view's pure state, `monitor-state.js`: the expansion and selection reducer, the rows the list shows with the attempts' display ordinals, the previews and elapsed times they show, the scroll tail and the drawer width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAWER_DEFAULT_WIDTH, DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_KEY_STEP, LIST_MIN_WIDTH, PREVIEW_CHARS,
  createViewState, reduceView, isOpen, ordinalsOf, paybackOf, settlementsOf, unexpectedMissOf, shownStatusOf, sourceCategoryOf, slotTitleOf, rowIdentity, flattenRows, previewOf, elapsedOf, formatElapsed, clampDrawerWidth,
  handoffSegmentOf, contextRangeText, NOT_AVAILABLE, LEAVES_LOADING, LEAVES_FAILED,
} from '../dsh/src/client/monitor-state.js';
import { attemptRow, slotRow, handoffRow } from './helpers/dsh-monitor-wire.js';

test('a new view state has nothing selected, no choices of its own and the drawer at its default width', () => {
  assert.deepEqual(createViewState(), { overrides: {}, selected: null, drawerWidth: DRAWER_DEFAULT_WIDTH });
});

test('every group is closed by default, a manual open is the group\'s own and stays, and a toggle of what shows open closes it', () => {
  let state = createViewState();
  assert.equal(isOpen(state, 1), false);
  assert.equal(isOpen(state, 2), false);

  const untouched = createViewState();
  state = reduceView(state, { type: 'toggle', attemptId: 2, open: false });
  assert.deepEqual(untouched, createViewState(), 'a reduction leaves the state it was given');
  assert.equal(isOpen(state, 2), true, 'a manual open');
  assert.equal(isOpen(state, 1), false, 'the others stay closed');
  assert.equal(isOpen(state, 3), false, 'and so does an attempt that arrives later');

  state = reduceView(state, { type: 'toggle', attemptId: 2, open: true });
  assert.equal(isOpen(state, 2), false, 'a toggle of what shows open closes it');
  state = reduceView(state, { type: 'toggle', attemptId: 2, open: false });
  assert.equal(isOpen(state, 2), true);
});

test('selecting keeps the selection for the same identity and replaces it for another, clear empties it, and a selection and a toggle each leave the other\'s part of the state alone', () => {
  const call = { type: 'select', kind: 'call', attemptId: 3 };
  const slot = { type: 'select', kind: 'slot', attemptId: 3, slotKey: 31 };
  const opened = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const selected = reduceView(opened, call);
  assert.deepEqual(selected.selected, { identity: rowIdentity(call), kind: 'call', attemptId: 3, slotKey: null });
  assert.deepEqual(selected.overrides, opened.overrides, 'a selection never changes the expansion');
  assert.equal(reduceView(selected, call), selected, 'the same identity keeps the selection');

  const replaced = reduceView(selected, slot);
  assert.deepEqual(replaced.selected, { identity: rowIdentity(slot), kind: 'slot', attemptId: 3, slotKey: 31 });
  assert.notEqual(replaced.selected.identity, selected.selected.identity);
  assert.deepEqual(replaced.overrides, opened.overrides);

  const toggled = reduceView(replaced, { type: 'toggle', attemptId: 3, open: false });
  assert.deepEqual(toggled.selected, replaced.selected, 'a toggle of the selection\'s parent leaves the selection');
  assert.equal(isOpen(toggled, 3), true);

  const cleared = reduceView(toggled, { type: 'clear' });
  assert.equal(cleared.selected, null);
  assert.deepEqual(cleared.overrides, toggled.overrides, 'and clear leaves the expansion');
  assert.equal(reduceView(cleared, { type: 'clear' }), cleared);
});

test('a row identity names the kind and the ids of the row alone: the same row has one identity and no two rows share one', () => {
  const rows = [
    { kind: 'attempt', attemptId: 3 }, { kind: 'call', attemptId: 3 }, { kind: 'call', attemptId: 31 },
    { kind: 'slot', attemptId: 3, slotKey: 31 }, { kind: 'slot', attemptId: 31, slotKey: 3 }, { kind: 'slot', attemptId: 3, slotKey: 3 },
  ];
  assert.equal(new Set(rows.map(rowIdentity)).size, rows.length);
  assert.equal(rowIdentity({ kind: 'slot', attemptId: 3, slotKey: 31 }), rowIdentity({ slotKey: 31, attemptId: 3, kind: 'slot' }));
  assert.equal(rowIdentity({ kind: 'call', attemptId: 3 }), rowIdentity({ kind: 'call', attemptId: 3, slotKey: 99 }), 'a slot key names nothing of a call');
});

const identities = rows => rows.map(row => row.identity);
/** A view state with the groups of the attempts `ids` opened, which a group is not by default. */
const opening = (...ids) => ids.reduce((state, attemptId) => reduceView(state, { type: 'toggle', attemptId, open: false }), createViewState());
const failedRow = id => attemptRow(id, { status: 'failed', reason: 'the response has no finish chunk', slots: null, endedAt: 1_800 + id });
const progressRow = (id, status) => attemptRow(id, {
  status, endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null },
});

test('an open attempt lists its call row and, once committed with its slots loaded, a slot row per slot in source order, a closed attempt its own row alone, and by default every attempt is closed', () => {
  const attempts = [attemptRow(1), failedRow(2), progressRow(3, 'generating')];
  const slotsByAttempt = { 1: [slotRow(10), slotRow(20)], 2: [slotRow(30)] };
  const state = createViewState();
  const rows = flattenRows(attempts, slotsByAttempt, state);
  assert.deepEqual(identities(rows), ['attempt:1', 'attempt:2', 'attempt:3']);
  assert.deepEqual(rows.map(row => row.kind), ['attempt', 'attempt', 'attempt']);
  assert.deepEqual(rows.map(row => row.open), [false, false, false], 'no group is open by default, the latest included');
  assert.equal(rows[0].attempt, attempts[0], 'a row carries the attempt row it lists');

  const opened = [1, 2, 3].reduce((current, attemptId) => reduceView(current, { type: 'toggle', attemptId, open: false }), state);
  const all = flattenRows(attempts, slotsByAttempt, opened);
  assert.deepEqual(identities(all), ['attempt:1', 'call:1', 'slot:1:10', 'slot:1:20', 'attempt:2', 'call:2', 'attempt:3', 'call:3']);
  assert.deepEqual(all.filter(row => row.kind === 'slot').map(row => row.slot), [slotRow(10), slotRow(20)]);
  assert.equal(all[2].attempt, attempts[0]);
});

test('a slot row appears only under a committed attempt whose slots are loaded: never under one in progress, failed, cancelled or unknown, and not before the slots arrive', () => {
  const slotsByAttempt = { 1: [slotRow(10)] };
  const open = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const rowsOf = row => flattenRows([row], slotsByAttempt, open);
  assert.deepEqual(identities(rowsOf(attemptRow(1))), ['attempt:1', 'call:1', 'slot:1:10']);
  assert.deepEqual(identities(flattenRows([attemptRow(1)], {}, open)), ['attempt:1', 'call:1'], 'before the slots are loaded');
  assert.deepEqual(identities(flattenRows([attemptRow(1)], { 1: [] }, open)), ['attempt:1', 'call:1', 'placeholder:1'], 'a loaded list of no slots says so');
  for (const status of ['generating', 'validating', 'failed', 'cancelled', 'unknown']) {
    assert.deepEqual(identities(rowsOf(attemptRow(1, { status, slots: null }))), ['attempt:1', 'call:1'], status);
  }
});

test('a new attempt or an update changes neither the selection nor whether the drawer shows, and opens no group the user did not open', () => {
  let state = reduceView(createViewState(), { type: 'select', kind: 'call', attemptId: 1 });
  const before = structuredClone(state);
  const first = flattenRows([progressRow(1, 'generating')], {}, state);
  assert.deepEqual(identities(first), ['attempt:1'], 'the selected call row is not listed while its group is closed');
  const updated = flattenRows([attemptRow(1), progressRow(2, 'generating')], { 1: [slotRow(10)] }, state);
  assert.deepEqual(state, before, 'rows are listed from the state without changing it');
  assert.equal(state.selected.identity, rowIdentity({ kind: 'call', attemptId: 1 }), 'the arrival did not select or deselect');
  assert.deepEqual(updated.filter(row => row.kind === 'attempt').map(row => row.open), [false, false], 'the newest attempt opens nothing either');
  assert.ok(!updated.some(row => row.identity === state.selected.identity), 'the group of the selection is closed, and the selection stays');
  const reopened = flattenRows([attemptRow(1), progressRow(2, 'generating')], {}, reduceView(state, { type: 'toggle', attemptId: 1, open: false }));
  assert.ok(reopened.some(row => row.identity === state.selected.identity), 'the same row is listed again once its group opens');

  state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const kept = flattenRows([progressRow(1, 'generating'), progressRow(2, 'generating')], {}, state);
  assert.deepEqual(kept.filter(row => row.kind === 'attempt').map(row => row.open), [true, false], 'a manual open stays when a newer attempt arrives');
  const none = createViewState();
  flattenRows([progressRow(1, 'generating'), progressRow(2, 'generating')], {}, none);
  assert.equal(none.selected, null, 'no arrival selects');
});

test('the identity of a row does not depend on the order of the attempts or the slots', () => {
  const attempts = [attemptRow(1), failedRow(2), attemptRow(3)];
  const slotsByAttempt = { 1: [slotRow(10), slotRow(20)], 3: [slotRow(30), slotRow(40)] };
  const state = [1, 2, 3].reduce((current, attemptId) => reduceView(current, { type: 'toggle', attemptId, open: false }), createViewState());
  const forward = flattenRows(attempts, slotsByAttempt, state);
  const backward = flattenRows(
    [...attempts].reverse(), Object.fromEntries(Object.entries(slotsByAttempt).map(([id, slots]) => [id, [...slots].reverse()])), state,
  );
  assert.deepEqual([...identities(backward)].sort(), [...identities(forward)].sort());
  assert.notDeepEqual(identities(backward), identities(forward), 'only the listing order follows the input');
  const byIdentity = rows => new Map(rows.map(row => [row.identity, [row.kind, row.attempt.id, row.slot?.key, row.open]]));
  assert.deepEqual(byIdentity(backward), byIdentity(forward), 'each identity names the same row');
});

test('an attempt\'s display ordinal is its place among the attempts of its segment, counted from one, whatever its seq, and neither folding, a loaded slot list nor a later arrival moves it', () => {
  const attempts = [attemptRow(3), failedRow(17), progressRow(40, 'generating')];
  assert.deepEqual(ordinalsOf(attempts), { 3: { epoch: 1, ordinal: 1 }, 17: { epoch: 1, ordinal: 2 }, 40: { epoch: 1, ordinal: 3 } });
  assert.deepEqual(ordinalsOf([]), {});

  const ordinalRows = rows => Object.fromEntries(rows.filter(row => row.kind === 'attempt').map(row => [row.attempt.id, [row.epoch, row.ordinal]]));
  assert.deepEqual(ordinalRows(flattenRows(attempts, {}, createViewState())), { 3: [1, 1], 17: [1, 2], 40: [1, 3] }, 'each parent row carries its segment and its ordinal');
  const listed = flattenRows(attempts, { 3: [slotRow(10)] }, opening(3, 17, 40));
  const others = listed.filter(row => row.kind !== 'attempt');
  assert.deepEqual(others.map(row => row.kind), ['call', 'slot', 'call', 'call'], 'the rows under the parents');
  assert.equal(others.every(row => !('ordinal' in row) && !('epoch' in row)), true, 'a call or slot row has neither of its own');

  const folded = [3, 17, 40].reduce((state, attemptId) => reduceView(state, { type: 'toggle', attemptId, open: attemptId === 40 }), createViewState());
  assert.deepEqual(ordinalRows(flattenRows(attempts, { 3: [slotRow(10)] }, folded)), { 3: [1, 1], 17: [1, 2], 40: [1, 3] }, 'folding or opening a group renumbers nothing');

  const appended = [...attempts, attemptRow(52)];
  assert.deepEqual(ordinalRows(flattenRows(appended, {}, createViewState())), { 3: [1, 1], 17: [1, 2], 40: [1, 3], 52: [1, 4] }, 'a later attempt takes the next ordinal and moves no earlier one');
  const legacyAndUnknown = [attemptRow(5, { legacy: true, startedAt: null }), attemptRow(9, { status: 'unknown', slots: null, endedAt: null })];
  assert.deepEqual(ordinalsOf(legacyAndUnknown), { 5: { epoch: 1, ordinal: 1 }, 9: { epoch: 1, ordinal: 2 } }, 'a legacy attempt and one with no terminal evidence count like any other');
});

test('the ordinal restarts at one in each segment, a segment is the host\'s boundary count plus one, and a segment with no attempt keeps its number unused', () => {
  const attempts = [0, 0, 1, 1, 3].map((epoch, at) => attemptRow(10 + at, { epoch }));
  assert.deepEqual(Object.values(ordinalsOf(attempts)).map(({ epoch, ordinal }) => [epoch, ordinal]), [[1, 1], [1, 2], [2, 1], [2, 2], [4, 1]], 'the segments skipped by no attempt are not renumbered');
  assert.deepEqual(
    flattenRows(attempts, {}, createViewState()).filter(row => row.kind === 'attempt').map(row => [row.epoch, row.ordinal]),
    [[1, 1], [1, 2], [2, 1], [2, 2], [4, 1]],
  );
  const { epoch: _, ...older } = attemptRow(7);
  assert.deepEqual(ordinalsOf([older, attemptRow(8, { epoch: 0 })]), { 7: { epoch: 1, ordinal: 1 }, 8: { epoch: 1, ordinal: 2 } }, 'a row from a host that sends no segment reads as the first');
});

// A compaction that cut 74000 tokens at a rebuild of 8000 tokens, its summary call having read 48000 tokens from the cache and taken 1000 more (400 uncached and 600 written to it), under a write-to-read price ratio of 12, pays back (12 − 1) × 8000 + 48000 + 12 × 1000 = 148000 read-price tokens, which two later steps of 74000 each cover exactly.
const CUT = { before: 100_000, after: 26_000, delta: -74_000, miss: 8_000 };
const SUMMARY = { input: 400, output: 2_400, cacheRead: 48_000, cacheWrite: 600 };
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const paying = (id, overrides = {}) => attemptRow(id, { contextChange: CUT, cRatio: 12, call: { usage: SUMMARY }, stepN: 8, epoch: 0, ...overrides });
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

test('the parent rows carry the status they show, and no call or slot row carries one', () => {
  const attempts = [paying(1), paying(2, { stepN: 2 }), failedRow(3)];
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const rows = flattenRows(attempts, { 1: [slotRow(10)] }, reduceView(state, { type: 'toggle', attemptId: 3, open: true }));
  assert.deepEqual(rows.filter(row => row.kind === 'attempt').map(row => row.shownStatus), ['paid', 'committed', 'failed']);
  const others = rows.filter(row => row.kind !== 'attempt');
  assert.deepEqual(others.map(row => row.kind), ['call', 'slot']);
  assert.equal(others.some(row => 'shownStatus' in row), false);
  assert.equal(rows.find(row => row.identity === 'attempt:1').attempt.status, 'committed', 'the row\'s own status is left as the host gave it');
});

// A committed compaction whose first call after it saw `after` tokens of context and rebuilt `miss` of them in the cache.
const rebuilt = (id, after, miss, overrides = {}) => attemptRow(id, { contextChange: { before: after + 1_000, after, delta: -1_000, miss }, epoch: 0, ...overrides });
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

test('the parent rows carry whether their rebuild is unexpected, and no call or slot row does', () => {
  const attempts = [rebuilt(1, 10_000, 0), rebuilt(2, 12_000, 9_000), rebuilt(3, 13_000, 1_004)];
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 2, open: false });
  const rows = flattenRows(attempts, { 2: [slotRow(10)] }, state);
  assert.deepEqual(rows.filter(row => row.kind === 'attempt').map(row => row.missWarned), [false, true, false]);
  const others = rows.filter(row => row.kind !== 'attempt');
  assert.deepEqual(others.map(row => row.kind), ['call', 'slot']);
  assert.equal(others.some(row => 'missWarned' in row), false);
});

test('a preview folds the whitespace of a text to single spaces and trims it, keeps a text that fits and ends a longer one with an ellipsis at the cut', () => {
  assert.equal(previewOf('  read\n\n the   file\t now '), 'read the file now');
  assert.equal(previewOf(''), '');
  const fits = 'x'.repeat(PREVIEW_CHARS);
  assert.equal(previewOf(fits), fits);
  assert.equal(previewOf(`${fits}y`), `${fits}…`);
  assert.equal(previewOf(`${'x'.repeat(PREVIEW_CHARS - 1)} \n y z`), `${'x'.repeat(PREVIEW_CHARS - 1)}…`, 'the cut does not leave a space before the ellipsis');
});

test('a call\'s preview is its response alone, a reason in its place for a failed or cancelled attempt, and none where there is no text to show: no input, no response, an empty or blank one', () => {
  const previewsOf = attempt => flattenRows([attempt], {}, opening(attempt.id)).filter(row => row.kind !== 'slot').map(row => row.preview);
  const open = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  assert.deepEqual(previewsOf(attemptRow(1, { call: { input: 'the same prompt', output: '["note"]' } })), [{ output: '["note"]' }, { output: '["note"]' }], 'the parent and the call row preview the same response, and neither carries the input');
  const failedWith = attemptRow(2, { status: 'failed', reason: 'could not\nstart', slots: null, call: { output: 'a response that was refused' } });
  assert.deepEqual(previewsOf(failedWith).map(preview => preview.output), ['could not start', 'could not start'], 'the reason comes before the response');
  const noResponse = attemptRow(3, { status: 'generating', endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null } });
  assert.deepEqual(previewsOf(noResponse).map(preview => preview.output), [null, null], 'no response, no preview');
  for (const output of ['', '  \n ']) assert.deepEqual(previewsOf(attemptRow(4, { call: { output } })).map(preview => preview.output), [null, null], `${JSON.stringify(output)} is no text to show`);
  assert.deepEqual(previewsOf(attemptRow(5, { status: 'cancelled', reason: '', slots: null, call: { output: '' } })).map(preview => preview.output), [null, null], 'a blank reason shows nothing');
  assert.deepEqual(previewsOf(attemptRow(6, { status: 'unknown', slots: null, reason: null, call: { output: '["kept"]' } })).map(preview => preview.output), ['["kept"]', '["kept"]'], 'an unknown attempt has no reason to show');
  const slots = [slotRow(10, { input: 'the source', output: 'the note' })];
  const slotRows = flattenRows([attemptRow(1)], { 1: slots }, open).filter(row => row.kind === 'slot');
  assert.deepEqual(slotRows.map(row => row.preview), [{ input: 'the source', output: 'the note' }], 'a slot keeps its source-to-summary pair');
});

test('a call and its parent preview a response or reason longer than a slot side whole and folded, with no cut of their own, while a slot side keeps its cut', () => {
  const long = `${'word '.repeat(PREVIEW_CHARS)}end`;
  const folded = `${'word '.repeat(PREVIEW_CHARS)}end`;
  const previewsOf = attempt => flattenRows([attempt], {}, opening(attempt.id)).filter(row => row.kind !== 'slot').map(row => row.preview.output);
  assert.deepEqual(previewsOf(attemptRow(1, { call: { output: long.replaceAll(' ', '\n') } })), [folded, folded], 'the response is folded, not cut');
  assert.deepEqual(previewsOf(attemptRow(2, { status: 'failed', reason: long, slots: null })), [folded, folded], 'the reason is not cut');
  const slotRows = flattenRows([attemptRow(1)], { 1: [slotRow(10, { input: long, output: long })] }, reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false })).filter(row => row.kind === 'slot');
  assert.equal(slotRows[0].preview.input, previewOf(long));
  assert.equal(slotRows[0].preview.output, previewOf(long));
  assert.ok(slotRows[0].preview.output.endsWith('…'), 'a slot side is still cut');
});

test('a call and its parent preview the response the host displays, the raw output only where the host sent no display, and a reason still comes first', () => {
  const previewsOf = (attempt) => flattenRows([attempt], {}, opening(attempt.id)).filter(row => row.kind !== 'slot').map(row => row.preview.output);
  assert.deepEqual(previewsOf(attemptRow(1, { call: { output: '["alpha","beta"]', outputDisplay: 'alpha\nbeta' } })), ['alpha beta', 'alpha beta'], 'both rows read the display, whitespace folded');
  assert.deepEqual(previewsOf(attemptRow(2, { call: { output: '["alpha","beta"]' } })), ['["alpha","beta"]', '["alpha","beta"]'], 'a host that sends no display leaves the raw output');
  assert.deepEqual(previewsOf(attemptRow(3, { call: { output: '["alpha"', outputDisplay: '["alpha"' } })), ['["alpha"', '["alpha"'], 'a text the host could not unwrap');
  assert.deepEqual(previewsOf(attemptRow(4, { call: { output: '[]', outputDisplay: '' } })), [null, null], 'an empty display is no text to show, whatever the raw output holds');
  assert.deepEqual(previewsOf(attemptRow(5, { call: { output: null, outputDisplay: null } })), [null, null]);
  const failed = attemptRow(6, { status: 'failed', reason: 'refused', slots: null, call: { output: '["alpha"]', outputDisplay: 'alpha' } });
  assert.deepEqual(previewsOf(failed), ['refused', 'refused']);
  const open = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  assert.equal(flattenRows([attemptRow(1, { call: { output: '["alpha"]', outputDisplay: 'alpha' } })], {}, open)[0].attempt.call.output, '["alpha"]', 'the row keeps the raw output beside the display');
});

test('a slot previews the display of its source where the host sent one and its input where it did not, and its C string as it is whatever it looks like', () => {
  const open = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const slots = [
    slotRow(10, { input: 'read {"file_path":"a.js"}', inputDisplay: 'read\nfile pruned', output: '["kept","as","is"]' }),
    slotRow(20, { input: 'old host source', output: 'a note' }),
    slotRow(30, { input: 'x', inputDisplay: '', output: 'n' }),
  ];
  const rows = flattenRows([attemptRow(1)], { 1: slots }, open).filter(row => row.kind === 'slot');
  assert.deepEqual(rows.map(row => row.preview), [
    { input: 'read file pruned', output: '["kept","as","is"]' }, { input: 'old host source', output: 'a note' }, { input: '', output: 'n' },
  ]);
});

test('a source falls into a category of its own by its event type and producer kind: a human\'s user message is the user, any other recorded kind of a user message an injection, the other known types their own, and anything missing or unknown is other', () => {
  const user = kind => ({ type: 'user/message', kind });
  assert.equal(sourceCategoryOf(user('user')), 'user');
  assert.equal(sourceCategoryOf(user('runtime-context')), 'injected');
  assert.equal(sourceCategoryOf(user('a-kind-no-list-names')), 'injected', 'no list of producers decides it');
  assert.equal(sourceCategoryOf(user(null)), 'other', 'a user message that records no source');
  assert.equal(sourceCategoryOf({ type: 'developer/message', kind: 'user' }), 'developer', 'the type decides first');
  assert.equal(sourceCategoryOf({ type: 'system/message', kind: 'system-prompt' }), 'system');
  assert.equal(sourceCategoryOf({ type: 'tool/result', kind: 'tool' }), 'tool');
  assert.equal(sourceCategoryOf({ type: 'assistant/message', kind: 'model' }), 'assistant');
  assert.equal(sourceCategoryOf({ type: 'plugin:x/y', kind: null }), 'other');
  assert.equal(sourceCategoryOf(undefined), 'other', 'a host that sends no source');
  assert.equal(sourceCategoryOf(null), 'other');
});

test('a slot is titled by its turn and step, by its turn alone, and by the category of its source where it has neither', () => {
  const t = (key, params = {}) => `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`;
  const user = { type: 'user/message', kind: 'user' };
  assert.equal(slotTitleOf({ turn: 2, step: 3, source: user }, t), 'monitor.object.turn(turn=2) · monitor.object.step(step=3)');
  assert.equal(slotTitleOf({ turn: 2, step: null, source: user }, t), 'monitor.object.turn(turn=2)');
  assert.equal(slotTitleOf({ turn: null, step: null, source: user }, t), 'monitor.source.user()');
  assert.equal(slotTitleOf({ turn: null, step: null, source: { type: 'tool/result', kind: 'tool' } }, t), 'monitor.source.tool()');
});

test('a slot\'s preview pairs the source the call saw with the slot\'s C string, an empty string being a preview of its own', () => {
  const open = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const slots = [slotRow(10, { input: 'read\n the file', output: 'the file was read' }), slotRow(20, { input: 'noise', output: '' })];
  const rows = flattenRows([attemptRow(1)], { 1: slots }, open).filter(row => row.kind === 'slot');
  assert.deepEqual(rows.map(row => row.preview), [{ input: 'read the file', output: 'the file was read' }, { input: 'noise', output: '' }]);
});

// attemptRow(1) starts at 1_001, its call ends at 1_501 and the attempt at 1_901.
const NOW = 9_001;
const START = 1_001;

test('an attempt in progress is as old as the clock says, a finished one keeps the difference of its recorded times, and an unrecorded or unknown one has none', () => {
  const committed = attemptRow(1);
  assert.equal(elapsedOf(committed, 'attempt', NOW), 900);
  assert.equal(elapsedOf(committed, 'attempt', NOW + 5_000), 900, 'the clock does not move a finished attempt');
  for (const status of ['failed', 'cancelled']) assert.equal(elapsedOf(attemptRow(1, { status }), 'attempt', NOW), 900, status);
  for (const status of ['generating', 'validating']) {
    const running = attemptRow(1, { status, endedAt: null });
    assert.equal(elapsedOf(running, 'attempt', NOW), NOW - START, status);
    assert.equal(elapsedOf(running, 'attempt', NOW + 1_000), NOW + 1_000 - START, `${status} follows the clock`);
    assert.equal(elapsedOf(running, 'attempt', START - 50), 0, `${status} never reads below zero`);
  }
  assert.equal(elapsedOf(attemptRow(1, { status: 'unknown', endedAt: null }), 'attempt', NOW), null, 'no terminal evidence, no end to measure');
  assert.equal(elapsedOf(attemptRow(1, { startedAt: null, legacy: true }), 'attempt', NOW), null, 'an attempt of old data has no start');
  assert.equal(elapsedOf(attemptRow(1, { endedAt: null }), 'attempt', NOW), null, 'a settled attempt without its end time');
});

test('a call is as old as the clock says while its stream runs and keeps its own difference of recorded times once it ends, apart from its attempt\'s, and takes no start from a first chunk', () => {
  const committed = attemptRow(1);
  assert.equal(elapsedOf(committed, 'call', NOW), 500);
  assert.notEqual(elapsedOf(committed, 'call', NOW), elapsedOf(committed, 'attempt', NOW), 'the call ends before the attempt');
  const validating = attemptRow(1, { status: 'validating', endedAt: null });
  assert.equal(elapsedOf(validating, 'call', NOW), 500, 'the call is over while the attempt goes on');
  assert.equal(elapsedOf(validating, 'attempt', NOW), NOW - START);
  const generatingCall = { state: 'generating', endedAt: null, finish: null, output: null, usage: null };
  const generating = attemptRow(1, { status: 'generating', endedAt: null, call: generatingCall });
  assert.equal(elapsedOf(generating, 'call', NOW), NOW - START);
  assert.equal(elapsedOf(generating, 'call', NOW + 1_000), NOW + 1_000 - START);
  assert.equal(elapsedOf(attemptRow(1, { status: 'failed', call: { state: 'absent', endedAt: null } }), 'call', NOW), null, 'no call, no duration');
  assert.equal(elapsedOf(attemptRow(1, { status: 'unknown', endedAt: null }), 'call', NOW), 500, 'a recorded call keeps its duration whatever the attempt came to');
  assert.equal(elapsedOf(attemptRow(1, { startedAt: null, legacy: true }), 'call', NOW), null, 'no start is inferred for the call');
  assert.equal(elapsedOf({ ...committed, firstAt: START + 300, response: { firstAt: START + 300 } }, 'call', NOW), 500, 'a first chunk starts nothing');
});

test('the drawer width stays within the bounds and leaves the list its least width, rounded to whole pixels', () => {
  const wide = 2_000;
  assert.equal(clampDrawerWidth(500, wide), 500);
  assert.equal(clampDrawerWidth(DRAWER_MIN_WIDTH - 100, wide), DRAWER_MIN_WIDTH);
  assert.equal(clampDrawerWidth(DRAWER_MAX_WIDTH + 100, wide), DRAWER_MAX_WIDTH);
  assert.equal(clampDrawerWidth(400.4, wide), 400);
  assert.equal(clampDrawerWidth(400.5, wide), 401);
  const medium = DRAWER_MIN_WIDTH + LIST_MIN_WIDTH + 100;
  assert.equal(clampDrawerWidth(DRAWER_MAX_WIDTH, medium), DRAWER_MIN_WIDTH + 100, 'the list keeps its width');
  assert.equal(clampDrawerWidth(DRAWER_MAX_WIDTH, 100), DRAWER_MIN_WIDTH, 'a container too narrow for both leaves the drawer its least');
});

test('a resize sets the clamped width and nothing else, and key steps carry it to the bounds and stop there', () => {
  const selected = reduceView(createViewState(), { type: 'select', kind: 'call', attemptId: 3 });
  const resized = reduceView(selected, { type: 'resize', width: 5_000, containerWidth: 2_000 });
  assert.equal(resized.drawerWidth, DRAWER_MAX_WIDTH);
  assert.deepEqual({ ...resized, drawerWidth: null }, { ...selected, drawerWidth: null }, 'the selection and the expansion are not touched');
  assert.equal(reduceView(resized, { type: 'resize', width: 1, containerWidth: 2_000 }).drawerWidth, DRAWER_MIN_WIDTH);

  let state = createViewState();
  for (let press = 0; press < 100; press += 1) state = reduceView(state, { type: 'resize', width: state.drawerWidth + DRAWER_KEY_STEP, containerWidth: 2_000 });
  assert.equal(state.drawerWidth, DRAWER_MAX_WIDTH);
  assert.equal(reduceView(state, { type: 'resize', width: state.drawerWidth - DRAWER_KEY_STEP, containerWidth: 2_000 }).drawerWidth, DRAWER_MAX_WIDTH - DRAWER_KEY_STEP);
  for (let press = 0; press < 100; press += 1) state = reduceView(state, { type: 'resize', width: state.drawerWidth - DRAWER_KEY_STEP, containerWidth: 2_000 });
  assert.equal(state.drawerWidth, DRAWER_MIN_WIDTH);
});

test('an elapsed span reads whole milliseconds under a second, seconds to a tenth under a minute, else minutes and whole seconds', () => {
  assert.equal(formatElapsed(0), '0 ms');
  assert.equal(formatElapsed(999), '999 ms');
  assert.equal(formatElapsed(1_000), '1.0 s');
  assert.equal(formatElapsed(59_940), '59.9 s');
  assert.equal(formatElapsed(60_000), '1 m 0 s');
  assert.equal(formatElapsed(125_900), '2 m 5 s');
});

// ── Handoff rows ──────────────────────────────────────────────────────────────

/** The turns a handoff's detail lists, as the host's `turns` give them. */
const turnsOf = (...records) => records.map(([user, note, address = null]) => ({ address, user, note }));

test('a handoff row, its content row and its turn rows have identities of their own, by kind and the handoff id and the turn\'s place in it, and none shares an identity with an attempt\'s row of the same id', () => {
  const rows = [
    { kind: 'attempt', attemptId: 7 }, { kind: 'call', attemptId: 7 }, { kind: 'handoff', handoffId: 7 }, { kind: 'content', handoffId: 7 },
    { kind: 'turn', handoffId: 7, turn: 0 }, { kind: 'turn', handoffId: 7, turn: 1 }, { kind: 'turn', handoffId: 1, turn: 7 },
  ];
  assert.equal(new Set(rows.map(rowIdentity)).size, rows.length);
  assert.equal(rowIdentity({ kind: 'turn', handoffId: 7, turn: 1 }), rowIdentity({ turn: 1, handoffId: 7, kind: 'turn' }));
  assert.equal(rowIdentity({ kind: 'content', handoffId: 7 }), rowIdentity({ kind: 'content', handoffId: 7, turn: 4 }), 'a turn number names nothing of the content row');
});

test('a handoff group opens by its own toggle, and selecting its content or one of its turns keeps the identity and clears what a compaction row would have kept', () => {
  const opened = reduceView(createViewState(), { type: 'toggle', handoffId: 7, open: false });
  assert.equal(isOpen(opened, 7), true);
  assert.equal(isOpen(opened, 8), false);
  assert.equal(isOpen(reduceView(opened, { type: 'toggle', handoffId: 7, open: true }), 7), false);

  const content = reduceView(opened, { type: 'select', kind: 'content', handoffId: 7 });
  assert.deepEqual(content.selected, { identity: rowIdentity({ kind: 'content', handoffId: 7 }), kind: 'content', handoffId: 7, turn: null });
  assert.equal(reduceView(content, { type: 'select', kind: 'content', handoffId: 7 }), content, 'the same identity keeps the selection');
  const turn = reduceView(content, { type: 'select', kind: 'turn', handoffId: 7, turn: 2 });
  assert.deepEqual(turn.selected, { identity: rowIdentity({ kind: 'turn', handoffId: 7, turn: 2 }), kind: 'turn', handoffId: 7, turn: 2 });
  assert.deepEqual(turn.overrides, opened.overrides, 'a selection never changes the expansion');
  const collapsed = reduceView(turn, { type: 'toggle', handoffId: 7, open: true });
  assert.deepEqual(collapsed.selected, turn.selected, 'a collapsed group keeps its selection');
});

test('the handoffs and the attempts are listed in one order by id, each group by its own id, and a view with no handoffs lists the attempts as before', () => {
  const attempts = [attemptRow(2, { epoch: 1 }), attemptRow(9, { epoch: 1 })];
  const handoffs = [handoffRow(5), handoffRow(11), handoffRow(1)];
  const rows = flattenRows(attempts, {}, createViewState(), handoffs);
  assert.deepEqual(identities(rows), ['handoff:1', 'attempt:2', 'handoff:5', 'attempt:9', 'handoff:11']);
  assert.deepEqual(rows.map(row => row.kind), ['handoff', 'attempt', 'handoff', 'attempt', 'handoff']);
  assert.equal(rows[0].handoff, handoffs[2], 'a row carries the handoff row it lists');
  assert.deepEqual(identities(flattenRows(attempts, {}, createViewState())), ['attempt:2', 'attempt:9']);
  assert.deepEqual(rows.filter(row => row.kind === 'attempt').map(({ epoch, ordinal }) => ({ epoch, ordinal })), [{ epoch: 2, ordinal: 1 }, { epoch: 2, ordinal: 2 }], 'a handoff of the same segment takes no number from the compactions');
});

test('a handoff group is closed unless the user opened it, and open it lists its content row and then a row per turn of its loaded detail, none before the turns arrive', () => {
  const handoffs = [handoffRow(5)];
  const turnsByHandoff = { 5: turnsOf(['first', 'note one'], ['second', null]) };
  const closed = flattenRows([], {}, createViewState(), handoffs, turnsByHandoff);
  assert.deepEqual(identities(closed), ['handoff:5']);
  assert.equal(closed[0].open, false);

  const state = reduceView(createViewState(), { type: 'toggle', handoffId: 5, open: false });
  const open = flattenRows([], {}, state, handoffs, turnsByHandoff);
  assert.deepEqual(identities(open), ['handoff:5', 'content:5', 'turn:5:0', 'turn:5:1']);
  assert.deepEqual(open.map(row => row.kind), ['handoff', 'content', 'turn', 'turn']);
  assert.equal(open[0].open, true);
  assert.deepEqual(open.filter(row => row.kind === 'turn').map(row => row.at), [0, 1]);
  assert.deepEqual(open.filter(row => row.kind === 'turn').map(row => row.turn), turnsByHandoff[5]);
  assert.deepEqual(identities(flattenRows([], {}, state, handoffs)), ['handoff:5', 'content:5'], 'a detail not loaded yet lists no turns');
  assert.deepEqual(identities(flattenRows([], {}, state, handoffs, { 5: [] })), ['handoff:5', 'content:5', 'placeholder:5'], 'a loaded list of no turns says so');
  assert.equal(identities(flattenRows([], {}, state, handoffs, turnsByHandoff)).includes('turn:5:0'), true, 'a turn keeps its identity whatever its place in the list');
  assert.deepEqual(identities(flattenRows([attemptRow(1)], {}, state, [handoffRow(5), handoffRow(6)], { 5: turnsByHandoff[5], 6: turnsOf(['x', 'y']) })), ['attempt:1', 'handoff:5', 'content:5', 'turn:5:0', 'turn:5:1', 'handoff:6'], 'a closed handoff lists none of its turns');
});

test('an open group whose leaves are being read, could not be read or are none lists one placeholder row in their place, after its call or content row, and a ready list of leaves replaces it', () => {
  const attempt = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const handoff = reduceView(createViewState(), { type: 'toggle', handoffId: 5, open: false });
  const placeholders = rows => rows.filter(row => row.kind === 'placeholder').map(({ identity, state }) => [identity, state]);
  for (const [leaves, state] of [[LEAVES_LOADING, 'loading'], [LEAVES_FAILED, 'failed'], [[], 'empty']]) {
    const slots = flattenRows([attemptRow(1)], { 1: leaves }, attempt);
    assert.deepEqual(identities(slots), ['attempt:1', 'call:1', 'placeholder:1'], state);
    assert.deepEqual(placeholders(slots), [['placeholder:1', state]]);
    assert.equal(slots[2].attempt, slots[0].attempt, 'the placeholder carries the attempt it stands in for');
    const turns = flattenRows([], {}, handoff, [handoffRow(5)], { 5: leaves });
    assert.deepEqual(identities(turns), ['handoff:5', 'content:5', 'placeholder:5'], state);
    assert.deepEqual(placeholders(turns), [['placeholder:5', state]]);
    assert.equal(turns[2].handoff, turns[0].handoff, 'and the handoff');
  }
  assert.deepEqual(placeholders(flattenRows([attemptRow(1)], { 1: [slotRow(10)] }, attempt)), [], 'a list of slots has no placeholder');
  assert.deepEqual(placeholders(flattenRows([], {}, handoff, [handoffRow(5)], { 5: turnsOf(['first', null]) })), [], 'nor has a list of turns');
  assert.deepEqual(placeholders(flattenRows([attemptRow(1)], {}, attempt)), [], 'a list never asked for has none');
  assert.deepEqual(placeholders(flattenRows([], {}, handoff, [handoffRow(5)])), []);
});

test('a placeholder row stands only under an open group: a closed one, and a compaction that did not commit, have none however the lists stand, and each group has its own', () => {
  const closed = createViewState();
  assert.deepEqual(identities(flattenRows([attemptRow(1)], { 1: LEAVES_LOADING }, closed)), ['attempt:1']);
  assert.deepEqual(identities(flattenRows([], {}, closed, [handoffRow(5)], { 5: LEAVES_LOADING })), ['handoff:5']);
  const open = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  for (const status of ['generating', 'validating', 'failed', 'cancelled', 'unknown']) {
    assert.deepEqual(identities(flattenRows([attemptRow(1, { status, slots: null })], { 1: LEAVES_LOADING }, open)), ['attempt:1', 'call:1'], status);
  }
  const both = reduceView(open, { type: 'toggle', handoffId: 5, open: false });
  assert.deepEqual(
    identities(flattenRows([attemptRow(1), attemptRow(9)], { 1: [slotRow(10)] }, both, [handoffRow(5)], { 5: LEAVES_FAILED })),
    ['attempt:1', 'call:1', 'slot:1:10', 'handoff:5', 'content:5', 'placeholder:5', 'attempt:9'],
    'a group lists its own leaves and the next group is not touched by them',
  );
});

test('a handoff previews its next task, folded and not cut, and the preview is the same on the parent and its content row; no next task is no preview', () => {
  const state = reduceView(createViewState(), { type: 'toggle', handoffId: 5, open: false });
  const long = `${'word '.repeat(PREVIEW_CHARS)}end`;
  const folded = `${'word '.repeat(PREVIEW_CHARS)}end`;
  const previews = nextTask => flattenRows([], {}, state, [handoffRow(5, { nextTask })]).map(row => row.preview);
  assert.deepEqual(previews('ship the\n  handoff rows'), [{ output: 'ship the handoff rows' }, { output: 'ship the handoff rows' }]);
  assert.deepEqual(previews(long.replaceAll(' ', '\n')), [{ output: folded }, { output: folded }], 'folded, not cut');
  assert.deepEqual(previews(null), [{ output: null }, { output: null }]);
  assert.deepEqual(previews(' \n '), [{ output: null }, { output: null }], 'a blank next task is no text to show');
});

test('a turn previews its user text on the left and its note on the right, each folded to one line and cut like a slot\'s sides, and no note and an empty note are told apart by the row\'s own note', () => {
  const state = reduceView(createViewState(), { type: 'toggle', handoffId: 5, open: false });
  const long = `${'word '.repeat(PREVIEW_CHARS)}end`;
  const turns = turnsOf(['ask\nmore', 'did\nit'], [long, long], ['asked', null], ['asked', '']);
  const rows = flattenRows([], {}, state, [handoffRow(5)], { 5: turns }).filter(row => row.kind === 'turn');
  assert.deepEqual(rows[0].preview, { input: 'ask more', output: 'did it' });
  assert.equal(rows[1].preview.input, previewOf(long));
  assert.equal(rows[1].preview.output, previewOf(long));
  assert.ok(rows[1].preview.output.endsWith('…'), 'a side is cut');
  assert.deepEqual(rows[2].preview, { input: 'asked', output: '' });
  assert.deepEqual(rows[3].preview, { input: 'asked', output: '' });
  assert.equal(rows[2].turn.note, null);
  assert.equal(rows[3].turn.note, '');
});

test('a handoff\'s segment is the epoch count its row records plus one', () => {
  assert.equal(handoffSegmentOf({ epoch: 0 }), 1);
  assert.equal(handoffSegmentOf({ epoch: 4 }), 5);
});

test('the range of a handoff\'s context names the words it is given, a dash where the row has no change and a dash for each end it has none of', () => {
  const t = (key, params) => `${key}(${params.before},${params.after})`;
  assert.equal(contextRangeText({ before: 460, after: 710, delta: 250, miss: 510 }, t), 'monitor.meta.range(460,710)', 'a compaction keeps its own words');
  assert.equal(contextRangeText({ before: 460, after: 710 }, t, 'monitor.handoff.meta.range'), 'monitor.handoff.meta.range(460,710)');
  assert.equal(contextRangeText({ before: 460, after: null }, t, 'monitor.handoff.meta.range'), `monitor.handoff.meta.range(460,${NOT_AVAILABLE})`);
  assert.equal(contextRangeText(null, t, 'monitor.handoff.meta.range'), NOT_AVAILABLE);
});

// ── The settlement of a segment a /sw-continue cleared ───────────────────────

/** The continue row of the clear of segment `epoch - 1`, which cut `tailSteps` steps off after the segment's last carrier or checkpoint. */
const clearing = (id, epoch, tailSteps, overrides = {}) => handoffRow(id, { type: 'continue', epoch, tailSteps, ...overrides });
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
  assert.deepEqual(percentsWith(segment, [handoffRow(5, { epoch: 1, tailSteps: 2 })]), unchanged, 'a load that carries a count is still a load');
  assert.deepEqual(percentsWith(segment, [clearing(5, 2, 2)]), unchanged, 'the clear of the next segment');
  assert.deepEqual(percentsWith(segment, [clearing(5, 0, 2)]), unchanged, 'a continue that cleared no segment');
  for (const tailSteps of [null, undefined, NaN, 'many']) assert.deepEqual(percentsWith(segment, [clearing(5, 1, tailSteps)]), unchanged, `a count of ${String(tailSteps)}`);
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
    rows: [{ id: 1, ordinal: 1, saved: 222_000, cost: 148_000 }, { id: 2, ordinal: 2, saved: 148_000, cost: 148_000 }],
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
    { id: 1, ordinal: 1, saved: 296_000, cost: 148_000 },
    { id: 3, ordinal: 3, saved: null, cost: null },
    { id: 4, ordinal: 4, saved: 148_000, cost: 148_000 },
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
  const { tailSteps: _, ...older } = clearing(5, 1, 2);
  assert.deepEqual(percentsWith(segment, [older]), percentsOf(segment));
  assert.equal(settlementsOf(segment, [older]).get(5).saved, 74_000);
  assert.equal(settlementsOf(segment, [older]).get(5).steps, 9);
});

test('a settlement row has an identity of its own: the kind and the handoff id, never the handoff\'s, and selecting it keeps that handoff id with no turn', () => {
  assert.equal(rowIdentity({ kind: 'settlement', handoffId: 7 }), 'settlement:7');
  assert.notEqual(rowIdentity({ kind: 'settlement', handoffId: 7 }), rowIdentity({ kind: 'handoff', handoffId: 7 }));
  assert.notEqual(rowIdentity({ kind: 'settlement', handoffId: 7 }), rowIdentity({ kind: 'attempt', attemptId: 7 }));
  const selected = reduceView(createViewState(), { type: 'select', kind: 'settlement', handoffId: 7 });
  assert.deepEqual(selected.selected, { identity: 'settlement:7', kind: 'settlement', handoffId: 7, turn: null });
  assert.equal(reduceView(selected, { type: 'select', kind: 'settlement', handoffId: 7 }), selected);
  assert.deepEqual(reduceView(selected, { type: 'toggle', handoffId: 7, open: false }).selected, selected.selected, 'the handoff\'s own toggle leaves the selection');
});

test('the list puts the settlement of a cleared segment right before the continue that cleared it, whether that handoff is open or closed, among the rows in the order of their ids', () => {
  const attempts = [paying(1), paying(2, { stepN: 1 }), paying(9, { epoch: 1 })];
  const handoffs = [clearing(5, 1, 2), handoffRow(7, { epoch: 1 })];
  const closed = flattenRows(attempts, {}, createViewState(), handoffs);
  assert.deepEqual(identities(closed), ['attempt:1', 'attempt:2', 'settlement:5', 'handoff:5', 'handoff:7', 'attempt:9']);
  const row = closed[2];
  assert.equal(row.kind, 'settlement');
  assert.equal(row.handoff, handoffs[0], 'it carries the continue it stands before');
  assert.deepEqual(row.settlement, settlementsOf(attempts, handoffs).get(5));
  const open = flattenRows(attempts, {}, reduceView(createViewState(), { type: 'toggle', handoffId: 5, open: false }), handoffs);
  assert.deepEqual(identities(open), ['attempt:1', 'attempt:2', 'settlement:5', 'handoff:5', 'content:5', 'handoff:7', 'attempt:9'], 'opening the handoff moves the settlement nowhere');
  assert.deepEqual(identities(flattenRows(attempts, {}, createViewState())), ['attempt:1', 'attempt:2', 'attempt:9'], 'with no handoff there is none');
});

test('the compactions\' shown status reads the steps a clear cut off, as their progress does', () => {
  const attempts = [paying(1)];
  const status = handoffs => flattenRows(attempts, {}, createViewState(), handoffs).find(row => row.kind === 'attempt').shownStatus;
  assert.equal(status([]), 'committed');
  assert.equal(status([clearing(5, 1, 2)]), 'paid');
});
