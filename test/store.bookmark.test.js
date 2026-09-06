import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dir, dbPath, store, openStore, closeStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sw-bmark-'));
  dbPath = join(dir, 't.sqlite');
  ({ openStore, closeStore } = await import('../lib/store.js'));
  store = openStore(dbPath);
});
afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

function makeRow(overrides = {}) {
  return {
    projectId: 'proj-X',
    sourceSessionId: 'sess-1',
    anchorUuid: 'uuid-aaa',
    role: 'user',
    previewText: 'Hello world',
    originalChars: 11,
    truncated: 0,
    sourceTimestamp: 1000,
    createdAt: 2000,
    ...overrides,
  };
}

test('upsertBookmark returns a row with numeric bookmarkId', async () => {
  const row = store.upsertBookmark(makeRow());
  assert.equal(typeof row.bookmarkId, 'number');
  assert.ok(row.bookmarkId > 0, 'bookmarkId must be positive');
  assert.equal(row.active, 1);
  assert.equal(row.previewText, 'Hello world');
  assert.equal(row.role, 'user');
});

test('duplicate active add returns same row (same bookmarkId)', async () => {
  const r1 = store.upsertBookmark(makeRow());
  const r2 = store.upsertBookmark(makeRow());
  assert.equal(r1.bookmarkId, r2.bookmarkId, 'second upsert of same identity returns same row');
  assert.equal(r2.active, 1);
});

test('soft delete sets active=0', async () => {
  const r = store.upsertBookmark(makeRow());
  store.deactivateBookmark('proj-X', 'sess-1', 'uuid-aaa');
  const after = store.getBookmarkById('proj-X', r.bookmarkId);
  assert.equal(after.active, 0);
});

test('re-add after soft delete sets active=1 and preserves ID, preview, role, timestamp, created_at', async () => {
  const row = makeRow();
  const r1 = store.upsertBookmark(row);
  store.deactivateBookmark('proj-X', 'sess-1', 'uuid-aaa');
  const r2 = store.upsertBookmark(makeRow({ previewText: 'CHANGED', originalChars: 999 }));
  // same bookmark_id (AUTOINCREMENT ID is stable)
  assert.equal(r2.bookmarkId, r1.bookmarkId, 'ID preserved on re-add');
  // immutable fields not overwritten
  assert.equal(r2.previewText, r1.previewText, 'preview preserved from original insert');
  assert.equal(r2.role, r1.role);
  assert.equal(r2.sourceTimestamp, r1.sourceTimestamp);
  assert.equal(r2.createdAt, r1.createdAt);
  assert.equal(r2.active, 1);
});

test('deactivateBookmark on missing row changes nothing', async () => {
  // Should not throw
  store.deactivateBookmark('proj-X', 'sess-1', 'uuid-nonexistent');
  // no rows exist
  const rows = store.listActiveBookmarksForSession('proj-X', 'sess-1');
  assert.deepEqual(rows, []);
});

test('unique identity is session-scoped: same anchor_uuid in different sessions is independent', async () => {
  const r1 = store.upsertBookmark(makeRow({ sourceSessionId: 'sess-1', anchorUuid: 'uuid-x' }));
  const r2 = store.upsertBookmark(makeRow({ sourceSessionId: 'sess-2', anchorUuid: 'uuid-x' }));
  assert.notEqual(r1.bookmarkId, r2.bookmarkId, 'different sessions get different rows');
});

test('project-scoped lookup: getBookmarkById cannot read another project', async () => {
  const r = store.upsertBookmark(makeRow({ projectId: 'proj-A' }));
  const found = store.getBookmarkById('proj-B', r.bookmarkId);
  assert.equal(found, null, 'cannot read across project boundary');
});

test('getBookmarkByIdentity returns the row by project+session+anchor', async () => {
  store.upsertBookmark(makeRow());
  const found = store.getBookmarkByIdentity('proj-X', 'sess-1', 'uuid-aaa');
  assert.ok(found);
  assert.equal(found.anchorUuid, 'uuid-aaa');
  assert.equal(found.projectId, 'proj-X');
});

test('getBookmarkByIdentity returns null for wrong project', async () => {
  store.upsertBookmark(makeRow());
  const found = store.getBookmarkByIdentity('proj-WRONG', 'sess-1', 'uuid-aaa');
  assert.equal(found, null);
});

test('peekNextBookmarkId follows SQLite AUTOINCREMENT state', async () => {
  const peek1 = store.peekNextBookmarkId();
  const r1 = store.upsertBookmark(makeRow({ anchorUuid: 'a1' }));
  const peek2 = store.peekNextBookmarkId();
  assert.equal(peek1, r1.bookmarkId, 'peek before insert matches first insert id');
  assert.equal(peek2, r1.bookmarkId + 1, 'peek after insert is next id');
});

test('listActiveBookmarksForSession excludes inactive rows', async () => {
  store.upsertBookmark(makeRow({ anchorUuid: 'a1' }));
  store.upsertBookmark(makeRow({ anchorUuid: 'a2' }));
  store.deactivateBookmark('proj-X', 'sess-1', 'a1');
  const rows = store.listActiveBookmarksForSession('proj-X', 'sess-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].anchorUuid, 'a2');
});

test('deleting handoff/session data does not delete bookmark rows', async () => {
  // Insert a handoff and a bookmark referencing the same session
  store.insertHandoff({
    sessionId: 'sess-1', segment: 0, loadToken: 'tok-bmark', createdAt: 100,
    pathsToKeep: '[]', summary: 'sum', summaryTokens: 1, projectId: 'proj-X',
  });
  store.upsertBookmark(makeRow());
  // Delete handoff GC style
  store._db.prepare("DELETE FROM handoff WHERE session_id='sess-1'").run();
  // Bookmark must survive
  const rows = store.listActiveBookmarksForSession('proj-X', 'sess-1');
  assert.equal(rows.length, 1, 'bookmark survives handoff deletion (no FK cascade)');
});
