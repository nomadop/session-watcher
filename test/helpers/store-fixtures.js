// Store fixtures for the carry-staleness telemetry tests (Task 0).
//
// Colocated with fold-feed/server-boot so the direct-store tests (Tasks 7/8/10) share ONE definition of a
// minimal-but-valid segment snapshot and a pre-seeded store. `snap()` mirrors the field口径 that
// lib/fold.js buildSegmentSnapshot produces (the canonical live producer) so a snapshot archived via this
// helper is indistinguishable from a real one to store._segmentArgs / archiveSegmentProfile.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore } from '../../lib/store.js';

// A minimal valid segment-snapshot object for archiveSegmentProfile. All fields are `?? null` in
// store._segmentArgs, so none is strictly required for the INSERT, but a meaningful profile row carries
// the full set buildSegmentSnapshot emits. `archiveSource` drives ARCHIVE_PRIORITY (snapshot=1, replay=2,
// live=3) — the priority guard that gates whether an upsert wins. `overrides.priority` is sugar to pick a
// source without knowing the mapping: priority 1→snapshot, 2→replay, 3→live.
export function snap(overrides = {}) {
  const { priority, ...rest } = overrides;
  const bySource = { 1: 'snapshot', 2: 'replay', 3: 'live' };
  const archiveSource = rest.archiveSource ?? (priority != null ? bySource[priority] ?? 'snapshot' : 'snapshot');
  return {
    archivedAt: Date.now(),
    archiveSource,
    model: 'claude-opus-4-8',
    projectId: 'proj-fixture',
    lFloor: 30000,
    bTotal: 42000,
    lPeak: 55000,
    gFinal: 2000,
    oAvg: 350,
    cRatio: 5,
    turns: 12,
    durationMs: 60000,
    totalTokensRead: 8000,
    mf: 0.4,
    ppExit: 0.2,
    brExit: 0.3,
    brPeak: 0.5,
    ppPeak: 0.35,
    p0: 3.0,
    bAxis: 0.35,
    xAxis: 1.8,
    gMin: 1500,
    turnAtBrAmber: 6,
    ...rest,
  };
}

// A temp-DB store with ONE archived profile row at segment 0 (for the Task 7/8/10 direct store tests).
// Returns { store, sessionId, dbPath, teardown }. The caller closes via teardown() (closeStore on its own
// connection — never closeStoreGlobal, this store is NOT the global singleton).
export function setupStore({ sessionId = 'sid-fixture', paths = [{ path: '/proj/a.js', tokens: 4000 }] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-store-'));
  const dbPath = join(dir, 'store.sqlite');
  const store = openStore(dbPath);
  store.archiveSegmentProfile(sessionId, 0, snap(), paths);
  return {
    store,
    sessionId,
    dbPath,
    teardown() { try { closeStore(store); } catch {} },
  };
}
