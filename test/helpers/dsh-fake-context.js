// test/helpers/dsh-fake-context.js — the Cordis context `applyHost` is handed, faked for `node:test`.
// It exposes what the host calls: the session store's `list` and `flush`, the persisted listing, the snapshot read, event subscription, effects, optional injection, `get`, and the tool, skill, llm, RPC, settings, session-title, token-meter, commands, working-directory and fs services.
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
export function recordingSession({
  id = 'session-recording', cwd = '/repo', events = [], failAppend = () => {},
} = {}) {
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

/**
 * The reads of the session query service that the event-read tool makes, over `logs`, a map of session id to `{ header, events }` whose events are in the log shape (`seq` their index): `readEvent` answers the window and header the service does, `filterSessions` the records whose header matches an `id` and a `cwd` filter, and `readTitleSnapshots` one fulfilled result per id with the title `titles` gives it.
 * An id in `unreadable` rejects the read of it with its error and an id in `untitled` has no title; a title read of an id that `logs` lacks is a rejected result, as the service isolates a session's failure.
 */
export function fakeSessionLogs(logs, { titles = {}, rejectTitle = {} } = {}) {
  const notFound = id => Object.assign(new Error(`session "${id}" was not found`), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  return {
    async readEvent({ sessionId, seq, before = 0, after = 0 }, signal) {
      signal?.throwIfAborted();
      const log = logs[sessionId];
      if (log === undefined) throw notFound(sessionId);
      const target = log.events[seq];
      if (target === undefined) throw Object.assign(new Error(`session "${sessionId}" has no event at seq ${seq}`), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' });
      const startSeq = Math.max(0, seq - before);
      const endSeq = Math.min(log.events.length - 1, seq + after);
      return {
        session: structuredClone(log.header), inheritedEventCount: 0, target: structuredClone(target),
        events: structuredClone(log.events.slice(startSeq, endSeq + 1)), startSeq, endSeq,
      };
    },
    async filterSessions(filters, signal) {
      signal?.throwIfAborted();
      const wanted = kind => filters.find(filter => filter.kind === kind)?.values;
      return Object.values(logs)
        .filter(({ header }) => (wanted('id') ?? [header.id]).includes(header.id) && (wanted('cwd') ?? [header.cwd]).includes(header.cwd))
        .map(({ header }) => ({ header: structuredClone(header), live: true, persisted: false }));
    },
    async readTitleSnapshots(ids, signal) {
      signal?.throwIfAborted();
      return ids.map((sessionId) => {
        if (rejectTitle[sessionId] !== undefined) return { sessionId, status: 'rejected', reason: rejectTitle[sessionId] };
        if (logs[sessionId] === undefined) return { sessionId, status: 'rejected', reason: notFound(sessionId) };
        return {
          sessionId, status: 'fulfilled',
          value: { session: structuredClone(logs[sessionId].header), ...titles[sessionId] === undefined ? {} : { title: { title: titles[sessionId] } } },
        };
      });
    },
  };
}

// The price of a node `fakeTokenMeter` was given none for: the route price and the heuristic price agree.
const DEFAULT_PRICE = { tokens: 10, heuristicTokens: 10 };

/**
 * A token meter whose `measure(session)` answers `{ nodes, totalTokens }`, one `{ seq, tokens, heuristicTokens }` per node of the session's surface in surface order, priced by `prices[seq]` and at `fallback` (`DEFAULT_PRICE` unless given) where a seq has none, and the request pressure `totalTokens`, the sum of the nodes' route prices unless given: the real total carries a baseline of its own, so a case that needs the two apart states the total.
 * Like the real method, `measure` works only when called on the meter.
 */
export function fakeTokenMeter({ prices = {}, fallback = DEFAULT_PRICE, totalTokens } = {}) {
  const meter = {
    measure(session) {
      if (this !== meter) throw new TypeError('measure called without its service');
      const nodes = session.surface.nodes.map(seq => ({ seq, ...(prices[seq] ?? fallback) }));
      return { nodes, totalTokens: totalTokens ?? nodes.reduce((sum, node) => sum + node.tokens, 0) };
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

/**
 * An `fs` service whose paths are the host's own: `processPathFromHostPath` maps an absolute path to itself and any other to `undefined`, `resolve` makes a target keyed and displayed by the path it is given, `stat` states `version` for it, and `processPath` answers its key.
 * Like the real methods, each works only when called on the service.
 */
export function fakeFs({ version = 'fs-version-1' } = {}) {
  const fs = {
    processPathFromHostPath(hostPath) {
      if (this !== fs) throw new TypeError('processPathFromHostPath called without its service');
      return hostPath.startsWith('/') ? hostPath : undefined;
    },
    async resolve(path) {
      if (this !== fs) throw new TypeError('resolve called without its service');
      return { targetKey: path, displayPath: path };
    },
    async stat() {
      if (this !== fs) throw new TypeError('stat called without its service');
      return { version, type: 'file', size: 0 };
    },
    processPath(target) {
      if (this !== fs) throw new TypeError('processPath called without its service');
      return String(target.targetKey);
    },
  };
  return fs;
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
    listProviders: () => [],
  };
}

/**
 * A fake context.
 * `sessions` are the sessions `sessions.list()` answers and `sessions.get(id)` looks up. `readSession` backs `sessionQuery.readSession` and `listSessions` backs `sessionQuery.listSessions`, which answers `[]` without it and forwards its `signal` argument; like the real methods, each works only when called on its service.
 * `llm` is a top-level service, on the context itself; without one given it is a service whose `resolveModelInfo` rejects with the llm service's `NO_ADAPTER` Error and whose `listConfigurableProviders` answers `[]`.
 * `connection` and `settings` are the optional services, present when given and reachable only on an `inject` child: reading one on the context itself throws, as Cordis does for a service the plugin does not inject.
 * `webServer`, `sessionTitle`, `tokenMeter`, `commands`, `workingDirectory`, `fs`, `agents`, `attachments`, `sessionProjections`, `jobs` and `systemPrompt` are such services too. `get(name)` answers any present service on the context itself and undefined for an absent one, as Cordis's does without the inject requirement.
 * `inject(deps, callback)` calls back at once when every named service is present, with a child `{ ...services, effect, extend, on }` whose `commands` registers as an effect of the child, whose `on(name, handler)` is a listener `emit` runs until the child is disposed and whose `extend(props)` answers a context that inherits the child and whose own `props` shadow its services, as Cordis's `extend` does; what the callback returns, or resolves to, is collected as the child's disposer, and one that resolves after the child was disposed runs at once; `unprovide(name)` runs the disposers of every child that injects `name` and drops the service.
 * `sessionReads` are the further session query reads `fakeSessionLogs` answers.
 * `sessions.flush(session)` records the session in `sessions.flushed` and resolves `true`, or rejects with `flushError` when given; like the real method it works only when called on `sessions`.
 * `skills.register` records each registration in `skills.registered` and returns a disposer, as the real method does.
 * `sibling` is a real context whose `get(name)` answers the services this context holds none of, a service another plugin provides in the context the host shares with it.
 * `emit(name, ...args)` runs each listener `on` recorded for `name` in order, lets a listener's throw propagate and answers a promise of their results, which a test that drives a serial event awaits; `dispose()` runs every disposer `effect` collected.
 */
export function createFakeContext({
  sessions = [], readSession, listSessions = () => [], connection, webServer, llm = noAdapterLlm(), settings, sessionTitle, tokenMeter,
  commands, workingDirectory, fs, agents, attachments, sessionProjections, jobs, systemPrompt, flushError, sibling, pluginManager, loader, sessionReads,
} = {}) {
  const services = new Map(Object.entries({
    connection, webServer, settings, sessionTitle, tokenMeter, commands, workingDirectory, fs, agents, attachments, sessionProjections, jobs, systemPrompt, pluginManager, loader,
  }).filter(([, value]) => value !== undefined));
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
    // The reads of `sessionReads` (`fakeSessionLogs`), each answered only when called on the service, as the real methods are.
    ...Object.fromEntries(Object.entries(sessionReads ?? {}).map(([name, read]) => [name, function bound(...args) {
      if (this !== sessionQuery) return Promise.reject(new TypeError(`${name} called without its service`));
      return read(...args);
    }])),
  };

  const sessionStore = {
    list: () => [...sessions],
    get: id => sessions.find(session => session.id === id),
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
    get: name => (services.has(name) ? services.get(name) : sibling?.get(name)),
    provide(name, value) { services.set(name, value); },
    tools: {
      register() {},
    },
    skills: {
      registered: [],
      register(skill) { this.registered.push(skill); return () => {}; },
    },
    on(name, handler, options) { listeners.push({ name, handler, options }); },
    emit(name, ...args) {
      return Promise.all(listeners.filter(each => each.name === name).map(listener => listener.handler(...args)));
    },
    effect(execute) { disposers.push(execute()); },
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    inject(deps, callback) {
      if (!deps.every(name => services.has(name))) return;
      const child = { deps, disposers: [], disposed: false };
      children.push(child);
      const context = {
        ...Object.fromEntries(deps.map(name => [name, name === 'commands' ? commandsOwnedBy(child, services.get(name)) : services.get(name)])),
        effect(execute) { child.disposers.push(execute()); },
        on(name, handler, options) {
          const listener = { name, handler, options };
          listeners.push(listener);
          child.disposers.push(() => { listeners.splice(listeners.indexOf(listener), 1); });
        },
        extend: props => Object.assign(Object.create(context), props),
      };
      const settle = (dispose) => {
        if (typeof dispose !== 'function') return;
        if (child.disposed) dispose();
        else child.disposers.push(dispose);
      };
      Promise.resolve(callback(context)).then(settle);
    },
    unprovide(name) {
      for (const child of children.filter(each => each.deps.includes(name))) {
        child.disposed = true;
        for (const dispose of child.disposers.splice(0)) dispose();
      }
      services.delete(name);
    },
  };
  for (const name of ['connection', 'webServer', 'settings', 'sessionTitle', 'tokenMeter', 'commands', 'workingDirectory', 'fs', 'agents', 'attachments', 'sessionProjections', 'jobs', 'systemPrompt']) {
    Object.defineProperty(ctx, name, { get() { throw new Error(`cannot get property "${name}" without inject`); } });
  }
  return ctx;
}
