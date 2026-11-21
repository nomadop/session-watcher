// test/helpers/dsh-inner-seal-stage-points-child.js — which usages of a real session stand after its inner seals, put against the usages the shipped host's watcher keeps; run in a fresh Node process by `test/dsh.inner-seal.integration.test.js`.
// The shipped host entry runs over the real DSH loop (`dsh-shipped-loop.js`), whose admission, request freeze, settlement and seal produce every event. The fixture answers each main request with a usage of its own, which names it in the history; the oracle (`dsh-selection-oracle.js`) reads the log's events, the carriers' positions and the range each seal's own record names, never an observation or the watcher.
// The process starts with `HOME`, `DSH_HOME` and `TMPDIR` inside the fixture the parent made. A scenario that fails an assertion exits non-zero with it on stderr; what it writes to stdout is the evidence the case reports.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { INNER_QUOTE } from '../../lib/inner-seal/quote.js';
import { standingUsages } from './dsh-selection-oracle.js';
import { CARRIER_KIND, INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, mountShippedLoop, REPLY_PADDING, SEAL_STEPS, slotNotes, turnOf } from './dsh-shipped-loop.js';

const [scenario] = process.argv.slice(2);
const ROOT = realpathSync(process.env.TMPDIR);

const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => { stderrLines.push(args.map(String).join(' ')); realConsoleError(...args); };

const lines = (label, count) => Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`);
const textOf = rows => `${rows.join('\n')}\n`;
const FILES = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
// The time context's default refresh interval is ten minutes; a clock moved by this much has passed it.
const PAST_TIME_REFRESH_MS = 11 * 60_000;
// The plain turns a scenario runs while it waits for its last seals: room for three ranges of `SEAL_STEPS` steps beyond the long first turn.
const PLAIN_TURN_LIMIT = SEAL_STEPS * 3 + 16;
const isCarrierEvent = event => event?.type === 'user/message' && event.data?.source?.kind === CARRIER_KIND;
const splitOfUsage = usage => `${usage.cacheReadTokens}/${usage.cacheWriteTokens}`;

// A summary that answers each slot with its index, its usage carrying all three of DSH's exclusive input fields.
async function* summary(count) {
  const text = slotNotes(count, 'summary of slot');
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

// ── The fixture model ───────────────────────────────────────────────────────
// The model's answer to each main request of a session follows the session's script: `chain` tool calls in a row, then a text answer, with `afterSeal` the answers to the first request after each seal in turn, `tool`, `text`, `empty` or `max`. Every answer reports a usage of its own, which names its request.
//   tool  — one `read` call, finishing with tool calls, a text block of `REPLY_PADDING` ahead of it
//   text  — a text answer, `REPLY_PADDING` after it
//   empty — no content block, a stop
//   max   — a tool call the output ceiling cuts, so the assistant message the loop settles holds no block
// The padded answers are what make a range of `SEAL_STEPS` steps worth sealing to the quote: the savings stand over the C estimate and the fee, so each seal falls at the count that the scripts place their changes by.
function modelOf(dir) {
  const scripts = new Map();
  const issued = [];
  const script = sessionId => {
    if (!scripts.has(sessionId)) scripts.set(sessionId, { chain: 0, afterSeal: [], carriers: 0, calls: 0 });
    return scripts.get(sessionId);
  };
  const usageFor = (options) => {
    const n = issued.length + 1;
    const usage = { inputTokens: 1, outputTokens: 40, cacheReadTokens: 20_000 + 11 * n, cacheWriteTokens: 500 + n };
    // The ids of the messages the request carries, taken as the loop froze them at dispatch: evidence of what a request did not carry.
    issued.push({ sessionId: options.sessionId, split: splitOfUsage(usage), ids: new Set(options.messages.map(message => message.id)) });
    return usage;
  };
  const textBlock = (index, text) => [
    { type: 'block-start', index, blockType: 'text' },
    { type: 'text-delta', index, text },
    { type: 'block-end', index, block: { type: 'text', text } },
  ];
  // A call of `read`, behind the padding text where `padded`.
  const toolChunks = (usage, finish, id, path, padded) => {
    const args = JSON.stringify({ file_path: path });
    const index = padded ? 1 : 0;
    return [
      ...(padded ? textBlock(0, REPLY_PADDING) : []),
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: 'read', argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: 'read', arguments: args } },
      { type: 'usage', usage },
      { type: 'finish', reason: finish },
    ];
  };
  const textChunks = (usage, text) => [
    ...textBlock(0, text),
    ...textBlock(1, REPLY_PADDING),
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  return {
    script,
    issued,
    reply(_n, options) {
      const state = script(options.sessionId);
      const usage = usageFor(options);
      state.calls += 1;
      const carriers = options.messages.filter(message => message.source?.kind === CARRIER_KIND).length;
      let kind;
      if (carriers > state.carriers && state.afterSeal.length > 0) kind = state.afterSeal.shift();
      else kind = state.chain > 0 ? 'tool' : 'text';
      state.carriers = carriers;
      if (kind === 'tool') state.chain = Math.max(0, state.chain - 1);
      const path = join(dir, FILES[state.calls % FILES.length]);
      const id = `call-${issued.length}`;
      switch (kind) {
        case 'tool': return { chunks: toolChunks(usage, { kind: 'tool-calls' }, id, path, true) };
        case 'max': return { chunks: toolChunks(usage, { kind: 'max-tokens' }, id, path, false) };
        case 'empty': return { chunks: [{ type: 'usage', usage }, { type: 'finish', reason: { kind: 'stop' } }] };
        default: return { chunks: textChunks(usage, `answer ${issued.length}`) };
      }
    },
  };
}

// The node a range opens with, as the evidence names it.
const nodeName = head => (head.type === 'assistant/message'
  ? (head.data.message.content.length === 0 ? 'empty assistant' : 'assistant')
  : `${head.type}:${head.data?.source?.kind ?? head.data?.message?.source?.kind ?? ''}`);

// ── The oracle against the host ─────────────────────────────────────────────

// The ranges each seal's own record names, checked to be what the native surface dropped, the carriers' positions, and the quote of the attempt each record names: the seal is the quote's permission, so its savings stand over the C estimate and the fee and its arm is the one the decision names, at a count from the minimum on.
function sealsOf(session) {
  const events = session.snapshotEvents();
  return events.filter(isCarrierEvent).map((carrier) => {
    const record = events[carrier.sourceEventSeqs[0]];
    assert.equal(record.type, INNER_CALL_RECORD_TYPE, 'the carrier cites its call record first');
    const { range } = record.data;
    assert.ok(session.surface.nodes.includes(carrier.seq), 'the carrier is on the surface');
    assert.ok(range.every(seq => !session.surface.nodes.includes(seq)), 'the surface holds no node of the range the record names');
    const attempt = events[record.data.attempt];
    assert.equal(attempt.type, INNER_ATTEMPT_RECORD_TYPE, 'the call record names the attempt record');
    const { quote } = attempt.data;
    assert.ok(quote.trigger === 'quote' && quote.sEst > 0 && (quote.arm === 'right' || quote.q < quote.kappa) && quote.n >= INNER_QUOTE.minSteps, `the quote permits the seal: ${JSON.stringify(quote)}`);
    return { carrier, range, head: events[range[0]], quote };
  });
}

// What the oracle says stands, against what the host's watcher reports in its history, in measured order.
async function qualify({ session, call, model, label }) {
  const events = session.snapshotEvents();
  const seals = sealsOf(session);
  const mine = model.issued.filter(request => request.sessionId === session.id);
  assert.equal(new Set(mine.map(request => request.split)).size, mine.length, 'every main request reported a usage of its own');
  const history = (await call('history', { sessionId: session.id })).value.payload;
  const actual = history.map(point => `${point.cacheRead}/${point.cacheCreation}`);
  const expected = standingUsages({ events, carriers: seals.map(({ carrier }) => carrier.seq), ranges: seals.map(({ range }) => range) })
    .map(seq => splitOfUsage(events[seq].data.usage));
  // The sufficient conditions first, so that a counterexample is named as one: the call right behind each carrier is a point of the history whatever opens its range, and so is the epoch's first call.
  const kept = new Set(actual);
  const posts = seals.map(({ carrier }) => {
    const post = events.find(event => event.type === 'assistant/message' && event.seq > carrier.seq);
    return { seq: post?.seq ?? null, usage: post?.data.usage !== undefined, stands: post?.data.usage !== undefined && kept.has(splitOfUsage(post.data.usage)) };
  });
  const first = events.find(event => event.type === 'assistant/message' && event.data.usage !== undefined);
  assert.ok(kept.has(splitOfUsage(first.data.usage)), `${label}: the epoch's first call is a point of the history`);
  for (const [index, post] of posts.entries()) {
    assert.equal(post.stands, post.usage, `${label}: the call behind carrier ${index + 1} (event ${post.seq}) stands exactly when it reports a usage`);
  }
  assert.deepEqual(actual, expected, `${label}: the history is exactly the head, the call behind each carrier and the calls no seal replaced`);
  const heads = seals.map(({ head }) => nodeName(head));
  return { events, seals, heads, counts: seals.map(({ quote }) => quote.n), posts, requests: mine.length, standing: expected.length, expected };
}

// ── The sessions ────────────────────────────────────────────────────────────

async function sessionOf(rig, name) {
  const { call, harness, llm } = rig;
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const file of FILES) writeFileSync(join(dir, file), textOf(lines(file, 30)));
  const selection = { provider: 'mock', model: 'loop-model' };
  const agent = await harness.create(`${name}-${Date.now().toString(16)}`, selection, { cwd: dir });
  assert.deepEqual(await call('inner-mode/select', { sessionId: agent.session.id, enabled: true }), { ok: true, value: {} });
  return { dir, agent, session: agent.session, turn: text => turnOf(agent, llm, text) };
}

const reasonsOf = events => events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind);
const emptyAssistants = events => events.filter(event => event.type === 'assistant/message' && event.data.message.content.length === 0 && event.data.usage !== undefined);

// The prompt and the tool declarations change as they do in an ordinary session, by the real producers: a prompt section whose text the fixture changes, which the loop normalizes into the surface head in place, and a tool schema the fixture adds and removes, which the loop announces to the model with a tool-registry message that the route receives only when it declares a tool update mode. The addition lands behind the first carrier, so the second range opens with that message; every other change falls inside a range or in the unsealed tail.
async function ordinaryScenario({ name, toolUpdate }) {
  const model = modelOf(join(ROOT, name));
  let prompt = 'A';
  let declared = false;
  const rig = await mountShippedLoop({
    tools: true, summary, ...(toolUpdate === undefined ? {} : { toolUpdate }),
    reply: (n, options) => {
      // Each change lands after the request it names, so the next step assembles it: the first inside the first range, the tool's addition after the first range's last request, the second inside the second range, the tool's removal inside the third and the last inside the unsealed tail.
      if (n === 4) prompt = 'B';
      if (n === SEAL_STEPS) declared = true;
      if (n === SEAL_STEPS * 2 - 4) prompt = 'C';
      if (n === SEAL_STEPS * 2 + 6) declared = false;
      if (n === SEAL_STEPS * 3 + 4) prompt = 'D';
      return model.reply(n, options);
    },
  });
  rig.ctx.systemPrompt.section({ name: 'sw-fixture-prompt', order: 1_000, interpolate: false, text: () => `Fixture prompt ${prompt}.` });
  rig.ctx.systemPrompt.tools(() => ({
    schemas: declared ? [{ name: 'fixture_probe', description: 'A declaration the fixture adds and removes.', parameters: { type: 'object', properties: {} } }] : [],
  }));
  const run = await sessionOf(rig, name);
  const state = model.script(run.session.id);
  state.afterSeal = ['tool', 'tool', 'tool'];
  state.chain = SEAL_STEPS * 3 + 4;
  await run.turn('work through the files');
  const result = await qualify({ session: run.session, call: rig.call, model, label: name });
  const replacements = result.events.filter(event => event.type === 'system/message' && event.surfaceOp?.op === 'replace');
  const registry = result.events.filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'tool-registry');
  const described = event => event.data.message.content.map(block => `${block.type} ${block.toolName}`);
  assert.deepEqual(registry.map(described), [['tool-addition fixture_probe'], ['tool-removal fixture_probe']], 'the loop announced the declaration changes');
  assert.equal(replacements.length, 3, 'the loop normalized the head in place at each prompt change');
  assert.equal(result.seals.length, 3);
  assert.deepEqual(result.counts, [SEAL_STEPS, SEAL_STEPS, SEAL_STEPS], 'each seal falls at the count the script places its changes by');
  assert.deepEqual(result.heads, ['assistant', 'developer/message:tool-registry', 'assistant'],
    'the range behind the first carrier opens with the tool-registry message the changed declaration brought');
  assert.ok(result.posts.every(post => post.stands), 'the call behind each carrier stands, the one behind the first among them');
  // The head, whose request preceded every change, stands beside the call behind the first carrier, which came after the tool was added, and the one behind the third, after the head had been replaced twice.
  const first = result.events.find(event => event.type === 'assistant/message' && event.data.usage !== undefined);
  assert.ok(first.seq < replacements[0].seq && result.expected.includes(splitOfUsage(first.data.usage)), 'the point that predates the changes is among the usages the host keeps');
  assert.ok(result.posts[0].seq > registry[0].seq, 'the call behind the first carrier read the changed declaration');
  assert.ok(result.posts[2].seq > replacements[1].seq && result.posts[2].seq > registry[1].seq);
  console.log(JSON.stringify({ ordinary: { seals: result.seals.length, requests: result.requests, standing: result.standing, heads: result.heads, counts: result.counts, posts: result.posts, replacements: replacements.map(event => event.seq), registry: registry.map(event => [event.seq, ...described(event)]) } }));
  await rig.ctx.fiber.dispose();
}

const SCENARIOS = {
  // Mid-turn seals over real tool calls, then seals at a turn's start: the ranges open with a model step or with the admitted question.
  async 'stage-points-chain'() {
    const model = modelOf(join(ROOT, 'chain'));
    const rig = await mountShippedLoop({ tools: true, summary, reply: model.reply });
    const run = await sessionOf(rig, 'chain');
    const state = model.script(run.session.id);
    state.afterSeal = ['tool', 'tool', 'tool'];
    state.chain = SEAL_STEPS * 3 + 4;
    await run.turn('work through the files');
    const sealed = () => run.session.snapshotEvents().filter(isCarrierEvent).length;
    for (let index = 0; index < PLAIN_TURN_LIMIT && sealed() < 6; index += 1) await run.turn(`plain ${index + 1}`);
    for (let index = 0; index < 2; index += 1) await run.turn(`after the last seal ${index + 1}`);
    const result = await qualify({ session: run.session, call: rig.call, model, label: 'chain' });
    assert.equal(result.seals.length, 6);
    assert.ok(result.counts.every(count => count === SEAL_STEPS), `each seal falls at the count the long turn's script is sized by: ${result.counts.join(', ')}`);
    assert.deepEqual(result.heads, ['assistant', 'assistant', 'assistant', 'assistant', 'user/message:user', 'user/message:user'],
      'the first range and each seal fired in the middle of the long turn open with the model step that follows the carrier, the seals at a turn\'s start with the admitted question');
    assert.ok(result.posts.length === 6 && result.posts.every(post => post.stands), 'the call behind every carrier stands, those behind a seal at a turn\'s start after the question that opens their range');
    console.log(JSON.stringify({ chain: { seals: result.seals.length, requests: result.requests, standing: result.standing, heads: result.heads, counts: result.counts, posts: result.posts } }));
    await rig.ctx.fiber.dispose();
  },

  // A range that opens with a step the loop settled empty: a stop with no block, and a tool call the output ceiling cut.
  async 'stage-points-empties'() {
    const model = modelOf(join(ROOT, 'empties'));
    const rig = await mountShippedLoop({ tools: true, summary, reply: model.reply });
    const run = await sessionOf(rig, 'empties');
    const state = model.script(run.session.id);
    state.afterSeal = ['empty', 'max', 'text', 'empty'];
    state.chain = SEAL_STEPS;
    await run.turn('first turn, which the first seal ends with an empty answer');
    const sealed = () => run.session.snapshotEvents().filter(isCarrierEvent).length;
    for (let index = 0; index < 16 && sealed() < 4; index += 1) {
      state.chain = SEAL_STEPS;
      await run.turn(`turn ${index + 2}`);
    }
    const result = await qualify({ session: run.session, call: rig.call, model, label: 'empties' });
    const empties = emptyAssistants(result.events);
    assert.equal(empties.length, 3, 'the loop settled the two empty heads and the ceiling-cut step with usage, each as an assistant message with no block');
    assert.ok(reasonsOf(result.events).includes('max-tokens'), 'a turn ended at the output ceiling');
    // The empty assistant node keeps its surface position and derives no message: no request after it carries it.
    const mine = model.issued.filter(request => request.sessionId === run.session.id);
    assert.ok(empties.every(event => mine.every(request => !request.ids.has(event.data.message.id))), 'no request carried an empty assistant message');
    assert.deepEqual(result.heads, ['assistant', 'empty assistant', 'empty assistant', 'assistant']);
    assert.ok(result.posts.every(post => post.usage && post.stands), 'the call behind each carrier stands, an empty one included');
    console.log(JSON.stringify({ empties: { seals: result.seals.length, requests: result.requests, standing: result.standing, heads: result.heads, counts: result.counts, posts: result.posts, emptyAssistants: empties.length, turnEnds: reasonsOf(result.events) } }));
    await rig.ctx.fiber.dispose();
  },

  // The real workspace-instructions and time contexts. The time context admits a reading once its refresh interval has passed since the last, so the clock it reads is moved just past that interval while the second and the third seal's summaries are made: the step right behind each of those carriers gets a new reading admitted by the real producer, which opens its range, and the ranges before them open with the model step.
  async 'stage-points-contexts'() {
    const realNow = Date.now;
    let skewMs = 0;
    Date.now = () => realNow() + skewMs;
    let summaries = 0;
    const slowSummary = (count, options) => {
      summaries += 1;
      if (summaries === 2 || summaries === 3) skewMs += PAST_TIME_REFRESH_MS;
      return summary(count, options);
    };
    const model = modelOf(join(ROOT, 'contexts'));
    const rig = await mountShippedLoop({ tools: true, contexts: true, summary: slowSummary, reply: model.reply });
    const run = await sessionOf(rig, 'contexts');
    const state = model.script(run.session.id);
    state.afterSeal = ['tool', 'tool', 'tool'];
    state.chain = SEAL_STEPS * 3 + 4;
    await run.turn('work through the files');
    const sealed = () => run.session.snapshotEvents().filter(isCarrierEvent).length;
    for (let index = 0; index < PLAIN_TURN_LIMIT && sealed() < 6; index += 1) await run.turn(`plain ${index + 1}`);
    const result = await qualify({ session: run.session, call: rig.call, model, label: 'contexts' });
    const kinds = new Map();
    for (const event of result.events) if (event.type === 'user/message') kinds.set(event.data.source.kind, (kinds.get(event.data.source.kind) ?? 0) + 1);
    // The readings after the first are the real producer's, admitted behind carriers: each opens its range with the reading, ahead of the call behind the carrier before it, which stands all the same.
    assert.ok(kinds.get('time-context') >= 2, `the time context admitted a reading behind a carrier: ${kinds.get('time-context')}`);
    const timed = result.heads.flatMap((node, index) => (node === 'user/message:time-context' ? [index] : []));
    assert.ok(timed.length >= 2, `a range opened with the reading the time context admitted behind the carrier: ${JSON.stringify(result.heads)}`);
    assert.ok(timed.every(index => result.posts[index - 1].stands), 'the call behind the carrier before a range that opens with a reading stands');
    assert.ok(result.heads.some(node => node === 'assistant'), 'the other ranges open with a model step');
    console.log(JSON.stringify({ contexts: { seals: result.seals.length, requests: result.requests, standing: result.standing, heads: result.heads, counts: result.counts, posts: result.posts, userKinds: Object.fromEntries(kinds) } }));
    await rig.ctx.fiber.dispose();
    Date.now = realNow;
  },

  async 'stage-points-ordinary'() { await ordinaryScenario({ name: 'ordinary' }); },
  async 'stage-points-ordinary-in-history'() { await ordinaryScenario({ name: 'ordinary-in-history', toolUpdate: 'in-history' }); },

  // The loop's default runtime candidate: a context source whose text the fixture changes inside a range. After a seal replaces the snapshot that carried the change, the loop projects the candidate again and admits it ahead of the next request, so that range opens with the runtime context and not with a model step.
  async 'stage-points-runtime'() {
    const model = modelOf(join(ROOT, 'runtime'));
    let contextText = 'build 1';
    const rig = await mountShippedLoop({
      tools: true, summary,
      reply: (n, options) => {
        // The changes land after a request of the first range and after one of the third, each inside its range.
        if (n === 6) contextText = 'build 2';
        if (n === SEAL_STEPS * 2 + 6) contextText = 'build 3';
        return model.reply(n, options);
      },
    });
    rig.ctx.systemPrompt.context({ name: 'sw-fixture-runtime', order: 1_000, interpolate: false, text: () => `Fixture build: ${contextText}.` });
    const run = await sessionOf(rig, 'runtime');
    const state = model.script(run.session.id);
    state.afterSeal = ['tool', 'tool', 'tool'];
    state.chain = SEAL_STEPS * 3 + 4;
    await run.turn('work through the files');
    const sealed = () => run.session.snapshotEvents().filter(isCarrierEvent).length;
    for (let index = 0; index < PLAIN_TURN_LIMIT && sealed() < 5; index += 1) await run.turn(`plain ${index + 1}`);
    const result = await qualify({ session: run.session, call: rig.call, model, label: 'runtime' });
    const admitted = result.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context');
    assert.ok(admitted.length >= 4, `the loop admitted the runtime snapshot again after the seals that replaced it: ${admitted.length}`);
    const reread = result.heads.flatMap((node, index) => (node === 'user/message:runtime-context' ? [index] : []));
    assert.ok(reread.length > 0, 'a range opened with the re-admitted runtime snapshot');
    assert.ok(reread.every(index => result.posts[index - 1].stands), 'the call behind the carrier before a range that opens with the snapshot stands');
    console.log(JSON.stringify({ runtime: { seals: result.seals.length, requests: result.requests, standing: result.standing, heads: result.heads, counts: result.counts, posts: result.posts, admitted: admitted.map(event => event.seq) } }));
    await rig.ctx.fiber.dispose();
  },
};

if (!Object.hasOwn(SCENARIOS, scenario)) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
try {
  await SCENARIOS[scenario]();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
