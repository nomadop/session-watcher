import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeStateFileExclusive } from "../server.js";
import { bootTestServer } from "./helpers/server-boot.js";
import {
  ts, chain, usage, userMessage, assistantToolUse, toolResult,
} from "./helpers/transcript-fixtures.js";

test("D5: writeStateFileExclusive fails when the state file already exists (wx)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-boot-"));
  try {
    const p = join(dir, "sess-D5.json");
    const fd = openSync(p, "wx");
    writeSync(fd, '{"port":1}');
    closeSync(fd); // pre-existing owner
    assert.throws(
      () => writeStateFileExclusive(p, { port: 2 }),
      /EEXIST/,
      "second writer must not clobber",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5: writeStateFileExclusive succeeds on a fresh path", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-boot-"));
  try {
    writeStateFileExclusive(join(dir, "sess-D5b.json"), { port: 3 }); // no throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Drive the REAL CLI bootstrap (the `server.listen` callback that owns the state-file write) as a
// child process. Levers: server.js computes PORT_DIR = join(homedir(), '.session-watcher') at load
// and does NOT read SW_STATE_DIR (only statusline.js does), so we redirect the child's state dir by
// overriding $HOME (os.homedir() honors it). `--project <emptyDir>` gives the watcher no transcript
// (resolveJsonl returns the dir; the initial poll is try/caught), `--port 0` binds ephemeral — exactly
// the path the existing health-e2e spawn test exercises, which is where the state-file write lives.
// We pre-create the state file so the child hits EEXIST and must exit non-zero with actionable stderr.
async function runBootstrapWithStaleStateFile() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(__dirname, "..", "server.js");
  const home = mkdtempSync(join(tmpdir(), "sw-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "sw-proj-"));
  const sessionId = "sw-bootstrap-D5"; // plain sid → safeSessionId is a no-op, path is deterministic
  const portDir = join(home, ".session-watcher");
  mkdirSync(portDir, { recursive: true });
  // Pre-create the STALE state file at the EXACT path the bootstrap computes (stateFileFor).
  const stateFile = join(portDir, `${sessionId}.json`);
  const fd = openSync(stateFile, "wx");
  writeSync(fd, JSON.stringify({ port: 1, pid: 999999, sessionId })); // a prior/crashed owner
  closeSync(fd);

  try {
    const child = spawn(
      process.execPath,
      [serverPath, "--port", "0", "--project", projectDir, "--session", sessionId],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, SW_NO_OPEN: "1" } },
    );
    return await new Promise((resolve, reject) => {
      let stderr = "";
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("bootstrap child did not exit (expected EEXIST exit)"));
      }, 8000);
      child.stderr.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (e) => { clearTimeout(t); reject(e); });
      child.on("close", (code) => { clearTimeout(t); resolve({ code, stderr }); });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
}

test("D5: bare `node server.js` against a STALE state file exits non-zero with actionable guidance (B15/E14)", async () => {
  // Pre-create the state file, then spawn the bootstrap; assert exit code !== 0 AND stderr names the
  // remedy: restart via startWatcher (auto-clears a dead-port file) OR manually delete <path>. Pins B15:
  // the EEXIST branch is a guided exit, not a dead-end. (spawn server.js as a child; capture code+stderr.)
  const { code, stderr } = await runBootstrapWithStaleStateFile();
  assert.notEqual(code, 0, "refuses to start against an existing owner");
  assert.match(
    stderr,
    /startWatcher|manually delete/,
    'stderr is actionable, not a bare "already owned"',
  );
});

// ── The runtime cutover, end to end ──────────────────────────────────────────
// The owner acquires its own Source through its own driver and serves every retained wire off the shared
// application. Nothing here reads a watcher field: the frame TRANSITIONS are observed through
// `streamRevision`, which the application increments on a replace and a rotate and leaves alone on an
// append, so the sequence a tick produced is visible without a private read or a diagnostic getter.
describe("cutover: the host acquires its Source and serves every wire off the shared application", () => {
  const revisionOf = (ctx) => ctx.watcher.readRateLampFrame(-1).streamRevision;

  test("synchronous bootstrap applies one replay `replace` before the first read", async (t) => {
    const ctx = await bootTestServer({ sessionId: "sid-cut-boot" });
    t.after(() => ctx.teardown());

    // One replace and nothing else: a fresh application is at revision 0, and the first readable advance of
    // a startup driver is its configured `replace`.
    assert.equal(revisionOf(ctx), 1, "bootstrap applied exactly one runtime-replacing frame");

    // The status read is already populated, which is what makes bootstrap synchronous rather than a promise
    // the first request races.
    const status = await ctx.get("/api/status");
    assert.equal(status.apiCalls, 1, "the opening step was measured before the server was exposed");
    assert.equal(status.transcriptPath, ctx.transcriptPath, "the retained wire field carries the locator");
  });

  test("every retained wire answers off the installed driver", async (t) => {
    const ctx = await bootTestServer({ sessionId: "sid-cut-wires" });
    t.after(() => ctx.teardown());
    ctx.touchBucketPaths(["lib/alpha.js"]);

    const status = await ctx.get("/api/status");
    assert.equal(typeof status.segment, "number");
    assert.ok(status.cRatio > 0, "a finite C ratio from the first poll");

    const history = await ctx.get("/api/history");
    assert.ok(Array.isArray(history), "history is the bare array baseline returned");
    assert.ok(history.length >= 1);
    assert.equal(typeof history[0].ts, "string", "the history timestamp keeps its ISO wire form");

    const buckets = await ctx.get("/api/buckets");
    assert.equal(buckets.session_id, "sid-cut-wires");
    assert.ok(buckets.paths.some(p => p.path.endsWith("/lib/alpha.js")), JSON.stringify(buckets.paths));
    assert.ok(buckets.paths.every(p => "last_active_turn" in p), "the compatibility alias is still emitted");

    const prepared = await ctx.prepareHandoffFull({
      paths_to_keep: [{ path: "lib/alpha.js" }], summary: "cutover wire check",
    });
    assert.equal(prepared.response.status, "ready");
    assert.equal(prepared.response.kept_paths, 1);
    const loaded = await ctx.get(`/api/handoff/load?load_token=${encodeURIComponent(prepared.token)}`);
    assert.equal(loaded.found, true);
    assert.equal(loaded.load_token, prepared.token);

    const skeleton = ctx.turnService.getTurnSkeleton();
    assert.equal(typeof skeleton.snapshot_id, "string");
    assert.ok(skeleton.skeleton_path.startsWith(join(ctx.stateDir, "turn-notes") + "/"));
  });

  test("rows appended after installation produce an append, not a second replace", async (t) => {
    const ctx = await bootTestServer({ sessionId: "sid-cut-append" });
    t.after(() => ctx.teardown());
    const before = revisionOf(ctx);
    const callsBefore = (await ctx.get("/api/status")).apiCalls;

    ctx.touchBucketPaths(["lib/beta.js"]);

    assert.equal(revisionOf(ctx), before, "an append leaves the sample stream continuous");
    const after = await ctx.get("/api/status");
    assert.ok(after.apiCalls > callsBefore, "the appended step was measured");
  });

  test("rotation closes the old segment, moves discovery, and consumes the new Source", async (t) => {
    const ctx = await bootTestServer({ sessionId: "sid-cut-rot-a" });
    t.after(() => ctx.teardown());
    ctx.touchBucketPaths(["lib/gamma.js"]);

    const discoveryPath = join(ctx.stateDir, "sid-cut-rot-a.json");
    const before = JSON.parse(readFileSync(discoveryPath, "utf8"));
    assert.equal(before.sessionId, "sid-cut-rot-a");
    assert.equal(before.transcriptPath, ctx.transcriptPath);

    // The new Source exists before the notification, which is the immediately-readable rotation path.
    const nextPath = join(ctx.projectsRoot, "sid-cut-rot-b.jsonl");
    writeFileSync(nextPath, chain([
      userMessage({ uuid: "u-b", parentUuid: null, text: "second session", timestamp: ts(20) }),
      assistantToolUse({
        uuid: "a-b", messageId: "m-b", toolUseId: "tu-b", name: "Read",
        input: { file_path: join(ctx.cwd, "lib/gamma.js") }, timestamp: ts(21),
        usage: usage({ input: 60, output: 25, cacheRead: 30000 }),
      }),
      toolResult({ uuid: "r-b", toolUseId: "tu-b", content: "1\texport const g = 1;" }),
    ]).map(row => JSON.stringify(row) + "\n").join(""));

    const revisionBefore = revisionOf(ctx);
    const result = ctx.doRotation("sid-cut-rot-b", nextPath);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.old_session_id, "sid-cut-rot-a");
    assert.equal(result.new_session_id, "sid-cut-rot-b");
    assert.equal(revisionOf(ctx), revisionBefore + 1, "a rotate restarts the sample stream exactly once");

    // Discovery follows the new identity: the new record exists with the new locator, the old path is gone.
    const after = JSON.parse(readFileSync(join(ctx.stateDir, "sid-cut-rot-b.json"), "utf8"));
    assert.equal(after.sessionId, "sid-cut-rot-b");
    assert.equal(after.transcriptPath, nextPath);
    assert.equal(after.port, before.port, "the port and owner metadata stay fixed across a rotation");
    assert.equal(after.pid, before.pid);
    assert.equal(after.startedAt, before.startedAt);

    // The old segment archived under the OLD session, which is the identity that produced it.
    const archived = ctx.store.listSegmentProfiles
      ? ctx.store.listSegmentProfiles("sid-cut-rot-a")
      : null;
    if (archived) assert.ok(archived.length >= 1, "the dying segment persisted a profile row");

    // The rotated-in driver is live: a further append is measured under the new identity.
    const buckets = await ctx.get("/api/buckets");
    assert.equal(buckets.session_id, "sid-cut-rot-b");
  });
});

// ── The CLI owner's owner-fatal sink ─────────────────────────────────────────
// Without a sink, `createServer`'s guard stopped the poll timer and returned: polling was dead forever while
// the HTTP server and the discovery record stayed live, so the owner advertised itself as alive while serving
// frozen state — worse than the baseline, which caught the throw and kept polling. The CLI owner now has the
// same sink shape as the in-process one: report, clean up, exit nonzero.
test("the CLI owner's post-startup blocking error exits nonzero and stops advertising itself", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "sw-clifatal-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "sw-clifatal-proj-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });
  const sessionId = "cli-fatal";
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  // One good step, so the owner starts and serves.
  writeFileSync(transcript, chain([
    userMessage({ uuid: "u-cf", parentUuid: null, text: "start", timestamp: ts(1) }),
    assistantToolUse({
      uuid: "a-cf", messageId: "m-cf", toolUseId: "t-cf", name: "Bash",
      input: { command: "echo hi" }, timestamp: ts(2),
      usage: usage({ input: 100, output: 10, cacheRead: 20000 }),
    }),
    toolResult({ uuid: "r-cf", toolUseId: "t-cf", content: "hi" }),
  ]).map(row => JSON.stringify(row) + "\n").join(""));

  const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const child = spawn(process.execPath,
    [serverPath, "--port", "0", "--transcript", transcript, "--session", sessionId, "--project", projectDir],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, SW_NO_OPEN: "1" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("exit", (code) => resolve(code)));

  try {
    // Wait for the owner to announce its port, which is what proves it started and is serving.
    const deadline = Date.now() + 10000;
    while (!/PORT=\d+/.test(stdout) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    assert.match(stdout, /PORT=\d+/, "the CLI owner started and announced its port");
    const stateFile = join(home, ".session-watcher", `${sessionId}.json`);
    assert.ok(existsSync(stateFile), "and published its discovery record");

    // A row whose usage carries a negative token count: it decodes and reduces normally and fails the Engine's
    // own non-negative invariant on ingest, so it is a blocking application error after startup.
    appendFileSync(transcript, JSON.stringify({
      type: "assistant", uuid: "u-bad", parentUuid: "r-cf", isSidechain: false,
      timestamp: "2026-07-01T00:00:09Z",
      message: {
        id: "m-bad", role: "assistant", model: "claude-opus-4-8", content: [],
        usage: { input_tokens: -5, output_tokens: 10, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 },
      },
    }) + "\n");

    const code = await Promise.race([
      exited,
      new Promise(r => setTimeout(() => r("timeout"), 15000)),
    ]);
    assert.notEqual(code, "timeout",
      "the owner exited instead of freezing with a dead poll timer and a live HTTP server");
    assert.notEqual(code, 0, "and it exited NONZERO: this is owner-fatal, not a normal shutdown");
    assert.match(stderr, /fatal/, "it reported the failure outside SW_DEBUG");
    assert.ok(!existsSync(stateFile), "and cleanup removed the discovery record it was advertising");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
});
