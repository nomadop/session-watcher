// The unsealed source of an inner-compaction session (`lib/inner-seal/source.js`): the frontier, range, step count and pause the semantic event facts decide over the surface's node order, the request header they name, and the slots of a range; first over hand-written fact Maps, then end to end over DSH logs through `eventFactsOf`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { headerSeqIn, innerSource, skeletonSlots } from '../lib/inner-seal/source.js';
import { eventFactOf, eventFactsOf } from '../lib/harness/dsh/event-facts.js';
import {
  userMessage, assistantMessage, toolResult, loadMessage, compactCheckpoint, innerSealCarrier, systemMessage, turnStart,
  attempt, toolCall, sessionLog, stepStart, stepEnd, unknownEvent, turnEnd, compactionPrune, prunedResult, requestHeader,
} from './helpers/dsh-events.js';

// ── Hand-written facts ───────────────────────────────────────────────────────────────────────────────────────

// The facts of one event that is none of the kinds a fact names, with `rest` set.
const F = (rest = {}) => ({
  system: false, header: false, marker: null, epoch: false, step: null, owner: { turn: 0, step: 0 }, assistant: false, skeletonCall: false, originals: [], ...rest,
});
// A step's completing assistant message and a node it owns.
const reply = (turn, step, rest = {}) => F({ assistant: true, step: { turn, step }, owner: { turn, step }, ...rest });
const owned = (turn, step, rest = {}) => F({ owner: { turn, step }, ...rest });

test('headerSeqIn answers the greatest header seq when latest, else the least above `above`, whatever order the Map was filled in, and null when none is', () => {
  const entries = [[0, F({ system: true })], [1, F({ header: true })], [2, F()], [3, F({ header: true })], [4, F({ header: true })], [5, F()]];
  for (const order of [entries, [...entries].reverse(), [entries[4], entries[1], entries[5], entries[3], entries[0], entries[2]]]) {
    const facts = new Map(order);
    assert.equal(headerSeqIn(facts, { latest: true }), 4);
    assert.equal(headerSeqIn(facts, { latest: false, above: -1 }), 1);
    assert.equal(headerSeqIn(facts, { latest: false, above: 1 }), 3, 'strictly above');
    assert.equal(headerSeqIn(facts, { latest: false, above: 2 }), 3);
    assert.equal(headerSeqIn(facts, { latest: false, above: 4 }), null);
  }
  const headerless = new Map(entries.filter(([, fact]) => !fact.header));
  assert.equal(headerSeqIn(headerless, { latest: true }), null);
  assert.equal(headerSeqIn(headerless, { latest: false, above: -1 }), null);
  assert.equal(headerSeqIn(new Map(), { latest: true }), null);
});

test('the initial prefix is the system head and the nodes before the first header, and the range opens behind it', () => {
  const facts = new Map([[0, F({ system: true })], [1, F()], [2, F()], [3, F({ header: true })], [4, reply(1, 1)], [5, owned(1, 1)], [6, reply(1, 2)]]);

  assert.deepEqual(innerSource(facts, [0, 1, 2, 4, 5, 6]), { frontier: null, range: [4, 5, 6], stepN: 2, paused: false });
  assert.deepEqual(innerSource(new Map(), []), { frontier: null, range: [], stepN: 0, paused: false });
});

test('the frontier is the marker of greatest seq wherever it stands on the surface, and a payload in the initial prefix is none', () => {
  const kept = new Map([[0, F({ system: true })], [3, F({ marker: 'carrier' })], [4, reply(1, 1)], [5, owned(1, 1)], [9, F({ marker: 'checkpoint' })]]);
  assert.deepEqual(innerSource(kept, [0, 9, 3, 4, 5]), { frontier: 9, range: [3, 4, 5], stepN: 1, paused: false });

  const loaded = new Map([[0, F({ system: true })], [1, F({ marker: 'payload' })], [2, F({ header: true })], [3, reply(1, 1)], [4, F({ marker: 'payload' })], [5, reply(2, 1)]]);
  assert.deepEqual(innerSource(loaded, [0, 1, 3, 4, 5]), { frontier: 4, range: [5], stepN: 1, paused: false });
});

test('an epoch-opening checkpoint takes the prefix through itself and the nodes it admits before the epoch\'s first header; an earlier header moves nothing', () => {
  const facts = new Map([
    [0, F({ system: true })], [1, F({ header: true })], [6, F({ marker: 'checkpoint', epoch: true })], [7, F()], [8, F({ header: true })], [9, reply(2, 1)], [10, F()],
  ]);

  assert.deepEqual(innerSource(facts, [0, 6, 7, 9, 10]), { frontier: 6, range: [9, 10], stepN: 1, paused: false });
});

test('a skeleton call pauses the range unless a payload of the range follows it', () => {
  const facts = new Map([[0, F({ system: true })], [3, reply(1, 1, { skeletonCall: true })], [4, F({ marker: 'payload' })], [9, F({ marker: 'checkpoint' })]]);

  assert.equal(innerSource(facts, [0, 9, 3, 4]).paused, false);
  assert.equal(innerSource(facts, [0, 9, 4, 3]).paused, true);
});

test('a counted step is one slot of the nodes it owns at its first node, an original before the replacement that stands for it; an uncounted node stands alone and an uncounted assistant message makes none', () => {
  const facts = new Map([
    [1, F({ owner: { turn: undefined, step: undefined } })], [2, owned(1, 1)], [3, reply(1, 1)], [4, owned(1, 1, { originals: [20] })], [5, F({ owner: { turn: undefined, step: undefined } })],
    [6, owned(1, 2, { assistant: true })], [7, owned(1, 2, { originals: [21] })],
  ]);
  const nodes = [1, 2, 3, 5, 4, 6, 7];

  assert.deepEqual(skeletonSlots(facts, nodes, nodes), [{ seqs: [1] }, { seqs: [2, 3, 20, 4], step: { turn: 1, step: 1 } }, { seqs: [5] }, { seqs: [21, 7] }]);
  assert.deepEqual(skeletonSlots(facts, nodes, [6, 4]), [{ seqs: [20, 4] }], 'a range without the completing message counts no step');
});

// ── DSH logs through eventFactsOf ────────────────────────────────────────────────────────────────────────────

const call = (name, id = `sw-load-${name}`) => ({ id, name, arguments: '{}', text: `${name} result` });

// The surface DSH folds from a log: an append adds the node, a replace swaps the nodes from its start through its end for itself.
function surfaceOf(log) {
  const nodes = [];
  for (const event of log) {
    const op = event.surfaceOp;
    if (op === undefined) continue;
    if (op === 'append') {
      nodes.push(event.seq);
      continue;
    }
    const first = nodes.indexOf(op.startSeq);
    nodes.splice(first, nodes.indexOf(op.endSeq) - first + 1, event.seq);
  }
  return nodes;
}

// One completed main step as the loop logs it: its start, its assistant message, the result of its one call and its end.
function mainStep(turn, step, { text = `step ${step} of turn ${turn}`, toolCalls = [] } = {}) {
  const callId = `call-${turn}-${step}`;
  const assistant = assistantMessage({ turn, step, text, toolCalls: [{ id: callId, name: 'read' }, ...toolCalls] });
  const result = toolResult({ callId, text: 'ok', turn, step });
  return { events: [stepStart({ turn, step }), assistant, result, stepEnd({ turn, step })], assistant, result };
}

// The log the events make, and the seq each of them has in it.
function logOf(events) {
  const log = sessionLog(events);
  return { log, seqOf: event => events.indexOf(event), nodes: surfaceOf(log), facts: eventFactsOf(log) };
}

test('the frontier is the inner-seal carrier, the stock checkpoint or the load payload, and the range is the nodes after it', async (t) => {
  const markers = {
    'an inner-seal carrier': ({ replaced }) => ({
      marker: innerSealCarrier({ sourceEventSeqs: replaced.map(event => event.seq) }), after: [],
    }),
    'a stock checkpoint': ({ replaced }) => ({
      marker: compactCheckpoint({ startSeq: replaced[0].seq, endSeq: replaced.at(-1).seq }), after: [],
    }),
    'a load payload': () => {
      const readMessage = loadMessage({ calls: [call('read')] });
      return { marker: loadMessage({ calls: [call('load_handoff')] }), after: [readMessage, userMessage({ text: 'continue' })] };
    },
  };
  for (const [name, build] of Object.entries(markers)) {
    await t.test(name, () => {
      const user = userMessage({ text: 'start' });
      const old1 = mainStep(1, 1);
      const old2 = mainStep(1, 2);
      const replaced = [user, old1.assistant, old1.result, old2.assistant, old2.result];
      const { marker, after } = build({ replaced });
      const next = mainStep(1, 3);
      const events = [systemMessage(), turnStart(), user, ...old1.events, ...old2.events, marker, ...after, ...next.events];
      const { nodes, facts, seqOf } = logOf(events);

      const source = innerSource(facts, nodes);

      assert.equal(source.frontier, seqOf(marker));
      assert.deepEqual(source.range, [...after, next.assistant, next.result].map(seqOf));
    });
  }
});

test('a session no marker has sealed starts its range after the system head, and a read message alone is no marker', () => {
  const user = userMessage({ text: 'start' });
  const read = loadMessage({ calls: [call('read')] });
  const first = mainStep(1, 1);
  const system = systemMessage();
  const events = [system, turnStart(), user, read, ...first.events];
  const { nodes, facts, seqOf } = logOf(events);

  assert.deepEqual(innerSource(facts, nodes), {
    frontier: null, range: [user, read, first.assistant, first.result].map(seqOf), stepN: 1, paused: false,
  });
  // A surface a stock compaction left without a system head has none to skip, and a blank one has no range.
  const headless = logOf([user, ...first.events]);
  assert.deepEqual(innerSource(headless.facts, headless.nodes).range, [user, first.assistant, first.result].map(headless.seqOf));
  assert.deepEqual(innerSource(new Map(), []), { frontier: null, range: [], stepN: 0, paused: false });
});

// The start of a native session as the loop logs it: the step opens, then the system prompt, the user's task and the harness contexts the first request carries are admitted, and only then the request's header is logged.
const INITIAL_CONTEXTS = ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context'];
function nativeStart() {
  const system = systemMessage();
  const task = userMessage({ text: 'the original task' });
  const contexts = INITIAL_CONTEXTS.map(kind => userMessage({ kind, text: `${kind} admitted before the first request` }));
  return { system, task, contexts, header: requestHeader(), prefix: [system, task, ...contexts] };
}

test('the initial prefix is H: the system prompt, the original task and every harness context the first request carried are not in the range, which opens with the first model step', () => {
  const { prefix, header } = nativeStart();
  const first = mainStep(1, 1);
  const second = mainStep(1, 2);
  const { nodes, facts, seqOf } = logOf([turnStart(), stepStart(), ...prefix, header, ...first.events.slice(1), ...second.events]);

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, null);
  assert.deepEqual(source.range, [first.assistant, first.result, second.assistant, second.result].map(seqOf), 'H is the whole prefix through the last context, the interleaved task included');
  assert.equal(source.stepN, 2, 'the steps after the initial preparation still count');
});

test('the initial cutoff is the first request header of the log: later headers, turns, contexts and a resume leave the prefix as it was', () => {
  const { prefix, header } = nativeStart();
  const first = mainStep(1, 1);
  const user2 = userMessage({ text: 'a later task' });
  const refreshed = userMessage({ kind: 'runtime-context', text: 'a later snapshot' });
  const second = mainStep(2, 1);
  const events = [
    turnStart(), stepStart(), ...prefix, header, ...first.events.slice(1), turnStart({ turn: 2 }), user2,
    requestHeader({ reason: 'change' }), refreshed, ...second.events, requestHeader({ reason: 'resume' }),
  ];
  const { nodes, facts, seqOf } = logOf(events);

  const source = innerSource(facts, nodes);

  assert.deepEqual(source.range, [first.assistant, first.result, user2, refreshed, second.assistant, second.result].map(seqOf),
    'a later task and a later context are source of the range, not prefix');
  // The Map can be filled in any order: the decision reads the header of least seq, not the first one met.
  const reversed = new Map([...facts].reverse());
  assert.deepEqual(innerSource(reversed, nodes).range, source.range);
});

test('a fork keeps the initial prefix it inherited: its own first header, logged as a resume, does not move the cutoff', () => {
  const { prefix, header } = nativeStart();
  const inherited = mainStep(1, 1);
  const own = mainStep(2, 1);
  const events = [
    turnStart(), stepStart(), ...prefix, header, ...inherited.events.slice(1),
    unknownEvent({ type: 'session/end-seed', data: { inherited: true } }),
    turnStart({ turn: 2 }), userMessage({ text: 'fork task' }), requestHeader({ reason: 'resume' }), ...own.events,
  ];
  const { nodes, facts, seqOf } = logOf(events);

  const { range } = innerSource(facts, nodes);

  assert.equal(range[0], seqOf(inherited.assistant), 'the inherited steps are unsealed source');
  assert.ok(prefix.every(event => !range.includes(seqOf(event))));
  assert.ok(range.includes(seqOf(own.assistant)));
});

test('a marker after the initial prefix still decides the range: the frontier wins over the prefix', () => {
  const { prefix, header } = nativeStart();
  const old = mainStep(1, 1);
  const carrier = innerSealCarrier({ sourceEventSeqs: [old.assistant, old.result].map(event => event.seq) });
  const next = mainStep(1, 2);
  const { nodes, facts, seqOf } = logOf([turnStart(), stepStart(), ...prefix, header, ...old.events.slice(1), carrier, ...next.events]);

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, seqOf(carrier));
  assert.deepEqual(source.range, [next.assistant, next.result].map(seqOf));
});

test('a system prompt the loop normalized in place after the first request still heads the surface and stays out of the range, the prefix behind it too', () => {
  const { system, prefix, header } = nativeStart();
  const first = mainStep(1, 1);
  const renormalized = { ...systemMessage({ text: 'the same prompt, rendered again' }), surfaceOp: { op: 'replace', startSeq: system.seq, endSeq: system.seq } };
  const second = mainStep(1, 2);
  const { nodes, facts, seqOf } = logOf([turnStart(), stepStart(), ...prefix, header, ...first.events.slice(1), renormalized, ...second.events]);

  assert.equal(nodes[0], seqOf(renormalized), 'the replaced prompt stands at the head with a seq above the first header');
  assert.deepEqual(innerSource(facts, nodes).range, [first.assistant, first.result, second.assistant, second.result].map(seqOf));
});

test('a log with no request header has no initial prefix to find: only its leading system prompt is skipped', () => {
  const { prefix } = nativeStart();
  const first = mainStep(1, 1);
  const { nodes, facts, seqOf } = logOf([turnStart(), ...prefix, ...first.events]);

  assert.deepEqual(innerSource(facts, nodes).range, [...prefix.slice(1), first.assistant, first.result].map(seqOf));
});


// The log a session writes up to its first request in a fresh Context Epoch, new or cleared: the load's payload and read message, the follow-up that wakes the model, then the harness contexts, and the header of the epoch's first request.
function epochStart({ header = requestHeader() } = {}) {
  const payload = loadMessage({ calls: [call('load_handoff')] });
  const read = loadMessage({ calls: [call('read')] });
  const followUp = userMessage({ text: 'Handoff is loaded' });
  const contexts = INITIAL_CONTEXTS.map(kind => userMessage({ kind, text: `${kind} admitted before the first request` }));
  return { payload, read, followUp, contexts, header, prefix: [payload, read, followUp, ...contexts] };
}

test('an initial load does not truncate the initial prefix at its payload: the payload, its read, the follow-up and the contexts the first request carried are H, and the range opens with the first model step', () => {
  const { prefix, header } = epochStart();
  const system = systemMessage();
  const first = mainStep(1, 1);
  const second = mainStep(1, 2);
  const { nodes, facts, seqOf } = logOf([system, turnStart(), stepStart(), ...prefix, header, ...first.events.slice(1), ...second.events]);

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, null, 'the initial load payload is no frontier');
  assert.deepEqual(source.range, [first.assistant, first.result, second.assistant, second.result].map(seqOf));
  assert.equal(source.stepN, 2);
});

// A session that ran one epoch to a first request header of its own, then cleared: the stock checkpoint replaces everything after the system head, and the next request logs a header, whose content may be unchanged.
function clearedSession({ reason }) {
  const system = systemMessage();
  const task = userMessage({ text: 'the original task' });
  const oldContexts = INITIAL_CONTEXTS.map(kind => userMessage({ kind, text: `old ${kind}` }));
  const old = [mainStep(1, 1), mainStep(1, 2)];
  const replaced = [task, ...oldContexts, ...old.flatMap(step => [step.assistant, step.result])];
  const checkpoint = compactCheckpoint({ startSeq: task.seq, endSeq: replaced.at(-1).seq });
  const start = epochStart({ header: requestHeader({ reason, startsSeries: reason !== 'series' }) });
  const after = [mainStep(2, 1), mainStep(2, 2)];
  const events = [
    system, turnStart(), stepStart(), task, ...oldContexts, requestHeader(), ...old.flatMap(step => step.events),
    checkpoint, ...start.prefix, start.header, ...after.flatMap(step => step.events),
  ];
  return { ...logOf(events), system, checkpoint, start, after };
}

test('a cleared Context Epoch has the initial prefix a new session has, whether the first request after the clear logs an unchanged header as a series or a changed one: the old session header does not stop it, and the epoch\'s payload, read, follow-up and contexts are H', async (t) => {
  for (const reason of ['series', 'change']) {
    await t.test(`the header is logged as ${reason}`, () => {
      const { nodes, facts, seqOf, system, checkpoint, start, after } = clearedSession({ reason });
      assert.deepEqual(nodes.slice(0, 2 + start.prefix.length), [system, checkpoint, ...start.prefix].map(seqOf), 'the checkpoint stands behind the system head, the epoch\'s admissions behind it');

      const source = innerSource(facts, nodes);

      assert.equal(source.frontier, seqOf(checkpoint), 'the checkpoint is the last marker; the initial payload is none');
      assert.deepEqual(source.range, after.flatMap(step => [step.assistant, step.result]).map(seqOf));
      assert.equal(source.stepN, 2);
    });
  }
});

test('what the cleared epoch admits behind its first header keeps its ordinary treatment: a later context, task and load payload are range source or frontier, and a seal\'s own series header leaves the prefix where it was', () => {
  const { prefix, header } = epochStart();
  const first = mainStep(1, 1);
  const refreshed = userMessage({ kind: 'runtime-context', text: 'a snapshot admitted behind the header' });
  const later = userMessage({ text: 'a later task' });
  const laterPayload = loadMessage({ calls: [call('load_handoff')] });
  const laterRead = loadMessage({ calls: [call('read')] });
  const second = mainStep(1, 2);
  const events = [systemMessage(), turnStart(), stepStart(), ...prefix, header, ...first.events.slice(1), refreshed, later, ...second.events];
  const unloaded = logOf(events);
  assert.deepEqual(innerSource(unloaded.facts, unloaded.nodes).range, [first.assistant, first.result, refreshed, later, second.assistant, second.result].map(unloaded.seqOf));

  const loaded = logOf([...events, laterPayload, laterRead, ...mainStep(2, 1).events]);
  const source = innerSource(loaded.facts, loaded.nodes);
  assert.equal(source.frontier, loaded.seqOf(laterPayload), 'a payload behind the header is a later load');
  assert.equal(source.range[0], loaded.seqOf(laterRead));

  const carrier = innerSealCarrier({ sourceEventSeqs: [first.assistant, first.result].map(event => event.seq) });
  const sealed = logOf([...events.slice(0, events.indexOf(first.assistant)), first.assistant, first.result, carrier, requestHeader({ reason: 'series' }), refreshed, ...second.events]);
  const afterSeal = innerSource(sealed.facts, sealed.nodes);
  assert.equal(afterSeal.frontier, sealed.seqOf(carrier));
  assert.deepEqual(afterSeal.range, [refreshed, second.assistant, second.result].map(sealed.seqOf), 'the series header of the seal opens no epoch and no prefix');
});

test('a stock checkpoint that keeps a tail freezes none of it though a header follows: the tail of lower seq and what is admitted behind it stay range source', () => {
  const user0 = userMessage({ text: 'start' });
  const old = mainStep(1, 1);
  const kept = mainStep(2, 1);
  const checkpoint = compactCheckpoint({ startSeq: user0.seq, endSeq: old.result.seq });
  const admitted = userMessage({ text: 'asked after the compaction' });
  const after = mainStep(3, 1);
  const { nodes, facts, seqOf } = logOf([
    systemMessage(), turnStart(), user0, ...old.events, ...kept.events, checkpoint, admitted, requestHeader({ reason: 'series' }), ...after.events,
  ]);

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, seqOf(checkpoint));
  assert.deepEqual(source.range, [kept.assistant, kept.result, admitted, after.assistant, after.result].map(seqOf));
  assert.equal(source.stepN, 2);
});

// The log of a session sealed once, then compacted by stock with a kept tail: the checkpoint replaces the oldest region and the tail behind it keeps an earlier payload, an earlier carrier and raw steps, all of lower seq than the checkpoint.
function keptTailSession() {
  const system = systemMessage();
  const user0 = userMessage({ text: 'start' });
  const step1 = mainStep(1, 1);
  const step2 = mainStep(1, 2);
  const payload = loadMessage({ calls: [call('load_handoff')] });
  const readMessage = loadMessage({ calls: [call('read')] });
  const user1 = userMessage({ text: 'continue' });
  const step3 = mainStep(2, 1);
  const step4 = mainStep(2, 2);
  const carrier = innerSealCarrier({
    sourceEventSeqs: [readMessage, user1, step3.assistant, step3.result, step4.assistant, step4.result].map(event => event.seq),
  });
  const step5 = mainStep(3, 1);
  const step6 = mainStep(3, 2);
  const checkpoint = compactCheckpoint({ startSeq: user0.seq, endSeq: step2.result.seq });
  const step7 = mainStep(4, 1);
  const events = [
    system, turnStart(), user0, ...step1.events, ...step2.events, payload, readMessage, user1, ...step3.events,
    ...step4.events, carrier, ...step5.events, ...step6.events, checkpoint, ...step7.events,
  ];
  return { ...logOf(events), system, payload, carrier, checkpoint, step5, step6, step7 };
}

test('a checkpoint that keeps a tail is the frontier though the old payload and carrier of its tail come after it on the surface', () => {
  const { nodes, facts, seqOf, system, payload, carrier, checkpoint, step5, step6, step7 } = keptTailSession();
  assert.deepEqual(nodes, [system, checkpoint, payload, carrier, step5.assistant, step5.result, step6.assistant, step6.result, step7.assistant, step7.result].map(seqOf),
    'the checkpoint sits before the tail nodes of lower seq');

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, seqOf(checkpoint));
  assert.deepEqual(source.range, [payload, carrier, step5.assistant, step5.result, step6.assistant, step6.result, step7.assistant, step7.result].map(seqOf),
    'the old payload and carrier of the tail are ordinary source of the range');
});

test('stepN counts the completed main steps of the range: failed attempts, empty messages and steps before the frontier do not count, an interrupted step does', () => {
  const user = userMessage({ text: 'start' });
  const before = mainStep(1, 1);
  const carrier = innerSealCarrier({ sourceEventSeqs: [user, before.assistant, before.result].map(event => event.seq) });
  const completed = mainStep(2, 1);
  // A step whose every request failed or was cancelled before a block arrived appended only attempts.
  const failed = [stepStart({ turn: 2, step: 2 }), attempt({ turn: 2, step: 2 }), attempt({ turn: 2, step: 2 }), stepEnd({ turn: 2, step: 2 })];
  const empty = assistantMessage({ turn: 2, step: 3 });
  const interrupted = assistantMessage({ text: 'partial answer', interrupted: true, turn: 2, step: 4 });
  const answered = assistantMessage({ text: 'done', turn: 2, step: 5 });
  const events = [
    systemMessage(), turnStart(), user, ...before.events, carrier, ...completed.events, ...failed,
    stepStart({ turn: 2, step: 3 }), empty, stepEnd({ turn: 2, step: 3 }),
    stepStart({ turn: 2, step: 4 }), interrupted, stepEnd({ turn: 2, step: 4 }),
    stepStart({ turn: 2, step: 5 }), answered, stepEnd({ turn: 2, step: 5 }),
  ];
  const { nodes, facts } = logOf(events);

  assert.equal(innerSource(facts, nodes).stepN, 3);
});

test('stepN counts the steps behind a checkpoint that keeps a tail by surface position, not by seq above the checkpoint', () => {
  const { nodes, facts } = keptTailSession();

  assert.equal(innerSource(facts, nodes).stepN, 3, 'the two kept steps and the one after the checkpoint');
});

const SKELETON = { id: 'call-skeleton', name: 'get_turn_skeleton' };

test('a skeleton call pauses the range until a payload message after it opens a new range, which counts from zero', () => {
  const user = userMessage({ text: 'hand this off' });
  const carrier = innerSealCarrier({ sourceEventSeqs: [user.seq] });
  const first = mainStep(1, 1);
  const handoff = mainStep(1, 2, { toolCalls: [SKELETON] });
  const payload = loadMessage({ calls: [call('load_handoff')] });
  const readMessage = loadMessage({ calls: [call('read')] });
  const resumed = [mainStep(2, 1), mainStep(2, 2)];
  const events = [systemMessage(), turnStart(), user, carrier, ...first.events];
  const facts = new Map();
  const surface = () => {
    const log = sessionLog(events);
    for (const event of log) facts.set(event.seq, eventFactOf(event));
    return surfaceOf(log);
  };

  assert.deepEqual({ ...innerSource(facts, surface()), range: undefined }, { frontier: 3, range: undefined, stepN: 1, paused: false });
  events.push(...handoff.events);
  assert.deepEqual(
    { ...innerSource(facts, surface()), range: undefined }, { frontier: 3, range: undefined, stepN: 2, paused: true },
    'the unanswered skeleton call pauses the steps already counted',
  );
  events.push(payload, readMessage, ...resumed[0].events);
  const released = innerSource(facts, surface());
  assert.equal(released.frontier, events.indexOf(payload), 'the payload is the new frontier');
  assert.deepEqual({ ...released, range: undefined }, { frontier: events.indexOf(payload), range: undefined, stepN: 1, paused: false });
  events.push(...resumed[1].events);
  assert.equal(innerSource(facts, surface()).stepN, 2, 'counting goes on from the new frontier');
});

// A stock checkpoint over the oldest step that keeps a tail holding a handoff: the skeleton call and the payload message in the order given, then a step of the tail, then a step after the checkpoint.
function keptHandoffSession({ callFirst }) {
  const user = userMessage({ text: 'start' });
  const old = mainStep(1, 1);
  const handoff = mainStep(1, 2, { toolCalls: [SKELETON] });
  const payload = loadMessage({ calls: [call('load_handoff')] });
  const readMessage = loadMessage({ calls: [call('read')] });
  const kept = mainStep(2, 1);
  const checkpoint = compactCheckpoint({ startSeq: user.seq, endSeq: old.result.seq });
  const after = mainStep(3, 1);
  const delivered = callFirst ? [...handoff.events, payload, readMessage] : [payload, readMessage, ...handoff.events];
  return logOf([systemMessage(), turnStart(), user, ...old.events, ...delivered, ...kept.events, checkpoint, ...after.events]);
}

test('a payload after the call in the range releases it though the checkpoint keeps both as ordinary tail source', () => {
  const { nodes, facts } = keptHandoffSession({ callFirst: true });

  assert.equal(innerSource(facts, nodes).paused, false);
});

test('a payload before the call in the range does not release it', () => {
  const { nodes, facts } = keptHandoffSession({ callFirst: false });

  assert.equal(innerSource(facts, nodes).paused, true);
});

test('stepN is computed afresh from the nodes of each call: a seal between two calls drops the steps it replaced', () => {
  const user = userMessage({ text: 'start' });
  const steps = [mainStep(1, 1), mainStep(1, 2), mainStep(1, 3)];
  const events = [systemMessage(), turnStart(), user, ...steps.flatMap(step => step.events)];
  const facts = new Map();
  const surface = () => {
    const log = sessionLog(events);
    for (const event of log) facts.set(event.seq, eventFactOf(event));
    return surfaceOf(log);
  };

  assert.equal(innerSource(facts, surface()).stepN, 3);
  events.push(innerSealCarrier({ sourceEventSeqs: [user, ...steps.flatMap(step => [step.assistant, step.result])].map(event => event.seq) }));
  assert.equal(innerSource(facts, surface()).stepN, 0, 'the seal replaced them');
  events.push(...mainStep(2, 1).events);
  assert.equal(innerSource(facts, surface()).stepN, 1);
});

// A fork of a session in the middle of its second step: the seed holds the prefix with an inherited carrier, marks its cut and closes the open step with an error result that cites the call's execution record; then the fork's own turn.
function forkSession() {
  const user = userMessage({ text: 'start' });
  const carrier = innerSealCarrier({ sourceEventSeqs: [user.seq] });
  const inherited = mainStep(1, 1);
  const open = assistantMessage({ text: 'reading', toolCalls: [{ id: 'call-open', name: 'read' }], turn: 1, step: 2 });
  const execution = toolCall({ callId: 'call-open', name: 'read', turn: 1, step: 2 });
  const closer = { ...toolResult({ callId: 'call-open', text: 'forked', isError: true, turn: 1, step: 2 }), sourceEventSeqs: [execution.seq] };
  const own = mainStep(2, 1);
  const events = [
    systemMessage(), turnStart(), user, carrier, ...inherited.events, stepStart({ turn: 1, step: 2 }), open, execution,
    unknownEvent({ type: 'session/end-seed', data: { inherited: true } }), closer, stepEnd({ turn: 1, step: 2 }),
    turnEnd({ reason: { kind: 'forked' } }), turnStart({ turn: 2 }), userMessage({ text: 'fork task' }), ...own.events,
  ];
  return { ...logOf(events), carrier, inherited, open, closer, own };
}

test('a fork counts the unsealed steps it inherited and the step its seed closed', () => {
  const { nodes, facts, seqOf, carrier, closer } = forkSession();

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, seqOf(carrier), 'the carrier of the inherited prefix is the fork\'s frontier');
  assert.equal(source.stepN, 3, 'the inherited step, the closed step and the fork\'s own');
  assert.ok(source.range.includes(seqOf(closer)));
});

test('a pruner replace is no frontier and moves no step: its node keeps the position of the result it replaced', () => {
  const held = mainStep(1, 1);
  const user = userMessage({ text: 'start' });
  const sealed = mainStep(1, 2);
  const carrier = innerSealCarrier({ sourceEventSeqs: [user, sealed.assistant, sealed.result].map(event => event.seq) });
  const kept = mainStep(2, 1);
  const pruneKept = [compactionPrune(kept.result), prunedResult(kept.result)];
  const pruneHeld = [compactionPrune(held.result), prunedResult(held.result)];
  const base = [systemMessage(), turnStart(), ...held.events, user, ...sealed.events, carrier, ...kept.events];
  const control = logOf(base);
  const events = [...base, ...pruneKept, ...pruneHeld, ...mainStep(2, 2).events];
  const { nodes, facts, seqOf } = logOf(events);

  const source = innerSource(facts, nodes);

  assert.equal(source.frontier, seqOf(carrier), 'neither replacement, though newer than the carrier, is the frontier');
  assert.equal(source.stepN, 2);
  assert.equal(nodes.indexOf(seqOf(pruneKept[1])), control.nodes.indexOf(control.seqOf(kept.result)), 'the replacement stands where the result stood');
  assert.ok(source.range.includes(seqOf(pruneKept[1])) && !source.range.includes(seqOf(kept.result)));
  assert.ok(!source.range.includes(seqOf(pruneHeld[1])), 'the replacement of a result before the frontier stays before it');
});

// ── Slots ────────────────────────────────────────────────────────────────────────────────────────────────────

// The slots over the whole range `innerSource` answers, each as `{ seqs, step? }` in the events' own seqs.
function slotsOf({ nodes, facts }) {
  return skeletonSlots(facts, nodes, innerSource(facts, nodes).range);
}

test('a counted step is one slot of its assistant message and settled tool results, and a user message is a slot of its own', () => {
  const user = userMessage({ text: 'start' });
  const first = mainStep(1, 1);
  const second = mainStep(1, 2);
  const interrupted = assistantMessage({ text: 'partial', interrupted: true, turn: 1, step: 3 });
  const second2 = userMessage({ text: 'and also this' });
  const session = logOf([
    systemMessage(), turnStart(), user, ...first.events, ...second.events, stepStart({ turn: 1, step: 3 }), interrupted, stepEnd({ turn: 1, step: 3 }), second2,
  ]);
  const { seqOf } = session;

  assert.deepEqual(slotsOf(session), [
    { seqs: [seqOf(user)] },
    { seqs: [first.assistant, first.result].map(seqOf), step: { turn: 1, step: 1 } },
    { seqs: [second.assistant, second.result].map(seqOf), step: { turn: 1, step: 2 } },
    { seqs: [seqOf(interrupted)], step: { turn: 1, step: 3 } },
    { seqs: [seqOf(second2)] },
  ]);
});

const developerMessage = ({ turn, step }) => ({
  ...unknownEvent({
    type: 'developer/message',
    data: { turn, step, message: { role: 'developer', content: [{ type: 'text', text: 'context' }], source: { kind: 'user' }, id: 'dev' } },
  }),
  surfaceOp: 'append',
});

test('a step slot also takes the developer and system messages of its turn and step, placed at the first of its sources', () => {
  const user = userMessage({ text: 'start' });
  const context = developerMessage({ turn: 1, step: 1 });
  const prompt = systemMessage({ turn: 1, step: 1 });
  const step = mainStep(1, 1);
  const stranger = developerMessage({ turn: 1, step: 2 });
  const session = logOf([systemMessage(), turnStart(), user, context, prompt, ...step.events, stranger]);
  const { seqOf } = session;

  assert.deepEqual(slotsOf(session), [
    { seqs: [seqOf(user)] },
    { seqs: [context, prompt, step.assistant, step.result].map(seqOf), step: { turn: 1, step: 1 } },
    { seqs: [seqOf(stranger)] },
  ]);
});

test('an empty message makes no slot and no step, and a node whose step the range does not hold stands alone', () => {
  const user = userMessage({ text: 'start' });
  const first = mainStep(1, 1);
  const empty = assistantMessage({ turn: 1, step: 2 });
  const session = logOf([systemMessage(), turnStart(), user, ...first.events, stepStart({ turn: 1, step: 2 }), empty, stepEnd({ turn: 1, step: 2 })]);
  const { facts, nodes, seqOf } = session;

  assert.deepEqual(slotsOf(session).map(slot => slot.seqs), [[seqOf(user)], [first.assistant, first.result].map(seqOf)], 'no slot for the empty message');
  // A range that starts at the result has not selected the step's assistant message.
  assert.deepEqual(skeletonSlots(facts, nodes, [first.result, empty].map(seqOf)), [{ seqs: [seqOf(first.result)] }]);
});

test('an empty message of a counted step stays with the step', () => {
  const step = mainStep(1, 1);
  const trailing = assistantMessage({ turn: 1, step: 1 });
  const session = logOf([systemMessage(), turnStart(), userMessage({ text: 'start' }), ...step.events, trailing]);

  assert.deepEqual(slotsOf(session).at(-1), { seqs: [step.assistant, step.result, trailing].map(session.seqOf), step: { turn: 1, step: 1 } });
});

test('a selected pruner replacement carries the original result it stands for, before its own seq in the slot of its step', () => {
  const user = userMessage({ text: 'start' });
  const step = mainStep(1, 1);
  const prune = [compactionPrune(step.result), prunedResult(step.result)];
  const next = mainStep(1, 2);
  const session = logOf([systemMessage(), turnStart(), user, ...step.events, ...prune, ...next.events]);
  const { seqOf } = session;

  assert.deepEqual(slotsOf(session).slice(1), [
    { seqs: [step.assistant, step.result, prune[1]].map(seqOf), step: { turn: 1, step: 1 } },
    { seqs: [next.assistant, next.result].map(seqOf), step: { turn: 1, step: 2 } },
  ]);
});

test('a carrier, a checkpoint\'s kept tail and a payload are slots anchored to their own events, and the carrier\'s earlier slots are not expanded', () => {
  const session = keptTailSession();
  const { seqOf, payload, carrier, step5, step6, step7 } = session;

  assert.deepEqual(slotsOf(session), [
    { seqs: [seqOf(payload)] },
    { seqs: [seqOf(carrier)] },
    { seqs: [step5.assistant, step5.result].map(seqOf), step: { turn: 3, step: 1 } },
    { seqs: [step6.assistant, step6.result].map(seqOf), step: { turn: 3, step: 2 } },
    { seqs: [step7.assistant, step7.result].map(seqOf), step: { turn: 4, step: 1 } },
  ]);
  assert.equal(slotsOf(session).filter(slot => slot.step).length, innerSource(session.facts, session.nodes).stepN, 'one slot per counted step');
});

test('a fork\'s closing result keeps to its own seq though it cites the call\'s execution record', () => {
  const session = forkSession();
  const { seqOf, open, closer } = session;

  const closed = slotsOf(session).find(slot => slot.step?.step === 2);

  assert.deepEqual(closed, { seqs: [open, closer].map(seqOf), step: { turn: 1, step: 2 } });
});

test('a step stays one slot at its first node when another node lies between its nodes', () => {
  const step = mainStep(1, 1);
  const steer = userMessage({ text: 'while it ran' });
  const session = logOf([systemMessage(), turnStart(), step.events[0], step.assistant, steer, step.result, step.events[3]]);
  const { seqOf } = session;

  assert.deepEqual(slotsOf(session), [
    { seqs: [step.assistant, step.result].map(seqOf), step: { turn: 1, step: 1 } },
    { seqs: [seqOf(steer)] },
  ]);
});

test('a replacement of a replacement carries the original result and the selected replacement, not the replacement in between', () => {
  const user = userMessage({ text: 'start' });
  const step = mainStep(1, 1);
  // A pruner whose budget was tightened after a restart prunes the first replacement again.
  const first = [compactionPrune(step.result), prunedResult(step.result)];
  const second = [compactionPrune(first[1]), prunedResult(first[1])];
  const next = mainStep(1, 2);
  const session = logOf([systemMessage(), turnStart(), user, ...step.events, ...first, ...second, ...next.events]);
  const { nodes, seqOf } = session;

  assert.ok(nodes.includes(seqOf(second[1])) && !nodes.includes(seqOf(first[1])), 'the surface holds the last replacement alone');
  assert.deepEqual(slotsOf(session).slice(1), [
    { seqs: [step.assistant, step.result, second[1]].map(seqOf), step: { turn: 1, step: 1 } },
    { seqs: [next.assistant, next.result].map(seqOf), step: { turn: 1, step: 2 } },
  ]);
});

test('a selected pruner replacement whose step is not counted is a slot of its own with the original before it', () => {
  const step = mainStep(1, 1);
  const prune = [compactionPrune(step.result), prunedResult(step.result)];
  const session = logOf([systemMessage(), turnStart(), ...step.events, ...prune]);
  const { facts, nodes, seqOf } = session;

  assert.deepEqual(skeletonSlots(facts, nodes, [seqOf(prune[1])]), [{ seqs: [step.result, prune[1]].map(seqOf) }]);
});

