// test/turn-query.test.js — the two history query operations: Exact Transcript Search (canonical
// entity surface, ASCII folding, excerpt construction, fold-anchor dedup, budget truncation,
// scope resolution, and each hit's containing-turn record) and History Range Location (FTS candidates
// re-verified against the active path, then widened into one chronological list of hits and the turns
// adjacent to each).
// 所有 fixture 都是合成转录；物理行号才是 T，所以头 U 用 meta 填充推到指定绝对行。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CTP_TABLE, DEFAULT_CTP, NOTE_PREVIEW_TOKENS, NOTE_TOKEN_LIMIT } from '../lib/constants.js';
import { BOOKMARK_PREVIEW_CHARS, BOOKMARK_TOKEN_BUDGET, estimateWireTokens, isWithinBookmarkBudget }
  from '../lib/bookmark-core.js';
import { classifyToolPair, serializeResult, stableStringify } from '../lib/bookmark-detail.js';
import { enumerateLines, findFoldByAnchor, foldLines, readCanonicalTranscript } from '../lib/dialogue-fold.js';
import { charsToTokens } from '../lib/measure.js';
import { openStore, closeStore } from '../lib/store.js';
import { activePathOrdinals, buildSearchTerms, groupTurns, storedUText, U_TEXT_TOKENS } from '../lib/turn.js';
import { locateRanges, searchTranscripts as searchTranscriptsImpl } from '../lib/turn-query.js';
import {
  assistantObservation, assistantToolUse, toolResult, ts, userMessage, writeTranscript,
} from './helpers/transcript-fixtures.js';

const dir = mkdtempSync(join(tmpdir(), 'sw-turn-query-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// 每组读库的 fixture 自带一个 DB —— locate 的理由见下方 fixture 段。
const testStore = (name) => {
  const store = openStore(join(dir, `${name}.sqlite`));
  after(() => closeStore(store));
  return store;
};

// search 的默认库是一个真库，里面一条 turn_note 都没有：除 enrichment 组外，每条 search 断言都跑在
// 「会话早于 turn_note 存在」这一侧，命中因此是裸形。
const storeEmpty = testStore('search-empty');
const searchTranscripts = args => searchTranscriptsImpl({ store: storeEmpty, ...args });

// 命中现在挂在 turn 分组里。断言匹配语义的用例只关心「哪些 fold 命中了、按什么顺序」，所以走这个拉平
// 视图；分组本身由分组段的用例负责。
const allMatches = (r) => (r.ranges ?? []).flatMap(g => g.matches);

// ── Fixtures ───────────────────────────────────────────────────────────────────

// 每个 fixture 都是一条严格线性链：写入前统一改写 parentUuid，避免逐条手写父边写错分支。
const linear = (entries) => {
  entries.forEach((entry, i) => { entry.parentUuid = i === 0 ? null : entries[i - 1].uuid; });
  return entries;
};

// meta 行被 isSystemNoise 丢弃却照样占一个行号 —— 这是把头 U 推到转录中段与末段的唯一手段。
const meta = (tag, i) => userMessage({ uuid: `${tag}-meta-${i}`, text: 'meta', timestamp: ts(0), extra: { isMeta: true } });
const padTo = (entries, ordinal, tag) => {
  while (entries.length < ordinal) entries.push(meta(tag, entries.length));
  return entries;
};

// Path 桶要成立，Read 的 result 必须真能产出有效 fullSet：真行号前缀 `N\t`、总长 > 100、
// 尾部没有 truncated / use offset / too large 标记。少一条就会按 ineffective_update 落回 Residual，
// 「Path 桶搜不到」就会因为错误的理由通过。
const READ_RESULT = [
  '1\tconst first = 1;   // read-bucket-literal marker line',
  '2\tconst second = 2;  // padding so the whole result is a full read',
  '3\tconst third = 3;   // padding so the whole result is a full read',
  '4\texport { first, second, third };',
].join('\n');

const LONG_Q = 'q'.repeat(200);
// 'İ' 是 1 个码元，但 'İ'.toLowerCase() 是 2 个 —— 命中偏移会整体后移一位。Z 段长度恰好等于 q，
// 所以偏移错一位就会把最后一个 Z 挤出 excerpt，断言真的会红。
const Z_RUN = 'Z'.repeat(200);
const HUGE_RESULT = `${'x'.repeat(9000)}mid-literal${'y'.repeat(9000)}`;

const sessionAEntries = () => {
  const entries = [
    userMessage({ uuid: 'u-open', text: 'kickoff needle-literal instruction', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a-open', messageId: 'm-open', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'acknowledged, starting now' }] }),
    // ABSORB：整个 fold 退出匹配面（tag 名本身就含被搜的字面量）
    userMessage({ uuid: 'u-absorb', timestamp: ts(3),
      text: '<local-command-stdout>local-command-stdout captured output</local-command-stdout>' }),
    assistantToolUse({ uuid: 'a-read', messageId: 'm-read', toolUseId: 'tu-read',
      name: 'Read', input: { file_path: '/synthetic/read-target.js' }, timestamp: ts(4) }),
    toolResult({ uuid: 'r-read', toolUseId: 'tu-read', content: READ_RESULT }),
    assistantToolUse({ uuid: 'a-bash', messageId: 'm-bash', toolUseId: 'tu-bash',
      name: 'Bash', input: { command: 'echo residual-bucket-literal' }, timestamp: ts(5) }),
    toolResult({ uuid: 'r-bash', toolUseId: 'tu-bash', content: 'residual bucket output' }),
    assistantToolUse({ uuid: 'a-dup', messageId: 'm-dup', toolUseId: 'tu-dup',
      name: 'Bash', input: { command: 'echo dup-literal from tool' }, timestamp: ts(6),
      text: 'visible-body dup-literal in prose' }),
    toolResult({ uuid: 'r-dup', toolUseId: 'tu-dup', content: 'dup tool output' }),
    assistantToolUse({ uuid: 'tool-fold-uuid', messageId: 'm-tool-only', toolUseId: 'tu-tool-only',
      name: 'Bash', input: { command: 'echo tool-only-literal' }, timestamp: ts(7) }),
    toolResult({ uuid: 'r-tool-only', toolUseId: 'tu-tool-only', content: 'tool only output' }),
    assistantObservation({ uuid: 'a-needle2', messageId: 'm-needle2', timestamp: ts(8),
      blocks: [{ type: 'text', text: 'a second needle-literal mention' }] }),
  ];
  // scope 测试的头 U，垫到中段。清洗投影是 '/model opus'，原文里没有这个连写。
  padTo(entries, 12, 'sess-a');
  entries.push(
    userMessage({ uuid: 'u-model', timestamp: ts(9),
      text: '<command-name>/model</command-name><command-args>opus</command-args>' }),
    assistantObservation({ uuid: 'a1', messageId: 'm-a1', timestamp: ts(10),
      blocks: [{ type: 'text', text: 'answering here with visible-literal evidence' }] }),
    assistantObservation({ uuid: 'a-span', messageId: 'm-span', timestamp: ts(11),
      blocks: [{ type: 'text', text: 'further reasoning span-only-literal in the same span' }] }),
    assistantObservation({ uuid: 'a-istanbul', messageId: 'm-istanbul', timestamp: ts(12),
      blocks: [{ type: 'text', text: 'İstanbul CONFIG_KEY 设定' }] }),
    assistantObservation({ uuid: 'a-longq', messageId: 'm-longq', timestamp: ts(13),
      blocks: [{ type: 'text', text: `left-context-${LONG_Q}-right-context` }] }),
    assistantObservation({ uuid: 'a-zfold', messageId: 'm-zfold', timestamp: ts(14),
      blocks: [{ type: 'text', text: `İ${Z_RUN}-tail-marker` }] }),
    assistantToolUse({ uuid: 'a-mid', messageId: 'm-mid', toolUseId: 'tu-mid',
      name: 'Bash', input: { command: 'echo mid-run' }, timestamp: ts(15) }),
    toolResult({ uuid: 'r-mid', toolUseId: 'tu-mid', content: HUGE_RESULT }),
    // 同一条 message 的文本块与 tool_use 块各占一行：fold 锚在文本行，工具名/input 在下一行。
    assistantObservation({ uuid: 'a-split', messageId: 'm-split', timestamp: ts(16),
      blocks: [{ type: 'text', text: 'split-prose-literal before the call' }] }),
    assistantToolUse({ uuid: 'a-split-tool', messageId: 'm-split', toolUseId: 'tu-split',
      name: 'Bash', input: { command: 'echo split-input-literal' }, timestamp: ts(16) }),
    toolResult({ uuid: 'r-split', toolUseId: 'tu-split', content: 'split-output-literal' }),
  );
  // 同 session 的下一个 turn，垫到末段：两个 scope 字面量都不在它的 span 里。
  padTo(entries, 31, 'sess-a');
  entries.push(
    userMessage({ uuid: 'u-tail', text: 'third turn with unrelated wording', timestamp: ts(16) }),
    assistantObservation({ uuid: 'a-tail', messageId: 'm-tail', timestamp: ts(17),
      blocks: [{ type: 'text', text: 'nothing of interest here' }] }),
  );
  return linear(entries);
};

const transcriptA = writeTranscript(dir, sessionAEntries());
const lineage = [{ label: 'S1', sessionId: 'sess-search-a', transcriptPath: transcriptA, handoffId: 901 }];

// 两会话：更新的会话单独就能溢出 5000 预算（80 条命中，每条 excerpt 满 200 字符）。
const FREQUENT_COUNT = 80;
const transcriptOld = writeTranscript(dir, linear([
  userMessage({ uuid: 'u-old-open', text: 'older session opening with rare-literal wording', timestamp: ts(1) }),
  assistantObservation({ uuid: 'a-old', messageId: 'm-old', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'older answer carrying cross-session-literal' }] }),
]));
const transcriptNew = writeTranscript(dir, linear([
  ...Array.from({ length: FREQUENT_COUNT }, (_, i) => userMessage({
    uuid: `u-freq-${i}`, text: `frequent-hit-${i}-${'p'.repeat(250)}`, timestamp: ts(1),
  })),
  assistantObservation({ uuid: 'a-new', messageId: 'm-new', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'newer answer carrying cross-session-literal' }] }),
]));
const twoSessionLineage = [
  { label: 'S1', sessionId: 'sess-old', transcriptPath: transcriptOld, handoffId: 902 },
  { label: 'S2', sessionId: 'sess-new', transcriptPath: transcriptNew, handoffId: 903 },
];

// 边缘会话：两个 fold 共用一个 anchor（materializeDialogue 只告警不丢弃）、一个无 tool_result 的
// tool_use、以及一条命中窗口正好切在代理对中间的正文。父边逐条手写 —— 双胞胎共用 uuid，
// 线性改写会让第二条以自己为父。
const SURROGATE_BODY = `${'f'.repeat(100)}😀${'p'.repeat(92)}surrogate-hit${'z'.repeat(200)}`;
const transcriptEdge = writeTranscript(dir, [
  userMessage({ uuid: 'u-edge-open', parentUuid: null, text: 'edge session opening', timestamp: ts(1) }),
  assistantObservation({ uuid: 'a-twin', parentUuid: 'u-edge-open', messageId: 'm-twin-1', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'first twin body twin-literal older' }] }),
  assistantObservation({ uuid: 'a-twin', parentUuid: 'u-edge-open', messageId: 'm-twin-2', timestamp: ts(3),
    blocks: [{ type: 'text', text: 'second twin body twin-literal newer' }] }),
  assistantToolUse({ uuid: 'a-unpaired', parentUuid: 'a-twin', messageId: 'm-unpaired', toolUseId: 'tu-unpaired',
    name: 'Bash', input: { command: 'echo unpaired-input-literal' }, timestamp: ts(4) }),
  assistantObservation({ uuid: 'a-surrogate', parentUuid: 'a-unpaired', messageId: 'm-surrogate', timestamp: ts(5),
    blocks: [{ type: 'text', text: SURROGATE_BODY }] }),
]);
const edgeLineage = [{ label: 'S1', sessionId: 'sess-edge', transcriptPath: transcriptEdge, handoffId: 904 }];

const foldsByAnchor = (path, uuid) =>
  readCanonicalTranscript(path).folds.filter(f => (f.message?.anchorUuid ?? f.sourceRef.uuid) === uuid);
const foldByAnchor = (path, uuid) => foldsByAnchor(path, uuid)[0];
const lineOfFold = (path, uuid) => foldByAnchor(path, uuid).sourceRef.lineOrdinal;

// ── Fixture self-proofs ────────────────────────────────────────────────────────

test('fixture 自证：三个头 U 落在 grep -n 给它们的那三行', () => {
  const turns = groupTurns(enumerateLines(readCanonicalTranscript(transcriptA)));
  assert.deepEqual(turns.map(t => t.t), [1, 13, 32]);
});

test('fixture 自证：Read 对真落在 Path 桶，Bash 对落在 Residual 桶', () => {
  assert.equal(classifyToolPair(foldByAnchor(transcriptA, 'a-read').toolPairs[0], DEFAULT_CTP), 'path');
  assert.equal(classifyToolPair(foldByAnchor(transcriptA, 'a-bash').toolPairs[0], DEFAULT_CTP), 'residual');
});

test('桶与 ctp 无关：Read 对在 CTP_TABLE 每一档与缺省档都是 Path', () => {
  // search 固定 DEFAULT_CTP，bookmark detail 用 ctpForModel(canonical.model)。两处若能对同一对给出
  // 不同桶，一条命中就会「search 找得到、detail 取不到」—— 这条不变量代码里没有别处声明。
  const pair = foldByAnchor(transcriptA, 'a-read').toolPairs[0];
  for (const ctp of [...Object.values(CTP_TABLE), DEFAULT_CTP]) {
    assert.equal(classifyToolPair(pair, ctp), 'path', JSON.stringify(ctp));
  }
});

// ── Matcher semantics ──────────────────────────────────────────────────────────

test('ASCII 折叠逐码元只映射 A–Z；非 ASCII 不经 toLowerCase 变长', () => {
  const r = searchTranscripts({ lineage, q: 'config_key' });
  assert.equal(r.found, true);
  assert.ok(allMatches(r)[0].excerpt.includes('CONFIG_KEY'));
  assert.equal(searchTranscripts({ lineage, q: 'i̇stanbul' }).found, false);
});

test('命中偏移不因 İ 变长而错位：紧跟其后的 200 字符 span 完整落在 excerpt 里', () => {
  const r = searchTranscripts({ lineage, q: 'z'.repeat(200) });
  assert.equal(r.found, true);
  assert.equal(allMatches(r)[0].excerpt.replace(/^…|…$/g, ''), Z_RUN);
});

test('found:true 的 excerpt 完整包含来源命中 span', () => {
  const r = searchTranscripts({ lineage, q: 'needle-literal' });
  assert.equal(r.found, true);
  assert.equal(allMatches(r).length, 2);
  assert.ok(allMatches(r).every(m => m.excerpt.includes('needle-literal')));
});

test('200 字符 q 仍完整落在 excerpt 中，不被「居中」算法切半', () => {
  const r = searchTranscripts({ lineage, q: LONG_Q });
  assert.equal(r.found, true);
  assert.ok(allMatches(r)[0].excerpt.includes(LONG_Q));
  assert.equal(allMatches(r)[0].excerpt.replace(/^…|…$/g, '').length, BOOKMARK_PREVIEW_CHARS);
});

test('同一 (session, anchor) 只返回一次，excerpt 取 canonical 首命中', () => {
  const r = searchTranscripts({ lineage, q: 'dup-literal' });
  assert.equal(allMatches(r).length, 1);
  assert.ok(allMatches(r)[0].excerpt.includes('visible-body dup-literal'));
});

test('工具实体命中的 line 是工具行，可见消息命中的 line 是消息行', () => {
  assert.equal(allMatches(searchTranscripts({ lineage, q: 'tool-only-literal' }))[0].line,
    lineOfFold(transcriptA, 'tool-fold-uuid'));
  assert.equal(allMatches(searchTranscripts({ lineage, q: 'visible-literal' }))[0].line,
    lineOfFold(transcriptA, 'a1'));
});

test('ABSORB harness evidence 不参与匹配', () => {
  assert.equal(searchTranscripts({ lineage, q: 'local-command-stdout' }).found, false);
});

test('Path 桶工具一个实体都不产出（连工具名也不进），Residual 桶搜得到', () => {
  assert.equal(searchTranscripts({ lineage, q: 'read-bucket-literal' }).found, false);
  assert.equal(searchTranscripts({ lineage, q: 'Read' }).found, false);
  assert.equal(searchTranscripts({ lineage, q: 'residual-bucket-literal' }).found, true);
  // Residual 工具名逐字可搜，且 ASCII 大小写不敏感
  assert.equal(searchTranscripts({ lineage, q: 'bash' }).found, true);
});

test('两个 fold 共用同一 anchor 时只返回一次（扫描按 anchor 去重）', () => {
  const r = searchTranscripts({ lineage: edgeLineage, q: 'twin-literal' });
  assert.equal(allMatches(r).length, 1);
  // 扫描新→旧，最新那个 fold 供 line 与 excerpt
  assert.equal(allMatches(r)[0].line, foldsByAnchor(transcriptEdge, 'a-twin').at(-1).sourceRef.lineOrdinal);
  assert.ok(allMatches(r)[0].excerpt.includes('second twin body'));
});

test('resultStr === null 不产出 result 实体，同一对的 input 仍可搜', () => {
  const r = searchTranscripts({ lineage: edgeLineage, q: 'unpaired-input-literal' });
  assert.equal(r.found, true);
  assert.equal(allMatches(r)[0].line, lineOfFold(transcriptEdge, 'a-unpaired'));
  // 整个 edge 会话的原文里没有 'null'：命中只可能来自把空结果字符串化后塞进实体
  assert.deepEqual(searchTranscripts({ lineage: edgeLineage, q: 'null' }), { found: false });
});

test('excerpt 边界不切开代理对，也不因此丢掉命中', () => {
  const matches = allMatches(searchTranscripts({ lineage: edgeLineage, q: 'surrogate-hit' }));
  assert.ok(matches[0].excerpt.includes('surrogate-hit'));
  assert.ok(!matches[0].excerpt.includes('\uDE00'), '不得留下半个代理对');
  assert.equal(matches[0].excerpt.replaceAll('…', '').length, BOOKMARK_PREVIEW_CHARS - 1);
});

test('工具实体的待搜文本复用 detail 的序列化，不另造 raw JSONL 表示', () => {
  const r = searchTranscripts({ lineage, q: '"command":"echo residual-bucket-literal"' });
  assert.equal(r.found, true);
  assert.equal(allMatches(r)[0].line, lineOfFold(transcriptA, 'a-bash'));
});

test('search 的扫描面与行枚举同源：同一 fold 的每条行都在匹配面上', () => {
  const fold = foldByAnchor(transcriptA, 'a-split');
  const lines = foldLines(fold);
  // 行枚举对这个 fold 的产出写死在这里：少一条工具行或换一种载荷，下面的字面量就不再可搜。
  assert.deepEqual(lines.map(l => l.kind), ['visible', 'tool']);
  const needles = lines.flatMap(line => line.kind === 'visible'
    ? [line.message.text]
    : [line.tool.name, stableStringify(line.tool.input), serializeResult(line.tool.result).resultStr]);
  // 一条可见行一个实体，一条 Residual 工具行三个（名、序列化 input、序列化 result）。
  assert.deepEqual(needles, [
    'split-prose-literal before the call',
    'Bash', '{"command":"echo split-input-literal"}', 'split-output-literal',
  ]);
  // 文本块、tool_use 块、result 各在自己的物理行上 —— 命中行随实体来源不同，都不是 fold 锚行的别名
  const [, tool] = lines;
  assert.notEqual(tool.tool.useLineOrdinal, tool.t);
  assert.notEqual(tool.tool.resultLineOrdinal, tool.tool.useLineOrdinal);
  const rows = lines.flatMap(line => line.kind === 'visible'
    ? [line.t]
    : [line.tool.useLineOrdinal, line.tool.useLineOrdinal, line.tool.resultLineOrdinal]);
  needles.forEach((needle, i) => {
    const r = searchTranscripts({ lineage, q: needle });
    assert.ok(r.found && allMatches(r).some(m => m.line === rows[i]), needle);
  });
});


test('head U 的匹配面是 fold 原文，不是清洗结果', () => {
  assert.equal(searchTranscripts({ lineage, q: '/model opus' }).found, false);
  assert.equal(searchTranscripts({ lineage, q: '/model' }).found, true);
});

test('超长实体中段可命中（不先套 detail 的 10k cap）', () => {
  const r = searchTranscripts({ lineage, q: 'mid-literal' });
  assert.equal(r.found, true);
  assert.ok(allMatches(r)[0].excerpt.includes('mid-literal'));
  assert.ok(allMatches(r)[0].excerpt.startsWith('…') && allMatches(r)[0].excerpt.endsWith('…'));
  assert.equal(allMatches(r)[0].excerpt.replaceAll('…', '').length, BOOKMARK_PREVIEW_CHARS);
});

// ── Budget / ordering ──────────────────────────────────────────────────────────

test('预算内只装完整命中；首个装不下的更旧命中 ⇒ truncated:true 并停止读取更老会话', () => {
  const opened = [];
  const counting = (p, opts) => { opened.push(p); return readCanonicalTranscript(p, opts); };
  const r = searchTranscripts({ lineage: twoSessionLineage, q: 'frequent', readTranscript: counting });
  assert.equal(r.truncated, true);
  assert.ok(allMatches(r).length > 0 && allMatches(r).length < FREQUENT_COUNT);
  assert.deepEqual(opened, [twoSessionLineage[1].transcriptPath]);
  assert.ok(allMatches(r).every(m => m.excerpt.replaceAll('…', '').length <= BOOKMARK_PREVIEW_CHARS));
});

test('稀有词扫到 lineage 尽头且 truncated:false；零命中精确为 {found:false}', () => {
  const rare = searchTranscripts({ lineage: twoSessionLineage, q: 'rare-literal' });
  assert.equal(rare.found, true);
  assert.equal(rare.truncated, false);
  assert.deepEqual(searchTranscripts({ lineage: twoSessionLineage, q: 'nowhere' }), { found: false });
});

test('保留集按 canonical 旧→新输出', () => {
  const r = searchTranscripts({ lineage: twoSessionLineage, q: 'cross-session-literal' });
  assert.deepEqual(r.ranges.map(g => g.transcript_path), [transcriptOld, transcriptNew]);
  assert.deepEqual(Object.keys(allMatches(r)[0]).sort(), ['excerpt', 'line', 'span'],
    '路径提到了 turn 级 —— match 只剩行地址与证据');
});

test('不可读会话在无 scope 搜索里被静默跳过，不影响其余命中', () => {
  const withMissing = [
    { label: 'S1', sessionId: 'sess-missing', transcriptPath: join(dir, 'no-such-file.jsonl') },
    { label: 'S2', sessionId: 'sess-search-a', transcriptPath: transcriptA },
  ];
  const r = searchTranscripts({ lineage: withMissing, q: 'visible-literal' });
  assert.equal(r.found, true);
  assert.deepEqual(r.ranges.map(g => g.transcript_path), [transcriptA]);
});

// ── Scope ──────────────────────────────────────────────────────────────────────

test('合法 scope 内零命中仍是 found:false；scope 只改变扫描范围', () => {
  assert.deepEqual(searchTranscripts({ lineage, q: 'visible-literal', scope: 'S1:32' }), { found: false });
  assert.equal(searchTranscripts({ lineage, q: 'visible-literal', scope: 'S1:13' }).found, true);
});

test('scope 覆盖整个 turn span，而不是整个 session 或仅头 U', () => {
  assert.equal(searchTranscripts({ lineage, q: 'span-only-literal', scope: 'S1:13' }).found, true);
  assert.deepEqual(searchTranscripts({ lineage, q: 'span-only-literal', scope: 'S1:32' }), { found: false });
  // 头 U 自己的原文也在 span 内
  assert.equal(searchTranscripts({ lineage, q: '/model', scope: 'S1:13' }).found, true);
  // 别的 turn 的正文不进这个 span
  assert.deepEqual(searchTranscripts({ lineage, q: 'needle-literal', scope: 'S1:13' }), { found: false });
});

test('label / T 不存在、转录不可读、非头 U 的 T 一律 scope_not_found', () => {
  const cases = ['S9:13', 'S1:14', 'S1:99999', 'nonsense', ''];
  for (const scope of cases) {
    assert.throws(() => searchTranscripts({ lineage, q: 'visible-literal', scope }),
      /scope_not_found/, scope);
  }
  const unreadable = [{ label: 'S1', sessionId: 'sess-gone', transcriptPath: join(dir, 'gone.jsonl') }];
  assert.throws(() => searchTranscripts({ lineage: unreadable, q: 'x', scope: 'S1:1' }), /scope_not_found/);
});

// ── Locate fixtures ────────────────────────────────────────────────────────────
// locate 读库，所以每组 fixture 自带一个 DB：bm25 的 IDF 是索引全局的，顺序断言只在自建库上稳定。
// 头 U 所在的物理行号才是 T，所以 pad 行把每个锚推到指定行；分叉会话的父边逐条手写。

const LOCATE_CWD = '/synthetic/project';

const lastUuid = (entries) => (entries.length ? entries[entries.length - 1].uuid : null);

// 在 ordinal 条 pad 行之后放一条头 U。单链会话专用：linear 把已有行接成一条链，新行接在末尾。
const headUAt = (entries, tag, ordinal, uuid, text) => {
  linear(padTo(entries, ordinal, tag));
  entries.push(userMessage({ uuid, parentUuid: lastUuid(entries), text, timestamp: ts(1) }));
  return entries;
};

const noteRow = (sessionId, o) => ({
  sourceSessionId: sessionId, anchorUuid: o.uuid, uText: o.uText,
  uOriginalChars: o.uOriginalChars ?? o.uText.length, note: o.note ?? null,
  searchTerms: o.searchTerms ?? '', sourceTimestamp: o.sourceTimestamp ?? 1000,
});

const storeMain = testStore('locate-main');

// S1：分叉会话。被放弃的兄弟 U 与活跃的那条相邻（同 parent 下最后写入的孩子胜出）。
const mainEntries = linear(padTo([], 10, 'loc-main'));
mainEntries.push(
  userMessage({ uuid: 'loc-fork-root', parentUuid: lastUuid(mainEntries), text: 'fork root instruction', timestamp: ts(1) }),
  assistantObservation({ uuid: 'loc-fork-a', parentUuid: 'loc-fork-root', messageId: 'm-loc-fork', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'forking here' }] }),
  userMessage({ uuid: 'loc-lost', parentUuid: 'loc-fork-a', text: 'the abandoned instruction', timestamp: ts(3) }),
  userMessage({ uuid: 'loc-kept', parentUuid: 'loc-fork-a', text: 'the kept instruction', timestamp: ts(4) }),
  assistantObservation({ uuid: 'loc-kept-a', parentUuid: 'loc-kept', messageId: 'm-loc-kept', timestamp: ts(5),
    blocks: [{ type: 'text', text: 'answered on the kept branch' }] }),
);
const locateMainPath = writeTranscript(dir, mainEntries);

// S2：单链会话，锚按等距 pad 撑开落在稀疏行号上。头 U 存的是 C 截断前缀，转录里是全文。
const PREFIX_TAIL_U = `prefix-literal ${'中'.repeat(400)} tail-literal`;
const indexEntries = [];
headUAt(indexEntries, 'loc-index', 20, 'loc-shape-noted', 'projshape-word noted turn');
headUAt(indexEntries, 'loc-index', 30, 'loc-shape-bare', 'projshape-word bare turn');
headUAt(indexEntries, 'loc-index', 40, 'loc-path-row', 'index probe turn');
headUAt(indexEntries, 'loc-index', 50, 'loc-cjk-row', '连续中文可命中');
headUAt(indexEntries, 'loc-index', 60, 'loc-and-row', 'and probe turn');
headUAt(indexEntries, 'loc-index', 70, 'loc-prefix-row', PREFIX_TAIL_U);
const locateIndexPath = writeTranscript(dir, indexEntries);

const locateLineage = [
  { label: 'S1', sessionId: 'sess-loc-main', transcriptPath: locateMainPath, handoffId: 910 },
  { label: 'S2', sessionId: 'sess-loc-index', transcriptPath: locateIndexPath, handoffId: 911 },
  { label: 'S3', sessionId: 'sess-loc-gone', transcriptPath: join(dir, 'locate-gone.jsonl'), handoffId: 912 },
];
const unreadableOnlyLineage = [{ ...locateLineage[2], label: 'S1' }];

// 校验组：四条索引内容完全相同的行 ⇒ 同 rank，只能按 timestamp 新→旧排序。唯一有效的那条 timestamp
// 最旧、rank 最低 —— SQL 若带 LIMIT 3，它就会被三条无效候选挤掉，本组随之变红。
const SHARED_U = 'shared-note-word turn';
storeMain.upsertTurnNotes([
  noteRow('sess-loc-gone', { uuid: 'loc-gone-1', uText: SHARED_U, sourceTimestamp: 4000 }),
  noteRow('sess-loc-gone', { uuid: 'loc-gone-2', uText: SHARED_U, sourceTimestamp: 3500 }),
  noteRow('sess-loc-main', { uuid: 'loc-lost', uText: SHARED_U, sourceTimestamp: 2000 }),
  noteRow('sess-loc-main', { uuid: 'loc-kept', uText: SHARED_U, sourceTimestamp: 1000 }),
]);

const prefixStored = storedUText(PREFIX_TAIL_U);
const pathTermsRow = {
  uuid: 'loc-path-row', uText: 'index probe turn', note: 'this note names no file',
  searchTerms: buildSearchTerms({
    uText: 'index probe turn', note: 'this note names no file', cwd: LOCATE_CWD,
    turn: { lines: [
      { kind: 'tool', tool: { name: 'Read', input: { file_path: 'lib/store.js' } } },
      { kind: 'tool', tool: { name: 'Bash', input: { command: 'npm test' } } },
    ] },
  }),
};
storeMain.upsertTurnNotes([
  noteRow('sess-loc-index', { uuid: 'loc-shape-noted', uText: 'projshape-word noted turn', note: 'a recorded decision' }),
  noteRow('sess-loc-index', { uuid: 'loc-shape-bare', uText: 'projshape-word bare turn' }),
  noteRow('sess-loc-index', pathTermsRow),
  noteRow('sess-loc-index', { uuid: 'loc-cjk-row', uText: '连续中文可命中',
    searchTerms: buildSearchTerms({ uText: '连续中文可命中', note: null, turn: { lines: [] }, cwd: LOCATE_CWD }) }),
  noteRow('sess-loc-index', { uuid: 'loc-and-row', uText: 'and probe turn', note: 'alpha decision recorded' }),
  noteRow('sess-loc-index', { uuid: 'loc-prefix-row', uText: prefixStored.uText,
    uOriginalChars: prefixStored.uOriginalChars,
    searchTerms: buildSearchTerms({ uText: prefixStored.uText, note: null, turn: { lines: [] }, cwd: LOCATE_CWD }) }),
]);

// 顺序组：独占一个 DB。七条索引内容完全相同的行（⇒ 同 rank）分布在三个会话，timestamp 决定全局次序；
// 前六名在 S2（四条）与 S1（两条）之间交错，第七名独占 S3。命中上限是 5，所以全局 rank 与「按 session
// 分桶」会挑出不同的命中集合：全局前五漏掉 S2 最旧的一条，分桶前五改漏 S1 最旧的一条 —— 重排会被抓住，
// 而 S3 只握着 rank 最低的一条，预读也会被抓住。
const storeRank = testStore('locate-rank');
const rankAEntries = [];
headUAt(rankAEntries, 'rank-a', 30, 'rank-a-30', 'rank a30 instruction');
headUAt(rankAEntries, 'rank-a', 50, 'rank-a-50', 'rank a50 instruction');
const rankAPath = writeTranscript(dir, rankAEntries);
const rankBEntries = [];
headUAt(rankBEntries, 'rank-b', 20, 'rank-b-20', 'rank b20 instruction');
headUAt(rankBEntries, 'rank-b', 40, 'rank-b-40', 'rank b40 instruction');
headUAt(rankBEntries, 'rank-b', 60, 'rank-b-60', 'rank b60 instruction');
headUAt(rankBEntries, 'rank-b', 80, 'rank-b-80', 'rank b80 instruction');
const rankBPath = writeTranscript(dir, rankBEntries);
const rankCPath = writeTranscript(dir, headUAt([], 'rank-c', 10, 'rank-c-10', 'rank c10 instruction'));
const rankLineage = [
  { label: 'S1', sessionId: 'sess-rank-a', transcriptPath: rankAPath, handoffId: 920 },
  { label: 'S2', sessionId: 'sess-rank-b', transcriptPath: rankBPath, handoffId: 921 },
  { label: 'S3', sessionId: 'sess-rank-c', transcriptPath: rankCPath, handoffId: 922 },
];
const RANK_U = 'rank-probe-word turn';
storeRank.upsertTurnNotes([
  noteRow('sess-rank-b', { uuid: 'rank-b-80', uText: RANK_U, sourceTimestamp: 7000 }),
  noteRow('sess-rank-a', { uuid: 'rank-a-50', uText: RANK_U, sourceTimestamp: 6000 }),
  noteRow('sess-rank-b', { uuid: 'rank-b-60', uText: RANK_U, sourceTimestamp: 5000 }),
  noteRow('sess-rank-a', { uuid: 'rank-a-30', uText: RANK_U, sourceTimestamp: 4000 }),
  noteRow('sess-rank-b', { uuid: 'rank-b-40', uText: RANK_U, sourceTimestamp: 3000 }),
  noteRow('sess-rank-b', { uuid: 'rank-b-20', uText: RANK_U, sourceTimestamp: 2000 }),
  noteRow('sess-rank-c', { uuid: 'rank-c-10', uText: RANK_U, sourceTimestamp: 1000 }),
]);

// 虚表删除组：独占一个 DB，因为删表会让同库后续 upsert 的三个触发器全部失败。
const storeDrop = testStore('locate-drop');
const dropPath = writeTranscript(dir, linear([
  userMessage({ uuid: 'drop-u', text: 'drop-visible-literal instruction', timestamp: ts(1) }),
  assistantObservation({ uuid: 'drop-a', messageId: 'm-drop', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'answered' }] }),
]));
const dropLineage = [{ label: 'S1', sessionId: 'sess-loc-drop', transcriptPath: dropPath, handoffId: 930 }];
storeDrop.upsertTurnNotes([noteRow('sess-loc-drop', { uuid: 'drop-u', uText: 'drop-probe-word turn' })]);

// 窗口组：邻居取自 projectSession 的 records 数组，所以锚落在连续物理行，每条 U 自成一个 fold。
// A 有八条记录、B 只有三条，边缘命中因此天然拿到短窗口 —— 跨会话借邻居会立刻被抓住。
const storeWin = testStore('locate-window');

// 一条纯 U 链：每条 U 自成一行，行号连号。窗口按数组下标取邻居，不必把锚推到稀疏行号上。
const uChain = (tag, texts) => writeTranscript(dir, linear(
  texts.map((text, i) => userMessage({ uuid: `${tag}-${i}`, text, timestamp: ts(i + 1) }))));

const WIN_A_U = [
  'winrow0 wincapword', 'winrow1 wincapword', 'winrow2 wincapword windedupword', 'winrow3 wincapword',
  'winrow4 wincapword windedupword winmidword', 'winrow5 wincapword', 'winrow6 wincapword',
  'winrow7 wincapword winedgeword',
];
const WIN_B_U = ['winrowb0 winedgeword', 'winrowb1 plainrow', 'winrowb2 plainrow'];
// 只有这一条 note 越过 NOTE_PREVIEW_TOKENS，所以预览截断与升级后的完整 note 都能一眼认出。
const WIN_LONG_NOTE = `a long recorded decision ${'d'.repeat(480)}`;
const WIN_A_NOTE = ['note zero', 'note one', WIN_LONG_NOTE, 'note three', 'note four', 'note five',
  'note six', 'note seven'];
const winAPath = uChain('win-a', WIN_A_U);
const winBPath = uChain('win-b', WIN_B_U);
const winLineage = [
  { label: 'S1', sessionId: 'sess-win-a', transcriptPath: winAPath, handoffId: 940 },
  { label: 'S2', sessionId: 'sess-win-b', transcriptPath: winBPath, handoffId: 941 },
];
storeWin.upsertTurnNotes([
  ...WIN_A_U.map((uText, i) => noteRow('sess-win-a',
    { uuid: `win-a-${i}`, uText, note: WIN_A_NOTE[i], sourceTimestamp: 8000 - i * 1000 })),
  ...WIN_B_U.map((uText, j) => noteRow('sess-win-b',
    { uuid: `win-b-${j}`, uText, note: `note b${j}`, sourceTimestamp: 500 - j * 100 })),
]);
const winIds = winLineage.map(e => e.sessionId);
const locateWin = (q) => locateRanges({ store: storeWin, lineage: winLineage, q });

// 预算组与地板组：note 取 NOTE_TOKEN_LIMIT 的满额（DEFAULT_CTP 下 800 token = 2400 个 ascii 字符），
// 也就是提交侧允许的最大值。预算组的 u 短，地板组的 u 也取满额 —— 一条最坏情况的命中带满窗口仍必须
// 留在预算内，这是「预算永远砍不掉第一个命中」的地板。
const MAX_NOTE = 'n'.repeat(NOTE_TOKEN_LIMIT * DEFAULT_CTP.ascii);

const storeBudget = testStore('locate-budget');
const BUDGET_HITS = [2, 7, 12, 17, 22];   // 间距 5 ⇒ 五个满窗口互不相交，命中数只可能被预算压低
const BUDGET_U = Array.from({ length: 25 }, (_, i) =>
  `budget row ${i}${BUDGET_HITS.includes(i) ? ' winbudgetword' : ''}`);
const budgetPath = uChain('bud', BUDGET_U);
const budgetLineage = [
  { label: 'S1', sessionId: 'sess-win-budget', transcriptPath: budgetPath, handoffId: 942 },
];
storeBudget.upsertTurnNotes(BUDGET_U.map((uText, i) => noteRow('sess-win-budget',
  { uuid: `bud-${i}`, uText, note: MAX_NOTE, sourceTimestamp: 25000 - i * 100 })));

const storeFloor = testStore('locate-floor');
const floorU = (i) => {
  const term = i === 2 ? 'winfloorword' : 'plainrow';
  return `${term} ${'u'.repeat(U_TEXT_TOKENS * DEFAULT_CTP.ascii - term.length - 1)}`;
};
const FLOOR_U = Array.from({ length: 5 }, (_, i) => floorU(i));
const floorPath = uChain('flo', FLOOR_U);
const floorLineage = [
  { label: 'S1', sessionId: 'sess-win-floor', transcriptPath: floorPath, handoffId: 943 },
];
storeFloor.upsertTurnNotes(FLOOR_U.map((uText, i) => noteRow('sess-win-floor',
  { uuid: `flo-${i}`, uText, note: MAX_NOTE, sourceTimestamp: 5000 - i * 100 })));

const locate = (args) => locateRanges({ store: storeMain, lineage: locateLineage, ...args });

// `hit` 只出现在命中项上，所以「哪一项是命中」只能从这个键读出来；context 项断言键的缺席。
const hitScopes = (r) => r.ranges.filter(e => e.hit).map(e => e.scope);
const allScopes = (r) => r.ranges.map(e => e.scope);
const entryAt = (r, scope) => r.ranges.find(e => e.scope === scope);

// ── Locate fixture self-proofs ─────────────────────────────────────────────────

test('fixture 自证：活跃锚落在预期物理行，废弃兄弟不在活跃路径上，S3 转录确实不可读', () => {
  const ordinalsOf = (p) => activePathOrdinals(readCanonicalTranscript(p));
  const main = ordinalsOf(locateMainPath);
  assert.equal(main.get('loc-kept'), 14);
  assert.equal(main.has('loc-lost'), false, '废弃兄弟必须真的丢掉活跃路径');
  assert.deepEqual([...ordinalsOf(locateIndexPath).entries()], [
    ['loc-shape-noted', 21], ['loc-shape-bare', 31], ['loc-path-row', 41],
    ['loc-cjk-row', 51], ['loc-and-row', 61], ['loc-prefix-row', 71],
  ]);
  assert.equal(readCanonicalTranscript(locateLineage[2].transcriptPath).status, 'unavailable');
  assert.deepEqual([...ordinalsOf(rankBPath).entries()],
    [['rank-b-20', 21], ['rank-b-40', 41], ['rank-b-60', 61], ['rank-b-80', 81]]);
  assert.deepEqual([...ordinalsOf(rankAPath).entries()], [['rank-a-30', 31], ['rank-a-50', 51]]);
  // 窗口组的锚落在连续物理行，所以下标之差就是 T 之差 —— 窗口断言里的 S{k}:{T} 直接对应下标距离。
  assert.deepEqual([...ordinalsOf(winAPath).values()], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...ordinalsOf(winBPath).values()], [1, 2, 3]);
});

test('fixture 自证：机械路径索引只收路径，前缀行的 u_text 真的截掉了尾部字面量', () => {
  assert.deepEqual(pathTermsRow.searchTerms.split(' '), [`${LOCATE_CWD}/lib/store.js`]);
  assert.ok(!pathTermsRow.uText.includes('store.js') && !pathTermsRow.note.includes('store.js'),
    '路径既不在 u_text 也不在 note 里 —— 命中只能来自 search_terms');
  assert.ok(prefixStored.uText.includes('prefix-literal'));
  assert.ok(!prefixStored.uText.includes('tail-literal'), '尾部字面量必须真的不在库里');
  assert.ok(prefixStored.uOriginalChars > prefixStored.uText.length);
});

// ── Locate ─────────────────────────────────────────────────────────────────────

test('locate：多词保持 AND，零命中不做 OR fallback，FTS 运算符按字面量处理', () => {
  assert.equal(locate({ q: 'alpha' }).found, true);
  assert.equal(locate({ q: 'alpha zzzz' }).found, false);
  assert.equal(locate({ q: 'alpha OR zzzz' }).found, false, 'advanced MATCH 不可达：OR 只是一个词');
});

test('locate：note 未提到的路径仍可命中（机械索引），工具名不进索引', () => {
  const r = locate({ q: 'lib/store.js' });
  assert.deepEqual(hitScopes(r), ['S2:41']);
  const hit = entryAt(r, 'S2:41');
  assert.ok(!hit.u.includes('store.js') && !hit.note.includes('store.js'));
  assert.equal(locate({ q: 'Bash' }).found, false, '工具名不是检索词');
});

test('locate：连续中文经 bigram 命中，与 search_terms 同一套切分', () => {
  assert.deepEqual(hitScopes(locate({ q: '连续中文' })), ['S2:51']);
});

test('locate：候选返回前解析 T 并校验 active path；废弃分支与不可读来源都省略', () => {
  // 全量列表而非只看命中：废弃的兄弟 U 也不能作为邻居被窗口捎带进来。
  assert.deepEqual(allScopes(locate({ q: 'shared-note-word' })), ['S1:14']);
});

test('locate：全部候选无法验证时与零命中同形，不暴露候选元数据', () => {
  assert.deepEqual(locateRanges({ store: storeMain, lineage: unreadableOnlyLineage, q: 'shared-note-word' }),
    { found: false });
});

test('locate：命中投影为 {scope,u,note?,transcript_path}+hit，context 项同形但无 hit 与路径，note 为 NULL 时键不出现', () => {
  const r = locate({ q: 'projshape-word' });
  assert.deepEqual(hitScopes(r), ['S2:21', 'S2:31']);
  assert.deepEqual(allScopes(r), ['S2:21', 'S2:31', 'S2:41', 'S2:51']);
  assert.deepEqual(Object.keys(entryAt(r, 'S2:21')).sort(), ['hit', 'note', 'scope', 'transcript_path', 'u']);
  assert.deepEqual(Object.keys(entryAt(r, 'S2:31')).sort(), ['hit', 'scope', 'transcript_path', 'u']);
  assert.deepEqual(Object.keys(entryAt(r, 'S2:41')).sort(), ['note', 'scope', 'u']);
  assert.deepEqual(Object.keys(entryAt(r, 'S2:51')).sort(), ['scope', 'u']);
  assert.equal(entryAt(r, 'S2:21').u, 'projshape-word noted turn');
  assert.equal(entryAt(r, 'S2:21').note, 'a recorded decision');
});

test('locate：hit 的 transcript_path 是它自己那个 session 的转录，不是 lineage 里别的', () => {
  const r = locate({ q: 'projshape-word' });
  // 上下文条目的职责是被认出来而不是被读，而路径按条目重复会从预算里挤掉候选 —— 所以只有 hit 带它。
  assert.equal(entryAt(r, 'S2:21').transcript_path, locateIndexPath);
  assert.equal(entryAt(r, 'S2:31').transcript_path, locateIndexPath);
});

test('locate：u_text 只索引 C-token 前缀 —— 前缀命中、尾部不命中，尾部仍由无 scope search 找到', () => {
  const r = locate({ q: 'prefix-literal' });
  assert.deepEqual(hitScopes(r), ['S2:71']);
  assert.ok(entryAt(r, 'S2:71').u.endsWith(` [truncated; ${prefixStored.uOriginalChars} chars]`),
    '投影复用消费侧 Turn Record，截断标记照旧');
  assert.equal(locate({ q: 'tail-literal' }).found, false);
  assert.equal(searchTranscripts({ lineage: locateLineage, q: 'tail-literal' }).found, true);
});

test('locate：session 集合为空时精确返回 {found:false}', () => {
  assert.deepEqual(locateRanges({ store: storeMain, lineage: [], q: 'shared-note-word' }), { found: false });
});

test('locate：turn FTS 状态位为 false 时不发查询即 locate_unavailable', (t) => {
  const priorFlag = storeMain._turnFtsAvailable;
  const original = storeMain.locateTurnNotes;
  let queries = 0;
  storeMain.locateTurnNotes = (...args) => { queries++; return original.apply(storeMain, args); };
  storeMain._turnFtsAvailable = false;
  t.after(() => { storeMain._turnFtsAvailable = priorFlag; storeMain.locateTurnNotes = original; });
  assert.throws(() => locate({ q: 'shared-note-word' }), /locate_unavailable/);
  assert.equal(queries, 0, '状态位为 false 时不再查 FTS');
});

test('locate：SQL 的全局 rank 顺序原样取用，跨 session 交错不重排，最多 5 个命中', () => {
  const r = locateRanges({ store: storeRank, lineage: rankLineage, q: 'rank-probe-word' });
  // 全局前五 = b-80/a-50/b-60/a-30/b-40；按 session 分桶会取成 b-80/b-60/b-40/b-20/a-50 —— 集合不同。
  assert.deepEqual(hitScopes(r), ['S1:31', 'S1:51', 'S2:41', 'S2:61', 'S2:81']);
  // S2 的三个命中共用一段窗口，把未命中的 b-20 一并带进来，且只带一次。
  assert.deepEqual(allScopes(r), ['S1:31', 'S1:51', 'S2:21', 'S2:41', 'S2:61', 'S2:81']);
});

test('locate：按需解析，每 session 至多一次；凑满 5 个命中后不打开更低 rank 的 session', () => {
  const opened = [];
  const counting = (p, opts) => { opened.push(p); return readCanonicalTranscript(p, opts); };
  const r = locateRanges({ store: storeRank, lineage: rankLineage, q: 'rank-probe-word', readTranscript: counting });
  assert.equal(hitScopes(r).length, 5);
  assert.deepEqual(opened, [rankBPath, rankAPath], 'S2 只解析一次，S3 完全不打开');
});

test('locate：运行期虚表被删（状态位仍为 true）⇒ locate_unavailable，精确 search 不受影响', (t) => {
  // 三个触发器仍指向已删虚表，所以本例结束前必须重建虚表并 rebuild，否则同库后续 upsert 全炸。
  storeDrop._db.exec('DROP TABLE turn_note_fts');
  t.after(() => {
    storeDrop._db.exec(`CREATE VIRTUAL TABLE turn_note_fts USING fts5(
      u_text, note, search_terms, content='turn_note', content_rowid='turn_note_id')`);
    storeDrop._db.exec("INSERT INTO turn_note_fts(turn_note_fts) VALUES('rebuild')");
  });
  assert.equal(storeDrop.turnFtsAvailable(), true, '可用性状态位在 open 时算定，删表不改它');
  assert.throws(() => locateRanges({ store: storeDrop, lineage: dropLineage, q: 'drop-probe-word' }),
    /locate_unavailable/);
  assert.equal(searchTranscripts({ lineage: dropLineage, q: 'drop-visible-literal' }).found, true);
});

test('locate：虚表重建后同一 store 仍可写可定位（上一例的收尾确实生效）', () => {
  storeDrop.upsertTurnNotes([noteRow('sess-loc-drop', { uuid: 'drop-u', uText: 'drop-probe-word turn again' })]);
  const r = locateRanges({ store: storeDrop, lineage: dropLineage, q: 'drop-probe-word' });
  assert.deepEqual(allScopes(r), ['S1:1']);
});

// ── Locate windows ─────────────────────────────────────────────────────────────

test('locate：命中带上同会话前后各两条邻居，摊平成一条按 T 升序的列表', () => {
  const r = locateWin('winmidword');
  assert.deepEqual(hitScopes(r), ['S1:5']);
  assert.deepEqual(allScopes(r), ['S1:3', 'S1:4', 'S1:5', 'S1:6', 'S1:7']);
  for (const scope of ['S1:3', 'S1:4', 'S1:6', 'S1:7']) {
    assert.equal(Object.hasOwn(entryAt(r, scope), 'hit'), false, `${scope} 是 context，不带 hit 键`);
  }
});

test('locate：会话边缘的命中拿短窗口，绝不借邻居会话的记录；输出先按 lineage 序再按 T 序', () => {
  const raw = storeWin.locateTurnNotes(winIds, 'winedgeword').map(row => row.anchorUuid);
  assert.deepEqual(raw, ['win-b-0', 'win-a-7'], 'rank 序把 S2 排在 S1 之前 —— 升序输出不是 rank 序的复制');
  const r = locateWin('winedgeword');
  assert.deepEqual(hitScopes(r), ['S1:8', 'S2:1']);
  // 前者是 A 的末条、后者是 B 的首条：两侧各缺一半窗口，且谁都没有拿到对面会话的记录。
  assert.deepEqual(allScopes(r), ['S1:6', 'S1:7', 'S1:8', 'S2:1', 'S2:2', 'S2:3']);
});

test('locate：会话末条上的单个命中，窗口只在本会话内收缩 —— 绝不借下一个会话的记录', () => {
  // 边缘窗口那一例里每个会话都有命中，它们的窗口并起来正好等于断言的列表，所以那一例分辨不出
  // 「窗口跨了会话」。这一例只让 A 的末条命中，于是 S2 的任何一条出现都只可能来自跨会话取窗。
  const raw = storeWin.locateTurnNotes(winIds, 'winrow7').map(row => row.anchorUuid);
  assert.deepEqual(raw, ['win-a-7'], 'fixture 自证：这个词只命中 A 的末条');
  const r = locateWin('winrow7');
  assert.deepEqual(hitScopes(r), ['S1:8']);
  assert.deepEqual(allScopes(r), ['S1:6', 'S1:7', 'S1:8']);
});

test('locate：相隔 2 的两个命中共享 context，共享记录只出现一次，后到的命中把 context 升级', () => {
  const raw = storeWin.locateTurnNotes(winIds, 'windedupword').map(row => row.anchorUuid);
  assert.deepEqual(raw, ['win-a-4', 'win-a-2'], 'rank 序先给 win-a-4 —— win-a-2 先作为 context 落地再被升级');
  const r = locateWin('windedupword');
  assert.deepEqual(allScopes(r), ['S1:1', 'S1:2', 'S1:3', 'S1:4', 'S1:5', 'S1:6', 'S1:7']);
  assert.deepEqual(hitScopes(r), ['S1:3', 'S1:5']);
  assert.equal(entryAt(r, 'S1:3').note, WIN_LONG_NOTE, '升级后带完整 note，不再是预览');
});

test('locate：context 项的 note 压到预览额度并带上原长后缀，短 note 原样不加标记', () => {
  const r = locateWin('winmidword');
  const suffix = ` [truncated; ${WIN_LONG_NOTE.length} chars]`;
  const preview = entryAt(r, 'S1:3').note;
  assert.ok(preview.endsWith(suffix), 'context note 复用投影 u 的同一条截断标记');
  const body = preview.slice(0, -suffix.length);
  assert.ok(WIN_LONG_NOTE.startsWith(body) && body.length < WIN_LONG_NOTE.length);
  assert.ok(Math.round(charsToTokens(body, DEFAULT_CTP)) <= NOTE_PREVIEW_TOKENS,
    `预览 ${body.length} 字符超过了 ${NOTE_PREVIEW_TOKENS} token`);
  assert.equal(entryAt(r, 'S1:4').note, 'note three', '本来就在额度内的 note 不进截断路径');
});

test('locate：验证通过的候选多于上限时恰好留 5 个命中，且这一刀不是预算切的', () => {
  assert.equal(storeWin.locateTurnNotes(winIds, 'wincapword').length, 8, '候选真的多于 5');
  const r = locateWin('wincapword');
  assert.equal(hitScopes(r).length, 5);
  assert.ok(estimateWireTokens(r, DEFAULT_CTP) < BOOKMARK_TOKEN_BUDGET / 2,
    '离预算还很远 —— 砍到 5 的是命中上限而不是预算');
});

test('locate：note 撑满额度时预算压低命中数，响应仍在预算内，且没有任何字段声明这次删减', () => {
  const nominated = storeBudget.locateTurnNotes(['sess-win-budget'], 'winbudgetword');
  assert.deepEqual(nominated.map(row => row.anchorUuid), BUDGET_HITS.map(i => `bud-${i}`),
    'rank 序就是下标序 —— 留下的三个必须是它的前缀，才说明走停了而不是跳着挑');
  const r = locateRanges({ store: storeBudget, lineage: budgetLineage, q: 'winbudgetword' });
  assert.deepEqual(hitScopes(r), ['S1:3', 'S1:8', 'S1:13']);
  assert.ok(isWithinBookmarkBudget(estimateWireTokens(r, DEFAULT_CTP)));
  assert.deepEqual(Object.keys(r).sort(), ['found', 'ranges'], '没有 truncated、没有计数、没有 rank');
  for (const e of r.ranges) {
    assert.ok(Object.keys(e).every(k => ['scope', 'u', 'note', 'hit', 'transcript_path'].includes(k)),
      Object.keys(e).join());
  }
});

test('locate：u 与 note 都撑满的单条命中带满窗口仍在预算内 —— 预算砍不掉第一个命中', () => {
  const r = locateRanges({ store: storeFloor, lineage: floorLineage, q: 'winfloorword' });
  assert.equal(r.found, true);
  assert.deepEqual(hitScopes(r), ['S1:3']);
  assert.deepEqual(allScopes(r), ['S1:1', 'S1:2', 'S1:3', 'S1:4', 'S1:5']);
  assert.equal(entryAt(r, 'S1:3').note, MAX_NOTE, '命中带的是完整的满额 note');
  assert.ok(isWithinBookmarkBudget(estimateWireTokens(r, DEFAULT_CTP)));
});

// ── Search enrichment fixtures ─────────────────────────────────────────────────
// 富化只能沿 turn 归属走：命中 fold 的锚 → groupTurns 给出的头 U 锚 → 已持久化的 Turn Record。
// A 会话因此刻意让命中落在头 U 之后的 fold 上（锚与 T 都与头 U 不同），并把一个「捕获边界之后」的
// 无记录 turn 放在一个 noted turn 之后 —— 按 T 就近取记录的实现会把它错配到前一个 noted turn 上。

const storeEnrich = testStore('search-enrich');

// 越过 NOTE_PREVIEW_TOKENS：命中带的必须是全文，locate 的预览截断不能渗进 search。
const ENRICH_NOTE = `a recorded search decision ${'e'.repeat(480)}`;

const enrichAPath = writeTranscript(dir, linear([
  // 头 U：crossenrich-literal 落在头 fold 自己身上
  userMessage({ uuid: 'enr-head', text: 'enrich head instruction crossenrich-literal', timestamp: ts(1) }),
  // 同一个 turn 里更深的一层 fold —— 锚与 T 都不是头 U 的
  assistantObservation({ uuid: 'enr-deep', messageId: 'm-enr-deep', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'deep inside the same turn: deepfold-literal' }] }),
  // 工具对更深一层，请求行与 result 行仍属同一个 turn
  assistantToolUse({ uuid: 'enr-tool', messageId: 'm-enr-tool', toolUseId: 'tu-enr',
    name: 'Bash', input: { command: 'echo toolfold-literal' }, timestamp: ts(3) }),
  toolResult({ uuid: 'r-enr-tool', toolUseId: 'tu-enr', content: 'tool output' }),
  // 头 U：捕获边界之后的 turn，库里没有它的行
  userMessage({ uuid: 'enr-orphan', text: 'orphan turn instruction past the boundary', timestamp: ts(4) }),
  assistantObservation({ uuid: 'enr-orphan-a', messageId: 'm-enr-orphan', timestamp: ts(5),
    blocks: [{ type: 'text', text: 'answered after the boundary: orphanfold-literal' }] }),
  // 头 U：有记录，但 note 为 NULL
  userMessage({ uuid: 'enr-nonote', text: 'nonote turn instruction', timestamp: ts(6) }),
  assistantObservation({ uuid: 'enr-nonote-a', messageId: 'm-enr-nonote', timestamp: ts(7),
    blocks: [{ type: 'text', text: 'answered with nonotefold-literal' }] }),
]));
// B 会话一条 turn_note 都没有：同一次调用里它的命中必须停在裸形。
const enrichBPath = writeTranscript(dir, linear([
  userMessage({ uuid: 'enr-b-head', text: 'b session instruction crossenrich-literal', timestamp: ts(1) }),
]));
const enrichLineage = [
  { label: 'S1', sessionId: 'sess-enrich-a', transcriptPath: enrichAPath, handoffId: 950 },
  { label: 'S2', sessionId: 'sess-enrich-b', transcriptPath: enrichBPath, handoffId: 951 },
];
storeEnrich.upsertTurnNotes([
  noteRow('sess-enrich-a', { uuid: 'enr-head', uText: 'enrich head instruction crossenrich-literal',
    note: ENRICH_NOTE, sourceTimestamp: 3000 }),
  noteRow('sess-enrich-a', { uuid: 'enr-nonote', uText: 'nonote turn instruction', sourceTimestamp: 1000 }),
]);

const enrichSearch = (q, scope = null) =>
  searchTranscriptsImpl({ store: storeEnrich, lineage: enrichLineage, q, scope });
// 富化挂在 turn 上，所以「裸形」是一个 turn 分组的性质，不再是单条 match 的性质。
const BARE_GROUP_KEYS = ['matches', 'transcript_path'];
const keysOf = (m) => Object.keys(m).sort();

// 富化组：搭一个 store 给已有的 80 命中会话，用来量「富化后预算装得更少」。
const FREQ_NOTE = `a recorded decision about this frequent turn ${'d'.repeat(240)}`;
const storeFreq = testStore('search-freq');
storeFreq.upsertTurnNotes(Array.from({ length: FREQUENT_COUNT }, (_, i) => noteRow('sess-new', {
  uuid: `u-freq-${i}`, uText: `frequent-hit-${i}-${'p'.repeat(250)}`, note: FREQ_NOTE,
  sourceTimestamp: 1000 + i,
})));

// ── Search enrichment fixture self-proofs ──────────────────────────────────────

test('fixture 自证：A 会话三个头 U 各占自己那一行，命中 fold 的 T 真的不是头 U 的 T，B 会话零记录', () => {
  const transcript = readCanonicalTranscript(enrichAPath);
  assert.deepEqual(groupTurns(enumerateLines(transcript)).map(t => t.t), [1, 5, 7]);
  assert.deepEqual(
    ['enr-deep', 'enr-tool', 'enr-orphan-a', 'enr-nonote-a']
      .map(u => findFoldByAnchor(transcript, u).sourceRef.lineOrdinal),
    [2, 3, 6, 8], '命中锚都不在头 U 那一行 —— 两个 T 若相同，scope 断言就不再有区分力');
  assert.equal(storeEnrich.listTurnNotes('sess-enrich-b').length, 0);
  assert.deepEqual(storeEnrich.listTurnNotes('sess-enrich-a').map(r => r.anchorUuid).sort(),
    ['enr-head', 'enr-nonote'], '边界之后的 turn 必须真的没有行');
});

// ── Search enrichment ──────────────────────────────────────────────────────────

test('search：命中所在 turn 有记录时分组带上 scope / u / 完整 note；同一次调用里零记录的会话仍是裸形', () => {
  const r = enrichSearch('crossenrich-literal');
  assert.deepEqual(r.ranges.map(g => g.transcript_path), [enrichAPath, enrichBPath]);
  const [enriched, bare] = r.ranges;
  assert.deepEqual(keysOf(enriched), [...BARE_GROUP_KEYS, 'note', 'scope', 'u'].sort());
  assert.equal(enriched.scope, 'S1:1');
  assert.equal(enriched.u, 'enrich head instruction crossenrich-literal');
  assert.equal(enriched.note, ENRICH_NOTE, '分组带 note 全文，不是 locate 的预览');
  assert.deepEqual(keysOf(bare), BARE_GROUP_KEYS);
});

test('search：scope 是头 U 的 T，而不是命中 fold 的行号', () => {
  for (const q of ['deepfold-literal', 'toolfold-literal']) {
    assert.equal(enrichSearch(q).ranges[0].scope, 'S1:1', q);
  }
});

test('search：无记录的 turn 分组一个富化字段都不带，绝不借前一个 noted turn 的记录', () => {
  const r = enrichSearch('orphanfold-literal');
  assert.deepEqual(allMatches(r).map(m => m.line), [lineOfFold(enrichAPath, 'enr-orphan-a')]);
  assert.deepEqual(keysOf(r.ranges[0]), BARE_GROUP_KEYS);
  // 头 U 自己的原文同理：这个 turn 整个没有记录，而它前面那个 turn 有
  assert.deepEqual(keysOf(enrichSearch('orphan turn instruction').ranges[0]), BARE_GROUP_KEYS);
});

test('search：note 为 NULL 的记录只带 scope 与 u，note 键不出现', () => {
  const g = enrichSearch('nonotefold-literal').ranges[0];
  assert.deepEqual(keysOf(g), [...BARE_GROUP_KEYS, 'scope', 'u'].sort());
  assert.equal(g.scope, 'S1:7');
  assert.equal(g.u, 'nonote turn instruction');
});

test('search：带 scope 的分组一律裸形 —— 这个 turn 有带 note 的记录也一样', () => {
  const scoped = enrichSearch('deepfold-literal', 'S1:1');
  assert.deepEqual(allMatches(scoped).map(m => m.line), [lineOfFold(enrichAPath, 'enr-deep')]);
  assert.deepEqual(keysOf(scoped.ranges[0]), BARE_GROUP_KEYS);
  // 同一个命中在无 scope 时确实富化 —— 那三个键的缺席只可能来自 scope 这一个条件
  assert.deepEqual(keysOf(enrichSearch('deepfold-literal').ranges[0]),
    [...BARE_GROUP_KEYS, 'note', 'scope', 'u'].sort());
});

test('search：无 scope 分组交出的 scope 喂回 search 拿回同一条命中', () => {
  const [group] = enrichSearch('crossenrich-literal').ranges;
  assert.equal(group.scope, 'S1:1');
  const round = enrichSearch('crossenrich-literal', group.scope);
  // 往返的是命中身份 —— 文件、命中行、excerpt；turn 级地址按上一例不参与
  assert.deepEqual(allMatches(round).map(m => m.line), group.matches.map(m => m.line));
  assert.equal(round.ranges[0].transcript_path, group.transcript_path);
  assert.equal(allMatches(round)[0].excerpt, group.matches[0].excerpt);
});

test('search：分组不改写定位符 —— line 是命中所在的物理行，不是头 U 的行', () => {
  for (const [q, t] of [['deepfold-literal', 2], ['toolfold-literal', 3]]) {
    // 分组的 scope 指向头 U 那一行，命中的 line 指向命中自己那一行 —— 两者是不同的坐标
    assert.equal(allMatches(enrichSearch(q))[0].line, t, q);
    assert.equal(enrichSearch(q).ranges[0].scope, 'S1:1', q);
  }
});

test('search：一命中一 turn 时记录仍更早填满预算，被丢掉的是更旧的那些，只由 truncated:true 报告', () => {
  const bare = searchTranscripts({ lineage: twoSessionLineage, q: 'frequent' });
  const enriched = searchTranscriptsImpl({
    store: storeFreq, lineage: twoSessionLineage, q: 'frequent',
  });
  assert.equal(bare.truncated, true);
  assert.equal(enriched.truncated, true);
  // 这个 fixture 里每条命中自成一个 turn，分组因此省不下任何东西 —— 记录的成本原样留在台面上
  assert.ok(enriched.ranges.every(g => g.matches.length === 1), '每条命中自成一个 turn');
  assert.ok(allMatches(enriched).length < allMatches(bare).length,
    `带记录后应装下更少命中：${allMatches(enriched).length} vs ${allMatches(bare).length}`);
  assert.ok(enriched.ranges.every(g => g.scope), '这一组每个 turn 都有记录');
  assert.deepEqual(allMatches(enriched).map(m => m.line),
    allMatches(bare).map(m => m.line).slice(-allMatches(enriched).length),
    '保留集是裸形保留集的「更新」尾段 —— 先丢的是更旧的命中');
  assert.ok(isWithinBookmarkBudget(estimateWireTokens(enriched, DEFAULT_CTP)));
});

test('search：记录按需解析 —— 有命中的会话只解析一次，没有命中的会话一次都不解析', () => {
  // projectSession 从 store 只要 listTurnNotes。Proxy 把这条性质变成断言：被测代码多要一个方法时，失败
  // 消息就是那个方法名，而不是 store.foo is not a function —— 后者读起来像桩写漏了，不像依赖换了。
  const listed = [];
  const counting = new Proxy(
    { listTurnNotes: (id) => { listed.push(id); return storeEnrich.listTurnNotes(id); } },
    { get: (t, p) => p in t ? t[p] : assert.fail(`search 只该向 store 要 listTurnNotes，这次要了 ${String(p)}`) },
  );
  const countingSearch = (q) =>
    searchTranscriptsImpl({ store: counting, lineage: enrichLineage, q });

  // 'literal' 在 A 的五个 fold 与 B 的一个 fold 上都命中：每个会话仍只解析一次。
  const both = countingSearch('literal');
  assert.equal(allMatches(both).length, 6);
  assert.deepEqual(listed, ['sess-enrich-b', 'sess-enrich-a'], '扫描序是新→旧，每会话一次');

  listed.length = 0;
  countingSearch('deepfold-literal');
  assert.deepEqual(listed, ['sess-enrich-a'], 'B 先被扫描但一条都没命中 —— 它的记录不该被解析');
});

// ── 分组 fixtures ──────────────────────────────────────────────────────────────
// 预算按 match 切，分组在输出时才套上去。要让「保留集是最新后缀」和「分组只是渲染」都可断言，每个 turn
// 必须带固定条数的命中 fold，并且 note 要大到预算真的在中途咬住 —— 否则切点根本不出现。

const GROUP_TURNS = 16;
const GROUP_HITS_PER_TURN = 3;
const GROUP_NOTE = `a recorded decision for this grouped turn ${'g'.repeat(760)}`;
const storeGroup = testStore('search-group');
const groupPath = writeTranscript(dir, linear(Array.from({ length: GROUP_TURNS }, (_, k) => [
  userMessage({ uuid: `grp-${k}-head`, text: `grouped turn ${k} head groupword`, timestamp: ts(1 + k * 3) }),
  assistantObservation({ uuid: `grp-${k}-a1`, messageId: `m-grp-${k}-1`, timestamp: ts(2 + k * 3),
    blocks: [{ type: 'text', text: `first answer groupword in turn ${k}` }] }),
  assistantObservation({ uuid: `grp-${k}-a2`, messageId: `m-grp-${k}-2`, timestamp: ts(3 + k * 3),
    blocks: [{ type: 'text', text: `second answer groupword in turn ${k}` }] }),
]).flat()));
const groupLineage = [{ label: 'S1', sessionId: 'sess-group', transcriptPath: groupPath, handoffId: 960 }];
storeGroup.upsertTurnNotes(Array.from({ length: GROUP_TURNS }, (_, k) => noteRow('sess-group', {
  uuid: `grp-${k}-head`, uText: `grouped turn ${k} head groupword`, note: GROUP_NOTE, sourceTimestamp: 1000 + k,
})));
const groupSearch = (scope = null) =>
  searchTranscriptsImpl({ store: storeGroup, lineage: groupLineage, q: 'groupword', scope });
// 每个 turn 占 GROUP_HITS_PER_TURN 行，头 U 是其中第一行，按 grep -n 编号。
const headT = (k) => k * GROUP_HITS_PER_TURN + 1;

// 一个 turn 自己就装不下：单个条目能容多少条 match，由 BOOKMARK_TOKEN_BUDGET 除以「一条 match 加上它
// 所在 turn 的记录」得出，而真实语料上的宽 turn 可命中 fold 数远超这个商。准入若以 turn 为单位，这种
// turn 会让整条响应变成 ranges:[]，所以这里要有一个 fixture。具体数字见 backlog 的决策记录段。
const WIDE_HITS = 120;
const WIDE_NOTE = `a recorded decision for the wide turn ${'w'.repeat(700)}`;
// 每条正文都把命中包在足够长的上下文里，好让 excerpt 顶到 BOOKMARK_PREVIEW_CHARS —— 真实语料上的宽
// turn 正是这样：命中多，且每条 excerpt 都是满窗口。
const wideBody = (i) => `${'a'.repeat(150)} answer ${i} widehit here ${'b'.repeat(150)}`;
const storeWide = testStore('search-wide');
const widePath = writeTranscript(dir, linear([
  userMessage({ uuid: 'wide-head', text: `wide turn head widehit ${'h'.repeat(150)}`, timestamp: ts(1) }),
  ...Array.from({ length: WIDE_HITS - 1 }, (_, i) => assistantObservation({
    uuid: `wide-a-${i}`, messageId: `m-wide-${i}`, timestamp: ts(2 + i),
    blocks: [{ type: 'text', text: wideBody(i) }],
  })),
]));
const wideLineage = [{ label: 'S1', sessionId: 'sess-wide', transcriptPath: widePath, handoffId: 961 }];
storeWide.upsertTurnNotes([noteRow('sess-wide', {
  uuid: 'wide-head', uText: 'wide turn head widehit', note: WIDE_NOTE, sourceTimestamp: 1000,
})]);

// groupTurns 明文「第一个 head 之前的行不属于任何 turn」，所以这种 fold 命中时没有 turn 可归，走的是
// 分组里 `?? anchorUuid` 那条回退。真实语料未见此形，但它是可达的，而回退是分组里没有别处覆盖的路径。
const storePre = testStore('search-prehead');
const prePath = writeTranscript(dir, [
  assistantObservation({ uuid: 'pre-a', parentUuid: null, messageId: 'm-pre', timestamp: ts(1),
    blocks: [{ type: 'text', text: 'orphan assistant before any head preheadword' }] }),
  userMessage({ uuid: 'pre-h', parentUuid: 'pre-a', text: 'first head preheadword', timestamp: ts(2) }),
]);
const preLineage = [{ label: 'S1', sessionId: 'sess-prehead', transcriptPath: prePath, handoffId: 962 }];
storePre.upsertTurnNotes([noteRow('sess-prehead', {
  uuid: 'pre-h', uText: 'first head preheadword', note: 'note of the first turn', sourceTimestamp: 1000 })]);

// ── 分组 fixture 自证 ──────────────────────────────────────────────────────────

test('fixture 自证：分组 fixture 的每个 turn 恰好 3 条命中 fold，且每个 turn 都有带 note 的记录', () => {
  const turns = groupTurns(enumerateLines(readCanonicalTranscript(groupPath)));
  assert.equal(turns.length, GROUP_TURNS);
  assert.deepEqual([...new Set(turns.map(t => t.lines.length))], [GROUP_HITS_PER_TURN]);
  assert.deepEqual(turns.map(t => t.t), Array.from({ length: GROUP_TURNS }, (_, k) => headT(k)));
  assert.equal(storeGroup.listTurnNotes('sess-group').filter(r => r.note).length, GROUP_TURNS);
});

// ── 分组 wire ──────────────────────────────────────────────────────────────────

test('search：同一 turn 的多条命中收成一个 ranges 条目，turn 级字段整条 wire 上只出现一次', () => {
  const r = enrichSearch('literal');
  const [first] = r.ranges;
  assert.deepEqual(first.matches.map(m => m.line),
    ['enr-head', 'enr-deep', 'enr-tool'].map(u => lineOfFold(enrichAPath, u)));
  assert.deepEqual(Object.keys(first), ['transcript_path', 'scope', 'u', 'note', 'matches']);
  assert.equal(first.scope, 'S1:1');
  assert.equal(first.u, 'enrich head instruction crossenrich-literal');
  assert.equal(first.note, ENRICH_NOTE, '命中带 note 全文，不是 locate 的预览');
  // 三条命中同属一个 turn，所以 note 在整条 wire 上只出现一次 —— 这正是分组省下的那部分
  assert.equal(JSON.stringify(r).split(ENRICH_NOTE).length - 1, 1);
  // match 只剩行地址与证据：路径提到了 turn 级，不再每条复制
  assert.deepEqual(Object.keys(first.matches[0]).sort(), ['excerpt', 'line', 'span']);
});

test('search：ranges 按时间线拉平 —— 先 lineage 序再 turn 序，未捕获的 turn 也自成一组', () => {
  const r = enrichSearch('literal');
  assert.deepEqual(r.ranges.map(g => g.transcript_path),
    [enrichAPath, enrichAPath, enrichAPath, enrichBPath]);
  assert.deepEqual(r.ranges.map(g => g.scope ?? null), ['S1:1', null, 'S1:7', null]);
  assert.deepEqual(r.ranges.map(g => g.matches.length), [3, 1, 1, 1]);
  assert.deepEqual(allMatches(r).map(m => m.line), [
    ...['enr-head', 'enr-deep', 'enr-tool', 'enr-orphan-a', 'enr-nonote-a']
      .map(u => lineOfFold(enrichAPath, u)),
    lineOfFold(enrichBPath, 'enr-b-head'),
  ]);
});

test('search：保留集是命中序列最新的那一后缀，分组只是把它按 turn 渲染出来', () => {
  // 这一例不证明「切点可以落在 turn 内部」—— 这个 fixture 里每个 turn 都带记录，一个条目的开销（note）
  // 远大于一条 excerpt，所以溢出几乎总发生在「新开一个条目」的那条候选上，切点因此落在 turn 边界。真正
  // 钉住 turn 内部切点的是下面的 `单个 turn 的命中就超预算`。
  const r = groupSearch();
  assert.equal(r.truncated, true, 'fixture 必须真的撑破预算，否则这条断言是空的');
  assert.ok(r.ranges.length < GROUP_TURNS, `应当丢掉一些 turn：${r.ranges.length} / ${GROUP_TURNS}`);
  const keptHeads = r.ranges.map(g => Number(g.scope.slice(3)));
  assert.deepEqual(keptHeads, Array.from({ length: keptHeads.length },
    (_, i) => headT(GROUP_TURNS - keptHeads.length + i)), '留下的是最新的那一段，且 turn 序连续');
  assert.deepEqual([...new Set(r.ranges.map(g => g.matches.length))], [GROUP_HITS_PER_TURN],
    '同一 turn 的三条命中收成一组 —— 分组是渲染，与切在哪里无关');
  assert.ok(isWithinBookmarkBudget(estimateWireTokens(r, DEFAULT_CTP)));
});

test('search：单个 turn 的命中就超预算时仍返回行地址 —— 该 turn 部分进入，而不是整条响应变空', () => {
  const r = searchTranscriptsImpl({ store: storeWide, lineage: wideLineage, q: 'widehit' });
  assert.equal(r.truncated, true);
  // 回归点：准入若按 turn 整体切，这里会是 ranges:[] —— found:true 却一个地址都没有，消费者无处可去
  assert.equal(r.ranges.length, 1, '所有命中都在同一个 turn 里');
  assert.ok(r.ranges[0].matches.length > 0, 'ranges 不得为空：那会交出一个没有任何地址的 found:true');
  assert.ok(r.ranges[0].matches.length < WIDE_HITS,
    `该 turn 必须是部分进入：${r.ranges[0].matches.length} / ${WIDE_HITS}`);
  assert.ok(r.ranges[0].matches.every(m => Number.isInteger(m.line)), '每条留下的 match 都仍带 line');
  assert.ok(isWithinBookmarkBudget(estimateWireTokens(r, DEFAULT_CTP)));
});

test('search：首个 head 之前的 fold 自成一个裸条目，不并进它后面那个 turn', () => {
  const r = searchTranscriptsImpl({ store: storePre, lineage: preLineage, q: 'preheadword' });
  assert.deepEqual(allMatches(r).map(m => m.line), ['pre-a', 'pre-h'].map(u => lineOfFold(prePath, u)),
    '两条命中各自成组，且旧的在前');
  assert.deepEqual(keysOf(r.ranges[0]), BARE_GROUP_KEYS, '没有 turn 就没有地址可带');
  assert.deepEqual(keysOf(r.ranges[1]), [...BARE_GROUP_KEYS, 'note', 'scope', 'u'].sort());
  assert.equal(r.ranges[1].scope, 'S1:2');
});

test('search：带 scope 的响应同样是分组的 —— 一个 turn 一组，且一个 turn 级地址都不带', () => {
  const scoped = groupSearch(`S1:${headT(GROUP_TURNS - 1)}`);
  assert.deepEqual(scoped.ranges.map(g => Object.keys(g)), [['transcript_path', 'matches']]);
  assert.equal(scoped.ranges[0].transcript_path, groupPath);
  assert.equal(scoped.ranges[0].matches.length, GROUP_HITS_PER_TURN);
  assert.equal(scoped.truncated, false, '一个 turn 的命中远在预算内 —— 这里不该被截断');
});

// ── 文件地址 ───────────────────────────────────────────────────────────────────

// 这三个 fixture 是同一条链：可见体命中、工具结果命中、无工具 fold —— 三种 line/span 口径各一。
const transcriptAddr = writeTranscript(dir, linear([
  userMessage({ uuid: 'ad-u', text: 'visiblebodyliteral in the body', timestamp: ts(1) }),
  assistantToolUse({ uuid: 'ad-a', messageId: 'ad-m', toolUseId: 'ad-t',
    name: 'Bash', input: { command: 'echo go' }, timestamp: ts(2) }),
  toolResult({ uuid: 'ad-r', toolUseId: 'ad-t', content: 'resultonlyliteral in the output', timestamp: ts(3) }),
]));
const addrLineage = [{ label: 'S1', sessionId: 'sess-addr', transcriptPath: transcriptAddr }];

test('可见体命中：line 是该 fold 自己的物理行，span 收敛成单行', () => {
  const m = allMatches(searchTranscripts({ lineage: addrLineage, q: 'visiblebodyliteral' }))[0];
  assert.equal(m.line, 1);
  assert.deepEqual(m.span, [1, 1]);
});

test('工具结果命中：line 指向 result 行而不是请求它的 fold 行', () => {
  const m = allMatches(searchTranscripts({ lineage: addrLineage, q: 'resultonlyliteral' }))[0];
  // 请求它的 fold 与它自己各占一行。发前者就会让读者读到一行不含自己 excerpt 的内容。
  assert.equal(m.line, 3);
  assert.deepEqual(m.span, [2, 3]);
});

// 这个 fold 没有可见文本，锚行就是调用行 —— 两个口径在这里同值，所以这一条断言分不开它们；分得开的
// fixture 带可见文本行，见本文件 `扫描面与行枚举同源`。
test('工具名与序列化 input 的命中指向发起调用的那一行', () => {
  const m = allMatches(searchTranscripts({ lineage: addrLineage, q: '"command":"echo go"' }))[0];
  assert.equal(m.line, 2);
  assert.deepEqual(m.span, [2, 3]);
});

test('每条 ranges 条目带自己的 transcript_path', () => {
  const r = searchTranscripts({ lineage: addrLineage, q: 'visiblebodyliteral' });
  assert.equal(r.ranges[0].transcript_path, transcriptAddr);
});

test('响应与命中都不再携带任何 bookmark 字段', () => {
  const r = searchTranscripts({ lineage: addrLineage, q: 'visiblebodyliteral' });
  assert.deepEqual(Object.keys(r).sort(), ['found', 'ranges', 'truncated']);
  assert.deepEqual(Object.keys(r.ranges[0]).sort(), ['matches', 'transcript_path']);
  assert.deepEqual(Object.keys(r.ranges[0].matches[0]).sort(), ['excerpt', 'line', 'span']);
});

test('scoped 响应同样带 transcript_path —— 调用者给的是 turn 地址，不是文件', () => {
  const scoped = searchTranscripts({ lineage: addrLineage, q: 'visiblebodyliteral', scope: 'S1:1' });
  // scope / u / note 三个键在 scoped 下缺席（它们只会回显输入），路径不在那三个里面。
  assert.deepEqual(Object.keys(scoped.ranges[0]).sort(), ['matches', 'transcript_path']);
  assert.equal(scoped.ranges[0].transcript_path, transcriptAddr);
});
