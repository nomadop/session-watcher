import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { G_FLOOR } from '../lib/constants.js';

// g = EMA(max(0, ΔtotalStock − Δ uncapped resident total)): α = ALPHA_EMA, no trend term, |Δg| bounded
// per call by G_DELTA_CAP. Expectations are hand-derived from those two parameters — g scales dhat and u
// for every session, so a silent parameter drift fails here rather than downstream. The Engine is driven
// through its record Interface: with no effect in an interval Δ resident total is zero, so each step's
// ΔtotalStock is the estimator input, and the first step seeds g at G_FLOOR.

const ANCHOR_STOCK = 1000;
// Any interval growth this large exceeds prevG by more than G_DELTA_CAP/ALPHA_EMA, so the cap binds.
const CAP_BINDING_GROWTH = 100_000;

function makeEngine() {
  return createMeasurementEngine({
    resolveModelPolicy: () => ({ cRatio: 10, contextCapacity: 1_000_000 }),
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
}

// Feeds one accepted step per entry of `growths`, each growing total stock by that many tokens, and
// returns g after every step. Stock never falls below the session floor, so no floor guard applies.
function gAfterEachGrowth(growths) {
  const engine = makeEngine();
  let cacheRead = ANCHOR_STOCK;
  let id = 0;
  engine.ingest([{ type: 'step', id: 's' + id, model: 'm', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead, cacheWrite: 0 } }]);
  const out = [];
  for (const growth of growths) {
    cacheRead += growth;
    id += 1;
    engine.ingest([{ type: 'step', id: 's' + id, model: 'm', timestamp: 1,
      usage: { input: 0, output: 0, cacheRead, cacheWrite: 0 } }]);
    out.push(engine.getStatus().g);
  }
  return out;
}

test('g: cold start seeds the estimator at its floor', () => {
  assert.equal(makeEngine().getStatus().g, G_FLOOR);
});

test('g: a step inside the cap moves ALPHA_EMA of the way to the new input', () => {
  // ALPHA_EMA·input + (1 − ALPHA_EMA)·G_FLOOR, a move short of G_DELTA_CAP
  const [g] = gAfterEachGrowth([2000]);
  assert.ok(Math.abs(g - 214) < 1e-9, `expected ≈214, got ${g}`);
});

test('g: a spike beyond the cap advances by exactly the cap', () => {
  // the uncapped level would ask for a jump far past G_DELTA_CAP
  const [g] = gAfterEachGrowth([30_000]);
  assert.equal(g, 350);
});

test('g: the cap is a rate limit, not a ceiling — successive spikes keep climbing', () => {
  assert.deepEqual(gAfterEachGrowth([30_000, 30_000, 30_000]), [350, 600, 850]);
});

test('g: the cap binds downward too', () => {
  // climb until a zero input would ask for a drop larger than G_DELTA_CAP
  const growths = Array.from({ length: 17 }, () => CAP_BINDING_GROWTH);
  growths.push(0);
  const series = gAfterEachGrowth(growths);
  assert.equal(series.at(-2), 4350, 'a run of capped steps starting from the floor');
  // the uncapped level would ask for a drop past G_DELTA_CAP
  assert.equal(series.at(-1), 4100);
});

test('g: a sustained drop converges to the new level without undershooting it', () => {
  const growths = Array.from({ length: 17 }, () => CAP_BINDING_GROWTH);
  for (let i = 0; i < 200; i++) growths.push(500);
  const series = gAfterEachGrowth(growths);
  const tail = series.slice(17);
  const min = Math.min(...tail);
  assert.ok(min >= 500, `g dipped to ${min}, below the input it was tracking`);
  assert.ok(Math.abs(series.at(-1) - 500) < 1, `expected ≈500, got ${series.at(-1)}`);
});

test('g: a lone spike decays back to baseline without dipping below it', () => {
  const growths = [];
  for (let i = 0; i < 50; i++) growths.push(500);
  growths.push(30_000);
  for (let i = 0; i < 300; i++) growths.push(500);
  const series = gAfterEachGrowth(growths);
  const spiked = series[50];
  assert.ok(spiked - series[49] <= 250 + 1e-9, 'the spike itself is rate-limited');
  const tail = series.slice(51);
  const min = Math.min(...tail);
  assert.ok(min >= 500, `g dipped to ${min} after the spike passed`);
  assert.ok(Math.abs(series.at(-1) - 500) < 0.01, `expected ≈500, got ${series.at(-1)}`);
});
