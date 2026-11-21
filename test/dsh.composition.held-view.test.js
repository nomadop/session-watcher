// The held view the composition hands an inner seal: a pass over a raw event slice of its own, apart from the live
// watcher, whose Engine answers the line keys of every held file and whose accepted skill effects answer the held
// skill texts. Each case compares it with the live watcher's Engine at the same point of the same log.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWatcher } from '../dsh/src/composition.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { openStore, closeStore } from '../lib/store.js';
import { dshCallLog, editableTree, readResultText, toolUseIdOf } from './helpers/attribution-fixtures.js';
import {
  assistantMessage, compactCheckpoint, sessionLog, stepEnd, stepStart, toolResult, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';

const SESSION = 's-held';
const A = ['export const alpha = 1;', 'export const beta = 2;', 'export const gamma = 3;', 'export const delta = 4;', 'export const epsilon = 5;'];
const B = ['const one = "first";', 'const two = "second";', 'const three = "third";'];
const textOf = lines => `${lines.join('\n')}\n`;
const FILES = { '/repo/src/a.js': textOf(A), '/repo/src/b.js': textOf(B) };

// A read of lines 2 to 4 of a.js and a `cat` of b.js.
const CALLS = [
  { name: 'read', args: { file_path: 'src/a.js', offset: 2, limit: 3 }, text: readResultText('/repo/src/a.js', A, { from: 2, to: 4 }) },
  { name: 'bash', args: { command: 'cat src/b.js' }, text: textOf(B) },
];
// The fingerprint the matcher records for an empty line.
const EMPTY_LINE_FP = 2166136261;
const HELD = new Map([['/repo/src/a.js', [2, 3, 4]], ['/repo/src/b.js', [1, 2, 3]]]);

// The composition over an in-memory store and an editable tree, closed when the case ends.
function composed(t, files = FILES) {
  const store = openStore(':memory:');
  t.after(() => closeStore(store));
  const tree = editableTree(files);
  const composition = composeWatcher({
    sessionId: SESSION, cwd: '/repo', store, turnNotesRoot: join(tmpdir(), 'sw-held-view-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree: tree.workingTree,
  });
  return { ...composition, store, tree };
}

// The events through the watcher as a session that starts empty and goes on live, so each call keeps its record.
function feedLive(watcher, events) {
  const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
  watcher.applyHarnessFrame(driver.install([]));
  driver.drain();
  for (const event of events) {
    const frame = driver.feed(event);
    if (frame !== null) watcher.applyHarnessFrame(frame);
  }
}

// The line keys the live watcher's Engine holds of each file, read off that Engine itself: the watcher's public reads
// drop a resource's line keys, and the equality the held view owes is with the Engine's key sets.
const liveLines = watcher => new Map([...watcher._engine.heldLines()].filter(([key]) => !key.startsWith('skill:')));

const sortedByPath = map => new Map([...map].sort(([a], [b]) => a.localeCompare(b)));

describe('the held line keys', () => {
  test('with the live records, they equal the live Engine\'s at the same point, however the tree has changed since', (t) => {
    const { watcher, heldView, tree } = composed(t);
    const { events } = dshCallLog(CALLS);
    feedLive(watcher, events);
    assert.deepEqual(sortedByPath(liveLines(watcher)), HELD);
    tree.set({ '/repo/src/a.js': textOf(['// moved', '// down', ...A]), '/repo/src/b.js': textOf(['// moved', ...B]) });
    assert.deepEqual(sortedByPath(heldView(events).paths), HELD);
  });

  // The watcher reads the log as a snapshot replay, which keeps no record: every call is matched again.
  function replayed(t) {
    const composition = composed(t);
    const { events } = dshCallLog(CALLS);
    const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
    composition.watcher.applyHarnessFrame(driver.install(events));
    return { ...composition, events };
  }
  const recorded = store => CALLS.map((_, index) => store.recallAttribution(SESSION, toolUseIdOf(index + 1)));

  test('without records over the tree the live Engine matched, they equal its key sets, and no record is written', (t) => {
    const { watcher, heldView, store, events } = replayed(t);
    assert.deepEqual(sortedByPath(liveLines(watcher)), HELD);
    assert.deepEqual(sortedByPath(heldView(events).paths), HELD);
    assert.deepEqual(recorded(store), [null, null]);
  });

  test('without records over a tree changed since, they follow the tree as it is now, the estimate the missing records leave, and no record is written', (t) => {
    const { heldView, store, tree, events } = replayed(t);
    tree.set({ '/repo/src/a.js': textOf(['// moved', '// down', ...A]), '/repo/src/b.js': textOf(['// moved', ...B]) });
    assert.deepEqual(sortedByPath(heldView(events).paths), new Map([['/repo/src/a.js', [4, 5, 6]], ['/repo/src/b.js', [2, 3, 4]]]));
    assert.deepEqual(recorded(store), [null, null]);
  });
});

describe('apart from the watcher', () => {
  test('a watcher that has applied no frame yet, or whose frame failed, leaves the held view answering the slice', (t) => {
    const { events } = dshCallLog(CALLS);
    const bootstrapping = composed(t);
    assert.deepEqual(sortedByPath(bootstrapping.heldView(events).paths), HELD);
    const failed = composed(t);
    assert.throws(() => failed.watcher.applyHarnessFrame({ transition: 'unknown', batches: [] }));
    assert.deepEqual(sortedByPath(failed.heldView(events).paths), HELD);
  });

  // The matcher leaves a file of empty lines alone unmatched and charges a `read` result's line-number prefix to each line,
  // so a resource of empty lines that weighs nothing is held only through a record whose entries are those lines alone:
  // each of no characters, under the fingerprint of an empty line.
  test('a held file of empty lines keeps its line keys, though it weighs nothing', (t) => {
    const { heldView, store } = composed(t, { '/repo/src/blank.txt': '\n\n\n' });
    const { events } = dshCallLog([{ name: 'bash', args: { command: 'cat src/blank.txt' }, text: '\n\n\n' }]);
    const entries = [1, 2, 3].map(key => ({ key, chars: 0, cjk: 0, fp: EMPTY_LINE_FP }));
    store.rememberAttribution(SESSION, toolUseIdOf(1), {
      v: 1, effects: [{ access: 'read', impacts: [{ resourceKey: '/repo/src/blank.txt', kind: 'replace-fragments', entries }] }], residual: null,
    });
    assert.deepEqual(heldView(events).paths, new Map([['/repo/src/blank.txt', [1, 2, 3]]]));
  });
});

// ── Skills ───────────────────────────────────────────────────────────────────

const USAGE = { inputTokens: 3, outputTokens: 40, cacheWriteTokens: 9600 };
const skillCall = (step, callId, name) => assistantMessage({ step, usage: USAGE, toolCalls: [{ id: callId, name: 'skill', arguments: JSON.stringify({ name }) }] });
const skillResult = (step, callId, text, isError = false) => toolResult({ step, callId, text, isError });

// The skill keys the live watcher's Engine holds.
const liveSkills = watcher => [...watcher._engine.heldLines().keys()].filter(key => key.startsWith('skill:')).map(key => key.slice('skill:'.length)).sort();

describe('the held skills', () => {
  test('each skill is the text behind its accepted effect: a failed call adds none, a held result counts once its use arrives, and a revised result keeps the first', (t) => {
    const { watcher, heldView } = composed(t);
    const events = sessionLog([
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillCall(1, 'c1', 'tdd'), skillResult(1, 'c1', 'TDD body'), stepEnd({ step: 1 }),
      stepStart({ step: 2 }), skillCall(2, 'c2', 'tdd'), skillResult(2, 'c2', 'tdd failed', true), stepEnd({ step: 2 }),
      stepStart({ step: 3 }), skillCall(3, 'c3', 'grill'), skillResult(3, 'c3', 'Grill body'), skillResult(3, 'c3', 'Grill revised'), stepEnd({ step: 3 }),
      stepStart({ step: 4 }), skillResult(4, 'c4', 'Domain body'), skillCall(4, 'c4', 'domain'), stepEnd({ step: 4 }),
      stepStart({ step: 5 }), skillCall(5, 'c5', 'unread'), skillResult(5, 'c5', 'never loaded', true), stepEnd({ step: 5 }),
      turnEnd(),
    ]);
    feedLive(watcher, events);
    const { skills } = heldView(events);
    assert.deepEqual(skills, new Map([['tdd', 'TDD body'], ['grill', 'Grill body'], ['domain', 'Domain body']]));
    assert.deepEqual([...skills.keys()].sort(), liveSkills(watcher));
  });

  test('a later successful call replaces the text, and an epoch boundary leaves only the skills loaded after it', (t) => {
    const { watcher, heldView } = composed(t);
    const before = [
      turnStart(), userMessage({ text: 'Work.' }),
      stepStart({ step: 1 }), skillCall(1, 'c1', 'tdd'), skillResult(1, 'c1', 'TDD v1'), stepEnd({ step: 1 }),
      stepStart({ step: 2 }), skillCall(2, 'c2', 'tdd'), skillResult(2, 'c2', 'TDD v2'), stepEnd({ step: 2 }),
      stepStart({ step: 3 }), skillCall(3, 'c3', 'grill'), skillResult(3, 'c3', 'Grill body'), stepEnd({ step: 3 }),
      turnEnd(),
    ];
    assert.deepEqual(heldView(sessionLog(before)).skills, new Map([['tdd', 'TDD v2'], ['grill', 'Grill body']]));
    const events = sessionLog([
      ...before,
      compactCheckpoint({ startSeq: before[1].seq, endSeq: before.at(-2).seq }),
      turnStart({ turn: 2 }), userMessage({ text: 'Go on.' }),
      stepStart({ turn: 2, step: 1 }),
      assistantMessage({ turn: 2, step: 1, usage: USAGE, toolCalls: [{ id: 'c9', name: 'skill', arguments: JSON.stringify({ name: 'domain' }) }] }),
      toolResult({ turn: 2, step: 1, callId: 'c9', text: 'Domain body' }), stepEnd({ turn: 2, step: 1 }), turnEnd({ turn: 2 }),
    ]);
    feedLive(watcher, events);
    const { skills } = heldView(events);
    assert.deepEqual(skills, new Map([['domain', 'Domain body']]));
    assert.deepEqual([...skills.keys()], liveSkills(watcher));
  });
});
