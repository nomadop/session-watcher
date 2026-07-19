import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLedgerState, validateRateLampSample } from '../lib/ledger-schema.js';

test('validateLedgerState accepts a well-formed state', () => {
  const s = { schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
    hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0 };
  assert.deepEqual(validateLedgerState(s), s);
});

test('validateLedgerState rejects corrupt/half-valid → null (silent fresh, no crash)', () => {
  assert.equal(validateLedgerState(null), null);
  assert.equal(validateLedgerState({}), null);
  // Base the corrupt-billProgress fixtures on an OTHERWISE-valid schema-v2 ledger so they REACH the numeric
  // field checks. Under the new hard version gate (schemaVersion!==2 → null) a v1 fixture short-circuits at
  // the gate → null for the WRONG reason, masking the billProgress-rejection path these assertions name.
  // Only billProgress is corrupt below, so each goes RED iff the billProgress field validation is removed.
  const validV2 = { schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
    hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0 };
  assert.ok(validateLedgerState({ ...validV2 }), 'sanity: the base fixture is a VALID v2 ledger (so null below is billProgress-only)');
  const missingBillProgress = { ...validV2 }; delete missingBillProgress.billProgress;
  assert.equal(validateLedgerState(missingBillProgress), null, 'missing billProgress (reaches the field check, not the version gate)');
  assert.equal(validateLedgerState({ ...validV2, billProgress: 'x' }), null, 'wrong-typed billProgress');
});

test('validateRateLampSample enforces L_read field (not cacheRead)', () => {
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: 0.2, L_read: 1000, turnSeq: 1 }), true);
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: 0.2, cacheRead: 1000, turnSeq: 1 }), false,
    'a cacheRead-named sample is rejected — the field MUST be L_read');
  assert.equal(validateRateLampSample({ seq: 1, reliable: false, turnSeq: 1 }), true, 'unreliable sample needs only seq/turnSeq');
  assert.equal(validateRateLampSample({ seq: 1, reliable: false }), false, 'round-2: unreliable sample still REQUIRES turnSeq');
});

test('round-2 GPT#11: validateLedgerState enforces RANGES, not just finiteness', () => {
  const good = { schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
    hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0 };
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
  const good = { schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
    lastAppliedLRead: 100000, hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0 };
  assert.equal(validateLedgerState({ ...good, kStableFrozen: -1 }), null, 'negative kStableFrozen (0 is fine, <0 is corruption)');
  assert.equal(validateLedgerState({ ...good, billAnchorLRead: -1 }), null, 'anchor L is a token count ≥ 0');
  assert.equal(validateLedgerState({ ...good, lastBurnRate: -0.1 }), null, 'burnRate is max(0,·) at source');
  assert.equal(validateLedgerState({ ...good, lastAppliedLRead: -1 }), null, 'applied L is a token count ≥ 0');
  assert.equal(validateLedgerState({ ...good, dwBillsSinceLastAlert: -1 }), null, 'negative dwBillsSinceLastAlert is corruption');
  assert.equal(validateLedgerState({ ...good, backstopLapCount: -1 }), null, 'negative backstopLapCount is corruption');
  assert.equal(validateLedgerState({ ...good, backstopLapCount: 1.5 }), null, 'non-integer backstopLapCount is corruption');
});

test('round-8 GPT#3: validateRateLampSample rejects a negative L_read / burnRate', () => {
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: 0.2, L_read: -1, turnSeq: 1 }), false, 'negative L_read');
  assert.equal(validateRateLampSample({ seq: 1, reliable: true, burnRate: -0.2, L_read: 1000, turnSeq: 1 }), false, 'negative burnRate');
});

// ─── v2.2-C-1: schema v2 hard version gate + new-field validation ──────────────────────────────────────
// A valid schema-v2 ledger matching the current freshLedger shape (Change A: boundary fields removed).
const v2good = () => ({ schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
  billCycleCount: 3, billAnchorLRead: 100000, billAnchorFoldedCallSeq: 12,
  lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5,
  pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
  lastAppliedLRead: 100000,
  hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0,
  ledgerRevision: 7, recentStopEvents: [], recentProcessedHookEventIds: [] });

test('C1-1 (H-C): a stale v1 disk ledger is REJECTED — schemaVersion !== 2 → null (no accept, no back-fill)', () => {
  const v1 = { schemaVersion: 1, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940 };
  assert.equal(validateLedgerState(v1), null, 'v1 schemaVersion → null');
  assert.equal(validateLedgerState({ ...v2good(), schemaVersion: 3 }), null, 'a future v3 is foreign too (hard === 2)');
});

test('C1-1: a well-formed schema-v2 ledger validates', () => {
  const s = v2good();
  assert.ok(validateLedgerState(s), 'v2 ledger with all 8 fields passes');
});

test('C1-1: ledgerRevision enforces non-negative integer', () => {
  assert.equal(validateLedgerState({ ...v2good(), ledgerRevision: -2 }), null, 'revision ≥ 0');
  assert.equal(validateLedgerState({ ...v2good(), ledgerRevision: 1.5 }), null, 'revision is an int');
});

test('C1-1: a claimed-v2 ledger MISSING a new field back-fills the default (v2-local tolerate, not migration)', () => {
  const partial = v2good();
  delete partial.recentStopEvents; delete partial.recentProcessedHookEventIds;
  delete partial.ledgerRevision;
  const r = validateLedgerState(partial);
  assert.ok(r, 'a partial-write v2 ledger normalizes rather than wiping');
  assert.deepEqual(r.recentStopEvents, []);
  assert.deepEqual(r.recentProcessedHookEventIds, []);
  assert.equal(r.ledgerRevision, 0);
});


test('C1-1: recentStopEvents / recentProcessedHookEventIds — element ranges', () => {
  assert.ok(validateLedgerState({ ...v2good(), recentStopEvents: [{ kind: 'wall', seq: 3 }] }), 'a legal stop event passes');
  assert.equal(validateLedgerState({ ...v2good(), recentStopEvents: [{ kind: 5, seq: 3 }] }), null, 'kind is a string');
  assert.ok(validateLedgerState({ ...v2good(), recentProcessedHookEventIds: ['a', 'b'] }), 'string ids pass');
  assert.equal(validateLedgerState({ ...v2good(), recentProcessedHookEventIds: ['a', 3] }), null, 'each id is a string');
});

test('C1-1: length caps — over-LIMIT array rejects the whole ledger (ring-eviction is the ADD-site guard)', () => {
  const bigIds = Array.from({ length: 129 }, (_, i) => `id-${i}`);           // RECENT_PROCESSED_HOOK_IDS_LIMIT = 128
  assert.equal(validateLedgerState({ ...v2good(), recentProcessedHookEventIds: bigIds }), null, '> 128 ids → reject');
  assert.ok(validateLedgerState({ ...v2good(), recentProcessedHookEventIds: bigIds.slice(0, 128) }), 'exactly 128 passes');
  const bigEvents = Array.from({ length: 33 }, () => ({ kind: 'wall', turnSeq: 1 })); // RECENT_STOP_EVENTS_LIMIT = 32
  assert.equal(validateLedgerState({ ...v2good(), recentStopEvents: bigEvents }), null, '> 32 stop events → reject');
});

test('Task 4: old ledger with currentTurnDeltaW + missing backstop fields hydrates to a valid v2 ledger', () => {
  // Simulate an old-format ledger that still carries currentTurnDeltaW (a stale field) and is missing
  // the three new backstop fields. The validator should back-fill them and NOT reject.
  const old = { ...v2good(), currentTurnDeltaW: 123 };
  delete old.hasDeepWaterGateFired; delete old.dwBillsSinceLastAlert; delete old.backstopLapCount;
  const v = validateLedgerState(old);
  assert.ok(v, 'not rejected as corrupt');
  assert.equal(v.hasDeepWaterGateFired, false, 'back-filled');
  assert.equal(v.dwBillsSinceLastAlert, 0);
  assert.equal(v.backstopLapCount, 0);
  // currentTurnDeltaW may remain on the tolerated object but is never READ; a later save drops it
  // (freshLedger no longer includes it). Assert the validator does not require it.
});
