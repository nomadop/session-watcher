import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRateLampInstant, computeFullCarryBurnRate } from '../lib/rate-lamp.js';

test('computeRateLampInstant: B/g inputs → x=L/B, burnRate=(L-B)/(R·B)', () => {
  const s = computeRateLampInstant({ L_read: 40000, B: 20000, g: 500, cRatio: 12.5, lCap: 960000 });
  assert.ok(s.reliable);
  assert.ok(Math.abs(s.x_display - 2) < 1e-9);
  assert.ok(Math.abs(s.burnRate - (40000 - 20000) / (12.5 * 20000)) < 1e-9);
  assert.ok(Number.isFinite(s.br));
});

test('computeRateLampInstant: invalid B → unreliable', () => {
  assert.equal(computeRateLampInstant({ L_read: 100, B: 0, g: 500, cRatio: 12.5, lCap: 1 }).reliable, false);
});

test('computeFullCarryBurnRate unchanged: (L-B)/(R·B)', () => {
  assert.ok(Math.abs(computeFullCarryBurnRate({ L_read: 30000, B_post: 10000, B_rebuild: 10000, cRatio: 10 }) - 0.2) < 1e-9);
});
