// dsh/src/client/monitor-state.js — the monitor view's pure state: the reducer of what is open, selected, filtered and how wide the drawer is, the rows the list shows, the previews and elapsed times the rows show, and the scroll and width measures.
// Its defaults and bounds follow the native Stats and Trajectory tables (`totalSpan`, `clampDetailsWidth`, `BOTTOM_FOLLOW_THRESHOLD_PX`), without the trajectory table's tool column; a container too narrow for the drawer is left to a CSS container query.
import { ACTIVE_STATUSES } from './monitor-store.js';
import { ordinalsOf, paybackOf, settlementsOf, unexpectedMissOf, isColdCall, shownStatusOf } from '../../../public/lib/compactionEconomics.js';

/** The width the drawer starts at. A resize keeps it between `DRAWER_MIN_WIDTH` and `DRAWER_MAX_WIDTH`, and leaves the list `LIST_MIN_WIDTH`. */
export const DRAWER_DEFAULT_WIDTH = 420;
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 720;
/** The inline padding of the drawer's body, on each side, which the stylesheet takes from here. */
export const DRAWER_BODY_PADDING_X = 14;
/** The width a chart of the settlement drawer takes until its container is measured: the default drawer's body, which is the drawer less the body's inline padding. */
export const DEFAULT_CHART_WIDTH = DRAWER_DEFAULT_WIDTH - 2 * DRAWER_BODY_PADDING_X;
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

/** The categories of event the list's filter takes: every one, the handoffs with the settlements before them, and the compactions. */
export const FILTER_CATEGORIES = ['all', 'handoff', 'compaction'];

/** A new view: `overrides` holds the open choice by attempt or handoff id, `selected` the drawer selection or null, `drawerWidth` the drawer's width, and `filter` the selected category and warnings filter. */
export function createViewState() {
  return { overrides: {}, selected: null, drawerWidth: DRAWER_DEFAULT_WIDTH, filter: { category: 'all', warned: false } };
}

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
 * `{ type: 'open-current-settlement', request }` opens the current settlement drawer with a pending result. `{ type: 'current-settlement-result', request, result }` fills it only if that opening is still selected.
 * `{ type: 'clear' }` selects nothing.
 * `{ type: 'resize', width, containerWidth }` sets the drawer to `clampDrawerWidth(width, containerWidth)`.
 * `{ type: 'category', category }` and `{ type: 'warned', warned }` set a part of the filter: a part that changes closes the drawer whether the selected row stays listed or not, and the expansion stays; the value it already has changes nothing.
 * `{ type: 'collapse' }` drops every choice of the user's, so that every group is closed again, and leaves the selection; with no group open it changes nothing.
 */
export function reduceView(state, action) {
  switch (action.type) {
    case 'toggle': return { ...state, overrides: { ...state.overrides, [action.handoffId ?? action.attemptId]: !action.open } };
    case 'open-current-settlement':
      return { ...state, selected: { identity: 'current-settlement', kind: 'current-settlement', request: action.request, result: null } };
    case 'current-settlement-result':
      return state.selected?.request !== action.request ? state : { ...state, selected: { ...state.selected, result: action.result } };
    case 'select': {
      const identity = rowIdentity(action);
      if (state.selected?.identity === identity) return state;
      if (action.handoffId !== undefined) return { ...state, selected: { identity, kind: action.kind, handoffId: action.handoffId, turn: action.kind === 'turn' ? action.turn : null } };
      const slotKey = action.kind === 'slot' ? action.slotKey : null;
      return { ...state, selected: { identity, kind: action.kind, attemptId: action.attemptId, slotKey } };
    }
    case 'clear': return state.selected === null ? state : { ...state, selected: null };
    case 'category': return action.category === state.filter.category ? state : { ...state, selected: null, filter: { ...state.filter, category: action.category } };
    case 'warned': return action.warned === state.filter.warned ? state : { ...state, selected: null, filter: { ...state.filter, warned: action.warned } };
    case 'collapse': return Object.values(state.overrides).includes(true) ? { ...state, overrides: {} } : state;
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

/** What joins the parts of one line. */
export const PART_SEPARATOR = ' · ';

/** A slot's title, from the `turn`, `step` and `source` the host's slot list and slot detail both carry: its turn and step, whichever it has, else the `category` the host names its source by, `other` where a host sends none. */
export function slotTitleOf({ turn, step, source }, t) {
  const parts = [turn === null ? null : t('monitor.object.turn', { turn }), step === null ? null : t('monitor.object.step', { step })].filter(part => part !== null);
  return parts.length === 0 ? t(`monitor.source.${source?.category ?? 'other'}`) : parts.join(PART_SEPARATOR);
}

/** What `flattenRows` takes in the place of a group's list of leaves while the list is being read, and where it could not be read; a list that is ready is the list itself. */
export const LEAVES_LOADING = 'loading';
export const LEAVES_FAILED = 'failed';

// The row that stands in a group's place of leaves where it has none to list: `state` is `loading`, `failed` or `empty`, `owner` `{ attempt }` or `{ handoff }`, the group's own.
const placeholderRow = (id, owner, state) => ({ identity: rowIdentity({ kind: 'placeholder', attemptId: id }), kind: 'placeholder', ...owner, state });

// A ready list shows its included leaves; placeholders describe the resource, not the filter.
function leafRows(id, owner, list, leafOf, include) {
  if (list === undefined) return [];
  if (list === LEAVES_LOADING || list === LEAVES_FAILED) return [placeholderRow(id, owner, list)];
  if (list.length === 0) return [placeholderRow(id, owner, 'empty')];
  return (include === undefined ? list : list.filter(include)).map(leafOf);
}

/** The fewest output tokens a committed summary call is expected to answer with; one that answered with less is short. */
export const SHORT_SUMMARY_OUTPUT = 500;

/** Whether a committed attempt's summary call is short; a call that did not commit, or has no usage, is not. The minimum is the same for every step count. */
const isShortSummary = ({ status, call }) => status === 'committed' && call.usage !== null && call.usage.output < SHORT_SUMMARY_OUTPUT;

/** The warning text keys of an attempt's cost readings, shared by its parent row and its call row: `context` and `miss` are the parent's own readings, `call` the cold summary call (`isColdCall`) and `short` the short one (`isShortSummary`), which the parent row only carries as a signal and the call row words. */
export function costWarningsOf(attempt, missWarned) {
  const { contextChange, call } = attempt;
  return {
    ...(contextChange?.delta > 0 && { context: 'monitor.meta.context.grew' }),
    ...(missWarned && { miss: 'monitor.meta.miss.unexpected' }),
    ...(isColdCall(call.usage, contextChange?.before) && { call: 'monitor.meta.call.cold' }),
    ...(isShortSummary(attempt) && { short: 'monitor.meta.call.short' }),
  };
}

/** How many slots of an attempt have a warning, without loading the slots. */
export const slotWarningCount = ({ slotWarnings }) => (slotWarnings === undefined ? 0 : Object.keys(slotWarnings).length);

/** Whether an attempt has a slot warning, without loading the slots. */
export const hasSlotWarnings = attempt => slotWarningCount(attempt) > 0;

/** The attempts and handoffs in `filter`'s category, in their given order. The warning filter keeps a compaction with a slot warning, context growth, an unexpected cache rebuild, a cold summary call or a short one. */
export function visibleGroups(attempts, handoffs, { category, warned }) {
  const unexpectedMiss = unexpectedMissOf(attempts);
  return {
    attempts: category === 'handoff' ? [] : attempts.filter(attempt => !warned || hasSlotWarnings(attempt) || Object.keys(costWarningsOf(attempt, unexpectedMiss.has(attempt.id))).length > 0),
    handoffs: category === 'compaction' || warned ? [] : handoffs,
  };
}

/**
 * The rows the list shows for `attempts` and `handoffs`, both the host's rows, in one order by id (the seqs of the events they began at), under the view `state`.
 * Each attempt has its own row `{ identity, kind: 'attempt', attempt, epoch, ordinal, shownStatus, missWarned, open, preview }`, `epoch` and `ordinal` as `ordinalsOf` gives them over all the attempts (a handoff takes no number from them), `shownStatus` as `shownStatusOf` gives it with `paybackOf` of all the attempts and handoffs, `missWarned` whether `unexpectedMissOf` over all the attempts names it, and an open one its call row `{ identity, kind: 'call', attempt, preview, warningKeys }`, with warning text keys from `costWarningsOf`,
 * and, where the open, committed attempt has a slot list, its slots in source order.
 * Each handoff has its own row `{ identity, kind: 'handoff', handoff, open, preview }`, in front of it, whether it is open or not, the settlement row `{ identity, kind: 'settlement', handoff, settlement }` of the segment it cleared where `settlementsOf` has one, and an open one its content row `{ identity, kind: 'content', handoff, preview }`
 * and, only where it has an entry in `turnsByHandoff` (the turns lists by handoff id), a turn row `{ identity, kind: 'turn', handoff, at, turn, preview }` per turn in page order, `turn` the host's `{ address, user, note }` and `at` its place among them.
 * An entry is the list itself or, while the list is being read or where it could not be read, `LEAVES_LOADING` or `LEAVES_FAILED`; an open group whose entry is one of those or an empty list has one placeholder row `{ identity, kind: 'placeholder', attempt | handoff, state }` in the place of its leaves, `state` being `loading`, `failed` or `empty`; a group with no entry, and a compaction that is not committed, has none.
 * Every group is closed unless the user opened it.
 * Only the groups `visibleGroups` lists under `state.filter` have rows. The warning filter also hides unmarked call and slot rows; numbers, statuses and settlements still use all the attempts and handoffs.
 * `preview` is of an attempt or its call `{ output }`, the one-line response as the host displays it, `outputDisplay`, else the raw `output` of a host that sent none (null where there is no text to show), a reason in its place where the attempt failed or was cancelled; of a handoff or its content row `{ output }`, its next task in the same way; of a slot `{ input, output }`, its source as the host displays it, `inputDisplay`, else its `input`, and its C string; of a turn `{ input, output }`, its user text and its note, an empty string for a note it has none of.
 */
export function flattenRows(attempts, slotsByAttempt, state, handoffs = [], turnsByHandoff = {}) {
  const ordinals = ordinalsOf(attempts);
  const payback = paybackOf(attempts, handoffs);
  const settlements = settlementsOf(attempts, handoffs);
  const unexpectedMiss = unexpectedMissOf(attempts);
  const shown = visibleGroups(attempts, handoffs, state.filter);
  const { warned } = state.filter;
  const groups = [...shown.attempts.map(attempt => ({ id: attempt.id, attempt })), ...shown.handoffs.map(handoff => ({ id: handoff.id, handoff }))].sort((a, b) => a.id - b.id);
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
    const missWarned = unexpectedMiss.has(id);
    rows.push({ identity: rowIdentity({ kind: 'attempt', attemptId: id }), kind: 'attempt', attempt, ...ordinals[id], shownStatus: shownStatusOf(attempt, payback), missWarned, open, preview });
    if (!open) continue;
    const warningKeys = Object.values(costWarningsOf(attempt, missWarned));
    if (!warned || warningKeys.length > 0) rows.push({ identity: rowIdentity({ kind: 'call', attemptId: id }), kind: 'call', attempt, preview, warningKeys });
    const slots = attempt.status === 'committed' && (!warned || hasSlotWarnings(attempt)) ? slotsByAttempt[id] : undefined;
    rows.push(...leafRows(id, { attempt }, slots, slot => ({
      identity: rowIdentity({ kind: 'slot', attemptId: id, slotKey: slot.key }),
      kind: 'slot',
      attempt,
      slot,
      preview: { input: previewOf(displayOf(slot.inputDisplay, slot.input)), output: previewOf(slot.output) },
    }), warned ? slot => attempt.slotWarnings?.[slot.key]?.length > 0 : undefined));
  }
  return rows;
}

/**
 * The elapsed milliseconds of an attempt (`part` is `'attempt'`) or of its call (`'call'`), null where there is none to show.
 * Both start at the attempt's recorded start. A finished one ends at its own recorded time, the attempt's terminal fact or the end of the call's stream, so neither takes the other's end; one still running reads `now`, never below zero.
 * No start is inferred, from a first chunk or otherwise: an unknown attempt and a call that was never recorded have no elapsed time.
 */
export function elapsedOf(attempt, part, now) {
  const { startedAt } = attempt;
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
