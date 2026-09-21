// lib/harness/claude-code/dialogue-source.js — Claude Code DialogueSource Adapter.
// A read-only pull path: one call reads the complete Source, reconstructs it with fresh state, and
// returns a detached canonical multi-epoch observation snapshot. The Adapter is the only interpreter of
// `sourceLocator`; Claude Code uses the transcript path.

import { readFileSync } from 'node:fs';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from './transcript-observation.js';

export function createClaudeCodeDialogueSource({ readFile = readFileSync } = {}) {
  return {
    read(sourceLocator) {
      let buffer;
      // File acquisition failure is a read result, not application health, and not a reducer invariant
      // failure: only the acquisition itself is guarded here.
      try { buffer = readFile(sourceLocator); }
      catch { return { status: 'unavailable', observations: [] }; }
      // A sealed read accepts a final row without LF; each call parses the Source afresh, so the values
      // it returns share nothing with an earlier read or with reducer state.
      const rows = readClaudeCodeRows(buffer, { atEof: true }).rows;
      return { status: 'ok', observations: reduceClaudeCodeSnapshot(rows).observations };
    },
  };
}
