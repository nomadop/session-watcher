import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDeltaLPerTurn, computeTargetL } from '../lib/rate-lamp-manager.js';

test('EMA cold start: first turn only seeds anchor, deltaLPerTurn stays null', () => {
  const ema = { prevTurnSeq: null, prevTurnL: null, deltaLPerTurn: null };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 1, L: 50000 });
  assert.equal(ema.deltaLPerTurn, null);
  assert.equal(ema.prevTurnSeq, 1);
  assert.equal(ema.prevTurnL, 50000);
});

test('EMA second turn initializes deltaLPerTurn to raw delta', () => {
  const ema = { prevTurnSeq: 1, prevTurnL: 50000, deltaLPerTurn: null };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 2, L: 53000 });
  assert.equal(ema.deltaLPerTurn, 3000);
});

test('EMA third turn applies alpha=0.3', () => {
  const ema = { prevTurnSeq: 2, prevTurnL: 53000, deltaLPerTurn: 3000 };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 3, L: 57000 });
  assert.ok(Math.abs(ema.deltaLPerTurn - 3300) < 1e-9);
});

test('EMA turnGap=2 divides delta by gap', () => {
  const ema = { prevTurnSeq: 1, prevTurnL: 50000, deltaLPerTurn: null };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 3, L: 56000 });
  assert.equal(ema.deltaLPerTurn, 3000);
});

test('EMA turnGap>3 skips update, only refreshes anchor', () => {
  const ema = { prevTurnSeq: 1, prevTurnL: 50000, deltaLPerTurn: 2000 };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 10, L: 100000 });
  assert.equal(ema.deltaLPerTurn, 2000, 'EMA unchanged');
  assert.equal(ema.prevTurnSeq, 10, 'anchor refreshed');
  assert.equal(ema.prevTurnL, 100000);
});

test('EMA negative/zero delta does not update', () => {
  const ema = { prevTurnSeq: 5, prevTurnL: 60000, deltaLPerTurn: 3000 };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 6, L: 60000 });
  assert.equal(ema.deltaLPerTurn, 3000, 'zero delta → no update');
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 7, L: 55000 });
  assert.equal(ema.deltaLPerTurn, 3000, 'negative delta → no update');
});

test('EMA same turnSeq is a strict no-op (prevTurnL not refreshed)', () => {
  const ema = { prevTurnSeq: 3, prevTurnL: 50000, deltaLPerTurn: 2000 };
  updateDeltaLPerTurn(ema, { watcherTurnSeq: 3, L: 55000 });
  assert.equal(ema.deltaLPerTurn, 2000, 'same turn → no update');
  assert.equal(ema.prevTurnL, 50000, 'same turn → anchor NOT refreshed');
});

test('computeTargetL below_entry → lBase * xEntry', () => {
  const target = computeTargetL({ band: 'below_entry', lBase: 55000, xEntry: 1.2, xExit: 2.0, lCap: 960000 });
  assert.ok(Math.abs(target - 55000 * 1.2) < 1e-6);
});

test('computeTargetL sweet zones → lBase * xExit', () => {
  const t1 = computeTargetL({ band: 'entry_to_sweet', lBase: 55000, xEntry: 1.2, xExit: 2.0, lCap: 960000 });
  assert.ok(Math.abs(t1 - 55000 * 2.0) < 1e-6);
});

test('computeTargetL above_exit → lCap', () => {
  assert.equal(computeTargetL({ band: 'above_exit', lBase: 55000, xEntry: 1.2, xExit: 2.0, lCap: 960000 }), 960000);
});

test('computeTargetL returns null for unknown band / missing data', () => {
  assert.equal(computeTargetL({ band: null, lBase: 55000, xEntry: 1.2, xExit: 2.0, lCap: 960000 }), null);
  assert.equal(computeTargetL({ band: 'below_entry', lBase: NaN, xEntry: 1.2, xExit: 2.0, lCap: 960000 }), null);
});

test('computeTargetL clamps to lCap when landmark exceeds cap', () => {
  const target = computeTargetL({ band: 'sweet_to_exit', lBase: 500000, xEntry: 1.2, xExit: 3.0, lCap: 960000 });
  assert.equal(target, 960000);
});
