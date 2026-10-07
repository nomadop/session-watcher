// test/dsh.dialogue-source.test.js — the DSH DialogueSource Adapter: one complete `readSession` per read,
// its snapshot reduced through the same reducer Measurement reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDshDialogueSource } from '../lib/harness/dsh/dialogue-source.js';
import { reduceDshSnapshot } from '../lib/harness/dsh/transcript-observation.js';
import { userMessage, sessionLog } from './helpers/dsh-events.js';

test('read calls readSession once per call and reduces the snapshot', async () => {
  const events = sessionLog([userMessage({ text: 'Where is parse defined?' })]);
  const calls = [];
  const source = createDshDialogueSource({
    readSession: async sessionId => { calls.push(sessionId); return { events }; },
  });

  const result = await source.read('session-a');

  assert.deepEqual(calls, ['session-a']);
  assert.deepEqual(result, { status: 'ok', observations: reduceDshSnapshot(events).observations });

  await source.read('session-a');
  assert.deepEqual(calls, ['session-a', 'session-a'], 'no cache: a second read calls readSession again');
});

test('a rejected readSession reads as unavailable', async () => {
  const source = createDshDialogueSource({ readSession: () => Promise.reject(new Error('unreachable')) });

  assert.deepEqual(await source.read('session-a'), { status: 'unavailable', observations: [] });
});

test('a thrown readSession reads as unavailable', async () => {
  const source = createDshDialogueSource({ readSession: () => { throw new Error('unreachable'); } });

  assert.deepEqual(await source.read('session-a'), { status: 'unavailable', observations: [] });
});

test('a reducer failure rejects', async () => {
  // A read that throws inside the reducer, before any shape check: `data.source` is accessed as the very
  // first field `reduceDshEvent` reads for a `user/message`.
  const malformed = {
    type: 'user/message', seq: 0, time: 0,
    data: { get source() { throw new Error('malformed source'); } },
  };
  const source = createDshDialogueSource({ readSession: async () => ({ events: [malformed] }) });

  await assert.rejects(() => source.read('session-a'), /malformed source/);
});
