import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolate ledger + gate state writes to a temp CLAUDE_PLUGIN_DATA (read lazily per call by the stores,
// so setting it before importing the server is sufficient — mirrors server.notify-gate.test.js).
const TMP = mkdtempSync(join(tmpdir(), 'sw-stoproute-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

import { createServer } from '../server.js';
import { freshLedger, stateKeyOf } from '../lib/rate-lamp-store.js';
import { setLiveLedger, getLiveLedger, _resetRateLampManagerForTest, drainPendingStopEvaluations, commitLedgerMutationSync } from '../lib/rate-lamp-manager.js';
import { loadGateState, saveGateState } from '../lib/gate-store.js';
import { PENDING_STOP_EVALUATIONS_LIMIT } from '../lib/constants.js';

// The Stop route computes the state key from getStatus fields; the seeded ledger must carry the SAME key.
// These fixed baseline params make landmarks(cRatio=10, kAvg=940, total=55000, dead=30000, L) land the
// gate at a known tier (xStar≈2.169, dhat≈0.585 → tier2 at L≥~151.5k). L_read drives the ledger axis.
const FP = 'd30000|t25000|k6|T';
const KEY = stateKeyOf({ segmentId: 0, model: 'claude-opus-4-8', cRatio: 10,
  baselineFingerprint: FP, contextCap: 960000, schemaVersion: 1 });

// A deterministic stub watcher with a FULL reliable rateLamp bundle (the gate-only stub in
// server.notify-gate.test.js is too thin for the settle path). L_read / burnRate / inDeepWater / the
// segment folded/turn counters are directly controllable so each truth-table row is reachable.
function stopWatcher(o = {}) {
  const {
    L = 160000, reliable = true, turnSeq = 1, foldedSeq = 5,
    L_read = 300000, burnRate = 0.3, inDeepWater = false,
    segmentCalls = [], gateL = 160000,
  } = o;
  return {
    _turnSeq: turnSeq, _foldedCallSeq: foldedSeq, _seg: segmentCalls,
    poll() { return { changed: false, newCalls: 0 }; },
    _currentSegmentCalls() { return this._seg; },
    // These fixtures test SETTLEMENT of an already-pending bill, not fresh per-call integration, and the
    // watcher's foldedSeq never exceeds the ledger's lastApplied here — so the drain window is empty. The
    // real builders are unit-tested in Task 3; a stub returning [] keeps advanceRateLampToCurrent's drain a no-op.
    rateLampSamplesSince() { return []; },
    rateLampSeqSamplesSince() { return []; },
    getStatus() {
      if (!reliable) {
        return { segment: 0, model: 'claude-opus-4-8', kAvg: 940, L: gateL,
          baseline: { total: 55000, dead: 30000, fingerprint: FP },
          rateLamp: { reliable: false, unavailableReason: 'insufficient_data' } };
      }
      return {
        segment: 0, model: 'claude-opus-4-8', kAvg: 940, L: gateL,
        baseline: { total: 55000, dead: 30000, fingerprint: FP },
        rateLamp: {
          reliable: true, C_RATIO: 10, L_cap: 960000, kStable: 940,
          B_post: 55000, B_rebuild: 55000,
          L_read, burnRate, inDeepWater,
          hBreak: burnRate > 0 ? 1 / burnRate : Infinity,
          xExit: 2.169, L_exit_fullCarry: 2.169 * 55000,
        },
      };
    },
  };
}

async function withServer({ sessionId, watcher }, fn) {
  _resetRateLampManagerForTest();
  const srv = createServer({ watcher, pollIntervalMs: 0, sessionId });
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const addr = srv.server.address();
  try { await fn({ port: addr.port, srv }); }
  finally { srv.stopTimers(); await new Promise(r => srv.server.close(r)); }
}
const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/notify-gate`,
  body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
       : { method: 'POST' }).then(r => r.json());
const postRaw = (port, body) => fetch(`http://127.0.0.1:${port}/api/notify-gate`,
  body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
       : { method: 'POST' });
const line = (port) => fetch(`http://127.0.0.1:${port}/api/status?fmt=line`).then(r => r.text());

// Seed a matching-key in-memory ledger with one pending bill and a positive anchor delta so a settle fires.
function seedLedger(sessionId, over = {}) {
  const led = { ...freshLedger(KEY, 940),
    lastAppliedFoldedCallSeq: 5, billAnchorLRead: 250000, billAnchorFoldedCallSeq: 1,
    pendingBillCountSinceBoundary: 1, currentTurnSeq: 1, ...over };
  setLiveLedger(sessionId, led);
  return led;
}

// (e) PRIMARY behavioral single-handler assertion (H-A rewrite): the POST returns the unified shape
// (ok/kind/delivery/bill/gate) and exactly one POST route exists. Under H-A the Stop settles NOTHING
// inline — empty_burn is deferred to the reader's boundary settle. The handler's structure is proven by
// the gate/tier sub-objects and the bill:null invariant.
test('(e) POST returns the unified H-A contract (ok/bill:null/gate) — exactly one handler', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250500, burnRate: 0.3, inDeepWater: true, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port, srv }) => {
    seedLedger(sid);
    const r = await post(port);
    assert.ok('bill' in r && 'kind' in r && 'delivery' in r, 'unified contract present');
    assert.equal(r.bill, null, 'H-A: Stop settles NOTHING — bill is always null');
    assert.equal(r.ok, true, 'request accepted');
    assert.ok('gate' in r, 'gate sub-object present');
    // AUXILIARY: exactly one POST layer for the path.
    const posts = srv.app._router.stack.filter(l => l.route && l.route.path === '/api/notify-gate'
      && l.route.methods && l.route.methods.post);
    assert.equal(posts.length, 1, 'exactly one POST /api/notify-gate handler registered');
  });
});

// (a) H-A: deep-water empty_burn does NOT fire inline — deferred to reader's authoritative settle.
// Under H-A the Stop unconditionally pends and lets drain resolve off the reader's summary at N+1.
test('(a) H-A: deep-water empty_burn does NOT fire inline — deferred (unconditional pend)', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250500, inDeepWater: true, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid);
    const r = await post(port);
    assert.equal(r.bill, null, 'H-A: no settlement, no bill');
    assert.equal(r.notify, false, 'empty_burn never fires inline');
    const led = getLiveLedger(sid);
    assert.equal(led.pendingStopEvaluations.length, 1, 'pending enqueued unconditionally');
  });
});

// (b) H-A: a gate fire resolves inline as stop_hook (gate is a live-quantity signal).
test('(b) H-A: gate fire resolves inline as stop_hook (live-quantity signal)', async () => {
  const sid = `sr-${randomUUID()}`;
  // gateL in tier2 range (≥151.5k) so the gate fires this turn.
  const w = stopWatcher({ L_read: 250500, inDeepWater: true, gateL: 160000, burnRate: 0.3 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { pendingBillCountSinceBoundary: 0 });
    const r = await post(port);
    assert.equal(r.kind, 'gate', 'gate fire resolves inline');
    assert.equal(r.notify, true, 'gate is a stop_hook alert');
    assert.equal(r.gate.notify, true, 'gate sub-object shows notify');
    assert.equal(r.bill, null, 'H-A: no settlement, bill always null');
  });
});

// (c) reliable=false → no settlement, no crash; under H-A still no bill.
test('(c) unreliable snapshot → no settlement, no bill, no stop alert', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ reliable: false });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    const r = await post(port);
    assert.equal(r.bill, null, 'no settlement on an unreliable frame');
    assert.equal(r.notify, false, 'no stop alert');
    assert.equal(r.kind, null);
    assert.equal(r.ok, true);
  });
});

// (d) a floor-step turn downgrades a WALL to a statusline pulse (A4 end-to-end).
test('(d) WALL (burnRate≥1) + a floor stock-step → downgraded to non_idle statusline (not stop_hook)', async () => {
  const sid = `sr-${randomUUID()}`;
  // burnRate≥1 would be a WALL, but a stock-step over the window suppresses it. Build a segment whose
  // total stock (cacheRead+cacheCreation) jumps by ≥ kStable(940) across the window since the anchor.
  const seg = [
    { foldedSeq: 2, cacheRead: 100000, cacheCreation: 2000 },
    { foldedSeq: 6, cacheRead: 140000, cacheCreation: 2000 }, // +40k step >> 940
  ];
  const w = stopWatcher({ L_read: 250500, burnRate: 1.2, inDeepWater: true, gateL: 100000, segmentCalls: seg, foldedSeq: 6 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { billAnchorFoldedCallSeq: 1, lastAppliedFoldedCallSeq: 6, pendingBillCountSinceBoundary: 0 });
    const r = await post(port);
    assert.equal(r.kind, 'non_idle_burn', 'stock-step suppressed the WALL to non_idle');
    assert.equal(r.delivery, 'statusline_pulse', 'downgraded off stop_hook');
    assert.equal(r.notify, false, 'not a prominent alert this turn');
  });
});

// (f) stale-key ledger → no settle / no pending-clear / no bill (final-review GPT#8).
test('(f) stale-key in-memory ledger → route does not settle it', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250500, inDeepWater: true, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    // Seed a ledger under a DIFFERENT (old-segment) key — the current key won't match it.
    const stale = { ...freshLedger('k-OLD-SEGMENT', 940), lastAppliedFoldedCallSeq: 5,
      billAnchorLRead: 250000, pendingBillCountSinceBoundary: 1, currentTurnSeq: 1 };
    setLiveLedger(sid, stale);
    const r = await post(port);
    // The manager resets a stale-key ledger to a fresh matching-key one anchored at the current seq
    // (no pending bills), so no settlement occurs and no bill is produced this turn.
    assert.equal(r.bill, null, 'a stale-key ledger is not settled');
  });
});

// (g) lastStopEvent surfaced this turn, gone next turn (TTL) — final-review GPT#2.
test('(g) a wall/gate POST surfaces lastStopEvent on GET /api/status this turn, not next (TTL)', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250500, burnRate: 1.2, inDeepWater: true, gateL: 100000 }); // WALL
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { pendingBillCountSinceBoundary: 0 }); // WALL is instantaneous; no bill needed
    const r = await post(port);
    assert.equal(r.kind, 'wall');
    assert.equal(r.delivery, 'stop_hook');
    const l1 = await line(port);
    assert.match(l1, /Rate wall:/, 'the WALL alert text surfaces on the statusline THIS turn (distinctive marker)');
    // Advance the turn on the watcher; the stale lastStopEvent (turnSeq=1) must no longer render (TTL).
    w._turnSeq = 2;
    const led = getLiveLedger(sid);
    setLiveLedger(sid, { ...led, currentTurnSeq: 2 });
    const l2 = await line(port);
    assert.doesNotMatch(l2, /Rate wall:/, 'the stale WALL alert does not keep flashing next turn (TTL expiry)');
  });
});

// (h) R5 GPT#1 — a PAUSED matching-key ledger still delivers a gate/WALL alert (pause blocks settlement, not delivery).
test('(h) paused ledger + WALL → no settlement (pending unchanged, no bill) but lastStopEvent recorded', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250500, burnRate: 1.2, inDeepWater: true, gateL: 100000 }); // WALL
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { pausedReason: 'folded_seq_gap', pendingBillCountSinceBoundary: 1 });
    const r = await post(port);
    assert.equal(r.bill, null, 'a paused ledger is NOT settled');
    assert.equal(getLiveLedger(sid).pendingBillCountSinceBoundary, 1, 'pending count unchanged (no settle)');
    assert.equal(r.kind, 'wall', 'the WALL alert still resolves');
    assert.equal(r.notify, true);
    const l1 = await line(port);
    assert.match(l1, /Rate wall:/, 'the WALL alert reaches the UI despite the pause (distinctive marker)');
  });
});

// (i) root-level tier AND gate.tier both present and equal (round-6 gemini#2 backward-compat).
test('(i) gate-fire POST carries both root `tier` and `gate.tier`, equal', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250000, burnRate: 0.3, inDeepWater: false, gateL: 160000 }); // tier2 gate, no bill
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { pendingBillCountSinceBoundary: 0, billAnchorLRead: 250000 });
    const r = await post(port);
    assert.equal(typeof r.tier, 'number', 'root tier present (Task-5 flat contract preserved)');
    assert.equal(r.tier, r.gate.tier, 'root tier equals gate.tier');
    assert.equal(r.gate.tier, 2, 'tier2 gate fired');
  });
});

// (j) persist-before-gate-commit (round-8 GPT#4): a ledger-persist failure → 500 AND gate NOT ratcheted.
// This test uses its OWN CLAUDE_PLUGIN_DATA so it can BLOCK the rate-lamp-state dir (place a FILE where the
// store needs a directory → writeJsonAtomic's mkdirSync throws ENOTDIR) while leaving the gate-state dir
// writable. If the gate ratchet were committed BEFORE the ledger persist, the gate file would show
// maxTierFired=2 even though the ledger throw returned 500 — a silently-consumed alert. The ordering
// (setLiveLedger first, saveGateState last) means the throw happens BEFORE saveGateState → gate un-ratcheted.
test('(j) ledger persist failure → 500 AND the gate ratchet is NOT advanced (alert re-fires, not lost)', async () => {
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  const jTmp = mkdtempSync(join(tmpdir(), 'sw-jfail-'));
  process.env.CLAUDE_PLUGIN_DATA = jTmp;
  try {
    // Block the rate-lamp-state directory: a regular FILE at that path makes mkdirSync(recursive) throw
    // ENOTDIR when saveRateLampState tries to create <jTmp>/rate-lamp-state/<sid>.json.
    writeFileSync(join(jTmp, 'rate-lamp-state'), 'not a dir');
    const sid = `sr-${randomUUID()}`;
    const w = stopWatcher({ L_read: 250500, burnRate: 1.2, inDeepWater: true, gateL: 160000 }); // WALL + tier2 gate
    await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
      // No seedLedger: advanceRateLampToCurrent itself checkpoints the (fresh) ledger via saveRateLampState,
      // which throws at the blocked dir — BEFORE the handler's saveGateState. That proves the ordering.
      const res = await fetch(`http://127.0.0.1:${port}/api/notify-gate`, { method: 'POST' });
      assert.equal(res.status, 500, 'a ledger-persist throw becomes HTTP 500 (error boundary), not a crash');
      // The gate ratchet must NOT have been committed — saveGateState runs only AFTER the ledger persist,
      // which threw. So the gate re-fires next turn (visible duplicate) rather than being consumed silently.
      assert.equal(loadGateState(sid), null, 'gate ratchet NOT advanced: no gate file written before the ledger throw');
    });
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = prevEnv;
    rmSync(jTmp, { recursive: true, force: true });
  }
});

// ─── v2.2-C3 H-A tests ───────────────────────────────────────────────────────

// (k) Every Stop enqueues a pending for the open turn (H-A)
test('(k) H-A: every Stop unconditionally enqueues a pending keyed on settledThroughTurnSeq', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { settledThroughTurnSeq: 5, currentTurnSeq: 6, pendingBillCountSinceBoundary: 0 });
    await post(port, { hook_event_id: 'ev-k1' });
    const led = getLiveLedger(sid);
    assert.equal(led.pendingStopEvaluations.length, 1, 'exactly one pending enqueued');
    assert.equal(led.pendingStopEvaluations[0].beforeSettledThroughTurnSeq, 5, 'keyed on settledThroughTurnSeq');
    assert.equal(led.pendingStopEvaluations[0].hookEventId, 'ev-k1');
  });
});

// (l) Inline stop_hook resolves from LIVE quantities, settles nothing (H-A)
test('(l) H-A: WALL resolves inline from live burnRate, no settlement occurs', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 1.2, gateL: 100000 }); // WALL
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 1 });
    const before = getLiveLedger(sid);
    const r = await post(port, { hook_event_id: 'ev-l1' });
    assert.equal(r.notify, true, 'WALL fires inline');
    assert.equal(r.kind, 'wall');
    assert.equal(r.bill, null, 'H-A: Stop settles NOTHING — no bill');
    const after = getLiveLedger(sid);
    // Settlement cursors unchanged
    assert.equal(after.settledThroughTurnSeq, before.settledThroughTurnSeq, 'settledThroughTurnSeq unchanged by Stop');
    assert.equal(after.settledTurnSummaries.length, before.settledTurnSummaries.length, 'no new summary committed by Stop');
    // Pending was still enqueued
    assert.equal(after.pendingStopEvaluations.length, 1, 'pending enqueued despite inline fire');
  });
});

// (m) empty_burn / non_idle / cache_unstable NEVER inline
test('(m) H-A: low deltaW + sub-wall + sub-dw → no stop_hook this POST (empty_burn never inline)', async () => {
  const sid = `sr-${randomUUID()}`;
  // burnRate < 1, dwTurn < DW_TURN_BACKSTOP (2), no gate fire → no inline stop_hook
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000, L_read: 250500, inDeepWater: true });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { currentTurnDeltaW: 0.5, settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 0 });
    const r = await post(port, { hook_event_id: 'ev-m1' });
    assert.equal(r.notify, false, 'no stop_hook fires inline');
    assert.equal(r.kind, null);
    // But pending was still enqueued (unconditional)
    const led = getLiveLedger(sid);
    assert.equal(led.pendingStopEvaluations.length, 1, 'pending enqueued unconditionally');
  });
});

// (n) Repeated POST (same hook_event_id) → dedup, only ONE pending
test('(n) H-A: repeated POST with same hook_event_id is deduped', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 0 });
    await post(port, { hook_event_id: 'ev-n1' });
    await post(port, { hook_event_id: 'ev-n1' }); // duplicate
    const led = getLiveLedger(sid);
    assert.equal(led.pendingStopEvaluations.length, 1, 'only ONE pending from repeated POST');
    assert.ok(led.recentProcessedHookEventIds.includes('ev-n1'), 'id is in processed ring');
  });
});

// (o) reader never touches pending / alertEvaluatedThroughTurnSeq
test('(o) H-A: reader advance leaves pendingStopEvaluations and alertEvaluatedThroughTurnSeq unchanged', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    const led = { ...freshLedger(KEY, 940),
      lastAppliedFoldedCallSeq: 5, currentTurnSeq: 4, settledThroughTurnSeq: 3,
      alertEvaluatedThroughTurnSeq: 2,
      pendingStopEvaluations: [{ hookEventId: 'test-pend', beforeSettledThroughTurnSeq: 3,
        requestedAtWallMs: 1000, enqueueSeq: 0, assignedTurnSeq: null, status: 'pending' }],
    };
    setLiveLedger(sid, led);
    // Trigger a reader advance via GET /api/status (calls advanceRateLampToCurrent internally)
    await fetch(`http://127.0.0.1:${port}/api/status`);
    const after = getLiveLedger(sid);
    assert.equal(after.pendingStopEvaluations.length, 1, 'pending unchanged by reader');
    assert.equal(after.alertEvaluatedThroughTurnSeq, 2, 'alertEvaluatedThroughTurnSeq unchanged by reader');
  });
});

// (p) pending backpressure (B7)
test('(p) H-A: pending backpressure returns 503, id NOT accepted, self-heals after drain', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    // Fill to limit
    const full = [];
    for (let i = 0; i < PENDING_STOP_EVALUATIONS_LIMIT; i++) {
      full.push({ hookEventId: `fill-${i}`, beforeSettledThroughTurnSeq: 0,
        requestedAtWallMs: Date.now(), requestedAtMonoMs: performance.now(),
        enqueueSeq: i, assignedTurnSeq: null, status: 'pending' });
    }
    seedLedger(sid, { settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 0,
      pendingStopEvaluations: full });
    const res = await postRaw(port, { hook_event_id: 'ev-overflow' });
    assert.equal(res.status, 503, 'backpressure returns 503');
    const body = await res.json();
    assert.equal(body.degraded, 'pending_backpressure');
    const led = getLiveLedger(sid);
    assert.ok(!led.recentProcessedHookEventIds.includes('ev-overflow'), 'id NOT accepted on 503');
    assert.equal(led.pendingStopEvaluations.length, PENDING_STOP_EVALUATIONS_LIMIT, 'no eviction of oldest');
  });
});

// (q) expired-pending removal — no false-full deadlock (tombstone-free)
test('(q) H-A: expired pendings are spliced out by drain → queue self-heals, no deadlock', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    // Fill with pendings ALL past TTL (wallMs far in the past, different processNonce)
    const full = [];
    for (let i = 0; i < PENDING_STOP_EVALUATIONS_LIMIT; i++) {
      full.push({ hookEventId: `old-${i}`, beforeSettledThroughTurnSeq: 0,
        requestedAtWallMs: 1000, requestedAtMonoMs: 1000,  // far in the past
        processNonce: -999,  // different from current process
        enqueueSeq: i, assignedTurnSeq: null, status: 'pending' });
    }
    seedLedger(sid, { settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 0,
      pendingStopEvaluations: full });
    // The next Stop triggers drain which expires all stale pendings
    const res = await postRaw(port, { hook_event_id: 'ev-after-drain' });
    assert.equal(res.status, 200, 'after drain of expired entries, new Stop is ACCEPTED');
    const led = getLiveLedger(sid);
    // The expired entries were removed; only the new pending from THIS Stop remains
    assert.equal(led.pendingStopEvaluations.length, 1, 'queue drained to 1 (only the new pending)');
    assert.ok(led.recentProcessedHookEventIds.includes('ev-after-drain'), 'id accepted post-drain');
    // Verify only 'pending' status entries remain
    for (const p of led.pendingStopEvaluations) {
      assert.equal(p.status, 'pending', 'only status:pending entries in the array');
    }
  });
});

// (r) hook-gap: reader settles N..N+3 with no Stop → first Stop marks historical as skipped
test('(r) H-A: hook-gap — historical summaries with no pending are marked skipped, alertEvaluatedThroughTurnSeq advanced', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    // Reader already settled turns 1..4, but no Stop arrived for them
    const summaries = [1, 2, 3, 4].map(t => ({
      turnSeq: t, foldedCallSeqStart: t - 1, foldedCallSeqEnd: t, deltaW: 100,
      billCycleCountIncrement: 1, billKindAtBoundary: 'non_idle_burn', inDeepWaterAtBoundary: false,
      billProgressBefore: 0, billProgressAfter: 0, hBreakAtBoundary: null,
    }));
    seedLedger(sid, { settledThroughTurnSeq: 4, currentTurnSeq: 5, pendingBillCountSinceBoundary: 0,
      settledTurnSummaries: summaries, alertEvaluatedThroughTurnSeq: 0 });
    await post(port, { hook_event_id: 'ev-r1' });
    const led = getLiveLedger(sid);
    // chooseCurrentStopSummary should have advanced alertEvaluatedThroughTurnSeq to cover the orphans
    assert.ok(led.alertEvaluatedThroughTurnSeq >= 4, 'alertEvaluatedThroughTurnSeq advanced past historical summaries');
    // The pending for the current Stop is present
    assert.equal(led.pendingStopEvaluations.length, 1);
  });
});

// (s) deferred-drain faithfulness: resolved kind matches BOUNDARY snapshot, not live values
test('(s) H-A: deferred drain resolves from boundary snapshot (billKindAtBoundary), not live values', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    // A summary with billKindAtBoundary='empty_burn' + inDeepWater=true → resolves to stop_hook
    const summaries = [{ turnSeq: 4, foldedCallSeqStart: 3, foldedCallSeqEnd: 5, deltaW: 50,
      billCycleCountIncrement: 1, billKindAtBoundary: 'empty_burn', inDeepWaterAtBoundary: true,
      billProgressBefore: 0, billProgressAfter: 0, hBreakAtBoundary: null }];
    // A pending for turn 4
    const pend = [{ hookEventId: 'ev-drain-s', beforeSettledThroughTurnSeq: 3,
      requestedAtWallMs: Date.now(), requestedAtMonoMs: performance.now(),
      enqueueSeq: 0, assignedTurnSeq: null, status: 'pending' }];
    seedLedger(sid, { settledThroughTurnSeq: 4, currentTurnSeq: 5, pendingBillCountSinceBoundary: 0,
      settledTurnSummaries: summaries, pendingStopEvaluations: pend, alertEvaluatedThroughTurnSeq: 3,
      // Live values differ — burnRate is high (would be WALL inline), but drain uses the snapshot
      kStableFrozen: 940 });
    // The Stop triggers drain which matches the pending to summary turnSeq=4
    await post(port, { hook_event_id: 'ev-s-current' });
    const led = getLiveLedger(sid);
    // The drain resolved the old pending's boundary as empty_burn (deep water → stop_hook)
    assert.ok(led.lastStopEvent, 'lastStopEvent recorded from drain');
    assert.equal(led.lastStopEvent.kind, 'empty_burn', 'kind from BOUNDARY snapshot, not live');
    assert.equal(led.alertEvaluatedThroughTurnSeq, 4, 'alert cursor advanced to the matched summary');
  });
});

// ─── C3-2 Fix Round 1: spec-mandated missing tests ──────────────────────────────

// (t) Same-turn inline + deferred = TWO stop_hooks (round-9 GPT-pt7)
// Turn N's Stop fires an INLINE wall (burnRate≥1) AND unconditionally enqueues a pending.
// Then a reader settles turn N with billKindAtBoundary='empty_burn'. The NEXT Stop's drain
// matches that pending and fires a deferred empty_burn stop_hook. Both fire; the pending is NOT
// skipped by the pushed-up alertEvaluatedThroughTurnSeq and NOT marked skipped_no_stop_event.
test('(t) same-turn inline WALL + deferred empty_burn = TWO stop_hooks (round-9 GPT-pt7)', async () => {
  const sid = `sr-${randomUUID()}`;
  // burnRate≥1 → WALL fires inline on the first Stop
  const w = stopWatcher({ burnRate: 1.2, gateL: 100000, L_read: 250500, inDeepWater: true });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid, { settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 0, kStableFrozen: 940 });

    // First Stop (turn 4): inline WALL fires + pending enqueued
    const r1 = await post(port, { hook_event_id: 'ev-t1' });
    assert.equal(r1.notify, true, 'inline WALL fires');
    assert.equal(r1.kind, 'wall', 'WALL inline');
    const led1 = getLiveLedger(sid);
    assert.equal(led1.pendingStopEvaluations.length, 1, 'pending enqueued alongside inline WALL');
    // alertEvaluatedThroughTurnSeq was pushed up by the inline path
    assert.ok(led1.alertEvaluatedThroughTurnSeq >= 4, 'alertEvaluatedThroughTurnSeq pushed by inline');

    // Simulate the reader settling turn 4 with empty_burn + inDeepWater=true (AFTER the Stop enqueued)
    // The pending's watermark is settledThroughTurnSeq=3, so it targets summary turnSeq=4.
    const summary4 = { turnSeq: 4, foldedCallSeqStart: 3, foldedCallSeqEnd: 5, deltaW: 50,
      billCycleCountIncrement: 1, billKindAtBoundary: 'empty_burn', inDeepWaterAtBoundary: true,
      billProgressBefore: 0, billProgressAfter: 0, hBreakAtBoundary: null };
    // Inject the settled summary as the reader would (settledThroughTurnSeq moves to 4)
    const led2 = getLiveLedger(sid);
    setLiveLedger(sid, { ...led2, settledThroughTurnSeq: 4, settledTurnSummaries: [...(led2.settledTurnSummaries || []), summary4] });

    // Advance watcher to turn 5 for the next Stop
    w._turnSeq = 5;
    const led3 = getLiveLedger(sid);
    setLiveLedger(sid, { ...led3, currentTurnSeq: 5 });

    // Second Stop (turn 5): drain matches the pending to summary 4 → deferred empty_burn fires
    const r2 = await post(port, { hook_event_id: 'ev-t2' });
    const led4 = getLiveLedger(sid);
    // The deferred empty_burn from drain should have fired (lastStopEvent shows it)
    assert.ok(led4.lastStopEvent, 'lastStopEvent present after drain');
    // The deferred one could be empty_burn OR the current inline (WALL for turn 5). Check recentStopEvents.
    const recentKinds = (led4.recentStopEvents || []).map(e => e.kind);
    assert.ok(recentKinds.includes('wall'), 'WALL from inline recorded');
    assert.ok(recentKinds.includes('empty_burn'), 'deferred empty_burn from drain recorded');
    // The pending for turn 4 was NOT skipped: it was matched and resolved, not left as skipped_no_stop_event
    // (the old pending from ev-t1 should be gone — consumed by drain)
    const remainingFromT1 = (led4.pendingStopEvaluations || []).filter(p => p.hookEventId === 'ev-t1');
    assert.equal(remainingFromT1.length, 0, 'ev-t1 pending consumed by drain, not stuck');
  });
});

// (u) A12: persist failure leaves hookEventId NOT accepted → retry succeeds (not short-circuited)
test('(u) A12: persist failure → 503 persist_failed; hookEventId NOT accepted; retry processes', async () => {
  const prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  const uTmp = mkdtempSync(join(tmpdir(), 'sw-u-a12-'));
  process.env.CLAUDE_PLUGIN_DATA = uTmp;
  try {
    const sid = `sr-${randomUUID()}`;
    const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });

    await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
      // Seed a valid ledger first (in a writable state so manager advance succeeds)
      seedLedger(sid, { settledThroughTurnSeq: 3, currentTurnSeq: 4, pendingBillCountSinceBoundary: 0 });

      // NOW block the rate-lamp-state directory: remove the directory that seedLedger created,
      // then place a regular FILE at that path so mkdirSync(recursive) throws ENOTDIR when
      // commitLedgerMutationSync → persistLedger → saveRateLampState tries to write the ledger.
      rmSync(join(uTmp, 'rate-lamp-state'), { recursive: true, force: true });
      writeFileSync(join(uTmp, 'rate-lamp-state'), 'not a dir');

      // Attempt a Stop — persist should fail
      const res1 = await postRaw(port, { hook_event_id: 'ev-u-fail' });
      assert.equal(res1.status, 503, 'persist failure returns 503');
      const body1 = await res1.json();
      assert.equal(body1.degraded, 'persist_failed', 'degraded reason is persist_failed');

      // The hookEventId must NOT be in the live ledger's processedIds (A12: mutation never-happened)
      const led = getLiveLedger(sid);
      assert.ok(!led.recentProcessedHookEventIds.includes('ev-u-fail'),
        'hookEventId NOT accepted on persist failure');
      assert.equal(led.pendingStopEvaluations.length, 0,
        'no pending was added (mutation rolled back)');

      // Unblock: remove the blocking file so persist works again
      const { unlinkSync: unlink } = await import('node:fs');
      unlink(join(uTmp, 'rate-lamp-state'));

      // Retry with the SAME hookEventId — should process (not short-circuited by alreadyAccepted)
      const res2 = await postRaw(port, { hook_event_id: 'ev-u-fail' });
      assert.equal(res2.status, 200, 'retry succeeds after persist recovers');
      const body2 = await res2.json();
      assert.equal(body2.ok, true, 'retry accepted');
      const led2 = getLiveLedger(sid);
      assert.ok(led2.recentProcessedHookEventIds.includes('ev-u-fail'),
        'hookEventId accepted on retry');
      assert.equal(led2.pendingStopEvaluations.length, 1,
        'pending enqueued on retry');
    });
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = prevEnv;
    rmSync(uTmp, { recursive: true, force: true });
  }
});

// (v) B3: cache_unstable never re-thresholded — negative deltaW resolves as cache_unstable, NOT empty_burn
test('(v) B3: cache_unstable boundary (negative deltaW) resolves as cache_unstable, never re-thresholded to empty_burn', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ burnRate: 0.3, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    // A summary with deltaL<0 → billKindAtBoundary='cache_unstable' and a NEGATIVE deltaW.
    // If the drain naively re-thresholded deltaW < kStable, it would falsely classify as empty_burn.
    const summaries = [{ turnSeq: 4, foldedCallSeqStart: 3, foldedCallSeqEnd: 5, deltaW: -500,
      billCycleCountIncrement: 1, billKindAtBoundary: 'cache_unstable', inDeepWaterAtBoundary: true,
      billProgressBefore: 0.3, billProgressAfter: 0.3, hBreakAtBoundary: 3.33 }];
    // A pending for turn 4
    const pend = [{ hookEventId: 'ev-v-cache', beforeSettledThroughTurnSeq: 3,
      requestedAtWallMs: Date.now(), requestedAtMonoMs: performance.now(),
      enqueueSeq: 0, assignedTurnSeq: null, status: 'pending' }];
    seedLedger(sid, { settledThroughTurnSeq: 4, currentTurnSeq: 5, pendingBillCountSinceBoundary: 0,
      settledTurnSummaries: summaries, pendingStopEvaluations: pend, alertEvaluatedThroughTurnSeq: 3,
      kStableFrozen: 940 });

    // The Stop triggers drain which matches the pending to the cache_unstable summary
    await post(port, { hook_event_id: 'ev-v-current' });
    const led = getLiveLedger(sid);
    // The drain should resolve as cache_unstable (neutral statusline_pulse), NOT empty_burn
    assert.equal(led.alertEvaluatedThroughTurnSeq, 4, 'alert cursor advanced to matched summary');
    // cache_unstable resolves to delivery='statusline_pulse' → NOT stop_hook → no lastStopEvent from it
    // The lastStopEvent should NOT show an empty_burn — if it did, that would mean re-thresholding happened
    const recentStops = led.recentStopEvents || [];
    const emptyBurns = recentStops.filter(e => e.kind === 'empty_burn' && e.turnSeq === 4);
    assert.equal(emptyBurns.length, 0, 'no empty_burn from re-thresholding negative deltaW');
    // Also confirm the validator accepted the negative-deltaW summary (the ledger is still valid)
    assert.ok(led.settledTurnSummaries.some(s => s.deltaW === -500), 'negative deltaW summary preserved in ring');
  });
});
