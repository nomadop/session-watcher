import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';
import { discoverServerByClientPid } from '../hooks/session-start.js';

function usageLine(cacheRead) {
  return {
    type: 'assistant', message: { id: `msg-${Math.random().toString(36).slice(2)}` },
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
    model: 'claude-sonnet-4-20250514',
  };
}

test('integration: full rotation lifecycle (discover → POST /api/rotate → verify)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-integ-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects', 'enc');
  mkdirSync(projRoot, { recursive: true });

  const oldSessionId = 'sess-old-integ';
  const newSessionId = 'sess-new-integ';
  const oldPath = join(projRoot, `${oldSessionId}.jsonl`);
  const newPath = join(projRoot, `${newSessionId}.jsonl`);
  writeFileSync(oldPath, JSON.stringify(usageLine(1000)) + '\n');
  writeFileSync(newPath, JSON.stringify(usageLine(2000)) + '\n');

  const watcher = new SessionWatcher(oldPath, null, { sessionId: oldSessionId });
  const { server, stopTimers, doRotation, currentSessionId, sseClients } = createServer({
    watcher, pollIntervalMs: 0, sessionId: oldSessionId, onIdleShutdown: null,
    projectsRoot: join(dir, 'projects'), stateDir,
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Write state file with clientPid (simulating what MCP startup does)
  const clientPid = process.pid;
  writeFileSync(join(stateDir, `${oldSessionId}.json`), JSON.stringify({
    port, pid: process.pid, clientPid, sessionId: oldSessionId, transcriptPath: oldPath,
  }));

  try {
    // 1. Hook discovers server via clientPid
    const discovery = discoverServerByClientPid(clientPid, stateDir);
    assert.ok(discovery, 'should discover server');
    assert.equal(discovery.sessionId, oldSessionId);

    // 2. Session ID mismatch detected
    assert.notEqual(discovery.sessionId, newSessionId);

    // 3. Hook POSTs /api/rotate
    const resp = await fetch(`${discovery.url}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: newSessionId, transcript_path: newPath }),
    });
    const result = await resp.json();
    assert.equal(result.ok, true);
    assert.equal(result.old_session_id, oldSessionId);
    assert.equal(result.new_session_id, newSessionId);

    // 4. Verify watcher switched
    assert.equal(watcher.path, newPath);
    assert.equal(watcher._sessionId, newSessionId);
    assert.equal(currentSessionId(), newSessionId);

    // 5. State file: new exists, old deleted
    assert.ok(existsSync(join(stateDir, `${newSessionId}.json`)));
    assert.ok(!existsSync(join(stateDir, `${oldSessionId}.json`)));

    // 6. Health still responds
    const healthResp = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal((await healthResp.json()).ok, true);
  } finally {
    stopTimers();
    for (const c of sseClients) { try { c.end(); } catch {} }
    await new Promise(r => server.close(r));
  }
});

test('integration: rotation is idempotent (same session_id = noop)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-integ-noop-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects', 'enc');
  mkdirSync(projRoot, { recursive: true });
  const sessionId = 'sess-idem';
  const path = join(projRoot, `${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify(usageLine(1000)) + '\n');

  const watcher = new SessionWatcher(path, null, { sessionId });
  const { server, stopTimers } = createServer({
    watcher, pollIntervalMs: 0, sessionId, onIdleShutdown: null,
    projectsRoot: join(dir, 'projects'), stateDir,
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    const result = await resp.json();
    assert.equal(result.ok, true);
    assert.equal(result.noop, true);
    assert.equal(watcher.path, path);
  } finally {
    stopTimers();
    await new Promise(r => server.close(r));
  }
});
