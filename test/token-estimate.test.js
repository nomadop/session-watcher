import test from 'node:test';
import assert from 'node:assert/strict';
import { charsToTokens, countsToTokens, CJK_RE } from '../lib/token-estimate.js';

const CLAUDE = { ascii: 2.45, cjk: 0.59 };

test('charsToTokens: pure ASCII uses ascii CTP', () => {
  const s = 'abcdefghij'; // 10 chars
  assert.ok(Math.abs(charsToTokens(s, CLAUDE) - 10 / 2.45) < 1e-9);
});

test('charsToTokens: mixed CJK splits ascii and cjk components', () => {
  const s = 'ab你好'; // 2 ascii + 2 cjk
  const expected = 2 / 2.45 + 2 / 0.59;
  assert.ok(Math.abs(charsToTokens(s, CLAUDE) - expected) < 1e-9);
});

test('charsToTokens: asciiOnly fast path ignores CJK scan', () => {
  const s = 'ab你好';
  assert.ok(Math.abs(charsToTokens(s, CLAUDE, { asciiOnly: true }) - s.length / 2.45) < 1e-9);
});

test('charsToTokens: empty string is zero', () => {
  assert.equal(charsToTokens('', CLAUDE), 0);
});

test('charsToTokens: Hangul and CJK-compatibility characters count as cjk', () => {
  assert.ok(Math.abs(charsToTokens('가', CLAUDE) - 1 / 0.59) < 1e-9);
  assert.ok(Math.abs(charsToTokens('豈', CLAUDE) - 1 / 0.59) < 1e-9);
});

test('CJK_RE is a global regex (reusable per call without lastIndex leakage in match())', () => {
  assert.ok(CJK_RE.global);
});

test('CJK_RE stays reusable across repeated charsToTokens calls', () => {
  const s = 'ab你好';
  const first = charsToTokens(s, CLAUDE);
  assert.equal(charsToTokens(s, CLAUDE), first);
  assert.equal(charsToTokens(s, CLAUDE), first);
});

test('countsToTokens: zero chars is zero', () => {
  assert.equal(countsToTokens({ chars: 0, cjk: 0 }, CLAUDE), 0);
});

test('countsToTokens: no cjk uses the ascii divisor alone', () => {
  assert.ok(Math.abs(countsToTokens({ chars: 10, cjk: 0 }, CLAUDE) - 10 / 2.45) < 1e-9);
});

test('countsToTokens matches charsToTokens on the same text', () => {
  const s = 'ab你好cd';
  const cjk = (s.match(CJK_RE) || []).length;
  assert.equal(countsToTokens({ chars: s.length, cjk }, CLAUDE), charsToTokens(s, CLAUDE));
});
