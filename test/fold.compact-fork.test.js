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

  const archivedProfiles = [];
  const archivedTelemetry = [];
  const store = {
    archiveSegmentProfile(sessionId, segment, snapshot) {
      archivedProfiles.push({ sessionId, segment, source: snapshot.archiveSource });
      return { status: 'archived' };
    },
    getTelemetryStatus() { return null; },
    archiveSegmentTelemetry(sessionId, segment, _payload, source) {
      archivedTelemetry.push({ sessionId, segment, source });
    },
  };
  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 40000, { sessionId: 'compact-replay' });
  w.setStore(store);
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
  assert.deepEqual(archivedProfiles, [
    { sessionId: 'compact-replay', segment: 0, source: 'replay' },
    { sessionId: 'compact-replay', segment: 1, source: 'replay' },
  ]);
  assert.deepEqual(archivedTelemetry, [
    { sessionId: 'compact-replay', segment: 0, source: 'cc-replay' },
    { sessionId: 'compact-replay', segment: 1, source: 'cc-replay' },
  ]);
});

test('compact: each root follows the newest write in its subtree, not the deepest descendant', () => {
  // Load-bearing beyond its own subject: unlike the parallel-fork tests, this one separates "newest
  // write" from "deepest node" and from "last node reached by the subtree walk".
  const content =
    line(sys('sys1', null)) +
    line(user('older deep branch', 'u-deep-1', 'sys1')) +
    line(asst('msg_deep_1', 'a-deep-1', 'u-deep-1', 90000)) +
    line(user('older branch continues', 'u-deep-2', 'a-deep-1')) +
    line(asst('msg_deep_2', 'a-deep-2', 'u-deep-2', 95000)) +
    line(user('newer shallow branch', 'u-recent', 'sys1')) +
    line(asst('msg_recent', 'a-recent', 'u-recent', 92000)) +
    line(sys('sys2', null)) +
    line(user('post compact', 'u-new', 'sys2')) +
    line(asst('msg_new', 'a-new', 'u-new', 40000));

  const w = new SessionWatcher(tmpJsonl(content), 42000);
  w.poll();

  assert.deepEqual(w._calls.map(c => ({
    messageId: c.messageId,
    segment: c.segment,
    foldedSeq: c.foldedSeq,
    turnSeq: c.turnSeq,
    L: c.L,
    B: c.B_at_call,
  })), [
    { messageId: 'msg_recent', segment: 0, foldedSeq: 1, turnSeq: 1, L: 92000, B: 92000 },
    { messageId: 'msg_new', segment: 1, foldedSeq: 2, turnSeq: 2, L: 40000, B: 40000 },
  ]);
});

test('compact: a parallel-tool-call fork keeps the continuation, not the earlier result stub', () => {
  // Two tool_use blocks of one assistant message are written as two entries (a1 -> a2), and each
  // tool_result is parented to the entry carrying ITS OWN tool_use. So the fork at a1 has the
  // continuation (a2) as its first child and call #1's result (tr1) as its last-written child.
  // The two entries carry distinct message ids here so that the continuation is observable in
  // _calls; in a real transcript they share one id and fold into a single call.
  const content =
    line(sys('sys1', null)) +
    line(user('old', 'u-old', 'sys1')) +
    line(asst('msg_old', 'a-old', 'u-old', 80000)) +
    line(sys('sys2', null)) +
    line(user('post compact', 'u-new', 'sys2')) +
    line(asst('msg_1', 'a1', 'u-new', 40000)) +
    line(asst('msg_2', 'a2', 'a1', 41000)) +
    line(user('result of call 1', 'tr1', 'a1')) +
    line(user('result of call 2', 'tr2', 'a2')) +
    line(asst('msg_3', 'a3', 'tr2', 42000));

  const w = new SessionWatcher(tmpJsonl(content), 42000);
  w.poll();

  assert.equal(w._segment, 1);
  assert.deepEqual(w._calls.filter(c => c.segment === 0).map(c => c.messageId), ['msg_old']);
  assert.deepEqual(w._calls.filter(c => c.segment === 1).map(c => c.messageId),
    ['msg_1', 'msg_2', 'msg_3'], "the segment must not stop at call #1's result stub");
});

test('compact: replay clears the compact signal before the next linear append', () => {
  const initial =
    line(sys('sys1', null)) +
    line(user('old', 'u-old', 'sys1')) +
    line(asst('msg_old', 'a-old', 'u-old', 80000)) +
    line(sys('sys2', null)) +
    line(user('new', 'u-new', 'sys2')) +
    line(asst('msg_new', 'a-new', 'u-new', 40000));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  const replay = w.poll();
  assert.deepEqual(replay, { newCalls: 2, changed: true });
  assert.equal(w._segment, 1);

  appendFileSync(p,
    line(user('continue', 'u-next', 'a-new')) +
    line(asst('msg_next', 'a-next', 'u-next', 41000))
  );
  const append = w.poll();

  assert.deepEqual(append, { newCalls: 1, changed: true });
  assert.equal(w._segment, 1, 'the prior compact is not consumed a second time');
  assert.deepEqual(w._calls.filter(c => c.segment === 1).map(c => c.messageId), ['msg_new', 'msg_next']);
});

test('compact: a rewind after a compact keeps the pre-compact segments', () => {
  // The first replay consumes the compact signal, so the second replay cannot read segmentation off
  // that signal — the file still has two roots and both still deserve their own segment.
  const initial =
    line(sys('sys1', null)) +
    line(user('old', 'u-old', 'sys1')) +
    line(asst('msg_old', 'a-old', 'u-old', 80000)) +
    line(sys('sys2', null)) +
    line(user('new', 'u-new', 'sys2')) +
    line(asst('msg_new', 'a-new', 'u-new', 40000));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.equal(w._segment, 1);

  // Ordinary rewind: fork off u-new, abandoning a-new. No new null-parent root.
  appendFileSync(p,
    line(user('retry', 'u-retry', 'u-new')) +
    line(asst('msg_retry', 'a-retry', 'u-retry', 41000))
  );
  w.poll();

  assert.equal(w._segment, 1, 'the pre-compact segment must survive a later rewind');
  assert.deepEqual(w._calls.filter(c => c.segment === 0).map(c => c.messageId), ['msg_old'],
    'the pre-compact segment keeps its call');
  assert.deepEqual(w._calls.filter(c => c.segment === 1).map(c => c.messageId), ['msg_retry']);
});

test('compact: a rewind into a pre-compact root never files later calls behind the abandoned root', () => {
  // Degradation guard. Normally the newest write lives in the newest root, so the last segment
  // folded is the live one. A rewind into a pre-compact root breaks that, and folding onward into
  // the last segment would put the live epoch's new calls in the SAME segment as an abandoned
  // root's — one segment measuring two epochs. Splitting the live epoch across segments is a paging
  // artefact; mixing epochs inside one segment is a measurement error.
  const initial =
    line(sys('sys1', null)) +
    line(user('old', 'u-old', 'sys1')) +
    line(asst('msg_old', 'a-old', 'u-old', 80000)) +
    line(sys('sys2', null)) +
    line(user('new', 'u-new', 'sys2')) +
    line(asst('msg_new', 'a-new', 'u-new', 40000));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  appendFileSync(p,
    line(user('rev', 'u-rev', 'u-old')) +
    line(asst('msg_rev', 'a-rev', 'u-rev', 41000))
  );
  w.poll();

  appendFileSync(p,
    line(user('cont', 'u-cont', 'a-rev')) +
    line(asst('msg_cont', 'a-cont', 'u-cont', 41500))
  );
  w.poll();

  const segOf = id => w._calls.find(c => c.messageId === id)?.segment;
  assert.notEqual(segOf('msg_cont'), segOf('msg_new'),
    'a live-epoch call must not share a segment with the abandoned root');
  assert.deepEqual(w._calls.map(c => c.messageId).sort(), ['msg_cont', 'msg_new', 'msg_rev'],
    'and nothing is dropped to achieve that');
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

test('compact: UUID-bearing replay populates firstRootUuid before foldCall', () => {
  // The replay rebuilds topology from the whole file before it folds any row, so the watcher reaches
  // the active segment with the session origin already resolved in the topology it consults.
  const content =
    line(sys('sys1', null)) +
    line(user('start', 'u1', 'sys1')) +
    line(asst('msg_1', 'a1', 'u1', 200000)) +
    line(sys('sys2', null)) +
    line(user('post compact', 'u2', 'sys2')) +
    line(asst('msg_2', 'a2', 'u2', 59000));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 55000);
  w.poll();

  assert.equal(w._segment, 1);
  // firstRootUuid is populated (topology is rebuilt before folding)
  assert.equal(w._topology.firstRootUuid, 'sys1');
});

test('compact: a UUID-less session segments on the same stock-drop floor', () => {
  // A session with no uuid carries no topology, so the totalStock floor is the only detector that can
  // run — the same one rule a uuid-bearing session reaches.
  const content =
    line({ type: 'assistant', isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
      message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 200000 } } }) +
    line({ type: 'assistant', isSidechain: false, timestamp: '2026-07-01T00:00:01Z',
      message: { id: 'msg_2', model: 'claude-opus-4-8', usage: { input_tokens: 3, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 45000 } } });

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  assert.equal(w._segment, 1, 'a UUID-less stock drop past the floor opens a segment');
  assert.equal(w._topology.firstRootUuid, null, 'no topology available in UUID-less session');
});
