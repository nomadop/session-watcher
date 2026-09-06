import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-a-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

test('Stream A: Read tool_use + successful tool_result adds file tokens to B', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 1000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/a.js' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: '1\tconst a = 1;\n2\tconst b = 2;\n' } ] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.ok(w._bRebuild.pathTotal('/proj/a.js') > 0, 'Read content contributes to B');
});

test('Stream A: is_error tool_result does NOT update B', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 1000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/a.js' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'ENOENT' } ] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._bRebuild.pathTotal('/proj/a.js'), 0);
});

test('Stream A: MCP tool (no adapter) leaves B unchanged (black box)', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 1000, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__serena__find_symbol', input: { name_path_pattern: 'X' } }] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'body...' } ] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._bRebuild.B(), w._bRebuild.dead); // only dead, no path contribution
});

test('Stream A: same-message snapshots retain physical tool events when usage revision is rejected', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', parentUuid: null, isSidechain: false,
      message: { id: 'm1', model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'tu-early', name: 'Read', input: { file_path: '/proj/early.js' } }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: false,
      message: { id: 'm1', model: 'claude-opus-4-8',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'tu-late', name: 'Read', input: { file_path: '/proj/late.js' } }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', isSidechain: false, message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-early', content: '1\tconst early = 1;\n2\tconst kept = 2;\n' },
      { type: 'tool_result', tool_use_id: 'tu-late', content: '1\tconst late = 1;\n2\tconst kept = 2;\n' },
    ] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  assert.equal(w._calls.length, 1);
  assert.equal(w._calls[0].output, 100, 'the lower-token usage revision remains rejected');
  assert.equal(w._segment, 0, 'the rejected revision does not trigger stock-drop segmentation');
  assert.ok(w._bRebuild.pathTotal('/proj/early.js') > 0, 'the first physical tool result updates B');
  assert.ok(w._bRebuild.pathTotal('/proj/late.js') > 0, 'its physical tool result still updates B');
});

test('Stream A: same-message observations keep reasoning attribution entry-local', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', parentUuid: null, isSidechain: false,
      message: { id: 'm1', model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/proj/a.js' } }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: false,
      message: { id: 'm1', model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        content: [
          { type: 'thinking', thinking: 'x'.repeat(600) },
          { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: '/proj/a.js', old_string: 'a', new_string: 'b' } },
        ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', isSidechain: false, message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-read', content: '1\tconst a = 1;\n2\tconst b = 2;\n' },
      { type: 'tool_result', tool_use_id: 'tu-edit', content: 'Updated /proj/a.js' },
    ] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  assert.equal(w._calls.length, 1, 'same message.id still folds to one usage call');
  assert.equal(w._calls[0].output, 20, 'the later accepted usage revision is retained');
  assert.equal(w._bRebuild._totalSpentReasoning.get('/proj/a.js') || 0, 0,
    'reasoning does not bridge two physical observations');
});

test('Stream A: UUID-less legacy fallback still processes sidechain tools without path telemetry', () => {
  const path = tmpJsonl([
    { type: 'assistant', isSidechain: true,
      message: { id: 'm-side', model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: 'tu-side', name: 'Read', input: { file_path: '/proj/side.js' } }] } },
    { type: 'user', isSidechain: true, message: { content: [
      { type: 'tool_result', tool_use_id: 'tu-side', content: '1\tconst side = 1;\n2\tconst legacy = 2;\n' },
    ] } },
  ]);

  const w = new SessionWatcher(path);
  w.poll();

  assert.equal(w._calls.length, 0, 'sidechain usage never becomes a folded call');
  assert.ok(w._bRebuild.pathTotal('/proj/side.js') > 0,
    'the no-tree raw fallback retains existing physical tool processing');
  assert.equal(w._segmentPathEvents.length, 0, 'sidechain path telemetry remains gated');
});

// ─── §2.4 Same-path reasoning attribution (Task 11: A4) ────────────────────────

test('Stream A: same-path reasoning attribution — thinking between same-path tool_uses attributes to that path', () => {
  // Assistant message with: tool_use(Read a.js) → thinking(500 chars) → tool_use(Edit a.js)
  // The thinking tokens should be added to a.js's totalSpent via reasoning ledger.
  const thinkingText = 'x'.repeat(500);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, output_tokens: 50 },
      content: [
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/a.js' } },
        { type: 'thinking', thinking: thinkingText },
        { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: '/proj/a.js', old_string: 'x', new_string: 'y' } },
      ] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: '1\tconst a = 1;\n2\tconst b = 2;\n' },
      { type: 'tool_result', tool_use_id: 'tu2', content: 'OK' },
    ] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  // Reasoning tokens (500 chars / 3.0 ascii ctp ≈ 167) should be in the reasoning ledger
  const reasoningSpent = w._bRebuild._totalSpentReasoning.get('/proj/a.js') || 0;
  assert.ok(reasoningSpent > 100, `Expected reasoning attribution > 100, got ${reasoningSpent}`);
  // totalSpent in snapshot should include reasoning (account for Math.round in snapshot)
  const snap = w._bRebuild.snapshot();
  const row = snap.find(r => r.path === '/proj/a.js');
  assert.ok(row, 'a.js should be in snapshot');
  const contentSpent = w._bRebuild._totalSpent.get('/proj/a.js') || 0;
  // snapshot uses Math.round on _spentFor, so allow ±1 for rounding
  assert.ok(row.totalSpent >= Math.floor(contentSpent + reasoningSpent), 'totalSpent includes reasoning');
});

test('Stream A: different-path reasoning NOT attributed — thinking between tool_uses on different paths is discarded', () => {
  const thinkingText = 'y'.repeat(600);
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, output_tokens: 50 },
      content: [
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/proj/a.js' } },
        { type: 'thinking', thinking: thinkingText },
        { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/proj/b.js' } },
      ] } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: '1\tconst a = 1;\n' },
      { type: 'tool_result', tool_use_id: 'tu2', content: '1\tconst b = 1;\n' },
    ] } },
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  // No reasoning attribution to either path since paths differ
  const reasoningA = w._bRebuild._totalSpentReasoning.get('/proj/a.js') || 0;
  const reasoningB = w._bRebuild._totalSpentReasoning.get('/proj/b.js') || 0;
  assert.equal(reasoningA, 0, 'No reasoning attributed to a.js (path changed)');
  assert.equal(reasoningB, 0, 'No reasoning attributed to b.js (path changed)');
});
