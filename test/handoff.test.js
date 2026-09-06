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

// The in-place revision `prepare_handoff` performs when it is handed a load_token: same row, new text.
const revision = (over = {}) => ({ pathsToKeep: '[]', summary: 'a revised summary', summaryTokens: 5,
  nextTask: 'a revised next task', searchTerms: '', ...over });

const DAY_MS = 24 * 3600 * 1000;

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

// prepare_handoff exposes load_token so an undelivered handoff can be revised in place, and
// updateHandoff rewrites indexed columns — so the index has to follow the row's new words.
test('updateHandoff: a revised handoff answers to its new summary and no longer to its old one', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row({ loadToken: 'auth-mw-fox', summary: 'refactor the auth middleware layer' }));
  if (!store.ftsAvailable) return;
  assert.equal(store.updateHandoff('auth-mw-fox', revision({ summary: 'rewrite the payment gateway' })), true);
  assert.deepEqual(store.searchHandoff('"gateway"', { limit: 10 }).map(r => r.loadToken), ['auth-mw-fox']);
  assert.deepEqual(store.searchHandoff('"middleware"', { limit: 10 }), []);
});

// A revision leaves the index carrying the old words; the row's own delete then subtracts the NEW ones,
// so what outlives the row is a posting for a rowid nothing can resolve — and the next search over that
// word raises SQLITE_CORRUPT_VTAB instead of answering. `fts5 integrity-check` passes throughout.
test('searchHandoff after a revised handoff ages out: the sweep leaves nothing behind it', async () => {
  const { openStore } = await import('../lib/store.js');
  const { GC_HANDOFF_MAX_AGE_DAYS } = await import('../lib/constants.js');
  const now = Date.now();
  store = openStore(join(dir, 't.sqlite'));
  store.insertHandoff(row({ loadToken: 'aged-fox', summary: 'legacy billing pipeline',
    createdAt: now - (GC_HANDOFF_MAX_AGE_DAYS + 1) * DAY_MS }));
  store.insertHandoff(row({ loadToken: 'live-oak', segment: 1, summary: 'legacy billing dashboard',
    createdAt: now }));
  if (!store.ftsAvailable) return;
  store.updateHandoff('aged-fox', revision({ summary: 'ledger cleanup pass' }));
  store.sweep(7 * DAY_MS, { now });
  assert.deepEqual(store.searchHandoff('"billing"', { limit: 10 }).map(r => r.loadToken), ['live-oak']);
});

// The probe's object list is what repairs a database written before the update trigger existed: it reads
// as incomplete exactly once, and that open's rebuild re-derives the index from the rows themselves.
test('handoff_fts drift from a missing update trigger: one reopen rebuilds it away', async (t) => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const p = join(dir, 'fts-drift.sqlite');
  let s = openStore(p);
  if (!s.ftsAvailable) { closeStore(s); return; }
  s._db.exec('DROP TRIGGER handoff_fts_update');     // the object set every older database has
  s.insertHandoff(row({ loadToken: 'drift-fox', summary: 'refactor the auth middleware layer' }));
  s.updateHandoff('drift-fox', revision({ summary: 'rewrite the payment gateway' }));
  assert.deepEqual(s.searchHandoff('"middleware"', { limit: 10 }).map(r => r.loadToken), ['drift-fox'],
    'with no trigger the revision leaves the row indexed under its old words');
  closeStore(s);
  s = openStore(p);
  t.after(() => closeStore(s));
  assert.deepEqual(s.searchHandoff('"gateway"', { limit: 10 }).map(r => r.loadToken), ['drift-fox']);
  assert.deepEqual(s.searchHandoff('"middleware"', { limit: 10 }), []);
});

test('handoff_fts 完好库 reopen：base 表推不出的 posting 不被重建冲掉', async (t) => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const p = join(dir, 'fts-keep.sqlite');
  let s = openStore(p);
  if (!s.ftsAvailable) { closeStore(s); return; }
  const { handoffId } = s.insertHandoff(
    row({ loadToken: 'keep-fox', summary: 'refactor the auth middleware layer' }));
  // A posting no row can yield: the word is in no column of any handoff, so only this write put it in the
  // index, and only a rebuild — which re-derives the index from the base table — can take it out.
  s._db.prepare(`INSERT INTO handoff_fts(rowid, summary, next_task, load_token, search_terms)
    VALUES (?, ?, NULL, NULL, NULL)`).run(handoffId, 'plantedsentinel');
  assert.deepEqual(s.searchHandoff('"plantedsentinel"', { limit: 10 }).map(r => r.loadToken), ['keep-fox'],
    '植入后可检索');
  closeStore(s);

  s = openStore(p);
  t.after(() => closeStore(s));
  assert.deepEqual(s.searchHandoff('"plantedsentinel"', { limit: 10 }).map(r => r.loadToken), ['keep-fox'],
    '对象集完整的 reopen 不重建索引');
  assert.deepEqual(s.searchHandoff('"middleware"', { limit: 10 }).map(r => r.loadToken), ['keep-fox'],
    '真实内容照旧可检索');
});

test('handoff_fts_update 只在索引列变化时点火：投递戳不碰索引，就地改写仍碰', async (t) => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const s = openStore(join(dir, 'fts-when.sqlite'));
  t.after(() => closeStore(s));
  if (!s.ftsAvailable) return;
  s.insertHandoff(row({ loadToken: 'when-fox', summary: 'refactor the auth middleware layer' }));

  // Swap the index for a table of the same shape that refuses every write. Dropping it outright does not
  // discriminate: SQLite compiles a trigger body while preparing the UPDATE, so a missing handoff_fts
  // fails every write to handoff before the WHEN is ever evaluated. A table that exists and rejects lets
  // the body compile, which makes "did it fire" observable on the wire rather than as an internal count.
  s._db.exec('DROP TABLE handoff_fts');
  s._db.exec(`CREATE TABLE handoff_fts (handoff_fts TEXT, summary TEXT, next_task TEXT,
    load_token TEXT, search_terms TEXT, CONSTRAINT handoff_fts_write_trap CHECK (0))`);

  // An in-place revision does change indexed columns, so the trigger must still fire — with the index
  // refusing, firing is a throw. This is the direction a predicate that never fires would break, and it
  // has to precede the stamp: updateHandoff only matches a row whose delivered_at is still NULL.
  assert.throws(() => s.updateHandoff('when-fox', revision({ summary: 'rewrite the payment gateway' })),
    /handoff_fts/);

  // Each nullable indexed column on its own, with the remaining indexed columns pinned to what the row
  // actually holds: a predicate narrowed to summary passes the case above yet leaves a revision that touches
  // only next_task or only search_terms unmirrored, which is the same stale-posting shape. Every rejection
  // here rolls back at statement level, so the row keeps the words the stamp below reads back.
  const held = s._db.prepare('SELECT summary, next_task, search_terms FROM handoff WHERE load_token = ?')
    .get('when-fox');
  assert.throws(() => s.updateHandoff('when-fox', revision({ summary: held.summary,
    nextTask: 'fix the refresh token path', searchTerms: held.search_terms })), /handoff_fts/);
  assert.throws(() => s.updateHandoff('when-fox', revision({ summary: held.summary,
    nextTask: held.next_task, searchTerms: 'lib/auth.js' })), /handoff_fts/);

  // A delivery stamp writes delivered_at / delivered_session_id / delivered_segment / loader_version and
  // no indexed column, so the trigger must not fire and the fail-closed load must still complete. The
  // rejected revision left the row's own words in place, so the load answers with them.
  const loaded = s.loadHandoffByToken('when-fox', { sessionId: 'consumer-sess' });
  assert.equal(loaded.error, undefined, '投递戳不该被一次索引写失败拖成 fail-closed');
  assert.equal(loaded.summary, 'refactor the auth middleware layer');
  assert.equal(loaded.claimResult, 'primary');
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
