// test/server.bookmark-load.test.js — Tests for bookmark merge into successful load responses.
// Also covers prepare (no bookmark state), failed pipeline fallback, and retired fields.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootTestServer } from './helpers/server-boot.js';
import { userMessage, assistantObservation, writeTranscript, ts } from './helpers/transcript-fixtures.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Seed a handoff delivered to sessionId from sourceSessionId
function seedDeliveredHandoff(store, { sessionId, sourceSessionId, loadToken, transcriptPath, projectId = 'proj-boot' }) {
  const { handoffId } = store.insertHandoff({
    sessionId: sourceSessionId, segment: 0, loadToken,
    createdAt: Date.now(), pathsToKeep: '[]', summary: 'test summary for load',
    summaryTokens: 10, projectId, transcriptPath,
  });
  store._db.prepare('UPDATE handoff SET delivered_at=?, delivered_session_id=? WHERE handoff_id=?')
    .run(Date.now(), sessionId, handoffId);
  return handoffId;
}

// ── Successful load injects turn_page + three capability URLs ─────────────────

describe('Successful load — turn page shape', () => {
  let ctx, dir, loadToken;
  before(async () => {
    ctx = await bootTestServer({ sessionId: 'sid-load' });
    dir = mkdtempSync(join(tmpdir(), 'sw-bm-load-'));

    // Build a transcript for the source session
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-bk', text: 'keep project isolation', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a-bk', parentUuid: 'u-bk', messageId: 'm-bk', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'isolation confirmed' }] }),
    ]);

    loadToken = 'tok-load-bk';
    seedDeliveredHandoff(ctx.store, {
      sessionId: 'sid-load', sourceSessionId: 'session-bk-src',
      loadToken, transcriptPath: path,
    });

    // Seed bookmark — still present in DB (bookmark CRUD stays), but no longer injected into load.
    ctx.store.upsertBookmark({
      projectId: 'proj-boot', sourceSessionId: 'session-bk-src', anchorUuid: 'u-bk',
      role: 'user', previewText: 'keep project isolation', originalChars: 22,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
    const bk = ctx.store.getBookmarkByIdentity('proj-boot', 'session-bk-src', 'u-bk');
    ctx.store._db.prepare('UPDATE bookmark SET bookmark_id = 42 WHERE bookmark_id = ?').run(bk.bookmarkId);
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('load 返回 turn_page，不含任何 turn URL，且无 bookmark 字段', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    assert.equal(typeof res.turn_page, 'string');
    for (const key of ['turn_page_url', 'turn_search_url', 'turn_locate_url']) {
      assert.equal(res[key], undefined, key);
    }
    assert.equal(res.bookmarks, undefined);
    assert.equal(res.bookmark_detail_url, undefined);
  });

  test('retired fields (bm_idx / rui) are ABSENT', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    // Field names constructed from fragments — retired symbols must not appear in runtime source.
    assert.equal(res[['bookmark', 'index'].join('_')], undefined, 'retired field must be absent from load');
    assert.equal(res[['recent', 'user', 'intents'].join('_')], undefined, 'retired field must be absent from load');
  });
});

// ── Successful load — turn_page present; no bookmark fields ──────────────────

describe('Successful load — no turn notes (empty page)', () => {
  let ctx, dir, loadToken;
  before(async () => {
    ctx = await bootTestServer({ sessionId: 'sid-load-empty' });
    dir = mkdtempSync(join(tmpdir(), 'sw-bm-empty-'));

    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-empty', text: 'no bookmarks here', timestamp: ts(1) }),
    ]);
    loadToken = 'tok-load-empty';
    seedDeliveredHandoff(ctx.store, {
      sessionId: 'sid-load-empty', sourceSessionId: 'session-empty-src',
      loadToken, transcriptPath: path,
    });
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('成功 load → turn_page 是字符串，无 bookmark 字段', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    assert.equal(typeof res.turn_page, 'string');
    assert.equal(res.bookmarks, undefined);
    assert.equal(res.bookmark_detail_url, undefined);
  });
});

// ── Bookmark pipeline throws → degraded ──────────────────────────────────────

describe('Bookmark pipeline failure isolation', () => {
  let ctx, dir, loadToken;
  before(async () => {
    // Inject a throwing bookmarkService for load failure isolation
    ctx = await bootTestServer({ sessionId: 'sid-load-fail', throwingBookmarkService: true });
    dir = mkdtempSync(join(tmpdir(), 'sw-bm-fail-'));

    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-fail', text: 'test', timestamp: ts(1) }),
    ]);
    loadToken = 'tok-load-fail';
    seedDeliveredHandoff(ctx.store, {
      sessionId: 'sid-load-fail', sourceSessionId: 'session-fail-src',
      loadToken, transcriptPath: path,
    });
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('bookmark service 抛异常不影响 load 响应，turn_page 正常返回', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    assert.equal(typeof res.turn_page, 'string');
    assert.equal(res.bookmarks, undefined);
    // Core handoff fields still present
    assert.equal(res.load_token, loadToken);
    assert.ok(typeof res.summary === 'string', 'summary present');
  });
});

// ── found:false, ambiguous, invalid, corrupt, search → no bookmarks ──────────

describe('Non-resolved load responses — no bookmarks field', () => {
  let ctx;
  before(async () => { ctx = await bootTestServer({ sessionId: 'sid-load-nobook' }); });
  after(async () => { await ctx.teardown(); });

  test('found:false (no token) → no turn_page field', async () => {
    const res = await ctx.request('/api/handoff/load?load_token=nonexistent', {});
    assert.equal(res.found, false);
    assert.equal(res.turn_page, undefined);
  });

  test('search result → no bookmarks field', async () => {
    // Insert a handoff with searchable summary (use a DIFFERENT project to avoid auto-match interference)
    ctx.store.insertHandoff({
      sessionId: 'sid-search-src2', segment: 0, loadToken: 'tok-search2',
      createdAt: Date.now(), pathsToKeep: '[]', summary: 'unique test search phrase xyz2',
      summaryTokens: 10, projectId: 'proj-search-only',
    });
    const res = await ctx.request('/api/handoff/load?query=unique+test+search+phrase+xyz2', {});
    if (res.mode === 'search') {
      assert.equal(res.bookmarks, undefined, 'search results have no bookmarks');
    }
    // If FTS not available, just verify no bookmarks on the error response
    if (res.error === 'search_unavailable' || res.status === 'error') {
      assert.equal(res.bookmarks, undefined, 'error response has no bookmarks');
    }
  });

  test('ambiguous auto-match → no bookmarks field', async () => {
    // Boot a separate server with a project that has two undelivered handoffs → ambiguous
    const ctx2 = await bootTestServer({ sessionId: 'sid-amb-check', projectId: 'proj-amb-check' });
    try {
      const { store: s2 } = ctx2;
      const now = Date.now();
      s2.insertHandoff({
        sessionId: 'session-amb-src-1', segment: 0, loadToken: 'tok-amb-c1',
        createdAt: now, pathsToKeep: '[]', summary: 'ambiguous test case',
        summaryTokens: 5, projectId: 'proj-amb-check', transcriptPath: null,
      });
      s2.insertHandoff({
        sessionId: 'session-amb-src-2', segment: 0, loadToken: 'tok-amb-c2',
        createdAt: now + 1, pathsToKeep: '[]', summary: 'ambiguous test case 2',
        summaryTokens: 5, projectId: 'proj-amb-check', transcriptPath: null,
      });
      // Auto-match for proj-amb-check with two candidates → ambiguous response
      const res = await ctx2.request('/api/handoff/load', {});
      // Either ambiguous or found:false — no bookmarks either way
      assert.equal(res.bookmarks, undefined, 'no bookmarks on non-resolved responses');
    } finally {
      await ctx2.teardown();
    }
  });
});

// ── prepare does not read/freeze/return bookmark state ──────────────────────

describe('prepare — no bookmark state', () => {
  let ctx;
  before(async () => { ctx = await bootTestServer({ sessionId: 'sid-prepare' }); });
  after(async () => { await ctx.teardown(); });

  test('prepare response has no bookmark fields', async () => {
    const res = await ctx.request('/api/handoff/prepare', {
      method: 'POST',
      body: { paths_to_keep: [], summary: 'test prepare no bookmark' },
    });
    assert.equal(res.status, 'ready');
    assert.equal(res.bookmarks, undefined, 'no bookmarks in prepare');
    // Field names constructed from fragments — retired symbols must not appear in runtime source.
    assert.equal(res[['bookmark', 'index'].join('_')], undefined, 'no retired field in prepare');
    assert.equal(res[['recent', 'user', 'intents'].join('_')], undefined, 'no retired field in prepare');
    assert.equal(res.bookmark_detail_url, undefined, 'no detail url in prepare');
  });
});

// ── Delivery write failure → 503 on both delivery-bearing paths ──────────────

describe('Delivery write failure — 503 on both delivery paths', () => {
  let ctx, loadToken;
  before(async () => {
    ctx = await bootTestServer({ sessionId: 'sid-deliver-fail', projectId: 'proj-deliver-fail' });
    loadToken = 'tok-deliver-fail';
    ctx.store.insertHandoff({
      sessionId: 'session-df-src', segment: 0, loadToken,
      createdAt: Date.now(), pathsToKeep: '[]', summary: 'delivery failure test',
      summaryTokens: 10, projectId: 'proj-deliver-fail',
    });
  });
  after(async () => { await ctx.teardown(); });

  test('delivery 写入失败：显式 token 与 auto-match 都返回无内容 503', async () => {
    const original = ctx.store._stmts.insertHandoffLoad;
    ctx.store._stmts.insertHandoffLoad = { run() { throw new Error('injected delivery failure'); } };
    try {
      for (const url of [`/api/handoff/load?load_token=${loadToken}`, '/api/handoff/load']) {
        const res = await ctx.requestRaw(url);
        assert.equal(res.status, 503, url);
        assert.deepEqual(await res.json(), {
          error: 'handoff_delivery_unavailable', retryable: true,
        }, url); // 精确 body 同时证明 summary/paths/turn page 等内容字段全未发布
      }
    } finally {
      ctx.store._stmts.insertHandoffLoad = original;
    }
  });
});

// ── load does not deactivate rows ──────────────────────────────────────────

describe('load — does not deactivate bookmark rows', () => {
  let ctx, dir, loadToken;
  before(async () => {
    ctx = await bootTestServer({ sessionId: 'sid-nodeact' });
    dir = mkdtempSync(join(tmpdir(), 'sw-bm-nodeact-'));
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-nd', text: 'must stay active', timestamp: ts(1) }),
    ]);
    loadToken = 'tok-nodeact';
    seedDeliveredHandoff(ctx.store, {
      sessionId: 'sid-nodeact', sourceSessionId: 'session-nd-src',
      loadToken, transcriptPath: path,
    });
    ctx.store.upsertBookmark({
      projectId: 'proj-boot', sourceSessionId: 'session-nd-src', anchorUuid: 'u-nd',
      role: 'user', previewText: 'must stay active', originalChars: 16,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('after load, bookmark row still active', async () => {
    await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    const bk = ctx.store.getBookmarkByIdentity('proj-boot', 'session-nd-src', 'u-nd');
    assert.equal(bk.active, 1, 'bookmark still active after load');
  });
});

// ── resolved source is the live lineage tail ───────────────────

describe('load — resolved source anchors the lineage tail', () => {
  let ctx, dir, loadToken;
  before(async () => {
    ctx = await bootTestServer({ sessionId: 'sid-lineage' });
    dir = mkdtempSync(join(tmpdir(), 'sw-bm-lineage-'));
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-lin', text: 'lineage test message', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a-lin', parentUuid: 'u-lin', messageId: 'm-lin', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'lineage reply' }] }),
    ]);
    loadToken = 'tok-lineage';
    seedDeliveredHandoff(ctx.store, {
      sessionId: 'sid-lineage', sourceSessionId: 'session-lin-src',
      loadToken, transcriptPath: path,
    });
    ctx.store.upsertBookmark({
      projectId: 'proj-boot', sourceSessionId: 'session-lin-src', anchorUuid: 'u-lin',
      role: 'user', previewText: 'lineage test message', originalChars: 20,
      truncated: 0, sourceTimestamp: Date.now(), createdAt: Date.now(),
    });
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('handoff sessionId is the lineage tail — turn_page returned, no bookmarks injected', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    assert.equal(typeof res.turn_page, 'string');
    assert.equal(res.bookmarks, undefined);
  });
});
