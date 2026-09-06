// test/fold.active-leaf.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore, closeStore } from '../lib/store.js';
import { SessionWatcher } from '../lib/watcher.js';
import { boundaryPrecheck } from '../lib/fold.js';
import { PRECHECK_LONG_LINE_BYTES, PRECHECK_HEAD_CAP_BYTES } from '../lib/constants.js';

function line(obj) { return JSON.stringify(obj) + '\n'; }

// An assistant row whose payload pushes `usage` and `uuid` past the precheck head cap. Key order is
// load-bearing: JSON.stringify emits it verbatim, so both fields must be declared after `content`.
function paddedAsst(id, uuid, parentUuid, cacheRead, output, padBytes) {
  return { type: 'assistant', parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'x'.repeat(padBytes) }],
      usage: { input_tokens: 100, output_tokens: output,
        cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } },
    uuid };
}

// Helper: build a JSONL assistant+usage row with parentUuid
function asst(id, uuid, parentUuid, cacheRead, output, cacheCreation = 0) {
  return { type: 'assistant', uuid, parentUuid, isSidechain: false,
    timestamp: '2026-07-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-8', usage: {
      input_tokens: 100, output_tokens: output,
      cache_creation_input_tokens: cacheCreation, cache_read_input_tokens: cacheRead } } };
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

test('M9: the newest write wins even when an earlier sibling branch is deeper', () => {
  const content =
    line(user('root', 'u-root', null)) +
    line(user('older branch', 'u-old', 'u-root')) +
    line(asst('msg_old_1', 'a-old-1', 'u-old', 42000, 100)) +
    line(user('older branch continues', 'u-old-2', 'a-old-1')) +
    line(asst('msg_old_2', 'a-old-2', 'u-old-2', 43000, 100)) +
    line(user('newer shallow branch', 'u-new', 'u-root')) +
    line(asst('msg_new', 'a-new', 'u-new', 44000, 100));

  const w = new SessionWatcher(tmpJsonl(content), 42000);
  w.poll();

  assert.deepEqual(w._calls.map(c => c.messageId), ['msg_new']);
});

test('M9: a later UUID-bearing sidechain branch does not steer the active leaf', () => {
  const p = tmpJsonl(
    line(user('root', 'u-root', null)) +
    line(asst('msg_main', 'a-main', 'u-root', 42000, 100))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();

  appendFileSync(p, line({
    ...asst('msg_side', 'a-side', 'u-root', 43000, 100),
    isSidechain: true,
  }));
  const result = w.poll();

  assert.deepEqual(result, { newCalls: 0, changed: false });
  assert.deepEqual(w._calls.map(c => c.messageId), ['msg_main']);
  assert.equal(w._activeLeafUuid, 'a-main');
  assert.equal(w._topology.latestUuid, 'a-main');
  assert.equal(w._topology.uuidToParent.has('a-side'), false);
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

test('M9: rewind replay reaches the stock-drop fallback, and a drop past the floor opens a segment', () => {
  // The rewind path reaches the same fallback the incremental path does: `replayActivePath` rebuilds
  // topology, resolves the active leaf, then folds the surviving rows in order, threading
  // `_prevTotalStock` across them. The root row carries 60000 of cache_creation that the rewound branch
  // does not, so the replayed stock falls 160100 → 100100 — a 60000 drop past a floor of 40025 — and
  // the boundary lands mid-replay. The messageIds pin the path the replay folded against:
  // `msg_old` sits on the branch the rewind abandoned, so a replay that folded the whole file rather
  // than the resolved active path would carry it.
  const initial =
    line(user('root', 'u-root', null)) +
    line(asst('msg_root', 'a-root', 'u-root', 100000, 10, 60000)) +
    line(user('old branch', 'u-old', 'a-root')) +
    line(asst('msg_old', 'a-old', 'u-old', 110000, 10));

  const p = tmpJsonl(initial);
  const w = new SessionWatcher(p, 42000);
  w.poll();

  appendFileSync(p,
    line(user('rewind branch', 'u-new', 'a-root')) +
    line(asst('msg_new', 'a-new', 'u-new', 100000, 10))
  );
  const result = w.poll();

  assert.deepEqual(w._calls.map(c => c.messageId), ['msg_root', 'msg_new']);
  assert.equal(w._segment, 1, 'a stock drop past the relative floor opens an epoch during a rewind replay');
  assert.deepEqual(result, { newCalls: 2, changed: true });
});

test('M9: a boundary raised inside the rewind replay archives with replay provenance', () => {
  // `replayActivePath` re-folds a transcript that is already on disk, so a boundary it crosses
  // reconstructs an epoch that already ended and must carry the pair `lib/carry-sweep.js` produces:
  // archiveSource 'replay' + capture_source 'cc-replay'. The boundary here comes from `foldCall`'s
  // stock-drop fallback, which hardcodes `replayMode: false`, so only the watcher-level `_replayMode`
  // can supply the flavour.
  //
  // `msg_old` GROWS the stock (161100) on purpose: it keeps the first, genuinely live poll from crossing
  // a boundary of its own. Were segment 0 archived live first, `archiveSegmentProfile` would report
  // already_archived and the row would keep its original provenance, and the assertion could not tell
  // the two sources apart.
  const initial =
    line(user('root', 'u-root', null)) +
    line(asst('msg_root', 'a-root', 'u-root', 100000, 10, 60000)) +   // stock 160100
    line(user('old branch', 'u-old', 'a-root')) +
    line(asst('msg_old', 'a-old', 'u-old', 160000, 10, 1000));        // stock 161100 — grows, no boundary

  const dir = mkdtempSync(join(tmpdir(), 'sw-leaf-prov-'));
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, initial);
  const store = openStore(join(dir, 'store.sqlite'));
  const sessionId = `leaf-${randomUUID()}`;
  // `_sessionId` arms archival; the injected store is the connection it archives to.
  const w = new SessionWatcher(p, 42000, { sessionId });
  w.setStore(store);
  try {
    w.poll();
    assert.equal(w._segment, 0, 'the live poll crosses no boundary — the growing stock is the guard');
    assert.deepEqual(store.getProfileSegments(sessionId), [], 'nothing archived yet');

    appendFileSync(p,
      line(user('rewind branch', 'u-new', 'a-root')) +
      line(asst('msg_new', 'a-new', 'u-new', 100000, 10))             // stock 100100 — 60000 drop, floor 40025
    );
    w.poll();

    assert.equal(w._segment, 1, 'the replay crossed the boundary');
    const archived = store.getProfileSegments(sessionId);
    assert.deepEqual(archived.map(s => s.segment), [0], 'the replay archived the dying segment exactly once');
    const captureSource = store._db
      .prepare('SELECT capture_source FROM profile WHERE session_id = ? AND segment = ?')
      .get(sessionId, 0)?.capture_source ?? null;
    assert.deepEqual({ archiveSource: archived[0].archiveSource, captureSource },
      { archiveSource: 'replay', captureSource: 'cc-replay' },
      'a boundary inside a replay is reconstructed history, not a live capture');
  } finally {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
  }
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

test('M9: a >1MB row whose uuid sits past the head cap is folded, and keeps its ancestors on the path', () => {
  // The head cap makes poll skip this row whole, so indexRow never registers its uuid and every later
  // entry parented to it is unreachable — which truncates the resolved path to the unreachable tail and
  // drops the conversation that came before it.
  // Padding is derived from the threshold so raising the constant keeps the row over it.
  const bigRaw = JSON.stringify(paddedAsst('msg_big', 'a-big', 'a1', 43000, 150, PRECHECK_LONG_LINE_BYTES + 60_000));

  // Non-vacuity: without these the test could pass on a row the cap never hid.
  assert.ok(bigRaw.length > PRECHECK_LONG_LINE_BYTES, 'row must exceed the long-line threshold');
  assert.ok(bigRaw.indexOf('"uuid"') > PRECHECK_HEAD_CAP_BYTES, 'uuid must sit past the head cap');
  assert.ok(bigRaw.indexOf('"usage"') > PRECHECK_HEAD_CAP_BYTES, 'usage must sit past the head cap');
  assert.equal(boundaryPrecheck(bigRaw), false, 'boundaryPrecheck must not rescue this row');

  const content =
    line(user('q', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100)) +
    bigRaw + '\n' +
    line(asst('msg_2', 'a2', 'a-big', 44000, 200));

  const w = new SessionWatcher(tmpJsonl(content), 42000);
  w.poll();

  assert.deepEqual(w._calls.map(c => c.messageId), ['msg_1', 'msg_big', 'msg_2']);
});

test('M9: a replay after an orphan island is appended keeps the conversation, not the island', () => {
  // One null-parent root, so replay takes the single-branch path. An entry whose parentUuid names a
  // uuid that was never written (a dropped or malformed line) is NOT a root, so it adds no branch —
  // but it can be the newest write, and its ancestor chain contains no part of the conversation.
  const p = tmpJsonl(
    line(user('q', 'u1', null)) +
    line(asst('msg_1', 'a1', 'u1', 42000, 100))
  );
  const w = new SessionWatcher(p, 42000);
  w.poll();
  assert.deepEqual(w._calls.map(c => c.messageId), ['msg_1']);

  appendFileSync(p,
    line(user('orphan', 'u2', 'ghost-never-written')) +
    line(asst('msg_2', 'a2', 'u2', 41000, 100))
  );
  w.poll();

  assert.deepEqual(w._calls.map(c => c.messageId), ['msg_1'],
    'the unreachable island must not replace the folded conversation');
});

test('M9: row with parentUuid referencing unknown uuid (orphan) does not crash', () => {
  const content =
    line(asst('msg_1', 'a1', 'nonexistent-parent', 42000, 100));

  const p = tmpJsonl(content);
  const w = new SessionWatcher(p, 42000);
  w.poll(); // should not throw
  assert.equal(w._calls.length, 1, 'orphan row still folds');
});
