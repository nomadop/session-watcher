// The DSH tab shell: the slot leaves and the badge state each store result renders inside the data-sw-tab root, the tab's first render over its store's retained result, and the mount controller that runs the slot tables' elements with per-phase containment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { SessionWatcherScreen, SessionWatcherTab, createMountController, scrollHostToTop } from '../dsh/src/client/tab.js';
import { SLOT_TABLES } from '../dsh/src/client/elements.js';
import { mount as mountHeroDiptych } from '../public/elements/heroDiptych.js';
import { mount as mountBucketPanel } from '../public/elements/bucketPanel.js';
import { mount as mountDepthAux } from '../public/elements/depthAux.js';
import { mount as mountBurnMeter } from '../public/elements/burnMeter.js';
import { mount as mountPricingChip } from '../public/elements/pricingChip.js';
import { mount as mountHistoryChart } from '../public/elements/historyChart.js';
import { mount as mountHistoryDrawer } from '../public/elements/historyDrawer.js';
import { en } from '../dsh/src/client/locales.js';

const t = (key, params = {}) => en[key].replace(/\{(\w+)\}/g, (_, name) => params[name]);
const screen = (result, signalState = 'live') => renderToString(React.createElement(SessionWatcherScreen, { result, t, rootRef: { current: null }, signalState }));
const badge = (state, title) => `<span class="sw-chrome-conn" data-state="${state}" role="status"${title === undefined ? '' : ` title="${title}"`}><span class="sw-chrome-conn-dot" aria-hidden="true"></span><span class="sw-chrome-conn-label">${en[`signal.${state}`]}</span></span>`;
const leaves = chrome => `<div id="sw-chrome">${chrome}</div><div id="sw-hero"></div><div class="sw-lower"><div id="sw-history"></div><div id="sw-buckets"></div></div>`;
const inRoot = inner => `<div data-sw-tab="">${inner}</div>`;
const LIVE = { kind: 'live', snapshot: { status: {}, history: [], capabilities: {}, bucketData: null } };
const FAILED = { kind: 'state', state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'read refused' } };

test('a live result renders the four slot leaves inside the data-sw-tab root, the chrome leaf holding the live badge', () => {
  assert.equal(screen(LIVE), inRoot(leaves(badge('live'))));
});

test('every non-live result renders the same leaves, the badge naming the result\'s state and titled with its locale text', () => {
  assert.equal(screen(null), inRoot(leaves(badge('reading', en['state.bootstrapping']))));
  assert.equal(screen({ kind: 'state', state: 'bootstrapping' }), inRoot(leaves(badge('reading', en['state.bootstrapping']))));
  assert.equal(screen({ kind: 'state', state: 'unobserved' }), inRoot(leaves(badge('unobserved', en['state.unobserved']))));
  assert.equal(screen(FAILED), inRoot(leaves(badge('failed', t('state.failed', { message: 'read refused' })))));
  assert.equal(screen({ kind: 'unreachable', message: 'HTTP 405' }), inRoot(leaves(badge('unreachable', t('state.unreachable', { message: 'HTTP 405' })))));
});

test('a connecting or disconnected signal stream takes the badge over any result', () => {
  for (const result of [LIVE, null, FAILED]) {
    for (const state of ['connecting', 'disconnected']) {
      assert.ok(screen(result, state).includes(`<div id="sw-chrome">${badge(state)}</div>`), `${state} over ${result?.kind}`);
    }
  }
});

test('the tab\'s first render shows the store\'s retained result', () => {
  const store = { result: { kind: 'state', state: 'unobserved' }, subscribe: () => () => {} };
  const signalState = { getSnapshot: () => 'live', subscribe: () => () => {} };
  const useTheme = selector => selector({ active: { id: 'dark', colorScheme: 'dark', tokens: {} } });
  const html = renderToString(React.createElement(SessionWatcherTab, { store, call: () => assert.fail('the render calls nothing'), useTheme, t, signalState }));
  assert.equal(html, `<div data-sw-tab="" data-sw-scheme="dark">${leaves(badge('unobserved', en['state.unobserved']))}</div>`);
});

test('the tab root\'s data-sw-scheme is the active theme\'s colorScheme', () => {
  const store = { result: { kind: 'state', state: 'unobserved' }, subscribe: () => () => {} };
  const signalState = { getSnapshot: () => 'live', subscribe: () => () => {} };
  const useTheme = selector => selector({ active: { id: 'light', colorScheme: 'light', tokens: {} } });
  const html = renderToString(React.createElement(SessionWatcherTab, { store, call: () => assert.fail('the render calls nothing'), useTheme, t, signalState }));
  assert.match(html, /^<div data-sw-tab="" data-sw-scheme="light">/);
});

test('scrollHostToTop puts the root\'s enclosing conversation scrollport at its top and leaves a root outside one alone', () => {
  const scrollport = { scrollTop: 840 };
  scrollHostToTop({ closest: selector => (selector === '[data-conversation-scroll]' ? scrollport : null) });
  assert.equal(scrollport.scrollTop, 0);
  assert.doesNotThrow(() => scrollHostToTop({ closest: () => null }));
});

// ── Mount controller ─────────────────────────────────────────────────────────

const LEAVES = { chrome: { leaf: 'chrome' }, hero: { leaf: 'hero' }, history: { leaf: 'history' }, buckets: { leaf: 'buckets' } };
const CTX = { name: 'tab ctx' };

/**
 * Fake slot tables whose elements record each phase into `events`; `faults` names the `<element> <phase>` pairs that throw,
 * an `update` fault naming the snapshot it throws on as `<element> update <snapshot.n>`.
 */
function fakeTables(names, faults = new Set()) {
  const events = [];
  const paints = {};
  const element = name => (root, ctx) => {
    events.push({ name, phase: 'mount', root, ctx });
    if (faults.has(`${name} mount`)) throw new Error(`${name} mount`);
    return {
      update(snapshot) {
        events.push({ name, phase: 'update', n: snapshot.n });
        if (faults.has(`${name} update ${snapshot.n}`)) throw new Error(`${name} update`);
        paints[name] = snapshot.n;
      },
      destroy() {
        events.push({ name, phase: 'destroy' });
        if (faults.has(`${name} destroy`)) throw new Error(`${name} destroy`);
      },
    };
  };
  const tables = Object.fromEntries(Object.entries(names).map(([slot, list]) => [slot, list.map(element)]));
  return { tables, events, paints };
}

const NAMES = { chrome: ['pricing'], hero: ['diptych', 'aux'], history: ['chart'], buckets: ['panel'] };
const MOUNT_ORDER = ['pricing', 'panel', 'diptych', 'aux', 'chart'];

function recordingLog() {
  const lines = [];
  const log = (message, error) => lines.push({ message, error: error.message });
  return { log, lines };
}

const phase = (events, wanted) => events.filter(e => e.phase === wanted).map(e => e.name);

test('mount runs each slot\'s elements in order with the tab context and update hands every instance the snapshot', () => {
  const { tables, events, paints } = fakeTables(NAMES);
  const controller = createMountController({ ctx: CTX, tables, log: () => assert.fail('nothing throws') });
  controller.mount(LEAVES, null);
  assert.deepEqual(phase(events, 'mount'), MOUNT_ORDER, 'app.js registration order');
  for (const e of events) {
    const slot = Object.keys(NAMES).find(s => NAMES[s].includes(e.name));
    assert.equal(e.root, LEAVES[slot], `${e.name} mounts into its slot's leaf`);
    assert.equal(e.ctx, CTX);
  }
  controller.update({ n: 1 });
  assert.deepEqual(phase(events, 'update'), MOUNT_ORDER);
  assert.deepEqual(paints, { pricing: 1, panel: 1, diptych: 1, aux: 1, chart: 1 });
});

test('mount with a held snapshot paints every instance before any later result', () => {
  const { tables, events, paints } = fakeTables(NAMES);
  const controller = createMountController({ ctx: CTX, tables, log: () => assert.fail('nothing throws') });
  controller.mount(LEAVES, { n: 7 });
  assert.deepEqual(events.map(e => `${e.name} ${e.phase}`), [
    ...MOUNT_ORDER.map(name => `${name} mount`),
    ...MOUNT_ORDER.map(name => `${name} update`),
  ]);
  assert.deepEqual(paints, { pricing: 7, panel: 7, diptych: 7, aux: 7, chart: 7 });
});

test('mount without a snapshot leaves update unrun', () => {
  const { tables, events } = fakeTables(NAMES);
  createMountController({ ctx: CTX, tables }).mount(LEAVES, null);
  assert.deepEqual(phase(events, 'update'), []);
});

test('a replay that throws logs the update phase, keeps the instance for later updates and destroy, and paints the others', () => {
  const { tables, events, paints } = fakeTables(NAMES, new Set(['diptych update 1']));
  const { log, lines } = recordingLog();
  const controller = createMountController({ ctx: CTX, tables, log });
  controller.mount(LEAVES, { n: 1 });
  assert.deepEqual(lines, [{ message: '[sw] hero update failed', error: 'diptych update' }]);
  assert.deepEqual(paints, { pricing: 1, panel: 1, aux: 1, chart: 1 });
  controller.update({ n: 2 });
  assert.equal(paints.diptych, 2, 'the instance stays registered for later updates');
  controller.destroy();
  assert.deepEqual(phase(events, 'destroy'), MOUNT_ORDER);
});

test('a mount that throws leaves that element absent and unpainted, logs the slot and phase, and mounts the others', () => {
  const { tables, events, paints } = fakeTables(NAMES, new Set(['panel mount']));
  const { log, lines } = recordingLog();
  const controller = createMountController({ ctx: CTX, tables, log });
  controller.mount(LEAVES, { n: 1 });
  assert.deepEqual(lines, [{ message: '[sw] buckets mount failed', error: 'panel mount' }]);
  assert.deepEqual(phase(events, 'mount'), MOUNT_ORDER);
  assert.deepEqual(paints, { pricing: 1, diptych: 1, aux: 1, chart: 1 });
  controller.update({ n: 2 });
  controller.destroy();
  assert.equal(events.filter(e => e.name === 'panel' && e.phase !== 'mount').length, 0, 'never updated or destroyed');
});

test('an update that throws leaves the element at its last paint and updates the others', () => {
  const { tables, paints } = fakeTables(NAMES, new Set(['chart update 2']));
  const { log, lines } = recordingLog();
  const controller = createMountController({ ctx: CTX, tables, log });
  controller.mount(LEAVES, { n: 1 });
  controller.update({ n: 2 });
  assert.deepEqual(lines, [{ message: '[sw] history update failed', error: 'chart update' }]);
  assert.deepEqual(paints, { pricing: 2, panel: 2, diptych: 2, aux: 2, chart: 1 });
});

test('destroy runs in mount order and a throwing destroy does not stop the rest', () => {
  const { tables, events } = fakeTables(NAMES, new Set(['pricing destroy']));
  const { log, lines } = recordingLog();
  const controller = createMountController({ ctx: CTX, tables, log });
  controller.mount(LEAVES, null);
  controller.destroy();
  assert.deepEqual(phase(events, 'destroy'), MOUNT_ORDER);
  assert.deepEqual(lines, [{ message: '[sw] chrome destroy failed', error: 'pricing destroy' }]);
});

test('the tables list pricingChip in the chrome slot, heroDiptych, depthAux and burnMeter in the hero slot, historyChart then historyDrawer in history, and bucketPanel in buckets', () => {
  assert.deepEqual(Object.keys(SLOT_TABLES).sort(), ['buckets', 'chrome', 'hero', 'history']);
  assert.deepEqual(SLOT_TABLES.chrome, [mountPricingChip]);
  assert.deepEqual(SLOT_TABLES.hero, [mountHeroDiptych, mountDepthAux, mountBurnMeter]);
  assert.deepEqual(SLOT_TABLES.history, [mountHistoryChart, mountHistoryDrawer]);
  assert.deepEqual(SLOT_TABLES.buckets, [mountBucketPanel]);
});
