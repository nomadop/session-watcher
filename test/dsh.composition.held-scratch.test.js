// The scratch the composition hands the read guard (`heldScratch`): the Projection's own, read through the view that wraps the interpreter the watcher's Projection is built with, and nothing a held view pass or a rebuild leaves behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWatcher } from '../dsh/src/composition.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { openStore, closeStore } from '../lib/store.js';
import { dshCallLog, editableTree, readResultText } from './helpers/attribution-fixtures.js';
import {
  assistantMessage, compactCheckpoint, sessionLog, stepEnd, stepStart, toolResult, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';

const SESSION = 's-scratch';
const A = ['export const alpha = 1;', 'export const beta = 2;', 'export const gamma = 3;'];
const B = ['const one = "first";', 'const two = "second";'];
const textOf = lines => `${lines.join('\n')}\n`;
const FILES = { '/repo/src/a.js': textOf(A), '/repo/src/b.js': textOf(B) };
const READ_A = { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText('/repo/src/a.js', A) };
const READ_B = { name: 'read', args: { file_path: 'src/b.js' }, text: readResultText('/repo/src/b.js', B) };

function composed(t) {
  const store = openStore(':memory:');
  t.after(() => closeStore(store));
  const tree = editableTree(FILES);
  const composition = composeWatcher({
    sessionId: SESSION, cwd: '/repo', store, turnNotesRoot: join(tmpdir(), 'sw-held-scratch-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree: tree.workingTree,
  });
  return { ...composition, tree };
}

// The events through the watcher as a session that starts empty and goes on live.
function feedLive(watcher, events) {
  const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
  watcher.applyHarnessFrame(driver.install([]));
  driver.drain();
  for (const event of events) {
    const frame = driver.feed(event);
    if (frame !== null) watcher.applyHarnessFrame(frame);
  }
  return driver;
}

const linesOf = (scratch, key) => [...scratch.get(key).keys()];

test('the scratch is none before a call and holds the lines of each file a call returned once the watcher has the call', (t) => {
  const { watcher, heldScratch } = composed(t);
  assert.equal(heldScratch(), null);
  feedLive(watcher, dshCallLog([READ_A, READ_B]).events);
  assert.deepEqual(linesOf(heldScratch(), '/repo/src/a.js'), [1, 2, 3]);
  assert.deepEqual(linesOf(heldScratch(), '/repo/src/b.js'), [1, 2]);
});

test('a held view pass over the same events leaves the watcher\'s scratch as it was, since it builds its own', (t) => {
  const { watcher, heldView, heldScratch } = composed(t);
  const { events } = dshCallLog([READ_A]);
  feedLive(watcher, events);
  const scratch = heldScratch();
  const before = JSON.stringify([...scratch].map(([key, held]) => [key, [...held]]));
  heldView(events);
  assert.equal(heldScratch(), scratch);
  assert.equal(JSON.stringify([...heldScratch()].map(([key, held]) => [key, [...held]])), before);
});

test('a rebuild of the Projection from the log hands the next call\'s scratch, which holds what the rebuilt epoch holds', (t) => {
  const { watcher, heldScratch } = composed(t);
  const { events } = dshCallLog([READ_A, READ_B]);
  feedLive(watcher, events);
  const live = heldScratch();
  const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
  watcher.applyHarnessFrame(driver.install(events));
  assert.notEqual(heldScratch(), live, 'the rebuilt Projection keeps a Map of its own');
  assert.deepEqual([...heldScratch().keys()].sort(), ['/repo/src/a.js', '/repo/src/b.js']);
});

test('after an epoch boundary the scratch holds what the new epoch\'s calls returned and none of the old one\'s', (t) => {
  const { watcher, heldScratch } = composed(t);
  const step = (turn, number, call) => [
    stepStart({ turn, step: number }),
    assistantMessage({ turn, step: number, toolCalls: [{ id: `c${turn}-${number}`, name: 'read', arguments: JSON.stringify(call.args) }] }),
    toolResult({ turn, step: number, callId: `c${turn}-${number}`, text: call.text }),
    stepEnd({ turn, step: number }),
  ];
  const first = [turnStart(), userMessage({ text: 'Read a.' }), ...step(1, 1, READ_A), turnEnd()];
  const events = sessionLog([
    ...first,
    compactCheckpoint({ startSeq: 0, endSeq: first.length - 1 }),
    turnStart({ turn: 2 }), userMessage({ text: 'Read b.' }), ...step(2, 1, READ_B), turnEnd({ turn: 2 }),
  ]);
  const driver = feedLive(watcher, events.slice(0, first.length));
  assert.deepEqual([...heldScratch().keys()], ['/repo/src/a.js']);
  for (const event of events.slice(first.length)) {
    const frame = driver.feed(event);
    if (frame !== null) watcher.applyHarnessFrame(frame);
  }
  assert.deepEqual([...heldScratch().keys()], ['/repo/src/b.js']);
});

test('the call a new epoch issues finds the scratch of that epoch, so a read of a file the earlier epoch held is judged against nothing', (t) => {
  const { watcher, heldScratch } = composed(t);
  const first = [
    turnStart(), userMessage({ text: 'Read a.' }),
    stepStart({ turn: 1, step: 1 }),
    assistantMessage({ turn: 1, step: 1, toolCalls: [{ id: 'c1-1', name: 'read', arguments: JSON.stringify(READ_A.args) }] }),
    toolResult({ turn: 1, step: 1, callId: 'c1-1', text: READ_A.text }),
    stepEnd({ turn: 1, step: 1 }), turnEnd(),
  ];
  const events = sessionLog([
    ...first,
    compactCheckpoint({ startSeq: 0, endSeq: first.length - 1 }),
    turnStart({ turn: 2 }), userMessage({ text: 'Read a again.' }),
    stepStart({ turn: 2, step: 1 }),
    assistantMessage({ turn: 2, step: 1, toolCalls: [{ id: 'c2-1', name: 'read', arguments: JSON.stringify(READ_A.args) }] }),
  ]);
  const driver = feedLive(watcher, events.slice(0, first.length));
  assert.deepEqual([...heldScratch().keys()], ['/repo/src/a.js']);
  for (const event of events.slice(first.length)) {
    const frame = driver.feed(event);
    if (frame !== null) watcher.applyHarnessFrame(frame);
  }
  assert.deepEqual([...heldScratch().keys()], [], 'the new epoch holds nothing yet, and the read is issued, not answered');
});
