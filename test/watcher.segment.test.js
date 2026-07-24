// test/watcher.segment.test.js — v3 segmentation (totalStock any-drop, spec §6.6)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-seg-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const asst = (id, cr, cc, out, uuid, parent, input = 100) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: {
    input_tokens: input, output_tokens: out,
    cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });

test('cache-expiry does NOT segment: cr=0 with cc≈full context → totalStock unchanged', () => {
  // totalStock = cr + cc + input. Growth rows build totalStock up. Then cache-expiry: cr→0 but
  // cc picks up the full context → totalStock remains ≈ same → no segment.
  const path = tmpJsonl([
    asst('m1', 100000, 2000, 10, 'u1'),
    asst('m2', 150000, 2000, 10, 'u2', 'u1'),
    asst('m3', 200000, 2000, 10, 'u3', 'u2'),     // totalStock ≈ 202100
    asst('m4', 0, 202000, 10, 'u4', 'u3'),         // CACHE EXPIRY: totalStock = 0+202000+100 = 202100 → no drop
    asst('m5', 202000, 2000, 10, 'u5', 'u4'),      // re-cache read back → same segment
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._segment, 0, 'cache-expiry row must NOT open a new segment');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'all calls remain in one segment');
});

test('real /clear DOES segment: topology signal (null-parent root)', () => {
  // A real /clear produces a new null-parent root (disconnected subtree). The topology signal
  // in indexRow detects this and fires segmentReset via _compactDetected.
  const path = tmpJsonl([
    asst('m1', 100000, 2000, 10, 'u1'),
    asst('m2', 200000, 2000, 10, 'u2', 'u1'),     // totalStock ≈ 202100
    asst('m3', 0, 5000, 10, 'u3', null),           // /clear: new null-parent root → segment
    asst('m4', 10000, 2000, 10, 'u4', 'u3'),       // first response in new segment
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._segment, 1, 'a genuine context shrink must open a new segment');
  // Active path is u3→u4 (new subtree); u3 is the compact-triggering row (segment 1)
  const seg1Calls = w._calls.filter(c => c.segment === 1);
  assert.ok(seg1Calls.length >= 1, 'at least one call in new segment');
});

test('monotonic totalStock growth yields exactly ONE segment (no spurious splits)', () => {
  const path = tmpJsonl([
    asst('m1', 100000, 2000, 10, 'u1'),
    asst('m2', 120000, 2000, 10, 'u2', 'u1'),
    asst('m3', 140000, 2000, 10, 'u3', 'u2'),
    asst('m4', 160000, 2000, 10, 'u4', 'u3'),
    asst('m5', 180000, 2000, 10, 'u5', 'u4'),
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  assert.equal(w._segment, 0, 'monotonic growth never segments');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'exactly one segment');
});

test('segment reset clears B_rebuild paths and bumps _segmentEpoch', () => {
  const path = tmpJsonl([
    asst('m1', 50000, 2000, 10, 'u1'),
    asst('m2', 60000, 2000, 10, 'u2', 'u1'),
    asst('m3', 5000, 2000, 10, 'u3', null),   // null-parent root → topology segment
  ]);
  const w = new SessionWatcher(path);
  const epoch0 = w._segmentEpoch;
  w.poll();
  assert.ok(w._segmentEpoch > epoch0, 'epoch bumped on segment boundary');
  assert.equal(w._bRebuild.paths.size, 0, 'B_rebuild cleared on reset');
  assert.equal(w._segment, 1, 'segment counter advanced');
});

test('getTerminalSnapshot includes segment index', () => {
  const path = tmpJsonl([
    asst('m1', 50000, 2000, 10, 'u1'),
    asst('m2', 60000, 2000, 10, 'u2', 'u1'),
    asst('m3', 5000, 2000, 10, 'u3', null),   // topology segment → _segment becomes 1
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  const snap = w.getTerminalSnapshot();
  assert.equal(snap.segment, w._segment, 'terminal snapshot carries current segment');
});

test('constructor threads sessionId/projectId; getSegmentIndex returns current segment', () => {
  const path = tmpJsonl([ asst('m1', 50000, 2000, 10, 'u1') ]);
  const w = new SessionWatcher(path, null, { sessionId: 'sid-x', projectId: 'proj-y' });
  assert.equal(w._sessionId, 'sid-x');
  assert.equal(w._projectId, 'proj-y');
  w.poll();
  assert.equal(w.getSegmentIndex(), w._segment);
});

test('segment peak/accumulator fields default correctly before any poll (R1-G)', () => {
  const path = tmpJsonl([ asst('m1', 50000, 2000, 10, 'u1') ]);
  const w = new SessionWatcher(path);
  // Assert defaults BEFORE poll — accumulation tests belong in Task 6 (after the hook is wired).
  assert.equal(w._segmentLPeak, 0);
  assert.equal(w._segmentGMin, Infinity);
  assert.equal(w._segmentInputTokens, 0);
  assert.equal(w._segmentBrPeak, 0);
  assert.equal(w._segmentPpPeak, 0);
  assert.equal(w._segmentOutputSum, 0);
  assert.equal(w._segmentUsageCount, 0);
});

test('segmentReset resets peak accumulators (called via topology boundary)', () => {
  const path = tmpJsonl([
    asst('m1', 50000, 2000, 10, 'u1'),
    asst('m2', 60000, 2000, 10, 'u2', 'u1'),
    asst('m3', 5000, 2000, 10, 'u3', null),   // topology segment → segmentReset fires
  ]);
  const w = new SessionWatcher(path);
  w.poll();
  // After segmentReset, the NEW segment's first call (m3) is folded and accumulates.
  // Verify the new segment reflects ONLY m3 — old segment's larger peaks are gone (R1-G).
  assert.equal(w._segmentLPeak, 5000, 'L peak reflects only new segment call (m3 cacheRead=5000)');
  assert.equal(w._segmentBrPeak, 0, 'br peak 0 — B=0 on new segment first call');
  assert.equal(w._segmentPpPeak, 0, 'pp peak 0 — B=0 on new segment first call');
  assert.equal(w._segmentTurnAtBrAmber, null);
  assert.equal(w._segmentOutputSum, 10, 'only m3 output accumulated');
  assert.equal(w._segmentUsageCount, 1, 'only m3 counted');
  assert.equal(w._segmentInputTokens, 100, 'only m3 input_tokens accumulated');
  assert.equal(w._segmentFirstTs, null, 'no timestamp in test fixture');
  assert.equal(w._segmentLastTs, null, 'no timestamp in test fixture');
});

test('projectId falls back to CLAUDE_PROJECT_ID env var', () => {
  const orig = process.env.CLAUDE_PROJECT_ID;
  try {
    process.env.CLAUDE_PROJECT_ID = 'env-proj-z';
    const path = tmpJsonl([ asst('m1', 50000, 2000, 10, 'u1') ]);
    const w = new SessionWatcher(path);
    assert.equal(w._projectId, 'env-proj-z');
  } finally {
    if (orig === undefined) delete process.env.CLAUDE_PROJECT_ID;
    else process.env.CLAUDE_PROJECT_ID = orig;
  }
});

test('_lastArchivedSegment initialized', () => {
  const path = tmpJsonl([ asst('m1', 50000, 2000, 10, 'u1') ]);
  const w = new SessionWatcher(path);
  assert.equal(w._lastArchivedSegment, -1);
});
