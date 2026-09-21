// The Store's telemetry transaction: what its status gate admits, what it refuses, and what a second
// connection racing it sees. Every fixture here is a direct Store fixture — the composed archival path is
// asserted end to end in test/segment-archive.integration.test.js, so nothing in this file drives a source.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore, closeStore } from '../lib/store.js';
import { snap, setupStore } from './helpers/store-fixtures.js';
import { createWatcherComposition } from '../server.js';
import { assistantToolUse, toolResult, ts, usage } from './helpers/transcript-fixtures.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';

const execFileAsync = promisify(execFile);

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-segtel-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ARTIFACT = (over = {}) => ({
  captureSource: 'cc-live',
  payload: {
    steps: [{ foldedSeq: 1, ts: 1, input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolCalls: 1, loadToken: null }],
    events: [{ foldedSeq: 1, eventOrdinal: 0, path: '/p/a.js', toolType: 'Read', isFullRead: 1 }],
  },
  ...over,
});

const statusOf = (store, sessionId, segment = 0) => store._db
  .prepare('SELECT telemetry_status FROM profile WHERE session_id=? AND segment=?').get(sessionId, segment).telemetry_status;
const eventCount = (store, sessionId, segment = 0) => store._db
  .prepare('SELECT COUNT(*) c FROM profile_path_event WHERE session_id=? AND segment=?').get(sessionId, segment).c;
const loadTokens = (store, sessionId, segment = 0) => store._db
  .prepare('SELECT load_token FROM profile_step_usage WHERE session_id=? AND segment=? ORDER BY folded_seq').all(sessionId, segment)
  .map(row => row.load_token);

describe('the telemetry status gate', () => {
  // The gate is what makes a lower-priority replay unable to overwrite a capture that already completed,
  // and what keeps a genuinely uncaptured segment writable.
  for (const [initial, expected] of [
    [null, 'complete'],
    ['pending', 'complete'],
    ['failed_retryable', 'complete'],
    ['complete', 'skipped_stale'],
    ['complete_empty', 'skipped_stale'],
  ]) {
    test(`an existing telemetry_status of ${initial} answers ${expected}`, () => {
      const { store, sessionId, teardown } = setupStore();
      try {
        store._db.prepare('UPDATE profile SET telemetry_status=? WHERE session_id=? AND segment=0').run(initial, sessionId);
        assert.equal(store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT()).status, expected);
      } finally { teardown(); }
    });
  }

  test('a payload with no path event completes empty', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      const result = store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT({ payload: { steps: ARTIFACT().payload.steps, events: [] } }));
      assert.equal(result.status, 'complete_empty');
      assert.equal(eventCount(store, sessionId), 0);
    } finally { teardown(); }
  });

  test('the Projection capture label is written unchanged', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT({ captureSource: 'cc-replay' }));
      assert.equal(store._db.prepare('SELECT capture_source FROM profile WHERE session_id=? AND segment=0').get(sessionId).capture_source, 'cc-replay');
    } finally { teardown(); }
  });

  test('re-archiving the same artifact converges instead of duplicating', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      assert.equal(store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT()).status, 'complete');
      assert.equal(store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT()).status, 'skipped_stale');
      assert.equal(eventCount(store, sessionId), 1, 'no duplication; the complete rows are preserved');
    } finally { teardown(); }
  });

  test('an already complete segment is not clobbered by a different payload', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT({
        payload: { steps: [{ foldedSeq: 1, ts: 1, input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolCalls: 1, loadToken: 'first' }], events: ARTIFACT().payload.events },
      }));
      assert.equal(statusOf(store, sessionId), 'complete');
      const result = store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT({
        payload: {
          steps: [{ foldedSeq: 9, ts: 2, input: 99, output: 99, cacheRead: 99, cacheCreation: 0, toolCalls: 0, loadToken: 'second' }],
          events: [{ foldedSeq: 9, eventOrdinal: 0, path: '/p/z.js', toolType: 'Read', isFullRead: 1 }],
        },
      }));
      assert.equal(result.status, 'skipped_stale', 'the in-transaction re-check refused to overwrite');
      assert.deepEqual(loadTokens(store, sessionId), ['first'], 'the original telemetry is intact');
    } finally { teardown(); }
  });

  test('an insert failure leaves the profile row intact and marks failed_retryable', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      const original = store._stmts.insertStepUsage;
      store._stmts.insertStepUsage = { run() { throw new Error('injected'); } };
      const result = store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT());
      store._stmts.insertStepUsage = original;
      assert.equal(result.status, 'failed_retryable');
      assert.ok(store._db.prepare('SELECT 1 FROM profile WHERE session_id=? AND segment=0').get(sessionId), 'the profile row survives');
      assert.equal(statusOf(store, sessionId), 'failed_retryable');
    } finally { teardown(); }
  });

  test('every archived path event has a matching step usage row in its own segment', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT({
        payload: {
          steps: [{ foldedSeq: 1, ts: 1, input: 100, output: 50, cacheRead: 4000, cacheCreation: 200, toolCalls: 2, loadToken: null }],
          events: [
            { foldedSeq: 1, eventOrdinal: 0, path: '/p/a.js', toolType: 'Read', isFullRead: 1 },
            { foldedSeq: 1, eventOrdinal: 1, path: '/p/b.js', toolType: 'Grep', isFullRead: 0 },
          ],
        },
      }));
      // Joining on segment as well as sequence also catches an event written to the WRONG segment, which
      // the per-segment delete idempotency depends on.
      const orphans = store._db.prepare(`SELECT pe.folded_seq FROM profile_path_event pe
        LEFT JOIN profile_step_usage su
          ON su.session_id = pe.session_id AND su.folded_seq = pe.folded_seq AND su.segment = pe.segment
        WHERE pe.session_id = ? AND su.folded_seq IS NULL`).all(sessionId);
      assert.equal(orphans.length, 0);
    } finally { teardown(); }
  });

  test('the four token buckets reconcile against the provider total they came from', () => {
    const { store, sessionId, teardown } = setupStore();
    try {
      store.archiveSegmentTelemetry(sessionId, 0, ARTIFACT({
        payload: {
          steps: [{ foldedSeq: 1, ts: 1, input: 100, output: 50, cacheRead: 4000, cacheCreation: 200, toolCalls: 0, loadToken: null }],
          events: [],
        },
      }));
      const row = store._db.prepare('SELECT input, cache_read, cache_creation FROM profile_step_usage WHERE session_id=?').get(sessionId);
      assert.equal(row.input + row.cache_read + row.cache_creation, 4300,
        'provider total == input + cache_read + cache_creation (billing semantics pinned)');
    } finally { teardown(); }
  });
});

describe('two connections racing the same segment', () => {
  test('a writer that waits for the lock reads the winner\'s complete status and preserves its rows', async () => {
    const dbPath = join(dir, 'race.sqlite');
    // B is this process; A is a separate one, because a connection that waits for a write lock blocks its
    // whole thread — inside one process B could never reach its COMMIT.
    //
    // The ordering is established through markers rather than timed. A's connection is opened BEFORE B takes
    // the lock, because opening one writes the journal mode and the schema and would itself block. A then
    // waits for B's `go`, announces `entering`, and reports the wall time its own archival call spent, so the
    // elapsed floor is what says the lock-wait path — this case's whole subject — is the one exercised rather
    // than an uncontended run that answered from an already-committed status.
    const HOLD_MS = 600;
    const WAITED_FLOOR_MS = 300;
    const openedMarker = join(dir, 'racer.opened');
    const goMarker = join(dir, 'racer.go');
    const enteringMarker = join(dir, 'racer.entering');
    const workerFile = join(dir, 'racer.mjs');
    writeFileSync(workerFile, `
      import { writeFileSync, existsSync } from 'node:fs';
      import { setTimeout as sleep } from 'node:timers/promises';
      import { openStore } from ${JSON.stringify(join(process.cwd(), 'lib/store.js'))};
      const store = openStore(${JSON.stringify(dbPath)});
      store._db.exec('PRAGMA busy_timeout = 20000');
      writeFileSync(${JSON.stringify(openedMarker)}, 'opened');
      const deadline = performance.now() + 30000;
      // Yielding between probes: the holder needs its interval, and a bare spin would burn a core through it.
      while (!existsSync(${JSON.stringify(goMarker)})) {
        if (performance.now() > deadline) throw new Error('the holder never signalled');
        await sleep(10);
      }
      writeFileSync(${JSON.stringify(enteringMarker)}, 'entering');
      const startedAt = performance.now();
      const result = store.archiveSegmentTelemetry('sid-race', 0, {
        captureSource: 'cc-replay',
        payload: {
          steps: [{ foldedSeq: 9, ts: 2, input: 1, output: 1, cacheRead: 1, cacheCreation: 0, toolCalls: 0, loadToken: 'loser' }],
          events: [{ foldedSeq: 9, eventOrdinal: 0, path: '/p/loser.js', toolType: 'Read', isFullRead: 1 }],
        },
      });
      process.stdout.write(JSON.stringify({ ...result, elapsedMs: performance.now() - startedAt }));
    `);
    // B's connection holds the write lock and an open transaction, and the per-case `afterEach` removes the
    // directory its database file sits in, so the close is on the failure path from the moment it is opened.
    const b = openStore(dbPath);
    try {
      b.archiveSegmentProfile('sid-race', 0, snap(), []);
      const running = execFileAsync(process.execPath, [workerFile], { timeout: 60000 });
      const awaitMarker = async (marker) => {
        while (!existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 10));
      };
      await awaitMarker(openedMarker);

      // Only now does B take the lock and write its own winning telemetry, uncommitted.
      b._db.exec('BEGIN IMMEDIATE');
      b._stmts.insertStepUsage.run('sid-race', 0, 1, 1, 100, 0, 10, 5, 1, 'winner');
      b._stmts.insertPathEvent.run('sid-race', 0, 1, 0, '/p/winner.js', '/p/winner.js', 'Read', 1);
      b._stmts.setTelemetryStatus.run('complete', 'cc-live', 'sid-race', 0);
      writeFileSync(goMarker, 'go');
      await awaitMarker(enteringMarker);
      await new Promise(resolve => setTimeout(resolve, HOLD_MS));
      b._db.exec('COMMIT');
      const { stdout } = await running;

      const answer = JSON.parse(stdout);
      assert.equal(answer.status, 'skipped_stale',
        'A read the committed complete status inside its own transaction');
      assert.ok(answer.elapsedMs >= WAITED_FLOOR_MS,
        `A's archival spanned B's hold, so it waited for the write lock rather than arriving after the commit (${answer.elapsedMs}ms)`);
      assert.deepEqual(loadTokens(b, 'sid-race'), ['winner'], 'B\'s rows are preserved');
      assert.equal(statusOf(b, 'sid-race'), 'complete');
      assert.equal(b._db.prepare("SELECT capture_source FROM profile WHERE session_id='sid-race' AND segment=0").get().capture_source, 'cc-live');
    } finally { closeStore(b); }
  });
});

// ── The startup compensating sweep coordinator ──────────────────────────────────
// The Store selects DISTINCT pending sessions and calls an INJECTED replaySession once per session, so
// store.js imports no fold, watcher or sweep module. Budget is real wall clock, chunked between sessions.

// The host's own `SessionWatcher` factory, on the project context this file's resources sit under.
// Reconstruction composes through it, so its archival path is the live owner's rather than a second table.
const sweepWatcher = ({ store, sessionId, sourceLocator }) => createWatcherComposition({
  sessionId, sourceLocator, projectId: '/p', projectRoot: '/p',
  stateDir: mkdtempSync(join(tmpdir(), 'sw-segtel-state-')), store, isIgnored: null,
});

// One minimal transcript: a cold-start step, a whole-file Read, and a second step. Written directly rather
// than through a fold harness so this file drives the Store alone.
function writeTranscript(target, absPath) {
  const numbered = Array.from({ length: 15 }, (unused, i) => `${i + 1}\texport const z = ${i};`).join('\n');
  const rows = [
    { type: 'assistant', uuid: 'g0', isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'gm0', model: 'claude-opus-4-8', usage: { cache_read_input_tokens: 10000, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'gtu0', name: 'Read', input: { file_path: absPath } }] } },
    { type: 'user', uuid: 'gu0', parentUuid: 'g0', isSidechain: false,
      message: { content: [{ type: 'tool_result', tool_use_id: 'gtu0', content: numbered }] } },
    { type: 'assistant', uuid: 'g1', parentUuid: 'gu0', isSidechain: false, timestamp: '2026-07-01T00:00:01Z',
      message: { id: 'gm1', model: 'claude-opus-4-8', usage: { cache_read_input_tokens: 15000, output_tokens: 5 }, content: [] } },
  ];
  writeFileSync(target, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return target;
}

describe('backfillPendingTelemetry', () => {
  test('a pending session is replayed through the injected callback and records replay provenance', async () => {
    const store = openStore(join(dir, 'backfill.sqlite'));
    try {
      store.archiveSegmentProfile('sid-backfill', 0, snap(), []);
      store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id='sid-backfill' AND segment=0").run();
      const txPath = writeTranscript(join(dir, 'sid-backfill.jsonl'), '/p/a.js');
      const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
      const result = await store.backfillPendingTelemetry({
        resolveTranscript: (sid) => (sid === 'sid-backfill' ? txPath : null),
        replaySession: (sid, tx) => replaySessionTelemetry(sid, tx, { store, createWatcher: sweepWatcher }),
      });
      assert.ok(result.replayed >= 1);
      assert.equal(statusOf(store, 'sid-backfill'), 'complete');
      assert.ok(eventCount(store, 'sid-backfill') >= 1);
      assert.equal(store._db.prepare("SELECT capture_source FROM profile WHERE session_id='sid-backfill' AND segment=0").get().capture_source, 'cc-replay');
    } finally { closeStore(store); }
  });

  test('a fully complete session is never resolved or replayed', async () => {
    const store = openStore(join(dir, 'complete.sqlite'));
    try {
      store.archiveSegmentProfile('sid-done', 0, snap(), []);
      store._db.prepare("UPDATE profile SET telemetry_status='complete' WHERE session_id='sid-done'").run();
      let resolved = false;
      await store.backfillPendingTelemetry({
        resolveTranscript: () => { resolved = true; return null; },
        replaySession: () => ({ archivedSegments: 0 }),
      });
      assert.equal(resolved, false);
    } finally { closeStore(store); }
  });

  test('a vanished transcript leaves the status eligible for a later retry', async () => {
    const store = openStore(join(dir, 'gone.sqlite'));
    try {
      store.archiveSegmentProfile('sid-gone', 0, snap(), []);
      store._db.prepare("UPDATE profile SET telemetry_status='failed_retryable' WHERE session_id='sid-gone'").run();
      await store.backfillPendingTelemetry({ resolveTranscript: () => null, replaySession: () => null });
      const status = statusOf(store, 'sid-gone');
      assert.ok(status === 'failed_retryable' || status === 'pending', 'still eligible, never marked complete');
    } finally { closeStore(store); }
  });

  test('a segment the replay never reaches is left pending rather than frozen complete_empty', async () => {
    const store = openStore(join(dir, 'phantom.sqlite'));
    try {
      store.archiveSegmentProfile('sid-phantom', 0, snap(), []);
      store.archiveSegmentProfile('sid-phantom', 7, snap(), []);   // a segment the transcript never had
      store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id='sid-phantom'").run();
      const txPath = writeTranscript(join(dir, 'sid-phantom.jsonl'), '/p/a.js');
      const { replaySessionTelemetry } = await import('../lib/carry-sweep.js');
      await store.backfillPendingTelemetry({
        resolveTranscript: () => txPath,
        replaySession: (sid, tx) => replaySessionTelemetry(sid, tx, { store, createWatcher: sweepWatcher }),
      });
      assert.equal(statusOf(store, 'sid-phantom', 0), 'complete');
      assert.equal(statusOf(store, 'sid-phantom', 7), 'pending',
        'a never-occurred segment needs no observed flag to stay uncaptured');
    } finally { closeStore(store); }
  });

  test('each session is replayed once regardless of how many pending segments it holds', async () => {
    const store = openStore(join(dir, 'once.sqlite'));
    try {
      store.archiveSegmentProfile('sid-once', 0, snap(), []);
      store.archiveSegmentProfile('sid-once', 1, snap(), []);
      store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id='sid-once'").run();
      let replays = 0;
      await store.backfillPendingTelemetry({
        resolveTranscript: () => '/tx.jsonl',
        replaySession: () => { replays++; return { archivedSegments: 2 }; },
      });
      assert.equal(replays, 1, 'the coordinator selects DISTINCT sessions, not rows');
    } finally { closeStore(store); }
  });

  test('a still-live session is excluded', async () => {
    const store = openStore(join(dir, 'live.sqlite'));
    try {
      store.archiveSegmentProfile('sid-live', 0, snap(), []);
      store._db.prepare("UPDATE profile SET telemetry_status='pending' WHERE session_id='sid-live'").run();
      let resolved = false;
      // A running process must never replay another process's still-growing transcript and prematurely
      // archive its tail.
      await store.backfillPendingTelemetry({
        excludeSessionIds: 'sid-live',
        resolveTranscript: () => { resolved = true; return null; },
        replaySession: () => null,
      });
      assert.equal(resolved, false);
    } finally { closeStore(store); }
  });

  test('the wall-clock budget aborts and says so rather than truncating silently', async () => {
    const store = openStore(join(dir, 'budget.sqlite'));
    try {
      for (const sid of ['sA', 'sB', 'sC']) {
        store.archiveSegmentProfile(sid, 0, snap(), []);
        store._db.prepare('UPDATE profile SET telemetry_status=? WHERE session_id=?').run('pending', sid);
      }
      const result = await store.backfillPendingTelemetry({
        resolveTranscript: () => '/tx.jsonl',
        replaySession: () => ({ archivedSegments: 0 }),
        budgetMs: 0,
      });
      assert.equal(result.aborted, true);
    } finally { closeStore(store); }
  });
});

// ── GC fallback from a persisted snapshot ─────────────────────────────────────
// When a session ages out and its Source is gone, GC cannot reconstruct it and archives from the persisted
// `profile_snapshot` instead. The value it must use is the snapshot's UNCAPPED `b_total`: the read-time cap
// belongs to the live dashboard, while persistence needs the belief its own path rows sum into — otherwise
// `dead + Σ paths` would exceed the total stored beside them. The snapshot here is produced by the real
// application rather than hand-written, so it is a real capped-vs-uncapped case and not a shaped literal.
describe('GC snapshot fallback', () => {
  test('an aged-out session with no Source archives from the snapshot using its uncapped b_total', async () => {
    const store = openStore(join(dir, 'gc-snapshot.sqlite'));
    try {
      const sessionId = 'sid-gc-snapshot';
      const projectRoot = '/repo';
      const watcher = createWatcherComposition({
        sessionId, sourceLocator: '/gone/session.jsonl', projectId: projectRoot, projectRoot,
        stateDir: mkdtempSync(join(tmpdir(), 'sw-gc-state-')), store, isIgnored: null,
      });

      // One step whose total stock is SMALL while a whole-file Read makes the belief LARGE. That is the
      // cache-warm lag: the belief legitimately leads total stock, so the live read is capped and the
      // persisted snapshot is not.
      const rows = [
        assistantToolUse({
          uuid: 'g-u1', parentUuid: null, messageId: 'g-m1', toolUseId: 'g-t1', name: 'Read',
          input: { file_path: `${projectRoot}/big.js` }, timestamp: ts(2), model: 'claude-opus-4-8',
          usage: usage({ input: 10, output: 5, cacheRead: 900, cacheWrite: 0 }),
        }),
        toolResult({
          uuid: 'g-r1', parentUuid: 'g-u1', toolUseId: 'g-t1',
          content: Array.from({ length: 400 }, (unused, i) => `${i + 1}\tconst big${i} = ${i};`).join('\n'),
        }),
      ];
      const observations = reduceClaudeCodeSnapshot(
        readClaudeCodeRows(Buffer.from(rows.map(r => JSON.stringify(r) + '\n').join('')), { atEof: true }).rows,
      ).observations;
      watcher.applyHarnessFrame({
        transition: 'replace', sourceLocator: '/gone/session.jsonl', batches: [observations],
        sourceObserved: true, captureMode: 'replay',
      });

      const snap = watcher.getTerminalSnapshot();
      const live = watcher.getStatus();
      assert.ok(snap.b_total > live.B,
        `precondition: the snapshot's b_total is UNCAPPED and the live read is capped (${snap.b_total} vs ${live.B})`);
      assert.ok(snap.paths.length >= 1, 'precondition: the snapshot carries its own path rows');
      const pathSum = snap.paths.reduce((n, row) => n + row.tokens, 0);

      // Persist it exactly as host wiring does — unchanged, no DTO.
      store.saveBatch(sessionId, [['profile_snapshot', snap]], { model: snap.model });
      // Age the session past the cutoff so the sweep selects it.
      store._db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(1000, sessionId);

      // The Source is unavailable, so GC takes the snapshot path rather than reconstruction.
      let replayCalled = false;
      const swept = store.sweep(1000, {
        now: 10_000_000,
        resolveTranscriptPath: () => null,
        replaySession: () => { replayCalled = true; return true; },
      });
      assert.equal(replayCalled, false, 'no Source, so nothing was reconstructed');
      assert.equal(swept, 1, 'the aged-out session was archived and removed');

      const archived = store._db
        .prepare('SELECT archive_source, b_total, g_final, l_peak, c_ratio, turns, mf, br_exit, model FROM profile WHERE session_id = ?')
        .get(sessionId);
      assert.ok(archived, 'a profile row was archived from the snapshot');
      assert.equal(archived.archive_source, 'snapshot');
      assert.equal(archived.b_total, snap.b_total, 'the UNCAPPED b_total is what persisted');
      assert.notEqual(archived.b_total, live.B, 'and not the read-time capped value');
      // A NON-FINITE snapshot value cannot round-trip through a SQLite REAL column: it lands as NULL. That is
      // the storage's own behaviour and it is asserted rather than smoothed over, so a field that starts
      // arriving finite (or stops) is still visible here.
      const stored = (value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value);
      for (const field of ['g_final', 'l_peak', 'c_ratio', 'turns', 'mf', 'br_exit']) {
        const snapKey = field;
        assert.equal(archived[field], stored(snap[snapKey]), `${field} came from the snapshot`);
      }
      assert.equal(archived.model, snap.model);
      assert.equal(Number.isFinite(snap.br_exit), false,
        'this fixture\'s br is non-finite before the baseline is valid, which is why br_exit stores as NULL');

      // `dead + Σ paths` is exactly the stored total, which is the invariant the uncapped value exists for.
      const deadFloor = snap.b_total - pathSum;
      assert.ok(deadFloor >= 0, 'the belief floor is non-negative');
      assert.equal(deadFloor + pathSum, archived.b_total,
        'the stored total is the sum its own path rows add up to');
    } finally { closeStore(store); }
  });
});
