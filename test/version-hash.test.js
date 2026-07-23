import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('PLUGIN_VERSION equals package.json version', async () => {
  const { PLUGIN_VERSION } = await import('../lib/version.js');
  const pkg = require('../package.json');
  assert.equal(PLUGIN_VERSION, pkg.version);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/);
});

test('hashFileContent returns a stable sha256 hex for a readable file', async () => {
  const { hashFileContent } = await import('../lib/handoff.js');
  const dir = mkdtempSync(join(tmpdir(), 'sw-hash-'));
  try {
    const f = join(dir, 'a.txt');
    writeFileSync(f, 'hello world\n');
    const h1 = hashFileContent(f);
    const h2 = hashFileContent(f);
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.equal(h1, h2, 'deterministic');
    writeFileSync(f, 'changed\n');
    assert.notEqual(hashFileContent(f), h1, 'content change → different hash');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hashFileContent returns null for a missing file (never throws)', async () => {
  const { hashFileContent } = await import('../lib/handoff.js');
  assert.equal(hashFileContent('/no/such/path/xyz.txt'), null);
});

test('hashFileContent returns null for a non-regular file (device/dir) — no unbounded read', async () => {
  const { hashFileContent } = await import('../lib/handoff.js');
  // A directory is a portable non-regular target (avoids assuming /dev/zero exists on the runner).
  const dir = mkdtempSync(join(tmpdir(), 'sw-hash-nr-'));
  try {
    assert.equal(hashFileContent(dir), null, 'a directory is not a regular file → null, never read');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hashFileContent returns null for a file over the size cap (never buffers it)', async () => {
  const { hashFileContent, HASH_MAX_BYTES } = await import('../lib/handoff.js');
  const dir = mkdtempSync(join(tmpdir(), 'sw-hash-big-'));
  try {
    const f = join(dir, 'big.bin');
    // Sparse file just over the cap: truncate sets length without writing bytes, so the test is cheap;
    // the guard must reject it via statSync.size BEFORE any readFileSync.
    const fd = openSync(f, 'w'); ftruncateSync(fd, HASH_MAX_BYTES + 1); closeSync(fd);
    assert.equal(hashFileContent(f), null, 'over-cap file → null without reading it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
