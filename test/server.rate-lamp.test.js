import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initStore, closeStoreGlobal } from '../lib/store.js';

// Initialize a module-level SQLite store so saveRateLampState / advanceRateLampToCurrent
// never write into the real ~/.session-watcher. initStore is called once; the store lives
// for the duration of this test file. _resetRateLampManagerForTest() within tests clears
// the in-memory manager state (not the store) — same isolation contract as the old env var.
const TMP = mkdtempSync(join(tmpdir(), 'sw-srv-rl-'));
initStore(join(TMP, 'test.sqlite'));
process.on('exit', () => {
  try { closeStoreGlobal(); } catch {}
  try { rmSync(TMP, { recursive: true, force: true }); } catch {};
});

import { SessionWatcher } from '../lib/watcher.js';
import { createServer } from '../server.js';
import { computeXExitFromKStable } from '../lib/rate-lamp.js';
import { freshLedger, saveRateLampState, stateKeyOf } from '../lib/rate-lamp-store.js';
import { validateLedgerState } from '../lib/ledger-schema.js';
import { advanceRateLampToCurrent, setLiveLedger, getLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
function line(o) { return JSON.stringify(o) + '\n'; }
function asst(id, cr, input, out, model = 'deepseek-v4-pro') {
  return line({ type: 'assistant', uuid: id + '_' + cr, isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
    message: { id, model, usage: {
      input_tokens: input, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: cr } } });
}
// Healthy cold-start warmup→stable session (a real knee → latches → rateLamp.reliable=true). Mirrors
// test/watcher.latch.test.js's `healthy()`. Cold-start (null lbase) is required — carried baselines never latch.
function healthy(n, startCr = 42000, idPrefix = 'm') {
  const deltas = [9000, 8000, 7000, 3000, 1500, 900];
  for (let i = 6; i < n; i++) deltas.push(940);
  let s = ''; let cr = startCr;
  s += asst(idPrefix + '0', cr, Math.round(deltas[0] * 0.6), Math.round(deltas[0] * 0.4));
  for (let t = 0; t < n; t++) { cr += deltas[t]; const g = deltas[t + 1] ?? 940;
    s += asst(idPrefix + (t + 1), cr, Math.round(g * 0.6), Math.round(g * 0.4)); }
  return s;
}
function tmpFile(text) { const p = join(mkdtempSync(join(tmpdir(), 'sw-srv-')), 's.jsonl'); writeFileSync(p, text); return p; }
function healthyWatcher(n = 40) { return new SessionWatcher(tmpFile(healthy(n)), null); }
// the state key the manager/route compute from a reliable getStatus() — must match the live ledger's.
function keyFromStatus(st) {
  return stateKeyOf({ segmentId: st.segment, model: st.model, cRatio: st.rateLamp.C_RATIO,
    baselineFingerprint: st.baseline?.fingerprint ?? null, contextCap: st.rateLamp.L_cap, schemaVersion: 1 });
}
async function withServer({ watcher, pollIntervalMs = 0 }, fn) {
  const sid = `srv-rl-${randomUUID()}`;
  const srv = createServer({ watcher, pollIntervalMs, sessionId: sid });
  await new Promise(r => srv.server.listen(0, r));
  const port = srv.server.address().port;
  try { await fn({ port, sid, watcher, srv }); }
  finally { srv.stopTimers(); await new Promise(r => srv.server.close(r)); }
}

// ── A. API-contract (A5): /api/status merges the LIVE same-key ledger; cycleCount is debug-only ─────
test('A5: /api/status merges the live same-key ledger billProgress; cycleCountInSegment is debug-only (GPT#16)', async () => {
  _resetRateLampManagerForTest();
  const w = healthyWatcher(); w.poll();
  const st = w.getStatus();
  assert.equal(st.rateLamp.reliable, true, 'fixture latched → reliable (precondition)');
  const KEY = keyFromStatus(st);
  await withServer({ watcher: w }, async ({ port, sid }) => {
    // A real same-key ledger with a NON-zero billProgress (not the fresh-anchor 0), anchored at the
    // current seq so a route/advance never re-drains history. Debug counter set to a distinct value.
    setLiveLedger(sid, { ...freshLedger(KEY, st.rateLamp.kStable), stateKey: KEY,
      lastAppliedFoldedCallSeq: w._foldedCallSeq, billProgress: 0.42, billCycleCount: 3, currentTurnSeq: 1 });

    const plain = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(plain.rateLamp.billProgress, 0.42, 'merged the real ledger billProgress (not 0, not undefined)');
    assert.ok(plain.rateLamp.billingCycle && plain.rateLamp.billingCycle.progress === 0.42, 'billingCycle mirrors billProgress');
    assert.equal(plain.rateLamp.billingCycle.cycleCountInSegment, undefined, 'GPT#16: cycleCount ABSENT without ?debug');

    const dbg = await (await fetch(`http://127.0.0.1:${port}/api/status?debug=1`)).json();
    assert.equal(dbg.rateLamp.billingCycle.cycleCountInSegment, 3, 'GPT#16: cycleCount PRESENT with ?debug, off the same ledger');
  });
});

// ── B. poll-loop wiring: startPolling drives advanceRateLampToCurrent → live ledger gets populated ──
test('poll loop advances the single writer: startPolling populates the live ledger', async () => {
  _resetRateLampManagerForTest();
  const w = healthyWatcher(); // constructor poll + loop poll both fold; loop advance creates the ledger
  await withServer({ watcher: w, pollIntervalMs: 20 }, async ({ sid, srv }) => {
    const KEY = keyFromStatus(w.getStatus());
    srv.startPolling();
    const t0 = Date.now();
    let led = null;
    while (Date.now() - t0 < 2000) { led = getLiveLedger(sid); if (led) break; await new Promise(r => setTimeout(r, 15)); }
    assert.ok(led, 'the poll loop called advanceRateLampToCurrent and created a live ledger');
    assert.equal(led.stateKey, KEY, 'live ledger is keyed to the current segment');
    assert.equal(typeof led.billProgress, 'number', 'ledger has a real billProgress (first-latch anchor = 0)');
    assert.equal(led.lastAppliedFoldedCallSeq, w._foldedCallSeq, 'first advance anchored at the current seq (no history catch-up)');
  });
});

// ── C. restart no-resurrect (round-7 GPT#2): route reads LIVE ledger only; disk pulses stay cleared ─
test('round-7 GPT#2: a stale disk lastStopEvent does NOT resurrect on the first GET; advance clears it', async () => {
  _resetRateLampManagerForTest();
  const w = healthyWatcher(); w.poll();
  const st = w.getStatus();
  const KEY = keyFromStatus(st);
  const sid = `srv-rl-noresurrect-${randomUUID()}`;
  // Persist to DISK a ledger with a live-LOOKING alert (turnSeq === currentTurnSeq). A raw disk read in
  // the route would merge+render it; the route must read the empty LIVE ledger instead.
  saveRateLampState(sid, { ...freshLedger(KEY, st.rateLamp.kStable), stateKey: KEY,
    lastAppliedFoldedCallSeq: w._foldedCallSeq, currentTurnSeq: 5,
    lastStopEvent: { kind: 'wall', delivery: 'stop_hook', message: 'STALE-ALERT-XYZ', billCount: 0, turnSeq: 5 } });

  const srv = createServer({ watcher: w, pollIntervalMs: 0, sessionId: sid });
  await new Promise(r => srv.server.listen(0, r));
  const port = srv.server.address().port;
  try {
    // BEFORE any advance: live ledger is empty → nothing merged → stale alert cannot render.
    const lineTxt = await (await fetch(`http://127.0.0.1:${port}/api/status?fmt=line`)).text();
    assert.ok(!lineTxt.includes('STALE-ALERT-XYZ'), 'stale disk alert did not render on the first fmt=line GET');
    const j = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(j.rateLamp.lastStopEvent, undefined, 'route read the empty live ledger, not the disk file');
    // First advance hydrates from disk with lastBillEvent/lastStopEvent CLEARED (A3).
    const { ledger } = advanceRateLampToCurrent(w, sid, { forcePoll: false });
    assert.equal(ledger.lastStopEvent, null, 'hydrateLedger cleared the stale stop alert on disk load');
    assert.equal(ledger.lastBillEvent, null, 'bill pulse cleared too');
  } finally { srv.stopTimers(); await new Promise(r => srv.server.close(r)); }
});

// ── D. stateKey guard (R2-4): a stale-key in-memory ledger must NOT ghost-merge into /api/status ────
test('R2-4: /api/status refuses a stale-key live ledger (no ghost billProgress)', async () => {
  _resetRateLampManagerForTest();
  const w = healthyWatcher(); w.poll();
  const st = w.getStatus();
  const CURRENT = keyFromStatus(st);
  await withServer({ watcher: w }, async ({ port, sid }) => {
    const STALE = stateKeyOf({ segmentId: 999, model: 'other', cRatio: 3, baselineFingerprint: 'stale', contextCap: 128000, schemaVersion: 1 });
    assert.notEqual(STALE, CURRENT, 'precondition: keys differ');
    setLiveLedger(sid, { ...freshLedger(STALE, 940), stateKey: STALE, billProgress: 0.77 });
    const j = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.notEqual(j.rateLamp.billProgress, 0.77, 'stale-key ledger billProgress did not leak into status');
    assert.equal(j.rateLamp.billProgress, undefined, 'no merge happened for a mismatched key');
  });
});

// ── E. frozen-xExit via /api/status (G4-2): xExit derives from ledger.kStableFrozen, not live kStable ─
test('G4-2: /api/status xExit/inDeepWater derive from the FROZEN kStable, matching the advance() status', async () => {
  _resetRateLampManagerForTest();
  const w = healthyWatcher(); w.poll();
  const st = w.getStatus();
  const KEY = keyFromStatus(st);
  const cRatio = st.rateLamp.C_RATIO, total = st.baseline.total, liveK = st.rateLamp.kStable;
  const FROZEN = liveK + 500; // deliberately different from the live stableMedian-derived kStable
  const expectedXExit = computeXExitFromKStable(cRatio, FROZEN, total);
  assert.notEqual(expectedXExit, st.rateLamp.xExit, 'precondition: frozen xExit differs from the live-kStable xExit');
  await withServer({ watcher: w }, async ({ port, sid }) => {
    setLiveLedger(sid, { ...freshLedger(KEY, FROZEN), stateKey: KEY, kStableFrozen: FROZEN,
      lastAppliedFoldedCallSeq: w._foldedCallSeq, currentTurnSeq: 1 });
    const j = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.ok(Math.abs(j.rateLamp.xExit - expectedXExit) < 1e-9, 'API xExit computed from the FROZEN kStable');
    assert.equal(j.rateLamp.kStable, FROZEN, 'API kStable overridden to the frozen value');
    // inDeepWater is now br-based (br >= 0.10), not xExit-threshold-based
    assert.equal(j.rateLamp.inDeepWater, Number.isFinite(j.rateLamp.br) && j.rateLamp.br >= 0.10, 'inDeepWater consistent with br >= BR_AMBER');
    // Single source: the Stop route's advanceRateLampToCurrent status shows the identical frozen xExit.
    const { status } = advanceRateLampToCurrent(w, sid, { forcePoll: false });
    assert.ok(Math.abs(status.rateLamp.xExit - j.rateLamp.xExit) < 1e-9, 'advance() and /api/status single-source the frozen xExit');
  });
});

// ── F. restart-continuity (A4): a same-key disk checkpoint continues integrating; no reset/double-count ─
test('A4: same-key restart continues from the persisted billProgress and integrates only the new call', async () => {
  _resetRateLampManagerForTest();
  const p = tmpFile(healthy(40));
  const w = new SessionWatcher(p, null);
  const sid = `srv-rl-continuity-${randomUUID()}`;
  const srv = createServer({ watcher: w, pollIntervalMs: 0, sessionId: sid }); // constructor folds the 41-call history
  try {
    const st = w.getStatus();
    const KEY = keyFromStatus(st);
    const N = w._foldedCallSeq;
    // "process 1" checkpoint: p=0.4 accrued, all N history calls already applied, a live burn rate set.
    saveRateLampState(sid, { ...freshLedger(KEY, st.rateLamp.kStable), stateKey: KEY,
      lastAppliedFoldedCallSeq: N, billProgress: 0.4, lastBurnRate: 0.3, lastAppliedLRead: st.rateLamp.L_read,
      billAnchorLRead: st.rateLamp.L_read, billAnchorFoldedCallSeq: N, billAnchorTurnSeq: 1, currentTurnSeq: 1 });
    _resetRateLampManagerForTest(); // simulate a fresh process (empty _ledgers; the disk checkpoint remains)

    // One genuinely new call arrives on the SAME segment (monotonic cacheRead → no L-drop → same key).
    appendFileSync(p, asst('m41', st.rateLamp.L_read + 940, 560, 380));
    w.poll();
    assert.equal(w._foldedCallSeq, N + 1, 'the new call folded to seq N+1');

    const { ledger } = advanceRateLampToCurrent(w, sid, { forcePoll: false });
    assert.equal(ledger.stateKey, KEY, 'same key → reused, not reset');
    assert.equal(ledger.lastAppliedFoldedCallSeq, N + 1, 'advanced exactly one call (no history double-count)');
    assert.equal(ledger.pausedReason, null, 'clean reuse — no folded_seq_gap');
    assert.ok(ledger.billProgress > 0.4, 'continued integrating from the persisted 0.4 (not reset to 0)');
    assert.ok(ledger.billProgress < 0.9, 'only ONE new call integrated (not the whole N-call history)');
  } finally { srv.stopTimers(); await new Promise(r => srv.server.close(r)); }
});

// ── G. no-catch-up on first latch (R2-3): first reliable advance anchors at seq now, billProgress 0 ─
test('R2-3: first reliable advance anchors at the current seq — the historical calls are NOT integrated', () => {
  _resetRateLampManagerForTest();
  const w = healthyWatcher(); w.poll(); // 41-call history, latched reliable, NO persisted ledger
  const sid = `srv-rl-nocatchup-${randomUUID()}`;
  const before = w._foldedCallSeq;
  assert.ok(before > 20, 'precondition: a real history precedes the first advance');
  const { ledger } = advanceRateLampToCurrent(w, sid, { forcePoll: false });
  assert.equal(ledger.lastAppliedFoldedCallSeq, before, 'fresh ledger anchored at the current seq');
  assert.equal(ledger.billProgress, 0, 'no retroactive integration of the pre-latch history');
  assert.equal(ledger.billCycleCount, 0, 'and no phantom settled cycles');
});

// ── H. unreliable drain (R2-2/F-1 + G4-1): unreliable advance still moves the cursor; recovery is clean ─
// A fakeWatcher gives deterministic control of reliable↔unreliable frames and the exact sample seqs.
function fakeWatcher({ turnSeq, foldedSeq, reliable, unavailableReason, calls = [],
  cRatio = 10, kStable = 940, L_read = 300000, L_cap = 1000000, total = 250000,
  model = 'opus', segment = 0, fingerprint = 'fp-H' } = {}) {
  return {
    _turnSeq: turnSeq, _foldedCallSeq: foldedSeq,
    poll() { return { changed: false, newCalls: 0 }; },
    getStatus() {
      const rateLamp = reliable
        ? { reliable: true, C_RATIO: cRatio, L_cap, L_read, B_post: total, B_rebuild: total, kStable }
        : { reliable: false, unavailableReason };
      return { segment, model, baseline: { fingerprint, total }, rateLamp };
    },
    rateLampSamplesSince(since) {
      return calls.filter(c => c.seq > since).map(c => ({ seq: c.seq, reliable: true, turnSeq: c.turnSeq, L_read: c.L_read, burnRate: c.burnRate }));
    },
    rateLampSeqSamplesSince(since, { unavailableReason: reason }) {
      return calls.filter(c => c.seq > since).map(c => ({ seq: c.seq, reliable: false, unavailableReason: reason, turnSeq: c.turnSeq }));
    },
  };
}

test('R2-2/F-1 + G4-1: an unreliable frame drains the seq cursor (never gated), and a reliable frame recovers cleanly', () => {
  _resetRateLampManagerForTest();
  const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'fp-H', contextCap: 1000000, schemaVersion: 1 });
  const sid = `srv-rl-unreliable-${randomUUID()}`;
  // A pre-existing reliable ledger at seq 10.
  setLiveLedger(sid, { ...freshLedger(KEY, 940), stateKey: KEY, lastAppliedFoldedCallSeq: 10, lastBurnRate: 0.3,
    lastAppliedLRead: 100000, currentTurnSeq: 1, pausedReason: null });

  // Phase 1 — UNRELIABLE (insufficient_data), two new folded calls 11,12. The drain must NOT be gated on
  // reliable: the cursor advances and the ledger pauses with the SPECIFIC reason.
  const wUnrel = fakeWatcher({ turnSeq: 2, foldedSeq: 12, reliable: false, unavailableReason: 'insufficient_data',
    calls: [{ seq: 11, turnSeq: 2 }, { seq: 12, turnSeq: 2 }] });
  const r1 = advanceRateLampToCurrent(wUnrel, sid, { forcePoll: false });
  assert.equal(r1.ledger.lastAppliedFoldedCallSeq, 12, 'unreliable frame advanced the seq cursor (drain not gated on reliable)');
  assert.equal(r1.ledger.pausedReason, 'insufficient_data', 'paused with the specific unavailable reason');
  assert.ok(validateLedgerState(r1.ledger), 'G4-1: the insufficient_data-paused ledger still passes its own validator');

  // Phase 2 — RELIABLE, one new call 13 (= lastApplied+1). Recovery re-anchors, never a folded_seq_gap,
  // never invalid_sample.
  const wRel = fakeWatcher({ turnSeq: 3, foldedSeq: 13, reliable: true,
    calls: [{ seq: 13, turnSeq: 3, L_read: 120000, burnRate: 0.5 }] });
  const r2 = advanceRateLampToCurrent(wRel, sid, { forcePoll: false });
  assert.equal(r2.ledger.pausedReason, null, 'reliable frame recovered to pausedReason:null (not invalid_sample, not a gap)');
  assert.equal(r2.ledger.lastAppliedFoldedCallSeq, 13, 'cursor continued from the unreliable stretch with no gap');
});
