// The DSH host mounted on the real Cordis packages of the DSH checkout `SW_DSH_CHECKOUT` names, imported from it by file path; without the checkout the case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyHost, HOST_INJECT } from '../dsh/src/host.js';
import { openStore, closeStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { reusedCallIdAcrossSteps, userMessage, requestHeader } from './helpers/dsh-events.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const CORDIS = 'vendor/cordis/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, CORDIS)) ? `SW_DSH_CHECKOUT names no ${CORDIS}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

// The Claude Code set `test/index.mcp-wiring.test.js` holds, `rotate_session` removed.
const EXPECTED_TOOLS = [
  'get_bucket_summary', 'get_turn_skeleton', 'load_handoff', 'prepare_handoff',
  'submit_turn_notes', 'turn_locate', 'turn_page', 'turn_search',
  'watcher_status',
];
const EXPECTED_SKILLS = ['sw-explain', 'sw-handoff', 'sw-load'];

// The events' route and model id, and the catalog name the smoke's adapter gives it: one no policy row matches, so a price under the id cannot pass for one under the name.
const ROUTE = 'deepseek';
const MODEL = 'deepseek-v4-pro';
const CATALOG_NAME = 'Smoke Catalog Model';

// The `credentials` service Connection keeps its browser-session record in.
class RecordCredentials {
  record = undefined;
  async modifyRecord(_key, mutate) { const next = await mutate(this.record); if (next !== undefined) this.record = next; return this.record; }
}

// A client of the `/session-watcher` channel at `authority` holding `cookie`: each call POSTs the client-request envelope and answers the reply's `result`, failing the case on any status but 200 with the Cordis errors `ctx` logged.
function channelClient(ctx, authority, cookie) {
  let rpcSeq = 0;
  const post = (endpoint, payload, rpcId = `smoke-${++rpcSeq}`) => fetch(`http://${authority}/session-watcher/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
  });
  const call = async (endpoint, payload) => {
    const rpcId = `smoke-${++rpcSeq}`;
    const response = await post(endpoint, payload, rpcId);
    const body = await response.text();
    const errors = ctx.logger.buffer.filter(m => m.type === 'error').map(m => `[${m.name}] ${m.args.map(a => a?.message ?? String(a)).join(' ')}`);
    assert.equal(response.status, 200, `POST /session-watcher/${endpoint} answered ${response.status}; Cordis errors: ${JSON.stringify(errors)}`);
    const reply = JSON.parse(body);
    assert.equal(reply.rpcId, rpcId);
    return reply.result;
  };
  return { post, call };
}

// The events stream at `authority`, read a whole frame at a time; `next` answers null once the stream ends.
async function eventsClient(authority, cookie) {
  const response = await fetch(`http://${authority}/api/session-watcher.events`, { headers: { cookie } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const next = async () => {
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end !== -1) {
        const frame = buffered.slice(0, end + 2);
        buffered = buffered.slice(end + 2);
        return frame;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
    }
  };
  return { response, next };
}

// The value of a successful reply; a failed reply fails the case with its error.
function valueOf(reply, endpoint) {
  assert.ok(reply.ok, `${endpoint} answered ${JSON.stringify(reply.error)}`);
  return reply.value;
}

// The status of `sessionId` once it leaves `bootstrapping`, read over the channel a turn at a time.
async function untilSettled(call, sessionId) {
  for (;;) {
    const status = valueOf(await call('status', { sessionId }), 'status');
    if (status.state === 'failed') assert.fail(`the watcher failed: ${JSON.stringify(status.diagnostic)}`);
    if (status.state !== 'bootstrapping') return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// Every event of `events` appended to `session` as DSH's own append records it.
function appendAll(session, events) {
  for (const { type, data, surfaceOp, sourceEventSeqs } of events) {
    if (surfaceOp === undefined) session.append(type, data);
    else session.append(type, data, { surfaceOp, ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }) });
  }
}

test('the plugin loads on a real context, measures an appended session, serves its bucket over the channel and signals it over the events route on the real Connection and WebServer and registers the tool set and bootstraps a persisted-only session on the first request that names it, each priced under the real llm catalog name', {
  skip, timeout: 30_000,
}, async (t) => {
  const [
    { Context }, { SessionStore }, { SystemPrompt }, { ToolRuntime, defineTool }, { SkillRegistry }, { SessionQueryEngine },
    connectionPlugin, { WebServer }, { default: JsonlSessionPersistence }, { LlmRuntime, LlmAdapter },
  ] = await Promise.all([
    CORDIS,
    'packages/core/session/lib/index.js',
    'packages/core/system-prompt/lib/index.js',
    'packages/core/tools/lib/index.js',
    'packages/skill/skill/lib/index.js',
    'packages/session-query/session-query/lib/index.js',
    'packages/client/connection/lib/index.js',
    'packages/host/webserver/lib/index.js',
    'packages/session/session-persistence-jsonl/lib/index.js',
    'packages/llm/llm/lib/index.js',
  ].map(fromCheckout));

  // The catalog of the events' route: their model id under its name, any other id unknown.
  class CatalogAdapter extends LlmAdapter {
    async * stream() {}
    async resolveModel(provider, id) {
      if (id !== MODEL) throw Object.assign(new Error(`unknown model "${id}"`), { code: 'UNKNOWN_MODEL' });
      return { provider, id, name: CATALOG_NAME };
    }
  }

  class EmptySearchEngine extends SessionQueryEngine {
    searchSessions() { return Promise.resolve({ items: [] }); }
    async searchEvents(request) { return { session: (await this.readSurface(request.sessionId)).session, items: [] }; }
  }

  const dir = mkdtempSync(join(tmpdir(), 'sw-dsh-smoke-'));
  const storePath = join(dir, 'store.sqlite');
  _resetRateLampManagerForTest();
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    _resetRateLampManagerForTest();
    closeStoreGlobal();
    rmSync(dir, { recursive: true, force: true });
  });

  ctx.provide('credentials', new RecordCredentials());
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(SkillRegistry);
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') });
  await ctx.plugin(EmptySearchEngine);
  // Each its own plugin, as the Loader mounts them: `webServer` comes from a sibling fiber, not from the root.
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(connectionPlugin);
  await ctx.plugin(LlmRuntime);
  ctx.llm.registerAdapter([ROUTE], new CatalogAdapter());

  const fiber = ctx.plugin({
    name: 'session-watcher',
    inject: HOST_INJECT,
    // Cordis takes the value `apply` returns as an effect and rejects an object, so the table is discarded as the plugin face discards it.
    apply(pluginCtx) {
      applyHost(pluginCtx, { defineTool, storePath, turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null, skillsDir: SKILLS_DIR });
    },
  });
  await fiber;
  const authority = `127.0.0.1:${ctx.webServer.port}`;
  const login = new URL(ctx.connection.authenticatedUrl(`http://${authority}`));
  let cookie;
  ctx.connection.authorizeIndex(
    { headers: { host: authority }, method: 'GET', url: `${login.pathname}${login.search}` },
    { writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0]; }, end() {} },
  );
  assert.ok(cookie, 'the token exchange set no cookie');
  const { post, call } = channelClient(ctx, authority, cookie);

  const session = ctx.sessions.create(undefined, { meta: { cwd: dir } });
  const sessionId = session.id;
  // `session/created` is dispatched inside `create`, so before any append only that subscription can have made the entry.
  const created = valueOf(await call('status', { sessionId }), 'status');
  assert.equal(created.state, 'live', 'the entry session/created made is live before the first append');
  // The entry is live, so the header's warm-up is the live path's; the wait after it stands in for the request's round trip.
  const [opening, ...rest] = reusedCallIdAcrossSteps();
  appendAll(session, [opening, requestHeader({ model: MODEL })]);
  await new Promise(resolve => setImmediate(resolve));
  appendAll(session, rest);

  assert.equal((await untilSettled(call, sessionId)).state, 'live');

  // Prepared and never entered, so no event announces it: only the persisted listing knows the session.
  const storedId = 'smoke-persisted-only';
  const stored = ctx.sessions.prepare(storedId, { meta: { cwd: dir } });
  appendAll(stored, reusedCallIdAcrossSteps());
  const handle = await ctx.sessionPersistence.create(stored.header);
  await handle.append(stored.snapshotEvents());
  await handle.close();
  assert.deepEqual(valueOf(await call('status', { sessionId: storedId }), 'status'), { state: 'bootstrapping' });
  assert.equal((await untilSettled(call, storedId)).state, 'live');
  for (const id of [sessionId, storedId]) {
    assert.equal(valueOf(await call('pricing', { sessionId: id }), 'pricing').payload.modelDefault.model, CATALOG_NAME, id);
  }
  const buckets = valueOf(await call('buckets', { sessionId }), 'buckets');
  const { paths, residual } = buckets.payload;
  assert.ok(paths.length > 0 || Object.values(residual).some(family => family.length > 0), JSON.stringify(buckets.payload));

  // Opened once the session is live, so the frame it reads is the append's and not the install's.
  const events = await eventsClient(authority, cookie);
  assert.equal(events.response.status, 200);
  assert.equal(events.response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await events.next(), ': open\n\n', 'the first chunk is the comment frame');
  const unauthenticated = await fetch(`http://${authority}/api/session-watcher.events`);
  assert.equal(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
  const { type, data, surfaceOp } = userMessage({ text: 'Signal this.' });
  session.append(type, data, { surfaceOp });
  assert.equal(await events.next(), `data: ${JSON.stringify({ sessionId })}\n\n`, 'the append signals its session');

  assert.deepEqual(ctx.tools.schemas().map(schema => schema.name).sort(), EXPECTED_TOOLS);
  assert.deepEqual((await ctx.skills.list()).map(skill => skill.name).sort(), EXPECTED_SKILLS);

  await fiber.dispose();
  assert.equal((await post('status', { sessionId })).status, 404, 'the channel outlived the plugin');
  // The unload's archival removes each entry, whose signal may precede the stream's end.
  const signals = [sessionId, storedId].map(id => `data: ${JSON.stringify({ sessionId: id })}\n\n`);
  const unloadFrames = [];
  for (let frame = await events.next(); frame !== null; frame = await events.next()) unloadFrames.push(frame);
  assert.ok(unloadFrames.every(frame => signals.includes(frame)), `the open stream ended with the plugin after ${JSON.stringify(unloadFrames)}`);
  const afterUnload = await fetch(`http://${authority}/api/session-watcher.events`, { headers: { cookie } });
  assert.equal(afterUnload.status, 404, 'the events route outlived the plugin');
  await afterUnload.body?.cancel();
  const store = openStore(storePath);
  try {
    const rows = store._db.prepare('SELECT capture_source FROM profile WHERE session_id = ?').all(sessionId);
    assert.deepEqual(rows.map(row => row.capture_source), ['dsh-live']);
  } finally {
    closeStore(store);
  }
});
