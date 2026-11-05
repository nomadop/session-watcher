// The load into a session, over the recording session, a recording agent, a fake delivery and a fake `tools.execute` that answers batches of one `read` in the shapes of the real executor: the reads planned from the delivered keep list, how a read's outcome lands, the one message the model is handed, the failures and the hand-over. The same load over the real DSH loop is `test/dsh.load.integration.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { handOver, loadHandoffInto, loadedText } from '../dsh/src/load.js';
import {
  ToolBatchExecutionError, abortedBeforeDispatch, batchExecutor, recordingSession,
} from './helpers/dsh-fake-context.js';

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

// `tools.execute` answering a batch of one `read` as the real executor does (`batchExecutor`) over the files on disk: one text block opening with the `<path>` line and the numbered lines, `meta` `{ path, offset, lines, totalLines }`, and the read's `additionalContexts`. `behaviour[file_path]` is `throw` (the batch rejects as the driver does on an internal failure), `aborted` (the skip result of a call the executor did not dispatch), `error` (an `isError` result), `{ lines: n }` (a byte cap that keeps the first n lines of the window) or `{ blank: true }` (a result with no text block); `contexts[file_path]` its additional contexts, which an `isError` result carries as well, as a failure result may. `calls` holds every input it received.
function fakeTools({ behaviour = {}, contexts = {} } = {}) {
  const calls = [];
  const answer = batchExecutor(async (_block, { file_path: path, offset, limit }) => {
    const mode = behaviour[path];
    if (mode === 'throw') throw new ToolBatchExecutionError(new Error(`read of ${path} threw`), { results: [], additionalContexts: [], concluded: false });
    if (mode === 'aborted') return abortedBeforeDispatch();
    if (mode === 'error') {
      return {
        isError: true, error: { message: `cannot read ${path}` }, content: [{ type: 'text', text: `Error: cannot read ${path}` }],
        ...(contexts[path] ? { additionalContexts: contexts[path] } : {}),
      };
    }
    const all = readFileSync(path, 'utf8').split('\n').slice(0, -1);
    const kept = Math.min(limit, mode?.lines ?? limit);
    const lines = all.slice(offset - 1, offset - 1 + kept).map((text, index) => ({ number: offset + index, text }));
    const text = `<path>${path}</path>\n<type>file</type>\n<content>\n${lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n</content>`;
    return {
      isError: false,
      value: { path, offset, lines, totalLines: all.length },
      content: mode?.blank ? [] : [{ type: 'text', text: text.slice(0, 20) }, { type: 'text', text: text.slice(20) }],
      meta: { path, offset, lines, totalLines: all.length },
      ...(contexts[path] ? { additionalContexts: contexts[path] } : {}),
    };
  });
  const execute = (input) => {
    calls.push(input);
    return answer(input);
  };
  return { tools: { execute }, calls };
}

const delivered = (paths, extra = {}) => ({
  found: true, handoff_id: 7, load_token: TOKEN, summary: 'The work so far.', paths_to_keep: paths, ...extra,
});

// A context message a read's hooks or policies attach to its result.
const context = name => ({ id: `context-${name}`, role: 'user', content: [{ type: 'text', text: name }], source: { kind: 'tool-context' } });

// One load over a fresh recording session and agent selecting `SELECTED` unless `selection` is given, undefined included, of `TOKEN` unless `token` is given, undefined included; `overrides` replaces any argument of the call.
async function load(spec) {
  const { payload, cwd, behaviour, contexts, selection: _selection, token: _token, signal = new AbortController().signal, ...overrides } = spec;
  const token = 'token' in spec ? spec.token : TOKEN;
  const session = recordingSession({ cwd: overrides.headerCwd ?? cwd });
  const agent = recordingAgent(session, 'selection' in spec ? spec.selection : SELECTED);
  const delivery = fakeDelivery(payload);
  const reads = fakeTools({ behaviour, contexts });
  const { headerCwd: _headerCwd, ...rest } = overrides;
  const outcome = await loadHandoffInto({
    agent, session, tools: reads.tools, deliver: delivery.deliver, kit, signal, token, cwdOf: () => cwd, ...rest,
  });
  return { outcome, session, agent, delivery, reads, signal };
}

const readArgsOf = reads => reads.calls.map(input => JSON.parse(input.calls[0].arguments));

// --- The read plan ---

test('the plan reads each kept range, each ranged symbol, or the first 40 lines, at absolute paths', async (t) => {
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
    { file_path: at('long.js'), offset: 100, limit: 2000 },
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

test('a read whose batch rejects or whose result is an error is skipped with the message, a byte-capped read and a read cut at the line cap list their tails as unread', async (t) => {
  const cwd = directoryWith(t, { 'thrown.js': 10, 'failed.js': 10, 'capped.js': 60, 'long.js': 2600, 'short.js': 10 });
  const at = name => join(cwd, name);
  const { outcome } = await load({
    cwd,
    behaviour: { [at('thrown.js')]: 'throw', [at('failed.js')]: 'error', [at('capped.js')]: { lines: 12 } },
    payload: delivered([
      { path: 'thrown.js' }, { path: 'failed.js' }, { path: 'capped.js', lines: [[5, 50]] },
      { path: 'long.js', lines: [[100, 2400]] }, { path: 'short.js' },
    ]),
  });
  const { loaded } = outcome;
  assert.deepEqual(loaded.skipped, [
    { path: at('thrown.js'), reason: 'Tool batch execution failed' },
    { path: at('failed.js'), reason: `cannot read ${at('failed.js')}` },
  ]);
  assert.deepEqual(loaded.unread, [
    { path: at('capped.js'), range: [17, 50] },
    { path: at('long.js'), range: [2100, 2400] },
  ]);
  const readCalls = loaded.message.source.calls.slice(1).map(call => JSON.parse(call.arguments).file_path);
  assert.deepEqual(readCalls, [at('capped.js'), at('long.js'), at('short.js')]);
  assert.deepEqual([loaded.reads, loaded.files], [3, 3]);
});

test('a read that fails keeps its additional contexts, which reach the model in plan order beside the later reads\' contexts', async (t) => {
  const cwd = directoryWith(t, { 'failed.js': 10, 'ok.js': 10 });
  const at = name => join(cwd, name);
  const { outcome, agent } = await load({
    cwd,
    behaviour: { [at('failed.js')]: 'error' },
    contexts: { [at('failed.js')]: [context('failure')], [at('ok.js')]: [context('ok')] },
    payload: delivered([{ path: 'failed.js' }, { path: 'ok.js' }]),
  });
  const { loaded } = outcome;
  assert.deepEqual(loaded.skipped.map(entry => entry.path), [at('failed.js')]);
  assert.deepEqual(loaded.message.source.calls.slice(1).map(call => JSON.parse(call.arguments).file_path), [at('ok.js')],
    'the failed read stays out of the message');
  assert.deepEqual(loaded.contexts, [context('failure'), context('ok')]);

  handOver({ agent, loaded });
  assert.deepEqual(agent.handed.slice(0, 3).map(([method, message]) => [method, message.id]), [
    ['inject', loaded.message.id], ['inject', 'context-failure'], ['inject', 'context-ok'],
  ]);
});

test('each context a read returns reaches the model once, in plan order, though the batch answer repeats it on the result', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'b.js': 10, 'c.js': 10 });
  const at = name => join(cwd, name);
  const { outcome } = await load({
    cwd,
    contexts: { [at('a.js')]: [context('a1'), context('a2')], [at('c.js')]: [context('c1')] },
    payload: delivered([{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }]),
  });
  assert.deepEqual(outcome.loaded.skipped, []);
  assert.deepEqual(outcome.loaded.contexts, [context('a1'), context('a2'), context('c1')]);
});

test('a read the executor skips for an aborted signal is skipped with the executor\'s reason and joins no context', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'b.js': 10 });
  const at = name => join(cwd, name);
  const reason = 'tool call aborted before dispatch';
  const { outcome } = await load({
    cwd,
    behaviour: { [at('a.js')]: 'aborted', [at('b.js')]: 'aborted' },
    payload: delivered([{ path: 'a.js' }, { path: 'b.js' }]),
  });
  const { loaded } = outcome;
  assert.deepEqual(loaded.skipped, [{ path: at('a.js'), reason }, { path: at('b.js'), reason }]);
  assert.deepEqual(loaded.contexts, []);
  assert.deepEqual([loaded.reads, loaded.files, loaded.unread], [0, 0, []]);
  assert.deepEqual(loaded.message.source.calls.map(call => call.name), ['load_handoff']);
});

// --- The message ---

test('the message holds the delivery and each read as calls with their results, under the session\'s route', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'b.js': 10 });
  const payload = delivered([{ path: 'a.js', lines: [[2, 3]] }, { path: 'b.js' }], {
    turn_page_error: 'page failed', recovery: 'Call turn_page to obtain the page.',
  });
  const { outcome, delivery, reads, agent, signal } = await load({
    cwd, payload, selection: ROUTE, behaviour: { [join(cwd, 'b.js')]: { blank: true } },
  });
  const { message } = outcome.loaded;
  const { source } = message;
  assert.ok(!['user', 'plugin', 'runtime-context'].includes(source.kind), source.kind);
  assert.deepEqual(source.route, ROUTE);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(source)), source, 'lossless, no absent key');

  assert.deepEqual(delivery.calls.map(({ agent: caller, signal: callSignal, args }) => [caller, callSignal, args]), [[agent, signal, { load_token: TOKEN }]]);
  assert.deepEqual(source.calls.map(call => call.name), ['load_handoff', 'read', 'read']);
  assert.deepEqual(source.calls.map(call => call.arguments), [
    JSON.stringify({ load_token: TOKEN }), ...readArgsOf(reads).map(args => JSON.stringify(args)),
  ]);
  for (const { id } of source.calls) assert.match(id, /^sw-load-[0-9a-f]{8}-\d+$/);
  assert.deepEqual(reads.calls, source.calls.slice(1).map(call => ({
    calls: [{ type: 'tool-call', id: call.id, name: 'read', arguments: call.arguments }], signal, agent,
  })), 'one batch of one call per read, owned by the agent and the signal, with no model-step log');

  const answered = await Promise.all(reads.calls.map(input => fakeTools({ behaviour: { [join(cwd, 'b.js')]: { blank: true } } }).tools.execute(input)));
  assert.deepEqual(message.content, [
    { type: 'text', text: JSON.stringify(payload) },
    { type: 'text', text: answered[0].results[0].result.content.map(block => block.text).join('') },
    { type: 'text', text: '' },
  ]);
  assert.equal(outcome.loaded.token, TOKEN);
  assert.deepEqual(agent.handed, [], 'nothing is handed over inside the load');
});

test('a load with no read holds the delivery alone, and an auto-match delivers with no token', async (t) => {
  const { outcome, delivery } = await load({ cwd: directoryWith(t), payload: delivered([]), token: undefined });
  assert.deepEqual(delivery.calls.map(call => call.args), [{}]);
  assert.deepEqual(outcome.loaded.message.source.calls.map(call => [call.name, call.arguments]), [['load_handoff', '{}']]);
  assert.equal(outcome.loaded.message.content.length, 1);
});

test('call ids are unique across two loads into one session', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10 });
  const session = recordingSession({ cwd });
  const agent = recordingAgent(session, SELECTED);
  const ids = [];
  for (let run = 0; run < 2; run += 1) {
    const { outcome } = await load({ cwd, payload: delivered([{ path: 'a.js' }, { path: 'a.js', lines: [[2, 4]] }]), session, agent });
    ids.push(...outcome.loaded.message.source.calls.map(call => call.id));
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('the route is the provider and model of the agent\'s current selection, and without one nothing is delivered or read', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10 });
  const payload = delivered([{ path: 'a.js' }]);
  const { outcome } = await load({ cwd, payload, selection: { ...ROUTE, reasoningEffort: 'high' } });
  assert.deepEqual(outcome.loaded.message.source.route, ROUTE);

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

test('handOver injects the message, then each read\'s contexts, then queues the follow-up, in one synchronous stretch', async (t) => {
  const cwd = directoryWith(t, { 'a.js': 10, 'b.js': 10 });
  const { outcome, agent } = await load({
    cwd, payload: delivered([{ path: 'a.js' }, { path: 'b.js' }]),
    contexts: { [join(cwd, 'a.js')]: [context('a1'), context('a2')], [join(cwd, 'b.js')]: [context('b1')] },
  });
  assert.deepEqual(outcome.loaded.contexts, [context('a1'), context('a2'), context('b1')]);

  const returned = handOver({ agent, loaded: outcome.loaded });
  assert.equal(returned, undefined);
  assert.deepEqual(agent.handed.map(([method, message]) => [method, message.id ?? null]), [
    ['inject', outcome.loaded.message.id], ['inject', 'context-a1'], ['inject', 'context-a2'], ['inject', 'context-b1'], ['followup', agent.handed[4][1].id],
  ]);
  const [, followup] = agent.handed[4];
  assert.deepEqual(followup.source, { kind: 'user' });
  assert.equal(followup.role, 'user');
  assert.deepEqual(followup.content, [{ type: 'text', text: loadedText(outcome.loaded) }]);
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
