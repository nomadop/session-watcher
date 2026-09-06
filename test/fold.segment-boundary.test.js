// A segment opens on a context reset, not on a stock dip. The topology signal
// (`w._compactDetected`) is the primary detector; these clauses drive the stock-drop fallback in
// `foldCall`, which judges one field — the Context Stock against a floor relative to itself. Nothing
// else is consulted, so every clause below is decided by that floor alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatcher, feedAssistantStep } from './helpers/fold-feed.js';

test('the observed dip does not open a segment', () => {
  // The reproduced false positive: cache_creation 2927 → 1383, stock 270687 → 269143 — a 1544-token,
  // 0.57% shrink against a floor of 67671.75.
  const w = makeWatcher();
  feedAssistantStep(w, { cacheRead: 267758, cacheCreation: 2927, input: 2 });
  feedAssistantStep(w, { cacheRead: 267758, cacheCreation: 1383, input: 2 });
  assert.equal(w._segment, 0, 'a sub-1% dip is not a context reset');
  assert.equal(w._calls.length, 2, 'both calls fold into the one segment');
});

test('a context reset still opens a segment', () => {
  // /clear or /compact: the whole prefix is replaced, so the stock falls by tens of percent — 270687 →
  // 26002, far past the floor.
  const w = makeWatcher();
  feedAssistantStep(w, { cacheRead: 267758, cacheCreation: 2927, input: 2 });
  feedAssistantStep(w, { cacheRead: 20000, cacheCreation: 6000, input: 2 });
  assert.equal(w._segment, 1);
});

test('a cache eviction still does not open a segment', () => {
  // An eviction re-carries the context in cache_creation, so the stock is preserved and classifyMiss
  // reconstructs L from cacheRead + cacheCreation.
  const w = makeWatcher();
  feedAssistantStep(w, { cacheRead: 267758, cacheCreation: 2927, input: 2 });
  feedAssistantStep(w, { cacheRead: 0, cacheCreation: 270685, input: 2 });
  assert.equal(w._segment, 0);
  assert.equal(w._calls[1].miss, true);
});

test('the floor is relative to the previous stock', () => {
  // 270002 × SEGMENT_DROP_FRACTION = 67500.5, an order of magnitude above SEGMENT_DROP_EPSILON. Both
  // halves release cache_creation while cacheRead holds at 200000 — the same prefix re-read on both
  // sides of the verdict — so the magnitude of the stock drop is the only thing that separates them.
  const inside = makeWatcher();
  feedAssistantStep(inside, { cacheRead: 200000, cacheCreation: 70000, input: 2 });   // stock 270002
  feedAssistantStep(inside, { cacheRead: 200000, cacheCreation: 10000, input: 2 });   // stock 210002, −22.2%
  assert.equal(inside._segment, 0, 'a 22.2% drop stays inside the floor');

  const outside = makeWatcher();
  feedAssistantStep(outside, { cacheRead: 200000, cacheCreation: 70000, input: 2 });  // stock 270002
  feedAssistantStep(outside, { cacheRead: 200000, cacheCreation: 0, input: 2 });      // stock 200002, −25.9%
  assert.equal(outside._segment, 1, 'a 25.9% drop clears the floor');
});

test('a small transcript keeps the absolute floor', () => {
  // 200 × SEGMENT_DROP_FRACTION = 50, under SEGMENT_DROP_EPSILON, so Math.max hands the decision to
  // the 100-token floor. An 80-token drop therefore holds the segment open even though it clears the
  // relative term — drop SEGMENT_DROP_EPSILON from the Math.max and this assertion flips.
  const held = makeWatcher();
  feedAssistantStep(held, { cacheRead: 150, cacheCreation: 48, input: 2 });   // stock 200
  feedAssistantStep(held, { cacheRead: 112, cacheCreation: 6, input: 2 });    // stock 120, −80
  assert.equal(held._segment, 0, 'a drop under the absolute floor holds the segment open');

  const opened = makeWatcher();
  feedAssistantStep(opened, { cacheRead: 150, cacheCreation: 48, input: 2 });  // stock 200
  feedAssistantStep(opened, { cacheRead: 40, cacheCreation: 8, input: 2 });    // stock 50, −150
  assert.equal(opened._segment, 1, 'a drop past the absolute floor opens one');
});
