// The `agent/pre-step` listener `applyHost` registers for the model name of a Context Epoch's first measured call: what it waits for, when it lets a step through at once, and the pricing the epoch's reads then show.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';

import { applyHost } from '../dsh/src/host.js';
import { closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { modelPolicyFor } from '../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../lib/constants.js';
import {
  assistantMessage, compactCheckpoint, requestHeader, sessionLog, stepEnd, stepStart, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';
import { createFakeContext, fakeSession } from './helpers/dsh-fake-context.js';
import { runShippedScenario, shippedEntrySkip } from './helpers/dsh-shipped-entry.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-epoch-model-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const ROUTE = 'deepseek';
// A route id that names no model family, and the catalog name that does: the two price apart.
const OPAQUE_ID = 'arn:aws:bedrock:us-east-2:111122223333:application-inference-profile/x1y2z3';
const OPUS_NAME = 'claude-opus-5-5';
const OTHER_ID = 'arn:aws:bedrock:us-east-2:111122223333:application-inference-profile/q7w8e9';
const OTHER_NAME = 'claude-haiku-4-5';
const USAGE = { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 };

const settled = () => new Promise(resolve => setImmediate(resolve));

const settledYet = async (promise) => {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await settled();
  return done;
};

// An llm service whose every `resolveModelInfo` stays pending until the test settles it; `calls` holds each call in order with its signal.
function heldCatalog() {
  const calls = [];
  const llm = {
    resolveModelInfo(provider, id, signal) {
      const deferred = Promise.withResolvers();
      calls.push({ provider, id, signal, name: name => deferred.resolve({ provider, id, name }), fail: error => deferred.reject(error) });
      return deferred.promise;
    },
    listConfigurableProviders: () => [],
  };
  return { llm, calls };
}

const webServer = {};

// The host over a fake context with a connection, whose `/session-watcher` handler answers `call`.
function mountHost({ sessions, llm, readSession = async () => ({ session: {}, inheritedEventCount: 0, events: [] }) }) {
  const handled = [];
  const connection = {
    rpc: { handle(channel, handler) { handled.push({ channel, handler }); return async () => {}; } },
    fetch: { register() { return async () => {}; } },
  };
  const ctx = createFakeContext({
    sessions, readSession, connection, webServer, llm,
  });
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'),
    loadIsIgnored: () => null, skillsDir: SKILLS_DIR,
  });
  return { ctx, table, call: (endpoint, payload) => handled[0].handler(endpoint, payload, new AbortController().signal, { kind: 'operator' }) };
}

// A decision whose every field stands out: the listener answers this very object.
const decisionOf = () => ({ kind: 'enter', messages: [userMessage({ text: 'next' })], startsRequestSeries: true });

// One `agent/pre-step` of `session` for `selection`, dispatched as the loop dispatches it; answers the promise of every listener's result.
function preStep(ctx, session, selection, { signal = new AbortController().signal, next = async () => decisionOf() } = {}) {
  const payload = { agent: { id: session.id, session }, messages: [], turn: 1, step: 1, signal, modelSelection: selection };
  return ctx.emit('agent/pre-step', payload, next);
}

const feed = (ctx, session, events) => { for (const event of events) ctx.emit('session/event', session, event); };

// The first call of a log, on `model`, reporting a usage unless `usage` is none.
const firstCall = (model, { usage = USAGE } = {}) => sessionLog([
  turnStart(), userMessage({ text: 'go' }), stepStart(), requestHeader({ model }), assistantMessage({ model, ...usage === null ? {} : { usage } }),
]);

// A log whose first epoch ends in a compact checkpoint, and whose second epoch's first call is on `model`: `before` holds the first epoch and the checkpoint, `after` the second epoch.
function twoEpochs(firstModel, model) {
  const user = userMessage({ text: 'go' });
  const call = assistantMessage({ model: firstModel, usage: USAGE });
  const log = sessionLog([
    turnStart(), user, stepStart(), requestHeader({ model: firstModel }), call, stepEnd(), turnEnd(),
    compactCheckpoint({ startSeq: user.seq, endSeq: call.seq }),
    turnStart({ turn: 2 }), userMessage({ text: 'again' }), stepStart({ turn: 2 }), requestHeader({ model, reason: 'change', startsSeries: true }),
    assistantMessage({ model, turn: 2, usage: USAGE }),
  ]);
  const boundary = log.findIndex(event => event.data?.source?.kind === 'compact-checkpoint');
  return { first: log.slice(0, boundary), checkpoint: log[boundary], after: log.slice(boundary + 1) };
}

const pricingOf = async (call, sessionId) => (await call('pricing', { sessionId })).value.payload;

test('a step that opens an epoch waits for the catalog name of its model and the call it sends is then priced under that name', async () => {
  assert.notEqual(modelPolicyFor(OPUS_NAME, DEFAULT_CACHE_TTL).cRatio, modelPolicyFor(OPAQUE_ID, DEFAULT_CACHE_TTL).cRatio, 'the name and the id price apart');
  const catalog = heldCatalog();
  const session = fakeSession({ id: 's-first' });
  const { ctx, call } = mountHost({ sessions: [session], llm: catalog.llm });
  await settled();

  const decision = decisionOf();
  const step = preStep(ctx, session, { provider: ROUTE, model: OPAQUE_ID }, { next: async () => decision });
  assert.equal(await settledYet(step), false, 'the step waits while the name is unresolved');
  assert.deepEqual(catalog.calls.map(({ provider, id }) => [provider, id]), [[ROUTE, OPAQUE_ID]]);

  catalog.calls[0].name(OPUS_NAME);
  const [answered] = await step;
  assert.equal(answered, decision, 'the decision next() answered is the answer, as it is');

  feed(ctx, session, firstCall(OPAQUE_ID));
  const payload = await pricingOf(call, session.id);
  assert.equal(payload.modelDefault.model, OPUS_NAME);
  assert.equal(payload.effective.ratio, modelPolicyFor(OPUS_NAME, DEFAULT_CACHE_TTL).cRatio);
  assert.equal(catalog.calls.length, 1, 'the header and the call find the name resolved');
  ctx.dispose();
});

// A host whose session has taken its first step on `OPAQUE_ID`, the catalog naming it `OPUS_NAME`; the call itself is the test's to feed.
async function anchoredHost({ readSession } = {}) {
  const catalog = heldCatalog();
  const session = fakeSession({ id: 's-anchored' });
  const host = mountHost({ sessions: [session], llm: catalog.llm, readSession });
  await settled();
  const step = preStep(host.ctx, session, { provider: ROUTE, model: OPAQUE_ID });
  await settled();
  catalog.calls[0].name(OPUS_NAME);
  await step;
  return { ...host, catalog, session };
}

test('a step that takes another model after the epoch\'s first call was measured goes through at once, and the epoch keeps pricing under its first model', async () => {
  const { ctx, call, catalog, session } = await anchoredHost();
  const first = firstCall(OPAQUE_ID);
  feed(ctx, session, first);
  assert.equal((await pricingOf(call, session.id)).modelDefault.model, OPUS_NAME);

  const decision = decisionOf();
  const step = preStep(ctx, session, { provider: ROUTE, model: OTHER_ID }, { next: async () => decision });
  assert.equal(await settledYet(step), true, 'the step does not wait for the name of the model it switches to');
  assert.equal((await step)[0], decision);
  assert.equal(catalog.calls.length, 1, 'no resolve is started for it');

  feed(ctx, session, sessionLog([
    ...first, requestHeader({ model: OTHER_ID, reason: 'change' }), assistantMessage({ model: OTHER_ID, step: 2, usage: USAGE }),
  ]).slice(first.length));
  const payload = await pricingOf(call, session.id);
  assert.equal(payload.modelDefault.model, OPUS_NAME);
  assert.equal(payload.effective.ratio, modelPolicyFor(OPUS_NAME, DEFAULT_CACHE_TTL).cRatio);
  ctx.dispose();
});

test('a step after a compact checkpoint waits for the name of the model it takes, and the new epoch prices under it', async () => {
  const { ctx, call, catalog, session } = await anchoredHost();
  const { first, checkpoint, after } = twoEpochs(OPAQUE_ID, OTHER_ID);
  feed(ctx, session, [...first, checkpoint]);

  const decision = decisionOf();
  const step = preStep(ctx, session, { provider: ROUTE, model: OTHER_ID }, { next: async () => decision });
  assert.equal(await settledYet(step), false, 'the checkpoint cleared the epoch model, so the step waits');
  assert.deepEqual(catalog.calls.slice(1).map(({ provider, id }) => [provider, id]), [[ROUTE, OTHER_ID]]);

  catalog.calls[1].name(OTHER_NAME);
  assert.equal((await step)[0], decision);
  feed(ctx, session, after);
  const payload = await pricingOf(call, session.id);
  assert.equal(payload.modelDefault.model, OTHER_NAME);
  assert.equal(payload.effective.ratio, modelPolicyFor(OTHER_NAME, DEFAULT_CACHE_TTL).cRatio);
  assert.notEqual(modelPolicyFor(OTHER_NAME, DEFAULT_CACHE_TTL).cRatio, modelPolicyFor(OPUS_NAME, DEFAULT_CACHE_TTL).cRatio, 'the epochs price apart');
  ctx.dispose();
});

test('a checkpoint another listener writes while the step is prepared is read after next(): the step waits for the model it takes', async () => {
  const { ctx, catalog, session } = await anchoredHost();
  const { first, checkpoint } = twoEpochs(OPAQUE_ID, OTHER_ID);
  feed(ctx, session, first);

  const decision = decisionOf();
  const step = preStep(ctx, session, { provider: ROUTE, model: OTHER_ID }, {
    next: async () => { feed(ctx, session, [checkpoint]); return decision; },
  });
  assert.equal(await settledYet(step), false);
  catalog.calls[1].name(OTHER_NAME);
  assert.equal((await step)[0], decision);
  ctx.dispose();
});

test('a call that reports no usage leaves the epoch model unfixed, so the next step waits for the name of the model it takes', async () => {
  const { ctx, catalog, session } = await anchoredHost();
  feed(ctx, session, firstCall(OPAQUE_ID, { usage: null }));
  const step = preStep(ctx, session, { provider: ROUTE, model: OTHER_ID });
  assert.equal(await settledYet(step), false);
  catalog.calls[1].name(OTHER_NAME);
  await step;
  ctx.dispose();
});

test('an abort ends the wait with its reason and cancels no resolve: a second session waiting on the same model keeps its wait and the name the resolve gives', async () => {
  const catalog = heldCatalog();
  const sessions = [fakeSession({ id: 's-aborted' }), fakeSession({ id: 's-waiting' })];
  const { ctx } = mountHost({ sessions, llm: catalog.llm });
  await settled();
  const abort = new AbortController();
  const selection = { provider: ROUTE, model: OPAQUE_ID };
  const aborted = preStep(ctx, sessions[0], selection, { signal: abort.signal });
  const decision = decisionOf();
  const waiting = preStep(ctx, sessions[1], selection, { next: async () => decision });
  await settled();
  assert.equal(catalog.calls.length, 1, 'both steps wait on one shared resolve');
  assert.equal(catalog.calls[0].signal, undefined, 'the resolve carries no caller\'s signal');

  const reason = new Error('turn cancelled');
  abort.abort(reason);
  await assert.rejects(aborted, error => error === reason);
  assert.equal(await settledYet(waiting), false, 'the other session still waits');

  catalog.calls[0].name(OPUS_NAME);
  assert.equal((await waiting)[0], decision);
  const again = preStep(ctx, sessions[0], selection);
  assert.equal(await settledYet(again), true, 'the resolved name is kept');
  assert.equal(catalog.calls.length, 1);
  ctx.dispose();
});

test('a wait that ended leaves no abort listener on its signal, which the steps of one run share', async () => {
  const catalog = heldCatalog();
  const session = fakeSession({ id: 's-run' });
  const { ctx } = mountHost({ sessions: [session], llm: catalog.llm });
  await settled();
  const { signal } = new AbortController();
  const selection = { provider: ROUTE, model: OPAQUE_ID };
  const first = preStep(ctx, session, selection, { signal });
  await settled();
  assert.equal(getEventListeners(signal, 'abort').length, 1, 'the wait listens while it waits');
  catalog.calls[0].name(OPUS_NAME);
  await first;
  // No call is measured, so each step waits again, on a name already resolved.
  for (let step = 0; step < 12; step += 1) await preStep(ctx, session, selection, { signal });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  ctx.dispose();
});

test('a signal aborted while the other listeners ran ends the step with its reason at once, the resolve still pending', async () => {
  const catalog = heldCatalog();
  const session = fakeSession({ id: 's-cancelled' });
  const { ctx } = mountHost({ sessions: [session], llm: catalog.llm });
  await settled();
  const abort = new AbortController();
  const reason = new Error('turn cancelled');
  const step = preStep(ctx, session, { provider: ROUTE, model: OPAQUE_ID }, {
    signal: abort.signal, next: async () => { abort.abort(reason); return decisionOf(); },
  });
  await assert.rejects(step, error => error === reason);
  assert.equal(catalog.calls.length, 1, 'the resolve started and is still pending');
  ctx.dispose();
});

test('a resolve that rejects ends the wait, the decision stands and the epoch is priced under the id', async (t) => {
  const rejections = [];
  const onUnhandled = reason => rejections.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const catalog = heldCatalog();
  const session = fakeSession({ id: 's-refused' });
  const { ctx, call } = mountHost({ sessions: [session], llm: catalog.llm });
  await settled();

  const decision = decisionOf();
  const step = preStep(ctx, session, { provider: ROUTE, model: OPAQUE_ID }, { next: async () => decision });
  await settled();
  catalog.calls[0].fail(Object.assign(new Error('no adapter registered'), { code: 'NO_ADAPTER' }));
  assert.equal((await step)[0], decision);

  feed(ctx, session, firstCall(OPAQUE_ID));
  const payload = await pricingOf(call, session.id);
  assert.equal(payload.modelDefault.model, OPAQUE_ID);
  assert.equal(payload.effective.ratio, modelPolicyFor(OPAQUE_ID, DEFAULT_CACHE_TTL).cRatio);
  await settled();
  assert.deepEqual(rejections, []);
  ctx.dispose();
});

test('a reject decision and a session the table has no live watcher for pass at once and start no resolve', async () => {
  const catalog = heldCatalog();
  const live = fakeSession({ id: 's-live' });
  const booting = fakeSession({ id: 's-booting' });
  const stranger = fakeSession({ id: 's-stranger' });
  const { ctx } = mountHost({
    sessions: [live, booting], llm: catalog.llm,
    readSession: sessionId => (sessionId === booting.id ? new Promise(() => {}) : Promise.resolve({ session: {}, inheritedEventCount: 0, events: [] })),
  });
  await settled();
  const selection = { provider: ROUTE, model: OPAQUE_ID };

  const rejected = { kind: 'reject' };
  assert.equal((await preStep(ctx, live, selection, { next: async () => rejected }))[0], rejected);
  for (const session of [booting, stranger]) {
    const decision = decisionOf();
    assert.equal((await preStep(ctx, session, selection, { next: async () => decision }))[0], decision, session.id);
  }
  assert.deepEqual(catalog.calls, []);
  ctx.dispose();
});

test('a step that waits for the name of its model delays no other session\'s step', async () => {
  const { ctx, catalog, session: anchored } = await anchoredHost();
  feed(ctx, anchored, firstCall(OPAQUE_ID));
  const waiting = fakeSession({ id: 's-first-step' });
  ctx.emit('session/created', waiting);
  await settled();
  const pending = preStep(ctx, waiting, { provider: ROUTE, model: OTHER_ID });
  await settled();
  assert.equal(catalog.calls.length, 2);

  const step = preStep(ctx, anchored, { provider: ROUTE, model: OTHER_ID });
  assert.equal(await settledYet(step), true);
  assert.equal(await settledYet(pending), false);
  catalog.calls[1].name(OTHER_NAME);
  await pending;
  ctx.dispose();
});

// ── The built entry on a real Cordis context and the real loop ───────────────

const CHECKOUT = process.env.SW_DSH_CHECKOUT;

test('the built entry over the real loop: the first step of a session waits for the catalog name of its model and the call it sends is priced under it', { skip: shippedEntrySkip(CHECKOUT), timeout: 90_000 }, (t) => {
  runShippedScenario(t, 'epoch-model-name', CHECKOUT);
});
