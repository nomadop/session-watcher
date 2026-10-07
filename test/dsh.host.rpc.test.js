// The `/session-watcher` RPC channel over the DSH host's watcher table: the state each reply carries, the payload each endpoint shares with its express route, the route's failure codes, and the pricing write's fan-out to every live watcher.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { createRpcHandler } from '../dsh/src/rpc.js';
import { getStore, openStore, closeStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest, getLiveLedger } from '../lib/rate-lamp-manager.js';
import { statusWire, statusWireWithLedger, bucketsPayload, overrideWarnings, pricingResponse } from '../lib/wire.js';
import { buildTurnBrowse } from '../lib/turn-browse.js';
import { lampZone } from '../lib/bill-regret.js';
import { forLoadedHandoff } from '../lib/lineage.js';
import { loadPricingOverride } from '../lib/pricing-store.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL, LONG_CACHE_TTL } from '../lib/constants.js';
import { initParser, loadGrammar } from '../lib/symbol-outline.js';
import { reusedCallIdAcrossSteps, header } from './helpers/dsh-events.js';
import { createFakeContext, fakeSession } from './helpers/dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

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

// The host over a fake context with a connection; `snapshots` maps a session id to its snapshot's events, empty unless given, and `listSessions` backs the persisted listing.
function mountHost({
  sessions = [], snapshots = {}, readSession, listSessions, llm, settings, loadIsIgnored = () => null,
} = {}) {
  const { handled, routes, connection } = fakeConnection();
  const read = readSession
    ?? (async sessionId => ({ session: {}, inheritedEventCount: 0, events: snapshots[sessionId] ?? [] }));
  const ctx = createFakeContext({ sessions, readSession: read, listSessions, connection, llm, settings });
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored,
    skillsDir: SKILLS_DIR,
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

// The log with every `assistant/message` under `model` and, when given, on `route`.
function logUnder({ model, route }) {
  return reusedCallIdAcrossSteps().map(event => {
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
  // The files the log reads exist under the session's cwd and the grammar is loaded, so a symbol-bearing buckets payload differs from the symbol-less one.
  await initParser({ wasmDir: join(NODE_MODULES, 'web-tree-sitter') });
  await loadGrammar('.js', { wasmDir: join(NODE_MODULES, 'tree-sitter-javascript') });
  const cwd = join(dir, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/a.js'), 'export function a() { return 1; }\n');
  writeFileSync(join(cwd, 'src/b.js'), 'export function b() { return 2; }\nexport default b;\n');
  const { ctx, table } = mountHost({
    sessions: [fakeSession({ id: sessionId, cwd })],
    snapshots: { [sessionId]: logUnder({ model: CLAUDE_MODEL, route }) },
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

  for (const endpoint of ['status', 'history', 'buckets', 'turn/browse', 'pricing']) {
    assert.equal((await call(handler, endpoint, { sessionId })).ok, true, endpoint);
  }
  assert.equal((await call(handler, 'preview', { sessionId, overrides: { '/repo/src/a.js': 'exclude' } })).ok, true);
  assert.equal((await call(handler, 'status', { sessionId: 's-nobody' })).ok, true);
  assert.deepEqual(published, []);
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
  // Armed once both are live: a throw while the log applies fails the watcher on the frame path instead.
  let broken = false;
  const throwing = () => {
    if (broken) throw new Error('matcher broke');
    return false;
  };
  const { ctx, table, handler } = mountHost({
    sessions: [fakeSession({ id: 's-throws', cwd: '/throws' }), fakeSession({ id: 's-clean', cwd: '/repo' })],
    snapshots: { 's-throws': log, 's-clean': log },
    loadIsIgnored: cwd => (cwd === '/throws' ? throwing : null),
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
    `s-throws [measurement-engine] resource_policy_invalid: resource policy for /throws/src/${file}.js is unusable; defaulting to selected`));
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

const ENDPOINTS = ['status', 'history', 'buckets', 'turn/browse', 'user-overrides', 'preview', 'pricing', 'pricing/save', 'pricing/delete'];

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
