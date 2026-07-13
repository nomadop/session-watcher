import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate ledger/gate state writes to a temp CLAUDE_PLUGIN_DATA (read lazily per call by the stores, so
// setting it before importing the server suffices — mirrors server.stop-route.test.js).
const TMP = mkdtempSync(join(tmpdir(), 'sw-pollloop-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { createServer } from '../server.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';

// A watcher whose poll() THROWS on every tick — the exact transient-failure shape the poll-loop guard
// must survive (a bad frame, or advanceRateLampToCurrent → writeJsonAtomic re-throwing a disk error).
// getStatus + the sample stubs are present so the module loads even if the guarded body reaches them.
function throwingWatcher() {
  return {
    poll() { throw new Error('boom'); },
    getStatus() { return { segment: 0, model: 'claude-opus-4-8', kAvg: 0, L: 0,
      baseline: { total: 0, dead: 0, fingerprint: null },
      rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } }; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    _currentSegmentCalls() { return []; },
  };
}

// Finding 1 (final-review Important): the setInterval poll body runs watcher.poll() +
// advanceRateLampToCurrent with NO boundary. A throw there (WITHOUT the guard) escapes to an
// uncaughtException that kills this long-lived daemon (RED: the test process crashes). WITH the
// guard, the throw is logged-under-SW_DEBUG + swallowed → the daemon stays up → /api/health is ok (GREEN).
test('poll-loop throw does not kill the daemon — /api/health still 200 {ok:true}', async () => {
  _resetRateLampManagerForTest();
  const sessionId = `pl-${randomUUID()}`;
  // pollIntervalMs must be > 0 (startPolling early-returns on <= 0); small so a few ticks elapse in ~40ms.
  const srv = createServer({ watcher: throwingWatcher(), pollIntervalMs: 10, sessionId });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  try {
    srv.startPolling();
    await new Promise((r) => setTimeout(r, 40)); // ~4 poll ticks, each of which throws
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200, 'daemon survived the throwing poll loop');
    const body = await res.json();
    assert.equal(body.ok, true, 'GET /api/health returns { ok: true } — process still alive');
  } finally {
    srv.stopTimers();
    await new Promise((r) => srv.server.close(r));
  }
});
