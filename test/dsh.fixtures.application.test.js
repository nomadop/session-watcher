// Every local DSH fixture run end to end: the log's events enter a composed `SessionWatcher` through the DSH
// source driver in each of the three ways a watcher can take them, and what the watcher measures, archives and
// hands off is compared with the `application` expectations `scripts/dsh-fixture-expect.mjs` derived from the
// events alone, and the bucket data of the two other entries with the whole snapshot's. A fixture absent on
// this machine skips its cases.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { readHistorySource } from '../lib/turn.js';
import { resolveProjectKey } from '../lib/project-key.js';
import { openStore, closeStore } from '../lib/store.js';
import { composeWatcher } from '../dsh/src/composition.js';
import { hasDshFixture, readDshFixture, expectationsOf } from './helpers/dsh-fixtures.js';

const FIXTURES = ['compaction-prune', 'plain-ask', 'subagent'];

async function withFixtureWatcher(name, run) {
  const { header, events } = readDshFixture(name);
  const { application } = expectationsOf(name);
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-dsh-application-'));
  const store = openStore(join(stateDir, 'store.sqlite'));
  const sessionId = header.id;
  const readSession = async () => ({ events });
  try {
    const { watcher } = composeWatcher({
      sessionId, cwd: header.cwd, store, turnNotesRoot: join(stateDir, 'turn-notes'), readSession,
      isIgnored: null, cacheTtl: () => null,
    });
    const diagnostics = [];
    const driver = createDshSourceDriver({ sessionId, onDiagnostics: reported => diagnostics.push(...reported) });
    const apply = frame => { if (frame) watcher.applyHarnessFrame(frame); };
    await run({ header, events, application, store, sessionId, watcher, driver, diagnostics, apply });
  } finally {
    closeStore(store);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const sumOf = (points, field) => points.reduce((sum, point) => sum + point[field], 0);

async function assertApplication({ application, sessionId, watcher, diagnostics }) {
  const status = watcher.getStatus();
  const history = watcher.getHistory();
  assert.equal(status.segment, application.segment, 'segment');
  assert.equal(history.length, application.measuredCalls, 'measured calls');
  assert.equal(status.segment + 1, application.epochs, 'epochs');
  const read = await readHistorySource({
    dialogueSource: watcher._dialogueSource,
    dialogueProjection: watcher._dialogueProjection,
  }, sessionId);
  assert.equal(read.turns.length, application.turns, 'turns');
  const { input, cacheRead, cacheWrite } = application.usage;
  assert.equal(sumOf(history, 'L'), input + cacheRead + cacheWrite, 'L');
  assert.equal(sumOf(history, 'cacheRead'), cacheRead, 'cacheRead');
  assert.equal(sumOf(history, 'cacheCreation'), cacheWrite, 'cacheCreation');
  assert.equal(status.model, application.latestModel, 'latest model');
  assert.deepEqual(diagnostics, [], 'the driver reported no diagnostics');
}

// The bucket data the whole snapshot measures, the value the two other entries are held to.
async function wholeSnapshotBucket(name) {
  let bucket;
  await withFixtureWatcher(name, async ({ events, watcher, driver, apply }) => {
    apply(driver.install(events));
    bucket = JSON.stringify(watcher.getBucketData());
  });
  return bucket;
}

function archivedSources(store, sessionId) {
  return store._db
    .prepare('SELECT segment, capture_source FROM profile WHERE session_id = ? ORDER BY segment')
    .all(sessionId).map(row => ({ ...row }));
}

// Every archived segment carries the capture label `sourceOf` names for it, and each segment `required` names,
// the one current at the close among them, is archived.
function assertArchived({ store, sessionId, application }, sourceOf, required = []) {
  const rows = archivedSources(store, sessionId);
  for (const segment of [...required, application.segment]) {
    assert.ok(rows.some(row => row.segment === segment), `segment ${segment} is archived`);
  }
  for (const row of rows) assert.equal(row.capture_source, sourceOf(row.segment), `segment ${row.segment}`);
}

// The bootstrap split: the snapshot prefix closes segment 0 inside itself when the log has an epoch, and
// otherwise ends on the first message issuing a tool call, so that call's result arrives live. The queue
// fed before `install` starts at the prefix's midpoint and ends as far past the snapshot's tail as it starts
// before it, so `drain` both drops queued events and keeps them, and a live tail follows.
function bootstrapSplit(events, { reducer }) {
  const prefixEnd = reducer.epochSeqs.length > 0
    ? events.findIndex(event => event.seq === reducer.epochSeqs[0])
    : events.findIndex(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'tool-call'));
  assert.ok(prefixEnd >= 0, 'the log holds the event its prefix ends on');
  const prefixLength = prefixEnd + 1;
  const queueStart = Math.floor(prefixLength / 2);
  const queueEnd = Math.min(events.length, prefixLength + (prefixLength - queueStart));
  return {
    prefix: events.slice(0, prefixLength),
    queued: events.slice(queueStart, queueEnd),
    tail: events.slice(queueEnd),
  };
}

describe('DSH fixtures through a composed SessionWatcher', () => {
  for (const name of FIXTURES) {
    const skip = !hasDshFixture(name);

    test(`${name}: the whole snapshot measures, archives as a replay and hands off under the session id`,
      { skip }, () => withFixtureWatcher(name, async (fixture) => {
        const { header, events, store, sessionId, watcher, driver, apply } = fixture;
        apply(driver.install(events));
        await assertApplication(fixture);

        watcher.closeCurrentSegment();
        assertArchived(fixture, () => 'dsh-replay');

        const prepared = watcher.prepareHandoff({ summary: 'Fixture summary.', nextTask: 'Fixture next task.' });
        assert.equal(prepared.status, 'ready');
        const row = { ...store._db.prepare('SELECT transcript_path, project_id FROM handoff WHERE load_token = ?')
          .get(prepared.load_token) };
        assert.deepEqual(row, { transcript_path: sessionId, project_id: resolveProjectKey({ cwd: header.cwd }) });
      }));

    test(`${name}: every event fed live after an empty snapshot measures as the whole snapshot does`,
      { skip }, () => withFixtureWatcher(name, async (fixture) => {
        const { events, watcher, driver, apply } = fixture;
        apply(driver.install([]));
        for (const frame of driver.drain()) apply(frame);
        for (const event of events) apply(driver.feed(event));
        await assertApplication(fixture);
        assert.equal(JSON.stringify(watcher.getBucketData()), await wholeSnapshotBucket(name), 'bucket data');

        watcher.closeCurrentSegment();
        assertArchived(fixture, () => 'dsh-live');
      }));

    test(`${name}: a snapshot prefix, an overlapping queue and a live tail measure as the whole snapshot does`,
      { skip }, () => withFixtureWatcher(name, async (fixture) => {
        const { events, watcher, driver, apply } = fixture;
        const expected = expectationsOf(name);
        const { prefix, queued, tail } = bootstrapSplit(events, expected);
        for (const event of queued) assert.equal(driver.feed(event), null);
        apply(driver.install(prefix));
        for (const frame of driver.drain()) apply(frame);
        for (const event of tail) apply(driver.feed(event));
        await assertApplication(fixture);
        assert.equal(JSON.stringify(watcher.getBucketData()), await wholeSnapshotBucket(name), 'bucket data');

        watcher.closeCurrentSegment();
        // The snapshot closes segment 0 exactly when the log holds an epoch, and every later close is live.
        const closedInSnapshot = expected.reducer.epochSeqs.length > 0 ? [0] : [];
        assertArchived(fixture, segment => (closedInSnapshot.includes(segment) ? 'dsh-replay' : 'dsh-live'),
          closedInSnapshot);
      }));
  }
});
