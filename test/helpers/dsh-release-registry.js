// test/helpers/dsh-release-registry.js — what the release-path scenarios (`dsh-release-child.js`) publish and install through: a loopback npm registry that carries packed tarballs and nothing else, the packages it is given (the released predecessors of this repository's two packages, repacked from git, and the packages this working tree packs), and the pnpm invocation of the plugin manager that points at it.
// The registry is transport only: each packument is built from the manifest inside the tarball it was handed, with that tarball's integrity, so pnpm and the plugin manager read real packed manifests and verify real integrity. Nothing is signed, rewritten or fetched from a public registry, and no tarball is kept in the repository.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** The commit that released Session Watcher `@nomadop/session-watcher-dsh@0.11.1`, and the one that released the companion `@nomadop/session-watcher-dsh-carrier-cache@0.1.0`: the predecessors a migration starts from. */
export const RELEASED_SW = '8bf3aba3';
export const RELEASED_COMPANION = '2fa1f995';

/** Publication times are fixed and old, so that pnpm's minimum release age has no say in what a test installs. */
const PUBLISHED_AT = '2026-01-01T00:00:00.000Z';

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr}`);
  return result.stdout;
};

/** The manifest inside a packed tarball. */
export const manifestOf = file => JSON.parse(run('tar', ['-xOzf', file, 'package/package.json']));

/**
 * A loopback npm registry over packed tarballs. `publish(file)` adds the package the tarball holds; each request is recorded in `requests` as `{ method, path }`.
 * `hold(name, version)` makes the next tarball request for that version wait: the answer is withheld, headers included, until `release()`; `reached` settles once the request has arrived.
 * @returns {Promise<{ url: string, publish: (file: string) => { name: string, version: string }, hold: (name: string, version: string) => { reached: Promise<void>, release: () => void }, requests: { method: string, path: string }[], tarballRequests: (name: string, version: string) => number, close: () => Promise<void> }>}
 */
export async function startRegistry() {
  const published = new Map();
  const requests = [];
  const holds = [];
  let origin;

  const tarballName = (name, version) => `${name.split('/').at(-1)}-${version}.tgz`;
  const packument = (name) => {
    const versions = published.get(name);
    return {
      name,
      'dist-tags': { latest: [...versions.keys()].at(-1) },
      time: Object.fromEntries([...versions.keys()].map(version => [version, PUBLISHED_AT])),
      versions: Object.fromEntries([...versions].map(([version, { manifest, integrity, shasum }]) => [version, {
        ...manifest, _id: `${name}@${version}`,
        dist: { tarball: `${origin}/${name}/-/${tarballName(name, version)}`, integrity, shasum },
      }])),
    };
  };

  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://registry').pathname);
    requests.push({ method: request.method, path });
    const [name, file] = path.slice(1).split('/-/');
    const versions = published.get(name);
    if (versions === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (file === undefined) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(packument(name)));
      return;
    }
    const version = [...versions.keys()].find(each => tarballName(name, each) === file);
    if (version === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    const held = holds.find(each => each.name === name && each.version === version && !each.taken);
    if (held !== undefined) {
      held.taken = true;
      held.arrive();
      await held.gate;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(versions.get(version).bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    url: `${origin}/`,
    publish(file) {
      const manifest = manifestOf(file);
      const bytes = readFileSync(file);
      const versions = published.get(manifest.name) ?? new Map();
      assert.ok(!versions.has(manifest.version), `${manifest.name}@${manifest.version} is published twice`);
      versions.set(manifest.version, {
        manifest, bytes,
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        shasum: createHash('sha1').update(bytes).digest('hex'),
      });
      published.set(manifest.name, versions);
      return { name: manifest.name, version: manifest.version };
    },
    hold(name, version) {
      let arrive;
      let release;
      const reached = new Promise((resolve) => { arrive = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      holds.push({ name, version, taken: false, arrive, gate });
      return { reached, release };
    },
    requests,
    tarballRequests: (name, version) => requests.filter(each => each.path.endsWith(`/-/${tarballName(name, version)}`)).length,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/**
 * The pnpm invocation the plugin manager runs with in a profile that reads the loopback registry `url`: its store, cache and home under `home`, the registry the one it is given and anything else (every proxy is a dead port, only the loopback is exempt) unreachable.
 * Async pnpm only: the registry shares the process of the scenario that mounts the manager.
 */
export const registryPnpm = (home, url) => {
  const dead = 'http://127.0.0.1:9';
  return {
    command: 'pnpm', args: [],
    env: {
      pnpm_config_registry: url, npm_config_registry: url,
      pnpm_config_store_dir: join(home, 'pnpm-store'), pnpm_config_cache_dir: join(home, 'pnpm-cache'), PNPM_HOME: join(home, 'pnpm-home'),
      HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead, all_proxy: dead, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    },
  };
};

/** `pnpm pack` of the package at `directory` into `destination`, asynchronously; answers the tarball's path. */
async function pack(directory, destination) {
  mkdirSync(destination, { recursive: true });
  const child = spawn('pnpm', ['pack', '--pack-destination', destination], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: destination, pnpm_config_offline: 'true', pnpm_config_store_dir: join(destination, '.store') },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const status = await new Promise(resolve => child.on('close', resolve));
  if (status !== 0) throw new Error(`pnpm pack ${directory} exited ${status}: ${stderr}`);
  return stdout.split('\n').map(line => line.trim()).filter(line => line.endsWith('.tgz')).at(-1);
}

/**
 * The tarball of a package as a release carried it: the manifest and the files committed at `revision` under `directory`, repacked without a build.
 * The commits are the released ones on the release branch; a checkout that lacks them cannot take part in release-path acceptance, which is a failure of the run, not a skip.
 */
export async function releasedTarball(revision, directory, destination) {
  const present = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${revision}^{commit}`]);
  assert.equal(present.status, 0, `the released commit ${revision} is not in this clone; fetch the release branch`);
  const source = mkdtempSync(join(destination, 'released-'));
  const archive = spawnSync('git', ['-C', REPO, 'archive', revision, directory], { maxBuffer: 256 * 1024 * 1024 });
  assert.equal(archive.status, 0, `git archive ${revision} ${directory} failed`);
  run('tar', ['-x', '-C', source], { input: archive.stdout, encoding: null });
  return pack(join(source, directory), join(destination, `tarball-${basename(source)}`));
}

/**
 * The tarball of this working tree's package at `directory`, packed as it is, or with `version` in the manifest of a staged copy of the files the package ships: a candidate whose version is a test's own, the workspace manifest untouched.
 */
export async function workingTreeTarball(directory, destination, { version } = {}) {
  const source = join(REPO, directory);
  if (version === undefined) return pack(source, join(destination, `tarball-${basename(directory)}`));
  const staged = mkdtempSync(join(destination, 'staged-'));
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  for (const entry of [...manifest.files, 'LICENSE', 'README.md']) {
    if (existsSync(join(source, entry))) cpSync(join(source, entry), join(staged, entry), { recursive: true });
  }
  writeFileSync(join(staged, 'package.json'), `${JSON.stringify({ ...manifest, version }, undefined, 2)}\n`);
  return pack(staged, join(destination, `tarball-${basename(staged)}`));
}

const APP_BOOT = 'packages/boot/app-boot/lib/index.js';

/** Why the release-path cases skip: only an unset checkout. Under a configured one nothing skips; a missing prerequisite fails the case. */
export const releaseSkip = checkout => (checkout ? false : 'SW_DSH_CHECKOUT is unset');

/**
 * One scenario of `dsh-release-child.js` in a fresh Node process whose home, Harness home and temp directory sit in a fixture of its own and which holds no profile: every profile the scenario boots is its own, over the checkout's installation, with no package of this repository linked into it.
 * A checkout that names no DSH runtime, or a working tree without the built host entry, fails the case; what the child writes to stdout is the case's diagnostic.
 */
export function runReleaseScenario(t, scenario, checkout, { timeout = 240_000 } = {}) {
  assert.ok(existsSync(join(checkout, APP_BOOT)), `SW_DSH_CHECKOUT names no ${APP_BOOT}`);
  assert.ok(existsSync(join(REPO, 'dsh', 'dist', 'index.js')), 'dsh/dist/index.js is not built; run node scripts/build.js');
  const root = mkdtempSync(join(tmpdir(), 'sw-dsh-release-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  for (const path of ['home', 'dsh-home', 'tmp']) mkdirSync(join(root, path));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./dsh-release-child.js', import.meta.url)), scenario], {
    encoding: 'utf8',
    timeout,
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), DSH_HOME: join(root, 'dsh-home'), TMPDIR: join(root, 'tmp'), SW_DSH_CHECKOUT: checkout },
  });
  assert.equal(result.status, 0, `scenario ${scenario} exited ${result.status} (${result.signal})\n${result.stderr}`);
  if (result.stdout.length > 0) t.diagnostic(result.stdout.trimEnd());
  return result;
}

/** A scratch directory under the process's `TMPDIR`. */
export const scratch = prefix => mkdtempSync(join(tmpdir(), prefix));
