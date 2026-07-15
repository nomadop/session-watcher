// test/bill-regret.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BR_AMBER, BR_RED, computeMovableFrac, computeBr, xRightFromBr, xLeftFromBr,
} from '../lib/bill-regret.js';

describe('bill-regret constants', () => {
  test('BR_AMBER = 0.10', () => assert.equal(BR_AMBER, 0.10));
  test('BR_RED = 0.25', () => assert.equal(BR_RED, 0.25));
});

describe('computeMovableFrac', () => {
  test('mid-mid profile (C=10, Lb=80000, k=684) → ~0.28', () => {
    const mf = computeMovableFrac(10, 80000, 684);
    assert.ok(mf > 0.27 && mf < 0.29, `expected ~0.28, got ${mf}`);
  });
  test('upper bound: equal pillars → 1/(1+√2) ≈ 0.4142', () => {
    // Lb = C*k → pillars equal → mf maximal
    const mf = computeMovableFrac(10, 5000, 500);
    assert.ok(mf > 0.413 && mf < 0.415, `expected ~0.4142, got ${mf}`);
  });
  test('invalid inputs → NaN', () => {
    assert.ok(Number.isNaN(computeMovableFrac(0, 80000, 684)));
    assert.ok(Number.isNaN(computeMovableFrac(10, 0, 684)));
    assert.ok(Number.isNaN(computeMovableFrac(10, 80000, 0)));
    assert.ok(Number.isNaN(computeMovableFrac(-1, 80000, 684)));
  });
});

describe('computeBr', () => {
  // dhat = √(2·R·k/Lb), mid-mid: √(2·10·684/80000) = √0.171 = 0.41352...
  const R = 10, Lb = 80000, k = 684;
  const dhat = Math.sqrt(2 * R * k / Lb);
  const mf = 0.28;

  test('at sweet spot (x = 1 + dhat, u=1) → br = 0', () => {
    const xSweet = 1 + dhat;
    const br = computeBr(xSweet, dhat, mf);
    assert.ok(Math.abs(br) < 1e-10, `expected ~0, got ${br}`);
  });

  test('symmetric: u=0.5 and u=2 give same br (left = right arm)', () => {
    const xLeft = 1 + 0.5 * dhat;   // u=0.5
    const xRight = 1 + 2 * dhat;    // u=2
    const brLeft = computeBr(xLeft, dhat, mf);
    const brRight = computeBr(xRight, dhat, mf);
    // pp at u=2: (2-1)²/(2·2) = 0.25; pp at u=0.5: (0.5-1)²/(2·0.5) = 0.25
    assert.ok(Math.abs(brLeft - brRight) < 1e-10, `left ${brLeft} ≠ right ${brRight}`);
    assert.ok(Math.abs(brLeft - mf * 0.25) < 1e-10, `expected ${mf * 0.25}, got ${brLeft}`);
  });

  test('theory table: mid-mid pp=25 → br ≈ mf×0.25 = 0.07', () => {
    // u=2 at pp=25%: x = 1 + 2·dhat
    const x = 1 + 2 * dhat;
    const br = computeBr(x, dhat, mf);
    assert.ok(Math.abs(br - 0.07) < 0.001, `expected ~0.07, got ${br}`);
  });

  test('theory table: mid-mid pp=100 → br ≈ mf×1.0 = 0.28', () => {
    // pp=1.0: (u-1)²/(2u) = 1 → u² - 4u + 1 = 0 → u = 2+√3 ≈ 3.732
    const u = 2 + Math.sqrt(3);
    const x = 1 + u * dhat;
    const br = computeBr(x, dhat, mf);
    assert.ok(Math.abs(br - 0.28) < 0.001, `expected ~0.28, got ${br}`);
  });

  test('monotone right arm: br increases with x for x > xSweet', () => {
    const x1 = 1 + 1.5 * dhat;
    const x2 = 1 + 3.0 * dhat;
    assert.ok(computeBr(x2, dhat, mf) > computeBr(x1, dhat, mf));
  });

  test('monotone left arm: br increases as x decreases below xSweet', () => {
    const x1 = 1 + 0.8 * dhat;  // u=0.8 closer to sweet
    const x2 = 1 + 0.3 * dhat;  // u=0.3 farther from sweet
    assert.ok(computeBr(x2, dhat, mf) > computeBr(x1, dhat, mf));
  });

  test('x=1 (d=0) → NaN (division by zero in u)', () => {
    assert.ok(Number.isNaN(computeBr(1, dhat, mf)));
  });

  test('invalid → NaN', () => {
    assert.ok(Number.isNaN(computeBr(0.5, dhat, mf)));   // x<1 → d<0
    assert.ok(Number.isNaN(computeBr(1.5, 0, mf)));      // dhat=0
    assert.ok(Number.isNaN(computeBr(1.5, dhat, -1)));   // mf<0
  });
});

describe('xRightFromBr / xLeftFromBr', () => {
  const R = 10, Lb = 80000, k = 684;
  const dhat = Math.sqrt(2 * R * k / Lb);
  const mf = 0.28;

  test('round-trip right arm: computeBr(xRightFromBr(target)) ≈ target', () => {
    const target = 0.10;
    const xR = xRightFromBr(target, dhat, mf);
    const br = computeBr(xR, dhat, mf);
    assert.ok(Math.abs(br - target) < 1e-9, `round-trip failed: got ${br}`);
  });

  test('round-trip left arm: computeBr(xLeftFromBr(target)) ≈ target', () => {
    const target = 0.10;
    const xL = xLeftFromBr(target, dhat, mf);
    const br = computeBr(xL, dhat, mf);
    assert.ok(Math.abs(br - target) < 1e-9, `left round-trip failed: got ${br}`);
  });

  test('xRight > xSweet > xLeft (symmetric around sweet)', () => {
    const xSweet = 1 + dhat;
    const xR = xRightFromBr(0.10, dhat, mf);
    const xL = xLeftFromBr(0.10, dhat, mf);
    assert.ok(xR > xSweet, `xRight ${xR} should exceed xSweet ${xSweet}`);
    assert.ok(xL < xSweet, `xLeft ${xL} should be below xSweet ${xSweet}`);
  });

  test('BR_AMBER right arm lands at u=2 for mf=0.25 (pp=25% exit)', () => {
    // pp = BR_AMBER/mf = 0.10/0.25 = 0.40. Solve (u-1)²/(2u) = 0.40
    // u² - 2.8u + 1 = 0 → u = (2.8 + √(7.84-4))/2 = (2.8 + 1.96)/2 = 2.38
    const xR = xRightFromBr(BR_AMBER, dhat, 0.25);
    const uR = (xR - 1) / dhat;
    const expectedU = (1.4 + Math.sqrt(1.4*1.4 - 1));
    assert.ok(Math.abs(uR - expectedU) < 1e-9);
  });

  test('invalid → NaN', () => {
    assert.ok(Number.isNaN(xRightFromBr(0.10, 0, 0.28)));
    assert.ok(Number.isNaN(xRightFromBr(0.10, dhat, 0)));
    assert.ok(Number.isNaN(xLeftFromBr(-0.01, dhat, 0.28)));
  });
});
