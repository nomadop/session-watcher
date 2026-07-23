import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, closeStoreGlobal, getStore } from '../lib/store.js';

const TMP = mkdtempSync(join(tmpdir(), 'sw-shf-'));
initStore(join(TMP, 't.sqlite'));
process.on('exit', () => { try { closeStoreGlobal(); } catch {} try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';

function fixtureWatcher() {
  let s = ''; let cr = 42000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 940;
    s += JSON.stringify({ type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + id++, model: 'deepseek-v4-pro', usage: { input_tokens: 560, output_tokens: 380,
        cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n'; }
  const p = join(mkdtempSync(join(tmpdir(), 'sw-')), 's.jsonl');
  writeFileSync(p, s);
  return new SessionWatcher(p, 42000, { sessionId: 'sid-srv', projectId: 'proj-srv' });
}

async function withServer(fn) {
  const w = fixtureWatcher(); w.poll();
  const { server, stopTimers } = createServer({ watcher: w, pollIntervalMs: 0, sessionId: 'sid-srv' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(port, w); } finally { stopTimers(); await new Promise(r => server.close(r)); }
}

test('GET /api/buckets is enriched with metrics + session_id + snake_case last_active_turn', async () => {
  await withServer(async (port) => {
    const data = await (await fetch(`http://127.0.0.1:${port}/api/buckets`)).json();
    assert.equal(data.session_id, 'sid-srv');
    assert.equal(typeof data.current_turn, 'number');
    assert.equal(typeof data.generated_at, 'number');
    assert.ok(data.metrics && typeof data.metrics.br !== 'undefined');
    assert.ok('b_total' in data.metrics && 'c_ratio' in data.metrics && 'pp' in data.metrics);
    if (data.paths.length) assert.ok('last_active_turn' in data.paths[0]);
  });
});

test('POST /api/handoff/prepare → ready + load_token; GET load by token round-trips', async () => {
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/app.js', symbols: ['handleAuth'] }], summary: 'Refactor auth middleware', next_task: 'fix token refresh' }),
    })).json();
    assert.equal(prep.status, 'ready');
    assert.ok(prep.load_token && prep.load_token.split('-').length === 3);
    assert.equal(typeof prep.summary_tokens, 'number');
    // Same-session no-param load → found:false (auto-match excludes own session)
    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load`)).json();
    assert.equal(load.found, false, 'auto-match excludes own session');
    // Token load still works
    const byTok = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    assert.equal(byTok.found, true);
    assert.equal(byTok.load_token, prep.load_token);
    assert.equal(byTok.next_task, 'fix token refresh');
    assert.equal(byTok.paths_to_keep[0].path, 'src/app.js');
    assert.deepEqual(byTok.paths_to_keep[0].symbols, ['handleAuth']);
    assert.strictEqual(byTok.previous_segment, undefined, 'previous_segment should not be exposed in load response');
    assert.equal(byTok.project_dir, 'proj-srv', 'load response includes project_dir from DB record');
  });
});

test('POST prepare rejects oversized summary + too many paths + secret redaction', async () => {
  await withServer(async (port) => {
    const tooLong = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [], summary: 'x'.repeat(10001) }),
    })).json();
    assert.equal(tooLong.error, 'summary_too_long');
    const secret = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/app.js' }], summary: 'key sk-ABCDEF0123456789ABCDEF', next_task: 'ghp_ABCDEF0123456789ABCDEFGHIJ' }),
    })).json();
    assert.equal(secret.status, 'ready');
    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${secret.load_token}`)).json();
    assert.ok(!load.summary.includes('sk-ABCDEF'), 'secret redacted in stored summary');
  });
});

test('prepare auto-injects line ranges from _bRebuild when path has line data', async () => {
  await withServer(async (port, watcher) => {
    // Manually inject line data into _bRebuild for a known path
    const testPath = 'src/injected.js';
    const entry = watcher._bRebuild._ensure(testPath);
    watcher._bRebuild._setLine(entry, 10, 50);
    watcher._bRebuild._setLine(entry, 11, 40);
    watcher._bRebuild._setLine(entry, 12, 60);
    watcher._bRebuild._setLine(entry, 20, 30);
    watcher._bRebuild._setLine(entry, 21, 25);

    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: testPath, symbols: ['myFunc'] }], summary: 'Lines injection test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    const entry0 = load.paths_to_keep[0];
    assert.equal(entry0.path, testPath);
    assert.deepEqual(entry0.symbols, ['myFunc']);
    assert.deepEqual(entry0.lines, [[10, 12], [20, 21]], 'lines collapsed into ranges');
  });
});

test('prepare skips lines injection when path has fullSnapshot (full file read)', async () => {
  await withServer(async (port, watcher) => {
    const testPath = 'src/full.js';
    const entry = watcher._bRebuild._ensure(testPath);
    watcher._bRebuild._setLine(entry, 1, 100);
    watcher._bRebuild._setLine(entry, 2, 80);
    watcher._bRebuild._setLine(entry, 3, 90);
    watcher._bRebuild._hasFullSnapshot.set(testPath, true);

    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: testPath }], summary: 'Full snapshot test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    const entry0 = load.paths_to_keep[0];
    assert.equal(entry0.path, testPath);
    assert.strictEqual(entry0.lines, undefined, 'no lines when fullSnapshot — signals full file read');
  });
});

test('skills_to_keep round-trips through prepare → load', async () => {
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/a.js' }], skills_to_keep: ['systematic-debugging', 'TDD'], summary: 'Skills test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    assert.deepEqual(load.skills_to_keep, ['systematic-debugging', 'TDD']);
  });
});

test('skills_to_keep omitted from load when not provided in prepare', async () => {
  await withServer(async (port) => {
    const prep = await (await fetch(`http://127.0.0.1:${port}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths_to_keep: [{ path: 'src/b.js' }], summary: 'No skills test' }),
    })).json();
    assert.equal(prep.status, 'ready');

    const load = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load?load_token=${prep.load_token}`)).json();
    assert.strictEqual(load.skills_to_keep, undefined, 'no skills_to_keep when none provided');
  });
});

// ── Auto-match (no-params) endpoint tests ───────────────────────────────────

test('GET /api/handoff/load (no params): single pending from other session → auto-match + stamp', async () => {
  await withServer(async (port) => {
    // Insert a handoff from a DIFFERENT session for the same project
    const store = getStore();
    store.insertHandoff({
      sessionId: 'other-session-1',
      segment: 0,
      loadToken: 'auto-aaa-bbb',
      createdAt: Date.now(),
      pathsToKeep: JSON.stringify([{ path: 'src/x.js' }]),
      summary: 'Auto-match single test',
      nextTask: 'do the thing',
      summaryTokens: 10,
      projectId: 'proj-srv',
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/handoff/load`);
    const data = await resp.json();
    assert.equal(data.found, true, 'single pending handoff from other session is auto-matched');
    assert.equal(data.next_task, 'do the thing');
    assert.equal(data.load_token, 'auto-aaa-bbb');
    // Verify it was stamped (delivered_at set)
    const recheck = await (await fetch(`http://127.0.0.1:${port}/api/handoff/load`)).json();
    assert.equal(recheck.found, false, 'after delivery stamp, no more pending');
  });
});

test('GET /api/handoff/load (no params): multiple pending → ambiguous response with candidates', async () => {
  await withServer(async (port) => {
    const store = getStore();
    // Insert TWO handoffs from different sessions for same project
    store.insertHandoff({
      sessionId: 'other-session-2',
      segment: 0,
      loadToken: 'amb-aaa-111',
      createdAt: Date.now() - 1000,
      pathsToKeep: JSON.stringify([{ path: 'src/a.js' }]),
      summary: 'First ambiguous',
      nextTask: 'task alpha',
      summaryTokens: 5,
      projectId: 'proj-srv',
    });
    store.insertHandoff({
      sessionId: 'other-session-3',
      segment: 0,
      loadToken: 'amb-bbb-222',
      createdAt: Date.now(),
      pathsToKeep: JSON.stringify([{ path: 'src/b.js' }]),
      summary: 'Second ambiguous',
      nextTask: 'task beta',
      summaryTokens: 5,
      projectId: 'proj-srv',
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/handoff/load`);
    const data = await resp.json();
    assert.equal(data.found, false, 'ambiguous case returns found:false');
    assert.equal(data.ambiguous, true);
    assert.ok(Array.isArray(data.candidates));
    assert.ok(data.candidates.length >= 2, 'at least 2 candidates');
    // Candidates should have load_token and next_task_preview
    const tokens = data.candidates.map(c => c.load_token);
    assert.ok(tokens.includes('amb-aaa-111') || tokens.includes('amb-bbb-222'));
    assert.ok(data.candidates[0].next_task_preview);
  });
});

test('GET /api/handoff/load (no params): null projectId → found:false', async () => {
  // Create a watcher with null projectId
  const p = join(mkdtempSync(join(tmpdir(), 'sw-np-')), 's.jsonl');
  let s = ''; let cr = 42000; let id = 0;
  for (let i = 0; i < 30; i++) { cr += 940;
    s += JSON.stringify({ type: 'assistant', uuid: 'u' + id, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'm' + id++, model: 'deepseek-v4-pro', usage: { input_tokens: 560, output_tokens: 380,
        cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } }) + '\n'; }
  writeFileSync(p, s);
  const w = new SessionWatcher(p, 42000, { sessionId: 'sid-noproj', projectId: null });
  w.poll();

  const { createServer } = await import('../server.js');
  const { server, stopTimers } = createServer({ watcher: w, pollIntervalMs: 0, sessionId: 'sid-noproj' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/handoff/load`);
    const data = await resp.json();
    assert.equal(data.found, false, 'null projectId means no auto-match possible');
  } finally { stopTimers(); await new Promise(r => server.close(r)); }
});

test('GET /api/handoff/load (no params): expired handoff (beyond TTL) → found:false', async () => {
  // Use an isolated projectId so prior tests' state cannot produce a false-positive pass
  const p = join(TMP, `ttl-${Date.now()}.jsonl`);
  writeFileSync(p, '');
  const w = new SessionWatcher(p, 42000, { sessionId: 'sid-ttl', projectId: 'proj-ttl-isolated' });
  w.poll();
  const { server, stopTimers } = createServer({ watcher: w, pollIntervalMs: 0, sessionId: 'sid-ttl' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const store = getStore();
    // Insert a handoff older than HANDOFF_HOOK_TTL_DAYS (7 days)
    store.insertHandoff({
      sessionId: 'other-session-expired',
      segment: 0,
      loadToken: 'exp-aaa-zzz',
      createdAt: Date.now() - (8 * 24 * 3600 * 1000), // 8 days ago
      pathsToKeep: JSON.stringify([{ path: 'src/old.js' }]),
      summary: 'Expired handoff',
      nextTask: 'stale task',
      summaryTokens: 5,
      projectId: 'proj-ttl-isolated',
    });

    const resp = await fetch(`http://127.0.0.1:${port}/api/handoff/load`);
    const data = await resp.json();
    assert.equal(data.found, false, 'expired handoff must not be auto-matched');
  } finally { stopTimers(); await new Promise(r => server.close(r)); }
});

