// The checkpoint the Rate Lamp manager leaves in the store: a frame driven through the manager's public entry and the coalesced flush lands whatever the live ledger then holds, wherever a reanchor or an epoch change left its revision. The store is a SQLite file of this test's own and the fake frame source has the real `readRateLampFrame`'s return shape; the checkpoint is read back through `loadRateLampState`.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeStoreGlobal, initStore } from '../lib/store.js';
import {
  advanceRateLampToCurrent, flushPendingPersistsSync, getDebugCounters, getLiveLedger, _resetRateLampManagerForTest,
} from '../lib/rate-lamp-manager.js';
import { loadRateLampState, stateKeyForStatus } from '../lib/rate-lamp-store.js';

const SID = 'sid-persist-checkpoint';
const MF = 0.4;

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-rl-checkpoint-'));
  initStore(join(dir, 'test.sqlite'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const sample = (seq, deltaW) => ({ seq, reliable: true, deltaW, mf: MF, L_read: 100_000 + seq, turnSeq: 1 });
const bill = ledger => ledger.billCycleCount + ledger.billProgress;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);

// A frame source with the real method's shape: the samples after the cursor it is asked from, `qualified` only when the input qualified the frame. `samples` are the whole prefix and `tail` the seq its last call holds.
function source({ samples, tail = samples.at(-1)?.seq ?? 0, streamRevision = 1, qualified = false, segment = 0 }) {
  return {
    readRateLampFrame(sinceFoldedSeq) {
      return {
        status: { reliable: true, C_RATIO: 10, mfLocal: MF, B_default: 250_000, bDefault: 250_000 },
        progress: { segment, measuredCalls: samples.length, sinceFoldedSeq },
        samples: samples.filter(each => each.seq > sinceFoldedSeq),
        turnSeq: 1,
        foldedCallSeq: tail,
        streamRevision,
        ...(qualified ? { qualified: true } : {}),
      };
    },
  };
}

// One poll tick: the advance, then the write-behind flush the timer would have run.
function tick(frameSource) {
  const { ledger } = advanceRateLampToCurrent(frameSource, SID, { forcePoll: false });
  flushPendingPersistsSync();
  return ledger;
}

// A prefix growing one call per tick, so the segment's ledger has been written at a revision well past a fresh one's.
function grow(segment, qualified, firstSeq = 1) {
  const samples = [sample(firstSeq, null)];
  tick(source({ samples: [...samples], segment, qualified }));
  for (let seq = firstSeq + 1; seq < firstSeq + 5; seq += 1) {
    samples.push(sample(seq, 0.05));
    tick(source({ samples: [...samples], segment, qualified }));
  }
  return samples;
}

test('an unqualified reanchor inside one epoch moves the cursor without a new revision, and the checkpoint follows it', () => {
  const samples = grow(0, false);
  assert.equal(loadRateLampState(SID).lastAppliedFoldedCallSeq, 5);
  const before = getLiveLedger(SID);
  const reanchored = tick(source({ samples: samples.slice(0, 2), streamRevision: 2 }));
  assert.equal(reanchored.ledgerRevision, before.ledgerRevision, 'the reanchor itself raises no revision');
  assert.equal(reanchored.lastAppliedFoldedCallSeq, 2, 'the cursor re-anchors at the frame tail');
  assert.deepEqual(loadRateLampState(SID), getLiveLedger(SID), 'the stored checkpoint is the live ledger');
});

test('an unqualified frame of another segment writes that segment\'s ledger though its revision starts below the retired one\'s', () => {
  grow(0, false);
  const retired = getLiveLedger(SID);
  const first = tick(source({ samples: [sample(6, 0.2)], segment: 1 }));
  assert.ok(first.ledgerRevision < retired.ledgerRevision, 'the new segment\'s ledger counts from its own start');
  const stored = loadRateLampState(SID);
  assert.equal(stored.stateKey, stateKeyForStatus({ segment: 1 }));
  assert.deepEqual(stored, getLiveLedger(SID));
});

test('a qualified frame of another segment writes its replaced budget though its revision starts below the retired one\'s', () => {
  grow(0, true);
  const retired = getLiveLedger(SID);
  const first = tick(source({ samples: [sample(6, null), sample(7, 0.25)], segment: 1, qualified: true }));
  assert.ok(first.ledgerRevision < retired.ledgerRevision, 'the new segment\'s ledger counts from its own start');
  const stored = loadRateLampState(SID);
  assert.equal(stored.stateKey, stateKeyForStatus({ segment: 1 }));
  close(bill(stored), 0.25, 'stored bill');
  assert.deepEqual(stored, getLiveLedger(SID));
});

test('a frame read again after the checkpoint caught up is not written again', () => {
  const samples = grow(0, false);
  const revised = source({ samples: samples.slice(0, 2), streamRevision: 2 });
  tick(revised);
  assert.deepEqual(loadRateLampState(SID), getLiveLedger(SID), 'the checkpoint has caught up with the reanchor');
  const writes = getDebugCounters().diskWrites;
  for (let read = 0; read < 3; read += 1) tick(revised);
  assert.equal(getDebugCounters().diskWrites, writes, 'an unchanged ledger is not rewritten');
  assert.deepEqual(loadRateLampState(SID), getLiveLedger(SID));
});
