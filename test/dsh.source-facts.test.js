// test/dsh.source-facts.test.js — the facts of the DSH measurement Source at an event cut: which usage points the open
// epoch selects and the roles they hold, and the post each inner-seal carrier waits for or is given. The inner monitor's
// projection and the measurement source fold read the same fold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSourceFacts, initialSourceFacts, qualifiedCalls } from '../lib/harness/dsh/source-facts.js';
import * as E from './helpers/dsh-events.js';

const U = n => ({ inputTokens: 2, outputTokens: 40, cacheReadTokens: 1_000 * n, cacheWriteTokens: 100 });
const READ = { id: 'call_read', name: 'read', arguments: '{"file_path":"src/a.js"}' };

// The facts after the first `count` events of `log`, the whole log when none is given.
const factsOf = (log, count = log.length) => log.slice(0, count).reduce((facts, event) => foldSourceFacts(facts, event), initialSourceFacts());
const rolesOf = facts => facts.points.map(({ seq, role }) => [seq, role]);
const postsOf = facts => facts.carriers.map(({ seq, post }) => [seq, post === null ? null : [post.seq, post.usage?.cacheRead ?? null]]);

test('a carrier waits for its post until a main call follows it, and takes the first one whether or not it reports usage', () => {
  const head = E.assistantMessage({ step: 1, toolCalls: [READ], usage: U(1) });
  const result = E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' });
  const first = E.innerSealCarrier({ sourceEventSeqs: [head.seq, result.seq] });
  const missing = E.assistantMessage({ step: 2, text: 'No count reported.' });
  const later = E.assistantMessage({ step: 3, text: 'Counted.', usage: U(2) });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, result, first, missing, later]);

  assert.deepEqual(postsOf(factsOf(log, 5)), [[4, null]], 'no main call yet: waiting');
  assert.deepEqual(postsOf(factsOf(log, 6)), [[4, [5, null]]], 'the first main call reports no usage: missing');
  assert.deepEqual(postsOf(factsOf(log)), [[4, [5, null]]], 'a later call with usage fills nothing back');
  assert.deepEqual(rolesOf(factsOf(log)), [[2, 'head'], [6, 'current']], 'and is a point of the unsealed range like any other');
});

test('carriers with no main call between them share one post, which is one point', () => {
  const head = E.assistantMessage({ step: 1, toolCalls: [READ], usage: U(1) });
  const result = E.toolResult({ step: 1, callId: READ.id, text: 'export const a = 1;' });
  const first = E.innerSealCarrier({ sourceEventSeqs: [head.seq, result.seq] });
  const second = E.innerSealCarrier({ sourceEventSeqs: [first.seq] });
  const post = E.assistantMessage({ step: 2, text: 'Counted.', usage: U(2) });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, result, first, second, post]);

  const facts = factsOf(log);
  assert.deepEqual(postsOf(facts), [[4, [6, 2_000]], [5, [6, 2_000]]]);
  assert.deepEqual(rolesOf(facts), [[2, 'head'], [6, 'post']]);
});

test('a carrier selects its post from its own epoch: a true epoch between the two leaves the old carrier waiting and opens its own head', () => {
  const head = E.assistantMessage({ step: 1, usage: U(1) });
  const carrier = E.innerSealCarrier({ sourceEventSeqs: [head.seq] });
  const checkpoint = E.compactCheckpoint({ startSeq: head.seq, endSeq: carrier.seq });
  const next = E.assistantMessage({ step: 2, usage: U(2) });
  const later = E.assistantMessage({ step: 3, usage: U(3) });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, carrier, checkpoint, next, later]);

  const facts = factsOf(log);
  assert.equal(facts.epoch, 1);
  assert.deepEqual(postsOf(facts), [[3, null]], 'the chain of the epoch before takes no point of this one');
  assert.deepEqual(rolesOf(facts), [[5, 'head'], [6, 'current']], 'the first call of a true epoch is its own head, and the call after it is no post of the carrier before');
});

test('the points of the unsealed range go with the next carrier that lists them, and the head and every post stay through every seal', () => {
  const head = E.assistantMessage({ step: 1, usage: U(1) });
  const mid = E.assistantMessage({ step: 2, usage: U(2) });
  const first = E.innerSealCarrier({ sourceEventSeqs: [head.seq, mid.seq] });
  const post = E.assistantMessage({ step: 3, usage: U(3) });
  const current = E.assistantMessage({ step: 4, usage: U(4) });
  const second = E.innerSealCarrier({ sourceEventSeqs: [post.seq, current.seq] });
  const after = E.assistantMessage({ step: 5, usage: U(5) });
  const unlisted = E.assistantMessage({ step: 6, usage: U(6) });
  const third = E.innerSealCarrier({ sourceEventSeqs: [after.seq] });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, mid, first, post, current, second, after, unlisted, third]);

  assert.deepEqual(rolesOf(factsOf(log, 4)), [[2, 'head'], [3, 'current']]);
  assert.deepEqual(rolesOf(factsOf(log, 5)), [[2, 'head']], 'the first seal takes the unsealed second step');
  assert.deepEqual(rolesOf(factsOf(log, 7)), [[2, 'head'], [5, 'post'], [6, 'current']]);
  assert.deepEqual(rolesOf(factsOf(log, 8)), [[2, 'head'], [5, 'post']], 'the second seal takes the current call and keeps the post it lists');
  assert.deepEqual(rolesOf(factsOf(log)), [[2, 'head'], [5, 'post'], [8, 'post'], [9, 'current']], 'the third seal lists the second one\'s post and keeps it, and a call it does not list stays a point of the unsealed range');
});

test('the qualified calls are the points ahead of the first one still pending, and a post behind a pending point waits with it', () => {
  const head = E.assistantMessage({ step: 1, usage: U(1) });
  const mid = E.assistantMessage({ step: 2, usage: U(2) });
  const first = E.innerSealCarrier({ sourceEventSeqs: [head.seq, mid.seq] });
  const post = E.assistantMessage({ step: 3, usage: U(3) });
  const current = E.assistantMessage({ step: 4, usage: U(4) });
  const second = E.innerSealCarrier({ sourceEventSeqs: [post.seq, current.seq] });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, mid, first, post, current, second]);

  assert.equal(qualifiedCalls(initialSourceFacts()), 0, 'no point yet');
  assert.equal(qualifiedCalls(factsOf(log, 3)), 1, 'the head');
  assert.equal(qualifiedCalls(factsOf(log, 4)), 1, 'the unsealed call after the head is pending');
  assert.equal(qualifiedCalls(factsOf(log, 5)), 1, 'its seal takes it away and leaves the head');
  assert.equal(qualifiedCalls(factsOf(log, 6)), 2, 'the post behind the carrier is qualified at once');
  assert.equal(qualifiedCalls(factsOf(log, 7)), 2, 'a call behind the post is pending');
  assert.equal(qualifiedCalls(factsOf(log, 8)), 2, 'a seal that lists the post and the pending call keeps the post');
});

test('a partial seal leaves its post behind a pending point: the prefix stops there and does not skip to the post', () => {
  const head = E.assistantMessage({ step: 1, usage: U(1) });
  const first = E.assistantMessage({ step: 2, usage: U(2) });
  const second = E.assistantMessage({ step: 3, usage: U(3) });
  const partial = E.innerSealCarrier({ sourceEventSeqs: [second.seq] });
  const post = E.assistantMessage({ step: 4, usage: U(4) });
  const facts = factsOf(E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, first, second, partial, post]));

  assert.deepEqual(rolesOf(facts), [[2, 'head'], [3, 'current'], [6, 'post']]);
  assert.equal(qualifiedCalls(facts), 1);
});

test('a main call that reports no usage is no point, so it moves no prefix and is no one\'s stand-in', () => {
  const head = E.assistantMessage({ step: 1, usage: U(1) });
  const carrier = E.innerSealCarrier({ sourceEventSeqs: [head.seq] });
  const missing = E.assistantMessage({ step: 2, text: 'No count reported.' });
  const later = E.assistantMessage({ step: 3, usage: U(3) });
  const log = E.sessionLog([E.turnStart(), E.userMessage({ text: 'Work.' }), head, carrier, missing, later]);

  assert.equal(qualifiedCalls(factsOf(log, 5)), 1, 'the head alone, whose post reported nothing');
  assert.equal(qualifiedCalls(factsOf(log)), 1, 'the call after it is pending and fills nothing back');
});
