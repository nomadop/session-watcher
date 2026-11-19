// The DSH client plugin's `applyClient` on a fake ctx: the locale, the tab stylesheet and the signal stream inside effects, the stream held across visibility and connection generations, and the `conversation.view` and `conversation.composer.dock` entries registered per slot declaration lifetime over one store per session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { applyClient } from '../dsh/src/client/plugin.js';
import { SessionWatcherTab } from '../dsh/src/client/tab.js';
import { ModeToggle, ModeMark } from '../dsh/src/client/mode.js';
import { NS, en, zh } from '../dsh/src/client/locales.js';
import { MIN_GAP_MS } from '../dsh/src/client/session-store.js';
import { MONITOR_VIEW_ID } from '../dsh/src/client/monitor-register.js';
import { TAB_CSS, OPTIONS, hookFakes, stubDocument, fakeCtx } from './helpers/dsh-client-context.js';

/** The registrations of one slot, by the entry's `name`, the monitor's `conversation.view` entry left to the tests of `monitor-register.js`. */
const entriesOf = (fake, name) => fake.registrations.filter(r => r.options.name === name && r.options.id !== MONITOR_VIEW_ID);
const viewEntry = fake => entriesOf(fake, 'conversation.view')[0];

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
  assert.deepEqual(fake.injections.map(i => i.key), [
    'conversation.view', 'conversation.composer.dock', 'conversation.hero.options', 'conversation.session.header.actions', 'conversation.view',
  ], 'the last is the monitor\'s, held by an injection child of its own');
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

// ── The session mode entries ─────────────────────────────────────────────────

const toggleEntry = fake => entriesOf(fake, 'conversation.hero.options')[0];
const markEntry = fake => entriesOf(fake, 'conversation.session.header.actions')[0];

const modeCalls = fake => rpcCalls(fake).filter(e => e.endpoint.startsWith('inner-mode'));
const readsOf = fake => modeCalls(fake).filter(e => e.endpoint === 'inner-mode');

const ready = (mode, locked) => ({ ok: true, value: { mode, locked } });
const unavailableReply = { ok: false, error: { code: 'inner_mode_unavailable', message: 'The inner compaction mode is not available in this host.', details: {} } };

test('declaring the slots registers the toggle under conversation.hero.options and the mark under conversation.session.header.actions, each with the plugin\'s locale, and undeclaring disposes them', (t) => {
  stubDocument(t);
  const fake = fakeCtx();
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  for (const [entry, component] of [[toggleEntry(fake), ModeToggle], [markEntry(fake), ModeMark]]) {
    assert.equal(entry.component, component);
    assert.equal(entry.options.id, 'session-watcher.inner-mode');
    assert.equal(entry.options.locale, NS);
  }
  fake.undeclare();
  assert.equal(toggleEntry(fake).disposed, 1);
  assert.equal(markEntry(fake).disposed, 1);
});

test('each entry\'s inject binds its session into the mode RPCs and both entries of a session share one reader', async (t) => {
  stubDocument(t);
  const fake = fakeCtx({ rpcCall: (_channel, endpoint) => Promise.resolve(endpoint === 'inner-mode' ? ready('off', false) : { ok: true, value: {} }) });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const toggle = toggleEntry(fake).options.inject('s1');
  const mark = markEntry(fake).options.inject('s1');
  assert.deepEqual(Object.keys(toggle).sort(), ['reader', 'select', 'visibility']);
  assert.deepEqual(Object.keys(mark).sort(), ['reader']);
  assert.equal(toggle.reader, mark.reader, 'one reader per session');
  assert.notEqual(toggleEntry(fake).options.inject('s2').reader, toggle.reader);
  toggle.reader.subscribe(() => {});
  await toggleEntry(fake).options.inject('s2').select(true);
  await toggle.select(false);
  await flush();
  assert.deepEqual(modeCalls(fake).map(({ channel, endpoint, payload }) => ({ channel, endpoint, payload })), [
    { channel: '/session-watcher', endpoint: 'inner-mode', payload: { sessionId: 's1' } },
    { channel: '/session-watcher', endpoint: 'inner-mode/select', payload: { sessionId: 's2', enabled: true } },
    { channel: '/session-watcher', endpoint: 'inner-mode/select', payload: { sessionId: 's1', enabled: false } },
  ]);
});

test('a reader holds no result before its read, the mode and lock a successful read answers, and unavailable for any other answer, which a later read replaces', async (t) => {
  const page = stubDocument(t);
  const answers = [unavailableReply, ready('on', false), { ok: true, value: { state: 'bootstrapping' } }, new Error('transport'), ready('on', true)];
  const fake = fakeCtx({ rpcCall: () => { const next = answers.shift(); return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); } });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { reader } = markEntry(fake).options.inject('s1');
  const heard = [];
  assert.equal(reader.result, null);
  const unsubscribe = reader.subscribe(result => heard.push(result));
  assert.deepEqual(heard, [], 'a new subscriber reads the result first');
  await flush();
  assert.deepEqual(reader.result, { kind: 'unavailable' });
  for (const expected of [{ kind: 'ready', mode: 'on', locked: false }, { kind: 'unavailable' }, { kind: 'unavailable' }, { kind: 'ready', mode: 'on', locked: true }]) {
    page.sources[0].emit('message', { data: JSON.stringify({ sessionId: 's1' }) });
    await flush();
    assert.deepEqual(reader.result, expected);
  }
  assert.deepEqual(heard, [
    { kind: 'unavailable' }, { kind: 'ready', mode: 'on', locked: false }, { kind: 'unavailable' }, { kind: 'unavailable' }, { kind: 'ready', mode: 'on', locked: true },
  ]);
  unsubscribe();
});

test('after an unavailable reply a frame re-reads only that session\'s subscribed reader and an open re-reads every subscribed reader', async (t) => {
  const page = stubDocument(t);
  const fake = fakeCtx({ rpcCall: (_channel, endpoint) => Promise.resolve(endpoint === 'inner-mode' ? unavailableReply : { ok: true, value: { state: 'bootstrapping' } }) });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { inject } = markEntry(fake).options;
  inject('s1').reader.subscribe(() => {});
  inject('s2').reader.subscribe(() => {});
  inject('s3');
  await flush();
  assert.deepEqual(readsOf(fake).map(e => e.payload.sessionId), ['s1', 's2'], 'a subscription reads');
  assert.deepEqual(inject('s1').reader.result, { kind: 'unavailable' });
  const [source] = page.sources;
  source.emit('message', { data: JSON.stringify({ sessionId: 's1' }) });
  await flush();
  assert.deepEqual(readsOf(fake).map(e => e.payload.sessionId).slice(2), ['s1'], 'a frame reads its own session\'s reader');
  source.emit('message', { data: JSON.stringify({ sessionId: 's3' }) });
  source.emit('message', { data: JSON.stringify({ sessionId: 's-unknown' }) });
  await flush();
  assert.equal(readsOf(fake).length, 3, 'a frame for an unsubscribed or unknown session reads nothing');
  source.emit('open');
  await flush();
  assert.deepEqual(readsOf(fake).map(e => e.payload.sessionId).slice(3), ['s1', 's2'], 'an open reads every subscribed reader and no other');
});

test('a reader coalesces signals that arrive while its read is in flight into one more read', async (t) => {
  const page = stubDocument(t);
  const replies = [];
  const fake = fakeCtx({
    rpcCall: (_channel, endpoint) => (endpoint === 'inner-mode' ? new Promise(resolve => replies.push(resolve)) : Promise.resolve({ ok: true, value: { state: 'bootstrapping' } })),
  });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { reader } = markEntry(fake).options.inject('s1');
  reader.subscribe(() => {});
  const [source] = page.sources;
  for (let frame = 0; frame < 3; frame += 1) source.emit('message', { data: JSON.stringify({ sessionId: 's1' }) });
  await flush();
  assert.equal(replies.length, 1, 'one read in flight');
  replies.shift()(ready('off', false));
  await flush();
  assert.equal(replies.length, 1, 'the frames that arrived meanwhile cost one more read');
  replies.shift()(ready('on', false));
  await flush();
  assert.deepEqual(reader.result, { kind: 'ready', mode: 'on', locked: false });
  assert.equal(replies.length, 0);
});

test('the face\'s selection handler leaves the displayed mode as it was whatever the reply, and only the session\'s frame re-reads it; a rejected selection changes no reader value and re-reads nothing', async (t) => {
  const page = stubDocument(t);
  let mode = 'off';
  let selectReply = { ok: true, value: {} };
  const fake = fakeCtx({
    rpcCall: (_channel, endpoint, payload) => {
      if (endpoint === 'inner-mode/select') {
        if (selectReply instanceof Error) return Promise.reject(selectReply);
        if (selectReply.ok) mode = payload.enabled ? 'on' : 'off';
        return Promise.resolve(selectReply);
      }
      return Promise.resolve(ready(mode, false));
    },
  });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const { reader, select } = toggleEntry(fake).options.inject('s1');
  reader.subscribe(() => {});
  await flush();
  assert.deepEqual(reader.result, { kind: 'ready', mode: 'off', locked: false });
  const reads = () => readsOf(fake).length;
  const before = reads();

  assert.deepEqual(await select(true), { ok: true, value: {} });
  await flush();
  assert.deepEqual(reader.result, { kind: 'ready', mode: 'off', locked: false }, 'a successful reply sets no mode');
  assert.equal(reads(), before, 'and re-reads nothing');
  page.sources[0].emit('message', { data: JSON.stringify({ sessionId: 's1' }) });
  await flush();
  assert.deepEqual(reader.result, { kind: 'ready', mode: 'on', locked: false }, 'the session\'s frame carries the re-read');

  for (const reply of [{ ok: false, error: { code: 'inner_mode_locked', message: 'locked', details: {} } }, unavailableReply, new Error('transport')]) {
    selectReply = reply;
    const settled = reply instanceof Error ? await select(false).then(() => 'resolved', () => 'rejected') : await select(false);
    await flush();
    assert.ok(settled === 'rejected' || settled.ok === false);
    assert.deepEqual(reader.result, { kind: 'ready', mode: 'on', locked: false }, 'a rejected selection leaves the value');
    assert.equal(reads(), before + 1, 'and re-reads nothing by itself');
  }
});

// ── The mode components ──────────────────────────────────────────────────────

const t = key => key;
const readerOf = result => ({ result, subscribe: () => () => {} });
const flagOf = flag => ({ getSnapshot: () => flag, subscribe: () => () => {} });
const renderToggle = (result, shown = true) => renderToString(React.createElement(ModeToggle, { reader: readerOf(result), select: async () => ({ ok: true, value: {} }), visibility: flagOf(shown), t }));
const renderMark = result => renderToString(React.createElement(ModeMark, { reader: readerOf(result), t }));

test('the toggle renders while the mode is read and unlocked, its switch showing the mode, and nothing for an unread, unavailable, locked or invalid state', () => {
  assert.equal(renderToggle(null), '');
  assert.equal(renderToggle({ kind: 'unavailable' }), '');
  assert.equal(renderToggle({ kind: 'ready', mode: 'off', locked: true }), '');
  assert.equal(renderToggle({ kind: 'ready', mode: 'on', locked: true }), '');
  assert.equal(renderToggle({ kind: 'ready', mode: 'invalid', locked: false }), '');
  const off = renderToggle({ kind: 'ready', mode: 'off', locked: false });
  assert.match(off, /role="switch"/);
  assert.match(off, /aria-checked="false"/);
  assert.ok(off.includes('mode.toggle'), off);
  const on = renderToggle({ kind: 'ready', mode: 'on', locked: false });
  assert.match(on, /aria-checked="true"/);
});

test('the toggle is shown only while the setting shows the option, whatever mode the session holds: hidden it renders nothing for an off, an on or any other read, and the mark of a started session does not follow it', () => {
  for (const result of [{ kind: 'ready', mode: 'off', locked: false }, { kind: 'ready', mode: 'on', locked: false }]) assert.equal(renderToggle(result, false), '', JSON.stringify(result));
  assert.match(renderToggle({ kind: 'ready', mode: 'on', locked: false }, true), /aria-checked="true"/, 'the mode a hidden option left chosen shows again once the option does');
  assert.ok(renderMark({ kind: 'ready', mode: 'on', locked: true }).includes('mode.mark'));
});

test('the mark renders for an on mode that is locked and nothing for any other state', () => {
  assert.equal(renderMark(null), '');
  assert.equal(renderMark({ kind: 'unavailable' }), '');
  assert.equal(renderMark({ kind: 'ready', mode: 'on', locked: false }), '');
  assert.equal(renderMark({ kind: 'ready', mode: 'off', locked: true }), '');
  assert.equal(renderMark({ kind: 'ready', mode: 'invalid', locked: true }), '');
  const mark = renderMark({ kind: 'ready', mode: 'on', locked: true });
  assert.ok(mark.includes('mode.mark'), mark);
  assert.doesNotMatch(mark, /<button|role="switch"/);
});
