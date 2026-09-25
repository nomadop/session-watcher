// test/xScale.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLandmarkPositions, computeEoqViewport, projectedX } from '../public/lib/xScale.js';

test('projectedX places a causal position on the reference skeleton, and nowhere without one', () => {
  assert.equal(projectedX({ a: 0.8, d: 0.5 }, 1.4), 1.5);
  assert.equal(projectedX(null, 1.4), null);
  assert.equal(projectedX({ a: 0.8, d: 0.5 }, null), null);
});

test('landmarks map to correct percentages', () => {
  const domain = { minX: 1, maxX: 11 };
  const r = computeLandmarkPositions({ domain, xBrAmberL: 1.3, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11, x: 2.5 });
  assert.ok(Math.abs(r.brAmberLPct - 3) < 0.1);
  assert.ok(Math.abs(r.wallPct - 100) < 0.1);
  assert.equal(r.clamped, false);
});
test('x < minX clamps marker to 0%', () => {
  const r = computeLandmarkPositions({ domain: { minX: 1, maxX: 11 }, xBrAmberL: 1.3, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11, x: 0.5 });
  assert.equal(r.markerPct, 0); assert.equal(r.clamped, true);
});
test('computeEoqViewport — opens at [1, √wallP] while the point is left of the lock point', () => {
  const r = computeEoqViewport({ wallP: 16, xCurrent: 1.5, previousDomainMax: null });
  assert.deepEqual(r.mainDomain, { min: 1, max: 4 });
  assert.deepEqual(r.overviewDomain, { min: 1, max: 16 });
  assert.equal(r.isPastWall, false);
  assert.ok(Math.abs(r.viewportPct.left) < 1e-9);
  assert.ok(Math.abs(r.viewportPct.right - 20) < 1e-9);
});

// The axis opens where the reference's asymptote stands — u = 0, the segment's starting position a — so the left
// arm always hugs the axis; without a reference the origin is the baseline itself.
test('computeEoqViewport — the window starts at the origin, and locks the point against it', () => {
  const r = computeEoqViewport({ wallP: 16, xCurrent: 2.5, previousDomainMax: null, origin: 1.2 });
  assert.deepEqual(r.mainDomain, { min: 1.2, max: 4 });
  assert.ok(Math.abs(r.viewportPct.left - (0.2 / 15) * 100) < 1e-9);
  const widened = computeEoqViewport({ wallP: 16, xCurrent: 4.2, previousDomainMax: null, origin: 1.2 });
  assert.ok(Math.abs(widened.mainDomain.max - 5.2) < 1e-9);
  assert.equal(computeEoqViewport({ wallP: 16, xCurrent: 1.5, previousDomainMax: null, origin: null }).mainDomain.min, 1);
});

test('computeEoqViewport — a point past the lock point widens the window to hold the point there', () => {
  const r = computeEoqViewport({ wallP: 16, xCurrent: 4, previousDomainMax: null });
  assert.deepEqual(r.mainDomain, { min: 1, max: 5 });
  assert.ok(Math.abs((4 - r.mainDomain.min) / (r.mainDomain.max - r.mainDomain.min) - 0.75) < 1e-9);
});

test('computeEoqViewport — a retreating point leaves the window where it stood', () => {
  const r = computeEoqViewport({ wallP: 16, xCurrent: 2, previousDomainMax: 5 });
  assert.equal(r.mainDomain.max, 5);
  assert.equal(r.actualDomainMax, 5);
});

test('computeEoqViewport — the window never reaches past the wall', () => {
  const inside = computeEoqViewport({ wallP: 16, xCurrent: 13, previousDomainMax: null });
  assert.equal(inside.mainDomain.max, 16);
  assert.equal(inside.isPastWall, false);
  const past = computeEoqViewport({ wallP: 16, xCurrent: 17, previousDomainMax: 16 });
  assert.equal(past.mainDomain.max, 16);
  assert.equal(past.actualDomainMax, 16);
  assert.equal(past.isPastWall, true);
  assert.equal(past.markerPct, 100);
});

test('computeEoqViewport — √wallP floors the right edge: a ratchet carried from a smaller wall widens to it', () => {
  const r = computeEoqViewport({ wallP: 100, xCurrent: 1.2, previousDomainMax: 4 });
  assert.equal(r.mainDomain.max, 10);
  assert.equal(r.actualDomainMax, 10);
  // An origin right of the baseline separates the two readings: flooring the right edge leaves the max at √wallP,
  // where flooring the opening span, √wallP − 1, would add it to the origin instead.
  const shifted = computeEoqViewport({ wallP: 100, xCurrent: 1.2, previousDomainMax: null, origin: 2 });
  assert.equal(shifted.mainDomain.min, 2);
  assert.equal(shifted.mainDomain.max, 10);
});

test('computeEoqViewport — a non-finite point holds the window and does not advance the ratchet', () => {
  const fresh = computeEoqViewport({ wallP: 16, xCurrent: null, previousDomainMax: null });
  assert.equal(fresh.mainDomain.max, 4);
  assert.equal(fresh.actualDomainMax, 4);
  const held = computeEoqViewport({ wallP: 16, xCurrent: NaN, previousDomainMax: 5 });
  assert.equal(held.mainDomain.max, 5);
  assert.equal(held.actualDomainMax, 5);
});

test('computeEoqViewport — previewX widens the window by the same rule without advancing the ratchet', () => {
  const r = computeEoqViewport({ wallP: 16, xCurrent: 1.5, previousDomainMax: null, previewX: 7 });
  assert.equal(r.mainDomain.max, 9);
  assert.equal(r.actualDomainMax, 4);
  const capped = computeEoqViewport({ wallP: 16, xCurrent: 1.5, previousDomainMax: null, previewX: 13 });
  assert.equal(capped.mainDomain.max, 16);
});

test('computeEoqViewport — a previewX left of the lock point, or non-finite, leaves the window alone', () => {
  const inside = computeEoqViewport({ wallP: 16, xCurrent: 1.5, previousDomainMax: null, previewX: 2 });
  assert.equal(inside.mainDomain.max, 4);
  const nan = computeEoqViewport({ wallP: 16, xCurrent: 1.5, previousDomainMax: null, previewX: NaN });
  assert.equal(nan.mainDomain.max, 4);
});
