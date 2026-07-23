import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { discoverServerByClientPid, buildRotationFallbackContext } from '../hooks/session-start.js';

test('discoverServerByClientPid: finds state file by clientPid match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-discover-'));
  writeFileSync(join(dir, 'sess-abc.json'), JSON.stringify({
    port: 12345, pid: 999, clientPid: 42, sessionId: 'sess-abc', transcriptPath: '/x.jsonl',
  }));
  writeFileSync(join(dir, 'sess-other.json'), JSON.stringify({
    port: 12346, pid: 998, clientPid: 99, sessionId: 'sess-other', transcriptPath: '/y.jsonl',
  }));

  const result = discoverServerByClientPid(42, dir);
  assert.deepEqual(result, { url: 'http://127.0.0.1:12345', sessionId: 'sess-abc' });
});

test('discoverServerByClientPid: returns null when no match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-discover-none-'));
  writeFileSync(join(dir, 'sess-z.json'), JSON.stringify({
    port: 12345, pid: 999, clientPid: 77, sessionId: 'sess-z',
  }));

  assert.equal(discoverServerByClientPid(42, dir), null);
});

test('discoverServerByClientPid: returns null for empty directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-discover-empty-'));
  assert.equal(discoverServerByClientPid(42, dir), null);
});

test('buildRotationFallbackContext: formats agent relay hint', () => {
  const ctx = buildRotationFallbackContext('new-sess-123', '/path/to/transcript.jsonl');
  assert.ok(ctx.includes('rotate_session'));
  assert.ok(ctx.includes('new-sess-123'));
  assert.ok(ctx.includes('/path/to/transcript.jsonl'));
});
