// test/store-migration-v5.test.js — reaching schema version 5 from every shape in the wild.
//
// Version 5 names the required current structure and does not require Bookmark: a fresh store omits it,
// and a database that already has one keeps it untouched. Every case below snapshots the whole database
// before migration and compares it afterwards, so a migration that silently rewrote a pre-existing object
// or row fails here whatever it added. `meta.schema_version` is the one value allowed to change.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

let dir, dbPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-mig5-')); dbPath = join(dir, 't.sqlite'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A generated FTS shadow table is fts5's own private storage: its bytes are an implementation detail, so it
// is checked for existence and nothing else. Its logical rows and query results are compared through the
// virtual table itself.
const FTS_SHADOW_SUFFIX = /_(data|idx|docsize|config|content)$/;
const isFtsShadow = (name) => /_fts_/.test(name) || (/_fts/.test(name) && FTS_SHADOW_SUFFIX.test(name));

// Every object and every row of one database, in a comparable form.
function snapshotDatabase(db) {
  const objects = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  const shadows = objects.filter(o => isFtsShadow(o.name)).map(o => o.name).sort();
  const schema = objects.filter(o => !isFtsShadow(o.name))
    .map(o => [o.type, o.name, o.tbl_name, o.sql]);
  const rows = {};
  for (const o of objects) {
    if (o.type !== 'table' || isFtsShadow(o.name)) continue;
    // Ordered by every column, so a row set is compared as a set rather than in storage order.
    const columns = db.prepare(`PRAGMA table_info(${o.name})`).all().map(c => `"${c.name}"`);
    rows[o.name] = columns.length === 0
      ? []
      : db.prepare(`SELECT * FROM ${o.name} ORDER BY ${columns.join(',')}`).all();
  }
  return { schema, shadows, rows };
}

// The comparison: every pre-existing object keeps its definition, every pre-existing table keeps its rows,
// and only `meta.schema_version` moves. New objects and new tables are what a migration is for.
function assertPreserved(before, after) {
  const afterByName = new Map(after.schema.map(o => [o[1], o]));
  for (const object of before.schema) {
    assert.deepEqual(afterByName.get(object[1]), object,
      `pre-existing ${object[0]} ${object[1]} changed`);
  }
  for (const shadow of before.shadows) {
    assert.ok(after.shadows.includes(shadow), `generated FTS shadow ${shadow} disappeared`);
  }
  for (const [table, rowsBefore] of Object.entries(before.rows)) {
    const rowsAfter = after.rows[table];
    if (table === 'meta') {
      const strip = (rs) => rs.filter(r => r.key !== 'schema_version');
      assert.deepEqual(strip(rowsAfter), strip(rowsBefore), 'meta rows other than schema_version changed');
      continue;
    }
    assert.deepEqual(rowsAfter, rowsBefore, `rows of ${table} changed`);
  }
}

const withSeed = async (seed) => {
  if (seed) seed(dbPath);
  let before = null;
  if (seed) {
    const raw = new DatabaseSync(dbPath);
    before = snapshotDatabase(raw);
    raw.close();
  }
  const { openStore, closeStore } = await import('../lib/store.js');
  return { before, openStore, closeStore };
};

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
  db.prepare(`INSERT INTO handoff (session_id, segment, load_token, created_at, paths_to_keep, summary, next_task, summary_tokens, project_id) VALUES ('s1',0,'tok-v3-alpha',100,'[]','v3 handoff summary','carry this on',3,'proj-A')`).run();
  db.prepare(`INSERT INTO profile (session_id, segment, archived_at, archive_source, archive_priority) VALUES ('s1',0,111,'live',2)`).run();
  db.close();
}

// The Bookmark shape a v4-era database carries, with rows. This is the only legacy Bookmark preservation
// fixture: the runtime that wrote these rows is gone, and they still may not be touched.
const BOOKMARK_V4_SQL = `CREATE TABLE bookmark (
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
    active            INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    UNIQUE (source_session_id, anchor_uuid)
  )`;

// The handoff FTS mechanism a v4-era database already carries: its virtual table, its three triggers, and
// its generated shadow tables. Seeding it is what lets the comparison prove an existing index survives.
function seedHandoffFts(db) {
  db.exec(`CREATE VIRTUAL TABLE handoff_fts USING fts5(
    summary, next_task, load_token, search_terms,
    content='handoff', content_rowid='handoff_id')`);
  db.exec(`CREATE TRIGGER handoff_fts_insert AFTER INSERT ON handoff BEGIN
    INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (new.handoff_id, new.summary, new.next_task, new.load_token, new.search_terms);
  END`);
  db.exec(`CREATE TRIGGER handoff_fts_delete AFTER DELETE ON handoff BEGIN
    INSERT INTO handoff_fts(handoff_fts, rowid, summary, next_task, load_token, search_terms)
    VALUES ('delete', old.handoff_id, old.summary, old.next_task, old.load_token, old.search_terms);
  END`);
  db.exec(`CREATE TRIGGER handoff_fts_update AFTER UPDATE ON handoff
    WHEN old.summary IS NOT new.summary OR old.next_task IS NOT new.next_task
      OR old.load_token IS NOT new.load_token OR old.search_terms IS NOT new.search_terms
    BEGIN
    INSERT INTO handoff_fts(handoff_fts, rowid, summary, next_task, load_token, search_terms)
    VALUES ('delete', old.handoff_id, old.summary, old.next_task, old.load_token, old.search_terms);
    INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (new.handoff_id, new.summary, new.next_task, new.load_token, new.search_terms);
  END`);
  db.exec("INSERT INTO handoff_fts(handoff_fts) VALUES('rebuild')");
}

// A full v4 DB: meta at '4', the healed bookmark shape with rows, and a live handoff FTS index.
function seedFullV4(dbPath) {
  seedV3(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
  db.exec(BOOKMARK_V4_SQL);
  db.exec('CREATE INDEX idx_bookmark_project_session ON bookmark(project_id, source_session_id)');
  db.prepare(`INSERT INTO bookmark (project_id, source_session_id, anchor_uuid, role, preview_text,
    original_chars, truncated, source_timestamp, created_at, active)
    VALUES ('proj-A','s1','anchor-live','assistant','a preserved preview',19,0,900,901,1)`).run();
  db.prepare(`INSERT INTO bookmark (project_id, source_session_id, anchor_uuid, role, preview_text,
    original_chars, truncated, source_timestamp, created_at, active)
    VALUES ('proj-A','s1','anchor-retired','user','a retired preview',17,1,800,801,0)`).run();
  seedHandoffFts(db);
  db.close();
}

// A partial v4 DB: meta already at '4', the bookmark table exists without `active` and without the index.
function seedPartialV4(dbPath) {
  seedV3(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value='4' WHERE key='schema_version'").run();
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
  db.prepare(`INSERT INTO bookmark (project_id, source_session_id, anchor_uuid, role, preview_text,
    original_chars, truncated, source_timestamp, created_at)
    VALUES ('proj-A','s1','anchor-partial','assistant','partial-shape preview',21,0,700,701)`).run();
  db.close();
}

const versionOf = (store) =>
  store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value;
const objectExists = (store, type, name) =>
  !!store._db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name);

// Version 5's own required structure: Turn Note and its index, and no Bookmark table created for it.
function assertV5Shape(store) {
  assert.equal(versionOf(store), '5');
  assert.ok(objectExists(store, 'table', 'turn_note'));
  assert.ok(objectExists(store, 'index', 'idx_turn_note_session'));
  assert.ok(objectExists(store, 'table', 'turn_note_fts'));
}

test('fresh DB ends at v5 with Turn Note and no bookmark table', async () => {
  const { openStore, closeStore } = await withSeed(null);
  const store = openStore(dbPath);
  assertV5Shape(store);
  assert.equal(objectExists(store, 'table', 'bookmark'), false, 'a fresh store creates no Bookmark');
  assert.equal(objectExists(store, 'index', 'idx_bookmark_project_session'), false);
  closeStore(store);
});

test('full v3 to v5: Turn Note is created, no bookmark table appears, and v3 objects and rows are untouched', async () => {
  const { before, openStore, closeStore } = await withSeed(seedV3);
  const store = openStore(dbPath);
  assertV5Shape(store);
  assert.equal(objectExists(store, 'table', 'bookmark'), false,
    'a v3 database has no Bookmark and must not grow one');
  assertPreserved(before, snapshotDatabase(store._db));
  closeStore(store);
});

test('full v4 to v5: Turn Note is created and the existing bookmark table, its rows and its FTS index survive', async () => {
  const { before, openStore, closeStore } = await withSeed(seedFullV4);
  const store = openStore(dbPath);
  assertV5Shape(store);
  assertPreserved(before, snapshotDatabase(store._db));
  // Stated on the Bookmark rows themselves, not only through the whole-database comparison: this is the
  // one legacy Bookmark preservation fixture the campaign keeps.
  const bookmarks = store._db.prepare(
    'SELECT anchor_uuid, preview_text, active FROM bookmark ORDER BY bookmark_id')
    .all().map(r => ({ ...r }));
  assert.deepEqual(bookmarks, [
    { anchor_uuid: 'anchor-live', preview_text: 'a preserved preview', active: 1 },
    { anchor_uuid: 'anchor-retired', preview_text: 'a retired preview', active: 0 },
  ]);
  // The pre-existing FTS index still answers the same query after migration.
  assert.deepEqual(
    store._db.prepare("SELECT rowid FROM handoff_fts WHERE handoff_fts MATCH 'alpha'")
      .all().map(r => r.rowid),
    [1]);
  closeStore(store);
});

test('partial v4 to v5: Turn Note is created and the partial bookmark shape is left exactly as it was', async () => {
  const { before, openStore, closeStore } = await withSeed(seedPartialV4);
  const store = openStore(dbPath);
  assertV5Shape(store);
  assertPreserved(before, snapshotDatabase(store._db));
  // The retired healing added `active` and an index; neither appears now.
  const columns = store._db.prepare('PRAGMA table_info(bookmark)').all().map(c => c.name);
  assert.equal(columns.includes('active'), false, 'no column is added to a partial Bookmark shape');
  assert.equal(objectExists(store, 'index', 'idx_bookmark_project_session'), false,
    'no index is added to a partial Bookmark shape');
  closeStore(store);
});

test('reopen is idempotent: a second open changes no object and no row', async () => {
  const { openStore, closeStore } = await withSeed(seedFullV4);
  let store = openStore(dbPath);
  const afterFirst = snapshotDatabase(store._db);
  closeStore(store);
  store = openStore(dbPath);
  assertV5Shape(store);
  assertPreserved(afterFirst, snapshotDatabase(store._db));
  assert.deepEqual(snapshotDatabase(store._db).schema, afterFirst.schema,
    'a reopen adds no object either');
  closeStore(store);
});
