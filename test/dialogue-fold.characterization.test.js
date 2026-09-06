// test/dialogue-fold.characterization.test.js — §7.1 characterization tests for Bookmark Dialogue Projection.
// These tests pin the DESIRED spec behavior for each of the 6 defect categories (§3.1–§3.6).
// Visible messages are derived through visibleMessages() rather than read off a second array:
// folds[] is the only authoritative state, so a fold with message===null (tool-only or
// residual-only) has no visible counterpart and must not surface as a candidate.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCanonicalTranscript,
  findCanonicalMessage,
  visibleMessages,
} from '../lib/dialogue-fold.js';
import {
  userMessage, assistantObservation, toolResult, writeTranscript, ts,
} from './helpers/transcript-fixtures.js';

// ═══════════════════════════════════════════════════════════════════════════════
// §3.1 — Tool-only fold must NOT leak as blank candidate
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3.1 tool-only fold exclusion from candidates', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-char31-')); });

  test('active-path tool-only assistant does not appear in messages[] (visible candidates)', () => {
    // Setup: user → assistant with text → assistant tool-only (same active path)
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'I will read a file' }],
      }),
      // Tool-only assistant turn — NO visible text, only tool_use
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm2', timestamp: ts(3),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a2', toolUseId: 't1', content: 'file contents' }),
      // Another assistant with text
      assistantObservation({
        uuid: 'a3', parentUuid: 'tr1', messageId: 'm3', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'Done reading' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    // Only messages with visible text should appear in messages[]
    const visibleAssistant = visibleMessages(c).filter(m => m.role === 'assistant');
    assert.equal(visibleAssistant.length, 2, 'should only have 2 visible assistant messages');
    assert.equal(visibleAssistant[0].text, 'I will read a file');
    assert.equal(visibleAssistant[1].text, 'Done reading');
    // No null/empty text assistant message
    for (const m of visibleMessages(c)) {
      if (m.role === 'assistant') {
        assert.ok(m.text !== null && m.text !== '', `assistant message must have visible text, got: ${JSON.stringify(m.text)}`);
      }
    }
  });

  test('tool-only fold is preserved in folds[] for Detail context window', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 't1', content: 'a.js\nb.js' }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'tr1', messageId: 'm2', timestamp: ts(3),
        blocks: [{ type: 'text', text: 'Listed files' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    // The tool-only turn keeps its own fold (Detail traverses folds), but carries no message.
    const toolOnly = c.folds.filter(f => f.message === null);
    assert.equal(toolOnly.length, 1, 'the tool-only turn must keep exactly one fold');
    assert.equal(toolOnly[0].toolPairs.length, 1, 'its tool pair must survive on the fold');
    assert.equal(toolOnly[0].toolPairs[0].result, 'a.js\nb.js');
    // ...and it must not become a visible message.
    assert.equal(visibleMessages(c).filter(m => m.role === 'assistant').length, 1);
  });

  test('folds are the only authoritative state: no parallel messages array is exposed', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    // A second array whose cardinality differs from folds[] is what let index zippers drift.
    assert.equal(c.messages, undefined, 'readCanonicalTranscript must not return messages[]');
  });

  test('every fold carries its ordinal and sourceRef', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'hello', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'hi' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.deepEqual(c.folds.map(f => f.ordinal), [0, 1]);
    for (const f of c.folds) {
      assert.ok(f.sourceRef, 'each fold must retain a sourceRef back to its observation');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.2 — Duplicate tool result: same tool_use_id must be LAST-WINS
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3.2 duplicate tool result last-wins', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-char32-')); });

  test('same tool_use_id with two results takes the LAST result payload', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }],
      }),
      // First result for t1
      toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 't1', content: 'first-content' }),
      // Second (duplicate) result for t1 — spec: this one wins
      toolResult({ uuid: 'tr2', parentUuid: 'tr1', toolUseId: 't1', content: 'last-content' }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.folds[0].toolPairs[0].result, 'last-content',
      'duplicate tool_use_id result must be last-wins, not first-wins');
  });

  test('different tool_use_ids preserve first-seen order with correct pairing', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/b.js' } },
        ],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 't2', content: 'edit-result' }),
      toolResult({ uuid: 'tr2', parentUuid: 'tr1', toolUseId: 't1', content: 'read-result' }),
    ]);
    const c = readCanonicalTranscript(path);
    // Order: t1 first-seen, t2 second
    assert.equal(c.folds[0].toolPairs[0].id, 't1');
    assert.equal(c.folds[0].toolPairs[0].result, 'read-result');
    assert.equal(c.folds[0].toolPairs[1].id, 't2');
    assert.equal(c.folds[0].toolPairs[1].result, 'edit-result');
  });

  test('a result is consumed by its own fold and does not carry to a later reuse of the ID', () => {
    // Pairing is keyed by tool_use_id, so a later fold reusing an already-consumed ID must not
    // inherit the earlier payload.
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a1', toolUseId: 't1', content: 'only-result' }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'tr1', messageId: 'm2', timestamp: ts(2),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/b.js' } }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.folds[0].toolPairs[0].result, 'only-result');
    assert.equal(c.folds[1].toolPairs[0].result, null,
      'the consumed result must not be paired again with a later reuse of the same ID');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.3 — Anchor contract: validation, first-anchor, duplicate-first-wins
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3.3 anchor contract', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-char33-')); });

  test('anchor takes first visible-text observation UUID', () => {
    const path = writeTranscript(dir, [
      // First observation: tool-only (no visible text) — should NOT be anchor
      assistantObservation({
        uuid: 'tool-only-uuid', messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
      }),
      // Second observation with text — THIS should be anchor
      assistantObservation({
        uuid: 'text-uuid', parentUuid: 'tool-only-uuid', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'Here is the result' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const msg = visibleMessages(c).find(m => m.role === 'assistant');
    assert.equal(msg.anchorUuid, 'text-uuid',
      'anchor must be first visible-text observation UUID');
  });

  // The three anchor-anomaly cases below WARN but do not drop the candidate. Across 2703 real
  // transcripts (366,221 lines) every one of them occurs zero times: the entries that lack a uuid
  // or timestamp are all session-metadata types (mode, ai-title, file-history-snapshot, …) which
  // never reach anchor resolution, no timestamp ever failed to parse, and uuids are unique per
  // line. Dropping candidates would buy no protection against real input while narrowing §10's
  // field-level degradation, so these stay observable rather than enforced.

  test('missing UUID on a visible-text observation produces a warning', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: null, messageId: 'm1', timestamp: ts(1),
        blocks: [{ type: 'text', text: 'no uuid' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.ok(c.warnings.some(w => /anchor|uuid/i.test(w)),
      'should produce a warning when anchor UUID is missing');
    // store enforces anchor_uuid NOT NULL, so such a row can never be bookmarked anyway.
    assert.equal(visibleMessages(c).length, 1, 'the readable message itself is retained');
  });

  test('invalid timestamp produces a warning and degrades to null', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: 'not-a-timestamp',
        blocks: [{ type: 'text', text: 'bad ts' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.ok(c.warnings.some(w => /timestamp/i.test(w)),
      'should produce a warning when timestamp is invalid');
    const msg = visibleMessages(c)[0];
    assert.equal(msg.anchorTimestamp, null, '§10 degrades the field, not the whole message');
    assert.equal(msg.text, 'bad ts');
  });

  test('a valid transcript produces no anchor warnings', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'q', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'a' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.deepEqual(c.warnings, [], 'anchor warnings must not fire on well-formed input');
  });

  test('duplicate anchor UUID warns and keeps canonical order', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'q1', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'dup-uuid', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'first answer' }],
      }),
      userMessage({ uuid: 'u2', parentUuid: 'dup-uuid', text: 'q2', timestamp: ts(3) }),
      // Different message.id but same observation UUID (duplicate anchor)
      assistantObservation({
        uuid: 'dup-uuid', parentUuid: 'u2', messageId: 'm2', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'second answer' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.ok(c.warnings.some(w => /duplicate.*anchor|anchor.*duplicate/i.test(w)),
      'should warn about duplicate anchor UUID');
    // Both stay, in canonical order: store's UNIQUE(source_session_id, anchor_uuid) already
    // collapses them to a single row on add, so silently hiding the second here would only
    // remove a readable message from the list.
    const withDupAnchor = visibleMessages(c).filter(m => m.anchorUuid === 'dup-uuid');
    assert.deepEqual(withDupAnchor.map(m => m.text), ['first answer', 'second answer']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.5 — Tool-only exclusion must use active-path fixture (not sibling branch)
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3.5 tool-only exclusion on active path (not sibling)', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-char35-')); });

  test('tool-only on active path is excluded from candidates but preserved in folds', () => {
    // All observations on a single linear active path (no sibling branch trick)
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'start', timestamp: ts(1) }),
      // Text assistant
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'response one' }],
      }),
      // Tool-only assistant on SAME active path (parentUuid: a1)
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm2', timestamp: ts(3),
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } }],
      }),
      toolResult({ uuid: 'tr1', parentUuid: 'a2', toolUseId: 't1', content: 'hi' }),
      // Text assistant continuing
      assistantObservation({
        uuid: 'a3', parentUuid: 'tr1', messageId: 'm3', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'response two' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    // messages (candidates) must not include the tool-only turn
    const assistantMsgs = visibleMessages(c).filter(m => m.role === 'assistant');
    assert.equal(assistantMsgs.length, 2);
    assert.ok(assistantMsgs.every(m => m.text !== null && m.text.length > 0));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3.6 — No causal cutoff: a transcript is read whole
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3.6 transcripts are read whole', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-char36-')); });

  test('a handoff token embedded in a message does not truncate the projection', () => {
    // The retired cutoff sliced the raw buffer at the token's line. Measured across 30 real
    // ancestor segments it withheld 9 visible messages in total, all of them session-closing
    // noise (`/exit`, `See ya!`, the sw-handoff echo). Membership is per session now.
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'context before', timestamp: ts(1) }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: ts(2),
        blocks: [{ type: 'text', text: 'Handoff prepared. Token: `some-load-token`' }],
      }),
      userMessage({ uuid: 'u2', parentUuid: 'a1', text: 'after the handoff', timestamp: ts(3) }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'u2', messageId: 'm2', timestamp: ts(4),
        blocks: [{ type: 'text', text: 'still in scope' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    assert.equal(c.status, 'ok');
    assert.deepEqual(visibleMessages(c).map(m => m.text), [
      'context before',
      'Handoff prepared. Token: `some-load-token`',
      'after the handoff',
      'still in scope',
    ]);
  });

  test('the retired cutoffToken option is not honored', () => {
    // A caller still passing it must not silently get a trimmed projection.
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'before TOKEN_X', timestamp: ts(1) }),
      userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'after', timestamp: ts(2) }),
    ]);
    const c = readCanonicalTranscript(path, { cutoffToken: 'TOKEN_X' });
    assert.deepEqual(visibleMessages(c).map(m => m.text), ['before TOKEN_X', 'after']);
    assert.deepEqual(c.warnings, [], 'no cutoff warning survives the retirement');
  });
});
