import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate ledger/gate state writes to a temp directory.
const TMP = mkdtempSync(join(tmpdir(), 'sw-timer-sse-gc-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { createServer, _inspectSseClientsForTest, _setServerTestClock } from '../server.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { SessionWatcher } from '../lib/watcher.js';

// Minimal fixture watcher: enough turns for poll() to work without throwing.
function fixtureWatcher() {
  let s = ''; let cr = 42000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 940;
    s += JSON.stringify({ type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + id++, model: 'deepseek-v4-pro', usage: {
        input_tokens: 560, output_tokens: 380, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n';
  }
  const p = join(mkdtempSync(join(tmpdir(), 'sw-fix-')), 's.jsonl');
  writeFileSync(p, s);
  return new SessionWatcher(p, 42000);
}

// === C5b-1: an SSE client that errors is removed from sseClients ===
test('C5b-1: an SSE client that errors is removed from sseClients', async (t) => {
  _resetRateLampManagerForTest();
  _setServerTestClock(null);
  t.after(() => { _setServerTestClock(null); _resetRateLampManagerForTest(); });

  const sessionId = `sse-gc-err-${randomUUID()}`;
  const srv = createServer({ watcher: fixtureWatcher(), pollIntervalMs: 0, sessionId });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;

  try {
    // Open SSE connection
    const controller = new AbortController();
    const resPromise = fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal });
    const res = await resPromise;
    assert.equal(res.status, 200, 'SSE stream opened');

    // Wait a moment for the server to register the client
    await new Promise(r => setTimeout(r, 30));
    assert.equal(_inspectSseClientsForTest(srv), 1, 'client is registered');

    // Force the response to emit an error by aborting from client side — this fires req 'close'/'aborted'
    controller.abort();
    // Allow event loop to process the close/abort events
    await new Promise(r => setTimeout(r, 50));

    assert.equal(_inspectSseClientsForTest(srv), 0, 'client removed after error/abort');
  } finally {
    srv.stopTimers();
    await new Promise(r => srv.server.close(r));
  }
});

// === C5b-1: a client-side REQUEST abort removes the SSE client (req close/aborted, not res) ===
test('C5b-1: a client-side REQUEST abort removes the SSE client — del is idempotent', async (t) => {
  _resetRateLampManagerForTest();
  _setServerTestClock(null);
  t.after(() => { _setServerTestClock(null); _resetRateLampManagerForTest(); });

  const sessionId = `sse-gc-abort-${randomUUID()}`;
  const srv = createServer({ watcher: fixtureWatcher(), pollIntervalMs: 0, sessionId });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;

  try {
    // Open first SSE connection
    const ctrl1 = new AbortController();
    await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl1.signal });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(_inspectSseClientsForTest(srv), 1, 'one client registered');

    // Abort the REQUEST (client hangs up) — req 'close'/'aborted' should fire
    ctrl1.abort();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(_inspectSseClientsForTest(srv), 0, 'client removed after request abort');

    // Idempotency: the del function was bound to multiple events (req.close, req.aborted, res.close,
    // res.error). All of them may fire. Confirm size stays 0 with no throw (Set.delete is idempotent).
    // We verify this by opening and aborting a second connection — if del threw on duplicate calls
    // the server would be in a bad state.
    const ctrl2 = new AbortController();
    await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: ctrl2.signal });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(_inspectSseClientsForTest(srv), 1, 'second client registered (server healthy)');

    ctrl2.abort();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(_inspectSseClientsForTest(srv), 0, 'second client removed cleanly — no double-fire crash');
  } finally {
    srv.stopTimers();
    await new Promise(r => srv.server.close(r));
  }
});

// === C5b-1: idle heartbeat skips the tick when a reader advanced recently (monotonic gate) ===
test('C5b-1: idle heartbeat skips the tick when a reader advanced recently (monotonic gate)', async (t) => {
  _resetRateLampManagerForTest();
  _setServerTestClock(null);
  t.after(() => { _setServerTestClock(null); _resetRateLampManagerForTest(); });

  const sessionId = `idle-gate-${randomUUID()}`;
  // Use a counting watcher to spy on advance count
  let pollCount = 0;
  const countingWatcher = {
    poll() { pollCount++; return { changed: false }; },
    getStatus() { return { segment: 0, model: 'claude-opus-4-8', kAvg: 0, L: 0,
      baseline: { total: 0, dead: 0, fingerprint: null },
      rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } }; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    _currentSegmentCalls() { return []; },
    _turnSeq: 0,
  };

  // pollIntervalMs = 10 so ticks fire frequently; we control _nowMono via the test clock.
  const srv = createServer({ watcher: countingWatcher, pollIntervalMs: 10, sessionId });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));

  try {
    // The first tick always runs (lastAdvanceMono starts at -Infinity → gate open).
    // After it runs, lastAdvanceMono = _nowMono(). We set the test clock so that subsequent
    // ticks see "now - lastAdvanceMono < IDLE_HEARTBEAT_MS" and get gated.
    const baseTime = 50000; // a fixed monotonic value (arbitrary, > IDLE_HEARTBEAT_MS)
    _setServerTestClock(baseTime);

    // Reset pollCount: createServer's initial watcher.poll() in the constructor increments it.
    pollCount = 0;
    srv.startPolling();
    // Wait for the first tick to fire (it passes the gate because lastAdvanceMono = -Infinity).
    await new Promise(r => setTimeout(r, 30));
    // First tick ran → pollCount = 1, lastAdvanceMono = baseTime (set by _nowMono() inside the tick).
    const afterFirstTick = pollCount;
    assert.equal(afterFirstTick, 1, 'first tick runs (gate open due to initial -Infinity)');

    // Now wait for more ticks — they should all be gated:
    // _nowMono() = baseTime, lastAdvanceMono = baseTime → diff = 0 < IDLE_HEARTBEAT_MS → skip.
    await new Promise(r => setTimeout(r, 60)); // ~6 more ticks at 10ms interval

    assert.equal(pollCount, 1, 'idle gate skipped all subsequent ticks (recent advance, no SSE clients)');

    // Now simulate time advancing beyond IDLE_HEARTBEAT_MS:
    _setServerTestClock(baseTime + 6000); // 6s > 5s threshold → diff = 6000 >= 5000
    await new Promise(r => setTimeout(r, 60)); // ~6 ticks

    // Now ticks should fire (past the idle threshold).
    assert.ok(pollCount > 1, `ticks fired after idle threshold exceeded (pollCount=${pollCount})`);
  } finally {
    srv.stopTimers();
    _setServerTestClock(null);
    await new Promise(r => srv.server.close(r));
  }
});

// === C5b-1: heartbeat advances meter but never records an alert ===
test('C5b-1: heartbeat advances meter but never records an alert (S2: alert is Stop-route only)', async (t) => {
  _resetRateLampManagerForTest();
  _setServerTestClock(null);
  t.after(() => { _setServerTestClock(null); _resetRateLampManagerForTest(); });

  const sessionId = `hb-no-alert-${randomUUID()}`;
  const srv = createServer({ watcher: fixtureWatcher(), pollIntervalMs: 10, sessionId });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;

  try {
    // Force the idle gate to be open (large time offset so the gate doesn't skip).
    _setServerTestClock(performance.now() + 100000);

    srv.startPolling();
    // Let several heartbeat ticks run
    await new Promise(r => setTimeout(r, 80));

    // Check status: the meter may have advanced (billProgress/summary moved) but lastStopEvent
    // must be null — alert delivery is Stop-route only (S2).
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    const status = await res.json();

    // rateLamp.lastStopEvent must be null/undefined — the heartbeat never sets it.
    const lastStopEvent = status.rateLamp?.lastStopEvent ?? null;
    assert.equal(lastStopEvent, null, 'heartbeat never records an alert (lastStopEvent stays null)');

    // Also check via debug endpoint if available
    const debugRes = await fetch(`http://127.0.0.1:${port}/api/debug/rate-lamp/${sessionId}`);
    if (debugRes.status === 200) {
      const debug = await debugRes.json();
      const ledgerStopEvent = debug.ledger?.lastStopEvent ?? null;
      assert.equal(ledgerStopEvent, null, 'ledger lastStopEvent is null — heartbeat never fires alerts');
    }
  } finally {
    srv.stopTimers();
    _setServerTestClock(null);
    await new Promise(r => srv.server.close(r));
  }
});
