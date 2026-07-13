import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLedgerState, validateRateLampSample } from '../lib/ledger-schema.js';

test('validateLedgerState accepts a well-formed state', () => {
  const s = { schemaVersion: 1, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940 };
  assert.deepEqual(validateLedgerState(s), s);
});

test('validateLedgerState rejects corrupt/half-valid → null (silent fresh, no crash)', () => {
  assert.equal(validateLedgerState(null), null);
  assert.equal(validateLedgerState({}), null);
  assert.equal(validateLedgerState({ schemaVersion: 1, stateKey: 'k' }), null, 'missing billProgress');
  assert.equal(validateLedgerState({ schemaVersion: 1, stateKey: 'k', billingBasis: 'fullCarry',
    billProgress: 'x', lastAppliedFoldedCallSeq: 1 }), null, 'wrong-typed billProgress');
});

test('validateRateLampSample enforces L_read field (not cacheRead)', () => {
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: 0.2, L_read: 1000, turnSeq: 1 }), true);
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: 0.2, cacheRead: 1000, turnSeq: 1 }), false,
    'a cacheRead-named sample is rejected — the field MUST be L_read');
  assert.equal(validateRateLampSample({ seq: 1, reliable: false, turnSeq: 1 }), true, 'unreliable sample needs only seq/turnSeq');
  assert.equal(validateRateLampSample({ seq: 1, reliable: false }), false, 'round-2: unreliable sample still REQUIRES turnSeq');
});

test('round-2 GPT#11: validateLedgerState enforces RANGES, not just finiteness', () => {
  const good = { schemaVersion: 1, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940 };
  assert.equal(validateLedgerState({ ...good, billProgress: 1.0 }), null, 'billProgress must be < 1');
  assert.equal(validateLedgerState({ ...good, billProgress: -0.1 }), null, 'billProgress must be ≥ 0');
  assert.equal(validateLedgerState({ ...good, lastAppliedFoldedCallSeq: -3 }), null, 'seq must be a non-negative int');
  assert.equal(validateLedgerState({ ...good, billCycleCount: 1.2 }), null, 'count must be an integer');
  assert.equal(validateLedgerState({ ...good, pausedReason: 'made_up' }), null, 'pausedReason must be in the enum');
  // NOTE: kStableFrozen === 0 on an active ledger is NOT rejected (final-review reconciliation) — it
  // degrades gracefully (reducer never reads it; manager guards >0 before xExit). Assert it PASSES:
  assert.ok(validateLedgerState({ ...good, kStableFrozen: 0, lastAppliedFoldedCallSeq: 5 }), 'kStableFrozen 0 is a benign degradation, not corruption');
});

test('round-8 GPT#3: negative continuous fields are rejected (physically non-negative)', () => {
  const good = { schemaVersion: 1, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
    lastAppliedLRead: 100000 };
  assert.equal(validateLedgerState({ ...good, kStableFrozen: -1 }), null, 'negative kStableFrozen (0 is fine, <0 is corruption)');
  assert.equal(validateLedgerState({ ...good, currentTurnDeltaW: -0.1 }), null, 'ΔW is a non-negative accumulation');
  assert.equal(validateLedgerState({ ...good, billAnchorLRead: -1 }), null, 'anchor L is a token count ≥ 0');
  assert.equal(validateLedgerState({ ...good, lastBurnRate: -0.1 }), null, 'burnRate is max(0,·) at source');
  assert.equal(validateLedgerState({ ...good, lastAppliedLRead: -1 }), null, 'applied L is a token count ≥ 0');
});

test('round-8 GPT#3: validateRateLampSample rejects a negative L_read / burnRate', () => {
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: 0.2, L_read: -1, turnSeq: 1 }), false, 'negative L_read');
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: -0.2, L_read: 1000, turnSeq: 1 }), false, 'negative burnRate');
});
