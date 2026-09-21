import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFullCarryBurnRate } from '../lib/rate-lamp.js';

test('computeFullCarryBurnRate: (L-B)/(R·B)', () => {
  assert.ok(Math.abs(computeFullCarryBurnRate({ L_read: 30000, B_post: 10000, B_rebuild: 10000, cRatio: 10 }) - 0.2) < 1e-9);
});
