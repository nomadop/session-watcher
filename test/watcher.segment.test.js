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
