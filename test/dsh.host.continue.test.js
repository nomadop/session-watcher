// `/sw-continue` over the host: its registration on the `commands` and `tokenMeter` services, the eligibility and idle checks, the load after the clear, the one flush and the hand-over, and the epoch the watcher reads once the session is cleared and the segment the load is delivered at. The fake context's recording session and token meter stand in for DSH's; the clear against the real packages is `test/dsh.continue.integration.test.js`.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import { LOAD_MESSAGE_KIND } from '../lib/harness/dsh/load-message.js';
import { loadedText } from '../dsh/src/load.js';
import { sessionLog, systemMessage, compactCheckpoint } from './helpers/dsh-events.js';
import {
  SESSION_ID, TOKEN, closedTurn, kit, commandAgent, deferred, invoke as invokeNamed, logFlushes, mountClear as mountOn,
  seedHandoff, segmentOf, settled, twoTurns,
} from './helpers/dsh-command-host.js';

const USAGE_TEXT = 'Usage: /sw-continue (no arguments)';
const NO_HANDOFF_TEXT = 'No handoff has been prepared in this session. Run the sw-handoff skill first.';
const STALE_TEXT = 'The last handoff was prepared before the session\'s latest context reset. Run the sw-handoff skill again.';
const NOT_IDLE_TEXT = '/sw-continue runs only while the agent is idle.';
const NOT_STARTED_TEXT = 'Clearing could not start; the session history is unchanged.';
const NOT_FINISHED_TEXT = 'Clearing did not finish cleanly; some history may be shadowed. Inspect the session before retrying.';
const NOT_SAVED_TEXT = 'Clearing finished, but the session could not be saved.';
const NOTHING_TEXT = 'No history to clear.';

let dir;
let mounted;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sw-dsh-continue-')));
  mounted = [];
  _resetRateLampManagerForTest();
});

afterEach(() => {
  for (const ctx of mounted) ctx.dispose();
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const mountClear = (options = {}) => mountOn({ dir, mounted, ...options });
const invoke = (commands, agent, options) => invokeNamed(commands, 'sw-continue', agent, options);
const continueOf = commands => commands.registered.filter(definition => definition.name === 'sw-continue');

// The same two turns with a checkpoint between them that replaces the first one's nodes: a snapshot that closes one segment.
function closingTurns() {
  const first = closedTurn(1);
  return sessionLog([
    ...first.events, compactCheckpoint({ startSeq: first.prompt.seq, endSeq: first.answer.seq }), ...closedTurn(2).events,
  ]);
}

const failure = text => ({ kind: 'error', text });
const success = text => ({ kind: 'success', text });

test('with both services the command is registered once under its name and description and carries no input', () => {
  const { commands } = mountClear();
  assert.equal(continueOf(commands).length, 1);
  const [definition] = continueOf(commands);
  assert.equal(definition.description, 'Clear the session and resume from its last handoff');
  assert.equal('input' in definition, false);
  assert.equal(typeof definition.handler, 'function');
  assert.deepEqual(commands.unregistered, []);
});

for (const absent of ['commands', 'tokenMeter']) {
  test(`without ${absent} no command is registered and the host still mounts`, async () => {
    const { commands, table } = mountClear({ absent });
    await settled();
    assert.deepEqual(continueOf(commands), []);
    assert.equal(table.get(SESSION_ID).state, 'live');
  });
}

for (const leaving of ['commands', 'tokenMeter']) {
  test(`unproviding ${leaving} runs the command's disposer`, () => {
    const { commands, ctx } = mountClear();
    ctx.unprovide(leaving);
    assert.deepEqual(commands.unregistered.filter(name => name === 'sw-continue'), ['sw-continue']);
  });
}

// Each call that cannot proceed: the state it starts from and the text it answers.
const REFUSED = [
  {
    title: 'an empty rawInput with no handoff answers that none was prepared',
    text: NO_HANDOFF_TEXT,
  },
  {
    title: 'a whitespace-only rawInput is no argument',
    rawInput: ' \t\n ',
    text: NO_HANDOFF_TEXT,
  },
  {
    title: 'a non-blank rawInput answers the usage, whatever handoff the session holds',
    rawInput: ' now',
    seed: ({ table }) => seedHandoff({ segment: segmentOf(table) }),
    text: USAGE_TEXT,
  },
  {
    title: 'a handoff of another session only is no handoff of this one',
    seed: ({ table }) => seedHandoff({ sessionId: 's-other', segment: segmentOf(table) }),
    text: NO_HANDOFF_TEXT,
  },
  {
    title: 'the newest of two handoffs of the session is the one compared',
    seed: ({ table }) => {
      seedHandoff({ segment: segmentOf(table), loadToken: 'older', createdAt: 1000 });
      seedHandoff({ segment: segmentOf(table) + 1, loadToken: 'newer', createdAt: 2000 });
    },
    text: STALE_TEXT,
  },
  {
    title: 'a handoff prepared before the session\'s latest context reset is stale',
    seed: ({ ctx, table, session, events }) => {
      const before = segmentOf(table);
      seedHandoff({ segment: before });
      const grown = sessionLog([...events, compactCheckpoint({ startSeq: session.surface.nodes[0], endSeq: session.surface.nodes.at(-1) })]);
      ctx.emit('session/event', session, grown.at(-1));
      assert.equal(segmentOf(table), before + 1, 'the checkpoint closed a segment');
    },
    text: STALE_TEXT,
  },
  {
    title: 'an agent that is not idle answers the idle text',
    seed: ({ table }) => seedHandoff({ segment: segmentOf(table) }),
    busy: true,
    text: NOT_IDLE_TEXT,
  },
];

for (const { title, rawInput, seed = () => {}, busy = false, text } of REFUSED) {
  test(`${title}, and nothing is appended, flushed or woken`, async () => {
    const events = twoTurns();
    const { ctx, table, session, commands } = mountClear({ events });
    await settled();
    seed({ ctx, table, session, events });
    const agent = commandAgent(session, { busy });

    assert.deepEqual(await invoke(commands, agent, { rawInput }), failure(text));
    assert.deepEqual(session.appended, []);
    assert.deepEqual(ctx.sessions.flushed, []);
    assert.deepEqual(agent.woken, []);
  });
}

test('a clear of a surface with nothing after its head answers that there is no history and wakes nothing', async () => {
  const events = sessionLog([systemMessage()]);
  const { ctx, table, session, commands } = mountClear({ events });
  await settled();
  seedHandoff({ segment: segmentOf(table) });
  const agent = commandAgent(session);

  assert.deepEqual(await invoke(commands, agent), success(NOTHING_TEXT));
  assert.deepEqual(session.appended, []);
  assert.deepEqual(ctx.sessions.flushed, []);
  assert.deepEqual(agent.woken, []);
});

test('a clear loads the session\'s newest handoff, flushes once, and after the maintenance settles hands it over', async () => {
  const kept = join(dir, 'kept.txt');
  writeFileSync(kept, Array.from({ length: 10 }, (_, index) => `kept line ${index + 1}\n`).join(''));
  const { ctx, table, session, commands } = mountClear();
  await settled();
  seedHandoff({ segment: segmentOf(table), pathsToKeep: JSON.stringify([{ path: 'kept.txt', lines: [[2, 4]] }]) });
  const log = [];
  logFlushes(ctx, log);
  const agent = commandAgent(session, { log });
  const shadowed = session.surface.nodes.length;

  const result = await invoke(commands, agent);

  assert.deepEqual(result, success(`Cleared ${shadowed} history items (~${shadowed * 10} tokens); loaded handoff ${TOKEN}.`));
  assert.deepEqual(session.appended.map(event => event.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  assert.deepEqual(log, ['maintenance', 'flush', 'settled', 'inject', 'followup']);
  assert.deepEqual(ctx.sessions.flushed, [session]);
  const [message] = agent.injected;
  assert.equal(message.source.kind, LOAD_MESSAGE_KIND);
  assert.deepEqual(message.source.calls.map(call => [call.name, call.arguments]), [
    ['load_handoff', JSON.stringify({ load_token: TOKEN })], ['read', JSON.stringify({ file_path: kept, offset: 2, limit: 3 })],
  ]);
  assert.deepEqual(ctx.tools.executed.flatMap(input => input.calls.map(call => call.arguments)), [JSON.stringify({ file_path: kept, offset: 2, limit: 3 })]);
  assert.equal(agent.woken.length, 1);
  assert.deepEqual(agent.woken[0].content, [{
    type: 'text', text: loadedText({ token: TOKEN, skipped: [], unread: [], toPlace: [], skills: [], empty: false }, { resume: true }),
  }]);
  assert.deepEqual(agent.woken[0].source, { kind: 'user' });
});

// The kit with a `createUserMessage` that builds the checkpoint and refuses the load message.
const refusingLoadMessage = {
  ...kit,
  createUserMessage(input) {
    if (input.source.kind === LOAD_MESSAGE_KIND) throw new Error('not lossless');
    return kit.createUserMessage(input);
  },
};

// The load the clear leads to fails: the clear stands, its one flush happens, nothing is handed over, and the error names the token to load by hand.
for (const [title, mount, reason] of [
  ['at the delivery', { pathsToKeep: 'not json' }, 'Loading failed: corrupt_handoff'],
  ['while the message is built', { commandKit: refusingLoadMessage }, 'Loading did not finish: not lossless'],
]) {
  test(`a load that fails ${title} after the clear leaves the clear flushed once and wakes nothing`, async () => {
    const { pathsToKeep, ...options } = mount;
    const { ctx, table, session, commands } = mountClear(options);
    await settled();
    seedHandoff({ segment: segmentOf(table), ...(pathsToKeep === undefined ? {} : { pathsToKeep }) });
    const log = [];
    logFlushes(ctx, log);
    const agent = commandAgent(session, { log });

    assert.deepEqual(await invoke(commands, agent),
      failure(`Context cleared, but the handoff was not loaded: ${reason}. Run /sw-load ${TOKEN}.`));
    assert.deepEqual(session.appended.map(event => event.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
    assert.deepEqual(log, ['maintenance', 'flush', 'settled']);
    assert.deepEqual([agent.injected, agent.woken], [[], []]);
  });
}

test('a flush that rejects answers that the session could not be saved and wakes nothing', async () => {
  const { ctx, table, session, commands } = mountClear({ flushError: new Error('disk full') });
  await settled();
  seedHandoff({ segment: segmentOf(table) });
  const agent = commandAgent(session);

  assert.deepEqual(await invoke(commands, agent), failure(NOT_SAVED_TEXT));
  assert.equal(session.appended.length, 4, 'the clear itself was written');
  assert.deepEqual(ctx.sessions.flushed, [session]);
  assert.equal(getStore().findLatestDeliveryInSession(SESSION_ID)?.loadToken, TOKEN, 'the load delivered the handoff before the flush that rejected');
  assert.deepEqual([agent.injected, agent.woken], [[], []]);
});

for (const [title, refused, appended, text] of [
  ['before the start', 'compaction/start', [], NOT_STARTED_TEXT],
  ['after the start', 'user/message', ['compaction/start', 'compaction/summary', 'compaction/end'], NOT_FINISHED_TEXT],
]) {
  test(`a transaction that fails ${title} answers its text and wakes nothing`, async () => {
    const { ctx, table, session, commands } = mountClear({ failAppend: (type) => { if (type === refused) throw new Error(`${type} refused`); } });
    await settled();
    seedHandoff({ segment: segmentOf(table) });
    const agent = commandAgent(session);

    assert.deepEqual(await invoke(commands, agent), failure(text));
    assert.deepEqual(session.appended.map(event => event.type), appended);
    assert.deepEqual(ctx.sessions.flushed, []);
    assert.deepEqual(agent.woken, []);
  });
}

// A rejection the command does not name reaches the runtime unchanged, which records it as the invocation's error.
for (const [title, make] of [
  ['the maintenance task rejecting', (agent) => {
    agent.runMaintenance = () => Promise.reject(new Error('maintenance rejected'));
    return 'maintenance rejected';
  }],
  ['the wake throwing', (agent) => {
    agent.followup = () => { throw new Error('wake refused'); };
    return 'wake refused';
  }],
]) {
  test(`${title} rejects the command with that error`, async () => {
    const { table, session, commands } = mountClear();
    await settled();
    seedHandoff({ segment: segmentOf(table) });
    const agent = commandAgent(session);
    const message = make(agent);

    await assert.rejects(invoke(commands, agent), { message });
  });
}

test('a session whose watcher failed rejects the command with the watcher\'s diagnostic and writes nothing', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { ctx, table, session, commands } = mountClear({ readSession: () => Promise.reject(new Error('read refused')) });
  await settled();
  assert.equal(table.get(SESSION_ID).state, 'failed');
  seedHandoff({ segment: 0 });
  const agent = commandAgent(session);

  await assert.rejects(invoke(commands, agent), { message: 'read refused' });
  assert.deepEqual(session.appended, []);
  assert.deepEqual(ctx.sessions.flushed, []);
});

test('a command called while the session\'s snapshot is read waits for it, then clears', async () => {
  const events = closingTurns();
  const snapshot = deferred();
  const { ctx, table, session, commands } = mountClear({ events, readSession: () => snapshot.promise });
  await settled();
  assert.equal(table.get(SESSION_ID).state, 'bootstrapping');
  seedHandoff({ segment: 1 });
  const agent = commandAgent(session);
  const shadowed = session.surface.nodes.length;
  let result;

  const running = invoke(commands, agent).then((value) => { result = value; });
  await settled();
  assert.equal(result, undefined, 'the command is still waiting for the watcher');
  assert.deepEqual(session.appended, []);

  snapshot.resolve({ session: {}, inheritedEventCount: 0, events });
  await running;
  assert.equal(segmentOf(table), 1, 'the snapshot closed a segment');
  assert.deepEqual(result, success(`Cleared ${shadowed} history items (~${shadowed * 10} tokens); loaded handoff ${TOKEN}.`));
  assert.equal(session.appended.length, 4);
  assert.equal(agent.woken.length, 1);
  assert.equal(ctx.sessions.flushed.length, 1);
});

test('an abort while the session\'s snapshot is read ends the command with the watcher table\'s aborted error, and the snapshot arriving later clears nothing', async () => {
  const events = closingTurns();
  const snapshot = deferred();
  const { ctx, table, session, commands } = mountClear({ events, readSession: () => snapshot.promise });
  await settled();
  assert.equal(table.get(SESSION_ID).state, 'bootstrapping');
  seedHandoff({ segment: 1 });
  const agent = commandAgent(session);
  const controller = new AbortController();
  const outcomes = [];

  invoke(commands, agent, { signal: controller.signal }).then(value => outcomes.push({ value }), error => outcomes.push({ error }));
  await settled();
  assert.deepEqual(outcomes, [], 'the command is waiting for the watcher');
  controller.abort();
  await settled();

  assert.equal(outcomes.length, 1, 'the abort ended the command while the watcher was still bootstrapping');
  assert.equal(outcomes[0].error?.message, `session ${SESSION_ID}: the wait for its watcher was aborted`);
  snapshot.resolve({ session: {}, inheritedEventCount: 0, events });
  await settled();
  assert.equal(table.get(SESSION_ID).state, 'live');
  assert.deepEqual(session.appended, []);
  assert.deepEqual(ctx.sessions.flushed, []);
  assert.deepEqual(agent.woken, []);
});

test('the watcher reads the clear as a new epoch from the session\'s own events, and the command delivers the handoff at that segment', async (t) => {
  const { table, session, commands } = mountClear({ forward: true });
  await settled();
  const stderr = t.mock.method(console, 'error', () => {});
  const { watcher } = table.get(SESSION_ID);
  const prepared = watcher.prepareHandoff({ pathsToKeep: [], summary: 'summary' });
  assert.equal(prepared.status, 'ready');
  const before = segmentOf(table);
  const agent = commandAgent(session);

  const result = await invoke(commands, agent);

  assert.equal(result.kind, 'success', result.text);
  const after = segmentOf(table);
  assert.equal(after, before + 1);
  const delivered = getStore().findLatestDeliveryInSession(SESSION_ID);
  assert.equal(delivered.loadToken, prepared.load_token);
  assert.equal(delivered.deliveredSegment, after);
  assert.equal(stderr.mock.callCount(), 0, 'the watcher took every event of the clear without a diagnostic');
});
