// R2-15 / final-review GPT#10: node:test + node:assert/strict + structuredClone require Node ≥18.
if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Session Watcher requires Node >=18'); process.exit(1); }
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { readdirSync, statSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { SessionWatcher } from './lib/watcher.js';
import { advanceRateLampToCurrent, mergeLedgerIntoStatus, getLiveLedger, setLiveLedger, recordBillEvent, recordStopEvent, flushAll } from './lib/rate-lamp-manager.js';
import { stateKeyForStatus, settleBatchAtBoundary } from './lib/rate-lamp-store.js';
import { landmarks } from './lib/landmarks.js';
import { detectStockStep } from './lib/rate-lamp.js';
import { resolveStopMessage } from './lib/stop-message.js';
import { evaluateGate, rawTierFor } from './lib/notify-gate.js';
import { loadGateState, saveGateState } from './lib/gate-store.js';
import { safeSessionId } from './lib/atomic-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PORT_DIR = join(homedir(), '.session-watcher');
// Discovery file is scoped by session_id (NOT a single global file, NOT project-hash):
// server↔transcript is 1:1, and session_id is the finest key — it also disambiguates two
// windows open on the SAME project (which a project-path hash would still collide).
// round-7 GPT#6: route the sid through safeSessionId so all THREE sid→path writers (this
// port-discovery file + gate-store's + rate-lamp-store's pathFor) agree — a `/` or `..` in the
// sid can no longer escape PORT_DIR. Defense-in-depth: the sid is a harness UUID in practice.
export const stateFileFor = (sessionId) => join(PORT_DIR, `${safeSessionId(sessionId || 'default')}.json`);

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
  // ER-2 (Task 10): the kFit eta segment (`~N轮`/`已过线`/`—`) is retired — the Task-7 break-even
  // (from hBreak, appended below) replaces the "rounds-remaining" role (§17.3). parseFitWindow still
  // selects the history/display fitWindow; it no longer feeds any kFit eta here.
  const phi = s.phi ? `φ${s.phi.toFixed(1)}×` : '';
  const p = s.paybackP != null ? `(P${Math.round(s.paybackP * 100)}%)` : '';
  const rst = s.restart ? ` · 🔴 L≥L* 建议重启(${s.restartReason})` : '';
  const base = `[${tag}] ${bar} L ${k(s.L)}/L* ${k(s.Lstar)} · ${light} · ${phi}${p}${rst}`;
  // B3 (v2.1): append the rate-lamp string ONLY when the instant bundle is reliable. Unreliable / absent
  // rateLamp → the existing bar line is returned unchanged (the statusline never blocks CC; degrade quietly).
  if (!s.rateLamp?.reliable) return base;
  const rl = s.rateLamp;
  // always-on segment. hBreak may be Infinity (burnRate=0, below the floor) → `break-even —`, NEVER
  // "break-even ~Infinity turns" (review A7#15). billProgress → `bill NN%` (§3.8 rounds at render only).
  const hb = rl.hBreak;
  const be = Number.isFinite(hb) ? `break-even ~${Math.round(hb)} turns` : 'break-even —';
  const billPct = `bill ${Math.round((rl.billProgress ?? 0) * 100)}%`;
  let line = `${base} · ${be} · ${billPct}`;
  // Single merged-presentation stack (STRICT priority, never both — §4.3). lastStopEvent is recorded ONLY
  // for stop_hook deliveries, so: stop_hook alert wins the turn; else the bill pulse; never both. TTL —
  // only the CURRENT turn's event renders (a stale event from an earlier turn must not keep flashing).
  const stop = rl.lastStopEvent, bill = rl.lastBillEvent, cur = rl.currentTurnSeq;
  if (stop && stop.turnSeq === cur) {
    line += ` · 🔴 ${stop.message}`;                                  // stop_hook alert wins the turn
  } else if (bill && bill.turnSeq === cur) {
    const n = bill.billCount ?? 0;
    // neutral copy — no verdict word / no α (Global Constraint §1/§5). A cache_unstable settlement is a
    // NEGATIVE jump → the neutral calibrating copy, NOT "ctx growing" (its opposite, round-2 GPT#13).
    if (bill.kind === 'cache_unstable') line += ` · 指标校准中 (cache unstable)`;
    else if (bill.kind === 'empty_burn') line += ` · rent +${n}x · idle`;
    else line += ` · rent +${n}x · ctx growing`;                      // non_idle_burn
  }
  return line;
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
export function createServer({ watcher, pollIntervalMs = 1000, sessionId }) {
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

  app.get('/api/status', (req, res, next) => {
    try {
      const status = watcher.getStatus(parseFitWindow(req.query.fitWindow));
      const currentKey = status.rateLamp?.reliable ? stateKeyForStatus(status) : null; // #10: shared key builder
      // round-7 GPT#2/#8: LIVE ledger only — never a raw disk read (that would skip the manager's
      // pulse-clear/turnSeq hydrate and could resurrect a stale alert on the first post-restart GET).
      const ledger = getLiveLedger(sessionId);
      mergeLedgerIntoStatus(status, ledger, currentKey);
      // billCycleCount is DEBUG-ONLY (GPT#16): attach only under debug, off the SAME ledger var (GPT#8).
      if ((req.query.debug || process.env.SW_DEBUG) && status.rateLamp?.billingCycle) {
        status.rateLamp.billingCycle.cycleCountInSegment = ledger?.billCycleCount ?? 0;
      }
      if (req.query.fmt === 'line') { res.type('text/plain').send(formatLine(status)); return; }
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
    req.on('close', () => sseClients.delete(res));
  });

  // round-7 gemini#2: mount the JSON body parser HERE, physically above the routes — the sessionMismatch
  // guard reads req.body.session_id, and because that guard tolerates an ABSENT body sid, a missing or
  // mis-ordered parser would SILENTLY DISABLE the cross-session 409 (fail-open) with no error and no
  // failing test. Small cap — the body is a tiny {session_id}. A malformed body → express.json throws →
  // the terminal error middleware returns 500 (daemon stays up). MUST precede app.post('/api/notify-gate').
  app.use(express.json({ limit: '4kb' }));

  // v2.1 notify-gate. POST advances the ratchet + persists; GET /peek is read-only (never mutates,
  // never consumes an alert — guardrail b). Gate snapshot assembled from getStatus + landmarks.
  const gateSnapshotFor = (turnSeq) => {
    const st = watcher.getStatus();
    const lm = landmarks(st.rateLamp?.C_RATIO ?? 10, st.kAvg, st.baseline?.total ?? 0, st.baseline?.dead ?? 0, st.L);
    return { segment: st.segment, turnSeq, reliable: st.rateLamp?.reliable === true,
      x: lm.x, landmarks: { fullCarry: { xStar: lm.fullCarry.xStar, dhat: lm.fullCarry.dhat } } };
  };
  // TEMPORARY gate-only handler (final-review GPT#3): Task 8b REPLACES this same handler in place with
  // the full settle + resolveStopMessage + recordStopEvent version. It is NOT a second route — editing
  // this one keeps exactly one `app.post('/api/notify-gate', …)` (Express dispatches the first match).
  // Uses (req, res, next) + try/catch per the error-boundary constraint (round-3 GPT#7 — even the
  // temporary handler must not be an un-guarded snippet the implementer copies).
  // round-6 GPT#3a: a stale/reused port could carry warn.sh's POST to the WRONG session's server. The
  // hook sends { session_id }; refuse a mismatch with 409 (loopback bind stops off-host, not local
  // cross-session). NOT auth — a stale-port guard (compatible with RV-C6 no-token). Shared by both the
  // temporary handler and the Task-8b replacement. A missing body sid (older hook) is tolerated (no 409).
  const sessionMismatch = (req, res) => {
    const bodySid = req.body?.session_id;
    if (bodySid && bodySid !== sessionId) { res.status(409).json({ error: 'session_mismatch' }); return true; }
    return false;
  };
  app.post('/api/notify-gate', (req, res, next) => {
   try {
    if (sessionMismatch(req, res)) return; // round-6 GPT#3a: stale-port cross-session guard (same helper as Task 5)
    // round-2 GPT#6: force-poll so the ledger sees the call(s) of the turn that just ended.
    const { ledger: advanced, status: st } = advanceRateLampToCurrent(watcher, sessionId, { forcePoll: true });
    const snap = gateSnapshotFor(watcher._turnSeq);
    // round-8 GPT#4: COMPUTE the gate result now (it feeds resolveStopMessage), but DEFER the ratchet
    // COMMIT (saveGateState) until AFTER the ledger event is persisted. The gate ratchet is a one-shot:
    // once its nextState is saved, that tier won't re-fire. If we committed it here and then setLiveLedger
    // threw (disk error), the gate would be ratcheted-consumed while lastStopEvent never persisted →
    // warn.sh discards the response, no OS notify → the alert is SILENTLY LOST. Ordering the ledger
    // persist first means a persist failure leaves the gate UN-ratcheted → it re-fires next turn (a rare
    // visible duplicate). Prefer a visible duplicate over a silent loss.
    const gateResult = evaluateGate(snap, loadGateState(sessionId));

    // final-review GPT#8: re-check stateKey at the settle site (defense-in-depth; the manager should
    // already have reset a stale ledger, but assert it here too — never settle a cross-segment ledger).
    const currentKey = st.rateLamp?.reliable ? stateKeyForStatus(st) : null; // #10: shared key builder (same fields as /api/status)
    const matchingKeyLedger = st.rateLamp?.reliable && advanced && advanced.stateKey === currentKey;

    let bill = null, dwTurn = 0, stockStep = false;
    let led = advanced; // the live ledger we may further mutate before persisting once, below

    // SETTLE only on a clean (non-paused) matching-key ledger. dwTurn/stockStep are ledger-derived, so
    // they too are gated here — a paused ledger's currentTurnDeltaW is not trustworthy for the ΔW backstop.
    if (matchingKeyLedger && advanced.pausedReason == null) {
      dwTurn = advanced.currentTurnDeltaW;
      // round-6 GPT#4: scan the WHOLE Stop window (calls since the boundary anchor), not just the last hop.
      stockStep = detectStockStep(watcher._currentSegmentCalls(), advanced.kStableFrozen, { sinceFoldedSeq: advanced.billAnchorFoldedCallSeq });
      const settled = settleBatchAtBoundary(advanced, { L_readNow: st.rateLamp.L_read, kStable: advanced.kStableFrozen,
        inDeepWater: st.rateLamp.inDeepWater, foldedSeqNow: watcher._foldedCallSeq, turnSeqNow: watcher._turnSeq });
      bill = settled.bill;
      led = recordBillEvent(settled.state, bill, watcher._turnSeq); // bill pulse (statusline_pulse) channel
    }

    // Resolve the ONE message. bill is null on a paused/absent ledger, but WALL (instantaneous burnRate)
    // and the notify-gate (independent of the ledger) can STILL resolve to a stop_hook alert.
    const resolved = resolveStopMessage({ gateResult, bill, burnRate: st.rateLamp?.burnRate ?? 0, dwTurn, stockStep });

    // R5 GPT#1: persist a stop_hook alert to lastStopEvent whenever one resolved AND we have a matching-key
    // ledger — INCLUDING when the ledger is PAUSED. Pausing blocks SETTLEMENT, not gate/WALL alert delivery:
    // warn.sh discards this POST response and there is no OS notification, so lastStopEvent is the alert's
    // ONLY UI home (final-review GPT#2). Without this, a gate/WALL fire during a folded_seq_gap /
    // cache_unstable / seq_history_mismatch pause is silently lost. recordStopEvent already no-ops on a
    // non-stop_hook delivery, so the guard just avoids a redundant write.
    if (matchingKeyLedger && resolved?.delivery === 'stop_hook') {
      led = recordStopEvent(led, resolved, watcher._turnSeq);
    }
    if (led !== advanced) setLiveLedger(sessionId, led); // single persist path (manager owns the file)
    // round-8 GPT#4: COMMIT the gate ratchet ONLY after the ledger event persisted. If setLiveLedger threw
    // above, we never reach here → the gate stays un-ratcheted and re-fires next turn (visible), rather than
    // being consumed with the alert lost. A gate-save failure here is the benign direction: the event is
    // already durable in the ledger; the ratchet simply hasn't advanced, so at worst the SAME gate re-fires.
    saveGateState(sessionId, gateResult.nextState);

    // final-review GPT#9: unified response — carries kind/delivery/message AND the gate sub-object (tier/reason)
    // AND the bill sub-object, so Task-5 contract consumers (tier) and dashboards keep working. hook ignores it.
    // round-6 gemini#2: ALSO emit `tier` at the ROOT. Task 5's response contract was flat `{ notify, tier, ... }`;
    // nesting tier only under `gate` silently breaks any consumer reading `response.tier` (→ undefined). Keep both.
    res.json({
      notify: resolved?.delivery === 'stop_hook',
      tier: gateResult?.tier ?? 0,                 // root-level, backward-compatible with the Task-5 flat contract
      kind: resolved?.kind ?? null,
      delivery: resolved?.delivery ?? null,
      message: resolved?.delivery === 'stop_hook' ? resolved.message : null,
      gate: { notify: gateResult.notify, tier: gateResult.tier, reason: gateResult.reason },
      bill: bill ? { kind: bill.kind, billCount: bill.billCount, deltaL: bill.deltaL } : null,
    });
   } catch (e) { next(e); } // round-2 gemini 一.2: error boundary
  });
  app.get('/api/notify-gate/peek', (req, res, next) => {
   try {
    const snap = gateSnapshotFor(watcher._turnSeq);
    const prev = loadGateState(sessionId);
    // A7/GPT#9: reuse the SAME rawTierFor as evaluateGate — no hand-rolled copy that can drift.
    // would-be raw tier WITHOUT running the ratchet / persisting.
    const rawTier = rawTierFor(snap.x, snap.landmarks.fullCarry);
    res.json({ rawTier, maxTierFired: prev?.maxTierFired ?? 0, reliable: snap.reliable });
   } catch (e) { next(e); }
  });

  app.use(express.static(join(__dirname, 'public')));
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
  let pollTimer = null;
  function startPolling() {
    if (pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => {
      // Poll-loop error boundary (final-review Important #1): symmetric to the terminal Express
      // error boundary above — the server is a long-lived daemon, so a transient throw here (a bad
      // watcher.poll() frame, or advanceRateLampToCurrent → saveRateLampState → writeJsonAtomic
      // RE-THROWING a disk error like ENOSPC/EACCES/ENOTDIR) must NEVER kill the process. The route
      // path has Express's boundary; this once-per-second timer is the symmetric hole with none.
      // Mirror the flushAll per-iteration guard: log under SW_DEBUG, swallow otherwise; next poll
      // proceeds and the last on-disk checkpoint survives.
      try {
        const { changed } = watcher.poll();
        // v2.1 PR2 SHADOW: advance the canonical fullCarry ledger via the in-memory single writer.
        // No local load-modify-save (round-2 GPT#10 race). Manager checkpoints to disk itself.
        const { ledger } = advanceRateLampToCurrent(watcher, sessionId, { forcePoll: false });
        if (process.env.SW_DEBUG && ledger) console.error('[rate-lamp shadow]', JSON.stringify({ billProgress: ledger.billProgress, cycles: ledger.billCycleCount, paused: ledger.pausedReason, applied: ledger.lastAppliedFoldedCallSeq }));
        if (changed) for (const c of sseClients) c.write(`data: ${JSON.stringify({ type: 'scan' })}\n\n`);
      } catch (e) {
        if (process.env.SW_DEBUG) console.error('[poll]', e);
      }
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
  const { server, startPolling, sseClients, stopTimers, startedAt } = createServer({ watcher, pollIntervalMs: 1000, sessionId });
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
  // SIGINT/SIGTERM flush (round-2 gemini 二.1): checkpoint every in-memory ledger on shutdown. Registered
  // AFTER shutdown() so shutdown's synchronous unlinkSync(STATE_FILE) runs FIRST (STATE_FILE lifecycle
  // preserved), then flushAll() persists the ledgers and the process exits. round-8 gemini#2 (by-design):
  // the hard process.exit(0) is acceptable because server.js is a PROCESS-EXCLUSIVE daemon — its own
  // bootstrap owns the process; there is no shared host whose shutdown this could truncate. Register ONLY
  // here (the bootstrap branch), NEVER inside createServer, so an embedding test/host that imports
  // createServer doesn't inherit a process-killing signal handler.
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { try { flushAll(); } finally { process.exit(0); } });

  // Process-level last-resort boundary (final-review Important #1, belt-and-suspenders): keep the
  // long-lived daemon alive across any throw/rejection the poll-loop try/catch or a route boundary
  // didn't catch — do NOT exit. Registered ONLY here in the bootstrap branch (same rationale as the
  // signal handlers above): an embedding test/host that imports createServer must not inherit a
  // process-level handler that silently swallows ITS crashes. Log under SW_DEBUG, otherwise swallow.
  process.on('uncaughtException', (e) => { if (process.env.SW_DEBUG) console.error('[uncaught]', e); });
  process.on('unhandledRejection', (e) => { if (process.env.SW_DEBUG) console.error('[unhandled]', e); });
}
