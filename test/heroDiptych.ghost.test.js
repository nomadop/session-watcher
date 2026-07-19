// test/heroDiptych.ghost.test.js — pure math tests for computePreviewLandmarks (Task 10)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePreviewLandmarks } from '../public/elements/heroDiptych.js';

test('computePreviewLandmarks: dhat/xSweet/x from B_preview', () => {
  const r = computePreviewLandmarks({ B_preview: 50000, R: 12.5, g: 940, L: 90000 });
  const dhat = Math.sqrt(2 * 12.5 * 940 / 50000);
  assert.ok(Math.abs(r.dhat - dhat) < 1e-6);
  assert.ok(Math.abs(r.xSweet - (1 + dhat)) < 1e-6);
  assert.ok(Math.abs(r.x - 90000 / 50000) < 1e-6);
});

test('computePreviewLandmarks: guards B_preview <= 0 using MIN_B_PREVIEW floor', () => {
  const r = computePreviewLandmarks({ B_preview: 0, R: 12.5, g: 940, L: 90000 });
  assert.ok(Number.isFinite(r.dhat) && r.dhat >= 0, 'no NaN/Infinity');
  // With B_preview=0, floor is MIN_B_PREVIEW=1000 → x = 90000/1000 = 90
  assert.ok(Math.abs(r.x - 90000 / 1000) < 1e-6, 'x computed from MIN_B_PREVIEW floor');
});

test('computePreviewLandmarks: recomputes mf from B_preview, ignores mfOverride', () => {
  const r = computePreviewLandmarks({ B_preview: 50000, R: 4, g: 2000, L: 90000, mf: 0.99 });
  // Expected: arm = √(2*4*50000*2000) = √(800000000) ≈ 28284.27
  // mf = arm / (arm + B + R*g) = 28284.27 / (28284.27 + 50000 + 8000) ≈ 0.3279
  const arm = Math.sqrt(2 * 4 * 50000 * 2000);
  const expectedMf = arm / (arm + 50000 + 4 * 2000);
  assert.ok(Math.abs(r.mf - expectedMf) < 1e-6, `mf should be ${expectedMf.toFixed(4)}, got ${r.mf.toFixed(4)}`);
  assert.ok(Math.abs(r.mf - 0.99) > 0.5, 'mfOverride=0.99 must be ignored when inputs are valid');
});

test('computePreviewLandmarks: falls back to mfOverride when g=0', () => {
  const r = computePreviewLandmarks({ B_preview: 50000, R: 4, g: 0, L: 90000, mf: 0.42 });
  assert.ok(Math.abs(r.mf - 0.42) < 1e-6, 'should use mfOverride when g=0');
});

test('computePreviewLandmarks: returns xAmberL (left-arm entry) between 1 and xSweet', () => {
  const r = computePreviewLandmarks({ B_preview: 50000, R: 12.5, g: 940, L: 90000 });
  assert.ok(Number.isFinite(r.xAmberL), 'xAmberL should be finite');
  assert.ok(r.xAmberL > 1 && r.xAmberL < r.xSweet, `xAmberL=${r.xAmberL.toFixed(4)} should be between 1 and xSweet=${r.xSweet.toFixed(4)}`);
  // Verify it satisfies br=0.10: mf*(u-1)^2/(2u) = 0.10
  const u = (r.xAmberL - 1) / r.dhat;
  const br = r.mf * (u - 1) * (u - 1) / (2 * u);
  assert.ok(Math.abs(br - 0.10) < 1e-6, `br at xAmberL should be 0.10, got ${br.toFixed(6)}`);
});

test('computePreviewLandmarks: mf changes with B_preview', () => {
  const r1 = computePreviewLandmarks({ B_preview: 50000, R: 4, g: 2000, L: 90000 });
  const r2 = computePreviewLandmarks({ B_preview: 30000, R: 4, g: 2000, L: 90000 });
  assert.ok(r2.mf > r1.mf, `smaller B should yield larger mf: ${r2.mf.toFixed(4)} > ${r1.mf.toFixed(4)}`);
});
