// The DSH host over a fake Cordis context: load-time enumeration, the session subscriptions, the optional services, the lifetime declaration, the catalog names and disposal, with the store the host opens under a temporary directory.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { getStore, openStore, closeStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL, LONG_CACHE_TTL } from '../lib/constants.js';
import { reusedCallIdAcrossSteps, FIRST_STEP_END, requestHeader, sessionLog } from './helpers/dsh-events.js';
import { createFakeContext, fakeSession } from './helpers/dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-host-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const storePath = () => join(dir, 'store.sqlite');

// The host over a fake context; `readSession` answers an empty snapshot unless given.
function mountHost({
  sessions = [], readSession = async () => ({ session: {}, inheritedEventCount: 0, events: [] }),
  connection, llm, settings, loadIsIgnored = () => null,
} = {}) {
  const ctx = createFakeContext({ sessions, readSession, connection, llm, settings });
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: storePath(), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored, skillsDir: SKILLS_DIR,
  });
  return { ctx, table };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

// Stderr captured for the case, restored after it.
function captureStderr(t) {
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = realError; });
  return lines;
}

const hostLines = lines => lines.filter(line => line.includes('[dsh-host]'));

// Rows archived under `sessionId`, read from the store file once the host has closed it.
function archivedSources(sessionId) {
  const store = openStore(storePath());
  try {
    return store._db.prepare('SELECT segment, capture_source FROM profile WHERE session_id = ? ORDER BY segment')
      .all(sessionId).map(row => ({ ...row }));
  } finally {
    closeStore(store);
  }
}

// The log under a Claude model whose row prices a long lifetime apart from its default one, every `assistant/message` on `route`.
const CLAUDE_MODEL = 'claude-opus-5-5';
function claudeLog(route) {
  return reusedCallIdAcrossSteps().map(event => {
    if (event.type !== 'assistant/message') return event;
    const source = { ...event.data.message.source, model: CLAUDE_MODEL, provider: route };
    return { ...event, data: { ...event.data, message: { ...event.data.message, source } } };
  });
}

// A provider directory listing `route` under one settings entry, and that entry declaring `retention` for it; the llm service names every model by its id, as the adapter base class does.
function declaredLifetime(route, retention) {
  const llm = {
    listConfigurableProviders: () => [
      { provider: route, displayName: route, settingsNs: 'pi-ai', settingsPath: ['providers', route] },
    ],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
  };
  const settings = {
    describe: () => [{ ns: 'pi-ai', revision: 0, value: { providers: { [route]: { cacheRetention: retention } } } }],
  };
  return { llm, settings };
}

const emitLog = (ctx, session, events) => {
  for (const event of events) ctx.emit('session/event', session, event);
};

test('loading ensures a watcher for every listed session and one created later', async () => {
  const reads = [];
  const listed = [fakeSession({ id: 's-listed-a' }), fakeSession({ id: 's-listed-b' })];
  const { ctx, table } = mountHost({
    sessions: listed,
    readSession: async (sessionId) => {
      reads.push(sessionId);
      return { session: {}, inheritedEventCount: 0, events: [] };
    },
  });
  const later = fakeSession({ id: 's-later' });
  ctx.emit('session/created', later);
  ctx.emit('session/event', later, reusedCallIdAcrossSteps()[0]);
  ctx.emit('session/event', listed[0], reusedCallIdAcrossSteps()[0]);
  await settled();

  assert.deepEqual(reads, ['s-listed-a', 's-listed-b', 's-later']);
  for (const id of reads) assert.equal(table.get(id).state, 'live', id);
  ctx.dispose();
});

test('a session event reaches its watcher before the handler yields', async () => {
  const session = fakeSession({ id: 's-sync' });
  const { ctx, table } = mountHost({ sessions: [session] });
  await settled();
  const { watcher } = table.get('s-sync');

  const log = reusedCallIdAcrossSteps();
  const firstCall = log.findIndex(event => event.type === 'assistant/message');
  emitLog(ctx, session, log.slice(0, firstCall + 1));
  assert.equal(watcher.getHistory().length, 1, 'the measured call is applied when emit returns');
  ctx.dispose();
});

test('a throwing handler body writes a handler_failed line and the host keeps serving', async (t) => {
  const lines = captureStderr(t);
  const readSession = (sessionId) => {
    if (sessionId === 's-refused') throw new Error('read refused');
    return Promise.resolve({ session: {}, inheritedEventCount: 0, events: [] });
  };
  const refused = fakeSession({ id: 's-refused' });
  const { ctx, table } = mountHost({ sessions: [refused, fakeSession({ id: 's-listed' })], readSession });
  assert.deepEqual(hostLines(lines), ['s-refused [dsh-host] handler_failed: read refused']);
  assert.notEqual(table.get('s-listed').state, 'unobserved', 'the enumeration continued');

  ctx.emit('session/event', refused, reusedCallIdAcrossSteps()[0]);
  ctx.emit('session/created', fakeSession({ id: 's-created' }));
  await settled();
  assert.deepEqual(hostLines(lines), [
    's-refused [dsh-host] handler_failed: read refused',
    's-refused [dsh-host] handler_failed: read refused',
  ]);
  assert.deepEqual(table.get('s-refused'), { state: 'unobserved' });
  assert.equal(table.get('s-created').state, 'live');
  assert.equal(table.get('s-listed').state, 'live');

  ctx.dispose();
  assert.throws(() => getStore(), /not initialized/);
});

test('a session/created whose watcher composition throws writes a handler_failed line and leaves the session unobserved', async (t) => {
  const lines = captureStderr(t);
  const { ctx, table } = mountHost({
    loadIsIgnored: (cwd) => {
      if (cwd === '/unreadable') throw new Error('ignore rules unreadable');
      return null;
    },
  });
  assert.doesNotThrow(() => ctx.emit('session/created', fakeSession({ id: 's-uncomposed', cwd: '/unreadable' })));
  await settled();
  assert.deepEqual(hostLines(lines), ['s-uncomposed [dsh-host] handler_failed: ignore rules unreadable']);
  assert.deepEqual(table.get('s-uncomposed'), { state: 'unobserved' });
  ctx.dispose();
});

test('a session/disposed whose archival throws writes a handler_failed line and removes the watcher', async (t) => {
  const lines = captureStderr(t);
  const session = fakeSession({ id: 's-unarchived' });
  const { ctx, table } = mountHost({ sessions: [session] });
  await settled();
  table.get('s-unarchived').watcher.closeCurrentSegment = () => { throw new Error('archive broke'); };

  assert.doesNotThrow(() => ctx.emit('session/disposed', session));
  assert.deepEqual(hostLines(lines), ['s-unarchived [dsh-host] handler_failed: archive broke']);
  assert.deepEqual(table.get('s-unarchived'), { state: 'unobserved' });
  ctx.dispose();
});

test('no code path appends to a session', async (t) => {
  const lines = captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  const listed = fakeSession({ id: 's-append-listed' });
  const created = fakeSession({ id: 's-append-created' });
  const { ctx, table } = mountHost({
    sessions: [listed],
    readSession: async sessionId => ({
      session: {}, inheritedEventCount: 0, events: sessionId === listed.id ? log : [],
    }),
  });
  ctx.emit('session/created', created);
  emitLog(ctx, created, log);
  await settled();
  assert.equal(table.get(listed.id).state, 'live');
  assert.equal(table.get(created.id).state, 'live');
  ctx.emit('session/disposed', created);
  ctx.dispose();
  assert.deepEqual(hostLines(lines), [], 'no handler or frame path failed, an append included');
});

test('disposal archives every live watcher and closes the store', async () => {
  const log = reusedCallIdAcrossSteps();
  const sessions = [fakeSession({ id: 's-close-a' }), fakeSession({ id: 's-close-b' })];
  const { ctx, table } = mountHost({
    sessions,
    readSession: async () => ({ session: {}, inheritedEventCount: 0, events: log.slice(0, FIRST_STEP_END + 1) }),
  });
  await settled();
  for (const { id } of sessions) assert.equal(table.get(id).state, 'live', id);
  for (const session of sessions) emitLog(ctx, session, log.slice(FIRST_STEP_END + 1));

  ctx.dispose();
  assert.throws(() => getStore(), /not initialized/);
  for (const { id } of sessions) {
    assert.deepEqual(archivedSources(id), [{ segment: 0, capture_source: 'dsh-live' }], id);
  }
});

test('a disposal after a failed apply still closes the store', () => {
  const ctx = createFakeContext({ readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }) });
  ctx.sessions.list = () => { throw new Error('session store unavailable'); };
  assert.throws(() => applyHost(ctx, {
    defineTool: definition => definition, storePath: storePath(), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR,
  }), /session store unavailable/);

  ctx.dispose();
  assert.throws(() => getStore(), /not initialized/);
});

test('a store close that throws in the disposer writes a handler_failed line with no session id', (t) => {
  const lines = captureStderr(t);
  const { ctx } = mountHost();
  const db = getStore()._db;
  const close = db.close;
  db.close = () => { throw new Error('close broke'); };
  t.after(() => close.call(db));

  assert.doesNotThrow(() => ctx.dispose());
  assert.deepEqual(hostLines(lines), ['[dsh-host] handler_failed: close broke']);
});

test('without a connection the host loads, runs no inject callback, and measures and archives its session', async () => {
  const injected = [];
  const session = fakeSession({ id: 's-unconnected' });
  const ctx = createFakeContext({
    sessions: [session], readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }),
  });
  const inject = ctx.inject;
  ctx.inject = (deps, callback) => inject(deps, (child) => { injected.push(deps); callback(child); });
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: storePath(), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR,
  });
  await settled();
  assert.deepEqual(injected, [], 'no injection called back');

  emitLog(ctx, session, reusedCallIdAcrossSteps());
  assert.equal(table.get('s-unconnected').watcher.getHistory().length, 2);
  ctx.emit('session/disposed', session);
  assert.deepEqual(table.get('s-unconnected'), { state: 'unobserved' });
  ctx.dispose();
  assert.deepEqual(archivedSources('s-unconnected'), [{ segment: 0, capture_source: 'dsh-live' }]);
});

test('a route declaring long prices its Claude model under the long row', async () => {
  const longRow = modelPolicyFor(CLAUDE_MODEL, LONG_CACHE_TTL).cRatio;
  assert.notEqual(longRow, modelPolicyFor(CLAUDE_MODEL, DEFAULT_CACHE_TTL).cRatio, 'the rows price apart');
  const session = fakeSession({ id: 's-long' });
  const { ctx, table } = mountHost({ sessions: [session], ...declaredLifetime('route-long', 'long') });
  await settled();
  emitLog(ctx, session, claudeLog('route-long'));
  assert.equal(table.get('s-long').watcher.getStatus().cRatio, longRow);
  ctx.dispose();
});

test('without settings the host meters under the default', async () => {
  const session = fakeSession({ id: 's-default' });
  const { ctx, table } = mountHost({ sessions: [session], llm: declaredLifetime('route-long', 'long').llm });
  await settled();
  emitLog(ctx, session, claudeLog('route-long'));
  assert.equal(table.get('s-default').watcher.getStatus().cRatio, modelPolicyFor(CLAUDE_MODEL, DEFAULT_CACHE_TTL).cRatio);
  ctx.dispose();
});

test('the lifetime reader answers the default after the settings child unloads', async (t) => {
  const lines = captureStderr(t);
  const declared = declaredLifetime('route-long', 'long');
  const session = fakeSession({ id: 's-unloaded' });
  const { ctx, table } = mountHost({ sessions: [session], ...declared });
  await settled();
  const log = claudeLog('route-long');
  const calls = log.flatMap((event, index) => (event.type === 'assistant/message' ? [index] : []));
  emitLog(ctx, session, log.slice(0, calls[0] + 1));
  assert.equal(table.get('s-unloaded').cacheTtl, LONG_CACHE_TTL);

  ctx.unprovide('settings');
  declared.settings.describe = () => { throw new Error('cannot get required service "settings" in inactive context'); };
  emitLog(ctx, session, log.slice(calls[0] + 1, calls[1] + 1));
  const entry = table.get('s-unloaded');
  assert.equal(entry.state, 'live');
  assert.equal(entry.cacheTtl, null);
  assert.deepEqual(lines.filter(line => line.startsWith('s-unloaded ')), []);
  ctx.dispose();
});

test('an ignored path is unselected by default through the host\'s ignore loader', async () => {
  const session = fakeSession({ id: 's-ignored', cwd: '/repo' });
  const { ctx, table } = mountHost({
    sessions: [session], loadIsIgnored: cwd => (cwd === '/repo' ? rel => rel === 'src/b.js' : null),
  });
  await settled();
  emitLog(ctx, session, reusedCallIdAcrossSteps());
  const { paths } = table.get('s-ignored').watcher.getBucketData();

  const kept = paths.find(row => row.path === '/repo/src/a.js');
  assert.ok(kept, 'the kept path is present');
  assert.equal(kept.defaultSelected, true);
  assert.equal(kept.defaultDiscardReason, null);
  const ignored = paths.find(row => row.path === '/repo/src/b.js');
  assert.ok(ignored, 'the ignored path is present');
  assert.equal(ignored.defaultSelected, false);
  assert.equal(ignored.defaultDiscardReason, 'gitignore');
  ctx.dispose();
});

// A connection whose `fetch.register` records each route; both methods answer the real methods' disposer shape.
function fakeConnection() {
  const routes = [];
  const connection = {
    rpc: { handle() { return async () => {}; } },
    fetch: { register(route) { routes.push(route); return async () => {}; } },
  };
  return { routes, connection };
}

const EVENTS_URL = 'http://h/api/session-watcher.events';
const decoder = new TextDecoder();

// A stream the recorded route serves, read a chunk at a time; `read` answers null once the stream is done.
async function openEvents(route) {
  const reader = (await route.fetch(new Request(EVENTS_URL))).body.getReader();
  return async () => {
    const { value, done } = await reader.read();
    return done ? null : decoder.decode(value);
  };
}

test('with a connection the host registers the events route on the inject child\'s fetch service and unproviding the connection closes every open stream', async () => {
  const { routes, connection } = fakeConnection();
  const { ctx } = mountHost({ connection });
  assert.deepEqual(routes.map(route => [route.path, route.methods, route.requestBody]),
    [['/api/session-watcher.events', ['GET'], 'buffered']]);

  const reads = [await openEvents(routes[0]), await openEvents(routes[0])];
  for (const read of reads) assert.equal(await read(), ': open\n\n');
  ctx.unprovide('connection');
  for (const read of reads) assert.equal(await read(), null);
  ctx.dispose();
});

test('an appended session event reaches an open stream as its sessionId', async () => {
  const { routes, connection } = fakeConnection();
  const session = fakeSession({ id: 's-signalled' });
  const { ctx } = mountHost({ sessions: [session], connection });
  await settled();
  const read = await openEvents(routes[0]);
  assert.equal(await read(), ': open\n\n');

  const log = reusedCallIdAcrossSteps();
  ctx.emit('session/event', session, log.find(event => event.type === 'user/message'));
  assert.equal(await read(), `data: ${JSON.stringify({ sessionId: 's-signalled' })}\n\n`);
  ctx.dispose();
});

const PROVIDER = 'deepseek';
// An id no policy row matches and a catalog name that matches the Claude rows, so the policy tells which one a call was priced under.
const CATALOG_ID = 'keysmith-opus';
const OPUS_NAME = 'Claude Opus 5.5 (Keysmith)';

// An llm service whose catalog `names` maps `provider/id` to a name and rejects any other pair with `NO_ADAPTER`; like the real method, `resolveModelInfo` works only when called on its service, and `calls` records each call.
function fakeCatalog(names) {
  const calls = [];
  const llm = {
    async resolveModelInfo(provider, id) {
      if (this !== llm) throw new TypeError('resolveModelInfo called without its service');
      calls.push([provider, id]);
      const name = names[`${provider}/${id}`];
      if (name === undefined) throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' });
      return { provider, id, name };
    },
    listConfigurableProviders: () => [],
  };
  return { llm, calls };
}

// The log under `CATALOG_ID`, opened by the request header that names it.
function catalogLog() {
  const log = reusedCallIdAcrossSteps().map(event => {
    if (event.type !== 'assistant/message') return event;
    const source = { ...event.data.message.source, model: CATALOG_ID };
    return { ...event, data: { ...event.data, message: { ...event.data.message, source } } };
  });
  return sessionLog([log[0], requestHeader({ model: CATALOG_ID }), ...log.slice(1)]);
}

test('a model call whose pair the llm catalog names is priced under that name', async () => {
  assert.notEqual(modelPolicyFor(OPUS_NAME, DEFAULT_CACHE_TTL).cRatio, modelPolicyFor(CATALOG_ID, DEFAULT_CACHE_TTL).cRatio,
    'the name and the id price apart');
  const { llm, calls } = fakeCatalog({ [`${PROVIDER}/${CATALOG_ID}`]: OPUS_NAME });
  const session = fakeSession({ id: 's-catalog' });
  const { ctx, table } = mountHost({ sessions: [session], llm });
  await settled();
  const log = catalogLog();
  const header = log.findIndex(event => event.type === 'request/header');
  emitLog(ctx, session, log.slice(0, header + 1));
  await settled();
  emitLog(ctx, session, log.slice(header + 1));

  const { watcher } = table.get('s-catalog');
  assert.equal(watcher.getHistory().length, 2);
  assert.equal(watcher.getEpochModel(), OPUS_NAME);
  assert.equal(watcher.getStatus().cRatio, modelPolicyFor(OPUS_NAME, DEFAULT_CACHE_TTL).cRatio);
  assert.deepEqual(calls, [[PROVIDER, CATALOG_ID]]);
  ctx.dispose();
});

test('a resolveModelInfo that throws synchronously leaves the entry live and every call under its id', async (t) => {
  const lines = captureStderr(t);
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const llm = {
    resolveModelInfo() { throw new Error('catalog unavailable'); },
    listConfigurableProviders: () => [],
  };
  const live = fakeSession({ id: 's-thrown-live' });
  const listed = fakeSession({ id: 's-thrown-snapshot' });
  const log = catalogLog();
  const { ctx, table } = mountHost({
    sessions: [live, listed], llm,
    readSession: async sessionId => ({ session: {}, inheritedEventCount: 0, events: sessionId === listed.id ? log : [] }),
  });
  await settled();
  emitLog(ctx, live, log);
  await settled();
  for (const id of [live.id, listed.id]) {
    const entry = table.get(id);
    assert.equal(entry.state, 'live', id);
    assert.equal(entry.watcher.getHistory().length, 2, id);
    assert.equal(entry.watcher.getEpochModel(), CATALOG_ID, id);
  }
  assert.deepEqual(hostLines(lines), []);
  assert.deepEqual(rejections, []);
  ctx.dispose();
});
