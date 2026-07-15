import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BR_AMBER, BR_RED } from '../lib/bill-regret.js';
import { rawTierFor } from '../lib/notify-gate.js';

describe('br-coordinate shim feeding rawTierFor', () => {
  // Simulate the shim: feed br directly as x, with BR_AMBER as xStar
  const fc = { xStar: BR_AMBER, dhat: BR_RED - BR_AMBER };

  test('br=0.05 → tier 0', () => {
    assert.equal(rawTierFor(0.05, fc), 0);
  });
  test('br=0.10 → tier 1', () => {
    assert.equal(rawTierFor(0.10, fc), 1);
  });
  test('br=0.20 → tier 1', () => {
    assert.equal(rawTierFor(0.20, fc), 1);
  });
  test('br=0.25 → tier 2', () => {
    assert.equal(rawTierFor(0.25, fc), 2);
  });
  test('br=0.50 → tier 2', () => {
    assert.equal(rawTierFor(0.50, fc), 2);
  });
});
