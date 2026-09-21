// test/dialogue-tool.test.js — the deterministic serialization Turn History measures and fingerprints
// tool evidence with. Both functions are pure and read no native tool name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeResult, stableStringify } from '../lib/dialogue-tool.js';

// ── stableStringify ────────────────────────────────────────────────────────────

test('stableStringify sorts object keys recursively and preserves array order', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableStringify({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
  assert.equal(stableStringify([3, 1, 2]), '[3,1,2]');
  assert.equal(stableStringify([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
});

test('stableStringify gives two spellings of one object the same bytes', () => {
  assert.equal(
    stableStringify({ file_path: '/a.js', limit: 10 }),
    stableStringify({ limit: 10, file_path: '/a.js' }),
  );
});

test('stableStringify renders primitives and both absent forms as JSON', () => {
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(undefined), undefined);
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify(7), '7');
  assert.equal(stableStringify(true), 'true');
});

// ── serializeResult ────────────────────────────────────────────────────────────

test('serializeResult: a string result is text, unchanged', () => {
  assert.deepEqual(serializeResult('hello'), { resultStr: 'hello', encoding: 'text' });
  assert.deepEqual(serializeResult(''), { resultStr: '', encoding: 'text' });
});

test('serializeResult: an all-text block array joins with newlines as text', () => {
  assert.deepEqual(
    serializeResult([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    { resultStr: 'a\nb', encoding: 'text' },
  );
});

test('serializeResult: a mixed block array is stable JSON', () => {
  const result = [{ type: 'text', text: 'a' }, { type: 'image', source: { data: 'x' } }];
  assert.deepEqual(serializeResult(result), { resultStr: stableStringify(result), encoding: 'json' });
});

test('serializeResult: an object result is stable JSON', () => {
  assert.deepEqual(serializeResult({ b: 1, a: 2 }), { resultStr: '{"a":2,"b":1}', encoding: 'json' });
});

test('serializeResult: an absent result is null, not the string "null"', () => {
  assert.deepEqual(serializeResult(null), { resultStr: null, encoding: 'text' });
  assert.deepEqual(serializeResult(undefined), { resultStr: null, encoding: 'text' });
});
