import { readdirSync, statSync, unlinkSync, readFileSync } from 'node:fs';
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
