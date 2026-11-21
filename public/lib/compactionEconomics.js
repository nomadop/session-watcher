// public/lib/compactionEconomics.js — harness-independent compaction figures: the monitor lists estimates from attempt and handoff rows; the closed-segment report can adjust those estimates and its cumulative net with recall evidence.

// The count of epoch boundaries before an attempt's first record: the segment it belongs to, the first where the host sends none.
const segmentOf = ({ epoch }) => epoch ?? 0;

// A step count as a term of a sum: zero where a row has none, that is, where it is not a finite number.
const countOf = value => (Number.isFinite(value) ? value : 0);

/**
 * The display segment and ordinal of each attempt of `attempts` by its id, `{ epoch, ordinal }`: the segment is the host's count of the epoch boundaries before the attempt's first record, plus one (a row from a host that sends none reads as the first), and the ordinal its place, counted from one, among the attempts of that segment in the order the host returned them. A segment no attempt began in takes no number from the others.
 * It is for presentation alone; no row identity, selection or resource key reads it.
 */
export function ordinalsOf(attempts) {
  const counts = new Map();
  return Object.fromEntries(attempts.map((attempt) => {
    const { id } = attempt;
    const segment = segmentOf(attempt) + 1;
    const ordinal = (counts.get(segment) ?? 0) + 1;
    counts.set(segment, ordinal);
    return [id, { epoch: segment, ordinal }];
  }));
}

/** The payback progress, in percent, at which a compaction counts as paid back. */
const PAID_BACK_PERCENT = 100;
const PERCENT = 100;

/** What `saved` is of `cost` in whole percent, rounded down on the exact figures; it has no ceiling. */
export const paybackPercent = (saved, cost) => Math.floor(saved * PERCENT / cost);

/**
 * The first `/sw-continue` clear of each segment, ascending by id, as `{ id, epoch, segment, tailCalls }`: `segment` the epoch count of the compactions it cleared, one less than the `epoch` of its row, which counts the boundaries before its payload, and `tailCalls` the main calls the monitor counted after the segment's last carrier or checkpoint, zero where the row has none; that count is the monitor's own, and differs in what it counts from the `stepN` of `innerSource`. A load and any later continue of a segment are none of them.
 */
function clearingsOf(handoffs) {
  const seen = new Set();
  return [...handoffs].sort((a, b) => a.id - b.id).flatMap(({ id, type, epoch, tailCalls }) => {
    const segment = epoch - 1;
    if (type !== 'continue' || seen.has(segment)) return [];
    seen.add(segment);
    return [{ id, epoch, segment, tailCalls: countOf(tailCalls) }];
  });
}

/**
 * The steps that followed the committed compaction at place `at` of `committed` (ascending by id): the `stepN` of the compactions after it in its segment, none for one that has no `stepN`, and the `tail` the clear that cut the segment off counted after the segment's last carrier or checkpoint, zero where none did. A compaction's saving, and the step its settlement row says it sealed at, are made of this one figure.
 */
function followOf(committed, at, tail) {
  const segment = segmentOf(committed[at]);
  const later = committed.slice(at + 1).filter(next => segmentOf(next) === segment).reduce((sum, { stepN }) => sum + countOf(stepN), 0);
  // `later` sums sealed steps (`stepN` of `innerSource`) and the tail adds the monitor's own count of main calls (`tailCalls`); the two are different counts and their sum is the display figure of the steps that followed.
  return later + tail;
}

// Output is recorded but not priced by this report's two-price model.
function requestCostOf(usage, ratio) {
  const { input, cacheRead, cacheWrite } = usage ?? {};
  if (![input, cacheRead, cacheWrite, ratio].every(Number.isFinite)) return null;
  return cacheRead + ratio * (input + cacheWrite);
}

const neededOf = (cut, cost) => (cost === null || cut === null ? null : cut > 0 ? Math.ceil(Math.round(cost) / cut) : Infinity);
const gapOf = (needed, follow) => (Number.isFinite(needed) ? needed - follow : null);

// Rebuild prices only the first call's miss above read price.
function figuresOf({ contextChange, call, cRatio }, follow, cut) {
  const { miss } = contextChange ?? {};
  const summary = requestCostOf(call.usage, cRatio);
  if (!Number.isFinite(cut) || !Number.isFinite(miss) || summary === null) return null;
  const rebuild = (cRatio - 1) * miss;
  const cost = summary + rebuild;
  return cost > 0 ? { saved: Math.max(0, follow * cut), cost, rebuild } : null;
}

/**
 * The payback progress of each committed attempt of `attempts`, a Map from its id to a whole percent rounded down, or to null where it is not known; no other attempt has an entry. The progress is what the steps that followed the attempt within its segment have saved as a share of what the seal cost, both as `figuresOf` has them from the attempt's observed context change, `handoffs` being the host's handoff rows. It has no ceiling: a compaction keeps rising for as long as steps follow it.
 * A compaction reads zero where no step is known to have followed it, as the latest committed one of a segment that no clear cut off, and where its context did not shrink. The steps a `/sw-continue` clear cut off after the segment's last carrier or checkpoint count for every compaction of the segment it cleared.
 * It is a model with two prices, read and write, and not a bill: the cut is the first call after the seal against the last before it, the call's output is not priced, and the call is priced under the session's ratio whichever model it ran on.
 * It is for presentation alone; no row identity, selection or resource key reads it.
 */
export function paybackOf(attempts, handoffs = []) {
  const committed = attempts.filter(({ status }) => status === 'committed').sort((a, b) => a.id - b.id);
  const tails = new Map(clearingsOf(handoffs).map(({ segment, tailCalls }) => [segment, tailCalls]));
  return new Map(committed.map((attempt, at) => {
    const follow = followOf(committed, at, tails.get(segmentOf(attempt)) ?? 0);
    const delta = attempt.contextChange?.delta;
    const figures = figuresOf(attempt, follow, Number.isFinite(delta) ? -delta : null);
    return [attempt.id, figures === null ? null : paybackPercent(figures.saved, figures.cost)];
  }));
}

/**
 * The settlement of each segment a `/sw-continue` cleared, a Map from the id of the first continue that cleared it to `{ epoch, count, steps, saved, cost, rows }`: `epoch` the segment's display number, as its compactions' titles read it, `count` the committed compactions of the segment, `steps` the steps the segment ran, the `stepN` of those compactions that have one and the steps the clear cut off after the segment's last carrier or checkpoint (`tailCalls`), and `rows`, one per such compaction ascending by id. `saved` and `cost` are the sums of the rows whose figures are known.
 * A row is `{ id, ordinal, saved, cost, before, after, cut, follow, sealAt, costRebuild, needed, gap }`: `ordinal` the compaction's place in the segment as `ordinalsOf` gives it and `saved` and `cost` the figures `figuresOf` has, null for a compaction whose figures are not known; `before` and `after` the context around the seal and `cut` what it cut, `before − after`, each null where the row has no context to read it from, whether or not its figures are known. The host's optional `estimatedBefore` stands in for a missing `before` only here, including when the cut prices the saving; `after` and the cache rebuild still read the original post. The row also has `follow` the steps that followed it, the one figure its saving is made of and defined for every row, and `sealAt` the step the seal landed on, `steps − follow`, the steps that ran up to and with it; `costRebuild` the cost's rebuild term, null where the cost is not; `needed` the steps the compaction took to pay its cost back, the cost as it is shown (rounded) over the `cut` and rounded up, `Infinity` where the seal cut nothing, null where the figures or the `cut` are not known; and `gap` the steps `needed` less those it had, `follow`, null where `needed` is not a number.
 * A segment has an entry only when at least one of its compactions has figures. A load, a segment no continue cleared and a later continue of a cleared segment have none.
 * It is for presentation alone; no row identity, selection or resource key reads it.
 */
export function settlementsOf(attempts, handoffs) {
  const ordinals = ordinalsOf(attempts);
  const settlements = new Map();
  for (const { id, epoch, tailCalls } of clearingsOf(handoffs)) {
    const settlement = settlementForSegment(attempts, { epoch, tailCalls }, ordinals);
    if (settlement.rows.some(({ saved }) => saved !== null)) settlements.set(id, settlement);
  }
  return settlements;
}

/** Prices a segment at its given tail count, whether open or closed. Rows lacking figures still belong to the segment. */
export function settlementForSegment(attempts, { epoch, tailCalls }, ordinals = ordinalsOf(attempts)) {
  const compactions = attempts.filter(attempt => attempt.status === 'committed' && segmentOf(attempt) === epoch - 1).sort((a, b) => a.id - b.id);
  // `stepN` counts sealed steps; `tailCalls` instead counts main calls after the last seal.
  const steps = compactions.reduce((sum, { stepN }) => sum + countOf(stepN), tailCalls);
  const rows = compactions.map((attempt, at) => {
    const { before: rawBefore, after, delta } = attempt.contextChange ?? {};
    const estimated = rawBefore === null && Number.isFinite(attempt.estimatedBefore);
    const before = estimated ? attempt.estimatedBefore : rawBefore;
    const cut = Number.isFinite(before) && Number.isFinite(after) ? before - after : null;
    const follow = followOf(compactions, at, tailCalls);
    const figures = figuresOf(attempt, follow, estimated ? cut : Number.isFinite(delta) ? -delta : null);
    const needed = neededOf(cut, figures?.cost ?? null);
    return {
      id: attempt.id,
      ordinal: ordinals[attempt.id].ordinal,
      saved: figures?.saved ?? null,
      cost: figures?.cost ?? null,
      before: Number.isFinite(before) ? before : null,
      after: Number.isFinite(after) ? after : null,
      cut,
      follow,
      sealAt: steps - follow,
      costRebuild: figures?.rebuild ?? null,
      needed,
      gap: gapOf(needed, follow),
    };
  });
  const known = rows.filter(({ saved }) => saved !== null);
  return { epoch, count: rows.length, steps, saved: known.reduce((sum, row) => sum + row.saved, 0), cost: known.reduce((sum, row) => sum + row.cost, 0), rows };
}

/** Applies recall evidence to the segment's report, never to the list's settlement. */
export function settlementWithRecall(settlement, recall) {
  if (recall === undefined) return settlement;
  const cuts = new Map(recall.cuts.map(({ id, tokens }) => [id, tokens]));
  let cutCredit = 0;
  const rows = settlement.rows.map(row => {
    if (!cuts.has(row.id) || row.cut === null) return row;
    const cut = row.cut - cuts.get(row.id);
    const saved = row.saved === null ? null : row.follow * Math.max(0, cut);
    cutCredit += (row.saved ?? 0) - (saved ?? 0);
    const needed = neededOf(cut, row.cost);
    return { ...row, cut, saved, needed, gap: gapOf(needed, row.follow) };
  });
  const known = rows.filter(row => row.saved !== null);
  const byId = new Map(known.map(row => [row.id, row]));
  const adjustments = new Map();
  let requests = 0;
  let overlap = 0;
  let withdrawn = 0;
  let residence = 0;
  let partial = Boolean(recall.partial);
  for (const step of recall.steps) {
    if ('resident' in step) {
      residence += step.resident;
      adjustments.set(step.at, { saving: step.resident, cost: 0 });
      continue;
    }
    // A recall-only call has no counterpart in the baseline. Its full usage already pays for any resident copies.
    const saving = known.reduce((sum, row) => sum + (row.sealAt < step.at ? Math.max(0, row.cut ?? 0) : 0), 0);
    const cost = requestCostOf(step.usage, step.ratio);
    const rebuild = cost === null ? 0 : byId.get(step.post)?.costRebuild ?? 0;
    if (cost === null) partial = true;
    requests += cost ?? 0;
    overlap += rebuild;
    withdrawn += saving;
    adjustments.set(step.at, { saving, cost: (cost ?? 0) - rebuild });
  }
  return {
    ...settlement, rows, adjustments,
    saved: settlement.saved - cutCredit - withdrawn - residence,
    cost: settlement.cost + requests - overlap,
    recall: { requests, overlap, withdrawn, residence, cutCredit, partial },
  };
}

/** The fewest compactions with a finite number of needed steps whose median is told. */
const MEDIAN_MIN_COUNT = 3;

/**
 * The cumulative net of a segment's run, step by step, as `{ steps, net, seals, lowest, below, medianNeeded }`: `net[step]` for step 0 to `steps`, what the known compactions had saved less what they had cost by then, a seal's whole cost landing on the step it sealed at (`sealAt`) and its cut (`max(0, cut)`) accruing from the next step; `seals` the `sealAt` of every row, those with no figures included, ascending; `lowest` the first step with the least net, `{ value, at }`; `below` the runs of steps whose net is under zero, each `[first, last]`, the last running to `steps` where the segment ends below zero; and `medianNeeded` the median of the finite `needed` of the rows, null for fewer than `MEDIAN_MIN_COUNT` of them, the mean of the middle two for an even count.
 * A row with no figures takes nothing from the net. A recall correction withdraws saving or adds cost at the step it names. The end figure is the report's `saved` less its `cost`, up to floating-point accumulation.
 * `settlement` is an entry of `settlementsOf`, optionally adjusted by `settlementWithRecall`.
 */
export function paybackCurveOf({ steps, rows, adjustments }) {
  const known = rows.filter(({ saved }) => saved !== null).sort((a, b) => a.sealAt - b.sealAt);
  const net = [];
  let earnedPerStep = 0;
  let earned = 0;
  let spent = 0;
  let next = 0;
  for (let step = 0; step <= steps; step += 1) {
    earned += earnedPerStep;
    while (next < known.length && known[next].sealAt <= step) {
      spent += known[next].cost;
      earnedPerStep += Math.max(0, known[next].cut ?? 0);
      next += 1;
    }
    const adjustment = adjustments?.get(step);
    earned -= adjustment?.saving ?? 0;
    spent += adjustment?.cost ?? 0;
    net.push(earned - spent);
  }
  let lowest = { value: net[0], at: 0 };
  const below = [];
  let first = null;
  net.forEach((value, step) => {
    if (value < lowest.value) lowest = { value, at: step };
    if (value < 0) first ??= step;
    else if (first !== null) {
      below.push([first, step - 1]);
      first = null;
    }
  });
  if (first !== null) below.push([first, steps]);
  const needed = rows.map(row => row.needed).filter(Number.isFinite).sort((a, b) => a - b);
  const middle = Math.floor(needed.length / 2);
  const medianNeeded = needed.length < MEDIAN_MIN_COUNT ? null : needed.length % 2 === 1 ? needed[middle] : (needed[middle - 1] + needed[middle]) / 2;
  return { steps, net, seals: rows.map(row => row.sealAt).sort((a, b) => a - b), lowest, below, medianNeeded };
}

/** The share of the previous compaction's context, in percent, that a cache rebuild may exceed the context's growth by before it counts as unexpected. */
export const UNEXPECTED_MISS_PERCENT = 30;

/**
 * The ids, as a Set, of the committed attempts of `attempts` whose cache rebuild was unexpected. A compaction's rebuild (`miss`) is what the first call after it did not read from the cache; where the cache held, it is the context the segment grew by since the previous compaction, `after` less the previous one's `after`. The rebuild is unexpected when it exceeds that growth by more than `UNEXPECTED_MISS_PERCENT` of the previous compaction's `after`; a context that shrank has a negative growth.
 * The previous compaction is the nearest committed one before it in its segment, ascending by id: a failed, cancelled or running attempt is none, and a committed one whose own `after` is unknown is the previous one all the same, so the compaction after it has none to compare with. A compaction with no previous one, no known `after` or `miss`, or a previous `after` that is not positive is not in the Set.
 * It is for presentation alone; no row identity, selection or resource key reads it.
 */
export function unexpectedMissOf(attempts) {
  const committed = attempts.filter(({ status }) => status === 'committed').sort((a, b) => a.id - b.id);
  const previousAfter = new Map();
  const unexpected = new Set();
  for (const attempt of committed) {
    const { id, contextChange } = attempt;
    const segment = segmentOf(attempt);
    const { after, miss } = contextChange ?? {};
    const previous = previousAfter.get(segment);
    if (previous > 0 && Number.isFinite(after) && Number.isFinite(miss) && (miss - (after - previous)) * PERCENT > UNEXPECTED_MISS_PERCENT * previous) unexpected.add(id);
    previousAfter.set(segment, Number.isFinite(after) ? after : null);
  }
  return unexpected;
}

/** The status an attempt shows: `paid` for a committed one whose progress in `payback` (`paybackOf` over all the attempts and handoffs) has reached `PAID_BACK_PERCENT`, else its own status, which stays what the host gave and decides everything else. */
export const shownStatusOf = (attempt, payback) => (attempt.status === 'committed' && payback.get(attempt.id) >= PAID_BACK_PERCENT ? 'paid' : attempt.status);
