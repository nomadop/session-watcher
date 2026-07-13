// Pure priority-stack resolver (spec §4.3 / §10.1#6). Returns the ONE message for a Stop boundary, or
// null. Merges the notify-gate result into the chosen message rather than emitting a second alert
// (§4.3 "only one merged message"). stockStep downgrades WALL/ΔW to neutral non_idle (A4). context_cap
// (an unreachable rate wall) is attribution only — never a stack item (§10.1#8) — and has NO v2.1 consumer,
// so it is deliberately not an input here (R5 gemini#3, deferred RV-C11). Copy is neutral per §5.
import { CONSTANTS } from './constants.js'; // R5 GPT#6: DW_TURN_BACKSTOP threshold — do not hard-code 2
const WALL = 'Rate wall: one more call costs at least one full restart in avoidable context rent. Finish the current small step, then restart unless continuity is unusually valuable.';
const DW = 'Rate bill: this step triggered several underlying calls; accumulated avoidable rent ≈ multiple full restarts. Consider restarting at the next natural checkpoint.';
const EMPTY = 'Rate idle-burn: about one billing cycle passed with little new context, yet high-position rent ≈ one full restart. Consider restarting after the current small step.';
const NON_IDLE = 'Rate bill: this cycle\'s high-position rent ≈ one full restart; context is still growing. Consider tidying up, compacting, or restarting at a natural checkpoint.';
const CACHE_UNSTABLE = 'Calibrating: context stock dropped (cache expiry / boundary); rate metering paused for this step.';
const merge = (msg, gate) => (gate?.notify && gate.message) ? `${gate.message} · ${msg}` : msg;

export function resolveStopMessage({ gateResult, bill, burnRate, dwTurn, stockStep }) {
  // 2. WALL (burnRate≥1) — every turn, ignores ΔL — UNLESS a floor-step suppresses it (A4).
  if (burnRate >= 1) {
    if (stockStep) return { kind: 'non_idle_burn', delivery: 'statusline_pulse', message: NON_IDLE, billCount: bill?.billCount ?? 0 };
    return { kind: 'wall', delivery: 'stop_hook', message: merge(WALL, gateResult), billCount: bill?.billCount ?? 0 };
  }
  // 3. ΔW_turn ≥ DW_TURN_BACKSTOP backstop — ignores ΔL/deep-water — also suppressed on a floor-step.
  if (dwTurn >= CONSTANTS.DW_TURN_BACKSTOP) {
    if (stockStep) return { kind: 'non_idle_burn', delivery: 'statusline_pulse', message: NON_IDLE, billCount: bill?.billCount ?? 0 };
    return { kind: 'dw_backstop', delivery: 'stop_hook', message: merge(DW, gateResult), billCount: bill?.billCount ?? 0 };
  }
  // 4. empty_burn (deep water routing already decided by settleBatchAtBoundary → bill.delivery).
  if (bill?.kind === 'empty_burn' && bill.delivery === 'stop_hook') {
    return { kind: 'empty_burn', delivery: 'stop_hook', message: merge(EMPTY, gateResult), billCount: bill.billCount };
  }
  // gate fire with no stronger bill → deliver the gate message alone.
  if (gateResult?.notify) {
    return { kind: 'gate', delivery: 'stop_hook', message: gateResult.message, billCount: bill?.billCount ?? 0 };
  }
  // 5. non_idle_burn → statusline only.
  if (bill?.kind === 'non_idle_burn') {
    return { kind: 'non_idle_burn', delivery: 'statusline_pulse', message: NON_IDLE, billCount: bill.billCount };
  }
  // cache_unstable (negative ΔL_read, round-2 GPT#13) → neutral calibrating pulse, NEVER stop_hook,
  // NEVER the "ctx growing" non_idle copy. Ranks below a gate fire (handled above) but above null.
  if (bill?.kind === 'cache_unstable') {
    return { kind: 'cache_unstable', delivery: 'statusline_pulse', message: CACHE_UNSTABLE, billCount: bill.billCount };
  }
  return null;
}
