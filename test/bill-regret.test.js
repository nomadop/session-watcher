// test/bill-regret.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BR_AMBER, BR_RED, computeMovableFrac, computeBr,
  computePp, uAtBr, uLeftAtBr, walletIntervalFor,
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

describe('computePp', () => {
  test('computePp: returns pp_frac (u-1)^2/(2u) matching computeBr/mf decomposition', () => {
    // u = (x-1)/dhat. Pick x, dhat so u=2 → pp = (1)^2/(2*2) = 0.25
    const x = 3, dhat = 1; // u = 2
    assert.equal(computePp(x, dhat), 0.25);
  });

  test('computePp: symmetric arm — u=0.5 gives (−0.5)^2/(2*0.5)=0.25', () => {
    const x = 1.5, dhat = 1; // u = 0.5
    assert.ok(Math.abs(computePp(x, dhat) - 0.25) < 1e-12);
  });

  test('computePp: null on non-finite or non-positive u', () => {
    assert.equal(computePp(1, 1), null);      // u=0
    assert.equal(computePp(0.5, 1), null);    // u=-0.5 ≤ 0
    assert.equal(computePp(NaN, 1), null);
    assert.equal(computePp(2, 0), null);      // dhat ≤ 0
    assert.equal(computePp(2, -1), null);
  });
});

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('wallet interval and its roots', () => {
  test('uAtBr numerical correctness at BR_AMBER', () => {
    near(uAtBr(0.20, BR_AMBER), 2.62);
    near(uAtBr(0.30, BR_AMBER), 2.22);
    near(uAtBr(0.40, BR_AMBER), 2.00);
  });
  test('walletIntervalFor = uAmber squared, never clamped, Infinity at mf=0', () => {
    near(walletIntervalFor(0.20, BR_AMBER), 6.85);
    near(walletIntervalFor(0.30, BR_AMBER), 4.91);
    near(walletIntervalFor(0.40, BR_AMBER), 4.00);
    // The AM-GM ceiling on mf is where the interval bottoms out, and it bottoms out on its own: a
    // max(4, ·) floor would break the higher-mf-shorter-interval direction rather than protect it.
    near(walletIntervalFor(0.414, BR_AMBER), 4.0, 0.1);
    assert.ok(walletIntervalFor(0.20, BR_AMBER) > walletIntervalFor(0.40, BR_AMBER));
    assert.equal(walletIntervalFor(0, BR_AMBER), Infinity);
  });
  test('uAtBr guards: mf<=0 or non-finite → Infinity; finite brTarget<=0 → 1; non-finite brTarget → Infinity', () => {
    assert.equal(uAtBr(0, BR_AMBER), Infinity);
    assert.equal(uAtBr(-1, BR_AMBER), Infinity);
    assert.equal(uAtBr(NaN, BR_AMBER), Infinity);
    assert.equal(uAtBr(0.3, 0), 1);
    assert.equal(uAtBr(0.3, -0.5), 1);          // negative finite target: clamp to the degenerate root
    assert.equal(uAtBr(0.3, NaN), Infinity);
  });
  test('uLeftAtBr is the reciprocal root, below the sweet spot', () => {
    for (const mf of [0.2, 0.3, 0.4]) near(uLeftAtBr(mf, BR_AMBER) * uAtBr(mf, BR_AMBER), 1, 1e-9);
    assert.ok(uLeftAtBr(0.3, BR_AMBER) < 1);
    assert.equal(uLeftAtBr(0, BR_AMBER), 0);
  });
});
