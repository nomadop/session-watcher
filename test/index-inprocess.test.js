import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(__dirname, '..', 'index.js');

function usageLine(cacheRead) {
  return JSON.stringify({
    type: 'assistant', message: { id: `msg-${Math.random().toString(36).slice(2)}` },
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
    model: 'claude-sonnet-4-20250514',
  });
}

// One measured step and its tool result, CHAINED onto `parent`. Chaining is load-bearing: a null-parent row is
// a topology root and a root with a call behind it is a compact epoch, so an unchained append would open an
// epoch per row once the first call has landed.
let stepSeq = 0;
function measuredStep(parent, cacheRead) {
  const tag = `ix${++stepSeq}`;
  return [
    JSON.stringify({
      type: 'assistant', uuid: `u-${tag}`, parentUuid: parent, isSidechain: false,
      timestamp: `2026-07-01T00:00:0${Math.min(9, stepSeq)}Z`,
      message: {
        id: `m-${tag}`, role: 'assistant', model: 'claude-sonnet-4-20250514',
        content: [{ type: 'tool_use', id: `t-${tag}`, name: 'Bash', input: { command: `echo ${tag}` } }],
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
      },
    }),
    JSON.stringify({
      type: 'user', uuid: `r-${tag}`, parentUuid: `u-${tag}`, isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${tag}`, content: `out ${tag}` }] },
    }),
  ].map(line => line + '\n').join('');
}
const leafOf = () => `r-ix${stepSeq}`;

// The persisted Rate Lamp ledger for one session, read through a fresh connection on the child's own store.
async function readLedger(home, sessionId) {
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(join(home, '.session-watcher', 'store.sqlite'));
  try {
    const row = store._db
      .prepare('SELECT value FROM state WHERE session_id = ? AND key = ?')
      .get(sessionId, 'ledger');
    return row ? JSON.parse(row.value) : null;
  } finally { closeStore(store); }
}

// Hold an SSE connection open against the owner named by its discovery record, so its poll ticks are never
// suppressed by the idle gate. Returns the controller that closes it.
async function attachSseClient(stateFile) {
  const { port } = JSON.parse(readFileSync(stateFile, 'utf8'));
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: controller.signal });
  // The body is never read; the server only needs a connected client to count.
  void res;
  return controller;
}

// The child's exit code, as a promise. NOT via `waitFor`: a normal exit code is 0, and `waitFor` treats a
// falsy result as "not yet" — so polling for it would time out on exactly the success case.
function exitCodeOf(child, timeoutMs = 8000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise(resolve => child.once('exit', (code) => resolve(code))),
    sleep(timeoutMs).then(() => 'timeout'),
  ]);
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

function spawnMcp(env) {
  return spawn(process.execPath, [INDEX_JS], {
    env: { ...process.env, ...env, SW_NO_OPEN: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('SW_INPROCESS=1: MCP writes state file with clientPid on startup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-inproc-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  // resolveBySessionId looks at join(HOME, '.claude', 'projects')
  const projDir = join(dir, '.claude', 'projects', 'enc');
  mkdirSync(projDir, { recursive: true });
  const sessionId = `test-inproc-${Date.now()}`;
  const transcriptPath = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, usageLine(1000) + '\n');

  const child = spawnMcp({
    SW_STATE_DIR: stateDir,
    CLAUDE_CODE_SESSION_ID: sessionId,
    HOME: dir,
  });

  const stateFile = join(stateDir, `${sessionId}.json`);
  let attempts = 0;
  while (!existsSync(stateFile) && attempts < 30) {
    await sleep(100);
    attempts++;
  }

  try {
    assert.ok(existsSync(stateFile), 'state file should be written');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.sessionId, sessionId);
    // clientPid = process.ppid of the MCP child = our (test runner's) process.pid
    assert.equal(state.clientPid, process.pid);
    assert.ok(state.port > 0);
    assert.ok(state.transcriptPath.includes(sessionId));
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
  }
});

test('SW_INPROCESS=1: state file removed on SIGTERM (exit cleanup)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-inproc-cleanup-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projDir = join(dir, '.claude', 'projects', 'enc');
  mkdirSync(projDir, { recursive: true });
  const sessionId = `test-cleanup-${Date.now()}`;
  const transcriptPath = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(transcriptPath, usageLine(1000) + '\n');

  const child = spawnMcp({
    SW_STATE_DIR: stateDir,
    CLAUDE_CODE_SESSION_ID: sessionId,
    HOME: dir,
  });

  const stateFile = join(stateDir, `${sessionId}.json`);
  let attempts = 0;
  while (!existsSync(stateFile) && attempts < 30) {
    await sleep(100);
    attempts++;
  }
  assert.ok(existsSync(stateFile), 'state file written before kill');

  child.kill('SIGTERM');
  await sleep(500);
  assert.ok(!existsSync(stateFile), 'state file removed after SIGTERM');
});

// ── normal shutdown Rate Lamp checkpoint ─────────────────────────────────────
// The delta: a normal shutdown flushes pending Rate Lamp progress BEFORE the Store closes, and a restart
// restores that integral without re-integrating the samples it already covers. Baseline lost the pending
// write-behind state at Store close, so the integral was only ever as current as the last coalesced write.
test('[delta] normal shutdown persists pending Rate Lamp progress before Store close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-inproc-flush-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projDir = join(dir, '.claude', 'projects', 'enc');
  mkdirSync(projDir, { recursive: true });
  const sessionId = `test-flush-${Date.now()}`;
  const transcriptPath = join(projDir, `${sessionId}.jsonl`);
  const env = { SW_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: sessionId, HOME: dir };

  // The Source opens with one step. The owner's first frame is a stream discontinuity, so it anchors at that
  // tail and integrates nothing; the two appends below are the calls that actually produce an integral.
  writeFileSync(transcriptPath, measuredStep(null, 20000));

  const first = spawnMcp(env);
  const stateFile = join(stateDir, `${sessionId}.json`);
  let watcher = null;
  let liveAtShutdown = 0;
  try {
    assert.ok(await waitFor(() => existsSync(stateFile)), 'the owner started');
    // An attached SSE client, as an open dashboard is. The idle gate suppresses an installed-driver tick whose
    // last advance was recent whenever NO client needs a push, so without one the appends below would wait out
    // the whole heartbeat window instead of being polled.
    watcher = await attachSseClient(stateFile);
    // Two further calls with a large L, so the trapezoid clears the ledger's 1e-6 progress quantum.
    appendFileSync(transcriptPath, measuredStep(leafOf(), 300000));
    await sleep(1400);
    appendFileSync(transcriptPath, measuredStep(leafOf(), 600000));
    await sleep(1400);
    // A THIRD call, so there is a newest integral for the flush to be responsible for.
    appendFileSync(transcriptPath, measuredStep(leafOf(), 900000));
    await sleep(1100);
    // The LIVE integral, read over HTTP while the owner still holds it in memory. This is the by-construction
    // anchor: what must survive is not "more than the write-behind happened to manage", which depends on a
    // timer cadence, but the live value ITSELF — and only a flush before Store close can promise that.
    const { port } = JSON.parse(readFileSync(stateFile, 'utf8'));
    const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    liveAtShutdown = status.rateLamp?.billProgress ?? 0;
    assert.ok(liveAtShutdown > 0, 'precondition: the owner really is holding an integral in memory');
  } finally {
    if (watcher) watcher.abort();
    first.kill('SIGTERM');
  }
  await waitFor(() => !existsSync(stateFile));
  await sleep(300);

  const persisted = await readLedger(dir, sessionId);
  assert.ok(persisted, 'the ledger was persisted before the Store closed');
  assert.ok(persisted.billProgress > 0,
    `the latest integral survived a normal shutdown (got ${persisted.billProgress})`);
  // BY CONSTRUCTION: what persisted is the value the owner was holding LIVE at shutdown, not merely whatever
  // the write-behind had last managed. No coalesced-write cadence can promise that — only a flush ordered
  // before Store close can — so this holds regardless of how the timer happened to interleave.
  assert.equal(persisted.billProgress, liveAtShutdown,
    'the persisted integral is the one the owner held at shutdown');

  // Restart on the SAME store and Source. The persisted ledger is the sole accumulated-integral authority, and
  // the restart's first frame is an unseen revision — so it reanchors at the history tail and integrates
  // NOTHING, rather than replaying the samples the integral already covers.
  const second = spawnMcp(env);
  try {
    assert.ok(await waitFor(() => existsSync(stateFile)), 'the owner restarted');
    await sleep(1400);
  } finally {
    second.kill('SIGTERM');
  }
  await waitFor(() => !existsSync(stateFile));
  await sleep(300);

  const afterRestart = await readLedger(dir, sessionId);
  assert.ok(afterRestart, 'the restarted owner persisted its ledger too');
  assert.equal(afterRestart.billProgress, persisted.billProgress,
    'the restart restored the integral without integrating historical samples');
  assert.equal(afterRestart.billCycleCount, persisted.billCycleCount,
    'and the lifetime cycle count came back unchanged with it');
});

// An assistant row whose usage carries a NEGATIVE token count. It decodes and reduces normally — the reducer
// passes token values through untouched — and fails the Engine's own non-negative invariant when the record is
// ingested. So it is an unclassified APPLICATION failure reached from the Source, which is the shape the delta
// is about, rather than an injected throw.
function invalidUsageStep(parent) {
  return JSON.stringify({
    type: 'assistant', uuid: 'u-bad', parentUuid: parent, isSidechain: false,
    timestamp: '2026-07-01T00:00:09Z',
    message: {
      id: 'm-bad', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [],
      usage: { input_tokens: -5, output_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 },
    },
  }) + '\n';
}

const profilesOf = async (home, sessionId) => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(join(home, '.session-watcher', 'store.sqlite'));
  try { return store.getProfileSegments(sessionId); } finally { closeStore(store); }
};

// Both provenance halves of every archived segment, keyed by segment. `capture_source` names the reader that
// produced the telemetry and `archive_source` the path that closed the segment, so a row is only wholly
// attributed when the pair agrees.
const provenanceOf = async (home, sessionId) => {
  const { openStore, closeStore } = await import('../lib/store.js');
  const store = openStore(join(home, '.session-watcher', 'store.sqlite'));
  try {
    const rows = store._db
      .prepare('SELECT segment, archive_source, capture_source FROM profile WHERE session_id = ? ORDER BY segment')
      .all(sessionId);
    return Object.fromEntries(rows.map(r => [r.segment, [r.archive_source, r.capture_source]]));
  } finally { closeStore(store); }
};

// A null-parent topology root with a call behind it, which is the only evidence that opens an epoch.
const compactRoot = (uuid, second) => JSON.stringify({
  type: 'user', uuid, parentUuid: null, isSidechain: false, isCompactSummary: true,
  timestamp: `2026-07-01T00:00:0${second}Z`, message: { role: 'user', content: 'summary' },
}) + '\n';

// A sandbox shared by the lifecycle cases below: its own HOME, state dir, session id and Source.
function sandbox(label) {
  const dir = mkdtempSync(join(tmpdir(), `sw-inproc-${label}-`));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const projDir = join(dir, '.claude', 'projects', 'enc');
  mkdirSync(projDir, { recursive: true });
  const sessionId = `${label}-${Date.now()}`;
  const transcriptPath = join(projDir, `${sessionId}.jsonl`);
  return {
    dir, stateDir, sessionId, transcriptPath,
    stateFile: join(stateDir, `${sessionId}.json`),
    env: { SW_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: sessionId, HOME: dir },
  };
}

test('[delta] an unclassified application exception is owner-fatal instead of discarding one native row and continuing', async () => {
  const box = sandbox('ownerfatal');
  // A closed epoch first, so there IS previously archived history to preserve, then a populated open segment,
  // then the offending row.
  writeFileSync(box.transcriptPath,
    measuredStep(null, 20000)
    + JSON.stringify({ type: 'user', uuid: 'c-of', parentUuid: null, isSidechain: false,
      isCompactSummary: true, timestamp: '2026-07-01T00:00:05Z',
      message: { role: 'user', content: 'summary' } }) + '\n'
    + measuredStep('c-of', 25000));

  const child = spawnMcp(box.env);
  let watcher = null;
  const exit = new Promise(resolve => child.on('exit', (code) => resolve(code)));
  try {
    assert.ok(await waitFor(() => existsSync(box.stateFile)), 'the owner started');
    const closedBefore = await profilesOf(box.dir, box.sessionId);
    assert.ok(closedBefore.length >= 1, 'precondition: an epoch archived during bootstrap');

    watcher = await attachSseClient(box.stateFile);
    const bytesBefore = readFileSync(box.transcriptPath, 'utf8');
    appendFileSync(box.transcriptPath, invalidUsageStep(leafOf()));

    // The owner exits NONZERO rather than dropping the row and carrying on.
    const code = await Promise.race([exit, sleep(8000).then(() => 'timeout')]);
    assert.notEqual(code, 'timeout', 'the owner exited rather than continuing');
    assert.notEqual(code, 0, 'and it exited nonzero: this is owner-fatal, not a normal shutdown');

    // The open segment is NOT archived — owner-fatal cleanup skips current-segment finalization — while the
    // previously closed segments and the Source itself are untouched, so a fresh owner can rebuild.
    const closedAfter = await profilesOf(box.dir, box.sessionId);
    assert.deepEqual(closedAfter.map(p => p.segment), closedBefore.map(p => p.segment),
      'the open segment did not archive and no closed segment changed');
    assert.equal(readFileSync(box.transcriptPath, 'utf8').startsWith(bytesBefore), true,
      'the Source is unchanged: nothing was rewritten or truncated');
  } finally {
    if (watcher) watcher.abort();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('stdin EOF starts the grace period, and HTTP, discovery and polling stay active until it expires', async () => {
  const box = sandbox('grace');
  writeFileSync(box.transcriptPath, measuredStep(null, 20000));
  // A grace window long enough to observe, short enough not to stall the suite.
  const child = spawnMcp({ ...box.env, SW_GRACE_MS: '4000' });
  let watcher = null;
  try {
    assert.ok(await waitFor(() => existsSync(box.stateFile)), 'the owner started');
    const { port } = JSON.parse(readFileSync(box.stateFile, 'utf8'));

    // First EOF starts the grace timer. Later EOFs do nothing, which is why closing once is enough.
    child.stdin.end();
    await sleep(400);

    // HTTP is still answering and discovery is still published.
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok, true,
      'HTTP stays active during the grace period');
    assert.ok(existsSync(box.stateFile), 'and discovery stays published');

    // Polling stays active too: a later Source append is processed BEFORE expiry.
    watcher = await attachSseClient(box.stateFile);
    const before = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).apiCalls;
    appendFileSync(box.transcriptPath, measuredStep(leafOf(), 40000));
    const grew = await waitFor(async () => {
      const now = (await (await fetch(`http://127.0.0.1:${port}/api/status`)).json()).apiCalls;
      return now > before ? now : null;
    }, 3000);
    assert.ok(grew, 'the append was polled and measured inside the grace window');

    // On expiry the owner runs cleanup once and exits NORMALLY.
    const code = await exitCodeOf(child, 6000);
    assert.equal(code, 0, 'grace expiry exits normally');
    assert.ok(!existsSync(box.stateFile), 'and cleanup removed its discovery record');
  } finally {
    if (watcher) watcher.abort();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('SIGTERM during the grace period interrupts it, removes discovery, and exits normally', async () => {
  const box = sandbox('gracesig');
  writeFileSync(box.transcriptPath, measuredStep(null, 20000));
  // A grace window far longer than this test: the point is that SIGTERM does not wait for it.
  const child = spawnMcp({ ...box.env, SW_GRACE_MS: '600000' });
  try {
    assert.ok(await waitFor(() => existsSync(box.stateFile)), 'the owner started');
    child.stdin.end();
    await sleep(400);
    assert.ok(existsSync(box.stateFile), 'still alive inside the grace window');

    child.kill('SIGTERM');
    const code = await exitCodeOf(child, 6000);
    assert.equal(code, 0, 'SIGTERM bypasses the grace period and exits normally');
    assert.ok(!existsSync(box.stateFile), 'cleanup ran and removed discovery');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

// The store must be open before the composition reads the Source. The owner's synchronous bootstrap applies
// the whole Source and crosses every epoch the file already holds, archiving through the store the composition
// was GIVEN — so an entrypoint that opens the store after composing has nothing for that archival to reach.
// The segment still rotates, so no later epoch and no shutdown finalization revisits it, and startup
// maintenance excludes the live session by construction: that profile is gone for good, with nothing logged
// and every other reply identical. The missing row is the only witness, which is what this asserts.
//
// Provenance is the discriminator, not row presence: a bootstrap segment is RECONSTRUCTED from bytes that were
// already on disk, so it carries replay provenance, while an epoch a later poll tick crosses is witnessed as it
// happens and carries live. A row written by the wrong path would satisfy a presence check and fail here.
test('the in-process owner archives its bootstrap segment as a replay and a later epoch as live', async () => {
  const box = sandbox('bootprov');
  // Segment 0 closes INSIDE the synchronous bootstrap: two measured steps, then the root that ends them.
  writeFileSync(box.transcriptPath,
    measuredStep(null, 100000)
    + measuredStep(leafOf(), 200000)
    + compactRoot('c-boot', 3)
    + measuredStep('c-boot', 3000));

  const child = spawnMcp(box.env);
  let watcher = null;
  try {
    // The state file is written from the `server.listen` callback, which cannot run until `createServer` has
    // returned — so the bootstrap fold and its archival attempt are already complete.
    assert.ok(await waitFor(() => existsSync(box.stateFile)), 'the owner started');

    const atBoot = await provenanceOf(box.dir, box.sessionId);
    assert.deepEqual(atBoot, { 0: ['replay', 'cc-replay'] },
      'the segment the synchronous bootstrap closed is archived, as a reconstruction');

    // A live poll tick needs a connected client, or the idle gate suppresses it.
    watcher = await attachSseClient(box.stateFile);
    appendFileSync(box.transcriptPath, compactRoot('c-live', 6) + measuredStep('c-live', 5000));

    const afterLive = await waitFor(async () => {
      const seen = await provenanceOf(box.dir, box.sessionId);
      return seen[1] ? seen : null;
    });
    assert.ok(afterLive, 'the appended epoch closed segment 1');
    assert.deepEqual(afterLive, { 0: ['replay', 'cc-replay'], 1: ['live', 'cc-live'] },
      'the newly closed segment is witnessed live and the bootstrap segment keeps its own provenance');
  } finally {
    if (watcher) watcher.abort();
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('normal MCP shutdown archives the terminal segment and removes discovery', async () => {
  const box = sandbox('termseg');
  // A populated OPEN segment and no epoch at all, so the only way a profile row appears is the terminal
  // finalization normal shutdown performs.
  writeFileSync(box.transcriptPath, measuredStep(null, 20000) + measuredStep('r-ix' + stepSeq, 22000));
  const child = spawnMcp(box.env);
  try {
    assert.ok(await waitFor(() => existsSync(box.stateFile)), 'the owner started');
    assert.equal((await profilesOf(box.dir, box.sessionId)).length, 0,
      'precondition: nothing archived yet — the segment is still open');

    child.kill('SIGTERM');
    const code = await exitCodeOf(child, 6000);
    assert.equal(code, 0, 'normal shutdown exits 0');
    assert.ok(!existsSync(box.stateFile), 'discovery removed');

    const archived = await profilesOf(box.dir, box.sessionId);
    assert.equal(archived.length, 1, 'the terminal segment was archived exactly once');
    assert.equal(archived[0].archiveSource, 'live', 'a normal shutdown finalizes a LIVE segment');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

// ── the shipped SessionStart entry, as a process ─────────────────────────────
// The entry `hooks/hooks.json` names is the shim, not the hook module it loads: the shim rewrites argv[1] to
// its sibling so `isMainModule` inside that sibling fires and the hook body runs. Spawning the sibling
// directly supplies its own argv[1], so only the shim as a process covers the rewrite. It is executed from
// the built tree because that is the copy the manifest points at, and the sibling it imports is a bundle.
const BUILT_HOOK_ENTRY = join(__dirname, '..', 'dist', 'hooks', 'session-start-entry.js');

test('the built SessionStart entry rotates the running owner onto the session it announces', async () => {
  const box = sandbox('hookentry');
  writeFileSync(box.transcriptPath, measuredStep(null, 20000));
  // The announced session, with its own Source under the same projects root, so the rotation resolves a
  // locator that is not the one the owner currently holds.
  const rotatedSessionId = `${box.sessionId}-rotated`;
  const rotatedTranscript = join(dirname(box.transcriptPath), `${rotatedSessionId}.jsonl`);
  writeFileSync(rotatedTranscript, measuredStep(null, 21000));
  const rotatedStateFile = join(box.stateDir, `${rotatedSessionId}.json`);

  const child = spawnMcp(box.env);
  let hook = null;
  try {
    assert.ok(await waitFor(() => existsSync(box.stateFile)), 'the owner started');
    const before = JSON.parse(readFileSync(box.stateFile, 'utf8'));
    // The hook discovers its owner by matching the owner's clientPid against its OWN process.ppid, so the
    // entry has to be a direct child of this process — the same parent the MCP child has.
    assert.equal(before.clientPid, process.pid, 'precondition: this process is the client the owner recorded');

    hook = spawn(process.execPath, [BUILT_HOOK_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...box.env },
    });
    let emitted = '';
    hook.stdout.on('data', (d) => { emitted += d; });
    hook.stdin.end(JSON.stringify({
      session_id: rotatedSessionId,
      source: 'startup',
      transcript_path: rotatedTranscript,
      cwd: box.dir,
    }));
    assert.equal(await exitCodeOf(hook), 0, 'the entry ran to completion');

    // The owner rewrites discovery inside the rotation request, so the records are settled the moment the
    // entry's own fetch has resolved — which it has, because the entry has exited.
    assert.ok(existsSync(rotatedStateFile), 'the owner published a discovery record for the announced session');
    const after = JSON.parse(readFileSync(rotatedStateFile, 'utf8'));
    assert.equal(after.sessionId, rotatedSessionId, 'the new record names the announced session');
    assert.equal(after.transcriptPath, rotatedTranscript, 'and carries that session as its locator');
    assert.equal(after.pid, before.pid, 'the owner that was already running rotated, rather than a second one starting');
    assert.equal(after.port, before.port, 'and it kept its port, so the URL the entry injected still reaches it');
    assert.ok(!existsSync(box.stateFile), 'the record for the session it rotated away from is gone');
    assert.ok(emitted.includes(`[Session Watcher] Server: http://127.0.0.1:${before.port}`),
      `the entry answered SessionStart with the owner it rotated (got ${JSON.stringify(emitted)})`);
  } finally {
    if (hook) { try { hook.kill('SIGKILL'); } catch { /* already gone */ } }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});
