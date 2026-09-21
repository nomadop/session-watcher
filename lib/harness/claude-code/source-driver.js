// lib/harness/claude-code/source-driver.js — incremental Claude Code Source acquisition.
// Owns the Source cursor, file identity, pending partial row, and stale-branch replacement, and produces
// one HarnessFrame per advance. Source mutation is one-way: the host invokes `advance()` and applies the
// returned frame; nothing here calls back into the application, and the driver holds no descriptor
// between advances, so it has no rotation or close operation of its own.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createClaudeCodeObservationReducer, readClaudeCodeRows } from './transcript-observation.js';

export function createClaudeCodeSourceDriver({
  sourceLocator = null,
  firstReadableTransition = 'replace',
  open = openSync,
  read = readSync,
  close = closeSync,
  stat = fstatSync,
} = {}) {
  let locator = sourceLocator;
  let offset = 0;
  let nextSourceOrdinal = 1;
  let inode = null;
  let initialized = false;
  let reducer = createClaudeCodeObservationReducer();
  // A rebuild owed to the consumer, as `{ captureMode }`. It survives an advance that acquires nothing, so
  // an acquisition failure between the rebuild trigger and the frame it owes can neither downgrade that
  // frame to an append nor relabel a reconstruction as live capture. A null `captureMode` means the frame
  // takes the caller's mode, which is what the identity-change routes retain.
  let pendingReplace = null;
  let closeFailure = null;

  function rebuild(pendingCaptureMode = null) {
    reducer = createClaudeCodeObservationReducer();
    offset = 0;
    nextSourceOrdinal = 1;
    pendingReplace = { captureMode: pendingCaptureMode };
  }

  function readSpan(fd, from, until) {
    const length = Math.max(0, until - from);
    if (length === 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    const bytes = read(fd, buffer, 0, length, from);
    return buffer.subarray(0, bytes);
  }

  // `byteLimit` is an absolute Source offset bounding this advance only. Reads commit LF-terminated rows
  // only, so an unbounded advance still leaves a newline-less tail pending and a code point split across
  // advances is decoded once its row completes.
  function advance({ captureMode = 'live', byteLimit = Infinity } = {}) {
    if (closeFailure) throw closeFailure;
    let fd;
    // A Source becomes readable once open, stat and read all complete. Until then there is no frame, no
    // observed Source, and no consumed first transition — a reducer or Projection invariant failure is a
    // different thing and is never absorbed here.
    try { fd = open(locator, 'r'); } catch { return null; }
    try {
      let status;
      try { status = stat(fd); } catch { return null; }
      // A shrunken size or a new inode at the same path is a different Source: rebuild from the complete
      // file. The identity change itself creates no epoch — only the rebuilt topology can.
      if (status.size < offset || (inode != null && status.ino !== inode)) rebuild();
      const until = Math.min(status.size, byteLimit);
      let chunk;
      try { chunk = readSpan(fd, offset, until); } catch { return null; }

      const reading = readClaudeCodeRows(chunk, {
        baseOffset: offset,
        sourceOrdinal: nextSourceOrdinal,
        maxBytes: chunk.length,
      });
      let appended = reducer.append(reading.rows);
      offset = reading.nextOffset;
      nextSourceOrdinal = reading.nextSourceOrdinal;
      inode = status.ino;

      if (appended.staleBranch) {
        // The branch the consumer holds is no longer canonical, so the increment is unusable: reconstruct
        // the whole Source with fresh reducer state. That reconstruction reads already-written facts, so
        // the mode it owes is replay whatever the caller was doing, and it stays owed until a frame
        // carries it — a frame built from already-written rows may not be labelled live capture.
        rebuild('replay');
        const whole = readSpan(fd, 0, until);
        const rebuilt = readClaudeCodeRows(whole, { maxBytes: whole.length });
        appended = reducer.append(rebuilt.rows);
        offset = rebuilt.nextOffset;
        nextSourceOrdinal = rebuilt.nextSourceOrdinal;
      }

      // The first readable advance always reports its configured transition, including when the Source
      // holds no complete valid row. After that, only new batches or an owed rebuild make a frame.
      if (initialized && !pendingReplace && appended.batches.length === 0) return null;
      const transition = initialized ? (pendingReplace ? 'replace' : 'append') : firstReadableTransition;
      const mode = pendingReplace?.captureMode ?? captureMode;
      initialized = true;
      pendingReplace = null;
      return transition === 'replace'
        ? { transition, sourceLocator: locator, batches: appended.batches, sourceObserved: true, captureMode: mode }
        : { transition, batches: appended.batches, sourceObserved: true, captureMode: mode };
    } finally {
      // Every successful open closes exactly once here. A failing close is unrecoverable state, not a
      // read result: it discards this advance's frame and no later advance reads the Source.
      try { close(fd); } catch (error) { closeFailure = error; throw error; }
    }
  }

  return { advance, get sourceLocator() { return locator; } };
}
