// test/constants.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONSTANTS, { C_RATIO_TABLE, DEFAULT_C_RATIO } from '../lib/constants.js';

test('constants match spec values exactly', () => {
  assert.equal(CONSTANTS.EFFICIENCY_MULT, 2);
  assert.equal(CONSTANTS.FIT_WINDOW_DEFAULT, 20);
  assert.equal(CONSTANTS.KNEE_MIN_TURN, 3);
  assert.equal(CONSTANTS.BASELINE_CONF_MIN, 0.75);
  assert.equal(CONSTANTS.RESIDUAL_MAX, 0.3);
});

test('C_RATIO table has claude and deepseek, default is 10', () => {
  assert.equal(DEFAULT_C_RATIO, 10);
  assert.ok(C_RATIO_TABLE.some(r => r.match.test('claude-opus-4-8') && r.ratio === 12.5));
  assert.ok(C_RATIO_TABLE.some(r => r.match.test('deepseek-v4-pro') && r.ratio === 120));
  assert.ok(C_RATIO_TABLE.some(r => r.match.test('deepseek-v4-flash') && r.ratio === 50));
});
