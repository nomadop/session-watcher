// test/helpers/dsh-pi-ai-child.js — one scenario of the opt-in pi-ai adapter entry (`dsh/dist/pi-ai-index.js`) on a real Cordis context, run in a fresh Node process by `test/dsh.pi-ai-carrier-cache.test.js`.
// The process starts with `HOME`, `DSH_HOME` and `TMPDIR` inside the fixture the parent made and the Bedrock switches the parent passes; the adapter resolves the built entry and its peers through the temporary profile's runtime resolution (`dsh-shipped-entry.js`), every endpoint is a loopback fixture of this process (`dsh-pi-ai-fixture.js`) and credentials are placeholders. A scenario that fails an assertion exits non-zero with it on stderr.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { applyHost } from '../../dsh/src/host.js';
import { CARRIER_EVIDENCE_SERVICE, PI_AI_SERVICE } from '../../dsh/src/pi-ai-integration.js';
import { createCarrierEvidence, MAX_CARRIER_EVIDENCE } from '../../dsh/src/carrier-evidence.js';
import { LOCAL_CARRIER_BUNDLE, OFFICIAL_CARRIER_BUNDLE, carrierCacheDepsOf, createCarrierCacheSwitch } from '../../dsh/src/carrier-cache-switch.js';
import { createCarrierCacheStore } from '../../dsh/src/client/settings.js';
import { createRpcHandler } from '../../dsh/src/rpc.js';
import { DEFAULT_CACHE_TTL, LONG_CACHE_TTL } from '../../lib/constants.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { initStore } from '../../lib/store.js';
import { createFakeContext, fakeSession } from './dsh-fake-context.js';
import { reusedCallIdAcrossSteps } from './dsh-events.js';

import { channelOn, CHECKOUT, DSH_HOME, fromCheckout, INNER_CALL_RECORD_TYPE, loaderOf, loaderWith, mountShippedLoop, ORIGINAL_ROW, REPLY_PADDING, SEAL_STEPS, SLOT_COUNT, slotNotes, turnOf } from './dsh-shipped-loop.js';
import {
  activation, addOffline, BUNDLE_PACKAGE, CARRIER_WORDING, carrierOf, conversationOf, endpoints, joinedText, KEY_REF, mountComposition, mountPiAi, OAUTH_REF, offlinePnpm, packBundleFixture, packOffline, REPLACEMENT_ID, REPLACEMENT_SPECIFIER, send, SW_PACKAGE, waitFor,
} from './dsh-pi-ai-fixture.js';

const [scenario] = process.argv.slice(2);

// The lines the host writes to stderr from here on, in order.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => { stderrLines.push(args.map(String).join(' ')); realConsoleError(...args); };

const MODEL = { contextWindow: 200_000, maxTokens: 4_096, input: ['text'], reasoningEfforts: false };

// A hand-declared Anthropic Messages route at `origin`; `profile` adds route-level fields.
const anthropicRoute = (origin, profile = {}) => ({
  api: 'anthropic-messages', baseURL: origin, apiKeyEnv: KEY_REF, models: [{ id: 'fixture-claude', ...MODEL }], ...profile,
});
const ANTHROPIC = { provider: 'sw-anthropic', model: 'fixture-claude' };

// The catalog route `amazon-bedrock` at `origin` with one Claude model; a model id that names Claude is what pi-ai's own Bedrock cache points go by.
const bedrockRoute = (origin, profile = {}) => ({ baseURL: origin, apiKeyEnv: KEY_REF, models: [{ id: 'anthropic.claude-sonnet-4-5-20250929-v1:0', ...MODEL }], ...profile });
// The catalog route `openai` pointed at the loopback endpoint: its catalog models keep their own capabilities, `gpt-6-sol` that of explicit cache breakpoints.
const openaiRoute = (origin, profile = {}) => ({ baseURL: `${origin}/v1`, apiKeyEnv: KEY_REF, ...profile });
const RESPONSES = { provider: 'openai', model: 'gpt-6-sol' };
// A hand-declared OpenAI Responses route at `origin`: no capability unless `profile` declares it in `compat`.
const responsesRoute = (origin, profile = {}) => ({ api: 'openai-responses', baseURL: `${origin}/v1`, apiKeyEnv: KEY_REF, models: [{ id: 'fixture-gpt', ...MODEL }], ...profile });
const SW_RESPONSES = { provider: 'sw-responses', model: 'fixture-gpt' };

// A hand-declared Chat Completions route at `origin`; `compat` states the gateway's conventions.
const completionsRoute = (origin, profile = {}) => ({ api: 'openai-completions', baseURL: origin, apiKeyEnv: KEY_REF, models: [{ id: 'fixture-chat', ...MODEL }], ...profile });
const COMPLETIONS = { provider: 'sw-completions', model: 'fixture-chat' };

const BEDROCK = { provider: 'amazon-bedrock', model: 'anthropic.claude-sonnet-4-5-20250929-v1:0' };

// What the host provides the replacement entry's hook with, over the real producer: the Responses breakpoint switch as `on` says.
const hostWith = on => createCarrierEvidence({ responsesBreakpoint: () => on }).service;

// Mounts the adapter plugin `entry` over the routes `providers` and sends `messages` once on `route`; `service` is what the host provides under `CARRIER_EVIDENCE_SERVICE`, none where the host is not mounted.
async function requestOver(entry, providers, route, messages, extra = {}, service = undefined) {
  const { ctx, llm } = await mountPiAi({ entry, config: { providers } });
  if (service !== undefined) ctx.provide(CARRIER_EVIDENCE_SERVICE, service);
  const finish = await send(ctx, { ...route, ...extra, messages: messages(llm, route) });
  const warnings = ctx.logger.buffer.filter(entryOf => entryOf.type === 'warn').map(entryOf => entryOf.args.map(String).join(' '));
  await ctx.fiber.dispose();
  return { finish, warnings };
}

// The body one request leaves through each adapter plugin over the same routes, conversation and endpoint reply; the original adapter's is what the request is without the carrier cache point.
async function bodiesOf({ providers, route, messages, protocol, extra, service }) {
  const bodies = {};
  const warnings = {};
  for (const entry of ['original', 'replacement']) {
    const served = await endpoints();
    const result = await requestOver(entry, providers(served.origin), route, messages, extra, entry === 'replacement' ? service : undefined);
    assert.notEqual(result.finish, undefined, `${entry}: the request finished`);
    warnings[entry] = result.warnings;
    const [recorded, ...more] = served.requests;
    assert.deepEqual(more, [], `${entry}: one request`);
    assert.equal(recorded.route, protocol, `${entry}: the request reached the ${protocol} endpoint`);
    bodies[entry] = recorded.body;
    await served.close();
  }
  return { ...bodies, warnings };
}

// The one body a request over `providers` leaves through `entry`, the host providing `service`.
async function bodyOver({ entry, providers, route, messages, service }) {
  const served = await endpoints();
  const { finish } = await requestOver(entry, providers(served.origin), route, messages, {}, service);
  assert.equal(finish?.kind, 'stop', JSON.stringify(finish));
  const [{ body }, ...more] = served.requests;
  assert.deepEqual(more, [], 'one request');
  await served.close();
  return body;
}

// The index of each message of a recorded body whose top-level text opens with the carrier wording.
const carrierAt = (messages, textOf) => messages.flatMap((message, index) => (message.role === 'user' && textOf(message).startsWith(CARRIER_WORDING.addresses) ? [index] : []));

// What a body keeps once its message `index` is set aside: the rest of the request, which the carrier cache point leaves exactly as the original adapter writes it.
const withoutMessage = (body, index, key = 'messages') => ({ ...body, [key]: body[key].filter((_, at) => at !== index) });

// A Claude model whose price row differs between the two cache lifetimes, and the routes of two lifetimes the pricing scenarios declare it under: one profile keeps prompts for long, the other states nothing.
const CLAUDE = 'claude-opus-5-5';
const CLAUDE_MODELS = [{ id: CLAUDE, name: CLAUDE, ...MODEL }];
const pricedRoutes = origin => ({ 'route-long': anthropicRoute(origin, { cacheRetention: 'long', models: CLAUDE_MODELS }), 'route-default': anthropicRoute(origin, { models: CLAUDE_MODELS }) });

// The C ratio the session watcher's host meters a session under on each of `routes`, over the llm and Settings services of the context `real` and the services `real` holds beside it (the pi-ai entry's among them): each session runs the shared log under the Claude model on its route.
async function ratiosOf(real, routes) {
  const claudeLog = route => reusedCallIdAcrossSteps().map((event) => {
    if (event.type !== 'assistant/message') return event;
    const source = { ...event.data.message.source, model: CLAUDE, provider: route };
    return { ...event, data: { ...event.data, message: { ...event.data.message, source } } };
  });
  const sessions = routes.map(route => fakeSession({ id: `s-${route}` }));
  initStore(join(process.env.TMPDIR, 'store.sqlite'));
  const fake = createFakeContext({ sessions, readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }), llm: real.llm, settings: real.settings, sibling: real });
  const { table } = applyHost(fake, {
    defineTool: definition => definition, storePath: join(process.env.TMPDIR, 'store.sqlite'), turnNotesRoot: join(process.env.TMPDIR, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: fileURLToPath(new URL('../../skills/', import.meta.url)),
  });
  await new Promise(resolve => setImmediate(resolve));
  routes.forEach((route, at) => { for (const event of claudeLog(route)) fake.emit('session/event', sessions[at], event); });
  const ratios = Object.fromEntries(routes.map(route => [route, table.get(`s-${route}`).watcher.getStatus().cRatio]));
  fake.dispose();
  return ratios;
}


// ── The switch over the real Loader, plugin manager and Connection ─────────────
const OWNER_PEER = { principal: { kind: 'owner' } };

// The isolated profile of the activation composition with the local carrier bundle installed and not selected, the real plugin manager over it, the real Connection on a loopback port and the switch's channel on it, the handler built from the source modules over the services of this one context. `wrap(manager)` answers the manager the switch is handed, a spy or a double around the real one; `started` has the profile start with the bundle selected, as after a restart that applied it; `installed: false` leaves the profile without the local bundle.
// `target` is the fixed install target the switch is injected with, none by default; the manager's pnpm then runs offline (`offlinePnpm`), whichever it is.
// `software` is the tarball of the Session Watcher package the profile holds before anything else, installed by pnpm as a profile's owner would.
async function managedRig({ providers, hmr = true, wrap = manager => manager, manager = true, installed = true, started = false, target, software }) {
  const { bundleLayer, layer } = activation({ providers });
  const mounted = await mountComposition({ layer, installed: installed ? [{ name: LOCAL_CARRIER_BUNDLE, patch: bundleLayer }] : [], selected: started ? [LOCAL_CARRIER_BUNDLE] : [], manager, hmr, connection: true, packageManager: offlinePnpm, prepare: software === undefined ? undefined : ({ dir, home }) => addOffline(dir, home, software) });
  const { ctx } = mounted;
  const carrier = createCarrierCacheSwitch({ ...carrierCacheDepsOf(ctx, { installTarget: () => target ?? null }), manager: () => (ctx.get('pluginManager') === undefined ? undefined : wrap(ctx.get('pluginManager'))) });
  const handler = createRpcHandler({ table: { get: () => ({ state: 'unobserved' }), live: () => [] }, store: {}, carrierCache: () => carrier });
  ctx.inject(['connection', 'webServer'], (child) => { child.extend({ webServer: child.webServer }).connection.rpc.handle('/session-watcher', handler); });
  await new Promise(resolve => setImmediate(resolve));
  const channel = channelOn(ctx);
  const manifest = () => JSON.parse(readFileSync(join(mounted.profileDir, 'package.json'), 'utf8'));
  const resave = () => {
    const saved = manifest();
    writeFileSync(join(mounted.profileDir, 'package.json'), `${JSON.stringify({ ...saved, dsh: { ...saved.dsh, profile: { ...saved.dsh.profile, bundles: [...new Set([...saved.dsh.profile.bundles, LOCAL_CARRIER_BUNDLE])] } } }, undefined, 2)}\n`);
  };
  return { ...mounted, call: channel.call, handler, carrier, resave, selected: (name = LOCAL_CARRIER_BUNDLE) => manifest().dsh.profile.bundles.includes(name), manifest };
}

// The manager the switch is handed, as a spy: each selection and install is recorded in `calls` as `['select', name, enabled]` and `['install', spec, options]` and, but for the answers `over` replaces, done by the real manager; the inventory is read through `over.listBundles` when given, and not recorded.
const spied = (calls, over = {}) => manager => ({
  listBundles: () => (over.listBundles ?? (() => manager.listBundles()))(),
  setBundleEnabled: (name, enabled) => { calls.push(['select', name, enabled]); return (over.setBundleEnabled ?? ((...args) => manager.setBundleEnabled(...args)))(name, enabled); },
  installBundle: (spec, options) => { calls.push(['install', spec, options]); return (over.installBundle ?? ((...args) => manager.installBundle(...args)))(spec, options); },
});
// Cordis's `FiberState.ACTIVE`.
const FIBER_ACTIVE = 2;

// The points a request over `route` carries beyond what the serializer writes for a carrier-less one: the wire shows who serves the route.
async function requestMarks(rig, served, route) {
  const before = served.requests.length;
  const finish = await send(rig.ctx, { ...route, messages: conversationOf(rig.llm, route, { carriers: 2, tail: 2 }) });
  assert.equal(finish?.kind, 'stop');
  assert.equal(served.requests.length, before + 1);
  return JSON.stringify(served.requests.at(-1).body).split('"cache_control"').length - 1;
}

const SCENARIOS = {
  // A request with no carrier in it: the replacement entry serves the route as the original adapter does, the same body and the same attribution headers.
  async 'parity-without-carrier'() {
    const bodies = {};
    for (const entry of ['original', 'replacement']) {
      const served = await endpoints();
      const { finish } = await requestOver(entry, { 'sw-anthropic': anthropicRoute(served.origin) }, ANTHROPIC,
        (llm, route) => conversationOf(llm, route, { carriers: 0, tail: 2 }));
      assert.equal(finish?.kind, 'stop', `${entry}: the fixture endpoint answers the request: ${JSON.stringify(finish)}`);
      assert.equal(served.requests.length, 1, `${entry}: one request`);
      bodies[entry] = served.requests[0];
      await served.close();
    }
    assert.deepEqual(bodies.replacement.body, bodies.original.body);
    const headersOf = ({ headers }) => Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-') && name !== 'x-stainless-retry-count'));
    assert.deepEqual(headersOf(bodies.replacement), headersOf(bodies.original));
  },

  // `H C1 C2 C3 A` on Anthropic Messages: the last carrier's final block, its whole text with the evidence and state blocks, carries the cache marker the native serializer writes at its own tail, and nothing else of the request differs from the original adapter's.
  async 'anthropic-carrier-point'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'sw-anthropic': anthropicRoute(origin) }), route: ANTHROPIC, protocol: 'anthropic',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 }),
    });
    const textOf = message => joinedText(message.content);
    const carriers = carrierAt(original.messages, textOf);
    assert.equal(carriers.length, 3, 'the request holds three carriers');
    assert.deepEqual(carrierAt(replacement.messages, textOf), carriers);
    const last = carriers.at(-1);
    const text = original.messages[last].content;
    assert.equal(typeof text, 'string', 'the native serializer writes a carrier as one string');
    assert.ok(text.includes(CARRIER_WORDING.carried) && text.includes('C3 line two') && text.includes(CARRIER_WORDING.stateHeading(9)) && text.includes('C3 item'), 'the carrier is whole: its summary, its evidence and its state');
    assert.deepEqual(replacement.messages[last], { role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
    assert.deepEqual(withoutMessage(replacement, last), withoutMessage(original, last));
    assert.deepEqual(replacement.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' }, 'the native tail point stays');
  },

  // The carrier a seal has just appended is the request's last message: the native serializer's tail point already ends it, so the request is the original adapter's.
  async 'anthropic-carrier-last'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'sw-anthropic': anthropicRoute(origin) }), route: ANTHROPIC, protocol: 'anthropic',
      messages: (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')],
    });
    const last = original.messages.at(-1);
    assert.equal(last.content.at(-1).cache_control?.type, 'ephemeral', 'the native tail point ends the carrier');
    assert.deepEqual(replacement, original);
  },

  // The lifetime of the new point is the one the route's native points carry: a long retention route writes `1h` on the last carrier too.
  async 'anthropic-long-retention'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'sw-anthropic': anthropicRoute(origin, { cacheRetention: 'long' }) }), route: ANTHROPIC, protocol: 'anthropic',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }),
    });
    assert.deepEqual(original.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' }, 'the native tail point is long');
    const last = carrierAt(original.messages, message => joinedText(message.content)).at(-1);
    assert.deepEqual(replacement.messages[last].content.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.deepEqual(withoutMessage(replacement, last), withoutMessage(original, last));
  },

  // A route whose profile turns caching off writes no native point, and the request gets none for its carrier either.
  async 'anthropic-caching-off'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'sw-anthropic': anthropicRoute(origin, { cacheRetention: 'none' }) }), route: ANTHROPIC, protocol: 'anthropic',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }),
    });
    assert.ok(!JSON.stringify(original).includes('cache_control'), 'the original request holds no cache marker');
    assert.deepEqual(replacement, original);
  },

  // The OAuth lane's four native points include the one ending a carrier that is the last message: the request is the original adapter's and no warning says a point was missing.
  async 'anthropic-carrier-last-on-full-lane'() {
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }];
    const { original, replacement, warnings } = await bodiesOf({
      providers: origin => ({ 'sw-anthropic': anthropicRoute(origin, { apiKeyEnv: OAUTH_REF }) }), route: ANTHROPIC, protocol: 'anthropic',
      messages: (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')], extra: { system: 'the system prompt', tools },
    });
    assert.equal(JSON.stringify(original).split('"cache_control"').length - 1, 4, 'the lane writes four native points');
    assert.deepEqual(replacement, original);
    assert.deepEqual(warnings.replacement, []);
  },

  // Both rows on, which the activation composition never does: the replacement finds its source row switched on, serves no route and registers no directory entry beside the original's, which keeps serving under the configuration it holds.
  async 'loader-both-rows-on'() {
    const served = await endpoints();
    const { ctx } = await mountComposition(activation({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, keepOriginalOn: true }));
    assert.ok(await waitFor(() => ctx.llm.listProviders().some(provider => provider.id === 'sw-anthropic')), 'the original serves its route');
    assert.equal(ctx.loader.resolve(ORIGINAL_ROW).disabled, false);
    const errors = ctx.logger.buffer.filter(entry => entry.type === 'error').map(entry => entry.args.map(String).join(' '));
    assert.equal(errors.length, 1, `the one line of the replacement\'s cause and no collision between the two directories: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /not switched off/);
    assert.deepEqual(ctx.get(PI_AI_SERVICE).failure, { cause: 'source-enabled' });
    assert.deepEqual([...new Set(ctx.llm.listConfigurableProviders().map(entry => entry.settingsNs))], ['llm-pi-ai'], 'the directory is the original\'s alone');
    await served.close();
  },

  // The cause of a configuration the replacement cannot use, over the real Loader: a dictionary the schema refuses, one the adapter's own resolution refuses and one with a `!!js` node, which the Loader evaluates for a running entry only. In each the replacement serves no route and declares no directory entry, names its cause on its service, and writes no value of the configuration anywhere, the secrets placed in it included.
  async 'loader-source-invalid'() {
    const secret = 'SECRET-CANARY-7731';
    const served = await endpoints();
    const route = anthropicRoute(served.origin);
    const yamlRoute = ['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  config:', '    providers:', '      sw-anthropic:', '        api: anthropic-messages', '        apiKeyEnv: SW_FIXTURE_PI_AI_KEY', '        baseURL: !!js \'http://127.0.0.1:1\'', ''].join('\n');
    const compositions = {
      'the schema refuses a value': activation({ providers: { 'sw-anthropic': { ...route, headers: { Authorization: `Bearer ${secret}` }, streamIdleTimeoutMs: secret } } }),
      'the resolution refuses a value': activation({ providers: { 'sw-anthropic': { ...route, headers: { 'X-Token': secret }, baseURL: '' } } }),
      'a !!js node stands for a value': { ...activation({ providers: {} }), layer: yamlRoute },
    };
    for (const [why, composition] of Object.entries(compositions)) {
      const { ctx } = await mountComposition(composition);
      assert.ok(await waitFor(() => ctx.get(PI_AI_SERVICE) !== undefined), `${why}: the replacement settles`);
      assert.deepEqual(ctx.get(PI_AI_SERVICE).failure, { cause: 'source-invalid' }, why);
      assert.equal(ctx.get(PI_AI_SERVICE).cacheRetention, undefined, `${why}: a failed entry holds no retention`);
      assert.deepEqual(ctx.llm.listProviders(), [], `${why}: no route is served`);
      assert.deepEqual(ctx.llm.listConfigurableProviders(), [], `${why}: no directory entry is declared`);
      const written = ctx.logger.buffer.flatMap(entry => entry.args.map(String)).join('\n');
      assert.ok(!written.includes(secret) && !written.includes('Authorization'), `${why}: the log holds no value of the configuration`);
      assert.equal(ctx.logger.buffer.filter(entry => entry.type === 'error').length, 1, `${why}: one line names the cause`);
      assert.ok(!JSON.stringify(ctx.get(PI_AI_SERVICE)).includes(secret), why);
      await ctx.fiber.dispose();
    }
    await served.close();
  },

  // A source row the Loader cannot resolve: the replacement names the cause on its service, serves no route and declares no directory entry.
  async 'source-missing'() {
    const { ctx } = await mountPiAi({ entry: 'replacement', config: {}, loader: loaderOf({}) });
    assert.deepEqual(ctx.get(PI_AI_SERVICE).failure, { cause: 'source-missing' });
    assert.deepEqual(ctx.llm.listProviders(), []);
    assert.deepEqual(ctx.llm.listConfigurableProviders(), []);
    assert.equal(ctx.logger.buffer.filter(entry => entry.type === 'error').length, 1);
    // The row with no configuration at all is the dormant original: no failure, and nothing to serve.
    const dormant = await mountPiAi({ entry: 'replacement', config: {}, loader: loaderOf({ [ORIGINAL_ROW]: {} }) });
    assert.equal(dormant.ctx.get(PI_AI_SERVICE).failure, null);
    assert.deepEqual(dormant.ctx.llm.listProviders(), []);
  },

  // The status over the real RPC channel of the real Connection with the host and the entry as siblings in one context: no failure while no entry is mounted or the entry serves its routes, and the entry's cause, with no session, while it serves none.
  async 'integration-status'() {
    const placeholders = { [KEY_REF]: 'sw-fixture-placeholder-key' };
    const served = await endpoints();
    const mounted = {
      'no pi-ai entry is mounted': undefined,
      'the entry serves its routes': { replacement: true, placeholders, loader: loaderWith({ 'sw-anthropic': anthropicRoute(served.origin) }) },
      'the entry finds no source row': { replacement: true, placeholders, loader: loaderOf({}) },
    };
    const answers = {};
    for (const [why, piAi] of Object.entries(mounted)) {
      const rig = await mountShippedLoop({ ...piAi === undefined ? {} : { piAi } });
      answers[why] = await rig.call('pi-ai/status', {});
      await rig.ctx.fiber.dispose();
    }
    assert.deepEqual(answers, {
      'no pi-ai entry is mounted': { ok: true, value: { failure: null } },
      'the entry serves its routes': { ok: true, value: { failure: null } },
      'the entry finds no source row': { ok: true, value: { failure: { cause: 'source-missing' } } },
    });
    await served.close();
  },

  // `H C1 C2 C3 A` on Bedrock Converse: a standalone cache point block ends the last carrier's content, the whole carrier before it, and the rest of the request is the original adapter's; no `cache_control` field is written for it.
  async 'bedrock-carrier-point'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'amazon-bedrock': bedrockRoute(origin) }), route: BEDROCK, protocol: 'bedrock',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 }),
    });
    const textOf = message => message.content.map(block => block.text ?? '').join('');
    const carriers = carrierAt(original.messages, textOf);
    assert.equal(carriers.length, 3, 'the request holds three carriers');
    const last = carriers.at(-1);
    assert.deepEqual(original.messages[last].content.map(block => Object.keys(block)), [['text']], 'the native serializer writes the carrier as one text block');
    assert.ok(original.messages[last].content[0].text.includes(CARRIER_WORDING.stateHeading(9)), 'the carrier is whole');
    assert.deepEqual(replacement.messages[last].content, [...original.messages[last].content, { cachePoint: { type: 'default' } }]);
    assert.deepEqual(withoutMessage(replacement, last), withoutMessage(original, last));
    assert.equal(replacement.messages.at(-1).content.at(-1).cachePoint?.type, 'default', 'the native tail point stays');
    assert.ok(!JSON.stringify(replacement).includes('cache_control'));
  },

  // The carrier a seal has just appended is Bedrock's last message: the native tail point already closes it, so no second one is added.
  async 'bedrock-carrier-last'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'amazon-bedrock': bedrockRoute(origin) }), route: BEDROCK, protocol: 'bedrock',
      messages: (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')],
    });
    assert.deepEqual(original.messages.at(-1).content.at(-1), { cachePoint: { type: 'default' } }, 'the native tail point closes the carrier');
    assert.deepEqual(replacement, original);
  },

  // The new point has the lifetime of the route's native points on Bedrock too.
  async 'bedrock-long-retention'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'amazon-bedrock': bedrockRoute(origin, { cacheRetention: 'long' }) }), route: BEDROCK, protocol: 'bedrock',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }),
    });
    assert.deepEqual(original.messages.at(-1).content.at(-1), { cachePoint: { type: 'default', ttl: '1h' } });
    const last = carrierAt(original.messages, message => message.content.map(block => block.text ?? '').join('')).at(-1);
    assert.deepEqual(replacement.messages[last].content.at(-1), { cachePoint: { type: 'default', ttl: '1h' } });
    assert.deepEqual(withoutMessage(replacement, last), withoutMessage(original, last));
  },

  // Caching turned off by the profile, and a model the serializer writes no point for, each keep the original request.
  async 'bedrock-no-native-points'() {
    const cases = {
      'caching off': { profile: { cacheRetention: 'none' }, route: BEDROCK, model: undefined },
      'a model with no cache points': { profile: { models: [{ id: 'amazon.fixture-text-1', ...MODEL }] }, route: { provider: 'amazon-bedrock', model: 'amazon.fixture-text-1' } },
    };
    for (const [label, { profile, route }] of Object.entries(cases)) {
      const { original, replacement } = await bodiesOf({
        providers: origin => ({ 'amazon-bedrock': bedrockRoute(origin, profile) }), route, protocol: 'bedrock',
        messages: (llm, over) => conversationOf(llm, over, { carriers: 2, tail: 2 }),
      });
      assert.ok(!JSON.stringify(original).includes('cachePoint'), `${label}: the original request holds no cache point`);
      assert.deepEqual(replacement, original, label);
    }
  },

  // `H C1 C2 C3 A` on Responses with a model that takes explicit breakpoints and the owner's switch on: the last carrier's final `input_text` block carries one, and the top-level mode, key and options the serializer writes, every other block and every earlier carrier are the original adapter's.
  async 'responses-carrier-point'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ openai: openaiRoute(origin) }), route: RESPONSES, protocol: 'responses', service: hostWith(true),
      messages: (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 }),
    });
    const textOf = item => (item.role === 'user' && Array.isArray(item.content) ? item.content.map(part => part.text ?? '').join('') : '');
    const carriers = carrierAt(original.input, textOf);
    assert.equal(carriers.length, 3, 'the request holds three carriers');
    const last = carriers.at(-1);
    assert.deepEqual(original.input[last].content.map(part => Object.keys(part)), [['type', 'text']], 'the native serializer writes the carrier as one input_text block');
    assert.ok(original.input[last].content[0].text.includes(CARRIER_WORDING.stateHeading(9)), 'the carrier is whole');
    assert.deepEqual(replacement.input[last].content, [{ ...original.input[last].content[0], prompt_cache_breakpoint: { mode: 'explicit' } }]);
    assert.deepEqual(withoutMessage(replacement, last, 'input'), withoutMessage(original, last, 'input'));
    assert.equal(original.prompt_cache_options, undefined, 'the serializer leaves the default implicit mode');
  },

  // A route whose profile turns caching off is sent explicit-only mode with no breakpoint, which means no caching at all: with the switch on the request stays the original adapter's, with no breakpoint for the carrier.
  async 'responses-caching-off'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ openai: openaiRoute(origin, { cacheRetention: 'none' }) }), route: RESPONSES, protocol: 'responses', service: hostWith(true),
      messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }),
    });
    assert.deepEqual(original.prompt_cache_options, { mode: 'explicit' }, 'the serializer sends explicit-only mode');
    assert.deepEqual(replacement, original);
  },

  // A long retention route is sent the request-level lifetime, and the carrier's breakpoint adds none of its own.
  async 'responses-long-retention'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ openai: openaiRoute(origin, { cacheRetention: 'long' }) }), route: RESPONSES, protocol: 'responses', service: hostWith(true),
      messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }),
    });
    assert.deepEqual(original.prompt_cache_options, { ttl: '30m' });
    assert.deepEqual(replacement.prompt_cache_options, { ttl: '30m' }, 'the request-level lifetime is untouched');
    const last = carrierAt(original.input, item => (item.role === 'user' && Array.isArray(item.content) ? item.content.map(part => part.text ?? '').join('') : '')).at(-1);
    assert.deepEqual(replacement.input[last].content.at(-1).prompt_cache_breakpoint, { mode: 'explicit' });
    assert.deepEqual({ ...replacement, input: undefined }, { ...original, input: undefined });
  },

  // The carrier a seal has just appended is the last input item: the implicit breakpoint of the latest message already ends it, so the request is the original adapter's.
  async 'responses-carrier-last'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ openai: openaiRoute(origin) }), route: RESPONSES, protocol: 'responses', service: hostWith(true),
      messages: (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')],
    });
    assert.deepEqual(replacement, original);
  },

  // A hand-declared Responses route that declares the explicit-breakpoint capability, which the pi-ai profile withholds and this entry's profile offers, with the switch on: the last carrier of its request carries the breakpoint, and none of the earlier ones do.
  async 'responses-custom-opt-in'() {
    const route = { provider: 'sw-responses', model: 'fixture-gpt' };
    const served = await endpoints();
    const providers = { 'sw-responses': { api: 'openai-responses', baseURL: `${served.origin}/v1`, apiKeyEnv: KEY_REF, compat: { supportsExplicitPromptCacheMode: true }, models: [{ id: 'fixture-gpt', ...MODEL }] } };
    const { finish } = await requestOver('replacement', providers, route, (llm, over) => conversationOf(llm, over, { carriers: 3, tail: 2 }), {}, hostWith(true));
    assert.equal(finish?.kind, 'stop', JSON.stringify(finish));
    const [{ body }] = served.requests;
    const textOf = item => (item.role === 'user' && Array.isArray(item.content) ? item.content.map(part => part.text ?? '').join('') : '');
    const carriers = carrierAt(body.input, textOf);
    const marked = body.input.flatMap((item, index) => (Array.isArray(item.content) && item.content.some(part => part.prompt_cache_breakpoint !== undefined) ? [index] : []));
    assert.deepEqual(marked, [carriers.at(-1)], 'one breakpoint, ending the last carrier');
    await served.close();
  },

  // The Responses breakpoint switch on, a request that gets one: its last carrier ends in the breakpoint and the request carries the options that go with it, which are the serializer's own for a route that declares explicit prompt-cache mode. The original adapter refuses the capability a profile declares, so the oracle of the rest of the request is the same declaring route served by this entry with the switch off, which `responses-switch-off` shows adds nothing. The requests that get none are the ones of `responses-switch-skips`.
  async 'responses-switch-on'() {
    const textOf = item => (item.role === 'user' && Array.isArray(item.content) ? item.content.map(part => part.text ?? '').join('') : '');
    const breakpoints = body => body.input.flatMap((item, index) => (Array.isArray(item.content) && item.content.some(part => part.prompt_cache_breakpoint !== undefined) ? [index] : []));
    const sealed = (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 });
    const sent = (entry, profile, service) => bodyOver({
      entry, providers: origin => ({ 'sw-responses': responsesRoute(origin, profile) }), route: SW_RESPONSES, messages: sealed, service,
    });
    // What each declaration a profile can make about the capability states: none, the capability itself for the oracle, and an explicit `false`, which is no control of its own.
    const cases = {
      'default retention': { profile: {}, native: { prompt_cache_retention: undefined, prompt_cache_options: undefined }, serialized: { prompt_cache_retention: undefined, prompt_cache_options: undefined } },
      'long retention': { profile: { cacheRetention: 'long' }, native: { prompt_cache_retention: '24h', prompt_cache_options: undefined }, serialized: { prompt_cache_retention: undefined, prompt_cache_options: { ttl: '30m' } } },
    };
    for (const [label, { profile, native: nativeFields, serialized }] of Object.entries(cases)) {
      const native = await sent('original', profile);
      assert.deepEqual({ prompt_cache_retention: native.prompt_cache_retention, prompt_cache_options: native.prompt_cache_options }, nativeFields, `${label}: the native request`);
      assert.deepEqual(breakpoints(native), [], `${label}: the native serializer writes none`);
      const declared = await sent('replacement', { ...profile, compat: { supportsExplicitPromptCacheMode: true } }, hostWith(false));
      assert.deepEqual(breakpoints(declared), [], `${label}: the serializer writes none for a route that declares the capability`);
      assert.deepEqual({ prompt_cache_retention: declared.prompt_cache_retention, prompt_cache_options: declared.prompt_cache_options }, serialized, `${label}: the declared route's own options`);
      const last = carrierAt(native.input, textOf).at(-1);
      for (const [declaration, compat] of Object.entries({ 'no capability declared': undefined, 'the capability declared false': { supportsExplicitPromptCacheMode: false } })) {
        const on = await sent('replacement', { ...profile, ...(compat === undefined ? {} : { compat }) }, hostWith(true));
        assert.deepEqual(breakpoints(on), [last], `${label}, ${declaration}: one breakpoint, ending the last carrier`);
        assert.deepEqual(on.input[last].content, [{ ...native.input[last].content[0], prompt_cache_breakpoint: { mode: 'explicit' } }], `${label}, ${declaration}`);
        assert.deepEqual(withoutMessage(on, last, 'input'), withoutMessage(declared, last, 'input'), `${label}, ${declaration}: every other member is the serializer's for the declared route`);
        assert.equal(on.prompt_cache_retention, serialized.prompt_cache_retention, `${label}, ${declaration}`);
        assert.deepEqual(on.prompt_cache_options, serialized.prompt_cache_options, `${label}, ${declaration}`);
      }
    }
    // A catalog model that already takes explicit breakpoints is sent what it always was with the switch on, the breakpoint added, kept for long or not.
    for (const [label, profile] of Object.entries({ 'default retention': {}, 'long retention': { cacheRetention: 'long' } })) {
      const { original, replacement } = await bodiesOf({
        providers: origin => ({ openai: openaiRoute(origin, profile) }), route: RESPONSES, protocol: 'responses', messages: sealed, service: hostWith(true),
      });
      const lastOf = carrierAt(original.input, textOf).at(-1);
      assert.deepEqual(breakpoints(replacement), [lastOf], `a catalog model, ${label}`);
      assert.deepEqual(withoutMessage(replacement, lastOf, 'input'), withoutMessage(original, lastOf, 'input'), `a catalog model, ${label}`);
    }
  },

  // The Responses breakpoint switch on, a request that gets no breakpoint is the request the original adapter writes, wire fields included: the 24-hour retention of a long route and the absence of options on every other, which are what a route that declares nothing is sent. The routes are a hand-declared one that declares nothing and a catalog model that takes breakpoints; the oracle is the original adapter over the same route and, for a route whose profile declares the capability `false`, which the original refuses, this entry's own request with the switch off. Nothing is granted to the request before it is known to get a breakpoint.
  async 'responses-switch-skips'() {
    const noCarrier = (llm, route) => conversationOf(llm, route, { carriers: 0, tail: 2 });
    const carrierLast = (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')];
    const sealed = (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 });
    const routes = {
      'a route that declares no capability': { providers: (o, profile) => ({ 'sw-responses': responsesRoute(o, profile) }), route: SW_RESPONSES },
      'a catalog model that takes breakpoints': { providers: (o, profile) => ({ openai: openaiRoute(o, profile) }), route: RESPONSES },
    };
    const retentions = { 'default retention': {}, 'long retention': { cacheRetention: 'long' }, 'caching off': { cacheRetention: 'none' } };
    const shapes = { 'no carrier': noCarrier, 'the carrier is the last item': carrierLast };
    const holdsNone = body => !JSON.stringify(body).includes('prompt_cache_breakpoint');
    // Every case is compared before the scenario fails, so one run names all the requests the switch changes.
    const changed = [];
    for (const [routeLabel, { providers, route }] of Object.entries(routes)) {
      for (const [retentionLabel, profile] of Object.entries(retentions)) {
        // Caching off gets none for any shape: the carrier mid-conversation is no reason for a breakpoint.
        const all = retentionLabel === 'caching off' ? { ...shapes, 'a carrier mid-conversation': sealed } : shapes;
        for (const [shapeLabel, messages] of Object.entries(all)) {
          const label = `${routeLabel}, ${retentionLabel}, ${shapeLabel}`;
          const { original, replacement } = await bodiesOf({ providers: o => providers(o, profile), route, protocol: 'responses', messages, service: hostWith(true) });
          assert.ok(holdsNone(original), `${label}: the original request holds none`);
          if (!isDeepStrictEqual(replacement, original)) changed.push(label);
        }
      }
    }
    // The wire fields the comparison is about, in the serializer's own words for the route that declares nothing.
    const longNative = (await bodiesOf({ providers: o => routes['a route that declares no capability'].providers(o, retentions['long retention']), route: SW_RESPONSES, protocol: 'responses', messages: noCarrier })).original;
    assert.equal(longNative.prompt_cache_retention, '24h');
    assert.equal(longNative.prompt_cache_options, undefined);
    const offNative = (await bodiesOf({ providers: o => routes['a route that declares no capability'].providers(o, retentions['caching off']), route: SW_RESPONSES, protocol: 'responses', messages: noCarrier })).original;
    assert.equal(offNative.prompt_cache_options, undefined);
    // A profile that declares the capability false is no control of its own: the switch is, and a request that gets none is what the same route is sent with the switch off.
    for (const [retentionLabel, profile] of Object.entries(retentions)) {
      for (const [shapeLabel, messages] of Object.entries(shapes)) {
        const send = service => bodyOver({
          entry: 'replacement', providers: o => ({ 'sw-responses': responsesRoute(o, { ...profile, compat: { supportsExplicitPromptCacheMode: false } }) }), route: SW_RESPONSES, messages, service,
        });
        const label = `the capability declared false, ${retentionLabel}, ${shapeLabel}`;
        const off = await send(hostWith(false));
        if (!isDeepStrictEqual(await send(hostWith(true)), off)) changed.push(label);
        assert.ok(holdsNone(off), label);
      }
    }
    assert.deepEqual(changed, [], 'requests the switch changes though they get no breakpoint');
  },

  // The Responses breakpoint switch off, which it is until the owner turns it on, and a host that provides nothing: no route of the protocol is given a breakpoint, whether its model declares the capability or not. A route the original adapter accepts is sent exactly what it sends; a route that declares the capability, which the original refuses, keeps the serializer's declared request.
  async 'responses-switch-off'() {
    const hosts = { 'no host service': undefined, 'the switch off': hostWith(false) };
    const messages = (llm, over) => conversationOf(llm, over, { carriers: 3, tail: 2 });
    const accepted = {
      'a catalog model that takes explicit breakpoints': { providers: o => ({ openai: openaiRoute(o) }), route: RESPONSES },
      'the same model kept for long': { providers: o => ({ openai: openaiRoute(o, { cacheRetention: 'long' }) }), route: RESPONSES },
      'a hand-declared route that declares none': { providers: o => ({ 'sw-responses': responsesRoute(o) }), route: SW_RESPONSES },
      'a hand-declared route that declares none and keeps prompts for long': { providers: o => ({ 'sw-responses': responsesRoute(o, { cacheRetention: 'long' }) }), route: SW_RESPONSES },
    };
    const declaring = {
      'a hand-declared route that declares the capability': { profile: {}, options: undefined },
      'a hand-declared route that declares it and keeps prompts for long': { profile: { cacheRetention: 'long' }, options: { ttl: '30m' } },
      'a hand-declared route that declares it and turns caching off': { profile: { cacheRetention: 'none' }, options: { mode: 'explicit' } },
    };
    for (const [host, service] of Object.entries(hosts)) {
      for (const [label, { providers, route }] of Object.entries(accepted)) {
        const { original, replacement } = await bodiesOf({ providers, route, protocol: 'responses', messages, service });
        assert.ok(!JSON.stringify(original).includes('prompt_cache_breakpoint'), `${host}, ${label}: the original request holds none`);
        assert.deepEqual(replacement, original, `${host}, ${label}`);
      }
      for (const [label, { profile, options }] of Object.entries(declaring)) {
        const body = await bodyOver({
          entry: 'replacement', providers: o => ({ 'sw-responses': responsesRoute(o, { ...profile, compat: { supportsExplicitPromptCacheMode: true } }) }), route: SW_RESPONSES, messages, service,
        });
        assert.ok(!JSON.stringify(body).includes('prompt_cache_breakpoint'), `${host}, ${label}: no breakpoint`);
        assert.deepEqual(body.prompt_cache_options, options, `${host}, ${label}: the serializer's own options for the declared route`);
        assert.equal(body.prompt_cache_retention, undefined, `${host}, ${label}`);
      }
    }
  },

  // The switch is read once for each Responses request; a host whose service has no such member and one that cannot answer both leave the request the original adapter's, the second with one warning.
  async 'responses-switch-unreadable'() {
    const sealed = (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 });
    const providers = origin => ({ openai: openaiRoute(origin) });
    const warningsOf = ctx => ctx.logger.buffer.filter(each => each.type === 'warn').map(each => each.args.map(String).join(' '));
    const { original } = await bodiesOf({ providers, route: RESPONSES, protocol: 'responses', messages: sealed });
    const cases = {
      'a service with no such member': { service: { record() {} }, warnings: 0 },
      'a service whose answer is not true': { service: { record() {}, responsesBreakpoint: () => 'yes' }, warnings: 0 },
      'a service that cannot answer': { service: { record() {}, responsesBreakpoint() { throw new Error('the settings are gone'); } }, warnings: 1 },
    };
    for (const [label, { service, warnings }] of Object.entries(cases)) {
      const served = await endpoints();
      const { ctx, llm } = await mountPiAi({ entry: 'replacement', config: { providers: providers(served.origin) } });
      ctx.provide(CARRIER_EVIDENCE_SERVICE, service);
      const finish = await send(ctx, { ...RESPONSES, messages: sealed(llm, RESPONSES) });
      assert.equal(finish?.kind, 'stop', label);
      assert.deepEqual(served.requests.at(-1).body, original, `${label}: the original adapter's request`);
      assert.equal(warningsOf(ctx).filter(line => line.includes('Responses breakpoint setting')).length, warnings, `${label}: ${JSON.stringify(warningsOf(ctx))}`);
      await ctx.fiber.dispose();
      await served.close();
    }
    // One read for a request, whatever the request holds.
    let reads = 0;
    const served = await endpoints();
    const { ctx, llm } = await mountPiAi({ entry: 'replacement', config: { providers: providers(served.origin) } });
    ctx.provide(CARRIER_EVIDENCE_SERVICE, { record() {}, responsesBreakpoint: () => { reads += 1; return true; } });
    assert.equal((await send(ctx, { ...RESPONSES, messages: sealed(llm, RESPONSES) }))?.kind, 'stop');
    assert.equal(reads, 1);
    assert.equal((await send(ctx, { ...RESPONSES, messages: sealed(llm, RESPONSES) }))?.kind, 'stop');
    assert.equal(reads, 2, 'the next request reads it again');
    await ctx.fiber.dispose();
    await served.close();
  },

  // The owner's saved switch reaches the replacement's hook through the real host entry beside it, over the real llm service and a loopback endpoint: the host's plugin Config holds it, off until it is saved on, and a saved on gives a route whose model declares no capability the breakpoint on its last carrier.
  async 'responses-switch-host'() {
    const placeholders = { [KEY_REF]: 'sw-fixture-placeholder-key' };
    const textOf = item => (item.role === 'user' && Array.isArray(item.content) ? item.content.map(part => part.text ?? '').join('') : '');
    const bodies = {};
    for (const [label, settings] of Object.entries({ 'nothing saved': {}, 'saved off': { carrierResponsesBreakpoint: false }, 'saved on': { carrierResponsesBreakpoint: true } })) {
      const served = await endpoints();
      const rig = await mountShippedLoop({ piAi: { replacement: true, placeholders, loader: loaderWith({ 'sw-responses': responsesRoute(served.origin) }) }, settings });
      const finish = await send(rig.ctx, { ...SW_RESPONSES, messages: conversationOf(rig.llm, SW_RESPONSES, { carriers: 3, tail: 2 }) });
      assert.equal(finish?.kind, 'stop', `${label}: ${JSON.stringify(finish)}`);
      bodies[label] = served.requests.at(-1).body;
      await rig.ctx.fiber.dispose();
      await served.close();
    }
    const breakpointsOf = body => body.input.flatMap((item, index) => (Array.isArray(item.content) && item.content.some(part => part.prompt_cache_breakpoint !== undefined) ? [index] : []));
    assert.deepEqual(breakpointsOf(bodies['nothing saved']), []);
    assert.deepEqual(bodies['saved off'], bodies['nothing saved']);
    assert.deepEqual(breakpointsOf(bodies['saved on']), [carrierAt(bodies['saved on'].input, textOf).at(-1)]);
  },

  // The switch is the Responses protocol's alone: the points of the Anthropic, Bedrock and Chat Completions routes are the ones they are with it off, and they are there.
  async 'responses-switch-other-protocols'() {
    const cases = {
      anthropic: { providers: o => ({ 'sw-anthropic': anthropicRoute(o) }), route: ANTHROPIC, protocol: 'anthropic' },
      bedrock: { providers: o => ({ 'amazon-bedrock': bedrockRoute(o) }), route: BEDROCK, protocol: 'bedrock' },
      completions: { providers: o => ({ 'sw-completions': completionsRoute(o, { compat: { cacheControlFormat: 'anthropic' } }) }), route: COMPLETIONS, protocol: 'completions' },
    };
    for (const [label, { providers, route, protocol }] of Object.entries(cases)) {
      const messages = (llm, over) => conversationOf(llm, over, { carriers: 3, tail: 2 });
      const off = await bodiesOf({ providers, route, protocol, messages, service: hostWith(false) });
      const on = await bodiesOf({ providers, route, protocol, messages, service: hostWith(true) });
      assert.notDeepEqual(off.replacement, off.original, `${label}: the entry's point is there with the switch off`);
      assert.deepEqual(on.replacement, off.replacement, `${label}: the switch changes nothing`);
      assert.deepEqual(on.original, off.original, label);
      // A request of another protocol does not consult the Responses switch at all, so an unreadable one cannot warn about it.
      let reads = 0;
      const counting = { record() {}, responsesBreakpoint() { reads += 1; throw new Error('the settings are gone'); } };
      const unread = await bodiesOf({ providers, route, protocol, messages, service: counting });
      assert.equal(reads, 0, `${label}: the switch is not read`);
      assert.deepEqual(unread.warnings.replacement, [], `${label}: no warning about it`);
      assert.deepEqual(unread.replacement, off.replacement, label);
    }
  },

  // `H C1 C2 C3 A` on a Chat Completions gateway that takes Anthropic-format cache markers: the last carrier's final text part carries the marker the serializer writes at its own tail, and the rest of the request is the original adapter's.
  async 'completions-gateway-point'() {
    const { original, replacement } = await bodiesOf({
      providers: origin => ({ 'sw-completions': completionsRoute(origin, { compat: { cacheControlFormat: 'anthropic' } }) }), route: COMPLETIONS, protocol: 'completions',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 3, tail: 2 }),
    });
    const textOf = message => joinedText(message.content);
    const carriers = carrierAt(original.messages, textOf);
    assert.equal(carriers.length, 3, 'the request holds three carriers');
    const last = carriers.at(-1);
    const text = original.messages[last].content;
    assert.equal(typeof text, 'string', 'the native serializer writes a carrier as one string');
    assert.ok(text.includes(CARRIER_WORDING.stateHeading(9)), 'the carrier is whole');
    assert.deepEqual(replacement.messages[last], { role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] });
    assert.deepEqual(withoutMessage(replacement, last), withoutMessage(original, last));
    assert.equal(replacement.messages.at(-1).content.at(-1).cache_control?.type, 'ephemeral', 'the native tail marker stays');
  },

  // A Chat Completions endpoint that does not state the Anthropic format, one whose profile turns caching off and a carrier that is the last message each keep the original request: the first two write no native marker for a carrier to follow, the last has its own.
  async 'completions-no-extra-point'() {
    const lastCarrierMessages = (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')];
    const cases = {
      'an endpoint of unstated format': { profile: {}, messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }), marked: false },
      'caching off': { profile: { compat: { cacheControlFormat: 'anthropic' }, cacheRetention: 'none' }, messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }), marked: false },
      'a carrier that is the last message': { profile: { compat: { cacheControlFormat: 'anthropic' } }, messages: lastCarrierMessages, marked: true },
    };
    for (const [label, { profile, messages, marked }] of Object.entries(cases)) {
      const { original, replacement } = await bodiesOf({
        providers: origin => ({ 'sw-completions': completionsRoute(origin, profile) }), route: COMPLETIONS, protocol: 'completions', messages,
      });
      assert.equal(JSON.stringify(original).includes('cache_control'), marked, `${label}: the original request's markers`);
      assert.deepEqual(replacement, original, label);
    }
  },

  // The real loop over the replacement entry: each request the seal's host sends reaches the Anthropic endpoint through the wrapped provider. Consecutive seals, the second asked for again after a reply that was not the notes; the main requests, the auxiliary requests and the retried request each carry the one new point at the end of the last carrier in them, and none at an earlier carrier.
  async 'loop-carrier-cache'() {
    let summaries = 0;
    const served = await endpoints({
      reply(route, body) {
        const tail = joinedText(body.messages.at(-1).content);
        const count = SLOT_COUNT.exec(tail)?.[1];
        // The main replies carry the padding that makes a range of `SEAL_STEPS` steps worth sealing to the quote.
        if (count === undefined) return `reply ${body.messages.length}${REPLY_PADDING}`;
        summaries += 1;
        // The second seal's first request is not the notes.
        return summaries === 2 ? 'these are not the notes' : slotNotes(Number(count));
      },
    });
    const rig = await mountShippedLoop({
      piAi: { replacement: true, placeholders: { [KEY_REF]: 'sw-fixture-placeholder-key' }, loader: loaderWith({ 'sw-anthropic': anthropicRoute(served.origin) }) },
    });
    const { ctx, call, harness, llm } = rig;
    const agent = await harness.create(`carrier-${Date.now().toString(16)}`, ANTHROPIC, { cwd: process.env.TMPDIR });
    assert.deepEqual(await call('inner-mode/select', { sessionId: agent.session.id, enabled: true }), { ok: true, value: {} });
    const wired = () => served.requests.filter(each => each.route === 'anthropic').map(each => each.body);
    const isCarrierEvent = event => event?.type === 'user/message' && event.data?.source?.kind === 'session-watcher-inner-seal';
    const sealed = () => agent.session.snapshotEvents().filter(isCarrierEvent).length;
    for (let turn = 1; sealed() < 2 && turn <= 4 * SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
    assert.equal(sealed(), 2, 'two seals committed');
    // Each seal is the quote's permission over its range, not a step count's.
    const logged = agent.session.snapshotEvents();
    for (const carrier of logged.filter(isCarrierEvent)) {
      const { quote } = logged[logged[carrier.sourceEventSeqs[0]].data.attempt].data;
      assert.ok(quote.trigger === 'quote' && quote.sEst > 0 && (quote.arm === 'right' || quote.q < quote.kappa), `the quote permits the seal: ${JSON.stringify(quote)}`);
    }

    const textOf = message => joinedText(message.content);
    const marks = body => JSON.stringify(body).split('"cache_control"').length - 1;
    const kinds = wired().map(body => (SLOT_COUNT.test(textOf(body.messages.at(-1))) ? 'summary' : 'main'));
    assert.equal(kinds.filter(kind => kind === 'summary').length, 3, 'two seals and one retried request');
    const natives = wired().find((_, at) => kinds[at] === 'main');
    const native = marks(natives);
    assert.equal(carrierAt(natives.messages, textOf).length, 0);
    const checked = [];
    wired().forEach((body, at) => {
      const carriers = carrierAt(body.messages, textOf);
      const last = carriers.at(-1);
      if (last === undefined) {
        assert.equal(marks(body), native, `request ${at} (${kinds[at]}): no carrier, the native points only`);
        return;
      }
      // The last carrier ends in a marker, written by the serializer when the carrier is the last message and by the entry otherwise; an earlier carrier has none.
      const ends = message => Array.isArray(message.content) && message.content.at(-1).cache_control !== undefined;
      assert.ok(ends(body.messages[last]), `request ${at} (${kinds[at]}): the last carrier ends in a marker`);
      for (const earlier of carriers.slice(0, -1)) assert.ok(!ends(body.messages[earlier]), `request ${at}: an earlier carrier has none`);
      assert.equal(marks(body), last === body.messages.length - 1 ? native : native + 1, `request ${at}: exactly one point beyond the native ones`);
      checked.push({ kind: kinds[at], carriers: carriers.length, carrierLast: last === body.messages.length - 1 });
    });
    assert.ok(checked.some(row => row.kind === 'summary' && row.carriers === 1), 'an auxiliary request held the first carrier and gave it a point');
    assert.ok(checked.some(row => row.kind === 'main' && row.carriers === 2 && !row.carrierLast), 'a main request held both carriers');
    const retried = wired().filter((_, at) => kinds[at] === 'summary').slice(1);
    assert.deepEqual(retried[1], retried[0], 'the retried auxiliary request is the failed one, as it was');
    // Each summary request's own call record holds the results of its own serialization: the first seal's request holds no carrier yet, the second seal's first request and its retry each hold one and were each given the point.
    const calls = logged.filter(event => event.type === INNER_CALL_RECORD_TYPE);
    assert.deepEqual(calls.map(event => event.data.carrierCache), [
      { results: [{ result: 'skipped', reason: 'no-carrier' }], omitted: 0 },
      { results: [{ result: 'added' }], omitted: 0 },
      { results: [{ result: 'added' }], omitted: 0 },
    ]);
    console.log(JSON.stringify(checked));
    await served.close();
    await ctx.fiber.dispose();
  },

  // The activation composition on the real Loader: the original `llm-pi-ai` row off and carrying the profile dictionary, the replacement inserted under its own id with no configuration. The replacement reads the original row's composed configuration at startup: the routes are the dictionary's, the configurable-provider directory is the replacement's alone, no second copy of the dictionary exists and Settings describes neither row, and a request through the real llm service reaches the endpoint with the carrier point, the placeholder credential and the attribution headers.
  async 'loader-activation'() {
    const served = await endpoints();
    const { ctx, llm: rigLlm } = await mountComposition(activation({ providers: { 'sw-anthropic': anthropicRoute(served.origin) } }));
    const original = ctx.loader.resolve(ORIGINAL_ROW);
    assert.equal(original.disabled, true, 'the original row is switched off by the bundle layer');
    assert.equal(original.fiber, undefined, 'and has no running plugin');
    assert.equal(original.options.config.providers['sw-anthropic'].baseURL, served.origin, 'its composed configuration holds the profile layer\'s dictionary');
    assert.equal(ctx.loader.resolve(`include:${REPLACEMENT_ID}`).options.config, undefined, 'the replacement row carries no configuration of its own');
    assert.ok(await waitFor(() => ctx.llm.listProviders().some(provider => provider.id === 'sw-anthropic')), 'the replacement serves the dictionary\'s route');
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['sw-anthropic']);
    const directory = ctx.llm.listConfigurableProviders();
    assert.ok(directory.length > 1, 'the whole installed catalog is configurable');
    assert.equal(new Set(directory.map(entry => entry.provider)).size, directory.length, 'no route is declared twice');
    assert.deepEqual([...new Set(directory.map(entry => entry.settingsNs))], [REPLACEMENT_ID], 'every entry names the replacement as the profile that configures it');
    assert.deepEqual(directory.find(entry => entry.provider === 'sw-anthropic')?.settingsPath, ['providers', 'sw-anthropic']);
    const entries = ctx.settings.describe().map(entry => entry.ns);
    assert.ok(!entries.includes(REPLACEMENT_ID) && !entries.includes('llm-pi-ai'), `Settings describes neither row: ${entries.join(', ')}`);

    const finish = await send(ctx, { ...ANTHROPIC, messages: conversationOf(rigLlm, ANTHROPIC, { carriers: 2, tail: 2 }) });
    assert.equal(finish?.kind, 'stop', JSON.stringify(finish));
    const [{ body, headers }] = served.requests;
    const last = carrierAt(body.messages, message => joinedText(message.content)).at(-1);
    assert.deepEqual(body.messages[last].content.at(-1).cache_control, { type: 'ephemeral' });
    assert.equal(headers['x-api-key'], 'sw-fixture-placeholder-key', 'the credential the profile names');
    await served.close();
  },

  // The session watcher's own consumer of the profile: its host, over the llm and Settings services of the activation composition and the replacement's sibling status, prices a session under the lifetime the route's profile declares in the original row's configuration, which the replacement read at startup.
  async 'loader-retention-pricing'() {
    const served = await endpoints();
    const { ctx: real } = await mountComposition(activation({ providers: pricedRoutes(served.origin) }));
    assert.ok(await waitFor(() => real.llm.listProviders().length === 2), 'the replacement serves both routes');
    assert.equal(real.get(PI_AI_SERVICE).failure, null);
    const longRatio = modelPolicyFor(CLAUDE, LONG_CACHE_TTL).cRatio;
    const defaultRatio = modelPolicyFor(CLAUDE, DEFAULT_CACHE_TTL).cRatio;
    assert.notEqual(longRatio, defaultRatio, 'the table prices the two lifetimes apart');
    assert.deepEqual(await ratiosOf(real, ['route-long', 'route-default']), { 'route-long': longRatio, 'route-default': defaultRatio });
    await served.close();
    await real.fiber.dispose();
  },

  // Both rows on: the replacement holds no authority over a lifetime while it serves no route. The original adapter serves the routes and Settings holds their profiles, so the host prices a route that declares long retention under the long lifetime, the original row's own, and a route that declares none under the default.
  async 'loader-both-rows-on-pricing'() {
    const served = await endpoints();
    const { ctx: real } = await mountComposition(activation({ providers: pricedRoutes(served.origin), keepOriginalOn: true }));
    assert.ok(await waitFor(() => real.llm.listProviders().length === 2), 'the original serves both routes');
    assert.deepEqual(real.get(PI_AI_SERVICE).failure, { cause: 'source-enabled' });
    const longRatio = modelPolicyFor(CLAUDE, LONG_CACHE_TTL).cRatio;
    const defaultRatio = modelPolicyFor(CLAUDE, DEFAULT_CACHE_TTL).cRatio;
    assert.notEqual(longRatio, defaultRatio, 'the table prices the two lifetimes apart');
    assert.deepEqual(await ratiosOf(real, ['route-long', 'route-default']), { 'route-long': longRatio, 'route-default': defaultRatio });
    await served.close();
    await real.fiber.dispose();
  },

  // The Settings service holds no second copy of the dictionary: nothing is configurable under the replacement's directory namespace, so a write is refused and neither patch layer changes.
  async 'loader-settings-write'() {
    const served = await endpoints();
    const { ctx, patchPath } = await mountComposition(activation({ providers: { 'sw-anthropic': anthropicRoute(served.origin) } }));
    assert.ok(await waitFor(() => ctx.llm.listProviders().some(provider => provider.id === 'sw-anthropic')));
    const { settingsNs } = ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'sw-anthropic');
    assert.equal(settingsNs, REPLACEMENT_ID);
    const { readFileSync } = await import('node:fs');
    const before = readFileSync(patchPath, 'utf8');
    await assert.rejects(ctx.settings.update(settingsNs, { providers: { 'sw-anthropic-added': { ...anthropicRoute(served.origin), models: [{ id: 'fixture-claude-added', ...MODEL }] } } }), /No configurable plugin entry/);
    assert.equal(readFileSync(patchPath, 'utf8'), before, 'the profile\'s layer is as it was');
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), ['sw-anthropic']);
    await served.close();
  },

  // What the original adapter owes the request besides its body, through both entries: the header contributors of `llm-pi-ai/request-headers` see the request's purpose and session, and a route naming a credential that is not stored fails the call before any request leaves, with the same failure.
  async 'headers-and-credentials'() {
    const seen = {};
    for (const entry of ['original', 'replacement']) {
      const served = await endpoints();
      const providers = { 'sw-anthropic': anthropicRoute(served.origin), 'sw-missing': { ...anthropicRoute(served.origin), apiKeyEnv: 'SW_FIXTURE_NOT_STORED' } };
      const { ctx, llm } = await mountPiAi({ entry, config: { providers } });
      ctx.on('llm-pi-ai/request-headers', (request, headers, next) => {
        headers.set('x-fixture-request', `${request.provider}/${request.purpose}/${request.sessionId}`);
        return next();
      });
      const messages = conversationOf(llm, ANTHROPIC, { carriers: 1, tail: 1 });
      const ok = await send(ctx, { ...ANTHROPIC, messages, purpose: 'inner-compaction', sessionId: 'fixture-session' });
      const failed = await send(ctx, { provider: 'sw-missing', model: 'fixture-claude', messages });
      seen[entry] = { ok: ok?.kind, header: served.requests[0].headers['x-fixture-request'], key: served.requests[0].headers['x-api-key'], failed, requests: served.requests.length };
      await ctx.fiber.dispose();
      await served.close();
    }
    assert.deepEqual(seen.replacement, seen.original);
    assert.deepEqual([seen.replacement.ok, seen.replacement.header, seen.replacement.key, seen.replacement.requests], ['stop', 'sw-anthropic/inner-compaction/fixture-session', 'sw-fixture-placeholder-key', 1]);
    assert.equal(seen.replacement.failed.failure.code, 'MISSING_CREDENTIAL');
  },

  // Native replay: an assistant turn the adapter produced is sent back as the same request through both entries, its provider state replayed as the original adapter replays it.
  async 'replay-parity'() {
    const bodies = {};
    for (const entry of ['original', 'replacement']) {
      const served = await endpoints({ reply: () => 'a reply the next request replays' });
      const { ctx, llm } = await mountPiAi({ entry, config: { providers: { 'sw-anthropic': anthropicRoute(served.origin) } } });
      const assembler = new llm.BlockAssembler();
      for await (const chunk of ctx.llm.stream({ ...ANTHROPIC, messages: conversationOf(llm, ANTHROPIC, { carriers: 0, tail: 0 }) })) assembler.push(chunk);
      const replayed = assembler.message({ provider: ANTHROPIC.provider, model: ANTHROPIC.model, ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }) });
      assert.ok(replayed.source?.replayState !== undefined, `${entry}: the adapter's turn carries provider replay state`);
      await send(ctx, { ...ANTHROPIC, messages: [...conversationOf(llm, ANTHROPIC, { carriers: 2, tail: 0 }), replayed, llm.createUserMessage({ content: [{ type: 'text', text: 'and then?' }], source: { kind: 'user' } })] });
      bodies[entry] = served.bodies('anthropic').at(-1);
      await ctx.fiber.dispose();
      await served.close();
    }
    const asked = bodies.original.messages.find(message => message.role === 'assistant' && JSON.stringify(message).includes('a reply the next request replays'));
    assert.ok(asked !== undefined, 'the replayed turn is in the request');
    const last = carrierAt(bodies.original.messages, message => joinedText(message.content)).at(-1);
    assert.deepEqual({ ...bodies.replacement, messages: bodies.replacement.messages.filter((_, at) => at !== last) }, { ...bodies.original, messages: bodies.original.messages.filter((_, at) => at !== last) });
    assert.deepEqual(bodies.replacement.messages[last].content.at(-1).cache_control, { type: 'ephemeral' });
  },

  // The two entries the package exports, resolved by name through the profile's runtime resolution: the host entry is the one it always was, and the opt-in pi-ai entry is a plugin of its own with no configuration schema, injecting the llm service and the Loader and registered under a name that is not the original's.
  async 'entries'() {
    // Mounting the adapter installs the profile's runtime resolution, which the host entry's own peers resolve through as well.
    const { ctx } = await mountPiAi({ entry: 'replacement', config: { providers: {} } });
    const { loadEntry, loadPiAiEntry } = await import((await import('node:url')).pathToFileURL(process.env.SW_FIXTURE_IMPORTER).href);
    const host = await loadEntry();
    assert.deepEqual(Object.keys(host).sort(), ['Config', 'apply', 'inject', 'name']);
    assert.equal(host.name, 'session-watcher');
    const piAi = await loadPiAiEntry();
    assert.deepEqual(Object.keys(piAi).sort(), ['apply', 'inject', 'name']);
    assert.deepEqual(piAi.inject, ['llm', 'loader']);
    const original = await import((await import('node:url')).pathToFileURL(`${process.env.SW_DSH_CHECKOUT}/packages/llm/llm-pi-ai/lib/index.js`).href);
    assert.notEqual(piAi.name, original.name, 'the replacement registers under a name of its own');
    await ctx.fiber.dispose();
  },

  // A carrier is told by its opening text alone: the wording inside a user's message or after other text is no carrier and the request stays the original's, while a message that opens with the wording is taken for one and given the point, which changes the cache marker only.
  async 'carrier-identification'() {
    const say = (llm, text) => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    const turn = (llm, text) => llm.createAssistantMessage({ content: [{ type: 'text', text }], source: ANTHROPIC });
    const quoted = (llm, route) => [say(llm, 'the opening request'), say(llm, `Quoted from the log: ${CARRIER_WORDING.addresses}`), turn(llm, 'a step'), say(llm, `A line first.\n${CARRIER_WORDING.addresses}`), turn(llm, 'another step'), say(llm, 'follow-up')];
    const typed = (llm, route) => [say(llm, 'the opening request'), say(llm, `${CARRIER_WORDING.addresses} Typed by the user, not a seal.`), turn(llm, 'a step'), say(llm, 'follow-up')];
    const quotedBodies = await bodiesOf({ providers: origin => ({ 'sw-anthropic': anthropicRoute(origin) }), route: ANTHROPIC, protocol: 'anthropic', messages: quoted });
    assert.deepEqual(quotedBodies.replacement, quotedBodies.original, 'the wording elsewhere than at the start is no carrier');
    const typedBodies = await bodiesOf({ providers: origin => ({ 'sw-anthropic': anthropicRoute(origin) }), route: ANTHROPIC, protocol: 'anthropic', messages: typed });
    const at = carrierAt(typedBodies.original.messages, message => joinedText(message.content)).at(-1);
    assert.deepEqual(typedBodies.replacement.messages[at].content.at(-1).cache_control, { type: 'ephemeral' });
    assert.deepEqual(withoutMessage(typedBodies.replacement, at), withoutMessage(typedBodies.original, at), 'and nothing else of the request differs');
  },

  // The reported sequence as payload shapes, not as proof of a cache hit: `H C1 C2 C3 A`, the continuation that rewarms it as `A` grows, and the seal that replaces `A` with `C4`. In each request the last carrier ends in a marker, and the content before C4 reads the same as the content before the rewarmed A, so the request after the seal looks up the prefix the rewarm wrote.
  async 'rewarm-then-seal'() {
    const served = await endpoints();
    const { ctx, llm } = await mountPiAi({ entry: 'replacement', config: { providers: { 'sw-anthropic': anthropicRoute(served.origin) } } });
    const say = text => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    const turn = text => llm.createAssistantMessage({ content: [{ type: 'text', text }], source: ANTHROPIC });
    const head = [say('the opening request'), carrierOf(llm, 'C1'), turn('step one'), carrierOf(llm, 'C2'), turn('step two'), carrierOf(llm, 'C3')];
    const a = [turn('A: a step after C3'), say('A: the ask after C3')];
    const rewarmed = [...a, turn('A: another step as it grows'), say('A: the ask as it grows')];
    for (const messages of [[...head, ...a], [...head, ...rewarmed], [...head, carrierOf(llm, 'C4'), say('the ask after C4')]]) await send(ctx, { ...ANTHROPIC, messages });
    const [warm, rewarm, sealed] = served.bodies('anthropic');
    const textOf = message => joinedText(message.content);
    const plain = message => ({ role: message.role, text: textOf(message) });
    const indexOf = (body, tag) => carrierAt(body.messages, textOf).find(at => textOf(body.messages[at]).includes(`${tag}: the first step`));
    const marked = (body, at) => Array.isArray(body.messages[at].content) && body.messages[at].content.at(-1).cache_control?.type === 'ephemeral';
    for (const body of [warm, rewarm]) assert.ok(marked(body, indexOf(body, 'C3')), 'C3, the last carrier of the request, ends in a marker');
    for (const body of [warm, rewarm]) assert.ok(!marked(body, indexOf(body, 'C2')) && !marked(body, indexOf(body, 'C1')), 'and no earlier carrier does');
    assert.ok(marked(sealed, indexOf(sealed, 'C4')), 'after the seal C4 ends in a marker');
    assert.ok(!marked(sealed, indexOf(sealed, 'C3')), 'where C3 no longer does');
    // The content ahead of the new carrier reads the same as the content ahead of the rewarmed A.
    const upToC3 = body => body.messages.slice(0, indexOf(body, 'C3') + 1).map(plain);
    assert.deepEqual(upToC3(sealed), upToC3(rewarm));
    assert.deepEqual(upToC3(rewarm), upToC3(warm));
    assert.equal(indexOf(sealed, 'C4'), indexOf(rewarm, 'C3') + 1, 'C4 stands where A began');
    await ctx.fiber.dispose();
    await served.close();
  },

  // The OAuth lane writes four native points (two system blocks, the last tool and the tail), so the carrier has no free point: the request is the original adapter's and one warning names the route.
  async 'anthropic-no-free-point'() {
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }];
    const { original, replacement, warnings } = await bodiesOf({
      providers: origin => ({ 'sw-anthropic': anthropicRoute(origin, { apiKeyEnv: OAUTH_REF }) }), route: ANTHROPIC, protocol: 'anthropic',
      messages: (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 }), extra: { system: 'the system prompt', tools },
    });
    const marks = body => JSON.stringify(body).split('"cache_control"').length - 1;
    assert.equal(marks(original), 4, 'the native serializer fills the four points');
    assert.deepEqual(replacement, original);
    assert.deepEqual(warnings.original, []);
    assert.equal(warnings.replacement.length, 1, `one warning: ${JSON.stringify(warnings.replacement)}`);
    assert.match(warnings.replacement[0], /sw-anthropic\/fixture-claude/);
  },
  // Every closed result the wrapped hook can leave, over the real pi-ai serializers and the loopback endpoints: each case sends one request inside the scope the host's evidence service opens around the stream and reads what the scope holds.
  async 'carrier-evidence-results'() {
    const sealed = (llm, route) => conversationOf(llm, route, { carriers: 2, tail: 2 });
    const carrierLast = (llm, route) => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')];
    const noCarrier = (llm, route) => conversationOf(llm, route, { carriers: 0, tail: 2 });
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } }];
    const added = { result: 'added' };
    const native = { result: 'native' };
    const skipped = reason => ({ result: 'skipped', reason });
    const cases = {
      'anthropic, the carrier takes the extra point': { providers: o => ({ 'sw-anthropic': anthropicRoute(o) }), route: ANTHROPIC, messages: sealed, expected: added },
      'anthropic, the native tail point already ends the carrier': { providers: o => ({ 'sw-anthropic': anthropicRoute(o) }), route: ANTHROPIC, messages: carrierLast, expected: native },
      'anthropic, caching off': { providers: o => ({ 'sw-anthropic': anthropicRoute(o, { cacheRetention: 'none' }) }), route: ANTHROPIC, messages: sealed, expected: skipped('no-native-point') },
      'anthropic, no carrier in the request': { providers: o => ({ 'sw-anthropic': anthropicRoute(o) }), route: ANTHROPIC, messages: noCarrier, expected: skipped('no-carrier') },
      'anthropic, the four native points fill the lane': {
        providers: o => ({ 'sw-anthropic': anthropicRoute(o, { apiKeyEnv: OAUTH_REF }) }), route: ANTHROPIC, messages: sealed, extra: { system: 'the system prompt', tools }, expected: skipped('points-full'),
      },
      'bedrock, the carrier takes the extra point': { providers: o => ({ 'amazon-bedrock': bedrockRoute(o) }), route: BEDROCK, messages: sealed, expected: added },
      'bedrock, the native tail point already ends the carrier': { providers: o => ({ 'amazon-bedrock': bedrockRoute(o) }), route: BEDROCK, messages: carrierLast, expected: native },
      'bedrock, caching off': { providers: o => ({ 'amazon-bedrock': bedrockRoute(o, { cacheRetention: 'none' }) }), route: BEDROCK, messages: sealed, expected: skipped('no-native-point') },
      'responses, the switch on, the carrier takes the explicit breakpoint': { providers: o => ({ openai: openaiRoute(o) }), route: RESPONSES, messages: sealed, responses: true, expected: added },
      'responses, the switch on, the last input item is the carrier': { providers: o => ({ openai: openaiRoute(o) }), route: RESPONSES, messages: carrierLast, responses: true, expected: native },
      'responses, the switch on, caching off sends explicit-only mode': { providers: o => ({ openai: openaiRoute(o, { cacheRetention: 'none' }) }), route: RESPONSES, messages: sealed, responses: true, expected: skipped('no-native-point') },
      'responses, the switch on, a route whose model declares no explicit-breakpoint capability': {
        providers: o => ({ 'sw-responses': responsesRoute(o) }), route: SW_RESPONSES, messages: sealed, responses: true, expected: added,
      },
      'responses, the switch off, a model that takes explicit breakpoints': { providers: o => ({ openai: openaiRoute(o) }), route: RESPONSES, messages: sealed, expected: skipped('responses-off') },
      'responses, the switch off, a route whose model declares no capability': { providers: o => ({ 'sw-responses': responsesRoute(o) }), route: SW_RESPONSES, messages: sealed, expected: skipped('responses-off') },
      'completions, a gateway of the Anthropic format': {
        providers: o => ({ 'sw-completions': completionsRoute(o, { compat: { cacheControlFormat: 'anthropic' } }) }), route: COMPLETIONS, messages: sealed, expected: added,
      },
      'completions, the native tail marker already ends the carrier': {
        providers: o => ({ 'sw-completions': completionsRoute(o, { compat: { cacheControlFormat: 'anthropic' } }) }), route: COMPLETIONS, messages: carrierLast, expected: native,
      },
      'completions, an endpoint of unstated format': { providers: o => ({ 'sw-completions': completionsRoute(o) }), route: COMPLETIONS, messages: sealed, expected: skipped('no-native-point') },
    };
    for (const [label, { providers, route, messages, extra, responses = false, expected }] of Object.entries(cases)) {
      const served = await endpoints();
      const { ctx, llm } = await mountPiAi({ entry: 'replacement', config: { providers: providers(served.origin) } });
      const evidence = createCarrierEvidence({ responsesBreakpoint: () => responses });
      ctx.provide(CARRIER_EVIDENCE_SERVICE, evidence.service);
      const scope = evidence.scope();
      await scope.run(() => send(ctx, { ...route, ...extra, messages: messages(llm, route) }));
      assert.deepEqual(scope.evidence(), { results: [expected], omitted: 0 }, label);
      assert.equal(served.requests.length, 1, `${label}: one request left`);
      await ctx.fiber.dispose();
      await served.close();
    }
  },

  // The hook's callback runs where pi-ai calls it, so the scope has to be the one of the stream that is being iterated: two scopes whose requests overlap in time, each over several sequential requests, and an unscoped request on the same adapter in the middle, are told apart, and the results of one scope come in the order its requests were serialized. A scope holds a bounded list and counts what it left out; a service whose record throws does not touch the request.
  async 'carrier-evidence-binding'() {
    const served = await endpoints({ delayMs: 120 });
    const providers = { 'sw-anthropic': anthropicRoute(served.origin), 'sw-off': anthropicRoute(served.origin, { cacheRetention: 'none' }) };
    const { ctx, llm } = await mountPiAi({ entry: 'replacement', config: { providers } });
    const evidence = createCarrierEvidence();
    ctx.provide(CARRIER_EVIDENCE_SERVICE, evidence.service);
    const on = { provider: 'sw-anthropic', model: 'fixture-claude' };
    const off = { provider: 'sw-off', model: 'fixture-claude' };
    const sealed = (route, carriers = 2) => conversationOf(llm, route, { carriers, tail: 2 });
    const carrierLast = route => [...conversationOf(llm, route, { carriers: 2, tail: 0 }).slice(0, -1), carrierOf(llm, 'C3')];
    const inScope = async (requests) => {
      const scope = evidence.scope();
      await scope.run(async () => { for (const request of requests) await send(ctx, request); });
      return scope.evidence();
    };
    const [first, second, unscoped] = await Promise.all([
      inScope([{ ...on, messages: sealed(on) }, { ...on, messages: carrierLast(on) }, { ...on, messages: sealed(on, 0) }]),
      inScope([{ ...off, messages: sealed(off) }, { ...off, messages: sealed(off) }]),
      send(ctx, { ...on, messages: carrierLast(on) }),
    ]);
    assert.equal(unscoped?.kind, 'stop');
    assert.deepEqual(first, { results: [{ result: 'added' }, { result: 'native' }, { result: 'skipped', reason: 'no-carrier' }], omitted: 0 });
    assert.deepEqual(second, { results: [{ result: 'skipped', reason: 'no-native-point' }, { result: 'skipped', reason: 'no-native-point' }], omitted: 0 });
    assert.equal(served.requests.length, 6, 'every request left, the unscoped one included');

    const many = await inScope(Array.from({ length: MAX_CARRIER_EVIDENCE + 3 }, () => ({ ...off, messages: sealed(off) })));
    assert.equal(many.results.length, MAX_CARRIER_EVIDENCE);
    assert.equal(many.omitted, 3);

    await ctx.fiber.dispose();
    // A service that cannot record leaves the request the one the serializer wrote with the carrier point, and one warning says the evidence is missing.
    const { ctx: broken, llm: brokenLlm } = await mountPiAi({ entry: 'replacement', config: { providers } });
    broken.provide(CARRIER_EVIDENCE_SERVICE, { record() { throw new Error('the evidence store is gone'); } });
    const before = served.requests.length;
    const finish = await send(broken, { ...on, messages: conversationOf(brokenLlm, on, { carriers: 2, tail: 2 }) });
    assert.equal(finish?.kind, 'stop');
    assert.equal(served.requests.length, before + 1);
    const marked = served.requests.at(-1).body.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])).filter(block => block.cache_control !== undefined).length;
    assert.ok(marked >= 2, 'the carrier point is still written');
    const warns = broken.logger.buffer.filter(each => each.type === 'warn').map(each => each.args.map(String).join(' '));
    assert.equal(warns.filter(line => line.includes('cache evidence')).length, 1, JSON.stringify(warns));
    await broken.fiber.dispose();
    await ctx.fiber.dispose();
    await served.close();
  },

  // The switch over the real Loader, plugin manager and Connection of an isolated profile: the status before, the switch on and the replacement owning the routes, and the switch off with the native adapter serving them again, each shown on the wire of a request over the route.
  async 'carrier-switch-takeover'() {
    const served = await endpoints();
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) } });
    const { call } = rig;
    assert.deepEqual(await call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
    assert.equal(rig.selected(), false);
    const native = await requestMarks(rig, served, ANTHROPIC);

    assert.deepEqual(await call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
    assert.equal(rig.selected(), true, 'the selection is saved');
    assert.deepEqual(await call('carrier-cache/status', {}), { ok: true, value: { state: 'on' } });
    assert.equal(await requestMarks(rig, served, ANTHROPIC), native + 1, 'the replacement serves the route: the last carrier takes one more point');
    assert.deepEqual(rig.ctx.get(PI_AI_SERVICE).routes(), ['sw-anthropic']);

    assert.deepEqual(await call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'disabled', native: 'restored' } });
    assert.equal(rig.selected(), false);
    assert.deepEqual(await call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
    assert.equal(await requestMarks(rig, served, ANTHROPIC), native, 'the native adapter serves the route again');
    assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined);
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // A selection that does not end in a confirmed takeover is rolled back, and the outcome is what the rollback verified of the saved selection and of the running composition: the manager's answers decide none of it.
  async 'carrier-switch-rollback'() {
    const secret = 'SECRET-CANARY-5521';
    const served = await endpoints();
    const route = anthropicRoute(served.origin);
    const still = async (rig, selected) => {
      assert.equal(rig.selected(), selected, `the saved selection is ${selected}`);
      assert.equal(rig.ctx.get(PI_AI_SERVICE) !== undefined, selected, `the entry's service stands exactly while the bundle is selected`);
    };

    // The manager reports the selection failed, though it took effect: the rollback finds the selection saved and the entry mounted, undoes both and proves the native adapter serving again.
    {
      const calls = [];
      let native;
      const rig = await managedRig({
        providers: { 'sw-anthropic': route },
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          async setBundleEnabled(name, enabled) {
            calls.push([name, enabled]);
            const result = await manager.setBundleEnabled(name, enabled);
            return enabled ? { ...result, application: 'failed' } : result;
          },
        }),
      });
      native = await requestMarks(rig, served, ANTHROPIC);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'apply-failed' } });
      assert.deepEqual(calls, [[LOCAL_CARRIER_BUNDLE, true], [LOCAL_CARRIER_BUNDLE, false]]);
      await still(rig, false);
      assert.equal(await requestMarks(rig, served, ANTHROPIC), native, 'the native adapter serves the route again');
      await rig.ctx.fiber.dispose();
    }

    // The manager applies the selection and the entry mounts with `failure: null`, but its dictionary is empty, so it registered no route: that is no takeover, and the rollback restores the original adapter.
    {
      const rig = await managedRig({ providers: {} });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'not-confirmed' } });
      await still(rig, false);
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
      await rig.ctx.fiber.dispose();
    }

    // Neither adapter can use the dictionary: the entry reports its cause, the rollback withdraws it and the original is not proven restored, which the outcome says in place of `rolled-back`.
    {
      const rig = await managedRig({ providers: { 'sw-anthropic': { ...route, headers: { Authorization: `Bearer ${secret}` }, streamIdleTimeoutMs: secret } } });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'withdrawn', reason: 'not-confirmed', cause: 'source-invalid' } });
      await still(rig, false);
      // The Loader's own diagnostic of the original adapter's refused configuration quotes the value, which is the Harness's and not the switch's or the entry's.
      assert.deepEqual([...new Set(rig.ctx.logger.buffer.filter(entry => JSON.stringify(entry).includes(secret)).map(entry => entry.name))], ['hmr'], 'only the Loader\'s own line quotes the configuration');
      await rig.ctx.fiber.dispose();
    }

    // The rollback itself fails: the entry stays mounted and the bundle stays selected, which the outcome says, and a later request is answered.
    {
      const rig = await managedRig({
        providers: {},
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          setBundleEnabled: (name, enabled) => (enabled ? manager.setBundleEnabled(name, enabled) : Promise.reject(new Error('the profile lock timed out'))),
        }),
      });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rollback-failed', reason: 'not-confirmed' } });
      await still(rig, true);
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      await rig.ctx.fiber.dispose();
    }

    // The deselection takes effect and the entry is gone, but the selection is saved again before the host reads it back: the rollback does not call that a rolled-back selection, and a deselection does not call itself disabled.
    {
      let rig;
      rig = await managedRig({
        providers: { 'sw-anthropic': route },
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          async setBundleEnabled(name, enabled) {
            const result = await manager.setBundleEnabled(name, enabled);
            if (!enabled) rig.resave();
            return result;
          },
        }),
      });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'failed' } }, 'the selection is still saved on');
      assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined, 'the entry is gone');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      await rig.ctx.fiber.dispose();
      rig = await managedRig({
        providers: {},
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          async setBundleEnabled(name, enabled) {
            const result = await manager.setBundleEnabled(name, enabled);
            if (!enabled) rig.resave();
            return result;
          },
        }),
      });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rollback-failed', reason: 'not-confirmed' } });
      assert.equal(rig.selected(), true);
      assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined);
      await rig.ctx.fiber.dispose();
    }

    // With the entry failed and the rollback failed, the status names the entry's cause beside the pending state.
    {
      const rig = await managedRig({
        providers: { 'sw-anthropic': { ...route, streamIdleTimeoutMs: secret } },
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          setBundleEnabled: (name, enabled) => (enabled ? manager.setBundleEnabled(name, enabled) : Promise.reject(new Error('the profile lock timed out'))),
        }),
      });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rollback-failed', reason: 'not-confirmed', cause: 'source-invalid' } });
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending', cause: 'source-invalid' } });
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // A manager that answers restart-required has not applied the selection, so what runs is unchecked, and the switch leaves no unchecked substitution for the next start: it withdraws the selection it saved and says why. A startup-only profile is such a manager, and so is one that reports restart-required for a change that did take effect.
  async 'carrier-switch-restart'() {
    const served = await endpoints();
    const route = anthropicRoute(served.origin);
    const spy = calls => manager => ({
      listBundles: () => manager.listBundles(),
      setBundleEnabled(name, enabled) { calls.push([name, enabled]); return manager.setBundleEnabled(name, enabled); },
    });
    {
      const calls = [];
      const rig = await managedRig({ providers: { 'sw-anthropic': route }, hmr: false, wrap: spy(calls) });
      const native = await requestMarks(rig, served, ANTHROPIC);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'restart-required' } });
      assert.deepEqual(calls, [[LOCAL_CARRIER_BUNDLE, true], [LOCAL_CARRIER_BUNDLE, false]], 'the selection was saved, then withdrawn');
      assert.equal(rig.selected(), false, 'no selection is left for the next start');
      assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined, 'nothing mounted');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
      assert.equal(await requestMarks(rig, served, ANTHROPIC), native, 'the native adapter still serves the route');
      await rig.ctx.fiber.dispose();
    }
    // The manager reports restart-required for a selection that was applied and confirmed: the answer is the one trusted, so the selection is withdrawn and the native adapter restored.
    {
      const rig = await managedRig({
        providers: { 'sw-anthropic': route },
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          async setBundleEnabled(name, enabled) {
            const result = await manager.setBundleEnabled(name, enabled);
            return enabled ? { ...result, application: 'restart-required' } : result;
          },
        }),
      });
      const native = await requestMarks(rig, served, ANTHROPIC);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'restart-required' } });
      assert.equal(rig.selected(), false);
      assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined);
      assert.equal(await requestMarks(rig, served, ANTHROPIC), native, 'the native adapter serves the route again');
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // A profile that started with the bundle selected and cannot apply a change: the replacement keeps running after a deselection, so the status never says off while it is mounted, the host does not believe an applied answer that left it mounted, and a request to switch on a selection that is not confirmed withdraws the selection with the replacement still mounted, which is a failed rollback and not a withdrawn replacement. The page's store reads exactly what the host answers.
  async 'carrier-switch-started-selected'() {
    const served = await endpoints();
    const route = anthropicRoute(served.origin);
    const native = await (async () => {
      const rig = await managedRig({ providers: { 'sw-anthropic': route } });
      const marks = await requestMarks(rig, served, ANTHROPIC);
      await rig.ctx.fiber.dispose();
      return marks;
    })();
    {
      const rig = await managedRig({ providers: { 'sw-anthropic': route }, hmr: false, started: true });
      const store = createCarrierCacheStore({ call: rig.call });
      await store.load();
      assert.deepEqual(store.getSnapshot(), { state: 'on', busy: false, outcome: null });
      assert.equal(await requestMarks(rig, served, ANTHROPIC), native + 1, 'the replacement serves the route');
      await store.set(false);
      assert.deepEqual(store.getSnapshot(), { state: 'pending', busy: false, outcome: { outcome: 'restart-required' } }, 'the page is told the replacement is still in place');
      assert.equal(rig.selected(), false, 'the deselection is saved');
      assert.deepEqual(rig.ctx.get(PI_AI_SERVICE).routes(), ['sw-anthropic'], 'the replacement is still mounted');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      assert.equal(await requestMarks(rig, served, ANTHROPIC), native + 1, 'and it still serves the route');
      await rig.ctx.fiber.dispose();
    }
    {
      const rig = await managedRig({
        providers: { 'sw-anthropic': route }, hmr: false, started: true,
        wrap: manager => ({
          listBundles: () => manager.listBundles(),
          async setBundleEnabled(name, enabled) { return { ...await manager.setBundleEnabled(name, enabled), application: 'applied' }; },
        }),
      });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'failed' } }, 'the answer applied does not outweigh the replacement still mounted');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      await rig.ctx.fiber.dispose();
    }
    {
      const rig = await managedRig({ providers: {}, hmr: false, started: true });
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } }, 'the replacement mounted with no route is no takeover');
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'rollback-failed', reason: 'restart-required' } });
      assert.equal(rig.selected(), false, 'the selection is withdrawn');
      assert.notEqual(rig.ctx.get(PI_AI_SERVICE), undefined, 'the replacement stays mounted until a restart');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // A third adapter takes the route the moment the original lets it go: the replacement is refused, the original cannot return, and the route list still names the route, held by the third adapter. The host reports the replacement withdrawn and the original's restoration unconfirmed, never a restored original, because the Loader row is not mounted.
  async 'carrier-switch-competitor'() {
    const served = await endpoints();
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) } });
    const competitor = { providerInfo: id => ({ id, name: 'competitor' }), providerRetryPolicy: () => undefined, async *stream() {} };
    let taken = 0;
    rig.ctx.on('llm/adapters-updated', () => {
      if (taken > 0 || rig.ctx.llm.listProviders().some(provider => provider.id === 'sw-anthropic')) return;
      taken += 1;
      rig.ctx.llm.registerAdapter(['sw-anthropic'], competitor);
    });
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'withdrawn', reason: 'apply-failed' } });
    assert.equal(taken, 1, 'the third adapter took the route');
    assert.deepEqual(rig.ctx.llm.listProviders().filter(provider => provider.id === 'sw-anthropic').map(provider => provider.name), ['competitor'], 'the registry lists the route, held by the third adapter');
    assert.deepEqual(carrierCacheDepsOf(rig.ctx).native(), { disabled: false, mounted: false, routes: ['sw-anthropic'] }, 'the original row is on and not mounted');
    assert.equal(rig.selected(), false);
    assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined);
    assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // The status is read from the running composition each time: once the takeover is confirmed, a Loader edit that the replacement does not follow takes the `on` away, since the replacement serves the dictionary it read at its start and the original row's current one is what an original adapter would serve, or since the original row is on again and cannot mount beside the replacement.
  async 'carrier-switch-drift'() {
    const served = await endpoints();
    const route = anthropicRoute(served.origin);
    {
      const rig = await managedRig({ providers: { 'sw-anthropic': route } });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
      await rig.rewrite(activation({ providers: { 'sw-anthropic': route, 'sw-second': route } }).layer);
      assert.ok(await waitFor(() => carrierCacheDepsOf(rig.ctx).native()?.routes.length === 2), 'the Loader composed the edited dictionary');
      assert.deepEqual(rig.ctx.get(PI_AI_SERVICE).routes(), ['sw-anthropic'], 'the replacement still serves the dictionary it read at its start');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      await rig.ctx.fiber.dispose();
    }
    {
      const rig = await managedRig({ providers: { 'sw-anthropic': route } });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
      await rig.rewrite(['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  disabled: false', `  config: ${JSON.stringify({ providers: { 'sw-anthropic': route } })}`, ''].join('\n'));
      assert.ok(await waitFor(() => carrierCacheDepsOf(rig.ctx).native()?.disabled === false), 'the Loader composed the original row on');
      assert.deepEqual(carrierCacheDepsOf(rig.ctx).native(), { disabled: false, mounted: false, routes: ['sw-anthropic'] }, 'it cannot mount beside the replacement');
      assert.deepEqual(rig.ctx.get(PI_AI_SERVICE).routes(), ['sw-anthropic'], 'the replacement keeps the route');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'pending' } });
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // The management is the owner's: the channel's handler is given the peer the connection layer admitted, and a peer whose principal is another kind, or none at all, reaches no manager call and no status read. The target is the switch's own, whatever the body names.
  async 'carrier-switch-auth'() {
    const served = await endpoints();
    const calls = [];
    const rig = await managedRig({
      providers: { 'sw-anthropic': anthropicRoute(served.origin) },
      wrap: manager => ({
        listBundles: () => { calls.push('list'); return manager.listBundles(); },
        setBundleEnabled: (name, enabled) => { calls.push([name, enabled]); return manager.setBundleEnabled(name, enabled); },
      }),
    });
    const guest = rig.ctx.connection.createPeer({ principal: { kind: 'guest' } });
    const signal = new AbortController().signal;
    for (const [label, peer] of [['a guest peer', guest], ['no peer', undefined]]) {
      for (const [endpoint, payload] of [['carrier-cache/status', {}], ['carrier-cache/set', { enabled: true }], ['carrier-cache/set', { nonsense: true }]]) {
        const reply = await rig.handler(endpoint, payload, signal, peer);
        assert.equal(reply.ok, false, `${label}: ${endpoint}`);
        assert.equal(reply.error.code, 'forbidden', `${label}: ${endpoint}`);
      }
    }
    assert.deepEqual(calls, [], 'the manager was not touched');
    assert.equal(rig.selected(), false);

    // The owner's own peer, the one the connection layer admits a browser with, is let through, and the body can only say whether, never which.
    assert.deepEqual(await rig.handler('carrier-cache/set', { enabled: 'yes' }, signal, rig.ctx.connection.browserPeer), { ok: false, error: { code: 'invalid_body', message: 'Body must contain { enabled: boolean }', details: {} } });
    const reply = await rig.handler('carrier-cache/set', { enabled: true, name: '@other/bundle', bundle: '@other/bundle', target: 'llm' }, signal, rig.ctx.connection.browserPeer);
    assert.deepEqual(reply, { ok: true, value: { outcome: 'enabled' } });
    assert.deepEqual(calls.filter(call => Array.isArray(call)), [[LOCAL_CARRIER_BUNDLE, true]]);

    // Over the wire a request with no session cookie never reaches the handler.
    const response = await fetch(`http://127.0.0.1:${rig.ctx.webServer.port}/session-watcher/carrier-cache/set`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: 'carrier-cache/set', payload: { enabled: false } }),
    });
    assert.ok([401, 403].includes(response.status), `status ${response.status}`);
    assert.equal(rig.selected(), true);
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // One selection at a time: a second one that arrives while the first runs is answered `busy` and reaches no manager, and the guard is released whether the first ended well or not.
  async 'carrier-switch-guard'() {
    const served = await endpoints();
    const calls = [];
    let fail = false;
    const rig = await managedRig({
      providers: { 'sw-anthropic': anthropicRoute(served.origin) },
      wrap: manager => ({
        listBundles: () => manager.listBundles(),
        setBundleEnabled(name, enabled) {
          calls.push([name, enabled]);
          return fail ? Promise.reject(new Error('the manager failed')) : manager.setBundleEnabled(name, enabled);
        },
      }),
    });
    const outcomes = (await Promise.all([rig.call('carrier-cache/set', { enabled: true }), rig.call('carrier-cache/set', { enabled: true })])).map(reply => reply.value.outcome);
    assert.deepEqual([...outcomes].sort(), ['busy', 'enabled']);
    assert.deepEqual(calls, [[LOCAL_CARRIER_BUNDLE, true]], 'one request reached the manager');
    // A request that ends in a failure releases the guard, and one that follows is taken.
    fail = true;
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'failed' } });
    fail = false;
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'disabled', native: 'restored' } });
    assert.equal((await rig.call('carrier-cache/status', {})).value.state, 'off');
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // A profile with no plugin manager, and one whose manager does not list the bundle, have no switch: the status and a selection both say it is unavailable and change nothing.
  async 'carrier-switch-unavailable'() {
    for (const [label, options] of [['no manager', { manager: false }], ['no bundle on disk', { installed: false }]]) {
      const rig = await managedRig({ providers: {}, ...options });
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'unavailable' } }, label);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'unavailable' } }, label);
      assert.equal(rig.selected(), false, label);
      await rig.ctx.fiber.dispose();
    }
    // A host with no switch at all answers so as well.
    const handler = createRpcHandler({ table: { get: () => ({ state: 'unobserved' }), live: () => [] }, store: {} });
    assert.equal((await handler('carrier-cache/status', {}, new AbortController().signal, OWNER_PEER)).error.code, 'carrier_cache_unavailable');
  },

  // ── First install ──────────────────────────────────────────────────────────
  // A bundle that is installed nowhere, with an install source the host was given, is offered and never installed unasked: the status names what would be installed, a request without the owner's confirmation (anything but the literal `true`) is answered with the need for it and leaves the profile and the manager as they were. With no install source the switch is as unavailable as it was before the install existed, a confirmation or not.
  async 'carrier-install-gate'() {
    const served = await endpoints();
    const target = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const touched = [];
    const profileState = rig => ({ manifest: readFileSync(join(rig.profileDir, 'package.json'), 'utf8'), lock: existsSync(join(rig.profileDir, 'pnpm-lock.yaml')), logs: existsSync(join(rig.profileDir, '.plugin-manager')) });

    const without = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, wrap: spied(touched) });
    assert.deepEqual(await without.call('carrier-cache/status', {}), { ok: true, value: { state: 'unavailable' } }, 'no install source: as before');
    assert.deepEqual(await without.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'unavailable' } });
    assert.deepEqual(touched, []);
    await without.ctx.fiber.dispose();

    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: target.spec, version: target.version }, wrap: spied(touched) });
    const before = profileState(rig);
    assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'not-installed', install: { name: OFFICIAL_CARRIER_BUNDLE, version: target.version } } });
    for (const confirmInstall of [undefined, false, 'true', 1, {}, null]) {
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, ...confirmInstall === undefined ? {} : { confirmInstall } }), { ok: true, value: { outcome: 'install-confirmation-required' } }, String(confirmInstall));
    }
    // A request cannot name what to install: no member of the body but the two booleans is read.
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, spec: '@other/bundle', target: '/tmp/other.tgz', name: '@other/bundle', registry: 'http://example.invalid' }), { ok: true, value: { outcome: 'install-confirmation-required' } });
    assert.deepEqual(touched, [], 'the manager was not asked to do anything');
    assert.deepEqual(profileState(rig), before, 'the profile is as it was');
    // Switching off what is not installed has nothing to switch.
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false, confirmInstall: true }), { ok: true, value: { outcome: 'unavailable' } });
    assert.deepEqual(touched, []);
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // The whole first install over the real isolated profile and the offline pnpm: the confirmed request installs the packed official bundle disabled, reads its identity back, selects it through the manager and shows the replacement serving the route; the package is what a publication would carry, two rows and no configuration, and switching off leaves it installed, so the next switching on installs nothing.
  async 'carrier-install-flow'() {
    const served = await endpoints();
    const target = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const calls = [];
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: target.spec, version: target.version }, wrap: spied(calls) });
    const native = await requestMarks(rig, served, ANTHROPIC);
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'enabled', installed: true } });
    assert.deepEqual(calls, [['install', target.spec, { enabled: false, saveExact: true }], ['select', OFFICIAL_CARRIER_BUNDLE, true]], 'installed disabled, with no registry and no script approval, then selected');

    const [bundle] = (await rig.ctx.get('pluginManager').listBundles()).filter(each => each.name === OFFICIAL_CARRIER_BUNDLE);
    assert.equal(bundle.installed, true);
    assert.equal(bundle.availability, 'profile');
    assert.equal(bundle.enabled, true);
    assert.equal(bundle.version, target.version);
    assert.equal(bundle.error, undefined);
    assert.deepEqual(bundle.rows.map(({ rowId, moduleName }) => ({ rowId, moduleName })), [{ rowId: REPLACEMENT_ID, moduleName: REPLACEMENT_SPECIFIER }], 'the bundle inserts the replacement row only');
    assert.deepEqual(bundle.overrides, ['llm-pi-ai'], 'and changes the original row only');
    assert.match(rig.manifest().dependencies[OFFICIAL_CARRIER_BUNDLE], /^file:.*\.tgz$/);
    assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), true);
    assert.equal(rig.selected(), false, 'the local bundle is not in the profile and not selected');

    // The composition: the original row off and unmounted, the replacement mounted with no configuration of its own and serving the route.
    const original = rig.ctx.loader.resolve('include:llm-pi-ai');
    assert.equal(original.disabled, true);
    assert.notEqual(original.fiber?.state, FIBER_ACTIVE);
    assert.equal(rig.ctx.loader.resolve(`include:${REPLACEMENT_ID}`).options.config, undefined);
    assert.deepEqual(rig.ctx.get(PI_AI_SERVICE).routes(), ['sw-anthropic']);
    assert.equal(await requestMarks(rig, served, ANTHROPIC), native + 1);
    assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'on' } });

    // Switching off leaves the package installed and disabled; switching on again reuses it.
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'disabled', native: 'restored' } });
    assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
    assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), false);
    assert.ok(Object.hasOwn(rig.manifest().dependencies, OFFICIAL_CARRIER_BUNDLE), 'the dependency stays');
    assert.equal(await requestMarks(rig, served, ANTHROPIC), native);
    calls.length = 0;
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } }, 'no confirmation is asked for what is installed');
    assert.deepEqual(calls, [['select', OFFICIAL_CARRIER_BUNDLE, true]], 'and nothing is installed again');
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // The local bundle and the official one are each reused as they are, whatever the install source: with one of them installed the switch selects that one and installs nothing, asks for no confirmation, and answers as it always did. An official bundle at another version than the install source names is reused too: the version is checked when the switch installs and not when it reuses, so nothing is installed over it or upgraded.
  async 'carrier-install-reuse'() {
    const served = await endpoints();
    const target = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const providers = { 'sw-anthropic': anthropicRoute(served.origin) };
    {
      const calls = [];
      const rig = await managedRig({ providers, installed: true, target: { spec: target.spec, version: target.version }, wrap: spied(calls) });
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
      assert.deepEqual(calls, [['select', LOCAL_CARRIER_BUNDLE, true]]);
      assert.equal(rig.selected(LOCAL_CARRIER_BUNDLE), true);
      assert.equal(Object.hasOwn(rig.manifest().dependencies, OFFICIAL_CARRIER_BUNDLE), false);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'disabled', native: 'restored' } });
      await rig.ctx.fiber.dispose();
    }
    {
      const calls = [];
      const rig = await managedRig({ providers, installed: false, wrap: spied(calls) });
      const done = await rig.ctx.get('pluginManager').installBundle(target.spec, { enabled: false });
      assert.equal(done.bundle, OFFICIAL_CARRIER_BUNDLE, 'a bundle installed by a manager of its own');
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } }, 'no install source of its own is needed');
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
      assert.deepEqual(calls, [['select', OFFICIAL_CARRIER_BUNDLE, true]]);
      assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), true);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'disabled', native: 'restored' } });
      await rig.ctx.fiber.dispose();
    }
    {
      const calls = [];
      const rig = await managedRig({ providers, installed: false, target: { spec: join(process.env.TMPDIR, 'other-version.tgz'), version: '999.0.0' }, wrap: spied(calls) });
      await rig.ctx.get('pluginManager').installBundle(target.spec, { enabled: false });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
      assert.deepEqual(calls, [['select', OFFICIAL_CARRIER_BUNDLE, true]], 'the install source is not asked for');
      const [bundle] = (await rig.ctx.get('pluginManager').listBundles()).filter(each => each.name === OFFICIAL_CARRIER_BUNDLE);
      assert.equal(bundle.version, target.version, 'the installed version stays');
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // Nothing is installed over what is not a missing bundle: both bundles at once, a bundle the manager lists but cannot read (either one, or a selection with no package behind it) and an inventory the manager cannot read each leave the switch unavailable with the reason, and a confirmed request reaches neither the install nor the selection.
  async 'carrier-install-refuses'() {
    const served = await endpoints();
    const target = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const fixed = { spec: target.spec, version: target.version };
    const providers = { 'sw-anthropic': anthropicRoute(served.origin) };
    const refused = async (label, rig, calls, reason) => {
      const before = rig.manifest();
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'unavailable', reason } }, label);
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'unavailable' } }, label);
      assert.deepEqual(calls.filter(call => call[0] !== 'list'), [], `${label}: nothing installed or selected`);
      assert.deepEqual(rig.manifest(), before, `${label}: the profile is as it was`);
      await rig.ctx.fiber.dispose();
    };
    const officialInstalled = async (rig) => { assert.equal((await rig.ctx.get('pluginManager').installBundle(target.spec, { enabled: false })).bundle, OFFICIAL_CARRIER_BUNDLE); };

    let calls = [];
    let rig = await managedRig({ providers, installed: true, target: fixed, wrap: spied(calls) });
    await officialInstalled(rig);
    await refused('both bundles', rig, calls, 'conflict');

    calls = [];
    rig = await managedRig({ providers, installed: false, target: fixed, wrap: spied(calls) });
    await officialInstalled(rig);
    rmSync(join(rig.profileDir, 'node_modules', ...OFFICIAL_CARRIER_BUNDLE.split('/')), { recursive: true });
    await refused('an official bundle whose files are gone', rig, calls, 'damaged');

    calls = [];
    rig = await managedRig({ providers, installed: false, target: fixed, wrap: spied(calls) });
    await officialInstalled(rig);
    const manifestPath = join(rig.profileDir, 'node_modules', ...OFFICIAL_CARRIER_BUNDLE.split('/'), 'package.json');
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), engines: { dsh: '>=99.0.0' } }));
    await refused('an official bundle the manager refuses for a version of the Harness it needs', rig, calls, 'damaged');

    calls = [];
    rig = await managedRig({ providers, installed: true, target: fixed, wrap: spied(calls) });
    rmSync(join(rig.profileDir, 'node_modules', ...LOCAL_CARRIER_BUNDLE.split('/')), { recursive: true });
    await refused('a local bundle whose files are gone', rig, calls, 'damaged');

    calls = [];
    rig = await managedRig({ providers, installed: false, target: fixed, wrap: spied(calls) });
    const saved = rig.manifest();
    writeFileSync(join(rig.profileDir, 'package.json'), `${JSON.stringify({ ...saved, dsh: { ...saved.dsh, profile: { ...saved.dsh.profile, bundles: [...saved.dsh.profile.bundles, OFFICIAL_CARRIER_BUNDLE] } } }, undefined, 2)}\n`);
    await refused('a selection with no package behind it', rig, calls, 'damaged');

    calls = [];
    rig = await managedRig({ providers, installed: false, target: fixed, wrap: spied(calls, { listBundles: () => Promise.reject(new Error('the inventory cannot be read')) }) });
    await refused('an inventory that cannot be read', rig, calls, 'unreadable');
    await served.close();
  },

  // A first install that does not end in a confirmed package selects nothing and says which way it failed: the manager's failure and a throw (nothing was installed), a package with a script (never approved here: the script has not run and nothing is saved, so the install fails), a package that is not the fixed identity and one whose version is not the target's (installed, disabled and kept).
  async 'carrier-install-failures'() {
    const served = await endpoints();
    const root = process.env.TMPDIR;
    const official = packOffline(BUNDLE_PACKAGE, join(root, 'pack'));
    const providers = { 'sw-anthropic': anthropicRoute(served.origin) };
    const INSTALL = { enabled: false, saveExact: true };
    const rigFor = async (target, over) => {
      const calls = [];
      const rig = await managedRig({ providers, installed: false, target, wrap: spied(calls, over) });
      return { rig, calls, before: readFileSync(join(rig.profileDir, 'package.json'), 'utf8') };
    };
    const confirmed = rig => rig.call('carrier-cache/set', { enabled: true, confirmInstall: true });

    // The manager's own failure: pnpm cannot find the package. The profile is as it was and the offer stands.
    {
      const missing = join(root, 'nothing.tgz');
      const { rig, calls, before } = await rigFor({ spec: missing, version: official.version });
      const { value } = await confirmed(rig);
      assert.equal(value.outcome, 'install-failed');
      assert.deepEqual(calls, [['install', missing, INSTALL]]);
      assert.equal(readFileSync(join(rig.profileDir, 'package.json'), 'utf8'), before);
      assert.deepEqual((await rig.call('carrier-cache/status', {})).value.state, 'not-installed');
      await rig.ctx.fiber.dispose();
    }
    // A manager that throws.
    {
      const { rig, calls, before } = await rigFor({ spec: official.spec, version: official.version }, { installBundle: () => Promise.reject(new Error('the manager failed')) });
      assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-failed' } });
      assert.deepEqual(calls, [['install', official.spec, INSTALL]]);
      assert.equal(readFileSync(join(rig.profileDir, 'package.json'), 'utf8'), before);
      await rig.ctx.fiber.dispose();
    }
    // A package with a script: pnpm refuses to run it and the manager fails the install and does not save the dependency, so the switch ends as a failed install. Each further confirmation ends the same way; none approves the script.
    {
      const marker = join(root, 'SCRIPT-RAN');
      const hostile = packBundleFixture(join(root, 'hostile'), { name: OFFICIAL_CARRIER_BUNDLE, version: official.version, scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"` } });
      const { rig, calls, before } = await rigFor({ spec: hostile.spec, version: hostile.version });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-failed' } }, `attempt ${attempt}`);
        assert.equal(existsSync(marker), false, 'the package script has not run');
        assert.equal(readFileSync(join(rig.profileDir, 'package.json'), 'utf8'), before, 'the dependency is not saved');
        const policy = readFileSync(join(rig.profileDir, 'pnpm-workspace.yaml'), 'utf8');
        assert.match(policy, /set this to true or false/, 'the script is left unapproved');
        assert.doesNotMatch(policy, /:\s*true\s*$/m, 'no script is allowed');
        assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), false);
      }
      assert.deepEqual(calls, [['install', hostile.spec, INSTALL], ['install', hostile.spec, INSTALL]], 'two installs, no selection, no approval in either');
      assert.equal((await rig.call('carrier-cache/status', {})).value.state, 'not-installed');
      await rig.ctx.fiber.dispose();
    }
    // A package of the right name at a version other than the target's: installed and disabled, not selected, and not accepted. The disabled package is kept.
    {
      const { rig, calls } = await rigFor({ spec: official.spec, version: '9.9.9' });
      assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-unconfirmed' } });
      assert.deepEqual(calls, [['install', official.spec, INSTALL]], 'nothing was selected');
      assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), false);
      const listed = (await rig.ctx.get('pluginManager').listBundles()).find(each => each.name === OFFICIAL_CARRIER_BUNDLE);
      assert.deepEqual([listed.installed, listed.enabled, listed.version], [true, false, official.version], 'the disabled package stays');
      assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined);
      await rig.ctx.fiber.dispose();
    }
    // A package of another name: it is the target's doing, and it is kept disabled, but the official bundle is still missing and nothing is selected.
    {
      const foreign = packBundleFixture(join(root, 'foreign'), { name: '@x/other-bundle' });
      const { rig, calls } = await rigFor({ spec: foreign.spec, version: foreign.version });
      assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-unconfirmed' } });
      assert.deepEqual(calls, [['install', foreign.spec, INSTALL]]);
      assert.deepEqual(rig.manifest().dsh.profile.bundles.filter(name => name.includes('other-bundle') || name === OFFICIAL_CARRIER_BUNDLE), []);
      assert.ok(Object.hasOwn(rig.manifest().dependencies, '@x/other-bundle'), 'the package stays');
      assert.equal((await rig.call('carrier-cache/status', {})).value.state, 'not-installed');
      await rig.ctx.fiber.dispose();
    }
    // A package that comes out under the local bundle's name is not the official one either: the local bundle is what is left installed and nothing is selected.
    {
      const lookalike = packBundleFixture(join(root, 'lookalike'), { name: LOCAL_CARRIER_BUNDLE });
      const { rig, calls } = await rigFor({ spec: lookalike.spec, version: lookalike.version });
      assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-unconfirmed' } });
      assert.deepEqual(calls, [['install', lookalike.spec, INSTALL]]);
      assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE) || rig.selected(LOCAL_CARRIER_BUNDLE), false);
      await rig.ctx.fiber.dispose();
    }
    // A package that comes out selected is not the disabled package asked for: the switch did not select it and does not accept it.
    {
      const { rig, calls } = await rigFor({ spec: official.spec, version: official.version }, { installBundle: (spec, options) => rig.ctx.get('pluginManager').installBundle(spec, { ...options, enabled: true }) });
      assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-unconfirmed' } });
      assert.deepEqual(calls, [['install', official.spec, INSTALL]], 'the switch selected nothing');
      await rig.ctx.fiber.dispose();
    }
    // An inventory that cannot be read once the package is in cannot confirm it: nothing is selected and the package stays.
    {
      let ran = false;
      const { rig, calls } = await rigFor({ spec: official.spec, version: official.version }, {
        installBundle: async (spec, options) => { const result = await rig.ctx.get('pluginManager').installBundle(spec, options); ran = true; return result; },
        listBundles: () => (ran ? Promise.reject(new Error('the inventory cannot be read')) : rig.ctx.get('pluginManager').listBundles()),
      });
      assert.deepEqual(await confirmed(rig), { ok: true, value: { outcome: 'install-unconfirmed' } });
      assert.deepEqual(calls, [['install', official.spec, INSTALL]]);
      assert.ok(Object.hasOwn(rig.manifest().dependencies, OFFICIAL_CARRIER_BUNDLE), 'the package stays');
      assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), false);
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // A selection that fails after the install is the switch's own rollback and compensation over a package that stays installed, disabled and kept: the answer says the package was installed, tells the withdrawn replacement from the one whose original adapter is proven serving again, and names a restart the manager asked for; no case uninstalls.
  async 'carrier-install-enable-failures'() {
    const served = await endpoints();
    const official = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const target = { spec: official.spec, version: official.version };
    const route = anthropicRoute(served.origin);
    const kept = async (label, rig) => {
      const listed = (await rig.ctx.get('pluginManager').listBundles()).find(each => each.name === OFFICIAL_CARRIER_BUNDLE);
      assert.deepEqual([listed.installed, listed.enabled, listed.error], [true, false, undefined], `${label}: installed and disabled`);
      assert.ok(Object.hasOwn(rig.manifest().dependencies, OFFICIAL_CARRIER_BUNDLE), `${label}: the dependency stays`);
      assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), false, `${label}: not selected`);
      assert.equal(rig.ctx.get(PI_AI_SERVICE), undefined, `${label}: no replacement mounted`);
    };

    // The manager says the selection failed though it took effect; the rollback finds it and undoes it: the original adapter is proven serving.
    {
      const calls = [];
      const rig = await managedRig({ providers: { 'sw-anthropic': route }, installed: false, target, wrap: spied(calls, { setBundleEnabled: async (name, enabled) => { const done = await rig.ctx.get('pluginManager').setBundleEnabled(name, enabled); return enabled ? { ...done, application: 'failed' } : done; } }) });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'apply-failed', installed: true } });
      assert.deepEqual(calls.map(call => call[0]), ['install', 'select', 'select']);
      assert.equal(calls.some(call => call[0] === 'remove'), false);
      await kept('apply failed', rig);
      assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
      await rig.ctx.fiber.dispose();
    }
    // The replacement mounts and registers no route (an empty dictionary): not a takeover, rolled back with the original proven.
    {
      const rig = await managedRig({ providers: {}, installed: false, target });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'not-confirmed', installed: true } });
      await kept('no route', rig);
      await rig.ctx.fiber.dispose();
    }
    // Neither adapter can use the dictionary: the replacement is withdrawn and the original is not proven restored, which the answer says in place of rolled back.
    {
      const rig = await managedRig({ providers: { 'sw-anthropic': { ...route, streamIdleTimeoutMs: 'not-a-number' } }, installed: false, target });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'withdrawn', reason: 'not-confirmed', cause: 'source-invalid', installed: true } });
      await kept('invalid dictionary', rig);
      await rig.ctx.fiber.dispose();
    }
    // A profile that applies changes only at startup: the package is installed and the selection the manager leaves for a restart is withdrawn, so no substitution waits for the next start.
    {
      const calls = [];
      const rig = await managedRig({ providers: { 'sw-anthropic': route }, installed: false, target, hmr: false, wrap: spied(calls) });
      assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'rolled-back', reason: 'restart-required', installed: true } });
      assert.deepEqual(calls.map(call => call[0]), ['install', 'select', 'select']);
      await kept('startup-only', rig);
      await rig.ctx.fiber.dispose();
    }
    await served.close();
  },

  // One change at a time over the install as well: a second confirmed request while the install runs is answered busy and reaches no manager, and the guard is released once the first has ended.
  async 'carrier-install-guard'() {
    const served = await endpoints();
    const official = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const calls = [];
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: official.spec, version: official.version }, wrap: spied(calls) });
    const outcomes = (await Promise.all([rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), rig.call('carrier-cache/set', { enabled: true, confirmInstall: true })])).map(reply => reply.value.outcome);
    assert.deepEqual([...outcomes].sort(), ['busy', 'enabled']);
    assert.deepEqual(calls.map(call => call[0]), ['install', 'select'], 'one request reached the manager');
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: false }), { ok: true, value: { outcome: 'disabled', native: 'restored' } }, 'the guard was released');
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // The install is the owner's alone: a guest peer or none, with the confirmation, reaches neither the install nor the selection; the owner's peer installs, and a request with no session cookie never reaches the handler.
  async 'carrier-install-auth'() {
    const served = await endpoints();
    const official = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const calls = [];
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: official.spec, version: official.version }, wrap: spied(calls) });
    const guest = rig.ctx.connection.createPeer({ principal: { kind: 'guest' } });
    const signal = new AbortController().signal;
    const before = rig.manifest();
    for (const [label, peer] of [['a guest peer', guest], ['no peer', undefined]]) {
      for (const payload of [{ enabled: true, confirmInstall: true }, { enabled: true }]) {
        const reply = await rig.handler('carrier-cache/set', payload, signal, peer);
        assert.deepEqual([reply.ok, reply.error.code], [false, 'forbidden'], label);
      }
    }
    assert.deepEqual(calls, [], 'the manager was not touched');
    assert.deepEqual(rig.manifest(), before);
    const response = await fetch(`http://127.0.0.1:${rig.ctx.webServer.port}/session-watcher/carrier-cache/set`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r-1', method: 'carrier-cache/set', payload: { enabled: true, confirmInstall: true } }),
    });
    assert.ok([401, 403].includes(response.status), `status ${response.status}`);
    assert.deepEqual(calls, []);
    assert.deepEqual(await rig.handler('carrier-cache/set', { enabled: true, confirmInstall: true }, signal, rig.ctx.connection.browserPeer), { ok: true, value: { outcome: 'enabled', installed: true } });
    assert.deepEqual(calls.map(call => call[0]), ['install', 'select']);
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // An external manager that installs the same package between the switch's read and its install: no deduplication against it is promised, and the profile stays coherent. The manager refuses the second install, the answer is a failure that names no manager code, nothing is selected, and the package the other manager installed is what the next request finds and reuses.
  async 'carrier-install-race'() {
    const served = await endpoints();
    const official = packOffline(BUNDLE_PACKAGE, join(process.env.TMPDIR, 'pack'));
    const calls = [];
    let other;
    const rig = await managedRig({
      providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: official.spec, version: official.version },
      wrap: spied(calls, { installBundle: async (spec, options) => { other = await rig.ctx.get('pluginManager').installBundle(spec, { enabled: false }); return rig.ctx.get('pluginManager').installBundle(spec, options); } }),
    });
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'install-failed' } });
    assert.equal(other.application, 'applied');
    assert.deepEqual(calls.map(call => call[0]), ['install'], 'the switch did not select what it did not install');
    assert.deepEqual(Object.keys(rig.manifest().dependencies), [OFFICIAL_CARRIER_BUNDLE], 'one package');
    assert.equal(rig.selected(OFFICIAL_CARRIER_BUNDLE), false);
    assert.deepEqual(await rig.call('carrier-cache/status', {}), { ok: true, value: { state: 'off' } });
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true }), { ok: true, value: { outcome: 'enabled' } });
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // The package the manager installed resolves the replacement row to the one Session Watcher the profile holds, and brings none of its own: the profile's runtime resolution names one package for the name, from the profile's own manifest, the bundle has no package under it, and the specifier the row names resolves from the bundle's directory, from the profile as the Loader's own resolver anchors it and from the profile's runtime table to the same file of the installed package.
  async 'carrier-install-resolution'() {
    const served = await endpoints();
    const root = process.env.TMPDIR;
    const software = packOffline(SW_PACKAGE, join(root, 'pack-sw'));
    const official = packOffline(BUNDLE_PACKAGE, join(root, 'pack'));
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: official.spec, version: official.version }, software: software.spec });
    assert.deepEqual(await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'enabled', installed: true } });

    const swDir = join(rig.profileDir, 'node_modules', '@nomadop', 'session-watcher-dsh');
    const bundleDir = join(rig.profileDir, 'node_modules', ...OFFICIAL_CARRIER_BUNDLE.split('/'));
    const entry = realpathSync(join(swDir, 'dist', 'pi-ai-index.js'));
    assert.equal(realpathSync(swDir) !== realpathSync(join(process.cwd(), 'dsh')), true, 'the profile holds a packed copy, not a link to this checkout');
    assert.equal(existsSync(join(bundleDir, 'node_modules')), false, 'no package of its own under the bundle');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))).filter(key => key.toLowerCase().includes('ependencies')), [], 'the bundle declares no dependency of any kind');

    // The profile's runtime table, as the Harness computes it for this profile: the package is one of the profile's own installed names, which Node resolves first, and the bundle adds no entry for it.
    const appBoot = await fromCheckout('packages/boot/app-boot/lib/index.js');
    const installAnchor = join(CHECKOUT, 'apps/cli/package.json');
    const profile = appBoot.loadProfileDirectory('sw-install-resolution', rig.profileDir, installAnchor, { userLayer: false });
    const resolution = await appBoot.createRuntimeResolution({ installAnchor, profile, home: DSH_HOME });
    assert.ok(resolution.localPackageNames.includes('@nomadop/session-watcher-dsh'));
    assert.deepEqual(resolution.entries.filter(each => each.name === '@nomadop/session-watcher-dsh'), [], 'no second entry for the name');

    // The specifier the replacement row names, resolved three ways.
    const specifier = REPLACEMENT_SPECIFIER;
    assert.equal(realpathSync(createRequire(join(bundleDir, 'package.json')).resolve(specifier)), entry, 'from the bundle');
    const resolver = join(rig.profileDir, '.cordis', 'resolve.mjs');
    mkdirSync(join(rig.profileDir, '.cordis'), { recursive: true });
    writeFileSync(resolver, 'export default (specifier) => import.meta.resolve(specifier)\n');
    const resolved = (await import(`${pathToFileURL(resolver).href}`)).default(specifier);
    assert.equal(realpathSync(fileURLToPath(resolved)), entry, 'from the profile, as the Loader resolves a bare specifier');
    const packages = new (await fromCheckout('vendor/cordis/lib/index.js')).Context();
    await packages.plugin(appBoot.PluginPackages, { resolution });
    for (const base of [pathToFileURL(join(bundleDir, 'package.json')), pathToFileURL(join(rig.profileDir, 'cordis.yml'))]) {
      assert.equal(realpathSync(packages.pluginPackages.packageOf(specifier, base.href).dir), realpathSync(swDir), `the table answers for ${base.pathname}`);
    }
    // The row's module is the installed copy's entry: it loads by that file, under the table, and is the pi-ai plugin.
    const loaded = await import(resolved);
    assert.equal(typeof loaded.apply, 'function');
    assert.deepEqual(loaded.inject, ['llm', 'loader']);
    await packages.fiber.dispose();
    await rig.ctx.fiber.dispose();
    await served.close();
  },

  // The rig cannot download: the registry spec of the official package, which is what a published install source would be and what is not published, fails without reaching anything, leaves the profile as it was and is answered as a failed install.
  async 'carrier-install-offline'() {
    const served = await endpoints();
    const calls = [];
    const rig = await managedRig({ providers: { 'sw-anthropic': anthropicRoute(served.origin) }, installed: false, target: { spec: `${OFFICIAL_CARRIER_BUNDLE}@0.10.2`, version: '0.10.2' }, wrap: spied(calls) });
    const before = readFileSync(join(rig.profileDir, 'package.json'), 'utf8');
    const reply = await rig.call('carrier-cache/set', { enabled: true, confirmInstall: true });
    assert.equal(reply.value.outcome, 'install-failed');
    assert.deepEqual(calls.map(call => call[0]), ['install']);
    assert.equal(readFileSync(join(rig.profileDir, 'package.json'), 'utf8'), before);
    assert.equal(existsSync(join(rig.profileDir, 'node_modules', ...OFFICIAL_CARRIER_BUNDLE.split('/'))), false);
    await rig.ctx.fiber.dispose();
    await served.close();
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
