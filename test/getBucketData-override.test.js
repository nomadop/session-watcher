// test/getBucketData-override.test.js — Task 3: userOverride field in getBucketData()
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function makeWatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-bd-'));
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, '');
  return new SessionWatcher(p, 1000, { cwd: '/workspace' });
}

test('getBucketData paths include userOverride: null when no override', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/src/a.js', 1, 1);
  const bd = w.getBucketData();
  const entry = bd.paths.find(p => p.path === '/workspace/src/a.js');
  assert.ok(entry);
  assert.equal(entry.userOverride, null);
});

test('getBucketData paths include userOverride: "exclude" when overridden', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/src/a.js', 1, 1);
  w._userOverrides.set('/workspace/src/a.js', 'exclude');
  const bd = w.getBucketData();
  const entry = bd.paths.find(p => p.path === '/workspace/src/a.js');
  assert.ok(entry);
  assert.equal(entry.userOverride, 'exclude');
});

test('getBucketData paths include userOverride: "include" when overridden', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/dist/x.js', 1, 1);
  w._userOverrides.set('/workspace/dist/x.js', 'include');
  const bd = w.getBucketData();
  const entry = bd.paths.find(p => p.path === '/workspace/dist/x.js');
  assert.ok(entry);
  assert.equal(entry.userOverride, 'include');
});

test('getBucketData skills include userOverride: null when no override', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, 'skill:deep-research', 1, 1);
  const bd = w.getBucketData();
  const entry = bd.skills.find(s => s.name === 'deep-research');
  assert.ok(entry);
  assert.equal(entry.userOverride, null);
});

test('getBucketData skills include userOverride: "exclude" when overridden', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, 'skill:deep-research', 1, 1);
  w._userOverrides.set('skill:deep-research', 'exclude');
  const bd = w.getBucketData();
  const entry = bd.skills.find(s => s.name === 'deep-research');
  assert.ok(entry);
  assert.equal(entry.userOverride, 'exclude');
});
