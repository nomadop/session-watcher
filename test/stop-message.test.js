import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStopMessage } from '../lib/stop-message.js';

// Post-Task4 signature: { gateResult, burnRate, backstopResult }. bill/dwTurn retired.
const base = { gateResult: { notify: false }, burnRate: 0.3, backstopResult: { notify: false } };

test('30: WALL (burnRate≥1) → stop_hook', () => {
  const r = resolveStopMessage({ ...base, burnRate: 1.0 });
  assert.equal(r.kind, 'wall'); assert.equal(r.delivery, 'stop_hook');
});
test('31: backstop fires when backstopResult.notify is true (sub-wall, no gate)', () => {
  const r = resolveStopMessage({ ...base, backstopResult: { notify: true } });
  assert.equal(r.kind, 'backstop'); assert.equal(r.delivery, 'stop_hook');
});
test('33: WALL outranks backstop + gate (priority 1 > 2 > 3)', () => {
  const r = resolveStopMessage({ ...base, burnRate: 1.2, gateResult: { notify: true, message: 'G' }, backstopResult: { notify: true } });
  assert.equal(r.kind, 'wall');
});
test('32: gate fire + backstop → gate wins (priority 2 > 3)', () => {
  const r = resolveStopMessage({ ...base, gateResult: { notify: true, message: 'past exit' }, backstopResult: { notify: true } });
  assert.equal(r.kind, 'gate'); assert.equal(r.delivery, 'stop_hook');
  assert.match(r.message, /past exit/);
});
test('nothing pending, no gate, no backstop → null', () => {
  assert.equal(resolveStopMessage(base), null);
});
test('34 (R5 gemini#3): resolver ignores reachability — an unknown/extra wallReachable prop never changes the outcome', () => {
  const withProp = resolveStopMessage({ ...base, burnRate: 1.0, wallReachable: false });
  const without = resolveStopMessage({ ...base, burnRate: 1.0 });
  assert.deepEqual(withProp, without, 'reachability is not consumed — WALL still resolves identically');
  assert.equal(withProp.kind, 'wall', 'an unreachable wall is STILL a wall (attribution ≠ suppression)');
});
test('gate fire alone → gate stop_hook', () => {
  const r = resolveStopMessage({ ...base, gateResult: { notify: true, message: 'past exit' } });
  assert.equal(r.kind, 'gate'); assert.equal(r.delivery, 'stop_hook');
  assert.match(r.message, /past exit/);
});

test('resolveStopMessage returns null when no signal fires', () => {
  const r = resolveStopMessage({ gateResult: null, burnRate: 0, backstopResult: { notify: false } });
  assert.equal(r, null);
});

