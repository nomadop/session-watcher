// test/fold.active-leaf.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function line(obj) { return JSON.stringify(obj) + '\n'; }

// Helper: build a JSONL assistant+usage row with parentUuid
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

function tmpJsonl(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-leaf-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);
  return p;
}

test('M9: normal linear append — all calls folded (fast path)', () => {
  // Linear chain: root → u1 → a1 → u2 → a2
  const content =
    line(user('hello', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    line(user('world', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 44000, 200));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 2, 'both calls on active path');
});

test('M9: fork — abandoned branch usage excluded from _calls', () => {
  // Tree:  root → u1 → a1 → u2 → a2 (active)
  //                         ↘ u3 → a3 (abandoned)
  // After fork, leaf is on the u2→a2 branch. a3 is on abandoned branch.
  const content =
    line(user('start', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    line(user('branch-A', 'u2', 'a1')) +      // active branch
    line(user('branch-B', 'u3', 'a1')) +      // abandoned branch (same parent as u2)
    line(asst('msg_3', 'a3', 'u3', 43000, 150)) + // abandoned
    line(asst('msg_2', 'a2', 'u2', 44000, 200));  // active (arrives after abandoned)

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  // Only msg_1 and msg_2 should be in _calls (active path: u1→a1→u2→a2)
  assert.equal(w._calls.length, 2, 'abandoned branch call excluded');
  assert.equal(w._calls[0].messageId, 'msg_1');
  assert.equal(w._calls[1].messageId, 'msg_2');
});

test('M9: rewind — leaf moves to earlier node, later records dropped', () => {
  // Initial: u1 → a1 → u2 → a2
  // After rewind, leaf becomes u2 (a2 is now on abandoned branch)
  // New append: u2 → a3 (replaces a2's branch)
  const initial =
    line(user('start', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    line(user('q1', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 44000, 200));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 2);

  // Rewind: new user message also parents off a1 (same as u2 = fork at a1)
  // Then a new assistant reply on that branch
  appendFileSync(p,
    line(user('q1-retry', 'u3', 'a1')) +
    line(asst('msg_3', 'a3', 'u3', 45000, 250))
  );
  w.poll();

  // Active path is now: u1→a1→u3→a3. msg_2 (on u2 branch) should be gone.
  assert.equal(w._calls.length, 2, 'rewind replays active path only');
  assert.equal(w._calls[0].messageId, 'msg_1');
  assert.equal(w._calls[1].messageId, 'msg_3');
});

test('H2: rotation (file truncated) — new segment, branch state reset', () => {
  // Initial content must be LONGER than rotated content so size < _offset triggers rotation detection
  const initial =
    line(user('start with a longer message to ensure initial file is bigger', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    line(user('extra padding line to make initial file bigger than rotated', 'u1b', 'a1'));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1);
  const segBefore = w._segment;

  // Simulate rotation: overwrite file with SHORTER content (triggers size < _offset)
  const rotated =
    line(user('hi', 'u2', null)) +
    line(asst('msg_2', 'a2', 'u2', 10000, 50));
  writeFileSync(p, rotated);
  w.poll();

  // Rotation preserves old-segment calls (for getHistory) but opens a new segment.
  // The new call is in the new segment; old call stays from the prior segment.
  assert.equal(w._segment, segBefore + 1, 'rotation opens a new segment');
  assert.equal(w._calls.length, 2, 'old + new segment calls preserved');
  const newSegCalls = w._calls.filter(c => c.segment === w._segment);
  assert.equal(newSegCalls.length, 1, 'one call in new segment');
  assert.equal(newSegCalls[0].messageId, 'msg_2');
  // Branch state is cleared — no stale tree from old session
});

test('M9: no fork, incremental append — fast path maintained', () => {
  const initial =
    line(user('start', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  // Append more on the same linear branch
  appendFileSync(p,
    line(user('more', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 44000, 200))
  );
  w.poll();

  assert.equal(w._calls.length, 2, 'both calls present on linear path');
});

// --- Malformed/adversarial JSONL tests ---

test('M9: malformed JSON line does not crash or corrupt branch index', () => {
  const content =
    line(user('start', 'u1', null)) +
    '{"type":"assistant","uuid":"broken_no_close\n' + // malformed
    line(asst('msg_1', 'a1', 'u1', 42000, 100));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll(); // should not throw
  assert.equal(w._calls.length, 1, 'valid call folded despite malformed line');
});

test('M9: row with missing parentUuid still folds (graceful degradation)', () => {
  // A row without parentUuid — branch index skips it, fold still works
  const rowNoParent = { type: 'assistant', uuid: 'a1', isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id: 'msg_1', model: 'claude-opus-4-8', usage: {
      input_tokens: 100, output_tokens: 50,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 42000 } } };
  const content = JSON.stringify(rowNoParent) + '\n';

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._calls.length, 1, 'call folded even without parentUuid');
});

test('M9: row with parentUuid referencing unknown uuid (orphan) does not crash', () => {
  const content =
    line(asst('msg_1', 'a1', 'nonexistent-parent', 42000, 100));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll(); // should not throw
  assert.equal(w._calls.length, 1, 'orphan row still folds');
});
