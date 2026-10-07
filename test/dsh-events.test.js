// test/dsh-events.test.js — the DSH event builders' replace events as a DSH session log accepts them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  userMessage, assistantMessage, stepStart, toolResult, compactCheckpoint, prunedResult, sessionLog,
} from './helpers/dsh-events.js';

// DSH appends a replace only when its `sourceEventSeqs` is a duplicate-free list of earlier seqs that includes every
// surface node the replace shadows. Which events of a range are surface nodes is DSH's to decide, so every event the
// replace covers must be cited.
function assertCitesReplaced(replace, replaced) {
  const cited = replace.sourceEventSeqs;
  assert.ok(Array.isArray(cited), 'sourceEventSeqs is a list');
  assert.equal(new Set(cited).size, cited.length, 'no seq is cited twice');
  for (const { seq } of replaced) assert.ok(cited.includes(seq), `replaced seq ${seq} is cited`);
  for (const seq of cited) assert.ok(seq < replace.seq, `cited seq ${seq} is earlier than ${replace.seq}`);
}

test('a pruned result cites the tool result it replaces', () => {
  const original = toolResult({ callId: 'call_read', text: 'export function parse() {}' });
  assertCitesReplaced(prunedResult(original), [original]);
});

test('a compact checkpoint cites every event from its start seq through its end seq', () => {
  const replaced = [
    userMessage({ text: 'Where is parse defined?' }),
    stepStart({ step: 1 }),
    assistantMessage({ step: 1, text: 'Reading src/a.js.' }),
    toolResult({ step: 1, callId: 'call_read', text: 'export function parse() {}' }),
  ];
  const checkpoint = compactCheckpoint({ startSeq: replaced[0].seq, endSeq: replaced.at(-1).seq });
  assertCitesReplaced(checkpoint, replaced);
});

test('sessionLog renumbers the cited seqs with the events they name', () => {
  userMessage(); // built outside the log, so the log's seqs differ from the built ones
  const question = userMessage({ text: 'Where is parse defined?' });
  const original = toolResult({ callId: 'call_read', text: 'export function parse() {}' });
  const pruned = prunedResult(original);
  const answer = assistantMessage({ text: 'In src/a.js.' });
  const checkpoint = compactCheckpoint({ startSeq: question.seq, endSeq: answer.seq });

  const log = sessionLog([question, original, pruned, answer, checkpoint]);
  assertCitesReplaced(log[2], [log[1]]);
  assertCitesReplaced(log[4], log.slice(0, 4));
});
