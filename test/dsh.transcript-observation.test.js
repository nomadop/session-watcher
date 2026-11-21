// test/dsh.transcript-observation.test.js — DSH Transcript Observation: one session event reduced to one
// Observation batch in the shapes the Claude Code reducer emits, one case per reducer table row and contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callUsageOf, foldInputOf, isMainCall, reduceDshEvent, reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import {
  userMessage, assistantMessage, toolCall, toolResult, attempt, requestHeader, requestContext,
  turnStart, turnEnd, stepStart, stepEnd, compactionStart, compactionSummary, compactCheckpoint, compactionEnd,
  compactionPrune, prunedResult, unknownEvent, ignorableEvent, sessionLog, reusedCallIdAcrossSteps, loadMessage,
  innerSealCarrier,
} from './helpers/dsh-events.js';

// The coordinates every Observation of one event shares.
function at(event) {
  return { sourceOrdinal: event.seq, sourceEntryId: String(event.seq), timestamp: event.time };
}

const NOTHING = { observations: [], diagnostics: [] };
const USAGE = {
  inputTokens: 5, outputTokens: 80, totalTokens: 9_725, cacheReadTokens: 9_600, cacheWriteTokens: 40,
};

const typesOf = observations => observations.map(observation => observation.type);

// --- User messages ---

test('a user-kind message yields a turn-boundary and a human text on the same seq', () => {
  const event = userMessage({ text: 'Refactor the parser.' });
  assert.deepEqual(reduceDshEvent(event), {
    observations: [
      { type: 'turn-boundary', ...at(event), provenance: 'human' },
      {
        type: 'text', role: 'human', text: 'Refactor the parser.', messageId: `dsh:message:${event.data.id}`,
        ...at(event), provenance: 'human',
      },
    ],
    diagnostics: [],
  });
});

test('a user message without text yields its turn-boundary and no text', () => {
  for (const event of [userMessage(), userMessage({ text: '' })]) {
    assert.deepEqual(reduceDshEvent(event), {
      observations: [{ type: 'turn-boundary', ...at(event), provenance: 'human' }],
      diagnostics: [],
    });
  }
});

test('a compact-checkpoint replacement yields one epoch-boundary first and nothing else', () => {
  const event = compactCheckpoint({ startSeq: 0, endSeq: 40, text: 'The session so far, summarised.' });
  assert.deepEqual(reduceDshEvent(event), {
    observations: [{ type: 'epoch-boundary', ...at(event), provenance: 'harness' }],
    diagnostics: [],
  });
  assert.deepEqual(reduceDshEvent({ ...event, surfaceOp: 'append' }), NOTHING, 'an appended checkpoint');
});

// Kinds harness producers inject, this plugin's own `session-watcher` among them.
const INJECTED_KINDS = [
  'agent-instructions', 'runtime-context', 'skill-catalog', 'skill-invocation', 'agent-message',
  'subagent-settled', 'goal', 'tool-jobs', 'session-watcher',
];

test('any other user/message kind yields nothing and no diagnostic', () => {
  for (const kind of INJECTED_KINDS) {
    assert.deepEqual(reduceDshEvent(userMessage({ text: 'Injected context.', kind })), NOTHING, kind);
  }
});

// --- Inner seals ---

test('an inner-seal carrier yields no observation and answers the seqs it cites as sealed, whatever its surface op says', () => {
  const carrier = innerSealCarrier({ sourceEventSeqs: [9, 3, 4, 5], startSeq: 3, endSeq: 5, text: 'C, then B.' });
  assert.deepEqual(reduceDshEvent(carrier), { observations: [], diagnostics: [], sealed: [9, 3, 4, 5] });
  for (const surfaceOp of [undefined, 'append', { op: 'replace', endSeq: 4 }]) {
    assert.deepEqual(reduceDshEvent({ ...carrier, surfaceOp }), { observations: [], diagnostics: [], sealed: [9, 3, 4, 5] }, JSON.stringify(surfaceOp));
  }
});

test('an inner-seal carrier with malformed seqs yields one shape-violation and seals nothing', () => {
  const valid = innerSealCarrier({ sourceEventSeqs: [3, 4] });
  for (const sourceEventSeqs of [undefined, 'all', [3, -1], [3, 1.5], [3, '4']]) {
    const { sealed, observations, diagnostics } = reduceDshEvent({ ...valid, sourceEventSeqs });
    assert.deepEqual(observations, [], String(sourceEventSeqs));
    assert.equal(sealed, undefined, String(sourceEventSeqs));
    assert.deepEqual(diagnostics.map(({ scope, code }) => [scope, code]),
      [['dsh-transcript-observation', 'shape-violation']], String(sourceEventSeqs));
    assert.match(diagnostics[0].message, new RegExp(`\\bseq ${valid.seq}\\b.*sourceEventSeqs`));
  }
});

// --- The measurement source fold's input ---

test('a main call is a committed assistant message with a seq that is an index, whatever its usage holds', () => {
  const message = assistantMessage({ step: 1, text: 'Counted.', usage: USAGE });
  assert.equal(isMainCall(message), true);
  assert.equal(isMainCall(assistantMessage({ step: 1, text: 'No count reported.' })), true, 'no usage');
  assert.equal(isMainCall(assistantMessage({ step: 1, usage: { inputTokens: 'many', outputTokens: 1 } })), true, 'a malformed usage');
  for (const seq of [undefined, null, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) assert.equal(isMainCall({ ...message, seq }), false, String(seq));
  for (const event of [
    attempt({ usageChunk: USAGE, finish: 'error' }), toolResult({ step: 1, callId: 'call_read', text: 'a' }), userMessage({ text: 'Question.' }), turnStart(),
    innerSealCarrier({ sourceEventSeqs: [1] }),
  ]) assert.equal(isMainCall(event), false, event.type);
});

test('the input of the source fold is the reducer\'s answer with the event\'s seq and whether it is a main call', () => {
  const read = [{ id: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' }];
  const call = assistantMessage({ step: 1, toolCalls: read, usage: USAGE });
  assert.deepEqual(foldInputOf(call), { ...reduceDshEvent(call), seq: call.seq, mainCall: true });
  assert.deepEqual(typesOf(foldInputOf(call).observations), ['tool-use', 'usage']);

  const result = toolResult({ step: 1, callId: 'call_read', text: 'a' });
  assert.deepEqual(foldInputOf(result), { ...reduceDshEvent(result), seq: result.seq, mainCall: false });

  const checkpoint = compactCheckpoint({ startSeq: 0, endSeq: 1 });
  assert.deepEqual(typesOf(foldInputOf(checkpoint).observations), ['epoch-boundary']);
  assert.equal(foldInputOf(checkpoint).mainCall, false);

  const batchless = foldInputOf(turnStart());
  assert.deepEqual(batchless, { observations: [], diagnostics: [], seq: batchless.seq, mainCall: false });
  assert.equal('sealed' in batchless, false, 'only a carrier answers a sealed list');
});

test('a carrier\'s input lists the seqs it seals and is no main call; a malformed carrier gives its diagnostic and no list', () => {
  const carrier = innerSealCarrier({ sourceEventSeqs: [9, 3, 4, 5] });
  assert.deepEqual(foldInputOf(carrier), { observations: [], diagnostics: [], sealed: [9, 3, 4, 5], seq: carrier.seq, mainCall: false });
  const malformed = foldInputOf({ ...carrier, sourceEventSeqs: 'all' });
  assert.deepEqual(malformed.diagnostics.map(({ code }) => code), ['shape-violation']);
  assert.equal('sealed' in malformed, false);
});

test('a main call whose message the reducer rejects is still a main call, and a message with no seq is none; the diagnostic stays with the input', () => {
  const malformed = assistantMessage({ step: 1, usage: { inputTokens: 'many', outputTokens: 1 } });
  assert.deepEqual(foldInputOf(malformed), { ...reduceDshEvent(malformed), seq: malformed.seq, mainCall: true });
  assert.deepEqual(foldInputOf(malformed).diagnostics.map(({ code }) => code), ['shape-violation']);
  const seqless = { ...assistantMessage({ step: 2, text: 'No seq.', usage: USAGE }), seq: 'x' };
  assert.deepEqual(foldInputOf(seqless), { ...reduceDshEvent(seqless), seq: 'x', mainCall: false });
  assert.deepEqual(foldInputOf(seqless).diagnostics.map(({ code }) => code), ['shape-violation']);
});

test('the Dialogue snapshot ignores a carrier: a log with one reduces as the log without it', () => {
  const read = [{ id: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' }];
  const events = [
    turnStart(),
    userMessage({ text: 'Where is parse defined?' }),
    assistantMessage({ step: 1, toolCalls: read, usage: USAGE }),
    toolResult({ step: 1, callId: 'call_read', text: 'export function parse() {}' }),
  ];
  const sealed = sessionLog([...events, innerSealCarrier({ sourceEventSeqs: events.slice(1).map(event => event.seq) })]);
  const withoutCarrier = reduceDshSnapshot(sealed.slice(0, -1));
  assert.deepEqual(reduceDshSnapshot(sealed), withoutCarrier);
  assert.ok(withoutCarrier.observations.length > 0);
});

// --- Loads ---

const LOAD_ROUTE = { provider: 'bedrock', model: 'us.anthropic.claude-opus-4-8' };
const LOAD_CALLS = [
  { id: 'sw-load-1a2b3c4d-1', name: 'load_handoff', arguments: '{"load_token":"sw-token"}', text: '{"found":true,"load_token":"sw-token"}' },
  { id: 'sw-load-1a2b3c4d-2', name: 'read', arguments: '{"file_path":"/repo/src/a.js","offset":3,"limit":2}', text: '<path>/repo/src/a.js</path>\n3: three\n4: four' },
  { id: 'sw-load-1a2b3c4d-3', name: 'read', arguments: '{"file_path":"/repo/src/empty.js","offset":1,"limit":40}', text: '' },
];

test('a load message yields one tool-use and one tool-result per call, keyed by the call id, priced by its route, with no turn boundary and no usage', () => {
  const event = loadMessage({ route: LOAD_ROUTE, calls: LOAD_CALLS });
  const messageId = `dsh:message:${event.data.id}`;
  const pair = ({ id, name, text }, input) => [
    {
      type: 'tool-use', messageId, model: LOAD_ROUTE.model, cwd: null, toolUseId: id, name, input,
      ...at(event), provenance: 'harness',
    },
    {
      type: 'tool-result', toolUseId: id, content: text, isError: false, resultMeta: { meta: null, error: null },
      ...at(event), provenance: 'harness',
    },
  ];
  assert.deepEqual(reduceDshEvent(event), {
    observations: [
      ...pair(LOAD_CALLS[0], { load_token: 'sw-token' }),
      ...pair(LOAD_CALLS[1], { file_path: '/repo/src/a.js', offset: 3, limit: 2 }),
      ...pair(LOAD_CALLS[2], { file_path: '/repo/src/empty.js', offset: 1, limit: 40 }),
    ],
    diagnostics: [],
  });
});

test('the payload message and the read message reduce, in order, to the observations of one message holding the same calls', () => {
  const payloadEvent = loadMessage({ route: LOAD_ROUTE, calls: LOAD_CALLS.slice(0, 1) });
  const readEvent = loadMessage({ route: LOAD_ROUTE, calls: LOAD_CALLS.slice(1) });
  const single = reduceDshEvent(loadMessage({ route: LOAD_ROUTE, calls: LOAD_CALLS }));
  const split = [payloadEvent, readEvent].map(reduceDshEvent);

  assert.deepEqual(split.map(reduced => reduced.diagnostics), [[], []]);
  assert.deepEqual(single.diagnostics, []);
  // The coordinates differ by event; everything else is what the one message yields.
  const withoutCoordinates = ({ messageId: _id, sourceOrdinal: _ordinal, sourceEntryId: _entry, timestamp: _time, ...rest }) => rest;
  assert.deepEqual(split.flatMap(reduced => reduced.observations).map(withoutCoordinates), single.observations.map(withoutCoordinates));
  for (const [event, reduced] of [[payloadEvent, split[0]], [readEvent, split[1]]]) {
    assert.deepEqual(reduced.observations.map(observation => observation.sourceOrdinal), reduced.observations.map(() => event.seq));
  }
  assert.ok(!typesOf(split.flatMap(reduced => reduced.observations)).includes('turn-boundary'), 'neither message opens a turn');
});

test('two loads never share a toolUseId', () => {
  const first = loadMessage({ calls: LOAD_CALLS });
  const second = loadMessage({ calls: LOAD_CALLS.map(call => ({ ...call, id: call.id.replace('1a2b3c4d', '5e6f7a8b') })) });
  const idsOf = event => reduceDshEvent(event).observations.map(observation => observation.toolUseId);
  const ids = [...idsOf(first), ...idsOf(second)];
  assert.equal(new Set(ids).size, ids.length / 2);
  assert.deepEqual(new Set(idsOf(second)), new Set(LOAD_CALLS.map(call => call.id.replace('1a2b3c4d', '5e6f7a8b'))));
});

test('a load message it cannot pair yields nothing and one shape-violation', () => {
  const valid = loadMessage({ calls: LOAD_CALLS });
  const variants = {
    'one block short': { ...valid.data, content: valid.data.content.slice(1) },
    'one block over': { ...valid.data, content: [...valid.data.content, { type: 'text', text: 'extra' }] },
    'a call without an id': {
      ...valid.data, source: { ...valid.data.source, calls: valid.data.source.calls.map(({ id: _id, ...call }) => call) },
    },
    'no calls': { ...valid.data, source: { ...valid.data.source, calls: undefined } },
    'a non-text block': { ...valid.data, content: [{ type: 'image' }, ...valid.data.content.slice(1)] },
    'a route without a model': { ...valid.data, source: { ...valid.data.source, route: { provider: 'bedrock' } } },
    'no route': { ...valid.data, source: { ...valid.data.source, route: undefined } },
  };
  for (const [label, data] of Object.entries(variants)) {
    const { observations, diagnostics } = reduceDshEvent({ ...valid, data });
    assert.deepEqual(observations, [], label);
    assert.deepEqual(diagnostics.map(({ scope, code }) => ({ scope, code })), [
      { scope: 'dsh-transcript-observation', code: 'shape-violation' },
    ], label);
  }
});

test('developer and system messages yield nothing', () => {
  // Written out in the shape DSH logs them.
  const systemPrompt = {
    type: 'system/message', seq: 0, time: Date.UTC(2026, 8, 27), surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }],
        source: { kind: 'system-prompt' }, id: 'message-system',
      },
    },
  };
  const toolChange = {
    type: 'developer/message', seq: 1, time: Date.UTC(2026, 8, 27, 0, 0, 1), surfaceOp: 'append',
    data: {
      turn: 1, step: 1, headerSeq: 0,
      message: {
        role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }],
        source: { kind: 'tool-registry' }, id: 'message-developer',
      },
    },
  };
  for (const event of [systemPrompt, toolChange]) assert.deepEqual(reduceDshEvent(event), NOTHING, event.type);
});

// --- Assistant messages ---

test('an assistant message yields its text, one tool-use per tool-call block with a step-qualified id, and a usage last', () => {
  const model = 'us.anthropic.claude-opus-4-8';
  const event = assistantMessage({
    turn: 2, step: 3, text: 'Reading both modules.', model, usage: USAGE,
    toolCalls: [
      { id: 'call_a', name: 'read', arguments: '{"file_path":"src/a.js"}' },
      { id: 'call_b', name: 'grep', arguments: '{"pattern":"parse"}' },
    ],
  });
  const messageId = `dsh:message:${event.data.message.id}`;
  assert.deepEqual(reduceDshEvent(event), {
    observations: [
      {
        type: 'text', role: 'assistant', text: 'Reading both modules.', messageId,
        ...at(event), provenance: 'assistant',
      },
      {
        type: 'tool-use', messageId, model, cwd: null, toolUseId: '2:3:call_a', name: 'read',
        input: { file_path: 'src/a.js' }, ...at(event), provenance: 'assistant',
      },
      {
        type: 'tool-use', messageId, model, cwd: null, toolUseId: '2:3:call_b', name: 'grep',
        input: { pattern: 'parse' }, ...at(event), provenance: 'assistant',
      },
      {
        type: 'usage', messageId, model, usage: { input: 5, output: 80, cacheRead: 9_600, cacheWrite: 40 },
        ...at(event), provenance: 'assistant',
      },
    ],
    diagnostics: [],
  });
});

test("tool-call arguments are parsed as DSH's loop parses them", () => {
  const event = assistantMessage({
    toolCalls: [
      { id: 'call_empty', name: 'glob', arguments: '' },
      { id: 'call_object', name: 'read', arguments: '{"file_path":"src/a.js","offset":10}' },
      { id: 'call_invalid', name: 'bash', arguments: '{"command":"ls' },
    ],
  });
  assert.deepEqual(
    reduceDshEvent(event).observations.map(observation => observation.input),
    [{}, { file_path: 'src/a.js', offset: 10 }, '{"command":"ls'],
  );
});

test('an absent cache bucket reads as zero', () => {
  const usageOf = event => reduceDshEvent(event).observations.at(-1).usage;
  const unread = assistantMessage({
    text: 'Done.', usage: { inputTokens: 3, outputTokens: 48, totalTokens: 9_651, cacheWriteTokens: 9_600 },
  });
  const unwritten = assistantMessage({
    text: 'Done.', usage: { inputTokens: 2, outputTokens: 12, totalTokens: 9_614, cacheReadTokens: 9_600 },
  });
  assert.deepEqual(usageOf(unread), { input: 3, output: 48, cacheRead: 0, cacheWrite: 9_600 });
  assert.deepEqual(usageOf(unwritten), { input: 2, output: 12, cacheRead: 9_600, cacheWrite: 0 });
});

test('an assistant message without usage yields no usage observation', () => {
  const event = assistantMessage({ text: 'No accounting came back.' });
  assert.deepEqual(typesOf(reduceDshEvent(event).observations), ['text']);
});

test('reasoning blocks contribute nothing to the text', () => {
  const event = assistantMessage({ text: 'The parser ' });
  event.data.message.content = [
    { type: 'reasoning', text: 'They asked where the parser lives.' },
    { type: 'text', text: 'The parser ' },
    { type: 'reasoning', text: 'Name the module.' },
    { type: 'text', text: 'lives in src/parse.js.' },
  ];
  assert.deepEqual(
    reduceDshEvent(event).observations.map(observation => [observation.type, observation.text]),
    [['text', 'The parser lives in src/parse.js.']],
  );
});

test('an assistant message without text blocks yields no text observation', () => {
  const event = assistantMessage({
    toolCalls: [{ id: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' }], usage: USAGE,
  });
  event.data.message.content.unshift({ type: 'reasoning', text: 'Read the module first.' });
  assert.deepEqual(typesOf(reduceDshEvent(event).observations), ['tool-use', 'usage']);
});

// --- Display usage ---

// What a settled call's usage can be: the reducer's own cases, and the ones it refuses.
const USAGE_SAMPLES = [
  ['a complete usage', USAGE],
  ['an unread cache bucket', { inputTokens: 3, outputTokens: 48, totalTokens: 9_651, cacheWriteTokens: 9_600 }],
  ['an unwritten cache bucket', { inputTokens: 2, outputTokens: 12, totalTokens: 9_614, cacheReadTokens: 9_600 }],
  ['no cache bucket at all', { inputTokens: 7, outputTokens: 1 }],
  ['no usage', undefined],
  ['a null usage', null],
  ['a count that is text', { inputTokens: '3', outputTokens: 20, totalTokens: 23 }],
  ['a count that is null', { inputTokens: 3, outputTokens: null }],
  ['a cache bucket that is not finite', { inputTokens: 3, outputTokens: 20, cacheReadTokens: Number.NaN }],
];

test('callUsageOf reads a usage as the reducer reads an assistant message\'s: the same four numbers where the reducer yields a usage observation, null where it yields none', () => {
  for (const [why, usage] of USAGE_SAMPLES) {
    const observed = reduceDshEvent(assistantMessage({ text: 'Done.', usage })).observations.find(observation => observation.type === 'usage');
    assert.deepEqual(callUsageOf(usage), observed?.usage ?? null, why);
  }
  const [, unread] = USAGE_SAMPLES[1];
  assert.deepEqual(callUsageOf(unread), { input: 3, output: 48, cacheRead: 0, cacheWrite: 9_600 }, 'an absent cache bucket is zero, not a missing field');
  assert.equal(callUsageOf(USAGE_SAMPLES[4][1]), null, 'no usage is null, which differs from a usage of zeros');
  assert.deepEqual(callUsageOf({ inputTokens: 0, outputTokens: 0 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('a plugin record whose stream holds a usage chunk, as an inner-call record does, yields no observation: callUsageOf serves the display and never the measurement', () => {
  const record = ignorableEvent({
    type: 'plugin:session-watcher/inner-call',
    data: { v: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: USAGE } }] },
  });
  assert.deepEqual(reduceDshEvent(record), NOTHING);
  assert.deepEqual(reduceDshSnapshot([record]), { batches: [], observations: [], diagnostics: [] });
});

// --- Tool results ---

test('a tool result yields one tool-result with the step-qualified id, the model-visible text and its meta', () => {
  const meta = { path: 'src/a.js', offset: 1, lines: [{ number: 1, text: 'export const a = 1;' }], totalLines: 1 };
  const text = '<path>src/a.js</path>\n<type>file</type>\n<content>\n1: export const a = 1;\n</content>';
  const read = toolResult({ turn: 2, step: 3, callId: 'call_read', text, meta });
  const refused = 'Error: cannot read "src/b.js": not found';
  const error = { name: 'FsError', code: 'FS_NOT_FOUND' };
  const failed = toolResult({ turn: 2, step: 4, callId: 'call_read', text: refused, isError: true, error });
  assert.deepEqual(reduceDshEvent(read), {
    observations: [{
      type: 'tool-result', toolUseId: '2:3:call_read', content: text, isError: false,
      resultMeta: { meta, error: null }, ...at(read), provenance: 'harness',
    }],
    diagnostics: [],
  });
  assert.deepEqual(reduceDshEvent(failed), {
    observations: [{
      type: 'tool-result', toolUseId: '2:4:call_read', content: refused, isError: true,
      resultMeta: { meta: null, error: { name: 'FsError', code: 'FS_NOT_FOUND' } },
      ...at(failed), provenance: 'harness',
    }],
    diagnostics: [],
  });
});

test('a replacement tool result yields nothing', () => {
  const original = toolResult({ callId: 'call_read', text: 'export const a = 1;\nexport const b = 2;' });
  assert.deepEqual(reduceDshEvent(prunedResult(original, { text: '[pruned]' })), NOTHING);
});

test('the same provider call id in two steps yields two tool-use ids, each shared with its own result', () => {
  const observations = reusedCallIdAcrossSteps().flatMap(event => reduceDshEvent(event).observations);
  const calls = observations.filter(observation => observation.type === 'tool-use')
    .map(observation => [observation.toolUseId, observation.input.file_path]);
  const results = observations.filter(observation => observation.type === 'tool-result')
    .map(observation => [observation.toolUseId, observation.resultMeta.meta.path]);
  assert.deepEqual(calls, [['1:1:call_read', 'src/a.js'], ['1:2:call_read', 'src/b.js']]);
  assert.deepEqual(results, calls);
});

// --- Events that yield nothing ---

test('attempts, tool calls, request headers, request contexts, turn, step and compaction events yield nothing', () => {
  const original = toolResult({ callId: 'call_read', text: 'export const a = 1;' });
  const failure = { message: 'stream ended before the response completed', code: 'PI_AI_ERROR' };
  const events = [
    attempt({
      usageChunk: { inputTokens: 3, outputTokens: 20, totalTokens: 9_623, cacheWriteTokens: 9_600 },
      finish: { kind: 'error', failure },
    }),
    toolCall({ callId: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' }),
    requestHeader({ reason: 'series', startsSeries: true }),
    requestContext(),
    turnStart(), stepStart(), stepEnd(), turnEnd(),
    compactionStart(), compactionSummary(), compactionPrune(original), compactionEnd(),
    compactionEnd({ error: 'compaction summary request failed' }),
  ];
  for (const event of events) assert.deepEqual(reduceDshEvent(event), NOTHING, event.type);
});

test('an unknown type and an ignorable event yield nothing and no diagnostic', () => {
  for (const event of [unknownEvent(), ignorableEvent()]) {
    assert.deepEqual(reduceDshEvent(event), NOTHING, event.type);
  }
});

// --- Shape violations ---

test('a known type with a broken shape yields nothing and one shape-violation', () => {
  const unsequenced = userMessage({ text: 'Refactor the parser.' });
  delete unsequenced.seq;
  const unpaired = toolResult({ callId: 'call_read', text: 'export const a = 1;' });
  delete unpaired.data.message.toolCallId;
  const unmetered = assistantMessage({
    text: 'Done.', usage: { inputTokens: '3', outputTokens: 20, totalTokens: 23 },
  });

  // The one diagnostic an event yields, which names the event's type.
  const violationOf = event => {
    const { observations, diagnostics } = reduceDshEvent(event);
    assert.deepEqual(observations, [], event.type);
    assert.equal(diagnostics.length, 1, event.type);
    const [{ scope, code, message }] = diagnostics;
    assert.deepEqual({ scope, code }, { scope: 'dsh-transcript-observation', code: 'shape-violation' });
    assert.ok(message.includes(event.type), message);
    return message;
  };
  assert.doesNotMatch(violationOf(unsequenced), /\bseq \d/);
  assert.match(violationOf(unpaired), new RegExp(`\\bseq ${unpaired.seq}\\b`));
  assert.match(violationOf(unmetered), new RegExp(`\\bseq ${unmetered.seq}\\b`));
});

// --- Snapshot ---

test('reduceDshSnapshot flattens the batches in event order', () => {
  const read = [{ id: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' }];
  const unpaired = toolResult({ step: 1, callId: 'call_grep', text: 'src/a.js:1: export function parse() {}' });
  delete unpaired.data.message.toolCallId;
  const unmetered = assistantMessage({ step: 2, text: 'Done.', usage: { inputTokens: 3, outputTokens: null } });
  const events = sessionLog([
    turnStart(),
    userMessage({ text: 'Where is parse defined?' }),
    stepStart({ step: 1 }),
    assistantMessage({ step: 1, toolCalls: read, usage: USAGE }),
    toolCall({ step: 1, callId: 'call_read', name: 'read', arguments: read[0].arguments }),
    toolResult({ step: 1, callId: 'call_read', text: 'export function parse() {}' }),
    unpaired,
    stepEnd({ step: 1 }),
    stepStart({ step: 2 }),
    unmetered,
    assistantMessage({ step: 2, text: 'In src/a.js.', usage: USAGE }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);

  const { batches, observations, diagnostics } = reduceDshSnapshot(events);
  const coordinates = batch => batch.map(observation => [observation.sourceOrdinal, observation.type]);
  assert.deepEqual(batches.map(coordinates), [
    [[1, 'turn-boundary'], [1, 'text']],
    [[3, 'tool-use'], [3, 'usage']],
    [[5, 'tool-result']],
    [[10, 'text'], [10, 'usage']],
  ]);
  assert.deepEqual(coordinates(observations), [
    [1, 'turn-boundary'], [1, 'text'], [3, 'tool-use'], [3, 'usage'], [5, 'tool-result'],
    [10, 'text'], [10, 'usage'],
  ]);
  assert.deepEqual(
    diagnostics.map(diagnostic => [diagnostic.code, /\bseq (\d+)\b/.exec(diagnostic.message)?.[1]]),
    [['shape-violation', '6'], ['shape-violation', '9']],
  );
});
