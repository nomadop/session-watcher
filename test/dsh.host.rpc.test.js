// The `/session-watcher` RPC channel over the DSH host's watcher table: the state each reply carries, the payload each endpoint shares with its express route, the route's failure codes, the pricing write's fan-out to every live watcher, and the handoff catalog `handoff/list` answers, which has no express route.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';

import { applyHost } from '../dsh/src/host.js';
import { createRpcHandler } from '../dsh/src/rpc.js';
import { PI_AI_SERVICE } from '../dsh/src/pi-ai-integration.js';
import { LOCAL_CARRIER_BUNDLE, OFFICIAL_CARRIER_BUNDLE } from '../dsh/src/carrier-cache-switch.js';
import { getStore, openStore, closeStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest, getLiveLedger } from '../lib/rate-lamp-manager.js';
import { statusWire, statusWireWithLedger, bucketsPayload, overrideWarnings, pricingResponse } from '../lib/wire.js';
import { buildTurnBrowse } from '../lib/turn-browse.js';
import { lampZone } from '../lib/bill-regret.js';
import { forLoadedHandoff } from '../lib/lineage.js';
import { loadPricingOverride } from '../lib/pricing-store.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL, LONG_CACHE_TTL, ATTRIBUTION_LIMITS } from '../lib/constants.js';
import { initParser, loadGrammar } from '../lib/symbol-outline.js';
import {
  reusedCallIdAcrossSteps, REUSED_CALL_ID_FILES, REUSED_CALL_ID_SYMBOL_FILES, header,
  assistantMessage, compactionPrune, continueCheckpoint, ignorableEvent, innerAttempt, innerCall, innerEnd, innerSealCarrier, loadFollowUp, loadPayload, loadReads, sessionLog,
  toolCall, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';
import { createFakeContext, fakeSession, fakeSessionLogs, fakeTokenMeter, fakeFs } from './helpers/dsh-fake-context.js';
import { writeFilesUnder } from './helpers/attribution-fixtures.js';
import { innerModeProjection, createModeSelection, createModeAccess, MODE_RECORD_TYPE, MODE_PROJECTION_KEY } from '../dsh/src/inner-mode.js';
import { MONITOR_PROJECTION_KEY } from '../dsh/src/inner-monitor-read.js';
import { createModeReaders } from '../dsh/src/client/mode-reader.js';
import { createMonitorStores } from '../dsh/src/client/monitor-store.js';
import { InnerCompactionView } from '../dsh/src/client/monitor-view.js';
import { ModeMark, ModeToggle } from '../dsh/src/client/mode.js';
import { zh } from '../dsh/src/client/locales.js';
import { INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE } from '../dsh/src/inner-seal.js';
import {
  modeKit, monitorKit, compactStreamOf, newSession, fakeAgents, forkSeedOf, sessionQueryError, sessionHeader,
  INHERITING_SETTINGS,
} from './helpers/dsh-mode-kit.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));
// The projections the inner child registers, in the order it registers them.
const REGISTRATION_ORDER = [MODE_PROJECTION_KEY, MONITOR_PROJECTION_KEY];
// The code the session service rejects a read of an id it neither holds nor lists with.
const SESSION_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-rpc-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

// The host only hands the web server to its registration's shadow, so the fake has no member.
const webServer = {};

// A connection whose `rpc.handle` and `fetch.register` record each registration and answer the real methods' disposer shape.
function fakeConnection() {
  const handled = [];
  const routes = [];
  return {
    handled,
    routes,
    connection: {
      rpc: { handle(channel, handler) { handled.push({ channel, handler }); return async () => {}; } },
      fetch: { register(route) { routes.push(route); return async () => {}; } },
    },
  };
}

// The host over a fake context with a connection and a web server; `snapshots` maps a session id to its snapshot's events, empty unless given, and `listSessions` backs the persisted listing.
function mountHost({
  sessions = [], snapshots = {}, readSession, listSessions, llm, settings, loadIsIgnored = () => null, sibling, pluginManager, loader, carrierInstallTarget,
} = {}) {
  const { handled, routes, connection } = fakeConnection();
  const read = readSession
    ?? (async sessionId => ({ session: {}, inheritedEventCount: 0, events: snapshots[sessionId] ?? [] }));
  const ctx = createFakeContext({ sessions, readSession: read, listSessions, connection, webServer, llm, settings, sibling, pluginManager, loader });
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored,
    skillsDir: SKILLS_DIR, carrierInstallTarget,
  });
  return { ctx, table, handled, routes, handler: handled[0]?.handler };
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

const call = (handler, endpoint, payload) => handler(endpoint, payload, new AbortController().signal, { kind: 'operator' });

const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });

// The log with every `assistant/message` under `model` and, when given, on `route`; its reads show the lines of `files`.
function logUnder({ model, route, files }) {
  return reusedCallIdAcrossSteps({ files }).map(event => {
    if (event.type !== 'assistant/message') return event;
    const source = { ...event.data.message.source, model, ...(route === undefined ? {} : { provider: route }) };
    return { ...event, data: { ...event.data, message: { ...event.data.message, source } } };
  });
}

const PRO_MODEL = 'deepseek-v4-pro';
const FLASH_MODEL = 'deepseek-v4-flash';
const CLAUDE_MODEL = 'claude-opus-5-5';

// A provider directory listing `route` under one settings entry, and that entry declaring `retention` for it; the llm service names every model by its id, as the adapter base class does.
function declaredLifetime(route, retention) {
  return {
    llm: {
      listConfigurableProviders: () => [
        { provider: route, displayName: route, settingsNs: 'pi-ai', settingsPath: ['providers', route] },
      ],
      resolveModelInfo: async (provider, id) => ({ provider, id, name: id }),
    },
    settings: {
      describe: () => [{ ns: 'pi-ai', revision: 0, value: { providers: { [route]: { cacheRetention: retention } } } }],
    },
  };
}

test('state follows the watcher: unobserved, bootstrapping without payload, live with payload, failed with its diagnostic and live without one', async (t) => {
  captureStderr(t);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const readSession = (sessionId) => {
    if (sessionId === 's-refused') return Promise.reject(new Error('read refused'));
    return pending;
  };
  const { ctx, handler } = mountHost({
    sessions: [fakeSession({ id: 's-boot' }), fakeSession({ id: 's-refused' })], readSession,
  });

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-nobody' }), { ok: true, value: { state: 'unobserved' } });
  assert.deepEqual(await call(handler, 'status', { sessionId: 's-boot' }), { ok: true, value: { state: 'bootstrapping' } });

  await settled();
  assert.deepEqual(await call(handler, 'status', { sessionId: 's-refused' }), {
    ok: true,
    value: { state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'read refused' } },
  });

  release({ session: {}, inheritedEventCount: 0, events: reusedCallIdAcrossSteps() });
  await settled();
  const live = await call(handler, 'status', { sessionId: 's-boot' });
  assert.equal(live.ok, true);
  assert.deepEqual(Object.keys(live.value).sort(), ['payload', 'state']);
  assert.equal(live.value.state, 'live');
  ctx.dispose();
});

test('every listed endpoint answers a live session with the value its express route answers', async () => {
  const sessionId = 's-live';
  const route = 'route-long';
  // The files the log reads exist under the session's cwd, with the lines the log shows because the host attributes by
  // them, and the grammar is loaded, so a symbol-bearing buckets payload differs from the symbol-less one.
  await initParser({ wasmDir: join(NODE_MODULES, 'web-tree-sitter') });
  await loadGrammar('.js', { wasmDir: join(NODE_MODULES, 'tree-sitter-javascript') });
  const cwd = join(dir, 'repo');
  writeFilesUnder(cwd, REUSED_CALL_ID_SYMBOL_FILES);
  const { ctx, table } = mountHost({
    sessions: [fakeSession({ id: sessionId, cwd })],
    snapshots: { [sessionId]: logUnder({ model: CLAUDE_MODEL, route, files: REUSED_CALL_ID_SYMBOL_FILES }) },
    ...declaredLifetime(route, 'long'),
  });
  await settled();
  const store = getStore();
  const { handoffId } = store.insertHandoff({
    sessionId: 's-prior', segment: 0, loadToken: 'token-prior', createdAt: 1000,
    pathsToKeep: '[]', summary: 'prior', summaryTokens: 10, projectId: 'project-1', transcriptPath: null,
  });
  store.insertHandoffLoad({
    handoffId, sessionId, loadedAt: 2000, loaderVersion: 'test', claimResult: 'primary', primarySessionId: sessionId,
    consumerSegment: 0,
  });
  store.upsertTurnNotes([{
    sourceSessionId: 's-prior', anchorUuid: 'anchor-1', uText: 'Compare the two modules.',
    uOriginalChars: 24, note: 'compared', searchTerms: 'compare', sourceTimestamp: 1,
  }]);

  const T = Date.UTC(2026, 9, 1);
  const handler = createRpcHandler({ table, store, now: () => T });
  const { watcher } = table.get(sessionId);
  const live = payload => ({ ok: true, value: { state: 'live', payload } });
  const overrides = { [join(cwd, 'src/b.js')]: 'exclude', [join(cwd, 'src/absent.js')]: 'include' };

  assert.deepEqual(await call(handler, 'status', { sessionId }),
    live(statusWireWithLedger(watcher.getStatus(), getLiveLedger(sessionId))));
  assert.deepEqual(await call(handler, 'history', { sessionId }), live(watcher.getHistory()));
  assert.ok(watcher.getBucketData({ includeSymbols: true }).paths.some(row => row.activeSymbols?.length > 0),
    'the read files carry symbols');
  assert.deepEqual(await call(handler, 'buckets', { sessionId }), live(bucketsPayload({
    bucketData: watcher.getBucketData({ includeSymbols: false }), status: watcher.getStatus(), sessionId, now: T,
  })));

  const lineage = forLoadedHandoff({ store, sessionId });
  assert.deepEqual(lineage.map(source => source.sessionId), ['s-prior'], 'the session loaded the prior one');
  const { sections } = buildTurnBrowse({ store, lineage });
  assert.ok(sections.length > 0, 'the lineage has turn notes to browse');
  assert.deepEqual(await call(handler, 'turn/browse', { sessionId }), live({ sections }));

  assert.deepEqual(await call(handler, 'preview', { sessionId, overrides }), live({ scenario: watcher.readScenario(overrides) }));

  const answered = await call(handler, 'user-overrides', { sessionId, overrides });
  const warnings = overrideWarnings(watcher.replaceUserOverrides(overrides).warnings);
  assert.ok(warnings.length > 0, 'the absent path is warned about');
  assert.deepEqual(answered, live({ ...statusWire(watcher.getStatus()), warnings }));

  const longRow = modelPolicyFor(CLAUDE_MODEL, LONG_CACHE_TTL);
  assert.notEqual(longRow.cRatio, modelPolicyFor(CLAUDE_MODEL, DEFAULT_CACHE_TTL).cRatio, 'the rows price apart');
  assert.equal(watcher.getEpochModel(), CLAUDE_MODEL);
  assert.deepEqual(await call(handler, 'pricing', { sessionId }), live(pricingResponse({
    model: CLAUDE_MODEL, saved: loadPricingOverride(CLAUDE_MODEL), policy: longRow, cliRatio: null,
  })));
  ctx.dispose();
});

const liveReply = payload => ({ ok: true, value: { state: 'live', payload } });

// The project key of a session is its cwd resolved, so an absolute cwd and the projectId of a stored handoff are the same literal.
const PROJECT_A = '/work/project-a';
const PROJECT_B = '/work/project-b';

// A handoff of `projectId` made by `sessionId` at `createdAt`; the store's own `insertHandoff` writes it.
function addHandoff(store, { sessionId, loadToken, createdAt, nextTask = null, projectId }) {
  store.insertHandoff({ sessionId, segment: 0, loadToken, createdAt, pathsToKeep: '[]', summary: 'sum', summaryTokens: 3, nextTask, projectId });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Handoffs spread across two projects and none, made at known distances before `now`: the session `own` made `self-made-owl` itself, which a bare load never offers it, and `sibling-fox` is the one handoff of another session that a bare load would deliver to it.
function seedCatalog(store, own, now) {
  addHandoff(store, { sessionId: own, loadToken: 'self-made-owl', createdAt: now - 3 * HOUR, nextTask: 'continue here', projectId: PROJECT_A });
  addHandoff(store, { sessionId: 's-prior', loadToken: 'sibling-fox', createdAt: now - 5 * MINUTE, projectId: PROJECT_A });
  addHandoff(store, { sessionId: 's-prior', loadToken: 'delivered-pine', createdAt: now - 2 * DAY, nextTask: 'delivered task', projectId: PROJECT_A });
  addHandoff(store, { sessionId: 's-prior', loadToken: 'elsewhere-moth', createdAt: 4000, nextTask: 'other project', projectId: PROJECT_B });
  addHandoff(store, { sessionId: 's-prior', loadToken: 'nowhere-crow', createdAt: 5000, nextTask: 'no project', projectId: null });
  store.deliverHandoffByToken('delivered-pine', { sessionId: 's-consumer', loaderVersion: 'test', consumerSegment: 0 });
}

test('handoff/list answers a live session with its project\'s whole handoff catalog, its own handoffs included and other projects left out, and writes no delivery', async () => {
  const sessionId = 's-browse';
  const { ctx, handler } = mountHost({ sessions: [fakeSession({ id: sessionId, cwd: PROJECT_A })] });
  await settled();
  const store = getStore();
  seedCatalog(store, sessionId, Date.now());
  const deliveredAt = store.getHandoffByToken('delivered-pine').deliveredAt;
  const tokens = ['self-made-owl', 'sibling-fox', 'delivered-pine', 'elsewhere-moth', 'nowhere-crow'];
  const facts = () => ({
    bindings: tokens.map(token => store.getHandoffByToken(token)),
    loads: store._db.prepare('SELECT * FROM handoff_load ORDER BY handoff_id, session_id, loaded_at').all().map(row => ({ ...row })),
  });
  const before = facts();
  assert.equal(before.loads.length, 1, 'the fixture delivered one handoff');

  assert.deepEqual(await call(handler, 'handoff/list', { sessionId }), liveReply({
    items: [
      { loadToken: 'sibling-fox', age: '5 min ago', nextTask: null, deliveredAt: null },
      { loadToken: 'self-made-owl', age: '3h ago', nextTask: 'continue here', deliveredAt: null },
      { loadToken: 'delivered-pine', age: '2d ago', nextTask: 'delivered task', deliveredAt },
    ],
  }));
  assert.deepEqual(facts(), before);
  ctx.dispose();
});

test('handoff/list answers a session of a project with no handoff an empty catalog, and another project\'s handoffs do not leak into it', async () => {
  const { ctx, handler } = mountHost({
    sessions: [fakeSession({ id: 's-owner', cwd: PROJECT_A }), fakeSession({ id: 's-stranger', cwd: '/work/project-none' })],
  });
  await settled();
  seedCatalog(getStore(), 's-owner', Date.now());

  assert.deepEqual(await call(handler, 'handoff/list', { sessionId: 's-stranger' }), liveReply({ items: [] }));
  ctx.dispose();
});

test('handoff/list rejects the call when the store under a live watcher cannot answer, instead of answering an empty or wrapped catalog', async () => {
  const sessionId = 's-down';
  const { handler } = mountHost({ sessions: [fakeSession({ id: sessionId, cwd: PROJECT_A })] });
  await settled();
  seedCatalog(getStore(), sessionId, Date.now());
  // Closed under the watcher, which a host unload would archive into, so this case leaves the host mounted.
  closeStore(getStore());

  await assert.rejects(call(handler, 'handoff/list', { sessionId }), Error);
});

test('status and user-overrides answer the lamp key the express routes answer', async () => {
  const sessionId = 's-lamp';
  const { ctx, table, handler } = mountHost({
    sessions: [fakeSession({ id: sessionId })], snapshots: { [sessionId]: reusedCallIdAcrossSteps() },
  });
  await settled();
  const { watcher } = table.get(sessionId);
  const { rateLamp } = watcher.getStatus();
  assert.equal(rateLamp.reliable, true, 'the fixture measures');
  const zone = lampZone(rateLamp.br, { u: rateLamp.u, mf: rateLamp.mf });

  const status = await call(handler, 'status', { sessionId });
  assert.equal(status.value.state, 'live');
  assert.ok('lamp' in status.value.payload);
  assert.equal(status.value.payload.lamp, zone);

  const answered = await call(handler, 'user-overrides', { sessionId, overrides: {} });
  assert.ok('lamp' in answered.value.payload);
  assert.equal(answered.value.payload.lamp, zone);
  ctx.dispose();
});

test('a user-overrides call through the host\'s handler writes the caller\'s session on the host\'s events route', async () => {
  const sessionId = 's-publish';
  const { ctx, handler, routes } = mountHost({
    sessions: [fakeSession({ id: sessionId })], snapshots: { [sessionId]: reusedCallIdAcrossSteps() },
  });
  await settled();
  assert.equal(routes.length, 1);
  const response = await routes[0].fetch(new Request('http://localhost/api/session-watcher.events'));
  const reader = response.body.getReader();
  assert.equal(await nextFrame(reader), ': open\n\n');
  await call(handler, 'user-overrides', { sessionId, overrides: {} });
  assert.equal(await nextFrame(reader), `data: ${JSON.stringify({ sessionId })}\n\n`);
  ctx.dispose();
});

test('an unlisted endpoint, a payload without sessionId, a malformed overrides map and an invalid pricing input answer ok false with their codes', async () => {
  const sessionId = 's-errors';
  const { ctx, handler } = mountHost({
    sessions: [fakeSession({ id: sessionId })], snapshots: { [sessionId]: reusedCallIdAcrossSteps() },
  });
  await settled();
  const overridesMessage = 'Body must contain { overrides: { path: "include"|"exclude" } }';

  assert.deepEqual(await call(handler, 'stream', { sessionId }), failure('unknown_endpoint', 'unknown endpoint stream'));
  assert.deepEqual(await call(handler, 'status', {}), failure('invalid_body', 'Body must contain { sessionId: string }'));
  assert.deepEqual(await call(handler, 'status', { sessionId: 7 }), failure('invalid_body', 'Body must contain { sessionId: string }'));
  assert.deepEqual(await call(handler, 'user-overrides', { sessionId, overrides: ['/repo/src/a.js'] }),
    failure('invalid_body', overridesMessage));
  assert.deepEqual(await call(handler, 'preview', { sessionId }), failure('invalid_body', overridesMessage));
  assert.deepEqual(await call(handler, 'pricing/save', { sessionId, readPrice: 'cheap', writePrice: 2 }),
    failure('invalid_input', 'readPrice and writePrice must be finite numbers'));
  ctx.dispose();
});

test('a pricing write under one session\'s epoch model restamps every live watcher of that model and leaves another model\'s watcher unchanged', async () => {
  const proLog = logUnder({ model: PRO_MODEL });
  const { ctx, table, handler } = mountHost({
    sessions: ['s-pro-a', 's-pro-b', 's-flash'].map(id => fakeSession({ id })),
    snapshots: { 's-pro-a': proLog, 's-pro-b': proLog, 's-flash': logUnder({ model: FLASH_MODEL }), 's-pro-late': proLog },
  });
  await settled();
  const ratioOf = sessionId => table.get(sessionId).watcher.getStatus().cRatio;
  const proRow = modelPolicyFor(PRO_MODEL, DEFAULT_CACHE_TTL).cRatio;
  const flashRow = modelPolicyFor(FLASH_MODEL, DEFAULT_CACHE_TTL).cRatio;
  assert.deepEqual(['s-pro-a', 's-pro-b', 's-flash'].map(ratioOf), [proRow, proRow, flashRow]);

  const saved = await call(handler, 'pricing/save', { sessionId: 's-pro-a', readPrice: 1, writePrice: 7 });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.payload.effective.source, 'saved');
  assert.deepEqual(['s-pro-a', 's-pro-b', 's-flash'].map(ratioOf), [7, 7, flashRow]);

  ctx.emit('session/created', fakeSession({ id: 's-pro-late' }));
  await settled();
  assert.equal(ratioOf('s-pro-late'), 7, 'a watcher composed after the write resolves the override');

  const deleted = await call(handler, 'pricing/delete', { sessionId: 's-pro-b' });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.payload.effective.source, 'model_default');
  assert.deepEqual(['s-pro-a', 's-pro-b', 's-pro-late', 's-flash'].map(ratioOf), [proRow, proRow, proRow, flashRow]);
  ctx.dispose();
});

// A handler over `table` whose `publish` records each session id it is handed.
function publishingHandler(table) {
  const published = [];
  const handler = createRpcHandler({ table, store: getStore(), publish: sessionId => published.push(sessionId) });
  return { handler, published };
}

test('a pricing save publishes only the live sessions whose read policies changed', async () => {
  const proLog = logUnder({ model: PRO_MODEL });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const snapshots = { 's-pro-a': proLog, 's-pro-b': proLog, 's-flash': logUnder({ model: FLASH_MODEL }) };
  const { ctx, table } = mountHost({
    sessions: ['s-pro-a', 's-pro-b', 's-flash', 's-boot'].map(id => fakeSession({ id })),
    readSession: sessionId => (sessionId === 's-boot'
      ? pending : Promise.resolve({ session: {}, inheritedEventCount: 0, events: snapshots[sessionId] })),
  });
  await settled();
  assert.equal(table.get('s-boot').state, 'bootstrapping');
  const { handler, published } = publishingHandler(table);

  assert.equal((await call(handler, 'pricing/save', { sessionId: 's-pro-a', readPrice: 1, writePrice: 7 })).ok, true);
  assert.deepEqual(published, ['s-pro-a', 's-pro-b'], 'the watchers of the saved model, not the other model\'s or a bootstrapping one');

  published.length = 0;
  assert.equal((await call(handler, 'pricing/save', { sessionId: 's-pro-b', readPrice: 1, writePrice: 7 })).ok, true);
  assert.deepEqual(published, [], 'a save that changes no read policy publishes nothing');

  assert.equal((await call(handler, 'pricing/delete', { sessionId: 's-pro-b' })).ok, true);
  assert.deepEqual(published, ['s-pro-a', 's-pro-b']);
  release({ session: {}, inheritedEventCount: 0, events: [] });
  await settled();
  ctx.dispose();
});

test('a successful user-overrides publishes the caller\'s session once and an invalid body publishes nothing', async () => {
  const { ctx, table } = mountHost({
    sessions: ['s-caller', 's-bystander'].map(id => fakeSession({ id })),
    snapshots: { 's-caller': reusedCallIdAcrossSteps(), 's-bystander': reusedCallIdAcrossSteps() },
  });
  await settled();
  const { handler, published } = publishingHandler(table);

  assert.equal((await call(handler, 'user-overrides', { sessionId: 's-caller', overrides: [] })).ok, false);
  assert.deepEqual(published, [], 'the invalid body publishes nothing');
  assert.equal((await call(handler, 'user-overrides', { sessionId: 's-caller', overrides: { '/repo/src/a.js': 'exclude' } })).ok, true);
  assert.deepEqual(published, ['s-caller']);
  ctx.dispose();
});

test('preview and the read endpoints publish nothing', async () => {
  const sessionId = 's-reader';
  const { ctx, table } = mountHost({
    sessions: [fakeSession({ id: sessionId })], snapshots: { [sessionId]: reusedCallIdAcrossSteps() },
  });
  await settled();
  const { handler, published } = publishingHandler(table);

  for (const endpoint of ['status', 'history', 'buckets', 'turn/browse', 'pricing', 'handoff/list']) {
    assert.equal((await call(handler, endpoint, { sessionId })).ok, true, endpoint);
  }
  assert.equal((await call(handler, 'preview', { sessionId, overrides: { '/repo/src/a.js': 'exclude' } })).ok, true);
  assert.equal((await call(handler, 'status', { sessionId: 's-nobody' })).ok, true);
  assert.deepEqual(published, []);
  ctx.dispose();
});

test('bucket/file answers the held lines of a held path as the host\'s working tree reads them, and a failure for a body or a path it cannot serve', async () => {
  const sessionId = 's-file';
  const cwd = join(dir, 'repo');
  writeFilesUnder(cwd, REUSED_CALL_ID_FILES);
  const { ctx, handler } = mountHost({
    sessions: [fakeSession({ id: sessionId, cwd })], snapshots: { [sessionId]: reusedCallIdAcrossSteps() },
  });
  await settled();
  const held = join(cwd, 'src/b.js');
  const file = path => call(handler, 'bucket/file', { sessionId, path });

  assert.deepEqual(await file(held), liveReply({
    path: held, total: 2,
    runs: [{ offset: 1, lines: [{ number: 1, text: 'export const b = 2;' }, { number: 2, text: 'export default b;' }] }],
  }));
  const notHeld = failure('not_held', 'The path is not held in the current context.');
  assert.deepEqual(await file(join(cwd, 'src/c.js')), notHeld);
  assert.deepEqual(await file('skill:tdd'), notHeld);
  const invalid = failure('invalid_body', 'Body must contain { path: string }');
  assert.deepEqual(await call(handler, 'bucket/file', { sessionId }), invalid);
  assert.deepEqual(await file(7), invalid);

  writeFileSync(held, 'x'.repeat(ATTRIBUTION_LIMITS.fileBytes + 1));
  assert.deepEqual(await file(held), liveReply({ path: held, reason: 'too-large' }));
  rmSync(held);
  assert.deepEqual(await file(held), liveReply({ path: held, reason: 'missing' }), 'a held file the disk lost is held and unreadable');
  ctx.dispose();
});

test('a pricing write with no epoch model answers no_model', async () => {
  const sessionId = 's-unmeasured';
  const { ctx, table, handler } = mountHost({ sessions: [fakeSession({ id: sessionId })] });
  await settled();
  assert.equal(table.get(sessionId).state, 'live');
  const noModel = failure('no_model', 'Model not yet detected; retry after first API call');
  assert.deepEqual(await call(handler, 'pricing/save', { sessionId, readPrice: 1, writePrice: 7 }), noModel);
  assert.deepEqual(await call(handler, 'pricing/delete', { sessionId }), noModel);
  assert.equal(loadPricingOverride(''), null, 'nothing was saved under the empty key');
  ctx.dispose();
});

test('a watcher whose ignore matcher throws reports each refresh diagnostic on stderr and the save still restamps the others', async (t) => {
  const lines = captureStderr(t);
  const log = reusedCallIdAcrossSteps();
  // The host attributes by the lines a call shows, so each session's directory holds the files the log reads; the
  // clean session then has resources to resolve and reports none.
  const throwsCwd = join(dir, 'throws');
  const cleanCwd = join(dir, 'clean');
  for (const cwd of [throwsCwd, cleanCwd]) writeFilesUnder(cwd, REUSED_CALL_ID_FILES);
  // Armed once both are live: a throw while the log applies fails the watcher on the frame path instead.
  let broken = false;
  const throwing = () => {
    if (broken) throw new Error('matcher broke');
    return false;
  };
  const { ctx, table, handler } = mountHost({
    sessions: [fakeSession({ id: 's-throws', cwd: throwsCwd }), fakeSession({ id: 's-clean', cwd: cleanCwd })],
    snapshots: { 's-throws': log, 's-clean': log },
    loadIsIgnored: cwd => (cwd === throwsCwd ? throwing : null),
  });
  await settled();
  for (const sessionId of ['s-throws', 's-clean']) assert.equal(table.get(sessionId).state, 'live', sessionId);
  broken = true;
  const before = lines.length;

  const saved = await call(handler, 'pricing/save', { sessionId: 's-clean', readPrice: 1, writePrice: 7 });
  assert.equal(saved.ok, true);
  for (const sessionId of ['s-throws', 's-clean']) assert.equal(table.get(sessionId).watcher.getStatus().cRatio, 7, sessionId);

  const written = lines.slice(before);
  const failedLine = 's-throws [measurement-engine] resource_policy_failed: resource policy resolver threw: matcher broke';
  assert.deepEqual(written.filter(line => line.includes(' resource_policy_failed: ')), [failedLine, failedLine],
    'one line per file the log reads');
  assert.deepEqual(written.filter(line => line.includes(' resource_policy_invalid: ')), ['a', 'b'].map(file =>
    `s-throws [measurement-engine] resource_policy_invalid: resource policy for ${throwsCwd}/src/${file}.js is unusable; defaulting to selected`));
  assert.deepEqual(written.filter(line => line.startsWith('s-clean ')), []);
  ctx.dispose();
});

test('the connection registers the channel once', async () => {
  const sessionId = 's-channel';
  const { ctx, handled } = mountHost({ sessions: [fakeSession({ id: sessionId })] });
  await settled();
  assert.deepEqual(handled.map(each => each.channel), ['/session-watcher']);
  assert.equal((await call(handled[0].handler, 'status', { sessionId })).value.state, 'live');
  ctx.dispose();
});

// ── On-demand bootstrap ──────────────────────────────────────────────────────

const ENDPOINTS = ['status', 'history', 'buckets', 'bucket/file', 'turn/browse', 'user-overrides', 'preview', 'pricing', 'pricing/save', 'pricing/delete', 'handoff/list'];

// A persisted session's listing record, as `sessionQuery.listSessions` answers it.
const persisted = (id, over = {}) => ({ header: header({ id, ...over }), live: false, persisted: true });

// A listing that answers `records` and counts its calls.
function countingListing(records) {
  const listing = () => { listing.calls += 1; return records; };
  listing.calls = 0;
  return listing;
}

// A snapshot read that records each id it is handed and answers `events`.
function recordingReader(events = reusedCallIdAcrossSteps()) {
  const reads = [];
  const readSession = async (sessionId) => { reads.push(sessionId); return { session: {}, inheritedEventCount: 0, events }; };
  return { reads, readSession };
}

const bootstrapping = { ok: true, value: { state: 'bootstrapping' } };
const unobserved = { ok: true, value: { state: 'unobserved' } };

// Rows archived under `sessionId`, read from the store file once the host has closed it.
function archivedSources(sessionId) {
  const store = openStore(join(dir, 'store.sqlite'));
  try {
    return store._db.prepare('SELECT segment, capture_source FROM profile WHERE session_id = ? ORDER BY segment')
      .all(sessionId).map(row => ({ ...row }));
  } finally {
    closeStore(store);
  }
}

// The next frame of an events stream, or undefined when none is written within one macrotask hop.
async function nextFrame(reader) {
  const next = await Promise.race([reader.read(), settled().then(() => ({ value: undefined }))]);
  return next.value && new TextDecoder().decode(next.value);
}

test('an unobserved session the persisted listing holds is ensured once and answers bootstrapping, then live once its snapshot installs', async () => {
  const listing = countingListing([persisted('s-old')]);
  const { reads, readSession } = recordingReader();
  const { ctx, table, handler } = mountHost({ listSessions: listing, readSession });

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-old' }), bootstrapping);
  assert.deepEqual(reads, ['s-old']);
  await settled();
  assert.equal((await call(handler, 'status', { sessionId: 's-old' })).value.state, 'live');
  assert.equal(table.get('s-old').state, 'live');
  assert.equal(listing.calls, 1, 'an entry the table holds is not listed again');
  assert.deepEqual(reads, ['s-old'], 'and is not read again');
  ctx.dispose();
});

test('an unobserved session the listing lacks answers unobserved and leaves no entry', async () => {
  const listing = countingListing([persisted('s-other')]);
  const { reads, readSession } = recordingReader();
  const { ctx, table, handler } = mountHost({ listSessions: listing, readSession });

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-ghost' }), unobserved);
  assert.equal(listing.calls, 1);
  assert.deepEqual(table.get('s-ghost'), { state: 'unobserved' });
  assert.deepEqual(table.get('s-other'), { state: 'unobserved' }, 'another listed session is not ensured');
  assert.deepEqual(reads, []);
  ctx.dispose();
});

test('two concurrent requests for one persisted session compose one watcher, read one snapshot and both answer bootstrapping', async () => {
  let releaseListing;
  const listed = new Promise((resolve) => { releaseListing = resolve; });
  let releaseSnapshot;
  const snapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  let composes = 0;
  const reads = [];
  const { ctx, handler } = mountHost({
    listSessions: () => listed,
    readSession: (sessionId) => { reads.push(sessionId); return snapshot; },
    loadIsIgnored: () => { composes += 1; return null; },
  });

  const first = call(handler, 'status', { sessionId: 's-twice' });
  const second = call(handler, 'history', { sessionId: 's-twice' });
  releaseListing([persisted('s-twice')]);
  assert.deepEqual(await Promise.all([first, second]), [bootstrapping, bootstrapping]);
  assert.equal(composes, 1);
  assert.deepEqual(reads, ['s-twice']);

  releaseSnapshot({ session: {}, inheritedEventCount: 0, events: reusedCallIdAcrossSteps() });
  await settled();
  assert.equal((await call(handler, 'status', { sessionId: 's-twice' })).value.state, 'live');
  ctx.dispose();
});

test('a listing that rejects and a composition that throws answer ok false under handler_failed, write one stderr line and leave no entry, and the next request lists again', async (t) => {
  const lines = captureStderr(t);
  let listings = 0;
  const listSessions = () => {
    listings += 1;
    if (listings === 1) return Promise.reject(new Error('listing broke'));
    return [persisted('s-broken')];
  };
  let composes = 0;
  const loadIsIgnored = () => {
    composes += 1;
    if (composes === 1) throw new Error('compose broke');
    return null;
  };
  const { ctx, table, handler } = mountHost({ listSessions, loadIsIgnored });

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-broken' }), failure('handler_failed', 'listing broke'));
  assert.deepEqual(table.get('s-broken'), { state: 'unobserved' });
  assert.deepEqual(await call(handler, 'status', { sessionId: 's-broken' }), failure('handler_failed', 'compose broke'));
  assert.deepEqual(table.get('s-broken'), { state: 'unobserved' });
  assert.deepEqual(lines.filter(line => line.startsWith('s-broken ')), [
    's-broken [dsh-host] handler_failed: listing broke',
    's-broken [dsh-host] handler_failed: compose broke',
  ]);

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-broken' }), bootstrapping);
  assert.equal(listings, 3, 'each request after a failure lists again');
  await settled();
  ctx.dispose();
});

test('a listing that settles after the host unloads answers handler_failed and leaves the retired table empty', async (t) => {
  const lines = captureStderr(t);
  let releaseListing;
  const listed = new Promise((resolve) => { releaseListing = resolve; });
  const { reads, readSession } = recordingReader();
  const { ctx, table, handler } = mountHost({ listSessions: () => listed, readSession });

  const answering = call(handler, 'status', { sessionId: 's-late' });
  ctx.dispose();
  releaseListing([persisted('s-late')]);
  assert.deepEqual(await answering, failure('handler_failed', 'the watcher table is closed'));
  assert.deepEqual(table.get('s-late'), { state: 'unobserved' });
  assert.deepEqual(reads, []);
  assert.equal(getLiveLedger('s-late'), null);
  assert.deepEqual(lines.filter(line => line.startsWith('s-late ')), ['s-late [dsh-host] handler_failed: the watcher table is closed']);
});

test('every endpoint takes the on-demand path, and an unlisted endpoint or a body without a sessionId never lists', async () => {
  const ids = ENDPOINTS.map(endpoint => `s-${endpoint.replace('/', '-')}`);
  const listing = countingListing([...ids.map(id => persisted(id)), persisted('s-unlisted-endpoint')]);
  const { reads, readSession } = recordingReader();
  const { ctx, handler } = mountHost({ listSessions: listing, readSession });

  for (const [index, endpoint] of ENDPOINTS.entries()) {
    assert.deepEqual(await call(handler, endpoint, { sessionId: ids[index] }), bootstrapping, endpoint);
  }
  assert.equal(listing.calls, ENDPOINTS.length);
  assert.deepEqual(reads, ids);

  assert.deepEqual(await call(handler, 'stream', { sessionId: 's-unlisted-endpoint' }), failure('unknown_endpoint', 'unknown endpoint stream'));
  assert.deepEqual(await call(handler, 'status', {}), failure('invalid_body', 'Body must contain { sessionId: string }'));
  assert.equal(listing.calls, ENDPOINTS.length, 'neither listed');
  await settled();
  ctx.dispose();
});

test('a bootstrapping or failed entry answers its state without listing', async (t) => {
  captureStderr(t);
  const listing = countingListing([persisted('s-boot'), persisted('s-refused')]);
  const { ctx, handler } = mountHost({
    sessions: [fakeSession({ id: 's-boot' }), fakeSession({ id: 's-refused' })],
    listSessions: listing,
    readSession: sessionId => (sessionId === 's-refused' ? Promise.reject(new Error('read refused')) : new Promise(() => {})),
  });
  await settled();

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-boot' }), bootstrapping);
  assert.deepEqual(await call(handler, 'status', { sessionId: 's-refused' }), {
    ok: true,
    value: { state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'read refused' } },
  });
  assert.equal(listing.calls, 0);
  ctx.dispose();
});

test('the host lists on the sessionQuery service and matches a record by its header id', async () => {
  const cwds = [];
  const { reads, readSession } = recordingReader();
  const { ctx, handler } = mountHost({
    listSessions: () => [persisted('s-first'), persisted('s-target', { cwd: '/target' }), persisted('s-last')],
    readSession,
    loadIsIgnored: (cwd) => { cwds.push(cwd); return null; },
  });

  assert.deepEqual(await call(handler, 'status', { sessionId: 's-target' }), bootstrapping);
  assert.deepEqual(reads, ['s-target']);
  assert.deepEqual(cwds, ['/target'], 'the watcher is composed over the matched record\'s header');
  await settled();
  ctx.dispose();
});

test('an on-demand watcher archives as dsh-replay when the host unloads', async () => {
  const { ctx, table, handler } = mountHost({
    listSessions: () => [persisted('s-settled')], snapshots: { 's-settled': reusedCallIdAcrossSteps() },
  });
  assert.deepEqual(await call(handler, 'status', { sessionId: 's-settled' }), bootstrapping);
  await settled();
  assert.equal(table.get('s-settled').state, 'live');

  ctx.dispose();
  assert.deepEqual(archivedSources('s-settled'), [{ segment: 0, capture_source: 'dsh-replay' }]);
});

test('a session disposed while read is rebuilt on its next request: its removal reaches an open stream, the request answers bootstrapping, and the install reaches the stream before a request answers live', async () => {
  const sessionId = 's-viewed';
  const session = fakeSession({ id: sessionId });
  const { ctx, handler, routes } = mountHost({
    sessions: [session], listSessions: () => [persisted(sessionId)], snapshots: { [sessionId]: reusedCallIdAcrossSteps() },
  });
  await settled();
  assert.equal((await call(handler, 'status', { sessionId })).value.state, 'live');
  const reader = (await routes[0].fetch(new Request('http://localhost/api/session-watcher.events'))).body.getReader();
  assert.equal(await nextFrame(reader), ': open\n\n');
  const signal = `data: ${JSON.stringify({ sessionId })}\n\n`;

  ctx.emit('session/disposed', session);
  assert.equal(await nextFrame(reader), signal, 'the removal reaches the stream');
  assert.deepEqual(await call(handler, 'status', { sessionId }), bootstrapping);
  assert.equal(await nextFrame(reader), signal, 'the install reaches the stream');
  assert.equal((await call(handler, 'status', { sessionId })).value.state, 'live');
  ctx.dispose();
});

// ── The session mode endpoints ───────────────────────────────────────────────

const modeProjection = innerModeProjection({ pluginRecordOf: modeKit.pluginRecordOf });
const modeOf = session => session.snapshotEvents().reduce((state, event) => modeProjection.apply(state, event), modeProjection.init());

// The mode access the host publishes over `sessions`, built from the mode's own selection and projection, with no stored log behind it.
function modeAccessOver(sessions) {
  return createModeAccess({
    sessionOf: id => sessions.find(session => session.id === id),
    readMode: modeOf,
    select: createModeSelection({ agents: fakeAgents(), appendPluginRecord: modeKit.appendPluginRecord }),
    readStored: async () => undefined,
  });
}

// A handler whose table answers `entry` for every session and lists nothing, so any use of the measurement entry shows as a listing or a state.
function modeHandler({ innerMode, entry = { state: 'bootstrapping' }, publish } = {}) {
  const listed = [];
  const handler = createRpcHandler({
    table: { get: () => entry, live: () => [] },
    store: null,
    publish,
    innerMode,
    resolvePersisted: async (sessionId) => { listed.push(sessionId); return null; },
  });
  return { handler, listed };
}

const modeRecords = session => session.snapshotEvents().filter(event => event.type === MODE_RECORD_TYPE).map(event => event.data);
const unavailable = failure('inner_mode_unavailable', 'The inner compaction mode is not available in this host.');

test('inner-mode answers the session\'s mode and lock and inner-mode/select appends its record, each before the measurement entry: a bootstrapping or failed measurement changes neither answer and nothing is listed', async () => {
  for (const entry of [{ state: 'bootstrapping' }, { state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'x' } }, { state: 'unobserved' }]) {
    const session = newSession(`s-mode-${entry.state}`);
    const { handler, listed } = modeHandler({ innerMode: () => modeAccessOver([session]), entry });
    assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'off', locked: false } }, entry.state);
    assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} }, entry.state);
    assert.deepEqual(modeRecords(session), [{ v: 1, enabled: true }]);
    assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: false } });
    assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled: false }), { ok: true, value: {} });
    assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'off', locked: false } });
    assert.deepEqual(listed, [], 'the persisted listing is the measurement entry\'s');
  }
});

test('with no published reader both mode endpoints answer inner_mode_unavailable at once, whether the host has no mode, the reader was withdrawn or the session is neither live nor stored', async () => {
  const session = newSession('s-no-reader');
  let access = null;
  const { handler } = modeHandler({ innerMode: () => access });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), unavailable);
  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled: true }), unavailable);
  access = modeAccessOver([session]);
  assert.equal((await call(handler, 'inner-mode', { sessionId: session.id })).ok, true);
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: 's-not-live' }), unavailable, 'a session the host does not hold');
  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: 's-not-live', enabled: true }), unavailable);
  access = null;
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), unavailable, 'the withdrawn reader');
  assert.deepEqual(modeRecords(session), []);
  const { handler: bare } = modeHandler();
  assert.deepEqual(await call(bare, 'inner-mode', { sessionId: session.id }), unavailable, 'a handler built without a mode');
});

test('inner-mode/select refuses a locked session and a body whose enabled is not a boolean, appending no record and publishing nothing', async () => {
  const published = [];
  const session = newSession('s-refusals');
  const { handler } = modeHandler({ innerMode: () => modeAccessOver([session]), publish: id => published.push(id) });
  const invalid = failure('invalid_body', 'Body must contain { sessionId: string, enabled: boolean }');
  for (const enabled of [undefined, 'true', 1, null]) {
    assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled }), invalid, String(enabled));
  }
  assert.deepEqual(await call(handler, 'inner-mode/select', { enabled: true }), failure('invalid_body', 'Body must contain { sessionId: string }'));
  assert.deepEqual(modeRecords(session), []);
  session.append('turn/start', { turn: 1 });
  const locked = failure('inner_mode_locked', 'The inner compaction mode can no longer be chosen once the session has started a turn.');
  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled: true }), locked);
  assert.deepEqual(modeRecords(session), []);
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'off', locked: true } });
  assert.deepEqual(published, [], 'the mode\'s notification is the session/event listener\'s, not the endpoint\'s');
});

test('the selection runs its lock check and its append in the stretch of the call, before the handler yields, so a turn/start appended right after the call comes after the record', async () => {
  const session = newSession('s-sync');
  const { handler } = modeHandler({ innerMode: () => modeAccessOver([session]) });
  const pending = call(handler, 'inner-mode/select', { sessionId: session.id, enabled: true });
  session.append('turn/start', { turn: 1 });
  assert.deepEqual(await pending, { ok: true, value: {} });
  assert.deepEqual(modeOf(session), { mode: 'on', locked: true });
});

// ── The inner monitor endpoint ───────────────────────────────────────────────

// A handler whose table answers `entry` for every session and lists nothing, over the monitor access `innerMonitor` publishes, so any use of the measurement entry shows as a listing or a state.
function monitorHandler({ innerMonitor, entry = { state: 'bootstrapping' }, publish } = {}) {
  const listed = [];
  const handler = createRpcHandler({
    table: { get: () => entry, live: () => [] },
    store: null,
    publish,
    innerMonitor,
    resolvePersisted: async (sessionId) => { listed.push(sessionId); return null; },
  });
  return { handler, listed };
}

// A row as the read side states it, in the shape the wire carries.
const ROW = {
  id: 7, revision: 12, status: 'committed', startedAt: 1_700_000_000_000, endedAt: 1_700_000_005_000,
  range: { first: 3, last: 5, count: 3 }, reason: null, slots: 3,
  call: {
    state: 'received', endedAt: 1_700_000_004_000, finish: 'stop', thrown: null, input: 'the prompt', output: '["a","b","c"]',
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 },
  },
};
// The access the host publishes, as far as the channel reads it: the rows of a session the host holds, undefined for any other.
const monitorAccessOf = (rows = sessionId => (sessionId === 's-held' ? { attempts: [ROW] } : undefined)) => ({ rows });
const monitorUnavailable = failure('inner_monitor_unavailable', 'The inner compaction monitor is not available in this host.');

test('inner-monitor answers the access\'s rows before the measurement entry: a bootstrapping, failed or unobserved measurement changes nothing, nothing is listed and nothing is published', async () => {
  for (const entry of [{ state: 'bootstrapping' }, { state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'x' } }, { state: 'unobserved' }, { state: 'live' }]) {
    const published = [];
    const { handler, listed } = monitorHandler({ innerMonitor: () => monitorAccessOf(), entry, publish: id => published.push(id) });
    assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-held' }), { ok: true, value: { attempts: [ROW] } }, entry.state);
    assert.deepEqual(listed, [], `${entry.state}: the persisted listing is the measurement entry's`);
    assert.deepEqual(published, [], `${entry.state}: a read signals nothing`);
  }
});

test('inner-monitor awaits the access, so a rows read that resolves later answers its value', async () => {
  const { handler } = monitorHandler({ innerMonitor: () => monitorAccessOf(async () => ({ attempts: [ROW] })) });
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-held' }), { ok: true, value: { attempts: [ROW] } });
});

test('with no published access, or an access that holds no instance of the session, inner-monitor answers inner_monitor_unavailable at once, whether the host has no monitor, the access was withdrawn or the session is not live', async () => {
  let access = null;
  const { handler, listed } = monitorHandler({ innerMonitor: () => access });
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-held' }), monitorUnavailable);
  access = monitorAccessOf();
  assert.equal((await call(handler, 'inner-monitor', { sessionId: 's-held' })).ok, true);
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-not-live' }), monitorUnavailable, 'a session the host does not hold');
  access = null;
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-held' }), monitorUnavailable, 'the withdrawn access');
  const { handler: bare } = monitorHandler();
  assert.deepEqual(await call(bare, 'inner-monitor', { sessionId: 's-held' }), monitorUnavailable, 'a handler built without a monitor');
  assert.deepEqual(listed, []);
});

test('a rows read that throws or rejects answers inner_monitor_read_failed with the error\'s message and writes one stderr line under the session, and the next read is made again', async (t) => {
  const lines = captureStderr(t);
  let outcome = () => { throw new Error('the projection could not be read'); };
  const { handler } = monitorHandler({ innerMonitor: () => monitorAccessOf(() => outcome()) });
  for (const [why, next, message] of [
    ['a synchronous throw', () => { throw new Error('the projection could not be read'); }, 'the projection could not be read'],
    ['a rejection', async () => { throw new Error('the registry refused'); }, 'the registry refused'],
    ['a thrown text', () => { throw 'plain text'; }, 'plain text'],
    ['a rejection with a text', () => Promise.reject('rejected text'), 'rejected text'],
  ]) {
    outcome = next;
    lines.length = 0;
    await assert.doesNotReject(call(handler, 'inner-monitor', { sessionId: 's-held' }), why);
    assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-held' }), failure('inner_monitor_read_failed', message), why);
    assert.deepEqual(lines, [`s-held [dsh-host] inner_monitor_read_failed: ${message}`, `s-held [dsh-host] inner_monitor_read_failed: ${message}`], why);
  }
  outcome = () => ({ attempts: [ROW] });
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-held' }), { ok: true, value: { attempts: [ROW] } }, 'a failure is not kept');
});

test('inner-monitor needs a string sessionId before it reads, and the access is not consulted for a body it refuses', async () => {
  const reads = [];
  const { handler } = monitorHandler({ innerMonitor: () => monitorAccessOf((sessionId) => { reads.push(sessionId); return { attempts: [] }; }) });
  const invalid = failure('invalid_body', 'Body must contain { sessionId: string }');
  assert.deepEqual(await call(handler, 'inner-monitor', {}), invalid);
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 7 }), invalid);
  assert.deepEqual(await call(handler, 'inner-monitor', undefined), invalid);
  assert.deepEqual(reads, []);
});

// The detail endpoints, each with the access method it reads, a body that addresses a held session's attempt (and slot) and the arguments the method then receives.
const DETAIL_ENDPOINTS = [
  ['inner-monitor/call', 'call', { attempt: 7 }, [7]],
  ['inner-monitor/slots', 'slots', { attempt: 7 }, [7]],
  ['inner-monitor/slot', 'slot', { attempt: 7, slot: 11 }, [7, 11]],
  ['inner-monitor/handoff', 'handoff', { handoff: 21 }, [21]],
  ['inner-monitor/settlement', 'settlement', { handoff: 21 }, [21]],
];
const CALL_PAYLOAD = {
  row: ROW, ids: { start: 7, call: 9, end: null, carrier: 12 }, request: { options: {} }, response: null, usage: null, timing: { attempt: {}, call: {} },
};
const SLOTS_PAYLOAD = { slots: [{ key: 3, turn: null, step: null, input: 'the source', output: 'the summary' }] };
const SLOT_PAYLOAD = { key: 3, seqs: [3], turn: null, step: null, c: 'the summary', events: [] };
const HANDOFF_PAYLOAD = {
  row: { id: 21, type: 'load', token: 'amber-falcon' }, summary: 'the summary', files: [], lineage: null, turnPage: null, turns: [], followUp: null,
};
const SETTLEMENT_PAYLOAD = { calls: [{ seq: 4, stock: 440, post: false }, { seq: 9, stock: null, post: true }] };
const DETAIL_PAYLOADS = { call: CALL_PAYLOAD, slots: SLOTS_PAYLOAD, slot: SLOT_PAYLOAD, handoff: HANDOFF_PAYLOAD, settlement: SETTLEMENT_PAYLOAD };
const notCommitted = failure('inner_monitor_not_committed', 'The inner compaction attempt has no committed seal, so it has no slots.');

// The access as far as the detail endpoints read it: each method records its arguments in `calls` and answers `answer(method)` for the held session, undefined for any other.
function detailAccessOf(answer, calls = []) {
  const method = name => (sessionId, ...addresses) => {
    calls.push([name, sessionId, ...addresses]);
    return sessionId === 's-held' ? answer(name) : undefined;
  };
  return { rows: method('rows'), call: method('call'), slots: method('slots'), slot: method('slot'), handoff: method('handoff'), settlement: method('settlement') };
}

test('the detail endpoints answer the access\'s payload for the addresses in the body, awaited, before the measurement entry: a bootstrapping, failed or unobserved measurement changes nothing, nothing is listed and nothing is published', async () => {
  for (const entry of [{ state: 'bootstrapping' }, { state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'x' } }, { state: 'unobserved' }, { state: 'live' }]) {
    for (const [endpoint, method, address, args] of DETAIL_ENDPOINTS) {
      const calls = [];
      const published = [];
      const { handler, listed } = monitorHandler({
        innerMonitor: () => detailAccessOf(name => Promise.resolve(DETAIL_PAYLOADS[name]), calls), entry, publish: id => published.push(id),
      });

      assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...address }), { ok: true, value: DETAIL_PAYLOADS[method] }, `${endpoint} ${entry.state}`);
      assert.deepEqual(calls, [[method, 's-held', ...args]], `${endpoint}: the access receives the session id and the addresses`);
      assert.deepEqual([listed, published], [[], []], `${endpoint} ${entry.state}: nothing listed, nothing published`);
    }
  }
});

test('with no published access, or an access that holds no instance of the session, each detail endpoint answers inner_monitor_unavailable at once, whether the host has no monitor, the access was withdrawn or the session is not live', async () => {
  for (const [endpoint, , address] of DETAIL_ENDPOINTS) {
    let access = null;
    const { handler, listed } = monitorHandler({ innerMonitor: () => access });
    assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...address }), monitorUnavailable, `${endpoint}: no access`);
    access = detailAccessOf(name => DETAIL_PAYLOADS[name]);
    assert.equal((await call(handler, endpoint, { sessionId: 's-held', ...address })).ok, true, endpoint);
    assert.deepEqual(await call(handler, endpoint, { sessionId: 's-not-live', ...address }), monitorUnavailable, `${endpoint}: a session the host does not hold`);
    access = null;
    assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...address }), monitorUnavailable, `${endpoint}: the withdrawn access`);
    const { handler: bare } = monitorHandler();
    assert.deepEqual(await call(bare, endpoint, { sessionId: 's-held', ...address }), monitorUnavailable, `${endpoint}: a handler built without a monitor`);
    assert.deepEqual(listed, []);
  }
});

test('slots and slot map the access\'s closed not_committed outcome to inner_monitor_not_committed, a known attempt without a seal told from an unavailable monitor, and write no line for it', async (t) => {
  const lines = captureStderr(t);
  for (const [endpoint, , address] of DETAIL_ENDPOINTS.filter(([, method]) => method === 'slots' || method === 'slot')) {
    const { handler } = monitorHandler({ innerMonitor: () => detailAccessOf(() => ({ kind: 'not_committed' })) });
    const reply = await call(handler, endpoint, { sessionId: 's-held', ...address });
    assert.deepEqual(reply, notCommitted, endpoint);
    assert.notDeepEqual(reply, monitorUnavailable, endpoint);
  }
  assert.deepEqual(lines, []);
});

test('a detail read that throws or rejects answers inner_monitor_read_failed with the error\'s message and writes one stderr line under the session, and the next read is made again', async (t) => {
  const lines = captureStderr(t);
  for (const [endpoint, method, address] of DETAIL_ENDPOINTS) {
    let outcome = () => { throw new Error('the log could not be read'); };
    const { handler } = monitorHandler({ innerMonitor: () => detailAccessOf(() => outcome()) });
    for (const [why, next, message] of [
      ['a synchronous throw', () => { throw new Error('the log could not be read'); }, 'the log could not be read'],
      ['a rejection', async () => { throw new Error('the monitor holds no attempt 7'); }, 'the monitor holds no attempt 7'],
      ['a thrown text', () => { throw 'plain text'; }, 'plain text'],
      ['a rejection with a text', () => Promise.reject('rejected text'), 'rejected text'],
    ]) {
      outcome = next;
      lines.length = 0;
      await assert.doesNotReject(call(handler, endpoint, { sessionId: 's-held', ...address }), `${endpoint} ${why}`);
      assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...address }), failure('inner_monitor_read_failed', message), `${endpoint} ${why}`);
      assert.deepEqual(lines, [`s-held [dsh-host] inner_monitor_read_failed: ${message}`, `s-held [dsh-host] inner_monitor_read_failed: ${message}`], `${endpoint} ${why}`);
    }
    outcome = () => DETAIL_PAYLOADS[method];
    assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...address }), { ok: true, value: DETAIL_PAYLOADS[method] }, `${endpoint}: a failure is not kept`);
  }
});

test('the detail endpoints need a string sessionId and a non-negative safe integer for each address before they read, and the access is not consulted for a body they refuse', async () => {
  const calls = [];
  const { handler } = monitorHandler({ innerMonitor: () => detailAccessOf(name => DETAIL_PAYLOADS[name], calls) });
  const sessionless = failure('invalid_body', 'Body must contain { sessionId: string }');
  const invalid = {
    'inner-monitor/call': failure('invalid_body', 'Body must contain { sessionId: string, attempt: non-negative integer }'),
    'inner-monitor/slots': failure('invalid_body', 'Body must contain { sessionId: string, attempt: non-negative integer }'),
    'inner-monitor/slot': failure('invalid_body', 'Body must contain { sessionId: string, attempt: non-negative integer, slot: non-negative integer }'),
    'inner-monitor/handoff': failure('invalid_body', 'Body must contain { sessionId: string, handoff: non-negative integer }'),
    'inner-monitor/settlement': failure('invalid_body', 'Body must contain { sessionId: string, handoff: non-negative integer }'),
  };
  const refused = [undefined, null, '7', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, true, {}];

  for (const [endpoint, , address] of DETAIL_ENDPOINTS) {
    assert.deepEqual(await call(handler, endpoint, { ...address }), sessionless, endpoint);
    assert.deepEqual(await call(handler, endpoint, { sessionId: 7, ...address }), sessionless, endpoint);
    assert.deepEqual(await call(handler, endpoint, undefined), sessionless, endpoint);
    for (const name of Object.keys(address)) {
      for (const value of refused) {
        assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...address, [name]: value }), invalid[endpoint], `${endpoint} ${name} ${String(value)}`);
      }
      assert.deepEqual(await call(handler, endpoint, { sessionId: 's-held', ...{ ...address, [name]: undefined } }), invalid[endpoint], `${endpoint} no ${name}`);
    }
    assert.equal((await call(handler, endpoint, { sessionId: 's-held', ...Object.fromEntries(Object.keys(address).map(name => [name, 0])) })).ok, true, `${endpoint}: zero is an address`);
  }
  assert.deepEqual(calls.map(([, , ...addresses]) => addresses), [[0], [0], [0, 0], [0], [0]], 'only the zero addresses reached the access');
});

// ── The mode through the host ────────────────────────────────────────────────

// The `sessionProjections` service a child reads: `register` records each definition and answers `registration(definition)`, by default a handle whose `stateOf` folds the session's log under that definition.
function fakeProjections(registration) {
  const registered = [];
  const handleFor = definition => ({
    stateOf: session => session.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()),
  });
  return {
    registered,
    register(definition) {
      registered.push(definition);
      return registration === undefined ? Promise.resolve(handleFor(definition)) : registration(definition, handleFor);
    },
  };
}

// The host over a fake context holding every service the mode's child injects but those in `absent`; `sessions` are the live sessions it lists and looks up.
function mountModeHost({
  sessions = [], absent = [], projections = fakeProjections(), readSession = async () => ({ session: {}, inheritedEventCount: 0, events: [] }), listSessions,
  kit = modeKit, queryKit, sessionReads,
} = {}) {
  const { handled, routes, connection } = fakeConnection();
  const services = {
    tokenMeter: fakeTokenMeter(), fs: fakeFs(), agents: fakeAgents(), attachments: {}, sessionProjections: projections,
  };
  for (const name of absent) delete services[name];
  const ctx = createFakeContext({ sessions, readSession, listSessions, connection, webServer, sessionReads, ...services });
  const tools = [];
  ctx.tools.register = (definition) => { tools.push(definition); };
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR, innerKit: kit, readSettings: () => INHERITING_SETTINGS, queryKit,
  });
  return { ctx, table, projections, routes, handler: handled[0].handler, tools };
}

const liveModeSession = id => newSession(id, { header: { cwd: '/repo' } });

test('the host answers the mode over its channel once the child\'s projection is registered, whatever its measurement says, and the child registers the mode unit and then the monitor unit', async () => {
  const session = liveModeSession('s-host-mode');
  const { ctx, projections, handler } = mountModeHost({ sessions: [session], readSession: logsOf(session).readSession });
  await settled();
  assert.deepEqual(projections.registered.map(definition => definition.key), REGISTRATION_ORDER);
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'off', locked: false } });
  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: false } });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: 's-not-listed' }), unavailable);
  ctx.dispose();
});

test('a service the mode\'s child requires missing, the host mounts all the same, both endpoints answer unavailable and no mode record is copied into a new subagent', async () => {
  for (const missing of ['sessionProjections', 'agents', 'fs', 'attachments', 'tokenMeter']) {
    const parent = liveModeSession(`p-${missing}`);
    modeKit.appendPluginRecord(parent, MODE_RECORD_TYPE, { v: 1, enabled: true });
    const { ctx, handler } = mountModeHost({ sessions: [parent], absent: [missing] });
    await settled();
    assert.deepEqual(await call(handler, 'inner-mode', { sessionId: parent.id }), unavailable, missing);
    assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: parent.id, enabled: false }), unavailable, missing);
    const child = newSession(`c-${missing}`, { header: { origin: 'subagent', parentSession: parent.id } });
    await ctx.emit('agent/created', { agent: { session: child }, source: 'startup' });
    assert.deepEqual(modeRecords(child), [], missing);
    assert.deepEqual(modeRecords(parent), [{ v: 1, enabled: true }], missing);
    ctx.dispose();
  }
});

test('the host records the mode of a live parent, on, off or blank, as the own record of a new plain subagent once the mode is available', async () => {
  const on = liveModeSession('p-copy-on');
  modeKit.appendPluginRecord(on, MODE_RECORD_TYPE, { v: 1, enabled: true });
  const off = liveModeSession('p-copy-off');
  modeKit.appendPluginRecord(off, MODE_RECORD_TYPE, { v: 1, enabled: false });
  const blank = liveModeSession('p-copy-blank');
  const { ctx } = mountModeHost({ sessions: [on, off, blank] });
  await settled();
  for (const [parent, enabled] of [[on, true], [off, false], [blank, false]]) {
    const child = newSession(`c-${parent.id}`, { header: { origin: 'subagent', parentSession: parent.id } });
    await ctx.emit('agent/created', { agent: { session: child }, source: 'startup' });
    assert.deepEqual(modeRecords(child), [{ v: 1, enabled }], parent.id);
  }
  ctx.dispose();
});

test('the host\'s agent/created listener holds the creation until the new subagent\'s first event has been read, so the record stands when the creation settles', async () => {
  const parent = liveModeSession('p-held');
  modeKit.appendPluginRecord(parent, MODE_RECORD_TYPE, { v: 1, enabled: true });
  const child = newSession('c-held', { header: { origin: 'subagent', parentSession: parent.id } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const readSession = async (id) => {
    if (id !== child.id) return { session: {}, inheritedEventCount: 0, events: [] };
    await gate;
    return { session: {}, inheritedEventCount: 0, events: child.snapshotEvents() };
  };
  const { ctx } = mountModeHost({ sessions: [parent], readSession });
  await settled();
  let done = false;
  const creation = ctx.emit('agent/created', { agent: { session: child }, source: 'startup' }).then(() => { done = true; });
  await settled();
  assert.equal(done, false, 'the creation waits for the read');
  assert.deepEqual(modeRecords(child), []);
  release();
  await creation;
  assert.deepEqual(modeRecords(child), [{ v: 1, enabled: true }]);
  ctx.dispose();
});

test('a measurement that is still bootstrapping or has failed leaves the mode readable and selectable over the channel', async (t) => {
  captureStderr(t);
  const booting = liveModeSession('s-booting');
  const refused = liveModeSession('s-refused-mode');
  const { ctx, handler } = mountModeHost({
    sessions: [booting, refused], readSession: id => (id === refused.id ? Promise.reject(new Error('read refused')) : new Promise(() => {})),
  });
  await settled();
  assert.deepEqual(await call(handler, 'status', { sessionId: booting.id }), bootstrapping);
  assert.equal((await call(handler, 'status', { sessionId: refused.id })).value.state, 'failed');
  for (const session of [booting, refused]) {
    assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} }, session.id);
    assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: false } }, session.id);
  }
  ctx.dispose();
});

test('the mode\'s agent/created listener never throws into the agent\'s creation: a projection read that fails writes one handler_failed line and leaves the child off', async (t) => {
  const lines = captureStderr(t);
  const parent = liveModeSession('p-throwing');
  const projections = fakeProjections(() => Promise.resolve({ stateOf: () => { throw new Error('projection read failed'); } }));
  const { ctx } = mountModeHost({ sessions: [parent], projections });
  await settled();
  const child = newSession('c-throwing', { header: { origin: 'subagent', parentSession: parent.id } });
  await assert.doesNotReject(async () => ctx.emit('agent/created', { agent: { session: child }, source: 'startup' }));
  assert.deepEqual(modeRecords(child), []);
  assert.deepEqual(lines.filter(line => line.startsWith('c-throwing ')), ['c-throwing [dsh-host] handler_failed: projection read failed']);
  ctx.dispose();
});

// ── The monitor through the host ─────────────────────────────────────────────

test('the host answers the monitor\'s rows over its channel once its projection is registered, whatever the measurement says: a held session reads the attempts of its own log, an idle one has none and a session the host does not hold is unavailable', async () => {
  const session = liveModeSession('s-host-monitor');
  // The held session's measurement never installs, and the service stores no other log.
  const readSession = id => (id === session.id ? new Promise(() => {}) : Promise.reject(sessionQueryError(`session "${id}" not found`, SESSION_NOT_FOUND)));
  const { ctx, handler } = mountModeHost({ sessions: [session], readSession });
  await settled();
  assert.deepEqual(await call(handler, 'status', { sessionId: session.id }), bootstrapping, 'the measurement is not live');
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: session.id }), { ok: true, value: { attempts: [], handoffs: [] } });

  const start = modeKit.appendPluginRecord(session, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [3, 4, 5] }).data);
  const { value } = await call(handler, 'inner-monitor', { sessionId: session.id });
  assert.deepEqual(value.attempts.map(row => [row.id, row.status, row.range]), [[start, 'unknown', { first: 3, last: 5, count: 3 }]]);
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: 's-not-listed' }), monitorUnavailable);
  ctx.dispose();
});

test('the host reads a monitor detail from the session\'s log through the sessionQuery service: a recorded attempt\'s call is answered, its slots are not committed and a log that cannot be read is one inner_monitor_read_failed line', async (t) => {
  const lines = captureStderr(t);
  const session = liveModeSession('s-host-details');
  let refusal = null;
  const reads = [];
  const { readSession: stored } = logsOf(session);
  const readSession = async (sessionId) => {
    reads.push(sessionId);
    if (refusal !== null) throw refusal;
    return stored(sessionId);
  };
  const { ctx, handler } = mountModeHost({ sessions: [session], readSession });
  await settled();
  const start = modeKit.appendPluginRecord(session, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [3, 4, 5], tail: 'the prompt' }).data);
  reads.length = 0;

  const { value } = await call(handler, 'inner-monitor/call', { sessionId: session.id, attempt: start });

  assert.deepEqual([value.ids, value.row.status, value.request.messages.tail.content[0].text, value.response], [{ start, call: null, end: null, carrier: null }, 'unknown', 'the prompt', null]);
  assert.deepEqual(reads, [session.id], 'one read of the session\'s log through the service');
  assert.deepEqual(await call(handler, 'inner-monitor/slots', { sessionId: session.id, attempt: start }), failure('inner_monitor_not_committed', 'The inner compaction attempt has no committed seal, so it has no slots.'));
  assert.deepEqual(await call(handler, 'inner-monitor/call', { sessionId: 's-not-listed', attempt: start }), monitorUnavailable);

  refusal = new Error('the log could not be read');
  assert.deepEqual(await call(handler, 'inner-monitor/call', { sessionId: session.id, attempt: start }), failure('inner_monitor_read_failed', 'the log could not be read'));
  assert.deepEqual(lines, [`${session.id} [dsh-host] inner_monitor_read_failed: the log could not be read`]);
  ctx.dispose();
});

test('a monitor registration that is refused costs one inner_monitor_register line and is not retried: the monitor answers unavailable while the mode is read and selected, a new subagent is given its parent\'s mode and the seal listener is registered', async (t) => {
  const lines = captureStderr(t);
  const parent = liveModeSession('p-monitor-refused');
  modeKit.appendPluginRecord(parent, MODE_RECORD_TYPE, { v: 1, enabled: true });
  const projections = fakeProjections((definition, handleFor) => (definition.key === MONITOR_PROJECTION_KEY
    ? Promise.reject(new Error('monitor registration refused')) : Promise.resolve(handleFor(definition))));
  const { ctx, handler } = mountModeHost({ sessions: [parent], projections });
  await settled();

  assert.deepEqual(projections.registered.map(definition => definition.key), REGISTRATION_ORDER, 'the monitor was asked for once, after the mode');
  assert.deepEqual(lines, ['[dsh-host] inner_monitor_register: monitor registration refused']);
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: parent.id }), monitorUnavailable);
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: parent.id }), { ok: true, value: { mode: 'on', locked: false } });
  const child = newSession('c-monitor-refused', { header: { origin: 'subagent', parentSession: parent.id } });
  await ctx.emit('agent/created', { agent: { session: child }, source: 'startup' });
  assert.deepEqual(modeRecords(child), [{ v: 1, enabled: true }], 'the inheritance listener stands');
  const invalid = liveModeSession('s-monitor-refused-invalid');
  modeKit.appendPluginRecord(invalid, MODE_RECORD_TYPE, { v: 2 });
  const payload = { agent: { id: invalid.id, session: invalid }, messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'p', model: 'm' } };
  const decision = { kind: 'enter', messages: [] };
  assert.deepEqual(await ctx.emit('agent/pre-step', payload, async () => decision), [decision, decision], 'the seal listener stands beside the epoch model listener');
  assert.equal(lines.filter(line => line.includes('inner_mode_invalid')).length, 1, 'and it ran');
  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: parent.id, enabled: false }), { ok: true, value: {} });
  assert.deepEqual(projections.registered.map(definition => definition.key), REGISTRATION_ORDER, 'nothing registered the monitor again');
  ctx.dispose();
});

test('a monitor projection whose state cannot be read once registered is one inner_monitor_read_failed line and a failure envelope, and the mode is read as before', async (t) => {
  const lines = captureStderr(t);
  const session = liveModeSession('s-monitor-unreadable');
  const projections = fakeProjections((definition, handleFor) => (definition.key === MONITOR_PROJECTION_KEY
    ? Promise.resolve({ stateOf: () => { throw new Error('the monitor state could not be read'); } })
    : Promise.resolve(handleFor(definition))));
  const { ctx, handler } = mountModeHost({ sessions: [session], projections });
  await settled();

  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: session.id }), failure('inner_monitor_read_failed', 'the monitor state could not be read'));
  assert.deepEqual(lines, [`${session.id} [dsh-host] inner_monitor_read_failed: the monitor state could not be read`]);
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'off', locked: false } });
  ctx.dispose();
});

test('withdrawing the child withdraws the monitor access with the mode\'s: both answer unavailable', async () => {
  const session = liveModeSession('s-withdrawn');
  const { ctx, handler } = mountModeHost({ sessions: [session] });
  await settled();
  assert.equal((await call(handler, 'inner-monitor', { sessionId: session.id })).ok, true);
  assert.equal((await call(handler, 'inner-mode', { sessionId: session.id })).ok, true);

  ctx.unprovide('tokenMeter');
  assert.deepEqual(await call(handler, 'inner-monitor', { sessionId: session.id }), monitorUnavailable);
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: session.id }), unavailable);
  ctx.dispose();
});

// ── A stored session through the host ────────────────────────────────────────

// The session service's reads over the logs of `sessions`, each as the service answers a read of a session it knows: its header and the events it holds at the time of the read; any other id is rejected as the service rejects one it neither holds nor lists. `reads` keeps the id of each read.
function logsOf(...sessions) {
  const reads = [];
  return {
    reads,
    readSession: async (sessionId) => {
      reads.push(sessionId);
      const known = sessions.find(session => session.id === sessionId);
      if (known === undefined) throw sessionQueryError(`session "${sessionId}" not found`, SESSION_NOT_FOUND);
      return { session: known.header, inheritedEventCount: known.inheritedEventCount ?? 0, events: known.snapshotEvents() };
    },
  };
}

// A child that chose its mode, ran a turn and finished it.
function finishedChild(id, { enabled = true } = {}) {
  const child = liveModeSession(id);
  modeKit.appendPluginRecord(child, MODE_RECORD_TYPE, { v: 1, enabled });
  child.append('turn/start', { turn: 1 });
  child.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return child;
}

// The host releases `session`: the store forgets it, then its disposal is announced, in the order the session store detaches one.
async function release(ctx, sessions, session) {
  sessions.splice(sessions.indexOf(session), 1);
  await ctx.emit('session/disposed', session);
}

test('a finished session the host no longer holds answers its mode from its stored log, though its measurement was never rebuilt: the lock and mode are the log\'s, no watcher is made, no persisted listing is read and no record is written', async () => {
  const child = finishedChild('c-finished');
  const sessions = [child];
  const { readSession, reads } = logsOf(child);
  const listed = [];
  const { ctx, table, handler } = mountModeHost({ sessions, readSession, listSessions: () => { listed.push('listed'); return []; } });
  await settled();
  await release(ctx, sessions, child);
  assert.equal(table.get(child.id).state, 'unobserved', 'the disposal released the watcher');
  reads.length = 0;

  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: child.id }), { ok: true, value: { mode: 'on', locked: true } });

  assert.deepEqual(reads, [child.id], 'one read of the stored log');
  assert.equal(table.get(child.id).state, 'unobserved', 'no watcher was made to answer it');
  assert.deepEqual(listed, [], 'the listing the measurement ensures its entry from was not read');
  assert.deepEqual(modeRecords(child), [{ v: 1, enabled: true }], 'nothing was written');
  ctx.dispose();
});

test('a finished session the host no longer holds lists its attempts from its stored log with the status the log gives them, an attempt whose end the log does not hold staying unknown, with no watcher made and nothing in flight', async () => {
  const child = finishedChild('c-attempts');
  const failedStart = modeKit.appendPluginRecord(child, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [3, 4, 5] }).data);
  modeKit.appendPluginRecord(child, INNER_END_RECORD_TYPE, innerEnd({ attempt: failedStart, reason: 'the summary was not valid' }).data);
  const unfinishedStart = modeKit.appendPluginRecord(child, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [6, 7], tail: 'the second prompt' }).data);
  const sessions = [child];
  const { readSession, reads } = logsOf(child);
  const { ctx, table, handler } = mountModeHost({ sessions, readSession });
  await settled();
  await release(ctx, sessions, child);
  reads.length = 0;

  const reply = await call(handler, 'inner-monitor', { sessionId: child.id });

  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(reply.value.attempts.map(row => [row.id, row.status, row.reason, row.range, row.call.state, row.call.input]), [
    [failedStart, 'failed', 'the summary was not valid', { first: 3, last: 5, count: 3 }, 'absent', 'Write concise continuity notes.'],
    [unfinishedStart, 'unknown', null, { first: 6, last: 7, count: 2 }, 'absent', 'the second prompt'],
  ]);
  assert.deepEqual(reads, [child.id], 'one read of the stored log');
  assert.equal(table.get(child.id).state, 'unobserved');
  ctx.dispose();
});

test('a session the host stores answers its handoffs and their detail over the channel: the rows carry the next task the host\'s store holds under the payload\'s handoff id, the detail reads the log at the seqs the row names, and an address the monitor holds none of is one read failure', async (t) => {
  const lines = captureStderr(t);
  let events = [];
  const readSession = async (id) => {
    if (id !== 's-stored-handoff') throw sessionQueryError(`session "${id}" not found`, SESSION_NOT_FOUND);
    return { session: sessionHeader(id), inheritedEventCount: 0, events };
  };
  const { ctx, handler } = mountModeHost({ readSession });
  await settled();
  const { handoffId } = getStore().insertHandoff({
    sessionId: 's-prior', segment: 0, loadToken: 'amber-falcon', createdAt: 1, pathsToKeep: '[]', summary: 'stored summary', summaryTokens: 3,
    nextTask: 'Carry on from step two', projectId: 'p',
  });
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'reply', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 } });
  const after = assistantMessage({ text: 'resumed', usage: { inputTokens: 500, outputTokens: 90, cacheReadTokens: 200, cacheWriteTokens: 10 } });
  events = sessionLog([
    ask, before, continueCheckpoint({ token: 'amber-falcon', startSeq: ask.seq, endSeq: before.seq }),
    loadPayload({ token: 'amber-falcon', handoffId, summary: 'the summary as sent', paths: ['/repo/src/a.js'], turnPage: 'notice\n\nS1  /logs/a.jsonl\n\nS1:4 | U: ask\n     | A: note' }),
    loadReads({ files: [{ path: '/repo/src/a.js', ranges: [{ offset: 1, limit: 1 }], text: '/repo/src/a.js (total lines: 1)\n1: a\n', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text: 'a' }] }] }] }),
    loadFollowUp({ token: 'amber-falcon' }), after,
  ]);
  const payloadSeq = events[3].seq;

  const rows = await call(handler, 'inner-monitor', { sessionId: 's-stored-handoff' });

  assert.equal(rows.ok, true, JSON.stringify(rows));
  assert.deepEqual(rows.value.attempts, []);
  assert.deepEqual(rows.value.handoffs.map(row => [row.id, row.type, row.token, row.nextTask, row.contextChange, row.revision]), [
    [payloadSeq, 'continue', 'amber-falcon', 'Carry on from step two', { before: 460, after: 710, delta: 250, miss: 510 }, events[6].seq],
  ]);

  const detail = await call(handler, 'inner-monitor/handoff', { sessionId: 's-stored-handoff', handoff: payloadSeq });

  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.deepEqual(detail.value.row, rows.value.handoffs[0]);
  assert.deepEqual([detail.value.summary, detail.value.followUp.startsWith('Handoff "amber-falcon" is loaded.')], ['the summary as sent', true]);
  assert.deepEqual(detail.value.files, [{ path: '/repo/src/a.js', total: 1, runs: [{ offset: 1, lines: [{ number: 1, text: 'a' }] }] }]);
  assert.deepEqual(detail.value.turns, [{ address: 'S1:4', user: 'ask', note: 'note' }]);

  assert.deepEqual(await call(handler, 'inner-monitor/handoff', { sessionId: 's-stored-handoff', handoff: 9999 }), failure('inner_monitor_read_failed', 'the inner monitor holds no handoff 9999'));
  assert.deepEqual(lines, ['s-stored-handoff [dsh-host] inner_monitor_read_failed: the inner monitor holds no handoff 9999']);
  assert.deepEqual(await call(handler, 'inner-monitor/handoff', { sessionId: 's-not-listed', handoff: payloadSeq }), monitorUnavailable);

  assert.deepEqual(await call(handler, 'inner-monitor/settlement', { sessionId: 's-stored-handoff', handoff: payloadSeq }), {
    ok: true, value: { epoch: 1, attempts: [], tailCalls: 1, calls: [{ seq: events[1].seq, stock: 440, post: false }], cut: { segment: 0, through: events[1].seq } },
  }, 'the calls of the segment the clear cut off, the stock the monitor reads of each, and the cut that read stood at');
  assert.deepEqual(await call(handler, 'inner-monitor/settlement', { sessionId: 's-stored-handoff', handoff: 9999 }), failure('inner_monitor_read_failed', 'the inner monitor holds no handoff 9999'));
  assert.deepEqual(await call(handler, 'inner-monitor/settlement', { sessionId: 's-not-listed', handoff: payloadSeq }), monitorUnavailable);
  assert.deepEqual(await call(handler, 'inner-monitor/settlement/current', { sessionId: 's-stored-handoff' }), {
    ok: true, value: { epoch: 2, attempts: [], tailCalls: 1, calls: [{ seq: events[6].seq, stock: 710, post: false }], cut: { segment: 1, through: events[6].seq } },
  });
  assert.deepEqual(await call(handler, 'inner-monitor/settlement/current', { sessionId: 's-not-listed' }), monitorUnavailable);
  ctx.dispose();
});

// The Chinese page's translate: the locale's text of a key with its `{name}` placeholders filled.
const zhText = (key, params) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (placeholder, name) => params?.[name] ?? placeholder);

test('the compaction page reads a finished session through its monitor stores over the channel and renders its attempts, and the header marks it through the mode reader', async () => {
  const child = finishedChild('c-page');
  const start = modeKit.appendPluginRecord(child, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [3, 4] }).data);
  modeKit.appendPluginRecord(child, INNER_END_RECORD_TYPE, innerEnd({ attempt: start, reason: 'the summary was not valid' }).data);
  const sessions = [child];
  const { ctx, handler } = mountModeHost({ sessions, readSession: logsOf(child).readSession });
  await settled();
  await release(ctx, sessions, child);
  const rpc = (endpoint, payload) => call(handler, endpoint, payload);
  const reader = createModeReaders({ call: rpc }).for(child.id);
  const monitor = createMonitorStores({ call: rpc }).for(child.id);
  const unsubscribe = [reader.subscribe(() => {}), monitor.rows.subscribe(() => {})];
  await settled();

  const html = renderToString(React.createElement(InnerCompactionView, { monitor, t: zhText }));

  assert.equal(html.includes(zh['monitor.rows.unavailable']), false, 'the notice of a mode the page cannot read');
  assert.equal(html.includes(`data-identity="attempt:${start}"`), true, 'the finished session\'s attempt is listed');
  assert.equal(renderToString(React.createElement(ModeMark, { reader, t: zhText })).includes('data-sw-mode-mark'), true, 'the header marks a session that started on');
  assert.equal(renderToString(React.createElement(ModeToggle, { reader, select: async () => ({ ok: true, value: {} }), visibility: { getSnapshot: () => true, subscribe: () => () => {} }, t: zhText })), '', 'and offers no switch for a locked mode');
  for (const stop of unsubscribe) stop();
  ctx.dispose();
});

// A stored log that is no live session: the object states what a read of it answers.
const storedLog = (id, events) => ({ id, header: sessionHeader(id), snapshotEvents: () => events });
const UNAVAILABLE_CALLS = [
  ['inner-mode', {}, unavailable], ['inner-monitor', {}, monitorUnavailable], ['inner-monitor/call', { attempt: 0 }, monitorUnavailable],
  ['inner-monitor/slots', { attempt: 0 }, monitorUnavailable], ['inner-monitor/slot', { attempt: 0, slot: 0 }, monitorUnavailable],
  ['inner-monitor/settlement', { handoff: 0 }, monitorUnavailable],
];

test('an id the session service neither holds nor lists is unavailable on every page endpoint, while a stored session whose read fails answers a read failure with one stderr line, never off, an empty list or its last answer, and the next read is made again', async (t) => {
  const lines = captureStderr(t);
  const child = finishedChild('c-flaky');
  const sessions = [child];
  const { readSession: stored } = logsOf(child);
  let refusal = null;
  const readSession = async (id) => {
    if (refusal !== null && id === child.id) throw refusal;
    return stored(id);
  };
  const { ctx, handler } = mountModeHost({ sessions, readSession });
  await settled();
  await release(ctx, sessions, child);

  for (const [endpoint, address, expected] of UNAVAILABLE_CALLS) {
    assert.deepEqual(await call(handler, endpoint, { sessionId: 's-nowhere', ...address }), expected, endpoint);
  }
  assert.deepEqual(lines, [], 'an id that is not stored is no failure');
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: child.id }), { ok: true, value: { mode: 'on', locked: true } });

  for (const cause of [new Error('the stored log is corrupt'), sessionQueryError('failed to read stored session "c-flaky": disk', 'SESSION_QUERY_PERSISTENCE_FAILED')]) {
    refusal = cause;
    lines.length = 0;
    assert.deepEqual(await call(handler, 'inner-mode', { sessionId: child.id }), failure('inner_mode_read_failed', cause.message), cause.message);
    for (const [endpoint, address] of UNAVAILABLE_CALLS.slice(1)) {
      assert.deepEqual(await call(handler, endpoint, { sessionId: child.id, ...address }), failure('inner_monitor_read_failed', cause.message), `${endpoint}: ${cause.message}`);
    }
    assert.deepEqual(lines, [
      `${child.id} [dsh-host] inner_mode_read_failed: ${cause.message}`,
      ...UNAVAILABLE_CALLS.slice(1).map(() => `${child.id} [dsh-host] inner_monitor_read_failed: ${cause.message}`),
    ]);
  }
  refusal = null;
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: child.id }), { ok: true, value: { mode: 'on', locked: true } }, 'a failure is not kept');
  ctx.dispose();
});

test('a stored session\'s mode is the log\'s once a turn has started, on, off or invalid as the projection reads it, and stays unavailable while none has, nothing standing in for a lock the log does not give', async () => {
  const invalid = storedLog('c-invalid', [ignorableEvent({ type: MODE_RECORD_TYPE, data: { v: 2 } }), turnStart(), turnEnd()]);
  const unstarted = storedLog('c-unstarted', [ignorableEvent({ type: MODE_RECORD_TYPE, data: { v: 1, enabled: true } })]);
  const on = finishedChild('c-on');
  const off = finishedChild('c-off', { enabled: false });
  const { readSession } = logsOf(on, off, invalid, unstarted);
  const { ctx, handler } = mountModeHost({ readSession });
  await settled();

  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: on.id }), { ok: true, value: { mode: 'on', locked: true } });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: off.id }), { ok: true, value: { mode: 'off', locked: true } });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: invalid.id }), { ok: true, value: { mode: 'invalid', locked: true } });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: unstarted.id }), unavailable);
  ctx.dispose();
});

test('a stored attempt without a carrier has no slots, which is told from an unavailable monitor and from an address the monitor cannot find', async (t) => {
  const lines = captureStderr(t);
  const child = finishedChild('c-uncommitted');
  const start = modeKit.appendPluginRecord(child, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [3, 4] }).data);
  const { readSession } = logsOf(child);
  const { ctx, handler } = mountModeHost({ readSession });
  await settled();
  const sessionId = child.id;

  assert.deepEqual(await call(handler, 'inner-monitor/slots', { sessionId, attempt: start }), notCommitted);
  assert.deepEqual(await call(handler, 'inner-monitor/slot', { sessionId, attempt: start, slot: 3 }), notCommitted);
  assert.deepEqual(await call(handler, 'inner-monitor/slots', { sessionId: 's-nowhere', attempt: start }), monitorUnavailable);
  assert.deepEqual(await call(handler, 'inner-monitor/slots', { sessionId, attempt: start + 100 }), failure('inner_monitor_read_failed', `the inner monitor holds no attempt ${start + 100}`));
  assert.equal(lines.length, 1, 'only the address the monitor cannot find is a failure');
  ctx.dispose();
});

test('a stored session cannot be selected: inner-mode/select answers inner_mode_unavailable with no read of the log and no record, and a plain subagent of a parent that is stored but not live is still left off, with the diagnostic', async (t) => {
  const lines = captureStderr(t);
  const parent = finishedChild('p-stored');
  const child = newSession('c-orphan', { header: { origin: 'subagent', parentSession: parent.id } });
  const { readSession, reads } = logsOf(parent, child);
  const { ctx, handler } = mountModeHost({ readSession });
  await settled();
  reads.length = 0;

  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: parent.id, enabled: false }), unavailable);
  assert.deepEqual(reads, [], 'the selection reads no stored log');
  assert.deepEqual(modeRecords(parent), [{ v: 1, enabled: true }]);

  await ctx.emit('agent/created', { agent: { session: child }, source: 'startup' });
  assert.deepEqual(modeRecords(child), [], 'the parent\'s stored mode is no mode to give');
  assert.deepEqual(lines.filter(line => line.startsWith('c-orphan ')), [`c-orphan [dsh-host] inner_mode_not_inherited: the parent session ${parent.id} is not live, so its inner mode is unknown; this subagent stays off`]);
  ctx.dispose();
});

test('a fork read live, then released, then live again under the same id answers each time from its current source: the prefix it inherited is read in all three phases, the stored read writes nothing and leaves nothing for the instance that returns', async () => {
  const parent = liveModeSession('p-lifecycle');
  modeKit.appendPluginRecord(parent, MODE_RECORD_TYPE, { v: 1, enabled: true });
  parent.append('turn/start', { turn: 1 });
  const child = newSession('c-lifecycle', {
    header: { isSeeded: true, origin: 'subagent', parentSession: parent.id }, seed: forkSeedOf(parent, 1), inheritedEventCount: 2,
  });
  const first = modeKit.appendPluginRecord(child, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [3, 4] }).data);
  const sessions = [parent, child];
  const { readSession, reads } = logsOf(parent, child);
  const { ctx, table, handler } = mountModeHost({ sessions, readSession });
  await settled();
  const modeOn = { ok: true, value: { mode: 'on', locked: true } };
  const attemptsOf = async () => (await call(handler, 'inner-monitor', { sessionId: child.id })).value.attempts.map(row => row.id);
  const logLength = child.snapshotEvents().length;
  reads.length = 0;

  assert.deepEqual([await call(handler, 'inner-mode', { sessionId: child.id }), await attemptsOf()], [modeOn, [first]], 'live');
  assert.deepEqual(reads, [], 'a held session reads no stored log');

  await release(ctx, sessions, child);
  assert.deepEqual([await call(handler, 'inner-mode', { sessionId: child.id }), await attemptsOf()], [modeOn, [first]], 'released');
  assert.deepEqual(reads, [child.id, child.id], 'a stored read for each answer');
  assert.equal(table.get(child.id).state, 'unobserved');

  sessions.push(child);
  await ctx.emit('session/created', child);
  await settled();
  const second = modeKit.appendPluginRecord(child, INNER_ATTEMPT_RECORD_TYPE, innerAttempt({ range: [5, 6] }).data);
  reads.length = 0;
  assert.deepEqual([await call(handler, 'inner-mode', { sessionId: child.id }), await attemptsOf()], [modeOn, [first, second]], 'the instance that returned');
  assert.deepEqual(reads, [], 'the instance answers, not a stored read');

  await release(ctx, sessions, child);
  assert.deepEqual(await attemptsOf(), [first, second], 'released again, from the log as it stands');
  assert.equal(modeRecords(child).length, 1, 'the one record the fork inherited, none copied by a read');
  assert.equal(child.snapshotEvents().length, logLength + 1, 'nothing but the attempt the instance recorded was written');
  ctx.dispose();
});

test('the selection of a held session keeps its synchronous lock check and append through the host, with the stored read behind inner-mode beside it', async () => {
  const blank = liveModeSession('s-select-sync');
  const { ctx, handler } = mountModeHost({ sessions: [blank], readSession: logsOf(blank).readSession });
  await settled();

  const pending = call(handler, 'inner-mode/select', { sessionId: blank.id, enabled: true });
  blank.append('turn/start', { turn: 1 });

  assert.deepEqual(await pending, { ok: true, value: {} });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: blank.id }), { ok: true, value: { mode: 'on', locked: true } });
  assert.deepEqual(modeRecords(blank), [{ v: 1, enabled: true }]);
  assert.deepEqual(await call(handler, 'inner-mode/select', { sessionId: blank.id, enabled: false }), failure('inner_mode_locked', 'The inner compaction mode can no longer be chosen once the session has started a turn.'));
  ctx.dispose();
});

// The monitor's details read the response and the records through the checkout's stream readers; without a checkout they skip.
const NEEDS_KIT = monitorKit === null && 'SW_DSH_CHECKOUT is unset';
const NOTES = { 1: 'asked for work', 2: 'read the file', 3: 'finished' };

// A stored log whose first seal committed: the mode chosen on, a turn that asked, read and finished, the attempt's start and call, the prune and the carrier that keeps one note for each of the three sources, then the turn's end.
// It is no live session: the object states the header and the events a read of it answers, and the seqs the monitor's addresses name.
function sealedLog(id) {
  const mode = ignorableEvent({ type: MODE_RECORD_TYPE, data: { v: 1, enabled: true } });
  const turn = turnStart();
  const ask = userMessage({ text: 'please work' });
  const reading = assistantMessage({ text: 'reading the file' });
  const done = assistantMessage({ text: 'all done' });
  const range = [ask.seq, reading.seq, done.seq];
  const tail = 'Write concise continuity notes for the listed parts.';
  const start = innerAttempt({ range, tail });
  const stream = compactStreamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: JSON.stringify(NOTES) },
    { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(NOTES) } },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 950, cacheReadTokens: 800 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const call = innerCall({ range, tail, stream, endedAt: 1_700_000_100_000, attempt: start.seq });
  const prune = compactionPrune(ask);
  const slots = [[ask, NOTES[1]], [reading, NOTES[2]], [done, NOTES[3]]].map(([source, text]) => ({ seqs: [source.seq], text }));
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, prune.seq, ...range], slots });
  const events = [mode, turn, ask, reading, done, start, call, prune, carrier, turnEnd()];
  return { id, header: sessionHeader(id), snapshotEvents: () => events, events, ask, reading, done, start, call, carrier };
}

test('the call, the slots and a slot of a committed attempt of a session the host no longer holds read from the stored log: the response, the carrier\'s notes and the source events at the addresses the rows name, none of it a watcher\'s', { skip: NEEDS_KIT }, async () => {
  const log = sealedLog('c-sealed');
  const { readSession, reads } = logsOf(log);
  const { table, ctx, handler } = mountModeHost({ readSession, kit: monitorKit });
  await settled();
  const sessionId = log.id;

  const rows = await call(handler, 'inner-monitor', { sessionId });
  assert.equal(rows.ok, true, JSON.stringify(rows));
  assert.deepEqual(rows.value.attempts.map(row => [row.id, row.status, row.slots, row.range, row.call.state, row.call.output]),
    [[log.start.seq, 'committed', 3, { first: log.ask.seq, last: log.done.seq, count: 3 }, 'received', JSON.stringify(NOTES)]]);

  const detail = await call(handler, 'inner-monitor/call', { sessionId, attempt: log.start.seq });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.deepEqual(detail.value.ids, { start: log.start.seq, call: log.call.seq, end: null, carrier: log.carrier.seq });
  assert.deepEqual(detail.value.response.blocks, [{ type: 'text', text: JSON.stringify(NOTES) }]);
  assert.equal(detail.value.request.messages.tail.content[0].text, 'Write concise continuity notes for the listed parts.');

  const slots = await call(handler, 'inner-monitor/slots', { sessionId, attempt: log.start.seq });
  assert.equal(slots.ok, true, JSON.stringify(slots));
  assert.deepEqual(slots.value.slots.map(slot => [slot.key, slot.output]), [[log.ask.seq, NOTES[1]], [log.reading.seq, NOTES[2]], [log.done.seq, NOTES[3]]]);
  assert.ok(slots.value.slots[1].input.includes('reading the file'), 'the source the call saw');

  const slot = await call(handler, 'inner-monitor/slot', { sessionId, attempt: log.start.seq, slot: log.reading.seq });
  assert.equal(slot.ok, true, JSON.stringify(slot));
  assert.deepEqual([slot.value.key, slot.value.number, slot.value.seqs, slot.value.c], [log.reading.seq, 2, [log.reading.seq], NOTES[2]]);
  assert.deepEqual(slot.value.events.map(event => [event.seq, event.type, event.visible]), [[log.reading.seq, 'assistant/message', true]]);
  assert.ok(JSON.stringify(slot.value.events[0].blocks).includes('reading the file'));

  assert.equal(reads.length, 4, 'one read of the stored log for each of the four requests');
  assert.equal(table.get(sessionId).state, 'unobserved');
  ctx.dispose();
});

// The chunks an events stream writes, collected as they arrive: `drain()` answers those written since its last call, after the macrotask the stream's delivery takes.
async function collectingStream(route) {
  const reader = (await route.fetch(new Request('http://localhost/api/session-watcher.events'))).body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      chunks.push(decoder.decode(value));
    }
  })();
  return { drain: async () => { await settled(); return chunks.splice(0); } };
}

test('an attempt record, a call record, an end record and an inner-seal carrier each publish their session once on the events route, and a prune, a reply, a user message and another plugin\'s record publish nothing', async () => {
  const session = liveModeSession('s-monitor-signals');
  // A measurement that never installs applies no frame, so every frame on the route is the child's own.
  const { ctx, routes } = mountModeHost({ sessions: [session], readSession: () => new Promise(() => {}) });
  await settled();
  const stream = await collectingStream(routes[0]);
  assert.deepEqual(await stream.drain(), [': open\n\n']);
  const signal = `data: ${JSON.stringify({ sessionId: session.id })}\n\n`;
  const source = userMessage({ text: 'please work' });

  for (const [why, event] of [
    ['an attempt record', innerAttempt()],
    ['a call record', innerCall()],
    ['an end record', innerEnd({ attempt: 0 })],
    ['an inner-seal carrier', innerSealCarrier({ sourceEventSeqs: [1, 2, 3], slots: [] })],
  ]) {
    await ctx.emit('session/event', session, event);
    assert.deepEqual(await stream.drain(), [signal], why);
  }
  for (const [why, event] of [
    ['a prune', compactionPrune(source)],
    ['a reply', assistantMessage({ text: 'a reply' })],
    ['a user message', userMessage({ text: 'an ask' })],
    ['another plugin\'s record', ignorableEvent({ type: 'plugin:other/thing', data: { v: 1 } })],
  ]) {
    await ctx.emit('session/event', session, event);
    assert.deepEqual(await stream.drain(), [], why);
  }
  ctx.dispose();
});

test('the live monitor publishes slot warnings with the carrier that first shows them, without measurement', { skip: NEEDS_KIT }, async () => {
  const session = sealedLog('s-slot-warnings');
  session.carrier.data.source.verbatimSeqs = [session.ask.seq];
  const { ctx, handler, routes } = mountModeHost({ sessions: [session], kit: monitorKit, readSession: () => new Promise(() => {}) });
  await settled();
  const stream = await collectingStream(routes[0]);
  await stream.drain();
  const warnings = async () => (await call(handler, 'inner-monitor', { sessionId: session.id })).value.attempts.map(row => row.slotWarnings);
  const send = async (event) => {
    session.events.push(event);
    await ctx.emit('session/event', session, event);
    return stream.drain();
  };

  const args = JSON.stringify({ seq: session.ask.seq });
  const reply = assistantMessage({ turn: 2, toolCalls: [{ id: 'recall', name: 'sw_event_read', arguments: args }] });
  await send(reply);
  assert.deepEqual(await send(toolCall({ turn: 2, callId: 'recall', name: 'sw_event_read', arguments: args })), []);
  assert.deepEqual(await warnings(), [undefined]);

  const range = [reply.seq];
  const start = innerAttempt({ range });
  const summary = innerCall({ range, attempt: start.seq });
  const prune = compactionPrune(reply);
  for (const event of [start, summary, prune]) await send(event);
  assert.deepEqual(await warnings(), [undefined, undefined]);
  const carrier = innerSealCarrier({ sourceEventSeqs: [summary.seq, prune.seq, ...range], slots: [{ seqs: range, text: 'read the earlier message' }] });
  assert.deepEqual(await send(carrier), [`data: ${JSON.stringify({ sessionId: session.id })}\n\n`]);
  assert.deepEqual(await warnings(), [undefined, { [reply.seq]: ['verbatim-recall'] }]);
  ctx.dispose();
});

test('sw_event_read refuses an event the monitor holds in the caller\'s context, and refuses none while the monitor is unpublished', { skip: NEEDS_KIT }, async () => {
  const queryKit = { extractSessionEventText: () => '', HarnessError: class HarnessError extends Error { constructor(message, code) { super(message); this.code = code; } } };
  const codeOf = (tool, session, seq) => tool.execute({ seq }, { agent: { session: { id: session.id, header: { cwd: '/repo' } } }, signal: new AbortController().signal })
    .then(text => (/^Session s-held — /.test(text) ? 'read' : text), error => error.code);
  const session = sealedLog('s-held');
  session.carrier.data.source.verbatimSeqs = [session.ask.seq];
  // The service's log of the session, each event at its seq.
  const bySeq = [];
  for (const event of session.events) bySeq[event.seq] = event;
  const sessionReads = fakeSessionLogs({ [session.id]: { header: { id: session.id, cwd: '/repo' }, events: bySeq } });
  const mount = absent => mountModeHost({ sessions: [session], kit: monitorKit, absent, readSession: () => new Promise(() => {}), queryKit, sessionReads });
  const { ctx, tools } = mount([]);
  await settled();
  const tool = tools.find(({ name }) => name === 'sw_event_read');
  assert.equal(await codeOf(tool, session, session.ask.seq), 'SW_EVENT_CARRIED', 'verbatim text');
  assert.equal(await codeOf(tool, session, session.carrier.seq), 'SW_EVENT_CARRIED', 'the carrier');
  assert.equal(await codeOf(tool, session, session.reading.seq), 'read', 'a summarized source');
  ctx.unprovide('tokenMeter');
  assert.equal(await codeOf(tool, session, session.ask.seq), 'read', 'withdrawn with the monitor');
  ctx.dispose();

  const unmonitored = mount(['tokenMeter']);
  await settled();
  assert.equal(await codeOf(unmonitored.tools.find(({ name }) => name === 'sw_event_read'), session, session.ask.seq), 'read');
  unmonitored.ctx.dispose();
});

// The context the host shares with the pi-ai entry, as far as the host reads it: `get(name)` answers the service the entry provides while `provided.service` holds one.
function piAiContext() {
  const provided = { service: undefined };
  return { provided, sibling: { get: name => (name === PI_AI_SERVICE ? provided.service : undefined) } };
}

test('the pi-ai integration status needs no session and answers what the mounted pi-ai entry\'s service holds at each call: no failure while none is mounted or the entry serves, and the entry\'s cause alone while it serves none', async () => {
  const { provided, sibling } = piAiContext();
  const { ctx, handler } = mountHost({ sibling });
  assert.deepEqual(await call(handler, 'pi-ai/status', {}), { ok: true, value: { failure: null } }, 'no pi-ai entry is mounted');
  provided.service = { failure: null, cacheRetention: () => null };
  assert.deepEqual(await call(handler, 'pi-ai/status', undefined), { ok: true, value: { failure: null } }, 'the entry serves its routes');
  provided.service = { failure: { cause: 'source-invalid', detail: 'secret-canary-detail' } };
  assert.deepEqual(await call(handler, 'pi-ai/status', {}), { ok: true, value: { failure: { cause: 'source-invalid' } } }, 'only the cause is on the wire');
  provided.service = undefined;
  assert.deepEqual(await call(handler, 'pi-ai/status', {}), { ok: true, value: { failure: null } }, 'the entry left');
  // The endpoints that read a watcher still ask for a session.
  assert.deepEqual(await call(handler, 'status', {}), failure('invalid_body', 'Body must contain { sessionId: string }'));
  ctx.dispose();
});

test('a session is priced under the retention the mounted pi-ai entry declares for its route, whatever the Settings service holds, and under the Settings service\'s once no entry is mounted or the entry reports a failure and holds no retention of its own', async () => {
  const route = 'route-long';
  const { provided, sibling } = piAiContext();
  const sessions = [fakeSession({ id: 's-entry' }), fakeSession({ id: 's-settings' }), fakeSession({ id: 's-failed' })];
  const { ctx, table } = mountHost({ sessions, ...declaredLifetime(route, 'long'), sibling });
  provided.service = { failure: null, cacheRetention: asked => (asked === route ? 'short' : null) };
  for (const event of logUnder({ model: CLAUDE_MODEL, route })) ctx.emit('session/event', sessions[0], event);
  provided.service = undefined;
  for (const event of logUnder({ model: CLAUDE_MODEL, route })) ctx.emit('session/event', sessions[1], event);
  provided.service = { failure: { cause: 'source-enabled' } };
  for (const event of logUnder({ model: CLAUDE_MODEL, route })) ctx.emit('session/event', sessions[2], event);
  await settled();
  assert.equal(table.get('s-entry').watcher.getStatus().cRatio, modelPolicyFor(CLAUDE_MODEL, DEFAULT_CACHE_TTL).cRatio);
  assert.equal(table.get('s-settings').watcher.getStatus().cRatio, modelPolicyFor(CLAUDE_MODEL, LONG_CACHE_TTL).cRatio);
  assert.equal(table.get('s-failed').watcher.getStatus().cRatio, modelPolicyFor(CLAUDE_MODEL, LONG_CACHE_TTL).cRatio);
  assert.notEqual(modelPolicyFor(CLAUDE_MODEL, DEFAULT_CACHE_TTL).cRatio, modelPolicyFor(CLAUDE_MODEL, LONG_CACHE_TTL).cRatio);
  ctx.dispose();
});

const OWNER = { principal: { kind: 'owner' } };
const askedAs = (handler, peer, endpoint, payload) => handler(endpoint, payload, new AbortController().signal, peer);

test('the host installs the carrier cache bundle only from the install source its composition was given and only for the owner who confirms: the status offers the package the source names, the request that is not the owner\'s or does not carry the literal confirmation touches no manager, and the request cannot name what to install', async () => {
  const listed = [];
  const touched = [];
  const pluginManager = {
    async listBundles() { return listed.map(each => ({ ...each })); },
    async installBundle(spec, options) {
      touched.push(['install', spec, options]);
      listed.push({ name: OFFICIAL_CARRIER_BUNDLE, availability: 'profile', enabled: false, installed: true, version: '9.9.9', rows: [], overrides: [] });
      return { application: 'applied', bundle: OFFICIAL_CARRIER_BUNDLE, version: '9.9.9' };
    },
    async setBundleEnabled(name, enabled) { touched.push(['select', name, enabled]); listed[0].enabled = enabled; return { application: 'restart-required' }; },
  };
  const { ctx, handler } = mountHost({ pluginManager, carrierInstallTarget: () => ({ spec: '/fixed/official.tgz', version: '9.9.9' }) });
  for (const peer of [{ principal: { kind: 'guest' } }, undefined]) {
    assert.deepEqual(await askedAs(handler, peer, 'carrier-cache/set', { enabled: true, confirmInstall: true }), failure('forbidden', 'Only the owner of this host can manage the carrier cache.'));
  }
  assert.deepEqual(await askedAs(handler, OWNER, 'carrier-cache/status', {}), { ok: true, value: { state: 'not-installed', install: { name: OFFICIAL_CARRIER_BUNDLE, version: '9.9.9' } } });
  for (const payload of [{ enabled: true }, { enabled: true, confirmInstall: false }, { enabled: true, confirmInstall: 'true' }, { enabled: true, confirmInstall: 1 }]) {
    assert.deepEqual(await askedAs(handler, OWNER, 'carrier-cache/set', payload), { ok: true, value: { outcome: 'install-confirmation-required' } }, JSON.stringify(payload));
  }
  assert.deepEqual(touched, [], 'the manager was not touched');
  const reply = await askedAs(handler, OWNER, 'carrier-cache/set', { enabled: true, confirmInstall: true, spec: '/other/package.tgz', name: '@other/bundle', registry: 'http://example.invalid', approvedBuilds: ['x'] });
  assert.deepEqual(reply, { ok: true, value: { outcome: 'withdrawn', reason: 'restart-required', installed: true } });
  assert.deepEqual(touched, [['install', '/fixed/official.tgz', { enabled: false, saveExact: true }], ['select', OFFICIAL_CARRIER_BUNDLE, true], ['select', OFFICIAL_CARRIER_BUNDLE, false]]);
  ctx.dispose();

  // A composition that gives no install source offers nothing to install.
  const bare = mountHost({ pluginManager: { listBundles: async () => [], installBundle: async () => { throw new Error('no install source'); } } });
  assert.deepEqual(await askedAs(bare.handler, OWNER, 'carrier-cache/status', {}), { ok: true, value: { state: 'unavailable' } });
  assert.deepEqual(await askedAs(bare.handler, OWNER, 'carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'unavailable' } });
  bare.ctx.dispose();
});

test('the host answers the carrier cache switch from the services of its context at each call and for the owner alone: the plugin manager it names the one fixed bundle on, a peer of another kind or none refused before any manager call, and no manager is an unavailable switch', async () => {
  const listed = { name: LOCAL_CARRIER_BUNDLE, availability: 'profile', enabled: false, installed: true, rows: [], overrides: [] };
  const touched = [];
  const pluginManager = {
    async listBundles() { touched.push('list'); return [listed]; },
    async setBundleEnabled(name, enabled) { touched.push([name, enabled]); listed.enabled = enabled; return { application: 'restart-required' }; },
  };
  const { ctx, handler } = mountHost({ pluginManager });
  for (const peer of [{ principal: { kind: 'guest' } }, { kind: 'owner' }, undefined]) {
    assert.deepEqual(await askedAs(handler, peer, 'carrier-cache/status', {}), failure('forbidden', 'Only the owner of this host can manage the carrier cache.'));
    assert.deepEqual(await askedAs(handler, peer, 'carrier-cache/set', { enabled: true }), failure('forbidden', 'Only the owner of this host can manage the carrier cache.'));
  }
  assert.deepEqual(touched, [], 'the manager was not touched');
  assert.deepEqual(await askedAs(handler, OWNER, 'carrier-cache/status', undefined), { ok: true, value: { state: 'off' } });
  assert.deepEqual(await askedAs(handler, OWNER, 'carrier-cache/set', { enabled: true, name: '@other/bundle' }), { ok: true, value: { outcome: 'withdrawn', reason: 'restart-required' } });
  assert.deepEqual(touched.filter(each => Array.isArray(each)), [[LOCAL_CARRIER_BUNDLE, true], [LOCAL_CARRIER_BUNDLE, false]], 'the target is the switch\'s own, and a selection the manager left for a restart is withdrawn');
  assert.deepEqual(await askedAs(handler, OWNER, 'carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
  assert.deepEqual(await askedAs(handler, OWNER, 'carrier-cache/set', {}), failure('invalid_body', 'Body must contain { enabled: boolean }'));
  ctx.dispose();

  const bare = mountHost();
  assert.deepEqual(await askedAs(bare.handler, OWNER, 'carrier-cache/status', {}), { ok: true, value: { state: 'unavailable' } });
  assert.deepEqual(await askedAs(bare.handler, OWNER, 'carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'unavailable' } });
  bare.ctx.dispose();
});
