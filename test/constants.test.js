// test/constants.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import CONSTANTS, {
  C_RATIO_TABLE, DEFAULT_CACHE_TTL,
  CTP_TABLE, DEFAULT_CTP, TOOL_OVERHEAD, ASCII_EXTS, ALPHA_EMA, G_DELTA_CAP, G_FLOOR,
  MISS_B_FRACTION, MISS_TOTAL_KEEP, SEGMENT_DROP_EPSILON,
  CHURN_ELEVATED_THRESHOLD, CHURN_STRUGGLING_THRESHOLD,
  CHURN_STRUGGLING_REREADS, WASTE_FLOOR,
} from '../lib/constants.js';

test('constants match spec values exactly', () => {
  assert.equal(CONSTANTS.EFFICIENCY_MULT, 2);
  assert.equal(CONSTANTS.MISS_TOTAL_KEEP, 0.7);
  assert.equal(CONSTANTS.MISS_B_FRACTION, 0.8);
});

// The ratio lookup reads two row shapes and no third: a scalar, where one cache-write price covers every
// prompt-cache lifetime, and a map keyed by lifetime, where the provider prices the lifetime. A keyed row
// carries an own entry at DEFAULT_CACHE_TTL because that entry is the lookup's single fallback for every
// lifetime the row prices no write under, and it carries at least one lifetime beside it because a row keyed
// only at the default states no lifetime dependence — and because a computed default key colliding with a
// literal key of the same name collapses the row to one entry with nothing in the diff to show it. What the
// lookup RESOLVES from these shapes is `test/model-policy.test.js`'s.
test('C_RATIO_TABLE: every row carries a shape the ratio lookup reads', () => {
  assert.ok(C_RATIO_TABLE.length > 0, 'a non-empty table, so the sweep below is not vacuous');
  for (const row of C_RATIO_TABLE) {
    const label = String(row.match);
    if (typeof row.ratio === 'number') {
      assert.ok(Number.isFinite(row.ratio) && row.ratio > 0, `${label} scalar ratio → ${row.ratio}`);
      continue;
    }
    assert.equal(typeof row.ratio, 'object', `${label} ratio is a scalar or a lifetime-keyed map`);
    assert.notEqual(row.ratio, null, `${label} ratio is a scalar or a lifetime-keyed map`);
    assert.ok(Object.hasOwn(row.ratio, DEFAULT_CACHE_TTL),
      `${label} carries its own default-lifetime entry, the lookup's single fallback`);
    const lifetimes = Object.keys(row.ratio);
    assert.ok(lifetimes.some(ttl => ttl !== DEFAULT_CACHE_TTL),
      `${label} keys a lifetime beside the default → ${lifetimes.join(',')}`);
    for (const ttl of lifetimes) {
      assert.ok(Number.isFinite(row.ratio[ttl]) && row.ratio[ttl] > 0,
        `${label} @ ${ttl} → ${row.ratio[ttl]}`);
    }
  }
});

test('v3: CTP table has calibrated claude/deepseek rows and a conservative default', () => {
  assert.deepEqual(CTP_TABLE.claude, { ascii: 2.45, cjk: 0.59 });
  assert.deepEqual(CTP_TABLE.deepseek, { ascii: 3.24, cjk: 0.94 });
  assert.deepEqual(DEFAULT_CTP, { ascii: 3.0, cjk: 1.0 });
});

test('v3: tool framing overhead constants (tokens)', () => {
  assert.deepEqual(TOOL_OVERHEAD, { Read: 40, Write: 90, Edit: 85, Bash: 10, Grep: 40, Serena: 50 });
});

test('v3: churn tier constants exported with exact values', () => {
  assert.equal(CHURN_ELEVATED_THRESHOLD, 3.0);
  assert.equal(CHURN_STRUGGLING_THRESHOLD, 5.0);
  assert.equal(CHURN_STRUGGLING_REREADS, 2);
  assert.equal(WASTE_FLOOR, 2500);
});

test('v3: measurement/notify constants', () => {
  assert.equal(ALPHA_EMA, 0.06);
  assert.equal(G_DELTA_CAP, 250);
  assert.equal(G_FLOOR, 100);
  assert.equal(MISS_B_FRACTION, 0.8);
  assert.equal(MISS_TOTAL_KEEP, 0.7);
  assert.equal(SEGMENT_DROP_EPSILON, 100);
  assert.ok(ASCII_EXTS.includes('.js') && ASCII_EXTS.includes('.json'));
});
