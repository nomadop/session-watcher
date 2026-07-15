// test/server.pricing.test.js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal } from '../lib/store.js';

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sw-psrv-'));
  initStore(join(tmpDir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function withServer(opts, fn) {
  const { createServer } = await import('../server.js');
  const { SessionWatcher } = await import('../lib/watcher.js');
  const watcher = new SessionWatcher('/dev/null', 55000, opts.watcherOpts || {});
  watcher._segmentModel = opts.model || 'test-model';  // non-empty so POST guard passes
  const { server, stopTimers } = createServer({ watcher, pollIntervalMs: 0, sessionId: opts.sid || 'test' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port); }
  finally { stopTimers(); await new Promise(r => server.close(r)); }
}

test('GET /api/pricing — no saved, no CLI → model_default', async () => {
  await withServer({ sid: 'g1' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`);
    const body = await res.json();
    assert.equal(body.effective.source, 'model_default');
    assert.equal(body.saved, null);
  });
});

test('POST /api/pricing — valid → saves, effective=saved', async () => {
  await withServer({ sid: 'p1' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.30, writePrice: 3.00 })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.effective.source, 'saved');
    assert.equal(body.effective.ratio, 10);
    assert.equal(body.saved.readPrice, 0.30);
  });
});

test('POST /api/pricing — invalid → 400, no mutation', async () => {
  await withServer({ sid: 'p2' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 3, writePrice: 0.3 })
    });
    assert.equal(res.status, 400);
    const get = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    assert.equal(get.saved, null);
  });
});

test('POST /api/pricing — overrides CLI ratio', async () => {
  await withServer({ sid: 'p3', watcherOpts: { ratioOverride: 15 } }, async (port) => {
    const before = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    assert.equal(before.effective.source, 'cli');
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.30, writePrice: 3.00 })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.effective.source, 'saved');
    assert.equal(body.effective.ratio, 10);
  });
});

test('DELETE /api/pricing — clears saved, reverts to CLI or model_default', async () => {
  await withServer({ sid: 'p4' }, async (port) => {
    await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.30, writePrice: 3.00 })
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, null);
    assert.equal(body.effective.source, 'model_default');
  });
});

test('GET /api/pricing — includes presets array from constants', async () => {
  await withServer({ sid: 'preset1' }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`);
    const body = await res.json();
    assert.ok(Array.isArray(body.presets));
    // Each preset has id, label, readPrice, writePrice
    for (const p of body.presets) {
      assert.ok(typeof p.id === 'string');
      assert.ok(typeof p.label === 'string');
      assert.ok(typeof p.readPrice === 'number');
      assert.ok(typeof p.writePrice === 'number');
    }
  });
});

test('POST /api/pricing — with presetId matching preset prices → source=preset', async () => {
  await withServer({ sid: 'preset2' }, async (port) => {
    // Prices must match the preset definition in constants.js (opus-4.8: read=0.50, write=6.25)
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 0.50, writePrice: 6.25, presetId: 'opus-4.8' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved.presetId, 'opus-4.8');
    assert.equal(body.effective.source, 'preset');  // prices match → source is preset
  });
});

test('GET /api/pricing — preset drift: saved presetId with changed prices → source=saved', async () => {
  await withServer({ sid: 'preset3' }, async (port) => {
    // Save with a presetId but prices that don't match current preset data
    await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 999, writePrice: 999, presetId: 'opus-4' })
    });
    const get = await (await fetch(`http://127.0.0.1:${port}/api/pricing`)).json();
    // Drift detected: source should be 'saved' not 'preset'
    assert.equal(get.effective.source, 'saved');
  });
});

test('POST /api/pricing — no model detected → 409', async () => {
  const { createServer } = await import('../server.js');
  const { SessionWatcher } = await import('../lib/watcher.js');
  const watcher = new SessionWatcher('/dev/null', 55000, {});
  // _segmentModel stays null — empty string after || '' — triggers guard
  const { server, stopTimers } = createServer({ watcher, pollIntervalMs: 0, sessionId: 'no-model-test' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pricing`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readPrice: 3, writePrice: 15 })
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'no_model');
  } finally {
    stopTimers();
    await new Promise(r => server.close(r));
  }
});
