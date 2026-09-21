// test/turn-browse.test.js — the human browse snapshot. It reads Store Turn Records and the transient
// `S{k}` view of the lineage it was handed, and no Source at all: `buildTurnBrowse` takes a store and a
// lineage, so Source health has no way into this snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnBrowse, lineageHeadlines } from '../lib/turn-browse.js';

const rowOf = (turnNoteId, anchorUuid, over = {}) => ({
  turnNoteId, anchorUuid, uText: `u ${anchorUuid}`,
  uOriginalChars: `u ${anchorUuid}`.length, note: `note ${anchorUuid}`,
  sourceTimestamp: 1, ...over,
});
// No `label`: the transient `S{k}` view is derived from lineage position, so a fixture cannot supply one.
const lineage = [
  { sessionId: 'old', sourceLocator: '/t/old.jsonl', sourceLabel: '/t/old.jsonl', handoffId: 41 },
  { sessionId: 'new', sourceLocator: '/t/new.jsonl', sourceLabel: '/t/new.jsonl', handoffId: 42 },
];
const rowsBySession = {
  old: [rowOf(7, 'o1')],
  new: [rowOf(11, 'n1'), rowOf(12, 'n2', { note: null })],
};
// getHandoff 是主键点查，行被 sweep 掉时答 null —— 与 lib/store.js 的返回形状一致。
const handoffs = {
  41: { handoffId: 41, nextTask: 'S1 交出的任务' },
  42: { handoffId: 42, nextTask: 'S2 交出的任务' },
};
const listAll = (sid) => rowsBySession[sid] ?? [];
const store = { listTurnNotes: listAll, getHandoff: (id) => handoffs[id] ?? null };
const build = () => buildTurnBrowse({ store, lineage });

test('三段 lineage 得到三个 section，label 由 lineage 位置派生，自老到新', () => {
  const { sections } = buildTurnBrowse({
    store: { listTurnNotes: (sid) => [rowOf(1, sid)], getHandoff: () => null },
    lineage: [
      { sessionId: 'a', sourceLocator: null, sourceLabel: null, handoffId: 91 },
      { sessionId: 'b', sourceLocator: null, sourceLabel: null, handoffId: 92 },
      { sessionId: 'c', sourceLocator: null, sourceLabel: null, handoffId: 93 },
    ],
  });
  assert.deepEqual(sections.map(s => s.label), ['S1', 'S2', 'S3']);
});

test('地址与任何转录派生字段都不出现在 wire 上，headline 始终是字符串', () => {
  for (const section of build().sections) {
    assert.deepEqual(Object.keys(section).sort(), ['entries', 'headline', 'label']);
    assert.equal(typeof section.headline, 'string');
    for (const entry of section.entries) {
      assert.deepEqual(Object.keys(entry).filter(k => !['u_text', 'note'].includes(k)), []);
    }
  }
});

test('非根段的 headline 是前一段交出的 handoff 的 nextTask，不是本段自己交出的', () => {
  const { sections } = build();
  assert.equal(sections[1].headline, 'S1 交出的任务');
  assert.notEqual(sections[1].headline, handoffs[42].nextTask);
});

test('前一段的 handoff 行已不在库里时，headline 为空串而段内行照旧', () => {
  const { sections } = buildTurnBrowse({
    store: { listTurnNotes: listAll, getHandoff: () => null },
    lineage,
  });
  assert.equal(sections[1].headline, '');
  assert.deepEqual(sections[1].entries.map(e => e.u_text), ['u n1', 'u n2']);
});

test('前一段 handoff 的 nextTask 为 null 时，headline 为空串', () => {
  const { sections } = buildTurnBrowse({
    store: {
      listTurnNotes: listAll,
      getHandoff: (id) => ({ handoffId: id, nextTask: null }),
    },
    lineage,
  });
  assert.equal(sections[1].headline, '');
});

test('根段 headline 串起开头无 note 的行与第一条有 note 的行；第一条有 note 之后的行不入选', () => {
  const rows = [
    rowOf(1, 'open', { note: null }),
    rowOf(2, 'still-open', { note: '' }),
    rowOf(3, 'answered', { note: 'A 观察到了' }),
    rowOf(4, 'trailing', { note: null }),
  ];
  const { sections } = buildTurnBrowse({
    store: { listTurnNotes: () => rows, getHandoff: () => null },
    lineage: [lineage[0]],
  });
  assert.equal(sections[0].headline, 'u open · u still-open · u answered');
});

test('根段没有任何行带 note 时，headline 是全部行的连接', () => {
  const { sections } = buildTurnBrowse({
    store: {
      listTurnNotes: () => [rowOf(1, 'a', { note: null }), rowOf(2, 'b', { note: '' })],
      getHandoff: () => null,
    },
    lineage: [lineage[0]],
  });
  assert.equal(sections[0].headline, 'u a · u b');
});

// 幸存段的 headline 认的是 lineage 前驱，不是前一个 section：零笔记的 S1 不出 section，但它仍是 S2
// 拿到任务的那一段。若 headline 改按 section 下标定根，S2 会被当成根而自述开场。
test('零笔记 session 不产生 section，后继段的 headline 仍是 lineage 前驱交出的任务', () => {
  const { sections } = buildTurnBrowse({
    store: {
      listTurnNotes: (sid) => (sid === 'new' ? rowsBySession.new : []),
      getHandoff: (id) => handoffs[id] ?? null,
    },
    lineage,
  });
  assert.deepEqual(sections.map(s => s.label), ['S2']);
  assert.equal(sections[0].headline, handoffs[41].nextTask);
});

test('段内按 turn_note_id 升序，不认 DB 返回顺序；note 为 NULL 时键 absent', () => {
  const { sections } = buildTurnBrowse({
    store: {
      listTurnNotes: () => [rowOf(90, 'late', { note: null }), rowOf(4, 'early')],
      getHandoff: () => null,
    },
    lineage: [lineage[0]],
  });
  assert.deepEqual(sections[0].entries, [
    { u_text: 'u early', note: 'note early' },
    { u_text: 'u late' },
  ]);
  assert.equal('note' in sections[0].entries[1], false);
});

test('空 lineage 得到空快照，不抛错', () => {
  assert.deepEqual(buildTurnBrowse({ store, lineage: [] }), { sections: [] });
});

test('标签、正文、headline 与各段条目数全部由 Store 行与 lineage 定出', () => {
  const { sections } = build();
  assert.deepEqual(sections.map(s => s.label), ['S1', 'S2']);
  assert.deepEqual(sections.map(s => s.entries.length), [1, 2]);
  assert.deepEqual(sections[1].entries.map(e => e.u_text), ['u n1', 'u n2']);
  assert.equal(sections[1].headline, 'S1 交出的任务');
});

test('lineageHeadlines 与 buildTurnBrowse 同段同序，每项只有 label 与 headline', () => {
  const { sections } = build();
  const headlines = lineageHeadlines({ store, lineage });
  assert.deepEqual(headlines, sections.map(({ label, headline }) => ({ label, headline })));
  for (const entry of headlines) assert.deepEqual(Object.keys(entry).sort(), ['headline', 'label']);
});

test('零笔记 session 不产生项，后继项的 label 仍由 lineage 位置派生', () => {
  const sparse = {
    listTurnNotes: (sid) => (sid === 'new' ? rowsBySession.new : []),
    getHandoff: (id) => handoffs[id] ?? null,
  };
  assert.deepEqual(lineageHeadlines({ store: sparse, lineage }),
    [{ label: 'S2', headline: handoffs[41].nextTask }]);
});

test('空 lineage 得到空列表，不抛错', () => {
  assert.deepEqual(lineageHeadlines({ store, lineage: [] }), []);
});
