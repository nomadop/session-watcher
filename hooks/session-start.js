#!/usr/bin/env node
// Claude Code SessionStart hook for the in-process session-watcher.
//
// Claude Code delivers the hook payload on STDIN as JSON: { session_id, transcript_path, source, ... }.
// The hook discovers the in-process server via clientPid match in state files and POSTs /api/rotate
// on session_id mismatch (startup/clear). Injects the server URL as additionalContext so
// skills can curl it directly. Also performs direct DB read for pending handoff discovery.
//
// BEST-EFFORT: any failure must never block or delay the session — always exit 0.
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { realpathSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveProjectKey } from "../lib/project-key.js";
import { defaultDbPath } from "../lib/store.js";
import { probeHook, probeHandoffDiscovery } from "../lib/probe.js";
import {
  HANDOFF_HOOK_TTL_DAYS,
  HANDOFF_HOOK_MAX_DISPLAY,
  HANDOFF_HOOK_QUERY_LIMIT,
  HANDOFF_HOOK_TASK_PREVIEW_CHARS,
  HANDOFF_HOOK_SOURCES,
} from "../lib/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Pure functions (exported for testing) ───────────────────────────────────

// Direct DB read — fail-open. Opens read-only, queries, closes. Never throws to caller.
export function discoverHandoffs(
  dbPath,
  projectId,
  sessionId,
  { ttlDays, queryLimit },
) {
  if (!projectId || !sessionId) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Guard: check table exists
    const tableCheck = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='handoff'",
      )
      .get();
    if (!tableCheck) return [];
    const cutoff = Date.now() - ttlDays * 24 * 3600 * 1000;
    const stmt =
      db.prepare(`SELECT load_token, next_task, created_at, summary_tokens, kept_tokens
      FROM handoff
      WHERE project_id = ? AND delivered_at IS NULL AND session_id <> ? AND created_at > ?
      ORDER BY created_at DESC LIMIT ?`);
    return stmt.all(projectId, sessionId, cutoff, queryLimit);
  } catch {
    return []; // fail-open: file not found, corrupt, locked, missing module, etc.
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

// Format handoff rows into additionalContext string.
export function formatHandoffContext(rows, maxDisplay, taskPreviewChars) {
  if (!rows || rows.length === 0) return null;
  const hasMore = rows.length > maxDisplay;
  const display = rows.slice(0, maxDisplay);

  const formatTokens = (summaryTok, keptTok) => {
    const total = (summaryTok || 0) + (keptTok || 0);
    if (total === 0) return null;
    if (total >= 1000) return `~${Math.round(total / 1000)}k tokens`;
    return `~${total} tokens`;
  };

  const formatAge = (createdAt) => {
    const diffMs = Math.max(0, Date.now() - createdAt);
    const mins = Math.floor(diffMs / 60000);
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
    const taskLine = r.next_task ? `\nTask: ${truncTask(r.next_task)}` : "";
    return `[Session Watcher] Handoff available (token: ${r.load_token}, ${age}${tokStr}).${taskLine}`;
  }

  const header = hasMore
    ? `[Session Watcher] ${maxDisplay}+ pending handoffs (showing newest ${maxDisplay}):`
    : `[Session Watcher] ${display.length} pending handoffs for this project:`;
  const lines = display.map((r, i) => {
    const age = formatAge(r.created_at);
    const tokens = formatTokens(r.summary_tokens, r.kept_tokens);
    const tokStr = tokens ? `, ${tokens}` : "";
    const task = truncTask(r.next_task);
    const taskStr = task ? ` — ${task}` : "";
    return `${i + 1}. ${r.load_token} (${age}${tokStr})${taskStr}`;
  });
  const footer = hasMore
    ? "(older handoffs available — use load_handoff with a query to search)"
    : "";
  return [header, ...lines, footer].join("\n");
}

// Server-only context (unchanged from original — preserve existing format)
export function buildServerContext(serverUrl) {
  if (!serverUrl) return null;
  return `[Session Watcher] Server: ${serverUrl}`;
}

// Pure decision function — no I/O, unit-tested directly.
export function launchOptionsFor(payload = {}, baseEnv = process.env) {
  const env = { ...baseEnv };
  if (payload.session_id) env.CLAUDE_CODE_SESSION_ID = payload.session_id;
  return {
    env,
    open: payload.source === "startup",
    transcript: payload.transcript_path || undefined,
  };
}

// Resolves the state directory from env or default.
function resolveStateDir() {
  return process.env.SW_STATE_DIR || join(homedir(), ".session-watcher");
}

// Discovers an in-process server by matching clientPid in state files.
// Returns { url, sessionId } for the first matching state file, or null.
export function discoverServerByClientPid(clientPid, stateDir) {
  const dir = stateDir || resolveStateDir();
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const sf = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (sf.clientPid === clientPid) {
        return { url: `http://127.0.0.1:${sf.port}`, sessionId: sf.sessionId };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// Builds a fallback context string for agent relay when HTTP rotation fails.
// Tells the agent to call rotate_session manually.
export function buildRotationFallbackContext(sessionId, transcriptPath) {
  const args = JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
  });
  return `[Session Watcher] Session rotated but HTTP rotation failed. Call rotate_session(${args}) to switch the watcher to the new segment.`;
}

// True when this module is the process entry point. Uses realpath to resolve symlinks
// (e.g. devcontainer plugin cache: ~/.claude/plugins/cache → ~/.claude-host/plugins/cache).
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    const self = realpathSync(fileURLToPath(metaUrl));
    const arg = realpathSync(argv1);
    return self === arg;
  } catch {
    return metaUrl === pathToFileURL(argv1).href;
  }
}

// Bounded stdin read. Resolves on 'end'/'error' (best-effort: whatever we got so far), and ALSO on a
// hard timeout — Claude Code always closes the hook's stdin, but if it ever didn't, an unbounded read
// would hang the session. The timeout floor guarantees the hook can never stall on a stuck stream.
export function readStdin(stream, timeoutMs = 2000) {
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

// ── CLI entry ───────────────────────────────────────────────────────────────
// Single path: in-process. Fault-isolated: DB read and rotation in separate try/catch.
if (isMainModule(import.meta.url, process.argv[1])) {
  (async () => {
    try {
      const raw = await readStdin(process.stdin);
      const payload = JSON.parse(raw);
      // Lifecycle probe (SW_PROBE=1 to activate)
      probeHook({
        session_id: payload.session_id,
        source: payload.source,
        transcript_path: payload.transcript_path,
        cwd: payload.cwd,
      });

      // Source gate: only startup|clear trigger handoff discovery
      if (!HANDOFF_HOOK_SOURCES.includes(payload.source)) {
        process.exit(0);
        return;
      }

      const contexts = [];

      // Fault domain 1: Direct DB read (zero-dependency, <5ms)
      try {
        const dbPath = defaultDbPath();
        const projectId = resolveProjectKey({
          claudeProjectDir: process.env.CLAUDE_PROJECT_DIR,
          cwd: payload.cwd,
        });
        const rows = discoverHandoffs(dbPath, projectId, payload.session_id, {
          ttlDays: HANDOFF_HOOK_TTL_DAYS,
          queryLimit: HANDOFF_HOOK_QUERY_LIMIT,
        });
        probeHandoffDiscovery({
          dbPath,
          projectId,
          sessionId: payload.session_id,
          rowCount: rows.length,
        });
        const handoffContext = formatHandoffContext(
          rows,
          HANDOFF_HOOK_MAX_DISPLAY,
          HANDOFF_HOOK_TASK_PREVIEW_CHARS,
        );
        if (handoffContext) contexts.push(handoffContext);
      } catch (e) {
        probeHandoffDiscovery({ error: e?.message }); /* fail-open */
      }

      // Fault domain 2: Discover server + rotate if needed
      try {
        const discovery = discoverServerByClientPid(process.ppid);
        if (discovery) {
          if (discovery.sessionId !== payload.session_id) {
            // Session ID mismatch → rotate
            try {
              const resp = await fetch(`${discovery.url}/api/rotate`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  session_id: payload.session_id,
                  transcript_path: payload.transcript_path,
                }),
                signal: AbortSignal.timeout(2000),
              });
              const result = await resp.json();
              if (!result.ok) {
                contexts.push(
                  buildRotationFallbackContext(
                    payload.session_id,
                    payload.transcript_path,
                  ),
                );
              }
            } catch {
              contexts.push(
                buildRotationFallbackContext(
                  payload.session_id,
                  payload.transcript_path,
                ),
              );
            }
          }
          contexts.push(buildServerContext(discovery.url));
        }
      } catch {
        /* fail-open: discovery/rotation issues don't suppress handoff context */
      }

      if (contexts.length > 0) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "SessionStart",
              additionalContext: contexts.filter(Boolean).join("\n"),
            },
          }),
        );
      }
    } catch {
      // swallow — a hook must never block or fail session start
    } finally {
      process.exit(0);
    }
  })();
}
