// test/featureDetect.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilities } from '../public/lib/featureDetect.js';

test('all available when reliable with valid data', () => {
  const caps = buildCapabilities({ rateLamp: { reliable: true, billProgress: 0.62, hBreak: 7, xBrAmberL: 1.3, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 } });
  assert.equal(caps.eoqLandmarks.available, true);
  assert.equal(caps.billingLedger.available, true);
});
test('billingLedger unavailable when billProgress null', () => {
  const caps = buildCapabilities({ rateLamp: { reliable: true, billProgress: null, hBreak: 7, xSweet: 1.6, xBrAmberR: 2.2, xBrRedR: 3.5, wallP: 11 } });
  assert.equal(caps.billingLedger.available, false);
});
test('null rateLamp degrades gracefully', () => {
  const caps = buildCapabilities({});
  assert.equal(caps.billingLedger.available, false);
  assert.equal(caps.eoqLandmarks.available, false);
});
test('eoqLandmarks follows the server contract: available iff reliable and xSweet is set', () => {
  const on = buildCapabilities({ rateLamp: { reliable: true, xSweet: 1.4, billProgress: 0.1 } });
  assert.equal(on.eoqLandmarks.available, true);
  const off = buildCapabilities({ rateLamp: { reliable: true, xSweet: null, billProgress: 0.1 } });
  assert.equal(off.eoqLandmarks.available, false);
  assert.equal(buildCapabilities({ rateLamp: { reliable: false } }).eoqLandmarks.available, false);
  assert.equal('breakEvenTurns' in on, false);
});
