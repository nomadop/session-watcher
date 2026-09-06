// test/boot-order.test.js — the store must be open before the eager startup fold reads the transcript.
//
// `createServer` folds the whole transcript synchronously, inside the factory, before it returns: the
// `watcher.poll()` call it makes crosses every segment boundary the file already contains. A boundary
// reaches `handleSegmentBoundary`, which resolves `getStore()` — so if the entrypoint calls `initStore()`
// only AFTER `createServer(...)`, that resolve throws and the boundary's own catch swallows it. The
// segment still rotates, so no later boundary and no exit-time `archiveCurrentSegment` ever revisits it,
// and the startup telemetry sweep excludes the live session by construction: the closed segment's profile
// and telemetry are gone for good. Nothing crashes, nothing is logged without `SW_DEBUG`, and every other
// reply the process gives is identical — the only witness is the missing row.
//
// So this file drives each entrypoint for real over a transcript whose FIRST poll must close a segment,
// and asserts that segment's profile landed in the child's own store. `archive_source` is asserted with
// it: the eager fold stamps 'replay' (test/server.startup-fold-provenance.test.js pins that mapping), so
// a row written by any later live poll would read 'live' and not satisfy this.
//
// Two entrypoints, two independent orderings, one case each:
//   * index.js — the in-process MCP host, inside its realpath entrypoint guard;
//   * server.js — the CLI entry, guarded by `typeof __CLI_BUNDLE__ === 'undefined'`.
//
// Isolation: every child gets its own HOME (which is what `defaultDbPath()`, `defaultBaseDir()` and the
// `~/.claude/projects` transcript lookup resolve against), its own SW_STATE_DIR (PORT_DIR, which
// `sweepStalePortFiles` unlinks from), its own CLAUDE_CODE_SESSION_ID and its own cwd, all under one
// mkdtemp root, plus SW_NO_OPEN. The env object is built from scratch rather than spread from
// process.env, so an inherited HOME cannot leak a real install into a child that reaps state files.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Covers spawn + store migrations + the eager whole-file fold. Every wait is bounded and reports the
// child's own stdout/stderr, so a boot that never completes fails with a reason instead of hanging.
const BOOT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

const apiCall = (messageId, cacheRead, cacheCreation, uuid, parentUuid) => ({
  type: 'assistant', uuid, parentUuid,
  message: {
    id: messageId, model: 'claude-opus-4-8',
    usage: {
      input_tokens: 100, output_tokens: 10,
      cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead,
    },
  },
});

// A context reset already written to the file before either entrypoint starts, so the boundary falls
// inside the first poll — the one `createServer` makes itself. The uuid chain stays connected, so the
// topology detector stays silent and this is `foldCall`'s stock-drop fallback: the stock falls
// 202100 → 3100, clearing a relative floor of 50525. Segment 0 closes holding two folded API steps, which
// is what arms archival — `handleSegmentBoundary` returns early on an empty `_segmentStepUsage`.
const CONTEXT_RESET_IN_FIRST_POLL = [
  apiCall('m1', 100000, 2000, 'u1', null),   // stock 102100
  apiCall('m2', 200000, 2000, 'u2', 'u1'),   // stock 202100
  apiCall('m3', 0, 3000, 'u3', 'u2'),        // stock 3100 — context reset, closes segment 0
  apiCall('m4', 3000, 2000, 'u4', 'u3'),     // stock 5100 — segment 1 grows
];

function makeSandbox(label) {
  const home = mkdtempSync(join(tmpdir(), `sw-boot-order-${label}-`));
  const stateDir = join(home, 'state');
  const cwd = join(home, 'work');
  const projectsDir = join(home, '.claude', 'projects', 'enc');
  for (const d of [stateDir, cwd, projectsDir]) mkdirSync(d, { recursive: true });

  // The CLI derives its session id from the transcript BASENAME while index.js takes it from
  // CLAUDE_CODE_SESSION_ID; naming the file after the id makes both entrypoints archive under the same
  // session_id, so one assertion reads either child's store.
  const sessionId = `boot-order-${label}-${process.pid}-${Date.now()}`;
  const transcript = join(projectsDir, `${sessionId}.jsonl`);
  writeFileSync(transcript, CONTEXT_RESET_IN_FIRST_POLL.map(e => JSON.stringify(e) + '\n').join(''));

  return {
    home, stateDir, cwd, sessionId, transcript,
    stateFile: join(stateDir, `${sessionId}.json`),
    dbPath: join(home, '.session-watcher', 'store.sqlite'),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      SW_STATE_DIR: stateDir,
      CLAUDE_CODE_SESSION_ID: sessionId,
      SW_NO_OPEN: '1',
      SW_GRACE_MS: '1',
    },
  };
}

function launch({ script, args, cwd, env }) {
  const proc = { stdout: '', stderr: '', exit: null };
  proc.child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Draining both pipes also keeps a chatty child from blocking on a full pipe.
  proc.child.stdout.on('data', (c) => { proc.stdout = (proc.stdout + c).slice(-8000); });
  proc.child.stderr.on('data', (c) => { proc.stderr = (proc.stderr + c).slice(-8000); });
  proc.child.on('exit', (code, signal) => { proc.exit = { code, signal }; });
  proc.child.on('error', (err) => { proc.exit = { code: null, signal: null, error: err.message }; });
  return proc;
}

const report = (proc) =>
  `\n--- child exit: ${JSON.stringify(proc.exit)}`
  + `\n--- child stdout ---\n${proc.stdout}`
  + `\n--- child stderr ---\n${proc.stderr}`;

async function stop(proc) {
  if (!proc?.child) return;
  try { proc.child.stdin.end(); } catch { /* already gone */ }
  try { proc.child.kill('SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (!proc.exit && Date.now() < deadline) await sleep(25);
  if (!proc.exit) { try { proc.child.kill('SIGKILL'); } catch { /* already gone */ } }
}

async function waitForBoot(proc, isReady, what) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isReady()) return;
    if (proc.exit) assert.fail(`${what}: the child exited before it was ready.${report(proc)}`);
    await sleep(25);
  }
  assert.fail(`${what}: not ready within ${BOOT_TIMEOUT_MS}ms.${report(proc)}`);
}

// Read-only, so this never writes to (nor migrates) the connection the live child owns. The child is
// still running here, so the WAL sidecar it created is present for a read-only opener.
function archivedSegments(dbPath, sessionId) {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    return db
      .prepare('SELECT segment, archive_source FROM profile WHERE session_id = ? ORDER BY segment ASC')
      .all(sessionId)
      .map((row) => ({ segment: row.segment, archiveSource: row.archive_source }));
  } finally { db.close(); }
}

function assertStartupSegmentArchived(sandbox, proc, what) {
  let segments;
  // A read that cannot even open the store is reported with the child's own output, so it never reads
  // as a bare SQLite error detached from the process that wrote the file.
  try { segments = archivedSegments(sandbox.dbPath, sandbox.sessionId); }
  catch (err) { assert.fail(`${what}: could not read the child's store — ${err.message}.${report(proc)}`); }
  assert.notEqual(segments, null, `${what}: the child never created its store.${report(proc)}`);
  assert.deepEqual(
    segments.find((s) => s.segment === 0) ?? null,
    { segment: 0, archiveSource: 'replay' },
    `${what}: the segment the eager startup fold closed is not in the store — initStore() must precede `
    + `createServer(), whose synchronous watcher.poll() reaches handleSegmentBoundary → getStore(). `
    + `Archived instead: ${JSON.stringify(segments)}.${report(proc)}`,
  );
}

describe('the store is open before the eager startup fold reads the transcript', { timeout: 120_000 }, () => {
  test('index.js archives the segment its startup fold closes', async () => {
    const sandbox = makeSandbox('index');
    const proc = launch({ script: join(ROOT, 'index.js'), args: [], cwd: sandbox.cwd, env: sandbox.env });
    try {
      // The state file is written from the `server.listen` callback, which cannot run until
      // `createServer` has returned — so the eager fold, and its archival attempt, are already done.
      await waitForBoot(proc, () => existsSync(sandbox.stateFile), 'index.js');
      assertStartupSegmentArchived(sandbox, proc, 'index.js');
    } finally {
      await stop(proc);
      rmSync(sandbox.home, { recursive: true, force: true });
    }
  });

  test('the server.js CLI entry archives the segment its startup fold closes', async () => {
    const sandbox = makeSandbox('cli');
    const proc = launch({
      script: join(ROOT, 'server.js'),
      args: ['--transcript', sandbox.transcript, '--project', sandbox.cwd],
      cwd: sandbox.cwd,
      env: sandbox.env,
    });
    try {
      // `PORT=` is the CLI's own readiness line, printed from the same post-`createServer` listen callback.
      await waitForBoot(proc, () => /^PORT=\d+$/m.test(proc.stdout), 'server.js CLI');
      assertStartupSegmentArchived(sandbox, proc, 'server.js CLI');
    } finally {
      await stop(proc);
      rmSync(sandbox.home, { recursive: true, force: true });
    }
  });
});
