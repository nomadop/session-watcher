import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal, getStore } from '../lib/store.js';
import {
  makeWatcher, feedSegmentWithTouches, feedSegmentNoTouches, feedSegmentWithKnownUsage,
  forceSegmentBoundary, writeFixtureTranscriptWithFullRead,
} from './helpers/fold-feed.js';
import { snap } from './helpers/store-fixtures.js';
import { handleSegmentBoundary } from '../lib/fold.js';

// End-to-end wiring: drive the REAL fold pipeline (append JSONL + poll) through a segment boundary and
// assert the telemetry tables + telemetry_status the archival wiring (TXN2) produced. The store is the
// GLOBAL singleton because lib/fold.js handleSegmentBoundary archives via getStore() — so `store` here
// must be the same instance the fold path writes to, and store._db reads reflect the wired-in writes.

let _dir;
let _n = 0;

function setup() {
  const sessionId = `sid-telemetry-${++_n}`;
  const w = makeWatcher({ sessionId });   // wired: feed* also sets w._sessionId
  const store = getStore();               // global singleton (initStore in beforeEach)
  return { w, store, sessionId };
}

beforeEach(() => {
  _dir = mkdtempSync(join(tmpdir(), 'sw-segtel-'));
  initStore(join(_dir, 't.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(_dir, { recursive: true, force: true });
});

test('segment archival writes step_usage + path_event rows for the segment and marks complete', async () => {
  const { w, store, sessionId } = setup();
  feedSegmentWithTouches(w, sessionId, [{ path: '/p/a.js', full: true }, { path: '/p/b.js', full: false }]);
  forceSegmentBoundary(w);   // archiveCurrentSegment or a compact boundary
  const seg = 0;
  const steps = store._db.prepare("SELECT * FROM profile_step_usage WHERE session_id=? AND segment=?").all(sessionId, seg);
  assert.ok(steps.length >= 1);
  const events = store._db.prepare("SELECT * FROM profile_path_event WHERE session_id=? AND segment=? ORDER BY folded_seq, event_ordinal").all(sessionId, seg);
  assert.equal(events.length, 2);
  assert.equal(events.find(e => e.path.endsWith('a.js')).is_full_read, 1);
  assert.equal(events.find(e => e.path.endsWith('b.js')).is_full_read, 0);
  const prof = store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=?").get(sessionId, seg);
  assert.equal(prof.telemetry_status, 'complete');
});

test('a zero-touch segment is complete_empty with no path_event rows', async () => {
  const { w, store, sessionId } = setup();
  feedSegmentNoTouches(w, sessionId);   // steps only, no file reads
  forceSegmentBoundary(w);
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=?").get(sessionId).c, 0);
  assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=0").get(sessionId).telemetry_status, 'complete_empty');
});

test('PROFILE-D1: empty segment (no API calls at all) skips archival entirely', async () => {
  const { w, store, sessionId } = setup();
  // Force a boundary without feeding any assistant steps — simulates a compact/stock-drop
  // boundary that fires before the watcher has seen its first API call.
  forceSegmentBoundary(w);
  const prof = store._db.prepare("SELECT COUNT(*) c FROM profile WHERE session_id=?").get(sessionId);
  assert.equal(prof.c, 0, 'no profile row written for empty segment');
  // Segment still advances (reset happened)
  assert.equal(w._segment, 1);
});

test('multi-segment: archiving segment 0 then 1 accumulates each segment\'s own rows', async () => {
  const { w, store, sessionId } = setup();
  feedSegmentWithTouches(w, sessionId, [{ path: '/p/a.js', full: true }]);
  forceSegmentBoundary(w);   // segment 0 archived, segment→1
  feedSegmentWithTouches(w, sessionId, [{ path: '/p/b.js', full: true }]);
  forceSegmentBoundary(w);   // segment 1 archived
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND segment=0").get(sessionId).c, 1);
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND segment=1").get(sessionId).c, 1);
});

// (The direct store-method idempotency + split-txn tests live in Task 7, alongside
//  archiveSegmentTelemetry. This file keeps only the end-to-end fold→archival wiring tests.)

test('FK invariant: every path_event (session,segment,folded_seq) has a matching step_usage row', async () => {
  const { w, store, sessionId } = setup();
  feedSegmentWithTouches(w, sessionId, [{ path: '/p/a.js', full: true }, { path: '/p/b.js', full: false }]);
  forceSegmentBoundary(w);
  // Join on segment too: a step_usage row is (session, folded_seq)-keyed, but including segment in the
  // join also catches an event mis-written to the WRONG segment (which would break the per-segment
  // DELETE idempotency), not just an orphan seq.
  const orphans = store._db.prepare(`SELECT pe.folded_seq FROM profile_path_event pe
    LEFT JOIN profile_step_usage su
      ON su.session_id = pe.session_id AND su.folded_seq = pe.folded_seq AND su.segment = pe.segment
    WHERE pe.session_id = ? AND su.folded_seq IS NULL`).all(sessionId);
  assert.equal(orphans.length, 0, 'no orphan / segment-mislabeled path events');
});

test('input reconciliation: provider_total EXACTLY equals input + cache_read + cache_creation', async () => {
  const { w, store, sessionId } = setup();
  // Feed KNOWN token values so the assertion actually reconciles, not just checks non-negativity.
  feedSegmentWithKnownUsage(w, sessionId, { input: 100, cacheRead: 4000, cacheCreation: 200, output: 50, providerTotal: 4300 });
  forceSegmentBoundary(w);
  const steps = store._db.prepare("SELECT input, cache_read, cache_creation FROM profile_step_usage WHERE session_id=? AND input IS NOT NULL").all(sessionId);
  assert.ok(steps.length >= 1);
  for (const s of steps) {
    assert.equal(s.input + s.cache_read + s.cache_creation, 4300,
      'provider_total == input + cache_read + cache_creation (billing semantics pinned; catches a usage-schema drift)');
  }
});

test('already_archived + complete does NOT overwrite good telemetry with empty buffers', async () => {
  // The guard must be exercised by the REAL boundary path, not simulated. Build a watcher whose
  // segment 0 already has complete telemetry in the DB, then drive a boundary whose in-memory buffers
  // are EMPTY (as a lower-priority replay would be) and assert TXN2 was skipped.
  const { w, store, sessionId } = setup();
  // Pre-seed segment 0 as archived + complete with one real touch (as if a prior live capture wrote it).
  store.archiveSegmentProfile(sessionId, 0, snap({ priority: 3 }), []);
  store.archiveSegmentTelemetry(sessionId, 0, {
    steps: [{ foldedSeq: 1, input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolCalls: 1, loadToken: null, ts: 1 }],
    events: [{ foldedSeq: 1, eventOrdinal: 0, path: '/p/a.js', toolType: 'Read', isFullRead: 1 }] }, 'cc-live');
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND segment=0").get(sessionId).c, 1);
  // Now drive the REAL boundary for segment 0 with EMPTY buffers (w._segmentPathEvents/[]StepUsage empty),
  // as a lower-priority replay boundary would. archiveSegmentProfile returns already_archived; the
  // guard reads telemetry_status='complete' → must NOT call archiveSegmentTelemetry.
  w._sessionId = sessionId; w._segment = 0; w._lastArchivedSegment = -1;
  w._segmentStepUsage = []; w._segmentPathEvents = [];
  handleSegmentBoundary(w, { replayMode: true });   // the actual wiring under test
  assert.equal(store.getTelemetryStatus(sessionId, 0), 'complete', 'status stays complete');
  assert.equal(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND segment=0").get(sessionId).c, 1,
    'the real boundary path SKIPPED TXN2 on already_archived+complete — good telemetry not clobbered by empty buffers');
});

// ── Task 10: startup compensating sweep (backfillPendingTelemetry) ──────────────
// The store-side coordinator selects DISTINCT pending sessions and calls an INJECTED replaySession
// callback ONCE per session (store.js never imports fold/watcher/carry-sweep). Budget is REAL wall-clock
// (performance.now()), chunked (await setImmediate between sessions), per-session try/catch, aborted flag.

test('backfillPendingTelemetry replays a pending session via the injected replaySession (real, cc-replay)', async () => {
  const { store, sessionId } = setup();
  store.archiveSegmentProfile(sessionId, 0, snap(), []);
  store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id=? AND segment=0").run(sessionId);
  const txPath = writeFixtureTranscriptWithFullRead(sessionId, '/p/a.js');   // helper writes a real jsonl file
  // Inject the REAL production-replay helper (store.js does NOT import it). It archives via
  // handleSegmentBoundary/TXN2 into `store`.
  const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
  const res = await store.backfillPendingTelemetry({
    resolveTranscript: (sid) => sid === sessionId ? txPath : null,
    replaySession: (sid, tx) => replaySessionTelemetry(sid, tx, { store }),
  });
  assert.ok(res.replayed >= 1);
  assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=0").get(sessionId).telemetry_status, 'complete');
  assert.ok(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=?").get(sessionId).c >= 1);
  assert.equal(store._db.prepare("SELECT capture_source FROM profile WHERE session_id=? AND segment=0").get(sessionId).capture_source, 'cc-replay');
});

test('backfill skips a session with no pending segments (never resolves/replays it)', async () => {
  const { store, sessionId } = setup();
  store.archiveSegmentProfile(sessionId, 0, snap(), []);
  store._db.prepare("UPDATE profile SET telemetry_status='complete' WHERE session_id=? AND segment=0").run(sessionId);
  let called = false;
  await store.backfillPendingTelemetry({ resolveTranscript: () => { called = true; return null; }, replaySession: () => ({ archivedSegments: 0 }) });
  assert.equal(called, false, 'a fully-complete session is not resolved/replayed');
});

test('backfill leaves status pending when the transcript is gone (eligible for later retry)', async () => {
  const { store, sessionId } = setup();
  store.archiveSegmentProfile(sessionId, 0, snap(), []);
  store._db.prepare("UPDATE profile SET telemetry_status='failed_retryable' WHERE session_id=? AND segment=0").run(sessionId);
  await store.backfillPendingTelemetry({ resolveTranscript: () => null, replaySession: () => null });
  const st = store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=0").get(sessionId).telemetry_status;
  assert.ok(st === 'failed_retryable' || st === 'pending', 'still eligible, not marked complete');
});

test('backfill does NOT mark a never-occurred segment as complete', async () => {
  const { store, sessionId } = setup();
  store.archiveSegmentProfile(sessionId, 0, snap(), []);   // segment 0 exists in profile…
  store.archiveSegmentProfile(sessionId, 7, snap(), []);   // …and a phantom segment 7 that the transcript never had
  store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id=?").run(sessionId);
  const txPath = writeFixtureTranscriptWithFullRead(sessionId, '/p/a.js');   // only produces segment 0
  const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
  await store.backfillPendingTelemetry({
    resolveTranscript: () => txPath,
    replaySession: (sid, tx) => replaySessionTelemetry(sid, tx, { store }),
  });
  // Segment 0 occurred in the replay → complete. Segment 7 never boundaried → NEVER written → still pending.
  assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=0").get(sessionId).telemetry_status, 'complete');
  assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id=? AND segment=7").get(sessionId).telemetry_status, 'pending',
    'a segment the replay never reached is left pending, never frozen complete_empty (no observed flag needed)');
});

test('backfill replays each session ONCE regardless of how many pending segments it has', async () => {
  const { store, sessionId } = setup();
  store.archiveSegmentProfile(sessionId, 0, snap(), []);
  store.archiveSegmentProfile(sessionId, 1, snap(), []);
  store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id=?").run(sessionId);
  let replays = 0;
  await store.backfillPendingTelemetry({
    resolveTranscript: () => '/tx.jsonl',
    // replaySession is called ONCE per session (the store selects DISTINCT sessions, not (session,segment) rows).
    replaySession: () => { replays++; return { archivedSegments: 2 }; },
  });
  assert.equal(replays, 1, 'one replay covered the whole session (both pending segments)');
});

test('backfill excludes the still-live session(s) (REQUIRED — see the reliability assumption)', async () => {
  const { store, sessionId } = setup();
  store.archiveSegmentProfile(sessionId, 0, snap(), []);
  store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id=?").run(sessionId);
  let resolved = false;
  // excludeSessionIds accepts a single id or a Set. A running process must never replay another
  // process's STILL-LIVE session (its transcript is still growing) and prematurely archive its tail.
  await store.backfillPendingTelemetry({ excludeSessionIds: sessionId, resolveTranscript: () => { resolved = true; return null; }, replaySession: () => null });
  assert.equal(resolved, false, 'the live session is skipped');
});

test('backfill honors the wall-clock budget and reports aborted without silently truncating', async () => {
  const { store } = setup();
  // Seed several distinct pending sessions so the budget can bite between them.
  for (const sid of ['sA', 'sB', 'sC']) {
    store.archiveSegmentProfile(sid, 0, snap(), []);
    store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id=?").run(sid);
  }
  // budgetMs=0 → the deadline is already reached on the first iteration; the batch aborts immediately.
  const res = await store.backfillPendingTelemetry({
    resolveTranscript: () => '/tx.jsonl',
    replaySession: () => ({ archivedSegments: 0 }),
    budgetMs: 0,
  });
  assert.equal(res.aborted, true, 'a zero budget aborts and SAYS so (no silent truncation)');
});
