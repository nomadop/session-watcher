#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// hooks/session-start.js
import { pathToFileURL, fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname2, join as join2 } from "node:path";

// lib/launcher.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { get as httpGet } from "node:http";
var __dirname = dirname(fileURLToPath(import.meta.url));
var PORT_DIR = process.env.SW_STATE_DIR || join(homedir(), ".session-watcher");
function safeSessionId(sessionId) {
  const s = String(sessionId ?? "");
  if (!s || s === "." || s === ".." || /[/\\\0]/.test(s) || s.includes("..")) return "__invalid_session__";
  return s;
}
var stateFileFor = (sessionId) => join(PORT_DIR, `${safeSessionId(sessionId || "default")}.json`);
function resolveProjectDir(env = process.env) {
  if (env.CLAUDE_PROJECT_DIR) return env.CLAUDE_PROJECT_DIR;
  const home = env.HOME || homedir();
  return join(home, ".claude", "projects");
}
function sessionIdOf(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || "default";
}
function probeHealth(port, timeoutMs = 2e3) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const req = httpGet({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => body += d);
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFileFor(sessionId), "utf8"));
  } catch {
    return null;
  }
}
function scanStateByHookSessionId(sessionId) {
  let files;
  try {
    files = readdirSync(PORT_DIR);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const st = JSON.parse(readFileSync(join(PORT_DIR, f), "utf8"));
      if (st.hookSessionId === sessionId) return st;
    } catch {
      continue;
    }
  }
  return null;
}
async function startWatcher(env = process.env, { open = true, transcript, waitForPort = true, serverPath } = {}) {
  const sessionId = sessionIdOf(env);
  let prev = readState(sessionId);
  if (!prev) prev = scanStateByHookSessionId(sessionId);
  if (prev && await probeHealth(prev.port)) return { url: `http://127.0.0.1:${prev.port}`, reused: true };
  if (prev) {
    const stalePath = stateFileFor(prev.sessionId);
    try {
      unlinkSync(stalePath);
    } catch {
    }
  }
  const dir = resolveProjectDir(env);
  const defaultServerPath = existsSync(join(__dirname, "server.js")) ? join(__dirname, "server.js") : join(__dirname, "..", "server.js");
  const resolvedServerPath = serverPath || defaultServerPath;
  const args = [resolvedServerPath, "--port", "0", "--project", dir, "--session", sessionId];
  if (transcript) args.push("--transcript", transcript);
  if (open) args.push("--open");
  if (!waitForPort) {
    const child2 = spawn(process.execPath, args, { detached: true, stdio: "ignore", env });
    child2.on("error", () => {
    });
    child2.unref();
    return { reused: false };
  }
  const child = spawn(
    process.execPath,
    args,
    { detached: true, stdio: ["ignore", "pipe", "ignore"], env }
  );
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      reject(new Error("server start timeout"));
    }, 1e4);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(t);
        resolve(parseInt(m[1], 10));
      }
    });
    child.on("error", (err) => {
      clearTimeout(t);
      try {
        child.kill();
      } catch {
      }
      reject(err);
    });
  });
  child.unref();
  return { url: `http://127.0.0.1:${port}`, reused: false };
}

// hooks/session-start.js
var __dirname2 = dirname2(fileURLToPath2(import.meta.url));
function launchOptionsFor(payload = {}, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (payload.session_id) env.CLAUDE_CODE_SESSION_ID = payload.session_id;
  return {
    env,
    open: payload.source === "startup",
    transcript: payload.transcript_path || void 0
  };
}
function isMainModule(metaUrl, argv1) {
  return metaUrl === pathToFileURL(argv1).href;
}
function readStdin(stream, timeoutMs = 2e3) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(buf);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (d) => {
      buf += d;
    });
    stream.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    stream.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
if (isMainModule(import.meta.url, process.argv[1])) {
  (async () => {
    try {
      const raw = await readStdin(process.stdin);
      const payload = JSON.parse(raw);
      const { env, open, transcript } = launchOptionsFor(payload);
      await startWatcher(env, { open, transcript, waitForPort: false, serverPath: join2(__dirname2, "..", "server.js") });
    } catch {
    } finally {
      process.exit(0);
    }
  })();
}
export {
  isMainModule,
  launchOptionsFor,
  readStdin
};
