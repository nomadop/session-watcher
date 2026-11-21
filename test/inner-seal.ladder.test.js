// The ladder a seal asks its summary again on: which selection each request takes, how many requests a format failure
// earns, how a content filter moves it down a rung, and when it answers that no request follows.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRetryLadder, FILTER_FAILURE, FORMAT_FAILURE, SUMMARY_FILTER_RETRIES, SUMMARY_MAX_REQUESTS,
} from '../lib/inner-seal/ladder.js';

const OWN = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' };
const BACKUP = { provider: 'backup', model: 'backup-model' };

// The selections of the requests a ladder makes while `failures` keep coming, the first request included: each failure that `next` answers true for is followed by a request.
function requestsUnder(ladder, failures) {
  const taken = [ladder.current()];
  for (const failure of failures) {
    if (!ladder.next(failure)) return { taken, stopped: true };
    taken.push(ladder.current());
  }
  return { taken, stopped: false };
}

test('the first request takes the session\'s selection', () => {
  assert.equal(createRetryLadder({ selection: OWN, fallback: BACKUP }).current(), OWN);
  assert.equal(createRetryLadder({ selection: OWN, fallback: null }).current(), OWN);
});

test('a format failure is asked again on the same selection until SUMMARY_MAX_REQUESTS requests in all, then next answers false', () => {
  const ladder = createRetryLadder({ selection: OWN, fallback: BACKUP });
  const { taken, stopped } = requestsUnder(ladder, Array(SUMMARY_MAX_REQUESTS).fill(FORMAT_FAILURE));
  assert.ok(stopped);
  assert.deepEqual(taken, Array(SUMMARY_MAX_REQUESTS).fill(OWN), 'the format bound counts the first request, and never reaches the fallback');
  assert.equal(ladder.next(FORMAT_FAILURE), false, 'the bound stays spent');
});

test('a filter failure moves down a rung at a time: the session\'s selection, SUMMARY_FILTER_RETRIES repeats of it, then the fallback, and next answers false on the last rung', () => {
  const ladder = createRetryLadder({ selection: OWN, fallback: BACKUP });
  const rungs = [OWN, ...Array(SUMMARY_FILTER_RETRIES).fill(OWN), BACKUP];
  const { taken, stopped } = requestsUnder(ladder, Array(rungs.length).fill(FILTER_FAILURE));
  assert.ok(stopped);
  assert.deepEqual(taken, rungs);
});

test('with no fallback the ladder ends on the session\'s own selection', () => {
  const ladder = createRetryLadder({ selection: OWN, fallback: null });
  const { taken, stopped } = requestsUnder(ladder, Array(1 + SUMMARY_FILTER_RETRIES).fill(FILTER_FAILURE));
  assert.ok(stopped);
  assert.deepEqual(taken, Array(1 + SUMMARY_FILTER_RETRIES).fill(OWN));
});

test('a new rung spends nothing of the format bound: after the ladder reaches the fallback, the format failures still earn SUMMARY_MAX_REQUESTS requests on it', () => {
  const ladder = createRetryLadder({ selection: OWN, fallback: BACKUP });
  const filters = Array(1 + SUMMARY_FILTER_RETRIES).fill(FILTER_FAILURE);
  const formats = Array(SUMMARY_MAX_REQUESTS).fill(FORMAT_FAILURE);
  const { taken, stopped } = requestsUnder(ladder, [...filters, ...formats]);
  assert.ok(stopped);
  assert.deepEqual(taken, [OWN, ...Array(SUMMARY_FILTER_RETRIES).fill(OWN), ...Array(SUMMARY_MAX_REQUESTS).fill(BACKUP)]);
});

test('a format failure never moves the ladder and a spent format bound leaves a filter its rung', () => {
  const ladder = createRetryLadder({ selection: OWN, fallback: BACKUP });
  const { taken } = requestsUnder(ladder, [...Array(SUMMARY_MAX_REQUESTS - 1).fill(FORMAT_FAILURE), FILTER_FAILURE]);
  assert.deepEqual(taken, [...Array(SUMMARY_MAX_REQUESTS).fill(OWN), SUMMARY_FILTER_RETRIES > 0 ? OWN : BACKUP]);
  assert.equal(ladder.next(FORMAT_FAILURE), false, 'the format requests made before the filter still count');
});

test('a failure of no category is never asked again', () => {
  for (const failure of [undefined, 'other']) {
    const ladder = createRetryLadder({ selection: OWN, fallback: BACKUP });
    assert.equal(ladder.next(failure), false);
    assert.equal(ladder.current(), OWN, 'the selection stays');
  }
});
