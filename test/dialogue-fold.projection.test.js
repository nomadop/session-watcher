// test/dialogue-fold.projection.test.js — Dialogue Projection behavior for the Bookmark route.
// Moved verbatim from canonical-fold.test.js when the compat re-export was retired: these
// exercise dialogue-fold.js, so they must import it directly (§7.2 dependency-direction gate).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCanonicalTranscript,
  visibleMessages,
  enumerateLines,
  findCanonicalMessage,
  foldAnchor,
} from '../lib/dialogue-fold.js';
import {
  userMessage, assistantObservation, assistantToolUse, toolResult, writeTranscript, ts,
} from './helpers/transcript-fixtures.js';

// --- Checkpoint B: Dialogue Projection tests ---

describe('readCanonicalTranscript', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-dialogue-')); });

  test('same message.id applies field-level streaming revisions', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'provisional text' }],
      }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'final text' }],
      }),
      assistantObservation({
        uuid: 'a3', parentUuid: 'a2', messageId: 'm1', timestamp: ts(3),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'partial' } }],
      }),
      assistantObservation({
        uuid: 'a4', parentUuid: 'a3', messageId: 'm1', timestamp: ts(4),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.js' } }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    assert.equal(visibleMessages(c).length, 1);
    assert.equal(visibleMessages(c)[0].text, 'final text');
    assert.equal(visibleMessages(c)[0].anchorUuid, 'a1');
    assert.equal(c.folds[0].toolPairs.length, 1);
    assert.equal(c.folds[0].toolPairs[0].input.file_path, '/repo/a.js');
  });

  test('compact summary / sidechain / meta / task notification are absent from dialogue', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'response' }],
      }),
      // Sidechain
      assistantObservation({
        uuid: 'sc1', parentUuid: 'a1', messageId: 'msc', timestamp: ts(3),
        blocks: [{ type: 'text', text: 'sidechain' }],
        extra: { isSidechain: true },
      }),
      // Meta
      { type: 'assistant', uuid: 'meta1', parentUuid: 'a1', isSidechain: false, isMeta: true,
        timestamp: ts(4), message: { id: 'mmeta', role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'meta content' }] } },
      // Task notification
      { type: 'user', uuid: 'tn1', parentUuid: 'a1', isSidechain: false,
        timestamp: ts(5), message: { role: 'user',
        content: '<task-notification><task-id>abc12345</task-id><summary>Agent "test" finished</summary></task-notification>' } },
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    // Only user 'hello' and assistant 'response' visible
    assert.equal(visibleMessages(c).length, 2);
    assert.equal(visibleMessages(c)[0].text, 'hello');
    assert.equal(visibleMessages(c)[1].text, 'response');
  });

  test('each compact root contributes only its active branch in physical root order', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'r1', text: 'first', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'r1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'answer 1' }],
      }),
      userMessage({ uuid: 'r2', text: 'second', timestamp: ts(3) }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'r2', messageId: 'm2', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'answer 2' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    assert.equal(visibleMessages(c).length, 4);
    assert.equal(visibleMessages(c)[0].text, 'first');
    assert.equal(visibleMessages(c)[1].text, 'answer 1');
    assert.equal(visibleMessages(c)[2].text, 'second');
    assert.equal(visibleMessages(c)[3].text, 'answer 2');
  });

  test('user message.content supports string and visible text-block array', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'string content', timestamp: ts(1) }),
      { type: 'user', uuid: 'u2', parentUuid: 'u1', isSidechain: false, timestamp: ts(2),
        message: { role: 'user', content: [
          { type: 'text', text: 'block one' },
          { type: 'text', text: ' block two' },
        ] } },
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    assert.equal(visibleMessages(c)[0].text, 'string content');
    assert.equal(visibleMessages(c)[1].text, 'block one block two');
  });

  test('last text-bearing observation supplies text; first visible-text keeps anchor', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'early text' }],
      }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'late text' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(visibleMessages(c)[0].text, 'late text');
    assert.equal(visibleMessages(c)[0].anchorUuid, 'a1');
    assert.equal(visibleMessages(c)[0].anchorTimestamp, Date.parse(ts(1)));
  });

  test('a later tool-only observation does not erase retained text', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'kept text' }],
      }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(visibleMessages(c)[0].text, 'kept text');
    assert.equal(c.folds[0].toolPairs.length, 1);
  });

  test('duplicate tool use/result ID is payload-last-wins with first-seen ID order', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/old.js' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.js' } },
        ],
      }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm1', timestamp: ts(2),
        blocks: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/new.js' } },
        ],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    // t1 is first-seen, t2 is second. t1 payload is last-wins (/new.js)
    assert.equal(c.folds[0].toolPairs[0].id, 't1');
    assert.equal(c.folds[0].toolPairs[0].input.file_path, '/new.js');
    assert.equal(c.folds[0].toolPairs[1].id, 't2');
    assert.equal(c.folds[0].toolPairs[1].input.file_path, '/b.js');
    // 行号随胜出的载荷一起走：搜到 /new.js 的读者要落在写它的那一行。
    assert.equal(c.folds[0].toolPairs[0].useLineOrdinal, 2);
    assert.equal(c.folds[0].toolPairs[1].useLineOrdinal, 1);
  });

  test('result pairs by tool_use_id; missing result remains null', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.js' } },
        ],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 't1', content: 'file contents' }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.folds[0].toolPairs[0].id, 't1');
    assert.equal(c.folds[0].toolPairs[0].result, 'file contents');
    assert.equal(c.folds[0].toolPairs[1].id, 't2');
    assert.equal(c.folds[0].toolPairs[1].result, null);
  });

  test('the whole transcript is materialized regardless of embedded tokens', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'first', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'CUT_HERE response' }],
      }),
      userMessage({ uuid: 'u2', parentUuid: 'a1', text: 'last', timestamp: ts(3) }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    assert.deepEqual(visibleMessages(c).map(m => m.text), ['first', 'CUT_HERE response', 'last']);
    assert.deepEqual(c.warnings, []);
  });

  test('afterLatestCompact:true starts strictly after the last native compact summary', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'r1', text: 'old context', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'r1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'old answer' }],
      }),
      // Simulate compact summary (type attachment/compact)
      { type: 'user', uuid: 'cs', parentUuid: 'a1', isSidechain: false,
        timestamp: ts(3), message: { role: 'user', content: '(compact summary)' },
        isCompactSummary: true },
      userMessage({ uuid: 'u2', parentUuid: 'cs', text: 'new context', timestamp: ts(4) }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'u2', messageId: 'm2', timestamp: ts(5),
        blocks: [{ type: 'text', text: 'new answer' }],
      }),
    ]);
    const c = readCanonicalTranscript(path, { afterLatestCompact: true });
    assert.equal(c.status, 'ok');
    // Only post-compact messages
    assert.ok(visibleMessages(c).every(m => m.text !== 'old context' && m.text !== 'old answer'));
    assert.ok(visibleMessages(c).some(m => m.text === 'new context'));
  });

  // A bare attachment is ordinary turn content, not a boundary. Measured across 1017 real
  // transcripts: type:'attachment' occurs 8081 times and never once carries isCompactSummary,
  // so treating it as a boundary clipped 86.5% of transcripts down to their trailing turn.
  test('afterLatestCompact:true does not treat a bare attachment as a boundary', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'first', timestamp: ts(1) }),
      { type: 'attachment', uuid: 'att1', parentUuid: 'u1', isSidechain: false,
        timestamp: ts(2), message: { role: 'user', content: 'pasted file' } },
      userMessage({ uuid: 'u2', parentUuid: 'att1', text: 'second', timestamp: ts(3) }),
    ]);
    const c = readCanonicalTranscript(path, { afterLatestCompact: true });
    assert.deepEqual(visibleMessages(c).map(m => m.text), ['first', 'second']);
  });

  // The boundary is the topology: a compact starts a second null-parent root. isCompactSummary is
  // not guaranteed to accompany it, so a flag-only rule leaks the entire pre-compact context.
  test('afterLatestCompact:true keeps only the newest root when no isCompactSummary is present', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'r1', text: 'pre-compact user', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'r1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'pre-compact answer' }],
      }),
      // Second null-parent root = compact, carrying no isCompactSummary field at all.
      userMessage({ uuid: 'r2', text: 'post-compact user', timestamp: ts(3) }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'r2', messageId: 'm2', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'post-compact answer' }],
      }),
    ]);
    const c = readCanonicalTranscript(path, { afterLatestCompact: true });
    assert.deepEqual(
      visibleMessages(c).map(m => m.text),
      ['post-compact user', 'post-compact answer'],
    );
  });

  test('unavailable path returns {status:unavailable}', () => {
    const c = readCanonicalTranscript('/nonexistent/path/transcript.jsonl');
    assert.equal(c.status, 'unavailable');
    assert.deepEqual(c.folds, []);
    assert.deepEqual(visibleMessages(c), []);
  });

  test('a paired tool result carries its own physical line ordinal, not the fold\'s', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantToolUse({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', toolUseId: 't1',
        name: 'Bash', input: { command: 'echo hi' }, timestamp: ts(2),
      }),
      toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 't1', content: 'output', timestamp: ts(3) }),
    ]);
    const c = readCanonicalTranscript(path);
    const fold = c.folds.find(f => f.toolPairs.length > 0);
    // fold 自己的物理行与它 result 所在的行必须不同，否则读 line 会读到不含 excerpt 的一行。
    assert.equal(fold.sourceRef.lineOrdinal, 2);
    assert.equal(fold.toolPairs[0].resultLineOrdinal, 3);
  });

  test('an unpaired tool use has no result line ordinal', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantToolUse({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', toolUseId: 't1',
        name: 'Bash', input: { command: 'echo hi' }, timestamp: ts(2),
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const fold = c.folds.find(f => f.toolPairs.length > 0);
    assert.equal(fold.toolPairs[0].result, null);
    assert.equal(fold.toolPairs[0].resultLineOrdinal, null);
  });

  test('a tool use carries its own physical line ordinal, not the fold\'s', () => {
    // CC writes each content block of one assistant message as its own JSONL row, so the fold's
    // anchor row (first visible text) and the tool_use row of the same message are different lines.
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
      assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'let me look' }] }),
      assistantToolUse({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm1', toolUseId: 't1',
        name: 'Bash', input: { command: 'echo hi' }, timestamp: ts(3),
      }),
      toolResult({ uuid: 'r1', parentUuid: 'a2', toolUseId: 't1', content: 'output', timestamp: ts(4) }),
    ]);
    const c = readCanonicalTranscript(path);
    const fold = c.folds.find(f => f.toolPairs.length > 0);
    assert.equal(fold.sourceRef.lineOrdinal, 2);
    assert.equal(fold.toolPairs[0].useLineOrdinal, 3);
    assert.equal(fold.toolPairs[0].resultLineOrdinal, 4);
  });
});

describe('findCanonicalMessage', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-findmsg-')); });

  test('finds a message by anchor UUID', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'world' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const found = findCanonicalMessage(c, 'a1');
    assert.equal(found.text, 'world');
  });

  test('returns null for unknown UUID', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
    ]);
    const c = readCanonicalTranscript(path);
    const found = findCanonicalMessage(c, 'nonexistent');
    assert.equal(found, null);
  });
});

// --- Task 3: raw tool pairs preserved regardless of classification ---

describe('raw tool pairs on DialogueFold', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-rawpairs-')); });

  test('raw tool input and result block remain on the pair regardless of classification', () => {
    // A failed Read (is_error) and a successful Read — both should have raw pairs preserved
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/missing.js' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/exists.js' } },
          { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } },
        ],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 't1', content: 'Error: file not found', isError: true }),
      toolResult({ uuid: 'tr2', parentUuid: 'tr1', toolUseId: 't2', content: '1\tconst x = 1;\n' }),
      toolResult({ uuid: 'tr3', parentUuid: 'tr2', toolUseId: 't3', content: 'Tests passed' }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    assert.equal(c.folds[0].toolPairs.length, 3);

    // Failed Read: raw input and result preserved
    const failedPair = c.folds[0].toolPairs[0];
    assert.equal(failedPair.id, 't1');
    assert.equal(failedPair.name, 'Read');
    assert.deepEqual(failedPair.input, { file_path: '/repo/missing.js' });
    assert.equal(failedPair.result, 'Error: file not found');

    // Successful Read: raw input and result preserved
    const successPair = c.folds[0].toolPairs[1];
    assert.equal(successPair.id, 't2');
    assert.equal(successPair.name, 'Read');
    assert.deepEqual(successPair.input, { file_path: '/repo/exists.js' });
    assert.equal(successPair.result, '1\tconst x = 1;\n');

    // Unmatched Bash (residual): raw input and result preserved
    const bashPair = c.folds[0].toolPairs[2];
    assert.equal(bashPair.id, 't3');
    assert.equal(bashPair.name, 'Bash');
    assert.deepEqual(bashPair.input, { command: 'npm test' });
    assert.equal(bashPair.result, 'Tests passed');
  });
});

// --- Line enumeration: the single traversal every line consumer is built on ---

describe('enumerateLines', () => {
  // Fixtures live in the describe body, not a test.before hook, so all four cases below share
  // them without one test block reaching into another's locals.
  const dir = mkdtempSync(join(tmpdir(), 'sw-enumlines-'));

  const mixedPath = writeTranscript(dir, [
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2), blocks: [
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/a.js' } },
    ] }),
    toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 'tu1', content: 'out' }),
    toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 'tu2', content: 'src' }),
  ]);
  // 纯工具 fold：assistantToolUse 不带可见正文 ⇒ fold.message 为 null，anchor 落到 sourceRef.uuid
  const toolOnlyPath = writeTranscript(dir, [
    userMessage({ uuid: 'u1', text: 'go', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'a1', parentUuid: 'u1', messageId: 'm1', toolUseId: 'tu1',
      name: 'Bash', input: { command: 'ls' }, timestamp: ts(2) }),
    toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 'tu1', content: 'out' }),
  ]);

  test('enumerateLines: 每个 toolPair 一行、同 fold 共用 t、原顺序不变', () => {
    const lines = enumerateLines(readCanonicalTranscript(mixedPath));
    assert.deepEqual(lines.map(l => l.kind), ['visible', 'visible', 'tool', 'tool']);
    assert.equal(lines[1].t, lines[2].t);
    assert.equal(lines[2].t, lines[3].t);
    assert.deepEqual(lines.slice(2).map(l => l.tool.name), ['Bash', 'Read']);
    assert.equal(lines[0].anchor, 'u1');
  });

  test('visibleMessages 输出与枚举的可见投影逐字相同', () => {
    const t = readCanonicalTranscript(mixedPath);
    assert.deepEqual(visibleMessages(t), enumerateLines(t).filter(l => l.kind === 'visible').map(l => l.message));
  });

  test('visibleMessages / enumerateLines 对退化输入返回 []（既有契约不得收窄）', () => {
    for (const bad of [null, undefined, {}, { status: 'unavailable', folds: [] }]) {
      assert.deepEqual(visibleMessages(bad), []);
      assert.deepEqual(enumerateLines(bad), []);
    }
  });

  test('纯工具 fold 的 anchor 取 sourceRef.uuid', () => {
    const lines = enumerateLines(readCanonicalTranscript(toolOnlyPath));
    const toolLine = lines.find(l => l.kind === 'tool');
    assert.equal(toolLine.message, null);
    assert.equal(toolLine.anchor, 'a1');   // 该 fold 的 sourceRef.uuid
  });

  // 读取器产出的 fold 上这两个键必然同值：anchorUuid 由同一条 observation 的 sourceRef.uuid 派生。
  // 所以规则的分支次序只能在手造 fold 上钉住 —— 有可见 message 就取它的 anchor，没有才回落。
  test('foldAnchor: 有 message 取 message.anchorUuid，message 为 null 才回落 sourceRef.uuid', () => {
    assert.equal(foldAnchor({ message: { anchorUuid: 'from-message' }, sourceRef: { uuid: 'from-source' } }),
      'from-message');
    assert.equal(foldAnchor({ message: null, sourceRef: { uuid: 'from-source' } }), 'from-source');
  });
});
