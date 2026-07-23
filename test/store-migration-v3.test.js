import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

let dir, dbPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-mig3-')); dbPath = join(dir, 't.sqlite'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Seed a v2 DB (schema_version=2, segment PK profile, handoff table without v3 columns).
function seedV2(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT, project_id TEXT) WITHOUT ROWID`);
  db.exec(`CREATE TABLE state (session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, key)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  db.exec(`CREATE TABLE lines (session_id TEXT NOT NULL, path TEXT NOT NULL, line_num INTEGER NOT NULL, chars INTEGER NOT NULL, PRIMARY KEY (session_id, path, line_num)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE paths (session_id TEXT NOT NULL, path TEXT NOT NULL, edit_delta INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile (session_id TEXT NOT NULL, segment INTEGER NOT NULL DEFAULT 0, archived_at INTEGER NOT NULL, model TEXT, project_id TEXT, l_floor REAL, b_total REAL, l_peak REAL, g_final REAL, o_avg REAL, c_ratio REAL, turns INTEGER, duration_ms INTEGER, total_tokens_read REAL, mf REAL, pp_exit REAL, br_exit REAL, br_peak REAL, pp_peak REAL, p0 REAL, b_axis REAL, x_axis REAL, g_min REAL, turn_at_br_amber INTEGER, archive_source TEXT, archive_priority INTEGER, PRIMARY KEY (session_id, segment)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile_paths (session_id TEXT NOT NULL, segment INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL, tokens REAL NOT NULL, PRIMARY KEY (session_id, segment, path)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE handoff (handoff_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, segment INTEGER NOT NULL, load_token TEXT NOT NULL, created_at INTEGER NOT NULL, paths_to_keep TEXT NOT NULL, summary TEXT NOT NULL, next_task TEXT, summary_tokens INTEGER NOT NULL, kept_tokens REAL, discarded_tokens REAL, prepared_at_turn INTEGER, previous_stats TEXT, prepared_stats TEXT, search_terms TEXT, project_id TEXT, delivered_at INTEGER, delivered_segment INTEGER)`);
  db.exec(`CREATE UNIQUE INDEX idx_handoff_token ON handoff(load_token)`);
  db.prepare("INSERT INTO meta VALUES ('schema_version','2')").run();
  db.prepare(`INSERT INTO handoff (session_id, segment, load_token, created_at, paths_to_keep, summary, summary_tokens) VALUES ('s1',0,'tok-old-alpha',100,'[]','sum',3)`).run();
  db.prepare(`INSERT INTO profile (session_id, segment, archived_at, archive_source, archive_priority) VALUES ('s1',0,111,'live',2)`).run();
  db.close();
}

test('v3 migration: adds handoff columns, profile.telemetry_status, new tables + indexes, bumps version', async () => {
  seedV2(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  const hcols = store._db.prepare("PRAGMA table_info(handoff)").all().map(c => c.name);
  assert.ok(hcols.includes('delivered_session_id'));
  assert.ok(hcols.includes('loader_version'));
  assert.ok(hcols.includes('bucket_snapshot'));
  const pcols = store._db.prepare("PRAGMA table_info(profile)").all().map(c => c.name);
  assert.ok(pcols.includes('telemetry_status'));
  assert.ok(pcols.includes('capture_source'), 'provenance column present');
  for (const t of ['handoff_load', 'profile_path_event', 'profile_step_usage']) {
    assert.ok(store._db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t), `table ${t} exists`);
  }
  // handoff_load carries the consumer's segment.
  assert.ok(store._db.prepare("PRAGMA table_info(handoff_load)").all().map(c => c.name).includes('consumer_segment'), 'handoff_load.consumer_segment present');
  // segment is part of the telemetry PKs so a SAME-segment duplicate fails a plain INSERT (loud →
  // failed_retryable) instead of INSERT OR REPLACE silently overwriting. (This does NOT enforce global
  // foldedSeq uniqueness across segments — that is a fold-code invariant, not a PK guarantee.)
  const suPk = store._db.prepare("PRAGMA table_info(profile_step_usage)").all().filter(c => c.pk > 0).map(c => c.name);
  assert.ok(suPk.includes('segment') && suPk.includes('folded_seq'), 'profile_step_usage PK includes segment + folded_seq');
  const pePk = store._db.prepare("PRAGMA table_info(profile_path_event)").all().filter(c => c.pk > 0).map(c => c.name);
  assert.ok(pePk.includes('segment') && pePk.includes('folded_seq') && pePk.includes('event_ordinal'), 'profile_path_event PK includes segment');
  for (const i of ['idx_handoff_delivered_session', 'idx_handoff_load_session', 'idx_profile_telemetry', 'idx_step_usage_load_token']) {
    assert.ok(store._db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(i), `index ${i} exists`);
  }
  assert.equal(store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '3');
  assert.equal(store._db.prepare("SELECT load_token FROM handoff WHERE session_id='s1'").get().load_token, 'tok-old-alpha', 'existing rows preserved');
  closeStore(store);
});

test('v3 migration is idempotent — reopen does not error or lose data', async () => {
  seedV2(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  let store = openStore(dbPath); closeStore(store);
  store = openStore(dbPath);
  assert.equal(store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '3');
  closeStore(store);
});

test('ensureV3Shape recreates a dropped telemetry table AND invalidates stale complete status', async () => {
  // A dropped-then-recreated telemetry table loses its event rows, but the profile rows keep
  // telemetry_status='complete' — so the sweep (guarded by that flag) would skip them forever =
  // silent permanent data loss. Recreating the table MUST reset affected statuses.
  seedV2(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  let store = openStore(dbPath);
  // Mark the seeded segment complete, as if its telemetry had been captured.
  store._db.prepare("UPDATE profile SET telemetry_status='complete' WHERE session_id='s1' AND segment=0").run();
  store._db.exec('DROP TABLE profile_step_usage');
  closeStore(store);
  store = openStore(dbPath);
  assert.ok(store._db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_step_usage'").get(), 'recreated by ensureV3Shape');
  const st = store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id='s1' AND segment=0").get().telemetry_status;
  assert.equal(st, 'pending', 'a complete segment whose telemetry table was wiped is reset to pending for the sweep');
  closeStore(store);
});

test('ensureV3Shape does NOT reset status when tables are already present (no false invalidation)', async () => {
  seedV2(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  let store = openStore(dbPath);
  store._db.prepare("UPDATE profile SET telemetry_status='complete' WHERE session_id='s1' AND segment=0").run();
  closeStore(store);
  store = openStore(dbPath);   // reopen — tables were never missing
  assert.equal(store._db.prepare("SELECT telemetry_status FROM profile WHERE session_id='s1' AND segment=0").get().telemetry_status, 'complete', 'ordinary reopen must not disturb complete status');
  closeStore(store);
});

test('ensureV3Shape self-heals a single missing handoff column (per-column PRAGMA check)', async () => {
  // Half-migrated v3: has version 3 + some columns but one ALTER never applied.
  seedV2(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("ALTER TABLE handoff ADD COLUMN delivered_session_id TEXT");  // only 1 of 3 applied
  db.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run();
  db.close();
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  const hcols = store._db.prepare("PRAGMA table_info(handoff)").all().map(c => c.name);
  assert.ok(hcols.includes('loader_version'), 'ensureV3Shape backfills the missing column');
  assert.ok(hcols.includes('bucket_snapshot'));
  closeStore(store);
});

test('fresh DB ends at v3 with all telemetry shape present', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  assert.equal(store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '3');
  assert.ok(store._db.prepare("PRAGMA table_info(profile)").all().map(c => c.name).includes('telemetry_status'));
  assert.ok(store._db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff_load'").get());
  closeStore(store);
});
