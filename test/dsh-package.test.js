import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));
const manifest = readJson('dsh', 'package.json');
const rootManifest = readJson('package.json');

test('every @deepseek-ai/dsh-* dependency is a peer at >=0.2.0-rc.1 and none is a dependency', () => {
  const peers = Object.entries(manifest.peerDependencies ?? {});
  assert.ok(peers.length > 0);
  for (const [name, range] of peers) {
    if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(range, '>=0.2.0-rc.1');
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const names = Object.keys(manifest[field] ?? {});
    assert.deepEqual(names.filter(n => n.startsWith('@deepseek-ai/')), [], field);
  }
});

test("the version is the root package's", () => {
  assert.equal(manifest.version, rootManifest.version);
});

test('the main export points into dist and files ships dist and the bundle patch alone', () => {
  assert.equal(manifest.exports['.'], './dist/index.js');
  assert.deepEqual(manifest.files, ['dist/', 'dsh.bundle.patch.yml']);
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
  const primitives = { useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {} };
  const exports = spec.factory((specifier) => {
    if (specifier === 'react' || specifier === 'react-dom') return devRequire(specifier);
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error(`require("${specifier}") is not a seed word the bundle uses`);
  });
  assert.deepEqual(exports.inject, ['slots', 'locale', 'theme', 'connection']);
  assert.equal(typeof exports.apply, 'function');
});

test('the manifest names its bundle patch file and the file exists', () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string');
  assert.ok(existsSync(join(ROOT, 'dsh', patch)));
});
