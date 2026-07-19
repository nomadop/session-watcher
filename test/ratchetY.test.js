// test/ratchetY.test.js — Y-axis ratchet: 80% trigger, 1.5× step
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeYRatchet, RATCHET_Y_INIT, RATCHET_Y_CAP } from '../public/chart-helpers.js';

// --- Core behavior: trigger at 80%, step 1.5× ---

test('ratchet stays when yMax is well below 80% of current ceiling', () => {
  // L at 50k, ceiling at 200k → 25% fill → no trigger
  const result = computeYRatchet(RATCHET_Y_INIT, 50000);
  assert.equal(result, RATCHET_Y_INIT, 'no ratchet when data is at 25%');
});

test('ratchet stays at exactly 80% boundary (not exceeded)', () => {
  // L exactly at 80% of 200k = 160,000 → boundary, not exceeded
  const result = computeYRatchet(200000, 160000);
  assert.equal(result, 200000, 'no ratchet at exactly 80%');
});

test('ratchet triggers when yMax exceeds 80% of current ceiling', () => {
  // L at 160,001 → > 80% of 200k → ratchet to 200k × 1.5 = 300k
  const result = computeYRatchet(200000, 160001);
  assert.equal(result, 300000, 'ratchets to 1.5× when data exceeds 80%');
});

test('ratchet triggers for current session scenario (L=199k, ceiling=200k)', () => {
  // The bug: L=198,776 with ceiling 200k — line pressed against top
  const result = computeYRatchet(200000, 198776);
  assert.equal(result, 300000, 'L at 99% triggers ratchet to 300k');
});

// --- Multi-step ratchet (data exceeds 80% of the new ceiling too) ---

test('ratchet steps multiple times if yMax exceeds 80% of successive ceilings', () => {
  // yMax = 250k → exceeds 80% of 200k (160k) → ratchet to 300k
  //            → does NOT exceed 80% of 300k (240k)... wait, 250k > 240k → ratchet to 450k
  const result = computeYRatchet(200000, 250000);
  assert.equal(result, 450000, 'two steps: 200k→300k→450k');
});

test('ratchet handles exact overflow at old 200k boundary', () => {
  // Old bug: L=200,001 previously needed to exceed ceiling, now 80% rule catches it much earlier
  const result = computeYRatchet(200000, 200001);
  assert.equal(result, 300000, 'overflow also triggers (> 80%)');
});

// --- Cap behavior ---

test('ratchet does not exceed RATCHET_Y_CAP', () => {
  // Force a value that would ratchet past cap
  const result = computeYRatchet(675000, 600000);
  // 600k > 80% of 675k (540k) → ratchet to 675k × 1.5 = 1,012,500 → capped at 1M
  assert.equal(result, RATCHET_Y_CAP, 'capped at 1M');
});

test('ratchet at cap stays at cap regardless of yMax', () => {
  const result = computeYRatchet(RATCHET_Y_CAP, 950000);
  assert.equal(result, RATCHET_Y_CAP, 'already at cap, no change');
});

// --- Monotonicity (never shrinks) ---

test('ratchet never shrinks even if yMax drops to zero', () => {
  const result = computeYRatchet(300000, 0);
  assert.equal(result, 300000, 'ratchet only grows, never shrinks');
});

test('ratchet never shrinks after previous ratchet-up', () => {
  // Simulate: previously ratcheted to 300k, now data dropped to 100k
  const result = computeYRatchet(300000, 100000);
  assert.equal(result, 300000, 'holds at 300k even with data at 33%');
});

// --- Step sequence verification ---

test('ratchet step sequence is 200k → 300k → 450k → 675k → 1M(cap)', () => {
  // Walk through full sequence with ever-increasing yMax
  let r = RATCHET_Y_INIT;
  r = computeYRatchet(r, 161000);  // > 80% of 200k
  assert.equal(r, 300000, 'step 1: 300k');
  r = computeYRatchet(r, 241000);  // > 80% of 300k
  assert.equal(r, 450000, 'step 2: 450k');
  r = computeYRatchet(r, 361000);  // > 80% of 450k
  assert.equal(r, 675000, 'step 3: 675k');
  r = computeYRatchet(r, 541000);  // > 80% of 675k
  assert.equal(r, RATCHET_Y_CAP, 'step 4: capped at 1M');
});
