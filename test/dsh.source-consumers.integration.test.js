// One Source, three consumers at the same event cut: the DSH composition's SessionWatcher over a real Store in a
// temporary directory (the measurement), and the inner monitor's projection with the rows it derives (the seal's context
// change), both fed the same authored log. The expected values are the usages the log scripts and the call each
// carrier is followed by, written down beside the events. Without the checkout `SW_DSH_CHECKOUT` names, the monitor's
// cases skip.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { composeWatcher } from '../dsh/src/composition.js';
import { innerMonitorProjection, rowsOf } from '../dsh/src/inner-monitor-read.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { closeStore, openStore } from '../lib/store.js';
import { contextMissText, contextRangeText } from '../dsh/src/client/monitor-state.js';
import { watchedTree } from './helpers/attribution-fixtures.js';
import {
  assistantMessage, compactCheckpoint, compactionPrune, innerAttempt, innerCall, innerSealCarrier, userMessage,
} from './helpers/dsh-events.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SESSION_LIB = 'packages/core/session/lib/index.js';
const LLM_LIB = 'packages/llm/llm/lib/index.js';
const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : [SESSION_LIB, LLM_LIB].find(path => !existsSync(join(CHECKOUT, path)))?.replace(/^/, 'SW_DSH_CHECKOUT names no ') ?? false;
const [sessionPackage, llmPackage] = skip ? [] : await Promise.all([SESSION_LIB, LLM_LIB].map(path => import(pathToFileURL(join(CHECKOUT, path)).href)));
const kit = skip ? null : {
  pluginRecordOf: sessionPackage.pluginRecordOf,
  assembleAssistantStream: llmPackage.assembleAssistantStream,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
};

let dir;
let store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-source-consumers-'));
  store = openStore(join(dir, 'store.sqlite'));
});
afterEach(() => {
  closeStore(store);
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = 's-consumers';

// Call `n`'s usage: its stock is 102 + 1000n and its uncached tokens are 102, so a stock names its call.
const usage = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
const stockOf = n => 102 + 1_000 * n;
const UNCACHED = 102;

// A seal over `range`, its records first as the seal writes them, then the carrier citing the call record, the prune and the range.
function sealOver(range) {
  const start = innerAttempt({ range });
  const call = innerCall({ range, attempt: start.seq });
  const prune = compactionPrune({ seq: range[0] });
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, prune.seq, ...range], slots: [{ seqs: range, text: 'summary' }] });
  return { events: [start, call, prune, carrier], carrier };
}

// The log: the epoch's head and an unsealed call, a seal; a runtime reading ahead of the call behind that carrier, which is followed by one more unsealed call, then a second seal over both; a call that reports no usage behind it, a call with usage after that, and a third seal; then the epoch is compacted and a call of the new epoch follows.
function authoredLog() {
  const ask = userMessage({ text: 'please work' });
  const head = assistantMessage({ text: 'one', usage: usage(1) });
  const early = assistantMessage({ text: 'two', usage: usage(2) });
  const first = sealOver([ask.seq, head.seq, early.seq]);
  const reading = userMessage({ text: 'ctx', kind: 'runtime-context' });
  const post = assistantMessage({ text: 'three', usage: usage(3) });
  const current = assistantMessage({ text: 'four', usage: usage(4) });
  const second = sealOver([reading.seq, post.seq, current.seq]);
  const missing = assistantMessage({ text: 'no count reported' });
  const filled = assistantMessage({ text: 'five', usage: usage(5) });
  const third = sealOver([missing.seq, filled.seq]);
  const checkpoint = compactCheckpoint({ startSeq: ask.seq, endSeq: third.carrier.seq });
  const next = assistantMessage({ text: 'six', usage: usage(6) });
  const events = [ask, head, early, ...first.events, reading, post, current, ...second.events, missing, filled, ...third.events, checkpoint, next];
  const cut = event => events.indexOf(event) + 1;
  return {
    events,
    cuts: {
      behindFirstCarrier: cut(first.carrier), behindPost: cut(post), behindSecondCarrier: cut(second.carrier),
      behindMissing: cut(missing), behindThirdCarrier: cut(third.carrier), inNextEpoch: cut(next),
    },
    carriers: [first.carrier, second.carrier, third.carrier],
  };
}

// The watcher over `events`: the last `live` events fed after the snapshot of the rest, as the host feeds them.
function measure(events, live = 0) {
  const { watcher } = composeWatcher({
    sessionId: SESSION, cwd: '/repo', store, turnNotesRoot: join(dir, 'turn-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree: watchedTree({}).workingTree,
  });
  const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
  const apply = (frame) => { if (frame !== null) watcher.applyHarnessFrame(frame); };
  apply(driver.install(events.slice(0, events.length - live)));
  for (const frame of driver.drain()) apply(frame);
  for (const event of events.slice(events.length - live)) apply(driver.feed(event));
  return watcher;
}

const projection = skip ? null : innerMonitorProjection(kit);
const rowsOver = events => rowsOf(events.reduce((state, event) => projection.apply(state, event), projection.init()), [], kit);

// The points of the open epoch the history shows, as their stocks.
const stocksOf = watcher => watcher.getHistory().filter(point => point.segment === watcher.getStatus().segment).map(point => point.L);
const uncachedOfPoint = point => point.L - point.cacheRead;

test('the measurement keeps the head and the call right behind each carrier, and the monitor reads its after from that call', { skip }, () => {
  const { events, cuts } = authoredLog();

  // Behind the first carrier, no main call follows it: the seal waits, and the early call went with its range.
  let watcher = measure(events.slice(0, cuts.behindFirstCarrier));
  assert.deepEqual(stocksOf(watcher), [stockOf(1)]);
  assert.deepEqual(rowsOver(events.slice(0, cuts.behindFirstCarrier)).map(row => row.contextChange.after), [null]);

  // The call behind it, after the reading the loop admitted ahead of it, is its post.
  watcher = measure(events.slice(0, cuts.behindPost));
  assert.deepEqual(stocksOf(watcher), [stockOf(1), stockOf(3)]);
  const [afterPost] = rowsOver(events.slice(0, cuts.behindPost));
  assert.deepEqual([afterPost.contextChange.after, afterPost.contextChange.miss], [stockOf(3), UNCACHED]);

  // The second carrier lists the post and the call after it: the post stays, the unsealed call goes.
  watcher = measure(events.slice(0, cuts.behindSecondCarrier));
  assert.deepEqual(stocksOf(watcher), [stockOf(1), stockOf(3)]);
  assert.deepEqual(rowsOver(events.slice(0, cuts.behindSecondCarrier)).map(row => row.contextChange.after), [stockOf(3), null]);
});

test('a post that reports no usage is missing for the monitor and no point of the measurement, and the call after it fills nothing back', { skip }, () => {
  const { events, cuts } = authoredLog();
  const watcher = measure(events.slice(0, cuts.behindThirdCarrier));
  const rows = rowsOver(events.slice(0, cuts.behindThirdCarrier));

  // The calls of the second range went with it but for its post; the third range's call with usage was sealed as an unsealed current one.
  assert.deepEqual(stocksOf(watcher), [stockOf(1), stockOf(3)]);
  assert.deepEqual(rows.map(row => row.contextChange.after), [stockOf(3), null, null]);
  const behindMissing = measure(events.slice(0, cuts.behindMissing));
  assert.deepEqual(stocksOf(behindMissing), [stockOf(1), stockOf(3)]);
  const [, second] = rowsOver(events.slice(0, cuts.behindMissing));
  assert.equal(second.contextChange.after, null, 'the first call behind the second carrier reports none');
  const [, waiting] = rowsOver(events.slice(0, cuts.behindMissing - 1));
  assert.equal(waiting.contextChange.after, null);
  assert.equal(waiting.revision, events[cuts.behindSecondCarrier - 1].seq, 'waiting: the carrier\'s seq');
  assert.equal(second.revision, events[cuts.behindMissing - 1].seq, 'missing: the call that reported none moved it');
  const filledRows = rowsOver(events.slice(0, cuts.behindMissing + 1));
  assert.equal(filledRows[1].contextChange.after, null, 'the call behind it with usage fills nothing back');
  assert.deepEqual(stocksOf(measure(events.slice(0, cuts.behindMissing + 1))), [stockOf(1), stockOf(3), stockOf(5)], 'and is a point of the unsealed range');
});

test('a true epoch between a carrier and the next main call leaves the seal waiting and starts the new epoch on that call', { skip }, () => {
  const { events, cuts } = authoredLog();
  const watcher = measure(events.slice(0, cuts.inNextEpoch));

  assert.equal(watcher.getStatus().segment, 1);
  assert.deepEqual(stocksOf(watcher), [stockOf(6)]);
  assert.deepEqual(rowsOver(events.slice(0, cuts.inNextEpoch)).map(row => row.contextChange.after), [stockOf(3), null, null], 'the third seal\'s post is not the new epoch\'s call');
});

test('the live feed, the snapshot and the monitor of the same cut agree, and every sampled after is a point the measurement holds', { skip }, () => {
  const { events, cuts } = authoredLog();
  for (const [name, cut] of Object.entries(cuts)) {
    const prefix = events.slice(0, cut);
    const snapshot = measure(prefix);
    const live = measure(prefix, Math.min(5, prefix.length));
    assert.deepEqual(live.getHistory(), snapshot.getHistory(), name);
    assert.deepEqual(live.getBucketData().dead, snapshot.getBucketData().dead, name);
    const held = snapshot.getHistory();
    for (const row of rowsOver(prefix)) {
      const { after, miss } = row.contextChange;
      if (after === null) continue;
      const point = held.find(each => each.L === after);
      assert.ok(point !== undefined || snapshot.getStatus().segment > 0, `${name}: the monitor's after ${after} is a point of the measurement`);
      if (point !== undefined) assert.equal(uncachedOfPoint(point), miss, name);
    }
  }
});

test('the client view of the rows shows the post\'s quantities and no other call\'s', { skip }, () => {
  const { events, cuts } = authoredLog();
  // The key and the values it is handed, so what the view shows is read back without a locale.
  const t = (key, values) => `${key}${values === undefined ? '' : JSON.stringify(values)}`;
  const [row] = rowsOver(events.slice(0, cuts.behindPost));
  // The early call, the last main call before the seal started, counts its output: 2102 + 40.
  assert.equal(contextRangeText(row.contextChange, t), `monitor.meta.range${JSON.stringify({ before: stockOf(2) + 40, after: stockOf(3) })}`);
  assert.equal(contextMissText(row.contextChange, t), `monitor.meta.miss${JSON.stringify({ count: UNCACHED })}`);
  const [waiting] = rowsOver(events.slice(0, cuts.behindFirstCarrier));
  assert.equal(contextMissText(waiting.contextChange, t), '—', 'a seal still waiting for its post shows none');
});
