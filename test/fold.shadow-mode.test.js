// test/fold.shadow-mode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function line(obj) { return JSON.stringify(obj) + '\n'; }
function asst(id, uuid, parentUuid, cacheRead, output) {
  return { type: 'assistant', uuid, parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-8', usage: {
      input_tokens: 100, output_tokens: output,
      cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } } };
}
function user(text, uuid, parentUuid) {
  return { type: 'user', uuid, parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { role: 'user', content: text } };
}

test('shadow: linear transcript produces identical _calls with and without active-leaf filter', () => {
  const content =
    line(user('hi', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    line(user('more', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 44000, 200));

  const dir = mkdtempSync(join(tmpdir(), 'sw-shadow-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);

  const w = new SessionWatcher(p, 42000);
  w.poll();

  // On a linear transcript, active-leaf-only should produce the same
  // result as the old unfiltered path
  assert.equal(w._calls.length, 2);
  assert.equal(w._calls[0].messageId, 'msg_1');
  assert.equal(w._calls[1].messageId, 'msg_2');
});

test('shadow: fork transcript correctly diverges from unfiltered baseline', () => {
  // With fork: old logic would include msg_3 (abandoned), new logic excludes it
  const content =
    line(user('start', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    line(user('branch-A', 'u2', 'a1')) +
    line(user('branch-B', 'u3', 'a1')) +      // fork
    line(asst('msg_3', 'a3', 'u3', 43000, 150)) + // abandoned
    line(asst('msg_2', 'a2', 'u2', 44000, 200));  // active

  const dir = mkdtempSync(join(tmpdir(), 'sw-shadow-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);

  const w = new SessionWatcher(p, 42000);
  w.poll();

  // New active-leaf logic should exclude msg_3
  assert.equal(w._calls.length, 2);
  const ids = w._calls.map(c => c.messageId);
  assert.ok(!ids.includes('msg_3'), 'abandoned branch call excluded');
  assert.ok(ids.includes('msg_1'), 'root call retained');
  assert.ok(ids.includes('msg_2'), 'active branch call retained');
});
