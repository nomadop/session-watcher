// test/fold.serena-integration.test.js
// Integration test: Serena MCP adapters → fold pipeline → BRebuild
// Verifies that Serena tool calls are correctly tracked (or excluded) through the full pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-serena-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// ─── §1: find_symbol with body content creates a B path entry ───────────────

test('fold pipeline: mcp__serena__find_symbol with body creates B path entry', () => {
  const findBody = 'export function hello() {\n  console.log("hi");\n}';
  // Serena result format: {"result": "<JSON-encoded array of symbol objects>"}
  const resultJson = JSON.stringify({
    result: JSON.stringify([{
      name_path: 'hello',
      kind: 'Function',
      relative_path: 'src/greet.ts',
      body_location: { start_line: 5, end_line: 7 },
      body: findBody,
    }]),
  });

  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: {
      id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, output_tokens: 30 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__serena__find_symbol',
        input: { relative_path: 'src/greet.ts', name_path_pattern: 'hello', include_body: true } }],
    } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: resultJson },
    ] } },
  ]);

  const w = new SessionWatcher(path, null, { cwd: '/workspace' });
  w.poll();

  // Canonical path: relative_path 'src/greet.ts' resolved against cwd '/workspace'
  const canonPath = '/workspace/src/greet.ts';
  const tokens = w._bRebuild.pathTotal(canonPath);
  assert.ok(tokens > 0, `src/greet.ts should have positive token count after find_symbol(body=true), got ${tokens}`);
});

// ─── §2: initial_instructions does NOT create a B path entry ────────────────

test('fold pipeline: mcp__serena__initial_instructions does NOT create B path entry', () => {
  const path = tmpJsonl([
    { type: 'assistant', uuid: 'a1', message: {
      id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, output_tokens: 10 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__serena__initial_instructions', input: {} }],
    } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1',
        content: JSON.stringify({ result: 'You have access to semantic tools for code navigation.' }) },
    ] } },
  ]);

  const w = new SessionWatcher(path, null, { cwd: '/workspace' });
  w.poll();

  // No adapter matches initial_instructions → all tokens go to residual (dead), no path entries
  assert.equal(w._bRebuild.B(), w._bRebuild.dead,
    'initial_instructions should not create any B path entry — all tokens in dead/residual');
});

// ─── §3: replace_content updates an existing B path entry ───────────────────

test('fold pipeline: mcp__serena__replace_content updates existing B path', () => {
  // First, read the file via a standard Read to establish a B entry
  const initialContent = '1\tconst x = 1;\n2\tconst y = 2;\n3\tconst z = 3;\n';

  const path = tmpJsonl([
    // Turn 1: Read establishes B entry for lib/foo.js
    { type: 'assistant', uuid: 'a1', message: {
      id: 'm1', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5000, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read',
        input: { file_path: '/workspace/lib/foo.js' } }],
    } },
    { type: 'user', uuid: 'u1', parentUuid: 'a1', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: initialContent },
    ] } },
    // Turn 2: replace_content updates the B entry (editDelta)
    { type: 'assistant', uuid: 'a2', parentUuid: 'u1', message: {
      id: 'm2', model: 'claude-opus-4-8',
      usage: { cache_read_input_tokens: 5100, output_tokens: 40 },
      content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__serena__replace_content',
        input: { relative_path: 'lib/foo.js', needle: 'x = 1', repl: 'x = 100000', mode: 'literal' } }],
    } },
    { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu2',
        content: JSON.stringify({ result: 'ok' }) },
    ] } },
  ]);

  const w = new SessionWatcher(path, null, { cwd: '/workspace' });
  w.poll();

  const canonPath = '/workspace/lib/foo.js';

  // foo.js should still be in B after replace_content
  const tokens = w._bRebuild.pathTotal(canonPath);
  assert.ok(tokens > 0, `foo.js should remain in B with positive tokens after replace_content, got ${tokens}`);

  // The editDelta should be non-zero (repl 'x = 100000' is longer than needle 'x = 1')
  const entry = w._bRebuild.paths.get(canonPath);
  assert.ok(entry, 'foo.js should be tracked in _bRebuild.paths');
  // editDelta > 0 because repl chars > needle chars
  assert.ok(entry.editDelta > 0, `editDelta should be positive (repl is longer than needle), got ${entry.editDelta}`);
});
