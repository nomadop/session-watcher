import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, serializeState, parseState, rawTierFor, validateGateState } from '../lib/notify-gate.js';

const snap = (o = {}) => ({ segment: 0, turnSeq: 1, reliable: true, x: 1.0,
  landmarks: { fullCarry: { xStar: 2.0, dhat: 0.5 } }, ...o });

test('57: segment change → fresh state (review A6: x below entry isolates the reset)', () => {
  // A6 fix: the prior plan used x:3.0 here, which would fire tier2 and set maxTierFired=2 — a
  // self-contradiction. Use x below xStar so this test asserts ONLY the fresh-state reset, not firing.
  const prev = { segment: 0, turnSeq: 9, maxTierFired: 2, pendingCount: 1 };
  const r = evaluateGate(snap({ segment: 1, turnSeq: 1, x: 1.0 }), prev);
  assert.equal(r.nextState.maxTierFired, 0, 'segment change reset maxTierFired');
  assert.equal(r.nextState.pendingCount, 0);
  assert.equal(r.notify, false);
});

test('57b: segment change with x already past exit DOES evaluate this turn (tier2 fires)', () => {
  // The complementary behavior: fresh state, then evaluated on the same turn — tier2 is confirm-exempt.
  const prev = { segment: 0, turnSeq: 9, maxTierFired: 2, pendingCount: 1 };
  const r = evaluateGate(snap({ segment: 1, turnSeq: 1, x: 2.6 }), prev);
  assert.equal(r.notify, true); assert.equal(r.tier, 2);
});

test('A7: rawTierFor is the single source of tier math (POST and peek share it)', () => {
  const fc = { xStar: 2.0, dhat: 0.5 };
  assert.equal(rawTierFor(1.5, fc), 0);
  assert.equal(rawTierFor(2.1, fc), 1);
  assert.equal(rawTierFor(2.6, fc), 2); // ≥ xStar+dhat
  assert.equal(rawTierFor(3.0, { xStar: 0, dhat: 0 }), 0, 'invalid landmarks → 0');
});

test('58: turn idempotency → duplicate_turn, no fire', () => {
  const prev = { segment: 0, turnSeq: 5, maxTierFired: 0, pendingCount: 0 };
  const r = evaluateGate(snap({ turnSeq: 5, x: 3.0 }), prev);
  assert.equal(r.notify, false); assert.equal(r.reason, 'duplicate_turn');
});

test('59: reliable=false → not_reliable freeze, pendingCount cleared', () => {
  const r = evaluateGate(snap({ reliable: false, x: 3.0 }), { segment: 0, turnSeq: 0, maxTierFired: 0, pendingCount: 1 });
  assert.equal(r.notify, false); assert.equal(r.reason, 'not_reliable');
  assert.equal(r.nextState.pendingCount, 0);
});

test('60: invalid landmarks → invalid_landmarks, no fire', () => {
  const r = evaluateGate(snap({ x: 3.0, landmarks: { fullCarry: { xStar: 0, dhat: 0 } } }), null);
  assert.equal(r.notify, false); assert.equal(r.reason, 'invalid_landmarks');
});

test('61: tier1 needs two consecutive eligible turns', () => {
  let st = null;
  let r = evaluateGate(snap({ turnSeq: 1, x: 2.1 }), st); // xStar=2.0 → rawTier 1
  assert.equal(r.notify, false); assert.equal(r.reason, 'pending_confirm');
  r = evaluateGate(snap({ turnSeq: 2, x: 2.1 }), r.nextState);
  assert.equal(r.notify, true); assert.equal(r.tier, 1);
});

test('62: tier2 fires in one turn (exempt from confirm)', () => {
  const r = evaluateGate(snap({ turnSeq: 1, x: 2.6 }), null); // ≥ xStar+dhat=2.5 → tier2
  assert.equal(r.notify, true); assert.equal(r.tier, 2);
});

test('63: ratchet absorbs thrash / x* drift (rawTier ≤ maxTierFired → suppressed)', () => {
  const prev = { segment: 0, turnSeq: 3, maxTierFired: 1, pendingCount: 0 };
  const r = evaluateGate(snap({ turnSeq: 4, x: 2.1 }), prev); // rawTier 1 ≤ fired 1
  assert.equal(r.notify, false); assert.equal(r.reason, 'below_or_fired');
});

test('64: ≤2 alerts/segment (tier1 then tier2, then silent)', () => {
  let r = evaluateGate(snap({ turnSeq: 1, x: 2.1 }), null);
  r = evaluateGate(snap({ turnSeq: 2, x: 2.1 }), r.nextState); assert.equal(r.tier, 1);
  r = evaluateGate(snap({ turnSeq: 3, x: 2.6 }), r.nextState); assert.equal(r.tier, 2); assert.equal(r.notify, true);
  r = evaluateGate(snap({ turnSeq: 4, x: 3.0 }), r.nextState); assert.equal(r.notify, false);
});

test('65: serialize/parse round-trip; bad string → null', () => {
  const st = { segment: 2, turnSeq: 7, maxTierFired: 1, pendingCount: 0 };
  assert.deepEqual(parseState(serializeState(st)), st);
  assert.equal(parseState('{bad'), null);
  assert.equal(parseState('{}'), null); // missing segment → null
});

test('gate messages are neutral — no α / no verdict words (Global Constraints §1/§5)', () => {
  // fire tier1 and tier2 and inspect the returned message copy
  let r = evaluateGate(snap({ turnSeq: 1, x: 2.1 }), null);       // rawTier1, pending
  r = evaluateGate(snap({ turnSeq: 2, x: 2.1 }), r.nextState);     // tier1 fires
  const tier1msg = r.message;
  const t2 = evaluateGate(snap({ turnSeq: 1, x: 2.6 }), null);     // tier2 fires in one turn
  const tier2msg = t2.message;
  for (const m of [tier1msg, tier2msg]) {
    assert.ok(m, 'a fired tier has a message');
    assert.ok(!/α|alpha|strongly|waste|must|urgent|overdue/i.test(m), `neutral copy only: ${m}`);
  }
});

test('round-6 GPT#6: validateGateState enforces ranges (not just presence)', () => {
  const good = { segment: 1, turnSeq: 3, maxTierFired: 1, pendingCount: 0 };
  assert.deepEqual(validateGateState(good), good);
  assert.equal(validateGateState(null), null);
  assert.equal(validateGateState({ ...good, turnSeq: -1 }), null, 'negative turnSeq rejected');
  assert.equal(validateGateState({ ...good, maxTierFired: 999 }), null, 'tier outside {0,1,2} rejected');
  assert.equal(validateGateState({ ...good, pendingCount: 99 }), null, 'pendingCount out of range rejected');
  assert.equal(validateGateState({ ...good, segment: 1.5 }), null, 'non-integer segment rejected');
});
