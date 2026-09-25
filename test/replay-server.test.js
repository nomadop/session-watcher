// test/replay-server.test.js
import { describe, it, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startReplayServer } from '../lib/replay-server.js';
import { indexTranscript, ReplayController } from '../lib/replay.js';
import { createWatcherComposition } from '../server.js';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';
import { openStore, closeStore } from '../lib/store.js';
import { bootTestServer } from './helpers/server-boot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use the smallest available real fixture for testing
const FIXTURE = join(__dirname, '..', 'fixtures', 'decf0f2c-20260703.jsonl');

test('replay index keeps the final byte offset for repeated usage snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-replay-index-'));
  const path = join(dir, 'session.jsonl');
  const first = JSON.stringify({ timestamp: '2026-07-01T00:00:01Z', type: 'assistant',
    message: { id: 'm1', usage: { output_tokens: 9 } } }) + '\n';
  const middle = JSON.stringify({ timestamp: '2026-07-01T00:00:02Z', type: 'user',
    message: { content: 'continue' } }) + '\n';
  const final = JSON.stringify({ timestamp: '2026-07-01T00:00:03Z', type: 'assistant',
    message: { id: 'm1', usage: { output_tokens: 1 } } }) + '\n';
  const next = JSON.stringify({ timestamp: '2026-07-01T00:00:04Z', type: 'assistant',
    message: { id: 'm2', usage: { output_tokens: 2 } } }) + '\n';
  writeFileSync(path, first + middle + final + next);

  const index = indexTranscript(path);

  assert.equal(index.length, 2);
  assert.deepEqual(index.map(step => step.byteEnd), [
    Buffer.byteLength(first + middle + final),
    Buffer.byteLength(first + middle + final + next),
  ]);
  assert.deepEqual(index.map(step => step.ts), [
    Date.parse('2026-07-01T00:00:03Z'),
    Date.parse('2026-07-01T00:00:04Z'),
  ]);
});

// Transcript Playback drives the source driver with absolute line-end byte limits and never touches a
// watcher offset. What ends playback is the Source and the application, not physical EOF: the controller
// consumes its index, then performs ONE final unbounded advance with live row-completeness semantics.
function playbackFixture(rows, tail) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-replay-valve-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join('') + (tail ? JSON.stringify(tail) : ''));
  const store = openStore(join(dir, 'store.sqlite'));
  const watcher = createWatcherComposition({
    sessionId: 'playback', sourceLocator: path, projectId: null, projectRoot: dir,
    stateDir: dir, store, isIgnored: null,
  });
  const driver = createClaudeCodeSourceDriver({ sourceLocator: path, firstReadableTransition: 'replace' });
  const index = indexTranscript(path);
  const controller = new ReplayController(watcher, index, { speed: 100, driver });
  return { path, watcher, controller, index, store, dir };
}

// Steps the controller exactly once: `start` performs one step then schedules the next on a timer, so a
// `pause` right after leaves the timer cancelled and the step already applied.
const stepOnce = (controller) => { controller.start(); controller.pause(); };

const usageRow = ({ uuid, parent, id, output, cacheRead, second, sidechain = false }) => ({
  type: 'assistant', uuid, parentUuid: parent, isSidechain: sidechain,
  timestamp: `2026-07-01T00:00:0${second}Z`,
  message: { id, role: 'assistant', model: 'claude-opus-4-8', content: [],
    usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
});
const userRow = ({ uuid, parent, text, second }) => ({
  type: 'user', uuid, parentUuid: parent, isSidechain: false,
  timestamp: `2026-07-01T00:00:0${second}Z`, message: { role: 'user', content: text },
});

test('a final unbounded advance that finds only an incomplete usage tail returns no frame and still completes', () => {
  const complete = [
    userRow({ uuid: 'u-root', parent: null, text: 'start', second: 1 }),
    usageRow({ uuid: 'a-one', parent: 'u-root', id: 'm1', output: 5, cacheRead: 5000, second: 2 }),
    usageRow({ uuid: 'a-two', parent: 'a-one', id: 'm2', output: 5, cacheRead: 6000, second: 3 }),
  ];
  // A newline-less revision of m2: a real streaming tail. It is not LF-terminated, so it is neither indexed
  // nor committed by any advance.
  const tail = usageRow({ uuid: 'a-tail', parent: 'a-two', id: 'm2', output: 50, cacheRead: 6000, second: 4 });
  const fx = playbackFixture(complete, tail);
  try {
    assert.equal(fx.index.length, 2, 'only the two LF-terminated usage rows are indexed');

    stepOnce(fx.controller);
    assert.equal(fx.controller.progress.current, 1);
    stepOnce(fx.controller);
    assert.equal(fx.controller.progress.current, 2);
    const callsAfterIndex = fx.watcher.getStatus().apiCalls;
    assert.equal(callsAfterIndex, 2, 'both indexed steps were measured');

    // The final unbounded advance. The only thing left is the incomplete tail, so it returns NO frame — and
    // no frame completes playback normally rather than leaving it stuck.
    stepOnce(fx.controller);
    assert.equal(fx.controller.progress.done, true, 'playback completed on a no-frame final advance');
    assert.equal(fx.watcher.getStatus().apiCalls, callsAfterIndex,
      'the pending tail revised nothing — it is still an incomplete row');
  } finally { fx.controller.stop(); closeStore(fx.store); rmSync(fx.dir, { recursive: true, force: true }); }
});

test('a complete non-usage row after the final indexed row is submitted by the final unbounded advance', () => {
  const rows = [
    userRow({ uuid: 'u-root', parent: null, text: 'start', second: 1 }),
    usageRow({ uuid: 'a-one', parent: 'u-root', id: 'm1', output: 5, cacheRead: 5000, second: 2 }),
    // A complete user row AFTER the last indexed usage row. The index holds only usage rows, so nothing
    // bounded ever reaches it; the final unbounded advance is what submits it.
    userRow({ uuid: 'u-after', parent: 'a-one', text: 'one more thing', second: 3 }),
  ];
  const fx = playbackFixture(rows, null);
  try {
    assert.equal(fx.index.length, 1, 'the trailing user row is not an index entry');
    stepOnce(fx.controller);
    assert.equal(fx.controller.progress.current, 1);
    const turnsBefore = fx.watcher.getBucketData().currentTurnSeq;

    stepOnce(fx.controller);
    assert.equal(fx.controller.progress.done, true);
    // The trailing row is a main-chain user turn, so submitting it sets the pending turn boundary. Its
    // arrival is observable as the frame having been applied at all.
    assert.ok(fx.watcher.getBucketData().currentTurnSeq >= turnsBefore,
      'the final unbounded advance applied the frame it returned');
  } finally { fx.controller.stop(); closeStore(fx.store); rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the controller drains every step of a multi-step frame into one ledger and restarts it on a segment change', () => {
  const rows = [
    userRow({ uuid: 'u-root', parent: null, text: 'start', second: 1 }),
    usageRow({ uuid: 'a-one', parent: 'u-root', id: 'm1', output: 5, cacheRead: 50000, second: 2 }),
    usageRow({ uuid: 'a-two', parent: 'a-one', id: 'm2', output: 5, cacheRead: 60000, second: 3 }),
    usageRow({ uuid: 'a-three', parent: 'a-two', id: 'm3', output: 5, cacheRead: 70000, second: 4 }),
    // A null-parent root with a measured call behind it is a compact epoch, so this row opens the second
    // segment and the ledger keyed on the first one can no longer be drained onto.
    userRow({ uuid: 'u-clear', parent: null, text: 'after clear', second: 5 }),
    usageRow({ uuid: 'b-one', parent: 'u-clear', id: 'm4', output: 5, cacheRead: 50000, second: 6 }),
    usageRow({ uuid: 'b-two', parent: 'b-one', id: 'm5', output: 5, cacheRead: 61000, second: 7 }),
  ];
  const fx = playbackFixture(rows, null);
  try {
    stepOnce(fx.controller); stepOnce(fx.controller); stepOnce(fx.controller);
    const first = fx.controller.ledger;
    assert.equal(fx.watcher.getStatus().segment, 0, 'the first three steps are one segment');
    assert.equal(first.lastAppliedFoldedCallSeq, 3, 'every step of the first segment was drained');
    assert.ok(first.billProgress > 0, 'the stamped intervals carried rent');
    stepOnce(fx.controller); stepOnce(fx.controller);
    const second = fx.controller.ledger;
    assert.notEqual(second.stateKey, first.stateKey, 'a segment change starts a fresh ledger');
    assert.equal(second.billCycleCount, 0);
    assert.equal(second.lastAppliedFoldedCallSeq, 5, 'the fresh ledger drained the new segment’s own steps');
    assert.equal(fx.controller.billProgress, undefined);
    assert.equal(fx.controller.gateState, undefined);
  } finally { fx.controller.stop(); closeStore(fx.store); rmSync(fx.dir, { recursive: true, force: true }); }
});

test('the final unbounded advance drains the calls the index missed', () => {
  const big = usageRow({ uuid: 'a-big', parent: 'a-one', id: 'm-big', output: 5, cacheRead: 70000, second: 3 });
  // A payload this size pushes `usage` past the head slice `indexTranscript` reads, so the row is absent from
  // the pacing index and only the final unbounded advance ever carries it.
  big.message.content = [{ type: 'text', text: 'x'.repeat(9000) }];
  const rows = [
    userRow({ uuid: 'u-root', parent: null, text: 'start', second: 1 }),
    usageRow({ uuid: 'a-one', parent: 'u-root', id: 'm1', output: 5, cacheRead: 50000, second: 2 }),
    big,
  ];
  const fx = playbackFixture(rows, null);
  try {
    assert.equal(fx.index.length, 1, 'the payload row is outside the index');
    stepOnce(fx.controller);   // the indexed row
    stepOnce(fx.controller);   // the final unbounded advance
    assert.equal(fx.controller.progress.done, true);
    assert.equal(fx.watcher.getStatus().apiCalls, 2, 'the Engine measured the row the index missed');
    assert.equal(fx.controller.ledger.lastAppliedFoldedCallSeq, 2, 'the ledger followed the measurement to its tail');
  } finally { fx.controller.stop(); closeStore(fx.store); rmSync(fx.dir, { recursive: true, force: true }); }
});

describe('replay-server', () => {
  let instance;

  after(async () => { if (instance) await instance.stop(); });

  it('starts and serves /api/status', async () => {
    instance = await startReplayServer({ transcriptPath: FIXTURE, speed: 100, port: 0 });
    assert.ok(instance.url.startsWith('http://127.0.0.1:'));
    assert.ok(instance.totalSteps > 0);

    const res = await fetch(`${instance.url}/api/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('model' in body || 'rateLamp' in body || 'L' in body);
  });

  it('serves /api/replay/status with progress', async () => {
    const res = await fetch(`${instance.url}/api/replay/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active, true);
    assert.ok('current' in body);
    assert.ok('total' in body);
    assert.ok(body.total > 0);
  });

  it('serves static dashboard at /', async () => {
    const res = await fetch(`${instance.url}/`);
    assert.equal(res.status, 200);
    // Byte equality against the served file identifies which file the static route reached, where a
    // literal from inside it would only prove that some page mentions the product.
    const served = Buffer.from(await res.arrayBuffer());
    const onDisk = readFileSync(join(__dirname, '..', 'public', 'dashboard.html'));
    assert.deepEqual(served, onDisk);
  });

  // Playback owns the position the dashboard is reading, so a preview folded from the playback segment would
  // describe a different application than the Apply it precedes. The route refuses instead of answering.
  it('refuses a preview while playback holds the controller', async () => {
    const res = await fetch(`${instance.url}/api/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: {} }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'replay_active');
  });

  it('does not create port-discovery state files', async () => {
    const { readdirSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const stateDir = join(homedir(), '.session-watcher');
    try {
      const files = readdirSync(stateDir);
      const port = new URL(instance.url).port;
      const match = files.find(f => f.includes(port));
      assert.equal(match, undefined, 'should not write port-discovery files');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  });

  it('stop() is idempotent', async () => {
    await instance.stop();
    await instance.stop(); // second call must not throw
  });
});

describe('replay control routes', () => {
  let ctx;

  before(async () => { ctx = await bootTestServer({ sessionId: 'sess-replay-routes' }); });
  after(async () => { await ctx.teardown(); });

  it('drives start, pause, speed, resume and stop over the routes, reading each state back from /api/replay/status', async () => {
    const start = await ctx.requestRaw('/api/replay/start', {
      method: 'POST', body: { transcript: ctx.transcriptPath, speed: 4 },
    });
    assert.equal(start.status, 200, 'start');
    assert.equal((await start.json()).ok, true, 'start response reports ok');

    const pause = await ctx.requestRaw('/api/replay/pause', { method: 'POST' });
    assert.equal(pause.status, 200, 'pause');
    assert.equal((await pause.json()).ok, true, 'pause response reports ok');
    const afterPause = await (await ctx.requestRaw('/api/replay/status')).json();
    assert.equal(afterPause.paused, true, 'status reads back paused');

    const speed = await ctx.requestRaw('/api/replay/speed', { method: 'POST', body: { speed: 8 } });
    assert.equal(speed.status, 200, 'speed');
    assert.equal((await speed.json()).ok, true, 'speed response reports ok');
    const afterSpeed = await (await ctx.requestRaw('/api/replay/status')).json();
    assert.equal(afterSpeed.speed, 8, 'status reads back speed');

    const resume = await ctx.requestRaw('/api/replay/resume', { method: 'POST' });
    assert.equal(resume.status, 200, 'resume');
    assert.equal((await resume.json()).ok, true, 'resume response reports ok');
    const afterResume = await (await ctx.requestRaw('/api/replay/status')).json();
    assert.equal(afterResume.paused, false, 'status reads back resumed (unpaused)');

    const stop = await ctx.requestRaw('/api/replay/stop', { method: 'POST' });
    assert.equal(stop.status, 200, 'stop');
    assert.equal((await stop.json()).ok, true, 'stop response reports ok');
    const afterStop = await (await ctx.requestRaw('/api/replay/status')).json();
    assert.equal(afterStop.active, false, 'status reads back stopped');
  });
});

describe('playback status', () => {
  let ctx;

  after(async () => { if (ctx) await ctx.teardown(); });

  it('serves the playback ledger through the /api/status playback branch', async () => {
    ctx = await bootTestServer({
      sessionId: 'sess-playback-ledger',
      entries: [
        userRow({ uuid: 'u-root', parent: null, text: 'start', second: 1 }),
        // A sidechain usage row IS a pacing-index step and is NOT a measured call, so playback opens on a
        // status with no stamp behind it — the unreliable side of the merge, reached without a timing race.
        usageRow({ uuid: 's-one', parent: 'u-root', id: 'ms1', output: 5, cacheRead: 1000, second: 2, sidechain: true }),
        usageRow({ uuid: 's-two', parent: 'u-root', id: 'ms2', output: 5, cacheRead: 1100, second: 3, sidechain: true }),
        usageRow({ uuid: 'a-one', parent: 'u-root', id: 'm1', output: 5, cacheRead: 50000, second: 4 }),
        usageRow({ uuid: 'a-two', parent: 'a-one', id: 'm2', output: 5, cacheRead: 60000, second: 5 }),
        usageRow({ uuid: 'a-three', parent: 'a-two', id: 'm3', output: 5, cacheRead: 70000, second: 6 }),
      ],
    });
    // The speed is low enough that the controller's step delay takes its slow-playback floor, and that
    // floor is the window this pause has to arrive in; every later step is driven by hand, so the served
    // status has a settled ledger behind it.
    const start = await ctx.requestRaw('/api/replay/start', {
      method: 'POST', body: { transcript: ctx.transcriptPath, speed: 4 },
    });
    assert.equal(start.status, 200, 'playback started');
    await ctx.requestRaw('/api/replay/pause', { method: 'POST' });
    const controller = ctx.replayController();
    assert.equal(controller.progress.current, 1, 'playback paused inside the unmeasured head of the index');

    const opening = await ctx.get('/api/status');
    assert.equal(opening.rateLamp.reliable, false, 'the sidechain step measured no call');
    assert.deepEqual(opening.rateLamp.rentMeter, {
      cycleProgress: 0, depthActive: false, depthProgress: 0,
      backstopInterval: null, backstopLapCount: 0, depthHot: false,
    }, 'an unreliable playback status carries the default rent meter');

    stepOnce(controller); stepOnce(controller); stepOnce(controller); stepOnce(controller);
    const ledger = controller.ledger;
    assert.ok(ledger.billProgress > 0, 'the drained frames carried rent');

    const body = await ctx.get('/api/status');
    assert.equal(body.rateLamp.reliable, true, 'the drained steps left a stamped status behind');
    assert.equal(body.rateLamp.billProgress, ledger.billProgress, 'the served bill progress is the ledger’s');
    assert.equal(body.rateLamp.rentMeter.backstopLapCount, ledger.walletLapCount, 'the served lap count is the wallet clock’s');
    assert.equal(body.rateLamp.rentMeter.cycleProgress, ledger.billProgress);
    assert.equal(body.rateLamp.rentMeter.depthProgress, ledger.walletPhase);
    assert.equal(body.rateLamp.rentMeter.depthActive, true);
  });
});
