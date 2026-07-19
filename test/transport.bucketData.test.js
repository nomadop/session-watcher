import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../public/lib/transport.js';

test('transport fetches /api/buckets and passes bucketData to onData', async () => {
  const bd = { paths: [{ path: 'a.js', tokens: 5, lastTurn: 1 }] };
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => url.includes('/api/buckets') ? bd
      : url.includes('/api/history') ? []
      : { L: 1 },
  });
  const t = createTransport({ streamUrl: 'about:blank' });
  let got = null;
  t.onData((status, history, capabilities, bucketData) => { got = { status, history, bucketData }; });
  await t.refresh();
  assert.deepEqual(got.bucketData, bd, 'bucketData delivered as 4th arg');
  assert.deepEqual(got.status, { L: 1 });
  t.destroy();
});

test('transport tolerates /api/buckets failure (bucketData null, status still delivered)', async () => {
  globalThis.fetch = async (url) => url.includes('/api/buckets')
    ? { ok: false, json: async () => { throw new Error('no'); } }
    : { ok: true, json: async () => url.includes('/api/history') ? [] : { L: 2 } };
  const t = createTransport({ streamUrl: 'about:blank' });
  let got = null;
  t.onData((status, history, capabilities, bucketData) => { got = { status, bucketData }; });
  await t.refresh();
  assert.deepEqual(got.status, { L: 2 }, 'status delivered even if buckets fail');
  assert.equal(got.bucketData, null, 'bucketData null on fetch failure');
  t.destroy();
});

test('transport: bucket state - fast success does NOT trigger isFetching', async () => {
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => url.includes('/api/buckets') ? {} : url.includes('/api/history') ? [] : { L: 1 },
  });
  const t = createTransport({ streamUrl: 'about:blank' });
  const states = [];
  t.onBucketState((s) => states.push({ ...s }));
  await t.refresh();
  // Fast fetch completes before 300ms debounce → isFetching never becomes true
  assert.ok(states.every(s => s.isFetching === false), 'fast fetch never triggers isFetching');
  t.destroy();
});

test('transport: bucket state - failure increments consecutiveFailures', async () => {
  globalThis.fetch = async (url) => url.includes('/api/buckets')
    ? { ok: false, json: async () => { throw new Error('no'); } }
    : { ok: true, json: async () => url.includes('/api/history') ? [] : { L: 1 } };
  const t = createTransport({ streamUrl: 'about:blank' });
  let lastState = null;
  t.onBucketState((s) => { lastState = { ...s }; });
  await t.refresh();
  assert.equal(lastState.consecutiveFailures, 1, 'failure increments counter');
  assert.equal(lastState.isFetching, false, 'not fetching after complete');
  await t.refresh();
  assert.equal(lastState.consecutiveFailures, 2, 'second failure increments again');
  t.destroy();
});

test('transport: bucket state - success resets consecutiveFailures and sets lastSuccessAt', async () => {
  let callCount = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/api/buckets')) {
      callCount++;
      if (callCount === 1) return { ok: false, json: async () => { throw new Error(); } };
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => url.includes('/api/history') ? [] : { L: 1 } };
  };
  const t = createTransport({ streamUrl: 'about:blank' });
  let lastState = null;
  t.onBucketState((s) => { lastState = { ...s }; });
  await t.refresh(); // first: failure
  assert.equal(lastState.consecutiveFailures, 1);
  await t.refresh(); // second: success
  assert.equal(lastState.consecutiveFailures, 0, 'reset on success');
  assert.ok(lastState.lastSuccessAt > 0, 'lastSuccessAt stamped');
  t.destroy();
});
