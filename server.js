// node:sqlite (DatabaseSync) requires Node >=22.16.0.
const [_major, _minor] = process.versions.node.split('.').map(Number);
if (_major < 22 || (_major === 22 && _minor < 16)) { console.error('Session Watcher requires Node >=22.16.0 (node:sqlite)'); process.exit(1); }
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { readdirSync, statSync, readFileSync, mkdirSync, unlinkSync, openSync, writeSync, closeSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomInt } from 'node:crypto';
import { SessionWatcher } from './lib/watcher.js';
import { advanceRateLampToCurrent, mergeLedgerIntoStatus, enrichStatusLandmarks, getLiveLedger, flushAll, getDebugCounters, isEnospcPaused } from './lib/rate-lamp-manager.js';
import { stateKeyForStatus } from './lib/rate-lamp-store.js';
import { IDLE_HEARTBEAT_MS, MODEL_PRICING_PRESETS, HANDOFF_MAX_PATHS, HANDOFF_MAX_SUMMARY_CHARS, HANDOFF_MAX_NEXT_TASK_CHARS, HANDOFF_TOKEN_MAX_RETRIES, HANDOFF_HOOK_TTL_DAYS, HANDOFF_HOOK_TASK_PREVIEW_CHARS } from './lib/constants.js';
import { resolveProjectKey } from './lib/project-key.js';
import { initStore, closeStoreGlobal, getStore } from './lib/store.js';
import { cleanupLegacyJson, defaultBaseDir } from './lib/legacy-cleanup.js';
import { cRatioFor } from './lib/extract.js';
import { loadPricingOverride, savePricingOverride, deletePricingOverride, validatePricingInput } from './lib/pricing-store.js';
import { sweepStaleState, sweepStalePortFiles } from './lib/state-reaper.js';
import {
  formatLine,
} from './lib/statusline-format.js';
import { loadIsIgnored } from './gitignore-loader.js';
import { archiveCurrentSegment } from './lib/fold.js';
import { replaySessionTelemetry } from './lib/carry-sweep.js';
import { computePp, computeMovableFrac, computeBr } from './lib/bill-regret.js';
import { nucleus } from './lib/landmarks.js';
import { charsToTokens, canonicalizePath } from './lib/measure.js';
import { generateLoadToken, redactSecrets, normalizeKeepPath, cjkBigrams, buildFtsMatch, hashFileContent, HASH_MAX_BYTES } from './lib/handoff.js';
import { PLUGIN_VERSION } from './lib/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Count logical lines without allocating a UTF-8 string/array. statSync-gated on the SAME cap as
// hashFileContent so a binary/huge/special file is never buffered. Trailing newline does not inflate:
// a file ending in \n has one fewer logical line than \n count + 1; empty file → 0.
function countFileLinesBounded(absPath) {
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size > HASH_MAX_BYTES) return null;
    if (st.size === 0) return 0;
    const buf = readFileSync(absPath);              // ≤ HASH_MAX_BYTES, gated above
    let nl = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0A) nl++;
    // logical lines = newline count, unless the last byte is NOT a newline (a final unterminated line).
    return buf[buf.length - 1] === 0x0A ? nl : nl + 1;
  } catch { return null; }
}

// round-6 GPT#3b: sanitize a sessionId used as a filename segment. Defense-in-depth — a `/`, `\`,
// `..`, or NUL would let `${sessionId}.json` escape the state dir. Inlined from the deleted
// lib/atomic-store.js (previously shared; now only used here and lib/launcher.js, each inline).
export function safeSessionId(sessionId) {
  const s = String(sessionId ?? '');
  if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s) || s.includes('..')) return '__invalid_session__';
  return s;
}

// Collapse a Map<lineNum, tokens> into sorted [start, end] inclusive ranges.
function collapseLineRanges(linesMap) {
  const sorted = [...linesMap.keys()].sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= end + 1) { end = sorted[i]; }
    else { ranges.push([start, end]); start = sorted[i]; end = sorted[i]; }
  }
  ranges.push([start, end]);
  return ranges;
}

// Agent sees only what it needs to reload the file; all per-entry telemetry keys
// (hp/hl/bucket_id/match_status/candidate_bucket_ids/total_line_count/selected_line_count) stay
// server-side. The stored DB row retains full telemetry — projection is RESPONSE-only.
const AGENT_ENTRY_KEYS = ['path', 'symbols', 'lines'];
function projectEntry(e) {
  if (!e || typeof e !== 'object') return e;
  const out = {};
  for (const k of AGENT_ENTRY_KEYS) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

// R1-H: safe-parse — a single corrupt row must not 500 the endpoint.
function formatHandoffFull(h) {
  let parsed;
  try { parsed = JSON.parse(h.pathsToKeep || '{}'); }
  catch { return { found: false, status: 'error', error: 'corrupt_handoff' }; }
  // Backward compat: old records stored a bare array; new records store {paths, skills}.
  const rawPaths = Array.isArray(parsed) ? parsed : (parsed.paths || []);
  const paths = (Array.isArray(rawPaths) ? rawPaths : []).map(projectEntry);
  const skills = Array.isArray(parsed) ? undefined : (parsed.skills?.length ? parsed.skills : undefined);
  const out = { found: true, handoff_id: h.handoffId, load_token: h.loadToken, created_at: h.createdAt,
    summary: h.summary, next_task: h.nextTask, paths_to_keep: paths };
  if (h.projectId) out.project_dir = h.projectId;
  if (skills) out.skills_to_keep = skills;
  return out;
}

export const PORT_DIR = process.env.SW_STATE_DIR || join(homedir(), '.session-watcher');
// Discovery file is scoped by session_id (NOT a single global file, NOT project-hash):
// server↔transcript is 1:1, and session_id is the finest key — it also disambiguates two
// windows open on the SAME project (which a project-path hash would still collide).
// round-7 GPT#6: route the sid through safeSessionId so all THREE sid→path writers (this
// port-discovery file + gate-store's + rate-lamp-store's pathFor) agree — a `/` or `..` in the
// sid can no longer escape PORT_DIR. Defense-in-depth: the sid is a harness UUID in practice.
export const stateFileFor = (sessionId) => join(PORT_DIR, `${safeSessionId(sessionId || 'default')}.json`);

// Atomic exclusive create (spec §5.2, invariant #20): O_CREAT|O_EXCL. Throws EEXIST if a live sibling
// already owns this sid's state file — the single-instance BACKSTOP for a bare `node server.js` relaunch
// that bypassed startWatcher's health-probe (startWatcher owns the PRIMARY guard; see the listen callback).
// shutdown()'s unlinkSync removes it, so a clean restart re-creates freely. NO probe/liveness logic here —
// liveness truth stays in startWatcher (SSOT); a crash-stale file is cleared by startWatcher's dead-port probe.
export function writeStateFileExclusive(path, record) {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
}

// formatLine is now imported from lib/statusline-format.js (v3 layout: 灯 bar %% ×N · ~Nt u · Δ L/b · model :port).
// Re-export so existing test imports from server.js continue to resolve.
export { formatLine };

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

// v2.2-C5b: module-level test clock override for the adaptive idle gate (A20 seam).
// Set via _setServerTestClock(ms); null = use real performance.now().
let _globalTestClockMono = null;

// Idle auto-shutdown: server exits after IDLE_SHUTDOWN_MS with no HTTP requests and no SSE clients.
// 24h default — statusline is event-driven (not polling), so long gaps between HTTP requests are normal;
// a shorter TTL (10min, 2h) caused mid-session "no port file" on active sessions.
// Fix #9: use Number.isFinite guard instead of `||` — `||` treats 0 as falsy, so SW_IDLE_TTL_MS=0
// (disable idle shutdown) would be ignored and the 24h default would silently apply.
const _idleEnv = Number(process.env.SW_IDLE_TTL_MS);
export const IDLE_SHUTDOWN_MS = Number.isFinite(_idleEnv) ? _idleEnv : 24 * 60 * 60 * 1000;
// V3-D3: profile_snapshot write throttle (30s). The snapshot only needs to be current at session end
// (GC archival reads it days later); 30s max staleness on crash is acceptable.
export const SNAPSHOT_THROTTLE_MS = 30_000;

// Pure function for testability: returns true if the server should shut down due to idleness.
export function shouldIdleShutdown({ sseClientsSize, lastRequestMono, now }) {
  return sseClientsSize === 0 && (now - lastRequestMono) > IDLE_SHUTDOWN_MS;
}

// Factory: build an http.Server around an existing watcher (used by tests and CLI).
// Returns { app, server, sseClients, startPolling, stopTimers }. `server` is a real
// node:http.Server so callers do server.listen(0)/server.address()/server.close().
export function createServer({ watcher, pollIntervalMs = 1000, sessionId, hookSessionId = null, onIdleShutdown = null, projectsRoot = null, stateDir = null, publicDir = join(__dirname, 'public'), store = null, disableTelemetrySweep = false }) {
  const app = express();
  const startMs = Date.now();
  const sseClients = new Set();
  const server = createHttpServer(app);
  // Store resolution (test-injection seam): production passes no `store` and every call site falls
  // through to the module-level `getStore()` singleton — identical to the pre-injection behavior.
  // Resolution is LAZY (per call site, not once here): production invokes createServer() BEFORE
  // initStore() (see index.js / the CLI entry), so resolving eagerly here would throw "Store not
  // initialized". Every getStore() call site is inside a route handler or the poll-timer tick, which
  // only run after listen()→initStore(), so `resolveStore()` always sees an initialized store. Tests
  // that need two independent connections on the same DB file (bootSecondConsumer) inject their own
  // openStore() handle so the two app instances do NOT share the global singleton. NOTE: the FOLD
  // archival path (lib/fold.js handleSegmentBoundary → getStore()) is NOT threaded by this seam — an
  // injected store covers only the server's own reads/writes (prepare/load, profile_snapshot save).
  const resolveStore = () => store || getStore();
  // activeWatcher: routes read from this. Normally === watcher; during replay of a
  // different transcript, may point to a temporary fully-processed watcher.
  let activeWatcher = watcher;

  // Idle auto-shutdown: track last HTTP request time (monotonic)
  let lastRequestMono = performance.now();
  app.use((req, res, next) => { lastRequestMono = performance.now(); next(); });

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

  app.get('/api/status', (req, res, next) => {
    try {
      const status = activeWatcher.getStatus();
      if (activeWatcher !== watcher && _replayController) {
        // Replay mode: inject billProgress + gate/backstop state, then enrich landmarks
        status.rateLamp = status.rateLamp || {};
        status.rateLamp.billProgress = _replayController.billProgress;
        const gate = _replayController.gateState;
        status.rateLamp.hasDeepWaterGateFired = gate.hasDeepWaterGateFired;
        status.rateLamp.dwBillsSinceLastAlert = gate.dwBillsSinceLastAlert;
        status.rateLamp.backstopLapCount = gate.backstopLapCount;
        // Notification banner: surface gate/backstop fire as lastStopEvent
        const notify = _replayController.lastNotify;
        if (notify) {
          status.rateLamp.lastStopEvent = {
            kind: notify.kind,
            message: notify.kind === 'gate' ? 'Deep water — bill premium is accumulating.' : 'Still in deep water — consider restarting.',
          };
        }
        enrichStatusLandmarks(status);
      } else {
        // Live mode: full ledger merge
        const currentKey = status.rateLamp?.reliable ? stateKeyForStatus(status) : null;
        const ledger = getLiveLedger(currentSessionId);
        mergeLedgerIntoStatus(status, ledger, currentKey);
      }
      // billCycleCount is DEBUG-ONLY (GPT#16): attach only when ?debug query param is set.
      if (req.query.debug && status.rateLamp?.billingCycle) {
        const debugLedger = (activeWatcher === watcher) ? getLiveLedger(currentSessionId) : null;
        status.rateLamp.billingCycle.cycleCountInSegment = debugLedger?.billCycleCount ?? 0;
      }
      if (req.query.fmt === 'line') {
        status.port = server.address()?.port ?? null;
        const line = formatLine(status);
        const port = status.port ?? '';
        const url = port ? ` http://127.0.0.1:${port}` : '';
        // Append URL to first line only (alert may be on second line)
        const firstNewline = line.indexOf('\n');
        if (firstNewline === -1) {
          return res.type('text/plain').send(line + url);
        }
        return res.type('text/plain').send(line.slice(0, firstNewline) + url + line.slice(firstNewline));
      }
      res.json(status);
    } catch (e) { next(e); } // round-2 gemini 一.2: error boundary — a bad request must not crash the daemon
  });

  app.get('/api/history', (req, res) => {
    let h = activeWatcher.getHistory(parseFitWindow(req.query.fitWindow));
    if (req.query.since) { const t = Date.parse(req.query.since); if (!Number.isNaN(t)) h = h.filter(p => Date.parse(p.ts) >= t); }
    res.json(h);
  });

  app.get('/api/buckets', (req, res, next) => {
    try {
      const bd = activeWatcher.getBucketData();
      const s = activeWatcher.getStatus();
      let paths = bd.paths.map(p => ({ ...p, last_active_turn: p.lastTurn }));
      res.json({
        ...bd, paths,
        session_id: currentSessionId,
        segment: bd.segment,
        current_turn: bd.currentTurnSeq,
        generated_at: Date.now(),
        metrics: { br: s.br, mf: s.mf, pp: computePp(s.x, s.dhat), g: s.g, b_total: s.B, c_ratio: s.cRatio },
      });
    } catch (e) { next(e); }
  });

  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    // v2.2-C5b SSE GC: IDEMPOTENT del (Set.delete on an already-removed entry is a safe no-op).
    // Bind to BOTH req and res events — client-side aborts surface on the REQUEST ('close'/'aborted'),
    // so res-only listeners would miss them. 'aborted' is a REQUEST event, never attached to res.
    const del = () => sseClients.delete(res);
    req.on('close', del);
    req.on('aborted', del);
    res.on('close', del);
    res.on('error', del);
    // Half-open TCP guard: if the socket goes idle beyond the threshold, destroy it —
    // this guarantees the 'close' event fires and del() cleans sseClients.
    if (req.socket) req.socket.setTimeout(30000, () => req.socket.destroy());
  });

  // Mount the JSON body parser for POST routes (pricing + handoff). A malformed body → express.json
  // throws → the terminal error middleware returns 500 (daemon stays up).
  // Limit raised to 64kb: handoff prepare accepts summaries up to 10000 chars + paths + JSON framing.
  app.use(express.json({ limit: '64kb' }));

  // ── Replay (post-v3: transcript replay for demo recording) ──────────────
  // Architecture: a fresh watcher with byte-limit valve runs the full production pipeline.
  // No re-derivation of metrics — getStatus/mergeLedger produce everything naturally.
  let _replayController = null;

  app.post('/api/replay/start', async (req, res) => {
    const { transcript, speed = 4 } = req.body || {};
    const replayPath = transcript || watcher.path;
    if (!replayPath) return res.status(400).json({ error: 'no transcript available' });

    // Stop any existing replay
    if (_replayController) { _replayController.stop(); _replayController = null; }
    activeWatcher = watcher;

    try {
      const { indexTranscript, ReplayController } = await import('./lib/replay.js');
      const index = indexTranscript(replayPath);
      if (index.length === 0) return res.status(400).json({ error: 'no usage rows in transcript' });

      // Fresh watcher — isolated from live, starts at byte 0 with byte-limit valve
      const replayWatcher = new SessionWatcher(replayPath, null, { cwd: watcher.cwd });
      activeWatcher = replayWatcher;

      _replayController = new ReplayController(replayWatcher, index, {
        speed,
        onAdvance: () => {
          // Broadcast SSE scan + replay tick so dashboard fetches fresh data and shows replay state
          if (sseClients.size > 0) {
            const prog = _replayController?.progress;
            const tick = JSON.stringify({ type: 'tick', uptime: activeWatcher._uptimeSec(), replay: prog ? { current: prog.current, total: prog.total, speed: prog.speed, paused: prog.paused } : undefined });
            for (const c of sseClients) { try { c.write(`data: ${tick}\n\ndata: ${JSON.stringify({ type: 'scan' })}\n\n`); } catch { sseClients.delete(c); } }
          }
          // Replay finished: keep activeWatcher + _replayController alive so the
          // dashboard freezes on the final state (u-line, rent meter stay visible).
          // The controller is stopped (no more steps) but still provides billProgress/gate.
        },
      });
      _replayController.start();

      res.json({ ok: true, total: index.length, speed });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/replay/stop', (req, res) => {
    if (_replayController) { _replayController.stop(); _replayController = null; }
    activeWatcher = watcher;
    res.json({ ok: true });
  });

  app.post('/api/replay/speed', (req, res) => {
    const { speed } = req.body || {};
    if (!_replayController) return res.status(400).json({ error: 'no active replay' });
    if (typeof speed !== 'number' || speed <= 0) return res.status(400).json({ error: 'invalid speed' });
    _replayController.speed = speed;
    res.json({ ok: true, speed: _replayController.speed });
  });

  app.post('/api/replay/pause', (req, res) => {
    if (!_replayController) return res.status(400).json({ error: 'no active replay' });
    _replayController.pause();
    res.json({ ok: true, paused: true });
  });

  app.post('/api/replay/resume', (req, res) => {
    if (!_replayController) return res.status(400).json({ error: 'no active replay' });
    _replayController.start();
    res.json({ ok: true, paused: false });
  });

  app.get('/api/replay/status', (req, res) => {
    if (!_replayController) return res.json({ active: false });
    res.json({ active: true, ...(_replayController.progress) });
  });

  // ── Handoff (post-v3 §4) ────────────────────────────────────────────────
  app.post('/api/handoff/prepare', (req, res, next) => {
    try {
      const { paths_to_keep = [], skills_to_keep, summary = '', next_task = null, observed_segment, load_token: existingToken } = req.body || {};
      if (typeof observed_segment === 'number' && observed_segment !== watcher.getSegmentIndex())
        return res.status(409).json({ status: 'error', error: 'stale_bucket_summary', instruction: 'Call get_bucket_summary again before preparing handoff.' });
      if (!Array.isArray(paths_to_keep))
        return res.status(400).json({ status: 'error', error: 'invalid_paths_to_keep' });
      if (paths_to_keep.length > HANDOFF_MAX_PATHS)
        return res.status(400).json({ status: 'error', error: 'too_many_paths', max_paths: HANDOFF_MAX_PATHS, actual_paths: paths_to_keep.length });
      if (typeof summary !== 'string' || summary.length === 0)
        return res.status(400).json({ status: 'error', error: 'summary_required' });
      if (summary.length > HANDOFF_MAX_SUMMARY_CHARS)
        return res.status(400).json({ status: 'error', error: 'summary_too_long', max_chars: HANDOFF_MAX_SUMMARY_CHARS, actual_chars: summary.length, instruction: 'Compress the summary and call prepare_handoff again.' });
      if (next_task != null && String(next_task).length > HANDOFF_MAX_NEXT_TASK_CHARS)
        return res.status(400).json({ status: 'error', error: 'next_task_too_long', max_chars: HANDOFF_MAX_NEXT_TASK_CHARS, actual_chars: String(next_task).length });

      // Redact FIRST — secrets must never reach token/search_terms/DB.
      const redSummary = redactSecrets(summary);
      const redNext = next_task != null ? redactSecrets(String(next_task)) : null;

      // Normalize paths; split invalid (..) from unknown (not in B_rebuild).
      const bd = watcher.getBucketData();
      const known = new Map(bd.paths.map(p => [p.path, { tokens: p.tokens, lastTurn: p.lastTurn }]));

      // ── Telemetry (spec decision 7): freeze the candidate universe server-side. The agent never
      // sees this payload. Each snapshot entry gets a stable local id + (for kept-matched candidates) a
      // canonical path + whole_bytes.
      //
      // NO truncation. bucket_snapshot is written once per prepare and bd.paths is "files touched this
      // session" (tens–hundreds); the only real cost is stat/canonicalize, and only KEPT paths need
      // whole_bytes/canonical. So persist EVERY candidate's in-memory {id, raw, tokens, lastTurn}
      // un-truncated, and stat/canonicalize ONLY the kept-matched ones (below). Cost is bounded by the
      // kept-path count (single digits) by construction — no cap, no forced/rest, no byte-trim, no
      // snapshot_truncated. (A giant candidate set is a rare accumulation concern → CST-D8 retention,
      // not a lossy in-row cap that corrupts bucket_id resolution.)
      const ctpVersion = (watcher._ctp && watcher._ctp.version) || 1;
      // id 'b'+i is positional over bd.paths — stable. canonical_path/whole_bytes are filled lazily below
      // only for candidates a kept path resolves to (the rest keep canonical_path=null, whole_bytes=null).
      const snapshotPaths = bd.paths.map((p, i) => ({
        id: 'b' + i,
        raw_path: p.path,
        canonical_path: null,       // filled only if this candidate is kept-matched
        whole_ctp: p.tokens,        // scope-labeled ESTIMATE (K_files_whole_ctp), NOT a K_A bound
        whole_bytes: null,          // BYTES; filled from an fs stat only for kept-matched candidates
        lastTurn: p.lastTurn ?? null,
      }));
      // NOTE: serialize `bucketSnapshot` AFTER the kept-identity loop below — that loop lazily fills
      // canonical_path/whole_bytes on the kept-matched snapshot entries, and those must be in the JSON.
      let bucketSnapshot;

      const invalid_paths = [], keptEntries = [], unknown_paths = [];
      const seenPaths = new Set();
      for (const raw of paths_to_keep) {
        if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string') { invalid_paths.push(raw); continue; }
        const { path, invalid } = normalizeKeepPath(raw.path, watcher.cwd);
        if (invalid) { invalid_paths.push(raw); continue; }
        if (seenPaths.has(path)) continue; // dedupe
        seenPaths.add(path);
        const symbols = Array.isArray(raw.symbols) ? raw.symbols.filter(s => typeof s === 'string') : undefined;
        keptEntries.push({ path, symbols: symbols && symbols.length ? symbols : undefined });
      }

      // Bind kept↔bucket identity ONCE, here — never re-guessed by suffix offline. Matching runs against
      // `snapshotPaths` = exactly what is persisted (every candidate; no truncation), so a bucket_id can
      // never dangle. Apply PRIORITY — a canonical/raw EXACT match wins outright; suffix matches are
      // considered ONLY when there is no exact match, so a path that exact-matches one candidate AND
      // suffix-matches another is NOT falsely ambiguous. NOTE: bd.paths[].path (= sp.raw_path) is the
      // ALREADY-CANONICALIZED absolute bucket key (getBucketData emits the B_rebuild map key verbatim,
      // and those keys are canonicalizePath'd at ingestion), while entry.path is project-relative — so
      // the exact test canonicalizes the candidate's raw_path and compares to the kept path's abs.
      const keptCanon = (rel) => canonicalizePath(rel, watcher.cwd || process.cwd());
      for (const entry of keptEntries) {
        const abs = keptCanon(entry.path);
        // raw_path IS the canonicalized-absolute bucket key (idempotent under keptCanon), so a direct
        // `raw_path === abs` is the exact test — no per-candidate canonicalize (honors the kept-only cost
        // bound). canonical_path===abs also fires once a prior kept entry lazily filled it; raw===entry.path
        // is a defensive clause for a hypothetical relative bucket key.
        const exact = snapshotPaths.filter(sp =>
          sp.canonical_path === abs || sp.raw_path === abs || sp.raw_path === entry.path);
        const suffix = snapshotPaths.filter(sp =>
          (sp.canonical_path && sp.canonical_path.endsWith('/' + entry.path))
          || sp.raw_path.endsWith('/' + entry.path));
        const matches = exact.length ? exact : suffix;   // exact beats suffix; suffix only if no exact
        // Hash/line-count the MATCHED candidate's physical file, not cwd/entry.path. On a unique suffix
        // match to api/src/server.js, the file to hash is that candidate, NOT cwd/src/server.js (which
        // may not exist → hp=null while match_status='exact' — a silent lie).
        let hashTarget = null;
        if (matches.length === 1) {
          entry.bucket_id = matches[0].id; entry.match_status = 'exact';
          // Lazily canonicalize + stat the matched candidate (only kept-matched candidates pay this).
          if (matches[0].canonical_path == null) matches[0].canonical_path = keptCanon(matches[0].raw_path);
          if (matches[0].whole_bytes == null) { try { const st = statSync(matches[0].canonical_path); if (st.isFile()) matches[0].whole_bytes = st.size; } catch { /* leave null */ } }
          hashTarget = matches[0].canonical_path;   // the physically-identified file
        } else if (matches.length > 1) {
          entry.bucket_id = null; entry.match_status = 'ambiguous';
          entry.candidate_bucket_ids = matches.map(m => m.id);   // persist so offline never re-guesses
          // Ambiguous → NO single physical file is authoritative. Do NOT hash a guessed cwd/entry.path
          // (it may resolve to a third, non-candidate file → a valid-looking hash of the WRONG identity,
          // worse than null). Leave hp=null; offline compares each candidate's whole_bytes.
          hashTarget = null;
        } else {
          entry.bucket_id = null; entry.match_status = 'unmatched';
          hashTarget = null;
        }

        entry.hp = hashTarget ? hashFileContent(hashTarget) : null;   // content_hash_prepare; null if ambiguous/unmatched/unreadable
        // Re-estimation basis (spec decision 7): store line-count context so a future tokenizer can
        // recompute without a migration. Count lines with a BOUNDED Buffer scan for 0x0A — NOT
        // readFileSync(abs,'utf8').split('\n'), which has no size cap and would allocate a full UTF-8
        // string + array for an 8MB binary. NO trailing-newline off-by-one: "a\nb\n" is 2, "" is 0.
        entry.total_line_count = hashTarget ? countFileLinesBounded(hashTarget) : null;   // null if ambiguous/unmatched/unreadable/over-cap
        // selected_line_count is filled after line-range injection below (Step 3b).
      }

      let kept_tokens = 0;
      const resolved_paths = [];
      for (const entry of keptEntries) {
        // match by suffix/exact against known bucket paths (bucket paths are absolute; kept are project-relative)
        const matches = [];
        for (const [kp, info] of known) { if (kp === entry.path || kp.endsWith('/' + entry.path)) matches.push({ kp, ...info }); }
        if (matches.length > 1) {
          // Auto-resolve: pick the most recently active match
          matches.sort((a, b) => b.lastTurn - a.lastTurn);
          kept_tokens += matches[0].tokens;
          resolved_paths.push({ from: entry.path, to: matches[0].kp });
        } else if (matches.length === 1) { kept_tokens += matches[0].tokens; }
        else { unknown_paths.push(entry.path); }
      }
      // Inject line ranges from _bRebuild for each kept path (skip if full file was read)
      for (const entry of keptEntries) {
        const resolvedPath = entry.path;
        const bKey = watcher._bRebuild.paths.has(resolvedPath) ? resolvedPath
          : [...watcher._bRebuild.paths.keys()].find(k => k.endsWith('/' + resolvedPath));
        if (!bKey) continue;
        const hasFullSnapshot = watcher._bRebuild._hasFullSnapshot.get(bKey);
        if (hasFullSnapshot) continue; // full file read — no lines needed, load agent should Read entire file
        const bEntry = watcher._bRebuild.paths.get(bKey);
        if (bEntry && bEntry.lines.size > 0) {
          entry.lines = collapseLineRanges(bEntry.lines);
        }
      }
      // Step 3b: selected_line_count from the injected line ranges (or whole-file total).
      for (const entry of keptEntries) {
        if (Array.isArray(entry.lines) && entry.lines.length) {
          // entry.lines is already disjoint+sorted (collapseLineRanges, server.js), so summing the
          // spans does NOT double-count overlaps (the merge happens upstream); each [a,b] is inclusive
          // → b-a+1 lines.
          entry.selected_line_count = entry.lines.reduce((n, [a, b]) => n + (b - a + 1), 0);
        } else {
          entry.selected_line_count = entry.total_line_count ?? null;  // whole-file carry
        }
      }
      // Step 3c: serialize bucket_snapshot AFTER the kept-identity loop lazily filled
      // canonical_path/whole_bytes on kept-matched entries (those must be in the JSON).
      bucketSnapshot = JSON.stringify({ v: 1, ctp_version: ctpVersion, root: watcher.cwd || null,
        total_candidates: snapshotPaths.length, paths: snapshotPaths });

      const allPathTokens = bd.paths.reduce((a, p) => a + (p.tokens || 0), 0);
      const discarded_tokens = Math.max(0, allPathTokens - kept_tokens);

      const s = watcher.getStatus();
      const ctp = watcher._ctp || undefined;
      const summary_tokens = Math.round(charsToTokens(redSummary, ctp || { ascii: 3.0, cjk: 1.0 }));
      const bDefault = s.rateLamp?.B_default ?? s.B;
      const previousStats = { b_full: s.B, b_default: bDefault, g: s.g, mf: s.mf, br_exit: s.br,
        pp_exit: computePp(s.x, s.dhat), turns: watcher._turnSeq, total_l: s.L,
        dead: watcher._bRebuild.dead, session_floor: watcher._warmupCeiling || watcher._bRebuild.dead,
        residual: Math.max(0, s.L - s.B) };
      // preparedStats: gate parameters computed with kept_tokens as B basis (selected bucket).
      // Contrast with previousStats (full B) for post-hoc analysis of keep/discard decisions.
      // bKept uses _warmupCeiling (= totalStock at segment anchor = dead + session-specific overhead
      // like skill_listing, deferred tools, agent listing). This is a better predictor of the next
      // segment's actual baseline than dead alone, which misses ~9k of always-present session floor.
      const dead = watcher._bRebuild.dead;
      const sessionFloor = watcher._warmupCeiling || dead;
      const bKept = kept_tokens > 0 ? kept_tokens + sessionFloor : null;
      const preparedStats = bKept && s.cRatio > 0 ? (() => {
        const gKept = s.g;
        const dhatKept = nucleus(s.cRatio, gKept, bKept);
        const mfKept = computeMovableFrac(s.cRatio, bKept, gKept);
        const xKept = s.L / bKept;
        const brKept = (dhatKept > 0 && Number.isFinite(mfKept)) ? computeBr(xKept, dhatKept, mfKept) : null;
        const ppKept = computePp(xKept, dhatKept);
        return { b_kept: bKept, dead, session_floor: sessionFloor, g: gKept, mf: mfKept, br: brKept, pp: ppKept, dhat: dhatKept, x: xKept };
      })() : null;
      const searchTerms = [cjkBigrams(redSummary), redNext ? cjkBigrams(redNext) : ''].filter(Boolean).join(' ');

      const keptSkills = Array.isArray(skills_to_keep) ? [...new Set(skills_to_keep.filter(s => typeof s === 'string' && s.length > 0))] : [];
      const pathsPayload = JSON.stringify(keptSkills.length ? { paths: keptEntries, skills: keptSkills } : keptEntries);

      // If existingToken provided, UPDATE in place (idempotent re-issue); otherwise INSERT with retry.
      let load_token = null;
      // Step 3d: whether we must mint a fresh token via the insert path (default: no existingToken).
      let mustInsert = !(typeof existingToken === 'string' && existingToken.length > 0);
      if (!mustInsert) {
        const updated = resolveStore().updateHandoff(existingToken, {
          pathsToKeep: pathsPayload, summary: redSummary, nextTask: redNext,
          summaryTokens: summary_tokens, keptTokens: kept_tokens, discardedTokens: discarded_tokens,
          preparedAtTurn: watcher._turnSeq, previousStats: JSON.stringify(previousStats),
          preparedStats: preparedStats ? JSON.stringify(preparedStats) : null, searchTerms, bucketSnapshot });
        if (updated) {
          load_token = existingToken;
        } else {
          // Step 3d: updateHandoff's WHERE now carries `AND delivered_at IS NULL`, so changes===0 has
          // TWO causes: (a) the token was already DELIVERED — its telemetry is immutable, so we mint a
          // fresh token via the insert path (never rewrite a consumed handoff at a different instant
          // than its recorded delivery); or (b) the token never existed — keep the actionable 404. One
          // cheap existence probe distinguishes them (same raw-_db pattern as stampLoadHashesIfPrimary).
          const exists = resolveStore().hasHandoff(existingToken);
          if (!exists) return res.status(404).json({ status: 'error', error: 'token_not_found', instruction: 'The provided load_token does not exist. Omit it to create a new handoff.' });
          mustInsert = true;   // delivered → fall through to insert (fresh token)
        }
      }
      if (mustInsert) {
        for (let attempt = 0; attempt < HANDOFF_TOKEN_MAX_RETRIES; attempt++) {
          const candidate = generateLoadToken(redSummary, redNext, (n) => randomInt(n));
          try {
            resolveStore().insertHandoff({ sessionId: currentSessionId, segment: watcher.getSegmentIndex(), loadToken: candidate,
              createdAt: Date.now(), pathsToKeep: pathsPayload, summary: redSummary, nextTask: redNext,
              summaryTokens: summary_tokens, keptTokens: kept_tokens, discardedTokens: discarded_tokens,
              preparedAtTurn: watcher._turnSeq, previousStats: JSON.stringify(previousStats),
              preparedStats: preparedStats ? JSON.stringify(preparedStats) : null, searchTerms,
              projectId: watcher._projectId || null, bucketSnapshot });
            load_token = candidate; break;
          } catch (e) { if (e.errcode !== 2067) throw e; }
        }
        if (!load_token) return res.status(500).json({ status: 'error', error: 'token_collision' });
      }

      const carry_over_pct = bDefault > 0 ? (kept_tokens / bDefault) * 100 : 0;
      const out = { status: 'ready', load_token, kept_paths: keptEntries.length, kept_tokens,
        discarded_tokens, summary_tokens, carry_over_pct: Math.round(carry_over_pct * 10) / 10,
        unknown_paths, invalid_paths,
        instruction: `Handoff prepared. Token: ${load_token}. Please /clear when ready.` };
      if (resolved_paths.length) out.resolved_paths = resolved_paths;
      res.json(out);
    } catch (e) { next(e); }
  });

  // Re-hash each kept path on THIS (consumer) machine and stamp content_hash_load. Gate:
  //   - claimedNow (the fresh primary claim), OR
  //   - this caller is the bound primary (h.deliveredSessionId === currentSessionId) AND hl is still
  //     absent (crash window: claim committed, hl never written — a same-session retry back-fills it).
  // A duplicate/second-session consumer is always excluded → never clobbers the primary's hl.
  // Fail-soft: an unreadable/oversized path gets hl=null (not-comparable); hashing never blocks content.
  // Uses resolveStore() (the test-injection seam) so the injected-store harness writes to the same
  // connection it later reads from; production falls through to the getStore() singleton unchanged.
  const stampLoadHashesIfPrimary = (h) => {
    if (!h) return;
    const isBoundPrimary = h.deliveredSessionId != null && h.deliveredSessionId === currentSessionId;
    if (!h.claimedNow && !isBoundPrimary) return;   // duplicate / session-less → never stamp
    try {
      const rawStored = resolveStore()._db.prepare('SELECT paths_to_keep FROM handoff WHERE handoff_id = ?').get(h.handoffId);
      if (!rawStored) return;
      let obj; try { obj = JSON.parse(rawStored.paths_to_keep); } catch { obj = null; }
      const entries = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.paths) ? obj.paths : null);
      if (!entries) return;
      // Idempotency: on a non-fresh retry, only stamp if hl is genuinely still missing. `hl===null`
      // (a prior stamp that resolved to not-comparable) counts as PRESENT — the key exists — so we do
      // not re-hash a file that was legitimately unreadable at primary-claim time.
      const hlMissing = entries.some(e => e && typeof e.path === 'string' && !('hl' in e));
      if (!h.claimedNow && !hlMissing) return;
      for (const e of entries) {
        if (!e || typeof e.path !== 'string') continue;
        const abs = resolve(watcher.cwd || process.cwd(), e.path);
        e.hl = hashFileContent(abs);   // sha256 hex or null (over-cap/special/missing)
      }
      resolveStore().stampContentHashLoad(h.handoffId, JSON.stringify(obj));
    } catch (e) { if (process.env.SW_DEBUG) console.error('[content_hash_load]', e.message); }
  };

  app.get('/api/handoff/load', (req, res, next) => {
    try {
      const { load_token, query, query_mode } = req.query;

      // Path 1: explicit token → stamp + return
      if (load_token) {
        const h = resolveStore().loadHandoffByToken(String(load_token), { sessionId: currentSessionId, loaderVersion: PLUGIN_VERSION, consumerSegment: watcher.getSegmentIndex() });
        if (!h) return res.json({ found: false });
        stampLoadHashesIfPrimary(h);
        return res.json(formatHandoffFull(h));   // formatHandoffFull re-reads/derives the response; projects entries
      }

      // Path 3: query/search → never stamps
      if (query) {
        if (!resolveStore().ftsAvailable) return res.json({ status: 'error', error: 'search_unavailable' });
        let results;
        try { results = resolveStore().searchHandoff(buildFtsMatch(String(query), query_mode === 'advanced' ? 'advanced' : 'plain'), { projectId: watcher._projectId }); }
        catch { return res.json({ status: 'error', error: 'invalid_query' }); }
        if (!results.length) return res.json({ found: false });
        return res.json({ found: true, mode: 'search',
          results: results.map(r => ({ load_token: r.loadToken, created_at: r.createdAt, next_task: r.nextTask, summary_preview: r.summaryPreview })),
          instruction: 'Multiple matches. Call load_handoff with the desired load_token for the full package.' });
      }

      // Path 2: auto-match (no params) — project-scoped with ambiguity detection
      if (!watcher._projectId) return res.json({ found: false });
      const ttlMs = HANDOFF_HOOK_TTL_DAYS * 24 * 3600 * 1000;
      const { rows, ambiguous } = resolveStore().loadHandoffByProject(watcher._projectId, currentSessionId, { ttlMs });
      if (rows.length === 0) return res.json({ found: false });
      if (ambiguous) {
        return res.json({ found: false, ambiguous: true,
          candidates: rows.map(r => ({ load_token: r.loadToken, created_at: r.createdAt, next_task_preview: r.nextTask ? r.nextTask.slice(0, HANDOFF_HOOK_TASK_PREVIEW_CHARS) : null })) });
      }
      // Single unambiguous result — stamp and return full
      const h = resolveStore().loadHandoffByToken(rows[0].loadToken, { sessionId: currentSessionId, loaderVersion: PLUGIN_VERSION, consumerSegment: watcher.getSegmentIndex() });
      if (!h) return res.json({ found: false });
      stampLoadHashesIfPrimary(h);
      return res.json(formatHandoffFull(h));
    } catch (e) { next(e); }
  });


  // §4 Pricing API — priority: saved > CLI > model_default
  const cliRatioAtStartup = watcher.ratioOverride; // capture CLI value at construction time

  const buildPricingResponse = () => {
    const model = watcher._segmentModel || '';
    const saved = loadPricingOverride(model);
    const modelRatio = cRatioFor(model);

    let effectiveRatio, source, effectiveRead = null, effectiveWrite = null;
    if (saved) {
      effectiveRatio = saved.ratio; source = 'saved';
      effectiveRead = saved.readPrice; effectiveWrite = saved.writePrice;

      // Preset drift detection (spec §10.3): if presetId saved, check prices still match
      if (saved.presetId) {
        const preset = MODEL_PRICING_PRESETS.find(p => p.id === saved.presetId);
        if (preset && preset.readPrice === saved.readPrice && preset.writePrice === saved.writePrice) {
          source = 'preset';
        }
        // else: prices drifted or preset removed — source stays 'saved'
      }
    } else if (cliRatioAtStartup != null) {
      effectiveRatio = cliRatioAtStartup; source = 'cli';
    } else {
      effectiveRatio = modelRatio; source = 'model_default';
    }

    return {
      effective: { ratio: effectiveRatio, readToWrite: 1 / effectiveRatio, source, readPrice: effectiveRead, writePrice: effectiveWrite },
      saved: saved || null,
      modelDefault: { model, ratio: modelRatio, readPrice: null, writePrice: null },
      presets: MODEL_PRICING_PRESETS,
    };
  };

  const applyEffectiveRatio = () => {
    const model = watcher._segmentModel || '';
    const saved = loadPricingOverride(model);
    watcher.ratioOverride = saved ? saved.ratio : cliRatioAtStartup;
    watcher._historyCache = null;
  };

  // Apply saved pricing at startup (persisted override must take effect without POST)
  applyEffectiveRatio();

  app.get('/api/pricing', (req, res) => { res.json(buildPricingResponse()); });

  // Fix #4: split validation (→400) from I/O errors (→next/500). Previously `catch (e) { if (e.message) → 400 }`
  // sent ALL errors as 400 since every Error has .message. Now validation is its own try/catch, I/O errors
  // propagate to the terminal error boundary via next(e).
  app.post('/api/pricing', (req, res, next) => {
    try {
      const { readPrice, writePrice } = req.body || {};
      validatePricingInput({ readPrice, writePrice });
    } catch (e) {
      return res.status(400).json({ error: 'invalid_input', message: e.message });
    }
    try {
      const { readPrice, writePrice, presetId } = req.body || {};
      // Sanitize presetId: must be null or a short string
      const safePresetId = (typeof presetId === 'string' && presetId.length > 0 && presetId.length <= 80)
        ? presetId : null;
      const model = watcher._segmentModel || '';
      if (!model) return res.status(409).json({ error: 'no_model', message: 'Model not yet detected; retry after first API call' });  // #9: guard empty model key
      savePricingOverride(model, { readPrice, writePrice, presetId: safePresetId });
      applyEffectiveRatio();
      res.json(buildPricingResponse());
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/pricing', (req, res) => {
    const model = watcher._segmentModel || '';
    if (!model) return res.status(409).json({ error: 'no_model', message: 'Model not yet detected; retry after first API call' });
    deletePricingOverride(model);
    applyEffectiveRatio();
    res.json(buildPricingResponse());
  });

  // v2.2-C5a (step 4): debug endpoint — loopback/SW_DEBUG gated (A22). Exposes live ledger + counters.
  // Reject with 403 unless req.socket.remoteAddress is loopback (127.0.0.1/::1) OR SW_DEBUG is set.
  app.get('/api/debug/rate-lamp/:sid', (req, res) => {
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback && !process.env.SW_DEBUG) {
      res.status(403).json({ error: 'forbidden', reason: 'non-loopback without SW_DEBUG' });
      return;
    }
    const sid = req.params.sid;
    const ledger = getLiveLedger(sid);
    const counters = getDebugCounters();
    const sizes = {
      recentStopEvents: (ledger?.recentStopEvents || []).length,
    };
    res.json({ ledger, counters, sizes, enospcPaused: isEnospcPaused(sid) });
  });

  app.get('/', (req, res) => res.sendFile(join(publicDir, 'dashboard.html')));
  app.get('/dashboard', (req, res) => res.sendFile(join(publicDir, 'dashboard.html')));
  app.use(express.static(publicDir, {
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
  }));

  // Terminal error boundary (Global Constraints / round-2 gemini 一.2): the server is a long-lived
  // daemon — one bad request (a route's next(err) or a synchronous throw Express catches for us) must
  // return an HTTP error, NEVER take the process down. Covers every /api/* route at one place; does not
  // fire on success paths, so existing behavior is unchanged. round-8 gemini#3: HONOR the framework's
  // status code when it set one — express.json throws a PayloadTooLargeError with err.status===413 on an
  // over-4kb body, other body-parser errors carry 400. Flattening all of these to 500 would lose the
  // network-layer semantics (a 413 misread as a server-code bug). Still never crashes (this middleware
  // always responds); it just reports the accurate code.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (process.env.SW_DEBUG) console.error('[route error]', err);
    if (res.headersSent) return next(err); // an SSE/streamed response already committed a status — don't double-send
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: status === 413 ? 'payload_too_large' : status === 400 ? 'bad_request' : 'internal' });
  });

  // Poll loop: emit SSE only on new data.
  // v2.2-C5b: adaptive keepalive timer (implementation A — time-stamp gate + fixed timer).
  // Uses performance.now() (monotonic) — NEVER Date.now() (sleep/lid-close jumps).
  let pollTimer = null;
  // Initialize to -Infinity so the first poll tick always runs (the gate checks
  // `now - lastAdvanceMono < IDLE_HEARTBEAT_MS` — with -Infinity the diff is always large).
  let lastAdvanceMono = -Infinity;
  let lastSnapshotMono = -Infinity; // V3-D3: ensures first changed-tick always writes
  // Test-injection seam (A20): _nowMono reads the module-level _globalTestClockMono (set via
  // _setServerTestClock) so tests can drive the idle gate deterministically.
  const _nowMono = () => _globalTestClockMono != null ? _globalTestClockMono : performance.now();

  function startPolling() {
    if (pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => {
      // Late transcript resolution: if the transcript file didn't exist at startup (race with CC
      // creating it), retry discovery each tick until found. Once resolved, never retries again.
      // Runs ABOVE the idle gate — the one-readdir cost is negligible and only fires while path=null.
      if (!watcher.path && projectsRoot && currentSessionId) {
        const found = resolveBySessionId(projectsRoot, currentSessionId);
        if (found) {
          watcher.switchTranscript(found);
          // Update state file so statusline sees the resolved path
          try {
            const port = server.address()?.port;
            if (port) writeFileSync(join(effectiveStateDir, `${safeSessionId(currentSessionId)}.json`), JSON.stringify({
              port, pid: process.pid, clientPid: process.ppid,
              transcriptPath: found, sessionId: currentSessionId, startedAt: startMs,
            }));
          } catch {}
          if (process.env.SW_DEBUG) console.error('[poll] late transcript resolution:', found);
        }
      }
      // v2.2-C5b adaptive idle gate: if the last advance was recent AND no SSE clients need push,
      // skip this tick (no redundant work). When SSE clients are connected, always run (they need data).
      const now = _nowMono();
      if (sseClients.size === 0 && (now - lastAdvanceMono) < IDLE_HEARTBEAT_MS) {
        return; // idle gate: skip tick
      }
      // Poll-loop error boundary (final-review Important #1): symmetric to the terminal Express
      // error boundary above — the server is a long-lived daemon, so a transient throw here (a bad
      // watcher.poll() frame, or advanceRateLampToCurrent → saveRateLampState → writeJsonAtomic
      // RE-THROWING a disk error like ENOSPC/EACCES/ENOTDIR) must NEVER kill the process. The route
      // path has Express's boundary; this once-per-second timer is the symmetric hole with none.
      // Mirror the flushAll per-iteration guard: log under SW_DEBUG, swallow otherwise; next poll
      // proceeds and the last on-disk checkpoint survives.
      try {
        const { changed } = watcher.poll();
        // Record advance timestamp (monotonic) for the idle gate BEFORE the rate-lamp advance,
        // so that a throwing advance still marks this tick as "recent work" (prevents infinite
        // high-frequency retries of a persistently failing advance).
        lastAdvanceMono = _nowMono();
        // v2.1 PR2 SHADOW: advance the canonical fullCarry ledger via the in-memory single writer.
        // No local load-modify-save (round-2 GPT#10 race). Manager checkpoints to disk itself.
        const { ledger } = advanceRateLampToCurrent(watcher, currentSessionId, { forcePoll: false });
        if (process.env.SW_DEBUG && ledger) console.error('[rate-lamp shadow]', JSON.stringify({ billProgress: ledger.billProgress, cycles: ledger.billCycleCount, paused: ledger.pausedReason, applied: ledger.lastAppliedFoldedCallSeq }));
        if (sseClients.size > 0 && !_replayController) {
          const tick = JSON.stringify({ type: 'tick', uptime: watcher._uptimeSec() });
          for (const c of sseClients) { try { c.write(`data: ${tick}\n\n`); } catch { sseClients.delete(c); } }
        }
        if (changed) for (const c of sseClients) { try { c.write(`data: ${JSON.stringify({ type: 'scan' })}\n\n`); } catch { sseClients.delete(c); } }
        // v3 (spec section 6.7): profile snapshot for GC archival — throttled to once per 30s
        // (V3-D3). The snapshot only needs to be current at session end; 30s staleness on crash
        // is acceptable (GC archival runs days later).
        if (changed) {
          const now = _nowMono();
          if (now - lastSnapshotMono >= SNAPSHOT_THROTTLE_MS) {
            lastSnapshotMono = now;
            try {
              const snap = watcher.getTerminalSnapshot();
              resolveStore().saveBatch(currentSessionId, [['profile_snapshot', snap]], { model: snap.model });
            } catch (e) { if (process.env.SW_DEBUG) console.error('[profile_snapshot]', e.message); }
          }
        }
        // Idle auto-shutdown: no HTTP requests AND no SSE clients for IDLE_SHUTDOWN_MS → exit
        if (onIdleShutdown && shouldIdleShutdown({ sseClientsSize: sseClients.size, lastRequestMono, now: performance.now() })) {
          onIdleShutdown();
        }
      } catch (e) {
        if (process.env.SW_DEBUG) console.error('[poll]', e);
      }
    }, pollIntervalMs);
    pollTimer.unref?.();
  }
  // v2.2-C5b SSE ping with dead-client GC: a failed write means the client is dead → delete it.
  const pingTimer = setInterval(() => {
    for (const c of sseClients) {
      try { c.write(': ping\n\n'); } catch { sseClients.delete(c); }
    }
  }, 15000);
  pingTimer.unref?.();

  // --- Session rotation (in-process architecture) ---
  let currentSessionId = sessionId;
  const effectiveStateDir = stateDir || PORT_DIR;

  function doRotation(newSessionId, transcriptPath) {
    if (newSessionId === currentSessionId) return { ok: true, noop: true };

    // Resolve transcript (NO side effects yet)
    let newPath = transcriptPath || null;
    if (!newPath && projectsRoot) {
      newPath = resolveBySessionId(projectsRoot, newSessionId);
    }
    if (!newPath) return { ok: false, error: 'transcript_not_found' };

    // Point of no return: archive current segment
    try {
      archiveCurrentSegment(watcher);
    } catch (e) {
      if (process.env.SW_DEBUG) console.error('[doRotation archive]', e.message);
    }

    // Switch watcher to new transcript
    watcher.switchTranscript(newPath);
    lastSnapshotMono = -Infinity; // V3-D3: new session gets an immediate snapshot on first changed-tick

    // Update ALL identity state
    const oldSessionId = currentSessionId;
    currentSessionId = newSessionId;
    watcher._sessionId = newSessionId;

    // State file: write-new-then-delete-old (zero-downtime)
    const port = server.address()?.port;
    const newStateFile = join(effectiveStateDir, `${safeSessionId(newSessionId)}.json`);
    const oldStateFile = join(effectiveStateDir, `${safeSessionId(oldSessionId)}.json`);
    let warning = undefined;
    try {
      mkdirSync(effectiveStateDir, { recursive: true });
      writeFileSync(newStateFile, JSON.stringify({
        port, pid: process.pid, clientPid: process.ppid,
        transcriptPath: newPath, sessionId: newSessionId, startedAt: startMs,
      }));
      if (oldStateFile !== newStateFile) {
        try { unlinkSync(oldStateFile); } catch {}
      }
    } catch (e) {
      warning = 'state_file_write_failed';
      if (process.env.SW_DEBUG) console.error('[doRotation state-file]', e.message);
    }

    const url = port ? `http://127.0.0.1:${port}` : null;
    const result = { ok: true, old_session_id: oldSessionId, new_session_id: newSessionId, url };
    if (warning) result.warning = warning;
    return result;
  }

  app.post('/api/rotate', express.json(), (req, res) => {
    const { session_id, transcript_path } = req.body || {};
    if (!session_id) return res.status(400).json({ ok: false, error: 'missing_session_id' });
    const result = doRotation(session_id, transcript_path);
    res.json(result);
  });

  // ── Startup compensating telemetry sweep (Task 10) ──────────────────────────
  // Once per process start, DEFERRED (setTimeout) + .unref()'d so it never blocks startup nor keeps the
  // process alive. The genuine chunking + real budget live INSIDE backfillPendingTelemetry (it awaits
  // setImmediate between sessions and enforces a performance.now() deadline); server.js just schedules it.
  // The honest guarantee is "TXN1 durability is never blocked," not "non-blocking." NOT called from the
  // migration path or the poll loop. Wires carry-sweep's replaySessionTelemetry HERE (server.js is the
  // composition root — this is what keeps store.js free of the fold/watcher graph). resolveStore() is used
  // for BOTH the backfill call AND the injected replay's store so an injected-store instance
  // (bootSecondConsumer) sweeps its OWN db, not the global singleton. excludeSessionIds is REQUIRED: a
  // running process must never replay another process's still-live session (its transcript is still
  // growing) and prematurely archive its tail. The 250ms defer lands after listen()→initStore(), so
  // resolveStore()→getStore() is initialized by the time the timer fires.
  let sweepTimer = null;
  if (!disableTelemetrySweep) {
    sweepTimer = setTimeout(() => {
      // Wrap the SYNCHRONOUS resolveStore() in the promise chain too: getStore() throws if the store is
      // not yet initialized, and a throw escaping this timer callback would be an uncaughtException (no
      // Express boundary covers a bare setTimeout). Threading it through Promise.resolve().then() turns
      // any such throw into a rejection the .catch() below swallows — the daemon-never-crashes invariant.
      Promise.resolve()
        .then(() => resolveStore().backfillPendingTelemetry({
          resolveTranscript: (sid) => resolveBySessionId(projectsRoot, sid),
          replaySession: (sid, txPath) => replaySessionTelemetry(sid, txPath, { store: resolveStore() }),
          excludeSessionIds: currentSessionId,   // don't sweep the still-live session (Set-or-string accepted)
          limit: 200, budgetMs: 1500,
        }))
        .then((s) => { if (process.env.SW_DEBUG) console.error('[telemetry-sweep]', JSON.stringify(s)); })  // log summary incl. aborted (no silent truncation)
        .catch((e) => { if (process.env.SW_DEBUG) console.error('[telemetry-sweep]', e.message); });
    }, 250);
    sweepTimer.unref();   // never keep the process alive for the sweep
  }

  // #7: expose startMs as `startedAt` so the CLI writes the SAME timestamp to the state file that
  // /api/health reports — one source of truth for the identity handshake (health===stateFile).
  return { app, server, sseClients, startPolling, startedAt: startMs, applyEffectiveRatio, stopTimers: () => { clearInterval(pollTimer); clearInterval(pingTimer); if (sweepTimer) clearTimeout(sweepTimer); }, doRotation, currentSessionId: () => currentSessionId };
}

// v2.2-C5b test-injection seams (A20): allow tests to inspect SSE client count and override the
// monotonic clock. Each test using them MUST t.after() reset. These are MODULE-LEVEL utilities
// that operate on a server handle returned by createServer.
export function _inspectSseClientsForTest(serverHandle) {
  return serverHandle.sseClients.size;
}

// _setServerTestClock: set a fixed monotonic timestamp for the idle gate. Pass null to reset.
// Module-scoped — the _nowMono closure inside createServer reads _globalTestClockMono on each tick.
export function _setServerTestClock(nowMono) {
  _globalTestClockMono = nowMono;
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
if (typeof __CLI_BUNDLE__ === 'undefined' && process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
  // Bind state to the transcript basename — this is the PERSISTENT id the statusline
  // queries (CC sends different session_ids to the hook vs. the statusline). The
  // --session value (hook's per-restart id) is stored as hookSessionId for the
  // sessionMismatch guard and startWatcher's fallback scan.
  const sessionId = jsonlPath.endsWith('.jsonl') ? basename(jsonlPath).replace(/\.jsonl$/, '') : (session || 'default');
  const hookSessionId = session || null;
  const projectId = resolveProjectKey({ claudeProjectDir: process.env.CLAUDE_PROJECT_DIR, cwd: project }) || process.env.CLAUDE_PROJECT_ID || null;
  const watcher = new SessionWatcher(jsonlPath, lbase, { ratioOverride, cwd: project || null, isIgnored: project ? loadIsIgnored(project) : null, sessionId, projectId });

  const STATE_FILE = stateFileFor(sessionId);
  let shutdown; // forward-declared for onIdleShutdown reference
  const { server, startPolling, sseClients, stopTimers, startedAt, applyEffectiveRatio } = createServer({ watcher, pollIntervalMs: 1000, sessionId, hookSessionId, onIdleShutdown: () => shutdown() });
  server.listen(wantPort, '127.0.0.1', () => {   // loopback only — never expose local session data
    const port = server.address().port;
    mkdirSync(PORT_DIR, { recursive: true });
    try { initStore(); } catch (e) { console.error('[session-watcher] fatal: store init failed —', e.message); process.exit(1); }
    cleanupLegacyJson(defaultBaseDir());
    applyEffectiveRatio(); // re-apply now that store is ready
    // #7: write createServer's startedAt (NOT a fresh Date.now()) so the state file's identity tokens
    // (pid, startedAt) are the exact values /api/health reports — the handshake stopWatcher relies on.
    // D5 (spec §5.2, invariant #20): write ATOMICALLY with wx (O_CREAT|O_EXCL). startWatcher owns the
    // PRIMARY single-instance guard (it health-probes the recorded port and reuses without respawning);
    // this closes the residual window of a bare relaunch for the SAME sid that bypassed startWatcher —
    // the loser hits EEXIST and exits rather than clobbering a live owner's port/pid.
    try {
      writeStateFileExclusive(STATE_FILE, { port, pid: process.pid, transcriptPath: jsonlPath, sessionId, hookSessionId: session, startedAt });
    } catch (e) {
      if (e.code === 'EEXIST') {
        console.error(
          `session-watcher: ${sessionId} already owned — refusing to start. If no live owner (e.g. a prior crash left a stale file), restart via the normal startWatcher entry (it health-probes and auto-clears a dead-port state file), or manually delete ${STATE_FILE}.`,
        );
        process.exit(1);
      } // B15: actionable, not a dead-end. No probe logic here — liveness truth stays in startWatcher (SSOT); see R5.
      throw e;
    }
    console.log(`PORT=${port}`);
    sweepStaleState({ portDir: PORT_DIR });
    sweepStalePortFiles(PORT_DIR);
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

  shutdown = function shutdown() {
    stopTimers();
    for (const c of sseClients) { try { c.end(); } catch {} }
    try { flushAll(); } catch {}  // persist in-memory ledgers while store is still open
    closeStoreGlobal();
    try { unlinkSync(STATE_FILE); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Process-level last-resort boundary (final-review Important #1, belt-and-suspenders): keep the
  // long-lived daemon alive across any throw/rejection the poll-loop try/catch or a route boundary
  // didn't catch — do NOT exit. Registered ONLY here in the bootstrap branch (same rationale as the
  // signal handlers above): an embedding test/host that imports createServer must not inherit a
  // process-level handler that silently swallows ITS crashes. Log under SW_DEBUG, otherwise swallow.
  process.on('uncaughtException', (e) => { if (process.env.SW_DEBUG) console.error('[uncaught]', e); });
  process.on('unhandledRejection', (e) => { if (process.env.SW_DEBUG) console.error('[unhandled]', e); });
}
