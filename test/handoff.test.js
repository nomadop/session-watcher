import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let store, dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-ho-')); });
afterEach(async () => { if (store) { const { closeStore } = await import('../lib/store.js'); closeStore(store); store = null; } rmSync(dir, { recursive: true, force: true }); });

const row = (over = {}) => ({ sessionId: 's1', segment: 0, loadToken: 'auth-mw-fox',
  createdAt: 1000, pathsToKeep: JSON.stringify(['/a.js']), summary: 'refactor auth middleware',
  nextTask: 'fix token refresh', summaryTokens: 5, keptTokens: 100, discardedTokens: 200,
  preparedAtTurn: 12, previousStats: JSON.stringify({ b_total: 60000 }), searchTerms: '', ...over });

test('insertHandoff + loadHandoffByToken roundtrip', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  const { handoffId } = store.insertHandoff(row());
  assert.ok(handoffId > 0);
  const got = store.loadHandoffByToken('auth-mw-fox');
  assert.equal(got.summary, 'refactor auth middleware');
  assert.deepEqual(JSON.parse(got.pathsToKeep), ['/a.js']);
  assert.equal(got.preparedAtTurn, 12);
});

test('insertHandoff duplicate token throws errcode 2067', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row());
  assert.throws(() => store.insertHandoff(row({ segment: 1 })), (e) => e.errcode === 2067);
});

test('loadHandoffBySession returns most recent', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row({ loadToken: 'old-fox', createdAt: 100 }));
  store.insertHandoff(row({ loadToken: 'new-oak', createdAt: 200, summary: 'newer work' }));
  assert.equal(store.loadHandoffBySession('s1').summary, 'newer work');
});

test('loadHandoffBySession respects projectId filter', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row({ loadToken: 'proj-a', createdAt: 100, projectId: 'projA' }));
  store.insertHandoff(row({ loadToken: 'proj-b', createdAt: 200, projectId: 'projB', summary: 'projB work' }));
  // Without filter → newest overall
  assert.equal(store.loadHandoffBySession('s1').summary, 'projB work');
  // With filter → only projA
  const got = store.loadHandoffBySession('s1', { projectId: 'projA' });
  assert.equal(got.loadToken, 'proj-a');
});

test('searchHandoff finds by keyword (FTS) or returns [] when FTS absent', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row({ loadToken: 'auth-mw-fox', summary: 'refactor the auth middleware layer' }));
  store.insertHandoff(row({ loadToken: 'db-oak', segment: 1, summary: 'optimize the sqlite store' }));
  const res = store.searchHandoff('"middleware"', { limit: 3 });
  if (store.ftsAvailable) {
    assert.ok(res.length >= 1);
    assert.equal(res[0].loadToken, 'auth-mw-fox');
    assert.ok('summaryPreview' in res[0]);
  } else {
    assert.deepEqual(res, []);
  }
});

test('searchHandoff respects projectId filter', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row({ loadToken: 'auth-mw-fox', summary: 'refactor the auth middleware layer', projectId: 'p1' }));
  store.insertHandoff(row({ loadToken: 'db-oak', segment: 1, summary: 'auth layer tuning', projectId: 'p2' }));
  if (store.ftsAvailable) {
    const all = store.searchHandoff('"auth"', { limit: 10 });
    assert.ok(all.length === 2);
    const filtered = store.searchHandoff('"auth"', { projectId: 'p1', limit: 10 });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].loadToken, 'auth-mw-fox');
  }
});


test('loadHandoffByProject: returns single pending handoff for project', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'old-session', segment: 0, loadToken: 'proj-fox',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'work A',
    nextTask: 'continue A', summaryTokens: 100, projectId: '/workspace' });
  const result = s.loadHandoffByProject('/workspace', 'new-session', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].loadToken, 'proj-fox');
  assert.equal(result.ambiguous, false);
  closeStore(s);
});

test('loadHandoffByProject: returns ambiguous when 2+ pending', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'old-1', segment: 0, loadToken: 'proj-a',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'A',
    nextTask: 'task A', summaryTokens: 50, projectId: '/workspace' });
  s.insertHandoff({ sessionId: 'old-2', segment: 0, loadToken: 'proj-b',
    createdAt: Date.now() - 30000, pathsToKeep: '[]', summary: 'B',
    nextTask: 'task B', summaryTokens: 50, projectId: '/workspace' });
  const result = s.loadHandoffByProject('/workspace', 'new-session', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.ambiguous, true);
  closeStore(s);
});

test('loadHandoffByProject: excludes own session_id', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'my-session', segment: 0, loadToken: 'self-owl',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'self',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  const result = s.loadHandoffByProject('/workspace', 'my-session', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 0);
  closeStore(s);
});

test('loadHandoffByProject: excludes expired (older than TTL)', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'old', segment: 0, loadToken: 'expired-elm',
    createdAt: Date.now() - 8 * 86400000, pathsToKeep: '[]', summary: 'old',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  const result = s.loadHandoffByProject('/workspace', 'new', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 0);
  closeStore(s);
});

test('loadHandoffByProject: excludes already-delivered', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'old', segment: 0, loadToken: 'done-ash',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'delivered',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  // Manually stamp delivered_at
  s._db.prepare('UPDATE handoff SET delivered_at = ? WHERE load_token = ?').run(Date.now(), 'done-ash');
  const result = s.loadHandoffByProject('/workspace', 'new', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 0);
  closeStore(s);
});

test('loadHandoffByProject: null projectId returns empty', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'old', segment: 0, loadToken: 'null-key',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'x',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  const result = s.loadHandoffByProject(null, 'new', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 0);
  closeStore(s);
});

test('loadHandoffByProject: different project not returned', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 'old', segment: 0, loadToken: 'other-proj',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'other',
    nextTask: null, summaryTokens: 50, projectId: '/other-project' });
  const result = s.loadHandoffByProject('/workspace', 'new', { ttlMs: 7 * 86400000 });
  assert.equal(result.rows.length, 0);
  closeStore(s);
});

test('loadHandoffByToken: a session-less load is a pure read and stamps NOTHING', async () => {
  // Task 3 changed the session-less contract: a load with no sessionId must NOT stamp the binding.
  // A NULL-consumer stamp would burn delivered_at and permanently block any later real consumer from
  // binding, AND mislabel every later session as 'primary'. So a session-less load returns content
  // with deliveredAt == null and writes no handoff_load row.
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 's1', segment: 0, loadToken: 'stamp-test',
    createdAt: Date.now(), pathsToKeep: '[]', summary: 'x',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  const h1 = s.loadHandoffByToken('stamp-test');
  assert.equal(h1.deliveredAt, null, 'a session-less load stamps no delivered_at');
  assert.equal(h1.deliveredSessionId, null, 'and binds no consumer');
  // A repeat session-less load still stamps nothing.
  const h2 = s.loadHandoffByToken('stamp-test');
  assert.equal(h2.deliveredAt, null, 'still no stamp on a second session-less load');
  closeStore(s);
});

test('loadHandoffByToken: delivered_segment is NULL (not claim-based)', async () => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(':memory:');
  s.insertHandoff({ sessionId: 's1', segment: 0, loadToken: 'seg-null',
    createdAt: Date.now(), pathsToKeep: '[]', summary: 'x',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  const h = s.loadHandoffByToken('seg-null');
  assert.equal(h.deliveredSegment, null, 'load-time stamp sets delivered_segment = NULL');
  closeStore(s);
});

test('loadHandoffByToken returns null for unknown token', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  assert.equal(store.loadHandoffByToken('nonexistent'), null);
});

test('loadHandoffBySession returns null for unknown session', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  assert.equal(store.loadHandoffBySession('nobody'), null);
});
