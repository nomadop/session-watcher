import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { GC_BATCH_LIMIT, GC_REPLAY_MAX_FILE_BYTES, GC_HANDOFF_MAX_AGE_DAYS } from './constants.js';

// Yield to the event loop between swept sessions so a large startup backlog does not monopolize the
// loop in one synchronous block (genuine chunking — the sweep is async and awaits this).
const yieldTick = () => new Promise(r => setImmediate(r));

const ARCHIVE_PRIORITY = { snapshot: 1, replay: 2, live: 3 };

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  model       TEXT,
  project_id  TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS state (
  session_id TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lines (
  session_id TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  line_num   INTEGER NOT NULL,
  chars      INTEGER NOT NULL,
  PRIMARY KEY (session_id, path, line_num)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS paths (
  session_id TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  edit_delta  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS profile (
  session_id   TEXT PRIMARY KEY,
  archived_at  INTEGER NOT NULL,
  model        TEXT,
  project_id   TEXT,
  l_floor      REAL,
  b_total      REAL,
  l_peak       REAL,
  g_final      REAL,
  o_avg        REAL,
  c_ratio      REAL,
  turns        INTEGER,
  duration_ms  INTEGER,
  total_tokens_read REAL,
  mf           REAL,
  pp_exit      REAL,
  br_exit      REAL,
  br_peak      REAL,
  pp_peak      REAL,
  p0           REAL,
  b_axis       REAL,
  x_axis       REAL,
  g_min        REAL,
  turn_at_br_amber INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS profile_paths (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  tokens     REAL NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_project_id ON profile(project_id);
`;

function migrateProfileToSegment(db) {
  db.exec('ALTER TABLE profile RENAME TO profile_v1');
  db.exec(`CREATE TABLE profile (
    session_id TEXT NOT NULL, segment INTEGER NOT NULL, archived_at INTEGER NOT NULL,
    model TEXT, project_id TEXT, l_floor REAL, b_total REAL, l_peak REAL, g_final REAL,
    o_avg REAL, c_ratio REAL, turns INTEGER, duration_ms INTEGER, total_tokens_read REAL,
    mf REAL, pp_exit REAL, br_exit REAL, br_peak REAL, pp_peak REAL, p0 REAL, b_axis REAL,
    x_axis REAL, g_min REAL, turn_at_br_amber INTEGER, archive_source TEXT,
    archive_priority INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (session_id, segment)) WITHOUT ROWID`);
  db.exec(`INSERT INTO profile (
    session_id, segment, archived_at, model, project_id, l_floor, b_total, l_peak, g_final,
    o_avg, c_ratio, turns, duration_ms, total_tokens_read, mf, pp_exit, br_exit, br_peak,
    pp_peak, p0, b_axis, x_axis, g_min, turn_at_br_amber, archive_source, archive_priority)
    SELECT session_id, 0, archived_at, model, project_id, l_floor, b_total, l_peak, g_final,
    o_avg, c_ratio, turns, duration_ms, total_tokens_read, mf, pp_exit, br_exit, br_peak,
    pp_peak, p0, b_axis, x_axis, g_min, turn_at_br_amber, 'snapshot', 1 FROM profile_v1`);
  db.exec('DROP TABLE profile_v1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_profile_project_archived ON profile(project_id, archived_at DESC)');
}

function migrateProfilePaths(db) {
  db.exec('ALTER TABLE profile_paths RENAME TO profile_paths_v1');
  db.exec(`CREATE TABLE profile_paths (
    session_id TEXT NOT NULL, segment INTEGER NOT NULL, path TEXT NOT NULL, tokens REAL NOT NULL,
    PRIMARY KEY (session_id, segment, path)) WITHOUT ROWID`);
  db.exec('INSERT INTO profile_paths (session_id, segment, path, tokens) SELECT session_id, 0, path, tokens FROM profile_paths_v1');
  db.exec('DROP TABLE profile_paths_v1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_profile_paths_path ON profile_paths(path, session_id, segment)');
}

function createHandoffTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS handoff (
    handoff_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, segment INTEGER NOT NULL,
    load_token TEXT NOT NULL, created_at INTEGER NOT NULL, paths_to_keep TEXT NOT NULL,
    summary TEXT NOT NULL, next_task TEXT, summary_tokens INTEGER NOT NULL,
    kept_tokens REAL, discarded_tokens REAL, prepared_at_turn INTEGER,
    previous_stats TEXT, prepared_stats TEXT, search_terms TEXT, project_id TEXT,
    delivered_at INTEGER, delivered_segment INTEGER)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_session ON handoff(session_id, created_at DESC)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_token ON handoff(load_token)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_created_at ON handoff(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_project ON handoff(project_id, created_at DESC)');
}

function createHandoffLoadTable(db) {
  // consumer_segment records the loader's segment index at load time (handoff→consumer linkage —
  //   "which segment started work off this carry"). Nullable (a session-less/legacy load has none).
  // claim_result gains 'legacy_unattributed' for a v2 row that was delivered_at!=NULL with an
  //   unknown consumer — such a load is neither a fresh primary nor a duplicate of a known primary.
  db.exec(`CREATE TABLE IF NOT EXISTS handoff_load (
    handoff_id         INTEGER NOT NULL,
    session_id         TEXT NOT NULL,
    loaded_at          INTEGER NOT NULL,
    loader_version     TEXT,
    claim_result       TEXT NOT NULL CHECK (claim_result IN ('primary','duplicate','legacy_unattributed')),
    primary_session_id TEXT,
    consumer_segment   INTEGER,
    PRIMARY KEY (handoff_id, session_id, loaded_at)
  ) WITHOUT ROWID`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_load_session ON handoff_load(session_id)');
}

// Returns the set of telemetry tables that were ABSENT before this call created them. A recreated
// table has lost its rows, so any profile that claimed those rows as `complete` must be re-swept —
// the caller resets their status. (CREATE TABLE IF NOT EXISTS silently no-ops when present, so we
// PRAGMA-check first.)
function createTelemetryTables(db) {
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const wasMissing = [];
  if (!has('profile_path_event')) wasMissing.push('profile_path_event');
  if (!has('profile_step_usage')) wasMissing.push('profile_step_usage');
  // segment is IN the PK. foldedSeq is session-global so (session_id, folded_seq) is logically
  //   unique, but a fold/replay bug producing a cross-segment collision must FAIL a plain INSERT
  //   (→ failed_retryable, observable) rather than let INSERT OR REPLACE silently clobber another
  //   segment's row. Writes are plain INSERT after a per-segment DELETE (Task 7). raw_path
  //   preserves the tool's original path string alongside the (project-relative) path so an offline
  //   cross-machine join is not forced to reverse a normalization it can't see.
  db.exec(`CREATE TABLE IF NOT EXISTS profile_path_event (
    session_id    TEXT NOT NULL,
    segment       INTEGER NOT NULL,
    folded_seq    INTEGER NOT NULL,
    event_ordinal INTEGER NOT NULL,
    path          TEXT NOT NULL,
    raw_path      TEXT,
    tool_type     TEXT NOT NULL,
    is_full_read  INTEGER CHECK (is_full_read IN (0,1) OR is_full_read IS NULL),
    PRIMARY KEY (session_id, segment, folded_seq, event_ordinal)
  ) WITHOUT ROWID`);
  db.exec(`CREATE TABLE IF NOT EXISTS profile_step_usage (
    session_id     TEXT NOT NULL,
    segment        INTEGER NOT NULL,
    folded_seq     INTEGER NOT NULL,
    ts             INTEGER,
    cache_read     REAL,
    cache_creation REAL,
    input          REAL,
    output         REAL,
    tool_calls     INTEGER,
    load_token     TEXT,
    PRIMARY KEY (session_id, segment, folded_seq)
  ) WITHOUT ROWID`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_step_usage_load_token ON profile_step_usage(load_token)');  // linkage join
  return wasMissing;
}

// v4: bookmark table + index. `CREATE TABLE IF NOT EXISTS` handles fresh and already-migrated DBs;
// addColumnIfMissing heals a partial v4 that has the table but lacks the `active` column.
// `CREATE INDEX IF NOT EXISTS` is idempotent on reopen.
function ensureV4Shape(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS bookmark (
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
  )`);
  addColumnIfMissing(db, 'bookmark', 'active', 'INTEGER NOT NULL DEFAULT 1');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bookmark_project_session ON bookmark(project_id, source_session_id)');
}

// v5: one turn_note row per history turn (cleaned user text + the assistant's note). Retention is
// keyed on source_session_id alone — no project_id column — and truncation is derived from
// u_original_chars > length(u_text) rather than stored as its own flag.
function ensureV5Shape(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS turn_note (
    turn_note_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    source_session_id TEXT    NOT NULL,
    anchor_uuid       TEXT    NOT NULL,
    u_text            TEXT    NOT NULL,
    u_original_chars  INTEGER NOT NULL,
    note              TEXT,
    search_terms      TEXT    NOT NULL DEFAULT '',
    source_timestamp  INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    UNIQUE (source_session_id, anchor_uuid)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_note_session
    ON turn_note(source_session_id, source_timestamp)`);
}

// v3 additive columns — each guarded so a half-migrated DB presence-heals per-column.
const V3_HANDOFF_COLUMNS = [
  ['delivered_session_id', 'TEXT'],
  ['loader_version', 'TEXT'],
  ['bucket_snapshot', 'TEXT'],
  ['transcript_path', 'TEXT'],
];

function addColumnIfMissing(db, table, name, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

// PRESENCE-heal: this backfills MISSING columns/tables/indexes; it does NOT repair a wrong column
// type / wrong PK / mis-defined index. That is weaker than ensureV2Shape, which actually rebuilds the
// profile table (migrateProfileToSegment) to fix a wrong PK — but it is adequate here because every v3
// object is net-new (no legacy wrong-shape variant exists in the wild) and all additions are additive.
// Do not describe it as full structural self-heal.
function ensureV3Shape(db) {
  for (const [name, type] of V3_HANDOFF_COLUMNS) addColumnIfMissing(db, 'handoff', name, type);
  addColumnIfMissing(db, 'profile', 'telemetry_status', 'TEXT');
  addColumnIfMissing(db, 'profile', 'capture_source', 'TEXT');   // 'cc-live'|'cc-replay'; NULL legacy ⇒ 'cc'
  createHandoffLoadTable(db);
  const recreated = createTelemetryTables(db);
  if (recreated.length) {
    // A telemetry table was missing → its rows are gone. Any profile that thinks it is captured must
    // be re-swept, else the sweep (guarded by telemetry_status) skips it forever. We cannot know
    // WHICH segments lost rows cheaply, so invalidate all captured statuses conservatively.
    db.prepare("UPDATE profile SET telemetry_status='pending' WHERE telemetry_status IN ('complete','complete_empty')").run();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_handoff_delivered_session ON handoff(delivered_session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_profile_telemetry ON profile(telemetry_status, archived_at)');  // sweep scan
}

// Every object an FTS index needs to stay in step with its base table: the virtual table plus the
// triggers that mirror each write into it. A name added to one of these lists is also the repair for the
// databases that predate it: each of them probes as incomplete once, and that open's rebuild clears the
// drift accumulated while the object was missing.
const HANDOFF_FTS_OBJECTS = ['handoff_fts', 'handoff_fts_insert', 'handoff_fts_delete',
  'handoff_fts_update'];
const TURN_NOTE_FTS_OBJECTS = ['turn_note_fts', 'turn_note_fts_insert', 'turn_note_fts_delete',
  'turn_note_fts_update'];

// sqlite_master carries tables and triggers alike, so one query answers whether an index's whole
// mechanism is in place. Must be asked BEFORE the creates run — a create is what makes an incomplete
// mechanism whole, and afterwards nothing distinguishes an index that was maintained all along.
function ftsObjectsPresent(db, names) {
  const holes = names.map(() => '?').join(',');
  const row = db.prepare(`SELECT COUNT(*) AS present FROM sqlite_master WHERE name IN (${holes})`).get(...names);
  return row.present === names.length;
}

// FTS5 over handoff. External-content deletes MUST use the ('delete', rowid, …) command form carrying the
// OLD values — a plain DELETE would leave the index out of sync. The AFTER UPDATE trigger is what keeps an
// in-place revision — prepare_handoff called with the token of an undelivered handoff, which updateHandoff
// serves — searchable under its new words only. Without it the row keeps its old postings, and the delete
// that later retires the row subtracts the new ones, so a posting outlives every row able to resolve it and
// the next search over that word raises SQLITE_CORRUPT_VTAB while fts5 integrity-check still passes.
// Its WHEN confines the firing to writes that change an indexed column: the in-place revision still fires,
// while a delivery stamp — which touches none of them, and runs inside loadHandoffByToken's fail-closed
// transaction — never reaches the index, so an index-side failure cannot answer a loadable handoff with no
// content at all.
// Throws if the SQLite build lacks FTS5 — caller catches.
function createHandoffFts(db) {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS handoff_fts USING fts5(
    summary, next_task, load_token, search_terms,
    content='handoff', content_rowid='handoff_id')`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fts_insert AFTER INSERT ON handoff BEGIN
    INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (new.handoff_id, new.summary, new.next_task, new.load_token, new.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fts_delete AFTER DELETE ON handoff BEGIN
    INSERT INTO handoff_fts(handoff_fts, rowid, summary, next_task, load_token, search_terms)
    VALUES ('delete', old.handoff_id, old.summary, old.next_task, old.load_token, old.search_terms);
  END`);
  // A body edited here reaches only a database that does not yet carry the trigger: CREATE TRIGGER IF NOT
  // EXISTS keeps the body sqlite_master already holds, and ftsObjectsPresent matches the name rather than
  // the definition. Delivering a revised body to a database that has it is a deliberate step.
  db.exec(`CREATE TRIGGER IF NOT EXISTS handoff_fts_update AFTER UPDATE ON handoff
    WHEN old.summary IS NOT new.summary OR old.next_task IS NOT new.next_task
      OR old.load_token IS NOT new.load_token OR old.search_terms IS NOT new.search_terms
    BEGIN
    INSERT INTO handoff_fts(handoff_fts, rowid, summary, next_task, load_token, search_terms)
    VALUES ('delete', old.handoff_id, old.summary, old.next_task, old.load_token, old.search_terms);
    INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (new.handoff_id, new.summary, new.next_task, new.load_token, new.search_terms);
  END`);
}

// FTS5 over turn_note. External-content deletes MUST use the ('delete', rowid, …) command form with
// the OLD values — a plain DELETE would leave the index out of sync. Every trigger lists the indexed
// columns in the same order. The AFTER UPDATE trigger is what makes a re-submitted note searchable under
// its new words only. The rebuild is the repair for an index whose mechanism was incomplete: a row
// written while the virtual table or a trigger was absent is in no index, and one rewritten then still
// answers to the words it dropped — nothing else corrects either. A complete index is already in step, so
// a reopen must not re-index the table.
// Throws if the SQLite build lacks FTS5 — caller catches.
function createTurnNoteFts(db) {
  const wasIncomplete = !ftsObjectsPresent(db, TURN_NOTE_FTS_OBJECTS);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS turn_note_fts USING fts5(
    u_text, note, search_terms, content='turn_note', content_rowid='turn_note_id')`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS turn_note_fts_insert AFTER INSERT ON turn_note BEGIN
    INSERT INTO turn_note_fts(rowid, u_text, note, search_terms)
    VALUES (new.turn_note_id, new.u_text, new.note, new.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS turn_note_fts_delete AFTER DELETE ON turn_note BEGIN
    INSERT INTO turn_note_fts(turn_note_fts, rowid, u_text, note, search_terms)
    VALUES ('delete', old.turn_note_id, old.u_text, old.note, old.search_terms);
  END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS turn_note_fts_update AFTER UPDATE ON turn_note BEGIN
    INSERT INTO turn_note_fts(turn_note_fts, rowid, u_text, note, search_terms)
    VALUES ('delete', old.turn_note_id, old.u_text, old.note, old.search_terms);
    INSERT INTO turn_note_fts(rowid, u_text, note, search_terms)
    VALUES (new.turn_note_id, new.u_text, new.note, new.search_terms);
  END`);
  if (wasIncomplete) db.exec(`INSERT INTO turn_note_fts(turn_note_fts) VALUES('rebuild')`);
}

// R1-F schema-repair: don't trust meta.schema_version alone — verify actual shape and self-heal.
function ensureV2Shape(db) {
  const hasHandoff = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='handoff'").get();
  const profileCols = db.prepare("PRAGMA table_info(profile)").all().map(c => c.name);
  const profileOk = profileCols.includes('segment') && profileCols.includes('archive_priority');
  if (!hasHandoff || !profileOk) {
    // Re-run builders (all IF NOT EXISTS / guarded) — recovers a half-migrated v2 DB.
    if (!profileOk && profileCols.includes('session_id') && !profileCols.includes('segment')) {
      migrateProfileToSegment(db);
      migrateProfilePaths(db);
    }
    if (!hasHandoff) createHandoffTable(db);
  }
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? parseInt(row.value) : 0;
    if (version < 1) {
      db.exec(SCHEMA_V1_SQL);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    // v3: profile_paths was added to SCHEMA_V1_SQL after some databases were already at version 1.
    // Ensure the table exists regardless of version (CREATE TABLE IF NOT EXISTS is idempotent).
    // Only create the old-schema profile_paths if we haven't already migrated to v2 (segment PK).
    if (version < 2) {
      db.exec(`CREATE TABLE IF NOT EXISTS profile_paths (
        session_id TEXT NOT NULL,
        path       TEXT NOT NULL,
        tokens     REAL NOT NULL,
        PRIMARY KEY (session_id, path)
      ) WITHOUT ROWID`);
      migrateProfileToSegment(db);
      migrateProfilePaths(db);
      createHandoffTable(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    if (version < 3) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    if (version < 4) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    ensureV2Shape(db);  // idempotent self-heal (R1-F) — heals/base-rebuilds profile first
    ensureV3Shape(db);  // presence-heal — always after v2, so profile is guaranteed present/healed
    ensureV4Shape(db);  // presence-heal — always on reopen even when meta is already '4'
    ensureV5Shape(db);  // presence-heal — always on reopen even when meta is already '5'
    if (version < 5) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // FTS5 is optional — created OUTSIDE the core migration transaction (§2.6).
  // On a v2+ DB the CREATE ... IF NOT EXISTS is a cheap no-op; always attempt so a DB
  // migrated on an FTS-less build gains the index if reopened on an FTS-capable build.
  // Two independent try/catch blocks: one index failing must not decide the other's availability.
  let handoffFtsAvailable = false;
  let turnFtsAvailable = false;
  try {
    const wasIncomplete = !ftsObjectsPresent(db, HANDOFF_FTS_OBJECTS);
    createHandoffFts(db);
    // The rebuild is the repair for an incomplete object set: a row written while an object was missing is
    // in no index, and a row revised then is indexed under words it no longer holds — nothing else corrects
    // either. A complete index is already in step, so it is not re-derived on a plain reopen.
    if (wasIncomplete) db.exec("INSERT INTO handoff_fts(handoff_fts) VALUES('rebuild')");
    handoffFtsAvailable = true;
  } catch (ftsErr) {
    console.warn('[store] FTS5 unavailable, handoff search disabled:', ftsErr.message);
  }
  try {
    createTurnNoteFts(db);   // probes and repairs its own index
    turnFtsAvailable = true;
  } catch (ftsErr) {
    console.warn('[store] FTS5 unavailable, turn-note locate disabled:', ftsErr.message);
  }
  return { handoffFtsAvailable, turnFtsAvailable };
}

class Store {
  constructor(db) {
    this._db = db;
    this._closed = false;  // #6: idempotent close guard
    this._stmts = {
      touchSession: db.prepare(`INSERT INTO sessions (session_id, created_at, updated_at, model, project_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, model = COALESCE(excluded.model, sessions.model), project_id = COALESCE(excluded.project_id, sessions.project_id)`),
      load: db.prepare('SELECT value FROM state WHERE session_id = ? AND key = ?'),
      save: db.prepare(`INSERT INTO state (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
      delete: db.prepare('DELETE FROM state WHERE session_id = ? AND key = ?'),
      loadAll: db.prepare('SELECT key, value FROM state WHERE session_id = ?'),
      deleteSessionState: db.prepare('DELETE FROM state WHERE session_id = ?'),
      deleteSessionPaths: db.prepare('DELETE FROM paths WHERE session_id = ?'),
      deleteSessionLines: db.prepare('DELETE FROM lines WHERE session_id = ?'),
      deleteSessionRecord: db.prepare('DELETE FROM sessions WHERE session_id = ?'),

      // Config CRUD
      loadConfig: db.prepare('SELECT value FROM config WHERE key = ?'),
      saveConfig: db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      deleteConfig: db.prepare('DELETE FROM config WHERE key = ?'),

      // Profile archival — v2 composite PK (session_id, segment)
      loadProfile: db.prepare('SELECT * FROM profile WHERE session_id = ? AND segment = 0'),
      loadAllProfiles: db.prepare('SELECT * FROM profile WHERE segment = 0 ORDER BY archived_at DESC'),
      archiveSegment: db.prepare(`INSERT INTO profile (session_id, segment, archived_at, model, project_id,
        l_floor, b_total, l_peak, g_final, o_avg, c_ratio, turns, duration_ms, total_tokens_read,
        mf, pp_exit, br_exit, br_peak, pp_peak, p0, b_axis, x_axis, g_min, turn_at_br_amber,
        archive_source, archive_priority)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id, segment) DO UPDATE SET
          archived_at=excluded.archived_at, model=excluded.model, project_id=excluded.project_id,
          l_floor=excluded.l_floor, b_total=excluded.b_total, l_peak=excluded.l_peak,
          g_final=excluded.g_final, o_avg=excluded.o_avg, c_ratio=excluded.c_ratio,
          turns=excluded.turns, duration_ms=excluded.duration_ms, total_tokens_read=excluded.total_tokens_read,
          mf=excluded.mf, pp_exit=excluded.pp_exit, br_exit=excluded.br_exit, br_peak=excluded.br_peak,
          pp_peak=excluded.pp_peak, p0=excluded.p0, b_axis=excluded.b_axis, x_axis=excluded.x_axis,
          g_min=excluded.g_min, turn_at_br_amber=excluded.turn_at_br_amber,
          archive_source=excluded.archive_source, archive_priority=excluded.archive_priority
        WHERE excluded.archive_priority >= profile.archive_priority`),
      deleteSegmentPaths: db.prepare('DELETE FROM profile_paths WHERE session_id = ? AND segment = ?'),
      insertSegmentPath: db.prepare('INSERT OR REPLACE INTO profile_paths (session_id, segment, path, tokens) VALUES (?,?,?,?)'),
      loadProfileSegments: db.prepare('SELECT * FROM profile WHERE session_id = ? ORDER BY segment ASC'),

      // --- Segment telemetry (TXN2): profile_step_usage / profile_path_event + telemetry_status ---
      deleteSegmentStepUsage: db.prepare('DELETE FROM profile_step_usage WHERE session_id = ? AND segment = ?'),
      deleteSegmentPathEvents: db.prepare('DELETE FROM profile_path_event WHERE session_id = ? AND segment = ?'),
      // plain INSERT (not INSERT OR REPLACE) — after the per-segment DELETE the table is clear for
      //   this segment, so a duplicate (session,segment,folded_seq) can ONLY come from a real fold/replay
      //   bug; let it THROW → the txn rolls back → failed_retryable (observable), not silent overwrite.
      insertStepUsage: db.prepare(`INSERT INTO profile_step_usage
        (session_id, segment, folded_seq, ts, cache_read, cache_creation, input, output, tool_calls, load_token)
        VALUES (?,?,?,?,?,?,?,?,?,?)`),
      insertPathEvent: db.prepare(`INSERT INTO profile_path_event
        (session_id, segment, folded_seq, event_ordinal, path, raw_path, tool_type, is_full_read)
        VALUES (?,?,?,?,?,?,?,?)`),
      // capture_source stamped WITH the status so provenance and status move together.
      setTelemetryStatus: db.prepare('UPDATE profile SET telemetry_status = ?, capture_source = ? WHERE session_id = ? AND segment = ?'),
      // Task 8 TXN1 handshake: a just-(re)written profile is needs-telemetry until TXN2 flips it. Clear
      // capture_source too so a re-written pending row never shows the PRIOR capture's provenance
      // (a crash between TXN1 and TXN2 would otherwise leave pending + a stale cc-live/cc-replay source).
      markTelemetryPending: db.prepare("UPDATE profile SET telemetry_status = 'pending', capture_source = NULL WHERE session_id = ? AND segment = ?"),
      setTelemetryStatusOnly: db.prepare('UPDATE profile SET telemetry_status = ? WHERE session_id = ? AND segment = ?'),
      // reused by the Task 8 getTelemetryStatus reader.
      getTelemetryStatusRow: db.prepare('SELECT telemetry_status FROM profile WHERE session_id=? AND segment=?'),

      // Task 10 startup sweep: DISTINCT sessions with ANY pending/failed_retryable/NULL segment,
      // newest-first, capped by a SQL LIMIT. The (? IS NULL OR session_id <> ?) clause pushes the common
      // single-live-id exclusion into SQL so the excluded session's rows do NOT consume the LIMIT (a
      // multi-id Set is JS-filtered after). Session granularity — the production replay archives every
      // occurred segment of a session in one pass, so the sweep issues ONE replay per DISTINCT session.
      pendingTelemetrySessions: db.prepare(`SELECT DISTINCT session_id FROM profile
        WHERE (telemetry_status IS NULL OR telemetry_status IN ('pending','failed_retryable'))
          AND (? IS NULL OR session_id <> ?)
        ORDER BY MAX(archived_at) OVER (PARTITION BY session_id) DESC
        LIMIT ?`),

      // Handoff CRUD
      insertHandoff: db.prepare(`INSERT INTO handoff
        (session_id, segment, load_token, created_at, paths_to_keep, summary, next_task,
         summary_tokens, kept_tokens, discarded_tokens, prepared_at_turn, previous_stats, prepared_stats, search_terms, project_id, bucket_snapshot, transcript_path)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      // Step 3d: `AND delivered_at IS NULL` makes a DELIVERED handoff's telemetry immutable — a
      // re-prepare with an already-consumed token gets changes===0 and the caller mints a fresh token
      // via the insert path (never rewrites bucket_snapshot/hp at a different instant than delivery).
      updateHandoff: db.prepare(`UPDATE handoff SET paths_to_keep = ?, summary = ?, next_task = ?,
         summary_tokens = ?, kept_tokens = ?, discarded_tokens = ?, prepared_at_turn = ?,
         previous_stats = ?, prepared_stats = ?, search_terms = ?, bucket_snapshot = ?, transcript_path = ?
         WHERE load_token = ? AND delivered_at IS NULL`),
      // Stamp ONLY paths_to_keep (per-entry telemetry back-fill: hp at prepare / hl at load). Keyed by
      // handoff_id so a load-side stamp does not need the token in scope.
      stampPathsToKeep: db.prepare('UPDATE handoff SET paths_to_keep = ? WHERE handoff_id = ?'),
      loadHandoffToken: db.prepare('SELECT * FROM handoff WHERE load_token = ?'),
      handoffExists: db.prepare('SELECT 1 FROM handoff WHERE load_token = ?'),
      loadHandoffSession: db.prepare('SELECT * FROM handoff WHERE session_id = ? AND (project_id = ? OR ? IS NULL) ORDER BY created_at DESC LIMIT 1'),
      loadHandoffByProject: db.prepare(`SELECT * FROM handoff
        WHERE project_id = ? AND delivered_at IS NULL AND session_id <> ? AND created_at > ?
        ORDER BY created_at DESC LIMIT 5`),
      // Two stamps. markDelivered is the CAS for a never-delivered row. markDeliveredLegacy binds the
      //   consumer of a v2 row that already has delivered_at but NULL consumer, WITHOUT touching the
      //   historical delivered_at (guarded on delivered_session_id IS NULL so it fires at most once).
      markDelivered: db.prepare('UPDATE handoff SET delivered_at = ?, delivered_session_id = ?, delivered_segment = ?, loader_version = ? WHERE handoff_id = ? AND delivered_at IS NULL'),
      markDeliveredLegacy: db.prepare('UPDATE handoff SET delivered_session_id = ?, delivered_segment = ?, loader_version = ? WHERE handoff_id = ? AND delivered_at IS NOT NULL AND delivered_session_id IS NULL'),
      insertHandoffLoad: db.prepare(`INSERT OR IGNORE INTO handoff_load
        (handoff_id, session_id, loaded_at, loader_version, claim_result, primary_session_id, consumer_segment)
        VALUES (?,?,?,?,?,?,?)`),

      // Bookmark CRUD
      // Upsert: on duplicate (source_session_id, anchor_uuid) only flip active=1; all immutable
      //   fields (preview, role, timestamp, created_at) are left untouched. After .run(), read-back
      //   by identity returns the canonical row regardless of insert vs. conflict path.
      upsertBookmark: db.prepare(`INSERT INTO bookmark (
          project_id, source_session_id, anchor_uuid, role, preview_text,
          original_chars, truncated, source_timestamp, created_at, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(source_session_id, anchor_uuid)
        DO UPDATE SET active = 1`),
      getBookmarkById: db.prepare('SELECT * FROM bookmark WHERE bookmark_id = ? AND project_id = ?'),
      getBookmarkByIdentity: db.prepare('SELECT * FROM bookmark WHERE project_id = ? AND source_session_id = ? AND anchor_uuid = ?'),
      deactivateBookmark: db.prepare('UPDATE bookmark SET active = 0 WHERE project_id = ? AND source_session_id = ? AND anchor_uuid = ?'),
      listActiveBookmarksForSession: db.prepare('SELECT * FROM bookmark WHERE project_id = ? AND source_session_id = ? AND active = 1 ORDER BY bookmark_id ASC'),
      // peekNextBookmarkId: reads the sqlite_sequence autoincrement counter for the bookmark table.
      //   Returns (current_max + 1). On a fresh/empty table the sqlite_sequence row is absent until
      //   first insert, so we fallback to 1. This is a non-transactional peek — callers must not
      //   rely on it for anything more than UI hints (the real id is determined by the INSERT).
      peekNextBookmarkId: db.prepare("SELECT seq FROM sqlite_sequence WHERE name='bookmark'"),
      // Lineage: the parent edge is the delivery a session consumed before it prepared its own
      // handoff. LIMIT 1 is replacement semantics, not a query optimization — when one child
      // session loaded several handoffs, only the newest qualifying delivery is its parent, and
      // the earlier ones' ancestor chains are NOT merged in. Same millisecond breaks by handoff_id.
      findParentDelivery: db.prepare(`SELECT h.* FROM handoff_load AS hl
        JOIN handoff AS h ON h.handoff_id = hl.handoff_id
       WHERE hl.session_id = ? AND hl.loaded_at <= ? AND h.project_id = ?
       ORDER BY hl.loaded_at DESC, hl.handoff_id DESC LIMIT 1`),
      findLatestDeliveryHandoff: db.prepare(`SELECT h.* FROM handoff_load AS hl
        JOIN handoff AS h ON h.handoff_id = hl.handoff_id
       WHERE hl.session_id = ? AND h.project_id = ?
       ORDER BY hl.loaded_at DESC, hl.handoff_id DESC LIMIT 1`),
      // A read tool resolves the head it should read from the running session's delivery facts alone.
      // No project predicate: the handoff a session actually loaded is the one it may read, and parent
      // traversal below still scopes itself by that head row's own project. Filtering here by the
      // watcher's project would answer "nothing loaded" about a cross-project handoff just delivered.
      // Select the delivery fact before joining its target: if GC removed that newest handoff, return
      // no head rather than letting the inner join silently fall back to an older delivery contract.
      findLatestDeliveryInSession: db.prepare(`SELECT h.* FROM (
        SELECT handoff_id FROM handoff_load
         WHERE session_id = ?
         ORDER BY loaded_at DESC, handoff_id DESC LIMIT 1
      ) AS latest JOIN handoff AS h ON h.handoff_id = latest.handoff_id`),
      getHandoff: db.prepare('SELECT * FROM handoff WHERE handoff_id = ?'),

      // Turn note CRUD
      // created_at is written on insert only and deliberately absent from the SET list: the first
      // write's timestamp is the row's own age, while a later submission only revises its content.
      upsertTurnNote: db.prepare(`INSERT INTO turn_note
        (source_session_id, anchor_uuid, u_text, u_original_chars, note, search_terms, source_timestamp, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_session_id, anchor_uuid) DO UPDATE SET
          u_text = excluded.u_text, u_original_chars = excluded.u_original_chars,
          note = excluded.note, search_terms = excluded.search_terms,
          source_timestamp = excluded.source_timestamp`),
      // No ORDER BY: the page orders by the runtime T it resolves after active-path projection,
      // so a DB order here would only look authoritative.
      listTurnNotes: db.prepare('SELECT * FROM turn_note WHERE source_session_id = ?'),

      // Sweep (GC)
      expiredSessions: db.prepare('SELECT session_id FROM sessions WHERE updated_at < ? ORDER BY updated_at ASC'),
      deleteOldHandoffs: db.prepare('DELETE FROM handoff WHERE created_at < ?'),
      // The sessions the age delete is about to take handoffs from — read before it runs, because once
      // those rows are gone nothing tells a session that just lost its last handoff apart from one that
      // never had a handoff to lose.
      sessionsWithExpiringHandoffs: db.prepare('SELECT DISTINCT session_id FROM handoff WHERE created_at < ?'),
      // Retirement granularity is the SOURCE SESSION, not the handoff: a note outlives any single
      // handoff and dies only when its session has none left. source_timestamp never decides this.
      // The NOT EXISTS is the rule, not a precaution: session scanning ages on the sweep's own window
      // while handoff retention ages on GC_HANDOFF_MAX_AGE_DAYS, so an ungated cascade would take notes
      // a handoff still loads (`store.turn-note.test.js` — `仍有存活 handoff 引用该会话时保留 turn_note`).
      deleteTurnNotesIfNoHandoff: db.prepare(`DELETE FROM turn_note
        WHERE source_session_id = ?
          AND NOT EXISTS (SELECT 1 FROM handoff AS h WHERE h.session_id = turn_note.source_session_id)`),
      loadSessionMeta: db.prepare('SELECT model, project_id FROM sessions WHERE session_id = ?'),
      insertProfilePath: db.prepare('INSERT OR REPLACE INTO profile_paths (session_id, segment, path, tokens) VALUES (?, 0, ?, ?)'),
      loadState: db.prepare('SELECT value FROM state WHERE session_id = ? AND key = ?'),

      // Line-level operations (paths + lines tables)
      clearLines: db.prepare('DELETE FROM lines WHERE session_id = ? AND path = ?'),
      insertLine: db.prepare(`INSERT INTO lines (session_id, path, line_num, chars) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path, line_num) DO UPDATE SET chars = excluded.chars`),
      upsertPath: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, 0, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET updated_at = excluded.updated_at`),
      setDelta: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET edit_delta = excluded.edit_delta, updated_at = excluded.updated_at`),
      addDelta: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET edit_delta = edit_delta + excluded.edit_delta, updated_at = excluded.updated_at`),
      pathTotal: db.prepare(`SELECT COALESCE(SUM(l.chars), 0) + COALESCE(p.edit_delta, 0) as total
        FROM paths p LEFT JOIN lines l ON l.session_id = p.session_id AND l.path = p.path
        WHERE p.session_id = ? AND p.path = ?`),
      allTotals: db.prepare(`SELECT p.path, COALESCE(SUM(l.chars), 0) + COALESCE(p.edit_delta, 0) as total
        FROM paths p LEFT JOIN lines l ON l.session_id = p.session_id AND l.path = p.path
        WHERE p.session_id = ? GROUP BY p.path`),
      clearPathMeta: db.prepare('DELETE FROM paths WHERE session_id = ? AND path = ?'),
      clearAllLines: db.prepare('DELETE FROM lines WHERE session_id = ?'),
      clearAllPathsMeta: db.prepare('DELETE FROM paths WHERE session_id = ?'),
    };
  }

  load(sessionId, key) {
    const row = this._stmts.load.get(sessionId, key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  save(sessionId, key, value, { model, projectId } = {}) {
    const now = Date.now();
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.save.run(sessionId, key, JSON.stringify(value), now);
      this._stmts.touchSession.run(sessionId, now, now, model || null, projectId || null);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  saveBatch(sessionId, entries, { model, projectId } = {}) {
    const now = Date.now();
    this._db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of entries) {
        this._stmts.save.run(sessionId, key, JSON.stringify(value), now);
      }
      this._stmts.touchSession.run(sessionId, now, now, model || null, projectId || null);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  delete(sessionId, key) {
    this._stmts.delete.run(sessionId, key);
  }

  loadSession(sessionId) {
    const rows = this._stmts.loadAll.all(sessionId);
    const map = new Map();
    for (const row of rows) {
      try { map.set(row.key, JSON.parse(row.value)); } catch { /* skip corrupt */ }
    }
    return map;
  }

  deleteSession(sessionId) {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.deleteSessionState.run(sessionId);
      this._stmts.deleteSessionPaths.run(sessionId);
      this._stmts.deleteSessionLines.run(sessionId);
      this._stmts.deleteTurnNotesIfNoHandoff.run(sessionId);
      this._stmts.deleteSessionRecord.run(sessionId);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- Config CRUD ---

  loadConfig(key) {
    const row = this._stmts.loadConfig.get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  saveConfig(key, value) {
    this._stmts.saveConfig.run(key, JSON.stringify(value));
  }

  deleteConfig(key) {
    this._stmts.deleteConfig.run(key);
  }

  // --- Profile archival ---

  archiveSession(sessionId, snapshot) {
    // Back-compat shim: session-level archive == segment 0, snapshot source.
    // Uses inner method directly — callers in a transaction (e.g. sweep) avoid nesting;
    // standalone callers get a transaction wrapper via SAVEPOINT for safety.
    const snap = { ...snapshot, archivedAt: Date.now(), archiveSource: snapshot.archiveSource || 'snapshot' };
    this._db.exec('SAVEPOINT archive_session');
    try {
      this._archiveSegmentProfileInner(sessionId, 0, snap, []);
      this._db.exec('RELEASE archive_session');
    } catch (e) {
      this._db.exec('ROLLBACK TO archive_session');
      throw e;
    }
  }

  _segmentArgs(sessionId, segment, s) {
    const priority = ARCHIVE_PRIORITY[s.archiveSource] ?? 1;
    return [sessionId, segment, s.archivedAt ?? Date.now(), s.model ?? null, s.projectId ?? null,
      s.lFloor ?? null, s.bTotal ?? null, s.lPeak ?? null, s.gFinal ?? null, s.oAvg ?? null,
      s.cRatio ?? null, s.turns ?? null, s.durationMs ?? null, s.totalTokensRead ?? null,
      s.mf ?? null, s.ppExit ?? null, s.brExit ?? null, s.brPeak ?? null, s.ppPeak ?? null,
      s.p0 ?? null, s.bAxis ?? null, s.xAxis ?? null, s.gMin ?? null, s.turnAtBrAmber ?? null,
      s.archiveSource ?? null, priority];
  }

  // R1-B: Single priority-guarded upsert. No `replace` flag — priority enforces in SQL.
  // A lower-priority writer can NEVER clobber a higher one. Paths are rewritten (DELETE+INSERT)
  // iff res.changes > 0 (a fresh insert or a qualifying higher-priority update).
  // Returns { status: 'archived' | 'already_archived', source } per R1-D.
  _archiveSegmentProfileInner(sessionId, segment, snapshot, paths) {
    const args = this._segmentArgs(sessionId, segment, snapshot);
    const res = this._stmts.archiveSegment.run(...args);
    if (res.changes > 0) {
      this._stmts.deleteSegmentPaths.run(sessionId, segment);
      for (const p of paths) this._stmts.insertSegmentPath.run(sessionId, segment, p.path, p.tokens);
      // TXN1 half of the pending handshake (Task 8, Step 3b): a profile that was actually (re)written is
      // needs-telemetry until TXN2 (archiveSegmentTelemetry) flips it to complete/complete_empty. Runs in
      // this SAME txn so a crash after the UPSERT can't leave a stale 'complete'. Gated on res.changes>0:
      // a priority-losing no-op UPSERT returns already_archived above and must NOT disturb an existing
      // complete status. capture_source is cleared alongside to keep provenance honest.
      this._stmts.markTelemetryPending.run(sessionId, segment);
      return { status: 'archived', source: snapshot.archiveSource };
    }
    return { status: 'already_archived', source: snapshot.archiveSource };
  }

  archiveSegmentProfile(sessionId, segment, snapshot, paths = []) {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      const result = this._archiveSegmentProfileInner(sessionId, segment, snapshot, paths);
      this._db.exec('COMMIT');
      return result;
    } catch (e) { this._db.exec('ROLLBACK'); throw e; }
  }

  // captureSource: 'cc-live' from the live archival wiring (Task 8), 'cc-replay' from the sweep
  // (Task 10). Recorded WITH the terminal status so provenance and status are consistent.
  archiveSegmentTelemetry(sessionId, segment, payload, captureSource = 'cc-live') {
    const steps = payload?.steps || [];
    const events = payload?.events || [];
    // NO `observed` flag. A segment that never occurred never reaches this method (the live boundary
    // and the reused replay both only call it for segments that actually boundaried), so
    // "not-observed ≠ complete_empty" is structural, not a payload check.
    let txnOpen = false;
    try {
      this._db.exec('BEGIN IMMEDIATE'); txnOpen = true;   // inside try
      // Re-read status INSIDE the write txn. A concurrent process (or the live owner racing a sweep)
      // may have completed this (session,segment) between the caller's pre-read and now — refuse to
      // clobber a completed segment. Closes the live-vs-sweep TOCTOU without a telemetry_generation
      // column (that surrogate → CST-D12). A pending/failed/NULL segment proceeds.
      const cur = this._stmts.getTelemetryStatusRow.get(sessionId, segment);   // SELECT telemetry_status …
      if (cur && (cur.telemetry_status === 'complete' || cur.telemetry_status === 'complete_empty')) {
        this._db.exec('ROLLBACK'); txnOpen = false;
        return { status: 'skipped_stale' };   // already captured by someone else — do not overwrite
      }
      this._stmts.deleteSegmentStepUsage.run(sessionId, segment);
      this._stmts.deleteSegmentPathEvents.run(sessionId, segment);
      for (const s of steps) {
        this._stmts.insertStepUsage.run(sessionId, segment, s.foldedSeq, s.ts ?? null,
          s.cacheRead ?? null, s.cacheCreation ?? null, s.input ?? null, s.output ?? null,
          s.toolCalls ?? null, s.loadToken ?? null);
      }
      for (const e of events) {
        this._stmts.insertPathEvent.run(sessionId, segment, e.foldedSeq, e.eventOrdinal,
          e.path, e.rawPath ?? e.path ?? null, e.toolType, e.isFullRead ?? null);
      }
      const status = events.length === 0 ? 'complete_empty' : 'complete';
      this._stmts.setTelemetryStatus.run(status, captureSource, sessionId, segment);
      this._db.exec('COMMIT'); txnOpen = false;
      return { status };
    } catch (e) {
      if (txnOpen) { try { this._db.exec('ROLLBACK'); } catch { /* already closed */ } }
      // TXN2 rolled back to prior good telemetry; profile (TXN1) untouched. Mark retryable. A
      // plain-INSERT duplicate (a real SAME-segment foldedSeq collision) lands HERE — loud + retryable,
      // not a silent OR REPLACE overwrite. The PK does NOT catch a *cross-segment* foldedSeq reuse; this
      // guard is about same-segment duplicates, which is what the DELETE+INSERT idempotency needs.
      // (Nested guard — the status UPDATE can itself fail if the DB is wedged; residual status stays
      //  pending/prior, which is still sweep-eligible, so this is not a permanent-pending trap.)
      try { this._stmts.setTelemetryStatusOnly.run('failed_retryable', sessionId, segment); }
      catch (e2) { if (process.env.SW_DEBUG) console.error('[telemetry-status]', e2.message); }
      if (process.env.SW_DEBUG) console.error('[archiveSegmentTelemetry]', e.message);
      return { status: 'failed_retryable' };
    }
  }

  // Task 8: small reader for the fold-side TXN2 pre-read gate (fast-path skip before the transform).
  // Returns the telemetry_status string ('pending'|'complete'|'complete_empty'|'failed_retryable') or
  // null (no profile row yet, or a legacy row that predates the column). Uses the prepared stmt shared
  // with archiveSegmentTelemetry's in-txn re-check (the authoritative anti-clobber guard).
  getTelemetryStatus(sessionId, segment) {
    const row = this._stmts.getTelemetryStatusRow.get(sessionId, segment);
    return row ? (row.telemetry_status ?? null) : null;
  }

  // Startup compensating sweep (spec §Startup compensating sweep). Runs AFTER open; MUST NOT be called
  // inside the migration transaction. Selects DISTINCT sessions with any pending/failed/NULL segment and
  // calls the injected replaySession ONCE per session — the PRODUCTION replay (carry-sweep) re-folds the
  // transcript and archives every occurred segment via handleSegmentBoundary/TXN2. A never-occurred
  // segment never boundaries → stays pending (no observed flag). The in-txn guard makes re-archiving an
  // already-complete segment a no-op. Budgets on REAL wall-clock (performance.now()); yields between
  // sessions (setImmediate) so it is genuinely chunked. Injected replaySession keeps store.js free of
  // any fold/watcher import. Returns a work summary. ASYNC.
  async backfillPendingTelemetry({ resolveTranscript, replaySession,
                                   excludeSessionIds = null, limit = 200, budgetMs = 1500,
                                   yieldBetweenSessions = true } = {}) {
    const empty = { examined: 0, replayed: 0, missing: 0, aborted: false };
    if (typeof resolveTranscript !== 'function' || typeof replaySession !== 'function') return empty;
    const excluded = excludeSessionIds == null ? new Set()
      : (excludeSessionIds instanceof Set ? excludeSessionIds : new Set([excludeSessionIds]));
    // Exclude the live session(s). Push the common single-id case into SQL (so its rows don't consume
    // the LIMIT and shrink the batch); JS-filter the rarer multi-id set after the LIMIT.
    const sqlExclude = excluded.size === 1 ? [...excluded][0] : null;
    const sessions = this._stmts.pendingTelemetrySessions.all(sqlExclude, sqlExclude, limit)
      .map(r => r.session_id).filter(sid => !excluded.has(sid));
    const summary = { examined: 0, replayed: 0, missing: 0, aborted: false };
    const deadline = performance.now() + budgetMs;   // real internal clock, always on
    for (const session_id of sessions) {
      if (performance.now() >= deadline) { summary.aborted = true; break; }   // budget exhausted
      summary.examined += 1;
      try {
        let txPath; try { txPath = resolveTranscript(session_id); } catch { txPath = null; }
        if (!txPath) { summary.missing += 1; continue; }   // gone → leave the session's segments pending
        const res = replaySession(session_id, txPath);     // production replay: archives via TXN1+TXN2
        if (res == null) { summary.missing += 1; continue; }   // unreadable transcript → leave pending
        summary.replayed += 1;
      } catch (e) {
        // One bad transcript must not abort the batch. The session stays pending, retried next boot.
        summary.missing += 1;
        if (process.env.SW_DEBUG) console.error('[telemetry-sweep session]', session_id, e.message);
      }
      if (yieldBetweenSessions) await yieldTick();   // chunk — release the loop between replays
    }
    return summary;
  }

  getProfileSegments(sessionId) {
    return this._stmts.loadProfileSegments.all(sessionId).map(Store._camelizeProfile);
  }

  // #21: camelize profile rows from DB (snake_case columns -> camelCase JS API)
  static _camelizeProfile(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id, segment: row.segment, archivedAt: row.archived_at, model: row.model,
      projectId: row.project_id,
      lFloor: row.l_floor, bTotal: row.b_total, lPeak: row.l_peak,
      gFinal: row.g_final, oAvg: row.o_avg, cRatio: row.c_ratio,
      turns: row.turns, durationMs: row.duration_ms, totalTokensRead: row.total_tokens_read,
      mf: row.mf, ppExit: row.pp_exit, brExit: row.br_exit,
      brPeak: row.br_peak, ppPeak: row.pp_peak,
      p0: row.p0, bAxis: row.b_axis, xAxis: row.x_axis,
      gMin: row.g_min, turnAtBrAmber: row.turn_at_br_amber,
      archiveSource: row.archive_source, archivePriority: row.archive_priority,
    };
  }

  getProfile(sessionId) {
    return Store._camelizeProfile(this._stmts.loadProfile.get(sessionId));
  }

  getAllProfiles() {
    return this._stmts.loadAllProfiles.all().map(Store._camelizeProfile);
  }

  // --- Sweep (GC): replay-first archive-then-delete expired sessions ---

  sweep(maxAgeMs, { now = Date.now(), isLiveSession, resolveTranscriptPath, replaySession,
                    limit = GC_BATCH_LIMIT } = {}) {
    // Age-based handoff GC (independent of session sweep — runs every call). Notes are retired here only
    // for the sessions this delete took handoffs from, and only for those it left with none: a session
    // that reached the sweep already handoff-less keeps its queue until its own row ages out. The
    // candidate read, the delete and the retirement run in ONE transaction — the retirement decides on
    // rows the delete removes, so a crash between them would leave notes whose last handoff is gone.
    try {
      const handoffCutoff = now - GC_HANDOFF_MAX_AGE_DAYS * 24 * 3600 * 1000;
      this._db.exec('BEGIN IMMEDIATE');
      const candidates = this._stmts.sessionsWithExpiringHandoffs.all(handoffCutoff);
      this._stmts.deleteOldHandoffs.run(handoffCutoff);
      for (const { session_id } of candidates) this._stmts.deleteTurnNotesIfNoHandoff.run(session_id);
      this._db.exec('COMMIT');
    } catch (e) {
      try { this._db.exec('ROLLBACK'); } catch { /* no open txn */ }
      if (process.env.SW_DEBUG) console.error('[sweep] handoff GC', e.message);
    }

    const cutoff = now - maxAgeMs;
    const expired = this._stmts.expiredSessions.all(cutoff);
    let count = 0;
    for (const { session_id } of expired) {
      if (count >= limit) break;                       // batch cap
      if (isLiveSession && isLiveSession(session_id)) continue;

      const transcriptPath = resolveTranscriptPath ? resolveTranscriptPath(session_id) : null;
      const canReplay = transcriptPath && replaySession && this._canReplay(transcriptPath);
      let archiveOk = false;
      try {
        if (canReplay) {
          replaySession(session_id, transcriptPath);
          archiveOk = true;
        } else {
          archiveOk = this._gcFromSnapshot(session_id);
        }
      } catch (e) {
        if (process.env.SW_DEBUG) console.error('[sweep] archive', session_id, e.message);
        // archiveOk stays false — session retained for retry
      }
      if (archiveOk) { this._cascadeDelete(session_id); count++; }
    }
    if (count > 0) { try { this._db.exec('PRAGMA incremental_vacuum'); } catch {} }
    return count;
  }

  _canReplay(transcriptPath) {
    try {
      const st = statSync(transcriptPath);
      return st.isFile() && st.size <= GC_REPLAY_MAX_FILE_BYTES;
    } catch { return false; }
  }

  _gcFromSnapshot(sessionId) {
    const snapRow = this._stmts.loadState.get(sessionId, 'profile_snapshot');
    const sessRow = this._stmts.loadSessionMeta.get(sessionId);
    if (!snapRow && !sessRow) return true; // nothing to archive — still considered success
    const snap = snapRow ? JSON.parse(snapRow.value) : {};
    this.archiveSegmentProfile(sessionId, snap.segment ?? 0, {
      archiveSource: 'snapshot', model: snap.model || sessRow?.model || null,
      projectId: sessRow?.project_id || null,
      bTotal: snap.b_total, gFinal: snap.g_final, lPeak: snap.l_peak, cRatio: snap.c_ratio,
      turns: snap.turns, mf: snap.mf, brExit: snap.br_exit,
    }, snap.paths || []);
    return true;
  }

  _cascadeDelete(sessionId) {
    this.deleteSession(sessionId);
  }

  // --- Line-level operations (paths + lines tables) ---

  setLines(sessionId, path, entries) {
    const now = Date.now();
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.setDelta.run(sessionId, path, 0, now); // reset editDelta
      this._stmts.clearLines.run(sessionId, path);
      for (const [lineNum, chars] of entries) {
        this._stmts.insertLine.run(sessionId, path, lineNum, chars);
      }
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  updateLines(sessionId, path, entries) {
    const now = Date.now();
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.upsertPath.run(sessionId, path, now);
      for (const [lineNum, chars] of entries) {
        this._stmts.insertLine.run(sessionId, path, lineNum, chars);
      }
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  addEditDelta(sessionId, path, delta) {
    const now = Date.now();
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.addDelta.run(sessionId, path, delta, now);
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  getPathTotal(sessionId, path) {
    const row = this._stmts.pathTotal.get(sessionId, path);
    return row ? row.total : 0;
  }

  getAllPathTotals(sessionId) {
    const rows = this._stmts.allTotals.all(sessionId);
    const map = new Map();
    for (const row of rows) map.set(row.path, row.total);
    return map;
  }

  clearPath(sessionId, path) {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.clearLines.run(sessionId, path);
      this._stmts.clearPathMeta.run(sessionId, path);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  clearAllPaths(sessionId) {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      this._stmts.clearAllLines.run(sessionId);
      this._stmts.clearAllPathsMeta.run(sessionId);
      this._db.exec('COMMIT');
    } catch (e) {
      this._db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- Handoff CRUD ---

  static _camelizeHandoff(r) {
    if (!r) return null;
    return { handoffId: r.handoff_id, sessionId: r.session_id, segment: r.segment,
      loadToken: r.load_token, createdAt: r.created_at, pathsToKeep: r.paths_to_keep,
      summary: r.summary, nextTask: r.next_task, summaryTokens: r.summary_tokens,
      keptTokens: r.kept_tokens, discardedTokens: r.discarded_tokens,
      preparedAtTurn: r.prepared_at_turn, previousStats: r.previous_stats,
      preparedStats: r.prepared_stats, searchTerms: r.search_terms,
      projectId: r.project_id, deliveredAt: r.delivered_at, deliveredSegment: r.delivered_segment,
      deliveredSessionId: r.delivered_session_id, loaderVersion: r.loader_version,
      bucketSnapshot: r.bucket_snapshot, transcriptPath: r.transcript_path };
  }

  insertHandoff(row) {
    const res = this._stmts.insertHandoff.run(
      row.sessionId, row.segment, row.loadToken, row.createdAt, row.pathsToKeep, row.summary,
      row.nextTask ?? null, row.summaryTokens, row.keptTokens ?? null, row.discardedTokens ?? null,
      row.preparedAtTurn ?? null, row.previousStats ?? null, row.preparedStats ?? null,
      row.searchTerms ?? null, row.projectId ?? null, row.bucketSnapshot ?? null,
      row.transcriptPath ?? null);
    return { handoffId: Number(res.lastInsertRowid) };
  }

  // Overwrite paths_to_keep with per-entry telemetry (content_hash_load stamping). Fire-and-forget:
  // the caller has already committed the claim; this is a post-txn back-fill of hl on the stored row.
  stampContentHashLoad(handoffId, pathsToKeepJson) {
    this._stmts.stampPathsToKeep.run(pathsToKeepJson, handoffId);
  }

  insertHandoffLoad({ handoffId, sessionId, loadedAt, loaderVersion, claimResult, primarySessionId, consumerSegment }) {
    this._stmts.insertHandoffLoad.run(handoffId, sessionId, loadedAt, loaderVersion ?? null,
      claimResult, primarySessionId ?? null, consumerSegment ?? null);
  }

  updateHandoff(token, row) {
    const res = this._stmts.updateHandoff.run(
      row.pathsToKeep, row.summary, row.nextTask ?? null,
      row.summaryTokens, row.keptTokens ?? null, row.discardedTokens ?? null,
      row.preparedAtTurn ?? null, row.previousStats ?? null, row.preparedStats ?? null,
      row.searchTerms ?? null, row.bucketSnapshot ?? null, row.transcriptPath ?? null, token);
    return res.changes > 0;
  }

  // PURE classifier: given the committed handoff row + this caller's session, what is the claim
  // relationship? Used by the txn body AND the catch path so both agree on committed state.
  static _classifyClaim(row, sessionId) {
    if (row.delivered_session_id != null && row.delivered_session_id !== sessionId) {
      return { claimResult: 'duplicate', primarySessionId: row.delivered_session_id };
    }
    // A legacy delivery we just bound (or that a concurrent caller bound) reads as legacy_unattributed
    // for the binder; a fresh binding / same-session retry reads as primary. The binder tags its own
    // result explicitly below via `legacyBind`; here we only cover the read-back cases.
    return { claimResult: 'primary', primarySessionId: null };
  }

  loadHandoffByToken(token, opts = {}) {
    const row = this._stmts.loadHandoffToken.get(token);
    if (!row) return null;
    const { sessionId = null, loaderVersion = null, consumerSegment = null } = opts;

    // Session-less / legacy caller: pure read. Do NOT stamp the binding or record an attempt — a
    // NULL-consumer stamp would permanently block a real later consumer.
    if (sessionId == null) {
      const out = Store._camelizeHandoff(row);
      out.claimResult = 'primary'; out.claimedNow = false;
      return out;
    }

    const now = Date.now();
    let claimResult = 'primary';
    let primarySessionId = null;
    let claimedNow = false;
    let legacyBind = false;

    // Binding CAS + attempt insert in ONE transaction. Fail-closed: on any error, roll back and
    // return no content (see the catch below).
    try {
      this._db.exec('BEGIN IMMEDIATE');
      if (row.delivered_at == null) {
        // First delivery: CAS-stamp the primary binding. If another process stamped between our
        // SELECT and UPDATE, changes === 0 → re-read and fall through to the classify check.
        const { changes } = this._stmts.markDelivered.run(now, sessionId, consumerSegment, loaderVersion, row.handoff_id);
        if (changes > 0) {
          claimedNow = true;
          row.delivered_at = now; row.delivered_session_id = sessionId;
          row.delivered_segment = consumerSegment; row.loader_version = loaderVersion;
        } else {
          Object.assign(row, this._stmts.loadHandoffToken.get(token));
        }
      } else if (row.delivered_session_id == null) {
        // A migrated v2 delivery with an unknown consumer. Bind the first v3 consumer WITHOUT
        // overwriting delivered_at. Guarded IS NULL → fires at most once.
        const { changes } = this._stmts.markDeliveredLegacy.run(sessionId, consumerSegment, loaderVersion, row.handoff_id);
        if (changes > 0) {
          legacyBind = true; claimedNow = true;
          row.delivered_session_id = sessionId; row.delivered_segment = consumerSegment;
          row.loader_version = loaderVersion;
        } else {
          Object.assign(row, this._stmts.loadHandoffToken.get(token));
        }
      }
      ({ claimResult, primarySessionId } = Store._classifyClaim(row, sessionId));
      if (legacyBind) claimResult = 'legacy_unattributed';   // the binder of a legacy row
      this._stmts.insertHandoffLoad.run(row.handoff_id, sessionId, now, loaderVersion ?? null,
        claimResult, primarySessionId ?? null, consumerSegment ?? null);
      this._db.exec('COMMIT');
    } catch (e) {
      try { this._db.exec('ROLLBACK'); } catch { /* no open txn */ }
      if (process.env.SW_DEBUG) console.error('[handoff_load]', e.message);
      // Fail-closed: delivery write and CAS stamp are one atomic unit. If the unit fails,
      // no content is returned — the response deliberately carries no content fields so the caller
      // can retry cleanly. Retry idempotency is already guaranteed by markDelivered /
      // markDeliveredLegacy's IS NULL guards and INSERT OR IGNORE; no backoff belongs here (§5).
      return { ok: false, error: 'handoff_delivery_unavailable', retryable: true };
    }

    const out = Store._camelizeHandoff(row);
    out.claimResult = claimResult;
    out.claimedNow = claimedNow;
    return out;
  }

  hasHandoff(token) {
    return !!this._stmts.handoffExists.get(token);
  }

  // R1-H: project-scoped — filters by project_id when provided (NULL = any project).
  loadHandoffBySession(sid, { projectId = null } = {}) {
    return Store._camelizeHandoff(this._stmts.loadHandoffSession.get(sid, projectId, projectId));
  }

  loadHandoffByProject(projectId, sessionId, { ttlMs = 7 * 86400000 } = {}) {
    if (!projectId) return { rows: [], ambiguous: false };
    const cutoff = Date.now() - ttlMs;
    const rows = this._stmts.loadHandoffByProject.all(projectId, sessionId, cutoff)
      .map(Store._camelizeHandoff);
    return { rows, ambiguous: rows.length > 1 };
  }

  // R1-H: project-scoped FTS search. Statement prepared LAZILY (handoff_fts may not exist).
  searchHandoff(matchExpr, { projectId = null, limit = 3 } = {}) {
    if (!this.ftsAvailable) return [];
    if (!this._searchStmt) {
      this._searchStmt = this._db.prepare(`SELECT h.load_token, h.created_at, h.next_task,
        substr(h.summary, 1, 200) AS summary_preview
        FROM handoff_fts JOIN handoff h ON h.handoff_id = handoff_fts.rowid
        WHERE handoff_fts MATCH ? AND (h.project_id = ? OR ? IS NULL)
        ORDER BY rank LIMIT ?`);
    }
    return this._searchStmt.all(matchExpr, projectId, projectId, limit).map(r => ({
      loadToken: r.load_token, createdAt: r.created_at, nextTask: r.next_task, summaryPreview: r.summary_preview,
    }));
  }


  // --- Bookmark CRUD ---

  static _camelizeBookmark(r) {
    if (!r) return null;
    return {
      bookmarkId: r.bookmark_id,
      projectId: r.project_id,
      sourceSessionId: r.source_session_id,
      anchorUuid: r.anchor_uuid,
      role: r.role,
      previewText: r.preview_text,
      originalChars: r.original_chars,
      truncated: r.truncated,
      sourceTimestamp: r.source_timestamp,
      createdAt: r.created_at,
      active: r.active,
    };
  }

  // Insert or re-activate a bookmark. Immutable fields (preview, role, timestamp, created_at)
  // are never overwritten on conflict — only `active` is flipped to 1. After the upsert the
  // canonical row is read back by identity and returned so callers always get a stable bookmarkId.
  upsertBookmark(row) {
    this._stmts.upsertBookmark.run(
      row.projectId, row.sourceSessionId, row.anchorUuid, row.role, row.previewText,
      row.originalChars, row.truncated, row.sourceTimestamp, row.createdAt);
    return Store._camelizeBookmark(
      this._stmts.getBookmarkByIdentity.get(row.projectId, row.sourceSessionId, row.anchorUuid));
  }

  getBookmarkById(projectId, bookmarkId) {
    return Store._camelizeBookmark(this._stmts.getBookmarkById.get(bookmarkId, projectId));
  }

  getBookmarkByIdentity(projectId, sourceSessionId, anchorUuid) {
    return Store._camelizeBookmark(
      this._stmts.getBookmarkByIdentity.get(projectId, sourceSessionId, anchorUuid));
  }

  deactivateBookmark(projectId, sourceSessionId, anchorUuid) {
    this._stmts.deactivateBookmark.run(projectId, sourceSessionId, anchorUuid);
  }

  listActiveBookmarksForSession(projectId, sourceSessionId) {
    return this._stmts.listActiveBookmarksForSession.all(projectId, sourceSessionId)
      .map(Store._camelizeBookmark);
  }

  // Non-transactional peek: returns the id that WOULD be assigned to the next INSERT.
  // Falls back to 1 when the bookmark table is empty (sqlite_sequence row absent).
  peekNextBookmarkId() {
    const row = this._stmts.peekNextBookmarkId.get();
    return row ? row.seq + 1 : 1;
  }

  // The handoff whose delivery into `sessionId` happened no later than `createdAt` — i.e. the
  // parent of the handoff that `sessionId` went on to prepare at `createdAt`.
  findParentDelivery(projectId, sessionId, createdAt) {
    return Store._camelizeHandoff(this._stmts.findParentDelivery.get(sessionId, createdAt, projectId));
  }

  // The latest handoff delivered into `sessionId` with no cutoff — the head for a running session.
  findLatestDeliveryHandoff(projectId, sessionId) {
    return Store._camelizeHandoff(this._stmts.findLatestDeliveryHandoff.get(sessionId, projectId));
  }

  // The newest handoff this session actually loaded, across every project — the head the turn read
  // tools resolve without being handed one.
  findLatestDeliveryInSession(sessionId) {
    return Store._camelizeHandoff(this._stmts.findLatestDeliveryInSession.get(sessionId));
  }

  // An explicit handoff_id already names one row, so no caller project filter is applied; the
  // returned row's projectId is the scope the lineage walk then uses.
  getHandoff(handoffId) {
    return Store._camelizeHandoff(this._stmts.getHandoff.get(handoffId));
  }

  // --- Turn note CRUD ---

  static _camelizeTurnNote(r) {
    if (!r) return null;
    return {
      turnNoteId: r.turn_note_id,
      sourceSessionId: r.source_session_id,
      anchorUuid: r.anchor_uuid,
      uText: r.u_text,
      uOriginalChars: r.u_original_chars,
      note: r.note,
      searchTerms: r.search_terms,
      sourceTimestamp: r.source_timestamp,
      createdAt: r.created_at,
    };
  }

  // Whole-batch atomicity: one bad row rolls the entire submission back, so a caller never has to
  // reason about a half-written turn queue. exec, not prepare — prepare('BEGIN IMMEDIATE') only
  // compiles the statement and would silently leave every write outside a transaction.
  upsertTurnNotes(rows) {
    this._db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) this._stmts.upsertTurnNote.run(
        r.sourceSessionId, r.anchorUuid, r.uText, r.uOriginalChars, r.note ?? null,
        r.searchTerms, r.sourceTimestamp, Date.now());
      this._db.exec('COMMIT');
    } catch (err) {
      try { this._db.exec('ROLLBACK'); } catch { /* no open txn */ }
      throw err;
    }
  }

  listTurnNotes(sessionId) {
    return this._stmts.listTurnNotes.all(sessionId).map(Store._camelizeTurnNote);
  }

  // FTS locate across a lineage's sessions. The IN list is variable-length (lineage depth), so the
  // statement is built and prepared per call — the set is tiny. No LIMIT: the top rows are taken
  // after the caller validates each anchor against the active path, which can drop matches.
  locateTurnNotes(sessionIds, matchExpr) {
    if (!sessionIds || sessionIds.length === 0) return [];
    const holes = sessionIds.map(() => '?').join(',');
    const sql = `SELECT tn.* FROM turn_note_fts
      JOIN turn_note AS tn ON tn.turn_note_id = turn_note_fts.rowid
     WHERE turn_note_fts MATCH ? AND tn.source_session_id IN (${holes})
     ORDER BY bm25(turn_note_fts) ASC, tn.source_timestamp DESC, tn.source_session_id, tn.anchor_uuid`;
    return this._db.prepare(sql).all(matchExpr, ...sessionIds).map(Store._camelizeTurnNote);
  }

  turnFtsAvailable() {
    return this._turnFtsAvailable === true;
  }

  resetForTesting() {
    closeStoreGlobal();
  }
}

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });  // #1: ensure parent dir exists on fresh install
  const db = new DatabaseSync(dbPath, { timeout: 3000 });
  try {
    const walResult = db.prepare('PRAGMA journal_mode=WAL').get();
    const actualMode = String(walResult.journal_mode ?? '').toLowerCase();
    if (actualMode !== 'wal' && dbPath !== ':memory:') {
      console.error(`[store] WAL unavailable (got ${actualMode}). Check local filesystem.`);
    }
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    const fts = migrate(db);
    const store = new Store(db);
    store.ftsAvailable = fts.handoffFtsAvailable;
    store._turnFtsAvailable = fts.turnFtsAvailable;   // read only through turnFtsAvailable()
    return store;
  } catch (err) {
    try { db.close(); } catch {}  // #5: don't leak fd on init failure
    throw err;
  }
}

export function closeStore(store) {
  if (store._closed) return;  // #6: idempotent
  store._closed = true;
  store._db.close();
}

// Module-level singleton
let _instance = null;
export function defaultDbPath() {
  return join(homedir(), '.session-watcher', 'store.sqlite');
}
export function initStore(dbPath) {
  if (_instance) closeStore(_instance);  // #4: prevent connection leak on re-init
  _instance = openStore(dbPath || defaultDbPath());
  return _instance;
}
export function getStore() { if (!_instance) throw new Error('Store not initialized'); return _instance; }
export function closeStoreGlobal() { if (_instance) { closeStore(_instance); _instance = null; } }
