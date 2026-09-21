// Carry reconstruction: rebuild a crashed session's segments from its Source, through the HOST's own
// `SessionWatcher` factory and a source driver in Source Reconstruction mode.
//
// The composition callback is what makes this the live owner's archival path rather than a second one, so
// every test here supplies the real factory. Nothing feeds a watcher through a private seam: the transcript
// on disk is the only input, which is also what makes "repeated reconstruction is idempotent" assertable
// against database results rather than against a call count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, closeStore } from '../lib/store.js';
import { replaySessionTelemetry } from '../lib/carry-sweep.js';
import { createWatcherComposition } from '../server.js';
import {
  assistantToolUse, compactSummary, toolResult, ts, usage,
} from './helpers/transcript-fixtures.js';

const PROJECT = '/p';

// The host's own composition callback, on the project context this fixture's resources sit under.
const createWatcher = ({ store, sessionId, sourceLocator }) => createWatcherComposition({
  sessionId, sourceLocator, projectId: PROJECT, projectRoot: PROJECT,
  stateDir: mkdtempSync(join(tmpdir(), 'sw-sweep-state-')), store, isIgnored: null,
});

const numbered = (lines) => Array.from({ length: lines }, (unused, i) => `${i + 1}\tconst v${i} = ${i};`).join('\n');

// One measured step whose tool use is a full Read of `absPath`, chained onto `parent`.
const readStep = ({ id, uuid, parent, absPath, cacheRead }) => [
  assistantToolUse({
    uuid, parentUuid: parent, messageId: id, toolUseId: `t-${id}`, name: 'Read',
    input: { file_path: absPath }, timestamp: ts(2), model: 'claude-opus-4-8',
    usage: usage({ input: 100, output: 10, cacheRead, cacheWrite: 2000 }),
  }),
  toolResult({ uuid: `r-${id}`, parentUuid: uuid, toolUseId: `t-${id}`, content: numbered(12) }),
];

function writeSource(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-sweep-src-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join(''));
  return path;
}

// A Source with NO terminal epoch: it just stops mid-segment, which is what a crashed owner leaves behind.
const noTerminalEpoch = (absPath) => [
  ...readStep({ id: 'm1', uuid: 'u1', parent: null, absPath, cacheRead: 100000 }),
  ...readStep({ id: 'm2', uuid: 'u2', parent: 'r-m1', absPath, cacheRead: 102000 }),
];

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-sweep-'));
  const store = openStore(join(dir, 't.sqlite'));
  try { return fn(store); }
  finally { closeStore(store); rmSync(dir, { recursive: true, force: true }); }
}

test('a Source with no terminal epoch archives its final segment as a replay', () => {
  withStore((store) => {
    const sid = 'crashed-1';
    const tx = writeSource(noTerminalEpoch(join(PROJECT, 'a.js')));
    assert.equal(replaySessionTelemetry(sid, tx, { store, createWatcher }), true);

    const profile = store._db
      .prepare('SELECT archive_source, capture_source, telemetry_status, archived_at FROM profile WHERE session_id=? AND segment=0')
      .get(sid);
    assert.equal(profile.archive_source, 'replay', 'reconstruction is not a live capture');
    assert.equal(profile.capture_source, 'cc-replay', 'and its telemetry says so too');
    assert.equal(profile.telemetry_status, 'complete');
    // The archive time is the last valid closed-step timestamp the Source carries, not this process's clock.
    assert.equal(profile.archived_at, Date.parse(ts(2)),
      'a reconstructed segment is stamped from the Source, so a later sweep does not re-date history');

    assert.ok(store._db.prepare('SELECT COUNT(*) c FROM profile_step_usage WHERE session_id=?').get(sid).c >= 1,
      'step usage written');
    assert.ok(store._db.prepare("SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND path LIKE '%a.js'").get(sid).c >= 1,
      'the full-read touch was recovered');
  });
});

test('a readable Source with no archivable segment returns true', () => {
  withStore((store) => {
    // Readable and empty: reconstruction COMPLETED, it just had nothing to archive. That is a success, and
    // reporting it as unavailability would leave the session pending for a sweep that can never fix it.
    const tx = writeSource([]);
    assert.equal(replaySessionTelemetry('empty-1', tx, { store, createWatcher }), true);
    assert.equal(store.getProfileSegments('empty-1').length, 0, 'and nothing was archived');
  });
});

test('an unavailable Source returns null', () => {
  withStore((store) => {
    assert.equal(replaySessionTelemetry('nope', '/no/such/file.jsonl', { store, createWatcher }), null);
  });
});

test('a readable Source holding only an incomplete row reconstructs completely and returns true', () => {
  withStore((store) => {
    // Nonzero size, but the single row has no terminating newline, so nothing commits. The driver's first
    // readable advance still reports its configured transition, so reconstruction COMPLETED — it just had
    // nothing to archive. Calling that unavailable would leave the session pending for a sweep that could
    // never fix it.
    const dirPath = mkdtempSync(join(tmpdir(), 'sw-sweep-partial-'));
    const path = join(dirPath, 'session.jsonl');
    const row = JSON.stringify(readStep({ id: 'p1', uuid: 'u1', parent: null, absPath: join(PROJECT, 'a.js'), cacheRead: 100000 })[0]);
    writeFileSync(path, row.slice(0, Math.floor(row.length / 2)));
    assert.ok(statSync(path).size > 0, 'precondition: the Source is not empty');
    assert.equal(replaySessionTelemetry('partial-1', path, { store, createWatcher }), true);
    assert.equal(store.getProfileSegments('partial-1').length, 0, 'and nothing was archived');
  });
});

test('a MISSING host composition callback throws rather than reporting the Source unavailable', () => {
  withStore((store) => {
    const tx = writeSource(noTerminalEpoch(join(PROJECT, 'a.js')));
    // A wiring fault is not a property of the transcript. Answering `null` here would make a permanent host
    // bug indistinguishable from an unreadable file, and the session would stay pending forever.
    assert.throws(() => replaySessionTelemetry('nocb-1', tx, { store }), /createWatcher/);
    // The same Source reconstructs cleanly once the callback IS supplied, which shows the Source was fine.
    assert.equal(replaySessionTelemetry('nocb-1', tx, { store, createWatcher }), true);
  });
});

test('an application failure terminates reconstruction without closing the incomplete segment', () => {
  withStore((store) => {
    const sid = 'failing-1';
    const absPath = join(PROJECT, 'a.js');
    const tx = writeSource(noTerminalEpoch(absPath));
    // A composition whose application throws part-way. The close that would freeze the segment sits AFTER
    // every advance and application, so a failure before it must leave the open segment unarchived.
    const failing = (args) => {
      const watcher = createWatcher(args);
      return {
        applyHarnessFrame: () => { throw new Error('projection invariant'); },
        closeCurrentSegment: (...rest) => watcher.closeCurrentSegment(...rest),
      };
    };
    assert.throws(() => replaySessionTelemetry(sid, tx, { store, createWatcher: failing }),
      /projection invariant/, 'the error propagates into the Store per-session isolation');
    assert.equal(store.getProfileSegments(sid).length, 0, 'the incomplete segment was never closed');
  });
});

test('a reconstruction failure leaves pending persistence eligible for retry', () => {
  withStore((store) => {
    const sid = 'retry-1';
    const absPath = join(PROJECT, 'a.js');
    const tx = writeSource(noTerminalEpoch(absPath));
    const failing = (args) => {
      const watcher = createWatcher(args);
      return {
        applyHarnessFrame: () => { throw new Error('transient'); },
        closeCurrentSegment: (...rest) => watcher.closeCurrentSegment(...rest),
      };
    };
    assert.throws(() => replaySessionTelemetry(sid, tx, { store, createWatcher: failing }));
    // The SAME Source reconstructs cleanly on the retry: the failure cost nothing durable.
    assert.equal(replaySessionTelemetry(sid, tx, { store, createWatcher }), true);
    assert.equal(store.getProfileSegments(sid).length, 1, 'the retry archived what the failure did not');
  });
});

test('repeated reconstruction is idempotent through database results', () => {
  withStore((store) => {
    const sid = 'crashed-2';
    const absPath = join(PROJECT, 'a.js');
    const tx = writeSource(noTerminalEpoch(absPath));
    assert.equal(replaySessionTelemetry(sid, tx, { store, createWatcher }), true);
    const before = {
      profiles: store.getProfileSegments(sid).length,
      steps: store._db.prepare('SELECT COUNT(*) c FROM profile_step_usage WHERE session_id=?').get(sid).c,
      events: store._db.prepare('SELECT COUNT(*) c FROM profile_path_event WHERE session_id=?').get(sid).c,
    };
    // A second pass over the same Source: the in-transaction status guard makes an already-complete segment
    // a no-op, so nothing duplicates and nothing is clobbered.
    assert.equal(replaySessionTelemetry(sid, tx, { store, createWatcher }), true);
    assert.deepEqual({
      profiles: store.getProfileSegments(sid).length,
      steps: store._db.prepare('SELECT COUNT(*) c FROM profile_step_usage WHERE session_id=?').get(sid).c,
      events: store._db.prepare('SELECT COUNT(*) c FROM profile_path_event WHERE session_id=?').get(sid).c,
    }, before);
  });
});

test('an epoch inside the Source archives with the same replay provenance as the terminal segment', () => {
  withStore((store) => {
    const sid = 'crashed-3';
    const absPath = join(PROJECT, 'a.js');
    // A compact summary is a null-parent root with a call behind it, so it closes segment 0 and opens 1. Both
    // reach the shared archival path, and NEITHER is a synthetic epoch the close invented.
    const tx = writeSource([
      ...readStep({ id: 'm1', uuid: 'u1', parent: null, absPath, cacheRead: 100000 }),
      compactSummary({ uuid: 'c1', timestamp: ts(3), text: 'summary' }),
      ...readStep({ id: 'm3', uuid: 'u3', parent: 'c1', absPath, cacheRead: 3000 }),
    ]);
    assert.equal(replaySessionTelemetry(sid, tx, { store, createWatcher }), true);
    // `node:sqlite` hands back null-prototype rows, so they are spread into plain objects before comparison.
    const rows = store._db
      .prepare('SELECT segment, archive_source, capture_source FROM profile WHERE session_id=? ORDER BY segment')
      .all(sid).map(row => ({ ...row }));
    assert.deepEqual(rows, [
      { segment: 0, archive_source: 'replay', capture_source: 'cc-replay' },
      { segment: 1, archive_source: 'replay', capture_source: 'cc-replay' },
    ]);
  });
});
