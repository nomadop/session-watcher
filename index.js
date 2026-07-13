#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, unlinkSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { safeSessionId } from './lib/atomic-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT_DIR = join(homedir(), '.session-watcher');
// State is scoped by session_id (server↔transcript is 1:1; session_id disambiguates two windows
// on the same project — a project-path hash would still collide there).
export const stateFileFor = (sessionId) => join(PORT_DIR, `${safeSessionId(sessionId || 'default')}.json`);

export function resolveProjectDir(env = process.env) {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  const home = env.HOME || homedir();
  return join(home, '.claude', 'projects');
}

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

// #7: like probeHealth, but returns the PARSED /api/health body (identity tokens pid+startedAt) or
// null when nothing valid answered. Loopback-only, bounded timeout, never throws. Used by stopWatcher
// to positively identify our server before signalling — a bare liveness check (kill(pid,0)) cannot
// distinguish our server from a recycled/foreign process that inherited the same pid.
export function fetchHealth(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    const req = httpGet({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = ''; res.on('data', d => body += d);
      res.on('end', () => { try { const h = JSON.parse(body); resolve(h && h.ok === true ? h : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

export function readState(sessionId) {
  try { return JSON.parse(readFileSync(stateFileFor(sessionId), 'utf8')); } catch { return null; }
}

export async function startWatcher(env = process.env, { open = true, transcript, waitForPort = true } = {}) {
  const sessionId = sessionIdOf(env);
  // Reuse only THIS session's server (health-probed) — never another session's.
  const prev = readState(sessionId);
  if (prev && await probeHealth(prev.port)) return { url: `http://127.0.0.1:${prev.port}`, reused: true };

  const dir = resolveProjectDir(env);
  // Auto-open the dashboard in the browser on start (a local OS action — NOT a model-context write,
  // so it does not touch the zero-pollution invariant). The MCP start_watcher path keeps open=true —
  // unchanged by this parameterization: the tool has opened a tab since 278af26, and this refactor only
  // ADDED the {open,transcript,waitForPort} options, it did not alter the tool's existing behavior. The
  // SessionStart hook passes open only on a fresh 'startup' source so resume/clear/compact reuse silently.
  // SW_NO_OPEN in the env still hard-disables it (test/e2e set it).
  // When a transcript path is supplied (the hook forwards Claude Code's transcript_path), it is passed
  // through as --transcript for an exact 1:1 session↔file bind; otherwise server.js resolves by
  // --session id. server.js's own precedence (--transcript > --session > newest) does the selection.
  const args = [join(__dirname, 'server.js'), '--port', '0', '--project', dir, '--session', sessionId];
  if (transcript) args.push('--transcript', transcript);
  if (open) args.push('--open');

  // Fire-and-forget path (used by the SessionStart hook): spawn the detached server and return
  // immediately WITHOUT awaiting its PORT= line. The server opens its own browser (--open) and writes
  // its own authoritative state file, so the launcher needs neither the port nor the URL — and a hook
  // must never block session start for up to the 10s port-wait below. stdio is fully ignored so the
  // child's PORT= can never reach the launcher's stdout (which Claude Code folds into model context),
  // and a no-op 'error' listener keeps a spawn failure from crashing a best-effort caller.
  if (!waitForPort) {
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
    child.on('error', () => {});
    child.unref();
    return { reused: false };
  }

  const child = spawn(process.execPath, args,
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    // On failure (spawn error OR start timeout) clear the pending timer and kill the child so a
    // detached server.js that never announced its port can't linger and the 10s timer can't stay armed.
    const t = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('server start timeout'));
    }, 10000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) { clearTimeout(t); resolve(parseInt(m[1], 10)); }
    });
    child.on('error', (err) => {
      clearTimeout(t);
      try { child.kill(); } catch {}
      reject(err);
    });
  });
  // The server itself writes the authoritative state file (incl. its own pid); we don't duplicate it.
  child.unref();
  return { url: `http://127.0.0.1:${port}`, reused: false };
}

export async function stopWatcher(env = process.env) {
  const sessionId = sessionIdOf(env);
  const st = readState(sessionId);
  if (!st || !st.pid) return { stopped: false };

  // #7 identity handshake: NEVER signal a pid we have not positively identified as our own server.
  // A bare kill(pid,0) only proves SOMETHING holds that pid — if the server was SIGKILLed without
  // unlinking its state and the OS recycled the pid, that would SIGTERM an innocent process. So we
  // probe /api/health on the recorded port and require BOTH identity tokens to match the state file.
  const health = await fetchHealth(st.port);

  if (health) {
    // A server answered. Only signal when it proves it is OURS (same pid AND same start timestamp).
    if (health.pid === st.pid && health.startedAt === st.startedAt) {
      try { process.kill(st.pid, 'SIGTERM'); }
      catch { return { stopped: false }; } // EPERM/ESRCH → be honest: we did not stop it.
      return { stopped: true };
    }
    // MISMATCH: some OTHER server answered on that port (recycled pid / foreign process). Do NOT
    // signal st.pid — that is exactly the innocent-process hazard. Leave state as-is; not ours to reap.
    return { stopped: false };
  }

  // NO response: a down server cannot prove identity, so blind-SIGTERM-ing its recorded pid is the
  // recycled-pid hazard. Policy: treat "state present but nothing answering" as already-stopped —
  // there is no live server of ours to stop — and unlink the stale state file so status is clean next
  // time. Never signal a bare pid here.
  try { unlinkSync(stateFileFor(sessionId)); } catch {}
  return { stopped: false };
}

export async function watcherStatus(env = process.env) {
  const st = readState(sessionIdOf(env));
  if (st && await probeHealth(st.port)) return { running: true, url: `http://127.0.0.1:${st.port}` };
  return { running: false };
}

// MCP wiring — only when run as the entrypoint (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'session-watcher', version: '0.1.0' });

  const reply = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  server.registerTool('start_watcher', { description: 'Start (or reuse) the Session Watcher dashboard server; returns its URL. Never returns metric values.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(await startWatcher()));
  server.registerTool('stop_watcher', { description: 'Stop the managed Session Watcher server.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(await stopWatcher()));
  server.registerTool('watcher_status', { description: 'Report whether the Session Watcher server is running and its URL.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => reply(await watcherStatus()));

  await server.connect(new StdioServerTransport());
  console.error('session-watcher MCP server ready');
}
