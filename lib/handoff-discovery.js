// lib/handoff-discovery.js — pending-handoff discovery and its context prose.
// The Claude Code hook and the DSH host plugin's `agent/created` injection both call it, so the read and its formatting have one home.
import { DatabaseSync } from "node:sqlite";

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
