import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../public/lib/store.js';

test('store.update carries bucketData as 4th field', () => {
  const store = createStore();
  const bd = { paths: [], skills: [], residual: { bash: [], mcp: [] }, dead: 0, totalB: 0, totalL: 0, totalResidual: 0, ctpOvershootRatio: 0, currentTurnSeq: 0, segment: 0 };
  store.update({ L: 1 }, [], { x: true }, bd);
  const snap = store.getSnapshot();
  assert.equal(snap.bucketData, bd, 'bucketData present in snapshot');
  assert.deepEqual(snap.status, { L: 1 }, 'existing fields unchanged');
});

test('store initial snapshot has bucketData: null', () => {
  const store = createStore();
  assert.equal(store.getSnapshot().bucketData, null);
});
