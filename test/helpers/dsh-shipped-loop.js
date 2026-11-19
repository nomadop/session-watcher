// test/helpers/dsh-shipped-loop.js — the real DSH loop a shipped-entry scenario child runs the built host entry in, over the fixture its parent made (`test/helpers/dsh-shipped-entry.js`): the checkout's packages imported by file path, the entry loaded through the temporary profile's runtime resolution.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHECKOUT = process.env.SW_DSH_CHECKOUT;
export const PROFILE_DIR = process.env.SW_FIXTURE_PROFILE;
export const IMPORTER = process.env.SW_FIXTURE_IMPORTER;
export const DSH_HOME = process.env.DSH_HOME;

/** The plugin record the seal appends for each auxiliary call it consumed. */
export const INNER_CALL_RECORD_TYPE = 'plugin:session-watcher/inner-call';
/** The plugin record the monitor appends as an attempt's auxiliary request is dispatched. */
export const INNER_ATTEMPT_RECORD_TYPE = 'plugin:session-watcher/inner-attempt';
/** The plugin record the monitor appends when an attempt fails or is cancelled. */
export const INNER_END_RECORD_TYPE = 'plugin:session-watcher/inner-end';
import { INNER_QUOTE } from '../../dsh/src/inner-quote.js';

/** The counted steps at which a scenario's range is first quoted: the quote's own minimum. Whether the quote then permits the seal is the scenario's replies' business (`REPLY_PADDING`), and each seal's quote the evidence of it. */
export const SEAL_STEPS = INNER_QUOTE.minSteps;
/** The text a scenario hands `loopAdapter` as `padding`: each non-empty main reply then carries it, in a text block of its own, so a range of replies has savings the quote's C estimate and fixed fee leave positive. It stays out of the user's asks, whose directives the scenarios parse, and out of the initial prefix, which no range holds. */
export const REPLY_PADDING = ` ${'z'.repeat(24_000)}`;
/** The plain turns a scenario waits for a seal: its counted steps and headroom for the turns before the range opens. */
export const SEAL_WAIT_TURNS = SEAL_STEPS + 6;
/** The carrier's source kind. */
export const CARRIER_KIND = 'session-watcher-inner-seal';

/** The slot count a C request's tail names: the reply is the object keyed "1" to this count. */
export const SLOT_COUNT = /slot numbers "1" to "(\d+)"/;
/** The reply to a C request over `count` slots: the object keyed "1" to `count`, each value `label` and its slot number. */
export const slotNotes = (count, label = 'summary') => JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1), `${label} ${index + 1}`])));

export const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

/** The Loader path of the original `llm-pi-ai` row, the one source of the opt-in pi-ai entry's configuration. */
export const ORIGINAL_ROW = 'include:llm-pi-ai';

/**
 * The part of the Loader service the opt-in pi-ai entry reads, for the scenarios that mount it on a bare context: `resolve(path)` answers the entry `rows` holds under that path, `{ disabled, options }` where `options` carries the row's composed `config` when `rows` gives one, and throws as the real Loader does for a path it holds no entry under.
 * `rows` maps a path to `{ config, disabled }`, `disabled` true unless given. The real Loader's composition is the business of the scenarios that mount it (`dsh-pi-ai-fixture.js` `mountComposition`).
 */
export function loaderOf(rows = {}) {
  return {
    resolve(path) {
      if (!Object.hasOwn(rows, path)) throw new Error(`cannot resolve entry ${path}`);
      const { config, disabled = true } = rows[path];
      return { disabled, options: { id: path.split(':').at(-1), name: '@deepseek-ai/dsh-llm-pi-ai', ...config === undefined ? {} : { config } } };
    },
  };
}

/** The Loader service of a source row that is switched off and holds the profile dictionary `providers`. */
export const loaderWith = providers => loaderOf({ [ORIGINAL_ROW]: { config: { providers } } });
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The `credentials` service Connection keeps its browser-session record in; it resolves each reference `placeholders` names to its placeholder value.
export class RecordCredentials {
  record = undefined;
  constructor(placeholders = {}) { this.placeholders = placeholders; }
  async modifyRecord(_key, mutate) { const next = await mutate(this.record); if (next !== undefined) this.record = next; return this.record; }
  async resolve(ref) { return Object.hasOwn(this.placeholders, ref) ? { value: this.placeholders[ref] } : undefined; }
}

// The authenticated channel of the real Connection on `ctx`: its authority, the session cookie and `call(endpoint, payload)`, which answers the endpoint's result.
export function channelOn(ctx) {
  const authority = `127.0.0.1:${ctx.webServer.port}`;
  const login = new URL(ctx.connection.authenticatedUrl(`http://${authority}`));
  let cookie;
  ctx.connection.authorizeIndex(
    { headers: { host: authority }, method: 'GET', url: `${login.pathname}${login.search}` },
    { writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0]; }, end() {} },
  );
  assert.ok(cookie, 'the token exchange set no cookie');
  let rpcSeq = 0;
  const call = async (endpoint, payload) => {
    const rpcId = `shipped-${++rpcSeq}`;
    const response = await fetch(`http://${authority}/session-watcher/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `POST ${endpoint} answered ${response.status}: ${body}`);
    return JSON.parse(body).result;
  };

  return { authority, cookie, call };
}

/**
 * The events route of the real Connection at `authority`, read as the session ids it writes: `quiet(ms)` waits `ms` and answers those written since its last call, `close()` ends the stream.
 * Only the data frames count; the comment frame that opens the stream is read and dropped.
 */
export async function eventsOn({ authority, cookie }) {
  const stream = await fetch(`http://${authority}/api/session-watcher.events`, { headers: { cookie } });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const frames = [];
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      for (let end = buffered.indexOf('\n\n'); end !== -1; end = buffered.indexOf('\n\n')) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice('data: '.length)).sessionId);
      }
    }
  })();
  pump.catch(() => {});
  return {
    quiet: async (ms = 250) => {
      await sleep(ms);
      return frames.splice(0);
    },
    close: () => reader.cancel().catch(() => {}),
  };
}

// One text block at `index`.
function* textBlock(index, text) {
  yield { type: 'block-start', index, blockType: 'text' };
  yield { type: 'text-delta', index, text };
  yield { type: 'block-end', index, block: { type: 'text', text } };
}

// One text block, a second one of `padding` after a text that is not empty, the usage and a stop.
function* textChunks(text, usage, padding) {
  yield* textBlock(0, text);
  if (padding !== undefined && text !== '') yield* textBlock(1, padding);
  yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/**
 * An adapter registered on the real llm service. A request's `purpose` tells it apart: the seal's auxiliary call (`inner-compaction`) answers `summary(count, options)` chunks, `count` the slot count its tail names; a stock compaction summary (`compaction`) answers `stockSummary`; every other request is a main request of its session, n counting them, and answers `reply(n, options)`: a text, `{ toolCalls }` (each `{ id, name, arguments }`, finishing with tool calls) or `{ chunks }`.
 * A model resolves under `modelNames[model] ?? model` as its name, and a resolve called with no signal, a name lookup as the host makes it, stays pending until the promise `nameLookupGate` when given; `lookups` records each resolve in order with whether it carried a signal. A model resolves with `contextWindows[model] ?? contextWindow` as its window when one is given, with `reasoningEfforts` as the efforts it accepts (without it a request naming an effort is refused), and with `toolUpdate` as the route's tool update mode: without it the llm service strips the tool-registry messages from what the adapter receives. Every request is recorded with its kind, session, purpose, route and messages.
 * With `padding`, a text or a function of `reply`'s arguments answering a text or undefined, a main reply that is a non-empty text carries what it names as a second text block, and one that is `{ toolCalls }` as a text block ahead of its calls, which keep their ids, names and arguments; `{ chunks }` replies, the auxiliary call's summary and the stock summary are answered as they are, so an empty step stays empty.
 */
export function loopAdapter(LlmAdapter, {
  summary, reply = n => `reply ${n}`, usage = { inputTokens: 1000, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  contextWindow, contextWindows = {}, stockSummary = 'The stock summary of the earlier conversation.', toolUpdate, padding, reasoningEfforts,
  modelNames = {}, nameLookupGate,
}) {
  class LoopAdapter extends LlmAdapter {
    requests = [];
    lookups = [];

    resolveModel(provider, model, signal) {
      const window = contextWindows[model] ?? contextWindow;
      this.lookups.push({ model, signalled: signal !== undefined });
      const info = { provider, id: model, name: modelNames[model] ?? model, ...(window === undefined ? {} : { context: { contextWindow: window } }), ...(toolUpdate === undefined ? {} : { toolUpdate }),
        ...(reasoningEfforts === undefined ? {} : { reasoning: { efforts: reasoningEfforts.map(id => ({ id, name: id })) } }) };
      // The loop's own preparation hands the adapter its signal and a plain name lookup does not: `nameLookupGate` holds the lookups alone.
      return signal === undefined && nameLookupGate !== undefined ? nameLookupGate.then(() => info) : Promise.resolve(info);
    }

    async* stream(options) {
      const kind = options.purpose === 'inner-compaction' ? 'summary' : options.purpose === 'compaction' ? 'stock' : 'main';
      this.requests.push({
        kind, summary: kind === 'summary', sessionId: options.sessionId, purpose: options.purpose,
        provider: options.provider, model: options.model, messages: options.messages,
      });
      if (kind === 'summary') {
        const tail = options.messages.at(-1)?.content?.[0]?.text ?? '';
        yield* summary(Number(SLOT_COUNT.exec(tail)?.[1]), options);
        return;
      }
      if (kind === 'stock') {
        yield* textChunks(stockSummary, usage);
        return;
      }
      const n = this.requests.filter(request => request.kind === 'main' && request.sessionId === options.sessionId).length;
      const answer = reply(n, options);
      const pad = typeof padding === 'function' ? padding(n, options) : padding;
      if (typeof answer === 'string') {
        yield* textChunks(answer, usage, pad);
      } else if (answer.toolCalls !== undefined) {
        const lead = pad === undefined ? 0 : 1;
        if (lead === 1) yield* textBlock(0, pad);
        for (const [position, { id, name, arguments: args }] of answer.toolCalls.entries()) {
          const index = position + lead;
          yield { type: 'block-start', index, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args };
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } };
        }
        yield { type: 'usage', usage };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield* answer.chunks;
      }
    }
  }
  return new LoopAdapter();
}

/**
 * The shipped entry over the real loop: the profile's runtime resolution loads the built entry, mounted beside the real session store, projection registry, agent registry, agent loop, local fs (cwd the fixture's `TMPDIR`) and working directory, tool runtime, token meter, local attachment store under the fixture's `DSH_HOME`, session-query engine, Connection and WebServer, and an adapter of `loopAdapter` on the `mock` route.
 * With `subagents`, the real subagent runtime and its in-process `spawn` and `fork` providers mount before the entry.
 * With `commands`, the real command runtime mounts before the entry, which registers `/sw-continue` and `/sw-load` on it.
 * With `tools`, the real `tool-fs` (read, edit, write; `read_image` beside the attachment store) and the fs observation policy mount before the entry. With `skills`, the real skill registry, which the entry registers its bundled skills on, and the `skill` tool do; without it `skills` is a double that registers nothing. With `persistence` or `stock`, the JSONL persistence under the fixture's `DSH_HOME` does. With `stock`, the stock consumers of `agent/pre-step` mount before the entry too: `compaction-basic` under `stock.compaction` and the session checkpoint policy.
 * With `todo`, the real `tool-todo` mounts before the entry: its `todos` unit stands on the projection registry the entry's inner child reads and its `todo_write` tool on the tool runtime. With `directoryTool`, the real `tool-working-directory` does, its `working_directory` tool on the tool runtime beside the working directory service the loop mounts.
 * With `contexts`, the real `agent-instructions` and `time-context` mount before the entry: the first request of a session then carries the workspace instructions and the time reading admitted ahead of it, beside the skill catalog `skills` publishes.
 * With `piAi`, the checkout's `llm-pi-ai` adapter under `piAi.config`, or with `piAi.replacement` the built opt-in pi-ai entry of this package over the Loader service `piAi.loader` (`loaderOf`), mounts before the entry, and the credentials double resolves `piAi.placeholders`; with `sessionTools`, the model-facing `tool-session-query` does.
 * `settings` is the entry's configuration as the Loader would hand it, the fields the user saved (none by default, so the Config's own defaults stand).
 * With `events`, the events route is opened on the context once the entry is mounted and its reader answered as `events` (`eventsOn`).
 * Answers the context, the channel's `call`, the adapter, the harness that creates agents, the llm package and, with `events`, the events reader.
 */
export async function mountShippedLoop({ stock, tools = false, skills = false, contexts = false, persistence = false, commands = false, subagents = false, todo = false, directoryTool = false, piAi, sessionTools = false, events = false, settings = {}, ...script }) {
  const [
    { Context }, connectionPlugin, { WebServer }, appBoot, testkit, fsLocal, tokenMeter, llm, attachmentLocal, sessionQuery,
  ] = await Promise.all([
    'vendor/cordis/lib/index.js',
    'packages/client/connection/lib/index.js',
    'packages/host/webserver/lib/index.js',
    'packages/boot/app-boot/lib/index.js',
    'packages/test-support/agent-loop-testkit/lib/index.js',
    'packages/fs/fs-local/lib/index.js',
    'packages/llm/token-meter/lib/index.js',
    'packages/llm/llm/lib/index.js',
    'packages/attachment/attachment-local/lib/index.js',
    'packages/session-query/session-query/lib/index.js',
  ].map(fromCheckout));
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = appBoot;
  const installAnchor = join(CHECKOUT, 'apps/cli/package.json');
  const profile = loadProfileDirectory('sw-shipped-fixture', PROFILE_DIR, installAnchor, { userLayer: false });
  const resolution = await createRuntimeResolution({ installAnchor, profile, home: DSH_HOME });
  const ctx = new Context();
  await ctx.plugin(PluginPackages, { resolution });
  const { loadEntry } = await import(pathToFileURL(IMPORTER).href);
  const entry = await loadEntry();

  ctx.provide('credentials', new RecordCredentials(piAi?.placeholders));
  await ctx.plugin(fsLocal.default, { cwd: process.env.TMPDIR });
  await testkit.mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(tokenMeter.default);
  await ctx.plugin(attachmentLocal.default);
  await ctx.plugin(sessionQuery.default);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(connectionPlugin);
  if (skills) {
    const [skillRegistry, toolSkill] = await Promise.all([
      'packages/skill/skill/lib/index.js',
      'packages/skill/tool-skill/lib/index.js',
    ].map(fromCheckout));
    await ctx.plugin(skillRegistry.default);
    await ctx.plugin(toolSkill);
  } else {
    ctx.provide('skills', { register() { return () => {}; } });
  }
  if (contexts) {
    const [instructions, timeContext] = await Promise.all([
      'packages/context/agent-instructions/lib/index.js',
      'packages/context/time-context/lib/index.js',
    ].map(fromCheckout));
    await ctx.plugin(instructions, { maxBytes: 20_000 });
    await ctx.plugin(timeContext, { timeZone: 'UTC' });
  }
  const adapter = loopAdapter(llm.LlmAdapter, script);
  ctx.llm.registerAdapter(['mock'], adapter);
  if (piAi !== undefined) {
    // `piAi.replacement` mounts the built opt-in pi-ai entry of this package, which the profile's runtime resolution loads, in place of the checkout's adapter.
    // The entry reads its configuration from the Loader's original row, `piAi.loader` here, and takes none of its own.
    const adapterModule = piAi.replacement ? await (await import(pathToFileURL(IMPORTER).href)).loadPiAiEntry() : await fromCheckout('packages/llm/llm-pi-ai/lib/index.js');
    if (piAi.replacement) ctx.provide('loader', piAi.loader);
    await ctx.plugin(adapterModule, piAi.replacement ? undefined : piAi.config);
  }
  if (sessionTools) await ctx.plugin(await fromCheckout('packages/experimental/tool-session-query/lib/index.js'));
  if (tools) {
    const [toolFs, observation] = await Promise.all([
      'packages/fs/tool-fs/lib/index.js',
      'packages/fs/fs-observation-policy/lib/index.js',
    ].map(fromCheckout));
    await ctx.plugin(observation);
    await ctx.plugin(toolFs);
  }
  if (todo) await ctx.plugin(await fromCheckout('packages/todo/tool-todo/lib/index.js'), { allowParallelInProgress: true });
  if (directoryTool) await ctx.plugin(await fromCheckout('packages/session/tool-working-directory/lib/index.js'));
  if (persistence || stock !== undefined) {
    const jsonl = await fromCheckout('packages/session/session-persistence-jsonl/lib/index.js');
    await ctx.plugin(jsonl, { root: join(DSH_HOME, 'sessions') });
  }
  if (subagents) {
    const [runtime, spawn, fork] = await Promise.all([
      'packages/subagent/subagent/lib/index.js',
      'packages/subagent/subagent-spawn-in-process/lib/index.js',
      'packages/subagent/subagent-fork-in-process/lib/index.js',
    ].map(fromCheckout));
    await ctx.plugin(runtime.default);
    await ctx.plugin(spawn, { providerName: 'spawn' });
    await ctx.plugin(fork, { providerName: 'fork' });
  }
  if (commands) {
    const runtime = await fromCheckout('packages/interaction/commands/lib/index.js');
    await ctx.plugin(runtime.default);
  }
  if (stock !== undefined) {
    const [compactionBasic, checkpointPolicy] = await Promise.all([
      'packages/compaction/compaction-basic/lib/index.js',
      'packages/session/session-checkpoint-policy/lib/index.js',
    ].map(fromCheckout));
    await ctx.plugin(compactionBasic.default, stock.compaction);
    await ctx.plugin(checkpointPolicy);
  }
  await ctx.plugin({ name: entry.name, inject: entry.inject, Config: entry.Config, apply: entry.apply }, settings);
  const harness = await testkit.mountAgentLoopTestHarness(ctx);
  await sleep(50);
  const channel = channelOn(ctx);
  return { ctx, call: channel.call, adapter, harness, llm, ...(events ? { events: await eventsOn(channel) } : {}) };
}

// One user turn of `agent` through the real loop, awaited until the agent is idle.
export async function turnOf(agent, llm, text) {
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
}
