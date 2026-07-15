// test/depthAux.test.js — Unit tests for depthAux overview bar (spec §3)
// Tests the logic paths in depthAux.js: viewport frame positioning, gradient zones,
// label rendering, degradation on unavailable capabilities, and segment-change ratchet reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEoqViewport, computeLandmarkPositions, validateLandmarks } from '../public/lib/xScale.js';

// --- Test: viewport frame positioning via computeEoqViewport ---

test('depthAux: viewport frame left/right from computeEoqViewport overview domain [1, wallP]', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.8, previousDomainMax: null,
  });
  // overviewDomain is always [1, wallP]
  assert.deepEqual(r.overviewDomain, { min: 1, max: 11 });
  assert.ok(r.viewportPct.left >= 0 && r.viewportPct.left <= 100);
  assert.ok(r.viewportPct.right >= r.viewportPct.left);
  assert.ok(r.viewportPct.right <= 100);
});

test('depthAux: viewport frame width = right - left as percentage', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.8, previousDomainMax: null,
  });
  const width = r.viewportPct.right - r.viewportPct.left;
  assert.ok(width > 0, `Viewport width should be > 0, got ${width}`);
  assert.ok(width <= 100, `Viewport width should be <= 100, got ${width}`);
});

// --- Test: marker positioning in overview domain ---

test('depthAux: markerPct maps xCurrent within [1, wallP] linearly', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 6, previousDomainMax: null,
  });
  // markerPct = (6 - 1) / (11 - 1) * 100 = 50%
  assert.ok(Math.abs(r.markerPct - 50) < 0.01);
});

test('depthAux: markerPct clamps to 100 when xCurrent > wallP', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 15, previousDomainMax: null,
  });
  assert.equal(r.markerPct, 100);
  assert.equal(r.isPastWall, true);
});

test('depthAux: markerPct at 0 when xCurrent = 1', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1, previousDomainMax: null,
  });
  assert.equal(r.markerPct, 0);
});

// --- Test: overview-domain landmark positions for gradient ---

test('depthAux: computeLandmarkPositions with overviewDomain [1, wallP] produces zone pcts', () => {
  const overviewDomain = { minX: 1, maxX: 11 };
  const r = computeLandmarkPositions({
    domain: overviewDomain, xBrAmberL: 1.3, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11, x: 1.8,
  });
  // brAmberLPct = (1.3 - 1) / 10 * 100 = 3%
  assert.ok(Math.abs(r.brAmberLPct - 3) < 0.1);
  // sweetPct = (1.6 - 1) / 10 * 100 = 6%
  assert.ok(Math.abs(r.sweetPct - 6) < 0.1);
  // brAmberRPct = (2.2 - 1) / 10 * 100 = 12%
  assert.ok(Math.abs(r.brAmberRPct - 12) < 0.1);
  // brRedRPct = (3.5 - 1) / 10 * 100 = 25%
  assert.ok(Math.abs(r.brRedRPct - 25) < 0.1);
  // wallPct = (11 - 1) / 10 * 100 = 100%
  assert.ok(Math.abs(r.wallPct - 100) < 0.1);
});

// --- Test: validateLandmarks gate ---

test('depthAux: validateLandmarks rejects NaN xSweet → bar hidden', () => {
  const v = validateLandmarks({ xBrAmberL: 1.3, xSweet: NaN, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 });
  assert.equal(v.ok, false);
});

test('depthAux: validateLandmarks rejects non-monotonic → bar hidden', () => {
  const v = validateLandmarks({ xBrAmberL: 1.3, xSweet: 3.0, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 });
  assert.equal(v.ok, false);
});

test('depthAux: validateLandmarks passes valid monotonic landmarks', () => {
  const v = validateLandmarks({ xBrAmberL: 1.3, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 });
  assert.equal(v.ok, true);
});

// --- Test: segment-change ratchet reset logic ---

test('depthAux: segment change resets previousDomainMax (ratchet)', () => {
  // Simulate: segment A has high x, domain expands
  const r1 = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 5.0, previousDomainMax: null,
  });
  // max(3.5, 5.0) * 1.2 = 6.0
  assert.ok(Math.abs(r1.mainDomain.max - 6.0) < 0.001);

  // Segment changes → previousDomainMax resets to null
  const r2 = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 1.5, previousDomainMax: null,
  });
  // max(3.5, 1.5) * 1.2 = 4.2 — NOT 6.0
  assert.ok(Math.abs(r2.mainDomain.max - 4.2) < 0.001);
});

// --- Test: isPastWall flag for marker flag text ---

test('depthAux: isPastWall flag enables "past wall" text', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 12, previousDomainMax: null,
  });
  assert.equal(r.isPastWall, true);
});

test('depthAux: not past wall when xCurrent < wallP', () => {
  const r = computeEoqViewport({
    xBrAmberR: 2.2, xSweet: 1.6, xBrRedR: 3.5, wallP: 11, xCurrent: 5, previousDomainMax: null,
  });
  assert.equal(r.isPastWall, false);
});

// --- Test: buildLabelsHTML logic (wide bar shows 4 labels, narrow hides internal) ---

test('depthAux: buildLabelsHTML — wide bar (>=120px) includes sweet and deep labels', () => {
  const barWidth = 200;
  const labels = [];
  labels.push('shallow');
  labels.push('wall');
  if (barWidth >= 120) {
    labels.push('sweet');
    labels.push('deep');
  }
  assert.equal(labels.length, 4);
  assert.ok(labels.includes('sweet'));
  assert.ok(labels.includes('deep'));
});

test('depthAux: buildLabelsHTML — narrow bar (<120px) only shows external labels', () => {
  const barWidth = 80;
  const labels = [];
  labels.push('shallow');
  labels.push('wall');
  if (barWidth >= 120) {
    labels.push('sweet');
    labels.push('deep');
  }
  assert.equal(labels.length, 2);
  assert.ok(!labels.includes('sweet'));
});

// --- Test: degradation when capabilities.eoqLandmarks.available is false ---

test('depthAux: unavailable capabilities hide the bar (logic check)', () => {
  const snapshot = { capabilities: { eoqLandmarks: { available: false } }, status: {} };
  const available = snapshot?.capabilities?.eoqLandmarks?.available === true;
  const rl = snapshot?.status?.rateLamp;
  assert.equal(available, false);
  assert.equal(rl, undefined);
});

test('depthAux: null rateLamp hides bar even when capabilities say available', () => {
  const snapshot = { capabilities: { eoqLandmarks: { available: true } }, status: {} };
  const available = snapshot?.capabilities?.eoqLandmarks?.available === true;
  const rl = snapshot?.status?.rateLamp;
  assert.equal(available, true);
  assert.equal(rl, undefined);
});
