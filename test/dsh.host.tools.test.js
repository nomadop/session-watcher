// The DSH tool set over the host's watcher table: the registered names, the watcher each call selects, the bootstrap wait, and the values each tool shares with the shared functions the Claude Code tools answer through.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { composeWatcher } from '../dsh/src/composition.js';
import { createTools } from '../dsh/src/tools.js';
import { createWatcherTable } from '../dsh/src/watcher-table.js';
import { initStore, getStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest, getLiveLedger } from '../lib/rate-lamp-manager.js';
import { bucketsPayload, bucketSummaryPayload, loadedHandoffPayload, statusDigest, statusWireWithLedger } from '../lib/wire.js';
import { buildTurnPage } from '../lib/turn-page.js';
import { createTurnReadService } from '../lib/turn-read-service.js';
import { UNUSABLE_POSITIONS_MESSAGE, withLoadRecovery } from '../lib/turn-tool-recovery.js';
import { createDshTurnRecovery } from '../lib/harness/dsh/turn-recovery.js';
import { initParser, loadGrammar } from '../lib/symbol-outline.js';
import { HISTORY_EXCERPT_CHARS } from '../lib/turn-history-budget.js';
import {
  reusedCallIdAcrossSteps, REUSED_CALL_ID_FILES, REUSED_CALL_ID_SYMBOL_FILES, sessionLog, compactCheckpoint, turnStart,
  turnEnd, stepStart, stepEnd, userMessage, assistantMessage, header,
} from './helpers/dsh-events.js';
import { createFakeContext, fakeSession, fakeSessionTitle } from './helpers/dsh-fake-context.js';
import { filesUnder, watchedTree, writeFilesUnder } from './helpers/attribution-fixtures.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

// The Claude Code set `test/index.mcp-wiring.test.js` holds, `rotate_session` removed.
const EXPECTED_TOOLS = [
  'get_bucket_summary', 'get_turn_skeleton', 'lineage_headlines', 'load_handoff', 'prepare_handoff',
  'submit_turn_notes', 'turn_locate', 'turn_page', 'turn_search',
  'watcher_status',
];

// Each tool's smallest valid arguments.
const MINIMAL_ARGS = {
  watcher_status: {},
  get_bucket_summary: {},
  prepare_handoff: { paths_to_keep: [], summary: 'summary' },
  load_handoff: {},
  get_turn_skeleton: {},
  submit_turn_notes: { snapshot_id: 'snapshot' },
  turn_page: {},
  turn_search: { q: 'literal' },
  turn_locate: { q: 'term' },
  lineage_headlines: { k: '1' },
};

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-tools-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

// The host over a fake context, every definition `ctx.tools.register` receives recorded by name; `snapshots` maps a session id to its snapshot's events, empty unless given, and `listSessions` backs the persisted listing.
function mountHost({ sessions = [], snapshots = {}, readSession, listSessions, sessionTitle } = {}) {
  const read = readSession
    ?? (async sessionId => ({ session: {}, inheritedEventCount: 0, events: snapshots[sessionId] ?? [] }));
  const ctx = createFakeContext({ sessions, readSession: read, listSessions, sessionTitle });
  const registered = [];
  const register = ctx.tools.register;
  ctx.tools.register = (definition) => { registered.push(definition); register(definition); };
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR,
  });
  const tool = name => registered.find(definition => definition.name === name);
  return { ctx, table, registered, tool };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

const execFor = (id, signal = new AbortController().signal) => ({ agent: { session: { id } }, signal });

const run = (definition, args, id, signal) => definition.execute(args, execFor(id, signal));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const handoffRows = () => getStore()._db.prepare('SELECT COUNT(*) AS n FROM handoff').get().n;

// A turn that reads two files, then ten one-step turns, each with its own user text and answer.
function notedLog() {
  return sessionLog([...reusedCallIdAcrossSteps(), ...Array.from({ length: 10 }, (_, index) => {
    const turn = index + 2;
    return [
      turnStart({ turn }), userMessage({ text: `turn${index}data` }), stepStart({ turn }),
      assistantMessage({
        turn, text: `answer${index}`, usage: { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 },
      }),
      stepEnd({ turn }), turnEnd({ turn }),
    ];
  }).flat()]);
}

// The source session commits a long note for every turn through the turn-note tools and prepares a handoff; the token it answers.
async function prepareNotedHandoff(tool, sessionId) {
  const skeleton = await run(tool('get_turn_skeleton'), {}, sessionId);
  const notes = readFileSync(skeleton.notes_path, 'utf8')
    .replace(/^(## NOTE\[(\d+)\])$/gm, (_line, heading, slot) => `${heading}\nnote${slot} ${'n'.repeat(2000)}`);
  writeFileSync(skeleton.notes_path, notes);
  assert.deepEqual(await run(tool('submit_turn_notes'), { snapshot_id: skeleton.snapshot_id }, sessionId), { committed: true });
  const prepared = await run(tool('prepare_handoff'), { paths_to_keep: [], summary: 'summary', next_task: 'next' }, sessionId);
  assert.equal(prepared.status, 'ready');
  return prepared.load_token;
}

test('the registered names are the Claude Code set minus rotate_session', async () => {
  const { ctx, registered } = mountHost();
  assert.deepEqual(registered.map(definition => definition.name).sort(), [...EXPECTED_TOOLS].sort());
  ctx.dispose();
});

test('every tool selects the watcher of exec.agent.session.id', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { ctx, tool } = mountHost({
    sessions: ['s-a', 's-b'].map(id => fakeSession({ id })),
    readSession: sessionId => Promise.reject(new Error(`refused ${sessionId}`)),
  });
  await settled();
  for (const name of EXPECTED_TOOLS) {
    for (const sessionId of ['s-a', 's-b']) {
      await assert.rejects(run(tool(name), MINIMAL_ARGS[name], sessionId), { message: `refused ${sessionId}` }, `${name} ${sessionId}`);
    }
  }
  assert.equal(handoffRows(), 0, 'no handoff was prepared or delivered');
  ctx.dispose();

  const live = mountHost({ sessions: ['s-c', 's-d'].map(id => fakeSession({ id })) });
  await settled();
  for (const sessionId of ['s-c', 's-d']) {
    assert.equal((await run(live.tool('get_bucket_summary'), {}, sessionId)).session_id, sessionId);
  }
  live.ctx.dispose();
});

// The reading `watcher_status` owes `sessionId`: the digest of the payload the RPC `status` endpoint builds, through the tool's JSON round trip.
const readingOf = (table, sessionId) => JSON.parse(JSON.stringify(
  statusDigest(statusWireWithLedger(table.get(sessionId).watcher.getStatus(), getLiveLedger(sessionId))),
));

// A persisted session's listing record, as `sessionQuery.listSessions` answers it.
const persisted = id => ({ header: header({ id }), live: false, persisted: true });

// A snapshot read that answers `snapshots` and counts its calls per id.
function countingReader(snapshots = {}) {
  const reads = {};
  const readSession = async (sessionId) => {
    reads[sessionId] = (reads[sessionId] ?? 0) + 1;
    return { session: {}, inheritedEventCount: 0, events: snapshots[sessionId] ?? [] };
  };
  return { reads, readSession };
}

test('watcher_status replies { running: true, sessionId, reading } with the digest of the RPC status payload', async () => {
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-live' }), fakeSession({ id: 's-empty' })], snapshots: { 's-live': reusedCallIdAcrossSteps() },
  });
  await settled();
  const reply = await run(tool('watcher_status'), {}, 's-live');
  assert.equal(reply.reading.reliable, true, 'a metered session reads reliable, so the case cannot pass on an all-null digest');
  assert.deepEqual(reply, { running: true, sessionId: 's-live', reading: readingOf(table, 's-live') });

  const empty = await run(tool('watcher_status'), {}, 's-empty');
  assert.equal(empty.reading.reliable, false);
  assert.deepEqual(empty, { running: true, sessionId: 's-empty', reading: readingOf(table, 's-empty') });
  ctx.dispose();
});

test('watcher_status writes a non-finite measure as null, as the Claude Code text does', async (t) => {
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-live' })], snapshots: { 's-live': reusedCallIdAcrossSteps() },
  });
  await settled();
  const { watcher } = table.get('s-live');
  const status = watcher.getStatus();
  t.mock.method(watcher, 'getStatus', () => ({ ...status, rateLamp: { ...status.rateLamp, gEma: Number.NaN } }));
  const { reading } = await run(tool('watcher_status'), {}, 's-live');
  assert.equal(reading.reliable, true);
  assert.equal(reading.gEma, null);
  ctx.dispose();
});

test('watcher_status named at another live session replies that session\'s digest and waits on the caller\'s watcher never', async (t) => {
  t.mock.method(console, 'error', () => {});
  const held = deferred();
  const listed = [];
  const { ctx, table, tool } = mountHost({
    sessions: ['s-failing', 's-booting', 's-target'].map(id => fakeSession({ id })),
    listSessions: () => { listed.push(true); return []; },
    readSession: (sessionId) => {
      if (sessionId === 's-failing') return Promise.reject(new Error('read refused'));
      if (sessionId === 's-booting') return held.promise;
      return Promise.resolve({ session: {}, inheritedEventCount: 0, events: reusedCallIdAcrossSteps() });
    },
  });
  await settled();
  assert.equal(table.get('s-failing').state, 'failed');
  assert.equal(table.get('s-booting').state, 'bootstrapping');
  for (const caller of ['s-failing', 's-booting']) {
    const reply = await run(tool('watcher_status'), { sessionId: 's-target' }, caller);
    assert.equal(reply.sessionId, 's-target', caller);
    assert.equal(reply.reading.reliable, true, caller);
    assert.deepEqual(reply.reading, readingOf(table, 's-target'), caller);
  }
  assert.equal(table.get('s-booting').state, 'bootstrapping', 'the caller\'s entry was left unresolved');
  assert.equal(listed.length, 0, 'an entry the table holds is not listed');
  held.resolve({ session: {}, inheritedEventCount: 0, events: [] });
  await settled();
  ctx.dispose();
});

test('watcher_status named at a persisted session the table lacks reads it once, waits for live and replies its digest', async () => {
  const { reads, readSession } = countingReader({ 's-stored': reusedCallIdAcrossSteps() });
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-caller' })], listSessions: () => [persisted('s-other'), persisted('s-stored')], readSession,
  });
  await settled();
  assert.deepEqual(table.get('s-stored'), { state: 'unobserved' });
  const replies = await Promise.all([
    run(tool('watcher_status'), { sessionId: 's-stored' }, 's-caller'),
    run(tool('watcher_status'), { sessionId: 's-stored' }, 's-caller'),
  ]);
  assert.equal(reads['s-stored'], 1, 'two concurrent calls build one watcher');
  assert.equal(reads['s-other'], undefined, 'only the named record is ensured');
  assert.equal(table.get('s-stored').state, 'live');
  for (const reply of replies) {
    assert.equal(reply.reading.reliable, true);
    assert.deepEqual(reply, { running: true, sessionId: 's-stored', reading: readingOf(table, 's-stored') });
  }
  ctx.dispose();
});

test('watcher_status named at a session the listing lacks rejects with its id and creates no entry', async () => {
  const { reads, readSession } = countingReader();
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-caller' })], listSessions: () => [persisted('s-other')], readSession,
  });
  await settled();
  await assert.rejects(run(tool('watcher_status'), { sessionId: 's-nowhere' }, 's-caller'),
    error => error instanceof Error && error.message.includes('s-nowhere') && /neither running nor persisted/.test(error.message));
  assert.equal(reads['s-nowhere'], undefined);
  assert.deepEqual(table.get('s-nowhere'), { state: 'unobserved' });
  ctx.dispose();
});

test('watcher_status named at a failed session rejects with its diagnostic', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { ctx, tool } = mountHost({
    sessions: ['s-caller', 's-failed'].map(id => fakeSession({ id })),
    readSession: sessionId => (sessionId === 's-failed'
      ? Promise.reject(new Error('read refused'))
      : Promise.resolve({ session: {}, inheritedEventCount: 0, events: [] })),
  });
  await settled();
  await assert.rejects(run(tool('watcher_status'), { sessionId: 's-failed' }, 's-caller'),
    error => error instanceof Error && error.message === 'read refused');
  ctx.dispose();
});

test('an abort while the listing is pending ends watcher_status with the abort and ensures nothing', async (t) => {
  const { reads, readSession } = countingReader();
  let listedSignal;
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-caller' })], readSession,
    listSessions: signal => new Promise((_resolve, reject) => {
      listedSignal = signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  await settled();
  const ensure = t.mock.method(table, 'ensure');
  const controller = new AbortController();
  const reading = run(tool('watcher_status'), { sessionId: 's-stored' }, 's-caller', controller.signal);
  await settled();
  assert.equal(listedSignal, controller.signal, 'the listing is handed the call\'s signal');
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(ensure.mock.callCount(), 0);
  assert.equal(reads['s-stored'], undefined);
  assert.deepEqual(table.get('s-stored'), { state: 'unobserved' });
  ctx.dispose();
});

test('a tool called during bootstrapping waits for the snapshot and load_handoff records the installed segment', async () => {
  const source = reusedCallIdAcrossSteps();
  const first = reusedCallIdAcrossSteps();
  const closing = sessionLog([
    ...first, compactCheckpoint({ startSeq: first[0].seq, endSeq: first.at(-1).seq }), ...reusedCallIdAcrossSteps(),
  ]);
  const snapshot = deferred();
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-src' }), fakeSession({ id: 's-boot' })],
    readSession: sessionId => (sessionId === 's-boot'
      ? snapshot.promise
      : Promise.resolve({ session: {}, inheritedEventCount: 0, events: source })),
  });
  await settled();
  const prepared = await run(tool('prepare_handoff'), { paths_to_keep: [], summary: 'summary' }, 's-src');

  const loading = run(tool('load_handoff'), { load_token: prepared.load_token }, 's-boot');
  await settled();
  assert.equal(table.get('s-boot').state, 'bootstrapping');
  snapshot.resolve({ session: {}, inheritedEventCount: 0, events: closing });
  const loaded = await loading;

  assert.equal(loaded.found, true);
  const installed = table.get('s-boot').watcher.getStatus().segment;
  assert.equal(installed, 1, 'the snapshot closed a segment');
  const { consumer_segment: consumerSegment } = getStore()._db
    .prepare('SELECT consumer_segment FROM handoff_load WHERE session_id = ?').get('s-boot');
  assert.equal(consumerSegment, installed);
  ctx.dispose();
});

test('a tool call from a session the table lacks lists nothing', async () => {
  let listings = 0;
  const { ctx, table, tool } = mountHost({
    listSessions: () => { listings += 1; return [{ header: header({ id: 's-absent' }), live: false, persisted: true }]; },
  });
  for (const name of EXPECTED_TOOLS) {
    await assert.rejects(run(tool(name), MINIMAL_ARGS[name], 's-absent'),
      error => error instanceof Error && error.message.includes('s-absent'), name);
  }
  assert.equal(listings, 0);
  assert.deepEqual(table.get('s-absent'), { state: 'unobserved' });
  ctx.dispose();
});

test('a tool on a failed watcher throws an Error whose message is the diagnostic\'s and touches no watcher', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { ctx, table, tool } = mountHost({
    sessions: [fakeSession({ id: 's-failed' })], readSession: () => Promise.reject(new Error('read refused')),
  });
  await settled();
  assert.equal(table.get('s-failed').diagnostic.message, 'read refused');
  for (const name of ['prepare_handoff', 'load_handoff', 'get_turn_skeleton']) {
    await assert.rejects(run(tool(name), MINIMAL_ARGS[name], 's-failed'),
      error => error instanceof Error && error.message === 'read refused', name);
  }
  assert.equal(handoffRows(), 0);
  ctx.dispose();
});

test('an aborted signal ends the wait with an abort error', async () => {
  const snapshot = deferred();
  const { ctx, tool } = mountHost({ sessions: [fakeSession({ id: 's-waiting' })], readSession: () => snapshot.promise });
  const controller = new AbortController();
  const waiting = run(tool('watcher_status'), {}, 's-waiting', controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  snapshot.resolve({ session: {}, inheritedEventCount: 0, events: [] });
  await settled();
  ctx.dispose();
});

test('an aborted signal ends the wait on another session\'s bootstrapping watcher with an abort error', async () => {
  const snapshot = deferred();
  const { ctx, tool } = mountHost({
    sessions: ['s-caller', 's-waiting'].map(id => fakeSession({ id })),
    readSession: sessionId => (sessionId === 's-waiting'
      ? snapshot.promise
      : Promise.resolve({ session: {}, inheritedEventCount: 0, events: [] })),
  });
  await settled();
  const controller = new AbortController();
  const waiting = run(tool('watcher_status'), { sessionId: 's-waiting' }, 's-caller', controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  snapshot.resolve({ session: {}, inheritedEventCount: 0, events: [] });
  await settled();
  ctx.dispose();
});

test('the turn reads carry the DSH recovery sentences', async () => {
  const { ctx, tool } = mountHost({
    sessions: [fakeSession({ id: 's-src' }), fakeSession({ id: 's-dst' })],
    snapshots: { 's-src': notedLog(), 's-dst': reusedCallIdAcrossSteps() },
  });
  await settled();
  const token = await prepareNotedHandoff(tool, 's-src');
  assert.equal((await run(tool('load_handoff'), { load_token: token }, 's-dst')).found, true);
  const recovery = createDshTurnRecovery();

  const page = await run(tool('turn_page'), {}, 's-dst');
  assert.equal(page.turn_page.split('\n')[0], recovery.notice);
  const located = await run(tool('turn_locate'), { q: 'turn3data' }, 's-dst');
  assert.equal(located.recovery, recovery.locateHit);
  const searched = await run(tool('turn_search'), { q: 'answer3' }, 's-dst');
  assert.equal(searched.recovery, recovery.searchHit);
  for (const sentence of [recovery.notice, recovery.locateHit, recovery.searchHit]) {
    assert.match(sentence, /session_event_read/);
  }
  ctx.dispose();
});

test('load_handoff, get_bucket_summary and the turn reads answer the values the shared functions answer over the same store', async (t) => {
  // The host attributes by the lines a call shows, so the destination session's directory holds the files its log
  // reads, and they carry symbols. The source session's log keeps `export const` lines for the search below.
  await initParser({ wasmDir: join(NODE_MODULES, 'web-tree-sitter') });
  await loadGrammar('.js', { wasmDir: join(NODE_MODULES, 'tree-sitter-javascript') });
  const cwd = join(dir, 'repo');
  writeFilesUnder(cwd, REUSED_CALL_ID_SYMBOL_FILES);
  const { ctx, table } = mountHost({
    sessions: [fakeSession({ id: 's-src', cwd }), fakeSession({ id: 's-dst', cwd })],
    snapshots: { 's-src': notedLog(), 's-dst': reusedCallIdAcrossSteps({ files: REUSED_CALL_ID_SYMBOL_FILES }) },
  });
  await settled();
  const store = getStore();
  const T = Date.UTC(2026, 9, 1);
  const tools = createTools({ defineTool: definition => definition, table, store, now: () => T });
  const tool = name => tools.find(definition => definition.name === name);
  const dst = table.get('s-dst');

  const buckets = dst.watcher.getBucketData({ includeSymbols: true });
  assert.ok(buckets.paths.some(row => row.activeSymbols?.length > 0), 'the read files carry symbols');
  assert.deepEqual(await run(tool('get_bucket_summary'), {}, 's-dst'), bucketSummaryPayload(bucketsPayload({
    bucketData: buckets, status: dst.watcher.getStatus(), sessionId: 's-dst', now: T,
  })));

  const token = await prepareNotedHandoff(tool, 's-src');
  assert.deepEqual(await run(tool('load_handoff'), { query: 'summary' }, 's-dst'),
    dst.watcher.searchHandoffs({ query: 'summary' }));
  const loaded = await run(tool('load_handoff'), { load_token: token }, 's-dst');
  const recovery = createDshTurnRecovery();
  const history = { dialogueSource: dst.dialogueSource, dialogueProjection: dst.dialogueProjection };
  const expectedLoad = withLoadRecovery(await loadedHandoffPayload(await dst.watcher.deliverHandoff({ loadToken: token }), {
    store, turnPageBuilder: buildTurnPage, ...history, notice: recovery.notice,
  }));
  assert.deepEqual(await run(tool('load_handoff'), { load_token: token }, 's-dst'), expectedLoad);

  const unreadable = t.mock.method(store, 'listTurnNotes', () => { throw new Error('turn notes unreadable'); });
  const failedPage = await run(tool('load_handoff'), { load_token: token }, 's-dst');
  assert.equal(failedPage.turn_page_error, 'turn_page_unavailable');
  assert.deepEqual(failedPage, withLoadRecovery(await loadedHandoffPayload(await dst.watcher.deliverHandoff({ loadToken: token }), {
    store, turnPageBuilder: buildTurnPage, ...history, notice: recovery.notice,
  })));
  unreadable.mock.restore();

  const service = createTurnReadService({ store: () => store, sessionId: () => 's-dst', ...history, recovery });
  const firstPage = await run(tool('turn_page'), {}, 's-dst');
  assert.ok(firstPage.next_before, 'the notes overflow one page');
  assert.deepEqual({ turn_page: loaded.turn_page, next_before: loaded.next_before }, firstPage);
  const secondPage = await run(tool('turn_page'), { before: firstPage.next_before }, 's-dst');
  assert.deepEqual(secondPage, await service.turnPage({ before: firstPage.next_before }));
  assert.notDeepEqual(secondPage, firstPage);

  assert.equal((await service.turnSearch({ q: 'export const a' })).found, true, 'only a file read holds the literal');
  assert.deepEqual(await run(tool('turn_search'), { q: 'export const a' }, 's-dst'),
    await service.turnSearch({ q: 'export const a' }));

  const headlines = await run(tool('lineage_headlines'), { k: '1' }, 's-dst');
  assert.deepEqual(headlines.lineage.map(({ label }) => label), ['S1']);
  assert.deepEqual(headlines, await service.lineageHeadlines({ k: '1' }));
  await assert.rejects(run(tool('lineage_headlines'), { k: '2' }, 's-dst'), { message: UNUSABLE_POSITIONS_MESSAGE });

  const located = await run(tool('turn_locate'), { q: 'turn3data' }, 's-dst');
  assert.deepEqual(located, await service.turnLocate({ q: 'turn3data' }));
  const { scope } = located.ranges.find(range => range.transcript_path === 's-src');
  const searched = await run(tool('turn_search'), { q: 'answer3', scope }, 's-dst');
  assert.equal(searched.found, true);
  assert.deepEqual(searched, await service.turnSearch({ q: 'answer3', scope }));
  ctx.dispose();
});

// The files `reusedCallIdAcrossSteps` and `notedLog` read, as the working tree of their sessions' directory.
const READ_FILES = filesUnder('/repo', REUSED_CALL_ID_FILES);

// The tools over a watcher table composed over `workingTree`. A `compose` of the production composition is all
// `applyHost` adds, and it hands the composition no tree: the process's own reads the real files.
function mountAttributedTable({ snapshots, workingTree }) {
  initStore(join(dir, 'store.sqlite'));
  const readSession = async sessionId => ({ session: {}, inheritedEventCount: 0, events: snapshots[sessionId] ?? [] });
  const table = createWatcherTable({
    readSession,
    compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
      sessionId, cwd, cacheTtl, store: getStore(), turnNotesRoot: join(dir, 'turn-notes'), readSession, isIgnored: null,
      workingTree,
    }),
  });
  for (const id of Object.keys(snapshots)) table.ensure({ id, header: { cwd: '/repo' } });
  const tools = createTools({ defineTool: definition => definition, table, store: getStore() });
  return { table, tool: name => tools.find(definition => definition.name === name) };
}

test('the turn reads and load_handoff over a table composed over a working tree ask it nothing', async () => {
  const snapshots = { 's-src': notedLog(), 's-dst': reusedCallIdAcrossSteps() };
  const tree = watchedTree(READ_FILES);
  const { table, tool } = mountAttributedTable({ snapshots, workingTree: tree.workingTree });
  try {
    await settled();
    const token = await prepareNotedHandoff(tool, 's-src');
    assert.ok(tree.calls.stat > 0, 'folding a snapshot and taking its keys at capture ask the tree, where no record is kept');

    const before = { ...tree.calls };
    assert.equal((await run(tool('load_handoff'), { load_token: token }, 's-dst')).found, true);
    assert.ok((await run(tool('turn_page'), {}, 's-dst')).turn_page.length > 0);
    assert.equal((await run(tool('turn_search'), { q: 'answer3' }, 's-dst')).found, true);
    assert.ok((await run(tool('turn_locate'), { q: 'turn3data' }, 's-dst')).ranges.length > 0);
    assert.equal((await run(tool('lineage_headlines'), { k: '1' }, 's-dst')).lineage.length, 1);
    assert.deepEqual(tree.calls, before);
  } finally {
    table.disposeAll();
  }
});

test('a tool\'s value is the JSON its Claude Code text encodes', async (t) => {
  const { ctx, table, tool } = mountHost({ sessions: [fakeSession({ id: 's-live' })] });
  await settled();
  const raw = { status: 'ready', load_token: 'token', dropped: undefined, ratio: Number.NaN };
  t.mock.method(table.get('s-live').watcher, 'prepareHandoff', () => raw);
  const value = await run(tool('prepare_handoff'), MINIMAL_ARGS.prepare_handoff, 's-live');
  assert.deepStrictEqual(value, JSON.parse(JSON.stringify(raw)));
  assert.equal(Object.hasOwn(value, 'dropped'), false);
  assert.equal(value.ratio, null);
  ctx.dispose();
});

test('prepare_handoff maps its snake-case input and returns an error result as data', async () => {
  const { ctx, tool } = mountHost({
    sessions: [fakeSession({ id: 's-src' })], snapshots: { 's-src': reusedCallIdAcrossSteps() },
  });
  await settled();
  const stale = await run(tool('prepare_handoff'), { paths_to_keep: [], summary: 'summary', observed_segment: 7 }, 's-src');
  assert.equal(stale.status, 'error');
  assert.equal(stale.error, 'stale_bucket_summary');

  const prepared = await run(tool('prepare_handoff'), {
    paths_to_keep: [{ path: 'src/a.js', symbols: ['a'] }], skills_to_keep: ['sw-handoff'], summary: 'the summary', next_task: 'the next task',
    observed_segment: 0,
  }, 's-src');
  assert.equal(prepared.status, 'ready');
  const rowOf = token => getStore()._db.prepare('SELECT summary, next_task, paths_to_keep FROM handoff WHERE load_token = ?')
    .get(token);
  const row = rowOf(prepared.load_token);
  assert.equal(row.summary, 'the summary');
  assert.equal(row.next_task, 'the next task');
  const kept = JSON.parse(row.paths_to_keep);
  assert.deepEqual(kept.paths.map(entry => [entry.path, entry.symbols]), [['src/a.js', ['a']]]);
  assert.deepEqual(kept.skills, ['sw-handoff']);

  const revised = await run(tool('prepare_handoff'), {
    paths_to_keep: [{ path: 'src/b.js' }], summary: 'the revised summary', load_token: prepared.load_token,
  }, 's-src');
  assert.equal(revised.load_token, prepared.load_token, 'an undelivered token is revised in place');
  assert.equal(rowOf(prepared.load_token).summary, 'the revised summary');

  const before = rowOf(prepared.load_token);
  const patched = await run(tool('prepare_handoff'), { load_token: prepared.load_token, next_task: 'the patched next task' }, 's-src');
  assert.equal(patched.status, 'ready');
  assert.deepEqual(patched.patched, ['next_task']);
  const after = rowOf(prepared.load_token);
  assert.equal(after.next_task, 'the patched next task');
  assert.equal(after.summary, before.summary);
  assert.equal(after.paths_to_keep, before.paths_to_keep);

  const withoutPaths = await run(tool('prepare_handoff'), { summary: 'a summary without paths' }, 's-src');
  assert.equal(withoutPaths.status, 'error');
  assert.equal(withoutPaths.error, 'paths_to_keep_required');
  ctx.dispose();
});

test('malformed before, scope, q and k are refused inside execute', async () => {
  const { ctx, tool } = mountHost({ sessions: [fakeSession({ id: 's-live' })] });
  await settled();
  await assert.rejects(run(tool('turn_page'), { before: 'S1:x' }, 's-live'), /before/);
  await assert.rejects(run(tool('turn_search'), { q: 'literal', scope: 'S1' }, 's-live'), /scope/);
  await assert.rejects(run(tool('turn_search'), { q: '   ' }, 's-live'), /\bq\b/);
  await assert.rejects(run(tool('turn_locate'), { q: '' }, 's-live'), /\bq\b/);
  await assert.rejects(run(tool('turn_locate'), { q: 'x'.repeat(HISTORY_EXCERPT_CHARS + 1) }, 's-live'), /\bq\b/);
  // The session delivered no handoff, so a service call would answer no_handoff_loaded: the check refuses first.
  for (const k of ['S1', '', '0', '3-2', '1,,2', '1 - 2']) {
    await assert.rejects(run(tool('lineage_headlines'), { k }, 's-live'), { message: UNUSABLE_POSITIONS_MESSAGE }, k);
  }
  assert.equal((await run(tool('lineage_headlines'), { k: '1' }, 's-live')).error, 'no_handoff_loaded');
  ctx.dispose();
});

// A source and a destination session over a fake title service; a handoff prepared in the source is loaded as the destination session.
function mountTitled() {
  const sessionTitle = fakeSessionTitle();
  const src = fakeSession({ id: 's-src' });
  const dst = fakeSession({ id: 's-dst' });
  const host = mountHost({
    sessions: [src, dst], snapshots: { 's-src': reusedCallIdAcrossSteps(), 's-dst': reusedCallIdAcrossSteps() }, sessionTitle,
  });
  const prepare = async (nextTask) => {
    const prepared = await run(host.tool('prepare_handoff'), {
      paths_to_keep: [], summary: 'summary', ...(nextTask === undefined ? {} : { next_task: nextTask }),
    }, 's-src');
    assert.equal(prepared.status, 'ready');
    return prepared.load_token;
  };
  const load = args => host.tool('load_handoff').execute(args, { agent: { session: dst }, signal: new AbortController().signal });
  return { ...host, sessionTitle, dst, prepare, load };
}

test('a delivered handoff renames the loading session after its next_task as stored', async () => {
  const { ctx, sessionTitle, dst, prepare, load } = mountTitled();
  await settled();
  const nextTask = 'migrate the auth middleware\nto the new session store';
  assert.equal((await load({ load_token: await prepare(nextTask) })).found, true);
  assert.deepEqual(sessionTitle.renamed, [{ session: dst, title: nextTask }]);
  ctx.dispose();
});

test('an auto-matched delivery renames the loading session too', async () => {
  const { ctx, sessionTitle, dst, prepare, load } = mountTitled();
  await settled();
  await prepare('the only pending task');
  assert.equal((await load({})).found, true);
  assert.deepEqual(sessionTitle.renamed, [{ session: dst, title: 'the only pending task' }]);
  ctx.dispose();
});

test('a later delivery into the same session renames it again, over the title the earlier delivery set', async () => {
  const { ctx, sessionTitle, dst, prepare, load } = mountTitled();
  await settled();
  const first = await prepare('first task');
  const second = await prepare('second task');
  assert.equal((await load({ load_token: first })).found, true);
  assert.equal((await load({ load_token: second })).found, true);
  assert.deepEqual(sessionTitle.renamed, [{ session: dst, title: 'first task' }, { session: dst, title: 'second task' }]);
  ctx.dispose();
});

test('a handoff without a usable next_task leaves the title alone', async () => {
  const { ctx, sessionTitle, prepare, load } = mountTitled();
  await settled();
  for (const nextTask of [undefined, '   ']) {
    assert.equal((await load({ load_token: await prepare(nextTask) })).found, true);
  }
  assert.deepEqual(sessionTitle.renamed, []);
  ctx.dispose();
});

test('a response that is not a delivery renames nothing and writes no line', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const { ctx, sessionTitle, prepare, load } = mountTitled();
  await settled();
  await prepare('first task');
  await prepare('second task');
  assert.equal((await load({ query: 'summary' })).mode, 'search');
  assert.equal((await load({})).ambiguous, true);
  assert.equal((await load({ load_token: 'no-such-token' })).found, false);
  assert.deepEqual(sessionTitle.renamed, []);
  assert.deepEqual(lines, []);
  ctx.dispose();
});

test('a title service that is no longer provided at the call is not asked, and no line is written', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const { ctx, sessionTitle, prepare, load } = mountTitled();
  await settled();
  const token = await prepare('next');
  ctx.unprovide('sessionTitle');
  assert.equal((await load({ load_token: token })).found, true);
  assert.deepEqual(sessionTitle.renamed, []);
  assert.deepEqual(lines, []);
  ctx.dispose();
});

test('a failing rename is a stderr line and the load still answers', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const { ctx, sessionTitle, prepare, load } = mountTitled();
  await settled();
  t.mock.method(sessionTitle, 'rename', () => { throw new Error('session title must contain visible characters'); });
  const loaded = await load({ load_token: await prepare('next') });
  assert.equal(loaded.found, true);
  assert.ok(loaded.turn_page !== undefined || loaded.turn_page_error !== undefined, 'the payload is the full load');
  assert.deepEqual(lines, ['s-dst [dsh-host] title_rename_failed: session title must contain visible characters']);
  ctx.dispose();
});
