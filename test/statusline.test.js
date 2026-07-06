// test/statusline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

const SCRIPT = 'statusline.sh';
const MOCK_STDIN = JSON.stringify({
  model: { display_name: 'Opus', id: 'claude-opus-4-8' },
  session_id: 'test-sid', transcript_path: '/tmp/x.jsonl',
  context_window: { current_usage: { cache_read_input_tokens: 137000 } },
});

// Not skipped: the script must exist. First run (before writing it) fails loudly, satisfying TDD.
test('statusline exits 0 and prints a fallback line when server is down', () => {
  assert.ok(existsSync(SCRIPT), 'statusline.sh must exist');
  chmodSync(SCRIPT, 0o755);
  // Point state dir at an empty tmp so no server is found → fallback path.
  const out = execFileSync('bash', [SCRIPT], {
    input: MOCK_STDIN, env: { ...process.env, SW_STATE_DIR: '/nonexistent-sw-dir' }, encoding: 'utf8' });
  assert.ok(out.trim().length > 0, 'non-empty output (never blocks CC)');
  assert.ok(/Opus|session-watcher/.test(out), 'shows model or off-marker');
  assert.ok(!/http:\/\//.test(out), 'no dashboard URL when server is down');
});

// When a server IS reachable, the statusline appends a full, clickable dashboard URL so the
// human can reopen the dashboard after closing the tab. Must be a complete http:// string
// (a bare :PORT is not clickable/complete in a terminal).
test('statusline appends full dashboard URL when server is up', async () => {
  chmodSync(SCRIPT, 0o755);
  const srv = createServer((req, res) => {
    if (req.url.startsWith('/api/status')) { res.setHeader('content-type', 'text/plain'); res.end('METRICS_LINE'); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const stateDir = mkdtempSync(join(tmpdir(), 'sw-state-'));
  try {
    writeFileSync(join(stateDir, 'test-sid.json'), JSON.stringify({ port }));
    // Async execFile (not execFileSync): the mock server shares this event loop, so a blocking
    // spawn would starve it and force curl into the fallback path.
    const child = execFileP('bash', [SCRIPT], { env: { ...process.env, SW_STATE_DIR: stateDir } });
    child.child.stdin.end(MOCK_STDIN);
    const { stdout: out } = await child;
    assert.ok(out.includes('METRICS_LINE'), 'renders the server metrics line');
    assert.ok(out.includes(`http://127.0.0.1:${port}`), 'appends the full dashboard URL');
  } finally {
    srv.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
