// The load into a session, over the recording session, a recording agent, a fake delivery and a `readFile` that reads the files on disk through the shared tree read, as `readObserved` answers it: the reads planned from the delivered keep list, how a read's outcome lands, the payload and read messages the model is handed, the failures and the hand-over. The same load over the real DSH loop is `test/dsh.load.integration.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { dirname, join } from 'node:path';

import { handOver, loadHandoffInto, loadedText } from '../dsh/src/load.js';
import { ATTRIBUTION_LIMITS } from '../lib/constants.js';
import { sourceFactOf } from '../lib/harness/dsh/inner-source.js';
import { LOAD_MESSAGE_KIND, isLoadPayload } from '../lib/harness/dsh/load-message.js';
import { reduceDshEvent } from '../lib/harness/dsh/transcript-observation.js';
import { createNodeWorkingTree } from '../lib/working-tree.js';
import { readTreeWindows } from '../lib/working-tree-text.js';
import { recordingSession } from './helpers/dsh-fake-context.js';

const TOKEN = 'sw-handoff-token';
const ROUTE = { provider: 'bedrock', model: 'us.anthropic.claude-opus-4-8' };
const SELECTED = { provider: 'deepseek', model: 'deepseek-v4-pro' };

// The kit's `createUserMessage`, in the shape DSH gives it: the input with an id and the user role.
let messages = 0;
const kit = { createUserMessage: ({ content, source }) => ({ id: `message-${++messages}`, role: 'user', content, source }) };

// A canonical temporary directory holding `files`, `{ relativePath: lineCount }`, each line naming its file and number; removed when the case ends.
function directoryWith(t, files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sw-dsh-load-unit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, count] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Array.from({ length: count }, (_, index) => `${root}:${path} line ${index + 1}\n`).join(''));
  }
  return root;
}

// An agent whose `model.current()` answers `selection`, and that records every `inject` and `followup` in one ordered list.
function recordingAgent(session, selection) {
  const handed = [];
  return {
    session, model: { current: () => selection }, handed,
    inject(message) { handed.push(['inject', message]); },
    followup(message) { handed.push(['followup', message]); },
  };
}

// A delivery that records each call and answers `outcome`: the payload, or the error it throws.
function fakeDelivery(outcome) {
  const calls = [];
  const deliver = async (call) => {
    calls.push(call);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { deliver, calls };
}

// `readFile(agent, key, ranges, signal)` as `readObserved` bound by the host answers it, over the files on disk: the shared tree read under `fileBytes` and `displayPath` the path the read shows, the key unless `displayPaths[key]` says otherwise. `scripted[key]` replaces the read of that file with an answer. `calls` holds every call it received.
function fakeReads({ fileBytes = ATTRIBUTION_LIMITS.fileBytes, displayPaths = {}, scripted = {} } = {}) {
  const tree = createNodeWorkingTree({ path: nodePath, homeDir: null, cacheEntries: 16, cacheChars: 1_000_000 });
  const calls = [];
  const readFile = async (agent, key, ranges, signal) => {
    calls.push({ agent, key, ranges, signal });
    return { read: scripted[key] ?? readTreeWindows(tree, key, ranges, { fileBytes }), displayPath: displayPaths[key] ?? key };
  };
  return { readFile, calls };
}

const delivered = (paths, extra = {}) => ({
  found: true, handoff_id: 7, load_token: TOKEN, summary: 'The work so far.', paths_to_keep: paths, ...extra,
});

// One load over a fresh recording session and agent selecting `SELECTED` unless `selection` is given, undefined included, of `TOKEN` unless `token` is given, undefined included; `reading` configures the `readFile` (`fakeReads`), and `overrides` replaces any argument of the call.
async function load(spec) {
  const { payload, cwd, reading, selection: _selection, token: _token, signal = new AbortController().signal, ...overrides } = spec;
  const token = 'token' in spec ? spec.token : TOKEN;
  const session = recordingSession({ cwd: overrides.headerCwd ?? cwd });
  const agent = recordingAgent(session, 'selection' in spec ? spec.selection : SELECTED);
  const delivery = fakeDelivery(payload);
  const reads = fakeReads(reading);
  const { headerCwd: _headerCwd, ...rest } = overrides;
  const outcome = await loadHandoffInto({
    agent, session, readFile: reads.readFile, deliver: delivery.deliver, kit, signal, token, cwdOf: () => cwd, ...rest,
  });
  return { outcome, session, agent, delivery, reads, signal };
}

// The window each `readFile` call of the load asked for, file by file in the order asked.
const readArgsOf = reads => reads.calls.flatMap(({ key, ranges }) => ranges.map(({ offset, limit }) => ({ file_path: key, offset, limit })));

// --- The read plan ---

test('the plan reads each kept range whole, each ranged symbol, or the first 40 lines, at absolute paths', async (t) => {
  const cwd = directoryWith(t, {
    'ranges.js': 60, 'symbols.js': 60, 'stale-beside.js': 60, 'all-stale.js': 60, 'removed.js': 60, 'unparsed.js': 60,
    'plain.js': 60, 'named.js': 60, 'long.js': 2600,
  });
  const at = name => join(cwd, name);
  const { outcome, reads } = await load({
    cwd,
    payload: delivered([
      { path: 'ranges.js', lines: [[3, 5], [10, 12]] },
      { path: 'symbols.js', resolvedSymbols: ['parse (lines 7-9)', 'emit (lines 20-31)'] },
      { path: 'stale-beside.js', resolvedSymbols: ['kept (lines 4-6)', 'gone — symbol not found in current file; originally at lines 30-33'] },
      { path: 'all-stale.js', resolvedSymbols: ['⚠️ all symbols stale (a, b) — file may have been refactored', 'a — symbol not found; originally at lines 2-3'] },
      { path: 'removed.js', resolvedSymbols: ['a — file removed; originally at lines 2-3'] },
      { path: 'unparsed.js', resolvedSymbols: ['a — parser not ready; originally at lines 2-3'] },
      { path: 'plain.js' },
      { path: 'named.js', symbols: ['first', 'second'] },
      { path: 'long.js', lines: [[100, 2400]] },
    ]),
  });
  assert.deepEqual(outcome.loaded.skipped, []);
  assert.deepEqual(readArgsOf(reads), [
    { file_path: at('ranges.js'), offset: 3, limit: 3 },
    { file_path: at('ranges.js'), offset: 10, limit: 3 },
    { file_path: at('symbols.js'), offset: 7, limit: 3 },
    { file_path: at('symbols.js'), offset: 20, limit: 12 },
    { file_path: at('stale-beside.js'), offset: 4, limit: 3 },
    { file_path: at('all-stale.js'), offset: 1, limit: 40 },
    { file_path: at('removed.js'), offset: 1, limit: 40 },
    { file_path: at('unparsed.js'), offset: 1, limit: 40 },
    { file_path: at('plain.js'), offset: 1, limit: 40 },
    { file_path: at('named.js'), offset: 1, limit: 40 },
    { file_path: at('long.js'), offset: 100, limit: 2301 },
  ]);
  assert.deepEqual(outcome.loaded.toPlace, [{ path: at('named.js'), names: ['first', 'second'] }]);
});

test('a relative path resolves against the current directory, then the project directory, never the header or process directory', async (t) => {
  const current = directoryWith(t, { 'src/a.js': 5 });
  const header = directoryWith(t, { 'src/a.js': 5, 'src/b.js': 5 });
  const project = directoryWith(t, { 'src/b.js': 5, 'src/c.js': 5 });
  const processCwd = directoryWith(t, { 'src/d.js': 5 });
  const previous = process.cwd();
  process.chdir(processCwd);
  t.after(() => process.chdir(previous));

  const { outcome, reads } = await load({
    cwd: current, headerCwd: header,
    payload: delivered([{ path: 'src/a.js' }, { path: 'src/b.js' }, { path: 'src/d.js' }, { path: join(header, 'src/a.js') }], { project_dir: project }),
  });
  assert.deepEqual(outcome.loaded.skipped.map(entry => entry.path), ['src/d.js']);
  assert.equal(typeof outcome.loaded.skipped[0].reason, 'string');
  assert.deepEqual(readArgsOf(reads).map(args => args.file_path), [
    join(current, 'src/a.js'), join(project, 'src/b.js'), join(header, 'src/a.js'),
  ]);
});

test('an empty keep list plans nothing and marks the load empty', async (t) => {
  const { outcome, reads } = await load({ cwd: directoryWith(t), payload: delivered([]) });
  assert.deepEqual(reads.calls, []);
  assert.equal(outcome.loaded.empty, true);
  assert.deepEqual([outcome.loaded.reads, outcome.loaded.files], [0, 0]);
});

// --- The reads ---

// The calls of the read message, and the text of the block a read contributed to it, by the file it read.
const readCallsOf = loaded => loaded.messages[1].source.calls;
const blockOf = (loaded, path) => {
  const index = readCallsOf(loaded).findIndex(call => JSON.parse(call.arguments).file_path === path);
  return loaded.messages[1].content[index].text;
};

test('a kept path the read finds unreadable is skipped with the reason it answers and joins no call of the read message', async (t) => {
  const cwd = directoryWith(t, { 'big.js': 100, 'gone.js': 5, 'ok.js': 5 });
  writeFileSync(join(cwd, 'blob.bin'), 'a\u0000b\n');
  const at = name => join(cwd, name);
  const { outcome } = await load({
    cwd,
    reading: { fileBytes: 3000, scripted: { [at('gone.js')]: { status: 'unreadable', reason: 'missing' } } },
    payload: delivered([{ path: 'big.js' }, { path: 'blob.bin' }, { path: 'gone.js' }, { path: 'ok.js' }]),
  });
  const { loaded } = outcome;
  assert.deepEqual(loaded.skipped, [
    { path: at('big.js'), reason: 'too-large' },
    { path: at('blob.bin'), reason: 'binary' },
    { path: at('gone.js'), reason: 'missing' },
  ]);
  assert.deepEqual(readCallsOf(loaded).map(call => JSON.parse(call.arguments).file_path), [at('ok.js')]);
  assert.deepEqual([loaded.reads, loaded.files, loaded.unread], [1, 1, []]);
});

test('a window wholly past the end of a file that has lines is skipped as past the end, and one partly past it reads what is there', async (t) => {
  const cwd = directoryWith(t, { 'short.js': 10 });
  const at = name => join(cwd, name);
  const { outcome } = await load({
    cwd,
    payload: delivered([{ path: 'short.js', lines: [[20, 25], [8, 15]] }]),
  });
  const { loaded } = outcome;
  assert.deepEqual(loaded.skipped, [{ path: at('short.js'), reason: 'past-end' }]);
  assert.deepEqual(loaded.unread, [], 'the tail past the end of the file is no unread range');
  assert.deepEqual(readCallsOf(loaded).map(call => call.arguments), [JSON.stringify({ file_path: at('short.js'), ranges: [{ offset: 8, limit: 8 }] })]);
  assert.match(blockOf(loaded, at('short.js')), /^.* \(total lines: 10\)\n8: .* line 8\n9: .* line 9\n10: .* line 10\n$/);
});

test('an empty kept file is its header alone, and read anywhere but its first line it is past the end', async (t) => {
  const cwd = directoryWith(t, { 'empty.js': 0, 'also-empty.js': 0 });
  const at = name => join(cwd, name);
  const { outcome } = await load({
    cwd,
    payload: delivered([{ path: 'empty.js' }, { path: 'also-empty.js', lines: [[3, 5]] }]),
  });
  const { loaded } = outcome;
  assert.equal(blockOf(loaded, at('empty.js')), `${at('empty.js')} (total lines: 0)\n`);
  assert.deepEqual(loaded.skipped, [{ path: at('also-empty.js'), reason: 'past-end' }]);
  assert.deepEqual([loaded.reads, loaded.files, loaded.unread], [1, 1, []]);
});

test('a window whose rendering exceeds the side limit is rendered under it and its tail is unread', async (t) => {
  const cwd = directoryWith(t, { 'long.js': 3000 });
  const at = name => join(cwd, name);
  const { outcome } = await load({ cwd, payload: delivered([{ path: 'long.js', lines: [[10, 2900]] }]) });
  const { loaded } = outcome;
  const block = blockOf(loaded, at('long.js'));
  const shown = [...block.matchAll(/^(\d+): /gm)].map(match => Number(match[1]));
  const last = shown.at(-1);
  assert.equal(shown[0], 10);
  assert.ok(last < 2900, 'the window was cut');
  assert.ok(block.length <= ATTRIBUTION_LIMITS.sideChars, String(block.length));
  assert.ok(block.length > ATTRIBUTION_LIMITS.sideChars - 300, 'cut at the limit, not under it');
  assert.ok(block.endsWith(`(Output capped after line ${last}. Use offset=${last + 1} to continue.)\n`), block.slice(-120));
  assert.deepEqual(loaded.unread, [{ path: at('long.js'), range: [last + 1, 2900] }]);
  assert.deepEqual(loaded.skipped, []);
});

test('a window of which no line fits under the side limit is left out of its file\'s call and is unread whole', async (t) => {
  const cwd = directoryWith(t);
  const wide = join(cwd, 'wide.js');
  writeFileSync(wide, `${'w'.repeat(ATTRIBUTION_LIMITS.sideChars + 1)}\nnarrow\n`);
  const { outcome } = await load({ cwd, payload: delivered([{ path: 'wide.js', lines: [[1, 5], [2, 2]] }]) });
  const { loaded } = outcome;
  assert.deepEqual(loaded.unread, [{ path: wide, range: [1, 5] }]);
  assert.deepEqual(loaded.skipped, []);
  assert.deepEqual(readCallsOf(loaded).map(call => call.arguments), [JSON.stringify({ file_path: wide, ranges: [{ offset: 2, limit: 1 }] })],
    'the window that fits is still read');
  assert.deepEqual([loaded.reads, loaded.files], [1, 1]);
});

test('a file kept over several ranges, however the keep list interleaves its entries, is one read and one call: its path once, each range under its header, the arguments listing the ranges read', async (t) => {
  const cwd = directoryWith(t, { 'multi.js': 30, 'other.js': 5, 'gone.js': 5 });
  const at = name => join(cwd, name);
  const row = (name, number) => `${number}: ${cwd}:${name} line ${number}`;
  const { outcome, reads } = await load({
    cwd,
    reading: { scripted: { [at('gone.js')]: { status: 'unreadable', reason: 'missing' } } },
    payload: delivered([
      { path: 'multi.js', lines: [[2, 3]] }, { path: 'other.js', lines: [[1, 2]] }, { path: 'multi.js', lines: [[10, 12]] },
      { path: 'gone.js', lines: [[1, 2], [4, 5]] },
    ]),
  });
  const { loaded } = outcome;
  assert.deepEqual(reads.calls.map(({ key, ranges }) => [key, ranges]), [
    [at('multi.js'), [{ offset: 2, limit: 2 }, { offset: 10, limit: 3 }]],
    [at('other.js'), [{ offset: 1, limit: 2 }]],
    [at('gone.js'), [{ offset: 1, limit: 2 }, { offset: 4, limit: 2 }]],
  ]);
  assert.deepEqual(readCallsOf(loaded).map(call => call.arguments), [
    JSON.stringify({ file_path: at('multi.js'), ranges: [{ offset: 2, limit: 2 }, { offset: 10, limit: 3 }] }),
    JSON.stringify({ file_path: at('other.js'), ranges: [{ offset: 1, limit: 2 }] }),
  ]);
  assert.deepEqual(loaded.messages[1].content.map(block => block.text), [
    `${at('multi.js')} (total lines: 30)\n${row('multi.js', 2)}\n${row('multi.js', 3)}\n--\n${row('multi.js', 10)}\n${row('multi.js', 11)}\n${row('multi.js', 12)}\n`,
    `${at('other.js')} (total lines: 5)\n${row('other.js', 1)}\n${row('other.js', 2)}\n`,
  ]);
  assert.deepEqual(loaded.skipped, [{ path: at('gone.js'), reason: 'missing' }], 'an unreadable file is skipped once, not once per range');
  assert.deepEqual([loaded.reads, loaded.files, loaded.unread], [3, 2, []], 'reads count the ranges read');
});

test('the rows of a file\'s call and its unread ranges together cover each requested range exactly, the cut falling inside a range or between ranges', async (t) => {
  const cwd = directoryWith(t, { 'long.js': 3000 });
  const requested = [[10, 2900], [2950, 2960], [5, 6]];
  const { outcome } = await load({ cwd, payload: delivered([{ path: 'long.js', lines: requested }]) });
  const { loaded } = outcome;
  const block = loaded.messages[1].content[0].text;
  assert.ok(block.length <= ATTRIBUTION_LIMITS.sideChars, String(block.length));
  const shown = new Set([...block.matchAll(/^(\d+): /gm)].map(match => Number(match[1])));
  const unread = new Set(loaded.unread.flatMap(({ range: [from, to] }) => Array.from({ length: to - from + 1 }, (_, at) => from + at)));
  assert.ok(unread.size > 0, 'fixture: the file does not fit whole');
  for (const [from, to] of requested) {
    for (let line = from; line <= to; line += 1) assert.notEqual(shown.has(line), unread.has(line), `line ${line} is shown or unread, one of the two`);
  }
});

// --- The message ---

test('the payload message holds the delivery alone and the read message each surviving read, as calls with their results, both under the session\'s route', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'b.js': 10 });
  const at = name => join(cwd, name);
  const payload = delivered([{ path: 'a.js', lines: [[2, 3]] }, { path: 'b.js' }], {
    turn_page_error: 'page failed', recovery: 'Call turn_page to obtain the page.',
  });
  const { outcome, delivery, reads, agent, signal } = await load({
    cwd, payload, selection: ROUTE, reading: { displayPaths: { [at('b.js')]: '/execution/b.js' } },
  });
  const { messages } = outcome.loaded;
  assert.equal(messages.length, 2);
  const [payloadMessage, readMessage] = messages;
  for (const { source } of messages) {
    assert.ok(!['user', 'plugin', 'runtime-context'].includes(source.kind), source.kind);
    assert.equal(source.kind, LOAD_MESSAGE_KIND);
    assert.deepEqual(source.route, ROUTE);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(source)), source, 'lossless, no absent key');
  }

  assert.deepEqual(delivery.calls.map(({ agent: caller, signal: callSignal, args }) => [caller, callSignal, args]), [[agent, signal, { load_token: TOKEN }]]);
  assert.deepEqual(payloadMessage.source.calls.map(call => [call.name, call.arguments]), [['load_handoff', JSON.stringify({ load_token: TOKEN })]]);
  assert.deepEqual(readMessage.source.calls.map(call => call.name), ['read', 'read']);
  assert.deepEqual(readMessage.source.calls.map(call => call.arguments), [
    JSON.stringify({ file_path: at('a.js'), ranges: [{ offset: 2, limit: 2 }] }),
    JSON.stringify({ file_path: at('b.js'), ranges: [{ offset: 1, limit: 40 }] }),
  ]);
  for (const { id } of messages.flatMap(message => message.source.calls)) assert.match(id, /^sw-load-[0-9a-f]{8}-\d+$/);
  assert.notEqual(payloadMessage.id, readMessage.id);
  assert.deepEqual(reads.calls, [
    { agent, key: at('a.js'), ranges: [{ offset: 2, limit: 2 }], signal },
    { agent, key: at('b.js'), ranges: [{ offset: 1, limit: 40 }], signal },
  ], 'one read per file, for the agent and under the signal');

  const numbered = (name, from, to) => Array.from({ length: to - from + 1 }, (_, index) => `${from + index}: ${cwd}:${name} line ${from + index}`).join('\n');
  assert.deepEqual(payloadMessage.content, [{ type: 'text', text: JSON.stringify(payload) }]);
  assert.deepEqual(readMessage.content, [
    { type: 'text', text: `${at('a.js')} (total lines: 10)\n${numbered('a.js', 2, 3)}\n` },
    { type: 'text', text: `/execution/b.js (total lines: 10)\n${numbered('b.js', 1, 10)}\n` },
  ], 'the key names the read, the displayed path heads its block, and each block ends its last row so that blocks joined with nothing between them stay apart');
  assert.equal(outcome.loaded.token, TOKEN);
  assert.deepEqual(agent.handed, [], 'nothing is handed over inside the load');
});

// The rows `N: text` a block shows, as `[number, text]`.
const rowsOf = block => [...block.matchAll(/^(\d+): (.*)$/gm)].map(([, number, text]) => [Number(number), text]);

test('the read message\'s source holds the lines its blocks show as canonical carried evidence under the Working Tree key, and the payload message none', async (t) => {
  const cwd = directoryWith(t, { 'multi.js': 30, 'other.js': 5, 'empty.js': 0, 'gone.js': 5 });
  const at = name => join(cwd, name);
  const row = (name, number) => [number, `${cwd}:${name} line ${number}`];
  const { outcome } = await load({
    cwd,
    reading: { displayPaths: { [at('other.js')]: '/execution/other.js' }, scripted: { [at('gone.js')]: { status: 'unreadable', reason: 'missing' } } },
    payload: delivered([
      { path: 'multi.js', lines: [[2, 3], [10, 11]] }, { path: 'other.js', lines: [[1, 2]] }, { path: 'empty.js' }, { path: 'gone.js' },
    ]),
  });
  const [payloadMessage, readMessage] = outcome.loaded.messages;

  assert.equal('paths' in payloadMessage.source, false, 'the delivery shows no file text');
  assert.deepEqual(readMessage.source.paths, [
    { path: at('multi.js'), displayPath: at('multi.js'), totalLines: 30, state: 'readable', write: [2, 3, 10, 11].map(number => row('multi.js', number)) },
    { path: at('other.js'), displayPath: '/execution/other.js', totalLines: 5, state: 'readable', write: [1, 2].map(number => row('other.js', number)) },
    { path: at('empty.js'), displayPath: at('empty.js'), state: 'empty' },
  ], 'one entry for each block, none for the path that could not be read');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(readMessage.source)), readMessage.source, 'lossless, no absent key');
  assert.deepEqual(readMessage.source.calls.map(call => JSON.parse(call.arguments).file_path), readMessage.source.paths.map(entry => entry.path),
    'a call and its evidence name the same key, in the same order');
});

test('what a cut block shows is the evidence and what it leaves unread is not: the rows of each block and the written lines of its entry are one set, the requested ranges and the unread lines notwithstanding', async (t) => {
  const cwd = directoryWith(t, { 'long.js': 3000, 'short.js': 20 });
  const wide = join(cwd, 'wide.js');
  writeFileSync(wide, `${'w'.repeat(ATTRIBUTION_LIMITS.sideChars + 1)}\nnarrow\n`);
  const { outcome } = await load({
    cwd,
    payload: delivered([
      { path: 'long.js', lines: [[10, 2900], [2950, 2960], [5, 6]] }, { path: 'wide.js', lines: [[1, 5], [2, 2]] }, { path: 'short.js', lines: [[3, 4]] },
    ]),
  });
  const { loaded } = outcome;
  const [, readMessage] = loaded.messages;
  const entry = path => readMessage.source.paths.find(held => held.path === path);

  const long = entry(join(cwd, 'long.js'));
  const lastShown = rowsOf(blockOf(loaded, long.path)).at(-1)[0];
  assert.ok(lastShown < 2900, 'fixture: the block was cut inside the first range');
  assert.deepEqual(long.write, rowsOf(blockOf(loaded, long.path)), 'the evidence is the shown rows, in order');
  assert.ok(long.write.every(([number]) => number <= lastShown), 'no unread row, none of the later ranges');
  assert.deepEqual(entry(wide).write, [[2, 'narrow']], 'the window of which no line fits is no evidence, the one that fits is');
  assert.deepEqual(entry(join(cwd, 'short.js')).write, rowsOf(blockOf(loaded, join(cwd, 'short.js'))));
  assert.equal(entry(join(cwd, 'short.js')).totalLines, 20);
});

test('the evidence in the read message\'s source changes what the Source reads of it by nothing: the same observations and the same source facts as the message without it', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'empty.js': 0 });
  const { outcome } = await load({ cwd, payload: delivered([{ path: 'a.js', lines: [[2, 3]] }, { path: 'empty.js' }]) });
  const [, message] = outcome.loaded.messages;
  const { paths, ...source } = message.source;
  assert.ok(paths.length > 0, 'fixture: the message holds evidence');
  const eventOf = data => ({ type: 'user/message', seq: 4, time: 1_000, data, surfaceOp: 'append' });

  assert.deepEqual(reduceDshEvent(eventOf(message)), reduceDshEvent(eventOf({ ...message, source })));
  assert.equal(reduceDshEvent(eventOf(message)).observations.length, 4, 'one use and one result for each of the two calls');
  assert.deepEqual(sourceFactOf(eventOf(message)), sourceFactOf(eventOf({ ...message, source })));
});

test('isLoadPayload holds of the payload message\'s source alone, not of the read message\'s nor of another kind\'s', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10 });
  const { outcome } = await load({ cwd, payload: delivered([{ path: 'a.js' }]) });
  const [payloadMessage, readMessage] = outcome.loaded.messages;
  assert.equal(isLoadPayload(payloadMessage.source), true);
  assert.equal(isLoadPayload(readMessage.source), false);
  assert.equal(isLoadPayload({ kind: 'user' }), false);
  assert.equal(isLoadPayload({ ...payloadMessage.source, kind: 'user' }), false);
});

test('a load none of whose reads survives hands over the payload message alone, and an auto-match delivers with no token', async (t) => {
  const { outcome, delivery } = await load({ cwd: directoryWith(t), payload: delivered([{ path: 'absent.js' }]), token: undefined });
  assert.deepEqual(delivery.calls.map(call => call.args), [{}]);
  const { messages } = outcome.loaded;
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].source.calls.map(call => [call.name, call.arguments]), [['load_handoff', '{}']]);
  assert.equal(messages[0].content.length, 1);
  assert.deepEqual(outcome.loaded.skipped.map(entry => entry.path), ['absent.js']);
});

test('call ids are unique across two loads into one session', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10 });
  const session = recordingSession({ cwd });
  const agent = recordingAgent(session, SELECTED);
  const ids = [];
  for (let run = 0; run < 2; run += 1) {
    const { outcome } = await load({ cwd, payload: delivered([{ path: 'a.js' }, { path: 'a.js', lines: [[2, 4]] }]), session, agent });
    ids.push(...outcome.loaded.messages.flatMap(message => message.source.calls.map(call => call.id)));
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('the route is the provider and model of the agent\'s current selection, and without one nothing is delivered or read', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10 });
  const payload = delivered([{ path: 'a.js' }]);
  const { outcome } = await load({ cwd, payload, selection: { ...ROUTE, reasoningEffort: 'high' } });
  assert.deepEqual(outcome.loaded.messages.map(message => message.source.route), [ROUTE, ROUTE]);

  const refused = await load({ cwd, payload, selection: undefined });
  assert.deepEqual(refused.outcome, { failed: { reason: 'No model route is known for this session yet.' } });
  assert.deepEqual([refused.delivery.calls, refused.reads.calls, refused.agent.handed], [[], [], []]);
});

// --- The failures ---

test('each failed delivery outcome answers its reason and hands nothing over', async (t) => {
  const cwd = directoryWith(t);
  const candidates = [
    { load_token: 'sw-first', created_at: Date.now() - 5 * 60_000, next_task_preview: 'Fix the parser' },
    { load_token: 'sw-second', created_at: Date.now() - 3 * 3_600_000, next_task_preview: null },
  ];
  const cases = [
    [new Error('the wait was aborted'), undefined, 'Loading failed: the wait was aborted'],
    [{ error: 'handoff_delivery_unavailable', retryable: true, recovery: 'Call again.' }, TOKEN, 'Loading failed: handoff_delivery_unavailable'],
    [{ found: false, status: 'error', error: 'corrupt_handoff' }, TOKEN, 'Loading failed: corrupt_handoff'],
    [{ found: false, ambiguous: true, candidates }, undefined,
      'Several handoffs are pending for this project; run /sw-load <token> with one of them:\n'
      + '- sw-first (5 min ago) — Fix the parser\n- sw-second (3h ago)'],
    [{ found: false }, TOKEN, `No handoff found for ${TOKEN}; it may have expired`],
    [{ found: false }, undefined, 'No handoff found pending for this project'],
  ];
  for (const [payload, token, reason] of cases) {
    const { outcome, reads, agent } = await load({ cwd, payload, token });
    assert.deepEqual(outcome, { failed: { reason } });
    assert.deepEqual([reads.calls, agent.handed], [[], []]);
  }
});

test('a throw while the message is built answers that the load did not finish and hands nothing over', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10 });
  const broken = { createUserMessage: () => { throw new Error('not lossless'); } };
  const { outcome, agent } = await load({ cwd, payload: delivered([{ path: 'a.js' }]), kit: broken });
  assert.deepEqual(outcome, { failed: { reason: 'Loading did not finish: not lossless' } });
  assert.deepEqual(agent.handed, []);
});

// --- The hand-over ---

test('handOver injects the payload message, then the read message, then queues the follow-up, in one synchronous stretch', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'b.js': 10 });
  const { outcome, agent } = await load({ cwd, payload: delivered([{ path: 'a.js' }, { path: 'b.js' }]) });

  const returned = handOver({ agent, loaded: outcome.loaded });
  assert.equal(returned, undefined);
  const [payloadMessage, readMessage] = outcome.loaded.messages;
  assert.deepEqual(agent.handed.map(([method, message]) => [method, message.id]), [
    ['inject', payloadMessage.id], ['inject', readMessage.id], ['followup', agent.handed[2][1].id],
  ]);
  const [, followup] = agent.handed[2];
  assert.deepEqual(followup.source, { kind: 'user' });
  assert.equal(followup.role, 'user');
  assert.deepEqual(followup.content, [{ type: 'text', text: loadedText(outcome.loaded) }]);
});

test('handOver of a load none of whose reads survives injects the payload message alone before the follow-up', async (t) => {
  const { outcome, agent } = await load({ cwd: directoryWith(t), payload: delivered([]) });

  handOver({ agent, loaded: outcome.loaded, resume: true });
  assert.deepEqual(agent.handed.map(([method, message]) => [method, message.id]), [
    ['inject', outcome.loaded.messages[0].id], ['followup', agent.handed[1][1].id],
  ]);
  assert.deepEqual(agent.handed[1][1].content, [{ type: 'text', text: loadedText(outcome.loaded, { resume: true }) }]);
});

// --- The follow-up text ---

// The pattern of DSH's skill-gesture scan, copied from `SKILL_GESTURE` in `packages/skill/tool-skill/src/index.ts` of the DSH checkout, which does not export it.
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g;

const gesturesIn = text => [...text.matchAll(SKILL_GESTURE)].map(match => match[0]);

// The follow-up of each intent: the default, which ends in a report the user confirms, and the resume.
const INTENTS = [['load', undefined], ['resume', { resume: true }]];

for (const [intent, options] of INTENTS) {
  test(`the ${intent} follow-up text carries the token, every skipped, unread and unplaced entry and every kept skill, and differs when the load is empty`, () => {
    const full = loadedText({
      token: 'sw-token', skills: ['tdd', 'sw-handoff'], empty: false,
      skipped: [{ path: 'gone.js', reason: 'not found' }],
      unread: [{ path: '/repo/long.js', range: [2001, 2400] }],
      toPlace: [{ path: '/repo/named.js', names: ['first', 'second'] }],
    }, options);
    for (const part of ['sw-token', 'gone.js', 'not found', '/repo/long.js', '2001', '2400', '/repo/named.js', 'first', 'second', 'tdd', 'sw-handoff']) {
      assert.ok(full.includes(part), part);
    }
    const bare = loadedText({ token: 'sw-token', skills: [], empty: false, skipped: [], unread: [], toPlace: [] }, options);
    const empty = loadedText({ token: 'sw-token', skills: [], empty: true, skipped: [], unread: [], toPlace: [] }, options);
    assert.notEqual(empty, bare);
  });
}

// The follow-up of a load whose reads survived (`reads` of them) or none did, with nothing else to report.
const textOfReads = (reads, options) => loadedText({ token: 'sw-token', skills: [], empty: false, skipped: [], unread: [], toPlace: [], reads, ...options });

for (const [intent, options] of INTENTS) {
  test(`the ${intent} follow-up names the one message holding the delivery when no read survived, and the two messages when one did`, () => {
    const alone = textOfReads(0, options);
    const both = textOfReads(2, options);
    assert.notEqual(alone, both);
    assert.match(both, /two messages/);
    assert.doesNotMatch(alone, /two messages/);
  });
}

test('the resume follow-up differs from the load follow-up', () => {
  const loaded = { token: 'sw-token', skills: ['tdd'], empty: false, skipped: [], unread: [], toPlace: [] };
  assert.notEqual(loadedText(loaded, { resume: true }), loadedText(loaded));
});

// Values a handoff or a failed read can carry: a slash that starts the value or follows a space, a newline or another whitespace character, and quote, backslash and backquote characters.
const HOSTILE = [
  '/tdd',
  'use /review',
  'notes /tdd draft.md',
  '/Users/me/My\n/tdd\n/a.js',
  'foo /tdd bar',
  'quote " back\\slash `tick` \' /tdd /sw-load ',
  'a\u00a0/tdd\u2003b',
  '\u2028/review\u2029',
  '\t/tdd',
];

// Each field of the text, filled by one value with every other field benign.
const FIELDS = {
  token: value => ({ token: value }),
  'kept skill': value => ({ skills: [value] }),
  'skipped path': value => ({ skipped: [{ path: value, reason: 'r' }] }),
  'skipped reason': value => ({ skipped: [{ path: 'p', reason: value }] }),
  'unread path': value => ({ unread: [{ path: value, range: [1, 2] }] }),
  'unplaced path': value => ({ toPlace: [{ path: value, names: ['n'] }] }),
  'unplaced name': value => ({ toPlace: [{ path: 'p', names: [value] }] }),
};

// Every JSON string literal in the text, decoded.
const stringsIn = text => [...text.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([literal]) => JSON.parse(literal));

test('the hostile values form no gesture even when written bare', () => {
  assert.deepEqual(HOSTILE.filter(value => gesturesIn(` ${value} `).length === 0), []);
});

for (const [intent, options] of INTENTS) {
  test(`no field of the ${intent} follow-up text forms a skill gesture, and each value reads back whole`, () => {
    const problems = [];
    for (const [field, fill] of Object.entries(FIELDS)) {
      for (const value of HOSTILE) {
        const text = loadedText({ token: 'sw-token', skills: [], empty: false, skipped: [], unread: [], toPlace: [], ...fill(value) }, options);
        if (gesturesIn(text).length > 0) problems.push(`${field} ${JSON.stringify(value)}: forms a gesture`);
        if (!stringsIn(text).includes(value)) problems.push(`${field} ${JSON.stringify(value)}: does not read back`);
      }
    }
    assert.deepEqual(problems, []);
  });
}
