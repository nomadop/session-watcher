import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thresholdLinesOf } from '../public/elements/historyChart.js';
import { projectedX } from '../public/lib/xScale.js';

test('thresholdLinesOf anchors the conversion at the plotted point, so a landmark at the current causal position lands exactly on it', () => {
  // The fold's own u, placed on the reference, is where the hero draws its dot. A landmark evaluated at that same
  // u is the same x, so its line must come out at the plotted L whatever the fit and whatever the basis — the
  // residual between measured and projected x cancels. Under `x * bDefault` each case lands on `x * bDefault`.
  for (const { a, d, u, bDefault, anchorL } of [
    { a: 1, d: 1, u: 1, bDefault: 50000, anchorL: 60000 },
    { a: 3.1, d: 0.7, u: 1.4, bDefault: 75595, anchorL: 425969 },
    { a: -2.5, d: 4.25, u: 0.3, bDefault: 12345, anchorL: 98765 },
  ]) {
    const source = { reference: { a, d }, u, xBrAmberL: null, xBrAmberR: a + d * u, xBrRedR: null };
    assert.equal(thresholdLinesOf(source, bDefault, anchorL).exit, anchorL);
  }
});

test('thresholdLinesOf places every other landmark at the anchor plus the basis times its projected x offset', () => {
  const reference = { a: 3.1, d: 0.7 };
  const u = 1.4, bDefault = 75595, anchorL = 425969;
  const xAt = (uu) => reference.a + reference.d * uu;
  const source = { reference, u, xBrAmberL: xAt(0.5), xBrAmberR: xAt(u), xBrRedR: xAt(2) };
  const lines = thresholdLinesOf(source, bDefault, anchorL);
  const expected = (x) => anchorL + bDefault * (x - projectedX(reference, u));
  assert.ok(Math.abs(lines.entry - expected(xAt(0.5))) < 1e-6);
  assert.ok(Math.abs(lines.red - expected(xAt(2))) < 1e-6);
  // The entry landmark sits behind the current position, so its line sits below the plotted L — the chart reads
  // that as already passed rather than clamping it.
  assert.ok(lines.entry < anchorL);
});

test('thresholdLinesOf carries a landmark far behind the current position below zero rather than clamping it', () => {
  const reference = { a: 1, d: 1 };
  const source = { reference, u: 40, xBrAmberL: 2, xBrAmberR: 3, xBrRedR: 4 };
  const lines = thresholdLinesOf(source, 50000, 100000);
  assert.equal(lines.entry, 100000 + 50000 * (2 - 41));
  assert.ok(lines.entry < 0);
});

test('thresholdLinesOf yields null lines for an absent landmark, a non-positive basis, a null source and a missing reference', () => {
  const nulls = { entry: null, exit: null, red: null };
  const reference = { a: 1, d: 1 };
  assert.deepEqual(thresholdLinesOf({ reference, u: 1, xBrAmberL: null, xBrAmberR: null, xBrRedR: null }, 50000, 60000), nulls);
  assert.deepEqual(thresholdLinesOf({ reference, u: 1, xBrAmberL: 1.2, xBrAmberR: 2.0, xBrRedR: 2.6 }, 0, 60000), nulls);
  assert.deepEqual(thresholdLinesOf(null, 50000, 60000), nulls);
  assert.deepEqual(thresholdLinesOf({ u: 1, xBrAmberL: 1.2, xBrAmberR: 2.0, xBrRedR: 2.6 }, 50000, 60000), nulls);
});
