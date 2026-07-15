import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal, getStore } from '../lib/store.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-reaper-'));
  initStore(join(dir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(d, name, obj) {
  const p = join(d, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function setMtimeOld(path, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(path, t, t);
}

test('sweepStaleState removes expired sessions from store', async () => {
  const { sweepStaleState } = await import('../lib/state-reaper.js');
  const store = getStore();
  // Insert an old session directly
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)').run('old1', old, old);
  store._db.prepare("INSERT INTO state (session_id, key, value, updated_at) VALUES ('old1', 'ledger', '{}', ?)").run(old);
  // Fresh session
  store.save('fresh1', 'ledger', { x: 1 });
  const count = sweepStaleState();
  assert.equal(count, 1);
  assert.equal(store.load('old1', 'ledger'), null);
  assert.deepEqual(store.load('fresh1', 'ledger'), { x: 1 });
});

test('sweepStaleState respects custom maxAgeMs', async () => {
  const { sweepStaleState } = await import('../lib/state-reaper.js');
  const store = getStore();
  // Insert a session that is 2 days old
  const twoDay = Date.now() - 2 * 24 * 3600 * 1000;
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)').run('med1', twoDay, twoDay);
  // Default 7-day max: should NOT sweep
  assert.equal(sweepStaleState(), 0);
  // 1-day max: should sweep
  assert.equal(sweepStaleState({ maxAgeMs: 1 * 24 * 3600 * 1000 }), 1);
});

test('sweepStalePortFiles removes old port files with dead pid', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  const p = writeJson(portDir, 'dead.json', { pid: 99999999, port: 12345 });
  setMtimeOld(p, 10);
  const count = sweepStalePortFiles(portDir);
  assert.equal(count, 1);
  rmSync(portDir, { recursive: true, force: true });
});

test('sweepStalePortFiles skips files with live pid', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  const p = writeJson(portDir, 'live.json', { pid: process.pid, port: 12345 });
  setMtimeOld(p, 10);
  const count = sweepStalePortFiles(portDir);
  assert.equal(count, 0);
  rmSync(portDir, { recursive: true, force: true });
});

test('sweepStalePortFiles skips fresh files', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  writeJson(portDir, 'fresh.json', { pid: 99999999, port: 12345 });
  // No mtime change — it's fresh
  const count = sweepStalePortFiles(portDir);
  assert.equal(count, 0);
  rmSync(portDir, { recursive: true, force: true });
});

test('sweepStalePortFiles handles missing directory gracefully', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  assert.equal(sweepStalePortFiles('/nonexistent-dir-xyz'), 0);
});

test('sweepStalePortFiles removes old file with non-numeric pid', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  const p = writeJson(portDir, 'corrupt.json', { pid: "abc", port: 12345 });
  setMtimeOld(p, 10);
  assert.equal(sweepStalePortFiles(portDir), 1);
  rmSync(portDir, { recursive: true, force: true });
});
