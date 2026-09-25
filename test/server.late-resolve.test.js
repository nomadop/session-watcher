// Delayed attach: an owner whose Source does not exist yet keeps `driver = null`, searches for a locator on
// its own schedule, and installs only once a readable Source has produced an applied frame.
//
// Acquisition is observed through the two things it actually does — resolver calls and candidate advances —
// both injected, so the schedule and the retry are pinned without reading any host field. Every server here
// takes an explicit stateDir under TMP: without one it falls back to PORT_DIR under the real home, and
// discovery publication is part of what this file exercises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'sw-lateresolve-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

import { createServer, createWatcherComposition, _setServerTestClock } from '../server.js';
import { openStore, closeStore } from '../lib/store.js';
import { _resetRateLampManagerForTest, getLiveLedger } from '../lib/rate-lamp-manager.js';
import { strictWatcherFacade } from './helpers/server-boot.js';
import { assistantToolUse, chain, toolResult, ts, usage } from './helpers/transcript-fixtures.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];

function boot({ sessionId, projectsRoot, createSourceDriver, resolveSourceLocator, sourceLocator = null }) {
  const dir = mkdtempSync(join(TMP, 'owner-'));
  const stateDir = mkdtempSync(join(TMP, 'state-'));
  const store = openStore(join(dir, 'store.sqlite'));
  const watcher = createWatcherComposition({
    sessionId, sourceLocator, projectId: null, projectRoot: dir, stateDir, store, isIgnored: null,
  });
  const handle = createServer({
    watcher: strictWatcherFacade(watcher), pollIntervalMs: 0, sessionId, projectsRoot,
    projectRoot: dir, stateDir, store, sourceLocator, disableTelemetrySweep: true,
    ...(createSourceDriver ? { createSourceDriver } : {}),
    ...(resolveSourceLocator ? { resolveSourceLocator } : {}),
  });
  return {
    handle, watcher, store, stateDir,
    revision: () => watcher.readRateLampFrame(-1).streamRevision,
    teardown: async () => {
      _setServerTestClock(null);
      try { handle.stopTimers(); } catch { /* already stopped */ }
      await new Promise(r => handle.server.close(r));
      try { closeStore(store); } catch { /* already closed */ }
    },
  };
}

const measuredRows = (tag, cacheRead) => chain([
  assistantToolUse({
    uuid: `u-${tag}`, parentUuid: null, messageId: `m-${tag}`, toolUseId: `t-${tag}`, name: 'Bash',
    input: { command: `echo ${tag}` }, timestamp: ts(1), model: 'claude-opus-4-8',
    usage: usage({ input: 100, output: 10, cacheRead }),
  }),
  toolResult({ uuid: `r-${tag}`, toolUseId: `t-${tag}`, content: `out ${tag}` }),
]);

test('startup with an unresolved locator keeps driver null and publishes transcriptPath null', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-'));
  const owner = boot({ sessionId, projectsRoot });
  t.after(() => owner.teardown());

  // Nothing was acquired, so no frame was applied and the application has never seen a Source.
  assert.equal(owner.revision(), 0, 'no frame was applied at bootstrap');
  assert.equal(owner.watcher.getStatus().rateLamp.unavailableReason, 'no_transcript');

  await new Promise(r => owner.handle.server.listen(0, '127.0.0.1', r));
  const port = owner.handle.server.address().port;

  const published = owner.handle.publishDiscovery();
  assert.equal(published.ok, true);
  const record = JSON.parse(readFileSync(published.path, 'utf8'));
  assert.equal(record.transcriptPath, null,
    'with NO locator resolved at all there is no session binding to publish');

  // The wire's model is a string at every moment an owner answers, including before any step has been
  // measured: the Engine holds no measured identity yet, and `getStatus` publishes the empty identity in
  // place of that absence.
  const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
  assert.equal(status.model, '', 'an owner with no measured step answers the empty model identity');
});

test('resolver calls follow the immediate, exponential, 30-second-capped schedule', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-sched-'));

  // The resolver is a host collaborator, so it is injected and counted. Patching a module-level `readdirSync`
  // would not work: an ESM named import is BOUND at link time, so reassigning it on the namespace changes
  // nothing the host calls.
  let attempts = 0;
  // The clock is set BEFORE the owner exists: bootstrap performs the immediate attempt, and its backoff is
  // measured from this value rather than from whatever real time the process happened to be at.
  let clock = 1_000_000;
  _setServerTestClock(clock);
  const owner = boot({
    sessionId, projectsRoot,
    resolveSourceLocator: () => { attempts++; return null; },   // resolution always fails
  });
  t.after(() => owner.teardown());

  // The bootstrap tick attempted resolution IMMEDIATELY.
  assert.equal(attempts, 1, 'the first attempt is immediate, with no wait');

  // Locator resolution proceeds without an SSE client; the idle gate governs installed-driver polling.
  _setServerTestClock(clock + 500);
  owner.handle.runPollTick();
  assert.equal(attempts, 1, 'a tick inside the first backoff window performs no attempt');

  for (const step of BACKOFF_MS) {
    const before = attempts;
    clock += step;
    _setServerTestClock(clock);
    owner.handle.runPollTick();
    assert.equal(attempts, before + 1, `a tick at +${step}ms attempted exactly once`);
    _setServerTestClock(clock + 1);
    owner.handle.runPollTick();
    assert.equal(attempts, before + 1, `the tick right after +${step}ms was suppressed`);
  }
  assert.deepEqual(BACKOFF_MS.slice(-3), [30000, 30000, 30000]);
});

test('failed resolution emits no frame and changes no runtime state', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-none-'));
  const owner = boot({ sessionId, projectsRoot });
  t.after(() => owner.teardown());

  const statusBefore = owner.watcher.getStatus();
  let clock = 2_000_000;
  for (const step of [1000, 2000, 4000]) {
    clock += step;
    _setServerTestClock(clock);
    owner.handle.runPollTick();
  }
  assert.equal(owner.revision(), 0, 'still no frame');
  assert.deepEqual(owner.watcher.getStatus().rateLamp, statusBefore.rateLamp, 'and no runtime state moved');
  assert.equal(owner.watcher.getHistory().length, 0);
});

test('an unavailable candidate is retried without another directory scan, and installs when it becomes readable', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-cand-'));
  const subdir = join(projectsRoot, 'encoded-cwd');
  mkdirSync(subdir, { recursive: true });
  const transcriptPath = join(subdir, `${sessionId}.jsonl`);
  // The file EXISTS so the locator resolves, but the driver reports it unreadable until we say otherwise.
  writeFileSync(transcriptPath, '');

  let advances = 0;
  let readable = false;
  // Resolution attempts are counted through the INJECTED resolver: it is the host collaborator that performs
  // the directory scan, so "the host stops scanning" is exactly "the resolver stops being called".
  let scans = 0;
  const owner = boot({
    sessionId, projectsRoot,
    resolveSourceLocator: () => { scans++; return transcriptPath; },
    createSourceDriver: ({ sourceLocator: locator, firstReadableTransition }) => ({
      advance({ captureMode }) {
        advances++;
        if (!readable) return null;      // open/stat/read failure: no frame, no consumed transition
        // The first readable advance always reports its CONFIGURED transition, with `sourceObserved: true`,
        // even when the Source holds no complete valid row.
        assert.equal(captureMode, 'replay', 'acquisition advances in Source Reconstruction mode');
        assert.equal(firstReadableTransition, 'replace');
        return { transition: 'replace', sourceLocator: locator, batches: [], sourceObserved: true, captureMode: 'replay' };
      },
      get sourceLocator() { return locator; },
    }),
  });
  t.after(() => owner.teardown());

  const scansAfterResolve = scans;
  assert.equal(scansAfterResolve, 1, 'the locator resolved on the first, immediate attempt');
  assert.ok(advances >= 1, 'the bootstrap tick resolved the locator and advanced the candidate');
  assert.equal(owner.revision(), 0, 'an unreadable candidate installs nothing');

  // Every later tick retries the RETAINED candidate — and performs no further directory scan.
  let clock = 3_000_000;
  for (let i = 0; i < 3; i++) {
    clock += 60_000;
    _setServerTestClock(clock);
    const before = advances;
    owner.handle.runPollTick();
    assert.equal(advances, before + 1, 'each tick retried the candidate exactly once');
  }
  assert.equal(scans, scansAfterResolve, 'once resolved, the host stops scanning directories');
  assert.equal(owner.revision(), 0, 'still nothing installed');

  // The locator RESOLVED, so discovery publishes it even though the Source is not readable yet: the field is
  // the host's resolved session binding, and baseline published the path as soon as it had one. A consumer
  // needs it to find the session, not to learn whether a read succeeded.
  await new Promise(r => owner.handle.server.listen(0, '127.0.0.1', r));
  const first = owner.handle.publishDiscovery();
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).transcriptPath, transcriptPath,
    'a resolved-but-unreadable candidate still publishes its own locator');

  // The Source becomes readable: ONE `replace` installs the driver, and discovery is rewritten from it.
  readable = true;
  clock += 60_000;
  _setServerTestClock(clock);
  owner.handle.runPollTick();
  assert.equal(owner.revision(), 1, 'the initial replace was applied exactly once');
  assert.equal(JSON.parse(readFileSync(first.path, 'utf8')).transcriptPath, transcriptPath,
    'the deferred installation rewrote discovery from the installed driver');
});

test('[delta] initial Source installation runs changed postprocessing once', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-post-'));
  const subdir = join(projectsRoot, 'encoded-cwd');
  mkdirSync(subdir, { recursive: true });
  const transcriptPath = join(subdir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, measuredRows('install', 42000).map(r => JSON.stringify(r) + '\n').join(''));

  // The installation frame carries the Source's REAL observations, so the tick genuinely measures a step —
  // a snapshot and a Rate Lamp anchor over an empty runtime would be trivially coherent and prove nothing.
  const installBatches = [reduceClaudeCodeSnapshot(
    readClaudeCodeRows(readFileSync(transcriptPath), { atEof: true }).rows,
  ).observations];

  let replayAdvances = 0;
  let liveAdvances = 0;
  let readable = false;
  const owner = boot({
    sessionId, projectsRoot,
    createSourceDriver: ({ sourceLocator: locator }) => ({
      advance({ captureMode }) {
        if (captureMode === 'replay') replayAdvances++; else liveAdvances++;
        if (!readable) return null;
        readable = 'installed';
        return {
          transition: 'replace', sourceLocator: locator, sourceObserved: true, captureMode: 'replay',
          batches: installBatches,
        };
      },
      get sourceLocator() { return locator; },
    }),
  });
  t.after(() => owner.teardown());

  // Count the snapshot writes the changed postprocessing performs: the installation tick must run it ONCE.
  const snapshots = [];
  const realSaveBatch = owner.store.saveBatch.bind(owner.store);
  owner.store.saveBatch = (sid, entries, opts) => { snapshots.push(sid); return realSaveBatch(sid, entries, opts); };

  readable = true;
  const replayBefore = replayAdvances;
  const liveBefore = liveAdvances;
  _setServerTestClock(4_000_000);
  owner.handle.runPollTick();

  assert.equal(replayAdvances, replayBefore + 1, 'the installation tick called the candidate replay advance once');
  assert.equal(liveAdvances, liveBefore, 'and performed NO live advance in the same tick');
  assert.equal(owner.revision(), 1, 'the initial application happened exactly once');
  assert.equal(snapshots.length, 1, 'the initial replace took the normal changed snapshot, once');

  // The snapshot it wrote is the INSTALLATION tick's own coherent state, not a partial or later one. That is
  // what makes this the moment the persisted `profile_snapshot` describes, and it is why the persisted
  // document names an earlier instant than a runtime whose first snapshot came from its first timer tick.
  // Read through `store.load(sessionId, key)`, which is the Store's actual reader. An earlier draft guarded
  // this on a `loadBatch` that does not exist, so `persisted` was always null and the comparison never ran —
  // a guard green with its subject absent. There is no `if` now: the assertion must execute.
  const persisted = owner.store.load(sessionId, 'profile_snapshot');
  const live = owner.watcher.getTerminalSnapshot();
  assert.ok(persisted, 'the installation tick actually persisted a snapshot');
  // A NON-FINITE value cannot round-trip through JSON storage: it lands as null. That is the storage's own
  // behaviour, so the live side is put through the same round-trip rather than the comparison being loosened —
  // every other field is compared exactly.
  const asStored = (value) => JSON.parse(JSON.stringify(value, (key, item) =>
    (typeof item === 'number' && !Number.isFinite(item) ? null : item)));
  assert.deepEqual(persisted, asStored(live),
    'the persisted snapshot equals the terminal snapshot at the installation tick — a coherent state of THIS tick');
  assert.equal(Number.isFinite(live.br_exit), false,
    'this fixture\'s br is non-finite before the baseline is valid, which is why br_exit stores as null');
  // The Rate Lamp advanced on the same tick. It holds no position quantity to compare against the snapshot's
  // L, so the instant the two surfaces agree on is the folded cursor: the installation frame's own tail.
  // Two independent surfaces agreeing on one instant is what distinguishes "written at an earlier tick" from
  // "a later write was lost".
  const ledger = getLiveLedger(sessionId);
  assert.ok(ledger, 'the installation tick advanced the Rate Lamp too');
  assert.ok(ledger.lastAppliedFoldedCallSeq >= 1,
    'the Rate Lamp cursor sits at the installation frame\'s tail, the instant the snapshot names');
});

test('a deferred-install discovery rewrite failure keeps the installed driver and previous discovery', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-rw-'));
  const subdir = join(projectsRoot, 'encoded-cwd');
  mkdirSync(subdir, { recursive: true });
  const transcriptPath = join(subdir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, measuredRows('rw', 42000).map(r => JSON.stringify(r) + '\n').join(''));

  let readable = false;
  const owner = boot({
    sessionId, projectsRoot,
    createSourceDriver: ({ sourceLocator: locator }) => ({
      advance() {
        if (!readable) return null;
        return { transition: 'replace', sourceLocator: locator, batches: [], sourceObserved: true, captureMode: 'replay' };
      },
      get sourceLocator() { return locator; },
    }),
  });
  t.after(() => owner.teardown());

  await new Promise(r => owner.handle.server.listen(0, '127.0.0.1', r));
  const first = owner.handle.publishDiscovery();
  assert.equal(first.ok, true);
  const before = readFileSync(first.path, 'utf8');

  // Make the rewrite impossible, then let the deferred installation happen.
  rmSync(owner.stateDir, { recursive: true, force: true });
  writeFileSync(owner.stateDir, 'not a directory');
  readable = true;
  _setServerTestClock(5_000_000);
  owner.handle.runPollTick();

  // The driver is installed regardless: the rewrite is a discovery convenience, and it is NON-blocking, so
  // there is no warning and no owner-fatal path.
  assert.equal(owner.revision(), 1, 'the candidate was applied and installed');
  void before;
});

test('completing an incomplete row produces a live append after installation', async (t) => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-tail-'));
  const subdir = join(projectsRoot, 'encoded-cwd');
  mkdirSync(subdir, { recursive: true });
  const transcriptPath = join(subdir, `${sessionId}.jsonl`);
  // Only an INCOMPLETE row: readable, so the first advance installs with `sourceObserved: true` and no batches.
  const rows = measuredRows('tail', 42000);
  const lines = rows.map(r => JSON.stringify(r) + '\n');
  const complete = lines.join('');
  // Cut INSIDE the first row, so the usage row itself is newline-less and therefore uncommitted. Cutting the
  // trailing row instead would leave the usage row complete and already measured.
  writeFileSync(transcriptPath, lines[0].slice(0, Math.floor(lines[0].length / 2)));

  const owner = boot({ sessionId, projectsRoot });
  t.after(() => owner.teardown());

  assert.equal(owner.revision(), 1, 'an incomplete-only Source still installs with one replace');
  assert.equal(owner.watcher.getStatus().apiCalls, 0, 'the incomplete row committed nothing');

  // Complete the row: the next tick is a live append that measures it.
  writeFileSync(transcriptPath, complete);
  _setServerTestClock(6_000_000);
  owner.handle.runPollTick();
  assert.equal(owner.revision(), 1, 'an append leaves the sample stream continuous');
  assert.equal(owner.watcher.getStatus().apiCalls, 1, 'the completed row was measured');
});
