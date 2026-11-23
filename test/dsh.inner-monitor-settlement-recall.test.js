// The recall activity of a segment's settlement: which original events pure recall steps after the first seal read back, where on the settlement axis each stands, and the counts a share of pure recall steps rests on.
// Each log is built to the shapes DSH writes (`test/helpers/dsh-events.js`); the cut a read makes is the monitor's, and the closed and current reads of one segment answer alike.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRpcHandler } from '../dsh/src/rpc.js';
import { ordinalsOf, settlementForSegment } from '../public/lib/compactionEconomics.js';
import {
  innerAttempt, innerCall, innerSealCarrier, systemMessage, userMessage,
} from './helpers/dsh-events.js';
import { createMonitorAccess } from '../dsh/src/inner-monitor-read.js';
import {
  SESSION, accessOver, fold, kit, clear, failedSeal, pricedSeal, readCall, stepOf, tokens,
} from './helpers/dsh-settlement.js';

// Step 1 of turn 1 admits the task and answers it with a file read, and a seal sums that step up: the settlement's first range, `#0`. Everything a test adds comes after it.
function opening() {
  const readFile = { id: 'file', name: 'read', arguments: JSON.stringify({ file_path: 'a.js' }) };
  const head = stepOf({ turn: 1, step: 1, admit: ['please work'], calls: [readFile], text: 'working', usage: tokens(100, 30, 900), answer: 'file text' });
  const [ask] = head.admitted;
  const sealed = pricedSeal([ask, head.request], 1);
  return { head, ask, sealed, events: [...head.events, ...sealed.events] };
}

const current = events => accessOver(events).currentSettlement(SESSION);

test('a pure recall step after the first seal makes a target row at the original event\'s own step with one read, and counts once among the judged steps', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('r1', ask.seq)] });
  const resumed = stepOf({ turn: 2, step: 2, text: 'resume' });

  const { activity } = await current([...events, ...recall.events, ...resumed.events]);

  assert.deepEqual(activity, {
    covered: true, judged: 2, pure: 1,
    targets: [{ seq: ask.seq, type: 'user/message', at: 1, reads: [{ at: 2, seq: recall.request.seq }] }],
  });
});

test('two reads of one target in one step are one read, and two targets of one step each have it as a read while the step counts once', async () => {
  const { head, ask, events } = opening();
  const recall = stepOf({
    turn: 2, step: 1,
    calls: [readCall('a', ask.seq), readCall('b', ask.seq, { name: 'session_event_read' }), readCall('c', head.request.seq, { sessionId: SESSION })],
  });

  const { activity } = await current([...events, ...recall.events]);

  assert.equal(activity.pure, 1);
  assert.equal(activity.judged, 1);
  assert.deepEqual(activity.targets.map(({ seq, at, reads }) => [seq, at, reads]), [
    [ask.seq, 1, [{ at: 2, seq: recall.request.seq }]],
    [head.request.seq, 1, [{ at: 2, seq: recall.request.seq }]],
  ]);
});

test('the same target read after a later seal shows both reads on its row; the second seal is a line of the axis and the read after it a step of its own', async () => {
  const { ask, events } = opening();
  const first = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const plain = stepOf({ turn: 2, step: 2, text: 'between' });
  const second = pricedSeal([...first.events, ...plain.events], 2);
  const again = stepOf({ turn: 3, step: 1, calls: [readCall('b', ask.seq)] });

  const answer = await current([...events, ...first.events, ...plain.events, ...second.events, ...again.events]);

  assert.deepEqual(answer.activity, {
    covered: true, judged: 3, pure: 2,
    targets: [{ seq: ask.seq, type: 'user/message', at: 1, reads: [{ at: 2, seq: first.request.seq }, { at: 4, seq: again.request.seq }] }],
  });
});

test('a mixed request is a judged step that is not pure and makes no target, and a step with no tools is judged the same way', async () => {
  const { ask, events } = opening();
  const mixed = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq), { id: 'b', name: 'read', arguments: JSON.stringify({ file_path: 'b.js' }) }] });
  const plain = stepOf({ turn: 2, step: 2, text: 'plain' });

  const { activity } = await current([...events, ...mixed.events, ...plain.events]);

  assert.deepEqual(activity, { covered: true, judged: 2, pure: 0, targets: [] });
});

test('a refused read still is an initiation, and one DSH logged as aborted before dispatch is not', async () => {
  const { ask, events } = opening();
  const refused = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)], isError: true, answer: 'Error: already in your context' });
  const skipped = stepOf({
    turn: 2, step: 2, calls: [readCall('b', ask.seq)], isError: true, answer: 'Error: tool call aborted before dispatch',
    error: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
  });

  const answer = await current([...events, ...refused.events, ...skipped.events]);

  assert.deepEqual(answer.activity, {
    covered: true, judged: 2, pure: 1,
    targets: [{ seq: ask.seq, type: 'user/message', at: 1, reads: [{ at: 2, seq: refused.request.seq }] }],
  });
  assert.deepEqual(answer.recall.steps.map(step => step.seq), [refused.request.seq], 'the request of the skipped call is no recall request either');
});

test('a read of another segment\'s event or another session\'s, one to an event not yet written and a read of no event are judged steps with no target', async () => {
  const earlier = userMessage({ text: 'previous segment' });
  const before = clear('previous', { from: earlier, to: earlier });
  const { ask, events } = opening();
  const elsewhere = stepOf({ turn: 2, step: 1, calls: [readCall('a', earlier.seq)] });
  const other = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq, { sessionId: 'another-session' })] });
  const future = stepOf({ turn: 2, step: 3, calls: [readCall('c', 99_999)] });
  const bare = stepOf({ turn: 2, step: 4, calls: [{ id: 'd', name: 'sw_event_read', arguments: '{' }] });

  const { activity } = await current([earlier, ...before.events, ...events, ...elsewhere.events, ...other.events, ...future.events, ...bare.events]);

  assert.deepEqual(activity, { covered: true, judged: 4, pure: 0, targets: [] });
});

test('an unanswered request nobody dispatched is unknown and counts in no denominator, while one the loop never started is a step that was not a recall', async () => {
  const { ask, events } = opening();
  const flying = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)], dispatch: false, results: false });
  const unstarted = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)], dispatch: false, isError: true, answer: 'Error: not started' });
  const read = stepOf({ turn: 2, step: 3, calls: [readCall('c', ask.seq)] });

  const { activity } = await current([...events, ...flying.events, ...unstarted.events, ...read.events]);

  assert.deepEqual(activity, {
    covered: true, judged: 2, pure: 1,
    targets: [{ seq: ask.seq, type: 'user/message', at: 1, reads: [{ at: 4, seq: read.request.seq }] }],
  });
});

test('a recall inside the first seal\'s range is before it and shows nowhere, and a share needs the steps after it', async () => {
  const ask = userMessage({ text: 'task' });
  const early = stepOf({ turn: 1, step: 1, calls: [readCall('a', ask.seq)] });
  const sealed = pricedSeal([ask, ...early.events], 1);

  const { activity, recall } = await current([ask, ...early.events, ...sealed.events]);

  assert.deepEqual(activity, { covered: true, judged: 0, pure: 0, targets: [] });
  assert.equal(recall, undefined);
});

test('a range whose counted steps are not the quote\'s leaves its steps unplaced: the read is observed with no landing, the coverage is not proved and the step is judged nowhere', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const plain = stepOf({ turn: 2, step: 2, text: 'between' });
  const second = pricedSeal([...recall.events, ...plain.events], 5);
  const after = stepOf({ turn: 3, step: 1, text: 'after' });

  const { activity } = await current([...events, ...recall.events, ...plain.events, ...second.events, ...after.events]);

  assert.deepEqual(activity, {
    covered: false, judged: 1, pure: 0,
    targets: [{ seq: ask.seq, type: 'user/message', at: 1, reads: [] }],
  });
});

test('a counted step in no range or tail the report can place leaves the coverage unproved', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const stray = stepOf({ turn: 2, step: 2, text: 'outside the range' });
  const second = pricedSeal(recall.events, 1);
  const after = stepOf({ turn: 3, step: 1, text: 'after' });

  const { activity } = await current([...events, ...recall.events, ...stray.events, ...second.events, ...after.events]);

  assert.equal(activity.covered, false);
});

test('a target stands on the step that owns its event: the step a user message was admitted in, a tool call or result the step ran, a seal at the line it makes; any other event has no landing', async () => {
  const system = systemMessage({ text: 'You are a coding agent.' });
  const readFile = { id: 'file', name: 'read', arguments: JSON.stringify({ file_path: 'a.js' }) };
  const head = stepOf({ turn: 1, step: 1, admit: ['please work'], calls: [readFile], text: 'working', usage: tokens(100, 30, 900), answer: 'file text' });
  const [ask] = head.admitted;
  const [fileCall] = head.dispatched;
  const [fileResult] = head.answers;
  const loose = userMessage({ text: 'typed between two steps' });
  const first = pricedSeal([ask, head.request], 1);
  const probe = stepOf({ turn: 2, step: 1, calls: [readCall('a', fileResult.seq)] });
  const second = pricedSeal(probe.events, 1);
  const aside = stepOf({
    turn: 3, step: 1, calls: [readCall('b', loose.seq), readCall('c', system.seq), readCall('d', second.carrier.seq), readCall('e', fileCall.seq), readCall('f', ask.seq)],
  });

  const { activity } = await current([system, ...head.events, loose, ...first.events, ...probe.events, ...second.events, ...aside.events]);

  assert.deepEqual(activity.targets.map(({ seq, type, at }) => [seq, type, at]), [
    [system.seq, 'system/message', null],
    [ask.seq, 'user/message', 1],
    [fileCall.seq, 'tool/call', 1],
    [fileResult.seq, 'tool/result', 1],
    [loose.seq, 'user/message', null],
    [second.carrier.seq, 'user/message', 2],
  ]);
  const readsOf = seq => activity.targets.find(each => each.seq === seq).reads.map(({ at }) => at);
  assert.deepEqual([readsOf(fileResult.seq), readsOf(fileCall.seq)], [[2], [3]], 'the probe read the result and the step after the second seal the rest');
});

test('the closed read of a segment answers what the current read of its last moment did, whatever came after the clear', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const second = pricedSeal(recall.events, 1);
  const resumed = stepOf({ turn: 2, step: 2, calls: [readCall('b', ask.seq)] });
  const segment = [...events, ...recall.events, ...second.events, ...resumed.events];
  // An attempt that began in the segment and whose call and carrier land after the clear belongs to no settlement of the segment as it ended.
  const began = innerAttempt({ range: resumed.events.map(event => event.seq) });
  const before = await current([...segment, began]);

  const cleared = clear('amber-falcon', { from: ask, to: resumed.request });
  const call = innerCall({ range: resumed.events.map(event => event.seq), attempt: began.seq, endedAt: 1_700_000_100_000 });
  const carrier = innerSealCarrier({ sourceEventSeqs: [call.seq, ...resumed.events.map(event => event.seq)], slots: [{ seqs: [resumed.request.seq], text: 'summary' }] });
  const next = stepOf({ turn: 3, step: 1, admit: ['a new task'], text: 'new segment' });
  const lateRead = stepOf({ turn: 3, step: 2, calls: [readCall('c', next.admitted[0].seq)] });
  const lateSeal = pricedSeal(next.events, 1);
  const after = await accessOver([...segment, began, ...cleared.events, call, carrier, ...next.events, ...lateRead.events, ...lateSeal.events]).settlement(SESSION, cleared.payload.seq);

  assert.equal(before.activity.pure, 2, 'precondition: the segment holds recall');
  assert.deepEqual(before.attempts.map(row => row.status), ['committed', 'committed', 'unknown'], 'precondition: two seals priced and the one in flight');
  assert.deepEqual(after, before);
});

test('a clear whose count of tail calls is not what the log shows leaves the tail unplaced and the coverage unproved', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  // A carrier that is no attempt's of the monitor ends the calls its count holds, so the clear counts none behind it where the log shows one after the last seal.
  const foreign = innerSealCarrier({ sourceEventSeqs: [recall.request.seq] });
  const cleared = clear('amber-falcon', { from: ask, to: recall.request });

  const answer = await accessOver([...events, ...recall.events, foreign, ...cleared.events]).settlement(SESSION, cleared.payload.seq);

  assert.equal(answer.tailCalls, 0);
  assert.deepEqual(answer.activity, { covered: false, judged: 0, pure: 0, targets: [{ seq: ask.seq, type: 'user/message', at: 1, reads: [] }] });
});

test('tail steps the clear counts and the log does not show are steps nobody placed, so the coverage is not proved though every step the log shows is', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const second = pricedSeal(recall.events, 1);
  const cleared = clear('amber-falcon', { from: ask, to: recall.request });
  const log = [...events, ...recall.events, ...second.events, ...cleared.events];
  const state = fold(log);
  state.handoffs = state.handoffs.map(handoff => ({ ...handoff, tailCalls: 2 }));
  const access = createMonitorAccess({
    sessionOf: () => ({}), readMonitor: () => state, live: () => [], kit, readSession: async () => ({ events: log }), readStored: async () => undefined, nextTaskOf: () => null,
  });

  const answer = await access.settlement(SESSION, cleared.payload.seq);

  assert.deepEqual([answer.tailCalls, answer.activity.covered, answer.activity.pure], [2, false, 1]);
  assert.deepEqual((await accessOver(log).settlement(SESSION, cleared.payload.seq)).activity.covered, true, 'the count the log gives is proved');
});

test('the answer names its cut: the segment and the last event it read', async () => {
  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });

  const answer = await current([...events, ...recall.events]);

  assert.deepEqual(answer.cut, { segment: 0, through: recall.end.seq });
});

test('a segment with no committed seal has no activity, and a held session answers as a stored one', async () => {
  const plain = stepOf({ turn: 1, step: 1, text: 'only' });
  const answer = await accessOver(plain.events).currentSettlement(SESSION);
  assert.equal(answer.activity, undefined);
  assert.equal(answer.recall, undefined);

  const { ask, events } = opening();
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const held = await accessOver([...events, ...recall.events], { held: true }).currentSettlement(SESSION);
  assert.equal(held.activity.pure, 1);
});

test('a failed seal is no line of the axis, but it keeps its place among the attempts, so a compaction has the ordinal the list gives it', async () => {
  const { ask, events } = opening();
  const lost = failedSeal([ask]);
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq)] });
  const second = pricedSeal(recall.events, 1);
  const log = [...events, ...lost.events, ...recall.events, ...second.events];

  const answer = await current(log);
  const { attempts: rows, handoffs } = await accessOver(log).rows(SESSION);

  assert.deepEqual(answer.attempts.map(row => row.status), ['committed', 'failed', 'committed']);
  assert.deepEqual(settlementForSegment(answer.attempts, { epoch: 1, tailCalls: answer.tailCalls }).rows.map(row => row.ordinal), [1, 3]);
  assert.deepEqual(Object.values(ordinalsOf(rows)).map(({ ordinal }) => ordinal), [1, 2, 3], 'the list\'s own');
  assert.deepEqual(answer.activity.targets.map(({ at, reads }) => [at, reads.map(read => read.at)]), [[1, [2]]]);
  assert.deepEqual(handoffs, []);
});

// ── The text of one target ───────────────────────────────────────────────────

const OWNER = { principal: { kind: 'owner' } };
const askedAs = (handler, peer, body) => handler('inner-monitor/settlement/target', { sessionId: SESSION, ...body }, new AbortController().signal, peer);
const refused = (code, message) => ({ ok: false, error: { code, message, details: {} } });

// A segment whose second step recalls the task and the file result, over the access the handler answers from.
function recalling() {
  const { head, ask, events } = opening();
  const [, fileResult] = [head.dispatched[0], head.answers[0]];
  const recall = stepOf({ turn: 2, step: 1, calls: [readCall('a', ask.seq), readCall('b', head.dispatched[0].seq)] });
  const log = [...events, ...recall.events];
  const reads = [];
  const access = accessOver(log);
  const spy = { ...access, settlementTarget: (...args) => { reads.push(args); return access.settlementTarget(...args); } };
  return { head, ask, fileResult, recall, log, reads, handler: createRpcHandler({ innerMonitor: () => spy }), access };
}

test('the owner reads the text of a target at the cut an answer named, the text of that event alone: not its result, its neighbors, the request that read it or the summary', async () => {
  const { ask, fileResult, recall, handler, access } = recalling();
  const { cut } = await access.currentSettlement(SESSION);

  assert.deepEqual(await askedAs(handler, OWNER, { ...cut, seq: ask.seq }), { ok: true, value: { seq: ask.seq, type: 'user/message', text: 'please work' } });
  const notRecalled = refused('inner_monitor_not_recalled', 'The event is not a recall target of this settlement at this cut.');
  for (const [seq, why] of [[recall.dispatched[0].seq, 'the dispatch of the recall'], [recall.answers[0].seq, 'what the read returned'], [recall.request.seq, 'the request that read'], [fileResult.seq, 'a result nobody read back']]) {
    assert.deepEqual(await askedAs(handler, OWNER, { ...cut, seq }), notRecalled, why);
  }
});

test('a target that holds no text answers null, never a record, a call or a neighbor', async () => {
  const { head, handler, access } = recalling();
  const { cut } = await access.currentSettlement(SESSION);

  assert.deepEqual(await askedAs(handler, OWNER, { ...cut, seq: head.dispatched[0].seq }), { ok: true, value: { seq: head.dispatched[0].seq, type: 'tool/call', text: null } });
});

test('only the owner reads a target and the access is not consulted for any other peer: another kind, none, and a peer that carries its kind outside the principal', async () => {
  const { ask, reads, handler, access } = recalling();
  const { cut } = await access.currentSettlement(SESSION);
  const forbidden = refused('forbidden', 'Only the owner of this host can read the text of a recalled event.');

  for (const peer of [{ principal: { kind: 'operator' } }, { principal: { kind: 'guest' } }, { kind: 'owner' }, { principal: {} }, null, undefined]) {
    assert.deepEqual(await askedAs(handler, peer, { ...cut, seq: ask.seq }), forbidden, JSON.stringify(peer));
    assert.deepEqual(await askedAs(handler, peer, undefined), forbidden, 'the peer is checked before the body');
    for (const payload of [undefined, null, {}, { sessionId: 7 }]) assert.deepEqual(await handler('inner-monitor/settlement/target', payload, undefined, peer), forbidden, `before the session is named: ${JSON.stringify(payload)}`);
  }
  assert.deepEqual(reads, []);
});

test('the body names a session, the cut and the event, each an address, and the access is not consulted for a body that does not', async () => {
  const { ask, reads, handler, access } = recalling();
  const { cut } = await access.currentSettlement(SESSION);
  const body = { ...cut, seq: ask.seq };

  assert.deepEqual(await handler('inner-monitor/settlement/target', undefined, undefined, OWNER), refused('invalid_body', 'Body must contain { sessionId: string }'));
  for (const name of ['segment', 'through', 'seq']) {
    for (const value of [undefined, null, '1', -1, 1.5, Number.NaN, true]) {
      assert.deepEqual(await askedAs(handler, OWNER, { ...body, [name]: value }), refused('invalid_body', 'Body must contain { sessionId: string, segment: non-negative integer, through: non-negative integer, seq: non-negative integer }'), `${name} ${String(value)}`);
    }
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(await handler('inner-monitor/settlement/target', { ...body, sessionId: 's-elsewhere' }, undefined, OWNER), refused('inner_monitor_unavailable', 'The inner compaction monitor is not available in this host.'));
});

test('a target is read at the cut the answer named: a read after it, another segment and a cut the segment never had confirm none, and the log running on changes nothing', async () => {
  const { ask, head, recall, log } = recalling();
  const before = await accessOver(log).currentSettlement(SESSION);
  const later = stepOf({ turn: 2, step: 2, calls: [readCall('c', head.answers[0].seq)] });
  const grown = accessOver([...log, ...later.events]);
  const handler = createRpcHandler({ innerMonitor: () => grown });
  const notRecalled = refused('inner_monitor_not_recalled', 'The event is not a recall target of this settlement at this cut.');

  assert.equal((await askedAs(handler, OWNER, { ...before.cut, seq: ask.seq })).ok, true, 'a read before the cut');
  assert.deepEqual(await askedAs(handler, OWNER, { ...before.cut, seq: head.answers[0].seq }), notRecalled, 'the result the later step read is no target of the earlier cut');
  assert.equal((await askedAs(handler, OWNER, { segment: 0, through: later.end.seq, seq: head.answers[0].seq })).ok, true, 'it is of the later one');
  assert.deepEqual(await askedAs(handler, OWNER, { ...before.cut, segment: 1, seq: ask.seq }), notRecalled, 'another segment');
  assert.deepEqual(await askedAs(handler, OWNER, { ...before.cut, through: 0, seq: ask.seq }), notRecalled, 'a cut before the recall');
});

test('a failed read of the log is a read failure with one line under the session, never a text', async (t) => {
  const lines = [];
  t.mock.method(process.stderr, 'write', (line) => { lines.push(String(line)); return true; });
  const failing = { settlementTarget: async () => { throw new Error('the stored log is corrupt'); } };
  const handler = createRpcHandler({ innerMonitor: () => failing });

  assert.deepEqual(await askedAs(handler, OWNER, { segment: 0, through: 1, seq: 0 }), refused('inner_monitor_read_failed', 'the stored log is corrupt'));
  assert.equal(lines.some(line => line.includes('inner_monitor_read_failed')), true);
});
