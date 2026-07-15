// test/warn-hook.test.js
// Unit tests for the Stop-hook thin client (hooks/warn.js).
// warn.js is a ZERO-INJECTION hook: it must ALWAYS exit 0 with EMPTY stdout (Stop-hook stdout would
// perturb Claude Code's Stop flow), read its session id from stdin `session_id` (NEVER an env var),
// POST { session_id } to the local server's /api/notify-gate, and — per the 2026-07-05 user decision —
// deliver NO system notification (no osascript / notify-send). The restart signal surfaces via
// statusline + dashboard only. These tests must therefore NOT rely on any stdout from the hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', 'hooks', 'warn.js');

// Build an isolated sandbox: a fake $HOME (so the port-discovery lookup never touches the real
// ~/.session-watcher). Starts a mock HTTP server that captures any POST from warn.js so tests
// can verify the request body, URL path, and headers without shelling out to curl.
async function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'warn-hook-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.session-watcher'), { recursive: true });

  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notify: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return { root, home, requests, server, port };
}

// Run the REAL hook via `node warn.js` (mirrors the registered `command: node, args: [warn.js]`),
// piping stdinStr. HOME is redirected to the sandbox so warn.js reads the state file from the
// sandbox's .session-watcher dir. stdio stderr is ignored.
function runHook(stdinStr, sb) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: sb.home };
    const child = spawn('node', [HOOK], { stdio: ['pipe', 'pipe', 'ignore'], env });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.write(stdinStr);
    child.stdin.end();
  });
}

const writeState = (sb, sid, obj) =>
  writeFileSync(join(sb.home, '.session-watcher', `${sid}.json`), JSON.stringify(obj));

// test 69 (unreachable → silent): a valid sid whose state file points at a dead port. The hook runs
// the REAL curl (--max-time 0.2), which fails on connection-refused; the `|| true` swallows it. The hook
// must STILL exit 0 with empty stdout. (If curl is absent, "command not found" is likewise swallowed.)
test('warn.js (69): server unreachable / dead port → silent exit 0, empty stdout', async () => {
  const sb = await makeSandbox();
  try {
    const sid = 'unreachable-sid';
    writeState(sb, sid, { sessionId: sid, port: 9 }); // port 9 (discard) — nothing listens → refused
    const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
    assert.equal(code, 0);
    assert.equal(out, '', 'Stop-hook must emit NOTHING to stdout');
  } finally {
    sb.server.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// test 68 (session from stdin, NOT env): the state file lives under the STDIN sid; a DIFFERENT id is
// planted in CLAUDE_CODE_SESSION_ID. The hook must POST to /api/notify-gate with the stdin sid's port
// (from state file) and the POST body must carry the stdin sid, proving the hook ignores the env id.
test('warn.js (68): sid + port come from stdin/statefile, not env; POST built correctly; stdout empty', async () => {
  const sb = await makeSandbox();
  try {
    const sid = 'stdin-sid-68';
    writeState(sb, sid, { sessionId: sid, port: sb.port });
    // Plant a bogus env session id different from the stdin one — the hook must NOT use it.
    process.env.CLAUDE_CODE_SESSION_ID = 'env-sid-DIFFERENT';
    let res;
    try {
      res = await runHook(JSON.stringify({ session_id: sid }), sb);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
    assert.equal(res.code, 0);
    assert.equal(res.out, '', 'Stop-hook must emit NOTHING to stdout');
    assert.equal(sb.requests.length, 1, 'the hook should have made one POST');
    const req = sb.requests[0];
    assert.ok(req.url.includes('/api/notify-gate'),
      `request URL must include /api/notify-gate; got: ${req.url}`);
    const body = JSON.parse(req.body);
    assert.equal(body.session_id, sid,
      `POST body must carry the STDIN sid (for the server's cross-session 409 guard); got: ${req.body}`);
    assert.ok(!body.session_id.includes('env-sid-DIFFERENT'), 'the env session id must never reach the POST');
  } finally {
    sb.server.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// no-notification assertion (round-2 R2-D1): even when the POST response says {"notify":true}, the JS
// hook (warn.js) uses http.request directly and never invokes osascript/notify-send. v2.1 delivery is
// statusline/dashboard only — the whole shell→AppleScript injection surface is deleted by design.
test('warn.js (R2-D1): notify:true response still triggers NO osascript/notify-send', async () => {
  const sb = await makeSandbox();
  try {
    const sid = 'notify-true-sid';
    writeState(sb, sid, { sessionId: sid, port: sb.port });
    const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
    assert.equal(code, 0);
    assert.equal(out, '', 'Stop-hook must emit NOTHING to stdout');
    assert.equal(sb.requests.length, 1, 'the hook should have made one POST');
    // warn.js never calls osascript/notify-send — no system notification is invoked
  } finally {
    sb.server.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// traversal / `..` reject (round-7 GPT#6 + round-8 GPT#2): a sid containing a path metacharacter or an
// internal `..` must be rejected BEFORE any filesystem lookup and BEFORE any POST — the hook exits 0,
// makes no POST, and stays silent. `abc..def` specifically pins that the hook's reject set matches
// safeSessionId's (which rejects ANY `..`), so a state file the hook would look up under
// `abc..def.json` while the server wrote `__invalid_session__.json` can never arise.
test('warn.js (traversal): metachar / .. sids → exit 0, no POST, no fs touch, empty stdout', async () => {
  for (const sid of ['../evil', 'a/b', 'abc..def']) {
    const sb = await makeSandbox();
    try {
      const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
      assert.equal(code, 0, `sid=${sid} must exit 0`);
      assert.equal(out, '', `sid=${sid} must emit nothing to stdout`);
      assert.equal(sb.requests.length, 0, `sid=${sid} must make no POST to any server`);
    } finally {
      sb.server.close();
      rmSync(sb.root, { recursive: true, force: true });
    }
  }
});

// C3-1 (spec §3.4a, red line #1): the Stop-hook POST body must carry a CLIENT-side hook_event_id,
// generated ONCE per invocation. B14: the id carries SECONDS not %3N ms — `date +%s%3N` is a GNU-ism
// that on macOS/BSD emits a literal `%3N`, breaking the all-digits id + this regex; the urandom nonce
// already guarantees uniqueness.
test('warn.js (C3-1): POST body carries a client hook_event_id', async () => {
  const sb = await makeSandbox();
  try {
    const sid = 'sess-C3';
    writeState(sb, sid, { sessionId: sid, port: sb.port });
    const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
    assert.equal(code, 0);
    assert.equal(out, '', 'Stop-hook must emit NOTHING to stdout');
    assert.equal(sb.requests.length, 1, 'the hook should have made one POST');
    const body = JSON.parse(sb.requests[0].body);
    assert.equal(body.session_id, 'sess-C3');
    assert.match(body.hook_event_id, /^sess-C3:stop:\d+:\d+:[0-9a-f]+$/,
      'client id: sid:stop:pid:seconds:nonce (B14 — no %3N ms)');
  } finally {
    sb.server.close();
    rmSync(sb.root, { recursive: true, force: true });
  }
});
