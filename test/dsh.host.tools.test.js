// The DSH tool set over the host's watcher table: the registered names, the watcher each call selects, the bootstrap wait, and the values each tool shares with the shared functions the Claude Code tools answer through.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { createTools } from '../dsh/src/tools.js';
import { getStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { bucketsPayload, bucketSummaryPayload, loadedHandoffPayload } from '../lib/wire.js';
import { buildTurnPage } from '../lib/turn-page.js';
import { createTurnReadService } from '../lib/turn-read-service.js';
import { withLoadRecovery } from '../lib/turn-tool-recovery.js';
import { createDshTurnRecovery } from '../lib/harness/dsh/turn-recovery.js';
import { classifyDshToolPair } from '../lib/harness/dsh/native-tools.js';
import { initParser, loadGrammar } from '../lib/symbol-outline.js';
import { DEFAULT_CTP } from '../lib/constants.js';
import { HISTORY_EXCERPT_CHARS } from '../lib/turn-history-budget.js';
import {
  reusedCallIdAcrossSteps, sessionLog, compactCheckpoint, turnStart, turnEnd, stepStart, stepEnd, userMessage,
  assistantMessage, header,
} from './helpers/dsh-events.js';
import { createFakeContext, fakeSession } from './helpers/dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

// The Claude Code set `test/index.mcp-wiring.test.js` holds, `rotate_session` removed.
const EXPECTED_TOOLS = [
  'get_bucket_summary', 'get_turn_skeleton', 'load_handoff', 'prepare_handoff',
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
function mountHost({ sessions = [], snapshots = {}, readSession, listSessions } = {}) {
  const read = readSession
    ?? (async sessionId => ({ session: {}, inheritedEventCount: 0, events: snapshots[sessionId] ?? [] }));
  const ctx = createFakeContext({ sessions, readSession: read, listSessions });
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

test('watcher_status answers exactly { running: true } on a live watcher', async () => {
  const { ctx, tool } = mountHost({ sessions: [fakeSession({ id: 's-live' })] });
  await settled();
  assert.deepEqual(await run(tool('watcher_status'), {}, 's-live'), { running: true });
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
  await initParser({ wasmDir: join(NODE_MODULES, 'web-tree-sitter') });
  await loadGrammar('.js', { wasmDir: join(NODE_MODULES, 'tree-sitter-javascript') });
  const cwd = join(dir, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/a.js'), 'export function a() { return 1; }\n');
  writeFileSync(join(cwd, 'src/b.js'), 'export function b() { return 2; }\nexport default b;\n');
  const { ctx, table } = mountHost({
    sessions: [fakeSession({ id: 's-src', cwd }), fakeSession({ id: 's-dst', cwd })],
    snapshots: { 's-src': notedLog(), 's-dst': reusedCallIdAcrossSteps() },
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

  const service = createTurnReadService({
    store: () => store, sessionId: () => 's-dst', ...history,
    includeToolEvidence: pair => classifyDshToolPair(pair, DEFAULT_CTP) === 'residual', recovery,
  });
  const firstPage = await run(tool('turn_page'), {}, 's-dst');
  assert.ok(firstPage.next_before, 'the notes overflow one page');
  assert.deepEqual({ turn_page: loaded.turn_page, next_before: loaded.next_before }, firstPage);
  const secondPage = await run(tool('turn_page'), { before: firstPage.next_before }, 's-dst');
  assert.deepEqual(secondPage, await service.turnPage({ before: firstPage.next_before }));
  assert.notDeepEqual(secondPage, firstPage);

  const admitAll = createTurnReadService({
    store: () => store, sessionId: () => 's-dst', ...history, includeToolEvidence: () => true, recovery,
  });
  assert.equal((await admitAll.turnSearch({ q: 'export const a' })).found, true, 'only a file read holds the literal');
  assert.deepEqual(await run(tool('turn_search'), { q: 'export const a' }, 's-dst'),
    await service.turnSearch({ q: 'export const a' }));

  const located = await run(tool('turn_locate'), { q: 'turn3data' }, 's-dst');
  assert.deepEqual(located, await service.turnLocate({ q: 'turn3data' }));
  const { scope } = located.ranges.find(range => range.transcript_path === 's-src');
  const searched = await run(tool('turn_search'), { q: 'answer3', scope }, 's-dst');
  assert.equal(searched.found, true);
  assert.deepEqual(searched, await service.turnSearch({ q: 'answer3', scope }));
  ctx.dispose();
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
  ctx.dispose();
});

test('malformed before, scope and q are refused inside execute', async () => {
  const { ctx, tool } = mountHost({ sessions: [fakeSession({ id: 's-live' })] });
  await settled();
  await assert.rejects(run(tool('turn_page'), { before: 'S1:x' }, 's-live'), /before/);
  await assert.rejects(run(tool('turn_search'), { q: 'literal', scope: 'S1' }, 's-live'), /scope/);
  await assert.rejects(run(tool('turn_search'), { q: '   ' }, 's-live'), /\bq\b/);
  await assert.rejects(run(tool('turn_locate'), { q: '' }, 's-live'), /\bq\b/);
  await assert.rejects(run(tool('turn_locate'), { q: 'x'.repeat(HISTORY_EXCERPT_CHARS + 1) }, 's-live'), /\bq\b/);
  ctx.dispose();
});
