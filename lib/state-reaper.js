import { readdirSync, statSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getStore } from './store.js';
import { GC_BATCH_LIMIT } from './constants.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }
}

// Check if a session has a live port file (daemon still running)
function isLivePortFile(sessionId, portDir) {
  if (!portDir) return false;
  if (!sessionId || /[/\\\0]/.test(sessionId) || sessionId === '..' || sessionId === '.') return false;
  try {
    const p = join(portDir, `${sessionId}.json`);
    const record = JSON.parse(readFileSync(p, 'utf8'));
    return record.pid && isPidAlive(record.pid);
  } catch { return false; }
}

function resolveTranscriptPath(sessionId, portDir) {
  if (!portDir || !sessionId) return null;
  try {
    const p = join(portDir, `${sessionId}.json`);
    const record = JSON.parse(readFileSync(p, 'utf8'));
    return record.transcriptPath || null;
  } catch { return null; }
}

// SQLite-backed session sweep (archive-then-delete for expired sessions)
export function sweepStaleState({ maxAgeMs = MAX_AGE_MS, now = Date.now(), portDir = null,
                                  limit = GC_BATCH_LIMIT } = {}) {
  const store = getStore();
  return store.sweep(maxAgeMs, {
    now,
    isLiveSession: portDir ? (sid) => isLivePortFile(sid, portDir) : undefined,
    resolveTranscriptPath: portDir ? (sid) => resolveTranscriptPath(sid, portDir) : undefined,
    // TODO: replaySession callback — requires SessionWatcher import (spec §14).
    // Replay-first GC exercised via unit test injection; production gains it when
    // transcript-path resolution lands.
    replaySession: undefined,
    limit,
  });
}

// File-based port file sweep (separate — port files remain on filesystem)
export function sweepStalePortFiles(portDir, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  let removed = 0;
  let entries;
  try { entries = readdirSync(portDir); } catch { return 0; }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const p = join(portDir, f);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > maxAgeMs) {
        try {
          const record = JSON.parse(readFileSync(p, 'utf8'));
          if (record.pid && isPidAlive(record.pid)) continue;
        } catch { /* unreadable → treat as dead */ }
        unlinkSync(p); removed++;
      }
    } catch { /* skip */ }
  }
  return removed;
}

// The age fallback behind the two turn-note files. Their normal retirement is the rmSync
// submitTurnNotes runs once the rows are in; this covers every route that never reaches that commit —
// an abandoned producer, a twice-rejected submission, a killed process — so an unredacted skeleton
// does not sit under the state dir indefinitely.
//
// Age is the NEWEST mtime in the directory, never the directory's own. On Linux a directory's mtime
// moves when an entry is created, renamed or unlinked, NOT when a file it already holds is written —
// so a producer filling notes.md, and a re-fetch overwriting skeleton.txt, both leave a long-lived
// epoch's directory reading as untouched since creation, and judging by it alone would delete notes
// still being written. The directory's own mtime still participates, as the record of the pair being
// created, which is also what gives an empty directory an age at all.
//
// Only directories are swept: the server creates nothing else here, and it never deletes what it did
// not write. A per-directory failure is skipped rather than aborting the sweep.
export function sweepStaleTurnNotes(stateDir, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  const root = join(stateDir, 'turn-notes');
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      let latest = statSync(dir).mtimeMs;
      for (const name of readdirSync(dir)) {
        try { latest = Math.max(latest, statSync(join(dir, name)).mtimeMs); } catch { /* skip */ }
      }
      if (now - latest > maxAgeMs) { rmSync(dir, { recursive: true, force: true }); removed++; }
    } catch { /* skip */ }
  }
  return removed;
}
