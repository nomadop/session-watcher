// ═══════════════════════════════════════════════════════════════════════════════════════════════
// C0b — READ-ONLY golden oracle test (the C-layer SAFETY NET). Spec §10.2 C0.
//
// This test FREEZES the CURRENT (v2.1) settleBatchAtBoundary + resolveStopMessage behavior. It LOADS the
// fixtures generated ONCE by test/fixtures/ledger-oracle/generate.js (C0a) and asserts the current code
// still reproduces them byte-for-byte. Every later C sub-batch (C1-2 settleMeterAtBoundary split, C2
// edge-settle, C3 pending, C4 bounded advance) must keep these green — that is how they prove they only
// REGROUPED behavior, not CHANGED it.
//
// ★ THIS TEST NEVER REGENERATES. ★ It only ever READS + asserts. A failure here means a later sub-batch
// changed settlement/alert behavior — INVESTIGATE the change; do NOT re-run generate.js to make it green.
// (Regenerating is correct ONLY when v2.1 behavior is being deliberately, reviewably re-baselined — which
// is not what any C sub-batch does.) See test/fixtures/ledger-oracle/README.md.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { freshLedger, stateKeyOf, applyFoldedCallSample, settleBatchAtBoundary } from '../lib/rate-lamp-store.js';
import { resolveStopMessage } from '../lib/stop-message.js';
import { validateLedgerState } from '../lib/ledger-schema.js';
import { runOracleScript, KEY, rs } from './fixtures/ledger-oracle/oracle-driver.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ledger-oracle');
const load = (name) => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8'));

// ── The two tests shown VERBATIM in the brief (self-contained; drive the real functions directly). ──

// Meter oracle: a scripted sequence, captured verbatim. Any future sub-batch MUST reproduce these.
test('C0: meter oracle — single turn, two calls', () => {
  let s = freshLedger(KEY);
  s = applyFoldedCallSample(s, rs(1, 0.2, 1000, 1));
  s = applyFoldedCallSample(s, rs(2, 0.4, 2000, 1));
  const { state, bill } = settleBatchAtBoundary(s, { L_readNow: 2000, kStable: 500, inDeepWater: false, foldedSeqNow: 2, turnSeqNow: 2 });
  assert.equal(state.billCycleCount, 0);
  assert.ok(Math.abs(state.billProgress - 0.3) < 1e-6);
  assert.equal(bill, null, 'no crossing → no bill this boundary');
});

test('C0: 3-turn poll, each turn a different deltaW — per-boundary captures', () => {
  // READ-ONLY (C0b): load the frozen fixture and assert the current code still reproduces it.
  const oracle = load('three-turn');
  let s = freshLedger(KEY);
  const got = [];
  for (const step of oracle.script) {
    if (step.sample) s = applyFoldedCallSample(s, rs(...step.sample));
    else { const { state, bill } = settleBatchAtBoundary(s, step.boundary); s = state;
      got.push([s.billCycleCount, s.currentTurnDeltaW, bill?.kind ?? null]); }
  }
  assert.deepEqual(got, oracle.captures, 'current code reproduces the frozen per-boundary triples');
});

// ── Generalized read-only replay: EVERY meter/alert fixture, driven through the SHARED driver. ──
// The shared driver is the one the generator used, so a divergence here can only mean the LIB changed.

const METER_FIXTURES = ['single-turn', 'three-turn', 'pre-flush-stale', 'poll-first', 'stop-first'];

for (const name of METER_FIXTURES) {
  test(`C0b READ-ONLY: meter oracle "${name}" — every boundary triple + full meter reproduced`, () => {
    const oracle = load(name);
    const r = runOracleScript(oracle.script);
    // per-boundary (billCycleCount, currentTurnDeltaW, kind) triples — the intermediate-summary requirement
    assert.deepEqual(r.triples, oracle.captures, `${name}: per-boundary triples must byte-match the frozen fixture`);
    // full meter oracle {billProgress, billCycleCount, currentTurnDeltaW, billAnchorLRead} per boundary
    assert.deepEqual(r.meter, oracle.meter, `${name}: meter oracle must byte-match`);
    assert.deepEqual(r.bills, oracle.bills, `${name}: settle bill objects must byte-match`);
  });
}

test('C0b READ-ONLY: alert oracle "persist-before-commit" — kinds + persisted lastStopEvent reproduced', () => {
  const oracle = load('persist-before-commit');
  const r = runOracleScript(oracle.script);
  assert.deepEqual(r.triples, oracle.captures, 'per-boundary triples must byte-match');
  assert.deepEqual(r.meter, oracle.meter, 'meter oracle must byte-match');
  assert.deepEqual(r.bills, oracle.bills, 'settle bills must byte-match');
  // alert oracle: resolveStopMessage kind/delivery/billCount per boundary — covers wall / empty_burn /
  // dw_backstop / non_idle_burn / cache_unstable / gate / null (every kind in the brief's alert oracle).
  assert.deepEqual(r.alerts, oracle.alerts, 'resolved alert kinds must byte-match');
  // persist-before-commit: the EXACT lastStopEvent recordStopEvent would persist synchronously. A
  // statusline_pulse resolution (non_idle_burn / cache_unstable) is NOT persisted (recordStopEvent no-ops)
  // → null in the frozen array; wall/empty_burn/dw_backstop/gate ARE persisted (stop_hook).
  assert.deepEqual(r.stopEvents, oracle.stopEvents, 'persisted lastStopEvent shapes must byte-match');
});

// Assert the alert oracle actually EXERCISES every kind (guards against a future edit that silently
// drops a branch and still "passes" a thinner fixture).
test('C0b: persist-before-commit alert oracle is non-degenerate — every resolveStopMessage kind present', () => {
  const oracle = load('persist-before-commit');
  const kinds = new Set(oracle.alerts.map((a) => a?.kind ?? 'null'));
  for (const k of ['wall', 'empty_burn', 'dw_backstop', 'non_idle_burn', 'cache_unstable', 'gate', 'null']) {
    assert.ok(kinds.has(k), `alert oracle must exercise "${k}" (froze a non-degenerate mix)`);
  }
  // persist-before-commit invariant: exactly the stop_hook resolutions were persisted; the two
  // statusline_pulse ones (non_idle_burn / cache_unstable) and the null were NOT.
  oracle.alerts.forEach((a, i) => {
    if (a && a.delivery === 'stop_hook') assert.ok(oracle.stopEvents[i], `boundary ${i}: stop_hook alert must be persisted`);
    else assert.equal(oracle.stopEvents[i], null, `boundary ${i}: non-stop_hook resolution must NOT persist a stop event`);
  });
});

// ── v2 hydrate / stale-v1-degrades-to-fresh (H-C). NOT a v1 oracle: there is NO v1-ledger.json. ──
test('C0b: v2 hydrate — a previously-persisted v2 ledger round-trips clean through validateLedgerState', () => {
  const oracle = load('v2-hydrate');
  // The persisted ledger is a REAL current `final` state (the frozen script reproduces it). This proves the
  // capture is genuine, not hand-authored.
  const reproduced = runOracleScript(oracle.script).final;
  assert.deepEqual(reproduced, oracle.persisted, 'the persisted v2 ledger is a reproducible current output');
  // Hydrate back: KEY.schemaVersion:2 → validateLedgerState accepts it unchanged.
  const hydrated = validateLedgerState(oracle.persisted);
  assert.notEqual(hydrated, null, 'a v2 ledger hydrates (schemaVersion:2 passes the HARD gate)');
  assert.equal(hydrated.schemaVersion, 2);
  assert.equal(hydrated.billCycleCount, oracle.persisted.billCycleCount, 'lifetime billCycleCount survives the hydrate');
  assert.equal(hydrated.stateKey, stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 2 }));
});

test('C0b (H-C): a stale v1 disk ledger degrades to fresh — validateLedgerState returns null, NOT a migration', () => {
  const oracle = load('v2-hydrate');
  // Take the identical persisted ledger but stamp it schemaVersion:1 (what an OLD binary wrote). The HARD
  // version gate (schemaVersion !== 2 → null) rejects it → loadRateLampState returns null → the manager
  // builds a freshLedger. There is deliberately NO v1-ledger.json fixture and NO migration/.bak path.
  const staleV1 = { ...oracle.persisted, schemaVersion: 1 };
  assert.equal(validateLedgerState(staleV1), null, 'schemaVersion:1 is judged foreign → null → fresh (no migration)');
  // Any non-2 version (a hypothetical future v3 disk file seen by this build) also degrades to fresh.
  assert.equal(validateLedgerState({ ...oracle.persisted, schemaVersion: 3 }), null, 'any non-2 schema degrades to fresh');
});
