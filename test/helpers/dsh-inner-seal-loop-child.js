// test/helpers/dsh-inner-seal-loop-child.js — one inner-seal scenario of the shipped host entry over the real DSH loop (`dsh-shipped-loop.js`), run in a fresh Node process by `test/dsh.inner-seal.integration.test.js`.
// The process starts with `HOME`, `DSH_HOME` and `TMPDIR` inside the fixture the parent made. A scenario that fails an assertion exits non-zero with it on stderr; what it writes to stdout is the evidence the case reports.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeWatcher } from '../../dsh/src/composition.js';
import { INNER_QUOTE } from '../../lib/inner-seal/quote.js';
import { SUMMARY_FILTER_RETRIES, SUMMARY_MAX_REQUESTS } from '../../lib/inner-seal/ladder.js';
import { COALESCED_PERSIST_MS } from '../../lib/constants.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { createDshSourceDriver } from '../../lib/harness/dsh/source-driver.js';
import { STATE_WORDING } from '../../lib/inner-seal/state-block.js';
import { CARRIER_TABLE } from '../../lib/harness/dsh/carrier-table.js';
import { foldCarried } from '../../lib/carried-evidence.js';
import { closeStore, openStore } from '../../lib/store.js';
import { splitLines } from '../../lib/line-align.js';
import { watchedTree } from './attribution-fixtures.js';
import { unframed } from './reminder-frame.js';
import {
  CARRIER_KIND, fromCheckout, INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, mountShippedLoop, REPLY_PADDING, SEAL_STEPS, SEAL_WAIT_TURNS, SLOT_COUNT, sleep, slotNotes, turnOf,
} from './dsh-shipped-loop.js';

const [scenario] = process.argv.slice(2);
const ROOT = realpathSync(process.env.TMPDIR);
const STORE_PATH = join(process.env.HOME, '.session-watcher', 'store.sqlite');
// A skill the entry registers on the real skill registry from its bundled skills.
const SKILL = 'sw-explain';

// The lines the host writes to stderr from here on; its diagnostics arrive as `console.error` lines.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => { stderrLines.push(args.map(String).join(' ')); realConsoleError(...args); };

const lines = (label, count) => Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`);
const textOf = rows => `${rows.join('\n')}\n`;

// A turn whose user text is `tool:<name> <json>` makes the model call that tool once, then answer; `inOneStep(...)` makes it call each tool in one step, so a turn's two steps hold as many calls as it names; any other turn is answered with text.
const directive = (name, args) => `tool:${name} ${JSON.stringify(args)}`;
const inOneStep = (...calls) => `tools:${JSON.stringify(calls.map(([name, args]) => ({ name, args })))}`;
function reply(n, options) {
  // The turn's own user message, unless a tool result has answered its call already; a context message may follow it.
  const asked = options.messages.at(-1)?.role === 'user' ? options.messages.findLast(message => message.source?.kind === 'user') : undefined;
  const text = asked?.content?.find(block => block.type === 'text')?.text;
  const match = text === undefined ? null : /^tool:(\w+) (.*)$/s.exec(text);
  if (match !== null) return { toolCalls: [{ id: `call-${n}`, name: match[1], arguments: match[2] }] };
  const calls = text === undefined ? null : /^tools:(.*)$/s.exec(text);
  return calls === null ? `reply ${n}` : { toolCalls: JSON.parse(calls[1]).map(({ name, args }, index) => ({ id: `call-${n}-${index + 1}`, name, arguments: JSON.stringify(args) })) };
}

// A summary that answers each slot with its index, its usage carrying all three of DSH's exclusive input fields.
async function* summary(count) {
  const text = slotNotes(count, 'summary of slot');
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 900, cacheWriteTokens: 0 } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

// A summary whose first note quotes an array with its inner quotes unescaped, so its JSON syntax fails alone; the other notes are those `slotNotes` writes.
const QUOTED_NOTE = `Found: '["one","two","three"]'.`;
const unescapedNotes = count => `{${Array.from({ length: count }, (_, index) => `"${index + 1}": "${index === 0 ? QUOTED_NOTE : `summary of slot ${index + 1}`}"`).join(', ')}}`;

const callRecordsOf = session => session.snapshotEvents().filter(event => event.type === INNER_CALL_RECORD_TYPE);
const isCarrierEvent = event => event?.type === 'user/message' && event.data?.source?.kind === CARRIER_KIND;
const requestCarriers = request => request.messages.filter(message => message.source?.kind === CARRIER_KIND);
const textsIn = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');

// The call ids of a log's assistant tool calls and of its tool results, a replacement result counted apart.
function callsOf(events) {
  const calls = events.filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content.filter(block => block.type === 'tool-call').map(block => block.id));
  const results = events.filter(event => event.type === 'tool/result' && event.surfaceOp?.op !== 'replace').map(event => event.data.message.toolCallId);
  return { calls, results };
}

// The checks one seal owes over the events it appended after `at` and the adapter requests it caused after `requestsAt`.
function sealOf({ session, at, adapter, requestsAt, selection, quiet }) {
  const events = session.snapshotEvents();
  const after = events.slice(at);
  const types = after.map(event => event.type);
  const recordAt = types.indexOf(INNER_CALL_RECORD_TYPE);
  assert.ok(recordAt >= 0, `the turn sealed: ${types.join(', ')}`);
  assert.deepEqual(types.slice(recordAt, recordAt + 3), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message'], 'the three appends, adjacent and in order');
  const [record, prune, carrier] = after.slice(recordAt, recordAt + 3);
  const { range } = record.data;
  assert.equal(record.data.purpose, 'inner-compaction');
  assert.deepEqual(record.data.selection, selection);
  assert.equal(record.data.thrown, undefined);
  // The attempt record is appended in the stretch that prepares the auxiliary request, ahead of the call record; the call record names it.
  const attempt = events[record.data.attempt];
  assert.equal(attempt.type, INNER_ATTEMPT_RECORD_TYPE, 'the call record names the attempt record');
  assert.ok(attempt.seq < record.seq);
  // The seal is the quote's permission, not a step count's: savings over the C estimate and fee, and the arm the decision names.
  const { quote } = attempt.data;
  assert.ok(quote.trigger === 'quote' && quote.sEst > 0 && (quote.arm === 'right' || quote.q < quote.kappa), `the quote permits the seal: ${JSON.stringify(quote)}`);
  // The auxiliary input names the latest request header at its preparation, and its cut is the event before the attempt record, which the same stretch appends; where nothing else is appended while the seal runs (`quiet`), the call record follows the attempt record directly.
  assert.equal(record.data.input.headerSeq, events.slice(0, record.data.input.throughSeq + 1).findLast(event => event.type === 'request/header').seq);
  assert.equal(record.data.input.throughSeq, attempt.seq - 1, 'the auxiliary input runs through the event before the attempt record');
  if (quiet) assert.equal(record.seq, attempt.seq + 1, 'in a quiet seal nothing comes between the attempt record and the call record');
  assert.deepEqual(prune.data.shadowedSeqs, range);
  assert.deepEqual(prune.data.shadowedRange, { start: range[0], end: range.at(-1) });
  assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: range[0], endSeq: range.at(-1) });
  assert.ok([record.seq, prune.seq, ...range].every(seq => carrier.sourceEventSeqs.includes(seq)), 'the carrier cites the record, the prune and every shadowed node');
  // Serial timing: every tool batch and step of the range settled before the record. The pre-step runs before the step starts and admits the turn's own user message, so the last user message admitted before the record, the previous turn's, is source the range seals.
  const settled = events.filter(event => range.includes(event.seq) && event.type === 'tool/result');
  assert.ok(settled.every(event => event.seq < record.seq));
  const previousEnd = events.slice(0, record.seq).findLast(event => event.type === 'turn/end');
  assert.ok(previousEnd !== undefined && previousEnd.seq < record.seq, 'the previous turn ended before the seal');
  const userSeq = events.slice(0, record.seq).findLast(event => event.type === 'user/message' && event.data.source.kind === 'user').seq;
  assert.ok(range.includes(userSeq), 'the last user message admitted before the seal is sealed with the range');

  const requests = adapter.requests.slice(requestsAt).filter(request => request.sessionId === session.id);
  const kinds = requests.map(request => request.kind);
  assert.deepEqual(kinds.slice(0, 2), ['summary', 'main'], `the auxiliary call precedes the step's main request: ${kinds.join(', ')}`);
  const [aux, main] = requests;
  assert.equal(aux.purpose, 'inner-compaction');
  assert.deepEqual({ provider: aux.provider, model: aux.model }, selection, 'the auxiliary call runs under the pre-step selection');
  const userText = textsIn(events[userSeq].data);
  assert.ok(aux.messages.slice(0, -1).some(message => textsIn(message) === userText), 'the auxiliary input holds the active history through the last-admitted user message');
  // The tail numbers the slots the model is asked for; a user's own message is a slot whose note the program wrote, `user: ` and the text.
  const asked = carrier.data.source.slots.filter(slot => !slot.text.startsWith('user: ')).length;
  assert.equal(Number(SLOT_COUNT.exec(aux.messages.at(-1).content[0].text)?.[1]), asked, 'the tail numbers the carrier\'s slots the model is asked for');
  assert.ok(requestCarriers(main).some(message => message.id === carrier.data.id), 'the step\'s main request, after the commit, carries the carrier');
  return { attempt, record, prune, carrier, range, aux, main };
}

// A watcher over `store`, fed as the host feeds it: a cold install of `events`.
function coldWatcher({ store, sessionId, cwd, events }) {
  const tree = watchedTree({});
  const { watcher } = composeWatcher({
    sessionId, cwd, store, turnNotesRoot: join(ROOT, 'turn-notes'),
    readSession: async () => ({ events: [] }), isIgnored: null, cacheTtl: () => null, workingTree: tree.workingTree,
  });
  const diagnostics = [];
  const driver = createDshSourceDriver({ sessionId, onDiagnostics: reported => diagnostics.push(...reported) });
  const apply = (frame) => {
    if (frame !== null) diagnostics.push(...watcher.applyHarnessFrame(frame).diagnostics);
  };
  apply(driver.install(events));
  for (const frame of driver.drain()) apply(frame);
  return { watcher, diagnostics, treeCalls: tree.calls };
}

// What an off-mode run must equal: per resource, its lines, its tokens and its counts.
const resourcesOf = watcher => watcher._engine.getBucketData().paths
  .map(({ path, tokens, lineNumbers, readCount, editCount, pureRereads }) => ({ path, tokens, lineNumbers, readCount, editCount, pureRereads }))
  .sort((a, b) => a.path.localeCompare(b.path));

const recordsOf = (store, sessionId) => store._db
  .prepare('SELECT tool_use_id, record FROM attribution_record WHERE session_id = ? ORDER BY tool_use_id').all(sessionId)
  .map(row => ({ ...row }));

// The session's persisted log, read back through the JSONL persistence after a flush: its events, and the session the native restore rebuilds from them and the stored header.
async function durableLog(ctx, session) {
  const { Session } = await fromCheckout('packages/core/session/lib/index.js');
  await ctx.sessions.flush(session);
  const reader = await ctx.sessionPersistence.open(session.id, 'read');
  try {
    const { events, eventState } = await reader.read();
    return { events, restored: Session.fromRestore(session.id, events, reader.header, reader.inheritedEventCount, eventState) };
  } finally {
    await reader.close();
  }
}

// One call through the real tool runtime, outside the loop, as `agent`: that call's result.
async function runTool(ctx, agent, name, args) {
  const id = `probe-${name}-${Math.random().toString(16).slice(2)}`;
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }], signal: new AbortController().signal, agent });
  return batch.results[0].result;
}

// The text of each file under `dir` now, by path; a removed file is absent.
const diskOf = (dir, names) => new Map(names.filter(name => existsSync(join(dir, name))).map(name => [join(dir, name), readFileSync(join(dir, name), 'utf8')]));

// What `disk` (a `diskOf` answer) holds on `held` lines (path → line numbers): a missing file is unreadable with nothing carried; a line past the file's end carries nothing.
function diskView(held, disk) {
  const paths = new Map();
  for (const [path, numbers] of held) {
    if (!disk.has(path)) {
      paths.set(path, { state: 'unreadable', reason: 'missing', lines: new Map() });
      continue;
    }
    const rows = splitLines(disk.get(path));
    paths.set(path, {
      state: rows.length === 0 ? 'empty' : 'readable',
      lines: new Map(numbers.filter(number => number <= rows.length).map(number => [number, rows[number - 1]])),
    });
  }
  return paths;
}

const plainView = paths => [...paths].map(([path, { state, reason, lines: held }]) => [path, state, reason ?? null, [...held].sort(([a], [b]) => a - b)]).sort(([a], [b]) => a.localeCompare(b));

// ── The stock entries ───────────────────────────────────────────────────────
// A model's window stays this large until a case sets the one its stock entry fires under.
const HUGE_WINDOW = 10_000_000;
const THRESHOLD_RATIO = 0.5;
const RETAIN_RATIO = 0.2;
// The retention of the model a switch goes to: its retained tail is a long user message, beside a fixed overhead the tail after a carrier does not need.
const SWITCH_RETAIN_RATIO = 0.05;
// What the stock's framed summary may price at most.
const STOCK_SUMMARY_ALLOWANCE = 200;
const LOAD_KIND = 'session-watcher-load';
const CHECKPOINT_KIND = 'compact-checkpoint';

const isKind = kind => event => event?.type === 'user/message' && event.data?.source?.kind === kind;
const isPayloadEvent = event => isKind(LOAD_KIND)(event) && event.data.source.calls[0]?.name === 'load_handoff';
const isReadEvent = event => isKind(LOAD_KIND)(event) && !isPayloadEvent(event);

// The counted steps among `seqs`: the turn and step of each non-empty assistant message.
function countedSteps(events, seqs) {
  const steps = new Set();
  for (const seq of seqs) {
    const event = events[seq];
    if (event.type === 'assistant/message' && event.data.message.content.length > 0) steps.add(`${event.data.turn}:${event.data.step}`);
  }
  return steps.size;
}

// A finish the llm service reads as a provider's context-window refusal.
function* overflowChunks() {
  yield { type: 'finish', reason: { kind: 'error', failure: { message: 'the request exceeds the context window', code: 'CONTEXT_WINDOW_EXCEEDED' } } };
}

// Whether the stock cases' main replies carry `REPLY_PADDING`: only the turns that wait for a seal are padded, so over the plain turns between them the retained tail stays the small share of the surface that a case's retention ratio and threshold are fixed against.
let paddingOn = false;
const stockPadding = () => (paddingOn ? REPLY_PADDING : undefined);

// The user's text after the second `/sw-load`, in the range the recount seals: enough text that the quote still passes at the minimum count of steps with the summary call's read of the surface in its fixed load.
const LOAD_FOLLOW_UP = `after the load ${'y'.repeat(4_000)}`;

// One session of a stock case under `model`, mode on, in its own directory holding the files the case reads.
async function stockSession(rig, name, model) {
  const { call, adapter, harness, llm } = rig;
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kept.txt'), textOf(lines('kept', 12)));
  writeFileSync(join(dir, 'big.txt'), textOf(lines(`big ${'b'.repeat(40)}`, 1_500)));
  writeFileSync(join(dir, 'mid.txt'), textOf(lines(`mid ${'m'.repeat(40)}`, 300)));
  writeFileSync(join(dir, 'after.txt'), textOf(lines('after', 6)));
  const selection = { provider: 'mock', model };
  const agent = await harness.create(`stock-${name}-${Date.now().toString(16)}`, selection, { cwd: dir });
  assert.deepEqual(await call('inner-mode/select', { sessionId: agent.session.id, enabled: true }), { ok: true, value: {} });
  const { session } = agent;
  const turn = async (text) => {
    const at0 = session.seq;
    const requestsAt = adapter.requests.length;
    await turnOf(agent, llm, text);
    return { at0, requestsAt, appended: session.snapshotEvents().slice(at0) };
  };
  // Plain turns until one seals, which answers the seal's checks; at most `limit` turns.
  const untilSeal = async (label, limit = SEAL_WAIT_TURNS) => {
    paddingOn = true;
    try {
      return await sealWithin(label, limit);
    } finally {
      paddingOn = false;
    }
  };
  const sealWithin = async (label, limit) => {
    for (let index = 0; index < limit; index += 1) {
      const { at0, requestsAt, appended } = await turn(`${label} ${index + 1}`);
      if (appended.some(event => event.type === INNER_CALL_RECORD_TYPE)) {
        const seal = sealOf({ session, at: at0, adapter, requestsAt, selection: handle.selection, quiet: false });
        // The quote permits the seal from the minimum count on, at the first count whose savings the padded replies make cover the fee and the held lines.
        const counted = countedSteps(session.snapshotEvents(), seal.range);
        const { quote } = seal.attempt.data;
        assert.equal(quote.n, counted, `${label}: the quote counts the range's steps`);
        assert.ok(quote.trigger === 'quote' && counted >= INNER_QUOTE.minSteps, `${label}: a quoted seal from the ${INNER_QUOTE.minSteps}th counted step: ${JSON.stringify(quote)}`);
        return seal;
      }
    }
    throw new Error(`${label}: no seal within ${limit} turns`);
  };
  const handle = { dir, agent, session, at: file => join(dir, file), selection, turn, untilSeal };
  return handle;
}

// The command `line` on the real command runtime for `agent`, run to idle: its result.
async function commandOf(ctx, agent, line) {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal);
  assert.ok(execution !== undefined, `${line} resolves to a command`);
  await agent.whenIdle();
  return execution.result;
}

// The token of the handoff the latest `prepare_handoff` result of `session` names.
function handoffToken(session) {
  const result = session.snapshotEvents().findLast(event => event.type === 'tool/result' && textsIn(event.data.message).includes('Handoff prepared'));
  assert.ok(result !== undefined, 'the model prepared a handoff');
  return /Token: (\S+)\. /.exec(textsIn(result.data.message))[1];
}

// The window under which the stock entry of `session`'s next turn compacts all before `keepSeq`: the threshold at or under the price now, the retention (`ratio` of the window) between the tail after `keepSeq` and the tail from it, and the price that would remain, the fixed overhead and a summary included, under the threshold.
function windowKeeping(ctx, session, keepSeq, ratio) {
  const { nodes, totalTokens } = ctx.tokenMeter.measure(session, session.requestHeader());
  const at = nodes.findIndex(node => node.seq === keepSeq);
  const priced = from => nodes.slice(from).reduce((sum, node) => sum + node.tokens, 0);
  const overhead = totalTokens - priced(0);
  const window = Math.ceil((priced(at + 1) + nodes[at].tokens / 2) / ratio);
  const threshold = Math.floor(window * THRESHOLD_RATIO);
  assert.ok(threshold <= totalTokens && threshold > overhead + priced(at) + STOCK_SUMMARY_ALLOWANCE,
    `fixture: threshold ${threshold}, price ${totalTokens}, overhead ${overhead}, tail ${priced(at)}`);
  return { window, threshold, totalTokens };
}

const stockLog = (ctx, trigger) => ctx.logger.buffer.filter(message => message.args.map(String).join(' ').includes(`compaction (${trigger})`));
const stockWarnings = ctx => ctx.logger.buffer.filter(message => message.type === 'warn' && message.args.map(String).join(' ').includes('compaction'));

// The cache-read growth per main request of the lamp cases: the slower moves the bill clock across the interval the seal's post closes, the faster past bill cycles.
const LAMP_GROWTH = 600;
const COUNTER_GROWTH = 20_000;
// The measured main steps of the counter case before its counted ones, which widen the interval the post closes.
const COUNTER_STEPS = 30;

// The Rate Lamp across a seal in a later segment, each main request's cache-read prefix growing by `growth`; with `counters`, the interval the seal's post closes must pass bill cycles. The reminder budget counts the Qualified Prefix (`CONTEXT.md`): the calls behind the epoch's head are pending until a seal lists them, so the clocks stand at zero before the first seal, the post behind its carrier joins the prefix and moves them, and the calls behind the post are pending again.
async function lampCase({ growth, counters = false }) {
  // Each main request's usage: the prefix read from cache grows by what the last step wrote.
  let mains = 0;
  const usage = {
    inputTokens: 200, outputTokens: 40,
    get cacheReadTokens() { return 4_000 + growth * mains; },
    cacheWriteTokens: growth,
  };
  // With `counters`, the turns texted `measured …` answer an empty assistant message with the usage alone: a measured main step that stands pending until a seal lists it.
  const empty = () => ({ chunks: [{ type: 'usage', usage: { ...usage } }, { type: 'finish', reason: { kind: 'stop' } }] });
  const rig = await mountShippedLoop({
    tools: true, commands: true, summary, usage, padding: REPLY_PADDING,
    reply: (n, options) => {
      mains += 1;
      const asked = options.messages.findLast(message => message.source?.kind === 'user');
      return textsIn(asked ?? {}).startsWith('measured ') ? empty() : reply(n, options);
    },
  });
  const { ctx, call } = rig;
  const handle = await stockSession(rig, 'lamp', 'loop-model');
  const { session, agent, at } = handle;
  const status = async () => (await call('status', { sessionId: session.id })).value.payload;
  const buckets = async () => (await call('buckets', { sessionId: session.id })).value.payload;
  const clocks = ({ rateLamp: lamp }) => ({ reliable: lamp.reliable, bill: lamp.billProgress, cycles: lamp.billCycleCount, phase: lamp.rentMeter.depthProgress, laps: lamp.rentMeter.backstopLapCount });
  await handle.turn(directive('read', { file_path: at('kept.txt') }));
  await handle.turn(directive('prepare_handoff', { summary: 'The work so far.', paths_to_keep: [{ path: 'kept.txt' }] }));
  assert.equal((await commandOf(ctx, agent, '/sw-continue')).kind, 'success');
  const trace = [];
  await handle.turn(directive('read', { file_path: at('mid.txt') }));
  assert.equal((await call('user-overrides', { sessionId: session.id, overrides: { [at('mid.txt')]: 'exclude' } })).ok, true);
  if (counters) for (let index = 0; index < COUNTER_STEPS; index += 1) await handle.turn(`measured ${index + 1}`);
  const store = openStore(STORE_PATH);
  let before = null;
  let segmentsBefore = null;
  let deadBefore = null;
  for (let index = 0; index < SEAL_WAIT_TURNS; index += 1) {
    const turned = await handle.turn(`lamp turn ${index + 1}`);
    const now = await status();
    const sealed = turned.appended.some(event => event.type === INNER_CALL_RECORD_TYPE);
    trace.push({ turn: index + 1, sealed, segment: now.segment, ...clocks(now) });
    if (sealed) break;
    before = { segment: now.segment, ...clocks(now) };
    segmentsBefore = store.getProfileSegments(session.id);
    deadBefore = (await buckets()).dead;
  }
  const sealedAt = trace.at(-1);
  assert.equal(sealedAt.sealed, true, 'the session sealed');
  assert.ok(before.segment > 0 && before.reliable, `the lamp of a later segment was reliable before the seal: ${JSON.stringify(before)}`);
  assert.deepEqual([before.bill, before.cycles, before.phase, before.laps], [0, 0, 0, 0], `the pending calls counted nothing before the seal: ${JSON.stringify(trace)}`);
  // A ledger is merged into the status only under the state key the status reads now, so its clocks standing positive say the seal kept the key. The sealed turn also made the call right behind the carrier, the post of its Stage Point, which the prefix now holds beside the head.
  const sealed = { segment: sealedAt.segment, ...clocks(await status()) };
  assert.equal(sealed.segment, before.segment, 'the seal keeps the state key');
  assert.ok(sealed.bill + sealed.cycles > 0, `the post's interval moved the bill clock: ${JSON.stringify({ before, sealed })}`);
  if (counters) assert.ok(sealed.cycles > 0, `the bill cycle counter is past zero after the seal: ${JSON.stringify(trace)}`);
  // The seal keeps the epoch's first call, so the dead it observed stands: every call that stays carries more stock.
  assert.ok(deadBefore > 0, `the epoch was anchored before the seal: ${deadBefore}`);
  assert.equal((await buckets()).dead, deadBefore, 'the seal keeps the dead the epoch\'s first call observed');
  for (let index = 0; index < 3; index += 1) {
    await handle.turn(`after the seal ${index + 1}`);
    const now = await status();
    trace.push({ after: index + 1, segment: now.segment, ...clocks(now) });
  }
  const after = trace.at(-1);
  assert.equal(after.segment, before.segment);
  assert.deepEqual([after.bill, after.cycles, after.phase, after.laps], [sealed.bill, sealed.cycles, sealed.phase, sealed.laps], 'the calls behind the post are pending, so no clock moves');
  const closing = await buckets();
  assert.equal(closing.dead, deadBefore, 'the dead stands through the calls after the seal');
  assert.equal(closing.paths.find(row => row.path === at('mid.txt'))?.userOverride, 'exclude', 'the user\'s override stays in force across the seal');
  assert.deepEqual(store.getProfileSegments(session.id), segmentsBefore, 'no saved archive moves');
  // The persisted ledger, written behind the live one at the write-behind interval: not wound back past `sealed`, the clocks the seal left.
  await sleep(COALESCED_PERSIST_MS * 2);
  const persisted = JSON.parse(store._db.prepare("SELECT value FROM state WHERE session_id = ? AND key = 'ledger'").get(session.id)?.value ?? 'null');
  assert.ok(persisted !== null, `the ledger is persisted: ${JSON.stringify(store._db.prepare('SELECT session_id, key FROM state').all())}`);
  assert.ok(persisted.billProgress + (persisted.billCycleCount ?? 0) >= sealed.bill + sealed.cycles, `the persisted clocks did not go back: ${JSON.stringify(persisted).slice(0, 300)}`);
  closeStore(store);
  trace.push({ persisted: { billProgress: persisted.billProgress, billCycleCount: persisted.billCycleCount, walletPhase: persisted.walletPhase, walletLapCount: persisted.walletLapCount } });
  console.log(JSON.stringify(trace));
  await ctx.fiber.dispose();
}

// The questions an asking step puts to the user: a long one with the model's explanation, its detail, option descriptions, and a short one.
const EXPLANATIONS = ['Cut the release today.\nTell on-call first.', 'Hold for the audit window.', 'Ship the API, hold the UI.', 'The audit window closes on Friday.\nA rollback is a revert.'];
const CUSTOM_ANSWER = 'Ship the API now,\nhold the UI until the audit window closes.';
const askedQuestions = () => ({
  questions: [
    {
      id: 'plan', header: 'Release plan', question: `Which release plan do we follow?\n${'Weigh the rollback cost and the on-call load. '.repeat(40)}`, detail: EXPLANATIONS[3], multiSelect: true,
      options: [{ label: 'Ship now', description: EXPLANATIONS[0] }, { label: 'Wait', description: EXPLANATIONS[1] }, { label: 'Split', description: EXPLANATIONS[2] }],
    },
    { id: 'owner', question: 'Who owns the rollout?', options: [{ label: 'Platform' }, { label: 'Product' }] },
  ],
});

// A session whose first turn asks the user `askedQuestions()` through the real loop and is then driven until the quote permits the seal, with the stand-in for the question tool mounted when `answering`. The stand-in answers the way the tool renders its value, `{ answers: [{ id, selected, custom? }] }` as JSON text, with answers this scenario scripts: it is no question service and shows no UI. `finish()` drives the turns and answers what the checks read from the log and the request after the seal.
async function askingSession(answering) {
  const rig = await mountShippedLoop({ padding: REPLY_PADDING, reply, summary });
  const { call, adapter, harness, llm } = rig;
  if (answering) {
    const { defineTool } = await fromCheckout('packages/core/tools/lib/index.js');
    rig.ctx.tools.register(defineTool({
      name: 'ask_user_question',
      description: 'A stand-in for the question tool: answers with the answers its scenario scripted.',
      parameters: { questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { answers: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => ({ answers: [{ id: 'plan', selected: ['Ship now', 'Split'], custom: CUSTOM_ANSWER }, { id: 'owner', selected: ['Platform'] }] }),
    }));
  }
  const selection = { provider: 'mock', model: 'loop-model' };
  const agent = await harness.create(`asks-${Date.now().toString(16)}`, selection, { cwd: process.env.TMPDIR });
  const { session } = agent;
  assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
  const finish = async () => {
    await turnOf(agent, llm, directive('ask_user_question', askedQuestions()));
    let requestsAt = adapter.requests.length;
    for (let turn = 1; turn <= SEAL_WAIT_TURNS && callRecordsOf(session).length === 0; turn += 1) {
      requestsAt = adapter.requests.length;
      await turnOf(agent, llm, `plain ${turn}`);
    }
    const events = session.snapshotEvents();
    const carrier = events.find(isCarrierEvent);
    assert.ok(carrier !== undefined, 'the session sealed');
    const callEvent = events.find(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call'));
    const [{ id }] = callEvent.data.message.content.filter(block => block.type === 'tool-call');
    const answer = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === id).data.message;
    const [main] = adapter.requests.slice(requestsAt).filter(request => request.sessionId === session.id && request.kind === 'main');
    const [message] = requestCarriers(main);
    return { carrier, call: callEvent.data.message, callSeq: callEvent.seq, answer, message };
  };
  return { rig, finish };
}

const SCENARIOS = {
  // Consecutive seals from an empty state over the real tools, beside the same script with the mode off: the auxiliary call's purpose, session, selection and input cut; serial timing; the second seal's B as changes against the first carrier, read from the commit-time surface's derived messages; an unreadable held path in the next main request; the meter over the sealed surface; the raw log keeping every call and result once; B's observation letting an edit through and a rewrite between its `stat` and read failing one; then each session's own durable JSONL log and Store rebuilt cold, the sealed one against the control.
  async 'loop-seals'() {
    const rig = await mountShippedLoop({ tools: true, skills: true, persistence: true, padding: REPLY_PADDING, reply, summary });
    const { ctx, call, adapter, harness, llm } = rig;
    const selection = { provider: 'mock', model: 'loop-model' };
    const FILES = {
      'a.txt': lines('alpha', 20), 'b.txt': lines('bravo', 10), 'c.txt': lines('charlie', 8),
      'gone.txt': lines('gone', 5), 'obs.txt': lines('observed', 5), 'stale.txt': lines('stale', 5),
    };
    const run = {};
    for (const [name, enabled] of [['sealed', true], ['control', false]]) {
      // Directory names of one length, so a path's text weighs the same in both runs.
      const dir = join(ROOT, name === 'sealed' ? 'sealed' : 'unseal');
      mkdirSync(dir, { recursive: true });
      for (const [file, rows] of Object.entries(FILES)) writeFileSync(join(dir, file), textOf(rows));
      const agent = await harness.create(`seals-${name}-${Date.now().toString(16)}`, selection, { cwd: dir });
      assert.deepEqual(await call('inner-mode/select', { sessionId: agent.session.id, enabled }), { ok: true, value: {} });
      run[name] = { dir, agent, session: agent.session, at: path => join(dir, path) };
    }
    // The first range holds each kind of held evidence once, in tool calls made together so that they fit; the second holds two reads of its own. Plain turns fill both ranges up to the seal's step count: a turn is two counted steps when it calls tools and one when it does not, and a sealing turn's own step opens the next range.
    const turns = at => {
      const opening = [
        inOneStep(['read', { file_path: at('a.txt') }], ['read', { file_path: at('b.txt'), offset: 2, limit: 4 }]),
        inOneStep(['read', { file_path: at('gone.txt') }], ['read', { file_path: at('obs.txt') }]),
        inOneStep(['read', { file_path: at('stale.txt') }], ['skill', { name: SKILL }]),
      ];
      const later = [
        directive('read', { file_path: at('b.txt') }),
        directive('read', { file_path: at('c.txt'), offset: 1, limit: 4 }),
      ];
      const plainTurns = [SEAL_STEPS - 2 * opening.length, SEAL_STEPS - 1 - 2 * later.length];
      assert.ok(plainTurns.every(count => count >= 0), 'the seal\'s step count holds the scripted turns of each range');
      const plain = count => Array.from({ length: count }, () => null);
      return [...opening, ...plain(plainTurns[0]), 'the first sealing turn', ...later, ...plain(plainTurns[1]), 'the second sealing turn']
        .map((text, index) => text ?? `plain ${index + 1}`);
    };
    const SEAL_TURNS = ['the first sealing turn', 'the second sealing turn'].map(text => turns(file => file).indexOf(text) + 1);
    // The second seal is not quiet: one plugin record is appended right after its slice is taken, another while its auxiliary stream is consumed.
    const PROBE = 'plugin:sw-test/probe';
    const { appendPluginRecord } = await fromCheckout('packages/core/session/lib/index.js');
    let consuming = null;
    ctx.on('llm/stream', (options, next) => {
      const stream = next();
      if (consuming === null || options.purpose !== 'inner-compaction') return stream;
      const session = consuming;
      consuming = null;
      return (async function* () {
        let first = true;
        for await (const chunk of stream) {
          yield chunk;
          if (first) evidence.cut.duringConsumption = appendPluginRecord(session, PROBE, { at: 'during the auxiliary stream' });
          first = false;
        }
      })();
    });
    const evidence = { seals: [] };
    const seals = [];

    for (const [name, { agent, session, at }] of Object.entries(run)) {
      const script = turns(at);
      for (const [index, text] of script.entries()) {
        const turn = index + 1;
        if (turn === SEAL_TURNS[1]) {
          // Before the second seal: a held line changes, a held file goes, an observed file is rewritten behind the agent's back, and in the sealed run a held file is rewritten between B's `stat` and its read (the control gets the same text at the same point).
          const a = [...FILES['a.txt']];
          a[2] = 'alpha line 3, changed on disk';
          writeFileSync(at('a.txt'), textOf(a));
          rmSync(at('gone.txt'));
          writeFileSync(at('obs.txt'), textOf(FILES['obs.txt'].map(row => `${row} (rewritten)`)));
          const staleText = textOf(FILES['stale.txt'].map(row => `${row} (rewritten after the stat)`));
          if (name === 'control') {
            writeFileSync(at('stale.txt'), staleText);
          } else {
            const stat = ctx.fs.stat;
            ctx.fs.stat = async function statThenRewrite(target, signal) {
              const info = await stat.call(this, target, signal);
              if (JSON.stringify(target ?? '').includes('stale.txt')) {
                ctx.fs.stat = stat;
                writeFileSync(at('stale.txt'), staleText);
                evidence.rewroteAfterStat = true;
              }
              return info;
            };
            const readSession = ctx.sessionQuery.readSession;
            ctx.sessionQuery.readSession = function readThenAppend(sessionId) {
              const reading = readSession.call(this, sessionId);
              if (sessionId !== session.id) return reading;
              ctx.sessionQuery.readSession = readSession;
              evidence.cut = { afterSlice: appendPluginRecord(session, PROBE, { at: 'after the slice was taken' }) };
              return reading.then((result) => { evidence.cut.sliceEnd = result.events.at(-1).seq; return result; });
            };
            consuming = session;
          }
        }
        const at0 = session.seq;
        const requestsAt = adapter.requests.length;
        await turnOf(agent, llm, text);
        if (name === 'sealed' && SEAL_TURNS.includes(turn)) {
          const seal = sealOf({ session, at: at0, adapter, requestsAt, selection, quiet: turn === SEAL_TURNS[0] });
          const measured = ctx.tokenMeter.measure(session);
          assert.deepEqual(measured.nodes.map(node => node.seq), session.surface.nodes, 'the meter prices the sealed surface');
          assert.ok(seal.range.every(seq => !measured.nodes.some(node => node.seq === seq)), 'and none of the shadowed nodes');
          seals.push(seal);
          evidence.seals.push({ turn, recordSeq: seal.record.seq, range: [seal.range[0], seal.range.at(-1)], nodes: seal.range.length, shadowedTokenCount: seal.prune.data.shadowedTokenCount });
        } else if (name === 'sealed') {
          assert.equal(session.snapshotEvents().slice(at0).filter(event => event.type === INNER_CALL_RECORD_TYPE).length, 0, `turn ${turn} does not seal`);
        }
      }
    }

    const sealed = run.sealed.session;
    const control = run.control.session;
    assert.deepEqual(await call('inner-mode', { sessionId: sealed.id }), { ok: true, value: { mode: 'on', locked: true } });
    // The off mode sends no summary request and writes no replace.
    assert.equal(adapter.requests.filter(request => request.kind === 'summary' && request.sessionId === control.id).length, 0, 'the control makes no summary request');
    assert.deepEqual(control.snapshotEvents().filter(event => event.type === INNER_CALL_RECORD_TYPE || event.type === 'compaction/prune' || isCarrierEvent(event)), [], 'the control writes no record, prune or carrier');
    assert.equal(adapter.requests.filter(request => request.kind === 'summary' && request.sessionId === sealed.id).length, 2, 'one auxiliary call per seal');

    // The second seal's B: changes against the first carrier, which lies outside its range on the commit-time surface.
    const [first, second] = seals;
    const sources = [first, second].map(seal => seal.carrier.data.source);
    assert.ok(!second.range.includes(first.carrier.seq) && second.range[0] > first.carrier.seq, 'the first carrier, the frontier, is outside the second range');
    assert.equal(sealed.surface.nodes.indexOf(second.carrier.seq), sealed.surface.nodes.indexOf(first.carrier.seq) + 1, 'the second carrier replaced what followed the first');
    const entry = (source, file) => source.paths.find(each => each.path === run.sealed.at(file));
    assert.deepEqual(entry(sources[0], 'a.txt').write.map(([number]) => number), Array.from({ length: 20 }, (_, index) => index + 1), 'the first seal carries every held line of a.txt');
    assert.deepEqual(entry(sources[1], 'a.txt').write, [[3, 'alpha line 3, changed on disk']], 'the second carries only the changed line: its baseline is the first carrier');
    assert.equal(entry(sources[1], 'a.txt').state, undefined, 'a.txt\'s state did not change');
    assert.deepEqual(entry(sources[0], 'b.txt').write.map(([number]) => number), [2, 3, 4, 5]);
    assert.deepEqual(entry(sources[1], 'b.txt').write.map(([number]) => number), [1, 6, 7, 8, 9, 10], 'b.txt\'s newly held lines alone');
    assert.deepEqual(entry(sources[1], 'c.txt').write.map(([number]) => number), [1, 2, 3, 4]);
    assert.equal(entry(sources[1], 'c.txt').state, 'readable', 'a newly held path states its state');
    const gone = entry(sources[1], 'gone.txt');
    assert.deepEqual({ state: gone.state, reason: gone.reason, withdraw: gone.withdraw }, { state: 'unreadable', reason: 'missing', withdraw: [1, 2, 3, 4, 5] });
    // The tail of each auxiliary call names the held files and skills its range touched: the first range holds every read and the skill load, the second two reads of its own, so the files and the skill held from the first range stay out of its tail.
    const listedIn = seal => seal.record.data.input.tail.content[0].text.split('\n').filter(line => /^- (file|skill) /u.test(line)).sort();
    assert.deepEqual(listedIn(first), [...['a.txt', 'b.txt', 'gone.txt', 'obs.txt', 'stale.txt'].map(file => `- file ${run.sealed.at(file)}`), `- skill ${SKILL}`].sort());
    assert.deepEqual(listedIn(second), ['b.txt', 'c.txt'].map(file => `- file ${run.sealed.at(file)}`).sort());
    // The adapter's request after the seal carries the unreadable path, its reason and the hint.
    const mainText = requestCarriers(second.main).map(textsIn).join('\n');
    assert.ok(mainText.includes(`${gone.displayPath} could not be read (missing). This is not its text and not a tool failure; read the file directly when it is needed.`), 'the main request carries the unreadable path, reason and hint');
    assert.deepEqual(requestCarriers(second.main).map(message => message.id), [first.carrier.data.id, second.carrier.data.id], 'both carriers, in surface order');
    assert.ok(requestCarriers(second.aux).some(message => message.id === first.carrier.data.id), 'the second auxiliary call carries the prior carrier');
    // The skill held in the first range reaches the first carrier as its payload; unchanged, the second carries none.
    assert.deepEqual(sources[0].skills?.map(skill => skill.name), [SKILL], 'the first carrier carries the held skill payload');
    assert.equal(sources[1].skills, undefined);

    // The second seal's cuts: the frozen slice ends before the record appended right after the slice was taken; the auxiliary input, prepared once the slice resolved, runs through that record and not through the one appended while its stream was consumed.
    const { cut } = evidence;
    assert.ok(cut.sliceEnd < cut.afterSlice, 'the frozen slice excludes the event appended after its call');
    assert.ok(second.range.every(seq => seq <= cut.sliceEnd), 'the range is the slice\'s');
    assert.equal(second.record.data.input.throughSeq, cut.afterSlice, 'the auxiliary input is cut at its own synchronous preparation, after the slice');
    assert.equal(second.record.data.attempt, cut.afterSlice + 1, 'and the attempt record is appended right behind that cut');
    assert.ok(cut.duringConsumption > second.record.data.input.throughSeq && cut.duringConsumption < second.record.seq, 'an event appended while the stream is consumed is not input');

    // Request evidence: the chain of carriers on the surface folds to the disk on the control's held lines at the last seal.
    const durable = { sealed: await durableLog(ctx, sealed), control: await durableLog(ctx, control) };
    // The carriers on the surface the native restore rebuilds from the reopened log and its stored header, in that surface's order.
    const { restored } = durable.sealed;
    const bySeq = new Map(durable.sealed.events.map(event => [event.seq, event]));
    const surfaceCarriers = restored.surface.nodes.map(seq => bySeq.get(seq)).filter(isCarrierEvent).map(event => event.data.source);
    assert.deepEqual(restored.deriveMessages().filter(message => message.source?.kind === CARRIER_KIND).map(message => message.source), surfaceCarriers,
      'the restored session\'s derived messages hold the same carrier sources');
    assert.deepEqual(restored.surface.nodes, sealed.surface.nodes, 'cross-check only: the restored surface is the live one');
    const fold = foldCarried(surfaceCarriers);
    const diskAtLastSeal = diskOf(run.sealed.dir, Object.keys(FILES));

    // The raw log keeps every call and result once, as the control does.
    const kept = callsOf(sealed.snapshotEvents());
    assert.equal(new Set(kept.calls).size, kept.calls.length, 'each tool call once');
    assert.deepEqual([...kept.results].sort(), [...kept.calls].sort(), 'each result once');
    assert.deepEqual(kept, callsOf(control.snapshotEvents()));

    // B's observation: the rewritten obs.txt is edited through after the seal and refused in the control; stale.txt, rewritten between B's stat and read, is refused as stale.
    const obsOld = 'observed line 2 (rewritten)\n';
    const obsEdit = { sealed: await runTool(ctx, run.sealed.agent, 'edit', { file_path: run.sealed.at('obs.txt'), old_string: obsOld, new_string: 'observed line two\n' }) };
    obsEdit.control = await runTool(ctx, run.control.agent, 'edit', { file_path: run.control.at('obs.txt'), old_string: obsOld, new_string: 'observed line two\n' });
    assert.equal(obsEdit.sealed.isError, false, `B's observation lets the edit through: ${JSON.stringify(obsEdit.sealed)}`);
    assert.equal(obsEdit.control.isError, true, 'control: without B the edit is stale');
    const staleEdit = await runTool(ctx, run.sealed.agent, 'edit', { file_path: run.sealed.at('stale.txt'), old_string: 'stale line 2 (rewritten after the stat)\n', new_string: 'stale line two\n' });
    assert.equal(evidence.rewroteAfterStat, true, 'the rewrite came after B\'s stat');
    assert.ok(entry(sources[1], 'stale.txt').write.every(([, text]) => text.endsWith('(rewritten after the stat)')), 'and before its read, which carried the rewritten text');
    assert.equal(staleEdit.isError, true, `a rewrite between B's stat and read makes the edit stale: ${JSON.stringify(staleEdit)}`);
    assert.equal(staleEdit.error?.info?.code, 'FS_STALE_VERSION', 'B observed the file, at the version before the rewrite');
    assert.equal(obsEdit.control.error?.info?.code, 'FS_STALE_VERSION');
    evidence.edits = { obsSealed: obsEdit.sealed.isError, obsControl: obsEdit.control.error?.info?.code ?? obsEdit.control.error, stale: staleEdit.error?.info?.code ?? staleEdit.error };

    // Cold: each session's own durable log and Store, read with `open(id, 'read').read()`, rebuilt by a fresh composition.
    const store = openStore(STORE_PATH);
    try {
      const recordsBefore = { sealed: recordsOf(store, sealed.id), control: recordsOf(store, control.id) };
      assert.ok(recordsBefore.sealed.length > 0);
      const cold = {
        sealed: coldWatcher({ store, sessionId: sealed.id, cwd: run.sealed.dir, events: durable.sealed.events }),
        control: coldWatcher({ store, sessionId: control.id, cwd: run.control.dir, events: durable.control.events }),
      };
      assert.deepEqual(durable.sealed.events.filter(isCarrierEvent).map(event => event.seq), seals.map(seal => seal.carrier.seq), 'the durable log holds both carriers');
      const inSealed = text => text.replaceAll(run.control.dir, run.sealed.dir);
      for (const side of ['sealed', 'control']) {
        assert.deepEqual(cold[side].diagnostics, [], `${side}: the cold rebuild reports nothing`);
        assert.deepEqual(cold[side].treeCalls, { resolve: 0, stat: 0, readText: 0 }, `${side}: the cold rebuild replays every record and reads no file`);
      }
      assert.equal(cold.sealed.watcher.getStatus().segment, 0, 'no seal opens a Context Epoch');
      // spec:110: attribution, fragments, resource quantities and read/edit/reread statistics equal the off-mode run's.
      assert.deepEqual(resourcesOf(cold.sealed.watcher), JSON.parse(inSealed(JSON.stringify(resourcesOf(cold.control.watcher)))));
      assert.deepEqual(recordsBefore.sealed, recordsBefore.control.map(row => ({ tool_use_id: row.tool_use_id, record: inSealed(row.record) })), 'the same attribution record per call');
      assert.deepEqual({ sealed: recordsOf(store, sealed.id), control: recordsOf(store, control.id) }, recordsBefore, 'the cold rebuilds write no record');
      // The current measurement follows H→C: the sealed run measures only what the seals left.
      assert.ok(cold.sealed.watcher.getHistory().length < cold.control.watcher.getHistory().length, 'the withdrawn steps leave the measurement');
      // foldCarried over the durable log's surface carriers equals the disk text on the control's held lines at the last seal's cutoff.
      const controlHeld = new Map([...cold.control.watcher._engine.heldLines()].filter(([key]) => key.startsWith(run.control.dir)).map(([key, numbers]) => [inSealed(key), numbers]));
      assert.deepEqual(plainView(fold.paths), plainView(diskView(controlHeld, diskAtLastSeal)), 'the carried chain is the disk on the held lines');
      // Each rebuild holds only its own session's facts: the shared database is keyed by session, and a record or resource of the other run would surface here under the other directory.
      const own = { sealed: run.sealed.dir, control: run.control.dir };
      for (const [side, other] of [['sealed', 'control'], ['control', 'sealed']]) {
        const keys = [...cold[side].watcher._engine.heldLines().keys()];
        assert.ok(keys.every(key => key === `skill:${SKILL}` || key.startsWith(`${own[side]}/`)), `${side}: every held resource is its own run's: ${keys.join(', ')}`);
        assert.ok(recordsBefore[side].every(row => !row.record.includes(own[other])), `${side}: no record names the other run's files`);
      }
      // The skill payload: the control's accepted skill resource and the text of its unerrored result, read from its own durable log.
      const skillCall = durable.control.events.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content).find(block => block.type === 'tool-call' && block.name === 'skill');
      const skillResult = durable.control.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === skillCall.id);
      assert.equal(skillResult.data.message.isError ?? false, false, 'the control\'s skill call succeeded');
      assert.ok(cold.control.watcher._engine.heldLines().has(`skill:${SKILL}`), 'the control accepted the skill\'s effect');
      assert.ok(cold.sealed.watcher._engine.heldLines().has(`skill:${SKILL}`), 'the sealed rebuild keeps the withdrawn skill call\'s effect');
      const controlText = skillResult.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      assert.ok(controlText.length > 0);
      assert.deepEqual([...fold.skills], [[SKILL, controlText]], 'the carried skill payload is the control\'s accepted result text');
      evidence.skillPayloadChars = controlText.length;
      evidence.heldPaths = [...controlHeld.keys()].map(key => key.slice(run.sealed.dir.length + 1)).sort();
    } finally {
      closeStore(store);
    }
    assert.deepEqual(stderrLines.filter(line => line.includes('inner_')), [], 'no inner diagnostic');
    console.log(JSON.stringify(evidence));
    await ctx.fiber.dispose();
  },

  // The stock entries beside the seal, each firing alone in its own session, then the recount after its checkpoint.
  async 'loop-stock'() {
    const contextWindows = { 'cap-model': HUGE_WINDOW, 'switch-from': HUGE_WINDOW, 'switch-to': HUGE_WINDOW, 'over-model': HUGE_WINDOW };
    const overflowAt = new Map();
    const rig = await mountShippedLoop({
      tools: true, commands: true, contextWindows, summary, padding: stockPadding,
      reply: (n, options) => (overflowAt.get(options.sessionId) === n ? { chunks: overflowChunks() } : reply(n, options)),
      // A provider usage below the surface's own price, so the meter prices the surface itself.
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stock: { compaction: {
        thresholdRatio: THRESHOLD_RATIO, retainRatio: RETAIN_RATIO, headroomTokens: 0, maxTokens: 1_000,
        modelPolicies: [{ provider: 'mock', model: 'switch-to', retainRatio: SWITCH_RETAIN_RATIO }],
      } },
    });
    const { ctx, call } = rig;
    const evidence = {};
    const store = openStore(STORE_PATH);

    // Capacity: `/sw-continue`, its first seal, a second seal, a held skeleton call answered by `/sw-load`, then the step pressure compacts all before the second carrier.
    {
      const cap = await stockSession(rig, 'capacity', 'cap-model');
      const { session, agent, at } = cap;
      await cap.turn(directive('read', { file_path: at('kept.txt') }));
      await cap.turn(directive('prepare_handoff', { summary: 'The work so far.', paths_to_keep: [{ path: 'kept.txt' }] }));
      assert.equal((await commandOf(ctx, agent, '/sw-continue')).kind, 'success');
      const events0 = session.snapshotEvents();
      const payload0 = events0.findLast(isPayloadEvent);
      const read0 = events0.findLast(isReadEvent);
      assert.ok(payload0 !== undefined && read0 !== undefined && read0.seq > payload0.seq, '/sw-continue delivered the payload and the read message');
      const payloadData = JSON.stringify(payload0.data);
      await cap.turn(directive('read', { file_path: at('big.txt') }));
      const first = await cap.untilSeal('before the first seal');
      // `/sw-continue` then the first seal: the clear's checkpoint, the payload, the read message and the follow-up are the cleared epoch's initial prefix and stay resident, the range opens with the first model step, and the kept lines the read message showed are the baseline of B.
      const readData = JSON.stringify(read0.data);
      assert.equal(session.snapshotEvents()[first.range[0]].type, 'assistant/message', 'the range opens with the first model step behind the prefix');
      assert.ok(first.range[0] > read0.seq && [payload0.seq, read0.seq].every(seq => !first.range.includes(seq) && session.surface.nodes.includes(seq)), 'the payload and the read message stay on the surface, outside the range');
      assert.equal(JSON.stringify(session.snapshotEvents()[payload0.seq].data), payloadData);
      assert.equal(JSON.stringify(session.snapshotEvents()[read0.seq].data), readData, 'the load\'s read message, which carries the evidence B is built against, is as the load wrote it');
      const payloadInMain = first.main.messages.find(message => message.id === payload0.data.id);
      assert.deepEqual(payloadInMain?.content, payload0.data.content, 'the main request carries the payload message unchanged');
      assert.ok(first.main.messages.some(message => message.id === read0.data.id), 'and the read message');
      assert.equal(first.carrier.data.source.paths.find(each => each.path === at('kept.txt')), undefined, 'the kept lines the load showed are not written again');
      assert.equal(first.main.messages.filter(message => textsIn(message).includes('kept line 7')).length, 1, 'they appear once in the request, in the load\'s read message');
      await cap.turn(directive('read', { file_path: at('mid.txt') }));
      const second = await cap.untilSeal('before the second seal');
      assert.equal(second.carrier.data.source.paths.find(each => each.path === at('kept.txt'))?.write, undefined, 'the first carrier is the baseline: kept.txt has nothing new');
      // A skeleton call pauses until the `/sw-load` payload follows it.
      // Both calls in one step: the steps from the second carrier to the read after the checkpoint stay under the seal's step count, so that read falls in the range of the seal that follows the checkpoint.
      await cap.turn(inOneStep(['get_turn_skeleton', {}], ['prepare_handoff', { summary: 'The second handoff.', paths_to_keep: [{ path: 'kept.txt' }] }]));
      const token = handoffToken(session);
      assert.equal((await commandOf(ctx, agent, `/sw-load ${token}`)).kind, 'success');
      const payload1 = session.snapshotEvents().findLast(isPayloadEvent);
      const skeletonCall = session.snapshotEvents().findLast(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'tool-call' && block.name === 'get_turn_skeleton'));
      assert.ok(payload1.seq > skeletonCall.seq);
      await cap.turn(LOAD_FOLLOW_UP);
      const { window } = windowKeeping(ctx, session, second.carrier.seq, RETAIN_RATIO);
      contextWindows['cap-model'] = window;
      const triggered = await cap.turn('the capacity turn');
      contextWindows['cap-model'] = HUGE_WINDOW;
      const checkpoint = triggered.appended.find(isKind(CHECKPOINT_KIND));
      assert.ok(checkpoint !== undefined, `the step pressure compacted: ${triggered.appended.map(event => event.type).join(', ')}`);
      assert.equal(triggered.appended.filter(event => event.type === 'compaction/start').length, 1);
      assert.equal(triggered.appended.filter(event => event.type === INNER_CALL_RECORD_TYPE).length, 0, 'the seal did not fire: the range after the load is short');
      assert.equal(stockLog(ctx, 'step pressure').length, 1, 'the capacity entry fired');
      assert.deepEqual(session.surface.nodes.slice(1, 3), [checkpoint.seq, second.carrier.seq], 'the kept tail starts at the second carrier');
      for (const seq of [payload1.seq, skeletonCall.seq]) assert.ok(session.surface.nodes.includes(seq), 'the kept tail holds the payload and the skeleton call');
      // A later segment: the user's override and the lamp's clocks before the recount's seal.
      await cap.turn(directive('read', { file_path: at('after.txt') }));
      const segmentsBefore = store.getProfileSegments(session.id);
      const overridden = await call('user-overrides', { sessionId: session.id, overrides: { [at('after.txt')]: 'exclude' } });
      assert.equal(overridden.ok, true, JSON.stringify(overridden));
      const statusBefore = (await call('status', { sessionId: session.id })).value.payload;
      const deadBefore = (await call('buckets', { sessionId: session.id })).value.payload.dead;
      const third = await cap.untilSeal('after the checkpoint');
      // The recount's quote seals at the minimum, priced at the C ratio the session's watcher reads and with the history read of the host's own token meter.
      const { quote } = third.attempt.data;
      assert.deepEqual([quote.trigger, quote.n], ['quote', INNER_QUOTE.minSteps], JSON.stringify(quote));
      assert.ok(Number.isFinite(quote.summaryReadCost) && quote.summaryReadCost > 0, `the quote paid the history read the host's meter measured: ${JSON.stringify(quote)}`);
      assert.equal(quote.cRatio, statusBefore.cRatio, 'the ratio the host\'s status answers');
      assert.equal(third.range[0], second.carrier.seq, 'the checkpoint is the frontier and its kept tail enters the range');
      assert.ok([payload1.seq, skeletonCall.seq, second.carrier.seq].every(seq => third.range.includes(seq)), 'the old carrier, the payload and the answered skeleton call are ordinary source');
      assert.ok(third.carrier.data.source.slots.some(slot => slot.seqs.includes(second.carrier.seq)), 'the old carrier has a slot');
      assert.deepEqual(third.carrier.data.source.paths.map(each => each.path), [at('after.txt')], 'B holds only what the new epoch read: no pre-checkpoint effect');
      const statusAfter = (await call('status', { sessionId: session.id })).value.payload;
      assert.equal(statusAfter.segment, statusBefore.segment, 'the seal opens no segment');
      assert.ok(statusBefore.segment > 0, 'a later segment');
      assert.deepEqual(store.getProfileSegments(session.id), segmentsBefore, 'no saved archive moves');
      const buckets = (await call('buckets', { sessionId: session.id })).value.payload;
      assert.equal(buckets.paths.find(row => row.path === at('after.txt'))?.userOverride, 'exclude', 'the user\'s override in this segment stays in force across the seal');
      // The seal keeps the segment's first call, which keeps the lamp reliable. Its baseline is the dead that call observed, which the excluded file leaves alone.
      assert.equal(buckets.dead, deadBefore);
      assert.equal(statusAfter.rateLamp.B_default, deadBefore);
      assert.ok(deadBefore > 0, 'the segment was anchored before the seal');
      for (const key of ['cycleProgress', 'backstopLapCount']) assert.ok(statusAfter.rateLamp.rentMeter[key] >= statusBefore.rateLamp.rentMeter[key], key);
      evidence.capacity = {
        ranges: [first, second, third].map(seal => [seal.range[0], seal.range.at(-1), seal.range.length]),
        checkpoint: checkpoint.seq, window, statusBefore: pick(statusBefore), statusAfter: pick(statusAfter),
        segments: segmentsBefore.map(profile => profile.segment),
      };
    }

    // A trigger turn's checkpoint, the one compaction of its session, then the recount: the next seal's range starts at the kept tail's first node and counts from there, and its B holds only what was read after the checkpoint.
    const recount = async (handle, triggered, tailStart, entry) => {
      const { session, at } = handle;
      const checkpoint = triggered.appended.find(isKind(CHECKPOINT_KIND));
      assert.ok(checkpoint !== undefined, `${entry} compacted: ${triggered.appended.map(event => event.type).join(', ')}`);
      assert.equal(stockLog(ctx, entry).length, 1, `the ${entry} entry fired: ${triggered.appended.map(event => event.type).join(', ')}`);
      assert.deepEqual(session.surface.nodes.slice(1, 3), [checkpoint.seq, tailStart], `${entry}: the kept tail starts where its retention says`);
      await handle.turn(directive('read', { file_path: at('after.txt') }));
      const seal = await handle.untilSeal(`after the ${entry} checkpoint`);
      assert.equal(seal.range[0], tailStart, `${entry}: the checkpoint is the frontier and its kept tail enters the range`);
      assert.deepEqual(seal.carrier.data.source.paths.map(each => each.path), [at('after.txt')], `${entry}: B holds only what the new epoch read`);
      assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/start').length, 1, `${entry}: the one stock compaction of its session`);
      return { checkpoint: checkpoint.seq, range: [seal.range[0], seal.range.at(-1), seal.range.length] };
    };

    // Model switch: the step pressure under the routed model is far below its threshold; the switched-to model's window is not.
    {
      const handle = await stockSession(rig, 'switch', 'switch-from');
      await handle.turn(directive('read', { file_path: handle.at('big.txt') }));
      const first = await handle.untilSeal('before the switch');
      // A long user message, priced well above the next one, where the retained tail is to start.
      const kept = await handle.turn(`retained ${'r'.repeat(8_000)}`);
      await handle.turn('after the seal');
      const tailStart = kept.appended.find(event => event.type === 'user/message' && event.data.source.kind === 'user').seq;
      assert.ok(first.carrier.seq < tailStart);
      contextWindows['switch-to'] = windowKeeping(ctx, handle.session, tailStart, SWITCH_RETAIN_RATIO).window;
      handle.selection = { provider: 'mock', model: 'switch-to' };
      handle.agent.model.select(handle.selection);
      const triggered = await handle.turn('the switch turn');
      contextWindows['switch-to'] = HUGE_WINDOW;
      assert.equal(stockLog(ctx, 'step pressure').length, 1, 'the step pressure did not fire again');
      evidence.switch = await recount(handle, triggered, tailStart, 'model switch');
    }

    // Overflow: the provider refuses one main request as over its window; the recovery keeps only the last node.
    {
      const handle = await stockSession(rig, 'overflow', 'over-model');
      await handle.turn(directive('read', { file_path: handle.at('big.txt') }));
      await handle.untilSeal('before the overflow');
      await handle.turn('after the seal');
      overflowAt.set(handle.session.id, rig.adapter.requests.filter(request => request.kind === 'main' && request.sessionId === handle.session.id).length + 1);
      const triggered = await handle.turn('the overflow turn');
      const attempt = triggered.appended.find(event => event.type === 'assistant/attempt');
      assert.ok(attempt !== undefined, 'the refused request left its attempt');
      // The recovery retains the last surface node at the refusal (`selectCompactableRange` with no retention).
      const last = triggered.appended.filter(event => event.seq < attempt.seq && event.surfaceOp !== undefined).at(-1);
      assert.equal(triggered.appended.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed', 'the retry answered');
      evidence.overflow = await recount(handle, triggered, last.seq, 'context overflow recovery');
    }
    assert.equal(stockLog(ctx, 'model switch').length, 1);
    closeStore(store);
    assert.deepEqual(stockWarnings(ctx).map(message => message.args.map(String).join(' ')), [], 'no stock compaction failed');
    console.log(JSON.stringify(evidence));
    await ctx.fiber.dispose();
  },

  // Sessions with no mode record, or with one appended after their first turn, stay off however far they run; a mode-on session whose long result the native pruner prunes twice, under a tighter budget the second time, seals the second replacement for the original it stands for.
  async 'loop-records-and-pruner'() {
    const rig = await mountShippedLoop({ tools: true, padding: REPLY_PADDING, reply, summary });
    const { ctx, call, adapter, harness, llm } = rig;
    const { appendPluginRecord } = await fromCheckout('packages/core/session/lib/index.js');
    const selection = { provider: 'mock', model: 'loop-model' };
    const evidence = {};
    for (const name of ['no-record', 'late-record']) {
      const agent = await harness.create(`off-${name}-${Date.now().toString(16)}`, selection, { cwd: ROOT });
      const { session } = agent;
      await turnOf(agent, llm, 'the first turn');
      if (name === 'late-record') {
        const refused = await call('inner-mode/select', { sessionId: session.id, enabled: true });
        assert.equal(refused.error?.code, 'inner_mode_locked', `the selection refuses once a turn has started: ${JSON.stringify(refused)}`);
        appendPluginRecord(session, 'plugin:session-watcher/inner-mode', { v: 1, enabled: true });
      }
      for (let index = 2; index <= SEAL_STEPS + 2; index += 1) await turnOf(agent, llm, `turn ${index}`);
      assert.deepEqual(await call('inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'off', locked: true } }, `${name}: off`);
      assert.equal(adapter.requests.filter(request => request.kind === 'summary' && request.sessionId === session.id).length, 0, `${name}: no summary request`);
      assert.deepEqual(session.snapshotEvents().filter(event => event.type === INNER_CALL_RECORD_TYPE || event.type === 'compaction/prune' || isCarrierEvent(event)).map(event => event.type), [], `${name}: no record, prune or carrier`);
      evidence[name] = { turns: SEAL_STEPS + 2, events: session.seq };
    }

    // The native pruner, mounted with one budget and then again with a tighter one, prunes the long result o to r1, then r1 to r2.
    const prunerPlugin = await fromCheckout('packages/compaction/compaction-tool-result-pruner/lib/index.js');
    const dir = join(ROOT, 'pruned');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'long.txt'), textOf(lines(`long ${'l'.repeat(40)}`, 200)));
    const agent = await harness.create(`pruned-${Date.now().toString(16)}`, selection, { cwd: dir });
    const { session } = agent;
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    await turnOf(agent, llm, directive('read', { file_path: join(dir, 'long.txt') }));
    const original = session.snapshotEvents().find(event => event.type === 'tool/result');
    const pruneWith = async (config) => {
      const fiber = await ctx.plugin(prunerPlugin.default, config);
      const result = ctx.toolResultPruner.pruneSession(session);
      await fiber.dispose();
      assert.equal(result.pruned.length, 1, JSON.stringify(result));
      return result.pruned[0];
    };
    const r1 = await pruneWith({ thresholdChars: 4_000, headChars: 1_500, tailChars: 1_500 });
    const r2 = await pruneWith({ thresholdChars: 2_000, headChars: 600, tailChars: 600 });
    assert.deepEqual([r1.originalSeq, r2.originalSeq], [original.seq, r1.replacementSeq], 'r1 replaces o, r2 replaces r1');
    let seal = null;
    for (let index = 2; index <= SEAL_STEPS + 2 && seal === null; index += 1) {
      const at0 = session.seq;
      const requestsAt = adapter.requests.length;
      await turnOf(agent, llm, `pruned turn ${index}`);
      if (session.snapshotEvents().slice(at0).some(event => event.type === INNER_CALL_RECORD_TYPE)) seal = sealOf({ session, at: at0, adapter, requestsAt, selection, quiet: false });
    }
    assert.ok(seal !== null, 'the pruned session sealed');
    assert.ok(seal.range.includes(r2.replacementSeq) && !seal.range.includes(r1.replacementSeq), 'the current replacement r2 is in the range, r1 is not on the surface');
    for (const seq of [original.seq, r2.replacementSeq]) assert.ok(seal.carrier.sourceEventSeqs.includes(seq), `the carrier cites ${seq}: the original and its current replacement`);
    assert.ok(seal.carrier.data.source.slots.some(slot => slot.seqs.includes(r2.replacementSeq)));
    evidence.pruned = { original: original.seq, r1: r1.replacementSeq, r2: r2.replacementSeq, range: [seal.range[0], seal.range.at(-1)], cites: seal.carrier.sourceEventSeqs.length };
    console.log(JSON.stringify(evidence));
    await ctx.fiber.dispose();
  },

  // The Rate Lamp's clocks in a later segment, at zero while the calls are pending, moved by the seal's post and held behind it.
  'loop-lamp': () => lampCase({ growth: LAMP_GROWTH }),
  // The same with main usage growing fast enough that the interval the post closes passes bill cycles.
  'loop-lamp-counters': () => lampCase({ growth: COUNTER_GROWTH, counters: true }),

  // Consecutive user-triggered attempts through the real loop and the shipped entry, each a fresh dispatch. The first is filtered on every rung of the ladder (the session's model, its repeat and the saved backup model), so one user-triggered attempt dispatches one request per rung and its turn fails; every request of the next ends in tool calls, which the seal asks again up to the bound of `SUMMARY_MAX_REQUESTS` before its turn fails, and the third succeeds. Each failed request is its own recorded consumed stream; neither failed turn prunes, replaces, executes the tool call the second emitted, or changes the mode or the range.
  async 'loop-repeated-failures'() {
    const dispatches = [];
    const usage = { inputTokens: 4, outputTokens: 17, cacheReadTokens: 130, cacheWriteTokens: 7 };
    const rungs = 1 + SUMMARY_FILTER_RETRIES + 1;
    // The backup model the user saved in the settings: the exact route alone.
    const BACKUP = { provider: 'backup-provider', model: 'backup-model' };
    const rig = await mountShippedLoop({
      padding: REPLY_PADDING,
      settings: { summaryFallbackModel: BACKUP },
      async* summary(count, options) {
        const request = dispatches.push({ count, route: { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort } }) - 1;
        if (request < rungs) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: '["a partial' };
          yield { type: 'usage', usage };
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'Provider stopped with: content_filtered', code: 'PI_AI_ERROR' } } };
        } else if (request < rungs + SUMMARY_MAX_REQUESTS) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'toolu_filtered', name: 'get_bucket_summary', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'toolu_filtered', name: 'get_bucket_summary', arguments: '{}' } };
          yield { type: 'usage', usage };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield* summary(count);
        }
      },
    });
    const { ctx, call, adapter, harness, llm } = rig;
    // The saved backup model names a provider of its own: the mock adapter answers it too, so the failure the ladder meets there is the filter and no missing route.
    ctx.llm.registerAdapter([BACKUP.provider], adapter);
    // The service-level dispatches of the auxiliary purpose, counted where the llm service receives them, apart from the adapter's own record.
    const serviceCalls = [];
    ctx.on('llm/stream', (options, next) => {
      if (options.purpose === 'inner-compaction') serviceCalls.push(options.sessionId);
      return next();
    });
    const agent = await harness.create(`repeat-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
    const { session } = agent;
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    for (let turn = 1; turn <= SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
    assert.equal(dispatches.length, 0, 'no seal below the threshold');

    const mainsOf = () => adapter.requests.filter(request => request.kind === 'main' && request.sessionId === session.id).length;
    const failed = [];
    let requested = 0;
    for (const [attempt, requests, expected] of [[1, rungs, /finished with error: Provider stopped with: content_filtered/], [2, SUMMARY_MAX_REQUESTS, /finished with tool-calls/]]) {
      const nodesBefore = [...session.surface.nodes];
      const at0 = session.seq;
      const mainsBefore = mainsOf();
      await turnOf(agent, llm, `the user-triggered attempt ${attempt}`);
      requested += requests;
      const appended = session.snapshotEvents().slice(at0);
      const records = appended.filter(event => event.type === INNER_CALL_RECORD_TYPE);
      assert.equal(records.length, requests, `attempt ${attempt}: each of its requests has its consumed call recorded once`);
      assert.equal(appended.filter(event => event.type === INNER_ATTEMPT_RECORD_TYPE).length, requests, `attempt ${attempt}: each request is an attempt of its own`);
      assert.equal(dispatches.length, requested, `attempt ${attempt}: one fresh adapter dispatch per request, not a replay of the earlier outcome`);
      assert.equal(serviceCalls.length, requested, `attempt ${attempt}: one fresh llm-service dispatch per request`);
      assert.equal(adapter.requests.filter(request => request.kind === 'summary').length, requested);
      assert.deepEqual(appended.filter(event => event.type === 'compaction/prune' || isCarrierEvent(event) || event.type === 'assistant/message' || event.type === 'tool/result'), [],
        `attempt ${attempt}: nothing is pruned, replaced, answered or executed`);
      assert.equal(mainsOf(), mainsBefore, `attempt ${attempt}: the step is not entered`);
      const end = appended.findLast(event => event.type === 'turn/end');
      assert.equal(end.data.reason.kind, 'error', `attempt ${attempt}: the turn ends with the error`);
      assert.match(end.data.reason.error.message, expected);
      assert.deepEqual(session.surface.nodes, nodesBefore, `attempt ${attempt}: the surface and so the range are unchanged`);
      assert.deepEqual(await call('inner-mode', { sessionId: session.id }), { ok: true, value: { mode: 'on', locked: true } }, `attempt ${attempt}: the mode is unchanged`);
      failed.push(records);
    }
    const [filteredRecords, toolCalledRecords] = failed;
    const [toolCalled] = toolCalledRecords;
    const [filtered] = filteredRecords;
    const own = { provider: 'mock', model: 'loop-model' };
    assert.deepEqual(dispatches.slice(0, rungs).map(dispatch => `${dispatch.route.provider}/${dispatch.route.model}`),
      [own, ...Array(SUMMARY_FILTER_RETRIES).fill(own), BACKUP].map(route => `${route.provider}/${route.model}`),
      'the three requests of the first attempt took the session\'s model, its repeat and the saved backup model in that order');
    assert.equal(dispatches[rungs - 1].route.reasoningEffort, undefined, 'the last request names no effort: the backup model\'s own default controls apply');
    assert.deepEqual(filteredRecords.map(record => ({ provider: record.data.selection.provider, model: record.data.selection.model })),
      dispatches.slice(0, rungs).map(dispatch => ({ provider: dispatch.route.provider, model: dispatch.route.model })), 'each call record names the route its request took');
    assert.deepEqual(filteredRecords.at(-1).data.selection, BACKUP, 'the last record keeps the whole saved route');
    const finishOf = record => llm.lastAssistantStreamChunk(record.data.stream, 'finish');
    for (const record of filteredRecords) {
      assert.deepEqual(finishOf(record).reason, { kind: 'error', failure: { message: 'Provider stopped with: content_filtered', code: 'PI_AI_ERROR' } }, 'every record of the first attempt keeps the provider\'s stop');
      assert.equal(record.data.thrown, undefined);
    }
    for (const record of toolCalledRecords) {
      assert.equal(finishOf(record).reason.kind, 'tool-calls', 'every record of the second attempt keeps the finish');
      assert.ok(JSON.stringify(record.data.stream).includes('get_bucket_summary'), 'and the tool call it emitted, which nothing executed');
    }
    assert.notDeepEqual(filtered.data.stream, toolCalled.data.stream, 'two distinct consumed streams');
    assert.deepEqual(toolCalled.data.range, filtered.data.range, 'the target range is the same');
    assert.ok(toolCalled.data.input.throughSeq > filteredRecords.at(-1).data.input.throughSeq, 'each call is cut at its own preparation');

    const sealedAt = session.seq;
    const mainsBefore = mainsOf();
    await turnOf(agent, llm, 'the third user-triggered attempt');
    const sealedEvents = session.snapshotEvents().slice(sealedAt);
    const types = sealedEvents.map(event => event.type);
    const recordAt = types.indexOf(INNER_CALL_RECORD_TYPE);
    assert.deepEqual(types.slice(recordAt, recordAt + 3), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message'], `the third attempt seals: ${types.join(', ')}`);
    const [record, , carrier] = sealedEvents.slice(recordAt, recordAt + 3);
    assert.deepEqual(record.data.range, filtered.data.range, 'the sealed range is the one every failure targeted');
    assert.equal(dispatches.length, requested + 1);
    assert.equal(carrier.data.source.slots.length, record.data.range.length);
    assert.equal(mainsOf(), mainsBefore + 1, 'the step is entered after the seal');
    assert.equal(callRecordsOf(session).length, requested + 1, 'one record per consumed call');
    assert.equal(session.snapshotEvents().filter(isCarrierEvent).length, 1);
    console.log(JSON.stringify({ requests: dispatches.length, records: callRecordsOf(session).map(each => finishOf(each)?.reason.kind), range: [record.data.range[0], record.data.range.at(-1), record.data.range.length] }));
    await ctx.fiber.dispose();
  },
  // A summary whose first two replies stop normally and are not the notes object, answered in the format by the third: through the shipped entry and the real loop the seal asks again inside the one turn, each request an attempt of its own, over the same request, and the turn is not ended.
  async 'loop-format-retry'() {
    const dispatches = [];
    const usage = { inputTokens: 4, outputTokens: 17, cacheReadTokens: 130, cacheWriteTokens: 7 };
    const stopped = async function* (text) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const rig = await mountShippedLoop({
      padding: REPLY_PADDING,
      async* summary(count) {
        const attempt = dispatches.push({ count }) - 1;
        if (attempt === 0) yield* stopped('these are not the notes');
        else if (attempt === 1) yield* stopped('{"1": "a note for the first slot alone"}');
        else yield* summary(count);
      },
    });
    const { ctx, call, adapter, harness, llm } = rig;
    const serviceCalls = [];
    ctx.on('llm/stream', (options, next) => {
      if (options.purpose === 'inner-compaction') serviceCalls.push(options.sessionId);
      return next();
    });
    const agent = await harness.create(`format-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
    const { session } = agent;
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    for (let turn = 1; turn <= SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
    assert.equal(dispatches.length, 0, 'no seal below the threshold');

    const mainsOf = () => adapter.requests.filter(request => request.kind === 'main' && request.sessionId === session.id).length;
    const at0 = session.seq;
    const mainsBefore = mainsOf();
    await turnOf(agent, llm, 'the turn the seal falls in');

    assert.equal(dispatches.length, 3, 'the reply is asked for until it is in the format');
    assert.equal(serviceCalls.length, 3, 'three llm-service dispatches');
    const summaries = adapter.requests.filter(request => request.kind === 'summary' && request.sessionId === session.id);
    assert.equal(summaries.length, 3);
    assert.deepEqual(summaries[1].messages, summaries[0].messages, 'the second request is the first, as it was');
    assert.deepEqual(summaries[2].messages, summaries[0].messages, 'and the third');
    const appended = session.snapshotEvents().slice(at0);
    const only = type => appended.filter(event => event.type === type);
    const attempts = only(INNER_ATTEMPT_RECORD_TYPE);
    const calls = only(INNER_CALL_RECORD_TYPE);
    const ends = only('plugin:session-watcher/inner-end');
    assert.deepEqual([attempts.length, calls.length, ends.length, only('compaction/prune').length, appended.filter(isCarrierEvent).length], [3, 3, 2, 1, 1]);
    assert.deepEqual(ends.map(end => [end.data.attempt, end.data.outcome]), [[attempts[0].seq, 'failed'], [attempts[1].seq, 'failed']]);
    assert.deepEqual(calls.map(record => record.data.attempt), attempts.map(attempt => attempt.seq), 'each consumed call names its own attempt');
    calls.forEach((record, at) => assert.equal(record.data.input.throughSeq, attempts[at].seq - 1, `request ${at + 1} is cut at its own preparation`));
    assert.ok(calls[0].data.input.throughSeq < calls[1].data.input.throughSeq && calls[1].data.input.throughSeq < calls[2].data.input.throughSeq);
    assert.deepEqual(calls[1].data.range, calls[0].data.range);
    assert.deepEqual(calls[2].data.range, calls[0].data.range);
    const [carrier] = appended.filter(isCarrierEvent);
    assert.ok(carrier.sourceEventSeqs.includes(calls[2].seq), 'the carrier cites the call that answered');
    assert.ok(!carrier.sourceEventSeqs.includes(calls[0].seq) && !carrier.sourceEventSeqs.includes(calls[1].seq), 'and neither failed call');
    assert.equal(appended.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed', 'the turn is not ended');
    assert.equal(mainsOf(), mainsBefore + 1, 'the step is entered once, after the seal');
    const { value } = await call('inner-monitor', { sessionId: session.id });
    assert.deepEqual(value.attempts.map(row => [row.id, row.status]), [[attempts[0].seq, 'failed'], [attempts[1].seq, 'failed'], [attempts[2].seq, 'committed']]);
    console.log(JSON.stringify({ requests: dispatches.length, statuses: value.attempts.map(row => row.status), range: [calls[0].data.range[0], calls[0].data.range.at(-1), calls[0].data.range.length] }));
    await ctx.fiber.dispose();
  },
  // A summary reply that stops normally and fails JSON syntax alone, its first note quoting an array with the inner quotes unescaped: through the shipped entry, which carries the library bundled, and the real loop the seal recovers it locally and commits after the one request, with no failed attempt and no second dispatch.
  async 'loop-summary-recovery'() {
    const dispatches = [];
    const usage = { inputTokens: 4, outputTokens: 17, cacheReadTokens: 130, cacheWriteTokens: 7 };
    const stopped = async function* (text) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const rig = await mountShippedLoop({
      padding: REPLY_PADDING,
      async* summary(count) {
        dispatches.push({ count });
        yield* stopped(unescapedNotes(count));
      },
    });
    const { ctx, call, adapter, harness, llm } = rig;
    const serviceCalls = [];
    ctx.on('llm/stream', (options, next) => {
      if (options.purpose === 'inner-compaction') serviceCalls.push(options.sessionId);
      return next();
    });
    const agent = await harness.create(`recovery-${Date.now().toString(16)}`, { provider: 'mock', model: 'loop-model' }, { cwd: process.env.TMPDIR });
    const { session } = agent;
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    for (let turn = 1; turn <= SEAL_STEPS; turn += 1) await turnOf(agent, llm, `ask ${turn}`);
    assert.equal(dispatches.length, 0, 'no seal below the threshold');

    const mainsOf = () => adapter.requests.filter(request => request.kind === 'main' && request.sessionId === session.id).length;
    const at0 = session.seq;
    const mainsBefore = mainsOf();
    await turnOf(agent, llm, 'the turn the seal falls in');

    assert.equal(dispatches.length, 1, 'the recovered reply is the one request');
    assert.equal(serviceCalls.length, 1, 'one llm-service dispatch');
    assert.equal(adapter.requests.filter(request => request.kind === 'summary' && request.sessionId === session.id).length, 1);
    const appended = session.snapshotEvents().slice(at0);
    const only = type => appended.filter(event => event.type === type);
    const [attempt] = only(INNER_ATTEMPT_RECORD_TYPE);
    const [record] = only(INNER_CALL_RECORD_TYPE);
    assert.deepEqual([only(INNER_ATTEMPT_RECORD_TYPE).length, only(INNER_CALL_RECORD_TYPE).length, only('plugin:session-watcher/inner-end').length, only('compaction/prune').length, appended.filter(isCarrierEvent).length], [1, 1, 0, 1, 1]);
    assert.equal(record.data.attempt, attempt.seq, 'the call names its attempt');
    assert.equal(llm.joinAssistantStreamText(record.data.stream), unescapedNotes(dispatches[0].count), 'the record keeps the reply as the model wrote it');
    const [carrier] = appended.filter(isCarrierEvent);
    assert.ok(carrier.sourceEventSeqs.includes(record.seq), 'the carrier cites the recovered call');
    // The notes the model was asked for, in order; a user's own slot holds the program's verbatim note.
    const asked = carrier.data.source.slots.map(slot => slot.text).filter(text => !text.startsWith('user: '));
    assert.deepEqual(asked, [QUOTED_NOTE, ...Array.from({ length: dispatches[0].count - 1 }, (_, index) => `summary of slot ${index + 2}`)], 'every note as the model meant it, the first with its quotes');
    assert.equal(appended.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
    assert.equal(mainsOf(), mainsBefore + 1, 'the step is entered once, after the seal');
    const { value } = await call('inner-monitor', { sessionId: session.id });
    assert.deepEqual(value.attempts.map(row => [row.id, row.status]), [[attempt.seq, 'committed']]);
    console.log(JSON.stringify({ requests: dispatches.length, statuses: value.attempts.map(row => row.status), range: [record.data.range[0], record.data.range.at(-1), record.data.range.length] }));
    await ctx.fiber.dispose();
  },
  // Children made by the real subagent runtime: a plain subagent of each mode takes its parent's mode as its own record before its first turn; a fork of a mode-on parent whose completed-turn prefix holds a checkpoint and a load inherits the mode with the prefix and counts the prefix's unsealed steps.
  async 'loop-creation'() {
    const rig = await mountShippedLoop({ tools: true, commands: true, subagents: true, persistence: true, settings: { subagentsInheritCompaction: true }, padding: REPLY_PADDING, reply, summary });
    const { ctx, call, adapter, llm } = rig;
    const MODE = 'plugin:session-watcher/inner-mode';
    const evidence = {};
    // Every agent the runtime creates, as `agent/created` announces it; and each watched child's mode as the RPC reads it while the child's first main request is being made.
    const created = new Map();
    ctx.on('agent/created', ({ agent }) => { created.set(agent.id, agent); });
    const watched = new Set();
    const modeDuring = new Map();
    ctx.on('llm/stream', (options, next) => {
      const stream = next();
      if (!watched.has(options.sessionId) || modeDuring.has(options.sessionId)) return stream;
      return (async function* () {
        modeDuring.set(options.sessionId, await call('inner-mode', { sessionId: options.sessionId }));
        yield* stream;
      })();
    });
    const childOf = async (parent, provider, label) => {
      const activation = await ctx.subagents.startActivation({
        provider, label, delivery: 'caller', signal: new AbortController().signal,
        request: { parent, prompt: [{ type: 'text', text: `the ${label} task` }], signal: new AbortController().signal },
      });
      watched.add(activation.childId);
      const result = await activation.result;
      const child = created.get(activation.childId);
      assert.ok(child !== undefined, `${label}: the runtime announced the child: ${JSON.stringify(result).slice(0, 300)}`);
      return child;
    };
    // One message from the parent to its child through the runtime, run until the child's turn after it ended: the child's live agent then.
    const messageChild = async (parent, childId, text) => {
      const ended = (agent) => agent?.session.snapshotEvents().filter(event => event.type === 'turn/end').length ?? 0;
      const before = ended(ctx.agents.get(childId) ?? created.get(childId));
      await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal });
      for (let tries = 0; tries < 500; tries += 1) {
        const agent = ctx.agents.get(childId) ?? created.get(childId);
        if (ended(agent) > before) {
          await agent.whenIdle?.();
          return agent;
        }
        await sleep(10);
      }
      throw new Error(`the child ${childId} did not answer ${text}`);
    };

    for (const enabled of [true, false]) {
      const parent = await stockSession(rig, `plain-${enabled ? 'on' : 'off'}`, 'loop-model');
      if (!enabled) assert.deepEqual(await call('inner-mode/select', { sessionId: parent.session.id, enabled: false }), { ok: true, value: {} });
      await parent.turn('the parent turn');
      const child = await childOf(parent.agent, 'spawn', `plain ${enabled}`);
      const events = child.session.snapshotEvents();
      assert.equal(child.session.header.origin, 'subagent');
      assert.equal(child.session.header.isSeeded, false);
      assert.equal(child.session.header.parentSession, parent.session.id);
      const record = events.find(event => event.type === MODE);
      const firstTurn = events.find(event => event.type === 'turn/start');
      assert.deepEqual(record?.data, { v: 1, enabled }, `the plain subagent holds its parent's mode as its own record: ${events.map(event => event.type).join(', ')}`);
      assert.ok(record.seq < firstTurn.seq, 'appended before its first turn started');
      assert.deepEqual(modeDuring.get(child.session.id), { ok: true, value: { mode: enabled ? 'on' : 'off', locked: true } }, 'the child reads that mode, locked, during its first request');
      evidence[`plain-${enabled}`] = { record: record.seq, firstTurn: firstTurn.seq };
    }

    // The fork's parent: `/sw-continue` (a checkpoint, the payload and the read message), then counted steps short of a seal.
    const parent = await stockSession(rig, 'fork-parent', 'loop-model');
    const { at } = parent;
    await parent.turn(directive('read', { file_path: at('kept.txt') }));
    await parent.turn(directive('prepare_handoff', { summary: 'The work so far.', paths_to_keep: [{ path: 'kept.txt' }] }));
    assert.equal((await commandOf(ctx, parent.agent, '/sw-continue')).kind, 'success');
    await parent.turn(directive('read', { file_path: at('after.txt') }));
    for (let index = 1; index <= 3; index += 1) await parent.turn(`parent turn ${index}`);
    const parentEvents = parent.session.snapshotEvents();
    const payload = parentEvents.findLast(isPayloadEvent);
    // The cleared epoch's initial prefix is the checkpoint, the payload, the read message and the follow-up; its unsealed steps begin with its first model step.
    const firstStepOf = (events, nodes) => nodes.slice(nodes.indexOf(payload.seq) + 1).find(seq => events[seq].type === 'assistant/message');
    const parentNodes = parent.session.surface.nodes;
    const parentSteps = countedSteps(parentEvents, parentNodes.slice(parentNodes.indexOf(firstStepOf(parentEvents, parentNodes))));
    assert.ok(parentEvents.some(isKind(CHECKPOINT_KIND)) && parentSteps > 0 && parentSteps < SEAL_STEPS, `the parent holds a checkpoint and ${parentSteps} unsealed steps`);
    assert.equal(parentEvents.filter(event => event.type === INNER_CALL_RECORD_TYPE).length, 0);

    const first = await childOf(parent.agent, 'fork', 'fork');
    let { session } = first;
    assert.equal(session.header.isSeeded, true);
    assert.ok(session.inheritedEventCount > payload.seq, 'the fork inherits the prefix through the payload');
    const inherited = session.snapshotEvents().slice(0, session.inheritedEventCount);
    assert.ok(inherited.some(isKind(CHECKPOINT_KIND)) && inherited.some(event => event.type === MODE), 'the inherited prefix holds the checkpoint and the parent\'s mode record');
    assert.equal(session.snapshotEvents().slice(session.inheritedEventCount).filter(event => event.type === MODE).length, 0, 'the fork appends no mode record of its own');
    assert.deepEqual(modeDuring.get(session.id), { ok: true, value: { mode: 'on', locked: true } }, 'the fork reads its inherited mode');
    // The fork seals once its range, the prefix's unsealed steps included, counts SEAL_STEPS.
    let seal = null;
    let nodesBefore = null;
    for (let index = 1; index <= SEAL_STEPS && seal === null; index += 1) {
      nodesBefore = [...session.surface.nodes];
      const at0 = session.seq;
      const requestsAt = adapter.requests.length;
      session = (await messageChild(parent.agent, first.id, `fork turn ${index}`)).session;
      if (session.snapshotEvents().slice(at0).some(event => event.type === INNER_CALL_RECORD_TYPE)) seal = sealOf({ session, at: at0, adapter, requestsAt, selection: parent.selection, quiet: false });
    }
    assert.ok(seal !== null, 'the fork sealed');
    const events = session.snapshotEvents();
    assert.equal(countedSteps(events, seal.range), SEAL_STEPS);
    const inheritedSteps = countedSteps(events, seal.range.filter(seq => seq < session.inheritedEventCount));
    assert.ok(inheritedSteps >= parentSteps, `the inherited unsealed steps count: ${inheritedSteps} of the parent's ${parentSteps}`);
    assert.equal(seal.range[0], firstStepOf(events, nodesBefore), 'the range starts with the inherited epoch\'s first model step, behind its initial prefix');
    assert.ok(session.surface.nodes.includes(payload.seq) && !seal.range.includes(payload.seq));
    evidence.fork = { inheritedEventCount: session.inheritedEventCount, payload: payload.seq, parentSteps, inheritedSteps, range: [seal.range[0], seal.range.at(-1), seal.range.length] };
    console.log(JSON.stringify(evidence));
    await ctx.fiber.dispose();
  },

  // The quote of a seal over the shipped host: L_A is the range's text priced under the calibrated pair the model policy gives the session's epoch model, where the prune keeps the meter's own heuristic count, which no model changes. Two sessions of one script, a model the policy calibrates and one it does not, over text-only turns.
  async 'loop-quote'() {
    const rig = await mountShippedLoop({ padding: REPLY_PADDING, reply: () => 'a steady answer', summary });
    const { call, harness, llm } = rig;
    const sealed = {};
    for (const model of ['deepseek-quote', 'loop-model']) {
      const agent = await harness.create(`quote-${model}-${Date.now().toString(16)}`, { provider: 'mock', model }, { cwd: process.env.TMPDIR });
      const { session } = agent;
      assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
      let record;
      for (let turn = 1; turn <= SEAL_WAIT_TURNS && record === undefined; turn += 1) {
        await turnOf(agent, llm, `ask ${turn}`);
        record = callRecordsOf(session)[0];
      }
      assert.ok(record !== undefined, `${model}: the session sealed`);
      const events = session.snapshotEvents();
      const prune = events.find(event => event.type === 'compaction/prune');
      const { quote } = events[record.data.attempt].data;
      // Every event of the range is a text-only message here, so its characters are the text blocks' lengths.
      const chars = record.data.range.reduce((sum, seq) => {
        const content = events[seq].data.message?.content ?? events[seq].data.content;
        assert.ok(content.every(block => block.type === 'text'), `${model}: seq ${seq} holds text alone`);
        return sum + content.reduce((total, block) => total + block.text.length, 0);
      }, 0);
      sealed[model] = { quote, prune: prune.data, chars, ascii: modelPolicyFor(model).ctp.ascii };
    }
    const [calibrated, plain] = [sealed['deepseek-quote'], sealed['loop-model']];
    assert.notEqual(calibrated.ascii, plain.ascii, 'fixture: the policy calibrates one of the two models');
    assert.equal(calibrated.chars, plain.chars, 'fixture: both sessions seal the same text');
    for (const { quote, chars, ascii } of Object.values(sealed)) {
      assert.equal(quote.trigger, 'quote');
      assert.ok(Math.abs(quote.lA - chars / ascii) < 1e-9 * quote.lA, `L_A ${quote.lA} is ${chars} characters at ${ascii} per token`);
    }
    assert.notEqual(calibrated.quote.lA, plain.quote.lA, 'the epoch model\'s policy, not a shared default, prices the range');
    assert.equal(calibrated.prune.shadowedTokenCount, plain.prune.shadowedTokenCount, 'the committed count is the meter\'s heuristic, whatever the model');
    assert.ok(Number.isInteger(calibrated.prune.shadowedTokenCount) && calibrated.prune.shadowedTokenCount !== Math.round(calibrated.quote.lA));
    console.log(JSON.stringify({ calibrated, plain }));
    await rig.ctx.fiber.dispose();
  },

  // The questions a step asked the user, through the shipped host: a step the real loop ran with an `ask_user_question` call, answered by a stand-in for the question tool that returns a scripted answer as the tool renders its value, is sealed with each question's original text and the user's own answer beside the step's note, the options, their descriptions and the detail left out, and the step's own request after the seal reaches the model with them.
  async 'loop-asks'() {
    const { rig, finish } = await askingSession(true);
    const QUESTIONS = askedQuestions();
    const logged = await finish();
    const [{ arguments: args }] = logged.call.content.filter(block => block.type === 'tool-call');
    assert.equal(args, JSON.stringify(QUESTIONS), 'the arguments are the raw text the model wrote');
    assert.equal(logged.answer.isError, false, 'the stand-in answered');
    const slots = logged.carrier.data.source.slots.filter(slot => slot.questions !== undefined);
    assert.equal(slots.length, 1, 'the one asking step has the field');
    assert.ok(slots[0].seqs.includes(logged.callSeq), 'the questions stand in the slot of the step that asked');
    assert.deepEqual(slots[0].questions, [
      { question: QUESTIONS.questions[0].question, user: `Ship now\nSplit\n${CUSTOM_ANSWER}` },
      { question: 'Who owns the rollout?', user: 'Platform' },
    ]);
    // Whatever the bundled renderer's wording, the body stored and the body the model's request carries hold each question whole in order inside the reminder and each answer whole in order after its closing tag, and none of the model's explanation.
    for (const [where, body] of [['the stored carrier', textsIn(logged.carrier.data)], ['the request\'s carrier', textsIn(logged.message)]]) {
      const places = [QUESTIONS.questions[0].question, 'Who owns the rollout?', '</system-reminder>', `Ship now\nSplit\n${CUSTOM_ANSWER}`, 'Platform'].map(part => body.indexOf(part));
      assert.ok(places.every((at, index) => at >= 0 && (index === 0 || at > places[index - 1])), `${where} holds each question whole in the reminder and the user's answer whole after it, in order`);
      for (const explanation of EXPLANATIONS) assert.ok(!body.includes(explanation), `${where} leaves out the model's explanation: ${explanation}`);
      assert.ok(!body.includes('Product'), `${where} leaves out the option the user did not select`);
    }
    assert.equal(textsIn(logged.message), textsIn(logged.carrier.data), 'the main request after the seal carries the body the source renders');
    console.log(JSON.stringify({ questions: slots[0].questions.map(({ question, user }) => ({ questionChars: question.length, userChars: user.length })) }));
    await rig.ctx.fiber.dispose();
  },

  // The same asking step with no question tool in the rig: the real tool runtime logs its own error result, and the seal adds nothing for it, neither a question and answer nor the raw call and result in their place, and commits.
  async 'loop-asks-error'() {
    const { rig, finish } = await askingSession(false);
    const QUESTIONS = askedQuestions();
    const logged = await finish();
    assert.equal(logged.answer.isError, true, 'the real tool runtime refused the call');
    const { slots } = logged.carrier.data.source;
    assert.ok(slots.every(slot => slot.questions === undefined), 'no slot has a supplement');
    for (const body of [textsIn(logged.carrier.data), textsIn(logged.message)]) {
      assert.ok(!body.includes(JSON.stringify(QUESTIONS)) && !body.includes(textsIn(logged.answer)), 'no raw call or result stands in the body');
    }
    await rig.ctx.fiber.dispose();
  },

  // The state block through the shipped host, the real `todos` unit and the real working directory service: of the tools the items stand for only `todo_write` and `working_directory` are mounted, so those two items are the ones the carrier shows. The directory is the service's own, shown whole by the first seal and as unchanged by the later ones. A list written in the turn the seal falls in is read from the host's projection registry and shown in full, the next seal, at a later turn's start, reads the reset the official fold makes there and shows the empty list, and the seal after it shows the directory as unchanged and the list as empty again.
  async 'loop-state'() {
    const rig = await mountShippedLoop({ todo: true, directoryTool: true, padding: REPLY_PADDING, reply, summary });
    const { ctx, call, adapter, harness, llm } = rig;
    const selection = { provider: 'mock', model: 'loop-model' };
    const agent = await harness.create(`state-${Date.now().toString(16)}`, selection, { cwd: process.env.TMPDIR });
    const { session } = agent;
    assert.deepEqual(await call('inner-mode/select', { sessionId: session.id, enabled: true }), { ok: true, value: {} });
    const LIST = [{ content: 'Write the tests', status: 'completed' }, { content: 'Ship it\nand check the bundle', status: 'in_progress' }];
    const turn = async (text) => {
      const at0 = session.seq;
      const requestsAt = adapter.requests.length;
      await turnOf(agent, llm, text);
      return { appended: session.snapshotEvents().slice(at0), requests: adapter.requests.slice(requestsAt).filter(request => request.sessionId === session.id) };
    };
    // The counted steps of the unsealed range: the model steps with content behind the last carrier.
    const openSteps = () => {
      const events = session.snapshotEvents();
      return events.slice(events.findLastIndex(isCarrierEvent) + 1).filter(event => event.type === 'assistant/message' && event.data.message.content.length > 0).length;
    };
    const sealedIn = done => done.appended.some(event => event.type === INNER_CALL_RECORD_TYPE);
    const W = STATE_WORDING;
    const labelOf = key => CARRIER_TABLE.stateItems.find(item => item.key === key).label;
    const directoryLine = tail => `${labelOf('workingDirectory')} ${tail}`;
    const todoLine = tail => `${labelOf('todos')} ${tail}`;
    const blockOf = (asOfSeq, directoryTail, todoTail) => `${W.heading(asOfSeq)}\n${directoryLine(directoryTail)}\n${todoLine(todoTail)}`;
    const DIRECTORY = ctx.workingDirectory.get(session);
    const carriersText = request => requestCarriers(request).map(textsIn).join('\n');
    const evidence = {};

    // The first seal: plain steps up to one short of SEAL_STEPS, then the turn that writes the list, whose first step is the SEAL_STEPSth and whose second step's pre-step seals with the list standing.
    for (let turns = 1; openSteps() < SEAL_STEPS - 1; turns += 1) assert.equal(sealedIn(await turn(`plain ${turns}`)), false, 'no seal below the minimum');
    const writing = await turn(directive('todo_write', { todos: LIST }));
    assert.equal(sealedIn(writing), true, 'the writing turn sealed');
    const record = writing.appended.find(event => event.type === INNER_CALL_RECORD_TYPE);
    const carrier = writing.appended.find(isCarrierEvent);
    const { state } = carrier.data.source;
    assert.deepEqual(state, { asOfSeq: record.seq - 1, items: { workingDirectory: { value: DIRECTORY }, todos: { value: LIST } } }, 'the directory the service holds and the list the official unit held at the commit, cut at the event before the call record, and no item of a tool that is not listed');
    assert.deepEqual(ctx.sessionProjections.snapshot(session, ['todos']).values, { todos: LIST }, 'the registry\'s own snapshot holds that list');
    const shown = blockOf(state.asOfSeq, DIRECTORY, JSON.stringify(LIST));
    assert.equal(unframed(carrier.data.content).at(-1).text, `\n\n${shown}`, 'the block closes the body');
    assert.ok(carriersText(writing.requests.at(-1)).includes(shown), 'the next main request carries it');
    const attempt = session.snapshotEvents()[record.data.attempt];
    assert.equal(Object.hasOwn(attempt.data.quote, 'todoEst'), false, 'the quote prices no state block');
    evidence.first = { asOfSeq: state.asOfSeq };

    // The second seal falls at a later turn's start: its turn/start reset the official unit to null, and the empty list after the list is shown as empty.
    let second;
    for (let turns = 1; second === undefined && turns <= SEAL_WAIT_TURNS; turns += 1) {
      const done = await turn(`after ${turns}`);
      if (sealedIn(done)) second = done;
    }
    assert.ok(second !== undefined, 'a second seal');
    const secondCarrier = second.appended.find(isCarrierEvent);
    const secondRecord = second.appended.find(event => event.type === INNER_CALL_RECORD_TYPE);
    assert.ok(second.appended.findIndex(event => event.type === 'turn/start') < second.appended.indexOf(secondRecord), 'the turn started before the seal read the state');
    assert.deepEqual(secondCarrier.data.source.state, { asOfSeq: secondRecord.seq - 1, items: { workingDirectory: { value: DIRECTORY, unchanged: true }, todos: { value: [] } } }, 'the reset is a state of its own: the empty list, beside the directory as unchanged');
    const secondBlock = blockOf(secondCarrier.data.source.state.asOfSeq, W.unchanged, W.empty);
    assert.equal(unframed(secondCarrier.data.content).at(-1).text, `\n\n${secondBlock}`);
    assert.ok(carriersText(second.requests.at(-1)).includes(secondBlock));
    assert.ok(carriersText(second.requests.at(-1)).includes(shown), 'the first carrier still stands on the request');

    // The third seal: the unit is still empty and the nearest carrier that showed it shows it empty, so the block says it is empty, not unchanged, beside the directory as unchanged.
    let third;
    for (let turns = 1; third === undefined && turns <= SEAL_WAIT_TURNS; turns += 1) {
      const done = await turn(`later ${turns}`);
      if (sealedIn(done)) third = done;
    }
    assert.ok(third !== undefined, 'a third seal');
    const thirdCarrier = third.appended.find(isCarrierEvent);
    const thirdRecord = third.appended.find(event => event.type === INNER_CALL_RECORD_TYPE);
    assert.deepEqual(thirdCarrier.data.source.state, { asOfSeq: thirdRecord.seq - 1, items: { workingDirectory: { value: DIRECTORY, unchanged: true }, todos: { value: [] } } }, 'the directory is shown as unchanged, the empty list as empty');
    assert.equal(unframed(thirdCarrier.data.content).at(-1).text, `\n\n${blockOf(thirdCarrier.data.source.state.asOfSeq, W.unchanged, W.empty)}`);
    assert.deepEqual(stderrLines.filter(line => line.includes('inner_')), [], 'no inner diagnostic');
    console.log(JSON.stringify(evidence));
    await ctx.fiber.dispose();
  },
};

const pick = status => ({
  segment: status.segment, reliable: status.rateLamp.reliable, rentMeter: status.rateLamp.rentMeter, billCycleCount: status.rateLamp.billCycleCount, apiCalls: status.apiCalls,
});

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
