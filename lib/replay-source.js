// lib/replay-source.js — a Transcript Playback source, opened by the file's bytes.

import { readFileSync } from 'node:fs';
import { indexTranscript } from './replay.js';
import { createClaudeCodeSourceDriver } from './harness/claude-code/source-driver.js';
import { decodeDshLog } from './harness/dsh/log-frames.js';
import { createDshPlaybackDriver, indexDshLog } from './harness/dsh/playback.js';

/**
 * The playback source at `path`: `{ harness, index, createDriver, header, dialogueSnapshot }`. A file
 * `decodeDshLog` decodes opens as `dsh` — its index from `indexDshLog`, a DSH playback driver over its events
 * under the header's id, its header, and `{ session: header, inheritedEventCount: 0, events }` as the snapshot
 * the replay composition's `readSession` answers. Any other file opens as `claude-code`, indexed by
 * `indexTranscript` and played by a Claude Code source driver whose first readable frame replaces, with no header
 * and no snapshot. A zstd or gzip file that is no DSH log throws from the decoder. Each `createDriver()` call
 * answers a new driver.
 * @param {string} path
 * @returns {{ harness: 'dsh'|'claude-code', index: { limit: number, ts: number|null }[],
 *   createDriver: () => { advance: (options: { captureMode?: string, limit?: number }) => object|null },
 *   header: object|null, dialogueSnapshot: object|null }}
 */
export function openReplaySource(path) {
  const log = decodeDshLog(readFileSync(path));
  if (log !== null) {
    const { header, events } = log;
    return {
      harness: 'dsh',
      index: indexDshLog(events),
      createDriver: () => createDshPlaybackDriver({ sessionId: header.id, events }),
      header,
      dialogueSnapshot: { session: header, inheritedEventCount: 0, events },
    };
  }
  return {
    harness: 'claude-code',
    index: indexTranscript(path),
    createDriver: () => createClaudeCodeSourceDriver({ sourceLocator: path, firstReadableTransition: 'replace' }),
    header: null,
    dialogueSnapshot: null,
  };
}
