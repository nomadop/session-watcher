// test/helpers/dsh-shipped-entry-child.js — one scenario of the shipped host entry on a real Cordis context, run in a fresh Node process by `test/dsh.host.smoke.test.js` and `test/dsh.inner-seal.integration.test.js`; the real loop it runs the loop scenarios in is `dsh-shipped-loop.js`'s.
// The process starts with `HOME`, `DSH_HOME` and `TMPDIR` inside the fixture the parent made. A temporary profile there links the DSH package of this repository; `loadProfileDirectory`, `createRuntimeResolution` and `PluginPackages` of the checkout's `dsh-app-boot` resolve the built `dsh/dist/index.js` and the peers it imports, and its exported plugin is mounted on the real Cordis `Context` beside the real session store, Connection and WebServer.
// The services the mode's child consumes are doubles, except in the `real-projection` and `created-recovery` scenarios, which mount the real `SessionProjectionRegistry` and `AgentRegistry`, and the loop scenarios, which mount the real loop's services. A scenario that fails an assertion exits non-zero with it on stderr.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fakeFs, fakeTokenMeter } from './dsh-fake-context.js';
import {
  channelOn, CHECKOUT, DSH_HOME, eventsOn, fromCheckout, IMPORTER, INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE, mountShippedLoop, PROFILE_DIR, RecordCredentials, REPLY_PADDING, SEAL_STEPS, SLOT_COUNT, sleep, slotNotes, turnOf,
} from './dsh-shipped-loop.js';
import { turnBoundaryOf } from './dsh-mode-kit.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../../lib/constants.js';
import { OFFICIAL_CARRIER_BUNDLE } from '../../dsh/src/carrier-cache-switch.js';
import carrierPackage from '../../dsh/carrier-cache/package.json' with { type: 'json' };
import hostPackage from '../../dsh/package.json' with { type: 'json' };

const [scenario] = process.argv.slice(2);
const MODE_RECORD_TYPE = 'plugin:session-watcher/inner-mode';

// The lines the host writes to stderr from here on, in order; the host's diagnostics and handler failures arrive as `console.error` lines.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => { stderrLines.push(args.map(String).join(' ')); realConsoleError(...args); };

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// A `sessionProjections` whose `register` records each definition and answers what `registration(definition, handleFor)` returns, a handle folding the session's log under the definition by default.
function projectionsDouble(registration) {
  const registered = [];
  const handleFor = definition => ({
    stateOf: session => session.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init()),
  });
  return {
    registered,
    handleFor,
    register(definition) {
      registered.push(definition);
      return registration === undefined ? Promise.resolve(handleFor(definition)) : registration(definition, handleFor);
    },
  };
}

// The `attachments` the real Connection reads its image body capacity from; the mode's child only waits for the service.
const attachmentsDouble = () => ({ imageLimits: { maxMessageImageBytes: 1024 } });

// An `agents` that states the turn boundary of a session's log, as the real service does for it.
const agentsDouble = () => ({ turnBoundaryOf: session => turnBoundaryOf(session) });



// The log of a session the store holds, as the session query service reads it, and for an id it neither holds nor lists the failure the service rejects with.
async function readHeld(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId);
  if (session === undefined) {
    const { SessionQueryError } = await fromCheckout('packages/session-query/session-query/lib/index.js');
    throw new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND');
  }
  return { session: {}, inheritedEventCount: 0, events: session.snapshotEvents() };
}

const callRecords = session => session.snapshotEvents().filter(event => event.type === INNER_CALL_RECORD_TYPE);

/**
 * The real context and its real session store, Connection and WebServer, the shipped entry mounted on them over the services in `provided`.
 * `readSession(sessionId)` is the persisted read the host's watcher table bootstraps from; the default reads the live session's own log. `listSessions` is the persisted listing the on-demand bootstrap reads, empty by default.
 * Answers the context, the entry's fiber, an authenticated `call(endpoint, payload)` over the real channel, the real events route's reader and the helpers a scenario drives.
 */
// `settings` is the entry's configuration as the Loader would hand it; these scenarios hold the mode child's wiring, in which a plain subagent is given its parent's mode, so the user's inheritance choice is on.
async function mountShipped({ provided, readSession, listSessions = async () => [], withRealRegistry = false, settings = { subagentsInheritCompaction: true } }) {
  const [
    { Context }, { SessionStore }, connectionPlugin, { WebServer }, appBoot,
  ] = await Promise.all([
    'vendor/cordis/lib/index.js',
    'packages/core/session/lib/index.js',
    'packages/client/connection/lib/index.js',
    'packages/host/webserver/lib/index.js',
    'packages/boot/app-boot/lib/index.js',
  ].map(fromCheckout));
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = appBoot;

  const installAnchor = join(CHECKOUT, 'apps/cli/package.json');
  const profile = loadProfileDirectory('sw-shipped-fixture', PROFILE_DIR, installAnchor, { userLayer: false });
  assert.deepEqual(profile.layers.map(layer => layer.packageName), ['@nomadop/session-watcher-dsh'], JSON.stringify(profile.skippedBundles));
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: DSH_HOME });

  const ctx = new Context();
  await ctx.plugin(PluginPackages, { resolution });
  // The entry and the peers it imports resolve through the profile's runtime resolution alone: the repository holds no DSH package.
  const { loadEntry } = await import(pathToFileURL(IMPORTER).href);
  const entry = await loadEntry();
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject', 'name']);

  ctx.provide('credentials', new RecordCredentials());
  await ctx.plugin(SessionStore);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(connectionPlugin);
  if (withRealRegistry) {
    const [{ SessionProjectionRegistry }, { AgentRegistry }] = await Promise.all([
      'packages/session/session-projection/lib/index.js',
      'packages/core/agent/lib/index.js',
    ].map(fromCheckout));
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(AgentRegistry);
  }
  const sessionQuery = {
    async readSession(sessionId) {
      if (readSession !== undefined) return readSession(sessionId);
      return readHeld(ctx, sessionId);
    },
    async listSessions() { return listSessions(); },
  };
  ctx.provide('sessionQuery', sessionQuery);
  ctx.provide('tools', { register() {} });
  ctx.provide('skills', { register() { return () => {}; } });
  ctx.provide('llm', {
    async resolveModelInfo(provider) { throw Object.assign(new Error(`no adapter for "${provider}"`), { code: 'NO_ADAPTER' }); },
    listConfigurableProviders: () => [],
  });
  const disposers = {};
  for (const [name, value] of Object.entries(provided)) disposers[name] = ctx.provide(name, value);

  const fiber = ctx.plugin({ name: entry.name, inject: entry.inject, Config: entry.Config, apply: entry.apply }, settings);
  await fiber;

  const channel = channelOn(ctx);
  // The frames the route has written so far, read until none arrives for `quiet` ms.
  const events = await eventsOn(channel);

  const errors = () => ctx.logger.buffer.filter(message => message.type === 'error');
  const finish = async () => {
    await events.close();
    await ctx.fiber.dispose();
  };
  return { ctx, fiber, call: channel.call, quiet: events.quiet, errors, finish, disposers };
}

// The session the real store lists, created blank in the fixture's directory.
const blankSession = (ctx, meta = {}) => ctx.sessions.create(undefined, { meta: { cwd: process.env.TMPDIR, ...meta } });

const modeRecords = session => session.snapshotEvents().filter(event => event.type === MODE_RECORD_TYPE).map(event => event.data);
const unavailable = { ok: false, error: { code: 'inner_mode_unavailable', message: 'The inner compaction mode is not available in this host.', details: {} } };

const MODE_KEY = 'session-watcher/inner-mode';
const MONITOR_KEY = 'session-watcher/inner-monitor';
const monitorUnavailable = { ok: false, error: { code: 'inner_monitor_unavailable', message: 'The inner compaction monitor is not available in this host.', details: {} } };

// Appends a plugin record to `session` as the log keeps it, through the shipped entry's own kit function; answers the record's seq.
async function appendRecord(session, type, data) {
  const { appendPluginRecord } = await fromCheckout('packages/core/session/lib/index.js');
  return appendPluginRecord(session, type, data);
}

// Appends the mode record to `session`.
async function appendModeRecord(session, data) {
  await appendRecord(session, MODE_RECORD_TYPE, data);
}

// The data of an attempt record over `count` seqs from `first`, its request showing `prompt` as the C tail.
const attemptData = (first, count, prompt) => ({
  v: 1,
  range: { first, last: first + count - 1, count },
  request: { options: { provider: 'mock', model: 'loop-model', purpose: 'inner-compaction' }, messages: { count: 0, tail: { role: 'user', content: [{ type: 'text', text: prompt }] } } },
});

// A counting semaphore: `acquire()` waits for a permit that `release()` gives, and `open()` gives every later `acquire()` its permit at once.
function semaphore() {
  const waiting = [];
  let permits = 0;
  let free = false;
  return {
    release() {
      const next = waiting.shift();
      if (next === undefined) permits += 1;
      else next();
    },
    open() {
      free = true;
      for (const next of waiting.splice(0)) next();
    },
    acquire() {
      if (free) return Promise.resolve();
      if (permits > 0) {
        permits -= 1;
        return Promise.resolve();
      }
      return new Promise(resolve => waiting.push(resolve));
    },
  };
}

// One `agent/pre-step` of `session` dispatched on `ctx` as the loop dispatches it, which must answer the final decision as it is.
async function preStep(ctx, session) {
  const decision = { kind: 'enter', messages: [] };
  const payload = { agent: { id: session.id, session }, messages: [], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'p', model: 'm' } };
  assert.equal(await ctx.waterfall('agent/pre-step', payload, async () => decision), decision, 'the pre-step answers the decision next() answers');
}

// The seal listener's one line for a session whose mode is invalid: what its presence leaves behind.
const invalidLines = session => stderrLines.filter(line => line.startsWith(`${session.id} `) && line.includes('inner_mode_invalid'));

// A blank session whose mode record does not read as a mode.
async function invalidSession(ctx) {
  const session = blankSession(ctx);
  await appendModeRecord(session, { v: 2 });
  return session;
}

const SCENARIOS = {
  // G4 through the shipped entry over the real loop beside the stock `compaction-basic` and session checkpoint policy, both mounted before the entry: the seal, prepended, runs ahead of both; the stock pressure check reads the sealed surface and leaves it, while the same history with the mode off is compacted by the stock; the checkpoint's pre-step flush persists the sealed surface.
  async 'loop-g4'() {
    const CONTEXT_WINDOW = 16_000;
    const THRESHOLD = 8_000;
    const big = Array.from({ length: 8_000 }, (_, index) => `word${index % 97}`).join(' ');
    const rig = await mountShippedLoop({
      contextWindow: CONTEXT_WINDOW,
      // A provider usage below the surface's own price, so the meter prices the surface itself.
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      reply: n => (n === SEAL_STEPS ? big : `reply ${n}`),
      async* summary(count) {
        const text = slotNotes(count);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
      stock: { compaction: { thresholdRatio: THRESHOLD / CONTEXT_WINDOW, headroomTokens: 0, maxTokens: 1_000, retainTokens: 500 } },
    });
    const { ctx, call, adapter, harness, llm } = rig;
    const isCarrier = event => event.data?.source?.kind === 'session-watcher-inner-seal';
    const flushes = [];
    ctx.on('session/flush', (session) => {
      flushes.push({
        sessionId: session.id, carrier: session.snapshotEvents().some(isCarrier),
        mains: adapter.requests.filter(request => !request.summary && request.sessionId === session.id).length,
      });
    });
    const pressure = session => ctx.tokenMeter.measure(session, session.requestHeader()).totalTokens;

    const agents = {};
    for (const [name, enabled] of [['sealed', true], ['control', false]]) {
      const agent = await harness.create(`g4-${name}-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
      assert.deepEqual(await call('inner-mode/select', { sessionId: agent.session.id, enabled }), { ok: true, value: {} });
      for (let turn = 1; turn <= SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
      assert.ok(pressure(agent.session) >= THRESHOLD, `${name}: the unsealed surface is above the stock threshold (${pressure(agent.session)})`);
      assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start'), [], `${name}: no stock compaction before the last step`);
      agents[name] = agent;
    }

    const { session } = agents.sealed;
    const sealedAt = session.seq;
    const mainsBefore = adapter.requests.filter(request => !request.summary && request.sessionId === session.id).length;
    await turnOf(agents.sealed, llm, 'the sealing turn');
    const sealedEvents = session.snapshotEvents().slice(sealedAt);
    const types = sealedEvents.map(event => event.type);
    const recordAt = types.indexOf(INNER_CALL_RECORD_TYPE);
    assert.deepEqual(types.slice(recordAt, recordAt + 3), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message'], `the seal: ${types.join(', ')}`);
    // The big reply is the range's savings: the seal is the quote's permission at the minimum count, not a step count's.
    assert.equal(sealedEvents[recordAt - 1].type, INNER_ATTEMPT_RECORD_TYPE, 'the call record follows the attempt record');
    const { quote } = sealedEvents[recordAt - 1].data;
    assert.ok(quote.trigger === 'quote' && quote.n === SEAL_STEPS && quote.sEst > 0 && (quote.arm === 'right' || quote.q < quote.kappa), `the quote permits the seal: ${JSON.stringify(quote)}`);
    assert.deepEqual(types.filter(type => type.startsWith('compaction/') && type !== 'compaction/prune'), [], 'the stock pressure check read the sealed surface and compacted nothing');
    assert.ok(pressure(session) < THRESHOLD, `the sealed surface is below the threshold (${pressure(session)})`);
    const afterSeal = flushes.filter(flush => flush.sessionId === session.id && flush.carrier && flush.mains === mainsBefore);
    assert.equal(afterSeal.length, 2, `the checkpoint's pre-step flush and the main request's checkpoint both persist the sealed surface: ${JSON.stringify(flushes.filter(flush => flush.sessionId === session.id).slice(-4))}`);
    const main = adapter.requests.filter(request => !request.summary && request.sessionId === session.id).at(-1);
    assert.ok(main.messages.some(message => message.source?.kind === 'session-watcher-inner-seal'), 'the main request carries the carrier');

    assert.deepEqual(ctx.logger.buffer.filter(message => message.args.some(arg => String(arg).includes('step compaction failed'))), [], 'the stock pressure check ran without failing');

    const control = agents.control.session;
    const controlAt = control.seq;
    await turnOf(agents.control, llm, 'the control turn');
    const controlTypes = control.snapshotEvents().slice(controlAt).map(event => event.type);
    assert.ok(controlTypes.includes('compaction/start'), `the same pressure with the mode off is compacted by the stock: ${controlTypes.join(', ')} ${JSON.stringify(ctx.logger.buffer.filter(message => message.type !== 'info' && message.type !== 'debug').map(message => message.args.map(String)).slice(-6))}`);
    assert.ok(!controlTypes.includes(INNER_CALL_RECORD_TYPE), 'and nothing is summarized by the seal');
    assert.equal(adapter.requests.filter(request => request.summary && request.sessionId === control.id).length, 0);
    await ctx.fiber.dispose();
  },

  // G3 through the shipped entry over the real loop: the mode chosen over the channel, a consumed summary stream that rejects outside its chunks ends the turn with the call record keeping the thrown error, and the next user message seals.
  async 'loop-g3'() {
    const rig = await mountShippedLoop({
      padding: REPLY_PADDING,
      async* summary(count) {
        const text = slotNotes(count);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    });
    // The llm service turns an adapter's throw into a finish chunk; a stream middleware's throw stays a rejection, outside the chunks. The first summary stream rejects after its first chunk.
    let rejectNext = true;
    rig.ctx.on('llm/stream', (options, next) => {
      const stream = next();
      if (!rejectNext || options.purpose !== 'inner-compaction') return stream;
      rejectNext = false;
      return (async function* () {
        for await (const chunk of stream) {
          yield chunk;
          throw new Error('the summary connection reset');
        }
      })();
    });
    const { ctx, call, adapter, harness, llm } = rig;
    const agent = await harness.create(`g3-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
    const { session } = agent;
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    for (let turn = 1; turn <= SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
    assert.deepEqual(await call('inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: true } });
    assert.deepEqual(callRecords(session), [], 'no seal below the threshold');
    assert.equal(adapter.requests.filter(request => request.summary).length, 0);

    const failedAt = session.seq;
    await turnOf(agent, llm, 'the failing turn');
    const failedEvents = session.snapshotEvents().slice(failedAt);
    const records = failedEvents.filter(event => event.type === INNER_CALL_RECORD_TYPE);
    assert.equal(records.length, 1, 'the consumed call is recorded once');
    // The shipped host's monitor records the attempt around the call: its start before the call, the failed end after it, naming one another.
    const failedFacts = failedEvents.filter(event => [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE].includes(event.type));
    assert.deepEqual(failedFacts.map(event => event.type), [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE]);
    assert.equal(records[0].data.attempt, failedFacts[0].seq, 'the call record names the attempt record');
    const { reason, ...ended } = failedFacts[2].data;
    assert.deepEqual(ended, { v: 1, attempt: failedFacts[0].seq, outcome: 'failed' });
    assert.match(reason, /^inner seal of session .* failed: the summary stream threw: .*the summary connection reset/);
    assert.ok(records[0].data.thrown !== undefined, `the record keeps the thrown error: ${JSON.stringify(records[0].data.stream)}`);
    assert.deepEqual(records[0].data.thrown, { message: records[0].data.thrown.message });
    assert.match(records[0].data.thrown.message, /the summary connection reset/);
    assert.ok(records[0].data.stream.length > 0, 'the record keeps the consumed chunks');
    assert.deepEqual(failedEvents.filter(event => event.type === 'compaction/prune' || event.data?.source?.kind === 'session-watcher-inner-seal'), [], 'nothing is sealed');
    const failedEnd = failedEvents.findLast(event => event.type === 'turn/end');
    assert.equal(failedEnd?.data.reason.kind, 'error', `the turn ends with the error: ${JSON.stringify(failedEnd?.data)}`);
    assert.equal(failedEvents.filter(event => event.type === 'assistant/message').length, 0, 'the step is not entered');
    const mainBefore = adapter.requests.filter(request => !request.summary).length;

    const sealedAt = session.seq;
    await turnOf(agent, llm, 'the next turn');
    const sealedEvents = session.snapshotEvents().slice(sealedAt);
    const types = sealedEvents.map(event => event.type);
    const recordAt = types.indexOf(INNER_CALL_RECORD_TYPE);
    assert.ok(recordAt >= 0, `the pre-step ran again: ${types.join(', ')}`);
    assert.deepEqual(types.slice(recordAt, recordAt + 3), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message'], 'the three appends, adjacent');
    assert.equal(sealedEvents[recordAt - 1].type, INNER_ATTEMPT_RECORD_TYPE, 'the attempt record opens them');
    assert.deepEqual(sealedEvents.filter(event => event.type === INNER_END_RECORD_TYPE), [], 'a commit writes no end record');
    const [record, prune, carrier] = sealedEvents.slice(recordAt, recordAt + 3);
    assert.equal(record.data.attempt, sealedEvents[recordAt - 1].seq);
    assert.equal(record.data.thrown, undefined);
    assert.equal(record.data.purpose, 'inner-compaction');
    assert.equal(carrier.data.source.kind, 'session-watcher-inner-seal');
    assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: record.data.range[0], endSeq: record.data.range.at(-1) });
    assert.ok(carrier.sourceEventSeqs.includes(record.seq) && carrier.sourceEventSeqs.includes(prune.seq));
    assert.equal(carrier.data.source.slots.length, record.data.range.length, 'one slot per request and per counted step');
    assert.ok(typeof carrier.data.id === 'string' && Object.isFrozen(carrier.data), 'the carrier message is the factory\'s');
    assert.ok(session.surface.nodes.includes(carrier.seq));
    const mainAfter = adapter.requests.filter(request => !request.summary);
    assert.equal(mainAfter.length, mainBefore + 1, 'the step is entered after the seal');
    assert.ok(mainAfter.at(-1).messages.some(message => message.source?.kind === 'session-watcher-inner-seal'), 'the main request carries the carrier');
    assert.equal(callRecords(session).length, 2);
    await ctx.fiber.dispose();
  },
  // The first step of a session over the real loop waits for the catalog name of its model: the built entry's listener has the real waterfall's `agent/pre-step` hold the step while the lookup it started is pending, so no request is sent and no request header logged, and the call the step then sends is priced under the name.
  async 'epoch-model-name'() {
    const NAME = 'claude-opus-5-5';
    const gate = deferred();
    const rig = await mountShippedLoop({ modelNames: { 'loop-model': NAME }, nameLookupGate: gate.promise });
    const { call, adapter, harness, llm } = rig;
    const agent = await harness.create(`epoch-name-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
    const { session } = agent;
    await sleep(50);
    const turn = turnOf(agent, llm, 'ask');
    await sleep(200);
    assert.deepEqual(adapter.lookups.filter(lookup => !lookup.signalled), [{ model: 'loop-model', signalled: false }], 'one name lookup, started by the listener');
    assert.equal(adapter.requests.length, 0, 'the first request waits for the name');
    assert.equal(session.snapshotEvents().some(event => event.type === 'request/header'), false, 'and no request header is logged');
    gate.resolve();
    await turn;
    assert.equal(adapter.requests.length, 1);
    const reply = await call('pricing', { sessionId: session.id });
    assert.equal(reply.ok, true);
    const { modelDefault, effective } = reply.value.payload;
    assert.equal(modelDefault.model, NAME);
    assert.equal(effective.ratio, modelPolicyFor(NAME, DEFAULT_CACHE_TTL).cRatio);
    assert.notEqual(effective.ratio, modelPolicyFor('loop-model', DEFAULT_CACHE_TTL).cRatio, 'the name and the id price apart');
    await rig.ctx.fiber.dispose();
  },
  // The entry's own Config: a deployment that saved nothing reads the defaults, so a plain subagent of a mode-on parent is left off, and the same entry configured to inherit gives it the parent's mode.
  async 'default-settings'() {
    const rig = await mountShipped({
      provided: { sessionProjections: projectionsDouble(), agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      settings: {},
    });
    const { ctx } = rig;
    const parent = blankSession(ctx);
    await appendModeRecord(parent, { v: 1, enabled: true });
    const child = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: child.id, session: child }, source: 'startup' });
    assert.deepEqual(modeRecords(child), [], 'the default is no inheritance');
    await rig.finish();

    // The same entry configured to inherit.
    const configured = await mountShipped({
      provided: { sessionProjections: projectionsDouble(), agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      settings: { subagentsInheritCompaction: true },
    });
    const owner = blankSession(configured.ctx);
    await appendModeRecord(owner, { v: 1, enabled: true });
    const inherits = blankSession(configured.ctx, { origin: 'subagent', parentSession: owner.id });
    await configured.ctx.serial('agent/created', { agent: { id: inherits.id, session: inherits }, source: 'startup' });
    assert.deepEqual(modeRecords(inherits), [{ v: 1, enabled: true }], 'the saved value is read');
    await configured.finish();
  },

  // The install target the entry gives the host names the official bundle at the version of the bundle's own package, which is not the host package's: the status offers that version, and the confirmed request hands the manager exactly that spec.
  async 'carrier-install-target'() {
    assert.notEqual(carrierPackage.version, hostPackage.version, 'the two packages version apart');
    const installs = [];
    const pluginManager = {
      listBundles: async () => [],
      installBundle: async (spec, options) => { installs.push([spec, options]); throw new Error('no registry in this scenario'); },
    };
    const rig = await mountShipped({ provided: { pluginManager }, settings: {} });
    assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'not-installed', install: { name: OFFICIAL_CARRIER_BUNDLE, version: carrierPackage.version } } });
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'install-failed' } });
    assert.deepEqual(installs, [[`${OFFICIAL_CARRIER_BUNDLE}@${carrierPackage.version}`, { enabled: false, saveExact: true }]]);
    await rig.finish();
  },

  // A registration still pending exposes no reader and no inheritance listener, to the channel or to events; resolving it publishes both.
  async 'pending'() {
    const registration = deferred();
    const projections = projectionsDouble(() => registration.promise);
    const rig = await mountShipped({
      provided: { sessionProjections: projections, agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
    });
    const { ctx, call } = rig;
    const parent = blankSession(ctx);
    await appendModeRecord(parent, { v: 1, enabled: true });
    assert.equal(projections.registered.length, 1, 'the child requested the registration');
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), unavailable, 'no reader while the registration is pending');
    assert.deepEqual(await call('inner-mode/select', { sessionId: parent.id, enabled: false }), unavailable);
    const early = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: early.id, session: early }, source: 'startup' });
    assert.deepEqual(modeRecords(early), [], 'no inheritance listener while the registration is pending');
    assert.deepEqual(stderrLines, [], 'and no listener ran and failed on the missing registration');
    await rig.quiet();
    await appendModeRecord(parent, { v: 1, enabled: true });
    assert.deepEqual(await rig.quiet(), [], 'no mode-input listener while the registration is pending');
    const invalid = await invalidSession(ctx);
    await preStep(ctx, invalid);
    assert.deepEqual(invalidLines(invalid), [], 'no seal listener while the registration is pending');
    // Registered before the seal listener, which is prepended ahead of it.
    const seenBySibling = [];
    ctx.on('agent/pre-step', ({ agent }, next) => { seenBySibling.push(invalidLines(agent.session).length); return next(); });

    registration.resolve(projections.handleFor(projections.registered[0]));
    await sleep(50);
    await preStep(ctx, invalid);
    assert.equal(invalidLines(invalid).length, 1, 'the seal listener once resolved');
    assert.deepEqual(seenBySibling, [1], 'the seal listener runs before a pre-step listener registered ahead of it');
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), { ok: true, value: { mode: 'on', locked: false } }, 'the reader once resolved');
    const late = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: late.id, session: late }, source: 'startup' });
    assert.deepEqual(modeRecords(late), [{ v: 1, enabled: true }], 'the inheritance listener once resolved');
    const off = blankSession(ctx);
    await appendModeRecord(off, { v: 1, enabled: false });
    const blank = blankSession(ctx);
    for (const [parentOf, why] of [[off, 'an off parent'], [blank, 'a blank parent']]) {
      const child = blankSession(ctx, { origin: 'subagent', parentSession: parentOf.id });
      await ctx.serial('agent/created', { agent: { id: child.id, session: child }, source: 'startup' });
      assert.deepEqual(modeRecords(child), [{ v: 1, enabled: false }], `the child of ${why} records the parent's mode`);
      assert.deepEqual(await call('inner-mode', { sessionId: child.id }), { ok: true, value: { mode: 'off', locked: false } });
    }
    await rig.finish();
  },

  // A rejected registration fails the child through Cordis and leaves neither the reader nor the listener published.
  async 'rejected'() {
    const projections = projectionsDouble(() => Promise.reject(new Error('registration refused')));
    const rig = await mountShipped({
      provided: { sessionProjections: projections, agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
    });
    const { ctx, call } = rig;
    await sleep(50);
    assert.equal(projections.registered.length, 1);
    assert.ok(rig.errors().some(message => message.args.some(arg => String(arg?.message ?? arg).includes('registration refused'))), 'Cordis logged the rejection');
    const parent = blankSession(ctx);
    await appendModeRecord(parent, { v: 1, enabled: true });
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), unavailable, 'no reader after the rejection');
    assert.deepEqual(await call('inner-mode/select', { sessionId: parent.id, enabled: false }), unavailable);
    const child = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: child.id, session: child }, source: 'startup' });
    assert.deepEqual(modeRecords(child), [], 'no inheritance listener after the rejection');
    assert.deepEqual(stderrLines, [], 'and no listener ran and failed on the missing registration');
    await rig.quiet();
    await appendModeRecord(parent, { v: 1, enabled: true });
    assert.deepEqual(await rig.quiet(), [], 'no mode-input listener after the rejection');
    const invalid = await invalidSession(ctx);
    await preStep(ctx, invalid);
    assert.deepEqual(invalidLines(invalid), [], 'no seal listener after the rejection');
    await rig.finish();
  },

  // Disposing the child clears the reader and removes the listeners it owns.
  async 'disposed'() {
    const projections = projectionsDouble();
    const rig = await mountShipped({
      provided: { sessionProjections: projections, agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
    });
    const { ctx, call } = rig;
    const parent = blankSession(ctx);
    await appendModeRecord(parent, { v: 1, enabled: true });
    await sleep(50);
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), { ok: true, value: { mode: 'on', locked: false } });
    const first = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: first.id, session: first }, source: 'startup' });
    assert.deepEqual(modeRecords(first), [{ v: 1, enabled: true }]);
    const invalid = await invalidSession(ctx);
    await preStep(ctx, invalid);
    assert.equal(invalidLines(invalid).length, 1, 'the seal listener is registered on the child');

    rig.disposers.fs();
    await sleep(50);
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), unavailable, 'the reader is cleared with the child');
    assert.deepEqual(await call('inner-mode/select', { sessionId: parent.id, enabled: false }), unavailable);
    const second = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: second.id, session: second }, source: 'startup' });
    assert.deepEqual(modeRecords(second), [], 'the inheritance listener left with the child');
    const blank = blankSession(ctx);
    const third = blankSession(ctx, { origin: 'subagent', parentSession: blank.id });
    await ctx.serial('agent/created', { agent: { id: third.id, session: third }, source: 'startup' });
    assert.deepEqual(modeRecords(third), [], 'and records no off mode of a blank parent either');
    await rig.quiet();
    await appendModeRecord(parent, { v: 1, enabled: false });
    assert.deepEqual(await rig.quiet(), [], 'the mode-input listener left with the child');
    const later = await invalidSession(ctx);
    await preStep(ctx, later);
    assert.deepEqual(invalidLines(later), [], 'the seal listener left with the child');
    assert.deepEqual(rig.errors(), [], 'the disposal threw nothing');
    await rig.finish();
  },

  // Publishing or clearing the reader emits each listed session's id, a session whose measurement failed among them, and `turn/start` emits its session's id with no measurement frame behind it.
  async 'frames'() {
    const registration = deferred();
    const projections = projectionsDouble(() => registration.promise);
    const rig = await mountShipped({
      provided: { sessionProjections: projections, agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      readSession: async (sessionId) => {
        if (sessionId === 's-measure-failed') throw new Error('read refused');
        return readHeld(ctx, sessionId);
      },
    });
    const { ctx, call } = rig;
    const healthy = ctx.sessions.create('s-measure-healthy', { meta: { cwd: process.env.TMPDIR } });
    const failed = ctx.sessions.create('s-measure-failed', { meta: { cwd: process.env.TMPDIR } });
    await sleep(100);
    assert.equal((await call('status', { sessionId: failed.id })).value.state, 'failed');
    assert.equal((await call('status', { sessionId: healthy.id })).value.state, 'live');
    await rig.quiet();

    registration.resolve(projections.handleFor(projections.registered[0]));
    assert.deepEqual((await rig.quiet()).sort(), [failed.id, healthy.id].sort(), 'publishing the reader emits every listed session once, the failed one too');

    failed.append('turn/start', { turn: 1 });
    assert.deepEqual(await rig.quiet(), [failed.id], 'turn/start emits its session\'s id, with no measurement behind it');
    assert.deepEqual(await call('inner-mode', { sessionId: failed.id }), { ok: true, value: { mode: 'off', locked: true } });

    rig.disposers.tokenMeter();
    assert.deepEqual((await rig.quiet()).sort(), [failed.id, healthy.id].sort(), 'clearing the reader emits every listed session once');
    assert.deepEqual(await call('inner-mode', { sessionId: failed.id }), unavailable);
    await rig.finish();
  },

  // The real `SessionProjectionRegistry`, `AgentRegistry` and sessions: blank selections emit their session frame and the reads show off, on, off, unlocked; a locked, unavailable or malformed selection answers its failure envelope with no record appended and no frame emitted.
  async 'real-projection'() {
    const rig = await mountShipped({
      withRealRegistry: true,
      provided: { fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      readSession: async () => { throw new Error('read refused'); },
    });
    const { ctx, call } = rig;
    // Its measurement fails, so a frame for it can only be the mode's.
    const session = ctx.sessions.create('s-real-projection', { meta: { cwd: process.env.TMPDIR } });
    await sleep(100);
    assert.equal((await call('status', { sessionId: session.id })).value.state, 'failed');
    const read = async () => (await call('inner-mode', { sessionId: session.id })).value;
    assert.deepEqual(await read(), { mode: 'off', locked: false });
    await rig.quiet();

    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    assert.deepEqual(await rig.quiet(), [session.id], 'a selection emits its session\'s frame');
    assert.deepEqual(await read(), { mode: 'on', locked: false });
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: false }), { ok: true, value: {} });
    assert.deepEqual(await rig.quiet(), [session.id]);
    assert.deepEqual(await read(), { mode: 'off', locked: false });
    assert.deepEqual(modeRecords(session), [{ v: 1, enabled: true }, { v: 1, enabled: false }]);

    const refusal = async (payload, envelope, why) => {
      const before = modeRecords(session).length;
      const reply = await call('inner-mode/select', payload);
      assert.equal(reply.ok, false, why);
      assert.equal(reply.error.code, envelope, why);
      assert.equal(modeRecords(session).length, before, `${why} appended a record`);
      assert.deepEqual(await rig.quiet(), [], `${why} emitted a frame`);
    };
    await refusal({ sessionId: session.id, enabled: 'yes' }, 'invalid_body', 'a malformed body');
    await refusal({ sessionId: 's-nobody', enabled: true }, 'inner_mode_unavailable', 'a session the host does not hold');

    session.append('turn/start', { turn: 1 });
    assert.deepEqual(await rig.quiet(), [session.id], 'turn/start emits its session\'s frame');
    assert.deepEqual(await read(), { mode: 'off', locked: true });
    await refusal({ sessionId: session.id, enabled: true }, 'inner_mode_locked', 'a locked session');
    assert.deepEqual(await read(), { mode: 'off', locked: true });

    rig.disposers.attachments();
    await rig.quiet();
    await refusal({ sessionId: session.id, enabled: true }, 'inner_mode_unavailable', 'a withdrawn reader');
    await rig.finish();
  },

  // The monitor's projection is registered after the mode's and awaited, its access published with the mode's in one signal per listed session and withdrawn with it; a read shows the attempts of a session's log whatever its measurement says, and a monitor record signals its session once.
  async 'monitor-access'() {
    const modeRegistration = deferred();
    const projections = projectionsDouble((definition, handleFor) => (definition.key === MONITOR_KEY ? Promise.resolve(handleFor(definition)) : modeRegistration.promise));
    const rig = await mountShipped({
      provided: { sessionProjections: projections, agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      readSession: async (sessionId) => {
        if (sessionId === 's-measure-failed') throw new Error('read refused');
        return readHeld(ctx, sessionId);
      },
    });
    const { ctx, call } = rig;
    const healthy = ctx.sessions.create('s-monitor-healthy', { meta: { cwd: process.env.TMPDIR } });
    const failed = ctx.sessions.create('s-measure-failed', { meta: { cwd: process.env.TMPDIR } });
    await sleep(100);
    assert.equal((await call('status', { sessionId: failed.id })).value.state, 'failed');
    assert.equal((await call('status', { sessionId: healthy.id })).value.state, 'live');
    assert.deepEqual(await call('inner-monitor', { sessionId: healthy.id }), monitorUnavailable, 'no access while the mode registration is pending');
    assert.deepEqual(projections.registered.map(definition => definition.key), [MODE_KEY], 'the monitor is not asked for ahead of the mode');
    await rig.quiet();

    modeRegistration.resolve(projections.handleFor(projections.registered[0]));
    assert.deepEqual((await rig.quiet()).sort(), [failed.id, healthy.id].sort(), 'the two accesses appear in one signal per listed session');
    assert.deepEqual(projections.registered.map(definition => definition.key), [MODE_KEY, MONITOR_KEY], 'the monitor follows the mode');

    for (const session of [failed, healthy]) {
      assert.deepEqual(await call('inner-monitor', { sessionId: session.id }), { ok: true, value: { attempts: [], handoffs: [] } }, `${session.id} reads whatever its measurement says`);
    }
    assert.deepEqual(await call('inner-monitor', { sessionId: 's-nobody' }), monitorUnavailable, 'a session the host does not hold');

    const startSeq = await appendRecord(failed, INNER_ATTEMPT_RECORD_TYPE, attemptData(3, 2, 'the prompt'));
    assert.deepEqual(await rig.quiet(), [failed.id], 'an attempt record emits its session\'s frame once');
    const { value } = await call('inner-monitor', { sessionId: failed.id });
    assert.deepEqual(value.attempts.map(row => [row.id, row.status, row.range, row.call.input, row.call.outputDisplay]), [[startSeq, 'unknown', { first: 3, last: 4, count: 2 }, 'the prompt', null]]);
    await appendRecord(failed, 'plugin:other/thing', { v: 1 });
    assert.deepEqual(await rig.quiet(), [], 'another plugin\'s record emits no frame');

    rig.disposers.tokenMeter();
    assert.deepEqual((await rig.quiet()).sort(), [failed.id, healthy.id].sort(), 'the withdrawal emits every listed session once');
    assert.deepEqual(await call('inner-monitor', { sessionId: failed.id }), monitorUnavailable);
    assert.deepEqual(await call('inner-mode', { sessionId: failed.id }), unavailable);
    await rig.finish();
  },

  // A monitor registration that is refused costs its own access alone: the mode is read and selected, a new subagent takes its parent's mode and the seal listener, prepended, stands, while the monitor answers unavailable; the refusal is one stderr line, not a failed child, and is not retried.
  async 'monitor-refused'() {
    const modeRegistration = deferred();
    const projections = projectionsDouble(definition => (definition.key === MONITOR_KEY
      ? Promise.reject(new Error('monitor registration refused')) : modeRegistration.promise));
    const rig = await mountShipped({
      provided: { sessionProjections: projections, agents: agentsDouble(), fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
    });
    const { ctx, call } = rig;
    const parent = blankSession(ctx);
    await appendModeRecord(parent, { v: 1, enabled: true });
    const invalid = await invalidSession(ctx);
    // Registered before the seal listener, which is prepended ahead of it once the mode registration resolves.
    const seenBySibling = [];
    ctx.on('agent/pre-step', ({ agent }, next) => { seenBySibling.push(invalidLines(agent.session).length); return next(); });
    await rig.quiet();
    assert.deepEqual(projections.registered.map(definition => definition.key), [MODE_KEY], 'the monitor is not asked for ahead of the mode');

    modeRegistration.resolve(projections.handleFor(projections.registered[0]));
    await sleep(100);
    const appeared = (await rig.quiet()).sort();
    assert.deepEqual(projections.registered.map(definition => definition.key), [MODE_KEY, MONITOR_KEY], 'the monitor was asked for once, after the mode');

    // What the mode wired stands: the inheritance listener, the seal listener ahead of one registered before it, the reader and the selection.
    const child = blankSession(ctx, { origin: 'subagent', parentSession: parent.id });
    await ctx.serial('agent/created', { agent: { id: child.id, session: child }, source: 'startup' });
    assert.deepEqual(modeRecords(child), [{ v: 1, enabled: true }], 'the inheritance listener stands');
    await preStep(ctx, invalid);
    assert.equal(invalidLines(invalid).length, 1, 'the seal listener stands');
    assert.deepEqual(seenBySibling, [1], 'and runs ahead of a pre-step listener registered before it');
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), { ok: true, value: { mode: 'on', locked: false } }, 'the mode reader stands');
    assert.deepEqual(await call('inner-mode/select', { sessionId: parent.id, enabled: false }), { ok: true, value: {} }, 'the selection stands');
    assert.deepEqual(appeared, [invalid.id, parent.id].sort(), 'the mode access appeared all the same, once per listed session');

    // The refusal costs the monitor alone: the access was never published, one line says why, no child failed and nothing asked again.
    assert.deepEqual(await call('inner-monitor', { sessionId: parent.id }), monitorUnavailable, 'the monitor access was never published');
    assert.deepEqual(stderrLines.filter(line => line.includes('inner_monitor_register')), ['[dsh-host] inner_monitor_register: monitor registration refused']);
    assert.deepEqual(rig.errors(), [], 'the refusal failed no child: Cordis logged no error');
    assert.deepEqual(projections.registered.map(definition => definition.key), [MODE_KEY, MONITOR_KEY], 'and nothing registered the monitor again');

    rig.disposers.fs();
    await sleep(50);
    assert.deepEqual(await call('inner-mode', { sessionId: parent.id }), unavailable, 'the mode access leaves with the child');
    assert.deepEqual(await call('inner-monitor', { sessionId: parent.id }), monitorUnavailable);
    await rig.finish();
  },

  // A page that read the mode unavailable and no attempts before the session's instance existed, over a table entry the persisted listing had already made and a stored log that has started no turn, is signalled by the instance's announcement: the events stream carries the id, and the mode and the idle session's recorded attempt read, with no summary request behind them.
  async 'created-recovery'() {
    const id = 's-recover';
    const rig = await mountShipped({
      withRealRegistry: true,
      provided: { fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      listSessions: async () => [{ header: { version: 4, id, createdAt: 1, isSeeded: false, cwd: process.env.TMPDIR }, live: false, persisted: true }],
      readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }),
    });
    const { ctx, call } = rig;
    assert.deepEqual(await call('status', { sessionId: id }), { ok: true, value: { state: 'bootstrapping' } }, 'the persisted listing makes the table entry');
    await sleep(100);
    assert.equal((await call('status', { sessionId: id })).value.state, 'live');
    assert.deepEqual(await call('inner-mode', { sessionId: id }), unavailable, 'the store holds no instance yet, and its stored log has started no turn');
    assert.deepEqual(await call('inner-monitor', { sessionId: id }), { ok: true, value: { attempts: [], handoffs: [] } }, 'the stored log has no attempt');
    await rig.quiet();

    const { Session, appendPluginRecord } = await fromCheckout('packages/core/session/lib/index.js');
    const origin = Session.create('s-recover-origin', undefined, { version: 4, id: 's-recover-origin', createdAt: 1, isSeeded: false, cwd: process.env.TMPDIR }, 0);
    const startSeq = appendPluginRecord(origin, INNER_ATTEMPT_RECORD_TYPE, attemptData(0, 1, 'the earlier prompt'));
    // As a fork's child is created, its seed the history it inherits.
    const seed = origin.snapshotEvents();
    ctx.sessions.create(id, { seed, inheritedEventCount: seed.length, meta: { cwd: process.env.TMPDIR, isSeeded: true } });
    assert.deepEqual(await rig.quiet(), [id], 'the announcement reaches the events stream although the table holds the entry');
    assert.deepEqual(await call('inner-mode', { sessionId: id }), { ok: true, value: { mode: 'off', locked: false } }, 'the mode baseline recovers');
    const { value } = await call('inner-monitor', { sessionId: id });
    assert.deepEqual(value.attempts.map(row => [row.id, row.status, row.call.input]), [[startSeq, 'unknown', 'the earlier prompt']], 'the idle session\'s recorded attempt reads');
    await rig.finish();
  },

  // A finished session the real store has detached answers the mode and its attempts over the shipped entry on the real projection registry from its stored log, with no instance of it held and no watcher made for it.
  async 'stored-read'() {
    const stored = new Map();
    const rig = await mountShipped({
      withRealRegistry: true,
      provided: { fs: fakeFs(), attachments: attachmentsDouble(), tokenMeter: fakeTokenMeter() },
      readSession: async (sessionId) => {
        const known = stored.get(sessionId);
        return known === undefined ? readHeld(ctx, sessionId) : { session: known.header, inheritedEventCount: 0, events: known.snapshotEvents() };
      },
    });
    const { ctx, call } = rig;
    const session = ctx.sessions.prepare('s-stored', { meta: { cwd: process.env.TMPDIR } });
    const detach = ctx.sessions.enter(session);
    ctx.sessions.announce(session);
    await appendModeRecord(session, { v: 1, enabled: true });
    session.append('turn/start', { turn: 1 });
    const startSeq = await appendRecord(session, INNER_ATTEMPT_RECORD_TYPE, attemptData(0, 1, 'the earlier prompt'));
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await sleep(100);
    assert.deepEqual(await call('inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: true } }, 'the instance answers while the store holds it');

    stored.set(session.id, session);
    detach();
    await sleep(100);
    assert.equal(ctx.sessions.get(session.id), undefined, 'the store no longer holds the session');
    assert.deepEqual(await call('status', { sessionId: session.id }), { ok: true, value: { state: 'unobserved' } }, 'and no watcher stands for it');
    assert.deepEqual(await call('inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: true } });
    const { value } = await call('inner-monitor', { sessionId: session.id });
    assert.deepEqual(value.attempts.map(row => [row.id, row.status, row.call.input]), [[startSeq, 'unknown', 'the earlier prompt']]);
    assert.deepEqual(await call('status', { sessionId: session.id }), { ok: true, value: { state: 'unobserved' } }, 'the reads made no watcher');
    assert.deepEqual(modeRecords(session), [{ v: 1, enabled: true }], 'and wrote nothing');
    await rig.finish();
  },

  // The monitor through the real loop and the real projection registry: a failed attempt reads failed with the call it consumed, an attempt in flight reads generating with the response so far and each chunk of it is one signal on the events stream with no event behind it, and the sealed attempt reads committed with the facts of the log, no request sent for the reads.
  async 'loop-monitor'() {
    const gate = semaphore();
    let hold = false;
    const firstHalf = count => slotNotes(count).slice(0, Math.floor(slotNotes(count).length / 2));
    const rig = await mountShippedLoop({
      events: true,
      padding: REPLY_PADDING,
      async* summary(count) {
        const text = slotNotes(count);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: firstHalf(count) };
        if (hold) await gate.acquire();
        yield { type: 'text-delta', index: 0, text: text.slice(firstHalf(count).length) };
        if (hold) await gate.acquire();
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    });
    // The first summary stream rejects after its first chunk, outside the chunks.
    let rejectNext = true;
    rig.ctx.on('llm/stream', (options, next) => {
      const stream = next();
      if (!rejectNext || options.purpose !== 'inner-compaction') return stream;
      rejectNext = false;
      return (async function* () {
        for await (const chunk of stream) {
          yield chunk;
          throw new Error('the summary connection reset');
        }
      })();
    });
    const { ctx, call, adapter, harness, llm, events } = rig;
    const agent = await harness.create(`monitor-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
    const { session } = agent;
    const rowsNow = async () => {
      const reply = await call('inner-monitor', { sessionId: session.id });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.value.attempts;
    };
    const factsOf = type => session.snapshotEvents().filter(event => event.type === type);
    const summaryRequests = () => adapter.requests.filter(request => request.summary).length;
    // The slots the model is asked for, as the attempt's request tail numbers them: a user's own slot takes a note the program wrote and no number.
    const askedOf = start => Number(SLOT_COUNT.exec(start.data.request.messages.tail.content.map(block => block.text).join(''))?.[1]);
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    for (let turn = 1; turn <= SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
    assert.deepEqual(await rowsNow(), [], 'no attempt below the threshold');

    await turnOf(agent, llm, 'the failing turn');
    const [failedStart] = factsOf(INNER_ATTEMPT_RECORD_TYPE);
    const [failedCall] = factsOf(INNER_CALL_RECORD_TYPE);
    const [failedEnd] = factsOf(INNER_END_RECORD_TYPE);
    assert.ok(failedStart !== undefined && failedCall !== undefined && failedEnd !== undefined, 'the failed attempt left its facts');
    const [failedRow, ...otherRows] = await rowsNow();
    assert.deepEqual(otherRows, []);
    assert.deepEqual(
      [failedRow.id, failedRow.revision, failedRow.status, failedRow.legacy, failedRow.startedAt, failedRow.endedAt, failedRow.slots],
      [failedStart.seq, failedEnd.seq, 'failed', false, failedStart.time, failedEnd.time, null],
      'a call without a carrier is no commit',
    );
    assert.equal(failedRow.reason, failedEnd.data.reason);
    assert.deepEqual([failedRow.call.state, failedRow.call.finish, failedRow.call.endedAt], ['error', null, failedCall.data.endedAt]);
    assert.match(failedRow.call.thrown, /the summary connection reset/);
    assert.equal(summaryRequests(), 1);

    hold = true;
    const sealing = turnOf(agent, llm, 'the next turn');
    let inFlight;
    for (let tries = 0; tries < 200 && inFlight === undefined; tries += 1) {
      const rows = await rowsNow();
      if (rows.length === 2 && rows[1].status === 'generating' && rows[1].call.output === firstHalf(askedOf(factsOf(INNER_ATTEMPT_RECORD_TYPE).at(-1)))) inFlight = rows[1];
      else await sleep(25);
    }
    assert.ok(inFlight !== undefined, 'the attempt in flight reads generating with the response so far');
    const [start] = factsOf(INNER_ATTEMPT_RECORD_TYPE).slice(-1);
    const asked = askedOf(start);
    // What the list shows of the quote the attempt triggered on; no Context Epoch boundary stands in this log.
    const { quote } = start.data;
    const quoted = { trigger: { q: quote.q, kappa: quote.kappa }, stepN: quote.n, cRatio: quote.cRatio, epoch: 0 };
    const prompt = start.data.request.messages.tail.content.filter(block => block.type === 'text').map(block => block.text).join('');
    assert.deepEqual(inFlight, {
      id: start.seq, revision: start.seq, status: 'generating', legacy: false, startedAt: start.time, endedAt: null,
      range: start.data.range, reason: null, slots: null,
      call: { state: 'generating', endedAt: null, finish: null, thrown: null, input: prompt.slice(0, 500), output: firstHalf(asked), outputDisplay: firstHalf(asked), usage: null },
      contextChange: null, ...quoted,
    });
    await events.quiet(150);
    const seqBefore = session.seq;
    gate.release();
    assert.deepEqual(await events.quiet(150), [session.id], 'one chunk is one signal on the events stream');
    assert.equal(session.seq, seqBefore, 'and no event stands behind it');
    assert.equal((await rowsNow())[1].call.output, slotNotes(asked), 'the row shows the chunk');

    gate.open();
    await sealing;
    assert.deepEqual((await events.quiet(150)).includes(session.id), true, 'the commit is signalled');
    const [record] = factsOf(INNER_CALL_RECORD_TYPE).slice(-1);
    const carrier = session.snapshotEvents().findLast(event => event.data?.source?.kind === 'session-watcher-inner-seal');
    assert.ok(carrier !== undefined && record.data.attempt === start.seq, 'the seal committed the attempt that was in flight');
    const rows = await rowsNow();
    assert.deepEqual(rows.map(row => [row.id, row.status]), [[failedStart.seq, 'failed'], [start.seq, 'committed']]);
    // The first main call after the carrier fixed the attempt's after, so the revision stands at that call.
    const firstAfter = session.snapshotEvents().find(event => event.type === 'assistant/message' && event.seq > carrier.seq);
    assert.ok(firstAfter !== undefined, 'a main call followed the seal');
    assert.deepEqual(rows[1], {
      id: start.seq, revision: firstAfter.seq, status: 'committed', legacy: false, startedAt: start.time, endedAt: carrier.time,
      range: start.data.range, reason: null, slots: carrier.data.source.slots.length,
      call: {
        state: 'received', endedAt: record.data.endedAt, finish: 'stop', thrown: null, input: prompt.slice(0, 500),
        output: slotNotes(asked),
        outputDisplay: Array.from({ length: asked }, (_, index) => `summary ${index + 1}`).join('\n'),
        usage: { input: 100, output: 9, cacheRead: 900, cacheWrite: 0 },
      },
      // The loop's main calls each report 1000 input and 4 output tokens: 1000+4 before the seal, 1000 after it, all of it uncached.
      contextChange: { before: 1004, after: 1000, delta: -4, miss: 1000 }, ...quoted,
    });
    const detail = await call('inner-monitor/call', { sessionId: session.id, attempt: start.seq });
    assert.equal(detail.ok, true, JSON.stringify(detail));
    assert.deepEqual(detail.value.row, { ...rows[1], call: Object.fromEntries(Object.entries(rows[1].call).filter(([field]) => field !== 'outputDisplay')) }, 'the shipped call detail is the list row without the list display');
    assert.equal(summaryRequests(), 2, 'the reads sent no summary request');
    await ctx.fiber.dispose();
  },
};

if (!Object.hasOwn(SCENARIOS, scenario)) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
try {
  await SCENARIOS[scenario]();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
