// Server-boot harness for the server-level tests, on the post-cutover stack.
//
// It stands up a real in-process app — the host's own `createWatcherComposition` for the shared
// `SessionWatcher`, `createServer` for the wiring, and a listening `http.Server` — over a temp store, a REAL
// temp `cwd` holding real files, and a REAL transcript on disk. The transcript is the Source: nothing here
// pushes measurement state in through a side door, so what a test sets up is what Claude Code would have
// written and what the host acquires through its own driver.
//
// The harness this replaces pushed measurement state straight into private runtime fields. There is no such
// path any more, so `touchBucketPaths` appends real tool rows and lets the host's poll tick acquire them.
//
// STORE ISOLATION: the app is given an INJECTED store — its OWN `openStore(dbPath)` connection — rather than
// the global `initStore`/`getStore` singleton. That is the only way two in-process app instances (primary +
// `bootSecondConsumer`) can hold two independent handles on the SAME db file; the singleton would clobber
// the first on the second init, and either teardown would close the connection out from under the other.
// Production uses the singleton (one MCP process has exactly one store); this injection is test-only wiring.

import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { openStore, closeStore } from '../../lib/store.js';
import { createServer, createWatcherComposition, _setServerTestClock } from '../../server.js';
import { IDLE_HEARTBEAT_MS, DEFAULT_CACHE_TTL } from '../../lib/constants.js';
import { SNAPSHOT_THROTTLE_MS } from '../../server.js';
import {
  ts, chain, usage, userMessage, assistantToolUse, toolResult,
} from './transcript-fixtures.js';

// The prompt-cache lifetime every boot in this harness is measured under. The composition's own default is
// the declaration of whichever process runs the suite, and that lifetime prices the C ratio that reaches
// `br`, `mf`, `dhat` and `wallP` — so the harness states one lifetime rather than inheriting a developer's.
const HARNESS_CACHE_TTL = DEFAULT_CACHE_TTL;

// A Read whose output carries the `N\t` line prefixes the Read adapter parses, so a fed path becomes
// resident content rather than an unattributed residual.
const numberedRead = (content) => content.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n');

// The complete declared surface of the shared application: every named operation a consumer may call, and
// nothing else. Host wiring and the tests below are held to exactly this list.
export const WATCHER_OPERATIONS = [
  'applyHarnessFrame', 'closeCurrentSegment',
  'getStatus', 'getHistory', 'getBucketData', 'getTerminalSnapshot',
  'getCurrentModel', 'getEpochModel', 'getCurrentCtp',
  'prepareHandoff', 'searchHandoffs', 'deliverHandoff',
  'getTurnSkeleton', 'submitTurnNotes',
  'readRateLampFrame', 'readScenario', 'replaceUserOverrides', 'setRatioOverride',
];

/**
 * A facade of the bound named operations, behind a STRICT Proxy.
 *
 * This is the shared test composition seam's enforcement of "consumers use only the Interface": any
 * undeclared string property read and ANY property write throws, so a consumer that reaches for a state
 * field or stamps one reddens here instead of quietly re-growing the private-state coupling the campaign
 * removed. Symbol reads pass through — the runtime itself probes those, and they name no application state.
 *
 * @param {object} watcher a real `SessionWatcher`
 * @returns {object} the guarded facade
 */
export function strictWatcherFacade(watcher) {
  const target = Object.create(null);
  for (const name of WATCHER_OPERATIONS) {
    if (typeof watcher[name] !== 'function') throw new Error(`SessionWatcher is missing ${name}`);
    target[name] = watcher[name].bind(watcher);
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string' && !(prop in obj)) {
        throw new Error(`SessionWatcher facade: undeclared read of "${prop}"`);
      }
      return obj[prop];
    },
    set(obj, prop) { throw new Error(`SessionWatcher facade: write to "${String(prop)}"`); },
    defineProperty(obj, prop) { throw new Error(`SessionWatcher facade: write to "${String(prop)}"`); },
  });
}

let seq = 0;

// The MCP tool name the load-token telemetry keys on: the rule is a `load_handoff` SUFFIX, so the plugin
// prefix is carried verbatim rather than re-derived here.
const LOAD_HANDOFF_TOOL = 'mcp__plugin_session-watcher_session-watcher__load_handoff';

// One measured step whose tool use is a handoff load. `explicitToken` puts the token in the tool INPUT;
// `resolvedToken` leaves the input tokenless and puts it in the RESULT, which is the auto-match back-fill.
let loadSeq = 0;
function loadHandoffRows({ explicitToken = null, resolvedToken = null, parentUuid = null } = {}) {
  const tag = `ld${++loadSeq}`;
  const input = explicitToken ? { load_token: explicitToken } : {};
  const result = resolvedToken ? JSON.stringify({ found: true, load_token: resolvedToken }) : 'loaded';
  // The parent is REQUIRED in practice: a null-parent row appended to a Source that already holds a call is
  // a topology root with that call behind it, which is a compact epoch — it would close the segment the load
  // was stamped against and land the step in the next one.
  return chain([
    assistantToolUse({
      uuid: `u-${tag}`, parentUuid, messageId: `m-${tag}`, toolUseId: `t-${tag}`,
      name: LOAD_HANDOFF_TOOL, input, timestamp: ts(20),
      usage: usage({ input: 60, output: 25, cacheRead: 90000 + loadSeq * 500 }),
    }),
    toolResult({ uuid: `r-${tag}`, toolUseId: `t-${tag}`, content: result }),
  ]);
}

// The idle gate skips an installed-driver tick whose last advance was recent, which is exactly what makes two
// appends in the same millisecond collapse into one. Test pumps therefore step a monotonic clock forward each
// time, past BOTH gated thresholds — the heartbeat gate and the profile-snapshot throttle — so a pump is a
// tick the gate lets through and a changed pump reaches the snapshot write. The clock starts beyond real time
// because bootstrap stamped its own timestamps from `performance.now()` before any test clock existed, and a
// smaller value would read as time running backwards. Real time is restored on teardown; a test that drives
// either gate itself sets its own clock and is unaffected.
const PUMP_STEP_MS = Math.max(IDLE_HEARTBEAT_MS, SNAPSHOT_THROTTLE_MS) + 1;
let pumpClock = null;
function pumpTick(handle) {
  if (pumpClock === null) pumpClock = performance.now() + PUMP_STEP_MS;
  pumpClock += PUMP_STEP_MS;
  _setServerTestClock(pumpClock);
  handle.runPollTick();
}

/**
 * A chained run of measured steps, optionally making some paths resident through real Read tool pairs.
 *
 * Everything is one topology: the first row is the only root. That is load-bearing — a null-parent root with
 * a call behind it IS a compact epoch, so a fixture assembled from the builders' defaults would open an
 * epoch on every row after its first call and leave each segment holding a single step.
 *
 * @param {{ steps?: number, paths?: string[], content?: string, model?: string, cacheReadStart?: number }} spec
 * @returns {object[]} chained fixture entries
 */
export function measuredTranscript({
  steps = 1, paths = [], content = 'export const touched = 1;\n'.repeat(12),
  model = 'deepseek-v4-pro', laterModel = null, cacheReadStart = 42000, extraEntries = [],
} = {}) {
  const rows = [];
  let cacheRead = cacheReadStart;
  paths.forEach((absPath, i) => {
    cacheRead += 940;
    rows.push(assistantToolUse({
      uuid: `p${i}`, messageId: `pm${i}`, toolUseId: `pt${i}`, name: 'Read',
      input: { file_path: absPath }, timestamp: ts(1), model,
      usage: usage({ input: 560, output: 380, cacheRead }),
    }));
    rows.push(toolResult({ uuid: `pr${i}`, toolUseId: `pt${i}`, content: numberedRead(content) }));
  });
  for (let i = 0; i < steps; i++) {
    cacheRead += 940;
    // `laterModel` makes the LATEST measured step's identity differ from the epoch's, which is the only shape
    // that can tell an epoch-model read apart from a latest-model one.
    rows.push(assistantToolUse({
      uuid: `s${i}`, messageId: `sm${i}`, toolUseId: `st${i}`, name: 'Bash',
      input: { command: `echo ${i}` }, timestamp: ts(2),
      model: (laterModel && i > 0) ? laterModel : model,
      usage: usage({ input: 560, output: 380, cacheRead }),
    }));
    rows.push(toolResult({ uuid: `sr${i}`, toolUseId: `st${i}`, content: `out ${i}` }));
  }
  for (const entry of extraEntries) rows.push(entry);
  rows[0].parentUuid = null;
  return chain(rows);
}

/** Write `measuredTranscript` output to a fresh temp file and return its path. */
export function writeMeasuredTranscript(spec = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-fixture-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, measuredTranscript(spec).map(r => JSON.stringify(r) + '\n').join(''));
  return path;
}

/**
 * Compose the post-cutover stack around a transcript that ALREADY exists on disk, and return the host handle
 * without listening. For the tests that only need `createServer` over one fixture.
 *
 * The store is REQUIRED now — the shared application takes it as a construction dependency — so a temp
 * database is opened per call rather than left to the global singleton.
 *
 * @returns {{ handle, watcher, store, dir, teardown }}
 */
export function composeForTranscript({
  transcriptPath, sessionId = 'test-session', projectId = null, projectRoot = null,
  pollIntervalMs = 0, projectsRoot = null, ratioOverride = null, disableTelemetrySweep = true,
  guard = true, cacheTtl = HARNESS_CACHE_TTL, ...rest
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-compose-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const store = openStore(join(dir, 'store.sqlite'));
  // One lifetime on BOTH sides — the measured composition and the host reporting its price — so a case that
  // wants another one names it once and the pair cannot drift apart.
  const watcher = createWatcherComposition({
    sessionId, sourceLocator: transcriptPath, projectId, projectRoot, stateDir, store, isIgnored: null,
    cacheTtl,
  });
  const handle = createServer({
    watcher: guard ? strictWatcherFacade(watcher) : watcher,
    pollIntervalMs, sessionId, sourceLocator: transcriptPath,
    projectsRoot: projectsRoot ?? dirname(transcriptPath),
    projectRoot, projectId, stateDir, store, ratioOverride, cacheTtl, disableTelemetrySweep, ...rest,
  });
  return {
    handle, watcher, store, dir, stateDir, transcriptPath,
    // Append more rows to the Source and let the host's own tick acquire them. The rows are chained onto the
    // previous leaf, because a null-parent row would be a topology root and therefore a compact epoch.
    appendRows: (rows, { parentUuid = null } = {}) => {
      if (rows.length > 0 && rows[0].parentUuid == null && parentUuid) rows[0].parentUuid = parentUuid;
      chain(rows);
      appendFileSync(transcriptPath, rows.map(row => JSON.stringify(row) + '\n').join(''));
      pumpTick(handle);
      return rows;
    },
    pump: () => pumpTick(handle),
    teardown: async () => {
      _setServerTestClock(null);
      try { handle.stopTimers(); } catch { /* already stopped */ }
      await new Promise(r => handle.server.close(r));
      try { closeStore(store); } catch { /* already closed */ }
    },
  };
}

export async function bootTestServer(opts = {}) {
  const {
    sessionId = 'sid-primary',
    projectId = 'proj-boot',
    disableTelemetrySweep = true,
    // throwingTurnPage: inject a turnPageBuilder that always throws, for failure-isolation tests.
    throwingTurnPage = false,
    // dialogueSource: inject a DialogueSource Adapter — a throwing or unavailable one — for the tests that
    // pin which operations read a Source at all.
    dialogueSource = null,
    // Entries the transcript already holds when the owner boots. The default is one complete step, so the
    // very first synchronous bootstrap has a readable Source with a measured call.
    entries = null,
  } = opts;

  const dir = mkdtempSync(join(tmpdir(), 'sw-boot-'));
  const dbPath = join(dir, 'store.sqlite');
  const cwd = mkdtempSync(join(tmpdir(), 'sw-boot-cwd-'));
  // Injected, not inherited: createServer falls back to PORT_DIR (~/.session-watcher), and the Turn Note
  // capture writes its two files beneath the state dir — a test must never reach the real install.
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  // The transcript lives where the host's own locator resolution looks for it: `<projectsRoot>/<sid>.jsonl`.
  const projectsRoot = join(dir, 'projects');
  mkdirSync(projectsRoot, { recursive: true });
  const transcriptPath = join(projectsRoot, `${sessionId}.jsonl`);

  const store = openStore(dbPath);

  let rowSeq = 0;
  const nextUuid = (label) => `${label}-${++rowSeq}`;
  // The leaf every later append hangs from. `chain` leaves a null parent alone and a null-parent root with a
  // call behind it IS a compact epoch, so an appended run that did not name its predecessor would open an
  // epoch on its first row and reset measurement — the all-roots trap of the builders' own defaults.
  let leafUuid = null;
  const append = (rows) => {
    if (rows.length > 0 && rows[0].parentUuid == null && leafUuid) rows[0].parentUuid = leafUuid;
    chain(rows);
    appendFileSync(transcriptPath, rows.map(row => JSON.stringify(row) + '\n').join(''));
    leafUuid = rows[rows.length - 1]?.uuid ?? leafUuid;
    return rows;
  };

  // One opening step so the Source is readable and measurement has a call before the first read.
  const openingEntries = entries ?? chain([
    userMessage({ uuid: 'u-open', parentUuid: null, text: 'open the session', timestamp: ts(1) }),
    assistantToolUse({
      uuid: 'a-open', messageId: 'm-open', toolUseId: 'tu-open', name: 'Read',
      input: { file_path: join(cwd, 'opening.js') }, timestamp: ts(2), text: 'reading',
      usage: usage({ input: 500, output: 20, cacheRead: 20000 }),
    }),
    toolResult({ uuid: 'r-open', toolUseId: 'tu-open', content: numberedRead('export const opening = 1;') }),
  ]);
  writeFileSync(join(cwd, 'opening.js'), 'export const opening = 1;\n');
  writeFileSync(transcriptPath, openingEntries.map(row => JSON.stringify(row) + '\n').join(''));
  leafUuid = openingEntries[openingEntries.length - 1]?.uuid ?? null;

  const watcher = createWatcherComposition({
    sessionId,
    sourceLocator: transcriptPath,
    projectId,
    projectRoot: cwd,
    stateDir,
    store,
    isIgnored: null,
    cacheTtl: HARNESS_CACHE_TTL,
    ...(dialogueSource ? { dialogueSource } : {}),
  });

  const resolvedTurnPageBuilder = throwingTurnPage
    ? () => { throw new Error('turn page unavailable'); }
    : undefined;
  // The host is handed the GUARDED facade, not the watcher: if any wire reached for a state field or wrote
  // one, every test that boots through here would redden on that read.
  const handle = createServer({
    watcher: strictWatcherFacade(watcher),
    pollIntervalMs: 0,
    sessionId,
    projectsRoot,
    sourceLocator: transcriptPath,
    store,
    stateDir,
    cacheTtl: HARNESS_CACHE_TTL,
    disableTelemetrySweep,
    ...(dialogueSource ? { dialogueSource } : {}),
    ...(resolvedTurnPageBuilder ? { turnPageBuilder: resolvedTurnPageBuilder } : {}),
  });
  const { server, stopTimers, turnService, turnReadService, runPollTick, doRotation } = handle;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // Listen-time discovery creation, exactly where the real owners do it: the record needs the assigned port.
  handle.publishDiscovery();

  const seconds = [];
  const consumerCache = new Map();

  // Handed out GUARDED: a test that reaches for a state field or stamps one reddens on that read, the same
  // way host wiring does. `switchSource` below is how a test repoints the Source instead.
  const guardedWatcher = strictWatcherFacade(watcher);

  const ctx = {
    store,
    sessionId,
    cwd,
    dbPath,
    stateDir,
    port,
    projectsRoot,
    transcriptPath,
    watcher: guardedWatcher,
    turnService,
    turnReadService,
    doRotation,

    // Repoint the application at a DIFFERENT Source. A `replace` carrying no batches swaps the locator and
    // installs fresh measurement state, which is exactly what an inode replacement does — and it is the only
    // way to move the Source, since `applyHarnessFrame` is the sole source-state mutation Interface.
    switchSource: (path) => guardedWatcher.applyHarnessFrame({
      transition: 'replace', sourceLocator: path, batches: [], sourceObserved: true, captureMode: 'replay',
    }),

    // Drive one host poll tick, exactly the one bootstrap and the recurring timer use.
    pump: () => pumpTick(handle),

    // The Transcript Playback controller the host's own replay route created, so a test drives its steps and
    // reads the ledger the playback status branch merges.
    replayController: () => handle.replayController(),

    get: (path, reqOpts) => _fetchJson(port, path, reqOpts),
    request: (path, reqOpts = {}) => _fetchJson(port, path, reqOpts),

    requestRaw: async (path, { method = 'GET', body, headers } = {}) => {
      const init = { method, headers: { ...(headers || {}) } };
      if (body !== undefined) {
        init.headers['content-type'] = init.headers['content-type'] || 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      return fetch(`http://127.0.0.1:${port}${path}`, init);
    },

    prepareHandoff: async (body) => {
      const resp = await _prepare(port, body);
      if (!resp.load_token) throw new Error(`prepareHandoff failed: ${JSON.stringify(resp)}`);
      return resp.load_token;
    },

    prepareHandoffFull: async (body) => {
      const response = await _prepare(port, body);
      return { token: response.load_token, response };
    },

    // Append rows to the transcript and let the host acquire them. Returns the appended entries so a caller
    // can chain further rows onto the leaf it left.
    appendRows: (rows) => { const written = append(rows); pumpTick(handle); return written; },

    // Make each (cwd-relative) path resident: write the real file, append a Read tool use plus its result
    // carrying the file's own numbered lines, then let the host's tick acquire them. Returns the absolute
    // paths written. Every path rides ONE issuing step, so a caller gets one measured call per call here.
    touchBucketPaths: (paths, { content = 'export const touched = 1;\n'.repeat(12) } = {}) => {
      const abs = [];
      const rows = [];
      const label = `touch${++seq}`;
      const stepUuid = nextUuid(label);
      const toolUses = [];
      const results = [];
      for (const p of paths) {
        const absPath = isAbsolute(p) ? p : join(cwd, p);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, content);
        abs.push(absPath);
        const toolUseId = nextUuid(`${label}-tu`);
        toolUses.push({ toolUseId, absPath });
        results.push(toolResult({
          uuid: nextUuid(`${label}-r`), toolUseId, content: numberedRead(content),
        }));
      }
      // One assistant row per tool use keeps each Read on its own native row, which is the shape a real
      // transcript has; the LAST one carries the usage that settles them.
      toolUses.forEach(({ toolUseId, absPath }, i) => {
        rows.push(assistantToolUse({
          uuid: i === 0 ? stepUuid : nextUuid(label),
          messageId: `${label}-msg`,
          toolUseId, name: 'Read', input: { file_path: absPath },
          timestamp: ts(10 + seq),
          ...(i === toolUses.length - 1
            ? { usage: usage({ input: 40, output: 30, cacheRead: 20000 + seq * 1000 }) }
            : {}),
        }));
        rows.push(results[i]);
      });
      append(rows);
      pumpTick(handle);
      return abs;
    },

    bootSecondConsumer: async ({ sessionId: secondSid = 'sid-second', projectId: secondPid = projectId } = {}) => {
      const secondStore = openStore(dbPath);   // independent connection on the SAME file
      const secondTranscript = join(projectsRoot, `${secondSid}.jsonl`);
      writeFileSync(secondTranscript, openingEntries.map(row => JSON.stringify(row) + '\n').join(''));
      const secondLeafUuid = openingEntries[openingEntries.length - 1]?.uuid ?? null;
      const secondWatcher = createWatcherComposition({
        sessionId: secondSid,
        sourceLocator: secondTranscript,
        projectId: secondPid,
        projectRoot: cwd,
        stateDir,
        store: secondStore,
        isIgnored: null,
        cacheTtl: HARNESS_CACHE_TTL,
      });
      const second = createServer({
        watcher: secondWatcher, pollIntervalMs: 0, sessionId: secondSid, projectsRoot,
        store: secondStore, stateDir, cacheTtl: HARNESS_CACHE_TTL, disableTelemetrySweep,
      });
      await new Promise(r => second.server.listen(0, '127.0.0.1', r));
      const p2 = second.server.address().port;
      second.publishDiscovery();
      const consumer = {
        sessionId: secondSid,
        port: p2,
        store: secondStore,
        watcher: secondWatcher,
        transcriptPath: secondTranscript,
        get: (path, reqOpts) => _fetchJson(p2, path, reqOpts),
        prepareHandoff: async (body) => (await _prepare(p2, body)).load_token,
        pump: () => pumpTick(second),

        // Close the consumer's current segment through the shared archival path, so the segment the load was
        // stamped against persists its profile and telemetry to the shared db file.
        closeSegment() { secondWatcher.closeCurrentSegment({ captureMode: 'live' }); return secondWatcher; },

        // A `load_handoff` MCP tool use carrying the token EXPLICITLY, then the segment's archival. The token
        // reaches Segment Telemetry as the issuing step's first load token, which is what the offline join
        // reads off `profile_step_usage`. Appending real rows is the only route: there is no seam that pushes
        // a load token into measurement.
        foldLoadHandoffThenArchive(token) {
          appendFileSync(secondTranscript, loadHandoffRows({ explicitToken: token, parentUuid: secondLeafUuid }).map(r => JSON.stringify(r) + '\n').join(''));
          pumpTick(second);
          secondWatcher.closeCurrentSegment({ captureMode: 'live' });
          return secondWatcher;
        },

        // The AUTO-MATCH variant: the tool use names no token and the RESULT carries the resolved one, which
        // is the back-fill path.
        foldAutoMatchLoadThenArchive(resolvedToken) {
          appendFileSync(secondTranscript, loadHandoffRows({ resolvedToken, parentUuid: secondLeafUuid }).map(r => JSON.stringify(r) + '\n').join(''));
          pumpTick(second);
          secondWatcher.closeCurrentSegment({ captureMode: 'live' });
          return secondWatcher;
        },

        async teardown() {
          try { second.stopTimers(); } catch { /* already stopped */ }
          await new Promise(r => second.server.close(r));
          try { closeStore(secondStore); } catch { /* already closed */ }
        },
      };
      seconds.push(consumer);
      return consumer;
    },

    // Sugar: spin up (and cache by sessionId) a second consumer, then GET `path` through it. Not a header
    // trick — `currentSessionId` is server-closure state, so a second session needs a second app instance.
    getAs: async (asSessionId, path, reqOpts) => {
      let consumer = consumerCache.get(asSessionId);
      if (!consumer) {
        consumer = await ctx.bootSecondConsumer({ sessionId: asSessionId });
        consumerCache.set(asSessionId, consumer);
      }
      return path == null ? consumer : consumer.get(path, reqOpts);
    },

    async teardown() {
      _setServerTestClock(null);
      for (const s of seconds) { try { await s.teardown(); } catch { /* already torn down */ } }
      seconds.length = 0;
      consumerCache.clear();
      try { stopTimers(); } catch { /* already stopped */ }
      await new Promise(r => server.close(r));
      try { closeStore(store); } catch { /* already closed */ }
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
