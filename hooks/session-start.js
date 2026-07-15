#!/usr/bin/env node
// Claude Code SessionStart hook: launch the session-watcher automatically, with no MCP tool call.
//
// Claude Code delivers the hook payload on STDIN as JSON: { session_id, transcript_path, source, ... }.
// `source` is one of startup | resume | clear | compact. We:
//   - inject session_id as CLAUDE_CODE_SESSION_ID so the existing startWatcher() reuse path works;
//   - forward transcript_path as --transcript for an exact 1:1 session↔file bind (server.js prefers it
//     over --session resolution);
//   - open the browser tab ONLY on a fresh 'startup' — resume/clear/compact reuse the running server
//     silently (launch is idempotent: startWatcher health-probes and returns {reused:true}).
//
// This hook is BEST-EFFORT: any failure (bad stdin, launch error) must never block or delay the
// session, so we always exit 0. It coexists with the MCP start_watcher tool (shared state file →
// health-probe reuse means no double-launch); the hook is the automatic path, the tool the manual one.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startWatcher } from '../lib/launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pure decision function — no I/O, unit-tested directly.
export function launchOptionsFor(payload = {}, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (payload.session_id) env.CLAUDE_CODE_SESSION_ID = payload.session_id;
  return {
    env,
    open: payload.source === 'startup',
    transcript: payload.transcript_path || undefined,
  };
}

// True when this module is the process entry point. Compares via pathToFileURL, NOT
// `file://${argv1}`: import.meta.url percent-encodes spaces (and other chars), so a raw string
// concatenation never matches under an install path like /Users/First Last/… → the hook would
// silently no-op (no dashboard, no error). pathToFileURL applies the SAME encoding to both sides.
// Extracted + exported so the spaced-path case is unit-testable without renaming the file on disk.
export function isMainModule(metaUrl, argv1) {
  return metaUrl === pathToFileURL(argv1).href;
}

// Bounded stdin read. Resolves on 'end'/'error' (best-effort: whatever we got so far), and ALSO on a
// hard timeout — Claude Code always closes the hook's stdin, but if it ever didn't, an unbounded read
// would hang the session. The timeout floor guarantees the hook can never stall on a stuck stream.
export function readStdin(stream, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (d) => { buf += d; });
    stream.on('end', () => { clearTimeout(timer); finish(); });
    stream.on('error', () => { clearTimeout(timer); finish(); });
  });
}

// CLI entry — only runs when invoked directly (not on import for tests). See isMainModule.
if (isMainModule(import.meta.url, process.argv[1])) {
  (async () => {
    try {
      const raw = await readStdin(process.stdin);
      const payload = JSON.parse(raw);
      const { env, open, transcript } = launchOptionsFor(payload);
      // Fire-and-forget (waitForPort:false): return the instant the server is spawned, WITHOUT awaiting
      // its port. The server opens its own browser and writes its own state file, so the hook needs
      // neither — and must never block session start for the launcher's 10s port-wait on a slow/broken
      // server. This is what keeps the BEST-EFFORT "never delay" promise literally true.
      await startWatcher(env, { open, transcript, waitForPort: false, serverPath: join(__dirname, '..', 'server.js') });
    } catch {
      // swallow — a hook must never block or fail session start
    } finally {
      process.exit(0);
    }
  })();
}
