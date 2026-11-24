// dsh/src/host.js — the session watcher mounted on the Cordis context it is handed.
// Every DSH service is read through `ctx` and every path is handed in, so a fake context drives the host under `node:test` and the plugin face binds the production values.
import { initStore, getStore, closeStoreGlobal } from '../../lib/store.js';
import { cacheTtlForRetention } from '../../lib/harness/dsh/cache-ttl.js';
import { ATTRIBUTION_LIMITS } from '../../lib/constants.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { composeWatcher, nodeWorkingTree } from './composition.js';
import { readObserved, readUnobserved } from './observed-read.js';
import { createWatcherTable, writeDiagnostic, handlerFailed, hostDiagnostic } from './watcher-table.js';
import { createModelNames } from './model-names.js';
import { createEpochModelName } from './epoch-model-name.js';
import { createRpcHandler } from './rpc.js';
import { CARRIER_EVIDENCE_SERVICE, CARRIER_PREFIX_SERVICE, CARRIER_SETTINGS_SERVICE, PI_AI_SERVICE } from './pi-ai-integration.js';
import { createCarrierEvidence } from './carrier-evidence.js';
import { carrierCacheDepsOf, createCarrierCacheSwitch } from './carrier-cache-switch.js';
import { createSignalHub } from './signal.js';
import { createHandoffDelivery, createTools } from './tools.js';
import { createContinueCommand } from './continue.js';
import { createEventReadTool } from './event-read.js';
import { EVENT_READ_GUIDANCE, EVENT_READ_TOOL } from '../../lib/harness/dsh/event-read.js';
import { createLoadCommand } from './load.js';
import { registerSkills } from './skills.js';
import { innerModeProjection, createModeSelection, createModeInheritance, createModeAccess, isModeInput } from './inner-mode.js';
import { createInnerSeal } from './inner-seal.js';
import { carrierPrefixOf } from '../../lib/inner-seal/carrier.js';
import { CARRIER_TABLE } from '../../lib/harness/dsh/carrier-table.js';
import { createReadGuard } from './read-guard.js';
import { readGitState } from '../../lib/inner-seal/git-state.js';
import { createInnerMonitor } from './inner-monitor.js';
import { heldInContext, innerMonitorProjection, createMonitorAccess, isMonitorInput } from './inner-monitor-read.js';

/** The services `applyHost` reads on `ctx` itself, which the plugin face injects. */
export const HOST_INJECT = ['sessions', 'sessionQuery', 'tools', 'skills', 'llm'];

/** The services the inner compaction feature's one child reads; the child waits for every one of them. */
const INNER_INJECT = ['sessionProjections', 'agents', 'fs', 'attachments', 'tokenMeter'];

/** The code the session query service rejects a read with for an id it neither holds live nor lists. */
const SESSION_NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND';

/**
 * Mount the host on `ctx`: open the store at `storePath`, keep one watcher per session the context lists, creates or appends to, and build one on demand when the RPC channel or `watcher_status` names a session the table lacks and the session listing holds, archive each on its session's disposal, and archive every live one and close the store when `ctx` unloads.
 * The agent tools answer each calling session from its watcher, `watcher_status` any session the host has run or persisted, and the skills are registered from the `SKILL.md` files under `skillsDir`; with `connection` and `webServer` present, the `/session-watcher` RPC channel answers from the watcher table, and the `/api/session-watcher.events` route streams the id of each session whose entry changes state, applies a frame, has its readings changed over the channel or is announced by `session/created`, which signals whether or not the table already holds its entry.
 * Each model call is measured under the `llm` catalog name of its provider and model id once `llm.resolveModelInfo` has answered one, and under the id until then; a pair keeps the first name it resolves to until the plugin remounts. An `agent/pre-step` listener (`createEpochModelName`) holds a step whose session has no measured call in its open epoch until the name of the model the step captured is resolved or fails to resolve, so the call that fixes the Epoch Model is mapped under it. The plugin requires `llm`, and a re-provided `llm` remounts the whole host, as a re-provided `sessions` does.
 * With the `commands`, `workingDirectory` and `fs` services present, the `/sw-load` command (`createLoadCommand`) is registered on their injection's child, and with `tokenMeter` as well, the `/sw-continue` command (`createContinueCommand`) on its own injection's child; each leaves with any service its injection names. Both deliver through the one `createHandoffDelivery` over the table, the store and the title service, which titles the loading session when one is mounted, read the kept text with `readObserved` over their child's `fs` and the process's shared Working Tree (`nodeWorkingTree`, the one the watchers attribute against), resolve a session's directory through their child's `workingDirectory.get`, and build their messages and events from `commandKit`, the `CompactionId`, `compactCheckpointSource` and `createUserMessage` values, read only there, so a caller that mounts neither command omits it.
 * With `queryKit`, the `extractSessionEventText` value of `dsh-session-query` and the `HarnessError` value of `dsh-llm`, the `sw_event_read` tool (`createEventReadTool`) is registered beside the others and answers any session the caller's directory holds from `ctx.sessionQuery`, with no watcher, and refuses an event of the caller's own session that the monitor's projection holds in its context whole (`heldInContext`), refusing none while the monitor's access is unpublished; with the `systemPrompt` service as well, its injection's child registers the tool's guidance (`EVENT_READ_GUIDANCE`) as a system prompt section at the session query order, empty for a step whose tool set does not hold the tool.
 * With `innerKit`, the `appendPluginRecord` and `pluginRecordOf` values of `dsh-session`, the `AssistantStreamAccumulator`, `BlockAssembler`, `assembleAssistantStream`, `lastAssistantStreamChunk`, `errorChain` and `createUserMessage` values of `dsh-llm`, the `toolPairingBalancedBefore` and `toolPairingBalancedAfter` values of `dsh-compaction` and the `loads` value of `ai-json-repair`, which the seal (`createInnerSeal`) and its auxiliary call (`summarizeSlots`) take as their `kit` and the monitor's projection (`innerMonitorProjection`) and rows read through it, `assembleAssistantStream` the monitor's alone and `loads` the auxiliary call's alone, which recovers a summary reply whose JSON syntax fails, and the `sessionProjections`, `agents`, `fs`, `attachments` and `tokenMeter` services present, the inner compaction feature's one child registers the session mode's projection (`innerModeProjection`) and awaits it before it publishes anything: the mode access the channel's `inner-mode` and `inner-mode/select` read (`createModeAccess`) and the watcher table's frames read as well, so a session whose mode is on has the qualified prefix of its Source for its Rate Lamp budget and one whose mode is off or invalid counts every call; the frames and the selection keep to the synchronous read of the instances the host holds, while the page's `inner-mode` answers through the access's `display`, which gives a session the host holds no instance of the state of its stored log, read once and folded under the registered projection (`readStored`), a `session/event` listener that publishes a session's id on a mode record, `turn/start`, an attempt record, an inner-seal carrier or a message of a handoff load, an `agent/created` listener that gives a plain subagent its parent's mode (`createModeInheritance`), which the serial creation awaits before the child's first turn, and the seal's `agent/pre-step` listener, registered with `prepend`, which reads the held text it quotes through `readUnobserved` over the child's `fs` and the shared tree, the C ratio of the session's live watcher (`getStatus`) and the calibrated pair of its epoch model (`getEpochModel`), each none without a live watcher, the session's state items through `readState`, the adapter over the child's `sessionProjections.snapshot(session, ['todos', 'subagentCatalog'])`, its `agents`, and the context's `workingDirectory` and `jobs` services where they are provided, and its git state through `readGit`, which reads it in the directory the `workingDirectory` service shows (`readGitState`), and takes the child's `createInnerMonitor`, built over `innerKit.appendPluginRecord` and the hub's `publish`, so a change of its registry of attempts in flight signals as well; the read guard's `tools/post-execute` and `tools/result` listeners (`createReadGuard`) answer a native `read` of lines the session's context holds with an error once it has run, and record the block that took effect, over the live watcher's scratch (`table.heldScratch`), the entries' event facts, the store's saved Attribution Records, the shared Working Tree and the child's `fs`. Once those stand it registers the monitor's projection the same way and builds the monitor access the channel's `inner-monitor` endpoints read (`createMonitorAccess`) over the projection's state, the registry's entries, the host's `readSession`, which an attempt's and a handoff's details and a clear's settlement read the log through, the store's next task of a handoff (`nextTaskOf`, over `getHandoff`), and `readStored`, which supplies one log snapshot and its folded monitor state for sessions without a held instance and, whether or not the session is held, for the current settlement and a settlement target, each of which reads from one snapshot. A rejected mode registration fails the child and publishes none of them; a monitor registration or access that fails is one `inner_monitor_register` stderr line that leaves the monitor access unpublished, nothing retried, until the child mounts again, and takes back nothing the mode wired. The child's disposer withdraws both accesses, its listeners leave with it, and the appearance and the withdrawal of the accesses each publish every session `ctx.sessions` lists. A caller that mounts no feature omits `innerKit`.
 * `readSettings()` answers the user's current settings, `{ preset, fallbackModel, inheritInSubagents, carrierResponsesBreakpoint }`, the Config's volatile values as the plugin face reads them: the seal reads the policy and the backup model once per quote, the plain-subagent inheritance reads whether to give a child its parent's mode as the child is created, and `CARRIER_SETTINGS_SERVICE` answers the Responses breakpoint switch from `carrierResponsesBreakpoint` (off where the caller passes no `readSettings`) each time the pi-ai entry asks, so a save changes the next read and the host keeps no copy. A caller that passes `innerKit` passes it too.
 * A route's cache lifetime is the retention its profile declares: the service of the opt-in pi-ai entry (`pi-ai-integration.js`, read through `ctx.get` at each use) answers it from the configuration it read at startup while the entry is mounted and serves, and the Settings service answers it otherwise, an entry that reports a failure included. The channel's `pi-ai/status` answers that service's `failure` cause, null while the entry is not mounted.
 * The host provides `CARRIER_EVIDENCE_SERVICE` (`carrier-evidence.js`), which the opt-in pi-ai entry's wrapped payload hook reports each serialization's closed result to, `CARRIER_SETTINGS_SERVICE`, which the entry asks whether the owner's Responses breakpoint switch is on, and `CARRIER_PREFIX_SERVICE`, which it asks at each call of the hook what a carrier opens with (`carrierPrefixOf` over the DSH wording table); the seal takes a scope of the evidence service around each summary request's stream, and the request's call record keeps what the scope held. The channel's `carrier-cache/status` and `carrier-cache/set` answer the owner alone from the one switch (`carrier-cache-switch.js`) the host builds over the `pluginManager`, `loader` and `llm` services and the pi-ai entry's service, each read at the call.
 * `carrierInstallTarget()` is the install target of the official carrier cache bundle (`carrier-cache-switch.js`), `{ spec, version }` or null; the plugin face gives the bundle's name at the version of its own `package.json`, and a composition that passes none leaves a profile without the bundle with no switch.
 * `turnNotesRoot` is the Turn Notes root; `loadIsIgnored(cwd)` answers a session's ignore matcher.
 * No handler or disposer throws into the host: a failure is a watcher's diagnostic or a stderr line.
 *
 * @returns {{ table: ReturnType<typeof createWatcherTable> }}
 */
export function applyHost(ctx, { storePath, turnNotesRoot, loadIsIgnored, defineTool, skillsDir, commandKit, queryKit, innerKit, readSettings, carrierInstallTarget }) {
  initStore(storePath);
  // Registered right after the store opens, so a disposal after a later throw in `apply` still closes it.
  ctx.effect(() => () => {
    try { table.disposeAll(); } catch (error) { writeDiagnostic(null, handlerFailed(error)); }
    try { closeStoreGlobal(); } catch (error) { writeDiagnostic(null, handlerFailed(error)); }
  });

  // The retention a route's profile declares, read from the Settings service for the Harness's own adapter.
  let readSettingsRetention = () => null;
  // A mounted opt-in pi-ai entry that serves (`pi-ai-integration.js`) answers from the configuration it read at startup, none of its routes' profiles being in Settings, and is read at each use so a remount or an unmount is followed. An entry that reports a failure holds no retention, and the Settings service answers as it does with no entry: the original adapter serves the routes when its row is still on.
  const readCacheRetention = (route) => {
    const piAi = ctx.get(PI_AI_SERVICE);
    return piAi?.failure === null ? piAi.cacheRetention(route) : readSettingsRetention(route);
  };
  // `readSession` reads its service's own state, so it is called on the service and never passed bare.
  const readSession = sessionId => ctx.sessionQuery.readSession(sessionId);
  // Read a session log and fold the page's projection over that same snapshot. The mode and monitor use this without a held projection; the current settlement uses it even for a held session.
  // Any other failure of the read or of the fold propagates. It makes no watcher, no session and no record, and keeps nothing: each call reads again.
  const readStored = async (definition, sessionId) => {
    let snapshot;
    try {
      snapshot = await readSession(sessionId);
    } catch (error) {
      if (error?.code === SESSION_NOT_FOUND) return undefined;
      throw error;
    }
    const { session, inheritedEventCount, events } = snapshot;
    return { state: events.reduce((state, event) => definition.apply(state, event), definition.init(session, inheritedEventCount)), events };
  };
  // Async, so a synchronous throw from the service is a rejection the warm-up settles rather than a throw on the feed path (test/dsh.host.lifecycle.test.js `throws synchronously leaves the entry live`).
  const modelNames = createModelNames({ resolve: async (provider, id) => ctx.llm.resolveModelInfo(provider, id) });
  const workingTree = nodeWorkingTree();
  // The session mode's access, published by the inner child once its projection is registered and withdrawn with the child; the channel and the table's frames read it at each use.
  let modeAccess = null;
  const table = createWatcherTable({
    readSession,
    modelNames,
    // The mode the child's projection answers, the one authority of whether a session's budget counts the qualified prefix; a host without the child has no mode to read.
    innerModeOn: sessionId => modeAccess?.read(sessionId)?.mode === 'on',
    cacheTtlFor: route => cacheTtlForRetention(readCacheRetention(route)),
    compose: ({ sessionId, cwd, cacheTtl }) => composeWatcher({
      sessionId, cwd, cacheTtl, store: getStore(), turnNotesRoot, readSession, isIgnored: loadIsIgnored(cwd), workingTree,
    }),
  });
  // The one resolution of a session the table has not observed, for the RPC channel and the tools: it ensures the listing's record for `sessionId`, whose id is only in its header, and answers the record or null; `signal` aborts the listing, and a throw from the listing or the ensure propagates.
  const resolvePersisted = async (sessionId, signal) => {
    const record = (await ctx.sessionQuery.listSessions(signal)).find(each => each.header.id === sessionId) ?? null;
    if (record !== null) table.ensure({ id: record.header.id, header: record.header });
    return record;
  };
  // What the opt-in pi-ai entry's wrapped payload hook reports, filed under the scope of the summary request whose stream is being iterated, and the owner's saved Responses breakpoint switch it asks at each request; the entry reads each service at each use, and the seal takes the scopes.
  const carrierEvidence = createCarrierEvidence();
  ctx.provide(CARRIER_EVIDENCE_SERVICE, carrierEvidence.service);
  ctx.provide(CARRIER_SETTINGS_SERVICE, { responsesBreakpoint: () => readSettings?.().carrierResponsesBreakpoint === true });
  ctx.provide(CARRIER_PREFIX_SERVICE, { carrierPrefix: () => carrierPrefixOf(CARRIER_TABLE) });
  const hub = createSignalHub();
  table.onChange(sessionId => hub.publish(sessionId));
  // It reads the epoch model after `next()`, so a boundary a listener inside it writes has cleared it by then.
  ctx.on('agent/pre-step', createEpochModelName({
    awaitsEpochModel: (sessionId) => {
      const entry = table.get(sessionId);
      return entry.state === 'live' && entry.watcher.getEpochModel() === null;
    },
    warm: pairs => modelNames.warm(pairs),
  }));

  const guarded = (sessionId, body) => {
    try { body(); } catch (error) { writeDiagnostic(sessionId, handlerFailed(error)); }
  };

  for (const session of ctx.sessions.list()) guarded(session.id, () => table.ensure(session));
  // The instance's appearance is a signal of its own: what a page read as unavailable before it, a mode's or a monitor's, is read again, whether or not the table already holds an entry for the session or composing one failed.
  ctx.on('session/created', (session) => {
    guarded(session.id, () => table.ensure(session));
    guarded(session.id, () => hub.publish(session.id));
  }, { global: true });
  // No `await` here: the bootstrap queue takes events in feed order.
  ctx.on('session/event', (session, event) => guarded(session.id, () => {
    table.ensure(session);
    table.feed(session.id, event);
  }));
  ctx.on('session/disposed', session => guarded(session.id, () => table.dispose(session.id)));
  // Read at each call: a deployment without a title service mounts the host all the same, and titles nothing.
  const sessionTitle = () => ctx.get('sessionTitle');
  for (const definition of createTools({ defineTool, table, store: getStore(), resolvePersisted })) ctx.tools.register(definition);
  // The monitor's answer of whether an event is in a session's context whole, published with the monitor's access and withdrawn with it; the event read asks it at each call and refuses nothing while it is unpublished.
  let heldOf = null;
  // The event read answers from the session query service alone, so it stands outside the watcher table and every gate the other tools wait on; a caller without `queryKit` mounts none.
  if (queryKit !== undefined) {
    ctx.tools.register(createEventReadTool({ defineTool, ctx, ...queryKit, heldInContext: (sessionId, seq) => heldOf?.(sessionId, seq) === true }));
    // The section is an effect of the child, so the callback returns nothing.
    ctx.inject(['systemPrompt'], (child) => {
      child.systemPrompt.section({
        name: `tool:${EVENT_READ_TOOL}`,
        order: child.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
        text: ({ scope, toolSet }) => (ctx.tools.get(EVENT_READ_TOOL, scope, toolSet) === undefined ? '' : EVENT_READ_GUIDANCE),
      });
    });
  }
  const deliver = createHandoffDelivery({ table, store: getStore(), sessionTitle });
  registerSkills(ctx, { skillsDir });
  // The kept text of a load, read from the shared tree and recorded as the agent's observation through the `fs` of the child that registers the command.
  const readFileThrough = fs => (agent, key, ranges, signal) => readObserved({
    fs, emit: (...args) => ctx.emit(...args), agent, tree: workingTree, key, ranges, fileBytes: ATTRIBUTION_LIMITS.fileBytes, signal,
  });
  // The held text a quote reads from the same tree, recording no observation.
  const readUnobservedThrough = fs => (_agent, key, ranges, signal) => readUnobserved({
    fs, tree: workingTree, key, ranges, fileBytes: ATTRIBUTION_LIMITS.fileBytes, signal,
  });
  // The inner seal's read of a session's state, the DSH adapter of the carrier's state items: the cut and, for each item, a read of its value, none for an item whose source the host does not hold (an unregistered unit, a service that is not provided).
  // The todo list and the subagent catalog come from one synchronous snapshot, whose cut is the block's; a snapshot that throws fails the whole read, which the seal reports once and answers with no state block. The services are read at each use, so an absent one leaves its item unavailable.
  const stateOf = ({ sessionProjections, agents }) => (session) => {
    const { asOfSeq, values } = sessionProjections.snapshot(session, ['todos', 'subagentCatalog']);
    const projected = (key, valueOf = value => value) => (Object.hasOwn(values, key) ? () => valueOf(values[key]) : undefined);
    const workingDirectory = ctx.get('workingDirectory');
    const jobs = ctx.get('jobs');
    return {
      asOfSeq,
      items: {
        workingDirectory: workingDirectory === undefined ? undefined : () => workingDirectory.get(session),
        // The children `list_agents` shows, those it marks running.
        subagents: projected('subagentCatalog', catalog => catalog
          .filter(({ id, mode }) => mode === 'continuable' && agents.get(id)?.status === 'running')
          .map(({ id, label }) => ({ id, label }))),
        jobs: jobs === undefined ? undefined : () => jobs.list(session.id)
          .filter(({ status }) => status === 'running' || status === 'stopping')
          .map(({ id, label }) => ({ id, label })),
        todos: projected('todos'),
      },
    };
  };
  // The seal's read of the git state in the directory the session's working directory item shows; it takes an await, so it is not among `stateOf`'s synchronous reads. None where the host holds no working directory service; a directory that cannot be read rejects.
  const gitStateOf = async (session, signal) => {
    const workingDirectory = ctx.get('workingDirectory');
    return workingDirectory === undefined ? null : readGitState({ cwd: workingDirectory.get(session), signal });
  };
  // The C ratio a session's live watcher reads, its model policy's default and a saved override included; null while the session has no live watcher.
  const ratioOf = (sessionId) => {
    const entry = table.get(sessionId);
    return entry.state === 'live' ? entry.watcher.getStatus().cRatio : null;
  };
  // The calibrated pair of the epoch model of a session's live watcher, the model every model-dependent value of the epoch resolves from; null while the session has no live watcher.
  const ctpOf = (sessionId) => {
    const entry = table.get(sessionId);
    return entry.state === 'live' ? modelPolicyFor(entry.watcher.getEpochModel() ?? '').ctp : null;
  };
  // `commands.register` is an effect of the child that reads it, so a registration leaves when any service its injection names does.
  ctx.inject(['commands', 'tokenMeter', 'workingDirectory', 'fs'], (child) => {
    child.commands.register(createContinueCommand({
      table, store: getStore(), kit: commandKit, meter: child.tokenMeter, flush: session => ctx.sessions.flush(session),
      deliver, readFile: readFileThrough(child.fs), cwdOf: session => child.workingDirectory.get(session),
    }));
  });
  ctx.inject(['commands', 'workingDirectory', 'fs'], (child) => {
    child.commands.register(createLoadCommand({
      deliver, readFile: readFileThrough(child.fs), kit: commandKit, cwdOf: session => child.workingDirectory.get(session),
    }));
  });

  // The monitor's access, published by the same child once the monitor's projection is registered, and left unpublished when that registration fails; the channel reads it at each request.
  let monitorAccess = null;
  // The mode's availability reaches every page for every session the host lists, whatever its measurement says.
  const publishListed = () => guarded(null, () => { for (const session of ctx.sessions.list()) hub.publish(session.id); });
  // With `innerKit` the inner compaction feature's one child: the mode's projection is registered and awaited before anything is published, the monitor's after the mode's wiring, and what the child publishes leaves with it.
  if (innerKit !== undefined) {
    ctx.inject(INNER_INJECT, async (child) => {
      const modeProjection = innerModeProjection(innerKit);
      const handle = await child.sessionProjections.register(modeProjection);
      const sessionOf = id => ctx.sessions.get(id);
      const inherit = createModeInheritance({
        sessionOf, readMode: session => handle.stateOf(session), readSettings, readSession, appendPluginRecord: innerKit.appendPluginRecord,
      });
      // The mode's and the monitor's own signal: their inputs reach the page whether or not the session's measurement is live.
      child.on('session/event', (session, event) => guarded(session.id, () => { if (isModeInput(event) || isMonitorInput(event)) hub.publish(session.id); }));
      // The serial creation awaits this listener and releases the child's first turn after it, so the record stands before it; a throw or rejection from the listener would fail the agent's creation.
      child.on('agent/created', async (payload) => {
        try { await inherit(payload); } catch (error) { writeDiagnostic(payload.agent.session.id, handlerFailed(error)); }
      });
      // The monitor records each of the seal's attempts and keeps the registry of those in flight, which is the child's and leaves with it.
      const monitor = createInnerMonitor({ appendPluginRecord: innerKit.appendPluginRecord, publish: hub.publish });
      // Prepended, so the seal runs ahead of every other pre-step listener, a stock compaction's included, and they read the sealed surface.
      child.on('agent/pre-step', createInnerSeal({
        readMode: session => handle.stateOf(session),
        eventFacts: sessionId => table.eventFacts(sessionId),
        readSession,
        heldView: (sessionId, events) => table.heldView(sessionId, events),
        readFile: readFileThrough(child.fs),
        readUnobserved: readUnobservedThrough(child.fs),
        readState: stateOf(child),
        readGit: gitStateOf,
        cRatio: ratioOf,
        ctpOf,
        readSettings,
        llm: ctx.llm, attachments: child.attachments, meter: child.tokenMeter, kit: innerKit, monitor, carrier: carrierEvidence,
      }), { prepend: true });
      // A native `read` of lines the session's context holds word for word is answered with an error after it has run, and the block is recorded as the result stands.
      const readGuard = createReadGuard({
        readMode: session => handle.stateOf(session),
        heldScratch: sessionId => table.heldScratch(sessionId),
        eventFacts: sessionId => table.eventFacts(sessionId),
        recallRecord: (sessionId, toolUseId) => getStore().recallAttribution(sessionId, toolUseId),
        workingTree,
        fsOf: () => child.fs,
        appendPluginRecord: innerKit.appendPluginRecord,
      });
      child.on('tools/post-execute', readGuard.postExecute);
      child.on('tools/result', readGuard.observeResult);
      modeAccess = createModeAccess({
        sessionOf,
        readMode: session => handle.stateOf(session),
        select: createModeSelection({ agents: child.agents, appendPluginRecord: innerKit.appendPluginRecord }),
        readStored: sessionId => readStored(modeProjection, sessionId),
      });
      // The mode, the inheritance and the seal stand by now: a monitor that cannot be registered or built costs its own access alone, with one line and no retry, until the child mounts again.
      try {
        const monitorProjection = innerMonitorProjection(innerKit);
        const monitorHandle = await child.sessionProjections.register(monitorProjection);
        monitorAccess = createMonitorAccess({
          sessionOf, readMonitor: session => monitorHandle.stateOf(session), live: sessionId => monitor.live(sessionId), kit: innerKit, readSession,
          readStored: sessionId => readStored(monitorProjection, sessionId),
          // The store answers null for an id it holds no row of, so an absent handoff reads as no next task.
          nextTaskOf: handoffId => getStore().getHandoff(handoffId)?.nextTask ?? null,
        });
        heldOf = (sessionId, seq) => {
          const session = sessionOf(sessionId);
          return session !== undefined && heldInContext(monitorHandle.stateOf(session), seq);
        };
      } catch (error) {
        writeDiagnostic(null, hostDiagnostic('inner_monitor_register', error));
      }
      publishListed();
      return () => {
        modeAccess = null;
        monitorAccess = null;
        heldOf = null;
        publishListed();
      };
    });
  }

  // The owner's switch of the carrier cache bundle over the services of this context, read at each call; the one instance holds the request in flight.
  const carrierCacheSwitch = createCarrierCacheSwitch(carrierCacheDepsOf(ctx, { installTarget: carrierInstallTarget }));

  // The cause the mounted pi-ai entry gives for serving no route, and nothing of what the entry holds beyond it; null while none is mounted.
  const piAiFailure = () => {
    const failure = ctx.get(PI_AI_SERVICE)?.failure;
    return failure == null ? null : { cause: failure.cause };
  };

  // rc.1's `rpc.handle` reads `owner.webServer` through Connection's own fiber, which does not inject it, so under the Loader's sibling composition the read throws and the channel and the route after it go missing; the own `webServer` that `extend` puts on the child wins over that lookup (`DSH-RPC-HANDLE-ROOT-READ`).
  // `rpc.handle` and `fetch.register` are effects of the context that reads them, so the channel and the route leave with this child, and the streams it served close with it.
  ctx.inject(['connection', 'webServer'], (child) => {
    child.extend({ webServer: child.webServer }).connection.rpc.handle('/session-watcher', createRpcHandler({
      table, store: getStore(), workingTree, publish: hub.publish, resolvePersisted, innerMode: () => modeAccess, innerMonitor: () => monitorAccess, piAiFailure,
      carrierCache: () => carrierCacheSwitch,
    }));
    child.connection.fetch.register(hub.route());
    child.effect(() => () => hub.closeAll());
  });
  // A service read on an unloaded child throws, and inside a frame that throw would fail the watcher, so the child's disposer restores the default.
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      readSettingsRetention = (route) => {
        const provider = ctx.llm.listConfigurableProviders().find(entry => entry.provider === route);
        if (provider === undefined) return null;
        let profile = child.settings.describe().find(entry => entry.ns === provider.settingsNs)?.value;
        for (const key of provider.settingsPath) profile = profile?.[key];
        return profile?.cacheRetention ?? null;
      };
      return () => { readSettingsRetention = () => null; };
    });
  });

  return { table };
}
