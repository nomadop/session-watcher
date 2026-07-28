// test/override-e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';

const TMP = mkdtempSync(join(tmpdir(), 'sw-e2e-override-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';

function makeWatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-'));
  const p = join(dir, 'transcript.jsonl');
  // Multi-call transcript so status metrics are populated
  let s = ''; let cr = 42000;
  for (let i = 0; i < 10; i++) {
    cr += 800;
    s += JSON.stringify({ type: 'assistant', uuid: 'u' + i, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + i, model: 'deepseek-v4-pro', usage: {
        input_tokens: 500, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
  }
  writeFileSync(p, s);
  return new SessionWatcher(p, 42000, { cwd: '/workspace' });
}

async function withServer(fn) {
  const w = makeWatcher();
  const { server, stopTimers } = createServer({ watcher: w, pollIntervalMs: 0, sessionId: 'test-e2e' });
  // Inject paths AFTER createServer (which runs an initial poll that rebuilds bRebuild)
  // so the paths survive and are visible to the POST /api/user-overrides validator.
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 2000]], overhead: 0 }, '/workspace/src/big.ts', 1, 1);
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/src/small.ts', 1, 1);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, w); } finally { stopTimers(); await new Promise(r => server.close(r)); }
}

test('Apply override changes bDefault which changes x/br in status', async () => {
  await withServer(async (port, w) => {
    // Get status before override
    const before = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    const bDefaultBefore = w._computeBDefault();

    // Exclude the big file
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/src/big.ts': 'exclude' } }),
    });
    assert.equal(res.status, 200);

    const bDefaultAfter = w._computeBDefault();
    assert.ok(bDefaultAfter < bDefaultBefore, `bDefault should decrease: ${bDefaultAfter} < ${bDefaultBefore}`);

    // Get status after override — x should change (higher since bDefault decreased)
    const after = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    // bDefault in status should reflect the change; x may also shift
    assert.ok(after.bDefault !== before.bDefault || after.x !== before.x,
      'Metrics should change after override');
  });
});

test('Reset (empty overrides) restores original bDefault', async () => {
  await withServer(async (port, w) => {
    const bOriginal = w._computeBDefault();

    // Apply override
    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/src/big.ts': 'exclude' } }),
    });
    assert.notEqual(w._computeBDefault(), bOriginal);

    // Reset
    await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: {} }),
    });
    assert.equal(w._computeBDefault(), bOriginal);
  });
});

test('Inference + Apply interaction preserves inferred entries', async () => {
  await withServer(async (port, w) => {
    // Set up siblings with override (absolute paths)
    w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, '/workspace/lib/a.js', 1, 1);
    w._bRebuild.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 0 }, '/workspace/lib/b.js', 1, 1);
    w._userOverrides.set('/workspace/lib/a.js', 'exclude');
    w._userOverrides.set('/workspace/lib/b.js', 'exclude');

    // Simulate new file arrival
    w._bRebuild.apply({ type: 'fullSet', lines: [[1, 150]], overhead: 0 }, '/workspace/lib/c.js', 1, 1);
    w._tryInferOverride('/workspace/lib/c.js');
    assert.equal(w._userOverrides.get('/workspace/lib/c.js'), 'exclude', 'c.js should be inferred as exclude');

    // Now POST an Apply that includes all current non-default state
    // (simulating what frontend would send — it sees userOverride on all three)
    const res = await fetch(`http://127.0.0.1:${port}/api/user-overrides`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { '/workspace/lib/a.js': 'exclude', '/workspace/lib/b.js': 'exclude', '/workspace/lib/c.js': 'exclude' } }),
    });
    assert.equal(res.status, 200);
    // All three should remain in the map
    assert.equal(w._userOverrides.get('/workspace/lib/c.js'), 'exclude');
  });
});
