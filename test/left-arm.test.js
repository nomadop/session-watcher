import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInDeepWater, brForGate, computeBr, BR_AMBER } from '../lib/bill-regret.js';

test('isInDeepWater false on left arm despite mathematical br > BR_AMBER', () => {
  // Cold start: x just above 1, xSweet well above x → left arm.
  const dhat = 0.22, mf = 0.3;
  const x = 1.05, xSweet = 1 + dhat; // 1.22 → x < xSweet
  const br = computeBr(x, dhat, mf);
  assert.ok(br >= BR_AMBER, 'precondition: mathematical br is above amber on the left arm');
  assert.equal(isInDeepWater(x, xSweet, br), false);
});

test('isInDeepWater true on right arm when br >= BR_AMBER', () => {
  const xSweet = 1.22;
  assert.equal(isInDeepWater(2.6, xSweet, 0.12), true);
});

test('isInDeepWater false on right arm when br < BR_AMBER', () => {
  assert.equal(isInDeepWater(1.3, 1.22, 0.05), false);
});

test('isInDeepWater false on non-finite inputs', () => {
  assert.equal(isInDeepWater(NaN, 1.2, 0.5), false);
  assert.equal(isInDeepWater(1.5, 1.2, NaN), false);
  assert.equal(isInDeepWater(1.5, NaN, 0.5), false);
});

test('brForGate returns null on left arm (whitened for gate)', () => {
  assert.equal(brForGate(1.05, 1.22, 5.0), null);
});

test('brForGate returns br on right arm', () => {
  assert.equal(brForGate(2.6, 1.22, 0.12), 0.12);
});

test('brForGate returns null (not NaN) on non-finite x/xSweet', () => {
  assert.equal(brForGate(NaN, 1.2, 0.5), null);
  assert.equal(brForGate(1.5, NaN, 0.5), null);
});

test('brForGate returns null when br itself is non-finite on right arm', () => {
  assert.equal(brForGate(2.6, 1.22, NaN), null);
});
