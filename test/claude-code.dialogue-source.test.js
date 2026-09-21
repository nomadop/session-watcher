// test/claude-code.dialogue-source.test.js — sealed full-Source read behind the DialogueSource Adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeDialogueSource } from '../lib/harness/claude-code/dialogue-source.js';
import { ts, userMessage, assistantObservation, writeTranscript } from './helpers/transcript-fixtures.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sw-cc-dialogue-'));
}

function assistantWithUsage({ uuid, parentUuid = null, messageId, timestamp, text }) {
  const entry = assistantObservation({
    uuid, parentUuid, messageId, timestamp, blocks: [{ type: 'text', text }],
  });
  entry.message.usage = {
    input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0,
  };
  return entry;
}

test('an unreadable Source returns unavailable with no observations', () => {
  const source = createClaudeCodeDialogueSource();
  const result = source.read(join(tmpDir(), 'absent.jsonl'));

  assert.deepEqual(result, { status: 'unavailable', observations: [] });
});

test('a readable empty Source returns ok with no observations', () => {
  const path = join(tmpDir(), 'empty.jsonl');
  writeFileSync(path, '');

  assert.deepEqual(createClaudeCodeDialogueSource().read(path), { status: 'ok', observations: [] });
});

test('a readable all-malformed Source returns ok with no observations', () => {
  const path = join(tmpDir(), 'malformed.jsonl');
  writeFileSync(path, 'not-json\n{"broken":\n');

  assert.deepEqual(createClaudeCodeDialogueSource().read(path), { status: 'ok', observations: [] });
});

test('malformed complete rows are skipped and later valid rows continue', () => {
  const path = join(tmpDir(), 'mixed.jsonl');
  writeFileSync(path, [
    'not-json',
    JSON.stringify(userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) })),
    'also-not-json',
    JSON.stringify(userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'again', timestamp: ts(2) })),
  ].join('\n') + '\n');

  const { status, observations } = createClaudeCodeDialogueSource().read(path);

  assert.equal(status, 'ok');
  assert.deepEqual(observations.filter(o => o.type === 'text').map(o => o.text), ['hi', 'again']);
  assert.deepEqual(observations.filter(o => o.type === 'text').map(o => o.sourceOrdinal), [2, 4]);
});

test('a sealed read accepts a final newline-less row', () => {
  const path = join(tmpDir(), 'unterminated.jsonl');
  writeFileSync(path, [
    JSON.stringify(userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) })),
    JSON.stringify(userMessage({ uuid: 'u2', parentUuid: 'u1', text: 'tail', timestamp: ts(2) })),
  ].join('\n'));

  const { observations } = createClaudeCodeDialogueSource().read(path);

  assert.deepEqual(observations.filter(o => o.type === 'text').map(o => o.text), ['hi', 'tail']);
});

test('one read returns the complete canonical multi-epoch snapshot', () => {
  const dir = tmpDir();
  const path = writeTranscript(dir, [
    userMessage({ uuid: 'u1', text: 'first epoch', timestamp: ts(1) }),
    assistantWithUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), text: 'one' }),
    userMessage({ uuid: 'u2', text: 'second epoch', timestamp: ts(3) }),
    assistantWithUsage({ uuid: 'a2', parentUuid: 'u2', messageId: 'msg_2', timestamp: ts(4), text: 'two' }),
  ]);

  const { status, observations } = createClaudeCodeDialogueSource().read(path);

  assert.equal(status, 'ok');
  assert.deepEqual(observations.filter(o => o.type === 'text').map(o => o.text),
    ['first epoch', 'one', 'second epoch', 'two']);
  const epochs = observations.filter(o => o.type === 'epoch-boundary');
  assert.deepEqual(epochs.map(o => o.sourceEntryId), ['u2']);
});

test('repeated reads build fresh reconstruction state and return detached values', () => {
  const dir = tmpDir();
  const path = writeTranscript(dir, [
    userMessage({ uuid: 'u1', text: 'hi', timestamp: ts(1) }),
    assistantWithUsage({ uuid: 'a1', parentUuid: 'u1', messageId: 'msg_1', timestamp: ts(2), text: 'ok' }),
  ]);
  const source = createClaudeCodeDialogueSource();

  const first = source.read(path);
  const second = source.read(path);

  assert.deepEqual(first, second);
  assert.notEqual(first.observations, second.observations);
  assert.notEqual(first.observations[0], second.observations[0]);

  first.observations.length = 0;
  first.observations.push({ type: 'mutated' });
  assert.ok(second.observations.length > 1, 'a mutated result does not reach the next read');
  assert.deepEqual(source.read(path).observations, second.observations);
});

test('a Source read failure is reported as unavailable rather than thrown', () => {
  const source = createClaudeCodeDialogueSource({
    readFile: () => { throw new Error('EACCES'); },
  });

  assert.deepEqual(source.read('/anything'), { status: 'unavailable', observations: [] });
});

test('the Adapter reads the locator it is given', () => {
  const seen = [];
  const source = createClaudeCodeDialogueSource({
    readFile: locator => { seen.push(locator); return Buffer.from(''); },
  });

  source.read('/transcripts/session.jsonl');
  assert.deepEqual(seen, ['/transcripts/session.jsonl']);
});
