// dsh/src/client/monitor-handle.js — what a page of the monitor's drawer reads a store handle through and the text it puts in the place of content it cannot show.
import React from 'react';

/** The handle's retained result, read again whenever its subscription calls back; a server render reads the same retained result. */
export function useResult(handle) {
  return React.useSyncExternalStore(handle.subscribe, () => handle.result, () => handle.result);
}

export function useSettlementResult(monitor, handoffId) {
  return useResult(monitor.resource({ endpoint: 'inner-monitor/settlement', handoff: handoffId }));
}

const h = React.createElement;

/** A text in the list's or the drawer's place that stands for content not shown: `state` is its marker, `children` its text. */
export function Notice({ state, children }) {
  return h('p', { className: 'sw-mon-notice', 'data-sw-monitor-notice': state, role: 'status' }, children);
}

export function RecallNotice({ result, partial, pending = false, t }) {
  const state = result === null ? (pending ? 'pending' : null) : result.kind !== 'ready' ? 'unavailable' : partial ? 'partial' : null;
  return state === null ? null : h(Notice, { state: `recall-${state}` }, t(`monitor.settlement.recall.${state}`));
}
