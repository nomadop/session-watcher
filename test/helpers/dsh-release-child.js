// test/helpers/dsh-release-child.js — one scenario of the release path of the carrier cache bundle, run in a fresh Node process by `test/dsh.carrier-cache-release.test.js` (`runReleaseScenario`): the packages as a registry serves them, the host's own RPC and the plugin manager's own update methods, on a profile booted the way the Harness boots one.
// The registry is a loopback server that serves packed tarballs and nothing more (`dsh-release-registry.js`); pnpm, the plugin manager, the Loader, HMR and the Connection are the checkout's, and every profile is the scenario's own, holding no package of this repository but what the registry installed. Credentials are fixture placeholders and every endpoint is a loopback port of this process.
// A scenario that fails an assertion exits non-zero with it on stderr.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { OFFICIAL_CARRIER_BUNDLE } from '../../dsh/src/carrier-cache-switch.js';
import { PI_AI_SERVICE, CARRIER_EVIDENCE_SERVICE, CARRIER_PREFIX_SERVICE } from '../../dsh/src/pi-ai-integration.js';
import { channelOn, mountHostServices } from './dsh-shipped-loop.js';
import {
  activation, CARRIER_TABLE, carrierPrefixOf, COMPANION_SPECIFIER, conversationOf, endpoints, joinedText, KEY_REF, mountComposition, REPLACEMENT_ID, REPLACEMENT_SPECIFIER, send, waitFor,
} from './dsh-pi-ai-fixture.js';
import { manifestOf, RELEASED_COMPANION, RELEASED_SW, registryPnpm, releasedTarball, startRegistry, workingTreeTarball } from './dsh-release-registry.js';

const [scenario] = process.argv.slice(2);

const SW = '@nomadop/session-watcher-dsh';
const COMPANION = OFFICIAL_CARRIER_BUNDLE;
/** The version the candidate Session Watcher package is staged under: newer than the release the migration starts from, and no release's identity. */
const SW_TEST_VERSION = '0.11.2-carrier-upgrade-test.0';
/** Cordis's `FiberState.ACTIVE`. */
const FIBER_ACTIVE = 2;
/** A request of the endpoint the release after the previous one added, for a session that exists nowhere: what it is answered with tells whether the host that is running has it. */
const SETTLEMENT_TARGET = { sessionId: 'none', segment: 0, through: 0, seq: 0 };

const ANTHROPIC = { provider: 'sw-anthropic', model: 'fixture-claude' };
const route = origin => ({
  api: 'anthropic-messages', baseURL: origin, apiKeyEnv: KEY_REF, models: [{ id: 'fixture-claude', contextWindow: 200_000, maxTokens: 4_096, input: ['text'], reasoningEfforts: false }],
});

/** `a` is a newer plain release than `b`. */
const newer = (a, b) => {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  const at = x.findIndex((part, index) => part !== y[index]);
  return at !== -1 && x[at] > y[at];
};

/** The promise's value, or a failure naming `what` when it has not settled within `ms`. */
async function bounded(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

// ── The packages ────────────────────────────────────────────────────────────
// The tarballs this working tree packs: the companion as its manifest stands and the Session Watcher package staged under `SW_TEST_VERSION`, so the workspace manifest keeps the version of the main release.
async function candidates(root) {
  const companion = await workingTreeTarball('dsh/carrier-cache', root);
  const host = await workingTreeTarball('dsh', root, { version: SW_TEST_VERSION });
  return { companion: { file: companion, version: manifestOf(companion).version }, host: { file: host, version: SW_TEST_VERSION } };
}

// The tarballs the previous releases carried, repacked from the commits that released them.
async function released(root) {
  const companion = await releasedTarball(RELEASED_COMPANION, 'dsh/carrier-cache', root);
  const host = await releasedTarball(RELEASED_SW, 'dsh', root);
  return { companion: { file: companion, version: manifestOf(companion).version }, host: { file: host, version: manifestOf(host).version } };
}

// A companion that moves the adapter into its own package is a new version of it: an installed copy updates only to a newer one.
function assertBumped(candidate, previous) {
  assert.ok(newer(candidate.version, previous.version), `the companion of this working tree is ${candidate.version}, not newer than the released ${previous.version}: an installed companion has nothing to update to`);
}

// ── The profile ─────────────────────────────────────────────────────────────
// A fresh profile on the real Loader, plugin manager and HMR whose package manager is the real pnpm against `registry` alone, over the host's real services; its original `llm-pi-ai` row carries the dictionary of one Anthropic route at `served`. `prepare` and `selected` give a profile its packages before it boots.
async function profileOver(registry, served, options = {}) {
  const rig = await mountComposition({
    layer: activation({ providers: { 'sw-anthropic': route(served.origin) } }).layer, services: mountHostServices, linkSoftware: false, manager: true,
    managerConfig: { registry: registry.url, fallbackRegistries: [] }, packageManager: home => registryPnpm(home, registry.url), carrierPrefix: null, ...options,
  });
  return { ...rig, manager: rig.ctx.get('pluginManager'), served };
}

const rowOf = (ctx, id) => { try { return ctx.loader.resolve(`include:${id}`); } catch { return undefined; } };
const activeRow = (ctx, id) => rowOf(ctx, id)?.fiber?.state === FIBER_ACTIVE;
const manifestOfProfile = rig => JSON.parse(readFileSync(join(rig.profileDir, 'package.json'), 'utf8'));
const packageDir = (rig, name) => join(rig.profileDir, 'node_modules', ...name.split('/'));
const bundlesOf = rig => manifestOfProfile(rig).dsh.profile.bundles;

// One request of the conversation `H C1 C2 C3 A` shape with two carriers in the current format, through the llm service to the route's loopback endpoint: the body the endpoint recorded, after a stop.
async function conversation(rig) {
  const before = rig.served.requests.length;
  const finish = await send(rig.ctx, { ...ANTHROPIC, messages: conversationOf(rig.llm, ANTHROPIC, { carriers: 2, tail: 2 }) });
  assert.equal(finish?.kind, 'stop', JSON.stringify(finish));
  assert.equal(rig.served.requests.length, before + 1, 'one request reached the endpoint');
  return rig.served.requests.at(-1).body;
}

// The warnings the profile's logger holds.
const warningsOf = rig => rig.ctx.logger.buffer.filter(each => each.type === 'warn').length;

// Whether each carrier of the body ends in the cache marker, in order: the native serializer writes a carrier as one string and the carrier cache point as blocks whose last one carries the marker.
const carrierPoints = body => body.messages
  .filter(message => message.role === 'user' && joinedText(message.content).startsWith(carrierPrefixOf(CARRIER_TABLE)))
  .map(message => Array.isArray(message.content) && message.content.at(-1).cache_control?.type === 'ephemeral');

// A profile package added by the real pnpm from `registry` before the profile boots.
function addFromRegistry(registry, spec) {
  return ({ dir, home }) => new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['add', '--save-exact', spec], { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...registryPnpm(home, registry.url).env } });
    let log = '';
    child.stdout.on('data', (data) => { log += data; });
    child.stderr.on('data', (data) => { log += data; });
    child.on('close', status => (status === 0 ? resolve() : reject(new Error(`pnpm add ${spec} exited ${status}\n${log}`))));
  });
}

// The replacement row of the profile as the running Loader holds it, and the package that owns its module.
function replacementOf(rig) {
  const row = rowOf(rig.ctx, REPLACEMENT_ID);
  assert.ok(row, 'the Loader holds the replacement row');
  return { row, owner: rig.ctx.pluginPackages.packageOf(row.options.name, rig.ctx.baseUrl) };
}

// What the profile shows while the companion serves: the original row off and unmounted with its dictionary where it was, the replacement mounted from `specifier` under no configuration of its own and owned by the package at `ownerDir`, serving the route.
function assertServing(rig, { specifier, ownerDir, ownerVersion, ownerName }) {
  const original = rowOf(rig.ctx, 'llm-pi-ai');
  assert.equal(original.disabled, true, 'the original row stays disabled');
  assert.notEqual(original.fiber?.state, FIBER_ACTIVE, 'and unmounted');
  assert.deepEqual(Object.keys(original.options.config.providers), ['sw-anthropic'], 'with its provider configuration');
  const { row, owner } = replacementOf(rig);
  assert.deepEqual([row.options.name, row.disabled, row.fiber?.state, row.options.config], [specifier, false, FIBER_ACTIVE, undefined]);
  assert.deepEqual([owner.name, owner.version], [ownerName, ownerVersion]);
  assert.equal(realpathSync(owner.dir), realpathSync(ownerDir), 'the module is the owner package\'s');
  assert.equal(rig.ctx.get(PI_AI_SERVICE)?.failure, null);
  assert.deepEqual(rig.ctx.get(PI_AI_SERVICE).routes(), ['sw-anthropic']);
}

const hostActive = rig => waitFor(() => activeRow(rig.ctx, 'session-watcher'), 30_000);

const SCENARIOS = {
  // A profile that has the candidate host and no companion: the Settings page offers the companion at exactly the version this working tree packs, installs nothing before the owner confirms, and the owner's confirmation installs that version from the registry, selects it and serves the route through the adapter the companion carries.
  async 'fresh-settings'() {
    const root = process.env.TMPDIR;
    const registry = await startRegistry();
    const served = await endpoints();
    const previous = await released(root);
    const next = await candidates(root);
    assertBumped(next.companion, previous.companion);
    for (const each of [previous.companion, next.companion, next.host]) registry.publish(each.file);
    const rig = await profileOver(registry, served);
    const { ctx, manager } = rig;
    const plan = await manager.registries();
    assert.deepEqual([plan.registry, plan.fallbackRegistries, plan.resolved], [registry.url, [], registry.url], 'the registry is the only one asked');

    assert.deepEqual(carrierPoints(await conversation(rig)), [false, false], 'the native adapter serves the route first');
    assert.equal((await manager.installBundle(`${SW}@${next.host.version}`, { saveExact: true, enabled: true })).application, 'applied');
    assert.ok(await hostActive(rig), 'the host is mounted');

    const channel = channelOn(ctx);
    assert.deepEqual(await channel.call('carrier-cache/status', {}), { ok: true, value: { state: 'not-installed', install: { name: COMPANION, version: next.companion.version } } }, 'the host offers the companion at the packed version');
    for (const body of [{ enabled: true }, { enabled: true, confirmInstall: false }]) {
      assert.deepEqual(await channel.call('carrier-cache/set', body), { ok: true, value: { outcome: 'install-confirmation-required' } });
    }
    assert.equal(registry.tarballRequests(COMPANION, next.companion.version), 0, 'nothing is fetched before the confirmation');
    assert.equal(existsSync(packageDir(rig, COMPANION)), false);
    assert.equal(Object.hasOwn(manifestOfProfile(rig).dependencies, COMPANION), false);

    assert.deepEqual(await channel.call('carrier-cache/set', { enabled: true, confirmInstall: true }), { ok: true, value: { outcome: 'enabled', installed: true } });
    assert.equal(manifestOfProfile(rig).dependencies[COMPANION], next.companion.version, 'the registry identity at its exact version');
    assert.ok(bundlesOf(rig).includes(COMPANION), 'selected');
    assert.equal(registry.tarballRequests(COMPANION, previous.companion.version), 0, 'the released companion is not the one fetched');
    const [bundle] = (await manager.listBundles()).filter(each => each.name === COMPANION);
    assert.deepEqual([bundle.installed, bundle.enabled, bundle.version, bundle.availability, bundle.error], [true, true, next.companion.version, 'profile', undefined]);
    assert.deepEqual(bundle.rows.map(({ rowId, moduleName }) => ({ rowId, moduleName })), [{ rowId: REPLACEMENT_ID, moduleName: COMPANION_SPECIFIER }]);
    assert.deepEqual(bundle.overrides, ['llm-pi-ai']);

    assertServing(rig, { specifier: COMPANION_SPECIFIER, ownerDir: packageDir(rig, COMPANION), ownerName: COMPANION, ownerVersion: next.companion.version });
    assert.deepEqual(await channel.call('carrier-cache/status', {}), { ok: true, value: { state: 'on' } });
    assert.deepEqual(carrierPoints(await conversation(rig)), [false, true], 'the last carrier ends in the marker');
    assert.equal(rig.ctx.get(CARRIER_EVIDENCE_SERVICE) !== undefined, true, 'the host records the request\'s evidence');
    await ctx.fiber.dispose();
    await served.close();
    await registry.close();
  },

  // A profile that holds the companion and no Session Watcher package, in a process that has loaded nothing of either: the row's module resolves from the companion package under the profile's runtime resolution with the real host peers, and the route is served.
  async 'cold-start'() {
    const root = process.env.TMPDIR;
    const registry = await startRegistry();
    const served = await endpoints();
    const next = await candidates(root);
    registry.publish(next.companion.file);
    const rig = await profileOver(registry, served, { selected: [COMPANION], prepare: addFromRegistry(registry, `${COMPANION}@${next.companion.version}`) });
    const modules = join(rig.profileDir, 'node_modules');
    assert.deepEqual(readdirSync(join(modules, '@nomadop')), ['session-watcher-dsh-carrier-cache'], 'no Session Watcher package is in the profile');
    assert.equal(existsSync(join(modules, '@deepseek-ai')), false, 'and no copy of a host package');
    assert.equal(rowOf(rig.ctx, 'session-watcher'), undefined, 'the profile mounts no host');

    assertServing(rig, { specifier: COMPANION_SPECIFIER, ownerDir: packageDir(rig, COMPANION), ownerName: COMPANION, ownerVersion: next.companion.version });
    // With no host to answer what a carrier opens with the route is served and no carrier is given a point, with no warning; a host that answers at the next request is followed.
    const before = warningsOf(rig);
    assert.deepEqual(carrierPoints(await conversation(rig)), [false, false]);
    assert.equal(warningsOf(rig), before, 'no warning for a request the host has no prefix for');
    rig.ctx.provide(CARRIER_PREFIX_SERVICE, { carrierPrefix: () => carrierPrefixOf(CARRIER_TABLE) });
    assert.deepEqual(carrierPoints(await conversation(rig)), [false, true]);
    await rig.ctx.fiber.dispose();
    await served.close();
    await registry.close();
  },

  // A profile started from the previous releases, the Session Watcher package and the companion it selected, updated through the methods the Plugins page calls: the companion first, after which the old host still has its route, then the Session Watcher package, whose new tarball is held back to look at the profile in between.
  async 'migration'() {
    const root = process.env.TMPDIR;
    const registry = await startRegistry();
    const served = await endpoints();
    const previous = await released(root);
    const next = await candidates(root);
    assertBumped(next.companion, previous.companion);
    for (const each of [previous.host, previous.companion, next.companion, next.host]) registry.publish(each.file);
    const rig = await profileOver(registry, served);
    const { ctx, manager } = rig;
    const nativeRequest = await conversation(rig);
    assert.deepEqual(carrierPoints(nativeRequest), [false, false]);

    // The old distributed state: the previous Session Watcher release and the previous companion, selected.
    for (const [name, each] of [[SW, previous.host], [COMPANION, previous.companion]]) {
      assert.equal((await manager.installBundle(`${name}@${each.version}`, { saveExact: true, enabled: true })).application, 'applied', name);
    }
    assert.ok(await hostActive(rig), 'the previous host is mounted');
    assert.ok(await waitFor(() => activeRow(ctx, REPLACEMENT_ID), 30_000), 'and the previous companion\'s row');
    assertServing(rig, { specifier: REPLACEMENT_SPECIFIER, ownerDir: packageDir(rig, SW), ownerName: SW, ownerVersion: previous.host.version });
    await conversation(rig);

    // The companion first.
    const offered = await manager.listVersions(COMPANION);
    assert.equal(offered.status, 'listed');
    assert.equal(offered.installed, previous.companion.version);
    assert.deepEqual(offered.versions.map(each => [each.version, each.bundle, each.incompatible]), [[next.companion.version, true, undefined]], 'the companion is offered at the packed version');
    const first = await manager.updateBundle(COMPANION, next.companion.version);
    assert.deepEqual([first.from, first.to, first.step, first.result.application, first.restore], [previous.companion.version, next.companion.version, 'install', 'applied', undefined]);
    assert.ok(bundlesOf(rig).includes(COMPANION), 'the companion is still selected');
    assert.ok(await waitFor(() => activeRow(ctx, REPLACEMENT_ID) && ctx.get(PI_AI_SERVICE)?.failure === null, 30_000));
    // The old host, now beside the companion that carries the adapter, still gets its route.
    const oldChannel = channelOn(ctx);
    assert.deepEqual(await oldChannel.call('carrier-cache/status', {}), { ok: true, value: { state: 'on' } });
    const unknown = await oldChannel.call('inner-monitor/settlement/target', SETTLEMENT_TARGET);
    assert.equal(unknown.error?.code, 'unknown_endpoint', 'the previous release has no endpoint of the settlement target');
    await conversation(rig);
    assertServing(rig, { specifier: COMPANION_SPECIFIER, ownerDir: packageDir(rig, COMPANION), ownerName: COMPANION, ownerVersion: next.companion.version });

    // The Session Watcher package second, its new tarball held back.
    const hostOffered = await manager.listVersions(SW);
    assert.equal(hostOffered.status, 'listed');
    assert.equal(hostOffered.installed, previous.host.version);
    assert.deepEqual(hostOffered.versions.map(each => [each.version, each.bundle, each.incompatible]), [[SW_TEST_VERSION, true, undefined]]);
    assert.equal(registry.tarballRequests(SW, SW_TEST_VERSION), 0, 'the new tarball has not been fetched yet');
    const held = registry.hold(SW, SW_TEST_VERSION);
    let second;
    try {
      second = manager.updateBundle(SW, SW_TEST_VERSION).catch(error => error);
      await bounded(Promise.race([held.reached, second.then((ended) => { throw new Error(`the update ended before it asked for the new tarball: ${JSON.stringify(ended)}`); })]), 60_000, 'the request for the new Session Watcher tarball');
      // The old package is removed and the new one is not yet there.
      assert.equal(existsSync(packageDir(rig, SW)), false, 'no Session Watcher package on disk');
      assert.equal(Object.hasOwn(manifestOfProfile(rig).dependencies, SW), false);
      assert.equal(bundlesOf(rig).includes(SW), false);
      assert.equal(rowOf(ctx, 'session-watcher'), undefined, 'its host row is gone');
      assert.equal(ctx.get(CARRIER_EVIDENCE_SERVICE), undefined, 'and with it the host\'s own service');
      // The companion carries the route alone.
      assert.ok(bundlesOf(rig).includes(COMPANION), 'the companion is still selected');
      assertServing(rig, { specifier: COMPANION_SPECIFIER, ownerDir: packageDir(rig, COMPANION), ownerName: COMPANION, ownerVersion: next.companion.version });
      const before = warningsOf(rig);
      assert.deepEqual(carrierPoints(await conversation(rig)), [false, false], 'the same route completes through the companion, which has no host to tell a carrier by');
      assert.equal(warningsOf(rig), before, 'and says nothing of it');
    } finally {
      held.release();
    }
    const done = await second;
    assert.deepEqual([done.from, done.to, done.step, done.result.application, done.restore], [previous.host.version, SW_TEST_VERSION, 'install', 'applied', undefined]);

    // Both updated: the new host mounted over the companion that is already selected.
    assert.ok(await hostActive(rig), 'the updated host is mounted');
    assert.ok(bundlesOf(rig).includes(SW) && bundlesOf(rig).includes(COMPANION));
    const host = ctx.pluginPackages.packageOf(SW, ctx.baseUrl);
    assert.deepEqual([host.version, realpathSync(host.dir)], [SW_TEST_VERSION, realpathSync(packageDir(rig, SW))]);
    assertServing(rig, { specifier: COMPANION_SPECIFIER, ownerDir: packageDir(rig, COMPANION), ownerName: COMPANION, ownerVersion: next.companion.version });
    const channel = channelOn(ctx);
    assert.deepEqual(await channel.call('carrier-cache/status', {}), { ok: true, value: { state: 'on' } });
    // The running host is the new release's code: it answers an endpoint the previous release does not have.
    const target = await channel.call('inner-monitor/settlement/target', SETTLEMENT_TARGET);
    assert.notEqual(target.error?.code, 'unknown_endpoint');
    assert.deepEqual(carrierPoints(await conversation(rig)), [false, true], 'a carrier of the current format ends in the marker');
    await ctx.fiber.dispose();
    await served.close();
    await registry.close();
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
