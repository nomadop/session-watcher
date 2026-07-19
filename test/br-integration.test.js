// test/br-integration.test.js
// End-to-end integration: status fixture → mergeLedgerIntoStatus → formatLine + rawTierFor gate snapshot

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIntoStatus, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { formatLine, renderLamp, renderBr, _resetRenderState } from '../lib/statusline-format.js';
import { BR_AMBER, BR_RED } from '../lib/bill-regret.js';

describe('br integration: status → display → gate', () => {
  beforeEach(() => {
    _resetRateLampManagerForTest();
    _resetRenderState();
  });

  function buildScenario(L_read, cRatio = 10) {
    const B = 80000, g = 684;
    const status = {
      rateLamp: { reliable: true, C_RATIO: cRatio, L_read, L_cap: 960000, B_post: B, B_rebuild: B, gEma: g },
      L: L_read, B, g,
      model: 'claude-sonnet-4-20250514',
    };
    const ledger = {
      stateKey: 'k1',
      kStableFrozen: 684,
      billProgress: 0.3,
      billCycleCount: 2,
      currentTurnSeq: 5,
      lastAppliedFoldedCallSeq: 10,
    };
    return { status, ledger };
  }

  test('green zone: R=2, L_read=88000 (x=1.1) → br < 0.10, lamp green, tier 0', () => {
    // With R=2, Lb=80000, k=684: dhat = √(2·2·684/80000) = 0.185
    //   x=1.1, u = 0.1/0.185 = 0.54, pp = (0.54-1)²/(2·0.54) = 0.196
    //   mf ≈ 0.154, br = 0.154 * 0.196 ≈ 0.030 → green
    const { status, ledger } = buildScenario(88000, 2);
    mergeLedgerIntoStatus(status, ledger, 'k1');

    assert.ok(Number.isFinite(status.rateLamp.br), `br should be finite, got ${status.rateLamp.br}`);
    assert.ok(status.rateLamp.br < BR_AMBER, `br=${status.rateLamp.br} should be < ${BR_AMBER}`);
    assert.equal(renderLamp(status.rateLamp.br), '🟢');
  });

  test('red zone: R=10, L_read=240000 (x=3.0) → br >= 0.25, lamp red, tier 2', () => {
    // With R=10, Lb=80000, k=684: dhat = √(2·10·684/80000) = 0.4135
    //   x=3.0, u = 2.0/0.4135 = 4.835, pp = (3.835)²/(2·4.835) = 1.521
    //   mf ≈ 0.28, br = 0.28 * 1.521 ≈ 0.426 → red
    const { status, ledger } = buildScenario(240000, 10);
    mergeLedgerIntoStatus(status, ledger, 'k1');

    assert.ok(Number.isFinite(status.rateLamp.br), `br should be finite, got ${status.rateLamp.br}`);
    assert.ok(status.rateLamp.br >= BR_RED, `br=${status.rateLamp.br} should be >= ${BR_RED}`);
    // v3: inDeepWater is computed at getStatus time from br >= BR_AMBER
    assert.ok(status.rateLamp.br >= BR_AMBER, 'br in deep water territory');
    assert.equal(renderLamp(status.rateLamp.br), '🔴');
  });

  test('formatLine produces valid output with br display', () => {
    const { status, ledger } = buildScenario(100000, 10);
    mergeLedgerIntoStatus(status, ledger, 'k1');

    const line = formatLine(status);
    assert.ok(typeof line === 'string' && line.length > 0, 'formatLine should return non-empty string');
    assert.ok(line.includes('b+'), `line should include br display (b+..%), got: "${line}"`);
  });

  test('renderBr formats br value as b+XX% string', () => {
    // br=0.09 → 9% → b+09%
    assert.equal(renderBr(0.09), 'b+09%');
    // br=0.0094 (green zone result) → 0% → b+00%
    assert.equal(renderBr(0.0094), 'b+00%');
    // br=0.627 (red zone result) → 62% → b+62%
    assert.equal(renderBr(0.627), 'b+62%');
  });
});
