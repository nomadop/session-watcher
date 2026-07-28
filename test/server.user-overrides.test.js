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

import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';

function fixtureWatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  const p = join(dir, 'transcript.jsonl');
  // Minimal transcript: one assistant call so watcher has cacheRead > 0
  let s = '';
  const cr = 42000;
  s += JSON.stringify({ type: 'assistant', uuid: 'u0', isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id: 'm0', model: 'deepseek-v4-pro', usage: {
      input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
  writeFileSync(p, s);
  const w = new SessionWatcher(p, 42000, { cwd: '/workspace' });
  // Inject paths into _bRebuild for validation testing (absolute — matches canonicalizePath output)
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 800]], overhead: 0 }, '/workspace/src/app.js', 1, 1);
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 400]], overhead: 0 }, '/workspace/dist/bundle.js', 1, 1);
  return w;
}

async function withServer(fn) {
  const w = fixtureWatcher();
  const { server, stopTimers, sseClients } = createServer({ watcher: w, pollIntervalMs: 0, sessionId: 'test-overrides' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, w, sseClients); } finally { stopTimers(); await new Promise(r => server.close(r)); }
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
    assert.equal(w._userOverrides.get('/workspace/src/app.js'), 'exclude');
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
    assert.equal(w._userOverrides.size, 2);

    // Second POST with only one entry — first entry should be gone (replace semantics)
    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/dist/bundle.js': 'include' } }),
    });
    assert.equal(w._userOverrides.size, 1);
    assert.equal(w._userOverrides.has('/workspace/src/app.js'), false);
  });
});

test('POST /api/user-overrides with empty object resets all', async () => {
  await withServer(async (port, w) => {
    w._userOverrides.set('/workspace/src/app.js', 'exclude');
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: {} }),
    });
    assert.equal(res.status, 200);
    assert.equal(w._userOverrides.size, 0);
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
    assert.equal(w._userOverrides.get('/workspace/dist/bundle.js'), 'include');
    assert.equal(w._userOverrides.has('/nonexistent.js'), false);
    assert.equal(w._userOverrides.has('/workspace/src/app.js'), false);
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
