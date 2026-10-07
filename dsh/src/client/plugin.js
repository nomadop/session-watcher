// dsh/src/client/plugin.js — the client half's registrations: the locale, the stylesheet, the signal stream and the `conversation.view` and `conversation.composer.dock` entries over one store per session, each under the caller's effects.
import { NS, en, zh } from './locales.js';
import { SessionWatcherTab } from './tab.js';
import { createSessionStores } from './session-store.js';
import { openSignalStream } from './signal.js';
import { createDock } from './dock.js';

const PLUGIN_ID = '@nomadop/session-watcher-dsh';
const CHANNEL = '/session-watcher';
/** The host's events route, relative to the page's base. */
const EVENTS_URL = 'api/session-watcher.events';

/**
 * Registers the locale namespace and appends one `<style>` carrying `tabCss` to `document.head`, both removed when the effects dispose,
 * and contributes the Session Watcher view to `conversation.view` and the dock to `conversation.composer.dock` for every declaration lifetime of each slot.
 * One `createSessionStores` instance pulls over the channel; `ctx.connection` is read at each call.
 * One effect holds a signal stream on `EVENTS_URL` only while the page is visible: a frame signals its session's store and an open signals every subscribed store.
 * Turning hidden closes the stream and turning visible opens another; a connection generation whose number differs from the last one seen closes a held stream and opens another, while a lost generation changes nothing and the first one seen only records its number.
 * A hidden page leaves the last state in place: the tab is not shown, and the stream that opens on turning visible restarts from `connecting`.
 * The view entry's `inject(sessionId)` hands the session's store, the stream's connection state as `signalState` (one subscribable `connecting`, `live` or `disconnected` for every session), a call that binds the session into every RPC call the tab's elements make, and the theme as the `useTheme` hook;
 * the dock entry's hands the same store, and the dock is built from the handed placement hooks and portal.
 *
 * @param {object} ctx - the client plugin context with `slots`, `locale`, `theme` and `connection`.
 * @param {{ tabCss: string, useAnchoredPosition: Function, useDismissOnOutsidePointer: Function, createPortal: Function }} options
 */
export function applyClient(ctx, { tabCss, useAnchoredPosition, useDismissOnOutsidePointer, createPortal }) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-watcher: dictionaries');
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = PLUGIN_ID;
    tag.dataset.pluginCss = `${PLUGIN_ID}/tab.css`;
    tag.textContent = tabCss;
    document.head.appendChild(tag);
    return () => { tag.remove(); };
  }, 'session-watcher: tab stylesheet');
  const sessions = createSessionStores({
    call: (endpoint, payload, signal) => ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal),
  });
  // Read by the tab's badge; an unchanged state notifies nobody.
  let signalState = 'connecting';
  const signalListeners = new Set();
  const signalStore = {
    getSnapshot: () => signalState,
    subscribe(listener) {
      signalListeners.add(listener);
      return () => { signalListeners.delete(listener); };
    },
  };
  const setSignalState = (next) => {
    if (next === signalState) return;
    signalState = next;
    for (const listener of [...signalListeners]) listener();
  };
  ctx.effect(() => {
    const { generation } = ctx.connection;
    let stream = null;
    let seen = generation.getSnapshot()?.id;
    const open = () => {
      stream = openSignalStream({
        url: EVENTS_URL, EventSource: globalThis.EventSource, onFrame: sessions.signal, onOpen: sessions.openAll, onState: setSignalState,
        setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      });
    };
    const close = () => {
      stream?.close();
      stream = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') open();
      else close();
    };
    const unsubscribe = generation.subscribe(() => {
      const id = generation.getSnapshot()?.id;
      if (id === undefined) return;
      if (seen !== undefined && id !== seen && stream !== null) {
        close();
        open();
      }
      seen = id;
    });
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') open();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      close();
    };
  }, 'session-watcher: signal stream');
  // The label is read through the bound translate as a thunk so the tab strip follows the active locale.
  const t = ctx.locale.bind(NS);
  const theme = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: listener => ctx.on('theme/change', listener),
  };
  // A direct `register` throws while `conversation.view` is undeclared, so the registration waits on `inject`.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'session-watcher',
    order: 20,
    locale: NS,
    label: () => t('view.label'),
    inject: sessionId => ({
      store: sessions.for(sessionId),
      signalState: signalStore,
      call: (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, { ...payload, sessionId }),
      hooks: { theme },
    }),
  }, SessionWatcherTab));
  const { Dock } = createDock({ useAnchoredPosition, useDismissOnOutsidePointer, createPortal });
  // The dock follows the host's own `stats` entry; the slot renders only in the resident composer.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'session-watcher',
    order: 10,
    locale: NS,
    inject: sessionId => ({ store: sessions.for(sessionId) }),
  }, Dock));
}
