// test/store-migration-forward.test.js — opening a store a newer binary already migrated.
//
// The ladder's top stamp is read from a fresh store, and the seeded stamp is set above it, so these cases
// keep describing a newer binary's store whatever the ladder's top becomes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openStore, closeStore } from '../lib/store.js';

let dir, dbPath;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-mig-forward-')); dbPath = join(dir, 't.sqlite'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stampOf = (db) => db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value;

// A migrated store whose stamp a newer binary raised above this binary's ladder; returns that stamp.
function seedStampAboveLadder() {
  const store = openStore(dbPath);
  const above = String(Number(stampOf(store._db)) + 1000);
  closeStore(store);
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(above);
  raw.close();
  return above;
}

test('openStore on a store stamped above the ladder succeeds and keeps the stamp', () => {
  const above = seedStampAboveLadder();
  const store = openStore(dbPath);
  assert.equal(stampOf(store._db), above);
  closeStore(store);
  const raw = new DatabaseSync(dbPath);
  assert.equal(stampOf(raw), above, 'the stamp on disk is not lowered');
  raw.close();
});

test('existing tables read and write under a higher stamp', () => {
  seedStampAboveLadder();
  let store = openStore(dbPath);
  store.insertHandoff({
    sessionId: 'sess-A', segment: 0, loadToken: 'tok-forward', createdAt: 1000,
    pathsToKeep: '[]', summary: 'forward summary', summaryTokens: 2, projectId: 'proj-1',
    transcriptPath: 'sess-A-locator',
  });
  store.upsertTurnNotes([{
    sourceSessionId: 'sess-A', anchorUuid: 'a1', uText: 'u', uOriginalChars: 1,
    note: 'forward note', searchTerms: '', sourceTimestamp: 1000,
  }]);
  closeStore(store);

  store = openStore(dbPath);
  const handoff = store.loadHandoffBySession('sess-A');
  assert.equal(handoff.loadToken, 'tok-forward');
  assert.equal(handoff.summary, 'forward summary');
  assert.equal(handoff.transcriptPath, 'sess-A-locator');
  const notes = store.listTurnNotes('sess-A');
  assert.deepEqual(notes.map(n => [n.anchorUuid, n.note]), [['a1', 'forward note']]);
  closeStore(store);
});
