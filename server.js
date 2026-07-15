// node:sqlite (DatabaseSync) requires Node >=22.16.0.
const [_major, _minor] = process.versions.node.split('.').map(Number);
if (_major < 22 || (_major === 22 && _minor < 16)) { console.error('Session Watcher requires Node >=22.16.0 (node:sqlite)'); process.exit(1); }
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { readdirSync, statSync, mkdirSync, unlinkSync, openSync, writeSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { SessionWatcher } from './lib/watcher.js';
import { advanceRateLampToCurrent, boundedIncrementalAdvance, mergeLedgerIntoStatus, getLiveLedger, setLiveLedger, recordBillEvent, recordStopEvent, flushAll, commitLedgerMutationSync, drainPendingStopEvaluations, _processNonce, isEnospcPaused, clearEnospcPause, engageEnospcPause, cancelCoalescedPersist, getDebugCounters, incrementCounter } from './lib/rate-lamp-manager.js';
import { stateKeyForStatus, settleBatchAtBoundary, enqueuePending, appendProcessedHookId, alreadyAccepted, chooseCurrentStopSummary, pushStopEventRing } from './lib/rate-lamp-store.js';
import { PENDING_STOP_EVALUATIONS_LIMIT, STOP_ADVANCE_MAX_MS, STOP_ADVANCE_MAX_BYTES, IDLE_HEARTBEAT_MS, MODEL_PRICING_PRESETS } from './lib/constants.js';
import { validateLedgerState } from './lib/ledger-schema.js';
import { landmarks } from './lib/landmarks.js';
import { detectStockStep } from './lib/rate-lamp.js';
import { resolveStopMessage } from './lib/stop-message.js';
import { evaluateGate, rawTierFor } from './lib/notify-gate.js';
import { loadGateState, saveGateState } from './lib/gate-store.js';
import { initStore, closeStoreGlobal } from './lib/store.js';
import { cleanupLegacyJson, defaultBaseDir } from './lib/legacy-cleanup.js';
import { cRatioFor } from './lib/extract.js';
import { loadPricingOverride, savePricingOverride, deletePricingOverride, validatePricingInput } from './lib/pricing-store.js';
import { sweepStaleState, sweepStalePortFiles } from './lib/state-reaper.js';
import { BR_AMBER, BR_RED } from './lib/bill-regret.js';
import {
  renderReliability,
  tagOf,
  formatLine,
} from './lib/statusline-format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// round-6 GPT#3b: sanitize a sessionId used as a filename segment. Defense-in-depth — a `/`, `\`,
// `..`, or NUL would let `${sessionId}.json` escape the state dir. Inlined from the deleted
// lib/atomic-store.js (previously shared; now only used here and lib/launcher.js, each inline).
function safeSessionId(sessionId) {
  const s = String(sessionId ?? '');
  if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s) || s.includes('..')) return '__invalid_session__';
  return s;
}

export const PORT_DIR = join(homedir(), '.session-watcher');
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

// Pure function for testability: returns true if the server should shut down due to idleness.
export function shouldIdleShutdown({ sseClientsSize, lastRequestMono, now }) {
  return sseClientsSize === 0 && (now - lastRequestMono) > IDLE_SHUTDOWN_MS;
}

// Factory: build an http.Server around an existing watcher (used by tests and CLI).
// Returns { app, server, sseClients, startPolling, stopTimers }. `server` is a real
// node:http.Server so callers do server.listen(0)/server.address()/server.close().
export function createServer({ watcher, pollIntervalMs = 1000, sessionId, onIdleShutdown = null }) {
  const app = express();
  const startMs = Date.now();
  const sseClients = new Set();
  const server = createHttpServer(app);

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
      const status = watcher.getStatus(parseFitWindow(req.query.fitWindow));
      const currentKey = status.rateLamp?.reliable ? stateKeyForStatus(status) : null; // #10: shared key builder
      // round-7 GPT#2/#8: LIVE ledger only — never a raw disk read (that would skip the manager's
      // pulse-clear/turnSeq hydrate and could resurrect a stale alert on the first post-restart GET).
      const ledger = getLiveLedger(sessionId);
      mergeLedgerIntoStatus(status, ledger, currentKey);
      // billCycleCount is DEBUG-ONLY (GPT#16): attach only when ?debug query param is set.
      if (req.query.debug && status.rateLamp?.billingCycle) {
        status.rateLamp.billingCycle.cycleCountInSegment = ledger?.billCycleCount ?? 0;
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
    let h = watcher.getHistory(parseFitWindow(req.query.fitWindow));
    if (req.query.since) { const t = Date.parse(req.query.since); if (!Number.isNaN(t)) h = h.filter(p => Date.parse(p.ts) >= t); }
    res.json(h);
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

  // round-7 gemini#2: mount the JSON body parser HERE, physically above the routes — the sessionMismatch
  // guard reads req.body.session_id, and because that guard tolerates an ABSENT body sid, a missing or
  // mis-ordered parser would SILENTLY DISABLE the cross-session 409 (fail-open) with no error and no
  // failing test. Small cap — the body is a tiny {session_id}. A malformed body → express.json throws →
  // the terminal error middleware returns 500 (daemon stays up). MUST precede app.post('/api/notify-gate').
  app.use(express.json({ limit: '4kb' }));

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

  // v2.1 notify-gate. POST advances the ratchet + persists; GET /peek is read-only (never mutates,
  // never consumes an alert — guardrail b). Gate snapshot assembled from getStatus + landmarks.
  // #8 (v2.2-D): take the ALREADY-computed status (from advanceRateLampToCurrent) — do NOT call
  // watcher.getStatus() a second time. peek route passes its own fresh getStatus (it has no advance).
  const gateSnapshotFor = (turnSeq, st) => {
    const br = st.rateLamp?.br;
    if (st.rateLamp?.reliable === true && Number.isFinite(br)) {
      // br-coordinate shim: feed br directly as x, with BR thresholds as landmarks.
      // Note: reliable=true implies kStableFrozen > 0 (same gate), so br is always
      // computed via computeBr in mergeLedgerIntoStatus. The "reliable + br=NaN" case
      // cannot occur in production — the guard is defensive only.
      return {
        segment: st.segment, turnSeq, reliable: true,
        x: br,
        landmarks: { fullCarry: { xStar: BR_AMBER, dhat: BR_RED - BR_AMBER } },
      };
    }
    // Fallback: calibrating period (kStable not yet frozen) — geometric landmarks.
    // reliable is false here, so evaluateGate won't fire notifications.
    // RV-C15: C_RATIO fallback is model-derived, not a hardcoded 10. A deepseek unreliable frame OMITS
    // rateLamp.C_RATIO, so `?? 10` would compute landmarks at ratio 10 instead of the model-correct 50 —
    // cRatioFor(st.model) mirrors the segment-locked ratio getStatus itself uses (never 0/undefined: it
    // falls back by tier substring, DEFAULT_C_RATIO=10 for a missing/unknown model — see lib/extract.js).
    const lm = landmarks(st.rateLamp?.C_RATIO ?? cRatioFor(st.model), st.kAvg, st.baseline?.total ?? 0, st.baseline?.dead ?? 0, st.L);
    return { segment: st.segment, turnSeq, reliable: st.rateLamp?.reliable === true,
      x: lm.x, landmarks: { fullCarry: { xStar: lm.fullCarry.xStar, dhat: lm.fullCarry.dhat } } };
  };
  // v2.2-C3 H-A: Zero-settle Stop route. The Stop settles NOTHING — it (a) integrates flushed events via
  // advanceRateLampToCurrent (forcePoll); (b) drains PRIOR pending off reader-committed summaries;
  // (c) resolves wall/dw_backstop/gate INLINE from LIVE quantities; (d) UNCONDITIONALLY enqueues a pending
  // for the open turn. empty_burn/non_idle/cache_unstable defer to the reader's authoritative settle at N+1.
  // round-6 GPT#3a: stale-port cross-session guard.
  const sessionMismatch = (req, res) => {
    const bodySid = req.body?.session_id;
    if (bodySid && bodySid !== sessionId) { res.status(409).json({ error: 'session_mismatch' }); return true; }
    return false;
  };
  // Internal event-id minter for hooks that don't send one (backwards compat with older warn.sh)
  let _internalEventSeq = 0;
  const mintInternalEventId = () => `internal-${Date.now()}-${++_internalEventSeq}`;

  app.post('/api/notify-gate', (req, res, next) => {
   try {
    if (sessionMismatch(req, res)) return;

    const hookEventId = req.body?.hook_event_id ?? mintInternalEventId();

    // 0. Hydrate the live ledger (needed for the dedup check below)
    let ledger = getLiveLedger(sessionId);

    // 1. HTTP dedup (B12): already accepted → short-circuit, no mutation
    if (ledger && alreadyAccepted(hookEventId, ledger)) {
      const snap = gateSnapshotFor(watcher._turnSeq, watcher.getStatus());
      const gateResult = evaluateGate(snap, loadGateState(sessionId));
      res.json({ ok: true, notify: false, tier: gateResult?.tier ?? 0, kind: null, delivery: null, message: null,
        gate: { notify: false, tier: gateResult?.tier ?? 0, reason: 'already_accepted' }, bill: null });
      return;
    }

    // 1.5 ENOSPC probe (C5a, round-5 G1 — BEFORE B7 backpressure to prevent deadlock):
    // If this session is in ENOSPC pause-drain, the Stop's force-write is the recovery probe.
    // On success → clear pause, drain backlog, return 200 {recovered:true, accepted:false}.
    // On failure → return 503 persist_failed (keep the pause).
    if (isEnospcPaused(sessionId)) {
      try {
        // Probe: force-write the current live ledger (proves disk is back)
        const currentLedger = getLiveLedger(sessionId);
        if (currentLedger) setLiveLedger(sessionId, currentLedger);
        // Probe succeeded → clear pause (setLiveLedger already cleared it internally)
        // Drain the backlog
        try {
          if (getLiveLedger(sessionId)) drainPendingStopEvaluations(sessionId);
        } catch (drainErr) {
          // round-8 GPT-pt5: drain re-hits ENOSPC → pause re-engaged, 503
          // persistLedger inside commitLedgerMutationSync threw → A12 rollback applied
          // Re-engage pause: setLiveLedger's clearEnospcPause already ran (probe succeeded),
          // but the drain's commitLedgerMutationSync threw on persist → re-add to pause set.
          engageEnospcPause(sessionId);
          res.status(503).json({ ok: false, degraded: 'persist_failed' });
          return;
        }
        res.json({ ok: true, recovered: true, accepted: false });
        return;
      } catch (probeErr) {
        // Probe failed → disk still down, keep pause engaged
        res.status(503).json({ ok: false, degraded: 'persist_failed' });
        return;
      }
    }

    // 2. Bounded incremental advance (C4-1: replaces forcePoll with budget-capped advance)
    const { caughtUp, status: st } = boundedIncrementalAdvance(watcher, sessionId, { maxMs: STOP_ADVANCE_MAX_MS, maxBytes: STOP_ADVANCE_MAX_BYTES });

    // 3. Drain PRIOR pending (reader-committed summaries). Sources LIVE ledger internally.
    // Bug fix: try/catch so a throw (e.g. IO error in commitLedgerMutationSync's persist) does not
    // prevent the current Stop's pending from being enqueued (alert intent must not be lost).
    try {
      if (getLiveLedger(sessionId)) drainPendingStopEvaluations(sessionId);
    } catch (e) { if (process.env.SW_DEBUG) console.error('[rate-lamp] drain throw (non-fatal):', e.message); }

    // 3.5 Hook-gap bookkeeping (F1/H-A): reconcile orphaned committed summaries.
    try {
      if (getLiveLedger(sessionId)) commitLedgerMutationSync(sessionId, 'choose-current-stop', draft => chooseCurrentStopSummary(draft));
    } catch (e) { if (process.env.SW_DEBUG) console.error('[rate-lamp] choose throw (non-fatal):', e.message); }

    // 3.6 RE-FETCH (I-pt3): step-2 advance, step-3 drain, step-3.5 choose EACH commit a new draft.
    ledger = getLiveLedger(sessionId);

    // 4. Resolve THIS Stop's inline signals from LIVE quantities (H-A)
    const snap = gateSnapshotFor(watcher._turnSeq, st);
    const gateResult = evaluateGate(snap, loadGateState(sessionId));

    let dwTurn = 0, stockStep = false;
    const currentKey = st.rateLamp?.reliable ? stateKeyForStatus(st) : null;
    const matchingKeyLedger = st.rateLamp?.reliable && ledger && ledger.stateKey === currentKey;

    if (matchingKeyLedger && ledger.pausedReason == null) {
      // dw_backstop only meaningful in deep water — shallow accumulation is controlled cost
      dwTurn = st.rateLamp?.inDeepWater ? ledger.currentTurnDeltaW : 0;
      stockStep = detectStockStep(watcher._currentSegmentCalls(), ledger.kStableFrozen, { sinceFoldedSeq: ledger.billAnchorFoldedCallSeq });
    }

    const inlineMsg = resolveStopMessage({ gateResult, bill: null, burnRate: st.rateLamp?.burnRate ?? 0, dwTurn, stockStep });
    const firesInline = inlineMsg && inlineMsg.delivery === 'stop_hook' && ['wall', 'dw_backstop', 'gate'].includes(inlineMsg.kind);

    // 5. Single transaction: unconditionally enqueue pending + optional inline stop_hook + add id + persist
    // B7 backpressure gate: check capacity on the LIVE ledger BEFORE entering the atomic commit.
    // A full queue returns 503 with NO mutation (enqueuePending's length check on the live ref is read-only here).
    if (ledger && (ledger.pendingStopEvaluations || []).length >= PENDING_STOP_EVALUATIONS_LIMIT) {
      res.status(503).json({ ok: false, degraded: 'pending_backpressure' });
      return;
    }

    // C5a: cancel any pending coalesced persist before the synchronous Stop-route write — eliminates
    // the interleave window where a stale coalesced flush could race the alert commit.
    cancelCoalescedPersist(sessionId);

    // A12 atomicity: ALL mutations (enqueue pending + appendProcessedHookId + optional inline stop_hook)
    // run inside commitLedgerMutationSync on a structuredClone'd DRAFT. If persist throws, the live
    // _ledgers entry is UNTOUCHED → the hookEventId is NOT accepted → next Stop self-heals (spec A12).
    // Guard: only enter the atomic commit if the ledger passes validateLedgerState — a ledger in a
    // degraded/invalid state (e.g. incomplete rateLamp bundle during calibration) skips pending tracking
    // gracefully; the gate fire still reaches the response (A12 applies to VALID ledgers only).
    try {
      if (ledger && validateLedgerState(ledger)) {
        commitLedgerMutationSync(sessionId, 'stop-enqueue', (draft) => {
          // B12: appendProcessedHookId — same-transaction
          appendProcessedHookId(draft, hookEventId);

          // Unconditionally enqueue pending
          enqueuePending(draft, {
            hookEventId,
            requestedAtWallMs: Date.now(),
            requestedAtMonoMs: performance.now(),
            processNonce: _processNonce,
            beforeSettledThroughTurnSeq: draft.settledThroughTurnSeq,
          });
          incrementCounter('pendingCreatedCount');

          // 6. Inline stop_hook from LIVE quantities (H-A)
          if (firesInline) {
            const stopEvt = { kind: inlineMsg.kind, delivery: inlineMsg.delivery, message: inlineMsg.message, billCount: inlineMsg.billCount ?? 0, turnSeq: draft.currentTurnSeq };
            draft.lastStopEvent = stopEvt;
            pushStopEventRing(draft, stopEvt);
            draft.alertEvaluatedThroughTurnSeq = Math.max(draft.currentTurnSeq, draft.alertEvaluatedThroughTurnSeq || 0);
          }
        });
      }
    } catch (writeErr) {
      // A12: persist failed — commitLedgerMutationSync persists BEFORE _ledgers.set, so on throw the
      // in-memory entry is UNTOUCHED. The hookEventId is NOT in the live ledger's processedIds ring →
      // not dedup-accepted → next Stop re-evaluates (self-heal). Rollback is free.
      // Bug fix: return BEFORE saveGateState — gate tier must NOT be consumed when hookEventId failed
      // to persist (otherwise the ratchet advances but the id isn't recorded → alert lost on retry).
      res.status(503).json({ ok: false, degraded: 'persist_failed' });
      return;
    }

    // Gate ratchet AFTER ledger persist (round-8 GPT#4: prefer visible duplicate over silent loss).
    // Safe: if commit threw we already returned above; if commit was skipped (no ledger / invalid),
    // the gate advances normally (no dedup ring to track against in that state).
    saveGateState(sessionId, gateResult.nextState);

    res.json({
      ok: true,
      notify: firesInline === true,
      tier: gateResult?.tier ?? 0,
      kind: inlineMsg?.kind ?? null,
      delivery: inlineMsg?.delivery ?? null,
      message: firesInline ? inlineMsg.message : null,
      gate: { notify: gateResult.notify, tier: gateResult.tier, reason: gateResult.reason },
      bill: null,  // H-A: Stop settles NOTHING — no bill
    });
   } catch (e) { next(e); }
  });
  app.get('/api/notify-gate/peek', (req, res, next) => {
   try {
    const st = watcher.getStatus(); // #8: peek has no advance → compute its own fresh status
    const snap = gateSnapshotFor(watcher._turnSeq, st);
    const prev = loadGateState(sessionId);
    // A7/GPT#9: reuse the SAME rawTierFor as evaluateGate — no hand-rolled copy that can drift.
    // would-be raw tier WITHOUT running the ratchet / persisting.
    const rawTier = rawTierFor(snap.x, snap.landmarks.fullCarry);
    res.json({ rawTier, maxTierFired: prev?.maxTierFired ?? 0, reliable: snap.reliable });
   } catch (e) { next(e); }
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
    // Step 4 size counters: computed at read time from the live ledger (no per-mutation tracking).
    const sizes = {
      pendingStopEvaluations: (ledger?.pendingStopEvaluations || []).length,
      settledTurnSummaries: (ledger?.settledTurnSummaries || []).length,
      recentStopEvents: (ledger?.recentStopEvents || []).length,
    };
    res.json({ ledger, counters, sizes, enospcPaused: isEnospcPaused(sid) });
  });

  app.use(express.static(join(__dirname, 'public'), {
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
  }));
  app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

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
  // Test-injection seam (A20): _nowMono reads the module-level _globalTestClockMono (set via
  // _setServerTestClock) so tests can drive the idle gate deterministically.
  const _nowMono = () => _globalTestClockMono != null ? _globalTestClockMono : performance.now();

  function startPolling() {
    if (pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => {
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
        const { ledger } = advanceRateLampToCurrent(watcher, sessionId, { forcePoll: false });
        if (process.env.SW_DEBUG && ledger) console.error('[rate-lamp shadow]', JSON.stringify({ billProgress: ledger.billProgress, cycles: ledger.billCycleCount, paused: ledger.pausedReason, applied: ledger.lastAppliedFoldedCallSeq }));
        if (sseClients.size > 0) {
          const tick = JSON.stringify({ type: 'tick', uptime: watcher._uptimeSec() });
          for (const c of sseClients) { try { c.write(`data: ${tick}\n\n`); } catch { sseClients.delete(c); } }
        }
        if (changed) for (const c of sseClients) { try { c.write(`data: ${JSON.stringify({ type: 'scan' })}\n\n`); } catch { sseClients.delete(c); } }
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

  // #7: expose startMs as `startedAt` so the CLI writes the SAME timestamp to the state file that
  // /api/health reports — one source of truth for the identity handshake (health===stateFile).
  return { app, server, sseClients, startPolling, startedAt: startMs, applyEffectiveRatio, stopTimers: () => { clearInterval(pollTimer); clearInterval(pingTimer); } };
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
  let shutdown; // forward-declared for onIdleShutdown reference
  const { server, startPolling, sseClients, stopTimers, startedAt, applyEffectiveRatio } = createServer({ watcher, pollIntervalMs: 1000, sessionId, onIdleShutdown: () => shutdown() });
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
      writeStateFileExclusive(STATE_FILE, { port, pid: process.pid, transcriptPath: jsonlPath, sessionId, startedAt });
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
