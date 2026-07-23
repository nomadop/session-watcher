import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTelemetryPayload } from '../lib/carry-outcome.js';
import { setupStore } from './helpers/store-fixtures.js';

test('buildTelemetryPayload dedups steps by foldedSeq and assigns event ordinals per step', () => {
  const calls = [
    { foldedSeq: 5, ts: 1000, cacheRead: 4000, cacheCreation: 0, input: 100, output: 50, toolCalls: 1, loadToken: null },
    { foldedSeq: 6, ts: 1010, cacheRead: 4200, cacheCreation: 0, input: 20, output: 10, toolCalls: 2, loadToken: 'carry-lyric-gear' },
  ];
  const events = [
    { foldedSeq: 5, path: '/p/a.js', toolType: 'Read', isFullRead: 1 },
    { foldedSeq: 6, path: '/p/b.js', toolType: 'Grep', isFullRead: 0 },
    { foldedSeq: 6, path: '/p/c.js', toolType: 'Edit', isFullRead: null },
  ];
  const { steps, events: outEvents } = buildTelemetryPayload(calls, events);
  assert.equal(steps.length, 2);
  assert.equal(steps.find(s => s.foldedSeq === 6).loadToken, 'carry-lyric-gear');
  // ordinals: step 6 has two touches → ordinals 0 and 1
  const step6 = outEvents.filter(e => e.foldedSeq === 6).map(e => e.eventOrdinal).sort();
  assert.deepEqual(step6, [0, 1]);
  assert.equal(outEvents.find(e => e.foldedSeq === 5).eventOrdinal, 0);
});

test('buildTelemetryPayload keeps the max-token snapshot when a foldedSeq is revised twice', () => {
  const calls = [
    { foldedSeq: 5, ts: 1000, cacheRead: 4000, cacheCreation: 0, input: 100, output: 50, toolCalls: 1, loadToken: null },
    { foldedSeq: 5, ts: 1005, cacheRead: 4000, cacheCreation: 0, input: 100, output: 120, toolCalls: 1, loadToken: null },
  ];
  const { steps } = buildTelemetryPayload(calls, []);
  assert.equal(steps.length, 1, 'one row per foldedSeq');
  assert.equal(steps[0].output, 120, 'latest/max revision wins');
});

test('buildTelemetryPayload forward stickiness: higher-total revision inherits loadToken from prior', () => {
  const calls = [
    { foldedSeq: 3, ts: 100, cacheRead: 2000, cacheCreation: 0, input: 50, output: 30, toolCalls: 1, loadToken: 'carry-forward-token' },
    // Same seq, higher total, null loadToken → must inherit from prior
    { foldedSeq: 3, ts: 105, cacheRead: 3000, cacheCreation: 0, input: 50, output: 80, toolCalls: 1, loadToken: null },
  ];
  const { steps } = buildTelemetryPayload(calls, []);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].output, 80, 'higher-total revision wins');
  assert.equal(steps[0].loadToken, 'carry-forward-token', 'loadToken inherited forward from prior revision');
});

test('buildTelemetryPayload backward stickiness: lower-total revision donates loadToken to stored winner', () => {
  const calls = [
    // First entry wins (higher total) but has no token
    { foldedSeq: 3, ts: 100, cacheRead: 5000, cacheCreation: 0, input: 100, output: 200, toolCalls: 1, loadToken: null },
    // Second entry loses (lower total) but carries a token → patches the winner
    { foldedSeq: 3, ts: 105, cacheRead: 1000, cacheCreation: 0, input: 10, output: 5, toolCalls: 1, loadToken: 'carry-backward-token' },
  ];
  const { steps } = buildTelemetryPayload(calls, []);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].output, 200, 'higher-total revision remains the winner');
  assert.equal(steps[0].loadToken, 'carry-backward-token', 'loadToken donated backward from losing revision');
});

test('archiveSegmentTelemetry is idempotent — re-archiving replaces only that segment\'s rows', async () => {
  const { store, sessionId, teardown } = setupStore();   // temp DB + one archived profile row at segment 0, status pending
  try {
    const payload = { steps: [{ foldedSeq: 1, input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolCalls: 1, loadToken: null, ts: 1 }],
      events: [{ foldedSeq: 1, eventOrdinal: 0, path: '/p/a.js', toolType: 'Read', isFullRead: 1 }] };
    // NOTE: setupStore leaves segment 0 at telemetry_status='pending' (not complete), so the first write
    // goes through; the second re-archive sees 'complete' → skipped_stale, so it neither duplicates NOR
    // clobbers. Assert convergence via row count.
    assert.equal(store.archiveSegmentTelemetry(sessionId, 0, payload).status, 'complete');
    assert.equal(store.archiveSegmentTelemetry(sessionId, 0, payload).status, 'skipped_stale');   // already complete
    assert.equal(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND segment=0").get(sessionId).c, 1, 'no duplication; complete rows preserved');
  } finally { teardown(); }
});

test('a TXN2 insert failure leaves the profile row (TXN1) intact and marks failed_retryable', async () => {
  const { store, sessionId, teardown } = setupStore();
  try {
    const orig = store._stmts.insertStepUsage;
    store._stmts.insertStepUsage = { run() { throw new Error('injected'); } };
    const res = store.archiveSegmentTelemetry(sessionId, 0,
      { steps: [{ foldedSeq: 1, input: 1, output: 1, cacheRead: 1, cacheCreation: 0, toolCalls: 0, loadToken: null, ts: 1 }], events: [] });
    store._stmts.insertStepUsage = orig;
    assert.equal(res.status, 'failed_retryable');
    assert.ok(store._db.prepare("SELECT 1 FROM profile WHERE session_id=? AND segment=0").get(sessionId), 'profile row (TXN1) survives');
    assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=0").get(sessionId).telemetry_status, 'failed_retryable');
  } finally { teardown(); }
});

test('archiving a segment already marked complete is skipped_stale and does not clobber it', async () => {
  // The live-vs-sweep TOCTOU. Simulate a concurrent completion by marking the segment complete WITH
  // rows, then a second archival with DIFFERENT payload must refuse (skipped_stale).
  const { store, sessionId, teardown } = setupStore();
  try {
    store.archiveSegmentTelemetry(sessionId, 0, { steps: [{ foldedSeq: 1, input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolCalls: 1, loadToken: 'first', ts: 1 }],
      events: [{ foldedSeq: 1, eventOrdinal: 0, path: '/p/a.js', toolType: 'Read', isFullRead: 1 }] });
    assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=0").get(sessionId).telemetry_status, 'complete');
    const res = store.archiveSegmentTelemetry(sessionId, 0, { steps: [{ foldedSeq: 9, input: 99, output: 99, cacheRead: 99, cacheCreation: 0, toolCalls: 0, loadToken: 'second', ts: 2 }],
      events: [{ foldedSeq: 9, eventOrdinal: 0, path: '/p/z.js', toolType: 'Read', isFullRead: 1 }] });
    assert.equal(res.status, 'skipped_stale', 'in-txn re-check refused to overwrite a completed segment');
    const su = store._db.prepare("SELECT load_token FROM profile_step_usage WHERE session_id=? AND segment=0").all(sessionId);
    assert.deepEqual(su.map(r => r.load_token), ['first'], 'original telemetry intact — the stale writer did not clobber it');
  } finally { teardown(); }
});
