// node:sqlite (DatabaseSync) requires Node >=22.16.0.
const [_major, _minor] = process.versions.node.split('.').map(Number);
if (_major < 22 || (_major === 22 && _minor < 16)) { console.error('Session Watcher requires Node >=22.16.0 (node:sqlite)'); process.exit(1); }
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, extname, isAbsolute } from 'node:path';
import { readdirSync, statSync, readFileSync, mkdirSync, unlinkSync, openSync, writeSync, closeSync, writeFileSync, appendFileSync, rmSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { SessionWatcher } from './lib/session-watcher.js';
import { createResourcePolicy } from './lib/resource-policy.js';
import { createResourceEnrichment } from './lib/resource-enrichment.js';
import { createMeasurementEngine } from './lib/measurement/engine.js';
import { createClaudeCodeSourceDriver } from './lib/harness/claude-code/source-driver.js';
import { createClaudeCodeMeasurementProjection } from './lib/harness/claude-code/measurement-projection.js';
import {
  interpretClaudeCodeToolUse, completeClaudeCodeToolResult,
  interpretClaudeCodeSkillPayload, interpretClaudeCodeTaskNotification,
} from './lib/harness/claude-code/native-tools.js';
import { resolveClaudeCodeCacheTtl } from './lib/harness/claude-code/cache-ttl.js';
import { advanceRateLampToCurrent, mergeLedgerIntoStatus, enrichStatusLandmarks, getLiveLedger, flushAll, getDebugCounters, isEnospcPaused } from './lib/rate-lamp-manager.js';
import { stateKeyForStatus } from './lib/rate-lamp-store.js';
import { IDLE_HEARTBEAT_MS, DEFAULT_CTP } from './lib/constants.js';
import { resolveProjectKey } from './lib/project-key.js';
import { initStore, closeStoreGlobal, getStore } from './lib/store.js';
import { cleanupLegacyJson, defaultBaseDir } from './lib/legacy-cleanup.js';
import { modelPolicyFor } from './lib/model-policy.js';
import { loadPricingOverride, savePricingOverride, deletePricingOverride, validatePricingInput } from './lib/pricing-store.js';
import { sweepStaleState, sweepStalePortFiles, sweepStaleTurnNotes } from './lib/state-reaper.js';
import {
  formatLine,
} from './lib/statusline-format.js';
import { loadIsIgnored } from './gitignore-loader.js';
import { replaySessionTelemetry } from './lib/carry-sweep.js';
import { computePp } from './lib/bill-regret.js';
import { createHandoffComposition } from './lib/handoff.js';
import { PLUGIN_VERSION } from './lib/version.js';
import { parseTurnAddress } from './lib/turn.js';
import { HISTORY_EXCERPT_CHARS } from './lib/turn-history-budget.js';
import { fromHandoff, forLoadedHandoff } from './lib/lineage.js';
import {
  NO_HANDOFF_LOADED, STALE_CURSOR_MESSAGE, SCOPE_ABSENT_MESSAGE,
  withPageRecovery, withSearchRecovery, withLocateRecovery,
} from './lib/turn-tool-recovery.js';
import { buildTurnPage } from './lib/turn-page.js';
import { buildTurnBrowse, lineageHeadlines } from './lib/turn-browse.js';
import { searchTranscripts, locateRanges } from './lib/turn-query.js';
import { createClaudeCodeDialogueSource } from './lib/harness/claude-code/dialogue-source.js';
import { createClaudeCodeDialogueProjection } from './lib/harness/claude-code/history-turn-rules.js';
import { classifyToolPair } from './lib/harness/claude-code/native-tools.js';
import { SEARCH_HIT_RECOVERY } from './lib/harness/claude-code/turn-recovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// round-6 GPT#3b: sanitize a sessionId used as a filename segment. Defense-in-depth — a `/`, `\`,
// `..`, or NUL would let `${sessionId}.json` escape the state dir. Inlined from the deleted
// lib/atomic-store.js (previously shared; now only used here and lib/launcher.js, each inline).
export function safeSessionId(sessionId) {
  const s = String(sessionId ?? '');
  if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s) || s.includes('..')) return '__invalid_session__';
  return s;
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

// The `q` rule of both turn query routes: a present, non-blank literal of at most
// HISTORY_EXCERPT_CHARS UTF-16 characters. That cap is what makes a search hit's excerpt able to
// contain q whole, and locate answers to the same rule rather than a second one. Every rejection is
// 400 { error: 'invalid_query' } — a missing q is never read as match-all.
const isValidTurnQuery = (q) =>
  typeof q === 'string' && q.trim() !== '' && q.length <= HISTORY_EXCERPT_CHARS;

// ── Composition root ─────────────────────────────────────────────────────────
// The ONE place a shared `SessionWatcher` is built, and the only place the two worlds meet: the portable
// Engine and the concrete Claude Code Measurement Projection factory are wired here, so neither
// `lib/measurement/` nor `lib/session-watcher.js` names a Harness and `lib/harness/` names no application.
//
// Every composition creates exactly one Resource Policy and one Resource Enrichment. The Engine takes the
// policy's `resolve` (per-resource default selection) and `SessionWatcher` takes its `infer` (sibling
// inference) — one object, two roles, so a manual override and an inferred one share the same set. The CLI
// owner, the in-process MCP owner and each carry reconstruction all call this, so every one of them resolves
// selection through the same Resource Policy, against the project context its own caller supplies.
export function createWatcherComposition({
  sessionId = null,
  sourceLocator = null,
  projectId = null,
  projectRoot = null,
  stateDir = null,
  store,
  isIgnored = null,
  dialogueSource = null,
  // Absent an injected lifetime, the one this host process declared for itself. This factory is the only
  // place production reads the declaration, and every layer below receives the lifetime already bound into
  // the policy resolver.
  cacheTtl = resolveClaudeCodeCacheTtl(),
  now = () => Date.now(),
} = {}) {
  const resourcePolicy = createResourcePolicy({ projectRoot, isIgnored });
  const resourceEnrichment = createResourceEnrichment();
  return new SessionWatcher({
    sessionId,
    sourceLocator,
    projectId,
    projectRoot,
    // Derived once from the host's existing state directory. `SessionWatcher` has no state-directory
    // fallback, so a composition that forgot this cannot silently write Turn Notes into the real install.
    turnNotesRoot: join(stateDir || PORT_DIR, 'turn-notes'),
    resourcePolicy,
    resourceEnrichment,
    handoffComposition: createHandoffComposition(),
    loaderVersion: PLUGIN_VERSION,
    store,
    dialogueSource: dialogueSource || createClaudeCodeDialogueSource(),
    dialogueProjection: createClaudeCodeDialogueProjection({ sessionCwd: projectRoot || process.cwd() }),
    createEngine: createMeasurementEngine,
    // The Projection is rebuilt per `replace` and per `rotate`, so the factory takes the locator and the
    // effective model resolver the application owns rather than closing over either.
    createMeasurementProjection: (locator, resolveModelPolicy) => createClaudeCodeMeasurementProjection({
      cwd: projectRoot, projectRoot, sourceLocator: locator, resolveModelPolicy,
      interpretToolUse: interpretClaudeCodeToolUse,
      completeToolResult: completeClaudeCodeToolResult,
      interpretSkillPayload: interpretClaudeCodeSkillPayload,
      interpretTaskNotification: interpretClaudeCodeTaskNotification,
    }),
    // The C ratio is a function of the model AND the prompt-cache lifetime this host declared, and that
    // lifetime is one fact for the whole composition. Binding it here leaves the measured layers below
    // passing a model id and nothing else, so no cache lifetime enters their vocabulary.
    modelPolicyFor: (modelId) => modelPolicyFor(modelId, cacheTtl),
    now,
  });
}

// Factory: build an http.Server around an existing watcher (used by tests and CLI).
// Returns { app, server, sseClients, startPolling, stopTimers, turnService, turnReadService }. `server`
// is a real node:http.Server so callers do server.listen(0)/server.address()/server.close().
// `turnService` and `turnReadService` are exposed for in-process MCP reuse — index.js cannot reach a
// closure, and the turn tools deliberately have no HTTP route to fetch.
export function createServer({ watcher, pollIntervalMs = 1000, sessionId, hookSessionId = null, onIdleShutdown = null, onOwnerFatal = null, projectsRoot = null, projectRoot = null, projectId = null, stateDir = null, sourceLocator = null, ratioOverride = null, cacheTtl, publicDir = join(__dirname, 'public'), store = null, disableTelemetrySweep = false, turnPageBuilder: injectedTurnPageBuilder = buildTurnPage, dialogueSource: injectedDialogueSource = null, createSourceDriver = createClaudeCodeSourceDriver, resolveSourceLocator = resolveBySessionId }) {
  const app = express();
  const startMs = Date.now();
  const sseClients = new Set();
  const server = createHttpServer(app);
  // Store resolution (test-injection seam): production passes no `store` and every call site falls
  // through to the module-level `getStore()` singleton — identical to the pre-injection behavior.
  // Resolution is LAZY (per call site, not once here) for the seam's sake, not for boot order: every
  // caller that reaches this factory outside a test — index.js, the CLI entry below, and
  // lib/replay-server.js — calls initStore() first, so an eager `store || getStore()` would find the
  // singleton ready in production. It would not in a test that needs no store at all:
  // test/server.test.js and test/server.poll-loop.test.js boot the app with neither an injected store
  // nor initStore(), and an eager resolve would throw "Store not initialized" at construction instead
  // of only on the routes that actually read the store. Tests that need two
  // independent connections on the same DB file (bootSecondConsumer) inject their own openStore()
  // handle so the two app instances do NOT share the global singleton. Segment archival is inside the
  // seam: every watcher composition here is handed `resolveStore()`, so the application archives through
  // the same connection the server's own reads/writes use.
  const resolveStore = () => store || getStore();

  // ── Turn History composition ─────────────────────────────────────────────────
  // The one Claude Code Dialogue seam every history READ goes through: the Source Adapter interprets the
  // opaque locator, and the bound Dialogue Adapter carries this composition's fixed History Turn rule
  // order and resolves each paired tool line's `resourceKey`. `sessionCwd` is the base a relative tool
  // path resolves against where the row carries none of its own; it falls back the same way every other
  // path consumer here does, because a null base would key `lib/store.js` as `/lib/store.js`.
  //
  // Distinct from the pair inside the shared application: these serve the lineage-scoped read tools, which
  // open OTHER sessions' Sources, while the application's own pair serves this session's Turn Note capture.
  const dialogueSource = injectedDialogueSource || createClaudeCodeDialogueSource();
  const dialogueProjection = createClaudeCodeDialogueProjection({
    sessionCwd: projectRoot || process.cwd(),
  });
  // Search admits residual evidence only: a pair whose ground truth is the working tree is reachable
  // there at full length, so ADR 0004 keeps it out of the transcript corpus. The classifier consumes the
  // target the Adapter already resolved.
  const includeToolEvidence = (pair) => classifyToolPair(pair, DEFAULT_CTP) === 'residual';
  const history = { dialogueSource, dialogueProjection };

  // ── turnPageWire ─────────────────────────────────────────────────────────────
  // Maps buildTurnPage's internal { turnPage, nextBefore } to the wire shape. The cursor travels bare:
  // load injection, GET /api/turn/page and the turn_page MCP tool all call this, so all three are
  // byte-identical for one head and one persisted state.
  function turnPageWire({ turnPage, nextBefore }) {
    return {
      turn_page: turnPage,
      ...(nextBefore ? { next_before: nextBefore } : {}),
    };
  }

  // ── formatLoadedHandoff ──────────────────────────────────────────────────────
  // Enrich the delivered package with its lineage headlines and its turn page, or attach
  // turn_page_error on failure. Both projections sit inside the same try and share its error name, so a
  // fault in either drops both: the reply keeps the core handoff and carries neither.
  const formatLoadedHandoff = (core) => {
    try {
      const store = resolveStore();
      const sessions = fromHandoff({ store, handoffId: core.handoff_id });
      return {
        ...core,
        lineage: lineageHeadlines({ store, lineage: sessions }),
        ...turnPageWire(injectedTurnPageBuilder({ store, lineage: sessions, ...history })),
      };
    } catch (err) {
      if (process.env.SW_DEBUG) console.error('[turn_page_load]', err?.message || err);
      return { ...core, turn_page_error: 'turn_page_unavailable' };
    }
  };

  // activeWatcher: routes read from this. Normally === watcher; during replay of a
  // different transcript, may point to a temporary fully-processed watcher.
  let activeWatcher = watcher;

  // Idle auto-shutdown: track last HTTP request time (monotonic)
  let lastRequestMono = performance.now();
  app.use((req, res, next) => { lastRequestMono = performance.now(); next(); });

  // ── Owner identity, discovery, and Source acquisition ────────────────────────

  // Session identity and the state directory are declared here rather than beside the rotation function:
  // discovery, the poll tick and rotation all read them, and the synchronous bootstrap below runs before
  // any of those, so a later declaration would leave them in their temporal dead zone at bootstrap.
  let currentSessionId = sessionId;
  const effectiveStateDir = stateDir || PORT_DIR;

  // Poll-loop timers and the monotonic gates they read. v2.2-C5b: adaptive keepalive (implementation A —
  // time-stamp gate + fixed timer). Uses performance.now() (monotonic), NEVER Date.now() (sleep jumps).
  let pollTimer = null;
  // -Infinity so the first tick always runs: the gate checks `now - lastAdvanceMono < IDLE_HEARTBEAT_MS`.
  let lastAdvanceMono = -Infinity;
  let lastSnapshotMono = -Infinity;   // V3-D3: ensures the first changed tick always writes
  // Test-injection seam (A20): reads the module-level _globalTestClockMono (set via _setServerTestClock) so
  // tests drive the idle gate and the resolution schedule deterministically.
  const _nowMono = () => _globalTestClockMono != null ? _globalTestClockMono : performance.now();

  // Captured ONCE. `/api/health` and every discovery record read these same three values, which is what
  // makes the launcher's identity handshake (health.pid === discovery.pid, health.startedAt ===
  // discovery.startedAt) an equality rather than two independent clock reads that can disagree.
  const ownerMeta = { pid: process.pid, startedAt: startMs, clientPid: process.ppid };

  // The installed driver owns the locator published in discovery. Acquisition installs it after applying a
  // frame; rotation can install it while the Source is unavailable, and polling retries that same locator.
  let driver = null;
  // Acquisition retains a candidate until an advance yields a frame. While it is retained, the next attempt
  // retries its locator without scanning the directory again.
  let candidate = null;
  // Locator resolution starts immediately, then follows the capped RESOLVE_BACKOFF_MS schedule.
  const RESOLVE_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
  let resolveAttempts = 0;
  let nextResolveMono = -Infinity;

  // Each discovery path this owner SUCCESSFULLY published. Cleanup deletes only these, after the existing
  // pid check — deriving a target from `currentSessionId` would delete a path this owner never wrote, and
  // after a rotation whose publication failed that is a live sibling's record.
  const publishedDiscoveryPaths = new Set();

  // The one discovery writer. It REPORTS rather than throws, because each ingress owns its own failure
  // policy: listen-time creation prevents startup, a deferred-install rewrite is silent, and a rotation
  // rewrite returns a warning. The record shape is exactly the six retained fields.
  function writeDiscovery(targetSessionId) {
    const path = join(effectiveStateDir, `${safeSessionId(targetSessionId)}.json`);
    try {
      mkdirSync(effectiveStateDir, { recursive: true });
      writeFileSync(path, JSON.stringify({
        port: server.address()?.port ?? null,
        pid: ownerMeta.pid,
        clientPid: ownerMeta.clientPid,
        // The resolved session locator: null while unresolved, the retained candidate's path while unreadable,
        // and the installed driver's path after acquisition.
        transcriptPath: driver?.sourceLocator ?? candidate?.sourceLocator ?? null,
        sessionId: targetSessionId,
        startedAt: ownerMeta.startedAt,
      }));
      publishedDiscoveryPaths.add(path);
      return { ok: true, path };
    } catch (error) {
      if (process.env.SW_DEBUG) console.error('[discovery]', error.message);
      return { ok: false, path, error };
    }
  }

  // A blocking failure after startup stops the poll timer and notifies the sink at most once. Rotation
  // shares this sink, so an owner cannot be left half-rotated with a live timer.
  let ownerFatalNotified = false;
  function failOwner(error) {
    if (ownerFatalNotified) return;
    ownerFatalNotified = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (onOwnerFatal) onOwnerFatal(error);
  }

  // The Projection cannot restore this line: reading process-global env is what its layering forbids, so it
  // emits an unconditional diagnostic instead and host wiring — which may read env — writes the baseline
  // stderr line for that code. Diagnostics are otherwise recorded and never added to a response.
  function recordDiagnostics(diagnostics) {
    if (!process.env.SW_DEBUG) return;
    for (const entry of diagnostics ?? []) {
      // The one line the baseline printed, restored verbatim — its own tag, its own wording, and no extra
      // argument. The Projection cannot print it: reading process-global env is what its layering forbids, so
      // it emits the diagnostic and host wiring, which may read env, writes the line.
      if (entry?.code === 'multiple_load_tokens') {
        console.error('[telemetry] multiple load_handoff tokens in one step; keeping first');
        continue;
      }
      // Every OTHER code needs a consumer too, or the Interface's "emits an internal diagnostic" describes
      // something nobody can observe. One debug-gated sink, tagged by the diagnostic's own scope, so a
      // telemetry join failure or an unusable model policy is visible where baseline's own logs were.
      console.error(`[${entry?.scope ?? 'diagnostic'}] ${entry?.code ?? 'unknown'}: ${entry?.message ?? ''}`);
    }
  }

  // Apply one frame and route its result through the same changed postprocessing an installed-driver tick
  // uses. Returns the application result so a caller can decide on `changed`.
  function applyFrame(frame) {
    const result = watcher.applyHarnessFrame(frame);
    recordDiagnostics(result.diagnostics);
    return result;
  }

  // #7: /api/health doubles as an IDENTITY proof for the MCP launcher. It returns pid + startedAt from the
  // immutable owner metadata so stopWatcher can confirm the process listening on this port is genuinely OUR
  // server before it ever SIGTERMs a pid (guards against a recycled/foreign pid). The discovery record
  // carries these exact values, so health.startedAt === discovery.startedAt for a live owner.
  // Stays fast, unauthenticated, loopback-only, and non-throwing.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, port: server.address()?.port ?? null, uptime: Math.floor((Date.now() - startMs) / 1000), pid: ownerMeta.pid, startedAt: ownerMeta.startedAt });
  });

  // Map the application's opaque sourceLocator to the retained transcriptPath wire field.
  function statusWire(source) {
    const { sourceLocator, ...rest } = source.getStatus();
    return { ...rest, transcriptPath: sourceLocator ?? null };
  }

  app.get('/api/status', (req, res, next) => {
    try {
      const status = statusWire(activeWatcher);
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
    let h = activeWatcher.getHistory();
    if (req.query.since) { const t = Date.parse(req.query.since); if (!Number.isNaN(t)) h = h.filter(p => Date.parse(p.ts) >= t); }
    res.json(h);
  });

  app.get('/api/buckets', (req, res, next) => {
    try {
      const includeSymbols = req.query.symbols === '1';
      const bd = activeWatcher.getBucketData({ includeSymbols });
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

  // ── User overrides (§6: bDefault override) ────────────────────────────────
  app.post('/api/user-overrides', (req, res) => {
    // Gate: reject during replay mode (activeWatcher !== watcher)
    if (_replayController) {
      return res.status(409).json({ error: 'replay_active', message: 'Cannot modify overrides during replay' });
    }
    const { overrides } = req.body || {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return res.status(400).json({ error: 'invalid_body', message: 'Body must contain { overrides: { path: "include"|"exclude" } }' });
    }

    // Whole-set replacement through the named operation. The Engine owns the current epoch's override set and
    // reports each rejected entry structurally; this route is the only place those structures become the
    // baseline warning STRINGS, because the wording is a wire fact and the Engine has no wire.
    const replaced = watcher.replaceUserOverrides(overrides);
    const warnings = (replaced.warnings ?? []).map(w => (w.code === 'unknown_resource'
      ? `ignored: path "${w.resourceKey}" not in current bRebuild`
      : `ignored: invalid value "${w.value}" for path "${w.resourceKey}"`));

    // Broadcast SSE scan so dashboard refreshes
    if (sseClients.size > 0) {
      const msg = `data: ${JSON.stringify({ type: 'scan' })}\n\n`;
      for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
    }

    const response = statusWire(watcher);
    if (warnings.length > 0) response.warnings = warnings;
    res.json(response);
  });

  // ── Replay (post-v3: transcript replay for demo recording) ──────────────
  // Architecture: a fresh watcher with byte-limit valve runs the full production pipeline.
  // No re-derivation of metrics — getStatus/mergeLedger produce everything naturally.
  let _replayController = null;

  app.post('/api/replay/start', async (req, res) => {
    const { transcript, speed = 4 } = req.body || {};
    const replayPath = transcript || driver?.sourceLocator || null;
    if (!replayPath) return res.status(400).json({ error: 'no transcript available' });

    // Stop any existing replay
    if (_replayController) { _replayController.stop(); _replayController = null; }
    activeWatcher = watcher;

    try {
      const { indexTranscript, ReplayController } = await import('./lib/replay.js');
      const index = indexTranscript(replayPath);
      if (index.length === 0) return res.status(400).json({ error: 'no usage rows in transcript' });

      // A fresh application and its OWN source driver, isolated from the live pair: Transcript Playback
      // paces the driver with absolute line-end byte limits and never touches the live Source cursor.
      const replayWatcher = createWatcherComposition({
        sessionId: null, sourceLocator: replayPath, projectId, projectRoot,
        stateDir: effectiveStateDir, store: resolveStore(), isIgnored: null,
        // This owner's own declared lifetime: playback prices its cache writes the way the live pair beside
        // it does, so a replayed reading is comparable with a measured one.
        cacheTtl,
      });
      const replayDriver = createClaudeCodeSourceDriver({
        sourceLocator: replayPath, firstReadableTransition: 'replace',
      });
      activeWatcher = replayWatcher;

      _replayController = new ReplayController(replayWatcher, index, {
        driver: replayDriver,
        speed,
        onAdvance: () => {
          // Broadcast SSE scan + replay tick so dashboard fetches fresh data and shows replay state
          if (sseClients.size > 0) {
            const prog = _replayController?.progress;
            const tick = JSON.stringify({ type: 'tick', uptime: activeWatcher.getStatus().uptime, replay: prog ? { current: prog.current, total: prog.total, speed: prog.speed, paused: prog.paused } : undefined });
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

  // ── Handoff ──────────────────────────────────────────────────────────────────
  // The application owns preparation, search and delivery; these routes map its results to HTTP.

  // Identity and consistency failures keep their explicit HTTP status.
  const PREPARE_ERROR_STATUS = {
    stale_bucket_summary: 409,
    token_not_found: 404,
    token_collision: 500,
  };

  app.post('/api/handoff/prepare', (req, res, next) => {
    try {
      const {
        paths_to_keep = [], skills_to_keep, summary = '', next_task = null,
        observed_segment, load_token: existingToken,
      } = req.body || {};
      const out = watcher.prepareHandoff({
        pathsToKeep: paths_to_keep, skillsToKeep: skills_to_keep, summary, nextTask: next_task,
        observedSegment: observed_segment, loadToken: existingToken,
      });
      if (out.status === 'error') {
        return res.status(PREPARE_ERROR_STATUS[out.error] ?? 400).json(out);
      }
      res.json(out);
    } catch (e) { next(e); }
  });

  app.get('/api/handoff/load', async (req, res, next) => {
    try {
      const { load_token, query, query_mode } = req.query;

      // The `query` branch is a read-only search that never stamps; everything else is a delivery.
      if (!load_token && query) {
        return res.json(watcher.searchHandoffs({ query: String(query), queryMode: query_mode }));
      }

      const delivered = await watcher.deliverHandoff(
        load_token ? { loadToken: String(load_token) } : {});
      // Project delivery errors to the HTTP response's error and retryable fields.
      if (delivered.ok === false) {
        return res.status(503).json({ error: delivered.error, retryable: delivered.retryable === true });
      }
      if (!delivered.found) return res.json(delivered);
      return res.json(formatLoadedHandoff(delivered));
    } catch (e) { next(e); }
  });

  // ── Turn page REST route ──────────────────────────────────────────────────────

  // GET /api/turn/page — one page of history turns for an explicit lineage head.
  // `lineage_head` is the handoff_id that anchors the lineage; `before` is an optional boundary, either
  // an S{k} session label or an S{k}:{T} turn address.
  // The route does not read watcher._projectId: lineage scope comes from the handoff row's own project,
  // so an explicit head resolves the same way no matter which project asks for it.
  app.get('/api/turn/page', (req, res, next) => {
    try {
      const headId = Number(req.query.lineage_head);
      if (!Number.isInteger(headId) || headId <= 0) return res.status(404).json({ error: 'not_found' });
      // Lineage resolution is INSIDE this try, matching the load path where fromHandoff sits inside the
      // turn-page try and degrades to turn_page_error. A store failure while walking the parent chain and
      // one while building the page are the same turn-page projection failure, not an internal 500.
      // An unresolvable head is still 404 — that return is not a throw, so this catch never sees it.
      try {
        const lineage = fromHandoff({ store: resolveStore(), handoffId: headId });
        if (lineage.length === 0) return res.status(404).json({ error: 'not_found' });
        const result = injectedTurnPageBuilder({
          store: resolveStore(),
          lineage,
          before: req.query.before || null,
          ...history,
        });
        return res.json(turnPageWire(result));
      } catch (err) {
        if (err && err.code === 'not_found') return res.status(404).json({ error: 'not_found' });
        // 每条 turn 路由自己兜住 503 后，终端 error boundary 再也看不到这些抛出 —— 所以三条 catch
        // 各自接上它那条 SW_DEBUG 门控日志。只报成因：不带 q、页文本或转录路径，错误响应不夹带正文，
        // 日志也不是它的后门。
        if (process.env.SW_DEBUG) console.error('[turn_page]', err?.message || err);
        return res.status(503).json({ error: 'turn_page_unavailable', retryable: true });
      }
    } catch (e) { next(e); }
  });

  // GET /api/turn/search — exact literal search over the canonical transcripts of one lineage.
  // `q` is a literal, never a pattern; `scope` is an optional S{k}:{T} turn span. The response is always
  // sized by HISTORY_TOKEN_BUDGET, so a `budget` parameter is ignored rather than rejected.
  app.get('/api/turn/search', (req, res, next) => {
    try {
      const headId = Number(req.query.lineage_head);
      if (!Number.isInteger(headId) || headId <= 0) return res.status(404).json({ error: 'not_found' });
      // Lineage resolution is INSIDE this try, as on the page route: a store failure while walking the
      // parent chain leaves this route unable to answer — a 503 the caller may retry, not an internal
      // 500. Every 404 here is a `return`, never a throw, so widening the try cannot swallow one.
      try {
        const lineage = fromHandoff({ store: resolveStore(), handoffId: headId });
        if (lineage.length === 0) return res.status(404).json({ error: 'not_found' });

        if (!isValidTurnQuery(req.query.q)) return res.status(400).json({ error: 'invalid_query' });
        const scope = req.query.scope == null ? null : String(req.query.scope);
        if (scope !== null && parseTurnAddress(scope) === null) return res.status(400).json({ error: 'invalid_scope' });

        return res.json(searchTranscripts({
          store: resolveStore(), lineage, q: req.query.q, scope, ...history, includeToolEvidence,
        }));
      } catch (err) {
        if (err && err.code === 'scope_not_found') return res.status(404).json({ error: 'scope_not_found' });
        if (process.env.SW_DEBUG) console.error('[turn_search]', err?.message || err);
        return res.status(503).json({ error: 'search_unavailable' });
      }
    } catch (e) { next(e); }
  });

  // GET /api/turn/locate — the persisted turn index of one lineage, resolved back onto the live
  // active path. No `scope`: locate is what produces one. The response is a fixed pair of shapes whose
  // size locate caps against HISTORY_TOKEN_BUDGET itself, so a `budget` parameter is ignored rather than
  // rejected.
  app.get('/api/turn/locate', (req, res, next) => {
    try {
      const headId = Number(req.query.lineage_head);
      if (!Number.isInteger(headId) || headId <= 0) return res.status(404).json({ error: 'not_found' });
      // Lineage resolution is INSIDE this try, as on the page route: a store failure while walking the
      // parent chain leaves locate unable to answer — the same 503 an unusable turn FTS already
      // returns. Every 404 here is a `return`, never a throw, so widening the try cannot swallow one.
      try {
        const lineage = fromHandoff({ store: resolveStore(), handoffId: headId });
        if (lineage.length === 0) return res.status(404).json({ error: 'not_found' });
        if (!isValidTurnQuery(req.query.q)) return res.status(400).json({ error: 'invalid_query' });

        return res.json(locateRanges({ store: resolveStore(), lineage, q: req.query.q, ...history }));
      } catch (err) {
        if (process.env.SW_DEBUG) console.error('[turn_locate]', err?.message || err);
        return res.status(503).json({ error: 'locate_unavailable' });
      }
    } catch (e) { next(e); }
  });

  // ── Turn browse REST route ────────────────────────────────────────────────────

  // GET /api/turn/browse — the whole-lineage browse snapshot behind the dashboard's History drawer.
  // It takes NO parameters: the head is the newest handoff delivered into THIS session, resolved by
  // the same forLoadedHandoff walk the three MCP read tools use, so an `S{k}` a drawer prints and one
  // an agent reports name the same session. A browser has no handoff id to send, and accepting one
  // would keep the head in two places at once.
  //
  // Below that label the two faces diverge and are meant to. The page opens session transcripts up to
  // its budget ceiling, addresses records by their active-path ordinal where the source is readable,
  // drops abandoned identities and fits itself to the ceiling isWithinHistoryBudget enforces. This
  // response opens nothing, carries no address and returns every stored row, because a person scrolls
  // and searches a list where an agent reads a window.
  app.get('/api/turn/browse', (req, res) => {
    // A session that has loaded nothing yields an empty lineage, and an empty snapshot is a SUCCESS
    // value, matching the success semantics of an empty turn page. There is no address a
    // caller could have got wrong here, so this route has no 404 at all.
    const store = resolveStore();
    const lineage = forLoadedHandoff({ store, sessionId: currentSessionId });
    const { sections } = buildTurnBrowse({ store, lineage });
    return res.json({ sections });
  });

  // §4 Pricing API — priority: saved > CLI > model_default.
  // `modelPolicyFor` is the sole owner of model-derived policy, PRICING PRESETS INCLUDED, so this route
  // reads `policy.pricing` rather than importing the preset table a second time. That is what keeps the
  // shape described in one place; the member exists for exactly this consumer.
  const cliRatioAtStartup = ratioOverride;   // the CLI value, captured at construction

  const buildPricingResponse = () => {
    // The EPOCH model, not the latest measured one. Pricing is a model-DEPENDENT read: this same value is the
    // key `loadPricingOverride`/`savePricingOverride` store under, so taking the latest identity would move
    // an override's key mid-epoch.
    const model = watcher.getEpochModel() ?? '';
    const saved = loadPricingOverride(model);
    // The declared prompt-cache TTL as well as the model: the reported model default is the price
    // measurement is actually charging this epoch, which the composition resolved under the same TTL.
    const policy = modelPolicyFor(model, cacheTtl);
    const modelRatio = policy.cRatio;
    const presets = policy.pricing.presets;

    let effectiveRatio, source, effectiveRead = null, effectiveWrite = null;
    if (saved) {
      effectiveRatio = saved.ratio; source = 'saved';
      effectiveRead = saved.readPrice; effectiveWrite = saved.writePrice;

      // Preset drift detection (spec §10.3): if presetId saved, check prices still match
      if (saved.presetId) {
        const preset = presets.find(p => p.id === saved.presetId);
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
      modelDefault: { model, ratio: modelRatio, readPrice: policy.pricing.readPrice, writePrice: policy.pricing.writePrice },
      presets,
    };
  };

  // The one runtime ratio mutation. `setRatioOverride` refreshes the Engine's named reads without rebuilding
  // measurement state, recomputing a prior segment's extrema or touching the Rate Lamp integral, so a price
  // change is visible immediately and the sample stream stays continuous across it. Host wiring keeps the
  // saved > CLI > null priority here and maintains no second effective model policy.
  const applyEffectiveRatio = () => {
    // Same key as the response builder above: the saved override is looked up under the EPOCH model.
    const saved = loadPricingOverride(watcher.getEpochModel() ?? '');
    watcher.setRatioOverride(saved ? saved.ratio : cliRatioAtStartup);
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
      // The WRITE key is the epoch model, so an override lands under the same identity the read looks it up
      // by. A latest-identity key would store under one model and be read back under another mid-epoch.
      const model = watcher.getEpochModel() ?? '';
      if (!model) return res.status(409).json({ error: 'no_model', message: 'Model not yet detected; retry after first API call' });  // #9: guard empty model key
      savePricingOverride(model, { readPrice, writePrice, presetId: safePresetId });
      applyEffectiveRatio();
      res.json(buildPricingResponse());
    } catch (e) {
      next(e);
    }
  });

  app.delete('/api/pricing', (req, res) => {
    const model = watcher.getEpochModel() ?? '';
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

  // ── The one poll tick ────────────────────────────────────────────────────────
  // Bootstrap and the recurring timer call THIS function, so there is one description of what a tick does
  // and `pollIntervalMs: 0` disables only the recurrence. Each tick selects acquisition or installed-driver
  // polling and performs AT MOST one Source advance and one frame application.

  // Everything a changed application result owes, shared by the initial installation and every live tick, so
  // an installed Source's first frame is postprocessed exactly like the ones after it. Each non-blocking
  // operation catches its own failure: a rate-lamp, snapshot or SSE fault must not stop later ticks.
  function afterApplication(changed) {
    try {
      const { ledger } = advanceRateLampToCurrent(watcher, currentSessionId, { forcePoll: false });
      if (process.env.SW_DEBUG && ledger) console.error('[rate-lamp shadow]', JSON.stringify({ billProgress: ledger.billProgress, cycles: ledger.billCycleCount, paused: ledger.pausedReason, applied: ledger.lastAppliedFoldedCallSeq }));
    } catch (e) { if (process.env.SW_DEBUG) console.error('[rate-lamp]', e.message); }
    try {
      if (sseClients.size > 0 && !_replayController) {
        const tick = JSON.stringify({ type: 'tick', uptime: watcher.getStatus().uptime });
        for (const c of sseClients) { try { c.write(`data: ${tick}\n\n`); } catch { sseClients.delete(c); } }
      }
      if (changed) for (const c of sseClients) { try { c.write(`data: ${JSON.stringify({ type: 'scan' })}\n\n`); } catch { sseClients.delete(c); } }
    } catch (e) { if (process.env.SW_DEBUG) console.error('[sse]', e.message); }
    // v3 (spec section 6.7): profile snapshot for GC archival — throttled (V3-D3). The snapshot only needs
    // to be current at session end; staleness on crash is acceptable because GC archival runs days later.
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
    try {
      if (onIdleShutdown && shouldIdleShutdown({ sseClientsSize: sseClients.size, lastRequestMono, now: performance.now() })) {
        onIdleShutdown();
      }
    } catch (e) { if (process.env.SW_DEBUG) console.error('[idle-shutdown]', e.message); }
  }

  // Acquisition. It runs while `driver === null`, ABOVE the idle gate and independently of SSE state: an
  // unwired owner has nothing to be idle about, and a dashboard-less session must still attach.
  //
  // The caller ends its tick as soon as this has run, so an acquisition tick performs no live advance — one
  // Source advance per tick, and no frame ends the tick.
  function runAcquisition() {
    // Resolution runs only while no candidate has been retained. Once a locator resolves, recursive
    // directory scans stop for good and the candidate itself is what gets retried.
    if (candidate === null) {
      const now = _nowMono();
      if (now < nextResolveMono) return;
      // An explicitly supplied locator is ALREADY resolved, so it never costs a directory scan. Only an
      // owner that was given none searches, and only that search follows the backoff schedule.
      const found = sourceLocator
        ?? ((projectsRoot && currentSessionId) ? resolveSourceLocator(projectsRoot, currentSessionId) : null);
      if (!found) {
        // A missing locator advances the capped RESOLVE_BACKOFF_MS schedule.
        const step = RESOLVE_BACKOFF_MS[Math.min(resolveAttempts, RESOLVE_BACKOFF_MS.length - 1)];
        resolveAttempts += 1;
        nextResolveMono = now + step;
        return;
      }
      candidate = createSourceDriver({ sourceLocator: found, firstReadableTransition: 'replace' });
    }
    // The retained candidate is advanced in Source Reconstruction mode on every tick until its Source is
    // readable. No frame means the Source is not readable yet, which ends the tick.
    const frame = candidate.advance({ captureMode: 'replay' });
    if (!frame) return;
    // Application failure installs nothing: the candidate is discarded so a later tick rebuilds from a
    // fresh reader rather than continuing from a cursor whose frame never landed.
    let result;
    try { result = applyFrame(frame); }
    catch (error) { candidate = null; throw error; }
    driver = candidate;
    candidate = null;
    // Discovery already exists from listen time, so this is a rewrite from the installed driver. Its failure
    // keeps the installed driver and the previous record, with no public warning: the record is a discovery
    // convenience and the owner is already serving.
    if (publishedDiscoveryPaths.size > 0) writeDiscovery(currentSessionId);
    // The successful initial `replace` takes the SAME changed postprocessing an installed-driver tick takes,
    // so it writes the normal changed snapshot and emits one SSE scan.
    afterApplication(result.changed);
  }

  // One tick. Shared by the synchronous bootstrap and the recurring timer.
  function runPollTick() {
    if (driver === null) { runAcquisition(); return; }
    // The idle gate applies ONLY to installed-driver polling: if the last advance was recent and no SSE
    // client needs a push, skip the tick.
    const now = _nowMono();
    if (sseClients.size === 0 && (now - lastAdvanceMono) < IDLE_HEARTBEAT_MS) return;
    const frame = driver.advance({ captureMode: 'live' });
    // Recorded BEFORE the application so a throwing advance still marks this tick as recent work, which is
    // what stops a persistently failing Source from being retried at full timer frequency.
    lastAdvanceMono = _nowMono();
    // No frame is not distinguished from temporary Source unavailability: both mean no applicable increment,
    // and the tick still owes its rate-lamp advance, its SSE tick and its idle check.
    afterApplication(frame ? applyFrame(frame).changed : false);
  }

  function startPolling() {
    if (pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => {
      // A blocking Source-advance or application error after startup is owner-fatal: it stops the timer and
      // notifies the sink at most once. The non-blocking operations inside the tick catch their own faults,
      // so anything reaching here is the Source or the application itself.
      try { runPollTick(); }
      catch (error) {
        if (process.env.SW_DEBUG) console.error('[poll]', error);
        failOwner(error);
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

  // ── Session rotation ─────────────────────────────────────────────────────────
  // ONE owner-local rotation function behind both ingresses (the SessionStart HTTP callback and the
  // `rotate_session` MCP fallback). There is no rotation coordinator Module: rotation is a host concern
  // because only the host owns the driver, and the application is told about it through one `rotate` frame.

  function doRotation(newSessionId, transcriptPath) {
    // A duplicate-session notification retains driver, application and discovery state and produces no frame.
    if (newSessionId === currentSessionId) return { ok: true, noop: true };

    // Resolve the new locator with NO side effects yet: an unresolved notification also produces no frame.
    let newPath = transcriptPath || null;
    if (!newPath && projectsRoot) newPath = resolveBySessionId(projectsRoot, newSessionId);
    if (!newPath) return { ok: false, error: 'transcript_not_found' };

    // The candidate's immutable first-readable transition is `append`, because the host's own `rotate` frame
    // is what establishes the new locator — the candidate must not also claim to replace it. Its initial live
    // read happens WITHOUT mutating the current driver, so a failure here leaves the old Source installed.
    const rotated = createSourceDriver({ sourceLocator: newPath, firstReadableTransition: 'append' });
    const initial = rotated.advance({ captureMode: 'live' });
    // An immediately readable Source contributes its batches; an unavailable one contributes none and
    // `sourceObserved: false`. Either way this is ONE live `rotate` frame, old segment closure included.
    const frame = {
      transition: 'rotate',
      sessionId: newSessionId,
      sourceLocator: newPath,
      batches: initial ? initial.batches : [],
      sourceObserved: initial ? true : false,
      captureMode: 'live',
    };

    // Blocking finalization failure must leave driver, discovery, application identity and the snapshot
    // throttle exactly as they were, then take the owner-fatal path — the application has already refused
    // the transition, so continuing would serve a half-rotated owner.
    let result;
    try { result = applyFrame(frame); }
    catch (error) { failOwner(error); throw error; }

    const oldSessionId = currentSessionId;
    driver = rotated;
    currentSessionId = newSessionId;
    // V3-D3: the new session gets an immediate snapshot on its first changed tick, so a snapshot written
    // just before the rotation cannot suppress it.
    lastSnapshotMono = -Infinity;

    // Discovery: write the new record, then retire the old path. A rewrite failure keeps the installed
    // candidate and the previous record and returns the existing warning.
    const oldStateFile = join(effectiveStateDir, `${safeSessionId(oldSessionId)}.json`);
    const published = writeDiscovery(newSessionId);
    let warning;
    if (published.ok) {
      if (published.path !== oldStateFile) {
        try { unlinkSync(oldStateFile); publishedDiscoveryPaths.delete(oldStateFile); } catch { /* already gone */ }
      }
    } else {
      warning = 'state_file_write_failed';
    }

    // Rate Lamp advances ONCE under the new session identity, so the new session's ledger is keyed before any
    // reader sees it. No snapshot is written and no SSE is sent from rotation: the installed driver's ordinary
    // live polling owns both, and the throttle reset above guarantees the next changed tick writes.
    try { advanceRateLampToCurrent(watcher, currentSessionId, { forcePoll: false }); }
    catch (e) { if (process.env.SW_DEBUG) console.error('[rotate rate-lamp]', e.message); }
    void result;

    const port = server.address()?.port;
    const url = port ? `http://127.0.0.1:${port}` : null;
    const out = { ok: true, old_session_id: oldSessionId, new_session_id: newSessionId, url };
    if (warning) out.warning = warning;
    return out;
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
  // Registered ONCE, and only AFTER the synchronous bootstrap has succeeded: an owner that never started has
  // no business sweeping other sessions, and the backfill reads `currentSessionId` to exclude the live one,
  // which is only meaningful once this owner owns it. It enters neither the poll loop nor the owner-fatal
  // path — a failed sweep is best-effort and the rows stay pending for the next process start.
  let sweepTimer = null;
  function scheduleStartupMaintenance() {
    if (disableTelemetrySweep || sweepTimer) return;
    sweepTimer = setTimeout(() => {
      // Wrap the SYNCHRONOUS resolveStore() in the promise chain too: getStore() throws if the store is
      // not yet initialized, and a throw escaping this timer callback would be an uncaughtException (no
      // Express boundary covers a bare setTimeout). Threading it through Promise.resolve().then() turns
      // any such throw into a rejection the .catch() below swallows — the daemon-never-crashes invariant.
      Promise.resolve()
        // The turn-note age fallback rides this timer rather than one of its own: it is pure fs with no
        // store dependency, so it needs neither the defer nor the chain, but a second startup timer would
        // buy nothing. It reads `effectiveStateDir` — the same reference getTurnSkeleton writes the pair
        // under, so an injected state dir sweeps itself instead of the real install.
        //
        // Chained FIRST for short-circuiting, not for latency: a rejection anywhere in this chain skips
        // every later link, so chaining a sweep after the backfill would let a backfill failure cancel it.
        // The cost is the mirror image — a throw out of an earlier link skips the backfill for this process
        // start — and the shared .catch below names this timer rather than any one of its links, because
        // more than one of them can reach it. Logged on every run rather than only on a non-zero count, so
        // "ran, swept nothing" stays distinguishable from "never ran".
        .then(() => {
          const swept = sweepStaleTurnNotes(effectiveStateDir);
          if (process.env.SW_DEBUG) console.error('[turn-notes-sweep]', swept);
        })
        // The session and port-file age sweeps run from this timer because the deployed plugin reaches it:
        // the manifest starts the MCP entry, which composes `createServer` in-process and never enters the
        // CLI block below. They take THIS owner's store and state dir, so an injected harness sweeps its own
        // database and its own directory rather than the real install.
        .then(() => {
          const sessions = sweepStaleState({ store: resolveStore(), portDir: effectiveStateDir });
          const ports = sweepStalePortFiles(effectiveStateDir);
          if (process.env.SW_DEBUG) console.error('[state-sweep]', sessions, ports);
        })
        .then(() => resolveStore().backfillPendingTelemetry({
          resolveTranscript: (sid) => resolveBySessionId(projectsRoot, sid),
          // Reconstruction composes its own `SessionWatcher` through the host's factory, so a carry sweep's
          // archival path is this owner's own rather than a second table. It reconstructs into THIS owner's
          // store, which is what keeps an injected-store harness sweeping its own database. The project
          // context is the composition's NEUTRAL one: the sweep selects by pending telemetry, so the session
          // it reaches may belong to another project, and this owner's `projectRoot` would exclude that
          // session's resources against a boundary they were never inside.
          replaySession: (sid, txPath) => replaySessionTelemetry(sid, txPath, {
            store: resolveStore(),
            createWatcher: ({ store: reconciled, sessionId: sid2, sourceLocator }) => createWatcherComposition({
              sessionId: sid2, sourceLocator, projectId: null, projectRoot: null,
              stateDir: effectiveStateDir, store: reconciled, isIgnored: null,
              // The cache lifetime is NOT neutral the way the project context is: it prices the C ratio, so a
              // reconstructed session is measured under this owner's lifetime rather than resolving one of
              // its own.
              cacheTtl,
            }),
          }),
          excludeSessionIds: currentSessionId,   // don't sweep the still-live session (Set-or-string accepted)
          limit: 200, budgetMs: 1500,
        }))
        .then((s) => { if (process.env.SW_DEBUG) console.error('[telemetry-sweep]', JSON.stringify(s)); })  // log summary incl. aborted (no silent truncation)
        .catch((e) => { if (process.env.SW_DEBUG) console.error('[startup-maintenance]', e.message); });
    }, 250);
    sweepTimer.unref();   // never keep the process alive for the sweep
  }

  // ── Turn service ─────────────────────────────────────────────────────────────
  // The production capture boundary behind get_turn_skeleton / submit_turn_notes. Both are shared-application
  // operations now: the capture, the epoch-keyed file pair beneath the injected Turn Note root, the coverage
  // validation and the atomic commit all live there, so the two entry points cannot see different Turns and
  // this layer holds no note state. Kept off the HTTP surface and off `prepare_handoff`: ordering the two
  // calls is the sw-handoff skill's job, not the server's.
  const turnService = {
    getTurnSkeleton: () => watcher.getTurnSkeleton(),
    submitTurnNotes: (input) => watcher.submitTurnNotes(input || {}),
  };

  // ── Turn read service ────────────────────────────────────────────────────────
  // The three read tools take no lineage identifier. forLoadedHandoff resolves the newest handoff
  // delivered into THIS session and runs the same walk as the explicit-head HTTP routes. The page
  // result is byte-identical; search and locate add only their tool-side recovery. Because the head
  // is never a parameter, "you must have loaded a handoff" is a precondition the schema cannot express
  // wrongly — there is no guessable integer to fabricate.
  //
  // An address the caller supplied that does not resolve is rethrown with its recovery as the message:
  // the HTTP route answers 404 there, and 404 has no meaning over MCP, while turn_page_unavailable's
  // "call again" would be wrong advice for a value that reproduces the same failure.
  const turnReadService = {
    turnPage({ before = null } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: resolveStore(), sessionId: currentSessionId });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        return withPageRecovery(turnPageWire(injectedTurnPageBuilder({
          store: resolveStore(), lineage, before: before || null, ...history,
        })));
      } catch (err) {
        if (err && err.code === 'not_found') throw new Error(STALE_CURSOR_MESSAGE);
        if (process.env.SW_DEBUG) console.error('[turn_page_tool]', err?.message || err);
        return withPageRecovery({ error: 'turn_page_unavailable', retryable: true });
      }
    },

    turnSearch({ q, scope = null } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: resolveStore(), sessionId: currentSessionId });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        return withSearchRecovery(searchTranscripts({
          store: resolveStore(), lineage, q, scope: scope || null, ...history, includeToolEvidence,
        }), { hitRecovery: SEARCH_HIT_RECOVERY });
      } catch (err) {
        if (err && err.code === 'scope_not_found') throw new Error(SCOPE_ABSENT_MESSAGE);
        if (process.env.SW_DEBUG) console.error('[turn_search_tool]', err?.message || err);
        return withSearchRecovery({ error: 'search_unavailable' });
      }
    },

    turnLocate({ q } = {}) {
      try {
        const lineage = forLoadedHandoff({ store: resolveStore(), sessionId: currentSessionId });
        if (lineage.length === 0) return NO_HANDOFF_LOADED;
        return withLocateRecovery(locateRanges({ store: resolveStore(), lineage, q, ...history }));
      } catch (err) {
        if (process.env.SW_DEBUG) console.error('[turn_locate_tool]', err?.message || err);
        return withLocateRecovery({ error: 'locate_unavailable' });
      }
    },
  };

  // ── Synchronous bootstrap ────────────────────────────────────────────────────
  // The SAME tick the recurring timer drives, run exactly once before the server is exposed, so the very
  // first /api/status, /api/history and /api/buckets are populated rather than racing a promise. A bootstrap
  // acquisition or application error THROWS out of `createServer` and prevents owner startup: there is no
  // half-started owner, and the caller's startup-failure cleanup skips current-segment finalization.
  runPollTick();
  scheduleStartupMaintenance();

  // #7: expose startMs as `startedAt` so the CLI writes the SAME timestamp to the state file that
  // /api/health reports — one source of truth for the identity handshake (health===discovery).
  return {
    app, server, sseClients, startPolling, startedAt: startMs, applyEffectiveRatio,
    stopTimers: () => { clearInterval(pollTimer); clearInterval(pingTimer); if (sweepTimer) clearTimeout(sweepTimer); },
    doRotation, currentSessionId: () => currentSessionId, turnService, turnReadService,
    // Listen-time discovery creation, and every later republication, go through the one writer. It REPORTS
    // its outcome: the caller decides whether a failure prevents startup or is merely logged.
    publishDiscovery: () => writeDiscovery(currentSessionId),
    // The discovery paths this owner actually published. Cleanup deletes only these, after its pid check.
    publishedDiscoveryPaths: () => [...publishedDiscoveryPaths],
    // One tick, exposed so a test drives acquisition, the idle gate and live polling deterministically
    // instead of waiting on a timer.
    runPollTick,
    // Terminal application finalization, for the owner's cleanup sequence.
    closeCurrentSegment: (options) => watcher.closeCurrentSegment(options),
  };
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
// as NaN — a NaN ratio is not nullish, so the application's override gate admits it in place of the C ratio
// the composition's lifetime-bound policy resolver answered, and poisons every metric silently; a NaN lbase
// forces carried-baseline mode with a NaN total; a NaN/negative
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

  // ratio: parseFloat semantics; non-finite OR <= 0 → null (cRatio must be > 0 → the model policy's own ratio).
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
  const projectRoot = project || null;
  void lbase;   // the injected baseline is a retired v1/v2 lever; the Engine anchors `dead` from the Source

  const STATE_FILE = stateFileFor(sessionId);
  let shutdown; // forward-declared for onIdleShutdown reference
  // Store BEFORE the composition: the shared application takes the store as a required construction
  // dependency, and the synchronous bootstrap inside createServer already archives through it.
  try { initStore(); } catch (e) { console.error('[session-watcher] fatal: store init failed —', e.message); process.exit(1); }
  // One read of this process's declaration, handed to the composition that measures under it and to the
  // application that reports its price, so the two cannot name different lifetimes.
  const cacheTtl = resolveClaudeCodeCacheTtl();
  const watcher = createWatcherComposition({
    sessionId, sourceLocator: jsonlPath, projectId, projectRoot,
    stateDir: PORT_DIR, store: getStore(), isIgnored: projectRoot ? loadIsIgnored(projectRoot) : null,
    cacheTtl,
  });
  let failOwner;   // forward-declared: the sink is defined below, beside the shutdown it reuses
  const { server, startPolling, sseClients, stopTimers, startedAt, applyEffectiveRatio } = createServer({ watcher, pollIntervalMs: 1000, sessionId, hookSessionId, projectsRoot, projectRoot, projectId, sourceLocator: jsonlPath, ratioOverride, cacheTtl, onIdleShutdown: () => shutdown(), onOwnerFatal: (error) => failOwner(error) });
  server.listen(wantPort, '127.0.0.1', () => {   // loopback only — never expose local session data
    const port = server.address().port;
    mkdirSync(PORT_DIR, { recursive: true });
    cleanupLegacyJson(defaultBaseDir());
    applyEffectiveRatio();
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

  shutdown = function shutdown({ code = 0 } = {}) {
    stopTimers();
    for (const c of sseClients) { try { c.end(); } catch {} }
    try { flushAll(); } catch {}  // persist in-memory ledgers while store is still open
    closeStoreGlobal();
    try { unlinkSync(STATE_FILE); } catch {}
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };

  // The CLI owner's owner-fatal sink. Without one, `createServer`'s guard stopped the poll timer and returned:
  // polling was dead forever while the HTTP server and the discovery record stayed live, so the owner went on
  // advertising itself as alive while serving frozen state — worse than the baseline, which caught the throw
  // and kept polling. Same shape as the in-process owner: report, clean up, exit NONZERO so a supervisor and
  // the discovery record both stop pointing at a stopped owner. A fresh owner rebuilds from the Source.
  failOwner = function failOwner(error) {
    console.error('[session-watcher] fatal:', error?.message || error);
    shutdown({ code: 1 });
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
