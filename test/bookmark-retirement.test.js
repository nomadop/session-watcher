// test/bookmark-retirement.test.js — the History Bookmark runtime is gone. Three routes, the Store CRUD
// that backed them, the fresh-store table creation, and the modules themselves: each is checked by
// observing what the running system answers, not by reading a source file.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { bootTestServer } from './helpers/server-boot.js';

let ctx;
before(async () => { ctx = await bootTestServer({ sessionId: 'sess-retired' }); });
after(async () => { await ctx.teardown(); });

test('[delta] bookmark routes and Store CRUD are absent and fresh stores do not create the bookmark table', async () => {
  const statusOf = async (path) => (await ctx.requestRaw(path)).status;
  assert.equal(await statusOf('/api/bookmark/messages'), 404);
  assert.equal(await statusOf('/api/bookmark'), 404);
  assert.equal(await statusOf('/api/bookmark/detail'), 404);

  const freshStore = ctx.store;
  for (const name of [
    'upsertBookmark',
    'getBookmarkById',
    'getBookmarkByIdentity',
    'deactivateBookmark',
    'listActiveBookmarksForSession',
    'peekNextBookmarkId',
  ]) assert.equal(freshStore[name], undefined, `Store still exposes ${name}`);

  const freshDb = freshStore._db;
  assert.equal(freshDb.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='bookmark'
  `).get(), undefined);
});

test('the retired route methods are 404 too — the paths carry no verb of their own', async () => {
  // PUT was the desired-state write. A route removed for GET but kept for PUT would still accept writes.
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const res = await ctx.requestRaw('/api/bookmark', { method, body: { add: true } });
    assert.equal(res.status, 404, `${method} /api/bookmark`);
  }
  assert.equal((await ctx.requestRaw('/api/bookmark')).status, 404, 'GET /api/bookmark');
});

test('the retained turn routes still answer, so the 404s above are removals rather than a dead server', async () => {
  // A server that 404'd everything would satisfy the assertions above vacuously.
  assert.equal((await ctx.requestRaw('/api/turn/browse')).status, 200);
  assert.equal((await ctx.requestRaw('/api/turn/page?lineage_head=0')).status, 404);
});

test('the bookmark modules do not resolve and no live namespace exports their Interfaces', async () => {
  for (const gone of ['../lib/bookmark.js', '../lib/bookmark-core.js', '../lib/bookmark-service.js',
    '../lib/bookmark-detail.js']) {
    assert.equal(existsSync(new URL(gone, import.meta.url)), false, `${gone} still exists`);
  }
  const retired = ['createBookmarkService', 'buildBookmarkDetail', 'resolveDetailTarget',
    'renderBookmarkFragment', 'estimateBookmarkTokens', 'isWithinBookmarkBudget', 'buildPreview',
    'parseBookmarkId', 'formatBookmarkId', 'capDetailEntity', 'BOOKMARK_TOKEN_BUDGET',
    'BOOKMARK_PREVIEW_CHARS', 'BOOKMARK_NOTICE', 'DETAIL_NOTICE'];
  for (const path of ['../server.js', '../index.js', '../lib/store.js', '../lib/turn.js',
    '../lib/turn-page.js', '../lib/turn-query.js', '../lib/turn-history-budget.js',
    '../lib/dialogue-tool.js', '../lib/dialogue-fold.js']) {
    const ns = await import(path);
    for (const symbol of retired) assert.ok(!(symbol in ns), `${path} still exports ${symbol}`);
  }
});

test('the two still-live helpers kept their behaviour under their new owners', async () => {
  // Retirement removed the product, not the deterministic serialization or the sizing primitives.
  const { serializeResult, stableStringify } = await import('../lib/dialogue-tool.js');
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.deepEqual(serializeResult('x'), { resultStr: 'x', encoding: 'text' });
  const budget = await import('../lib/turn-history-budget.js');
  assert.equal(budget.HISTORY_EXCERPT_CHARS, 200);
  assert.equal(budget.HISTORY_TOKEN_BUDGET, 5000);
  assert.equal(budget.truncationMarker(842), ' [truncated; 842 chars]');
});
