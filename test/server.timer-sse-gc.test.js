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
import { composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';

// Enough measured steps that a poll tick has real work, composed on the post-cutover stack. The composition
// owns the temp store as well as the server, so each case below registers its `teardown` as the release that
// covers a failing assertion, and keeps its own in-order stop-and-close for the path that reaches the end.
const composeFixture = (sessionId) => composeForTranscript({
  transcriptPath: writeMeasuredTranscript({ steps: 30 }), sessionId,
});

// === C5b-1: an SSE client that errors is removed from sseClients ===
test('C5b-1: an SSE client that errors is removed from sseClients', async (t) => {
  _resetRateLampManagerForTest();
  _setServerTestClock(null);
  t.after(() => { _setServerTestClock(null); _resetRateLampManagerForTest(); });

  const sessionId = `sse-gc-err-${randomUUID()}`;
  const composed = composeFixture(sessionId);
  const srv = composed.handle;
  t.after(() => composed.teardown());
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
  const composed = composeFixture(sessionId);
  const srv = composed.handle;
  t.after(() => composed.teardown());
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
  // A counting DRIVER spies on the advance count: the idle gate gates ONE Source advance per tick, so the
  // driver is where a suppressed tick is observable. It reports no frame, which is the ordinary
  // "no new rows" answer and is what leaves the gate as the only thing under test.
  let advanceCount = 0;
  let installed = false;
  const countingDriver = {
    advance() {
      advanceCount++;
      // A real driver's first readable advance returns its configured transition, which is what INSTALLS it;
      // afterwards "no new rows" is no frame. Without that first frame the host would still be acquiring, and
      // acquisition deliberately runs above the gate — so the gate would never be the thing under test.
      if (installed) return null;
      installed = true;
      return { transition: 'replace', sourceLocator: '/fixture/counting.jsonl', batches: [], sourceObserved: true, captureMode: 'replay' };
    },
    get sourceLocator() { return '/fixture/counting.jsonl'; },
  };

  // pollIntervalMs = 10 so ticks fire frequently; we control _nowMono via the test clock.
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1 }), sessionId, pollIntervalMs: 10,
    createSourceDriver: () => countingDriver,
  });
  const srv = composed.handle;
  t.after(() => composed.teardown());
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));

  try {
    // The first tick always runs (lastAdvanceMono starts at -Infinity → gate open).
    // After it runs, lastAdvanceMono = _nowMono(). We set the test clock so that subsequent
    // ticks see "now - lastAdvanceMono < IDLE_HEARTBEAT_MS" and get gated.
    const baseTime = 50000; // a fixed monotonic value (arbitrary, > IDLE_HEARTBEAT_MS)
    _setServerTestClock(baseTime);

    // Reset the count: the synchronous bootstrap already performed this driver's first advance.
    advanceCount = 0;
    srv.startPolling();
    // Wait for the first tick to fire (it passes the gate because lastAdvanceMono = -Infinity).
    await new Promise(r => setTimeout(r, 30));
    // First tick ran → advanceCount = 1, lastAdvanceMono = baseTime (set by _nowMono() inside the tick).
    const afterFirstTick = advanceCount;
    assert.equal(afterFirstTick, 1, 'first tick runs (gate open due to initial -Infinity)');

    // Now wait for more ticks — they should all be gated:
    // _nowMono() = baseTime, lastAdvanceMono = baseTime → diff = 0 < IDLE_HEARTBEAT_MS → skip.
    await new Promise(r => setTimeout(r, 60)); // ~6 more ticks at 10ms interval

    assert.equal(advanceCount, 1, 'idle gate skipped all subsequent ticks (recent advance, no SSE clients)');

    // Now simulate time advancing beyond IDLE_HEARTBEAT_MS:
    _setServerTestClock(baseTime + 6000); // 6s > 5s threshold → diff = 6000 >= 5000
    await new Promise(r => setTimeout(r, 60)); // ~6 ticks

    // Now ticks should fire (past the idle threshold).
    assert.ok(advanceCount > 1, `ticks fired after idle threshold exceeded (advanceCount=${advanceCount})`);
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
  const composed = composeForTranscript({ transcriptPath: writeMeasuredTranscript({ steps: 30 }), sessionId, pollIntervalMs: 10 });
  const srv = composed.handle;
  t.after(() => composed.teardown());
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
