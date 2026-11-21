// test/helpers/dsh-pi-ai-fixture.js — what a pi-ai scenario child (`dsh-pi-ai-child.js`) mounts and sends: the pi-ai adapter plugin on a real Cordis context under the profile's runtime resolution, loopback `node:http` endpoints that record each request body and answer it, and conversations built with the production carrier renderer.
// Credentials are fixture placeholders and every endpoint is a loopback port of this process, so no request leaves it.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { INNER_SEAL_KIND, renderCarrier } from '../../lib/inner-seal/carrier.js';
import { STATE_WORDING } from '../../lib/inner-seal/state-block.js';
import { carriedNote } from '../../lib/carried-evidence.js';
import { CARRIER_TABLE } from '../../lib/harness/dsh/carrier-table.js';
import { CHECKOUT, DSH_HOME, fromCheckout, IMPORTER, loaderWith, PROFILE_DIR, RecordCredentials } from './dsh-shipped-loop.js';

export { CARRIER_TABLE, STATE_WORDING, carriedNote };

/** The credential reference every fixture route names and the placeholder the credentials double answers it with. */
export const KEY_REF = 'SW_FIXTURE_PI_AI_KEY';
/** A reference whose placeholder has the shape pi-ai takes for an Anthropic OAuth bearer token. */
export const OAUTH_REF = 'SW_FIXTURE_PI_AI_OAUTH';
const PLACEHOLDERS = { [KEY_REF]: 'sw-fixture-placeholder-key', [OAUTH_REF]: 'sk-ant-oat-fixture-placeholder' };

// ── The loopback endpoints ──────────────────────────────────────────────────
const anthropicFrame = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const anthropicReply = text => [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
].map(anthropicFrame).join('');

const completionsReply = text => [
  { choices: [{ delta: { role: 'assistant', content: '' }, index: 0, finish_reason: null }] },
  { choices: [{ delta: { content: text }, index: 0, finish_reason: null }] },
  { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
].map(data => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n';

const responsesReply = (text) => {
  const usage = { input_tokens: 3, output_tokens: 1, total_tokens: 4, input_tokens_details: { cached_tokens: 0 } };
  return [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage } },
  ].map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
};

const REPLIES = { anthropic: anthropicReply, completions: completionsReply, responses: responsesReply };

/** The wire route a request path belongs to. */
const routeOf = (url) => {
  const { pathname } = new URL(url, 'http://fixture');
  if (pathname.includes('/converse-stream')) return 'bedrock';
  if (pathname.endsWith('/v1/messages')) return 'anthropic';
  if (pathname.endsWith('/chat/completions')) return 'completions';
  if (pathname.endsWith('/responses')) return 'responses';
  return 'unknown';
};

/**
 * The loopback endpoints of one scenario; with `delayMs` each answer waits that long, so requests sent together overlap. Each request's JSON body is recorded with its route, url and the headers the fixture checks; the Anthropic, Chat Completions and Responses routes answer `reply(route, body)` (a text, `hello` by default) as a minimal stream, and the Bedrock route refuses with an HTTP error, which still ends a request that has been recorded.
 * @returns {Promise<{ port: number, origin: string, requests: { route: string, url: string, headers: object, body: object }[], bodies: (route: string) => object[], close: () => Promise<void> }>}
 */
export async function endpoints({ reply = () => 'hello', delayMs = 0 } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (data) => { raw += data; });
    request.on('end', () => {
      const route = routeOf(request.url);
      const body = JSON.parse(raw);
      requests.push({ route, url: request.url, headers: request.headers, body });
      if (route === 'bedrock') {
        response.writeHead(400, { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' });
        response.end(JSON.stringify({ message: 'the fixture endpoint records the request and refuses it' }));
        return;
      }
      const make = REPLIES[route];
      if (make === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      const answer = () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(make(reply(route, body)));
      };
      if (delayMs > 0) setTimeout(answer, delayMs);
      else answer();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    bodies: route => requests.filter(each => each.route === route).map(each => each.body),
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

// ── The adapter plugin on a real context ────────────────────────────────────
/**
 * A real Cordis context under the profile's runtime resolution with the real llm service and a credentials double that answers `KEY_REF`, the pi-ai adapter plugin mounted on it: `entry: 'original'` is the checkout's `llm-pi-ai` under `config`, `'replacement'` the built opt-in entry of this package, which takes no configuration of its own and reads `config.providers` from the original row of the Loader service stand-in `loaderWith` it is given.
 * `loader` stands in for the Loader service instead when given.
 * `ctx.llm.stream` is the one entry the scenarios send through.
 */
export async function mountPiAi({ entry, config, loader = loaderWith(config.providers) }) {
  const [{ Context }, appBoot, llm] = await Promise.all([
    'vendor/cordis/lib/index.js',
    'packages/boot/app-boot/lib/index.js',
    'packages/llm/llm/lib/index.js',
  ].map(fromCheckout));
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = appBoot;
  const installAnchor = join(CHECKOUT, 'apps/cli/package.json');
  const profile = loadProfileDirectory('sw-shipped-fixture', PROFILE_DIR, installAnchor, { userLayer: false });
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: DSH_HOME });
  const ctx = new Context();
  await ctx.plugin(PluginPackages, { resolution });
  ctx.provide('credentials', new RecordCredentials(PLACEHOLDERS));
  await ctx.plugin(llm.default);
  const replacement = entry === 'replacement';
  const module = replacement
    ? await (await import(pathToFileURL(IMPORTER).href)).loadPiAiEntry()
    : await fromCheckout('packages/llm/llm-pi-ai/lib/index.js');
  if (replacement) ctx.provide('loader', loader);
  await ctx.plugin(module, replacement ? undefined : config);
  return { ctx, llm, module };
}

/** One request through `ctx.llm.stream`, drained: the finish chunk's reason kind. */
export async function send(ctx, options) {
  let finish;
  for await (const chunk of ctx.llm.stream(options)) if (chunk.type === 'finish') finish = chunk.reason;
  return finish;
}

// ── Conversations ───────────────────────────────────────────────────────────
const user = (llm, text) => llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });

/** An assistant turn of `route`, which the adapter replays as provider-neutral text. */
const assistant = (llm, text, route) => llm.createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: route.provider, model: route.model } });

/**
 * The carrier message a seal appends, from the production renderer: `slots` summary lines, an evidence block (B) of one kept file, and a state block.
 * `tag` distinguishes the text of two carriers.
 */
export function carrierOf(llm, tag, { evidence = true, state = true } = {}) {
  const source = {
    kind: INNER_SEAL_KIND, v: 1,
    slots: [{ seqs: [1, 2], text: `${tag}: the first step read a file` }, { seqs: [3], text: `${tag}: the second step edited it` }],
    paths: evidence ? [{ displayPath: `/work/${tag}.txt`, totalLines: 2, state: 'readable', write: [[1, `${tag} line one`], [2, `${tag} line two`]] }] : [],
    ...(state ? { state: { asOfSeq: 9, items: { todos: { value: [{ content: `${tag} item`, status: 'pending' }] } } } } : {}),
  };
  return llm.createUserMessage({ content: renderCarrier(source, CARRIER_TABLE), source });
}

/**
 * The conversation `H C1 C2 C3 A`: the opening request, three carriers each followed by a main step of its own, and `tail` unsealed turns after them.
 * With `carriers` fewer or zero the same shape holds with fewer carriers.
 */
export function conversationOf(llm, route, { carriers = 3, tail = 2 } = {}) {
  const messages = [user(llm, 'the opening request')];
  for (let index = 1; index <= carriers; index += 1) {
    messages.push(carrierOf(llm, `C${index}`), assistant(llm, `step after C${index}`, route), user(llm, `follow-up after C${index}`));
  }
  for (let index = 1; index <= tail; index += 1) messages.push(assistant(llm, `unsealed step ${index}`, route), user(llm, `unsealed ask ${index}`));
  return messages;
}

/** The text of a recorded body's message content, whichever shape it has: a string, or the text of its blocks in order. */
export const joinedText = content => (typeof content === 'string' ? content
  : content.map(block => block.text ?? '').join(''));

// ── Offline package installation ────────────────────────────────────────────
/**
 * The invocation the plugin manager runs pnpm with in an isolated profile so that nothing can leave the machine: pnpm offline, its store and cache inside `home`, a registry that nothing listens on and proxies that refuse every connection, so a spec that is not a local file or directory fails instead of downloading.
 * It adds nothing to the manager's own arguments and never approves a build script.
 */
export const offlinePnpm = (home) => {
  const dead = 'http://127.0.0.1:9';
  // pnpm 11 reads its settings from `pnpm_config_*` variables; the `npm_config_*` spellings stay for the registry and for any other reader of them.
  return {
    command: 'pnpm', args: [],
    env: {
      pnpm_config_offline: 'true', pnpm_config_registry: `${dead}/`, npm_config_registry: `${dead}/`, pnpm_config_store_dir: join(home, 'pnpm-store'), pnpm_config_cache_dir: join(home, 'pnpm-cache'),
      HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead, all_proxy: dead, NO_PROXY: '', no_proxy: '',
    },
  };
};

/** `pnpm add spec` in the profile at `dir`, offline: the install of a package the profile holds before the plugin manager is involved. */
export function addOffline(dir, home, spec) {
  const { env } = offlinePnpm(home);
  const { status, stdout, stderr } = spawnSync('pnpm', ['add', spec], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  if (status !== 0) throw new Error(`pnpm add ${spec} exited ${status}: ${stdout}${stderr}`);
}

/** Whether pnpm can run here at all; the cases that install a package skip without it. */
export const pnpmSkip = () => (spawnSync('pnpm', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).status === 0 ? false : 'pnpm is not on the PATH');

const REPO = fileURLToPath(new URL('../..', import.meta.url));
/** The directory of the official companion bundle package and of the Session Watcher package, as the repository holds them. */
export const BUNDLE_PACKAGE = join(REPO, 'dsh', 'carrier-cache');
export const SW_PACKAGE = join(REPO, 'dsh');

/**
 * `pnpm pack` of the package at `directory` into `destination`, offline: the tarball a publication would carry, and its manifest's name and version.
 * @returns {{ spec: string, name: string, version: string }} `spec` the absolute path of the tarball, the shape of install target the tests inject.
 */
export function packOffline(directory, destination) {
  mkdirSync(destination, { recursive: true });
  const { status, stderr, stdout } = spawnSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: directory, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: destination, pnpm_config_offline: 'true', pnpm_config_store_dir: join(destination, '.store') },
  });
  if (status !== 0) throw new Error(`pnpm pack ${directory} exited ${status}: ${stderr}`);
  const { name, version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const file = stdout.split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).at(-1);
  return { spec: file, name, version };
}

/**
 * A bundle package of its own under `directory`, a patch of one disabled row and the `scripts` it is given, packed offline: what an install target that is not the official bundle is made of.
 * @returns {{ spec: string, name: string, version: string }}
 */
export function packBundleFixture(directory, { name, version = '1.0.0', scripts }) {
  const source = join(directory, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version, files: ['cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, ...scripts === undefined ? {} : { scripts } }));
  writeFileSync(join(source, 'cordis.patch.yml'), '- id: llm-pi-ai\n  name: \'@deepseek-ai/dsh-llm-pi-ai\'\n  disabled: true\n');
  return packOffline(source, join(directory, 'tarball'));
}

// ── A profile composition on the real Loader ────────────────────────────────
/** The Loader entry id the activation composition gives the replacement entry, and the specifier it names it by. */
export const REPLACEMENT_ID = 'llm-pi-ai-carrier-cache';
export const REPLACEMENT_SPECIFIER = '@nomadop/session-watcher-dsh/pi-ai';

const yamlOf = value => JSON.stringify(value);

/**
 * The activation composition of `dsh/README.md` as two patch layers: the bundle's, the original `llm-pi-ai` row off and the replacement entry inserted under its own id with no configuration, and the profile's own, the profile dictionary `providers` on the original row, where the host's configuration has always lived.
 * `keepOriginalOn` leaves the original row on beside the replacement, which the composition must never do.
 * Answers `{ bundleLayer, layer }`, the arguments of `mountComposition`.
 */
export function activation({ providers, keepOriginalOn = false }) {
  return {
    bundleLayer: [
      ...(keepOriginalOn ? [] : ['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  disabled: true']),
      '- insert:',
      `    - id: ${REPLACEMENT_ID}`,
      `      name: '${REPLACEMENT_SPECIFIER}'`,
      '',
    ].join('\n'),
    layer: providers === undefined ? '[]\n' : ['- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", `  config: ${yamlOf({ providers })}`, ''].join('\n'),
  };
}

/**
 * The real Loader mounting a profile whose base bundle holds the llm service and the original dormant `llm-pi-ai` row, whose second bundle's patch layer is `bundleLayer`, and whose own patch layer is `layer`, with the real Settings service, the config editor, the timer and HMR reloading the Loader when that layer's file changes.
 * `modules` names every module a row may import: the fixture's llm service, the checkout's `llm-pi-ai` and the built replacement entry, which the profile's runtime resolution loaded by its specifier.
 * `installed` are bundles `{ name, patch }` the profile depends on and holds on disk without selecting them, except the names `selected` lists, which the profile started with; with `manager` the real plugin manager mounts over the profile, which `ctx.pluginManager` then is, and with `hmr: false` the profile is startup-only; with `connection` the real WebServer and Connection mount on a loopback port; `packageManager(home)` answers the package manager invocation the manager runs pnpm with, `offlinePnpm(home)` for a profile that must install without a network, and `prepare({ dir, home })` runs once the profile's files are on disk and before its composition mounts, for a package the profile must already hold.
 * Answers the context, the llm package, the layer's file, the profile directory and `rewrite(text)`, which replaces the layer's text, the Loader reloading from it.
 */
export async function mountComposition({ bundleLayer = '[]\n', layer, installed = [], selected = [], manager = false, hmr: withHmr = true, connection = false, packageManager, prepare }) {
  const [{ Context }, loaderModule, includeModule, appBoot, llm, settingsModule, configEditor, timer, hmr, fsPromises, osModule, managerModule] = await Promise.all([
    fromCheckout('vendor/cordis/lib/index.js'), fromCheckout('vendor/loader/lib/index.js'), fromCheckout('vendor/include/lib/index.js'),
    fromCheckout('packages/boot/app-boot/lib/index.js'), fromCheckout('packages/llm/llm/lib/index.js'),
    fromCheckout('packages/settings/settings/lib/index.js'), fromCheckout('packages/boot/config-editor/lib/index.js'),
    fromCheckout('vendor/timer/lib/index.js'), fromCheckout('packages/boot/hmr/lib/index.js'), import('node:fs/promises'), import('node:os'),
    manager ? fromCheckout('packages/boot/plugin-manager/lib/index.js') : undefined,
  ]);
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages, initProfile, mountRootInclude, readProfilePatches } = appBoot;
  const installAnchor = join(CHECKOUT, 'apps/cli/package.json');
  const resolutionProfile = loadProfileDirectory('sw-shipped-fixture', PROFILE_DIR, installAnchor, { userLayer: false });
  const resolution = await createRuntimeResolution({ installAnchor, profile: resolutionProfile, home: DSH_HOME });
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(`${process.env.TMPDIR}/`).href;
  await ctx.plugin(PluginPackages, { resolution });
  ctx.provide('credentials', new RecordCredentials(PLACEHOLDERS));

  const modules = new Map([
    ['test-llm-service', llm.default],
    ['@deepseek-ai/dsh-llm-pi-ai', await fromCheckout('packages/llm/llm-pi-ai/lib/index.js')],
    [REPLACEMENT_SPECIFIER, await (await import(pathToFileURL(IMPORTER).href)).loadPiAiEntry()],
  ]);
  await ctx.plugin(loaderModule.default);
  ctx.loader.builtins.include = includeModule.default;
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    import: (specifier) => {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`);
      return Promise.resolve(modules.get(specifier));
    },
    register() { throw new Error('unexpected module hook registration'); },
    getOrCreateModuleJob() { throw new Error('unexpected module job creation'); },
    resolveSync() { throw new Error('unexpected synchronous module resolution'); },
    load() { throw new Error('unexpected module load'); },
  };

  const home = await fsPromises.mkdtemp(join(osModule.tmpdir(), 'sw-pi-ai-composition-'));
  const dir = join(home, 'profile');
  initProfile(dir, ['sw-fixture-base-bundle', 'sw-fixture-activation-bundle', ...selected]);
  const bundle = join(dir, 'node_modules', 'sw-fixture-base-bundle');
  await fsPromises.mkdir(bundle, { recursive: true });
  await fsPromises.writeFile(join(home, 'package.json'), '{"name":"sw-fixture-installation"}\n');
  await fsPromises.writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'sw-fixture-base-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
  // The base layer, as the shipped base bundle holds them: the llm service and the original adapter's dormant row.
  await fsPromises.writeFile(join(bundle, 'cordis.patch.yml'), ['- insert:', '    - id: llm', "      name: 'test-llm-service'", '    - id: llm-pi-ai', "      name: '@deepseek-ai/dsh-llm-pi-ai'", ''].join('\n'));
  const activationBundle = join(dir, 'node_modules', 'sw-fixture-activation-bundle');
  await fsPromises.mkdir(activationBundle, { recursive: true });
  await fsPromises.writeFile(join(activationBundle, 'package.json'), JSON.stringify({ name: 'sw-fixture-activation-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
  await fsPromises.writeFile(join(activationBundle, 'cordis.patch.yml'), bundleLayer);
  // The bundles `installed` are profile dependencies whose files are on disk and which no `dsh.profile.bundles` entry selects: what a preinstalled bundle is until the manager selects it. Each is a `link:` dependency, as a local bundle is in a real profile, so pnpm can run in the profile without a registry.
  const dependencies = {};
  for (const { name, patch } of installed) {
    const source = join(home, 'packages', ...name.split('/'));
    await fsPromises.mkdir(source, { recursive: true });
    await fsPromises.writeFile(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    await fsPromises.writeFile(join(source, 'cordis.patch.yml'), patch);
    const installedDir = join(dir, 'node_modules', ...name.split('/'));
    await fsPromises.mkdir(dirname(installedDir), { recursive: true });
    await fsPromises.symlink(source, installedDir, 'dir');
    dependencies[name] = `link:${source}`;
  }
  if (installed.length > 0) {
    const manifest = JSON.parse(await fsPromises.readFile(join(dir, 'package.json'), 'utf8'));
    await fsPromises.writeFile(join(dir, 'package.json'), `${JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, ...dependencies } }, undefined, 2)}\n`);
  }
  await fsPromises.writeFile(join(dir, 'cordis.yml'), '[]\n');
  const patchPath = join(dir, 'cordis.patch.yml');
  await fsPromises.writeFile(patchPath, layer);
  await prepare?.({ dir, home });
  const profile = {
    name: 'test', startedBundles: ['sw-fixture-base-bundle', 'sw-fixture-activation-bundle', ...selected], dir, patchPath, installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    ...packageManager === undefined ? {} : { packageManager: packageManager(home) },
  };
  ctx.provide('profileContext', profile);
  ctx.provide('appReady', { onReady: (listener) => { listener(); return () => {}; } });
  await ctx.plugin(configEditor.default);
  await ctx.plugin(settingsModule.default);
  await mountRootInclude(ctx, join(dir, 'cordis.yml'), readProfilePatches('test', profile));
  await ctx.loader.await();
  await ctx.plugin(timer.default);
  // Without HMR the profile is a startup-only one: the manager saves a change and reports that it waits for a restart.
  if (withHmr) {
    await ctx.plugin(hmr.default, { root: [], ignored: [], debounce: 0 });
    await ctx.hmr.runExclusive(async () => {});
  }
  // The real plugin manager over the profile above, as the base bundle mounts it; the isolated profile is the only one it can write.
  if (manager) await ctx.plugin(managerModule.default, {});
  // The real WebServer and Connection on a loopback port, whose `/session-watcher` channel a scenario registers its handler on.
  if (connection) {
    const [{ WebServer }, connectionPlugin] = await Promise.all(['packages/host/webserver/lib/index.js', 'packages/client/connection/lib/index.js'].map(fromCheckout));
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
    await ctx.plugin(connectionPlugin);
  }
  return {
    ctx, llm, patchPath, profileDir: dir, home,
    async rewrite(text) {
      await fsPromises.writeFile(patchPath, text);
    },
  };
}

/** Polls `check` until it answers truthy or `ms` pass; answers its last value. */
export async function waitFor(check, ms = 5_000) {
  const until = Date.now() + ms;
  let value = await check();
  while (!value && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await check();
  }
  return value;
}
