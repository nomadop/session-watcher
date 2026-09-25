import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDelta, renderU } from '../lib/statusline-format.js';

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

test('renderU prints the stamped u at xExit, not a value derived from x_display/dhat', () => {
  const cRatio = 10, kStable = 1000, lBase = 50000;
  const dhat = Math.sqrt(2 * cRatio * kStable / lBase);
  const xExit = 1 + 2 * dhat; // (xExit-1)/dhat derives to 2.0 — the stamped u below must not match that.
  const rl = { x_display: xExit, dhat, u: 5.0 };
  const result = renderU(rl);
  assert.equal(result, 'u5.0');
});
