import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { stateFileFor } from '../lib/launcher.js';

const PORT_DIR = dirname(stateFileFor('probe'));

test('RV-C13: stateFileFor sanitizes path-traversal characters', () => {
  const p = stateFileFor('../../../etc/passwd');
  assert.ok(!p.includes('..'), 'path traversal characters must be sanitized');
  assert.ok(p.startsWith(PORT_DIR), 'result must stay inside the state directory');
  assert.ok(p.endsWith('.json'));
});

test('RV-C13: stateFileFor handles normal UUID unchanged', () => {
  const p = stateFileFor('abc123-def456');
  assert.ok(p.includes('abc123-def456'));
});
