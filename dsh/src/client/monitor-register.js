// dsh/src/client/monitor-register.js — the inner compaction monitor's `conversation.view` entry, present under each lifetime of the slot's declaration.
import { NS } from './locales.js';
import { InnerCompactionView } from './monitor-view.js';

/** The monitor entry's id in the `conversation.view` roster. */
export const MONITOR_VIEW_ID = 'session-watcher.inner-compaction';
/** The monitor entry's `order`, after the Session Watcher entry's. */
export const MONITOR_VIEW_ORDER = 30;

/**
 * Registers the monitor's view for the injection child that reads `slots`.
 * The entry is registered under each lifetime of the `conversation.view` declaration and disposed when the declaration collapses, so every session has it whatever its inner mode.
 * The entry's `inject(sessionId)` hands the session's monitor stores and its session store; it reads nothing.
 *
 * @param {object} child - the injection child
 * @param {{ monitors: object, sessions: object, t: Function }} options - the monitor stores, the session stores and the plugin's bound translate
 */
export function registerMonitorView(child, { monitors, sessions, t }) {
  child.slots.inject('conversation.view', () => child.slots.register({
    name: 'conversation.view',
    id: MONITOR_VIEW_ID,
    order: MONITOR_VIEW_ORDER,
    locale: NS,
    label: () => t('monitor.label'),
    inject: sessionId => ({ monitor: monitors.for(sessionId), session: sessions.for(sessionId) }),
  }, InnerCompactionView));
}
