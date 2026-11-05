// test/helpers/dsh-client-context.js — the Cordis client context `applyClient` is handed, faked for `node:test`, with the `document` and `EventSource` it reaches for.
// Shared by the tests of `applyClient` and of the registrations it makes.

export const TAB_CSS = '@scope ([data-sw-tab]) { :scope { color: red; } }';

/** Recording stand-ins for the two primitives hooks and the portal `index.js` hands in. */
export function hookFakes() {
  const calls = { anchored: [], dismiss: [], portal: [] };
  return {
    calls,
    useAnchoredPosition: (options) => { calls.anchored.push(options); return null; },
    useDismissOnOutsidePointer: (...args) => { calls.dismiss.push(args); },
    createPortal: (node, target) => { calls.portal.push(target); return node; },
  };
}

export const OPTIONS = (() => {
  const { calls, ...hooks } = hookFakes();
  return { tabCss: TAB_CSS, ...hooks };
})();

/**
 * A `document` stub with a `head` that records appended children, whether each arrived inside an effect, and their removal,
 * and a `visibilityState` that `setVisibility` changes before it dispatches `visibilitychange` to the listeners `addEventListener` holds.
 * It installs a fake `EventSource` class too, whose instances record `url`, listeners, `readyState` and `close()` calls; both are restored after the case.
 */
export function stubDocument(t, { inEffect = () => false, visibilityState = 'visible' } = {}) {
  const head = { children: [], appendChild(node) { node.appendedInEffect = inEffect(); head.children.push(node); return node; } };
  const createElement = tag => ({
    tag, dataset: {}, textContent: '',
    remove() { head.children.splice(head.children.indexOf(this), 1); },
  });
  const listeners = new Set();
  const doc = {
    head, createElement, visibilityState,
    addEventListener(type, listener) { if (type === 'visibilitychange') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'visibilitychange') listeners.delete(listener); },
  };
  const sources = [];
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.CONNECTING;
      this.listeners = {};
      this.closeCalls = 0;
      this.openedInEffect = inEffect();
      sources.push(this);
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    close() { this.closeCalls += 1; this.readyState = FakeEventSource.CLOSED; }
    emit(type, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event); }
  }
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    EventSource: Object.getOwnPropertyDescriptor(globalThis, 'EventSource'),
  };
  globalThis.document = doc;
  globalThis.EventSource = FakeEventSource;
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    head, doc, sources, visibilityListeners: listeners,
    setVisibility(next) {
      doc.visibilityState = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * A fake client ctx recording each service call the plugin makes.
 * `slots.inject` holds its callback; `declare()` runs every held callback and keeps its disposer, `undeclare()` calls them.
 * `slots.register` throws while the slot is undeclared, as DSH's does, and otherwise records and returns a recording disposer.
 * `setGeneration(snapshot)` replaces the connection generation and calls its listeners, as the checkout's `publishGeneration` does.
 * `rpcCall(channel, endpoint, payload, signal)` answers the connection's `rpc.call` when given, and a synchronous throw of it escapes the call as the real method's would; `translated` lists the keys every bound translate was asked for.
 * `services` maps a service name to `child => service`, the service as the child that reads it sees it. `inject(deps, callback)` calls back at once, with a child `{ ...services, effect }`, only when every named service is present, and holds nothing otherwise.
 * An `effect` of the child runs at once and its disposer is collected; `children[n].dispose()` runs the collected disposers in reverse registration order, as Cordis does when the child unloads.
 */
export function fakeCtx(options = {}) {
  const log = [];
  let effectDepth = 0;
  const effectDisposers = [];
  const injections = [];
  const registrations = [];
  let declared = false;
  let generation = 'generation' in options ? options.generation : { id: 1, host: {} };
  const generationListeners = new Set();
  // Each translate and theme read answers a fresh count, so a value cached at registration shows as a stale one.
  let translations = 0;
  let themeReads = 0;
  const translated = [];
  const services = options.services ?? {};
  const children = [];
  const ctx = {
    effect(fn) {
      effectDepth++;
      let dispose;
      try { dispose = fn(); } finally { effectDepth--; }
      effectDisposers.push(dispose);
      return dispose;
    },
    locale: {
      register(ns, dicts) {
        log.push({ call: 'locale.register', ns, dicts, inEffect: effectDepth > 0 });
        return () => { log.push({ call: 'locale.dispose', ns }); };
      },
      bind(ns) {
        log.push({ call: 'locale.bind', ns });
        return (key, params) => {
          translated.push(key);
          return `${ns}:${key}${params ? JSON.stringify(params) : ''}#${++translations}`;
        };
      },
    },
    theme: { getTheme() { log.push({ call: 'theme.getTheme' }); return { active: { id: 'dark' }, revision: ++themeReads }; } },
    on(event, listener) {
      log.push({ call: 'on', event, listener });
      return () => { log.push({ call: 'off', event }); };
    },
    connection: {
      rpc: {
        call(channel, endpoint, payload, signal) {
          log.push({ call: 'rpc.call', channel, endpoint, payload, signal });
          if (options.rpcCall) return options.rpcCall(channel, endpoint, payload, signal);
          return Promise.resolve({ ok: true, value: { state: 'bootstrapping' } });
        },
      },
      // The checkout's generation state: `getSnapshot()` answers `{ id, host }` or undefined, and each listener is called with no argument whenever the snapshot is replaced.
      generation: {
        getSnapshot: () => generation,
        subscribe(listener) {
          generationListeners.add(listener);
          return () => { generationListeners.delete(listener); };
        },
      },
    },
    inject(deps, callback) {
      if (!deps.every(name => name in services)) return;
      const disposers = [];
      const child = {
        effect(execute) {
          const dispose = execute();
          disposers.push(dispose);
          return dispose;
        },
      };
      for (const name of deps) child[name] = services[name](child);
      children.push({ dispose() { for (const dispose of disposers.splice(0).reverse()) dispose?.(); } });
      callback(child);
    },
    slots: {
      inject(key, callback) {
        log.push({ call: 'slots.inject', key });
        injections.push({ key, callback, dispose: null });
        return () => {};
      },
      register(options, component) {
        if (!declared) throw new Error(`slot "${options.name}" is not declared`);
        const registration = { options, component, disposed: 0 };
        registrations.push(registration);
        return () => { registration.disposed++; };
      },
    },
  };
  return {
    ctx, log, registrations, injections, translated, children,
    inEffect: () => effectDepth > 0,
    declare() {
      declared = true;
      for (const injection of injections) injection.dispose = injection.callback();
    },
    undeclare() {
      for (const injection of injections) { injection.dispose?.(); injection.dispose = null; }
      declared = false;
    },
    disposeEffects() { for (const dispose of effectDisposers.splice(0).reverse()) dispose?.(); },
    generationListeners,
    setGeneration(next) {
      if (Object.is(generation, next)) return;
      generation = next;
      for (const listener of [...generationListeners]) listener();
    },
  };
}
