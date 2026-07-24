#!/usr/bin/env node
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// hooks/session-start.js
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname as dirname2, join as join3 } from "node:path";
import { realpathSync, readdirSync as readdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// lib/project-key.js
import { resolve } from "node:path";
function resolveProjectKey({ claudeProjectDir, cwd } = {}) {
  const raw = claudeProjectDir || cwd;
  if (!raw) return null;
  return resolve(raw);
}

// lib/store.js
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

// lib/constants.js
var HANDOFF_HOOK_TTL_DAYS = 7;
var HANDOFF_HOOK_MAX_DISPLAY = 3;
var HANDOFF_HOOK_QUERY_LIMIT = HANDOFF_HOOK_MAX_DISPLAY + 1;
var HANDOFF_HOOK_TASK_PREVIEW_CHARS = 200;
var HANDOFF_HOOK_SOURCES = ["startup", "clear"];

// lib/store.js
function defaultDbPath() {
  return join(homedir(), ".session-watcher", "store.sqlite");
}

// lib/probe.js
import { appendFileSync, mkdirSync as mkdirSync2, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var ACTIVE = process.env.SW_PROBE === "1";
var STATE_DIR = process.env.SW_STATE_DIR || join2(homedir2(), ".session-watcher");
var PROBE_LOG = join2(STATE_DIR, "lifecycle-probe.jsonl");
var DEDUP_DIR = join2(STATE_DIR, "probe-dedup");
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
    mkdirSync2(STATE_DIR, { recursive: true });
    appendFileSync(PROBE_LOG, line);
  } catch {
  }
}
function probeHook({ session_id, source, transcript_path, cwd }) {
  if (!ACTIVE) return;
  let existingCount = 0, aliveCount = 0;
  try {
    const files = readdirSync(STATE_DIR).filter((f) => f.endsWith(".json") && !f.includes("probe"));
    existingCount = files.length;
    for (const f of files) {
      try {
        const sf = JSON.parse(readFileSync(join2(STATE_DIR, f), "utf8"));
        if (sf.pid && isPidAlive(sf.pid)) aliveCount++;
      } catch {
      }
    }
  } catch {
  }
  emit("hook", {
    session_id: session_id?.slice(0, 12),
    hook_source: source,
    transcript: transcript_path ? transcript_path.split("/").slice(-2).join("/") : "",
    cwd: cwd ? cwd.split("/").slice(-2).join("/") : "",
    existingStateFiles: existingCount,
    aliveServers: aliveCount,
    env_session_id: process.env.CLAUDE_CODE_SESSION_ID?.slice(0, 12) || null
  });
}
function probeHandoffDiscovery({ dbPath, projectId, sessionId, rowCount, error }) {
  if (!ACTIVE) return;
  emit("hook_discovery", {
    dbPath: dbPath || null,
    projectId: projectId || null,
    session_id: sessionId?.slice(0, 12) || null,
    rowCount: rowCount ?? null,
    error: error || null
  });
}

// hooks/session-start.js
var __dirname = dirname2(fileURLToPath(import.meta.url));
function discoverHandoffs(dbPath, projectId, sessionId, { ttlDays, queryLimit }) {
  if (!projectId || !sessionId) return [];
  let db;
  try {
    db = new DatabaseSync2(dbPath, { readOnly: true });
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='handoff'"
    ).get();
    if (!tableCheck) return [];
    const cutoff = Date.now() - ttlDays * 24 * 3600 * 1e3;
    const stmt = db.prepare(`SELECT load_token, next_task, created_at, summary_tokens, kept_tokens
      FROM handoff
      WHERE project_id = ? AND delivered_at IS NULL AND session_id <> ? AND created_at > ?
      ORDER BY created_at DESC LIMIT ?`);
    return stmt.all(projectId, sessionId, cutoff, queryLimit);
  } catch {
    return [];
  } finally {
    try {
      if (db) db.close();
    } catch {
    }
  }
}
function formatHandoffContext(rows, maxDisplay, taskPreviewChars) {
  if (!rows || rows.length === 0) return null;
  const hasMore = rows.length > maxDisplay;
  const display = rows.slice(0, maxDisplay);
  const formatTokens = (summaryTok, keptTok) => {
    const total = (summaryTok || 0) + (keptTok || 0);
    if (total === 0) return null;
    if (total >= 1e3) return `~${Math.round(total / 1e3)}k tokens`;
    return `~${total} tokens`;
  };
  const formatAge = (createdAt) => {
    const diffMs = Math.max(0, Date.now() - createdAt);
    const mins = Math.floor(diffMs / 6e4);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };
  const truncTask = (task) => {
    if (!task) return "";
    if (task.length <= taskPreviewChars) return task;
    return task.slice(0, taskPreviewChars - 3) + "...";
  };
  if (display.length === 1) {
    const r = display[0];
    const age = formatAge(r.created_at);
    const tokens = formatTokens(r.summary_tokens, r.kept_tokens);
    const tokStr = tokens ? `, ${tokens} to restore` : "";
    const taskLine = r.next_task ? `
Task: ${truncTask(r.next_task)}` : "";
    return `[Session Watcher] Handoff available (token: ${r.load_token}, ${age}${tokStr}).${taskLine}`;
  }
  const header = hasMore ? `[Session Watcher] ${maxDisplay}+ pending handoffs (showing newest ${maxDisplay}):` : `[Session Watcher] ${display.length} pending handoffs for this project:`;
  const lines = display.map((r, i) => {
    const age = formatAge(r.created_at);
    const tokens = formatTokens(r.summary_tokens, r.kept_tokens);
    const tokStr = tokens ? `, ${tokens}` : "";
    const task = truncTask(r.next_task);
    const taskStr = task ? ` \u2014 ${task}` : "";
    return `${i + 1}. ${r.load_token} (${age}${tokStr})${taskStr}`;
  });
  const footer = hasMore ? "(older handoffs available \u2014 use load_handoff with a query to search)" : "";
  return [header, ...lines, footer].join("\n");
}
function buildServerContext(serverUrl) {
  if (!serverUrl) return null;
  return `[Session Watcher] Server: ${serverUrl}`;
}
function launchOptionsFor(payload = {}, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (payload.session_id) env.CLAUDE_CODE_SESSION_ID = payload.session_id;
  return {
    env,
    open: payload.source === "startup",
    transcript: payload.transcript_path || void 0
  };
}
function resolveStateDir() {
  return process.env.SW_STATE_DIR || join3(homedir3(), ".session-watcher");
}
function discoverServerByClientPid(clientPid, stateDir) {
  const dir = stateDir || resolveStateDir();
  let files;
  try {
    files = readdirSync2(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const sf = JSON.parse(readFileSync2(join3(dir, f), "utf8"));
      if (sf.clientPid === clientPid) {
        return { url: `http://127.0.0.1:${sf.port}`, sessionId: sf.sessionId };
      }
    } catch {
      continue;
    }
  }
  return null;
}
function buildRotationFallbackContext(sessionId, transcriptPath) {
  const args = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath
  });
  return `[Session Watcher] Session rotated but HTTP rotation failed. Call rotate_session(${args}) to switch the watcher to the new segment.`;
}
function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    const self = realpathSync(fileURLToPath(metaUrl));
    const arg = realpathSync(argv1);
    return self === arg;
  } catch {
    return metaUrl === pathToFileURL(argv1).href;
  }
}
function readStdin(stream, timeoutMs = 2e3) {
  return new Promise((resolve2) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve2(buf);
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
      probeHook({
        session_id: payload.session_id,
        source: payload.source,
        transcript_path: payload.transcript_path,
        cwd: payload.cwd
      });
      if (!HANDOFF_HOOK_SOURCES.includes(payload.source)) {
        process.exit(0);
        return;
      }
      const contexts = [];
      try {
        const dbPath = defaultDbPath();
        const projectId = resolveProjectKey({
          claudeProjectDir: process.env.CLAUDE_PROJECT_DIR,
          cwd: payload.cwd
        });
        const rows = discoverHandoffs(dbPath, projectId, payload.session_id, {
          ttlDays: HANDOFF_HOOK_TTL_DAYS,
          queryLimit: HANDOFF_HOOK_QUERY_LIMIT
        });
        probeHandoffDiscovery({
          dbPath,
          projectId,
          sessionId: payload.session_id,
          rowCount: rows.length
        });
        const handoffContext = formatHandoffContext(
          rows,
          HANDOFF_HOOK_MAX_DISPLAY,
          HANDOFF_HOOK_TASK_PREVIEW_CHARS
        );
        if (handoffContext) contexts.push(handoffContext);
      } catch (e) {
        probeHandoffDiscovery({ error: e?.message });
      }
      try {
        const discovery = discoverServerByClientPid(process.ppid);
        if (discovery) {
          if (discovery.sessionId !== payload.session_id) {
            try {
              const resp = await fetch(`${discovery.url}/api/rotate`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  session_id: payload.session_id,
                  transcript_path: payload.transcript_path
                }),
                signal: AbortSignal.timeout(2e3)
              });
              const result = await resp.json();
              if (!result.ok) {
                contexts.push(
                  buildRotationFallbackContext(
                    payload.session_id,
                    payload.transcript_path
                  )
                );
              }
            } catch {
              contexts.push(
                buildRotationFallbackContext(
                  payload.session_id,
                  payload.transcript_path
                )
              );
            }
          }
          contexts.push(buildServerContext(discovery.url));
        }
      } catch {
      }
      if (contexts.length > 0) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: contexts.filter(Boolean).join("\n")
            }
          })
        );
      }
    } catch {
    } finally {
      process.exit(0);
    }
  })();
}
export {
  buildRotationFallbackContext,
  buildServerContext,
  discoverHandoffs,
  discoverServerByClientPid,
  formatHandoffContext,
  isMainModule,
  launchOptionsFor,
  readStdin
};
