#!/usr/bin/env node
// Session Watcher Stop hook — Node.js cross-platform (replaces warn.sh).
// Zero context injection: ALWAYS exit 0 + empty stdout.
// Reads session_id from stdin JSON, POSTs notify-gate to the server, then exits.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

const STATE_DIR = process.env.SW_STATE_DIR || join(homedir(), '.session-watcher');

async function main() {
  // Read stdin (2s timeout – same spirit as warn.sh's 0.2s curl timeout)
  const raw = await readStdin(2000);
  if (!raw) { process.exit(0); }

  let sid;
  try { sid = JSON.parse(raw).session_id; } catch { process.exit(0); }
  sid = String(sid ?? '');

  // Whitelist charset + reject dangerous patterns (matches safeSessionId + warn.sh rules)
  if (!sid || sid === '.' || sid === '..' || sid.includes('..') || /[^A-Za-z0-9._-]/.test(sid)) {
    process.exit(0);
  }

  // Read port from state file
  const stateFile = join(STATE_DIR, `${sid}.json`);
  let state;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch {
    // Fallback: scan for a state file whose hookSessionId matches (per-restart session ID)
    state = findStateByHookSessionId(sid);
    if (!state) { process.exit(0); }
  }
  const port = state?.port;
  if (!port) { process.exit(0); }

  // Generate hook_event_id (matches warn.sh format: sid:stop:pid:epoch:nonce)
  const nonce = randomBytes(8).toString('hex');
  const hookEventId = `${sid}:stop:${process.pid}:${Math.floor(Date.now() / 1000)}:${nonce}`;

  // Fire-and-forget POST — response intentionally ignored
  const body = JSON.stringify({ session_id: sid, hook_event_id: hookEventId });
  await new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1', port,
      path: '/api/notify-gate',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 200,
    }, () => resolve());
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });

  process.exit(0);
}

function findStateByHookSessionId(sid) {
  let files;
  try { files = readdirSync(STATE_DIR); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const st = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
      if (st.hookSessionId === sid) return st;
    } catch { continue; }
  }
  return null;
}

function readStdin(ms) {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => { resolve(buf || null); }, ms);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(buf || null); });
    // stdin might already be closed if input was piped
    if (process.stdin.isTTY) { clearTimeout(timer); resolve(null); }
  });
}

main();
