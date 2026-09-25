import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshLedger, stateKeyOf, stateKeyForStatus, applyFoldedCallSample,
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
// sample helper — the increment is deltaW, the exchange rate is mf, and L_read rides along for the Engine's
// other readers. The reducer reads neither L_read nor any rate.
const rs = (seq, deltaW, mf = 0.3, L_read = 1000 * seq) => ({ seq, reliable: true, deltaW, mf, L_read, turnSeq: 1 });

test('7 + 9: billProgress ≥ 1 settles and −=1 keeping remainder (not reset to 0)', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 1.2));
  assert.equal(s.billCycleCount, 1);
  assert.equal(s.billProgress, 1.2 - 1, 'remainder kept, stored as computed');
});

test('10/11: billCycleCount is a LIFETIME counter — accumulates across calls', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 2.0));
  assert.equal(s.billCycleCount, 2);
  s = applyFoldedCallSample(s, rs(2, 2.0));
  assert.equal(s.billCycleCount, 4, 'lifetime counter accumulated');
});

test('45: duplicate foldedCallSeq (seq ≤ lastApplied) → no-op', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2));
  s = applyFoldedCallSample(s, rs(2, 0.4));
  const snap = { ...s };
  const replayed = applyFoldedCallSample(s, rs(2, 0.4)); // same seq again
  assert.deepEqual(replayed, snap, 'idempotent no-op on replayed seq');
});

test('46: foldedCallSeq gap → pause(folded_seq_gap), no cross-gap integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2));
  s = applyFoldedCallSample(s, rs(3, 0.9)); // gap (expected 2)
  assert.equal(s.pausedReason, 'folded_seq_gap');
  assert.equal(s.billProgress, 0.2, 'did not integrate across the gap');
});

test('#1/#2: the crossing test runs on the unrounded running value — a remainder just under the unit settles nothing', () => {
  // A remainder just under the unit is the window a round on store would lift to it, either firing a bill a
  // call early or re-entering the settle loop for a phantom second one. Nothing rounds, so the stored
  // remainder is what was computed and each assertion below discriminates a reintroduced quantization.
  let s = applyFoldedCallSample(freshLedger(KEY), rs(1, 0.9999996));
  assert.equal(s.billCycleCount, 0, 'a remainder below the unit settles no bill');
  assert.equal(s.billProgress, 0.9999996, 'remainder retained un-rounded');
  s = applyFoldedCallSample(s, rs(2, 1.0));
  assert.equal(s.billCycleCount, 1, 'EXACTLY one bill: the sum crosses the unit once');
  assert.equal(s.billProgress, 0.9999996, 'the crossing left the computed remainder, still below the unit');
});

// --- Review-added regression tests (multi-call poll, A2/A3) ---

test('four consecutive samples all integrate and pause nothing, the seq cursor reaching the last', () => {
  let s = freshLedger(KEY);
  // A poll that ingested four new calls feeds four samples seq 1..4 in order. Distinct increments make the
  // sum identify the multiset: a call counted twice beside one dropped cannot land on the same total.
  for (let i = 1; i <= 4; i++) s = applyFoldedCallSample(s, rs(i, 0.2 * i, 0.3, 1000 * i));
  assert.equal(s.pausedReason, null, 'no folded_seq_gap across a contiguous run');
  assert.equal(s.lastAppliedFoldedCallSeq, 4);
  assert.ok(Math.abs(s.billCycleCount + s.billProgress - 2.0) < 1e-9, 'integrated every call, dropped none');
});

test('REVIEW A2: unreliable sample ADVANCES seq so recovery is not a spurious gap', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'metrics_unreliable', turnSeq: 1 });
  assert.equal(s.lastAppliedFoldedCallSeq, 2, 'unreliable sample advanced the seq cursor');
  s = applyFoldedCallSample(s, rs(3, 0.8, 0.3, 4000)); // seq 3 = lastApplied+1 → integrates, NOT a gap
  assert.equal(s.pausedReason, null, 'clean recovery, no folded_seq_gap');
});

test('REVIEW A2: an unreliable sample carries its unavailableReason through and the paused state re-validates', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.5));
  s = applyFoldedCallSample(s, { seq: 2, reliable: false, unavailableReason: 'invalid_baseline', turnSeq: 1 });
  assert.equal(s.pausedReason, 'invalid_baseline', 'the specific unavailableReason is preserved (schema allows it)');
  assert.ok(validateLedgerState(s), 'an unreliable-drain paused state still re-validates (schema PAUSE_REASONS covers invalid_baseline)');
});

test('R2-11: a malformed (cacheRead-named) sample → pause(invalid_sample), no integration', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2));
  const bad = applyFoldedCallSample(s, { seq: 2, reliable: true, deltaW: 0.4, mf: 0.3, cacheRead: 2000, turnSeq: 1 });
  assert.equal(bad.pausedReason, 'invalid_sample');
  assert.equal(bad.billProgress, 0.2, 'did not integrate a sample that failed the schema guard');
});

test('final-review GPT#5 + R5 GPT#3: a CORRUPT prev → pause(invalid_sample) AND the returned state itself re-validates', () => {
  const corrupt = { ...freshLedger(KEY), billProgress: 1.2 }; // out of [0,1)
  const r1 = applyFoldedCallSample(corrupt, rs(5, 0.4, 0.3, 2000));
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
  // xExit reaches the key through no parameter: stateKeyOf takes a named set that does not include it,
  // so passing one alongside a fixed set cannot move the result.
  assert.equal(k1, stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'A', contextCap: 1e6, schemaVersion: 1, xExit: 0.9 }));
});

test('50: single ledger — deadOnly is counterfactual only (store has no deadOnly ledger)', () => {
  // stateKeyOf/freshLedger/applyFoldedCallSample take no scenario param → structurally single-ledger.
  const s = freshLedger(KEY);
  assert.equal(s.billingBasis, 'fullCarry');
  assert.equal('deadOnlyBillProgress' in s, false);
});

test('GPT#12: persistence round-trips a valid ledger and a corrupt/foreign entry loads as null (silent fresh)', () => {
  // store is already initialized by beforeEach — just use it directly
  const s = freshLedger(KEY);
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
