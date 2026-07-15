import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLamp, renderBr, formatLine } from '../lib/statusline-format.js';

describe('renderLamp (br-based)', () => {
  test('calibrating → ⚪', () => {
    assert.equal(renderLamp(0.05, { calibrating: true }), '⚪');
  });
  test('NaN → ⚪', () => {
    assert.equal(renderLamp(NaN), '⚪');
  });
  test('br < 0.10 → 🟢', () => {
    assert.equal(renderLamp(0.09), '🟢');
  });
  test('br = 0.10 → 🟡', () => {
    assert.equal(renderLamp(0.10), '🟡');
  });
  test('br = 0.24 → 🟡', () => {
    assert.equal(renderLamp(0.24), '🟡');
  });
  test('br = 0.25 → 🔴', () => {
    assert.equal(renderLamp(0.25), '🔴');
  });
  test('br = 0.50 → 🔴', () => {
    assert.equal(renderLamp(0.50), '🔴');
  });
  test('left arm before entry (x < xBrAmberL) → ⚪', () => {
    assert.equal(renderLamp(0.30, { x: 1.2, xSweet: 1.6, xBrAmberL: 1.3 }), '⚪');
  });
  test('left arm past entry (xBrAmberL ≤ x < xSweet) → 🟢', () => {
    assert.equal(renderLamp(0.15, { x: 1.4, xSweet: 1.6, xBrAmberL: 1.3 }), '🟢');
  });
  test('left arm without xBrAmberL → ⚪ (fallback)', () => {
    assert.equal(renderLamp(0.30, { x: 1.2, xSweet: 1.6 }), '⚪');
  });
  test('right arm (x >= xSweet) → normal br thresholds', () => {
    assert.equal(renderLamp(0.30, { x: 2.0, xSweet: 1.6 }), '🔴');
    assert.equal(renderLamp(0.05, { x: 2.0, xSweet: 1.6 }), '🟢');
  });
});

describe('renderBr', () => {
  test('NaN → b---%', () => {
    assert.equal(renderBr(NaN), 'b---%');
  });
  test('negative → b---%', () => {
    assert.equal(renderBr(-0.01), 'b---%');
  });
  test('0.00 → b+00%', () => {
    assert.equal(renderBr(0.00), 'b+00%');
  });
  test('0.086 floors to b+08%', () => {
    assert.equal(renderBr(0.086), 'b+08%');
  });
  test('0.096 floors to b+09% (not 10 — floor prevents threshold mismatch)', () => {
    assert.equal(renderBr(0.096), 'b+09%');
  });
  test('0.10 → b+10%', () => {
    assert.equal(renderBr(0.10), 'b+10%');
  });
  test('1.5 → b+99% (cap)', () => {
    assert.equal(renderBr(1.5), 'b+99%');
  });
});

describe('formatLine with br', () => {
  test('reliable session includes lamp + br + u', () => {
    const s = {
      rateLamp: {
        reliable: true, br: 0.08, mf: 0.28, C_RATIO: 10,
        billProgress: 0.3, billCycleCount: 2, currentTurnSeq: 5,
        x_display: 1.3, dhat: 0.4167, L_read: 104000,
        L_cap: 960000, inDeepWater: false, gEma: 700,
      },
      baseline: { total: 80000 },
      kAvg: 684,
      L: 104000,
      model: 'claude-sonnet-4-20250514',
    };
    const line = formatLine(s);
    assert.ok(line.includes('🟢'), 'should have green lamp');
    assert.ok(line.includes('b+08%'), 'should have br display');
    assert.ok(line.includes('u'), 'should have u value');
    assert.ok(!line.includes('~'), 'should not have countdown');
  });
});
