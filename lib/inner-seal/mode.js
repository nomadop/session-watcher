// lib/inner-seal/mode.js — the session mode of the inner compaction experiment: the fold of its two inputs into the mode.
// The inputs are "a turn has started" and "the data of one mode record"; which event is which is the host adapter's classification. The last record before the first turn decides the mode, a turn locks it, and a record whose data does not read as `{ v: 1, enabled: boolean }` makes it `invalid`.
// The fold is pure and writes nothing. Every state is one of six frozen objects, so a step that changes nothing returns the reference it was given and `modeStateOf` gives a persisted value the same reference the fold would.

const MODES = ['off', 'on', 'invalid'];

const STATES = Object.fromEntries(MODES.map(mode => [mode, {
  unlocked: Object.freeze({ mode, locked: false }),
  locked: Object.freeze({ mode, locked: true }),
}]));
const stateOf = (mode, locked) => STATES[mode][locked ? 'locked' : 'unlocked'];

const isModeData = data => data !== null && typeof data === 'object' && data.v === 1 && typeof data.enabled === 'boolean';

/** The mode of a session no record has reached: off and unlocked. */
export const INITIAL_MODE = stateOf('off', false);

/**
 * The canonical frozen state of a value that reads as `{ mode, locked }` with one of the six states; null for any other value.
 * @param {unknown} value
 * @returns {{ mode: 'off' | 'on' | 'invalid', locked: boolean } | null}
 */
export function modeStateOf(value) {
  if (value === null || typeof value !== 'object' || !MODES.includes(value.mode) || typeof value.locked !== 'boolean') return null;
  return stateOf(value.mode, value.locked);
}

/**
 * One fold step: `input` is `{ turnStarted: true }` or `{ record: data }`.
 * A locked state answers itself for any input.
 * @param {{ mode: 'off' | 'on' | 'invalid', locked: boolean }} state
 * @param {{ turnStarted: true } | { record: unknown }} input
 * @returns {{ mode: 'off' | 'on' | 'invalid', locked: boolean }}
 */
export function foldMode(state, input) {
  if (state.locked) return state;
  if (input.turnStarted === true) return stateOf(state.mode, true);
  return stateOf(isModeData(input.record) ? (input.record.enabled ? 'on' : 'off') : 'invalid', false);
}
