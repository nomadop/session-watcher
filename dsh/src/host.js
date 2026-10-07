// dsh/src/host.js — the session watcher mounted on the Cordis context it is handed.
// Every DSH service is read through `ctx` and every path is handed in, so a fake context drives the host under `node:test` and the plugin face binds the production values.
import { initStore, getStore, closeStoreGlobal } from '../../lib/store.js';
import { resolveProjectKey } from '../../lib/project-key.js';
import { cacheTtlForRetention } from '../../lib/harness/dsh/cache-ttl.js';
import { composeWatcher } from './composition.js';
import { createWatcherTable, writeDiagnostic, handlerFailed } from './watcher-table.js';
import { createModelNames } from './model-names.js';
import { createRpcHandler } from './rpc.js';
import { createSignalHub } from './signal.js';
import { createTools } from './tools.js';
import { registerSkills } from './skills.js';
import { catalogMessageFor } from './catalog.js';

/** The services `applyHost` reads on `ctx` itself, which the plugin face injects. */
export const HOST_INJECT = ['sessions', 'sessionQuery', 'tools', 'skills', 'llm'];

/**
 * Mount the host on `ctx`: open the store at `storePath`, keep one watcher per session the context lists, creates or appends to, and build one on demand when the RPC channel names a session the table lacks and the session listing holds, archive each on its session's disposal, and archive every live one and close the store when `ctx` unloads.
 * The agent tools answer each calling session from its watcher, the skills are registered from the `SKILL.md` files under `skillsDir`, and an agent created at startup or resume is injected the pending-handoff catalog of its session's project; with a connection present, the `/session-watcher` RPC channel answers from the watcher table, and the `/api/session-watcher.events` route streams the id of each session whose entry changes state, applies a frame or has its readings changed over the channel.
 * Each model call is measured under the `llm` catalog name of its provider and model id once `llm.resolveModelInfo` has answered one, and under the id until then; a pair keeps the first name it resolves to until the plugin remounts. The plugin requires `llm`, and a re-provided `llm` remounts the whole host, as a re-provided `sessions` does.
 * `turnNotesRoot` is the Turn Notes root; `loadIsIgnored(cwd)` answers a session's ignore matcher.
 * No handler or disposer throws into the host: a failure is a watcher's diagnostic or a stderr line.
 *
 * @returns {{ table: ReturnType<typeof createWatcherTable> }}
 */
export function applyHost(ctx, { storePath, turnNotesRoot, loadIsIgnored, defineTool, skillsDir }) {
  initStore(storePath);
  // Registered right after the store opens, so a disposal after a later throw in `apply` still closes it.
  ctx.effect(() => () => {
    try { table.disposeAll(); } catch (error) { writeDiagnostic(null, handlerFailed(error)); }
    try { closeStoreGlobal(); } catch (error) { writeDiagnostic(null, handlerFailed(error)); }
  });

  let readCacheRetention = () => null;
  // `readSession` reads its service's own state, so it is called on the service and never passed bare.
  const readSession = sessionId => ctx.sessionQuery.readSession(sessionId);
  // A listing record carries its id only in its header.
  const resolvePersisted = async sessionId => (await ctx.sessionQuery.listSessions())
    .find(record => record.header.id === sessionId) ?? null;
  // Async, so a synchronous throw from the service is a rejection the warm-up settles rather than a throw on the feed path (test/dsh.host.lifecycle.test.js `throws synchronously leaves the entry live`).
  const modelNames = createModelNames({ resolve: async (provider, id) => ctx.llm.resolveModelInfo(provider, id) });
  const table = createWatcherTable({
    readSession,
    modelNames,
    cacheTtlFor: route => cacheTtlForRetention(readCacheRetention(route)),
    compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
      sessionId, cwd, cacheTtl, store: getStore(), turnNotesRoot, readSession, isIgnored: loadIsIgnored(cwd),
    }),
  });
  const hub = createSignalHub();
  table.onChange(sessionId => hub.publish(sessionId));

  const guarded = (sessionId, body) => {
    try { body(); } catch (error) { writeDiagnostic(sessionId, handlerFailed(error)); }
  };

  for (const session of ctx.sessions.list()) guarded(session.id, () => table.ensure(session));
  ctx.on('session/created', session => guarded(session.id, () => table.ensure(session)), { global: true });
  // No `await` here: the bootstrap queue takes events in feed order.
  ctx.on('session/event', (session, event) => guarded(session.id, () => {
    table.ensure(session);
    table.feed(session.id, event);
  }));
  ctx.on('session/disposed', session => guarded(session.id, () => table.dispose(session.id)));
  ctx.on('agent/created', ({ agent, source }) => guarded(agent.session.id, () => {
    if (source !== 'startup' && source !== 'resume') return;
    if (agent.session.header.origin === 'subagent') return;
    const message = catalogMessageFor({
      dbPath: storePath, projectId: resolveProjectKey({ cwd: agent.session.header.cwd }), sessionId: agent.session.id,
    });
    if (message !== null) agent.inject(message);
  }));
  for (const definition of createTools({ defineTool, table, store: getStore() })) ctx.tools.register(definition);
  registerSkills(ctx, { skillsDir });

  // Handed a plugin caller, `rpc.handle` reads `webServer` from Connection's own fiber, which does not inject it; called from the root, the read is permitted.
  // The root then owns the route, so the child's effect removes it.
  ctx.inject(['connection'], (child) => {
    const remove = child.root.get('connection').rpc.handle('/session-watcher', createRpcHandler({
      table, store: getStore(), publish: hub.publish, resolvePersisted,
    }));
    child.effect(() => remove);
    // `fetch.register` is an effect of the context that read `connection`, so read on the child the route leaves with it, and the streams it served close with it.
    child.connection.fetch.register(hub.route());
    child.effect(() => () => hub.closeAll());
  });
  // A service read on an unloaded child throws, and inside a frame that throw would fail the watcher, so the child's disposer restores the default.
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      readCacheRetention = (route) => {
        const provider = ctx.llm.listConfigurableProviders().find(entry => entry.provider === route);
        if (provider === undefined) return null;
        let profile = child.settings.describe().find(entry => entry.ns === provider.settingsNs)?.value;
        for (const key of provider.settingsPath) profile = profile?.[key];
        return profile?.cacheRetention ?? null;
      };
      return () => { readCacheRetention = () => null; };
    });
  });

  return { table };
}
