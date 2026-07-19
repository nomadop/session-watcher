// test/rate-lamp.settle-summary.test.js — per-call gate/backstop tests (Change A)
// Verifies that advanceGateAndBackstop correctly arms the gate after NOTIFY_DWELL
// consecutive deep-water API calls (with cycle), and fires the backstop at the correct interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initStore, closeStoreGlobal } from '../lib/store.js';
const TMP = mkdtempSync(join(tmpdir(), 'sw-rl-settle-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {};
});

import { freshLedger, stateKeyOf, applyFoldedCallSample, advanceGateAndBackstop } from '../lib/rate-lamp-store.js';
import { advanceRateLampToCurrent, setLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';

const KEY = stateKeyOf({ segmentId: 0, model: null, cRatio: null, baselineFingerprint: null, contextCap: null, schemaVersion: 1 });
const rs = (seq, br, L, turnSeq) => ({ seq, reliable: true, burnRate: br, L_read: L, turnSeq });

test('advanceGateAndBackstop: gate arms after NOTIFY_DWELL=3 consecutive deep-water API calls with cycle', () => {
  const l = freshLedger(KEY);
  // 3 consecutive API calls in deep water, each with 1 cycle crossing
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(l.hasDeepWaterGateFired, false, 'not armed after 1 call');
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(l.hasDeepWaterGateFired, false, 'not armed after 2 calls');
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(l.hasDeepWaterGateFired, true, 'armed after 3 calls (NOTIFY_DWELL=3)');
  assert.equal(l.dwBillsSinceLastAlert, 0, 'dwBills zeroed on gate arm');
});

test('advanceGateAndBackstop: gate does NOT arm without cycle crossing (condition b)', () => {
  const l = freshLedger(KEY);
  // 3 consecutive deep-water calls but zero cycle crossings
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 0, mf: 0.2 });
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 0, mf: 0.2 });
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 0, mf: 0.2 });
  assert.equal(l.hasDeepWaterGateFired, false, 'no cycle → gate stays closed');
  assert.equal(l.deepWaterDwell, 3, 'dwell counted calls');
  assert.equal(l.deepWaterDwellCycled, 0, 'no cycles accumulated');
  // One more call WITH a cycle → now fires (dwell already ≥ 3)
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(l.hasDeepWaterGateFired, true, 'gate fires once cycle arrives');
});

test('advanceGateAndBackstop: shallow-water call resets dwell counter and cycled', () => {
  const l = freshLedger(KEY);
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(l.deepWaterDwell, 2);
  assert.equal(l.deepWaterDwellCycled, 2);
  advanceGateAndBackstop(l, { inDeepWater: false, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(l.deepWaterDwell, 0, 'shallow call resets dwell');
  assert.equal(l.deepWaterDwellCycled, 0, 'shallow call resets cycled');
  assert.equal(l.hasDeepWaterGateFired, false, 'gate not armed');
});

test('advanceGateAndBackstop: multi-cycle single call only counts as 1 dwell', () => {
  const l = freshLedger(KEY);
  // A single call that crosses 3 cycles — still only 1 call toward dwell
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 3, mf: 0.2 });
  assert.equal(l.hasDeepWaterGateFired, false, 'single call cannot arm gate alone');
  assert.equal(l.deepWaterDwell, 1, 'dwell counts calls not cycles');
  assert.equal(l.deepWaterDwellCycled, 3, 'cycles tracked separately');
});

test('advanceGateAndBackstop: backstop accumulates and fires at interval', () => {
  const l = freshLedger(KEY);
  l.hasDeepWaterGateFired = true;
  l.dwBillsSinceLastAlert = 0;
  l.backstopLapCount = 0;
  // backstopIntervalFor(mf=0.2, BR_AMBER=0.10) ≈ ceil(uAtBr(0.2, 0.10)^2) ≈ 7
  const mf = 0.2;
  // Accumulate 6 bills — no fire (interval ≈ 6.85, need ≥ 6.85)
  advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 6, mf });
  assert.equal(l.dwBillsSinceLastAlert, 6);
  assert.equal(l.backstopLapCount, 0, 'not fired below interval');
  // 7th bill fires (6+1=7 ≥ 6.85)
  const { fired } = advanceGateAndBackstop(l, { inDeepWater: true, billCycleIncrement: 1, mf });
  assert.equal(fired, true, 'backstop fires at interval');
  assert.equal(l.dwBillsSinceLastAlert, 0, 'dwBills reset on fire');
  assert.equal(l.backstopLapCount, 1, 'lap count incremented');
});

test('advanceGateAndBackstop: shallow water after gate armed does NOT accumulate', () => {
  const l = freshLedger(KEY);
  l.hasDeepWaterGateFired = true;
  l.dwBillsSinceLastAlert = 5;
  const { fired } = advanceGateAndBackstop(l, { inDeepWater: false, billCycleIncrement: 1, mf: 0.2 });
  assert.equal(fired, false);
  assert.equal(l.dwBillsSinceLastAlert, 5, 'shallow water: no accumulation');
});

test('per-call advance: cycle tick in deep water advances dwBillsSinceLastAlert immediately', () => {
  _resetRateLampManagerForTest();
  const SID = 'sid-percall-depth';
  // Pre-arm the gate so we test backstop accumulation
  const seed = { ...freshLedger(KEY), stateKey: KEY, currentTurnSeq: 1,
    lastAppliedFoldedCallSeq: 0, lastBurnRate: null, hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 0 };
  setLiveLedger(SID, seed);
  // burnRate 2.0 → each call crosses 1 cycle. L_read high enough to be in deep water.
  // With B=250000, cRatio=10, gEma=940: dhat≈0.274, xSweet≈1.274
  // L=450000 → x=1.8 → deep water
  const w = {
    _turnSeq: 1, _foldedCallSeq: 3,
    poll() { return { changed: false, newCalls: 0 }; },
    getStatus() {
      return { segment: 0, model: 'opus',
        rateLamp: { reliable: true, C_RATIO: 10, L_cap: 1000000, L_read: 450000,
          B_post: 250000, B_rebuild: 250000, B_default: 250000, kStable: 940, gEma: 940 } };
    },
    rateLampSamplesSince() {
      return [rs(1, 2.0, 450000, 1), rs(2, 2.0, 460000, 1), rs(3, 2.0, 470000, 1)];
    },
    rateLampSeqSamplesSince() { return []; },
  };
  const { ledger } = advanceRateLampToCurrent(w, SID, { forcePoll: false });
  // Each call at burnRate 2.0 crosses 1 cycle → 3 cycle ticks total in deep water
  assert.ok(ledger.dwBillsSinceLastAlert >= 3, `dwBills advanced per-call: got ${ledger.dwBillsSinceLastAlert}`);
});
