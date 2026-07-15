#!/usr/bin/env node
// Session Watcher statusline — thin client (Node.js cross-platform, replaces statusline.sh).
// Never blocks CC: always exit 0 with output.
// Reads stdin JSON (session_id + model), looks up the port from the per-session state file,
// fetches /api/status?fmt=line from the dashboard server, and prints the formatted line.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { get as httpGet } from 'node:http';

const STATE_DIR = process.env.SW_STATE_DIR || join(homedir(), '.session-watcher');

async function main() {
  // Read stdin
  const raw = await readStdin();
  let input = {};
  try { input = JSON.parse(raw); } catch { /* keep defaults */ }

  // Sanitize session_id (matches safeSessionId: whitelist charset, reject dangerous patterns)
  const rawSid = String(input.session_id || 'default');
  const sid = rawSid.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';

  // Normalize model name: strip ANSI escapes, then replace tab/CR/LF (matches F9)
  const model = String(
    (input.model && (input.model.display_name || input.model.id)) || 'model'
  ).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\t\r\n]/g, ' ');

  // Read port from per-session state file
  let port = '';
  try {
    const state = JSON.parse(readFileSync(join(STATE_DIR, `${sid}.json`), 'utf8'));
    port = String(state.port || '');
  } catch {}

  // Fetch status line from the dashboard server
  let line = '';
  if (port) {
    line = await fetchStatusLine(port);
  }

  // If the matched-session server is unreachable, scan ALL state files for any live server.
  // Claude Code can pass a different session_id to the statusline vs SessionStart hook
  // (e.g., persistent vs per-restart), so fallback scanning is essential.
  if (!line) {
    line = await scanForLiveServer();
  }

  if (line) {
    process.stdout.write(line + '\n');
  } else if (!port) {
    process.stdout.write(`[${model}] no port file\n`);
  } else {
    process.stdout.write(`[${model}] unreachable :${port}\n`);
  }
  process.exit(0);
}

// Scan all .json state files (excluding store.sqlite) for any reachable server.
// Returns the first status line found, or empty string.
async function scanForLiveServer() {
  if (!existsSync(STATE_DIR)) return '';
  let files;
  try { files = readdirSync(STATE_DIR); } catch { return ''; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
    } catch { continue; }
    const p = state?.port;
    if (!p) continue;
    const line = await fetchStatusLine(p, 500);
    if (line) return line;
  }
  return '';
}

function readStdin() {
  return new Promise((resolve) => {
    // When there's no pipe (TTY), resolve immediately with empty
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(buf); } };
    const timer = setTimeout(finish, 2000);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

function fetchStatusLine(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = httpGet(
      { host: '127.0.0.1', port, path: '/api/status?fmt=line', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { resolve(body.trim()); });
      }
    );
    req.on('error', () => { resolve(''); });
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

main();
