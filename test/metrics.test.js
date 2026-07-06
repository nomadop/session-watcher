// test/metrics.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { theilSen, nStar, lStar, rho, phi, paybackP, timingWeight, regret, etaCalls } from '../lib/metrics.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('theilSen returns exact slope for a clean line, resists a single outlier', () => {
  close(theilSen([0, 10, 20, 30, 40]), 10);
  // one spike must not dominate (median of pairwise slopes)
  const withSpike = [0, 10, 20, 9000, 40];
  assert.ok(theilSen(withSpike) < 100, 'median slope resists the spike');
  assert.equal(theilSen([5]), 0);
});

test('lStar matches spec formula; M=2 default', () => {
  // L* = Lbase + M·√(2·ratio·Lbase·kAvg)
  const expected = 55000 + 2 * Math.sqrt(2 * 50 * 55000 * 940);
  close(lStar(55000, 50, 940), expected, 1e-3);
  assert.equal(lStar(55000, 50, 0), 55000); // kAvg<=0 → floor
});

test('nStar and its relationship to timingWeight peak at rho=1', () => {
  close(nStar(50, 55000, 940), Math.sqrt(2 * 50 * 55000 / 940), 1e-6);
  // timingWeight upper bound √2−1 at rho=1
  close(timingWeight(1), Math.SQRT2 - 1, 1e-9);
  assert.ok(timingWeight(0.5) < timingWeight(1));
  assert.ok(timingWeight(5) < timingWeight(1));
});

test('phi = 1 + P/(1+rho) identity holds', () => {
  const L = 150000, lBase = 55000, cRatio = 50, kAvg = 940;
  const P = paybackP(L, lBase);
  const r = rho(cRatio, kAvg, lBase);
  close(phi(L, lBase, cRatio, kAvg), 1 + P / (1 + r), 1e-9);
  assert.equal(phi(55000, 55000, 50, 940), 1.0); // at baseline → 1x
});

test('paybackP is L/Lbase-1, clamped at 0', () => {
  close(paybackP(110000, 55000), 1.0);
  assert.equal(paybackP(50000, 55000), 0);
});

test('regret is (u+1/u)/2 - 1: 0 at optimum, +25% at u=2', () => {
  close(regret(76, 76), 0);
  close(regret(152, 76), 0.25);
  close(regret(38, 76), 0.25); // symmetric
});

test('etaCalls: null on non-positive slope, frozen 0 past the line, else rounds up', () => {
  assert.equal(etaCalls(180000, 137000, 0), null);
  assert.equal(etaCalls(180000, 137000, -5), null);
  assert.equal(etaCalls(180000, 200000, 1350), 0); // already past → frozen
  assert.equal(etaCalls(180000, 137000, 1000), 43); // ceil((180000-137000)/1000)
});
