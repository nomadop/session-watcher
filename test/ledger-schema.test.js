import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLedgerState, validateRateLampSample } from '../lib/ledger-schema.js';

test('validateLedgerState accepts a well-formed state', () => {
  const s = { schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
    billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940 };
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
    lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
    pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940 };
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
  const good = { schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
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

// ─── v2.2-C-1: schema v2 hard version gate + new-field validation ──────────────────────────────────────
// A valid schema-v2 ledger: the v1 shape + the 8 new fields at their freshLedger defaults.
const v2good = () => ({ schemaVersion: 2, stateKey: 'k', billingBasis: 'fullCarry', billProgress: 0.4,
  billCycleCount: 3, billAnchorLRead: 100000, billAnchorTurnSeq: 5, billAnchorFoldedCallSeq: 12,
  lastBurnRate: 0.2, lastAppliedFoldedCallSeq: 12, currentTurnSeq: 5, currentTurnDeltaW: 0.3,
  pendingBillCountSinceBoundary: 0, pausedReason: null, cacheExpiryCount: 0, kStableFrozen: 940,
  lastAppliedLRead: 100000,
  settledThroughTurnSeq: 4, alertEvaluatedThroughTurnSeq: 4, ledgerRevision: 7,
  pendingStopEvaluations: [], settledTurnSummaries: [], recentStopEvents: [], recentProcessedHookEventIds: [],
  deepWaterDisplayLatched: false });
// A fully-populated summary — every field the real settle emits, all legal (helper discipline F3).
const summary = (over = {}) => ({ turnSeq: 3, foldedCallSeqStart: 2, foldedCallSeqEnd: 5, deltaW: 0.7,
  billCycleCountIncrement: 1, inDeepWaterAtBoundary: true, billKindAtBoundary: 'non_idle_burn',
  billProgressBefore: 0.2, billProgressAfter: 0.9, hBreakAtBoundary: 1200, ...over });
const pending = (over = {}) => ({ hookEventId: 'h1', beforeSettledThroughTurnSeq: 4, requestedAtWallMs: 1000,
  enqueueSeq: 0, status: 'pending', ...over });

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

test('C1-1: new int cursors/revision enforce non-negative integer', () => {
  assert.equal(validateLedgerState({ ...v2good(), settledThroughTurnSeq: -1 }), null, 'cursor ≥ 0');
  assert.equal(validateLedgerState({ ...v2good(), alertEvaluatedThroughTurnSeq: 1.5 }), null, 'cursor is an int');
  assert.equal(validateLedgerState({ ...v2good(), ledgerRevision: -2 }), null, 'revision ≥ 0');
});

test('C1-1: a claimed-v2 ledger MISSING a new field back-fills the default (v2-local tolerate, not migration)', () => {
  const partial = v2good();
  delete partial.pendingStopEvaluations; delete partial.settledTurnSummaries;
  delete partial.recentStopEvents; delete partial.recentProcessedHookEventIds;
  delete partial.deepWaterDisplayLatched; delete partial.settledThroughTurnSeq;
  delete partial.alertEvaluatedThroughTurnSeq; delete partial.ledgerRevision;
  const r = validateLedgerState(partial);
  assert.ok(r, 'a partial-write v2 ledger normalizes rather than wiping');
  assert.deepEqual(r.pendingStopEvaluations, []);
  assert.deepEqual(r.settledTurnSummaries, []);
  assert.deepEqual(r.recentStopEvents, []);
  assert.deepEqual(r.recentProcessedHookEventIds, []);
  assert.equal(r.deepWaterDisplayLatched, false, 'non-boolean/absent → false');
  assert.equal(r.settledThroughTurnSeq, 0);
  assert.equal(r.alertEvaluatedThroughTurnSeq, 0, 'defaults to settledThroughTurnSeq');
  assert.equal(r.ledgerRevision, 0);
});

test('C1-1: settledTurnSummaries — per-element load-bearing ranges hard-reject', () => {
  assert.ok(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary()] }), 'a legal summary passes');
  assert.ok(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ deltaW: -0.5, billKindAtBoundary: 'cache_unstable' })] }),
    'a cache_unstable boundary has NEGATIVE deltaW — finite, any sign, MUST pass (NOT ≥0)');
  assert.equal(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ deltaW: Infinity })] }), null, 'deltaW must be FINITE');
  assert.equal(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ turnSeq: -1 })] }), null, 'turnSeq ≥ 0');
  assert.equal(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ foldedCallSeqEnd: 1 })] }), null, 'End ≥ Start');
  assert.equal(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ billCycleCountIncrement: -1 })] }), null, 'increment ≥ 0');
  assert.equal(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ inDeepWaterAtBoundary: 'yes' })] }), null, 'inDeepWater is a boolean');
  assert.equal(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ billKindAtBoundary: 'made_up' })] }), null, 'billKind enum');
  assert.ok(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ billKindAtBoundary: null })] }), 'null billKind (pre-calibration) is legal');
});

test('C1-1: settledTurnSummaries — display trio is VALIDATE-AND-TOLERATE (back-fill, not wipe)', () => {
  // NaN billProgress is LEGAL (pre-calibration). Infinity hBreak is LEGAL (never-break-even).
  assert.ok(validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ billProgressBefore: NaN, billProgressAfter: NaN, hBreakAtBoundary: Infinity })] }),
    'NaN billProgress + Infinity hBreak are legal, not corruption');
  // An out-of-domain display value back-fills the field; the ledger is NOT wiped (alert history preserved).
  const r = validateLedgerState({ ...v2good(), settledTurnSummaries: [summary({ billProgressBefore: 1.5, billProgressAfter: -0.2, hBreakAtBoundary: -5 })] });
  assert.ok(r, 'a bad display value tolerates rather than wiping the ledger');
  assert.ok(Number.isNaN(r.settledTurnSummaries[0].billProgressBefore), 'billProgressBefore back-filled to NaN');
  assert.ok(Number.isNaN(r.settledTurnSummaries[0].billProgressAfter), 'billProgressAfter back-filled to NaN');
  assert.equal(r.settledTurnSummaries[0].hBreakAtBoundary, null, 'hBreakAtBoundary back-filled to null');
});

test('C1-1: pendingStopEvaluations — per-element ranges + tombstone-free status (J-Gpt2)', () => {
  assert.ok(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending()] }), 'a legal pending passes');
  assert.ok(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending({ requestedAtMonoMs: 5, processNonce: 9 })] }), 'optional mono/nonce fields tolerated');
  assert.equal(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending({ hookEventId: 7 })] }), null, 'hookEventId is a string');
  assert.equal(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending({ beforeSettledThroughTurnSeq: -1 })] }), null, 'watermark ≥ 0');
  assert.equal(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending({ requestedAtWallMs: NaN })] }), null, 'requestedAtWallMs finite');
  assert.equal(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending({ enqueueSeq: -1 })] }), null, 'enqueueSeq ≥ 0');
  assert.equal(validateLedgerState({ ...v2good(), pendingStopEvaluations: [pending({ status: 'expired_unmatched' })] }), null, "any status other than 'pending' is foreign → reject");
});

test('C1-1: recentStopEvents / recentProcessedHookEventIds — element ranges', () => {
  assert.ok(validateLedgerState({ ...v2good(), recentStopEvents: [{ kind: 'wall', turnSeq: 3 }] }), 'a legal stop event passes');
  assert.equal(validateLedgerState({ ...v2good(), recentStopEvents: [{ kind: 5, turnSeq: 3 }] }), null, 'kind is a string');
  assert.equal(validateLedgerState({ ...v2good(), recentStopEvents: [{ kind: 'wall', turnSeq: -1 }] }), null, 'turnSeq ≥ 0');
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
