// The two sentences the handoff commands write into the session log and the inner monitor reads back, one definition each (`dsh/src/handoff-text.js`): what the producers write is read back to the token, and what they write opens with the sentence the reader looks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpointText, checkpointTokenOf, loadedLead, loadedTokenOf } from '../dsh/src/handoff-text.js';
import { loadedText } from '../dsh/src/load.js';

test('the checkpoint of /sw-continue names the token after its fixed lead and reads back to it, and only that text does', () => {
  assert.equal(checkpointText('amber-falcon'), '[Session Watcher] Context cleared by /sw-continue. Handoff token: amber-falcon');
  assert.equal(checkpointTokenOf('[Session Watcher] Context cleared by /sw-continue. Handoff token: amber-falcon'), 'amber-falcon');
  assert.equal(checkpointTokenOf(checkpointText('copper heron')), 'copper heron');
  assert.equal(checkpointTokenOf('[Session Watcher] Context cleared by /sw-continue. Handoff token: '), null);
  assert.equal(checkpointTokenOf('Handoff token: amber-falcon'), null);
  assert.equal(checkpointTokenOf(undefined), null);
});

test('the lead of a load\'s follow-up names the token as a JSON string and reads back to it, a token with a slash after whitespace included, and only a text that opens with it does', () => {
  assert.equal(loadedLead('amber-falcon'), 'Handoff "amber-falcon" is loaded.');
  assert.equal(loadedLead('a /b'), 'Handoff "a \\/b" is loaded.');
  for (const token of ['amber-falcon', 'a /b', 'quote"inside', 'back\\slash']) {
    assert.equal(loadedTokenOf(`${loadedLead(token)} The harness placed two messages.`), token, token);
  }
  assert.equal(loadedTokenOf('Handoff "amber-falcon" is loaded'), null, 'no full stop');
  assert.equal(loadedTokenOf('See Handoff "amber-falcon" is loaded.'), null, 'not at the start');
  assert.equal(loadedTokenOf('Handoff "bad\\qescape" is loaded.'), null);
  assert.equal(loadedTokenOf('Handoff amber-falcon is loaded.'), null);
  assert.equal(loadedTokenOf(undefined), null);
});

test('the follow-up `loadedText` writes opens with that lead, whichever variant and however many messages the harness placed', () => {
  const loaded = { token: 'amber-falcon', skipped: [], unread: [], toPlace: [], skills: [], empty: false, reads: 0 };
  for (const [reads, resume] of [[0, false], [2, false], [0, true], [2, true]]) {
    const text = loadedText({ ...loaded, reads }, { resume });
    assert.equal(loadedTokenOf(text), 'amber-falcon', `${reads} reads, resume ${resume}`);
    assert.equal(text.startsWith('Handoff "amber-falcon" is loaded. The harness placed '), true, `${reads} reads, resume ${resume}`);
  }
});
