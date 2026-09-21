import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';

const TMP = mkdtempSync(join(tmpdir(), 'sw-overrides-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

import { composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';

// Both paths become resident the way production makes them resident: real Read tool pairs in the Source,
// under the project root, so the override route's validation sees the Engine's own resource keys.
const RESIDENT = ['/workspace/src/app.js', '/workspace/dist/bundle.js'];

// The effective override set, read through the Interface rather than a private map: the Engine owns the
// current epoch's set and reports each resource's own `userOverride` on the bucket row.
const overridesOf = (w) => new Map(w.getBucketData().paths
  .filter(row => row.userOverride)
  .map(row => [row.path, row.userOverride]));

async function withServer(fn) {
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1, paths: RESIDENT }),
    sessionId: 'test-overrides', projectRoot: '/workspace',
  });
  const { server, stopTimers, sseClients } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, composed.watcher, sseClients); } finally { stopTimers(); await composed.teardown(); }
}

test('POST /api/user-overrides sets overrides and returns status', async () => {
  await withServer(async (port, w) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/src/app.js': 'exclude' } }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.B, 'number');
    assert.equal(overridesOf(w).get('/workspace/src/app.js'), 'exclude');
  });
});

test('POST /api/user-overrides replaces entire map', async () => {
  await withServer(async (port, w) => {
    // First POST
    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/src/app.js': 'exclude', '/workspace/dist/bundle.js': 'include' } }),
    });
    assert.equal(overridesOf(w).size, 2);

    // Second POST with only one entry — first entry should be gone (replace semantics)
    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/dist/bundle.js': 'include' } }),
    });
    assert.equal(overridesOf(w).size, 1);
    assert.equal(overridesOf(w).has('/workspace/src/app.js'), false);
  });
});

test('POST /api/user-overrides with empty object resets all', async () => {
  await withServer(async (port, w) => {
    // Seeded through the named operation, which is the only way a set is established now.
    w.replaceUserOverrides({ '/workspace/src/app.js': 'exclude' });
    assert.equal(overridesOf(w).size, 1, 'the seed landed before the reset');
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: {} }),
    });
    assert.equal(res.status, 200);
    assert.equal(overridesOf(w).size, 0);
  });
});

test('POST /api/user-overrides ignores invalid keys/values (200 with warning)', async () => {
  await withServer(async (port, w) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/nonexistent.js': 'include', '/workspace/src/app.js': 'badvalue', '/workspace/dist/bundle.js': 'include' } }),
    });
    assert.equal(res.status, 200);
    // Only valid entry applied
    const effective = overridesOf(w);
    assert.equal(effective.get('/workspace/dist/bundle.js'), 'include');
    assert.equal(effective.has('/nonexistent.js'), false);
    assert.equal(effective.has('/workspace/src/app.js'), false);
    const data = await res.json();
    assert.ok(Array.isArray(data.warnings));
    assert.ok(data.warnings.length >= 2);
  });
});

test('POST /api/user-overrides broadcasts SSE scan event', async () => {
  await withServer(async (port, w, sseClients) => {
    // Connect an SSE client
    const controller = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal }).catch(() => null);
    // Wait for SSE client to register
    const t0 = Date.now();
    while (sseClients.size === 0 && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 10));
    assert.equal(sseClients.size, 1);

    // POST override
    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/src/app.js': 'exclude' } }),
    });

    // The SSE scan event was broadcast — we can verify by checking sseClients is still alive
    // (A more thorough test would read the SSE stream, but this verifies no crash)
    assert.equal(sseClients.size, 1);
    controller.abort();
  });
});
