import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';
import { initStore, closeStoreGlobal, getStore } from '../lib/store.js';

let store, dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-segarch-')); });
afterEach(async () => {
  if (store) { const { closeStore } = await import('../lib/store.js'); closeStore(store); store = null; }
  rmSync(dir, { recursive: true, force: true });
});

const snap = (over = {}) => ({ archivedAt: 1000, archiveSource: 'live', model: 'opus',
  projectId: 'p', bTotal: 60000, gFinal: 900, cRatio: 12.5, turns: 10, durationMs: 5000,
  totalTokensRead: 40000, mf: 0.3, ppExit: 0.5, brExit: 0.15, lPeak: 80000, brPeak: 0.2,
  ppPeak: 0.6, gMin: 100, turnAtBrAmber: 4, lFloor: 42000, p0: 3.5, bAxis: 0.5, xAxis: 1.9,
  oAvg: 380, ...over });

test('archiveSegmentProfile: writes profile + paths for a segment', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  const res = store.archiveSegmentProfile('s1', 2, snap(), [{ path: '/a.js', tokens: 100 }, { path: '/b.js', tokens: 200 }]);
  assert.equal(res.status, 'archived');
  const segs = store.getProfileSegments('s1');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].segment, 2);
  assert.equal(segs[0].archiveSource, 'live');
  assert.equal(segs[0].bTotal, 60000);
  const paths = store._db.prepare('SELECT path, tokens FROM profile_paths WHERE session_id=? AND segment=? ORDER BY path').all('s1', 2);
  assert.deepEqual(paths.map(p => ({ path: p.path, tokens: p.tokens })), [{ path: '/a.js', tokens: 100 }, { path: '/b.js', tokens: 200 }]);
});

test('archiveSegmentProfile: higher priority overwrites lower + removes stale paths', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.archiveSegmentProfile('s1', 0, snap({ archiveSource: 'snapshot' }), [{ path: '/a.js', tokens: 100 }, { path: '/gone.js', tokens: 50 }]);
  const res = store.archiveSegmentProfile('s1', 0, snap({ archiveSource: 'live', bTotal: 61000 }), [{ path: '/a.js', tokens: 120 }]);
  assert.equal(res.status, 'archived');
  const paths = store._db.prepare('SELECT path FROM profile_paths WHERE session_id=? AND segment=0').all('s1');
  assert.deepEqual(paths.map(p => p.path), ['/a.js'], 'stale /gone.js removed');
  assert.equal(store.getProfileSegments('s1')[0].bTotal, 61000, 'profile row replaced by higher priority');
});

test('archiveSegmentProfile: lower priority cannot clobber higher (replay does not overwrite live)', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  store.archiveSegmentProfile('s1', 0, snap({ archiveSource: 'live', bTotal: 60000 }), [{ path: '/a.js', tokens: 100 }]);
  const res = store.archiveSegmentProfile('s1', 0, snap({ archiveSource: 'replay', bTotal: 999 }), [{ path: '/x.js', tokens: 1 }]);
  assert.equal(res.status, 'already_archived');
  const seg = store.getProfileSegments('s1')[0];
  assert.equal(seg.bTotal, 60000, 'live row preserved — replay blocked by priority');
  assert.equal(seg.archiveSource, 'live');
  const paths = store._db.prepare('SELECT path FROM profile_paths WHERE session_id=? AND segment=0').all('s1');
  assert.deepEqual(paths.map(p => p.path), ['/a.js'], 'live paths preserved — replay blocked');
});

test('archiveSegmentProfile: inserts when the segment is new (any priority)', async () => {
  const { openStore } = await import('../lib/store.js');
  store = openStore(join(dir, 't.sqlite'));
  const res = store.archiveSegmentProfile('s1', 1, snap({ archiveSource: 'replay' }), [{ path: '/r.js', tokens: 9 }]);
  assert.equal(res.status, 'archived');
  assert.equal(store.getProfileSegments('s1').length, 1);
  assert.equal(store.getProfileSegments('s1')[0].archiveSource, 'replay');
});

// --- Watcher-integration tests (Task 6) ---

function tmpJsonl(targetDir, lines) {
  const p = join(targetDir, 'session.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// UUID-less assistant entries: uses the totalStock-drop heuristic (no compact detection)
// so the foldCall fast path fires handleSegmentBoundary with replayMode:false (live).
const asst = (id, cr, cc, out) => ({ type: 'assistant',
  timestamp: '2026-07-01T00:00:00Z',
  message: { id, model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: out,
    cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });

test('multi-segment session archives each dead segment (live path) + peaks accumulate (R1-G)', () => {
  initStore(join(dir, 'store.sqlite'));
  try {
    const path = tmpJsonl(dir, [
      asst('m1', 50000, 2000, 10),
      asst('m2', 90000, 2000, 10),
      asst('m3', 5000, 2000, 10),     // totalStock drop → segment boundary; segment 0 archived
      asst('m4', 20000, 2000, 10),
    ]);
    const w = new SessionWatcher(path, null, { sessionId: 'sid-multi', projectId: 'p' });
    w.poll();
    const segs = getStore().getProfileSegments('sid-multi');
    assert.ok(segs.some(s => s.segment === 0), 'segment 0 archived on boundary');
    const seg0 = segs.find(s => s.segment === 0);
    assert.equal(seg0.archiveSource, 'live');
    assert.ok(seg0.lPeak >= 90000, 'segment-local L peak captured (accumulation hook wired)');
    assert.ok(seg0.totalTokensRead > 0, 'total_tokens_read accumulated per-call (R1-C)');
  } finally { closeStoreGlobal(); }
});

test('idempotency guard: boundary fired twice for same segment archives once', () => {
  initStore(join(dir, 'store.sqlite'));
  try {
    const path = tmpJsonl(dir, [
      asst('m1', 50000, 2000, 10),
      asst('m2', 5000, 2000, 10),     // totalStock drop → boundary: archives segment 0
    ]);
    const w = new SessionWatcher(path, null, { sessionId: 'sid-idem', projectId: 'p' });
    w.poll();
    const before = getStore().getProfileSegments('sid-idem').length;
    // Re-poll (no new data) must not re-archive.
    w.poll();
    assert.equal(getStore().getProfileSegments('sid-idem').length, before);
  } finally { closeStoreGlobal(); }
});
