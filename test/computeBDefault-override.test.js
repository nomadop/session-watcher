// test/computeBDefault-override.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function makeWatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'sw-override-'));
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, '');
  const w = new SessionWatcher(p, 1000, { cwd: '/workspace' });
  w._bRebuild.setDead(1000); // simulate fold pipeline's dead anchor
  return w;
}

test('_computeBDefault includes overridden-include path that was auto-excluded', () => {
  const w = makeWatcher();
  // Simulate a path in _bRebuild
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 500]], overhead: 0 }, '/workspace/dist/bundle.js', 1, 1);
  // Inject isIgnored to simulate gitignore exclusion
  w._isIgnored = (rel) => rel.startsWith('dist/');

  const withoutOverride = w._computeBDefault();
  // dist/bundle.js should be excluded by default
  assert.equal(withoutOverride, 1000); // only dead

  // Now add override
  w._userOverrides.set('/workspace/dist/bundle.js', 'include');
  const withOverride = w._computeBDefault();
  assert.equal(withOverride, 1500); // dead + 500
});

test('_computeBDefault excludes overridden-exclude path that was auto-included', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 800]], overhead: 0 }, '/workspace/src/big.ts', 1, 1);
  w._isIgnored = () => false;

  const withoutOverride = w._computeBDefault();
  assert.equal(withoutOverride, 1800); // dead + 800

  w._userOverrides.set('/workspace/src/big.ts', 'exclude');
  const withOverride = w._computeBDefault();
  assert.equal(withOverride, 1000); // only dead
});

test('segmentReset clears _userOverrides', () => {
  const w = makeWatcher();
  w._userOverrides.set('src/a.js', 'exclude');
  assert.equal(w._userOverrides.size, 1);
  w.segmentReset();
  assert.equal(w._userOverrides.size, 0);
});

test('_computeBDefault excludes skill when overridden (I3: H3 ordering guard)', () => {
  const w = makeWatcher();
  w._bRebuild.apply({ type: 'fullSet', lines: [[1, 600]], overhead: 0 }, 'skill:deep-research', 1, 1);
  assert.equal(w._computeBDefault(), 1600); // dead(1000) + skill(600)
  w._userOverrides.set('skill:deep-research', 'exclude');
  assert.equal(w._computeBDefault(), 1000); // only dead — override before skill guard
});
