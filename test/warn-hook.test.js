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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, '..', 'hooks', 'warn.js');

// Build an isolated sandbox: a fake $HOME (so the port-discovery lookup never touches the real
// ~/.session-watcher), plus a bin/ dir that can shadow `curl`/`osascript` on PATH. Each fake tool
// APPENDS its argv to a capture file so a test can assert whether — and how — it was invoked. We never
// pre-create the capture files, so "file absent" is a clean proof the tool was never run.
function makeSandbox({ curlBody = '{"notify":false}' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'warn-hook-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, '.session-watcher'), { recursive: true });
  const curlArgs = join(root, 'curl-args.txt');
  const osaArgs = join(root, 'osascript-args.txt');

  const fakeCurl = join(bin, 'curl');
  // Capture argv, emit a canned body on stdout (the hook discards it), succeed. This lets a test read
  // back the exact URL + --data the hook built, proving the sid/port it used came from stdin+statefile.
  writeFileSync(fakeCurl, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$CURL_ARGS_FILE"\nprintf '%s' '${curlBody}'\nexit 0\n`);
  chmodSync(fakeCurl, 0o755);

  const fakeOsa = join(bin, 'osascript');
  // If warn.js ever regressed into an OS-notification path, this would capture the call. v2.1 forbids it.
  writeFileSync(fakeOsa, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$OSASCRIPT_ARGS_FILE"\nexit 0\n`);
  chmodSync(fakeOsa, 0o755);
  // notify-send is the Linux twin of osascript — shadow it too so the no-notification proof is portable.
  const fakeNotify = join(bin, 'notify-send');
  writeFileSync(fakeNotify, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$OSASCRIPT_ARGS_FILE"\nexit 0\n`);
  chmodSync(fakeNotify, 0o755);

  return { root, bin, home, curlArgs, osaArgs };
}

// Run the REAL hook via `node warn.js` (mirrors the registered `command: bash, args: [warn.js]`),
// piping stdinStr. `usePath` prepends the sandbox bin so curl/osascript are the fakes; when false the
// real PATH is used (to exercise a genuine curl failure against a dead port). stdio stderr is ignored.
function runHook(stdinStr, sb, { usePath = true } = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      HOME: sb.home,
      CURL_ARGS_FILE: sb.curlArgs,
      OSASCRIPT_ARGS_FILE: sb.osaArgs,
    };
    if (usePath) env.PATH = `${sb.bin}:${process.env.PATH}`;
    const child = spawn('bash', [HOOK], { stdio: ['pipe', 'pipe', 'ignore'], env });
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
  const sb = makeSandbox();
  try {
    const sid = 'unreachable-sid';
    writeState(sb, sid, { sessionId: sid, port: 9 }); // port 9 (discard) — nothing listens → refused
    const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb, { usePath: false });
    assert.equal(code, 0);
    assert.equal(out, '', 'Stop-hook must emit NOTHING to stdout');
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// test 68 (session from stdin, NOT env): a fake curl on PATH captures argv; the state file lives under
// the STDIN sid; a DIFFERENT id is planted in CLAUDE_CODE_SESSION_ID. The POST URL must carry the stdin
// sid's port (and the --data must carry the stdin sid), proving the hook ignores the env id. The hook's
// own stdout must still be empty (no dryrun echo — that would violate zero-stdout).
test('warn.js (68): sid + port come from stdin/statefile, not env; POST built correctly; stdout empty', async () => {
  const sb = makeSandbox();
  try {
    const sid = 'stdin-sid-68';
    const port = 54321;
    writeState(sb, sid, { sessionId: sid, port });
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
    assert.ok(existsSync(sb.curlArgs), 'the hook should have POSTed via curl');
    const args = readFileSync(sb.curlArgs, 'utf8');
    assert.ok(args.includes(`http://127.0.0.1:${port}/api/notify-gate`),
      `curl URL must target the stdin sid's port; got:\n${args}`);
    assert.ok(args.includes(`"session_id":"${sid}"`),
      `--data must carry the STDIN sid (for the server's cross-session 409 guard); got:\n${args}`);
    assert.ok(!args.includes('env-sid-DIFFERENT'), 'the env session id must never reach the POST');
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// no-notification assertion (round-2 R2-D1): even when the POST response says {"notify":true}, the hook
// must NOT invoke osascript / notify-send. v2.1 delivery is statusline/dashboard only — the whole
// shell→AppleScript injection surface is deleted by design. Fakes for both are on PATH; their capture
// file must never be created.
test('warn.js (R2-D1): notify:true response still triggers NO osascript/notify-send', async () => {
  const sb = makeSandbox({ curlBody: '{"notify":true}' });
  try {
    const sid = 'notify-true-sid';
    writeState(sb, sid, { sessionId: sid, port: 55555 });
    const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
    assert.equal(code, 0);
    assert.equal(out, '', 'Stop-hook must emit NOTHING to stdout');
    assert.ok(existsSync(sb.curlArgs), 'the POST should have happened (curl invoked)');
    assert.ok(!existsSync(sb.osaArgs),
      'no OS notification is allowed in v2.1 — osascript/notify-send must never be invoked');
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// traversal / `..` reject (round-7 GPT#6 + round-8 GPT#2): a sid containing a path metacharacter or an
// internal `..` must be rejected BEFORE any filesystem lookup and BEFORE any curl — the hook exits 0,
// makes no POST (fake-curl capture file never created), and stays silent. `abc..def` specifically pins
// that the hook's reject set matches safeSessionId's (which rejects ANY `..`), so a state file the hook
// would look up under `abc..def.json` while the server wrote `__invalid_session__.json` can never arise.
test('warn.js (traversal): metachar / .. sids → exit 0, no curl, no fs touch, empty stdout', async () => {
  for (const sid of ['../evil', 'a/b', 'abc..def']) {
    const sb = makeSandbox();
    try {
      // Plant a state file under the *sanitized-ish* names too? No — the point is the hook bails on the
      // sid itself, before ever forming a path, so no state file is needed to prove no-curl.
      const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
      assert.equal(code, 0, `sid=${sid} must exit 0`);
      assert.equal(out, '', `sid=${sid} must emit nothing to stdout`);
      assert.ok(!existsSync(sb.curlArgs), `sid=${sid} must make NO curl (no POST to any server)`);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  }
});

// C3-1 (spec §3.4a, red line #1): the Stop-hook POST body must carry a CLIENT-side hook_event_id,
// generated ONCE per invocation and reused across curl retries. Without it the server mints a fresh id
// per receipt, so a duplicate POST of one Stop becomes two watermark-identical pending → drain 串轮.
// Harness adaptation (brief's runWarnHook({captureCurl}) → this file's makeSandbox/runHook): the fake
// curl appends its full argv one-arg-per-line to sb.curlArgs; we recover each POST body as the arg
// following every `--data` token (N curl invocations → N bodies) and assert on bodies[0]. B14: the id
// carries SECONDS not %3N ms — `date +%s%3N` is a GNU-ism that on macOS/BSD emits a literal `%3N`,
// breaking the all-digits id + this regex; the urandom nonce already guarantees uniqueness.
test('warn.js (C3-1): POST body carries a client hook_event_id, reused across retries', async () => {
  const sb = makeSandbox();
  try {
    const sid = 'sess-C3';
    writeState(sb, sid, { sessionId: sid, port: 54321 });
    const { code, out } = await runHook(JSON.stringify({ session_id: sid }), sb);
    assert.equal(code, 0);
    assert.equal(out, '', 'Stop-hook must emit NOTHING to stdout');
    assert.ok(existsSync(sb.curlArgs), 'the hook should have POSTed via curl');
    const argv = readFileSync(sb.curlArgs, 'utf8').split('\n');
    const bodies = argv.filter((line, i) => i > 0 && argv[i - 1] === '--data');
    assert.equal(bodies.length >= 1, true, 'at least one POST body captured');
    const b = JSON.parse(bodies[0]);
    assert.equal(b.session_id, 'sess-C3');
    assert.match(b.hook_event_id, /^sess-C3:stop:\d+:\d+:[0-9a-f]+$/,
      'client id: sid:stop:pid:seconds:nonce (B14 — no %3N ms)');
    // reused across retries: the body is pre-assembled ONCE into $body, so every captured body is identical.
    for (const raw of bodies) assert.equal(raw, bodies[0], 'same body reused across curl retries');
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});
