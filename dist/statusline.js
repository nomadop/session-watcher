#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// statusline.js
import { readFileSync as readFileSync2, readdirSync as readdirSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
import { get as httpGet } from "node:http";

// lib/probe.js
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var ACTIVE = process.env.SW_PROBE === "1";
var STATE_DIR = process.env.SW_STATE_DIR || join(homedir(), ".session-watcher");
var PROBE_LOG = join(STATE_DIR, "lifecycle-probe.jsonl");
var SAMPLE_INTERVAL_MS = 3e5;
var DEDUP_DIR = join(STATE_DIR, "probe-dedup");
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
function emit(source, data) {
  if (!ACTIVE) return;
  const line = JSON.stringify({ ts: Date.now(), source, ...data }) + "\n";
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(PROBE_LOG, line);
  } catch {
  }
}
function probeStatusline({ session_id, transcript_path, cwd, model, port, stateFileKey, stateTranscript }) {
  if (!ACTIVE) return;
  let serverAlive = false;
  if (port) {
    try {
      const sf = readStateFile(stateFileKey || session_id);
      if (sf && sf.pid) serverAlive = isPidAlive(sf.pid);
    } catch {
    }
  }
  const transcriptMatch = stateTranscript && transcript_path ? stateTranscript === transcript_path : null;
  const hash = [!!port, serverAlive, transcriptMatch, stateFileKey || ""].join(",");
  const now = Date.now();
  const dedupFile = join(DEDUP_DIR, (session_id || "x").slice(0, 12));
  try {
    const raw = readFileSync(dedupFile, "utf8");
    const sepIdx = raw.lastIndexOf("	");
    if (sepIdx > 0 && raw.slice(0, sepIdx) === hash && now - Number(raw.slice(sepIdx + 1)) < SAMPLE_INTERVAL_MS) return;
  } catch {
  }
  try {
    mkdirSync(DEDUP_DIR, { recursive: true });
    writeFileSync(dedupFile, `${hash}	${now}`);
  } catch {
  }
  emit("statusline", {
    session_id: session_id?.slice(0, 12),
    transcript: transcript_path ? transcript_path.split("/").slice(-2).join("/") : "",
    cwd: cwd ? cwd.split("/").slice(-2).join("/") : "",
    model: model || "",
    portFound: !!port,
    port: port || null,
    stateFileKey: stateFileKey?.slice(0, 12) || null,
    transcriptMatch,
    serverAlive
  });
}
function readStateFile(key) {
  if (!key) return null;
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

// statusline.js
var STATE_DIR2 = process.env.SW_STATE_DIR || join2(homedir2(), ".session-watcher");
async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
  }
  const rawSid = String(input.session_id || "default");
  const sid = rawSid.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const model = String(
    input.model && (input.model.display_name || input.model.id) || "model"
  ).replace(/\x1b\[[0-9;]*m/g, "").replace(/[\t\r\n]/g, " ");
  let port = "";
  let state;
  try {
    state = JSON.parse(readFileSync2(join2(STATE_DIR2, `${sid}.json`), "utf8"));
    port = String(state.port || "");
  } catch {
    const alt = findStateByHookSessionId(sid);
    if (alt) port = String(alt.port || "");
  }
  probeStatusline({
    session_id: sid,
    transcript_path: input.transcript_path,
    cwd: input.cwd,
    model,
    port,
    stateFileKey: state?.sessionId,
    stateTranscript: state?.transcriptPath
  });
  let line = "";
  if (port) {
    line = await fetchStatusLine(port);
  }
  if (line) {
    process.stdout.write(line + "\n");
  } else if (!port) {
    process.stdout.write(`[${model}] no port file
`);
  } else {
    process.stdout.write(`[${model}] unreachable :${port}
`);
  }
  process.exit(0);
}
function findStateByHookSessionId(sid) {
  let files;
  try {
    files = readdirSync2(STATE_DIR2);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const st = JSON.parse(readFileSync2(join2(STATE_DIR2, f), "utf8"));
      if (st.hookSessionId === sid) return st;
    } catch {
      continue;
    }
  }
  return null;
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(buf);
      }
    };
    const timer = setTimeout(finish, 2e3);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
function fetchStatusLine(port, timeoutMs = 1e3) {
  return new Promise((resolve) => {
    const req = httpGet(
      { host: "127.0.0.1", port, path: "/api/status?fmt=line", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => {
          resolve(body.trim());
        });
      }
    );
    req.on("error", () => {
      resolve("");
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("");
    });
  });
}
main();
