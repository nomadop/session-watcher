// dsh/src/client/monitor-state.js — the monitor view's pure state: the reducer of what is open, selected and how wide the drawer is, the rows the list shows with the attempts' display ordinals, the payback of the compactions and the settlement of the segment a clear cut off, the previews and elapsed times the rows show, and the scroll and width measures.
// Its defaults and bounds follow the native Stats and Trajectory tables (`totalSpan`, `clampDetailsWidth`, `BOTTOM_FOLLOW_THRESHOLD_PX`), without the trajectory table's tool column; a container too narrow for the drawer is left to a CSS container query.
import { ACTIVE_STATUSES } from './monitor-store.js';

/** The width the drawer starts at. A resize keeps it between `DRAWER_MIN_WIDTH` and `DRAWER_MAX_WIDTH`, and leaves the list `LIST_MIN_WIDTH`. */
export const DRAWER_DEFAULT_WIDTH = 420;
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 720;
export const LIST_MIN_WIDTH = 280;
/** The width one key press on the resize handle moves the drawer by. */
export const DRAWER_KEY_STEP = 16;
/** The longest text a preview keeps, before its ellipsis. */
export const PREVIEW_CHARS = 160;
/** The text of a value the row or the detail has none of. */
export const NOT_AVAILABLE = '—';

const FAILED_STATUSES = ['failed', 'cancelled'];
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/** A new view: `overrides` holds the user's choice of open or closed by attempt or handoff id, `selected` the selected row's `{ identity, kind, attemptId, slotKey }` (a handoff's content, turn or settlement row `{ identity, kind, handoffId, turn }`) or null, `drawerWidth` the drawer's width. */
export function createViewState() {
  return { overrides: {}, selected: null, drawerWidth: DRAWER_DEFAULT_WIDTH };
}

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
 * The first `/sw-continue` clear of each segment, ascending by id, as `{ id, epoch, segment, tailSteps }`: `segment` the epoch count of the compactions it cleared, one less than the `epoch` of its row, which counts the boundaries before its payload, and `tailSteps` the steps it cut off after the segment's last carrier or checkpoint, zero where the row has none. A load and any later continue of a segment are none of them.
 */
function clearingsOf(handoffs) {
  const seen = new Set();
  return [...handoffs].sort((a, b) => a.id - b.id).flatMap(({ id, type, epoch, tailSteps }) => {
    const segment = epoch - 1;
    if (type !== 'continue' || seen.has(segment)) return [];
    seen.add(segment);
    return [{ id, epoch, segment, tailSteps: countOf(tailSteps) }];
  });
}

/**
 * What each committed attempt of `attempts` saved and cost, a Map from its id to `{ saved, cost }` in read-price tokens, or to null where it is not known; no other attempt has an entry. The cost is its summary call (`cacheRead` at read price, `input` and `cacheWrite` at write price, `cRatio` times) and the rebuild of the cache by the first call after it (`miss` beyond read price, `(cRatio − 1) × miss`). The saving is the context the seal cut per step, times the steps that followed it within its segment: the `stepN` of the committed attempts after it in its segment, ascending by id, never its own `stepN`, which is steps before it, and, where a clear cut the segment off, the steps it cut off after the segment's last carrier or checkpoint (`tailSteps` of the first continue that cleared it). An attempt with no `stepN` adds none, and neither does a failed, cancelled or running one; a context that did not shrink saves nothing.
 * It is null where the cut, the rebuild, the ratio or the call's usage is missing, or the cost is not positive.
 */
function economicsOf(attempts, handoffs) {
  const committed = attempts.filter(({ status }) => status === 'committed').sort((a, b) => a.id - b.id);
  const tails = new Map(clearingsOf(handoffs).map(({ segment, tailSteps }) => [segment, tailSteps]));
  return new Map(committed.map((attempt, at) => {
    const { delta, miss } = attempt.contextChange ?? {};
    const { input, cacheRead, cacheWrite } = attempt.call.usage ?? {};
    const { cRatio } = attempt;
    if (![delta, miss, cRatio, input, cacheRead, cacheWrite].every(Number.isFinite)) return [attempt.id, null];
    const cost = cacheRead + cRatio * (input + cacheWrite) + (cRatio - 1) * miss;
    if (!(cost > 0)) return [attempt.id, null];
    const segment = segmentOf(attempt);
    const later = committed.slice(at + 1).filter(next => segmentOf(next) === segment).reduce((sum, { stepN }) => sum + countOf(stepN), 0);
    return [attempt.id, { saved: Math.max(0, (later + (tails.get(segment) ?? 0)) * -delta), cost }];
  }));
}

/**
 * The payback progress of each committed attempt of `attempts`, a Map from its id to a whole percent rounded down, or to null where it is not known; no other attempt has an entry. The progress is what the steps that followed the attempt within its segment have saved as a share of what the seal cost, both as `economicsOf` has them, `handoffs` being the host's handoff rows. It has no ceiling: a compaction keeps rising for as long as steps follow it.
 * A compaction reads zero where no step is known to have followed it, as the latest committed one of a segment that no clear cut off, and where its context did not shrink. The steps a `/sw-continue` clear cut off after the segment's last carrier or checkpoint count for every compaction of the segment it cleared.
 * It is a model with two prices, read and write, and not a bill: the cut is the first call after the seal against the last before it, the call's output is not priced, and the call is priced under the session's ratio whichever model it ran on.
 * It is for presentation alone; no row identity, selection or resource key reads it.
 */
export function paybackOf(attempts, handoffs = []) {
  return new Map([...economicsOf(attempts, handoffs)].map(([id, figures]) => [id, figures === null ? null : paybackPercent(figures.saved, figures.cost)]));
}

/**
 * The settlement of each segment a `/sw-continue` cleared, a Map from the id of the first continue that cleared it to `{ epoch, count, steps, saved, cost, rows }`: `epoch` the segment's display number, as its compactions' titles read it, `count` the committed compactions of the segment, `steps` the steps the segment ran, the `stepN` of those compactions that have one and the steps the clear cut off after the segment's last carrier or checkpoint (`tailSteps`), and `rows`, one per such compaction ascending by id, `{ id, ordinal, saved, cost }` with `ordinal` its place in the segment as `ordinalsOf` gives it and the figures `economicsOf` has, null for a compaction whose figures are not known. `saved` and `cost` are the sums of the rows whose figures are known.
 * A segment has an entry only when at least one of its compactions has figures. A load, a segment no continue cleared and a later continue of a cleared segment have none.
 * It is for presentation alone; no row identity, selection or resource key reads it.
 */
export function settlementsOf(attempts, handoffs) {
  const economics = economicsOf(attempts, handoffs);
  const ordinals = ordinalsOf(attempts);
  const settlements = new Map();
  for (const { id, epoch, segment, tailSteps } of clearingsOf(handoffs)) {
    const compactions = attempts.filter(attempt => attempt.status === 'committed' && segmentOf(attempt) === segment).sort((a, b) => a.id - b.id);
    const rows = compactions.map((attempt) => {
      const figures = economics.get(attempt.id);
      return { id: attempt.id, ordinal: ordinals[attempt.id].ordinal, saved: figures?.saved ?? null, cost: figures?.cost ?? null };
    });
    const known = rows.filter(({ saved }) => saved !== null);
    if (known.length === 0) continue;
    const steps = compactions.reduce((sum, { stepN }) => sum + countOf(stepN), tailSteps);
    settlements.set(id, { epoch, count: rows.length, steps, saved: known.reduce((sum, row) => sum + row.saved, 0), cost: known.reduce((sum, row) => sum + row.cost, 0), rows });
  }
  return settlements;
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

/** Whether the group of the attempt or handoff `id` shows open: as the user chose where they did, else closed. The id of an attempt and the id of a handoff are seqs of different events, so no id names both. */
export function isOpen(state, id) {
  return state.overrides[id] ?? false;
}

/** The segment a handoff's title names: the host's count of the epoch boundaries before its payload, plus one. */
export const handoffSegmentOf = ({ epoch }) => epoch + 1;

/** The identity of a row, made of its kind (`attempt`, `call`, `slot`, `handoff`, `settlement`, `content`, `turn` or `placeholder`), its attempt or handoff id and, for a slot, the slot's key, the seq it starts at, and for a turn its place in its handoff's turns; no list position of the rows takes part. A settlement is of the handoff that cleared the segment and has its own kind. */
export function rowIdentity({ kind, attemptId, slotKey, handoffId, turn }) {
  switch (kind) {
    case 'slot': return `slot:${attemptId}:${slotKey}`;
    case 'handoff':
    case 'settlement':
    case 'content': return `${kind}:${handoffId}`;
    case 'turn': return `turn:${handoffId}:${turn}`;
    default: return `${kind}:${attemptId}`;
  }
}

/**
 * The state after `action`, never changed in place; an action that changes nothing answers the state it was given.
 * `{ type: 'toggle', attemptId, open }` (a handoff's `handoffId` in its place) is a click on the parent row of a group that showed `open`; the user's choice becomes the opposite, and the selection stays.
 * `{ type: 'select', kind, attemptId, slotKey }` selects a `call` or a `slot` row, `{ type: 'select', kind, handoffId, turn }` a handoff's `content` or `turn` row or the `settlement` of the segment it cleared: the identity already selected stays selected, another replaces it, and the expansion stays.
 * `{ type: 'clear' }` selects nothing.
 * `{ type: 'resize', width, containerWidth }` sets the drawer to `clampDrawerWidth(width, containerWidth)`.
 */
export function reduceView(state, action) {
  switch (action.type) {
    case 'toggle': return { ...state, overrides: { ...state.overrides, [action.handoffId ?? action.attemptId]: !action.open } };
    case 'select': {
      const identity = rowIdentity(action);
      if (state.selected?.identity === identity) return state;
      if (action.handoffId !== undefined) return { ...state, selected: { identity, kind: action.kind, handoffId: action.handoffId, turn: action.kind === 'turn' ? action.turn : null } };
      const slotKey = action.kind === 'slot' ? action.slotKey : null;
      return { ...state, selected: { identity, kind: action.kind, attemptId: action.attemptId, slotKey } };
    }
    case 'clear': return state.selected === null ? state : { ...state, selected: null };
    case 'resize': return { ...state, drawerWidth: clampDrawerWidth(action.width, action.containerWidth) };
    default: return state;
  }
}

/** The unit the drawer's own token counts carry; the list's metadata is compact and carries none. */
export const TOKEN_UNIT = 'token';

/**
 * What a committed seal did to the context, in words: `change` is the row's `{ before, after, delta }`, and a dash stands where there is none, the host sent none or a main call is missing; the sign is never shown.
 * The list and the usage page both read it, so they never disagree on the direction; the usage page hands `TOKEN_UNIT` as `unit`, which follows the number once, and the list hands none. An unchanged context shows no number and so no unit.
 */
export function contextChangeText(change, t, unit) {
  const delta = change?.delta;
  if (!Number.isFinite(delta)) return NOT_AVAILABLE;
  if (delta === 0) return t('monitor.change.same');
  const count = unit === undefined ? Math.abs(delta) : `${Math.abs(delta)} ${unit}`;
  return t(delta > 0 ? 'monitor.change.increase' : 'monitor.change.decrease', { count });
}

/** The tokens of the first call after the seal that the cache did not serve, for the list's line, a dash where the row has none. */
export function contextMissText(change, t) {
  return Number.isFinite(change?.miss) ? t('monitor.meta.miss', { count: change.miss }) : NOT_AVAILABLE;
}

/** A token count as the list shows it, a dash where the host sent none. */
const numberOrDash = value => (Number.isFinite(value) ? value : NOT_AVAILABLE);

/** A token count as the drawer's usage page shows it, followed by `TOKEN_UNIT`, a dash where the host sent none. */
export const tokensOf = value => (Number.isFinite(value) ? `${value} ${TOKEN_UNIT}` : NOT_AVAILABLE);

/** The tokens before and after the seal as the list's one line in the words of `key`, a dash for each that is missing and for a row with no change; a compaction's words are the default and a handoff hands its own. */
export function contextRangeText(change, t, key = 'monitor.meta.range') {
  if (change === null || change === undefined) return NOT_AVAILABLE;
  return t(key, { before: numberOrDash(change.before), after: numberOrDash(change.after) });
}

// The text on one line: its whitespace folded to single spaces and trimmed.
const foldedOf = text => text.replace(/\s+/g, ' ').trim();

/** The text on one line, cut to `PREVIEW_CHARS` with an ellipsis where it was longer: a slot's two sides share the row, so each is bounded. */
export function previewOf(text) {
  const compact = foldedOf(text);
  return compact.length > PREVIEW_CHARS ? `${compact.slice(0, PREVIEW_CHARS).trimEnd()}…` : compact;
}

// The text a field of the host's row shows: the display the host computed, else the raw field of a host that sent no display. Only an absent display falls back; a null or empty one is the host's answer.
const displayOf = (display, raw) => (display === undefined ? raw : display);

// A text alone as a preview, null where there is none to show. It is folded and not cut: the row's whole width is its alone, and the stylesheet's ellipsis ends it there; the host bounds the text.
function wholePreview(text) {
  const output = text === null ? '' : foldedOf(text);
  return { output: output === '' ? null : output };
}

// A call's response alone; an attempt that failed or was cancelled shows its reason in the response's place.
function callPreview({ status, reason, call }) {
  return wholePreview(FAILED_STATUSES.includes(status) && reason !== null ? reason : displayOf(call.outputDisplay, call.output));
}

const SOURCE_CATEGORIES = { 'system/message': 'system', 'developer/message': 'developer', 'tool/result': 'tool', 'assistant/message': 'assistant' };
const HUMAN_SOURCE_KIND = 'user';

/**
 * The category of a slot's `source`, `{ type, kind }` of its first event: `user` for a user message whose recorded kind is the human's, `injected` for a user message of any other recorded kind, `system`, `developer`, `tool` or `assistant` by the event type, else `other`.
 * An absent source, an event type it does not know and a user message that records no kind are `other`; no list of producers takes part.
 */
export function sourceCategoryOf(source) {
  if (source?.type === 'user/message') {
    if (typeof source.kind !== 'string') return 'other';
    return source.kind === HUMAN_SOURCE_KIND ? 'user' : 'injected';
  }
  return SOURCE_CATEGORIES[source?.type] ?? 'other';
}

/** What joins the parts of one line. */
export const PART_SEPARATOR = ' · ';

/** A slot's title, from the `turn`, `step` and `source` the host's slot list and slot detail both carry: its turn and step, whichever it has, else the category of its recorded source. */
export function slotTitleOf({ turn, step, source }, t) {
  const parts = [turn === null ? null : t('monitor.object.turn', { turn }), step === null ? null : t('monitor.object.step', { step })].filter(part => part !== null);
  return parts.length === 0 ? t(`monitor.source.${sourceCategoryOf(source)}`) : parts.join(PART_SEPARATOR);
}

/** What `flattenRows` takes in the place of a group's list of leaves while the list is being read, and where it could not be read; a list that is ready is the list itself. */
export const LEAVES_LOADING = 'loading';
export const LEAVES_FAILED = 'failed';

// The row that stands in a group's place of leaves where it has none to list: `state` is `loading`, `failed` or `empty`, `owner` `{ attempt }` or `{ handoff }`, the group's own.
const placeholderRow = (id, owner, state) => ({ identity: rowIdentity({ kind: 'placeholder', attemptId: id }), kind: 'placeholder', ...owner, state });

// The rows of a group's leaves, `leafOf(entry, at)` of each entry of its ready `list`; where the list is still being read, could not be read or is empty, the placeholder in their place, and nothing for a list never asked for.
function leafRows(id, owner, list, leafOf) {
  if (list === undefined) return [];
  if (list === LEAVES_LOADING || list === LEAVES_FAILED) return [placeholderRow(id, owner, list)];
  return list.length === 0 ? [placeholderRow(id, owner, 'empty')] : list.map(leafOf);
}

/**
 * The rows the list shows for `attempts` and `handoffs`, both the host's rows, in one order by id (the seqs of the events they began at), under the view `state`.
 * Each attempt has its own row `{ identity, kind: 'attempt', attempt, epoch, ordinal, shownStatus, missWarned, open, preview }`, `epoch` and `ordinal` as `ordinalsOf` gives them over all the attempts (a handoff takes no number from them), `shownStatus` as `shownStatusOf` gives it with `paybackOf` of all the attempts and handoffs, `missWarned` whether `unexpectedMissOf` over all the attempts names it, and an open one its call row `{ identity, kind: 'call', attempt, preview }`
 * and, only where it is committed and has an entry in `slotsByAttempt` (the slots lists by attempt id), a slot row `{ identity, kind: 'slot', attempt, slot, preview }` per slot in source order.
 * Each handoff has its own row `{ identity, kind: 'handoff', handoff, open, preview }`, in front of it, whether it is open or not, the settlement row `{ identity, kind: 'settlement', handoff, settlement }` of the segment it cleared where `settlementsOf` has one, and an open one its content row `{ identity, kind: 'content', handoff, preview }`
 * and, only where it has an entry in `turnsByHandoff` (the turns lists by handoff id), a turn row `{ identity, kind: 'turn', handoff, at, turn, preview }` per turn in page order, `turn` the host's `{ address, user, note }` and `at` its place among them.
 * An entry is the list itself or, while the list is being read or where it could not be read, `LEAVES_LOADING` or `LEAVES_FAILED`; an open group whose entry is one of those or an empty list has one placeholder row `{ identity, kind: 'placeholder', attempt | handoff, state }` in the place of its leaves, `state` being `loading`, `failed` or `empty`; a group with no entry, and a compaction that is not committed, has none.
 * Every group is closed unless the user opened it.
 * `preview` is of an attempt or its call `{ output }`, the one-line response as the host displays it, `outputDisplay`, else the raw `output` of a host that sent none (null where there is no text to show), a reason in its place where the attempt failed or was cancelled; of a handoff or its content row `{ output }`, its next task in the same way; of a slot `{ input, output }`, its source as the host displays it, `inputDisplay`, else its `input`, and its C string; of a turn `{ input, output }`, its user text and its note, an empty string for a note it has none of.
 */
export function flattenRows(attempts, slotsByAttempt, state, handoffs = [], turnsByHandoff = {}) {
  const ordinals = ordinalsOf(attempts);
  const payback = paybackOf(attempts, handoffs);
  const settlements = settlementsOf(attempts, handoffs);
  const unexpectedMiss = unexpectedMissOf(attempts);
  const groups = [...attempts.map(attempt => ({ id: attempt.id, attempt })), ...handoffs.map(handoff => ({ id: handoff.id, handoff }))].sort((a, b) => a.id - b.id);
  const rows = [];
  for (const { id, attempt, handoff } of groups) {
    const open = isOpen(state, id);
    if (handoff !== undefined) {
      const settlement = settlements.get(id);
      if (settlement !== undefined) rows.push({ identity: rowIdentity({ kind: 'settlement', handoffId: id }), kind: 'settlement', handoff, settlement });
      const preview = wholePreview(handoff.nextTask);
      rows.push({ identity: rowIdentity({ kind: 'handoff', handoffId: id }), kind: 'handoff', handoff, open, preview });
      if (!open) continue;
      rows.push({ identity: rowIdentity({ kind: 'content', handoffId: id }), kind: 'content', handoff, preview });
      rows.push(...leafRows(id, { handoff }, turnsByHandoff[id], (turn, at) => ({
        identity: rowIdentity({ kind: 'turn', handoffId: id, turn: at }),
        kind: 'turn',
        handoff,
        at,
        turn,
        preview: { input: previewOf(turn.user), output: previewOf(turn.note ?? '') },
      })));
      continue;
    }
    const preview = callPreview(attempt);
    rows.push({ identity: rowIdentity({ kind: 'attempt', attemptId: id }), kind: 'attempt', attempt, ...ordinals[id], shownStatus: shownStatusOf(attempt, payback), missWarned: unexpectedMiss.has(id), open, preview });
    if (!open) continue;
    rows.push({ identity: rowIdentity({ kind: 'call', attemptId: id }), kind: 'call', attempt, preview });
    const slots = attempt.status === 'committed' ? slotsByAttempt[id] : undefined;
    rows.push(...leafRows(id, { attempt }, slots, slot => ({
      identity: rowIdentity({ kind: 'slot', attemptId: id, slotKey: slot.key }),
      kind: 'slot',
      attempt,
      slot,
      preview: { input: previewOf(displayOf(slot.inputDisplay, slot.input)), output: previewOf(slot.output) },
    })));
  }
  return rows;
}

/**
 * The elapsed milliseconds of an attempt (`part` is `'attempt'`) or of its call (`'call'`), null where there is none to show.
 * Both start at the attempt's recorded start. A finished one ends at its own recorded time, the attempt's terminal fact or the end of the call's stream, so neither takes the other's end; one still running reads `now`, never below zero.
 * No start is inferred, from a first chunk or otherwise: an attempt without one has no elapsed time, nor has an unknown attempt or a call that was never recorded.
 */
export function elapsedOf(attempt, part, now) {
  const { startedAt } = attempt;
  if (startedAt === null) return null;
  const endedAt = part === 'call' ? attempt.call.endedAt : attempt.endedAt;
  if (endedAt !== null) return endedAt - startedAt;
  const running = part === 'call' ? attempt.call.state === 'generating' : ACTIVE_STATUSES.includes(attempt.status);
  return running ? Math.max(0, now - startedAt) : null;
}

/** An elapsed span as text: whole milliseconds under a second, seconds to a tenth under a minute, else minutes and whole seconds. */
export function formatElapsed(ms) {
  if (ms < MS_PER_SECOND) return `${ms} ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)} s`;
  return `${Math.floor(ms / MS_PER_MINUTE)} m ${Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND)} s`;
}

/** The drawer width `width` brought within the bounds, leaving the list `LIST_MIN_WIDTH` of a container `containerWidth` wide where the bounds allow, in whole pixels. */
export function clampDrawerWidth(width, containerWidth) {
  const max = Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, containerWidth - LIST_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, DRAWER_MIN_WIDTH), max));
}
