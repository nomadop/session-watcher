import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIntoStatus } from '../lib/rate-lamp-manager.js';

describe('mergeLedgerIntoStatus — the ledger onto the wire', () => {
  test('billing merged', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500, x_display: 2 }, B: 20000, g: 500 };
    const ledger = { stateKey: 'k', billProgress: 0.4, billCycleCount: 2, currentTurnSeq: 7 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.billProgress, 0.4);
    assert.equal(status.rateLamp.billCycleCount, 2);
  });

  test('wallP = 1 + cRatio', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500 } };
    const ledger = { stateKey: 'k', billProgress: 0.1, billCycleCount: 0, currentTurnSeq: 1 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.wallP, 13.5);
  });

  test('unreliable status → dhat set to null, early return', () => {
    const status = { rateLamp: { reliable: false } };
    const ledger = { stateKey: 'k', billProgress: 0.4, billCycleCount: 2, currentTurnSeq: 7 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.dhat, null);
    assert.equal(status.rateLamp.billProgress, undefined);
  });

  // A reliable frame reaches the merge with no ledger at all: `getLiveLedger` answers null for a
  // session that has none, and a ReplayController carries a null ledger from construction until its
  // first timer-driven drain, by which time the active watcher has already been swapped.
  test('a null ledger → the default rentMeter and a null dhat, with nothing merged', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500, x_display: 2 }, B: 20000, g: 500 };
    const merged = mergeLedgerIntoStatus(status, null, 'k');
    assert.equal(merged, status);
    assert.deepEqual(status.rateLamp.rentMeter, { cycleProgress: 0, depthActive: false,
      depthProgress: 0, backstopInterval: null, backstopLapCount: 0, depthHot: false });
    assert.equal(status.rateLamp.dhat, null);
    assert.equal(status.rateLamp.billProgress, undefined);
  });

  test('stateKey mismatch → not merged', () => {
    const status = { rateLamp: { reliable: true, B_post: 20000, gEma: 500, C_RATIO: 12.5 } };
    const ledger = { stateKey: 'other-key', billProgress: 0.9, billCycleCount: 5, currentTurnSeq: 10 };
    mergeLedgerIntoStatus(status, ledger, 'k');
    assert.equal(status.rateLamp.billProgress, undefined);
  });

  test('lastStopEvent passthrough', () => {
    const status = { rateLamp: { reliable: true, L_read: 40000, B_post: 20000, B_rebuild: 20000,
      C_RATIO: 12.5, gEma: 500 } };
    const ledger = { stateKey: 'k', billProgress: 0.1, billCycleCount: 0, currentTurnSeq: 1,
      lastAppliedFoldedCallSeq: 5,
      lastStopEvent: { kind: 'wall', delivery: 'stop_hook', seq: 3 } };
    mergeLedgerIntoStatus(status, ledger, 'k');
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
