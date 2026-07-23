import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

let dir, dbPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-mig-')); dbPath = join(dir, 't.sqlite'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Hand-build a v1 DB (schema_version=1, old profile PK=session_id) so the v2 migration runs on open.
function seedV1(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  // Full v1 schema (sessions, state, config, lines, paths needed by Store constructor)
  db.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, model TEXT, project_id TEXT) WITHOUT ROWID`);
  db.exec(`CREATE TABLE state (session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, key)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  db.exec(`CREATE TABLE lines (session_id TEXT NOT NULL, path TEXT NOT NULL, line_num INTEGER NOT NULL, chars INTEGER NOT NULL, PRIMARY KEY (session_id, path, line_num)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE paths (session_id TEXT NOT NULL, path TEXT NOT NULL, edit_delta INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path)) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile (
    session_id TEXT PRIMARY KEY, archived_at INTEGER NOT NULL, model TEXT, project_id TEXT,
    l_floor REAL, b_total REAL, l_peak REAL, g_final REAL, o_avg REAL, c_ratio REAL,
    turns INTEGER, duration_ms INTEGER, total_tokens_read REAL, mf REAL, pp_exit REAL,
    br_exit REAL, br_peak REAL, pp_peak REAL, p0 REAL, b_axis REAL, x_axis REAL,
    g_min REAL, turn_at_br_amber INTEGER) WITHOUT ROWID`);
  db.exec(`CREATE TABLE profile_paths (session_id TEXT NOT NULL, path TEXT NOT NULL, tokens REAL NOT NULL, PRIMARY KEY (session_id, path)) WITHOUT ROWID`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_project_id ON profile(project_id)`);
  db.prepare("INSERT INTO meta VALUES ('schema_version','1')").run();
  db.prepare(`INSERT INTO profile (session_id, archived_at, model, b_total, turns) VALUES (?,?,?,?,?)`)
    .run('s-old', 111, 'opus', 42000, 7);
  db.prepare(`INSERT INTO profile_paths VALUES (?,?,?)`).run('s-old', '/a.js', 1234);
  db.close();
}

test('v2 migration: profile gains segment PK, existing rows get segment=0 + archive_source=snapshot', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  const row = store._db.prepare("SELECT * FROM profile WHERE session_id='s-old' AND segment=0").get();
  assert.ok(row, 'migrated row addressable by (session_id, segment=0)');
  assert.equal(row.b_total, 42000);
  assert.equal(row.turns, 7);
  assert.equal(row.archive_source, 'snapshot');
  const ver = store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(ver.value, '3');  // terminal version is v3 (v2 migration then chains into v3)
  closeStore(store);
});

test('v2 migration: profile_paths gains segment column, existing rows segment=0', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  const p = store._db.prepare("SELECT * FROM profile_paths WHERE session_id='s-old' AND segment=0 AND path='/a.js'").get();
  assert.ok(p);
  assert.equal(p.tokens, 1234);
  closeStore(store);
});

test('v2 migration: composite PK allows two segments per session', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  store._db.prepare(`INSERT INTO profile (session_id, segment, archived_at, archive_source) VALUES ('s-old',1,222,'live')`).run();
  const rows = store._db.prepare("SELECT segment FROM profile WHERE session_id='s-old' ORDER BY segment").all();
  assert.deepEqual(rows.map(r => r.segment), [0, 1]);
  closeStore(store);
});

test('migration is idempotent — reopen a v2 DB does not re-migrate or lose data', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  let store = openStore(dbPath); closeStore(store);
  store = openStore(dbPath);
  const row = store._db.prepare("SELECT b_total FROM profile WHERE session_id='s-old' AND segment=0").get();
  assert.equal(row.b_total, 42000);
  closeStore(store);
});

test('fresh DB ends at v2 with segment PK and handoff table', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  // profile should have segment column
  const cols = store._db.prepare("PRAGMA table_info(profile)").all().map(c => c.name);
  assert.ok(cols.includes('segment'), 'profile must have segment column');
  assert.ok(cols.includes('archive_source'), 'profile must have archive_source column');
  assert.ok(cols.includes('archive_priority'), 'profile must have archive_priority column');
  // handoff table exists
  const handoff = store._db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff'").get();
  assert.ok(handoff, 'handoff table must exist');
  // terminal version is v3 (fresh DB migrates base → v2 → v3)
  const ver = store._db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(ver.value, '3');
  closeStore(store);
});

test('ensureV2Shape self-heals missing handoff table', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  let store = openStore(dbPath);
  // Sabotage: drop handoff table
  store._db.exec('DROP TABLE IF EXISTS handoff');
  closeStore(store);
  // Reopen should self-heal
  store = openStore(dbPath);
  const handoff = store._db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff'").get();
  assert.ok(handoff, 'handoff table must be recreated by ensureV2Shape');
  closeStore(store);
});

test('v2 migration: handoff table has unique load_token index', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  // Insert two rows; duplicate load_token must violate the unique index.
  const ins = store._db.prepare(`INSERT INTO handoff
    (session_id, segment, load_token, created_at, paths_to_keep, summary, summary_tokens)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run('s1', 0, 'tok-alpha-fox', 100, '[]', 'sum', 3);
  assert.throws(() => ins.run('s2', 0, 'tok-alpha-fox', 200, '[]', 'sum2', 4),
    (e) => e.errcode === 2067, 'duplicate load_token rejected by unique index (errcode 2067)');
  closeStore(store);
});

test('v2 migration: handoff_fts is available and synced by insert trigger', async () => {
  seedV1(dbPath);
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(dbPath);
  if (!store.ftsAvailable) { closeStore(store); return; } // skip if FTS5 absent in this build
  store._db.prepare(`INSERT INTO handoff
    (session_id, segment, load_token, created_at, paths_to_keep, summary, summary_tokens, search_terms)
    VALUES ('s1',0,'auth-middleware-jade',100,'[]','refactor the auth middleware',5,'')`).run();
  const hit = store._db.prepare(`SELECT h.load_token FROM handoff_fts
    JOIN handoff h ON h.handoff_id = handoff_fts.rowid WHERE handoff_fts MATCH 'middleware'`).get();
  assert.equal(hit.load_token, 'auth-middleware-jade');
  closeStore(store);
});
