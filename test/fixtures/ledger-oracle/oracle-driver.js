// C0 oracle DRIVER — the ONE piece of logic shared by the C0a generator (generate.js) and the
// read-only C0b test (../../rate-lamp.oracle.test.js). It drives the CURRENT (v2.1) pure functions
// verbatim: applyFoldedCallSample → settleBatchAtBoundary → resolveStopMessage → recordStopEvent.
// It computes NOTHING itself — every captured number is a REAL current output. Because the generator
// and the test share this exact driver, a fixture generated once and replayed later can only diverge
// if the LIB behavior changed (which is precisely what C0b must catch).
//
// NOT a *.test.js file → node --test never runs it as a test. Imported, not executed standalone.
import { freshLedger, stateKeyOf, applyFoldedCallSample, settleBatchAtBoundary } from '../../../lib/rate-lamp-store.js';
import { resolveStopMessage } from '../../../lib/stop-message.js';
import { recordStopEvent } from '../../../lib/rate-lamp-manager.js';

// EXACT KEY from the task brief (schemaVersion:2 — C1-1 bumped the schema to v2). The meter triples are
// stateKey-independent (settle/apply math never reads stateKey), but the hydrate round-trip needs a valid
// v2 stateKey, so we pin the one KEY everywhere.
export const KEY = stateKeyOf({ segmentId: 0, model: 'opus', cRatio: 10, baselineFingerprint: 'f', contextCap: 1_000_000, schemaVersion: 2 });

// Sample helper — field is L_read (effectiveL), NEVER cacheRead (Task 2.5 locked contract). Byte-identical
// to the brief's `rs`, so the shown inline tests and the driver build the same sample object.
export const rs = (seq, br, L, turnSeq) => ({ seq, reliable: true, burnRate: br, L_read: L, turnSeq });

// Drive one script through the current code. A `script` is an ordered list of steps:
//   { sample: [seq, br, L, turnSeq] }            → applyFoldedCallSample(state, rs(...))
//   { boundary: {L_readNow,kStable,inDeepWater,foldedSeqNow,turnSeqNow},
//     resolve?: {gateResult?,burnRate?,dwTurn?,stockStep?} }
//                                                → settleBatchAtBoundary(state, boundary); if `resolve` is
//                                                  present, ALSO resolveStopMessage(...) with the REAL bill
//                                                  from settle, then recordStopEvent(...) to snapshot the
//                                                  persist-before-commit lastStopEvent shape.
//
// Returns, per BOUNDARY (spec §10.2 C0 — assert EVERY ended turn's intermediate summary, not just final):
//   triples[] : [billCycleCount, currentTurnDeltaW, bill?.kind ?? null]  (byte-match to the brief's shown loop)
//   meter[]   : {billProgress, billCycleCount, currentTurnDeltaW, billAnchorLRead}   (meter oracle)
//   bills[]   : the settle bill {kind,delivery,billCount,deltaL} or null
//   alerts[]  : resolveStopMessage result {kind,delivery,billCount} or null (null when no `resolve` step)
//   stopEvents[] : recordStopEvent(...).lastStopEvent — the persisted alert shape or null
//   final     : the terminal ledger state
export function runOracleScript(script) {
  let s = freshLedger(KEY);
  const triples = [], meter = [], bills = [], alerts = [], stopEvents = [];
  for (const step of script) {
    if (step.sample) { s = applyFoldedCallSample(s, rs(...step.sample)); continue; }
    if (!step.boundary) throw new Error('oracle script step must be {sample} or {boundary}');
    // The real Stop route reads ΔW_turn from the ledger BEFORE the settle (settle never touches
    // currentTurnDeltaW), so we snapshot it here to feed resolveStopMessage's dwTurn faithfully.
    const dwTurnPreSettle = s.currentTurnDeltaW;
    const { state, bill } = settleBatchAtBoundary(s, step.boundary);
    s = state;
    triples.push([s.billCycleCount, s.currentTurnDeltaW, bill?.kind ?? null]);
    meter.push({ billProgress: s.billProgress, billCycleCount: s.billCycleCount,
      currentTurnDeltaW: s.currentTurnDeltaW, billAnchorLRead: s.billAnchorLRead });
    bills.push(bill ? { kind: bill.kind, delivery: bill.delivery, billCount: bill.billCount, deltaL: bill.deltaL } : null);
    if (step.resolve) {
      const r = resolveStopMessage({
        gateResult: step.resolve.gateResult ?? { notify: false },
        bill,
        burnRate: step.resolve.burnRate ?? 0,
        dwTurn: step.resolve.dwTurn ?? dwTurnPreSettle,
        stockStep: step.resolve.stockStep ?? false,
      });
      alerts.push(r ? { kind: r.kind, delivery: r.delivery, billCount: r.billCount ?? 0 } : null);
      // persist-before-commit shape: recordStopEvent no-ops on a non-stop_hook resolution, so this is the
      // exact lastStopEvent that the Stop route would persist synchronously before the gate ratchet commit.
      const led = recordStopEvent(s, r, step.boundary.turnSeqNow);
      stopEvents.push(led.lastStopEvent ?? null);
    } else { alerts.push(null); stopEvents.push(null); }
  }
  return { triples, meter, bills, alerts, stopEvents, final: s };
}
