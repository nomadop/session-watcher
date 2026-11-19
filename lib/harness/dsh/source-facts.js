// lib/harness/dsh/source-facts.js — the facts of one DSH session's measurement Source at an event cut.
// They are `{ epoch, headDone, points, carriers }`: `epoch` the count of true epoch boundaries folded, `headDone` whether the open epoch's first main call with a positive stock has been seen, `points` the open epoch's selected usage points in log order, each `{ seq, role }`, and `carriers` every inner-seal carrier in log order, `{ seq, epoch, post }`.
// A point's role is `head` for the epoch's calls with a usage through the first whose stock is positive, `post` for the first main call behind a carrier, `current` for any other until a carrier lists it. `post` of a carrier is null while no main call follows it in its epoch, else `{ seq, usage }` of the first one, `usage` null where the measurement reads none of it; no later call fills it. A true epoch clears the points and leaves the carriers of the epoch before waiting for good.
// The fold is pure and total over the reducer's answers. The measurement source fold (`source-fold.js`) decides from it which usage a withdrawal keeps, and the inner monitor's projection reads a carrier's post from it, so both see one epoch, one main call and one usage at the same cut. The calls a budget may count are its points ahead of the first pending one (`qualifiedCalls`).

import { reduceDshEvent } from './transcript-observation.js';

/** The facts before any event. */
export function initialSourceFacts() {
  return { epoch: 0, headDone: false, points: [], carriers: [] };
}

const isCarrier = reduced => Array.isArray(reduced.withdraws);
const usageOf = reduced => reduced.observations.find(observation => observation.type === 'usage')?.usage ?? null;
// A stock is what the call's request carried: its input and cache buckets, summed.
const stockOf = ({ input, cacheRead, cacheWrite }) => input + cacheRead + cacheWrite;
/** Whether `reduced`, a `reduceDshEvent` answer, states a true epoch boundary: the replacement of a compact checkpoint. */
export const startsEpoch = reduced => reduced.observations.some(observation => observation.type === 'epoch-boundary');

function withCarrier(facts, event, reduced) {
  const listed = new Set(reduced.withdraws);
  return {
    ...facts,
    points: facts.points.filter(point => point.role !== 'current' || !listed.has(point.seq)),
    carriers: [...facts.carriers, { seq: event.seq, epoch: facts.epoch, post: null }],
  };
}

function withMainCall(facts, event, reduced) {
  const usage = usageOf(reduced);
  const waiting = facts.carriers.some(carrier => carrier.epoch === facts.epoch && carrier.post === null);
  const carriers = waiting
    ? facts.carriers.map(carrier => (carrier.epoch === facts.epoch && carrier.post === null ? { ...carrier, post: { seq: event.seq, usage } } : carrier))
    : facts.carriers;
  if (usage === null) return waiting ? { ...facts, carriers } : facts;
  const role = facts.headDone ? (waiting ? 'post' : 'current') : 'head';
  return { ...facts, headDone: facts.headDone || stockOf(usage) > 0, points: [...facts.points, { seq: event.seq, role }], carriers };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIndex = value => Number.isSafeInteger(value) && value >= 0;
/** Whether `event` is a main call: a committed `assistant/message` with a seq, whatever its usage holds. */
export const isMainCall = event => event.type === 'assistant/message' && isIndex(event.seq);
const isUsage = value => isObject(value) && ['input', 'output', 'cacheRead', 'cacheWrite'].every(field => Number.isFinite(value[field]));
const isPost = value => value === null || (isObject(value) && isIndex(value.seq) && (value.usage === null || isUsage(value.usage)));

/**
 * How many of the open epoch's points the Source qualifies for a budget: those ahead of the first one that is still `current`, which no carrier has listed yet. A point behind a pending one, a post of a partial seal among them, waits with it: the prefix stops at the first pending point and never skips one to reach a later point.
 * @param {{ points: { role: string }[] }} facts
 * @returns {number}
 */
export function qualifiedCalls(facts) {
  const pending = facts.points.findIndex(point => point.role === 'current');
  return pending === -1 ? facts.points.length : pending;
}

/**
 * Whether `value` is facts as the fold builds them: what a state persisted with them is read back through.
 */
export function isSourceFacts(value) {
  return isObject(value) && isIndex(value.epoch) && typeof value.headDone === 'boolean'
    && Array.isArray(value.points) && value.points.every(point => isObject(point) && isIndex(point.seq) && ['head', 'post', 'current'].includes(point.role))
    && Array.isArray(value.carriers) && value.carriers.every(carrier => isObject(carrier) && isIndex(carrier.seq) && isIndex(carrier.epoch) && isPost(carrier.post));
}

/**
 * The facts after `event`, which the reducer answered as `reduced` (`reduceDshEvent(event)` unless the caller has it already); the facts themselves when the event changes none, an event with no seq included.
 * An epoch boundary opens the next epoch and clears its points. A carrier drops the points it lists that hold the role `current`, and waits for its post. The first main call that follows, with a usage or without one, is the post of every carrier waiting in its epoch.
 */
export function foldSourceFacts(facts, event, reduced = reduceDshEvent(event)) {
  if (!isIndex(event.seq)) return facts;
  if (startsEpoch(reduced)) return { ...facts, epoch: facts.epoch + 1, headDone: false, points: [] };
  if (isCarrier(reduced)) return withCarrier(facts, event, reduced);
  if (isMainCall(event)) return withMainCall(facts, event, reduced);
  return facts;
}
