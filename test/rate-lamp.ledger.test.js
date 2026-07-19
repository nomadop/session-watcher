import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshLedger, stateKeyOf, stateKeyForStatus, applyFoldedCallSample, advanceGateAndBackstop,
  saveRateLampState, loadRateLampState } from '../lib/rate-lamp-store.js';
import { validateLedgerState } from '../lib/ledger-schema.js';
import { initStore, closeStoreGlobal } from '../lib/store.js';

let _storeDir;
beforeEach(() => {
  _storeDir = mkdtempSync(join(tmpdir(), 'sw-rl-ledger-'));
  initStore(join(_storeDir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(_storeDir, { recursive: true, force: true });
});

const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'd30000|t25000|k6|T', contextCap: 1000000, schemaVersion: 1 });
// sample helper — field is L_read (effectiveL), NEVER cacheRead (Task 2.5 locked contract).
const rs = (seq, burnRate, L_read, turnSeq = 1) => ({ seq, reliable: true, burnRate, L_read, turnSeq });

test('5: trapezoidal integration billProgress += ½(prev+now), not rectangular', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000, 3)); // first frame: anchor only, no integration (turnSeq=3)
  assert.equal(s.billProgress, 0);
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000, 3));
  assert.ok(Math.abs(s.billProgress - 0.5 * (0.2 + 0.4)) < 1e-9, 'trapezoid ½(0.2+0.4)=0.3');
});

test('6: first frame after fresh anchors lastBurnRate + anchor fields, integrates nothing (no rectangular head)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.9, 5000, 2));
  assert.equal(s.billProgress, 0, 'a lone first frame never integrates (rectangular head would give 0.9)');
  assert.equal(s.lastBurnRate, 0.9, 'first frame re-anchors lastBurnRate');
  assert.equal(s.billAnchorLRead, 5000);
  assert.equal(s.billAnchorFoldedCallSeq, 1);
  assert.equal(s.lastAppliedFoldedCallSeq, 1);
});

test('7 + 9: billProgress ≥ 1 settles and −=1 keeping remainder (not reset to 0)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1.2, 1000));
  s = applyFoldedCallSample(s, rs(2, 1.2, 2000)); // ½(1.2+1.2)=1.2 → cross once, remainder ≈0.2
  assert.equal(s.billCycleCount, 1);
  // floor-on-store (#1/#2 fix): 1.2-1 = 0.19999999999999996 → floor(·1e6)/1e6 = 0.199999 (≤1e-6 low).
  assert.equal(s.billProgress, 0.199999, 'remainder kept (floored, not zeroed)');
});

test('8: one turn with N calls crossing >1 produces multiple cycle counts', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 2.0, 1000, 5));
  s = applyFoldedCallSample(s, rs(2, 2.0, 2000, 5)); // trapezoid 2.0 → 2 crossings
  assert.equal(s.billCycleCount, 2);
});

test('10/11: billCycleCount is a LIFETIME counter — accumulates across calls', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 2.0, 1000)); // anchor at L_read=1000
  s = applyFoldedCallSample(s, rs(2, 2.0, 2000)); // trap 2.0 → 2 crossings
  assert.equal(s.billCycleCount, 2);
  s = applyFoldedCallSample(s, rs(3, 2.0, 60000)); // trap ½(2.0+2.0)=2.0 → 2 more
  assert.equal(s.billCycleCount, 4, 'lifetime counter accumulated');
});

test('45: duplicate foldedCallSeq (seq ≤ lastApplied) → no-op', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000));
  const snap = { ...s };
  const replayed = applyFoldedCallSample(s, rs(2, 0.4, 2000)); // same seq again
  assert.deepEqual(replayed, snap, 'idempotent no-op on replayed seq');
});

test('46: foldedCallSeq gap → pause(folded_seq_gap), no cross-gap integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, rs(3, 0.9, 5000)); // gap (expected 2)
  assert.equal(s.pausedReason, 'folded_seq_gap');
  assert.equal(s.billProgress, 0, 'did not integrate across the gap');
});

test('47: reliable recovery first frame re-anchors only, no catch-up integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'metrics_unreliable', turnSeq: 1 }); // round-2: unreliable sample carries turnSeq (schema requires it)
  assert.equal(s.pausedReason, 'metrics_unreliable');
  const before = s.billProgress;
  s = applyFoldedCallSample(s, rs(3, 0.8, 4000)); // recovery: re-anchor, no integrate
  assert.equal(s.billProgress, before, 'recovery frame only re-anchors lastBurnRate');
  s = applyFoldedCallSample(s, rs(4, 0.8, 5000)); // now integrates
  assert.ok(s.billProgress > before);
});

test('48: billAnchorLRead anchors from the recovering first-frame L_read', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.3, 10000)); // anchor at L=10000
  assert.equal(s.billAnchorLRead, 10000, 'anchor set from first frame');
});

test('49: −=1 applies round(billProgress, 6) (no long-tail float drift)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1/3, 1000));
  s = applyFoldedCallSample(s, rs(2, 1/3 + 2, 2000)); // force a crossing with irrational-ish sum
  assert.equal(s.billProgress, Math.round(s.billProgress * 1e6) / 1e6);
});

test('R5 GPT#2: billProgress landing at 0.9999996 must NOT round up to a premature bill', () => {
  // The OLD code did round6(billProgress + trap) BEFORE the `>= 1` test. 0.9999996·1e6 = 999999.6 → rounds
  // to 1000000 → 1.0, so a value genuinely BELOW 1 fired a bill one call early. Construct exactly that value.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.9999992, 1000)); // anchor: lastBurnRate = 0.9999992, no integration
  s = applyFoldedCallSample(s, rs(2, 1.0, 2000));       // trap = ½(0.9999992 + 1.0) = 0.9999996
  assert.equal(s.billCycleCount, 0, 'no premature bill: 0.9999996 < 1, must not be rounded up first');
  assert.ok(s.billProgress < 1 && s.billProgress > 0.9999, 'remainder retained un-rounded-up');
});

test('R5 GPT#2: a genuine crossing still settles exactly one bill (regression guard)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1.0, 1000));
  s = applyFoldedCallSample(s, rs(2, 1.4, 2000)); // trap = ½(1.0+1.4) = 1.2 → next 1.2 ≥ 1 → one bill, rem ≈0.2
  assert.equal(s.billCycleCount, 1);
  assert.equal(s.billProgress, 0.199999, 'remainder ≈0.2, floored on store (#1/#2 fix)');
});

// --- #1/#2 (fix wave): a remainder in [0.9999995,1) must not up-round INSIDE the settle loop ---

test('#1/#2: remainder 0.9999996 settles EXACTLY one bill (round6 inside the loop double-billed)', () => {
  // REPRO: prior remainder 0.7, both burn rates 1.2999996 → trap = ½(1.2999996+1.2999996) = 1.2999996,
  // next = 0.7 + 1.2999996 = 1.9999996. Pre-fix `next = round6(next - 1)` rounds 0.9999996 → 1.0, so the
  // while-loop iterates a SECOND time (phantom bill) and lands at remainder 0. Floor-on-store subtracts on
  // the unrounded running value and stores floor(0.9999996) = 0.999999 (< 1) — exactly one bill.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0, 1000, 4));   // anchor: lastBurnRate=0, no integration
  s.billProgress = 0.7;                               // force the exact boundary state
  s.lastBurnRate = 1.2999996;
  const beforeCycles = s.billCycleCount;
  s = applyFoldedCallSample(s, rs(2, 1.2999996, 1100, 4)); // trap 1.2999996 → next 1.9999996
  assert.equal(s.billCycleCount - beforeCycles, 1, 'EXACTLY one bill (1.9999996 crosses 1 once)');
  assert.equal(s.billProgress, 0.999999, 'floored remainder: floor(0.9999996·1e6)=999999 → 0.999999');
  assert.ok(s.billProgress < 1, 'stored remainder is < 1 by construction (floor never rounds up)');
});

// Task 4: currentTurnDeltaW retired (sole consumer was dw_backstop, replaced by amber-baseline backstop).

test('advanceGateAndBackstop: gate dwell counts API calls, not cycle ticks (Change A fix)', () => {
  const s = freshLedger(KEY);
  advanceGateAndBackstop(s, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(s.deepWaterDwell, 1, 'first call: dwell=1');
  advanceGateAndBackstop(s, { inDeepWater: true, billCycleIncrement: 2, mf: 0.2 });
  assert.equal(s.deepWaterDwell, 2, 'second call: dwell=2 (not 1+2=3)');
  assert.equal(s.hasDeepWaterGateFired, false, '2 calls < NOTIFY_DWELL=3 → not armed');
  advanceGateAndBackstop(s, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(s.hasDeepWaterGateFired, true, '3 calls with cycles → armed');
});

// --- Review-added regression tests (GPT#1 miss-row, A1 multi-call poll, A2/A3) ---

test('REVIEW A1: N samples in one batch integrate per-call (not one lump), no gap', () => {
  let s = freshLedger(KEY);
  // simulate a poll that ingested 4 new calls: feed 4 samples seq 1..4 in order
  for (let i = 1; i <= 4; i++) s = applyFoldedCallSample(s, rs(i, 0.3, 1000 * i, 1));
  assert.equal(s.pausedReason, null, 'no folded_seq_gap when fed per-call');
  assert.equal(s.lastAppliedFoldedCallSeq, 4);
  assert.ok(s.billProgress > 0, 'integrated the middle calls, did not first-frame-drop them');
});

test('REVIEW A2: unreliable sample ADVANCES seq so recovery is not a spurious gap', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'metrics_unreliable', turnSeq: 1 });
  assert.equal(s.lastAppliedFoldedCallSeq, 2, 'unreliable sample advanced the seq cursor');
  s = applyFoldedCallSample(s, rs(3, 0.8, 4000)); // seq 3 = lastApplied+1 → recovery re-anchor, NOT gap
  assert.equal(s.pausedReason, null, 'clean recovery, no folded_seq_gap');
});

test('REVIEW A2: an unreliable sample freezes lastBurnRate → null AND carries its unavailableReason through', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.5, 1000));
  assert.equal(s.lastBurnRate, 0.5);
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'invalid_baseline', turnSeq: 1 });
  assert.equal(s.lastBurnRate, null, 'lastBurnRate zeroed to force a clean re-anchor on recovery (P0-5)');
  assert.equal(s.pausedReason, 'invalid_baseline', 'the specific unavailableReason is preserved (schema allows it)');
  assert.ok(validateLedgerState(s), 'an unreliable-drain paused state still re-validates (schema PAUSE_REASONS covers invalid_baseline)');
});

// Task 4: currentTurnDeltaW per-turn reset test retired (field removed; backstop now via bill-count interval).

test('REVIEW GPT#1: reducer uses L_read (effectiveL) — always positive progression', () => {
  // The ledger only ever sees L_read (effectiveL). A miss row has HIGHER L_read than prior,
  // so the reducer integrates normally — never pauses from a miss.
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.3, 200000));
  s = applyFoldedCallSample(s, rs(2, 0.3, 260000)); // miss row L_read rises
  assert.notEqual(s.pausedReason, 'cache_unstable', 'rising L_read never pauses');
  assert.ok(s.billProgress > 0 || s.lastBurnRate !== null, 'integrated normally');
});

test('R2-9: an already-applied seq reappearing with a CHANGED L_read → pause(folded_call_mutated)', () => {
  // R5 GPT#4: this is a REDUCER-ONLY defense. It fires only when a same-seq sample is re-fed directly; the
  // live manager (rateLampSamplesSince) only ever emits foldedSeq>sinceSeq, so this branch is unreachable
  // from the manager path by design — no manager-level same-seq re-check is added (see R2-9/F-7 notes).
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000)); // seq 2 applied at L_read=2000
  const mutated = applyFoldedCallSample(s, rs(2, 0.4, 9999)); // same seq, DIFFERENT L_read
  assert.equal(mutated.pausedReason, 'folded_call_mutated', 'in-place mutation of an integrated call is not silently swallowed');
  const same = applyFoldedCallSample(s, rs(2, 0.4, 2000)); // same seq, SAME L_read → idempotent no-op
  assert.equal(same.pausedReason, null);
});

test('R2-11: a malformed (cacheRead-named) sample → pause(invalid_sample), no integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000));
  const bad = applyFoldedCallSample(s, { seq: 2, reliable: true, burnRate: 0.4, cacheRead: 2000, turnSeq: 1 });
  assert.equal(bad.pausedReason, 'invalid_sample');
  assert.equal(bad.billProgress, 0, 'did not integrate a sample that failed the schema guard');
});

test('final-review GPT#5 + R5 GPT#3: a CORRUPT prev → pause(invalid_sample) AND the returned state itself re-validates', () => {
  const corrupt = { ...freshLedger(KEY, 940), billProgress: 1.2 }; // out of [0,1)
  const r1 = applyFoldedCallSample(corrupt, rs(5, 0.4, 2000));
  assert.equal(r1.pausedReason, 'invalid_sample', 'reducer validates prev, does not integrate onto a corrupt ledger');
  assert.ok(validateLedgerState(r1), 'R5 GPT#3: the returned paused state is NOT still corrupt');
  assert.equal(r1.stateKey, KEY, 'preserves the reusable stateKey');
});

test('35: stateKeyOf is sensitive to model, cRatio and contextCap (all baseline-scope fields reset the ledger)', () => {
  const base = { segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'A', contextCap: 1e6, schemaVersion: 1 };
  const k0 = stateKeyOf(base);
  assert.notEqual(k0, stateKeyOf({ ...base, model: 'sonnet' }), 'model change → new key');
  assert.notEqual(k0, stateKeyOf({ ...base, cRatio: 5 }), 'cRatio change → new key');
  assert.notEqual(k0, stateKeyOf({ ...base, contextCap: 200000 }), 'contextCap change → new key');
  assert.notEqual(k0, stateKeyOf({ ...base, segmentId: 1 }), 'segmentId change → new key');
  assert.equal(k0, stateKeyOf({ ...base }), 'same inputs → same key (deterministic, order-stable)');
});

test('36/37: state key change resets; xExit is NOT in the key', () => {
  const k1 = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'A', contextCap: 1e6, schemaVersion: 1 });
  const k2 = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'B', contextCap: 1e6, schemaVersion: 1 });
  assert.notEqual(k1, k2, 'baselineFingerprint change → different key → reset');
  // xExit is not a parameter of stateKeyOf at all — cannot influence the key.
  assert.ok(!/xExit/i.test(stateKeyOf.toString()));
});

test('GPT#11: freshLedger freezes kStableFrozen at creation (segment constant, reused on same-key restart)', () => {
  const s = freshLedger(KEY, 940);
  assert.equal(s.kStableFrozen, 940, 'k_stable frozen into the ledger at creation');
  assert.equal(freshLedger(KEY).kStableFrozen, 0, 'default frozen k_stable is 0 (benign degradation)');
});

test('50: single ledger — deadOnly is counterfactual only (store has no deadOnly ledger)', () => {
  // stateKeyOf/freshLedger/applyFoldedCallSample take no scenario param → structurally single-ledger.
  const s = freshLedger(KEY);
  assert.equal(s.billingBasis, 'fullCarry');
  assert.equal('deadOnlyBillProgress' in s, false);
});

test('GPT#12: persistence round-trips a valid ledger and a corrupt/foreign entry loads as null (silent fresh)', () => {
  // store is already initialized by beforeEach — just use it directly
  const s = freshLedger(KEY, 940);
  saveRateLampState('sess-A', s);
  assert.deepEqual(loadRateLampState('sess-A'), s, 'a valid saved ledger round-trips through validateLedgerState');
  // a value that fails the schema (validateLedgerState → null) must load as null, never crash.
  saveRateLampState('sess-B', { not: 'a ledger' });
  assert.equal(loadRateLampState('sess-B'), null, 'a schema-invalid entry loads as null (treated as no saved state)');
  // a never-written session loads as null too (getStore().load returns null → catch → null).
  assert.equal(loadRateLampState('sess-missing'), null, 'no entry → null, no throw');
});

// --- v3: stateKeyForStatus keyed on segment only (spec §5 #8 / §6.3) ---

test('v3: stateKeyForStatus keyed on segment only (model/ratio changes do not reset billing)', () => {
  const a = stateKeyForStatus({ segment: 3, model: 'claude-opus-4-8', rateLamp: { C_RATIO: 12.5, L_cap: 1 } });
  const b = stateKeyForStatus({ segment: 3, model: 'deepseek-v4', rateLamp: { C_RATIO: 50, L_cap: 2 } });
  assert.equal(a, b, 'same segment → same key regardless of model/ratio/cap');
  const c = stateKeyForStatus({ segment: 4, model: 'claude-opus-4-8', rateLamp: { C_RATIO: 12.5, L_cap: 1 } });
  assert.notEqual(a, c, 'new segment → new key');
});

