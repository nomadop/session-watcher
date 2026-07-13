import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJsonAtomic, safeSessionId } from './atomic-store.js';
import { parseState, serializeState, validateGateState } from './notify-gate.js';

function pathFor(sessionId) {
  const base = process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, 'gate-state')
    : join(homedir(), '.session-watcher', 'gate');
  return join(base, `${safeSessionId(sessionId || 'default')}.json`); // round-6 GPT#3b: no path traversal
}
// round-6 GPT#6: validate on load with the SAME rigor as validateLedgerState — parseState alone only
// checked JSON + `segment` presence, so a finite-but-out-of-range state (turnSeq:-1, maxTierFired:999)
// could drive the gate into permanent suppress / spurious fire. validateGateState (Task 4) enforces the
// ranges; corrupt/out-of-range → null → server treats as fresh (guardrail a: never crash, never stale-fire).
export function loadGateState(sessionId) {
  try { return validateGateState(parseState(readFileSync(pathFor(sessionId), 'utf8'))); } catch { return null; }
}
export function saveGateState(sessionId, state) { writeJsonAtomic(pathFor(sessionId), JSON.parse(serializeState(state))); }
