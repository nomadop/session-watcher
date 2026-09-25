// test/heroDiptych.test.js — the hero's producers: reference skeleton, measured trajectory, verdict, group models
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  referenceY, sampleReference, yMaxOf, positionVerdict, groupModelFromStatus, groupModelFromScenario,
  shownGroupOf,
} from '../public/elements/heroDiptych.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const ref = { a: 0.75, d: 0.5, provisional: false };

test('referenceY is 1 + φ((x − a)/d) and null at or left of the asymptote', () => {
  near(referenceY(1.25, ref), 1);              // u = 1
  near(referenceY(1.75, ref), 1 + 1 / 4);      // u = 2 → φ = 0.25
  assert.equal(referenceY(0.75, ref), null);
  assert.equal(referenceY(0.5, ref), null);
});

test('sampleReference starts at the window\'s left edge, right of a, and ends at the viewport max', () => {
  const pts = sampleReference(ref, 0.9, 3, 10);
  assert.ok(pts[0].x < 1 && pts[0].x >= 0.9);
  near(pts.at(-1).x, 3);
  for (const p of pts) assert.ok(Number.isFinite(p.y));
  const left = sampleReference({ a: 1.4, d: 0.5 }, 1, 3, 10);
  assert.ok(left.length > 0, 'a viewport opening left of a still samples');
  assert.ok(left[0].x > 1.4);
});

test('yMaxOf takes the larger of the amber-left and wall heights with headroom, and the unit height without a reference', () => {
  const withRef = yMaxOf({ reference: ref, xBrAmberL: 1.05, wallP: 11 });
  near(withRef, Math.max(referenceY(1.05, ref), referenceY(11, ref)) * 1.3);
  near(yMaxOf({ reference: null, xBrAmberL: null, wallP: 11 }), 1.3);
});

test('positionVerdict: arm by u, wall by x, zone by br; captions print no br value and only the wall prompts', () => {
  const verdicts = {
    calibrating: positionVerdict(null, 0.2, 1.1, 11),
    wall: positionVerdict(0.3, 3, 11.5, 11),
    left: positionVerdict(0.15, 0.6, 1.1, 11),
    leftValley: positionVerdict(0.02, 0.9, 1.2, 11),
    red: positionVerdict(0.3, 2.5, 3, 11),
    amber: positionVerdict(0.15, 2, 2.2, 11),
    valley: positionVerdict(0.02, 1.3, 1.5, 11),
    // br = mf · pp, so a small movable fraction makes br small at any u: u = 2 is a quarter of a penalty
    // past the sweet spot however little of the bill it moves.
    farButCheap: positionVerdict(0.005, 2, 2.5, 11),
  };
  assert.deepEqual(Object.values(verdicts).map(v => v.zone), ['calibrating', 'wall', 'left', 'green', 'red', 'amber', 'green', 'green']);
  assert.match(verdicts.farButCheap.caption, /^Past the sweet spot/);
  assert.match(verdicts.valley.caption, /^Past the sweet spot/);
  assert.match(verdicts.leftValley.caption, /^Left of the sweet spot/);
  for (const v of Object.values(verdicts)) assert.doesNotMatch(v.caption, /%/);
  for (const [name, v] of Object.entries(verdicts)) if (name !== 'wall') assert.doesNotMatch(v.caption, /restart/i, name);
  assert.match(verdicts.wall.caption, /restart/i);
});

// The chart places the causal position on the reference skeleton — x = a + d·u, y = 1 + pp — never at the measured
// x, which retreats when a read widens the baseline while u only advances.
test('a group model from status places the dot on the reference, keeps the measured x for the verdict, and has no dot without a reference', () => {
  const rl = { reliable: true, u: 1.5, pp: 0.06, mf: 0.3, br: 0.018, x_display: 1.6, C_RATIO: 10, wallP: 11,
    reference: ref, xSweet: 1.3, xBrAmberL: 1.05, xBrAmberR: 1.9, xBrRedR: 2.4 };
  const g = groupModelFromStatus(rl, true);
  assert.deepEqual(g.dot, { x: 1.5, y: 1.06 });
  assert.equal(g.x, 1.6);
  assert.equal(g.wallP, 11);
  assert.deepEqual(g.reference, ref);
  assert.deepEqual(g.landmarks, { xSweet: 1.3, xBrAmberL: 1.05, xBrAmberR: 1.9, xBrRedR: 2.4 });
  near(g.residual, 1.6 - 1.5);
  const bare = groupModelFromStatus({ ...rl, reference: null, xSweet: null, xBrAmberL: null, xBrAmberR: null, xBrRedR: null }, false);
  assert.equal(bare.reference, null);
  assert.equal(bare.landmarks, null);
  assert.equal(bare.dot, null);
  assert.equal(bare.x, 1.6);
});

// The wall reaches the client as `wallP` only on the path where a ledger was accepted: a segment rollover or
// a controller whose ledger is still null leaves a reliable status with C_RATIO and no wallP
// (test/rate-lamp.merge-br.test.js `a null ledger → the default rentMeter`), and the client's own read is
// what places the wall then.
test('the wall is the status wallP, and one plus the price ratio when a status carries none', () => {
  const rl = { reliable: true, u: 1.4, pp: 0.06, mf: 0.3, br: 0.018, x_display: 1.5, C_RATIO: 12.5,
    reference: ref, xSweet: 1.3, xBrAmberL: 1.05, xBrAmberR: 1.9, xBrRedR: 2.4 };
  assert.equal(groupModelFromStatus({ ...rl, wallP: 9 }, true).wallP, 9);
  assert.equal(groupModelFromStatus(rl, true).wallP, 13.5);
});

test('a group model from a scenario never computes locally: it takes the scenario\'s last frame, reference and landmarks', () => {
  const scenario = { reliable: true, trajectory: [{ seq: 2, x: 1.3, u: 0.5, pp: 0.06 }, { seq: 3, x: 1.7, u: 1.5, pp: 0.02 }],
    u: 1.5, pp: 0.02, mf: 0.3, br: 0.006, bDefault: 900, reference: { a: 0.875, d: 0.5, provisional: false },
    xSweet: 1.5, xBrAmberL: 1.2, xBrAmberR: 2.0, xBrRedR: 2.6, wallP: 11 };
  const g = groupModelFromScenario(scenario, 11);
  assert.deepEqual(g.dot, { x: 1.625, y: 1.02 });
  assert.equal(g.x, 1.7);
  near(g.residual, 1.7 - 1.625);
  assert.equal(g.landmarks.xSweet, 1.5);
  assert.equal(g.br, 0.006);
  assert.equal(groupModelFromScenario({ reliable: false }, 11), null);
});

test('a scenario\'s dot is its last frame placed on the reference, and a scenario without frames leaves dot, x and residual unset', () => {
  const base = { reliable: true, u: 0.5, pp: 0.06, mf: 0.3, br: 0.018, bDefault: 900,
    reference: { a: 0.875, d: 0.5, provisional: false }, xSweet: 1.5, xBrAmberL: 1.2, xBrAmberR: 2.0, xBrRedR: 2.6 };

  const blankFirst = groupModelFromScenario({ ...base, trajectory: [
    { seq: 1, x: 1.1, u: null, pp: null }, { seq: 2, x: 1.3, u: 0.5, pp: 0.06 },
  ] }, 11);
  assert.deepEqual(blankFirst.dot, { x: 1.125, y: 1.06 });

  const empty = groupModelFromScenario({ ...base, trajectory: [] }, 11);
  assert.equal(empty.dot, null);
  assert.equal(empty.x, null);
  assert.equal(empty.residual, null);
  // The downstream consumers of a pointless group still answer.
  assert.ok(yMaxOf({ reference: empty.reference, xBrAmberL: empty.landmarks.xBrAmberL, wallP: 11 }) > 1);
  assert.equal(positionVerdict(empty.br, empty.u, empty.x, 11).zone, 'green');
});

// A scenario is reliable whenever the default one is, so a preview whose own fit was refused arrives with a
// reference of null and nothing to place. The aux bar's marker already reads the placed position rather than the
// reliability (`test/depthAux.test.js` `markerModel takes the mint position`), and the hero reads the same fact:
// showing such a group would withdraw the curve, the dot and the premium label the default group still carries.
test('the shown group is the preview only once its scenario places a position', () => {
  const scenario = { reliable: true, u: 0.5, pp: 0.06, mf: 0.3, br: 0.018, bDefault: 900,
    reference: { a: 0.875, d: 0.5 }, xSweet: 1.5, xBrAmberL: 1.2, xBrAmberR: 2.0, xBrRedR: 2.6 };
  const placed = groupModelFromScenario({ ...scenario, trajectory: [{ seq: 2, x: 1.3, u: 0.5, pp: 0.06 }] }, 11);
  const unfitted = groupModelFromScenario({ ...scenario, reference: null, xSweet: null, xBrAmberL: null,
    xBrAmberR: null, xBrRedR: null, trajectory: [] }, 11);

  assert.ok(placed.dot, 'a fitted scenario places its dot');
  assert.equal(unfitted.dot, null);

  assert.equal(shownGroupOf('mint', placed), 'mint');
  assert.equal(shownGroupOf('mint', unfitted), 'amber');
  assert.equal(shownGroupOf('mint', null), 'amber');
  assert.equal(shownGroupOf('amber', placed), 'amber');
});
