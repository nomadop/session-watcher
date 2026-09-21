// test/server.turn.test.js — 生产捕获边界：骨架、snapshot 身份、原子提交。
// 两个入口共用一条确定性捕获路径（Source 读取 → 当前 epoch 后缀 → 分组 → 去掉当前 handoff turn），
// 所以这里的 fixture 全部按物理行号断言，不按数组下标。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootTestServer } from './helpers/server-boot.js';
import { parseNoteSections, readHistorySource, slotKeysOf, snapshotDigest } from '../lib/turn.js';
import { captureCurrentEpochTurns } from '../lib/turn-note.js';
import { createClaudeCodeDialogueSource } from '../lib/harness/claude-code/dialogue-source.js';
import { createClaudeCodeDialogueProjection } from '../lib/harness/claude-code/history-turn-rules.js';
import { sweepStaleTurnNotes } from '../lib/state-reaper.js';
import {
  userMessage, assistantObservation, assistantToolUse, toolResult, compactSummary, ts, usage,
  writeTranscript,
} from './helpers/transcript-fixtures.js';
import { _seedDeliveredHandoff } from './helpers/handoff-seed.js';

const SESSION_ID = 'sess-A';
// 当前 handoff turn 的活跃 leaf：增长测试往它下面挂完整 tool pair，boundary 测试往它下面挂新用户消息。
const currentHandoffLeafUuid = 'u-cur';
// 头 U 故意超过 U_TEXT_TOKENS：250 个 CJK 字，DEFAULT_CTP cjk=1.0 ⇒ 250 tok。这样落库时 storedUText
// 的 200-token 反解真的动过手，而不是对一条十几字的短句做恒等变换。
const LONG_HEAD_U = '一二三四五六七八九十'.repeat(25);

// 物理行依次是：头 U、assistant 正文 + 它的工具行、tool_result（不产出对话行）、打断（被吸收）、
// assistant 正文、`/model` 与 `/clear` 各自的裸命令 turn（皆真 note-less）、当前 handoff turn。捕获
// 去掉末尾那个 handoff turn 后，剩下的 turn 里只有头 U 那个带 assistant 活动 ⇒ 全篇只有它落 NOTE 槽。
const baseEntries = ({ dropTimestamp = false } = {}) => [
  userMessage({ uuid: 'u-one', parentUuid: null, text: LONG_HEAD_U, timestamp: ts(1) }),
  assistantToolUse({ uuid: 'a-one', parentUuid: 'u-one', messageId: 'm-one', toolUseId: 'tok-one',
    name: 'Read', input: { file_path: 'lib/store.js' }, timestamp: ts(2), text: 'working on it' }),
  toolResult({ uuid: 'r-one', parentUuid: 'a-one', toolUseId: 'tok-one', content: 'export const x = 1;' }),
  userMessage({ uuid: 'u-int', parentUuid: 'r-one', text: '[Request interrupted by user]', timestamp: ts(3) }),
  assistantObservation({ uuid: 'a-two', parentUuid: 'u-int', messageId: 'm-two', timestamp: ts(4),
    blocks: [{ type: 'text', text: 'resumed' }] }),
  userMessage({ uuid: 'u-cmd', parentUuid: 'a-two', timestamp: dropTimestamp ? undefined : ts(5),
    text: '<command-name>/model</command-name><command-args>opus</command-args>' }),
  userMessage({ uuid: 'u-clr', parentUuid: 'u-cmd', text: '<command-name>/clear</command-name>', timestamp: ts(6) }),
  userMessage({ uuid: currentHandoffLeafUuid, parentUuid: 'u-clr', text: 'prepare the handoff', timestamp: ts(7) }),
];

// compact summary 之后的头 U 自成一行：捕获只取最新 epoch，但 T 是它在整个文件里的行号，不随 epoch
// 重新起编。
// The pre-compact call carries usage because that is what a compact replaces, and a root with no call
// behind it is session-start preamble rather than a boundary.
const compactEntries = () => [
  userMessage({ uuid: 'u-pre', parentUuid: null, text: 'pre-compact-u', timestamp: ts(1) }),
  assistantObservation({ uuid: 'a-pre', parentUuid: 'u-pre', messageId: 'm-pre', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'pre-compact-a' }], usage: usage({ input: 2, output: 5, cacheRead: 10_000 }) }),
  compactSummary({ uuid: 'c-sum', timestamp: ts(3), text: 'summary of the epoch' }),
  userMessage({ uuid: 'u-post', parentUuid: 'c-sum', text: 'post-compact-u', timestamp: ts(4) }),
  assistantObservation({ uuid: 'a-post', parentUuid: 'u-post', messageId: 'm-post', timestamp: ts(5),
    blocks: [{ type: 'text', text: 'post-compact-a' }] }),
  userMessage({ uuid: 'u-cur2', parentUuid: 'a-post', text: 'current-handoff-u', timestamp: ts(6) }),
];

// 两条可见 U 共用同一 uuid：活跃路径与成员判据都只认 uuid，重复 anchor 只告警不丢弃，所以两个
// turn 都活着并带进 snapshot —— 落库前必须整组拒绝。
const duplicateEntries = () => [
  userMessage({ uuid: 'u-dup', parentUuid: null, text: 'dup-first', timestamp: ts(1) }),
  assistantObservation({ uuid: 'a-dup-one', parentUuid: 'u-dup', messageId: 'm-dup-one', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'answer one' }] }),
  userMessage({ uuid: 'u-dup', parentUuid: 'a-dup-one', text: 'dup-second', timestamp: ts(3) }),
  assistantObservation({ uuid: 'a-dup-two', parentUuid: 'u-dup', messageId: 'm-dup-two', timestamp: ts(4),
    blocks: [{ type: 'text', text: 'answer two' }] }),
  userMessage({ uuid: 'u-cur3', parentUuid: 'a-dup-two', text: 'prepare the handoff', timestamp: ts(5) }),
];

// 一段从未提交过的转录：库里没有它任何一个 anchor 的行。覆盖率由「文件给出这一段」或「库里已经有那
// 一行」成立，所以只有在这样一段捕获上，「文件缺这一段」才仍然只能是 missing note —— 这一侧的用例
// 因此跑在它上面，而不是跑在共享转录那个早就落过库的 epoch 上。
const uncommittedEntries = () => [
  userMessage({ uuid: 'u-unc', parentUuid: null, text: 'an ask nobody has committed', timestamp: ts(1) }),
  assistantObservation({ uuid: 'a-unc', parentUuid: 'u-unc', messageId: 'm-unc', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'answered' }] }),
  userMessage({ uuid: 'u-cur-unc', parentUuid: 'a-unc', text: 'prepare the handoff', timestamp: ts(3) }),
];

// `/exit` 三件套写进 CC 即将丢弃的那个文件；`claude -c` resume 回同一个文件后，CC 补一条 assistant
// 「No response requested.」parent 到 stdout 行上。物理行依次是：头 U、assistant、caveat（吸收）、
// `/exit` 回显、stdout（吸收）、那条 assistant、resume 后的头 U、assistant、当前 handoff turn。捕获
// 去掉末尾那个 handoff turn 后，`/exit` 那个 turn 必须不带槽却仍落一行。
const exitEchoEntries = () => [
  userMessage({ uuid: 'xu-work', parentUuid: null, text: 'deploy 完了，重启一下', timestamp: ts(1) }),
  assistantObservation({ uuid: 'xa-work', parentUuid: 'xu-work', messageId: 'xm-work', timestamp: ts(2),
    blocks: [{ type: 'text', text: 'deployed' }] }),
  userMessage({ uuid: 'xu-cav', parentUuid: 'xa-work', timestamp: ts(3),
    text: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>' }),
  userMessage({ uuid: 'xu-exit', parentUuid: 'xu-cav', timestamp: ts(4),
    text: '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>' }),
  userMessage({ uuid: 'xu-bye', parentUuid: 'xu-exit', timestamp: ts(5),
    text: '<local-command-stdout>Catch you later!</local-command-stdout>' }),
  assistantObservation({ uuid: 'xa-bye', parentUuid: 'xu-bye', messageId: 'xm-bye', timestamp: ts(6),
    blocks: [{ type: 'text', text: 'No response requested.' }] }),
  userMessage({ uuid: 'xu-resumed', parentUuid: 'xa-bye', text: 'resume 之后接着干', timestamp: ts(7) }),
  assistantObservation({ uuid: 'xa-resumed', parentUuid: 'xu-resumed', messageId: 'xm-resumed',
    timestamp: ts(8), blocks: [{ type: 'text', text: 'ok' }] }),
  userMessage({ uuid: 'xu-cur', parentUuid: 'xa-resumed', text: 'prepare the handoff', timestamp: ts(9) }),
];

const serialize = (entries) => entries.map(e => JSON.stringify(e) + '\n').join('');
const writeEntries = (path, entries) => { writeFileSync(path, serialize(entries)); return path; };
const appendTranscriptEntries = (path, entries) => appendFileSync(path, serialize(entries));
const appendUserMessage = (path, text) => appendTranscriptEntries(path, [
  userMessage({ uuid: 'u-next', parentUuid: currentHandoffLeafUuid, text, timestamp: ts(9) }),
]);

// 测试侧对捕获路径的独立复算 —— 只用来算「应该有几行/哪个 turn 是 note-less/该填哪些槽」，不参与断言的产物。
const dialogueSource = createClaudeCodeDialogueSource();
// The Adapter resolves a relative tool path against the session directory, and the snapshot digest covers
// the key it attaches — so the recomputation has to be bound to the same directory the server is.
const projectionFor = (cwd) => createClaudeCodeDialogueProjection({ sessionCwd: cwd });
const capture = (path, cwd) => captureCurrentEpochTurns({
  observations: dialogueSource.read(path).observations, dialogueProjection: projectionFor(cwd),
}).turns;

// 服务端预写的空标题清单就是槽清单 —— 测试不从骨架反推槽键，读它写好的那份文件。
const headingKeysOf = (notesPath) =>
  [...readFileSync(notesPath, 'utf8').matchAll(/^## NOTE\[(\d+)\]$/gm)].map(m => m[1]);

// 生产者那一次 Write：每段标题下填正文，标题行原样保留。槽清单可以由调用方给出 —— 预填回来的正文里
// 可能有一行长得像标题（一个 rewind 留下的孤儿段就是这样落库的），从文件里扫标题会把它当成一个槽。
const fillNotes = (notesPath, body = () => 'note', keys = headingKeysOf(notesPath)) => {
  writeFileSync(notesPath, keys.map(k => `## NOTE[${k}]\n\n${body(k)}\n`).join('\n'));
  return keys;
};

let ctx, store, svc, sessionId, transcriptPath, turns, headT;
let currentTurnGrowthPath, staleBoundaryPath, compactCapturePath, missingTimestampPath, duplicateAnchorPath;
let uncommittedPath;

// 取骨架 + 填满每一段，即提交前的完整生产者动作。每个用例各做一次：提交成功会删掉两文件，所以
// 共享一份「已填好的文件」会让用例顺序变成隐性依赖。
const produce = ({ body } = {}) => {
  const captured = svc.getTurnSkeleton();
  const keys = slotKeysOf(capture(currentSourcePath, ctx.cwd));
  return { ...captured, keys: fillNotes(captured.notes_path, body, keys) };
};

// Repoint the Source through the only Interface that moves it. A `replace` with no batches swaps the
// locator and installs fresh measurement state; the Turn Note capture re-reads the file itself, so the
// locator is all this needs to change.
let transcriptDir;
let currentSourcePath;
const useTranscript = (path) => { ctx.switchSource(path); currentSourcePath = path; transcriptDir = dirname(path); };

before(async () => {
  ctx = await bootTestServer({ sessionId: SESSION_ID });
  store = ctx.store;
  svc = ctx.turnService;
  sessionId = ctx.sessionId;
  transcriptPath = ctx.transcriptPath;
  currentSourcePath = transcriptPath;
  const dir = dirname(transcriptPath);
  transcriptDir = dir;

  writeEntries(transcriptPath, baseEntries());
  currentTurnGrowthPath = writeEntries(join(dir, 'growth.jsonl'), baseEntries());
  staleBoundaryPath = writeEntries(join(dir, 'stale.jsonl'), baseEntries());
  missingTimestampPath = writeEntries(join(dir, 'missing-ts.jsonl'), baseEntries({ dropTimestamp: true }));
  compactCapturePath = writeEntries(join(dir, 'compact.jsonl'), compactEntries());
  duplicateAnchorPath = writeEntries(join(dir, 'duplicate.jsonl'), duplicateEntries());
  uncommittedPath = writeEntries(join(dir, 'uncommitted.jsonl'), uncommittedEntries());

  turns = capture(transcriptPath, ctx.cwd);
  headT = turns[0].sourceOrdinal;
});

after(async () => { await ctx.teardown(); });

test('get_turn_skeleton 成功形状：snapshot_id + 两个路径 + 协议句，两文件真的落在 state dir', () => {
  const res = svc.getTurnSkeleton();
  assert.deepEqual(Object.keys(res).sort(), ['notes_path', 'protocol', 'skeleton_path', 'snapshot_id']);
  // FORMAT, not just presence — a sha256 digest in lowercase hex, so the field cannot turn into another
  // shape unnoticed.
  assert.match(res.snapshot_id, /^[0-9a-f]{64}$/, 'the fingerprint is a lowercase sha256 hex digest');
  // And determinism: the same capture re-fetched mints the same fingerprint.
  assert.equal(svc.getTurnSkeleton().snapshot_id, res.snapshot_id, 'the same capture digests identically');
  assert.ok(res.protocol.length > 0);
  // 路径由服务端从 state dir + Context Epoch 键（捕获 session + 本 epoch 首个 anchor）自推。
  const epochDir = join(ctx.stateDir, 'turn-notes', `${sessionId}-${turns[0].sourceEntryId}`);
  assert.equal(res.skeleton_path, join(epochDir, 'skeleton.txt'));
  assert.equal(res.notes_path, join(epochDir, 'notes.md'));
  // 骨架不再随回复内联，它在那份文件里。
  assert.match(readFileSync(res.skeleton_path, 'utf8'), /^CONTEXT EPOCH {2}session /);
  // notes 文件是服务端预写的空标题清单 —— 槽由它承载，producer 不发明格式。
  assert.equal(readFileSync(res.notes_path, 'utf8'), `## NOTE[${headT}]\n`);
});

test('重取：已写正文原样存活，新出现的槽在末尾补标题', (t) => {
  t.after(() => writeEntries(transcriptPath, baseEntries()));   // 共享 fixture，失败也要复原
  const first = produce({ body: () => 'kept body' });
  appendTranscriptEntries(transcriptPath, [
    userMessage({ uuid: 'u-grew', parentUuid: currentHandoffLeafUuid, text: 'a further ask', timestamp: ts(20) }),
    assistantObservation({ uuid: 'a-grew', parentUuid: 'u-grew', messageId: 'm-grew', timestamp: ts(21),
      blocks: [{ type: 'text', text: 'answered the further ask' }] }),
    userMessage({ uuid: 'u-cur-b', parentUuid: 'a-grew', text: 'prepare the handoff', timestamp: ts(22) }),
  ]);
  const again = svc.getTurnSkeleton();
  assert.equal(again.notes_path, first.notes_path, 'epoch 键不随 turn 增长改变，所以撞的是同一份文件');
  const grown = readFileSync(again.notes_path, 'utf8');
  const grownKeys = slotKeysOf(capture(transcriptPath, ctx.cwd));
  const { sections } = parseNoteSections(grown, grownKeys);
  assert.equal(sections.get(String(headT)), 'kept body');
  const newKey = grownKeys.find(key => key !== String(headT));
  assert.equal(sections.get(newKey), '', '新槽有标题、无正文');
  assert.ok(grown.trimEnd().endsWith(`## NOTE[${newKey}]`), '追加在末尾 —— 已有内容不被重排');
  // 骨架整份重写：它全是服务端产物，落后一版就会让 producer 去给一个骨架里没有的 turn 写 note。
  const skeleton = readFileSync(again.skeleton_path, 'utf8');
  assert.match(skeleton, new RegExp(`^ +\\| NOTE\\[${newKey}\\]: ____$`, 'm'));
  assert.equal((skeleton.match(/NOTE\[\d+\]: ____/g) || []).length, grownKeys.length);
});

test('重取：已有文件没有末尾换行时，新标题仍独占一行', (t) => {
  t.after(() => writeEntries(transcriptPath, baseEntries()));
  const { notes_path } = svc.getTurnSkeleton();
  writeFileSync(notes_path, `## NOTE[${headT}]\n\nbody without a trailing newline`);
  appendTranscriptEntries(transcriptPath, [
    userMessage({ uuid: 'u-nl', parentUuid: currentHandoffLeafUuid, text: 'one more ask', timestamp: ts(30) }),
    assistantObservation({ uuid: 'a-nl', parentUuid: 'u-nl', messageId: 'm-nl', timestamp: ts(31),
      blocks: [{ type: 'text', text: 'answered' }] }),
    userMessage({ uuid: 'u-cur-c', parentUuid: 'a-nl', text: 'prepare the handoff', timestamp: ts(32) }),
  ]);
  const grownKeys = slotKeysOf(capture(transcriptPath, ctx.cwd));
  const { sections } = parseNoteSections(readFileSync(svc.getTurnSkeleton().notes_path, 'utf8'), grownKeys);
  const newKey = grownKeys.find(key => key !== String(headT));
  assert.equal(sections.get(String(headT)), 'body without a trailing newline');
  assert.equal(sections.get(newKey), '', '标题黏在正文尾部就再也解析不出这个槽');
});

test('重取：notes 路径读不出内容（非 ENOENT）→ 报错，绝不当成「还没有文件」把它重写掉', (t) => {
  const { notes_path } = svc.getTurnSkeleton();
  rmSync(notes_path);
  mkdirSync(notes_path);                       // 任何 uid 下 readFileSync 都会 EISDIR
  t.after(() => rmSync(notes_path, { recursive: true }));
  assert.throws(() => svc.getTurnSkeleton(), /cannot be read/i);
  assert.ok(existsSync(notes_path), '读不到就不动它 —— 那份正文不是服务端写的');
});

test('epoch 键里的 anchor 也过文件名净化：越界 uuid 不把路径带出 state dir', (t) => {
  const escapeUuid = '../../../../../../tmp/sw-escape';
  const evilPath = writeEntries(join(dirname(transcriptPath), 'evil-anchor.jsonl'), [
    userMessage({ uuid: escapeUuid, parentUuid: null, text: 'an ask', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a-evil', parentUuid: escapeUuid, messageId: 'm-evil', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'answered' }] }),
    userMessage({ uuid: 'u-cur-evil', parentUuid: 'a-evil', text: 'prepare the handoff', timestamp: ts(3) }),
  ]);
  useTranscript(evilPath);
  t.after(() => useTranscript(transcriptPath));
  const { skeleton_path, notes_path } = svc.getTurnSkeleton();
  // 提交成功会对这个目录做 recursive rmSync，所以它必须留在 state dir 里面。
  const root = join(ctx.stateDir, 'turn-notes') + '/';
  assert.ok(skeleton_path.startsWith(root) && notes_path.startsWith(root), skeleton_path);
  assert.ok(!skeleton_path.includes('..'));
});

test('submit：标题在、正文空 → missing note（预写标题的全部意义所在）', async () => {
  const { snapshot_id } = svc.getTurnSkeleton();     // 服务端刚写好空标题清单，没人填
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.equal(res.error, 'invalid_notes');
  assert.deepEqual(res.issues, [{ t: headT, message: 'missing note for this NOTE slot' }]);
});

test('submit：同一 T 两个标题段 → invalid_notes，解析期的 issue 真的上了线', async () => {
  const { snapshot_id, notes_path } = svc.getTurnSkeleton();
  writeFileSync(notes_path, `## NOTE[${headT}]\n\nfirst body\n\n## NOTE[${headT}]\n\nsecond body\n`);
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.equal(res.error, 'invalid_notes');
  assert.deepEqual(res.issues, [{ t: headT, message: 'duplicate NOTE section for this T' }]);
  assert.ok(!store.listTurnNotes(sessionId).some(r => r.note === 'second body'));
});

test('submit：一段都没写 → invalid_notes 且 DB 零写入', async () => {
  const { snapshot_id, notes_path } = svc.getTurnSkeleton();
  writeFileSync(notes_path, '');
  const beforeRows = store.listTurnNotes(sessionId);
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.equal(res.committed, false);
  assert.equal(res.error, 'invalid_notes');
  assert.ok(res.issues.every(i => Number.isInteger(i.t)));
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
});

// 校验是覆盖率而不是对应关系：本轮每个槽都给了就通过,文件里还有什么都不拒。拒它曾造出唯一一类「写
// note 无法清除」的 invalid_notes —— rewind 把一个 turn 从活跃路径上拿掉而 epoch 键不变,孤儿段就留在
// 同一份文件里,而文件对 server 只追加,于是该 epoch 之后每次 handoff 都撞同一个拒绝。
// 而「忽略」是彻底的:非槽标题连段都不是,所以它既拒不掉也进不了库 —— 它成为前一段正文的一部分,可见、
// 可改、不丢字节。
test('submit：捕获里没有的槽号不是分隔符 —— 它留在正文里,覆盖率照旧成立', async () => {
  const { snapshot_id, notes_path } = produce({ body: (k) => `coverage body ${k}` });
  appendFileSync(notes_path, '\n## NOTE[999999]\n\nan orphan a rewind left behind\n');
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
  const notes = store.listTurnNotes(sessionId).map(r => r.note);
  assert.ok(!notes.includes('an orphan a rewind left behind'), '孤儿不单独落一行');
  const carrier = notes.find(n => n?.startsWith(`coverage body ${headT}`));
  assert.ok(carrier.includes('## NOTE[999999]'), '孤儿标题成了正文,一个字节都没丢');
  assert.ok(carrier.endsWith('an orphan a rewind left behind'));
});

// 写路径也只认槽。一个落在 note-less turn 的 T 上的标题不切段,所以那个 turn 的行仍是 null ——
// `CONTEXT.md` Turn Record 要的正是「including a truly note-less turn whose note is null」。
test('submit：note-less turn 的 T 上发明的标题不会给它落一条 note', async () => {
  const noteless = capture(transcriptPath, ctx.cwd).find(turn => !turn.hasAssistantActivity);
  const { snapshot_id, notes_path } = produce({ body: (k) => `real body ${k}` });
  appendFileSync(notes_path, `\n## NOTE[${noteless.t}]\n\nINVENTED\n`);
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
  const row = store.listTurnNotes(sessionId).find(r => r.anchorUuid === noteless.sourceEntryId);
  assert.equal(row.note, null, 'note-less turn 的 note 必须是 null');
});

// 失败的 fetch 不得刷新任何 mtime。sweepStaleTurnNotes 按目录内最新 mtime 判龄,所以「先写骨架再读
// notes」的顺序会让一个已超龄的目录在每次失败重试后重新变年轻 —— 未脱敏骨架就永远清不掉。
test('重取失败不刷新 mtime —— 超龄目录在读失败之后仍清得掉', (t) => {
  const { skeleton_path, notes_path } = svc.getTurnSkeleton();
  const epochDir = dirname(notes_path);
  t.after(() => rmSync(epochDir, { recursive: true, force: true }));
  rmSync(notes_path);
  mkdirSync(notes_path);                       // 任何 uid 下 readFileSync 都会 EISDIR
  const old = new Date(Date.now() - 30 * 86400000);
  for (const p of [skeleton_path, notes_path, epochDir]) utimesSync(p, old, old);
  assert.throws(() => svc.getTurnSkeleton(), /cannot be read/i);
  assert.equal(sweepStaleTurnNotes(ctx.stateDir), 1, '读失败把目录变年轻了');
  assert.equal(existsSync(epochDir), false);
});

// 首个用户消息就是 handoff 请求 ⇒ 捕获去掉当前 turn 后一个都不剩。目录名落在 `-empty` 兜底上,提交是
// 成功的零行:一个没有已闭合 turn 的 epoch 没有什么可记。
test('零 turn 捕获：目录名用 empty 兜底,提交成功且落零行', async (t) => {
  const onlyCurrentPath = writeEntries(join(dirname(transcriptPath), 'only-current.jsonl'), [
    userMessage({ uuid: 'u-only', parentUuid: null, text: 'prepare the handoff', timestamp: ts(1) }),
  ]);
  useTranscript(onlyCurrentPath);
  t.after(() => useTranscript(transcriptPath));
  const res = svc.getTurnSkeleton();
  assert.equal(res.notes_path, join(ctx.stateDir, 'turn-notes', `${sessionId}-empty`, 'notes.md'));
  assert.equal(readFileSync(res.notes_path, 'utf8'), '');
  const beforeRows = store.listTurnNotes(sessionId);
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id: res.snapshot_id }), { committed: true });
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows, '零 turn 落零行');
});

test('submit：notes 文件不存在 → invalid_notes（不是崩溃，也不是成功零 note）', async (t) => {
  useTranscript(uncommittedPath);            // 库里没有这一段的行，缺段才只能是 missing note
  t.after(() => useTranscript(transcriptPath));
  const [slotKey] = slotKeysOf(capture(uncommittedPath, ctx.cwd));
  const { snapshot_id, notes_path } = svc.getTurnSkeleton();
  rmSync(notes_path);
  const beforeRows = store.listTurnNotes(sessionId);
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.equal(res.error, 'invalid_notes');
  assert.deepEqual(res.issues.map(i => i.t), [Number(slotKey)]);
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
});

test('submit：分隔符严格是 `## ` —— `###` 写出来的段不算填了那个槽', async (t) => {
  useTranscript(uncommittedPath);
  t.after(() => useTranscript(transcriptPath));
  const [slotKey] = slotKeysOf(capture(uncommittedPath, ctx.cwd));
  const { snapshot_id, notes_path } = svc.getTurnSkeleton();
  writeFileSync(notes_path, `### NOTE[${slotKey}]\n\na note under the wrong heading level\n`);
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.equal(res.error, 'invalid_notes');
  assert.deepEqual(res.issues, [{ t: Number(slotKey), message: 'missing note for this NOTE slot' }]);
});

test('submit：note 取整 token > 800 → invalid_notes 且绝不截断', async () => {
  const { snapshot_id } = produce({ body: () => '中'.repeat(1000) });   // DEFAULT_CTP cjk=1.0 ⇒ 约 1000 tok
  const beforeRows = store.listTurnNotes(sessionId);
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.equal(res.committed, false);
  assert.equal(res.error, 'invalid_notes');
  assert.deepEqual(res.issues.map(i => i.t), [headT]);
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
});

test('submit：boundary 前移（新用户消息到达）→ stale_snapshot、零写入', async (t) => {
  useTranscript(staleBoundaryPath);
  t.after(() => useTranscript(transcriptPath));
  const { snapshot_id } = produce();
  const beforeRows = store.listTurnNotes(sessionId);
  appendUserMessage(staleBoundaryPath, 'a new instruction');
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.deepEqual(res, { committed: false, error: 'stale_snapshot' });
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
});

// snapshot_id 是同版本内的握手凭证：取回时铸造，提交时重新校验，没有任何消费者跨版本比较它 —— 等价性
// 工具因此把它投影成固定占位符（`VOLATILE_MCP_POSITIONS.mcpTurnSkeleton`）。这条守卫钉住占位符没有连带
// 放过握手的否定分支：正文已经填好，所以唯一挡得下提交的就是身份本身，三种坏凭证都必须落 stale_snapshot
// 且一行不写。缺失与畸形不各自成类：能提交的身份只有一个值，其余一切都不是它。
test('submit：缺失、畸形、以及格式合法但非本次捕获的 snapshot_id 都被拒，且零写入', async () => {
  const { snapshot_id } = produce();
  const beforeRows = store.listTurnNotes(sessionId);
  const rejected = [
    undefined,            // 缺失：调用方根本没带
    'not-a-digest',       // 畸形：不是摘要的形状
    'f'.repeat(64),       // 形状合法的 64 位十六进制，但不是这次捕获的摘要
  ];
  for (const candidate of rejected) {
    const res = await svc.submitTurnNotes({ snapshot_id: candidate });
    assert.deepEqual(res, { committed: false, error: 'stale_snapshot' }, `accepted ${String(candidate)}`);
    assert.deepEqual(store.listTurnNotes(sessionId), beforeRows, `wrote rows for ${String(candidate)}`);
  }
  // 同一次捕获、同一份正文，真凭证仍然提交成功：上面的拒绝来自身份检查，而不是这份 fixture 本就提交不了。
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
});

// 覆盖率判据要读库，所以读失败排在 note 判断之前：这一段的槽是空的，库好着的时候它就是 invalid_notes。
// 读不出库的时候「缺段」根本无法成立 —— 缺的那一段可能早就落库了，所以它只能是可重试的存储故障。
test('submit：覆盖率读库失败 → storage_unavailable，压过 invalid_notes，两文件留着', async (t) => {
  useTranscript(uncommittedPath);            // 库里没有这一段的行，恢复后才轮得到 missing note
  const orig = store.listTurnNotes;
  t.after(() => { store.listTurnNotes = orig; useTranscript(transcriptPath); });
  const { snapshot_id, notes_path } = svc.getTurnSkeleton();     // 服务端刚写好空标题清单，没人填
  const beforeRows = store.listTurnNotes(sessionId);
  store.listTurnNotes = () => { throw new Error('disk full'); };   // 仓内惯用的注入法
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.deepEqual(res, { committed: false, error: 'storage_unavailable', retryable: true });
  assert.ok(existsSync(notes_path), 'retryable 却把 note 删了，等于不可重试');
  store.listTurnNotes = orig;
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
  assert.equal((await svc.submitTurnNotes({ snapshot_id })).error, 'invalid_notes', '库恢复后才轮到 note 判断');
});

test('submit：写事务中途 DB error → storage_unavailable，两文件留着，原地重试即成功', async (t) => {
  const orig = store.upsertTurnNotes;
  t.after(() => { store.upsertTurnNotes = orig; });
  store.upsertTurnNotes = () => { throw new Error('disk full'); };   // 仓内惯用的注入法
  const { snapshot_id, notes_path } = produce();
  const beforeRows = store.listTurnNotes(sessionId);
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.deepEqual(res, { committed: false, error: 'storage_unavailable', retryable: true });
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
  // retryable 的前提：删文件只发生在提交成功之后，否则重试无从读取已写的 note。
  assert.ok(existsSync(notes_path), 'retryable 却把 note 删了，等于不可重试');
  store.upsertTurnNotes = orig;
  const retry = await svc.submitTurnNotes({ snapshot_id });
  assert.deepEqual(retry, { committed: true });
  assert.equal(store.listTurnNotes(sessionId).length, turns.length);   // 无重复行
});

test('submit 成功：{committed:true}，note-less turn 也有行，两文件与目录随即消失', async () => {
  const { snapshot_id, notes_path, skeleton_path } = produce();
  const res = await svc.submitTurnNotes({ snapshot_id });
  assert.deepEqual(res, { committed: true });
  const rows = store.listTurnNotes(sessionId);
  assert.equal(rows.length, turns.length);
  const noteLessAnchor = turns.find(turn => !turn.hasAssistantActivity).sourceEntryId;
  assert.equal(rows.find(row => row.anchorUuid === noteLessAnchor).note, null);
  // 骨架是未脱敏的 Turn History Projection，note 落库后它没有第二个读者。
  assert.ok(!existsSync(notes_path) && !existsSync(skeleton_path));
  assert.ok(!existsSync(dirname(notes_path)));
});

// 提交成功会退休那份目录，而同一 session 的下一次 handoff 的 epoch 键不变 —— 重提交撞到的就是「文件
// 已经没了」。库是持久副本：每个被捕获的 turn 都有一行，所以覆盖率由行的存在成立，重提交因此是幂等的
// 而不是有损的。
test('重提交已落库的 epoch：库里有行即算覆盖 → committed，已存 note 一字不动', async () => {
  const { snapshot_id, notes_path } = produce({ body: () => 'durable body' });
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
  assert.equal(existsSync(dirname(notes_path)), false, '前提：目录随提交退休');
  const committed = store.listTurnNotes(sessionId);
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
  assert.deepEqual(store.listTurnNotes(sessionId), committed, '文件没了也不改一行 —— 幂等而非有损');
  assert.equal(committed.find(r => r.anchorUuid === turns[0].sourceEntryId).note, 'durable body');
});

// 重取撞的是同一个 epoch 键，而目录已随提交退休：交出一份空文档等于让生产者把已经写好的 note 重写一遍。
test('重取已提交的 epoch：新 notes 文件从库里预填已存的 note', async () => {
  const first = produce({ body: () => 'prefilled body' });
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id: first.snapshot_id }), { committed: true });
  const again = svc.getTurnSkeleton();
  assert.equal(again.notes_path, first.notes_path, 'epoch 键不随提交改变，撞的是同一条路径');
  const refetched = readFileSync(again.notes_path, 'utf8');
  const { sections } = parseNoteSections(refetched, slotKeysOf(capture(transcriptPath, ctx.cwd)));
  assert.equal(sections.get(String(headT)), 'prefilled body', '已落库的正文回到它自己的标题下');
  // 预填出来的文档本身可提交：第二份 handoff 不必重写一遍 note。
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id: again.snapshot_id }), { committed: true });
  const row = store.listTurnNotes(sessionId).find(r => r.anchorUuid === turns[0].sourceEntryId);
  assert.equal(row.note, 'prefilled body');
});

// 覆盖率判的是「有行」而不是「有正文」。一个真 note-less 的 turn 落的是合法的 null，判正文会让它永远
// missing —— 一个写 note 也清不掉的 invalid_notes。这里让原本没槽的裸命令 turn 在同一 epoch 里长出
// assistant 活动：它于是成了一个槽，而库里那一行的 note 是 null。
test('note-less 的槽由它那一行兜住：不报 missing，null 也不被空正文改写', async (t) => {
  t.after(() => writeEntries(transcriptPath, baseEntries()));   // 共享 fixture，失败也要复原
  const noteless = capture(transcriptPath, ctx.cwd).find(turn => !turn.hasAssistantActivity);
  const { snapshot_id } = produce({ body: () => 'head body' });
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
  const storedNoteOf = () =>
    store.listTurnNotes(sessionId).find(r => r.anchorUuid === noteless.sourceEntryId).note;
  assert.equal(storedNoteOf(), null, '前提：这一行的 note 是合法的 null');
  // 那个裸命令 turn 长出一条 assistant 回复，新的当前 handoff turn 接在它后面。
  appendTranscriptEntries(transcriptPath, [
    assistantObservation({ uuid: 'a-late', parentUuid: noteless.sourceEntryId, messageId: 'm-late',
      timestamp: ts(40), blocks: [{ type: 'text', text: 'answered the bare command turn' }] }),
    userMessage({ uuid: 'u-cur-d', parentUuid: 'a-late', text: 'prepare the handoff', timestamp: ts(41) }),
  ]);
  const again = svc.getTurnSkeleton();
  const grownKeys = slotKeysOf(capture(transcriptPath, ctx.cwd));
  assert.ok(grownKeys.includes(String(noteless.sourceOrdinal)), 'fixture 自证：那个 turn 现在真的有槽了');
  const { sections } = parseNoteSections(readFileSync(again.notes_path, 'utf8'), grownKeys);
  assert.equal(sections.get(String(noteless.sourceOrdinal)), '', 'null 的 note 没有正文可预填');
  // 空正文 + 有行 ⇒ 覆盖成立；那一行的 null 也不被这段空正文改写。
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id: again.snapshot_id }), { committed: true });
  assert.equal(storedNoteOf(), null);
});

test('submit 落库：u_text 过 200-token 反解，search_terms 带解析后的绝对工具路径', async () => {
  const { snapshot_id } = produce();
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }), { committed: true });
  const row = store.listTurnNotes(sessionId).find(r => r.anchorUuid === 'u-one');
  // 同一份清洗正文，两个判据互不派生：u_original_chars 是清洗长度，u_text 是它的 200-token 前缀。
  assert.equal(row.uOriginalChars, LONG_HEAD_U.length);
  assert.ok(row.uOriginalChars > row.uText.length, '写路径必须真的做过 200-token 反解');
  // Task 10 的 FTS 输入：相对 file_path 已按捕获 cwd 解析成绝对路径。
  assert.ok(row.searchTerms.split(' ').includes(join(ctx.cwd, 'lib/store.js')));
});

test('骨架只捕获最新 compact epoch，T 仍是文件绝对行号', (t) => {
  useTranscript(compactCapturePath);
  t.after(() => useTranscript(transcriptPath));
  const skeleton = readFileSync(svc.getTurnSkeleton().skeleton_path, 'utf8');
  assert.ok(!skeleton.includes('pre-compact-u'));
  assert.ok(skeleton.includes('post-compact-u'));
  assert.ok(!skeleton.includes('current-handoff-u'));
  assert.match(skeleton, /^T +4 \| U/m);               // compact 后不重新起编，T 仍是 grep -n 的行号
});

// 头行缺时间或组内重复 identity 的捕获，两个入口都拒：骨架侧在写任何文件之前就抛（钉在
// test/turn.capture.test.js `malformed Turn Head fails before skeleton`），提交侧仍是 invalid_snapshot。
// 提交侧的 snapshot 取自这些捕获自己的指纹 —— 骨架已经拿不到它了。
for (const [label, pathOf] of [
  ['缺 source_timestamp', () => missingTimestampPath],
  ['重复 (session, anchor)', () => duplicateAnchorPath],
]) {
  test(`submit：${label} → invalid_snapshot、零写入`, async (t) => {
    const path = pathOf();
    useTranscript(path);
    t.after(() => useTranscript(transcriptPath));
    assert.throws(() => svc.getTurnSkeleton(), /identity/i, '骨架侧先拒，一个文件都不写');
    const snapshot_id = snapshotDigest(capture(path, ctx.cwd));
    const beforeRows = store.listTurnNotes(sessionId);
    const res = await svc.submitTurnNotes({ snapshot_id });
    assert.deepEqual(res, { committed: false, error: 'invalid_snapshot' });
    assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
  });
}

test('转录读不到时：骨架抛错，submit 以 invalid_snapshot 拒绝，绝不出现「成功 + 零行」', async (t) => {
  const missingPath = join(dirname(transcriptPath), 'no-such-transcript.jsonl');
  // 先在可读转录上取一份真 snapshot：这样 submit 的拒绝只能来自读取状态本身。
  const { snapshot_id } = produce();
  useTranscript(missingPath);
  t.after(() => useTranscript(transcriptPath));

  assert.equal(dialogueSource.read(missingPath).status, 'unavailable', 'fixture 自证：该路径真的读不到');
  assert.throws(() => svc.getTurnSkeleton(), /transcript/i, '零 turn 的骨架看起来是合法空 epoch，不能交出去');

  const beforeRows = store.listTurnNotes(sessionId);
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id }),
    { committed: false, error: 'invalid_snapshot' });
  // 丢弃读取状态时服务端会自己算出这个 digest（空捕获）。连它都必须被拒 ——
  // 否则一个零槽的空捕获会以 { committed: true } 提交零行，整个 epoch 的 note 静默丢失。
  assert.deepEqual(await svc.submitTurnNotes({ snapshot_id: snapshotDigest([]) }),
    { committed: false, error: 'invalid_snapshot' });
  assert.deepEqual(store.listTurnNotes(sessionId), beforeRows);
});

test('NOTE_TOKEN_LIMIT 是收口而非截断点：取整 800 合法，801 整组拒绝', async () => {
  const atLimit = '中'.repeat(800);
  const ok = await svc.submitTurnNotes({ snapshot_id: produce({ body: () => atLimit }).snapshot_id });
  assert.deepEqual(ok, { committed: true });
  assert.equal(store.listTurnNotes(sessionId).find(r => r.note === atLimit).uOriginalChars > 0, true);
  const over = await svc.submitTurnNotes({ snapshot_id: produce({ body: () => '中'.repeat(801) }).snapshot_id });
  assert.equal(over.error, 'invalid_notes');
  // 拒绝，不截断：库里仍是那条整整 800 字的 note。
  assert.ok(store.listTurnNotes(sessionId).some(r => r.note === atLimit));
});

// ── Turn page endpoint: shape, parity, 404s, capability isolation ─────────────

describe('Turn page endpoint — 负载形态与 load_handoff 同一性', () => {
  let ctx, store, loadToken, handoffId, dir, pageTranscriptPath;
  const sessionId = 'sid-tp-norm';
  const projectId = 'proj-boot';

  before(async () => {
    ctx = await bootTestServer({ sessionId });
    store = ctx.store;
    dir = mkdtempSync(join(tmpdir(), 'sw-tp-norm-'));

    // 10 user/assistant pairs — enough to overflow the 5000-token budget, so next_before is produced.
    // uText is short and distinct per entry (turn{i}data) so disjointness is assertable by content.
    // note is long (3000 'n' chars) to drive the overflow: 6 entries exceed the budget, 5 fit.
    const indices = Array.from({ length: 10 }, (_, i) => i);
    const entries = indices.flatMap(i => [
      userMessage({ uuid: `u-tp-${i}`, parentUuid: i === 0 ? null : `a-tp-${i - 1}`,
        text: `turn${i}data`, timestamp: ts(i * 2 + 1) }),
      assistantObservation({ uuid: `a-tp-${i}`, parentUuid: `u-tp-${i}`, messageId: `m-tp-${i}`,
        timestamp: ts(i * 2 + 2), blocks: [{ type: 'text', text: `answer${i}` }] }),
    ]);
    pageTranscriptPath = writeTranscript(dir, entries);

    loadToken = 'tok-tp-norm';
    handoffId = _seedDeliveredHandoff(store, {
      sessionId, sourceSessionId: 'session-tp-src',
      loadToken, transcriptPath: pageTranscriptPath,
    });

    // Seed turn notes for all 10 user messages. Long note drives budget overflow.
    store.upsertTurnNotes(indices.map(i => ({
      sourceSessionId: 'session-tp-src',
      anchorUuid: `u-tp-${i}`,
      uText: `turn${i}data`,
      uOriginalChars: `turn${i}data`.length,
      note: 'n'.repeat(3000),
      searchTerms: `turn${i}data`,
      sourceTimestamp: Date.parse(ts(i * 2 + 1)),
    })));
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('load 返回 turn_page，且不含任何 turn URL 或 bookmark 字段', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    assert.equal(typeof res.turn_page, 'string');
    for (const key of ['turn_page_url', 'turn_search_url', 'turn_locate_url']) {
      assert.equal(res[key], undefined, key);
    }
    assert.equal(res.bookmarks, undefined);
  });

  test('分页同一性：load 合入的完整 page 投影与缺省-before HTTP 响应相同', async () => {
    const loaded = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    const paged = await ctx.request(`/api/turn/page?lineage_head=${handoffId}`, {});
    // turn_page is non-empty (notes seeded), so this exercises real content equality, not ""==="".
    assert.ok(loaded.turn_page.length > 0, 'turn_page is non-empty');
    assert.deepEqual(paged, {
      turn_page: loaded.turn_page,
      ...(loaded.next_before ? { next_before: loaded.next_before } : {}),
    });
  });

  test('next_before：存在、格式正确、load 与 HTTP 相同、翻页不重叠', async () => {
    const loaded = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    const paged = await ctx.request(`/api/turn/page?lineage_head=${handoffId}`, {});

    // Budget overflow guarantees next_before is present.
    assert.ok(loaded.next_before, 'next_before present on load');
    assert.match(loaded.next_before, /^S\d+:\d+$/, 'next_before is a bare S{k}:{T} cursor');

    // Both call sites produce the same cursor.
    assert.equal(paged.next_before, loaded.next_before, 'load and HTTP produce identical next_before');

    // Following the cursor returns a page disjoint from page 1.
    const page2 = await ctx.request(
      `/api/turn/page?lineage_head=${handoffId}&before=${encodeURIComponent(loaded.next_before)}`, {});
    assert.ok(page2.turn_page.length > 0, 'page 2 is non-empty');

    // Disjointness: the seeded entries divide across pages by budget; each page covers
    // a distinct subset of entries. The newest entry (turn9data) is on page 1 and not
    // on page 2; the entries on page 2 (older) are absent from page 1.
    assert.ok(loaded.turn_page.includes('turn9data'), 'page 1 has newest entry');
    assert.ok(!page2.turn_page.includes('turn9data'), 'page 2 has no page-1 entries');
    // Page 2 has its own entries — turn5data is u-tp-5's, the newest one the budget pushed off page 1.
    assert.ok(page2.turn_page.includes('turn5data'), 'page 2 has its own entries');
    assert.ok(!loaded.turn_page.includes('turn5data'), 'page 1 has no page-2 entries');
  });

  test('显式跨项目 head 的三条 Turn 路由仍由该 head 自己的 project 重建', async () => {
    const projectBLoadToken = 'tok-project-b';
    const projectBSource = 'session-project-b-src';
    const projectBTranscript = writeTranscript(dir, [
      userMessage({ uuid: 'u-project-b', text: 'crossprojectneedle', timestamp: ts(10) }),
      assistantObservation({ uuid: 'a-project-b', parentUuid: 'u-project-b', messageId: 'm-project-b',
        timestamp: ts(11), blocks: [{ type: 'text', text: 'project B evidence' }] }),
    ]);
    const projectBHandoffId = _seedDeliveredHandoff(ctx.store, {
      sessionId,
      sourceSessionId: projectBSource,
      loadToken: projectBLoadToken,
      transcriptPath: projectBTranscript,
      projectId: 'project-B',
    });
    ctx.store.upsertTurnNotes([{
      sourceSessionId: projectBSource,
      anchorUuid: 'u-project-b',
      uText: 'crossprojectneedle',
      uOriginalChars: 'crossprojectneedle'.length,
      note: 'project B evidence',
      searchTerms: 'crossprojectneedle project evidence',
      sourceTimestamp: Date.parse(ts(10)),
    }]);

    const loaded = await ctx.request(`/api/handoff/load?load_token=${projectBLoadToken}`, {});
    assert.equal(loaded.found, true);
    assert.equal(loaded.turn_page_url, undefined);

    // 显式 head 仍是 HTTP 面的能力：三条路由都把该 head 行自己的 projectId 交给共享 walk。
    const paged = await ctx.request(`/api/turn/page?lineage_head=${projectBHandoffId}`, {});
    assert.deepEqual(paged, {
      turn_page: loaded.turn_page,
      ...(loaded.next_before ? { next_before: loaded.next_before } : {}),
    });

    const searched = await ctx.request(
      `/api/turn/search?lineage_head=${projectBHandoffId}&q=crossprojectneedle`, {});
    assert.equal(searched.found, true);

    const located = await ctx.request(
      `/api/turn/locate?lineage_head=${projectBHandoffId}&q=crossprojectneedle`, {});
    assert.equal(located.found, true);
    assert.deepEqual(located.ranges.map(e => e.scope), ['S1:1']);
  });

  test('lineage_head 缺失/越界、before 无法解析 → 404 {error:"not_found"}', async () => {
    for (const url of ['/api/turn/page',
                       '/api/turn/page?lineage_head=999999',
                       `/api/turn/page?lineage_head=${handoffId}&before=nonsense`,
                       `/api/turn/page?lineage_head=${handoffId}&before=S1:99999`]) {
      const res = await ctx.requestRaw(url);
      assert.equal(res.status, 404, url);
      assert.deepEqual(await res.json(), { error: 'not_found' }, url);
    }
  });

  test('lineage 解析失败与 page 构造失败同一降级：可重试 503，不是 500', async (t) => {
    // load 侧 fromHandoff 在 try 内，失败降级成 turn_page_error；HTTP 侧把同类失败映射为 503。
    const orig = store.getHandoff;
    t.after(() => { store.getHandoff = orig; });
    store.getHandoff = () => { throw new Error('store unavailable'); };   // 仓内惯用的注入法
    const res = await ctx.requestRaw(`/api/turn/page?lineage_head=${handoffId}`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'turn_page_unavailable', retryable: true });
  });

  test('q / scope 校验的错误码与 body 逐字固定', async () => {
    const h = handoffId;
    const cases = [
      [`/api/turn/search?lineage_head=${h}&q=x&scope=nonsense`, 400, 'invalid_scope'],
      [`/api/turn/search?lineage_head=${h}&q=x&scope=S1:99999`, 404, 'scope_not_found'],
      [`/api/turn/search?lineage_head=${h}`, 400, 'invalid_query'],
      [`/api/turn/search?lineage_head=${h}&q=`, 400, 'invalid_query'],
      [`/api/turn/search?lineage_head=${h}&q=%20%20`, 400, 'invalid_query'],
      [`/api/turn/search?lineage_head=${h}&q=${'a'.repeat(201)}`, 400, 'invalid_query'],
    ];
    for (const [url, status, error] of cases) {
      const res = await ctx.requestRaw(url);
      assert.equal(res.status, status, url);
      assert.deepEqual(await res.json(), { error }, url);
    }
  });

  test('search 的 lineage_head 缺失或越界统一 404 not_found', async () => {
    for (const url of ['/api/turn/search?q=x', '/api/turn/search?lineage_head=999999&q=x']) {
      const res = await ctx.requestRaw(url);
      assert.equal(res.status, 404, url);
      assert.deepEqual(await res.json(), { error: 'not_found' }, url);
    }
  });

  test('search 的 lineage 解析失败与 page 同一降级：503，不是 500', async (t) => {
    const orig = store.getHandoff;
    t.after(() => { store.getHandoff = orig; });
    store.getHandoff = () => { throw new Error('store unavailable'); };
    const res = await ctx.requestRaw(`/api/turn/search?lineage_head=${handoffId}&q=turn9data`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'search_unavailable' });
  });

  test('page / search / locate 都不接受预算参数：传入即忽略，不新增错误码', async () => {
    const plain = await ctx.request(`/api/turn/page?lineage_head=${handoffId}`, {});
    const withBudget = await ctx.request(`/api/turn/page?lineage_head=${handoffId}&budget=999999`, {});
    assert.ok(plain.turn_page.length > 0);
    assert.equal(withBudget.turn_page, plain.turn_page);
    for (const route of ['search', 'locate']) {
      const s = await ctx.requestRaw(`/api/turn/${route}?lineage_head=${handoffId}&q=turn9data&budget=999999`);
      assert.equal(s.status, 200, route);
      assert.equal((await s.json()).found, true, route);
    }
  });

  test('locate 成功形状只有 found/ranges，scope 是运行时地址，命中带上它的前两条邻居', async () => {
    const res = await ctx.request(`/api/turn/locate?lineage_head=${handoffId}&q=turn9data`, {});
    assert.deepEqual(Object.keys(res).sort(), ['found', 'ranges']);
    const hits = res.ranges.filter(e => e.hit);
    // u-tp-9 的物理行由 fixture 每 turn 两行推出，按 grep -n 编号 —— 地址来自运行时解析，不是数组下标。
    assert.deepEqual(hits.map(e => e.scope), ['S1:19']);
    assert.equal(hits[0].u, 'turn9data');
    // 它是最后一条 turn，所以窗口只往前拿得到两条；note 都是 3000 字符，context 侧因此都是预览。
    assert.deepEqual(res.ranges.map(e => e.scope), ['S1:15', 'S1:17', 'S1:19']);
    assert.ok(res.ranges[0].note.endsWith(' [truncated; 3000 chars]'));
  });

  test('locate 零命中精确返回 {found:false}', async () => {
    const res = await ctx.request(`/api/turn/locate?lineage_head=${handoffId}&q=nowhere-in-this-fixture`, {});
    assert.deepEqual(res, { found: false });
  });

  test('locate 复用 q 校验：缺失、空、纯空白或超 200 字符均 400 invalid_query', async () => {
    for (const url of [
      `/api/turn/locate?lineage_head=${handoffId}`,
      `/api/turn/locate?lineage_head=${handoffId}&q=`,
      `/api/turn/locate?lineage_head=${handoffId}&q=%20`,
      `/api/turn/locate?lineage_head=${handoffId}&q=${'a'.repeat(201)}`,
    ]) {
      const res = await ctx.requestRaw(url);
      assert.equal(res.status, 400, url);
      assert.deepEqual(await res.json(), { error: 'invalid_query' }, url);
    }
  });

  test('turn FTS 不可用时 locate 精确返回 503 body', async (t) => {
    const prior = store._turnFtsAvailable;
    t.after(() => { store._turnFtsAvailable = prior; });
    store._turnFtsAvailable = false;
    const res = await ctx.requestRaw(`/api/turn/locate?lineage_head=${handoffId}&q=turn9data`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'locate_unavailable' });
  });

  test('locate 的 lineage_head 缺失或越界统一 404 not_found', async () => {
    for (const url of ['/api/turn/locate?q=x', '/api/turn/locate?lineage_head=999999&q=x']) {
      const res = await ctx.requestRaw(url);
      assert.equal(res.status, 404, url);
      assert.deepEqual(await res.json(), { error: 'not_found' }, url);
    }
  });

  test('locate 的 lineage 解析失败与 FTS 不可用同一降级：503，不是 500', async (t) => {
    const orig = store.getHandoff;
    t.after(() => { store.getHandoff = orig; });
    store.getHandoff = () => { throw new Error('store unavailable'); };
    const res = await ctx.requestRaw(`/api/turn/locate?lineage_head=${handoffId}&q=turn9data`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'locate_unavailable' });
  });

  // 三条路由各自兜住 503 之前，未预期的抛出会走到终端 handler，由它在 SW_DEBUG 下打印 `[route error]`。
  // 兜住之后必须自己接上同一条门控日志，否则没有任何途径知道某次 503 的成因。
  test('三条 turn 路由的 503 在 SW_DEBUG 下报出成因；不开则静默，body 两次都不变', async (t) => {
    const orig = store.getHandoff;
    const origDebug = process.env.SW_DEBUG;
    const origError = console.error;
    t.after(() => {
      store.getHandoff = orig;
      console.error = origError;
      if (origDebug === undefined) delete process.env.SW_DEBUG;
      else process.env.SW_DEBUG = origDebug;
    });
    store.getHandoff = () => { throw new Error('store unavailable: fixture cause'); };

    const q = 'sensitiveneedle';   // 调用方载荷：允许报成因，不允许报它
    const cases = [
      ['[turn_page]', `/api/turn/page?lineage_head=${handoffId}`, { error: 'turn_page_unavailable', retryable: true }],
      ['[turn_search]', `/api/turn/search?lineage_head=${handoffId}&q=${q}`, { error: 'search_unavailable' }],
      ['[turn_locate]', `/api/turn/locate?lineage_head=${handoffId}&q=${q}`, { error: 'locate_unavailable' }],
    ];
    const asLine = (args) => args.map(a => (typeof a === 'string' ? a : String(a?.message ?? a))).join(' ');

    const drive = async () => {
      const lines = [];
      console.error = (...args) => { lines.push(asLine(args)); };
      try {
        for (const [, url, body] of cases) {
          const res = await ctx.requestRaw(url);
          assert.equal(res.status, 503, url);
          assert.deepEqual(await res.json(), body, url);
        }
      } finally { console.error = origError; }
      return lines;
    };

    process.env.SW_DEBUG = '1';
    const logged = await drive();
    for (const [tag] of cases) {
      const hits = logged.filter(l => l.includes(tag));
      assert.equal(hits.length, 1, `${tag} 应恰好报一次成因`);
      assert.match(hits[0], /store unavailable: fixture cause/);
    }
    assert.ok(!logged.some(l => l.includes(q)), '日志只报成因，不带 q 这类调用方载荷');

    // 预期内的 404 不是成因：日志行的出现即表示这一次是 503。
    store.getHandoff = orig;
    const notFoundLines = [];
    console.error = (...args) => { notFoundLines.push(asLine(args)); };
    const nf = await ctx.requestRaw(`/api/turn/page?lineage_head=${handoffId}&before=nonsense`);
    console.error = origError;
    assert.equal(nf.status, 404);
    assert.deepEqual(notFoundLines.filter(l => l.includes('[turn_page]')), []);

    store.getHandoff = () => { throw new Error('store unavailable: fixture cause'); };
    delete process.env.SW_DEBUG;
    const silent = await drive();
    assert.deepEqual(silent.filter(l => /\[turn_(page|search|locate)\]/.test(l)), []);
  });

  test('search 成功响应不回显输入', async () => {
    const res = await ctx.request(`/api/turn/search?lineage_head=${handoffId}&q=turn9data`, {});
    assert.deepEqual(Object.keys(res).sort(), ['found', 'ranges', 'truncated']);
    const at = readHistorySource({ dialogueSource, dialogueProjection: projectionFor(ctx.cwd) },
      pageTranscriptPath)
      .folds.find(f => f.sourceEntryId === 'u-tp-9').sourceOrdinal;
    assert.deepEqual(res.ranges.flatMap(g => g.matches).map(m => m.line), [at]);
  });

  test('search 零命中精确返回 {found:false}', async () => {
    const res = await ctx.request(`/api/turn/search?lineage_head=${handoffId}&q=nowhere-in-this-fixture`, {});
    assert.deepEqual(res, { found: false });
  });

  test('load 带 lineage：每段一条 headline，label 与页里的 session 头同源', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.deepEqual(res.lineage, [{ label: 'S1', headline: 'turn0data' }]);
    assert.ok(res.turn_page.includes(`S1  ${pageTranscriptPath}`));
  });

});

// ── Turn page failure seam ────────────────────────────────────────────────────

describe('Turn page construction failure seam', () => {
  let ctx, store, loadToken, handoffId, dir;
  const sessionId = 'sid-tp-fail';

  before(async () => {
    ctx = await bootTestServer({ sessionId, throwingTurnPage: true });
    store = ctx.store;
    dir = mkdtempSync(join(tmpdir(), 'sw-tp-fail-'));
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u-tf', text: 'test', timestamp: ts(1) }),
    ]);
    loadToken = 'tok-tp-fail';
    handoffId = _seedDeliveredHandoff(store, {
      sessionId, sourceSessionId: 'session-tf-src',
      loadToken, transcriptPath: path,
    });
  });
  after(async () => {
    await ctx.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  test('page 构造失败时 delivery 已提交：核心 handoff + turn_page_error，无 URL', async () => {
    const res = await ctx.request(`/api/handoff/load?load_token=${loadToken}`, {});
    assert.equal(res.found, true);
    assert.equal(res.load_token, loadToken);
    assert.equal(typeof res.summary, 'string');
    assert.equal(res.turn_page_error, 'turn_page_unavailable');
    assert.equal(res.turn_page, undefined);
    assert.equal(res.next_before, undefined);
    assert.equal(res.lineage, undefined);
    for (const key of ['turn_page_url', 'turn_search_url', 'turn_locate_url']) {
      assert.equal(res[key], undefined, key);
    }
    assert.ok(ctx.store._db.prepare('SELECT 1 FROM handoff_load WHERE handoff_id = ?').get(handoffId));
  });

  test('page HTTP 构造失败精确返回可重试 503', async () => {
    const res = await ctx.requestRaw(`/api/turn/page?lineage_head=${handoffId}`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'turn_page_unavailable', retryable: true });
  });
});

// `/exit` 与 `/clear` 在落库这一层必须同形：都落一行，都是 note=null。自带一个 server 实例 —— 它是
// 这份文件里唯一往共享 store 落新 anchor 的用例，而上面两条按行数断言「无重复行」的用例只在这个
// session 只被基准转录写过时才成立。
describe('/exit 回显 turn — 与 /clear 落库同形', () => {
  let ctx, store, svc, sourcePath;
  const sessionId = 'sid-exit-echo';

  before(async () => {
    ctx = await bootTestServer({ sessionId });
    store = ctx.store;
    svc = ctx.turnService;
    // This suite has its OWN owner, so it writes its OWN Source rather than the outer suite's.
    sourcePath = ctx.transcriptPath;
    writeEntries(sourcePath, exitEchoEntries());
  });

  after(async () => { await ctx.teardown(); });

  // 槽的那半在服务端预写的标题清单上断言 —— 生产者看到的就是那份文件，它没有那个标题就不会为一个
  // 零内容的 turn 写 note。
  test('服务端不给它预写槽，落库仍是一行 note=null', async () => {
    const exitTurn = capture(sourcePath, ctx.cwd).find(turn => turn.cleanedU === '/exit');
    const captured = svc.getTurnSkeleton();
    assert.deepEqual(headingKeysOf(captured.notes_path), ['1', '7'], '`/exit` 回显自成一块，它不得成为一个槽');
    fillNotes(captured.notes_path, (k) => `exit-fixture body ${k}`);
    assert.deepEqual(await svc.submitTurnNotes({ snapshot_id: captured.snapshot_id }), { committed: true });
    const rows = store.listTurnNotes(sessionId);
    assert.equal(rows.length, 3, '三个捕获的 turn 各落一行 —— 少给槽不等于少落行');
    const row = rows.find(r => r.anchorUuid === exitTurn.sourceEntryId);
    assert.equal(row.uText, '/exit', '行照旧落 —— 和 `/clear` 一样是个重启边界标记');
    assert.equal(row.note, null);
  });
});
