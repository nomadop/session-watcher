// test/turn.capture.test.js — Turn Note capture: the current-epoch suffix, the skeleton a producer writes
// into, the slot set, the notes-document grammar, the snapshot fingerprint, and the Turn Record rows a
// submission writes.
//
// The pure cases drive shared capture with a SYNTHETIC rule list and supply each tool line's
// `resourceKey` directly: resolving a native input is the Harness Adapter's job, and shared capture reads
// only the field the Adapter attaches. The three cases at the end drive the real in-process turn service,
// because what they pin is the ORDER of a validation against a file write.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ABSORB, AGG_PATH_CAP, PASS, U_TEXT_TOKENS, buildSearchTerms, buildSkeleton, groupTurns,
  parseNoteSections, renderNoteSections, slotKeysOf, snapshotDigest, storedUText,
} from '../lib/turn.js';
import {
  buildTurnNoteRows, captureCurrentEpochTurns, captureIsPersistable, collectNoteIssues,
} from '../lib/turn-note.js';
import { enumerateDialogueLines, projectDialogue } from '../lib/dialogue-fold.js';
import { createClaudeCodeDialogueProjection } from '../lib/harness/claude-code/history-turn-rules.js';
import { createClaudeCodeDialogueSource } from '../lib/harness/claude-code/dialogue-source.js';
import { DEFAULT_CTP } from '../lib/constants.js';
import { charsToTokens } from '../lib/token-estimate.js';
import { bootTestServer } from './helpers/server-boot.js';
import {
  assistantObservation, assistantToolUse, chain, compactSummary, observationsOf, toolResult, ts, usage,
  userMessage,
} from './helpers/transcript-fixtures.js';

// The same synthetic composition shape a real one has: a visible-line rule, then a tool rule.
const RULES = [
  (line) => {
    if (line.kind !== 'visible' || line.message.role !== 'human') return PASS;
    const text = String(line.message.text);
    if (text.startsWith('ACK:')) return { kind: 'ACK', text: text.slice(4) };
    if (text.startsWith('ABSORB:')) return ABSORB;
    return { kind: 'HEAD', text };
  },
  (line) => {
    if (line.kind !== 'tool' || line.tool.name !== 'Ratify') return PASS;
    return { kind: 'HEAD', text: String(line.tool.result ?? '') };
  },
];

// Shared path-cue fixtures supply `resourceKey` directly.
const withResourceKeys = (folds, keys = {}) => {
  for (const fold of folds) {
    for (const pair of fold.toolPairs) {
      if (Object.hasOwn(keys, pair.toolUseId)) pair.resourceKey = keys[pair.toolUseId];
    }
  }
  return folds;
};

const linesOf = (entries, keys) =>
  enumerateDialogueLines(withResourceKeys(projectDialogue(observationsOf(entries)).folds, keys));
const turnsOf = (entries, keys) => groupTurns(linesOf(entries, keys), RULES);

// A synthetic Dialogue Adapter over the shared projection: capture takes the Adapter's two operations, so
// this is what a composition hands it.
const PROJECTION = {
  project: (observations) => ({ folds: projectDialogue(observations).folds }),
  groupTurns: (lines) => groupTurns(lines, RULES),
};

// ── The current-epoch suffix ───────────────────────────────────────────────────

test('capture: 无 epoch-boundary 时取全量观测，末尾 turn 一律排除', () => {
  const observations = observationsOf(chain([
    userMessage({ uuid: 'u1', text: '第一问', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '第一答' }] }),
    userMessage({ uuid: 'u2', text: '当前 handoff turn', timestamp: ts(3) }),
  ]));
  assert.ok(!observations.some(o => o.type === 'epoch-boundary'), 'fixture 自证：没有 epoch 边界');
  const { turns } = captureCurrentEpochTurns({ observations, dialogueProjection: PROJECTION });
  assert.deepEqual(turns.map(t => t.cleanedU), ['第一问']);
});

test('capture: 只取最后一个 epoch-boundary 严格之后的观测，T 仍是文件绝对行号', () => {
  const observations = observationsOf([
    ...chain([
      userMessage({ uuid: 'u-pre', text: 'pre-compact-u', timestamp: ts(1) }),
      // The call the compact replaces: a root with no call behind it is session-start preamble, so the
      // boundary this case is about needs a measured turn ahead of it.
      assistantObservation({ uuid: 'a-pre', messageId: 'm-pre', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'pre-compact-a' }], usage: usage({ input: 2, output: 5, cacheRead: 10_000 }) }),
    ]),
    ...chain([
      compactSummary({ uuid: 'c-sum', timestamp: ts(3), text: 'summary of the epoch' }),
      userMessage({ uuid: 'u-post', text: 'post-compact-u', timestamp: ts(4) }),
      assistantObservation({ uuid: 'a-post', messageId: 'm-post', timestamp: ts(5),
        blocks: [{ type: 'text', text: 'post-compact-a' }] }),
      userMessage({ uuid: 'u-cur', text: 'current-handoff-u', timestamp: ts(6) }),
    ]),
  ]);
  const { turns } = captureCurrentEpochTurns({ observations, dialogueProjection: PROJECTION });
  assert.deepEqual(turns.map(t => t.cleanedU), ['post-compact-u']);
  // The boundary does not restart the numbering: the ordinal is still the row's own physical position.
  assert.equal(turns[0].sourceOrdinal, 4);
});

test('capture: 每个 epoch-boundary 都数，取的是最后一个', () => {
  const observations = observationsOf([
    ...chain([userMessage({ uuid: 'r1', text: 'epoch one ask', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'epoch one answer' }], usage: usage({ input: 2, output: 5, cacheRead: 10_000 }) })]),
    ...chain([compactSummary({ uuid: 'c1', timestamp: ts(3) }),
      userMessage({ uuid: 'u2', text: 'epoch two ask', timestamp: ts(4) })]),
    ...chain([compactSummary({ uuid: 'c2', timestamp: ts(5) }),
      userMessage({ uuid: 'u3', text: 'epoch three ask', timestamp: ts(6) }),
      assistantObservation({ uuid: 'a3', messageId: 'm3', timestamp: ts(7),
        blocks: [{ type: 'text', text: 'answered' }] }),
      userMessage({ uuid: 'u4', text: 'current handoff', timestamp: ts(8) })]),
  ]);
  assert.equal(observations.filter(o => o.type === 'epoch-boundary').length, 2);
  const { turns } = captureCurrentEpochTurns({ observations, dialogueProjection: PROJECTION });
  assert.deepEqual(turns.map(t => t.cleanedU), ['epoch three ask']);
});

test('capture: 只有当前 handoff turn 时捕获为空', () => {
  const observations = observationsOf([userMessage({ uuid: 'u1', text: 'prepare', timestamp: ts(1) })]);
  assert.deepEqual(captureCurrentEpochTurns({ observations, dialogueProjection: PROJECTION }).turns, []);
  assert.deepEqual(captureCurrentEpochTurns({ observations: [], dialogueProjection: PROJECTION }).turns, []);
});

// ── Persistability ─────────────────────────────────────────────────────────────

test('captureIsPersistable: identity、时间与组内唯一性三条都要成立', () => {
  const head = (sourceEntryId, timestamp) => ({ sourceEntryId, timestamp, sourceOrdinal: 1 });
  assert.equal(captureIsPersistable([head('a', 10), head('b', 20)]), true);
  assert.equal(captureIsPersistable([]), true);
  assert.equal(captureIsPersistable([head(null, 10)]), false);
  assert.equal(captureIsPersistable([head('', 10)]), false);
  assert.equal(captureIsPersistable([head('a', null)]), false);
  assert.equal(captureIsPersistable([head('a', undefined)]), false);
  assert.equal(captureIsPersistable([head('dup', 10), head('dup', 20)]), false);
});

// ── The skeleton ───────────────────────────────────────────────────────────────

// 物理转录行与对话行不是一回事：meta 行、tool_result 行都占掉 ordinal 却不产出对话行。骨架 fixture
// 故意留着这段空隙 —— T 只有取绝对文件行号才对得上，取 turn 内数组下标一律不对。
const lastUuid = (entries) => (entries.length ? entries[entries.length - 1].uuid : null);
const padTo = (entries, ordinal, tag) => {
  while (entries.length < ordinal) {
    entries.push(userMessage({
      uuid: `${tag}-meta-${entries.length}`, parentUuid: lastUuid(entries),
      text: 'meta', timestamp: ts(0), extra: { isMeta: true },
    }));
  }
  return entries;
};

// 头 U 由 padTo 垫到转录中段：一个承载 turn（含 ABSORB 的打断行）+ 一个真 note-less 的裸命令 turn。
const skeletonEntries = (answer) => {
  const e = padTo([], 12, 'sk');
  e.push(userMessage({ uuid: 'sk-u1', parentUuid: lastUuid(e), text: '第一个问题', timestamp: ts(1) }));
  e.push(assistantObservation({ uuid: 'sk-a1', parentUuid: lastUuid(e), messageId: 'sk-m1', timestamp: ts(2),
    blocks: [{ type: 'text', text: answer }] }));
  e.push(userMessage({ uuid: 'sk-i1', parentUuid: lastUuid(e), text: 'ABSORB:[Request interrupted by user]', timestamp: ts(3) }));
  e.push(assistantObservation({ uuid: 'sk-a2', parentUuid: lastUuid(e), messageId: 'sk-m2', timestamp: ts(4),
    blocks: [{ type: 'text', text: '续答' }] }));
  e.push(userMessage({ uuid: 'sk-c1', parentUuid: lastUuid(e), text: '/clear', timestamp: ts(5) }));
  return e;
};
const turns = turnsOf(skeletonEntries('回答'));
const turnsWithActivity = turns.filter(t => t.hasAssistantActivity);
// 同一批 entries，只把一条 assistant 正文改一个字：槽集合不变，已捕获的 fold 正文变了。
const turnsWithEditedAssistantText = turnsOf(skeletonEntries('回荅'));
const clearOnlyTurns = turnsOf([userMessage({ uuid: 'c1', text: '/clear', timestamp: ts(1) })]);

// 两侧都要超护栏：U 500 字过 U_HEAD_CHARS，A 600 字过 A_CUT_CHARS —— 否则「尾截 A」那半个断言无从落地。
const [turnWithLongU] = turnsOf(chain([
  userMessage({ uuid: 'lu-u', text: 'x'.repeat(500), timestamp: ts(1) }),
  assistantObservation({ uuid: 'lu-a', messageId: 'lu-m', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'y'.repeat(600) }] }),
]));

// 中段密集 CRLF：先截后归一化会把护栏花在马上要塌掉的 \r 上，'z' 一个都留不下来。
const [crlfBudgetTurn] = turnsOf(chain([
  userMessage({ uuid: 'cb-u', text: 'a' + '\r\n'.repeat(150) + 'z'.repeat(100), timestamp: ts(1) }),
  assistantObservation({ uuid: 'cb-a', messageId: 'cb-m', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'ok' }] }),
]));

const multilineEntries = padTo([], 12, 'ml');
multilineEntries.push(userMessage({ uuid: 'ml-u', parentUuid: lastUuid(multilineEntries),
  text: 'u-first\r\nu-second', timestamp: ts(1) }));
padTo(multilineEntries, 18, 'ml');
multilineEntries.push(assistantObservation({ uuid: 'ml-a', parentUuid: lastUuid(multilineEntries),
  messageId: 'ml-m', timestamp: ts(2), blocks: [{ type: 'text', text: 'a-first\ra-second' }] }));
const [multilineSkeletonTurn] = turnsOf(multilineEntries);

// U 的第 200 个 UTF-16 码元落在 emoji 高代理上；A 长 601 码元，尾截起点 601-128=473 落在低代理上。
const [astralBoundaryTurn] = turnsOf(chain([
  userMessage({ uuid: 'ab-u', text: 'a'.repeat(199) + '😀'.repeat(10), timestamp: ts(1) }),
  assistantObservation({ uuid: 'ab-a', messageId: 'ab-m', timestamp: ts(2),
    blocks: [{ type: 'text', text: '😀'.repeat(300) + 'z' }] }),
]));

const relativeToolEntries = chain([
  userMessage({ uuid: 'rt-u', text: 'read the store', timestamp: ts(1) }),
  assistantToolUse({ uuid: 'rt-a', messageId: 'rt-m', toolUseId: 'tok-rt',
    name: 'Read', input: { file_path: 'lib/store.js' }, timestamp: ts(2) }),
  toolResult({ uuid: 'rt-r', toolUseId: 'tok-rt', content: 'export const x = 1;' }),
]);
const [turnWithRelativeTool] = turnsOf(relativeToolEntries, { 'tok-rt': '/project/lib/store.js' });
const [turnWithOtherResourceKey] = turnsOf(relativeToolEntries, { 'tok-rt': '/other/lib/store.js' });

// 一条 assistant 消息，头段与尾段可区分：'末条永远取尾' 只有这样才能落地断言。
const [turnWithOneLongAssistant] = turnsOf(chain([
  userMessage({ uuid: 'ol-u', text: '问', timestamp: ts(1) }),
  assistantObservation({ uuid: 'ol-a', messageId: 'ol-m', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'H'.repeat(200) + 'T'.repeat(200) }] }),
]));

// 三条 assistant 消息：首条取头、末条取尾、中段一整条不出现。
const [turnWithThreeAssistants] = turnsOf(chain([
  userMessage({ uuid: 'th-u', text: '问', timestamp: ts(1) }),
  assistantObservation({ uuid: 'th-a1', messageId: 'th-m1', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'F'.repeat(200) + 'x'.repeat(200) }] }),
  assistantObservation({ uuid: 'th-a2', messageId: 'th-m2', timestamp: ts(3),
    blocks: [{ type: 'text', text: 'MIDDLE-MESSAGE' }] }),
  assistantObservation({ uuid: 'th-a3', messageId: 'th-m3', timestamp: ts(4),
    blocks: [{ type: 'text', text: 'y'.repeat(200) + 'L'.repeat(200) }] }),
]));

// 聚合行：8 条不同 key 过 AGG_PATH_CAP，一条重复 key 验去重，一条无 key 的工具只进计数。
const manyToolEntries = [
  userMessage({ uuid: 'mt-u', text: '干活', timestamp: ts(1) }),
  assistantObservation({ uuid: 'mt-a', parentUuid: 'mt-u', messageId: 'mt-m', timestamp: ts(2),
    blocks: [{ type: 'text', text: '开始' }] }),
];
const manyToolKeys = {};
for (const [i, rel] of ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js', 'a.js'].entries()) {
  manyToolEntries.push(assistantToolUse({ uuid: `mt-t${i}`, parentUuid: lastUuid(manyToolEntries),
    messageId: `mt-tm${i}`, toolUseId: `tok-mt${i}`, name: 'Read', input: { file_path: `lib/${rel}` },
    timestamp: ts(3 + i) }));
  manyToolEntries.push(toolResult({ uuid: `mt-r${i}`, parentUuid: lastUuid(manyToolEntries),
    toolUseId: `tok-mt${i}`, content: 'ok' }));
  manyToolKeys[`tok-mt${i}`] = `/project/lib/${rel}`;
}
manyToolEntries.push(assistantToolUse({ uuid: 'mt-np', parentUuid: lastUuid(manyToolEntries),
  messageId: 'mt-npm', toolUseId: 'tok-mt-np', name: 'Bash', input: { command: 'ls' }, timestamp: ts(20) }));
manyToolEntries.push(toolResult({ uuid: 'mt-npr', parentUuid: lastUuid(manyToolEntries),
  toolUseId: 'tok-mt-np', content: 'ok' }));
const [turnWithManyTools] = turnsOf(manyToolEntries, manyToolKeys);

test('骨架：每行带自己的 T，NOTE 槽自带头行的 T 作标签，真 note-less 无槽', () => {
  const skeleton = buildSkeleton(turns, 'sess-A');
  assert.match(skeleton, /^CONTEXT EPOCH {2}session sess-A {3}turns \d+$/m);
  assert.match(skeleton, /^CONTEXT EPOCH {2}session sess-A {3}turns \d+\n\nT /);
  assert.match(skeleton, /^T +13 \| U {3}: /m);
  assert.match(skeleton, /^ +\| NOTE\[13\]: ____$/m);
  assert.equal((skeleton.match(/NOTE\[\d+\]: ____/g) || []).length, turnsWithActivity.length);
});

// 聚合行与 NOTE 槽同一个门控。放开聚合行那一半的变异曾在全套 1786 个测试下存活。
test('真 note-less turn 既不出聚合行也不出槽', () => {
  const s = buildSkeleton(clearOnlyTurns, 'sess-A');
  assert.ok(!/\| A×/.test(s));
  assert.ok(!/NOTE\[/.test(s));
});

test('ABSORB 行在骨架里以原文出现（不是清洗后的空串），但不获得 NOTE 槽', () => {
  const s = buildSkeleton(turns, 'sess-A');
  assert.ok(s.includes('[Request interrupted by user]'));
  assert.equal((s.match(/NOTE\[\d+\]: ____/g) || []).length, 1);   // 只有承载 turn 有槽
});

// 生产者按块里印的 T 去写 `## NOTE[T]`：头行与槽印不同的行号，这一块就没有一个能用的地址。
test('骨架：裁定 turn 的头行与它的 NOTE 槽印同一个 T —— 提问行', () => {
  const ratified = turnsOf(chain([
    userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '先确认一件事' }] }),
    assistantToolUse({ uuid: 'ask1', messageId: 'm1', toolUseId: 'tu1', name: 'Ratify',
      input: {}, timestamp: ts(3) }),
    toolResult({ uuid: 'ans1', toolUseId: 'tu1', content: '裁定文本', timestamp: ts(9) }),
    assistantObservation({ uuid: 'after-a', messageId: 'm2', timestamp: ts(10),
      blocks: [{ type: 'text', text: '开始执行' }] }),
  ]))[1];
  const s = buildSkeleton([ratified], 'sess-A');
  const uRow = s.split('\n').find(row => row.includes('| U   :'));
  assert.equal(Number(uRow.match(/^T\s+(\d+) \|/)[1]), ratified.sourceOrdinal);
  assert.ok(s.includes(`NOTE[${ratified.sourceOrdinal}]: ____`));
  assert.equal(ratified.sourceOrdinal, 3, '提问的 tool_use 行，不是 fold 正文行 2');
});

test('骨架：裁定行只渲染一条 U，不重复渲染成工具行，也不进聚合行的工具计数', () => {
  const ratified = turnsOf(chain([
    userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'ask1', messageId: 'm1', toolUseId: 'tu1', name: 'Ratify',
      input: {}, timestamp: ts(2) }),
    toolResult({ uuid: 'ans1', toolUseId: 'tu1', content: '裁定文本', timestamp: ts(3) }),
    assistantObservation({ uuid: 'ah-a', messageId: 'ah-m', timestamp: ts(4),
      blocks: [{ type: 'text', text: '接着做' }] }),
    assistantToolUse({ uuid: 'ah-t', messageId: 'ah-tm', toolUseId: 'tok-ah', name: 'Read',
      input: { file_path: 'lib/store.js' }, timestamp: ts(5) }),
    toolResult({ uuid: 'ah-r', toolUseId: 'tok-ah', content: 'ok' }),
  ]), { 'tok-ah': '/project/lib/store.js' })[1];
  const s = buildSkeleton([ratified], 'sess', );
  const rows = s.split('\n').filter(r => r.includes(`T ${String(2).padStart(4)} |`));
  assert.deepEqual(rows, [`T ${String(2).padStart(4)} | U   : 裁定文本`]);
  assert.ok(!s.includes('Ratify'));
  assert.match(s, /^ {6}\| A×1 · 1 tools: store\.js$/m);
});

test('骨架省略：头截 U 尾随裸 …、尾截 A 前置裸 …，无计数；两个护栏各自定尺', () => {
  const s = buildSkeleton([turnWithLongU], 'sess-A');
  assert.ok(!s.includes('[truncated'));
  assert.match(s, /^T +\d+ \| U {3}: x{200}…$/m);   // U 头截：… 收尾
  assert.match(s, /^T +\d+ \| A {3}: …y{128}$/m);   // A 尾截：… 起头
});

test('单条 assistant 消息取尾：末条永远取尾，取头只在 ≥2 条时生效', () => {
  const aRows = buildSkeleton([turnWithOneLongAssistant], 'sess-A')
    .split('\n').filter(r => / \| A {3}: /.test(r));
  assert.equal(aRows.length, 1);
  assert.match(aRows[0], /^T +\d+ \| A {3}: …T{128}$/);   // 取头会以 H 起、以 … 收
});

test('≥2 条：首条取头、末条取尾，中段整条不进骨架', () => {
  const s = buildSkeleton([turnWithThreeAssistants], 'sess-A');
  assert.match(s, /^T +\d+ \| A {3}: F{128}…$/m);
  assert.match(s, /^T +\d+ \| A {3}: …L{128}$/m);
  assert.ok(!s.includes('MIDDLE-MESSAGE'));
  assert.match(s, /^ +\| A×3$/m);                  // 无工具时聚合行只报条数
});

test('聚合行：assistant 条数、工具次数、去重 basename 封顶后记余数；无逐次工具行', () => {
  const s = buildSkeleton([turnWithManyTools], 'sess-A');
  assert.match(s, /^ +\| A×1 · 10 tools: a\.js,b\.js,c\.js,d\.js,e\.js,f\.js \+2$/m);
  assert.ok(!/\| A · : /.test(s));
  assert.ok(!s.includes('/project/lib/'));         // basename only —— 全 key 由 search_terms 承担
  assert.equal(AGG_PATH_CAP, 6, 'fixture 自证：封顶值就是这一行印出六个 basename 的原因');
});

// 两行对调曾在全套下存活,而 `CONTEXT.md` 的 Turn Skeleton 词条与 `NOTES.md` 的示例块都把 NOTE 槽
// 定在块尾 —— producer 是按「块以槽收尾」读的。
test('块尾顺序：聚合行紧接正文，NOTE 槽是块的最后一行', () => {
  const rows = buildSkeleton([turnWithManyTools], 'sess-A').split('\n');
  assert.match(rows[rows.length - 1], /^ +\| NOTE\[\d+\]: ____$/);
  assert.match(rows[rows.length - 2], /^ +\| A×\d+ · \d+ tools/);
});

test('聚合行：零 resourceKey 时只报次数，不留悬空冒号', () => {
  const s = buildSkeleton(turnsOf(chain([
    userMessage({ uuid: 'nb-u', text: '跑一下', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'nb-t', messageId: 'nb-m', toolUseId: 'tok-nb',
      name: 'Bash', input: { command: 'ls' }, timestamp: ts(2) }),
    toolResult({ uuid: 'nb-r', toolUseId: 'tok-nb', content: 'ok' }),
  ])), 'sess');
  assert.match(s, /^ {6}\| A×0 · 1 tools$/m);
});

test('聚合行：basename 数恰好等于 AGG_PATH_CAP 时不记余数', () => {
  const e = [userMessage({ uuid: 'cap-u', text: '读六个', timestamp: ts(1) })];
  const keys = {};
  for (const [i, rel] of ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'].entries()) {
    e.push(assistantToolUse({ uuid: `cap-t${i}`, parentUuid: lastUuid(e), messageId: `cap-m${i}`,
      toolUseId: `tok-cap${i}`, name: 'Read', input: { file_path: `lib/${rel}` }, timestamp: ts(2 + i) }));
    e.push(toolResult({ uuid: `cap-r${i}`, parentUuid: lastUuid(e), toolUseId: `tok-cap${i}`, content: 'ok' }));
    keys[`tok-cap${i}`] = `/project/lib/${rel}`;
  }
  const s = buildSkeleton(turnsOf(e, keys), 'sess');
  assert.match(s, /^ {6}\| A×0 · 6 tools: a\.js,b\.js,c\.js,d\.js,e\.js,f\.js$/m);
});

test('骨架先统一换行符再截断：护栏按归一化后的字符数计，不被 CRLF 吃掉', () => {
  const s = buildSkeleton([crlfBudgetTurn], 'sess-A');
  assert.match(s, /^T +\d+ \| U {3}: z+…$/m);
  assert.ok(!s.includes('\r'));
});

test('骨架多行正文统一换行符，且每个物理行重复自己的 T 与角色', () => {
  const s = buildSkeleton([multilineSkeletonTurn], 'sess-A');
  assert.match(s, /^T +13 \| U {3}: u-first$/m);
  assert.match(s, /^T +13 \| U {3}: u-second$/m);
  assert.match(s, /^T +19 \| A {3}: a-first$/m);
  assert.match(s, /^T +19 \| A {3}: a-second$/m);
  assert.ok(!s.includes('\r'));
});

test('骨架头截/尾截不切断 UTF-16 代理对', () => {
  const s = buildSkeleton([astralBoundaryTurn], 'sess-A');
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    assert.ok(cp < 0xD800 || cp > 0xDFFF, '不得输出孤立代理码元');
  }
});

// ── The slot set ───────────────────────────────────────────────────────────────

test('slotKeysOf：只有带 assistant 活动的 turn 有槽，顺序即 turn 顺序', () => {
  // 三个 turn 两个槽：首问与第二问有 assistant 活动，中间那个裸命令没有。字面量是故意的 ——
  // 拿同一个 filter 反算期望值只会复述实现，槽序被颠倒也看不出来。
  const twoSlots = turnsOf(chain([
    userMessage({ uuid: 'sk2-u1', text: '第一问', timestamp: ts(1) }),
    assistantObservation({ uuid: 'sk2-a1', messageId: 'sk2-m1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '第一答' }] }),
    userMessage({ uuid: 'sk2-c', text: '/clear', timestamp: ts(3) }),
    userMessage({ uuid: 'sk2-u2', text: '第二问', timestamp: ts(4) }),
    assistantObservation({ uuid: 'sk2-a2', messageId: 'sk2-m2', timestamp: ts(5),
      blocks: [{ type: 'text', text: '第二答' }] }),
  ]));
  assert.deepEqual(slotKeysOf(twoSlots), ['1', '4']);
  assert.deepEqual(slotKeysOf(clearOnlyTurns), []);
});

// ── notes 文件文法 ─────────────────────────────────────────────────────────────
// 分隔符是独占一行的二级标题，正文是标题之间的一切。这才是它比内联 `NOTE[T]: text` 稳的地方：
// 正文里出现 `NOTE[9]:`、`|`、冒号、换行都不影响切段。

test('renderNoteSections：标题由服务端写，槽间一个空行', () => {
  assert.equal(renderNoteSections(['12', '31']), '## NOTE[12]\n\n## NOTE[31]\n');
  assert.equal(renderNoteSections([]), '');
});

test('parseNoteSections：标题之间的一切都是正文，含换行、冒号、`|` 与内联 NOTE 字样', () => {
  const body = '第一行 · 结论: 砍掉\n第二行 NOTE[9]: 这是正文不是标题\n| 表格行';
  const { sections, issues } = parseNoteSections(`## NOTE[12]\n\n${body}\n\n## NOTE[31]\n\nb\n`, ['12', '31']);
  assert.deepEqual(issues, []);
  assert.deepEqual([...sections], [['12', body], ['31', 'b']]);
});

test('parseNoteSections：严格 `## ` —— 其他标题级不是分隔符，落进上一段正文', () => {
  const { sections } = parseNoteSections('## NOTE[12]\n\nbody\n\n### NOTE[31]\n\nsub\n', ['12', '31']);
  assert.deepEqual([...sections.keys()], ['12']);
  assert.ok(sections.get('12').includes('### NOTE[31]'), '子标题留在正文里，不另开段');
});

// 分隔符是「本次捕获的槽标签」而不是「任何数字标签」。三件事靠这一条同时成立：正文里出现独占一行的
// `## NOTE[N]` 时后半段不会被静默截断；rewind 留下的孤儿标题无法把一条 note 塞给一个没有槽的 turn；
// 每条 issue 的 t 都是真实 turn 序号,而不是文件里恰好写了什么数字。
test('parseNoteSections：非本轮槽的标题不是分隔符 —— 它是正文，后半段不丢', () => {
  const { sections, issues } = parseNoteSections(
    '## NOTE[12]\n\nheading grammar: server prewrites\n## NOTE[31]\nand the producer fills bodies\n', ['12']);
  assert.deepEqual(issues, []);
  assert.deepEqual([...sections.keys()], ['12']);
  assert.ok(sections.get('12').endsWith('and the producer fills bodies'), '截断在标题处就丢了这半句');
  assert.ok(sections.get('12').includes('## NOTE[31]'));
  // 首个槽标题之前也开不出段。只放开这半边的变异曾在全套下存活,而它复活的正是「producer 发明的标题
  // 把一条 note 塞给 note-less turn」。
  assert.deepEqual(
    [...parseNoteSections('## NOTE[999]\n\nINVENTED\n\n## NOTE[12]\n\nreal\n', ['12']).sections],
    [['12', 'real']]);
});

// 无损:同一份字节在槽集合变化时读出不同的段。rewind 掉的槽日后若回来,它的正文原样恢复。
test('parseNoteSections：同一份文本随槽集合改变读法，孤儿段的正文不丢', () => {
  const text = '## NOTE[12]\n\na\n\n## NOTE[31]\n\nb\n';
  assert.equal(parseNoteSections(text, ['12']).sections.get('12'), 'a\n\n## NOTE[31]\n\nb');
  assert.equal(parseNoteSections(text, ['12', '31']).sections.get('31'), 'b');
});

test('parseNoteSections：首标题前的散文被丢弃 —— 它不属于任何槽', () => {
  const { sections, issues } = parseNoteSections('preamble prose\n\n## NOTE[12]\n\nbody\n', ['12']);
  assert.deepEqual(issues, []);
  assert.deepEqual([...sections], [['12', 'body']]);
});

test('parseNoteSections：空正文的段解析为空串，重复标题各报一次 issue', () => {
  const empty = parseNoteSections('## NOTE[12]\n\n## NOTE[31]\n\nb\n', ['12', '31']);
  assert.equal(empty.sections.get('12'), '');
  const dup = parseNoteSections('## NOTE[12]\n\na\n\n## NOTE[12]\n\nb\n', ['12']);
  assert.deepEqual(dup.issues, [{ t: 12, message: 'duplicate NOTE section for this T' }]);
});

// 重复只在真槽上是错误。非槽标签重复不切段 ⇒ 不报 —— 否则它又是一条 producer 删不掉、而且指向一个
// 骨架里根本没有的 T 的拒绝。
test('parseNoteSections：非槽标签重复不报 issue', () => {
  const dup = parseNoteSections('## NOTE[12]\n\na\n\n## NOTE[41]\n\nb\n\n## NOTE[41]\n\nc\n', ['12']);
  assert.deepEqual(dup.issues, []);
  assert.deepEqual([...dup.sections.keys()], ['12']);
});

// 槽键都来自 String(turn.sourceOrdinal),所以任何标签长到溢出 Number.MAX_VALUE 都不可能成为分隔符 ——
// issue 的 t 于是永远是安全整数,不会经 Infinity 变成线上的 null。
test('parseNoteSections：溢出 Number 的巨大标签既不切段也不产出 issue', () => {
  const huge = '9'.repeat(309);
  const { sections, issues } = parseNoteSections(
    `## NOTE[0]\n\nbody\n\n## NOTE[${huge}]\n\nx\n\n## NOTE[${huge}]\n\ny\n`, ['0']);
  assert.deepEqual(issues, []);
  assert.deepEqual([...sections.keys()], ['0']);
});

test('parseNoteSections：文件不存在（null）不是崩溃，是零段', () => {
  assert.deepEqual(parseNoteSections(null, ['12']), { sections: new Map(), issues: [] });
});

test('parseNoteSections：标签按数字读 —— `## NOTE[00]` 就是槽 0，不是一个谁都对不上的键', () => {
  assert.deepEqual([...parseNoteSections('## NOTE[00]\n\nbody\n', ['0']).sections], [['0', 'body']]);
  // 归一化后 `## NOTE[0]` 与 `## NOTE[00]` 是同一个槽 ⇒ 报重复（真话），而不是「无此槽」+「缺此槽」两条互相矛盾的假话。
  assert.deepEqual(parseNoteSections('## NOTE[0]\n\na\n\n## NOTE[00]\n\nb\n', ['0']).issues,
    [{ t: 0, message: 'duplicate NOTE section for this T' }]);
});

test('parseNoteSections：标题行尾的空白不吃掉那条 note', () => {
  assert.deepEqual([...parseNoteSections('## NOTE[0]  \n\nbody\n', ['0']).sections], [['0', 'body']]);
});

// ── Coverage validation ────────────────────────────────────────────────────────

test('collectNoteIssues：缺段报 missing，库里已有那一行则算覆盖', () => {
  const withNotes = turnsOf(chain([
    userMessage({ uuid: 'cv-u', text: '问', timestamp: ts(1) }),
    assistantObservation({ uuid: 'cv-a', messageId: 'cv-m', timestamp: ts(2),
      blocks: [{ type: 'text', text: '答' }] }),
  ]));
  assert.deepEqual(collectNoteIssues({ turns: withNotes, sections: new Map(), storedNotes: new Map() }),
    [{ t: 1, message: 'missing note for this NOTE slot' }]);
  // 判据是行的存在，不是 note 的内容：一条合法的 null 也算覆盖。
  assert.deepEqual(collectNoteIssues({
    turns: withNotes, sections: new Map(), storedNotes: new Map([['cv-u', null]]),
  }), []);
  assert.deepEqual(collectNoteIssues({
    turns: withNotes, sections: new Map([['1', 'a body']]), storedNotes: new Map(),
  }), []);
});

test('collectNoteIssues：note 超上限整组拒绝，且只量文件里那一份', () => {
  const withNotes = turnsOf(chain([
    userMessage({ uuid: 'cv-u', text: '问', timestamp: ts(1) }),
    assistantObservation({ uuid: 'cv-a', messageId: 'cv-m', timestamp: ts(2),
      blocks: [{ type: 'text', text: '答' }] }),
  ]));
  const atLimit = '中'.repeat(800);
  assert.equal(Math.round(charsToTokens(atLimit, DEFAULT_CTP)), 800, 'fixture 自证：正好落在上限上');
  assert.deepEqual(collectNoteIssues({
    turns: withNotes, sections: new Map([['1', atLimit]]), storedNotes: new Map(),
  }), []);
  assert.deepEqual(collectNoteIssues({
    turns: withNotes, sections: new Map([['1', '中'.repeat(801)]]), storedNotes: new Map(),
  }), [{ t: 1, message: 'note exceeds 800 tokens' }]);
  // 库里那一份没有再过一次这道门 —— 它第一次落库时就过了。
  assert.deepEqual(collectNoteIssues({
    turns: withNotes, sections: new Map(), storedNotes: new Map([['cv-u', '中'.repeat(5000)]]),
  }), []);
});

test('collectNoteIssues：无槽的 turn 不产出任何 issue', () => {
  assert.deepEqual(collectNoteIssues({
    turns: clearOnlyTurns, sections: new Map(), storedNotes: new Map(),
  }), []);
});

// ── The snapshot fingerprint ───────────────────────────────────────────────────

test('snapshotDigest：槽集合不变但已捕获 fold 正文变化 ⇒ digest 变化', () => {
  assert.notEqual(snapshotDigest(turns), snapshotDigest(turnsWithEditedAssistantText));
});

test('snapshotDigest：resourceKey 变化即 digest 变化 —— 路径线索是被指纹覆盖的', () => {
  assert.notEqual(snapshotDigest([turnWithRelativeTool]), snapshotDigest([turnWithOtherResourceKey]));
});

test('snapshotDigest：同一批 turn 两次计算一致，空捕获也有确定的 digest', () => {
  assert.equal(snapshotDigest(turns), snapshotDigest(turnsOf(skeletonEntries('回答'))));
  assert.equal(snapshotDigest([]), snapshotDigest([]));
  assert.notEqual(snapshotDigest([]), snapshotDigest(turns));
});

// ── Row construction ───────────────────────────────────────────────────────────

test('storedUText: 截断状态由 u_original_chars > u_text.length 派生', () => {
  const { uText, uOriginalChars } = storedUText('中'.repeat(500));
  assert.equal(uOriginalChars, 500);
  assert.ok(uOriginalChars > uText.length);
  assert.ok(charsToTokens(uText, DEFAULT_CTP) <= U_TEXT_TOKENS);
});

test('buildSearchTerms：CJK bigram 加上每条工具行的 resourceKey，去重，工具名从不入索引', () => {
  const terms = buildSearchTerms({ uText: '', note: null, turn: turnWithRelativeTool });
  assert.ok(terms.split(' ').includes('/project/lib/store.js'));
  assert.ok(!terms.includes('Read'));
  const many = buildSearchTerms({ uText: '', note: null, turn: turnWithManyTools }).split(' ');
  assert.equal(many.filter(t => t === '/project/lib/a.js').length, 1, '重复 key 只入一次');
  // 一条没有 resourceKey 的工具行贡献不了词条。
  assert.equal(buildSearchTerms({ uText: '', note: null, turn: clearOnlyTurns[0] }), '');
});

test('buildTurnNoteRows：每个被捕获的 turn 一行，identity 与时间来自它的头', () => {
  const captured = turnsOf(chain([
    userMessage({ uuid: 'row-u', text: '中'.repeat(500), timestamp: ts(4) }),
    assistantObservation({ uuid: 'row-a', messageId: 'row-m', timestamp: ts(5),
      blocks: [{ type: 'text', text: '答' }] }),
    userMessage({ uuid: 'row-c', text: '/clear', timestamp: ts(6) }),
  ]));
  const rows = buildTurnNoteRows({
    turns: captured,
    sections: new Map([['1', 'the note']]),
    storedNotes: new Map(),
    sessionId: 'sess-R',
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sourceSessionId, 'sess-R');
  assert.equal(rows[0].anchorUuid, 'row-u');
  assert.equal(rows[0].sourceTimestamp, Date.parse(ts(4)));
  assert.equal(rows[0].note, 'the note');
  assert.equal(rows[0].uOriginalChars, 500);
  assert.ok(rows[0].uOriginalChars > rows[0].uText.length);
  // A truly note-less turn still gets a row, carrying a legitimate null.
  assert.equal(rows[1].anchorUuid, 'row-c');
  assert.equal(rows[1].note, null);
});

// The one case in this file driven by the REAL Claude Code Adapter rather than by a supplied key: what it
// pins is which base directory the Adapter resolves against, so the resolution itself has to happen.
test('[delta] Turn path cues resolve against the issuing row cwd', () => {
  const SESSION_CWD = '/project';
  const ROW_CWD = '/project/lib';
  // One relative tool input, two candidate absolute keys. Both are reachable, so an assertion on the
  // row-cwd one cannot pass by accident: a silent fall back to the session root yields the other.
  const UNDER_ROW_CWD = '/project/lib/store.js';
  const UNDER_SESSION_CWD = '/project/store.js';
  assert.notEqual(UNDER_ROW_CWD, UNDER_SESSION_CWD, 'fixture 自证：两个候选 key 真的不同');

  const adapter = createClaudeCodeDialogueProjection({ sessionCwd: SESSION_CWD });
  // The two fixtures differ in ONE field: whether the tool-use row carries its own working directory.
  // `cwd` is not in the snapshot digest, so any digest difference below comes from the resolved key alone.
  const entriesWith = (rowCwd) => chain([
    userMessage({ uuid: 'tc-u', text: 'read the store', timestamp: ts(1) }),
    { ...assistantToolUse({ uuid: 'tc-a', messageId: 'tc-m', toolUseId: 'tc-tu', name: 'Read',
      input: { file_path: 'store.js' }, timestamp: ts(2) }), ...(rowCwd ? { cwd: rowCwd } : {}) },
    toolResult({ uuid: 'tc-r', toolUseId: 'tc-tu', content: 'export const x = 1;' }),
  ]);
  const turnsOfAdapter = (rowCwd) => {
    const { folds } = adapter.project(observationsOf(entriesWith(rowCwd)));
    return adapter.groupTurns(enumerateDialogueLines(folds));
  };
  const [withRowCwd] = turnsOfAdapter(ROW_CWD);
  const [withoutRowCwd] = turnsOfAdapter(null);

  // The key the Adapter attached, and the key the same input reaches without a row directory.
  const keyOf = (turn) => turn.lines.find(l => l.kind === 'tool').tool.resourceKey;
  assert.equal(keyOf(withRowCwd), UNDER_ROW_CWD);
  assert.equal(keyOf(withoutRowCwd), UNDER_SESSION_CWD, 'fixture 自证：会话根确实给出另一个 key');

  // search_terms indexes the row-cwd key and never the session-root one.
  const terms = buildSearchTerms({ uText: '', note: null, turn: withRowCwd }).split(' ');
  assert.deepEqual(terms, [UNDER_ROW_CWD]);
  assert.ok(!terms.includes(UNDER_SESSION_CWD));
  assert.deepEqual(buildSearchTerms({ uText: '', note: null, turn: withoutRowCwd }).split(' '),
    [UNDER_SESSION_CWD], 'fixture 自证：索引确实随 base 变化');

  // The snapshot digest covers the same cue: the two captures fingerprint differently, and the row-cwd
  // capture fingerprints as a capture whose key IS the row-cwd one.
  assert.notEqual(snapshotDigest([withRowCwd]), snapshotDigest([withoutRowCwd]));
  assert.equal(snapshotDigest([withRowCwd]),
    snapshotDigest(turnsOf(entriesWith(ROW_CWD), { 'tc-tu': UNDER_ROW_CWD })));
  assert.notEqual(snapshotDigest([withRowCwd]),
    snapshotDigest(turnsOf(entriesWith(ROW_CWD), { 'tc-tu': UNDER_SESSION_CWD })));
});

test('buildTurnNoteRows：文件是增量、库是底本 —— 库独占覆盖的槽保住它自己的 note', () => {
  const captured = turnsOf(chain([
    userMessage({ uuid: 'row-u', text: '问', timestamp: ts(1) }),
    assistantObservation({ uuid: 'row-a', messageId: 'row-m', timestamp: ts(2),
      blocks: [{ type: 'text', text: '答' }] }),
  ]));
  assert.equal(buildTurnNoteRows({
    turns: captured, sections: new Map(), storedNotes: new Map([['row-u', 'durable body']]),
    sessionId: 'sess-R',
  })[0].note, 'durable body');
  assert.equal(buildTurnNoteRows({
    turns: captured, sections: new Map([['1', 'incoming edit']]),
    storedNotes: new Map([['row-u', 'durable body']]), sessionId: 'sess-R',
  })[0].note, 'incoming edit');
});

// ── The three capture pins that need the real service ──────────────────────────

let ctx;
before(async () => { ctx = await bootTestServer({ sessionId: 'sess-capture' }); });
after(async () => { await ctx.teardown(); });

const serialize = (entries) => entries.map(e => JSON.stringify(e) + '\n').join('');
const writeEntries = (path, entries) => { writeFileSync(path, serialize(entries)); return path; };
const turnNotesRoot = () => join(ctx.stateDir, 'turn-notes');
const epochDirs = () => (existsSync(turnNotesRoot()) ? readdirSync(turnNotesRoot()) : []);

test('[delta] Turn Head sourceEntryId persists as anchor_uuid', async () => {
  // The head row's own identity, not a fold identity: the asking message's body row and its tool-use row
  // are different rows, and it is the tool-use row that the ratified Turn takes its identity from.
  const path = writeEntries(join(dirname(ctx.transcriptPath), 'anchor-delta.jsonl'), chain([
    userMessage({ uuid: 'ad-head', text: 'an ordinary ask', timestamp: ts(1) }),
    assistantObservation({ uuid: 'ad-body', messageId: 'ad-m', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'let me confirm' }] }),
    assistantToolUse({ uuid: 'ad-question', messageId: 'ad-m', toolUseId: 'ad-tu',
      name: 'AskUserQuestion', input: { questions: [] }, timestamp: ts(3) }),
    toolResult({ uuid: 'ad-answer', toolUseId: 'ad-tu', content: 'envelope', timestamp: ts(4),
      toolUseResult: { questions: [{ question: 'Q', header: 'H' }], answers: { Q: 'A' } } }),
    assistantObservation({ uuid: 'ad-after', messageId: 'ad-m2', timestamp: ts(5),
      blocks: [{ type: 'text', text: 'done' }] }),
    userMessage({ uuid: 'ad-cur', text: 'prepare the handoff', timestamp: ts(6) }),
  ]));
  ctx.switchSource(path);
  const { snapshot_id, notes_path } = ctx.turnService.getTurnSkeleton();
  const keys = [...readFileSync(notes_path, 'utf8').matchAll(/^## NOTE\[(\d+)\]$/gm)].map(m => m[1]);
  writeFileSync(notes_path, keys.map(k => `## NOTE[${k}]\n\nbody ${k}\n`).join('\n'));
  // The stored set belongs to the session every case here shares, so the identities are read as this
  // submission's own delta: every identity the store gained, naming no expected identity, so an extra row
  // still reddens.
  const identitiesBefore = new Set(ctx.store.listTurnNotes('sess-capture').map(r => r.anchorUuid));
  assert.deepEqual(await ctx.turnService.submitTurnNotes({ snapshot_id }), { committed: true });

  const stored = ctx.store.listTurnNotes('sess-capture')
    .map(r => r.anchorUuid).filter(uuid => !identitiesBefore.has(uuid)).sort();
  assert.deepEqual(stored, ['ad-head', 'ad-question']);
  // The fold's body row is NOT what persists, and neither is the answering row.
  assert.ok(!stored.includes('ad-body'));
  assert.ok(!stored.includes('ad-answer'));
  const ratified = ctx.store.listTurnNotes('sess-capture').find(r => r.anchorUuid === 'ad-question');
  assert.equal(ratified.sourceTimestamp, Date.parse(ts(3)), 'the question row supplies the time too');
});

test('[delta] malformed Turn Head fails before skeleton or notes files are written', async () => {
  // Two heads share one native identity, so the capture can never be persisted. The rejection lands
  // before any directory is created: a skeleton is an unredacted Turn History Projection, and one written
  // for a capture no submission can ever commit would sit on disk with nothing able to retire it.
  const path = writeEntries(join(dirname(ctx.transcriptPath), 'malformed-head.jsonl'), chain([
    userMessage({ uuid: 'dup-head', text: 'first ask', timestamp: ts(1) }),
    assistantObservation({ uuid: 'mh-a1', messageId: 'mh-m1', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'answer one' }] }),
    userMessage({ uuid: 'dup-head', text: 'second ask', timestamp: ts(3) }),
    assistantObservation({ uuid: 'mh-a2', messageId: 'mh-m2', timestamp: ts(4),
      blocks: [{ type: 'text', text: 'answer two' }] }),
    userMessage({ uuid: 'mh-cur', text: 'prepare the handoff', timestamp: ts(5) }),
  ]));
  ctx.switchSource(path);
  const before = epochDirs();
  assert.throws(() => ctx.turnService.getTurnSkeleton(), /identity/i);
  assert.deepEqual(epochDirs(), before, 'no epoch directory, no skeleton and no notes file were written');

  // The same fault on the submission side is still a snapshot rejection rather than a partial write.
  const rows = ctx.store.listTurnNotes('sess-capture');
  assert.deepEqual(await ctx.turnService.submitTurnNotes({ snapshot_id: 'whatever' }),
    { committed: false, error: 'stale_snapshot' });
  assert.deepEqual(ctx.store.listTurnNotes('sess-capture'), rows);

  // The gate's other branch, on the same side of the same writes: a head the Source could give no identity
  // at all. A human row is its own fold, so it reaches capture with the identity its own row carried and
  // nothing to fall back to.
  const headless = writeEntries(join(dirname(ctx.transcriptPath), 'headless-identity.jsonl'), chain([
    userMessage({ uuid: null, text: 'an ask with no identity', timestamp: ts(1) }),
    assistantObservation({ uuid: 'hi-a', messageId: 'hi-m', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'answered' }] }),
    userMessage({ uuid: 'hi-cur', text: 'prepare the handoff', timestamp: ts(3) }),
  ]));
  ctx.switchSource(headless);
  const captured = captureCurrentEpochTurns({
    observations: createClaudeCodeDialogueSource().read(headless).observations,
    dialogueProjection: createClaudeCodeDialogueProjection({ sessionCwd: ctx.cwd }),
  }).turns;
  assert.deepEqual(captured.map(t => t.sourceEntryId), [null],
    'fixture 自证：捕获里真的有一个没有 identity 的头');
  const beforeHeadless = epochDirs();
  assert.throws(() => ctx.turnService.getTurnSkeleton(), /identity/i);
  assert.deepEqual(epochDirs(), beforeHeadless);
});

test('current handoff Turn growth does not change the capture snapshot', async () => {
  const path = writeEntries(join(dirname(ctx.transcriptPath), 'growth.jsonl'), chain([
    userMessage({ uuid: 'gr-head', text: 'an ask', timestamp: ts(1) }),
    assistantObservation({ uuid: 'gr-a', messageId: 'gr-m', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'answered' }] }),
    userMessage({ uuid: 'gr-cur', text: 'prepare the handoff', timestamp: ts(3) }),
  ]));
  ctx.switchSource(path);
  const { snapshot_id, notes_path } = ctx.turnService.getTurnSkeleton();
  const keys = [...readFileSync(notes_path, 'utf8').matchAll(/^## NOTE\[(\d+)\]$/gm)].map(m => m[1]);
  writeFileSync(notes_path, keys.map(k => `## NOTE[${k}]\n\nbody ${k}\n`).join('\n'));
  // The asking Turn grows a whole tool pair while the producer writes notes.
  writeFileSync(path, readFileSync(path, 'utf8') + serialize(chain([
    { ...assistantToolUse({ uuid: 'gr-tool', messageId: 'gr-tm', toolUseId: 'gr-tu',
      name: 'Read', input: { file_path: 'lib/store.js' }, timestamp: ts(4) }), parentUuid: 'gr-cur' },
    toolResult({ uuid: 'gr-res', toolUseId: 'gr-tu', content: 'export const x = 1;' }),
  ])));
  assert.deepEqual(await ctx.turnService.submitTurnNotes({ snapshot_id }), { committed: true });
});
