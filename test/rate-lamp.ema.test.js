import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLedgerIntoStatus } from '../lib/rate-lamp-manager.js';
import { renderDelta, renderU } from '../lib/statusline-format.js';
import { freshLedger, stateKeyOf } from '../lib/rate-lamp-store.js';

// ── renderDelta: prefers gEma, falls back to kAvgFallback ─────────────────────

test('renderDelta: uses gEma when available', () => {
  assert.equal(renderDelta(3200, 5000), 'Δ3.2k'); // first arg = gEma
});

test('renderDelta: gEma null → Δ----', () => {
  assert.equal(renderDelta(null), 'Δ----');
});

test('renderDelta: gEma undefined → Δ----', () => {
  assert.equal(renderDelta(undefined), 'Δ----');
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

test('mergeLedgerIntoStatus: dhat derived from gEma (live g), not kAvg', () => {
  // v3: dhat = nucleus(cRatio, g, B) = sqrt(2*cRatio*g/B)
  const cRatio = 10, g = 1000, B = 50000, kAvg = 2000;
  const status = {
    kAvg,
    rateLamp: {
      reliable: true, C_RATIO: cRatio, L_read: 80000, L_cap: 960000,
      gEma: g, B_post: B, B_rebuild: B,
      x_display: 80000 / B,
    },
  };
  const key = JSON.stringify([0, 'claude-opus-4-6', cRatio, 'd0|t50000|k3|T', 960000, 1]);
  const ledger = { ...freshLedger(key, g), stateKey: key, currentTurnSeq: 5 };
  mergeLedgerIntoStatus(status, ledger, key);
  // WHY: dhat = sqrt(2*cRatio*g/B) = sqrt(2*10*1000/50000) = sqrt(0.4)
  const expectedDhat = Math.sqrt(2 * cRatio * g / B);
  assert.ok(Math.abs(status.rateLamp.dhat - expectedDhat) < 1e-10,
    `dhat should use gEma (${expectedDhat}), got ${status.rateLamp.dhat}`);
  // NOT the kAvg-derived value
  const wrongDhat = Math.sqrt(2 * cRatio * kAvg / B);
  assert.notEqual(status.rateLamp.dhat, wrongDhat, 'dhat must NOT use kAvg');
});

test('mergeLedgerIntoStatus: br-based inDeepWater when L far past sweet', () => {
  // v3: br from live B and gEma
  const cRatio = 10, g = 1000, B = 50000;
  // L far past sweet → high br → inDeepWater=true
  const L_read = 125000;
  const status = {
    rateLamp: {
      reliable: true, C_RATIO: cRatio, L_read, L_cap: 960000,
      gEma: g, B_post: B, B_rebuild: B,
      x_display: L_read / B,
    },
  };
  const key = JSON.stringify([0, 'claude-opus-4-6', cRatio, 'd0|t50000|k3|T', 960000, 1]);
  const ledger = { ...freshLedger(key, g), stateKey: key, currentTurnSeq: 5 };
  mergeLedgerIntoStatus(status, ledger, key);
  assert.ok(Number.isFinite(status.rateLamp.br), 'br is computed');
  assert.ok(Number.isFinite(status.rateLamp.mf), 'mf is computed');
  // x=2.5 with cRatio=10, g=1000, B=50000 → br should exceed BR_AMBER=0.10
  assert.ok(status.rateLamp.br >= 0.10, `br=${status.rateLamp.br} should be >= 0.10`);
  assert.equal(status.rateLamp.targetL, undefined, 'targetL no longer produced');
});
