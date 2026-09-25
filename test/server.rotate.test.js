// Owner-local rotation, at the HTTP ingress. One `rotate` frame carries the whole transition: the candidate
// driver's own first live read, the old segment's closure, the new identity, and the discovery move.
//
// The frame TRANSITIONS are observed through `streamRevision` — the application increments it on a replace
// and a rotate and leaves it alone on an append — so no test reads a watcher field to learn what happened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, closeStore } from '../lib/store.js';
import {
  _resetRateLampManagerForTest, getLiveLedger, getDebugCounters, flushPendingPersistsSync,
} from '../lib/rate-lamp-manager.js';
import { createServer, createWatcherComposition, _setServerTestClock, SNAPSHOT_THROTTLE_MS } from '../server.js';
import { strictWatcherFacade } from './helpers/server-boot.js';
import { assistantToolUse, chain, toolResult, ts, usage } from './helpers/transcript-fixtures.js';

// One measured step plus its result, as its own chain root.
const measuredRows = (tag, cacheRead) => chain([
  assistantToolUse({
    uuid: `u-${tag}`, parentUuid: null, messageId: `m-${tag}`, toolUseId: `t-${tag}`, name: 'Bash',
    input: { command: `echo ${tag}` }, timestamp: ts(1), model: 'claude-sonnet-4-20250514',
    usage: usage({ input: 100, output: 10, cacheRead }),
  }),
  toolResult({ uuid: `r-${tag}`, toolUseId: `t-${tag}`, content: `out ${tag}` }),
]);

const writeRows = (dir, name, rows) => {
  const path = join(dir, name);
  writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join(''));
  return path;
};

function bootOwner({ sessionId, sourceLocator, projectsRoot, stateDir, dir }) {
  const store = openStore(join(dir, `store-${sessionId}.sqlite`));
  const watcher = createWatcherComposition({
    sessionId, sourceLocator, projectId: null, projectRoot: dir, stateDir, store, isIgnored: null,
  });
  const handle = createServer({
    watcher: strictWatcherFacade(watcher), pollIntervalMs: 0, sessionId, onIdleShutdown: null,
    sourceLocator, projectsRoot, projectRoot: dir, stateDir, store, disableTelemetrySweep: true,
  });
  return { store, watcher, handle };
}

const revisionOf = (watcher) => watcher.readRateLampFrame(-1).streamRevision;

// The idle gate skips an installed-driver tick whose last advance was recent, so two ticks in the same
// millisecond collapse into one. A test that needs consecutive ticks steps a monotonic clock past both gated
// thresholds — the heartbeat gate and the snapshot throttle — before each one.
let pumpClock = null;
function pump(handle) {
  if (pumpClock === null) pumpClock = performance.now() + SNAPSHOT_THROTTLE_MS + 1;
  pumpClock += SNAPSHOT_THROTTLE_MS + 1;
  _setServerTestClock(pumpClock);
  handle.runPollTick();
}

async function withOwner(fn, { seedDiscovery = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-rotate-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projectsRoot = join(dir, 'projects');
  const projRoot = join(projectsRoot, 'encoded-cwd');
  mkdirSync(projRoot, { recursive: true });
  const pathOld = writeRows(projRoot, 'sess-old.jsonl', measuredRows('old', 1000));

  const owner = bootOwner({ sessionId: 'sess-old', sourceLocator: pathOld, projectsRoot, stateDir, dir });
  const { server, stopTimers } = owner.handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  if (seedDiscovery) owner.handle.publishDiscovery();
  try {
    await fn({ ...owner, port, dir, stateDir, projectsRoot, projRoot, pathOld });
  } finally {
    _setServerTestClock(null);
    stopTimers();
    await new Promise(r => server.close(r));
    try { closeStore(owner.store); } catch { /* already closed */ }
  }
}

const rotate = (port, body) => fetch(`http://127.0.0.1:${port}/api/rotate`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json());

test('POST /api/rotate: an immediately readable candidate contributes its batches to one live rotate', async () => {
  await withOwner(async (ctx) => {
    const pathNew = writeRows(ctx.projRoot, 'sess-new.jsonl', measuredRows('new', 2000));
    const before = revisionOf(ctx.watcher);

    const body = await rotate(ctx.port, { session_id: 'sess-new', transcript_path: pathNew });
    assert.equal(body.ok, true);
    assert.equal(body.old_session_id, 'sess-old');
    assert.equal(body.new_session_id, 'sess-new');
    assert.equal(revisionOf(ctx.watcher), before + 1, 'a rotate restarts the sample stream exactly once');

    // The candidate's own batches came in ON the rotate frame, so the new session already has its call.
    assert.equal(ctx.watcher.getStatus().apiCalls, 1, "the new Source's step was measured by the rotate itself");

    // Discovery moved: the new record carries the new locator, the old path is retired.
    const record = JSON.parse(readFileSync(join(ctx.stateDir, 'sess-new.json'), 'utf8'));
    assert.equal(record.sessionId, 'sess-new');
    assert.equal(record.transcriptPath, pathNew);
    assert.ok(!existsSync(join(ctx.stateDir, 'sess-old.json')), 'the old discovery record was retired');

    // The dying segment archived under the OLD identity — the identity that produced it.
    const archived = ctx.store.getProfileSegments('sess-old');
    assert.equal(archived.length, 1, 'the old segment archived exactly once');
    assert.equal(archived[0].archiveSource, 'live', 'the whole rotate frame is live, closure included');
  });
});

test('POST /api/rotate: an unavailable Source applies an empty rotate, and the first readable append latches', async () => {
  await withOwner(async (ctx) => {
    // A locator that resolves but does not exist yet: the candidate's first live read finds nothing.
    const pathNew = join(ctx.projRoot, 'sess-later.jsonl');
    const before = revisionOf(ctx.watcher);

    const body = await rotate(ctx.port, { session_id: 'sess-later', transcript_path: pathNew });
    assert.equal(body.ok, true, 'an unavailable Source still rotates — the candidate is installed');
    assert.equal(revisionOf(ctx.watcher), before + 1, 'the empty rotate incremented the revision once');
    // `sourceObserved: false` on the rotate, so measurement is not ready for a reason the application owns.
    assert.equal(ctx.watcher.getStatus().rateLamp.unavailableReason, 'no_transcript');

    // The Source appears. Its first readable live append is what latches `hasObservedSource`, which
    // increments the revision AGAIN — and the previously archived history is untouched.
    writeFileSync(pathNew, measuredRows('later', 3000).map(r => JSON.stringify(r) + '\n').join(''));
    pump(ctx.handle);
    assert.equal(revisionOf(ctx.watcher), before + 2,
      'the first readable append latched the Source and restarted the stream once more');
    assert.equal(ctx.watcher.getStatus().apiCalls, 1, 'the appended step was measured');
    assert.equal(ctx.store.getProfileSegments('sess-old').length, 1, 'old history preserved, no second rotation');
  });
});

test('POST /api/rotate: noop when same session_id, with no frame and no state change', async () => {
  await withOwner(async (ctx) => {
    const before = revisionOf(ctx.watcher);
    const callsBefore = ctx.watcher.getStatus().apiCalls;
    const body = await rotate(ctx.port, { session_id: 'sess-old' });
    assert.equal(body.ok, true);
    assert.equal(body.noop, true);
    assert.equal(revisionOf(ctx.watcher), before, 'a duplicate-session notification produces NO frame');
    assert.equal(ctx.watcher.getStatus().apiCalls, callsBefore);
    assert.ok(existsSync(join(ctx.stateDir, 'sess-old.json')), 'discovery is unchanged');
  });
});

test('POST /api/rotate: an unresolved locator retains driver, application and discovery state', async () => {
  await withOwner(async (ctx) => {
    const before = revisionOf(ctx.watcher);
    const body = await rotate(ctx.port, { session_id: 'nonexistent-sess-zzz' });
    assert.equal(body.ok, false);
    assert.equal(body.error, 'transcript_not_found');
    assert.equal(revisionOf(ctx.watcher), before, 'no frame was produced');
    // The old identity still owns discovery, and the old Source is still the one installed.
    const record = JSON.parse(readFileSync(join(ctx.stateDir, 'sess-old.json'), 'utf8'));
    assert.equal(record.sessionId, 'sess-old');
    assert.equal(record.transcriptPath, ctx.pathOld);
  });
});

test('POST /api/rotate: a discovery rewrite failure keeps the installed candidate and returns the warning', async () => {
  await withOwner(async (ctx) => {
    const pathNew = writeRows(ctx.projRoot, 'sess-warn.jsonl', measuredRows('warn', 2000));
    const before = revisionOf(ctx.watcher);
    // Replace the state directory with a regular FILE, so the rewrite cannot land. A permission bit is not
    // used: this suite may run as a user that bypasses permission checks, and then nothing would fail.
    const { rmSync } = await import('node:fs');
    rmSync(ctx.stateDir, { recursive: true, force: true });
    writeFileSync(ctx.stateDir, 'not a directory');

    const body = await rotate(ctx.port, { session_id: 'sess-warn', transcript_path: pathNew });
    assert.equal(body.ok, true, 'the rotation itself succeeded');
    assert.equal(body.warning, 'state_file_write_failed', 'and it returns the existing warning');
    assert.equal(revisionOf(ctx.watcher), before + 1, 'the candidate was applied and installed');
    assert.equal(ctx.watcher.getStatus().apiCalls, 1, 'the installed candidate is the one being measured');
  });
});

test('POST /api/rotate: rotation writes no snapshot and the new session still gets its first changed tick', async () => {
  await withOwner(async (ctx) => {
    const pathNew = writeRows(ctx.projRoot, 'sess-snap.jsonl', measuredRows('snap', 2000));
    // A snapshot written immediately before the rotation. The rotation resets the host throttle, so it cannot
    // suppress the new session's only changed tick.
    const writes = [];
    const realSaveBatch = ctx.store.saveBatch.bind(ctx.store);
    ctx.store.saveBatch = (sessionId, entries, opts) => { writes.push(sessionId); return realSaveBatch(sessionId, entries, opts); };

    const beforeRotationWrites = writes.length;
    const body = await rotate(ctx.port, { session_id: 'sess-snap', transcript_path: pathNew });
    assert.equal(body.ok, true);
    assert.equal(writes.length, beforeRotationWrites, 'rotation itself writes no snapshot');

    // The next changed tick under the new identity DOES write, because the throttle was reset to -Infinity.
    writeFileSync(pathNew, [
      ...measuredRows('snap', 2000),
      ...measuredRows('snap2', 4000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-snap' })),
    ].map(r => JSON.stringify(r) + '\n').join(''));
    pump(ctx.handle);
    assert.ok(writes.includes('sess-snap'), "the new session's first changed tick wrote its snapshot");
  });
});

// ── The approved `rotation Rate Lamp reanchor` delta ─────────────────────────
// A baseline RACE FIX, not equivalent behaviour: baseline left the window between a rotation and the new
// session's first later call UNANCHORED, so whatever the new Source already carried could integrate against a
// stale anchor. The rotation now reanchors immediately under the new identity, which is why the restored
// samples do not integrate and the first later call is the one that anchors.
test('[delta] successful rotation reanchors the new session\'s Rate Lamp before later calls without integrating restored samples', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());
  await withOwner(async (ctx) => {
    // The new Source ALREADY holds two measured steps when the rotation happens. Those are the "restored
    // samples": under the reanchor they are skipped, so nothing integrates from history.
    const pathNew = writeRows(ctx.projRoot, 'sess-reanchor.jsonl', [
      ...measuredRows('ra1', 2000),
      ...measuredRows('ra2', 4000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-ra1' })),
    ]);

    const body = await rotate(ctx.port, { session_id: 'sess-reanchor', transcript_path: pathNew });
    assert.equal(body.ok, true);

    // The new session's ledger EXISTS immediately after the rotation — that is the anchoring the baseline
    // window lacked — and it has integrated nothing.
    const ledger = getLiveLedger('sess-reanchor');
    assert.ok(ledger, 'the rotation advanced the Rate Lamp under the NEW session identity');
    assert.equal(ledger.stateKey, JSON.stringify([1, null, null, null, null, 1]),
      'keyed to the new session\'s own segment');
    assert.equal(ledger.billProgress, 0, 'the restored samples did not integrate');
    assert.equal(ledger.billCycleCount, 0);
    assert.equal(ledger.walletLapCount, 0, 'and neither clock turned over on the rotation');
    // The folded cursor sits at the frame TAIL, which is what skips the history rather than replaying it.
    const tail = ledger.lastAppliedFoldedCallSeq;
    assert.equal(tail, 3, 'and the tail is the restored history\'s end, not zero');

    // Discriminating on its own subject: every call AFTER the reanchored tail integrates its own stamped
    // increment, and the restored history contributes none. A rotation that did not reanchor would have
    // already integrated that history above. The later calls carry a large L so each increment is observable.
    const spend = (l) => l.billCycleCount + l.billProgress;
    writeFileSync(pathNew, [
      ...measuredRows('ra1', 2000),
      ...measuredRows('ra2', 4000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-ra1' })),
      ...measuredRows('ra3', 300000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-ra2' })),
    ].map(r => JSON.stringify(r) + '\n').join(''));
    pump(ctx.handle);
    const afterFirst = getLiveLedger('sess-reanchor');
    assert.equal(afterFirst.lastAppliedFoldedCallSeq, tail + 1, 'exactly one new call drained');
    // The increment comes off a fresh read of the same frame the drain consumed, so the pin discriminates the
    // reducer's own arithmetic without restating the pricing formula that stamped it. The spend is rebuilt
    // through the settle loop's unit subtractions, hence a tolerance rather than equality.
    const drained = ctx.watcher.readRateLampFrame(tail).samples;
    assert.equal(drained.length, 1, 'and the frame past the tail holds only that call');
    assert.ok(Math.abs(spend(afterFirst) - drained[0].deltaW) < 1e-9,
      'the first contiguous call after the reanchored tail integrates its own stamped increment, and only it');

    writeFileSync(pathNew, [
      ...measuredRows('ra1', 2000),
      ...measuredRows('ra2', 4000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-ra1' })),
      ...measuredRows('ra3', 300000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-ra2' })),
      ...measuredRows('ra4', 600000).map(row => ({ ...row, parentUuid: row.parentUuid ?? 'r-ra3' })),
    ].map(r => JSON.stringify(r) + '\n').join(''));
    pump(ctx.handle);
    assert.ok(spend(getLiveLedger('sess-reanchor')) > spend(afterFirst),
      'and the next one integrates on top of it');
  });
});

// The write-behind arithmetic the rotation advance changes, proved rather than assumed. `coalesceHits` counts
// `schedulePersist` calls that joined an EXISTING pending write for the same session. The rotation advance is
// the first such call for the new identity — a MISS that leaves the session pending — so the next advance
// under that identity is necessarily a HIT. Baseline performed no rotation advance, so its next advance was
// the first and therefore a miss.
test('the rotation Rate Lamp advance makes the next advance for that session a coalesce hit', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());
  await withOwner(async (ctx) => {
    const pathNew = writeRows(ctx.projRoot, 'sess-coalesce.jsonl', measuredRows('cz', 2000));

    const before = getDebugCounters();
    const body = await rotate(ctx.port, { session_id: 'sess-coalesce', transcript_path: pathNew });
    assert.equal(body.ok, true);
    const afterRotation = getDebugCounters();
    assert.equal(afterRotation.coalesceMisses, before.coalesceMisses + 1,
      'the rotation advance scheduled the FIRST persist for the new session — a miss that leaves it pending');
    assert.equal(afterRotation.coalesceHits, before.coalesceHits, 'and no hit yet');

    // A later tick under the same identity finds the session already pending: that is the extra hit.
    pump(ctx.handle);
    assert.equal(getDebugCounters().coalesceHits, afterRotation.coalesceHits + 1,
      'the next advance for the same session joined the pending write');

    // Draining the queue restores the invariant that a hit is only ever a join, never a lost write.
    flushPendingPersistsSync();
    assert.ok(getLiveLedger('sess-coalesce'), 'the coalesced write still landed');
  });
});
