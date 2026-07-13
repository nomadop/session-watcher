// test/xScale.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLandmarkPositions, validateLandmarks, computeEoqViewport } from '../public/lib/xScale.js';

test('landmarks map to correct percentages', () => {
  const domain = { minX: 1, maxX: 11 };
  const r = computeLandmarkPositions({ domain, xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, x: 2.5 });
  assert.ok(Math.abs(r.entryPct - 3) < 0.1);
  assert.ok(Math.abs(r.wallPct - 100) < 0.1);
  assert.equal(r.clamped, false);
});
test('x < minX clamps marker to 0%', () => {
  const r = computeLandmarkPositions({ domain: { minX: 1, maxX: 11 }, xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, x: 0.5 });
  assert.equal(r.markerPct, 0); assert.equal(r.clamped, true);
});
test('valid monotonic landmarks', () => {
  assert.equal(validateLandmarks({ xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11 }).ok, true);
});
test('non-monotonic landmarks fail', () => {
  assert.equal(validateLandmarks({ xEntry: 2.0, xSweet: 1.5, xExit: 2.2, wallP: 11 }).ok, false);
});
test('NaN landmark fails', () => {
  assert.equal(validateLandmarks({ xEntry: NaN, xSweet: 1.6, xExit: 2.2, wallP: 11 }).ok, false);
});

test('computeEoqViewport — normal case: domain focuses around landmarks', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 1.8, previousDomainMax: null,
  });
  // mainDomain.min = max(1, 1.3 * 0.85) = max(1, 1.105) = 1.105
  assert.ok(Math.abs(r.mainDomain.min - 1.105) < 0.001);
  // mainDomain.max = min(11, max(2.2, 1.8) * 1.2) = min(11, 2.64) = 2.64
  assert.ok(Math.abs(r.mainDomain.max - 2.64) < 0.001);
  assert.deepEqual(r.overviewDomain, { min: 1, max: 11 });
  assert.equal(r.isPastWall, false);
  // viewportPct.left = (1.105 - 1) / (11 - 1) * 100 = 1.05
  assert.ok(r.viewportPct.left > 0 && r.viewportPct.left < 5);
  // viewportPct.right = (2.64 - 1) / (11 - 1) * 100 = 16.4
  assert.ok(r.viewportPct.right > 10 && r.viewportPct.right < 20);
});

test('computeEoqViewport — ratchet: previousDomainMax prevents shrink', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 1.5, previousDomainMax: 5.0,
  });
  // Without ratchet, max would be min(11, max(2.2, 1.5)*1.2) = 2.64
  // With ratchet, max = max(5.0, 2.64) = 5.0
  assert.ok(Math.abs(r.mainDomain.max - 5.0) < 0.001);
});

test('computeEoqViewport — xCurrent > wallP: isPastWall + clamp', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 13, previousDomainMax: null,
  });
  assert.equal(r.isPastWall, true);
  // mainDomain.max clamped to wallP
  assert.ok(r.mainDomain.max <= 11);
  // markerPct clamped to 100
  assert.equal(r.markerPct, 100);
});

test('computeEoqViewport — minimum span guard', () => {
  const r = computeEoqViewport({
    xEntry: 1.0, xSweet: 1.0, xExit: 1.0, wallP: 11, xCurrent: 1.0, previousDomainMax: null,
  });
  // min span = 0.3
  assert.ok(r.mainDomain.max - r.mainDomain.min >= 0.3);
});

test('computeEoqViewport — xEntry < 1.18: min floors at 1', () => {
  const r = computeEoqViewport({
    xEntry: 1.1, xSweet: 1.3, xExit: 1.8, wallP: 11, xCurrent: 1.2, previousDomainMax: null,
  });
  // max(1, 1.1 * 0.85) = max(1, 0.935) = 1
  assert.equal(r.mainDomain.min, 1);
});
