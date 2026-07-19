import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIntoStatus } from '../lib/rate-lamp-manager.js';

describe('mergeLedgerIntoStatus — br from live B/g (v3)', () => {
  test('br from live B/g, billing merged', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500, x_display: 2 }, B: 20000, g: 500 };
    const ledger = { stateKey: 'k', billProgress: 0.4, billCycleCount: 2, currentTurnSeq: 7 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.billProgress, 0.4);
    assert.equal(status.rateLamp.billCycleCount, 2);
    assert.ok(Number.isFinite(status.rateLamp.br));
    assert.ok(Number.isFinite(status.rateLamp.dhat));
    assert.ok(Number.isFinite(status.rateLamp.xSweet));
  });

  test('mf computed from live B and gEma (not kStableFrozen)', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500, x_display: 2 } };
    const ledger = { stateKey: 'k', billProgress: 0.3, billCycleCount: 1, currentTurnSeq: 3 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.ok(Number.isFinite(status.rateLamp.mf), 'mf should be finite');
    assert.ok(status.rateLamp.mf > 0, 'mf should be positive');
  });

  test('xBrAmberR/xBrAmberL/xBrRedR landmarks derived from live dhat+mf', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500, x_display: 2 } };
    const ledger = { stateKey: 'k', billProgress: 0.5, billCycleCount: 3, currentTurnSeq: 9 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.ok(Number.isFinite(status.rateLamp.xBrAmberR));
    assert.ok(Number.isFinite(status.rateLamp.xBrAmberL));
    assert.ok(Number.isFinite(status.rateLamp.xBrRedR));
    assert.ok(status.rateLamp.xBrAmberR > status.rateLamp.xSweet, 'amber right > sweet');
  });

  test('wallP = 1 + cRatio', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500 } };
    const ledger = { stateKey: 'k', billProgress: 0.1, billCycleCount: 0, currentTurnSeq: 1 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.wallP, 13.5);
  });

  test('lBase = B (not baseline.total)', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500 } };
    const ledger = { stateKey: 'k', billProgress: 0.1, billCycleCount: 0, currentTurnSeq: 1 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.lBase, 20000);
  });

  test('unreliable status → dhat set to null, early return', () => {
    const status = { rateLamp: { reliable: false } };
    const ledger = { stateKey: 'k', billProgress: 0.4, billCycleCount: 2, currentTurnSeq: 7 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.dhat, null);
    assert.equal(status.rateLamp.billProgress, undefined);
  });

  test('stateKey mismatch → not merged', () => {
    const status = { rateLamp: { reliable: true, B_post: 20000, gEma: 500, C_RATIO: 12.5 } };
    const ledger = { stateKey: 'other-key', billProgress: 0.9, billCycleCount: 5, currentTurnSeq: 10 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.billProgress, undefined);
  });

  test('lastBillEvent and lastStopEvent passthrough', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500 } };
    const ledger = { stateKey: 'k', billProgress: 0.1, billCycleCount: 0, currentTurnSeq: 1,
      lastAppliedFoldedCallSeq: 5,
      lastBillEvent: { kind: 'non_idle_burn', turnSeq: 1 },
      lastStopEvent: { kind: 'wall', delivery: 'stop_hook', seq: 3 } };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.deepEqual(status.rateLamp.lastBillEvent, { kind: 'non_idle_burn', turnSeq: 1 });
    assert.deepEqual(status.rateLamp.lastStopEvent, { kind: 'wall', delivery: 'stop_hook', seq: 3 });
  });

  test('no _perCallEma usage — gEma comes from status.rateLamp (watcher-owned)', () => {
    // The old merge used _perCallEma to compute gEma; now status.rateLamp.gEma is pre-set by getStatus.
    // Verify it is NOT overwritten by merge.
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500 } };
    const ledger = { stateKey: 'k', billProgress: 0.1, billCycleCount: 0, currentTurnSeq: 1 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.gEma, 500, 'gEma not overwritten by merge');
  });
});
