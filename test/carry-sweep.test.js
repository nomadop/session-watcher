import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, closeStore } from '../lib/store.js';
import { writeFixtureTranscriptWithFullRead } from './helpers/fold-feed.js';

// writeFixtureTranscriptWithFullRead(sessionId, absPath, opts?) — the Task 0 golden builder makes its
// OWN temp dir for the transcript (it does NOT take a target dir), so the test only needs its own `dir`
// for the store db. The transcript path it returns lives under a sibling sw-golden-* temp dir; the sweep
// just needs a readable path, so this is sufficient. (Signature reconciliation — see task-9 report.)

test('replaySessionTelemetry re-archives an occurred segment via the production boundary (cc-replay)', async () => {
  const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
  const dir = mkdtempSync(join(tmpdir(), 'sw-sweep-'));
  const store = openStore(join(dir, 't.sqlite'));
  try {
    const sid = 'crashed-1';
    const tx = writeFixtureTranscriptWithFullRead(sid, '/p/a.js');   // a real jsonl with one segment + a full read
    const res = replaySessionTelemetry(sid, tx, { store });
    assert.ok(res && res.archivedSegments >= 1, 'at least one segment archived');
    assert.ok(store._db.prepare("SELECT COUNT(*) c FROM profile_step_usage WHERE session_id=?").get(sid).c >= 1, 'step_usage written');
    assert.ok(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND path LIKE '%a.js'").get(sid).c >= 1, 'the full-read touch recovered');
    const prof = store._db.prepare("SELECT telemetry_status, capture_source FROM profile WHERE session_id=? AND segment=0").get(sid);
    assert.equal(prof.telemetry_status, 'complete');
    assert.equal(prof.capture_source, 'cc-replay', 'replay-origin stamped');
  } finally { closeStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test('replaySessionTelemetry returns null for an unreadable transcript', async () => {
  const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
  const dir = mkdtempSync(join(tmpdir(), 'sw-sweep-nf-'));
  const store = openStore(join(dir, 't.sqlite'));
  try {
    assert.equal(replaySessionTelemetry('nope', '/no/such/file.jsonl', { store }), null);
  } finally { closeStore(store); rmSync(dir, { recursive: true, force: true }); }
});

test('re-replaying a session whose segment is already complete is a no-op (skipped_stale)', async () => {
  const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
  const dir = mkdtempSync(join(tmpdir(), 'sw-sweep-idem-'));
  const store = openStore(join(dir, 't.sqlite'));
  try {
    const sid = 'crashed-2';
    const tx = writeFixtureTranscriptWithFullRead(sid, '/p/a.js');
    replaySessionTelemetry(sid, tx, { store });
    const before = store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=?").get(sid).c;
    replaySessionTelemetry(sid, tx, { store });   // second replay: archiveSegmentTelemetry sees complete → skipped_stale
    const after = store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=?").get(sid).c;
    assert.equal(after, before, 'no duplication / clobber on re-replay of an already-complete segment');
  } finally { closeStore(store); rmSync(dir, { recursive: true, force: true }); }
});
