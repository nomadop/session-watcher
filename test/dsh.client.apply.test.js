// The DSH client plugin's `applyClient` on a fake ctx: the locale, the tab stylesheet and the signal stream inside effects, the stream held across visibility and connection generations, and the `conversation.view` and `conversation.composer.dock` entries registered per slot declaration lifetime over one store per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { applyClient } from '../dsh/src/client/plugin.js';
import { SessionWatcherTab } from '../dsh/src/client/tab.js';
import { NS, en, zh } from '../dsh/src/client/locales.js';
import { MIN_GAP_MS } from '../dsh/src/client/session-store.js';

const TAB_CSS = '@scope ([data-sw-tab]) { :scope { color: red; } }';

/** Recording stand-ins for the two primitives hooks and the portal `index.js` hands in. */
function hookFakes() {
  const calls = { anchored: [], dismiss: [], portal: [] };
  return {
    calls,
    useAnchoredPosition: (options) => { calls.anchored.push(options); return null; },
    useDismissOnOutsidePointer: (...args) => { calls.dismiss.push(args); },
    createPortal: (node, target) => { calls.portal.push(target); return node; },
  };
}

const OPTIONS = (() => {
  const { calls, ...hooks } = hookFakes();
  return { tabCss: TAB_CSS, ...hooks };
})();

/** The registrations of one slot, by the entry's `name`. */
const entriesOf = (fake, name) => fake.registrations.filter(r => r.options.name === name);
const viewEntry = fake => entriesOf(fake, 'conversation.view')[0];

/**
 * A `document` stub with a `head` that records appended children, whether each arrived inside an effect, and their removal,
 * and a `visibilityState` that `setVisibility` changes before it dispatches `visibilitychange` to the listeners `addEventListener` holds.
 * It installs a fake `EventSource` class too, whose instances record `url`, listeners, `readyState` and `close()` calls; both are restored after the case.
 */
function stubDocument(t, { inEffect = () => false, visibilityState = 'visible' } = {}) {
  const head = { children: [], appendChild(node) { node.appendedInEffect = inEffect(); head.children.push(node); return node; } };
  const createElement = tag => ({
    tag, dataset: {}, textContent: '',
    remove() { head.children.splice(head.children.indexOf(this), 1); },
  });
  const listeners = new Set();
  const doc = {
    head, createElement, visibilityState,
    addEventListener(type, listener) { if (type === 'visibilitychange') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'visibilitychange') listeners.delete(listener); },
  };
  const sources = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = {};
      this.closeCalls = 0;
      this.openedInEffect = inEffect();
      sources.push(this);
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    close() { this.closeCalls += 1; this.readyState = FakeEventSource.CLOSED; }
    emit(type, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event); }
  }
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    EventSource: Object.getOwnPropertyDescriptor(globalThis, 'EventSource'),
  };
  globalThis.document = doc;
  globalThis.EventSource = FakeEventSource;
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    head, doc, sources, visibilityListeners: listeners,
    setVisibility(next) {
      doc.visibilityState = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * A fake client ctx recording each service call the plugin makes.
 * `slots.inject` holds its callback; `declare()` runs every held callback and keeps its disposer, `undeclare()` calls them.
 * `slots.register` throws while the slot is undeclared, as DSH's does, and otherwise records and returns a recording disposer.
 * `setGeneration(snapshot)` replaces the connection generation and calls its listeners, as the checkout's `publishGeneration` does.
 */
function fakeCtx(options = {}) {
  const log = [];
  let effectDepth = 0;
  const effectDisposers = [];
  const injections = [];
  const registrations = [];
  let declared = false;
  let generation = 'generation' in options ? options.generation : { id: 1, host: {} };
  const generationListeners = new Set();
  // Each translate and theme read answers a fresh count, so a value cached at registration shows as a stale one.
  let translations = 0;
  let themeReads = 0;
  const ctx = {
    effect(fn) {
      effectDepth++;
      let dispose;
      try { dispose = fn(); } finally { effectDepth--; }
      effectDisposers.push(dispose);
      return dispose;
    },
    locale: {
      register(ns, dicts) {
        log.push({ call: 'locale.register', ns, dicts, inEffect: effectDepth > 0 });
        return () => { log.push({ call: 'locale.dispose', ns }); };
      },
      bind(ns) {
        log.push({ call: 'locale.bind', ns });
        return (key, params) => `${ns}:${key}${params ? JSON.stringify(params) : ''}#${++translations}`;
      },
    },
    theme: { getTheme() { log.push({ call: 'theme.getTheme' }); return { active: { id: 'dark' }, revision: ++themeReads }; } },
    on(event, listener) {
      log.push({ call: 'on', event, listener });
      return () => { log.push({ call: 'off', event }); };
    },
    connection: {
      rpc: {
        call(channel, endpoint, payload, signal) {
          log.push({ call: 'rpc.call', channel, endpoint, payload, signal });
          return Promise.resolve({ ok: true, value: { state: 'bootstrapping' } });
        },
      },
      // The checkout's generation state: `getSnapshot()` answers `{ id, host }` or undefined, and each listener is called with no argument whenever the snapshot is replaced.
      generation: {
        getSnapshot: () => generation,
        subscribe(listener) {
          generationListeners.add(listener);
          return () => { generationListeners.delete(listener); };
        },
      },
    },
    slots: {
      inject(key, callback) {
        log.push({ call: 'slots.inject', key });
        injections.push({ key, callback, dispose: null });
        return () => {};
      },
      register(options, component) {
        if (!declared) throw new Error(`slot "${options.name}" is not declared`);
        const registration = { options, component, disposed: 0 };
        registrations.push(registration);
        return () => { registration.disposed++; };
      },
    },
  };
  return {
    ctx, log, registrations, injections,
    inEffect: () => effectDepth > 0,
    declare() {
      declared = true;
      for (const injection of injections) injection.dispose = injection.callback();
    },
    undeclare() {
      for (const injection of injections) { injection.dispose?.(); injection.dispose = null; }
      declared = false;
    },
    disposeEffects() { for (const dispose of effectDisposers.splice(0).reverse()) dispose?.(); },
    generationListeners,
    setGeneration(next) {
      if (Object.is(generation, next)) return;
      generation = next;
      for (const listener of [...generationListeners]) listener();
    },
  };
}

test('applyClient registers the locale namespace and one style tag carrying the handed text inside effects, injects into the view and dock slots, registers nothing while the slots are undeclared and throws nothing', (t) => {
  const fake = fakeCtx();
  const { head } = stubDocument(t, { inEffect: fake.inEffect });

  assert.doesNotThrow(() => applyClient(fake.ctx, OPTIONS));

  const registers = fake.log.filter(e => e.call === 'locale.register');
  assert.equal(registers.length, 1);
  assert.equal(registers[0].ns, NS);
  assert.deepEqual(registers[0].dicts, { en, zh });
  assert.equal(registers[0].inEffect, true);
  assert.equal(head.children.length, 1);
  const [tag] = head.children;
  assert.equal(tag.tag, 'style');
  assert.equal(tag.textContent, TAB_CSS);
  assert.deepEqual(tag.dataset, { plugin: '@nomadop/session-watcher-dsh', pluginCss: '@nomadop/session-watcher-dsh/tab.css' });
  assert.equal(tag.appendedInEffect, true);
  assert.deepEqual(fake.injections.map(i => i.key), ['conversation.view', 'conversation.composer.dock']);
  assert.deepEqual(fake.registrations, []);
});

test('declaring the slot registers one conversation.view list entry under the session-watcher id with a label thunk reading the locale, the session\'s store, a session-bound call and a theme hook', (t) => {
  stubDocument(t);
  const fake = fakeCtx();
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  assert.equal(entriesOf(fake, 'conversation.view').length, 1);
  const { options, component } = viewEntry(fake);
  assert.equal(component, SessionWatcherTab);
  assert.equal(options.name, 'conversation.view');
  assert.equal(options.id, 'session-watcher');
  assert.equal(options.order, 20);
  assert.equal(options.locale, NS);
  assert.equal(typeof options.label, 'function');
  assert.equal(options.label(), `${NS}:view.label#1`);
  assert.equal(options.label(), `${NS}:view.label#2`, 'the label reads the locale at each call');
  const face = options.inject('s1');
  assert.deepEqual(Object.keys(face).sort(), ['call', 'hooks', 'signalState', 'store']);
  assert.equal(options.inject('s1').store, face.store, 'one store per session');
  assert.equal(typeof face.store.subscribe, 'function');
  assert.deepEqual(Object.keys(face.hooks), ['theme']);
  assert.deepEqual(face.hooks.theme.getSnapshot(), { active: { id: 'dark' }, revision: 1 });
  assert.deepEqual(face.hooks.theme.getSnapshot(), { active: { id: 'dark' }, revision: 2 }, 'the snapshot reads the theme at each call');
  const listener = () => {};
  const unsubscribe = face.hooks.theme.subscribe(listener);
  assert.ok(fake.log.some(e => e.call === 'on' && e.event === 'theme/change' && e.listener === listener));
  unsubscribe();
  assert.ok(fake.log.some(e => e.call === 'off' && e.event === 'theme/change'));
});

test('the entry\'s inject binds its session into every call, over a sessionId the payload carries', async (t) => {
  stubDocument(t);
  const fake = fakeCtx();
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { call } = viewEntry(fake).options.inject('s1');
  const overrides = { 'a.js': 'exclude' };
  await call('status');
  await call('preview', { overrides, sessionId: 'other' });
  assert.deepEqual(fake.log.filter(e => e.call === 'rpc.call').map(({ channel, endpoint, payload }) => ({ channel, endpoint, payload })), [
    { channel: '/session-watcher', endpoint: 'status', payload: { sessionId: 's1' } },
    { channel: '/session-watcher', endpoint: 'preview', payload: { overrides, sessionId: 's1' } },
  ]);
});

test('undeclaring the slot disposes the entry and redeclaring registers it once more', (t) => {
  stubDocument(t);
  const fake = fakeCtx();
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  fake.undeclare();
  for (const name of ['conversation.view', 'conversation.composer.dock']) {
    const entries = entriesOf(fake, name);
    assert.equal(entries.length, 1, name);
    assert.equal(entries[0].disposed, 1, name);
  }
  fake.declare();
  for (const name of ['conversation.view', 'conversation.composer.dock']) {
    const entries = entriesOf(fake, name);
    assert.equal(entries.length, 2, name);
    assert.equal(entries[1].disposed, 0, name);
    assert.equal(entries[1].options.id, 'session-watcher', name);
  }
});

test('applyClient registers the locale, the stylesheet, the view and the dock, and both slots\' inject answer the same store for one session', (t) => {
  const { head } = stubDocument(t);
  const fake = fakeCtx();
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  assert.equal(fake.log.filter(e => e.call === 'locale.register').length, 1);
  assert.equal(head.children.length, 1);
  assert.equal(entriesOf(fake, 'conversation.view').length, 1);
  const docks = entriesOf(fake, 'conversation.composer.dock');
  assert.equal(docks.length, 1);
  const [{ options, component }] = docks;
  assert.equal(options.id, 'session-watcher');
  assert.equal(options.order, 10);
  assert.equal(options.locale, NS);
  assert.equal(typeof component, 'function');
  const face = options.inject('s1');
  assert.deepEqual(Object.keys(face), ['store']);
  assert.equal(face.store, viewEntry(fake).options.inject('s1').store, 'the dock and the view share the session\'s store');
  assert.notEqual(options.inject('s2').store, face.store);
});

test('the registered dock is built from the hooks applyClient was handed', (t) => {
  stubDocument(t);
  const fake = fakeCtx();
  const { calls, ...hooks } = hookFakes();
  applyClient(fake.ctx, { tabCss: TAB_CSS, ...hooks });
  fake.declare();
  const [{ component: Dock }] = entriesOf(fake, 'conversation.composer.dock');
  const status = { lamp: 'green', L: 1000, B: 2000, rateLamp: { reliable: true, br: 0.1, u: 1, gEma: 10, rentMeter: { depthActive: true, depthProgress: 0.5 } } };
  const store = { result: { kind: 'live', snapshot: { status, history: [], capabilities: {}, bucketData: {} } }, subscribe: () => () => {} };
  const html = renderToString(React.createElement(Dock, { store, t: key => key }));
  assert.ok(html.includes('data-zone="green"'), html);
  assert.equal(calls.anchored.length, 1, 'the handed useAnchoredPosition runs');
  assert.equal(calls.dismiss.length, 1, 'the handed useDismissOnOutsidePointer runs');
  assert.equal(calls.anchored[0].open, false, 'the dock renders closed');
});

test('disposing the effects removes the style tag and the locale registration', (t) => {
  const { head } = stubDocument(t);
  const fake = fakeCtx();
  applyClient(fake.ctx, OPTIONS);
  assert.equal(head.children.length, 1);
  fake.disposeEffects();
  assert.equal(head.children.length, 0);
  assert.deepEqual(fake.log.filter(e => e.call === 'locale.dispose').map(e => e.ns), [NS]);
});

// ── The signal stream ────────────────────────────────────────────────────────

const EVENTS_URL = 'api/session-watcher.events';

// A macrotask hop through setImmediate drains every pending promise continuation.
const flush = () => new Promise(resolve => setImmediate(resolve));

const rpcCalls = fake => fake.log.filter(e => e.call === 'rpc.call');
const sessionsCalled = calls => calls.map(e => e.payload.sessionId);

test('the stream effect opens one EventSource on the relative events URL and its disposal closes it', (t) => {
  const fake = fakeCtx();
  const page = stubDocument(t, { inEffect: fake.inEffect });
  applyClient(fake.ctx, OPTIONS);
  assert.equal(page.sources.length, 1);
  const [source] = page.sources;
  assert.equal(source.url, EVENTS_URL);
  assert.equal(source.openedInEffect, true);
  assert.equal(page.visibilityListeners.size, 1);
  assert.equal(fake.generationListeners.size, 1);
  fake.disposeEffects();
  assert.equal(source.closeCalls, 1);
  assert.equal(page.visibilityListeners.size, 0, 'the visibility listener is removed');
  assert.equal(fake.generationListeners.size, 0, 'the generation subscription is removed');
  assert.equal(page.sources.length, 1);
});

test('a stream frame signals that session\'s store and an open signals every subscribed store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = fakeCtx();
  const page = stubDocument(t);
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { inject } = viewEntry(fake).options;
  inject('s1').store.subscribe(() => {});
  inject('s2').store.subscribe(() => {});
  inject('s3');
  await flush();
  const subscribed = rpcCalls(fake);
  assert.deepEqual(sessionsCalled(subscribed), ['s1', 's1', 's1', 's2', 's2', 's2']);
  assert.ok(subscribed.every(e => e.channel === '/session-watcher' && e.signal instanceof AbortSignal), 'each store call carries the pull\'s signal');
  t.mock.timers.tick(MIN_GAP_MS);
  const [source] = page.sources;
  source.emit('message', { data: JSON.stringify({ sessionId: 's1' }) });
  await flush();
  assert.deepEqual(sessionsCalled(rpcCalls(fake).slice(subscribed.length)), ['s1', 's1', 's1']);
  t.mock.timers.tick(MIN_GAP_MS);
  const beforeOpen = rpcCalls(fake).length;
  source.emit('open');
  await flush();
  assert.deepEqual(sessionsCalled(rpcCalls(fake).slice(beforeOpen)), ['s1', 's1', 's1', 's2', 's2', 's2'], 'an open signals every subscribed store and no other');
});

test('a generation snapshot with a new number closes the stream and opens another, and the same number, a first snapshot or a lost one leaves it open', (t) => {
  const fake = fakeCtx();
  const page = stubDocument(t);
  applyClient(fake.ctx, OPTIONS);
  fake.setGeneration({ id: 1, host: {} });
  fake.setGeneration(undefined);
  assert.equal(page.sources.length, 1, 'the same number and a lost snapshot leave the stream open');
  assert.equal(page.sources[0].closeCalls, 0);
  fake.setGeneration({ id: 2, host: {} });
  assert.equal(page.sources.length, 2);
  assert.equal(page.sources[0].closeCalls, 1, 'a new number closes the old stream');
  assert.equal(page.sources[1].url, EVENTS_URL);

  fake.disposeEffects();
  const late = fakeCtx({ generation: undefined });
  applyClient(late.ctx, OPTIONS);
  const lateSources = () => page.sources.slice(2);
  late.setGeneration({ id: 5, host: {} });
  assert.equal(lateSources().length, 1, 'a first snapshot only records its number');
  late.setGeneration(undefined);
  late.setGeneration({ id: 5, host: {} });
  assert.equal(lateSources().length, 1, 'the recorded number survives a lost snapshot');
  late.setGeneration({ id: 6, host: {} });
  assert.equal(lateSources().length, 2);
  assert.equal(lateSources()[0].closeCalls, 1);
});

test('a page that turns hidden closes its stream and holds none, a generation change while hidden opens none, and turning visible opens one whose open signals every subscribed store', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = fakeCtx();
  const page = stubDocument(t);
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  viewEntry(fake).options.inject('s1').store.subscribe(() => {});
  await flush();
  page.setVisibility('hidden');
  assert.equal(page.sources[0].closeCalls, 1);
  fake.setGeneration({ id: 2, host: {} });
  assert.equal(page.sources.length, 1, 'no stream opens while hidden');
  page.setVisibility('visible');
  assert.equal(page.sources.length, 2);
  assert.equal(page.sources[1].url, EVENTS_URL);
  t.mock.timers.tick(MIN_GAP_MS);
  const before = rpcCalls(fake).length;
  page.sources[1].emit('open');
  await flush();
  assert.deepEqual(sessionsCalled(rpcCalls(fake).slice(before)), ['s1', 's1', 's1']);

  fake.disposeEffects();
  page.doc.visibilityState = 'hidden';
  const hidden = fakeCtx();
  applyClient(hidden.ctx, OPTIONS);
  assert.equal(page.sources.length, 2, 'a page hidden at the effect\'s start opens nothing');
  page.setVisibility('visible');
  assert.equal(page.sources.length, 3);
});

test('the view entry\'s signalState follows the stream: connecting before an open, live after it, disconnected once the source closes, and every subscriber hears each change', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeCtx();
  const page = stubDocument(t);
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { signalState } = viewEntry(fake).options.inject('s1');
  assert.equal(viewEntry(fake).options.inject('s2').signalState, signalState, 'one state for every session');
  assert.equal(signalState.getSnapshot(), 'connecting');
  let heard = 0;
  const unsubscribe = signalState.subscribe(() => { heard += 1; });
  const [source] = page.sources;
  source.emit('open');
  assert.equal(signalState.getSnapshot(), 'live');
  assert.equal(heard, 1);
  source.close();
  source.emit('error');
  assert.equal(signalState.getSnapshot(), 'disconnected');
  t.mock.timers.tick(1000);
  assert.equal(signalState.getSnapshot(), 'connecting');
  unsubscribe();
  page.sources[1].emit('open');
  assert.equal(signalState.getSnapshot(), 'live');
  assert.equal(heard, 3, 'an unsubscribed listener hears nothing more');
});

test('a page that turns visible again opens a stream whose state restarts from connecting', (t) => {
  const fake = fakeCtx();
  const page = stubDocument(t);
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { signalState } = viewEntry(fake).options.inject('s1');
  page.sources[0].emit('open');
  page.setVisibility('hidden');
  page.setVisibility('visible');
  assert.equal(signalState.getSnapshot(), 'connecting');
  page.sources[1].emit('open');
  assert.equal(signalState.getSnapshot(), 'live');
});
