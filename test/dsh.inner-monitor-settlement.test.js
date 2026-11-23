// The inner monitor's settlement read: sampled main calls and their chart marks, and the settlement's estimate of the context a seal removed.
// The projection is folded over the synthetic log `test/helpers/dsh-events.js` builds, with a kit that reads the plugin records and the settlement's usage chunks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMonitorAccess } from '../dsh/src/inner-monitor-read.js';
import { createRpcHandler } from '../dsh/src/rpc.js';
import { seriesOf, stockGeometryOf } from '../dsh/src/client/monitor-context-model.js';
import { composeWatcher } from '../dsh/src/composition.js';
import { createDshSourceDriver } from '../lib/harness/dsh/source-driver.js';
import { openStore, closeStore } from '../lib/store.js';
import { paybackOf, settlementsOf } from '../public/lib/compactionEconomics.js';
import {
  assistantMessage, attempt, compactionPrune, innerAttempt, innerCall, innerSealCarrier, loadPayload, prunedResult, toolCall, toolResult, userMessage,
} from './helpers/dsh-events.js';
import {
  SESSION, kit, fold, tokens, clear, pricedSeal, failedSeal,
} from './helpers/dsh-settlement.js';

// The access over one session's events, held by the host (state folded from the events, log read whole through `readSession`, whose reads `reads` counts) or stored (state and log from one snapshot).
function accessOver(events, { held = true } = {}) {
  const reads = { held: 0, stored: 0 };
  const access = createMonitorAccess({
    sessionOf: id => (held && id === SESSION ? {} : undefined),
    readMonitor: () => fold(events),
    live: () => [],
    kit,
    readSession: async () => { reads.held += 1; return { events }; },
    readStored: async (id) => { reads.stored += 1; return !held && id === SESSION ? { state: fold(events), events } : undefined; },
    nextTaskOf: () => null,
  });
  return { access, reads };
}

// A committed seal over `range` that records no quote and no usage: the attempt record, the call record and the carrier that cites it. Seals that are priced or failed are the helper's.
function seal(range) {
  const seqs = range.map(event => event.seq);
  const start = innerAttempt({ range: seqs });
  const call = innerCall({ range: seqs, attempt: start.seq, endedAt: 1_700_000_100_000 });
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, ...seqs], slots: [{ seqs: [seqs[0]], text: 'summary' }] });
  return { start, events: [start, call, carrier] };
}

// A segment of six main calls beside the events that are none: two committed seals of the three attempts it starts (the failed one between them), the first seal's post a call with a stock and the second's a call that reports no usage. The attempts' ordinals are 1, 2 and 3, the committed ones 1 and 3.
function firstSegment() {
  const ask = userMessage({ text: 'please work' });
  const one = assistantMessage({ text: 'one', usage: tokens(100, 20, 300, 40) });
  const silent = assistantMessage({ text: 'two' });
  const aside = attempt({ usageChunk: { inputTokens: 9, outputTokens: 9 } });
  const result = toolResult({ callId: 'c-1', text: 'a result' });
  const sealOne = seal([ask, one, silent]);
  const postOne = assistantMessage({ text: 'three', usage: tokens(50, 5, 600) });
  const lost = failedSeal([postOne]);
  const four = assistantMessage({ text: 'four', usage: tokens(10, 1, 700) });
  const sealThree = seal([postOne, four]);
  const postThree = assistantMessage({ text: 'five' });
  const six = assistantMessage({ text: 'six', usage: tokens(1, 1, 900) });
  const calls = [one, silent, postOne, four, postThree, six];
  return {
    ask, calls, sealOne, sealThree, lost, postOne, postThree, six,
    events: [ask, one, silent, aside, result, ...sealOne.events, postOne, ...lost.events, four, ...sealThree.events, postThree, six],
  };
}

const callsOf = (segment, posts) => segment.calls.map(event => ({
  seq: event.seq, stock: event.data.usage === undefined ? null : event.data.usage.inputTokens + (event.data.usage.cacheReadTokens ?? 0) + (event.data.usage.cacheWriteTokens ?? 0), post: posts.includes(event),
}));

test('a continue\'s settlement lists the main calls of the segment it cleared in log order, each with its stock, and marks the first call behind each committed seal; events that are no main call, failed attempts and the segments after the clear add nothing', async () => {
  const first = firstSegment();
  const cleared = clear('amber-falcon', { from: first.ask, to: first.six });
  const resumed = [assistantMessage({ text: 'resumed', usage: tokens(300, 50, 9000, 400) }), assistantMessage({ text: 'again', usage: tokens(1, 1) })];
  const events = [...first.events, ...cleared.events, ...resumed];
  const { access } = accessOver(events);

  const answer = await access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual(answer.calls, callsOf(first, [first.postOne, first.postThree]));
  assert.deepEqual(answer.calls.map(call => call.stock), [440, null, 650, 710, null, 901]);
  assert.deepEqual(answer.calls.filter(call => call.post).map(call => call.seq), [first.postOne.seq, first.postThree.seq]);
});

test('the Nth mark is the Nth committed compaction of the segment by row order, whatever ordinals the attempts hold, and the stock beside it is the context that compaction\'s row shows after it', async () => {
  const first = firstSegment();
  const cleared = clear('amber-falcon', { from: first.ask, to: first.six });
  const { access } = accessOver([...first.events, ...cleared.events]);

  const { attempts } = await access.rows(SESSION);
  const answer = await access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual(attempts.map(row => [row.id, row.status]), [[first.sealOne.start.seq, 'committed'], [first.lost.start.seq, 'failed'], [first.sealThree.start.seq, 'committed']]);
  const committed = attempts.filter(row => row.status === 'committed');
  const marked = answer.calls.filter(call => call.post);
  assert.equal(marked.length, committed.length);
  assert.deepEqual(marked.map(call => call.stock), committed.map(row => row.contextChange.after), 'the first row shows the stock of the first mark, the second row the second mark\'s, which reports none');
  assert.deepEqual(marked.map(call => call.seq), [first.postOne.seq, first.postThree.seq]);
});

test('the current settlement reads the latest epoch from one committed snapshot, including its tail and recall evidence', async () => {
  const old = userMessage({ text: 'previous segment' });
  const { events: boundary } = clear('previous', { from: old, to: old });
  const ask = userMessage({ text: 'current segment' });
  const before = assistantMessage({ text: 'working', model: 'uncalibrated', usage: tokens(100, 30, 900) });
  const sealed = pricedSeal([before], 1);
  const read = { id: 'recall', name: 'sw_event_read', arguments: JSON.stringify({ seq: ask.seq }) };
  const recalled = assistantMessage({ turn: 2, toolCalls: [read], usage: tokens(20, 7, 570, 10) });
  const dispatched = toolCall({ turn: 2, callId: read.id, name: read.name, arguments: read.arguments });
  const result = toolResult({ turn: 2, callId: read.id, text: 'abcdefghijkl' });
  const working = assistantMessage({ turn: 2, step: 2, text: 'resume', usage: tokens(20, 7, 600) });
  const later = assistantMessage({ turn: 2, step: 3, text: 'more work', usage: tokens(20, 7, 650) });
  let events = [old, ...boundary, ask, before, ...sealed.events, recalled, dispatched, result, working];
  const initial = structuredClone(events);
  let reads = 0;
  const access = createMonitorAccess({
    sessionOf: () => ({}), readMonitor: () => fold([old]), live: () => [], kit,
    readStored: async () => { reads += 1; return { state: fold(events), events }; },
  });
  const handler = createRpcHandler({ innerMonitor: () => access });
  const readCurrent = () => handler('inner-monitor/settlement/current', { sessionId: SESSION });

  const first = await readCurrent();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.value.epoch, 2);
  assert.equal(first.value.tailCalls, 2);
  assert.deepEqual(first.value.attempts.map(({ id, contextChange }) => [id, contextChange]), [
    [sealed.start.seq, { before: 1030, after: 600, delta: -430, miss: 30 }],
  ]);
  assert.deepEqual(first.value.calls.map(({ seq, post }) => [seq, post]), [[before.seq, false], [recalled.seq, true], [working.seq, false]]);
  assert.deepEqual(first.value.recall, {
    steps: [
      { at: 2, seq: recalled.seq, usage: { input: 20, output: 7, cacheRead: 570, cacheWrite: 10 }, ratio: 2, post: sealed.start.seq },
      { at: 3, seq: working.seq, resident: 4 },
    ], cuts: [],
  });
  assert.equal(reads, 1);
  assert.deepEqual(events, initial);

  events = [...events, later];
  const second = await readCurrent();
  assert.equal(second.value.tailCalls, 3);
  assert.deepEqual(second.value.recall.steps.at(-1), { at: 4, seq: later.seq, resident: 4 });
  assert.equal(first.value.calls.at(-1).seq, working.seq);
  assert.equal(reads, 2);
});

test('a refused event read is charged as its request and leaves no returned copy resident', async () => {
  const old = userMessage({ text: 'previous segment' });
  const { events: boundary } = clear('previous', { from: old, to: old });
  const ask = userMessage({ text: 'current segment' });
  const before = assistantMessage({ text: 'working', model: 'uncalibrated', usage: tokens(100, 30, 900) });
  const sealed = pricedSeal([before], 1);
  const read = { id: 'recall', name: 'sw_event_read', arguments: JSON.stringify({ seq: ask.seq }) };
  const recalled = assistantMessage({ turn: 2, toolCalls: [read], usage: tokens(20, 7, 570, 10) });
  const dispatched = toolCall({ turn: 2, callId: read.id, name: read.name, arguments: read.arguments });
  const refused = toolResult({ turn: 2, callId: read.id, text: 'Error: already in your context', isError: true });
  const working = assistantMessage({ turn: 2, step: 2, text: 'resume', usage: tokens(20, 7, 600) });
  const events = [old, ...boundary, ask, before, ...sealed.events, recalled, dispatched, refused, working];
  const access = createMonitorAccess({
    sessionOf: () => ({}), readMonitor: () => fold([old]), live: () => [], kit,
    readStored: async () => ({ state: fold(events), events }),
  });
  const answer = await createRpcHandler({ innerMonitor: () => access })('inner-monitor/settlement/current', { sessionId: SESSION });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.value.recall, {
    steps: [{ at: 2, seq: recalled.seq, usage: { input: 20, output: 7, cacheRead: 570, cacheWrite: 10 }, ratio: 2, post: sealed.start.seq }], cuts: [],
  });
});

test('settlement marks one model request for two same-epoch event reads and counts both returned copies only where they were in the input', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'working', model: 'uncalibrated', usage: tokens(100, 30, 900) });
  const first = pricedSeal([before], 1);
  const reads = [
    { id: 'event-one', name: 'sw_event_read', arguments: JSON.stringify({ seq: ask.seq, session_id: SESSION }) },
    { id: 'event-two', name: 'session_event_read', arguments: JSON.stringify({ seq: ask.seq }) },
  ];
  const request = assistantMessage({ turn: 2, toolCalls: reads, usage: tokens(20, 7, 570, 10) });
  const answers = reads.flatMap(({ id, name, arguments: args }) => [
    toolCall({ turn: 2, callId: id, name, arguments: args }),
    toolResult({ turn: 2, callId: id, text: 'abcdefghijkl' }),
  ]);
  const working = assistantMessage({ turn: 2, step: 2, text: 'resume', usage: tokens(20, 7, 600) });
  const second = pricedSeal([request, ...answers.filter(event => event.type === 'tool/result'), working], 2);
  const post = assistantMessage({ turn: 3, text: 'post', usage: tokens(30, 5, 570) });
  const cleared = clear('amber-falcon', { from: ask, to: post });
  const events = [ask, before, ...first.events, request, ...answers, working, ...second.events, post, ...cleared.events];
  const snapshot = structuredClone(events);
  const { access, reads: sourceReads } = accessOver(events, { held: false });
  const prior = await access.rows(SESSION);

  const answer = await access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual(answer.recall, {
    steps: [
      { at: 2, seq: request.seq, usage: { input: 20, output: 7, cacheRead: 570, cacheWrite: 10 }, ratio: 2, post: first.start.seq },
      { at: 3, seq: working.seq, resident: 8 },
    ],
    cuts: [{ id: second.start.seq, tokens: 8 }],
  });
  assert.deepEqual(answer.calls, [
    { seq: before.seq, stock: 1000, post: false }, { seq: request.seq, stock: 600, post: true },
    { seq: working.seq, stock: 620, post: false }, { seq: post.seq, stock: 600, post: true },
  ]);
  assert.deepEqual(sourceReads, { held: 0, stored: 2 });
  assert.deepEqual(events, snapshot);
  assert.deepEqual(await access.rows(SESSION), prior);
});

test('a mixed request adds no full charge, and only the current epoch recall copy in the request counts after tool-result pruning', async () => {
  const old = userMessage({ text: 'prior task' });
  const earlier = clear('first', { from: old, to: old });
  const task = userMessage({ text: 'current task, still present after the seal' });
  const before = assistantMessage({ text: 'working', model: 'uncalibrated', usage: tokens(100, 30, 900) });
  const sealed = pricedSeal([before], 1);
  const batch = (step, operations) => {
    const turn = 2;
    const tools = operations.map(([name, args], index) => ({ id: `c${index}`, name, arguments: JSON.stringify(args) }));
    const request = assistantMessage({ turn, step, toolCalls: tools, usage: tokens(20, 7, 570, 10) });
    const results = [];
    const events = [request, ...tools.flatMap(({ id, name, arguments: args }) => {
      const call = toolCall({ turn, step, callId: id, name, arguments: args });
      const result = toolResult({ turn, step, callId: id, text: 'abcdefghijkl' });
      results.push(result);
      return [call, result];
    })];
    return { request, events, results };
  };
  const mixed = batch(1, [['sw_event_read', { seq: task.seq }], ['read', { file_path: 'work.js' }]]);
  const [original] = mixed.results;
  const prune = compactionPrune(original);
  const replacement = prunedResult(original, { text: 'abcdef' });
  const oldRead = batch(2, [['session_event_read', { seq: old.seq }]]);
  const working = assistantMessage({ turn: 2, step: 3, text: 'working again', usage: tokens(20, 7, 600) });
  const cleared = clear('second', { from: task, to: working });
  const { access } = accessOver([old, ...earlier.events, task, before, ...sealed.events, ...mixed.events, prune, replacement, ...oldRead.events, working, ...cleared.events]);

  assert.deepEqual((await access.settlement(SESSION, cleared.payload.seq)).recall, {
    steps: [{ at: 3, seq: oldRead.request.seq, resident: 2 }, { at: 4, seq: working.seq, resident: 2 }],
    cuts: [],
  });
});

test('settlement does not credit a later seal for the last pure recall output or charge for its unread result', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'working', usage: tokens(100, 30, 900) });
  const first = pricedSeal([before], 1);
  const read = { id: 'recall', name: 'sw_event_read', arguments: JSON.stringify({ seq: ask.seq }) };
  const request = assistantMessage({ turn: 2, toolCalls: [read], usage: tokens(20, 800, 570, 10) });
  const call = toolCall({ turn: 2, callId: read.id, name: read.name, arguments: read.arguments });
  const result = toolResult({ turn: 2, callId: read.id, text: 'unread copy' });
  const second = pricedSeal([request, result], 1);
  const post = assistantMessage({ turn: 3, text: 'post', usage: tokens(30, 5, 540) });
  const cleared = clear('amber-falcon', { from: ask, to: post });
  const { access } = accessOver([ask, before, ...first.events, request, call, result, ...second.events, post, ...cleared.events]);

  assert.deepEqual((await access.settlement(SESSION, cleared.payload.seq)).recall, {
    steps: [{ at: 2, seq: request.seq, usage: { input: 20, output: 800, cacheRead: 570, cacheWrite: 10 }, ratio: 2, post: first.start.seq }],
    cuts: [{ id: second.start.seq, tokens: 800 }],
  });
});

test('a cleared segment skips an interrupted call with no usage and restores the cut and dashed line from the last reading before the seal', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'working', interrupted: true, usage: tokens(100, 30, 900) });
  const noise = assistantMessage({ turn: 2, text: 'partial output', interrupted: true });
  const sealed = pricedSeal([ask, before, noise], 8);
  const post = assistantMessage({ turn: 3, text: 'after the seal', usage: tokens(30, 5, 570) });
  const cleared = clear('amber-falcon', { from: ask, to: post });
  const { access } = accessOver([ask, before, noise, ...sealed.events, post, ...cleared.events]);

  const { attempts, handoffs } = await access.rows(SESSION);
  const answer = await access.settlement(SESSION, cleared.payload.seq);
  const settlement = settlementsOf(attempts, handoffs).get(cleared.payload.seq);
  assert.ok(settlement, 'the seal has figures once its before reading is recovered');
  assert.deepEqual(settlement.rows.map(({ before: head, after, cut, saved, cost }) => [head, after, cut, saved, cost]), [[1030, 600, 430, 430, 130]]);
  assert.deepEqual(answer.calls, [{ seq: before.seq, stock: 1000, post: false }, { seq: post.seq, stock: 600, post: true }]);
  const series = seriesOf(settlement.rows, answer.calls);
  assert.deepEqual(series.drawn.map(({ uncompressed }) => uncompressed), [1000, 1030]);
  const chart = stockGeometryOf(series, null, 600, key => key);
  assert.ok(chart.points[1].y > chart.points[0].y, 'actual input stock falls');
  assert.ok(chart.points[1].uncompressedY < chart.points[0].uncompressedY, 'the dashed line rises');
  const raw = { before: null, after: 600, delta: null, miss: 30 };
  assert.deepEqual(attempts[0].contextChange, raw);
  assert.deepEqual((await access.call(SESSION, sealed.start.seq)).row.contextChange, raw);
  assert.equal(paybackOf(attempts, handoffs).get(sealed.start.seq), null, 'the attempt badge does not use the settlement estimate');
});

test('a missing or invalid reading on a retained call blocks the estimate through later interruptions', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'working', usage: tokens(100, 30, 900) });
  const silent = assistantMessage({ text: 'ordinary call without usage' });
  const invalid = assistantMessage({ text: 'reported invalid usage', interrupted: true, usage: { inputTokens: 70 } });
  const noise = assistantMessage({ text: 'partial output', interrupted: true });
  for (const blocker of [silent, invalid]) {
    const sealed = pricedSeal([before, blocker, noise], 8);
    const post = assistantMessage({ text: 'post', usage: tokens(30, 5, 570) });
    const cleared = clear('amber-falcon', { from: ask, to: post });
    const { access } = accessOver([ask, before, blocker, noise, ...sealed.events, post, ...cleared.events]);
    const { attempts, handoffs } = await access.rows(SESSION);
    assert.equal(settlementsOf(attempts, handoffs).has(cleared.payload.seq), false, 'the cut remains unknown');
    const { calls } = await access.settlement(SESSION, cleared.payload.seq);
    assert.deepEqual(calls, [{ seq: before.seq, stock: 1000, post: false }, { seq: blocker.seq, stock: null, post: false }, { seq: post.seq, stock: 600, post: true }]);
  }
});

test('a retained call does not stand in for the usage of an excluded post, but takes its chart mark', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'working', usage: tokens(100, 30, 900) });
  const sealed = pricedSeal([ask, before], 8);
  const noise = assistantMessage({ text: 'partial post', interrupted: true });
  const next = assistantMessage({ text: 'ordinary call without usage' });
  const tail = assistantMessage({ text: 'tail', usage: tokens(30, 5, 570) });
  const cleared = clear('amber-falcon', { from: ask, to: tail });
  const { access } = accessOver([ask, before, ...sealed.events, noise, next, tail, ...cleared.events]);
  const { attempts, handoffs } = await access.rows(SESSION);

  assert.deepEqual(attempts[0].contextChange, { before: 1030, after: null, delta: null, miss: null });
  assert.equal(handoffs[0].tailCalls, 3, 'the excluded call still counts toward steps');
  assert.deepEqual((await access.settlement(SESSION, cleared.payload.seq)).calls, [
    { seq: before.seq, stock: 1000, post: false }, { seq: next.seq, stock: null, post: true }, { seq: tail.seq, stock: 600, post: false },
  ]);
});

test('an estimate and an excluded post mark stop at a carrier or an epoch boundary', async () => {
  const ask = userMessage({ text: 'please work' });
  const before = assistantMessage({ text: 'working', usage: tokens(100, 30, 900) });
  const first = pricedSeal([ask, before], 8);
  const noise = assistantMessage({ text: 'partial post', interrupted: true });
  const second = pricedSeal([noise], 8);
  const post = assistantMessage({ text: 'measured', usage: tokens(30, 5, 570) });
  const cleared = clear('amber-falcon', { from: ask, to: post });
  const newNoise = assistantMessage({ text: 'partial head', interrupted: true });
  const third = pricedSeal([newNoise], 8);
  const next = assistantMessage({ text: 'new measured', usage: tokens(10, 1, 420) });
  const clearedNext = clear('copper-heron', { from: newNoise, to: next });
  const { access } = accessOver([ask, before, ...first.events, noise, ...second.events, post, ...cleared.events, newNoise, ...third.events, next, ...clearedNext.events]);
  const { attempts, handoffs } = await access.rows(SESSION);

  assert.equal(settlementsOf(attempts, handoffs).size, 0, 'no before reading can be borrowed from another sealing round or epoch');
  assert.deepEqual((await access.settlement(SESSION, cleared.payload.seq)).calls, [
    { seq: before.seq, stock: 1000, post: false }, { seq: post.seq, stock: 600, post: true },
  ]);
  assert.deepEqual((await access.settlement(SESSION, clearedNext.payload.seq)).calls, [{ seq: next.seq, stock: 430, post: true }]);
});

test('a carrier no main call follows in its segment gives no mark, and the calls behind it in the next segment do not fill it', async () => {
  const ask = userMessage({ text: 'please work' });
  const one = assistantMessage({ text: 'one', usage: tokens(100, 20, 300, 40) });
  const two = assistantMessage({ text: 'two', usage: tokens(10, 1, 400) });
  const sealed = seal([ask, one, two]);
  const cleared = clear('amber-falcon', { from: ask, to: two });
  const next = assistantMessage({ text: 'next', usage: tokens(7, 7, 7) });

  const answer = await accessOver([ask, one, two, ...sealed.events, ...cleared.events, next]).access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual(answer.calls, [{ seq: one.seq, stock: 440, post: false }, { seq: two.seq, stock: 410, post: false }]);
});

test('a segment with no main call settles an empty list', async () => {
  const ask = userMessage({ text: 'please work' });
  const cleared = clear('amber-falcon', { from: ask, to: ask });

  assert.deepEqual((await accessOver([ask, ...cleared.events]).access.settlement(SESSION, cleared.payload.seq)).calls, []);
});

test('a call whose usage the monitor reads as none has no stock, whether it reports none or reports one that is not valid', async () => {
  const ask = userMessage({ text: 'please work' });
  const none = assistantMessage({ text: 'none' });
  const invalid = assistantMessage({ text: 'invalid', usage: { inputTokens: 5 } });
  const valid = assistantMessage({ text: 'valid', usage: tokens(5, 1, 20, 10) });
  const cleared = clear('amber-falcon', { from: ask, to: valid });

  const { calls } = await accessOver([ask, none, invalid, valid, ...cleared.events]).access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual(calls.map(call => call.stock), [null, null, 35]);
});

test('each continue settles the segment before its own clear: the epoch it names less one, the posts of that segment alone', async () => {
  const first = firstSegment();
  const clearedFirst = clear('amber-falcon', { from: first.ask, to: first.six });
  const askAgain = userMessage({ text: 'go on' });
  const head = assistantMessage({ text: 'head', usage: tokens(300, 50, 9000, 400) });
  const sealed = seal([askAgain, head]);
  const post = assistantMessage({ text: 'post', usage: tokens(20, 2, 5000) });
  const tail = assistantMessage({ text: 'tail', usage: tokens(1, 1, 5100) });
  const clearedSecond = clear('copper-heron', { from: askAgain, to: tail, handoffId: 8 });
  const last = assistantMessage({ text: 'last', usage: tokens(3, 3, 3) });
  const { access } = accessOver([...first.events, ...clearedFirst.events, askAgain, head, ...sealed.events, post, tail, ...clearedSecond.events, last]);

  const { handoffs } = await access.rows(SESSION);
  assert.deepEqual(handoffs.map(row => [row.id, row.type, row.epoch]), [[clearedFirst.payload.seq, 'continue', 1], [clearedSecond.payload.seq, 'continue', 2]]);

  assert.deepEqual((await access.settlement(SESSION, clearedFirst.payload.seq)).calls, callsOf(first, [first.postOne, first.postThree]));
  assert.deepEqual((await access.settlement(SESSION, clearedSecond.payload.seq)).calls, [
    { seq: head.seq, stock: 9700, post: false },
    { seq: post.seq, stock: 5020, post: true },
    { seq: tail.seq, stock: 5101, post: false },
  ]);
});

test('an attempt belongs to the segment it began in, so a carrier that lands after the clear marks the call behind it in no settlement of the next segment', async () => {
  const ask = userMessage({ text: 'please work' });
  const one = assistantMessage({ text: 'one', usage: tokens(100, 20, 300, 40) });
  const began = innerAttempt({ range: [ask.seq, one.seq] });
  const firstClear = clear('amber-falcon', { from: ask, to: one });
  const call = innerCall({ range: [ask.seq, one.seq], attempt: began.seq, endedAt: 1_700_000_100_000 });
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, ask.seq, one.seq], slots: [{ seqs: [ask.seq], text: 'summary' }] });
  const behind = assistantMessage({ text: 'behind', usage: tokens(30, 3, 900) });
  const secondClear = clear('copper-heron', { from: ask, to: behind, handoffId: 8 });
  const { access } = accessOver([ask, one, began, ...firstClear.events, call, carrier, behind, ...secondClear.events]);

  const { attempts } = await access.rows(SESSION);
  assert.deepEqual(attempts.map(row => [row.id, row.status, row.epoch]), [[began.seq, 'committed', 0]], 'precondition: the attempt began before the first clear and committed after it');

  assert.deepEqual((await access.settlement(SESSION, secondClear.payload.seq)).calls, [{ seq: behind.seq, stock: 930, post: false }]);
  const closed = await access.settlement(SESSION, firstClear.payload.seq);
  assert.deepEqual(closed.calls, [{ seq: one.seq, stock: 440, post: false }]);
  assert.deepEqual(closed.attempts.map(row => [row.id, row.status]), [[began.seq, 'unknown']], 'the seal committed after the clear is an attempt in flight in the segment as it ended');
});

test('a load clears no segment and a handoff the monitor does not hold names none: both are failures of the read, and a session neither held nor stored answers undefined', async () => {
  const ask = userMessage({ text: 'please work' });
  const call = assistantMessage({ text: 'one', usage: tokens(1, 1) });
  const load = loadPayload({ token: 'copper-heron', handoffId: 8 });
  const cleared = clear('amber-falcon', { from: ask, to: call });
  const { access, reads } = accessOver([ask, call, load, ...cleared.events]);

  await assert.rejects(access.settlement(SESSION, load.seq), { message: `the handoff ${load.seq} is no /sw-continue clear` });
  await assert.rejects(access.settlement(SESSION, 9999), { message: 'the inner monitor holds no handoff 9999' });
  assert.equal(reads.held, 0, 'the log is read for a clear alone');
  assert.deepEqual((await access.settlement(SESSION, cleared.payload.seq)).calls.map(entry => entry.seq), [call.seq]);
  assert.equal(await access.settlement('s-elsewhere', cleared.payload.seq), undefined);
});

test('a session the host holds none of answers from its stored log as a held one does, one read of its source for the request', async () => {
  const first = firstSegment();
  const cleared = clear('amber-falcon', { from: first.ask, to: first.six });
  const events = [...first.events, ...cleared.events, assistantMessage({ text: 'resumed', usage: tokens(300, 50, 9000, 400) })];
  const held = accessOver(events);
  const stored = accessOver(events, { held: false });

  const fromHeld = await held.access.settlement(SESSION, cleared.payload.seq);
  const fromStored = await stored.access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual(fromStored, fromHeld);
  assert.equal(fromStored.calls.length, 6);
  assert.deepEqual([held.reads.held, held.reads.stored], [1, 0]);
  assert.deepEqual([stored.reads.held, stored.reads.stored], [0, 1]);
  assert.equal(await stored.access.settlement('s-elsewhere', cleared.payload.seq), undefined);
  await assert.rejects(stored.access.settlement(SESSION, 9999), { message: 'the inner monitor holds no handoff 9999' });
});

// ── The two counts of a cleared segment ──────────────────────────────────────

// The composed watcher over `events`, as a session that is installed whole: its history, and the monitor's rows over the same log.
async function measuredOver(events) {
  const store = openStore(':memory:');
  try {
    const { watcher } = composeWatcher({
      sessionId: SESSION, cwd: '/repo', store, turnNotesRoot: join(tmpdir(), 'sw-dsh-settlement-notes'),
      readSession: async () => ({ events }), isIgnored: null, cacheTtl: () => null,
    });
    const driver = createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} });
    watcher.applyHarnessFrame(driver.install(events));
    const { access } = accessOver(events);
    return { history: watcher.getHistory(), access, rows: await access.rows(SESSION) };
  } finally {
    closeStore(store);
  }
}

// Two segments of twenty calls whose cached reads grow, each holding one seal, behind two clears and a short open tail: a log whose segments close on a fit past the left arm.
function sealedSegments() {
  const events = [];
  const calls = (name, first, step, accrual, sealAt, sealRange, fresh) => {
    const made = [];
    let read = first;
    for (let index = 0; index < 20; index += 1) {
      read += step + index * accrual;
      const call = assistantMessage({ text: `${name}${index}`, usage: tokens(fresh(index), 5, read, index % 4 === 0 ? 300 : 0) });
      made.push(call);
      events.push(call);
      if (index === sealAt) events.push(...seal(made.slice(...sealRange)).events);
    }
    return made;
  };
  const ask = userMessage({ text: 'work' });
  events.push(ask);
  const first = calls('c', 1000, 1200, 300, 12, [2, 6], index => 10 + index);
  events.push(...clear('amber-falcon', { from: ask, to: first.at(-1) }).events);
  const askAgain = userMessage({ text: 'again' });
  events.push(askAgain);
  const second = calls('d', 2000, 1500, 250, 14, [3, 8], () => 5);
  events.push(...clear('copper-heron', { from: askAgain, to: second.at(-1), handoffId: 8 }).events);
  for (let index = 0; index < 3; index += 1) events.push(assistantMessage({ text: `e${index}`, usage: tokens(3, 3, 3000 + index * 500) }));
  return events;
}

// The history a composed watcher holds once `events` have entered it through the source driver, whole at once (`install`) or one event after another behind an empty install, where each seal rewrites the open epoch and rebuilds the measurement; `rebuilds` counts those rebuilds.
function historiesOf(events) {
  const open = () => {
    const store = openStore(':memory:');
    const { watcher } = composeWatcher({
      sessionId: SESSION, cwd: '/repo', store, turnNotesRoot: join(tmpdir(), 'sw-dsh-settlement-notes'),
      readSession: async () => ({ events }), isIgnored: null, cacheTtl: () => null,
    });
    return { store, watcher, driver: createDshSourceDriver({ sessionId: SESSION, onDiagnostics: () => {} }) };
  };
  const whole = open();
  const live = open();
  try {
    whole.watcher.applyHarnessFrame(whole.driver.install(events));
    live.watcher.applyHarnessFrame(live.driver.install([]));
    live.driver.drain();
    let rebuilds = 0;
    for (const event of events) {
      const frame = live.driver.feed(event);
      if (frame === null) continue;
      if (frame.transition === 'replace') rebuilds += 1;
      live.watcher.applyHarnessFrame(frame);
    }
    return { whole: whole.watcher.getHistory(), live: live.watcher.getHistory(), rebuilds };
  } finally {
    closeStore(whole.store);
    closeStore(live.store);
  }
}

test('a session fed event by event, its seals rebuilding the measurement, ends each closed segment on the same amber line as the same log installed whole', () => {
  const { whole, live, rebuilds } = historiesOf(sealedSegments());
  const annotated = history => history.filter(point => Object.hasOwn(point, 'amberStockL')).map(point => [point.segment, point.foldedSeq, point.amberStockL]);

  assert.ok(rebuilds >= 2, 'precondition: each seal rebuilt the measurement');
  assert.deepEqual(annotated(whole).map(([segment]) => segment), [0, 1]);
  assert.ok(annotated(whole).every(([, , line]) => Number.isFinite(line)), 'precondition: both segments close on a fit that draws a line');
  assert.deepEqual(annotated(live), annotated(whole));
});

test('the segment a settlement names is the Engine\'s segment one less than its epoch: the last point of exactly that segment carries the amber line, and it is the last call the settlement lists', async () => {
  const first = firstSegment();
  const clearedFirst = clear('amber-falcon', { from: first.ask, to: first.six });
  const askAgain = userMessage({ text: 'go on' });
  const head = assistantMessage({ text: 'head', usage: tokens(300, 50, 9000, 400) });
  const sealed = seal([askAgain, head]);
  const post = assistantMessage({ text: 'post', usage: tokens(20, 2, 5000) });
  const tail = assistantMessage({ text: 'tail', usage: tokens(1, 1, 5100) });
  const clearedSecond = clear('copper-heron', { from: askAgain, to: tail, handoffId: 8 });
  const last = assistantMessage({ text: 'last', usage: tokens(3, 3, 3) });
  const events = [...first.events, ...clearedFirst.events, askAgain, head, ...sealed.events, post, tail, ...clearedSecond.events, last];

  const { history, access, rows } = await measuredOver(events);
  // The rows' own `epoch` and ids stand; the figures a settlement needs of a committed compaction, which the stub kit cannot read from a stream, are given.
  const attempts = rows.attempts.map(row => (row.status === 'committed'
    ? { ...row, cRatio: 10, call: { ...row.call, usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 } }, contextChange: { before: 9000, after: 3000, delta: -6000, miss: 200 } }
    : row));
  const settlements = [...settlementsOf(attempts, rows.handoffs).entries()];

  assert.deepEqual(settlements.map(([id]) => id), [clearedFirst.payload.seq, clearedSecond.payload.seq]);
  assert.deepEqual(history.map(point => point.segment).filter((segment, index, all) => all.indexOf(segment) === index), [0, 1, 2], 'precondition: the history spans three segments');
  for (const [id, { epoch }] of settlements) {
    const segment = history.filter(point => point.segment === epoch - 1);
    const { calls } = await access.settlement(SESSION, id);
    assert.ok(segment.length > 0, `epoch ${epoch}`);
    assert.deepEqual(segment.map(point => Object.hasOwn(point, 'amberStockL')), segment.map((_, index) => index === segment.length - 1), `epoch ${epoch}: the closed segment's last point alone`);
    assert.equal(segment.at(-1).L, calls.at(-1).stock, `epoch ${epoch}: that point is the last call the settlement lists`);
  }
  assert.ok(history.filter(point => point.segment === 2).every(point => !Object.hasOwn(point, 'amberStockL')), 'the open segment is annotated nowhere');
});
