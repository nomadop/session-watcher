// The Rate Lamp manager under an input that qualifies the calls its budget may count: where the stream is new to a process or has been rebuilt, a frame whose samples are a qualified prefix replaces the budget the ledger holds, where a frame nobody qualified keeps it. The manager is driven through its public frame entry over an isolated store, and the fake frame source has the real method's return shape.
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
import { BR_AMBER, walletIntervalFor } from '../lib/bill-regret.js';

const SID = 'sid-qualified-prefix';
const MF = 0.4;
const LAP = walletIntervalFor(MF, BR_AMBER);

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-rl-qualified-'));
  initStore(join(dir, 'test.sqlite'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

// A sample as the Engine stamps it: the rent increment its interval paid and the movable fraction it was priced at.
const sample = (seq, deltaW, turnSeq = 1, mf = MF) => ({ seq, reliable: true, deltaW, mf, L_read: 100_000 + seq, turnSeq });
const wallet = ledger => ledger.walletLapCount + ledger.walletPhase;
const bill = ledger => ledger.billCycleCount + ledger.billProgress;
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} is not ${expected}`);

// A frame source with the real `readRateLampFrame`'s shape: the samples after the cursor it is asked from, and `qualified` only when the input qualified the frame. `samples` are the whole prefix and `tail` the seq its last call holds.
function source({ samples, tail = samples.at(-1)?.seq ?? 0, turnSeq = 1, streamRevision = 1, qualified = true, segment = 0 }) {
  return {
    readRateLampFrame(sinceFoldedSeq) {
      return {
        status: { reliable: true, C_RATIO: 10, mfLocal: MF, B_default: 250_000, bDefault: 250_000 },
        progress: { segment, measuredCalls: samples.length, sinceFoldedSeq },
        samples: samples.filter(each => each.seq > sinceFoldedSeq),
        turnSeq,
        foldedCallSeq: tail,
        streamRevision,
        ...(qualified ? { qualified: true } : {}),
      };
    },
  };
}

const advance = frameSource => advanceRateLampToCurrent(frameSource, SID, { forcePoll: false }).ledger;

// The state an earlier process of this version left: its frame advanced through the manager and written through the store's one writer, the process itself gone.
function earlierProcess(frameSource) {
  const ledger = advance(frameSource);
  flushPendingPersistsSync();
  _resetRateLampManagerForTest();
  return ledger;
}

test('a process that reads the Source its predecessor left replaces the stored budget with the integral of the prefix it now reads, adding nothing to it', () => {
  const stored = earlierProcess(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5)] }));
  close(bill(stored), 0.8, 'the stored bill');
  const ledger = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5), sample(4, 0.1)], turnSeq: 6 }));
  close(bill(ledger), 0.9, 'bill');
  close(wallet(ledger), 0.9 / LAP, 'wallet');
  assert.deepEqual([ledger.billCycleCount, ledger.walletLapCount], [0, 0]);
  assert.equal(ledger.lastAppliedFoldedCallSeq, 4, 'the cursor is the frame\'s, the qualified tail');
  assert.equal(ledger.currentTurnSeq, 6);
  assert.equal(ledger.pausedReason, null);
});

test('replacing raises no reminder for the laps the prefix already crossed and keeps the history of the reminders raised', () => {
  advance(source({ samples: [sample(1, null), sample(2, 0.3)] }));
  const raised = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, LAP)] }));
  assert.deepEqual(raised.recentStopEvents.map(event => event.billCount), [1]);
  flushPendingPersistsSync();
  _resetRateLampManagerForTest();
  const ledger = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, LAP), sample(4, LAP * 1.2)] }));
  assert.equal(ledger.walletLapCount, 2, 'the prefix crosses a second lap');
  assert.equal(ledger.lastStopEvent, null);
  assert.deepEqual(ledger.recentStopEvents.map(event => event.billCount), [1], 'the lap it replays raises none and the history stays as it was');
});

test('a rebuilt stream drops the reminder the earlier one left visible, and a lap its budget crosses raises its own', () => {
  advance(source({ samples: [sample(1, null), sample(2, 0.3)] }));
  const raised = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, LAP)] }));
  assert.equal(raised.lastStopEvent.billCount, 1);
  const rebuilt = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, LAP), sample(4, 0.1)], streamRevision: 2 }));
  assert.equal(rebuilt.lastStopEvent, null, 'a replaced budget shows no reminder of the one it replaced');
  assert.equal(rebuilt.walletLapCount, 1);
  const again = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, LAP), sample(4, 0.1), sample(5, LAP)], streamRevision: 2 }));
  assert.equal(again.lastStopEvent.billCount, 2);
  assert.deepEqual(again.recentStopEvents.map(event => event.billCount), [1, 2]);
});

test('a frame read again adds nothing: the same prefix is neither integrated twice nor rewritten', () => {
  const frame = source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5)] });
  const first = advance(frame);
  flushPendingPersistsSync();
  const writes = getDebugCounters().diskWrites;
  for (let read = 0; read < 3; read += 1) assert.deepEqual(advance(frame), first);
  flushPendingPersistsSync();
  assert.equal(getDebugCounters().diskWrites, writes, 'an unchanged ledger is not written again');
  assert.equal(getLiveLedger(SID).ledgerRevision, first.ledgerRevision);
});

test('a later qualified call of the same stream integrates onto the replaced budget, and the lap it crosses raises its reminder', () => {
  advance(source({ samples: [sample(1, null), sample(2, 0.3)] }));
  const crossing = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, LAP)], turnSeq: 1 }));
  close(wallet(crossing), (0.3 + LAP) / LAP, 'wallet');
  assert.equal(crossing.walletLapCount, 1);
  assert.deepEqual(crossing.lastStopEvent && [crossing.lastStopEvent.billCount, crossing.lastStopEvent.seq], [1, 3]);
  assert.deepEqual(crossing.recentStopEvents.map(event => event.billCount), [1]);
});

test('a rebuilt stream replaces the budget with its own prefix, the new post included, and counts the earlier prefix once', () => {
  advance(source({ samples: [sample(1, null), sample(2, 0.9), sample(3, 0.9)] }));
  const rebuilt = advance(source({ samples: [sample(1, null), sample(2, 0.9), sample(3, 0.9), sample(4, 0.2)], streamRevision: 2 }));
  close(bill(rebuilt), 2.0, 'bill');
  close(wallet(rebuilt), 2.0 / LAP, 'wallet');
  assert.equal(rebuilt.lastAppliedFoldedCallSeq, 4);
});

test('streamRevision alone never replaces a budget nobody qualified', () => {
  advance(source({ samples: [sample(1, null)], qualified: false }));
  const held = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5)], qualified: false }));
  close(bill(held), 0.8, 'the budget the ordinary stream integrated');
  const ledger = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5), sample(4, 0.1)], streamRevision: 9, qualified: false }));
  assert.deepEqual([ledger.billCycleCount, ledger.billProgress, ledger.walletLapCount, ledger.walletPhase],
    [held.billCycleCount, held.billProgress, held.walletLapCount, held.walletPhase]);
  assert.equal(ledger.lastAppliedFoldedCallSeq, 4, 'the cursor re-anchors at the frame tail');
});

test('a qualified frame of another segment starts that segment\'s budget from nothing', () => {
  advance(source({ samples: [sample(1, null), sample(2, 0.3)] }));
  const ledger = advance(source({ samples: [sample(5, null), sample(6, 0.25)], segment: 1 }));
  assert.equal(ledger.stateKey, stateKeyForStatus({ segment: 1 }));
  close(bill(ledger), 0.25, 'bill');
  assert.equal(ledger.lastAppliedFoldedCallSeq, 6);
});

test('a qualified frame with no call qualified yet leaves a fresh budget at zero with the cursor before the first call', () => {
  const ledger = advance(source({ samples: [], tail: 0 }));
  assert.deepEqual([bill(ledger), wallet(ledger), ledger.lastAppliedFoldedCallSeq], [0, 0, 0]);
});

test('the replaced ledger reaches the store through the one writer and survives a restart as the next qualified read\'s budget', () => {
  const ledger = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5)] }));
  assert.ok(ledger.ledgerRevision > 0);
  flushPendingPersistsSync();
  const stored = loadRateLampState(SID);
  close(bill(stored), 0.8, 'stored bill');
  assert.equal(stored.lastStopEvent, null);
  _resetRateLampManagerForTest();
  const restarted = advance(source({ samples: [sample(1, null), sample(2, 0.3), sample(3, 0.5)] }));
  close(bill(restarted), 0.8, 'the budget after a restart');
});

test('an unreliable frame still preserves both clocks and pauses, qualified or not', () => {
  advance(source({ samples: [sample(1, null), sample(2, 0.3)] }));
  const held = getLiveLedger(SID);
  const unreliable = {
    readRateLampFrame: () => ({
      status: { reliable: false, unavailableReason: 'insufficient_data' }, progress: { segment: 0, measuredCalls: 0, sinceFoldedSeq: 2 },
      samples: [], turnSeq: 2, foldedCallSeq: 2, streamRevision: 1, qualified: true,
    }),
  };
  const ledger = advance(unreliable);
  assert.equal(bill(ledger), bill(held));
  assert.equal(ledger.pausedReason, 'insufficient_data');
});
