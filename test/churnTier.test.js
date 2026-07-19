import { test } from 'node:test';
import assert from 'node:assert/strict';
import { churnTier } from '../public/lib/churnTier.js';

test('churnTier: normal < 3.0 → mint', () => {
  assert.equal(churnTier({ churn: 2.5, waste: 10000, pureRereads: 0 }), 'mint');
});
test('churnTier: 3.0–5.0 → amber (elevated), waste-independent', () => {
  assert.equal(churnTier({ churn: 3.5, waste: 100, pureRereads: 0 }), 'amber');
});
test('churnTier: churn >5.0 with waste >= floor → coral', () => {
  assert.equal(churnTier({ churn: 6.0, waste: 3000, pureRereads: 0 }), 'coral');
});
test('churnTier: churn >5.0 but waste < floor → amber (coral gated by WASTE_FLOOR)', () => {
  assert.equal(churnTier({ churn: 6.0, waste: 100, pureRereads: 0 }), 'amber');
});
test('churnTier: pureRereads >= 2 with waste >= floor → coral even if churn is only ~3', () => {
  assert.equal(churnTier({ churn: 3.0, waste: 3000, pureRereads: 2 }), 'coral');
});
test('churnTier: pureRereads >= 2 but waste < floor → not coral from rereads', () => {
  assert.equal(churnTier({ churn: 3.0, waste: 100, pureRereads: 2 }), 'amber');
});
test('churnTier: null churn → mint (safe default)', () => {
  assert.equal(churnTier({ churn: null, waste: 0, pureRereads: 0 }), 'mint');
});
