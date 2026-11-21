// The inner seal (`dsh/src/inner-seal.js`) against the real DSH packages of the checkout `SW_DSH_CHECKOUT` names, imported from it by file path: a real detached `Session` the seal reads, summarizes over and commits to, the real stream, record, message and tool-pairing kit and the real inner monitor, over a recording `llm.stream`, a recording token meter and doubles of the services the seal reads. The last cases hand the facts the seal wrote to the monitor's read side. Without the checkout every case skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath, { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loads } from 'ai-json-repair';

import { createInnerMonitor } from '../dsh/src/inner-monitor.js';
import { loadHandoffInto } from '../dsh/src/load.js';
import { INNER_QUOTE, KAPPA_PRESETS, kappaOf } from '../lib/inner-seal/quote.js';
import { createMonitorAccess, innerMonitorProjection, rowsOf, PREVIEW_SOURCE_CHARS } from '../dsh/src/inner-monitor-read.js';
import { createInnerSeal, INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE } from '../dsh/src/inner-seal.js';
import { SUMMARY_MAX_REQUESTS } from '../lib/inner-seal/ladder.js';
import { UNCACHED_SHARE_ALERT } from '../lib/inner-seal/call-record.js';
import { CARRIER_WORDING, INNER_SEAL_KIND, renderCarrier } from '../lib/inner-seal/carrier.js';
import { STATE_WORDING } from '../lib/inner-seal/state-block.js';
import { CARRIER_TABLE } from '../lib/harness/dsh/carrier-table.js';
import { renderCarried } from '../lib/carried-evidence.js';
import { eventFactOf } from '../lib/harness/dsh/event-facts.js';
import { createNodeWorkingTree } from '../lib/working-tree.js';
import { readTreeWindows } from '../lib/working-tree-text.js';
import { fakeTokenMeter } from './helpers/dsh-fake-context.js';
import { withoutEventAt } from './helpers/dsh-mode-kit.js';
import {
  assistantMessage, compactCheckpoint, innerSealCarrier, prunedResult, requestHeader, sessionLog, stepEnd, stepStart, systemMessage, toolCall,
  toolResult, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';

const CHECKOUT = process.env.SW_DSH_CHECKOUT;
const LIBS = {
  session: 'packages/core/session/lib/index.js',
  llm: 'packages/llm/llm/lib/index.js',
  compaction: 'packages/compaction/compaction/lib/index.js',
};

const skip = !CHECKOUT ? 'SW_DSH_CHECKOUT is unset'
  : Object.values(LIBS).find(path => !existsSync(join(CHECKOUT, path)))?.replace(/^/, 'SW_DSH_CHECKOUT names no ') ?? false;

const fromCheckout = path => import(pathToFileURL(join(CHECKOUT, path)).href);
const [sessionPackage, llmPackage, compactionPackage] = skip ? [] : await Promise.all(Object.values(LIBS).map(fromCheckout));

const kitOf = (overrides = {}) => ({
  appendPluginRecord: sessionPackage.appendPluginRecord,
  pluginRecordOf: sessionPackage.pluginRecordOf,
  AssistantStreamAccumulator: llmPackage.AssistantStreamAccumulator,
  BlockAssembler: llmPackage.BlockAssembler,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
  errorChain: llmPackage.errorChain,
  loads,
  createUserMessage: llmPackage.createUserMessage,
  toolPairingBalancedBefore: compactionPackage.toolPairingBalancedBefore,
  toolPairingBalancedAfter: compactionPackage.toolPairingBalancedAfter,
  ...overrides,
});

const SELECTION = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' };
const TOOLS = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }];

// One turn of `steps` model steps after the system head and one user request: each step a text reply, `bulk` characters longer where given, and, for each step in `toolSteps`, a tool call answered by its result in the same step. A step in `asks` also asks the user, one `ask_user_question` call for each `{ id, arguments, result }` of its entry, `result` the `{ text, isError }` of the call's result, which follow the step's `read` call and its result in that order. Answers the events (not yet a log) and the named ones.
function turnOf({ steps = INNER_QUOTE.minSteps, toolSteps = [], asks = {}, turn = 1, ask = 'please work', bulk = 0, tools = TOOLS } = {}) {
  const events = [turnStart({ turn })];
  const request = userMessage({ text: ask });
  events.push(request);
  const replies = [];
  for (let step = 1; step <= steps; step += 1) {
    events.push(stepStart({ turn, step }));
    if (step === 1 && turn === 1) {
      const header = requestHeader();
      events.push({ ...header, data: { ...header.data, header: { ...header.data.header, tools } } });
    }
    const callId = `call-${turn}-${step}`;
    const withTool = toolSteps.includes(step);
    const questions = asks[step] ?? [];
    const toolCalls = [
      ...(withTool ? [{ id: callId, name: 'read' }] : []),
      ...questions.map(({ id, arguments: args }) => ({ id, name: 'ask_user_question', arguments: args })),
    ];
    const reply = assistantMessage({ text: `reply ${turn}.${step}${bulk > 0 ? ` ${'z'.repeat(bulk)}` : ''}`, turn, step, toolCalls });
    events.push(reply);
    replies.push(reply);
    if (withTool) {
      events.push(toolCall({ callId, name: 'read', turn, step }));
      events.push(toolResult({ callId, text: `result ${turn}.${step}`, turn, step }));
    }
    for (const { id, arguments: args, result } of questions) {
      events.push(toolCall({ callId: id, name: 'ask_user_question', arguments: args, turn, step }));
      events.push(toolResult({ callId: id, ...result, turn, step }));
    }
    events.push(stepEnd({ turn, step }));
  }
  events.push(turnEnd({ turn }));
  return { events, request, replies };
}

// The surface of a `turnOf` session after its initial prefix: the system prompt and the task, both logged before the first request's header, stay out of every range.
const afterPrefix = session => session.surface.nodes.slice(2);

const HEADER = id => ({ version: 4, id, createdAt: 1, isSeeded: false, cwd: '/repo', delegationDepth: 0 });

// A detached `Session` over `events` renumbered into a log; `seqOf` names an event's seq in it.
function sessionOver(events, id = 'inner-seal') {
  const log = sessionLog(events);
  const session = sessionPackage.Session.create(id, log, HEADER(id), 0);
  return { session, seqOf: event => events.indexOf(event) };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

// A recording `llm` whose `stream` answers `script(options)`.
function recordingLlm(script) {
  const calls = [];
  return { calls, stream(options) { calls.push(options); return script(options); } };
}

async function* chunks(...list) {
  for (const chunk of list) yield chunk;
}

// The notes object of `texts`, one per slot keyed "1" to the slot count.
const notesTextOf = texts => JSON.stringify(Object.fromEntries(texts.map((text, index) => [String(index + 1), text])));
// A successful summary stream answering `texts`, with `usage` when given.
const summaryStream = (texts, usage) => chunks(
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: notesTextOf(texts) },
  { type: 'block-end', index: 0, block: { type: 'text', text: notesTextOf(texts) } },
  ...(usage === undefined ? [] : [{ type: 'usage', usage }]),
  { type: 'finish', reason: { kind: 'stop' } },
);
// A summary stream that answers one summary per slot the tail message names.
const answeringSlots = usage => recordingLlm((options) => {
  const count = Number(/slot numbers "1" to "(\d+)"/.exec(options.messages.at(-1).content[0].text)[1]);
  return summaryStream(Array.from({ length: count }, (_, index) => `summary ${index + 1}`), usage);
});

// A reply that stopped normally and fails JSON syntax alone: the notes object `answeringSlots` writes, but for a first note that quotes an array with its inner quotes unescaped.
const QUOTED_NOTE = `Found: '["one","two","three"]'.`;
const unescapedSlots = () => recordingLlm((options) => {
  const count = Number(/slot numbers "1" to "(\d+)"/.exec(options.messages.at(-1).content[0].text)[1]);
  const text = `{${Array.from({ length: count }, (_, index) => `"${index + 1}": "${index === 0 ? QUOTED_NOTE : `summary ${index + 1}`}"`).join(', ')}}`;
  return chunks(
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  );
});

// A recording `llm` whose nth request is answered by the nth of `scripts`, and every request past the last by the last.
function sequencedLlm(...scripts) {
  const llm = recordingLlm(options => scripts[Math.min(llm.calls.length, scripts.length) - 1](options));
  return llm;
}
// A reply that stopped with no tool call and fails the notes' format: one note for the slots the tail asks.
const wrongFormat = () => summaryStream(['only one']);
// A reply that stopped with a tool call, and one whose finish is tool-calls: neither carries the notes object.
const toolCalled = () => chunks(
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'stop' } },
);
const toolCallsFinish = () => chunks(
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
);
// A consumed stream whose failure is no format failure: it ended on the output ceiling.
const cutShort = () => chunks({ type: 'finish', reason: { kind: 'max-tokens' } });
// A stream the provider's content filter cut off mid-reply: the finish chunk is an error carrying the provider's stop text.
const filtered = () => chunks(
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '{"1": "par' },
  { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider stopped with: content_filtered', code: 'PI_AI_ERROR' } } },
);
// A stream that ended on an error the filter did not cause.
const otherError = () => chunks({ type: 'finish', reason: { kind: 'error', failure: { message: 'Provider stopped with: overloaded', code: 'PI_AI_ERROR' } } });
// The backup model the settings name: the exact route alone, which the request carries with the model's own default controls.
const FALLBACK = { provider: 'fallback-provider', model: 'fallback-model' };
const FALLBACK_ROUTE = { ...FALLBACK, reasoningEffort: undefined };
const routeOf = options => ({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort });

const NEXT_DECISION = Object.freeze({ kind: 'enter', messages: [] });

// The C ratio the session's watcher reads, the calibrated pair the host reads for the session and the meter's heuristic price of a node. The pair is a power of two, so every token count is exact, and a range of `INNER_QUOTE.minSteps` counted steps of `turnOf` quotes as worth sealing under it, while no range of any count does under `SMALL_CTP`; `test/inner-seal.quote.test.js` holds the estimate's and the decision's worked examples. The node price is the prune's `shadowedTokenCount` alone, which the quote does not read.
const RATIO = 30;
// A count of steps well past `INNER_QUOTE.minSteps`: under `ELIGIBLE_CTP` a range of `turnOf` steps quotes on the right arm and seals whatever its count.
const LONG_STEPS = 24;
// Reply padding that puts a range's text above a held file's B under `ELIGIBLE_CTP`, so a range of `LONG_STEPS` steps over such a block still has savings to quote; a range of that count at the ratio the tests read passes whenever its savings are positive.
const BULK = 200;
const ELIGIBLE_CTP = { ascii: 1 / 1024, cjk: 1 / 1024, version: 1 };
const SMALL_CTP = { ascii: 2 ** 20, cjk: 2 ** 20, version: 1 };
const ELIGIBLE_NODE = { tokens: 10, heuristicTokens: 5000 };
// The characters of the text blocks of events that carry nothing else, as `turnOf` writes its replies.
const charsOf = events => events.reduce((sum, event) => sum + event.data.message.content.reduce((total, block) => total + block.text.length, 0), 0);
// The tokens of the B text `renderCarried` renders for `paths` under `ELIGIBLE_CTP`, over text that is all ASCII: its characters at the pair's characters per token, the blank-line opening the carrier's block adds not among them.
const pricedB = paths => renderCarried({ paths }, CARRIER_TABLE).length / ELIGIBLE_CTP.ascii;
const emptyRead = async (_agent, key) => ({ read: { status: 'readable', totalLines: 0, windows: [] }, displayPath: key });

// The seal over `session`, with every service a double the case may replace: the mode `on`, the event facts read from the session's own log, the session's own log as the frozen slice, an empty held view, readable reads, observed or not, a host that reads no state, the watcher's ratio `RATIO`, the pair `ELIGIBLE_CTP` and a meter pricing every node at `ELIGIBLE_NODE`.
// The monitor is the real one, made after the overrides apply so it appends through the kit the seal appends through; `published` keeps the session id of each publish it makes.
function sealOver(session, { settings, ...overrides } = {}) {
  const published = [];
  const services = {
    readMode: () => ({ mode: 'on', locked: true }),
    eventFacts: () => new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)])),
    readSession: async () => ({ events: session.snapshotEvents() }),
    heldView: () => ({ paths: new Map(), skills: new Map(), effects: [] }),
    readFile: emptyRead,
    readUnobserved: emptyRead,
    readState: () => ({ asOfSeq: 0, items: {} }),
    readSettings: () => ({ preset: 'E2', fallbackModel: null, ...settings }),
    cRatio: () => RATIO,
    ctpOf: () => ELIGIBLE_CTP,
    attachments: {},
    meter: fakeTokenMeter({ fallback: ELIGIBLE_NODE }),
    llm: answeringSlots(),
    kit: kitOf(),
    ...overrides,
  };
  services.monitor ??= createInnerMonitor({ appendPluginRecord: services.kit.appendPluginRecord, publish: (sessionId) => { published.push(sessionId); } });
  return { services, seal: createInnerSeal(services), monitor: services.monitor, published };
}

// One pre-step of `session`'s agent through `seal`, whose `next()` answers `decision`; answers the seal's decision and the times `next` ran.
async function preStep(seal, session, { signal = new AbortController().signal, decision = NEXT_DECISION, selection = SELECTION } = {}) {
  let nextCalls = 0;
  const next = async () => { nextCalls += 1; return decision; };
  const answer = await seal({ agent: { id: session.id, session }, messages: [], turn: 2, step: 1, signal, modelSelection: selection }, next);
  return { answer, nextCalls };
}

// One pre-step expected to end the turn: answers the value it rejected with and the times `next` ran.
async function failingPreStep(seal, session, { signal = new AbortController().signal, selection = SELECTION } = {}) {
  let nextCalls = 0;
  const next = async () => { nextCalls += 1; return NEXT_DECISION; };
  const error = await seal({ agent: { id: session.id, session }, messages: [], turn: 2, step: 1, signal, modelSelection: selection }, next).then(
    () => assert.fail('the pre-step answered'),
    thrown => thrown,
  );
  return { error, nextCalls };
}

const appendedSince = (session, seq) => session.snapshotEvents().slice(seq);
const typesSince = (session, seq) => appendedSince(session, seq).map(event => event.type);

// The facts of one attempt in log order: the attempt record, the call record and, by how it ended, the prune and the carrier or the end record.
const SEALED = [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message'];
const FAILED = [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE];

test('a range of INNER_QUOTE.minSteps counted steps seals before the step: the attempt record opens it, then the call record, the prune and the carrier replace are appended, those three adjacent and in that order, the step entered with next()\'s own decision', { skip }, async () => {
  const system = systemMessage();
  const { events, request, replies } = turnOf();
  const { session, seqOf } = sessionOver([system, ...events]);
  const before = session.seq;
  const range = afterPrefix(session);
  const { services, seal } = sealOver(session);

  const { answer, nextCalls } = await preStep(seal, session);

  assert.equal(answer, NEXT_DECISION, 'the decision next() answers is returned as it is');
  assert.equal(nextCalls, 1);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), SEALED);
  const [attempt, record, prune, carrier] = appended;
  assert.deepEqual(appended.map(event => event.seq), [before, before + 1, before + 2, before + 3], 'the attempt record opens the stretch and the three appends follow it adjacent');
  assert.equal(record.data.purpose, 'inner-compaction');
  assert.deepEqual(record.data.range, range);
  assert.equal(record.data.attempt, attempt.seq, 'the call record names the attempt record');
  assert.deepEqual(prune.data, {
    shadowedRange: { start: range[0], end: range.at(-1) }, shadowedSeqs: range,
    shadowedTokenCount: range.length * ELIGIBLE_NODE.heuristicTokens,
  });
  assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: range[0], endSeq: range.at(-1) });
  assert.deepEqual([...carrier.sourceEventSeqs].sort((a, b) => a - b), [...range, record.seq, prune.seq].sort((a, b) => a - b), 'the carrier cites the call record, not the attempt record');
  assert.deepEqual(session.surface.nodes, [seqOf(system), seqOf(request), carrier.seq], 'the carrier stands for the whole range, after the initial prefix');
  const source = carrier.data.source;
  assert.equal(source.kind, INNER_SEAL_KIND);
  assert.deepEqual(source.slots.map(slot => slot.seqs), replies.map(reply => [seqOf(reply)]));
  assert.deepEqual(source.slots.map(slot => slot.text), source.slots.map((_, index) => `summary ${index + 1}`));
  assert.deepEqual(carrier.data.content, renderCarrier(source, CARRIER_TABLE), 'the body is the source rendered');
  assert.equal(services.llm.calls.length, 1);
});

test('the seal follows its quote: a range the quote finds worth sealing seals with that quote and the kappa it was compared with on its attempt record, one it does not permits the step with no summary and nothing appended, and below the minimum no quote is taken', { skip }, async () => {
  const eligibleTurn = turnOf();
  const eligible = sessionOver([systemMessage(), ...eligibleTurn.events], 'eligible').session;
  const before = eligible.seq;
  const { seal } = sealOver(eligible);
  await preStep(seal, eligible);
  const [attempt] = appendedSince(eligible, before);
  assert.deepEqual(typesSince(eligible, before), SEALED);
  const { quote } = attempt.data;
  assert.deepEqual(
    [quote.trigger, quote.arm, quote.n, quote.lA, quote.bEst, quote.cEst, quote.cRatio, quote.fee],
    ['quote', 'right', INNER_QUOTE.minSteps, charsOf(eligibleTurn.replies) / ELIGIBLE_CTP.ascii, 0, INNER_QUOTE.cPerStep * INNER_QUOTE.minSteps, RATIO, INNER_QUOTE.fee],
  );
  // The preset's kappa at n 8 and ratio 30, the research record's expression evaluated apart from the module; the right arm passes with no regard for q.
  assert.ok(Math.abs(quote.kappa - 1.0994084552089021) < 1e-12, `kappa ${quote.kappa}`);

  const rejected = sessionOver([systemMessage(), ...turnOf().events], 'rejected').session;
  const rejectedBefore = rejected.seq;
  const llm = answeringSlots();
  const { seal: declining } = sealOver(rejected, { ctpOf: () => SMALL_CTP, llm });
  const { answer, nextCalls } = await preStep(declining, rejected);
  assert.equal(answer, NEXT_DECISION, 'the decision next() answers is returned as it is');
  assert.equal(nextCalls, 1);
  assert.equal(llm.calls.length, 0, 'no summary is requested');
  assert.equal(rejected.seq, rejectedBefore, 'nothing is appended');

  const short = sessionOver([systemMessage(), ...turnOf({ steps: INNER_QUOTE.minSteps - 1 }).events], 'short').session;
  let quoted = 0;
  const { seal: idle } = sealOver(short, { heldView: () => { quoted += 1; return { paths: new Map(), skills: new Map(), effects: [] }; }, readUnobserved: async (...args) => { quoted += 1; return emptyRead(...args); } });
  const shortBefore = short.seq;
  assert.equal((await preStep(idle, short)).answer, NEXT_DECISION);
  assert.equal(quoted, 0, 'below the minimum nothing is read for a quote');
  assert.equal(short.seq, shortBefore);
});

test('a node of the range that derives no message adds nothing to the quote\'s A: the messages of the other nodes are priced alone', { skip }, async () => {
  const { events, replies } = turnOf();
  // An assistant node with no content, as a step that ran out of tokens leaves it, derives no message.
  const empty = assistantMessage({ turn: 1, step: 1 });
  events.splice(events.indexOf(replies[0]) + 1, 0, empty);
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  await preStep(sealOver(session).seal, session);

  const [attempt, , , carrier] = appendedSince(session, before);
  assert.ok(carrier.sourceEventSeqs.includes(seqOf(empty)), 'the node without a message stands in the range the seal replaces');
  assert.equal(attempt.data.quote.lA, charsOf(replies) / ELIGIBLE_CTP.ascii);
});

// A session of `INNER_QUOTE.minSteps` steps whose range the pair prices at `lA` tokens: at ratio 40 and n 8 a `lA` of 20000 is a left quote under E2's kappa and above the kappa of W2, M2, S3 and X3, so it passes under E2 alone.
function leftQuoteAt(lA, id) {
  const { events, replies } = turnOf();
  const { session } = sessionOver([systemMessage(), ...events], id);
  return { session, ctp: { ascii: charsOf(replies) / lA, cjk: 1, version: 1 } };
}

test('the preset the settings name decides the seal: one range at one ratio seals under the most aggressive policy with that policy\'s kappa on its attempt record and is left unsealed under the balanced one with no summary and nothing appended', { skip }, async () => {
  const aggressive = leftQuoteAt(20000, 'aggressive');
  const before = aggressive.session.seq;
  const { seal } = sealOver(aggressive.session, { ctpOf: () => aggressive.ctp, cRatio: () => 40, readSettings: () => ({ preset: 'E2', fallbackModel: null }) });
  await preStep(seal, aggressive.session);
  assert.deepEqual(typesSince(aggressive.session, before), SEALED);
  const { quote } = appendedSince(aggressive.session, before)[0].data;
  assert.deepEqual([quote.preset, quote.arm, quote.trigger], ['E2', 'left', 'quote']);
  assert.ok(Math.abs(quote.kappa - 1.1456008175730845) < 1e-12, `kappa ${quote.kappa}`);

  const balanced = leftQuoteAt(20000, 'balanced');
  const llm = answeringSlots();
  const { seal: declining } = sealOver(balanced.session, { ctpOf: () => balanced.ctp, cRatio: () => 40, llm, readSettings: () => ({ preset: 'M2', fallbackModel: null }) });
  const { answer, nextCalls } = await preStep(declining, balanced.session);
  assert.equal(answer, NEXT_DECISION, 'the decision next() answers is returned as it is');
  assert.equal(nextCalls, 1);
  assert.equal(llm.calls.length, 0, 'no summary is requested');
  assert.equal(typesSince(balanced.session, balanced.session.seq).length, 0);
});

// A meter whose whole surface weighs `total` heuristic tokens, half on the head and half on the newest node, so the sum is exact and counts nodes inside the range as well as outside it. Its request pressure `totalTokens` is the nodes' route prices, of no weight beside the read the cases below state.
const meterOfTotal = (session, total) => {
  const nodes = session.surface.nodes;
  const half = { tokens: 1, heuristicTokens: total / 2 };
  return fakeTokenMeter({ prices: { [nodes[0]]: half, [nodes.at(-1)]: half }, fallback: { tokens: 1, heuristicTokens: 0 } });
};

// A left quote at lA 34000, n 8 and ratio 40 passes under E2 and W2 and is declined by M2, S3 and X3; at 38000 M2 passes too; at 48000 every preset passes.
test('the quote is priced under the preset the settings name whatever the heuristic length of the whole surface: the snapshot records that preset and its kappa', { skip }, async () => {
  for (const [configured, lA, total] of [
    ['E2', 34000, 0], ['E2', 34000, 400_000], ['E2', 34000, 5_000_000],
    ['M2', 38000, 200_000], ['S3', 46000, 200_000], ['X3', 48000, 1_000_000],
  ]) {
    const { session, ctp } = leftQuoteAt(lA, `${configured}-${total}`);
    const before = session.seq;
    const llm = answeringSlots();
    const { seal } = sealOver(session, { ctpOf: () => ctp, cRatio: () => 40, llm, meter: meterOfTotal(session, total), readSettings: () => ({ preset: configured, fallbackModel: null }) });
    await preStep(seal, session);
    const why = `${configured} at ${total}`;
    assert.ok(llm.calls.length > 0, `${why}: the quote passes under the configured preset`);
    const { quote } = appendedSince(session, before)[0].data;
    assert.equal(quote.preset, configured, why);
    assert.equal(quote.kappa, kappaOf(quote.n, quote.cRatio, KAPPA_PRESETS[configured]), `${why}: the kappa is the configured preset's`);
  }
});

// The range of `turnOf` at n 8 and ratio 25 whose quote under E2 is the research record's worked point with no B: C 1600, S 31250, so a read of the history of 0, 140625 or 312500 puts the reference at 8, 12.5 or 18 (`test/inner-seal.quote.test.js` `READ_COST_AT_ANCHOR`); the first two seal, the third is a left quote at or above kappa. The pair's characters per token is inexact here, so a case reads the trigger and the recorded read, not the arm at the boundary.
function readPointAt(id) {
  const { events, replies } = turnOf();
  const { session } = sessionOver([systemMessage(), ...events], id);
  return { session, ctp: { ascii: charsOf(replies) / 32850, cjk: 1, version: 1 } };
}
const READ_POINT_SERVICES = ({ ctp, ...overrides }) => ({ ctpOf: () => ctp, cRatio: () => 25, readSettings: () => ({ preset: 'E2', fallbackModel: null }), ...overrides });

test('the summary call\'s read of the active history is paid in the quote by the meter\'s total pressure, not by the sum of its nodes: one range at one ratio seals at a read of zero or 140625 with the read on the attempt record and is left unsealed at 312500 with no summary and nothing appended', { skip }, async () => {
  for (const [totalTokens, seals] of [[0, true], [140625, true], [312500, false]]) {
    const { session, ctp } = readPointAt(`read-${totalTokens}`);
    const before = session.seq;
    const llm = answeringSlots();
    // The nodes' own prices sum to far more than any total here and to something else than each of them, so only the total decides.
    const meter = fakeTokenMeter({ fallback: { tokens: 1_000_000, heuristicTokens: 1 }, totalTokens });
    const { seal } = sealOver(session, READ_POINT_SERVICES({ ctp, llm, meter }));
    const { answer, nextCalls } = await preStep(seal, session);
    const why = `a read of ${totalTokens}`;
    assert.equal(answer, NEXT_DECISION, why);
    assert.equal(nextCalls, 1, why);
    if (!seals) {
      assert.equal(llm.calls.length, 0, `${why}: no summary is requested`);
      assert.equal(session.seq, before, `${why}: nothing is appended`);
      continue;
    }
    assert.deepEqual(typesSince(session, before), SEALED, why);
    const { quote } = appendedSince(session, before)[0].data;
    assert.deepEqual([quote.trigger, quote.summaryReadCost, quote.preset, quote.fee], ['quote', totalTokens, 'E2', INNER_QUOTE.fee], `${why}: the attempt keeps the read it was priced with`);
    assert.equal(quote.kappa, kappaOf(quote.n, quote.cRatio, KAPPA_PRESETS.E2), `${why}: the read leaves kappa alone`);
    assert.ok(Math.abs(quote.nRef - (250000 + totalTokens) / quote.sEst) < 1e-9, `${why}: the reference is the fixed load plus the read over the savings, the read not multiplied by the ratio`);
  }
});

test('the configured preset still prices the quote whatever the read: one read passes under the most aggressive policy and is left unsealed under the balanced one, a read past the left arm declines under the one that passed, and the snapshot names the configured preset and its kappa', { skip }, async () => {
  for (const [configured, totalTokens, seals] of [['E2', 140625, true], ['M2', 140625, false], ['E2', 5_000_000, false], ['M2', 0, true]]) {
    const { session, ctp } = readPointAt(`${configured}-${totalTokens}`);
    const before = session.seq;
    const llm = answeringSlots();
    const { seal } = sealOver(session, READ_POINT_SERVICES({ ctp, llm, meter: fakeTokenMeter({ totalTokens }), readSettings: () => ({ preset: configured, fallbackModel: null }) }));
    await preStep(seal, session);
    const why = `${configured} at a read of ${totalTokens}`;
    assert.equal(llm.calls.length > 0, seals, why);
    if (!seals) continue;
    const { quote } = appendedSince(session, before)[0].data;
    assert.equal(quote.preset, configured, why);
    assert.equal(quote.kappa, kappaOf(quote.n, quote.cRatio, KAPPA_PRESETS[configured]), why);
  }
});

test('the read is taken beside the settings and the surface cut, before the pre-step\'s first await', { skip }, async () => {
  const { session, ctp } = readPointAt('read-order');
  const order = [];
  const meter = fakeTokenMeter({ totalTokens: 0 });
  const measure = meter.measure.bind(meter);
  meter.measure = function (...args) { order.push('meter'); return measure(...args); };
  const { seal } = sealOver(session, READ_POINT_SERVICES({
    ctp, meter,
    readSettings: () => { order.push('settings'); return { preset: 'E2', fallbackModel: null }; },
    readSession: async () => { order.push('session'); return { events: session.snapshotEvents() }; },
  }));
  await preStep(seal, session);
  assert.deepEqual(order.slice(0, 3), ['settings', 'meter', 'session']);
});

test('a read that cannot be taken leaves the old quote whole: a meter with no total, a total that is not a finite non-negative number, and a measurement that throws at the quote each seal as the quote without a read did, the attempt keeps no read, and only the throw writes one diagnostic line naming it', { skip }, async (t) => {
  for (const [why, meter, lines] of [
    ['no total', { measure: () => ({ nodes: [] }) }, 0],
    ['a total that is not a number', { measure: () => ({ nodes: [], totalTokens: Number.NaN }) }, 0],
    ['a negative total', { measure: () => ({ nodes: [], totalTokens: -1 }) }, 0],
  ]) {
    const { session, ctp } = readPointAt(`unread-${why}`);
    const before = session.seq;
    // The commit's own measurement still has the nodes of the surface to count.
    let calls = 0;
    const real = fakeTokenMeter();
    const { seal } = sealOver(session, READ_POINT_SERVICES({ ctp, meter: { measure(...args) { calls += 1; return calls === 1 ? meter.measure() : real.measure(...args); } } }));
    const written = await stderrOf(t, async () => { await preStep(seal, session); });
    assert.deepEqual(typesSince(session, before), SEALED, why);
    const { quote } = appendedSince(session, before)[0].data;
    assert.equal(Object.hasOwn(quote, 'summaryReadCost'), false, why);
    assert.equal(written.filter(line => line.includes('inner_quote_failed')).length, lines, `${why}: ${written.join('\n')}`);
  }

  // A total that would decline the range, never read: the throw leaves the quote as before and the range seals.
  const { session, ctp } = readPointAt('throws');
  const before = session.seq;
  let calls = 0;
  const real = fakeTokenMeter({ totalTokens: 312500 });
  const meter = { measure(...args) { calls += 1; if (calls === 1) throw new Error('the meter has no baseline'); return real.measure(...args); } };
  const { seal } = sealOver(session, READ_POINT_SERVICES({ ctp, meter }));
  const written = await stderrOf(t, async () => { await preStep(seal, session); });
  assert.deepEqual(typesSince(session, before), SEALED);
  const { quote } = appendedSince(session, before)[0].data;
  assert.equal(Object.hasOwn(quote, 'summaryReadCost'), false);
  const failures = written.filter(line => line.includes('inner_quote_failed'));
  assert.equal(failures.length, 1, written.join('\n'));
  assert.ok(failures[0].includes('the meter has no baseline'), failures[0]);
});

test('no count of steps seals without a quote that passes: a ratio the watcher cannot read, a pair it cannot read, savings that are not positive and a left quote at or above kappa permit the step with no summary, no attempt and nothing appended', { skip }, async (t) => {
  const long = () => sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK }).events], 'long').session;
  for (const [why, overrides] of [
    ['a ratio that cannot be read', { cRatio: () => null }],
    ['a ratio read that throws', { cRatio: () => { throw new Error('the watcher could not answer'); } }],
    ['a pair that cannot be read', { ctpOf: () => null }],
    ['a pair read that throws', { ctpOf: () => { throw new Error('the watcher has no epoch'); } }],
    ['savings that are not positive', { ctpOf: () => SMALL_CTP }],
  ]) {
    const session = long();
    const before = session.seq;
    const llm = answeringSlots();
    const { seal } = sealOver(session, { ...overrides, llm });
    let outcome;
    await stderrOf(t, async () => { outcome = await preStep(seal, session); });
    assert.equal(outcome.answer, NEXT_DECISION, `${why}: the decision next() answers is returned as it is`);
    assert.equal(outcome.nextCalls, 1, why);
    assert.equal(llm.calls.length, 0, `${why}: no summary is requested`);
    assert.equal(session.seq, before, `${why}: nothing is appended`);
  }

  // A left quote above kappa at a ratio of 1.
  const beyond = turnOf({ steps: LONG_STEPS + 2 });
  const session = sessionOver([systemMessage(), ...beyond.events], 'beyond').session;
  const before = session.seq;
  const priced = { ascii: charsOf(beyond.replies) / (INNER_QUOTE.cPerStep * (LONG_STEPS + 2) + 100), cjk: 1, version: 1 };
  const llm = answeringSlots();
  const { seal } = sealOver(session, { ctpOf: () => priced, cRatio: () => 1, llm });
  const { nextCalls } = await preStep(seal, session);
  assert.equal(nextCalls, 1);
  assert.equal(llm.calls.length, 0, 'the quote alone declines: no summary is requested');
  assert.equal(session.seq, before, 'nothing is appended');
});

test('a ratio read that throws leaves the ratio unavailable: the step is entered unsealed with one diagnostic line naming the throw, and a cancel the read threw under ends the turn as the abort before any attempt', { skip }, async (t) => {
  const declined = sessionOver([systemMessage(), ...turnOf().events], 'declined').session;
  const before = declined.seq;
  const llm = answeringSlots();
  const { seal } = sealOver(declined, { llm, cRatio: () => { throw new Error('the watcher could not answer'); } });
  let outcome;
  const lines = await stderrOf(t, async () => { outcome = await preStep(seal, declined); });
  assert.equal(outcome.answer, NEXT_DECISION, 'the decision next() answers is returned as it is');
  assert.equal(outcome.nextCalls, 1);
  assert.equal(llm.calls.length, 0, 'no summary is requested');
  assert.equal(declined.seq, before, 'nothing is appended');
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.ok(lines[0].includes('the watcher could not answer'), lines[0]);

  const cancelled = sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK }).events], 'cancelled').session;
  const cancelledBefore = cancelled.seq;
  const controller = new AbortController();
  const cause = { kind: 'user' };
  const cancelledLlm = answeringSlots();
  const { seal: aborting } = sealOver(cancelled, {
    llm: cancelledLlm,
    cRatio: () => { controller.abort(cause); throw new Error('the ratio read was aborted'); },
  });
  let failure;
  await stderrOf(t, async () => { failure = await failingPreStep(aborting, cancelled, { signal: controller.signal }); });
  assert.equal(failure.error, cause, 'the cause itself');
  assert.equal(failure.nextCalls, 0);
  assert.equal(cancelledLlm.calls.length, 0);
  assert.equal(cancelled.seq, cancelledBefore);
});

test('the quote reads the held files without recording an observation and the commit reads them again recording it: the attempt keeps the B the quote estimated while the carrier states what the commit read', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK }).events]);
  const before = session.seq;
  const reads = [];
  const at = (text, kind) => async (_agent, key) => {
    reads.push([kind, key]);
    return { read: { status: 'readable', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text }] }] }, displayPath: key };
  };
  const later = 'the held line as the commit reads it, rewritten after the quote and longer than before';
  const { seal } = sealOver(session, {
    heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }),
    readUnobserved: at('x', 'quote'),
    readFile: at(later, 'commit'),
  });
  await preStep(seal, session);

  assert.deepEqual(reads, [['quote', HELD_PATH], ['commit', HELD_PATH]], 'one unobserved read for the quote, then the observed read of the commit');
  const [attempt, , , carrier] = appendedSince(session, before);
  assert.deepEqual(carrier.data.source.paths[0].write, [[1, later]], 'the carrier states what the commit read');
  const priced = text => pricedB([{ path: HELD_PATH, displayPath: HELD_PATH, totalLines: 1, state: 'readable', write: [[1, text]] }]);
  assert.equal(attempt.data.quote.bEst, priced('x'), 'the attempt keeps the B the quote read');
  assert.notEqual(attempt.data.quote.bEst, priced(later));
});

test('the summary tail names the held files and skills the range touched, while the quote and the carrier hold every one the held view answers', { skip }, async () => {
  const { events, replies, request } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  const other = '/repo/src/other.js';
  // An effect belongs to the seq of an event: the first reply is among the events the seal replaces, the task's request is not.
  const inside = seqOf(replies[0]);
  const outside = seqOf(request);
  const readable = async (_agent, key) => ({ read: { status: 'readable', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text: 'x' }] }] }, displayPath: key });
  const { services, seal } = sealOver(session, {
    heldView: () => ({
      paths: new Map([[HELD_PATH, [1]], [other, [1]]]),
      skills: new Map([['tdd', 'TDD body'], ['grill', 'Grill body']]),
      effects: [
        { seq: outside, kind: 'path', key: HELD_PATH },
        { seq: inside, kind: 'path', key: other },
        { seq: outside, kind: 'skill', key: 'tdd' },
        { seq: inside, kind: 'skill', key: 'grill' },
      ],
    }),
    readUnobserved: readable,
    readFile: readable,
  });
  await preStep(seal, session);

  const [attempt, , , carrier] = appendedSince(session, before);
  const replaced = carrier.data.source.slots.flatMap(slot => slot.seqs);
  assert.ok(replaced.includes(inside) && !replaced.includes(outside), 'the effects stand inside and outside the range the seal replaces');
  const tail = services.llm.calls[0].messages.at(-1).content[0].text;
  assert.deepEqual(tail.split('\n').filter(line => /^- (file|skill) /u.test(line)), [`- file ${other}`, '- skill grill']);
  assert.deepEqual(carrier.data.source.paths.map(entry => entry.path).sort(), [other, HELD_PATH].sort(), 'the carrier holds every held file');
  assert.deepEqual(carrier.data.source.skills.map(skill => skill.name).sort(), ['grill', 'tdd'], 'and every held skill');
  const everything = {
    paths: [HELD_PATH, other].map(path => ({ path, displayPath: path, totalLines: 1, state: 'readable', write: [[1, 'x']] })),
    skills: [{ name: 'tdd', text: 'TDD body' }, { name: 'grill', text: 'Grill body' }],
  };
  assert.equal(attempt.data.quote.bEst, renderCarried(everything, CARRIER_TABLE).length / ELIGIBLE_CTP.ascii, 'the quote prices every held file and skill');
});

test('a held view whose effects all lie outside the range leaves the summary tail naming no file and no skill', { skip }, async () => {
  const { events, request } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const outside = seqOf(request);
  const { services, seal } = sealOver(session, {
    heldView: () => ({
      paths: new Map([[HELD_PATH, [1]]]), skills: new Map([['tdd', 'TDD body']]),
      effects: [{ seq: outside, kind: 'path', key: HELD_PATH }, { seq: outside, kind: 'skill', key: 'tdd' }],
    }),
  });
  await preStep(seal, session);

  const tail = services.llm.calls[0].messages.at(-1).content[0].text;
  assert.deepEqual(tail.split('\n').filter(line => /^- (file|skill) /u.test(line)), []);
});

test('the effects of the original result a pruner replacement in the range stands for count with the range\'s, so the file the pruned read held is named in the tail', { skip }, async () => {
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, toolSteps: [1] });
  const original = events.find(event => event.type === 'tool/result');
  const replacement = prunedResult(original, { text: 'pruned once' });
  const at = events.indexOf(original) + 1;
  const { session, seqOf } = sessionOver([systemMessage(), ...events.slice(0, at), replacement, ...events.slice(at)]);
  // The surface the range is taken from holds the replacement, and the original it stands for is no node of it.
  assert.ok(session.surface.nodes.includes(seqOf(replacement)) && !session.surface.nodes.includes(seqOf(original)));
  const readable = async (_agent, key) => ({ read: { status: 'readable', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text: 'x' }] }] }, displayPath: key });
  const { services, seal } = sealOver(session, {
    // The effect of the read belongs to the original, as the projection attributes it: the replacement yields no observation.
    heldView: () => ({
      paths: new Map([[HELD_PATH, [1]]]), skills: new Map(),
      effects: [{ seq: seqOf(original), kind: 'path', key: HELD_PATH }],
    }),
    readUnobserved: readable,
    readFile: readable,
  });
  await preStep(seal, session);

  const tail = services.llm.calls[0].messages.at(-1).content[0].text;
  assert.deepEqual(tail.split('\n').filter(line => /^- (file|skill) /u.test(line)), [`- file ${HELD_PATH}`]);
});

test('a cancel while the quote reads ends the turn as the abort before any attempt: no summary, nothing appended, and the step is not entered', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const controller = new AbortController();
  const cause = { kind: 'user' };
  const llm = answeringSlots();
  // The read itself survives the abort, as the unobserved read does when the execution world refuses: the quote alone does not end the turn.
  const { seal } = sealOver(session, {
    llm,
    heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }),
    readUnobserved: async (...args) => { controller.abort(cause); return emptyRead(...args); },
  });
  const { error, nextCalls } = await failingPreStep(seal, session, { signal: controller.signal });
  assert.equal(error, cause, 'the cause itself');
  assert.equal(nextCalls, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal(session.seq, before);
});

test('the summary call is given the slice the seal froze: its tail rows name each step by the text and calls of the events readSession answered, a failed call as error, and the attempt record and the call record show that same tail, while the commit binds the summaries to the slots\' seqs as before', { skip }, async () => {
  const system = systemMessage();
  const { events, replies } = turnOf({ toolSteps: [2, 5] });
  const failed = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call-1-5');
  failed.data.message.isError = true;
  const { session, seqOf } = sessionOver([system, ...events]);
  const before = session.seq;
  // What the slice holds is what the tail shows: the third reply reads differently in the frozen copy than in the live log.
  const live = session.snapshotEvents();
  const frozen = live.map(event => (event === live[seqOf(replies[2])]
    ? { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'text', text: 'frozen reply 1.3' }] } } }
    : event));
  const { services, seal } = sealOver(session, { readSession: async () => ({ events: frozen }) });

  await preStep(seal, session);

  const [attempt, record, , carrier] = appendedSince(session, before);
  const sent = services.llm.calls[0].messages.at(-1);
  const rows = [];
  for (let step = 1; step <= INNER_QUOTE.minSteps; step += 1) {
    rows.push(`[${step}] assistant step`, `  text: "${step === 3 ? 'frozen reply 1.3' : `reply 1.${step}`}"`);
    if (step === 2) rows.push('  call call-1-2 read → ok');
    if (step === 5) rows.push('  call call-1-5 read → error');
  }
  assert.deepEqual(sent.content[0].text.split('\n').filter(line => /^(\[\d+\] |  text: |  call )/u.test(line)), rows);
  assert.deepEqual(attempt.data.request.messages.tail, sent);
  assert.deepEqual(record.data.input.tail, sent);
  assert.deepEqual(carrier.data.source.slots.map(slot => slot.seqs), replies.map((reply, index) => (
    [seqOf(reply), ...(index === 1 ? [seqOf(events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call-1-2'))] : []),
      ...(index === 4 ? [seqOf(failed)] : [])]
  )));
  assert.deepEqual(carrier.data.source.slots.map(slot => slot.text), rows.filter(row => /^\[/u.test(row)).map((_, index) => `summary ${index + 1}`));
});

// The log of a session's first turn as the native loop writes it: the step opens, the system prompt, the user's task and the harness contexts the first request carries are admitted, the request's header is logged, and `steps` model steps follow.
function nativeFirstTurn({ steps = INNER_QUOTE.minSteps } = {}) {
  const system = systemMessage();
  const task = userMessage({ text: 'the original task' });
  const contexts = ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']
    .map(kind => userMessage({ kind, text: `${kind} admitted before the first request` }));
  const header = requestHeader();
  const events = [system, turnStart(), stepStart(), task, ...contexts, { ...header, data: { ...header.data, header: { ...header.data.header, tools: TOOLS } } }];
  const replies = [];
  for (let step = 1; step <= steps; step += 1) {
    if (step > 1) events.push(stepStart({ turn: 1, step }));
    const reply = assistantMessage({ text: `reply 1.${step}`, turn: 1, step });
    events.push(reply, stepEnd({ turn: 1, step }));
    replies.push(reply);
  }
  events.push(turnEnd());
  return { events, system, task, contexts, replies };
}

test('the seal leaves the initial prefix in H: the system prompt, the original task and the harness contexts of the first request are in no range, slot, prune, replace or cited source, and stay on the surface ahead of the carrier and in the summary call\'s history', { skip }, async () => {
  const { events, system, task, contexts, replies } = nativeFirstTurn();
  const { session, seqOf } = sessionOver(events);
  const prefix = [system, task, ...contexts].map(seqOf);
  const before = session.seq;
  const { services, seal } = sealOver(session);

  await preStep(seal, session);

  const [attempt, record, prune, carrier] = appendedSince(session, before);
  const range = replies.map(seqOf);
  assert.deepEqual(record.data.range, range, 'the range opens with the first model step');
  assert.deepEqual(attempt.data.range, { first: range[0], last: range.at(-1), count: range.length }, 'and so does the attempt\'s');
  assert.deepEqual(prune.data.shadowedSeqs, range);
  assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: range[0], endSeq: range.at(-1) });
  assert.deepEqual([...carrier.sourceEventSeqs].sort((a, b) => a - b), [...range, record.seq, prune.seq].sort((a, b) => a - b));
  assert.deepEqual(carrier.data.source.slots.map(slot => slot.seqs), replies.map(reply => [seqOf(reply)]));
  assert.deepEqual(session.surface.nodes, [...prefix, carrier.seq], 'the prefix stays on the surface, the carrier after it');
  const [call] = services.llm.calls;
  const history = call.messages.slice(0, -1).flatMap(message => (message.content ?? []).map(block => block.text));
  for (const event of [task, ...contexts]) {
    assert.ok(history.includes(event.data.content[0].text), `the summary call's history holds ${event.data.source.kind} verbatim, as reference`);
  }
  const tail = call.messages.at(-1).content[0].text;
  assert.ok([task, ...contexts].every(event => !tail.includes(event.data.content[0].text)), 'the target rows carry no cue of the prefix');
  assert.equal(tail.split('\n').filter(line => line.startsWith('[')).length, replies.length, 'one row for each slot of the range');
});

test('the prune counts the shadowed range at the meter\'s heuristic estimate, not at its route price, and counts no node outside the range, while the quote of the same range is priced under the session\'s pair and reads no meter price', { skip }, async () => {
  const system = systemMessage();
  // The padded range quotes as worth sealing under the default pair.
  const { events, request, replies } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const { session, seqOf } = sessionOver([system, ...events]);
  const range = afterPrefix(session);
  const heuristic = seq => 3 + (seq % 5);
  const prices = Object.fromEntries(range.map(seq => [seq, { tokens: 1000 + seq, heuristicTokens: heuristic(seq) }]));
  prices[seqOf(system)] = { tokens: 7000, heuristicTokens: 900 };
  prices[seqOf(request)] = { tokens: 6000, heuristicTokens: 800 };
  const before = session.seq;
  const { seal } = sealOver(session, { meter: fakeTokenMeter({ prices }) });

  await preStep(seal, session);

  const prune = appendedSince(session, before).find(event => event.type === 'compaction/prune');
  assert.equal(prune.data.shadowedTokenCount, range.reduce((sum, seq) => sum + heuristic(seq), 0));
  const { quote } = appendedSince(session, before)[0].data;
  assert.equal(quote.lA, charsOf(replies) / ELIGIBLE_CTP.ascii, 'L_A is the range\'s text under the pair, not the meter\'s prices');
  assert.notEqual(quote.lA, prune.data.shadowedTokenCount);
});

test('the quote prices the range under the pair the host reads for the session, whatever model the pre-step selects: the same range under another pair quotes another L_A while the prune keeps the meter\'s count', { skip }, async () => {
  const counts = [];
  for (const [ascii, selection] of [[1 / 64, SELECTION], [1 / 128, { provider: 'other', model: 'another-model' }]]) {
    const turn = turnOf({ steps: LONG_STEPS, bulk: BULK });
    const { session } = sessionOver([systemMessage(), ...turn.events], `pair-${ascii}`);
    const before = session.seq;
    const asked = [];
    const { seal } = sealOver(session, { ctpOf: (sessionId) => { asked.push(sessionId); return { ascii, cjk: ascii, version: 1 }; } });
    await preStep(seal, session, { selection });
    assert.deepEqual(asked, [session.id], 'the pair is read once for the session');
    const [attempt, , prune] = appendedSince(session, before);
    assert.equal(attempt.data.quote.lA, charsOf(turn.replies) / ascii);
    counts.push(prune.data.shadowedTokenCount);
  }
  assert.equal(counts[0], counts[1], 'the committed count is the meter\'s, whatever the pair');
});

const LATER_TOOLS = [{ name: 'write', description: 'Write a file.', parameters: { type: 'object', properties: {} } }];
const headerData = (tools, reason = 'change') => ({
  header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' }, ...(tools === undefined ? {} : { tools }) }, reason,
});

// DSH's own pairing checks still read `Session.eventAt`, so a case that takes it away from the session leaves them out; its range holds no tool call.
const withoutPairing = () => kitOf({ toolPairingBalancedBefore: () => true, toolPairingBalancedAfter: () => true });

// The call record the seal appended on one pre-step of `session`, and the options of the one summary call it made.
async function sealedRecord(session, overrides = {}) {
  const before = session.seq;
  const llm = answeringSlots();
  const { seal } = sealOver(session, { llm, ...overrides });
  await preStep(seal, session);
  return { record: appendedSince(session, before).find(event => event.type === INNER_CALL_RECORD_TYPE), call: llm.calls[0] };
}

test('the call record names the request header the summary call sent, found in the live source index when the call is prepared: a header appended after the slice was captured, with Session.eventAt unavailable', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  withoutEventAt(session);
  const earlier = session.snapshotEvents().find(event => event.type === 'request/header');
  // The index the host's feed keeps: it takes each committed event as it commits.
  const index = new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)]));
  let later;

  const { record, call } = await sealedRecord(session, {
    kit: withoutPairing(),
    eventFacts: () => index,
    readSession: async () => {
      const slice = session.snapshotEvents();
      later = session.append('request/header', headerData(LATER_TOOLS));
      index.set(later.seq, eventFactOf(later));
      return { events: slice };
    },
  });

  assert.ok(later.seq > earlier.seq);
  assert.equal(record.data.input.headerSeq, later.seq, 'the header of the request, not the one the slice held');
  assert.equal(record.data.input.throughSeq, later.seq, 'the cut is the log at the call, header included');
  assert.deepEqual(call.tools, LATER_TOOLS, 'the call sent the later header\'s tools');
});

test('the request header the call record names is the one of greatest seq, whatever order the source index was filled in, and none when the log holds no header', { skip }, async () => {
  const { events } = turnOf();
  const second = { ...requestHeader({ reason: 'change' }), data: headerData(LATER_TOOLS) };
  events.splice(events.length - 1, 0, second);
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  withoutEventAt(session);
  const entries = session.snapshotEvents().map(event => [event.seq, eventFactOf(event)]);
  const latest = entries.findLast(([, fact]) => fact.header)[0];
  assert.equal(latest, seqOf(second), 'the later header is the log\'s last');
  // A snapshot merged after live feeds leaves the Map with its later seqs first.
  const { record } = await sealedRecord(session, { kit: withoutPairing(), eventFacts: () => new Map([...entries].reverse()) });
  assert.equal(record.data.input.headerSeq, latest);

  const headerless = sessionOver([systemMessage(), ...turnOf().events.filter(event => event.type !== 'request/header')], 'headerless').session;
  withoutEventAt(headerless);
  const { record: bare, call } = await sealedRecord(headerless, { kit: withoutPairing() });
  assert.equal(bare.data.input.headerSeq, null);
  assert.equal('tools' in call, false);
});

// The stderr lines written while `body` runs.
async function stderrOf(t, body) {
  const lines = [];
  t.mock.method(console, 'error', (...args) => { lines.push(args.map(String).join(' ')); });
  await body();
  t.mock.restoreAll();
  return lines;
}

test('an invalid mode across repeated pre-steps writes one diagnostic per session and seals nothing, and off seals nothing and writes nothing', { skip }, async (t) => {
  const system = systemMessage();
  const sessions = ['invalid-a', 'invalid-b', 'off'].map(id => sessionOver([system, ...turnOf().events], id).session);
  const modes = { 'invalid-a': 'invalid', 'invalid-b': 'invalid', off: 'off' };
  const llm = answeringSlots();
  const { seal } = sealOver(sessions[0], { readMode: session => ({ mode: modes[session.id], locked: true }), llm });
  const before = sessions.map(session => session.seq);

  const lines = await stderrOf(t, async () => {
    for (let round = 0; round < 3; round += 1) {
      for (const session of sessions) assert.equal((await preStep(seal, session)).answer, NEXT_DECISION);
    }
  });

  assert.equal(llm.calls.length, 0, 'no summary is requested');
  assert.deepEqual(sessions.map(session => session.seq), before, 'nothing is appended');
  assert.deepEqual(lines.map(line => line.split(' ')[0]), ['invalid-a', 'invalid-b'], 'one line for each invalid session, none for off');
  assert.ok(lines.every(line => line.includes('inner_mode_invalid')), lines.join('\n'));
});

test('an unready source index permits the next step without sealing: a mode-on session past INNER_QUOTE.minSteps reads no slice, requests no summary and appends nothing', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const llm = answeringSlots();
  let reads = 0;
  const { seal } = sealOver(session, { eventFacts: () => null, readSession: async () => { reads += 1; return { events: session.snapshotEvents() }; }, llm });
  const before = session.seq;

  const { answer, nextCalls } = await preStep(seal, session);

  assert.equal(answer, NEXT_DECISION, 'the decision next() answers is returned as it is');
  assert.equal(nextCalls, 1);
  assert.equal(reads, 0, 'no slice is read');
  assert.equal(llm.calls.length, 0, 'no summary is requested');
  assert.equal(session.seq, before, 'nothing is appended');
});

test('a reply whose JSON syntax fails on unescaped inner quotes is recovered locally and commits after the one request: no second request, one attempt, one call, one prune and the carrier citing that call, the first note as the model meant it', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const range = afterPrefix(session);
  const llm = unescapedSlots();
  const { seal, monitor } = sealOver(session, { llm });

  const { answer, nextCalls } = await preStep(seal, session);

  assert.equal(answer, NEXT_DECISION);
  assert.equal(nextCalls, 1);
  assert.equal(llm.calls.length, 1, 'no second request');
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), SEALED);
  const [attempt, call, prune, carrier] = appended;
  assert.equal(call.data.attempt, attempt.seq);
  assert.deepEqual([...carrier.sourceEventSeqs].sort((a, b) => a - b), [...range, call.seq, prune.seq].sort((a, b) => a - b), 'the carrier cites the call that was recovered');
  assert.deepEqual(carrier.data.source.slots.map(slot => slot.text), [QUOTED_NOTE, ...carrier.data.source.slots.slice(1).map((_, index) => `summary ${index + 2}`)]);
  assert.equal(llmPackage.joinAssistantStreamText(call.data.stream).includes('"1": "Found: \'["one"'), true, 'the raw stream of the record is the reply as it was');
  assert.deepEqual(monitor.live(session.id), []);
});

test('a reply that fails the notes\' format is asked again over the same request, each request an attempt of its own: the first ends failed with its call recorded, the second answers and its attempt commits the carrier', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const range = afterPrefix(session);
  const answering = answeringSlots();
  const llm = sequencedLlm(wrongFormat, answering.stream);
  const { seal, monitor } = sealOver(session, { llm });

  const { answer, nextCalls } = await preStep(seal, session);

  assert.equal(answer, NEXT_DECISION, 'the decision next() answers is returned as it is');
  assert.equal(nextCalls, 1);
  assert.equal(llm.calls.length, 2);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [...FAILED, ...SEALED]);
  const [firstAttempt, firstCall, firstEnd, secondAttempt, secondCall, prune, carrier] = appended;
  assert.equal(firstCall.data.attempt, firstAttempt.seq);
  assert.equal(secondCall.data.attempt, secondAttempt.seq);
  assert.equal(firstEnd.data.outcome, 'failed');
  assert.equal(firstEnd.data.attempt, firstAttempt.seq);
  assert.match(firstEnd.data.reason, /the summary text is not a JSON object of \d+ strings keyed "1" to "\d+"/);
  assert.deepEqual([...carrier.sourceEventSeqs].sort((a, b) => a - b), [...range, secondCall.seq, prune.seq].sort((a, b) => a - b), 'the carrier cites the call that answered, not the one that failed');
  assert.deepEqual(carrier.data.source.slots.map(slot => slot.text), carrier.data.source.slots.map((_, index) => `summary ${index + 1}`));
  assert.deepEqual(monitor.live(session.id), []);
});

test('two replies that fail the notes\' format are asked again until the third answers: three requests in all, the first two attempts ended failed and the third committing the carrier', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const answering = answeringSlots();
  const llm = sequencedLlm(wrongFormat, () => summaryStream([]), answering.stream);
  const { seal, monitor } = sealOver(session, { llm });

  const { answer, nextCalls } = await preStep(seal, session);

  assert.equal(answer, NEXT_DECISION);
  assert.equal(nextCalls, 1);
  assert.equal(llm.calls.length, 3);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [...FAILED, ...FAILED, ...SEALED]);
  const [firstAttempt, , firstEnd, secondAttempt, , secondEnd, thirdAttempt, thirdCall, , carrier] = appended;
  assert.deepEqual([firstEnd.data.attempt, secondEnd.data.attempt], [firstAttempt.seq, secondAttempt.seq]);
  assert.deepEqual([firstEnd.data.outcome, secondEnd.data.outcome], ['failed', 'failed']);
  assert.equal(thirdCall.data.attempt, thirdAttempt.seq);
  assert.ok(carrier.sourceEventSeqs.includes(thirdCall.seq));
  assert.deepEqual(monitor.live(session.id), []);
});

test('a reply that fails the notes\' format at every request ends the turn at the bound with the failure it ended with before: three requests, three failed attempts with their calls recorded, no prune or carrier, and the step not entered', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const nodes = [...session.surface.nodes];
  const llm = recordingLlm(wrongFormat);
  const { seal, monitor } = sealOver(session, { llm });

  const { error, nextCalls } = await failingPreStep(seal, session);

  assert.match(error.message, /^inner seal of session inner-seal failed: the summary text is not a JSON object of \d+ strings keyed "1" to "\d+"$/);
  assert.equal(nextCalls, 0);
  assert.equal(llm.calls.length, 3, 'no fourth request');
  assert.equal(SUMMARY_MAX_REQUESTS, 3);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [...FAILED, ...FAILED, ...FAILED]);
  for (const [at, [attempt, record, end]] of [0, 3, 6].map(start => appended.slice(start, start + 3)).entries()) {
    assert.equal(record.data.attempt, attempt.seq, `request ${at + 1}: its call names its attempt`);
    assert.ok(record.data.stream.length > 0, `request ${at + 1}: its consumed stream is kept`);
    assert.equal(end.data.attempt, attempt.seq);
    assert.equal(end.data.outcome, 'failed');
  }
  assert.equal(appended[8].data.reason, error.message, 'the last end names the error the turn ends with');
  assert.deepEqual(session.surface.nodes, nodes, 'the surface is untouched');
  assert.deepEqual(monitor.live(session.id), []);
});

test('each request of a seal asks the same thing and states its own point: the history, tail, tools, tool history, selection and signal of the first request go again unchanged, no new quote or read is taken, and each call record cuts the log where its own request was prepared', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK }).events]);
  const before = session.seq;
  const range = afterPrefix(session);
  const header = session.snapshotEvents().find(event => event.type === 'request/header');
  const reads = { held: 0, unobserved: 0, state: 0, ratio: 0, pair: 0, committed: 0 };
  const answering = answeringSlots();
  const llm = sequencedLlm(wrongFormat, wrongFormat, answering.stream);
  const signal = new AbortController().signal;
  const { seal } = sealOver(session, {
    llm,
    heldView: () => { reads.held += 1; return { paths: new Map(), skills: new Map(), effects: [] }; },
    readUnobserved: async (...args) => { reads.unobserved += 1; return emptyRead(...args); },
    readFile: async (...args) => { reads.committed += 1; return emptyRead(...args); },
    readState: () => { reads.state += 1; return { asOfSeq: 0, items: {} }; },
    cRatio: () => { reads.ratio += 1; return RATIO; },
    ctpOf: () => { reads.pair += 1; return ELIGIBLE_CTP; },
  });

  await preStep(seal, session, { signal });

  assert.equal(llm.calls.length, 3);
  const [first, ...later] = llm.calls;
  for (const options of later) {
    assert.deepEqual(options.messages, first.messages, 'the history and the tail are the first request\'s, whole');
    assert.deepEqual({ ...options, messages: undefined }, { ...first, messages: undefined });
  }
  assert.equal(first.signal, signal, 'the host signal is the one the request carries');
  assert.deepEqual(first.tools, TOOLS);
  assert.deepEqual({ held: reads.held, unobserved: reads.unobserved, state: reads.state, ratio: reads.ratio, pair: reads.pair }, { held: 1, unobserved: 0, state: 1, ratio: 1, pair: 1 }, 'the held view, the ratio and the pair are read once and the state at the commit alone, none of it again for a request');
  assert.equal(reads.committed, 0, 'no held path, so the commit read none');

  const appended = appendedSince(session, before);
  const attempts = appended.filter(event => event.type === INNER_ATTEMPT_RECORD_TYPE);
  const calls = appended.filter(event => event.type === INNER_CALL_RECORD_TYPE);
  assert.equal(attempts.length, 3);
  assert.equal(calls.length, 3);
  calls.forEach((record, at) => {
    assert.equal(record.data.input.throughSeq, attempts[at].seq - 1, `request ${at + 1}: the cut is the log before its own attempt record`);
    assert.equal(record.data.input.headerSeq, header.seq, `request ${at + 1}: the header it sent`);
    assert.deepEqual(record.data.input.tail, first.messages.at(-1), `request ${at + 1}: the same tail`);
    assert.deepEqual(record.data.range, range, `request ${at + 1}: the same range`);
    assert.deepEqual(record.data.selection, SELECTION);
  });
  assert.ok(calls[0].data.input.throughSeq < calls[1].data.input.throughSeq && calls[1].data.input.throughSeq < calls[2].data.input.throughSeq, 'each cut follows the records of the request before');
  assert.deepEqual(attempts.map(attempt => attempt.data.quote), [attempts[0].data.quote, attempts[0].data.quote, attempts[0].data.quote], 'every attempt keeps the one quote the seal took');
  assert.deepEqual(attempts.map(attempt => attempt.data.range), Array(3).fill(attempts[0].data.range));
  assert.deepEqual(attempts.map(attempt => ({ ...attempt.data.request, throughSeq: null })), Array(3).fill({ ...attempts[0].data.request, throughSeq: null }));
  assert.deepEqual(attempts.map(attempt => attempt.data.request.throughSeq), calls.map(record => record.data.input.throughSeq), 'the attempt record shows the cut its call record names');
});

test('the failed requests leave facts and no live entry, and the seal still commits once: one prune and one carrier citing the request that answered, a single downstream entry, and at most the current attempt live while a request is out', { skip }, async () => {
  const system = systemMessage();
  const { events, request } = turnOf();
  const { session, seqOf } = sessionOver([system, ...events]);
  const before = session.seq;
  const range = afterPrefix(session);
  const answering = answeringSlots();
  let rig;
  const liveAtRequest = [];
  const base = sequencedLlm(wrongFormat, wrongFormat, answering.stream);
  const llm = { calls: base.calls, stream(options) { liveAtRequest.push(rig.monitor.live(session.id).map(entry => entry.attempt)); return base.stream(options); } };
  rig = sealOver(session, { llm });

  const { answer, nextCalls } = await preStep(rig.seal, session);

  assert.equal(answer, NEXT_DECISION);
  assert.equal(nextCalls, 1, 'the step is entered once');
  const appended = appendedSince(session, before);
  const attempts = appended.filter(event => event.type === INNER_ATTEMPT_RECORD_TYPE);
  assert.deepEqual(liveAtRequest, attempts.map(attempt => [attempt.seq]), 'each request is the one live attempt, the failed ones already closed');
  assert.deepEqual(rig.monitor.live(session.id), []);
  assert.equal(appended.filter(event => event.type === 'compaction/prune').length, 1);
  const carriers = appended.filter(event => event.type === 'user/message');
  assert.equal(carriers.length, 1);
  const [prune] = appended.filter(event => event.type === 'compaction/prune');
  const calls = appended.filter(event => event.type === INNER_CALL_RECORD_TYPE);
  assert.deepEqual([...carriers[0].sourceEventSeqs].sort((a, b) => a - b), [...range, calls[2].seq, prune.seq].sort((a, b) => a - b), 'the failed calls are cited by no carrier');
  assert.deepEqual(session.surface.nodes, [seqOf(system), seqOf(request), carriers[0].seq], 'the carrier stands for the whole range');
  assert.deepEqual(rig.published.filter(id => id !== session.id), [], 'every change published is the session\'s');
  assert.equal(calls.length, 3, 'every consumed call is recorded, once');
});

test('the facts of a seal that asked again read as the failed attempts beside the committed one: each attempt row its own reason and its own call, the carrier belonging to the request that answered', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const llm = sequencedLlm(wrongFormat, wrongFormat, answeringSlots().stream);
  const { seal, monitor } = sealOver(session, { llm });

  await preStep(seal, session);

  const appended = appendedSince(session, before);
  const attempts = appended.filter(event => event.type === INNER_ATTEMPT_RECORD_TYPE);
  const ends = appended.filter(event => event.type === INNER_END_RECORD_TYPE);
  const rows = rowsAfter(session, monitor.live(session.id));
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.status])), { [attempts[0].seq]: 'failed', [attempts[1].seq]: 'failed', [attempts[2].seq]: 'committed' });
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual([0, 1].map(at => byId.get(attempts[at].seq).reason), [ends[0].data.reason, ends[1].data.reason]);
  assert.deepEqual(attempts.map(attempt => byId.get(attempt.seq).call.state), ['received', 'received', 'received']);
  assert.deepEqual(attempts.map(attempt => byId.get(attempt.seq).call.finish), ['stop', 'stop', 'stop']);
  assert.equal(byId.get(attempts[2].seq).slots, INNER_QUOTE.minSteps);
  assert.equal(byId.get(attempts[0].seq).slots, null, 'a failed attempt has no carrier and so no slots');
});

test('a cancel is never followed by another request: one that arrives while a format failure is closed ends the turn as the abort with that attempt failed, and one that the reply met first ends its attempt as cancelled, the call recorded', { skip }, async () => {
  const cause = { kind: 'user' };

  const between = sessionOver([systemMessage(), ...turnOf().events], 'between');
  const betweenBefore = between.session.seq;
  const controller = new AbortController();
  const llm = sequencedLlm(wrongFormat, answeringSlots().stream);
  const kit = kitOf();
  // The published change that follows the failed attempt's end is the first one with no entry live and one request made.
  const monitor = createInnerMonitor({ appendPluginRecord: kit.appendPluginRecord, publish: () => { if (llm.calls.length === 1 && monitor.live(between.session.id).length === 0) controller.abort(cause); } });
  const { seal } = sealOver(between.session, { llm, kit, monitor });
  const { error, nextCalls } = await failingPreStep(seal, between.session, { signal: controller.signal });
  assert.equal(error, cause, 'the cause itself');
  assert.equal(nextCalls, 0);
  assert.equal(llm.calls.length, 1, 'no request after the abort');
  const appended = appendedSince(between.session, betweenBefore);
  assert.deepEqual(appended.map(event => event.type), FAILED, 'no second attempt is begun');
  assert.deepEqual(appended[2].data, { v: 1, attempt: appended[0].seq, outcome: 'failed', reason: appended[2].data.reason });
  assert.match(appended[2].data.reason, /the summary text is not a JSON object/);
  assert.deepEqual(monitor.live(between.session.id), []);

  const during = sessionOver([systemMessage(), ...turnOf().events], 'during');
  const duringBefore = during.session.seq;
  const stopped = new AbortController();
  const duringLlm = recordingLlm(() => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    stopped.abort(cause);
    yield* wrongFormat();
  })());
  const { seal: interrupted, monitor: duringMonitor } = sealOver(during.session, { llm: duringLlm });
  const outcome = await failingPreStep(interrupted, during.session, { signal: stopped.signal });
  assert.equal(outcome.error, cause, 'the cause itself');
  assert.equal(duringLlm.calls.length, 1, 'no request after the abort');
  const duringAppended = appendedSince(during.session, duringBefore);
  assert.deepEqual(duringAppended.map(event => event.type), FAILED);
  assert.deepEqual(duringAppended[2].data, { v: 1, attempt: duringAppended[0].seq, outcome: 'cancelled', reason: 'user' });
  assert.deepEqual(duringMonitor.live(during.session.id), []);
});

test('a reply the content filter cut off is asked again on the same model', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const llm = sequencedLlm(filtered, answeringSlots().stream);
  const { seal, monitor } = sealOver(session, { llm, settings: { fallbackModel: FALLBACK } });

  const { answer, nextCalls } = await preStep(seal, session);

  assert.equal(answer, NEXT_DECISION);
  assert.equal(nextCalls, 1);
  assert.deepEqual(llm.calls.map(routeOf), [SELECTION, SELECTION], 'the retry is on the session\'s model');
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [...FAILED, ...SEALED]);
  assert.match(appended[2].data.reason, /the summary stream finished with error: Provider stopped with: content_filtered$/);
  assert.deepEqual(appended.filter(event => event.type === INNER_CALL_RECORD_TYPE).map(event => event.data.selection), [SELECTION, SELECTION]);
  assert.deepEqual(monitor.live(session.id), []);
});

test('a model filtered on both of its requests hands the summary to the backup model of the settings, whose reply commits the carrier: three requests, the third on the backup', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const llm = sequencedLlm(filtered, filtered, answeringSlots().stream);
  const { seal, monitor } = sealOver(session, { llm, settings: { fallbackModel: FALLBACK } });

  const { nextCalls } = await preStep(seal, session);

  assert.equal(nextCalls, 1);
  assert.deepEqual(llm.calls.map(routeOf), [SELECTION, SELECTION, FALLBACK_ROUTE]);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [...FAILED, ...FAILED, ...SEALED]);
  const calls = appended.filter(event => event.type === INNER_CALL_RECORD_TYPE);
  assert.deepEqual(calls.map(event => event.data.selection), [SELECTION, SELECTION, FALLBACK], 'each call record keeps the route its own request took');
  assert.deepEqual(monitor.live(session.id), []);
});

test('a filter that cuts off every rung of the ladder ends the turn as a failed seal: three attempts, each failed with its call recorded, no prune or carrier, and the step not entered', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const nodes = [...session.surface.nodes];
  const llm = recordingLlm(filtered);
  const { seal, monitor } = sealOver(session, { llm, settings: { fallbackModel: FALLBACK } });

  const { error, nextCalls } = await failingPreStep(seal, session);

  assert.match(error.message, /^inner seal of session inner-seal failed: the summary stream finished with error: Provider stopped with: content_filtered$/);
  assert.equal(nextCalls, 0);
  assert.deepEqual(llm.calls.map(routeOf), [SELECTION, SELECTION, FALLBACK_ROUTE], 'no request past the last rung');
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [...FAILED, ...FAILED, ...FAILED]);
  assert.equal(appended[8].data.reason, error.message);
  assert.deepEqual(session.surface.nodes, nodes);
  assert.deepEqual(monitor.live(session.id), []);
});

test('with no backup model in the settings the ladder has two rungs: the second filtered request ends the turn', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const llm = recordingLlm(filtered);
  const { seal } = sealOver(session, { llm, settings: { fallbackModel: null } });

  const { error, nextCalls } = await failingPreStep(seal, session);

  assert.match(error.message, /content_filtered$/);
  assert.equal(nextCalls, 0);
  assert.deepEqual(llm.calls.map(routeOf), [SELECTION, SELECTION]);
  assert.deepEqual(appendedSince(session, before).map(event => event.type), [...FAILED, ...FAILED]);
});

test('a format failure never moves the ladder and a filter failure never spends the format bound: replies that fail the format are asked again on the model the rung names, up to the bound in all, while a filtered rung before them is free', { skip }, async () => {
  const pure = sessionOver([systemMessage(), ...turnOf().events], 'pure');
  const pureLlm = recordingLlm(wrongFormat);
  const { seal: pureSeal } = sealOver(pure.session, { llm: pureLlm, settings: { fallbackModel: FALLBACK } });
  await failingPreStep(pureSeal, pure.session);
  assert.deepEqual(pureLlm.calls.map(routeOf), Array(SUMMARY_MAX_REQUESTS).fill(SELECTION), 'a format failure asks again on the same selection, never on the fallback');

  const mixed = sessionOver([systemMessage(), ...turnOf().events], 'mixed');
  const mixedLlm = sequencedLlm(filtered, filtered, wrongFormat, wrongFormat, wrongFormat, answeringSlots().stream);
  const { seal: mixedSeal } = sealOver(mixed.session, { llm: mixedLlm, settings: { fallbackModel: FALLBACK } });
  await failingPreStep(mixedSeal, mixed.session);
  assert.deepEqual(mixedLlm.calls.map(routeOf), [SELECTION, SELECTION, FALLBACK_ROUTE, FALLBACK_ROUTE, FALLBACK_ROUTE], 'the two ladder steps do not count against the format bound, and the format failures stay on the rung they met');

  const other = sessionOver([systemMessage(), ...turnOf().events], 'other');
  for (const [why, script] of [['another error finish', otherError], ['a finish at the output ceiling', cutShort]]) {
    const llm = recordingLlm(script);
    const { seal } = sealOver(other.session, { llm, settings: { fallbackModel: FALLBACK } });
    await failingPreStep(seal, other.session);
    assert.equal(llm.calls.length, 1, `${why}: no request follows`);
  }
});

test('a text that is not the notes and both kinds of tool call share the one bound: each is asked again on the same selection, and the last failure ends the turn with its own reason', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const nodes = [...session.surface.nodes];
  const llm = sequencedLlm(wrongFormat, toolCalled, toolCallsFinish);
  const { seal, monitor } = sealOver(session, { llm, settings: { fallbackModel: FALLBACK } });

  const { error, nextCalls } = await failingPreStep(seal, session);

  assert.match(error.message, /finished with tool-calls/);
  assert.equal(nextCalls, 0);
  assert.deepEqual(llm.calls.map(routeOf), Array(SUMMARY_MAX_REQUESTS).fill(SELECTION), 'asked again on the same selection up to the bound, never on the fallback');
  assert.deepEqual(appendedSince(session, before).map(event => event.type), Array(SUMMARY_MAX_REQUESTS).fill(FAILED).flat(), 'each request is an attempt of its own, failed with its call recorded');
  assert.deepEqual(session.surface.nodes, nodes);
  assert.deepEqual(monitor.live(session.id), []);
});

test('a tool call that the next request answers in the notes format seals with that answer: the failed attempt is closed first, both requests on the session\'s selection', { skip }, async () => {
  for (const [why, failing] of [['a tool call that stopped', toolCalled], ['a finish of tool-calls', toolCallsFinish]]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events], why);
    const before = session.seq;
    const llm = sequencedLlm(failing, answeringSlots().stream);
    const { seal, monitor } = sealOver(session, { llm, settings: { fallbackModel: FALLBACK } });

    const { nextCalls } = await preStep(seal, session);

    assert.equal(nextCalls, 1, `${why}: the step is entered after the seal`);
    assert.deepEqual(llm.calls.map(routeOf), [SELECTION, SELECTION], why);
    assert.deepEqual(appendedSince(session, before).map(event => event.type), [...FAILED, ...SEALED], why);
    assert.deepEqual(monitor.live(session.id), [], why);
  }
});

test('a cancel is never followed by another rung: one that arrives while a filtered attempt is closed ends the turn as the abort, and one that the filtered reply met first ends its attempt as cancelled', { skip }, async () => {
  const cause = { kind: 'user' };

  const between = sessionOver([systemMessage(), ...turnOf().events], 'between');
  const betweenBefore = between.session.seq;
  const controller = new AbortController();
  const llm = sequencedLlm(filtered, answeringSlots().stream);
  const kit = kitOf();
  const monitor = createInnerMonitor({ appendPluginRecord: kit.appendPluginRecord, publish: () => { if (llm.calls.length === 1 && monitor.live(between.session.id).length === 0) controller.abort(cause); } });
  const { seal } = sealOver(between.session, { llm, kit, monitor, settings: { fallbackModel: FALLBACK } });
  const { error, nextCalls } = await failingPreStep(seal, between.session, { signal: controller.signal });
  assert.equal(error, cause, 'the cause itself');
  assert.equal(nextCalls, 0);
  assert.equal(llm.calls.length, 1, 'no request after the abort');
  assert.deepEqual(appendedSince(between.session, betweenBefore).map(event => event.type), FAILED);

  const during = sessionOver([systemMessage(), ...turnOf().events], 'during');
  const duringBefore = during.session.seq;
  const stopped = new AbortController();
  const duringLlm = recordingLlm(() => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    stopped.abort(cause);
    yield* filtered();
  })());
  const { seal: interrupted, monitor: duringMonitor } = sealOver(during.session, { llm: duringLlm, settings: { fallbackModel: FALLBACK } });
  const outcome = await failingPreStep(interrupted, during.session, { signal: stopped.signal });
  assert.equal(outcome.error, cause, 'the cause itself');
  assert.equal(duringLlm.calls.length, 1, 'no request after the abort');
  const duringAppended = appendedSince(during.session, duringBefore);
  assert.deepEqual(duringAppended.map(event => event.type), FAILED);
  assert.deepEqual(duringAppended[2].data, { v: 1, attempt: duringAppended[0].seq, outcome: 'cancelled', reason: 'user' });
  assert.deepEqual(duringMonitor.live(during.session.id), []);
});

test('a reply that answered in the format is never asked again whatever fails after it: a held file that cannot be read, a range whose surface changed, unbalanced tool pairing, a carrier that cannot be assembled and a commit append that throws each end the attempt failed after the one request', { skip }, async () => {
  const refused = new Error('the prune was refused');
  const cases = [
    ['a held file that cannot be read', {}, { heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }), readFile: async () => { throw new Error('the file is gone'); } }, /the file is gone/],
    ['a range whose surface changed', {
      during: (session) => {
        const result = session.snapshotEvents().find(event => event.type === 'tool/result');
        session.append('tool/result', { ...result.data, message: { ...result.data.message, content: [{ type: 'text', text: 'pruned' }] } },
          { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] });
      },
    }, {}, /surface nodes changed/],
    ['unbalanced tool pairing', {}, { kit: kitOf({ toolPairingBalancedBefore: () => false }) }, /tool pairing is unbalanced/],
    ['a carrier that cannot be assembled', {}, { meter: { measure: () => { throw new Error('the meter has no nodes'); } } }, /the meter has no nodes/],
    ['a commit append that throws', { refuse: 'compaction/prune' }, {}, /the prune was refused/],
  ];
  for (const [why, { during, refuse } = {}, overrides, pattern] of cases) {
    const { session } = sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK, toolSteps: [2] }).events]);
    const before = session.seq;
    if (refuse !== undefined) {
      const append = session.append.bind(session);
      session.append = (type, ...rest) => {
        if (type === refuse) throw refused;
        return append(type, ...rest);
      };
    }
    const answering = answeringSlots();
    const llm = { calls: answering.calls, stream(options) { const stream = answering.stream(options); during?.(session); return stream; } };
    const { seal, monitor } = sealOver(session, { llm, ...overrides });

    const { error, nextCalls } = await failingPreStep(seal, session).catch((thrown) => { throw new Error(`${why}: ${thrown.message}`); });

    assert.match(error.message, pattern, why);
    assert.equal(nextCalls, 0, why);
    assert.equal(llm.calls.length, 1, `${why}: the one request is not repeated`);
    const attempts = appendedSince(session, before).filter(event => event.type === INNER_ATTEMPT_RECORD_TYPE);
    assert.equal(attempts.length, 1, `${why}: one attempt`);
    assert.equal(appendedSince(session, before).filter(event => event.type === INNER_END_RECORD_TYPE).length, 1, `${why}: ended once`);
    assert.deepEqual(monitor.live(session.id), [], why);
  }
});

// One seal of a fresh session whose summary stream reports `usage` (none when undefined) and answers `count` summaries, or one too few when `fail`; answers the stderr lines, the call record appended right behind the attempt record and the range sealed.
async function sealWithUsage(t, usage, { fail = false } = {}) {
  const { session } = sessionOver([systemMessage(), ...turnOf().events], 'usage');
  const before = session.seq;
  const range = afterPrefix(session);
  const llm = fail ? recordingLlm(() => chunks(...(usage === undefined ? [] : [{ type: 'usage', usage }]), { type: 'finish', reason: { kind: 'max-tokens' } })) : answeringSlots(usage);
  const { seal } = sealOver(session, { llm });
  const lines = await stderrOf(t, async () => {
    if (fail) await assert.rejects(preStep(seal, session));
    else await preStep(seal, session);
  });
  return { lines, record: session.eventAt(before + 1), range };
}

test('the seal diagnostic: an uncached share above UNCACHED_SHARE_ALERT, a present zero counting, names the session, the appended record\'s seq, the range, the selection, the share and the constant on success and on consumed-call failure; a share at or below it writes nothing; missing usage or an absent field writes the gap', { skip }, async (t) => {
  const cases = [
    { why: 'cache writes count as uncached', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 300, cacheWriteTokens: 400 }, share: 0.625 },
    { why: 'a present zero counts', usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, share: 1 },
    { why: 'a cached call', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 800, cacheWriteTokens: 100 }, quiet: true },
    { why: 'an even split', usage: { inputTokens: 250, outputTokens: 1, cacheReadTokens: 500, cacheWriteTokens: 250 }, quiet: true },
    { why: 'missing usage', usage: undefined, gap: true },
    { why: 'an absent field', usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 300 }, gap: true },
  ];
  for (const fail of [false, true]) {
    for (const { why, usage, share, quiet, gap } of cases) {
      const label = `${why}${fail ? ' on a failed summary' : ''}`;
      const { lines, record, range } = await sealWithUsage(t, usage, { fail });
      assert.equal(record.type, INNER_CALL_RECORD_TYPE, label);
      if (quiet) {
        assert.deepEqual(lines, [], label);
        continue;
      }
      assert.equal(lines.length, 1, `${label}: ${lines.join('\n')}`);
      const [line] = lines;
      assert.ok(line.startsWith('usage '), label);
      assert.ok(line.includes(`record seq ${record.seq}`), `${label}: ${line}`);
      if (gap) {
        assert.ok(line.includes('inner_usage_gap'), `${label}: ${line}`);
        continue;
      }
      assert.ok(line.includes('inner_uncached_share'), `${label}: ${line}`);
      for (const part of [`range ${range[0]}-${range.at(-1)}`, 'deepseek/deepseek-v4-pro', `share ${share}`, `alert ${UNCACHED_SHARE_ALERT}`]) {
        assert.ok(line.includes(part), `${label}: ${line} lacks ${part}`);
      }
    }
  }
});

// A kit whose `appendPluginRecord` counts the calls it receives by record type and throws the error `refuse` holds for a type, else appends through the real one.
function countingKit({ refuse = {} } = {}) {
  const attempts = {};
  const kit = kitOf({
    appendPluginRecord: (target, type, data) => {
      attempts[type] = (attempts[type] ?? 0) + 1;
      if (Object.hasOwn(refuse, type)) throw refuse[type];
      return sessionPackage.appendPluginRecord(target, type, data);
    },
  });
  return { kit, attempts };
}

// The codes of the diagnostic lines `console.error` was given: a line is `<session> [<scope>] <code>: <message>`.
const codesOf = lines => lines.map(line => /\] (\w+): /u.exec(line)?.[1]);
// The monitor's own lines among them: the seal's, such as the usage gap of a stream that reports none, are not in question where this is read.
const monitorCodesOf = lines => codesOf(lines).filter(code => code.startsWith('inner_monitor_'));

test('a call-record append that fails is not retried, writes no diagnostic claiming a record seq and ends the turn with both failures, the failed end recording the error the turn ends with', { skip }, async (t) => {
  const usage = { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const [why, script] of [
    ['a failed summary', () => summaryStream([], usage)],
    ['a successful summary', null],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const before = session.seq;
    const { kit, attempts } = countingKit({ refuse: { [INNER_CALL_RECORD_TYPE]: new Error('the log refused the record') } });
    const llm = script === null ? answeringSlots(usage) : recordingLlm(script);
    const { seal } = sealOver(session, { kit, llm });
    let error;
    const lines = await stderrOf(t, async () => { ({ error } = await failingPreStep(seal, session)); });
    assert.match(error.message, /the log refused the record/, why);
    if (script !== null) assert.match(error.message, /not a JSON object/, why);
    assert.equal(attempts[INNER_CALL_RECORD_TYPE], 1, `${why}: the call record's append is not retried`);
    assert.equal(llm.calls.length, 1, `${why}: no request follows the refused record, a format failure included`);
    assert.deepEqual(lines, [], `${why}: no diagnostic claims a record seq`);
    const appended = appendedSince(session, before);
    assert.deepEqual(appended.map(event => event.type), [INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE], `${why}: the call record is the one append that failed`);
    assert.equal(appended[1].data.reason, error.message, why);
  }
});

test('a filtered reply whose call record cannot be appended does not move the ladder: no request follows the refused record, and the turn ends with both failures', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const { kit, attempts } = countingKit({ refuse: { [INNER_CALL_RECORD_TYPE]: new Error('the log refused the record') } });
  const llm = recordingLlm(filtered);
  const { seal } = sealOver(session, { kit, llm, settings: { fallbackModel: FALLBACK } });

  const { error, nextCalls } = await failingPreStep(seal, session);

  assert.match(error.message, /content_filtered; its call record could not be appended: the log refused the record$/);
  assert.equal(nextCalls, 0);
  assert.equal(attempts[INNER_CALL_RECORD_TYPE], 1, 'the call record\'s append is not retried');
  assert.equal(llm.calls.length, 1, 'neither the same model nor the fallback is asked');
  assert.deepEqual(appendedSince(session, before).map(event => event.type), [INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE]);
});

test('the settings are read once, before the quote\'s first await: a save that lands while the quote reads and while the requests run changes neither the policy the quote was priced under nor the backup model the retries reach, and the next pre-step takes the saved ones', { skip }, async () => {
  const OTHER = { provider: 'other-provider', model: 'other-model' };
  let current = { preset: 'E2', fallbackModel: FALLBACK };
  let reads = 0;
  const saved = () => { current = { preset: 'X3', fallbackModel: OTHER }; };
  const first = sessionOver([systemMessage(), ...turnOf().events], 'first');
  const before = first.session.seq;
  const llm = sequencedLlm(() => { saved(); return filtered(); }, filtered, answeringSlots().stream);
  const { seal } = sealOver(first.session, {
    llm,
    readSettings: () => { reads += 1; return current; },
    // A save lands while the log is read and again while the quote is priced, both after the settings were read.
    readSession: async () => { saved(); return { events: first.session.snapshotEvents() }; },
    ctpOf: () => { saved(); return ELIGIBLE_CTP; },
  });

  await preStep(seal, first.session);

  assert.equal(reads, 1, 'one read for the pre-step, whatever the quote and its retries do');
  assert.deepEqual(llm.calls.map(routeOf), [SELECTION, SELECTION, FALLBACK_ROUTE], 'the third request reaches the backup model read at the start');
  const appended = appendedSince(first.session, before);
  assert.deepEqual(appended.filter(event => event.type === INNER_ATTEMPT_RECORD_TYPE).map(event => event.data.quote.preset), ['E2', 'E2', 'E2'], 'every attempt keeps the policy the quote was priced under');
  assert.deepEqual(appended.filter(event => event.type === INNER_CALL_RECORD_TYPE).map(event => event.data.selection), [SELECTION, SELECTION, FALLBACK]);

  // The next pre-step, at the same seal, reads what was saved.
  const next = sessionOver([systemMessage(), ...turnOf().events], 'next');
  const nextBefore = next.session.seq;
  const { seal: later } = sealOver(next.session, { readSettings: () => { reads += 1; return current; } });
  await preStep(later, next.session);
  assert.equal(reads, 2);
  assert.equal(appendedSince(next.session, nextBefore)[0].data.quote.preset, 'X3');
});

test('a failure before the request is dispatched leaves no monitor fact and throws the error itself: an unreadable log, a request that cannot be constructed', { skip }, async (t) => {
  const unreadable = new Error('the log is unreadable');
  const unbuildable = new Error('no accumulator');
  for (const [why, overrides, expected] of [
    ['an unreadable log', { readSession: async () => { throw unreadable; } }, unreadable],
    ['a request that cannot be constructed', { kit: kitOf({ AssistantStreamAccumulator: class { constructor() { throw unbuildable; } } }) }, unbuildable],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const before = session.seq;
    const llm = answeringSlots();
    const { seal, monitor, published } = sealOver(session, { llm, ...overrides });
    let outcome;
    const lines = await stderrOf(t, async () => { outcome = await failingPreStep(seal, session); });
    assert.equal(outcome.error, expected, `${why}: the error itself`);
    assert.equal(outcome.nextCalls, 0, why);
    assert.equal(session.seq, before, `${why}: nothing is appended`);
    assert.deepEqual(lines, [], `${why}: no diagnostic`);
    assert.equal(llm.calls.length, 0, why);
    assert.deepEqual(monitor.live(session.id), [], why);
    assert.deepEqual(published, [], `${why}: no change is published`);
  }
});

test('a request that cannot be sent leaves the attempt and a failed end whose reason is the error, no call record, and throws that error itself, retrying nothing', { skip }, async () => {
  const refused = new Error('no adapter for this route');
  for (const [why, llm] of [
    ['a synchronous throw from stream()', recordingLlm(() => { throw refused; })],
    ['an iterable that refuses an iterator', recordingLlm(() => ({ [Symbol.asyncIterator]() { throw refused; } }))],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const before = session.seq;
    const { seal, monitor } = sealOver(session, { llm });

    const { error, nextCalls } = await failingPreStep(seal, session);

    assert.equal(error, refused, `${why}: the error the call raised, itself`);
    assert.equal(nextCalls, 0, why);
    assert.equal(llm.calls.length, 1, `${why}: not retried`);
    const appended = appendedSince(session, before);
    assert.deepEqual(appended.map(event => event.type), [INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE], why);
    assert.deepEqual(appended[1].data, { v: 1, attempt: appended[0].seq, outcome: 'failed', reason: 'no adapter for this route' }, why);
    assert.deepEqual(monitor.live(session.id), [], why);
  }
});

const HELD_PATH = '/repo/src/held.js';

// An appended carrier whose source carries `paths`, as an earlier seal left it on the surface.
function carrierWith(paths) {
  const source = { kind: INNER_SEAL_KIND, v: 1, slots: [], paths };
  return { ...userMessage({ text: 'earlier seal' }), data: { ...userMessage({ text: 'earlier seal' }).data, content: renderCarrier(source, CARRIER_TABLE), source } };
}

// A session `[system, h1, carrier, ...one turn of INNER_QUOTE.minSteps steps, step 1 with a tool call]` whose first request header precedes the carrier, as a log written by the loop has it, a seal that holds HELD_PATH's line 1 as `x` and whose B read runs `during(session)` before it answers.
function commitRig({ during = () => {}, kit, services = {}, tools } = {}) {
  const h1 = userMessage({ text: 'earlier ask' });
  const carrier = carrierWith([]);
  // The held line's B is under this padded range's text, so the quote passes.
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, toolSteps: [1], ...(tools === undefined ? {} : { tools }) });
  const { session, seqOf } = sessionOver([systemMessage(), h1, requestHeader(), carrier, ...events]);
  const { seal } = sealOver(session, {
    ...(kit === undefined ? {} : { kit }),
    ...services,
    heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }),
    readFile: async (_agent, key) => {
      during(session);
      return { read: { status: 'readable', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text: 'x' }] }] }, displayPath: key };
    },
  });
  return { session, seal, seqOf, h1, carrier, range: session.surface.nodes.slice(3) };
}

test('the commit refuses a range whose surface nodes changed, appending the attempt, the call record and a failed end, while a change outside the range alone commits against the commit-time baseline, a prefix changing length included', { skip }, async () => {
  const pruned = commitRig({
    during: (session) => {
      const result = session.snapshotEvents().find(event => event.type === 'tool/result');
      session.append('tool/result', { ...result.data, message: { ...result.data.message, content: [{ type: 'text', text: 'pruned' }] } },
        { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] });
    },
  });
  const before = pruned.session.seq;
  await assert.rejects(preStep(pruned.seal, pruned.session), /surface/);
  assert.deepEqual(typesSince(pruned.session, before), [INNER_ATTEMPT_RECORD_TYPE, 'tool/result', INNER_CALL_RECORD_TYPE, INNER_END_RECORD_TYPE], 'a changed range is refused, the pruner\'s replacement between the attempt and the call record');

  let replacement;
  const outside = commitRig({
    during: (session) => {
      const nodes = session.surface.nodes;
      const fresh = carrierWith([{ path: HELD_PATH, displayPath: HELD_PATH, totalLines: 1, state: 'readable', write: [[1, 'x']] }]);
      replacement = session.append('user/message', fresh.data, { surfaceOp: { op: 'replace', startSeq: nodes[1], endSeq: nodes[2] }, sourceEventSeqs: [nodes[1], nodes[2]] });
    },
  });
  const outsideBefore = outside.session.seq;
  await preStep(outside.seal, outside.session);
  const appended = appendedSince(outside.session, outsideBefore).filter(event => event.seq !== replacement.seq);
  assert.deepEqual(appended.map(event => event.type), SEALED, 'an outside change alone commits');
  const carrier = appended[3];
  assert.deepEqual(outside.session.surface.nodes, [0, replacement.seq, carrier.seq], 'the shorter prefix stays before the carrier');
  assert.deepEqual(carrier.data.source.paths, [], 'the commit-time baseline already carries the held line');
});

test('the commit refuses unbalanced tool pairing at either end and a pairing check that throws, appending the attempt, the call record and a failed end', { skip }, async () => {
  for (const [why, overrides] of [
    ['unbalanced before the range', { toolPairingBalancedBefore: () => false }],
    ['unbalanced after the range', { toolPairingBalancedAfter: () => false }],
    ['a throwing check', { toolPairingBalancedAfter: () => { throw new Error('seq absent'); } }],
  ]) {
    const { session, seal } = commitRig({ kit: kitOf(overrides) });
    const before = session.seq;
    await assert.rejects(preStep(seal, session), /pairing/, why);
    assert.deepEqual(typesSince(session, before), FAILED, why);
  }
});

test('a cancel observed before the replace appends the attempt, the call record and a cancelled end and propagates the abort, and a cancel after it leaves the commit standing', { skip }, async () => {
  const controller = new AbortController();
  const reason = new Error('the user cancelled');
  const { session, seal } = commitRig({ during: () => controller.abort(reason) });
  const before = session.seq;
  await assert.rejects(preStep(seal, session, { signal: controller.signal }), error => error === reason);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), FAILED);
  assert.deepEqual(appended[2].data, { v: 1, attempt: appended[0].seq, outcome: 'cancelled', reason: 'the user cancelled' });

  const late = new AbortController();
  const after = commitRig();
  const lateBefore = after.session.seq;
  let decision;
  await after.seal({ agent: { id: after.session.id, session: after.session }, messages: [], turn: 2, step: 1, signal: late.signal, modelSelection: SELECTION },
    async () => { late.abort(reason); decision = { kind: 'reject' }; return decision; }).then(answer => assert.equal(answer, decision));
  assert.deepEqual(typesSince(after.session, lateBefore), SEALED, 'the commit stands, and no end is written for it');
  assert.equal(after.session.surface.nodes.at(-1), lateBefore + 3, 'the carrier stays on the surface');
});

test('a cancel that stops the summary stream appends the attempt, the consumed call\'s record and a cancelled end and propagates the abort', { skip }, async () => {
  const controller = new AbortController();
  const reason = new Error('the user cancelled');
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const llm = recordingLlm(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    controller.abort(reason);
    throw reason;
  });
  const { seal } = sealOver(session, { llm });
  const before = session.seq;
  await assert.rejects(preStep(seal, session, { signal: controller.signal }), error => error === reason);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), FAILED);
  assert.equal(appended[1].data.thrown.message, 'the user cancelled');
  assert.deepEqual(appended[2].data, { v: 1, attempt: appended[0].seq, outcome: 'cancelled', reason: 'the user cancelled' });
});

const FILE_REF = { attachmentId: 'sha256:file', name: 'notes.txt', bytes: 3 };
const IMAGE_REF = { attachmentId: 'sha256:upload', mediaType: 'image/jpeg', bytes: 4, width: 2, height: 2, name: 'shot.png' };
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xdb]);

// A session whose request carries a file and an image block, and attachments whose `readImage` answers the normalized JPEG and whose `saveFile` records each save and answers its ref, or rejects with `saveError`.
function attachmentRig({ saveError } = {}) {
  const { events } = turnOf();
  // A task logged after the first request's header, so it is source of the range, not the initial prefix.
  const request = userMessage({ text: 'see these' });
  request.data.content = [{ type: 'text', text: 'see these' }, { type: 'file', attachment: FILE_REF }, { type: 'image', attachment: IMAGE_REF }];
  events.splice(events.findIndex(event => event.type === 'assistant/message'), 0, request);
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const saves = [];
  const reads = [];
  const attachments = {
    async readImage(ref) { reads.push(ref); return { ref: { ...ref }, data: IMAGE_BYTES }; },
    async saveFile(input) {
      saves.push(input);
      if (saveError !== undefined) throw saveError;
      return { attachmentId: 'sha256:saved', name: input.name, bytes: input.data.length };
    },
  };
  return { session, seqOf, request, saves, reads, ...sealOver(session, { attachments }) };
}

test('a file block of A moves to its slot\'s place in the carrier, and an image block\'s normalized bytes are saved as a file named for the returned media type behind the sentence naming the original attachment', { skip }, async () => {
  const { session, seqOf, request, saves, reads, seal } = attachmentRig();
  const before = session.seq;
  await preStep(seal, session);

  assert.deepEqual(reads, [IMAGE_REF]);
  assert.equal(saves.length, 1);
  assert.deepEqual([...saves[0].data], [...IMAGE_BYTES], 'exactly the bytes readImage answered');
  assert.equal(saves[0].name, 'shot.jpg', 'the extension of the normalized media type, not of the display name');
  const carrier = session.eventAt(before + 3);
  const [slot] = carrier.data.source.slots;
  assert.deepEqual(slot.seqs, [seqOf(request)], 'the later task is the range\'s first slot');
  const saved = { attachmentId: 'sha256:saved', name: 'shot.jpg', bytes: IMAGE_BYTES.length };
  assert.deepEqual(slot.attachments, [{ file: FILE_REF }, { file: saved, image: { attachmentId: IMAGE_REF.attachmentId, name: IMAGE_REF.name } }]);
  const blocks = carrier.data.content;
  assert.deepEqual(blocks.filter(block => block.type === 'file').map(block => block.attachment), [FILE_REF, saved]);
  const behind = blocks[blocks.findIndex(block => block.type === 'file' && block.attachment.attachmentId === saved.attachmentId) - 1];
  assert.equal(behind.type, 'text');
  assert.ok(behind.text.endsWith(`${CARRIER_WORDING.imageSaved(IMAGE_REF.name, CARRIER_TABLE.imageReadTool)}\n`), `the saved image's file block follows its sentence's line: ${JSON.stringify(behind.text)}`);
});

test('a failed image save is a summary failure: the attempt, the call record and a failed end, and an error that ends the turn', { skip }, async () => {
  const { session, seal } = attachmentRig({ saveError: new Error('disk full') });
  const before = session.seq;
  await assert.rejects(preStep(seal, session), /disk full/);
  assert.deepEqual(typesSince(session, before), FAILED);
});

test('the carrier cites the call record, the prune, every shadowed node and, for a pruner replacement pruned again, the original result it stands for', { skip }, async () => {
  const { events } = turnOf({ toolSteps: [1] });
  const original = events.find(event => event.type === 'tool/result');
  const r1 = prunedResult(original, { text: 'pruned once' });
  const r2 = prunedResult(r1, { text: 'pruned twice' });
  const at = events.indexOf(original) + 1;
  const { session, seqOf } = sessionOver([systemMessage(), ...events.slice(0, at), r1, r2, ...events.slice(at)]);
  const range = afterPrefix(session);
  assert.ok(range.includes(seqOf(r2)) && !range.includes(seqOf(original)), 'r2 stands on the surface for the original');
  const before = session.seq;
  const { seal } = sealOver(session);
  await preStep(seal, session);

  const [, record, prune, carrier] = appendedSince(session, before);
  assert.deepEqual([...carrier.sourceEventSeqs].sort((a, b) => a - b),
    [record.seq, prune.seq, ...range, seqOf(original)].sort((a, b) => a - b));
});

// A question batch and its answer as `ask_user_question` logs them: the arguments as the raw JSON string the model wrote, the answer as the JSON text of the result. The question and the custom answer run far past any cut of a user's text, with line breaks inside, a multiple choice answered with two labels and a custom text beside them; the options and their descriptions are the model's explanation for the user and the detail its supporting text.
const LONG_QUESTION = `Which release plan do we follow?\nWeigh the rollback cost, the audit window and the on-call load.\n${'Consider every dependent service in turn. '.repeat(160)}`;
const PLAN_CUSTOM = `Ship the API now,\nhold the UI until the audit window closes. ${'Then re-check the on-call rota. '.repeat(60)}`;
const EXPLANATIONS = ['Cut the release today.\nTell on-call first.', 'Hold for the audit window.', 'Ship the API, hold the UI.', 'The audit window closes on Friday.\nA rollback is a revert.'];
const PLAN_ARGUMENTS = JSON.stringify({
  questions: [
    {
      id: 'plan', header: 'Release plan', question: LONG_QUESTION, detail: EXPLANATIONS[3],
      options: [{ label: 'Ship now', description: EXPLANATIONS[0] }, { label: 'Wait', description: EXPLANATIONS[1] }, { label: 'Split', description: EXPLANATIONS[2] }],
      multiSelect: true,
    },
    { id: 'owner', question: 'Who owns the rollout?', options: [{ label: 'Platform' }, { label: 'Product' }] },
  ],
});
const PLAN_RESULT = JSON.stringify({
  answers: [
    { id: 'plan', selected: ['Ship now', 'Split'], custom: PLAN_CUSTOM },
    { id: 'owner', selected: ['Platform'] },
  ],
});
// A recording `llm` answering `notes(count)`, the notes of the slots the tail names, as the object keyed "1" to the count.
const notingSlots = notes => recordingLlm((options) => {
  const count = Number(/slot numbers "1" to "(\d+)"/.exec(options.messages.at(-1).content[0].text)[1]);
  return summaryStream(notes(count));
});

// The positions of `parts` in `text`, each from `indexOf`, which an assertion holds present and ascending.
const placesIn = (text, parts) => parts.map(part => text.indexOf(part));
const ascending = places => places.every((at, index) => at >= 0 && (index === 0 || at > places[index - 1]));

test('a step that asked the user carries each question\'s original text and the user\'s own answer beside its note, in the step\'s place among the notes: the labels the user selected and the custom text whole, the options, their descriptions and the detail left out, and the note the model wrote, restating the answer, stays as written', { skip }, async () => {
  const { events, replies } = turnOf({ asks: { 3: [{ id: 'call_ask_plan', arguments: PLAN_ARGUMENTS, result: { text: PLAN_RESULT } }] } });
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  const restated = 'Required — the user answered the release plan: ship the API now and hold the UI until the audit window closes.';
  const llm = notingSlots(count => Array.from({ length: count }, (_, index) => (index === 2 ? restated : `summary ${index + 1}`)));
  const { seal } = sealOver(session, { llm });

  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  const { slots } = carrier.data.source;
  const answer = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_ask_plan');
  assert.deepEqual(slots.map(slot => slot.seqs), replies.map((reply, index) => (index === 2 ? [seqOf(reply), seqOf(answer)] : [seqOf(reply)])), 'the step\'s result stays in the step\'s slot');
  assert.deepEqual(slots[2].questions, [
    { question: LONG_QUESTION, user: `Ship now\nSplit\n${PLAN_CUSTOM}` },
    { question: 'Who owns the rollout?', user: 'Platform' },
  ]);
  assert.equal(slots[2].text, restated, 'the note is the model\'s, nothing taken out of it');
  assert.deepEqual(slots.map(slot => Object.hasOwn(slot, 'questions')), slots.map((_, index) => index === 2), 'no other slot has the field');
  assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), 'the body is the source rendered');
  // Independent of the wording: whatever frames them, the originals stand in the body whole, in the order note, question, answer, question, answer, next note.
  const body = carrier.data.content[0].text;
  assert.ok(ascending(placesIn(body, [restated, LONG_QUESTION, 'Ship now\nSplit\n', PLAN_CUSTOM, 'Who owns the rollout?', 'Platform', slots[3].text])), 'the originals follow the step\'s note, before the next note');
  for (const explanation of EXPLANATIONS) assert.ok(!body.includes(explanation), `the model's explanation is no part of the body: ${explanation}`);
  assert.ok(!body.includes('Wait') && !body.includes('Product'), 'the options the user did not select are no part of the body');
  assert.ok(body.startsWith(`${CARRIER_TABLE.addresses} ${CARRIER_WORDING.questionMark}`), 'the address sentence names the question lines');
  assert.equal(llm.calls.length, 1, 'one summary call, over the slots as before');
});

// One ask answered as `result`, with `arguments`, at the third step of a range that seals; answers the carrier the seal committed and the session's appended types.
async function sealedAsk({ arguments: args = PLAN_ARGUMENTS, result, mutate = () => {} }) {
  const { events } = turnOf({ asks: { 3: [{ id: 'call_ask_plan', arguments: args, result }] } });
  mutate(events);
  const { session } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  const { seal } = sealOver(session);
  await preStep(seal, session);
  return { carrier: appendedSince(session, before).find(event => event.type === 'user/message'), types: typesSince(session, before) };
}

test('what cannot give a question with the user\'s own answer adds nothing, and the seal commits as it would without it: a result the tool marked as an error, text that is no answer, arguments that are no questions, a result that no call id pairs, answers that name no question, a selection of nothing with no custom text, a malformed answer that voids the well-formed answers beside it', { skip }, async () => {
  const unpaired = (events) => {
    const answer = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_ask_plan');
    answer.data.message.toolCallId = 'call_elsewhere';
    answer.data.message.source.callId = 'call_elsewhere';
  };
  const nothing = JSON.stringify({ answers: [{ id: 'plan', selected: [] }, { id: 'owner', selected: [], custom: '' }] });
  for (const [why, ask] of [
    ['a result the tool marked as an error', { result: { text: 'Error: ask_user_question was aborted before the user answered', isError: true } }],
    ['an error flag over text that reads as an answer', { result: { text: PLAN_RESULT, isError: true } }],
    ['a result text that is no JSON', { result: { text: 'The user is away.' } }],
    ['arguments that are no JSON', { arguments: '{"questions":[{"id":"plan","question":', result: { text: PLAN_RESULT } }],
    ['arguments with no questions list', { arguments: '{"question":"Which?"}', result: { text: PLAN_RESULT } }],
    ['a result that holds no answers list', { result: { text: '{"answers":"yes"}' } }],
    ['a selection that is no list of labels', { result: { text: JSON.stringify({ answers: [{ id: 'plan', selected: 'Ship now' }] }) } }],
    ['a label that is no text', { result: { text: JSON.stringify({ answers: [{ id: 'plan', selected: [1] }] }) } }],
    ['a malformed answer beside a well-formed one', { result: { text: JSON.stringify({ answers: [{ id: 'plan', selected: ['Ship now'] }, { id: 'owner', selected: [1] }] }) } }],
    ['a custom answer that is no text beside a well-formed one', { result: { text: JSON.stringify({ answers: [{ id: 'plan', selected: ['Ship now'] }, { id: 'owner', selected: ['Platform'], custom: 3 }] }) } }],
    ['answers that name no question', { result: { text: JSON.stringify({ answers: [{ id: 'elsewhere', selected: ['Ship now'] }] }) } }],
    ['a result no call id pairs', { result: { text: PLAN_RESULT }, mutate: unpaired }],
    ['a selection of nothing and no custom text', { result: { text: nothing } }],
  ]) {
    const { carrier, types } = await sealedAsk(ask);
    assert.deepEqual(types, SEALED, why);
    const { slots } = carrier.data.source;
    assert.deepEqual(slots.map(slot => Object.keys(slot)), slots.map(() => ['seqs', 'text']), `${why}: no field, no stand-in`);
    assert.deepEqual(carrier.data.content, [{ type: 'text', text: [CARRIER_TABLE.addresses, ...slots.map(slot => `${CARRIER_WORDING.slotLine(slot.seqs)}${slot.text}`)].join('\n') }], `${why}: the body is the notes alone, as without an ask`);
  }
});

test('a slot whose frozen events cannot be read for its questions, whatever the reading throws, adds nothing and the seal commits: the supplement is dropped, no other error with it', { skip }, async (t) => {
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, asks: { 3: [{ id: 'call_ask_plan', arguments: PLAN_ARGUMENTS, result: { text: PLAN_RESULT } }] } });
  const { session } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  // The slice the seal froze holds a result whose call id cannot be read, which the log's own validation never lets in; the quote prices the message's content alone.
  const live = session.snapshotEvents();
  const unreadable = message => Object.defineProperty({ ...message }, 'toolCallId', { enumerable: true, get() { throw new Error('the call id cannot be read'); } });
  const frozen = live.map(event => (event.type === 'tool/result' && event.data.message.toolCallId === 'call_ask_plan'
    ? { ...event, data: { ...event.data, message: unreadable(event.data.message) } }
    : event));
  const { seal } = sealOver(session, { readSession: async () => ({ events: frozen }) });
  await stderrOf(t, async () => { await preStep(seal, session); });
  assert.deepEqual(typesSince(session, before), SEALED);
  const { slots } = appendedSince(session, before).find(event => event.type === 'user/message').data.source;
  assert.deepEqual(slots.map(slot => Object.keys(slot)), slots.map(() => ['seqs', 'text']));
});

test('a refusal, a custom answer with no selection and a question the user left unanswered are what the user said: the non-empty answers stand under their questions, bound by id whatever order the answers come in, and the question with no text of the user\'s adds nothing beside them', { skip }, async () => {
  const REFUSAL = 'No.\nNot until the audit window has closed.';
  const args = JSON.stringify({
    questions: [
      { id: 'a', question: 'Ship today?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'b', question: 'Who owns the rollout?\nName one team.', options: [{ label: 'Platform' }] },
      { id: 'c', question: 'Anything else?' },
      { id: 'd', question: 'Notify on-call?', options: [{ label: 'Yes' }, { label: 'No' }] },
    ],
  });
  const result = JSON.stringify({
    answers: [
      { id: 'd', selected: ['No'] },
      { id: 'c', selected: [] },
      { id: 'b', selected: [], custom: 'Neither;\nask the infra team.' },
      { id: 'a', selected: ['No'], custom: REFUSAL },
    ],
  });
  const { carrier } = await sealedAsk({ arguments: args, result: { text: result } });
  assert.deepEqual(carrier.data.source.slots[2].questions, [
    { question: 'Ship today?', user: `No\n${REFUSAL}` },
    { question: 'Who owns the rollout?\nName one team.', user: 'Neither;\nask the infra team.' },
    { question: 'Notify on-call?', user: 'No' },
  ], 'the questions in the order they were asked, each with the answer of its own id');
  const body = carrier.data.content[0].text;
  assert.ok(ascending(placesIn(body, ['Ship today?', `No\n${REFUSAL}`, 'Who owns the rollout?\nName one team.', 'Neither;\nask the infra team.', 'Notify on-call?'])), 'the originals stand whole in the body, in order');
  assert.ok(!body.includes('Anything else?'), 'the question the user gave no words to is no part of the body');
});

test('a result the pruner replaced twice gives its answer from the original it stands for, from the frozen events, never from the pruned text that stood in the range: the slot keeps the replacement beside the original in its seqs, and the pairing is by call id', { skip }, async () => {
  const { events, replies } = turnOf({ asks: { 2: [{ id: 'call_ask_plan', arguments: PLAN_ARGUMENTS, result: { text: PLAN_RESULT } }] } });
  const original = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call_ask_plan');
  const r1 = prunedResult(original, { text: 'pruned once' });
  const r2 = prunedResult(r1, { text: 'pruned twice' });
  const at = events.indexOf(original) + 1;
  const { session, seqOf } = sessionOver([systemMessage(), ...events.slice(0, at), r1, r2, ...events.slice(at)]);
  assert.ok(session.surface.nodes.includes(seqOf(r2)) && !session.surface.nodes.includes(seqOf(original)), 'r2 stands on the surface for the original');
  const before = session.seq;
  const { seal } = sealOver(session);

  await preStep(seal, session);

  const { slots } = appendedSince(session, before).find(event => event.type === 'user/message').data.source;
  assert.deepEqual(slots[1].seqs, [seqOf(replies[1]), seqOf(original), seqOf(r2)]);
  assert.deepEqual(slots[1].questions, [
    { question: LONG_QUESTION, user: `Ship now\nSplit\n${PLAN_CUSTOM}` },
    { question: 'Who owns the rollout?', user: 'Platform' },
  ]);
});

test('several question calls keep their own pairing and order: two asks of one step that also read a file, their results logged in the other order, and an ask of a later step, each in its own slot beside its own note, the other tool\'s call and result left to the note and the slot', { skip }, async () => {
  const answerOf = (id, ...selected) => JSON.stringify({ answers: [{ id, selected, ...(id === 'b' ? { custom: 'Not before Friday' } : {}) }] });
  const argumentsOf = id => JSON.stringify({ questions: [{ id, question: `Question ${id}?\nWith a second line.`, options: [{ label: 'Yes' }, { label: 'No' }] }] });
  const { events, replies } = turnOf({
    toolSteps: [4],
    asks: {
      4: [{ id: 'call_a', arguments: argumentsOf('a'), result: { text: answerOf('a', 'Yes') } }, { id: 'call_b', arguments: argumentsOf('b'), result: { text: answerOf('b', 'No') } }],
      6: [{ id: 'call_c', arguments: argumentsOf('c'), result: { text: answerOf('c', 'Later') } }],
    },
  });
  const resultOf = id => events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id);
  // The tools answer in the order they finish: b before a.
  const [first, second] = [resultOf('call_a'), resultOf('call_b')];
  const slotsAt = [events.indexOf(first), events.indexOf(second)];
  events[slotsAt[0]] = second;
  events[slotsAt[1]] = first;
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  const { seal } = sealOver(session);

  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  const { slots } = carrier.data.source;
  assert.deepEqual(slots[3].seqs, [seqOf(replies[3]), seqOf(resultOf('call-1-4')), seqOf(second), seqOf(first)], 'the slot keeps its results in the order they were logged');
  assert.deepEqual(slots[3].questions, [{ question: 'Question a?\nWith a second line.', user: 'Yes' }, { question: 'Question b?\nWith a second line.', user: 'No\nNot before Friday' }], 'calls in the order they were made, each with its own result');
  assert.deepEqual(slots[5].questions, [{ question: 'Question c?\nWith a second line.', user: 'Later' }]);
  assert.deepEqual(slots.map(slot => Object.hasOwn(slot, 'questions')), slots.map((_, index) => index === 3 || index === 5));
  assert.deepEqual(slots.map(slot => slot.text), slots.map((_, index) => `summary ${index + 1}`), 'every step has its note, the asking ones included');
  assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), 'the body is the source rendered');
  const body = carrier.data.content[0].text;
  assert.ok(ascending(placesIn(body, [
    slots[3].text, 'Question a?\nWith a second line.', 'Yes', 'Question b?\nWith a second line.', 'No\nNot before Friday', slots[4].text, slots[5].text, 'Question c?\nWith a second line.', 'Later', slots[6].text,
  ])), 'each question and answer follow their own note, in the order the calls were made');
});

test('a seal over steps that asked nothing, tool calls of other tools among them, leaves every slot with its seqs and note alone and renders the address sentence and one line per note, as a carrier did before the exchanges', { skip }, async () => {
  const { events } = turnOf({ toolSteps: [2, 5] });
  const { session } = sessionOver([systemMessage(), ...events]);
  const before = session.seq;
  const { seal } = sealOver(session);

  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  const { slots } = carrier.data.source;
  assert.deepEqual(slots.map(slot => Object.keys(slot)), slots.map(() => ['seqs', 'text']));
  assert.deepEqual(carrier.data.content, [{ type: 'text', text: [CARRIER_TABLE.addresses, ...slots.map(slot => `${CARRIER_WORDING.slotLine(slot.seqs)}${slot.text}`)].join('\n') }]);
});

test('a second seal whose range holds an old carrier, kept in a checkpoint\'s tail, builds B against only the carriers outside the range on the commit-time surface, so the old carrier\'s lines are carried again', { skip }, async () => {
  const h1 = userMessage({ text: 'earlier ask' });
  const old = carrierWith([{ path: HELD_PATH, displayPath: HELD_PATH, totalLines: 1, state: 'readable', write: [[1, 'x']] }]);
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const checkpoint = compactCheckpoint({ startSeq: h1.seq, endSeq: h1.seq });
  const { session, seqOf } = sessionOver([systemMessage(), h1, old, ...events, checkpoint]);
  assert.deepEqual(session.surface.nodes.slice(0, 3), [0, seqOf(checkpoint), seqOf(old)], 'the checkpoint keeps the old carrier in its tail');
  const before = session.seq;
  const { seal } = sealOver(session, {
    heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }),
    readFile: async (_agent, key) => ({ read: { status: 'readable', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text: 'x' }] }] }, displayPath: key }),
  });
  await preStep(seal, session);

  const [, record, , carrier] = appendedSince(session, before);
  assert.equal(record.data.range[0], seqOf(old), 'the old carrier is ordinary source of the range');
  assert.deepEqual(carrier.data.source.paths, [{ path: HELD_PATH, displayPath: HELD_PATH, totalLines: 1, state: 'readable', write: [[1, 'x']] }]);
});

const SHOWN_BODY = ['first line of the held block, long enough', 'second line of the held block, long enough', 'third line of the held block, long enough'];
const shownAt = first => ({ path: HELD_PATH, displayPath: HELD_PATH, totalLines: 40, state: 'readable', write: SHOWN_BODY.map((text, at) => [first + at, text]) });
// A seal whose held view holds `texts` from line `first` of a 40-line file, read as it stands on disk.
const heldAt = (first, texts) => ({
  heldView: () => ({ paths: new Map([[HELD_PATH, texts.map((_, at) => first + at)]]), skills: new Map(), effects: [] }),
  readFile: async (_agent, key) => ({
    read: { status: 'readable', totalLines: 40, windows: [{ offset: first, lines: texts.map((text, at) => ({ number: first + at, text })) }] }, displayPath: key,
  }),
});
const heldShiftedBody = heldAt(6, SHOWN_BODY);

test('a held block that moved to other lines with its text unchanged is left out of the new carrier\'s body when a carrier still on the request shows that text: the source writes every line and withdraws the old ones, `omit` names the lines, and the content is the source rendered', { skip }, async () => {
  const h1 = userMessage({ text: 'earlier ask' });
  const old = carrierWith([shownAt(1)]);
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const { session } = sessionOver([systemMessage(), h1, old, ...events]);
  const before = session.seq;
  const { seal } = sealOver(session, heldShiftedBody);
  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  const [entry] = carrier.data.source.paths;
  assert.deepEqual(entry, { path: HELD_PATH, displayPath: HELD_PATH, totalLines: 40, write: shownAt(6).write, withdraw: [1, 2, 3], omit: [6, 7, 8] },
    'every line is written, the old ones withdrawn, and every line is the one omitted');
  assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), 'the body is the source rendered');
  assert.equal(renderCarried(carrier.data.source, CARRIER_TABLE), null, 'the withdrawals are no part of B, which has nothing else to say');
  const body = carrier.data.content.map(block => block.text ?? '').join('');
  for (const text of SHOWN_BODY) assert.ok(!body.includes(text), 'no row of the omitted lines is in the body');
  assert.ok(!body.includes('(total lines:'), 'and no file block');
});

test('a held block that moved by less than its length, a brace line it shares with the old place carried by the baseline, is left out whole by the new carrier although its write is in pieces', { skip }, async () => {
  const OLD = ['alpha', '}', 'beta', '}', 'gamma'];
  const h1 = userMessage({ text: 'earlier ask' });
  const old = carrierWith([{ ...shownAt(1), write: OLD.map((text, at) => [1 + at, text]) }]);
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const { session } = sessionOver([systemMessage(), h1, old, ...events]);
  const before = session.seq;
  const { seal } = sealOver(session, heldAt(3, OLD));
  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  const [entry] = carrier.data.source.paths;
  assert.deepEqual(entry.write, [[3, 'alpha'], [5, 'beta'], [6, '}'], [7, 'gamma']], 'the brace at 4 is the baseline\'s own');
  assert.deepEqual([entry.withdraw, entry.omit], [[1, 2], [3, 5, 6, 7]]);
  assert.ok(!carrier.data.content.at(-1).text.includes('gamma'), 'no written line is in the body');
});

test('a held block that moved and gained a line shows the new line alone, under the path, where the moved lines are left out', { skip }, async () => {
  const h1 = userMessage({ text: 'earlier ask' });
  const old = carrierWith([shownAt(1)]);
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const { session } = sessionOver([systemMessage(), h1, old, ...events]);
  const before = session.seq;
  const { seal } = sealOver(session, heldAt(6, [...SHOWN_BODY, 'a fourth line, new to the request']));
  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  assert.deepEqual(carrier.data.source.paths[0].omit, [6, 7, 8]);
  const body = carrier.data.content.at(-1).text;
  assert.ok(body.includes(`${HELD_PATH} (total lines: 40)\n9: a fourth line, new to the request`), body);
  for (const text of SHOWN_BODY) assert.ok(!body.includes(text), text);
});

test('a carrier in the range, replaced by the new one, is no carrier on the request to refer to: its text is shown again', { skip }, async () => {
  const h1 = userMessage({ text: 'earlier ask' });
  const old = carrierWith([shownAt(1)]);
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK });
  const checkpoint = compactCheckpoint({ startSeq: h1.seq, endSeq: h1.seq });
  const { session } = sessionOver([systemMessage(), h1, old, ...events, checkpoint]);
  const before = session.seq;
  const { seal } = sealOver(session, heldShiftedBody);
  await preStep(seal, session);

  const carrier = appendedSince(session, before).find(event => event.type === 'user/message');
  assert.equal(carrier.data.source.paths[0].omit, undefined);
  for (const text of SHOWN_BODY) assert.ok(carrier.data.content.at(-1).text.includes(text), text);
});

test('when the cheap check and the frozen slice disagree, the slice\'s range, count and pause decide the summary and the commit', { skip }, async () => {
  const { events, replies } = turnOf({ steps: INNER_QUOTE.minSteps + 1 });
  const { session, seqOf } = sessionOver([systemMessage(), ...events]);
  const factsOf = s => new Map(s.snapshotEvents().map(event => [event.seq, eventFactOf(event)]));
  // The index wrongly takes the first reply for a checkpoint: its range starts after it, still at INNER_QUOTE.minSteps.
  const stale = factsOf(session);
  stale.set(seqOf(replies[0]), { ...stale.get(seqOf(replies[0])), marker: 'checkpoint' });
  const before = session.seq;
  const { seal } = sealOver(session, { eventFacts: () => stale });
  await preStep(seal, session);
  const record = session.eventAt(before + 1);
  assert.equal(record.data.range[0], seqOf(replies[0]), 'the slice\'s range starts after the initial prefix');
  assert.equal(session.eventAt(before + 3).data.source.slots.length, INNER_QUOTE.minSteps + 1, 'one slot per step of the slice');

  // The index misses a skeleton call that the slice holds: the slice is paused, so nothing is summarized.
  const paused = turnOf();
  const call = paused.replies.at(-1);
  call.data.message.content.push({ type: 'tool-call', id: 'skeleton-1', name: 'get_turn_skeleton', arguments: '{}' });
  const held = sessionOver([systemMessage(), ...paused.events]).session;
  const unpaused = factsOf(held);
  for (const [seq, fact] of unpaused) unpaused.set(seq, { ...fact, skeletonCall: false });
  const llm = answeringSlots();
  const { seal: pausedSeal } = sealOver(held, { eventFacts: () => unpaused, llm });
  const heldBefore = held.seq;
  const { answer } = await preStep(pausedSeal, held);
  assert.equal(answer, NEXT_DECISION);
  assert.equal(llm.calls.length, 0, 'a paused slice is not summarized');
  assert.equal(held.seq, heldBefore);
});

test('the surface capture and the slice read share one synchronous stretch: an event appended right after the cheap check is in neither', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const late = { seq: null };
  const slices = [];
  const { seal } = sealOver(session, {
    eventFacts: () => {
      queueMicrotask(() => { late.seq = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'late' }], source: { kind: 'user' }, id: 'late' }, { surfaceOp: 'append' }).seq; });
      return new Map(session.snapshotEvents().map(event => [event.seq, eventFactOf(event)]));
    },
    heldView: (_id, events) => { slices.push(events.map(event => event.seq)); return { paths: new Map(), skills: new Map(), effects: [] }; },
  });
  await preStep(seal, session);
  assert.notEqual(late.seq, null);
  assert.ok(!slices[0].includes(late.seq), 'the slice ends before the late event');
  const carrier = session.snapshotEvents().findLast(event => event.data?.source?.kind === INNER_SEAL_KIND);
  assert.equal(session.surface.nodes.at(-1), late.seq, 'the late event stays after the carrier, outside the range');
  assert.ok(!carrier.sourceEventSeqs.includes(late.seq));
});

test('no event comes between the commit checks and the three appends', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const kit = kitOf({
    toolPairingBalancedAfter: (target, seq) => {
      queueMicrotask(() => kit.appendPluginRecord(target, 'plugin:session-watcher/probe', { v: 1 }));
      return compactionPackage.toolPairingBalancedAfter(target, seq);
    },
  });
  const { seal } = sealOver(session, { kit });
  await preStep(seal, session);
  assert.deepEqual(typesSince(session, before), [...SEALED, 'plugin:session-watcher/probe']);
});

test('the invalid-mode diagnostic is once per session id for the seal\'s lifetime, so a Session object built again for the same session writes no second line', { skip }, async (t) => {
  const events = [systemMessage(), ...turnOf().events];
  const first = sessionOver(events, 'same-session').session;
  const again = sessionOver(events, 'same-session').session;
  const { seal } = sealOver(first, { readMode: () => ({ mode: 'invalid', locked: true }) });
  const lines = await stderrOf(t, async () => {
    await preStep(seal, first);
    await preStep(seal, again);
  });
  assert.equal(lines.length, 1, lines.join('\n'));
});

test('a throw after the stream was consumed and before the commit appends, from the carrier factory or the measurement, appends the attempt, the call record and a failed end and ends the turn with it', { skip }, async () => {
  for (const [why, overrides, pattern] of [
    ['a carrier factory that throws', { kit: kitOf({ createUserMessage: () => { throw new Error('the message is not well formed'); } }) }, /the message is not well formed/],
    ['a measurement that throws', { meter: { measure: () => { throw new Error('the meter has no fold'); } } }, /the meter has no fold/],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK }).events]);
    const before = session.seq;
    const { seal } = sealOver(session, overrides);
    await assert.rejects(preStep(seal, session), pattern, why);
    assert.deepEqual(typesSince(session, before), FAILED, why);
  }
});

test('the question supplement is optional and nothing else is: over a range that holds an answered question, a carrier factory that throws, a cancel the commit meets and an unbalanced tool pairing each still end the attempt as failed or cancelled and reach the turn as they did', { skip }, async () => {
  const reason = new Error('the user cancelled');
  const controller = new AbortController();
  const asked = () => sessionOver([systemMessage(), ...turnOf({ asks: { 3: [{ id: 'call_ask_plan', arguments: PLAN_ARGUMENTS, result: { text: PLAN_RESULT } }] } }).events]).session;
  const cases = [
    ['a carrier factory that throws', { kit: kitOf({ createUserMessage: () => { throw new Error('the message is not well formed'); } }) }, {}, error => /the message is not well formed/.test(error.message)],
    ['a cancel while the commit reads', {
      heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }),
      readFile: async (...args) => { controller.abort(reason); return emptyRead(...args); },
    }, { signal: controller.signal }, error => error === reason],
    ['an unbalanced tool pairing', { kit: kitOf({ toolPairingBalancedAfter: () => false }) }, {}, error => /tool pairing is unbalanced/.test(error.message)],
  ];
  for (const [why, overrides, options, matches] of cases) {
    const session = asked();
    const before = session.seq;
    const { seal } = sealOver(session, overrides);
    await assert.rejects(preStep(seal, session, options), matches, why);
    assert.deepEqual(typesSince(session, before), FAILED, why);
  }
});

// ── The attempt the monitor records around the call ───────────────────────────────────────────────────────

test('the attempt record is appended before the summary request is sent and shows that request: the route, the C tail, the history, tool and tool-update counts and the cut, no history body, while the call receives the options untouched', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const header = session.snapshotEvents().find(event => event.type === 'request/header');
  const derived = session.deriveMessages();
  const toolHistory = session.toolHistory();
  const before = session.seq;
  const range = afterPrefix(session);
  const signal = new AbortController().signal;
  const llm = answeringSlots();
  // The kit's appender states how many requests had been sent when each record was appended.
  const sentAt = [];
  const kit = kitOf({ appendPluginRecord: (target, type, data) => { sentAt.push([type, llm.calls.length]); return sessionPackage.appendPluginRecord(target, type, data); } });
  const { seal } = sealOver(session, { llm, kit });

  const lines = await stderrOf(t, async () => { await preStep(seal, session, { signal }); });

  assert.deepEqual(monitorCodesOf(lines), [], 'a healthy run costs the monitor no line');
  assert.deepEqual(sentAt, [[INNER_ATTEMPT_RECORD_TYPE, 0], [INNER_CALL_RECORD_TYPE, 1]], 'the attempt record is appended before the request is sent, the call record after it');
  const [sent] = llm.calls;
  assert.equal(sent.signal, signal, 'the request carries the pre-step signal itself');
  assert.deepEqual(sent, {
    provider: SELECTION.provider, model: SELECTION.model, reasoningEffort: SELECTION.reasoningEffort,
    messages: [...derived, sent.messages.at(-1)], tools: TOOLS, toolHistory, sessionId: session.id, purpose: 'inner-compaction', signal,
  }, 'the options are the request\'s, nothing added and nothing dropped');
  assert.equal(sent.messages.at(-1).role, 'user');
  const [attempt, record] = appendedSince(session, before);
  assert.equal(attempt.data.quote.trigger, 'quote', 'the attempt record keeps the quote it was triggered on');
  assert.deepEqual(attempt.data, {
    v: 1,
    quote: attempt.data.quote,
    range: { first: range[0], last: range.at(-1), count: range.length },
    request: {
      options: { provider: SELECTION.provider, model: SELECTION.model, reasoningEffort: SELECTION.reasoningEffort, purpose: 'inner-compaction', sessionId: session.id },
      messages: { count: derived.length, tail: sent.messages.at(-1) },
      throughSeq: before - 1,
      headerSeq: header.seq,
      tools: { count: TOOLS.length },
      toolHistory: { updates: [] },
    },
  });
  for (const body of ['please work', 'You are a coding agent.']) assert.equal(JSON.stringify(attempt.data).includes(body), false, `the history body ${JSON.stringify(body)} is not in the record`);
  assert.deepEqual(Object.keys(record.data).sort(), ['attempt', 'endedAt', 'input', 'purpose', 'range', 'selection', 'stream', 'v'], 'the call record keeps its fields and gains the attempt and the end time');
  assert.equal(record.data.attempt, attempt.seq);
  assert.equal(typeof record.data.endedAt, 'number');
  assert.deepEqual(record.data.input, { throughSeq: before - 1, headerSeq: header.seq, tail: sent.messages.at(-1) });
  assert.deepEqual(record.data.selection, SELECTION);
});

test('a legal input with no reasoning effort, no tools and no request header still gets its attempt record, which shows none of them', { skip }, async (t) => {
  for (const selection of [{ provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: undefined }]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events.filter(event => event.type !== 'request/header')], 'bare');
    const before = session.seq;
    const llm = answeringSlots();
    const { seal } = sealOver(session, { llm });

    const lines = await stderrOf(t, async () => { await preStep(seal, session, { selection }); });

    assert.deepEqual(monitorCodesOf(lines), [], 'the monitor wrote no line');
    assert.equal('tools' in llm.calls[0], false);
    const [attempt, record] = appendedSince(session, before);
    assert.equal(attempt.type, INNER_ATTEMPT_RECORD_TYPE, 'the attempt record is appended');
    assert.deepEqual(Object.keys(attempt.data.request).sort(), ['headerSeq', 'messages', 'options', 'throughSeq', 'toolHistory']);
    assert.deepEqual(Object.keys(attempt.data.request.options).sort(), ['model', 'provider', 'purpose', 'sessionId']);
    assert.equal(attempt.data.request.headerSeq, null);
    assert.equal(record.data.attempt, attempt.seq);
  }
});

// A text block that carries `text`, with `rest` after it.
const textStream = (text, ...rest) => chunks(
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  ...rest,
);
const STOP = { type: 'finish', reason: { kind: 'stop' } };

test('each way a consumed summary can fail leaves the attempt, the call record and a failed end whose reason is the error the turn ends with, retrying nothing and entering no step', { skip }, async (t) => {
  const cases = [
    ['a stream that throws', async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; throw new Error('the connection reset'); }, /the summary stream threw: the connection reset/],
    ['a stream without a finish chunk', () => textStream('[]'), /ended without a finish chunk/],
    ['a finish that is not a stop', () => textStream('[]', { type: 'finish', reason: { kind: 'max-tokens' } }), /finished with max-tokens/],
  ];
  for (const [why, script, pattern] of cases) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const before = session.seq;
    const llm = recordingLlm(script);
    const { seal, monitor } = sealOver(session, { llm });

    let outcome;
    const lines = await stderrOf(t, async () => { outcome = await failingPreStep(seal, session); });
    const { error, nextCalls } = outcome;

    assert.deepEqual(monitorCodesOf(lines), [], `${why}: the monitor wrote no line`);
    assert.match(error.message, pattern, why);
    assert.equal(nextCalls, 0, `${why}: the step is not entered`);
    assert.equal(llm.calls.length, 1, `${why}: nothing is retried`);
    const appended = appendedSince(session, before);
    assert.deepEqual(appended.map(event => event.type), FAILED, why);
    assert.deepEqual(appended[2].data, { v: 1, attempt: appended[0].seq, outcome: 'failed', reason: error.message }, why);
    assert.equal(appended[1].data.attempt, appended[0].seq, `${why}: the call record names the attempt`);
    assert.deepEqual(monitor.live(session.id), [], why);
  }
});

test('a commit append that throws ends the attempt as failed and throws the append\'s own error, leaving the facts written before it', { skip }, async (t) => {
  for (const [why, refused, expected] of [
    ['the prune', 'compaction/prune', FAILED],
    ['the carrier', 'user/message', [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, 'compaction/prune', INNER_END_RECORD_TYPE]],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const refusal = new Error(`${why} refused`);
    const append = session.append.bind(session);
    session.append = (type, ...rest) => {
      if (type === refused) throw refusal;
      return append(type, ...rest);
    };
    const before = session.seq;
    const { seal, monitor } = sealOver(session);

    let outcome;
    const lines = await stderrOf(t, async () => { outcome = await failingPreStep(seal, session); });
    const { error, nextCalls } = outcome;

    assert.deepEqual(monitorCodesOf(lines), [], `${why}: the monitor wrote no line`);
    assert.equal(error, refusal, `${why}: the append's own error`);
    assert.equal(nextCalls, 0, why);
    const appended = appendedSince(session, before);
    assert.deepEqual(appended.map(event => event.type), expected, why);
    assert.deepEqual(appended.at(-1).data, { v: 1, attempt: appended[0].seq, outcome: 'failed', reason: refusal.message }, why);
    assert.deepEqual(monitor.live(session.id), [], why);
  }
});

// The cancel causes the agent loop aborts a turn with, and how an end record shows each.
const CANCEL_CAUSES = [
  ['a user cancel', { kind: 'user' }, 'user'],
  ['a parent cancel', { kind: 'parent' }, 'parent'],
  ['a hook cancel', { kind: 'hook', reason: 'a hook ended the turn' }, 'hook: a hook ended the turn'],
  ['a disposed agent', { kind: 'disposed' }, 'disposed'],
];

test('a cancel the loop made ends the attempt as cancelled with its cause readable, whether it came while the summary streamed or while a held file was read, and the turn ends with the cause itself', { skip }, async (t) => {
  for (const [why, cause, shown] of CANCEL_CAUSES) {
    const midStream = new AbortController();
    const streaming = sessionOver([systemMessage(), ...turnOf().events]);
    const streamed = recordingLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      midStream.abort(cause);
      throw new Error('This operation was aborted');
    });
    const whileReading = new AbortController();
    const reading = sessionOver([systemMessage(), ...turnOf({ steps: LONG_STEPS, bulk: BULK }).events]);
    // The read ends with an error of its own, not the cause.
    const read = (_agent, _key, _ranges, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('the read was aborted')), { once: true });
      whileReading.abort(cause);
    });
    for (const [where, { session }, controller, overrides] of [
      ['in the stream', streaming, midStream, { llm: streamed }],
      ['in a held-file read', reading, whileReading, { heldView: () => ({ paths: new Map([[HELD_PATH, [1]]]), skills: new Map(), effects: [] }), readFile: read }],
    ]) {
      const before = session.seq;
      const { seal, monitor } = sealOver(session, overrides);

      let outcome;
      const lines = await stderrOf(t, async () => { outcome = await failingPreStep(seal, session, { signal: controller.signal }); });
      const { error, nextCalls } = outcome;

      assert.deepEqual(monitorCodesOf(lines), [], `${why} ${where}: the monitor wrote no line`);
      assert.equal(error, cause, `${why} ${where}: the cause itself`);
      assert.equal(nextCalls, 0, `${why} ${where}`);
      const appended = appendedSince(session, before);
      assert.deepEqual(appended.map(event => event.type), FAILED, `${why} ${where}`);
      assert.deepEqual(appended[2].data, { v: 1, attempt: appended[0].seq, outcome: 'cancelled', reason: shown }, `${why} ${where}`);
      assert.deepEqual(monitor.live(session.id), [], `${why} ${where}`);
    }
  }
});

test('the live entry of an attempt is generating once the request is dispatched, validating from the stream\'s end with the call\'s own end time, and gone once the carrier stands, every change published', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const answering = answeringSlots();
  const phases = [];
  const entries = [];
  let rig;
  // What the registry holds at a point of the run.
  const peek = (point) => {
    const live = rig.monitor.live(session.id);
    phases.push([point, live.map(entry => entry.phase)]);
    entries.push(live[0]);
  };
  const streamed = [];
  const llm = {
    calls: answering.calls,
    stream(options) {
      peek('request');
      return (async function* () {
        for await (const chunk of answering.stream(options)) {
          streamed.push(chunk.type);
          yield chunk;
          peek(`after ${chunk.type}`);
        }
      })();
    },
  };
  // The state is read at the commit, after the response is validated and before the carrier is appended.
  rig = sealOver(session, { llm, readState: () => { peek('state read'); return { asOfSeq: 0, items: {} }; } });

  const lines = await stderrOf(t, async () => { await preStep(rig.seal, session); });
  peek('sealed');

  assert.deepEqual(monitorCodesOf(lines), [], 'the monitor wrote no line');
  assert.deepEqual(phases, [
    ['request', ['generating']],
    ...streamed.map(type => [`after ${type}`, ['generating']]),
    ['state read', ['validating']],
    ['sealed', []],
  ]);
  const [attempt, record] = appendedSince(session, before);
  const [generating] = entries;
  assert.equal(generating.attempt, attempt.seq);
  assert.equal(generating.endedAt, null);
  assert.deepEqual(generating.request, attempt.data.request);
  assert.equal(generating.tools, llm.calls[0].tools, 'the tools are the array the request carries, by reference');
  assert.deepEqual(generating.stream(), record.data.stream, 'stream() answers the accumulator\'s snapshot as it stands');
  const validating = entries.at(-2);
  assert.equal(validating.endedAt, record.data.endedAt, 'the entry holds the call\'s own end time');
  assert.deepEqual(rig.published, Array(1 + streamed.length + 1 + 1).fill(session.id), 'the dispatch, each chunk, the response and the commit each publish once');
});

test('the step\'s own decision stays outside the attempt: a next() that throws after the commit leaves the commit standing, run once, with no end record behind it', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const { seal, monitor } = sealOver(session);
  const refused = new Error('the step was refused');
  let nextCalls = 0;

  let error;
  const lines = await stderrOf(t, async () => {
    error = await seal(
      { agent: { id: session.id, session }, messages: [], turn: 2, step: 1, signal: new AbortController().signal, modelSelection: SELECTION },
      async () => { nextCalls += 1; throw refused; },
    ).then(() => assert.fail('the pre-step answered'), thrown => thrown);
  });

  assert.deepEqual(monitorCodesOf(lines), [], 'the monitor wrote no line');
  assert.equal(error, refused);
  assert.equal(nextCalls, 1);
  assert.deepEqual(typesSince(session, before), SEALED, 'the commit stands and nothing follows it');
  assert.deepEqual(monitor.live(session.id), []);
});

// ── The monitor's own failures stay out of the seal ───────────────────────────────────────────────────────

test('an attempt record that cannot be appended costs the monitor one line and the call record its link, and the seal commits or fails as it does without a monitor, nothing retried and no end written', { skip }, async (t) => {
  for (const [why, llm, pattern] of [
    ['a commit', answeringSlots(), undefined],
    ['a summary failure', recordingLlm(cutShort), /finished with max-tokens/],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const before = session.seq;
    const { kit, attempts } = countingKit({ refuse: { [INNER_ATTEMPT_RECORD_TYPE]: new Error('the log refused the attempt') } });
    const { seal, monitor, published } = sealOver(session, { kit, llm });
    let outcome;
    const lines = await stderrOf(t, async () => {
      outcome = pattern === undefined ? await preStep(seal, session) : await failingPreStep(seal, session);
    });

    if (pattern === undefined) assert.equal(outcome.nextCalls, 1, why);
    else assert.match(outcome.error.message, pattern, why);
    const appended = appendedSince(session, before);
    assert.deepEqual(appended.map(event => event.type), pattern === undefined ? SEALED.slice(1) : [INNER_CALL_RECORD_TYPE], why);
    assert.equal(Object.hasOwn(appended[0].data, 'attempt'), false, `${why}: the call record is the old shape, with no attempt`);
    assert.equal(typeof appended[0].data.endedAt, 'number', why);
    assert.deepEqual(monitorCodesOf(lines), ['inner_monitor_start_failed'], why);
    assert.deepEqual(attempts, { [INNER_ATTEMPT_RECORD_TYPE]: 1, [INNER_CALL_RECORD_TYPE]: 1 }, `${why}: nothing is retried, and with no attempt there is no end to write`);
    assert.deepEqual(monitor.live(session.id), [], why);
    assert.deepEqual(published, [], `${why}: with no entry there is no change to publish`);
  }
});

test('an end record that cannot be appended costs the monitor one line, leaves the attempt without a terminal fact and no entry live, and the turn ends with the error it would have ended with', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const { kit, attempts } = countingKit({ refuse: { [INNER_END_RECORD_TYPE]: new Error('the log refused the end') } });
  const { seal, monitor } = sealOver(session, { kit, llm: recordingLlm(cutShort) });
  let error;
  const lines = await stderrOf(t, async () => { ({ error } = await failingPreStep(seal, session)); });

  assert.match(error.message, /finished with max-tokens/);
  assert.doesNotMatch(error.message, /refused the end/);
  assert.deepEqual(typesSince(session, before), [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE]);
  assert.deepEqual(monitorCodesOf(lines), ['inner_monitor_end_failed']);
  assert.equal(attempts[INNER_END_RECORD_TYPE], 1, 'the end is not retried');
  assert.deepEqual(monitor.live(session.id), [], 'the entry is gone with no terminal fact written');
});

test('a publish that throws changes neither the seal\'s outcome nor its facts, costs a line for each publish, and leaves no entry live', { skip }, async (t) => {
  for (const [why, llm, expected] of [
    ['a commit', answeringSlots(), SEALED],
    ['a summary failure', recordingLlm(cutShort), FAILED],
  ]) {
    const { session } = sessionOver([systemMessage(), ...turnOf().events]);
    const before = session.seq;
    const kit = kitOf();
    const publishes = [];
    const monitor = createInnerMonitor({ appendPluginRecord: kit.appendPluginRecord, publish: (sessionId) => { publishes.push(sessionId); throw new Error('the hub is closed'); } });
    const { seal } = sealOver(session, { kit, llm, monitor });
    let outcome;
    const lines = await stderrOf(t, async () => {
      outcome = expected === SEALED ? await preStep(seal, session) : await failingPreStep(seal, session);
    });

    if (expected === SEALED) assert.equal(outcome.nextCalls, 1, why);
    else assert.match(outcome.error.message, /finished with max-tokens/, why);
    assert.deepEqual(typesSince(session, before), expected, why);
    assert.ok(publishes.length > 0, `${why}: the monitor published`);
    assert.deepEqual(monitorCodesOf(lines), publishes.map(() => 'inner_monitor_publish_failed'), `${why}: a line for each publish`);
    assert.deepEqual(monitor.live(session.id), [], why);
  }
});

// ── What the monitor's read side makes of the facts the seal wrote ────────────────────────────────────────

// The values the read side takes of DSH, bound where these cases read the facts: the seal's own kit has no use for the stream assembler.
const readKitOf = () => ({
  pluginRecordOf: sessionPackage.pluginRecordOf,
  assembleAssistantStream: llmPackage.assembleAssistantStream,
  lastAssistantStreamChunk: llmPackage.lastAssistantStreamChunk,
});

// The rows the read side makes of the facts `session` holds and the entries `live` lists: the projection folded over the whole log, as the registry folds it.
function rowsAfter(session, live = []) {
  const kit = readKitOf();
  const projection = innerMonitorProjection(kit);
  const state = session.snapshotEvents().reduce((folded, event) => projection.apply(folded, event), projection.init());
  return rowsOf(state, live, kit);
}

// The text of the C tail a summary request carried, the prompt.
const promptOf = options => options.messages.at(-1).content[0].text;

test('the facts of a sealed attempt read as one committed row: the attempt record\'s id, time and range, the call\'s end time, usage and response, the carrier\'s time and slots, and the prompt the request carried, cut at PREVIEW_SOURCE_CHARS', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const llm = answeringSlots({ inputTokens: 100, outputTokens: 7, totalTokens: 807, cacheReadTokens: 700, cacheWriteTokens: 0 });
  const { seal, monitor } = sealOver(session, { llm });

  await preStep(seal, session);

  const [attempt, record, , carrier] = appendedSince(session, before);
  const prompt = promptOf(llm.calls[0]);
  assert.ok(prompt.length > PREVIEW_SOURCE_CHARS, 'a real prompt is longer than a summary keeps');
  assert.deepEqual(rowsAfter(session, monitor.live(session.id)), [{
    id: attempt.seq,
    revision: carrier.seq,
    status: 'committed',
    startedAt: attempt.time,
    endedAt: carrier.time,
    range: attempt.data.range,
    reason: null,
    slots: INNER_QUOTE.minSteps,
    call: {
      state: 'received', endedAt: record.data.endedAt, finish: 'stop', thrown: null,
      input: prompt.slice(0, PREVIEW_SOURCE_CHARS),
      output: notesTextOf(Array.from({ length: INNER_QUOTE.minSteps }, (_, index) => `summary ${index + 1}`)),
      outputDisplay: Array.from({ length: INNER_QUOTE.minSteps }, (_, index) => `summary ${index + 1}`).join('\n'),
      usage: { input: 100, output: 7, cacheRead: 700, cacheWrite: 0 },
    },
    contextChange: { before: null, after: null, delta: null, miss: null },
    trigger: { q: attempt.data.quote.q, kappa: attempt.data.quote.kappa },
    stepN: INNER_QUOTE.minSteps,
    cRatio: RATIO,
    epoch: 0,
  }]);
});

test('the facts of a summary that failed after its stream was consumed read as a failed row with the reason the turn ended with, and those of a cancel as a cancelled row with its cause and the stream that threw', { skip }, async (t) => {
  const failing = sessionOver([systemMessage(), ...turnOf().events]).session;
  const failingBefore = failing.seq;
  const failedRig = sealOver(failing, { llm: recordingLlm(() => textStream('{"1":"only one"}', { type: 'finish', reason: { kind: 'max-tokens' } })) });
  let error;
  const failedLines = await stderrOf(t, async () => { ({ error } = await failingPreStep(failedRig.seal, failing)); });
  assert.deepEqual(monitorCodesOf(failedLines), [], 'the monitor wrote no line');

  const [attempt, record, end] = appendedSince(failing, failingBefore);
  const [failed] = rowsAfter(failing, failedRig.monitor.live(failing.id));
  assert.deepEqual([failed.id, failed.status, failed.reason, failed.endedAt, failed.revision, failed.slots], [attempt.seq, 'failed', error.message, end.time, end.seq, null]);
  assert.deepEqual(failed.call, { state: 'received', endedAt: record.data.endedAt, finish: 'max-tokens', thrown: null, input: promptOf(failedRig.services.llm.calls[0]).slice(0, PREVIEW_SOURCE_CHARS), output: '{"1":"only one"}', outputDisplay: 'only one', usage: null });

  const controller = new AbortController();
  const cancelling = sessionOver([systemMessage(), ...turnOf().events]).session;
  const cancellingBefore = cancelling.seq;
  const cancelledRig = sealOver(cancelling, {
    llm: recordingLlm(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      controller.abort({ kind: 'user' });
      throw new Error('This operation was aborted');
    }),
  });
  const cancelledLines = await stderrOf(t, async () => { await failingPreStep(cancelledRig.seal, cancelling, { signal: controller.signal }); });
  assert.deepEqual(monitorCodesOf(cancelledLines), [], 'the monitor wrote no line');

  const [, cancelledRecord, cancelledEnd] = appendedSince(cancelling, cancellingBefore);
  const [cancelled] = rowsAfter(cancelling, cancelledRig.monitor.live(cancelling.id));
  assert.deepEqual([cancelled.status, cancelled.reason, cancelled.endedAt], ['cancelled', 'user', cancelledEnd.time]);
  assert.deepEqual([cancelled.call.state, cancelled.call.thrown, cancelled.call.finish], ['error', cancelledRecord.data.thrown.message, null]);
});

test('the facts of a stream that ran to its finish chunk and then did not assemble read as a received call with its thrown message beside it, in a failed attempt: the call state is the transport\'s alone', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  // An image block that never closes: the stream ends at its stop, then the assembler of DSH refuses what it streamed.
  const { seal, monitor } = sealOver(session, { llm: recordingLlm(() => chunks({ type: 'block-start', index: 0, blockType: 'image' }, STOP)) });
  let error;
  const lines = await stderrOf(t, async () => { ({ error } = await failingPreStep(seal, session)); });
  assert.deepEqual(monitorCodesOf(lines), [], 'the monitor wrote no line');

  const [, record, end] = appendedSince(session, before);
  assert.equal(record.data.stream.some(each => each.chunk?.type === 'finish'), true, 'the recorded stream holds its finish chunk');
  assert.equal(typeof record.data.thrown.message, 'string', 'and the call holds the throw of the assembly');
  const [row] = rowsAfter(session, monitor.live(session.id));
  assert.deepEqual([row.status, row.reason, row.endedAt], ['failed', error.message, end.time]);
  assert.deepEqual([row.call.state, row.call.finish, row.call.thrown, row.call.output], ['received', 'stop', record.data.thrown.message, null]);
});

test('the facts of a request that could not be sent read as a failed row that shows the prompt from the attempt record alone, no call behind it', { skip }, async () => {
  const refused = new Error('no adapter for this route');
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const llm = recordingLlm(() => { throw refused; });
  const { seal, monitor } = sealOver(session, { llm });

  const { error } = await failingPreStep(seal, session);

  assert.equal(error, refused);
  const appended = appendedSince(session, before);
  assert.deepEqual(appended.map(event => event.type), [INNER_ATTEMPT_RECORD_TYPE, INNER_END_RECORD_TYPE]);
  const [attempt, end] = appended;
  assert.deepEqual(rowsAfter(session, monitor.live(session.id)), [{
    id: attempt.seq,
    revision: end.seq,
    status: 'failed',
    startedAt: attempt.time,
    endedAt: end.time,
    range: attempt.data.range,
    reason: 'no adapter for this route',
    slots: null,
    call: { state: 'absent', endedAt: null, finish: null, thrown: null, input: promptOf(llm.calls[0]).slice(0, PREVIEW_SOURCE_CHARS), output: null, outputDisplay: null, usage: null },
    contextChange: null,
    trigger: { q: attempt.data.quote.q, kappa: attempt.data.quote.kappa },
    stepN: INNER_QUOTE.minSteps,
    cRatio: RATIO,
    epoch: 0,
  }]);
});

test('the entries of the registry join the folded facts by the attempt record\'s seq: a running seal reads generating with the response so far, validating with the call\'s end time before its call is recorded, and committed once the carrier stands', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const answering = answeringSlots();
  const seen = {};
  let rig;
  const peek = (point) => { seen[point] = rowsAfter(session, rig.monitor.live(session.id)); };
  const llm = {
    calls: answering.calls,
    stream(options) {
      peek('request');
      return (async function* () {
        for await (const chunk of answering.stream(options)) {
          yield chunk;
          peek(`after ${chunk.type}`);
        }
      })();
    },
  };
  // The state is read at the commit, after the response is validated and before the carrier is appended.
  rig = sealOver(session, { llm, readState: () => { peek('state read'); return { asOfSeq: 0, items: {} }; } });

  const lines = await stderrOf(t, async () => { await preStep(rig.seal, session); });
  peek('sealed');

  assert.deepEqual(monitorCodesOf(lines), [], 'the monitor wrote no line');
  const [attempt, record] = appendedSince(session, before);
  const summaries = notesTextOf(Array.from({ length: INNER_QUOTE.minSteps }, (_, index) => `summary ${index + 1}`));
  const summariesDisplay = Array.from({ length: INNER_QUOTE.minSteps }, (_, index) => `summary ${index + 1}`).join('\n');
  const prompt = promptOf(llm.calls[0]).slice(0, PREVIEW_SOURCE_CHARS);
  for (const [point, state, output, outputDisplay] of [['request', 'generating', '', ''], ['after text-delta', 'generating', summaries, summariesDisplay]]) {
    const [row] = seen[point];
    assert.deepEqual([row.id, row.revision, row.status], [attempt.seq, attempt.seq, 'generating'], point);
    assert.deepEqual(row.call, { state, endedAt: null, finish: null, thrown: null, input: prompt, output, outputDisplay, usage: null }, point);
  }
  const [validating] = seen['state read'];
  assert.deepEqual([validating.id, validating.status], [attempt.seq, 'validating']);
  assert.deepEqual(validating.call, { state: 'received', endedAt: record.data.endedAt, finish: 'stop', thrown: null, input: prompt, output: summaries, outputDisplay: summariesDisplay, usage: null });
  const [sealed] = seen.sealed;
  assert.deepEqual([sealed.id, sealed.status, sealed.slots], [attempt.seq, 'committed', INNER_QUOTE.minSteps]);
});

test('the facts a seal leaves when a monitor record could not be appended read as the contract says: a call with no attempt record makes no row though its carrier commits, and an attempt whose end could not be appended stays unknown beside its call', { skip }, async (t) => {
  const unstarted = sessionOver([systemMessage(), ...turnOf().events]).session;
  const unstartedBefore = unstarted.seq;
  const startRefused = countingKit({ refuse: { [INNER_ATTEMPT_RECORD_TYPE]: new Error('the log refused the attempt') } });
  const startLlm = answeringSlots();
  const startRig = sealOver(unstarted, { kit: startRefused.kit, llm: startLlm });
  await stderrOf(t, async () => { await preStep(startRig.seal, unstarted); });

  const [call, , carrier] = appendedSince(unstarted, unstartedBefore);
  assert.equal(call.type, INNER_CALL_RECORD_TYPE);
  assert.equal(carrier.data.source.slots.length, INNER_QUOTE.minSteps, 'the seal committed');
  assert.deepEqual(rowsAfter(unstarted, startRig.monitor.live(unstarted.id)), [], 'the call names no attempt of the log');

  const unended = sessionOver([systemMessage(), ...turnOf().events]).session;
  const unendedBefore = unended.seq;
  const endRefused = countingKit({ refuse: { [INNER_END_RECORD_TYPE]: new Error('the log refused the end') } });
  const endRig = sealOver(unended, { kit: endRefused.kit, llm: recordingLlm(() => textStream('{"1":"only one"}', { type: 'finish', reason: { kind: 'max-tokens' } })) });
  await stderrOf(t, async () => { await failingPreStep(endRig.seal, unended); });

  assert.deepEqual(typesSince(unended, unendedBefore), [INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE]);
  const [waiting] = rowsAfter(unended, endRig.monitor.live(unended.id));
  assert.deepEqual([waiting.status, waiting.reason, waiting.endedAt], ['unknown', null, null]);
  assert.deepEqual([waiting.call.state, waiting.call.output], ['received', '{"1":"only one"}']);
});

// ── What the monitor's details make of the facts the seal wrote ───────────────────────────────────────────

// The access to the facts `session` holds as the host builds it: the projection folded over the whole log, the registry's entries of `monitor` and the service's snapshot of the log, each read of which `reads` keeps.
function accessAfter(session, monitor, reads = []) {
  const kit = readKitOf();
  const projection = innerMonitorProjection(kit);
  return createMonitorAccess({
    sessionOf: id => (id === session.id ? session : undefined),
    readMonitor: held => held.snapshotEvents().reduce((folded, event) => projection.apply(folded, event), projection.init()),
    live: sessionId => monitor.live(sessionId),
    kit,
    readSession: async (sessionId) => {
      reads.push(sessionId);
      return { session: session.header, inheritedEventCount: 0, events: session.snapshotEvents() };
    },
    readStored: async () => undefined,
  });
}

test('the monitor warns only when a later slot seals a direct read of text the real carrier injected whole', { skip }, async () => {
  const opening = turnOf({ steps: 1 });
  const short = turnOf({ turn: 2, steps: 1, ask: 'Keep the smoke checks focused.' });
  const long = turnOf({ turn: 3, steps: LONG_STEPS, bulk: BULK, ask: 'Long input. '.repeat(20_000), toolSteps: [3], asks: {
    3: [
      { id: 'answered', arguments: PLAN_ARGUMENTS, result: { text: JSON.stringify({ answers: [{ id: 'plan', selected: ['Split'] }, { id: 'unpaired', selected: ['Not shown'] }] }) } },
      { id: 'unanswered', arguments: PLAN_ARGUMENTS, result: { text: 'No answer', isError: true } },
    ],
  } });
  const { session, seqOf } = sessionOver([systemMessage(), ...opening.events, ...short.events, ...long.events]);
  const { seal, monitor } = sealOver(session);
  const access = accessAfter(session, monitor);
  await preStep(seal, session);
  const result = id => long.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id);
  const targets = [short.request, long.replies[2], result('answered'), long.request, opening.request, result('call-3-3'), result('unanswered')];
  const append = ({ type, data, surfaceOp }) => session.append(type, data, surfaceOp === undefined ? undefined : { surfaceOp });
  const recallSlots = targets.map((target, at) => {
    const step = at + 1;
    const id = `recall-${step}`;
    const args = JSON.stringify({ seq: seqOf(target) });
    const reply = append(assistantMessage({ turn: 4, step, toolCalls: [{ id, name: 'sw_event_read', arguments: args }] }));
    append(toolCall({ turn: 4, step, callId: id, name: 'sw_event_read', arguments: args }));
    append(toolResult({ turn: 4, step, callId: id, text: 'Read denied', isError: true }));
    return reply.seq;
  });
  turnOf({ turn: 5, steps: LONG_STEPS, bulk: BULK }).events.forEach(append);

  const warnings = async () => (await access.rows(session.id)).attempts.map(row => row.slotWarnings);
  assert.deepEqual(await warnings(), [undefined], 'do not mark the source or the earlier seal');
  await preStep(seal, session);
  assert.deepEqual(await warnings(), [undefined, {
    [recallSlots[0]]: ['verbatim-recall'],
    [recallSlots[2]]: ['verbatim-recall'],
  }], 'mark whole user text and the result of an injected question; not the message that asked it, whose own text the carrier does not hold, nor truncated, unsealed or other result text');
});

test('the details of a sealed attempt read from the facts the seal wrote: the request as it was sent with the definitions of the header\'s tools, the response and its usage, and slots that tell the sources the call saw from the original a pruner replaced', { skip }, async () => {
  const { events } = turnOf({ toolSteps: [1] });
  const original = events.find(event => event.type === 'tool/result');
  const reply = events.find(event => event.type === 'assistant/message');
  const replacement = prunedResult(original, { text: 'pruned once' });
  const at = events.indexOf(original) + 1;
  const { session, seqOf } = sessionOver([systemMessage(), ...events.slice(0, at), replacement, ...events.slice(at)]);
  const range = afterPrefix(session);
  assert.ok(range.includes(seqOf(replacement)) && !range.includes(seqOf(original)), 'the replacement stands on the surface for the original');
  const before = session.seq;
  const usage = { inputTokens: 100, outputTokens: 7, totalTokens: 807, cacheReadTokens: 700, cacheWriteTokens: 0 };
  const llm = answeringSlots(usage);
  const { seal, monitor } = sealOver(session, { llm });
  await preStep(seal, session);
  const [attempt, record, , carrier] = appendedSince(session, before);
  const access = accessAfter(session, monitor);
  const sent = llm.calls[0];

  const call = await access.call(session.id, attempt.seq);

  assert.deepEqual(call.request.messages.tail, sent.messages.at(-1), 'the C tail in full is the one the request carried');
  assert.ok(call.request.messages.tail.content[0].text.length > PREVIEW_SOURCE_CHARS);
  assert.deepEqual(call.request.options, { provider: SELECTION.provider, model: SELECTION.model, reasoningEffort: SELECTION.reasoningEffort, purpose: 'inner-compaction', sessionId: session.id });
  assert.deepEqual(call.request.tools, { count: TOOLS.length, definitions: TOOLS });
  assert.deepEqual(call.ids, { start: attempt.seq, call: record.seq, end: null, carrier: carrier.seq });
  assert.deepEqual(call.response.blocks, [{ type: 'text', text: notesTextOf(Array.from({ length: INNER_QUOTE.minSteps }, (_, index) => `summary ${index + 1}`)) }]);
  assert.deepEqual([call.response.live, call.response.stream], [false, record.data.stream]);
  assert.deepEqual(call.usage, { folded: { input: 100, output: 7, cacheRead: 700, cacheWrite: 0 }, raw: { type: 'usage', usage } });
  assert.deepEqual(call.timing, { attempt: { startedAt: attempt.time, endedAt: carrier.time }, call: { startedAt: attempt.time, endedAt: record.data.endedAt } });

  const { slots } = await access.slots(session.id, attempt.seq);
  assert.equal(slots.length, INNER_QUOTE.minSteps);
  const [first] = slots;
  assert.deepEqual([first.key, first.turn, first.step, first.output], [seqOf(reply), 1, 1, 'summary 1']);
  assert.equal(first.input, 'reply 1.1\nread {}\npruned once', 'the sources the call saw, not the original the replacement stands for');

  const detail = await access.slot(session.id, attempt.seq, first.key);
  assert.deepEqual(detail.seqs, carrier.data.source.slots[0].seqs, 'the carrier\'s slot as the seal wrote it');
  assert.equal(detail.c, 'summary 1');
  assert.deepEqual(detail.events.map(({ seq, type, visible }) => [seq, type, visible]), [
    [seqOf(reply), 'assistant/message', true], [seqOf(original), 'tool/result', false], [seqOf(replacement), 'tool/result', true],
  ]);
  const [asked, answered] = [detail.events[0].blocks.find(block => block.type === 'tool-call'), detail.events[1].blocks[0]];
  assert.deepEqual([asked.name, answered.type, answered.callId], ['read', 'tool-result', asked.id], 'the call and its original result pair by id');
  assert.deepEqual(detail.events[2].blocks[0].blocks, [{ type: 'text', text: 'pruned once' }]);
});

test('the call of a request that could not be sent reads from the facts the seal wrote the options the actual request carried, a selection with no reasoning effort giving no such key, and no response behind it', { skip }, async () => {
  for (const [selection, effort] of [[{ provider: 'deepseek', model: 'deepseek-v4-pro' }, {}], [SELECTION, { reasoningEffort: 'high' }]]) {
    const refused = new Error('no adapter for this route');
    const { session } = sessionOver([systemMessage(), ...turnOf().events], `refused-${Object.keys(effort).length}`);
    const before = session.seq;
    const llm = recordingLlm(() => { throw refused; });
    const { seal, monitor } = sealOver(session, { llm });
    await failingPreStep(seal, session, { selection });
    const [attempt, end] = appendedSince(session, before);

    const call = await accessAfter(session, monitor).call(session.id, attempt.seq);

    assert.deepEqual(call.request.options, { provider: 'deepseek', model: 'deepseek-v4-pro', ...effort, purpose: 'inner-compaction', sessionId: session.id });
    assert.equal('reasoningEffort' in call.request.options, 'reasoningEffort' in effort);
    assert.deepEqual(call.request.messages.tail, llm.calls[0].messages.at(-1));
    assert.deepEqual(call.ids, { start: attempt.seq, call: null, end: end.seq, carrier: null });
    assert.deepEqual([call.response, call.usage, call.row.status, call.row.reason, call.row.call.state], [null, null, 'failed', 'no adapter for this route', 'absent']);
  }
});

test('the call of a summary that failed with a long error reads the whole text of the failure from the facts the seal wrote, where the list\'s row carries a preview of it', { skip }, async (t) => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const before = session.seq;
  const long = `the connection reset ${'x'.repeat(PREVIEW_SOURCE_CHARS + 100)}`;
  const llm = recordingLlm(async function* () { yield { type: 'block-start', index: 0, blockType: 'text' }; throw new Error(long); });
  const { seal, monitor } = sealOver(session, { llm });
  let error;
  const lines = await stderrOf(t, async () => { ({ error } = await failingPreStep(seal, session)); });
  assert.deepEqual(monitorCodesOf(lines), [], 'the monitor wrote no line');
  const [attempt, record, end] = appendedSince(session, before);
  assert.equal(end.data.reason, error.message, 'the end record holds the whole of what the turn ended with');
  assert.ok(error.message.length > PREVIEW_SOURCE_CHARS);

  const call = await accessAfter(session, monitor).call(session.id, attempt.seq);
  const [listed] = rowsAfter(session, monitor.live(session.id));

  assert.equal(listed.reason, error.message.slice(0, PREVIEW_SOURCE_CHARS));
  assert.equal(listed.call.thrown, record.data.thrown.message.slice(0, PREVIEW_SOURCE_CHARS));
  assert.equal(call.row.reason, error.message);
  assert.equal(call.row.call.thrown, record.data.thrown.message);
  assert.ok(call.row.call.thrown.includes(long), 'the thrown message is the whole error chain');
  assert.deepEqual([call.row.status, call.row.call.state, call.row.call.finish], ['failed', 'error', null]);
});

test('the call of an attempt the real seal has in flight reads the registry\'s entry, the request as dispatched with the tools it sent and the response as it streams, and reads no log until the carrier stands', { skip }, async () => {
  const { session } = sessionOver([systemMessage(), ...turnOf().events]);
  const answering = answeringSlots({ inputTokens: 100, outputTokens: 7, totalTokens: 807, cacheReadTokens: 700, cacheWriteTokens: 0 });
  const seen = {};
  const reads = [];
  let access;
  const startOf = () => session.snapshotEvents().findLast(event => event.type === INNER_ATTEMPT_RECORD_TYPE).seq;
  // The access answers an attempt in flight in the stretch of the call, so the entry is read at the point `peek` names.
  const peek = (point) => { seen[point] = access.call(session.id, startOf()); };
  const llm = {
    calls: answering.calls,
    stream(options) {
      peek('request');
      return (async function* () {
        for await (const chunk of answering.stream(options)) {
          yield chunk;
          peek(`after ${chunk.type}`);
        }
      })();
    },
  };
  // The state is read at the commit, after the response is validated and before the carrier is appended.
  const { seal, monitor } = sealOver(session, { llm, readState: () => { peek('state read'); return { asOfSeq: 0, items: {} }; } });
  access = accessAfter(session, monitor, reads);

  await preStep(seal, session);

  assert.deepEqual(reads, [], 'no read of the log while the attempt was in flight');
  const summaries = notesTextOf(Array.from({ length: INNER_QUOTE.minSteps }, (_, index) => `summary ${index + 1}`));
  const [dispatched, streaming, finished, validating] = await Promise.all(['request', 'after text-delta', 'after finish', 'state read'].map(point => seen[point]));
  for (const detail of [dispatched, streaming, finished, validating]) {
    assert.deepEqual(detail.request.tools, { count: TOOLS.length, definitions: TOOLS });
    assert.deepEqual(detail.request.messages.tail, llm.calls[0].messages.at(-1));
    assert.equal(detail.response.live, true);
  }
  assert.deepEqual([dispatched.row.status, dispatched.response.blocks, dispatched.response.firstAt, dispatched.response.finish], ['generating', [], null, null]);
  assert.deepEqual([streaming.row.status, streaming.response.blocks, streaming.response.finish], ['generating', [{ type: 'text', text: summaries }], null]);
  assert.deepEqual([finished.row.status, finished.response.finish], ['generating', STOP]);
  assert.deepEqual([validating.row.status, validating.response.finish, typeof validating.timing.call.endedAt], ['validating', STOP, 'number']);
  assert.deepEqual(validating.ids, { start: dispatched.ids.start, call: null, end: null, carrier: null });

  const sealed = await access.call(session.id, dispatched.ids.start);
  assert.deepEqual(reads, [session.id]);
  assert.deepEqual([sealed.row.status, sealed.response.live, sealed.ids.carrier === null], ['committed', false, false]);
});

// ── The kept evidence a load showed is B₀ ────────────────────────────────────────────────────────────────────

// A canonical temporary directory holding `files`, `{ name: lines[] }`, removed when the case ends.
function directoryWith(t, files) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sw-dsh-seal-b0-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, rows] of Object.entries(files)) writeFileSync(join(root, name), `${rows.join('\n')}\n`);
  return root;
}

const fileRows = (name, count) => Array.from({ length: count }, (_, index) => `${name} line ${index + 1}`);

// The `readFile` of the host over the files on disk as they are now: a fresh tree for every read, so a rewrite shows.
const readFromDisk = async (_agent, key, ranges) => ({
  read: readTreeWindows(createNodeWorkingTree({ path: nodePath, homeDir: null, cacheEntries: 4, cacheChars: 1_000_000 }), key, ranges, { fileBytes: 1_000_000 }),
  displayPath: key,
});

// One real load (`loadHandoffInto` over the checkout's `createUserMessage`) of the keep list `paths` of `root`, answered as the events `/sw-load` appends: the payload message and the read message.
async function loadedEvents(root, paths) {
  const agent = { model: { current: () => ({ provider: SELECTION.provider, model: SELECTION.model }) } };
  const delivery = { found: true, handoff_id: 7, load_token: 'sw-token', summary: 'The work so far.', paths_to_keep: paths };
  const { loaded, failed } = await loadHandoffInto({
    agent, session: {}, deliver: async () => delivery, kit: kitOf(), signal: new AbortController().signal, token: 'sw-token',
    cwdOf: () => root, readFile: readFromDisk,
  });
  assert.equal(failed, undefined, failed?.reason);
  const [payload, read] = loaded.messages.map(message => ({ ...userMessage({ text: 'placeholder' }), data: message }));
  return { payload, read, loaded };
}

// A mode-on session that started with a load: `[system, payload, read, follow-up, ...one turn of steps]`, the load's messages before the first request's header. The turn's text is padded by `BULK` so that it outweighs the B of the held blocks and the quote has savings to pass on.
async function loadedSession(root, paths, { steps = LONG_STEPS } = {}) {
  const { payload, read, loaded } = await loadedEvents(root, paths);
  const followUp = userMessage({ text: 'Handoff sw-token is loaded.' });
  const { events } = turnOf({ steps, bulk: BULK });
  return { ...sessionOver([systemMessage(), payload, read, followUp, ...events]), payload, read, loaded };
}

const keyOf = (root, name) => join(root, name);
const heldLines = (...numbers) => numbers;
const carrierOf = (session, before) => appendedSince(session, before).find(event => event.type === 'user/message');

test('the seal of a session that started with a load builds B against the evidence the load showed: a kept line unchanged in the Working Tree is not written again, a rewritten one is, and what the load never showed is', { skip }, async (t) => {
  const root = directoryWith(t, { 'kept.js': fileRows('kept.js', 20), 'other.js': fileRows('other.js', 6) });
  const { session, read } = await loadedSession(root, [{ path: 'kept.js', lines: [[3, 8]] }, { path: 'other.js', lines: [[1, 2]] }]);
  const key = keyOf(root, 'kept.js');
  const before = session.seq;
  const { seal } = sealOver(session, {
    readFile: readFromDisk, readUnobserved: readFromDisk,
    // What the session holds of the files: the lines the load showed, one line the model read later, and a line of the other file past what the load showed.
    heldView: () => ({ paths: new Map([[key, [3, 4, 5, 6, 7, 8, 12]], [keyOf(root, 'other.js'), [1, 2, 4]]]), skills: new Map(), effects: [] }),
  });
  const shownBefore = JSON.stringify(read.data.source);
  writeFileSync(key, `${fileRows('kept.js', 20).map((row, index) => (index + 1 === 5 ? 'kept.js line 5 rewritten' : row)).join('\n')}\n`);

  await preStep(seal, session);

  const carrier = carrierOf(session, before);
  assert.deepEqual(carrier.data.source.paths, [
    { path: key, displayPath: key, totalLines: 20, write: [[5, 'kept.js line 5 rewritten'], [12, 'kept.js line 12']] },
    { path: keyOf(root, 'other.js'), displayPath: keyOf(root, 'other.js'), totalLines: 6, write: [[4, 'other.js line 4']] },
  ], 'the shown lines that stand are carried by the load, the rewritten, the later-read and the unshown ones by B');
  assert.deepEqual(carrier.data.source.removed, undefined);
  assert.equal(JSON.stringify(read.data.source), shownBefore, 'B₀ is the load message\'s own source, which the seal leaves as it was');
  assert.deepEqual(session.surface.nodes.slice(0, 4), [0, 1, 2, 3], 'the prefix, the load\'s messages among it, stays on the surface in its order');
});

test('a path the load kept follows the carried semantics against the evidence it showed: a path the session no longer holds is removed, and one whose file is gone is unreadable with its shown lines withdrawn', { skip }, async (t) => {
  const root = directoryWith(t, { 'kept.js': fileRows('kept.js', 20), 'other.js': fileRows('other.js', 6) });
  const { session } = await loadedSession(root, [{ path: 'kept.js', lines: [[3, 8]] }, { path: 'other.js', lines: [[1, 2]] }]);
  const key = keyOf(root, 'kept.js');
  const before = session.seq;
  const { seal } = sealOver(session, {
    readFile: readFromDisk, readUnobserved: readFromDisk,
    heldView: () => ({ paths: new Map([[key, [3, 4, 5, 6, 7, 8]]]), skills: new Map(), effects: [] }),
  });
  rmSync(key);

  await preStep(seal, session);

  const { source } = carrierOf(session, before).data;
  assert.deepEqual(source.paths, [{ path: key, displayPath: key, state: 'unreadable', reason: 'missing', withdraw: heldLines(3, 4, 5, 6, 7, 8) }]);
  assert.deepEqual(source.removed, [keyOf(root, 'other.js')]);
});

test('the quote and the commit read B against the same evidence the load showed: the attempt keeps the estimate of the B the commit then writes, nothing for kept lines that stand and the price of the rewritten line alone', { skip }, async (t) => {
  const root = directoryWith(t, { 'kept.js': fileRows('kept.js', 20) });
  const key = keyOf(root, 'kept.js');
  const held = () => ({ paths: new Map([[key, [3, 4, 5, 6, 7, 8]]]), skills: new Map(), effects: [] });

  const standing = await loadedSession(root, [{ path: 'kept.js', lines: [[3, 8]] }]);
  const standingBefore = standing.session.seq;
  await preStep(sealOver(standing.session, { readFile: readFromDisk, readUnobserved: readFromDisk, heldView: held }).seal, standing.session);
  const [standingAttempt] = appendedSince(standing.session, standingBefore);
  assert.equal(standingAttempt.data.quote.bEst, 0, 'the lines the load showed and the tree still holds cost the carrier nothing');
  assert.deepEqual(carrierOf(standing.session, standingBefore).data.source.paths, []);

  const rewritten = await loadedSession(root, [{ path: 'kept.js', lines: [[3, 8]] }]);
  writeFileSync(key, `${fileRows('kept.js', 20).map((row, index) => (index + 1 === 5 ? 'kept.js line 5 rewritten' : row)).join('\n')}\n`);
  const rewrittenBefore = rewritten.session.seq;
  await preStep(sealOver(rewritten.session, { readFile: readFromDisk, readUnobserved: readFromDisk, heldView: held }).seal, rewritten.session);
  const [rewrittenAttempt] = appendedSince(rewritten.session, rewrittenBefore);
  const { paths } = carrierOf(rewritten.session, rewrittenBefore).data.source;
  assert.deepEqual(paths.map(entry => entry.write), [[[5, 'kept.js line 5 rewritten']]], 'the commit writes the rewritten line alone');
  assert.equal(rewrittenAttempt.data.quote.bEst, pricedB(paths), 'the quote priced the very B the commit wrote');
  assert.ok(rewrittenAttempt.data.quote.bEst > 0);
});

test('B₂ is built by the machinery of B₁: the second seal of a session that started with a load carries against the load and the first carrier, a line the first carrier wrote standing and one rewritten since written again', { skip }, async (t) => {
  const root = directoryWith(t, { 'kept.js': fileRows('kept.js', 20) });
  const key = keyOf(root, 'kept.js');
  const rewrite = (row5, row6 = 'kept.js line 6') => writeFileSync(key, `${fileRows('kept.js', 20).map((row, index) => (index + 1 === 5 ? row5 : index + 1 === 6 ? row6 : row)).join('\n')}\n`);
  const { session } = await loadedSession(root, [{ path: 'kept.js', lines: [[3, 8]] }]);
  const services = { readFile: readFromDisk, readUnobserved: readFromDisk, heldView: () => ({ paths: new Map([[key, [3, 4, 5, 6, 7, 8]]]), skills: new Map(), effects: [] }) };
  const { seal } = sealOver(session, services);
  rewrite('kept.js line 5 second');
  const first = session.seq;
  await preStep(seal, session);
  assert.deepEqual(carrierOf(session, first).data.source.paths.map(entry => entry.write), [[[5, 'kept.js line 5 second']]]);

  // The model works on for another range's worth of steps; line 6 is rewritten meanwhile and line 5 stays as the first carrier wrote it.
  const more = turnOf({ turn: 2, steps: LONG_STEPS, bulk: BULK });
  for (const event of more.events) session.append(event.type, event.data, event.surfaceOp === undefined ? undefined : { surfaceOp: event.surfaceOp });
  rewrite('kept.js line 5 second', 'kept.js line 6 third');
  const second = session.seq;
  await preStep(seal, session);

  assert.deepEqual(carrierOf(session, second).data.source.paths.map(entry => entry.write), [[[6, 'kept.js line 6 third']]],
    'line 5 stands as the first carrier wrote it, the lines the load showed stand, line 6 is new');
});

test('evidence inside the victim range is no baseline: a later load\'s read message is withdrawn with its range, so its lines are written in full while the initial load\'s stay carried by it', { skip }, async (t) => {
  const root = directoryWith(t, { 'kept.js': fileRows('kept.js', 20), 'later.js': fileRows('later.js', 8) });
  const first = await loadedEvents(root, [{ path: 'kept.js', lines: [[3, 8]] }]);
  const later = await loadedEvents(root, [{ path: 'later.js', lines: [[1, 4]] }]);
  const opening = turnOf({ steps: 1 });
  const working = turnOf({ turn: 2, steps: LONG_STEPS, bulk: BULK });
  const { session } = sessionOver([
    systemMessage(), first.payload, first.read, userMessage({ text: 'Handoff is loaded.' }), ...opening.events, later.payload, later.read, ...working.events,
  ]);
  const before = session.seq;
  const { seal } = sealOver(session, {
    readFile: readFromDisk, readUnobserved: readFromDisk,
    heldView: () => ({ paths: new Map([[keyOf(root, 'kept.js'), [3, 4, 5, 6, 7, 8]], [keyOf(root, 'later.js'), [1, 2, 3, 4]]]), skills: new Map(), effects: [] }),
  });

  await preStep(seal, session);

  const { source } = carrierOf(session, before).data;
  assert.deepEqual(source.paths.map(entry => [entry.path, entry.write.map(([number]) => number)]), [[keyOf(root, 'later.js'), [1, 2, 3, 4]]]);
  assert.ok(!source.paths.some(entry => entry.path === keyOf(root, 'kept.js')), 'the initial load\'s lines stand');
});

// ── The session state ────────────────────────────────────────────────────────

const toolOf = key => CARRIER_TABLE.stateItems.find(item => item.key === key).tool;
// The session's tool list with the tool of each item named in `keys` beside the one every test session lists.
const toolsFor = (...keys) => [...TOOLS, ...keys.map(key => ({ name: toolOf(key), description: `The ${toolOf(key)} tool.`, parameters: { type: 'object', properties: {} } }))];
// The items that stand for a tool of the session: the git state stands for none and is read by `readGit`.
const ALL_KEYS = CARRIER_TABLE.stateItems.filter(({ tool }) => tool !== undefined).map(({ key }) => key);
const ALL_TOOLS = toolsFor(...ALL_KEYS);
// What the host's `readState(session)` answers for `values`, `{ key: value }`: the cut and a read for each item named, answering its value.
const stateRead = (values, asOfSeq = 9) => () => ({ asOfSeq, items: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, () => value])) });
// A summary usage whose uncached share stays under the alert, so the seal writes no diagnostic of its own.
const QUIET_USAGE = { inputTokens: 100, outputTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 0 };
const TODO_A = [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it', status: 'in_progress' }];
const TODO_B = [{ content: 'Review it', status: 'pending' }];
const AGENTS = [{ id: 'agent-1', label: 'review the parser' }];
const JOBS = [{ id: 'bash-1a2b', label: 'npm run watch' }, { id: 'bash-3c4d', label: 'npm test' }];
const FULL = { workingDirectory: '/repo/app', subagents: AGENTS, jobs: JOBS, todos: TODO_A };
const bodyOf = carrier => carrier.data.content.at(-1).text;
const sealedCarrier = (session, before) => appendedSince(session, before).find(event => event.type === 'user/message');
const stateLines = lines => lines.filter(line => line.includes('inner_'));

// A seal over one padded turn that lists `tools`, with `anchors` as the extra fields of earlier carriers on its surface and `readGit` the host's read of the git state; answers the carrier it commits and the stderr lines.
async function sealingWith(t, { values = FULL, tools = ALL_TOOLS, anchors = [], readState = stateRead(values), asOfSeq, readGit, signal } = {}) {
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, tools });
  const { session } = sessionOver([systemMessage(), userMessage({ text: 'earlier ask' }), requestHeader(), ...anchors.map(carrierShowing), ...events]);
  const before = session.seq;
  const { seal } = sealOver(session, { readState: asOfSeq === undefined ? readState : stateRead(values, asOfSeq), readGit, llm: answeringSlots(QUIET_USAGE) });
  const lines = await stderrOf(t, async () => { await preStep(seal, session, signal === undefined ? {} : { signal }); });
  return { session, before, lines, carrier: sealedCarrier(session, before) };
}

// A carrier an earlier seal left on the surface: its source holds the extra fields `extra` gives, `state`; a source that does not render, which a seal never wrote, has the text of a bare carrier.
function carrierShowing(extra = {}) {
  const source = { kind: INNER_SEAL_KIND, v: 1, slots: [], paths: [], ...extra };
  const message = userMessage({ text: 'earlier seal' });
  let content;
  try {
    content = renderCarrier(source, CARRIER_TABLE);
  } catch {
    const { state, ...bare } = source;
    content = renderCarrier(bare, CARRIER_TABLE);
  }
  return { ...message, data: { ...message.data, content, source } };
}
const shows = (items, asOfSeq = 3) => ({ state: { asOfSeq, items } });

test('the carrier shows the state the host reads at the commit after the body: each item the session lists a tool for, in full the first time, its source keeping the cut and every value as read, while an item that is empty and never shown, one whose tool is not listed and one the host cannot read are left out and a state with no item to show leaves no field', { skip }, async (t) => {
  const rows = [
    ['every item', ALL_TOOLS, FULL, ALL_KEYS],
    ['the working directory beside lists with nothing in them', ALL_TOOLS, { workingDirectory: '/repo', subagents: [], jobs: [], todos: null }, ['workingDirectory']],
    ['lists with nothing in them alone', ALL_TOOLS, { subagents: [], jobs: [], todos: [] }, []],
    ['items whose tools are not listed', toolsFor('jobs', 'todos'), FULL, ['jobs', 'todos']],
    ['no state tool listed', TOOLS, FULL, []],
    ['items the host cannot read', ALL_TOOLS, { jobs: JOBS }, ['jobs']],
  ];
  for (const [why, tools, values, shown] of rows) {
    const { carrier, lines } = await sealingWith(t, { tools, values, asOfSeq: 41 });
    const { source } = carrier.data;
    assert.deepEqual(stateLines(lines), [], `${why}: nothing is a diagnostic`);
    assert.equal(Object.hasOwn(source, 'state'), shown.length > 0, why);
    assert.deepEqual(carrier.data.content, renderCarrier(source, CARRIER_TABLE), `${why}: the body is the source rendered`);
    if (shown.length === 0) continue;
    assert.equal(source.state.asOfSeq, 41, why);
    assert.deepEqual(Object.keys(source.state.items), shown, `${why}: the shown items in the items' order`);
    for (const key of shown) {
      const value = values[key] === null ? [] : values[key];
      assert.deepEqual(source.state.items[key], { value }, `${why}: ${key} in full, as read`);
    }
    assert.ok(bodyOf(carrier).includes(STATE_WORDING.heading(41)), `${why}: the block closes the body under the cut`);
  }
});

test('each item follows the retained carriers the surface holds: a value the nearest carrier showing it shows is shown as unchanged beside its value unless it is empty, another whole, and carriers showing other items or none leave it as it was', { skip }, async (t) => {
  const rows = [
    ['the same value shown before', [shows({ jobs: { value: JOBS } })], { jobs: JOBS }, { jobs: { value: JOBS, unchanged: true } }],
    ['another value than the one shown', [shows({ jobs: { value: JOBS.slice(0, 1) } })], { jobs: JOBS }, { jobs: { value: JOBS } }],
    ['an empty value after a shown one', [shows({ subagents: { value: AGENTS } })], { subagents: [] }, { subagents: { value: [] } }],
    ['an empty value shown before, empty again', [shows({ subagents: { value: [] } })], { subagents: [] }, { subagents: { value: [] } }],
    ['A, B, then A again', [shows({ todos: { value: TODO_A } }), shows({ todos: { value: TODO_B } })], { todos: TODO_A }, { todos: { value: TODO_A } }],
    ['the shown value, then carriers that showed other items or none', [shows({ workingDirectory: { value: '/repo' } }), shows({ jobs: { value: JOBS } }), {}], { workingDirectory: '/repo' }, { workingDirectory: { value: '/repo', unchanged: true } }],
    ['each item against its own', [shows({ workingDirectory: { value: '/repo' }, todos: { value: TODO_A } })], { workingDirectory: '/elsewhere', todos: TODO_A }, { workingDirectory: { value: '/elsewhere' }, todos: { value: TODO_A, unchanged: true } }],
  ];
  for (const [why, anchors, values, expected] of rows) {
    const { carrier } = await sealingWith(t, { anchors, values });
    assert.deepEqual(carrier.data.source.state.items, expected, why);
    assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), `${why}: the body is the source rendered`);
  }
});

test('a carrier the range replaces leaves the comparison: the value it showed is shown again whole', { skip }, async () => {
  const h1 = userMessage({ text: 'earlier ask' });
  const old = carrierShowing(shows({ jobs: { value: JOBS } }));
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, tools: ALL_TOOLS });
  const checkpoint = compactCheckpoint({ startSeq: h1.seq, endSeq: h1.seq });
  const { session, seqOf } = sessionOver([systemMessage(), h1, old, ...events, checkpoint]);
  const before = session.seq;
  const { seal } = sealOver(session, { readState: stateRead({ jobs: JOBS }, 90), llm: answeringSlots(QUIET_USAGE) });
  await preStep(seal, session);

  assert.equal(appendedSince(session, before)[1].data.range[0], seqOf(old), 'the old carrier is in the range');
  assert.deepEqual(sealedCarrier(session, before).data.source.state, { asOfSeq: 90, items: { jobs: { value: JOBS } } });
});

test('the state is read once, at the commit, and is no term of the quote: the host is read after the attempt is recorded, the quote is the one a host reading no state gets, and no todo estimate is recorded', { skip }, async () => {
  const quoteWith = async (readState) => {
    const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, tools: ALL_TOOLS });
    const { session } = sessionOver([systemMessage(), ...events]);
    const before = session.seq;
    const { seal } = sealOver(session, { readState: readState(session, before), llm: answeringSlots(QUIET_USAGE) });
    await preStep(seal, session);
    return { quote: appendedSince(session, before)[0].data.quote, carrier: sealedCarrier(session, before) };
  };
  const reads = [];
  const read = await quoteWith((session, before) => () => {
    reads.push(typesSince(session, before));
    return stateRead({ ...FULL, todos: [{ content: 'x'.repeat(5000), status: 'pending' }] })();
  });
  const none = await quoteWith(() => () => ({ asOfSeq: 0, items: {} }));
  assert.equal(reads.length, 1, 'one read for the seal');
  assert.deepEqual(reads[0], [INNER_ATTEMPT_RECORD_TYPE], 'at the commit: the attempt is recorded, its call, the prune and the carrier not yet');
  assert.deepEqual(read.quote, none.quote, 'the quote is the same whatever the host would show');
  assert.equal(Object.hasOwn(read.quote, 'todoEst'), false);
  assert.equal(read.quote.sEst, read.quote.lA - read.quote.bEst - read.quote.cEst);
  assert.ok(Object.hasOwn(read.carrier.data.source, 'state'));
});

test('an item that fails is left out with one inner_state_failed line naming it, whatever the failure, and the seal commits with every other item: a read that throws, a value the item cannot hold and an earlier carrier that holds none it can read', { skip }, async (t) => {
  const failing = [
    ['a read that throws', { jobs: () => { throw new Error('the jobs registry could not be read'); } }, 'jobs'],
    ['a value that is no list', { subagents: () => 'later' }, 'subagents'],
    ['a working directory that is no path', { workingDirectory: () => 7 }, 'workingDirectory'],
    ['a todo with no status', { todos: () => [{ content: 'x' }] }, 'todos'],
  ];
  for (const [why, broken, key] of failing) {
    const readState = () => ({
      asOfSeq: 9,
      items: { workingDirectory: () => '/repo', subagents: () => AGENTS, jobs: () => JOBS, todos: () => TODO_A, ...broken },
    });
    const { carrier, lines, session, before } = await sealingWith(t, { readState });
    assert.deepEqual(typesSince(session, before), SEALED, `${why}: the seal commits`);
    assert.deepEqual(Object.keys(carrier.data.source.state.items), ALL_KEYS.filter(each => each !== key), `${why}: every other item stands`);
    assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), why);
    const reported = stateLines(lines);
    assert.equal(reported.length, 1, `${why}: ${lines.join('\n')}`);
    assert.equal(/^\S+ \[dsh-host\] inner_state_failed: (\w+)/.exec(reported[0])?.[1], key, `${why}: ${reported[0]}`);
  }

  const { carrier, lines } = await sealingWith(t, { anchors: [shows({ todos: { value: 'later' } })], values: { todos: TODO_A, jobs: JOBS } });
  assert.deepEqual(Object.keys(carrier.data.source.state.items), ['jobs'], 'the item whose earlier value cannot be read fails alone');
  assert.equal(stateLines(lines).length, 1);

  const several = await sealingWith(t, {
    readState: () => ({ asOfSeq: 2, items: { subagents: () => { throw new Error('a'); }, jobs: () => { throw new Error('b'); }, todos: () => TODO_A } }),
  });
  assert.deepEqual(stateLines(several.lines).map(line => /inner_state_failed: (\w+)/.exec(line)[1]), ['subagents', 'jobs'], 'one line per failing item, in the items\' order');
  assert.deepEqual(Object.keys(several.carrier.data.source.state.items), ['todos']);
});

test('an item whose tool the session does not list is not read and writes no line, and a state that cannot be read as a whole costs the seal one inner_state_failed line and the block, never the carrier: a host that throws, a cut that is no session seq', { skip }, async (t) => {
  const reads = [];
  const counting = key => () => { reads.push(key); return key === 'workingDirectory' ? '/repo' : []; };
  const { carrier, lines } = await sealingWith(t, {
    tools: toolsFor('todos'), readState: () => ({ asOfSeq: 9, items: Object.fromEntries(ALL_KEYS.map(key => [key, counting(key)])) }),
  });
  assert.deepEqual(reads, ['todos'], 'only the listed tool\'s item is read');
  assert.deepEqual(stateLines(lines), []);
  assert.equal(Object.hasOwn(carrier.data.source, 'state'), false);

  for (const [why, readState] of [
    ['a host that throws', () => { throw new Error('the registry is gone'); }],
    ['a cut that is no seq', () => ({ asOfSeq: undefined, items: { jobs: () => JOBS } })],
    ['an answer that is no state', () => null],
  ]) {
    const { carrier: stands, lines: written, session, before } = await sealingWith(t, { readState });
    assert.deepEqual(typesSince(session, before), SEALED, `${why}: the seal commits`);
    assert.equal(Object.hasOwn(stands.data.source, 'state'), false, why);
    assert.equal(stateLines(written).length, 1, `${why}: ${written.join('\n')}`);
    assert.ok(stateLines(written)[0].startsWith(`${session.id} [dsh-host] inner_state_failed`), `${why}: ${written.join('\n')}`);
  }
});

test('the values a carrier keeps are its own: what the host hands out and mutates later reaches neither the source handed to the message factory nor the body, nor the logged carrier', { skip }, async () => {
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, tools: ALL_TOOLS });
  const { session } = sessionOver([systemMessage(), ...events], 'state-detached');
  const before = session.seq;
  const live = { subagents: AGENTS.map(entry => ({ ...entry })), jobs: JOBS.map(entry => ({ ...entry })), todos: TODO_A.map(entry => ({ ...entry })) };
  // The factory is handed the source itself: a seam that keeps what it is given, as a session without detached logs would.
  let handed;
  const kit = kitOf({ createUserMessage: (input) => { handed = input; return llmPackage.createUserMessage(input); } });
  const { seal } = sealOver(session, { readState: stateRead(live, 6), llm: answeringSlots(QUIET_USAGE), kit });
  await preStep(seal, session);

  live.subagents[0].label = 'rewritten';
  live.jobs.push({ id: 'late', label: 'late' });
  live.todos[0].status = 'pending';
  const expected = { asOfSeq: 6, items: { subagents: { value: AGENTS }, jobs: { value: JOBS }, todos: { value: TODO_A } } };
  assert.deepEqual(handed.source.state, expected);
  assert.deepEqual(handed.content, renderCarrier({ ...handed.source, state: expected }, CARRIER_TABLE));
  assert.deepEqual(sealedCarrier(session, before).data.source.state, expected, 'as the log holds it');
});

test('the commit reads the state only in the stretch behind its checks: a range that changed, a pairing that is unbalanced and a cancel each end the attempt before any read, while a commit that stands reads once', { skip }, async () => {
  const counted = () => { const reads = []; return { reads, services: { readState: () => { reads.push(1); return { asOfSeq: 4, items: { todos: () => TODO_A } }; } } }; };
  const refused = [
    ['a range whose nodes changed', during => ({ during }), /surface/],
    ['an unbalanced pairing', () => ({ kit: kitOf({ toolPairingBalancedAfter: () => false }) }), /pairing/],
  ];
  for (const [why, options, pattern] of refused) {
    const { reads, services } = counted();
    const rig = commitRig({
      ...options((session) => {
        const result = session.snapshotEvents().find(event => event.type === 'tool/result');
        session.append('tool/result', { ...result.data, message: { ...result.data.message, content: [{ type: 'text', text: 'pruned' }] } },
          { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] });
      }),
      services, tools: ALL_TOOLS,
    });
    await assert.rejects(preStep(rig.seal, rig.session), pattern, why);
    assert.equal(reads.length, 0, `${why}: no read`);
  }
  const controller = new AbortController();
  const cancelled = counted();
  const rig = commitRig({ during: () => controller.abort(new Error('the user cancelled')), services: cancelled.services, tools: ALL_TOOLS });
  await assert.rejects(preStep(rig.seal, rig.session, { signal: controller.signal }), /the user cancelled/);
  assert.equal(cancelled.reads.length, 0, 'a cancel: no read');

  const standing = counted();
  const ok = commitRig({ services: standing.services, tools: ALL_TOOLS });
  await preStep(ok.seal, ok.session);
  assert.equal(standing.reads.length, 1, 'the commit\'s read alone');
});

// ── The git state ────────────────────────────────────────────────────────────

const GIT = '## main...origin/main [ahead 1]\n M lib/a.js\n?? notes.md\n4f2a9c1 fix the thing';
const GIT_ITEM = CARRIER_TABLE.stateItems.find(item => item.key === 'git');
// The host's read of the git state answering `text` after a turn of the event loop, and the calls it took.
const gitReading = (text = GIT) => {
  const calls = [];
  const readGit = async (session, signal) => {
    calls.push({ session, signal });
    await new Promise(resolve => setImmediate(resolve));
    return text;
  };
  return { calls, readGit };
};

test('the git state is read before the commit\'s synchronous stretch and carried as the last item, whatever tools the session lists: the host\'s state is read after it, the value stands as read and the block ends on it', { skip }, async (t) => {
  const order = [];
  const { calls, readGit } = gitReading();
  const reading = async (session, signal) => { order.push('git'); return readGit(session, signal); };
  const controller = new AbortController();
  const readState = () => { order.push('state'); return stateRead(FULL, 41)(); };
  const { carrier, lines, session } = await sealingWith(t, { readGit: reading, readState, signal: controller.signal });

  assert.deepEqual(order, ['git', 'state']);
  assert.equal(calls.length, 1, 'one read for the seal');
  assert.equal(calls[0].session, session, 'the session whose carrier it is');
  assert.equal(calls[0].signal, controller.signal, 'the seal\'s own signal, so a cancel stops the read');
  const { source } = carrier.data;
  assert.deepEqual(Object.keys(source.state.items), [...ALL_KEYS, 'git']);
  assert.deepEqual(source.state.items.git, { value: GIT });
  assert.equal(source.state.asOfSeq, 41, 'the cut is the host\'s state read');
  assert.deepEqual(carrier.data.content, renderCarrier(source, CARRIER_TABLE));
  assert.ok(bodyOf(carrier).endsWith(`${GIT_ITEM.label}\n${GIT}`), 'the block ends on the git text under its label');
  assert.deepEqual(stateLines(lines), []);

  const alone = await sealingWith(t, { tools: TOOLS, values: {}, readGit: gitReading().readGit });
  assert.deepEqual(Object.keys(alone.carrier.data.source.state.items), ['git'], 'it stands for no tool the session must list');
});

test('the git state follows the retained carriers like any item: the same text is shown as unchanged beside its text, another whole', { skip }, async (t) => {
  const rows = [
    ['the same as shown', [shows({ git: { value: GIT } })], { value: GIT, unchanged: true }],
    ['another text than the one shown', [shows({ git: { value: `${GIT}\n` } })], { value: GIT }],
    ['never shown', [shows({ jobs: { value: JOBS } })], { value: GIT }],
  ];
  for (const [why, anchors, expected] of rows) {
    const { carrier } = await sealingWith(t, { anchors, values: {}, readGit: gitReading().readGit });
    assert.deepEqual(carrier.data.source.state.items.git, expected, why);
    assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), `${why}: the body is the source rendered`);
  }
});

test('no git state is no item and no line: a host that has no read, a directory that is no repository and a state that is the only item', { skip }, async (t) => {
  const none = await sealingWith(t, { values: {}, readGit: async () => null });
  assert.equal(Object.hasOwn(none.carrier.data.source, 'state'), false, 'no repository, no other item: no block');
  assert.deepEqual(stateLines(none.lines), []);
  const beside = await sealingWith(t, { readGit: async () => null });
  assert.deepEqual(Object.keys(beside.carrier.data.source.state.items), ALL_KEYS, 'the other items stand');
  assert.deepEqual(stateLines(beside.lines), []);
  const unread = await sealingWith(t, {});
  assert.deepEqual(Object.keys(unread.carrier.data.source.state.items), ALL_KEYS, 'a host with no read for it');
  assert.deepEqual(stateLines(unread.lines), []);
});

test('a git state that cannot be read leaves its item out with one inner_state_failed line naming it, and the seal commits with every other item: a read that rejects, one that throws at once and a value that is no text', { skip }, async (t) => {
  const failing = [
    ['a rejection', async () => { throw new Error('git status timed out'); }, 'git status timed out'],
    ['a throw at once', () => { throw new Error('the working directory could not be read'); }, 'the working directory could not be read'],
    ['a value that is no text', async () => 7, ''],
  ];
  for (const [why, readGit, message] of failing) {
    const { carrier, lines, session, before } = await sealingWith(t, { readGit });
    assert.deepEqual(typesSince(session, before), SEALED, `${why}: the seal commits`);
    assert.deepEqual(Object.keys(carrier.data.source.state.items), ALL_KEYS, `${why}: every other item stands`);
    assert.deepEqual(carrier.data.content, renderCarrier(carrier.data.source, CARRIER_TABLE), why);
    const reported = stateLines(lines);
    assert.equal(reported.length, 1, `${why}: ${lines.join('\n')}`);
    assert.ok(reported[0].startsWith(`${session.id} [dsh-host] inner_state_failed: git: ${message}`), `${why}: ${reported[0]}`);
  }
});

test('a cancel during the git read ends the turn as the cancel, with no carrier and no state line: the read answers the abort and the seal stops at its check', { skip }, async (t) => {
  const controller = new AbortController();
  const cancelled = new Error('the user cancelled');
  const readGit = async (_session, signal) => {
    controller.abort(cancelled);
    throw signal.reason;
  };
  const { events } = turnOf({ steps: LONG_STEPS, bulk: BULK, tools: ALL_TOOLS });
  const { session } = sessionOver([systemMessage(), userMessage({ text: 'earlier ask' }), requestHeader(), ...events]);
  const before = session.seq;
  const { seal } = sealOver(session, { readState: stateRead(FULL), readGit, llm: answeringSlots(QUIET_USAGE) });
  let failure;
  const lines = await stderrOf(t, async () => { failure = await failingPreStep(seal, session, { signal: controller.signal }); });

  assert.equal(failure.error, cancelled);
  assert.equal(failure.nextCalls, 0);
  assert.deepEqual(typesSince(session, before), FAILED, 'the attempt ends with no prune and no carrier');
  assert.deepEqual(stateLines(lines), []);
});
