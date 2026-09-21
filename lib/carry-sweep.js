// lib/carry-sweep.js — carry reconstruction: recover a crashed session's telemetry from its Source.
//
// It composes the HOST's own `SessionWatcher` factory with a source driver in Source Reconstruction mode and
// drives the driver to the end of the Source, applying every returned frame. That is the whole of it: the
// archival path, the Resource Policy and the profile/telemetry provenance come from that one composition
// rather than from a second table maintained here, and the project context it resolves against is the
// host's to supply.

import { existsSync, statSync } from 'node:fs';
import { createClaudeCodeSourceDriver } from './harness/claude-code/source-driver.js';

// A backstop only: an advance that returns no frame ends the loop well before this.
const RECONSTRUCTION_GUARD_MAX = 100000;

/**
 * Rebuild one session's segments from its Source.
 *
 * @param {string} sessionId
 * @param {string} transcriptPath
 * @param {{ store: object, createWatcher: function }} deps
 * @returns {true|null} `true` after a COMPLETE reconstruction, including when no segment was archived;
 *   `null` when the Source is unavailable. A reconstruction error THROWS, into the Store's existing
 *   per-session failure isolation, so the session's rows stay pending and eligible for a later retry. A
 *   MISSING host callback also throws rather than answering `null`: a wiring fault is not an unreadable
 *   transcript, and reporting it as one would leave the session pending forever with nothing to find.
 */
export function replaySessionTelemetry(sessionId, transcriptPath, { store, createWatcher } = {}) {
  // Ahead of every Source probe: a composition this module was never given is a programming error in the
  // host, and it must not be reported as a property of the transcript.
  if (typeof createWatcher !== 'function') {
    throw new Error('replaySessionTelemetry requires the host\'s createWatcher composition callback');
  }
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  // Not-a-file is unavailability. A readable Source with nothing usable in it — empty, or holding only an
  // incomplete row — reconstructs COMPLETELY and archives nothing, which is a success: the rows it would have
  // archived do not exist, and calling it unavailable would leave the session pending for a sweep that could
  // never fix it. Any stat error is unavailability.
  try { const stat = statSync(transcriptPath); if (!stat.isFile()) return null; if (stat.size === 0) return true; }
  catch { return null; }

  const watcher = createWatcher({ store, sessionId, sourceLocator: transcriptPath });
  const driver = createClaudeCodeSourceDriver({
    sourceLocator: transcriptPath, firstReadableTransition: 'replace',
  });

  // Drive to the end of the Source. Every frame is Source Reconstruction: it reads facts already written, so
  // its profile rows and telemetry carry replay provenance and its archive times come from the steps
  // themselves rather than this process's clock.
  let advances = 0;
  let sawFrame = false;
  while (advances++ < RECONSTRUCTION_GUARD_MAX) {
    const frame = driver.advance({ captureMode: 'replay' });
    if (!frame) break;
    sawFrame = true;
    // A Source or application error propagates: the incomplete segment stays OPEN and unarchived, because a
    // close here would freeze a segment whose later rows were never applied.
    watcher.applyHarnessFrame(frame);
  }
  // A Source that never became readable produced no frame at all: `open`, `stat` or `read` failed every time,
  // which is unavailability. A readable Source always yields its configured first transition, even when it
  // holds no complete valid row — so an incomplete-only Source reaches the close below and answers `true`.
  if (!sawFrame) return null;

  // The terminal segment: the one a crashed owner's cleanup never reached. It closes through the SHARED
  // archival path and synthesizes no epoch, so a session whose Source ends mid-segment still persists it.
  // Reached only after every advance and application above succeeded.
  watcher.closeCurrentSegment({ captureMode: 'replay' });
  return true;
}
