import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { stubDocument, fakeCtx } from './helpers/dsh-client-context.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const manifest = readJson('dsh', 'package.json');
const rootManifest = readJson('package.json');

test('the host floor is the one `engines.dsh` declares, every @deepseek-ai/dsh-* dependency is a peer at that floor and none is a dependency', () => {
  const floor = manifest.engines.dsh;
  assert.equal(floor, '>=0.2.2-rc.1');
  const peers = Object.entries(manifest.peerDependencies ?? {});
  assert.ok(peers.length > 0);
  for (const [name, range] of peers) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, floor, name);
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const names = Object.keys(manifest[field] ?? {});
    assert.deepEqual(names.filter(n => n.startsWith('@deepseek-ai/')), [], field);
  }
});

test("the version is the root package's", () => {
  assert.equal(manifest.version, rootManifest.version);
});

test('the main export points into dist and files ships dist, the README assets and the bundle patch alone', () => {
  assert.equal(manifest.exports['.'], './dist/index.js');
  assert.deepEqual(manifest.files, ['dist/', 'assets/', 'dsh.bundle.patch.yml']);
});

test('the client half is declared and its artifact registers under the package name', async (t) => {
  assert.deepEqual(manifest.dsh.client, { platform: 'web' });
  assert.equal(manifest.exports['./client'], './dist/client.js');

  // The bundle is a classic script that hands its factory to the page's loader; the factory requires the loader's seed words alone.
  const specs = [];
  globalThis.window = { __ModuleLoader__: { load(spec) { specs.push(spec); } } };
  t.after(() => { delete globalThis.window; });
  await import(pathToFileURL(join(ROOT, 'dsh', manifest.exports['./client'])).href);
  assert.equal(specs.length, 1);
  const [spec] = specs;
  assert.equal(spec.id, manifest.name);
  const devRequire = createRequire(import.meta.url);
  const GaugeIcon = () => null;
  const primitives = { IconGaugeOutlineMedium: GaugeIcon, useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {} };
  const exports = spec.factory((specifier) => {
    if (specifier === 'react' || specifier === 'react-dom') return devRequire(specifier);
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`require("${specifier}") is not a seed word the bundle uses`);
  });
  assert.deepEqual(exports.inject, ['slots', 'locale', 'theme', 'connection']);
  assert.equal(typeof exports.apply, 'function');

  stubDocument(t);
  const fake = fakeCtx();
  exports.apply(fake.ctx);
  fake.declare();
  const icon = fake.registrations.find(entry => entry.options.name === 'settings.section.icon');
  assert.ok(icon);
  assert.equal(icon.options.id, 'session-watcher');
  assert.equal(icon.component, GaugeIcon);
  fake.undeclare();
  assert.equal(icon.disposed, 1);
});

test('the manifest names its bundle patch file and the file exists', () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string');
  assert.ok(existsSync(join(ROOT, 'dsh', patch)));
});

test('the skills the package ships are sw-explain and sw-handoff', () => {
  const skillsDir = join(ROOT, 'dsh', 'dist', 'skills');
  const shipped = readdirSync(skillsDir).filter(name => existsSync(join(skillsDir, name, 'SKILL.md'))).sort();
  assert.deepEqual(shipped, ['sw-explain', 'sw-handoff']);
});
