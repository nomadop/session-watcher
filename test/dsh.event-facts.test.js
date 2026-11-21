// The semantic facts of DSH events (`lib/harness/dsh/event-facts.js`): what one event gives the seal's trigger and slots, and the originals a log's pruner replacements stand for.
import test from 'node:test';
import assert from 'node:assert/strict';

import { eventFactOf, eventFactsOf, TURN_SKELETON_TOOL } from '../lib/harness/dsh/event-facts.js';
import { createTools } from '../dsh/src/tools.js';
import {
  userMessage, assistantMessage, toolResult, loadMessage, compactCheckpoint, innerSealCarrier, systemMessage, turnStart,
  attempt, toolCall, sessionLog, stepStart, stepEnd, unknownEvent, compactionPrune, prunedResult, requestHeader,
} from './helpers/dsh-events.js';

// The facts of an event that is none of the kinds a fact names, with `rest` set; `owner` is the event's own turn and step.
const fact = (event, rest = {}) => ({
  system: false, header: false, marker: null, epoch: false, step: null, owner: { turn: event.data?.turn, step: event.data?.step }, assistant: false, skeletonCall: false, ...rest,
});
const factOf = (event, rest) => [eventFactOf(event), fact(event, rest)];

test('eventFactOf names the system head, the request header and the carrier and checkpoint markers', () => {
  for (const event of [userMessage({ text: 'hello' }), toolResult({ callId: 'c1', text: 'ok' }), turnStart({ turn: 4 })]) assert.deepEqual(...factOf(event));
  assert.deepEqual(...factOf(systemMessage(), { system: true }));
  assert.deepEqual(...factOf(requestHeader(), { header: true }));
  assert.deepEqual(...factOf(compactCheckpoint({ startSeq: 1, endSeq: 2 }), { marker: 'checkpoint', epoch: true }));
  assert.deepEqual(...factOf(innerSealCarrier({ sourceEventSeqs: [1, 2] }), { marker: 'carrier' }));
});

test('a marker holds of a user/message alone: another event whose message carries a marker\'s source is none', () => {
  const carrier = innerSealCarrier({ sourceEventSeqs: [1] });
  const checkpoint = compactCheckpoint({ startSeq: 1, endSeq: 2 });
  const payload = loadMessage({ calls: [call('load_handoff')] });
  for (const source of [carrier, checkpoint, payload].map(event => event.data.source)) {
    const reply = assistantMessage({ text: 'done' });
    const result = toolResult({ callId: 'c1', text: 'ok' });
    assert.equal(eventFactOf({ ...reply, data: { ...reply.data, message: { ...reply.data.message, source } } }).marker, null);
    assert.equal(eventFactOf({ ...result, data: { ...result.data, message: { ...result.data.message, source } } }).marker, null);
    assert.equal(eventFactOf({ type: 'developer/message', seq: 9, time: 0, data: { role: 'developer', content: [], source } }).marker, null);
  }
});

function call(name, id = `sw-load-${name}`) {
  return { id, name, arguments: '{}', text: `${name} result` };
}
const withSource = (event, source) => ({ ...event, data: { ...event.data, source } });

test('a load message is a payload marker when its first call is the delivery, and a read message is none whatever the kind', () => {
  const payload = loadMessage({ calls: [call('load_handoff')] });
  const read = loadMessage({ calls: [call('read')] });
  assert.deepEqual(...factOf(payload, { marker: 'payload' }));
  assert.deepEqual(...factOf(read), 'a read message carries the load kind and is no marker');
  // `isLoadPayload` reads the first call: a pre-split message holding the delivery then a read is still the payload, and a delivery that is not the first call is not.
  assert.equal(eventFactOf(loadMessage({ calls: [call('load_handoff'), call('read')] })).marker, 'payload');
  assert.equal(eventFactOf(loadMessage({ calls: [call('read'), call('load_handoff')] })).marker, null);
  assert.equal(eventFactOf(withSource(payload, { kind: 'session-watcher-load' })).marker, null, 'no calls, no delivery');
  assert.equal(eventFactOf(withSource(payload, { ...payload.data.source, kind: 'user' })).marker, null, 'the delivery call outside the load kind');
});

test('only a non-empty assistant/message is a step, named by its turn and step; an attempt, an empty message and other events are not', () => {
  assert.deepEqual(...factOf(assistantMessage({ text: 'done', turn: 2, step: 3 }), { assistant: true, step: { turn: 2, step: 3 } }));
  const calling = eventFactOf(assistantMessage({ toolCalls: [{ id: 'c1', name: 'read' }], turn: 5, step: 1 }));
  assert.deepEqual(calling.step, { turn: 5, step: 1 }, 'a message holding only a tool call is a step');
  const cut = eventFactOf(assistantMessage({ text: 'partial', interrupted: true, turn: 1, step: 4 }));
  assert.deepEqual(cut.step, { turn: 1, step: 4 }, 'an interrupted response keeps its prefix and is a step');
  const empty = eventFactOf(assistantMessage({ turn: 1, step: 2 }));
  assert.equal(empty.step, null, 'a message with no block is no step');
  assert.equal(empty.assistant, true, 'an empty message is still an assistant message');
  assert.deepEqual(...factOf(attempt({ turn: 1, step: 2 })), 'a failed attempt appended no message');
  assert.equal(eventFactOf(toolResult({ callId: 'c1', text: 'ok', turn: 1, step: 2 })).step, null, 'a tool result is no step of its own');
});

test('the owner of an event is the turn and step its data names, whether or not it completes a step', () => {
  assert.deepEqual(eventFactOf(toolResult({ callId: 'c1', text: 'ok', turn: 3, step: 2 })).owner, { turn: 3, step: 2 });
  assert.deepEqual(eventFactOf(systemMessage({ turn: 2, step: 5 })).owner, { turn: 2, step: 5 });
  assert.deepEqual(eventFactOf(assistantMessage({ turn: 4, step: 1 })).owner, { turn: 4, step: 1 }, 'an empty message too');
  assert.deepEqual(eventFactOf(userMessage({ text: 'hello' })).owner, { turn: undefined, step: undefined }, 'a user message names none');
});

test('only a tool-call block of an assistant/message naming get_turn_skeleton is a skeleton call', () => {
  const skeleton = { id: 'c-skel', name: 'get_turn_skeleton' };
  assert.equal(eventFactOf(assistantMessage({ toolCalls: [skeleton] })).skeletonCall, true);
  assert.equal(eventFactOf(assistantMessage({ text: 'handing off', toolCalls: [{ id: 'c1', name: 'read' }, skeleton] })).skeletonCall, true, 'among other calls');
  assert.equal(eventFactOf(assistantMessage({ toolCalls: [{ id: 'c2', name: 'submit_turn_notes' }, { id: 'c3', name: 'read' }] })).skeletonCall, false);
  assert.equal(eventFactOf(assistantMessage({ text: 'I will call get_turn_skeleton' })).skeletonCall, false, 'the name in text is no call');
  assert.equal(eventFactOf(toolCall({ callId: 'c-skel', name: 'get_turn_skeleton' })).skeletonCall, false, 'the log-only tool/call is not on the surface');
  assert.equal(eventFactOf(userMessage({ text: 'get_turn_skeleton' })).skeletonCall, false);
});

test('a malformed assistant/message gives the facts of an event with no step and no call, and throws nothing', () => {
  const messageWith = content => ({ role: 'assistant', content, source: { kind: 'model' } });
  const absent = { type: 'assistant/message', seq: 4, time: 0, data: { turn: 1, step: 1 } };
  const text = { type: 'assistant/message', seq: 5, time: 0, data: { turn: 1, step: 1, message: messageWith('text') } };
  const hollow = { type: 'assistant/message', seq: 6, time: 0, data: { turn: 1, step: 1, message: messageWith([null, 3]) } };

  for (const event of [absent, text]) assert.deepEqual(...factOf(event, { assistant: true }));
  assert.equal(eventFactOf(hollow).skeletonCall, false, 'blocks that are no objects name no call');
  assert.deepEqual(eventFactOf({ type: 'user/message', seq: 7, time: 0 }).marker, null, 'an event with no data is no marker');
});

test('only a replacing compact checkpoint opens a Context Epoch: an inner-seal carrier, a checkpoint that appends and a malformed replacement do not', () => {
  const checkpoint = compactCheckpoint({ startSeq: 1, endSeq: 2 });
  assert.equal(eventFactOf(checkpoint).epoch, true);
  assert.equal(eventFactOf(innerSealCarrier({ sourceEventSeqs: [1, 2] })).epoch, false);
  assert.equal(eventFactOf({ ...checkpoint, surfaceOp: 'append' }).epoch, false, 'an append replaces nothing');
  assert.equal(eventFactOf({ ...checkpoint, time: undefined }).epoch, false, 'the reducer states no boundary for a malformed envelope');
  assert.equal(eventFactOf(userMessage({ text: 'hello' })).epoch, false);
});

// ── The facts of a log ───────────────────────────────────────────────────────────────────────────────────────

function mainStep(turn, step) {
  const callId = `call-${turn}-${step}`;
  const assistant = assistantMessage({ turn, step, text: `step ${step} of turn ${turn}`, toolCalls: [{ id: callId, name: 'read' }] });
  const result = toolResult({ callId, text: 'ok', turn, step });
  return { events: [stepStart({ turn, step }), assistant, result, stepEnd({ turn, step })], assistant, result };
}

test('eventFactsOf gives each event of a log its eventFactOf facts, the originals of a pruner replacement beside them and none beside any other', () => {
  const step = mainStep(1, 1);
  const prune = [compactionPrune(step.result), prunedResult(step.result)];
  const events = [systemMessage(), turnStart(), userMessage({ text: 'start' }), ...step.events, ...prune];
  const log = sessionLog(events);
  const seqOf = event => events.indexOf(event);

  const facts = eventFactsOf(log);

  assert.deepEqual([...facts.keys()], log.map(event => event.seq));
  for (const event of log) {
    const { originals, ...rest } = facts.get(event.seq);
    assert.deepEqual(rest, eventFactOf(event));
    assert.deepEqual(originals, event.seq === seqOf(prune[1]) ? [seqOf(step.result)] : []);
  }
});

test('the originals of a replacement of a replacement are the original result alone, not the replacement in between', () => {
  const step = mainStep(1, 1);
  // A pruner whose budget was tightened after a restart prunes the first replacement again.
  const first = [compactionPrune(step.result), prunedResult(step.result)];
  const second = [compactionPrune(first[1]), prunedResult(first[1])];
  const events = [systemMessage(), turnStart(), ...step.events, ...first, ...second];
  const seqOf = event => events.indexOf(event);

  const facts = eventFactsOf(sessionLog(events));

  assert.deepEqual(facts.get(seqOf(second[1])).originals, [seqOf(step.result)]);
  assert.deepEqual(facts.get(seqOf(first[1])).originals, [seqOf(step.result)]);
});

test('a fork\'s closing result cites the call\'s execution record and appends, so it stands for no original', () => {
  const open = assistantMessage({ text: 'reading', toolCalls: [{ id: 'call-open', name: 'read' }], turn: 1, step: 2 });
  const execution = toolCall({ callId: 'call-open', name: 'read', turn: 1, step: 2 });
  const closer = { ...toolResult({ callId: 'call-open', text: 'forked', isError: true, turn: 1, step: 2 }), sourceEventSeqs: [execution.seq] };
  const events = [systemMessage(), stepStart({ turn: 1, step: 2 }), open, execution, unknownEvent({ type: 'session/end-seed', data: { inherited: true } }), closer];

  assert.deepEqual(eventFactsOf(sessionLog(events)).get(events.indexOf(closer)).originals, []);
});

test('the pause names the tool the host registers', () => {
  const definitions = createTools({ defineTool: definition => definition, table: {}, store: {} });

  assert.ok(definitions.some(definition => definition.name === TURN_SKELETON_TOOL));
});
