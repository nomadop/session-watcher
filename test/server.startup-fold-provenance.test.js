// The host's synchronous bootstrap applies the whole Source before any route or poll tick exists, so every
// epoch that bootstrap crosses belongs to history that already happened — a Source Reconstruction, not a live
// capture. The two archival provenance fields must say so: `archiveSource` 'replay' on the profile row and
// `capture_source` 'cc-replay' on its telemetry, the same pair carry reconstruction produces. A segment an
// epoch closes takes the closing FRAME's capture mode, so that provenance is scoped to bootstrap alone and the
// ticks that follow are live; a segment the owner's terminal close archives takes the segment's live mark,
// set once a live frame has applied to it.
//
// Epochs here are opened by explicit source topology — a compact summary is a null-parent root with a call
// behind it.
// The stock-drop fallback that used to open them was retired with the approved epoch-detection delta, so a
// fixture that fell back on it would now archive nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, closeStore } from '../lib/store.js';
import { createServer, createWatcherComposition } from '../server.js';
import { strictWatcherFacade } from './helpers/server-boot.js';
import { assistantToolUse, compactSummary, toolResult, ts, usage } from './helpers/transcript-fixtures.js';

const jsonl = (rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

// One measured step plus its tool result, chained onto `parent`.
const step = ({ id, uuid, parent, cacheRead }) => [
  assistantToolUse({
    uuid, parentUuid: parent, messageId: id, toolUseId: `t-${id}`, name: 'Bash',
    input: { command: `echo ${id}` }, timestamp: ts(1), model: 'claude-opus-4-8',
    usage: usage({ input: 100, output: 10, cacheRead, cacheWrite: 2000 }),
  }),
  toolResult({ uuid: `r-${id}`, parentUuid: uuid, toolUseId: `t-${id}`, content: `out ${id}` }),
];

// Two epochs already on disk before the owner boots: the compact summary is a topology root with a call
// behind it, so it closes segment 0 and opens segment 1. Both are reconstructed by bootstrap.
const EPOCH_AT_STARTUP = [
  ...step({ id: 'm1', uuid: 'u1', parent: null, cacheRead: 100000 }),
  ...step({ id: 'm2', uuid: 'u2', parent: 'r-m1', cacheRead: 102000 }),
  compactSummary({ uuid: 'c1', timestamp: ts(2), text: 'summary one' }),
  ...step({ id: 'm4', uuid: 'u4', parent: 'c1', cacheRead: 3000 }),
];

// Appended after the owner exists and acquired by a LATER poll tick, exactly as the timer drives it: the
// same shape of epoch, this time observed live as it happens.
const EPOCH_WHILE_LIVE = [
  compactSummary({ uuid: 'c2', timestamp: ts(3), text: 'summary two' }),
  ...step({ id: 'm6', uuid: 'u6', parent: 'c2', cacheRead: 2000 }),
];

function bootOverTranscript(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-startup-fold-'));
  const transcript = join(dir, 'session.jsonl');
  writeFileSync(transcript, jsonl(rows));
  const store = openStore(join(dir, 'store.sqlite'));
  const sessionId = `sf-${randomUUID()}`;
  const watcher = createWatcherComposition({
    sessionId, sourceLocator: transcript, projectId: null, projectRoot: dir, stateDir: dir, store,
    isIgnored: null,
  });
  const srv = createServer({
    watcher: strictWatcherFacade(watcher), pollIntervalMs: 0, sessionId, sourceLocator: transcript,
    projectsRoot: dir, projectRoot: dir, store, disableTelemetrySweep: true,
  });
  return {
    store, transcript, sessionId, srv,
    // The profile row plus its telemetry provenance for one segment. `capture_source` has no camelized
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

test('the synchronous bootstrap archives a reconstructed segment as a replay', () => {
  const ctx = bootOverTranscript(EPOCH_AT_STARTUP);
  try {
    assert.deepEqual(ctx.provenanceOf(0), { archiveSource: 'replay', captureSource: 'cc-replay' },
      'the epoch bootstrap crossed reconstructs history, so it is not a live capture');
  } finally { ctx.teardown(); }
});

test('an epoch crossed by a later poll tick on the same owner archives as live', () => {
  const ctx = bootOverTranscript(EPOCH_AT_STARTUP);
  try {
    ctx.append(EPOCH_WHILE_LIVE);
    ctx.srv.runPollTick();
    assert.deepEqual(ctx.provenanceOf(1), { archiveSource: 'live', captureSource: 'cc-live' },
      'bootstrap must not leave replay capture set — live polling is observed, not reconstructed');
    assert.deepEqual(ctx.provenanceOf(0), { archiveSource: 'replay', captureSource: 'cc-replay' },
      'the bootstrap segment keeps its own provenance');
  } finally { ctx.teardown(); }
});

test('the owner\'s terminal close archives the bootstrap segment as a replay when no live frame applied since the bootstrap', () => {
  const ctx = bootOverTranscript(EPOCH_AT_STARTUP);
  try {
    ctx.srv.closeCurrentSegment();
    assert.deepEqual(ctx.provenanceOf(1), { archiveSource: 'replay', captureSource: 'cc-replay' },
      'a segment only the bootstrap reconstructed is not a live capture');
    const { archived_at: archivedAt } = ctx.store._db
      .prepare('SELECT archived_at FROM profile WHERE session_id = ? AND segment = 1').get(ctx.sessionId);
    assert.equal(archivedAt, Date.parse(ts(1)), 'stamped with the segment\'s last step time');
  } finally { ctx.teardown(); }
});

test('the owner\'s terminal close archives as live after a poll tick applied a live frame', () => {
  const ctx = bootOverTranscript(EPOCH_AT_STARTUP);
  try {
    ctx.append(step({ id: 'm5', uuid: 'u5', parent: 'r-m4', cacheRead: 5000 }));
    ctx.srv.runPollTick();
    ctx.srv.closeCurrentSegment();
    assert.deepEqual(ctx.provenanceOf(1), { archiveSource: 'live', captureSource: 'cc-live' });
  } finally { ctx.teardown(); }
});
