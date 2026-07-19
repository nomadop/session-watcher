// Pure priority-stack resolver (spec §4.3 / §10.1#6). Returns the ONE message for a Stop boundary, or
// null. Merges the notify-gate result into the chosen message rather than emitting a second alert
// (§4.3 "only one merged message"). context_cap (an unreachable rate wall) is attribution only — never a
// stack item (§10.1#8) — and has NO v2.1 consumer, so it is deliberately not an input here (R5 gemini#3,
// deferred RV-C11). Copy is neutral per §5.
const WALL = 'Rate wall: one more call costs at least one full restart in avoidable context rent. Finish the current small step, then restart unless continuity is unusually valuable.';
const BACKSTOP_MSG = 'Rate reminder: sustained deep water — you have accumulated another amber-distance of avoidable rent. Consider compacting or restarting at the next natural checkpoint.';
export const EMPTY_MSG = 'Rate idle-burn: about one billing cycle passed with little new context, yet high-position rent ≈ one full restart. Consider restarting after the current small step.';
export const CACHE_UNSTABLE_MSG = 'Calibrating: context stock dropped (cache expiry / boundary); rate metering paused for this step.';
const merge = (msg, gate) => (gate?.notify && gate.message) ? `${gate.message} · ${msg}` : msg;

export function resolveStopMessage({ gateResult, burnRate, backstopResult }) {
  // 1. WALL (burnRate >= 1) — hard ceiling, every turn.
  if (burnRate >= 1)
    return { kind: 'wall', delivery: 'stop_hook', message: merge(WALL, gateResult), billCount: 0 };
  // 2. Gate fire (first deep-water entry in segment).
  if (gateResult?.notify)
    return { kind: 'gate', delivery: 'stop_hook', message: gateResult.message, billCount: 0 };
  // 3. Backstop (sustained deep water, amber-baseline interval).
  if (backstopResult?.notify)
    return { kind: 'backstop', delivery: 'stop_hook', message: BACKSTOP_MSG, billCount: 0 };
  return null;
}
