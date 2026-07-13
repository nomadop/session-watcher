import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

// Generalized atomic JSON writer (B2): temp file → renameSync (atomic on same fs), so a crash
// mid-write never leaves a half-written state file. Not gate/ledger-specific — reused by
// rate-lamp-store, gate-store, and (v1.2) pricing-store. Caller owns path selection
// (${CLAUDE_PLUGIN_DATA} or ~/.session-watcher; NEVER ${CLAUDE_PLUGIN_ROOT} — non-persistent).
let _tmpSeq = 0;
export function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  // Unique temp name (review GPT#12): concurrent writers / leftover-after-crash must not collide on
  // a single `${path}.tmp`. pid + monotonic counter is enough (no Date.now — banned in workflow ctx;
  // in server ctx a counter is deterministic and sufficient).
  const tmp = `${path}.${process.pid}.${_tmpSeq++}.tmp`;
  // round-7 gemini#1: if writeFileSync throws (ENOSPC / EACCES) the rename never runs → the unique .tmp
  // would dangle forever (state-file GC is deferred, C2). try/finally unlinks the temp UNLESS the rename
  // consumed it. `renamed` gates the cleanup so a successful write is untouched; rmSync(force) swallows
  // the already-renamed / never-created cases. Keeps the write atomic AND self-cleaning on failure.
  let renamed = false;
  try {
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) rmSync(tmp, { force: true }); // best-effort: never leave an orphan .tmp on a failed write
  }
}

// round-6 GPT#3b: sanitize a sessionId used as a filename SEGMENT. sessionId is a harness UUID (safe in
// practice), but a `/`, `\`, `..`, or NUL would let `${sessionId}.json` escape the state dir — reject it
// to a stable sentinel rather than traverse. Defense-in-depth (belt-and-suspenders), not a known exploit.
export function safeSessionId(sessionId) {
  const s = String(sessionId ?? '');
  if (!s || s === '.' || s === '..' || /[/\\\0]/.test(s) || s.includes('..')) return '__invalid_session__';
  return s;
}
