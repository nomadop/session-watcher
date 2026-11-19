// An inner seal rebuilt within its Context Epoch, end to end: the DSH composition's SessionWatcher over a real Store in
// a temporary directory, the DSH source driver, and authored logs whose inner-seal carriers withdraw the source they
// replace. The rewind is the driver's replay replace over the folded batches; the same log installed cold, and the same
// log with its carriers taken out, are what it is held against.
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWatcher } from '../dsh/src/composition.js';
import { createWatcherTable } from '../dsh/src/watcher-table.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { closeStore, closeStoreGlobal, getStore, initStore, openStore } from '../lib/store.js';
import { getLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import {
  assistantMessage, compactCheckpoint, innerSealCarrier, loadMessage, sessionLog, stepEnd, stepStart, toolResult, turnEnd,
  turnStart, userMessage,
} from './helpers/dsh-events.js';
import { CWD, editableTree, linesText, readResultText, watchedTree } from './helpers/attribution-fixtures.js';

const SESSION = 's-sealed';
const UNTOUCHED = { resolve: 0, stat: 0, readText: 0 };

let dir;
const stores = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-inner-seal-'));
});

afterEach(() => {
  for (const store of stores.splice(0)) closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

function newStore() {
  const store = openStore(join(dir, `store-${stores.length}.sqlite`));
  stores.push(store);
  return store;
}

// ── The files ────────────────────────────────────────────────────────────────

const A = '/repo/src/a.js';
const B = '/repo/src/b.js';
const C = '/repo/src/c.js';
const D = '/repo/src/d.js';
const NOTES = '/repo/notes.txt';
const KEPT = '/repo/src/kept.js';

const V1 = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'].map((name, index) => `const ${name} = ${index + 1};`);
const HEADERS = ['one', 'two', 'three', 'four', 'five'].map(name => `// header ${name}`);
const V2 = [...HEADERS, ...V1];
const B_LINES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'].map(name => `export const bravo${name} = 1;`);
const C_LINES = ['north', 'south', 'east', 'west'].map(name => `export const ${name}Wind = true;`);
const D_LINES = ['spring', 'summer', 'autumn', 'winter'].map(name => `export const ${name}Season = 0;`);
const NOTES_LINES = ['first note', 'second note', 'third note', 'fourth note', 'fifth note', 'sixth note'];

// The file a handoff keeps a window of: long enough that the window and the whole file price far apart.
const KEPT_LINES = Array.from({ length: 400 }, (_, index) => `export const kept${index + 1} = '${'k'.repeat(60)}';`);
const LOAD_WINDOW = { from: 11, to: 210 };

const STATIC = {
  [B]: linesText(B_LINES), [C]: linesText(C_LINES), [D]: linesText(D_LINES), [NOTES]: linesText(NOTES_LINES), [KEPT]: linesText(KEPT_LINES),
};
const ON_V1 = { ...STATIC, [A]: linesText(V1) };
const ON_V2 = { ...STATIC, [A]: linesText(V2) };

// ── The calls ────────────────────────────────────────────────────────────────

// The spec's original-record fixtures: a relocation (a read, an edit that shifts the file, a whole read of the
// shifted file), a partial then a full read, a call holding several resources, and a call whose input and output name
// one path; then a call that matches nothing, a partial read after the first seal, and a read after the second. `disk`
// is the tree each call is folded against.
const CALLS = [
  { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(A, V1), disk: ON_V1 },
  {
    name: 'edit', args: { file_path: 'src/a.js', old_string: V1[0], new_string: [...HEADERS, V1[0]].join('\n') },
    text: 'The file src/a.js has been edited.', disk: ON_V2,
  },
  { name: 'read', args: { file_path: 'src/a.js' }, text: readResultText(A, V2), disk: ON_V2 },
  { name: 'read', args: { file_path: 'src/b.js', offset: 2, limit: 2 }, text: readResultText(B, B_LINES, { from: 2, to: 3 }), disk: ON_V2 },
  { name: 'read', args: { file_path: 'src/b.js' }, text: readResultText(B, B_LINES), disk: ON_V2 },
  { name: 'bash', args: { command: 'cat src/c.js src/d.js' }, text: linesText([...C_LINES, ...D_LINES]), disk: ON_V2 },
  {
    name: 'bash', args: { command: `cat > notes.txt <<'EOF'\n${linesText(NOTES_LINES)}EOF\ncat notes.txt` },
    text: linesText(NOTES_LINES), disk: ON_V2,
  },
  { name: 'bash', args: { command: 'git status --short' }, text: ' M src/a.js\n?? notes.txt\n', disk: ON_V2 },
  { name: 'read', args: { file_path: 'src/a.js', offset: 6, limit: 3 }, text: readResultText(A, V2, { from: 6, to: 8 }), disk: ON_V2 },
  { name: 'read', args: { file_path: 'src/c.js' }, text: readResultText(C, C_LINES), disk: ON_V2 },
];

const STOCK_BASE = 50_000;
const STOCK_GROWTH = 2_000;

function usageOf(step) {
  const usage = step === 1
    ? { inputTokens: 3, outputTokens: 40, cacheWriteTokens: STOCK_BASE }
    : { inputTokens: 2, outputTokens: 40, cacheReadTokens: STOCK_BASE + (step - 2) * STOCK_GROWTH, cacheWriteTokens: STOCK_GROWTH };
  return { ...usage, totalTokens: Object.values(usage).reduce((sum, count) => sum + count, 0) };
}

/**
 * A log of `plan`, read in order: a number is the call of that index in `calls`, made in its own step; `{ seal }` a
 * carrier withdrawing the events of the calls it lists, `question` among them standing for the opening message, and
 * `carriers` for the seals made before it; `'checkpoint'` a compaction of everything before it. The log opens with a
 * question and closes with a text-only step.
 * `modelOf(step)` names the model of that step's message, the default model when it answers undefined, and `usageFor(step)` is the usage it reports.
 * @returns {{ events: object[], disks: object[] }} `disks[i]` the tree as event `i` is fed
 */
function logOf(plan, { calls = CALLS, withCarriers = true, modelOf = () => undefined, load = null, usageFor = usageOf } = {}) {
  const events = [turnStart()];
  const disks = [ON_V1];
  const push = (disk, ...pushed) => { for (const event of pushed) { events.push(event); disks.push(disk); } };
  // A session that starts with `/sw-load`: the window of a kept file reaches the model ahead of the question.
  if (load !== null) {
    push(ON_V1, loadMessage({ calls: [{ id: 'sw-load-0000aaaa-2', name: 'read', arguments: JSON.stringify({ file_path: KEPT, offset: load.from, limit: load.to - load.from + 1 }), text: readResultText(KEPT, KEPT_LINES, load) }] }));
  }
  const question = userMessage({ text: 'Work on the module.' });
  push(ON_V1, question);
  const eventsOfCall = new Map();
  const carriers = [];
  let step = 0;
  for (const part of plan) {
    if (part === 'checkpoint') {
      push(disks.at(-1), compactCheckpoint({ startSeq: events[0].seq, endSeq: events.at(-1).seq }));
    } else if (part.input !== undefined) {
      push(disks.at(-1), userMessage({ text: 'a reading', kind: part.input }));
    } else if (typeof part === 'number') {
      step += 1;
      const { name, args, text, disk } = calls[part];
      const id = `call_${step}`;
      const own = [
        stepStart({ step }),
        assistantMessage({ step, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: usageFor(step), model: modelOf(step) }),
        toolResult({ step, callId: id, text }),
        stepEnd({ step }),
      ];
      eventsOfCall.set(part, own);
      push(disk, ...own);
    } else {
      const seqs = part.seal.flatMap((member) => {
        if (member === 'question') return [question.seq];
        if (member === 'carriers') return carriers.map(carrier => carrier.seq);
        return eventsOfCall.get(member).map(event => event.seq);
      });
      const carrier = innerSealCarrier({ sourceEventSeqs: seqs });
      carriers.push(carrier);
      if (withCarriers) push(disks.at(-1), carrier);
    }
  }
  step += 1;
  push(disks.at(-1), stepStart({ step }), assistantMessage({ step, text: 'That is done.', usage: usageFor(step), model: modelOf(step) }),
    stepEnd({ step }), turnEnd());
  return { events: sessionLog(events), disks };
}

const SEALED = [0, 1, 2, 3, 4, 5, 6, { seal: ['question', 0, 1, 2, 3, 4] }, 7, 8, { seal: ['carriers', 5, 6, 7] }, 9];

const isCarrier = event => event.data?.source?.kind === 'session-watcher-inner-seal';
// The stock of step `step` of the log, which the history reports as the point's `L`.
const stockOfStep = (step) => { const { inputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = usageOf(step); return inputTokens + cacheReadTokens + cacheWriteTokens; };

// ── The rig ──────────────────────────────────────────────────────────────────

// A watcher over `store` and `workingTree`, fed as the host feeds it: `snapshot(events)` a bootstrap, and
// `feed(events)` live events after it, each frame and its capture mode kept.
function watch({ store, workingTree, sessionId = SESSION }) {
  const { watcher } = composeWatcher({
    sessionId, cwd: CWD, store, turnNotesRoot: join(dir, 'turn-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree,
  });
  const diagnostics = [];
  const frames = [];
  let driver = null;
  const apply = (frame) => {
    if (frame === null) return;
    frames.push(frame);
    diagnostics.push(...watcher.applyHarnessFrame(frame).diagnostics);
  };
  return {
    watcher, diagnostics, frames,
    snapshot(events) {
      driver = createDshSourceDriver({ sessionId, onDiagnostics: reported => diagnostics.push(...reported) });
      apply(driver.install(events));
      for (const frame of driver.drain()) apply(frame);
    },
    feed(event) { apply(driver.feed(event)); },
  };
}

// The log fed live after an empty snapshot, the tree set to each event's disk before the event.
function runLive({ store = newStore(), log, sessionId }) {
  const tree = editableTree(log.disks[0]);
  const rig = watch({ store, workingTree: tree.workingTree, sessionId });
  rig.snapshot([]);
  log.events.forEach((event, index) => {
    tree.set(log.disks[index]);
    rig.feed(event);
  });
  return { rig, store };
}

const withoutUptime = ({ uptime: _ignored, ...status }) => status;
// What a reader of the watcher sees, and the Engine's own rows with the fragment lines they hold.
const stateOf = watcher => JSON.parse(JSON.stringify({
  status: withoutUptime(watcher.getStatus()),
  history: watcher.getHistory(),
  buckets: watcher.getBucketData(),
  engineRows: watcher._engine.getBucketData().paths,
}));

// What an off-mode run must equal: per resource, its lines, its tokens and its counts.
const resourcesOf = watcher => watcher._engine.getBucketData().paths
  .map(({ path, tokens, lineNumbers, readCount, editCount, pureRereads }) => ({ path, tokens, lineNumbers, readCount, editCount, pureRereads }))
  .sort((a, b) => a.path.localeCompare(b.path));

const recordCount = (store, sessionId = SESSION) => store._db
  .prepare('SELECT COUNT(*) AS n FROM attribution_record WHERE session_id = ?').get(sessionId).n;

// The tool-use id of the call made in step `step`.
const toolUseIdOf = step => `1:${step}:call_${step}`;

// ── Live against cold ────────────────────────────────────────────────────────

describe('an inner seal rebuilds the measurement within its epoch', () => {
  test('each live carrier is one replay replace, the rewind writes no record, and later calls append live and keep theirs', () => {
    const log = logOf(SEALED);
    const tree = editableTree(log.disks[0]);
    const store = newStore();
    const rig = watch({ store, workingTree: tree.workingTree });
    rig.snapshot([]);
    const recordsAt = [];
    log.events.forEach((event, index) => {
      tree.set(log.disks[index]);
      const before = recordCount(store);
      rig.feed(event);
      if (event.data?.source?.kind === 'session-watcher-inner-seal') recordsAt.push([before, recordCount(store)]);
    });

    const modes = rig.frames.slice(1).map(frame => `${frame.transition}/${frame.captureMode}`);
    assert.deepEqual(modes.filter(mode => mode === 'replace/replay').length, 2, 'one rebuild per carrier');
    assert.ok(modes.every(mode => mode === 'replace/replay' || mode === 'append/live'), modes.join(' '));
    assert.deepEqual(recordsAt, [[7, 7], [9, 9]], 'a rebuild keeps no record of its own');
    assert.equal(recordCount(store), CALLS.length, 'every call made live keeps its record');
    assert.equal(rig.watcher.getStatus().segment, 0, 'no seal opens a Context Epoch');
    assert.deepEqual(rig.diagnostics, []);
  });

  test('the live feed of a log with several seals ends where a cold install of the same log stands', () => {
    const log = logOf(SEALED);
    const { rig, store } = runLive({ log });
    const tree = watchedTree({});
    const cold = watch({ store, workingTree: tree.workingTree });
    cold.snapshot(log.events);

    assert.deepEqual(stateOf(cold.watcher), stateOf(rig.watcher));
    assert.deepEqual(tree.calls, UNTOUCHED, 'the cold install replays the records');
    assert.deepEqual(cold.diagnostics, []);
  });

  test('against the same log without its carriers, every resource holds the same lines, tokens and counts', () => {
    const sealed = runLive({ log: logOf(SEALED) });
    const off = runLive({ log: logOf(SEALED, { withCarriers: false }) });

    assert.deepEqual(resourcesOf(sealed.rig.watcher), resourcesOf(off.rig.watcher));
    assert.deepEqual(resourcesOf(sealed.rig.watcher).map(row => row.path), [NOTES, A, B, C, D].sort());

    // The withdrawn calls are what they are named for: the edit moved lines, one cat held two files, and the heredoc
    // wrote and read one path.
    const impactsOf = step => sealed.store.recallAttribution(SESSION, toolUseIdOf(step)).effects
      .flatMap(effect => effect.impacts.map(impact => [effect.access, impact.resourceKey, impact.entries.some(entry => entry.moved === true)]));
    assert.ok(impactsOf(2).some(([, path, moved]) => path === A && moved), 'the edit relocated lines of a.js');
    assert.deepEqual(impactsOf(6).map(([access, path]) => [access, path]), [['read', C], ['read', D]]);
    assert.deepEqual(impactsOf(7).map(([access, path]) => [access, path]), [['write', NOTES], ['read', NOTES]]);
    // The calls made after a seal were partitioned against the scratch the rebuild left, so their residual weights
    // are those of the run that never sealed.
    for (const step of [8, 9, 10]) {
      assert.deepEqual(sealed.store.recallAttribution(SESSION, toolUseIdOf(step)),
        off.store.recallAttribution(SESSION, toolUseIdOf(step)), `call ${step}`);
    }
  });

  test('a withdrawn call leaves its residual, its usage and its turn behind', () => {
    // The withdrawn call follows the epoch's first measured step, so its residual would land on the anchored epoch.
    const plan = [0, 7, 3, { seal: [7] }, 4];
    const { rig: { watcher: sealed } } = runLive({ log: logOf(plan) });
    const off = runLive({ log: logOf(plan, { withCarriers: false }) }).rig.watcher;
    const names = watcher => Object.values(watcher.getBucketData().residual).flat().map(group => group.name).sort();

    assert.deepEqual(names(sealed), ['read']);
    assert.deepEqual(names(off), ['git status', 'read'], 'control: the run that never sealed carries its residual');
    assert.equal(sealed.getHistory().length, 4, 'the withdrawn call\'s step is gone');
    assert.equal(off.getHistory().length, 5);
  });

  test('a seal right behind the epoch\'s first call leaves that call the only point, which prices no interval until a call is measured behind the carrier', () => {
    const log = logOf([0, 1, { seal: ['question', 0, 1] }]);
    const events = log.events.slice(0, log.events.findIndex(isCarrier) + 1);
    const { rig } = runLive({ log: { events, disks: log.disks } });

    assert.deepEqual(rig.watcher.getHistory().map(point => point.L), [stockOfStep(1)]);
    assert.equal(rig.watcher.getStatus().rateLamp.br, null, 'one point has no interval to price');
    assert.deepEqual(rig.diagnostics, []);
  });

  test('a closed live archive is left as it was when a later epoch seals', () => {
    const log = logOf([0, 1, 'checkpoint', 2, 3, { seal: [2, 3] }, 4]);
    const seal = log.events.findIndex(event => event.data?.source?.kind === 'session-watcher-inner-seal');
    const tree = editableTree(log.disks[0]);
    const store = newStore();
    const rig = watch({ store, workingTree: tree.workingTree });
    rig.snapshot([]);
    const feedUpTo = end => {
      for (let index = rig.fed ?? 0; index < end; index += 1) {
        tree.set(log.disks[index]);
        rig.feed(log.events[index]);
      }
      rig.fed = end;
    };
    feedUpTo(seal);
    const archived = store.getProfileSegments(SESSION);
    assert.deepEqual(archived.map(profile => [profile.segment, profile.archiveSource]), [[0, 'live']]);

    feedUpTo(log.events.length);
    assert.equal(rig.frames.at(-1).transition, 'append');
    assert.deepEqual(store.getProfileSegments(SESSION), archived);
    assert.equal(rig.watcher.getStatus().segment, 1);
  });

  test('a user\'s overrides in the sealed epoch stay in force across the rebuild', () => {
    const log = logOf([0, 3, { seal: ['question', 0] }, 4]);
    const seal = log.events.findIndex(event => event.data?.source?.kind === 'session-watcher-inner-seal');
    const tree = editableTree(log.disks[0]);
    const rig = watch({ store: newStore(), workingTree: tree.workingTree });
    rig.snapshot([]);
    log.events.forEach((event, index) => {
      tree.set(log.disks[index]);
      if (index === seal) rig.watcher.replaceUserOverrides({ [B]: 'exclude' });
      rig.feed(event);
    });
    assert.equal(rig.frames.filter(frame => frame.transition === 'replace').length, 2);
    assert.equal(rig.watcher.getBucketData().paths.find(row => row.path === B).userOverride, 'exclude');
  });
});

// ── The epoch's head against a rebuild ───────────────────────────────────────

// The first call of the log takes the whole stock as input plus cacheWrite and has made no resource resident yet, so the
// dead the epoch is anchored on is that stock whole.
const FIRST_STOCK = 3 + STOCK_BASE;
const FLASH = 'deepseek-v4-flash';   // priced above the default model, by the same ratio table the watcher reads

// The token total the default selection carries beyond the dead.
const selectedTokens = ({ paths, skills }) => [...paths, ...skills]
  .filter(row => row.defaultSelected).reduce((sum, row) => sum + row.tokens, 0);

describe('a seal leaves the epoch head the calls that stay are measured against', () => {
  test('the first call stays through a seal that lists it, so its dead stands against the calls after it', () => {
    const plan = [0, 1, 2, { seal: ['question', 0, 1] }, 3];
    const { rig } = runLive({ log: logOf(plan) });
    const { watcher } = rig;

    // The second step is gone; the first stays beside the steps the seal did not list.
    assert.deepEqual(watcher.getHistory().map(point => point.L), [1, 3, 4, 5].map(stockOfStep));
    assert.equal(watcher.getBucketData().dead, FIRST_STOCK);
    assert.deepEqual(rig.diagnostics, []);
  });

  test('every rebuild of a log with several seals keeps it, and the default baseline, a preview and a handoff read it', () => {
    const log = logOf(SEALED);
    const tree = editableTree(log.disks[0]);
    const store = newStore();
    const rig = watch({ store, workingTree: tree.workingTree });
    rig.snapshot([]);
    const deadAfterCarriers = [];
    log.events.forEach((event, index) => {
      tree.set(log.disks[index]);
      rig.feed(event);
      if (isCarrier(event)) deadAfterCarriers.push(rig.watcher.getBucketData().dead);
    });
    const { watcher } = rig;
    assert.deepEqual(deadAfterCarriers, [FIRST_STOCK, FIRST_STOCK], 'each carrier\'s rebuild');

    const bucket = watcher.getBucketData();
    assert.equal(bucket.dead, FIRST_STOCK);
    assert.ok(Math.abs(bucket.bDefault - (FIRST_STOCK + selectedTokens(bucket))) < 1e-6, 'the default baseline is the dead and the selected resources');
    assert.ok(Math.abs(watcher.getStatus().bDefault - bucket.bDefault) < 1e-6);

    const bRow = bucket.paths.find(row => row.path === B);
    const preview = watcher.readScenario({ [B]: 'exclude' });
    assert.ok(Math.abs(preview.bDefault - (FIRST_STOCK + selectedTokens(bucket) - bRow.tokens)) < 1e-6, 'a preview prices the same dead');

    const prepared = watcher.prepareHandoff({ pathsToKeep: [{ path: B }], summary: 'Kept the module.', nextTask: 'Go on.' });
    assert.equal(prepared.status, 'ready');
    const row = store.getHandoffByToken(prepared.load_token);
    const previous = JSON.parse(row.previousStats);
    const stats = JSON.parse(row.preparedStats);
    assert.deepEqual([previous.dead, previous.session_floor], [FIRST_STOCK, FIRST_STOCK]);
    assert.deepEqual([stats.dead, stats.session_floor], [FIRST_STOCK, FIRST_STOCK]);
    assert.ok(row.keptTokens > 0);
    assert.equal(stats.b_kept, row.keptTokens + FIRST_STOCK);
    assert.deepEqual(rig.diagnostics, []);
  });

  test('the model the epoch\'s first call ran on stays the epoch model against the calls that stay', () => {
    const plan = [0, 1, 2, { seal: ['question', 0, 1] }, 3];
    const { rig: { watcher } } = runLive({ log: logOf(plan, { modelOf: step => (step === 1 ? FLASH : undefined) }) });

    assert.equal(watcher.getEpochModel(), FLASH);
    assert.equal(watcher.getStatus().cRatio, 50);
    assert.equal(watcher.getStatus().model, 'deepseek-v4-pro', 'the latest call still shows on the status');
    const control = runLive({ log: logOf(plan, { modelOf: () => undefined }) }).rig.watcher;
    assert.equal(control.getStatus().cRatio, 30, 'the ratio the default model\'s calls alone give');
  });

  test('a cold install of the same log ends where the live feed stands, with the dead of the first call', () => {
    const log = logOf([0, 1, 2, { seal: ['question', 0, 1] }, 3]);
    const { rig, store } = runLive({ log });
    const cold = watch({ store, workingTree: watchedTree({}).workingTree });
    cold.snapshot(log.events);

    assert.equal(cold.watcher.getBucketData().dead, FIRST_STOCK);
    assert.deepEqual(stateOf(cold.watcher), stateOf(rig.watcher));
    assert.deepEqual(cold.diagnostics, []);
  });

  test('a first call that reports no stock stays beside the first one that does, so the model and the dead are read from the two calls they came from', () => {
    // Step 1 reports no stock on the pricier model; the stock that anchors the epoch is step 2's, on the default model.
    const options = { modelOf: step => (step === 1 ? FLASH : undefined), usageFor: step => (step === 1 ? { inputTokens: 0, outputTokens: 12 } : usageOf(step - 1)) };
    const plan = [0, 1, 2, { seal: ['question', 0, 1] }, 3];
    const control = runLive({ log: logOf(plan, { ...options, withCarriers: false }) });
    const sealed = runLive({ log: logOf(plan, options) });

    const stock = FIRST_STOCK;
    assert.ok(control.rig.watcher.getBucketData().dead < stock && control.rig.watcher.getBucketData().dead > 0, 'the dead is the second call\'s stock less the resident the first call\'s result put there');
    assert.equal(sealed.rig.watcher.getBucketData().dead, control.rig.watcher.getBucketData().dead);
    assert.equal(sealed.rig.watcher.getEpochModel(), FLASH, 'the first accepted call decides the model');
    assert.equal(control.rig.watcher.getEpochModel(), FLASH);
    assert.deepEqual(sealed.rig.watcher.getHistory().slice(0, 2).map(point => point.L), [0, stock], 'the two calls of the head stay');
    assert.deepEqual(sealed.rig.diagnostics, []);
  });

  test('a true epoch is anchored on its own first call, which a seal in it keeps as the epoch before keeps its own', () => {
    const log = logOf([0, 1, 'checkpoint', 2, 3, { seal: [2] }, 4]);
    const { rig: { watcher } } = runLive({ log });

    // The epoch after the checkpoint opens on step 3; the seal lists only that step, which stays.
    assert.equal(watcher.getStatus().segment, 1);
    assert.deepEqual(watcher.getHistory().filter(point => point.segment === 1).map(point => point.L), [3, 4, 5, 6].map(stockOfStep));
    assert.equal(watcher.getBucketData().dead, stockOfStep(3));
  });
});

// ── A session that starts with /sw-load ──────────────────────────────────────

describe('a session that starts with /sw-load', () => {
  // Read-only calls whose texts hold at every version of the tree, so a cold install over a store that kept no record matches the same lines.
  const PLAN = [3, 4, 5, { seal: ['question', 3, 4, 5] }, { input: 'time-context' }, 9, 8, { seal: ['carriers', 9, 8] }];
  const logWith = (options = {}) => logOf(PLAN, { load: LOAD_WINDOW, ...options });

  // What the load put resident before any call, read from the ordinary run of the log's first two events.
  function loadedTokens(log) {
    const tree = editableTree(log.disks[0]);
    const rig = watch({ store: newStore(), workingTree: tree.workingTree });
    rig.snapshot([]);
    log.events.slice(0, 2).forEach((event, index) => { tree.set(log.disks[index]); rig.feed(event); });
    return rig.watcher.getBucketData().totalB;
  }

  test('the dead leaves out the window the load injected before any seal, and a seal, a reading ahead of the next call and a cold install over a store that kept nothing leave it where it was', () => {
    const log = logWith();
    const loaded = loadedTokens(log);
    const dead = FIRST_STOCK - loaded;
    assert.ok(loaded > 1_000 && dead > 0 && dead < FIRST_STOCK, `the load put ${loaded} tokens resident of a ${FIRST_STOCK} stock`);

    const control = runLive({ log: logWith({ withCarriers: false }) }).rig.watcher;
    const sealed = runLive({ log });
    const cold = watch({ store: newStore(), workingTree: watchedTree(ON_V2).workingTree });
    cold.snapshot(log.events);

    assert.equal(control.getBucketData().dead, dead, 'the ordinary run of the same calls takes the stock less the window');
    assert.equal(sealed.rig.watcher.getBucketData().dead, dead);
    assert.equal(cold.watcher.getBucketData().dead, dead);
    // The head, the call right behind the first carrier (the reading admitted ahead of it opens the second range) and the call right behind the second.
    const expectedL = [1, 4, 6].map(stockOfStep);
    assert.deepEqual(sealed.rig.watcher.getHistory().map(point => point.L), expectedL);
    assert.deepEqual(cold.watcher.getHistory().map(point => point.L), expectedL);
    assert.deepEqual(sealed.rig.diagnostics, []);
    assert.deepEqual(cold.diagnostics, []);
  });

  test('the floor is the first call\'s whole stock, and a selector change moves the baseline by the path it selects and leaves the dead', () => {
    const log = logWith();
    const dead = FIRST_STOCK - loadedTokens(log);
    const { rig: { watcher }, store } = runLive({ log });

    const before = watcher.getBucketData();
    const kept = before.paths.find(row => row.path === KEPT);
    assert.ok(kept.defaultSelected && kept.tokens > 0);
    watcher.replaceUserOverrides({ [KEPT]: 'exclude' });
    const after = watcher.getBucketData();
    assert.equal(after.dead, dead);
    assert.ok(Math.abs(after.bDefault - (before.bDefault - kept.tokens)) < 1e-6, 'the selection moves the resource part of the baseline alone');

    const prepared = watcher.prepareHandoff({ pathsToKeep: [{ path: B }], summary: 'Kept.', nextTask: 'Go on.' });
    const previous = JSON.parse(store.getHandoffByToken(prepared.load_token).previousStats);
    assert.deepEqual([previous.dead, previous.session_floor], [dead, FIRST_STOCK], 'the floor is the stock whole and the dead is not');
  });

  test('what the dead leaves out is the window the load injected, not the file it was read from', () => {
    const log = logWith();
    const loaded = loadedTokens(log);
    const whole = runLive({
      log: logOf([10], { calls: [...CALLS, { name: 'read', args: { file_path: KEPT }, text: readResultText(KEPT, KEPT_LINES), disk: ON_V1 }] }),
    }).rig.watcher.getBucketData().paths.find(row => row.path === KEPT).tokens;

    assert.ok(loaded < whole / 1.5, `the window ${loaded} is well under the file ${whole}`);
    const dead = runLive({ log }).rig.watcher.getBucketData().dead;
    assert.equal(dead, FIRST_STOCK - loaded);
    assert.ok(dead > FIRST_STOCK - whole);
  });
});

// ── The Rate Lamp ────────────────────────────────────────────────────────────

describe('the Rate Lamp across a seal', () => {
  beforeEach(() => {
    initStore(join(dir, 'global.sqlite'));
    _resetRateLampManagerForTest();
  });

  afterEach(() => {
    _resetRateLampManagerForTest();
    closeStoreGlobal();
  });

  // A watcher table over the global store, bootstrapped from an empty snapshot and fed by `feed`.
  async function tableOver(tree) {
    let release;
    const table = createWatcherTable({
      readSession: () => new Promise((resolve) => { release = resolve; }),
      compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
        sessionId, cwd, cacheTtl, store: getStore(), turnNotesRoot: join(dir, 'turn-notes'),
        readSession: async () => ({ events: [] }), isIgnored: null, workingTree: tree.workingTree,
      }),
    });
    table.ensure({ id: SESSION, header: { cwd: CWD } });
    release({ session: {}, inheritedEventCount: 0, events: [] });
    await new Promise(resolve => setImmediate(resolve));
    return table;
  }

  const clocksOf = () => {
    const { billProgress, billCycleCount, walletPhase, walletLapCount, stateKey } = getLiveLedger(SESSION);
    return { billProgress, billCycleCount, walletPhase, walletLapCount, stateKey };
  };

  test('keeps its clocks and counters through the rebuild, and runs on from them', async () => {
    const log = logOf([0, 1, 2, 3, 4, 5, { seal: [4, 5] }, 6, 7]);
    const seal = log.events.findIndex(isCarrier);
    const tree = editableTree(log.disks[0]);
    const table = await tableOver(tree);
    const feed = (from, to) => {
      for (let index = from; index < to; index += 1) {
        tree.set(log.disks[index]);
        table.feed(SESSION, log.events[index]);
      }
    };

    feed(0, seal);
    const before = clocksOf();
    assert.ok(before.billProgress > 0 && before.walletPhase > 0, 'the clocks have run before the seal');
    feed(seal, seal + 1);
    assert.deepEqual(clocksOf(), before);
    feed(seal + 1, log.events.length);
    const after = clocksOf();
    assert.ok(after.billProgress + after.billCycleCount > before.billProgress + before.billCycleCount, 'the clocks run on');
    assert.equal(after.stateKey, before.stateKey);
    table.disposeAll();
  });

  test('keeps them through a rebuild that withdraws the first call too, which leaves the dead it observed', async () => {
    const log = logOf([0, 1, 2, 3, { seal: ['question', 0, 1] }, 4, 5]);
    const seal = log.events.findIndex(isCarrier);
    const tree = editableTree(log.disks[0]);
    const table = await tableOver(tree);
    const feed = (from, to) => {
      for (let index = from; index < to; index += 1) {
        tree.set(log.disks[index]);
        table.feed(SESSION, log.events[index]);
      }
    };

    feed(0, seal);
    const before = clocksOf();
    assert.ok(before.billProgress > 0 && before.walletPhase > 0, 'the clocks have run before the seal');
    feed(seal, seal + 1);
    assert.deepEqual(clocksOf(), before);
    assert.equal(table.get(SESSION).watcher.getBucketData().dead, FIRST_STOCK);
    feed(seal + 1, log.events.length);
    const after = clocksOf();
    assert.ok(after.billProgress + after.billCycleCount > before.billProgress + before.billCycleCount, 'the clocks run on');
    assert.equal(after.stateKey, before.stateKey);
    assert.equal(table.get(SESSION).watcher.getBucketData().dead, FIRST_STOCK);
    table.disposeAll();
  });
});
