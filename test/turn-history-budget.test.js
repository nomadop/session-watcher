// test/turn-history-budget.test.js — the sizing primitives every Turn History read is measured and cut
// with: the excerpt/query character limit, the read token budget, UTF-16-safe slicing, the truncation
// marker, wire sizing, and token-bounded truncation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_EXCERPT_CHARS,
  HISTORY_TOKEN_BUDGET,
  estimateWireTokens,
  isWithinHistoryBudget,
  safePrefix,
  safeSuffix,
  truncateToTokens,
  truncationMarker,
} from '../lib/turn-history-budget.js';
import { charsToTokens, countsToTokens } from '../lib/token-estimate.js';
import { DEFAULT_CTP } from '../lib/constants.js';

// ── The two bounds ─────────────────────────────────────────────────────────────

test('the excerpt limit contains a maximal query whole', () => {
  const q = 'q'.repeat(HISTORY_EXCERPT_CHARS);
  // The hit span is contained first, so a query at the limit still fits inside one excerpt window.
  assert.equal(safePrefix(q, HISTORY_EXCERPT_CHARS), q);
});

test('the budget admits its own boundary and rejects one token past it', () => {
  assert.equal(isWithinHistoryBudget(0), true);
  assert.equal(isWithinHistoryBudget(HISTORY_TOKEN_BUDGET), true);
  assert.equal(isWithinHistoryBudget(HISTORY_TOKEN_BUDGET + 1), false);
});

// ── UTF-16-safe slicing ────────────────────────────────────────────────────────

test('safePrefix keeps the limit when the boundary is not a surrogate', () => {
  assert.equal(safePrefix('abcdef', 3), 'abc');
  assert.equal(safePrefix('abc', 10), 'abc');
});

test('safePrefix backs off a boundary that would split a surrogate pair', () => {
  // '😀' is two UTF-16 code units: a cut at 1 would emit its high half alone.
  const text = '😀😀';
  assert.equal(safePrefix(text, 1), '');
  assert.equal(safePrefix(text, 2), '😀');
  assert.equal(safePrefix(text, 3), '😀');
});

test('safeSuffix keeps the limit when the boundary is not a surrogate', () => {
  assert.equal(safeSuffix('abcdef', 3), 'def');
  assert.equal(safeSuffix('abc', 10), 'abc');
});

test('safeSuffix advances past a low surrogate at the boundary', () => {
  const text = '😀😀';
  assert.equal(safeSuffix(text, 1), '');
  assert.equal(safeSuffix(text, 2), '😀');
});

// ── truncation marker ──────────────────────────────────────────────────────────

test('truncationMarker counts the length BEFORE the cut', () => {
  assert.equal(truncationMarker(842), ' [truncated; 842 chars]');
});

// ── wire sizing ────────────────────────────────────────────────────────────────

test('estimateWireTokens measures the JSON a response actually sends', () => {
  const payload = { turn_page: 'S1:4 | U: hello' };
  assert.equal(
    estimateWireTokens(payload, DEFAULT_CTP),
    Math.round(charsToTokens(JSON.stringify(payload), DEFAULT_CTP)),
  );
});

test('estimateWireTokens grows with the payload it is given', () => {
  const small = estimateWireTokens({ a: 'x' }, DEFAULT_CTP);
  const large = estimateWireTokens({ a: 'x'.repeat(4000) }, DEFAULT_CTP);
  assert.ok(large > small);
});

// ── token-bounded truncation ───────────────────────────────────────────────────

test('truncateToTokens returns the text itself when it already fits', () => {
  assert.equal(truncateToTokens('short', 1000, DEFAULT_CTP), 'short');
});

test('truncateToTokens cuts at the longest prefix within the limit', () => {
  const text = 'a'.repeat(1000);
  const cut = truncateToTokens(text, 10, DEFAULT_CTP);
  assert.ok(cut.length < text.length);
  assert.ok(countsToTokens({ chars: cut.length, cjk: 0 }, DEFAULT_CTP) <= 10);
  assert.ok(countsToTokens({ chars: cut.length + 1, cjk: 0 }, DEFAULT_CTP) > 10);
});

test('truncateToTokens accounts CJK separately from ASCII', () => {
  const cjk = truncateToTokens('日'.repeat(1000), 10, DEFAULT_CTP);
  const ascii = truncateToTokens('a'.repeat(1000), 10, DEFAULT_CTP);
  // One CJK character costs more tokens than one ASCII character, so the same budget buys fewer of them.
  assert.ok(cjk.length < ascii.length);
});

test('truncateToTokens cuts through a safe slice so no lone surrogate half is stored', () => {
  const cut = truncateToTokens('😀'.repeat(1000), 10, DEFAULT_CTP);
  assert.equal(cut.length % 2, 0);
  for (let i = 0; i < cut.length; i += 2) {
    const code = cut.charCodeAt(i);
    assert.ok(code >= 0xD800 && code <= 0xDBFF, 'every even index holds a high surrogate');
  }
});
