// The Claude Code composition, end to end: the real SessionWatcher over the real store (in memory), the composition's
// own matcher and interpreter over an in-memory working tree, and the transcript the Claude Code Source driver reads.
// It covers which frames write an Attribution Record, what Source Reconstruction replays from the records and what it
// matches again without them, the keys Turn History takes at capture, and the working tree the composition reads when
// it is handed none. Every path, line and row is authored.
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWatcherComposition } from '../server.js';
import { createClaudeCodeSourceDriver } from '../lib/harness/claude-code/source-driver.js';
import { readClaudeCodeRows, reduceClaudeCodeSnapshot } from '../lib/harness/claude-code/transcript-observation.js';
import { createClaudeCodeDialogueSource } from '../lib/harness/claude-code/dialogue-source.js';
import { createClaudeCodeDialogueProjection } from '../lib/harness/claude-code/history-turn-rules.js';
import { LOCATE_HIT_RECOVERY, SEARCH_HIT_RECOVERY, TURN_NOTICE } from '../lib/harness/claude-code/turn-recovery.js';
import { createTurnReadService } from '../lib/turn-read-service.js';
import { closeStore, openStore } from '../lib/store.js';
import { countsToTokens } from '../lib/token-estimate.js';
import { observationsOf, transcriptBytes } from './helpers/transcript-fixtures.js';
import {
  CC_HOME, CWD, SILENT_TREE, ccCallLog, ccReadResultText, ccToolUseIdOf, editableTree, linesText, watchedTree,
} from './helpers/attribution-fixtures.js';

const SESSION = 's-attributed';
const ELSEWHERE = 's-elsewhere';
const UNTOUCHED = { resolve: 0, stat: 0, readText: 0 };

let dir;
const stores = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-cc-attribution-'));
});

afterEach(() => {
  for (const store of stores.splice(0)) closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

function newStore() {
  const store = openStore(':memory:');
  stores.push(store);
  return store;
}

const numbers = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

// A watcher composed over `store` and `workingTree`, and the means to feed it as the host does:
// `snapshot(entries)` writes the transcript and takes it with a first read, a replace under the replay capture mode,
// and `feed(entries)` appends rows to it and takes what a poll tick takes after that, an append under the live one.
// A frame's diagnostics are kept: a store that failed a read or a write shows there.
function watch({
  store, workingTree, sessionId = SESSION, projectRoot = CWD,
  file = join(dir, `${sessionId ?? 'unnamed'}.jsonl`),
}) {
  const watcher = createWatcherComposition({
    sessionId, sourceLocator: file, projectId: 'p-attributed', projectRoot, stateDir: join(dir, 'state'), store,
    isIgnored: null, cacheTtl: null, workingTree,
  });
  const diagnostics = [];
  let driver = null;
  const apply = (frame) => {
    if (frame !== null) diagnostics.push(...watcher.applyHarnessFrame(frame).diagnostics);
    return frame;
  };
  return {
    watcher,
    diagnostics,
    file,
    apply,
    get driver() { return driver; },
    snapshot(entries) {
      writeFileSync(file, transcriptBytes(entries));
      driver = createClaudeCodeSourceDriver({ sourceLocator: file, firstReadableTransition: 'replace' });
      return apply(driver.advance({ captureMode: 'replay' }));
    },
    feed(entries) {
      appendFileSync(file, transcriptBytes(entries));
      return apply(driver.advance({ captureMode: 'live' }));
    },
  };
}

// Everything a reader of the watcher can see of the Engine's belief, as the JSON it writes.
const stateOf = watcher => JSON.parse(JSON.stringify({ buckets: watcher.getBucketData(), history: watcher.getHistory() }));
const pathsOf = watcher => watcher.getBucketData().paths;
const pathKeysOf = watcher => pathsOf(watcher).map(row => row.path).sort();
const rowFor = (watcher, path) => pathsOf(watcher).find(row => row.path === path);

// The transcript read once for its opening row and then fed live a call at a time, with the state read after each
// `cuts` entry and at the end.
function runLive({ store, workingTree, entries, cuts = [], sessionId }) {
  const rig = watch({ store, workingTree, sessionId });
  rig.snapshot(entries.slice(0, 1));
  const states = [];
  let from = 1;
  for (const cut of cuts) {
    rig.feed(entries.slice(from, cut));
    from = cut;
    states.push(stateOf(rig.watcher));
  }
  rig.feed(entries.slice(from));
  return { rig, states, final: stateOf(rig.watcher) };
}

const recordCount = (store, sessionId) => store._db
  .prepare('SELECT COUNT(*) AS n FROM attribution_record WHERE session_id = ?').get(sessionId).n;

// A store method that fails every time it is called, as a locked database does.
function failing(store, method) {
  store[method] = () => { throw new Error('database is locked'); };
}

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? 'tokens'}: ${actual} is not ${expected}`);
}

// ── The files and calls ──────────────────────────────────────────────────────

const A = '/repo/src/a.js';
const B = '/repo/src/b.js';
const NOTES = '/repo/notes.txt';

const A_LINES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
  .map((name, index) => `const ${name} = ${index + 1};`);
const B_LINES = [
  'export const bravoFirst = 1;',
  'export const bravoSecond = 2;',
  'export const bravoThird = 3;',
  'export const bravoFourth = 4;',
  'export const bravoFifth = 5;',
  'export default bravoFirst;',
];
const NOTES_LINES = ['first note', 'second note', 'third note', 'fourth note', 'fifth note', 'sixth note', 'seventh note', 'eighth note'];

const SKILL_LAUNCH = 'Launching skill: tdd';
const SKILL_BODY = [
  'Base directory for this skill: /skills/tdd', '', '# Test-Driven Development', 'Red, then green.',
].join('\n');
const MISSING_TEXT = 'File does not exist.';

const TREE = { [A]: linesText(A_LINES), [B]: linesText(B_LINES) };
const treeOf = (files = TREE) => editableTree(files, CC_HOME);
const watchedTreeOf = (files = TREE) => watchedTree(files, CC_HOME);

// A whole-file read, a call that matches nothing, a skill with its payload row, a failed read, and a `cat` of a
// file no tool name says is read.
const SESSION_CALLS = [
  { name: 'Read', input: { file_path: 'src/a.js' }, content: ccReadResultText(A_LINES) },
  { name: 'Bash', input: { command: 'git status --short' }, content: ' M src/a.js\n?? notes.txt\n' },
  { name: 'Skill', input: { skill: 'tdd' }, content: SKILL_LAUNCH, payload: SKILL_BODY },
  { name: 'Read', input: { file_path: 'src/missing.js' }, content: MISSING_TEXT, isError: true },
  { name: 'Bash', input: { command: 'cat src/b.js' }, content: linesText(B_LINES) },
];
const SESSION_LOG = ccCallLog(SESSION_CALLS);
// The resources the Engine holds once each of those calls is folded in.
const PATHS_AFTER_CALL = [[A], [A], [A], [A], [A, B]];

// ── Which frames write a record ──────────────────────────────────────────────

describe('the Attribution Records a session keeps', () => {
  test('an append+live poll writes one record per attributed call under the current session id, holding no file text', () => {
    const store = newStore();
    const { rig } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });

    const records = SESSION_CALLS.map((_, index) => store.recallAttribution(SESSION, ccToolUseIdOf(index + 1)));
    assert.deepEqual(records.map(record => record !== null), [true, true, false, true, true],
      'every call but the skill, which the matcher never sees');
    assert.equal(recordCount(store, SESSION), 4);
    assert.equal(recordCount(store, ELSEWHERE), 0);

    const impactsOf = record => record.effects.map(effect => effect.impacts.map(impact => [
      effect.access, impact.resourceKey, impact.kind, impact.entries.map(entry => entry.key),
    ]));
    assert.deepEqual(impactsOf(records[0]), [[['read', A, 'replace-fragments', numbers(1, 8)]]]);
    assert.deepEqual(impactsOf(records[4]), [[['read', B, 'replace-fragments', numbers(1, 6)]]],
      'a cat is attributed by what it shows, whatever the tool is called');
    assert.deepEqual(records[1].effects, []);
    assert.equal(records[1].residual.weight,
      JSON.stringify(SESSION_CALLS[1].input).length + SESSION_CALLS[1].content.length, 'a call that matches nothing is all residual');
    assert.deepEqual(records[3].effects, []);

    const stored = store._db.prepare('SELECT record FROM attribution_record WHERE session_id = ?').all(SESSION)
      .map(row => row.record).join('\n');
    for (const line of [...A_LINES, ...B_LINES]) assert.ok(!stored.includes(line), `the records hold no file text: ${line}`);

    assert.deepEqual(pathKeysOf(rig.watcher), [A, B]);
    assert.deepEqual(rig.watcher.getBucketData().skills.map(skill => skill.name), ['tdd'], 'the skill is charged as before');
    assert.deepEqual(rig.diagnostics, []);
  });

  test('the first read of a Source, an identity-change rebuild that takes the caller\'s live mode, and a rotate frame write no record', () => {
    const log = ccCallLog([
      { name: 'Read', input: { file_path: 'src/a.js' }, content: ccReadResultText(A_LINES) },
      { name: 'Bash', input: { command: 'cat src/b.js' }, content: linesText(B_LINES) },
      { name: 'Read', input: { file_path: 'notes.txt' }, content: ccReadResultText(NOTES_LINES) },
    ]);
    const [afterFirst, afterSecond, afterThird] = log.cuts;
    const store = newStore();
    const tree = treeOf({ ...TREE, [NOTES]: linesText(NOTES_LINES) });
    const rig = watch({ store, workingTree: tree.workingTree });

    const first = rig.snapshot(log.entries.slice(0, afterFirst));
    assert.deepEqual([first.transition, first.captureMode], ['replace', 'replay']);
    assert.equal(recordCount(store, SESSION), 0, 'the first read folds the first call and keeps nothing');
    rig.feed(log.entries.slice(afterFirst, afterSecond));
    assert.equal(recordCount(store, SESSION), 1, 'the poll after it keeps the second call');

    // The Source is replaced by a file that holds one call more, the tree is gone, and the next live poll rebuilds.
    tree.set({});
    const replacement = `${rig.file}.swap`;
    writeFileSync(replacement, transcriptBytes(log.entries.slice(0, afterThird)));
    renameSync(replacement, rig.file);
    const rebuilt = rig.apply(rig.driver.advance({ captureMode: 'live' }));
    assert.deepEqual([rebuilt.transition, rebuilt.captureMode], ['replace', 'live'],
      'the identity change takes the mode of the poll that found it');
    assert.equal(recordCount(store, SESSION), 1, 'the third call was folded by the rebuild and keeps nothing');
    assert.deepEqual(pathKeysOf(rig.watcher), [B], 'the second call replays from its record over a tree that is gone');

    // The host's rotation: a fresh driver over the new Source, its first read inside one live `rotate` frame.
    const rotatedFile = join(dir, 'rotated.jsonl');
    const rotatedLog = ccCallLog([
      { name: 'Read', input: { file_path: 'src/a.js' }, content: ccReadResultText(A_LINES) },
      { name: 'Bash', input: { command: 'cat src/b.js' }, content: linesText(B_LINES) },
    ]);
    tree.set(TREE);
    writeFileSync(rotatedFile, transcriptBytes(rotatedLog.entries.slice(0, rotatedLog.cuts[0])));
    const rotated = createClaudeCodeSourceDriver({ sourceLocator: rotatedFile, firstReadableTransition: 'append' });
    const initial = rotated.advance({ captureMode: 'live' });
    rig.apply({
      transition: 'rotate', sessionId: ELSEWHERE, sourceLocator: rotatedFile, batches: initial.batches,
      sourceObserved: true, captureMode: 'live',
    });
    assert.equal(recordCount(store, ELSEWHERE), 0, 'a rotate frame keeps nothing, though it carries a call');
    appendFileSync(rotatedFile, transcriptBytes(rotatedLog.entries.slice(rotatedLog.cuts[0], rotatedLog.cuts[1])));
    rig.apply(rotated.advance({ captureMode: 'live' }));
    assert.equal(recordCount(store, ELSEWHERE), 1, 'the next live append keeps its call under the new session id');
    assert.equal(recordCount(store, SESSION), 1, 'and nothing more under the old one');
    assert.notEqual(store.recallAttribution(ELSEWHERE, ccToolUseIdOf(2)), null);
    assert.deepEqual(rig.diagnostics, []);
  });

  test('replay frames and a frame that names no capture mode write no record and still replay the records the session holds', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });
    const { batches } = reduceClaudeCodeSnapshot(readClaudeCodeRows(transcriptBytes(SESSION_LOG.entries), { atEof: true }).rows);
    const appendFrame = mode => ({ transition: 'append', batches, sourceObserved: true, ...mode });
    const frames = {
      'a replace frame': rig => rig.snapshot(SESSION_LOG.entries),
      'an append frame marked replay': rig => rig.apply(appendFrame({ captureMode: 'replay' })),
      'an append frame with no capture mode': rig => rig.apply(appendFrame({})),
    };

    for (const [name, replay] of Object.entries(frames)) {
      const emptied = watchedTreeOf({});
      const rig = watch({ store, workingTree: emptied.workingTree });
      replay(rig);
      assert.deepEqual(stateOf(rig.watcher), final, `${name} replays the records over a tree that holds nothing`);
      assert.deepEqual(emptied.calls, UNTOUCHED, name);
      assert.equal(recordCount(store, SESSION), 4, `${name} wrote nothing`);
      assert.deepEqual(rig.diagnostics, []);
    }

    for (const [name, replay] of Object.entries(frames)) {
      const rig = watch({ store, workingTree: treeOf().workingTree, sessionId: ELSEWHERE });
      replay(rig);
      assert.deepEqual(stateOf(rig.watcher), final, `${name} matches a session with no record against the tree`);
      assert.equal(recordCount(store, ELSEWHERE), 0, `${name} wrote nothing for it either`);
    }
  });

  test('a composition with no session id, the replay route\'s, neither reads nor writes a record and matches against the tree', () => {
    const store = newStore();
    const touched = [];
    for (const method of ['recallAttribution', 'rememberAttribution']) {
      const original = store[method].bind(store);
      store[method] = (...args) => {
        touched.push(method);
        return original(...args);
      };
    }
    const { final } = runLive({ store: newStore(), workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });

    const { rig, final: unnamed } = runLive({
      store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries, sessionId: null,
    });
    rig.snapshot(SESSION_LOG.entries);
    assert.deepEqual(touched, []);
    assert.deepEqual(rig.diagnostics, []);
    assert.deepEqual(unnamed, final);
    assert.deepEqual(stateOf(rig.watcher), final);
    assert.deepEqual(pathKeysOf(rig.watcher), [A, B], 'the calls are matched against the tree');
  });

  test('a result that reaches the Projection before its call is judged by the frame that completes it', () => {
    const observations = observationsOf(SESSION_LOG.entries.slice(0, SESSION_LOG.cuts[0]));
    const result = observations.find(observation => observation.type === 'tool-result');
    const call = observations.filter(observation => observation.type === 'tool-use' || observation.type === 'usage');
    const frame = (batch, captureMode) => ({
      transition: 'append', batches: [batch], sourceObserved: true, captureMode,
    });
    const cases = [
      ['the call arrives in a replay frame', 'live', 'replay', 0],
      ['the call arrives in a live frame', 'replay', 'live', 1],
    ];

    for (const [name, resultMode, callMode, written] of cases) {
      const store = newStore();
      const rig = watch({ store, workingTree: treeOf().workingTree });
      rig.apply(frame([result], resultMode));
      assert.equal(recordCount(store, SESSION), 0, `${name}: a held result completes nothing`);
      rig.apply(frame(call, callMode));
      assert.equal(recordCount(store, SESSION), written, name);
      assert.deepEqual(pathKeysOf(rig.watcher), [A], `${name}: the result is folded either way`);
    }
  });

  test('a recall that fails is a miss with a diagnostic and the call is still folded and kept', () => {
    const { final } = runLive({ store: newStore(), workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });
    const store = newStore();
    failing(store, 'recallAttribution');
    const { rig, final: failed } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });

    assert.deepEqual(failed, final);
    assert.deepEqual(rig.diagnostics.map(({ scope, code }) => [scope, code]),
      Array(4).fill(['session-watcher', 'attribution_recall_failed']));
    assert.equal(recordCount(store, SESSION), 4, 'a miss still lets the call be kept');
  });

  test('a remember that fails keeps nothing and is a diagnostic, and the call is still folded', () => {
    const { final } = runLive({ store: newStore(), workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });
    const store = newStore();
    failing(store, 'rememberAttribution');
    const { rig, final: failed } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });

    assert.deepEqual(failed, final);
    assert.deepEqual(rig.diagnostics.map(({ scope, code }) => [scope, code]),
      Array(4).fill(['session-watcher', 'attribution_remember_failed']));
    assert.equal(recordCount(store, SESSION), 0);
  });

  test('a Bash heredoc that writes a file and a later cat of it give the same keys, and count one edit and one read', () => {
    const heredoc = `cat > notes.txt <<'EOF'\n${linesText(NOTES_LINES)}EOF`;
    const log = ccCallLog([
      { name: 'Bash', input: { command: heredoc }, content: '' },
      { name: 'Bash', input: { command: 'cat notes.txt' }, content: linesText(NOTES_LINES) },
    ]);
    const store = newStore();
    const { rig } = runLive({ store, entries: log.entries, workingTree: treeOf({ [NOTES]: linesText(NOTES_LINES) }).workingTree });

    const keysOf = record => record.effects.map(effect => [effect.access, effect.impacts[0].resourceKey, effect.impacts[0].entries.map(entry => entry.key)]);
    assert.deepEqual(keysOf(store.recallAttribution(SESSION, ccToolUseIdOf(1))), [['write', NOTES, numbers(1, 8)]]);
    assert.deepEqual(keysOf(store.recallAttribution(SESSION, ccToolUseIdOf(2))), [['read', NOTES, numbers(1, 8)]]);

    const row = rowFor(rig.watcher, NOTES);
    const ctp = rig.watcher.getCurrentCtp();
    near(row.tokens, NOTES_LINES.reduce((sum, line) => sum + countsToTokens({ chars: line.length, cjk: 0 }, ctp), 0));
    assert.deepEqual([row.readCount, row.editCount, row.pureRereads], [1, 1, 0]);
    assert.deepEqual(pathKeysOf(rig.watcher), [NOTES], 'one resource, not one per tool');
  });
});

// ── Live against rebuilt ─────────────────────────────────────────────────────

describe('Source Reconstruction', () => {
  // The same rows with the model of every step named otherwise, as the host's model names do between a live run and
  // a later one.
  const underModel = (entries, model) => entries.map(entry => (entry.type !== 'assistant' ? entry : {
    ...entry, message: { ...entry.message, model },
  }));

  test('with records, a tree that is emptied or rewritten changes nothing, and nothing is read from it', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });

    const afters = {
      emptied: {},
      rewritten: { [A]: 'unrelated\n', [B]: 'other\n' },
    };
    for (const [name, files] of Object.entries(afters)) {
      const tree = watchedTreeOf(files);
      const rig = watch({ store, workingTree: tree.workingTree });
      rig.snapshot(SESSION_LOG.entries);
      assert.deepEqual(stateOf(rig.watcher), final, name);
      assert.deepEqual(pathKeysOf(rig.watcher), PATHS_AFTER_CALL.at(-1), name);
      assert.deepEqual(tree.calls, UNTOUCHED, name);
      assert.deepEqual(rig.diagnostics, [], name);
    }

    const bare = watch({ store, workingTree: watchedTreeOf({}).workingTree, sessionId: ELSEWHERE });
    bare.snapshot(SESSION_LOG.entries);
    assert.deepEqual(pathsOf(bare.watcher), [], 'the records are what carried the paths');
  });

  test('a Source cut back to an earlier prefix, rebuilt from the records, leaves the calls before the cut as the live run had them', () => {
    const store = newStore();
    const { states } = runLive({
      store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries, cuts: SESSION_LOG.cuts,
    });
    assert.ok(new Set(states.map(state => JSON.stringify(state))).size === states.length, 'each call moved the state');

    SESSION_LOG.cuts.forEach((cut, index) => {
      const tree = watchedTreeOf({});
      const rig = watch({ store, workingTree: tree.workingTree });
      rig.snapshot(SESSION_LOG.entries.slice(0, cut));
      assert.deepEqual(stateOf(rig.watcher), states[index], `after call ${index + 1}`);
      assert.deepEqual(pathKeysOf(rig.watcher), PATHS_AFTER_CALL[index], `after call ${index + 1}`);
      assert.deepEqual(tree.calls, UNTOUCHED, `after call ${index + 1}`);
    });
  });

  test('a rebuild prices the records under the model policy in force then, as matching afresh under it does', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });
    const renamed = underModel(SESSION_LOG.entries, 'model-x');

    const rebuilt = watch({ store, workingTree: watchedTreeOf({}).workingTree });
    rebuilt.snapshot(renamed);
    const afresh = watch({ store: newStore(), workingTree: treeOf().workingTree, sessionId: ELSEWHERE });
    afresh.snapshot(renamed);

    assert.deepEqual(pathKeysOf(rebuilt.watcher), PATHS_AFTER_CALL.at(-1));
    assert.deepEqual(stateOf(rebuilt.watcher), stateOf(afresh.watcher));
    assert.notDeepEqual(stateOf(rebuilt.watcher).buckets.paths, final.buckets.paths, 'the policy moved the prices');
  });

  test('without records, two rebuilds of one Source and one tree are the same, matched against the tree as it stands and kept nowhere', () => {
    const tree = treeOf();
    const firstStore = newStore();
    const first = watch({ store: firstStore, workingTree: tree.workingTree });
    first.snapshot(SESSION_LOG.entries);
    const secondStore = newStore();
    const second = watch({ store: secondStore, workingTree: tree.workingTree });
    second.snapshot(SESSION_LOG.entries);

    assert.deepEqual(stateOf(first.watcher), stateOf(second.watcher));
    assert.deepEqual(pathKeysOf(first.watcher), [A, B], 'the reconstruction attributes by match');

    tree.set({ [B]: TREE[B] });
    const laterStore = newStore();
    const later = watch({ store: laterStore, workingTree: tree.workingTree });
    later.snapshot(SESSION_LOG.entries);
    assert.deepEqual(pathKeysOf(later.watcher), [B], 'a call with no record meets the tree as it is now');

    for (const [rig, store] of [[first, firstStore], [second, secondStore], [later, laterStore]]) {
      assert.deepEqual(rig.diagnostics, []);
      assert.equal(recordCount(store, SESSION), 0);
    }
  });

  test('once a session\'s records are deleted with it, the Source replayed under its id is a session with none', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });
    store.deleteSession(SESSION);
    assert.equal(recordCount(store, SESSION), 0);

    const rig = watch({ store, workingTree: watchedTreeOf({}).workingTree });
    rig.snapshot(SESSION_LOG.entries);
    assert.deepEqual(pathsOf(rig.watcher), []);
    assert.notDeepEqual(stateOf(rig.watcher), final);
    assert.equal(recordCount(store, SESSION), 0, 'the replay kept nothing');
  });

  test('a session whose head was folded by a first read and whose tail ran live keeps records for the tail, and rebuilds without error', () => {
    const store = newStore();
    const split = SESSION_LOG.cuts[1];
    const rig = watch({ store, workingTree: treeOf().workingTree });
    rig.snapshot(SESSION_LOG.entries.slice(0, split));
    rig.feed(SESSION_LOG.entries.slice(split));
    const { final } = runLive({ store: newStore(), workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });

    assert.deepEqual(stateOf(rig.watcher), final);
    assert.deepEqual([1, 2, 3, 4, 5].map(step => store.recallAttribution(SESSION, ccToolUseIdOf(step)) !== null),
      [false, false, false, true, true], 'the head has none, and the skill has none');

    const rebuilt = watch({ store, workingTree: watchedTreeOf({}).workingTree });
    rebuilt.snapshot(SESSION_LOG.entries);
    assert.deepEqual(pathKeysOf(rebuilt.watcher), [B], 'the tail comes from its records, the head finds a tree that is gone');
    assert.deepEqual(rig.diagnostics, []);
    assert.deepEqual(rebuilt.diagnostics, []);
  });

  test('a tree that answers nothing leaves L and every step\'s usage unchanged and the path buckets empty', () => {
    const answering = runLive({ store: newStore(), workingTree: treeOf().workingTree, entries: SESSION_LOG.entries });
    const silent = runLive({ store: newStore(), workingTree: SILENT_TREE, entries: SESSION_LOG.entries });

    const usage = watcher => watcher.getHistory().map(({ L, cacheRead, cacheCreation, turnSeq, foldedSeq }) => ({
      L, cacheRead, cacheCreation, turnSeq, foldedSeq,
    }));
    assert.ok(usage(answering.rig.watcher).length > 0);
    assert.deepEqual(usage(silent.rig.watcher), usage(answering.rig.watcher));
    assert.equal(silent.rig.watcher.getStatus().L, answering.rig.watcher.getStatus().L);
    assert.deepEqual(pathsOf(silent.rig.watcher), []);
    assert.ok(pathsOf(answering.rig.watcher).length > 0, 'the same transcript fills them when the tree answers');
    assert.deepEqual(silent.rig.diagnostics, []);
  });
});

// ── Turn History ─────────────────────────────────────────────────────────────

describe('Turn History at capture', () => {
  const CAPTURED = ccCallLog([
    { name: 'Read', input: { file_path: 'src/a.js' }, content: ccReadResultText(A_LINES) },
    { name: 'Bash', input: { command: 'cat src/b.js' }, content: linesText(B_LINES) },
    { name: 'Skill', input: { skill: 'tdd' }, content: SKILL_LAUNCH, payload: SKILL_BODY },
  ], { asking: true });

  // What a producer does: fetch the skeleton, fill every slot it asks for, submit. The skeleton's aggregate row of
  // tools is read before the commit retires its file.
  async function capture(watcher) {
    const skeleton = await watcher.getTurnSkeleton();
    const row = readFileSync(skeleton.skeleton_path, 'utf8').match(/^ +\| A×\d+ · \d+ tools.*$/m)?.[0] ?? null;
    const slots = [...readFileSync(skeleton.notes_path, 'utf8').matchAll(/^## NOTE\[(\d+)\]$/gm)].map(match => match[1]);
    writeFileSync(skeleton.notes_path, slots.map(slot => `## NOTE[${slot}]\n\nbody ${slot}\n`).join('\n'));
    const committed = await watcher.submitTurnNotes({ snapshot_id: skeleton.snapshot_id });
    return { row, committed };
  }

  const searchTermsOf = (store, sessionId) => store.listTurnNotes(sessionId)
    .map(note => note.searchTerms.split(' ').filter(Boolean).sort());

  test('the skeleton and the committed search terms take their keys from the records, over a tree that holds nothing', async () => {
    const store = newStore();
    runLive({ store, workingTree: treeOf().workingTree, entries: CAPTURED.entries });
    assert.equal(recordCount(store, SESSION), 2, 'the read and the cat have a record, the skill none');

    const tree = watchedTreeOf({});
    const rig = watch({ store, workingTree: tree.workingTree });
    const { row, committed } = await capture(rig.watcher);

    assert.match(row, /· 3 tools: a\.js,b\.js,skill:tdd$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, SESSION), [[A, B, 'skill:tdd']]);
    assert.deepEqual(tree.calls, UNTOUCHED, 'a record answers without a read of the tree');
  });

  test('a skill key survives a session with no records, where a read and a cat have no key over a tree that holds nothing', async () => {
    const store = newStore();
    const tree = watchedTreeOf({});
    const rig = watch({ store, workingTree: tree.workingTree, sessionId: ELSEWHERE });
    writeFileSync(rig.file, transcriptBytes(CAPTURED.entries));
    const { row, committed } = await capture(rig.watcher);

    assert.match(row, /· 3 tools: skill:tdd$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, ELSEWHERE), [['skill:tdd']]);
    assert.ok(tree.calls.stat > 0, 'a miss asks the tree');
    assert.equal(recordCount(store, ELSEWHERE), 0, 'capture keeps nothing');
  });

  test('a recall that throws at capture is a miss: the skeleton and the commit go on with the keys the tree gives', async () => {
    const store = newStore();
    runLive({ store, workingTree: treeOf().workingTree, entries: CAPTURED.entries });
    failing(store, 'recallAttribution');

    const rig = watch({ store, workingTree: treeOf().workingTree });
    const { row, committed } = await capture(rig.watcher);

    assert.match(row, /· 3 tools: a\.js,b\.js,skill:tdd$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, SESSION), [[A, B, 'skill:tdd']]);
  });

  test('a relative-path read on a row with no cwd, folded by a replace rebuild so that it has no record, has the Engine resource and the committed search terms on one key', async () => {
    const lines = ['one', 'two', 'three', 'four', 'five'].map(name => `export const ${name} = 1;`);
    const log = ccCallLog([{ name: 'Read', input: { file_path: 'lib/a.js' }, content: ccReadResultText(lines) }], { asking: true });
    const cases = [
      ['a project root', '/repo', { '/repo/lib/a.js': linesText(lines) }, ['/repo/lib/a.js']],
      // The file is there only under the process's directory, which is no base: neither end finds it.
      ['no project root', null, { [`${process.cwd()}/lib/a.js`]: linesText(lines) }, []],
    ];

    for (const [name, projectRoot, files, expected] of cases) {
      const store = newStore();
      const rig = watch({ store, workingTree: treeOf(files).workingTree, projectRoot, sessionId: `s-${name}` });
      rig.snapshot(log.entries);
      assert.equal(recordCount(store, `s-${name}`), 0, `${name}: a replace frame keeps no record`);

      assert.deepEqual(pathKeysOf(rig.watcher), expected, `${name}: the Engine resource`);
      const { committed } = await capture(rig.watcher);
      assert.deepEqual(committed, { committed: true });
      assert.deepEqual(searchTermsOf(store, `s-${name}`), [expected], `${name}: the committed search terms`);
    }
  });
});

// ── Search and the Dialogue projection ───────────────────────────────────────

describe('search', () => {
  test('a turn search over the Dialogue projection finds the file reads and the residual evidence alike', async () => {
    const log = ccCallLog([
      { name: 'Read', input: { file_path: 'src/a.js' }, content: ccReadResultText(A_LINES) },
      { name: 'Bash', input: { command: 'ls src' }, content: 'a.js\nb.js\nlisting-only-literal\n' },
    ], { asking: true });
    const transcriptPath = join(dir, 'lineage-source.jsonl');
    writeFileSync(transcriptPath, transcriptBytes(log.entries));
    // One delivered handoff heading a one-session lineage: the reads the lineage walk makes, and nothing else.
    // It is prepared after the Source's last row, so its window holds every turn of the Source.
    const store = {
      findLatestDeliveryInSession: () => ({ handoffId: 7 }),
      getHandoff: id => (id === 7
        ? { handoffId: 7, projectId: 'p', sessionId: 's-src', transcriptPath, createdAt: Date.parse('2026-07-02T00:00:00Z') }
        : null),
      findParentDelivery: () => null,
      listTurnNotes: () => [],
    };
    const reads = createTurnReadService({
      store: () => store,
      sessionId: () => 's-dst',
      dialogueSource: createClaudeCodeDialogueSource(),
      dialogueProjection: createClaudeCodeDialogueProjection(),
      recovery: { notice: TURN_NOTICE, searchHit: SEARCH_HIT_RECOVERY, locateHit: LOCATE_HIT_RECOVERY },
    });

    assert.equal((await reads.turnSearch({ q: A_LINES[2] })).found, true, 'only a file read holds the literal');
    assert.equal((await reads.turnSearch({ q: 'listing-only-literal' })).found, true);
  });
});

// ── Attribution by text ──────────────────────────────────────────────────────

describe('attribution by text', () => {
  test('attributes a call by the lines it shows, whatever tool made it', () => {
    // A tool no table names, that answers with a file's text.
    const log = ccCallLog([{ name: 'mcp__acme__read_text_file', input: { path: 'src/b.js' }, content: linesText(B_LINES) }]);

    // The composition builds the matcher and the interpreter from the limits constant, which each throws on when a
    // member it reads has drifted from its name.
    const rig = watch({ store: newStore(), workingTree: treeOf().workingTree });
    rig.snapshot(log.entries);
    assert.deepEqual(pathKeysOf(rig.watcher), [B]);
  });

  test('charges a Skill call and its payload row to the Engine as a skill resource, and keeps no record', () => {
    const log = ccCallLog([{ name: 'Skill', input: { skill: 'tdd' }, content: SKILL_LAUNCH, payload: SKILL_BODY }]);
    const store = newStore();
    const { rig } = runLive({ store, workingTree: watchedTreeOf({}).workingTree, entries: log.entries });

    const [skill] = rig.watcher.getBucketData().skills;
    // The launch confirmation and the payload row are two reads of the one resource.
    assert.deepEqual(
      { name: skill.name, readCount: skill.readCount, editCount: skill.editCount, pureRereads: skill.pureRereads, touchSeqs: skill.touchSeqs },
      { name: 'tdd', readCount: 2, editCount: 0, pureRereads: 1, touchSeqs: [{ seq: 1, mode: 'r' }, { seq: 1, mode: 'r' }] },
    );
    near(skill.tokens, 75.10204081632654, 'the skill\'s tokens');
    near(skill.totalSpent, 75.10204081632654, 'the skill\'s spend');
    assert.deepEqual(pathKeysOf(rig.watcher), []);
    assert.equal(recordCount(store, SESSION), 0, 'a skill is not matched, so it keeps no record');
    assert.deepEqual(rig.diagnostics, []);
  });
});

// ── The working tree the composition builds ──────────────────────────────────

describe('the Node working tree of a composition that is handed none', () => {
  // Every other case of this file hands its composition a tree, so this is the first to need the process's, which
  // takes its home directory when it is first built.
  test('reads a path spelled ~ from the user\'s home directory, the Claude Code namespace', () => {
    const home = mkdtempSync(join(tmpdir(), 'sw-cc-home-'));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    try {
      writeFileSync(join(home, 'a.js'), linesText(A_LINES));
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      const log = ccCallLog([{ name: 'Bash', input: { command: 'cat ~/a.js' }, content: linesText(A_LINES) }]);
      const store = newStore();
      const { rig } = runLive({ store, workingTree: undefined, entries: log.entries });

      assert.deepEqual(pathKeysOf(rig.watcher), [`${home.replaceAll('\\', '/')}/a.js`]);
      assert.equal(recordCount(store, SESSION), 1);
      assert.deepEqual(rig.diagnostics, []);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
