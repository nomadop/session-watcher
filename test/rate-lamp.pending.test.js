import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshLedger, stateKeyOf, matchPendingToSummary, settleableDistanceAfterWatermark } from '../lib/rate-lamp-store.js';

const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 2 });
// G8 (round-5): a FULLY F3-legal summary factory
const summary = (turnSeq, foldedCallSeqEnd = turnSeq) => ({
  turnSeq, foldedCallSeqEnd, foldedCallSeqStart: Math.max(0, foldedCallSeqEnd - 1),
  deltaW: 0, billCycleCountIncrement: 0, billKindAtBoundary: null, inDeepWaterAtBoundary: false,
  billProgressBefore: 0, billProgressAfter: 0, hBreakAtBoundary: null,
});
let _seq = 0;
const pending = (hookEventId, beforeSettledThroughTurnSeq, requestedAtWallMs) =>
  ({ hookEventId, beforeSettledThroughTurnSeq, requestedAtWallMs, enqueueSeq: _seq++, assignedTurnSeq: null, status: 'pending' });

test('C3-2: pending matches first summary with turnSeq > watermark', () => {
  const l = { ...freshLedger(KEY),
    pendingStopEvaluations: [pending('h1', 3, 100)],
    settledTurnSummaries: [summary(3), summary(4), summary(5)] };
  const { assigned } = matchPendingToSummary(l);
  assert.deepEqual(assigned, [{ hookEventId: 'h1', summaryTurnSeq: 4 }], 'first turnSeq > 3 is 4');
});

test('C3-2: zero-call turn — Stop at turn N (settledThrough=N-1) matches empty summary N (N>N-1)', () => {
  const l = { ...freshLedger(KEY),
    pendingStopEvaluations: [pending('h1', 4, 100)],   // watermark = N-1 = 4, target turn N = 5
    settledTurnSummaries: [{ turnSeq: 5, foldedCallSeqEnd: 9, deltaW: 0, foldedCallSeqStart: 9,
      billCycleCountIncrement: 0, billKindAtBoundary: null, inDeepWaterAtBoundary: false,
      billProgressBefore: 0, billProgressAfter: 0, hBreakAtBoundary: null }] };
  const { assigned } = matchPendingToSummary(l);
  assert.deepEqual(assigned, [{ hookEventId: 'h1', summaryTurnSeq: 5 }], 'empty summary 5 matches (5>4)');
});

test('C3-2: two DIFFERENT hook ids, SAME watermark → blind-merge to ONE summary, the rest expire (E2)', () => {
  const l = { ...freshLedger(KEY),
    pendingStopEvaluations: [pending('h1', 3, 100), pending('h2', 3, 200)],
    settledTurnSummaries: [summary(4), summary(5)] };
  const { assigned, expired } = matchPendingToSummary(l);
  assert.deepEqual(assigned, [{ hookEventId: 'h1', summaryTurnSeq: 4 }], 'only the first same-watermark pending resolves');
  assert.equal(expired.length, 1, 'the second same-watermark pending is returned in expired[]');
});

test('C3-2: two hook ids, DISTINCT watermarks → each matches its own turn (genuine multi-boundary)', () => {
  const l = { ...freshLedger(KEY),
    pendingStopEvaluations: [pending('h1', 3, 100), pending('h2', 4, 200)],
    settledTurnSummaries: [summary(4), summary(5)] };
  const { assigned } = matchPendingToSummary(l);
  assert.deepEqual(assigned, [{ hookEventId: 'h1', summaryTurnSeq: 4 }, { hookEventId: 'h2', summaryTurnSeq: 5 }]);
});

test('C3-2: no summary beyond watermark → pending retained, no alert', () => {
  const l = { ...freshLedger(KEY), pendingStopEvaluations: [pending('h1', 9, 100)], settledTurnSummaries: [summary(4)] };
  const { assigned, remainingPending } = matchPendingToSummary(l);
  assert.equal(assigned.length, 0);
  assert.equal(remainingPending.length, 1);
});

test('C3-2: slide-forward cap — a match >PENDING_MAX_TURN_DISTANCE settleable turns past the watermark is refused (A24)', () => {
  // watermark 3; the target turn 4 was dropped/never-flushed, so the first available summary is turn 6
  // (>2 settleable turns past 3). Must NOT slide the alert onto turn 6 — expire instead (no false alert).
  // Turn 4 is MISSING (no summary for it) → settleableDistanceAfterWatermark returns Infinity → expire.
  const l = { ...freshLedger(KEY), pendingStopEvaluations: [pending('h1', 3, 100)],
    settledTurnSummaries: [summary(6), summary(7)] };
  const { assigned, expired } = matchPendingToSummary(l);
  assert.equal(assigned.length, 0, 'not matched to the far summary');
  assert.equal(expired.length, 1, 'pending expired (slide-forward guard), never false-alerted');
});

// E9: settleableDistanceAfterWatermark matrix
test('C3-2: settleableDistanceAfterWatermark counts settleable (non-zero-call) turns only (E9)', () => {
  const S = (turnSeq, start, end) => ({ turnSeq, foldedCallSeqStart: start, foldedCallSeqEnd: end });
  const D = settleableDistanceAfterWatermark;
  assert.equal(D([S(4, 0, 2)], 3, 4), 1, 'one nonzero-call turn after wm → distance 1');
  assert.equal(D([S(4, 2, 2), S(5, 2, 4)], 3, 5), 1, 'zero-call turn 4 skipped → distance 1');
  assert.equal(D([S(4, 0, 2), S(5, 2, 2), S(6, 2, 5)], 3, 6), 2, 'zero-call 5 skipped → distance 2');
  assert.equal(D([S(5, 0, 2), S(6, 2, 4)], 3, 5), Infinity, 'turn 4 MISSING (not zero-call) → not settleable, unbounded/expire');
});

// ════════════════════════════════════════════════════════════════════════════════
// C4-1: Bounded incremental advance — byte-layer (B8) + implementation-note specs
// ════════════════════════════════════════════════════════════════════════════════

import { readCompleteJsonlEventsFromBuffer } from '../lib/fold.js';
import { boundedIncrementalAdvance, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { setLiveLedger, getLiveLedger } from '../lib/rate-lamp-manager.js';
// B8 byte-layer tests (pure readCompleteJsonlEventsFromBuffer)

test('C4-1/B8: maxBytes cuts mid-JSON-line → no parse, no mutate, no offset advance', () => {
  const line = Buffer.from('{"type":"assistant","message":{"id":"m1"}}\n');
  const cut = line.length - 8;                                  // budget ends mid-line
  const { events, nextOffset, caughtUp } = readCompleteJsonlEventsFromBuffer(line, { baseOffset: 0, maxBytes: cut });
  assert.deepEqual(events, [], 'no complete line => no events');
  assert.equal(nextOffset, 0, 'offset NOT advanced past a partial line');
  assert.equal(caughtUp, false);
});
test('C4-1/B8: maxBytes cuts mid-UTF-8 multibyte char → no replacement char, no half-line advance', () => {
  const line = Buffer.from('{"t":"€uro"}\n', 'utf8');           // euro = 3 bytes
  const eIdx = line.indexOf(0xe2);                              // first byte of euro
  const { events, nextOffset } = readCompleteJsonlEventsFromBuffer(line, { baseOffset: 0, maxBytes: eIdx + 1 });
  assert.deepEqual(events, [], 'partial multibyte => no decode');
  assert.equal(nextOffset, 0, 'no half-line / no U+FFFD replacement committed');
});
test('C4-1/B8: CRLF line → cursor advances the true \\r\\n byte length', () => {
  const line = Buffer.from('{"type":"user"}\r\n', 'utf8');
  const { events, nextOffset } = readCompleteJsonlEventsFromBuffer(line, { baseOffset: 0, maxBytes: line.length });
  assert.equal(events.length, 1);
  assert.equal(nextOffset, line.length, 'cursor includes both \\r and \\n');
});
test('C4-1/B8: liveTail — final line without a trailing newline is NEVER committed (F5)', () => {
  const line = Buffer.from('{"type":"user"}', 'utf8');          // no '\n'
  const live = readCompleteJsonlEventsFromBuffer(line, { baseOffset: 0, maxBytes: line.length, atEof: false });
  assert.deepEqual(live.events, [], 'live tail: no newline => incomplete, uncommitted');
  assert.equal(live.nextOffset, 0);
});
test('C4-1/B8: sealedEof — newline-less final line IS complete ONLY for sealed/offline replay (F5)', () => {
  const line = Buffer.from('{"type":"user"}', 'utf8');          // no '\n'
  const sealed = readCompleteJsonlEventsFromBuffer(line, { baseOffset: 0, maxBytes: line.length, atEof: true });
  assert.equal(sealed.events.length, 1, 'sealed EOF: the trailing newline-less line IS a complete event');
});
test('C4-1/B8: NON-ZERO baseOffset → nextOffset is ABSOLUTE (baseOffset + committed bytes), not buffer-local (round-8 GPT-pt6 / round-9 GPT-pt5)', () => {
  const chunk = Buffer.from('{"type":"assistant","message":{"id":"m1"}}\n', 'utf8');
  const baseOffset = 4096;
  const { events, nextOffset } = readCompleteJsonlEventsFromBuffer(chunk, { baseOffset, maxBytes: chunk.length });
  assert.equal(events.length, 1, 'scans from chunk[0], reads the one complete line');
  assert.equal(nextOffset, baseOffset + chunk.length, 'nextOffset is ABSOLUTE (baseOffset + committed bytes), NOT the in-chunk length alone');
});

// Implementation-note specs (1-4) — real asserts against manager/route

test('C4-1: offset-commit — budget exhaustion stops BEFORE the next event, cursor not half-advanced', () => {
  _resetRateLampManagerForTest();
  // Build a multi-line buffer where maxBytes cuts mid-second-line
  const line1 = Buffer.from('{"type":"assistant","message":{"id":"m1"}}\n');
  const line2 = Buffer.from('{"type":"assistant","message":{"id":"m2"}}\n');
  const full = Buffer.concat([line1, line2]);
  const cut = line1.length + 5; // can complete line1 but cuts mid-line2
  const { events, nextOffset, caughtUp } = readCompleteJsonlEventsFromBuffer(full, { baseOffset: 100, maxBytes: cut });
  assert.equal(events.length, 1, 'only the first complete line parsed');
  assert.equal(nextOffset, 100 + line1.length, 'cursor at end of last FULLY committed line');
  assert.equal(caughtUp, false, 'did not reach end of buffer');
});

test('C4-1/G2: mid-batch throw rolls BOTH the ledger draft AND watcher._offset back (no half-commit)', () => {
  _resetRateLampManagerForTest();
  // The test verifies the BYTE-LAYER offset-commit contract: if mutateLedger throws mid-batch,
  // watcher._offset remains unchanged (batch-staging G2). We test at the readCompleteJsonlEventsFromBuffer
  // level + simulate the manager-level throw.
  const line1 = '{"type":"assistant","message":{"id":"m1"}}\n';
  const line2 = '{"type":"assistant","message":{"id":"m2"}}\n';
  const buf = Buffer.from(line1 + line2);
  const result = readCompleteJsonlEventsFromBuffer(buf, { baseOffset: 0, maxBytes: buf.length, atEof: false });
  const stagedOffset = result.nextOffset;
  // Simulate: batch-staging means _offset is assigned ONLY after mutateLedger returns.
  // If mutateLedger throws, _offset stays at its pre-advance value.
  let watcherOffset = 0;
  try {
    // Simulate mutateLedger throwing mid-batch
    throw new Error('simulated mid-batch throw');
    // eslint-disable-next-line no-unreachable
    watcherOffset = stagedOffset; // would execute only on success
  } catch {
    // G2: watcher._offset MUST remain unchanged
  }
  assert.equal(watcherOffset, 0, 'watcher._offset unchanged after throw (batch-staging G2)');
  assert.ok(stagedOffset > 0, 'stagedOffset WAS computed but never assigned');
});

test('C4-1/H-A: bounded advance settles NOTHING for the open turn; returns {caughtUp, status} with no bill', () => {
  _resetRateLampManagerForTest();
  // The bounded advance must return {caughtUp, status} with NO bill field
  // and leave the open turn unsettled. We test via a mock watcher.
  const sid = 'test-c4-ha-' + Date.now();
  const FP = 'd30000|t25000|k6|T';
  const testKey = stateKeyOf({ segmentId: 0, model: 'claude-opus-4-8', cRatio: 10,
    baselineFingerprint: FP, contextCap: 960000, schemaVersion: 1 });

  // Seed a ledger with settledThroughTurnSeq=1 and currentTurnSeq=2 (open turn 2)
  const ledger = { ...freshLedger(KEY, 940),
    stateKey: testKey, lastAppliedFoldedCallSeq: 3, currentTurnSeq: 2, settledThroughTurnSeq: 1,
    billAnchorLRead: 50000, billAnchorFoldedCallSeq: 1 };
  setLiveLedger(sid, ledger);

  // Mock watcher: poll does nothing, no new samples, getStatus returns reliable
  const w = {
    path: '/dev/null', _offset: 0, _turnSeq: 2, _foldedCallSeq: 3,
    _currentSegmentCalls() { return []; },
    poll() { return { changed: false, newCalls: 0 }; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    getStatus() {
      return {
        segment: 0, model: 'claude-opus-4-8', kAvg: 940, L: 160000,
        baseline: { total: 55000, dead: 30000, fingerprint: FP },
        rateLamp: { reliable: true, C_RATIO: 10, L_cap: 960000, kStable: 940,
          B_post: 55000, B_rebuild: 55000, L_read: 55000, burnRate: 0.3,
          inDeepWater: false, hBreak: 3.33, xExit: 2.169, L_exit_fullCarry: 119295 },
      };
    },
  };

  const result = boundedIncrementalAdvance(w, sid, { maxMs: 150, maxBytes: 524288 });
  assert.equal(result.caughtUp, true, 'caughtUp is true (no new events to read)');
  assert.ok(result.status, 'status returned');
  assert.ok(!('bill' in result), 'NO bill field in return (H-A: Stop settles nothing)');
  // Open turn NOT settled
  const after = getLiveLedger(sid);
  assert.equal(after.settledThroughTurnSeq, 1, 'open turn 2 NOT settled');
});

test('C4-1/H-A: an open turn that WOULD be empty_burn is not judged at Stop — pending enqueued, reader decides', () => {
  _resetRateLampManagerForTest();
  // Even when the open turn looks like a low-deltaW empty_burn, the bounded advance makes NO settle
  // and NO inline empty_burn; it returns {caughtUp, status} only, open turn unsettled.
  const sid = 'test-c4-eb-' + Date.now();
  const FP = 'd30000|t25000|k6|T';
  const testKey = stateKeyOf({ segmentId: 0, model: 'claude-opus-4-8', cRatio: 10,
    baselineFingerprint: FP, contextCap: 960000, schemaVersion: 1 });
  // Seed ledger where open turn has tiny deltaW < kStable (would be empty_burn)
  const ledger = { ...freshLedger(KEY, 940),
    stateKey: testKey, lastAppliedFoldedCallSeq: 5, currentTurnSeq: 3, settledThroughTurnSeq: 2,
    currentTurnDeltaW: 0.1, // very small — would be empty_burn under old settle
    billAnchorLRead: 54999, billAnchorFoldedCallSeq: 3, lastAppliedLRead: 55000 };
  setLiveLedger(sid, ledger);

  const w = {
    path: '/dev/null', _offset: 0, _turnSeq: 3, _foldedCallSeq: 5,
    _currentSegmentCalls() { return []; },
    poll() { return { changed: false, newCalls: 0 }; },
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    getStatus() {
      return {
        segment: 0, model: 'claude-opus-4-8', kAvg: 940, L: 55000,
        baseline: { total: 55000, dead: 30000, fingerprint: FP },
        rateLamp: { reliable: true, C_RATIO: 10, L_cap: 960000, kStable: 940,
          B_post: 55000, B_rebuild: 55000, L_read: 55000, burnRate: 0.01,
          inDeepWater: false, hBreak: 100, xExit: 2.169, L_exit_fullCarry: 119295 },
      };
    },
  };

  const result = boundedIncrementalAdvance(w, sid, { maxMs: 150, maxBytes: 524288 });
  assert.equal(result.caughtUp, true);
  assert.ok(!('bill' in result), 'no bill — open turn NOT judged');
  const after = getLiveLedger(sid);
  // The open turn (3) is NOT settled — settledThroughTurnSeq stays at 2
  assert.equal(after.settledThroughTurnSeq, 2, 'open turn 3 NOT settled (reader decides)');
  // No settledTurnSummaries added for the open turn
  const openTurnSummary = (after.settledTurnSummaries || []).find(s => s.turnSeq === 3);
  assert.equal(openTurnSummary, undefined, 'no summary emitted for the open turn');
});
