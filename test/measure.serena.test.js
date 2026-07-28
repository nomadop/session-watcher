// test/measure.serena.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAdapter, charsToTokens, canonicalizePath } from '../lib/measure.js';

const CTP = { ascii: 3.0, cjk: 1.0 };
const CWD = '/workspace/project';

// ─── find_symbol (with relative_path in input) ───────────────────────────────

test('Serena find_symbol adapter: matches mcp__serena__find_symbol', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  assert.ok(adapter, 'adapter should exist');
  assert.equal(adapter.name, 'serena_find_symbol');
});

test('Serena find_symbol: extractPath returns canonicalized input.relative_path', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  const path = adapter.extractPath({ relative_path: 'src/foo.ts', name_path_pattern: 'bar', include_body: true }, CWD);
  assert.equal(path, canonicalizePath('src/foo.ts', CWD));
});

test('Serena find_symbol: extractPath returns null when no relative_path (project-wide search)', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  const path = adapter.extractPath({ name_path_pattern: 'bar', include_body: true }, CWD);
  assert.equal(path, null);
});

test('Serena find_symbol: computeUpdate with body returns lineUpdate', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  const result = JSON.stringify({
    result: JSON.stringify([{
      name_path: 'foo', kind: 'Function', relative_path: 'src/foo.ts',
      body_location: { start_line: 5, end_line: 7 },
      body: 'function foo() {\n  return 1;\n}',
    }]),
  });
  const update = adapter.computeUpdate(
    { relative_path: 'src/foo.ts', name_path_pattern: 'foo', include_body: true },
    result, CWD, CTP
  );
  assert.equal(update.type, 'lineUpdate');
  assert.equal(update.lines.length, 3); // 3 lines of body
  assert.equal(update.lines[0][0], 6);  // start_line=5 (0-based) → B line 6 (1-based)
  assert.equal(update.lines[2][0], 8);  // end at B line 8
  assert.ok(update.spent > 0);
});

test('Serena find_symbol: computeUpdate without body returns null (no file content)', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  const result = JSON.stringify({
    result: JSON.stringify([
      { name_path: 'Foo', kind: 'Class', relative_path: 'src/foo.ts', body_location: { start_line: 1, end_line: 50 } },
    ]),
  });
  const update = adapter.computeUpdate(
    { relative_path: 'src/foo.ts', name_path_pattern: 'Foo' },
    result, CWD, CTP
  );
  assert.equal(update, null);
});

test('Serena find_symbol: project-wide (no relative_path) returns grepMultiFile', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  const result = JSON.stringify({
    result: JSON.stringify([
      { name_path: 'foo', kind: 'Function', relative_path: 'src/a.ts', body_location: { start_line: 1, end_line: 2 }, body: 'line1\nline2' },
      { name_path: 'foo', kind: 'Function', relative_path: 'src/b.ts', body_location: { start_line: 10, end_line: 10 }, body: 'line10' },
    ]),
  });
  const update = adapter.computeUpdate(
    { name_path_pattern: 'foo', include_body: true },
    result, CWD, CTP
  );
  assert.equal(update.type, 'grepMultiFile');
  const paths = Object.keys(update.files);
  assert.equal(paths.length, 2);
  // Verify 0-based → 1-based conversion: start_line=1 → B lines 2,3
  const aPath = paths.find(p => p.includes('src/a.ts'));
  assert.ok(aPath);
  assert.equal(update.files[aPath][0][0], 2);  // start_line=1 + 1 + 0
  assert.equal(update.files[aPath][1][0], 3);  // start_line=1 + 1 + 1
  // start_line=10 → B line 11
  const bPath = paths.find(p => p.includes('src/b.ts'));
  assert.ok(bPath);
  assert.equal(update.files[bPath][0][0], 11); // start_line=10 + 1 + 0
});

// ─── get_symbols_overview ────────────────────────────────────────────────────

test('Serena get_symbols_overview adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__get_symbols_overview');
  assert.ok(adapter);
  assert.equal(adapter.name, 'serena_get_symbols_overview');
});

test('Serena get_symbols_overview: extractPath from input.relative_path', () => {
  const adapter = matchAdapter('mcp__serena__get_symbols_overview');
  const path = adapter.extractPath({ relative_path: 'lib/foo.js' }, CWD);
  assert.equal(path, canonicalizePath('lib/foo.js', CWD));
});

test('Serena get_symbols_overview: computeUpdate returns null (enters residual)', () => {
  const adapter = matchAdapter('mcp__serena__get_symbols_overview');
  const result = JSON.stringify({ result: JSON.stringify({ Function: ['foo', 'bar'], Class: ['Baz'] }) });
  const update = adapter.computeUpdate({ relative_path: 'lib/foo.js' }, result, CWD, CTP);
  assert.equal(update, null);
});

// ─── find_referencing_symbols ────────────────────────────────────────────────

test('Serena find_referencing_symbols adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__find_referencing_symbols');
  assert.ok(adapter);
});

test('Serena find_referencing_symbols: extractPath returns null (multi-file result)', () => {
  const adapter = matchAdapter('mcp__serena__find_referencing_symbols');
  const path = adapter.extractPath({ name_path: 'foo', relative_path: 'src/foo.ts' }, CWD);
  assert.equal(path, null);
});

test('Serena find_referencing_symbols: computeUpdate returns grepMultiFile', () => {
  const adapter = matchAdapter('mcp__serena__find_referencing_symbols');
  const result = JSON.stringify({
    result: JSON.stringify({
      'src/a.ts': { Function: [{ name_path: 'handler', body_location: { start_line: 10, end_line: 20 }, content_around_reference: 'import { foo }' }] },
      'src/b.ts': { File: [{ name_path: 'b', body_location: { start_line: 1, end_line: 5 }, content_around_reference: 'use foo' }] },
    }),
  });
  const update = adapter.computeUpdate({ name_path: 'foo', relative_path: 'src/foo.ts' }, result, CWD, CTP);
  assert.equal(update.type, 'grepMultiFile');
  assert.equal(Object.keys(update.files).length, 2);
});

test('Serena find_referencing_symbols: returns null when all entries lack context', () => {
  const adapter = matchAdapter('mcp__serena__find_referencing_symbols');
  const result = JSON.stringify({
    result: JSON.stringify({
      'src/a.ts': { Function: [{ name_path: 'handler', body_location: { start_line: 10, end_line: 20 }, content_around_reference: '' }] },
    }),
  });
  const update = adapter.computeUpdate({ name_path: 'foo', relative_path: 'src/foo.ts' }, result, CWD, CTP);
  assert.equal(update, null);
});

// ─── read_memory ─────────────────────────────────────────────────────────────

test('Serena read_memory adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__read_memory');
  assert.ok(adapter);
});

test('Serena read_memory: extractPath returns .serena/memories/{name}.md', () => {
  const adapter = matchAdapter('mcp__serena__read_memory');
  const path = adapter.extractPath({ memory_name: 'core' }, CWD);
  assert.equal(path, canonicalizePath('.serena/memories/core.md', CWD));
});

test('Serena read_memory: extractPath with .md suffix does not double-add', () => {
  const adapter = matchAdapter('mcp__serena__read_memory');
  const path = adapter.extractPath({ memory_name: 'v2.1_rate_lamp.md' }, CWD);
  assert.equal(path, canonicalizePath('.serena/memories/v2.1_rate_lamp.md', CWD));
});

test('Serena read_memory: computeUpdate returns fullSet', () => {
  const adapter = matchAdapter('mcp__serena__read_memory');
  const result = JSON.stringify({ result: '# Memory\n\nSome content here.\nLine 3.' });
  const update = adapter.computeUpdate({ memory_name: 'core' }, result, CWD, CTP);
  assert.equal(update.type, 'fullSet');
  assert.equal(update.lines.length, 4); // 4 lines
  assert.ok(update.spent > 0);
});

// ─── initial_instructions / onboarding / list_memories: NOT adapted ──────────

test('Serena initial_instructions: NOT matched (enters residual)', () => {
  const adapter = matchAdapter('mcp__serena__initial_instructions');
  assert.equal(adapter, null);
});

test('Serena onboarding: NOT matched (enters residual)', () => {
  const adapter = matchAdapter('mcp__serena__onboarding');
  assert.equal(adapter, null);
});

test('Serena list_memories: NOT matched (enters residual)', () => {
  const adapter = matchAdapter('mcp__serena__list_memories');
  assert.equal(adapter, null);
});

// ─── replace_content ─────────────────────────────────────────────────────────

test('Serena replace_content adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__replace_content');
  assert.ok(adapter);
  assert.equal(adapter.name, 'serena_replace_content');
});

test('Serena replace_content: extractPath from input.relative_path', () => {
  const adapter = matchAdapter('mcp__serena__replace_content');
  const path = adapter.extractPath({ relative_path: 'lib/foo.js', needle: 'old', repl: 'new', mode: 'literal' }, CWD);
  assert.equal(path, canonicalizePath('lib/foo.js', CWD));
});

test('Serena replace_content: computeUpdate returns editDelta', () => {
  const adapter = matchAdapter('mcp__serena__replace_content');
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', needle: 'short', repl: 'a much longer replacement string', mode: 'literal' },
    '{"result":"ok"}', CWD, CTP
  );
  assert.equal(update.type, 'editDelta');
  assert.ok(update.value > 0); // repl longer than needle → positive delta
  assert.ok(update.spent > 0);
});

test('Serena replace_content: negative delta when needle > repl', () => {
  const adapter = matchAdapter('mcp__serena__replace_content');
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', needle: 'a very long needle string here', repl: 'x', mode: 'literal' },
    '{"result":"ok"}', CWD, CTP
  );
  assert.equal(update.type, 'editDelta');
  assert.ok(update.value < 0);
});

// ─── replace_symbol_body ─────────────────────────────────────────────────────

test('Serena replace_symbol_body adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__replace_symbol_body');
  assert.ok(adapter);
});

test('Serena replace_symbol_body: extractPath from input.relative_path', () => {
  const adapter = matchAdapter('mcp__serena__replace_symbol_body');
  const path = adapter.extractPath({ relative_path: 'lib/foo.js', name_path: 'myFunc', body: 'new body' }, CWD);
  assert.equal(path, canonicalizePath('lib/foo.js', CWD));
});

test('Serena replace_symbol_body: computeUpdate returns editDelta with value=0', () => {
  const adapter = matchAdapter('mcp__serena__replace_symbol_body');
  const body = 'function myFunc() {\n  return 42;\n}';
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', name_path: 'myFunc', body },
    '{"result":"ok"}', CWD, CTP
  );
  assert.equal(update.type, 'editDelta');
  assert.equal(update.value, 0);
  assert.ok(update.spent > 0);
});

// ─── insert_after_symbol / insert_before_symbol ──────────────────────────────

test('Serena insert_after_symbol adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__insert_after_symbol');
  assert.ok(adapter);
});

test('Serena insert_before_symbol adapter: matches', () => {
  const adapter = matchAdapter('mcp__serena__insert_before_symbol');
  assert.ok(adapter);
});

test('Serena insert_after_symbol: computeUpdate returns editDelta with value=bodyTokens', () => {
  const adapter = matchAdapter('mcp__serena__insert_after_symbol');
  const body = 'function newHelper() {\n  return true;\n}';
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', name_path: 'existingFunc', body },
    '{"result":"ok"}', CWD, CTP
  );
  assert.equal(update.type, 'editDelta');
  assert.ok(update.value > 0);
  assert.equal(update.value, charsToTokens(body, CTP));
});

// ─── Error handling (all adapters) ──────────────────────────────────────────

test('Serena replace_content: returns null on error result', () => {
  const adapter = matchAdapter('mcp__serena__replace_content');
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', needle: 'old', repl: 'new', mode: 'literal' },
    JSON.stringify({ result: 'Error executing tool: needle not found' }), CWD, CTP
  );
  assert.equal(update, null);
});

test('Serena replace_content: returns null for non-literal mode (regex)', () => {
  const adapter = matchAdapter('mcp__serena__replace_content');
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', needle: 'old', repl: 'new', mode: 'regex' },
    '{"result":"ok"}', CWD, CTP
  );
  assert.equal(update, null);
});

test('Serena replace_symbol_body: returns null on error result', () => {
  const adapter = matchAdapter('mcp__serena__replace_symbol_body');
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', name_path: 'myFunc', body: 'new body' },
    'Error executing tool replace_symbol_body: symbol not found', CWD, CTP
  );
  assert.equal(update, null);
});

test('Serena insert_after_symbol: returns null on error result', () => {
  const adapter = matchAdapter('mcp__serena__insert_after_symbol');
  const update = adapter.computeUpdate(
    { relative_path: 'lib/foo.js', name_path: 'func', body: 'code' },
    JSON.stringify({ result: 'Error executing tool: could not locate symbol' }), CWD, CTP
  );
  assert.equal(update, null);
});

test('Serena find_symbol: returns null on error result', () => {
  const adapter = matchAdapter('mcp__serena__find_symbol');
  const update = adapter.computeUpdate(
    { relative_path: 'src/foo.ts', name_path_pattern: 'bar', include_body: true },
    JSON.stringify({ result: 'Error executing tool: file not found' }), CWD, CTP
  );
  assert.equal(update, null);
});

test('Serena read_memory: returns null on error result', () => {
  const adapter = matchAdapter('mcp__serena__read_memory');
  const update = adapter.computeUpdate(
    { memory_name: 'nonexistent' },
    'Error executing tool read_memory: memory not found', CWD, CTP
  );
  assert.equal(update, null);
});
