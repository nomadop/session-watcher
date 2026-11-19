// The load against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: the real agent loop over the real `fs-local`, working directory, observation policy and `read` tool, a scripted adapter, the token meter and the JSONL loader. The load reads through `readObserved` over the real `fs` and the host's shared Working Tree, and the real `read` tool is the reference the rows of its blocks are compared with. Without the checkout every case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLoadCommand, handOver, loadHandoffInto } from '../dsh/src/load.js';
import { clearSurface, createContinueCommand } from '../dsh/src/continue.js';
import { LOAD_MESSAGE_KIND } from '../lib/harness/dsh/load-message.js';
import { composeWatcher, nodeWorkingTree } from '../dsh/src/composition.js';
import { readObserved } from '../dsh/src/observed-read.js';
import { ATTRIBUTION_LIMITS } from '../lib/constants.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { createMemoryWorkingTree } from '../lib/working-tree.js';
import { openStore, closeStore } from '../lib/store.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const CORDIS = 'vendor/cordis/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, CORDIS)) ? `SW_DSH_CHECKOUT names no ${CORDIS}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

// The real packages.
async function packages() {
  const [
    { Context }, testkit, fsLocal, observation, toolFs, tokenMeter, llm, session, compaction, jsonl,
  ] = await Promise.all([
    CORDIS,
    'packages/test-support/agent-loop-testkit/lib/index.js',
    'packages/fs/fs-local/lib/index.js',
    'packages/fs/fs-observation-policy/lib/index.js',
    'packages/fs/tool-fs/lib/index.js',
    'packages/llm/token-meter/lib/index.js',
    'packages/llm/llm/lib/index.js',
    'packages/core/session/lib/index.js',
    'packages/compaction/compaction/lib/index.js',
    'packages/session/session-persistence-jsonl/lib/index.js',
  ].map(fromCheckout));
  return { Context, testkit, fsLocal, observation, toolFs, tokenMeter, llm, session, compaction, jsonl };
}

// The input every scripted reply reports, above what the loads hold, so the first call's stock exceeds the resident it carries.
const STOCK = 100_000;

// An adapter that answers each request with the next scripted reply and records every request, in the shape of the checkout's `core/agent-loop/tests/mock-adapter.ts`.
function scriptedAdapter(LlmAdapter, replies) {
  class ScriptedAdapter extends LlmAdapter {
    constructor() {
      super();
      this.requests = [];
    }

    resolveModel(provider, model) {
      return Promise.resolve({ provider, id: model, name: model });
    }

    async* stream(options) {
      this.requests.push(options);
      const text = replies.shift();
      if (text === undefined) throw new Error('ScriptedAdapter: script exhausted');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: STOCK, outputTokens: text.length } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  return new ScriptedAdapter();
}

const fileLines = (count, label) => Array.from({ length: count }, (_, index) => `${label} body ${index + 1}`).join('\n') + '\n';

// A canonical temporary directory, removed when the case ends.
function fixtureDirectory(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'sw-dsh-load-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// The real loop over `cwd`: `fs-local` rooted there, the testkit's dependencies with the real working directory and the native tool executor, the token meter, the loop harness, the observation policy and the `read` tool; and one agent created on `{ provider: 'mock', model: 'opt-model' }` with `cwd`.
async function mountLoop(t, cwd, replies = []) {
  const dsh = await packages();
  const ctx = new dsh.Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(dsh.fsLocal.default, { cwd });
  await dsh.testkit.mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(dsh.tokenMeter.default);
  const adapter = scriptedAdapter(dsh.llm.LlmAdapter, replies);
  ctx.llm.registerAdapter(['mock'], adapter);
  const harness = await dsh.testkit.mountAgentLoopTestHarness(ctx);
  await ctx.plugin(dsh.observation);
  await ctx.plugin(dsh.toolFs);
  const agent = await harness.create(dsh.session.SessionId(`load-${Math.random().toString(16).slice(2)}`), { provider: 'mock', model: 'opt-model' }, { cwd });
  return { dsh, ctx, adapter, agent };
}

// One call through the real tool runtime as the batch of one it is: that call's result.
async function runTool(ctx, { id, name, args, signal, agent }) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }], signal, agent });
  assert.deepEqual(batch.results.map(entry => entry.callId), [id]);
  return batch.results[0].result;
}

// --- The load over the real loop ---

const TOKEN = 'sw-handoff-token';
const COMMAND_ID = 'command-load-integration';

// The fixture's files, by name: a kept file read over ranges, one read from its head, one whose range renders past the side limit, and a control file nobody reads.
const FIXTURE = {
  'kept.txt': fileLines(30, 'kept'),
  'head.txt': fileLines(10, 'head'),
  'long.txt': fileLines(6000, 'long'),
  'control.txt': fileLines(5, 'control'),
};

function writeFixture(cwd, files = FIXTURE) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(cwd, name, '..'), { recursive: true });
    writeFileSync(join(cwd, name), text);
  }
}

const payloadOf = paths => ({
  found: true, handoff_id: 1, load_token: TOKEN, summary: 'The work so far.', paths_to_keep: paths, project_dir: '/nowhere',
});

// `readFile` as the host binds it: `readObserved` over the real `fs`, the real event emitter and the host's shared Working Tree, under the matcher's size limit.
const readFileOf = ctx => (agent, key, ranges, signal) => readObserved({
  fs: ctx.fs, emit: (...args) => ctx.emit(...args), agent, tree: nodeWorkingTree(), key, ranges, fileBytes: ATTRIBUTION_LIMITS.fileBytes, signal,
});

const kitOf = dsh => ({
  createUserMessage: dsh.llm.createUserMessage,
  CompactionId: dsh.compaction.CompactionId,
  compactCheckpointSource: dsh.compaction.compactCheckpointSource,
});

// One load inside one maintenance task of the real agent, the clear first when `clear` is set; answers what the load answered.
async function loadInto(loop, payload, { clear = false } = {}) {
  const { dsh, ctx, agent } = loop;
  const kit = kitOf(dsh);
  const outcome = await agent.runMaintenance(async (signal) => {
    if (clear) {
      clearSurface({ session: agent.session, meter: ctx.tokenMeter, kit, commandId: COMMAND_ID, token: TOKEN });
    }
    return loadHandoffInto({
      agent, session: agent.session, readFile: readFileOf(ctx), deliver: async () => payload, kit, signal, token: TOKEN,
      cwdOf: session => ctx.workingDirectory.get(session),
    });
  });
  assert.ok(outcome.loaded, JSON.stringify(outcome));
  return { loaded: outcome.loaded };
}

// The request's messages as the kinds a reader tells them by: `system` for the head, else the source kind.
const kindsOf = request => request.messages.map(message => (message.role === 'system' ? 'system' : message.source.kind));

// `kinds` keeps only the given kinds, in order.
const only = (kinds, wanted) => kinds.filter(kind => wanted.includes(kind));

// The numbered lines of each read block of a read message as a file-to-lines map, keyed by the call's Working Tree key.
function linesRead(message) {
  const map = {};
  message.source.calls.forEach((call, index) => {
    const key = JSON.parse(call.arguments).file_path;
    map[key] = [...(map[key] ?? []), ...[...message.content[index].text.matchAll(/^(\d+): /gm)].map(match => Number(match[1]))];
  });
  return map;
}

// A watcher composed over `store` and a memory tree holding the fixture under `cwd` (or the `workingTree` handed over), with the means to feed it as the host does.
function watch({ store, cwd, sessionId, files = FIXTURE, workingTree = createMemoryWorkingTree({
  files: Object.fromEntries(Object.entries(files).map(([name, text]) => [join(cwd, name), text])), path: nodePath.posix, homeDir: null,
}) }) {
  const { watcher } = composeWatcher({
    sessionId, cwd, store, turnNotesRoot: join(cwd, '.turn-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree,
  });
  const diagnostics = [];
  const driver = createDshSourceDriver({ sessionId, onDiagnostics: reported => diagnostics.push(...reported) });
  const apply = (frame) => {
    if (frame !== null) diagnostics.push(...watcher.applyHarnessFrame(frame).diagnostics);
  };
  return {
    watcher, diagnostics,
    snapshot(events) {
      apply(driver.install(events));
      for (const frame of driver.drain()) apply(frame);
    },
    feed(events) {
      for (const event of events) apply(driver.feed(event));
    },
  };
}

// The Engine's path rows as a file-to-lines map: `lineNumbers` is the Engine's own row field, which the watcher's bucket read keeps internal.
const pathLines = watcher => Object.fromEntries(watcher._engine.getBucketData().paths.map(row => [row.path, row.lineNumbers]));

const recordsOf = (store, sessionId) => store._db
  .prepare('SELECT tool_use_id, record FROM attribution_record WHERE session_id = ? ORDER BY tool_use_id').all(sessionId)
  .map(row => ({ ...row }));

// The models the two loads run under: the first is selected before the session's first request, the second after that request used the first.
const ROUTE_B = { provider: 'mock', model: 'model-b' };
const ROUTE_C = { provider: 'mock', model: 'model-c' };

// Two loads of the same session, the second after the clear and over another range of the kept file, each woken and answered by one scripted turn; `ROUTE_B` is selected ahead of the first load and `ROUTE_C` after the first request, so the second load finds it pending. `requested` is the route of the session's last request when `ROUTE_C` was selected.
async function twoLoads(t) {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = await mountLoop(t, cwd, ['First answer.', 'Second answer.']);
  const { agent, adapter } = loop;
  const first = payloadOf([
    { path: 'kept.txt', lines: [[5, 12]] }, { path: 'head.txt' }, { path: 'long.txt', lines: [[50, 5900]] },
  ]);
  const second = payloadOf([{ path: 'kept.txt', lines: [[15, 20]] }]);

  agent.model.select(ROUTE_B);
  const fresh = await loadInto(loop, first);
  const headBefore = agent.session.surface.nodes.filter(seq => agent.session.eventAt(seq).type === 'system/message');
  handOver({ agent, loaded: fresh.loaded });
  await agent.whenIdle();
  const freshLogged = agent.session.snapshotEvents().length;
  const requested = agent.session.requestContext();

  agent.model.select(ROUTE_C);
  const cleared = await loadInto(loop, second, { clear: true });
  handOver({ agent, loaded: cleared.loaded });
  await agent.whenIdle();
  return { ...loop, cwd, first, second, fresh, cleared, headBefore, freshLogged, requested, requests: adapter.requests };
}

const textsOf = message => message.content.map(block => block.text);

test('a fresh load and a load after the clear reach the model ahead of their follow-ups, under the model selected before the first request and then the one selected after it, and the logged session reopens', { skip }, async (t) => {
  const run = await twoLoads(t);
  const { dsh, ctx, agent, requests, fresh, cleared } = run;
  // The loader folds the lifecycle rules a live append does not apply, so the reopen is what refuses an order the loop would not write.
  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-load-jsonl-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await ctx.plugin(dsh.jsonl, { root: directory });
  const live = agent.session.snapshotEvents();
  const writer = await ctx.sessionPersistence.create(agent.session.header);
  await writer.append(live);
  await writer.close();
  const reader = await ctx.sessionPersistence.open(agent.session.id, 'read');
  try {
    const { events } = await reader.read();
    assert.deepEqual(events.map(event => event.type), live.map(event => event.type));
    // The evidence a load's read message holds is part of its logged source: it reopens as it was written.
    const evidenceOf = log => log.filter(event => event.type === 'user/message' && event.data.source.kind === LOAD_MESSAGE_KIND && event.data.source.calls[0].name === 'read')
      .map(event => event.data.source.paths);
    assert.equal(evidenceOf(live).length, 2, 'fixture: each load logged a read message');
    assert.ok(evidenceOf(live).every(paths => paths.length > 0 && paths.every(entry => entry.write.length > 0)));
    assert.deepEqual(evidenceOf(events), evidenceOf(live));
  } finally {
    await reader.close();
  }

  assert.deepEqual(run.headBefore, [], 'the fresh surface holds no system head before the hand-over');
  assert.deepEqual(fresh.loaded.messages.map(message => message.source.route), [ROUTE_B, ROUTE_B]);
  assert.deepEqual(run.requested, ROUTE_B, 'the last request used the first model when the second was selected');
  assert.deepEqual(cleared.loaded.messages.map(message => message.source.route), [ROUTE_C, ROUTE_C]);
  assert.deepEqual(agent.session.requestContext(), ROUTE_C);
  assert.deepEqual(requests.map(({ provider, model }) => ({ provider, model })), [ROUTE_B, ROUTE_C], 'each load is named for the model its request used');

  assert.deepEqual(only(kindsOf(requests[0]), ['system', 'session-watcher-load', 'user']), ['system', 'session-watcher-load', 'session-watcher-load', 'user']);
  assert.deepEqual(
    only(kindsOf(requests[1]), ['system', 'compact-checkpoint', 'session-watcher-load', 'user']),
    ['system', 'compact-checkpoint', 'session-watcher-load', 'session-watcher-load', 'user'],
  );
  const loadsIn = request => request.messages.filter(message => message.source?.kind === 'session-watcher-load');
  assert.deepEqual(loadsIn(requests[0]).map(textsOf), fresh.loaded.messages.map(textsOf));
  assert.deepEqual(loadsIn(requests[1]).map(textsOf), cleared.loaded.messages.map(textsOf));
  assert.deepEqual(textsOf(fresh.loaded.messages[0]), [JSON.stringify(run.first)]);
  assert.deepEqual(textsOf(cleared.loaded.messages[0]), [JSON.stringify(run.second)]);
  const longLines = linesRead(fresh.loaded.messages[1])[join(run.cwd, 'long.txt')];
  assert.equal(longLines[0], 50);
  assert.ok(longLines.at(-1) < 5900, 'the window was cut at the side limit');
  assert.deepEqual(fresh.loaded.unread, [{ path: join(run.cwd, 'long.txt'), range: [longLines.at(-1) + 1, 5900] }]);

  const measured = ctx.tokenMeter.measure(agent.session);
  const loads = agent.session.snapshotEvents().filter(event => event.data?.source?.kind === 'session-watcher-load').map(event => event.seq);
  assert.ok(measured.nodes.some(node => node.seq === loads.at(-1)), 'the meter prices the surviving load');

  const edit = (name, from, to) => runTool(ctx, {
    id: `edit-${name}`, name: 'edit', args: { file_path: join(run.cwd, name), old_string: from, new_string: to },
    signal: new AbortController().signal, agent,
  });
  const refused = await edit('control.txt', 'control body 2\n', 'control body two\n');
  assert.equal(refused.isError, true);
  assert.equal(refused.error.info?.code, 'FS_NOT_OBSERVED', JSON.stringify(refused.error));
  const edited = await edit('kept.txt', 'kept body 16\n', 'kept body sixteen\n');
  assert.equal(edited.isError, false, JSON.stringify(edited));
});

test('the logged loads are each epoch\'s resource evidence, one attribution record per call, and a rebuild over the same store replays them', { skip }, async (t) => {
  const run = await twoLoads(t);
  const sessionId = run.agent.session.id;
  const events = run.agent.session.snapshotEvents();
  assert.deepEqual(events.filter(event => event.type === 'model/selection').map(event => event.data), [ROUTE_B, ROUTE_C], 'the replayed log holds both selections');
  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-load-store-'));
  const store = openStore(join(directory, 'store.sqlite'));
  t.after(() => {
    closeStore(store);
    rmSync(directory, { recursive: true, force: true });
  });

  const live = watch({ store, cwd: run.cwd, sessionId });
  live.snapshot([]);
  const firstCall = events.findIndex(event => event.type === 'assistant/message');
  live.feed(events.slice(0, firstCall));
  const firstMap = linesRead(run.fresh.loaded.messages[1]);
  assert.deepEqual(firstMap[join(run.cwd, 'kept.txt')], [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(pathLines(live.watcher), firstMap, 'the reads are resident before the first measured call');
  assert.equal(live.watcher.getHistory().length, 0);
  const resident = live.watcher.getBucketData().totalB;
  assert.ok(resident > 0 && resident < STOCK, String(resident));

  live.feed(events.slice(firstCall, run.freshLogged));
  assert.equal(live.watcher.getHistory().length, 1, 'the fresh epoch measured its one call');
  assert.deepEqual(pathLines(live.watcher), firstMap);
  assert.equal(live.watcher.getBucketData().dead, STOCK - resident, 'the anchor subtracts the resident the loads put there');

  live.feed(events.slice(run.freshLogged));
  const secondMap = linesRead(run.cleared.loaded.messages[1]);
  assert.deepEqual(secondMap, { [join(run.cwd, 'kept.txt')]: [15, 16, 17, 18, 19, 20] });
  assert.deepEqual(pathLines(live.watcher), secondMap);
  assert.deepEqual(live.diagnostics, []);

  const ids = [run.fresh, run.cleared].flatMap(({ loaded }) => loaded.messages.flatMap(message => message.source.calls.map(call => call.id)));
  const records = recordsOf(store, sessionId);
  assert.deepEqual(records.map(row => row.tool_use_id), [...new Set(ids)].sort());

  const rebuilt = watch({ store, cwd: run.cwd, sessionId });
  rebuilt.snapshot(events);
  assert.deepEqual(pathLines(rebuilt.watcher), secondMap);
  assert.deepEqual(recordsOf(store, sessionId), records);
});

// One session loaded and woken over a fresh loop, its load handed over as the two messages or, with `single`, as the one message holding the same calls; watched live and then rebuilt over its own store. Answers what the watcher holds of it and the attribution records its calls wrote, keyed by the position of the call.
async function watchedLoad(t, { single }) {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = await mountLoop(t, cwd, ['Answer.']);
  const { dsh, agent } = loop;
  agent.model.select(ROUTE_B);
  const { loaded } = await loadInto(loop, payloadOf([{ path: 'kept.txt', lines: [[5, 12], [20, 22]] }, { path: 'head.txt' }]));
  const [payloadMessage, readMessage] = loaded.messages;
  const merged = dsh.llm.createUserMessage({
    content: [...payloadMessage.content, ...readMessage.content],
    source: { ...payloadMessage.source, calls: [...payloadMessage.source.calls, ...readMessage.source.calls] },
  });
  handOver({ agent, loaded: single ? { ...loaded, messages: [merged] } : loaded });
  await agent.whenIdle();

  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-load-equivalence-'));
  const store = openStore(join(directory, 'store.sqlite'));
  t.after(() => {
    closeStore(store);
    rmSync(directory, { recursive: true, force: true });
  });
  const sessionId = agent.session.id;
  const events = agent.session.snapshotEvents();
  const records = () => recordsOf(store, sessionId)
    .map(({ tool_use_id: id, record }) => [Number(/-(\d+)$/.exec(id)[1]), record])
    .sort(([left], [right]) => left - right);

  const live = watch({ store, cwd, sessionId });
  live.snapshot([]);
  live.feed(events);
  const held = () => ({
    paths: pathLines(live.watcher), totalB: live.watcher.getBucketData().totalB, calls: live.watcher.getHistory().length,
  });
  const afterLive = { ...held(), records: records() };

  const rebuilt = watch({ store, cwd, sessionId });
  rebuilt.snapshot(events);
  const afterRebuild = { paths: pathLines(rebuilt.watcher), totalB: rebuilt.watcher.getBucketData().totalB, records: records() };
  return { afterLive, afterRebuild, diagnostics: [...live.diagnostics, ...rebuilt.diagnostics], cwd };
}

test('the two messages leave the attribution records, the path rows and the rebuild what one message holding the same calls would', { skip }, async (t) => {
  const two = await watchedLoad(t, { single: false });
  const one = await watchedLoad(t, { single: true });

  assert.deepEqual(two.diagnostics, []);
  assert.deepEqual(one.diagnostics, []);
  const lines = { [join(two.cwd, 'kept.txt')]: [5, 6, 7, 8, 9, 10, 11, 12, 20, 21, 22], [join(two.cwd, 'head.txt')]: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
  assert.deepEqual(two.afterLive.paths, lines);
  assert.equal(two.afterLive.records.length, 3, 'one record per call: the delivery and one call for each kept file');
  assert.deepEqual(two.afterLive.paths, two.afterRebuild.paths);
  assert.deepEqual(two.afterLive.records, two.afterRebuild.records);

  const inOneCwd = text => text.replaceAll(one.cwd, two.cwd);
  assert.deepEqual(two.afterLive.records, one.afterLive.records.map(([position, record]) => [position, inOneCwd(record)]));
  assert.deepEqual(two.afterLive.paths, Object.fromEntries(Object.entries(one.afterLive.paths).map(([path, rows]) => [inOneCwd(path), rows])));
  assert.deepEqual([two.afterLive.totalB, two.afterLive.calls], [one.afterLive.totalB, one.afterLive.calls]);
  assert.equal(two.afterRebuild.totalB, one.afterRebuild.totalB);
});

test('a relative kept path reads under the session\'s current directory after a working-directory change, not under its original one', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  writeFixture(join(cwd, 'sub'), { 'kept.txt': fileLines(30, 'sub-kept') });
  const loop = await mountLoop(t, cwd, ['Ready.', 'Loaded.']);
  const { agent, dsh, ctx } = loop;
  agent.followup(dsh.llm.createUserMessage({ content: [{ type: 'text', text: 'Start.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(await ctx.workingDirectory.set(agent, 'sub'), join(cwd, 'sub'));

  const { loaded } = await loadInto(loop, payloadOf([{ path: 'kept.txt', lines: [[2, 3]] }]));
  assert.deepEqual(Object.keys(linesRead(loaded.messages[1])), [join(cwd, 'sub', 'kept.txt')]);
  assert.ok(textsOf(loaded.messages[1])[0].startsWith(`${join(cwd, 'sub', 'kept.txt')} (total lines: 30)\n`));
  assert.equal(agent.session.header.cwd, cwd);
});

// --- The commands over the real loop ---

// The kept list of the command cases: two ranges of one file, then the head of another.
const KEPT = [{ path: 'kept.txt', lines: [[3, 6], [20, 22]] }, { path: 'head.txt' }];

// A command built over the host's `readFile`, invoked once on the real agent, whose hand-over wakes it and which then runs to idle; answers what the command answered and the last request the adapter received.
async function runCommand(loop, makeCommand, input = {}) {
  const { ctx, agent, adapter } = loop;
  const command = makeCommand(readFileOf(ctx));
  const result = await command.handler({ agent, signal: new AbortController().signal, ...input });
  await agent.whenIdle();
  return { result, request: adapter.requests.at(-1) };
}

// What a load over the real loop must have put before the model: the payload message with the delivery, the read message with the two kept files' reads, their blocks the rendering of the planned windows, one per file, and the follow-up right behind them.
function assertKeptReadsReachedTheModel({ request, loop, route }) {
  const { agent, cwd } = loop;
  const at = name => join(cwd, name);
  const planned = [
    { file_path: at('kept.txt'), ranges: [{ offset: 3, limit: 4 }, { offset: 20, limit: 3 }] },
    { file_path: at('head.txt'), ranges: [{ offset: 1, limit: 40 }] },
  ];
  const loadAt = request.messages.findIndex(message => message.source?.kind === LOAD_MESSAGE_KIND);
  assert.ok(loadAt >= 0, 'the request carries the load message');
  const [payloadMessage, message] = request.messages.slice(loadAt, loadAt + 2);

  assert.deepEqual([payloadMessage, message].map(each => each.source.route), [route, route]);
  assert.deepEqual(payloadMessage.source.calls.map(call => call.name), ['load_handoff']);
  assert.equal(message.source.kind, LOAD_MESSAGE_KIND);
  assert.deepEqual(message.source.calls.map(call => call.name), ['read', 'read']);
  assert.deepEqual(message.source.calls.map(call => call.arguments), planned.map(args => JSON.stringify(args)));
  assert.deepEqual(Object.values(linesRead(message)), [[3, 4, 5, 6, 20, 21, 22], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  assert.deepEqual(textsOf(message).map(text => text.split('\n')[0]), [`${at('kept.txt')} (total lines: 30)`, `${at('head.txt')} (total lines: 10)`]);
  assert.match(textsOf(message)[0], /\n6: kept body 6\n--\n20: kept body 20\n/);
  assert.match(textsOf(message)[0], /\n3: kept body 3\n/);
  assert.equal(request.messages[loadAt + 2].source.kind, 'user', 'the follow-up follows the two messages, with no context message between');

  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'tool/call' || event.type === 'tool/result'), [],
    'the load logs no tool call');
}

test('/sw-load over the real loop reads the kept ranges into the load message under the selected model', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = { ...(await mountLoop(t, cwd, ['Loaded.'])), cwd };
  const { dsh, ctx, agent } = loop;
  agent.model.select(ROUTE_B);

  const { result, request } = await runCommand(loop, readFile => createLoadCommand({
    deliver: async () => payloadOf(KEPT), readFile, kit: kitOf(dsh), cwdOf: session => ctx.workingDirectory.get(session),
  }), { rawInput: TOKEN });

  assert.deepEqual(result, { kind: 'success', text: `Loaded handoff ${TOKEN}: 3 reads over 2 files, 0 skipped.` });
  assertKeptReadsReachedTheModel({ request, loop, route: ROUTE_B });
});

test('/sw-continue over the real loop clears the session and reads the kept ranges into the load message under the model selected since the last request', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = { ...(await mountLoop(t, cwd, ['Ready.', 'Resumed.'])), cwd };
  const { dsh, ctx, agent } = loop;
  agent.followup(dsh.llm.createUserMessage({ content: [{ type: 'text', text: 'Start.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  agent.model.select(ROUTE_C);

  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-load-continue-'));
  const store = openStore(join(directory, 'store.sqlite'));
  t.after(() => {
    closeStore(store);
    rmSync(directory, { recursive: true, force: true });
  });
  store.insertHandoff({
    sessionId: agent.session.id, segment: 0, loadToken: TOKEN, createdAt: 1000, pathsToKeep: '[]', summary: 'summary', summaryTokens: 10,
  });
  const table = { waitLive: async () => ({ state: 'live', watcher: { getStatus: () => ({ segment: 0 }) } }) };

  const { result, request } = await runCommand(loop, readFile => createContinueCommand({
    table, store, kit: kitOf(dsh), meter: ctx.tokenMeter, flush: session => ctx.sessions.flush(session),
    deliver: async () => payloadOf(KEPT), readFile, cwdOf: session => ctx.workingDirectory.get(session),
  }), { commandId: COMMAND_ID, rawInput: '' });

  assert.equal(result.kind, 'success', result.text);
  assert.ok(request.messages.some(message => message.source?.kind === 'compact-checkpoint'), 'the clear stands ahead of the load');
  assertKeptReadsReachedTheModel({ request, loop, route: ROUTE_C });
});

// --- The blocks against the real read tool ---

const resultTextOf = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('');

// The numbered rows of a text, in order: what the `read` tool prints inside its envelope and what a block prints under its path.
const rowsIn = text => text.split('\n').filter(line => /^\d+: /.test(line));

// The rows of each stretch of a block, one list per `--` line and the one before it; a stretch holds the runs whose line numbers follow on, so a window comparison by position needs windows that do not.
const runsIn = text => text.split('\n').reduce((runs, line) => {
  if (line === '--') runs.push([]);
  else if (/^\d+: /.test(line)) runs.at(-1).push(line);
  return runs;
}, [[]]);

// The real `read` tool run on the window `{ file_path, offset, limit }`, as the tool answers it: the path it prints, the file's total lines and its rows.
async function nativeRead(loop, args) {
  const { ctx, agent } = loop;
  const result = await runTool(ctx, { id: `native-${Math.random().toString(16).slice(2)}`, name: 'read', args, signal: new AbortController().signal, agent });
  assert.equal(result.isError, false, JSON.stringify(result));
  const text = resultTextOf(result);
  const total = /total (\d+) lines\)|of (\d+)\. Use offset/.exec(text);
  return { path: /^<path>(.*)<\/path>/.exec(text)[1], totalLines: Number(total[1] ?? total[2]), rows: rowsIn(text) };
}

// Every file holds lines below the tool's line-length and byte limits, so a block is comparable with the tool's answer for the same window; `near-limit.txt` has a line one character short of the tool's line cut.
const DRIFT_FIXTURE = {
  'plain.txt': fileLines(30, 'plain'),
  'near-limit.txt': `${'n'.repeat(1999)}\nshort\n`,
  'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
  'no-final-newline.txt': 'alpha\nbeta',
  'blank-lines.txt': 'a\n\n\nb\n  indented  \n\t\n',
  'unicode.txt': 'héllo wörld\n日本語の行\n😀 emoji\n',
  'empty.txt': '',
  'big.txt': fileLines(6000, 'big'),
};

test('each row of a block, its path and its total lines are what the real read tool returns for the same window', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd, DRIFT_FIXTURE);
  symlinkSync(join(cwd, 'plain.txt'), join(cwd, 'link.txt'));
  const loop = await mountLoop(t, cwd);
  const { loaded } = await loadInto(loop, payloadOf([
    { path: 'plain.txt', lines: [[1, 5], [10, 12], [28, 30], [28, 40]] },
    { path: 'plain.txt' },
    { path: 'crlf.txt' }, { path: 'no-final-newline.txt' }, { path: 'blank-lines.txt' }, { path: 'unicode.txt' }, { path: 'empty.txt' },
    { path: 'near-limit.txt' },
    { path: 'link.txt', lines: [[3, 6]] },
  ]));

  assert.deepEqual([loaded.skipped, loaded.unread], [[], []]);
  const blocks = textsOf(loaded.messages[1]);
  assert.equal(blocks.length, 8, 'one block for each of the eight files');
  assert.ok(blocks.at(-1).startsWith(`${join(cwd, 'plain.txt')} (total lines: 30)\n`), 'the link is shown by the path the tool prints');
  let compared = 0;
  for (const [index, call] of loaded.messages[1].source.calls.entries()) {
    const { file_path: file, ranges } = JSON.parse(call.arguments);
    const runs = runsIn(blocks[index]);
    for (const [at, { offset, limit }] of ranges.entries()) {
      const native = await nativeRead(loop, { file_path: file, offset, limit });
      assert.equal(blocks[index].split('\n')[0], `${native.path} (total lines: ${native.totalLines})`, `${file} ${offset}: the header`);
      assert.deepEqual(runs[at] ?? [], native.rows, `${file} ${offset}-${offset + limit - 1}: the rows`);
      compared += 1;
    }
    // The evidence the call's entry holds is those rows, each line once: what the block shows and the carried lines are one set.
    const entry = loaded.messages[1].source.paths[index];
    assert.equal(entry.path, file);
    const shown = blocks[index].split('\n').filter(row => /^\d+: /.test(row));
    assert.deepEqual(new Set((entry.write ?? []).map(([number, text]) => `${number}: ${text}`)), new Set(shown), `${file}: the evidence is the shown rows`);
  }
  assert.equal(compared, 12, 'every window of every file was compared');
});

test('a block cut at the side limit holds the rows the real tool returns for the surviving window, then the notice of where to continue', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd, DRIFT_FIXTURE);
  const loop = await mountLoop(t, cwd);
  const { loaded } = await loadInto(loop, payloadOf([{ path: 'big.txt', lines: [[10, 5900]] }]));

  const [block] = textsOf(loaded.messages[1]);
  const last = linesRead(loaded.messages[1])[join(cwd, 'big.txt')].at(-1);
  assert.ok(last < 5900 && block.length <= ATTRIBUTION_LIMITS.sideChars, `${last} ${block.length}`);
  // The tool answers at most 2000 lines of a window, so the surviving window is read in pieces.
  const native = [];
  for (let offset = 10; offset <= last; offset += 2000) {
    native.push(...(await nativeRead(loop, { file_path: join(cwd, 'big.txt'), offset, limit: Math.min(2000, last - offset + 1) })).rows);
  }
  assert.deepEqual(rowsIn(block), native);
  assert.ok(block.endsWith(`(Output capped after line ${last}. Use offset=${last + 1} to continue.)\n`), block.slice(-120));
  assert.deepEqual(loaded.unread, [{ path: join(cwd, 'big.txt'), range: [last + 1, 5900] }]);
});

test('a window wholly past the end of a non-empty kept file is skipped, and the kept lines of the same entry are still read', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = await mountLoop(t, cwd);
  const { loaded } = await loadInto(loop, payloadOf([{ path: 'kept.txt', lines: [[40, 50], [2, 3]] }]));

  assert.deepEqual(loaded.skipped, [{ path: join(cwd, 'kept.txt'), reason: 'past-end' }]);
  assert.deepEqual(linesRead(loaded.messages[1]), { [join(cwd, 'kept.txt')]: [2, 3] });
});

test('over a symlinked kept path the read keeps the lexical key and shows the realpath, and attribution retains the lexical key', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd, { 'real/target.txt': fileLines(10, 'target') });
  symlinkSync(join(cwd, 'real', 'target.txt'), join(cwd, 'link.txt'));
  const loop = await mountLoop(t, cwd, ['Seen.']);
  const { agent } = loop;
  const { loaded } = await loadInto(loop, payloadOf([{ path: 'link.txt', lines: [[2, 4]] }]));

  const [read] = loaded.messages[1].source.calls;
  assert.equal(JSON.parse(read.arguments).file_path, join(cwd, 'link.txt'));
  assert.equal(textsOf(loaded.messages[1])[0].split('\n')[0], `${join(cwd, 'real', 'target.txt')} (total lines: 10)`);

  handOver({ agent, loaded });
  await agent.whenIdle();
  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-load-symlink-'));
  const store = openStore(join(directory, 'store.sqlite'));
  t.after(() => {
    closeStore(store);
    rmSync(directory, { recursive: true, force: true });
  });
  const live = watch({ store, cwd, sessionId: agent.session.id, workingTree: nodeWorkingTree() });
  live.snapshot([]);
  live.feed(agent.session.snapshotEvents());
  assert.deepEqual(pathLines(live.watcher), { [join(cwd, 'link.txt')]: [2, 3, 4] });
  assert.deepEqual(live.diagnostics, []);
});
