// `/sw-load` over the host: its registration on the `commands`, `workingDirectory` and `fs` services, its arguments and idle check, the failures of the host's own delivery, the title a delivered handoff gives the session, the shared Working Tree it reads through, and the hand-over of a loaded handoff. The fake context's recording session, `workingDirectory` and `fs` stand in for DSH's; the delivery is the host's, over the real store; the load's failure-value matrix is `test/dsh.load.test.js`.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { LOAD_MESSAGE_KIND } from '../lib/harness/dsh/load-message.js';
import { loadedText } from '../dsh/src/load.js';
import { nodeWorkingTree } from '../dsh/src/composition.js';
import { fakeSessionTitle } from './helpers/dsh-fake-context.js';
import { dshCallLog, readResultText } from './helpers/attribution-fixtures.js';
import {
  PROJECT, ROUTE, SESSION_ID, commandAgent, deferred, invoke, logFlushes, mountClear as mountOn, seedHandoff, settled,
} from './helpers/dsh-command-host.js';

let dir;
let mounted;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sw-dsh-load-')));
  mounted = [];
  _resetRateLampManagerForTest();
});

afterEach(() => {
  for (const ctx of mounted) ctx.dispose();
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const mountLoad = (options = {}) => mountOn({ dir, mounted, ...options });
const named = (definitions, name) => definitions.filter(definition => definition.name === name);
const load = (commands, agent, options) => invoke(commands, 'sw-load', agent, options);
const failure = text => ({ kind: 'error', text });
const success = text => ({ kind: 'success', text });

// A handoff another session of the project prepared and nobody has loaded.
const seedPending = ({ loadToken, createdAt = Date.now(), nextTask, pathsToKeep }) => seedHandoff({
  sessionId: 's-src', loadToken, createdAt, nextTask, pathsToKeep, projectId: PROJECT,
});

// --- Registration ---

test('with commands, workingDirectory and fs the command is registered once under its name, description and input hint', async () => {
  const { commands } = mountLoad();
  await settled();
  const loads = named(commands.registered, 'sw-load');
  assert.equal(loads.length, 1);
  const [definition] = loads;
  assert.equal(definition.description, 'Load a handoff into the session');
  assert.deepEqual(definition.input, { hint: 'handoff token (optional)' });
  assert.equal(typeof definition.handler, 'function');
  assert.deepEqual(commands.unregistered, []);
});

for (const absent of ['commands', 'workingDirectory', 'fs']) {
  test(`without ${absent} /sw-load is not registered and the host still mounts`, async () => {
    const { commands, table } = mountLoad({ absent });
    await settled();
    assert.deepEqual(named(commands.registered, 'sw-load'), []);
    assert.equal(table.get(SESSION_ID).state, 'live');
  });
}

for (const absent of ['workingDirectory', 'fs']) {
  test(`without ${absent} /sw-continue is not registered either`, async () => {
    const { commands } = mountLoad({ absent });
    await settled();
    assert.deepEqual(named(commands.registered, 'sw-continue'), []);
  });
}

for (const leaving of ['commands', 'workingDirectory', 'fs']) {
  test(`unproviding ${leaving} runs /sw-load's disposer`, async () => {
    const { commands, ctx } = mountLoad();
    await settled();
    ctx.unprovide(leaving);
    assert.deepEqual(commands.unregistered.filter(name => name === 'sw-load'), ['sw-load']);
  });
}

// --- The arguments and the idle check ---

// One handoff pending for the project and one named only by its token: which of them the input delivers, if either, whose token the success text then names, and the text a refused input answers.
const INPUTS = [
  { title: 'a blank input loads the handoff pending for the project', rawInput: ' \t ', delivered: 'sw-pending' },
  { title: 'one word is the token', rawInput: 'sw-named', delivered: 'sw-named' },
  { title: 'a token with whitespace around it is the token', rawInput: '  sw-named\t', delivered: 'sw-named' },
  { title: 'two words answer the usage', rawInput: 'sw-named now', delivered: null, text: 'Usage: /sw-load [token]' },
  { title: 'an agent that is not idle answers the idle text', rawInput: 'sw-named', busy: true, delivered: null, text: '/sw-load runs only while the agent is idle.' },
];

for (const { title, rawInput, busy = false, delivered, text } of INPUTS) {
  test(`${title}`, async () => {
    const { ctx, session, commands } = mountLoad();
    await settled();
    seedPending({ loadToken: 'sw-pending' });
    seedHandoff({ sessionId: 's-elsewhere', loadToken: 'sw-named', createdAt: Date.now(), projectId: '/elsewhere' });
    const agent = commandAgent(session, { busy });

    const result = await load(commands, agent, { rawInput });
    assert.equal(getStore().findLatestDeliveryInSession(SESSION_ID)?.loadToken ?? null, delivered);
    if (text === undefined) {
      assert.deepEqual(result, success(`Loaded handoff ${delivered}: 0 reads over 0 files, 0 skipped.`));
      return;
    }
    assert.deepEqual(result, failure(text));
    assert.deepEqual([session.appended, agent.injected, agent.woken, ctx.sessions.flushed], [[], [], [], []]);
  });
}

// --- A delivery that loads nothing ---

// Each call the host's delivery answers without a loaded handoff: the state it starts from, the input, and the text it answers.
const REFUSED = [
  {
    title: 'a token no handoff carries, while another is pending for the project',
    seed: () => seedPending({ loadToken: 'sw-pending' }),
    rawInput: 'sw-missing',
    text: 'No handoff found for sw-missing; it may have expired',
  },
  {
    title: 'no token and no handoff pending for the project',
    text: 'No handoff found pending for this project',
  },
  {
    title: 'no token and several handoffs pending for the project',
    seed: () => {
      seedPending({ loadToken: 'sw-first', createdAt: Date.now() - 5 * 60_000, nextTask: 'Fix the parser' });
      seedPending({ loadToken: 'sw-second', createdAt: Date.now() - 3 * 3_600_000 });
    },
    text: 'Several handoffs are pending for this project; run /sw-load <token> with one of them:\n'
      + '- sw-first (5 min ago) — Fix the parser\n- sw-second (3h ago)',
  },
  {
    title: 'a token whose stored keep list does not parse',
    seed: () => seedPending({ loadToken: 'sw-corrupt', pathsToKeep: 'not json' }),
    rawInput: 'sw-corrupt',
    text: 'Loading failed: corrupt_handoff',
  },
];

for (const { title, seed = () => {}, rawInput, text } of REFUSED) {
  test(`${title} answers its text, and nothing is appended, injected, flushed or woken`, async () => {
    const { ctx, session, commands } = mountLoad();
    await settled();
    seed();
    const log = [];
    const agent = commandAgent(session, { log });

    assert.deepEqual(await load(commands, agent, { rawInput }), failure(text));
    assert.deepEqual(log, ['maintenance', 'settled']);
    assert.deepEqual([session.appended, agent.injected, agent.woken, ctx.sessions.flushed], [[], [], [], []]);
  });
}

test('a wait for the watcher that the invocation aborts answers its message, and nothing is appended, injected or woken', async () => {
  const snapshot = deferred();
  const { ctx, table, session, commands } = mountLoad({ readSession: () => snapshot.promise });
  await settled();
  assert.equal(table.get(SESSION_ID).state, 'bootstrapping');
  const agent = commandAgent(session);
  const controller = new AbortController();
  controller.abort();

  assert.deepEqual(await load(commands, agent, { signal: controller.signal }),
    failure(`Loading failed: session ${SESSION_ID}: the wait for its watcher was aborted`));
  assert.deepEqual([session.appended, agent.injected, agent.woken, ctx.sessions.flushed], [[], [], [], []]);
  assert.equal(getStore().findLatestDeliveryInSession(SESSION_ID), null);
});

// --- The session title ---

test('a delivered handoff that has a next task renames the loading session after it through the host\'s title service', async () => {
  const titles = fakeSessionTitle();
  const { session, commands } = mountLoad({ sessionTitle: titles });
  await settled();
  seedPending({ loadToken: 'sw-titled', nextTask: 'Fix the parser' });

  const result = await load(commands, commandAgent(session), { rawInput: 'sw-titled' });

  assert.equal(result.kind, 'success', result.text);
  assert.deepEqual(titles.renamed, [{ session, title: 'Fix the parser' }]);
});

// --- The hand-over ---

test('a loaded handoff is handed over once the maintenance settles: the payload message, the read message, then one follow-up, with nothing flushed or appended', async () => {
  const kept = join(dir, 'kept.txt');
  writeFileSync(kept, Array.from({ length: 10 }, (_, index) => `kept line ${index + 1}\n`).join(''));
  const { ctx, session, commands } = mountLoad();
  await settled();
  seedPending({ loadToken: 'sw-kept', pathsToKeep: JSON.stringify([{ path: 'kept.txt', lines: [[2, 4]] }]) });
  const log = [];
  logFlushes(ctx, log);
  const agent = commandAgent(session, { log });
  const signal = new AbortController().signal;

  const result = await load(commands, agent, { rawInput: 'sw-kept', signal });

  assert.deepEqual(result, success('Loaded handoff sw-kept: 1 reads over 1 files, 0 skipped.'));
  assert.deepEqual(log, ['maintenance', 'settled', 'inject', 'inject', 'followup']);
  const readArgs = { file_path: kept, ranges: [{ offset: 2, limit: 3 }] };

  const [payloadMessage, readMessage] = agent.injected;
  assert.equal(agent.injected.length, 2);
  for (const message of agent.injected) {
    assert.equal(message.source.kind, LOAD_MESSAGE_KIND);
    assert.deepEqual(message.source.route, ROUTE);
  }
  assert.deepEqual(payloadMessage.source.calls.map(call => [call.name, call.arguments]), [['load_handoff', JSON.stringify({ load_token: 'sw-kept' })]]);
  assert.deepEqual(readMessage.source.calls.map(call => [call.name, call.arguments]), [['read', JSON.stringify(readArgs)]]);
  assert.equal(JSON.parse(payloadMessage.content[0].text).load_token, 'sw-kept');
  assert.equal(readMessage.content[0].text,
    `${kept} (total lines: 10)\n2: kept line 2\n3: kept line 3\n4: kept line 4\n`);

  assert.equal(agent.woken.length, 1);
  const [followup] = agent.woken;
  assert.deepEqual(followup.source, { kind: 'user' });
  assert.deepEqual(followup.content, [{
    type: 'text', text: loadedText({ token: 'sw-kept', skipped: [], unread: [], toPlace: [], skills: [], empty: false, reads: 1 }),
  }]);
  assert.deepEqual(session.appended, []);
  assert.deepEqual(ctx.sessions.flushed, []);
});

test('a loaded kept file is recorded as the agent\'s observation, once however many windows it was kept over, at the version the fs stated', async () => {
  const kept = join(dir, 'kept.txt');
  writeFileSync(kept, Array.from({ length: 10 }, (_, index) => `kept line ${index + 1}\n`).join(''));
  const { ctx, session, commands } = mountLoad();
  await settled();
  seedPending({ loadToken: 'sw-kept', pathsToKeep: JSON.stringify([{ path: 'kept.txt', lines: [[2, 4], [7, 8]] }, { path: 'absent.txt' }]) });
  const observed = [];
  ctx.on('fs/observed', (...args) => observed.push(args));
  const agent = commandAgent(session);

  await load(commands, agent, { rawInput: 'sw-kept' });

  assert.equal(observed.length, 1);
  for (const [target, observation, actor] of observed) {
    assert.deepEqual(target, { targetKey: kept, displayPath: kept });
    assert.deepEqual(observation, { kind: 'present', version: 'fs-version-1' });
    assert.equal(actor.agent, agent);
  }
});

// The process's shared Working Tree, with its reads recorded for the case and restored when it ends.
function spyOnSharedTree(t) {
  const tree = nodeWorkingTree();
  const { stat, readText } = tree;
  const read = [];
  tree.stat = (key) => { read.push(key); return stat(key); };
  tree.readText = (key) => { read.push(key); return readText(key); };
  t.after(() => Object.assign(tree, { stat, readText }));
  return read;
}

test('the load reads the kept file through the process\'s shared Working Tree, the one the watcher attributes against', async (t) => {
  const kept = join(dir, 'kept.txt');
  const lines = Array.from({ length: 10 }, (_, index) => `export const kept${index + 1} = ${index + 1};`);
  writeFileSync(kept, lines.map(line => `${line}\n`).join(''));
  const read = spyOnSharedTree(t);
  const { events } = dshCallLog([{ name: 'read', args: { file_path: kept }, text: readResultText(kept, lines) }]);
  const { session, commands } = mountLoad({ events });
  await settled();
  const attributed = read.length;
  assert.ok(attributed > 0, 'the watcher\'s matcher reads the file through the shared tree');

  seedPending({ loadToken: 'sw-kept', pathsToKeep: JSON.stringify([{ path: kept, lines: [[2, 4]] }]) });
  await load(commands, commandAgent(session), { rawInput: 'sw-kept' });

  assert.ok(read.length > attributed, 'the load adds its reads to the same tree\'s');
  assert.equal(read.at(-1), kept);
});

test('a hand-over that throws rejects the command with that error and retracts nothing it injected', async () => {
  const { session, commands } = mountLoad();
  await settled();
  seedPending({ loadToken: 'sw-refused' });
  const agent = commandAgent(session);
  const refusal = new Error('wake refused');
  agent.followup = () => { throw refusal; };

  await assert.rejects(load(commands, agent, { rawInput: 'sw-refused' }), error => error === refusal);
  assert.deepEqual(agent.injected.map(message => message.source.kind), [LOAD_MESSAGE_KIND], 'the message injected before the throw stays queued');
});
