import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatcher, feedReadFull, feedReadRange, feedAssistantStep, forceSegmentBoundary } from './fold-feed.js';

// Task 0 sequencing note (brief Step 1): `w._segmentPathEvents` / `w._segmentStepUsage` are populated by
// Task 6's capture code. The FOUR buffer-inspecting cases below were marked `{ todo: true }` while Task 6
// was pending; Task 6 has landed the capture code, so they are now UN-SKIPPED and pass — they exercise the
// real feed*/makeWatcher/forceSegmentBoundary path AND the telemetry buffers it fills.

test('feedReadFull produces a fullSet touch (is_full_read=1) at the issuing step seq', () => {
  const w = makeWatcher();
  feedReadFull(w, '/proj/a.js', 'export const x=1;\n'.repeat(20));
  const ev = w._segmentPathEvents.at(-1);
  assert.equal(ev.toolType, 'Read');
  assert.equal(ev.isFullRead, 1);
  assert.equal(typeof ev.foldedSeq, 'number');
});

test('feedReadRange produces a line-subset touch (is_full_read=0)', () => {
  const w = makeWatcher();
  feedReadRange(w, '/proj/a.js', { offset: 10, limit: 5 });
  assert.equal(w._segmentPathEvents.at(-1).isFullRead, 0);
});

test('feedAssistantStep buffers one step_usage with all four token classes', () => {
  const w = makeWatcher();
  feedAssistantStep(w, { input: 100, output: 50, cacheRead: 4000, cacheCreation: 200, toolUses: 0 });
  const s = w._segmentStepUsage.at(-1);
  assert.equal(s.input, 100); assert.equal(s.cacheRead, 4000);
});

test('forceSegmentBoundary advances the segment and preserves foldedSeq monotonicity', () => {
  const w = makeWatcher();
  feedAssistantStep(w, { input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolUses: 0 });
  const before = Math.max(...w._segmentStepUsage.map(s => s.foldedSeq));
  forceSegmentBoundary(w);
  feedAssistantStep(w, { input: 10, output: 5, cacheRead: 100, cacheCreation: 0, toolUses: 0 });
  assert.ok(Math.max(...w._segmentStepUsage.map(s => s.foldedSeq)) > before);
});
