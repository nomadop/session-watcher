// test/xScale.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLandmarkPositions, validateLandmarks, computeEoqViewport } from '../public/lib/xScale.js';

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
test('valid monotonic landmarks', () => {
  assert.equal(validateLandmarks({ xBrAmberL: 1.3, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 }).ok, true);
});
test('non-monotonic landmarks fail', () => {
  assert.equal(validateLandmarks({ xBrAmberL: 1.3, xSweet: 3.0, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 }).ok, false);
});
test('NaN xSweet landmark fails', () => {
  assert.equal(validateLandmarks({ xBrAmberL: 1.3, xSweet: NaN, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 }).ok, false);
});
test('xBrAmberL NaN is tolerated (optional)', () => {
  assert.equal(validateLandmarks({ xBrAmberL: NaN, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 }).ok, true);
});

test('computeEoqViewport — normal case: domain starts at 1, marker always inside', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.8, previousDomainMax: null,
  });
  // mainDomain.min = 1 (always starts from 1 so marker is never left of viewport)
  assert.ok(Math.abs(r.mainDomain.min - 1) < 0.001);
  // mainDomain.max = min(11, max(3.5, 1.8) * 1.2) = min(11, 4.2) = 4.2
  assert.ok(Math.abs(r.mainDomain.max - 4.2) < 0.001);
  assert.deepEqual(r.overviewDomain, { min: 1, max: 11 });
  assert.equal(r.isPastWall, false);
  // viewportPct.left = (1 - 1) / (11 - 1) * 100 = 0
  assert.ok(Math.abs(r.viewportPct.left) < 0.001);
  // viewportPct.right = (4.2 - 1) / (11 - 1) * 100 = 32
  assert.ok(r.viewportPct.right > 25 && r.viewportPct.right < 40);
});

test('computeEoqViewport — ratchet: previousDomainMax prevents shrink', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.5, previousDomainMax: 5.0,
  });
  // Without ratchet, max would be min(11, max(3.5, 1.5)*1.2) = 4.2
  // With ratchet, max = max(5.0, 4.2) = 5.0
  assert.ok(Math.abs(r.mainDomain.max - 5.0) < 0.001);
});

test('computeEoqViewport — xCurrent > wallP: isPastWall + clamp', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 13, previousDomainMax: null,
  });
  assert.equal(r.isPastWall, true);
  // mainDomain.max clamped to wallP
  assert.ok(r.mainDomain.max <= 11);
  // markerPct clamped to 100
  assert.equal(r.markerPct, 100);
});

test('computeEoqViewport — minimum span guard', () => {
  const r = computeEoqViewport({
    xBrAmberR: 1.0, xSweet: 1.0, xBrRedR: 1.0, wallP: 11, xCurrent: 1.0, previousDomainMax: null,
  });
  // min span = 0.3
  assert.ok(r.mainDomain.max - r.mainDomain.min >= 0.3);
});

test('computeEoqViewport — min floors at 1', () => {
  const r = computeEoqViewport({
    xBrAmberR: 1.8, xSweet: 1.3, xBrRedR: 2.5, wallP: 11, xCurrent: 1.2, previousDomainMax: null,
  });
  // min is always 1 (viewport starts from origin)
  assert.equal(r.mainDomain.min, 1);
});

test('computeEoqViewport — previewGroup expands viewport ephemerally', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11,
    xCurrent: 1.8, previousDomainMax: null,
    previewGroup: { xRedR: 6.0, x: 5.5 },
  });
  // Ghost max = max(6.0, 5.5, 3.5, 1.8) * 1.12 = 6.72
  // Without ghost: max(3.5, 1.8) * 1.2 = 4.2
  // Final visible max = max(4.2, 6.72) = 6.72
  assert.ok(Math.abs(r.mainDomain.max - 6.72) < 0.01, `Expected ~6.72, got ${r.mainDomain.max}`);
  // actualDomainMax is pre-ghost (ratchet-safe); callers use this to avoid a second invocation
  assert.ok(Math.abs(r.actualDomainMax - 4.2) < 0.01, `Expected actualDomainMax ~4.2 (pre-ghost), got ${r.actualDomainMax}`);
});

test('computeEoqViewport — previewGroup does not advance ratchet', () => {
  // With previewGroup: viewport is 6.72
  computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11,
    xCurrent: 1.8, previousDomainMax: null,
    previewGroup: { xRedR: 6.0, x: 5.5 },
  });
  // Without previewGroup using same inputs: viewport should NOT retain ghost expansion
  const actual = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11,
    xCurrent: 1.8, previousDomainMax: null,
  });
  // Actual max = max(3.5, 1.8) * 1.2 = 4.2
  assert.ok(Math.abs(actual.mainDomain.max - 4.2) < 0.01, `Expected ~4.2, got ${actual.mainDomain.max}`);
});

test('computeEoqViewport — previewGroup with NaN values is filtered safely', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11,
    xCurrent: 1.8, previousDomainMax: null,
    previewGroup: { xRedR: NaN, x: 5.0 },
  });
  // Only finite candidate is 5.0; ghost max = max(5.0, 3.5, 1.8) * 1.12 = 5.6
  assert.ok(Math.abs(r.mainDomain.max - 5.6) < 0.01, `Expected ~5.6, got ${r.mainDomain.max}`);
});
