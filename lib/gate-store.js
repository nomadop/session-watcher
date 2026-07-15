import { getStore } from './store.js';
import { validateGateState } from './notify-gate.js';

// round-6 GPT#6: validate on load with the SAME rigor as validateLedgerState — parseState alone only
// checked JSON + `segment` presence, so a finite-but-out-of-range state (turnSeq:-1, maxTierFired:999)
// could drive the gate into permanent suppress / spurious fire. validateGateState (Task 4) enforces the
// ranges; corrupt/out-of-range → null → server treats as fresh (guardrail a: never crash, never stale-fire).
export function loadGateState(sessionId) {
  try {
    const raw = getStore().load(sessionId, 'gate');
    if (!raw) return null;
    return validateGateState(raw);
  } catch { return null; }
}

export function saveGateState(sessionId, state) {
  // state is already a plain object; store.save handles JSON serialization
  getStore().save(sessionId, 'gate', state);
}
