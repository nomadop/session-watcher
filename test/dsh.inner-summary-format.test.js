// The notes and the failure category of one summary reply (`summarizeSlots` in `dsh/src/inner-summary.js`), over the real detached `Session`, stream kit and a recording `llm.stream` of the DSH checkout `SW_DSH_CHECKOUT` names, imported from it by file path, and the real `loads` of `ai-json-repair` the plugin face injects as `kit.loads`: which replies the local recovery reads as the notes, and which are a format failure, a category the seal asks again, and which are not. Without the checkout every case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loads } from 'ai-json-repair';

import { summarizeSlots } from '../dsh/src/inner-summary.js';
import { eventFactOf } from '../lib/harness/dsh/event-facts.js';
import { assistantMessage, requestHeader, sessionLog, stepEnd, stepStart, systemMessage, turnEnd, turnStart, userMessage } from './helpers/dsh-events.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SESSION_LIB = 'packages/core/session/lib/index.js';
const LLM_LIB = 'packages/llm/llm/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, SESSION_LIB)) ? `SW_DSH_CHECKOUT names no ${SESSION_LIB}`
  : !existsSync(join(CHECKOUT, LLM_LIB)) ? `SW_DSH_CHECKOUT names no ${LLM_LIB}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);
const [sessionPackage, llmPackage] = skip ? [null, null] : await Promise.all([SESSION_LIB, LLM_LIB].map(fromCheckout));

// `recoveries` keeps the text of each call the kit's `loads` receives.
const kitOf = (recoveries = []) => ({
  AssistantStreamAccumulator: llmPackage.AssistantStreamAccumulator,
  BlockAssembler: llmPackage.BlockAssembler,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
  errorChain: llmPackage.errorChain,
  loads: (text) => {
    recoveries.push(text);
    return loads(text);
  },
});

const SELECTION = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' };
const STOP = { type: 'finish', reason: { kind: 'stop' } };

// A session of one user request and two model steps, whose two steps are the two slots the model is asked for.
function twoSlots() {
  const first = assistantMessage({ text: 'first reply', turn: 1, step: 1 });
  const second = assistantMessage({ text: 'second reply', turn: 1, step: 2 });
  const events = [
    systemMessage(), turnStart(), userMessage({ text: 'please work' }), stepStart({ step: 1 }), requestHeader(), first, stepEnd({ step: 1 }),
    stepStart({ step: 2 }), second, stepEnd({ step: 2 }), turnEnd(),
  ];
  const session = sessionPackage.Session.create('format', sessionLog(events), { version: 4, id: 'format', createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 }, 0);
  const slots = [{ seqs: [events.indexOf(first)], step: { turn: 1, step: 1 } }, { seqs: [events.indexOf(second)], step: { turn: 1, step: 2 } }];
  return { session, slots };
}

async function* chunks(...list) {
  for (const chunk of list) yield chunk;
}

const textReply = (text, ...rest) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  ...rest,
];

// The outcome of one call whose stream is `list`.
async function outcomeOf(list, recoveries = []) {
  const { session, slots } = twoSlots();
  const llm = { stream: () => chunks(...list) };
  return summarizeSlots({
    llm, session, index: new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)])), events: session.snapshotEvents(), selection: SELECTION,
    slots, range: slots.flatMap(slot => slot.seqs), held: { paths: new Map(), skills: new Map() }, signal: new AbortController().signal, kit: kitOf(recoveries),
  });
}

test('a reply that stopped without a tool call and whose text is not exactly a JSON object of one string per slot, keyed "1" to the slot count, is the format failure, whatever way it is wrong', { skip }, async () => {
  const texts = [
    '', 'not json', '["a", "b"]', '"abc"', 'null', '{}', '{"1": "a"}', '{"1": "a", "2": "b", "3": "c"}', '{"1": "a", "3": "b"}', '{"0": "a", "1": "b"}',
    '{"1": "a", "2": 2}', '{"1": "a", "2": null}', '{"1": "a", "2": ["b"]}', '{"1": "a", "2": {"x": "b"}}',
  ];
  for (const text of texts) {
    const outcome = await outcomeOf(textReply(text, STOP));
    assert.equal(outcome.ok, false, JSON.stringify(text));
    assert.equal(outcome.failure, 'format', JSON.stringify(text));
    assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), text, 'the raw text stays in the record');
  }
});

test('a reply that stopped without a tool call and fails JSON syntax alone is recovered once by the local library, its notes mapped to their own slots: the unescaped inner quotes of a quoted array, a quoted object and a quoted slot-like key stay in their note, and the raw stream keeps the reply as it was', { skip }, async () => {
  const cases = [
    ['an array quoted in the note', `{"1": "Found: '["one","two","three"]'.", "2": "second"}`, [`Found: '["one","two","three"]'.`, 'second']],
    ['an object quoted in the note', '{"1": "Found: {"x":"y"}.", "2": "second"}', ['Found: {"x":"y"}.', 'second']],
    ['a slot-like key quoted in the note', '{"1": "Example {"2":"literal"}, not another slot.", "2": "actual second"}', ['Example {"2":"literal"}, not another slot.', 'actual second']],
  ];
  for (const [why, text, notes] of cases) {
    const recoveries = [];
    const outcome = await outcomeOf(textReply(text, STOP), recoveries);
    assert.equal(outcome.ok, true, why);
    assert.deepEqual(outcome.summaries, notes, why);
    assert.equal('failure' in outcome, false, why);
    assert.deepEqual(recoveries, [text], `${why}: one local recovery over the whole reply`);
    assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), text, `${why}: the raw text stays in the record`);
  }
});

test('a reply that is legal JSON is read as it stands and never reaches the library: the notes object with surrounding whitespace, reordered keys and empty notes carries no failure category', { skip }, async () => {
  for (const text of ['{"1": "a", "2": "b"}', '\n  {"2": "b", "1": "a"}\n', '{"1": "", "2": "b"}']) {
    const recoveries = [];
    const outcome = await outcomeOf(textReply(text, STOP), recoveries);
    assert.equal(outcome.ok, true, JSON.stringify(text));
    assert.equal('failure' in outcome, false);
    assert.deepEqual(recoveries, [], `${JSON.stringify(text)}: the library is not asked`);
  }
});

test('a reply that is a tool call is the format failure, like a text that is not the notes: a finish of tool-calls and a stop with a tool call block, whatever the text beside the call says', { skip }, async () => {
  const valid = '{"1": "a", "2": "b"}';
  const invalid = 'not the notes';
  const toolCall = { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } };
  const finishedWithCalls = { type: 'finish', reason: { kind: 'tool-calls' } };
  for (const [why, list] of [
    ['a tool-calls finish, a malformed text', textReply(invalid, finishedWithCalls)],
    ['a tool-calls finish, a well-formed text', textReply(valid, finishedWithCalls)],
    ['a tool-calls finish, no text', [finishedWithCalls]],
    ['a tool call beside a well-formed text, stopped', [...textReply(valid), toolCall, STOP]],
    ['a tool call beside a malformed text, stopped', [...textReply(invalid), toolCall, STOP]],
  ]) {
    const outcome = await outcomeOf(list);
    assert.equal(outcome.ok, false, why);
    assert.equal(outcome.failure, 'format', why);
    assert.equal(outcome.summaries, undefined, why);
  }
});

test('every other way a summary call fails is no format failure: a stream that threw, one with no finish chunk and a finish that is neither a stop nor tool-calls', { skip }, async () => {
  const valid = '{"1": "a", "2": "b"}';
  const invalid = 'not the notes';
  const cases = [
    ['no chunk at all', []],
    ['no finish chunk, a well-formed text', textReply(valid)],
    ['no finish chunk, a malformed text', textReply(invalid)],
    ['an error finish', textReply(invalid, { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream said no', code: 'provider_error' } } })],
    ['an aborted finish', textReply(invalid, { type: 'finish', reason: { kind: 'aborted', failure: { message: 'caller left', code: 'aborted' } } })],
    ['a max-tokens finish', textReply(invalid, { type: 'finish', reason: { kind: 'max-tokens' } })],
  ];
  for (const [why, list] of cases) {
    const outcome = await outcomeOf(list);
    assert.equal(outcome.ok, false, why);
    assert.equal('failure' in outcome, false, why);
  }

  const { session, slots } = twoSlots();
  const thrown = await summarizeSlots({
    llm: { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('the connection reset')) }) }) },
    session, index: new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)])), events: session.snapshotEvents(), selection: SELECTION,
    slots, range: slots.flatMap(slot => slot.seqs), held: { paths: new Map(), skills: new Map() }, signal: new AbortController().signal, kit: kitOf(),
  });
  assert.equal(thrown.ok, false);
  assert.equal('failure' in thrown, false, 'a stream that threw');
  assert.match(thrown.reason, /the connection reset/);
});

test('a stream whose finish is an error naming the content filter is the filter failure, and no other finish is, whatever its message says', { skip }, async () => {
  const stop = 'Provider stopped with: content_filtered';
  const filtered = await outcomeOf(textReply('{"1": "par', { type: 'finish', reason: { kind: 'error', failure: { message: stop, code: 'PI_AI_ERROR' } } }));
  assert.equal(filtered.ok, false);
  assert.equal(filtered.failure, 'filtered');
  assert.match(filtered.reason, /finished with error: Provider stopped with: content_filtered$/);

  for (const [why, finish] of [
    ['an aborted finish', { kind: 'aborted', failure: { message: stop, code: 'aborted' } }],
    ['a max-tokens finish', { kind: 'max-tokens', failure: { message: stop, code: 'x' } }],
    ['an error finish with another message', { kind: 'error', failure: { message: 'Provider stopped with: overloaded', code: 'PI_AI_ERROR' } }],
    ['an error finish with no failure', { kind: 'error' }],
  ]) {
    const outcome = await outcomeOf(textReply('{"1": "par', { type: 'finish', reason: finish }));
    assert.equal(outcome.ok, false, why);
    assert.equal('failure' in outcome, false, why);
  }
});
