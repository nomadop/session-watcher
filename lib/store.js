import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

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

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_project_id ON profile(project_id);
`;

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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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

      // Profile archival
      archiveSession: db.prepare(`INSERT INTO profile (session_id, archived_at, model, project_id,
        l_floor, b_total, l_peak, g_final, o_avg, c_ratio, turns, duration_ms, total_tokens_read,
        mf, pp_exit, br_exit, br_peak, pp_peak,
        p0, b_axis, x_axis, g_min, turn_at_br_amber)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET
          archived_at = excluded.archived_at, model = excluded.model,
          project_id = excluded.project_id,
          l_floor = excluded.l_floor, b_total = excluded.b_total,
          l_peak = excluded.l_peak, g_final = excluded.g_final,
          o_avg = excluded.o_avg, c_ratio = excluded.c_ratio,
          turns = excluded.turns, duration_ms = excluded.duration_ms,
          total_tokens_read = excluded.total_tokens_read,
          mf = excluded.mf, pp_exit = excluded.pp_exit, br_exit = excluded.br_exit,
          br_peak = excluded.br_peak, pp_peak = excluded.pp_peak,
          p0 = excluded.p0, b_axis = excluded.b_axis, x_axis = excluded.x_axis,
          g_min = excluded.g_min, turn_at_br_amber = excluded.turn_at_br_amber`),
      loadProfile: db.prepare('SELECT * FROM profile WHERE session_id = ?'),
      loadAllProfiles: db.prepare('SELECT * FROM profile ORDER BY archived_at DESC'),

      // Sweep (GC)
      expiredSessions: db.prepare('SELECT session_id FROM sessions WHERE updated_at < ?'),
      loadSessionMeta: db.prepare('SELECT model, project_id FROM sessions WHERE session_id = ?'),

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
    const now = Date.now();
    // JS API uses camelCase; Store maps to snake_case DB columns internally (#21)
    this._stmts.archiveSession.run(
      sessionId, now, snapshot.model || null, snapshot.projectId || null,
      snapshot.lFloor ?? null, snapshot.bTotal ?? null, snapshot.lPeak ?? null,
      snapshot.gFinal ?? null, snapshot.oAvg ?? null, snapshot.cRatio ?? null,
      snapshot.turns ?? null, snapshot.durationMs ?? null, snapshot.totalTokensRead ?? null,
      snapshot.mf ?? null, snapshot.ppExit ?? null, snapshot.brExit ?? null,
      snapshot.brPeak ?? null, snapshot.ppPeak ?? null,
      snapshot.p0 ?? null, snapshot.bAxis ?? null, snapshot.xAxis ?? null,
      snapshot.gMin ?? null, snapshot.turnAtBrAmber ?? null,
    );
  }

  // #21: camelize profile rows from DB (snake_case columns -> camelCase JS API)
  static _camelizeProfile(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id, archivedAt: row.archived_at, model: row.model,
      projectId: row.project_id,
      lFloor: row.l_floor, bTotal: row.b_total, lPeak: row.l_peak,
      gFinal: row.g_final, oAvg: row.o_avg, cRatio: row.c_ratio,
      turns: row.turns, durationMs: row.duration_ms, totalTokensRead: row.total_tokens_read,
      mf: row.mf, ppExit: row.pp_exit, brExit: row.br_exit,
      brPeak: row.br_peak, ppPeak: row.pp_peak,
      p0: row.p0, bAxis: row.b_axis, xAxis: row.x_axis,
      gMin: row.g_min, turnAtBrAmber: row.turn_at_br_amber,
    };
  }

  getProfile(sessionId) {
    return Store._camelizeProfile(this._stmts.loadProfile.get(sessionId));
  }

  getAllProfiles() {
    return this._stmts.loadAllProfiles.all().map(Store._camelizeProfile);
  }

  // --- Sweep (GC): archive-then-delete expired sessions ---

  sweep(maxAgeMs, { now = Date.now(), isLiveSession } = {}) {
    const cutoff = now - maxAgeMs;
    const expired = this._stmts.expiredSessions.all(cutoff);
    let count = 0;
    for (const { session_id } of expired) {
      if (isLiveSession && isLiveSession(session_id)) continue;
      this._db.exec('BEGIN IMMEDIATE');
      try {
        // Archive to profile (nulls for pre-v3 fields)
        const sessRow = this._stmts.loadSessionMeta.get(session_id);
        this.archiveSession(session_id, { model: sessRow?.model || null, projectId: sessRow?.project_id || null });
        // Cascade delete
        this._stmts.deleteSessionState.run(session_id);
        this._stmts.deleteSessionPaths.run(session_id);
        this._stmts.deleteSessionLines.run(session_id);
        this._stmts.deleteSessionRecord.run(session_id);
        this._db.exec('COMMIT');
        count++;
      } catch (e) {
        this._db.exec('ROLLBACK');
        console.error('[store] sweep: failed to archive/delete session', session_id, e.message);
        continue;
      }
    }
    if (count > 0) this._db.exec('PRAGMA incremental_vacuum');
    return count;
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
    if (actualMode !== 'wal') {
      console.error(`[store] WAL unavailable (got ${actualMode}). Check local filesystem.`);
    }
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    migrate(db);
    return new Store(db);
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
  const base = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.session-watcher');
  return join(base, 'store.sqlite');
}
export function initStore(dbPath) {
  if (_instance) closeStore(_instance);  // #4: prevent connection leak on re-init
  _instance = openStore(dbPath || defaultDbPath());
  return _instance;
}
export function getStore() { if (!_instance) throw new Error('Store not initialized'); return _instance; }
export function closeStoreGlobal() { if (_instance) { closeStore(_instance); _instance = null; } }
