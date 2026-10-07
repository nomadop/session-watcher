// test/helpers/dsh-fake-context.js — the Cordis context `applyHost` is handed, faked for `node:test`.
// It exposes what the host calls: the session store's `list`, the persisted listing, the snapshot read, event subscription, effects, optional injection, and the tool, skill, llm, RPC and settings services.
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
 * `sessions` are the sessions `sessions.list()` answers. `readSession` backs `sessionQuery.readSession` and `listSessions` backs `sessionQuery.listSessions`, which answers `[]` without it; like the real methods, each works only when called on its service.
 * `llm` is a top-level service, on the context itself; without one given it is a service whose `resolveModelInfo` rejects with the llm service's `NO_ADAPTER` Error and whose `listConfigurableProviders` answers `[]`.
 * `connection` and `settings` are the optional services, present when given and reachable only on an `inject` child: reading one on the context itself throws, as Cordis does for a service the plugin does not inject.
 * `inject(deps, callback)` calls back at once when every named service is present, with a child `{ ...services, effect, root }` whose `root.get(name)` answers any present service; `unprovide(name)` runs the disposers of every child that injects `name` and drops the service.
 * `skills.register` records each registration in `skills.registered` and returns a disposer, as the real method does.
 * `emit(name, ...args)` runs each listener `on` recorded for `name` in order, and lets a listener's throw propagate; `dispose()` runs every disposer `effect` collected.
 */
export function createFakeContext({
  sessions = [], readSession, listSessions = () => [], connection, llm = noAdapterLlm(), settings,
} = {}) {
  const services = new Map(Object.entries({ connection, settings }).filter(([, value]) => value !== undefined));
  const listeners = [];
  const disposers = [];
  const children = [];

  const sessionQuery = {
    readSession(sessionId) {
      if (this !== sessionQuery) return Promise.reject(new TypeError('readSession called without its service'));
      return readSession(sessionId);
    },
    async listSessions() {
      if (this !== sessionQuery) throw new TypeError('listSessions called without its service');
      return listSessions();
    },
  };

  const ctx = {
    sessions: { list: () => [...sessions] },
    sessionQuery,
    llm,
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
        ...Object.fromEntries(deps.map(name => [name, services.get(name)])),
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
  for (const name of ['connection', 'settings']) {
    Object.defineProperty(ctx, name, { get() { throw new Error(`cannot get property "${name}" without inject`); } });
  }
  return ctx;
}
