// test/constants.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONSTANTS, {
  C_RATIO_TABLE, DEFAULT_C_RATIO,
  CTP_TABLE, DEFAULT_CTP, TOOL_OVERHEAD, ASCII_EXTS, ALPHA_EMA, G_FLOOR,
  MISS_B_FRACTION, MISS_TOTAL_KEEP, SEGMENT_DROP_EPSILON, NOTIFY_DWELL,
  BR_HYST, CTP_OVERSHOOT_WARN,
  CHURN_ELEVATED_THRESHOLD, CHURN_STRUGGLING_THRESHOLD,
  CHURN_STRUGGLING_REREADS, WASTE_FLOOR,
} from '../lib/constants.js';

test('constants match spec values exactly', () => {
  assert.equal(CONSTANTS.EFFICIENCY_MULT, 2);
  assert.equal(CONSTANTS.DW_TURN_BACKSTOP, 2);
  assert.equal(CONSTANTS.MISS_TOTAL_KEEP, 0.7);
  assert.equal(CONSTANTS.MISS_B_FRACTION, 0.8);
});

test('C_RATIO table has claude and deepseek, default is 10', () => {
  assert.equal(DEFAULT_C_RATIO, 10);
  assert.ok(C_RATIO_TABLE.some(r => r.match.test('claude-opus-4-8') && r.ratio === 12.5));
  assert.ok(C_RATIO_TABLE.some(r => r.match.test('deepseek-v4-pro') && r.ratio === 120));
  assert.ok(C_RATIO_TABLE.some(r => r.match.test('deepseek-v4-flash') && r.ratio === 50));
});

test('v3: CTP table has calibrated claude/deepseek rows and a conservative default', () => {
  assert.deepEqual(CTP_TABLE.claude, { ascii: 2.45, cjk: 0.59 });
  assert.deepEqual(CTP_TABLE.deepseek, { ascii: 3.24, cjk: 0.94 });
  assert.deepEqual(DEFAULT_CTP, { ascii: 3.0, cjk: 1.0 });
});

test('v3: tool framing overhead constants (tokens)', () => {
  assert.deepEqual(TOOL_OVERHEAD, { Read: 40, Write: 90, Edit: 85, Bash: 10, Grep: 40 });
});

test('v3: churn tier constants exported with exact values', () => {
  assert.equal(CHURN_ELEVATED_THRESHOLD, 3.0);
  assert.equal(CHURN_STRUGGLING_THRESHOLD, 5.0);
  assert.equal(CHURN_STRUGGLING_REREADS, 2);
  assert.equal(WASTE_FLOOR, 2500);
});

test('v3: measurement/notify constants', () => {
  assert.equal(ALPHA_EMA, 0.12);
  assert.equal(G_FLOOR, 100);
  assert.equal(MISS_B_FRACTION, 0.8);
  assert.equal(MISS_TOTAL_KEEP, 0.7);
  assert.equal(SEGMENT_DROP_EPSILON, 100);
  assert.equal(NOTIFY_DWELL, 3);
  assert.equal(BR_HYST, 0.02);
  assert.equal(CTP_OVERSHOOT_WARN, 0.05);
  assert.ok(ASCII_EXTS.includes('.js') && ASCII_EXTS.includes('.json'));
});
