import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLedger, stateKeyOf } from '../lib/rate-lamp-store.js';
import { validateLedgerState } from '../lib/ledger-schema.js';
import { mutateLedger } from '../lib/rate-lamp-manager.js';

const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 2 });

test('C1-1: freshLedger carries all fields with sane defaults', () => {
  const s = freshLedger(KEY);
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.ledgerRevision, 0);
  assert.deepEqual(s.recentStopEvents, []);
  assert.deepEqual(s.recentProcessedHookEventIds, []);
  assert.equal(s.hasDeepWaterGateFired, false);
  assert.equal(s.dwBillsSinceLastAlert, 0);
  assert.equal(s.backstopLapCount, 0);
  assert.equal(s.billProgress, 0);
  assert.equal(s.billCycleCount, 0);
});

test('C1-1: a stale v1 disk ledger is REJECTED (schemaVersion mismatch → null → degrade to fresh) — no migration (H-C)', () => {
  // No v1→v2 migration: validateLedgerState hard-gates schemaVersion===2. A v1-shaped ledger (schemaVersion:1,
  // none of the 8 new fields) is judged foreign and returns null; loadRateLampState then yields null and the
  // manager builds a freshLedger. This is the intentional under-report H-C accepts (transient session ledger).
  const v1 = { schemaVersion: 1, stateKey: KEY, currentTurnSeq: 7, billProgress: 0.3, billCycleCount: 1,
    billAnchorLRead: 1000, billAnchorFoldedCallSeq: 2, billAnchorTurnSeq: 7, lastAppliedFoldedCallSeq: 2,
    lastAppliedLRead: 1000, kStableFrozen: 500 };
  assert.equal(validateLedgerState(v1), null, 'v1 schemaVersion → null (no accept, no back-fill)');
});

test('C1-1: mutateLedger bumps ledgerRevision on a real content change, not on a no-op fn', () => {
  const s = freshLedger(KEY);
  const a = mutateLedger(s, 'set-progress', (l) => { l.billProgress = 0.1; });
  assert.equal(a.ledgerRevision, 1);
  const b = mutateLedger(a, 'touch', () => {});                 // fn changes nothing → content identical
  assert.equal(b.ledgerRevision, 1, 'no content change → no bump (derived from before===after, not reason)');
  assert.equal(b, a, 'no-op returns the SAME object untouched');
});

test('C1-1: mutateLedger does not alias arrays (push in fn must not pollute the prior ledger)', () => {
  const s = freshLedger(KEY);
  const a = mutateLedger(s, 'enqueue', (l) => { l.recentStopEvents.push({ kind: 'wall', seq: 1 }); });
  assert.equal(a.recentStopEvents.length, 1);
  assert.equal(s.recentStopEvents.length, 0, 'prior ledger array untouched (structuredClone, no alias)');
});

test('C1-1: invariant — any op that makes memory content ≠ disk content strictly increases ledgerRevision (B5)', () => {
  const base = freshLedger(KEY);
  const changed = mutateLedger(base, 'test-content-change', (d) => { d.currentTurnSeq = base.currentTurnSeq + 1; });
  assert.ok(changed.ledgerRevision > base.ledgerRevision, 'content changed ⟹ revision strictly increased');
  const noop = mutateLedger(base, 'test-noop', () => {});
  assert.equal(noop.ledgerRevision, base.ledgerRevision, 'no content change ⟹ revision flat');
});
