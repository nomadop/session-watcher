import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emaStep } from '../lib/measure.js';

// g = EMA(max(0, ΔtotalStock − ΔB)): α = 0.06, no trend term, |Δg| bounded per call by G_DELTA_CAP.
// Expectations are hand-derived from those parameters — g scales dhat and u for every session, so a
// silent parameter drift fails here rather than downstream.

test('g: a step inside the cap moves 6% of the way to the new input', () => {
  // 0.06·2000 + 0.94·1000 = 1060 → |Δg| = 60, cap does not bind
  assert.equal(emaStep(1000, 2000), 1060);
});

test('g: a spike beyond the cap advances by exactly the cap', () => {
  // uncapped step would be 0.06·30000 + 0.94·500 = 2270, i.e. Δg = +1770
  assert.equal(emaStep(500, 30000), 750);
});

test('g: the cap is a rate limit, not a ceiling — successive spikes keep climbing', () => {
  const seq = [];
  let g = 500;
  for (let i = 0; i < 3; i++) { g = emaStep(g, 30000); seq.push(g); }
  assert.deepEqual(seq, [750, 1000, 1250]);
});

test('g: the cap binds downward too', () => {
  // uncapped step would be 0.06·0 + 0.94·5000 = 4700, i.e. Δg = −300
  assert.equal(emaStep(5000, 0), 4750);
});

test('g: a sustained drop converges to the new level without undershooting it', () => {
  let g = 5000, min = Infinity;
  for (let i = 0; i < 200; i++) { g = emaStep(g, 500); min = Math.min(min, g); }
  assert.ok(min >= 500, `g dipped to ${min}, below the input it was tracking`);
  assert.ok(Math.abs(g - 500) < 1, `expected ≈500, got ${g}`);
});

test('g: a lone spike decays back to baseline without dipping below it', () => {
  let g = 500;
  for (let i = 0; i < 50; i++) g = emaStep(g, 500);
  g = emaStep(g, 30000);
  assert.equal(g, 750, 'the spike itself is rate-limited');
  let min = Infinity;
  for (let i = 0; i < 300; i++) { g = emaStep(g, 500); min = Math.min(min, g); }
  assert.ok(min >= 500, `g dipped to ${min} after the spike passed`);
  assert.ok(Math.abs(g - 500) < 0.01, `expected ≈500, got ${g}`);
});
