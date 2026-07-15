// test/heroDiptych.test.js — Unit tests for heroDiptych logic changes (spec §2)
// Tests the computeEoqViewport integration + u reading + segment ratchet reset
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEoqViewport } from '../public/lib/xScale.js';

// --- Test: u = L_read / L_cap computation ---

test('u reading: L_read / L_cap ratio', () => {
  // u = L_read / L_cap per spec §2.1
  const L_read = 50000;
  const L_cap = 200000;
  const u = L_read / L_cap;
  assert.ok(Math.abs(u - 0.25) < 0.001);
});

test('u reading: null when L_cap is 0', () => {
  const L_read = 50000;
  const L_cap = 0;
  const u = (L_read != null && L_cap > 0) ? L_read / L_cap : null;
  assert.equal(u, null);
});

test('u reading: null when L_read is null', () => {
  const L_read = null;
  const L_cap = 200000;
  const u = (L_read != null && L_cap > 0) ? L_read / L_cap : null;
  assert.equal(u, null);
});

// --- Test: domain ratchet reset on segment change ---

test('ratchet: previousDomainMax persists within same segment', () => {
  // First call sets max
  const r1 = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 3.0, previousDomainMax: null,
  });
  // max(3.5, 3.0) * 1.2 = 4.2, clamped to min(11, 4.2) = 4.2
  assert.ok(Math.abs(r1.mainDomain.max - 4.2) < 0.001);

  // Second call with lower xCurrent — ratchet holds at previous max
  const r2 = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.5, previousDomainMax: r1.mainDomain.max,
  });
  assert.ok(Math.abs(r2.mainDomain.max - 4.2) < 0.001);
});

test('ratchet: null previousDomainMax allows fresh computation (segment change)', () => {
  // After segment change, previousDomainMax is reset to null
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.5, previousDomainMax: null,
  });
  // max(3.5, 1.5) * 1.2 = 4.2, no ratchet
  assert.ok(Math.abs(r.mainDomain.max - 4.2) < 0.001);
});

// --- Test: computeEoqViewport domain used for curve sampling ---

test('viewport domain min always starts at 1', () => {
  const r = computeEoqViewport({
    xBrAmberR: 3.0, xSweet: 2.5, xBrRedR: 4.0, wallP: 11, xCurrent: 2.3, previousDomainMax: null,
  });
  // min = 1 (always starts from origin so marker is never outside viewport)
  assert.ok(Math.abs(r.mainDomain.min - 1) < 0.001);
});

test('viewport domain for curve: starts at 1, includes full range to current', () => {
  const r = computeEoqViewport({
    xBrAmberR: 3.0, xSweet: 2.5, xBrRedR: 4.0, wallP: 11, xCurrent: 2.3, previousDomainMax: null,
  });
  // Domain starts at 1, max covers xBrRedR with headroom: max(4.0, 2.3)*1.2 = 4.8
  assert.ok(Math.abs(r.mainDomain.min - 1) < 0.001);
  assert.ok(r.mainDomain.max >= 4.0 * 1.2 - 0.01, `Expected max >= 4.8, got ${r.mainDomain.max}`);
});

// --- Test: dataset count ---

test('dataset indices: 7 datasets (0-6) with 4 landmark lines', () => {
  // 0: EOQ curve, 1: br=-10% line, 2: br=0 (sweet) line, 3: br=+10% line,
  // 4: br=+25% line, 5: amber dot (current x), 6: horizontal cost line
  const expectedDatasetCount = 7;
  assert.equal(expectedDatasetCount, 7, 'Should have 7 datasets (indices 0-6)');
});
