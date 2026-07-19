// test/historyChart.hoverLinkage.test.js — hover linkage segment-local mapping
// Verifies that history points carry foldedSeq and that the segment-local offset
// computation produces correct chart indices for multi-segment sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';
import { getHistory } from '../lib/history.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-hover-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (id, cr, cc, out, uuid, parent, input = 100) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: {
    input_tokens: input, output_tokens: out,
    cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });

test('history points carry foldedSeq field', () => {
  const path = tmpJsonl([
    asst('m1', 10000, 2000, 10, 'u1'),
    asst('m2', 20000, 2000, 10, 'u2', 'u1'),
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);
  assert.ok(pts.length >= 1, 'at least one point');
  assert.ok(pts.every(p => typeof p.foldedSeq === 'number'), 'every point has foldedSeq');
  // foldedSeq should be monotonically increasing
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].foldedSeq > pts[i - 1].foldedSeq, `foldedSeq increases: ${pts[i].foldedSeq} > ${pts[i - 1].foldedSeq}`);
  }
});

test('multi-segment: segment 2 foldedSeq continues from segment 1', () => {
  // Build a uuid-less session (no tree) so the totalStock fallback triggers segment boundary.
  // Active-path filtering only applies to uuid-bearing sessions; uuid-less sessions fold all rows.
  const path = tmpJsonl([
    asst('m1', 100000, 2000, 10),
    asst('m2', 200000, 2000, 10),
    asst('m3', 300000, 2000, 10),
    // /clear: totalStock collapses → new segment (uuid-less fallback)
    asst('m4', 0, 5000, 10),
    asst('m5', 10000, 2000, 10),
    asst('m6', 20000, 2000, 10),
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const pts = getHistory(w);

  // Group points by segment
  const seg0 = pts.filter(p => p.segment === 0);
  const seg1 = pts.filter(p => p.segment === 1);
  assert.ok(seg0.length >= 1, 'segment 0 has points');
  assert.ok(seg1.length >= 1, 'segment 1 has points');

  // Segment 1's first foldedSeq > segment 0's last foldedSeq (global counter, no reset)
  assert.ok(
    seg1[0].foldedSeq > seg0[seg0.length - 1].foldedSeq,
    `seg1 first foldedSeq (${seg1[0].foldedSeq}) > seg0 last (${seg0[seg0.length - 1].foldedSeq})`,
  );
});

test('segment-local mapping: global foldedSeq maps to correct chart index', () => {
  // Simulate the mapping logic from historyChart.js onBucketHover:
  //   segOffset = currentPoints[0].foldedSeq - 1
  //   localSeq = lastCallSeq - segOffset
  // Given segment 2 starting at foldedSeq=100, lastCallSeq=103 should map to local index 4.

  // Mock currentPoints for segment 2 (5 points starting at foldedSeq 100)
  const currentPoints = [
    { foldedSeq: 100, L: 10000 },
    { foldedSeq: 101, L: 12000 },
    { foldedSeq: 102, L: 14000 },
    { foldedSeq: 103, L: 16000 },
    { foldedSeq: 104, L: 18000 },
  ];

  // The mapping logic extracted from onBucketHover
  function mapToLocal(lastCallSeq, points) {
    const segOffset = points.length > 0
      ? (points[0].foldedSeq ?? 1) - 1
      : 0;
    const localSeq = lastCallSeq - segOffset;
    if (localSeq < 1 || localSeq > points.length) return null;
    return localSeq;
  }

  // foldedSeq 103 → local index 4 (103 - (100-1) = 4)
  assert.equal(mapToLocal(103, currentPoints), 4);
  // foldedSeq 100 → local index 1 (first point)
  assert.equal(mapToLocal(100, currentPoints), 1);
  // foldedSeq 104 → local index 5 (last point)
  assert.equal(mapToLocal(104, currentPoints), 5);
  // foldedSeq 99 → null (before this segment)
  assert.equal(mapToLocal(99, currentPoints), null);
  // foldedSeq 105 → null (beyond this segment)
  assert.equal(mapToLocal(105, currentPoints), null);
});

test('segment-local mapping: single-segment (foldedSeq starts at 1) works unchanged', () => {
  // For a fresh session with no prior segments, foldedSeq starts at 1
  const currentPoints = [
    { foldedSeq: 1, L: 5000 },
    { foldedSeq: 2, L: 8000 },
    { foldedSeq: 3, L: 11000 },
  ];

  function mapToLocal(lastCallSeq, points) {
    const segOffset = points.length > 0
      ? (points[0].foldedSeq ?? 1) - 1
      : 0;
    const localSeq = lastCallSeq - segOffset;
    if (localSeq < 1 || localSeq > points.length) return null;
    return localSeq;
  }

  // In single-segment, segOffset = 0, so localSeq == lastCallSeq
  assert.equal(mapToLocal(1, currentPoints), 1);
  assert.equal(mapToLocal(2, currentPoints), 2);
  assert.equal(mapToLocal(3, currentPoints), 3);
  assert.equal(mapToLocal(4, currentPoints), null);
  assert.equal(mapToLocal(0, currentPoints), null);
});

test('segment-local mapping: empty points returns null gracefully', () => {
  function mapToLocal(lastCallSeq, points) {
    const segOffset = points.length > 0
      ? (points[0].foldedSeq ?? 1) - 1
      : 0;
    const localSeq = lastCallSeq - segOffset;
    if (localSeq < 1 || localSeq > points.length) return null;
    return localSeq;
  }

  // Empty array: any lastCallSeq should be out of bounds
  assert.equal(mapToLocal(1, []), null);
  assert.equal(mapToLocal(100, []), null);
});
