// test/dsh.source-fold.test.js — the DSH measurement source fold: per-event batches in log order, and an inner-seal
// carrier that rewrites the open epoch's batches it cites into what the measurement still takes of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshSourceFold } from '../lib/harness/dsh/source-fold.js';
import { reduceDshEvent } from '../lib/harness/dsh/transcript-observation.js';
import * as E from './helpers/dsh-events.js';

const USAGE = { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 };
const READ = { id: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' };

// Each batch as its observations' seq, type and effects-only mark.
const coordinates = batches => batches.map(batch => batch.map(observation => [
  observation.sourceOrdinal, observation.type, ...(observation.effectsOnly ? ['effectsOnly'] : []),
]));

function pushAll(fold, events) {
  return events.map(event => fold.push(event));
}

// A question, a step that reads and gets its result, a load, and a step that answers.
function turn() {
  return [
    E.turnStart(),
    E.userMessage({ text: 'Where is a defined?' }),
    E.stepStart({ step: 1 }),
    E.assistantMessage({ step: 1, text: 'Reading it.', toolCalls: [READ], usage: USAGE }),
    E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' }),
    E.stepEnd({ step: 1 }),
    E.loadMessage(),
    E.assistantMessage({ step: 2, text: 'In src/a.js.', usage: USAGE }),
  ];
}

test('push answers each event\'s batch and batches() lists them in log order', () => {
  const events = E.sessionLog(turn());
  const fold = createDshSourceFold();
  const pushed = pushAll(fold, events);
  assert.deepEqual(pushed.map(answer => answer.batch), events.map(event => {
    const { observations } = reduceDshEvent(event);
    if (event.type === 'assistant/message') return [{ type: 'main-call', sourceOrdinal: event.seq }, ...observations];
    return observations.length > 0 ? observations : null;
  }));
  assert.ok(pushed.every(answer => answer.rewound === false && answer.diagnostics.length === 0));
  assert.deepEqual(fold.batches(), pushed.map(answer => answer.batch).filter(batch => batch !== null));
});

test('an assistant message opens its batch with a main-call fact, ahead of its text, tool uses and usage', () => {
  const fold = createDshSourceFold();
  pushAll(fold, E.sessionLog(turn()));
  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[3, 'main-call'], [3, 'text'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result']],
    [[6, 'tool-use'], [6, 'tool-result']],
    [[7, 'main-call'], [7, 'text'], [7, 'usage']],
  ]);
});

test('a main call is a fact whether its message reports usage, a malformed one or none; an attempt, a tool result and a message with no seq give none', () => {
  const quiet = E.assistantMessage({ step: 1, text: 'no count reported' });
  const malformed = E.assistantMessage({ step: 2, text: 'bad count', usage: { inputTokens: 'many', outputTokens: 1 } });
  const failed = E.attempt({ step: 3, usageChunk: USAGE, finish: 'error' });
  const result = E.toolResult({ step: 3, callId: READ.id, text: 'export const a = 1;' });
  const seqless = { ...E.assistantMessage({ step: 4, text: 'no seq', usage: USAGE }), seq: 'x' };
  const fold = createDshSourceFold();
  const pushed = pushAll(fold, [...E.sessionLog([quiet, malformed, failed, result]), seqless]);

  assert.deepEqual(pushed.map(answer => answer.batch?.map(observation => observation.type) ?? null), [
    ['main-call', 'text'], ['main-call'], null, ['tool-result'], null,
  ]);
  assert.deepEqual(pushed.map(answer => answer.diagnostics.map(diagnostic => diagnostic.code)), [[], ['shape-violation'], [], [], ['shape-violation']]);
  assert.deepEqual(coordinates(fold.batches()), [[[0, 'main-call'], [0, 'text']], [[1, 'main-call']], [[3, 'tool-result']]]);
});

test('a withdrawal keeps tool uses and every main-call fact, marks tool results effects-only and drops turn boundaries, text and the usage of every call but the epoch\'s first', () => {
  const events = turn();
  const carrier = E.innerSealCarrier({ sourceEventSeqs: events.slice(1).map(event => event.seq) });
  const log = E.sessionLog([...events, carrier]);
  const fold = createDshSourceFold();
  pushAll(fold, log.slice(0, -1));

  assert.deepEqual(fold.push(log.at(-1)), { batch: null, rewound: true, diagnostics: [] });
  assert.deepEqual(coordinates(fold.batches()), [
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[6, 'tool-use'], [6, 'tool-result', 'effectsOnly']],
    [[7, 'main-call']],
  ]);
});

test('a withdrawal rewrites only the batches it cites', () => {
  const events = turn();
  const carrier = E.innerSealCarrier({ sourceEventSeqs: [events[3].seq, events[4].seq] });
  const log = E.sessionLog([...events, carrier]);
  const fold = createDshSourceFold();
  pushAll(fold, log);
  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[6, 'tool-use'], [6, 'tool-result']],
    [[7, 'main-call'], [7, 'text'], [7, 'usage']],
  ]);
});

test('a withdrawal does not cross the last epoch boundary, even into a tail the compaction kept, and the epoch it opens keeps its own first call', () => {
  // The compaction replaces the question and the first step and keeps the second step's events, which precede the
  // checkpoint in the log; the carrier then cites them beside the step after the checkpoint.
  const head = [E.turnStart(), E.userMessage({ text: 'Work on the module.' })];
  const kept = [
    E.assistantMessage({ step: 1, toolCalls: [READ], usage: USAGE }),
    E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' }),
  ];
  const checkpoint = E.compactCheckpoint({ startSeq: head[0].seq, endSeq: head.at(-1).seq });
  const after = [
    E.assistantMessage({ step: 2, toolCalls: [{ ...READ, id: 'call_again' }], usage: USAGE }),
    E.toolResult({ step: 2, callId: 'call_again', text: 'export const a = 1;' }),
  ];
  // The checkpoint is a surface node the carrier shadows too, and its boundary stays.
  const carrier = E.innerSealCarrier({ sourceEventSeqs: [...kept, checkpoint, ...after].map(event => event.seq) });
  const log = E.sessionLog([...head, ...kept, checkpoint, ...after, carrier]);
  const fold = createDshSourceFold();
  const pushed = pushAll(fold, log);

  assert.equal(pushed.at(-1).rewound, true);
  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[2, 'main-call'], [2, 'tool-use'], [2, 'usage']],
    [[3, 'tool-result']],
    [[4, 'epoch-boundary']],
    [[5, 'main-call'], [5, 'tool-use'], [5, 'usage']],
    [[6, 'tool-result', 'effectsOnly']],
  ]);
});

test('a pruned original is withdrawn through the seq the carrier lists for it', () => {
  const original = E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' });
  const events = [
    E.assistantMessage({ step: 1, toolCalls: [READ], usage: USAGE }),
    original,
    E.compactionPrune(original),
  ];
  const replacement = E.prunedResult(original);
  const carrier = E.innerSealCarrier({ sourceEventSeqs: [events[0].seq, replacement.seq, original.seq] });
  const log = E.sessionLog([...events, replacement, carrier]);
  const fold = createDshSourceFold();
  pushAll(fold, log);
  assert.deepEqual(coordinates(fold.batches()), [[[0, 'main-call'], [0, 'tool-use'], [0, 'usage']], [[1, 'tool-result', 'effectsOnly']]]);
});

test('a carrier that changes no batch does not rewind', () => {
  const events = turn();
  const first = E.innerSealCarrier({ sourceEventSeqs: events.slice(1).map(event => event.seq) });
  const again = E.innerSealCarrier({ sourceEventSeqs: events.slice(1).map(event => event.seq) });
  const batchless = E.innerSealCarrier({ sourceEventSeqs: [events[0].seq, events[2].seq, events[5].seq] });
  const log = E.sessionLog([...events, first, again, batchless]);
  const fold = createDshSourceFold();
  const pushed = pushAll(fold, log);
  const withdrawn = coordinates(fold.batches());

  assert.deepEqual(pushed.slice(-3).map(answer => answer.rewound), [true, false, false]);
  assert.deepEqual(coordinates(fold.batches()), withdrawn);
});

test('a malformed carrier hands on its diagnostic and changes nothing', () => {
  const events = turn();
  const carrier = { ...E.innerSealCarrier({ sourceEventSeqs: [events[3].seq] }), sourceEventSeqs: 'all' };
  const log = E.sessionLog([...events, carrier]);
  const fold = createDshSourceFold();
  pushAll(fold, log.slice(0, -1));
  const before = coordinates(fold.batches());
  const answer = fold.push(log.at(-1));
  assert.equal(answer.rewound, false);
  assert.deepEqual(answer.diagnostics.map(diagnostic => diagnostic.code), ['shape-violation']);
  assert.deepEqual(coordinates(fold.batches()), before);
});

// --- The stage points ---

test('the call right behind a carrier stays through the next seal though admitted input opens its range, and the unsealed calls around it go', () => {
  const U = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
  const READ_2 = { ...READ, id: 'call_read_2' };
  const first = [
    E.turnStart(), E.userMessage({ text: 'Where is a defined?' }),
    E.assistantMessage({ step: 1, text: 'Reading it.', toolCalls: [READ], usage: U(1) }),
    E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' }),
    E.assistantMessage({ step: 2, text: 'In src/a.js.', usage: U(2) }),
  ];
  const firstSeal = E.innerSealCarrier({ sourceEventSeqs: first.slice(2).map(event => event.seq) });
  // The second range opens with the next turn's question, a runtime context and a time reading: the leading input every
  // request after a carrier may carry, ahead of the call the carrier is followed by.
  const second = [
    E.turnStart({ turn: 2 }), E.userMessage({ text: 'And b?' }),
    E.userMessage({ text: 'ctx', kind: 'runtime-context' }), E.userMessage({ text: 'now', kind: 'time-context' }),
    E.assistantMessage({ turn: 2, step: 1, toolCalls: [READ_2], usage: U(3) }),
    E.toolResult({ turn: 2, step: 1, callId: READ_2.id, text: 'export const b = 2;' }),
    E.assistantMessage({ turn: 2, step: 2, text: 'In src/b.js.', usage: U(4) }),
  ];
  const secondSeal = E.innerSealCarrier({ sourceEventSeqs: second.slice(1).map(event => event.seq) });
  const log = E.sessionLog([...first, firstSeal, ...second, secondSeal]);
  const fold = createDshSourceFold();
  pushAll(fold, log);

  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[2, 'main-call'], [2, 'tool-use'], [2, 'usage']],
    [[3, 'tool-result', 'effectsOnly']],
    [[4, 'main-call']],
    [[10, 'main-call'], [10, 'tool-use'], [10, 'usage']],
    [[11, 'tool-result', 'effectsOnly']],
    [[12, 'main-call']],
  ], 'the first call of the epoch and the call right behind the first carrier stay; the second step of each range goes, its main-call fact stays');
  assert.deepEqual(fold.batches().flat().filter(observation => observation.type === 'usage').map(observation => observation.usage.cacheRead), [1_000, 3_000]);
});

test('a replaced system head and a changed tool declaration around the seals withdraw nothing: the epoch\'s first call, the call behind the first carrier and the unsealed step stand', () => {
  const U = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
  const READ_2 = { ...READ, id: 'call_read_2' };
  const system = E.systemMessage();
  const head = E.assistantMessage({ step: 1, text: 'Reading it.', toolCalls: [READ], usage: U(1) });
  const result = E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' });
  const firstSeal = E.innerSealCarrier({ sourceEventSeqs: [head.seq, result.seq] });
  // The head is normalized in place behind the first seal, and the second range opens with the next model step.
  const replacement = E.systemReplacement({ seq: system.seq, text: 'You are a coding agent. Terse.' });
  const head2 = E.assistantMessage({ step: 2, toolCalls: [READ_2], usage: U(2) });
  const result2 = E.toolResult({ step: 2, callId: READ_2.id, text: 'export const b = 2;' });
  const secondSeal = E.innerSealCarrier({ sourceEventSeqs: [head2.seq, result2.seq] });
  // A tool is added behind the second seal; the step that follows is not in any sealed range.
  const changed = E.requestHeader({ reason: 'change' });
  const registry = E.toolRegistryMessage({ additions: ['grep'], headerSeq: changed.seq });
  const tail = E.assistantMessage({ step: 3, text: 'In src/b.js.', usage: U(3) });
  const log = E.sessionLog([
    system, E.turnStart(), E.userMessage({ text: 'Where is a defined?' }), head, result, firstSeal,
    replacement, head2, result2, secondSeal, changed, registry, tail,
  ]);
  const fold = createDshSourceFold();
  const pushed = pushAll(fold, log);

  assert.ok(pushed.every(answer => answer.diagnostics.length === 0));
  assert.deepEqual(pushed.map(answer => answer.rewound), log.map(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace'));
  assert.deepEqual(coordinates(fold.batches()), [
    [[2, 'turn-boundary'], [2, 'text']],
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[7, 'main-call'], [7, 'tool-use'], [7, 'usage']],
    [[8, 'tool-result', 'effectsOnly']],
    [[12, 'main-call'], [12, 'text'], [12, 'usage']],
  ]);
  assert.deepEqual(fold.batches().flat().filter(observation => observation.type === 'usage').map(observation => observation.usage.cacheRead), [1_000, 2_000, 3_000]);
});

test('the head runs through the first call with a stock: a call that reports none before it stays beside it, and the calls after go', () => {
  const U = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
  // The first call reports no stock at all, so the model it ran on is its alone to give, and the stock that anchors the
  // epoch is the second call's.
  const calls = [
    E.turnStart(), E.userMessage({ text: 'Where is a defined?' }),
    E.assistantMessage({ step: 1, text: 'One moment.', usage: { inputTokens: 0, outputTokens: 12 } }),
    E.assistantMessage({ step: 2, text: 'Reading it.', toolCalls: [READ], usage: U(1) }),
    E.toolResult({ step: 2, callId: READ.id, text: 'export const a = 1;' }),
    E.assistantMessage({ step: 3, text: 'In src/a.js.', usage: U(2) }),
  ];
  const carrier = E.innerSealCarrier({ sourceEventSeqs: calls.slice(2).map(event => event.seq) });
  const fold = createDshSourceFold();
  pushAll(fold, E.sessionLog([...calls, carrier]));

  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[2, 'main-call'], [2, 'usage']],
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[5, 'main-call']],
  ]);
});

test('input admitted late, between the calls of a range, changes no point: the head and the call behind each carrier stand through every seal', () => {
  const U = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
  const call = n => E.assistantMessage({ step: n, text: `step ${n}`, usage: U(n) });
  const late = () => [E.userMessage({ text: 'Also the notes.' }), E.userMessage({ text: 'ctx', kind: 'runtime-context' }), E.userMessage({ text: 'now', kind: 'time-context' })];
  const [one, two, three, four, five, six] = [1, 2, 3, 4, 5, 6].map(call);
  const first = [E.turnStart(), E.userMessage({ text: 'Where is a defined?' }), one, ...late(), two];
  const firstSeal = E.innerSealCarrier({ sourceEventSeqs: first.slice(2).map(event => event.seq) });
  const second = [three, ...late(), four, ...late(), five];
  const secondSeal = E.innerSealCarrier({ sourceEventSeqs: second.map(event => event.seq) });
  const fold = createDshSourceFold();
  pushAll(fold, E.sessionLog([...first, firstSeal, ...second, secondSeal, ...late(), six]));

  assert.deepEqual(fold.batches().flat().filter(observation => observation.type === 'usage').map(observation => observation.usage.cacheRead), [1_000, 3_000, 6_000]);
});

test('a first call behind the carrier that reports no usage is the post all the same, so the call after it with usage goes with its range', () => {
  const U = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
  const head = E.assistantMessage({ step: 1, text: 'one', usage: U(1) });
  const firstSeal = E.innerSealCarrier({ sourceEventSeqs: [head.seq] });
  const quiet = E.assistantMessage({ step: 2, text: 'no count reported' });
  const counted = E.assistantMessage({ step: 3, text: 'three', usage: U(3) });
  const secondSeal = E.innerSealCarrier({ sourceEventSeqs: [quiet.seq, counted.seq] });
  const fold = createDshSourceFold();
  pushAll(fold, E.sessionLog([head, firstSeal, quiet, counted, secondSeal]));

  assert.deepEqual(fold.batches().flat().filter(observation => observation.type === 'usage').map(observation => observation.usage.cacheRead), [1_000]);
});

test('qualifiedCalls reads the open epoch\'s kept usages ahead of the first one no carrier has listed, at the cut of the last event pushed', () => {
  const usage = cacheRead => ({ inputTokens: 1, outputTokens: 40, cacheReadTokens: cacheRead, cacheWriteTokens: 0 });
  const head = E.assistantMessage({ step: 1, usage: usage(1_000) });
  const second = E.assistantMessage({ step: 2, usage: usage(2_000) });
  const carrier = E.innerSealCarrier({ sourceEventSeqs: [head.seq, second.seq] });
  const post = E.assistantMessage({ step: 3, usage: usage(3_000) });
  const pending = E.assistantMessage({ step: 4, usage: usage(4_000) });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, second, carrier, post, pending]);
  const fold = createDshSourceFold();
  assert.equal(fold.qualifiedCalls(), 0);
  const counts = log.map((event) => { fold.push(event); return fold.qualifiedCalls(); });
  assert.deepEqual(counts, [0, 0, 1, 1, 1, 2, 2]);
  const usages = fold.batches().flat().filter(observation => observation.type === 'usage');
  assert.equal(usages.length, 3, 'the head, the post and the pending call are the usages the fold keeps');
});
