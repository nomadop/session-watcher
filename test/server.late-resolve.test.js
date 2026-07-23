import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate ledger/gate state writes to a temp CLAUDE_PLUGIN_DATA.
const TMP = mkdtempSync(join(tmpdir(), 'sw-lateresolve-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { createServer, resolveBySessionId } from '../server.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';

// Minimal watcher stub that starts with path=null (simulates cold-start race)
function nullPathWatcher() {
  return {
    path: null,
    _sessionId: null,
    poll() { return { changed: false }; },
    switchTranscript(newPath) { this.path = newPath; },
    getStatus() { return { segment: 0, model: 'claude-opus-4-8', L: 0,
      rateLamp: { reliable: false, unavailableReason: 'no_transcript' } }; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    _currentSegmentCalls() { return []; },
    _uptimeSec() { return 0; },
    getTerminalSnapshot() { return {}; },
  };
}

test('late transcript resolution: watcher.path goes from null to resolved within poll ticks', async () => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects-'));

  // Start server with a null-path watcher (transcript not yet created)
  const watcher = nullPathWatcher();
  const srv = createServer({ watcher, pollIntervalMs: 10, sessionId, projectsRoot });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));

  try {
    // Verify watcher starts with no path
    assert.equal(watcher.path, null);
    srv.startPolling();

    // Wait a few ticks — still null because the file doesn't exist yet
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(watcher.path, null, 'path stays null when transcript file does not exist');

    // Now create the transcript file (simulating CC writing it after MCP loaded)
    const subdir = join(projectsRoot, 'encoded-cwd');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, `${sessionId}.jsonl`), '');

    // Wait for the poll loop to discover it
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(watcher.path, join(subdir, `${sessionId}.jsonl`),
      'poll loop resolves the transcript path once the file appears');
  } finally {
    srv.stopTimers();
    await new Promise((r) => srv.server.close(r));
  }
});

test('late resolution does not fire when watcher already has a path', async () => {
  _resetRateLampManagerForTest();
  const sessionId = randomUUID();
  const projectsRoot = mkdtempSync(join(TMP, 'projects2-'));

  // Create transcript file up-front
  const subdir = join(projectsRoot, 'cwd');
  mkdirSync(subdir, { recursive: true });
  const transcriptPath = join(subdir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, '');

  // Watcher already has a path — late resolution should not trigger switchTranscript
  const watcher = nullPathWatcher();
  watcher.path = '/some/existing/path.jsonl';
  let switchCalled = false;
  watcher.switchTranscript = () => { switchCalled = true; };

  const srv = createServer({ watcher, pollIntervalMs: 10, sessionId, projectsRoot });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));

  try {
    srv.startPolling();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(switchCalled, false, 'switchTranscript not called when path already set');
  } finally {
    srv.stopTimers();
    await new Promise((r) => srv.server.close(r));
  }
});
