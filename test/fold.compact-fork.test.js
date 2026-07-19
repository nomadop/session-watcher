// test/fold.compact-fork.test.js — Compact detection via topology (null-parent root on active path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWatcher } from '../lib/watcher.js';

function line(obj) { return JSON.stringify(obj) + '\n'; }

function asst(id, uuid, parentUuid, cacheRead, output = 100) {
  return { type: 'assistant', uuid, parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-8', usage: {
      input_tokens: 3, output_tokens: output,
      cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } } };
}

function sys(uuid, parentUuid) {
  const row = { type: 'system', uuid, isSidechain: false, timestamp: '2026-07-01T00:00:00Z' };
  if (parentUuid) row.parentUuid = parentUuid;
  return row;
}

function user(text, uuid, parentUuid) {
  return { type: 'user', uuid, parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { role: 'user', content: text } };
}

function attachment(uuid, parentUuid) {
  return { type: 'attachment', uuid, parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { role: 'user', content: '(compact summary)' } };
}

function tmpJsonl(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sw-compact-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);
  return p;
}

test('compact: system(par=NULL) on active path → segment bumps', () => {
  // Real compact structure: old subtree (system par=NULL) then new subtree (system par=NULL).
  // Active path goes through new subtree only.
  // Old subtree: sys1(par=NULL) → u1 → a1(200K) → u2 → a2(234K)
  // New subtree: sys2(par=NULL) → u3("session continued") → compact_row → att → sys3(par=att) → u4 → a3(59K)
  const content =
    // Old subtree (off-path after compact)
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 200000)) +
    line(user('work', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 234000)) +
    // New subtree (post-compact, on active path)
    line(sys('sys2', null)) +
    line(user('session continued', 'u3', 'sys2')) +
    line(user('/compact', 'u-compact', 'u3')) +
    line(user('compacted output', 'u-out', 'u-compact')) +
    line(attachment('att1', 'u-out')) +
    line(attachment('att2', 'att1')) +
    line(sys('sys3', 'att2')) +
    line(user('next prompt', 'u4', 'sys3')) +
    line(asst('msg_3', 'a3', 'u4', 59000)) +
    line(user('continue', 'u5', 'a3')) +
    line(asst('msg_4', 'a4', 'u5', 59500));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 55000);
  w.poll();

  // sys2(par=NULL) is on active path and is NOT the first root (sys1 is) → compact detected
  assert.equal(w._segment, 1, 'segment must bump on compact (topology detection)');
  // Two-pass replay: old subtree (seg 0) + new subtree (seg 1) for history paging
  const seg0 = w._calls.filter(c => c.segment === 0);
  const seg1 = w._calls.filter(c => c.segment === 1);
  assert.equal(seg0.length, 2, 'old subtree calls preserved in segment 0');
  assert.equal(seg1.length, 2, 'post-compact calls in segment 1');
  assert.equal(seg0[0].messageId, 'msg_1');
  assert.equal(seg1[0].messageId, 'msg_3');
});

test('compact: rewind (fork, no new root) → segment stays 0', () => {
  // Rewind: user goes back and creates a fork from an existing node.
  // NO system(par=NULL) created — all nodes chain back to the single root.
  const content =
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 52000)) +
    // Abandoned branch (off-path)
    line(user('first try', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 55000)) +
    // Active branch (rewind from a1, same parent)
    line(user('retry', 'u3', 'a1')) +
    line(asst('msg_3', 'a3', 'u3', 54000)) +
    line(user('continue', 'u4', 'a3')) +
    line(asst('msg_4', 'a4', 'u4', 57000));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 50000);
  w.poll();

  // No new null-parent root → not a compact, just a fork/rewind
  assert.equal(w._segment, 0, 'segment must NOT bump on plain rewind');
  assert.equal(w._calls.length, 3, 'on-path calls: msg_1, msg_3, msg_4');
});

test('compact: no tree (legacy JSONL without uuid) → topology path skipped', () => {
  // No uuid/parentUuid → no tree → no active-path filtering → normal fold.
  // Stock drop detected by existing foldCall mechanism.
  const content =
    line({ type: 'assistant', isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000 } } }) +
    line({ type: 'assistant', isSidechain: false, timestamp: '2026-07-01T00:00:01Z',
      message: { id: 'msg_2', model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 45000 } } });

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  // No tree → stock drop detected by existing foldCall mechanism (200003 → 45003, drop > EPSILON)
  assert.equal(w._segment, 1, 'stock drop detected by existing foldCall segment detection');
  assert.equal(w._calls.length, 2, 'both calls folded (existing detection handles mid-fold drop)');
});

test('compact: multiple compacts (3 subtrees) → all segments preserved', () => {
  // Two compacts in history: each creates a new system(par=NULL) subtree.
  // All three subtrees get their own segment for history paging.
  const content =
    // First subtree (original session)
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 200000)) +
    // Second subtree (first compact)
    line(sys('sys2', null)) +
    line(user('continued 1', 'u2', 'sys2')) +
    line(user('/compact', 'u-c1', 'u2')) +
    line(attachment('att-c1', 'u-c1')) +
    line(sys('sys2b', 'att-c1')) +
    line(user('work', 'u3', 'sys2b')) +
    line(asst('msg_2', 'a2', 'u3', 80000)) +
    // Third subtree (second compact, active)
    line(sys('sys3', null)) +
    line(user('continued 2', 'u4', 'sys3')) +
    line(user('/compact', 'u-c2', 'u4')) +
    line(attachment('att-c2', 'u-c2')) +
    line(sys('sys3b', 'att-c2')) +
    line(user('final', 'u5', 'sys3b')) +
    line(asst('msg_3', 'a3', 'u5', 40000)) +
    line(user('continue', 'u6', 'a3')) +
    line(asst('msg_4', 'a4', 'u6', 45000));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 40000);
  w.poll();

  // 3 subtrees → segment 0, 1, 2
  assert.equal(w._segment, 2, 'three subtrees produce segment 2');
  const seg0 = w._calls.filter(c => c.segment === 0);
  const seg1 = w._calls.filter(c => c.segment === 1);
  const seg2 = w._calls.filter(c => c.segment === 2);
  assert.equal(seg0.length, 1, 'subtree 1: 1 call in segment 0');
  assert.equal(seg0[0].messageId, 'msg_1');
  assert.equal(seg1.length, 1, 'subtree 2: 1 call in segment 1');
  assert.equal(seg1[0].messageId, 'msg_2');
  assert.equal(seg2.length, 2, 'subtree 3: 2 calls in segment 2');
  assert.equal(seg2[0].messageId, 'msg_3');
});

test('compact: single session (no system break) with /compact → no segment bump', () => {
  // "Inline compact": /compact was called but no system(par=NULL) break occurred.
  // This happens when compact doesn't actually reduce context (stock stays flat).
  // No topology signal → no bump (correct: no segment reset needed).
  const content =
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 85000)) +
    line(user('/compact', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 89000)) +
    line(user('continue', 'u3', 'a2')) +
    line(asst('msg_3', 'a3', 'u3', 92000));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 80000);
  w.poll();

  // No new null-parent root → no compact boundary detected
  // Stock is increasing normally → no foldCall stock-drop either
  assert.equal(w._segment, 0, 'inline compact without system break → no segment bump');
  assert.equal(w._calls.length, 3, 'all calls folded normally');
});

test('compact: only first root on active path → no false positive', () => {
  // Simple session with one root, no compact. Should never trigger.
  const content =
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 42000)) +
    line(user('q1', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 45000)) +
    line(user('q2', 'u3', 'a2')) +
    line(asst('msg_3', 'a3', 'u3', 48000));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  assert.equal(w._segment, 0, 'normal session → no compact detection');
  assert.equal(w._calls.length, 3);
});

test('compact: incremental poll preserves old-segment history (no call loss)', () => {
  // Simulate a running watcher that already folded calls, then compact arrives.
  // Old-segment calls must be preserved for history chart paging.
  const preCompact =
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 100000)) +
    line(user('q1', 'u2', 'a1')) +
    line(asst('msg_2', 'a2', 'u2', 120000)) +
    line(user('q2', 'u3', 'a2')) +
    line(asst('msg_3', 'a3', 'u3', 140000));

  const p = tmpJsonl(preCompact);
  const w = new SessionWatcher(p, 100000);
  w.poll();

  // Verify pre-compact state
  assert.equal(w._segment, 0);
  assert.equal(w._calls.length, 3, 'pre-compact: 3 calls in segment 0');

  // Now compact arrives: new subtree appended
  const postCompact =
    line(sys('sys2', null)) +
    line(user('session continued', 'u4', 'sys2')) +
    line(user('/compact', 'u-c', 'u4')) +
    line(attachment('att1', 'u-c')) +
    line(sys('sys2b', 'att1')) +
    line(user('next', 'u5', 'sys2b')) +
    line(asst('msg_4', 'a4', 'u5', 30000)) +
    line(user('continue', 'u6', 'a4')) +
    line(asst('msg_5', 'a5', 'u6', 35000));

  appendFileSync(p, postCompact);
  w.poll();

  // After compact: segment bumps, old calls preserved for history
  assert.equal(w._segment, 1, 'segment bumps after compact');
  const seg0 = w._calls.filter(c => c.segment === 0);
  const seg1 = w._calls.filter(c => c.segment === 1);
  assert.equal(seg0.length, 3, 'old-segment calls preserved for history');
  assert.equal(seg1.length, 2, 'new-segment calls folded');
  assert.equal(seg0[0].messageId, 'msg_1');
  assert.equal(seg1[0].messageId, 'msg_4');
});
