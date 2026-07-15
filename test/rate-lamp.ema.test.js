import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePerCallEma, mergeLedgerIntoStatus } from '../lib/rate-lamp-manager.js';
import { renderDelta, renderU } from '../lib/statusline-format.js';
import { freshLedger, stateKeyOf } from '../lib/rate-lamp-store.js';

// ── updatePerCallEma: per-call EMA (alpha=0.5) ───────────────────────────────

test('per-call EMA: first call seeds prevL, returns null (no delta yet)', () => {
  const state = { prevL: null, ema: null, callsSinceAnchor: 0 };
  const result = updatePerCallEma(state, { L: 50000 });
  assert.equal(result, null, 'no EMA on first call (only seed)');
  assert.equal(state.prevL, 50000);
  assert.equal(state.callsSinceAnchor, 1);
});

test('per-call EMA: second call computes first raw delta as initial EMA', () => {
  const state = { prevL: 50000, ema: null, callsSinceAnchor: 1 };
  const result = updatePerCallEma(state, { L: 53000 });
  assert.equal(result, 3000, 'first delta = raw delta (no prior EMA)');
  assert.equal(state.ema, 3000);
  assert.equal(state.prevL, 53000);
  assert.equal(state.callsSinceAnchor, 2);
});

test('per-call EMA: third call applies alpha=0.5', () => {
  const state = { prevL: 53000, ema: 3000, callsSinceAnchor: 2 };
  const result = updatePerCallEma(state, { L: 57000 });
  // delta = 4000, ema = 0.5*4000 + 0.5*3000 = 3500
  assert.equal(result, 3500);
  assert.equal(state.ema, 3500);
});

test('per-call EMA: negative delta clamped to 0', () => {
  const state = { prevL: 57000, ema: 3500, callsSinceAnchor: 3 };
  const result = updatePerCallEma(state, { L: 55000 });
  // delta = -2000 → clamped to 0, ema = 0.5*0 + 0.5*3500 = 1750
  assert.equal(result, 1750);
  assert.equal(state.ema, 1750);
  assert.equal(state.prevL, 55000, 'prevL still advances on negative delta');
});

test('per-call EMA: same L (no growth) decays EMA', () => {
  const state = { prevL: 55000, ema: 1750, callsSinceAnchor: 4 };
  const result = updatePerCallEma(state, { L: 55000 });
  // delta = 0, ema = 0.5*0 + 0.5*1750 = 875
  assert.equal(result, 875);
});

test('per-call EMA: bootstrap returns honest EMA value (caller uses fallback)', () => {
  const state = { prevL: 50000, ema: null, callsSinceAnchor: 1 };
  const result = updatePerCallEma(state, { L: 50000 });
  // same L → delta=0, ema set to 0 (first delta = initial EMA)
  assert.equal(result, 0, 'honest EMA value even during bootstrap');
  assert.equal(state.callsSinceAnchor, 2);
});

test('per-call EMA: non-finite L returns current ema unchanged', () => {
  const state = { prevL: 50000, ema: 3000, callsSinceAnchor: 3 };
  const result = updatePerCallEma(state, { L: NaN });
  assert.equal(result, 3000, 'returns existing ema when L is non-finite');
  assert.equal(state.prevL, 50000, 'prevL unchanged');
});

// ── renderDelta: prefers gEma, falls back to kAvgFallback ─────────────────────

test('renderDelta: uses gEma when available', () => {
  assert.equal(renderDelta(3200, 5000), 'Δ3.2k'); // first arg = gEma
});

test('renderDelta: gEma null → falls back to kAvg', () => {
  assert.equal(renderDelta(null, 5000), 'Δ5.0k');
});

test('renderDelta: gEma undefined → falls back to kAvg', () => {
  assert.equal(renderDelta(undefined, 3200), 'Δ3.2k');
});

test('renderDelta: both null → Δ----', () => {
  assert.equal(renderDelta(null, null), 'Δ----');
  assert.equal(renderDelta(undefined, undefined), 'Δ----');
});

test('renderDelta: kAvg < 1000 → integer, right-padded', () => {
  assert.equal(renderDelta(800, 500), 'Δ800 ');
});

test('renderDelta: kAvg >= 100000 → Nk format', () => {
  assert.equal(renderDelta(120000, 5000), 'Δ120k');
});

// ── Task 3: u-display aligned to frozen kStable (lamp↔u consistency) ─────────

test('u=2 exactly at xExit when dhat derived from kStable', () => {
  // Setup: cRatio=10, kStable=1000, lBase=50000
  // xExit = 1 + 2*sqrt(2*10*1000/50000) = 1 + 2*sqrt(0.4) = 1 + 2*0.6325 = 2.265
  // dhat_frozen = sqrt(2*cRatio*kStable/lBase) = sqrt(0.4) = 0.6325
  // At x = xExit: u = (xExit - 1) / dhat = (2.265 - 1) / 0.6325 = 2.0
  const cRatio = 10, kStable = 1000, lBase = 50000;
  const dhat = Math.sqrt(2 * cRatio * kStable / lBase);
  const xExit = 1 + 2 * dhat; // EXIT_NUCLEUS = 2
  const u = (xExit - 1) / dhat;
  assert.ok(Math.abs(u - 2.0) < 1e-10, `u at xExit must be exactly 2.0, got ${u}`);
});

test('renderU at xExit shows u2.0 when dhat uses kStable', () => {
  const cRatio = 10, kStable = 1000, lBase = 50000;
  const dhat = Math.sqrt(2 * cRatio * kStable / lBase);
  const xExit = 1 + 2 * dhat;
  const rl = { x_display: xExit, dhat };
  const result = renderU(rl);
  assert.equal(result, 'u2.0');
});

test('mergeLedgerIntoStatus: dhat derived from kStable, not kAvg', () => {
  const cRatio = 10, kStable = 1000, lBase = 50000, kAvg = 2000;
  const status = {
    kAvg,
    baseline: { total: lBase },
    rateLamp: {
      reliable: true, C_RATIO: cRatio, L_read: 80000, L_cap: 960000,
      kStable, kStableReliable: true, B_post: lBase, B_rebuild: lBase,
      x_display: 80000 / lBase,
    },
  };
  const key = JSON.stringify([0, 'claude-opus-4-6', cRatio, 'd0|t50000|k3|T', 960000, 1]);
  const ledger = { ...freshLedger(key, kStable), stateKey: key, kStableFrozen: kStable, currentTurnSeq: 5 };
  mergeLedgerIntoStatus(status, ledger, key);
  // dhat should be sqrt(2*cRatio*kStable/lBase) = sqrt(2*10*1000/50000) = sqrt(0.4)
  const expectedDhat = Math.sqrt(2 * cRatio * kStable / lBase);
  assert.ok(Math.abs(status.rateLamp.dhat - expectedDhat) < 1e-10,
    `dhat should use kStable (${expectedDhat}), got ${status.rateLamp.dhat}`);
  // NOT the kAvg-derived value
  const wrongDhat = Math.sqrt(2 * cRatio * kAvg / lBase);
  assert.notEqual(status.rateLamp.dhat, wrongDhat, 'dhat must NOT use kAvg');
});

test('mergeLedgerIntoStatus: br-based inDeepWater when L far past sweet', () => {
  const cRatio = 10, kStable = 1000, lBase = 50000, kAvg = 2000;
  // L far past sweet → high br → inDeepWater=true
  const L_read = 125000;
  const lCap = 960000;
  const status = {
    kAvg,
    baseline: { total: lBase },
    rateLamp: {
      reliable: true, C_RATIO: cRatio, L_read, L_cap: lCap,
      kStable, kStableReliable: true, B_post: lBase, B_rebuild: lBase,
      x_display: L_read / lBase,
    },
  };
  const key = JSON.stringify([0, 'claude-opus-4-6', cRatio, 'd0|t50000|k3|T', lCap, 1]);
  const ledger = { ...freshLedger(key, kStable), stateKey: key, kStableFrozen: kStable, currentTurnSeq: 5 };
  mergeLedgerIntoStatus(status, ledger, key);
  assert.ok(Number.isFinite(status.rateLamp.br), 'br is computed');
  assert.ok(Number.isFinite(status.rateLamp.mf), 'mf is computed');
  // x=2.5 with cRatio=10, kStable=1000, lBase=50000 → br should exceed BR_AMBER=0.10
  assert.ok(status.rateLamp.br >= 0.10, `br=${status.rateLamp.br} should be >= 0.10`);
  assert.equal(status.rateLamp.inDeepWater, true, 'inDeepWater=true when br >= BR_AMBER');
  assert.equal(status.rateLamp.targetL, undefined, 'targetL no longer produced');
});
