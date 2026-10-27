// `/sw-continue` over the host: its registration on the `commands` and `tokenMeter` services, the eligibility and idle checks, the flush and the wake, and the epoch the watcher reads once the session is cleared. The fake context's recording session and token meter stand in for DSH's; the clear against the real packages is `test/dsh.continue.integration.test.js`.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { getStore, closeStoreGlobal } from '../lib/store.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import {
  sessionLog, systemMessage, turnStart, turnEnd, stepStart, stepEnd, userMessage, assistantMessage, compactCheckpoint,
} from './helpers/dsh-events.js';
import { createFakeContext, fakeCommands, fakeTokenMeter, recordingSession } from './helpers/dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));

const SESSION_ID = 's-clear';
const COMMAND_ID = 'command-host';
const TOKEN = 'sw-handoff-token';

const USAGE_TEXT = 'Usage: /sw-continue (no arguments)';
const NO_HANDOFF_TEXT = 'No handoff has been prepared in this session. Run the sw-handoff skill first.';
const STALE_TEXT = 'The last handoff was prepared before the session\'s latest context reset. Run the sw-handoff skill again.';
const NOT_IDLE_TEXT = '/sw-continue runs only while the agent is idle.';
const NOT_STARTED_TEXT = 'Clearing could not start; the session history is unchanged.';
const NOT_FINISHED_TEXT = 'Clearing did not finish cleanly; some history may be shadowed. Inspect the session before retrying.';
const NOT_SAVED_TEXT = 'Clearing finished, but the session could not be saved.';
const NOTHING_TEXT = 'No history to clear.';

// The DSH values the command is handed, in the shapes DSH gives them: a brand that is the identity, the frozen checkpoint source and a user message carrying an id.
let messages = 0;
const kit = {
  CompactionId: id => id,
  compactCheckpointSource: (compactionId, sourceCommandId) => Object.freeze({ kind: 'compact-checkpoint', compactionId, sourceCommandId }),
  createUserMessage: ({ content, source }) => ({ id: `message-${++messages}`, role: 'user', content, source }),
};

let dir;
let mounted;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-continue-'));
  mounted = [];
  _resetRateLampManagerForTest();
});

afterEach(() => {
  for (const ctx of mounted) ctx.dispose();
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

const settled = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const PRICED_CALL = { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 };

// One closed turn of a prompt and its answer, with the events still carrying the builders' own seqs, which `sessionLog` renumbers.
function closedTurn(turn) {
  const prompt = userMessage({ text: `Request ${turn}.` });
  const answer = assistantMessage({ turn, step: 1, text: `Answer ${turn}.`, usage: PRICED_CALL });
  return { prompt, answer, events: [turnStart({ turn }), prompt, stepStart({ turn }), answer, stepEnd({ turn }), turnEnd({ turn })] };
}

// Two closed turns and no system head: the surface holds both prompts and both answers.
const twoTurns = () => sessionLog([...closedTurn(1).events, ...closedTurn(2).events]);

// The same two turns with a checkpoint between them that replaces the first one's nodes: a snapshot that closes one segment.
function closingTurns() {
  const first = closedTurn(1);
  return sessionLog([
    ...first.events, compactCheckpoint({ startSeq: first.prompt.seq, endSeq: first.answer.seq }), ...closedTurn(2).events,
  ]);
}

// The host over a fake context holding one recording session over `events`, which is also the snapshot the host reads for it unless `readSession` is given; `absent` names a service to leave out. The context is disposed when the case ends.
function mountClear({
  events = twoTurns(), readSession, failAppend, flushError, absent, forward = false,
} = {}) {
  const session = recordingSession({ id: SESSION_ID, events, failAppend });
  const commands = fakeCommands();
  const ctx = createFakeContext({
    sessions: [session],
    readSession: readSession ?? (async () => ({ session: {}, inheritedEventCount: 0, events })),
    commands: absent === 'commands' ? undefined : commands,
    tokenMeter: absent === 'tokenMeter' ? undefined : fakeTokenMeter(),
    flushError,
  });
  mounted.push(ctx);
  if (forward) {
    const append = session.append;
    session.append = (...args) => {
      const event = append(...args);
      ctx.emit('session/event', session, event);
      return event;
    };
  }
  const { table } = applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'),
    loadIsIgnored: () => null, skillsDir: SKILLS_DIR, continueKit: kit,
  });
  return { ctx, table, session, commands };
}

// The agent a command invocation holds: its session; a `runMaintenance` that starts the task at once as the real one does and throws of its own when `busy`; and a `followup` that records the wake. `log` takes the order of maintenance, settlement and wake.
function commandAgent(session, { log = [], busy = false } = {}) {
  const woken = [];
  return {
    session,
    woken,
    runMaintenance(task) {
      if (busy) throw new Error('the agent is not idle');
      log.push('maintenance');
      return task(new AbortController().signal).finally(() => log.push('settled'));
    },
    followup(message) {
      log.push('followup');
      woken.push(message);
    },
  };
}

// Every flush the context's session store receives is recorded in `log` ahead of the flush itself.
function logFlushes(ctx, log) {
  const sessions = ctx.sessions;
  const flush = sessions.flush;
  sessions.flush = function flushLogged(session) {
    log.push('flush');
    return flush.call(this, session);
  };
}

// The registered command's handler, called as the command runtime calls it.
function invoke(commands, agent, { rawInput = '', signal = new AbortController().signal } = {}) {
  const [definition] = commands.registered;
  return definition.handler({ commandId: COMMAND_ID, agent, rawInput, attachments: [], signal });
}

const segmentOf = (table, sessionId = SESSION_ID) => table.get(sessionId).watcher.getStatus().segment;

function seedHandoff({ sessionId = SESSION_ID, segment, loadToken = TOKEN, createdAt = 1000 }) {
  getStore().insertHandoff({
    sessionId, segment, loadToken, createdAt, pathsToKeep: '[]', summary: 'summary', summaryTokens: 10,
  });
}

const failure = text => ({ kind: 'error', text });
const success = text => ({ kind: 'success', text });

test('with both services the command is registered once under its name and description and carries no input', () => {
  const { commands } = mountClear();
  assert.equal(commands.registered.length, 1);
  const [definition] = commands.registered;
  assert.equal(definition.name, 'sw-continue');
  assert.equal(definition.description, 'Clear the session and resume from its last handoff');
  assert.equal('input' in definition, false);
  assert.equal(typeof definition.handler, 'function');
  assert.deepEqual(commands.unregistered, []);
});

for (const absent of ['commands', 'tokenMeter']) {
  test(`without ${absent} no command is registered and the host still mounts`, async () => {
    const { commands, table } = mountClear({ absent });
    await settled();
    assert.deepEqual(commands.registered, []);
    assert.equal(table.get(SESSION_ID).state, 'live');
  });
}

for (const leaving of ['commands', 'tokenMeter']) {
  test(`unproviding ${leaving} runs the command's disposer`, () => {
    const { commands, ctx } = mountClear();
    ctx.unprovide(leaving);
    assert.deepEqual(commands.unregistered, ['sw-continue']);
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

test('a clear flushes the session, then the maintenance settles, then one follow-up wakes the model with the handoff token', async () => {
  const { ctx, table, session, commands } = mountClear();
  await settled();
  seedHandoff({ segment: segmentOf(table) });
  const log = [];
  logFlushes(ctx, log);
  const agent = commandAgent(session, { log });
  const shadowed = session.surface.nodes.length;

  const result = await invoke(commands, agent);

  assert.deepEqual(result, success(`Cleared ${shadowed} history items (~${shadowed * 10} tokens); loading handoff ${TOKEN}.`));
  assert.deepEqual(session.appended.map(event => event.type), ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end']);
  assert.deepEqual(log, ['maintenance', 'flush', 'settled', 'followup']);
  assert.deepEqual(ctx.sessions.flushed, [session]);
  assert.equal(agent.woken.length, 1);
  assert.deepEqual(agent.woken[0].content, [{ type: 'text', text: `Continue from handoff ${TOKEN}: load it with the sw-load skill.` }]);
  assert.deepEqual(agent.woken[0].source, { kind: 'user' });
});

test('a flush that rejects answers that the session could not be saved and wakes nothing', async () => {
  const { ctx, table, session, commands } = mountClear({ flushError: new Error('disk full') });
  await settled();
  seedHandoff({ segment: segmentOf(table) });
  const agent = commandAgent(session);

  assert.deepEqual(await invoke(commands, agent), failure(NOT_SAVED_TEXT));
  assert.equal(session.appended.length, 4, 'the clear itself was written');
  assert.deepEqual(ctx.sessions.flushed, [session]);
  assert.deepEqual(agent.woken, []);
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
  assert.deepEqual(result, success(`Cleared ${shadowed} history items (~${shadowed * 10} tokens); loading handoff ${TOKEN}.`));
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

test('the watcher reads the clear as a new epoch from the session\'s own events, and a handoff loaded next is delivered at that segment', async (t) => {
  const { table, session, commands } = mountClear({ forward: true });
  await settled();
  const stderr = t.mock.method(console, 'error', () => {});
  const { watcher } = table.get(SESSION_ID);
  const prepared = watcher.prepareHandoff({ pathsToKeep: [], summary: 'summary' });
  assert.equal(prepared.status, 'ready');
  const before = segmentOf(table);
  const agent = commandAgent(session);

  const result = await invoke(commands, agent);

  assert.equal(result.kind, 'success');
  const after = segmentOf(table);
  assert.equal(after, before + 1);
  assert.equal((await watcher.deliverHandoff({ loadToken: prepared.load_token })).found, true);
  const { consumer_segment: consumerSegment } = getStore()._db
    .prepare('SELECT consumer_segment FROM handoff_load WHERE session_id = ?').get(SESSION_ID);
  assert.equal(consumerSegment, after);
  assert.equal(stderr.mock.callCount(), 0, 'the watcher took every event of the clear without a diagnostic');
});
