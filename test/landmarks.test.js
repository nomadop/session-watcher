import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nucleus, landmarksFor, hBreak, bandOf, landmarks } from '../lib/landmarks.js';

const R = 10, K = 940, LBASE = 55000;

test('52: deadOnly floor offset is b, not fixed 1', () => {
  const lDead = 0.25 * LBASE; // b = 0.25
  const { xStar } = landmarksFor(R, K, LBASE, lDead);
  const dhat = nucleus(R, K, LBASE) * Math.sqrt(0.25);
  assert.ok(Math.abs(xStar - (0.25 + 2 * dhat)) < 1e-9, 'xStar(b) = b + M·Δ̂·√b, offset = 0.25');
});

test('53: hBreak denominator is L−B (not L−lBase); L≤B → Infinity; fullCarry degenerates', () => {
  assert.equal(hBreak(R, LBASE, LBASE), Infinity, 'L=B → Infinity');
  assert.equal(hBreak(R, LBASE, LBASE - 1), Infinity, 'L<B → Infinity');
  const L = 2 * LBASE; // x=2, fullCarry
  assert.ok(Math.abs(hBreak(R, LBASE, L) - R / (L / LBASE - 1)) < 1e-9, 'fullCarry hBreak = cRatio/(x−1)');
  const lDead = 0.25 * LBASE;
  assert.ok(Math.abs(hBreak(R, lDead, L) - R * lDead / (L - lDead)) < 1e-6, 'deadOnly uses L−lDead');
});

test('54: deadOnly xStar < fullCarry xStar (deadOnly exits earlier)', () => {
  const full = landmarksFor(R, K, LBASE, LBASE);
  const dead = landmarksFor(R, K, LBASE, 0.25 * LBASE);
  assert.ok(dead.xStar < full.xStar, 'deadOnly exit is earlier');
});

test('55: bandOf is a neutral enum, never a verdict word', () => {
  const lm = landmarksFor(R, K, LBASE, LBASE);
  assert.equal(bandOf(0.5, lm), 'below_entry');
  assert.equal(bandOf(lm.xEntry + 1e-9, lm), 'entry_to_sweet');
  assert.equal(bandOf(lm.xSweet + 1e-9, lm), 'sweet_to_exit');
  assert.equal(bandOf(lm.xStar + 1, lm), 'above_exit');
  for (const b of ['below_entry','entry_to_sweet','sweet_to_exit','above_exit']) {
    assert.ok(!/overdue|waste|must|urgent/i.test(b));
  }
});

test('56: landmarks bundle gives both endpoints + each hBreak/band; tool does not interpolate', () => {
  const L = 1.5 * LBASE;
  const b = landmarks(R, K, LBASE, 0.25 * LBASE, L);
  assert.ok(Math.abs(b.x - 1.5) < 1e-9);
  assert.ok('xStar' in b.fullCarry && 'hBreak' in b.fullCarry && 'band' in b.fullCarry);
  assert.ok('xStar' in b.deadOnly && 'hBreak' in b.deadOnly && 'band' in b.deadOnly);
  assert.ok(b.deadOnly.xStar < b.fullCarry.xStar, 'two distinct endpoints, no blended middle');
});

test('nucleus guards non-positive inputs → 0', () => {
  assert.equal(nucleus(0, K, LBASE), 0);
  assert.equal(nucleus(R, 0, LBASE), 0);
  assert.equal(nucleus(R, K, 0), 0);
});
