// test/session-start-hook.test.js
// Unit tests for the SessionStart hook wrapper (hooks/session-start.js).
// The pure decision function (launchOptionsFor) is tested directly; the CLI entry's
// best-effort "never block session start" guarantee is tested by spawning the hook
// with malformed stdin and asserting a clean exit 0 with NO server spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { launchOptionsFor, readStdin, isMainModule } from '../hooks/session-start.js';

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

test('CLI entry: valid payload → exits 0, emits nothing to stdout, actually launches a server (self-cleaning)', async () => {
  // Valid JSON so JSON.parse succeeds and startWatcher IS reached (exercises the launch path, not just
  // the parse-throw branch). Fire-and-forget spawn returns immediately; the detached child's PORT= must
  // never surface on the hook's own stdout. We forward a transcript_path to the real deepseek fixture so
  // the server can bind and become healthy, then poll for its state file, kill the pid, and unlink —
  // leaving no orphan (mirrors the e2e cleanup discipline; unit tests must not leak processes).
  const sessionId = `hooktest-${process.pid}-${Math.floor(process.hrtime()[1])}`;
  const fixture = join(__dirname, '..', 'fixtures', 'host', '.claude', 'projects',
    'C--Users-nomad-freshtrack', 'aa8e3739-3264-48d6-a2a0-75346d583c03.jsonl');
  const transcriptBasename = basename(fixture).replace(/\.jsonl$/, '');
  const stateFile = join(homedir(), '.session-watcher', `${transcriptBasename}.json`);
  const payload = JSON.stringify({
    session_id: sessionId,
    source: 'resume', // not 'startup' → open:false (belt-and-suspenders with SW_NO_OPEN)
    transcript_path: existsSync(fixture) ? fixture : undefined,
  });
  // Clean up any stale state file from a previous test run (the state file path is now
  // keyed to the transcript basename, which is fixed — stale file would cause EEXIST in
  // writeStateFileExclusive and the server would fail to start).
  try { unlinkSync(stateFile); } catch {}
  try {
    const { code, out } = await runHook(payload);
    assert.equal(code, 0);
    assert.equal(out, '', 'child PORT= must not leak to the hook stdout');

    // Poll for the state file the detached server writes (it writes AFTER the hook has exited).
    // 100×50ms = 5s budget: node cold-start + listen is normally hundreds of ms, but a loaded CI box
    // can be slower — a wide budget avoids both a false failure AND a slow-boot orphan the finally would
    // otherwise miss (the server writes its pid only once it's up).
    let state = null;
    for (let i = 0; i < 100 && !state; i++) {
      if (existsSync(stateFile)) { try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {} }
      if (!state) await sleep(50);
    }
    assert.ok(state && state.pid && state.port, 'fire-and-forget launch should have spawned a real server');
    assert.equal(state.sessionId, transcriptBasename);
    assert.equal(state.hookSessionId, sessionId);
  } finally {
    // Best-effort cleanup — never leave an orphan server or state file behind. Re-poll briefly in case
    // the server booted slower than the assert budget: its pid may land only after the try block, so we
    // give the state file a short grace window here before giving up, then kill by recorded pid + unlink.
    let killed = false;
    for (let i = 0; i < 40 && !killed; i++) {
      try {
        if (existsSync(stateFile)) {
          const s = JSON.parse(readFileSync(stateFile, 'utf8'));
          if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} killed = true; }
        }
      } catch {}
      if (!killed) await sleep(50);
    }
    try { unlinkSync(stateFile); } catch {}
  }
});
