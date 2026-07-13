// C0a GENERATE-ONCE (E6). Run this ONE TIME against the CURRENT (v2.1) code to FREEZE the golden
// meter+alert oracle, human-review the diff, and commit. It drives the REAL settle/apply/resolve/record
// functions via oracle-driver.js and writes one `{script, ...captures}` fixture per scenario.
//
//   node test/fixtures/ledger-oracle/generate.js
//
// This script is NOT part of the test suite (not a *.test.js). The committed test
// (test/rate-lamp.oracle.test.js) is READ-ONLY: it NEVER calls this. A later C sub-batch that changes
// settlement behavior must make the READ-ONLY test FAIL — you then INVESTIGATE, you do NOT re-run this
// generator to paint it green. Regenerating is only ever correct when v2.1 behavior itself is being
// deliberately (and reviewably) re-baselined, which is NOT what any C sub-batch does.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runOracleScript } from './oracle-driver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const kS = 940;   // kStable used across scenarios (empirical stable-k order of magnitude; test-only)

// Meter-oracle scenarios: each a scripted (sample… boundary)* sequence. `sample:[seq,br,L,turnSeq]`,
// `boundary:{L_readNow,kStable,inDeepWater,foldedSeqNow,turnSeqNow}`. NO `resolve` → alerts/stopEvents null.
const METER_SCENARIOS = {
  // Matches the brief's shown INLINE test exactly (two calls, one turn, one boundary, no crossing).
  'single-turn': [
    { sample: [1, 0.2, 1000, 1] },
    { sample: [2, 0.4, 2000, 1] },
    { boundary: { L_readNow: 2000, kStable: 500, inDeepWater: false, foldedSeqNow: 2, turnSeqNow: 2 } },
  ],
  // One poll spanning 3 turns, each turn a DIFFERENT deltaW, each crossing at least once — a mix of
  // non_idle_burn (deltaL≥kStable) and empty_burn (deltaL<kStable) settle kinds.
  'three-turn': [
    { sample: [1, 1.2, 1000, 1] }, { sample: [2, 1.2, 5000, 1] },
    { boundary: { L_readNow: 5000, kStable: kS, inDeepWater: false, foldedSeqNow: 2, turnSeqNow: 1 } }, // deltaL 4000 → non_idle
    { sample: [3, 0.8, 5100, 2] }, { sample: [4, 0.2, 5150, 2] },
    { boundary: { L_readNow: 5150, kStable: kS, inDeepWater: false, foldedSeqNow: 4, turnSeqNow: 2 } }, // deltaL 150 → empty_burn
    { sample: [5, 0.5, 8000, 3] }, { sample: [6, 0.5, 12000, 3] },
    { boundary: { L_readNow: 12000, kStable: kS, inDeepWater: false, foldedSeqNow: 6, turnSeqNow: 3 } }, // deltaL 6850 → non_idle
  ],
  // Pre-flush stale read: calls burned (crossing) but the boundary settles against a STALE L_read equal to
  // the anchor (deltaL 0 < kStable) → the boundary reads empty_burn even though burn happened.
  'pre-flush-stale': [
    { sample: [1, 1.2, 1000, 1] }, { sample: [2, 1.2, 1000, 1] },
    { boundary: { L_readNow: 1000, kStable: kS, inDeepWater: false, foldedSeqNow: 2, turnSeqNow: 2 } },
  ],
  // Poll-first: the normal poll path integrates several calls, THEN one boundary settle (one crossing).
  'poll-first': [
    { sample: [1, 0.9, 2000, 1] }, { sample: [2, 0.9, 4000, 1] }, { sample: [3, 0.9, 6000, 1] },
    { boundary: { L_readNow: 6000, kStable: kS, inDeepWater: false, foldedSeqNow: 3, turnSeqNow: 2 } },
  ],
  // Stop-first: a boundary settles BEFORE anything is pending (bill null), then integration crosses and a
  // SECOND boundary fires a real bill — freezes the "Stop fired early, nothing to settle yet" case.
  'stop-first': [
    { sample: [1, 1.2, 1000, 1] },
    { boundary: { L_readNow: 1000, kStable: kS, inDeepWater: false, foldedSeqNow: 1, turnSeqNow: 1 } }, // pending 0 → null
    { sample: [2, 1.2, 3000, 1] },
    { boundary: { L_readNow: 3000, kStable: kS, inDeepWater: false, foldedSeqNow: 2, turnSeqNow: 1 } }, // deltaL 2000 → non_idle
  ],
};

// Alert-oracle scenario: persist-before-commit. Each boundary adds a `resolve` step so the driver ALSO
// runs resolveStopMessage(real bill, …) and recordStopEvent(…) — capturing the EXACT lastStopEvent the Stop
// route persists synchronously (persist-before-commit) AND the fact that a statusline_pulse resolution is
// NOT persisted (recordStopEvent no-ops). Covers every resolveStopMessage kind: wall / empty_burn(deep) /
// dw_backstop / non_idle_burn(statusline, no-persist) / cache_unstable(no-persist) / gate / null.
const PERSIST_SCENARIO = [
  // Turn 1 → WALL (burnRate≥1 overrides the non_idle settle bill) → stop_hook, PERSISTED.
  { sample: [1, 1.2, 1000, 1] }, { sample: [2, 1.2, 3000, 1] },
  { boundary: { L_readNow: 3000, kStable: kS, inDeepWater: true, foldedSeqNow: 2, turnSeqNow: 1 }, resolve: { burnRate: 1.2 } },
  // Turn 2 → empty_burn in DEEP water → stop_hook, PERSISTED.
  { sample: [3, 1.5, 3020, 2] },
  { boundary: { L_readNow: 3050, kStable: kS, inDeepWater: true, foldedSeqNow: 3, turnSeqNow: 2 }, resolve: { burnRate: 0.3 } },
  // Turn 3 → ΔW_turn ≥ DW_TURN_BACKSTOP backstop (trap 2.0 in one turn) → stop_hook, PERSISTED.
  { sample: [4, 2.5, 3070, 3] },
  { boundary: { L_readNow: 9000, kStable: kS, inDeepWater: false, foldedSeqNow: 4, turnSeqNow: 3 }, resolve: { burnRate: 0.3 } },
  // Turn 4 → non_idle_burn → statusline_pulse → NOT persisted (recordStopEvent no-ops on non-stop_hook).
  { sample: [5, 0.5, 9020, 4] }, { sample: [6, 0.3, 9040, 4] },
  { boundary: { L_readNow: 11000, kStable: kS, inDeepWater: false, foldedSeqNow: 6, turnSeqNow: 4 }, resolve: { burnRate: 0.4 } },
  // Turn 5 → cache_unstable (negative ΔL_read) → statusline_pulse → NOT persisted.
  { sample: [7, 1.2, 11020, 5] }, { sample: [8, 1.2, 11040, 5] },
  { boundary: { L_readNow: 5000, kStable: kS, inDeepWater: false, foldedSeqNow: 8, turnSeqNow: 5 }, resolve: { burnRate: 0.3 } },
  // Turn 6 → gate fire with nothing pending → gate-alone stop_hook, PERSISTED.
  { sample: [9, 0.5, 5020, 6] },
  { boundary: { L_readNow: 5020, kStable: kS, inDeepWater: false, foldedSeqNow: 9, turnSeqNow: 6 },
    resolve: { burnRate: 0.3, gateResult: { notify: true, message: 'past exit' } } },
  // Turn 7 → shallow empty_burn, no gate, sub-threshold → resolveStopMessage returns null (no alert).
  { sample: [10, 0.5, 5040, 7] },
  { boundary: { L_readNow: 5060, kStable: kS, inDeepWater: false, foldedSeqNow: 10, turnSeqNow: 7 }, resolve: { burnRate: 0.3 } },
];

// v2 hydrate scenario: a previously-persisted v2 ledger (KEY.schemaVersion:2), captured as a REAL `final`
// state, then hydrated back through validateLedgerState in the READ-ONLY test (round-trips clean; a
// stale-v1 copy degrades to null → fresh). We store the generating script + the final ledger so the test
// can prove the persisted ledger is a reproducible current output, not hand-authored.
const HYDRATE_SCRIPT = METER_SCENARIOS['three-turn'];

function writeFixture(name, obj) {
  const p = join(HERE, `${name}.json`);
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  return p;
}

const written = [];
for (const [name, script] of Object.entries(METER_SCENARIOS)) {
  const r = runOracleScript(script);
  written.push(writeFixture(name, { script, captures: r.triples, meter: r.meter, bills: r.bills, alerts: r.alerts, stopEvents: r.stopEvents }));
}
{
  const r = runOracleScript(PERSIST_SCENARIO);
  written.push(writeFixture('persist-before-commit', { script: PERSIST_SCENARIO, captures: r.triples, meter: r.meter, bills: r.bills, alerts: r.alerts, stopEvents: r.stopEvents }));
}
{
  const r = runOracleScript(HYDRATE_SCRIPT);
  written.push(writeFixture('v2-hydrate', { script: HYDRATE_SCRIPT, persisted: r.final }));
}

console.error(`C0a: wrote ${written.length} fixtures:`);
for (const p of written) console.error('  ' + p);
