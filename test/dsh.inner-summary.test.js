// The inner seal's auxiliary call (`dsh/src/inner-summary.js`) against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: the real detached `Session` the call reads its history from, the real stream kit and the real `appendPluginRecord`, over a recording `llm.stream`. Without the checkout every case skips but the display of a request, which reads no DSH package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { requestDisplayOf, summarizeSlots } from '../dsh/src/inner-summary.js';
import { eventFactOf } from '../lib/harness/dsh/event-facts.js';
import {
  assistantMessage, innerSealCarrier, loadMessage, requestHeader, sessionLog, stepEnd, stepStart, systemMessage, toolRegistryMessage, toolResult, turnEnd, turnStart,
  userMessage,
} from './helpers/dsh-events.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const SESSION_LIB = 'packages/core/session/lib/index.js';
const LLM_LIB = 'packages/llm/llm/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, SESSION_LIB)) ? `SW_DSH_CHECKOUT names no ${SESSION_LIB}`
  : !existsSync(join(CHECKOUT, LLM_LIB)) ? `SW_DSH_CHECKOUT names no ${LLM_LIB}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);
const [sessionPackage, llmPackage] = skip ? [null, null] : await Promise.all([SESSION_LIB, LLM_LIB].map(fromCheckout));

const kitOf = () => ({
  AssistantStreamAccumulator: llmPackage.AssistantStreamAccumulator,
  BlockAssembler: llmPackage.BlockAssembler,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
  errorChain: llmPackage.errorChain,
  appendPluginRecord: sessionPackage.appendPluginRecord,
});

// The index the host's feed keeps for `session`: the `seq → eventFactOf` Map of its events, each later event added as it commits.
const indexOf = session => new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)]));

// The held view of a call whose tail names nothing held.
const NO_HELD = { paths: new Map(), skills: new Map() };

const TOOLS = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];
const SELECTION = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' };

// A log whose first turn an inner seal already replaced, so its carrier is ordinary source of the next range: system head, the carrier standing for the first turn, then a second turn of one user message and one model step. `seqOf` names an event's seq in the log; the log is held as a detached `Session`, whose `session/end-seed` marker closes it.
function sealedSession() {
  const system = systemMessage();
  const firstTurn = turnStart({ turn: 1 });
  const firstAsk = userMessage({ text: 'first request' });
  const firstStep = stepStart({ turn: 1, step: 1 });
  const firstHeader = requestHeader();
  const firstReply = assistantMessage({ text: 'first reply', turn: 1, step: 1 });
  const firstStepEnd = stepEnd({ turn: 1, step: 1 });
  const firstTurnEnd = turnEnd({ turn: 1 });
  const carrier = innerSealCarrier({ sourceEventSeqs: [firstAsk.seq, firstReply.seq], text: 'the earlier seal said: first request was answered' });
  const secondTurn = turnStart({ turn: 2 });
  const secondAsk = userMessage({ text: 'second request' });
  const secondStep = stepStart({ turn: 2, step: 1 });
  const header = requestHeader({ reason: 'change' });
  const headerWithTools = { ...header, data: { ...header.data, header: { ...header.data.header, tools: TOOLS } } };
  const secondReply = assistantMessage({ text: 'second reply', turn: 2, step: 1 });
  const secondStepEnd = stepEnd({ turn: 2, step: 1 });
  const events = [
    system, firstTurn, firstAsk, firstStep, firstHeader, firstReply, firstStepEnd, firstTurnEnd, carrier, secondTurn, secondAsk, secondStep,
    headerWithTools, secondReply, secondStepEnd,
  ];
  const log = sessionLog(events);
  const seqOf = event => events.indexOf(event);
  const session = sessionPackage.Session.create(
    'inner-summary', log, { version: 4, id: 'inner-summary', createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 }, 0,
  );
  return { session, seqOf, carrier, secondAsk, secondReply, headerWithTools };
}

// A recording `llm`: `stream(options)` keeps the options it was called with and answers `script(options)`.
function recordingLlm(script) {
  const calls = [];
  return { calls, stream(options) { calls.push(options); return script(options); } };
}

async function* chunks(...list) {
  for (const chunk of list) yield chunk;
}

// The rows of a C tail: its `[i]` lines, the unnumbered `user, no note` lines and their `  text:` / `  call` continuation lines, in order.
const rowLinesOf = tail => tail.content[0].text.split('\n').filter(line => /^(\[\d+\] |user, no note: |  text: |  call )/u.test(line));

test('the call streams the pre-step selection over the derived history and one tail message, with the header tools, tool history, session id, purpose and signal, and no output cap', { skip }, async () => {
  const { session, seqOf, carrier, secondAsk, secondReply } = sealedSession();
  const llm = recordingLlm(() => chunks());
  const signal = new AbortController().signal;
  const slots = [{ seqs: [seqOf(carrier)] }, { seqs: [seqOf(secondAsk)] }, { seqs: [seqOf(secondReply)], step: { turn: 2, step: 1 } }];

  await summarizeSlots({ llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal, held: NO_HELD, kit: kitOf() });

  assert.equal(llm.calls.length, 1);
  const [options] = llm.calls;
  const derived = session.deriveMessages();
  assert.ok(derived.some(message => message.source?.kind === 'session-watcher-inner-seal'), 'the earlier carrier stands in the derived history');
  assert.deepEqual(options.messages.slice(0, -1), derived, 'the history is the derived one, the old carrier among it');
  assert.equal(options.messages.length, derived.length + 1);
  const tail = options.messages.at(-1);
  assert.equal(tail.role, 'user');
  assert.equal(tail.content.length, 1);
  assert.equal(tail.content[0].type, 'text');
  assert.deepEqual(rowLinesOf(tail), [
    '[1] harness: "the earlier seal said: first request was answered"',
    'user, no note: "second request"',
    '[2] assistant step',
    '  text: "second reply"',
  ]);
  assert.match(tail.content[0].text, /"1" to "2"/u, 'the user\'s own slot takes no number');
  assert.equal(/\{rows\}|\{N\}|\{held\}/u.test(tail.content[0].text), false, 'the template holds no placeholder once it is filled');
  assert.deepEqual(
    { ...options, messages: undefined },
    {
      provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high', messages: undefined, tools: TOOLS,
      toolHistory: session.toolHistory(), sessionId: 'inner-summary', purpose: 'inner-compaction', signal,
    },
  );
  assert.equal('maxTokens' in options, false);
});

// Synthetic work: a user request, a failing test run, a read and a search in one step, a skill load, and an edit with a rerun. `slots` are those the skeleton makes of it.
function locatingSession() {
  const ask = userMessage({ text: '只改 parser，不动 CLI。先跑测试看哪里挂。' });
  const run = assistantMessage({ text: '先跑 parser 的测试。', step: 1, toolCalls: [{ id: 'call-run', name: 'bash', arguments: '{"command":"npm test -- parser"}' }] });
  const failed = toolResult({ callId: 'call-run', step: 1, isError: true, text: '✖ parseDate returns null for "" (expected Error)\n  at test/parser.test.js:18' });
  const inspect = assistantMessage({
    step: 2,
    toolCalls: [{ id: 'call-read', name: 'read', arguments: '{"path":"src/parser.js"}' }, { id: 'call-grep', name: 'grep', arguments: '{"pattern":"parseDate","path":"src"}' }],
  });
  const readText = toolResult({ callId: 'call-read', step: 2, text: 'export function parseDate(s) {\n  if (!s) return null;\n}' });
  const grepText = toolResult({ callId: 'call-grep', step: 2, text: 'src/parser.js:31: export function parseDate(s) {' });
  const skill = userMessage({
    kind: 'skill-load',
    text: '<skill_content name="tdd"> Use when implementing a fix … write the failing test first … </skill_content>',
  });
  const fix = assistantMessage({
    text: '改为对空串抛错。测试通过，未提交。', step: 3,
    toolCalls: [
      { id: 'call-edit', name: 'edit', arguments: JSON.stringify({ path: 'src/parser.js', old_string: 'export function parseDate(s) {\n  if (!s) return null;', new_string: 'export function parseDate(s) {\n  if (!s) throw new Error(\'empty\');' }) },
      { id: 'call-rerun', name: 'bash', arguments: '{"command":"npm test -- parser"}' },
    ],
  });
  const edited = toolResult({ callId: 'call-edit', step: 3, text: 'edited src/parser.js' });
  const passed = toolResult({ callId: 'call-rerun', step: 3, text: '14 passing' });
  const events = [
    systemMessage(), turnStart(), ask, stepStart({ step: 1 }), run, failed, stepEnd({ step: 1 }), stepStart({ step: 2 }), inspect, readText, grepText,
    stepEnd({ step: 2 }), skill, stepStart({ step: 3 }), fix, edited, passed, stepEnd({ step: 3 }), turnEnd(),
  ];
  const session = sessionPackage.Session.create('locating', sessionLog(events), { version: 4, id: 'locating', createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 }, 0);
  const at = event => events.indexOf(event);
  const slots = [
    { seqs: [at(ask)] },
    { seqs: [at(run), at(failed)], step: { turn: 1, step: 1 } },
    { seqs: [at(inspect), at(readText), at(grepText)], step: { turn: 1, step: 2 } },
    { seqs: [at(skill)] },
    { seqs: [at(fix), at(edited), at(passed)], step: { turn: 1, step: 3 } },
  ];
  return { session, events, slots, at };
}

test('the tail names each slot by cues the request carries: who wrote a user or harness message and its text, and for an assistant step its text and each call by id, name, outcome and arguments\' text, in slot order and without the slots\' seqs, turns or steps', { skip }, async () => {
  const { session, slots } = locatingSession();
  const llm = recordingLlm(() => chunks());

  await summarizeSlots({ llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf() });

  const tail = llm.calls[0].messages.at(-1);
  assert.deepEqual(rowLinesOf(tail), [
    'user, no note: "只改 parser，不动 CLI。先跑测试看哪里挂。"',
    '[1] assistant step',
    '  text: "先跑 parser 的测试。"',
    '  call call-run bash → error: "npm test -- parser"',
    '[2] assistant step',
    '  text: none',
    '  call call-read read → ok: "src/parser.js"',
    '  call call-grep grep → ok: "parseDate src"',
    '[3] harness: "<skill_content name=\\"tdd\\"> Use… test first … </skill_content>"',
    '[4] assistant step',
    '  text: "改为对空串抛错。测试通过，未提交。"',
    `  call call-edit edit → ok: "src/parser.js export function …(!s) throw new Error('empty');"`,
    '  call call-rerun bash → ok: "npm test -- parser"',
  ]);
  const text = tail.content[0].text;
  assert.match(text, /"1" to "4"/u);
  assert.equal(text.includes('parseDate returns null'), false, 'a tool result\'s body is not a cue');
  assert.equal(/seq|turn \d|step \d/u.test(rowLinesOf(tail).join('\n')), false);
});

// The row lines the tail makes of the log `events` for `slotsOf(at)`, the slots over the seqs the log gives the events.
async function rowsOfLog(events, slotsOf, { range } = {}) {
  const session = detached('rows', events);
  const at = event => events.indexOf(event);
  const slots = slotsOf(at);
  const llm = recordingLlm(() => chunks());
  await summarizeSlots({
    llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range: range?.(at) ?? slots.flatMap(slot => slot.seqs),
    signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });
  return rowLinesOf(llm.calls[0].messages.at(-1));
}

// The rows of one assistant step that made `calls` (`{ id?, name, arguments }`), each call answered by no result.
const callRows = async (calls, text) => {
  const reply = assistantMessage({ text, step: 1, toolCalls: calls.map((call, index) => ({ id: `call-${index}`, ...call })) });
  return rowsOfLog([systemMessage(), turnStart(), stepStart(), reply, stepEnd(), turnEnd()], at => [{ seqs: [at(reply)], step: { turn: 1, step: 1 } }]);
};

test('a call\'s arguments cue is cut at a code point, so a surrogate pair is never split at either end of the ellipsis', { skip }, async () => {
  const rows = await callRows([{ name: 'emoji', arguments: JSON.stringify({ edge: `a${'😀'.repeat(40)}b` }) }]);

  assert.deepEqual(rows, ['[1] assistant step', '  text: none', `  call call-0 emoji → ok: "a${'😀'.repeat(14)}…${'😀'.repeat(14)}b"`]);
});

test('a text cue joins the text blocks of the slot\'s message with nothing between them, leaves reasoning out, folds runs of whitespace to one space, and is whole up to the width and its opening and ending beyond it; a message without text is none in a step and an empty string elsewhere', { skip }, async () => {
  const joined = assistantMessage({ step: 1 });
  joined.data.message.content = [
    { type: 'text', text: 'alpha ' }, { type: 'reasoning', text: 'hidden thought' }, { type: 'text', text: 'beta' },
    { type: 'tool-call', id: 'c1', name: 'noop', arguments: '{}' },
  ];
  const folded = assistantMessage({ text: ' a \n\t b   c\n', step: 2 });
  const whole = assistantMessage({ text: '0123456789'.repeat(6), step: 3 });
  const cut = assistantMessage({ text: `${'0123456789'.repeat(6)}X`, step: 4 });
  const silent = assistantMessage({ step: 5, toolCalls: [{ id: 'c5', name: 'noop' }] });
  const blank = userMessage({});
  const rows = await rowsOfLog(
    [systemMessage(), turnStart(), stepStart(), joined, stepEnd(), stepStart({ step: 2 }), folded, stepEnd({ step: 2 }), stepStart({ step: 3 }), whole, stepEnd({ step: 3 }),
      stepStart({ step: 4 }), cut, stepEnd({ step: 4 }), stepStart({ step: 5 }), silent, stepEnd({ step: 5 }), blank, turnEnd()],
    at => [
      { seqs: [at(joined)], step: { turn: 1, step: 1 } }, { seqs: [at(folded)], step: { turn: 1, step: 2 } }, { seqs: [at(whole)], step: { turn: 1, step: 3 } },
      { seqs: [at(cut)], step: { turn: 1, step: 4 } }, { seqs: [at(silent)], step: { turn: 1, step: 5 } }, { seqs: [at(blank)] },
    ],
  );

  assert.deepEqual(rows, [
    '[1] assistant step', '  text: "alpha beta"', '  call c1 noop → ok',
    '[2] assistant step', '  text: " a b c "',
    '[3] assistant step', '  text: "012345678901234567890123456789012345678901234567890123456789"',
    '[4] assistant step', '  text: "012345678901234567890123456789…12345678901234567890123456789X"',
    '[5] assistant step', '  text: none', '  call c5 noop → ok',
    'user, no note: ""',
  ]);
});

test('a call is an error exactly when the step\'s tool result with its id says so: a result of another id, a failure flag that is false or a call with no result make it ok, and a developer message in the step adds no cue', { skip }, async () => {
  const reply = assistantMessage({
    step: 1, text: 'trying', toolCalls: [{ id: 'first', name: 'one' }, { id: 'second', name: 'two' }, { id: 'third', name: 'three' }],
  });
  const first = toolResult({ callId: 'first', step: 1, text: 'fine', isError: false });
  const second = toolResult({ callId: 'second', step: 1, text: 'boom', isError: true });
  const stray = toolResult({ callId: 'elsewhere', step: 1, text: 'other', isError: true });
  const notice = toolRegistryMessage({ removals: ['gone'] });
  notice.data.message.content.push({ type: 'text', text: 'DEVELOPER NOTICE' });
  const rows = await rowsOfLog(
    [systemMessage(), turnStart(), stepStart(), reply, first, second, stray, notice, stepEnd(), turnEnd()],
    at => [{ seqs: [at(reply), at(first), at(second), at(stray), at(notice)], step: { turn: 1, step: 1 } }],
  );

  assert.deepEqual(rows, ['[1] assistant step', '  text: "trying"', '  call first one → ok', '  call second two → error', '  call third three → ok']);
});

test('a slot of one tool result is a row of its kind alone, a load or injected message is a harness row and a user message a user row, and a seq outside the range adds no cue', { skip }, async () => {
  const lone = toolResult({ callId: 'lone', text: 'the whole file body', isError: true });
  const load = loadMessage();
  const asked = userMessage({ text: 'a real ask' });
  const kept = assistantMessage({ text: 'inside the range', step: 1 });
  const withdrawn = assistantMessage({ text: 'withdrawn original', step: 1 });
  const rows = await rowsOfLog(
    [systemMessage(), turnStart(), lone, load, asked, stepStart(), withdrawn, kept, stepEnd(), turnEnd()],
    at => [{ seqs: [at(lone)] }, { seqs: [at(load)] }, { seqs: [at(asked)] }, { seqs: [at(withdrawn), at(kept)], step: { turn: 1, step: 1 } }],
    { range: at => [at(lone), at(load), at(asked), at(kept)] },
  );

  assert.deepEqual(rows, ['[1] tool result of call lone', '[2] harness: "{\\"found\\":true}"', 'user, no note: "a real ask"', '[3] assistant step', '  text: "inside the range"']);
});

const FINISH_STOP = { type: 'finish', reason: { kind: 'stop' } };

// A well-formed reply: the text arrives in two deltas of one block, then usage and a successful stop.
function reply(text, ...rest) {
  const cut = Math.floor(text.length / 2);
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, cut) },
    { type: 'text-delta', index: 0, text: text.slice(cut) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...rest,
  ];
}

const slotsOf = ({ carrier, secondAsk, secondReply }, seqOf) => [
  { seqs: [seqOf(carrier)] }, { seqs: [seqOf(secondAsk)] }, { seqs: [seqOf(secondReply)], step: { turn: 2, step: 1 } },
];

// The notes object of a reply over those slots: the user's own slot takes its verbatim note and no number, so the model's two notes are keyed "1" and "2".
const NOTES = '{"1": "a", "2": "b"}';
const SUMMARIES = ['a', 'user: second request', 'b'];

test('a successful stop with a notes object of one string per slot the model is asked for answers the summaries, the user\'s own slot keeping its verbatim note and an empty note taking its step\'s text cue, and the call record data, which carries the stream as the accumulator recorded it', { skip }, async () => {
  const fixture = sealedSession();
  const { session, seqOf, headerWithTools } = fixture;
  const usage = { type: 'usage', usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 600 } };
  const llm = recordingLlm(() => chunks(...reply('{"1": "asked once", "2": ""}', usage, FINISH_STOP)));
  const slots = slotsOf(fixture, seqOf);
  const range = [...slots.flatMap(slot => slot.seqs), 99];
  const logLength = session.seq;

  const outcome = await summarizeSlots({ llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range, signal: new AbortController().signal, held: NO_HELD, kit: kitOf() });

  assert.equal(outcome.ok, true);
  assert.equal(session.seq, logLength, 'the call appends nothing to the log');
  assert.deepEqual(outcome.summaries, ['asked once', 'user: second request', '"second reply"'], 'the empty note of the last slot is its step\'s text cue');
  const { call } = outcome;
  assert.deepEqual(Object.keys(call).sort(), ['endedAt', 'input', 'purpose', 'range', 'selection', 'stream', 'v']);
  assert.equal(typeof call.endedAt, 'number');
  assert.equal(call.v, 1);
  assert.equal(call.purpose, 'inner-compaction');
  assert.deepEqual(call.selection, SELECTION);
  assert.deepEqual(call.range, range, 'the range is the one the caller supplied, whole');
  assert.deepEqual(call.input, {
    throughSeq: session.snapshotEvents().at(-1).seq, headerSeq: seqOf(headerWithTools), tail: llm.calls[0].messages.at(-1),
  });
  assert.equal(llmPackage.joinAssistantStreamText(call.stream), '{"1": "asked once", "2": ""}');
  assert.deepEqual(llmPackage.lastAssistantStreamChunk(call.stream, 'finish'), FINISH_STOP);
  assert.deepEqual(llmPackage.assistantStreamChunks(call.stream, 'usage'), [usage]);
  assert.deepEqual(llmPackage.assembleAssistantStream(call.stream).blocks(), [{ type: 'text', text: '{"1": "asked once", "2": ""}' }]);
});

// The outcome of a call whose stream is `list`, over the fixture session and its three slots.
async function outcomeOf(list, { slots, selection = SELECTION } = {}) {
  const fixture = sealedSession();
  const llm = recordingLlm(() => chunks(...list));
  const used = slots ?? slotsOf(fixture, fixture.seqOf);
  const outcome = await summarizeSlots({
    llm, session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection, slots: used, range: used.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });
  return { outcome, fixture, llm };
}

test('a stream that ends without a finish chunk is a failure, however well-formed its text, and keeps what was observed', { skip }, async () => {
  const usage = { type: 'usage', usage: { inputTokens: 900, outputTokens: 30 } };
  const { outcome } = await outcomeOf(reply(NOTES, usage));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.summaries, undefined);
  assert.match(outcome.reason, /finish/u);
  assert.equal(llmPackage.lastAssistantStreamChunk(outcome.call.stream, 'finish'), undefined, 'no finish is made up for the record');
  assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), NOTES);
  assert.deepEqual(llmPackage.assistantStreamChunks(outcome.call.stream, 'usage'), [usage]);
  assert.equal('thrown' in outcome.call, false);
});

test('a stream with no chunk at all is a failure that still answers its call record data', { skip }, async () => {
  const { outcome } = await outcomeOf([]);

  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.call.stream, []);
  assert.equal(outcome.call.v, 1);
});

test('a finish other than a successful stop is a failure that names it, with the stream kept: error and aborted carry the provider failure, a cap and a tool-call stop carry their kind', { skip }, async () => {
  const failure = { message: 'upstream said no', code: 'provider_error' };
  const cases = [
    [{ kind: 'error', failure }, /error.*upstream said no/u],
    [{ kind: 'aborted', failure: { message: 'caller left', code: 'aborted' } }, /aborted.*caller left/u],
    [{ kind: 'max-tokens' }, /max-tokens/u],
    [{ kind: 'tool-calls' }, /tool-calls/u],
  ];
  for (const [kind, expected] of cases) {
    const finish = { type: 'finish', reason: kind };
    const { outcome, llm } = await outcomeOf(reply(NOTES, finish));
    assert.equal(outcome.ok, false, kind.kind);
    assert.equal(llm.calls.length, 1, `${kind.kind}: a failed call is not retried`);
    assert.match(outcome.reason, expected, kind.kind);
    assert.deepEqual(llmPackage.lastAssistantStreamChunk(outcome.call.stream, 'finish'), finish, kind.kind);
    assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), NOTES, kind.kind);
  }
});

test('a tool call anywhere in a stream that stopped is a failure, however the adapter spelled it', { skip }, async () => {
  const text = reply(NOTES);
  const call = { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' };
  const spellings = {
    'block start': [{ type: 'block-start', index: 1, blockType: 'tool-call' }],
    'argument delta': [{ type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' }],
    'block end': [{ type: 'block-end', index: 1, block: call }],
  };
  for (const [name, spelling] of Object.entries(spellings)) {
    const { outcome } = await outcomeOf([...text, ...spelling, FINISH_STOP]);
    assert.equal(outcome.ok, false, name);
    assert.match(outcome.reason, /tool call/u, name);
    assert.deepEqual(llmPackage.lastAssistantStreamChunk(outcome.call.stream, 'finish'), FINISH_STOP, name);
  }
});

// An async iterable whose consumption throws `error` once its `delivered` chunks have been read: at the very first `next()` when there are none.
function throwingStream(error, ...delivered) {
  return {
    [Symbol.asyncIterator]() {
      let next = 0;
      return {
        next: () => (next < delivered.length ? Promise.resolve({ done: false, value: delivered[next++] }) : Promise.reject(error)),
      };
    },
  };
}

// The call record data as the real `appendPluginRecord` takes it, read back from the log it was appended to.
function appended(call) {
  const target = sessionPackage.Session.create(
    'call-record', undefined, { version: 4, id: 'call-record', createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 }, 0,
  );
  const seq = kitOf().appendPluginRecord(target, 'plugin:session-watcher/inner-seal-call', call);
  return sessionPackage.pluginRecordOf(target.eventAt(seq)).data;
}

test('a throw outside the stream on the first next() answers an empty stream and the thrown message as plain data', { skip }, async () => {
  const fixture = sealedSession();
  const error = new TypeError('fetch failed', { cause: new Error('socket hang up') });
  const llm = recordingLlm(() => throwingStream(error));
  const slots = slotsOf(fixture, fixture.seqOf);
  const logLength = fixture.session.seq;

  const outcome = await summarizeSlots({
    llm, session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });

  assert.equal(outcome.ok, false);
  assert.equal(llm.calls.length, 1, 'a failed call is not retried');
  assert.equal(fixture.session.seq, logLength, 'and appends nothing');
  assert.match(outcome.reason, /fetch failed: socket hang up/u);
  assert.deepEqual(outcome.call.stream, []);
  assert.deepEqual(outcome.call.thrown, { message: 'fetch failed: socket hang up' });
});

test('the record of a call that threw on its first next() is accepted by the real appendPluginRecord and reads back whole', { skip }, async () => {
  const fixture = sealedSession();
  const llm = recordingLlm(() => throwingStream(new TypeError('fetch failed', { cause: new Error('socket hang up') })));
  const slots = slotsOf(fixture, fixture.seqOf);

  const { call } = await summarizeSlots({
    llm, session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });

  assert.deepEqual(appended(call), JSON.parse(JSON.stringify(call)));
});

test('a throw after some chunks keeps those chunks beside the thrown message, and an AbortError thrown from the stream is a throw like any other', { skip }, async () => {
  const fixture = sealedSession();
  const slots = slotsOf(fixture, fixture.seqOf);
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const llm = recordingLlm(() => throwingStream(aborted, { type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: '{"1": "a' }));

  const outcome = await summarizeSlots({
    llm, session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });

  assert.equal(outcome.ok, false);
  assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), '{"1": "a');
  assert.deepEqual(outcome.call.thrown, { message: 'This operation was aborted' });
  assert.deepEqual(appended(outcome.call), JSON.parse(JSON.stringify(outcome.call)));
});

test('a failure before the stream is consumed rejects with no call record data: a throwing derivation, a synchronous stream() throw, an iterable that refuses an iterator', { skip }, async () => {
  const fixture = sealedSession();
  const slots = slotsOf(fixture, fixture.seqOf);
  const call = (llm, session = fixture.session) => summarizeSlots({
    llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });

  const deriving = Object.create(fixture.session, { deriveMessages: { value() { throw new Error('derive boom'); } } });
  const underived = recordingLlm(() => chunks());
  await assert.rejects(call(underived, deriving), /derive boom/u);
  assert.equal(underived.calls.length, 0, 'nothing is streamed from a history that could not be derived');

  await assert.rejects(call(recordingLlm(() => { throw new Error('stream boom'); })), /stream boom/u);
  const refusing = { [Symbol.asyncIterator]() { throw new Error('iterator boom'); } };
  await assert.rejects(call(recordingLlm(() => refusing)), /iterator boom/u);
});

test('known, zero and missing usage stay as the stream gave them in the record: nothing is filled in beside a stop and nothing is dropped as falsy', { skip }, async () => {
  const known = { type: 'usage', usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 600, cacheWriteTokens: 100 } };
  const zero = { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
  const usageOf = async (...usage) => {
    const { outcome } = await outcomeOf(reply(NOTES, ...usage, FINISH_STOP));
    assert.equal(outcome.ok, true);
    return llmPackage.assistantStreamChunks(outcome.call.stream, 'usage');
  };

  assert.deepEqual(await usageOf(known), [known]);
  assert.deepEqual(await usageOf(zero), [zero]);
  assert.deepEqual(await usageOf(), [], 'a stream that reported none leaves none in the record');
});

test('reasoning fragments are not part of the summary text', { skip }, async () => {
  const thinking = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'maybe {"1": "x"} fits' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'maybe {"1": "x"} fits' } },
  ];
  const text = reply(NOTES).map(chunk => ('index' in chunk ? { ...chunk, index: 1 } : chunk));

  const { outcome } = await outcomeOf([...thinking, ...text, FINISH_STOP]);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.summaries, SUMMARIES);
});

test('a selection that names no reasoning effort sends none and records none, whether the key is absent or explicitly undefined, and the real appendPluginRecord takes the record', { skip }, async () => {
  for (const selection of [{ provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: undefined }]) {
    const fixture = sealedSession();
    const llm = recordingLlm(() => chunks(...reply(NOTES, FINISH_STOP)));
    const slots = slotsOf(fixture, fixture.seqOf);

    const outcome = await summarizeSlots({
      llm, session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
    });

    assert.equal('reasoningEffort' in llm.calls[0], false);
    assert.deepEqual(outcome.call.selection, { provider: 'deepseek', model: 'deepseek-v4-pro' });
    assert.equal('reasoningEffort' in outcome.call.selection, false);
    assert.deepEqual(appended(outcome.call), JSON.parse(JSON.stringify(outcome.call)));
  }
});

const detached = (id, events) => sessionPackage.Session.create(
  id, sessionLog(events), { version: 4, id, createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 }, 0,
);

test('a history with no request header, or a header that holds no tools, sends no tools; the record names no header seq only in the first case', { skip }, async () => {
  const slots = [{ seqs: [2] }];
  const headerless = detached('headerless', [systemMessage(), turnStart({ turn: 1 }), userMessage({ text: 'ask' })]);
  const toolless = detached('toolless', [systemMessage(), turnStart({ turn: 1 }), userMessage({ text: 'ask' }), requestHeader()]);
  const results = [];
  for (const session of [headerless, toolless]) {
    const llm = recordingLlm(() => chunks(...reply('{}', FINISH_STOP)));
    const outcome = await summarizeSlots({ llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range: [2], signal: new AbortController().signal, held: NO_HELD, kit: kitOf() });
    assert.equal('tools' in llm.calls[0], false);
    results.push(outcome.call.input.headerSeq);
  }

  assert.deepEqual(results, [null, 3]);
});

test('the history, the cut and the header seq are those at the call: an event appended while the stream is consumed, a request header included, changes none of them', { skip }, async () => {
  const fixture = sealedSession();
  const { session, seqOf, headerWithTools } = fixture;
  const slots = slotsOf(fixture, fixture.seqOf);
  const index = indexOf(session);
  const before = { cut: session.snapshotEvents().at(-1).seq, derived: session.deriveMessages() };
  const llm = recordingLlm(() => (async function* () {
    kitOf().appendPluginRecord(session, 'plugin:session-watcher/noted', { v: 1 });
    const header = session.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, reason: 'change' });
    index.set(header.seq, eventFactOf(header));
    yield* reply(NOTES, FINISH_STOP);
  })());

  const outcome = await summarizeSlots({
    llm, session, index, events: session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });

  assert.equal(session.snapshotEvents().at(-1).seq, before.cut + 2, 'the events were appended during consumption');
  assert.equal(outcome.call.input.throughSeq, before.cut);
  assert.equal(outcome.call.input.headerSeq, seqOf(headerWithTools));
  assert.deepEqual(llm.calls[0].messages.slice(0, -1), before.derived);
});

test('the header seq is the live index\'s latest, not the frozen slice\'s: a header appended after the slice was taken and before the call is the one named', { skip }, async () => {
  const fixture = sealedSession();
  const { session, seqOf, headerWithTools } = fixture;
  const slots = slotsOf(fixture, fixture.seqOf);
  const frozen = session.snapshotEvents();
  const index = indexOf(session);
  const header = session.append('request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, reason: 'change' });
  index.set(header.seq, eventFactOf(header));
  assert.ok(header.seq > seqOf(headerWithTools) && !frozen.some(event => event.seq === header.seq), 'fixture: the slice holds the earlier header alone');

  const outcome = await summarizeSlots({
    llm: recordingLlm(() => chunks(...reply(NOTES, FINISH_STOP))), session, index, events: frozen, selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });

  assert.equal(outcome.call.input.headerSeq, header.seq);
});

// The chunks of a text block at `index`, optionally opened and with its deltas and its closing block as given.
const openText = index => ({ type: 'block-start', index, blockType: 'text' });
const textDelta = (index, text) => ({ type: 'text-delta', index, text });
const closeText = (index, text) => ({ type: 'block-end', index, block: { type: 'text', text } });

test('the summary text is what DSH assembles: a text block closed by block-end with no delta counts', { skip }, async () => {
  const { outcome } = await outcomeOf([openText(0), closeText(0, NOTES), FINISH_STOP]);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.summaries, SUMMARIES);
  assert.deepEqual(llmPackage.assembleAssistantStream(outcome.call.stream).blocks(), [{ type: 'text', text: NOTES }]);
});

test('a text or tool-call delta that arrives after its block closed is ignored, as the assembler ignores it, and the raw stream keeps it', { skip }, async () => {
  const straggler = [textDelta(0, 'junk'), { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{}' }];
  const { outcome } = await outcomeOf([...reply(NOTES), ...straggler, FINISH_STOP]);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.summaries, SUMMARIES);
  assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), `${NOTES}junk`, 'the straggler stays in the record');
  assert.deepEqual(llmPackage.assembleAssistantStream(outcome.call.stream).blocks(), [{ type: 'text', text: NOTES }]);
});

test('a closed block that is not a summary fails the call whatever its deltas said, which stay in the record', { skip }, async () => {
  const { outcome } = await outcomeOf([openText(0), textDelta(0, '{"1": "x", "2": "y"}'), closeText(0, 'not a summary'), FINISH_STOP]);

  assert.equal(outcome.ok, false, 'valid deltas do not rescue an invalid closed block');
  assert.match(outcome.reason, /JSON object of 2 strings/u);
  assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), '{"1": "x", "2": "y"}');
  assert.deepEqual(llmPackage.assembleAssistantStream(outcome.call.stream).blocks(), [{ type: 'text', text: 'not a summary' }]);
});

test('a closed block that is a summary carries the call whatever its deltas said, which stay in the record', { skip }, async () => {
  const { outcome } = await outcomeOf([openText(0), textDelta(0, 'streamed noise'), closeText(0, NOTES), FINISH_STOP]);

  assert.equal(outcome.ok, true, 'invalid deltas do not sink a valid closed block');
  assert.deepEqual(outcome.summaries, SUMMARIES);
  assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), 'streamed noise');
});

test('text blocks join in the order their indexes first appear, whatever order their deltas interleave in', { skip }, async () => {
  const { outcome } = await outcomeOf([
    openText(0), openText(1),
    textDelta(0, '{"1": "a"'), textDelta(1, ' "b"}'), textDelta(0, ', "2":'),
    closeText(0, '{"1": "a", "2":'), closeText(1, ' "b"}'),
    FINISH_STOP,
  ]);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.summaries, SUMMARIES);
});

test('a stream with deltas and no block markers at all is read from its deltas', { skip }, async () => {
  const { outcome } = await outcomeOf([textDelta(0, '{"1": "a", '), textDelta(0, '"2": "b"}'), FINISH_STOP]);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.summaries, SUMMARIES);
});

test('chunks DSH cannot assemble fail the call but keep it consumed: the record keeps the whole stream and the assembly error, and the real appendPluginRecord takes it', { skip }, async () => {
  const unfinished = { type: 'block-start', index: 1, blockType: 'image' };
  const { outcome, llm } = await outcomeOf([...reply(NOTES), unfinished, FINISH_STOP]);

  assert.equal(outcome.ok, false);
  assert.equal(llm.calls.length, 1);
  assert.match(outcome.reason, /incomplete block of type "image"/u);
  assert.match(outcome.call.thrown.message, /incomplete block of type "image"/u);
  assert.deepEqual(llmPackage.lastAssistantStreamChunk(outcome.call.stream, 'finish'), FINISH_STOP, 'the stream is kept whole');
  assert.equal(llmPackage.joinAssistantStreamText(outcome.call.stream), NOTES);
  assert.deepEqual(appended(outcome.call), JSON.parse(JSON.stringify(outcome.call)));
});

// ── The observer: the attempt a monitor records around the call ───────────────────────────────────────────

test('the observer is dispatched with the very options the stream receives and the call\'s own input, before the request is sent, and is told of each chunk once it is accumulated', { skip }, async () => {
  const fixture = sealedSession();
  const text = NOTES;
  const llm = recordingLlm(() => chunks(...reply(text, FINISH_STOP)));
  const slots = slotsOf(fixture, fixture.seqOf);
  const seen = [];
  const streamed = [];
  let request;
  const observer = {
    dispatch(handed) { request = handed; seen.push(['dispatch', llm.calls.length]); },
    chunk() { seen.push(['chunk', llm.calls.length]); streamed.push(llmPackage.joinAssistantStreamText(request.stream())); },
  };

  const outcome = await summarizeSlots({
    llm, session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs),
    signal: new AbortController().signal, held: NO_HELD, kit: kitOf(), observer,
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(seen, [['dispatch', 0], ...Array.from({ length: 5 }, () => ['chunk', 1])], 'dispatched before the request is sent, then one note for each of the five chunks');
  assert.equal(request.options, llm.calls[0], 'the options are the very object the stream received');
  assert.equal(request.input, outcome.call.input, 'the input is the call\'s own');
  const cut = Math.floor(text.length / 2);
  assert.deepEqual(streamed, ['', text.slice(0, cut), text, text, text], 'stream() answers the accumulator as it stands at each note');
  assert.deepEqual(request.stream(), outcome.call.stream, 'and as it ended');
  assert.deepEqual(Object.keys(request).sort(), ['input', 'options', 'stream']);
});

test('a request that cannot be sent is dispatched and then rejects with the error itself, while a request that cannot be built is never dispatched', { skip }, async () => {
  const fixture = sealedSession();
  const slots = slotsOf(fixture, fixture.seqOf);
  const refused = new Error('stream boom');
  const dispatches = [];
  const observer = { dispatch: request => dispatches.push(request), chunk() { throw new Error('no chunk was accumulated'); } };
  const call = (llm, session = fixture.session) => summarizeSlots({
    llm, session, index: indexOf(session), events: session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs), signal: new AbortController().signal, held: NO_HELD, kit: kitOf(), observer,
  });

  const sending = recordingLlm(() => { throw refused; });
  await assert.rejects(call(sending), error => error === refused);
  assert.equal(dispatches.length, 1, 'the request was dispatched');
  assert.equal(dispatches[0].options, sending.calls[0]);

  const deriving = Object.create(fixture.session, { deriveMessages: { value() { throw new Error('derive boom'); } } });
  await assert.rejects(call(recordingLlm(() => chunks()), deriving), /derive boom/u);
  assert.equal(dispatches.length, 1, 'nothing was dispatched for a request that could not be built');
});

// Whether the time the stream iteration ended precedes the first reading of the assembler: `blocks` is wrapped to note the clock, and the clock is a counter that ticks at each reading.
async function endedBeforeAssembly(t, list) {
  let clock = 0;
  t.mock.method(Date, 'now', () => { clock += 1; return clock; });
  let assembledAt;
  const kit = {
    ...kitOf(),
    BlockAssembler: class extends llmPackage.BlockAssembler {
      blocks() { assembledAt = Date.now(); return super.blocks(); }
    },
  };
  const fixture = sealedSession();
  const slots = slotsOf(fixture, fixture.seqOf);
  const outcome = await summarizeSlots({
    llm: recordingLlm(() => list), session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs),
    held: NO_HELD, signal: new AbortController().signal, kit,
  });
  t.mock.restoreAll();
  return { outcome, assembledAt };
}

test('the call ends when the stream iteration does: endedAt is read after the last chunk and before the stream is assembled, whether the iteration ended or threw', { skip }, async (t) => {
  const ended = await endedBeforeAssembly(t, chunks(...reply(NOTES, FINISH_STOP)));
  const timed = llmPackage.expandAssistantStream(ended.outcome.call.stream);
  assert.ok(ended.outcome.call.endedAt > timed.at(-1).time, 'after the last chunk');
  assert.ok(ended.outcome.call.endedAt < ended.assembledAt, 'and before the assembly');

  // A stream the assembler cannot assemble still ends at the iteration's end: `blocks()` is where it throws.
  const unfinished = await endedBeforeAssembly(t, chunks(...reply(NOTES), { type: 'block-start', index: 1, blockType: 'image' }, FINISH_STOP));
  assert.match(unfinished.outcome.call.thrown.message, /incomplete block/u);
  assert.ok(unfinished.outcome.call.endedAt < unfinished.assembledAt, 'the throw from the assembly did not move it');

  // A throw out of the iteration ends it as well, and the assembler is never read.
  const fixture = sealedSession();
  const slots = slotsOf(fixture, fixture.seqOf);
  const threw = await summarizeSlots({
    llm: recordingLlm(() => throwingStream(new Error('socket hang up'), { type: 'block-start', index: 0, blockType: 'text' })),
    session: fixture.session, index: indexOf(fixture.session), events: fixture.session.snapshotEvents(), selection: SELECTION, slots, range: slots.flatMap(slot => slot.seqs),
    signal: new AbortController().signal, held: NO_HELD, kit: kitOf(),
  });
  assert.equal(typeof threw.call.endedAt, 'number');
  assert.deepEqual(threw.call.thrown, { message: 'socket hang up' });
  assert.ok(threw.call.endedAt >= llmPackage.expandAssistantStream(threw.call.stream).at(-1).time);
});

// ── The display of a request ──────────────────────────────────────────────────────────────────────────────

const TAIL = { role: 'user', content: [{ type: 'text', text: 'Write concise continuity notes for the listed parts.' }] };
const schema = name => ({ name, description: `${name} a file.`, parameters: { type: 'object', properties: {} } });

test('the display of a request keeps the route, the C tail, the history and tool counts, the cut and the names of the tools an update adds, and nothing else of what the request holds', () => {
  const options = {
    provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high', purpose: 'inner-compaction', sessionId: 'session-1',
    messages: [{ role: 'system', content: 'the system prompt' }, { role: 'user', content: [{ type: 'text', text: 'an earlier ask' }] }, TAIL],
    tools: [schema('read'), schema('write')],
    toolHistory: { tools: [schema('read')], updates: [{ messageId: 'm-1', additions: [schema('write'), schema('edit')] }, { messageId: 'm-2', additions: [] }] },
    signal: new AbortController().signal,
  };

  const display = requestDisplayOf(options, { throughSeq: 41, headerSeq: 7, tail: TAIL });

  assert.deepEqual(display, {
    options: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high', purpose: 'inner-compaction', sessionId: 'session-1' },
    messages: { count: 2, tail: TAIL },
    throughSeq: 41,
    headerSeq: 7,
    tools: { count: 2 },
    toolHistory: { updates: [{ messageId: 'm-1', additions: ['write', 'edit'] }, { messageId: 'm-2', additions: [] }] },
  });
  assert.equal(display.messages.tail, TAIL, 'the tail is the request\'s own message');
});

test('the display of a request makes up nothing the request did not provide: no effort, tools, tool history or header seq gives no key, and nothing in it is undefined', () => {
  const options = { provider: 'deepseek', model: 'deepseek-v4-pro', purpose: 'inner-compaction', sessionId: 'session-1', messages: [TAIL], reasoningEffort: undefined };

  const display = requestDisplayOf(options, { throughSeq: 3, headerSeq: null });

  assert.deepEqual(display, {
    options: { provider: 'deepseek', model: 'deepseek-v4-pro', purpose: 'inner-compaction', sessionId: 'session-1' },
    messages: { count: 0, tail: TAIL },
    throughSeq: 3,
    headerSeq: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(display)), display, 'the display is plain JSON, so the log takes it');
});

test('the display of a request copies no key outside its list, whichever object carries it: the shape it shows, not a redaction', () => {
  const options = {
    provider: 'deepseek', model: 'deepseek-v4-pro', purpose: 'inner-compaction', sessionId: 'session-1', messages: [TAIL],
    apiKey: 'sk-not-for-display', headers: { authorization: 'Bearer x' }, temperature: 0.2, maxTokens: 9, stop: ['x'], system: 'a system prompt', extra: { nested: true },
  };

  const display = requestDisplayOf(options, { throughSeq: 3, headerSeq: 1, tail: TAIL, secret: 'no' });

  assert.deepEqual(Object.keys(display).sort(), ['headerSeq', 'messages', 'options', 'throughSeq']);
  assert.deepEqual(Object.keys(display.options).sort(), ['model', 'provider', 'purpose', 'sessionId']);
  assert.deepEqual(Object.keys(display.messages).sort(), ['count', 'tail']);
});
