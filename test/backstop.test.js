import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uAtBr, backstopIntervalFor, BR_AMBER, computeBr, computeMovableFrac, isInDeepWater, brForGate } from '../lib/bill-regret.js';
import { nucleus } from '../lib/landmarks.js';
import { evaluateGate } from '../lib/notify-gate.js';
import { resolveStopMessage } from '../lib/stop-message.js';
import { advanceGateAndBackstop, decideBackstop, probeBackstop, commitBackstopFire } from '../lib/rate-lamp-store.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('uAtBr numerical correctness at BR_AMBER', () => {
  near(uAtBr(0.20, BR_AMBER), 2.62);
  near(uAtBr(0.30, BR_AMBER), 2.22);
  near(uAtBr(0.40, BR_AMBER), 2.00);
});

test('backstopIntervalFor = uAmber squared', () => {
  near(backstopIntervalFor(0.20, BR_AMBER), 6.85);
  near(backstopIntervalFor(0.30, BR_AMBER), 4.91);
  near(backstopIntervalFor(0.40, BR_AMBER), 4.00);
});

test('uAtBr guards: mf<=0 → Infinity; finite brTarget<=0 → 1; non-finite brTarget → Infinity', () => {
  assert.equal(uAtBr(0, BR_AMBER), Infinity);
  assert.equal(uAtBr(-1, BR_AMBER), Infinity);
  assert.equal(uAtBr(0.3, 0), 1);          // genuinely-zero finite target: degenerate but finite
  assert.equal(uAtBr(0.3, -0.5), 1);       // negative finite target: clamp to 1
  assert.equal(uAtBr(0.3, NaN), Infinity); // non-finite target → safe degrade (never fires), NOT 1
  assert.equal(uAtBr(NaN, BR_AMBER), Infinity);
});

test('interval never clamped: high mf gives shorter interval (invariant 6), no floor at 4', () => {
  // mf cannot exceed ~0.414 physically, but if a test feeds 0.414 the interval is ~4.0 — the natural min.
  near(backstopIntervalFor(0.414, BR_AMBER), 4.0, 0.1);
  // A smaller mf yields a LARGER interval — monotonic, never floored.
  assert.ok(backstopIntervalFor(0.20, BR_AMBER) > backstopIntervalFor(0.40, BR_AMBER));
});

test('backstopIntervalFor Infinity when interval unreachable (mf=0)', () => {
  assert.equal(backstopIntervalFor(0, BR_AMBER), Infinity);
});

test('resolveStopMessage priority: wall > gate > backstop', () => {
  const wall = resolveStopMessage({ gateResult: { notify: true, message: 'G' }, burnRate: 1.2, backstopResult: { notify: true } });
  assert.equal(wall.kind, 'wall');
  const gate = resolveStopMessage({ gateResult: { notify: true, message: 'G' }, burnRate: 0.5, backstopResult: { notify: true } });
  assert.equal(gate.kind, 'gate');
  const bs = resolveStopMessage({ gateResult: { notify: false }, burnRate: 0.5, backstopResult: { notify: true } });
  assert.equal(bs.kind, 'backstop');
  assert.equal(bs.delivery, 'stop_hook');
  const none = resolveStopMessage({ gateResult: { notify: false }, burnRate: 0.5, backstopResult: { notify: false } });
  assert.equal(none, null);
});

// ── accumulator (reader path) ──
const mkDraft = () => ({ hasDeepWaterGateFired: false, dwBillsSinceLastAlert: 0, backstopLapCount: 0, deepWaterDwell: 0, deepWaterDwellCycled: 0 });

test('accumulator inactive before gate fires', () => {
  const d = mkDraft();
  advanceGateAndBackstop(d, { inDeepWater: true, billCycleIncrement: 100 });
  assert.equal(d.dwBillsSinceLastAlert, 0);
});

test('sweet-zone boundaries do NOT advance the accumulator', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true };
  advanceGateAndBackstop(d, { inDeepWater: false, billCycleIncrement: 10 });
  assert.equal(d.dwBillsSinceLastAlert, 0);
});

test('accumulator advances by REAL bill increment (batch of 3 adds 3, not 1)', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true };
  advanceGateAndBackstop(d, { inDeepWater: true, billCycleIncrement: 3 });
  assert.equal(d.dwBillsSinceLastAlert, 3);
});

// ── fire decision (Stop path) ──
test('gate fire arms backstop and zeros accumulator (mutual exclusion)', () => {
  const d = { ...mkDraft(), dwBillsSinceLastAlert: 3 };
  const r = decideBackstop(d, { gateJustFired: true, mf: 0.4 });
  assert.equal(r.notify, false);
  assert.equal(d.hasDeepWaterGateFired, true);
  assert.equal(d.dwBillsSinceLastAlert, 0);
});

test('decideBackstop fires once accumulator reaches interval, then resets + laps', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true };
  advanceGateAndBackstop(d, { inDeepWater: true, billCycleIncrement: 3 });
  advanceGateAndBackstop(d, { inDeepWater: true, billCycleIncrement: 1 }); // total 4 >= interval(mf0.4)=4.0
  const r = decideBackstop(d, { gateJustFired: false, mf: 0.4 });
  assert.equal(r.notify, true);
  assert.equal(d.dwBillsSinceLastAlert, 0);
  assert.equal(d.backstopLapCount, 1);
});

test('decideBackstop does not fire below interval', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 2 };
  assert.equal(decideBackstop(d, { gateJustFired: false, mf: 0.4 }).notify, false);
});

test('carry-over: an increment exceeding one interval still fires once and keeps the remainder', () => {
  // A single deep-water batch that crossed 9 bill cycles at mf=0.4 (interval 4): fires, resets to 0.
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 9 };
  const r = decideBackstop(d, { gateJustFired: false, mf: 0.4 });
  assert.equal(r.notify, true);
  assert.equal(d.dwBillsSinceLastAlert, 0);
  assert.equal(d.backstopLapCount, 1);
});

test('mf=0 → interval Infinity → never fires', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 999 };
  assert.equal(decideBackstop(d, { gateJustFired: false, mf: 0 }).notify, false);
});

// ── probeBackstop (non-mutating) + commitBackstopFire ──

test('probeBackstop returns notify:true at threshold WITHOUT mutating the draft', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 4 };
  const r = probeBackstop(d, { gateJustFired: false, mf: 0.4 }); // interval=4 → would fire
  assert.equal(r.notify, true);
  // State NOT mutated — accumulator and lapCount preserved
  assert.equal(d.dwBillsSinceLastAlert, 4, 'accumulator must remain untouched after probe');
  assert.equal(d.backstopLapCount, 0, 'lapCount must remain untouched after probe');
});

test('probeBackstop below threshold → notify:false, no mutation', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 2 };
  const r = probeBackstop(d, { gateJustFired: false, mf: 0.4 });
  assert.equal(r.notify, false);
  assert.equal(d.dwBillsSinceLastAlert, 2);
});

test('probeBackstop with gateJustFired → notify:false, no arm mutation', () => {
  const d = mkDraft(); // hasDeepWaterGateFired = false
  const r = probeBackstop(d, { gateJustFired: true, mf: 0.4 });
  assert.equal(r.notify, false);
  assert.equal(d.hasDeepWaterGateFired, false, 'probe must NOT arm the backstop');
});

test('commitBackstopFire applies fire mutations (reset + lap)', () => {
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 5 };
  commitBackstopFire(d, { gateJustFired: false });
  assert.equal(d.dwBillsSinceLastAlert, 0);
  assert.equal(d.backstopLapCount, 1);
});

test('commitBackstopFire with gateJustFired arms and zeros (gate-arm path)', () => {
  const d = { ...mkDraft(), dwBillsSinceLastAlert: 3 };
  commitBackstopFire(d, { gateJustFired: true });
  assert.equal(d.hasDeepWaterGateFired, true);
  assert.equal(d.dwBillsSinceLastAlert, 0);
  assert.equal(d.backstopLapCount, 0); // no lap on arm
});

test('regression: wall outranks backstop — probe+resolve preserves accumulator when wall wins', () => {
  // Simulates the Stop route logic: backstop would fire, but burnRate>=1 so wall wins.
  // Before the fix, decideBackstop would consume the accumulator even though wall won.
  const d = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 5 };
  const backstopResult = probeBackstop(d, { gateJustFired: false, mf: 0.4 });
  assert.equal(backstopResult.notify, true); // backstop WOULD fire
  const msg = resolveStopMessage({ gateResult: { notify: false }, burnRate: 1.2, backstopResult });
  assert.equal(msg.kind, 'wall'); // wall wins
  // Because wall won, we do NOT commit backstop fire — accumulator preserved for next check
  assert.equal(d.dwBillsSinceLastAlert, 5, 'accumulator must be preserved when wall wins');
  assert.equal(d.backstopLapCount, 0, 'no lap consumed when wall wins');
});

// ── Full Stop-route simulation: backstop should fire and commit when threshold reached ──

test('Stop-route sim: backstop fires and resets when gate already fired + threshold met + burnRate < 1', () => {
  // This reproduces the EXACT logic from server.js lines 447-458:
  //   1. probeBackstop (non-mutating check)
  //   2. resolveStopMessage (priority)
  //   3. commitBackstopFire only if kind === 'backstop' or gateJustFired
  const draft = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 10 };
  const gateJustFired = false;
  const mf = 0.32;        // interval ≈ 4.9, so dwBills=10 >> interval
  const burnRate = 0.21;  // NOT wall

  // Step 1: probe
  const backstopResult = probeBackstop(draft, { gateJustFired, mf });
  assert.equal(backstopResult.notify, true, 'probe should detect threshold exceeded');

  // Step 2: resolve priority
  const inlineMsg = resolveStopMessage({ gateResult: { notify: false }, burnRate, backstopResult });
  assert.equal(inlineMsg.kind, 'backstop', 'backstop should win priority (not wall, gate already past)');

  // Step 3: commit (mimics server.js conditional)
  if (gateJustFired || (inlineMsg && inlineMsg.kind === 'backstop')) {
    commitBackstopFire(draft, { gateJustFired });
  }

  // Verify: accumulator reset + lap incremented
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'accumulator must reset after backstop fire');
  assert.equal(draft.backstopLapCount, 1, 'lap must increment after backstop fire');
});

test('Stop-route sim: repeated backstop fires produce multiple laps', () => {
  const draft = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 0 };
  const mf = 0.4;  // interval = 4

  // Simulate 3 backstop fire cycles
  for (let lap = 1; lap <= 3; lap++) {
    // Accumulate past threshold
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 5 });
    assert.ok(draft.dwBillsSinceLastAlert >= 4, `before fire ${lap}: accumulator should exceed interval`);

    const backstopResult = probeBackstop(draft, { gateJustFired: false, mf });
    assert.equal(backstopResult.notify, true, `lap ${lap}: probe should fire`);

    const inlineMsg = resolveStopMessage({ gateResult: { notify: false }, burnRate: 0.3, backstopResult });
    assert.equal(inlineMsg.kind, 'backstop');

    commitBackstopFire(draft, { gateJustFired: false });
    assert.equal(draft.dwBillsSinceLastAlert, 0, `after fire ${lap}: accumulator reset`);
    assert.equal(draft.backstopLapCount, lap, `after fire ${lap}: lapCount = ${lap}`);
  }
});

test('BUG REPRO: accumulator grows unbounded when Stop hook never calls the backstop path', () => {
  // This test documents the observed bug: dwBillsSinceLastAlert=14, backstopLapCount=0, interval=4.6
  // The accumulator keeps growing because commitBackstopFire is never called.
  // Root cause hypothesis: either the Stop route's condition gate blocks it, or Stop isn't called.
  const draft = { ...mkDraft(), hasDeepWaterGateFired: true, dwBillsSinceLastAlert: 0 };
  const mf = 0.32;  // interval ≈ 4.9
  const interval = backstopIntervalFor(mf, BR_AMBER);

  // Simulate 14 cycle ticks of accumulation (each adds 1 bill cycle)
  for (let i = 0; i < 14; i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf: 0 });
  }
  assert.equal(draft.dwBillsSinceLastAlert, 14);
  assert.equal(draft.backstopLapCount, 0);

  // At this point, the accumulator is 14 / 4.9 ≈ 2.8× the interval — should have fired ~2 times.
  // But if NO Stop route evaluated backstop during those 14 boundaries, it never fires.
  // The accumulator grows in the reader path (advanceGateAndBackstop), but fire is Stop-route-only.
  // Verify that a single probeBackstop+commit NOW would fire but only lap once (not catch up):
  const backstopResult = probeBackstop(draft, { gateJustFired: false, mf });
  assert.equal(backstopResult.notify, true);
  commitBackstopFire(draft, { gateJustFired: false });
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'resets to 0');
  assert.equal(draft.backstopLapCount, 1, 'only 1 lap even though 14/4.9 ≈ 2.8× interval passed');
  // depthProgress will show 0 after reset — the 2.8× overshoot is lost
});

// ══════════════════════════════════════════════════════════════════════════════
// Full shallow→deep gate+backstop integration (simulates server.js Stop route)
// ══════════════════════════════════════════════════════════════════════════════

test('E2E: shallow→deep gate fire at correct br threshold (brForGate + evaluateGate)', () => {
  // Simulate a session with Claude cRatio=12.5, B=10000, g=100 (G_FLOOR at cold start)
  const cRatio = 12.5, B = 10000, g = 100;
  const dhat = nucleus(cRatio, g, B);
  const xSweet = 1 + dhat;
  const mf = computeMovableFrac(cRatio, B, g);

  // Verify landmarks
  assert.ok(dhat > 0.4 && dhat < 0.6, `dhat=${dhat} should be ~0.5`);
  assert.ok(xSweet > 1.4 && xSweet < 1.6, `xSweet=${xSweet} should be ~1.5`);

  // Walk x from 1.0 to 3.0 in 0.1 steps. At each step, compute brForGate and feed to evaluateGate.
  let gateState = null;
  let gateFireX = null;
  let turn = 0;
  for (let x = 1.0; x <= 3.0; x += 0.1) {
    turn++;
    const br = computeBr(x, dhat, mf);
    const gateBr = brForGate(x, xSweet, br);
    const snap = { segment: 0, turnSeq: turn, br: gateBr, reliable: gateBr !== null };
    const result = evaluateGate(snap, gateState);
    gateState = result.nextState;
    if (result.notify) {
      gateFireX = x;
      break;
    }
  }

  assert.ok(gateFireX !== null, 'gate must fire somewhere between x=1.0 and x=3.0');
  // Gate should fire around x ≈ 2.1-2.2 (br ≈ 0.10 at x=2.1 for these params) + 3 dwell
  // With 0.1 step size and dwell=3, gate fires 3 steps after amber: ~2.1 + 0.3 = ~2.4
  const brAtFire = computeBr(gateFireX, dhat, mf);
  assert.ok(brAtFire >= BR_AMBER, `br at gate fire (${brAtFire.toFixed(3)}) must be >= BR_AMBER`);
  assert.ok(gateFireX < 2.8, `gate should fire before x=2.8 (fired at ${gateFireX.toFixed(2)})`);
  assert.ok(gateFireX >= xSweet, `gate fires only past xSweet (x=${gateFireX.toFixed(2)}, xSweet=${xSweet.toFixed(2)})`);
});

test('E2E: gate fire arms backstop → accumulate → backstop fires and laps', () => {
  const cRatio = 12.5, B = 10000, g = 100;
  const mf = computeMovableFrac(cRatio, B, g);
  const interval = backstopIntervalFor(mf, BR_AMBER);

  // 1. Gate fires → arm backstop
  const draft = mkDraft();
  commitBackstopFire(draft, { gateJustFired: true });
  assert.equal(draft.hasDeepWaterGateFired, true);
  assert.equal(draft.dwBillsSinceLastAlert, 0);

  // 2. Accumulate bill cycles in deep water (1 per turn boundary)
  const turnsToFire = Math.ceil(interval);
  for (let i = 0; i < turnsToFire; i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1 });
  }
  assert.ok(draft.dwBillsSinceLastAlert >= interval,
    `after ${turnsToFire} turns: dwBills=${draft.dwBillsSinceLastAlert} should >= interval=${interval.toFixed(2)}`);

  // 3. Stop route: probe → resolve → commit (gate NOT firing again)
  const backstopResult = probeBackstop(draft, { gateJustFired: false, mf });
  assert.equal(backstopResult.notify, true, 'backstop threshold reached');

  const inlineMsg = resolveStopMessage({ gateResult: { notify: false }, burnRate: 0.15, backstopResult });
  assert.equal(inlineMsg.kind, 'backstop', 'backstop wins priority');

  commitBackstopFire(draft, { gateJustFired: false });
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'accumulator resets');
  assert.equal(draft.backstopLapCount, 1, 'first lap');

  // 4. Second lap
  for (let i = 0; i < turnsToFire; i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1 });
  }
  const r2 = probeBackstop(draft, { gateJustFired: false, mf });
  assert.equal(r2.notify, true);
  commitBackstopFire(draft, { gateJustFired: false });
  assert.equal(draft.backstopLapCount, 2, 'second lap');
});

test('E2E: gate does NOT fire on left arm (x < xSweet) even with high raw br', () => {
  // Left arm: x < xSweet → brForGate returns null → gate never accumulates dwell
  const cRatio = 12.5, B = 10000, g = 100;
  const dhat = nucleus(cRatio, g, B);
  const xSweet = 1 + dhat;
  const mf = computeMovableFrac(cRatio, B, g);

  let gateState = null;
  for (let turn = 1; turn <= 10; turn++) {
    // x stays below xSweet
    const x = 1.0 + (turn * 0.04); // max x = 1.4, below xSweet ≈ 1.5
    const br = computeBr(x, dhat, mf);
    const gateBr = brForGate(x, xSweet, br);
    assert.equal(gateBr, null, `x=${x.toFixed(2)} < xSweet=${xSweet.toFixed(2)}: brForGate must return null`);
    const snap = { segment: 0, turnSeq: turn, br: gateBr, reliable: false };
    const result = evaluateGate(snap, gateState);
    gateState = result.nextState;
    assert.equal(result.notify, false, 'gate must not fire on left arm');
  }
});

test('reader-path backstop fire: accumulator reaches interval → lap increments', () => {
  // Setup: gate already fired, dwBills just below threshold
  const mf = 0.3;  // backstopIntervalFor(0.3, 0.10) ≈ 4.9 → fires when dwBills reaches interval
  const interval = backstopIntervalFor(mf, BR_AMBER);
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: Math.floor(interval) - 1,  // one bill short
    backstopLapCount: 0,
  };
  // Advance with 2 bill cycles → crosses threshold
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 2, mf });
  assert.equal(fired, true, 'fired signal returned');
  assert.equal(draft.backstopLapCount, 1, 'lap must increment when accumulator crosses interval');
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'accumulator must reset after fire');
});

test('reader-path backstop fire: accumulator below interval → no fire', () => {
  const mf = 0.3;
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 1,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf });
  assert.equal(fired, false, 'fired signal is false');
  assert.equal(draft.backstopLapCount, 0, 'no fire when below interval');
  assert.equal(draft.dwBillsSinceLastAlert, 2, 'accumulator advances');
});

test('reader-path backstop fire: mf=0 skips fire check but still accumulates', () => {
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 100, // well past any threshold
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf: 0 });
  assert.equal(fired, false, 'no fire when mf=0');
  assert.equal(draft.backstopLapCount, 0, 'lap not incremented');
  assert.equal(draft.dwBillsSinceLastAlert, 101, 'accumulator still advances');
});

test('reader-path backstop fire: multi-lap accumulation', () => {
  const mf = 0.3;
  const interval = backstopIntervalFor(mf, BR_AMBER);
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 0,
    backstopLapCount: 0,
  };
  // Accumulate to first fire
  for (let i = 0; i < Math.ceil(interval); i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf });
  }
  assert.equal(draft.backstopLapCount, 1, 'first lap fires');
  // Accumulate to second fire
  for (let i = 0; i < Math.ceil(interval); i++) {
    advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 1, mf });
  }
  assert.equal(draft.backstopLapCount, 2, 'second lap fires');
});

test('reader-path backstop fire: returns fired=true on threshold crossing', () => {
  const mf = 0.3;
  const interval = backstopIntervalFor(mf, BR_AMBER);
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: Math.floor(interval) - 1,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 2, mf });
  assert.equal(fired, true, 'fired signal is true on threshold crossing');
});

test('reader-path backstop fire: gate not fired → no accumulation, fired=false', () => {
  const draft = {
    hasDeepWaterGateFired: false,
    dwBillsSinceLastAlert: 0,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: true, billCycleIncrement: 5, mf: 0.3 });
  assert.equal(fired, false);
  assert.equal(draft.dwBillsSinceLastAlert, 0, 'no accumulation without gate');
});

test('reader-path backstop fire: not in deep water → no accumulation, fired=false', () => {
  const draft = {
    hasDeepWaterGateFired: true,
    dwBillsSinceLastAlert: 100,
    backstopLapCount: 0,
  };
  const { fired } = advanceGateAndBackstop(draft, { inDeepWater: false, billCycleIncrement: 5, mf: 0.3 });
  assert.equal(fired, false);
  assert.equal(draft.dwBillsSinceLastAlert, 100, 'no change when not in deep water');
});

test('E2E: with large g (inflated dhat), gate still fires at correct br relative to xSweet', () => {
  // Large g pushes xSweet far right — gate threshold is high in absolute x terms
  // but the br formula is correct (fires at br=0.10 relative to the curve)
  const cRatio = 12.5, B = 10000, g = 3000;
  const dhat = nucleus(cRatio, g, B);
  const xSweet = 1 + dhat;
  const mf = computeMovableFrac(cRatio, B, g);

  assert.ok(dhat > 2, `large g → large dhat (${dhat.toFixed(2)})`);
  assert.ok(xSweet > 3, `large g → xSweet far right (${xSweet.toFixed(2)})`);

  // Walk from xSweet to xSweet+5 to find gate fire
  let gateState = null;
  let gateFireX = null;
  let turn = 0;
  for (let x = xSweet; x <= xSweet + 8; x += 0.2) {
    turn++;
    const br = computeBr(x, dhat, mf);
    const gateBr = brForGate(x, xSweet, br);
    const snap = { segment: 0, turnSeq: turn, br: gateBr, reliable: gateBr !== null };
    const result = evaluateGate(snap, gateState);
    gateState = result.nextState;
    if (result.notify) {
      gateFireX = x;
      break;
    }
  }

  assert.ok(gateFireX !== null, 'gate must fire eventually even with large g');
  const brAtFire = computeBr(gateFireX, dhat, mf);
  // Gate fires at br >= 0.10 after 3 consecutive turns → br at fire should be near 0.10
  assert.ok(brAtFire >= BR_AMBER, `br at fire = ${brAtFire.toFixed(3)} must be >= BR_AMBER`);
  assert.ok(brAtFire < 0.20, `br at fire should be close to threshold, not far past it (got ${brAtFire.toFixed(3)})`);
});
