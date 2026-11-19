// Inner-seal stage points end to end through the DSH composition: authored logs whose ranges and carriers follow the shape the loop gives them, fed to the production composition's SessionWatcher through the DSH source driver.
// Which usages stand after the seals is written from the log alone (`test/helpers/dsh-selection-oracle.js`): the epoch's head, the first call behind each carrier and the calls no seal replaced; the geometry they give is held against a watcher fed the retained observations directly, which no fold produced.
import test, { afterEach, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeWatcher } from '../dsh/src/composition.js';
import { createWatcherTable } from '../dsh/src/watcher-table.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { reduceDshEvent } from '../lib/harness/dsh/transcript-observation.js';
import { closeStore, closeStoreGlobal, getStore, initStore, openStore } from '../lib/store.js';
import { getLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { CWD, watchedTree } from './helpers/attribution-fixtures.js';
import { B, changedSession, DISK, sealedSession } from './helpers/dsh-authored-seals.js';
import { standingUsages } from './helpers/dsh-selection-oracle.js';

const SESSION = 's-stage-points';

let dir;
const stores = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-stage-points-'));
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

// ── The rig ──────────────────────────────────────────────────────────────────

function watch({ store, sessionId = SESSION }) {
  const { watcher } = composeWatcher({
    sessionId, cwd: CWD, store, turnNotesRoot: join(dir, 'turn-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree: watchedTree(DISK).workingTree,
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
    // A frame of observations no fold produced, applied as the one install of a cold watcher.
    install(batches) {
      apply({ transition: 'replace', sourceLocator: sessionId, batches, sourceObserved: true, captureMode: 'replay' });
    },
  };
}

const runLive = (log, store = newStore()) => {
  const rig = watch({ store });
  rig.snapshot([]);
  for (const event of log.events) rig.feed(event);
  return { ...rig, store };
};

// What a reader of the watcher sees; the uptime and the stream revision are the only fields it does not compare.
const withoutUptime = ({ uptime: _ignored, ...status }) => status;
const stateOf = watcher => JSON.parse(JSON.stringify({
  status: withoutUptime(watcher.getStatus()),
  history: watcher.getHistory(),
  buckets: watcher.getBucketData(),
  frame: (({ streamRevision: _ignored, ...frame }) => frame)(watcher.readRateLampFrame(-1)),
}));

// The observations the watcher takes of an ordinary session, written from the log: every event of an unsealed span in
// full, and of a sealed range only its calls and their results as effects, with the usage of each assistant message the oracle says stands; each assistant message, sealed or not, leads its batch with the main call it makes.
function retainedBatches(log) {
  const standing = new Set(standingUsages(log));
  const sealed = new Set(log.ranges.flat());
  return log.events.flatMap((event) => {
    const mainCall = event.type === 'assistant/message' ? [{ type: 'main-call', sourceOrdinal: event.seq }] : [];
    const batch = [...mainCall, ...reduceDshEvent(event).observations];
    if (!sealed.has(event.seq)) return batch.length > 0 ? [batch] : [];
    const left = batch.flatMap((observation) => {
      if (observation.type === 'main-call' || observation.type === 'tool-use') return [observation];
      if (observation.type === 'tool-result') return [{ ...observation, effectsOnly: true }];
      return observation.type === 'usage' && standing.has(event.seq) ? [observation] : [];
    });
    return left.length > 0 ? [left] : [];
  });
}

// A request is named by the cache split of its usage, which the history reports back per point.
const splitOf = event => `${event.data.usage.cacheReadTokens}/${event.data.usage.cacheWriteTokens}`;
const splitOfPoint = point => `${point.cacheRead}/${point.cacheCreation}`;
const retainedSplits = log => standingUsages(log).map(seq => splitOf(log.events[seq]));

// The 1-based numbers of the model steps whose usage stands, and of all steps that name one by its cache split.
const stepsOf = log => log.events.filter(event => event.type === 'assistant/message');
const standingSteps = (log) => {
  const steps = stepsOf(log);
  return standingUsages(log).map(seq => steps.findIndex(event => event.seq === seq) + 1);
};

// ── The stage points ─────────────────────────────────────────────────────────

describe('the head and the call behind each carrier stand through every seal, whatever opens the range they sit in', () => {
  test('the authored log: the head, the call behind each carrier and the unsealed tail', () => {
    const log = sealedSession();
    // Step 1 is the head, steps 5, 7 and 9 follow the three carriers (the third range opens with admitted input, which sits ahead of step 7 and 9 alike), and steps 9 and 10 are the tail.
    assert.deepEqual(standingSteps(log), [1, 5, 7, 9, 10]);
    assert.equal(new Set(stepsOf(log).map(splitOf)).size, stepsOf(log).length, 'every request has its own cache split, so a retained usage names its step');
  });

  test('the watcher keeps exactly those usages beside every call, each carrier one replay replace', () => {
    const log = sealedSession();
    const rig = runLive(log);

    assert.deepEqual(rig.watcher.getHistory().map(splitOfPoint), retainedSplits(log));
    assert.deepEqual(rig.frames.slice(1).map(frame => `${frame.transition}/${frame.captureMode}`).filter(mode => mode === 'replace/replay').length, 3);
    assert.deepEqual(rig.diagnostics, []);
  });

  test('the sealed watcher is the watcher of the retained observations: status, history, buckets, resources and rate samples', () => {
    const log = sealedSession();
    const live = runLive(log);
    const control = watch({ store: newStore() });
    control.install(retainedBatches(log));

    assert.deepEqual(stateOf(live.watcher), stateOf(control.watcher));
    assert.ok(live.watcher.getBucketData().paths.length > 0 && live.watcher.getBucketData().totalB > live.watcher.getBucketData().dead, 'the calls left resident resources');
    assert.ok(live.watcher.getHistory().length > 1);
  });
});

// ── One event cut, three readings ────────────────────────────────────────────

// The log as it stood after `count` events: the seals whose carrier is among them, every request's reads unchanged.
const cutOf = (log, count) => {
  const kept = log.carriers.filter(at => at < count).length;
  return { ...log, events: log.events.slice(0, count), ranges: log.ranges.slice(0, kept), carriers: log.carriers.slice(0, kept) };
};

// Each event cut of `log` read three ways, against the watcher of the retained observations: at every carrier and at the log's end.
function agreeAtEveryCut(log) {
  const cuts = [...log.carriers.map(at => at + 1), log.events.length];

  for (const count of cuts) {
    test(`the first ${count} events`, () => {
      const cut = cutOf(log, count);
      const control = watch({ store: newStore() });
      control.install(retainedBatches(cut));
      const expected = stateOf(control.watcher);

      const live = runLive(cut);
      assert.deepEqual(stateOf(live.watcher), expected, 'live');
      assert.deepEqual(live.diagnostics, []);

      const snapshot = watch({ store: newStore() });
      snapshot.snapshot(cut.events);
      assert.deepEqual(stateOf(snapshot.watcher), expected, 'snapshot');

      // The cold install over the records the live feed kept: the matcher is not asked again.
      const tree = watchedTree({});
      const { watcher } = composeWatcher({
        sessionId: SESSION, cwd: CWD, store: live.store, turnNotesRoot: join(dir, 'turn-notes'),
        readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree: tree.workingTree,
      });
      const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
      watcher.applyHarnessFrame(driver.install(cut.events));
      assert.deepEqual(stateOf(watcher), expected, 'cold');
      assert.deepEqual(tree.calls, { resolve: 0, stat: 0, readText: 0 });
    });
  }
}

describe('the live feed, a snapshot and a cold install of the same event cut stand together with the retained observations', () => {
  const log = sealedSession();
  agreeAtEveryCut(log);

  test('a snapshot cut in the middle of a range and the events after it fed live end where the whole log does', () => {
    const middle = log.carriers[0] - 2;
    const rig = watch({ store: newStore() });
    rig.snapshot(log.events.slice(0, middle));
    for (const event of log.events.slice(middle)) rig.feed(event);
    const control = watch({ store: newStore() });
    control.install(retainedBatches(log));
    assert.deepEqual(stateOf(rig.watcher), stateOf(control.watcher));
  });
});

// ── An ordinary change of the prompt or the tool declarations ────────────────

// Nothing but a seal withdraws a usage in an ordinary session, whatever the prompt or the declarations do. The authored log carries the changes a session makes: a system node appended in the first range and sealed with it, the head normalized in place behind that seal, a tool added in the second range, one removed right behind its carrier, and a second head replacement in the unsealed tail.
describe('a replaced system head and a changed tool declaration leave the stage points and the tail to the ordinary rules', () => {
  const log = changedSession();

  test('the authored log: the head and the call behind each carrier stand across the changes, the declaration change in front of step 7 included', () => {
    // Step 1 is the head, steps 4, 7 and 9 follow the carriers (the tool-registry message of the removal sits ahead of step 7), and steps 9 and 10 are the tail.
    assert.deepEqual(standingSteps(log), [1, 4, 7, 9, 10]);
    assert.equal(new Set(stepsOf(log).map(splitOf)).size, stepsOf(log).length, 'every request has its own cache split, so a retained usage names its step');
    const replacements = log.events.filter(event => event.type === 'system/message' && event.surfaceOp?.op === 'replace');
    const registry = log.events.filter(event => event.type === 'developer/message');
    assert.equal(replacements.length, 2);
    assert.deepEqual(registry.map(event => event.data.message.content.map(block => `${block.type} ${block.toolName}`)), [['tool-addition grep'], ['tool-removal grep']]);
    assert.equal(log.events[log.events.findIndex(event => event === registry[1]) - 1].type, 'request/header', 'a changed header precedes the message');
    // The head comes before every change; the call behind the first carrier after the head replacement and before the declaration changes; the call behind the third after the removal.
    const [first, second, , third] = standingUsages(log);
    assert.ok(first < Math.min(...replacements.map(event => event.seq), registry[0].seq));
    assert.ok(replacements[0].seq < second && second < registry[0].seq);
    assert.ok(registry[1].seq < third);
  });

  test('the watcher keeps those usages, the head beside the steps after every change, and is the watcher of the retained observations', () => {
    const live = runLive(log);
    assert.deepEqual(live.watcher.getHistory().map(splitOfPoint), retainedSplits(log));
    assert.deepEqual(live.diagnostics, []);
    const control = watch({ store: newStore() });
    control.install(retainedBatches(log));
    assert.deepEqual(stateOf(live.watcher), stateOf(control.watcher));
  });

  agreeAtEveryCut(log);
});

// ── A user's resource selection ──────────────────────────────────────────────

test('a user\'s override on a resource stays in force across the rebuild and prices as the retained observations price it', () => {
  const log = sealedSession();
  const overrides = { [B]: 'exclude' };
  const rig = watch({ store: newStore() });
  rig.snapshot([]);
  log.events.forEach((event, index) => {
    if (index === log.carriers[0]) rig.watcher.replaceUserOverrides(overrides);
    rig.feed(event);
  });
  const control = watch({ store: newStore() });
  control.install(retainedBatches(log));
  control.watcher.replaceUserOverrides(overrides);

  assert.equal(rig.watcher.getBucketData().paths.find(row => row.path === B).userOverride, 'exclude');
  assert.deepEqual(stateOf(rig.watcher), stateOf(control.watcher));
  const unrestricted = watch({ store: newStore() });
  unrestricted.install(retainedBatches(log));
  assert.notEqual(stateOf(unrestricted.watcher).status.bDefault, stateOf(rig.watcher).status.bDefault, 'the selection moves the baseline');
});

// ── The epoch head and the clocks already paid ──────────────────────────────

describe('the clocks already paid and the epoch head across the rebuild', () => {
  beforeEach(() => {
    initStore(join(dir, 'global.sqlite'));
    _resetRateLampManagerForTest();
  });

  afterEach(() => {
    _resetRateLampManagerForTest();
    closeStoreGlobal();
  });

  async function tableOver() {
    let release;
    const table = createWatcherTable({
      readSession: () => new Promise((resolve) => { release = resolve; }),
      compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
        sessionId, cwd, cacheTtl, store: getStore(), turnNotesRoot: join(dir, 'turn-notes'),
        readSession: async () => ({ events: [] }), isIgnored: null, workingTree: watchedTree(DISK).workingTree,
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

  test('each carrier\'s rebuild leaves the clocks as they stood and the dead the first call observed, which the epoch\'s head still measures', async () => {
    const log = sealedSession();
    const table = await tableOver();
    const first = log.events.find(event => event.type === 'assistant/message');
    let paid = null;
    for (const [index, event] of log.events.entries()) {
      table.feed(SESSION, event);
      if (log.carriers.includes(index)) {
        const now = clocksOf();
        if (paid !== null) assert.ok(now.billProgress + now.billCycleCount >= paid.billProgress + paid.billCycleCount, `carrier ${index}: no clock goes back`);
        assert.equal(table.get(SESSION).watcher.getHistory().length >= 1, true);
        paid = now;
      } else if (paid !== null && event.type === 'assistant/message') {
        const now = clocksOf();
        assert.ok(now.billProgress + now.billCycleCount >= paid.billProgress + paid.billCycleCount, `event ${index}: the clocks run on`);
        paid = now;
      }
    }
    const watcher = table.get(SESSION).watcher;
    const stock = first.data.usage.inputTokens + first.data.usage.cacheReadTokens + first.data.usage.cacheWriteTokens;
    assert.equal(watcher.getBucketData().dead, stock, 'the dead is the first call\'s stock');
    assert.equal(watcher.getHistory()[0].L, stock, 'the first call is a measured point again');
    table.disposeAll();
  });

  test('every carrier\'s rebuild keeps each clock exactly as it stood', async () => {
    const log = sealedSession();
    const table = await tableOver();
    for (const [index, event] of log.events.entries()) {
      if (log.carriers.includes(index)) {
        const before = clocksOf();
        assert.ok(before.billProgress > 0, 'the clocks have run before the carrier');
        table.feed(SESSION, event);
        assert.deepEqual(clocksOf(), before, `carrier ${index}`);
      } else {
        table.feed(SESSION, event);
      }
    }
    table.disposeAll();
  });
});
