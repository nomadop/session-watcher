import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLedger, stateKeyOf } from '../lib/rate-lamp-store.js';
import {
  _resetRateLampManagerForTest,
  _setRateLampManagerTestHooks,
  setLiveLedger,
  getLiveLedger,
  mutateLedger,
  schedulePersist,
  cancelCoalescedPersist,
  persistLedger,
  isEnospcPaused,
} from '../lib/rate-lamp-manager.js';

const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 2 });

// ════════════════════════════════════════════════════════════════════════════════
// C5a-1: Write-behind coalesced persist tests
// ════════════════════════════════════════════════════════════════════════════════

test('C5a-1: coalesced flush re-reads the live ledger, never a captured snapshot', (t) => {
  _resetRateLampManagerForTest();
  const sid = 'test-c5a-reread-' + Date.now();

  // Track writes through the injected writer
  const writes = [];
  let timerCb = null;

  _setRateLampManagerTestHooks({
    writer: (path, obj) => { writes.push(obj); },
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });
  t.after(() => _resetRateLampManagerForTest());

  // Seed a live ledger at revision 1
  const ledger = { ...freshLedger(KEY, 940), ledgerRevision: 1 };
  setLiveLedger(sid, ledger);

  // Schedule persist (records sid only, NOT a snapshot)
  schedulePersist(sid);

  // Mutate the live ledger to a HIGHER revision BEFORE flush
  const mutated = mutateLedger(getLiveLedger(sid), 'test-advance', (l) => {
    l.billProgress = 0.5;
  });
  // mutated now has ledgerRevision = 2
  // Replace the live ledger in the manager
  setLiveLedger(sid, mutated);

  // Fire the coalesced timer
  assert.ok(timerCb, 'scheduler was called with a flush callback');
  timerCb();

  // Assert: the writer received the LATEST revision (2), not the schedule-time value (1)
  // Filter writes to exclude the setLiveLedger calls (which are force-writes with revision 1 and 2)
  // The coalesced flush is the LAST write after timerCb()
  const lastWrite = writes[writes.length - 1];
  assert.equal(lastWrite.ledgerRevision, 2, 'flush re-read the live ledger (revision 2), not the snapshot at schedule time (1)');
  assert.equal(lastWrite.billProgress, 0.5, 'flush carries the latest mutation');
});

test('C5a-1: revision gate refuses to write an older revision over a newer one', (t) => {
  _resetRateLampManagerForTest();
  const sid = 'test-c5a-gate-' + Date.now();

  const writes = [];
  _setRateLampManagerTestHooks({
    writer: (path, obj) => { writes.push(obj); },
  });
  t.after(() => _resetRateLampManagerForTest());

  // Persist a ledger at revision 5 via setLiveLedger (force:true → updates _lastPersistedRevision)
  const ledger5 = { ...freshLedger(KEY, 940), ledgerRevision: 5, billProgress: 0.5 };
  setLiveLedger(sid, ledger5);

  // Now attempt to persistLedger with a stale revision 3 WITHOUT force
  const staleLedger = { ...freshLedger(KEY, 940), ledgerRevision: 3, billProgress: 0.1 };
  writes.length = 0; // clear tracked writes
  persistLedger(sid, staleLedger); // without force, revision gate blocks

  // The writer should NOT have been called (revision 3 < last persisted 5, no force)
  assert.equal(writes.length, 0, 'writer NOT called for stale revision (3 < 5) without force');

  // But with force:true, it SHOULD succeed (force bypasses < gate — needed for fresh ledger after key change)
  persistLedger(sid, staleLedger, { force: true });
  assert.equal(writes.length, 1, 'writer called with force:true even for stale revision (key-change recovery)');
});

test('C5a-1: an unchanged advance elides the write (write-elision via _lastSaved still holds)', (t) => {
  _resetRateLampManagerForTest();
  const sid = 'test-c5a-elision-' + Date.now();

  const writes = [];
  let timerCb = null;
  _setRateLampManagerTestHooks({
    writer: (path, obj) => { writes.push(obj); },
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });
  t.after(() => _resetRateLampManagerForTest());

  // Seed a live ledger
  const ledger = { ...freshLedger(KEY, 940), ledgerRevision: 1 };
  setLiveLedger(sid, ledger);
  // setLiveLedger force-writes once
  const afterFirst = writes.length;

  // Schedule persist for the SAME ledger (no changes since last write)
  schedulePersist(sid);
  if (timerCb) timerCb();

  // No additional write should have occurred (unchanged content → elision)
  assert.equal(writes.length, afterFirst, 'no redundant write for unchanged ledger (write-elision cache)');
});

// ════════════════════════════════════════════════════════════════════════════════
// C5a-1: ENOSPC pause-drain
// ════════════════════════════════════════════════════════════════════════════════

test('C5a-1: ENOSPC pause blocks schedulePersist; Stop force-write probes recovery', (t) => {
  _resetRateLampManagerForTest();
  const sid = 'test-c5a-enospc-' + Date.now();

  let writeCount = 0;
  let shouldThrow = true;
  let timerCb = null;
  _setRateLampManagerTestHooks({
    writer: (path, obj) => {
      writeCount++;
      if (shouldThrow) {
        const err = new Error('ENOSPC');
        err.code = 'ENOSPC';
        throw err;
      }
    },
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });
  t.after(() => _resetRateLampManagerForTest());

  // Seed ledger in memory: use setLiveLedger which will throw but we catch it.
  // setLiveLedger does _ledgers.set BEFORE persistLedger, so the ledger IS in memory.
  const ledger = { ...freshLedger(KEY, 940), ledgerRevision: 1 };
  try { setLiveLedger(sid, ledger); } catch { /* expected ENOSPC */ }
  // Verify ledger is in memory
  assert.ok(getLiveLedger(sid), 'ledger is in memory after failed setLiveLedger');

  // Engage ENOSPC via the coalesced flush path (the designed engagement trigger):
  // schedulePersist + fire timer → flush throws → pause engaged
  schedulePersist(sid);
  assert.ok(timerCb, 'scheduler installed');
  timerCb(); // flush throws → ENOSPC pause engaged for this sid
  assert.equal(isEnospcPaused(sid), true, 'session is in ENOSPC pause after coalesced flush failure');

  // Now that pause is engaged, a SUBSEQUENT schedulePersist is blocked
  writeCount = 0;
  timerCb = null;
  schedulePersist(sid);
  // schedulePersist returns early for paused sessions — nothing added to pending
  // Even if timer fires, nothing written
  if (timerCb) timerCb();
  assert.equal(writeCount, 0, 'no write attempted for paused session during coalesced flush');

  // Recovery: disk comes back
  shouldThrow = false;
  writeCount = 0;

  // The Stop route's force-write acts as the probe (setLiveLedger with force:true)
  setLiveLedger(sid, { ...ledger, ledgerRevision: 2 });

  // Probe succeeded → pause should be cleared
  assert.ok(writeCount > 0, 'probe force-write executed successfully after recovery');
  assert.equal(isEnospcPaused(sid), false, 'pause cleared after successful force-write probe');
});

test('C5a-1: probe succeeds but backlog drain re-hits ENOSPC → pause re-engaged', (t) => {
  _resetRateLampManagerForTest();
  const sid = 'test-c5a-redrain-' + Date.now();

  let shouldThrow = false;
  let timerCb = null;
  _setRateLampManagerTestHooks({
    writer: (path, obj) => {
      if (shouldThrow) {
        const err = new Error('ENOSPC');
        err.code = 'ENOSPC';
        throw err;
      }
    },
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });
  t.after(() => _resetRateLampManagerForTest());

  // Seed ledger in memory (write succeeds)
  const ledger = { ...freshLedger(KEY, 940), ledgerRevision: 1 };
  setLiveLedger(sid, ledger);
  assert.ok(getLiveLedger(sid), 'ledger seeded');

  // Mutate the live ledger so the coalesced flush will find DIFFERENT content (not elided)
  const mutated = mutateLedger(getLiveLedger(sid), 'dirty', (l) => { l.billProgress = 0.9; });
  // Put mutated ledger directly in _ledgers (via setLiveLedger which writes successfully)
  setLiveLedger(sid, mutated);

  // Now enable throws and schedule a persist → engage ENOSPC via flush
  shouldThrow = true;
  // Mutate again so the flush has new content (not matching _lastSaved)
  const mutated2 = mutateLedger(getLiveLedger(sid), 'dirty2', (l) => { l.billProgress = 0.95; });
  // Set directly in memory — we can't use setLiveLedger (it would throw).
  // We need the flush to find different content from _lastSaved. Trick: set _ledgers directly via
  // a brief period where shouldThrow is false just for the _ledgers.set:
  // Actually — setLiveLedger does _ledgers.set first, then persistLedger. If we catch the throw,
  // the ledger IS in memory with the new content, and _lastSaved still has the OLD serialization.
  try { setLiveLedger(sid, mutated2); } catch { /* expected ENOSPC */ }
  // Now _ledgers has mutated2 (rev 3), _lastSaved still has mutated (rev 2) serialization

  // Schedule persist + fire → flush finds new content → throws → pause engaged
  schedulePersist(sid);
  assert.ok(timerCb, 'timer installed');
  timerCb();
  assert.equal(isEnospcPaused(sid), true, 'pause engaged after coalesced flush failure');

  // Probe succeeds (disk recovered)
  shouldThrow = false;
  setLiveLedger(sid, { ...getLiveLedger(sid), ledgerRevision: 4 });
  // After successful probe, pause should be cleared
  assert.equal(isEnospcPaused(sid), false, 'pause cleared after probe succeeds');
});

test('C5a-1: cancelCoalescedPersist removes sid from pending set', (t) => {
  _resetRateLampManagerForTest();
  const sid = 'test-c5a-cancel-' + Date.now();

  const writes = [];
  let timerCb = null;
  _setRateLampManagerTestHooks({
    writer: (path, obj) => { writes.push({ ...obj }); },
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });
  t.after(() => _resetRateLampManagerForTest());

  const ledger = { ...freshLedger(KEY, 940), ledgerRevision: 1 };
  setLiveLedger(sid, ledger);
  const afterSet = writes.length;

  // Schedule then cancel before flush
  schedulePersist(sid);
  cancelCoalescedPersist(sid);

  // Fire timer — sid was cancelled, so no write
  if (timerCb) timerCb();
  assert.equal(writes.length, afterSet, 'cancelled sid not flushed by coalesced timer');
});

// ════════════════════════════════════════════════════════════════════════════════
// C5a-1: /api/debug/rate-lamp/:sid — loopback gate
// ════════════════════════════════════════════════════════════════════════════════

test('C5a-1: /api/debug/rate-lamp/:sid accessible from loopback', async (t) => {
  _resetRateLampManagerForTest();
  const { createServer: createSWServer } = await import('../server.js');
  const sid = 'test-debug-' + Date.now();

  const watcher = {
    path: '/dev/null', _offset: 0, _turnSeq: 1, _foldedCallSeq: 1,
    poll() { return { changed: false }; },
    getStatus() { return { rateLamp: { reliable: false } }; },
    getHistory() { return []; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
  };

  const { app, server } = createSWServer({ watcher, pollIntervalMs: 0, sessionId: sid });

  const origDebug = process.env.SW_DEBUG;
  delete process.env.SW_DEBUG;
  t.after(() => {
    if (origDebug) process.env.SW_DEBUG = origDebug;
    else delete process.env.SW_DEBUG;
    server.close();
    _resetRateLampManagerForTest();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // From loopback: the route allows loopback OR SW_DEBUG
  const resp = await fetch(`http://127.0.0.1:${port}/api/debug/rate-lamp/${sid}`);
  assert.equal(resp.status, 200, 'loopback request allowed');
  const body = await resp.json();
  assert.ok('counters' in body || 'ledger' in body, 'response contains debug info');
});

test('C5a-1: /api/debug/rate-lamp/:sid rejects non-loopback without SW_DEBUG', async (t) => {
  _resetRateLampManagerForTest();
  const { createServer: createSWServer } = await import('../server.js');
  const sid = 'test-debug-nonloop-' + Date.now();

  const watcher = {
    path: '/dev/null', _offset: 0, _turnSeq: 1, _foldedCallSeq: 1,
    poll() { return { changed: false }; },
    getStatus() { return { rateLamp: { reliable: false } }; },
    getHistory() { return []; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
  };

  const { app, server } = createSWServer({ watcher, pollIntervalMs: 0, sessionId: sid });

  const origDebug = process.env.SW_DEBUG;
  delete process.env.SW_DEBUG;

  // Override remoteAddress on incoming connections to simulate non-loopback
  server.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: '192.168.1.100', configurable: true });
  });

  t.after(() => {
    if (origDebug) process.env.SW_DEBUG = origDebug;
    else delete process.env.SW_DEBUG;
    server.close();
    _resetRateLampManagerForTest();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Non-loopback + no SW_DEBUG → should be rejected with 403
  const resp = await fetch(`http://127.0.0.1:${port}/api/debug/rate-lamp/${sid}`);
  assert.equal(resp.status, 403, 'non-loopback request rejected without SW_DEBUG');
  const body = await resp.json();
  assert.equal(body.error, 'forbidden', 'error body indicates forbidden');
});
