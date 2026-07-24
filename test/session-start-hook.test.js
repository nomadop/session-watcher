// test/session-start-hook.test.js
// Unit tests for the SessionStart hook wrapper (hooks/session-start.js).
// The pure decision function (launchOptionsFor) is tested directly; the CLI entry's
// best-effort "never block session start" guarantee is tested by spawning the hook
// with malformed stdin and asserting a clean exit 0 with NO server spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchOptionsFor, readStdin, isMainModule, buildServerContext, discoverHandoffs, formatHandoffContext, discoverServerByClientPid, buildRotationFallbackContext } from '../hooks/session-start.js';
import { openStore, closeStore } from '../lib/store.js';
import { HANDOFF_HOOK_SOURCES } from '../lib/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', 'hooks', 'session-start.js');

test('launchOptionsFor: open ONLY on source=startup', () => {
  assert.equal(launchOptionsFor({ source: 'startup' }).open, true);
  for (const source of ['resume', 'clear', 'compact', undefined, 'anything']) {
    assert.equal(launchOptionsFor({ source }).open, false, `source=${source} must not open`);
  }
});

test('launchOptionsFor: transcript_path passes through as transcript (1:1 bind)', () => {
  const o = launchOptionsFor({ transcript_path: '/x/y/abc.jsonl' });
  assert.equal(o.transcript, '/x/y/abc.jsonl');
});

test('launchOptionsFor: missing transcript_path → transcript undefined (falls back to --session)', () => {
  assert.equal(launchOptionsFor({}).transcript, undefined);
  assert.equal(launchOptionsFor({ transcript_path: '' }).transcript, undefined);
});

test('launchOptionsFor: session_id is injected into env.CLAUDE_CODE_SESSION_ID', () => {
  const o = launchOptionsFor({ session_id: 'sess-123' }, { HOME: '/home/u' });
  assert.equal(o.env.CLAUDE_CODE_SESSION_ID, 'sess-123');
  assert.equal(o.env.HOME, '/home/u'); // base env preserved
});

test('launchOptionsFor: missing session_id → no CLAUDE_CODE_SESSION_ID injected', () => {
  const o = launchOptionsFor({}, { HOME: '/home/u' });
  assert.ok(!('CLAUDE_CODE_SESSION_ID' in o.env));
});

test('readStdin reads a stream to completion', async () => {
  const s = Readable.from(['{"a":', '1}']);
  assert.equal(await readStdin(s), '{"a":1}');
});

test('isMainModule: matches under a path WITH SPACES (percent-encoding regression)', () => {
  // The bug: `import.meta.url === file://${argv1}` fails when argv1 has spaces, because
  // import.meta.url percent-encodes them (space → %20). Under /Users/First Last/… the guard
  // never fires and the hook silently no-ops. isMainModule compares via pathToFileURL on both sides.
  const spaced = '/Users/First Last/session-watcher/hooks/session-start.js';
  const metaUrl = pathToFileURL(spaced).href; // what import.meta.url would be for this file
  assert.ok(metaUrl.includes('%20'), 'sanity: the file URL is percent-encoded');
  assert.equal(isMainModule(metaUrl, spaced), true, 'guard must fire under a spaced install path');
  // The old raw-concatenation form would have compared against an UN-encoded string and failed:
  assert.notEqual(metaUrl, `file://${spaced}`, 'the old `file://${argv1}` form would not have matched');
  // And a genuinely different entry point must still be rejected.
  assert.equal(isMainModule(metaUrl, '/some/other/file.js'), false);
});

test('readStdin resolves on a hard timeout when the stream never ends (never hangs)', async () => {
  // A stream that emits then stays open forever — without the timeout floor this would hang.
  const stuck = new Readable({ read() {} });
  stuck.push('{"partial"');
  const got = await readStdin(stuck, 50); // resolves via the 50ms floor, not 'end'
  assert.equal(got, '{"partial"');
});

// Spawn the REAL hook and capture its own stdout — SessionStart stdout becomes model context, so the
// hook must emit NOTHING to stdout regardless of input. `env: SW_NO_OPEN` belt-and-suspenders so no
// browser pops even if a valid payload ever reaches startWatcher in this suite.
function runHook(stdinStr) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, SW_NO_OPEN: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.write(stdinStr);
    child.stdin.end();
  });
}

test('CLI entry: malformed stdin never blocks — exits 0, emits nothing to stdout', async () => {
  const { code, out } = await runHook('this is not json');
  assert.equal(code, 0);
  assert.equal(out, '', 'hook must not write to its own stdout (SessionStart stdout leaks into model context)');
});

test('CLI entry: valid payload, no matching server → exits 0, emits nothing (no server to discover)', async () => {
  // In-process hook discovers by clientPid. No server running for this test's ppid → nothing injected.
  const payload = JSON.stringify({
    session_id: `hooktest-${process.pid}-${Math.floor(process.hrtime()[1])}`,
    source: 'resume',
    transcript_path: '/nonexistent/path.jsonl',
  });
  const { code, out } = await runHook(payload);
  assert.equal(code, 0);
  assert.equal(out, '', 'no server to discover → no additionalContext emitted');
});

// ── discoverHandoffs unit tests ──────────────────────────────────────────────

test('discoverHandoffs: returns pending handoff from DB', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const dbPath = join(dir, 'store.sqlite');
  const store = openStore(dbPath);
  store.insertHandoff({ sessionId: 'prev-session', segment: 0, loadToken: 'test-fox',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'test work',
    nextTask: 'do the thing', summaryTokens: 100, keptTokens: 5000, projectId: '/workspace' });
  closeStore(store);

  const rows = discoverHandoffs(dbPath, '/workspace', 'new-session', { ttlDays: 7, queryLimit: 4 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].load_token, 'test-fox');
  assert.equal(rows[0].next_task, 'do the thing');
});

test('discoverHandoffs: excludes own session_id', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const dbPath = join(dir, 'store.sqlite');
  const store = openStore(dbPath);
  store.insertHandoff({ sessionId: 'my-session', segment: 0, loadToken: 'self-owl',
    createdAt: Date.now() - 60000, pathsToKeep: '[]', summary: 'self',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  closeStore(store);

  const rows = discoverHandoffs(dbPath, '/workspace', 'my-session', { ttlDays: 7, queryLimit: 4 });
  assert.equal(rows.length, 0);
});

test('discoverHandoffs: returns empty when DB does not exist', () => {
  const rows = discoverHandoffs('/nonexistent/path/store.sqlite', '/workspace', 'sess', { ttlDays: 7, queryLimit: 4 });
  assert.deepEqual(rows, []);
});

test('discoverHandoffs: returns empty when projectId is null', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const dbPath = join(dir, 'store.sqlite');
  const store = openStore(dbPath);
  store.insertHandoff({ sessionId: 'old', segment: 0, loadToken: 'null-key',
    createdAt: Date.now(), pathsToKeep: '[]', summary: 'x',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  closeStore(store);

  const rows = discoverHandoffs(dbPath, null, 'new', { ttlDays: 7, queryLimit: 4 });
  assert.deepEqual(rows, []);
});

test('discoverHandoffs: respects TTL (expired handoff not returned)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const dbPath = join(dir, 'store.sqlite');
  const store = openStore(dbPath);
  store.insertHandoff({ sessionId: 'old', segment: 0, loadToken: 'expired-elm',
    createdAt: Date.now() - 8 * 86400000, pathsToKeep: '[]', summary: 'old',
    nextTask: null, summaryTokens: 50, projectId: '/workspace' });
  closeStore(store);

  const rows = discoverHandoffs(dbPath, '/workspace', 'new', { ttlDays: 7, queryLimit: 4 });
  assert.equal(rows.length, 0);
});

test('discoverHandoffs: respects LIMIT', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hook-test-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const dbPath = join(dir, 'store.sqlite');
  const store = openStore(dbPath);
  for (let i = 0; i < 6; i++) {
    store.insertHandoff({ sessionId: `old-${i}`, segment: 0, loadToken: `lim-${i}`,
      createdAt: Date.now() - i * 60000, pathsToKeep: '[]', summary: `work ${i}`,
      nextTask: `task ${i}`, summaryTokens: 50, projectId: '/workspace' });
  }
  closeStore(store);

  const rows = discoverHandoffs(dbPath, '/workspace', 'new', { ttlDays: 7, queryLimit: 4 });
  assert.equal(rows.length, 4);
});

// ── formatHandoffContext unit tests ──────────────────────────────────────────────

test('formatHandoffContext: single handoff format', () => {
  const rows = [{ load_token: 'review-clear-egret', next_task: 'Fix the review findings.',
    created_at: Date.now() - 15 * 60000, summary_tokens: 1000, kept_tokens: 65000 }];
  const ctx = formatHandoffContext(rows, 3, 200);
  assert.ok(ctx.includes('[Session Watcher] Handoff available'));
  assert.ok(ctx.includes('review-clear-egret'));
  assert.ok(ctx.includes('~66k tokens'));
  assert.ok(ctx.includes('15 min ago'));
  assert.ok(ctx.includes('Fix the review findings.'));
});

test('formatHandoffContext: multiple handoffs listed', () => {
  const now = Date.now();
  const rows = [
    { load_token: 'a-fox', next_task: 'Task A long description here', created_at: now - 5 * 60000, summary_tokens: 500, kept_tokens: 1000 },
    { load_token: 'b-owl', next_task: 'Task B', created_at: now - 3600000, summary_tokens: 200, kept_tokens: 800 },
    { load_token: 'c-elm', next_task: 'Task C', created_at: now - 36000000, summary_tokens: 100, kept_tokens: 400 },
  ];
  const ctx = formatHandoffContext(rows, 3, 200);
  assert.ok(ctx.includes('[Session Watcher] 3 pending handoffs'));
  assert.ok(ctx.includes('1. a-fox'));
  assert.ok(ctx.includes('2. b-owl'));
  assert.ok(ctx.includes('3. c-elm'));
});

test('formatHandoffContext: 4 rows triggers "more available" message', () => {
  const now = Date.now();
  const rows = Array.from({ length: 4 }, (_, i) => ({
    load_token: `tok-${i}`, next_task: `task ${i}`, created_at: now - i * 60000,
    summary_tokens: 50, kept_tokens: 100 }));
  const ctx = formatHandoffContext(rows, 3, 200);
  assert.ok(ctx.includes('3+ pending handoffs'));
  assert.ok(ctx.includes('older handoffs available'));
  // Only 3 displayed even though 4 rows passed
  assert.ok(!ctx.includes('tok-3'));
});

test('formatHandoffContext: truncates next_task at preview limit', () => {
  const longTask = 'x'.repeat(300);
  const rows = [{ load_token: 'trunc-fox', next_task: longTask,
    created_at: Date.now() - 60000, summary_tokens: 50, kept_tokens: 100 }];
  const ctx = formatHandoffContext(rows, 3, 200);
  assert.ok(!ctx.includes('x'.repeat(201)), 'should be truncated');
  assert.ok(ctx.includes('x'.repeat(197) + '...'), 'should end with ellipsis');
});

test('formatHandoffContext: returns null for empty rows', () => {
  assert.equal(formatHandoffContext([], 3, 200), null);
});

test('formatHandoffContext: handles null summary_tokens or kept_tokens', () => {
  const rows = [{ load_token: 'null-tok', next_task: 'do it',
    created_at: Date.now() - 60000, summary_tokens: null, kept_tokens: 5000 }];
  const ctx = formatHandoffContext(rows, 3, 200);
  assert.ok(ctx.includes('~5k tokens'));
});

// ── source-gate test ──────────────────────────────────────────────────────────

test('hook source gate: only startup and clear trigger discovery', () => {
  assert.deepEqual(HANDOFF_HOOK_SOURCES, ['startup', 'clear']);
});

// ── buildServerContext unit tests ──────────────────────────────────────────────

test('buildServerContext: returns URL line', () => {
  const ctx = buildServerContext('http://127.0.0.1:4321');
  assert.equal(ctx, '[Session Watcher] Server: http://127.0.0.1:4321');
});

test('buildServerContext: null when no URL', () => {
  assert.equal(buildServerContext(null), null);
  assert.equal(buildServerContext(undefined), null);
  assert.equal(buildServerContext(''), null);
});
