// test/canonical-fold.test.js — Tests for the shared canonical topology and byte reader.
// Dialogue Projection is covered by test/dialogue-fold.projection.test.js; this file must not
// reach into dialogue-fold.js, which is what keeps Measurement's shared layer free of it.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCompleteJsonlEventsFromBuffer,
  createTopologyState,
  resetTopologyState,
  indexTopologyEntry,
  detectActiveLeaf,
  resolveActivePath,
  isTopologyAncestor,
  selectCanonicalBranches,
  selectCanonicalBranchPaths,
  activeLeafForRoot,
} from '../lib/canonical-fold.js';

// --- Checkpoint A: Byte reader tests ---

describe('readCompleteJsonlEventsFromBuffer', () => {
  test('return shape is {events, nextOffset, caughtUp} with additive observations', () => {
    const line = JSON.stringify({ type: 'user', message: 'hi' }) + '\n';
    const buf = Buffer.from(line);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: true });
    assert.ok(Array.isArray(result.events));
    assert.ok(Array.isArray(result.observations));
    assert.equal(typeof result.nextOffset, 'number');
    assert.equal(typeof result.caughtUp, 'boolean');
  });

  test('baseOffset produces absolute offsets', () => {
    const line = JSON.stringify({ x: 1 }) + '\n';
    const buf = Buffer.from(line);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 500, maxBytes: buf.length, atEof: true });
    assert.equal(result.nextOffset, 500 + buf.length);
  });

  test('maxBytes is a hard scan bound and does not commit a partial line', () => {
    const line1 = JSON.stringify({ a: 1 }) + '\n';
    const line2 = JSON.stringify({ b: 2 }) + '\n';
    const buf = Buffer.from(line1 + line2);
    // Set maxBytes to only include first line + part of second
    const limit = Buffer.byteLength(line1) + 3;
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: limit, atEof: false });
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0], { a: 1 });
    assert.equal(result.nextOffset, Buffer.byteLength(line1));
  });

  test('CRLF is accepted', () => {
    const line = JSON.stringify({ crlf: true }) + '\r\n';
    const buf = Buffer.from(line);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: true });
    assert.equal(result.events.length, 1);
    assert.deepEqual(result.events[0], { crlf: true });
  });

  test('malformed complete lines advance offset but are omitted from events and observations', () => {
    const good = JSON.stringify({ ok: true }) + '\n';
    const bad = 'not valid json{{{' + '\n';
    const good2 = JSON.stringify({ also: 'ok' }) + '\n';
    const buf = Buffer.from(good + bad + good2);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: true });
    assert.equal(result.events.length, 2);
    assert.equal(result.observations.length, 2);
    assert.equal(result.nextOffset, buf.length);
  });

  test('atEof:false leaves a newline-less tail uncommitted', () => {
    const line = JSON.stringify({ complete: true }) + '\n';
    const tail = JSON.stringify({ incomplete: true });
    const buf = Buffer.from(line + tail);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: false });
    assert.equal(result.events.length, 1);
    assert.equal(result.nextOffset, Buffer.byteLength(line));
  });

  test('atEof:true seals a newline-less tail', () => {
    const line = JSON.stringify({ complete: true }) + '\n';
    const tail = JSON.stringify({ sealed: true });
    const buf = Buffer.from(line + tail);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: true });
    assert.equal(result.events.length, 2);
    assert.equal(result.nextOffset, buf.length);
  });

  test('UTF-8 content and SourceRef byte accuracy', () => {
    const entry = { text: '你好世界' };
    const line = JSON.stringify(entry) + '\n';
    const buf = Buffer.from(line);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 100, maxBytes: buf.length, atEof: true });
    assert.equal(result.observations.length, 1);
    const obs = result.observations[0];
    assert.equal(obs.sourceRef.byteStart, 100);
    assert.equal(obs.sourceRef.byteEnd, 100 + buf.length);
    assert.equal(obs.sourceRef.lineOrdinal, 1);
  });

  test('lineOrdinal numbers rows as grep -n does, malformed lines consuming a number', () => {
    const good1 = JSON.stringify({ a: 1 }) + '\n';
    const bad = 'broken\n';
    const good2 = JSON.stringify({ b: 2 }) + '\n';
    const buf = Buffer.from(good1 + bad + good2);
    const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: true });
    assert.equal(result.observations.length, 2);
    assert.equal(result.observations[0].sourceRef.lineOrdinal, 1);
    assert.equal(result.observations[1].sourceRef.lineOrdinal, 3);
  });
});

// --- Checkpoint A: Topology tests ---

describe('selectCanonicalBranches', () => {
  function makeObs(entry, lineOrdinal = 0, byteStart = 0, byteEnd = 10) {
    return {
      entry,
      raw: JSON.stringify(entry),
      sourceRef: {
        uuid: typeof entry.uuid === 'string' ? entry.uuid : null,
        lineOrdinal,
        byteStart,
        byteEnd,
      },
    };
  }

  test('compact roots are emitted in physical root order', () => {
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false }, 0),
      makeObs({ uuid: 'a1', parentUuid: 'r1', type: 'assistant', isSidechain: false }, 1),
      makeObs({ uuid: 'r2', parentUuid: null, type: 'user', isSidechain: false }, 2),
      makeObs({ uuid: 'a2', parentUuid: 'r2', type: 'assistant', isSidechain: false }, 3),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches.length, 2);
    assert.equal(branches[0][0].sourceRef.uuid, 'r1');
    assert.equal(branches[1][0].sourceRef.uuid, 'r2');
  });

  test('each root follows the newest write in its subtree, not the deepest descendant', () => {
    // root1 has two children: older-deep and newer-shallow. The newest write wins, so the deeper
    // branch loses. One of the few guards that separate "newest write" from "deepest node" and from
    // "last node the subtree walk happens to reach" — the parallel-fork tests do not.
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false }, 0),
      makeObs({ uuid: 'old-deep', parentUuid: 'r1', type: 'user', isSidechain: false }, 1),
      makeObs({ uuid: 'old-leaf', parentUuid: 'old-deep', type: 'assistant', isSidechain: false }, 2),
      makeObs({ uuid: 'newer', parentUuid: 'r1', type: 'user', isSidechain: false }, 3),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches.length, 1);
    // Should contain root + newer (the newest write), NOT the deeper older path
    const uuids = branches[0].map(o => o.sourceRef.uuid);
    assert.ok(uuids.includes('r1'));
    assert.ok(uuids.includes('newer'));
    assert.ok(!uuids.includes('old-deep'));
    assert.ok(!uuids.includes('old-leaf'));
  });

  test('a parallel-tool-call fork keeps the continuation, not the earlier result stub', () => {
    // Two tool_use blocks of one assistant message are written as two entries (a1 -> a2), and each
    // tool_result is parented to the entry carrying ITS OWN tool_use. So the fork at a1 has the
    // continuation (a2) as its first child and call #1's result (tr1) as its last-written child.
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false }, 0),
      makeObs({ uuid: 'a1', parentUuid: 'r1', type: 'assistant', isSidechain: false }, 1),
      makeObs({ uuid: 'a2', parentUuid: 'a1', type: 'assistant', isSidechain: false }, 2),
      makeObs({ uuid: 'tr1', parentUuid: 'a1', type: 'user', isSidechain: false }, 3),
      makeObs({ uuid: 'tr2', parentUuid: 'a2', type: 'user', isSidechain: false }, 4),
      makeObs({ uuid: 'a3', parentUuid: 'tr2', type: 'assistant', isSidechain: false }, 5),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches.length, 1);
    const uuids = branches[0].map(o => o.sourceRef.uuid);
    assert.ok(uuids.includes('a3'), 'the newest write must be on the selected path');
    assert.ok(uuids.includes('a2'), 'the continuation entry must be on the selected path');
    assert.ok(uuids.includes('tr2'));
    assert.ok(!uuids.includes('tr1'), "the earlier call's result stub is off the active path");
  });

  test('connected-tree branches use !uuid || path.has(uuid) filter', () => {
    // Observations without uuid are always included
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false }, 0),
      makeObs({ type: 'system', isSidechain: false }, 1), // no uuid
      makeObs({ uuid: 'a1', parentUuid: 'r1', type: 'assistant', isSidechain: false }, 2),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches.length, 1);
    assert.equal(branches[0].length, 3); // all included
  });

  test('sidechain rows do not affect topology', () => {
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false }, 0),
      makeObs({ uuid: 'sc', parentUuid: 'r1', type: 'assistant', isSidechain: true }, 1),
      makeObs({ uuid: 'a1', parentUuid: 'r1', type: 'assistant', isSidechain: false }, 2),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches.length, 1);
    // Active leaf is the newest write among NON-sidechain entries in the root's subtree
    const uuids = branches[0].map(o => o.sourceRef.uuid);
    assert.ok(uuids.includes('a1'));
  });

  test('no parent-child edge returns one unfiltered raw branch including sidechain', () => {
    // UUID-less legacy or disconnected roots
    const obs = [
      makeObs({ type: 'user', isSidechain: false }, 0),
      makeObs({ type: 'assistant', isSidechain: true }, 1),
      makeObs({ type: 'assistant', isSidechain: false }, 2),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches.length, 1);
    assert.equal(branches[0].length, 3); // everything included, including sidechain
  });

  test('returned branches preserve physical order and repeated message.id observations', () => {
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false, message: { id: 'm1' } }, 0),
      makeObs({ uuid: 'a1', parentUuid: 'r1', type: 'assistant', isSidechain: false, message: { id: 'm1' } }, 1),
      makeObs({ uuid: 'a2', parentUuid: 'a1', type: 'assistant', isSidechain: false, message: { id: 'm1' } }, 2),
    ];
    const branches = selectCanonicalBranches(obs);
    assert.equal(branches[0].length, 3);
    // Physical order preserved
    assert.equal(branches[0][0].sourceRef.lineOrdinal, 0);
    assert.equal(branches[0][1].sourceRef.lineOrdinal, 1);
    assert.equal(branches[0][2].sourceRef.lineOrdinal, 2);
  });

  test('always returns at least one branch for non-empty input', () => {
    const obs = [makeObs({ type: 'user', isSidechain: false }, 0)];
    const branches = selectCanonicalBranches(obs);
    assert.ok(branches.length >= 1);
  });

  test('selectCanonicalBranchPaths carries the path each branch was filtered by', () => {
    // fold.js folds each branch against THIS path instead of deriving its own, so the two cannot
    // be allowed to disagree — that divergence is what kept a fixed rule broken on one route.
    const obs = [
      makeObs({ uuid: 'r1', parentUuid: null, type: 'user', isSidechain: false }, 0),
      makeObs({ uuid: 'a1', parentUuid: 'r1', type: 'assistant', isSidechain: false }, 1),
      makeObs({ uuid: 'r2', parentUuid: null, type: 'user', isSidechain: false }, 2),
      makeObs({ uuid: 'b1', parentUuid: 'r2', type: 'assistant', isSidechain: false }, 3),
      makeObs({ uuid: 'b2', parentUuid: 'r2', type: 'assistant', isSidechain: false }, 4),
    ];
    const withPaths = selectCanonicalBranchPaths(obs);
    assert.equal(withPaths.length, 2);
    assert.deepEqual([withPaths[0].root, withPaths[1].root], ['r1', 'r2']);
    assert.equal(withPaths[1].leaf, 'b2');
    assert.deepEqual(selectCanonicalBranches(obs), withPaths.map(b => b.observations));
    for (const b of withPaths) {
      for (const o of b.observations) {
        if (o.sourceRef.uuid) {
          assert.ok(b.path.has(o.sourceRef.uuid), `${o.sourceRef.uuid} must be on its own branch path`);
        }
      }
    }
  });

  test('selectCanonicalBranchPaths reports a null path when there is no tree', () => {
    const obs = [
      makeObs({ type: 'user', isSidechain: false }, 0),
      makeObs({ type: 'assistant', isSidechain: true }, 1),
    ];
    const [only] = selectCanonicalBranchPaths(obs);
    assert.equal(only.path, null);
    assert.equal(only.root, null);
    assert.equal(only.observations.length, 2);
  });
});

// --- Checkpoint A: Topology state functions ---

describe('topology state functions', () => {
  test('createTopologyState returns correct shape', () => {
    const state = createTopologyState();
    assert.ok(state.uuidToParent instanceof Map);
    assert.ok(state.uuidChildren instanceof Map);
    assert.equal(state.latestUuid, null);
    assert.equal(state.activeLeafUuid, null);
    assert.equal(state.firstRootUuid, null);
    assert.equal(state.compactDetected, false);
  });

  test('resetTopologyState clears all fields', () => {
    const state = createTopologyState();
    state.uuidToParent.set('a', 'b');
    state.uuidChildren.set('b', new Set(['a']));
    state.latestUuid = 'a';
    state.activeLeafUuid = 'a';
    state.firstRootUuid = 'b';
    state.compactDetected = true;
    resetTopologyState(state);
    assert.equal(state.uuidToParent.size, 0);
    assert.equal(state.uuidChildren.size, 0);
    assert.equal(state.latestUuid, null);
    assert.equal(state.activeLeafUuid, null);
    assert.equal(state.firstRootUuid, null);
    assert.equal(state.compactDetected, false);
  });

  test('indexTopologyEntry builds parent/child maps', () => {
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'a1', parentUuid: 'r1', isSidechain: false });
    assert.equal(state.uuidToParent.get('r1'), null);
    assert.equal(state.uuidToParent.get('a1'), 'r1');
    assert.ok(state.uuidChildren.get('r1').has('a1'));
    assert.equal(state.firstRootUuid, 'r1');
    assert.equal(state.latestUuid, 'a1');
  });

  test('indexTopologyEntry ignores sidechain', () => {
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'sc', parentUuid: 'r1', isSidechain: true });
    assert.equal(state.uuidChildren.has('r1'), false);
    assert.equal(state.latestUuid, 'r1'); // not updated to 'sc'
  });

  test('indexTopologyEntry sets compactDetected on second null-parent root', () => {
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    assert.equal(state.compactDetected, false);
    indexTopologyEntry(state, { uuid: 'r2', parentUuid: null, isSidechain: false });
    assert.equal(state.compactDetected, true);
  });

  test('detectActiveLeaf is the newest write', () => {
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'old', parentUuid: 'r1', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'new', parentUuid: 'r1', isSidechain: false });
    const leaf = detectActiveLeaf(state);
    assert.equal(leaf, 'new');
  });

  test('detectActiveLeaf is the newest write even when that uuid already has children', () => {
    // A reused uuid is the one shape that gives the newest write children: `u` is written under
    // r1 with child `c`, then written again under `d`. Descending from `u` by last-added child
    // would land on `c` — an entry written three lines earlier.
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'u', parentUuid: 'r1', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'c', parentUuid: 'u', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'd', parentUuid: 'r1', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'u', parentUuid: 'd', isSidechain: false });

    assert.equal(state.latestUuid, 'u');
    assert.equal(detectActiveLeaf(state), 'u', 'the leaf is the last line written, not its stale child');
    assert.equal(activeLeafForRoot(state, 'r1', ['r1', 'u', 'c', 'd', 'u']), 'u',
      'the per-root rule must agree with the whole-file rule');
  });

  test('activeLeafForRoot uses the write order it is given, not topology insertion order', () => {
    // The parameter is the contract: it must be the physical order of the same scan that built
    // `state`. Topology insertion order here ends at 'second', the caller's order at 'first'.
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'first', parentUuid: 'r1', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'second', parentUuid: 'r1', isSidechain: false });
    assert.equal(activeLeafForRoot(state, 'r1', ['r1', 'second', 'first']), 'first');
  });

  test('resolveActivePath walks parent chain to root', () => {
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'a1', parentUuid: 'r1', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'a2', parentUuid: 'a1', isSidechain: false });
    const path = resolveActivePath(state, 'a2');
    assert.ok(path.has('r1'));
    assert.ok(path.has('a1'));
    assert.ok(path.has('a2'));
    assert.equal(path.size, 3);
  });

  test('isTopologyAncestor returns true for ancestor', () => {
    const state = createTopologyState();
    indexTopologyEntry(state, { uuid: 'r1', parentUuid: null, isSidechain: false });
    indexTopologyEntry(state, { uuid: 'a1', parentUuid: 'r1', isSidechain: false });
    indexTopologyEntry(state, { uuid: 'a2', parentUuid: 'a1', isSidechain: false });
    assert.equal(isTopologyAncestor(state, 'r1', 'a2'), true);
    assert.equal(isTopologyAncestor(state, 'a1', 'a2'), true);
    assert.equal(isTopologyAncestor(state, 'a2', 'r1'), false);
  });
});
