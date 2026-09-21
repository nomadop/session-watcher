// test/dialogue-fold.timestamp.test.js — a projected line's timestamp is a numeric epoch, never the raw
// ISO string. Transcripts carry ISO-8601 times while source_timestamp is an INTEGER column and every
// consumer compares numbers; the conversion happens once, inside the Source, and the projection carries
// each row's own converted value onto the lines that row produced.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateDialogueLines, projectDialogue } from '../lib/dialogue-fold.js';
import {
  assistantObservation, assistantToolUse, chain, observationsOf, toolResult, userMessage,
} from './helpers/transcript-fixtures.js';

const linesOf = (entries) => enumerateDialogueLines(projectDialogue(observationsOf(entries)).folds);

describe('projected timestamps', () => {
  test('an assistant body carries a numeric epoch, not the raw ISO string', () => {
    const [line] = linesOf([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:01Z',
        blocks: [{ type: 'text', text: 'answer' }] }),
    ]);
    assert.equal(typeof line.timestamp, 'number');
    assert.equal(line.timestamp, Date.parse('2026-07-01T00:00:01Z'));
  });

  test('a human body carries a numeric epoch', () => {
    const [line] = linesOf([
      userMessage({ uuid: 'u1', text: 'question', timestamp: '2026-07-01T00:00:02Z' }),
    ]);
    assert.equal(typeof line.timestamp, 'number');
    assert.equal(line.timestamp, Date.parse('2026-07-01T00:00:02Z'));
  });

  test('a fold whose body arrives on a later row takes that row’s epoch', () => {
    const [line] = linesOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:03Z',
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: '2026-07-01T00:00:04Z',
        blocks: [{ type: 'text', text: 'now visible' }] }),
    ]));
    assert.equal(line.timestamp, Date.parse('2026-07-01T00:00:04Z'));
  });

  test('an already-numeric timestamp passes through unchanged', () => {
    const [line] = linesOf([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: 1785600000000,
        blocks: [{ type: 'text', text: 'numeric' }] }),
    ]);
    assert.equal(line.timestamp, 1785600000000);
  });

  test('a promoting row with no readable time keeps the time its group already had', () => {
    // The fold's body arrives on a row whose timestamp will not parse. The group already holds a readable
    // time from the row that created it, and that is the time the fold answers with — a fold reached
    // through a readable row does not lose its time to a later unreadable one.
    const [line] = linesOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:08Z',
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] }),
      assistantObservation({ uuid: 'a2', messageId: 'm1', timestamp: 'not-a-timestamp',
        blocks: [{ type: 'text', text: 'now visible' }] }),
    ]));
    assert.equal(line.timestamp, Date.parse('2026-07-01T00:00:08Z'));
    // Position and identity still move to the row that bears the body; only the time falls back.
    assert.equal(line.sourceOrdinal, 2);
    assert.equal(line.sourceEntryId, 'a2');
  });

  test('an unparseable timestamp becomes null rather than NaN', () => {
    const [line] = linesOf([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: 'not-a-timestamp',
        blocks: [{ type: 'text', text: 'bad ts' }] }),
    ]);
    assert.equal(line.timestamp, null);
    assert.ok(!Number.isNaN(line.timestamp), 'must never be NaN');
  });

  test('a tool line and its result carry their own rows’ epochs, not the fold’s', () => {
    const lines = linesOf(chain([
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:05Z',
        blocks: [{ type: 'text', text: 'looking' }] }),
      assistantToolUse({ uuid: 'a2', messageId: 'm1', toolUseId: 't1', name: 'Bash',
        input: { command: 'ls' }, timestamp: '2026-07-01T00:00:06Z' }),
      toolResult({ uuid: 'r1', toolUseId: 't1', content: 'out', timestamp: '2026-07-01T00:00:07Z' }),
    ]));
    const tool = lines.find(l => l.kind === 'tool');
    assert.equal(tool.timestamp, Date.parse('2026-07-01T00:00:06Z'));
    assert.equal(tool.tool.resultTimestamp, Date.parse('2026-07-01T00:00:07Z'));
  });

  test('normalized timestamps sort correctly with numeric subtraction', () => {
    const lines = linesOf(chain([
      userMessage({ uuid: 'u1', text: 'first', timestamp: '2026-07-01T00:00:01Z' }),
      assistantObservation({ uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:02Z',
        blocks: [{ type: 'text', text: 'second' }] }),
      userMessage({ uuid: 'u2', text: 'third', timestamp: '2026-07-01T00:00:03Z' }),
    ]));
    const shuffled = [lines[2], lines[0], lines[1]];
    const sorted = shuffled.slice().sort((a, b) => a.timestamp - b.timestamp);
    assert.deepEqual(sorted.map(l => l.message.text), ['first', 'second', 'third']);
  });
});
