// The DSH composition, end to end: the real SessionWatcher over the real store (in
// memory), the composition's own matcher and interpreter over an in-memory working tree, and the DSH log the host
// feeds. It covers which frames write an Attribution Record, what Source Reconstruction replays from the records
// and what it matches again without them, the path events an archived segment holds, and the keys Turn History
// takes at capture. Every path, line and event is authored.
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWatcher } from '../dsh/src/composition.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { reduceDshEvent, reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { openStore, closeStore } from '../lib/store.js';
import { countsToTokens } from '../lib/token-estimate.js';
import {
  CWD, SILENT_TREE, dshCallLog, editableTree, linesText, readResultText, toolUseIdOf, watchedTree,
} from './helpers/attribution-fixtures.js';

const SESSION = 's-attributed';
const ELSEWHERE = 's-elsewhere';
const UNTOUCHED = { resolve: 0, stat: 0, readText: 0 };

let dir;
const stores = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-attribution-'));
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
// `snapshot(events)` is a bootstrap, one replace frame, and `feed(events)` is live events after it. `readable` is
// the Source Turn History reads. A frame's diagnostics are kept: a store that failed a read or a write shows there.
function watch({ store, workingTree, sessionId = SESSION, readable = [] }) {
  const { watcher } = composeWatcher({
    sessionId, cwd: CWD, store, turnNotesRoot: join(dir, 'turn-notes'),
    readSession: async () => ({ events: readable }), isIgnored: null, cacheTtl: () => null,
    workingTree,
  });
  const diagnostics = [];
  let driver = null;
  const apply = (frame) => {
    if (frame !== null) diagnostics.push(...watcher.applyHarnessFrame(frame).diagnostics);
  };
  return {
    watcher,
    diagnostics,
    snapshot(events) {
      driver = createDshSourceDriver({ sessionId, onDiagnostics: reported => diagnostics.push(...reported) });
      apply(driver.install(events));
      for (const frame of driver.drain()) apply(frame);
    },
    feed(events) {
      for (const event of events) apply(driver.feed(event));
    },
    apply,
  };
}

// Everything a reader of the watcher can see of the Engine's belief, as the JSON it writes.
const stateOf = watcher => JSON.parse(JSON.stringify({ buckets: watcher.getBucketData(), history: watcher.getHistory() }));
const pathsOf = watcher => watcher.getBucketData().paths;
const pathKeysOf = watcher => pathsOf(watcher).map(row => row.path).sort();
const rowFor = (watcher, path) => pathsOf(watcher).find(row => row.path === path);

// The log fed live after an empty snapshot, with the state read after each `cuts` entry and at the end.
function runLive({ store, workingTree, events, cuts = [], sessionId }) {
  const rig = watch({ store, workingTree, sessionId, readable: events });
  rig.snapshot([]);
  const states = [];
  let from = 0;
  for (const cut of cuts) {
    rig.feed(events.slice(from, cut));
    from = cut;
    states.push(stateOf(rig.watcher));
  }
  rig.feed(events.slice(from));
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

const SKILL_TEXT = [
  '<skill_content name="tdd">', '<skill_instructions>', '# Test-Driven Development', 'Red, then green.',
  '</skill_instructions>', '</skill_content>',
].join('\n');
const MISSING_TEXT = 'Error: cannot read "src/missing.js": not found';

const TREE = { [A]: linesText(A_LINES), [B]: linesText(B_LINES) };

// A whole-file read, a call that matches nothing, a skill, a failed read, and a `cat` of a file no tool name says
// is read.
const SESSION_CALLS = [
  { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(A, A_LINES) },
  { name: 'bash', args: { command: 'git status --short' }, text: ' M src/a.js\n?? notes.txt\n' },
  { name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT },
  {
    name: 'read', args: { file_path: 'src/missing.js' }, text: MISSING_TEXT, isError: true,
    error: { name: 'FsError', code: 'FS_NOT_FOUND' },
  },
  { name: 'bash', args: { command: 'cat src/b.js' }, text: linesText(B_LINES) },
];
const SESSION_LOG = dshCallLog(SESSION_CALLS);
// The resources the Engine holds once each of those calls is folded in.
const PATHS_AFTER_CALL = [[A], [A], [A], [A], [A, B]];

// ── Which frames write a record ──────────────────────────────────────────────

describe('the Attribution Records a session keeps', () => {
  test('an append+live session event writes one record per attributed call under the current session id, holding no file text', () => {
    const store = newStore();
    const { rig } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });

    const records = SESSION_CALLS.map((_, index) => store.recallAttribution(SESSION, toolUseIdOf(index + 1)));
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
      JSON.stringify(SESSION_CALLS[1].args).length + SESSION_CALLS[1].text.length, 'a call that matches nothing is all residual');
    assert.deepEqual(records[3].effects, []);

    const stored = store._db.prepare('SELECT record FROM attribution_record WHERE session_id = ?').all(SESSION)
      .map(row => row.record).join('\n');
    for (const line of [...A_LINES, ...B_LINES]) assert.ok(!stored.includes(line), `the records hold no file text: ${line}`);

    assert.deepEqual(pathKeysOf(rig.watcher), [A, B]);
    assert.deepEqual(rig.diagnostics, []);
  });

  test('replace and replay frames, and a frame that names no capture mode, write no record and still replay the records the session holds', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });
    const { batches } = reduceDshSnapshot(SESSION_LOG.events);
    const appendFrame = mode => ({ transition: 'append', batches, sourceObserved: true, ...mode });
    const frames = {
      'a replace frame': rig => rig.snapshot(SESSION_LOG.events),
      'an append frame marked replay': rig => rig.apply(appendFrame({ captureMode: 'replay' })),
      'an append frame with no capture mode': rig => rig.apply(appendFrame({})),
    };

    for (const [name, replay] of Object.entries(frames)) {
      const emptied = watchedTree({});
      const rig = watch({ store, workingTree: emptied.workingTree });
      replay(rig);
      assert.deepEqual(stateOf(rig.watcher), final, `${name} replays the records over a tree that holds nothing`);
      assert.deepEqual(emptied.calls, UNTOUCHED, name);
      assert.equal(recordCount(store, SESSION), 4, `${name} wrote nothing`);
      assert.deepEqual(rig.diagnostics, []);
    }

    for (const [name, replay] of Object.entries(frames)) {
      const rig = watch({ store, workingTree: editableTree(TREE).workingTree, sessionId: ELSEWHERE });
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
    const { final } = runLive({ store: newStore(), workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });

    const { rig, final: unnamed } = runLive({
      store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events, sessionId: null,
    });
    rig.snapshot(SESSION_LOG.events);
    assert.deepEqual(touched, []);
    assert.deepEqual(rig.diagnostics, []);
    assert.deepEqual(unnamed, final);
    assert.deepEqual(stateOf(rig.watcher), final);
    assert.deepEqual(pathKeysOf(rig.watcher), [A, B], 'the calls are matched against the tree');
  });

  test('a result that reaches the Projection before its call is judged by the frame that completes it', () => {
    const [assistant] = SESSION_LOG.events.filter(event => event.type === 'assistant/message');
    const result = SESSION_LOG.events.find(event => event.type === 'tool/result');
    const frame = (observations, captureMode) => ({
      transition: 'append', batches: [observations], sourceObserved: true, captureMode,
    });
    const cases = [
      ['the call arrives in a replay frame', 'live', 'replay', 0],
      ['the call arrives in a live frame', 'replay', 'live', 1],
    ];

    for (const [name, resultMode, callMode, written] of cases) {
      const store = newStore();
      const rig = watch({ store, workingTree: editableTree(TREE).workingTree });
      rig.apply(frame(reduceDshEvent(result).observations, resultMode));
      assert.equal(recordCount(store, SESSION), 0, `${name}: a held result completes nothing`);
      rig.apply(frame(reduceDshEvent(assistant).observations, callMode));
      assert.equal(recordCount(store, SESSION), written, name);
      assert.deepEqual(pathKeysOf(rig.watcher), [A], `${name}: the result is folded either way`);
    }
  });

  test('a recall that fails is a miss with a diagnostic and the call is still folded and kept', () => {
    const { final } = runLive({ store: newStore(), workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });
    const store = newStore();
    failing(store, 'recallAttribution');
    const { rig, final: failed } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });

    assert.deepEqual(failed, final);
    assert.deepEqual(rig.diagnostics.map(({ scope, code }) => [scope, code]),
      Array(4).fill(['session-watcher', 'attribution_recall_failed']));
    assert.equal(recordCount(store, SESSION), 4, 'a miss still lets the call be kept');
  });

  test('a remember that fails keeps nothing and is a diagnostic, and the call is still folded', () => {
    const { final } = runLive({ store: newStore(), workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });
    const store = newStore();
    failing(store, 'rememberAttribution');
    const { rig, final: failed } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });

    assert.deepEqual(failed, final);
    assert.deepEqual(rig.diagnostics.map(({ scope, code }) => [scope, code]),
      Array(4).fill(['session-watcher', 'attribution_remember_failed']));
    assert.equal(recordCount(store, SESSION), 0);
  });

  test('a read whose tool-private meta disagrees with its text is attributed from the text', () => {
    const OTHER = '/repo/src/other.js';
    const OTHER_LINES = ['other one', 'other two', 'other three'];
    const store = newStore();
    const { events } = dshCallLog([{
      name: 'read',
      args: { file_path: 'src/a.js' },
      text: readResultText(A, A_LINES, { from: 5, to: 6 }),
      meta: {
        path: OTHER, offset: 1, totalLines: OTHER_LINES.length,
        lines: OTHER_LINES.map((text, index) => ({ number: index + 1, text })),
      },
    }]);
    const { rig } = runLive({
      store, events, workingTree: editableTree({ ...TREE, [OTHER]: linesText(OTHER_LINES) }).workingTree,
    });

    const record = store.recallAttribution(SESSION, toolUseIdOf(1));
    assert.deepEqual(record.effects.map(effect => effect.impacts.map(impact => [impact.resourceKey, impact.entries.map(entry => entry.key)])),
      [[[A, [5, 6]]]]);
    assert.deepEqual(pathKeysOf(rig.watcher), [A]);
    const ctp = rig.watcher.getCurrentCtp();
    near(rowFor(rig.watcher, A).tokens,
      countsToTokens({ chars: `5: ${A_LINES[4]}`.length, cjk: 0 }, ctp) + countsToTokens({ chars: `6: ${A_LINES[5]}`.length, cjk: 0 }, ctp));
  });

  test('a Write that carries content and a later Read of the same file give the same keys', () => {
    const C = '/repo/src/c.js';
    const C_LINES = ['one', 'two', 'three', 'four', 'five', 'six'].map((name, index) => `export const ${name} = ${index + 1};`);
    const store = newStore();
    const log = dshCallLog([
      { name: 'write', args: { file_path: 'src/c.js', content: linesText(C_LINES) }, text: 'Wrote 6 lines to src/c.js' },
      { name: 'read', args: { file_path: 'src/c.js', offset: 2, limit: 3 }, text: readResultText(C, C_LINES, { from: 2, to: 4 }) },
    ]);
    const { rig } = runLive({ store, events: log.events, workingTree: editableTree({ [C]: linesText(C_LINES) }).workingTree });

    const keysOf = record => record.effects.map(effect => [effect.access, effect.impacts[0].resourceKey, effect.impacts[0].entries.map(entry => entry.key)]);
    assert.deepEqual(keysOf(store.recallAttribution(SESSION, toolUseIdOf(1))), [['write', C, numbers(1, 6)]]);
    assert.deepEqual(keysOf(store.recallAttribution(SESSION, toolUseIdOf(2))), [['read', C, [2, 3, 4]]]);

    // The write is priced as the file's own lines and the read as the lines the model saw numbered; one fragment
    // per line of the file stays, so the keys of the two calls were one set.
    const ctp = rig.watcher.getCurrentCtp();
    const tokensOf = text => countsToTokens({ chars: text.length, cjk: 0 }, ctp);
    const afterRead = C_LINES.reduce((sum, line, index) => sum + tokensOf(index >= 1 && index <= 3 ? `${index + 1}: ${line}` : line), 0);
    const row = rowFor(rig.watcher, C);
    near(row.tokens, afterRead);
    assert.deepEqual([row.readCount, row.editCount, row.pureRereads], [1, 1, 0]);
    assert.deepEqual(pathKeysOf(rig.watcher), [C], 'one resource, not one per spelling');
  });
});

// ── Changing directory ───────────────────────────────────────────────────────

describe('a command that changes directory', () => {
  const GUIDE = '/repo/docs/guide.txt';
  const GUIDE_LINES = ['install the tool', 'run the first check', 'read the report'];
  const COPY = '/repo/guide.txt';
  const COPY_LINES = ['a different guide', 'with other words', 'and other lines'];

  test('a cat after a cd is recorded and replayed under the file the shell read, and one in a directory the command cannot name is attributed to nothing', () => {
    // The second call reads a temporary copy of the repository, whose guide has the session directory's lines.
    const calls = [
      { name: 'bash', args: { command: 'cd docs && cat guide.txt' }, text: linesText(GUIDE_LINES) },
      { name: 'bash', args: { command: 'cd $(mktemp -d) && cat guide.txt' }, text: linesText(COPY_LINES) },
    ];
    const log = dshCallLog(calls);
    const store = newStore();
    const { rig, final } = runLive({
      store, events: log.events,
      workingTree: editableTree({ [GUIDE]: linesText(GUIDE_LINES), [COPY]: linesText(COPY_LINES) }).workingTree,
    });

    assert.deepEqual(pathKeysOf(rig.watcher), [GUIDE]);
    const [read, copied] = calls.map((_, index) => store.recallAttribution(SESSION, toolUseIdOf(index + 1)));
    assert.deepEqual(read.effects.map(effect => effect.impacts.map(impact => [effect.access, impact.resourceKey])), [[['read', GUIDE]]]);
    assert.deepEqual(copied.effects, []);
    assert.equal(copied.residual.weight, JSON.stringify(calls[1].args).length + calls[1].text.length, 'the whole call is residual');

    const tree = watchedTree({});
    const rebuilt = watch({ store, workingTree: tree.workingTree });
    rebuilt.snapshot(log.events);
    assert.deepEqual(stateOf(rebuilt.watcher), final, 'the records carry the keys');
    assert.deepEqual(tree.calls, UNTOUCHED);
    assert.deepEqual(rig.diagnostics, []);
  });
});

// ── Path events ──────────────────────────────────────────────────────────────

describe('the path events of an archived segment', () => {
  test('a call that hit one file on both sides stores two rows in effect order, named for the tool and keyed alike', () => {
    const heredoc = `cat > notes.txt <<'EOF'\n${linesText(NOTES_LINES)}EOF\ncat notes.txt`;
    const log = dshCallLog([
      { name: 'bash', args: { command: heredoc }, text: linesText(NOTES_LINES) },
      { name: 'read', args: { file_path: 'src/a.js', offset: 2, limit: 3 }, text: readResultText(A, A_LINES, { from: 2, to: 4 }) },
      { name: 'bash', args: { command: "sed -n '2,6p' notes.txt" }, text: linesText(NOTES_LINES.slice(1, 6)) },
    ]);
    const store = newStore();
    const { rig } = runLive({
      store, events: log.events, workingTree: editableTree({ ...TREE, [NOTES]: linesText(NOTES_LINES) }).workingTree,
    });
    rig.watcher.closeCurrentSegment();

    const rows = store._db.prepare(`SELECT folded_seq, event_ordinal, path, raw_path, tool_type, is_full_read
      FROM profile_path_event WHERE session_id = ? ORDER BY folded_seq, event_ordinal`).all(SESSION);
    assert.deepEqual(rows.map(row => [row.path, row.tool_type, row.is_full_read]), [
      [NOTES, 'bash', null],
      [NOTES, 'bash', 1],
      [A, 'read', 0],
      [NOTES, 'bash', 0],
    ]);
    for (const row of rows) assert.equal(row.raw_path, row.path);
    assert.deepEqual(rig.diagnostics, []);
  });
});

// ── Live against rebuilt ─────────────────────────────────────────────────────

describe('a rebuild from the records', () => {
  // An edit that puts lines above the file's, a whole read of the shifted file and, once the rebuild is behind, an
  // edit that puts lines in its middle and a partial read: the records alone must carry the file's lines across.
  const HEADERS = ['one', 'two', 'three', 'four', 'five'].map(name => `// header ${name}`);
  const V1 = A_LINES;
  const V2 = [...HEADERS, ...V1];
  const INSERTED = ['one', 'two', 'three', 'four'].map(name => `const gamma${name} = 0;`);
  const V3 = [...V2.slice(0, 8), ...INSERTED, ...V2.slice(8)];
  const edit = (before, after) => ({
    name: 'edit',
    args: { file_path: 'src/a.js', old_string: before[0], new_string: after.join('\n') },
    text: 'The file src/a.js has been edited.',
  });
  const SHIFT = dshCallLog([
    { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(A, V1) },
    edit([V1[0]], [...HEADERS, V1[0]]),
    { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(A, V2) },
    edit([V2[7]], [V2[7], ...INSERTED, V2[8]]),
    { name: 'read', args: { file_path: 'src/a.js', offset: 3, limit: 5 }, text: readResultText(A, V3, { from: 3, to: 7 }) },
  ]);
  // The file on disk when each call's result is folded in.
  const DISK = [V1, V2, V2, V3, V3].map(lines => ({ [A]: linesText(lines) }));
  const REBUILT_AFTER = 3;

  const callEvents = index => SHIFT.events.slice(index === 0 ? 0 : SHIFT.cuts[index - 1], SHIFT.cuts[index]);
  const tail = SHIFT.events.slice(SHIFT.cuts.at(-1));

  function foldCalls(rig, tree, indexes) {
    for (const index of indexes) {
      tree.set(DISK[index]);
      rig.feed(callEvents(index));
    }
  }

  test('a whole read of a file an earlier edit shifted, then the same edit and a partial read, end where the uninterrupted run ends', () => {
    const uninterrupted = (() => {
      const tree = editableTree(DISK[0]);
      const rig = watch({ store: newStore(), workingTree: tree.workingTree });
      rig.snapshot([]);
      foldCalls(rig, tree, numbers(0, 4));
      rig.feed(tail);
      return rig;
    })();

    const store = newStore();
    const tree = editableTree(DISK[0]);
    const rig = watch({ store, workingTree: tree.workingTree });
    rig.snapshot([]);
    foldCalls(rig, tree, numbers(0, REBUILT_AFTER - 1));
    const before = stateOf(rig.watcher);
    tree.set({});
    rig.snapshot(SHIFT.events.slice(0, SHIFT.cuts[REBUILT_AFTER - 1]));
    assert.deepEqual(stateOf(rig.watcher), before, 'the rebuild itself replays the live state');
    foldCalls(rig, tree, numbers(REBUILT_AFTER, 4));
    rig.feed(tail);

    assert.deepEqual(stateOf(rig.watcher), stateOf(uninterrupted.watcher));
    assert.deepEqual(rig.diagnostics, []);

    // The scenario holds what it names: the edits shifted lines, and the records the rebuild leaned on carry the
    // fingerprints the later edit moved them by.
    const movedIn = step => store.recallAttribution(SESSION, toolUseIdOf(step))
      .effects.flatMap(effect => effect.impacts.flatMap(impact => impact.entries)).filter(entry => entry.moved === true).length;
    assert.ok(movedIn(2) > 0, 'the first edit moved lines');
    assert.ok(movedIn(4) > 0, 'the second edit moved lines');
    const whole = store.recallAttribution(SESSION, toolUseIdOf(3)).effects[0].impacts[0].entries;
    assert.equal(whole.length, V2.length);
    assert.ok(whole.every(entry => Number.isInteger(entry.fp)), 'the whole read of the shifted file recorded every fingerprint');
    const row = rowFor(rig.watcher, A);
    assert.deepEqual([row.readCount, row.editCount], [3, 2]);
  });
});

// ── Source Reconstruction ────────────────────────────────────────────────────

describe('Source Reconstruction', () => {
  // The same log with the model of every call named otherwise, as the host's model names do between a live run and
  // a later one.
  const underModel = (events, model) => events.map(event => (event.type !== 'assistant/message' ? event : {
    ...event,
    data: { ...event.data, message: { ...event.data.message, source: { ...event.data.message.source, model } } },
  }));

  test('with records, a tree that is emptied or rewritten changes nothing, and nothing is read from it', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });

    const afters = {
      emptied: {},
      rewritten: { [A]: 'unrelated\n', [B]: 'other\n' },
    };
    for (const [name, files] of Object.entries(afters)) {
      const tree = watchedTree(files);
      const rig = watch({ store, workingTree: tree.workingTree });
      rig.snapshot(SESSION_LOG.events);
      assert.deepEqual(stateOf(rig.watcher), final, name);
      assert.deepEqual(pathKeysOf(rig.watcher), PATHS_AFTER_CALL.at(-1), name);
      assert.deepEqual(tree.calls, UNTOUCHED, name);
      assert.deepEqual(rig.diagnostics, [], name);
    }

    const bare = watch({ store, workingTree: watchedTree({}).workingTree, sessionId: ELSEWHERE });
    bare.snapshot(SESSION_LOG.events);
    assert.deepEqual(pathsOf(bare.watcher), [], 'the records are what carried the paths');
  });

  test('a Source cut back to an earlier prefix, reconstructed from the records, leaves the calls before the cut as the live run had them', () => {
    const store = newStore();
    const { states } = runLive({
      store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events, cuts: SESSION_LOG.cuts,
    });
    assert.ok(new Set(states.map(state => JSON.stringify(state))).size > 1, 'each call moved the state');

    SESSION_LOG.cuts.forEach((cut, index) => {
      const tree = watchedTree({});
      const rig = watch({ store, workingTree: tree.workingTree });
      rig.snapshot(SESSION_LOG.events.slice(0, cut));
      assert.deepEqual(stateOf(rig.watcher), states[index], `after call ${index + 1}`);
      assert.deepEqual(pathKeysOf(rig.watcher), PATHS_AFTER_CALL[index], `after call ${index + 1}`);
      assert.deepEqual(tree.calls, UNTOUCHED, `after call ${index + 1}`);
    });
  });

  test('a rebuild prices the records under the model policy in force then, as matching afresh under it does', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });
    const renamed = underModel(SESSION_LOG.events, 'claude-opus-5-5');

    const rebuilt = watch({ store, workingTree: watchedTree({}).workingTree });
    rebuilt.snapshot(renamed);
    const afresh = watch({ store: newStore(), workingTree: editableTree(TREE).workingTree, sessionId: ELSEWHERE });
    afresh.snapshot(renamed);

    assert.deepEqual(pathKeysOf(rebuilt.watcher), PATHS_AFTER_CALL.at(-1));
    assert.deepEqual(stateOf(rebuilt.watcher), stateOf(afresh.watcher));
    assert.notDeepEqual(stateOf(rebuilt.watcher).buckets.paths, final.buckets.paths, 'the policy moved the prices');
  });

  test('without records, two reconstructions of one Source and one tree are the same, matched against the tree as it stands and kept nowhere', () => {
    const tree = editableTree(TREE);
    const firstStore = newStore();
    const first = watch({ store: firstStore, workingTree: tree.workingTree });
    first.snapshot(SESSION_LOG.events);
    const secondStore = newStore();
    const second = watch({ store: secondStore, workingTree: tree.workingTree });
    second.snapshot(SESSION_LOG.events);

    assert.deepEqual(stateOf(first.watcher), stateOf(second.watcher));
    assert.deepEqual(pathKeysOf(first.watcher), [A, B], 'the reconstruction attributes by match');

    tree.set({ [B]: TREE[B] });
    const laterStore = newStore();
    const later = watch({ store: laterStore, workingTree: tree.workingTree });
    later.snapshot(SESSION_LOG.events);
    assert.deepEqual(pathKeysOf(later.watcher), [B], 'a call with no record meets the tree as it is now');

    for (const [rig, store] of [[first, firstStore], [second, secondStore], [later, laterStore]]) {
      assert.deepEqual(rig.diagnostics, []);
      assert.equal(recordCount(store, SESSION), 0);
    }
  });

  test('once a session\'s records are deleted with it, the Source replayed under its id is a session with none', () => {
    const store = newStore();
    const { final } = runLive({ store, workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });
    store.deleteSession(SESSION);
    assert.equal(recordCount(store, SESSION), 0);

    const rig = watch({ store, workingTree: watchedTree({}).workingTree });
    rig.snapshot(SESSION_LOG.events);
    assert.deepEqual(pathsOf(rig.watcher), []);
    assert.notDeepEqual(stateOf(rig.watcher), final);
    assert.equal(recordCount(store, SESSION), 0, 'the replay kept nothing');
  });

  test('a session whose head was folded by a bootstrap snapshot and whose tail ran live keeps records for the tail, and rebuilds without error', () => {
    const store = newStore();
    const split = SESSION_LOG.cuts[1];
    const rig = watch({ store, workingTree: editableTree(TREE).workingTree, readable: SESSION_LOG.events });
    rig.snapshot(SESSION_LOG.events.slice(0, split));
    rig.feed(SESSION_LOG.events.slice(split));
    const { final } = runLive({ store: newStore(), workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });

    assert.deepEqual(stateOf(rig.watcher), final);
    assert.deepEqual([1, 2, 3, 4, 5].map(step => store.recallAttribution(SESSION, toolUseIdOf(step)) !== null),
      [false, false, false, true, true], 'the head has none, and the skill has none');

    const rebuilt = watch({ store, workingTree: watchedTree({}).workingTree });
    rebuilt.snapshot(SESSION_LOG.events);
    assert.deepEqual(pathKeysOf(rebuilt.watcher), [B], 'the tail comes from its records, the head finds a tree that is gone');
    assert.deepEqual(rig.diagnostics, []);
    assert.deepEqual(rebuilt.diagnostics, []);
  });

  test('a tree that answers nothing leaves L and every step\'s usage unchanged and the path buckets empty', () => {
    const answering = runLive({ store: newStore(), workingTree: editableTree(TREE).workingTree, events: SESSION_LOG.events });
    const silent = runLive({ store: newStore(), workingTree: SILENT_TREE, events: SESSION_LOG.events });

    const usage = watcher => watcher.getHistory().map(({ L, cacheRead, cacheCreation, turnSeq, foldedSeq }) => ({
      L, cacheRead, cacheCreation, turnSeq, foldedSeq,
    }));
    assert.ok(usage(answering.rig.watcher).length > 0);
    assert.deepEqual(usage(silent.rig.watcher), usage(answering.rig.watcher));
    assert.equal(silent.rig.watcher.getStatus().L, answering.rig.watcher.getStatus().L);
    assert.deepEqual(pathsOf(silent.rig.watcher), []);
    assert.ok(pathsOf(answering.rig.watcher).length > 0, 'the same log fills them when the tree answers');
    assert.deepEqual(silent.rig.diagnostics, []);
  });
});

// ── Turn History ─────────────────────────────────────────────────────────────

describe('Turn History at capture', () => {
  const CAPTURED = dshCallLog([
    { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(A, A_LINES) },
    { name: 'bash', args: { command: 'cat src/b.js' }, text: linesText(B_LINES) },
    { name: 'skill', args: { name: 'tdd' }, text: SKILL_TEXT },
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

  const searchTermsOf = (store, sessionId) => store.listTurnNotes(sessionId).map(note => note.searchTerms.split(' ').sort());

  test('the skeleton and the committed search terms take their keys from the records, over a tree that holds nothing', async () => {
    const store = newStore();
    runLive({ store, workingTree: editableTree(TREE).workingTree, events: CAPTURED.events });
    assert.equal(recordCount(store, SESSION), 2, 'the read and the cat have a record, the skill none');

    const tree = watchedTree({});
    const rig = watch({ store, workingTree: tree.workingTree, readable: CAPTURED.events });
    const { row, committed } = await capture(rig.watcher);

    assert.match(row, /· 3 tools: a\.js,b\.js,skill:tdd$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, SESSION), [[A, B, 'skill:tdd']]);
    assert.deepEqual(tree.calls, UNTOUCHED, 'a record answers without a read of the tree');
  });

  test('a skill key survives a session with no records, where a read and a cat have no key over a tree that holds nothing', async () => {
    const store = newStore();
    const tree = watchedTree({});
    const rig = watch({ store, workingTree: tree.workingTree, sessionId: ELSEWHERE, readable: CAPTURED.events });
    const { row, committed } = await capture(rig.watcher);

    assert.match(row, /· 3 tools: skill:tdd$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, ELSEWHERE), [['skill:tdd']]);
    assert.ok(tree.calls.stat > 0, 'a miss asks the tree');
    assert.equal(recordCount(store, ELSEWHERE), 0, 'capture keeps nothing');
  });

  test('a recall that throws at capture is a miss: the skeleton and the commit go on with the keys the tree gives', async () => {
    const store = newStore();
    runLive({ store, workingTree: editableTree(TREE).workingTree, events: CAPTURED.events });
    failing(store, 'recallAttribution');

    const rig = watch({ store, workingTree: editableTree(TREE).workingTree, readable: CAPTURED.events });
    const { row, committed } = await capture(rig.watcher);

    assert.match(row, /· 3 tools: a\.js,b\.js,skill:tdd$/);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, SESSION), [[A, B, 'skill:tdd']]);
  });

  test('a relative-path read folded by a replace frame, with no record, has the Engine resource and the committed search terms on one key', async () => {
    const store = newStore();
    const rig = watch({ store, workingTree: editableTree(TREE).workingTree, readable: CAPTURED.events });
    rig.snapshot(CAPTURED.events);
    assert.equal(recordCount(store, SESSION), 0, 'a replace frame keeps no record');

    const buckets = rig.watcher.getBucketData();
    const engineKeys = [...buckets.paths.map(row => row.path), ...buckets.skills.map(skill => `skill:${skill.name}`)];
    assert.deepEqual(engineKeys.sort(), [A, B, 'skill:tdd']);

    const { committed } = await capture(rig.watcher);
    assert.deepEqual(committed, { committed: true });
    assert.deepEqual(searchTermsOf(store, SESSION), [engineKeys]);
  });
});
