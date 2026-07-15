import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let store, dbPath, dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-store-'));
  dbPath = join(dir, 'test.sqlite');
});
afterEach(async () => {
  if (store) { const { closeStore } = await import('../lib/store.js'); closeStore(store); store = null; }
  rmSync(dir, { recursive: true, force: true });
});

test('openStore creates DB and returns store', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  assert.ok(store);
  closeStore(store);
  store = null;
});

test('load returns null for nonexistent key', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  assert.equal(store.load('sid1', 'missing'), null);
});

test('save + load roundtrip', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  const obj = { a: 1, nested: { b: [2, 3] } };
  store.save('sid1', 'ledger', obj);
  assert.deepEqual(store.load('sid1', 'ledger'), obj);
});

test('save with model and projectId touches sessions metadata', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.save('sid1', 'ledger', { x: 1 }, { model: 'claude-sonnet-4', projectId: 'proj-abc' });
  // subsequent save without model/projectId does not overwrite
  store.save('sid1', 'ledger', { x: 2 });
  const row = store._db.prepare('SELECT model, project_id FROM sessions WHERE session_id = ?').get('sid1');
  assert.equal(row.model, 'claude-sonnet-4');
  assert.equal(row.project_id, 'proj-abc');
});

test('saveBatch is atomic — success', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.saveBatch('sid1', [['ledger', { a: 1 }], ['gate', { b: 2 }]]);
  assert.deepEqual(store.load('sid1', 'ledger'), { a: 1 });
  assert.deepEqual(store.load('sid1', 'gate'), { b: 2 });
});

test('saveBatch is atomic — rollback on mid-batch failure', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  const circular = {}; circular.self = circular;  // JSON.stringify will throw
  assert.throws(() => {
    store.saveBatch('sid1', [['ok', { a: 1 }], ['bad', circular]]);
  });
  // First entry must NOT be persisted (transaction rolled back)
  assert.equal(store.load('sid1', 'ok'), null);
});

test('delete removes a key', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.save('sid1', 'ledger', { x: 1 });
  store.delete('sid1', 'ledger');
  assert.equal(store.load('sid1', 'ledger'), null);
});

test('loadSession returns all keys for a session', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.save('sid1', 'ledger', { a: 1 });
  store.save('sid1', 'gate', { b: 2 });
  store.save('sid2', 'ledger', { c: 3 });
  const map = store.loadSession('sid1');
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('ledger'), { a: 1 });
  assert.deepEqual(map.get('gate'), { b: 2 });
});

test('deleteSession removes all data for a session', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.save('sid1', 'ledger', { a: 1 });
  store.save('sid1', 'gate', { b: 2 });
  store.deleteSession('sid1');
  assert.equal(store.load('sid1', 'ledger'), null);
  assert.equal(store.load('sid1', 'gate'), null);
});

test('schema migration is idempotent', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.save('sid1', 'x', { v: 1 });
  closeStore(store);
  // reopen same DB
  store = openStore(dbPath);
  assert.deepEqual(store.load('sid1', 'x'), { v: 1 });
});

test('closeStore is idempotent — double close does not throw', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  closeStore(store);
  closeStore(store);  // second call must not throw
  store = null;
});

test('initStore closes previous instance before reinit', async () => {
  const { initStore, getStore, closeStoreGlobal } = await import('../lib/store.js');
  const s1 = initStore(dbPath);
  s1.save('sid1', 'k', { v: 1 });
  // reinit to a new path — old instance should be closed
  const dbPath2 = join(dir, 'test2.sqlite');
  const s2 = initStore(dbPath2);
  assert.notEqual(s1, s2);
  assert.equal(getStore(), s2);
  closeStoreGlobal();
});

test('getStore throws if not initialized', async () => {
  const { getStore, closeStoreGlobal } = await import('../lib/store.js');
  closeStoreGlobal();  // ensure clean slate
  assert.throws(() => getStore(), /Store not initialized/);
});

test('openStore creates parent directories', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const nested = join(dir, 'a', 'b', 'c', 'deep.sqlite');
  store = openStore(nested);
  assert.ok(store);
  closeStore(store);
  store = null;
});

// --- Config CRUD ---

test('config: save + load roundtrip', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.saveConfig('pricing:opus', { ratio: 5, readPrice: 15 });
  assert.deepEqual(store.loadConfig('pricing:opus'), { ratio: 5, readPrice: 15 });
});

test('config: load nonexistent returns null', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  assert.equal(store.loadConfig('nope'), null);
});

test('config: deleteConfig removes key', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.saveConfig('k', { v: 1 });
  store.deleteConfig('k');
  assert.equal(store.loadConfig('k'), null);
});

// --- Profile archival ---

test('archiveSession writes profile row with all fields (camelCase API)', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.archiveSession('sid1', { model: 'opus', projectId: 'proj-x', turns: 10, durationMs: 5000, brPeak: 0.18, totalTokensRead: 50000 });
  const p = store.getProfile('sid1');
  assert.equal(p.model, 'opus');
  assert.equal(p.projectId, 'proj-x');
  assert.equal(p.turns, 10);
  assert.equal(p.brPeak, 0.18);
  assert.equal(p.totalTokensRead, 50000);
});

test('getAllProfiles returns all profiles descending', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.archiveSession('s1', { model: 'a' });
  store.archiveSession('s2', { model: 'b' });
  const all = store.getAllProfiles();
  assert.equal(all.length, 2);
  // Most recent archivedAt first (camelCase from _camelizeProfile)
  assert.ok(all[0].archivedAt >= all[1].archivedAt);
});

// --- Sweep (GC) ---

test('sweep archives and deletes expired sessions', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  // Manually insert an old session
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)').run('old1', old, old);
  store._db.prepare("INSERT INTO state (session_id, key, value, updated_at) VALUES ('old1', 'ledger', '{}', ?)").run(old);
  // Fresh session
  store.save('fresh1', 'ledger', { x: 1 });

  const count = store.sweep(7 * 24 * 3600 * 1000, { now: Date.now() });
  assert.equal(count, 1);
  assert.equal(store.load('old1', 'ledger'), null);
  assert.deepEqual(store.load('fresh1', 'ledger'), { x: 1 });
  // profile was created for old1
  const p = store.getProfile('old1');
  assert.ok(p);
});

test('sweep skips sessions with live port file', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)').run('live1', old, old);
  const isLive = (sid) => sid === 'live1';
  const count = store.sweep(7 * 24 * 3600 * 1000, { now: Date.now(), isLiveSession: isLive });
  assert.equal(count, 0);
});

// --- Line-level operations (paths + lines tables) ---

test('setLines: clears old + inserts new, resets editDelta', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  // Pre-existing editDelta
  store.addEditDelta('s1', '/a.js', 100);
  // setLines = full Read snapshot → resets editDelta to 0
  store.setLines('s1', '/a.js', [[1, 50], [2, 30], [3, 20]]);
  assert.equal(store.getPathTotal('s1', '/a.js'), 100); // 50+30+20 + 0 editDelta
  // setLines again replaces old data
  store.setLines('s1', '/a.js', [[1, 10]]);
  assert.equal(store.getPathTotal('s1', '/a.js'), 10);
});

test('updateLines: preserves editDelta, upserts lines', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.addEditDelta('s1', '/b.js', 50);
  store.updateLines('s1', '/b.js', [[1, 20], [2, 30]]);
  // total = SUM(chars) + editDelta = 50 + 50 = 100
  assert.equal(store.getPathTotal('s1', '/b.js'), 100);
  // update existing line
  store.updateLines('s1', '/b.js', [[1, 25]]);
  // total = 25 + 30 + 50 = 105
  assert.equal(store.getPathTotal('s1', '/b.js'), 105);
});

test('addEditDelta: accumulates on existing path', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.addEditDelta('s1', '/c.js', 10);
  store.addEditDelta('s1', '/c.js', 20);
  assert.equal(store.getPathTotal('s1', '/c.js'), 30); // no lines, just delta
});

test('getPathTotal: returns 0 for unknown path', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  assert.equal(store.getPathTotal('s1', '/unknown'), 0);
});

test('getAllPathTotals: returns map of all paths', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.setLines('s1', '/a.js', [[1, 10]]);
  store.addEditDelta('s1', '/b.js', 5);
  const map = store.getAllPathTotals('s1');
  assert.equal(map.get('/a.js'), 10);
  assert.equal(map.get('/b.js'), 5);
});

test('clearPath: removes lines + path row', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.setLines('s1', '/a.js', [[1, 10]]);
  store.clearPath('s1', '/a.js');
  assert.equal(store.getPathTotal('s1', '/a.js'), 0);
});

test('clearAllPaths: removes all lines + paths for session', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.setLines('s1', '/a.js', [[1, 10]]);
  store.setLines('s1', '/b.js', [[1, 20]]);
  store.clearAllPaths('s1');
  const map = store.getAllPathTotals('s1');
  assert.equal(map.size, 0);
});

test('paths invariant: setLines always creates paths row', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(dbPath);
  store.setLines('s1', '/x.js', [[1, 5]]);
  const pathRow = store._db.prepare('SELECT * FROM paths WHERE session_id = ? AND path = ?').get('s1', '/x.js');
  assert.ok(pathRow, 'paths row must exist after setLines');
  assert.equal(pathRow.edit_delta, 0);
});

// --- resetForTesting ---

test('resetForTesting closes and nullifies singleton', async () => {
  const { initStore, getStore, closeStoreGlobal } = await import('../lib/store.js');
  const s = initStore(dbPath);
  assert.ok(getStore());
  s.resetForTesting();
  assert.throws(() => getStore(), /Store not initialized/);
});
