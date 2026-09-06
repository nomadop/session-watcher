// test/dialogue-fold.timestamp.test.js — anchorTimestamp must be a numeric epoch, never an ISO string.
// Transcripts carry ISO-8601 timestamps; source_timestamp is an INTEGER column and bookmark-service
// sorts numerically (a - b). Normalizing at the Dialogue Projection boundary keeps one conversion point.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCanonicalTranscript, visibleMessages } from '../lib/dialogue-fold.js';
import {
  userMessage, assistantObservation, writeTranscript, ts,
} from './helpers/transcript-fixtures.js';

describe('anchorTimestamp normalization', () => {
  let dir;
  test.before(() => { dir = mkdtempSync(join(tmpdir(), 'sw-ts-')); });

  test('assistant anchorTimestamp is a numeric epoch, not the raw ISO string', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:01Z',
        blocks: [{ type: 'text', text: 'answer' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const msg = visibleMessages(c).find(m => m.role === 'assistant');
    assert.equal(typeof msg.anchorTimestamp, 'number');
    assert.equal(msg.anchorTimestamp, Date.parse('2026-07-01T00:00:01Z'));
  });

  test('user anchorTimestamp is a numeric epoch', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'question', timestamp: '2026-07-01T00:00:02Z' }),
    ]);
    const c = readCanonicalTranscript(path);
    const msg = visibleMessages(c).find(m => m.role === 'user');
    assert.equal(typeof msg.anchorTimestamp, 'number');
    assert.equal(msg.anchorTimestamp, Date.parse('2026-07-01T00:00:02Z'));
  });

  test('anchor promoted by a later text-bearing revision also carries a numeric epoch', () => {
    // First observation is tool-only, so the anchor is set on the revision path (:107).
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:03Z',
        blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
      }),
      assistantObservation({
        uuid: 'a2', parentUuid: 'a1', messageId: 'm1', timestamp: '2026-07-01T00:00:04Z',
        blocks: [{ type: 'text', text: 'now visible' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const msg = visibleMessages(c).find(m => m.role === 'assistant');
    assert.equal(typeof msg.anchorTimestamp, 'number');
    assert.equal(msg.anchorTimestamp, Date.parse('2026-07-01T00:00:04Z'));
  });

  test('already-numeric timestamps pass through unchanged', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: 1785600000000,
        blocks: [{ type: 'text', text: 'numeric' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const msg = visibleMessages(c).find(m => m.role === 'assistant');
    assert.equal(msg.anchorTimestamp, 1785600000000);
  });

  test('unparseable timestamp becomes null rather than NaN', () => {
    const path = writeTranscript(dir, [
      assistantObservation({
        uuid: 'a1', messageId: 'm1', timestamp: 'not-a-timestamp',
        blocks: [{ type: 'text', text: 'bad ts' }],
      }),
    ]);
    const c = readCanonicalTranscript(path);
    const msg = visibleMessages(c).find(m => m.role === 'assistant');
    assert.equal(msg.anchorTimestamp, null);
    assert.ok(!Number.isNaN(msg.anchorTimestamp), 'must never be NaN');
  });

  test('normalized timestamps sort correctly with numeric subtraction', () => {
    const path = writeTranscript(dir, [
      userMessage({ uuid: 'u1', text: 'first', timestamp: '2026-07-01T00:00:01Z' }),
      assistantObservation({
        uuid: 'a1', parentUuid: 'u1', messageId: 'm1', timestamp: '2026-07-01T00:00:02Z',
        blocks: [{ type: 'text', text: 'second' }],
      }),
      userMessage({ uuid: 'u2', parentUuid: 'a1', text: 'third', timestamp: '2026-07-01T00:00:03Z' }),
    ]);
    const c = readCanonicalTranscript(path);
    const shuffled = [visibleMessages(c)[2], visibleMessages(c)[0], visibleMessages(c)[1]];
    const sorted = shuffled.slice().sort((a, b) => a.anchorTimestamp - b.anchorTimestamp);
    assert.deepEqual(sorted.map(m => m.text), ['first', 'second', 'third']);
  });
});
