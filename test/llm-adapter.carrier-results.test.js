// The closed vocabulary of one carrier cache point result (`lib/llm-adapter/carrier-results.js`): which values are a result.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CARRIER_RESULTS, SKIP_REASONS, isCarrierResult } from '../lib/llm-adapter/carrier-results.js';

test('a result is `added` or `native` alone, or `skipped` with one of the reasons the vocabulary names', () => {
  assert.ok(SKIP_REASONS.length > 0);
  for (const result of CARRIER_RESULTS.filter(each => each !== 'skipped')) assert.equal(isCarrierResult({ result }), true, result);
  for (const reason of SKIP_REASONS) assert.equal(isCarrierResult({ result: 'skipped', reason }), true, reason);
});

test('a value that is no closed result is none: another type, a result or reason the vocabulary does not name, a missing reason and any extra member', () => {
  const refused = [
    null, undefined, 'added', 7, ['added'],
    {}, { result: 'unknown' }, { result: 'Added' },
    { result: 'added', reason: 'no-carrier' }, { result: 'native', extra: true },
    { result: 'skipped' }, { result: 'skipped', reason: 'unknown' }, { result: 'skipped', reason: 'no-carrier', extra: true },
  ];
  for (const value of refused) assert.equal(isCarrierResult(value), false, JSON.stringify(value));
});
