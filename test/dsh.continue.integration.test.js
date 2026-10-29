// `clearSurface` and the `/sw-continue` command against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: the session store, the projection registry, the token meter and the command runtime, mounted standalone, and the JSONL persistence for the one control that reloads the cleared session. The fake session of `test/dsh.continue.test.js` cannot refuse a transaction DSH refuses or price a replacement as the meter does; this file can. Without the checkout every case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { clearSurface, createContinueCommand, ClearError } from '../dsh/src/continue.js';
import { openStore, closeStore } from '../lib/store.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const CORDIS = 'vendor/cordis/lib/index.js';

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : !existsSync(join(CHECKOUT, CORDIS)) ? `SW_DSH_CHECKOUT names no ${CORDIS}`
  : false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);

const COMMAND_ID = 'command-integration';
const TOKEN = 'sw-handoff-token';
const SEGMENT = 0;
const ROUTE = 'test-route';
const FILLER = 'fixture '.repeat(60).trim();

// Every service the transaction touches, mounted on one context, and the DSH values to build events with; the context is disposed when the case ends.
async function mountDsh(t) {
  const [
    { Context }, { SessionStore }, { default: SessionProjectionRegistry },
    { TokenMeter }, llm, compaction, commandsPkg,
  ] = await Promise.all([
    CORDIS,
    'packages/core/session/lib/index.js',
    'packages/session/session-projection/lib/index.js',
    'packages/llm/token-meter/lib/index.js',
    'packages/llm/llm/lib/index.js',
    'packages/compaction/compaction/lib/index.js',
    'packages/interaction/commands/lib/index.js',
  ].map(fromCheckout));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(TokenMeter);
  const kit = {
    CompactionId: compaction.CompactionId,
    compactCheckpointSource: compaction.compactCheckpointSource,
    createUserMessage: llm.createUserMessage,
  };
  return { ctx, kit, llm, commandsPkg };
}

// Two closed turns behind a system head: the first holds a tool call paired with its result, so the range the clear shadows crosses a pair whole, and it opens its step before the system message, which the loader refuses outside an open step.
function converse(session, { llm }) {
  const text = body => [{ type: 'text', text: body }];
  const assistant = (turn, step, content) => session.append('assistant/message', {
    stream: [], turn, step,
    message: llm.createAssistantMessage({ content, source: { provider: ROUTE, model: ROUTE } }),
  }, { surfaceOp: 'append' });
  const callId = llm.ToolCallId('call-1');

  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('You are a coding agent.') }, { surfaceOp: 'append' });
  session.append('user/message', llm.createUserMessage({ content: text(`${FILLER} first request`), source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: ROUTE, model: ROUTE } }, reason: 'initial' });
  assistant(1, 1, [...text(`${FILLER} reading`), { type: 'tool-call', id: callId, name: 'read', arguments: '{}' }]);
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' });
  session.append('tool/result', {
    turn: 1, step: 1, message: llm.createToolResultMessage({ callId, content: text(`${FILLER} file body`), isError: false }),
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 2 });
  assistant(1, 2, text(`${FILLER} first answer`));
  session.append('step/end', { turn: 1, step: 2 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

  session.append('turn/start', { turn: 2 });
  session.append('user/message', llm.createUserMessage({ content: text(`${FILLER} second request`), source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 2, step: 1 });
  assistant(2, 1, text(`${FILLER} second answer`));
  session.append('step/end', { turn: 2, step: 1 });
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
}

const clear = (ctx, kit, session) => clearSurface({ session, meter: ctx.tokenMeter, kit, commandId: COMMAND_ID, token: TOKEN });

// What the meter and the projection registry each say the surface costs; they are two prices of one surface, kept in agreement by the shadow-price protocol.
const surfaceTokens = (ctx, session) => ({
  measured: ctx.tokenMeter.measure(session).surfaceTokens,
  projected: ctx.sessionProjections.stateOf(session, 'contextPressure').surfaceTokens,
});

test('the clear leaves the head and one checkpoint, which the token meter and the projection price alike', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  const head = session.surface.nodes[0];
  const before = ctx.tokenMeter.measure(session);
  const generation = session.surface.replaceGeneration;
  assert.equal(session.eventAt(head).type, 'system/message');
  assert.equal(before.nodes.length > 3, true, 'the fixture holds a range to shadow');
  assert.deepEqual(surfaceTokens(ctx, session), { measured: before.surfaceTokens, projected: before.surfaceTokens });

  const result = clear(ctx, kit, session);

  const nodes = session.surface.nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0], head);
  const checkpoint = session.eventAt(nodes[1]);
  assert.equal(checkpoint.type, 'user/message');
  assert.equal(checkpoint.data.source.kind, 'compact-checkpoint');
  assert.equal(result.count, before.nodes.length - 1);
  assert.equal(session.surface.replaceGeneration, generation + 1);

  const after = ctx.tokenMeter.measure(session);
  assert.deepEqual(after.nodes.map(node => node.seq), nodes);
  assert.ok(after.totalTokens < before.totalTokens, `the total fell from ${before.totalTokens} to ${after.totalTokens}`);
  assert.ok(after.surfaceTokens < before.surfaceTokens);
  assert.deepEqual(surfaceTokens(ctx, session), { measured: after.surfaceTokens, projected: after.surfaceTokens });
});

test('the transaction is closed, so a second clear shadows the first checkpoint and the two prices still agree', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  clear(ctx, kit, session);
  const [head, first] = session.surface.nodes;

  const result = clear(ctx, kit, session);

  assert.equal(result.count, 1);
  const nodes = session.surface.nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0], head);
  assert.notEqual(nodes[1], first);
  const { measured, projected } = surfaceTokens(ctx, session);
  assert.equal(projected, measured);
});

test('a surface holding only its head is left as it is', { skip }, async (t) => {
  const { ctx, kit, llm } = await mountDsh(t);
  const session = ctx.sessions.create();
  session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('You are a coding agent.') }, { surfaceOp: 'append' });
  const logged = session.seq;

  assert.equal(clear(ctx, kit, session), null);
  assert.equal(session.seq, logged);
});

// DSH validates the lifecycle order when a session log is opened, so the reload is the real-layer proof that the transaction's order conforms.
test('control: the loader accepts the cleared session', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const jsonl = await fromCheckout('packages/session/session-persistence-jsonl/lib/index.js');
  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-loader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await ctx.plugin(jsonl, { root: directory });
  const session = ctx.sessions.create();
  converse(session, dsh);
  assert.ok(clear(ctx, kit, session), 'the fixture holds a range to clear');
  const live = session.snapshotEvents().map(event => event.type);

  const writer = await ctx.sessionPersistence.create(session.header);
  await writer.append(session.snapshotEvents());
  await writer.close();
  const reader = await ctx.sessionPersistence.open(session.id, 'read');
  try {
    const { events } = await reader.read();
    assert.deepEqual(events.map(event => event.type), live);
  } finally {
    await reader.close();
  }
});

const thrownBy = (run) => {
  try { run(); } catch (error) { return error; }
  return assert.fail('the call did not throw');
};

// A failure after `compaction/start` that DSH itself raises. The meter is hand-written, as the real one prices every surface node, and drops an interior node of the range: an endpoint would narrow the range, and the clear would succeed. The summary then keeps the range's endpoints and lists one node fewer, which the append accepts; the replacement, the third append, is refused, as its `sourceEventSeqs` leave that node uncited. The log is neither persisted nor reopened: the loader refuses that summary's span, so the case pins no recoverability of the stored session.
test('a replacement the surface refuses closes the compaction with an error end, and the next clear of the session succeeds', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  const nodes = [...session.surface.nodes];
  const dropped = nodes[2];
  const omitting = {
    measure(each) {
      const measured = ctx.tokenMeter.measure(each);
      return { ...measured, nodes: measured.nodes.filter(node => node.seq !== dropped) };
    },
  };

  const failure = thrownBy(() => clearSurface({ session, meter: omitting, kit, commandId: COMMAND_ID, token: TOKEN }));

  assert.ok(failure instanceof ClearError);
  assert.equal(failure.code, 'commit');
  assert.match(failure.cause.message, new RegExp(`must include every shadowed surface node; missing ${dropped}$`));
  const [start, summary, end] = session.snapshotEvents().slice(-3);
  assert.deepEqual([start, summary, end].map(event => event.type), ['compaction/start', 'compaction/summary', 'compaction/end']);
  assert.equal(end.data.error, failure.cause.message);
  assert.equal(end.data.compactionId, start.data.compactionId);
  assert.deepEqual(session.surface.nodes, nodes, 'the surface is as it was');

  const result = clear(ctx, kit, session);
  assert.equal(result.count, nodes.length - 1);
  assert.equal(session.surface.nodes.length, 2);
});

// The command registered the way the host registers it, on a plugin the case can dispose, over the real command runtime and the real session. The watcher table and the agent are the two stubs the command reads: a live watcher at `SEGMENT`, and an agent whose maintenance runs the task at once and whose wake is recorded. The handoff row is the real store's.
async function mountCommand(t, dsh) {
  const { ctx, kit, commandsPkg } = dsh;
  await ctx.plugin(commandsPkg.CommandRuntime);
  const directory = mkdtempSync(join(tmpdir(), 'sw-dsh-continue-'));
  const store = openStore(join(directory, 'store.sqlite'));
  t.after(() => {
    closeStore(store);
    rmSync(directory, { recursive: true, force: true });
  });
  const session = ctx.sessions.create();
  converse(session, dsh);
  store.insertHandoff({
    sessionId: session.id, segment: SEGMENT, loadToken: TOKEN, createdAt: 1000, pathsToKeep: '[]', summary: 'summary', summaryTokens: 10,
  });
  const woken = [];
  const agent = {
    session,
    runMaintenance: task => task(new AbortController().signal),
    followup: (message) => { woken.push(message); },
  };
  const table = { waitLive: async () => ({ state: 'live', watcher: { getStatus: () => ({ segment: SEGMENT }) } }) };
  const plugin = ctx.plugin({
    name: 'continue-under-test',
    apply(root) {
      root.inject(['commands', 'tokenMeter'], (child) => {
        child.commands.register(createContinueCommand({
          table, store, kit, meter: child.tokenMeter, flush: each => ctx.sessions.flush(each),
        }));
      });
    },
  });
  await plugin;
  return { session, agent, woken, plugin };
}

const execute = (ctx, agent) => ctx.commands.execute(agent, '/sw-continue', [], new AbortController().signal);

test('the registered command clears the session under the real command runtime, which logs the run and the completion around the four transaction events', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx } = dsh;
  const { session, agent, woken } = await mountCommand(t, dsh);
  const measured = ctx.tokenMeter.measure(session).nodes.slice(1);
  const logged = session.seq;

  const execution = await execute(ctx, agent);

  const text = `Cleared ${measured.length} history items (~${measured.reduce((total, node) => total + node.heuristicTokens, 0)} tokens); loading handoff ${TOKEN}.`;
  assert.deepEqual(execution.result, { kind: 'success', text });
  const added = session.snapshotEvents().slice(logged);
  assert.deepEqual(added.map(event => event.type), [
    'command/run', 'compaction/start', 'compaction/summary', 'user/message', 'compaction/end', 'command/done',
  ]);
  const [run, start, summary, replacement, end, done] = added;
  const { commandId } = execution;
  assert.equal(run.data.commandId, commandId);
  assert.equal(run.data.name, 'sw-continue');
  assert.equal(done.data.commandId, commandId);
  assert.deepEqual([done.data.kind, done.data.text], ['success', text]);
  assert.deepEqual([start, summary, end].map(event => event.data.sourceCommandId), [commandId, commandId, commandId]);
  assert.equal(replacement.data.source.sourceCommandId, commandId);
  assert.equal(replacement.data.source.compactionId, start.data.compactionId);

  assert.equal(woken.length, 1);
  assert.deepEqual(woken[0].content, [{ type: 'text', text: `Continue from handoff ${TOKEN}: load it with the sw-load skill.` }]);
  assert.deepEqual(woken[0].source, { kind: 'user' });
});

test('after the plugin is disposed the command runtime does not know the command and a call appends nothing', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx } = dsh;
  const { session, agent, woken, plugin } = await mountCommand(t, dsh);

  await plugin.dispose();
  const logged = session.seq;

  assert.equal(await execute(ctx, agent), undefined);
  assert.equal(session.seq, logged);
  assert.deepEqual(woken, []);
});
