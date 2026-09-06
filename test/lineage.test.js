// test/lineage.test.js — Tests for the Lineage Resolver (fromHandoff / forCurrentSession /
// forLoadedHandoff) plus materializeLineage, which now lives with its runtime owner in
// lib/bookmark-service.js.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore } from '../lib/store.js';
import { userMessage, assistantObservation, writeTranscript, ts } from './helpers/transcript-fixtures.js';

let dir, store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-lineage-'));
  const dbPath = join(dir, 'lineage.sqlite');
  store = openStore(dbPath);
});
afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

// 每个 handoff 行都用 insertHandoff；父边只来自 handoff_load，不再写 delivered_session_id
function seedHandoff({ sessionId, loadToken, projectId = 'project-1', transcriptPath = null, createdAt }) {
  return store.insertHandoff({
    sessionId, segment: 0, loadToken, createdAt,
    pathsToKeep: '[]', summary: 'test', summaryTokens: 10, projectId, transcriptPath,
  }).handoffId;
}
function seedDelivery({ handoffId, sessionId, loadedAt, claimResult = 'primary' }) {
  store.insertHandoffLoad({
    handoffId, sessionId, loadedAt, loaderVersion: 'test',
    claimResult, primarySessionId: sessionId, consumerSegment: 0,
  });
}

// Helper: seed an active bookmark
function seedBookmark({ projectId = 'project-1', sourceSessionId, anchorUuid, role = 'assistant', sourceTimestamp = 1000 }) {
  return store.upsertBookmark({
    projectId, sourceSessionId, anchorUuid, role,
    previewText: `preview-${anchorUuid}`,
    originalChars: 20, truncated: 0,
    sourceTimestamp, createdAt: Date.now(),
  });
}

// ============== Lineage Resolver tests ==============

describe('lineage resolver', () => {
  let fromHandoff, forCurrentSession, forLoadedHandoff;

  beforeEach(async () => {
    ({ fromHandoff, forCurrentSession, forLoadedHandoff } = await import('../lib/lineage.js'));
  });

  test('fromHandoff: duplicate claim 仍是合格父边', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500, claimResult: 'duplicate' });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    const chain = fromHandoff({ store, handoffId: hB });
    assert.deepEqual(chain.map(s => [s.label, s.sessionId]), [['S1', 'sess-A'], ['S2', 'sess-B']]);
  });

  test('fromHandoff: prepare 之后发生的 load 不进父链', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 2500 }); // > hB.created_at
    const chain = fromHandoff({ store, handoffId: hB });
    assert.deepEqual(chain.map(s => s.sessionId), ['sess-B']);
  });

  test('fromHandoff: 同毫秒 delivery 按 handoff_id DESC 决胜', () => {
    const h1 = seedHandoff({ sessionId: 'sess-X', loadToken: 't1', createdAt: 1000 });
    const h2 = seedHandoff({ sessionId: 'sess-Y', loadToken: 't2', createdAt: 1000 });
    seedDelivery({ handoffId: h1, sessionId: 'sess-B', loadedAt: 1500 });
    seedDelivery({ handoffId: h2, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    const chain = fromHandoff({ store, handoffId: hB });
    assert.equal(chain[0].sessionId, 'sess-Y'); // h2 > h1
  });

  test('同一 session 多次载入：后一次 delivery 取代前一次，不合并祖先链', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    const hX = seedHandoff({ sessionId: 'sess-X', loadToken: 'tX', createdAt: 1100 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1400 });
    seedDelivery({ handoffId: hX, sessionId: 'sess-B', loadedAt: 1600 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    const chain = fromHandoff({ store, handoffId: hB });
    assert.deepEqual(chain.map(s => s.sessionId), ['sess-X', 'sess-B']);
    assert.ok(!chain.some(s => s.sessionId === 'sess-A'));
  });

  test('fromHandoff: 跨项目不串链', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', projectId: 'other', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    assert.deepEqual(
      fromHandoff({ store, handoffId: hB }).map(s => s.sessionId),
      ['sess-B'],
    );
  });

  test('project_id NULL：显式 head 自身可读，但 NULL 父边仍不串链', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', projectId: null, createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', projectId: null, createdAt: 2000 });
    assert.deepEqual(
      fromHandoff({ store, handoffId: hB }).map(s => [s.label, s.sessionId]),
      [['S1', 'sess-B']],
    );
  });

  test('父边指向已被 GC 删除的 handoff 时按链尾处理，不报错', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    store._db.prepare('DELETE FROM handoff WHERE handoff_id = ?').run(hA);   // handoff_load 行被孤儿化（无 FK）
    assert.deepEqual(fromHandoff({ store, handoffId: hB }).map(s => s.sessionId), ['sess-B']);
  });

  test('forCurrentSession: 无 delivery 只返当前 session', () => {
    const chain = forCurrentSession({
      store, projectId: 'project-1', sessionId: 'sess-solo', transcriptPath: '/tmp/x.jsonl',
    });
    assert.deepEqual(chain, [{ label: 'S1', sessionId: 'sess-solo', transcriptPath: '/tmp/x.jsonl', handoffId: null }]);
  });

  test('forCurrentSession: 跨项目 delivery 不成为当前 session 的头', () => {
    // head 查询的 project 谓词是列表/候选/增删这整条 current-session 面唯一的项目边界：少了它，
    // 另一个项目的会话就会作为祖先段出现，其可见消息随即变成可书签目标。
    const hOther = seedHandoff({ sessionId: 'sess-A', loadToken: 'tOther', projectId: 'other', createdAt: 1000 });
    seedDelivery({ handoffId: hOther, sessionId: 'sess-B', loadedAt: 1500 });
    const chain = forCurrentSession({ store, projectId: 'project-1', sessionId: 'sess-B', transcriptPath: null });
    assert.deepEqual(chain.map(s => [s.label, s.sessionId]), [['S1', 'sess-B']]);
  });

  test('A→B→A 链只得到一个 A 的 S（session 级截断，保留较新出现）', () => {
    const h1 = seedHandoff({ sessionId: 'sess-A', loadToken: 't1', createdAt: 100 });
    seedDelivery({ handoffId: h1, sessionId: 'sess-B', loadedAt: 150 });
    const h2 = seedHandoff({ sessionId: 'sess-B', loadToken: 't2', createdAt: 200 });
    seedDelivery({ handoffId: h2, sessionId: 'sess-A', loadedAt: 250 });
    const h3 = seedHandoff({ sessionId: 'sess-A', loadToken: 't3', createdAt: 300 });
    const chain = fromHandoff({ store, handoffId: h3 });
    assert.deepEqual(chain.map(s => [s.label, s.sessionId]), [['S1', 'sess-B'], ['S2', 'sess-A']]);
  });

  test('父边指回自身的退化 fixture 仍终止', () => {
    const h = seedHandoff({ sessionId: 'sess-S', loadToken: 'tS', createdAt: 1000 });
    seedDelivery({ handoffId: h, sessionId: 'sess-S', loadedAt: 1000 });   // loaded_at == created_at
    const chain = fromHandoff({ store, handoffId: h });
    assert.deepEqual(chain.map(s => s.sessionId), ['sess-S']);
  });

  test('forCurrentSession: 当前 session 同时也是祖先时只出现一次（保留较新那次）', () => {
    // C 交给 B，B 又交回被 resume 的 C：追加的当前 session 是较新那次出现，走 walk 的同一条截断。
    const h1 = seedHandoff({ sessionId: 'sess-C', loadToken: 't1', createdAt: 100 });
    seedDelivery({ handoffId: h1, sessionId: 'sess-B', loadedAt: 150 });
    const h2 = seedHandoff({ sessionId: 'sess-B', loadToken: 't2', createdAt: 200 });
    seedDelivery({ handoffId: h2, sessionId: 'sess-C', loadedAt: 250 });
    const chain = forCurrentSession({ store, projectId: 'project-1', sessionId: 'sess-C', transcriptPath: null });
    assert.deepEqual(chain.map(s => [s.label, s.sessionId]), [['S1', 'sess-B'], ['S2', 'sess-C']]);
  });

  test('lineage 等价性: fromHandoff(H) 是 forCurrentSession 去掉末尾当前 session 的前缀', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    seedDelivery({ handoffId: hB, sessionId: 'sess-C', loadedAt: 2500 });
    const cur = forCurrentSession({ store, projectId: 'project-1', sessionId: 'sess-C', transcriptPath: null });
    const explicit = fromHandoff({ store, handoffId: hB });
    assert.deepEqual(cur.slice(0, -1).map(s => s.sessionId), explicit.map(s => s.sessionId));
  });

  test('forLoadedHandoff: 取本 session 最近一次 delivery 的 head，不追加当前 session', () => {
    // 读面的 S{k} 标号必须与 load 响应、与显式 head 的 HTTP 路由完全一致；追加当前 session 会把
    // 每个标号整体挪一位，让同一个地址在两条路上指向不同的 Lineage Session。
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    seedDelivery({ handoffId: hB, sessionId: 'sess-C', loadedAt: 2500 });
    const chain = forLoadedHandoff({ store, sessionId: 'sess-C' });
    assert.deepEqual(chain.map(s => [s.label, s.sessionId]), [['S1', 'sess-A'], ['S2', 'sess-B']]);
    assert.ok(!chain.some(s => s.sessionId === 'sess-C'));
  });

  test('forLoadedHandoff: 无 delivery 返回空数组', () => {
    assert.deepEqual(forLoadedHandoff({ store, sessionId: 'sess-solo' }), []);
  });

  test('forLoadedHandoff: 跨项目 delivery 仍成为 head，父链按 head 行自己的 project 走', () => {
    // 这个 session 真的载入过这个 handoff，所以它读得到 —— 查询没有 project 谓词。父链的项目边界
    // 来自 head 行自己的 project_id，于是 'other' 项目内部的祖先照样接上。
    const hAnc = seedHandoff({ sessionId: 'sess-anc', loadToken: 'tAnc', projectId: 'other', createdAt: 500 });
    seedDelivery({ handoffId: hAnc, sessionId: 'sess-X', loadedAt: 700 });
    const hOther = seedHandoff({ sessionId: 'sess-X', loadToken: 'tX', projectId: 'other', createdAt: 1000 });
    seedDelivery({ handoffId: hOther, sessionId: 'sess-B', loadedAt: 1500 });
    const chain = forLoadedHandoff({ store, sessionId: 'sess-B' });
    assert.ok(chain.length > 0);
    assert.deepEqual(chain.map(s => [s.label, s.sessionId]), [['S1', 'sess-anc'], ['S2', 'sess-X']]);
  });

  test('forLoadedHandoff(sid) 与 fromHandoff(该 session 最近 delivery 的 handoffId) 逐字相同', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    const hX = seedHandoff({ sessionId: 'sess-X', loadToken: 'tX', createdAt: 1100 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1400 });
    seedDelivery({ handoffId: hX, sessionId: 'sess-B', loadedAt: 1600 });
    assert.deepEqual(
      forLoadedHandoff({ store, sessionId: 'sess-B' }),
      fromHandoff({ store, handoffId: hX }),
    );
  });

  test('forLoadedHandoff: 最新 delivery 的 handoff 已 GC 时返回空，不回退到更早 delivery', () => {
    // 最近那条 delivery 事实独占这个 session 的隐式契约。它的目标过期后走 no_handoff_loaded 那条路，
    // 而不是把 S{k}:{T} 悄悄重新绑到更早的历史上。
    const hOld = seedHandoff({ sessionId: 'sess-O', loadToken: 'tO', createdAt: 1000 });
    seedDelivery({ handoffId: hOld, sessionId: 'sess-B', loadedAt: 1400 });
    const hNew = seedHandoff({ sessionId: 'sess-N', loadToken: 'tN', createdAt: 1100 });
    seedDelivery({ handoffId: hNew, sessionId: 'sess-B', loadedAt: 1600 });
    store._db.prepare('DELETE FROM handoff WHERE handoff_id = ?').run(hNew);
    assert.deepEqual(forLoadedHandoff({ store, sessionId: 'sess-B' }), []);
  });
});

// ============== materializeLineage tests ==============

describe('materializeLineage', () => {
  let materializeLineage;

  beforeEach(async () => {
    ({ materializeLineage } = await import('../lib/bookmark-service.js'));
  });

  test('every visible message of an ancestor segment is materialized', () => {
    // The handoff token sits mid-transcript. Everything on both sides of it is in scope:
    // membership in the lineage is decided per session, never per byte offset.
    const entries = [
      userMessage({ uuid: 'u1', text: 'first', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'mid-1', blocks: [{ type: 'text', text: 'resp1' }], timestamp: ts(2) }),
      { type: 'user', uuid: 'load-marker', parentUuid: 'a1', isSidechain: false, timestamp: ts(3),
        message: { role: 'user', content: 'token-ab' } },
      assistantObservation({ uuid: 'a2', parentUuid: 'load-marker', messageId: 'mid-2', blocks: [{ type: 'text', text: 'after-handoff' }], timestamp: ts(4) }),
    ];
    const path = writeTranscript(dir, entries);

    seedBookmark({ sourceSessionId: 'session-a', anchorUuid: 'a1' });

    const lineage = [{ sessionId: 'session-a', transcriptPath: path }];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    const texts = rows.map(r => r.text);
    assert.ok(texts.includes('first'), 'user message included');
    assert.ok(texts.includes('resp1'), 'assistant message included');
    assert.ok(texts.includes('after-handoff'), 'a message following the handoff token is still in scope');
  });

  test('a bookmark on a message following the handoff token resolves as canonical, not orphan', () => {
    const entries = [
      userMessage({ uuid: 'u1', text: 'before', timestamp: ts(1) }),
      { type: 'user', uuid: 'marker', parentUuid: 'u1', isSidechain: false, timestamp: ts(2),
        message: { role: 'user', content: 'token-cut' } },
      assistantObservation({ uuid: 'a-post', parentUuid: 'marker', messageId: 'mid-post', blocks: [{ type: 'text', text: 'post' }], timestamp: ts(3) }),
    ];
    const path = writeTranscript(dir, entries);

    seedBookmark({ sourceSessionId: 'sess-x', anchorUuid: 'a-post' });

    const lineage = [{ sessionId: 'sess-x', transcriptPath: path }];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    const row = rows.find(r => r.anchorUuid === 'a-post');
    assert.ok(row, 'the bookmarked message must be materialized');
    assert.equal(row.orphan, false, 'it resolves from the transcript, so it is not an orphan');
    assert.equal(row.text, 'post', 'canonical text wins over the persisted preview');
  });

  test('a bookmark added long after the handoff is still included', () => {
    const entries = [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'mid-1', blocks: [{ type: 'text', text: 'world' }], timestamp: ts(2) }),
      { type: 'user', uuid: 'hoff', parentUuid: 'a1', isSidechain: false, timestamp: ts(3),
        message: { role: 'user', content: 'token-x' } },
    ];
    const path = writeTranscript(dir, entries);

    seedBookmark({ sourceSessionId: 'sess-y', anchorUuid: 'a1', sourceTimestamp: 5000 });

    const lineage = [{ sessionId: 'sess-y', transcriptPath: path }];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: false });
    const bookmarkedAnchors = rows.filter(r => r.bookmarked).map(r => r.anchorUuid);
    assert.ok(bookmarkedAnchors.includes('a1'), 'bookmark state is live regardless of creation time');
  });

  test('the tail session includes its most recent messages', () => {
    const entries = [
      userMessage({ uuid: 'u1', text: 'start', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'mid-1', blocks: [{ type: 'text', text: 'response' }], timestamp: ts(2) }),
      userMessage({ uuid: 'u2', parentUuid: 'a1', text: 'post-prepare', timestamp: ts(3) }),
    ];
    const path = writeTranscript(dir, entries);

    seedBookmark({ sourceSessionId: 'sess-tail', anchorUuid: 'u2', role: 'user' });

    const lineage = [{ sessionId: 'sess-tail', transcriptPath: path }];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    const anchors = rows.map(r => r.anchorUuid);
    assert.ok(anchors.includes('u2'), 'tail session includes messages after any hypothetical prepare');
  });

  test('a segment reads exactly one transcript view', () => {
    // The retired cutoff view forced a second full read per ancestor. One view per segment now.
    const entries = [
      userMessage({ uuid: 'u1', text: 'only-msg', timestamp: ts(1) }),
    ];
    const path = writeTranscript(dir, entries);

    const warnings = [];
    const lineage = [{ sessionId: 'sess-anc', transcriptPath: path }];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true, warn: (msg) => warnings.push(msg) });
    assert.ok(rows.some(r => r.text === 'only-msg'), 'the transcript is materialized');
    assert.deepEqual(warnings, [], 'a well-formed segment produces no warning');
  });

  test('locally unlocatable active row follows parsed messages and sorts by timestamp', () => {
    // Transcript has one message; bookmark references a UUID NOT in the transcript
    const entries = [
      userMessage({ uuid: 'u1', text: 'known', timestamp: ts(1) }),
    ];
    const path = writeTranscript(dir, entries);

    // Active bookmark with anchor not found in transcript
    seedBookmark({ sourceSessionId: 'sess-o', anchorUuid: 'orphan-uuid-1', sourceTimestamp: 3000 });
    seedBookmark({ sourceSessionId: 'sess-o', anchorUuid: 'orphan-uuid-2', sourceTimestamp: 1000 });

    const lineage = [
      { sessionId: 'sess-o', transcriptPath: path },
    ];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    // Orphans come AFTER the canonical messages
    const canonicalIdx = rows.findIndex(r => r.anchorUuid === 'u1');
    const orphan1Idx = rows.findIndex(r => r.anchorUuid === 'orphan-uuid-1');
    const orphan2Idx = rows.findIndex(r => r.anchorUuid === 'orphan-uuid-2');
    assert.ok(orphan1Idx > canonicalIdx, 'orphan after canonical');
    assert.ok(orphan2Idx > canonicalIdx, 'orphan after canonical');
    // Sorted by timestamp
    assert.ok(orphan2Idx < orphan1Idx, 'orphans sorted by timestamp (1000 before 3000)');
    // spec §5.5: the field means "this canonical source message is unavailable", not "the
    // transcript file is missing", so an unlocatable anchor reports false even though the
    // transcript itself read fine.
    assert.equal(rows[orphan1Idx].source_available, false);
    assert.equal(rows[orphan1Idx].orphan, true);
  });

  test('active bookmark whose message falls off canonical fork uses orphan fallback', () => {
    // Topology: u1 is root, with children a1 (written first) and u2 (written later). Branch
    // selection takes the newest write in u1's subtree — a2 — so the canonical branch is
    // u1 -> u2 -> a2 and the u1 -> a1 -> u3 fork is off it. Both forks are two nodes deep, so this
    // fixture also rejects a deepest-descendant rule: only write order separates them.
    // Bookmark on a1 (dead fork anchor) should become an orphan.
    const entries = [
      userMessage({ uuid: 'u1', text: 'root', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'mid-1', blocks: [{ type: 'text', text: 'old-branch' }], timestamp: ts(2) }),
      userMessage({ uuid: 'u3', parentUuid: 'a1', text: 'old-continue', timestamp: ts(3) }),
      // Fork: a2 below u2 is the newest write, so the canonical path goes through u2
      userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'new-branch', timestamp: ts(4) }),
      assistantObservation({ uuid: 'a2', parentUuid: 'u2', messageId: 'mid-2', blocks: [{ type: 'text', text: 'new-resp' }], timestamp: ts(5) }),
    ];
    const path = writeTranscript(dir, entries);

    // Bookmark on a1 (on dead fork — not in the canonical branch)
    seedBookmark({ sourceSessionId: 'sess-fork', anchorUuid: 'a1', sourceTimestamp: 2000 });

    const lineage = [
      { sessionId: 'sess-fork', transcriptPath: path },
    ];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: false });
    // a1 should appear as orphan (no cause classification — same fallback as any unlocatable)
    const a1Row = rows.find(r => r.anchorUuid === 'a1');
    assert.ok(a1Row, 'dead-fork bookmark appears');
    assert.equal(a1Row.orphan, true);
  });

  test('wholly unavailable transcript returns all active persisted previews sorted by timestamp', () => {
    // Use a nonexistent path
    seedBookmark({ sourceSessionId: 'sess-gone', anchorUuid: 'bk-1', sourceTimestamp: 3000, role: 'user' });
    seedBookmark({ sourceSessionId: 'sess-gone', anchorUuid: 'bk-2', sourceTimestamp: 1000, role: 'assistant' });

    const lineage = [
      { sessionId: 'sess-gone', transcriptPath: '/nonexistent/path.jsonl' },
    ];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].source_available, false);
    assert.equal(rows[1].source_available, false);
    // Sorted by timestamp
    assert.equal(rows[0].anchorUuid, 'bk-2'); // ts=1000
    assert.equal(rows[1].anchorUuid, 'bk-1'); // ts=3000
  });

  test('an unavailable transcript warns and names the session it degraded', () => {
    // The fail-open is silent otherwise: rows come back as persisted previews with no signal
    // that a transcript went missing, so a deleted or rotated file looks like normal output.
    seedBookmark({ sourceSessionId: 'sess-gone', anchorUuid: 'bk-1', sourceTimestamp: 1000 });

    const warnings = [];
    const lineage = [
      { sessionId: 'sess-gone', transcriptPath: '/nonexistent/path.jsonl' },
    ];

    materializeLineage({
      store, lineage, projectId: 'project-1', includeUnbookmarked: true,
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(warnings.length, 1, 'exactly one warning per degraded segment');
    assert.match(warnings[0], /sess-gone/, 'the warning must identify the session');
    assert.match(warnings[0], /unavailable|persisted|preview/i);
    assert.ok(!warnings[0].includes('/nonexistent/path.jsonl'), 'must not leak the transcript path');
  });

  test('an unavailable segment with no active bookmark still warns', () => {
    // Zero rows to emit is exactly when a silent fail-open is least detectable.
    const warnings = [];
    const lineage = [
      { sessionId: 'sess-empty', transcriptPath: '/gone.jsonl' },
    ];

    const rows = materializeLineage({
      store, lineage, projectId: 'project-1', includeUnbookmarked: true,
      warn: (msg) => warnings.push(msg),
    });

    assert.deepEqual(rows, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sess-empty/);
  });

  test('an available segment produces no unavailable warning', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'present', timestamp: ts(1) }),
    ]);

    const warnings = [];
    materializeLineage({
      store, lineage: [{ sessionId: 'sess-ok', transcriptPath: path }],
      projectId: 'project-1', includeUnbookmarked: true,
      warn: (msg) => warnings.push(msg),
    });

    assert.deepEqual(warnings, []);
  });

  test('unavailable ancestor does not prevent later sessions', () => {
    const entries = [
      userMessage({ uuid: 'u1', text: 'tail-msg', timestamp: ts(1) }),
    ];
    const pathTail = writeTranscript(dir, entries);

    seedBookmark({ sourceSessionId: 'sess-missing', anchorUuid: 'bk-m', sourceTimestamp: 500 });
    seedBookmark({ sourceSessionId: 'sess-miss2', anchorUuid: 'bk-n', sourceTimestamp: 600 });
    seedBookmark({ sourceSessionId: 'sess-tail', anchorUuid: 'u1', role: 'user', sourceTimestamp: 1000 });

    const warnings = [];
    const lineage = [
      { sessionId: 'sess-missing', transcriptPath: '/gone.jsonl' },
      { sessionId: 'sess-miss2', transcriptPath: '/also-gone.jsonl' },
      { sessionId: 'sess-tail', transcriptPath: pathTail },
    ];

    const rows = materializeLineage({
      store, lineage, projectId: 'project-1', includeUnbookmarked: true,
      warn: (msg) => warnings.push(msg),
    });
    // First session's rows come first (unavailable)
    const missingRow = rows.find(r => r.anchorUuid === 'bk-m');
    assert.ok(missingRow, 'unavailable ancestor bookmark present');
    assert.equal(missingRow.source_available, false);
    // Tail session's messages present
    const tailRow = rows.find(r => r.anchorUuid === 'u1');
    assert.ok(tailRow, 'tail session messages present');
    assert.equal(tailRow.source_available, true);
    // §5.3 degrades per segment, so each dead ancestor warns on its own. A single deduped
    // warning for the whole walk would report one lost session where two were lost.
    assert.equal(warnings.length, 2, 'one warning per degraded segment, not one per lineage');
    assert.ok(warnings.some(w => w.includes('sess-missing')));
    assert.ok(warnings.some(w => w.includes('sess-miss2')));
  });

  test('inactive bookmark row absent from materialization', () => {
    const entries = [
      userMessage({ uuid: 'u1', text: 'visible', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'mid-1', blocks: [{ type: 'text', text: 'resp' }], timestamp: ts(2) }),
    ];
    const path = writeTranscript(dir, entries);

    // Create then deactivate
    seedBookmark({ sourceSessionId: 'sess-inact', anchorUuid: 'a1' });
    store.deactivateBookmark('project-1', 'sess-inact', 'a1');

    const lineage = [
      { sessionId: 'sess-inact', transcriptPath: path },
    ];

    // includeUnbookmarked=false means only bookmarked rows appear; inactive bookmark should NOT
    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: false });
    const a1Row = rows.find(r => r.anchorUuid === 'a1');
    assert.ok(!a1Row, 'inactive bookmark must not appear');
  });

  test('reversed timestamps do not reorder available-transcript messages (physical order preserved)', () => {
    // msg at ts(5) is written to the file BEFORE msg at ts(3) — reversed/out-of-order timestamps.
    // materializeLineage must return them in physical (fold) order, not timestamp order.
    const entries = [
      userMessage({ uuid: 'u-high-ts', text: 'high-timestamp-first', timestamp: ts(5) }),
      assistantObservation({ uuid: 'a-low-ts', parentUuid: 'u-high-ts', messageId: 'mid-low', blocks: [{ type: 'text', text: 'low-timestamp-second' }], timestamp: ts(3) }),
    ];
    const path = writeTranscript(dir, entries);

    const lineage = [
      { sessionId: 'sess-rev', transcriptPath: path },
    ];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    const anchors = rows.map(r => r.anchorUuid);
    // Physical order: u-high-ts first, a-low-ts second — regardless of timestamps
    const highIdx = anchors.indexOf('u-high-ts');
    const lowIdx = anchors.indexOf('a-low-ts');
    assert.ok(highIdx !== -1, 'u-high-ts present');
    assert.ok(lowIdx !== -1, 'a-low-ts present');
    assert.ok(highIdx < lowIdx, 'physical order preserved: u-high-ts (ts=5) before a-low-ts (ts=3)');
  });

  test('lost lineage connection leaves DB row but not projection', () => {
    // A bookmark for a session that is NOT in the lineage
    seedBookmark({ sourceSessionId: 'sess-lost', anchorUuid: 'bk-lost', sourceTimestamp: 500 });

    const entries = [
      userMessage({ uuid: 'u1', text: 'present', timestamp: ts(1) }),
    ];
    const path = writeTranscript(dir, entries);

    const lineage = [
      { sessionId: 'sess-actual', transcriptPath: path },
    ];

    const rows = materializeLineage({ store, lineage, projectId: 'project-1', includeUnbookmarked: true });
    // sess-lost is not in the lineage, so its bookmarks must not appear
    const lostRow = rows.find(r => r.anchorUuid === 'bk-lost');
    assert.ok(!lostRow, 'bookmarks from sessions not in lineage must not appear');
  });
});


// The retired traversal is checked two ways that observe rather than read: a module either resolves or
// it does not, and a symbol either lands in the live namespace or it does not. Private use is outside
// this test's observable surface. scripts/handoff-inspect.mjs is left out because it has no entry guard:
// importing it opens the real store and can exit the process.
test('the retired lineage traversal is gone: unexported everywhere, and its module does not resolve', async () => {
  assert.equal(existsSync(new URL('../lib/bookmark-lineage.js', import.meta.url)), false);
  const retired = ['resolveApplicableLineage', 'findParentHandoff', 'loadFragmentForHandoff'];
  for (const path of ['../lib/lineage.js', '../lib/bookmark-service.js', '../lib/bookmark-detail.js',
    '../lib/store.js', '../server.js']) {
    const ns = await import(path);
    for (const symbol of retired) assert.ok(!(symbol in ns), `${path} still exports ${symbol}`);
  }
});
