// test/watcher.segment.test.js
// Segmentation TRIGGER tests (Round-2 T1, #3): a mid-session cache EXPIRY
// (cacheRead≈0 while cache_creation carries the full context — context is being
// RE-CACHED, not dropped) must NOT open a spurious L=0 segment. A genuine
// /clear|/compact (whole context shrinks: cacheRead drops AND cacheCreation small)
// MUST still segment. L stays cacheRead everywhere; only the trigger changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function line(obj) { return JSON.stringify(obj) + '\n'; }
// Row helper with INDEPENDENT control of cacheRead and cacheCreation (the existing
// fold-test helper hard-codes cacheCreation, which cannot express a cache-expiry row).
function asst(id, uuid, cacheRead, cacheCreation, output = 10, input = 100) {
  return { type: 'assistant', uuid, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-8', usage: {
      input_tokens: input, output_tokens: output,
      cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead } } };
}
function tmpJsonl(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-seg-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);
  return p;
}

test('cache-expiry does NOT segment: cacheRead=0 with cacheCreation≈full context stays one segment', () => {
  // Growth rows: cacheRead climbing, modest cacheCreation → segmentMaxTotal ≈ 202000.
  // Then a cache-expiry row: cacheRead=0 but cacheCreation = the full carried context
  // (~202000). Total is UNCHANGED → context was NOT dropped → no new segment.
  const p = tmpJsonl(
    line(asst('m1', 'u1', 100000, 2000)) +
    line(asst('m2', 'u2', 150000, 2000)) +
    line(asst('m3', 'u3', 200000, 2000)) +   // segmentMaxTotal = 202000
    line(asst('m4', 'u4', 0, 202000)) +        // CACHE EXPIRY: total 202000, unchanged → NO segment
    line(asst('m5', 'u5', 202000, 2000))       // re-cache read back → same segment continues
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._segment, 0, 'cache-expiry row must NOT open a new segment');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'all calls remain in one segment');
  assert.equal(w._calls.length, 5, 'all five unique calls folded');
  // L stays cacheRead: the expiry row is recorded with cacheRead=0 (stock actually read from cache).
  const expiry = w._calls.find(c => c.messageId === 'm4');
  assert.equal(expiry.cacheRead, 0, 'L (cacheRead) semantics unchanged on the expiry row');
});

test('real /clear DOES segment: cacheRead=0 with SMALL cacheCreation (fresh context) opens a new segment', () => {
  // Growth rows → segmentMaxTotal ≈ 202000. Then a genuine /clear: cacheRead=0 AND
  // cacheCreation small (only the fresh turn / summary) → total collapses → segment.
  const p = tmpJsonl(
    line(asst('m1', 'u1', 100000, 2000)) +
    line(asst('m2', 'u2', 150000, 2000)) +
    line(asst('m3', 'u3', 200000, 2000)) +   // segmentMaxTotal = 202000
    line(asst('m4', 'u4', 0, 5000))            // /clear: total 5000 << 202000 → NEW segment
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._segment, 1, 'a genuine context shrink must open a new segment');
  assert.equal(w._calls[3].segment, w._calls[0].segment + 1, 'the /clear row starts segment 1');
});

test('regression: monotonic cacheRead growth yields exactly ONE segment (no spurious splits)', () => {
  const p = tmpJsonl(
    line(asst('m1', 'u1', 100000, 2000)) +
    line(asst('m2', 'u2', 120000, 2000)) +
    line(asst('m3', 'u3', 140000, 2000)) +
    line(asst('m4', 'u4', 160000, 2000)) +
    line(asst('m5', 'u5', 180000, 2000))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._segment, 0, 'monotonic growth never segments');
  assert.equal(new Set(w._calls.map(c => c.segment)).size, 1, 'exactly one segment');
});
