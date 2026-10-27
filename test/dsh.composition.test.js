// The one DSH composition: where the Turn Notes of a composed watcher land, the notes root the host binds in
// production, and what it builds: the Dialogue projection, the way a call is attributed, and the working tree the
// composition reads when it is handed none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

import { composeWatcher, DSH_TURN_NOTES_ROOT } from '../dsh/src/composition.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { openStore, closeStore } from '../lib/store.js';
import {
  sessionLog, header, turnStart, userMessage, stepStart, assistantMessage, stepEnd, turnEnd,
} from './helpers/dsh-events.js';
import { dshCallLog, editableTree, readResultText } from './helpers/attribution-fixtures.js';

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

// ── Attribution ──────────────────────────────────────────────────────────────

const LINES = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].map(name => `export const ${name} = 1;`);
const textOf = lines => `${lines.join('\n')}\n`;

// The composition over an in-memory store that is closed once `run` has returned, with `options` laid over the
// defaults.
function composed(events, options, run) {
  const store = openStore(':memory:');
  try {
    return run(composeWatcher({
      sessionId: 's-switch', cwd: '/repo', store, turnNotesRoot: join(tmpdir(), 'sw-dsh-switch-notes'),
      readSession: async () => ({ events }), isIgnored: null, cacheTtl: () => null, ...options,
    }));
  } finally {
    closeStore(store);
  }
}

// The resources a composition holds once `events` have run through it as a session that starts empty and goes on
// live.
function pathsAfter(events, options) {
  return composed(events, options, ({ watcher }) => {
    const driver = createDshSourceDriver({ sessionId: 's-switch', onDiagnostics: () => {} });
    watcher.applyHarnessFrame(driver.install([]));
    driver.drain();
    for (const event of events) {
      const frame = driver.feed(event);
      if (frame !== null) watcher.applyHarnessFrame(frame);
    }
    return watcher.getBucketData().paths.map(row => row.path);
  });
}

test('the Dialogue projection the composition builds attaches no key', () => {
  const { events } = dshCallLog([{ name: 'read', args: { file_path: 'src/a.js' }, text: readResultText('/repo/src/a.js', LINES) }]);
  const { observations } = reduceDshSnapshot(events);
  const workingTree = editableTree({ '/repo/src/a.js': textOf(LINES) }).workingTree;
  const { dialogueProjection } = composed(events, { workingTree }, composition => composition);
  assert.deepEqual(
    dialogueProjection.project(observations).folds.flatMap(fold => fold.toolPairs).map(pair => pair.resourceKeys),
    [[]],
  );
});

test('a call is attributed by the lines it shows, whatever tool made it', () => {
  const { events } = dshCallLog([{ name: 'bash', args: { command: 'cat src/b.js' }, text: textOf(LINES) }]);
  const workingTree = editableTree({ '/repo/src/b.js': textOf(LINES) }).workingTree;

  // The composition builds the matcher and the interpreter from the limits constant, which each throws on when a
  // member it reads has drifted from its name.
  assert.deepEqual(pathsAfter(events, { workingTree }), ['/repo/src/b.js']);
});

test('with no tree handed over, the composition reads the files of the session directory in the DSH namespace, where ~ is a directory name', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sw-dsh-composition-'));
  try {
    mkdirSync(join(cwd, '~'));
    writeFileSync(join(cwd, '~', 'a.js'), textOf(LINES));
    const { events } = dshCallLog([{ name: 'bash', args: { command: 'cat ~/a.js' }, text: textOf(LINES) }]);
    assert.deepEqual(pathsAfter(events, { cwd }), [`${cwd}/~/a.js`]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
