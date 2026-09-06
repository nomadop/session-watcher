// The reproduced production failure, folded end to end. A live session lost 91 folded calls because
// two independent defects met on one batch: a sub-1% Context Stock dip read as a context reset, and
// `handleSegmentBoundary` resolved the store outside the try implementing its own degradation, so a
// store-less `getStore()` threw out of `foldCall` → `foldEntries` → `poll`. `readNewText` advances
// `_offset` over the whole batch before `foldEntries` folds any of it, which makes such a throw
// permanent loss rather than a retry.
//
// This is the guard over the whole chain rather than over either half: the production token values,
// folded in a single poll, on a watcher whose archival is armed and whose store is not initialized —
// the shape an MCP restart mid-session produces. The dip must open no epoch, so nothing is
// archived and nothing is lost. `test/fold.segment-boundary.test.js` pins the criterion clause by
// clause and `test/fold.boundary-durability.test.js` pins the degradation around the archive; neither
// asserts that one poll over the real transcript keeps every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeStoreGlobal } from '../lib/store.js';
import { getHistory } from '../lib/history.js';
import { makeWatcher, feedAssistantStep } from './helpers/fold-feed.js';

// `feedAssistantStep` stamps each step exactly one second after its predecessor, and `getHistory` copies
// that stamp through, so the gap between two consecutive points is one step unless a call was lost —
// which doubles the one pair it fell between and leaves the first and last stamps untouched. The check
// below is therefore per-pair, not first-to-last.
const FEED_STEP_MS = 1000;

// The transcript the root cause was reproduced against: two consecutive calls carry an IDENTICAL
// `cacheRead` while `cache_creation` falls 2927 → 1383 — a 1544-token, 0.57% shrink of a conversation
// prefix that never moved. Every other step grows the stock, so that dip is the batch's only drop.
const CALLS = [
  { cacheRead: 260000, cacheCreation: 7756, input: 2 },  // stock 267758
  { cacheRead: 267758, cacheCreation: 2927, input: 2 },  // stock 270687
  { cacheRead: 267758, cacheCreation: 1383, input: 2 },  // stock 269143 — the dip
  { cacheRead: 269143, cacheCreation: 1500, input: 2 },  // stock 270645
  { cacheRead: 270645, cacheCreation: 1800, input: 2 },  // stock 272447
];

test('a store-less restart folds every call across the dip', () => {
  // The restart: `_sessionId` arms archival, and the process-wide singleton is gone, so any boundary
  // that fires reaches a `getStore()` that throws. Closed per test — the singleton outlives a file.
  closeStoreGlobal();
  const w = makeWatcher({ sessionId: 'restart-sid' });
  // The replay valve holds every read at byte 0, so the whole transcript accumulates in the file and
  // ONE poll folds it as a single batch — the production shape, where `_offset` is already at EOF
  // before the first entry folds.
  w._replayByteLimit = 0;
  for (const row of CALLS) feedAssistantStep(w, { ...row, output: 5 });
  assert.equal(w._calls.length, 0, 'the valve held: nothing folded until the one poll below');
  delete w._replayByteLimit;
  assert.doesNotThrow(() => w.poll());

  assert.equal(w._calls.length, CALLS.length, 'every call in the batch folded');
  assert.equal(w._segment, 0, 'the dip is no context reset, so no boundary looked for a store');
  assert.equal(w.getStatus().foldErrors, 0, 'no entry cost anything');

  const points = getHistory(w);
  assert.deepEqual(points.map(p => p.foldedSeq), CALLS.map((_, i) => i + 1),
    'the chart carries one point per call, in sequence');
  const stamps = points.map(p => Date.parse(p.ts));
  assert.deepEqual(stamps.slice(1).map((t, i) => t - stamps[i]),
    Array(CALLS.length - 1).fill(FEED_STEP_MS),
    'every consecutive pair is one feed step apart: no call was dropped out of the middle');
});
