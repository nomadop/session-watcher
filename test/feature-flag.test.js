import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('index.js has in-process watcher (no legacy branch)', () => {
  const src = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('rotate_session'), 'rotate_session tool registered');
  assert.ok(src.includes('inprocFetch'), 'in-process fetch helper exists');
  assert.ok(!src.includes("SW_INPROCESS"), 'no feature flag check — legacy removed');
});

test('hooks/session-start.js uses clientPid discovery (no legacy branch)', () => {
  const src = readFileSync(join(__dirname, '..', 'hooks', 'session-start.js'), 'utf8');
  assert.ok(src.includes('discoverServerByClientPid'), 'discovery function used');
  assert.ok(!src.includes("SW_INPROCESS"), 'no feature flag check — legacy removed');
});

test('server.js has doRotation and /api/rotate route', () => {
  const src = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(src.includes('doRotation'), 'doRotation exists');
  assert.ok(src.includes("'/api/rotate'"), 'rotate route exists');
  assert.ok(src.includes('archiveCurrentSegment'), 'uses public archive API');
});

test('fold.js exports archiveCurrentSegment (not handleSegmentBoundary)', () => {
  const src = readFileSync(join(__dirname, '..', 'lib', 'fold.js'), 'utf8');
  assert.ok(src.includes('export function archiveCurrentSegment'), 'archiveCurrentSegment exported');
  assert.ok(!src.includes('export function handleSegmentBoundary'), 'handleSegmentBoundary is not a first-class export (server.js uses archiveCurrentSegment)');
});
