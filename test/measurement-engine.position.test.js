import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeasurementEngine } from '../lib/measurement/engine.js';
import { integratePath } from '../lib/measurement/position.js';
import { computeFullCarryBurnRate } from '../lib/rate-lamp.js';
import { BR_AMBER, computeMovableFrac } from '../lib/bill-regret.js';
import { nucleus } from '../lib/landmarks.js';

// The causal position the Engine stamps on every step, read back through the named reads. Every expectation
// is produced by the pure fold or by a second Engine fed the same records, so nothing here restates the
// fold's algebra.

const R = 10;
const POLICIES = { 'model-a': { cRatio: R, contextCapacity: 1_000_000 } };
function makeEngine({ resolveResourcePolicy } = {}) {
  return createMeasurementEngine({
    resolveModelPolicy: modelId => POLICIES[modelId] ?? { cRatio: 3, contextCapacity: 500_000 },
    resolveResourcePolicy: resolveResourcePolicy ?? (() => ({ selectedByDefault: true, defaultDiscardReason: null })),
  });
}
const usage = (cacheRead) => ({ input: 0, output: 1, cacheRead, cacheWrite: 0 });
const step = (id, cacheRead) => ({ type: 'step', id, model: 'model-a', timestamp: 1, usage: usage(cacheRead) });
const whole = (resourceKey, tokens) => ({
  type: 'effect', access: 'read', overheadTokens: 0, spentTokens: 0,
  impacts: [{ resourceKey, mutation: { kind: 'replace-fragments', fragments: [{ key: 'snapshot', tokens }] } }],
});
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

const steps = (...reads) => reads.map((cacheRead, i) => step(`s${i + 1}`, cacheRead));

// The frames the Engine records, rebuilt from the history: each frame after the first closes one interval
// whose stock growth is the history's own increment. With input and cacheWrite at zero the stock is the
// cacheRead itself, and no resource grew, so the whole increment is excess.
const growthFrames = (history) => history.map((p, i) => ({
  seq: p.foldedSeq, L: p.L, resourceTokens: new Map(),
  growth: i > 0 ? { stock: Math.max(0, p.L - history[i - 1].L), resources: new Map() } : null,
}));

test('stamps equal the pure fold over the recorded growth, whose rate is the running mean of realized excess growth', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000, 2600));
  const history = engine.getHistory();
  const dead = engine.getBucketData().dead;
  const { points, gBar } = integratePath(growthFrames(history), { dead, R, selector: () => true });
  assert.equal(engine.getHandoffMeasurement().measurement.gBar, gBar);
  assert.notEqual(gBar, history.at(-1).g, 'the smoothed g the history exposes is not the fold\'s rate');
  history.forEach((p, i) => {
    assert.equal(p.u, points[i].u); assert.equal(p.pp, points[i].pp);
    assert.equal(p.x, points[i].x); assert.equal(p.bDefault, points[i].bDefault);
  });
  assert.equal(history[0].pp, null);
  assert.equal(engine.getStatus().u, history.at(-1).u);
  assert.equal(engine.getStatus().pp, history.at(-1).pp);
});

test('a closed segment leaves no rate behind: the next segment prices its first interval at zero', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000));
  engine.closeCurrentSegment();
  engine.ingest([step('n1', 1000), step('n2', 1600)]);
  const fresh = engine.getHistory().filter(p => p.segment === engine.getStatus().segment);
  assert.equal(fresh.length, 2);
  assert.equal(fresh[1].u, 0, 'the previous segment\'s realized growth prices nothing here');
  assert.equal(fresh[1].pp, null);
});

test('readRateLampFrame samples carry deltaW and mf; under constant B_S deltaW is the previous trapezoid', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000, 2500));
  const { samples } = engine.readRateLampFrame(0);
  const r = (L) => computeFullCarryBurnRate({ L_read: L, B_post: 1000, B_rebuild: 1000, cRatio: R });
  assert.equal(samples[0].deltaW, null);
  assert.equal(samples[0].mf, null);
  near(samples[1].deltaW, 0.5 * (r(1000) + r(1500)));
  near(samples[3].deltaW, 0.5 * (r(2000) + r(2500)));
  for (const s of samples) assert.equal('burnRate' in s, false);
  // The sample's exchange rate is the interval's own, priced at its left endpoint — here a realized growth of
  // 500 every interval, so the running mean is 500 at every settled frame — not the path-weighted mf the lamp
  // reads, which still carries the zero-rate first interval.
  assert.equal(samples[1].mf, 0);
  near(samples[3].mf, computeMovableFrac(R, 1000, 500));
  assert.notEqual(samples[3].mf, engine.getStatus().mf);
  assert.equal(engine.getStatus().rateLamp.mfLocal, samples[3].mf);
});

test('ΔL = ΔB at a step leaves that step\'s u, pp and deltaW unchanged', () => {
  const plain = makeEngine();
  plain.ingest(steps(1000, 1500, 2000));
  const shifted = makeEngine();
  shifted.ingest(steps(1000, 1500));
  shifted.ingest([whole('/r.js', 500), step('s3', 2500)]);
  const a = plain.getHistory().at(-1), b = shifted.getHistory().at(-1);
  assert.equal(b.u, a.u); assert.equal(b.pp, a.pp);
  assert.equal(b.bDefault, a.bDefault + 500);
  near(shifted.readRateLampFrame(0).samples.at(-1).deltaW, plain.readRateLampFrame(0).samples.at(-1).deltaW);
});

test('the reference reads every point\'s excess at the current baseline: a paired arrival leaves it unchanged in token units', () => {
  const plain = makeEngine();
  plain.ingest(steps(1000, 1500, 2000, 2500, 3000));
  const shifted = makeEngine();
  shifted.ingest(steps(1000, 1500, 2000, 2500));
  shifted.ingest([whole('/r.js', 500), step('s5', 3500)]);
  const a = plain.getStatus().rateLamp, b = shifted.getStatus().rateLamp;
  assert.equal(b.u, a.u);
  assert.equal(b.bDefault, a.bDefault + 500);
  // Every frame holds the same excess in both engines, so the fit differs only by the unit it is read in.
  near(b.reference.d * b.bDefault, a.reference.d * a.bDefault);
  near((b.reference.a - 1) * b.bDefault, (a.reference.a - 1) * a.bDefault);
  for (const key of ['xSweet', 'xBrAmberL', 'xBrAmberR', 'xBrRedR']) near((b[key] - 1) * b.bDefault, (a[key] - 1) * a.bDefault, 1e-6);
  // The arrival moved the last frame's physical x, so a fit over physical coordinates could not have matched.
  assert.notEqual(b.reference.d, a.reference.d);
  assert.ok(b.x_display < a.x_display);
});

test('feeding the same records in more batches leaves every stamp equal', () => {
  const once = makeEngine();
  once.ingest([...steps(1000, 1500), whole('/r.js', 300), step('s3', 2000), step('s4', 2400)]);
  const batched = makeEngine();
  batched.ingest(steps(1000));
  batched.ingest([step('s2', 1500)]);
  batched.ingest([whole('/r.js', 300)]);
  batched.ingest([step('s3', 2000), step('s4', 2400)]);
  assert.deepEqual(batched.getHistory().map(p => [p.u, p.pp, p.x, p.bDefault]), once.getHistory().map(p => [p.u, p.pp, p.x, p.bDefault]));
});

test('a second Engine fed the same records stamps the same values', () => {
  const records = [...steps(1000, 1400), whole('/a.js', 200), step('s3', 1900), whole('/b.js', 700), step('s4', 2800)];
  const one = makeEngine(); one.ingest(records);
  const two = makeEngine(); two.ingest(records);
  assert.deepEqual(one.getHistory(), two.getHistory());
  assert.deepEqual(one.readRateLampFrame(0).samples, two.readRateLampFrame(0).samples);
});

test('status reads the last step: reference, landmarks and provisional arm state come from the fold', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000, 2500, 3000));
  const rl = engine.getStatus().rateLamp;
  assert.equal(rl.reliable, true);
  assert.equal(typeof rl.reference.a, 'number');
  assert.equal(rl.reference.provisional, rl.u < 1);
  for (const key of ['xSweet', 'xBrAmberL', 'xBrAmberR', 'xBrRedR']) assert.ok(Number.isFinite(rl[key]), key);
  assert.equal(rl.uInst, (rl.x_display - 1) / rl.dhat);
  for (const gone of ['burnRate', 'hBreak', 'inDeepWater', 'lBase']) assert.equal(gone in rl, false, gone);
  assert.equal('burnRate' in engine.getStatus(), false);
});

test('dhat and uInst read the fold\'s rate against the fold\'s baseline, not the smoothed g: zero and null until an interval has settled', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000));
  const early = engine.getStatus();
  assert.equal(early.rateLamp.reliable, true);
  assert.equal(early.dhat, 0);
  assert.equal(early.rateLamp.uInst, null);
  engine.ingest([step('s2', 1500), whole('/r.js', 600), step('s3', 2600), step('s4', 3100)]);
  const status = engine.getStatus(), rl = status.rateLamp;
  const { gBar } = engine.getHandoffMeasurement().measurement;
  assert.equal(rl.dhat, nucleus(R, gBar, status.bDefault));
  assert.equal(status.dhat, rl.dhat);
  assert.notEqual(rl.dhat, nucleus(R, rl.gEma, status.bDefault));
  assert.equal(rl.uInst, (rl.x_display - 1) / rl.dhat);
  // Apply moves the rate with the baseline, and dhat follows both.
  engine.replaceResourceOverrides({ '/r.js': 'exclude' });
  const after = engine.getStatus();
  assert.equal(after.rateLamp.dhat, nucleus(R, engine.getHandoffMeasurement().measurement.gBar, after.bDefault));
});

test('a fold with a single distinct u gives no reference and every landmark null while the lamp fields stay set', () => {
  const engine = makeEngine();
  // The first interval carries no realized growth, so the first step past it is the one stamped point with a
  // penalty; the fit needs two.
  engine.ingest(steps(1000, 1500, 2000));
  const rl = engine.getStatus().rateLamp;
  assert.equal(rl.reliable, true);
  assert.equal(rl.reference, null);
  assert.deepEqual([rl.xSweet, rl.xBrAmberL, rl.xBrAmberR, rl.xBrRedR], [null, null, null, null]);
  assert.ok(Number.isFinite(rl.u) && Number.isFinite(rl.pp) && Number.isFinite(rl.mf));
});

// `wallP` is produced by readScenario, not by getStatus: the singularity is a price fact, so it is stated
// from the epoch ratio the view carries rather than from anything the fold accumulated.
test('wallP is 1 + R whatever the fold says', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000));
  assert.equal(engine.getStatus().cRatio, R);
  assert.equal(engine.readScenario({}).wallP, 1 + R);
});

test('the handoff measurement carries the stamped u and pp', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000));
  const m = engine.getHandoffMeasurement().measurement;
  assert.equal(m.u, engine.getStatus().u);
  assert.equal(m.pp, engine.getStatus().pp);
  // The what-if's rate is the one the fold runs on: the segment's realized mean growth, 500 per interval here,
  // beside the smoothed g the reads expose.
  assert.equal(m.gBar, 500);
  assert.notEqual(m.g, m.gBar);
});

test('growth on a resource outside the scenario is excess: excluding it raises the rate and the position, in preview and after Apply', () => {
  const engine = makeEngine();
  // Intervals: 500 of plain growth; 1100 of stock growth of which 600 landed on /r.js; 500 plain.
  engine.ingest([...steps(1000, 1500), whole('/r.js', 600), step('s3', 2600), step('s4', 3100)]);
  const before = engine.getStatus();
  assert.equal(engine.getHandoffMeasurement().measurement.gBar, 500);
  const scenario = engine.readScenario({ '/r.js': 'exclude' });
  assert.equal(scenario.gBar, 700);
  assert.ok(scenario.u > before.u, 'a smaller baseline and a faster rate both advance the excluded scenario');
  engine.replaceResourceOverrides({ '/r.js': 'exclude' });
  assert.equal(engine.getHandoffMeasurement().measurement.gBar, 700);
  assert.equal(engine.getStatus().u, scenario.u);
  // The mirror image: a scenario that INCLUDES a resource the default excludes takes its growth out of the rate.
  const excludedByPolicy = makeEngine({ resolveResourcePolicy: (key) => ({ selectedByDefault: key !== '/r.js', defaultDiscardReason: null }) });
  excludedByPolicy.ingest([...steps(1000, 1500), whole('/r.js', 600), step('s3', 2600), step('s4', 3100)]);
  assert.equal(excludedByPolicy.getHandoffMeasurement().measurement.gBar, 700);
  assert.equal(excludedByPolicy.readScenario({ '/r.js': 'include' }).gBar, 500);
});

test('status stops reading live resident totals: an effect after the last step moves bucket data, not the position', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000));
  const before = engine.getStatus();
  engine.ingest([whole('/late.js', 900)]);
  const after = engine.getStatus();
  assert.equal(after.bDefault, before.bDefault);
  assert.equal(after.x, before.x);
  assert.equal(engine.getBucketData().bDefault, before.bDefault + 900);
});

test('a resource read down to zero leaves the baseline at the next frame', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500));
  const dead = engine.getBucketData().dead;
  engine.ingest([whole('/r.js', 500), step('s3', 2200)]);
  assert.equal(engine.getHistory().at(-1).bDefault, dead + 500);
  engine.ingest([whole('/r.js', 0), step('s4', 2600)]);
  assert.equal(engine.getHistory().at(-1).bDefault, dead);
  assert.equal(engine.getBucketData().bDefault, dead, 'the stamped basis agrees with the live one');
  // The release is credited to the rate: the interval's stock grew by 400 while the selected resource gave
  // back 500, so 900 of excess, beside 500 plain and 200 (700 less the 500 that landed on /r.js).
  assert.equal(engine.getHandoffMeasurement().measurement.gBar, (500 + 200 + 900) / 3);
});

// The known cost of stamping only the steps whose own stock moved the cursor: the live read is the last
// step's stamp, so a stockless tail step takes the read unavailable while the frames behind it stand. Its
// consequences for the rent the frame has not yet drained are recorded as
// UNRELIABLE-TAIL-FORFEITS-UNDRAINED-RENT.
test('a zero-stock step past the anchor takes the live read unavailable and leaves the recorded frames standing', () => {
  const engine = makeEngine();
  engine.ingest(steps(1000, 1500, 2000));
  const before = engine.getHistory();
  engine.ingest([step('z', 0)]);
  const status = engine.getStatus();
  assert.equal(status.rateLamp.reliable, false);
  assert.equal(status.rateLamp.unavailableReason, 'insufficient_data');
  assert.equal(status.B, 0, 'the last step carries no stock of its own');
  assert.deepEqual(engine.getHistory().slice(0, before.length), before, 'the stamps already taken are untouched');
  const { samples } = engine.readRateLampFrame(0);
  for (const s of samples) {
    assert.equal(s.unavailableReason, 'insufficient_data');
    assert.equal('deltaW' in s, false);
  }
});

test('readScenario(O) before replaceResourceOverrides(O) equals the position fields read after it', () => {
  const engine = makeEngine();
  engine.ingest([...steps(1000, 1400), whole('/r.js', 600), step('s3', 2200), step('s4', 2900)]);
  const scenario = engine.readScenario({ '/r.js': 'exclude' });
  assert.equal(scenario.reliable, true);
  assert.deepEqual(scenario.warnings, []);
  engine.replaceResourceOverrides({ '/r.js': 'exclude' });
  const status = engine.getStatus(), rl = status.rateLamp, history = engine.getHistory();
  for (const key of ['u', 'pp', 'mf', 'br', 'bDefault']) assert.equal(scenario[key], status[key], key);
  for (const key of ['xSweet', 'xBrAmberL', 'xBrAmberR', 'xBrRedR']) assert.equal(scenario[key], rl[key], key);
  assert.deepEqual(scenario.reference, rl.reference);
  assert.deepEqual(scenario.trajectory, history.filter(p => p.pp !== null).map(p => ({ seq: p.foldedSeq, x: p.x, u: p.u, pp: p.pp })));
  assert.equal(scenario.wallP, 1 + R);
});

test('readScenario mutates nothing and validates as Apply does', () => {
  const engine = makeEngine();
  const records = [...steps(1000, 1400), whole('/r.js', 600), step('s3', 2200)];
  engine.ingest(records);
  const before = engine.getHistory();
  const scenario = engine.readScenario({ '/r.js': 'maybe', '/nope.js': 'exclude' });
  assert.deepEqual(engine.getHistory(), before);
  assert.deepEqual(scenario.warnings.map(w => w.code).sort(), ['invalid_override_value', 'unknown_resource'].sort());
  assert.equal(scenario.bDefault, before.at(-1).bDefault, 'both entries were ignored');
  // A scenario that pushed the live fold leaves the stamps already taken alone, so re-reading the history
  // cannot see it: the damage surfaces on the next step the live fold prices. The comparison is against an
  // Engine driven by the same records that never previewed.
  engine.ingest([step('s4', 2800)]);
  const neverPreviewed = makeEngine();
  neverPreviewed.ingest([...records, step('s4', 2800)]);
  assert.deepEqual(engine.getHistory(), neverPreviewed.getHistory());
});

test('the next drained sample after Apply carries the re-stamped deltaW and mf', () => {
  const engine = makeEngine();
  engine.ingest([whole('/r.js', 600), ...steps(1000, 1400, 1900)]);
  const before = engine.readRateLampFrame(2).samples[0];
  engine.replaceResourceOverrides({ '/r.js': 'exclude' });
  const after = engine.readRateLampFrame(2).samples[0];
  assert.equal(after.seq, before.seq);
  assert.notEqual(after.deltaW, before.deltaW);
  assert.notEqual(after.mf, before.mf);
});

test('stamping continues after a re-stamp: steps appended after Apply and after a refresh equal an Engine that never re-stamped', () => {
  let selected = true;
  const records = [whole('/r.js', 600), ...steps(1000, 1400, 1900)];
  const more = [step('s4', 2300), whole('/q.js', 200), step('s5', 2900)];
  const position = (engine) => engine.getHistory().map(p => [p.u, p.pp, p.x, p.bDefault]);
  const increments = (engine) => engine.readRateLampFrame(0).samples.map(s => [s.deltaW, s.mf]);

  const restamped = makeEngine({ resolveResourcePolicy: () => ({ selectedByDefault: selected, defaultDiscardReason: null }) });
  restamped.ingest(records);
  restamped.replaceResourceOverrides({ '/r.js': 'exclude' });
  restamped.ingest(more);
  const excludedFromStart = makeEngine({ resolveResourcePolicy: (key) => ({ selectedByDefault: key !== '/r.js', defaultDiscardReason: null }) });
  excludedFromStart.ingest([...records, ...more]);
  assert.deepEqual(position(restamped), position(excludedFromStart));
  assert.deepEqual(increments(restamped), increments(excludedFromStart));

  selected = false;
  assert.equal(restamped.refreshReadPolicies().changed, true);
  restamped.ingest([step('s6', 3400)]);
  const nothingSelected = makeEngine({ resolveResourcePolicy: () => ({ selectedByDefault: false, defaultDiscardReason: null }) });
  nothingSelected.ingest([...records, ...more, step('s6', 3400)]);
  assert.deepEqual(position(restamped), position(nothingSelected));
  assert.deepEqual(increments(restamped), increments(nothingSelected));
});

test('a segment whose epoch policy resolves no ratio keeps its frames and carries no stamp until a refresh resolves one', () => {
  let policy = null;
  const engine = createMeasurementEngine({
    resolveModelPolicy: () => policy,
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
  engine.ingest(steps(1000, 1500, 2000));
  assert.equal(engine.getStatus().rateLamp.reliable, false);
  assert.ok(engine.getHistory().every(p => p.u === null));
  policy = { cRatio: R, contextCapacity: 1_000_000 };
  assert.equal(engine.refreshReadPolicies().changed, true);
  assert.equal(engine.getStatus().rateLamp.reliable, true);
  assert.ok(engine.getHistory().every(p => Number.isFinite(p.u)), 'the frames recorded without a ratio are stamped now');
});

// The direction test/measurement-engine.position.test.js `carries no stamp until a refresh resolves one`
// leaves open, on every entry that re-stamps: a segment the epoch policy never priced still accepts an
// override set, and a segment that had a ratio gives every stamp back when the policy stops resolving one.
// Either way the recorded frames stay and the read goes unreliable rather than keeping stamps the current
// policy cannot produce.
test('an override set under an unresolved ratio stamps nothing; a refresh that loses it clears the stamps; the frames survive both', () => {
  let policy = null;
  const engineOffPolicy = () => createMeasurementEngine({
    resolveModelPolicy: () => policy,
    resolveResourcePolicy: () => ({ selectedByDefault: true, defaultDiscardReason: null }),
  });
  const stepRecords = steps(1000, 1500, 2000);
  const records = [whole('/r.js', 600), ...stepRecords];

  const unresolved = engineOffPolicy();
  unresolved.ingest(records);
  assert.equal(unresolved.replaceResourceOverrides({ '/r.js': 'exclude' }).changed, true);
  assert.equal(unresolved.getHistory().length, stepRecords.length);
  assert.ok(unresolved.getHistory().every(p => p.u === null));

  policy = { cRatio: R, contextCapacity: 1_000_000 };
  const resolved = engineOffPolicy();
  resolved.ingest(records);
  assert.ok(resolved.getHistory().every(p => Number.isFinite(p.u)), 'the ratio in force stamped every frame');
  policy = null;
  assert.equal(resolved.refreshReadPolicies().changed, true);
  assert.equal(resolved.getStatus().rateLamp.reliable, false);
  assert.equal(resolved.getHistory().length, stepRecords.length);
  assert.ok(resolved.getHistory().every(p => p.u === null));
});

test('readScenario while unreliable is { reliable: false }', () => {
  const engine = makeEngine();
  assert.deepEqual(engine.readScenario({}), { reliable: false });
});

test('replaceResourceOverrides re-stamps every step of the segment; the first frame stays u = 0', () => {
  const engine = makeEngine();
  engine.ingest([whole('/r.js', 600), ...steps(1000, 1400, 1900)]);
  const before = engine.getHistory();
  engine.replaceResourceOverrides({ '/r.js': 'exclude' });
  const after = engine.getHistory();
  assert.equal(after[0].u, 0);
  assert.ok(after[2].u > before[2].u, 'a smaller baseline speeds every interval');
  assert.equal(after[1].bDefault, before[1].bDefault - 600);
});

test('refreshReadPolicies re-stamps under the new resource policy', () => {
  let selected = true;
  const engine = makeEngine({ resolveResourcePolicy: () => ({ selectedByDefault: selected, defaultDiscardReason: null }) });
  engine.ingest([whole('/r.js', 600), ...steps(1000, 1400, 1900)]);
  const before = engine.getHistory();
  selected = false;
  assert.equal(engine.refreshReadPolicies().changed, true);
  assert.equal(engine.getHistory()[1].bDefault, before[1].bDefault - 600);
});

test('provisional is u_T < 1 on both sides of the sweet spot', () => {
  const short = makeEngine();
  short.ingest(steps(1000, 1100, 1200, 1300));
  const early = short.getStatus().rateLamp;
  assert.ok(early.u < 1);
  assert.equal(early.reference.provisional, true);
  const long = makeEngine();
  long.ingest(steps(...Array.from({ length: 40 }, (_, i) => 1000 + i * 400)));
  const rl = long.getStatus().rateLamp;
  assert.ok(rl.u > 1, 'the trajectory passed the sweet spot');
  assert.equal(rl.reference.provisional, false);
});

test('segment close folds the stamps: exit values, peaks and the first amber turn', () => {
  const engine = makeEngine();
  // A closed segment ahead of the measured one and one turn per step are what make the amber turn
  // observable: on a fresh Engine every step shares the same turn and the segment starts at the Engine's
  // own turn origin, so the first crossing, the last crossing and the Engine's absolute turn all read
  // alike. The turns the closed segment reports are where this segment's turns start counting.
  const { closedSegments: [warm] } = engine.ingest([step('w', 800), { type: 'epoch' }]);
  engine.ingest(Array.from({ length: 30 }, (_, i) => 1000 + i * 500)
    .flatMap((cacheRead, i) => [{ type: 'turn-boundary' }, step(`s${i + 1}`, cacheRead)]));
  const dead = engine.getBucketData().dead;
  const status = engine.getStatus();
  const { closedSegments: [closed] } = engine.closeCurrentSegment();
  const history = engine.getHistory().filter(p => p.segment === closed.segment);
  const last = history.at(-1);
  // History exposes each step's stamped pp but not its br, so the per-step br comes from the same pure fold
  // over the same frames test/measurement-engine.position.test.js `stamps equal the pure fold` reads back.
  const { points } = integratePath(growthFrames(history), { dead, R, selector: () => true });
  const firstAmber = points.findIndex(p => p.u >= 1 && p.br !== null && p.br >= BR_AMBER);
  assert.ok(firstAmber !== -1, 'the trajectory crossed amber on the right arm');
  assert.equal(closed.metrics.ppExit, last.pp);
  assert.equal(closed.metrics.brExit, status.br);
  assert.equal(closed.metrics.mf, status.mf);
  assert.equal(closed.metrics.ppPeak, Math.max(...history.filter(p => p.pp !== null).map(p => p.pp)));
  assert.equal(closed.metrics.brPeak, Math.max(...points.filter(p => p.br !== null).map(p => p.br)));
  assert.equal(closed.metrics.turnAtBrAmber, history[firstAmber].turnSeq - warm.metrics.turns);
  assert.equal(closed.metrics.lPeak, 1000 + 29 * 500);
});

// Before the anchor a zero-stock step records nothing, because the settlement cursor does not exist yet.
// Past the anchor the cursor is never null again, so such a step used to record and stamp a frame against a
// cursor its own stock never moved — closing an interval no settlement backed, and stamping itself at x = 0.
// `settle` still runs for such a step, so the smoothed `g` it reports moves; what this pins is the fold.
test('a zero-stock step past the anchor closes no interval: the fold is what it would be without the step', () => {
  const engine = makeEngine();
  engine.ingest([step('s1', 1000), step('s2', 1500), step('z', 0), step('s3', 2000)]);
  const control = makeEngine();
  control.ingest(steps(1000, 1500, 2000));
  const stamped = (history) => history.filter(p => p.u !== null).map(p => [p.u, p.pp, p.x, p.bDefault]);
  const history = engine.getHistory();
  assert.deepEqual(stamped(history), stamped(control.getHistory()));
  assert.equal(history.find(p => p.foldedSeq === 3).u, null, 'the zero-stock step carries no stamp of its own');
  assert.equal(engine.getStatus().u, control.getStatus().u);
});

test('a segment closed before any stamp reports the zero peaks and null exits it reports today', () => {
  const engine = makeEngine();
  engine.ingest([step('z', 0)]);
  const { closedSegments: [closed] } = engine.closeCurrentSegment();
  assert.equal(closed.metrics.ppExit, null);
  assert.equal(closed.metrics.brExit, null);
  assert.equal(closed.metrics.brPeak, 0);
  assert.equal(closed.metrics.ppPeak, 0);
  assert.equal(closed.metrics.turnAtBrAmber, null);
});
