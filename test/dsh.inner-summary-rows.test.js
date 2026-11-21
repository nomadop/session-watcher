// The rows the inner seal's auxiliary call (`dsh/src/inner-summary.js`) puts in its C tail for an assistant step's tool calls, against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names: the real detached `Session` over a recording `llm.stream`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { summarizeSlots } from '../dsh/src/inner-summary.js';
import { eventFactOf } from '../lib/harness/dsh/event-facts.js';
import { assistantMessage, requestHeader, sessionLog, stepEnd, stepStart, systemMessage, toolResult, turnEnd, turnStart, userMessage } from './helpers/dsh-events.js';

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
});

const SELECTION = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' };

// The rows block of the tail the call sent: the lines between the slot list's heading and the reply instruction.
const rowLinesOf = (tail) => {
  const text = tail.content.map(block => block.text).join('');
  const from = text.indexOf('Slots, oldest first:\n') + 'Slots, oldest first:\n'.length;
  return text.slice(from, text.indexOf('\n\nReply with')).split('\n');
};

// The rows of one assistant step that made `calls` (`{ id, name, arguments }`), each answered by a result, a failed one when its id is in `failing`; a standalone tool result of a call outside the range follows as a slot of its own.
async function rowsOf(calls, failing = []) {
  const reply = assistantMessage({ step: 1, toolCalls: calls });
  const results = calls.map(call => toolResult({ callId: call.id, text: 'done', isError: failing.includes(call.id) }));
  const orphan = toolResult({ callId: 'call-outside', text: 'late', step: 2 });
  const events = [systemMessage(), turnStart(), userMessage({ text: 'work' }), stepStart({ step: 1 }), requestHeader(), reply, ...results, stepEnd({ step: 1 }), orphan, turnEnd()];
  const session = sessionPackage.Session.create('rows', sessionLog(events), { version: 4, id: 'rows', createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 }, 0);
  const slots = [{ seqs: [events.indexOf(reply), ...results.map(result => events.indexOf(result))], step: { turn: 1, step: 1 } }, { seqs: [events.indexOf(orphan)] }];
  const sent = [];
  const llm = {
    stream(options) {
      sent.push(options);
      return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })();
    },
  };
  await summarizeSlots({
    llm, session, index: new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)])), events: session.snapshotEvents(), selection: SELECTION,
    slots, range: slots.flatMap(slot => slot.seqs), held: { paths: new Map(), skills: new Map() }, signal: new AbortController().signal, kit: kitOf(),
  });
  return rowLinesOf(sent[0].messages.at(-1));
}

test('a call row carries the call\'s id, its tool name, its outcome and the values of its arguments joined by single spaces in the order they appear, nested ones included: a string as it is, a number or a boolean after the key it sits under, and null left out', { skip }, async () => {
  const rows = await rowsOf([
    { id: 'c1', name: 'edit', arguments: JSON.stringify({ description: 'why', path: 'src/a.js', replace_all: true, count: 3, edits: [{ old: 'x', n: 1 }, { old: 'y', gone: null }], note: 'last' }) },
  ]);
  assert.deepEqual(rows.slice(0, 3), ['[1] assistant step', '  text: none', '  call c1 edit → ok: "why src/a.js replace_all true count 3 x n 1 y last"']);
});

test('the arguments cue is whole up to the cue width and its opening and ending around an ellipsis beyond it, with runs of whitespace folded', { skip }, async () => {
  const short = `${'a'.repeat(30)}  \n${'b'.repeat(29)}`;
  const long = `${'a'.repeat(40)} ${'m'.repeat(40)} ${'z'.repeat(40)}`;
  const rows = await rowsOf([
    { id: 'c1', name: 'bash', arguments: JSON.stringify({ command: short }) },
    { id: 'c2', name: 'bash', arguments: JSON.stringify({ command: long }) },
  ]);
  assert.deepEqual(rows.slice(2, 4), [
    `  call c1 bash → ok: "${'a'.repeat(30)} ${'b'.repeat(29)}"`,
    `  call c2 bash → ok: "${'a'.repeat(30)}…${'z'.repeat(30)}"`,
  ]);
});

test('a failed call keeps its error outcome beside the arguments cue, and an answered call its ok', { skip }, async () => {
  const rows = await rowsOf([
    { id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' },
    { id: 'c2', name: 'read', arguments: '{"path":"src/a.js"}' },
  ], ['c1']);
  assert.deepEqual(rows.slice(2, 4), ['  call c1 bash → error: "npm test"', '  call c2 read → ok: "src/a.js"']);
});

test('a call with no string, number or boolean argument has no cue suffix, whatever shape its arguments take, a number keeps its key as an array element too, and arguments that are not JSON count as one string', { skip }, async () => {
  const rows = await rowsOf([
    { id: 'c1', name: 'a', arguments: '{}' },
    { id: 'c2', name: 'b', arguments: '{"none":null,"list":[[]],"empty":"","blank":"","space":" \\n"}' },
    { id: 'c6', name: 'sw_event_read', arguments: '{"seq":2038,"after":4,"ok":false,"list":[1,[]]}' },
    { id: 'c3', name: 'c', arguments: '' },
    { id: 'c4', name: 'd', arguments: 'not json' },
    { id: 'c5', name: 'e', arguments: '{"empty":"","path":"a.js","blank":""}' },
  ]);
  assert.deepEqual(rows.slice(2, 8), ['  call c1 a → ok', '  call c2 b → ok', '  call c6 sw_event_read → ok: "seq 2038 after 4 ok false list 1"', '  call c3 c → ok', '  call c4 d → ok: "not json"', '  call c5 e → ok: "a.js"']);
});

test('a standalone tool result row still names the id of the call it answers and no cue', { skip }, async () => {
  const rows = await rowsOf([{ id: 'c1', name: 'read', arguments: '{"path":"src/a.js"}' }]);
  assert.equal(rows.at(-1), '[2] tool result of call call-outside');
});
