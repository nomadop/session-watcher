import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

let dir, dbPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-mig4-')); dbPath = join(dir, 't.sqlite'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Seed a full v3 DB (schema_version=3, all v3 tables present, with a seeded handoff row).
function seedV3(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT, project_id TEXT) WITHOUT ROWID`);
  db.exec(`CREATE TABLE state (session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, key)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  db.exec(`CREATE TABLE lines (session_id TEXT NOT NULL, path TEXT NOT NULL, line_num INTEGER NOT NULL, chars INTEGER NOT NULL, PRIMARY KEY (session_id, path, line_num)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE paths (session_id TEXT NOT NULL, path TEXT NOT NULL, edit_delta INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile (session_id TEXT NOT NULL, segment INTEGER NOT NULL DEFAULT 0, archived_at INTEGER NOT NULL, model TEXT, project_id TEXT, l_floor REAL, b_total REAL, l_peak REAL, g_final REAL, o_avg REAL, c_ratio REAL, turns INTEGER, duration_ms INTEGER, total_tokens_read REAL, mf REAL, pp_exit REAL, br_exit REAL, br_peak REAL, pp_peak REAL, p0 REAL, b_axis REAL, x_axis REAL, g_min REAL, turn_at_br_amber INTEGER, archive_source TEXT, archive_priority INTEGER, telemetry_status TEXT, capture_source TEXT, PRIMARY KEY (session_id, segment)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile_paths (session_id TEXT NOT NULL, segment INTEGER NOT NULL DEFAULT 0, path TEXT NOT NULL, tokens REAL NOT NULL, PRIMARY KEY (session_id, segment, path)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE handoff (handoff_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, segment INTEGER NOT NULL, load_token TEXT NOT NULL, created_at INTEGER NOT NULL, paths_to_keep TEXT NOT NULL, summary TEXT NOT NULL, next_task TEXT, summary_tokens INTEGER NOT NULL, kept_tokens REAL, discarded_tokens REAL, prepared_at_turn INTEGER, previous_stats TEXT, prepared_stats TEXT, search_terms TEXT, project_id TEXT, delivered_at INTEGER, delivered_segment INTEGER, delivered_session_id TEXT, loader_version TEXT, bucket_snapshot TEXT, transcript_path TEXT)`);
  db.exec(`CREATE UNIQUE INDEX idx_handoff_token ON handoff(load_token)`);
  db.exec(`CREATE INDEX idx_handoff_session ON handoff(session_id, created_at DESC)`);
  db.exec(`CREATE INDEX idx_handoff_created_at ON handoff(created_at)`);
  db.exec(`CREATE INDEX idx_handoff_project ON handoff(project_id, created_at DESC)`);
  db.exec(`CREATE INDEX idx_handoff_delivered_session ON handoff(delivered_session_id)`);
  db.exec(`CREATE TABLE handoff_load (handoff_id INTEGER NOT NULL, session_id TEXT NOT NULL, loaded_at INTEGER NOT NULL, loader_version TEXT, claim_result TEXT NOT NULL CHECK (claim_result IN ('primary','duplicate','legacy_unattributed')), primary_session_id TEXT, consumer_segment INTEGER, PRIMARY KEY (handoff_id, session_id, loaded_at)) WITHOUT ROWID`);
  db.exec(`CREATE INDEX idx_handoff_load_session ON handoff_load(session_id)`);
  db.exec(`CREATE TABLE profile_path_event (session_id TEXT NOT NULL, segment INTEGER NOT NULL, folded_seq INTEGER NOT NULL, event_ordinal INTEGER NOT NULL, path TEXT NOT NULL, raw_path TEXT, tool_type TEXT NOT NULL, is_full_read INTEGER CHECK (is_full_read IN (0,1) OR is_full_read IS NULL), PRIMARY KEY (session_id, segment, folded_seq, event_ordinal)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile_step_usage (session_id TEXT NOT NULL, segment INTEGER NOT NULL, folded_seq INTEGER NOT NULL, ts INTEGER, cache_read REAL, cache_creation REAL, input REAL, output REAL, tool_calls INTEGER, load_token TEXT, PRIMARY KEY (session_id, segment, folded_seq)) WITHOUT ROWID`);
  db.exec(`CREATE INDEX idx_step_usage_load_token ON profile_step_usage(load_token)`);
  db.exec(`CREATE INDEX idx_profile_telemetry ON profile(telemetry_status, archived_at)`);
  db.prepare("INSERT INTO meta VALUES ('schema_version','3')").run();
  db.prepare(`INSERT INTO handoff (session_id, segment, load_token, created_at, paths_to_keep, summary, summary_tokens, project_id) VALUES ('s1',0,'tok-v3-alpha',100,'[]','v3 handoff summary',3,'proj-A')`).run();
  db.close();
}

// Seed a partial v4 DB: meta already at '4', bookmark table exists but missing `active` column and the index.
function seedPartialV4(dbPath) {
  seedV3(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
  // Table exists but without the `active` column and without the index
  db.exec(`CREATE TABLE bookmark (
    bookmark_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    anchor_uuid       TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    preview_text      TEXT NOT NULL,
    original_chars    INTEGER NOT NULL,
    truncated         INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    source_timestamp  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (source_session_id, anchor_uuid)
  )`);
  db.close();
}

// The v4 bookmark objects plus the terminal schema version and the v5 table: a v4-era DB reaches v5
// with its bookmark shape healed, so every seed below also proves v4 → v5 keeps the old rows.
function assertV5Shape(store) {
  assert.equal(
    store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    '5',
  );
  const columns = store._db.prepare('PRAGMA table_info(bookmark)').all().map(r => r.name);
  assert.deepEqual(columns, [
    'bookmark_id', 'project_id', 'source_session_id', 'anchor_uuid',
    'role', 'preview_text', 'original_chars', 'truncated',
    'source_timestamp', 'created_at', 'active',
  ]);
  assert.ok(store._db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_bookmark_project_session'"
  ).get());
  assert.ok(store._db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_note'"
  ).get());
}

test('fresh DB ends at v5 with bookmark table and index', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  assertV5Shape(store);
  closeStore(store);
});

test('v4 migration from full v3 DB: bookmark table + index added, v3 handoff row preserved', async () => {
  seedV3(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  assertV5Shape(store);
  // v3 handoff row must survive migration unchanged
  const row = store._db.prepare("SELECT load_token, summary FROM handoff WHERE session_id='s1'").get();
  assert.equal(row.load_token, 'tok-v3-alpha');
  assert.equal(row.summary, 'v3 handoff summary');
  closeStore(store);
});

test('v4 shape-heal: partial v4 with missing active column + index is healed on reopen', async () => {
  seedPartialV4(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  assertV5Shape(store);
  closeStore(store);
});

test('v4 migration is idempotent — reopen does not error or lose data', async () => {
  seedV3(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  let store = openStore(dbPath); closeStore(store);
  store = openStore(dbPath);
  assertV5Shape(store);
  const row = store._db.prepare("SELECT load_token FROM handoff WHERE session_id='s1'").get();
  assert.equal(row.load_token, 'tok-v3-alpha');
  closeStore(store);
});
