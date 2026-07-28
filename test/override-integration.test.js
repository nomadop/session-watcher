// test/override-integration.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function makeWatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-infer-'));
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, '');
  const w = new SessionWatcher(p, 1000, { cwd: '/workspace' });
  w._isIgnored = () => false; // no gitignore
  return w;
}

test('new path inherits override when all siblings unanimously overridden', () => {
  const w = makeWatcher();
  // Existing siblings (absolute paths — matches canonicalizePath output)
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/src/a.js', 1, 1);
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, '/workspace/src/b.js', 1, 1);
  // User excludes both
  w._userOverrides.set('/workspace/src/a.js', 'exclude');
  w._userOverrides.set('/workspace/src/b.js', 'exclude');

  // Simulate new path arrival — call the inference hook
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 0 }, '/workspace/src/c.js', 1, 1);
  w._tryInferOverride('/workspace/src/c.js');

  assert.equal(w._userOverrides.get('/workspace/src/c.js'), 'exclude');
});

test('new path does NOT inherit when siblings are mixed', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/src/a.js', 1, 1);
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, '/workspace/src/b.js', 1, 1);
  w._userOverrides.set('/workspace/src/a.js', 'exclude');
  // /workspace/src/b.js has no override (auto-included)

  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 0 }, '/workspace/src/c.js', 1, 1);
  w._tryInferOverride('/workspace/src/c.js');

  assert.equal(w._userOverrides.has('/workspace/src/c.js'), false);
});

test('skill: prefixed paths are excluded from inference', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, 'skill:a', 1, 1);
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, 'skill:b', 1, 1);
  w._userOverrides.set('skill:a', 'exclude');
  w._userOverrides.set('skill:b', 'exclude');

  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 0 }, 'skill:c', 1, 1);
  w._tryInferOverride('skill:c');

  // Skills are excluded from inference (manual-only)
  assert.equal(w._userOverrides.has('skill:c'), false);
});

test('new path inherits include when all siblings unanimously included (overriding gitignore)', () => {
  const w = makeWatcher();
  // Simulate gitignored paths that the user has manually included
  w._isIgnored = (rel) => rel.startsWith('dist/');
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/dist/a.js', 1, 1);
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 300]], overhead: 0 }, '/workspace/dist/b.js', 1, 1);
  w._userOverrides.set('/workspace/dist/a.js', 'include');
  w._userOverrides.set('/workspace/dist/b.js', 'include');

  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 200]], overhead: 0 }, '/workspace/dist/c.js', 1, 1);
  w._tryInferOverride('/workspace/dist/c.js');

  assert.equal(w._userOverrides.get('/workspace/dist/c.js'), 'include');
});
