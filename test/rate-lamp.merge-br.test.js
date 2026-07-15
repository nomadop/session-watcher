import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIntoStatus } from '../lib/rate-lamp-manager.js';

describe('mergeLedgerIntoStatus — br migration', () => {
  const baseStatus = () => ({
    rateLamp: { reliable: true, C_RATIO: 10, L_read: 120000, L_cap: 960000 },
    baseline: { total: 80000 },
    kAvg: 684,
    L: 120000,
    model: 'claude-sonnet',
  });
  const baseLedger = () => ({
    stateKey: 'k1',
    kStableFrozen: 684,
    billProgress: 0.3,
    billCycleCount: 2,
    currentTurnSeq: 5,
    lastAppliedFoldedCallSeq: 10,
    currentTurnDeltaW: 100,
  });

  test('mf is computed and cached once kStableFrozen > 0', () => {
    const st = baseStatus();
    const ld = baseLedger();
    mergeLedgerIntoStatus(st, ld, 'k1');
    assert.ok(Number.isFinite(st.rateLamp.mf), 'mf should be finite');
    assert.ok(st.rateLamp.mf > 0.27 && st.rateLamp.mf < 0.29, `mf=${st.rateLamp.mf}`);
  });

  test('br is computed from x and mf', () => {
    const st = baseStatus();
    const ld = baseLedger();
    mergeLedgerIntoStatus(st, ld, 'k1');
    assert.ok(Number.isFinite(st.rateLamp.br), 'br should be finite');
    assert.ok(st.rateLamp.br >= 0, 'br should be non-negative');
  });

  test('inDeepWater is br-based (br >= 0.10)', () => {
    const st = baseStatus();
    st.rateLamp.L_read = 200000; // far past sweet → high br
    const ld = baseLedger();
    mergeLedgerIntoStatus(st, ld, 'k1');
    // At x=2.5 with mf≈0.28, br should be well above 0.10
    assert.equal(st.rateLamp.inDeepWater, st.rateLamp.br >= 0.10);
  });

  test('band field no longer present', () => {
    const st = baseStatus();
    const ld = baseLedger();
    mergeLedgerIntoStatus(st, ld, 'k1');
    assert.equal(st.rateLamp.band, undefined);
  });

  test('targetL field no longer present', () => {
    const st = baseStatus();
    const ld = baseLedger();
    mergeLedgerIntoStatus(st, ld, 'k1');
    assert.equal(st.rateLamp.targetL, undefined);
  });

  test('deepWaterDisplayLatched field no longer present', () => {
    const st = baseStatus();
    const ld = baseLedger();
    mergeLedgerIntoStatus(st, ld, 'k1');
    assert.equal(st.rateLamp.deepWaterDisplayLatched, undefined);
  });
});
