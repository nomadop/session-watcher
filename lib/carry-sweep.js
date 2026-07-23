import { existsSync, statSync } from 'node:fs';
import { SessionWatcher } from './watcher.js';
import { poll, archiveCurrentSegment } from './fold.js';

const REPLAY_GUARD_MAX = 100000;   // backstop only; poll returns no-progress well before this

// Reuse the PRODUCTION replay to recover a crashed session's telemetry. A watcher bound to `sessionId`
// + the injected `store` re-folds the transcript through the SAME handleSegmentBoundary/TXN2 as live
// capture — each occurred segment archives profile (TXN1) + telemetry (TXN2, capture_source='cc-replay').
// The in-txn status guard (Task 7) makes re-archiving an already-`complete` segment a no-op, so this is
// safe to run over a session whose earlier segments were captured live. Returns null only if the
// transcript is unreadable/absent; otherwise { archivedSegments } (segments whose boundary ran).
//
// Imported ONLY by server.js (the composition root); store.js NEVER imports this — that keeps store.js
// DB-only and free of the watcher.js/fold.js graph. server.js injects this as the replaySession callback.
export function replaySessionTelemetry(sessionId, transcriptPath, { store } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  // Not-a-file / empty transcript: a session with no occurred segments archives nothing (correct — the
  // rows stay pending). Any stat error (permission, race) → null (indistinguishable from unreadable).
  try { const st = statSync(transcriptPath); if (!st.isFile() || st.size === 0) return { archivedSegments: 0 }; }
  catch { return null; }

  let w;
  try {
    // POSITIONAL ctor (lib/watcher.js: constructor(jsonlPath, lbase=null, opts={})). Set the session id
    // + store + replay flag so handleSegmentBoundary ACTUALLY archives (unlike a read-only replay) to the
    // RIGHT DB with replay provenance — this is the whole point: recover the crashed session's segments.
    w = new SessionWatcher(transcriptPath, null, {});
    w._sessionId = sessionId;
    // Replay provenance for EVERY segment (see fold.js handleSegmentBoundary): poll()'s internal
    // fast-path boundaries (foldCall) hardcode replayMode:false, so the watcher-level flag is what makes
    // them — and the terminal archiveCurrentSegment below — all stamp source='replay'/capture_source='cc-replay'.
    w._replayMode = true;
    if (store && typeof w.setStore === 'function') w.setStore(store);   // else the boundary uses getStore()
  } catch { return { archivedSegments: 0 }; }

  let guard = 0;
  try {
    // Drive to EOF: poll() until no progress. Each fast-path segment boundary detected while folding
    // (compact / stock-drop) archives its profile+telemetry exactly as it would have live.
    while (guard++ < REPLAY_GUARD_MAX) {
      const r = poll(w);
      if (!r || (r.newCalls === 0 && r.changed === false)) break;
    }
    // Terminal segment: the last, un-boundaried segment archives via archiveCurrentSegment (same call
    // index.js/server.js use on shutdown), so a crashed session's FINAL segment (the one the terminal-
    // archival cleanup never reached under a SIGHUP/kill) is recovered too. It goes through the same
    // handleSegmentBoundary → w._replayMode makes it cc-replay like the rest.
    archiveCurrentSegment(w);
  } catch (e) {
    // A replay error returns the best-effort count so far, never throws — the sweep must not crash the
    // server. The in-flight segment stays pending and is eligible for a later re-sweep.
    if (process.env.SW_DEBUG) console.error('[carry-sweep]', sessionId, e.message);
  }
  // archivedSegments is best-effort informational (the sweep's summary counts DB outcomes, not this).
  return { archivedSegments: (w._lastArchivedSegment ?? -1) + 1 };
}
