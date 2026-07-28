import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holtStep, emaStep, gEffective } from '../lib/measure.js';
import { ALPHA_EMA, BETA_TREND, G_FLOOR } from '../lib/constants.js';

test('holtStep: returns { level, trend } object', () => {
  const result = holtStep(1000, 0, 2000);
  assert.ok('level' in result);
  assert.ok('trend' in result);
});

test('holtStep: converges to constant residual (trend → 0)', () => {
  let level = 100, trend = 0;
  for (let i = 0; i < 100; i++) {
    ({ level, trend } = holtStep(level, trend, 500));
  }
  assert.ok(Math.abs(level - 500) < 5, `level=${level} should be ~500`);
  assert.ok(Math.abs(trend) < 2, `trend=${trend} should be ~0`);
});

test('holtStep: tracks regime change faster than raw EMA', () => {
  // Residual steps from 500 to 2000 (sustained regime shift)
  let level = 500, trend = 0;
  let gRaw = 500;

  // 10 consecutive steps at the new regime (2000)
  for (let i = 0; i < 10; i++) {
    ({ level, trend } = holtStep(level, trend, 2000));
    gRaw = emaStep(gRaw, 2000);
  }

  // Holt should be closer to 2000 than raw EMA due to trend assist
  const holtError = Math.abs(level - 2000);
  const rawError = Math.abs(gRaw - 2000);
  assert.ok(holtError < rawError,
    `Holt error (${holtError.toFixed(0)}) should be less than raw EMA error (${rawError.toFixed(0)})`);
});

test('holtStep: trend is positive during sustained upward residuals', () => {
  let level = 500, trend = 0;
  for (let i = 0; i < 20; i++) {
    ({ level, trend } = holtStep(level, trend, 500 + i * 75));
  }
  assert.ok(level > 1000, `level=${level} should track upward`);
  assert.ok(trend > 0, `trend=${trend} should be positive during uptrend`);
});

test('holtStep: trend decays toward zero under constant input', () => {
  // Start with artificial positive trend
  let level = 1000, trend = 200;
  for (let i = 0; i < 100; i++) {
    ({ level, trend } = holtStep(level, trend, 1000));
  }
  // With β=0.05, trend decays slowly; after 100 iterations it is ~0.2 (well under 5)
  assert.ok(Math.abs(trend) < 5, `trend=${trend} should decay to ~0`);
});

test('ALPHA_EMA is 0.20 (Holt-validated param)', () => {
  assert.equal(ALPHA_EMA, 0.20);
});

test('BETA_TREND is 0.05', () => {
  assert.equal(BETA_TREND, 0.05);
});

test('gEffective unchanged: still floors at G_FLOOR', () => {
  assert.equal(gEffective(50), G_FLOOR);
  assert.equal(gEffective(500), 500);
  assert.equal(gEffective(null), G_FLOOR);
});
