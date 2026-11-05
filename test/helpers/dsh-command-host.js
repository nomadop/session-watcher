// test/helpers/dsh-command-host.js — the host's commands mounted over the fake context, for the command tests: one recording session, the agent a command invocation holds, the handoff rows they read and the call the command runtime makes.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../../dsh/src/host.js';
import { getStore } from '../../lib/store.js';
import { sessionLog, turnStart, turnEnd, stepStart, stepEnd, userMessage, assistantMessage } from './dsh-events.js';
import { createFakeContext, fakeCommands, fakeTokenMeter, recordingSession } from './dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../../skills/', import.meta.url));

export const SESSION_ID = 's-clear';
export const COMMAND_ID = 'command-host';
export const TOKEN = 'sw-handoff-token';
/** The recording session's header directory, and so its project. */
export const PROJECT = '/repo';
/** The model selection the command agent holds, and so the route of the load message. */
export const ROUTE = { provider: 'deepseek', model: 'deepseek-v4-pro' };

// The DSH values the commands are handed, in the shapes DSH gives them: a brand that is the identity, the frozen checkpoint source and a user message carrying an id.
let messages = 0;
export const kit = {
  CompactionId: id => id,
  compactCheckpointSource: (compactionId, sourceCommandId) => Object.freeze({ kind: 'compact-checkpoint', compactionId, sourceCommandId }),
  createUserMessage: ({ content, source }) => ({ id: `message-${++messages}`, role: 'user', content, source }),
};

export const settled = () => new Promise(resolve => setImmediate(resolve));

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const PRICED_CALL = { inputTokens: 3, outputTokens: 40, totalTokens: 9643, cacheWriteTokens: 9600 };

/** One closed turn of a prompt and its answer, with the events still carrying the builders' own seqs, which `sessionLog` renumbers. */
export function closedTurn(turn) {
  const prompt = userMessage({ text: `Request ${turn}.` });
  const answer = assistantMessage({ turn, step: 1, text: `Answer ${turn}.`, usage: PRICED_CALL });
  return { prompt, answer, events: [turnStart({ turn }), prompt, stepStart({ turn }), answer, stepEnd({ turn }), turnEnd({ turn })] };
}

/** Two closed turns and no system head: the surface holds both prompts and both answers. */
export const twoTurns = () => sessionLog([...closedTurn(1).events, ...closedTurn(2).events]);

/**
 * The host over a fake context holding one recording session over `events`, which is also the snapshot the host reads for it unless `readSession` is given; `absent` names a service to leave out; `workingDirectory.get` answers `dir`; `executeTool` answers `tools.execute`; `sessionTitle`, when given, is the context's title service. With `forward`, each append to the session is emitted as its `session/event`, so the watcher folds it.
 * The store lives under the caller's `dir`, and the context joins the caller's `mounted` list, which the caller disposes.
 */
export function mountClear({
  dir, mounted, events = twoTurns(), readSession, failAppend, flushError, absent, forward = false, commandKit = kit, executeTool, sessionTitle,
}) {
  const session = recordingSession({ id: SESSION_ID, cwd: PROJECT, events, failAppend });
  const commands = fakeCommands();
  const ctx = createFakeContext({
    sessions: [session],
    readSession: readSession ?? (async () => ({ session: {}, inheritedEventCount: 0, events })),
    commands: absent === 'commands' ? undefined : commands,
    tokenMeter: absent === 'tokenMeter' ? undefined : fakeTokenMeter(),
    workingDirectory: absent === 'workingDirectory' ? undefined : { get: () => dir },
    flushError,
    sessionTitle,
    ...(executeTool === undefined ? {} : { executeTool }),
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
    loadIsIgnored: () => null, skillsDir: SKILLS_DIR, commandKit,
  });
  return { ctx, table, session, commands };
}

/**
 * The agent a command invocation holds: its session; `model.current()` answering `selection`; a `runMaintenance` that starts the task at once as the real one does and throws of its own when `busy`; an `inject` and a `followup` that record what they take, in `injected` and `woken`.
 * `log` takes the order of maintenance, settlement, injections and the wake.
 */
export function commandAgent(session, { log = [], busy = false, selection = ROUTE } = {}) {
  const injected = [];
  const woken = [];
  return {
    session,
    model: { current: () => selection },
    injected,
    woken,
    runMaintenance(task) {
      if (busy) throw new Error('the agent is not idle');
      log.push('maintenance');
      return task(new AbortController().signal).finally(() => log.push('settled'));
    },
    inject(message) {
      log.push('inject');
      injected.push(message);
    },
    followup(message) {
      log.push('followup');
      woken.push(message);
    },
  };
}

/** Every flush the context's session store receives is recorded in `log` ahead of the flush itself. */
export function logFlushes(ctx, log) {
  const sessions = ctx.sessions;
  const flush = sessions.flush;
  sessions.flush = function flushLogged(session) {
    log.push('flush');
    return flush.call(this, session);
  };
}

/** The handler of the command registered under `name`, called as the command runtime calls it. */
export function invoke(commands, name, agent, { rawInput = '', signal = new AbortController().signal } = {}) {
  const definition = commands.registered.find(each => each.name === name);
  return definition.handler({ commandId: COMMAND_ID, agent, rawInput, attachments: [], signal });
}

export const segmentOf = (table, sessionId = SESSION_ID) => table.get(sessionId).watcher.getStatus().segment;

/** A handoff row in the real store; `pathsToKeep` is the stored JSON text. */
export function seedHandoff({
  sessionId = SESSION_ID, segment = 0, loadToken = TOKEN, createdAt = 1000, pathsToKeep = '[]', projectId, nextTask,
}) {
  getStore().insertHandoff({
    sessionId, segment, loadToken, createdAt, pathsToKeep, summary: 'summary', summaryTokens: 10, projectId, nextTask,
  });
}
