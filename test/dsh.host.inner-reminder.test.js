// The inner mode of a DSH session reaching the Rate Lamp budget through the host: a new session that chooses the mode before its first turn, over the channel or by inheritance, has the qualified prefix of its Source for its budget from its first call, because the table's frames read the mode the inner child's projection answers.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { closeStoreGlobal } from '../lib/store.js';
import { getLiveLedger, _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { createFakeContext, fakeTokenMeter, fakeFs } from './helpers/dsh-fake-context.js';
import { INHERITING_SETTINGS, modeKit, newSession, fakeAgents } from './helpers/dsh-mode-kit.js';
import { authoredLog, BUDGET_AT_POST } from './helpers/dsh-inner-reminder-log.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-host-reminder-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const settled = () => new Promise(resolve => setImmediate(resolve));

const bill = ledger => ledger.billCycleCount + ledger.billProgress;
const wallet = ledger => ledger.walletLapCount + ledger.walletPhase;

// The `sessionProjections` service the inner child reads: `register` answers a handle whose `stateOf` folds the session's log under the definition, once `gate` (a promise) settles when one is given.
function projections(gate = Promise.resolve(), { unreadable = false } = {}) {
  const handleFor = definition => ({
    stateOf: (session) => {
      if (unreadable) throw new Error('the projection cannot be read');
      return session.snapshotEvents().reduce((state, event) => definition.apply(state, event), definition.init());
    },
  });
  return { register: definition => gate.then(() => handleFor(definition)) };
}

const blank = id => newSession(id, { header: { cwd: '/repo' } });

// The host over a fake context listing `sessions`, each reading an empty snapshot at bootstrap, with the `/session-watcher` channel's handler; the inner child is mounted unless `withInnerChild` is false and is ready once `gate` settles.
function mountHost({ sessions, gate, withInnerChild = true, unreadable = false }) {
  const handled = [];
  const connection = {
    rpc: { handle(channel, handler) { handled.push(handler); return async () => {}; } },
    fetch: { register() { return async () => {}; } },
  };
  const ctx = createFakeContext({
    sessions,
    readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }),
    connection, webServer: {},
    tokenMeter: fakeTokenMeter(), fs: fakeFs(), agents: fakeAgents(), attachments: {}, sessionProjections: projections(gate, { unreadable }),
  });
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR, ...(withInnerChild ? { innerKit: modeKit, readSettings: () => INHERITING_SETTINGS } : {}),
  });
  return { ctx, table, handler: handled[0] };
}

const call = (handler, endpoint, payload) => handler(endpoint, payload, new AbortController().signal, { kind: 'operator' });
const select = (handler, session, enabled) => call(handler, 'inner-mode/select', { sessionId: session.id, enabled });
const selected = { ok: true, value: {} };

// The authored log up to the third post and the calls pending behind it: the head and the three posts are the qualified path, the calls before the first carrier and the ones behind the third post are pending, and an ordinary session counts them all.
const entries = authoredLog();
const FIRST_CARRIER = entries.findIndex(entry => entry.kind === 'carrier');
const THIRD_POST = entries.findIndex(entry => entry.post === 3);
const events = entries.map(entry => entry.event);
const feed = (ctx, session, run) => { for (const event of run) ctx.emit('session/event', session, event); };
const isThreePosts = ledger => Math.abs(bill(ledger) - BUDGET_AT_POST[3].bill) < 1e-9 && Math.abs(wallet(ledger) - BUDGET_AT_POST[3].wallet) < 1e-9;

test('a new session that selects the mode before its first turn counts the qualified prefix of its Source from its first call, and one that selects none or off counts every call', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const [on, off, none] = [blank('s-on'), blank('s-off'), blank('s-none')];
  const { ctx, handler } = mountHost({ sessions: [on, off, none], gate });
  await settled();
  release();
  await settled();
  assert.deepEqual(await select(handler, on, true), selected);
  assert.deepEqual(await select(handler, off, false), selected);
  for (const session of [on, off, none]) session.append('turn/start', { turn: 1 });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: on.id }), { ok: true, value: { mode: 'on', locked: true } });

  feed(ctx, on, events.slice(0, FIRST_CARRIER));
  for (const session of [off, none]) feed(ctx, session, events.slice(0, FIRST_CARRIER));
  assert.equal(bill(getLiveLedger(on.id)), 0, 'the calls before the first carrier are pending');
  for (const session of [off, none]) assert.ok(bill(getLiveLedger(session.id)) > 0, `${session.id} counts them`);

  feed(ctx, on, events.slice(FIRST_CARRIER, THIRD_POST + 7));
  for (const session of [off, none]) feed(ctx, session, events.slice(FIRST_CARRIER, THIRD_POST + 7));
  assert.ok(isThreePosts(getLiveLedger(on.id)), `the three posts cost ${bill(getLiveLedger(on.id))}`);
  for (const session of [off, none]) {
    assert.ok(!isThreePosts(getLiveLedger(session.id)), `${session.id} counts the calls pending behind the third post`);
  }
  ctx.dispose();
});

test('a plain subagent given its parent\'s mode before its first turn counts the qualified prefix of its Source from its first call', async () => {
  const parent = blank('s-parent');
  const sessions = [parent];
  const { ctx, handler } = mountHost({ sessions });
  await settled();
  assert.deepEqual(await select(handler, parent, true), selected);
  const child = newSession('s-child', { header: { cwd: '/repo', origin: 'subagent', parentSession: parent.id } });
  sessions.push(child);
  ctx.emit('session/created', child);
  await settled();
  await ctx.emit('agent/created', { agent: { session: child }, source: 'startup' });
  assert.deepEqual(await call(handler, 'inner-mode', { sessionId: child.id }), { ok: true, value: { mode: 'on', locked: false } });
  child.append('turn/start', { turn: 1 });

  feed(ctx, child, events.slice(0, FIRST_CARRIER));
  assert.equal(bill(getLiveLedger(child.id)), 0, 'the calls before the first carrier are pending');
  feed(ctx, child, events.slice(FIRST_CARRIER, THIRD_POST + 7));
  assert.ok(isThreePosts(getLiveLedger(child.id)), `the three posts cost ${bill(getLiveLedger(child.id))}`);
  ctx.dispose();
});

test('a host that mounts no inner child leaves every session\'s budget the whole path\'s', async () => {
  const session = blank('s-no-child');
  modeKit.appendPluginRecord(session, 'plugin:session-watcher/inner-mode', { v: 1, enabled: true });
  const { ctx } = mountHost({ sessions: [session], withInnerChild: false });
  await settled();
  feed(ctx, session, events.slice(0, THIRD_POST + 7));
  assert.ok(bill(getLiveLedger(session.id)) > 0 && !isThreePosts(getLiveLedger(session.id)));
  ctx.dispose();
});

test('a mode read that throws fails the watcher through the frame seam instead of leaving the session an ordinary one', async (t) => {
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = realError; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const session = blank('s-unreadable');
  const { ctx, table } = mountHost({ sessions: [session], gate, unreadable: true });
  await settled();
  assert.equal(table.get(session.id).state, 'live', 'no child is ready yet: nothing is read');
  release();
  await settled();
  feed(ctx, session, events.slice(0, 1));
  assert.equal(table.get(session.id).state, 'failed');
  assert.deepEqual(table.get(session.id).diagnostic, { scope: 'dsh-host', code: 'frame_application_failed', message: 'the projection cannot be read' });
  assert.ok(lines.some(line => line.includes('s-unreadable [dsh-host] frame_application_failed: the projection cannot be read')), lines.join('\n'));
  ctx.dispose();
});
