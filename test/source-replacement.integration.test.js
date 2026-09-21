// Source replacement end to end: what an inode change, a truncation, a rewind and a post-rotation replace do
// to LIVE measurement state and to what is already ARCHIVED.
//
// The shared application, the real portable Engine, the real Claude Code Projection, a real source driver and a
// real Store on a temp database, wired only through the host's own composition root. The frames are taken from
// `driver.advance()` and inspected directly, because the transition and its capture mode are the subject here —
// a test that only looked at the aftermath could not tell a `replace` from a rebuild that happened to agree.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openStore, closeStore } from '../lib/store.js';
import { createWatcherComposition } from '../server.js';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';
import {
  assistantToolUse, chain, compactSummary, toolResult, ts, usage,
} from './helpers/transcript-fixtures.js';

const PROJECT = '/repo';
const numbered = (lines) => Array.from({ length: lines }, (unused, i) => `${i + 1}\tconst v${i} = ${i};`).join('\n');

let dir;
let stores;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sw-srcrepl-')); stores = []; });
afterEach(() => {
  for (const store of stores) { try { closeStore(store); } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

// One measured step whose tool use is a full Read, so the step carries BOTH step usage and a path event —
// which is what makes the archived telemetry tables non-empty and their primary-key sets worth asserting on.
const readStep = ({ tag, parent, absPath, cacheRead }) => [
  assistantToolUse({
    uuid: `u-${tag}`, parentUuid: parent, messageId: `m-${tag}`, toolUseId: `t-${tag}`, name: 'Read',
    input: { file_path: absPath }, timestamp: ts(2), model: 'claude-opus-4-8',
    usage: usage({ input: 100, output: 10, cacheRead, cacheWrite: 2000 }),
  }),
  toolResult({ uuid: `r-${tag}`, parentUuid: `u-${tag}`, toolUseId: `t-${tag}`, content: numbered(12) }),
];

// One persisted explicit epoch carrying step and path telemetry, followed by a POPULATED OPEN segment. The
// compact summary is a null-parent root with a call behind it, which is the only evidence that opens an epoch.
function baseRows(absPath) {
  return [
    ...readStep({ tag: 'a1', parent: null, absPath, cacheRead: 100000 }),
    ...readStep({ tag: 'a2', parent: 'r-a1', absPath, cacheRead: 102000 }),
    compactSummary({ uuid: 'c1', timestamp: ts(3), text: 'summary one' }),
    ...readStep({ tag: 'b1', parent: 'c1', absPath, cacheRead: 3000 }),
    ...readStep({ tag: 'b2', parent: 'r-b1', absPath, cacheRead: 5000 }),
  ];
}

const serialize = (rows) => rows.map(r => JSON.stringify(r) + '\n').join('');

function compose({ sessionId = 'sid-repl', sourceLocator }) {
  const store = openStore(join(dir, `store-${stores.length}.sqlite`));
  stores.push(store);
  const watcher = createWatcherComposition({
    sessionId, sourceLocator, projectId: PROJECT, projectRoot: PROJECT,
    stateDir: join(dir, 'state'), store, isIgnored: null,
  });
  return { store, watcher };
}

const revisionOf = (watcher) => watcher.readRateLampFrame(-1).streamRevision;

// The primary-key sets of the three archival tables. Their STABILITY is the claim: a replaced open segment
// must not archive, and a rebuild must not revise history.
function archivalKeys(store) {
  const keys = (sql) => store._db.prepare(sql).all().map(row => Object.values(row).join('|')).sort();
  return {
    profile: keys('SELECT session_id, segment FROM profile'),
    stepUsage: keys('SELECT session_id, segment, folded_seq FROM profile_step_usage'),
    pathEvent: keys('SELECT session_id, segment, folded_seq, event_ordinal FROM profile_path_event'),
  };
}

// What the Source on disk NOW says, computed by an INDEPENDENT reconstruction: a fresh application and a fresh
// driver over the same bytes. Comparing the live state to this is what "equal to the Source now on disk" means,
// rather than to a number written into the test.
function reconstructCounts(sourceLocator) {
  const { watcher } = compose({ sessionId: 'sid-oracle', sourceLocator });
  const driver = createClaudeCodeSourceDriver({ sourceLocator, firstReadableTransition: 'replace' });
  for (;;) {
    const frame = driver.advance({ captureMode: 'replay' });
    if (!frame) break;
    watcher.applyHarnessFrame(frame);
  }
  const status = watcher.getStatus();
  return { apiCalls: status.apiCalls, segment: status.segment };
}

test('[delta] inode replacement and truncation rebuild live state without creating a synthetic epoch or archiving the replaced open segment', () => {
  const absPath = join(PROJECT, 'alpha.js');
  const sourceLocator = join(dir, 'session.jsonl');
  const rows = baseRows(absPath);
  const fullBytes = serialize(rows);
  writeFileSync(sourceLocator, fullBytes);

  const { store, watcher } = compose({ sourceLocator });
  const driver = createClaudeCodeSourceDriver({ sourceLocator, firstReadableTransition: 'replace' });

  // Drive to the end of the Source: the explicit epoch archives, and the open segment is populated.
  for (;;) {
    const frame = driver.advance({ captureMode: 'replay' });
    if (!frame) break;
    watcher.applyHarnessFrame(frame);
  }
  const archivedBefore = archivalKeys(store);
  assert.ok(archivedBefore.profile.length >= 1, 'precondition: an explicit epoch archived');
  assert.ok(archivedBefore.stepUsage.length >= 1, 'precondition: it carried step telemetry');
  assert.ok(archivedBefore.pathEvent.length >= 1, 'precondition: and path telemetry');
  assert.ok(watcher.getStatus().apiCalls >= 1, 'precondition: the open segment is populated');

  // ── 1. INODE REPLACEMENT with identical bytes ───────────────────────────────
  // A different file at the same path. The bytes are identical, so nothing about the CONTENT changed; only the
  // Source's identity did, and a file-identity change never creates an epoch of its own.
  const inodeBefore = statSync(sourceLocator).ino;
  const swap = `${sourceLocator}.swap`;
  writeFileSync(swap, fullBytes);
  renameSync(swap, sourceLocator);
  assert.notEqual(statSync(sourceLocator).ino, inodeBefore, 'precondition: the inode really changed');

  const revisionBeforeInode = revisionOf(watcher);
  const inodeFrame = driver.advance({ captureMode: 'live' });
  assert.ok(inodeFrame, 'the rebuild produced a frame');
  assert.equal(inodeFrame.transition, 'replace', 'a file-identity change rebuilds rather than appending');
  assert.equal(inodeFrame.captureMode, 'live', 'and it retains the TRIGGERING capture mode');
  watcher.applyHarnessFrame(inodeFrame);

  assert.equal(revisionOf(watcher), revisionBeforeInode + 1, 'streamRevision advanced exactly once');
  assert.deepEqual(archivalKeys(store), archivedBefore,
    'the replaced open segment did not archive, and no archived row was revised');
  assert.deepEqual(
    { apiCalls: watcher.getStatus().apiCalls, segment: watcher.getStatus().segment },
    reconstructCounts(sourceLocator),
    'live call and epoch counts equal the Source now on disk — unchanged, because the bytes are identical');

  // ── 2. TRUNCATION to a shorter complete-row prefix ──────────────────────────
  // Cut at a row boundary, so the shortened Source is a valid prefix rather than a torn row.
  const prefixRows = rows.slice(0, 4);           // both steps of the closed epoch, plus its summary and one step
  const prefixBytes = serialize(prefixRows);
  assert.ok(prefixBytes.length < fullBytes.length, 'precondition: the prefix really is shorter');
  writeFileSync(sourceLocator, prefixBytes);

  const revisionBeforeTruncate = revisionOf(watcher);
  const truncFrame = driver.advance({ captureMode: 'live' });
  assert.ok(truncFrame, 'the truncation produced a frame');
  assert.equal(truncFrame.transition, 'replace');
  assert.equal(truncFrame.captureMode, 'live', 'it retains the triggering capture mode too');
  watcher.applyHarnessFrame(truncFrame);

  assert.equal(revisionOf(watcher), revisionBeforeTruncate + 1, 'streamRevision advanced exactly once');
  assert.deepEqual(archivalKeys(store), archivedBefore,
    'truncation archived nothing and revised nothing: the Source shrank, history did not');
  assert.deepEqual(
    { apiCalls: watcher.getStatus().apiCalls, segment: watcher.getStatus().segment },
    reconstructCounts(sourceLocator),
    'live counts are now exactly the PREFIX\'s');
});

test('a stale-branch rewind produces replace with captureMode replay', () => {
  const absPath = join(PROJECT, 'alpha.js');
  const sourceLocator = join(dir, 'rewind.jsonl');
  // Two steps on one chain, then a row that re-parents onto the FIRST — the branch the consumer holds stops
  // being canonical, so the increment is unusable and the whole Source is reconstructed.
  const rows = [
    ...readStep({ tag: 'w1', parent: null, absPath, cacheRead: 100000 }),
    ...readStep({ tag: 'w2', parent: 'r-w1', absPath, cacheRead: 102000 }),
  ];
  writeFileSync(sourceLocator, serialize(rows));
  const { watcher } = compose({ sessionId: 'sid-rewind', sourceLocator });
  const driver = createClaudeCodeSourceDriver({ sourceLocator, firstReadableTransition: 'replace' });
  for (;;) {
    const frame = driver.advance({ captureMode: 'replay' });
    if (!frame) break;
    watcher.applyHarnessFrame(frame);
  }

  writeFileSync(sourceLocator, serialize([
    ...rows,
    ...readStep({ tag: 'w3', parent: 'r-w1', absPath, cacheRead: 4000 }),   // re-parents onto the first step
  ]));
  // The caller asks for LIVE capture. A reconstruction reads already-written facts, so the frame it owes is
  // replay whatever the caller was doing — a frame built from history may not be labelled live capture.
  const frame = driver.advance({ captureMode: 'live' });
  assert.ok(frame, 'the rewind produced a frame');
  assert.equal(frame.transition, 'replace');
  assert.equal(frame.captureMode, 'replay', 'a rewind is a reconstruction, so its capture mode is replay');
});

test('[delta] post-rotation replace clears retained live measurement history without changing archives', () => {
  const absPath = join(PROJECT, 'alpha.js');
  const firstLocator = join(dir, 'first.jsonl');
  writeFileSync(firstLocator, serialize(baseRows(absPath)));

  const { store, watcher } = compose({ sessionId: 'sid-rot-a', sourceLocator: firstLocator });
  const firstDriver = createClaudeCodeSourceDriver({ sourceLocator: firstLocator, firstReadableTransition: 'replace' });
  for (;;) {
    const frame = firstDriver.advance({ captureMode: 'replay' });
    if (!frame) break;
    watcher.applyHarnessFrame(frame);
  }
  const historyBeforeRotation = watcher.getHistory().length;
  assert.ok(historyBeforeRotation >= 2, 'precondition: the first Source produced live history');

  // Rotate to a POPULATED second Source. A rotate retains the Engine and its history in a fresh segment.
  const secondLocator = join(dir, 'second.jsonl');
  const secondRows = [
    ...readStep({ tag: 'c1', parent: null, absPath, cacheRead: 20000 }),
    ...readStep({ tag: 'c2', parent: 'r-c1', absPath, cacheRead: 22000 }),
  ];
  writeFileSync(secondLocator, serialize(secondRows));
  const secondDriver = createClaudeCodeSourceDriver({ sourceLocator: secondLocator, firstReadableTransition: 'append' });
  const initial = secondDriver.advance({ captureMode: 'live' });
  watcher.applyHarnessFrame({
    transition: 'rotate', sessionId: 'sid-rot-b', sourceLocator: secondLocator,
    batches: initial ? initial.batches : [], sourceObserved: Boolean(initial), captureMode: 'live',
  });
  const archivedAfterRotation = archivalKeys(store);
  assert.ok(watcher.getHistory().length > historyBeforeRotation,
    'precondition: the rotation RETAINED the old history alongside the new Source\'s calls');

  // Now REPLACE the rotated-in Source. A replace rebuilds a fresh Engine from its own batches, which clears
  // the live history an earlier rotate retained — while persisted archives are untouched.
  const revisionBefore = revisionOf(watcher);
  const swap = `${secondLocator}.swap`;
  writeFileSync(swap, serialize(secondRows));
  renameSync(swap, secondLocator);
  const replaceFrame = secondDriver.advance({ captureMode: 'live' });
  assert.ok(replaceFrame, 'the identity change produced a frame');
  assert.equal(replaceFrame.transition, 'replace');
  watcher.applyHarnessFrame(replaceFrame);

  assert.equal(revisionOf(watcher), revisionBefore + 1, 'streamRevision advanced exactly once');
  // The rebuilt live state contains ONLY the replacement Source: the pre-rotation history is gone.
  assert.deepEqual(
    { apiCalls: watcher.getStatus().apiCalls, segment: watcher.getStatus().segment },
    reconstructCounts(secondLocator),
    'the rebuilt live state is exactly the replacement Source');
  assert.equal(watcher.getHistory().length, reconstructCounts(secondLocator).apiCalls,
    'the retained pre-rotation history was cleared, leaving only the replacement Source\'s calls');
  assert.deepEqual(archivalKeys(store), archivedAfterRotation,
    'and no archived profile or telemetry row changed');
});
