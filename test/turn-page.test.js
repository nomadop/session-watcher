// test/turn-page.test.js — the single Turn Page Operation: window selection, lazy per-session
// parse, budget accounting and the frozen page text.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore } from '../lib/store.js';
import { readCanonicalTranscript } from '../lib/dialogue-fold.js';
import { charsToTokens } from '../lib/measure.js';
import { DEFAULT_CTP } from '../lib/constants.js';
import { BOOKMARK_TOKEN_BUDGET } from '../lib/bookmark-core.js';
import { TURN_NOTICE, buildTurnPage } from '../lib/turn-page.js';
import {
  assistantObservation, compactSummary, ts, userMessage, writeTranscript,
} from './helpers/transcript-fixtures.js';

const dir = mkdtempSync(join(tmpdir(), 'sw-turn-page-'));
const store = openStore(join(dir, 't.sqlite'));
after(() => { closeStore(store); rmSync(dir, { recursive: true, force: true }); });

// ── Fixtures ───────────────────────────────────────────────────────────────────
// 合成 transcript + 直接 upsert 的 turn_note，本文件自带定义（不与 turn-query 共享）。转录里的物理行
// 号才是 T，所以 meta 行用来把头 U 推到指定绝对行 —— 取 turn 内下标一律对不上。

const lastUuid = (entries) => (entries.length ? entries[entries.length - 1].uuid : null);
const padTo = (entries, ordinal, tag) => {
  while (entries.length < ordinal) entries.push(userMessage({
    uuid: `${tag}-meta-${entries.length}`, parentUuid: lastUuid(entries),
    text: 'meta', timestamp: ts(0), extra: { isMeta: true },
  }));
  return entries;
};

// turns: [{ uuid, uText, at?, answer?, … }] —— `at` 是垫在该头 U 之前的行数，头 U 紧接其后
const transcriptOf = (tag, turns) => {
  const entries = [];
  for (const turn of turns) {
    if (turn.at != null) padTo(entries, turn.at, tag);
    entries.push(userMessage({
      uuid: turn.uuid, parentUuid: lastUuid(entries), text: turn.uText, timestamp: ts(1),
    }));
    entries.push(assistantObservation({
      uuid: `${turn.uuid}-a`, parentUuid: lastUuid(entries), messageId: `${turn.uuid}-m`,
      timestamp: ts(2), blocks: [{ type: 'text', text: turn.answer ?? 'ok' }],
    }));
  }
  return writeTranscript(dir, entries);
};

const noteRow = (sessionId, turn) => ({
  sourceSessionId: sessionId, anchorUuid: turn.uuid, uText: turn.uText,
  uOriginalChars: turn.uOriginalChars ?? turn.uText.length, note: turn.note ?? null,
  searchTerms: '', sourceTimestamp: turn.sourceTimestamp ?? 1000,
});

// specs 顺序即 lineage 顺序（旧 → 新），label 与 lib/lineage.js 的 `S${i+1}` 一致。每行单独 upsert，
// 于是 specs 里 `persist` 的顺序就是 DB 插入顺序。
const seedLineage = (specs) => specs.map((spec, i) => {
  const transcriptPath = spec.transcriptPath ?? transcriptOf(spec.sessionId, spec.turns ?? []);
  for (const turn of spec.persist ?? spec.turns ?? []) {
    store.upsertTurnNotes([noteRow(spec.sessionId, turn)]);
  }
  return { label: `S${i + 1}`, sessionId: spec.sessionId, transcriptPath, handoffId: 700 + i };
});

const rawLineage = (specs) => specs.map((spec, i) => {
  for (const turn of spec.persist ?? []) store.upsertTurnNotes([noteRow(spec.sessionId, turn)]);
  return { label: `S${i + 1}`, sessionId: spec.sessionId, transcriptPath: spec.transcriptPath, handoffId: 800 + i };
});

// 缺省页：每个 turn 一对 U/A 行，所以头 U 隔一行落一个；turn 数与每条 note 的长度都够，让整段
// wire 超过 BOOKMARK_TOKEN_BUDGET，第一页因此装不下最老的那条 —— 「before 取回上一页」需要一个
// 非空 nextBefore。
const sessACount = 10;
const sessATurns = Array.from({ length: sessACount }, (_, i) => ({
  uuid: `a-u${i + 1}`, uText: `u-turn-${i + 1}`, note: `${'n'.repeat(1490)}-note-${i + 1}`,
}));
const [lineageHead] = seedLineage([{ sessionId: 'sess-A', turns: sessATurns }]);
const lineage = [lineageHead];
// 第一页最先装入的是最新 turn，它必须不出现在更旧页里
const firstTurnUText = `u-turn-${sessACount}`;

const [hugeSingleTurnSession] = seedLineage([{
  sessionId: 'sess-huge',
  turns: [{ uuid: 'huge-u1', uText: 'u-huge', note: 'n'.repeat(20000) }],
}]);

// 多行 U + 截断：标记只能落在最后一个 U 物理行
const [truncatedUSession] = seedLineage([{
  sessionId: 'sess-trunc',
  turns: [{ uuid: 'trunc-u1', uText: 'u-cut-first\nu-cut-second', uOriginalChars: 999 }],
}]);

// 同一会话里一个短地址与一个长地址：续行填充按地址自己的宽度定尺
const [wideOrdinalSession] = seedLineage([{
  sessionId: 'sess-wide',
  turns: [
    { uuid: 'wide-u1', uText: 'u-wide-narrow', at: 12, note: 'wide-note-narrow' },
    { uuid: 'wide-u2', uText: 'u-wide-broad', at: 1718, note: 'wide-note-broad' },
  ],
}]);

const [multilineSession] = seedLineage([{
  sessionId: 'sess-multi',
  turns: [{ uuid: 'multi-u1', uText: 'u-first\r\nu-second\n\nu-fourth', at: 12, note: 'a-first\ra-second' }],
}]);

// 三个会话、每个 6 个 turn，合计远超预算：装页要跨会话推进后才停
const bigLineage = seedLineage(['sess-big-1', 'sess-big-2', 'sess-big-3'].map(sessionId => ({
  sessionId,
  turns: Array.from({ length: 6 }, (_, i) => ({
    uuid: `${sessionId}-u${i + 1}`, uText: `${sessionId}-turn-${i + 1}`,
    note: `${'b'.repeat(1200)}-${sessionId}-${i + 1}`,
  })),
})));

// 最新会话单独就装满 5000：更老两个会话的 transcript 不该被打开
const threeSessionLineage = seedLineage([
  { sessionId: 'sess-three-1', turns: [{ uuid: 'three1-u1', uText: 'three-1-turn', note: 'old note 1' }] },
  { sessionId: 'sess-three-2', turns: [{ uuid: 'three2-u1', uText: 'three-2-turn', note: 'old note 2' }] },
  {
    sessionId: 'sess-three-3',
    turns: Array.from({ length: 8 }, (_, i) => ({
      uuid: `three3-u${i + 1}`, uText: `three-3-turn-${i + 1}`,
      note: `${'c'.repeat(2200)}-${i + 1}`,
    })),
  },
]);

// 边界 session 之外还各有一个更老与一个更新的 session：切窗要保留前者、整条排除后者
const s1OlderText = 's1-older-u';
const s2Turn10Text = 's2-turn-ten-u';
const s2Turn20Text = 's2-turn-twenty-u';
const s2Turn30Text = 's2-turn-thirty-u';
const s3NewerText = 's3-newer-u';
const crossSessionLineage = seedLineage([
  { sessionId: 'sess-cross-1', turns: [{ uuid: 'cross-1-u1', uText: s1OlderText, note: 'older note' }] },
  {
    sessionId: 'sess-cross-2',
    turns: [
      { uuid: 'cross-2-u1', uText: s2Turn10Text, at: 10, note: 'ten note' },
      { uuid: 'cross-2-u2', uText: s2Turn20Text, at: 20, note: 'twenty note' },
      { uuid: 'cross-2-u3', uText: s2Turn30Text, at: 30, note: 'thirty note' },
    ],
  },
  { sessionId: 'sess-cross-3', turns: [{ uuid: 'cross-3-u1', uText: s3NewerText, note: 'newer note' }] },
]);

// compact：同一会话里 compact summary 前后各有一条已持久化记录
const compactEntries = [
  userMessage({ uuid: 'compact-u1', text: 'pre-compact-u', timestamp: ts(1) }),
  assistantObservation({ uuid: 'compact-a1', parentUuid: 'compact-u1', messageId: 'compact-m1',
    timestamp: ts(2), blocks: [{ type: 'text', text: 'pre answer' }] }),
  compactSummary({ uuid: 'compact-c1', timestamp: ts(3) }),
  userMessage({ uuid: 'compact-u2', parentUuid: 'compact-c1', text: 'post-compact-u', timestamp: ts(4) }),
];
const [compactSession] = rawLineage([{
  sessionId: 'sess-compact', transcriptPath: writeTranscript(dir, compactEntries),
  persist: [
    { uuid: 'compact-u1', uText: 'pre-compact-u' },
    { uuid: 'compact-u2', uText: 'post-compact-u' },
  ],
}]);

// DB 插入顺序打乱，source_timestamp 与 T 逆序且含同值，anchor uuid 升序也与 T 逆序：
// 三个可能的替代键各指向一个不同的顺序，页顺序只能来自运行时 T
const [timestampOrderSession] = seedLineage([{
  sessionId: 'sess-tsorder',
  turns: [
    { uuid: 'tso-z1', uText: 't-first-u', sourceTimestamp: 3000 },
    { uuid: 'tso-m1', uText: 't-middle-u', sourceTimestamp: 3000 },
    { uuid: 'tso-a1', uText: 't-last-u', sourceTimestamp: 1000 },
  ],
  persist: [],
}]);
store.upsertTurnNotes([noteRow('sess-tsorder', { uuid: 'tso-m1', uText: 't-middle-u', sourceTimestamp: 3000 })]);
store.upsertTurnNotes([noteRow('sess-tsorder', { uuid: 'tso-a1', uText: 't-last-u', sourceTimestamp: 1000 })]);
store.upsertTurnNotes([noteRow('sess-tsorder', { uuid: 'tso-z1', uText: 't-first-u', sourceTimestamp: 3000 })]);

// 活读：transcript 有两个 active 头 U，起初只持久化第一条
const liveReadRow1 = (o = {}) => noteRow('sess-live',
  { uuid: 'live-u1', uText: 'first-persisted-u', note: 'old-note', ...o });
const liveReadRow2 = (o = {}) => noteRow('sess-live',
  { uuid: 'live-u2', uText: 'later-persisted-u', note: 'later-note', ...o });
const [liveReadSession] = seedLineage([{
  sessionId: 'sess-live',
  turns: [
    { uuid: 'live-u1', uText: 'first-persisted-u' },
    { uuid: 'live-u2', uText: 'later-persisted-u' },
  ],
  persist: [{ uuid: 'live-u1', uText: 'first-persisted-u', note: 'old-note' }],
}]);

// 同一 parentUuid 下两条兄弟 U，后者（更深）为活跃分支
const branchedEntries = [
  userMessage({ uuid: 'branch-root', text: 'root-u', timestamp: ts(1) }),
  assistantObservation({ uuid: 'branch-a1', parentUuid: 'branch-root', messageId: 'branch-m1',
    timestamp: ts(2), blocks: [{ type: 'text', text: 'fork here' }] }),
  userMessage({ uuid: 'branch-lost', parentUuid: 'branch-a1', text: 'abandoned-u-text', timestamp: ts(3) }),
  userMessage({ uuid: 'branch-kept', parentUuid: 'branch-a1', text: 'kept-u-text', timestamp: ts(4) }),
  assistantObservation({ uuid: 'branch-a2', parentUuid: 'branch-kept', messageId: 'branch-m2',
    timestamp: ts(5), blocks: [{ type: 'text', text: 'kept answer' }] }),
];
const [branchedSession] = rawLineage([{
  sessionId: 'sess-branch', transcriptPath: writeTranscript(dir, branchedEntries),
  persist: [
    { uuid: 'branch-lost', uText: 'abandoned-u-text', note: 'abandoned-note' },
    { uuid: 'branch-kept', uText: 'kept-u-text', note: 'kept-note' },
  ],
}]);

// 转录可读但一条 fold 都没有（整个文件都是 meta 噪声）：ordinals 是空 map，不是「非空 map 里缺 anchor」
const [foldlessSession] = rawLineage([{
  sessionId: 'sess-foldless',
  transcriptPath: writeTranscript(dir, [
    userMessage({ uuid: 'foldless-meta-0', text: 'meta', timestamp: ts(0), extra: { isMeta: true } }),
  ]),
  persist: [{ uuid: 'foldless-u1', uText: 'foldless-u-text', note: 'foldless-note' }],
}]);

// 未定位记录的顺序：anchor uuid 升序与 DB 插入顺序、source_timestamp 顺序三者互不相同
const [unverifiedOrderSession] = rawLineage([{
  sessionId: 'sess-unverified-order', transcriptPath: '/missing.jsonl',
  persist: [
    { uuid: 'm-anchor', uText: 'unordered-mu', sourceTimestamp: 2000 },
    { uuid: 'z-anchor', uText: 'unordered-zeta', sourceTimestamp: 1000 },
    { uuid: 'a-anchor', uText: 'unordered-alpha', sourceTimestamp: 3000 },
  ],
}]);

// 页首 t:null 场景。不可读会话必须自己溢出预算 —— 否则「无更旧记录」会让 nextBefore 空洞地为 null，
// 断言就不再证明「t:null 页首省略 nextBefore」这条规则。
const [unreadableOlder, readableNewer] = rawLineage([
  {
    sessionId: 'sess-unread', transcriptPath: '/missing.jsonl',
    persist: Array.from({ length: 12 }, (_, i) => ({
      uuid: `unread-u${i + 1}`, uText: `unread-turn-${i + 1}`,
      note: `${'d'.repeat(1500)}-${i + 1}`, sourceTimestamp: 1000 + i,
    })),
  },
  {
    sessionId: 'sess-newer',
    transcriptPath: transcriptOf('sess-newer', [{ uuid: 'newer-u1', uText: 'newer-turn' }]),
    persist: [{ uuid: 'newer-u1', uText: 'newer-turn', note: 'newer note' }],
  },
]);

// ── Tests ──────────────────────────────────────────────────────────────────────

test('页文本形状：notice + 空行 + session 头 + turn 行 + A 续行', () => {
  const { turnPage } = buildTurnPage({ store, lineage });
  const lines = turnPage.split('\n');
  assert.equal(lines[0], TURN_NOTICE);
  assert.equal(lines[1], '');
  assert.equal(lines[2], `S1  ${lineage[0].transcriptPath}`);
  assert.match(turnPage, /^S1:13 \| U: /m);
  assert.match(turnPage, /^ {6}\| A: /m);
});

test('页头行给出转录文件，且不再给出 session id', () => {
  const { turnPage } = buildTurnPage({ store, lineage });
  assert.match(turnPage, /^S1 {2}\//m);
  // 行下每个 T 都是这个文件的物理行号，而 session id 在文件名里 —— 头行没有第二个地址要给
  assert.equal(turnPage.includes('session sess-A'), false);
});

test('t:null 行以 `| U: ` 开头且无前导填充', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [{ label: 'S1', sessionId: 'sess-A', transcriptPath: '/missing.jsonl' }] });
  assert.match(turnPage, /^\| U: /m);
  assert.ok(!/^S1:/m.test(turnPage));
});

test('空历史精确返回 turnPage:"" 且无 nextBefore', () => {
  assert.deepEqual(buildTurnPage({ store, lineage: [] }), { turnPage: '', nextBefore: null });
});

test('单条 turn 就超预算 ⇒ 与空历史同形（n 无硬下界）', () => {
  const { turnPage, nextBefore } = buildTurnPage({ store, lineage: [hugeSingleTurnSession] });
  assert.equal(turnPage, '');
  assert.equal(nextBefore, null);
});

test('U 截断后缀由 u_original_chars > u_text.length 派生，形状与既有标记一致', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [truncatedUSession] });
  assert.match(turnPage, / \[truncated; \d+ chars\]$/m);
  assert.match(turnPage, /^ {5}\| U: u-cut-second \[truncated; 999 chars\]$/m);   // 只在最后一个 U 物理行
  assert.equal((turnPage.match(/\[truncated;/g) || []).length, 1);
});

test('| A: 续行填充按行宽计算（短地址与长地址各自定尺）', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [wideOrdinalSession] });
  assert.match(turnPage, /^ {6}\| A: /m);
  assert.match(turnPage, /^ {8}\| A: /m);
});

test('多行 U/note 的每个物理行都保留角色前缀，且 renderer 统一换行符', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [multilineSession] });
  assert.ok(turnPage.includes([
    'S1:13 | U: u-first',
    '      | U: u-second',
    '      | U: ',
    '      | U: u-fourth',
    '      | A: a-first',
    '      | A: a-second',
  ].join('\n')));
  assert.ok(!turnPage.includes('\r'));
});

test('预算：按实际完整 wire 实算，不超 BOOKMARK_TOKEN_BUDGET', () => {
  const { turnPage } = buildTurnPage({ store, lineage: bigLineage });
  assert.ok(Math.round(charsToTokens(JSON.stringify({ turn_page: turnPage }), DEFAULT_CTP)) <= BOOKMARK_TOKEN_BUDGET);
  assert.ok(turnPage.includes('sess-big-3-turn-6'));      // 装到了最新一条
  assert.ok(!turnPage.includes('sess-big-1-turn-1'));     // 也确实被预算截住
});


test('懒解析：预算装满后更老会话的 transcript 不被打开', () => {
  const opened = [];
  const counting = (p, opts) => { opened.push(p); return readCanonicalTranscript(p, opts); };
  buildTurnPage({ store, lineage: threeSessionLineage, readTranscript: counting });
  // threeSessionLineage[2] 是最新会话，它的 turn 已能装满 5000 预算
  assert.deepEqual(opened, [threeSessionLineage[2].transcriptPath]);
});

test('before 取回上一页，且是同一操作（不返回目标 turn detail）', () => {
  const first = buildTurnPage({ store, lineage });
  assert.match(first.nextBefore, /^S1:\d+$/);
  const older = buildTurnPage({ store, lineage, before: first.nextBefore });
  assert.ok(!older.turnPage.includes(firstTurnUText));
  assert.ok(older.turnPage.startsWith(TURN_NOTICE));   // 仍是整页形状
});

test('before 跨 session 严格切窗：同 session 只留 t<T，保留更老 session，整条排除更新 session', () => {
  const { turnPage } = buildTurnPage({ store, lineage: crossSessionLineage, before: 'S2:21' });
  assert.ok(turnPage.includes(s2Turn10Text));
  assert.ok(turnPage.includes(s1OlderText));
  assert.ok(!turnPage.includes(s2Turn20Text));
  assert.ok(!turnPage.includes(s2Turn30Text));
  assert.ok(!turnPage.includes(s3NewerText));                    // label 更大的会话一条都不进页
  assert.ok(!turnPage.includes(
    crossSessionLineage.find(e => e.sessionId === 'sess-cross-3').transcriptPath));  // 连 session 头也不出现
});

test('before 只认精确 label + 精确 T，其余一律 not_found', () => {
  for (const before of ['nonsense', 'S2:22', 'S9:21', 'S01:21', 's2:21', 'S2:21 ', '', 21]) {
    assert.throws(() => buildTurnPage({ store, lineage: crossSessionLineage, before }),
      /not_found/, String(before));
  }
});

test('before 指向不可读会话或废弃 anchor 时 not_found，不退化成整页', () => {
  const unreadable = [{ label: 'S1', sessionId: 'sess-A', transcriptPath: '/missing.jsonl' }];
  assert.throws(() => buildTurnPage({ store, lineage: unreadable, before: 'S1:1' }), /not_found/);
  assert.throws(() => buildTurnPage({ store, lineage: [branchedSession], before: 'S1:3' }), /not_found/);
});

test('消费默认模式把 compact 前后记录留在同一个 S，T 不按 epoch 重置', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [compactSession] });
  assert.equal((turnPage.match(/^S1 {2}\//gm) || []).length, 1);
  assert.match(turnPage, /^S1:1 \| U: pre-compact-u$/m);
  assert.match(turnPage, /^S1:4 \| U: post-compact-u$/m);
});

test('page 顺序只认运行时 T，不认 DB 插入顺序或 source_timestamp', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [timestampOrderSession] });
  const positions = ['t-first-u', 't-middle-u', 't-last-u'].map(text => turnPage.indexOf(text));
  assert.ok(positions.every(i => i >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
});

test('同一 lineage contract 内容活读：后续覆盖 note 与新增 active Turn Record 立即可见', () => {
  const first = buildTurnPage({ store, lineage: [liveReadSession] }).turnPage;
  assert.ok(first.includes('old-note'));
  assert.ok(!first.includes('later-persisted-u'));
  store.upsertTurnNotes([
    liveReadRow1({ note: 'updated-note' }),
    liveReadRow2({ uText: 'later-persisted-u', note: 'later-note' }),
  ]);
  const after = buildTurnPage({ store, lineage: [liveReadSession] }).turnPage;
  assert.ok(!after.includes('old-note'));
  assert.ok(after.includes('updated-note'));
  assert.ok(after.includes('later-persisted-u'));
});

test('废弃分支的 turn_note 行不进页，且不得伪装成 t:null', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [branchedSession] });
  assert.ok(turnPage.includes('kept-u-text'));
  assert.ok(!turnPage.includes('abandoned-u-text'));
  assert.ok(!/^\| U: /m.test(turnPage));               // 转录可读 ⇒ 不存在无地址行
});

test('转录可读但无 fold（空 ordinals）⇒ 未定位而非废弃：记录保留', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [foldlessSession] });
  assert.match(turnPage, /^\| U: /m);
  assert.ok(turnPage.includes('foldless-u-text'));
  assert.ok(turnPage.includes('foldless-note'));
});

test('未定位记录按 anchor uuid 升序，不取 DB 插入顺序，也不取 source_timestamp', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [unverifiedOrderSession] });
  const positions = ['unordered-alpha', 'unordered-mu', 'unordered-zeta'].map(t => turnPage.indexOf(t));
  assert.ok(positions.every(i => i >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
});

test('转录缺失时整会话为 t:null，仍展示 u_text + note', () => {
  const { turnPage } = buildTurnPage({ store, lineage: [{ label: 'S1', sessionId: 'sess-A', transcriptPath: '/missing.jsonl' }] });
  assert.match(turnPage, /^\| U: /m);
  assert.match(turnPage, /^\| A: /m);
});

test('页首为 t:null 时省略 nextBefore', () => {
  const { nextBefore } = buildTurnPage({ store, lineage: [unreadableOlder, readableNewer], before: 'S2:1' });
  assert.equal(nextBefore, null);
});
