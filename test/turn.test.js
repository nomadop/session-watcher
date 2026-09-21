// test/turn.test.js — shared Turn grouping, the Turn Head constructor, and the read projections.
// Every case drives `groupTurns` with a SYNTHETIC rule list: shared grouping sees a classification and a
// text and never a Harness vocabulary, so the rules here key on markers the fixtures write themselves.
// The Claude Code rules and their own behaviour live in test/claude-code.history-turn-rules.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSORB, PASS, activePathOrdinals, buildSkeleton, groupTurns, projectTurnRecord, slotKeysOf,
} from '../lib/turn.js';
import { enumerateDialogueLines, projectDialogue } from '../lib/dialogue-fold.js';
import {
  assistantObservation, assistantToolUse, chain, observationsOf, toolResult, ts, userMessage,
} from './helpers/transcript-fixtures.js';

// A synthetic composition, ordered the way a real one is: the visible-line rule first, the tool rule
// second. `ACK:` and `ABSORB:` prefixes stand in for whatever a Harness reads to reach those classes.
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

const linesOf = (entries) => enumerateDialogueLines(projectDialogue(observationsOf(entries)).folds);
const turnsOf = (entries) => groupTurns(linesOf(entries), RULES);

// U, A, an absorbed line, A, U — the shape that pins "every line after the first head lands in one span".
const spanEntries = chain([
  userMessage({ uuid: 'u1', text: '第一个问题', timestamp: ts(1) }),
  assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
    blocks: [{ type: 'text', text: '回答' }] }),
  userMessage({ uuid: 'i1', text: 'ABSORB:[Request interrupted by user]', timestamp: ts(3) }),
  assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(4),
    blocks: [{ type: 'text', text: '续答' }] }),
  userMessage({ uuid: 'u2', text: '第二个问题', timestamp: ts(5) }),
]);

// A head-less opening: the first row is an assistant one, which is what a current-epoch suffix looks like
// when the boundary cut lands mid-turn.
const preHeadEntries = chain([
  assistantObservation({ uuid: 'a0', messageId: 'm0', timestamp: ts(1),
    blocks: [{ type: 'text', text: '第一个 head U 之前的行' }] }),
  userMessage({ uuid: 'u1', text: '第一个问题', timestamp: ts(2) }),
  assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(3),
    blocks: [{ type: 'text', text: '回答' }] }),
]);

// ── Span grouping ──────────────────────────────────────────────────────────────

test('groupTurns: ABSORB 留在 span 内、不开 turn；第一个 head 之后每行恰好落一个 span', () => {
  const lines = linesOf(spanEntries);
  const turns = groupTurns(lines, RULES);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].lines.length, 4);
  assert.equal(turns.reduce((n, t) => n + t.lines.length, 0), lines.length);
});

test('groupTurns: 第一个 head 之前的行不落任何 span —— 不为它造 identity', () => {
  const lines = linesOf(preHeadEntries);
  assert.equal(lines.length, 3);
  const turns = groupTurns(lines, RULES);
  assert.equal(turns.length, 1);
  assert.equal(turns.reduce((n, t) => n + t.lines.length, 0), lines.length - 1);
  assert.ok(!turns.some(t => t.lines.some(l => l.sourceEntryId === 'a0')),
    '被丢的行不得出现在任何 span 里');
  assert.ok(!turns.some(t => t.sourceEntryId === 'a0'), '被丢的行不得成为任何 turn 的持久化 identity');
});

test('groupTurns: 真 note-less 由 hasAssistantActivity=false 标记（无可见 A 且无工具）', () => {
  const turns = turnsOf([userMessage({ uuid: 'c1', text: '/clear', timestamp: ts(1) })]);
  assert.equal(turns[0].hasAssistantActivity, false);
});

test('groupTurns: 一条工具行让当前 turn 记上 assistant 活动', () => {
  const turns = turnsOf(chain([
    userMessage({ uuid: 'u1', text: '跑一下', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'a1', messageId: 'm1', toolUseId: 'tu1', name: 'Bash',
      input: { command: 'ls' }, timestamp: ts(2) }),
    toolResult({ uuid: 'r1', toolUseId: 'tu1', content: 'ok' }),
  ]));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].hasAssistantActivity, true);
});

// ── The Turn Head constructor ──────────────────────────────────────────────────

test('Turn Head: 三个 source fact 全部取自胜出那一行，text 取自规则', () => {
  const turns = turnsOf(chain([
    userMessage({ uuid: 'head-row', text: '第一个问题', timestamp: ts(4) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(5),
      blocks: [{ type: 'text', text: '回答' }] }),
  ]));
  assert.deepEqual(
    [turns[0].sourceOrdinal, turns[0].sourceEntryId, turns[0].timestamp, turns[0].cleanedU],
    [1, 'head-row', Date.parse(ts(4)), '第一个问题'],
  );
});

test('Turn Head: 工具行开出的 turn 同样整套取自那一行，与它的 fold 无关', () => {
  const turns = turnsOf(chain([
    userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
    assistantObservation({ uuid: 'body-row', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '先说一句' }] }),
    assistantToolUse({ uuid: 'tool-row', messageId: 'm1', toolUseId: 'tu1', name: 'Ratify',
      input: {}, timestamp: ts(3) }),
    toolResult({ uuid: 'result-row', toolUseId: 'tu1', content: '裁定文本', timestamp: ts(9) }),
  ]));
  const ratified = turns[1];
  assert.deepEqual(
    [ratified.sourceOrdinal, ratified.sourceEntryId, ratified.timestamp, ratified.cleanedU],
    [3, 'tool-row', Date.parse(ts(3)), '裁定文本'],
  );
});

test('Turn Head: 规则只给分类与文本 —— 一个只回 text 的规则不能改任何 source fact', () => {
  const lines = linesOf([userMessage({ uuid: 'only-row', text: '问', timestamp: ts(2) })]);
  const [turn] = groupTurns(lines, [() => ({
    kind: 'HEAD', text: 'projected', sourceOrdinal: 999, sourceEntryId: 'invented', timestamp: 1,
  })]);
  assert.equal(turn.cleanedU, 'projected');
  assert.deepEqual([turn.sourceOrdinal, turn.sourceEntryId, turn.timestamp],
    [1, 'only-row', Date.parse(ts(2))]);
});

test('Turn Head: 没有 identity 或时间的行照旧开 turn —— 只有捕获才要求它们', () => {
  const [turn] = groupTurns(linesOf([
    userMessage({ uuid: null, text: '问', timestamp: 'not-a-timestamp' }),
  ]), RULES);
  assert.equal(turn.sourceEntryId, null);
  assert.equal(turn.timestamp, null);
  assert.equal(turn.cleanedU, '问');
});

// ── ACK ────────────────────────────────────────────────────────────────────────

// One synthetic-ACK seam case: the classification, not any Harness echo, is what closes the slot.
test('ACK turn 保留全部行与 Turn Record，但不积累 assistant 活动、也不出骨架槽', () => {
  const turns = turnsOf(chain([
    userMessage({ uuid: 'u1', text: '干活', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '做完了' }] }),
    userMessage({ uuid: 'ack', text: 'ACK:/exit', timestamp: ts(3) }),
    userMessage({ uuid: 'out', text: 'ABSORB:Catch you later!', timestamp: ts(4) }),
    assistantObservation({ uuid: 'a2', messageId: 'm2', timestamp: ts(5),
      blocks: [{ type: 'text', text: 'No response requested.' }] }),
    userMessage({ uuid: 'u2', text: '接着干', timestamp: ts(6) }),
    assistantObservation({ uuid: 'a3', messageId: 'm3', timestamp: ts(7),
      blocks: [{ type: 'text', text: 'ok' }] }),
  ]));
  assert.deepEqual(turns.map(t => t.classification), ['HEAD', 'ACK', 'HEAD']);
  assert.deepEqual(turns.map(t => t.hasAssistantActivity), [true, false, true]);
  // Its lines are all retained, so a Turn Record and a skeleton block still exist for it.
  assert.deepEqual(turns[1].lines.map(l => l.sourceEntryId), ['ack', 'out', 'a2']);
  assert.equal(turns[1].cleanedU, '/exit');
  // No slot at all, and the two real turns on either side keep theirs.
  assert.deepEqual(slotKeysOf(turns), ['1', '6']);
  const skeleton = buildSkeleton(turns, 'sess-A');
  assert.ok(skeleton.includes('Catch you later!'), 'the absorbed line is still visible to a producer');
  assert.ok(skeleton.includes('No response requested.'));
  assert.deepEqual(skeleton.match(/NOTE\[\d+\]: ____/g), ['NOTE[1]: ____', 'NOTE[6]: ____']);
});

// ── Read projections ───────────────────────────────────────────────────────────

test('projectTurnRecord: NULL note ⇒ 键不出现；截断态由字符数之差派生', () => {
  const row = { anchorUuid: 'u1', uText: 'abc', uOriginalChars: 12, note: null };
  const out = projectTurnRecord(row, new Map([['u1', 7]]));
  assert.deepEqual(out, { t: 7, u: 'abc [truncated; 12 chars]' });
  assert.equal('note' in out, false);
});

// t 为 null 只代表「没有可读 Source 可定位」，即 `CONTEXT.md` Unverified Turn Record 的空 T 地址。
// identity 不在一张非空 map 里是废弃 turn，由调用方排除 —— 所以这里只测无 map 与空 map 两种缺失形态。
test('projectTurnRecord: Source 缺失（无 ordinals / 空 map）⇒ t 为 null，note 原样带出', () => {
  const row = { anchorUuid: 'u1', uText: 'abc', uOriginalChars: 3, note: '记录' };
  assert.deepEqual(projectTurnRecord(row, null), { t: null, u: 'abc', note: '记录' });
  assert.equal(projectTurnRecord(row, new Map()).t, null);
});

test('projectTurnRecord: 缺失由 map 里有没有这个 identity 决定，不由 t 的真假值决定', () => {
  const row = { anchorUuid: 'u1', uText: 'abc', uOriginalChars: 3, note: null };
  assert.equal(projectTurnRecord(row, new Map([['u1', 0]])).t, 0);
});

test('activePathOrdinals: turn 头的 sourceEntryId → 该 turn 的 source ordinal；非头行不可查', () => {
  const ordinals = activePathOrdinals(turnsOf(chain([
    userMessage({ uuid: 'u1', text: '问', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '答' }] }),
  ])));
  assert.equal(ordinals.get('u1'), 1);
  assert.equal(ordinals.get('a1'), undefined);
});

test('activePathOrdinals: 裁定 turn 的 ordinal 与 groupTurns 同源 —— 提问行，不是 fold 文本行', () => {
  const turns = turnsOf(chain([
    userMessage({ uuid: 'u1', text: '开始', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(2),
      blocks: [{ type: 'text', text: '先确认一件事' }] }),
    assistantToolUse({ uuid: 'ask1', messageId: 'm1', toolUseId: 'tu1', name: 'Ratify',
      input: {}, timestamp: ts(3) }),
    toolResult({ uuid: 'ans1', toolUseId: 'tu1', content: '裁定', timestamp: ts(9) }),
  ]));
  const ordinals = activePathOrdinals(turns);
  const ratified = turns.find(turn => turn.cleanedU === '裁定');
  assert.equal(ordinals.get('ask1'), ratified.sourceOrdinal);
  assert.equal(ordinals.get('ask1'), 3);
});

test('activePathOrdinals: 无 identity 的头不进 map，重复 identity 首次胜出', () => {
  const ordinals = activePathOrdinals([
    { sourceEntryId: null, sourceOrdinal: 1 },
    { sourceEntryId: 'dup', sourceOrdinal: 2 },
    { sourceEntryId: 'dup', sourceOrdinal: 9 },
  ]);
  assert.equal(ordinals.size, 1);
  assert.equal(ordinals.get('dup'), 2);
});
