// test/measurement-source-fold.test.js — the measurement source fold: per-event batches in log order, and a carrier
// that rewrites the open epoch's batches it seals into what the measurement still takes of them. The inputs are written
// by hand in the shape a harness adapter hands the fold, so the fold is read without any harness reducer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceFold } from '../lib/measurement/source-fold.js';
import * as S from './helpers/source-inputs.js';

const USAGE = S.usage(0, { input: 3, cacheWrite: 9_600 });
const U = n => S.usage(1_000 * n);

// Each batch as its observations' seq, type and effects-only mark.
const coordinates = batches => batches.map(batch => batch.map(observation => [
  observation.sourceOrdinal, observation.type, ...(observation.effectsOnly ? ['effectsOnly'] : []),
]));

const usagesOf = fold => fold.batches().flat().filter(observation => observation.type === 'usage').map(observation => observation.usage.cacheRead);

function pushAll(fold, inputs) {
  return inputs.map(input => fold.push(input));
}

// A question, a step that reads and gets its result, a harness read, and a step that answers.
function turn() {
  return [
    S.quiet(),
    S.question(),
    S.quiet(),
    S.call({ text: 'Reading it.', tools: ['read'], usage: USAGE }),
    S.result('read'),
    S.quiet(),
    S.reads('load'),
    S.call({ text: 'In src/a.js.', usage: USAGE }),
  ];
}

test('push answers each input\'s batch and batches() lists them in log order', () => {
  const log = S.sourceLog(turn());
  const fold = createSourceFold();
  const pushed = pushAll(fold, log);
  assert.deepEqual(pushed.map(answer => answer.batch), log.map(input => {
    if (input.mainCall) return [{ type: 'main-call', sourceOrdinal: input.seq }, ...input.observations];
    return input.observations.length > 0 ? input.observations : null;
  }));
  assert.ok(pushed.every(answer => answer.rewound === false && answer.diagnostics.length === 0));
  assert.deepEqual(fold.batches(), pushed.map(answer => answer.batch).filter(batch => batch !== null));
});

test('a main call opens its batch with a main-call fact, ahead of its text, tool uses and usage', () => {
  const fold = createSourceFold();
  pushAll(fold, S.sourceLog(turn()));
  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[3, 'main-call'], [3, 'text'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result']],
    [[6, 'tool-use'], [6, 'tool-result']],
    [[7, 'main-call'], [7, 'text'], [7, 'usage']],
  ]);
});

test('a main call is a fact whether it carries a usage, a text alone or nothing; an input that is no main call and yields nothing gives no batch, whatever its diagnostics say', () => {
  const diagnostic = { scope: 'adapter', code: 'shape-violation', message: 'malformed usage' };
  const log = S.sourceLog([S.call({ text: 'no count reported' }), S.callWithoutObservations([diagnostic]), S.quiet(), S.result('read')]);
  const seqless = { ...S.sourceLog([S.quiet()])[0], seq: 'x', diagnostics: [diagnostic] };
  const fold = createSourceFold();
  const pushed = pushAll(fold, [...log, seqless]);

  assert.deepEqual(pushed.map(answer => answer.batch?.map(observation => observation.type) ?? null), [
    ['main-call', 'text'], ['main-call'], null, ['tool-result'], null,
  ]);
  assert.deepEqual(pushed.map(answer => answer.diagnostics), [[], [diagnostic], [], [], [diagnostic]]);
  assert.deepEqual(coordinates(fold.batches()), [[[0, 'main-call'], [0, 'text']], [[1, 'main-call']], [[3, 'tool-result']]]);
});

test('a seal keeps tool uses and every main-call fact, marks tool results effects-only and drops turn boundaries, text and the usage of every call but the epoch\'s first', () => {
  const events = turn();
  const carrier = S.seal(...events.slice(1));
  const log = S.sourceLog([...events, carrier]);
  const fold = createSourceFold();
  pushAll(fold, log.slice(0, -1));

  assert.deepEqual(fold.push(log.at(-1)), { batch: null, rewound: true, diagnostics: [] });
  assert.deepEqual(coordinates(fold.batches()), [
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[6, 'tool-use'], [6, 'tool-result', 'effectsOnly']],
    [[7, 'main-call']],
  ]);
});

test('a seal rewrites only the batches it cites', () => {
  const events = turn();
  const carrier = S.seal(events[3], events[4]);
  const log = S.sourceLog([...events, carrier]);
  const fold = createSourceFold();
  pushAll(fold, log);
  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[6, 'tool-use'], [6, 'tool-result']],
    [[7, 'main-call'], [7, 'text'], [7, 'usage']],
  ]);
});

test('a seal does not cross the last epoch boundary, even into a tail the compaction kept, and the epoch it opens keeps its own first call', () => {
  // The compaction replaces the question and the first step and keeps the second step's events, which precede the
  // boundary in the log; the carrier then cites them beside the step after the boundary.
  const head = [S.quiet(), S.question()];
  const kept = [S.call({ tools: ['read'], usage: USAGE }), S.result('read')];
  const checkpoint = S.boundary();
  const after = [S.call({ tools: ['again'], usage: USAGE }), S.result('again')];
  // The boundary is a surface node the carrier shadows too, and it stays.
  const carrier = S.seal(...kept, checkpoint, ...after);
  const log = S.sourceLog([...head, ...kept, checkpoint, ...after, carrier]);
  const fold = createSourceFold();
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

test('a batch is sealed through the seq the carrier lists for it, whatever events with no batch lie between', () => {
  // The result at seq 1 is pruned later and its replacement is a batchless event of its own; the carrier lists the original's seq.
  const events = [S.call({ tools: ['read'], usage: USAGE }), S.result('read'), S.quiet()];
  const replacement = S.quiet();
  const carrier = S.seal(events[0], replacement, events[1]);
  const log = S.sourceLog([...events, replacement, carrier]);
  const fold = createSourceFold();
  pushAll(fold, log);
  assert.deepEqual(coordinates(fold.batches()), [[[0, 'main-call'], [0, 'tool-use'], [0, 'usage']], [[1, 'tool-result', 'effectsOnly']]]);
});

test('a carrier that changes no batch does not rewind', () => {
  const events = turn();
  const first = S.seal(...events.slice(1));
  const again = S.seal(...events.slice(1));
  const batchless = S.seal(events[0], events[2], events[5]);
  const log = S.sourceLog([...events, first, again, batchless]);
  const fold = createSourceFold();
  const pushed = pushAll(fold, log.slice(0, events.length + 1));
  const sealed = coordinates(fold.batches());
  pushed.push(...pushAll(fold, log.slice(events.length + 1)));

  assert.deepEqual(pushed.slice(-3).map(answer => answer.rewound), [true, false, false]);
  assert.deepEqual(coordinates(fold.batches()), sealed);
});

// --- The stage points ---

test('the call right behind a carrier stays through the next seal though admitted input opens its range, and the unsealed calls around it go', () => {
  const first = [
    S.quiet(), S.question(),
    S.call({ text: 'Reading it.', tools: ['read'], usage: U(1) }),
    S.result('read'),
    S.call({ text: 'In src/a.js.', usage: U(2) }),
  ];
  const firstSeal = S.seal(...first.slice(2));
  // The second range opens with the next turn's question, a runtime context and a time reading: the leading input every
  // request after a carrier may carry, ahead of the call the carrier is followed by.
  const second = [
    S.quiet(), S.question(), S.quiet(), S.quiet(),
    S.call({ tools: ['read_2'], usage: U(3) }),
    S.result('read_2'),
    S.call({ text: 'In src/b.js.', usage: U(4) }),
  ];
  const secondSeal = S.seal(...second.slice(1));
  const fold = createSourceFold();
  pushAll(fold, S.sourceLog([...first, firstSeal, ...second, secondSeal]));

  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[2, 'main-call'], [2, 'tool-use'], [2, 'usage']],
    [[3, 'tool-result', 'effectsOnly']],
    [[4, 'main-call']],
    [[10, 'main-call'], [10, 'tool-use'], [10, 'usage']],
    [[11, 'tool-result', 'effectsOnly']],
    [[12, 'main-call']],
  ], 'the first call of the epoch and the call right behind the first carrier stay; the second step of each range goes, its main-call fact stays');
  assert.deepEqual(usagesOf(fold), [1_000, 3_000]);
});

test('events that yield nothing around the seals rewrite nothing: the epoch\'s first call, the call behind the first carrier and the unsealed step stand', () => {
  const head = S.call({ text: 'Reading it.', tools: ['read'], usage: U(1) });
  const result = S.result('read');
  const firstSeal = S.seal(head, result);
  // The head is normalized in place behind the first seal, and the second range opens with the next model step.
  const head2 = S.call({ tools: ['read_2'], usage: U(2) });
  const result2 = S.result('read_2');
  const secondSeal = S.seal(head2, result2);
  // A tool is added behind the second seal; the step that follows is not in any sealed range.
  const tail = S.call({ text: 'In src/b.js.', usage: U(3) });
  const log = S.sourceLog([
    S.quiet(), S.quiet(), S.question(), head, result, firstSeal,
    S.quiet(), head2, result2, secondSeal, S.quiet(), S.quiet(), tail,
  ]);
  const fold = createSourceFold();
  const pushed = pushAll(fold, log);

  assert.ok(pushed.every(answer => answer.diagnostics.length === 0));
  assert.deepEqual(pushed.map(answer => answer.rewound), log.map(input => input.sealed !== undefined));
  assert.deepEqual(coordinates(fold.batches()), [
    [[2, 'turn-boundary'], [2, 'text']],
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[7, 'main-call'], [7, 'tool-use'], [7, 'usage']],
    [[8, 'tool-result', 'effectsOnly']],
    [[12, 'main-call'], [12, 'text'], [12, 'usage']],
  ]);
  assert.deepEqual(usagesOf(fold), [1_000, 2_000, 3_000]);
});

test('the head runs through the first call with a stock: a call that reports none before it stays beside it, and the calls after go', () => {
  // The first call reports no stock at all, so the model it ran on is its alone to give, and the stock that anchors the
  // epoch is the second call's.
  const calls = [
    S.quiet(), S.question(),
    S.call({ text: 'One moment.', usage: S.usage(0, { input: 0, output: 12, cacheWrite: 0 }) }),
    S.call({ text: 'Reading it.', tools: ['read'], usage: U(1) }),
    S.result('read'),
    S.call({ text: 'In src/a.js.', usage: U(2) }),
  ];
  const carrier = S.seal(...calls.slice(2));
  const fold = createSourceFold();
  pushAll(fold, S.sourceLog([...calls, carrier]));

  assert.deepEqual(coordinates(fold.batches()), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[2, 'main-call'], [2, 'usage']],
    [[3, 'main-call'], [3, 'tool-use'], [3, 'usage']],
    [[4, 'tool-result', 'effectsOnly']],
    [[5, 'main-call']],
  ]);
});

test('input admitted late, between the calls of a range, changes no point: the head and the call behind each carrier stand through every seal', () => {
  const call = n => S.call({ text: `step ${n}`, usage: U(n) });
  const late = () => [S.question(), S.quiet(), S.quiet()];
  const [one, two, three, four, five, six] = [1, 2, 3, 4, 5, 6].map(call);
  const first = [S.quiet(), S.question(), one, ...late(), two];
  const firstSeal = S.seal(...first.slice(2));
  const second = [three, ...late(), four, ...late(), five];
  const secondSeal = S.seal(...second);
  const fold = createSourceFold();
  pushAll(fold, S.sourceLog([...first, firstSeal, ...second, secondSeal, ...late(), six]));

  assert.deepEqual(usagesOf(fold), [1_000, 3_000, 6_000]);
});

test('a first call behind the carrier that reports no usage is the post all the same, so the call after it with usage goes with its range', () => {
  const head = S.call({ text: 'one', usage: U(1) });
  const firstSeal = S.seal(head);
  const quiet = S.call({ text: 'no count reported' });
  const counted = S.call({ text: 'three', usage: U(3) });
  const secondSeal = S.seal(quiet, counted);
  const fold = createSourceFold();
  pushAll(fold, S.sourceLog([head, firstSeal, quiet, counted, secondSeal]));

  assert.deepEqual(usagesOf(fold), [1_000]);
});

test('qualifiedCalls reads the open epoch\'s kept usages ahead of the first one no carrier has listed, at the cut of the last input pushed', () => {
  const head = S.call({ usage: S.usage(1_000, { input: 1, cacheWrite: 0 }) });
  const second = S.call({ usage: S.usage(2_000, { input: 1, cacheWrite: 0 }) });
  const carrier = S.seal(head, second);
  const post = S.call({ usage: S.usage(3_000, { input: 1, cacheWrite: 0 }) });
  const pending = S.call({ usage: S.usage(4_000, { input: 1, cacheWrite: 0 }) });
  const log = S.sourceLog([S.quiet(), S.question(), head, second, carrier, post, pending]);
  const fold = createSourceFold();
  assert.equal(fold.qualifiedCalls(), 0);
  const counts = log.map((input) => { fold.push(input); return fold.qualifiedCalls(); });
  assert.deepEqual(counts, [0, 0, 1, 1, 1, 2, 2]);
  const usages = fold.batches().flat().filter(observation => observation.type === 'usage');
  assert.equal(usages.length, 3, 'the head, the post and the pending call are the usages the fold keeps');
});
