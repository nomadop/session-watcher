// dsh/src/client/tab.js — the Session Watcher view: the slot leaves and badge each store result renders inside the tab root, and the mount controller that runs the dashboard elements in those leaves.
import React from 'react';
import { createTabContext } from './context.js';
import { SLOT_TABLES } from './elements.js';
import { resultSignalState, stateText } from './locales.js';

const h = React.createElement;

/** The slots in `public/app.js`'s registration order, which mount, update and destroy all follow. */
const SLOT_ORDER = ['chrome', 'buckets', 'hero', 'history'];

/** Each slot's leaf id, which the sheets select on. */
const LEAF_IDS = { chrome: 'sw-chrome', hero: 'sw-hero', history: 'sw-history', buckets: 'sw-buckets' };

/** A non-`live` result's badge state and locale text; the badge shows the signal stream's state instead while that is not `live`. */
function resultBadge(result, t) {
  return { state: resultSignalState(result), title: stateText(result, t) };
}

/** The connection badge, which reuses the dashboard chrome's badge classes; `data-state` selects the accent its state takes and `title` carries a result's full text. */
function SignalBadge({ state, title, t }) {
  return h('span', { className: 'sw-chrome-conn', 'data-state': state, role: 'status', title },
    h('span', { className: 'sw-chrome-conn-dot', 'aria-hidden': 'true' }),
    h('span', { className: 'sw-chrome-conn-label' }, t(`signal.${state}`)));
}

/**
 * The tab root `<div data-sw-tab>` — the element the sheets scope to and the overlay root the context holds, its `data-sw-scheme` the host theme's colour scheme the light palette keys on — holding the four slot leaves under every result, the elements' idle paint standing in until a `live` result.
 * The chrome leaf holds the badge: the signal stream's state while it is not `live`, else a non-`live` result's state titled with its locale text, else `live`.
 *
 * @param {{ result: null | { kind: string }, t: (key: string, params?: object) => string, rootRef: { current: Element | null }, scheme?: string, signalState: string }} props
 */
export function SessionWatcherScreen({ result, t, rootRef, scheme, signalState }) {
  const badge = signalState !== 'live' ? { state: signalState }
    : result?.kind === 'live' ? { state: 'live' }
      : resultBadge(result, t);
  return h('div', { 'data-sw-tab': '', 'data-sw-scheme': scheme, ref: rootRef },
    h('div', { id: LEAF_IDS.chrome }, h(SignalBadge, { ...badge, t })),
    h('div', { id: LEAF_IDS.hero }),
    h('div', { className: 'sw-lower' }, h('div', { id: LEAF_IDS.history }), h('div', { id: LEAF_IDS.buckets })));
}

/**
 * Runs the slot tables' elements in their leaves: `mount(leaves, snapshot)` mounts every element with `ctx` and, when `snapshot` is not null, paints each instance through `update`.
 * Each phase of each element is contained: a throw writes `[sw] <slot> <phase> failed` to `log`; a failed mount leaves that element absent, a failed update leaves it at its last paint, and a failed destroy does not stop the rest.
 *
 * @param {{ ctx: object, tables: Record<string, Function[]>, log?: (message: string, error: unknown) => void }} options
 */
export function createMountController({ ctx, tables, log = console.error }) {
  const instances = [];

  function contained(slot, phase, run) {
    try {
      return run();
    } catch (error) {
      log(`[sw] ${slot} ${phase} failed`, error);
      return undefined;
    }
  }

  function update(snapshot) {
    for (const { slot, instance } of instances) contained(slot, 'update', () => instance.update(snapshot));
  }

  return {
    mount(leaves, snapshot) {
      for (const slot of SLOT_ORDER) {
        for (const mount of tables[slot]) {
          const instance = contained(slot, 'mount', () => mount(leaves[slot], ctx));
          if (instance !== undefined) instances.push({ slot, instance });
        }
      }
      if (snapshot !== null) update(snapshot);
    },
    update,
    destroy() {
      for (const { slot, instance } of instances) contained(slot, 'destroy', () => instance.destroy());
    },
  };
}

/**
 * Puts the host's conversation scrollport enclosing `root` at its top. The host renders only the active view inside one scrollport the chat leaves at its tail, so a freshly mounted tab would otherwise open at its own bottom.
 *
 * @param {Element} root
 */
export function scrollHostToTop(root) {
  const scrollport = root.closest('[data-conversation-scroll]');
  if (scrollport !== null) scrollport.scrollTop = 0;
}

const themeKey = theme => JSON.stringify([theme.active.id, theme.active.colorScheme, theme.active.tokens]);
const colorScheme = theme => theme.active.colorScheme;

/**
 * The `conversation.view` entry's component: subscribes to its session's `store`, renders `SessionWatcherScreen` with the latest result, and mounts the elements on the first commit, painting them only from a `live` result.
 * The first render shows the store's retained result, and a retained `live` result paints the elements on the first commit, because the subscription and the element ctx are set up in a layout effect declared before the mount's.
 * Consecutive `live` results reach the mounted elements through the controller's `update`, outside the render cycle, so they keep their interaction state;
 * entering or leaving `live` and a theme change remount them after the layout presenter has written the DOM, on the last snapshot while `live` and unpainted otherwise.
 * The mount puts the host's scrollport at its top. The elements' `ctx.transport` is the store and their requests go through `call`.
 *
 * @param {{ store: { result: null | object, subscribe: Function }, signalState: { getSnapshot: () => string, subscribe: Function }, call: (endpoint: string, payload?: object) => Promise<object>, useTheme: (selector: Function) => unknown, t: Function }} props
 */
export function SessionWatcherTab({ store, signalState, call, useTheme, t }) {
  const rootRef = React.useRef(null);
  const contextRef = React.useRef(null);
  const [result, setResult] = React.useState(() => store.result);
  const snapshotRef = React.useRef(result?.kind === 'live' ? result.snapshot : null);
  const controllerRef = React.useRef(null);
  const theme = useTheme(themeKey);
  const scheme = useTheme(colorScheme);
  const connection = React.useSyncExternalStore(signalState.subscribe, signalState.getSnapshot, signalState.getSnapshot);
  const isLive = result?.kind === 'live';

  React.useLayoutEffect(() => {
    scrollHostToTop(rootRef.current);
    contextRef.current = { ...createTabContext({ call, root: rootRef.current }), transport: store };
    return store.subscribe((next) => {
      if (next.kind === 'live') {
        snapshotRef.current = next.snapshot;
        controllerRef.current?.update(next.snapshot);
      }
      setResult(next);
    });
  }, []);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const leaves = {};
    for (const slot of SLOT_ORDER) leaves[slot] = root.querySelector('#' + LEAF_IDS[slot]);
    const controller = createMountController({ ctx: contextRef.current, tables: SLOT_TABLES });
    controller.mount(leaves, isLive ? snapshotRef.current : null);
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.destroy();
    };
  }, [isLive, theme]);

  return h(SessionWatcherScreen, { result, t, rootRef, scheme, signalState: connection });
}
