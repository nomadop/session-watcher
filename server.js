import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { SessionWatcher } from './lib/watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT_DIR = join(homedir(), '.session-watcher');
// Discovery file is scoped by session_id (NOT a single global file, NOT project-hash):
// server↔transcript is 1:1, and session_id is the finest key — it also disambiguates two
// windows open on the SAME project (which a project-path hash would still collide).
const stateFileFor = (sessionId) => join(PORT_DIR, `${sessionId || 'default'}.json`);

export function formatLine(s) {
  const model = s.model || '';
  const tag = model ? (model.match(/opus|sonnet|haiku|deepseek/i)?.[0] || model) : 'model';
  const k = n => (n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n));
  // #6-server: render CALIBRATING whenever we're calibrating for ANY reason — not only when
  // !metricsReliable. During warmup metricsReliable is TRUE (short-circuits at <3 calls) but
  // kAvg=0 → Lthreshold≈baseline.total → pct≈100% → a misleading full ▓ bar + 🟡. getStatus now
  // exposes calibratingReason (T5) covering every warmup state incl. 'no_transcript'. restart is
  // false whenever calibratingReason != null (watcher.js: restart = crossed && reason===null), so
  // calibrating-first ordering can never suppress a real 🔴 restart. Keep the model tag; stay
  // non-empty + throw-free (this feeds the statusline that must never block Claude Code).
  if (s.calibratingReason != null || s.metricsReliable === false) {
    const hint = s.calibratingReason === 'no_transcript' ? ' 无转录/未找到' : '';
    return `[${tag}] 指标校准中 (calibrating${hint ? '·' + hint.trim() : ''})`;
  }
  const pct = s.Lthreshold > 0 ? Math.min(100, Math.round((s.L / s.Lthreshold) * 100)) : 0;
  const filled = Math.round(pct / 10);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  const light = s.restart ? '🔴' : (pct >= 90 ? '🟡' : '🟢');
  const eta = s.etaCalls == null ? '—' : (s.etaCalls === 0 ? '已过线' : `~${s.etaCalls}轮`);
  const phi = s.phi ? `φ${s.phi.toFixed(1)}×` : '';
  const p = s.paybackP != null ? `(P${Math.round(s.paybackP * 100)}%)` : '';
  const rst = s.restart ? ` · 🔴 L≥L* 建议重启(${s.restartReason})` : '';
  return `[${tag}] ${bar} L ${k(s.L)}/L* ${k(s.Lstar)} · ${light} · ${eta} · ${phi}${p}${rst}`;
}

// Resolve the newest .jsonl. If given a directory, search RECURSIVELY — CC transcripts live at
// projects/<encoded-cwd>/<session>.jsonl, so a non-recursive readdir on the projects/ root finds
// nothing (verified on real fixtures: 0 at root, 203 nested one level down).
export function resolveJsonl(target) {
  let targetStat;
  try { targetStat = statSync(target); } catch { return target; } // vanished/unstattable → as-is
  if (!targetStat.isDirectory()) return target;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  try { walk(target, 0); } catch { /* permission etc. */ }
  // #8: Schwartzian transform — stat each path ONCE (was ~2·N·log₂N statSync calls inside sort;
  // a 203-file dir cited ~3100). A file that vanishes / a broken symlink between walk() and stat
  // yields mtime=-Infinity (sorts to oldest) and is skipped, so a disappearing transcript can NEVER
  // throw out of startup (pre-fix statSync sat OUTSIDE the try/catch → uncaught → server died before
  // writing its port/state file). Newest surviving .jsonl wins; original target if none survive.
  const decorated = found.map((p) => {
    let mtime = -Infinity;
    try { mtime = statSync(p).mtimeMs; } catch { /* vanished/broken symlink → treat as oldest */ }
    return { p, mtime };
  }).filter((d) => d.mtime !== -Infinity);
  decorated.sort((a, b) => b.mtime - a.mtime);
  return decorated.length ? decorated[0].p : target;
}

// 1:1 identity binding: resolve the transcript by session_id, NOT mtime. CC lays transcripts at
// <projectsRoot>/<encoded-cwd>/<sessionId>.jsonl and the filename IS the session UUID, so we search
// the root for `${sessionId}.jsonl` and skip CC's fragile cwd-encoding entirely. Without this, a
// subagent-driven build (each subagent writes its own newer .jsonl) makes resolveJsonl's newest-mtime
// pick follow the WRONG session. Returns the path, or null (caller falls back to resolveJsonl) when the
// id is falsy/'default' (no real CC session) or no matching file exists. Never throws.
export function resolveBySessionId(projectsRoot, sessionId) {
  if (!sessionId || sessionId === 'default') return null;
  const wanted = `${sessionId}.jsonl`;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === wanted) hits.push(p);
    }
  };
  walk(projectsRoot, 0);
  return hits.length ? hits[0] : null;
}

// Factory: build an http.Server around an existing watcher (used by tests and CLI).
// Returns { app, server, sseClients, startPolling, stopTimers }. `server` is a real
// node:http.Server so callers do server.listen(0)/server.address()/server.close().
export function createServer({ watcher, pollIntervalMs = 1000 }) {
  const app = express();
  const startMs = Date.now();
  const sseClients = new Set();
  const server = createHttpServer(app);

  // Initial scan so the very first /api/status and /api/history are populated
  // (tests and the CLI both rely on this; without it /api/history returns []).
  try { watcher.poll(); } catch { /* empty/missing transcript → status stays in calibrating */ }

  // #7: /api/health doubles as an IDENTITY proof for the MCP launcher. It returns pid + startedAt so
  // stopWatcher can confirm the process listening on this port is genuinely OUR server before it ever
  // SIGTERMs a pid (guards against a recycled/foreign pid). startMs is the SINGLE source of truth:
  // the CLI writes this exact value to the state file's `startedAt` (see the listen callback below),
  // so health.startedAt === stateFile.startedAt and health.pid === stateFile.pid for a live server.
  // Stays fast, unauthenticated, loopback-only, and non-throwing.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, port: server.address()?.port ?? null, uptime: Math.floor((Date.now() - startMs) / 1000), pid: process.pid, startedAt: startMs });
  });

  const parseFitWindow = (q) => { const n = parseInt(q, 10); return [10, 20, 40].includes(n) ? n : undefined; };

  app.get('/api/status', (req, res) => {
    const status = watcher.getStatus(parseFitWindow(req.query.fitWindow));
    if (req.query.fmt === 'line') { res.type('text/plain').send(formatLine(status)); return; }
    res.json(status);
  });

  app.get('/api/history', (req, res) => {
    let h = watcher.getHistory(parseFitWindow(req.query.fitWindow));
    if (req.query.since) { const t = Date.parse(req.query.since); if (!Number.isNaN(t)) h = h.filter(p => Date.parse(p.ts) >= t); }
    res.json(h);
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.use(express.static(join(__dirname, 'public')));
  app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

  // Poll loop: emit SSE only on new data.
  let pollTimer = null;
  function startPolling() {
    if (pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => {
      const { changed } = watcher.poll();
      if (changed) for (const c of sseClients) c.write(`data: ${JSON.stringify({ type: 'scan' })}\n\n`);
    }, pollIntervalMs);
    pollTimer.unref?.();
  }
  const pingTimer = setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 15000);
  pingTimer.unref?.();

  // #7: expose startMs as `startedAt` so the CLI writes the SAME timestamp to the state file that
  // /api/health reports — one source of truth for the identity handshake (health===stateFile).
  return { app, server, sseClients, startPolling, startedAt: startMs, stopTimers: () => { clearInterval(pollTimer); clearInterval(pingTimer); } };
}

// Pure CLI-arg parser (exported for unit tests). #1: malformed numeric args must NEVER propagate
// as NaN — a NaN ratio defeats watcher's `?? cRatioFor(model)` (NaN is not nullish) and poisons
// every metric silently; a NaN lbase forces carried-baseline mode with a NaN total; a NaN/negative
// port misbinds server.listen so PORT= is never printed and the launcher times out at 10s. Each
// numeric field validates with Number.isFinite and falls back to a safe default; drops are reported
// via `warnings` (the caller prints them to stderr — stdout carries the PORT= line the launcher parses).
export function parseArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const warnings = [];

  // lbase: parseInt semantics; non-finite (incl. 'abc') OR negative → null. A negative injected dead
  // makes baseline.total <= 0 → the restart gate's `baseline.total > 0` never passes → permanent
  // calibrating (graceful, not a crash), so reject it up front and auto-detect instead. Mirrors the
  // `ratio > 0` guard below.
  const lbaseRaw = get('--lbase');
  let lbase = null;
  if (lbaseRaw != null) {
    const n = parseInt(lbaseRaw, 10);
    if (Number.isFinite(n) && n >= 0) lbase = n;
    else warnings.push(`ignoring invalid --lbase ${JSON.stringify(lbaseRaw)} (must be >= 0; using auto baseline)`);
  }

  // ratio: parseFloat semantics; non-finite OR <= 0 → null (cRatio must be > 0 → fall back to cRatioFor(model)).
  const ratioRaw = get('--ratio');
  let ratioOverride = null;
  if (ratioRaw != null) {
    const n = parseFloat(ratioRaw);
    if (Number.isFinite(n) && n > 0) ratioOverride = n;
    else warnings.push(`ignoring invalid --ratio ${JSON.stringify(ratioRaw)} (must be a number > 0; using model default)`);
  }

  // port: parseInt semantics; non-finite (NaN) or outside [0,65535] → 0 (ephemeral port, never crash).
  // A fractional value is truncated by parseInt (e.g. 80.5 → 80), not rejected — this is intentional.
  const portRaw = get('--port');
  let wantPort = 0;
  if (portRaw != null) {
    const n = parseInt(portRaw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 65535) wantPort = n;
    else warnings.push(`ignoring invalid --port ${JSON.stringify(portRaw)} (using ephemeral port 0)`);
  }

  return {
    transcript: get('--transcript'),
    project: get('--project'),
    session: get('--session'),
    lbase, ratioOverride, wantPort,
    open: argv.includes('--open'),
    warnings,
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const { transcript, project, session, lbase, ratioOverride, wantPort, open, warnings } = parseArgs(argv);
  for (const w of warnings) console.error(`session-watcher: ${w}`); // stderr only — stdout carries PORT=
  // Resolution priority (1:1 session↔transcript binding):
  //   1. --transcript wins (explicit file).
  //   2. --session id → the transcript NAMED for that session (identity, not mtime) under the CC
  //      projects root. This is what keeps the dashboard on THIS session when subagents (each writing
  //      a newer .jsonl) are active. The projects root is ~/.claude/projects — NOT --project, which
  //      carries the repo cwd (CLAUDE_PROJECT_DIR); transcripts live in the encoded-cwd tree there.
  //   3. else newest .jsonl under --project (recursive mtime fallback) — direct CLI use w/o a session.
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const byId = resolveBySessionId(projectsRoot, session);
  const jsonlPath = transcript
    ? resolve(transcript)
    : (byId || resolveJsonl(resolve(project || projectsRoot)));
  const sessionId = session || basename(jsonlPath).replace(/\.jsonl$/, '');
  const watcher = new SessionWatcher(jsonlPath, lbase, { ratioOverride });

  const STATE_FILE = stateFileFor(sessionId);
  const { server, startPolling, sseClients, stopTimers, startedAt } = createServer({ watcher, pollIntervalMs: 1000 });
  server.listen(wantPort, '127.0.0.1', () => {   // loopback only — never expose local session data
    const port = server.address().port;
    mkdirSync(PORT_DIR, { recursive: true });
    // #7: write createServer's startedAt (NOT a fresh Date.now()) so the state file's identity tokens
    // (pid, startedAt) are the exact values /api/health reports — the handshake stopWatcher relies on.
    writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid, transcriptPath: jsonlPath, sessionId, startedAt }));
    console.log(`PORT=${port}`);
    startPolling();
    if (open && !process.env.SW_NO_OPEN) {
      import('node:child_process').then(({ spawn }) => {
        // $BROWSER first (the xdg-open/npm/opener convention), then the platform default. In a
        // devcontainer VS Code sets $BROWSER to a helper that routes to the host browser, so honoring it
        // makes auto-open actually WORK headless instead of merely not-crashing.
        const cmd = process.env.BROWSER
          || (process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open');
        // A missing/failed opener (headless box: no $BROWSER and no `open`/`xdg-open`) makes the child
        // emit 'error'. Without a listener that 'error' is unhandled → it crashes THIS server milliseconds
        // after it wrote its state file + printed PORT=, leaving a stale state file pointing at a dead port
        // (every later auto-launch then re-crashes). Opening the dashboard is best-effort; on failure the
        // server keeps running and the user clicks the printed URL — swallow the error.
        const opener = spawn(cmd, [`http://127.0.0.1:${port}`], { detached: true, stdio: 'ignore' });
        opener.on('error', () => {});
        opener.unref();
      }).catch(() => {}); // dynamic import failure must not crash the server either
    }
  });

  function shutdown() {
    stopTimers();
    for (const c of sseClients) { try { c.end(); } catch {} }
    try { unlinkSync(STATE_FILE); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
