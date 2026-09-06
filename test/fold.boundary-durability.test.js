// The archival side of a segment boundary is best-effort: `handleSegmentBoundary` degrades to "the
// segment still rotates, the sweep retries the archive". These pin that the degradation covers the
// WHOLE archival attempt — including resolving the store — so a failure there can never cost the
// entries `readNewText` already consumed by advancing `_offset`. The second group generalizes that
// rule to ANY per-entry throw, and pins the counter that reports the entries it costs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { closeStoreGlobal } from '../lib/store.js';
import { makeWatcher, feedAssistantStep, feedReadFull } from './helpers/fold-feed.js';

// The production shape after an MCP restart mid-session: a watcher with a sessionId (archival armed),
// no injected store, and no global singleton yet — so `getStore()` throws `Store not initialized`.
// Called per test: the singleton is process-wide, and two tests in one file share it.
function makeStorelessWatcher() {
  closeStoreGlobal();
  return makeWatcher({ sessionId: 'durability-sid' });
}

// A 270000-stock call followed by a context reset: the stock collapses 90%, far past the 67500 floor.
function feedContextReset(w) {
  feedAssistantStep(w, { cacheRead: 267000, cacheCreation: 2998, input: 2 });
  feedAssistantStep(w, { cacheRead: 20000, cacheCreation: 6000, input: 2 });
}

test('a boundary with no store does not throw', () => {
  const w = makeStorelessWatcher();
  assert.doesNotThrow(() => feedContextReset(w));
  assert.equal(w._segment, 1, 'the segment rotates even though nothing was archived');
  assert.equal(w._calls.length, 2, 'both calls fold');
});

test('entries after the boundary still fold', () => {
  const w = makeStorelessWatcher();
  // The replay valve (lib/replay.js drives it the same way) holds every read at byte 0, so the three
  // appends accumulate in the file and ONE poll folds them as a single batch — the production shape
  // where `_offset` jumps to EOF before any folding and a mid-batch throw is unrecoverable.
  w._replayByteLimit = 0;
  feedContextReset(w);
  feedAssistantStep(w, { cacheRead: 26000, cacheCreation: 500, input: 2 });
  assert.equal(w._calls.length, 0, 'the valve held: nothing folded until the one poll below');
  delete w._replayByteLimit;
  w.poll();
  assert.equal(w._calls.length, 3, 'the boundary consumes no entry from the batch');
  assert.equal(w._calls[1].segment, 1, 'the boundary fell on the row whose stock dropped');
  assert.equal(w._calls[2].segment, 1, 'the tail of the batch folds into the new segment');
});

test('an archive failure does not abort the fold', () => {
  const w = makeStorelessWatcher();
  w.setStore({ archiveSegmentProfile() { throw new Error('db locked'); } });
  assert.doesNotThrow(() => feedContextReset(w));
  assert.equal(w._segment, 1);
  assert.equal(w._calls.length, 2);
});

// The general net: `readNewText` advances `_offset` over the whole batch before `foldEntries` folds any
// of it, so no entry here is ever re-read and a throw that escapes the loop takes every entry behind it.
// These pin the blast radius at one entry — for ANY per-entry throw, not just an archival one — and the
// increment at `getStatus().foldErrors`. That counter is a LOWER BOUND on lost measurement, not a count
// of entries: a replay re-folds the active path so one persistently faulting entry increments once per
// replay, and a throw part-way through a multi-block entry loses the rest of that entry's blocks for the
// same one increment. One fault, one increment is all these cases claim.
// No sessionId here: the archival guard in `handleSegmentBoundary` is inert, so the store plays no part.
const READ_BEFORE = '/proj/before.txt';
const READ_FAULTING = '/proj/faulting.txt';
const READ_AFTER = '/proj/after.txt';

// Three Read steps queued behind the replay valve, then one poll folds them as a single batch with
// `_bRebuild.apply` armed to throw on the middle Read. Each step is two entries — the assistant usage
// row, then the user tool_result that applies the B update — so the throw lands on exactly one entry
// with folded entries on both sides. `.txt` keeps symbol-outline's grammar warmup out of the fixture;
// the rising cacheRead keeps every step inside one segment (a drop would be a segment boundary).
function feedReadsFaultingTheMiddle(w) {
  w._replayByteLimit = 0;
  feedReadFull(w, READ_BEFORE, 'before line\n'.repeat(12), { cacheRead: 10000 });
  feedReadFull(w, READ_FAULTING, 'faulting line\n'.repeat(12), { cacheRead: 11000 });
  feedReadFull(w, READ_AFTER, 'after line\n'.repeat(12), { cacheRead: 12000 });
  assert.equal(w._calls.length, 0, 'the valve held: nothing folded, so no apply has run yet');
  delete w._replayByteLimit;
  // A Read tool_result makes exactly one `_bRebuild.apply` call, so the applies run one per step in
  // file order and the SECOND one is the middle step's — measured against this fixture, not assumed.
  const apply = w._bRebuild.apply.bind(w._bRebuild);
  let applies = 0;
  w._bRebuild.apply = (...args) => {
    if (++applies === 2) throw new Error('apply fault');
    return apply(...args);
  };
  return w;
}

test('a throwing entry does not abort the batch', () => {
  const w = feedReadsFaultingTheMiddle(makeWatcher());
  assert.doesNotThrow(() => w.poll());
  // cacheRead identifies each step by the value the fixture fed it — every usage row folds, the faulting
  // step's included (its usage row precedes its tool_result).
  assert.deepEqual(w._calls.map(c => c.cacheRead), [10000, 11000, 12000], 'every usage row folds');
  assert.ok(w._bRebuild.paths.has(READ_BEFORE), 'the Read before the fault keeps its B update');
  assert.ok(w._bRebuild.paths.has(READ_AFTER), 'the Read after the fault keeps its B update');
  assert.equal(w._bRebuild.paths.has(READ_FAULTING), false, 'the faulting entry is the whole loss');
});

test('a fold error is visible in status', () => {
  const w = feedReadsFaultingTheMiddle(makeWatcher());
  w.poll();
  assert.equal(w.getStatus().foldErrors, 1, 'one entry lost, one entry reported');
});

// The deferred-ledger finalization is the one part of `handleSegmentBoundary` that runs before
// `segmentReset`, so a throw inside it leaves the segment un-rotated with `_prevTotalStock` still at the
// pre-drop value — the drop condition stays true and every following low-stock row re-enters the
// boundary. The finalization therefore has to be re-entrant. Two Reads of the same ~12.5k-token file
// with 8000 of cacheRead growth between them bank ~4.5k per path (settleDeferred banks the B-surplus L
// has not confirmed), so the ledger holds two paths by the time the boundary arrives.
const LEDGER_APPLIED = '/proj/ledger-applied.txt';
const LEDGER_FAULTING = '/proj/ledger-faulting.txt';

function feedTwoPathLedger(w) {
  const body = 'const filler = "some text on this line";\n'.repeat(700);
  feedReadFull(w, LEDGER_APPLIED, body, { cacheRead: 50000 });
  feedReadFull(w, LEDGER_FAULTING, body, { cacheRead: 58000 });
  feedAssistantStep(w, { cacheRead: 66000, output: 5 });
  assert.equal(w._bLagLedger.byPath.size, 2, 'the fixture banked a deferred amount for each path');
  return w;
}

test('a boundary that throws mid-finalization re-applies no correction', () => {
  const w = feedTwoPathLedger(makeWatcher());
  const deferred = w._bLagLedger.byPath.get(LEDGER_APPLIED);
  const beforeCorrection = w._bRebuild.pathTotal(LEDGER_APPLIED);
  assert.ok(deferred > 1 && deferred < beforeCorrection, 'the deferred amount is a visible slice of the bucket');
  // The second path's correction throws, so the attempt aborts part-way with one correction applied —
  // the state a re-entry would double-apply. `corrected` records every path the finalization touches,
  // across both attempts.
  const corrected = [];
  const addCorrection = w._bRebuild.addCorrection.bind(w._bRebuild);
  w._bRebuild.addCorrection = (p, amt) => {
    corrected.push(p);
    if (p === LEDGER_FAULTING) throw new Error('correction fault');
    return addCorrection(p, amt);
  };
  feedAssistantStep(w, { cacheRead: 5000, output: 5 });
  assert.equal(w._segment, 0, 'the throw cost the rotation: segmentReset never ran');
  assert.equal(w.getStatus().foldErrors, 1, 'the aborted boundary is one lost entry');
  assert.equal(w._bRebuild.pathTotal(LEDGER_APPLIED), beforeCorrection - deferred, 'the correction applied once');
  assert.equal(w._bLagLedger.total, 0, 'the ledger was taken before it was applied: nothing is left to re-apply');
  // Still far below the stale `_prevTotalStock`, so this row re-enters the boundary.
  feedAssistantStep(w, { cacheRead: 5100, output: 5 });
  assert.deepEqual(corrected, [LEDGER_APPLIED, LEDGER_FAULTING],
    'the re-entry applies nothing a second time — B does not drift down per re-entry');
  assert.equal(w._segment, 1, 'the re-entered boundary finds an empty ledger and completes');
});

test('foldErrors survives a segment boundary', () => {
  const w = feedReadsFaultingTheMiddle(makeWatcher());
  w.poll();
  feedContextReset(w);
  assert.equal(w._segment, 1, 'the context reset rotated the segment');
  assert.equal(w.getStatus().foldErrors, 1, 'segmentReset leaves the counter alone');
  // A truncated transcript takes readNewText's rotation guard, which runs resetFoldState on the way out.
  writeFileSync(w.path, '');
  w.poll();
  assert.equal(w._activeLeafUuid, null, 'the rotation guard reached resetFoldState');
  assert.equal(w.getStatus().foldErrors, 1, 'resetFoldState leaves the counter alone');
});
