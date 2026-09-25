import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLedgerState, validateRateLampSample } from '../lib/ledger-schema.js';

const validV3 = { schemaVersion: 3, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4, billCycleCount: 3,
  walletPhase: 0.7, walletLapCount: 2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, pausedReason: null,
  cacheExpiryCount: 0, lastStopEvent: null, ledgerRevision: 0, recentStopEvents: [], recentProcessedHookEventIds: [] };

test('validateLedgerState accepts a well-formed state', () => {
  const s = { ...validV3 };
  assert.deepEqual(validateLedgerState(s), s);
});

test('validateLedgerState rejects corrupt/half-valid → null (silent fresh, no crash)', () => {
  assert.equal(validateLedgerState(null), null);
  assert.equal(validateLedgerState({}), null);
  // Base the corrupt-billProgress fixtures on an OTHERWISE-valid ledger so they REACH the numeric field
  // checks: under the hard version gate a foreign-version fixture short-circuits at the gate → null for the
  // WRONG reason, masking the billProgress-rejection path these assertions name.
  assert.ok(validateLedgerState({ ...validV3 }), 'sanity: the base fixture is VALID (so null below is billProgress-only)');
  const missingBillProgress = { ...validV3 }; delete missingBillProgress.billProgress;
  assert.equal(validateLedgerState(missingBillProgress), null, 'missing billProgress (reaches the field check, not the version gate)');
  assert.equal(validateLedgerState({ ...validV3, billProgress: 'x' }), null, 'wrong-typed billProgress');
});

test('a schema-v2 ledger is foreign and degrades to fresh', () => {
  assert.equal(validateLedgerState({ ...validV3, schemaVersion: 2 }), null);
});

test('a stale v1 and a future v4 disk ledger are both foreign — only the current version is accepted', () => {
  assert.equal(validateLedgerState({ ...validV3, schemaVersion: 1 }), null, 'v1 schemaVersion → null');
  assert.equal(validateLedgerState({ ...validV3, schemaVersion: 4 }), null, 'a future v4 is foreign too');
});

test('walletPhase is guarded to [0, 1) and walletLapCount to a non-negative integer', () => {
  assert.equal(validateLedgerState({ ...validV3, walletPhase: 1 }), null);
  assert.equal(validateLedgerState({ ...validV3, walletPhase: -0.1 }), null);
  assert.equal(validateLedgerState({ ...validV3, walletLapCount: 1.5 }), null);
  assert.equal(validateLedgerState({ ...validV3, walletLapCount: -1 }), null);
});

test('round-2 GPT#11: validateLedgerState enforces RANGES, not just finiteness', () => {
  assert.equal(validateLedgerState({ ...validV3, billProgress: 1.0 }), null, 'billProgress must be < 1');
  assert.equal(validateLedgerState({ ...validV3, billProgress: -0.1 }), null, 'billProgress must be ≥ 0');
  assert.equal(validateLedgerState({ ...validV3, lastAppliedFoldedCallSeq: -3 }), null, 'seq must be a non-negative int');
  assert.equal(validateLedgerState({ ...validV3, billCycleCount: 1.2 }), null, 'count must be an integer');
  assert.equal(validateLedgerState({ ...validV3, pausedReason: 'made_up' }), null, 'pausedReason must be in the enum');
});

test('C1-1: ledgerRevision enforces non-negative integer', () => {
  assert.equal(validateLedgerState({ ...validV3, ledgerRevision: -2 }), null, 'revision ≥ 0');
  assert.equal(validateLedgerState({ ...validV3, ledgerRevision: 1.5 }), null, 'revision is an int');
});

test('C1-1: a ledger MISSING a back-fillable field normalizes rather than wiping (version-local tolerate)', () => {
  const partial = { ...validV3 };
  delete partial.recentStopEvents; delete partial.recentProcessedHookEventIds;
  delete partial.ledgerRevision;
  const r = validateLedgerState(partial);
  assert.ok(r, 'a partial-write ledger normalizes rather than wiping');
  assert.deepEqual(r.recentStopEvents, []);
  assert.deepEqual(r.recentProcessedHookEventIds, []);
  assert.equal(r.ledgerRevision, 0);
});

test('C1-1: recentStopEvents / recentProcessedHookEventIds — element ranges', () => {
  assert.ok(validateLedgerState({ ...validV3, recentStopEvents: [{ kind: 'backstop', seq: 3 }] }), 'a legal stop event passes');
  assert.equal(validateLedgerState({ ...validV3, recentStopEvents: [{ kind: 5, seq: 3 }] }), null, 'kind is a string');
  assert.ok(validateLedgerState({ ...validV3, recentProcessedHookEventIds: ['a', 'b'] }), 'string ids pass');
  assert.equal(validateLedgerState({ ...validV3, recentProcessedHookEventIds: ['a', 3] }), null, 'each id is a string');
});

test('C1-1: length caps — over-LIMIT array rejects the whole ledger (ring-eviction is the ADD-site guard)', () => {
  const bigIds = Array.from({ length: 129 }, (_, i) => `id-${i}`);           // RECENT_PROCESSED_HOOK_IDS_LIMIT = 128
  assert.equal(validateLedgerState({ ...validV3, recentProcessedHookEventIds: bigIds }), null, '> 128 ids → reject');
  assert.ok(validateLedgerState({ ...validV3, recentProcessedHookEventIds: bigIds.slice(0, 128) }), 'exactly 128 passes');
  const bigEvents = Array.from({ length: 33 }, () => ({ kind: 'backstop', turnSeq: 1 })); // RECENT_STOP_EVENTS_LIMIT = 32
  assert.equal(validateLedgerState({ ...validV3, recentStopEvents: bigEvents }), null, '> 32 stop events → reject');
});

test('a reliable sample carries deltaW and mf as finite-or-null; one missing deltaW is rejected', () => {
  const base = { seq: 3, reliable: true, turnSeq: 1, L_read: 1000 };
  assert.equal(validateRateLampSample({ ...base, deltaW: 0.2, mf: 0.3 }), true);
  assert.equal(validateRateLampSample({ ...base, deltaW: null, mf: null }), true);
  assert.equal(validateRateLampSample({ ...base, deltaW: -0.1, mf: 0.3 }), false);
  assert.equal(validateRateLampSample({ ...base, deltaW: 0.2, mf: NaN }), false);
  assert.equal(validateRateLampSample({ ...base, mf: 0.3 }), false, 'a reliable sample stamping no deltaW at all');
});

test('validateRateLampSample enforces L_read field (not cacheRead)', () => {
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, deltaW: 0.2, mf: 0.3, L_read: 1000, turnSeq: 1 }), true);
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, deltaW: 0.2, mf: 0.3, cacheRead: 1000, turnSeq: 1 }), false,
    'a cacheRead-named sample is rejected — the field MUST be L_read');
  assert.equal(validateRateLampSample({ seq: 1, reliable: false, turnSeq: 1 }), true, 'unreliable sample needs only seq/turnSeq');
  assert.equal(validateRateLampSample({ seq: 1, reliable: false }), false, 'round-2: unreliable sample still REQUIRES turnSeq');
});

test('round-8 GPT#3: validateRateLampSample rejects a negative L_read', () => {
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, deltaW: 0.2, mf: 0.3, L_read: -1, turnSeq: 1 }), false, 'negative L_read');
});
