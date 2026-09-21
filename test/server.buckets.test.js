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

import { createServer } from '../server.js';
import { composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';

void createServer;   // the composition helper owns the wiring; the import documents what it wires

async function withServer(fn) {
  // Enough measured steps for getBucketData to have meaningful output, plus two resident paths fed the way
  // production feeds them: real Read tool pairs in the Source.
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 28, paths: ['/workspace/src/app.js'] }),
    sessionId: 'test-buckets', projectRoot: '/workspace',
  });
  const { server, stopTimers } = composed.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, composed.watcher); } finally { stopTimers(); await composed.teardown(); }
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
    // CTP overshoot telemetry left status, bucket data and the terminal snapshot with the approved delta;
    // `test/session-watcher.interface.test.js` pins its absence at the Interface.
    assert.equal('ctpOvershootRatio' in data, false, 'the retired overshoot field is absent');
    assert.equal(typeof data.currentTurnSeq, 'number', 'currentTurnSeq is a number');
    assert.equal(typeof data.segment, 'number', 'segment is a number');
  });
});
