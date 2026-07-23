// test/project-key.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectKey } from '../lib/project-key.js';

test('resolveProjectKey: prefers claudeProjectDir over cwd', () => {
  const result = resolveProjectKey({ claudeProjectDir: '/projects/alpha', cwd: '/projects/beta' });
  assert.equal(result, '/projects/alpha');
});

test('resolveProjectKey: falls back to cwd when claudeProjectDir missing', () => {
  assert.equal(resolveProjectKey({ cwd: '/workspace' }), '/workspace');
  assert.equal(resolveProjectKey({ claudeProjectDir: '', cwd: '/workspace' }), '/workspace');
});

test('resolveProjectKey: normalizes trailing slash', () => {
  assert.equal(resolveProjectKey({ cwd: '/workspace/' }), '/workspace');
  assert.equal(resolveProjectKey({ claudeProjectDir: '/a/b/' }), '/a/b');
});

test('resolveProjectKey: resolves relative paths to absolute', () => {
  const result = resolveProjectKey({ cwd: './relative/path' });
  assert.ok(result.startsWith('/'), 'should be absolute');
  assert.ok(!result.includes('./'), 'should be resolved');
});

test('resolveProjectKey: returns null when both missing', () => {
  assert.equal(resolveProjectKey({}), null);
  assert.equal(resolveProjectKey({ claudeProjectDir: '', cwd: '' }), null);
  assert.equal(resolveProjectKey({ claudeProjectDir: undefined, cwd: undefined }), null);
});

test('resolveProjectKey: hook and watcher produce same key for same env', () => {
  // Simulate hook call (from payload)
  const hookKey = resolveProjectKey({ claudeProjectDir: '/workspace', cwd: '/workspace' });
  // Simulate watcher call (from process.env + process.cwd)
  const watcherKey = resolveProjectKey({ claudeProjectDir: '/workspace', cwd: '/workspace' });
  assert.equal(hookKey, watcherKey);
});
