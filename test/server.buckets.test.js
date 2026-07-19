import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal } from '../lib/store.js';

// Initialize a temp store so server.js imports don't fail
const TMP = mkdtempSync(join(tmpdir(), 'sw-buckets-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';

function fixtureWatcher() {
  // Build a transcript with enough data for getBucketData to produce meaningful output
  let s = ''; let cr = 42000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 940;
    s += JSON.stringify({ type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + id++, model: 'deepseek-v4-pro', usage: {
        input_tokens: 560, output_tokens: 380, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
  }
  const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl');
  writeFileSync(p, s);
  return new SessionWatcher(p, 42000);
}

async function withServer(fn) {
  const w = fixtureWatcher();
  const { server, stopTimers } = createServer({ watcher: w, pollIntervalMs: 0, sessionId: 'test-buckets' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, w); } finally { stopTimers(); await new Promise(r => server.close(r)); }
}

test('GET /api/buckets returns expected shape', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/buckets`);
    assert.equal(res.status, 200);
    const data = await res.json();
    // Expected keys per watcher.getBucketData() contract (§11.3.1)
    assert.ok(Array.isArray(data.paths), 'paths is an array');
    assert.ok(Array.isArray(data.skills), 'skills is an array');
    assert.ok(data.residual && Array.isArray(data.residual.bash) && Array.isArray(data.residual.mcp), 'residual.bash/mcp arrays');
    assert.equal(typeof data.dead, 'number', 'dead is a number');
    assert.equal(typeof data.totalB, 'number', 'totalB is a number');
    assert.equal(typeof data.totalL, 'number', 'totalL is a number');
    assert.equal(typeof data.totalResidual, 'number', 'totalResidual is a number');
    assert.equal(typeof data.ctpOvershootRatio, 'number', 'ctpOvershootRatio is a number');
    assert.equal(typeof data.currentTurnSeq, 'number', 'currentTurnSeq is a number');
    assert.equal(typeof data.segment, 'number', 'segment is a number');
  });
});
