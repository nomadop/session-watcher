// The recall judge (`lib/harness/dsh/recall-judge.js`): what a request is as a recall, judged call by call from the events pushed after it, the reads of lines the context held that the read guard blocked among them.
// The settlement and the Source facts that judge through it are the cases of `test/dsh.inner-monitor-settlement-recall.test.js` and `test/dsh.source-driver.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecallJudge, judgeOf } from '../lib/harness/dsh/recall-judge.js';
import { assistantMessage, ignorableEvent, readBlockRecord, toolCall, toolResult, userMessage } from './helpers/dsh-events.js';

const SESSION = 's-judge';
const file = id => ({ id, name: 'read', arguments: JSON.stringify({ file_path: 'a.js' }) });
const readBack = (id, seq) => ({ id, name: 'sw_event_read', arguments: JSON.stringify({ seq }) });
const dispatchOf = calls => calls.map(({ id, name, arguments: args }) => toolCall({ callId: id, name, arguments: args }));

// A judge fed `events` in order: what each event answered, and the verdict on the latest request after the last of them.
function judged(events) {
  const judge = createRecallJudge({ sessionId: SESSION });
  const answers = events.map(event => judge.push(event));
  return { answers, verdict: () => judgeOf(answers.findLast(answer => answer !== undefined).sample) };
}

test('a request of reads the guard blocked is pure once each call has its record, and an ordinary one before', () => {
  const calls = [file('a'), file('b')];
  const request = assistantMessage({ toolCalls: calls });
  const dispatched = dispatchOf(calls);
  const records = calls.map(({ id }) => readBlockRecord({ callId: id }));
  const answers = calls.map(({ id }) => toolResult({ callId: id, text: 'Error: already in your context', isError: true }));

  assert.equal(judged([request, ...dispatched]).verdict(), 'other');
  assert.equal(judged([request, ...dispatched, records[0]]).verdict(), 'other', 'one of two');
  assert.equal(judged([request, ...dispatched, ...records]).verdict(), 'pure');
  assert.equal(judged([request, ...dispatched, ...records, ...answers]).verdict(), 'pure');
});

test('a blocked read stands beside a read of an event the request makes, and a call that is neither leaves the request none', () => {
  const ask = userMessage({ text: 'task' });
  const calls = [file('a'), readBack('b', ask.seq)];
  assert.equal(judged([ask, assistantMessage({ toolCalls: calls }), ...dispatchOf(calls), readBlockRecord({ callId: 'a' })]).verdict(), 'pure');
  const neither = [file('c'), readBack('d', ask.seq)];
  assert.equal(judged([ask, assistantMessage({ toolCalls: neither }), ...dispatchOf(neither)]).verdict(), 'other', 'a read of a file with no record');
});

test('the record answers as a touch of the request and the call it names, the way a dispatch does', () => {
  const calls = [file('a')];
  const request = assistantMessage({ toolCalls: calls });
  const { answers } = judged([request, ...dispatchOf(calls), readBlockRecord({ callId: 'a' })]);
  assert.equal(answers[2].sample, answers[0].sample);
  assert.equal(answers[2].call, answers[1].call, 'the call the dispatch touched');
  assert.deepEqual(answers[2].call, { target: undefined, dispatched: true, skipped: false, resulted: false, blocked: true });
});

test('a record that names no call of the latest request, reads as no block or is no plugin record leaves the request as it was, and one the judge is not asked to follow touches none', () => {
  const calls = [file('a')];
  const request = assistantMessage({ toolCalls: calls });
  const dispatched = dispatchOf(calls);
  const unreadable = readBlockRecord({ callId: 'a' });
  delete unreadable.data.last;
  const stray = [
    ['another step', readBlockRecord({ callId: 'a', step: 2 })],
    ['another turn', readBlockRecord({ callId: 'a', turn: 2 })],
    ['an unreadable record', unreadable],
    ['an event no plugin wrote', { ...readBlockRecord({ callId: 'a' }), ignorable: undefined }],
  ];
  for (const [why, record] of stray) {
    const { answers, verdict } = judged([request, ...dispatched, record]);
    assert.equal(answers.at(-1), undefined, why);
    assert.equal(verdict(), 'other', why);
  }
  const ghost = judged([request, ...dispatched, readBlockRecord({ callId: 'ghost' })]);
  assert.equal(ghost.answers.at(-1).call, undefined, 'a call of the request no one issued');
  assert.equal(ghost.verdict(), 'other');

  const judge = createRecallJudge({ sessionId: SESSION });
  assert.equal(judge.push(readBlockRecord({ callId: 'a' })), undefined, 'a record before any request');
  for (const event of [request, ...dispatched]) judge.push(event);
  assert.equal(judge.push(readBlockRecord({ callId: 'a' }), { track: false }), undefined, 'a record the caller does not track');
  assert.equal(judge.push(ignorableEvent({ type: 'plugin:session-watcher/inner-mode', data: { v: 1 } })), undefined);
});
