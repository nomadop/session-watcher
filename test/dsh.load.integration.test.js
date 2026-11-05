// The load against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: the real agent loop over the real `fs-local`, working directory, observation policy and `read` tool, a scripted adapter, the token meter and the JSONL loader. Without the checkout every case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createLoadCommand, handOver, loadHandoffInto } from '../dsh/src/load.js';
import { clearSurface, createContinueCommand } from '../dsh/src/continue.js';
import { LOAD_MESSAGE_KIND } from '../lib/harness/dsh/load-message.js';
import { composeWatcher } from '../dsh/src/composition.js';
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

test('a read through tools.execute inside the agent\'s maintenance answers a result that is not an error, and logs no tool call', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFileSync(join(cwd, 'probe.txt'), fileLines(3, 'probe'));
  const { ctx, agent } = await mountLoop(t, cwd);
  const logged = agent.session.snapshotEvents().length;

  const result = await agent.runMaintenance(signal => runTool(ctx, { id: 'g2-probe', name: 'read', args: { file_path: 'probe.txt' }, signal, agent }));

  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.meta.path, join(cwd, 'probe.txt'));
  assert.deepEqual(result.meta.lines.map(line => line.number), [1, 2, 3]);
  assert.deepEqual(agent.session.snapshotEvents().slice(logged).filter(event => event.type.startsWith('tool/')), []);
});

// --- The load over the real loop ---

const TOKEN = 'sw-handoff-token';
const COMMAND_ID = 'command-load-integration';

// The fixture's files, by name: two kept files read over ranges, one read from its head, one longer than the line cap, and a control file nobody reads.
const FIXTURE = {
  'kept.txt': fileLines(30, 'kept'),
  'head.txt': fileLines(10, 'head'),
  'long.txt': fileLines(2100, 'long'),
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

// `tools.execute` passed through to the real runtime, keeping every batch it answered and every result in them.
function passThrough(ctx) {
  const batches = [];
  const results = [];
  return {
    batches,
    results,
    tools: {
      execute: async (input) => {
        const batch = await ctx.tools.execute(input);
        batches.push(batch);
        results.push(...batch.results.map(entry => entry.result));
        return batch;
      },
    },
  };
}

const kitOf = dsh => ({
  createUserMessage: dsh.llm.createUserMessage,
  CompactionId: dsh.compaction.CompactionId,
  compactCheckpointSource: dsh.compaction.compactCheckpointSource,
});

// One load inside one maintenance task of the real agent, the clear first when `clear` is set; answers what the load answered and the results its reads answered.
async function loadInto(loop, payload, { clear = false } = {}) {
  const { dsh, ctx, agent } = loop;
  const kit = kitOf(dsh);
  const reads = passThrough(ctx);
  const outcome = await agent.runMaintenance(async (signal) => {
    if (clear) {
      clearSurface({ session: agent.session, meter: ctx.tokenMeter, kit, commandId: COMMAND_ID, token: TOKEN });
    }
    return loadHandoffInto({
      agent, session: agent.session, tools: reads.tools, deliver: async () => payload, kit, signal, token: TOKEN,
      cwdOf: session => ctx.workingDirectory.get(session),
    });
  });
  assert.ok(outcome.loaded, JSON.stringify(outcome));
  return { loaded: outcome.loaded, results: reads.results, batches: reads.batches };
}

// The request's messages as the kinds a reader tells them by: `system` for the head, else the source kind.
const kindsOf = request => request.messages.map(message => (message.role === 'system' ? 'system' : message.source.kind));

// `kinds` keeps only the given kinds, in order.
const only = (kinds, wanted) => kinds.filter(kind => wanted.includes(kind));

// The file-to-lines map the reads answered, keyed by absolute path.
function linesRead(results) {
  const map = {};
  for (const { meta } of results) map[meta.path] = [...(map[meta.path] ?? []), ...meta.lines.map(line => line.number)];
  return map;
}

// A watcher composed over `store` and a memory tree holding the fixture under `cwd`, with the means to feed it as the host does.
function watch({ store, cwd, sessionId, files = FIXTURE }) {
  const workingTree = createMemoryWorkingTree({
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [join(cwd, name), text])), path: nodePath.posix, homeDir: null,
  });
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
    { path: 'kept.txt', lines: [[5, 12]] }, { path: 'head.txt' }, { path: 'long.txt', lines: [[50, 2080]] },
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
const resultText = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('');

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
  } finally {
    await reader.close();
  }

  assert.deepEqual(run.headBefore, [], 'the fresh surface holds no system head before the hand-over');
  assert.deepEqual(fresh.loaded.message.source.route, ROUTE_B);
  assert.deepEqual(run.requested, ROUTE_B, 'the last request used the first model when the second was selected');
  assert.deepEqual(cleared.loaded.message.source.route, ROUTE_C);
  assert.deepEqual(agent.session.requestContext(), ROUTE_C);
  assert.deepEqual(requests.map(({ provider, model }) => ({ provider, model })), [ROUTE_B, ROUTE_C], 'each load is named for the model its request used');

  assert.deepEqual(only(kindsOf(requests[0]), ['system', 'session-watcher-load', 'user']), ['system', 'session-watcher-load', 'user']);
  assert.deepEqual(
    only(kindsOf(requests[1]), ['system', 'compact-checkpoint', 'session-watcher-load', 'user']),
    ['system', 'compact-checkpoint', 'session-watcher-load', 'user'],
  );
  const loadIn = request => request.messages.find(message => message.source?.kind === 'session-watcher-load');
  assert.deepEqual(textsOf(loadIn(requests[0])), [JSON.stringify(run.first), ...fresh.results.map(resultText)]);
  assert.deepEqual(textsOf(loadIn(requests[1])), [JSON.stringify(run.second), ...cleared.results.map(resultText)]);
  assert.deepEqual(fresh.loaded.unread, [{ path: join(run.cwd, 'long.txt'), range: [2050, 2080] }]);
  assert.equal(fresh.results.find(result => result.meta.path === join(run.cwd, 'long.txt')).meta.lines.length, 2000);

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
  const firstMap = linesRead(run.fresh.results);
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
  const secondMap = linesRead(run.cleared.results);
  assert.deepEqual(secondMap, { [join(run.cwd, 'kept.txt')]: [15, 16, 17, 18, 19, 20] });
  assert.deepEqual(pathLines(live.watcher), secondMap);
  assert.deepEqual(live.diagnostics, []);

  const ids = [run.fresh, run.cleared].flatMap(({ loaded }) => loaded.message.source.calls.map(call => call.id));
  const records = recordsOf(store, sessionId);
  assert.deepEqual(records.map(row => row.tool_use_id), [...new Set(ids)].sort());

  const rebuilt = watch({ store, cwd: run.cwd, sessionId });
  rebuilt.snapshot(events);
  assert.deepEqual(pathLines(rebuilt.watcher), secondMap);
  assert.deepEqual(recordsOf(store, sessionId), records);
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

  const { results } = await loadInto(loop, payloadOf([{ path: 'kept.txt', lines: [[2, 3]] }]));
  assert.deepEqual(results.map(result => result.meta.path), [join(cwd, 'sub', 'kept.txt')]);
  assert.equal(agent.session.header.cwd, cwd);
});

// --- The commands over the real loop ---

const CONTEXT_KIND = 'sw-test-context';

// A `tools/post-execute` listener that attaches a context to every `read`, as a policy of a profile does: one message per call, named for its file and offset.
function attachContexts(loop) {
  const { dsh, ctx } = loop;
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const decision = await next();
    if (exec.name !== 'read') return decision;
    const text = `context of ${nodePath.basename(exec.arguments.file_path)} from ${exec.arguments.offset}`;
    const attached = dsh.llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: CONTEXT_KIND } });
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), attached] };
  });
}

// The kept list of the command cases: two ranges of one file, then the head of another.
const KEPT = [{ path: 'kept.txt', lines: [[3, 6], [20, 22]] }, { path: 'head.txt' }];

// A command built over a pass-through of the real `tools.execute`, invoked once on the real agent, whose hand-over wakes it and which then runs to idle; answers what the command answered, what its reads ran and answered, and the last request the adapter received.
async function runCommand(loop, makeCommand, input = {}) {
  const { ctx, agent, adapter } = loop;
  const reads = passThrough(ctx);
  const command = makeCommand(reads.tools);
  const result = await command.handler({ agent, signal: new AbortController().signal, ...input });
  await agent.whenIdle();
  return { result, reads, request: adapter.requests.at(-1) };
}

// What a load over the real loop must have put before the model: the message with the delivery and the three kept reads, their results as the tool returned them, and each read's context once, in plan order, between the message and the follow-up.
function assertKeptReadsReachedTheModel({ reads, request, loop, route }) {
  const { agent, cwd } = loop;
  const at = name => join(cwd, name);
  const planned = [
    { file_path: at('kept.txt'), offset: 3, limit: 4 },
    { file_path: at('kept.txt'), offset: 20, limit: 3 },
    { file_path: at('head.txt'), offset: 1, limit: 40 },
  ];
  const loadAt = request.messages.findIndex(message => message.source?.kind === LOAD_MESSAGE_KIND);
  assert.ok(loadAt >= 0, 'the request carries the load message');
  const message = request.messages[loadAt];

  assert.deepEqual(message.source.route, route);
  assert.deepEqual(message.source.calls.map(call => call.name), ['load_handoff', 'read', 'read', 'read']);
  assert.deepEqual(message.source.calls.slice(1).map(call => call.arguments), planned.map(args => JSON.stringify(args)));
  assert.deepEqual(reads.batches.map(batch => batch.results.map(entry => entry.callId)), message.source.calls.slice(1).map(call => [call.id]));
  assert.deepEqual(reads.results.map(result => result.isError), [false, false, false]);
  assert.deepEqual(reads.results.map(result => result.meta.lines.map(line => line.number)), [[3, 4, 5, 6], [20, 21, 22], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  assert.deepEqual(textsOf(message).slice(1), reads.results.map(resultText));
  assert.match(textsOf(message)[1], /\n3: kept body 3\n/);

  const contextTexts = request.messages.filter(each => each.source?.kind === CONTEXT_KIND).map(each => each.content[0].text);
  assert.deepEqual(contextTexts, ['context of kept.txt from 3', 'context of kept.txt from 20', 'context of head.txt from 1']);
  assert.deepEqual(only(request.messages.slice(loadAt + 1).map(each => each.source.kind), [CONTEXT_KIND, 'user']),
    [CONTEXT_KIND, CONTEXT_KIND, CONTEXT_KIND, 'user'], 'the contexts follow the message and precede the follow-up');

  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'tool/call' || event.type === 'tool/result'), [],
    'the maintenance reads log no model-step tool call');
}

test('/sw-load over the real loop reads the kept ranges into the load message under the selected model, and their contexts reach the model once, in order', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = { ...(await mountLoop(t, cwd, ['Loaded.'])), cwd };
  attachContexts(loop);
  const { dsh, ctx, agent } = loop;
  agent.model.select(ROUTE_B);

  const { result, reads, request } = await runCommand(loop, tools => createLoadCommand({
    deliver: async () => payloadOf(KEPT), tools, kit: kitOf(dsh), cwdOf: session => ctx.workingDirectory.get(session),
  }), { rawInput: TOKEN });

  assert.deepEqual(result, { kind: 'success', text: `Loaded handoff ${TOKEN}: 3 reads over 2 files, 0 skipped.` });
  assertKeptReadsReachedTheModel({ reads, request, loop, route: ROUTE_B });
});

test('/sw-continue over the real loop clears the session and reads the kept ranges into the load message under the model selected since the last request, and their contexts reach the model once, in order', { skip }, async (t) => {
  const cwd = fixtureDirectory(t);
  writeFixture(cwd);
  const loop = { ...(await mountLoop(t, cwd, ['Ready.', 'Resumed.'])), cwd };
  attachContexts(loop);
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

  const { result, reads, request } = await runCommand(loop, tools => createContinueCommand({
    table, store, kit: kitOf(dsh), meter: ctx.tokenMeter, flush: session => ctx.sessions.flush(session),
    deliver: async () => payloadOf(KEPT), tools, cwdOf: session => ctx.workingDirectory.get(session),
  }), { commandId: COMMAND_ID, rawInput: '' });

  assert.equal(result.kind, 'success', result.text);
  assert.ok(request.messages.some(message => message.source?.kind === 'compact-checkpoint'), 'the clear stands ahead of the load');
  assertKeptReadsReachedTheModel({ reads, request, loop, route: ROUTE_C });
});
