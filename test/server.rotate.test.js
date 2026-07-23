import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';

function tmpJsonl(dir, name, lines) {
  const p = join(dir, name);
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function usageLine(cacheRead, opts = {}) {
  return {
    type: 'assistant', message: { id: opts.id || `msg-${Math.random().toString(36).slice(2)}` },
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
    model: 'claude-sonnet-4-20250514',
  };
}

test('POST /api/rotate: rotates session, updates watcher._sessionId, rewrites state file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-rotate-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects', 'encoded-cwd');
  mkdirSync(projRoot, { recursive: true });
  const path1 = tmpJsonl(projRoot, 'sess-old.jsonl', [usageLine(1000)]);
  const path2 = tmpJsonl(projRoot, 'sess-new.jsonl', [usageLine(2000)]);

  const watcher = new SessionWatcher(path1, null, { sessionId: 'sess-old' });
  const { server, stopTimers } = createServer({
    watcher, pollIntervalMs: 0, sessionId: 'sess-old', onIdleShutdown: null,
    projectsRoot: join(dir, 'projects'), stateDir,
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // Write initial state file so doRotation can delete it
  writeFileSync(join(stateDir, 'sess-old.json'), JSON.stringify({ port, pid: process.pid, sessionId: 'sess-old' }));

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-new', transcript_path: path2 }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.old_session_id, 'sess-old');
    assert.equal(body.new_session_id, 'sess-new');
    assert.equal(watcher.path, path2);
    assert.equal(watcher._sessionId, 'sess-new');
    // State file rewritten
    assert.ok(existsSync(join(stateDir, 'sess-new.json')), 'new state file exists');
    assert.ok(!existsSync(join(stateDir, 'sess-old.json')), 'old state file deleted');
  } finally {
    stopTimers();
    await new Promise(r => server.close(r));
  }
});

test('POST /api/rotate: noop when same session_id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-rotate-noop-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects', 'encoded-cwd');
  mkdirSync(projRoot, { recursive: true });
  const path1 = tmpJsonl(projRoot, 'sess-same.jsonl', [usageLine(1000)]);

  const watcher = new SessionWatcher(path1, null, { sessionId: 'sess-same' });
  const { server, stopTimers } = createServer({
    watcher, pollIntervalMs: 0, sessionId: 'sess-same', onIdleShutdown: null,
    projectsRoot: join(dir, 'projects'), stateDir,
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-same' }),
    });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.noop, true);
  } finally {
    stopTimers();
    await new Promise(r => server.close(r));
  }
});

test('POST /api/rotate: returns error when transcript not found (watcher unchanged)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-rotate-miss-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projRoot = join(dir, 'projects');
  mkdirSync(projRoot, { recursive: true });
  const path1 = tmpJsonl(projRoot, 'sess-x.jsonl', [usageLine(1000)]);

  const watcher = new SessionWatcher(path1, null, { sessionId: 'sess-x' });
  const { server, stopTimers } = createServer({
    watcher, pollIntervalMs: 0, sessionId: 'sess-x', onIdleShutdown: null,
    projectsRoot: projRoot, stateDir,
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'nonexistent-sess-zzz' }),
    });
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'transcript_not_found');
    // Watcher unchanged — no side effects on failure
    assert.equal(watcher.path, path1);
    assert.equal(watcher._sessionId, 'sess-x');
  } finally {
    stopTimers();
    await new Promise(r => server.close(r));
  }
});
