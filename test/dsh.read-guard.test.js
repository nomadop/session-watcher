// The read guard (`dsh/src/read-guard.js`) over the scratch the real interpreter keeps: which reads it turns into an error, which it lets through, what it records, and how every doubt degrades. The services it reads are stand-ins that answer only what the guard asks of them.
import test, { describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createReadGuard, READ_BLOCK_RECORD_TYPE, readBlockFeedback } from '../dsh/src/read-guard.js';
import { isReadBlockRecord } from '../lib/inner-seal/read-block-record.js';
import { createScratchView } from '../lib/scratch-view.js';
import { createDshMeasurementProjection } from '../lib/harness/dsh/measurement-projection.js';
import { INNER_SEAL_KIND } from '../lib/inner-seal/carrier.js';
import { CWD, dshObservations, dshRig, readResultText, resolveModelPolicy, treeOf } from './helpers/attribution-fixtures.js';

const FILE = `${CWD}/src/a.js`;
const OTHER = `${CWD}/src/b.js`;
const LINES = ['export const alpha = 1;', 'export const beta = 2;', 'export const gamma = 3;', 'export const delta = 4;', 'export const epsilon = 5;'];
const textOf = lines => `${lines.join('\n')}\n`;
const shown = (lines, from = 1) => lines.map((text, index) => ({ number: from + index, text }));
const SESSION_ID = 'session-1';

// The scratch of a Projection fed the calls in order, over the files: what the live watcher's view reads.
function scratchAfter(calls, files = { [FILE]: textOf(LINES), [OTHER]: textOf(LINES) }) {
  const rig = dshRig({ files });
  const view = createScratchView();
  const projection = createDshMeasurementProjection({ cwd: CWD, resolveModelPolicy, ...view.observing(rig.interpreters) });
  calls.forEach((call, index) => {
    const { use, result } = dshObservations({ ...call, callId: `call_${index + 1}` });
    projection.project(use, {});
    projection.project(result, {});
  });
  return view.read();
}

const READ_A = { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(FILE, LINES) };
const asAssistant = { step: { turn: 2, step: 3 }, pruned: null };

// The guard with every service a stand-in, each overridable; `appended` collects the records it appends and `options.session` the session the executions run in.
function rig({ mode = 'on', scratch = scratchAfter([READ_A]), facts, nodes = [10], messages = [], recall = () => null, fs, tree, append } = {}) {
  const appended = [];
  const session = { id: SESSION_ID, header: { cwd: CWD }, surface: { nodes }, deriveMessages: () => messages };
  const factsOf = facts === undefined ? new Map(nodes.map(seq => [seq, asAssistant])) : facts;
  const guard = createReadGuard({
    readMode: () => ({ mode }),
    heldScratch: () => scratch,
    eventFacts: () => factsOf,
    recallRecord: (sessionId, toolUseId) => recall(sessionId, toolUseId),
    workingTree: tree ?? treeOf({ [FILE]: textOf(LINES), [OTHER]: textOf(LINES) }),
    fsOf: () => fs ?? { processPathFromHostPath: key => key, resolve: async mapped => ({ target: mapped }), processPath: target => target.target },
    appendPluginRecord: append ?? ((owner, type, data) => { appended.push({ owner, type, data }); return appended.length; }),
  });
  return { guard, session, appended };
}

const valueOf = (lines, path = FILE) => ({ path, offset: lines[0]?.number ?? 1, lines, totalLines: LINES.length });
const execOf = (session, overrides = {}) => ({
  name: 'read', callId: 'c1', arguments: { file_path: 'src/a.js' }, agent: { session }, signal: new AbortController().signal, ...overrides,
});
const successOf = (lines, overrides = {}) => ({ isError: false, value: valueOf(lines), content: [{ type: 'text', text: 'file text' }], ...overrides });
const ACCEPT = { kind: 'accept' };
const blockOf = async (guard, exec, result, decision = ACCEPT) => guard.postExecute(exec, result, async () => decision);

// A carrier source holding file `path`, with whatever else `entry` says of it.
const carrierOf = (entry, rest = {}) => ({ role: 'user', source: { kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [{ path: FILE, displayPath: FILE, state: 'readable', write: LINES.map((text, index) => [index + 1, text]), ...entry }], ...rest } });

function diagnostics() {
  const lines = [];
  mock.method(console, 'error', (line) => { lines.push(String(line)); });
  return lines;
}

describe('a read whose every line the context holds', () => {
  test('is blocked as an error whose one text block is the feedback of its lines and its path as the model wrote it, and the block is recorded once it reached the model', async () => {
    const { guard, session, appended } = rig();
    const exec = execOf(session);
    const decision = await blockOf(guard, exec, successOf(shown(LINES)));
    assert.equal(decision.kind, 'block');
    assert.deepEqual(decision.feedback, [{ type: 'text', text: readBlockFeedback({ first: 1, last: 5, path: 'src/a.js' }) }]);
    assert.equal(appended.length, 0, 'nothing is recorded before the result stands');
    guard.observeResult(exec, { isError: true, content: decision.feedback });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].owner, session);
    assert.equal(appended[0].type, READ_BLOCK_RECORD_TYPE);
    assert.deepEqual(appended[0].data, { v: 1, turn: 2, step: 3, callId: 'c1', path: 'src/a.js', first: 1, last: 5 });
    assert.ok(isReadBlockRecord(appended[0].data));
  });

  test('is blocked over the window it returned, and the contexts its decision carried stay with the block', async () => {
    const { guard, session } = rig();
    const contexts = [{ role: 'user', content: [] }];
    const decision = await blockOf(guard, execOf(session), successOf(shown(LINES.slice(1, 4), 2)), { kind: 'accept', additionalContexts: contexts });
    assert.equal(decision.kind, 'block');
    assert.equal(decision.additionalContexts, contexts);
    assert.deepEqual(decision.feedback, [{ type: 'text', text: readBlockFeedback({ first: 2, last: 4, path: 'src/a.js' }) }]);
  });

  test('is blocked when lines of the file come from a `cat` of it, since the scratch holds those lines whoever showed them', async () => {
    const scratch = scratchAfter([{ name: 'bash', args: { command: 'cat src/a.js' }, text: textOf(LINES) }]);
    const { guard, session } = rig({ scratch });
    assert.equal((await blockOf(guard, execOf(session), successOf(shown(LINES)))).kind, 'block');
  });

  test('is blocked under the key of a symlink when the execution world prints the real path of it', async () => {
    const LINK = `${CWD}/link.js`;
    const scratch = scratchAfter([{ name: 'read', args: { file_path: 'link.js' }, text: readResultText(LINK, LINES) }], { [LINK]: textOf(LINES) });
    const fs = { processPathFromHostPath: key => key, resolve: async mapped => ({ target: mapped.replace('link.js', 'src/a.js') }), processPath: target => target.target };
    const { guard, session } = rig({ scratch, fs, tree: treeOf({ [LINK]: textOf(LINES) }) });
    const exec = execOf(session, { arguments: { file_path: 'link.js' } });
    const decision = await blockOf(guard, exec, { ...successOf(shown(LINES)), value: valueOf(shown(LINES), FILE) });
    assert.equal(decision.kind, 'block');
  });
});

describe('a read the guard lets through unchanged', () => {
  const passes = async (setup, result, { exec: overrides, decision = ACCEPT } = {}) => {
    const { guard, session, appended } = setup;
    const exec = execOf(session, overrides);
    assert.equal(await blockOf(guard, exec, result, decision), decision, 'the very decision the listeners behind it came to');
    guard.observeResult(exec, result);
    assert.equal(appended.length, 0);
  };

  test('when one line is not held, another has other text, a long line was cut, or the read returned no line', async () => {
    const changed = [LINES[0], 'export const beta = 20;', ...LINES.slice(2)];
    await passes(rig(), successOf(shown([...LINES, 'export const zeta = 6;'])));
    await passes(rig(), successOf(shown(changed)));
    await passes(rig(), successOf(shown([LINES[0], `${LINES[1].slice(0, 8)}... (line truncated to 8 chars)`, ...LINES.slice(2)])));
    await passes(rig(), successOf([]));
  });

  test('when its mode is off or invalid, it is nested in a transport call, it failed, its signal was cancelled or a listener behind it replaced its content, value or decision', async () => {
    const ok = successOf(shown(LINES));
    await passes(rig({ mode: 'off' }), ok);
    await passes(rig({ mode: 'invalid' }), ok);
    await passes(rig(), ok, { exec: { parent: {} } });
    await passes(rig(), { ...ok, isError: true });
    await passes(rig(), ok, { exec: { signal: AbortSignal.abort() } });
    await passes(rig(), ok, { decision: { kind: 'accept', content: [{ type: 'text', text: 'spilled' }] } });
    await passes(rig(), ok, { decision: { kind: 'accept', value: { path: FILE } } });
    await passes(rig(), ok, { decision: { kind: 'block', feedback: [{ type: 'text', text: 'other' }] } });
    await passes(rig(), ok, { exec: { name: 'grep' } });
  });

  test('when the result\'s value is no read value, and no line is written for it', async () => {
    const lines = diagnostics();
    const ok = successOf(shown(LINES));
    await passes(rig(), { ...ok, value: 'not a read value' });
    await passes(rig(), { ...ok, value: { path: FILE, offset: 1, lines: [{ number: 'one', text: 1 }], totalLines: 1 } });
    mock.restoreAll();
    assert.deepEqual(lines, []);
  });

  test('when the file is one the scratch holds nothing of, whatever it holds of another', async () => {
    await passes(rig(), { ...successOf(shown(LINES)), value: valueOf(shown(LINES), OTHER) }, { exec: { arguments: { file_path: 'src/b.js' } } });
    await passes(rig(), successOf(shown(LINES)), { exec: { arguments: {} } });
  });
});

describe('the carriers of the surface leave a line unsure', () => {
  const blocksWith = async (messages, lines = shown(LINES)) => {
    const { guard, session } = rig({ messages });
    return (await blockOf(guard, execOf(session), successOf(lines))).kind;
  };

  test('a carrier that shows every line it writes does not, and one that left a line out of its body because another shows the text, or withdrew it, does', async () => {
    assert.equal(await blocksWith([carrierOf({})]), 'block');
    assert.equal(await blocksWith([carrierOf({ omit: [3] })]), 'accept');
    assert.equal(await blocksWith([carrierOf({ withdraw: [4] })]), 'accept');
    assert.equal(await blocksWith([carrierOf({ omit: [3] })], shown(LINES.slice(3), 4)), 'block', 'a read of other lines is not in doubt');
  });

  test('a file a later carrier removed, or one the chain carries unreadable or empty, is not judged, and one it carries readable again is', async () => {
    assert.equal(await blocksWith([carrierOf({}), { role: 'user', source: { kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [], removed: [FILE] } }]), 'accept');
    assert.equal(await blocksWith([carrierOf({}), carrierOf({ state: 'unreadable', reason: 'missing', write: undefined })]), 'accept');
    assert.equal(await blocksWith([carrierOf({}), carrierOf({ state: 'empty', write: undefined })]), 'accept');
    assert.equal(await blocksWith([carrierOf({}), { role: 'user', source: { kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [], removed: [FILE] } }, carrierOf({})]), 'block');
  });

  test('a message that is no carrier, whatever its source says of a path, leaves nothing in doubt', async () => {
    assert.equal(await blocksWith([{ role: 'user', source: { kind: 'user', paths: [{ path: FILE, omit: [1] }] } }]), 'block');
  });
});

describe('a pruner\'s replacement result on the surface', () => {
  const PRUNED = { turn: 1, step: 1, callId: 'c0' };
  const surface = { facts: new Map([[10, asAssistant], [11, { step: null, pruned: PRUNED }]]), nodes: [10, 11] };
  const recordOf = (...keys) => ({
    v: 1,
    effects: [{ access: 'read', impacts: keys.map(resourceKey => ({ resourceKey, kind: 'merge-fragments', entries: [{ key: 1, chars: 4, cjk: 0 }] })) }],
    residual: null,
  });

  test('lets through the read of a file its call was attributed to, and no other', async () => {
    const asked = [];
    const recall = (sessionId, toolUseId) => { asked.push([sessionId, toolUseId]); return recordOf(FILE); };
    const same = rig({ ...surface, recall });
    assert.equal((await blockOf(same.guard, execOf(same.session), successOf(shown(LINES)))).kind, 'accept');
    assert.deepEqual(asked, [[SESSION_ID, '1:1:c0']], 'the record of the call the replacement answers');
    const other = rig({ ...surface, recall: () => recordOf(OTHER) });
    assert.equal((await blockOf(other.guard, execOf(other.session), successOf(shown(LINES)))).kind, 'block');
  });

  test('lets every read through, with one line each, when the call has no record or a record that is no Attribution Record', async () => {
    const lines = diagnostics();
    for (const recall of [() => null, () => ({ v: 1, effects: 'none' }), () => ({ v: 1, effects: [{ access: 'read', impacts: [{ resourceKey: FILE }] }], residual: null })]) {
      const { guard, session } = rig({ ...surface, recall });
      for (let again = 0; again < 2; again += 1) assert.equal((await blockOf(guard, execOf(session), successOf(shown(LINES)))).kind, 'accept');
    }
    mock.restoreAll();
    assert.equal(lines.length, 6);
    assert.ok(lines.every(line => line.includes('read_guard_unavailable')));
  });

  test('lets the read through, with one line, when a node of the surface has no fact', async () => {
    const lines = diagnostics();
    const { guard, session } = rig({ nodes: [10, 11], facts: new Map([[10, asAssistant]]) });
    assert.equal((await blockOf(guard, execOf(session), successOf(shown(LINES)))).kind, 'accept');
    mock.restoreAll();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /read_guard_unavailable/);
  });
});

describe('every doubt of the guard lets the read through', () => {
  test('a path the execution world does not map to the file the matcher resolved and a missing fs service are one line each, once every line is held', async () => {
    const lines = diagnostics();
    const wrong = rig({ fs: { processPathFromHostPath: key => key, resolve: async mapped => ({ target: mapped }), processPath: () => '/elsewhere/a.js' } });
    assert.equal((await blockOf(wrong.guard, execOf(wrong.session), successOf(shown(LINES)))).kind, 'accept');
    const unmapped = rig({ fs: { processPathFromHostPath: () => undefined, resolve: async () => ({}), processPath: () => FILE } });
    assert.equal((await blockOf(unmapped.guard, execOf(unmapped.session), successOf(shown(LINES)))).kind, 'accept');
    const noFs = createReadGuard({ readMode: () => ({ mode: 'on' }), heldScratch: () => scratchAfter([READ_A]), eventFacts: () => new Map([[10, asAssistant]]), recallRecord: () => null, workingTree: treeOf({ [FILE]: textOf(LINES) }), fsOf: () => undefined, appendPluginRecord: () => 0 });
    const session = { id: SESSION_ID, header: { cwd: CWD }, surface: { nodes: [10] }, deriveMessages: () => [] };
    assert.equal((await noFs.postExecute(execOf(session), successOf(shown(LINES)), async () => ACCEPT)).kind, 'accept');
    mock.restoreAll();
    assert.equal(lines.length, 3);
    assert.ok(lines.every(line => line.includes('read_guard_unmapped')));
  });

  test('a read the guard would not block is let through with no line, whether or not the execution world maps its path', async () => {
    const lines = diagnostics();
    const changed = [LINES[0], 'export const beta = 20;', ...LINES.slice(2)];
    const wrong = rig({ fs: { processPathFromHostPath: () => undefined, resolve: async () => ({}), processPath: () => '/elsewhere/a.js' } });
    assert.equal((await blockOf(wrong.guard, execOf(wrong.session), successOf(shown(changed)))).kind, 'accept');
    assert.equal((await blockOf(wrong.guard, execOf(wrong.session), successOf([]))).kind, 'accept');
    const nowhere = rig({ tree: treeOf({}) });
    const exec = execOf(nowhere.session, { arguments: { file_path: 'missing.js' } });
    assert.equal((await blockOf(nowhere.guard, exec, successOf(shown(LINES)))).kind, 'accept');
    const noCwd = rig();
    noCwd.session.header = {};
    assert.equal((await blockOf(noCwd.guard, execOf(noCwd.session), successOf(shown(LINES)))).kind, 'accept');
    mock.restoreAll();
    assert.deepEqual(lines, []);
  });

  test('a watcher that is not live, or one whose facts are missing, lets the read through with no line, the entry\'s own failure being the table\'s to report', async () => {
    const lines = diagnostics();
    for (const setup of [rig({ scratch: null }), rig({ facts: null })]) {
      for (let again = 0; again < 3; again += 1) assert.equal((await blockOf(setup.guard, execOf(setup.session), successOf(shown(LINES)))).kind, 'accept');
    }
    mock.restoreAll();
    assert.deepEqual(lines, []);
  });

  test('a surface with no counted step is one line a read', async () => {
    const lines = diagnostics();
    const noStep = rig({ facts: new Map([[10, { step: null, pruned: null }]]) });
    for (let again = 0; again < 2; again += 1) assert.equal((await blockOf(noStep.guard, execOf(noStep.session), successOf(shown(LINES)))).kind, 'accept');
    mock.restoreAll();
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => line.includes('read_guard_unavailable')));
  });

  test('a service that throws is one line each time and the read stands', async () => {
    const lines = diagnostics();
    const guard = createReadGuard({
      readMode: () => ({ mode: 'on' }), heldScratch: () => { throw new Error('scratch is gone'); }, eventFacts: () => new Map(), recallRecord: () => null,
      workingTree: treeOf({ [FILE]: textOf(LINES) }), fsOf: () => ({ processPathFromHostPath: key => key, resolve: async mapped => ({ target: mapped }), processPath: target => target.target }), appendPluginRecord: () => 0,
    });
    const session = { id: SESSION_ID, header: { cwd: CWD }, surface: { nodes: [] }, deriveMessages: () => [] };
    for (let again = 0; again < 2; again += 1) assert.equal((await blockOf(guard, execOf(session), successOf(shown(LINES)))).kind, 'accept');
    mock.restoreAll();
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => line.includes('read_guard_failed') && line.includes('scratch is gone')));
  });
});

describe('the step a block is recorded under', () => {
  test('is the one the latest counted assistant message of the surface completes, whatever results and earlier steps stand around it', async () => {
    const counted = (turn, step) => ({ step: { turn, step }, pruned: null });
    const facts = new Map([[10, counted(1, 1)], [11, { step: null, pruned: null }], [12, counted(2, 4)], [13, { step: null, pruned: null }]]);
    const { guard, session, appended } = rig({ nodes: [10, 11, 12, 13], facts });
    const exec = execOf(session);
    const decision = await blockOf(guard, exec, successOf(shown(LINES)));
    guard.observeResult(exec, { isError: true, content: decision.feedback });
    assert.deepEqual(appended[0].data, { v: 1, turn: 2, step: 4, callId: 'c1', path: 'src/a.js', first: 1, last: 5 });
  });
});

describe('the record of a block', () => {
  const blocked = async (setup = rig()) => {
    const exec = execOf(setup.session);
    const decision = await blockOf(setup.guard, exec, successOf(shown(LINES)));
    return { ...setup, exec, decision };
  };

  test('is left by no result another listener changed, and a result the guard never blocked has none', async () => {
    const one = await blocked();
    one.guard.observeResult(one.exec, { isError: false, content: [{ type: 'text', text: 'file text' }] });
    const two = await blocked();
    two.guard.observeResult(two.exec, { isError: true, content: [{ type: 'text', text: 'Error: another listener said so' }] });
    const stranger = rig();
    stranger.guard.observeResult(execOf(stranger.session), { isError: true, content: one.decision.feedback });
    assert.equal(one.appended.length + two.appended.length + stranger.appended.length, 0);
  });

  test('is written once, and a record that cannot be appended is one line and no throw', async () => {
    const lines = diagnostics();
    const failing = await blocked(rig({ append: () => { throw new Error('log is closed'); } }));
    failing.guard.observeResult(failing.exec, { isError: true, content: failing.decision.feedback });
    const twice = await blocked();
    twice.guard.observeResult(twice.exec, { isError: true, content: twice.decision.feedback });
    twice.guard.observeResult(twice.exec, { isError: true, content: twice.decision.feedback });
    mock.restoreAll();
    assert.equal(twice.appended.length, 1);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /read_guard_record_failed.*log is closed/);
  });
});
