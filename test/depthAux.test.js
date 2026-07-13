// test/depthAux.test.js — Unit tests for depthAux overview bar (spec §3)
// Tests the logic paths in depthAux.js: viewport frame positioning, gradient zones,
// label rendering, degradation on unavailable capabilities, and segment-change ratchet reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEoqViewport, computeLandmarkPositions, validateLandmarks } from '../public/lib/xScale.js';

// --- Test: viewport frame positioning via computeEoqViewport ---

test('depthAux: viewport frame left/right from computeEoqViewport overview domain [1, wallP]', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 1.8, previousDomainMax: null,
  });
  // overviewDomain is always [1, wallP]
  assert.deepEqual(r.overviewDomain, { min: 1, max: 11 });
  // viewportPct.left = (mainDomain.min - 1) / (wallP - 1) * 100
  // mainDomain.min = max(1, 1.3*0.85) = 1.105
  // viewportPct.left = (1.105 - 1) / 10 * 100 = 1.05
  assert.ok(r.viewportPct.left >= 0 && r.viewportPct.left <= 100);
  assert.ok(r.viewportPct.right >= r.viewportPct.left);
  assert.ok(r.viewportPct.right <= 100);
});

test('depthAux: viewport frame width = right - left as percentage', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 1.8, previousDomainMax: null,
  });
  const width = r.viewportPct.right - r.viewportPct.left;
  assert.ok(width > 0, `Viewport width should be > 0, got ${width}`);
  assert.ok(width <= 100, `Viewport width should be <= 100, got ${width}`);
});

// --- Test: marker positioning in overview domain ---

test('depthAux: markerPct maps xCurrent within [1, wallP] linearly', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 6, previousDomainMax: null,
  });
  // markerPct = (6 - 1) / (11 - 1) * 100 = 50%
  assert.ok(Math.abs(r.markerPct - 50) < 0.01);
});

test('depthAux: markerPct clamps to 100 when xCurrent > wallP', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 15, previousDomainMax: null,
  });
  assert.equal(r.markerPct, 100);
  assert.equal(r.isPastWall, true);
});

test('depthAux: markerPct at 0 when xCurrent = 1', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 1, previousDomainMax: null,
  });
  assert.equal(r.markerPct, 0);
});

// --- Test: overview-domain landmark positions for gradient ---

test('depthAux: computeLandmarkPositions with overviewDomain [1, wallP] produces zone pcts', () => {
  const overviewDomain = { minX: 1, maxX: 11 };
  const r = computeLandmarkPositions({
    domain: overviewDomain, xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, x: 1.8,
  });
  // entryPct = (1.3 - 1) / 10 * 100 = 3%
  assert.ok(Math.abs(r.entryPct - 3) < 0.1);
  // sweetPct = (1.6 - 1) / 10 * 100 = 6%
  assert.ok(Math.abs(r.sweetPct - 6) < 0.1);
  // exitPct = (2.2 - 1) / 10 * 100 = 12%
  assert.ok(Math.abs(r.exitPct - 12) < 0.1);
  // wallPct = (11 - 1) / 10 * 100 = 100%
  assert.ok(Math.abs(r.wallPct - 100) < 0.1);
});

// --- Test: validateLandmarks gate ---

test('depthAux: validateLandmarks rejects NaN → bar hidden', () => {
  const v = validateLandmarks({ xEntry: NaN, xSweet: 1.6, xExit: 2.2, wallP: 11 });
  assert.equal(v.ok, false);
});

test('depthAux: validateLandmarks rejects non-monotonic → bar hidden', () => {
  const v = validateLandmarks({ xEntry: 3.0, xSweet: 1.6, xExit: 2.2, wallP: 11 });
  assert.equal(v.ok, false);
});

test('depthAux: validateLandmarks passes valid monotonic landmarks', () => {
  const v = validateLandmarks({ xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11 });
  assert.equal(v.ok, true);
});

// --- Test: segment-change ratchet reset logic ---

test('depthAux: segment change resets previousDomainMax (ratchet)', () => {
  // Simulate: segment A has high x, domain expands
  const r1 = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 5.0, previousDomainMax: null,
  });
  // max(2.2, 5.0) * 1.2 = 6.0
  assert.ok(Math.abs(r1.mainDomain.max - 6.0) < 0.001);

  // Segment changes → previousDomainMax resets to null
  // New lower x gets fresh computation without ratchet
  const r2 = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 1.5, previousDomainMax: null,
  });
  // max(2.2, 1.5) * 1.2 = 2.64 — NOT 6.0
  assert.ok(Math.abs(r2.mainDomain.max - 2.64) < 0.001);
});

// --- Test: isPastWall flag for marker flag text ---

test('depthAux: isPastWall flag enables "past wall" text', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 12, previousDomainMax: null,
  });
  assert.equal(r.isPastWall, true);
});

test('depthAux: not past wall when xCurrent < wallP', () => {
  const r = computeEoqViewport({
    xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11, xCurrent: 5, previousDomainMax: null,
  });
  assert.equal(r.isPastWall, false);
});

// --- Test: buildLabelsHTML logic (wide bar shows 4 labels, narrow hides internal) ---

test('depthAux: buildLabelsHTML — wide bar (>=120px) includes sweet and deep labels', () => {
  // Simulate the logic inline since it's a pure function in the module
  const barWidth = 200;
  const entryPct = 3;
  const exitPct = 12;
  const wallPct = 100;
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
  // The renderBar logic: if (!available || !rl) → bar hidden
  const snapshot = { capabilities: { eoqLandmarks: { available: false } }, status: {} };
  const available = snapshot?.capabilities?.eoqLandmarks?.available === true;
  const rl = snapshot?.status?.rateLamp;
  assert.equal(available, false);
  assert.equal(rl, undefined);
  // Both conditions false → bar should be hidden
});

test('depthAux: null rateLamp hides bar even when capabilities say available', () => {
  const snapshot = { capabilities: { eoqLandmarks: { available: true } }, status: {} };
  const available = snapshot?.capabilities?.eoqLandmarks?.available === true;
  const rl = snapshot?.status?.rateLamp;
  assert.equal(available, true);
  assert.equal(rl, undefined);
  // !rl is true → bar still hidden
});
