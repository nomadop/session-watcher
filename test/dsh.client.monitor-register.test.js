// The inner compaction monitor's `conversation.view` entry `applyClient` registers in an injection child of its own for every session once the slot is declared, and the signals that reach the monitor stores the entry hands out.
// Driven through `applyClient` on the recording ctx, which provides no service: the registration reads none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClient } from '../dsh/src/client/plugin.js';
import { NS } from '../dsh/src/client/locales.js';
import { OPTIONS, stubDocument, fakeCtx } from './helpers/dsh-client-context.js';
import { ok, rowsValue } from './helpers/dsh-monitor-wire.js';

const VIEW_ID = 'session-watcher.inner-compaction';

/** The applied client on a ctx with no service; `declareFirst` declares the slots before the client is applied. */
function mountClient(t, { rpcCall, declareFirst = false } = {}) {
  const page = stubDocument(t);
  const fake = fakeCtx({ rpcCall });
  if (declareFirst) fake.declare();
  applyClient(fake.ctx, OPTIONS);
  return { fake, page };
}

/** The registrations of the monitor's entry. */
const monitorEntries = fake => fake.registrations.filter(registration => registration.options.id === VIEW_ID);

test('declaring the slot registers the monitor entry once, under its own id, the plugin\'s locale and a label thunk that reads the locale at each call', (t) => {
  const { fake } = mountClient(t);
  assert.deepEqual(monitorEntries(fake), [], 'nothing before the slot is declared');

  fake.declare();

  const entries = monitorEntries(fake);
  assert.equal(entries.length, 1);
  const [{ options, component }] = entries;
  assert.equal(options.name, 'conversation.view');
  assert.equal(options.locale, NS);
  const meter = fake.registrations.find(registration => registration.options.name === 'conversation.view' && registration.options.id === 'session-watcher');
  assert.ok(options.order > meter.options.order, 'the tab follows the Session Watcher\'s');
  assert.equal(typeof options.inject, 'function');
  assert.equal(typeof component, 'function');
  const first = options.label();
  const second = options.label();
  assert.match(first, /^session-watcher:monitor\.label#\d+$/);
  assert.notEqual(first, second, 'the label reads the locale at each call');
  assert.ok(fake.translated.includes('monitor.label'));
  const { dicts } = fake.log.find(entry => entry.call === 'locale.register');
  assert.equal(dicts.zh[fake.translated.at(-1)], 'SW事件', 'the label the thunk asks for reads so in the registered Chinese dictionary');
  assert.equal(dicts.en[fake.translated.at(-1)], 'SW Events');
});

test('collapsing the slot declaration disposes the entry and declaring it again registers a fresh one', (t) => {
  const { fake } = mountClient(t);
  fake.declare();
  assert.equal(monitorEntries(fake).length, 1);
  assert.equal(monitorEntries(fake)[0].disposed, 0);

  fake.undeclare();
  assert.equal(monitorEntries(fake).length, 1);
  assert.equal(monitorEntries(fake)[0].disposed, 1);

  fake.declare();
  assert.equal(monitorEntries(fake).length, 2);
  assert.equal(monitorEntries(fake)[0].disposed, 1);
  assert.equal(monitorEntries(fake)[1].disposed, 0);
});

test('a slot already declared when the injection child arrives registers at once', (t) => {
  const { fake } = mountClient(t, { declareFirst: true });

  assert.equal(monitorEntries(fake).length, 1);
});

test('the injection child unloading disposes the entry, and a later declaration installs nothing of the monitor', (t) => {
  const { fake } = mountClient(t);
  fake.declare();
  assert.equal(fake.children.length, 1);

  fake.children[0].dispose();
  assert.equal(monitorEntries(fake)[0].disposed, 1);

  fake.undeclare();
  fake.declare();
  assert.equal(monitorEntries(fake).length, 1, 'no new registration');
  const meterEntries = fake.registrations.filter(registration => registration.options.name === 'conversation.view' && registration.options.id === 'session-watcher');
  assert.equal(meterEntries.length, 2, 'the Session Watcher view installs again, so it is the monitor\'s injection alone that is gone');
});

test('the monitor registers with no service but the slots, alongside the other entries', (t) => {
  const { fake } = mountClient(t);

  fake.declare();

  assert.equal(fake.children.length, 1, 'the monitor\'s injection child alone');
  assert.deepEqual(fake.registrations.map(registration => `${registration.options.name}:${registration.options.id}`).sort(), [
    'conversation.composer.dock:session-watcher',
    'conversation.hero.options:session-watcher.inner-mode',
    'conversation.session.header.actions:session-watcher.inner-mode',
    'conversation.view:session-watcher',
    `conversation.view:${VIEW_ID}`,
  ]);
});

test('the monitor entry does not follow the Developer Tools preference: the configuration mirror the host provides is asked for the plugin\'s own entry alone, and the entry is registered whatever that preference reads', (t) => {
  stubDocument(t);
  const asked = [];
  const form = { getSnapshot: () => ({ status: 'loading', value: undefined, revision: undefined, writable: true }), subscribe: () => () => {}, mutate: async () => true };
  const fake = fakeCtx({
    services: {
      configForms: () => ({
        developerTools: { enabled: { getSnapshot: () => false, subscribe: () => () => {} } },
        get(entryId) { asked.push(entryId); return form; },
      }),
    },
  });
  applyClient(fake.ctx, OPTIONS);

  fake.declare();

  assert.deepEqual(asked, ['session-watcher']);
  assert.equal(monitorEntries(fake).length, 1);
});

// ── What the entry hands out, and the signals that reach it ───────────────────

const rpcCalls = fake => fake.log.filter(entry => entry.call === 'rpc.call');
const rowReads = fake => rpcCalls(fake).filter(entry => entry.endpoint === 'inner-monitor');
const sessionsOf = calls => calls.map(entry => entry.payload.sessionId);
// A macrotask hop through setImmediate drains every pending promise continuation.
const flush = () => new Promise(resolve => setImmediate(resolve));
const frame = (page, sessionId) => page.sources[0].emit('message', { data: JSON.stringify({ sessionId }) });

test('the entry\'s inject hands the session\'s monitor handles and its session store, one set per session, and neither inject nor taking a handle reads', (t) => {
  const { fake } = mountClient(t);
  fake.declare();
  const { inject } = monitorEntries(fake)[0].options;

  const face = inject('s1');

  assert.deepEqual(Object.keys(face), ['monitor', 'session']);
  assert.deepEqual(Object.keys(face.monitor).sort(), ['readCurrentSettlement', 'resource', 'rows']);
  assert.equal(inject('s1').monitor, face.monitor, 'one set of handles per session');
  assert.notEqual(inject('s2').monitor, face.monitor);
  const tab = fake.registrations.find(registration => registration.options.name === 'conversation.view' && registration.options.id === 'session-watcher');
  assert.equal(face.session, tab.options.inject('s1').store, 'the store the tab reads, so the monitor\'s subscription shares its pulls');
  assert.equal(inject('s1').session, face.session, 'one store per session');
  assert.notEqual(inject('s2').session, face.session);
  assert.equal(face.session.result, null);
  assert.equal(typeof face.session.subscribe, 'function');
  assert.equal(face.monitor.rows.result, null);
  face.monitor.resource({ endpoint: 'inner-monitor/call', attempt: 1 });
  assert.deepEqual(rpcCalls(fake), [], 'no read until a handle is subscribed');
});

test('a stream frame re-reads the rows handle of its own session alone and an open re-reads every subscribed one, an unsubscribed session never; the handles are subscribed by hand, so this proves the store wiring and not a mounted component\'s effects', async (t) => {
  const { fake, page } = mountClient(t, { rpcCall: () => Promise.resolve(ok(rowsValue([]))) });
  fake.declare();
  const { inject } = monitorEntries(fake)[0].options;
  const s1 = inject('s1').monitor.rows;
  const s2 = inject('s2').monitor.rows;
  inject('s3');
  assert.deepEqual(rowReads(fake), [], 'inject reads nothing');

  s1.subscribe(() => {});
  s2.subscribe(() => {});
  await flush();
  assert.deepEqual(sessionsOf(rowReads(fake)), ['s1', 's2'], 'a subscription reads');

  frame(page, 's1');
  await flush();
  assert.deepEqual(sessionsOf(rowReads(fake)).slice(2), ['s1'], 'a frame reads its own session\'s handle and not the other subscribed one');

  frame(page, 's3');
  frame(page, 's-unknown');
  await flush();
  assert.equal(rowReads(fake).length, 3, 'a frame of a session with no subscriber, or of none the page knows, reads nothing');

  page.sources[0].emit('open');
  await flush();
  assert.deepEqual(sessionsOf(rowReads(fake)).slice(3), ['s1', 's2'], 'an open reads every subscribed handle and no other');
});
