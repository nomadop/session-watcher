import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sweepStaleState } from '../lib/state-reaper.js';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'sw-reaper-')); }
function writeJson(dir, name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
function setMtimeOld(path, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(path, t, t);
}

test('sweepStaleState deletes .json files older than 7 days', () => {
  const dir = tmpDir();
  const old = writeJson(dir, 'old-session.json', { x: 1 });
  setMtimeOld(old, 10);
  writeJson(dir, 'fresh-session.json', { x: 2 });
  const removed = sweepStaleState([dir], { now: Date.now() });
  assert.equal(removed, 1);
  const remaining = readdirSync(dir);
  assert.ok(!remaining.includes('old-session.json'));
  assert.ok(remaining.includes('fresh-session.json'));
});

test('sweepStaleState skips non-.json files', () => {
  const dir = tmpDir();
  const p = join(dir, 'note.txt');
  writeFileSync(p, 'hello');
  setMtimeOld(p, 10);
  assert.equal(sweepStaleState([dir], { now: Date.now() }), 0);
});

test('sweepStaleState skips missing directories gracefully', () => {
  assert.equal(sweepStaleState(['/nonexistent-dir-xyz'], { now: Date.now() }), 0);
});

test('sweepStaleState PORT_DIR: skips old file if pid is alive', () => {
  const dir = tmpDir();
  const p = writeJson(dir, 'live.json', { pid: process.pid, port: 12345 });
  setMtimeOld(p, 10);
  assert.equal(sweepStaleState([dir], { now: Date.now(), portDir: dir }), 0, 'live pid must not be reaped');
});

test('sweepStaleState PORT_DIR: deletes old file if pid is dead', () => {
  const dir = tmpDir();
  writeJson(dir, 'dead.json', { pid: 99999999, port: 12345 });
  setMtimeOld(join(dir, 'dead.json'), 10);
  assert.equal(sweepStaleState([dir], { now: Date.now(), portDir: dir }), 1, 'dead pid should be reaped');
});

test('sweepStaleState PORT_DIR: deletes old file with non-numeric pid', () => {
  const dir = tmpDir();
  const p = writeJson(dir, 'corrupt.json', { pid: "abc", port: 12345 });
  setMtimeOld(p, 10);
  assert.equal(sweepStaleState([dir], { now: Date.now(), portDir: dir }), 1);
});

test('sweepStaleState PORT_DIR: deletes old file with null pid', () => {
  const dir = tmpDir();
  const p = writeJson(dir, 'nullpid.json', { pid: null, port: 12345 });
  setMtimeOld(p, 10);
  assert.equal(sweepStaleState([dir], { now: Date.now(), portDir: dir }), 1);
});
