import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBucketStateTracker, BUCKET_FETCH_DEBOUNCE_MS } from '../public/lib/bucketState.js';

test('begin then end(true) resets failures and stamps lastSuccessAt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5000 });
  const tracker = createBucketStateTracker();
  tracker.begin();
  tracker.end(false);
  assert.equal(tracker.state.consecutiveFailures, 1);
  t.mock.timers.tick(1000);
  tracker.begin();
  tracker.end(true);
  assert.deepEqual(tracker.state, { isFetching: false, consecutiveFailures: 0, lastSuccessAt: 6000 });
});

test('end(false) counts a failure and leaves lastSuccessAt', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5000 });
  const tracker = createBucketStateTracker();
  tracker.begin();
  tracker.end(true);
  t.mock.timers.tick(1000);
  tracker.begin();
  tracker.end(false);
  tracker.begin();
  tracker.end(false);
  assert.deepEqual(tracker.state, { isFetching: false, consecutiveFailures: 2, lastSuccessAt: 5000 });
});

test('isFetching turns true only after the debounce and false at once on end', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const tracker = createBucketStateTracker();
  tracker.begin();
  t.mock.timers.tick(BUCKET_FETCH_DEBOUNCE_MS - 1);
  assert.equal(tracker.state.isFetching, false, 'still inside the debounce');
  t.mock.timers.tick(1);
  assert.equal(tracker.state.isFetching, true, 'debounce elapsed');
  tracker.end(true);
  assert.equal(tracker.state.isFetching, false, 'end clears at once');
  tracker.begin();
  tracker.end(true);
  t.mock.timers.tick(BUCKET_FETCH_DEBOUNCE_MS * 2);
  assert.equal(tracker.state.isFetching, false, 'an end inside the debounce cancels the flip');
});

test('subscribe sees each change once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5000 });
  const tracker = createBucketStateTracker();
  const seen = [];
  const unsubscribe = tracker.subscribe((s) => seen.push({ ...s }));
  tracker.begin();
  t.mock.timers.tick(BUCKET_FETCH_DEBOUNCE_MS);
  tracker.end(true);
  tracker.begin();
  tracker.end(false);
  assert.deepEqual(seen, [
    { isFetching: true, consecutiveFailures: 0, lastSuccessAt: null },
    { isFetching: false, consecutiveFailures: 0, lastSuccessAt: 5000 + BUCKET_FETCH_DEBOUNCE_MS },
    { isFetching: false, consecutiveFailures: 1, lastSuccessAt: 5000 + BUCKET_FETCH_DEBOUNCE_MS },
  ]);
  unsubscribe();
  tracker.begin();
  tracker.end(true);
  assert.equal(seen.length, 3, 'an unsubscribed callback sees nothing');
});
