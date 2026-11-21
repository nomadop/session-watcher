// test/measurement-source-facts.test.js — the facts of a measurement Source at an event cut: which usage points the open
// epoch selects and the roles they hold, and the post each carrier waits for or is given. The inputs are written by
// hand in the shape a harness adapter hands the fold, so the facts are read without any harness reducer; the inner
// monitor's projection and the measurement source fold read the same fold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSourceFacts, initialSourceFacts, isSourceFacts, qualifiedCalls, startsEpoch } from '../lib/measurement/source-facts.js';
import * as S from './helpers/source-inputs.js';

const U = n => S.usage(1_000 * n);

// The facts after the first `count` inputs of `log`, the whole log when none is given.
const factsOf = (log, count = log.length) => log.slice(0, count).reduce((facts, input) => foldSourceFacts(facts, input), initialSourceFacts());
const rolesOf = facts => facts.points.map(({ seq, role }) => [seq, role]);
const postsOf = facts => facts.carriers.map(({ seq, post }) => [seq, post === null ? null : [post.seq, post.usage?.cacheRead ?? null]]);

test('a carrier waits for its post until a main call follows it, and takes the first one whether or not it reports usage', () => {
  const head = S.call({ tools: ['read'], usage: U(1) });
  const result = S.result('read');
  const first = S.seal(head, result);
  const missing = S.call();
  const later = S.call({ usage: U(2) });
  const log = S.sourceLog([S.quiet(), S.question(), head, result, first, missing, later]);

  assert.deepEqual(postsOf(factsOf(log, 5)), [[4, null]], 'no main call yet: waiting');
  assert.deepEqual(postsOf(factsOf(log, 6)), [[4, [5, null]]], 'the first main call reports no usage: missing');
  assert.deepEqual(postsOf(factsOf(log)), [[4, [5, null]]], 'a later call with usage fills nothing back');
  assert.deepEqual(rolesOf(factsOf(log)), [[2, 'head'], [6, 'current']], 'and is a point of the unsealed range like any other');
});

test('carriers with no main call between them share one post, which is one point', () => {
  const head = S.call({ tools: ['read'], usage: U(1) });
  const result = S.result('read');
  const first = S.seal(head, result);
  const second = S.seal(first);
  const post = S.call({ usage: U(2) });
  const log = S.sourceLog([S.quiet(), S.question(), head, result, first, second, post]);

  const facts = factsOf(log);
  assert.deepEqual(postsOf(facts), [[4, [6, 2_000]], [5, [6, 2_000]]]);
  assert.deepEqual(rolesOf(facts), [[2, 'head'], [6, 'post']]);
});

test('a carrier selects its post from its own epoch: a true epoch between the two leaves the old carrier waiting and opens its own head', () => {
  const head = S.call({ usage: U(1) });
  const carrier = S.seal(head);
  const next = S.call({ usage: U(2) });
  const later = S.call({ usage: U(3) });
  const log = S.sourceLog([S.quiet(), S.question(), head, carrier, S.boundary(), next, later]);

  const facts = factsOf(log);
  assert.equal(facts.epoch, 1);
  assert.deepEqual(postsOf(facts), [[3, null]], 'the chain of the epoch before takes no point of this one');
  assert.deepEqual(rolesOf(facts), [[5, 'head'], [6, 'current']], 'the first call of a true epoch is its own head, and the call after it is no post of the carrier before');
});

test('the points of the unsealed range go with the next carrier that lists them, and the head and every post stay through every seal', () => {
  const head = S.call({ usage: U(1) });
  const mid = S.call({ usage: U(2) });
  const first = S.seal(head, mid);
  const post = S.call({ usage: U(3) });
  const current = S.call({ usage: U(4) });
  const second = S.seal(post, current);
  const after = S.call({ usage: U(5) });
  const unlisted = S.call({ usage: U(6) });
  const third = S.seal(after);
  const log = S.sourceLog([S.quiet(), S.question(), head, mid, first, post, current, second, after, unlisted, third]);

  assert.deepEqual(rolesOf(factsOf(log, 4)), [[2, 'head'], [3, 'current']]);
  assert.deepEqual(rolesOf(factsOf(log, 5)), [[2, 'head']], 'the first seal takes the unsealed second step');
  assert.deepEqual(rolesOf(factsOf(log, 7)), [[2, 'head'], [5, 'post'], [6, 'current']]);
  assert.deepEqual(rolesOf(factsOf(log, 8)), [[2, 'head'], [5, 'post']], 'the second seal takes the current call and keeps the post it lists');
  assert.deepEqual(rolesOf(factsOf(log)), [[2, 'head'], [5, 'post'], [8, 'post'], [9, 'current']], 'the third seal lists the second one\'s post and keeps it, and a call it does not list stays a point of the unsealed range');
});

test('the qualified calls are the points ahead of the first one still pending, and a post behind a pending point waits with it', () => {
  const head = S.call({ usage: U(1) });
  const mid = S.call({ usage: U(2) });
  const first = S.seal(head, mid);
  const post = S.call({ usage: U(3) });
  const current = S.call({ usage: U(4) });
  const second = S.seal(post, current);
  const log = S.sourceLog([S.quiet(), S.question(), head, mid, first, post, current, second]);

  assert.equal(qualifiedCalls(initialSourceFacts()), 0, 'no point yet');
  assert.equal(qualifiedCalls(factsOf(log, 3)), 1, 'the head');
  assert.equal(qualifiedCalls(factsOf(log, 4)), 1, 'the unsealed call after the head is pending');
  assert.equal(qualifiedCalls(factsOf(log, 5)), 1, 'its seal takes it away and leaves the head');
  assert.equal(qualifiedCalls(factsOf(log, 6)), 2, 'the post behind the carrier is qualified at once');
  assert.equal(qualifiedCalls(factsOf(log, 7)), 2, 'a call behind the post is pending');
  assert.equal(qualifiedCalls(factsOf(log, 8)), 2, 'a seal that lists the post and the pending call keeps the post');
});

test('a partial seal leaves its post behind a pending point: the prefix stops there and does not skip to the post', () => {
  const head = S.call({ usage: U(1) });
  const first = S.call({ usage: U(2) });
  const second = S.call({ usage: U(3) });
  const partial = S.seal(second);
  const post = S.call({ usage: U(4) });
  const facts = factsOf(S.sourceLog([S.quiet(), S.question(), head, first, second, partial, post]));

  assert.deepEqual(rolesOf(facts), [[2, 'head'], [3, 'current'], [6, 'post']]);
  assert.equal(qualifiedCalls(facts), 1);
});

test('a main call that reports no usage is no point, so it moves no prefix and is no one\'s stand-in', () => {
  const head = S.call({ usage: U(1) });
  const carrier = S.seal(head);
  const missing = S.call();
  const later = S.call({ usage: U(3) });
  const log = S.sourceLog([S.quiet(), S.question(), head, carrier, missing, later]);

  assert.equal(qualifiedCalls(factsOf(log, 5)), 1, 'the head alone, whose post reported nothing');
  assert.equal(qualifiedCalls(factsOf(log)), 1, 'the call after it is pending and fills nothing back');
});

test('a main call whose message yielded no Observation is still a main call: it is the post of a carrier waiting, with no usage', () => {
  const head = S.call({ usage: U(1) });
  const carrier = S.seal(head);
  const malformed = S.callWithoutObservations([{ scope: 'any', code: 'shape-violation', message: 'x' }]);
  const log = S.sourceLog([S.quiet(), S.question(), head, carrier, malformed]);

  assert.deepEqual(postsOf(factsOf(log)), [[3, [4, null]]]);
  assert.deepEqual(rolesOf(factsOf(log)), [[2, 'head']]);
});

test('an input whose seq is no index changes nothing, whatever it states', () => {
  const head = S.call({ usage: U(1) });
  const log = S.sourceLog([S.quiet(), S.question(), head, S.seal(head), S.boundary(), S.call({ usage: U(2) })]);
  const facts = factsOf(log);
  for (const input of log) {
    for (const seq of [-1, 1.5, '3', undefined, null]) assert.equal(foldSourceFacts(facts, { ...input, seq }), facts, `${input.seq} as ${String(seq)}`);
  }
});

test('a true epoch is a boundary Observation of the input, whatever else the input holds', () => {
  assert.equal(startsEpoch(S.sourceLog([S.boundary()])[0]), true);
  for (const input of S.sourceLog([S.quiet(), S.question(), S.call({ usage: U(1) }), S.seal(1), S.result('read')])) assert.equal(startsEpoch(input), false);
});

test('the facts a state is read back as are those the fold builds: its shape stands, the fold\'s own answers pass and anything else fails', () => {
  const head = S.call({ usage: U(1) });
  const facts = factsOf(S.sourceLog([S.quiet(), S.question(), head, S.seal(head), S.call({ usage: U(2) })]));
  assert.equal(isSourceFacts(initialSourceFacts()), true);
  assert.equal(isSourceFacts(facts), true);
  assert.equal(isSourceFacts(JSON.parse(JSON.stringify(facts))), true);
  for (const broken of [null, [], {}, { ...facts, epoch: -1 }, { ...facts, headDone: 1 }, { ...facts, points: [{ seq: 2, role: 'other' }] }, { ...facts, carriers: [{ seq: 3, epoch: 0, post: { seq: 4, usage: { input: 1 } } }] }]) {
    assert.equal(isSourceFacts(broken), false, JSON.stringify(broken));
  }
});
