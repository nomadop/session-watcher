// Server-boot harness for the carry-staleness telemetry tests (Task 0).
//
// bootTestServer stands up a real in-process app (createServer + a listening http.Server) over a temp DB,
// a temp transcript, and a REAL temp cwd containing real files — so path-resolution / (future) content-hash
// routes have something on disk to resolve. It factors the existing `withServer` skeleton
// (test/server.handoff.test.js) and adds the cwd + the extra accessors the later tasks need.
//
// STORE ISOLATION (decision 4 / brief Step 3 caveat): the app is given an INJECTED store instance
// (createServer's optional `store` param) — its OWN openStore(dbPath) connection — rather than the global
// initStore/getStore singleton. This is the ONLY way two in-process app instances (primary +
// bootSecondConsumer) can hold two independent DatabaseSync handles on the SAME db file: the global
// singleton would clobber the first handle on the second initStore and either teardown's closeStoreGlobal
// would close the connection out from under the other. Production still uses the singleton (a single MCP
// process has exactly one store); this injection is a test-only wiring path.
//
// FOLD-ARCHIVAL CAVEAT: lib/fold.js handleSegmentBoundary archives via `w._store || getStore()`
// (fold.js:129 — Task 9 added w.setStore + the injected-store resolve). Since bootTestServer never calls
// initStore, a fold-driven segment archival (only when a test sets watcher._sessionId AND folds a
// boundary) that has NO w._store resolves getStore() → throws "Store not initialized" → swallowed by
// handleSegmentBoundary's try/catch (logged only under SW_DEBUG). bootTestServer therefore leaves the
// PRIMARY watcher._sessionId UNSET so that archival guard is a no-op; the injected store covers the
// SERVER's own reads/writes (prepare/load, profile_snapshot save, direct store._db queries).
//
// E2E FOLD ARCHIVAL (Task 11): bootSecondConsumer's handle exposes foldLoadHandoffThenArchive /
// foldAutoMatchLoadThenArchive. These wire the consumer's watcher to the consumer's OWN injected store
// (w.setStore(secondStore)) and set w._sessionId, so handleSegmentBoundary resolves w._store — the
// consumer's connection on the SHARED db file — and the archived profile_step_usage / profile_path_event
// rows land in the exact DB the producer's store reads. This is the ONLY store on the consumer side
// (bootSecondConsumer never initStore's a global), so there is no second-connection clobber: TXN1+TXN2
// both hit secondStore, which the producer queries through its own connection to the same file.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { openStore, closeStore } from '../../lib/store.js';
import { createServer } from '../../server.js';
import { makeWatcher, feedReadFull, feedLoadHandoffStep, feedAutoMatchLoadStep, forceSegmentBoundary } from './fold-feed.js';

// Start the primary app instance. opts:
//   sessionId?            — the server's currentSessionId (default 'sid-primary'). Distinct from
//                           watcher._sessionId (which stays unset — see FOLD-ARCHIVAL CAVEAT above).
//   projectId?            — watcher._projectId (default 'proj-boot'); needed by auto-match load.
//   disableTelemetrySweep — default true. The sweep does not exist yet (Task 10); this is a no-op
//                           placeholder accepted now so later tasks can pass it unchanged. teardown
//                           clearTimeout()s any scheduled sweep timer (there is none today).
export async function bootTestServer(opts = {}) {
  // disableTelemetrySweep (default true) is forwarded to createServer (Task 10) so the deferred, unref'd
  // startup sweep timer is never even scheduled mid-test. teardown still clearTimeout()s any scheduled
  // timer via stopTimers() as a belt-and-suspenders.
  const {
    sessionId = 'sid-primary',
    projectId = 'proj-boot',
    disableTelemetrySweep = true,
  } = opts;

  const dir = mkdtempSync(join(tmpdir(), 'sw-boot-'));
  const dbPath = join(dir, 'store.sqlite');
  const cwd = mkdtempSync(join(tmpdir(), 'sw-boot-cwd-'));

  const store = openStore(dbPath);
  // No sessionId on the watcher (fold-archival stays a no-op); cwd + projectId only.
  const watcher = makeWatcher({ projectId, cwd });

  const { server, stopTimers } = createServer({ watcher, pollIntervalMs: 0, sessionId, store, disableTelemetrySweep });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // The startup sweep timer now lives INSIDE createServer (Task 10) and is gated by disableTelemetrySweep
  // (default true here) + cleared by stopTimers() on teardown. This local stays as a defensive no-op so
  // teardown's clearTimeout keeps working even if a future harness schedules its own timer.
  let sweepTimer = null;

  const seconds = [];       // spawned bootSecondConsumer handles (for teardown fan-out)
  const consumerCache = new Map(); // sessionId → second-consumer handle (getAs caching)

  const ctx = {
    store,
    sessionId,
    cwd,
    dbPath,
    port,

    // GET (or POST with { method, body }) a route; returns the parsed JSON body.
    get: (path, reqOpts) => _fetchJson(port, path, reqOpts),

    // POST /api/handoff/prepare; returns the load token (string) or throws with the error body.
    prepareHandoff: async (body) => {
      const resp = await _prepare(port, body);
      if (!resp.load_token) throw new Error(`prepareHandoff failed: ${JSON.stringify(resp)}`);
      return resp.load_token;
    },

    // POST /api/handoff/prepare; returns { token, response } (for asserting the agent-visible shape).
    prepareHandoffFull: async (body) => {
      const response = await _prepare(port, body);
      return { token: response.load_token, response };
    },

    // Fold Read events for the given (cwd-relative) paths into the watcher AND write the corresponding
    // real files under cwd, so they resolve on disk and appear in getBucketData().paths. Returns the list
    // of absolute paths written.
    touchBucketPaths: (paths, { content = 'export const touched = 1;\n'.repeat(12) } = {}) => {
      const abs = [];
      for (const p of paths) {
        const absPath = isAbsolute(p) ? p : join(cwd, p);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, content);
        feedReadFull(watcher, absPath, content);
        abs.push(absPath);
      }
      return abs;
    },

    watcher,

    // A SECOND app instance (its own watcher + currentSessionId) bound to the SAME db file (its own
    // openStore connection) and the same cwd. Returns { get, sessionId, teardown }.
    bootSecondConsumer: async ({ sessionId: secondSid = 'sid-second', projectId: secondPid = projectId } = {}) => {
      const secondStore = openStore(dbPath); // independent connection on the SAME file
      const secondWatcher = makeWatcher({ projectId: secondPid, cwd });
      const { server: s2, stopTimers: stop2 } = createServer({ watcher: secondWatcher, pollIntervalMs: 0, sessionId: secondSid, store: secondStore, disableTelemetrySweep });
      await new Promise(r => s2.listen(0, '127.0.0.1', r));
      const p2 = s2.address().port;
      const handle = {
        sessionId: secondSid,
        port: p2,
        store: secondStore,
        watcher: secondWatcher,
        get: (path, reqOpts) => _fetchJson(p2, path, reqOpts),
        prepareHandoff: async (body) => (await _prepare(p2, body)).load_token,

        // ── Task 11 E2E fold-archival ────────────────────────────────────────────
        // Fold a load_handoff step for `token` into the consumer's watcher, then force a segment
        // boundary so the segment's telemetry (profile_step_usage w/ load_token + profile_path_event)
        // archives. CRUCIAL: bind the watcher to THIS consumer's injected store + arm _sessionId so
        // handleSegmentBoundary resolves `w._store` (fold.js:129) and writes to the shared db file —
        // not the uninitialized global getStore() (which would no-op and yield a vacuous 0-row join).
        // The load must be captured on the SAME segment index the server stamped consumer_segment with
        // (getSegmentIndex at load time). feed*Step folds into the watcher's CURRENT segment; the
        // boundary archives THAT segment and then bumps _segment — so we snapshot the pre-boundary
        // segment as the archived one, matching handoff_load.consumer_segment.
        foldLoadHandoffThenArchive(token) {
          secondWatcher.setStore(secondStore);
          secondWatcher._sessionId = secondSid;
          feedLoadHandoffStep(secondWatcher, { loadToken: token });
          forceSegmentBoundary(secondWatcher);
          return secondWatcher;
        },

        // Auto-match variant: feed a load_handoff step with NO input token + its resolved-token
        // tool_result (exercising Task 6's tool_result → step_usage.load_token back-fill), then archive.
        foldAutoMatchLoadThenArchive(resolvedToken) {
          secondWatcher.setStore(secondStore);
          secondWatcher._sessionId = secondSid;
          feedAutoMatchLoadStep(secondWatcher, { resolvedToken });
          forceSegmentBoundary(secondWatcher);
          return secondWatcher;
        },

        async teardown() {
          try { stop2(); } catch {}
          await new Promise(r => s2.close(r));
          try { closeStore(secondStore); } catch {}
        },
      };
      seconds.push(handle);
      return handle;
    },

    // Sugar: spin up (and cache by sessionId) a second consumer, then GET `path` through it. NOT a
    // header/param trick — currentSessionId is server-closure state, so a second session needs a second
    // app instance. With no `path`, returns the cached consumer handle.
    getAs: async (asSessionId, path, reqOpts) => {
      let consumer = consumerCache.get(asSessionId);
      if (!consumer) {
        consumer = await ctx.bootSecondConsumer({ sessionId: asSessionId });
        consumerCache.set(asSessionId, consumer);
      }
      return path == null ? consumer : consumer.get(path, reqOpts);
    },

    async teardown() {
      if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
      for (const s of seconds) { try { await s.teardown(); } catch {} }
      seconds.length = 0;
      consumerCache.clear();
      try { stopTimers(); } catch {}
      await new Promise(r => server.close(r));
      try { closeStore(store); } catch {}
    },
  };

  return ctx;
}

// ── Internal fetch helpers ──────────────────────────────────────────────────
async function _fetchJson(port, path, { method = 'GET', body, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    init.headers['content-type'] = init.headers['content-type'] || 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return res.json();
}

async function _prepare(port, body) {
  return _fetchJson(port, '/api/handoff/prepare', { method: 'POST', body: body || {} });
}
