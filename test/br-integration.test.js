// test/br-integration.test.js
// End-to-end integration: status fixture → mergeLedgerIntoStatus → the statusline's br and line.
// `br` arrives ON the status: the Engine is its sole producer, so the fixture states it rather than asking
// the merge to derive it.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIntoStatus, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { formatLine, renderBr, _resetRenderState } from '../lib/statusline-format.js';

describe('br integration: status → merge → display', () => {
  beforeEach(() => {
    _resetRateLampManagerForTest();
    _resetRenderState();
  });

  function buildScenario(L_read, cRatio, br) {
    const B = 80000, g = 684;
    const status = {
      rateLamp: { reliable: true, C_RATIO: cRatio, L_read, L_cap: 960000, B_post: B, B_rebuild: B, gEma: g, br },
      L: L_read, B, g,
      model: 'claude-sonnet-4-20250514',
    };
    const ledger = {
      stateKey: 'k1',
      billProgress: 0.3,
      billCycleCount: 2,
      currentTurnSeq: 5,
      lastAppliedFoldedCallSeq: 10,
    };
    return { status, ledger };
  }

  test('formatLine produces valid output with br display', () => {
    const { status, ledger } = buildScenario(100000, 10, 0.12);
    mergeLedgerIntoStatus(status, ledger, 'k1');

    const line = formatLine(status);
    assert.ok(typeof line === 'string' && line.length > 0, 'formatLine should return non-empty string');
    assert.ok(line.includes('b+'), `line should include br display (b+..%), got: "${line}"`);
  });

  test('renderBr formats br value as b+XX% string', () => {
    // br=0.09 → 9% → b+09%
    assert.equal(renderBr(0.09), 'b+09%');
    // br=0.0094 → 0% → b+00%
    assert.equal(renderBr(0.0094), 'b+00%');
    // br=0.627 → 62% → b+62%
    assert.equal(renderBr(0.627), 'b+62%');
  });
});
