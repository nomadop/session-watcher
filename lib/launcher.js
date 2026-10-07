import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { get as httpGet } from 'node:http';
const PORT_DIR = process.env.SW_STATE_DIR || join(homedir(), '.session-watcher');

// round-6 GPT#3b: sanitize a sessionId used as a filename segment. Defense-in-depth — a `/`, `\`,
// `..`, or NUL would let `${sessionId}.json` escape the state dir. Inlined from the deleted
// lib/atomic-store.js (previously shared; now only used here and server.js, each inline).
function safeSessionId(sessionId) {
  const s = String(sessionId ?? '');
  if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s) || s.includes('..')) return '__invalid_session__';
  return s;
}
// State is scoped by session_id (server↔transcript is 1:1; session_id disambiguates two windows
// on the same project — a project-path hash would still collide there).
export const stateFileFor = (sessionId) => join(PORT_DIR, `${safeSessionId(sessionId || 'default')}.json`);

export function sessionIdOf(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || 'default';
}

export function probeHealth(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const req = httpGet({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export function readState(sessionId) {
  try { return JSON.parse(readFileSync(stateFileFor(sessionId), 'utf8')); } catch { return null; }
}

export function scanStateByHookSessionId(sessionId) {
  let files;
  try { files = readdirSync(PORT_DIR); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const st = JSON.parse(readFileSync(join(PORT_DIR, f), 'utf8'));
      if (st.hookSessionId === sessionId) return st;
    } catch { continue; }
  }
  return null;
}

export async function watcherStatus(env = process.env) {
  const sessionId = sessionIdOf(env);
  let st = readState(sessionId);
  if (!st) st = scanStateByHookSessionId(sessionId);
  if (st && await probeHealth(st.port)) return { running: true, url: `http://127.0.0.1:${st.port}` };
  return { running: false };
}

// --- Handoff HTTP-forwarding helpers (Task 11) ---

function liveUrl(env) {
  const sessionId = sessionIdOf(env);
  let st = readState(sessionId);
  if (!st) st = scanStateByHookSessionId(sessionId);
  return st && st.port ? `http://127.0.0.1:${st.port}` : null;
}

export async function getBucketSummary(env = process.env) {
  const url = liveUrl(env);
  if (!url) return { error: 'no_server' };
  try {
    const r = await fetch(`${url}/api/buckets`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return { error: 'no_server' }; }
}

export async function prepareHandoff(env = process.env, input = {}) {
  const url = liveUrl(env);
  if (!url) return { error: 'no_server' };
  try {
    const r = await fetch(`${url}/api/handoff/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return { error: 'no_server' }; }
}

export async function loadHandoff(env = process.env, input = {}) {
  const url = liveUrl(env);
  if (!url) return { error: 'no_server' };
  const qs = new URLSearchParams();
  if (input.load_token) qs.set('load_token', input.load_token);
  if (input.query) qs.set('query', input.query);
  if (input.query_mode) qs.set('query_mode', input.query_mode);
  try {
    const r = await fetch(`${url}/api/handoff/load${qs.toString() ? '?' + qs : ''}`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return { error: 'no_server' }; }
}

export async function rotateSession(env = process.env, input = {}) {
  const url = liveUrl(env);
  if (!url) return { error: 'no_server' };
  try {
    const r = await fetch(`${url}/api/rotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: input.session_id, transcript_path: input.transcript_path }),
      signal: AbortSignal.timeout(3000),
    });
    return await r.json();
  } catch { return { error: 'no_server' }; }
}
