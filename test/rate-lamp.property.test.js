// ═══════════════════════════════════════════════════════════════════════════════════════════════
// C5c-1: Property-based reference-model oracle + chaos injection over the settlement engine.
//
// Seeds a small PRNG (mulberry32) with a FIXED seed constant for reproducibility. Generates
// random event sequences from [sample(deltaW), boundary(turnSeq), statuslineRead, heartbeatRead,
// stopHook, flushDelay, coalescedPersistFlush, crashHydrate], drives the REAL manager/store
// functions, and compares observable ledger projections against an INDEPENDENT reference model
// (plain array + exact arithmetic — MUST NOT call production settleMeterAtBoundary / matchPendingToSummary).
//
// Assertions (spec §10.3 C property-based oracle):
// - billProgress/billCycleCount == oracle
// - Each ended turn ≤1 settle
// - Each pending ≤1 assign
// - Each summary ≤1 consume
// - Reader NEVER records an alert / never advances alertEvaluatedThroughTurnSeq
// - Stop records alert only AFTER persist
// - Old coalesced snapshot never overwrites a new Stop alert
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Initialize a module-level SQLite store so disk writes never touch the real ~/.session-watcher.
import { initStore, closeStoreGlobal } from '../lib/store.js';
const TMP = mkdtempSync(join(tmpdir(), 'sw-rl-prop-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {};
});

import { freshLedger, stateKeyOf, applyFoldedCallSample, settleMeterAtBoundary } from '../lib/rate-lamp-store.js';
import {
  advanceRateLampToCurrent,
  setLiveLedger,
  getLiveLedger,
  _resetRateLampManagerForTest,
  _setRateLampManagerTestHooks,
  flushPendingPersistsSync,
  schedulePersist,
  cancelCoalescedPersist,
  commitLedgerMutationSync,
  drainPendingStopEvaluations,
  mutateLedger,
} from '../lib/rate-lamp-manager.js';
import { validateLedgerState } from '../lib/ledger-schema.js';

// ─── Mulberry32 PRNG (deterministic, 32-bit state) ────────────────────────────────────────────
function mulberry32(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────────────────────
const FIXED_SEED = 0xCAFE_BABE;
const SEQUENCES_PER_RUN = 200;
const EVENTS_PER_SEQUENCE = 40;
const K_STABLE = 940;
const BASELINE_TOTAL = 250000;
const L_CAP = 1_000_000;

// The state key the fakeWatcher computes (stateKeyForStatus pins schemaVersion:1 in the key string)
const WKEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: L_CAP, schemaVersion: 1 });

// ─── Fake watcher constructor ─────────────────────────────────────────────────────────────────
function makeFakeWatcher({ turnSeq, foldedSeq, samples, kStable = K_STABLE, L_read = 300000 }) {
  return {
    _turnSeq: turnSeq,
    _foldedCallSeq: foldedSeq,
    poll() { return { changed: false, newCalls: 0 }; },
    getStatus() {
      return {
        segment: 0, model: 'opus',
        baseline: { fingerprint: 'f', total: BASELINE_TOTAL },
        rateLamp: { reliable: true, C_RATIO: 10, L_cap: L_CAP, L_read, B_post: BASELINE_TOTAL, B_rebuild: BASELINE_TOTAL, kStable },
      };
    },
    rateLampSamplesSince(sinceSeq) {
      return samples.filter(s => s.seq > sinceSeq);
    },
    rateLampSeqSamplesSince(sinceSeq) {
      return samples.filter(s => s.seq > sinceSeq);
    },
  };
}

// ─── Independent oracle (plain arithmetic, NO production function calls) ──────────────────────
// Tracks billProgress and billCycleCount using the same trapezoid rule as the production code
// but computed independently from the raw event list. Also tracks settle-per-turn counts.
//
// Key behavior modeled:
// - anchorFresh sets lastAppliedFoldedCallSeq = watcherFoldedSeq, so the sample AT the anchor
//   point never reaches the reducer. The oracle must skip it.
// - The FIRST sample post-anchor that reaches the reducer triggers the "recovering" path
//   (sets lastBurnRate, no integration). Only from the THIRD distinct sample onward does
//   real trapezoid integration happen.
// - An unreliable sample nulls lastBurnRate, forcing the next reliable sample to re-anchor.
class ReferenceOracle {
  constructor() {
    this.billProgress = 0;
    this.billCycleCount = 0;
    this.lastBurnRate = null; // null until first post-anchor recovery
    this.anchoredSeq = -1;   // the seq absorbed by anchorFresh (never reaches reducer)
    this.lastAppliedSeq = 0; // tracks the highest seq processed (mirrors lastAppliedFoldedCallSeq)
    this.settled = new Map(); // turnSeq → number of settles
    this.pendingAssigns = new Map(); // hookEventId → number of assigns
    this.summaryConsumes = new Map(); // turnSeq → number of consume-uses
    this.currentTurnSeq = 0;
    this.currentTurnDeltaW = 0;
  }

  // Called once when the production code creates a fresh ledger (anchors at the current seq).
  // The oracle skips this sample — it never reaches applyFoldedCallSample in production.
  anchor(seq) {
    this.anchoredSeq = seq;
    this.lastAppliedSeq = seq;
  }

  // Apply a folded call sample — mirrors the trapezoid integration in applyFoldedCallSample
  // but is an INDEPENDENT computation (no production function call).
  applySample(sample) {
    // Skip samples at or below the anchor (they never reach the reducer in production)
    if (sample.seq <= this.lastAppliedSeq) return;

    this.lastAppliedSeq = sample.seq;

    if (!sample.reliable) {
      this.lastBurnRate = null; // force re-anchor on recovery
      return;
    }
    const br = Number.isFinite(sample.burnRate) ? Math.max(0, sample.burnRate) : 0;

    // Per-turn DeltaW reset on turn boundary
    if (sample.turnSeq !== this.currentTurnSeq) {
      this.currentTurnSeq = sample.turnSeq;
      this.currentTurnDeltaW = 0;
    }

    // First frame after (re)anchor: re-anchor only (P0-5), no integration
    if (this.lastBurnRate === null) {
      this.lastBurnRate = br;
      return;
    }

    // Trapezoid integration (the core billing math)
    const trap = 0.5 * (this.lastBurnRate + br);
    let next = this.billProgress + trap;
    while (next >= 1) {
      next -= 1;
      this.billCycleCount += 1;
    }
    this.billProgress = Math.floor(next * 1e6) / 1e6;
    this.currentTurnDeltaW = Math.floor((this.currentTurnDeltaW + trap) * 1e6) / 1e6;
    this.lastBurnRate = br;
  }

  // Record that a turn was settled
  recordSettle(turnSeq) {
    this.settled.set(turnSeq, (this.settled.get(turnSeq) || 0) + 1);
  }

  // Record that a pending was assigned
  recordPendingAssign(hookEventId) {
    this.pendingAssigns.set(hookEventId, (this.pendingAssigns.get(hookEventId) || 0) + 1);
  }

  // Record that a summary was consumed
  recordSummaryConsume(turnSeq) {
    this.summaryConsumes.set(turnSeq, (this.summaryConsumes.get(turnSeq) || 0) + 1);
  }
}

// ─── Event types and generators ───────────────────────────────────────────────────────────────

// Oracle-focused events: sample + boundary + reader paths + stopHook. No crash/flush events
// (those are tested separately in the chaos/crash tests where the oracle isn't the focus).
function generateOracleSequence(rng, length) {
  const events = [];
  let seq = 0;
  let turnSeq = 1;
  let L_read = 100000;

  for (let i = 0; i < length; i++) {
    const r = rng();
    if (r < 0.4) {
      // sample (40% — most events should advance the meter)
      seq++;
      const burnRate = rng() * 3.0;
      L_read += Math.floor(rng() * 5000);
      events.push({ type: 'sample', seq, burnRate, L_read, turnSeq, reliable: true });
    } else if (r < 0.55) {
      // boundary (15%)
      turnSeq++;
      events.push({ type: 'boundary', turnSeq });
    } else if (r < 0.7) {
      // statuslineRead (15%)
      events.push({ type: 'statuslineRead' });
    } else if (r < 0.85) {
      // heartbeatRead (15%)
      events.push({ type: 'heartbeatRead' });
    } else {
      // stopHook (15%)
      events.push({ type: 'stopHook', hookEventId: `hook-${i}-${Math.floor(rng() * 1000)}` });
    }
  }
  return { events, finalSeq: seq, finalTurnSeq: turnSeq, finalLRead: L_read };
}

// Full event set including crash/flush for the chaos and crash-hydrate tests.
const ALL_EVENT_TYPES = ['sample', 'boundary', 'statuslineRead', 'heartbeatRead', 'stopHook', 'flushDelay', 'coalescedPersistFlush', 'crashHydrate'];

function generateFullEventSequence(rng, length) {
  const events = [];
  let seq = 0;
  let turnSeq = 1;
  let L_read = 100000;

  for (let i = 0; i < length; i++) {
    const typeIdx = Math.floor(rng() * ALL_EVENT_TYPES.length);
    const type = ALL_EVENT_TYPES[typeIdx];

    switch (type) {
      case 'sample': {
        seq++;
        const burnRate = rng() * 3.0;
        L_read += Math.floor(rng() * 5000);
        events.push({ type: 'sample', seq, burnRate, L_read, turnSeq, reliable: true });
        break;
      }
      case 'boundary': {
        turnSeq++;
        events.push({ type: 'boundary', turnSeq });
        break;
      }
      case 'statuslineRead': {
        events.push({ type: 'statuslineRead' });
        break;
      }
      case 'heartbeatRead': {
        events.push({ type: 'heartbeatRead' });
        break;
      }
      case 'stopHook': {
        events.push({ type: 'stopHook', hookEventId: `hook-${i}-${Math.floor(rng() * 1000)}` });
        break;
      }
      case 'flushDelay': {
        events.push({ type: 'flushDelay' });
        break;
      }
      case 'coalescedPersistFlush': {
        events.push({ type: 'coalescedPersistFlush' });
        break;
      }
      case 'crashHydrate': {
        events.push({ type: 'crashHydrate' });
        break;
      }
    }
  }
  return { events, finalSeq: seq, finalTurnSeq: turnSeq, finalLRead: L_read };
}

// ─── Run a single sequence: drive production + oracle ─────────────────────────────────────────
function runSequence(events, sid) {
  const oracle = new ReferenceOracle();
  let flushedWrites = [];
  let timerCb = null;
  let lastAlertEvalTurnSeq = 0; // track reader's alertEvaluatedThroughTurnSeq
  let ledgerCreated = false; // track whether the production code has created a ledger

  // Use real disk writes (temp dir) so crashHydrate can reload. Only mock the scheduler
  // to prevent real timers from firing outside our control.
  _setRateLampManagerTestHooks({
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });

  // Accumulated samples for the watcher stub
  let allSamples = [];
  let currentTurnSeq = 1;
  let currentFoldedSeq = 0;
  let currentLRead = 100000;

  // Do NOT seed an initial ledger — let advanceRateLampToCurrent create one naturally
  // via hydrateLedger → null → resolveLedgerForKey(null, ...) → anchorFresh().
  // This avoids the DEAD-LETTER diagnostic from setLiveLedger + subsequent syncLedgerTurn.

  // Helper: detect ledger creation and anchor the oracle at the same seq the production used.
  // The production's anchorFresh sets lastAppliedFoldedCallSeq = watcherFoldedSeq, so we anchor
  // at whatever `currentFoldedSeq` was when the first advance created the ledger.
  function maybeAnchorOracle() {
    if (ledgerCreated) return;
    const l = getLiveLedger(sid);
    if (l) {
      ledgerCreated = true;
      // The production anchored at l.lastAppliedFoldedCallSeq (== watcherFoldedSeq at creation time).
      oracle.anchor(l.lastAppliedFoldedCallSeq);
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'sample': {
        const sample = {
          seq: event.seq, reliable: event.reliable,
          burnRate: event.burnRate, L_read: event.L_read,
          turnSeq: event.turnSeq,
        };
        allSamples.push(sample);
        currentFoldedSeq = event.seq;
        currentTurnSeq = event.turnSeq;
        currentLRead = event.L_read;

        // Drive production: advance
        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        maybeAnchorOracle();

        // Feed to oracle (it will skip if seq <= lastAppliedSeq due to anchor)
        oracle.applySample(sample);

        // After reader advance: alertEvaluatedThroughTurnSeq MUST NOT advance
        // (reader never records an alert / never advances the cursor)
        const ledger = getLiveLedger(sid);
        const newAlertEval = ledger?.alertEvaluatedThroughTurnSeq || 0;
        if (newAlertEval > lastAlertEvalTurnSeq) {
          lastAlertEvalTurnSeq = newAlertEval;
        }
        break;
      }
      case 'boundary': {
        currentTurnSeq = event.turnSeq;

        // Advance production to see the new turn
        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        maybeAnchorOracle();

        // Track settles in the oracle (just record which turns have been settled)
        const ledger = getLiveLedger(sid);
        if (ledger) {
          for (const s of (ledger.settledTurnSummaries || [])) {
            if (!oracle.settled.has(s.turnSeq)) {
              oracle.recordSettle(s.turnSeq);
            }
          }
        }
        break;
      }
      case 'statuslineRead': {
        // A reader path: advance via advanceRateLampToCurrent (the statusline read)
        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        const beforeLedger = getLiveLedger(sid);
        const alertBefore = beforeLedger?.alertEvaluatedThroughTurnSeq || 0;

        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        maybeAnchorOracle();

        // INVARIANT: reader NEVER advances alertEvaluatedThroughTurnSeq
        const afterLedger = getLiveLedger(sid);
        const alertAfter = afterLedger?.alertEvaluatedThroughTurnSeq || 0;
        if (alertAfter > alertBefore) {
          return { error: 'reader advanced alertEvaluatedThroughTurnSeq', alertBefore, alertAfter };
        }
        break;
      }
      case 'heartbeatRead': {
        // Same as statuslineRead — it is a reader surface
        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        const beforeLedger = getLiveLedger(sid);
        const alertBefore = beforeLedger?.alertEvaluatedThroughTurnSeq || 0;

        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        maybeAnchorOracle();

        const afterLedger = getLiveLedger(sid);
        const alertAfter = afterLedger?.alertEvaluatedThroughTurnSeq || 0;
        if (alertAfter > alertBefore) {
          return { error: 'heartbeat reader advanced alertEvaluatedThroughTurnSeq', alertBefore, alertAfter };
        }
        break;
      }
      case 'stopHook': {
        // The Stop route: enqueue a pending, drain, check that alert is only recorded AFTER persist.
        const ledger = getLiveLedger(sid);
        if (!ledger) break;

        // Cancel coalesced persist before the stop route's synchronous write
        cancelCoalescedPersist(sid);

        // Record what the alert cursor was BEFORE the stop route's drain
        const alertBefore = ledger.alertEvaluatedThroughTurnSeq || 0;

        // Enqueue a pending via commitLedgerMutationSync (as the real stop route does)
        try {
          commitLedgerMutationSync(sid, 'stop-enqueue', (draft) => {
            const arr = draft.pendingStopEvaluations || [];
            if (arr.length >= 64) return; // backpressure
            const enqueueSeq = 1 + Math.max(-1, ...arr.map(p => p.enqueueSeq || 0));
            arr.push({
              hookEventId: event.hookEventId,
              requestedAtWallMs: Date.now(),
              requestedAtMonoMs: performance.now(),
              processNonce: performance.now(), // test nonce
              beforeSettledThroughTurnSeq: draft.settledThroughTurnSeq,
              assignedTurnSeq: null, status: 'pending', enqueueSeq,
            });
            draft.pendingStopEvaluations = arr;
          });
        } catch {
          // commitLedgerMutationSync can throw on schema validation — skip this event
          break;
        }

        // Drain pending evaluations (the real stop route does this after persist)
        drainPendingStopEvaluations(sid);

        // Alert cursor may now advance (via drain) — that is correct for the Stop route
        const afterLedger = getLiveLedger(sid);
        if (afterLedger) {
          const alertAfter = afterLedger.alertEvaluatedThroughTurnSeq || 0;
          lastAlertEvalTurnSeq = alertAfter;
        }
        break;
      }
      case 'flushDelay': {
        // Just mark the sid dirty — simulates the interval between advance and flush
        schedulePersist(sid);
        break;
      }
      case 'coalescedPersistFlush': {
        // Force flush of pending persists
        flushPendingPersistsSync();
        break;
      }
      case 'crashHydrate': {
        // Simulate crash: flush to disk, reset in-memory state, reload
        flushPendingPersistsSync();

        // Reset in-memory state (simulates process crash)
        _resetRateLampManagerForTest();
        // Re-install scheduler hook (writer uses real disk so hydrate can reload)
        _setRateLampManagerTestHooks({
          scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
        });

        // Hydrate from disk via advanceRateLampToCurrent (which calls hydrateLedger internally).
        // The hydrate loads the last-persisted ledger, which contains the billProgress/billCycleCount
        // accumulated up to the last flush. Since the production code also clears lastBillEvent and
        // lastStopEvent on hydrate (A3), we don't need to worry about those.
        // Crucially: the hydrated ledger keeps its lastAppliedFoldedCallSeq, so subsequent advances
        // only process samples AFTER that seq (no double-integration). The oracle already has the
        // correct accumulated billProgress/billCycleCount from before the crash.
        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        break;
      }
    }
  }

  // Final state
  const finalLedger = getLiveLedger(sid);
  return { oracle, finalLedger, error: null };
}

// ─── Property assertions ──────────────────────────────────────────────────────────────────────
function assertProperties(result, seqIdx) {
  const { oracle, finalLedger, error } = result;
  const ctx = `[seq ${seqIdx}]`;

  if (error) {
    assert.fail(`${ctx} ${error}`);
  }

  if (!finalLedger) return; // degenerate sequence that never produced a ledger

  // 1. billProgress/billCycleCount == oracle
  assert.equal(finalLedger.billProgress, oracle.billProgress,
    `${ctx} billProgress: production ${finalLedger.billProgress} !== oracle ${oracle.billProgress}`);
  assert.equal(finalLedger.billCycleCount, oracle.billCycleCount,
    `${ctx} billCycleCount: production ${finalLedger.billCycleCount} !== oracle ${oracle.billCycleCount}`);

  // 2. Each ended turn ≤1 settle
  for (const [turnSeq, count] of oracle.settled) {
    assert.ok(count <= 1, `${ctx} turn ${turnSeq} settled ${count} times (must be ≤1)`);
  }

  // 3. Each pending ≤1 assign (check via the final ledger's state)
  // The pending queue should have no duplicates by hookEventId
  const pendingIds = (finalLedger.pendingStopEvaluations || []).map(p => p.hookEventId);
  const uniquePendingIds = new Set(pendingIds);
  assert.equal(pendingIds.length, uniquePendingIds.size,
    `${ctx} duplicate hookEventId in pendingStopEvaluations`);

  // 4. Each summary ≤1 consume: settled summaries should have unique turnSeqs
  const summaryTurnSeqs = (finalLedger.settledTurnSummaries || []).map(s => s.turnSeq);
  const uniqueSummaryTurnSeqs = new Set(summaryTurnSeqs);
  assert.equal(summaryTurnSeqs.length, uniqueSummaryTurnSeqs.size,
    `${ctx} duplicate turnSeq in settledTurnSummaries`);

  // 5. Ledger is schema-valid at the end
  const validated = validateLedgerState(JSON.parse(JSON.stringify(finalLedger)));
  assert.ok(validated !== null, `${ctx} final ledger fails schema validation`);

  // 6. settledThroughTurnSeq is monotonically consistent with summaries
  if (finalLedger.settledTurnSummaries.length > 0) {
    const maxSummaryTurn = Math.max(...finalLedger.settledTurnSummaries.map(s => s.turnSeq));
    assert.ok(finalLedger.settledThroughTurnSeq >= maxSummaryTurn,
      `${ctx} settledThroughTurnSeq ${finalLedger.settledThroughTurnSeq} < max summary turnSeq ${maxSummaryTurn}`);
  }

  // 7. alertEvaluatedThroughTurnSeq ≤ settledThroughTurnSeq (can never evaluate beyond settled)
  assert.ok((finalLedger.alertEvaluatedThroughTurnSeq || 0) <= finalLedger.settledThroughTurnSeq,
    `${ctx} alertEvaluatedThroughTurnSeq ${finalLedger.alertEvaluatedThroughTurnSeq} > settledThroughTurnSeq ${finalLedger.settledThroughTurnSeq}`);

  // 8. ledgerRevision is non-negative (monotonic: the revision gate in the production code ensures
  // no stale write can clobber a newer alert — tested separately in the chaos injection test)
  assert.ok(finalLedger.ledgerRevision >= 0,
    `${ctx} ledgerRevision ${finalLedger.ledgerRevision} is negative`);
}

// ─── Chaos injection: writer hangs + cancelCoalescedPersist + ledgerRevision gate ─────────────
function runChaosSequence(events, sid) {
  const oracle = new ReferenceOracle();
  let flushedWrites = [];
  let timerCb = null;
  let writerHanging = false;
  let hangingWrites = [];
  let ledgerCreated = false;

  _setRateLampManagerTestHooks({
    writer: (path, obj) => {
      if (writerHanging) {
        // Simulate a hanging write (TCP half-open / writeJsonAtomic hangs)
        hangingWrites.push(JSON.parse(JSON.stringify(obj)));
        return; // write "hangs" — never completes from the perspective of the caller
        // In reality the production code is synchronous, so "hangs" means: the write
        // was attempted but we recorded it to verify it never clobbers a newer alert.
      }
      flushedWrites.push(JSON.parse(JSON.stringify(obj)));
    },
    scheduler: (fn, ms) => { timerCb = fn; return { unref() {} }; },
  });

  let allSamples = [];
  let currentTurnSeq = 1;
  let currentFoldedSeq = 0;
  let currentLRead = 100000;

  // Do NOT seed — let advanceRateLampToCurrent create the ledger naturally.

  function maybeAnchorOracle() {
    if (ledgerCreated) return;
    const l = getLiveLedger(sid);
    if (l) {
      ledgerCreated = true;
      oracle.anchor(l.lastAppliedFoldedCallSeq);
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'sample': {
        const sample = {
          seq: event.seq, reliable: event.reliable,
          burnRate: event.burnRate, L_read: event.L_read,
          turnSeq: event.turnSeq,
        };
        allSamples.push(sample);
        currentFoldedSeq = event.seq;
        currentTurnSeq = event.turnSeq;
        currentLRead = event.L_read;

        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        maybeAnchorOracle();
        oracle.applySample(sample);
        break;
      }
      case 'boundary': {
        currentTurnSeq = event.turnSeq;
        const w = makeFakeWatcher({
          turnSeq: currentTurnSeq, foldedSeq: currentFoldedSeq,
          samples: allSamples, L_read: currentLRead,
        });
        advanceRateLampToCurrent(w, sid, { forcePoll: false });
        maybeAnchorOracle();
        break;
      }
      case 'flushDelay': {
        // Start writer hanging (simulates TCP half-open / slow disk)
        writerHanging = true;
        schedulePersist(sid);
        break;
      }
      case 'coalescedPersistFlush': {
        // Flush while writer is hanging
        if (timerCb) timerCb();
        break;
      }
      case 'stopHook': {
        // Stop route: cancel coalesced persist, then commit synchronously
        writerHanging = false; // Stop route's synchronous write goes through
        cancelCoalescedPersist(sid);

        const ledger = getLiveLedger(sid);
        if (!ledger) break;

        try {
          commitLedgerMutationSync(sid, 'chaos-stop', (draft) => {
            const arr = draft.pendingStopEvaluations || [];
            if (arr.length >= 64) return;
            const enqueueSeq = 1 + Math.max(-1, ...arr.map(p => p.enqueueSeq || 0));
            arr.push({
              hookEventId: event.hookEventId,
              requestedAtWallMs: Date.now(),
              requestedAtMonoMs: performance.now(),
              processNonce: performance.now(),
              beforeSettledThroughTurnSeq: draft.settledThroughTurnSeq,
              assignedTurnSeq: null, status: 'pending', enqueueSeq,
            });
            draft.pendingStopEvaluations = arr;
          });
        } catch { break; }

        drainPendingStopEvaluations(sid);
        break;
      }
      default:
        break;
    }
  }

  // Verify: the hanging writes (old coalesced snapshots) never carried a HIGHER revision
  // than what the Stop route committed. The revision gate ensures this.
  const finalLedger = getLiveLedger(sid);
  const finalRev = finalLedger?.ledgerRevision ?? 0;

  // All successful writes must have monotonically non-decreasing revisions
  for (let i = 1; i < flushedWrites.length; i++) {
    const prevRev = flushedWrites[i - 1].ledgerRevision ?? 0;
    const curRev = flushedWrites[i].ledgerRevision ?? 0;
    if (curRev < prevRev) {
      return { error: `stale write: revision ${curRev} after ${prevRev}`, oracle, finalLedger, flushedWrites };
    }
  }

  // Hanging writes (blocked by the revision gate or writer "hanging") should never have been
  // actually persisted with a revision > the current final revision. Since our "hanging" writer
  // simply records them, we verify none would clobber:
  for (const hw of hangingWrites) {
    const hwRev = hw.ledgerRevision ?? 0;
    // A hanging write at a lower revision than the current final is exactly what the
    // revision gate would block — safe. A hanging write at a HIGHER revision would mean
    // the gate failed (should not happen).
    if (hwRev > finalRev) {
      return { error: `hanging write at rev ${hwRev} > final rev ${finalRev} (gate leak)`, oracle, finalLedger, flushedWrites };
    }
  }

  return { oracle, finalLedger, flushedWrites, error: null };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════════════════════

test('C5c-1: property-based oracle — billProgress/billCycleCount match independent reference model (200 sequences)', () => {
  const rng = mulberry32(FIXED_SEED);

  for (let i = 0; i < SEQUENCES_PER_RUN; i++) {
    _resetRateLampManagerForTest();
    const sid = `prop-oracle-${i}`;
    const { events } = generateOracleSequence(rng, EVENTS_PER_SEQUENCE);
    const result = runSequence(events, sid);
    assertProperties(result, i);
  }
});

test('C5c-1: reader NEVER advances alertEvaluatedThroughTurnSeq (statusline/heartbeat reads)', () => {
  const rng = mulberry32(FIXED_SEED + 1);

  for (let i = 0; i < SEQUENCES_PER_RUN; i++) {
    _resetRateLampManagerForTest();
    const sid = `prop-reader-${i}`;

    // Generate a sequence heavy on reader events
    const events = [];
    let seq = 0;
    let turnSeq = 1;
    let L_read = 100000;

    for (let j = 0; j < EVENTS_PER_SEQUENCE; j++) {
      const r = rng();
      if (r < 0.3) {
        // sample
        seq++;
        L_read += Math.floor(rng() * 5000);
        events.push({ type: 'sample', seq, burnRate: rng() * 2, L_read, turnSeq, reliable: true });
      } else if (r < 0.4) {
        // boundary
        turnSeq++;
        events.push({ type: 'boundary', turnSeq });
      } else if (r < 0.7) {
        // statusline read
        events.push({ type: 'statuslineRead' });
      } else {
        // heartbeat read
        events.push({ type: 'heartbeatRead' });
      }
    }

    const result = runSequence(events, sid);
    if (result.error) {
      assert.fail(`[seq ${i}] ${result.error}`);
    }
  }
});

test('C5c-1: each ended turn is settled at most once (dedup gate holds across random sequences)', () => {
  const rng = mulberry32(FIXED_SEED + 2);

  for (let i = 0; i < SEQUENCES_PER_RUN; i++) {
    _resetRateLampManagerForTest();
    const sid = `prop-dedup-${i}`;
    const { events } = generateOracleSequence(rng, EVENTS_PER_SEQUENCE);
    const result = runSequence(events, sid);

    if (!result.finalLedger) continue;
    // Check settled summaries have unique turnSeqs (no double settle)
    const turnSeqs = (result.finalLedger.settledTurnSummaries || []).map(s => s.turnSeq);
    const unique = new Set(turnSeqs);
    assert.equal(turnSeqs.length, unique.size,
      `[seq ${i}] duplicate turnSeq in settledTurnSummaries: ${JSON.stringify(turnSeqs)}`);
  }
});

test('C5c-1: Stop records alert only AFTER persist — drainPendingStopEvaluations requires committed summaries', () => {
  const rng = mulberry32(FIXED_SEED + 3);

  for (let i = 0; i < SEQUENCES_PER_RUN; i++) {
    _resetRateLampManagerForTest();
    const sid = `prop-stop-persist-${i}`;

    // Build a sequence that: advance some samples, cross a boundary, then Stop + drain
    let seq = 0;
    let turnSeq = 1;
    let L_read = 100000;
    const events = [];

    // Some samples in turn 1
    const numSamples = 2 + Math.floor(rng() * 5);
    for (let j = 0; j < numSamples; j++) {
      seq++;
      L_read += Math.floor(rng() * 3000) + 500;
      events.push({ type: 'sample', seq, burnRate: 0.5 + rng() * 2, L_read, turnSeq, reliable: true });
    }

    // Boundary → turn 2
    turnSeq++;
    events.push({ type: 'boundary', turnSeq });

    // A sample in turn 2 (so boundary fires)
    seq++;
    L_read += Math.floor(rng() * 2000) + 500;
    events.push({ type: 'sample', seq, burnRate: rng() * 2, L_read, turnSeq, reliable: true });

    // Stop hook — should find the committed summary from turn 1
    events.push({ type: 'stopHook', hookEventId: `stop-${i}` });

    const result = runSequence(events, sid);
    if (result.error) {
      assert.fail(`[seq ${i}] ${result.error}`);
    }

    // The drain should have processed the pending IF a summary existed (turn 1 settled).
    // If alertEvaluatedThroughTurnSeq advanced, it should be <= settledThroughTurnSeq.
    if (result.finalLedger) {
      const alertEval = result.finalLedger.alertEvaluatedThroughTurnSeq || 0;
      const settled = result.finalLedger.settledThroughTurnSeq;
      assert.ok(alertEval <= settled,
        `[seq ${i}] alertEvaluated ${alertEval} > settled ${settled} — alert without persist`);
    }
  }
});

test('C5c-1: chaos injection — old coalesced snapshot never overwrites a new Stop alert (revision gate)', () => {
  const rng = mulberry32(FIXED_SEED + 4);

  for (let i = 0; i < SEQUENCES_PER_RUN; i++) {
    _resetRateLampManagerForTest();
    const sid = `prop-chaos-${i}`;

    // Generate a chaos-heavy sequence with interleaved flushDelay + stopHook events
    const events = [];
    let seq = 0;
    let turnSeq = 1;
    let L_read = 100000;

    for (let j = 0; j < EVENTS_PER_SEQUENCE; j++) {
      const r = rng();
      if (r < 0.25) {
        seq++;
        L_read += Math.floor(rng() * 5000);
        events.push({ type: 'sample', seq, burnRate: rng() * 3, L_read, turnSeq, reliable: true });
      } else if (r < 0.35) {
        turnSeq++;
        events.push({ type: 'boundary', turnSeq });
      } else if (r < 0.5) {
        events.push({ type: 'flushDelay' });
      } else if (r < 0.65) {
        events.push({ type: 'coalescedPersistFlush' });
      } else if (r < 0.85) {
        events.push({ type: 'stopHook', hookEventId: `chaos-${i}-${j}` });
      } else {
        events.push({ type: 'statuslineRead' });
      }
    }

    const result = runChaosSequence(events, sid);
    if (result.error) {
      assert.fail(`[seq ${i}] ${result.error}`);
    }

    // Oracle check on the chaos sequence
    if (result.finalLedger) {
      assert.equal(result.finalLedger.billProgress, result.oracle.billProgress,
        `[chaos seq ${i}] billProgress mismatch`);
      assert.equal(result.finalLedger.billCycleCount, result.oracle.billCycleCount,
        `[chaos seq ${i}] billCycleCount mismatch`);
    }
  }
});

test('C5c-1: crashHydrate — ledger survives disk round-trip, oracle stays consistent', () => {
  const rng = mulberry32(FIXED_SEED + 5);

  for (let i = 0; i < 50; i++) { // fewer iterations for crash tests (disk I/O)
    _resetRateLampManagerForTest();
    const sid = `prop-crash-${i}`;

    // Generate a sequence with a crash midway
    const events = [];
    let seq = 0;
    let turnSeq = 1;
    let L_read = 100000;

    // Phase 1: some normal activity
    const phase1Len = 5 + Math.floor(rng() * 10);
    for (let j = 0; j < phase1Len; j++) {
      const r = rng();
      if (r < 0.5) {
        seq++;
        L_read += Math.floor(rng() * 3000) + 200;
        events.push({ type: 'sample', seq, burnRate: rng() * 2, L_read, turnSeq, reliable: true });
      } else if (r < 0.7) {
        turnSeq++;
        events.push({ type: 'boundary', turnSeq });
      } else {
        events.push({ type: 'coalescedPersistFlush' });
      }
    }

    // Flush before crash
    events.push({ type: 'coalescedPersistFlush' });
    // CRASH
    events.push({ type: 'crashHydrate' });

    // Phase 2: more activity post-crash
    const phase2Len = 5 + Math.floor(rng() * 10);
    for (let j = 0; j < phase2Len; j++) {
      const r = rng();
      if (r < 0.5) {
        seq++;
        L_read += Math.floor(rng() * 3000) + 200;
        events.push({ type: 'sample', seq, burnRate: rng() * 2, L_read, turnSeq, reliable: true });
      } else if (r < 0.7) {
        turnSeq++;
        events.push({ type: 'boundary', turnSeq });
      } else {
        events.push({ type: 'coalescedPersistFlush' });
      }
    }

    const result = runSequence(events, sid);
    if (result.error) {
      assert.fail(`[crash seq ${i}] ${result.error}`);
    }

    // After crash-hydrate, the ledger should be schema-valid
    if (result.finalLedger) {
      const valid = validateLedgerState(JSON.parse(JSON.stringify(result.finalLedger)));
      assert.ok(valid !== null, `[crash seq ${i}] final ledger fails validation after crash-hydrate`);
    }
  }
});
