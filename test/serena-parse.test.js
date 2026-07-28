// test/serena-parse.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSerenaError,
  parseSerenaFindSymbol,
  parseSerenaSymbolsOverview,
  parseSerenaReferencing,
  parseSerenaPlainText,
} from '../lib/serena-parse.js';

test('parseSerenaFindSymbol: extracts bodies with paths and line ranges', () => {
  const input = JSON.stringify({
    result: JSON.stringify([
      {
        name_path: 'MyClass/myMethod',
        kind: 'Function',
        relative_path: 'src/foo.ts',
        body_location: { start_line: 10, end_line: 15 },
        body: 'function myMethod() {\n  return 42;\n}',
      },
      {
        name_path: 'helper',
        kind: 'Function',
        relative_path: 'src/bar.ts',
        body_location: { start_line: 1, end_line: 3 },
        body: 'function helper() {\n  return 1;\n}',
      },
    ]),
  });
  const result = parseSerenaFindSymbol(input);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].path, 'src/foo.ts');
  assert.equal(result.items[0].startLine, 10);
  assert.equal(result.items[0].endLine, 15);
  assert.equal(result.items[0].body, 'function myMethod() {\n  return 42;\n}');
  assert.equal(result.items[1].path, 'src/bar.ts');
  assert.equal(result.truncated, false);
});

test('parseSerenaFindSymbol: no-body results have null body', () => {
  const input = JSON.stringify({
    result: JSON.stringify([
      { name_path: 'Foo', kind: 'Class', relative_path: 'src/foo.ts', body_location: { start_line: 1, end_line: 50 } },
    ]),
  });
  const result = parseSerenaFindSymbol(input);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].body, null);
  assert.equal(result.items[0].path, 'src/foo.ts');
});

test('parseSerenaFindSymbol: truncated result (max_matches exceeded)', () => {
  const input = JSON.stringify({
    result: 'Matched 5>max_matches=1 symbols.\nShortened result:\n{"src/a.ts": ["Foo"], "src/b.ts": ["Bar"]}',
  });
  const result = parseSerenaFindSymbol(input);
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 0);
});

test('parseSerenaFindSymbol: empty result []', () => {
  const input = JSON.stringify({ result: '[]' });
  const result = parseSerenaFindSymbol(input);
  assert.equal(result.items.length, 0);
  assert.equal(result.truncated, false);
});

test('parseSerenaFindSymbol: backslash paths normalized to forward slash', () => {
  const input = JSON.stringify({
    result: JSON.stringify([
      { name_path: 'x', kind: 'Function', relative_path: 'packages\\\\server\\\\src\\\\app.ts', body_location: { start_line: 1, end_line: 2 }, body: 'x' },
    ]),
  });
  const result = parseSerenaFindSymbol(input);
  assert.equal(result.items[0].path, 'packages/server/src/app.ts');
});

test('parseSerenaSymbolsOverview: extracts symbol names from kind-grouped dict', () => {
  const input = JSON.stringify({
    result: JSON.stringify({ Function: ['foo', 'bar'], Class: ['Baz'] }),
  });
  const result = parseSerenaSymbolsOverview(input);
  assert.deepEqual(result.names.sort(), ['Baz', 'bar', 'foo']);
});

test('parseSerenaReferencing: extracts per-file context', () => {
  const input = JSON.stringify({
    result: JSON.stringify({
      'src/a.ts': {
        Function: [
          { name_path: 'handler', body_location: { start_line: 10, end_line: 20 }, content_around_reference: '  > 15: doThing(mySymbol)\n' },
        ],
      },
      'src/b.ts': {
        File: [
          { name_path: 'b', body_location: { start_line: 0, end_line: 100 }, content_around_reference: '  > 2: import { mySymbol }\n' },
        ],
      },
    }),
  });
  const result = parseSerenaReferencing(input);
  const paths = Object.keys(result.files);
  assert.equal(paths.length, 2);
  assert.ok(paths.includes('src/a.ts'));
  assert.equal(result.files['src/a.ts'][0].context, '  > 15: doThing(mySymbol)\n');
});

test('parseSerenaPlainText: unwraps {"result":"..."} envelope', () => {
  const input = JSON.stringify({ result: 'Hello world\nLine 2' });
  assert.equal(parseSerenaPlainText(input), 'Hello world\nLine 2');
});

test('parseSerenaPlainText: passes through non-JSON (error messages)', () => {
  const input = 'Error: tool failed';
  assert.equal(parseSerenaPlainText(input), 'Error: tool failed');
});

// ─── isSerenaError ──────────────────────────────────────────────────────────

test('isSerenaError: detects "Error executing tool" in raw text', () => {
  assert.equal(isSerenaError('Error executing tool find_symbol: validation error'), true);
});

test('isSerenaError: detects error inside {"result":"Error executing tool: ..."}', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: 'Error executing tool: ValueError - Cannot extract symbols' })), true);
});

test('isSerenaError: detects "No X found matching" pattern', () => {
  assert.equal(isSerenaError('No symbol found matching pattern "nonexistent"'), true);
  assert.equal(isSerenaError(JSON.stringify({ result: 'No symbols found matching pattern' })), true);
});

test('isSerenaError: returns false for normal result', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: 'ok' })), false);
});

test('isSerenaError: returns false for normal JSON array result', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: '[{"name_path":"foo"}]' })), false);
});

test('isSerenaError: returns false for memory content starting with "No"', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: 'No easy fix found for the timezone issue.' })), false);
});

test('isSerenaError: returns false for memory content starting with "Error:"', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: 'Error: this documents the Error class.' })), false);
});

test('isSerenaError: returns false for memory content starting with "Failed:"', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: 'Failed: describes why approach failed.' })), false);
});

test('isSerenaError: detects raw "Error: " prefix (timeout/inactive errors)', () => {
  assert.equal(isSerenaError('Error: tool timed out'), true);
  assert.equal(isSerenaError('Error: server inactive'), true);
});

test('isSerenaError: does NOT false-positive wrapped "Error: " in memory content', () => {
  assert.equal(isSerenaError(JSON.stringify({ result: 'Error: this is content about errors' })), false);
});

// ─── Malformed input edge cases ─────────────────────────────────────────────

test('parseSerenaFindSymbol: non-JSON string returns empty items', () => {
  assert.deepEqual(parseSerenaFindSymbol('not json at all'), { items: [], truncated: false });
});

test('parseSerenaFindSymbol: null input returns empty items', () => {
  assert.deepEqual(parseSerenaFindSymbol(null), { items: [], truncated: false });
});

test('parseSerenaFindSymbol: empty string returns empty items', () => {
  assert.deepEqual(parseSerenaFindSymbol(''), { items: [], truncated: false });
});

test('parseSerenaSymbolsOverview: non-JSON returns empty names', () => {
  assert.deepEqual(parseSerenaSymbolsOverview('garbage'), { names: [] });
});

test('parseSerenaReferencing: null returns empty files', () => {
  assert.deepEqual(parseSerenaReferencing(null), { files: {} });
});

test('parseSerenaReferencing: non-JSON returns empty files', () => {
  assert.deepEqual(parseSerenaReferencing('not valid json'), { files: {} });
});
