import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readdirSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initStore, closeStoreGlobal, getStore } from '../lib/store.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-reaper-'));
  initStore(join(dir, 'test.sqlite'));
});
afterEach(() => {
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(d, name, obj) {
  const p = join(d, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function setMtimeOld(path, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(path, t, t);
}

test('sweepStaleState removes expired sessions from store', async () => {
  const { sweepStaleState } = await import('../lib/state-reaper.js');
  const store = getStore();
  // Insert an old session directly
  const old = Date.now() - 8 * 24 * 3600 * 1000;
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)').run('old1', old, old);
  store._db.prepare("INSERT INTO state (session_id, key, value, updated_at) VALUES ('old1', 'ledger', '{}', ?)").run(old);
  // Fresh session
  store.save('fresh1', 'ledger', { x: 1 });
  const count = sweepStaleState();
  assert.equal(count, 1);
  assert.equal(store.load('old1', 'ledger'), null);
  assert.deepEqual(store.load('fresh1', 'ledger'), { x: 1 });
});

test('sweepStaleState respects custom maxAgeMs', async () => {
  const { sweepStaleState } = await import('../lib/state-reaper.js');
  const store = getStore();
  // Insert a session that is 2 days old
  const twoDay = Date.now() - 2 * 24 * 3600 * 1000;
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)').run('med1', twoDay, twoDay);
  // Default 7-day max: should NOT sweep
  assert.equal(sweepStaleState(), 0);
  // 1-day max: should sweep
  assert.equal(sweepStaleState({ maxAgeMs: 1 * 24 * 3600 * 1000 }), 1);
});

test('sweepStalePortFiles removes old port files with dead pid', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  const p = writeJson(portDir, 'dead.json', { pid: 99999999, port: 12345 });
  setMtimeOld(p, 10);
  const count = sweepStalePortFiles(portDir);
  assert.equal(count, 1);
  rmSync(portDir, { recursive: true, force: true });
});

test('sweepStalePortFiles skips files with live pid', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  const p = writeJson(portDir, 'live.json', { pid: process.pid, port: 12345 });
  setMtimeOld(p, 10);
  const count = sweepStalePortFiles(portDir);
  assert.equal(count, 0);
  rmSync(portDir, { recursive: true, force: true });
});

test('sweepStalePortFiles skips fresh files', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  writeJson(portDir, 'fresh.json', { pid: 99999999, port: 12345 });
  // No mtime change — it's fresh
  const count = sweepStalePortFiles(portDir);
  assert.equal(count, 0);
  rmSync(portDir, { recursive: true, force: true });
});

test('sweepStalePortFiles handles missing directory gracefully', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  assert.equal(sweepStalePortFiles('/nonexistent-dir-xyz'), 0);
});

test('sweepStalePortFiles removes old file with non-numeric pid', async () => {
  const { sweepStalePortFiles } = await import('../lib/state-reaper.js');
  const portDir = mkdtempSync(join(tmpdir(), 'sw-ports-'));
  const p = writeJson(portDir, 'corrupt.json', { pid: "abc", port: 12345 });
  setMtimeOld(p, 10);
  assert.equal(sweepStalePortFiles(portDir), 1);
  rmSync(portDir, { recursive: true, force: true });
});

// ── turn-notes epoch directories ──────────────────────────────────────────────
// The age fallback behind the two note files. Their normal lifetime is one submission
// (server.js rmSync's the pair on commit); every route that never reaches commit — an abandoned
// producer, a twice-rejected submission, a SIGKILL — leaves the pair on disk with nobody to delete it.

// One epoch directory in the shape the server writes it. `daysAgo` ages BOTH files and the
// directory itself, so an aged directory has no recent mtime anywhere in it.
function makeEpochDir(stateDir, name, { daysAgo = null } = {}) {
  const d = join(stateDir, 'turn-notes', name);
  mkdirSync(d, { recursive: true });
  const skeleton = join(d, 'skeleton.txt');
  const notes = join(d, 'notes.md');
  writeFileSync(skeleton, 'CONTEXT EPOCH  session sess-A   turns 3');
  writeFileSync(notes, '## NOTE[0]\n');
  if (daysAgo != null) { setMtimeOld(skeleton, daysAgo); setMtimeOld(notes, daysAgo); setMtimeOld(d, daysAgo); }
  return { dir: d, skeleton, notes };
}

test('sweepStaleTurnNotes removes an expired epoch directory and keeps a fresh one', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  const stale = makeEpochDir(dir, 'sess-A-anchor-old', { daysAgo: 10 });
  const fresh = makeEpochDir(dir, 'sess-A-anchor-new');
  assert.equal(sweepStaleTurnNotes(dir), 1);
  assert.equal(existsSync(stale.dir), false);
  assert.equal(existsSync(fresh.notes), true);
});

// The load-bearing case. On Linux a directory's mtime moves when an entry is created, renamed or
// unlinked — NOT when a file inside it is written. A producer filling notes.md over a long-lived
// epoch, and a re-fetch overwriting skeleton.txt, both leave the directory mtime at creation time,
// so judging age by the directory alone deletes the notes of an epoch still being written.
test('sweepStaleTurnNotes keeps a directory whose files are fresh even when its own mtime is old', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  const d = makeEpochDir(dir, 'sess-A-anchor-live', { daysAgo: 10 });
  writeFileSync(d.notes, '## NOTE[0]\n\nstill being written\n');   // fresh mtime on the file only
  assert.equal(sweepStaleTurnNotes(dir), 0);
  assert.equal(existsSync(d.dir), true);
});

// The server only ever creates directories here, so anything else under turn-notes/ is not its own —
// same rule the notes file itself follows: never delete what this server did not write.
test('sweepStaleTurnNotes skips a non-directory entry under turn-notes', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  mkdirSync(join(dir, 'turn-notes'), { recursive: true });
  const stray = join(dir, 'turn-notes', 'someone-elses-file');
  writeFileSync(stray, 'not ours');
  setMtimeOld(stray, 30);
  assert.equal(sweepStaleTurnNotes(dir), 0);
  assert.equal(existsSync(stray), true);
});

// What the isDirectory() guard actually carries. A plain file is already refused by readdirSync's
// ENOTDIR, but readdirSync FOLLOWS a symlink to a directory and Dirent.isDirectory() (lstat semantics)
// reports false for one — so without the guard a link planted here would be judged by its target's
// age and then unlinked.
test('sweepStaleTurnNotes never follows a symlink under turn-notes', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  mkdirSync(join(dir, 'turn-notes'), { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), 'sw-reaper-outside-'));
  const victim = join(outside, 'keep.txt');
  writeFileSync(victim, 'not ours');
  setMtimeOld(victim, 30);
  setMtimeOld(outside, 30);
  const link = join(dir, 'turn-notes', 'sess-A-anchor-link');
  symlinkSync(outside, link);                  // never setMtimeOld(link) — utimesSync follows it
  assert.equal(sweepStaleTurnNotes(dir), 0);
  // The link surviving is the whole assertion. rmSync unlinks a symlink rather than descending it, so
  // the target outlives the guard's removal either way and asserting on it would assert nothing.
  assert.equal(existsSync(link), true);
  rmSync(outside, { recursive: true, force: true });
});

// The per-entry catch, mutated away, leaves the whole directory unreapable — the leak direction. A
// dangling symlink throws ENOENT out of statSync exactly as an entry another process unlinked between
// the readdir and the stat does, and that other process is a concurrent submitTurnNotes rmSync.
test('sweepStaleTurnNotes reaps an expired directory even when one entry cannot be stat-ed', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  const d = makeEpochDir(dir, 'sess-A-anchor-dangling', { daysAgo: 10 });
  symlinkSync(join(d.dir, 'gone.txt'), join(d.dir, 'dangling'));   // target never created
  setMtimeOld(d.dir, 10);   // creating that entry moved the directory's mtime to now
  assert.equal(sweepStaleTurnNotes(dir), 1);
  assert.equal(existsSync(d.dir), false);
});

// mkdirSync lands before either writeFileSync, so an ENOSPC or a kill between them leaves a directory
// with no file to take an age from — its own mtime is then the only one there is, and it has to decide
// in BOTH directions. Keeping the fresh one is not enough: a rule that never reaps an empty directory
// leaks the exact case this sweep was added for.
test('sweepStaleTurnNotes ages an empty directory by its own mtime', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  const fresh = join(dir, 'turn-notes', 'sess-A-anchor-empty-fresh');
  const stale = join(dir, 'turn-notes', 'sess-A-anchor-empty-stale');
  mkdirSync(fresh, { recursive: true });
  mkdirSync(stale, { recursive: true });
  setMtimeOld(stale, 10);
  assert.equal(sweepStaleTurnNotes(dir), 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test('sweepStaleTurnNotes handles a missing turn-notes directory gracefully', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  assert.equal(sweepStaleTurnNotes(dir), 0);
  assert.equal(sweepStaleTurnNotes('/nonexistent-dir-xyz'), 0);
});

// Both sides of the default, one day apart, so the only whole-day threshold that satisfies the pair is
// the 7 days shared with the other two sweeps — the retention window of an UNREDACTED projection is not
// something a loose bracket should leave free to drift.
test('sweepStaleTurnNotes brackets the shared 7-day default, and honours injected maxAgeMs and now', async () => {
  const { sweepStaleTurnNotes } = await import('../lib/state-reaper.js');
  const six = makeEpochDir(dir, 'sess-A-anchor-six-day', { daysAgo: 6 });
  const eight = makeEpochDir(dir, 'sess-A-anchor-eight-day', { daysAgo: 8 });
  assert.equal(sweepStaleTurnNotes(dir), 1);
  assert.equal(existsSync(eight.dir), false);
  assert.equal(existsSync(six.dir), true);
  assert.equal(sweepStaleTurnNotes(dir, { maxAgeMs: 5 * 86400000 }), 1);
  assert.equal(existsSync(six.dir), false);
  // `now` is the clock the age is measured against, not Date.now(): moved forward, a fresh directory ages.
  const fresh = makeEpochDir(dir, 'sess-A-anchor-fresh-clock');
  assert.equal(sweepStaleTurnNotes(dir, { now: Date.now() + 8 * 86400000 }), 1);
  assert.equal(existsSync(fresh.dir), false);
});
