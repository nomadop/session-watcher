// test/featureDetect.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilities } from '../public/lib/featureDetect.js';

test('all available when reliable with valid data', () => {
  const caps = buildCapabilities({ rateLamp: { reliable: true, billProgress: 0.62, hBreak: 7, xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11 } });
  assert.equal(caps.eoqLandmarks.available, true);
  assert.equal(caps.billingLedger.available, true);
  assert.equal(caps.breakEvenTurns.available, true);
});
test('billingLedger unavailable when billProgress null', () => {
  const caps = buildCapabilities({ rateLamp: { reliable: true, billProgress: null, hBreak: 7, xEntry: 1.3, xSweet: 1.6, xExit: 2.2, wallP: 11 } });
  assert.equal(caps.billingLedger.available, false);
});
test('breakEvenTurns unavailable when not reliable', () => {
  const caps = buildCapabilities({ rateLamp: { reliable: false, billProgress: 0.5, hBreak: 7 } });
  assert.equal(caps.breakEvenTurns.available, false);
});
test('eoqLandmarks unavailable when non-monotonic', () => {
  const caps = buildCapabilities({ rateLamp: { reliable: true, billProgress: 0.5, hBreak: 7, xEntry: 2.5, xSweet: 1.6, xExit: 2.2, wallP: 11 } });
  assert.equal(caps.eoqLandmarks.available, false);
});
test('null rateLamp degrades gracefully', () => {
  const caps = buildCapabilities({});
  assert.equal(caps.billingLedger.available, false);
  assert.equal(caps.eoqLandmarks.available, false);
});
