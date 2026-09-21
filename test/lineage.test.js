// test/lineage.test.js — the Lineage Resolver (fromHandoff / forLoadedHandoff). It alone owns the
// handoff-graph traversal, the session deduplication and the oldest-to-newest order; the transient `S{k}`
// view is derived from that order by Turn History, and the stored transcript path is copied into
// `sourceLocator` and `sourceLabel` without being interpreted.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore } from '../lib/store.js';
import { fromHandoff, forLoadedHandoff } from '../lib/lineage.js';
import { labelHistorySources } from '../lib/turn.js';

let dir, store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-lineage-'));
  store = openStore(join(dir, 'lineage.sqlite'));
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

const labelled = (lineage) => labelHistorySources(lineage).map(s => [s.label, s.sessionId]);

// ============== Lineage Resolver tests ==============

describe('lineage resolver', () => {
  test('fromHandoff: duplicate claim 仍是合格父边', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500, claimResult: 'duplicate' });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    assert.deepEqual(labelled(fromHandoff({ store, handoffId: hB })),
      [['S1', 'sess-A'], ['S2', 'sess-B']]);
  });

  test('fromHandoff: prepare 之后发生的 load 不进父链', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 2500 }); // > hB.created_at
    assert.deepEqual(fromHandoff({ store, handoffId: hB }).map(s => s.sessionId), ['sess-B']);
  });

  test('fromHandoff: 同毫秒 delivery 按 handoff_id DESC 决胜', () => {
    const h1 = seedHandoff({ sessionId: 'sess-X', loadToken: 't1', createdAt: 1000 });
    const h2 = seedHandoff({ sessionId: 'sess-Y', loadToken: 't2', createdAt: 1000 });
    seedDelivery({ handoffId: h1, sessionId: 'sess-B', loadedAt: 1500 });
    seedDelivery({ handoffId: h2, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    assert.equal(fromHandoff({ store, handoffId: hB })[0].sessionId, 'sess-Y'); // h2 > h1
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
    assert.deepEqual(fromHandoff({ store, handoffId: hB }).map(s => s.sessionId), ['sess-B']);
  });

  test('project_id NULL：显式 head 自身可读，但 NULL 父边仍不串链', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', projectId: null, createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', projectId: null, createdAt: 2000 });
    assert.deepEqual(labelled(fromHandoff({ store, handoffId: hB })), [['S1', 'sess-B']]);
  });

  test('父边指向已被 GC 删除的 handoff 时按链尾处理，不报错', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    store._db.prepare('DELETE FROM handoff WHERE handoff_id = ?').run(hA);   // handoff_load 行被孤儿化（无 FK）
    assert.deepEqual(fromHandoff({ store, handoffId: hB }).map(s => s.sessionId), ['sess-B']);
  });

  test('fromHandoff: 无法解析的 head 得到空链', () => {
    assert.deepEqual(fromHandoff({ store, handoffId: 9999 }), []);
  });

  test('A→B→A 链只得到一个 A 的 S（session 级截断，保留较新出现）', () => {
    const h1 = seedHandoff({ sessionId: 'sess-A', loadToken: 't1', createdAt: 100 });
    seedDelivery({ handoffId: h1, sessionId: 'sess-B', loadedAt: 150 });
    const h2 = seedHandoff({ sessionId: 'sess-B', loadToken: 't2', createdAt: 200 });
    seedDelivery({ handoffId: h2, sessionId: 'sess-A', loadedAt: 250 });
    const h3 = seedHandoff({ sessionId: 'sess-A', loadToken: 't3', createdAt: 300 });
    assert.deepEqual(labelled(fromHandoff({ store, handoffId: h3 })),
      [['S1', 'sess-B'], ['S2', 'sess-A']]);
  });

  test('父边指回自身的退化 fixture 仍终止', () => {
    const h = seedHandoff({ sessionId: 'sess-S', loadToken: 'tS', createdAt: 1000 });
    seedDelivery({ handoffId: h, sessionId: 'sess-S', loadedAt: 1000 });   // loaded_at == created_at
    assert.deepEqual(fromHandoff({ store, handoffId: h }).map(s => s.sessionId), ['sess-S']);
  });

  test('forLoadedHandoff: 取本 session 最近一次 delivery 的 head，不追加当前 session', () => {
    // 读面的 S{k} 标号必须与 load 响应、与显式 head 的 HTTP 路由完全一致；追加当前 session 会把
    // 每个标号整体挪一位，让同一个地址在两条路上指向不同的 Lineage Session。
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    seedDelivery({ handoffId: hB, sessionId: 'sess-C', loadedAt: 2500 });
    const chain = forLoadedHandoff({ store, sessionId: 'sess-C' });
    assert.deepEqual(labelled(chain), [['S1', 'sess-A'], ['S2', 'sess-B']]);
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
    assert.deepEqual(labelled(forLoadedHandoff({ store, sessionId: 'sess-B' })),
      [['S1', 'sess-anc'], ['S2', 'sess-X']]);
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

// ============== The History Source shape ==============

describe('the History Source shape', () => {
  test('an entry carries exactly the four canonical members', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000,
      transcriptPath: '/transcripts/sess-A.jsonl' });
    const chain = fromHandoff({ store, handoffId: hA });
    assert.deepEqual(chain, [{
      sessionId: 'sess-A',
      sourceLocator: '/transcripts/sess-A.jsonl',
      sourceLabel: '/transcripts/sess-A.jsonl',
      handoffId: hA,
    }]);
  });

  test('the stored path is copied into both members uninterpreted', () => {
    // A locator is what a DialogueSource is handed; a label is what output naming prints. The resolver
    // does not normalize, resolve or validate either one — a value with no filesystem meaning survives.
    const opaque = 'not-a-path::opaque locator';
    const h = seedHandoff({ sessionId: 'sess-O', loadToken: 'tO', createdAt: 1000, transcriptPath: opaque });
    const [entry] = fromHandoff({ store, handoffId: h });
    assert.equal(entry.sourceLocator, opaque);
    assert.equal(entry.sourceLabel, opaque);
  });

  test('a session with no stored path carries a null locator and label', () => {
    const h = seedHandoff({ sessionId: 'sess-N', loadToken: 'tN', createdAt: 1000, transcriptPath: null });
    const [entry] = fromHandoff({ store, handoffId: h });
    assert.equal(entry.sourceLocator, null);
    assert.equal(entry.sourceLabel, null);
  });

  test('handoffId is the handoff that session PRODUCED, per lineage member', () => {
    const hA = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    seedDelivery({ handoffId: hA, sessionId: 'sess-B', loadedAt: 1500 });
    const hB = seedHandoff({ sessionId: 'sess-B', loadToken: 'tB', createdAt: 2000 });
    assert.deepEqual(fromHandoff({ store, handoffId: hB }).map(s => [s.sessionId, s.handoffId]),
      [['sess-A', hA], ['sess-B', hB]]);
  });

  test('no entry carries a transient label or a next task', () => {
    // The `S{k}` mapping is derived from position by Turn History and stored nowhere; `nextTask` is read
    // by primary key where a headline needs it, never copied into the lineage.
    const h = seedHandoff({ sessionId: 'sess-A', loadToken: 'tA', createdAt: 1000 });
    for (const entry of fromHandoff({ store, handoffId: h })) {
      assert.deepEqual(Object.keys(entry).sort(),
        ['handoffId', 'sessionId', 'sourceLabel', 'sourceLocator']);
    }
  });

  test('labelHistorySources derives labels and positions from order alone', () => {
    const lineage = [
      { sessionId: 'a', sourceLocator: 'la', sourceLabel: 'la', handoffId: 1 },
      { sessionId: 'b', sourceLocator: 'lb', sourceLabel: 'lb', handoffId: 2 },
      { sessionId: 'c', sourceLocator: 'lc', sourceLabel: 'lc', handoffId: 3 },
    ];
    const sources = labelHistorySources(lineage);
    assert.deepEqual(sources.map(s => [s.label, s.index, s.sessionId]),
      [['S1', 0, 'a'], ['S2', 1, 'b'], ['S3', 2, 'c']]);
    // The input keeps every member and gains nothing: the view is transient.
    assert.deepEqual(lineage.map(e => Object.keys(e).sort()),
      lineage.map(() => ['handoffId', 'sessionId', 'sourceLabel', 'sourceLocator']));
  });
});

// The retired traversal and the retired current-session resolver are checked two ways that observe rather
// than read: a module either resolves or it does not, and a symbol either lands in the live namespace or
// it does not. Private use is outside this test's observable surface. scripts/handoff-inspect.mjs is left
// out because it has no entry guard: importing it opens the real store and can exit the process.
test('the retired lineage traversal and current-session resolver are gone', async () => {
  for (const gone of ['../lib/bookmark-lineage.js', '../lib/bookmark-service.js', '../lib/bookmark.js']) {
    assert.equal(existsSync(new URL(gone, import.meta.url)), false, `${gone} still exists`);
  }
  const retired = ['resolveApplicableLineage', 'findParentHandoff', 'loadFragmentForHandoff',
    'forCurrentSession', 'materializeLineage'];
  for (const path of ['../lib/lineage.js', '../lib/store.js', '../server.js']) {
    const ns = await import(path);
    for (const symbol of retired) assert.ok(!(symbol in ns), `${path} still exports ${symbol}`);
  }
});
