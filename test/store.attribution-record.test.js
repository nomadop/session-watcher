// test/store.attribution-record.test.js — the Attribution Record table: first write kept, opaque JSON out.
//
// The store holds the record as text it never interprets; its shape belongs to the tool-evidence
// interpreter. What the store owns is the key, first-write-wins, the miss answers, retention with the
// session, and the table's presence on every open (ADR 0025).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore, closeStore } from '../lib/store.js';

let dir, dbPath, store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-attr-record-')); dbPath = join(dir, 't.sqlite'); store = openStore(dbPath); });
afterEach(() => { closeStore(store); rmSync(dir, { recursive: true, force: true }); });

const stampOf = (db) => db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value;
const hasTable = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attribution_record'").get();

const recordA = { v: 1, effects: [{ access: 'read', impacts: [] }], residual: null };
const recordB = { v: 1, effects: [], residual: { groupKey: 'g', kind: 'k', detail: 'd', weight: 3 } };

// Close the store, run `mutate` on the raw database, reopen. The test's own store variable follows.
function reopenAfter(mutate) {
  closeStore(store);
  const raw = new DatabaseSync(dbPath);
  mutate(raw);
  raw.close();
  store = openStore(dbPath);
}

test('recallAttribution of an absent key is null', () => {
  assert.equal(store.recallAttribution('sess-A', 'tu-1'), null);
});

test('remember then recall round-trips the record deep-equal', () => {
  assert.equal(store.rememberAttribution('sess-A', 'tu-1', recordA), undefined);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-1'), recordA);
});

test('a record is keyed by session and tool use together', () => {
  store.rememberAttribution('sess-A', 'tu-1', recordA);
  store.rememberAttribution('sess-A', 'tu-2', recordB);
  store.rememberAttribution('sess-B', 'tu-1', recordB);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-1'), recordA);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-2'), recordB);
  assert.deepEqual(store.recallAttribution('sess-B', 'tu-1'), recordB);
});

test('a second remember with a different record leaves the first recalled', () => {
  store.rememberAttribution('sess-A', 'tu-1', recordA);
  store.rememberAttribution('sess-A', 'tu-1', recordB);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-1'), recordA);
});

test('unparsable stored text and a stored non-object recall as null', () => {
  const insert = store._db.prepare('INSERT INTO attribution_record (session_id, tool_use_id, record) VALUES (?, ?, ?)');
  const stored = { 'tu-broken': '{not json', 'tu-null': 'null', 'tu-number': '7', 'tu-string': '"text"', 'tu-array': '[1]' };
  for (const [toolUseId, text] of Object.entries(stored)) insert.run('sess-A', toolUseId, text);
  for (const toolUseId of Object.keys(stored)) {
    assert.equal(store.recallAttribution('sess-A', toolUseId), null, toolUseId);
  }
});

test('a database without the table gains it on open and keeps its other tables', () => {
  store.save('sess-A', 'k', { kept: true });
  reopenAfter(raw => raw.exec('DROP TABLE IF EXISTS attribution_record'));
  assert.ok(hasTable(store._db));
  assert.deepEqual(store.load('sess-A', 'k'), { kept: true });
  store.rememberAttribution('sess-A', 'tu-1', recordA);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-1'), recordA);
});

test('a store stamped above the ladder gains the table, keeps the stamp, and the table is usable', () => {
  // Seeded as test/store-migration-forward.test.js seeds it, with the table removed to stand for a
  // store a binary without it migrated.
  let above;
  reopenAfter(raw => {
    above = String(Number(stampOf(raw)) + 1000);
    raw.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(above);
    raw.exec('DROP TABLE IF EXISTS attribution_record');
  });
  assert.ok(hasTable(store._db));
  assert.equal(stampOf(store._db), above, 'the stamp is not lowered');
  store.rememberAttribution('sess-A', 'tu-1', recordA);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-1'), recordA);
  closeStore(store);
  const raw = new DatabaseSync(dbPath);
  assert.equal(stampOf(raw), above, 'the stamp on disk is not lowered');
  raw.close();
  store = openStore(dbPath);
});

test('deleteSession removes that session\'s records and leaves another session\'s', () => {
  store.rememberAttribution('sess-A', 'tu-1', recordA);
  store.rememberAttribution('sess-A', 'tu-2', recordB);
  store.rememberAttribution('sess-B', 'tu-1', recordB);
  store.deleteSession('sess-A');
  assert.equal(store.recallAttribution('sess-A', 'tu-1'), null);
  assert.equal(store.recallAttribution('sess-A', 'tu-2'), null);
  assert.deepEqual(store.recallAttribution('sess-B', 'tu-1'), recordB);
});

test('a record written after deleteSession is kept like any first write', () => {
  store.rememberAttribution('sess-A', 'tu-1', recordA);
  store.deleteSession('sess-A');
  store.rememberAttribution('sess-A', 'tu-1', recordB);
  assert.deepEqual(store.recallAttribution('sess-A', 'tu-1'), recordB);
});
