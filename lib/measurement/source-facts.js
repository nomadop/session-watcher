// lib/measurement/source-facts.js — the facts of one measurement Source at an event cut.
// They are `{ epoch, headDone, points, carriers }`: `epoch` the count of true epoch boundaries folded, `headDone` whether the open epoch's first main call with a positive stock has been seen, `points` the open epoch's selected usage points in log order, each `{ seq, role }`, and `carriers` every carrier in log order, `{ seq, epoch, post }`. A carrier is an event that replaces the source events it seals.
// A point's role is `head` for the epoch's calls with a usage through the first whose stock is positive, `post` for the first main call behind a carrier, `current` for any other until a carrier lists it. `post` of a carrier is null while no main call follows it in its epoch, else `{ seq, usage }` of the first one, `usage` null where the measurement reads none of it; no later call fills it. A true epoch clears the points and leaves the carriers of the epoch before waiting for good.
// The fold is pure and total over the inputs a harness adapter gives it, one per event: `{ seq, observations, diagnostics, sealed?, mainCall }`, the Observations the event reduces to, the seqs a carrier seals (`sealed`, present on a carrier alone) and whether the event is a main call. It reads Observation types and the canonical usage alone. The measurement source fold (`source-fold.js`) decides from the facts which usage a seal keeps, and the inner monitor's projection reads a carrier's post from them, so both see one epoch, one main call and one usage at the same cut. The calls a budget may count are its points ahead of the first pending one (`qualifiedCalls`).
import { stockOf } from './usage.js';

/** The facts before any event. */
export function initialSourceFacts() {
  return { epoch: 0, headDone: false, points: [], carriers: [] };
}

const isCarrier = input => Array.isArray(input.sealed);
const usageOf = input => input.observations.find(observation => observation.type === 'usage')?.usage ?? null;
/** Whether the event whose Observations an input holds states a true epoch boundary. */
export const startsEpoch = ({ observations }) => observations.some(observation => observation.type === 'epoch-boundary');

function withCarrier(facts, input) {
  const listed = new Set(input.sealed);
  return {
    ...facts,
    points: facts.points.filter(point => point.role !== 'current' || !listed.has(point.seq)),
    carriers: [...facts.carriers, { seq: input.seq, epoch: facts.epoch, post: null }],
  };
}

function withMainCall(facts, input) {
  const usage = usageOf(input);
  const waiting = facts.carriers.some(carrier => carrier.epoch === facts.epoch && carrier.post === null);
  const carriers = waiting
    ? facts.carriers.map(carrier => (carrier.epoch === facts.epoch && carrier.post === null ? { ...carrier, post: { seq: input.seq, usage } } : carrier))
    : facts.carriers;
  if (usage === null) return waiting ? { ...facts, carriers } : facts;
  const role = facts.headDone ? (waiting ? 'post' : 'current') : 'head';
  return { ...facts, headDone: facts.headDone || stockOf(usage) > 0, points: [...facts.points, { seq: input.seq, role }], carriers };
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isIndex = value => Number.isSafeInteger(value) && value >= 0;
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
 * The facts after the event `input` stands for; the facts themselves when the event changes none, an event whose seq is no index included.
 * An epoch boundary opens the next epoch and clears its points. A carrier drops the points it seals that hold the role `current`, and waits for its post. The first main call that follows, with a usage or without one, is the post of every carrier waiting in its epoch.
 * @param {{ epoch: number, headDone: boolean, points: object[], carriers: object[] }} facts
 * @param {{ seq: number, observations: object[], sealed?: number[], mainCall: boolean }} input
 */
export function foldSourceFacts(facts, input) {
  if (!isIndex(input.seq)) return facts;
  if (startsEpoch(input)) return { ...facts, epoch: facts.epoch + 1, headDone: false, points: [] };
  if (isCarrier(input)) return withCarrier(facts, input);
  if (input.mainCall) return withMainCall(facts, input);
  return facts;
}
