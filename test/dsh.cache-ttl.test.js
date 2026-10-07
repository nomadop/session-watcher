// test/dsh.cache-ttl.test.js — pi-ai's `cacheRetention` declaration mapped onto the TTL keys the C ratio table prices.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheTtlForRetention } from '../lib/harness/dsh/cache-ttl.js';
import { DEFAULT_CACHE_TTL, LONG_CACHE_TTL } from '../lib/constants.js';
import { modelPolicyFor } from '../lib/model-policy.js';

test('long maps to the long lifetime key and every other declaration to null', () => {
  assert.equal(cacheTtlForRetention('long'), LONG_CACHE_TTL);
  for (const retention of ['short', 'none', undefined, null]) {
    assert.equal(cacheTtlForRetention(retention), null, String(retention));
  }

  // A key the table prices answers its own row rather than the DEFAULT_CACHE_TTL fallback, which a key no row carries would reach.
  const model = 'claude-opus-4-8';
  assert.notEqual(modelPolicyFor(model, LONG_CACHE_TTL).cRatio, modelPolicyFor(model, DEFAULT_CACHE_TTL).cRatio);
});
