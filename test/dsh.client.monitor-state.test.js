// The monitor view's pure state, `monitor-state.js`: the expansion, selection and filter reducer, the rows the list shows with the attempts' display ordinals, payback and settlements, the previews and elapsed times they show, the scroll tail and the drawer width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAWER_DEFAULT_WIDTH, DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_KEY_STEP, LIST_MIN_WIDTH, PREVIEW_CHARS,
  costWarningsOf, createViewState, reduceView, isOpen, slotTitleOf, rowIdentity, flattenRows, visibleGroups, previewOf, elapsedOf, formatElapsed, clampDrawerWidth,
  handoffSegmentOf, contextRangeText, NOT_AVAILABLE, LEAVES_LOADING, LEAVES_FAILED, SHORT_SUMMARY_OUTPUT,
} from '../dsh/src/client/monitor-state.js';
import { settlementsOf } from '../public/lib/compactionEconomics.js';
import { attemptRow, slotRow, handoffRow, failedRow, progressRow, paying, rebuilt, clearing, warmed, SUMMARY } from './helpers/dsh-monitor-wire.js';

test('a new view state has nothing selected, no choices of its own, the drawer at its default width and the filter listing everything', () => {
  assert.deepEqual(createViewState(), { overrides: {}, selected: null, drawerWidth: DRAWER_DEFAULT_WIDTH, filter: { category: 'all', warned: false } });
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

test('an attempt\'s row carries its segment and ordinal, and neither folding, a loaded slot list nor a later arrival moves it', () => {
  const attempts = [attemptRow(3), failedRow(17), progressRow(40, 'generating')];
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
});

test('the rows restart the ordinal at one in each segment', () => {
  const attempts = [0, 0, 1, 1, 3].map((epoch, at) => attemptRow(10 + at, { epoch }));
  assert.deepEqual(
    flattenRows(attempts, {}, createViewState()).filter(row => row.kind === 'attempt').map(row => [row.epoch, row.ordinal]),
    [[1, 1], [1, 2], [2, 1], [2, 2], [4, 1]],
  );
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

test('a slot is titled by its turn and step, by its turn alone, and by the category of its source where it has neither', () => {
  const t = (key, params = {}) => `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`;
  const user = { type: 'user/message', kind: 'user', category: 'user' };
  assert.equal(slotTitleOf({ turn: 2, step: 3, source: user }, t), 'monitor.object.turn(turn=2) · monitor.object.step(step=3)');
  assert.equal(slotTitleOf({ turn: 2, step: null, source: user }, t), 'monitor.object.turn(turn=2)');
  assert.equal(slotTitleOf({ turn: null, step: null, source: user }, t), 'monitor.source.user()');
  assert.equal(slotTitleOf({ turn: null, step: null, source: { type: 'tool/result', kind: 'tool', category: 'tool' } }, t), 'monitor.source.tool()');
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

// ── The settlement row of a segment a /sw-continue cleared ────────────────────

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

// ── The filter and the collapse of every group ────────────────────────────────

test('choosing another category or switching the warning filter changes the filter and closes the drawer, and choosing what is already chosen answers the state it was given', () => {
  const base = createViewState();
  const open = reduceView(base, { type: 'toggle', attemptId: 1, open: false });
  const wide = reduceView(open, { type: 'resize', width: 600, containerWidth: 1_400 });
  const selected = reduceView(wide, { type: 'select', kind: 'call', attemptId: 1 });
  assert.equal(reduceView(selected, { type: 'category', category: 'all' }), selected);
  assert.equal(reduceView(selected, { type: 'warned', warned: false }), selected);

  const handoffs = reduceView(selected, { type: 'category', category: 'handoff' });
  assert.deepEqual(handoffs.filter, { category: 'handoff', warned: false });
  assert.equal(handoffs.selected, null, 'a change of the filter closes the drawer, whether the selected row stays listed or not');
  assert.deepEqual(handoffs.overrides, selected.overrides, 'the groups the user opened stay open');
  assert.equal(handoffs.drawerWidth, selected.drawerWidth);
  assert.equal(reduceView(handoffs, { type: 'category', category: 'handoff' }), handoffs);

  const warned = reduceView(reduceView(handoffs, { type: 'select', kind: 'content', handoffId: 5 }), { type: 'warned', warned: true });
  assert.deepEqual(warned.filter, { category: 'handoff', warned: true }, 'each part of the filter leaves the other');
  assert.equal(warned.selected, null);
  assert.deepEqual(reduceView(warned, { type: 'category', category: 'compaction' }).filter, { category: 'compaction', warned: true });
  assert.deepEqual(reduceView(warned, { type: 'warned', warned: false }).filter, { category: 'handoff', warned: false });
  assert.deepEqual(base, createViewState(), 'a reduction leaves the state it was given');
});

test('collapsing closes every group the user opened and leaves the selection and the filter; with no group open it answers the state it was given', () => {
  let state = createViewState();
  for (const action of [{ type: 'toggle', attemptId: 1, open: false }, { type: 'toggle', attemptId: 2, open: false }, { type: 'toggle', handoffId: 5, open: false }, { type: 'warned', warned: true }, { type: 'select', kind: 'slot', attemptId: 1, slotKey: 10 }]) state = reduceView(state, action);

  const collapsed = reduceView(state, { type: 'collapse' });
  for (const id of [1, 2, 5]) assert.equal(isOpen(collapsed, id), false, `group ${id}`);
  assert.equal(collapsed.selected, state.selected, 'the selection under a collapsed group stays');
  assert.equal(collapsed.filter, state.filter);
  assert.equal(collapsed.drawerWidth, state.drawerWidth);
  assert.equal(reduceView(collapsed, { type: 'collapse' }), collapsed);

  const reclosed = reduceView(reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false }), { type: 'toggle', attemptId: 1, open: true });
  assert.equal(reduceView(reclosed, { type: 'collapse' }), reclosed, 'a group the user closed again is no open group');
});

// Two compactions of segment 0 that cut the context, the second rebuilding enough of the first's context in the cache to pass `MISS_WARNING_PERCENT` (a warning); the continue 5 that cleared the segment, a settlement before it; a later load 7; and a compaction of segment 1 that grew the context (a warning).
const mixed = () => ({ attempts: [paying(1), paying(2, { stepN: 1 }), attemptRow(9, { epoch: 1 })].map(warmed), handoffs: [clearing(5, 1, 2), handoffRow(7, { epoch: 1 })] });
const filtering = (...actions) => actions.reduce(reduceView, createViewState());
const category = name => ({ type: 'category', category: name });
const WARNED = { type: 'warned', warned: true };

test('a filter lists the groups of its category and, with the warning filter on, the compactions that carry a warning, whether the context grew or the cache rebuilt more than it grew by; a handoff and a settlement carry none', () => {
  const { attempts, handoffs } = mixed();
  const listed = (...actions) => identities(flattenRows(attempts, {}, filtering(...actions), handoffs));
  const ids = rows => [rows.attempts.map(attempt => attempt.id), rows.handoffs.map(handoff => handoff.id)];

  assert.deepEqual(listed(), ['attempt:1', 'attempt:2', 'settlement:5', 'handoff:5', 'handoff:7', 'attempt:9']);
  assert.deepEqual(listed(category('handoff')), ['settlement:5', 'handoff:5', 'handoff:7'], 'the settlement is of the handoffs');
  assert.deepEqual(listed(category('compaction')), ['attempt:1', 'attempt:2', 'attempt:9']);
  assert.deepEqual(listed(WARNED), ['attempt:2', 'attempt:9'], 'the rebuild of the cache and the growth of the context are each a warning');
  assert.deepEqual(listed(WARNED, category('compaction')), ['attempt:2', 'attempt:9']);
  assert.deepEqual(listed(WARNED, category('handoff')), [], 'the two filters intersect');
  assert.deepEqual(listed(WARNED, { type: 'warned', warned: false }), listed());

  assert.deepEqual(ids(visibleGroups(attempts, handoffs, filtering().filter)), [[1, 2, 9], [5, 7]]);
  assert.deepEqual(ids(visibleGroups(attempts, handoffs, filtering(category('handoff')).filter)), [[], [5, 7]]);
  assert.deepEqual(ids(visibleGroups(attempts, handoffs, filtering(WARNED).filter)), [[2, 9], []]);
});

test('the filter hides rows and changes no figure of the rest: the ordinals, the shown status and the cache warning of a compaction read all the compactions and all the handoffs', () => {
  const { attempts, handoffs } = mixed();
  const attemptRows = state => Object.fromEntries(flattenRows(attempts, {}, state, handoffs).filter(row => row.kind === 'attempt').map(({ attempt, epoch, ordinal, shownStatus, missWarned }) => [attempt.id, { epoch, ordinal, shownStatus, missWarned }]));
  const all = attemptRows(createViewState());
  assert.deepEqual(all[1], { epoch: 1, ordinal: 1, shownStatus: 'paid', missWarned: false }, 'the steps of the cleared segment pay it back');
  assert.equal(all[2].missWarned, true);
  for (const actions of [[category('compaction')], [WARNED], [WARNED, category('compaction')]]) {
    const shown = attemptRows(filtering(...actions));
    for (const [id, figures] of Object.entries(shown)) assert.deepEqual(figures, all[id], `attempt ${id}`);
  }
  assert.deepEqual(Object.keys(attemptRows(filtering(WARNED))), ['2', '9']);
  assert.equal(flattenRows(attempts, {}, filtering(category('handoff')), handoffs).find(row => row.kind === 'settlement').settlement.count, 2, 'a settlement reads the compactions the filter hides');
});

test('a compaction the filter hides still pays back the ones it lists: the steps after a listed compaction count whether they are listed or not', () => {
  const rebuilding = attemptRow(2, { contextChange: { before: 150_000, after: 50_000, delta: -100_000, miss: 40_000 }, cRatio: 12, call: { usage: SUMMARY }, stepN: 4, epoch: 0 });
  const quiet = attemptRow(3, { contextChange: { before: 51_000, after: 50_000, delta: -1_000, miss: 0 }, stepN: 5, epoch: 0 });
  const attempts = [warmed(paying(1)), rebuilding, warmed(quiet)];
  const statusOf = state => Object.fromEntries(flattenRows(attempts, {}, state).map(row => [row.attempt.id, row.shownStatus]));
  assert.equal(statusOf(createViewState())[2], 'paid');
  assert.deepEqual(statusOf(filtering(WARNED)), { 2: 'paid' }, 'the compaction after it is not listed and still counts');
});

test('a group the filter hides lists none of its leaves and keeps its choice of open: it is open again where the filter lists it again', () => {
  const { attempts, handoffs } = mixed();
  const slots = { 1: [slotRow(10)], 2: [slotRow(20)] };
  const turns = { 5: [{ address: null, user: 'u', note: null }] };
  let state = filtering({ type: 'toggle', attemptId: 1, open: false }, { type: 'toggle', handoffId: 5, open: false });
  const before = identities(flattenRows(attempts, slots, state, handoffs, turns));
  assert.deepEqual(before, ['attempt:1', 'call:1', 'slot:1:10', 'attempt:2', 'settlement:5', 'handoff:5', 'content:5', 'turn:5:0', 'handoff:7', 'attempt:9']);

  state = reduceView(state, category('handoff'));
  assert.deepEqual(identities(flattenRows(attempts, slots, state, handoffs, turns)), ['settlement:5', 'handoff:5', 'content:5', 'turn:5:0', 'handoff:7']);
  state = reduceView(state, category('compaction'));
  assert.deepEqual(identities(flattenRows(attempts, slots, state, handoffs, turns)), ['attempt:1', 'call:1', 'slot:1:10', 'attempt:2', 'attempt:9']);
  state = reduceView(state, category('all'));
  assert.deepEqual(identities(flattenRows(attempts, slots, state, handoffs, turns)), before);
});

// ── The cold summary call ─────────────────────────────────────────────────────

const callOf = (cacheRead, overrides = {}, id = 1) => attemptRow(id, { call: { usage: { input: 10, output: 600, cacheRead, cacheWrite: 0 } }, contextChange: { before: 1_000, after: 900, delta: -100, miss: 0 }, ...overrides });

test('a cold call is a cost warning of its own beside the context and rebuild warnings, for a failed attempt too, and marks the call row and the warning filter', () => {
  assert.deepEqual(costWarningsOf(callOf(100), false), { call: 'monitor.meta.call.cold' });
  assert.deepEqual(costWarningsOf(callOf(900), false), {});
  assert.deepEqual(costWarningsOf(callOf(100, { contextChange: { before: 1_000, after: 1_100, delta: 100, miss: 0 } }), true), { context: 'monitor.meta.context.grew', miss: 'monitor.meta.miss.unexpected', call: 'monitor.meta.call.cold' }, 'the warnings above it are untouched');
  assert.deepEqual(costWarningsOf(attemptRow(2, { status: 'failed', contextChange: null, call: { usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } } }), false), { call: 'monitor.meta.call.cold' });
  assert.deepEqual(costWarningsOf(attemptRow(3, { status: 'generating', contextChange: null, call: { usage: null } }), false), {}, 'no usage yet');

  const attempts = [callOf(100), callOf(900, {}, 2)];
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const rows = flattenRows(attempts, {}, reduceView(state, WARNED));
  assert.deepEqual(rows.map(row => row.identity), ['attempt:1', 'call:1']);
  assert.deepEqual(rows.find(row => row.kind === 'call').warningKeys, ['monitor.meta.call.cold']);
});

// ── The short summary ─────────────────────────────────────────────────────────

const shortOf = (output, overrides = {}, id = 1) => attemptRow(id, { call: { usage: { input: 10, output, cacheRead: 1_000, cacheWrite: 0 } }, contextChange: { before: 1_000, after: 900, delta: -100, miss: 0 }, ...overrides });

test('a committed summary call is short when its output falls under the minimum, and not at the minimum; any other attempt, and a call with no usage, is never short', () => {
  assert.deepEqual(costWarningsOf(shortOf(SHORT_SUMMARY_OUTPUT - 1), false), { short: 'monitor.meta.call.short' });
  assert.deepEqual(costWarningsOf(shortOf(SHORT_SUMMARY_OUTPUT), false), {}, 'at the minimum');
  for (const status of ['failed', 'cancelled', 'generating', 'validating', 'unknown']) assert.deepEqual(costWarningsOf(shortOf(1, { status, contextChange: null }), false), {}, status);
  assert.deepEqual(costWarningsOf(shortOf(1, { call: { usage: null } }), false), {}, 'no usage');
});

test('a short summary stands beside the other cost warnings, marks the call row and the warning filter', () => {
  assert.deepEqual(costWarningsOf(shortOf(1, { contextChange: { before: 1_000, after: 1_100, delta: 100, miss: 0 } }), true), { context: 'monitor.meta.context.grew', miss: 'monitor.meta.miss.unexpected', short: 'monitor.meta.call.short' });
  const coldAndShort = shortOf(1, { call: { usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } } });
  assert.deepEqual(costWarningsOf(coldAndShort, false), { call: 'monitor.meta.call.cold', short: 'monitor.meta.call.short' }, 'a cold call that is also short keeps both');
  const state = reduceView(createViewState(), { type: 'toggle', attemptId: 1, open: false });
  const rows = flattenRows([shortOf(1), shortOf(900, {}, 2)], {}, reduceView(state, WARNED));
  assert.deepEqual(rows.map(row => row.identity), ['attempt:1', 'call:1']);
  assert.deepEqual(rows.find(row => row.kind === 'call').warningKeys, ['monitor.meta.call.short']);
});
