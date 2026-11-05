// dsh/src/host.js — the session watcher mounted on the Cordis context it is handed.
// Every DSH service is read through `ctx` and every path is handed in, so a fake context drives the host under `node:test` and the plugin face binds the production values.
import { initStore, getStore, closeStoreGlobal } from '../../lib/store.js';
import { cacheTtlForRetention } from '../../lib/harness/dsh/cache-ttl.js';
import { composeWatcher } from './composition.js';
import { createWatcherTable, writeDiagnostic, handlerFailed } from './watcher-table.js';
import { createModelNames } from './model-names.js';
import { createRpcHandler } from './rpc.js';
import { createSignalHub } from './signal.js';
import { createHandoffDelivery, createTools } from './tools.js';
import { createContinueCommand } from './continue.js';
import { createLoadCommand } from './load.js';
import { registerSkills } from './skills.js';

/** The services `applyHost` reads on `ctx` itself, which the plugin face injects. */
export const HOST_INJECT = ['sessions', 'sessionQuery', 'tools', 'skills', 'llm'];

/**
 * Mount the host on `ctx`: open the store at `storePath`, keep one watcher per session the context lists, creates or appends to, and build one on demand when the RPC channel or `watcher_status` names a session the table lacks and the session listing holds, archive each on its session's disposal, and archive every live one and close the store when `ctx` unloads.
 * The agent tools answer each calling session from its watcher, `watcher_status` any session the host has run or persisted, and the skills are registered from the `SKILL.md` files under `skillsDir`; with `connection` and `webServer` present, the `/session-watcher` RPC channel answers from the watcher table, and the `/api/session-watcher.events` route streams the id of each session whose entry changes state, applies a frame or has its readings changed over the channel.
 * Each model call is measured under the `llm` catalog name of its provider and model id once `llm.resolveModelInfo` has answered one, and under the id until then; a pair keeps the first name it resolves to until the plugin remounts. The plugin requires `llm`, and a re-provided `llm` remounts the whole host, as a re-provided `sessions` does.
 * With the `commands` and `workingDirectory` services present, the `/sw-load` command (`createLoadCommand`) is registered on their injection's child, and with `tokenMeter` as well, the `/sw-continue` command (`createContinueCommand`) on its own injection's child; each leaves with any service its injection names. Both deliver through the one `createHandoffDelivery` over the table, the store and the title service, which titles the loading session when one is mounted, read through `ctx.tools`, resolve a session's directory through their child's `workingDirectory.get`, and build their messages and events from `commandKit`, the `CompactionId`, `compactCheckpointSource` and `createUserMessage` values, read only there, so a caller that mounts neither command omits it.
 * `turnNotesRoot` is the Turn Notes root; `loadIsIgnored(cwd)` answers a session's ignore matcher.
 * No handler or disposer throws into the host: a failure is a watcher's diagnostic or a stderr line.
 *
 * @returns {{ table: ReturnType<typeof createWatcherTable> }}
 */
export function applyHost(ctx, { storePath, turnNotesRoot, loadIsIgnored, defineTool, skillsDir, commandKit }) {
  initStore(storePath);
  // Registered right after the store opens, so a disposal after a later throw in `apply` still closes it.
  ctx.effect(() => () => {
    try { table.disposeAll(); } catch (error) { writeDiagnostic(null, handlerFailed(error)); }
    try { closeStoreGlobal(); } catch (error) { writeDiagnostic(null, handlerFailed(error)); }
  });

  let readCacheRetention = () => null;
  // `readSession` reads its service's own state, so it is called on the service and never passed bare.
  const readSession = sessionId => ctx.sessionQuery.readSession(sessionId);
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
  // The one resolution of a session the table has not observed, for the RPC channel and the tools: it ensures the listing's record for `sessionId`, whose id is only in its header, and answers the record or null; `signal` aborts the listing, and a throw from the listing or the ensure propagates.
  const resolvePersisted = async (sessionId, signal) => {
    const record = (await ctx.sessionQuery.listSessions(signal)).find(each => each.header.id === sessionId) ?? null;
    if (record !== null) table.ensure({ id: record.header.id, header: record.header });
    return record;
  };
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
  // Read at each call: a deployment without a title service mounts the host all the same, and titles nothing.
  const sessionTitle = () => ctx.get('sessionTitle');
  for (const definition of createTools({ defineTool, table, store: getStore(), resolvePersisted })) ctx.tools.register(definition);
  const deliver = createHandoffDelivery({ table, store: getStore(), sessionTitle });
  registerSkills(ctx, { skillsDir });
  // `commands.register` is an effect of the child that reads it, so a registration leaves when any service its injection names does.
  ctx.inject(['commands', 'tokenMeter', 'workingDirectory'], (child) => {
    child.commands.register(createContinueCommand({
      table, store: getStore(), kit: commandKit, meter: child.tokenMeter, flush: session => ctx.sessions.flush(session),
      deliver, tools: ctx.tools, cwdOf: session => child.workingDirectory.get(session),
    }));
  });
  ctx.inject(['commands', 'workingDirectory'], (child) => {
    child.commands.register(createLoadCommand({
      deliver, tools: ctx.tools, kit: commandKit, cwdOf: session => child.workingDirectory.get(session),
    }));
  });

  // rc.1's `rpc.handle` reads `owner.webServer` through Connection's own fiber, which does not inject it, so under the Loader's sibling composition the read throws and the channel and the route after it go missing; the own `webServer` that `extend` puts on the child wins over that lookup (`DSH-RPC-HANDLE-ROOT-READ`).
  // `rpc.handle` and `fetch.register` are effects of the context that reads them, so the channel and the route leave with this child, and the streams it served close with it.
  ctx.inject(['connection', 'webServer'], (child) => {
    child.extend({ webServer: child.webServer }).connection.rpc.handle('/session-watcher', createRpcHandler({
      table, store: getStore(), publish: hub.publish, resolvePersisted,
    }));
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
