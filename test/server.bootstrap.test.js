import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeStateFileExclusive } from "../server.js";

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
// and does NOT read SW_STATE_DIR (only statusline.sh does), so we redirect the child's state dir by
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
