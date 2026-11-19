// The `/sw-load` handoff picker `applyClient` registers on the client: the bare-invocation popup over the project's handoff catalog, what its options and selection do, and the registration it leaves with its injection child.
// Driven through `applyClient` on the recording ctx; the services the picker consumes are doubles that expose only the members it calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyClient } from '../dsh/src/client/plugin.js';
import { NS, en, zh } from '../dsh/src/client/locales.js';
import { OPTIONS, stubDocument, fakeCtx } from './helpers/dsh-client-context.js';

/** The `commandUi` a child reads: a decoration made through it is an effect of that child, as in Cordis, and `calls` lists each decorate, dismiss and undecorate in order. `decorate` answers the disposer the real method does. */
function fakeCommandUi(child) {
  const decorations = [];
  const calls = [];
  return {
    decorations,
    calls,
    decorate(decoration) {
      decorations.push(decoration);
      calls.push(`decorate:${decoration.name}`);
      const remove = () => {
        const at = decorations.indexOf(decoration);
        if (at === -1) return;
        decorations.splice(at, 1);
        calls.push(`undecorate:${decoration.name}`);
      };
      child.effect(() => remove);
      return remove;
    },
    dismiss(name) { calls.push(`dismiss:${name}`); },
  };
}

/**
 * The applied client with the picker's dependencies provided.
 * `scoped` lists the sessions `sessions.scope` finds a retained scope for; the input of a scope records each `setDraft` in `drafts`, except for a session of `refuseInput`, whose input is refused as the checkout's is for a scope it does not retain.
 */
function mountPicker(t, { scoped = ['s1'], refuseInput = [], rpcCall } = {}) {
  stubDocument(t);
  const drafts = [];
  const holder = {};
  const fake = fakeCtx({
    rpcCall,
    services: {
      commandUi: (child) => { holder.commandUi = fakeCommandUi(child); return holder.commandUi; },
      sessions: () => ({ scope: id => (scoped.includes(id) ? { sessionId: id } : undefined) }),
      conversation: () => ({
        input: {
          for(actx) {
            if (refuseInput.includes(actx.sessionId)) throw new Error('conversation.input.for requires a retained Session scope');
            return { setDraft: (text) => { drafts.push({ sessionId: actx.sessionId, text }); } };
          },
        },
      }),
    },
  });
  applyClient(fake.ctx, OPTIONS);
  fake.declare();
  const [decoration] = holder.commandUi.decorations;
  return { fake, commandUi: holder.commandUi, decoration, drafts };
}

test('applyClient decorates the bare /sw-load as a popupSelect once its own dependencies are provided', (t) => {
  const { commandUi, decoration } = mountPicker(t);

  assert.deepEqual(commandUi.decorations.map(each => each.name), ['sw-load']);
  assert.equal(decoration.available({ sessionId: 's1' }), true);
  assert.equal(decoration.ui.kind, 'popupSelect');
});

const liveReply = payload => ({ ok: true, value: { state: 'live', payload } });
const rpcCalls = fake => fake.log.filter(e => e.call === 'rpc.call');

test('options asks the channel for handoff/list with the opening session\'s id alone and hands the popup\'s signal to the call', async (t) => {
  const { fake, decoration } = mountPicker(t, { rpcCall: async () => liveReply({ items: [] }) });
  const signal = new AbortController().signal;

  await decoration.ui.options({ sessionId: 's1' }, signal);

  const [asked, ...others] = rpcCalls(fake);
  assert.deepEqual(others, []);
  assert.deepEqual({ channel: asked.channel, endpoint: asked.endpoint, payload: asked.payload },
    { channel: '/session-watcher', endpoint: 'handoff/list', payload: { sessionId: 's1' } });
  assert.equal(asked.signal, signal);
});

// The ages as the Host answers them: the Client shows them as they come.
const NEWEST = '5 min ago';
const MIDDLE = '3h ago';
const OLDEST = '2d ago';
// The delivery stamp is only compared with null.
const DELIVERED = 1_700_000_000_000;
// A row as the popup hands it back on selection.
const OPTION = { id: 'new-river-moth', label: 'new-river-moth', detail: 'x' };

// The Host's order is not an order a Client sort by group, age or token (either way) would produce: the groups alternate, and the ages and tokens run in no direction.
test('options keeps the order the catalog came in: the token as id and label, the age before the task, the age alone for a missing or empty task, and a group per delivery state', async (t) => {
  const items = [
    { loadToken: 'mid-river-moth', age: MIDDLE, nextTask: 'ship the picker', deliveredAt: null },
    { loadToken: 'zeta-pine-fox', age: OLDEST, nextTask: 'delivered task', deliveredAt: DELIVERED },
    { loadToken: 'alpha-lamp-crow', age: NEWEST, nextTask: null, deliveredAt: null },
    { loadToken: 'beta-blank-elk', age: MIDDLE, nextTask: '', deliveredAt: DELIVERED },
  ];
  const { decoration } = mountPicker(t, { rpcCall: async () => liveReply({ items }) });

  const options = await decoration.ui.options({ sessionId: 's1' }, new AbortController().signal);

  assert.deepEqual(options.map(({ id, label, detail }) => ({ id, label, detail })), [
    { id: 'mid-river-moth', label: 'mid-river-moth', detail: '3h ago · ship the picker' },
    { id: 'zeta-pine-fox', label: 'zeta-pine-fox', detail: '2d ago · delivered task' },
    { id: 'alpha-lamp-crow', label: 'alpha-lamp-crow', detail: '5 min ago' },
    { id: 'beta-blank-elk', label: 'beta-blank-elk', detail: '3h ago' },
  ]);
  assert.deepEqual(options.map(option => option.group.name), ['undelivered', 'delivered', 'undelivered', 'delivered']);
  assert.ok(options[0].group.label.startsWith(`${NS}:picker.group.undelivered#`));
  assert.ok(options[1].group.label.startsWith(`${NS}:picker.group.delivered#`));
  for (const option of options) assert.deepEqual(Object.keys(option).sort(), ['detail', 'group', 'id', 'label'], 'no icon, badge, active mark or confirmation');
});

test('options rejects with the failure\'s own text for an explicit failure, a state that is not live, a rejected call and a call that throws, and loads nothing else', async (t) => {
  const cases = [
    { answer: () => Promise.resolve({ ok: false, error: { code: 'handler_failed', message: 'listing broke', details: {} } }), text: message => message.includes('listing broke') },
    { answer: () => Promise.resolve({ ok: true, value: { state: 'unobserved' } }), text: message => message.startsWith(`${NS}:state.unobserved`) },
    { answer: () => Promise.resolve({ ok: true, value: { state: 'bootstrapping' } }), text: message => message.startsWith(`${NS}:state.bootstrapping`) },
    {
      answer: () => Promise.resolve({ ok: true, value: { state: 'failed', diagnostic: { scope: 'dsh-host', code: 'read_session_rejected', message: 'read refused' } } }),
      text: message => message.includes('read refused'),
    },
    { answer: () => Promise.reject(new Error('transport failure for /session-watcher/handoff/list: HTTP 500')), text: message => message.includes('HTTP 500') },
    { answer: () => { throw new Error('connection is gone'); }, text: message => message.includes('connection is gone') },
  ];
  for (const { answer, text } of cases) {
    const { fake, decoration, drafts } = mountPicker(t, { rpcCall: answer });
    const settling = decoration.ui.options({ sessionId: 's1' }, new AbortController().signal);
    await assert.rejects(settling, error => text(error.message), answer.toString());
    assert.equal(rpcCalls(fake).length, 1, 'one catalog read and nothing else');
    assert.deepEqual(drafts, []);
  }
});

test('an empty catalog is an empty option list under search copy for an empty catalog and for no match, and a single candidate is listed instead of chosen', async (t) => {
  let items = [];
  const { decoration, drafts } = mountPicker(t, { rpcCall: async () => liveReply({ items }) });
  const signal = new AbortController().signal;

  assert.deepEqual(await decoration.ui.options({ sessionId: 's1' }, signal), []);
  const labels = decoration.ui.searchLabels();
  assert.deepEqual(Object.keys(labels).sort(), ['empty', 'noResults', 'placeholder']);
  assert.ok(labels.empty.startsWith(`${NS}:picker.empty#`));
  assert.ok(labels.noResults.startsWith(`${NS}:picker.noResults#`));
  assert.ok(labels.placeholder.startsWith(`${NS}:picker.search#`));
  assert.equal(decoration.ui.searchMode ?? 'substring', 'substring', 'a token and a task text both match by substring');

  items = [{ loadToken: 'only-river-moth', age: NEWEST, nextTask: null, deliveredAt: null }];
  const options = await decoration.ui.options({ sessionId: 's1' }, signal);
  assert.deepEqual(options.map(option => option.id), ['only-river-moth']);
  assert.deepEqual(drafts, []);
});

test('every text the picker asks the locale for has an entry in both dictionaries', async (t) => {
  const items = [
    { loadToken: 'new-river-moth', age: NEWEST, nextTask: 'ship the picker', deliveredAt: null },
    { loadToken: 'done-pine-fox', age: OLDEST, nextTask: null, deliveredAt: DELIVERED },
  ];
  const { fake, decoration } = mountPicker(t, { rpcCall: async () => liveReply({ items }) });

  decoration.ui.searchLabels();
  await decoration.ui.options({ sessionId: 's1' }, new AbortController().signal);
  assert.throws(() => decoration.ui.onSelect(OPTION, { sessionId: 'gone' }));

  const asked = fake.translated.filter(key => key.startsWith('picker.'));
  assert.ok(asked.length > 0, 'the picker asked for its own texts');
  for (const key of new Set(asked)) {
    assert.equal(typeof en[key], 'string', `en ${key}`);
    assert.equal(typeof zh[key], 'string', `zh ${key}`);
  }
});

test('selecting a row replaces the draft of the session that opened the popup with its load command, at once, and runs nothing', (t) => {
  const { fake, decoration, drafts } = mountPicker(t, { scoped: ['s1', 's2'] });

  decoration.ui.onSelect(OPTION, { sessionId: 's2' });

  assert.deepEqual(drafts, [{ sessionId: 's2', text: '/sw-load new-river-moth' }]);
  assert.deepEqual(rpcCalls(fake), [], 'no command or delivery goes out');
});

test('a selection that finds no retained scope or no input for its session fails with the popup\'s error path, writes no draft and leaves the row selectable again', (t) => {
  const { fake, decoration, drafts } = mountPicker(t, { scoped: ['s1', 's3'], refuseInput: ['s3'] });

  assert.throws(() => decoration.ui.onSelect(OPTION, { sessionId: 's2' }), error => error.message.startsWith(`${NS}:picker.noSession`));
  assert.throws(() => decoration.ui.onSelect(OPTION, { sessionId: 's3' }), { message: 'conversation.input.for requires a retained Session scope' });
  assert.deepEqual(drafts, []);
  assert.deepEqual(rpcCalls(fake), []);

  decoration.ui.onSelect(OPTION, { sessionId: 's1' });
  assert.deepEqual(drafts, [{ sessionId: 's1', text: '/sw-load new-river-moth' }]);
});

test('the child\'s unloading dismisses the command\'s open popups before it removes the decoration', (t) => {
  const { fake, commandUi } = mountPicker(t);
  assert.deepEqual(commandUi.calls, ['decorate:sw-load']);

  fake.children[0].dispose();

  assert.deepEqual(commandUi.calls, ['decorate:sw-load', 'dismiss:sw-load', 'undecorate:sw-load']);
  assert.deepEqual(commandUi.decorations, []);
});

test('the view and the dock register without the services the picker reads, and the picker waits for them', (t) => {
  stubDocument(t);
  const fake = fakeCtx();

  applyClient(fake.ctx, OPTIONS);
  fake.declare();

  for (const name of ['conversation.view', 'conversation.composer.dock']) {
    assert.equal(fake.registrations.filter(registration => registration.options.name === name && registration.options.id === 'session-watcher').length, 1, name);
  }
  assert.equal(fake.children.length, 1, 'no picker without commandUi, sessions and conversation: the monitor\'s injection child, which reads `slots` alone, is the only one');
});
