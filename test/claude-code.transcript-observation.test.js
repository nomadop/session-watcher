// test/claude-code.transcript-observation.test.js — Claude Code Transcript Observation Interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readClaudeCodeRows,
  reduceClaudeCodeSnapshot,
  createClaudeCodeObservationReducer,
} from '../lib/harness/claude-code/transcript-observation.js';
import {
  ts,
  userMessage,
  assistantObservation,
  assistantToolUse,
  toolResult,
  compactSummary,
} from './helpers/transcript-fixtures.js';

const MODEL = 'claude-opus-4-8';

function jsonl(entries) {
  return Buffer.from(entries.map(e => JSON.stringify(e) + '\n').join(''), 'utf8');
}

function rowsFrom(entries) {
  return readClaudeCodeRows(jsonl(entries), { atEof: true }).rows;
}

// The shared fixture builders carry no usage object, so the usage rows every measurement case needs
// are assembled from `assistantObservation` plus the native `message.usage` member.
function assistantUsage({
  uuid, parentUuid = null, messageId = null, blocks = [], timestamp = ts(0),
  model = MODEL, usage, extra = {},
}) {
  const entry = assistantObservation({ uuid, parentUuid, messageId, blocks, timestamp, model, extra });
  if (messageId === null) delete entry.message.id;
  entry.message.usage = usage;
  return entry;
}

function usageOf({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  return {
    input_tokens: input, output_tokens: output,
    cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
  };
}

function typesOf(observations) {
  return observations.map(o => o.type);
}

// --- Row reader ---

test('physical ordinals follow grep -n and malformed rows still consume an ordinal', () => {
  const input = Buffer.from('{"type":"user","uuid":"u1"}\nnot-json\n{"type":"assistant","uuid":"a1"}\n');
  const out = readClaudeCodeRows(input, { atEof: true });
  assert.deepEqual(out.rows.map(r => r.sourceOrdinal), [1, 3]);
  assert.equal(out.nextSourceOrdinal, 4);
});

test('CRLF rows parse normally and a malformed complete row still advances the committed offset', () => {
  const chunk = Buffer.from('{"a":1}\r\nnot-json\n{"b":2}\n', 'utf8');
  const out = readClaudeCodeRows(chunk, { baseOffset: 11 });

  assert.deepEqual(out.rows.map(r => r.entry), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(out.rows.map(r => r.sourceOrdinal), [1, 3]);
  assert.equal(out.nextOffset, 11 + chunk.length);
  assert.equal(out.nextSourceOrdinal, 4);
});

// The reader hands the parser a complete line at any size, and every boundary judgment reads a parsed field.
// The fixture's key order is the load-bearing half: the body is serialized ahead of `uuid` and
// `timestamp`, so a read that stopped short of this row's end would resolve neither of them.
const LONG_ROW_BYTES = 1024 * 1024;

test('a row past LONG_ROW_BYTES carries its uuid, normalized timestamp, and byte span; a missing uuid yields null', () => {
  const withUuid = {
    type: 'user',
    message: { content: 'x'.repeat(LONG_ROW_BYTES) },
    uuid: 'u1',
    timestamp: '2026-07-01T00:00:03Z',
  };
  const withoutUuid = { type: 'user', message: { content: 'ho' } };
  const chunk = jsonl([withUuid, withoutUuid]);
  const [first, second] = readClaudeCodeRows(chunk, { baseOffset: 100 }).rows;

  assert.equal(first.sourceEntryId, 'u1');
  assert.equal(first.timestamp, Date.parse('2026-07-01T00:00:03Z'));
  assert.ok(first.byteEnd - first.byteStart > LONG_ROW_BYTES, 'the fixture must be one row past the bound');
  assert.equal(first.byteStart, 100);
  assert.equal(first.byteEnd, 100 + JSON.stringify(withUuid).length + 1);
  assert.equal(second.sourceEntryId, null);
  assert.equal(second.timestamp, null);
  assert.equal(second.byteStart, first.byteEnd);
});

// The span is a BYTE span, so a row whose content is multi-byte must not be measured in code units: over
// CJK text a length-based end lands short of the LF and the next read would re-commit the tail.
test('a row byte span counts bytes, not code units, over multi-byte content', () => {
  const entry = { type: 'user', uuid: 'u1', message: { content: '你好世界' } };
  const line = JSON.stringify(entry) + '\n';
  const [row] = readClaudeCodeRows(Buffer.from(line, 'utf8'), { baseOffset: 100, atEof: true }).rows;

  assert.ok(Buffer.byteLength(line, 'utf8') > line.length, 'the fixture must be multi-byte');
  assert.equal(row.byteStart, 100);
  assert.equal(row.byteEnd, 100 + Buffer.byteLength(line, 'utf8'));
});

test('a byte budget ending before the LF commits no partial row', () => {
  const chunk = jsonl([{ a: 1 }, { b: 2 }]);
  const firstLine = JSON.stringify({ a: 1 }).length + 1;
  const out = readClaudeCodeRows(chunk, { baseOffset: 7, maxBytes: chunk.length - 1 });

  assert.deepEqual(out.rows.map(r => r.entry), [{ a: 1 }]);
  assert.equal(out.nextOffset, 7 + firstLine);
  assert.equal(out.nextSourceOrdinal, 2);
});

test('a byte budget ending inside a multi-byte code point commits no row and no replacement character', () => {
  const chunk = jsonl([{ text: '你好' }]);
  const cutInsideCodePoint = chunk.indexOf(Buffer.from('你', 'utf8')) + 2;

  const partial = readClaudeCodeRows(chunk, { maxBytes: cutInsideCodePoint });
  assert.deepEqual(partial.rows, []);
  assert.equal(partial.nextOffset, 0);
  assert.equal(partial.nextSourceOrdinal, 1);

  const complete = readClaudeCodeRows(chunk);
  assert.deepEqual(complete.rows.map(r => r.entry), [{ text: '你好' }]);
  assert.ok(!JSON.stringify(complete.rows).includes('�'), 'no replacement character');
});

test('a final newline-less row is committed only for a sealed read', () => {
  const chunk = Buffer.from('{"a":1}\n{"tail":true}', 'utf8');

  const live = readClaudeCodeRows(chunk);
  assert.deepEqual(live.rows.map(r => r.entry), [{ a: 1 }]);
  assert.equal(live.nextOffset, 8);

  const sealed = readClaudeCodeRows(chunk, { atEof: true });
  assert.deepEqual(sealed.rows.map(r => r.entry), [{ a: 1 }, { tail: true }]);
  assert.equal(sealed.nextOffset, chunk.length);
  assert.equal(sealed.nextSourceOrdinal, 3);
});

test('a read resumes from a caller-supplied offset and ordinal', () => {
  const out = readClaudeCodeRows(jsonl([{ a: 1 }]), { baseOffset: 512, sourceOrdinal: 9 });
  assert.deepEqual(out.rows.map(r => r.sourceOrdinal), [9]);
  assert.equal(out.rows[0].byteStart, 512);
  assert.equal(out.nextSourceOrdinal, 10);
});

// --- Batches, order, and identity ---

// A text block with nothing in it says nothing about the conversation, and admitting it as an observation
// would make a row whose blocks are all empty indistinguishable from a row that spoke. The block form is
// what is suppressed: a string `content` is the whole row's text, and an empty one is still that row's body.
test('an empty text block emits no observation, while an empty string content still does', () => {
  const { batches } = reduceClaudeCodeSnapshot(rowsFrom([
    { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: ts(1),
      message: { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'u1', isSidechain: false, timestamp: ts(2),
      message: { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'spoke' }] } },
    { type: 'user', uuid: 'u3', parentUuid: 'u2', isSidechain: false, timestamp: ts(3),
      message: { role: 'user', content: '' } },
  ]));
  const texts = batches.flat().filter(o => o.type === 'text');
  assert.deepEqual(texts.map(o => [o.sourceEntryId, o.text]), [['u2', 'spoke'], ['u3', '']]);
  // The all-empty row keeps its ordinal and its turn boundary; only its content observation is absent.
  assert.deepEqual(batches[0].map(o => o.type), ['turn-boundary']);
});

test('an empty text block on an assistant row emits no observation either', () => {
  const { batches } = reduceClaudeCodeSnapshot(rowsFrom([
    assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: ts(1),
      blocks: [{ type: 'text', text: '' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }] }),
  ]));
  assert.deepEqual(typesOf(batches[0]), ['tool-use']);
});

test('content blocks retain native order and the usage observation is last', () => {
  const rows = rowsFrom([assistantUsage({
    uuid: 'a1', messageId: 'msg_1', timestamp: ts(1),
    blocks: [
      { type: 'text', text: 'first' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/a.js' } },
      { type: 'text', text: 'second' },
    ],
    usage: usageOf({ input: 2, output: 110, cacheRead: 137000, cacheWrite: 2446 }),
  })]);
  const { batches } = reduceClaudeCodeSnapshot(rows);

  assert.equal(batches.length, 1);
  assert.deepEqual(typesOf(batches[0]), ['text', 'tool-use', 'text', 'usage']);
  assert.deepEqual(batches[0].filter(o => o.type === 'text').map(o => o.text), ['first', 'second']);
  assert.equal(batches[0][0].role, 'assistant');
  assert.equal(batches[0][0].provenance, 'assistant');
  assert.equal(batches[0].at(-1).provenance, 'assistant');
});

test('every observation of one native row shares its source position, entry id, and timestamp', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({
      uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'ok' }],
      usage: usageOf({ output: 5, cacheRead: 100 }),
    }),
  ]);
  const batch = reduceClaudeCodeSnapshot(rows).batches.at(-1);

  for (const observation of batch) {
    assert.equal(observation.sourceOrdinal, 2);
    assert.equal(observation.sourceEntryId, 'a1');
    assert.equal(observation.timestamp, Date.parse(ts(2)));
  }
});

test('observations retain no raw row, byte offset, or native entry at any depth', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({
      uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
      usage: usageOf({ output: 5, cacheRead: 100 }),
    }),
    toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 'tu_1', content: 'ok',
      timestamp: ts(3), toolUseResult: { stdout: 'ok' } }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);
  const forbidden = ['raw', 'entry', 'byteStart', 'byteEnd'];

  assert.ok(observations.some(o => o.type === 'tool-result'), 'the nested-member carrier is present');
  const walk = (value, trail) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      assert.ok(!forbidden.includes(key), `${trail}.${key} retains a source-cursor or native member`);
      walk(value[key], `${trail}.${key}`);
    }
  };
  for (const observation of observations) walk(observation, observation.type);
});

test('a missing uuid yields sourceEntryId null on every observation of that row', () => {
  const rows = rowsFrom([{
    type: 'assistant', timestamp: ts(1),
    message: { id: 'msg_1', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text: 'ok' }], usage: usageOf({ output: 5, cacheRead: 100 }) },
  }]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  assert.equal(observations.length, 2);
  assert.ok(observations.every(o => o.sourceEntryId === null));
});

test('message.id is namespaced and a missing id uses a separately namespaced row-local key', () => {
  const rows = rowsFrom([
    assistantUsage({ uuid: 'a1', messageId: '2', usage: usageOf({ output: 5, cacheRead: 100 }) }),
    assistantUsage({ uuid: 'a2', parentUuid: 'a1', usage: usageOf({ output: 6, cacheRead: 100 }) }),
  ]);
  const usages = reduceClaudeCodeSnapshot(rows).observations.filter(o => o.type === 'usage');

  assert.equal(usages.length, 2);
  const [native, rowLocal] = usages;
  assert.notEqual(native.messageId, '2', 'native id is namespaced, not raw');
  assert.ok(native.messageId.includes('2'));
  assert.ok(rowLocal.messageId.includes('2'), 'row-local key derives from sourceOrdinal');
  assert.notEqual(rowLocal.messageId, native.messageId, 'the two namespaces cannot collide');
});

test('a row-local message key is deterministic and distinct per source ordinal', () => {
  const build = () => rowsFrom([
    assistantUsage({ uuid: 'a1', usage: usageOf({ output: 5, cacheRead: 100 }) }),
    assistantUsage({ uuid: 'a2', parentUuid: 'a1', usage: usageOf({ output: 6, cacheRead: 100 }) }),
  ]);
  const first = reduceClaudeCodeSnapshot(build()).observations.filter(o => o.type === 'usage');
  const second = reduceClaudeCodeSnapshot(build()).observations.filter(o => o.type === 'usage');

  assert.equal(first[0].messageId, second[0].messageId);
  assert.notEqual(first[0].messageId, first[1].messageId);
});

// Streaming writes one logical message as several rows sharing its id. This layer observes rows; collapsing
// them by identity is the Engine's revision rule, so every row must still arrive with the same message key.
test('rows sharing one message.id each observe separately under that one key', () => {
  const rows = rowsFrom([
    assistantUsage({ uuid: 'a1', messageId: 'msg_1', timestamp: ts(1),
      usage: usageOf({ output: 5, cacheRead: 100 }) }),
    assistantUsage({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_1', timestamp: ts(2),
      usage: usageOf({ output: 9, cacheRead: 100 }) }),
  ]);
  const usages = reduceClaudeCodeSnapshot(rows).observations.filter(o => o.type === 'usage');

  assert.equal(usages.length, 2, 'neither row is dropped as a duplicate here');
  assert.equal(usages[0].messageId, usages[1].messageId, 'one logical message, one key');
  assert.deepEqual(usages.map(o => o.sourceEntryId), ['a1', 'a2'], 'source order is preserved');
});

test('legacy requestId and request_id are ignored as message identity', () => {
  const rows = rowsFrom([assistantUsage({
    uuid: 'a1', usage: usageOf({ output: 5, cacheRead: 100 }),
    extra: { requestId: 'req_camel', request_id: 'req_snake' },
  })]);
  const usage = reduceClaudeCodeSnapshot(rows).observations.find(o => o.type === 'usage');

  assert.ok(!usage.messageId.includes('req_camel'));
  assert.ok(!usage.messageId.includes('req_snake'));
});

test('an assistant tool-use copies its row messageId, model, and string cwd', () => {
  const rows = rowsFrom([assistantToolUse({
    uuid: 'a1', messageId: 'msg_1', toolUseId: 'tu_1', name: 'Read',
    input: { file_path: '/tmp/a.js' }, timestamp: ts(1),
  })].map(entry => ({ ...entry, cwd: '/repo' })));
  const [toolUse] = reduceClaudeCodeSnapshot(rows).observations;

  assert.equal(toolUse.type, 'tool-use');
  assert.equal(toolUse.toolUseId, 'tu_1');
  assert.equal(toolUse.name, 'Read');
  assert.deepEqual(toolUse.input, { file_path: '/tmp/a.js' });
  assert.equal(toolUse.model, MODEL);
  assert.equal(toolUse.cwd, '/repo');
  assert.ok(toolUse.messageId.includes('msg_1'));
});

test('an absent or invalid cwd becomes null and no other observation carries it', () => {
  const absent = assistantToolUse({
    uuid: 'a1', messageId: 'msg_1', toolUseId: 'tu_1', name: 'Read', input: {}, timestamp: ts(1), text: 'why',
  });
  const invalid = { ...assistantToolUse({
    uuid: 'a2', parentUuid: 'a1', messageId: 'msg_2', toolUseId: 'tu_2', name: 'Read', input: {}, timestamp: ts(2),
  }), cwd: 42 };
  const observations = reduceClaudeCodeSnapshot(rowsFrom([absent, invalid])).observations;
  const toolUses = observations.filter(o => o.type === 'tool-use');

  assert.equal(toolUses.length, 2);
  assert.ok(toolUses.every(o => o.cwd === null));
  assert.ok(observations.filter(o => o.type !== 'tool-use').every(o => !Object.hasOwn(o, 'cwd')));
});

test('a tool-result carries its native content, raw error flag, and uninterpreted result meta', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    toolResult({ uuid: 'r1', parentUuid: 'u1', toolUseId: 'tu_1', content: 'boom',
      isError: true, timestamp: ts(3), toolUseResult: { stdout: 'boom' } }),
    toolResult({ uuid: 'r2', parentUuid: 'r1', toolUseId: 'tu_2', content: 'ok', timestamp: ts(4) }),
  ]);
  const results = reduceClaudeCodeSnapshot(rows).observations.filter(o => o.type === 'tool-result');

  assert.equal(results.length, 2);
  assert.equal(results[0].toolUseId, 'tu_1');
  assert.equal(results[0].content, 'boom');
  assert.equal(results[0].isError, true);
  assert.deepEqual(results[0].resultMeta, { annotation: { stdout: 'boom' } });
  assert.equal(results[0].timestamp, Date.parse(ts(3)), 'the row time is the observation timestamp');
  assert.deepEqual(results[1].resultMeta, { annotation: undefined },
    'a result row with no annotation is still an annotation carrier');
  assert.equal(results[0].provenance, 'harness');
  assert.equal(results[1].isError, undefined, 'an absent is_error stays distinct from false');
});

// --- Turn boundaries ---

test('a normal main-chain user row emits exactly one turn-boundary', () => {
  const rows = rowsFrom([userMessage({ uuid: 'u1', text: '开始写 plan', timestamp: ts(1) })]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  assert.deepEqual(typesOf(observations), ['turn-boundary', 'text']);
  assert.equal(observations[0].provenance, 'human');
  assert.equal(observations[1].role, 'human');
  assert.equal(observations[1].provenance, 'human');
  assert.equal(observations[1].text, '开始写 plan');
});

test('a compact-summary row emits no text and no turn-boundary, and the tool-result under it opens no turn', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    { ...compactSummary({ uuid: 'c1', timestamp: ts(2), text: 'summary' }), parentUuid: 'u1' },
    toolResult({ uuid: 'r1', parentUuid: 'c1', toolUseId: 'tu_1', content: 'ok', timestamp: ts(3) }),
  ]);
  const { observations, activePath } = reduceClaudeCodeSnapshot(rows);

  // The tool-result row is parented to the compact summary, so its observation exists only while the
  // summary row is indexed and canonical — that is what keeps this from passing vacuously.
  assert.deepEqual(activePath, ['u1', 'c1', 'r1']);
  assert.deepEqual(typesOf(observations), ['turn-boundary', 'text', 'tool-result']);
  assert.ok(observations.every(o => o.sourceOrdinal !== 2), 'the compact-summary row emits nothing');
  assert.equal(observations.find(o => o.type === 'tool-result').sourceOrdinal, 3);
});

// The call ahead of the summary root is what a compact replaces, and it is also what tells the root apart
// from the session-start preamble — a root with no call behind it opens nothing.
test('a compact-summary root emits exactly its epoch-boundary', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), cacheRead: 10_000 }),
    compactSummary({ uuid: 'c1', timestamp: ts(3), text: 'This session is being continued…' }),
  ]);
  const { batches } = reduceClaudeCodeSnapshot(rows);

  assert.deepEqual(typesOf(batches.at(-1)), ['epoch-boundary']);
  assert.equal(batches.at(-1)[0].sourceEntryId, 'c1');
  assert.equal(batches.at(-1)[0].sourceOrdinal, 3);
});

test('a task-notification row emits exactly one task-notification observation', () => {
  const text = '<task-notification><task-id>abcdef0123</task-id><summary>Agent "x" finished</summary></task-notification>';
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    userMessage({ uuid: 'n1', parentUuid: 'u1', text, timestamp: ts(2) }),
  ]);
  const batch = reduceClaudeCodeSnapshot(rows).batches.at(-1);

  assert.deepEqual(typesOf(batch), ['task-notification']);
  assert.equal(batch[0].text, text);
  assert.equal(batch[0].provenance, 'harness');
  assert.equal(batch[0].sourceEntryId, 'n1');
});

// The tag is recognized only at the head of the content, so human prose that quotes it mid-sentence is
// still a human turn. A substring match here would swallow real turns whenever a person discusses the tag.
test('human prose quoting the task-notification tag is still a turn boundary', () => {
  const text = 'why did the <task-notification> arrive before the agent finished?';
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    userMessage({ uuid: 'u2', parentUuid: 'u1', text, timestamp: ts(2) }),
  ]);
  const batch = reduceClaudeCodeSnapshot(rows).batches.at(-1);

  assert.deepEqual(typesOf(batch), ['turn-boundary', 'text']);
  assert.equal(batch[1].text, text);
});

test('a meta row emits no text or turn-boundary and a string sourceToolUseID yields one skill-payload', () => {
  const withId = {
    type: 'user', uuid: 'm1', parentUuid: 'u1', isSidechain: false, isMeta: true,
    sourceToolUseID: 'tu_skill', timestamp: ts(2),
    message: { role: 'user', content: [
      { type: 'text', text: 'alpha' },
      { type: 'text', text: 'beta' },
    ] },
  };
  const withoutId = {
    type: 'user', uuid: 'm2', parentUuid: 'm1', isSidechain: false, isMeta: true, timestamp: ts(3),
    message: { role: 'user', content: [{ type: 'text', text: 'gamma' }] },
  };
  const rows = rowsFrom([userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }), withId, withoutId]);
  const { batches, observations } = reduceClaudeCodeSnapshot(rows);

  assert.equal(observations.filter(o => o.type === 'text').length, 1, 'only the human row emits text');
  assert.equal(observations.filter(o => o.type === 'turn-boundary').length, 1);
  const payloads = observations.filter(o => o.type === 'skill-payload');
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].toolUseId, 'tu_skill');
  assert.equal(payloads[0].text, 'alphabeta');
  assert.equal(payloads[0].provenance, 'harness');
  assert.deepEqual(typesOf(batches.at(-1)), ['skill-payload'], 'the meta row without an id emits no batch');
});

// --- Topology, epochs, and canonical path ---

test('[delta] only canonical topology roots emit epoch-boundary; stock drops do not', () => {
  const observations = reduceClaudeCodeSnapshot(rowsWithLargeUsageStockDropButOneRoot()).observations;
  assert.equal(observations.filter(o => o.type === 'epoch-boundary').length, 0);
});

function rowsWithLargeUsageStockDropButOneRoot() {
  return rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      usage: usageOf({ input: 20, output: 40, cacheRead: 400000, cacheWrite: 1000 }) }),
    assistantUsage({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_2', timestamp: ts(3),
      usage: usageOf({ input: 20, output: 40, cacheRead: 1000, cacheWrite: 0 }) }),
  ]);
}

// The root here carries the Source's first call, so the call it reports is the evidence for its own
// boundary: a root at or after the first call opens, since a missed reset carries the anchor across a real
// reset while a spurious boundary only misnumbers a segment.
test('[delta] epoch-boundary is first in its native-row batch', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'a1', messageId: 'msg_1', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'after compact' }],
      usage: usageOf({ input: 2, output: 5, cacheRead: 100 }) }),
  ]);
  const batch = reduceClaudeCodeSnapshot(rows).batches.at(-1);
  assert.equal(batch[0].type, 'epoch-boundary');
  assert.equal(batch.at(-1).type, 'usage');
  assert.equal(batch[0].provenance, 'harness');
  assert.equal(batch[0].sourceEntryId, 'a1');
});

test('each canonical root with a call behind it opens one epoch in source order', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'one', timestamp: ts(1) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), cacheRead: 10_000 }),
    userMessage({ uuid: 'u2', text: 'two', timestamp: ts(3) }),
    userMessage({ uuid: 'u3', parentUuid: 'u2', text: 'three', timestamp: ts(4) }),
    userMessage({ uuid: 'u4', text: 'four', timestamp: ts(5) }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);
  const epochs = observations.filter(o => o.type === 'epoch-boundary');

  assert.deepEqual(epochs.map(o => o.sourceEntryId), ['u2', 'u4']);
  assert.deepEqual(epochs.map(o => o.sourceOrdinal), [3, 5]);
});

// The session-start preamble: a meta user root carrying the slash-command echo, then a null-parent
// attachment chain the conversation hangs off. Both roots are written before the Source's first call, and the
// harness stamps them alike, so the shape is told apart by write order alone.
function preambleRows() {
  return [
    userMessage({ uuid: 'u-meta', parentUuid: null, timestamp: ts(1),
      text: '<local-command-caveat>Caveat: …</local-command-caveat>', extra: { isMeta: true } }),
    userMessage({ uuid: 'u-clear', parentUuid: 'u-meta', text: '<command-name>/clear</command-name>', timestamp: ts(1) }),
    { type: 'system', subtype: 'local_command', uuid: 'sys-clear', parentUuid: 'u-clear', isSidechain: false,
      isMeta: false, content: '<local-command-stdout></local-command-stdout>', level: 'info', timestamp: ts(1) },
    attachmentRow({ uuid: 'att-root', parentUuid: null, timestamp: ts(1) }),
    attachmentRow({ uuid: 'att-tail', parentUuid: 'att-root', timestamp: ts(1) }),
  ];
}

function attachmentRow({ uuid, parentUuid, timestamp }) {
  return {
    type: 'attachment', uuid, parentUuid, isSidechain: false, timestamp,
    attachment: { type: 'hook_success', hookName: 'SessionStart:clear', hookEvent: 'SessionStart', content: '' },
  };
}

// A real compact boundary is two rows: the harness writes a null-parent `system` row carrying its own
// boundary subtype, then restates the replaced prefix as the marked summary on that root's child.
function compactBoundaryRows({ rootUuid, summaryUuid, logicalParentUuid, timestamp }) {
  return [
    { type: 'system', subtype: 'compact_boundary', uuid: rootUuid, parentUuid: null, logicalParentUuid,
      isSidechain: false, content: 'Conversation compacted', level: 'info', timestamp },
    { type: 'user', uuid: summaryUuid, parentUuid: rootUuid, isSidechain: false, isCompactSummary: true,
      isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued…' },
      timestamp },
  ];
}

function firstCall({ uuid, parentUuid, messageId, timestamp, cacheRead, cacheWrite = 5_000 }) {
  return assistantUsage({ uuid, parentUuid, messageId, timestamp, blocks: [{ type: 'text', text: 'ok' }],
    usage: usageOf({ input: 2, output: 100, cacheRead, cacheWrite }) });
}

test('a null-parent root written before the first call opens no epoch', () => {
  const rows = rowsFrom([
    ...preambleRows(),
    userMessage({ uuid: 'u1', parentUuid: 'att-tail', text: 'go', timestamp: ts(2) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(3), cacheRead: 10_000 }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  assert.equal(observations.filter(o => o.type === 'epoch-boundary').length, 0);
});

// Acceptance is resolution-dependent: the fork under the earlier root moves that root's canonical branch off
// the first call, so that call is not an accepted row at all, and a judgment that read the call only while it
// was accepted would answer differently depending on whether the Source arrived whole or in chunks — and the
// whole-Source answer is also what a rebuild takes.
test('a fork under an earlier root leaves the reset epoch identical whole and in chunks', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'one', timestamp: ts(1) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), cacheRead: 10_000 }),
    userMessage({ uuid: 'fork', parentUuid: 'u1', text: 'said again', timestamp: ts(3) }),
    userMessage({ uuid: 'u2', text: 'after a reset', timestamp: ts(4) }),
    firstCall({ uuid: 'a2', parentUuid: 'u2', messageId: 'msg_2', timestamp: ts(5), cacheRead: 2_000 }),
  ]);
  const epochsOf = (batches) => batches.flat().filter(o => o.type === 'epoch-boundary').map(o => o.sourceEntryId);

  const whole = epochsOf(reduceClaudeCodeSnapshot(rows).batches);
  const reducer = createClaudeCodeObservationReducer();
  const chunked = rows.flatMap(row => epochsOf(reducer.append([row]).batches));

  assert.deepEqual(whole, ['u2'], 'the reset root opens its epoch');
  assert.deepEqual(chunked, whole);
});

// A rewind moves the conversation back onto an EARLIER root's chain, so the branch it leaves is rooted
// later and stops being written. Write order is the only evidence of that: the abandoned branch's own
// rows are older, and the harness stamps a child's time before its parent's often enough that the clock
// cannot say which side the conversation is on.
function rewoundRows() {
  return rowsFrom([
    ...preambleRows(),
    userMessage({ uuid: 'u1', parentUuid: 'att-tail', text: 'go', timestamp: ts(2) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(3), cacheRead: 10_000 }),
    firstCall({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_2', timestamp: ts(4), cacheRead: 15_000 }),
    userMessage({ uuid: 'u2', parentUuid: 'u-clear', text: 'rewound', timestamp: ts(5) }),
    firstCall({ uuid: 'a3', parentUuid: 'u2', messageId: 'msg_3', timestamp: ts(6), cacheRead: 9_000 }),
  ]);
}

test('no call on a branch rooted after the live one is folded', () => {
  const { observations } = reduceClaudeCodeSnapshot(rewoundRows());

  assert.deepEqual(observations.filter(o => o.type === 'usage').map(o => o.sourceEntryId), ['a3']);
});

test('the active leaf and the accepted ids resolve from one root', () => {
  const { activeLeafId, activePath } = reduceClaudeCodeSnapshot(rewoundRows());

  assert.equal(activeLeafId, 'a3');
  assert.deepEqual(activePath, ['u-meta', 'u-clear', 'u2', 'a3']);
});

// The newest write can sit on an island — a row whose parent was never written — which is in no root's
// subtree, so no root holds it and the live one cannot be located. The last root stands in, accepting every
// root's branch the way this rule's predecessor did.
test('an island holding the newest write leaves the last root live', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'one', timestamp: ts(1) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), cacheRead: 10_000 }),
    userMessage({ uuid: 'u2', text: 'after a reset', timestamp: ts(3) }),
    firstCall({ uuid: 'a2', parentUuid: 'u2', messageId: 'msg_2', timestamp: ts(4), cacheRead: 2_000 }),
    firstCall({ uuid: 'island', parentUuid: 'never-written', messageId: 'msg_3', timestamp: ts(5),
      cacheRead: 3_000 }),
  ]);
  const { observations, activeLeafId, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.deepEqual(observations.filter(o => o.type === 'usage').map(o => o.sourceEntryId), ['a1', 'a2']);
  assert.equal(activeLeafId, 'a2');
  assert.deepEqual(activePath, ['u2', 'a2']);
});

// A row written under an earlier root withdraws every later root when it is the Source's NEWEST write: that
// makes the earlier root live, and what the caller holds is rooted past it, so the extension cannot be
// appended beside delivered rows the live conversation no longer reaches. A write that leaves a newer one
// standing on a later root moves no root and withdraws nothing, which is what
// `HD-WITHDRAWAL-TESTS-THE-ACTIVE-LEAF-ONLY` carries.
test('the newest write landing under an earlier root withdraws the later root', () => {
  const reducer = createClaudeCodeObservationReducer();
  reducer.append(rowsFrom([
    userMessage({ uuid: 'u1', text: 'one', timestamp: ts(1) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), cacheRead: 10_000 }),
    userMessage({ uuid: 'u2', text: 'after a reset', timestamp: ts(3) }),
    firstCall({ uuid: 'a2', parentUuid: 'u2', messageId: 'msg_2', timestamp: ts(4), cacheRead: 2_000 }),
  ]));

  const extension = reducer.append(readClaudeCodeRows(jsonl([
    userMessage({ uuid: 'u3', parentUuid: 'a1', text: 'back on the earlier root', timestamp: ts(5) }),
  ]), { sourceOrdinal: 5 }).rows);

  assert.equal(extension.staleBranch, true);
  assert.deepEqual(extension.batches, []);
});

// Acceptance is resolution-dependent in BOTH directions. A root can be rejected on the very advance that
// carried its row — a straggler under an earlier root arriving alongside it makes that earlier root live —
// and a later write can readmit it once its own row is long past. Readmission is a stale branch for the same
// reason a withdrawal is: the delivered history stops matching what a whole-Source read gives, and the row
// that would carry the readmitted root's epoch is not in any later advance to open it.
test('a root readmitted after its own advance reports a stale branch', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'one', timestamp: ts(1) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), cacheRead: 10_000 }),
    userMessage({ uuid: 'u2', text: 'after a reset', timestamp: ts(3) }),
    userMessage({ uuid: 'x', parentUuid: 'a1', text: 'straggler under the earlier root', timestamp: ts(4) }),
    firstCall({ uuid: 'y', parentUuid: 'u2', messageId: 'msg_2', timestamp: ts(5), cacheRead: 2_000 }),
  ]);
  const reducer = createClaudeCodeObservationReducer();
  reducer.append(rows.slice(0, 2));
  const rejecting = reducer.append(rows.slice(2, 4));
  const readmitting = reducer.append(rows.slice(4));

  assert.equal(rejecting.staleBranch, false, 'rejecting the new root withdraws nothing the caller holds');
  assert.equal(readmitting.staleBranch, true);
  assert.deepEqual(readmitting.batches, []);
});

test('a compact boundary root opens its epoch in a session whose preamble is exempt', () => {
  const rows = rowsFrom([
    ...preambleRows(),
    userMessage({ uuid: 'u1', parentUuid: 'att-tail', text: 'go', timestamp: ts(2) }),
    firstCall({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(3), cacheRead: 10_000 }),
    ...compactBoundaryRows({ rootUuid: 'sys-root', summaryUuid: 'c1', logicalParentUuid: 'a1', timestamp: ts(4) }),
    firstCall({ uuid: 'a2', parentUuid: 'c1', messageId: 'msg_2', timestamp: ts(5), cacheRead: 2_000 }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);
  const epochs = observations.filter(o => o.type === 'epoch-boundary');

  assert.deepEqual(epochs.map(o => o.sourceEntryId), ['sys-root']);
});

test('logicalParentUuid and isCompactSummary alone do not emit an epoch', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    { ...compactSummary({ uuid: 'c1', timestamp: ts(2) }), parentUuid: 'u1', logicalParentUuid: 'u1' },
    userMessage({ uuid: 'u2', parentUuid: 'c1', text: 'go on', timestamp: ts(3),
      extra: { logicalParentUuid: null } }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  assert.equal(observations.filter(o => o.type === 'epoch-boundary').length, 0);
});

test('[delta] a sidechain row emits no observation and does not enter topology', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      usage: usageOf({ input: 2, output: 5, cacheRead: 100 }) }),
    assistantUsage({ uuid: 'side1', parentUuid: 'a1', messageId: 'msg_side', timestamp: ts(3),
      blocks: [{ type: 'text', text: 'subagent' }],
      usage: usageOf({ input: 9, output: 9, cacheRead: 900 }),
      extra: { isSidechain: true } }),
  ]);
  const { observations, activeLeafId, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.ok(observations.every(o => o.sourceEntryId !== 'side1'), 'no observation from a sidechain row');
  assert.ok(observations.every(o => o.sourceOrdinal !== 3), 'the sidechain row contributes no batch');
  assert.equal(activeLeafId, 'a1', 'the newest write ignores the sidechain row');
  assert.ok(!activePath.includes('side1'), 'the sidechain row is absent from the canonical path');
});

test('the canonical active path keeps the newest write of each root and drops abandoned siblings', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'stub', parentUuid: 'u1', messageId: 'msg_stub', timestamp: ts(2),
      usage: usageOf({ output: 1, cacheRead: 100 }) }),
    assistantUsage({ uuid: 'live', parentUuid: 'u1', messageId: 'msg_live', timestamp: ts(3),
      usage: usageOf({ output: 2, cacheRead: 200 }) }),
  ]);
  const { observations, activeLeafId, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.equal(activeLeafId, 'live');
  assert.deepEqual(activePath, ['u1', 'live']);
  assert.ok(observations.every(o => o.sourceEntryId !== 'stub'), 'the abandoned sibling is not accepted');
});

// The rule is the newest physical WRITE, which is not the deepest node and not the last node a subtree walk
// happens to reach: here the abandoned branch is both deeper and written earlier than the live sibling.
test('the newest write wins over a deeper branch written before it', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    userMessage({ uuid: 'old-deep', parentUuid: 'u1', text: 'abandoned', timestamp: ts(2) }),
    assistantUsage({ uuid: 'old-leaf', parentUuid: 'old-deep', messageId: 'msg_old', timestamp: ts(3),
      usage: usageOf({ output: 1, cacheRead: 100 }) }),
    assistantUsage({ uuid: 'newer', parentUuid: 'u1', messageId: 'msg_new', timestamp: ts(4),
      usage: usageOf({ output: 2, cacheRead: 200 }) }),
  ]);
  const { observations, activeLeafId, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.equal(activeLeafId, 'newer');
  assert.deepEqual(activePath, ['u1', 'newer']);
  const accepted = new Set(observations.map(o => o.sourceEntryId));
  assert.ok(!accepted.has('old-deep') && !accepted.has('old-leaf'), 'the deeper older branch is abandoned');
});

// Two tool_use blocks of one logical message are written as two rows, and each tool_result names the row
// carrying ITS OWN tool use. So the fork's LAST-written child is the first call's one-row result stub while
// the continuation is an earlier sibling — the shape real parallel tool calls produce.
test('a parallel-tool-call fork keeps the continuation, not the earlier result stub', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', toolUseId: 'tu_1',
      name: 'Read', input: { file_path: '/a.js' }, timestamp: ts(2) }),
    assistantToolUse({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_1', toolUseId: 'tu_2',
      name: 'Read', input: { file_path: '/b.js' }, timestamp: ts(3) }),
    toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 'tu_1', content: 'a', timestamp: ts(4) }),
    toolResult({ uuid: 'tr2', parentUuid: 'a2', toolUseId: 'tu_2', content: 'b', timestamp: ts(5) }),
    assistantUsage({ uuid: 'a3', parentUuid: 'tr2', messageId: 'msg_2', timestamp: ts(6),
      usage: usageOf({ output: 3, cacheRead: 300 }) }),
  ]);
  const { activeLeafId, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.equal(activeLeafId, 'a3');
  assert.deepEqual(activePath, ['u1', 'a1', 'a2', 'tr2', 'a3']);
});

// Every result of a parallel batch but the last call's is a sibling leaf off the ancestor chain, because a
// result is parented to its own call's row while the continuation hangs off whichever result landed last.
// A result row is accepted with the row it hangs from; the chain itself is unchanged. This is the shape of
// `fixtures/f6008161-20260921.jsonl`, results returned out of order.
test('a result row under an accepted row is accepted off the ancestor chain', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', toolUseId: 'tu_1',
      name: 'Read', input: { file_path: '/a.md' }, timestamp: ts(2) }),
    assistantToolUse({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_1', toolUseId: 'tu_2',
      name: 'Read', input: { file_path: '/b.md' }, timestamp: ts(3) }),
    assistantToolUse({ uuid: 'a3', parentUuid: 'a2', messageId: 'msg_1', toolUseId: 'tu_3',
      name: 'Read', input: { file_path: '/c.md' }, timestamp: ts(4) }),
    toolResult({ uuid: 'tr3', parentUuid: 'a3', toolUseId: 'tu_3', content: 'c', timestamp: ts(5) }),
    assistantToolUse({ uuid: 'a4', parentUuid: 'tr3', messageId: 'msg_1', toolUseId: 'tu_4',
      name: 'Skill', input: { skill: 's' }, timestamp: ts(6) }),
    toolResult({ uuid: 'tr2', parentUuid: 'a2', toolUseId: 'tu_2', content: 'b', timestamp: ts(7) }),
    toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 'tu_1', content: 'a', timestamp: ts(8) }),
    toolResult({ uuid: 'tr4', parentUuid: 'a4', toolUseId: 'tu_4', content: 'ok', timestamp: ts(9) }),
    userMessage({ uuid: 'u2', parentUuid: 'tr4', text: 'next', timestamp: ts(10) }),
  ]);
  const { observations, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.deepEqual(activePath, ['u1', 'a1', 'a2', 'a3', 'tr3', 'a4', 'tr4', 'u2'], 'the chain is unchanged');
  const results = observations.filter(o => o.type === 'tool-result');
  assert.deepEqual(results.map(o => o.sourceEntryId), ['tr3', 'tr2', 'tr1', 'tr4'], 'results arrive in row order');
  assert.deepEqual(new Set(results.map(o => o.toolUseId)), new Set(['tu_1', 'tu_2', 'tu_3', 'tu_4']));
});

// The shape of `fixtures/decf0f2c-20260703.jsonl`: results return in call order, and the first one is off
// the chain all the same, because the continuation is parented to the last.
test('an in-order parallel batch admits the first call\'s result', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantToolUse({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', toolUseId: 'tu_1',
      name: 'Bash', input: { command: 'ls' }, timestamp: ts(2) }),
    assistantToolUse({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_1', toolUseId: 'tu_2',
      name: 'Bash', input: { command: 'pwd' }, timestamp: ts(3) }),
    toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 'tu_1', content: 'a', timestamp: ts(4) }),
    toolResult({ uuid: 'tr2', parentUuid: 'a2', toolUseId: 'tu_2', content: 'b', timestamp: ts(5) }),
    assistantUsage({ uuid: 'a3', parentUuid: 'tr2', messageId: 'msg_2', timestamp: ts(6),
      usage: usageOf({ output: 3, cacheRead: 300 }) }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  const results = observations.filter(o => o.type === 'tool-result').map(o => o.toolUseId);
  assert.deepEqual(results, ['tu_1', 'tu_2']);
});

// A rewound branch begins at a human row — the one the human replaced — so the row at its fork is never a
// result, and every result deeper in it hangs from a row the chain does not reach. The shape of
// `fixtures/f6008161-20260921.jsonl`: a Bash and a Read, an interrupt, then the human rewinds to before the
// question and asks again.
test('a rewound branch\'s results stay out with its branch', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u0', text: 'earlier', timestamp: ts(1) }),
    userMessage({ uuid: 'u1', parentUuid: 'u0', text: 'first ask', timestamp: ts(2) }),
    assistantToolUse({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', toolUseId: 'tu_1',
      name: 'Bash', input: { command: 'ls' }, timestamp: ts(3) }),
    toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 'tu_1', content: 'a', timestamp: ts(4) }),
    assistantToolUse({ uuid: 'a2', parentUuid: 'tr1', messageId: 'msg_1', toolUseId: 'tu_2',
      name: 'Read', input: { file_path: '/a.md' }, timestamp: ts(5) }),
    toolResult({ uuid: 'tr2', parentUuid: 'a2', toolUseId: 'tu_2', content: 'b', timestamp: ts(6) }),
    userMessage({ uuid: 'stop', parentUuid: 'tr2', text: '[Request interrupted by user]', timestamp: ts(7) }),
    userMessage({ uuid: 'u2', parentUuid: 'u0', text: 'second ask', timestamp: ts(8) }),
  ]);
  const { observations, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.deepEqual(activePath, ['u0', 'u2']);
  const abandoned = new Set(['u1', 'a1', 'tr1', 'a2', 'tr2', 'stop']);
  assert.ok(observations.every(o => !abandoned.has(o.sourceEntryId)), 'nothing on the rewound branch is observed');
  assert.equal(observations.filter(o => o.type === 'tool-result').length, 0);
});

// A reused uuid is the one shape that gives the newest write children of its own: `dup` is written under u1
// with a child, then written again under a later sibling. Descending by last-added child would land on the
// stale child, and walking up the now-cyclic parent edges would not terminate.
test('a reused uuid resolves to its last write and terminates the path walk', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    userMessage({ uuid: 'dup', parentUuid: 'u1', text: 'first write', timestamp: ts(2) }),
    userMessage({ uuid: 'stale-child', parentUuid: 'dup', text: 'stale', timestamp: ts(3) }),
    userMessage({ uuid: 'sibling', parentUuid: 'u1', text: 'sibling', timestamp: ts(4) }),
    userMessage({ uuid: 'dup', parentUuid: 'sibling', text: 'second write', timestamp: ts(5) }),
  ]);
  const { activeLeafId, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.equal(activeLeafId, 'dup', 'the leaf is the last row written, not its stale child');
  assert.ok(!activePath.includes('stale-child'), 'the stale child is off the path');
  assert.ok(activePath.length <= 4, `the walk terminates: ${JSON.stringify(activePath)}`);
});

test('a row whose parent was never written stays out of every canonical path', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'island', parentUuid: 'never-written', messageId: 'msg_i', timestamp: ts(2),
      usage: usageOf({ output: 1, cacheRead: 100 }) }),
  ]);
  const { observations, activePath } = reduceClaudeCodeSnapshot(rows);

  assert.deepEqual(activePath, ['u1']);
  assert.ok(observations.every(o => o.sourceEntryId !== 'island'));
});

test('a uuid-less row is accepted alongside the canonical path', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    { type: 'user', timestamp: ts(2), message: { role: 'user', content: 'no uuid here' } },
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  assert.equal(observations.filter(o => o.type === 'text').length, 2);
});

// --- Usage normalization through the observation Interface ---

test('the flat cache_creation_input_tokens field maps to cacheWrite', () => {
  const rows = rowsFrom([assistantUsage({ uuid: 'a1', messageId: 'msg_1',
    usage: usageOf({ input: 2, output: 110, cacheRead: 137000, cacheWrite: 2446 }) })]);
  const usage = reduceClaudeCodeSnapshot(rows).observations.find(o => o.type === 'usage');

  assert.deepEqual(usage.usage, { input: 2, output: 110, cacheRead: 137000, cacheWrite: 2446 });
  assert.equal(usage.model, MODEL);
});

test('an object cache_creation sums its 5-minute and 1-hour ephemeral fields', () => {
  const rows = rowsFrom([assistantUsage({ uuid: 'a1', messageId: 'msg_1', usage: {
    input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 500 },
  } })]);
  const usage = reduceClaudeCodeSnapshot(rows).observations.find(o => o.type === 'usage');

  assert.equal(usage.usage.cacheWrite, 1500);
});

test('an object cache_creation wins over a stale flat field', () => {
  const rows = rowsFrom([assistantUsage({ uuid: 'a1', messageId: 'msg_1', usage: {
    input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100,
    cache_creation_input_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 500 },
  } })]);
  const usage = reduceClaudeCodeSnapshot(rows).observations.find(o => o.type === 'usage');

  assert.equal(usage.usage.cacheWrite, 1500);
});

test('canonical usage has exactly input, output, cacheRead, and cacheWrite', () => {
  const rows = rowsFrom([assistantUsage({ uuid: 'a1', messageId: 'msg_1',
    usage: { ...usageOf({ input: 2, output: 5, cacheRead: 100 }), service_tier: 'standard' } })]);
  const usage = reduceClaudeCodeSnapshot(rows).observations.find(o => o.type === 'usage');

  assert.deepEqual(Object.keys(usage.usage).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
});

test('non-assistant, missing-usage, synthetic-model, and all-zero rows emit no usage observation', () => {
  const rows = rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantObservation({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1',
      blocks: [{ type: 'text', text: 'no usage member' }], timestamp: ts(2) }),
    assistantUsage({ uuid: 'a2', parentUuid: 'a1', messageId: 'msg_syn', model: '<synthetic>',
      timestamp: ts(3), usage: usageOf({ input: 5, output: 5, cacheRead: 5, cacheWrite: 5 }) }),
    assistantUsage({ uuid: 'a3', parentUuid: 'a2', messageId: 'msg_zero', model: 'deepseek-v4-pro',
      timestamp: ts(4), usage: usageOf({}) }),
  ]);
  const { observations } = reduceClaudeCodeSnapshot(rows);

  assert.equal(observations.filter(o => o.type === 'usage').length, 0);
});

test('a real zero-cache-read row with nonzero input or output emits usage', () => {
  const rows = rowsFrom([assistantUsage({ uuid: 'a1', messageId: 'msg_cold', model: 'deepseek-v4-pro',
    usage: usageOf({ input: 32351, output: 716 }) })]);
  const usage = reduceClaudeCodeSnapshot(rows).observations.find(o => o.type === 'usage');

  assert.deepEqual(usage.usage, { input: 32351, output: 716, cacheRead: 0, cacheWrite: 0 });
});

test('an explicitly null known usage field suppresses only the usage observation', () => {
  const rows = rowsFrom([assistantUsage({
    uuid: 'a1', messageId: 'msg_1', timestamp: ts(1),
    blocks: [
      { type: 'text', text: 'still visible' },
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/a.js' } },
    ],
    usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: null },
  })]);
  const batch = reduceClaudeCodeSnapshot(rows).batches.at(-1);

  assert.deepEqual(typesOf(batch), ['text', 'tool-use']);
});

// --- Reducer instances ---

test('the same rows through two fresh reducer instances produce deep-equal batches', () => {
  const entries = [
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      blocks: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
      usage: usageOf({ input: 2, output: 5, cacheRead: 100 }) }),
    toolResult({ uuid: 'r1', parentUuid: 'a1', toolUseId: 'tu_1', content: 'ok', timestamp: ts(3) }),
    userMessage({ uuid: 'u2', text: 'after compact', timestamp: ts(4) }),
  ];

  const first = createClaudeCodeObservationReducer();
  const second = createClaudeCodeObservationReducer();
  const whole = first.append(rowsFrom(entries));
  const split = [
    second.append(rowsFrom(entries).slice(0, 2)),
    second.append(rowsFrom(entries).slice(2)),
  ];

  assert.deepEqual(whole.batches, [...split[0].batches, ...split[1].batches]);
  assert.deepEqual(first.snapshot(), second.snapshot());
  assert.deepEqual(reduceClaudeCodeSnapshot(rowsFrom(entries)).batches, whole.batches);
});

test('an incremental reducer signals a stale active branch on a rewind', () => {
  const reducer = createClaudeCodeObservationReducer();
  reducer.append(rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      usage: usageOf({ output: 5, cacheRead: 100 }) }),
  ]));

  const rewind = reducer.append(readClaudeCodeRows(jsonl([
    assistantUsage({ uuid: 'a2', parentUuid: 'u1', messageId: 'msg_2', timestamp: ts(3),
      usage: usageOf({ output: 6, cacheRead: 120 }) }),
  ]), { sourceOrdinal: 3 }).rows);

  assert.equal(rewind.staleBranch, true);
  assert.deepEqual(rewind.batches, []);
});

test('an incremental canonical compact root appends an epoch instead of a stale branch', () => {
  const reducer = createClaudeCodeObservationReducer();
  reducer.append(rowsFrom([
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2),
      usage: usageOf({ output: 5, cacheRead: 100 }) }),
  ]));

  const compact = reducer.append(readClaudeCodeRows(jsonl([
    userMessage({ uuid: 'u2', text: 'after compact', timestamp: ts(3) }),
  ]), { sourceOrdinal: 3 }).rows);

  assert.equal(compact.staleBranch, false);
  assert.equal(compact.batches[0][0].type, 'epoch-boundary');
  assert.equal(compact.batches[0][0].sourceEntryId, 'u2');
});

test('a reducer snapshot is detached from later appends', () => {
  const reducer = createClaudeCodeObservationReducer();
  reducer.append(rowsFrom([userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) })]));
  const snapshot = reducer.snapshot();

  reducer.append(readClaudeCodeRows(jsonl([
    userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'more', timestamp: ts(2) }),
  ]), { sourceOrdinal: 2 }).rows);

  assert.deepEqual(snapshot.activePath, ['u1']);
  assert.equal(snapshot.activeLeafId, 'u1');
});
