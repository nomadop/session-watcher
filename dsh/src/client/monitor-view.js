// dsh/src/client/monitor-view.js — the monitor's toolbar, event list and detail drawer, which can also show the current settlement without a selected row.
import React from 'react';
import { ACTIVE_STATUSES } from './monitor-store.js';
import { CallDetail, SlotDetail, HandoffDetail, TurnDetail, SettlementDetail, CurrentSettlementDetail, DetailBody, SLOTS_ENDPOINT } from './monitor-drawer.js';
import { Notice, useResult } from './monitor-handle.js';
import {
  createViewState, reduceView, flattenRows, visibleGroups, isOpen, hasSlotWarnings, FILTER_CATEGORIES, LEAVES_LOADING, LEAVES_FAILED, slotTitleOf, handoffSegmentOf, NOT_AVAILABLE, PART_SEPARATOR, DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_KEY_STEP,
} from './monitor-state.js';
import { ordinalsOf, paybackOf, settlementsOf } from '../../../public/lib/compactionEconomics.js';
import { settlementViewOf } from './monitor-recall-model.js';
import { parentMetaParts, handoffMetaParts, handoffTitle, settlementMetaParts } from './monitor-model.js';

const h = React.createElement;

/** The period of the display clock, which the running times follow while an attempt is in progress, in milliseconds. */
const CLOCK_TICK_MS = 1000;

const ROW_LEVELS = { attempt: 1, call: 2, slot: 2, handoff: 1, settlement: 1, content: 2, turn: 2, placeholder: 2 };

// A row's title: the attempt by its display segment and ordinal, the call by its name, a slot by its turn and step, else by the category of its recorded source, a handoff by its segment, a settlement by the segment it settles, its content row by its name and a turn by its place among the handoff's turns.
function titleOf(row, t) {
  switch (row.kind) {
    case 'attempt': return t('monitor.object.attempt', { epoch: row.epoch, ordinal: row.ordinal });
    case 'call': return t('monitor.object.call');
    case 'handoff': return handoffTitle(row.handoff, t);
    case 'settlement': return t('monitor.object.settlement', { epoch: row.settlement.epoch });
    case 'content': return t('monitor.object.handoffContent');
    case 'turn': return t('monitor.object.handoffTurn', { n: row.at + 1 });
    default: return slotTitleOf(row.slot, t);
  }
}

// The neutral marker a row's right side shows in place of text it has none of: a slot's empty C string, and a turn's missing note or empty one.
function emptyMarkerOf(row, t) {
  if (row.kind === 'slot' && row.slot.output === '') return t('monitor.slot.empty');
  if (row.kind === 'turn' && row.turn.note === null) return t('monitor.handoff.turn.noNote');
  if (row.kind === 'turn' && row.turn.note === '') return t('monitor.slot.empty');
  return null;
}

// A slot's input and its C string, or a call's response alone, on one line, nothing where there is no text to show; a slot's empty C string, which has no text to preview, shows the neutral empty marker in its place.
function Preview({ preview: { input, output }, empty }) {
  const shown = empty ?? output;
  if (input === undefined && shown === null) return null;
  const paired = input !== undefined;
  return h('div', { className: 'sw-mon-preview', title: paired ? (shown === null ? input : `${input} → ${shown}`) : shown },
    paired ? h('span', { className: 'sw-mon-in' }, input) : null,
    paired && shown !== null ? h('span', { className: 'sw-mon-arrow', 'aria-hidden': 'true' }, '→') : null,
    shown === null ? null : h('span', empty === null ? { className: 'sw-mon-out' } : { className: 'sw-mon-out sw-mon-empty', 'data-sw-empty': '' }, shown));
}

// A parent row's meta, which wraps with the width: the parts the model gives, each in a span of its own, a warning's span carrying `data-sw-attention` and a handoff's type its `data-type`, which the style colours by.
function Meta({ parts }) {
  return h('span', { className: 'sw-mon-meta' },
    parts.map(({ part, text, title, attention, type }) => h('span', { key: part, className: 'sw-mon-meta-item', 'data-part': part, 'data-sw-attention': attention ? '' : undefined, 'data-type': type, title }, text)));
}

// A parent row only toggles its group, never selects; a call, slot, settlement, content or turn row selects, from the keyboard too; a placeholder row does neither. A settlement row shows its title and its meta and no preview.
function MonitorRow({ row, selected, now, dispatch, t }) {
  const { kind, attempt, handoff } = row;
  const props = { className: 'sw-mon-row', role: 'treeitem', 'data-sw-row': kind, 'data-identity': row.identity, 'aria-level': ROW_LEVELS[kind] };
  if (kind === 'placeholder') {
    const what = t(handoff === undefined ? 'monitor.leaves.summaries' : 'monitor.leaves.turns');
    return h('div', { ...props, 'data-sw-placeholder': row.state },
      h('div', { className: 'sw-mon-head' },
        row.state === 'loading' ? h('span', { className: 'sw-mon-spinner', 'aria-hidden': 'true' }) : null,
        h('span', { 'data-part': 'text' }, t(`monitor.leaves.${row.state}`, { what }))));
  }
  const title = h('span', { className: 'sw-mon-title', 'data-part': 'title' }, titleOf(row, t));
  const preview = h(Preview, { preview: row.preview, empty: emptyMarkerOf(row, t) });
  const toggle = h('button', { type: 'button', className: 'sw-mon-toggle', 'aria-expanded': row.open }, h('span', { className: 'sw-mon-chevron', 'aria-hidden': 'true' }), title);
  if (kind === 'attempt') {
    props['aria-expanded'] = row.open;
    props.onClick = () => dispatch({ type: 'toggle', attemptId: attempt.id, open: row.open });
    const parts = parentMetaParts(attempt, now, t, row.missWarned);
    if (hasSlotWarnings(attempt) || parts.some(({ attention }) => attention)) props['data-sw-attention'] = '';
    return h('div', props,
      h('div', { className: 'sw-mon-head' },
        toggle,
        h('span', { className: 'sw-mon-status', 'data-part': 'status', 'data-status': row.shownStatus }, t(`monitor.status.${row.shownStatus}`)),
        h(Meta, { parts })),
      row.open ? null : preview);
  }
  if (kind === 'handoff') {
    props['aria-expanded'] = row.open;
    props.onClick = () => dispatch({ type: 'toggle', handoffId: handoff.id, open: row.open });
    return h('div', props, h('div', { className: 'sw-mon-head' }, toggle, h(Meta, { parts: handoffMetaParts(handoff, t) })), row.open ? null : preview);
  }
  const warningKeys = kind === 'slot' ? attempt.slotWarnings?.[row.slot.key]?.map(warning => `monitor.warning.${warning}`) : row.warningKeys;
  if (warningKeys?.length > 0) {
    props['data-sw-attention'] = '';
    props.title = props['aria-description'] = warningKeys.map(key => t(key)).join(PART_SEPARATOR);
  }
  const select = () => dispatch(handoff === undefined
    ? { type: 'select', kind, attemptId: attempt.id, slotKey: row.slot?.key }
    : { type: 'select', kind, handoffId: handoff.id, turn: row.at });
  props['aria-selected'] = selected;
  props.tabIndex = 0;
  props.onClick = select;
  props.onKeyDown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    select();
  };
  if (kind === 'settlement') return h('div', props, h('div', { className: 'sw-mon-head' }, title, h(Meta, { parts: settlementMetaParts(row.settlement, t) })));
  return h('div', props, h('div', { className: 'sw-mon-head' }, title), preview);
}

/**
 * The rows `flattenRows` lists as a `tree` of compact items: `selected` is the identity of the selected row or null, `now` the display clock the running times read, and `dispatch` takes the view reducer's actions.
 * A parent row only toggles its group; a call, slot, settlement, content or turn row selects.
 */
export function MonitorList({ rows, selected, now, dispatch, t }) {
  return h('div', { className: 'sw-mon-list', role: 'tree' },
    rows.map(row => h(MonitorRow, { key: row.identity, row, selected: row.identity === selected, now, dispatch, t })));
}

// The divider between the list and the drawer, which the pointer drags and the arrow keys step; the drawer lies at the container's right edge, so a wider drawer is a divider moved left.
function ResizeHandle({ width, dispatch, t }) {
  const drag = React.useRef(null);
  return h('div', {
    className: 'sw-mon-handle',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': t('monitor.drawer.resize'),
    'aria-valuenow': width,
    'aria-valuemin': DRAWER_MIN_WIDTH,
    'aria-valuemax': DRAWER_MAX_WIDTH,
    tabIndex: 0,
    onPointerDown(event) {
      if (event.button !== 0) return;
      const handle = event.currentTarget;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: handle.parentElement.getBoundingClientRect().width,
        containerWidth: handle.closest('[data-sw-monitor-split]').getBoundingClientRect().width,
      };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event) {
      const current = drag.current;
      if (current === null || current.pointerId !== event.pointerId) return;
      dispatch({ type: 'resize', width: current.startWidth + current.startX - event.clientX, containerWidth: current.containerWidth });
    },
    onPointerUp(event) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel() {
      drag.current = null;
    },
    onKeyDown(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const containerWidth = event.currentTarget.closest('[data-sw-monitor-split]').getBoundingClientRect().width;
      dispatch({ type: 'resize', width: width + (event.key === 'ArrowLeft' ? DRAWER_KEY_STEP : -DRAWER_KEY_STEP), containerWidth });
    },
  });
}

const CALL_ENDPOINT = 'inner-monitor/call';
const SLOT_ENDPOINT = 'inner-monitor/slot';
const HANDOFF_ENDPOINT = 'inner-monitor/handoff';

// The body of the call drawer: the handle of the call's detail is looked up from the identity at every render and read through the external store, so another identity reads its own handle and a handle's new result shows without any state copied at mount.
function CallDrawerBody({ monitor, attemptId, payback, now, t }) {
  const result = useResult(monitor.resource({ endpoint: CALL_ENDPOINT, attempt: attemptId }));
  return h(DetailBody, { result, t, render: detail => h(CallDetail, { detail, monitor, attemptId, payback, now, t }) });
}

function SlotDrawerBody({ monitor, attemptId, slotKey, t }) {
  const result = useResult(monitor.resource({ endpoint: SLOT_ENDPOINT, attempt: attemptId, slot: slotKey }));
  return h(DetailBody, { result, t, render: value => h(SlotDetail, { detail: value, t }) });
}

// The body of a handoff's drawer, read through the handoff's resource like the call's.
function HandoffDrawerBody({ monitor, handoffId, t }) {
  const result = useResult(monitor.resource({ endpoint: HANDOFF_ENDPOINT, handoff: handoffId }));
  return h(DetailBody, { result, t, render: detail => h(HandoffDetail, { detail, t }) });
}

// The body of a turn's drawer: the turn is the detail's turn at the place the identity names.
function TurnDrawerBody({ monitor, handoffId, turn, t }) {
  const result = useResult(monitor.resource({ endpoint: HANDOFF_ENDPOINT, handoff: handoffId }));
  return h(DetailBody, { result, t, render: detail => h(TurnDetail, { turn: detail.turns[turn], t }) });
}

// The turn drawer's subtitle: the turn's address once the detail has arrived, nothing for a turn recorded without one.
function TurnSubtitle({ monitor, handoffId, turn }) {
  const result = useResult(monitor.resource({ endpoint: HANDOFF_ENDPOINT, handoff: handoffId }));
  const address = result?.kind === 'ready' ? result.value.turns[turn].address : null;
  return address === null ? null : h('p', { className: 'sw-mon-drawer-sub' }, address);
}

/**
 * The detail drawer of the selected identity, nothing while none is selected.
 * What a call, slot, content or turn drawer shows depends on the identity alone: `monitor.resource` hands the detail of the selected item, so a selection under a collapsed parent keeps its drawer and a selection the rows do not list keeps it too.
 * `ordinals` is `ordinalsOf` over all the attempts: the title names the attempt by its segment and ordinal, the neutral marker for both where it has none, and the raw seq the drawer is addressed by is the id beside it in the header line, as plain text: a call's attempt id, a slot's first event id. `payback` is `paybackOf` over all the attempts and handoffs, from which the overview of a call reads its progress and its shown status.
 * A settlement row opens a drawer titled by the segment it settles (`settlements` is `settlementsOf` over the attempts and handoffs, and the segment reads as the neutral marker where it holds none), with the handoff's id beside it and the page tabs of the settlement: the selected page reads the settlement's resource through `monitor`, and the context page also reads the amber line through `session`, the session's store; another settlement opens at the first page.
 * A handoff's content row and its turn rows open their own drawers, titled by the handoff's segment, which `handoffs` (the host's rows) names, the neutral marker where it lists no such handoff; the content row's by the handoff's id beside the title, a turn's by the turn's address, once the detail has it.
 */
export function MonitorDrawer({ state, monitor, session, ordinals, payback, handoffs = [], settlements, now, dispatch, t }) {
  const { selected, drawerWidth } = state;
  if (selected === null) return null;
  const { kind, identity, attemptId, slotKey, handoffId, turn } = selected;
  let title;
  let subtitle;
  let body;
  if (kind === 'current-settlement') {
    const { base } = selected.result?.kind === 'ready' ? settlementViewOf(null, selected.result) : { base: null };
    title = base === null ? t('monitor.toolbar.currentSettlement') : t('monitor.drawer.settlement', { epoch: base.epoch });
    subtitle = base === null ? null : h('p', { className: 'sw-mon-drawer-sub' }, t('monitor.settlement.current.through', { step: base.steps }));
    body = h(CurrentSettlementDetail, { key: identity, result: selected.result, monitor, t });
  } else if (kind === 'settlement') {
    const settlement = settlements.get(handoffId);
    title = t('monitor.drawer.settlement', { epoch: settlement === undefined ? NOT_AVAILABLE : settlement.epoch });
    subtitle = h('p', { className: 'sw-mon-drawer-sub' }, t('monitor.drawer.handoffId', { id: handoffId }));
    body = h(SettlementDetail, { key: identity, settlement, handoffId, monitor, session, t });
  } else if (kind === 'content' || kind === 'turn') {
    const listed = handoffs.find(handoff => handoff.id === handoffId);
    title = t(kind === 'turn' ? 'monitor.drawer.handoffTurn' : 'monitor.drawer.handoff', { epoch: listed === undefined ? NOT_AVAILABLE : handoffSegmentOf(listed) });
    subtitle = kind === 'turn' ? h(TurnSubtitle, { key: identity, monitor, handoffId, turn }) : h('p', { className: 'sw-mon-drawer-sub' }, t('monitor.drawer.handoffId', { id: handoffId }));
    body = kind === 'turn'
      ? h(TurnDrawerBody, { key: identity, monitor, handoffId, turn, t })
      : h(HandoffDrawerBody, { key: identity, monitor, handoffId, t });
  } else {
    const call = kind === 'call';
    const { epoch, ordinal } = ordinals[attemptId] ?? { epoch: NOT_AVAILABLE, ordinal: NOT_AVAILABLE };
    title = t(call ? 'monitor.drawer.call' : 'monitor.drawer.slot', { epoch, ordinal });
    subtitle = h('p', { className: 'sw-mon-drawer-sub' }, call ? t('monitor.drawer.attemptId', { id: attemptId }) : t('monitor.drawer.slotKey', { id: slotKey }));
    body = call
      ? h(CallDrawerBody, { key: identity, monitor, attemptId, payback, now, t })
      : h(SlotDrawerBody, { key: identity, monitor, attemptId, slotKey, t });
  }
  return h('aside', { className: 'sw-mon-drawer', 'data-sw-monitor-drawer': '', 'data-kind': kind, 'aria-label': t('monitor.drawer.label'), style: { width: drawerWidth } },
    h(ResizeHandle, { width: drawerWidth, dispatch, t }),
    h('div', { className: 'sw-mon-drawer-head' },
      h('h2', { className: 'sw-mon-drawer-title' }, title),
      subtitle,
      h('button', { type: 'button', className: 'sw-mon-close', 'aria-label': t('monitor.drawer.close'), onClick: () => dispatch({ type: 'clear' }) }, '×')),
    h('div', { className: 'sw-mon-drawer-body' }, body));
}

// What a group's leaves stand at for `flattenRows`: the `list` field of a ready answer, `LEAVES_LOADING` while it has no answer and `LEAVES_FAILED` for an answer that is none.
const leavesOf = (result, list) => (result === null ? LEAVES_LOADING : result.kind === 'ready' ? result.value[list] : LEAVES_FAILED);

// The leaves of the groups `ids` as they stand, each group's as `leavesOf` has them from the `list` field of its `endpoint` payload, the resource addressed by `address`: a feed over their resource handles whose subscription holds all of them and whose snapshot is the same object until one handle's result moves.
function listFeed(monitor, { endpoint, address, list }, ids) {
  const handles = ids.map(id => [id, monitor.resource({ endpoint, [address]: id })]);
  let seen = null;
  let lists = null;
  return {
    subscribe(listener) {
      const unsubscribes = handles.map(([, handle]) => handle.subscribe(listener));
      return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
    },
    snapshot() {
      const results = handles.map(([, handle]) => handle.result);
      if (seen !== null && results.every((result, at) => result === seen[at])) return lists;
      seen = results;
      lists = Object.fromEntries(handles.map(([id], at) => [id, leavesOf(results[at], list)]));
      return lists;
    },
  };
}

const SLOT_LISTS = { endpoint: SLOTS_ENDPOINT, address: 'attempt', list: 'slots' };
const TURN_LISTS = { endpoint: HANDOFF_ENDPOINT, address: 'handoff', list: 'turns' };

// The leaves of `source`, by id, of the groups `ids`, each as `leavesOf` has it. The hook count does not depend on `ids`; a change of the set makes a new feed, so React drops the subscriptions of the old one and takes the new one's.
function useLists(monitor, source, ids) {
  const feed = React.useMemo(() => listFeed(monitor, source, ids), [monitor, source, ids.join()]);
  return React.useSyncExternalStore(feed.subscribe, feed.snapshot, feed.snapshot);
}

export function MonitorToolbar({ filter, dispatch, openCurrent, currentOpen = false, t }) {
  const button = (props, text) => h('button', { type: 'button', className: 'sw-mon-fbtn', ...props }, text);
  return h('div', { className: 'sw-mon-toolbar', role: 'toolbar', 'aria-label': t('monitor.toolbar.label') },
    filter === null ? null : h(React.Fragment, null,
      h('div', { className: 'sw-mon-filter', role: 'group', 'aria-label': t('monitor.filter.category') },
        FILTER_CATEGORIES.map(category => button({ key: category, 'aria-pressed': filter.category === category, onClick: () => dispatch({ type: 'category', category }) }, t(`monitor.filter.${category}`)))),
      button({ onClick: () => dispatch({ type: 'collapse' }) }, t('monitor.filter.collapseAll')),
      button({ 'data-act': 'warned', 'aria-pressed': filter.warned, onClick: () => dispatch({ type: 'warned', warned: !filter.warned }) }, t('monitor.filter.warned'))),
    button({ 'aria-expanded': currentOpen, onClick: openCurrent }, t('monitor.toolbar.currentSettlement')));
}

/**
 * The toolbar opens a fixed current settlement snapshot even when the event pane shows `listNotice`. Row filters and row-selected drawers need an event list.
 * The pane scrolls to the tail when its first event list arrives; later commits do not move it. A filter that matches nothing shows a notice instead of rows.
 * A click on the pane's blank space clears the selection.
 * The clock ticks only while an attempt is in progress.
 * The list subscribes to slots only for open, shown, committed attempts. The summaries page uses the same slots handle; an open, shown handoff and its drawers use the handoff handle.
 */
export function MonitorSplit({ attempts, handoffs, listNotice = null, monitor, session, state, dispatch, t }) {
  const paneRef = React.useRef(null);
  const placed = React.useRef(false);
  const hasEvents = attempts.length > 0 || handoffs.length > 0;
  const currentOpen = state.selected?.kind === 'current-settlement';
  async function openCurrent() {
    if (currentOpen) return;
    const request = Symbol();
    dispatch({ type: 'open-current-settlement', request });
    const result = await monitor.readCurrentSettlement();
    dispatch({ type: 'current-settlement-result', request, result });
  }
  const [now, setNow] = React.useState(() => Date.now());
  const running = attempts.some(attempt => ACTIVE_STATUSES.includes(attempt.status));
  React.useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => { setNow(Date.now()); }, CLOCK_TICK_MS);
    return () => { clearInterval(timer); };
  }, [running]);
  React.useLayoutEffect(() => {
    if (!hasEvents || placed.current) return;
    const pane = paneRef.current;
    pane.scrollTop = pane.scrollHeight;
    placed.current = true;
  }, [hasEvents]);
  const shown = visibleGroups(attempts, handoffs, state.filter);
  const expanded = shown.attempts.filter(attempt => isOpen(state, attempt.id) && attempt.status === 'committed' && (!state.filter.warned || hasSlotWarnings(attempt))).map(attempt => attempt.id);
  const expandedHandoffs = shown.handoffs.filter(handoff => isOpen(state, handoff.id)).map(handoff => handoff.id);
  const rows = flattenRows(attempts, useLists(monitor, SLOT_LISTS, expanded), state, handoffs, useLists(monitor, TURN_LISTS, expandedHandoffs));
  return h(React.Fragment, null,
    h(MonitorToolbar, { filter: hasEvents ? state.filter : null, dispatch, openCurrent, currentOpen, t }),
    h('div', { className: 'sw-mon-split', 'data-sw-monitor-split': '' },
      h('div', {
        className: 'sw-mon-pane',
        ref: paneRef,
        role: 'region',
        'aria-label': t('monitor.region'),
        tabIndex: 0,
        onClick(event) { if (event.target === event.currentTarget) dispatch({ type: 'clear' }); },
      }, listNotice ?? (rows.length === 0
        ? h(Notice, { state: 'filter-empty' }, t('monitor.filter.empty'))
        : h(MonitorList, { rows, selected: state.selected?.identity ?? null, now, dispatch, t }))),
      hasEvents || currentOpen
        ? h(MonitorDrawer, { state, monitor, session, ordinals: ordinalsOf(attempts), payback: paybackOf(attempts, handoffs), handoffs, settlements: settlementsOf(attempts, handoffs), now, dispatch, t })
        : null));
}

function MonitorContent({ monitor, session, state, dispatch, t }) {
  const rows = useResult(monitor.rows);
  const { attempts = [], handoffs = [] } = rows ?? {};
  const notice = rows?.kind === 'ready' ? (attempts.length + handoffs.length === 0 ? 'empty' : null) : rows?.kind ?? 'loading';
  const listNotice = notice === null ? null : h(Notice, { state: `rows-${notice}` }, t(`monitor.rows.${notice}`, notice === 'unreachable' ? { message: rows.message } : undefined));
  return h(MonitorSplit, { attempts, handoffs, listNotice, monitor, session, state, dispatch, t });
}

/**
 * The monitor's `conversation.view` entry: the attempts and handoffs the session's monitor stores hold, for every session whatever its inner mode. `session` is the session's store (`session-store.js`), which the settlement drawer's context page subscribes to for the amber line for as long as that page is shown.
 * The view state, the open and selected rows, the drawer's width and the filter, belongs to the instance and lasts as long as the tab stays mounted.
 *
 * @param {{ monitor: { rows: { result: object | null, subscribe: Function } }, session: { result: object | null, subscribe: Function }, t: Function }} props
 */
export function InnerCompactionView({ monitor, session, t }) {
  const [state, dispatch] = React.useReducer(reduceView, undefined, createViewState);
  return h('div', { className: 'sw-mon', 'data-sw-monitor': '', 'data-conversation-composer-overlay': '' },
    h(MonitorContent, { monitor, session, state, dispatch, t }));
}
