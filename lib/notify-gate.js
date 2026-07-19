// v3 notify gate (spec section 6.2): dwell-time (NOTIFY_DWELL consecutive br>=BR_AMBER turns) + hysteresis
// re-arm deadband (br must drop below BR_AMBER - BR_HYST before a new fire). No ratchet, no tiers,
// no cooldown — billing table + 3-call dwell provides natural spacing; deeper position fires more often.
import { NOTIFY_DWELL, BR_HYST } from './constants.js';
import { BR_AMBER } from './bill-regret.js';

function fresh(segment) { return { segment, turnSeq: 0, dwell: 0, fired: false, armed: true }; }

const MSG = 'Session Watcher: bill-regret is above the amber threshold and holding. Consider restarting/compacting at the next natural boundary. Ask session-restart-advisor for details.';

export function evaluateGate(snapshot, prevState) {
  let state = (!prevState || prevState.segment !== snapshot.segment) ? fresh(snapshot.segment) : { ...prevState };
  const done = (notify, reason, message = null) => ({ notify, reason, message, nextState: state });

  if (snapshot.turnSeq <= state.turnSeq) return done(false, 'duplicate_turn');
  state.turnSeq = snapshot.turnSeq;

  if (snapshot.reliable === false || !Number.isFinite(snapshot.br)) { state.dwell = 0; return done(false, 'not_reliable'); }

  // Hysteresis re-arm: once br falls below the deadband, allow a future fire.
  if (snapshot.br < BR_AMBER - BR_HYST) state.armed = true;

  if (snapshot.br >= BR_AMBER) {
    state.dwell += 1;
    if (state.dwell >= NOTIFY_DWELL && state.armed && !state.fired) {
      state.fired = true; state.armed = false;
      return done(true, 'fire', MSG);
    }
    // still fired/not-armed -> suppressed
    if (state.fired) return done(false, 'already_fired');
    return done(false, 'pending_dwell');
  }
  state.dwell = 0;
  // Dropping below amber clears the fired latch so the NEXT amber run can fire again once re-armed.
  if (snapshot.br < BR_AMBER - BR_HYST) state.fired = false;
  return done(false, 'below_amber');
}

export function serializeState(state) { return JSON.stringify(state); }
export function parseState(str) {
  try { const s = JSON.parse(str); return (s && typeof s.segment !== 'undefined') ? s : null; } catch { return null; }
}
export function validateGateState(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const f of ['segment', 'turnSeq', 'dwell']) if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  if (typeof obj.fired !== 'boolean' || typeof obj.armed !== 'boolean') return null;
  return obj;
}
