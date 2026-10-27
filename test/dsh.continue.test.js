// `clearSurface`, the clear as one compaction transaction, over a recording session and a kit that stands in for the DSH values it is handed: the events it appends, the range it shadows and how it fails. The same transaction against the real DSH packages is `test/dsh.continue.integration.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { clearSurface, ClearError } from '../dsh/src/continue.js';
import {
  sessionLog, systemMessage, turnStart, turnEnd, stepStart, stepEnd, userMessage, assistantMessage, toolResult,
} from './helpers/dsh-events.js';
import { recordingSession, fakeTokenMeter } from './helpers/dsh-fake-context.js';

const COMMAND_ID = 'command-1';
const TOKEN = 'sw-handoff-token';
const CHECKPOINT_TEXT = `[Session Watcher] Context cleared by /sw-continue. Handoff token: ${TOKEN}`;

// The DSH values `clearSurface` is handed, in the shapes DSH gives them: a brand that is the identity, the frozen checkpoint source and a user message carrying an id.
let messages = 0;
const kit = {
  CompactionId: id => id,
  compactCheckpointSource: (compactionId, sourceCommandId) => Object.freeze({ kind: 'compact-checkpoint', compactionId, sourceCommandId }),
  createUserMessage: ({ content, source }) => ({ id: `message-${++messages}`, role: 'user', content, source }),
};

// One closed turn of a prompt, a tool call with its result and an answer. The surface nodes are the head's seq when it has one, then the prompt, the tool call, its result and the answer; the turn and step events between them are no nodes.
function conversation({ head = true } = {}) {
  return sessionLog([
    ...(head ? [systemMessage()] : []),
    turnStart(),
    userMessage({ text: 'Open the module.' }),
    stepStart({ step: 1 }),
    assistantMessage({ step: 1, toolCalls: [{ id: 'call_read', name: 'read' }] }),
    toolResult({ step: 1, callId: 'call_read', text: 'export const a = 1;' }),
    stepEnd({ step: 1 }),
    stepStart({ step: 2 }),
    assistantMessage({ step: 2, text: 'It exports a.' }),
    stepEnd({ step: 2 }),
    turnEnd(),
  ]);
}

// A price for every node: the head's apart from the rest, and a route price that differs from the heuristic price on each node, so a sum over the wrong field or over the head shows.
function pricesOf(nodes, { head = true } = {}) {
  return Object.fromEntries(nodes.map((seq, index) => (head && index === 0
    ? [seq, { tokens: 500, heuristicTokens: 400 }]
    : [seq, { tokens: 30 + index, heuristicTokens: 20 + index }])));
}

// The clear over a recording session; `session` and `prices` come back for the reading, `overrides` replaces any argument of the call.
function clear({ head = true, failAppend, ...overrides } = {}) {
  const session = recordingSession({ events: conversation({ head }), failAppend });
  const prices = pricesOf(session.surface.nodes, { head });
  const meter = fakeTokenMeter({ prices });
  const run = () => clearSurface({ session, meter, kit, commandId: COMMAND_ID, token: TOKEN, ...overrides });
  return { session, prices, run };
}

const thrownBy = (run) => {
  try { run(); } catch (error) { return error; }
  return assert.fail('the call did not throw');
};

const typesOf = session => session.appended.map(event => event.type);

test('the clear appends compaction start, summary, the replacing checkpoint and compaction end, in that order', () => {
  const { session, run } = clear();
  run();
  assert.deepEqual(typesOf(session), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
});

test('every event of the transaction carries the one compaction id and the command id, and the checkpoint source is the kit\'s of them', () => {
  const { session, run } = clear();
  run();
  const [start, summary, replacement, end] = session.appended;
  const { compactionId } = start.data;
  assert.ok(typeof compactionId === 'string' && compactionId.length > 0);
  assert.deepEqual(start.data, { compactionId, sourceCommandId: COMMAND_ID, turn: null });
  assert.equal(summary.data.compactionId, compactionId);
  assert.equal(summary.data.sourceCommandId, COMMAND_ID);
  assert.deepEqual(replacement.data.source, kit.compactCheckpointSource(compactionId, COMMAND_ID));
  assert.deepEqual(end.data, { compactionId, sourceCommandId: COMMAND_ID, turn: null });
});

test('the summary lists every node after the head in surface order, priced by their heuristic tokens, with no model call record', () => {
  const { session, prices, run } = clear();
  const shadowed = session.surface.nodes.slice(1);
  run();
  const [start, summary] = session.appended;
  assert.deepEqual(summary.data, {
    compactionId: start.data.compactionId,
    sourceCommandId: COMMAND_ID,
    summary: [{ type: 'text', text: CHECKPOINT_TEXT }],
    shadowedRange: { start: shadowed[0], end: shadowed.at(-1) },
    shadowedSeqs: shadowed,
    shadowedTokenCount: shadowed.reduce((total, seq) => total + prices[seq].heuristicTokens, 0),
    provider: 'session-watcher',
    model: 'sw-continue',
  });
});

test('the replacing checkpoint replaces that range, cites the start, the summary and the shadowed nodes, and follows the summary at once', () => {
  const { session, run } = clear();
  const shadowed = session.surface.nodes.slice(1);
  run();
  const [start, summary, replacement] = session.appended;
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) });
  assert.deepEqual(replacement.sourceEventSeqs, [start.seq, summary.seq, ...shadowed]);
  assert.equal(replacement.seq, summary.seq + 1);
  assert.equal(replacement.data.role, 'user');
  assert.deepEqual(replacement.data.content, [{ type: 'text', text: CHECKPOINT_TEXT }]);
});

test('the result counts the shadowed nodes and states their heuristic tokens', () => {
  const { session, prices, run } = clear();
  const shadowed = session.surface.nodes.slice(1);
  const result = run();
  assert.deepEqual(result, {
    count: shadowed.length,
    shadowedTokenCount: shadowed.reduce((total, seq) => total + prices[seq].heuristicTokens, 0),
  });
});

test('a surface headed by a system message is cleared from its second node through its last', () => {
  const { session, run } = clear({ head: true });
  const nodes = session.surface.nodes;
  run();
  const { shadowedSeqs } = session.appended[1].data;
  assert.deepEqual(shadowedSeqs, nodes.slice(1));
  assert.equal(shadowedSeqs.at(-1), nodes.at(-1), 'the last node is shadowed');
  assert.deepEqual(session.surface.nodes, [nodes[0], session.appended[2].seq]);
});

test('a surface with no system head is cleared from its first node through its last', () => {
  const { session, run } = clear({ head: false });
  const nodes = session.surface.nodes;
  run();
  assert.deepEqual(session.appended[1].data.shadowedSeqs, nodes);
  assert.deepEqual(session.surface.nodes, [session.appended[2].seq]);
});

test('a surface holding only its head answers null and appends nothing', () => {
  const session = recordingSession({ events: sessionLog([systemMessage()]) });
  const result = clearSurface({
    session, meter: fakeTokenMeter(), kit, commandId: COMMAND_ID, token: TOKEN,
  });
  assert.equal(result, null);
  assert.deepEqual(session.appended, []);
});

test('an empty surface answers null and appends nothing', () => {
  const session = recordingSession();
  const result = clearSurface({
    session, meter: fakeTokenMeter(), kit, commandId: COMMAND_ID, token: TOKEN,
  });
  assert.equal(result, null);
  assert.deepEqual(session.appended, []);
});

test('a refused compaction start appends nothing and throws a start ClearError', () => {
  const refusal = new Error('start refused');
  const { session, run } = clear({ failAppend: (type) => { if (type === 'compaction/start') throw refusal; } });
  const error = thrownBy(run);
  assert.ok(error instanceof ClearError);
  assert.equal(error.code, 'start');
  assert.equal(error.cause, refusal);
  assert.deepEqual(session.appended, []);
});

test('a measurement that throws appends nothing and throws a start ClearError', () => {
  const refusal = new Error('measurement refused');
  const { session, run } = clear({ meter: { measure() { throw refusal; } } });
  const error = thrownBy(run);
  assert.ok(error instanceof ClearError);
  assert.equal(error.code, 'start');
  assert.equal(error.cause, refusal);
  assert.deepEqual(session.appended, []);
});

for (const [refused, appended] of [
  ['compaction/summary', ['compaction/start', 'compaction/end']],
  ['user/message', ['compaction/start', 'compaction/summary', 'compaction/end']],
]) {
  test(`a refused ${refused} closes the transaction with one error compaction end and throws a commit ClearError`, () => {
    const refusal = new Error(`${refused} refused`);
    const { session, run } = clear({ failAppend: (type) => { if (type === refused) throw refusal; } });
    const error = thrownBy(run);
    assert.ok(error instanceof ClearError);
    assert.equal(error.code, 'commit');
    assert.equal(error.cause, refusal);
    assert.deepEqual(typesOf(session), appended);
    const end = session.appended.at(-1);
    assert.deepEqual(end.data, {
      compactionId: session.appended[0].data.compactionId, sourceCommandId: COMMAND_ID, turn: null, error: refusal.message,
    });
  });
}

test('a refused compaction end throws a commit ClearError and appends no second end', () => {
  const refusal = new Error('end refused');
  const attempts = [];
  const { session, run } = clear({
    failAppend: (type) => {
      attempts.push(type);
      if (type === 'compaction/end') throw refusal;
    },
  });
  const error = thrownBy(run);
  assert.ok(error instanceof ClearError);
  assert.equal(error.code, 'commit');
  assert.equal(error.cause, refusal);
  assert.deepEqual(typesOf(session), ['compaction/start', 'compaction/summary', 'user/message']);
  assert.equal(attempts.filter(type => type === 'compaction/end').length, 1);
});

test('a refused error end after a refused replacement is tried once and the replacement\'s failure is the one thrown', () => {
  const refusal = new Error('replacement refused');
  const attempts = [];
  const { session, run } = clear({
    failAppend: (type) => {
      attempts.push(type);
      if (type === 'user/message') throw refusal;
      if (type === 'compaction/end') throw new Error('end refused');
    },
  });
  const error = thrownBy(run);
  assert.ok(error instanceof ClearError);
  assert.equal(error.code, 'commit');
  assert.equal(error.cause, refusal);
  assert.deepEqual(typesOf(session), ['compaction/start', 'compaction/summary']);
  assert.equal(attempts.filter(type => type === 'compaction/end').length, 1);
});
