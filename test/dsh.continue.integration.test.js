// `clearSurface` and the `/sw-continue` command against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: the session store, the invariant registry with the compaction invariant, the projection registry, the token meter and the command runtime, mounted standalone. The fake session of `test/dsh.continue.test.js` cannot refuse a transaction DSH refuses or price a replacement as the meter does; this file can. Without the checkout every case skips.
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
    { Context }, { SessionStore }, { default: InvariantRegistry }, compactionInvariant, { default: SessionProjectionRegistry },
    { TokenMeter }, llm, compaction, commandsPkg,
  ] = await Promise.all([
    CORDIS,
    'packages/core/session/lib/index.js',
    'packages/runtime-diagnostics/invariants/lib/index.js',
    'packages/compaction/compaction/lib/invariant.js',
    'packages/session/session-projection/lib/index.js',
    'packages/llm/token-meter/lib/index.js',
    'packages/llm/llm/lib/index.js',
    'packages/compaction/compaction/lib/index.js',
    'packages/interaction/commands/lib/index.js',
  ].map(fromCheckout));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore);
  await ctx.plugin(InvariantRegistry);
  await ctx.plugin(compactionInvariant);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(TokenMeter);
  const kit = {
    CompactionId: compaction.CompactionId,
    compactCheckpointSource: compaction.compactCheckpointSource,
    createUserMessage: llm.createUserMessage,
  };
  return { ctx, kit, llm, commandsPkg };
}

// Two closed turns behind a system head: the first holds a tool call paired with its result, so the range the clear shadows crosses a pair whole.
function converse(session, { llm }) {
  const text = body => [{ type: 'text', text: body }];
  const assistant = (turn, step, content) => session.append('assistant/message', {
    stream: [], turn, step,
    message: llm.createAssistantMessage({ content, source: { provider: ROUTE, model: ROUTE } }),
  }, { surfaceOp: 'append' });
  const callId = llm.ToolCallId('call-1');

  session.append('turn/start', { turn: 1 });
  session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('You are a coding agent.') }, { surfaceOp: 'append' });
  session.append('user/message', llm.createUserMessage({ content: text(`${FILLER} first request`), source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
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

test('a session with an open turn refuses the start and the clear leaves it as it was', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  session.append('turn/start', { turn: 3 });
  const logged = session.seq;

  assert.throws(() => clear(ctx, kit, session), (error) => {
    assert.ok(error instanceof ClearError);
    assert.equal(error.code, 'start');
    assert.match(error.cause.message, /compaction\/start is standalone but turn 3 is open/);
    return true;
  });
  assert.equal(session.seq, logged);
});

test('control: the invariant refuses a checkpoint with no compaction start', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  const [, ...range] = session.surface.nodes;

  assert.throws(() => session.append('user/message', kit.createUserMessage({
    content: [{ type: 'text', text: 'checkpoint' }], source: kit.compactCheckpointSource(kit.CompactionId('orphan'), COMMAND_ID),
  }), {
    surfaceOp: { op: 'replace', startSeq: range[0], endSeq: range.at(-1) }, sourceEventSeqs: range,
  }), /compaction checkpoint has no matching compaction\/start/);
});

test('control: the invariant refuses a successful compaction end with no summary', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  const compactionId = kit.CompactionId('unsummarized');
  session.append('compaction/start', { compactionId, sourceCommandId: COMMAND_ID, turn: null });

  assert.throws(
    () => session.append('compaction/end', { compactionId, sourceCommandId: COMMAND_ID, turn: null }),
    /successful compaction\/end requires one compaction\/summary/,
  );
});

const thrownBy = (run) => {
  try { run(); } catch (error) { return error; }
  return assert.fail('the call did not throw');
};

// A failure after `compaction/start` that DSH itself raises: the meter leaves a node of the range out, so the summary lists a span it does not cover and the compaction invariant refuses it.
test('a summary the invariant refuses closes the compaction with an error end, and the next clear of the session succeeds', { skip }, async (t) => {
  const dsh = await mountDsh(t);
  const { ctx, kit } = dsh;
  const session = ctx.sessions.create();
  converse(session, dsh);
  const nodes = [...session.surface.nodes];
  const omitting = {
    measure(each) {
      const measured = ctx.tokenMeter.measure(each);
      return { ...measured, nodes: measured.nodes.filter((_, index) => index !== 2) };
    },
  };

  const failure = thrownBy(() => clearSurface({ session, meter: omitting, kit, commandId: COMMAND_ID, token: TOKEN }));

  assert.ok(failure instanceof ClearError);
  assert.equal(failure.code, 'commit');
  const log = session.snapshotEvents();
  assert.deepEqual(log.slice(-2).map(event => event.type), ['compaction/start', 'compaction/end']);
  assert.equal(log.at(-1).data.error, failure.cause.message);
  assert.equal(log.at(-1).data.compactionId, log.at(-2).data.compactionId);
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
