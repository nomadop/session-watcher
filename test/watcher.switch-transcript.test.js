import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionWatcher } from '../lib/watcher.js';

function tmpJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-switch-'));
  const p = join(dir, 'test.jsonl');
  writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function usageLine(cacheRead, output = 10, opts = {}) {
  return {
    type: 'assistant', message: {
      id: opts.id || `msg-${Math.random().toString(36).slice(2)}`,
      model: opts.model || 'claude-sonnet-4-20250514',
      usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
      content: [],
    },
  };
}

test('switchTranscript resets file state and reads from new path', () => {
  const path1 = tmpJsonl([usageLine(1000, 10, { model: 'claude-sonnet-4-20250514' })]);
  const path2 = tmpJsonl([usageLine(2000, 20, { model: 'claude-sonnet-4-20250514' })]);
  const w = new SessionWatcher(path1, null, { sessionId: 'test-s1' });
  w.poll();
  assert.equal(w._calls.length, 1);
  assert.equal(w.path, path1);

  w.switchTranscript(path2);
  assert.equal(w.path, path2);
  // poll() ran internally — _partial should be empty (full lines consumed)
  assert.equal(w._partial, '');

  // switchTranscript calls poll internally — new file should be read
  const lastCall = w._calls[w._calls.length - 1];
  assert.equal(lastCall.cacheRead, 2000, 'last call should be from new transcript');
});

test('switchTranscript handles ENOENT gracefully (transcript not yet created)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-switch-noent-'));
  const path1 = tmpJsonl([usageLine(1000, 10, { model: 'claude-sonnet-4-20250514' })]);
  const w = new SessionWatcher(path1, null, { sessionId: 'test-s2' });
  w.poll();

  // Switch to nonexistent path — should not throw
  const missing = join(dir, 'nonexistent.jsonl');
  w.switchTranscript(missing);
  assert.equal(w.path, missing);
  assert.equal(w._offset, 0);
});

test('switchTranscript preserves _calls from prior segments (history continuity)', () => {
  const path1 = tmpJsonl([usageLine(1000, 10, { model: 'claude-sonnet-4-20250514' })]);
  const path2 = tmpJsonl([usageLine(2000, 20, { model: 'claude-sonnet-4-20250514' })]);
  const w = new SessionWatcher(path1, null, { sessionId: 'test-s3' });
  w.poll();
  const callsBefore = w._calls.length;
  assert.equal(callsBefore, 1);

  w.switchTranscript(path2);
  // _calls NOT cleared — old segment's calls remain for getHistory, plus new call
  assert.equal(w._calls.length, 2);
  assert.equal(w._calls[0].cacheRead, 1000);
  assert.equal(w._calls[1].cacheRead, 2000);
});
