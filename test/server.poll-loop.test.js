// The one poll tick, at the seams the host owns: synchronous bootstrap, listen-time discovery, the
// owner-fatal sink, the non-blocking operations' own guards, and the idle gate.
//
// The pre-cutover shape of this file asserted that a throwing tick was SWALLOWED so the daemon stayed up.
// That is retired: an unclassified application failure is owner-fatal now, which is an approved delta. What
// survives is the narrower promise — the NON-blocking work inside a tick (rate lamp, snapshot, SSE) still
// catches its own failure, so a disk or client fault cannot stop later ticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate ledger/gate state writes to a temp CLAUDE_PLUGIN_DATA (read lazily per call by the stores, so
// setting it before importing the server suffices).
const TMP = mkdtempSync(join(tmpdir(), 'sw-pollloop-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { _setServerTestClock, IDLE_SHUTDOWN_MS, SNAPSHOT_THROTTLE_MS } from '../server.js';
import { composeForTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';
import { assistantToolUse, toolResult, ts, usage } from './helpers/transcript-fixtures.js';

const IDLE_HEARTBEAT_GAP = 60_000;   // any gap the heartbeat threshold cannot exceed

// ── 1. Synchronous bootstrap ─────────────────────────────────────────────────

test('with pollIntervalMs 0 and a readable Source, bootstrap applies one replay replace before the first read', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());
  const transcriptPath = writeMeasuredTranscript({ steps: 3 });
  const composed = composeForTranscript({ transcriptPath, sessionId: `boot-${randomUUID()}` });
  t.after(() => composed.teardown());

  // A fresh application sits at revision 0; a `replace` increments it, and an append does not. So exactly
  // one runtime-replacing frame has been applied — and it landed BEFORE any read, which is what makes
  // bootstrap synchronous rather than a promise the first request races.
  assert.equal(composed.watcher.readRateLampFrame(-1).streamRevision, 1);
  assert.equal(composed.watcher.getStatus().apiCalls, 3, 'every step was measured before the first read');
  assert.ok(composed.watcher.getHistory().length >= 3);
  assert.ok(composed.watcher.getBucketData().segment >= 0);

  await new Promise(r => composed.handle.server.listen(0, '127.0.0.1', r));
  // Listen-time discovery carries the INSTALLED driver's locator, not the pre-bootstrap candidate's.
  const published = composed.handle.publishDiscovery();
  assert.equal(published.ok, true);
  const record = JSON.parse(readFileSync(published.path, 'utf8'));
  assert.equal(record.transcriptPath, transcriptPath);
  assert.deepEqual(Object.keys(record).sort(),
    ['clientPid', 'pid', 'port', 'sessionId', 'startedAt', 'transcriptPath'],
    'the discovery record is exactly the six retained fields');
});

// ── 2. Listen-time discovery creation failure ────────────────────────────────

test('listen-time discovery creation failure is reported so the owner can refuse to start', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());
  // A state dir whose PARENT component is a regular file: `mkdirSync` cannot create it and the write cannot
  // land, which is ENOTDIR. Chosen over a permission bit because this suite may run as a user that bypasses
  // permission checks entirely, and then the failure under test would never occur.
  const blockerDir = mkdtempSync(join(tmpdir(), 'sw-disc-'));
  const blocker = join(blockerDir, 'not-a-directory');
  writeFileSync(blocker, 'this is a file, not a directory');
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1 }), sessionId: `disc-${randomUUID()}`,
    stateDir: join(blocker, 'state'),
  });
  t.after(() => composed.teardown());
  await new Promise(r => composed.handle.server.listen(0, '127.0.0.1', r));

  const published = composed.handle.publishDiscovery();
  assert.equal(published.ok, false, 'the writer REPORTS the failure rather than throwing');
  assert.deepEqual(composed.handle.publishedDiscoveryPaths(), [],
    'a record that was never written is not one this owner may later delete');
});

// ── 3. A blocking Source-frame error is owner-fatal, once ────────────────────

test('a blocking frame error notifies onOwnerFatal once, stops the timer, and advances no further', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());

  let advances = 0;
  let installed = false;
  const failingDriver = {
    advance() {
      advances++;
      if (installed) return { transition: 'append', batches: [[{ type: 'wildly-unknown' }]], sourceObserved: true, captureMode: 'live' };
      installed = true;
      return { transition: 'replace', sourceLocator: '/fixture/fatal.jsonl', batches: [], sourceObserved: true, captureMode: 'replay' };
    },
    get sourceLocator() { return '/fixture/fatal.jsonl'; },
  };

  const fatals = [];
  const sessionId = `fatal-${randomUUID()}`;
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1 }), sessionId,
    pollIntervalMs: 5, createSourceDriver: () => failingDriver,
    onOwnerFatal: (error) => fatals.push(error),
  });
  t.after(() => composed.teardown());

  const afterBootstrap = advances;
  composed.handle.startPolling();
  await new Promise(r => setTimeout(r, 60));   // many intervals would have elapsed

  assert.equal(fatals.length, 1, 'the sink is notified AT MOST once');
  assert.equal(advances, afterBootstrap + 1, 'the timer stopped, so no later Source advance happened');
  // The unclassified record never became a measured call, and no segment was archived from it.
  assert.equal(composed.store.getProfileSegments(sessionId).length, 0);
});

// ── 4. The non-blocking operations catch their own failures ──────────────────

test('a snapshot write failure does not stop later ticks', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());

  const transcriptPath = writeMeasuredTranscript({ steps: 1 });
  const composed = composeForTranscript({ transcriptPath, sessionId: `snap-${randomUUID()}` });
  t.after(() => composed.teardown());

  // The snapshot write is a store call inside the changed postprocessing. Making it throw is the shape a
  // disk fault takes; the tick must still complete and the NEXT tick must still run.
  const realSaveBatch = composed.store.saveBatch.bind(composed.store);
  let attempts = 0;
  composed.store.saveBatch = () => { attempts++; throw new Error('ENOSPC'); };
  t.after(() => { composed.store.saveBatch = realSaveBatch; _setServerTestClock(null); });

  // The snapshot write is THROTTLED and bootstrap's own changed frame already took the first slot, so the
  // clock has to clear the throttle window before a later changed tick reaches the write at all.
  _setServerTestClock(10 * SNAPSHOT_THROTTLE_MS);
  // A changed tick: append a new measured step so the snapshot path is reached.
  composed.appendRows(stepRows('a', 71000), { parentUuid: 'sr0' });
  assert.ok(attempts >= 1, 'the failing snapshot write was actually attempted');

  // A LATER tick still applies its frame, which is what "does not stop later ticks" means.
  const before = composed.watcher.getStatus().apiCalls;
  _setServerTestClock(20 * SNAPSHOT_THROTTLE_MS);
  composed.appendRows(stepRows('b', 72000), { parentUuid: 'sr-a' });
  assert.ok(composed.watcher.getStatus().apiCalls > before, 'the next tick measured its step');
});

// ── 5. An installed-driver no-frame tick ─────────────────────────────────────

test('a no-frame tick updates the poll timestamp, advances Rate Lamp, and applies no frame', async (t) => {
  _resetRateLampManagerForTest();
  _setServerTestClock(null);
  t.after(() => { _setServerTestClock(null); _resetRateLampManagerForTest(); });

  let advances = 0;
  let installed = false;
  const quietDriver = {
    advance() {
      advances++;
      if (installed) return null;          // readable, but no new rows
      installed = true;
      return { transition: 'replace', sourceLocator: '/fixture/quiet.jsonl', batches: [], sourceObserved: true, captureMode: 'replay' };
    },
    get sourceLocator() { return '/fixture/quiet.jsonl'; },
  };

  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1 }), sessionId: `quiet-${randomUUID()}`,
    createSourceDriver: () => quietDriver,
  });
  t.after(() => composed.teardown());

  const revisionBefore = composed.watcher.readRateLampFrame(-1).streamRevision;
  const callsBefore = composed.watcher.getStatus().apiCalls;

  // A no-frame tick still ran an advance and still updated the poll timestamp.
  const base = 10 * IDLE_SHUTDOWN_MS;
  _setServerTestClock(base);
  const advancesBefore = advances;
  composed.handle.runPollTick();
  assert.equal(advances, advancesBefore + 1, 'the tick performed exactly one Source advance');
  assert.equal(composed.watcher.readRateLampFrame(-1).streamRevision, revisionBefore,
    'no frame was applied, so the sample stream stayed continuous');
  assert.equal(composed.watcher.getStatus().apiCalls, callsBefore, 'and nothing was measured');

  // Because the timestamp moved, the idle gate suppresses the NEXT tick with no SSE client attached.
  _setServerTestClock(base + 1);
  composed.handle.runPollTick();
  assert.equal(advances, advancesBefore + 1, 'the gate suppressed the next tick entirely');

  // Once the heartbeat gap has passed, the gate opens again.
  _setServerTestClock(base + IDLE_HEARTBEAT_GAP);
  composed.handle.runPollTick();
  assert.equal(advances, advancesBefore + 2, 'a tick beyond the heartbeat gap runs');
});

// One measured step plus its result, for the append-driven ticks above.
function stepRows(tag, cacheRead) {
  return [
    assistantToolUse({
      uuid: `s-${tag}`, messageId: `sm-${tag}`, toolUseId: `st-${tag}`, name: 'Bash',
      input: { command: `echo ${tag}` }, timestamp: ts(6), model: 'deepseek-v4-pro',
      usage: usage({ input: 40, output: 30, cacheRead }),
    }),
    toolResult({ uuid: `sr-${tag}`, toolUseId: `st-${tag}`, content: `out ${tag}` }),
  ];
}

// ── The frame diagnostic channel has a consumer ───────────────────────────────
// The Projection cannot print: reading process-global env is what its layering forbids. So it emits a
// diagnostic and host wiring writes the line. An earlier cutover branched on a code NO producer emits
// (`load_token_conflict` where the Projection emits `multiple_load_tokens`), so the channel was dead and every
// code was silently discarded. These pin that it is live, and that the one line the baseline printed is that
// line verbatim.
test('a frame diagnostic reaches stderr under SW_DEBUG, with the baseline text for the load-token case', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());

  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  const realDebug = process.env.SW_DEBUG;
  process.env.SW_DEBUG = '1';
  t.after(() => {
    console.error = realError;
    if (realDebug === undefined) delete process.env.SW_DEBUG; else process.env.SW_DEBUG = realDebug;
  });

  // Two DIFFERENT load tokens in one issuing step: the shape the Projection reports, reached from the Source.
  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1, extraEntries: twoLoadTokenRows() }),
    sessionId: `diag-${randomUUID()}`,
  });
  t.after(() => composed.teardown());

  assert.ok(lines.some(line => line === '[telemetry] multiple load_handoff tokens in one step; keeping first'),
    `the baseline line was written verbatim; saw ${JSON.stringify(lines)}`);
});

test('a diagnostic code the specific branch does not name still reaches the debug sink', async (t) => {
  _resetRateLampManagerForTest();
  t.after(() => _resetRateLampManagerForTest());

  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  const realDebug = process.env.SW_DEBUG;
  process.env.SW_DEBUG = '1';
  t.after(() => {
    console.error = realError;
    if (realDebug === undefined) delete process.env.SW_DEBUG; else process.env.SW_DEBUG = realDebug;
  });

  const composed = composeForTranscript({
    transcriptPath: writeMeasuredTranscript({ steps: 1 }), sessionId: `diag2-${randomUUID()}`,
  });
  t.after(() => composed.teardown());

  // A LOWER-total revision of an existing step: the Engine keeps its higher-total usage and reports
  // `usage_revision_ignored`. That code is not the one the specific branch names, so it exercises the general
  // sink — which is exactly what a dead channel used to discard.
  lines.length = 0;
  composed.appendRows([
    assistantToolUse({
      uuid: 'u-rev', messageId: 'sm0', toolUseId: 't-rev', name: 'Bash',
      input: { command: 'echo rev' }, timestamp: ts(9),
      usage: usage({ input: 1, output: 1, cacheRead: 1 }),
    }),
    toolResult({ uuid: 'r-rev', toolUseId: 't-rev', content: 'ok' }),
  ], { parentUuid: 'sr0' });

  assert.ok(lines.some(line => line.includes('usage_revision_ignored')),
    `the general sink wrote the diagnostic; saw ${JSON.stringify(lines)}`);
  assert.ok(lines.some(line => line.startsWith('[measurement-engine]')),
    'and tagged it with the diagnostic\'s own scope');
});

// One issuing step carrying two load_handoff tool uses with DIFFERENT explicit tokens.
function twoLoadTokenRows() {
  const LOAD = 'mcp__plugin_session-watcher_session-watcher__load_handoff';
  return [
    assistantToolUse({
      uuid: 'u-ld1', messageId: 'm-ld', toolUseId: 't-ld1', name: LOAD,
      input: { load_token: 'first-token' }, timestamp: ts(7),
      usage: usage({ input: 40, output: 30, cacheRead: 95000 }),
    }),
    toolResult({ uuid: 'r-ld1', toolUseId: 't-ld1', content: 'ok' }),
    assistantToolUse({
      uuid: 'u-ld2', messageId: 'm-ld', toolUseId: 't-ld2', name: LOAD,
      input: { load_token: 'second-token' }, timestamp: ts(8),
    }),
    toolResult({ uuid: 'r-ld2', toolUseId: 't-ld2', content: 'ok' }),
  ];
}
