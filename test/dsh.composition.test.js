// The one DSH composition: where the Turn Notes of a composed watcher land, and the notes root the host binds in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { composeWatcher, DSH_TURN_NOTES_ROOT } from '../dsh/src/composition.js';
import { openStore, closeStore } from '../lib/store.js';
import {
  sessionLog, header, turnStart, userMessage, stepStart, assistantMessage, stepEnd, turnEnd,
} from './helpers/dsh-events.js';

test('get_turn_skeleton\'s notes_path sits in the epoch directory directly under the turnNotesRoot the composition is handed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-dsh-composition-'));
  const store = openStore(join(dir, 'store.sqlite'));
  const turnNotesRoot = join(dir, 'turn-notes');
  const session = header({ id: 's-composed' });
  const events = sessionLog([
    turnStart(), userMessage({ text: 'question' }), stepStart(),
    assistantMessage({ text: 'answer', usage: { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 } }),
    stepEnd(), turnEnd(),
  ]);
  try {
    const { watcher } = composeWatcher({
      sessionId: session.id, cwd: session.cwd, store, turnNotesRoot,
      readSession: async () => ({ session, inheritedEventCount: 0, events }), isIgnored: null, cacheTtl: () => null,
    });
    const { notes_path: notesPath } = await watcher.getTurnSkeleton();
    assert.equal(basename(notesPath), 'notes.md');
    assert.equal(dirname(dirname(notesPath)), turnNotesRoot);
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the host\'s production notes root sits under the os temp directory and outside the Claude Code state directory', () => {
  assert.ok(DSH_TURN_NOTES_ROOT.startsWith(tmpdir() + sep), DSH_TURN_NOTES_ROOT);
  assert.ok(!DSH_TURN_NOTES_ROOT.startsWith(join(homedir(), '.session-watcher')), DSH_TURN_NOTES_ROOT);
});
