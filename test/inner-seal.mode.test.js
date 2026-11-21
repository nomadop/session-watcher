// The session mode's fold (`lib/inner-seal/mode.js`) driven by its two inputs: "a turn has started" and "the data of one mode record".
import test from 'node:test';
import assert from 'node:assert/strict';

import { foldMode, INITIAL_MODE, modeStateOf } from '../lib/inner-seal/mode.js';

const TURN = { turnStarted: true };
const recordOf = data => ({ record: data });
const foldAll = (...inputs) => inputs.reduce(foldMode, INITIAL_MODE);

test('no record is off and unlocked, the last record before the first turn decides, and a turn locks the mode that stands', () => {
  assert.deepEqual(INITIAL_MODE, { mode: 'off', locked: false });
  assert.deepEqual(foldAll(recordOf({ v: 1, enabled: true })), { mode: 'on', locked: false });
  assert.deepEqual(foldAll(
    recordOf({ v: 1, enabled: false }), recordOf({ v: 1, enabled: true }), recordOf({ v: 1, enabled: false }),
  ), { mode: 'off', locked: false }, 'the last of several records decides');
  assert.deepEqual(foldAll(recordOf({ v: 1, enabled: true }), TURN), { mode: 'on', locked: true });
  assert.deepEqual(foldAll(TURN), { mode: 'off', locked: true });
});

test('a record that arrives after the lock changes nothing', () => {
  assert.deepEqual(foldAll(recordOf({ v: 1, enabled: true }), TURN, recordOf({ v: 1, enabled: false })), { mode: 'on', locked: true });
  assert.deepEqual(foldAll(TURN, recordOf({ v: 1, enabled: true })), { mode: 'off', locked: true });
  assert.deepEqual(foldAll(TURN, recordOf({ v: 3 })), { mode: 'off', locked: true });
});

test('a record whose data does not read as { v: 1, enabled: boolean } makes the mode invalid, the last record still decides, and a lock keeps the invalid mode', () => {
  for (const data of [null, undefined, 7, 'on', [], {}, { v: 1 }, { v: 2, enabled: true }, { v: 1, enabled: 'yes' }, { v: 1, enabled: 1 }, { enabled: true }]) {
    assert.deepEqual(foldAll(recordOf(data)), { mode: 'invalid', locked: false }, JSON.stringify(data));
  }
  assert.deepEqual(foldAll(recordOf({ v: 1, enabled: 1 }), TURN), { mode: 'invalid', locked: true });
  assert.deepEqual(foldAll(recordOf({ v: 1 }), recordOf({ v: 1, enabled: true })), { mode: 'on', locked: false }, 'a valid record after an invalid one decides');
  assert.deepEqual(foldAll(recordOf({ v: 1, enabled: true }), recordOf({ v: 1 })), { mode: 'invalid', locked: false });
});

test('the fold answers the state it was given when the input changes nothing, and one same state for any path that reaches it', () => {
  const on = foldAll(recordOf({ v: 1, enabled: true }));
  assert.equal(foldMode(on, recordOf({ v: 1, enabled: true })), foldMode(INITIAL_MODE, recordOf({ v: 1, enabled: true })), 'a record that restates the mode reaches the one state it names');
  const locked = foldMode(on, TURN);
  assert.equal(foldMode(locked, TURN), locked, 'a second turn');
  assert.equal(foldMode(locked, recordOf({ v: 1, enabled: false })), locked, 'a record after the lock');
  assert.equal(foldMode(INITIAL_MODE, TURN), foldAll(TURN));
  assert.ok(Object.isFrozen(INITIAL_MODE) && Object.isFrozen(on) && Object.isFrozen(locked));
  assert.equal(foldMode(on, TURN), foldMode(foldAll(recordOf({ v: 1, enabled: true })), TURN));
});

test('the state reader answers the canonical frozen state of each of the six states and null for any other value', () => {
  for (const modeName of ['off', 'on', 'invalid']) {
    for (const locked of [false, true]) {
      const state = modeStateOf({ mode: modeName, locked });
      assert.deepEqual(state, { mode: modeName, locked });
      assert.ok(Object.isFrozen(state));
      assert.equal(modeStateOf({ mode: modeName, locked, extra: 1 }), state, 'the same canonical state, whatever else the value carries');
    }
  }
  assert.equal(modeStateOf({ mode: 'off', locked: false }), INITIAL_MODE);
  assert.equal(modeStateOf({ mode: 'on', locked: true }), foldAll(recordOf({ v: 1, enabled: true }), TURN), 'the fold and the reader give one reference');
  assert.equal(modeStateOf({ mode: 'invalid', locked: false }), foldAll(recordOf(null)));
  for (const value of [null, undefined, 'on', 7, [], {}, { mode: 'on' }, { locked: false }, { mode: 'maybe', locked: false }, { mode: 'on', locked: 1 }, { mode: 'toString', locked: false }]) {
    assert.equal(modeStateOf(value), null, JSON.stringify(value));
  }
});
