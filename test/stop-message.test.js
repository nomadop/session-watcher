import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStopMessage } from '../lib/stop-message.js';
import { CONSTANTS } from '../lib/constants.js'; // R5 GPT#6: derive the threshold, don't hard-code 2

const base = { gateResult: { notify: false }, bill: null, burnRate: 0.3, dwTurn: 0, stockStep: false };

test('30: WALL (burnRate≥1) → stop_hook, ignores ΔL', () => {
  const r = resolveStopMessage({ ...base, burnRate: 1.0 });
  assert.equal(r.kind, 'wall'); assert.equal(r.delivery, 'stop_hook');
});
test('A4: WALL suppressed on a floor-step turn → neutral non_idle statusline', () => {
  const r = resolveStopMessage({ ...base, burnRate: 1.0, stockStep: true });
  assert.equal(r.kind, 'non_idle_burn'); assert.equal(r.delivery, 'statusline_pulse');
});
test('31: ΔW_turn ≥ DW_TURN_BACKSTOP → forced stop_hook once (threshold from the constant, R5 GPT#6)', () => {
  const over = resolveStopMessage({ ...base, dwTurn: CONSTANTS.DW_TURN_BACKSTOP + 0.1 });
  assert.equal(over.kind, 'dw_backstop'); assert.equal(over.delivery, 'stop_hook');
  const under = resolveStopMessage({ ...base, dwTurn: CONSTANTS.DW_TURN_BACKSTOP - 0.1 });
  assert.notEqual(under?.kind, 'dw_backstop', 'below threshold does not trip the backstop (proves the constant is the source)');
});
test('33: WALL + non_idle_burn → only WALL (priority 2 > 5)', () => {
  const r = resolveStopMessage({ ...base, burnRate: 1.2, bill: { kind: 'non_idle_burn', billCount: 1 } });
  assert.equal(r.kind, 'wall');
});
test('32: empty_burn + gate fire same turn → ONE merged message', () => {
  const r = resolveStopMessage({ ...base, bill: { kind: 'empty_burn', billCount: 1, delivery: 'stop_hook' }, gateResult: { notify: true, message: 'past exit' } });
  assert.equal(r.kind, 'empty_burn'); assert.equal(r.delivery, 'stop_hook');
  assert.match(r.message, /past exit/); // gate text merged, not a second message
});
test('non_idle_burn + no gate → statusline only', () => {
  const r = resolveStopMessage({ ...base, bill: { kind: 'non_idle_burn', billCount: 1 } });
  assert.equal(r.kind, 'non_idle_burn'); assert.equal(r.delivery, 'statusline_pulse');
});
test('R2-13: cache_unstable bill → neutral calibrating pulse, never stop_hook, never "growing" copy', () => {
  const r = resolveStopMessage({ ...base, bill: { kind: 'cache_unstable', billCount: 1, deltaL: -40000 } });
  assert.equal(r.kind, 'cache_unstable'); assert.equal(r.delivery, 'statusline_pulse');
  assert.doesNotMatch(r.message, /growing/i);
});
test('nothing pending, no gate → null', () => {
  assert.equal(resolveStopMessage(base), null);
});
test('34 (R5 gemini#3): resolver ignores reachability — an unknown/extra wallReachable prop never changes the outcome', () => {
  // context_cap attribution is NOT a resolver input in v2.1 (deferred RV-C11). Pinning that a stray
  // wallReachable prop is inert prevents a future maintainer from re-introducing it as a silent stack item.
  const withProp = resolveStopMessage({ ...base, burnRate: 1.0, wallReachable: false });
  const without = resolveStopMessage({ ...base, burnRate: 1.0 });
  assert.deepEqual(withProp, without, 'reachability is not consumed — WALL still resolves identically');
  assert.equal(withProp.kind, 'wall', 'an unreachable wall is STILL a wall (attribution ≠ suppression)');
});
test('row 4: ΔW_turn ≥ backstop suppressed on a floor-step → neutral non_idle statusline', () => {
  const r = resolveStopMessage({ ...base, dwTurn: 2.1, stockStep: true });
  assert.equal(r.kind, 'non_idle_burn'); assert.equal(r.delivery, 'statusline_pulse');
});
test('row 6: non_idle_burn bill + gate fire → gate-alone stop_hook (gate outranks the non_idle pulse)', () => {
  const r = resolveStopMessage({ ...base, bill: { kind: 'non_idle_burn', billCount: 1 }, gateResult: { notify: true, message: 'past exit' } });
  assert.equal(r.kind, 'gate'); assert.equal(r.delivery, 'stop_hook');
  assert.match(r.message, /past exit/);
});
test('row 9: null bill + gate fire → gate-alone stop_hook', () => {
  const r = resolveStopMessage({ ...base, bill: null, gateResult: { notify: true, message: 'past exit' } });
  assert.equal(r.kind, 'gate'); assert.equal(r.delivery, 'stop_hook');
});
