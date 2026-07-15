// test/fold.utf8.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

test('H3: multi-byte UTF-8 split across read boundaries does not produce U+FFFD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-utf8-'));
  const p = join(dir, 'session.jsonl');
  // Build a JSONL line with a 3-byte UTF-8 char (e.g. '€' = 0xE2 0x82 0xAC)
  const content = '你好世界'; // 4 × 3-byte chars
  const row = { type: 'assistant', uuid: 'u1', isSidechain: false,
    message: { id: 'msg_1', model: 'claude-opus-4-8',
      content: [{ type: 'text', text: content }],
      usage: { input_tokens: 100, output_tokens: 50,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 42000 } } };
  const fullLine = JSON.stringify(row) + '\n';
  const buf = Buffer.from(fullLine, 'utf8');

  // Write first chunk that splits a multi-byte char (cut at byte that's mid-codepoint)
  // Find the position of '你' (E4 BD A0) in the buffer and split inside it
  const targetStr = '你好';
  const targetBuf = Buffer.from(targetStr, 'utf8'); // 6 bytes
  const idx = buf.indexOf(targetBuf);
  assert(idx > 0, 'target string found in buffer');
  const splitPoint = idx + 2; // mid-codepoint of '你' (only 2 of 3 bytes)

  writeFileSync(p, buf.slice(0, splitPoint));
  const w = new SessionWatcher(p, 42000);
  w.poll(); // reads partial multi-byte — should NOT produce U+FFFD

  // Now append the rest
  appendFileSync(p, buf.slice(splitPoint));
  w.poll();

  // The call should have been parsed correctly — AND no replacement characters leaked
  assert.equal(w._calls.length, 1, 'one call folded after both reads');
  assert.equal(w._calls[0].cacheRead, 42000);
  // H3-specific: confirm no U+FFFD corruption in any buffered state
  assert.ok(!w._partial.includes('�'), 'no replacement char in partial buffer');
});

test('H3: partial line across reads still works (no regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sw-utf8-'));
  const p = join(dir, 'session.jsonl');
  const row = { type: 'assistant', uuid: 'u1', isSidechain: false,
    message: { id: 'msg_2', model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 20,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 50000 } } };
  const fullLine = JSON.stringify(row) + '\n';

  // Write half the line (ASCII-safe split)
  const half = Math.floor(fullLine.length / 2);
  writeFileSync(p, fullLine.slice(0, half));
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 0, 'no call yet — line incomplete');

  appendFileSync(p, fullLine.slice(half));
  w.poll();
  assert.equal(w._calls.length, 1, 'call folded after line completes');
});
