// The session mode (`dsh/src/inner-mode.js`) over the real `dsh-session` record functions where `SW_DSH_CHECKOUT` names a built checkout and a recording double elsewhere: the pure projection fold, the atomic selection and the plain subagent's inheritance.
import test from 'node:test';
import assert from 'node:assert/strict';

import { innerModeProjection, createModeSelection, createModeInheritance, MODE_RECORD_TYPE } from '../dsh/src/inner-mode.js';
import { modeKit, newSession, fakeAgents, forkSeedOf, withoutEventAt } from './helpers/dsh-mode-kit.js';
import { userMessage } from './helpers/dsh-events.js';

const projection = innerModeProjection({ pluginRecordOf: modeKit.pluginRecordOf });

// The state the registry's fold reaches over the session's whole log, as it folds a cell: `init` and then `apply` per event.
const fold = session => session.snapshotEvents().reduce((state, event) => projection.apply(state, event), projection.init());

const select = (session, enabled) => modeKit.appendPluginRecord(session, MODE_RECORD_TYPE, { v: 1, enabled });

test('a blank session is off and unlocked, the last mode record before the first turn/start decides, and turn/start locks the mode that stands', () => {
  const session = newSession('s-fold');
  assert.deepEqual(fold(session), { mode: 'off', locked: false });
  select(session, true);
  assert.deepEqual(fold(session), { mode: 'on', locked: false });
  select(session, false);
  select(session, true);
  select(session, false);
  assert.deepEqual(fold(session), { mode: 'off', locked: false }, 'the last of several records decides');
  select(session, true);
  session.append('turn/start', { turn: 1 });
  assert.deepEqual(fold(session), { mode: 'on', locked: true });
  select(session, false);
  assert.deepEqual(fold(session), { mode: 'on', locked: true }, 'a record after the first turn/start decides nothing');
});

// Stderr captured for the case, restored after it.
function captureStderr(t) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
  return lines;
}

test('a record whose data does not read as { v: 1, enabled: boolean } makes the mode invalid, the last record still decides, and repeated folds and reads write no diagnostic', (t) => {
  const lines = captureStderr(t);
  for (const data of [null, 7, 'on', [], {}, { v: 1 }, { v: 2, enabled: true }, { v: 1, enabled: 'yes' }, { enabled: true }]) {
    const session = newSession(`s-invalid-${JSON.stringify(data)}`);
    modeKit.appendPluginRecord(session, MODE_RECORD_TYPE, data);
    assert.deepEqual(fold(session), { mode: 'invalid', locked: false }, JSON.stringify(data));
  }
  const session = newSession('s-invalid-then-valid');
  modeKit.appendPluginRecord(session, MODE_RECORD_TYPE, { v: 1, enabled: 1 });
  const events = session.snapshotEvents();
  const readInvalid = () => events.reduce((state, event) => projection.apply(state, event), projection.init());
  for (let read = 0; read < 5; read += 1) assert.equal(readInvalid().mode, 'invalid');
  session.append('turn/start', { turn: 1 });
  assert.deepEqual(fold(session), { mode: 'invalid', locked: true }, 'a locked invalid mode stays invalid');
  const repaired = newSession('s-repaired');
  modeKit.appendPluginRecord(repaired, MODE_RECORD_TYPE, { v: 1 });
  select(repaired, true);
  assert.deepEqual(fold(repaired), { mode: 'on', locked: false }, 'a valid record after an invalid one decides');
  assert.deepEqual(lines, [], 'the fold and the reads wrote nothing');
});

test('the fold returns the state it was given for an event that changes nothing, so the registry does no downstream work', () => {
  const session = newSession('s-reference');
  select(session, true);
  const on = fold(session);
  session.append('turn/start', { turn: 1 });
  const locked = projection.apply(on, session.eventAt(1));
  assert.deepEqual(locked, { mode: 'on', locked: true });
  assert.equal(projection.apply(locked, session.eventAt(1)), locked, 'a second turn/start');
  assert.equal(projection.apply(locked, { type: 'plugin:other/thing', seq: 9, time: 1, data: {}, ignorable: true }), locked);
  assert.equal(projection.apply(on, { type: 'user/message', seq: 9, time: 1, data: {} }), on, 'an event that is not the unit\'s');
  assert.equal(projection.apply(on, { type: MODE_RECORD_TYPE, seq: 9, time: 1, data: { v: 1, enabled: false } }), on, 'an event of the record\'s type that is not an ignorable record');
  const restated = newSession('s-restated');
  select(restated, true);
  select(restated, true);
  assert.equal(projection.apply(fold(newSession('s-first')), restated.eventAt(0)), projection.apply(projection.init(), restated.eventAt(1)), 'a record that restates the mode reaches the one state it names');
});

test('the state schema accepts exactly the six states the fold reaches and refuses any other persisted value', () => {
  for (const mode of ['off', 'on', 'invalid']) {
    for (const locked of [false, true]) assert.deepEqual(projection.stateSchema.parse({ mode, locked }), { mode, locked });
  }
  for (const value of [null, undefined, 'on', {}, { mode: 'on' }, { locked: false }, { mode: 'maybe', locked: false }, { mode: 'on', locked: 1 }]) {
    assert.throws(() => projection.stateSchema.parse(value), JSON.stringify(value));
  }
});

// Stands in for the selection endpoint: the agents service reads the turn boundary the preset's lock reads, and the kit appends.
const selection = createModeSelection({ agents: fakeAgents(), appendPluginRecord: modeKit.appendPluginRecord });
const recordsOf = session => session.snapshotEvents().filter(event => event.type === MODE_RECORD_TYPE);

test('a selection on a blank session appends the record and answers selected, repeated selections each append one, and the mode folded is the last', async () => {
  const session = newSession('s-select');
  assert.equal(await selection(session, true), 'selected');
  assert.deepEqual(recordsOf(session).map(record => record.data), [{ v: 1, enabled: true }]);
  assert.deepEqual(fold(session), { mode: 'on', locked: false });
  assert.equal(await selection(session, false), 'selected');
  assert.deepEqual(recordsOf(session).map(record => record.data), [{ v: 1, enabled: true }, { v: 1, enabled: false }]);
  assert.deepEqual(fold(session), { mode: 'off', locked: false });
});

test('a selection after a turn/start, open or ended, answers locked and appends no record', async () => {
  const open = newSession('s-open-turn');
  open.append('turn/start', { turn: 1 });
  assert.equal(await selection(open, true), 'locked');
  assert.deepEqual(recordsOf(open), []);
  const ended = newSession('s-ended-turn');
  ended.append('turn/start', { turn: 1 });
  ended.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const before = ended.snapshotEvents().length;
  assert.equal(await selection(ended, true), 'locked', 'the lock holds once the turn has ended');
  assert.equal(ended.snapshotEvents().length, before);
  assert.deepEqual(fold(ended), { mode: 'off', locked: true });
});

test('the lock is read and the record appended in one synchronous stretch, so a turn/start appended right after the call cannot come before the record', async () => {
  const session = newSession('s-atomic');
  const pending = selection(session, true);
  session.append('turn/start', { turn: 1 });
  assert.equal(await pending, 'selected');
  assert.deepEqual(fold(session), { mode: 'on', locked: true }, 'the record is in the log before the turn/start');
  assert.ok(recordsOf(session)[0].seq < session.snapshotEvents().find(event => event.type === 'turn/start').seq);
});

// ── Children ─────────────────────────────────────────────────────────────────

// The listener over `parents`, the live sessions by id, reading modes with the fold, a child's first event with `readSession` (by default the child's own log, which is all the sessions it is handed) and appending through `append`.
// A child is handed with `Session.eventAt` unavailable, as under a DSH that has dropped it, and the listener's work is awaited as the serial `agent/created` dispatch awaits it.
function inheritanceOver(parents, append = modeKit.appendPluginRecord, { readSession, settings = () => ({ inheritInSubagents: true }) } = {}) {
  const children = new Map();
  const reads = [];
  const listener = createModeInheritance({
    readSettings: settings,
    sessionOf: id => parents.find(parent => parent.id === id),
    readMode: fold,
    readSession: readSession ?? (async (id) => { reads.push(id); return { events: children.get(id).snapshotEvents() }; }),
    appendPluginRecord: append,
  });
  const inherit = async (session) => {
    children.set(session.id, withoutEventAt(session));
    await listener({ agent: { session }, source: 'startup' });
  };
  return Object.assign(inherit, { reads });
}

const subagentOf = (parent, id, extra = {}) => newSession(id, { header: { origin: 'subagent', parentSession: parent.id }, ...extra });

test('a fork inherits the mode records with its prefix and the listener adds none, and a seeded or resumed child gets no copy, none of them read beyond what the cheap checks leave', async () => {
  const parent = newSession('p-fork');
  select(parent, true);
  const { type, data, surfaceOp } = userMessage({ text: 'Hello.' });
  parent.append(type, data, { surfaceOp });
  const seed = forkSeedOf(parent, 1);
  const fork = newSession('f1', { header: { isSeeded: true, origin: 'subagent', parentSession: parent.id }, seed, inheritedEventCount: 2 });
  assert.deepEqual(fold(fork), { mode: 'on', locked: false }, 'the prefix carries the record');
  const inherit = inheritanceOver([parent]);
  await inherit(fork);
  assert.deepEqual(recordsOf(fork).map(record => record.data), [{ v: 1, enabled: true }], 'the fork keeps the one record it inherited');
  assert.deepEqual(inherit.reads, [], 'a child that holds a seed is not read');

  const emptyFork = newSession('f0', { header: { isSeeded: true, origin: 'subagent', parentSession: parent.id }, seed: [], inheritedEventCount: 0 });
  await inherit(emptyFork);
  assert.deepEqual(recordsOf(emptyFork), [], 'a fork of an empty prefix: its first event is the inherited end-seed marker');
  const emptySeed = subagentOf(parent, 'seeded-empty', { seed: [] });
  await inherit(emptySeed);
  assert.deepEqual(recordsOf(emptySeed), [], 'a child whose first event is the end-seed marker, its header unseeded');
  assert.equal(emptySeed.header.isSeeded, false);
  assert.equal(emptySeed.firstLiveSeq, 0);
  assert.deepEqual(inherit.reads, ['f0', 'seeded-empty'], 'only a child that holds no seed is read');
  const earlier = newSession('earlier-run');
  earlier.append('turn/start', { turn: 1 });
  const resumed = newSession('resumed', { header: { origin: 'subagent', parentSession: parent.id }, seed: earlier.snapshotEvents() });
  await inherit(resumed);
  assert.deepEqual(recordsOf(resumed), [], 'a child that already holds events');
  assert.deepEqual(inherit.reads, ['f0', 'seeded-empty']);
});

test('a plain subagent gets its parent\'s valid mode, on or off, blank included, as its own record, which its fold reads', async () => {
  const expectations = [
    ['p-on', true, { mode: 'on', locked: false }],
    ['p-off', false, { mode: 'off', locked: false }],
    ['p-blank', undefined, { mode: 'off', locked: false }],
  ];
  for (const [parentId, selected, folded] of expectations) {
    const parent = newSession(parentId);
    if (selected !== undefined) select(parent, selected);
    const child = subagentOf(parent, `child-of-${parentId}`);
    await inheritanceOver([parent])(child);
    assert.deepEqual(recordsOf(child).map(record => record.data), [{ v: 1, enabled: parentId === 'p-on' }], parentId);
    assert.deepEqual(fold(child), folded, parentId);
  }
  const parent = newSession('p-top');
  select(parent, true);
  const toplevel = newSession('top');
  const inherit = inheritanceOver([parent]);
  await inherit(toplevel);
  assert.deepEqual(recordsOf(toplevel), [], 'a session that is not a subagent');
  assert.deepEqual(inherit.reads, [], 'and is not read');
});

test('a plain subagent is given its parent\'s mode only while the settings ask for it, read when the child is created: off settings leave it with no record and off, and a save that lands while its first event is read changes neither answer', async () => {
  const parent = newSession('p-setting');
  select(parent, true);

  const unasked = subagentOf(parent, 'child-unasked');
  const inheritUnasked = inheritanceOver([parent], modeKit.appendPluginRecord, { settings: () => ({ inheritInSubagents: false }) });
  await inheritUnasked(unasked);
  assert.deepEqual(recordsOf(unasked), [], 'no record is written');
  assert.deepEqual(fold(unasked), { mode: 'off', locked: false });
  assert.deepEqual(inheritUnasked.reads, [], 'a child that is not to inherit is not read');

  // The setting a save changes while the child's first event is read: the answer was fixed at creation.
  let inherit = true;
  const turnedOff = subagentOf(parent, 'child-turned-off');
  await inheritanceOver([parent], modeKit.appendPluginRecord, {
    settings: () => ({ inheritInSubagents: inherit }),
    readSession: async () => { inherit = false; return { events: turnedOff.snapshotEvents() }; },
  })(turnedOff);
  assert.deepEqual(recordsOf(turnedOff).map(record => record.data), [{ v: 1, enabled: true }], 'asked at creation, still given');

  inherit = false;
  const turnedOn = subagentOf(parent, 'child-turned-on');
  await inheritanceOver([parent], modeKit.appendPluginRecord, {
    settings: () => ({ inheritInSubagents: inherit }),
    readSession: async () => { inherit = true; return { events: turnedOn.snapshotEvents() }; },
  })(turnedOn);
  assert.deepEqual(recordsOf(turnedOn), [], 'not asked at creation, still not given');

  // A fork and a resumed child keep what they carry, whatever the setting says.
  const { type, data, surfaceOp } = userMessage({ text: 'Hello.' });
  parent.append(type, data, { surfaceOp });
  const seeded = forkSeedOf(parent, 1);
  const fork = newSession('f-unasked', { header: { isSeeded: true, origin: 'subagent', parentSession: parent.id }, seed: seeded, inheritedEventCount: 2 });
  await inheritanceOver([parent], modeKit.appendPluginRecord, { settings: () => ({ inheritInSubagents: false }) })(fork);
  assert.deepEqual(fold(fork), { mode: 'on', locked: false }, 'the fork\'s inherited prefix is untouched');
});

test('a parent that is invalid or missing, a first event that cannot be read and an append that throws each write one diagnostic and leave the child off', async (t) => {
  const lines = captureStderr(t);
  const invalid = newSession('p-bad');
  modeKit.appendPluginRecord(invalid, MODE_RECORD_TYPE, { v: 3 });
  const child = subagentOf(invalid, 'child-of-invalid');
  await inheritanceOver([invalid])(child);
  assert.deepEqual(recordsOf(child), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^child-of-invalid \[dsh-host\] inner_mode_not_inherited: .*invalid/);

  const orphan = subagentOf(newSession('gone'), 'orphan');
  await inheritanceOver([])(orphan);
  assert.deepEqual(recordsOf(orphan), []);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^orphan \[dsh-host\] inner_mode_not_inherited: .*gone/);

  const parent = newSession('p-on-failing');
  select(parent, true);
  const failing = subagentOf(parent, 'child-failing');
  await assert.doesNotReject(inheritanceOver([parent], () => { throw new Error('append refused'); })(failing));
  assert.deepEqual(recordsOf(failing), []);
  assert.equal(lines.length, 3);
  assert.match(lines[2], /^child-failing \[dsh-host\] inner_mode_not_inherited: append refused/);
  assert.deepEqual(fold(failing), { mode: 'off', locked: false });

  const unread = subagentOf(parent, 'child-unread');
  await assert.doesNotReject(inheritanceOver([parent], modeKit.appendPluginRecord, { readSession: async () => { throw new Error('read refused'); } })(unread));
  assert.deepEqual(recordsOf(unread), [], 'nothing is retried or filled in');
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^child-unread \[dsh-host\] inner_mode_not_inherited: .*read refused.*stays off/);
  assert.deepEqual(fold(unread), { mode: 'off', locked: false });
});
