// test/helpers/dsh-fake-context.js — the Cordis context `applyHost` is handed, faked for `node:test`.
// It exposes what the host calls: the session store's `list` and `flush`, the persisted listing, the snapshot read, event subscription, effects, optional injection, `get`, and the tool, skill, llm, RPC, settings, session-title, token-meter and commands services.
// A test drives it with `emit`, `dispose` and `unprovide`.

/** A live session as the store lists it, its header carrying `origin` and `parentSession` when given; its `append` throws, so a host that appends fails loudly. */
export function fakeSession({ id, cwd = '/repo', origin, parentSession }) {
  return {
    id,
    header: { cwd, ...(origin === undefined ? {} : { origin }), ...(parentSession === undefined ? {} : { parentSession }) },
    append() { throw new Error(`session ${id} was appended to`); },
  };
}

/** An agent over `session`, as `agent/created` hands it; `injected` holds every message `inject` received, in order. */
export function fakeAgent(session) {
  const injected = [];
  return { session, injected, inject(message) { injected.push(message); } };
}

/**
 * A session-title service whose `rename` records each call in `renamed`, in order, and answers the snapshot it set.
 */
export function fakeSessionTitle() {
  const renamed = [];
  return {
    renamed,
    rename(session, title) {
      renamed.push({ session, title });
      return { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: renamed.length, updatedAt: renamed.length };
    },
  };
}

/**
 * A session that records what is appended to it, over `events`, the log it already holds: events in the v4 log shape (`test/helpers/dsh-events.js`) whose `seq` is their index, as `sessionLog` numbers them.
 * `surface.nodes` folds the events' `surfaceOp`s as the real surface does, an append adding its seq and a replace standing in for the range it names; `eventAt` answers the event at a seq.
 * `append(type, data, { surfaceOp, sourceEventSeqs })` stamps the next seq and logs `{ type, seq, time, data, surfaceOp?, sourceEventSeqs? }` with a copy of `data`, answers that event, and pushes it to `appended`.
 * `failAppend(type, data)` runs first on every append and throws to refuse it, so a refused append leaves no event behind.
 */
export function recordingSession({ id = 'session-recording', cwd = '/repo', events = [], failAppend = () => {} } = {}) {
  const log = [...events];
  const nodes = [];
  const appended = [];
  const fold = (event) => {
    const op = event.surfaceOp;
    if (op === 'append') nodes.push(event.seq);
    else if (op?.op === 'replace') {
      const start = nodes.indexOf(op.startSeq);
      nodes.splice(start, nodes.indexOf(op.endSeq) - start + 1, event.seq);
    }
  };
  log.forEach(fold);
  return {
    id,
    header: { id, cwd },
    surface: { get nodes() { return [...nodes]; } },
    appended,
    eventAt: seq => log[seq],
    append(type, data, { surfaceOp, sourceEventSeqs } = {}) {
      failAppend(type, data);
      const event = {
        type, seq: log.length, time: Date.now(), data: structuredClone(data),
        ...(surfaceOp === undefined ? {} : { surfaceOp }),
        ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
      };
      log.push(event);
      fold(event);
      appended.push(event);
      return event;
    },
  };
}

// The price of a node `fakeTokenMeter` was given none for: the route price and the heuristic price agree.
const DEFAULT_PRICE = { tokens: 10, heuristicTokens: 10 };

/**
 * A token meter whose `measure(session)` answers `{ nodes }`, one `{ seq, tokens, heuristicTokens }` per node of the session's surface in surface order, priced by `prices[seq]` and at `DEFAULT_PRICE` where a seq has none.
 * Like the real method, `measure` works only when called on the meter.
 */
export function fakeTokenMeter({ prices = {} } = {}) {
  const meter = {
    measure(session) {
      if (this !== meter) throw new TypeError('measure called without its service');
      return { nodes: session.surface.nodes.map(seq => ({ seq, ...(prices[seq] ?? DEFAULT_PRICE) })) };
    },
  };
  return meter;
}

/**
 * A commands service that records each definition handed to `register` in `registered`, in order, and answers the disposer the real method does: calling it records the definition's name in `unregistered`.
 * Like the real method, `register` works only when called on the service.
 */
export function fakeCommands() {
  const registered = [];
  const unregistered = [];
  const commands = {
    registered,
    unregistered,
    register(definition) {
      if (this !== commands) throw new TypeError('register called without its service');
      registered.push(definition);
      return () => { unregistered.push(definition.name); };
    },
  };
  return commands;
}

// The `commands` an `inject` child reads: a registration made through it is an effect of that child, as in Cordis, so the child's unloading runs its disposer.
const commandsOwnedBy = (child, commands) => ({
  register(definition) {
    const dispose = commands.register(definition);
    child.disposers.push(dispose);
    return dispose;
  },
});

// An llm service with no adapter and no configurable provider.
function noAdapterLlm() {
  return {
    async resolveModelInfo(provider) {
      throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' });
    },
    listConfigurableProviders: () => [],
  };
}

/**
 * A fake context.
 * `sessions` are the sessions `sessions.list()` answers. `readSession` backs `sessionQuery.readSession` and `listSessions` backs `sessionQuery.listSessions`, which answers `[]` without it and forwards its `signal` argument; like the real methods, each works only when called on its service.
 * `llm` is a top-level service, on the context itself; without one given it is a service whose `resolveModelInfo` rejects with the llm service's `NO_ADAPTER` Error and whose `listConfigurableProviders` answers `[]`.
 * `connection` and `settings` are the optional services, present when given and reachable only on an `inject` child: reading one on the context itself throws, as Cordis does for a service the plugin does not inject.
 * `sessionTitle`, `tokenMeter` and `commands` are such services too. `get(name)` answers any present service on the context itself and undefined for an absent one, as Cordis's does without the inject requirement.
 * `inject(deps, callback)` calls back at once when every named service is present, with a child `{ ...services, effect, root }` whose `root.get(name)` answers any present service and whose `commands` registers as an effect of the child; `unprovide(name)` runs the disposers of every child that injects `name` and drops the service.
 * `sessions.flush(session)` records the session in `sessions.flushed` and resolves `true`, or rejects with `flushError` when given; like the real method it works only when called on `sessions`.
 * `skills.register` records each registration in `skills.registered` and returns a disposer, as the real method does.
 * `emit(name, ...args)` runs each listener `on` recorded for `name` in order, and lets a listener's throw propagate; `dispose()` runs every disposer `effect` collected.
 */
export function createFakeContext({
  sessions = [], readSession, listSessions = () => [], connection, llm = noAdapterLlm(), settings, sessionTitle, tokenMeter,
  commands, flushError,
} = {}) {
  const services = new Map(Object.entries({ connection, settings, sessionTitle, tokenMeter, commands }).filter(([, value]) => value !== undefined));
  const listeners = [];
  const disposers = [];
  const children = [];

  const sessionQuery = {
    readSession(sessionId) {
      if (this !== sessionQuery) return Promise.reject(new TypeError('readSession called without its service'));
      return readSession(sessionId);
    },
    async listSessions(signal) {
      if (this !== sessionQuery) throw new TypeError('listSessions called without its service');
      return listSessions(signal);
    },
  };

  const sessionStore = {
    list: () => [...sessions],
    flushed: [],
    flush(session) {
      if (this !== sessionStore) return Promise.reject(new TypeError('flush called without its service'));
      this.flushed.push(session);
      return flushError === undefined ? Promise.resolve(true) : Promise.reject(flushError);
    },
  };

  const ctx = {
    sessions: sessionStore,
    sessionQuery,
    llm,
    get: name => services.get(name),
    tools: { register() {} },
    skills: {
      registered: [],
      register(skill) { this.registered.push(skill); return () => {}; },
    },
    on(name, handler, options) { listeners.push({ name, handler, options }); },
    emit(name, ...args) {
      for (const listener of listeners.filter(each => each.name === name)) listener.handler(...args);
    },
    effect(execute) { disposers.push(execute()); },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    inject(deps, callback) {
      if (!deps.every(name => services.has(name))) return;
      const child = { deps, disposers: [] };
      children.push(child);
      callback({
        ...Object.fromEntries(deps.map(name => [name, name === 'commands' ? commandsOwnedBy(child, services.get(name)) : services.get(name)])),
        effect(execute) { child.disposers.push(execute()); },
        root: { get: name => services.get(name) },
      });
    },
    unprovide(name) {
      for (const child of children.filter(each => each.deps.includes(name))) {
        for (const dispose of child.disposers.splice(0)) dispose();
      }
      services.delete(name);
    },
  };
  for (const name of ['connection', 'settings', 'sessionTitle', 'tokenMeter', 'commands']) {
    Object.defineProperty(ctx, name, { get() { throw new Error(`cannot get property "${name}" without inject`); } });
  }
  return ctx;
}
