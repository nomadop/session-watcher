// The in-process owner's startup maintenance is where the age sweeps and the telemetry carry run: the CLI
// block is not what the deployed plugin executes. Each case drives that timer instead of calling a sweep
// directly, so the store and the state directory each assertion lands on are the host's own — a sweep
// reaching for the module-level store or for PORT_DIR reddens here rather than deleting rows in the real
// install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeForTranscript, measuredTranscript, writeMeasuredTranscript } from './helpers/server-boot.js';
import { snap } from './helpers/store-fixtures.js';

const EXPIRED_AGE_MS = 8 * 24 * 3600 * 1000;   // past the reaper's own MAX_AGE_MS default

// The maintenance timer is deferred and unref'd, so a case waits for its effect rather than for a duration.
async function waitForEffect(predicate, label) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`startup maintenance never ${label}`);
}

function seedExpiredSession(store, sessionId) {
  const old = Date.now() - EXPIRED_AGE_MS;
  store._db.prepare('INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(sessionId, old, old);
  store._db.prepare("INSERT INTO state (session_id, key, value, updated_at) VALUES (?, 'ledger', ?, ?)")
    .run(sessionId, JSON.stringify({ x: 1 }), old);
}

// A discovery record, written where the owner writes its own. `pid` is the whole of the liveness answer.
function writePortFile(stateDir, sessionId, pid, { ageMs = 0 } = {}) {
  const path = join(stateDir, `${sessionId}.json`);
  writeFileSync(path, JSON.stringify({ pid, port: 1234 }));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
  }
  return path;
}

function bootOwnerWithMaintenance(t) {
  const ctx = composeForTranscript({
    transcriptPath: writeMeasuredTranscript(), disableTelemetrySweep: false,
  });
  t.after(ctx.teardown);
  return ctx;
}

test('the startup maintenance archives an expired session out of the host store and keeps a live one', async (t) => {
  const ctx = bootOwnerWithMaintenance(t);
  seedExpiredSession(ctx.store, 'expired-sid');
  seedExpiredSession(ctx.store, 'live-sid');
  writePortFile(ctx.stateDir, 'live-sid', process.pid);   // this process is the liveness proof

  await waitForEffect(() => ctx.store.load('expired-sid', 'ledger') === null, 'deleted the expired session');
  assert.ok(ctx.store.getProfile('expired-sid'), 'the expired session was deleted without being archived');
  assert.deepEqual(ctx.store.load('live-sid', 'ledger'), { x: 1 }, 'a live session lost its state');
});

test('the startup maintenance reaps a dead owner’s port file under the injected state dir', async (t) => {
  const ctx = bootOwnerWithMaintenance(t);
  writePortFile(ctx.stateDir, 'dead-owner', 99999999, { ageMs: EXPIRED_AGE_MS });
  writePortFile(ctx.stateDir, 'this-owner', process.pid, { ageMs: EXPIRED_AGE_MS });

  await waitForEffect(() => !existsSync(join(ctx.stateDir, 'dead-owner.json')), 'reaped the dead port file');
  assert.ok(existsSync(join(ctx.stateDir, 'this-owner.json')), 'a live owner’s port file was reaped');
});

// ── The telemetry carry of a session from another project ────────────────────
// The sweep selects by pending telemetry, not by project, so the session it reaches may belong to a project
// this owner knows nothing about. What it archives must therefore be a property of that session's own Source.

const FOREIGN_SESSION = 'foreign-project-session';

// A Source belonging to another project, laid where the host's own locator resolution looks for it. Its
// whole-file Read is of a resource under that project's root, which is what an owner bound elsewhere judges
// outside its own boundary.
function writeForeignProjectSource() {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'sw-foreign-projects-'));
  const foreignRoot = mkdtempSync(join(tmpdir(), 'sw-foreign-root-'));
  const readPath = join(foreignRoot, 'carried.js');
  writeFileSync(readPath, 'export const carried = 1;\n');
  writeFileSync(join(projectsRoot, `${FOREIGN_SESSION}.jsonl`),
    measuredTranscript({ steps: 2, paths: [readPath] }).map(row => JSON.stringify(row) + '\n').join(''));
  return projectsRoot;
}

// An owner whose maintenance chain can reach that session: it shares the projects root the sweep resolves
// through, and the pending segment is seeded at the archive priority a reconstruction outranks, so the
// rebuilt profile row is what the assertions read.
function bootOwnerOverForeignSession(t, { projectsRoot, projectRoot, projectId, sessionId }) {
  const ctx = composeForTranscript({
    transcriptPath: writeMeasuredTranscript(), sessionId, projectId, projectRoot, projectsRoot,
    disableTelemetrySweep: false,
  });
  t.after(ctx.teardown);
  ctx.store.archiveSegmentProfile(FOREIGN_SESSION, 0, snap({ priority: 1, projectId: null }), []);
  return ctx;
}

const carryStatusOf = (store) => store._db
  .prepare('SELECT telemetry_status FROM profile WHERE session_id = ? AND segment = 0')
  .get(FOREIGN_SESSION)?.telemetry_status ?? null;

// The archived facts an owner's project context can reach: the recorded identity, and the br family the
// position basis — the selected subset of the rebuilt resources — is computed from. `node:sqlite` hands back
// null-prototype rows, so the row is spread into a plain object before comparison.
const carriedProfileOf = (store) => ({
  ...store._db.prepare(`SELECT project_id, mf, pp_exit, br_exit, br_peak, pp_peak
    FROM profile WHERE session_id = ? AND segment = 0`).get(FOREIGN_SESSION),
});

test('the startup maintenance carries another project’s session on a neutral context', async (t) => {
  const projectsRoot = writeForeignProjectSource();
  const bound = bootOwnerOverForeignSession(t, {
    projectsRoot, sessionId: 'owner-bound', projectId: 'owner-project',
    projectRoot: mkdtempSync(join(tmpdir(), 'sw-owner-root-')),
  });
  // The same carry under an owner that is bound to no project at all: the rebuild every assertion below is
  // measured against, produced by the same host wiring rather than by a second composition.
  const unbound = bootOwnerOverForeignSession(t, {
    projectsRoot, sessionId: 'owner-unbound', projectId: null, projectRoot: null,
  });

  await waitForEffect(() => carryStatusOf(bound.store) === 'complete', 'carried the foreign session');
  await waitForEffect(() => carryStatusOf(unbound.store) === 'complete',
    'carried the foreign session under an unbound owner');

  const neutral = carriedProfileOf(unbound.store);
  assert.equal(neutral.project_id, null, 'precondition: a rebuild attributes an unknown project to none');
  assert.ok(neutral.mf > 0, 'precondition: the rebuilt position basis selected the carried resource');
  assert.deepEqual(carriedProfileOf(bound.store), neutral,
    'the carry rebuilds one session one way: the running owner’s identity and boundary reach neither its '
    + 'attribution nor its measurements');
});

test('the startup maintenance reaps an abandoned turn-note epoch under the injected state dir', async (t) => {
  const ctx = bootOwnerWithMaintenance(t);
  const epochDir = join(ctx.stateDir, 'turn-notes', 'epoch-abandoned');
  mkdirSync(epochDir, { recursive: true });
  writeFileSync(join(epochDir, 'notes.md'), '## NOTE 1\nan unredacted body\n');
  // The directory's own mtime last: creating the entry moved it, and age is the newest mtime here.
  const when = new Date(Date.now() - EXPIRED_AGE_MS);
  utimesSync(join(epochDir, 'notes.md'), when, when);
  utimesSync(epochDir, when, when);

  await waitForEffect(() => !existsSync(epochDir), 'reaped the abandoned epoch');
});
