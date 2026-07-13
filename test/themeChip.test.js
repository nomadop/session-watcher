// test/themeChip.test.js — Unit tests for themeChip pure logic (spec §1.1 / Task 8)
// Tests the pure logic used in themeChip.js:
// 1. getCurrentTheme: localStorage reads + validation + fallback to 'h'
// 2. dotGradient: conic-gradient output shape
// 3. THEMES: correct ids, colors, labels
//
// These are logic-level tests — no DOM required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, VALID_IDS, resolveTheme, dotGradient } from '../public/lib/themeHelpers.js';

test('THEMES: has exactly 5 entries', () => {
  assert.equal(THEMES.length, 5);
});

test('THEMES: each entry has id, label, and 3 colors', () => {
  for (const t of THEMES) {
    assert.ok(typeof t.id === 'string' && t.id.length === 1, `id must be single char: ${t.id}`);
    assert.ok(typeof t.label === 'string' && t.label.length >= 1, `label must be non-empty: ${t.label}`);
    assert.ok(Array.isArray(t.colors) && t.colors.length === 3, `colors must be array of 3: ${t.id}`);
    for (const c of t.colors) {
      assert.match(c, /^#[0-9a-f]{6}$/i, `color must be 6-digit hex: ${c}`);
    }
  }
});

test('THEMES: ids are c, d, f, g, h', () => {
  assert.deepEqual(THEMES.map(t => t.id), ['c', 'd', 'f', 'g', 'h']);
});

test('THEMES: theme h is last (index 4) and is the fallback', () => {
  assert.equal(THEMES[4].id, 'h');
});

test('resolveTheme: valid stored id "c" → returns "c"', () => {
  assert.equal(resolveTheme('c'), 'c');
});

test('resolveTheme: valid stored id "h" → returns "h"', () => {
  assert.equal(resolveTheme('h'), 'h');
});

test('resolveTheme: valid stored id "f" → returns "f"', () => {
  assert.equal(resolveTheme('f'), 'f');
});

test('resolveTheme: null (no stored value) → falls back to "h"', () => {
  assert.equal(resolveTheme(null), 'h');
});

test('resolveTheme: undefined → falls back to "h"', () => {
  assert.equal(resolveTheme(undefined), 'h');
});

test('resolveTheme: empty string → falls back to "h"', () => {
  assert.equal(resolveTheme(''), 'h');
});

test('resolveTheme: unknown id "z" → falls back to "h"', () => {
  assert.equal(resolveTheme('z'), 'h');
});

test('resolveTheme: unknown id "dark" → falls back to "h"', () => {
  assert.equal(resolveTheme('dark'), 'h');
});

test('resolveTheme: all valid ids round-trip', () => {
  for (const id of VALID_IDS) {
    assert.equal(resolveTheme(id), id, `expected ${id} to round-trip`);
  }
});

// ── dotGradient ───────────────────────────────────────────────────────────────

test('dotGradient: returns conic-gradient string', () => {
  const result = dotGradient(['#ff0000', '#00ff00', '#0000ff']);
  assert.ok(result.startsWith('conic-gradient('), `expected conic-gradient prefix: ${result}`);
});

test('dotGradient: 3 colors → each gets 120deg segment', () => {
  const result = dotGradient(['#ff0000', '#00ff00', '#0000ff']);
  // First segment: 0deg 120deg
  assert.ok(result.includes('#ff0000 0deg 120deg'), `first segment: ${result}`);
  // Second segment: 120deg 240deg
  assert.ok(result.includes('#00ff00 120deg 240deg'), `second segment: ${result}`);
  // Third segment: 240deg 360deg
  assert.ok(result.includes('#0000ff 240deg 360deg'), `third segment: ${result}`);
});

test('dotGradient: uses actual theme h colors', () => {
  const themeH = THEMES.find(t => t.id === 'h');
  const result = dotGradient(themeH.colors);
  assert.ok(result.startsWith('conic-gradient('));
  // Should include all 3 colors
  for (const c of themeH.colors) {
    assert.ok(result.includes(c), `expected color ${c} in gradient`);
  }
});

test('dotGradient: single color → 0deg to 360deg', () => {
  const result = dotGradient(['#aabbcc']);
  assert.ok(result.includes('#aabbcc 0deg 360deg'));
});
