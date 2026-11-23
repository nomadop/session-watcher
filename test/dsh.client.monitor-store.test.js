// The DSH client's monitor stores, `createMonitorStores`, over a channel call the test answers: the rows a session's `inner-monitor` last answered and the detail resources its rows key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitorStores } from '../dsh/src/client/monitor-store.js';
import {
  ok, fail, UNAVAILABLE_REPLY, attemptRow, rowsValue, handoffRow, handoffPayload, callPayload, slotsValue, slotRow, slotValue,
} from './helpers/dsh-monitor-wire.js';

// A macrotask hop drains every pending promise continuation.
const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * A channel call that logs each request and answers `answer(endpoint, payload)`: an Error rejects, anything else resolves.
 * @param {(endpoint: string, payload: object) => unknown} answer
 */
function channel(answer) {
  const log = [];
  return {
    log,
    call(endpoint, payload) {
      log.push({ endpoint, payload });
      const reply = answer(endpoint, payload);
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
}

/**
 * A channel call whose answers the test settles by hand, in any order; `held` lists the requests not answered yet.
 */
function manual() {
  const held = [];
  return {
    held,
    call: (endpoint, payload) => new Promise((resolve, reject) => { held.push({ endpoint, payload, resolve, reject }); }),
  };
}

// Answers the held request at `index` with `reply`, an Error rejecting it, and lets the store's continuations run.
async function settle(host, reply, index = 0) {
  const [request] = host.held.splice(index, 1);
  if (reply instanceof Error) request.reject(reply);
  else request.resolve(reply);
  await flush();
}

test('a rows handle is unread before its first read, reads when subscribed without calling back at once, and holds what its last read answered: the attempts, unavailable for inner_monitor_unavailable, and unreachable with the message for any other failure or a rejection', async () => {
  const attempts = [attemptRow(1), attemptRow(2, { status: 'failed', reason: 'no finish chunk' })];
  const answers = [
    ok(rowsValue(attempts)), UNAVAILABLE_REPLY, fail('inner_monitor_read_failed', 'the log could not be read'), new Error('transport down'), ok(rowsValue([])),
  ];
  const host = channel(() => answers.shift());
  const { rows } = createMonitorStores({ call: host.call }).for('s1');
  assert.equal(rows.result, null);
  const heard = [];
  let unsubscribe = rows.subscribe(result => heard.push(result));
  assert.deepEqual(heard, [], 'a new subscriber reads the result first');
  assert.deepEqual(host.log, [{ endpoint: 'inner-monitor', payload: { sessionId: 's1' } }], 'a subscription reads');
  await flush();
  assert.deepEqual(rows.result, { kind: 'ready', attempts, handoffs: [] });
  const expected = [
    { kind: 'unavailable' },
    { kind: 'unreachable', message: 'the log could not be read' },
    { kind: 'unreachable', message: 'transport down' },
    { kind: 'ready', attempts: [], handoffs: [] },
  ];
  for (const result of expected) {
    unsubscribe();
    unsubscribe = rows.subscribe(() => {});
    await flush();
    assert.deepEqual(rows.result, result);
  }
  assert.deepEqual(heard, [{ kind: 'ready', attempts, handoffs: [] }], 'an unsubscribed listener hears nothing more');
});

test('a success without an attempts list is unreachable and not ready', async () => {
  const host = channel(() => ok({}));
  const { rows } = createMonitorStores({ call: host.call }).for('s1');
  rows.subscribe(() => {});
  await flush();
  assert.equal(rows.result.kind, 'unreachable');
  assert.equal(typeof rows.result.message, 'string');
});

test('for answers the same handles for one session, and a frame reads that session\'s subscribed rows only and an open every subscribed one', async () => {
  const host = channel(() => ok(rowsValue([])));
  const stores = createMonitorStores({ call: host.call });
  assert.equal(stores.for('s1'), stores.for('s1'), 'one store per session');
  assert.notEqual(stores.for('s1'), stores.for('s2'));
  assert.deepEqual(Object.keys(stores.for('s1')).sort(), ['readCurrentSettlement', 'resource', 'rows', 'settlementTarget']);
  const sessionsRead = () => host.log.map(({ payload }) => payload.sessionId);
  const unsubscribe = stores.for('s1').rows.subscribe(() => {});
  stores.for('s2').rows.subscribe(() => {});
  stores.for('s3');
  await flush();
  assert.deepEqual(sessionsRead(), ['s1', 's2'], 'a subscription reads');
  stores.signal('s3');
  stores.signal('s-unknown');
  await flush();
  assert.equal(host.log.length, 2, 'a frame for an unsubscribed or unknown session reads nothing');
  stores.signal('s1');
  await flush();
  assert.deepEqual(sessionsRead().slice(2), ['s1'], 'a frame reads its own session');
  stores.openAll();
  await flush();
  assert.deepEqual(sessionsRead().slice(3), ['s1', 's2'], 'an open reads every subscribed store and no other');
  unsubscribe();
  stores.signal('s1');
  await flush();
  assert.equal(host.log.length, 5, 'a signal without a subscriber is ignored');
});

test('one-shot current settlement reads distinguish an unavailable session, transport failure and incomplete reply', async () => {
  const whole = { epoch: 2, attempts: [], tailCalls: 0, calls: [], cut: { segment: 1, through: 9 }, activity: { covered: true, judged: 0, pure: 0, targets: [] } };
  const answers = [UNAVAILABLE_REPLY, new Error('transport down'), ok({ epoch: 1, attempts: [], tailCalls: 0 }), ok(whole)];
  const host = channel(() => answers.shift());
  const { readCurrentSettlement } = createMonitorStores({ call: host.call }).for('s1');

  assert.deepEqual(await readCurrentSettlement(), { kind: 'unavailable' });
  assert.deepEqual(await readCurrentSettlement(), { kind: 'unreachable', message: 'transport down' });
  assert.equal((await readCurrentSettlement()).kind, 'unreachable', 'a snapshot without its calls cannot be displayed');
  assert.deepEqual(await readCurrentSettlement(), { kind: 'ready', value: whole }, 'the answer whole: the pricing inputs, the calls, the cut and the recall activity, which the two drawers read alike');
});

// ── The text of one recall target ────────────────────────────────────────────

const CUT = { segment: 1, through: 99 };
const textOf = seq => ({ seq, type: 'user/message', text: `text of ${seq}` });

test('a target reader reads nothing until a target is chosen, and asks the host once for each choice, for the session and cut it was made for', async () => {
  const host = manual();
  const reader = createMonitorStores({ call: host.call }).for('s1').settlementTarget(CUT);
  const heard = [];
  reader.subscribe(() => heard.push(reader.state));

  assert.deepEqual(reader.state, { selected: null, result: null });
  assert.deepEqual(host.held, [], 'no choice, no read');
  reader.select(128);
  reader.select(128);

  assert.equal(host.held.length, 1, 'the same choice is one read');
  assert.deepEqual([host.held[0].endpoint, host.held[0].payload], ['inner-monitor/settlement/target', { sessionId: 's1', segment: 1, through: 99, seq: 128 }]);
  assert.deepEqual(reader.state, { selected: 128, result: null }, 'pending');
  await settle(host, ok(textOf(128)));
  assert.deepEqual(reader.state, { selected: 128, result: { kind: 'ready', value: textOf(128) } });
  assert.deepEqual(heard.map(({ selected, result }) => [selected, result?.kind ?? null]), [[128, null], [128, 'ready']]);
});

test('a choice that is made while another is read leaves the answer of the first nowhere, whichever answers first', async () => {
  for (const order of ['first first', 'second first']) {
    const host = manual();
    const reader = createMonitorStores({ call: host.call }).for('s1').settlementTarget(CUT);
    reader.select(1);
    reader.select(2);
    assert.deepEqual(host.held.map(({ payload }) => payload.seq), [1, 2]);

    const [one, two] = host.held.map(({ payload }) => payload.seq);
    for (const seq of order === 'first first' ? [one, two] : [two, one]) await settle(host, ok(textOf(seq)), host.held.findIndex(({ payload }) => payload.seq === seq));

    assert.deepEqual(reader.state, { selected: 2, result: { kind: 'ready', value: textOf(2) } }, order);
  }
});

test('choosing nothing clears the target and its text, and the answer that was in flight applies nothing', async () => {
  const host = manual();
  const reader = createMonitorStores({ call: host.call }).for('s1').settlementTarget(CUT);
  reader.select(5);
  reader.select(null);
  await settle(host, ok(textOf(5)));

  assert.deepEqual(reader.state, { selected: null, result: null });
  assert.equal(host.held.length, 0);
});

test('another cut is another reader: a choice of one is read for its own cut and its answer reaches no other', async () => {
  const host = manual();
  const handles = createMonitorStores({ call: host.call }).for('s1');
  const first = handles.settlementTarget(CUT);
  const second = handles.settlementTarget({ segment: 1, through: 120 });
  const heard = [];
  first.subscribe(() => heard.push('first'));
  second.subscribe(() => heard.push('second'));
  first.select(1);
  second.select(1);
  heard.length = 0;

  assert.deepEqual(host.held.map(({ payload }) => [payload.through, payload.seq]), [[99, 1], [120, 1]]);
  await settle(host, ok({ ...textOf(1), text: 'the later cut' }), 1);
  assert.deepEqual([first.state, heard], [{ selected: 1, result: null }, ['second']], 'the answer of the later cut is the later reader\'s alone');
  assert.equal(second.state.result.value.text, 'the later cut');
  await settle(host, ok(textOf(1)));
  assert.equal(first.state.result.value.text, 'text of 1');
});

test('a read that fails is a result of the choice, never an exception: not the owner, not a target at that cut, an unavailable monitor and a transport failure', async () => {
  const answers = [fail('forbidden', 'Only the owner'), fail('inner_monitor_not_recalled', 'not a target'), UNAVAILABLE_REPLY, new Error('transport down')];
  const host = channel(() => answers.shift());
  const reader = createMonitorStores({ call: host.call }).for('s1').settlementTarget(CUT);
  const kinds = [];
  for (const seq of [1, 2, 3, 4]) {
    reader.select(seq);
    await flush();
    kinds.push(reader.state.result);
  }

  assert.deepEqual(kinds, [
    { kind: 'unreachable', message: 'Only the owner' }, { kind: 'unreachable', message: 'not a target' }, { kind: 'unavailable' }, { kind: 'unreachable', message: 'transport down' },
  ]);
});


test('signals that arrive while a rows read is in flight cost one more read, and the last answer is the latest', async () => {
  const host = manual();
  const stores = createMonitorStores({ call: host.call });
  const { rows } = stores.for('s1');
  const heard = [];
  rows.subscribe(result => heard.push(result));
  for (let frame = 0; frame < 3; frame += 1) stores.signal('s1');
  assert.equal(host.held.length, 1, 'one read in flight');
  await settle(host, ok(rowsValue([attemptRow(1)])));
  assert.equal(host.held.length, 1, 'the signals that arrived meanwhile cost one more read');
  assert.deepEqual(rows.result, { kind: 'ready', attempts: [attemptRow(1)], handoffs: [] });
  await settle(host, ok(rowsValue([attemptRow(1), attemptRow(2)])));
  assert.equal(host.held.length, 0);
  assert.deepEqual(rows.result, { kind: 'ready', attempts: [attemptRow(1), attemptRow(2)], handoffs: [] });
  assert.equal(heard.length, 2, 'the subscriber hears each completed read');
});

test('a rows read in flight when the last subscriber leaves still sets the result and reads nothing more', async () => {
  const host = manual();
  const stores = createMonitorStores({ call: host.call });
  const { rows } = stores.for('s1');
  const unsubscribe = rows.subscribe(() => {});
  stores.signal('s1');
  unsubscribe();
  await settle(host, ok(rowsValue([attemptRow(1)])));
  assert.deepEqual(rows.result, { kind: 'ready', attempts: [attemptRow(1)], handoffs: [] });
  assert.equal(host.held.length, 0);
});

const CALL = 'inner-monitor/call';
const SLOTS = 'inner-monitor/slots';
const SLOT = 'inner-monitor/slot';

/** A host that answers the rows from `attempts()` and each detail endpoint from `details[endpoint](payload)`. */
function hostOf({ attempts, details = {} }) {
  return channel((endpoint, payload) => (endpoint === 'inner-monitor' ? ok(rowsValue(attempts())) : details[endpoint](payload)));
}

test('a resource reads the rows before it reads anything, so that no state is guessed, then its own endpoint with the attempt and slot it names, and holds the endpoint\'s complete payload', async () => {
  const row = attemptRow(7);
  const payloads = { [CALL]: callPayload(row), [SLOTS]: slotsValue([slotRow(31), slotRow(41)]), [SLOT]: slotValue(31) };
  const host = hostOf({
    attempts: () => [row],
    details: { [CALL]: () => ok(payloads[CALL]), [SLOTS]: () => ok(payloads[SLOTS]), [SLOT]: () => ok(payloads[SLOT]) },
  });
  const session = createMonitorStores({ call: host.call }).for('s1');
  const reads = [
    { handle: session.resource({ endpoint: CALL, attempt: 7 }), endpoint: CALL, payload: { sessionId: 's1', attempt: 7 } },
    { handle: session.resource({ endpoint: SLOTS, attempt: 7 }), endpoint: SLOTS, payload: { sessionId: 's1', attempt: 7 } },
    { handle: session.resource({ endpoint: SLOT, attempt: 7, slot: 31 }), endpoint: SLOT, payload: { sessionId: 's1', attempt: 7, slot: 31 } },
  ];
  assert.equal(session.resource({ endpoint: CALL, attempt: 7 }), reads[0].handle, 'one handle for one identity');
  assert.notEqual(session.resource({ endpoint: CALL, attempt: 8 }), reads[0].handle);
  assert.notEqual(session.resource({ endpoint: SLOT, attempt: 7, slot: 41 }), reads[2].handle);

  const [{ handle: call }] = reads;
  assert.equal(call.result, null);
  const heard = [];
  call.subscribe(result => heard.push(result));
  assert.deepEqual(heard, [], 'a new subscriber reads the result first');
  assert.deepEqual(host.log.map(entry => entry.endpoint), ['inner-monitor'], 'the rows come first');
  await flush();
  assert.deepEqual(host.log, [
    { endpoint: 'inner-monitor', payload: { sessionId: 's1' } },
    { endpoint: CALL, payload: { sessionId: 's1', attempt: 7 } },
  ]);
  assert.deepEqual(call.result, { kind: 'ready', value: payloads[CALL] });
  assert.deepEqual(heard, [call.result], 'the subscriber hears the completed read');
  for (const { handle, endpoint, payload } of reads.slice(1)) {
    handle.subscribe(() => {});
    await flush();
    assert.deepEqual(host.log.at(-1), { endpoint, payload });
    assert.deepEqual(handle.result, { kind: 'ready', value: payloads[endpoint] });
  }
});

test('a resource holds unavailable for inner_monitor_unavailable and unreachable with the message for any other failure, a refused uncommitted attempt included, or a rejection', async () => {
  const row = attemptRow(7);
  const answers = [
    UNAVAILABLE_REPLY, fail('inner_monitor_not_committed', 'The inner compaction attempt has no committed seal, so it has no slots.'),
    fail('inner_monitor_read_failed', 'the log could not be read'), new Error('transport down'),
  ];
  const host = hostOf({ attempts: () => [row], details: { [SLOTS]: () => answers.shift() } });
  const detail = createMonitorStores({ call: host.call }).for('s1').resource({ endpoint: SLOTS, attempt: 7 });
  let unsubscribe = detail.subscribe(() => {});
  await flush();
  assert.deepEqual(detail.result, { kind: 'unavailable' });
  for (const expected of [
    { kind: 'unreachable', message: 'The inner compaction attempt has no committed seal, so it has no slots.' },
    { kind: 'unreachable', message: 'the log could not be read' },
    { kind: 'unreachable', message: 'transport down' },
  ]) {
    unsubscribe();
    unsubscribe = detail.subscribe(() => {});
    await flush();
    assert.deepEqual(detail.result, expected);
  }
});

test('a resource whose rows cannot be read stays unread and reads no detail', async () => {
  const host = channel((endpoint) => (endpoint === 'inner-monitor' ? UNAVAILABLE_REPLY : ok({})));
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  detail.subscribe(() => {});
  await flush();
  assert.equal(detail.result, null);
  assert.deepEqual(host.log.map(entry => entry.endpoint), ['inner-monitor']);
  assert.deepEqual(stores.for('s1').rows.result, { kind: 'unavailable' });
});

const readsOf = (host, endpoint) => host.log.filter(entry => entry.endpoint === endpoint).length;

test('a settled attempt\'s detail is read once for its status and revision: a signal, an open and a re-subscription read the rows again and the detail not at all', async () => {
  const row = attemptRow(7);
  const host = hostOf({ attempts: () => [row], details: { [CALL]: () => ok(callPayload(row)) } });
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  let unsubscribe = detail.subscribe(() => {});
  await flush();
  assert.equal(readsOf(host, CALL), 1);
  const snapshot = detail.result;
  stores.signal('s1');
  await flush();
  stores.openAll();
  await flush();
  unsubscribe();
  unsubscribe = detail.subscribe(() => {});
  await flush();
  assert.equal(readsOf(host, CALL), 1, 'the snapshot of the current facts is read once');
  assert.equal(readsOf(host, 'inner-monitor'), 3, 'the signal and the open update the baseline first');
  assert.equal(detail.result, snapshot, 'the cached snapshot is the result still');
});

const heldOf = (host, endpoint) => host.held.filter(request => request.endpoint === endpoint);

// Answers the held request for `endpoint` at `position` among those, the oldest by default.
async function answer(host, endpoint, reply, position = 0) {
  const request = heldOf(host, endpoint)[position];
  assert.ok(request, `a held ${endpoint} request`);
  await settle(host, reply, host.held.indexOf(request));
}

const generating = (id, revision) => attemptRow(id, {
  status: 'generating', revision, endedAt: null, slots: null, call: { state: 'generating', endedAt: null, finish: null, output: null, usage: null },
});

test('an active attempt\'s detail is read again at every signal, open and re-subscription, and the last ready stays the result until the new answer completes', async () => {
  const row = generating(7, 9);
  const host = manual();
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  let unsubscribe = detail.subscribe(() => {});
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  await answer(host, CALL, ok(callPayload(row, { marker: 1 })));
  const first = detail.result;
  assert.deepEqual(first, { kind: 'ready', value: callPayload(row, { marker: 1 }) });

  stores.signal('s1');
  assert.equal(heldOf(host, CALL).length, 0, 'the baseline is updated first');
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  assert.equal(heldOf(host, CALL).length, 1, 'the unchanged facts of an active attempt are read again');
  assert.equal(detail.result, first, 'the last ready stays while the new read is pending');
  await answer(host, CALL, ok(callPayload(row, { marker: 2 })));
  assert.deepEqual(detail.result, { kind: 'ready', value: callPayload(row, { marker: 2 }) });

  stores.openAll();
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  assert.equal(heldOf(host, CALL).length, 1, 'a reconnect reads it again');
  await answer(host, CALL, ok(callPayload(row, { marker: 3 })));

  unsubscribe();
  unsubscribe = detail.subscribe(() => {});
  assert.equal(heldOf(host, 'inner-monitor').length, 0, 'a re-subscription takes the baseline it has');
  assert.equal(heldOf(host, CALL).length, 1, 'and reads the active detail again');
  await answer(host, CALL, ok(callPayload(row, { marker: 4 })));
  assert.deepEqual(detail.result, { kind: 'ready', value: callPayload(row, { marker: 4 }) });
  unsubscribe();
});

test('signals that arrive while an active detail read is in flight cost one more read of it', async () => {
  const row = generating(7, 9);
  const host = manual();
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  detail.subscribe(() => {});
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  assert.equal(heldOf(host, CALL).length, 1, 'one read in flight');
  stores.signal('s1');
  stores.signal('s1');
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  assert.equal(heldOf(host, CALL).length, 1, 'the signals meanwhile start no second read');
  await answer(host, CALL, ok(callPayload(row, { marker: 1 })));
  assert.equal(heldOf(host, CALL).length, 1, 'they cost one more read');
  await answer(host, CALL, ok(callPayload(row, { marker: 2 })));
  assert.equal(host.held.length, 0);
  assert.deepEqual(detail.result, { kind: 'ready', value: callPayload(row, { marker: 2 }) });
});

test('a settled attempt\'s refused or rejected read leaves its facts unobtained: a re-subscription, a signal and an open each read it once more while the failure stays the result, and the first success is kept', async () => {
  const row = attemptRow(7);
  for (const failure of [fail('inner_monitor_read_failed', 'the log could not be read'), new Error('transport down')]) {
    for (const trigger of ['re-subscription', 'signal', 'open']) {
      const host = manual();
      const stores = createMonitorStores({ call: host.call });
      const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
      let unsubscribe = detail.subscribe(() => {});
      await answer(host, 'inner-monitor', ok(rowsValue([row])));
      await answer(host, CALL, failure);
      const failed = detail.result;
      assert.equal(failed.kind, 'unreachable', trigger);

      if (trigger === 're-subscription') {
        unsubscribe();
        unsubscribe = detail.subscribe(() => {});
      } else {
        if (trigger === 'signal') stores.signal('s1');
        else stores.openAll();
        await answer(host, 'inner-monitor', ok(rowsValue([row])));
      }
      assert.equal(heldOf(host, CALL).length, 1, `${trigger} reads the unobtained detail once`);
      assert.equal(detail.result, failed, `${trigger}: the failure stays while the new read is pending`);
      await answer(host, CALL, ok(callPayload(row)));
      assert.deepEqual(detail.result, { kind: 'ready', value: callPayload(row) }, `${trigger} recovers`);

      stores.signal('s1');
      await answer(host, 'inner-monitor', ok(rowsValue([row])));
      assert.equal(host.held.length, 0, `${trigger}: the obtained snapshot is read no more`);
      unsubscribe();
    }
  }
});

test('a failure stays the detail\'s result until a new read completes or the facts change, and the change clears it like any other result', async () => {
  const host = manual();
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  const heard = [];
  detail.subscribe(result => heard.push(result));
  await answer(host, 'inner-monitor', ok(rowsValue([attemptRow(7, { revision: 9 })])));
  await answer(host, CALL, fail('inner_monitor_read_failed', 'the log could not be read'));
  assert.equal(detail.result.kind, 'unreachable');
  stores.signal('s1');
  await answer(host, 'inner-monitor', ok(rowsValue([attemptRow(7, { revision: 9 })])));
  assert.equal(detail.result.kind, 'unreachable', 'the same facts keep the failure while they are read again');
  await answer(host, CALL, new Error('transport down'));
  assert.deepEqual(detail.result, { kind: 'unreachable', message: 'transport down' }, 'and the new failure replaces it');

  stores.signal('s1');
  await answer(host, 'inner-monitor', ok(rowsValue([attemptRow(7, { revision: 10 })])));
  assert.equal(detail.result, null, 'new facts clear the failure');
  assert.equal(heard.at(-1), null);
  await answer(host, CALL, ok(callPayload(attemptRow(7, { revision: 10 }))));
  assert.equal(detail.result.kind, 'ready');
});

test('a signal that arrives while a settled attempt\'s first read is in flight does not read it again when that read fails', async () => {
  const row = attemptRow(7);
  const host = manual();
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  detail.subscribe(() => {});
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  assert.equal(heldOf(host, CALL).length, 1);
  stores.signal('s1');
  await answer(host, 'inner-monitor', ok(rowsValue([row])));
  assert.equal(heldOf(host, CALL).length, 1, 'the read in flight is the read');
  await answer(host, CALL, fail('inner_monitor_read_failed', 'the log could not be read'));
  assert.equal(detail.result.kind, 'unreachable');
  assert.equal(host.held.length, 0, 'a failed read is not retried by itself');
});

test('a success whose request has no tool definitions is a snapshot like any other and is not read again', async () => {
  const row = attemptRow(7);
  const { request } = callPayload(row);
  const snapshots = [
    callPayload(row, { request: { ...request, tools: { count: 2, definitions: null, reason: 'the log holds no request header at seq 1' } } }),
  ];
  for (const payload of snapshots) {
    const host = hostOf({ attempts: () => [row], details: { [CALL]: () => ok(payload) } });
    const stores = createMonitorStores({ call: host.call });
    const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
    let unsubscribe = detail.subscribe(() => {});
    await flush();
    stores.signal('s1');
    await flush();
    stores.openAll();
    await flush();
    unsubscribe();
    unsubscribe = detail.subscribe(() => {});
    await flush();
    assert.equal(readsOf(host, CALL), 1);
    assert.deepEqual(detail.result, { kind: 'ready', value: payload });
  }
});

// A host whose attempts change under the test: rows answer `host.rows`, and a call detail answers the row it names as it stands.
function livingHost(rows) {
  const host = hostOf({
    attempts: () => host.rows,
    details: { [CALL]: ({ attempt }) => ok(callPayload(host.rows.find(row => row.id === attempt))) },
  });
  host.rows = rows;
  return host;
}

const unknownRow = (id, revision) => attemptRow(id, {
  status: 'unknown', revision, endedAt: null, slots: null, call: { state: 'absent', endedAt: null, finish: null, output: null, usage: null },
});

test('a subscribed detail follows its attempt from generating through validating to its terminal state, each status read as the facts it is', async () => {
  const host = livingHost([generating(7, 9)]);
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  detail.subscribe(() => {});
  await flush();
  assert.equal(detail.result.value.row.status, 'generating');

  host.rows = [attemptRow(7, { status: 'validating', revision: 9, endedAt: null, slots: null })];
  stores.signal('s1');
  await flush();
  assert.equal(detail.result.value.row.status, 'validating');

  host.rows = [attemptRow(7, { status: 'committed', revision: 12 })];
  stores.signal('s1');
  await flush();
  assert.equal(detail.result.value.row.status, 'committed', 'the terminal state is read though the attempt is no longer active');
  const reads = readsOf(host, CALL);
  stores.signal('s1');
  stores.openAll();
  await flush();
  assert.equal(readsOf(host, CALL), reads, 'and it is a snapshot from then on');
});

test('a detail whose attempt was unknown reads the terminal facts when they arrive', async () => {
  for (const terminal of [attemptRow(7, { status: 'failed', revision: 11, reason: 'no finish chunk', slots: null }), attemptRow(7, { revision: 12 })]) {
    const host = livingHost([unknownRow(7, 8)]);
    const stores = createMonitorStores({ call: host.call });
    const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
    detail.subscribe(() => {});
    await flush();
    assert.equal(detail.result.value.row.status, 'unknown');
    host.rows = [terminal];
    stores.signal('s1');
    await flush();
    assert.equal(detail.result.value.row.status, terminal.status);
  }
});

test('a detail whose attempt stays unknown reads again when a new call fact moves its revision, and not before', async () => {
  const host = livingHost([unknownRow(7, 8)]);
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  detail.subscribe(() => {});
  await flush();
  stores.signal('s1');
  await flush();
  assert.equal(readsOf(host, CALL), 1, 'the same facts are read once');
  host.rows = [unknownRow(7, 10)];
  host.rows[0].call = { ...host.rows[0].call, state: 'error', finish: null, thrown: 'the stream failed', output: 'partial' };
  stores.signal('s1');
  await flush();
  assert.equal(readsOf(host, CALL), 2);
  assert.equal(detail.result.value.row.status, 'unknown');
  assert.equal(detail.result.value.row.call.thrown, 'the stream failed', 'the new call fact is in the snapshot');
});

test('an older key\'s late answer, a success or a failure, overwrites nothing of the newer key and is not heard', async () => {
  const before = generating(7, 9);
  const after = attemptRow(7, { status: 'validating', revision: 9, endedAt: null, slots: null });
  const lateReplies = [ok(callPayload(before, { marker: 'late' })), fail('inner_monitor_read_failed', 'late failure'), new Error('late transport failure')];
  for (const late of lateReplies) {
    const host = manual();
    const stores = createMonitorStores({ call: host.call });
    const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
    const heard = [];
    detail.subscribe(result => heard.push(result));
    await answer(host, 'inner-monitor', ok(rowsValue([before])));
    assert.equal(heldOf(host, CALL).length, 1, 'the old key\'s read is in flight');
    stores.signal('s1');
    await answer(host, 'inner-monitor', ok(rowsValue([after])));
    assert.equal(heldOf(host, CALL).length, 2, 'the new key is read at once');
    await answer(host, CALL, ok(callPayload(after, { marker: 'new' })), 1);
    const current = detail.result;
    assert.deepEqual(current, { kind: 'ready', value: callPayload(after, { marker: 'new' }) });
    await settle(host, late);
    assert.equal(detail.result, current, 'the late answer changes nothing');
    assert.deepEqual(heard, [current], 'and is not heard');
    assert.equal(host.held.length, 0);
  }
});

test('a key change clears the detail before anyone is told: the rows listener reads null, the detail\'s subscribers hear null, the old key\'s late answer leaves that loading state alone, and only the new key\'s answer is ready', async () => {
  const before = generating(7, 9);
  const after = attemptRow(7, { status: 'validating', revision: 9, endedAt: null, slots: null });
  const host = manual();
  const session = createMonitorStores({ call: host.call }).for('s1');
  const detail = session.resource({ endpoint: CALL, attempt: 7 });
  const sawByRows = [];
  const heard = [];
  session.rows.subscribe(() => sawByRows.push(detail.result));
  detail.subscribe(result => heard.push(result));
  await answer(host, 'inner-monitor', ok(rowsValue([before])));
  await answer(host, CALL, ok(callPayload(before, { marker: 'old' })));
  const old = detail.result;
  assert.equal(old.kind, 'ready');

  session.rows.subscribe(() => {});
  await answer(host, 'inner-monitor', ok(rowsValue([before])));
  assert.equal(heldOf(host, CALL).length, 1, 'the same key is read again');
  assert.equal(detail.result, old, 'and the last ready stays while that read is pending');

  const rowsCalls = sawByRows.length;
  session.rows.subscribe(() => {});
  const heardBefore = heard.length;
  await answer(host, 'inner-monitor', ok(rowsValue([after])));
  assert.equal(sawByRows.length, rowsCalls + 1, 'the rows listener heard the new baseline');
  assert.equal(sawByRows.at(-1), null, 'and read the detail already cleared');
  assert.deepEqual(heard.slice(heardBefore), [null], 'the detail\'s subscribers heard null');
  assert.equal(detail.result, null);
  assert.equal(heldOf(host, CALL).length, 2, 'the new key is read beside the abandoned read of the old');

  await answer(host, CALL, ok(callPayload(before, { marker: 'late' })));
  assert.equal(detail.result, null, 'the old key\'s late answer does not leave the loading state');
  assert.equal(heard.length, heardBefore + 1);
  await answer(host, CALL, ok(callPayload(after, { marker: 'new' })));
  assert.deepEqual(detail.result, { kind: 'ready', value: callPayload(after, { marker: 'new' }) });
  assert.deepEqual(heard.at(-1), detail.result);
});

test('a resource for an attempt the rows do not name reads nothing until a later read of the rows names it', async () => {
  const host = livingHost([attemptRow(1)]);
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 2 });
  detail.subscribe(() => {});
  await flush();
  assert.equal(detail.result, null);
  assert.equal(readsOf(host, CALL), 0, 'no state is guessed for an attempt the baseline lacks');
  host.rows = [attemptRow(1), attemptRow(2)];
  stores.signal('s1');
  await flush();
  assert.equal(readsOf(host, CALL), 1);
  assert.equal(detail.result.value.row.id, 2);
});

test('a rows read that fails leaves the facts the details rest on, so a snapshot of unchanged facts is kept and is not read again', async () => {
  let rowsAnswer = null;
  const row = attemptRow(7);
  const host = hostOf({ attempts: () => [row], details: { [CALL]: () => ok(callPayload(row)) } });
  const call = (endpoint, payload) => (endpoint === 'inner-monitor' && rowsAnswer !== null ? Promise.resolve(rowsAnswer) : host.call(endpoint, payload));
  const stores = createMonitorStores({ call });
  const session = stores.for('s1');
  const detail = session.resource({ endpoint: CALL, attempt: 7 });
  detail.subscribe(() => {});
  session.rows.subscribe(() => {});
  await flush();
  const snapshot = detail.result;
  assert.equal(snapshot.kind, 'ready');
  rowsAnswer = fail('inner_monitor_read_failed', 'the rows could not be read');
  stores.signal('s1');
  await flush();
  assert.deepEqual(session.rows.result, { kind: 'unreachable', message: 'the rows could not be read' });
  assert.equal(detail.result, snapshot);
  assert.equal(readsOf(host, CALL), 1);
});

test('a signal reads nothing for a session nobody listens to, a resource handle included, and a resource listener keeps its session read', async () => {
  const row = attemptRow(7);
  const host = livingHost([row]);
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: CALL, attempt: 7 });
  stores.signal('s1');
  stores.openAll();
  await flush();
  assert.equal(host.log.length, 0, 'an unsubscribed handle reads nothing');
  const unsubscribe = detail.subscribe(() => {});
  await flush();
  assert.equal(host.log.length, 2);
  unsubscribe();
  stores.signal('s1');
  stores.openAll();
  await flush();
  assert.equal(host.log.length, 2, 'and once its last listener left, a signal reads nothing');
});

// ── Handoffs ──────────────────────────────────────────────────────────────────

const HANDOFF = 'inner-monitor/handoff';

// A host whose handoffs change under the test: rows answer `host.attempts` and `host.handoffs`, and a handoff detail answers the row it names as it stands.
function handoffHost({ attempts = [], handoffs }) {
  const host = channel((endpoint, payload) => {
    if (endpoint === 'inner-monitor') return ok(rowsValue(host.attempts, host.handoffs));
    return ok(handoffPayload(host.handoffs.find(row => row.id === payload.handoff), { marker: payload.handoff }));
  });
  host.attempts = attempts;
  host.handoffs = handoffs;
  return host;
}

test('the rows hold the handoffs the host answers beside its attempts, none where a host answers none', async () => {
  const handoffs = [handoffRow(5), handoffRow(9, { type: 'continue' })];
  const attempts = [attemptRow(1)];
  const withHandoffs = createMonitorStores({ call: channel(() => ok(rowsValue(attempts, handoffs))).call }).for('s1').rows;
  withHandoffs.subscribe(() => {});
  await flush();
  assert.deepEqual(withHandoffs.result, { kind: 'ready', attempts, handoffs });
  const old = createMonitorStores({ call: channel(() => ok({ attempts })).call }).for('s1').rows;
  old.subscribe(() => {});
  await flush();
  assert.deepEqual(old.result, { kind: 'ready', attempts, handoffs: [] });
});

test('a handoff resource reads the rows first, then the handoff endpoint with the handoff it names, and holds the endpoint\'s complete payload', async () => {
  const host = handoffHost({ handoffs: [handoffRow(5)] });
  const session = createMonitorStores({ call: host.call }).for('s1');
  const detail = session.resource({ endpoint: HANDOFF, handoff: 5 });
  assert.equal(session.resource({ endpoint: HANDOFF, handoff: 5 }), detail, 'one handle for one identity');
  assert.notEqual(session.resource({ endpoint: HANDOFF, handoff: 6 }), detail);
  assert.notEqual(session.resource({ endpoint: CALL, attempt: 5 }), detail, 'a compaction of the same id is another identity');
  const heard = [];
  detail.subscribe(result => heard.push(result));
  assert.deepEqual(host.log.map(entry => entry.endpoint), ['inner-monitor']);
  await flush();
  assert.deepEqual(host.log, [
    { endpoint: 'inner-monitor', payload: { sessionId: 's1' } },
    { endpoint: HANDOFF, payload: { sessionId: 's1', handoff: 5 } },
  ]);
  assert.deepEqual(detail.result, { kind: 'ready', value: handoffPayload(handoffRow(5), { marker: 5 }) });
  assert.deepEqual(heard, [detail.result]);
});

test('a handoff\'s detail is read once for its revision: a signal and a re-subscription read the rows again and the detail not at all', async () => {
  const host = handoffHost({ handoffs: [handoffRow(5)] });
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: HANDOFF, handoff: 5 });
  let unsubscribe = detail.subscribe(() => {});
  await flush();
  const snapshot = detail.result;
  stores.signal('s1');
  await flush();
  unsubscribe();
  unsubscribe = detail.subscribe(() => {});
  await flush();
  assert.equal(readsOf(host, HANDOFF), 1);
  assert.equal(readsOf(host, 'inner-monitor'), 2);
  assert.equal(detail.result, snapshot);
});

test('a handoff row whose revision moved clears its detail, tells its subscribers and reads it again, which is how the first call after a continue reaches the drawer', async () => {
  const host = handoffHost({ handoffs: [handoffRow(5, { type: 'continue', revision: 7, contextChange: { before: 460, after: null, delta: null, miss: null } })] });
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: HANDOFF, handoff: 5 });
  const heard = [];
  detail.subscribe(result => heard.push(result));
  await flush();
  assert.equal(readsOf(host, HANDOFF), 1);
  host.handoffs = [handoffRow(5, { type: 'continue', revision: 12, contextChange: { before: 460, after: 710, delta: 250, miss: 510 } })];
  stores.signal('s1');
  await flush();
  assert.equal(readsOf(host, HANDOFF), 2, 'a moved revision is read again');
  assert.equal(heard.includes(null), true, 'the subscriber heard the detail cleared');
  assert.equal(detail.result.value.row.revision, 12);
});

test('a handoff the rows do not name reads nothing until a later read of the rows names it', async () => {
  const host = handoffHost({ handoffs: [handoffRow(5)] });
  const stores = createMonitorStores({ call: host.call });
  const detail = stores.for('s1').resource({ endpoint: HANDOFF, handoff: 6 });
  detail.subscribe(() => {});
  await flush();
  assert.equal(detail.result, null);
  assert.equal(readsOf(host, HANDOFF), 0);
  host.handoffs = [handoffRow(5), handoffRow(6)];
  stores.signal('s1');
  await flush();
  assert.equal(readsOf(host, HANDOFF), 1);
  assert.equal(detail.result.value.marker, 6);
});
