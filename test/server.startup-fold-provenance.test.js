// `createServer` folds the whole transcript eagerly before any route or poll tick exists, so every
// segment boundary that fold crosses belongs to history that already happened — a replay, not a live
// capture. The two archival provenance fields must say so: `archiveSource` 'replay' on the profile row
// and `capture_source` 'cc-replay' on its telemetry, the same pair `lib/carry-sweep.js` produces for the
// crash-recovery replay. `foldCall`'s own boundaries hardcode `replayMode: false`, so the flavour can
// only come from the watcher-level `_replayMode` that `handleSegmentBoundary` ORs in — and it must be
// scoped to the eager fold alone, because the poll ticks that follow ARE live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, closeStore } from '../lib/store.js';
import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';

const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

const asst = (id, cr, cc, uuid, parent) => ({ type: 'assistant', uuid, parentUuid: parent,
  message: { id, model: 'claude-opus-4-8', usage: {
    input_tokens: 100, output_tokens: 10,
    cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });

// A prefix replaced in place: the uuid chain stays connected (no new null-parent root, so the topology
// detector stays silent) while the stock falls 202100 → 3100, clearing the relative floor of 50525.
// That is `foldCall`'s stock-drop fallback — the boundary that passes `replayMode: false`.
const RESET_AT_STARTUP = [
  asst('m1', 100000, 2000, 'u1', null),   // stock 102100
  asst('m2', 200000, 2000, 'u2', 'u1'),   // stock 202100
  asst('m3', 0, 3000, 'u3', 'u2'),        // stock 3100 — context reset, opens segment 1
  asst('m4', 3000, 2000, 'u4', 'u3'),     // stock 5100 — segment 1 grows
];

// Appended after the server exists and folded by a LATER watcher.poll(), exactly as the poll timer
// drives it: the same shape of reset, this time observed as it happens.
const RESET_WHILE_LIVE = [
  asst('m5', 100000, 2000, 'u5', 'u4'),   // stock 102100
  asst('m6', 0, 2000, 'u6', 'u5'),        // stock 2100 — context reset, opens segment 2
];

function bootOverTranscript(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-startup-fold-'));
  const transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, jsonl(rows));
  const store = openStore(join(dir, 'store.sqlite'));
  const sessionId = `sf-${randomUUID()}`;
  // `_sessionId` arms archival and the injected store is the connection it archives to, so the boundary
  // never reaches the uninitialized global singleton.
  const watcher = new SessionWatcher(transcript, null, { sessionId });
  watcher.setStore(store);
  const srv = createServer({ watcher, pollIntervalMs: 0, sessionId, store, disableTelemetrySweep: true });
  return {
    store, watcher, transcript, sessionId,
    // The profile row + its telemetry provenance for one segment. `capture_source` has no camelized
    // reader, so it comes off the row directly.
    provenanceOf: (segment) => {
      const profile = store.getProfileSegments(sessionId).find(s => s.segment === segment) || null;
      const row = store._db
        .prepare('SELECT capture_source FROM profile WHERE session_id = ? AND segment = ?')
        .get(sessionId, segment);
      return { archiveSource: profile?.archiveSource ?? null, captureSource: row?.capture_source ?? null };
    },
    append: (moreRows) => appendFileSync(transcript, jsonl(moreRows)),
    teardown: () => {
      srv.stopTimers();
      closeStore(store);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the startup whole-file fold archives a reconstructed segment as a replay', () => {
  const ctx = bootOverTranscript(RESET_AT_STARTUP);
  try {
    assert.deepEqual(ctx.provenanceOf(0), { archiveSource: 'replay', captureSource: 'cc-replay' },
      'the boundary the eager fold crossed reconstructs history, so it is not a live capture');
  } finally { ctx.teardown(); }
});

test('a boundary crossed by a later poll on the same watcher archives as live', () => {
  const ctx = bootOverTranscript(RESET_AT_STARTUP);
  try {
    ctx.append(RESET_WHILE_LIVE);
    ctx.watcher.poll();
    assert.deepEqual(ctx.provenanceOf(1), { archiveSource: 'live', captureSource: 'cc-live' },
      'the eager fold must not leave _replayMode set — live polling is observed, not reconstructed');
    assert.deepEqual(ctx.provenanceOf(0), { archiveSource: 'replay', captureSource: 'cc-replay' },
      'the startup segment keeps its own provenance');
  } finally { ctx.teardown(); }
});
