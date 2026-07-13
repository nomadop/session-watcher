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
import { setLiveLedger, getLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { loadGateState, saveGateState } from '../lib/gate-store.js';

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
const line = (port) => fetch(`http://127.0.0.1:${port}/api/status?fmt=line`).then(r => r.text());

// Seed a matching-key in-memory ledger with one pending bill and a positive anchor delta so a settle fires.
function seedLedger(sessionId, over = {}) {
  const led = { ...freshLedger(KEY, 940),
    lastAppliedFoldedCallSeq: 5, billAnchorLRead: 250000, billAnchorFoldedCallSeq: 1,
    pendingBillCountSinceBoundary: 1, currentTurnSeq: 1, ...over };
  setLiveLedger(sessionId, led);
  return led;
}

// (e) PRIMARY behavioral single-handler assertion: a POST that settles a pending bill returns the UNIFIED
// shape (bill / kind / delivery). The Task-5 gate-only handler returned only { notify, tier, message } →
// no `bill` field, so this proves the full handler is the one Express dispatches (not a dead second route).
test('(e) POST returns the unified settle contract (bill/kind/delivery) — full handler is live', async () => {
  const sid = `sr-${randomUUID()}`;
  // deep-water empty_burn: L_read barely above the anchor (deltaL < kStable 940) → empty_burn; inDeepWater → stop_hook.
  const w = stopWatcher({ L_read: 250500, burnRate: 0.3, inDeepWater: true, gateL: 100000 /* below tier1 */ });
  await withServer({ sessionId: sid, watcher: w }, async ({ port, srv }) => {
    seedLedger(sid);
    const r = await post(port);
    assert.ok('bill' in r && 'kind' in r && 'delivery' in r, 'unified contract present (not the gate-only shape)');
    assert.equal(r.kind, 'empty_burn');
    assert.equal(r.delivery, 'stop_hook');
    assert.equal(r.notify, true, 'deep-water empty_burn is a stop_hook alert');
    // AUXILIARY (brittle across Express versions): exactly one POST layer for the path.
    const posts = srv.app._router.stack.filter(l => l.route && l.route.path === '/api/notify-gate'
      && l.route.methods && l.route.methods.post);
    assert.equal(posts.length, 1, 'exactly one POST /api/notify-gate handler registered');
  });
});

// (a) pending empty_burn bills in deep water fire delivery:stop_hook with the empty copy.
test('(a) deep-water empty_burn settles → stop_hook with empty copy', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ L_read: 250500, inDeepWater: true, gateL: 100000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid);
    const r = await post(port);
    assert.equal(r.kind, 'empty_burn');
    assert.equal(r.delivery, 'stop_hook');
    assert.match(r.message, /idle|empty|rent/i, 'empty copy surfaced');
    assert.equal(getLiveLedger(sid).pendingBillCountSinceBoundary, 0, 'settlement cleared the pending count');
  });
});

// (b) a concurrent gate fire merges into ONE message (test 32 at the route level).
test('(b) empty_burn + gate fire same turn → ONE merged message (gate text merged)', async () => {
  const sid = `sr-${randomUUID()}`;
  // gateL in tier2 range (≥151.5k) so the gate fires this turn; deep-water empty_burn bill also present.
  const w = stopWatcher({ L_read: 250500, inDeepWater: true, gateL: 160000 });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    seedLedger(sid);
    const r = await post(port);
    assert.equal(r.kind, 'empty_burn', 'empty_burn wins the stack over the gate-alone branch');
    assert.equal(r.delivery, 'stop_hook');
    assert.equal(r.gate.notify, true, 'the gate DID fire this turn (merged, not a second alert)');
    // one merged message — the gate text is folded into the empty message, not emitted separately.
    assert.equal(typeof r.message, 'string');
  });
});

// (c) reliable=false → no settlement, statusline stays calibrating; no crash.
test('(c) unreliable snapshot → no settlement, no bill, no stop alert', async () => {
  const sid = `sr-${randomUUID()}`;
  const w = stopWatcher({ reliable: false });
  await withServer({ sessionId: sid, watcher: w }, async ({ port }) => {
    const r = await post(port);
    assert.equal(r.bill, null, 'no settlement on an unreliable frame');
    assert.equal(r.notify, false, 'no stop alert');
    assert.equal(r.kind, null);
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
    assert.match(l1, /🔴 Rate wall:/, 'the WALL alert text surfaces on the statusline THIS turn (distinctive marker)');
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
    assert.match(l1, /🔴 Rate wall:/, 'the WALL alert reaches the UI despite the pause (distinctive marker)');
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
