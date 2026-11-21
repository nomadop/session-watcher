// The `sw_event_read` tool through `applyHost` registration and execution: the event text it answers verbatim, the authorization of a cross-session read, the window of neighbors, and what a failed or cancelled read says.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHost } from '../dsh/src/host.js';
import { createEventReadTool } from '../dsh/src/event-read.js';
import { closeStoreGlobal } from '../lib/store.js';
import { EVENT_READ_GUIDANCE } from '../lib/harness/dsh/event-read.js';
import { _resetRateLampManagerForTest } from '../lib/rate-lamp-manager.js';
import {
  assistantMessage, attempt, compactCheckpoint, innerSealCarrier, loadPayload, loadReads, requestHeader, sessionLog, stepStart, toolCall, toolResult, turnEnd, turnStart, userMessage,
} from './helpers/dsh-events.js';
import { createFakeContext, fakeSessionLogs } from './helpers/dsh-fake-context.js';

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const TOOL = 'sw_event_read';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sw-dsh-event-read-'));
  _resetRateLampManagerForTest();
});

afterEach(() => {
  _resetRateLampManagerForTest();
  closeStoreGlobal();
  rmSync(dir, { recursive: true, force: true });
});

// The text of the events the tool lists as neighbors: the text blocks of a message, nothing for any other event.
const extractSessionEventText = event => (event.data?.content ?? event.data?.message?.content ?? [])
  .filter(block => block.type === 'text').map(block => block.text).join('\n');

// The error class the host is handed, with the constructor of the real one.
class HarnessError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const headerOf = (id, cwd = '/repo') => ({ id, cwd });

// The host over a fake context whose session query serves `logs`; `caller` lives in `/repo`. The tool the context registered is answered by name.
function mountHost({ logs, titles, rejectTitle, sessionReads, systemPrompt } = {}) {
  const ctx = createFakeContext({ sessions: [], systemPrompt, sessionReads: sessionReads ?? fakeSessionLogs(logs, { titles, rejectTitle }) });
  const registered = [];
  ctx.tools.register = (definition) => { registered.push(definition); };
  applyHost(ctx, {
    defineTool: definition => definition, storePath: join(dir, 'store.sqlite'), turnNotesRoot: join(dir, 'turn-notes'), loadIsIgnored: () => null,
    skillsDir: SKILLS_DIR, queryKit: { extractSessionEventText, HarnessError },
  });
  return { ctx, tool: registered.find(definition => definition.name === TOOL) };
}

const callerOf = (id, cwd) => ({ id, header: { cwd } });
// An explicit `cwd: undefined` is a caller without a directory.
const read = (tool, args, { id = 's-caller', signal = new AbortController().signal, ...caller } = {}) => tool.execute(args, { agent: { session: callerOf(id, Object.hasOwn(caller, 'cwd') ? caller.cwd : '/repo') }, signal });
const jsonOf = text => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);

// A `todo/write` in the log shape, which the dsh-events builders lack.
const todoWrite = () => ({ type: 'todo/write', seq: 0, time: 0, data: { todos: [{ status: 'pending', content: 'write it' }] } });

// The log of one session: a request header, a user message with significant whitespace, an assistant message with a duplicated stream, two reasoning blocks (one around significant whitespace and replay data), usage and a call with raw arguments, the call, its result with private meta, and an attempt.
const RAW_ARGUMENTS = '{ "file_path" :  "/a.txt",\n  "meta": {"x":1} }';
const SPACED = '  keep\tthis\n    spacing  \n';
const THOUGHT = 'secret thoughts';
const MID_THOUGHT = '  second\tthought\n  ';
const RESULT_TEXT = '{"meta": {"stream": [1]}, "source": {"kind": "x"}}  ';
function rich() {
  const assistant = assistantMessage({ text: 'I will read.\n', toolCalls: [{ id: 'call-1', name: 'read', arguments: RAW_ARGUMENTS }], usage: { inputTokens: 3 } });
  const content = assistant.data.message.content;
  content.unshift({ type: 'reasoning', text: THOUGHT });
  content.splice(2, 0, { type: 'reasoning', text: MID_THOUGHT, signature: 'replay-signature', replay: { opaque: 'replay-state' } });
  assistant.data.message.source.replay = { opaque: 'source-replay-state' };
  assistant.data.stream = [{ type: 'chunk', time: 1, chunk: { type: 'text', text: 'I will read.\n' } }];
  const result = toolResult({ callId: 'call-1', text: RESULT_TEXT, isError: true, error: { name: 'Boom', code: 'E_BOOM', message: 'detail' }, meta: { private: 'tool-private' } });
  const cut = assistantMessage({ text: 'The first half of', interrupted: true, usage: { inputTokens: 3 } });
  cut.data.stream = [{ type: 'chunk', time: 1, chunk: { type: 'text', text: 'The first half of' } }];
  return sessionLog([requestHeader(), turnStart(), userMessage({ text: SPACED }), stepStart(), assistant, toolCall({ callId: 'call-1', name: 'read', arguments: RAW_ARGUMENTS }), result, attempt({ finish: 'stop' }), cut,
    todoWrite(), turnEnd({ reason: { kind: 'error', error: { message: 'provider said /Users/x/diagnostic', code: 'E_PROVIDER' } } })]);
}

const RICH = rich();
const LOGS = {
  's-caller': { header: headerOf('s-caller'), events: RICH },
  's-peer': { header: headerOf('s-peer'), events: RICH },
  's-other': { header: headerOf('s-other', '/elsewhere'), events: RICH },
};

test('sw_event_read is registered parallel-safe, with a required integer seq and the optional target and window', () => {
  const { ctx, tool } = mountHost({ logs: LOGS });
  const kinds = Object.fromEntries(Object.entries(tool.parameters).map(([name, { type, required }]) => [name, [type, required === true]]));
  assert.deepEqual(kinds, { session_id: ['string', false], seq: ['integer', true], before: ['integer', false], after: ['integer', false] });
  assert.equal(tool.isConcurrencySafe({ seq: 0 }), true);
  ctx.dispose();
});

test('the guidance section sits at the session query order and shows only to a step whose tool set holds sw_event_read', async () => {
  const sections = [];
  const systemPrompt = { section: (section) => { sections.push(section); return () => {}; }, getSectionOrder: name => ({ TOOL_SESSION_QUERY: 2300 })[name] };
  const { ctx } = mountHost({ logs: LOGS, systemPrompt });
  await Promise.resolve();
  assert.equal(sections.length, 1);
  const [{ name, order, text }] = sections;
  assert.deepEqual([name, order], [`tool:${TOOL}`, 2300]);
  const seen = [];
  ctx.tools.get = (tool, scope, toolSet) => { seen.push([tool, scope, toolSet]); return toolSet.has(tool) ? {} : undefined; };
  assert.equal(text({ scope: 'agent-a', toolSet: new Set([TOOL]) }), EVENT_READ_GUIDANCE);
  assert.equal(text({ scope: 'agent-b', toolSet: new Set() }), '');
  assert.deepEqual(seen.map(([tool, scope]) => [tool, scope]), [[TOOL, 'agent-a'], [TOOL, 'agent-b']]);
  ctx.dispose();
});

test('a read answers the verbatim text of known fields and leaves out the stream, the replay data, the usage and the private meta', async () => {
  const { ctx, tool } = mountHost({ logs: LOGS, titles: { 's-caller': 'The title' } });
  const user = await read(tool, { seq: 2 });
  assert.equal(typeof user, 'string');
  assert.deepEqual(user.split('\n').slice(0, 3), ['Session s-caller — The title', 'Target event seq 2:', '```json']);
  assert.deepEqual(jsonOf(user), { type: 'user/message', seq: 2, time: RICH[2].time, data: { content: [{ type: 'text', text: SPACED }], source: { kind: 'user' } } });

  const assistant = jsonOf(await read(tool, { seq: 4 }));
  assert.deepEqual(assistant, {
    type: 'assistant/message', seq: 4, time: RICH[4].time,
    data: {
      message: {
        content: [
          { type: 'reasoning', text: THOUGHT },
          { type: 'text', text: 'I will read.\n' },
          { type: 'reasoning', text: MID_THOUGHT },
          { type: 'tool-call', id: 'call-1', name: 'read', arguments: RAW_ARGUMENTS },
        ],
      },
    },
  });
  assert.deepEqual(jsonOf(await read(tool, { seq: 5 })).data, { callId: 'call-1', name: 'read', arguments: RAW_ARGUMENTS });

  const result = jsonOf(await read(tool, { seq: 6 }));
  assert.deepEqual(result.data, { message: { toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: RESULT_TEXT }] }, error: { name: 'Boom', code: 'E_BOOM' } });
  ctx.dispose();
});

test('reasoning stays out of the neighbor summaries of a window while the normal text remains', async () => {
  const { ctx, tool } = mountHost({ logs: LOGS });
  const text = await read(tool, { seq: 3, after: 1 });
  assert.match(text, /- seq 4 \| assistant\/message \| \S+\n {2}I will read\./);
  assert.ok(!text.split('\nAfter:')[1].includes('thought'), 'the neighbor summary carries no reasoning text');
  ctx.dispose();
});

test('an assistant message a cancellation cut short keeps the interrupted mark and nothing of its stream or usage', async () => {
  const { ctx, tool } = mountHost({ logs: LOGS });
  assert.deepEqual(jsonOf(await read(tool, { seq: 8 })), {
    type: 'assistant/message', seq: 8, time: RICH[8].time, data: { message: { content: [{ type: 'text', text: 'The first half of' }] }, interrupted: true },
  });
  ctx.dispose();
});

test('an event of a type the read-back does not serve, todo and turn ends included, answers its identity alone', async () => {
  const { ctx, tool } = mountHost({ logs: LOGS });
  for (const seq of [0, 7, 9, 10]) {
    const event = jsonOf(await read(tool, { seq }));
    assert.deepEqual(event, { type: RICH[seq].type, seq, time: RICH[seq].time });
  }
  ctx.dispose();
});

test('a session untitled or whose title read fails reads as untitled and the failure stays out of the answer', async () => {
  const { ctx, tool } = mountHost({ logs: LOGS, rejectTitle: { 's-peer': new Error('title store at /secret/path failed') } });
  assert.equal((await read(tool, { seq: 2 })).split('\n')[0], 'Session s-caller — untitled');
  const peer = await read(tool, { session_id: 's-peer', seq: 2 });
  assert.equal(peer.split('\n')[0], 'Session s-peer — untitled');
  assert.ok(!peer.includes('/secret/path'));
  ctx.dispose();
});

test('before and after count raw events, structural ones included, and list each neighbor in seq order under its own heading', async () => {
  const { ctx, tool } = mountHost({ logs: LOGS });
  const text = await read(tool, { seq: 2, before: 2, after: 2 });
  const headings = text.split('\n').filter(line => /^(Before|After):$|^- seq /.test(line));
  assert.deepEqual(headings.map(line => line.replace(/ \| \d{4}-.*$/, '')), ['Before:', '- seq 0 | request/header', '- seq 1 | turn/start', 'After:', '- seq 3 | step/start', '- seq 4 | assistant/message']);
  assert.match(text, /- seq 0 \| request\/header \| \S+ \| \(no semantic text\)/);
  assert.match(text, /- seq 4 \| assistant\/message \| \S+\n {2}I will read\./);

  const alone = await read(tool, { seq: 2 });
  assert.ok(!/^(Before|After):$/m.test(alone), 'no window, no neighbors');
  const edge = await read(tool, { seq: 0, before: 5 });
  assert.ok(!/^Before:$/m.test(edge), 'a window before the first event adds none');
  ctx.dispose();
});

test('a session of the caller\'s directory reads, another directory or a caller without one is refused before any event is read', async () => {
  const reads = fakeSessionLogs(LOGS);
  const calls = [];
  const { ctx, tool } = mountHost({ sessionReads: { ...reads, async readEvent(...args) { calls.push(args[0].sessionId); return reads.readEvent(...args); } } });
  assert.match(await read(tool, { session_id: 's-peer', seq: 2 }), /^Session s-peer — /);
  await assert.rejects(read(tool, { session_id: 's-other', seq: 2 }), { code: 'SESSION_QUERY_TOOL_UNAUTHORIZED' });
  await assert.rejects(read(tool, { session_id: 's-peer', seq: 2 }, { cwd: undefined }), { code: 'SESSION_QUERY_TOOL_UNAUTHORIZED' });
  await assert.rejects(read(tool, { session_id: 's-absent', seq: 2 }), { code: 'SESSION_QUERY_TOOL_UNAUTHORIZED' });
  assert.deepEqual(calls, ['s-peer'], 'only the authorized read reached the service');
  ctx.dispose();
});

test('the header the read observed is checked against the caller and the requested id', async () => {
  const reads = fakeSessionLogs(LOGS);
  const headerFor = observed => ({ ...reads, async readEvent(...args) { return { ...await reads.readEvent(...args), session: observed }; } });
  for (const [why, observed, args] of [
    ['another id', headerOf('s-swapped'), { session_id: 's-peer', seq: 2 }],
    ['another directory', headerOf('s-peer', '/elsewhere'), { session_id: 's-peer', seq: 2 }],
    ['the caller\'s own session in another directory', headerOf('s-caller', '/elsewhere'), { seq: 2 }],
  ]) {
    const { ctx, tool } = mountHost({ sessionReads: headerFor(observed) });
    await assert.rejects(read(tool, args), { code: 'SESSION_QUERY_TOOL_UNAUTHORIZED' }, why);
    ctx.dispose();
  }
  const titleHeader = { ...reads, async readTitleSnapshots(...args) { return (await reads.readTitleSnapshots(...args)).map(result => ({ ...result, value: { ...result.value, session: headerOf('s-peer', '/elsewhere') } })); } };
  const { ctx, tool } = mountHost({ sessionReads: titleHeader });
  await assert.rejects(read(tool, { session_id: 's-peer', seq: 2 }), { code: 'SESSION_QUERY_TOOL_UNAUTHORIZED' }, 'the title observation\'s header too');
  ctx.dispose();
});

test('a failing service answers a fixed message by its code, the diagnostic going to stderr alone', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const reads = fakeSessionLogs(LOGS);
  const failing = error => ({ ...reads, async readEvent() { throw error; } });
  const diagnostic = 'ENOENT /Users/someone/.dsh/sessions/s-caller.jsonl: line 3 corrupt';
  for (const [error, code, message] of [
    [Object.assign(new Error(diagnostic), { code: 'SESSION_QUERY_EVENT_NOT_FOUND' }), 'SESSION_QUERY_EVENT_NOT_FOUND', 'session event was not found'],
    [Object.assign(new Error(diagnostic), { code: 'SESSION_QUERY_INVALID_WINDOW' }), 'SESSION_QUERY_INVALID_WINDOW', 'session event window is invalid'],
    [Object.assign(new Error(diagnostic), { code: 'SESSION_QUERY_PERSISTENCE_FAILED' }), 'SESSION_QUERY_TOOL_FAILED', 'session query operation failed'],
    [new Error(diagnostic), 'SESSION_QUERY_TOOL_FAILED', 'session query operation failed'],
  ]) {
    const { ctx, tool } = mountHost({ sessionReads: failing(error) });
    await assert.rejects(read(tool, { seq: 2 }), (thrown) => {
      assert.equal(thrown.message, message);
      assert.equal(thrown.code, code);
      assert.ok(thrown instanceof HarnessError);
      assert.equal(thrown.cause, undefined);
      return true;
    });
    ctx.dispose();
  }
  assert.equal(lines.length, 4);
  assert.ok(lines.every(line => line.includes(diagnostic)), 'each failure is one stderr line');
});

test('an aborted signal ends the read with the abort, whichever step it lands in, and a window that is no non-negative integer is refused', async () => {
  const reads = fakeSessionLogs(LOGS);
  const controller = new AbortController();
  const { ctx, tool } = mountHost({ sessionReads: { ...reads, async readEvent(...args) { controller.abort(); throw new Error('read failed: /Users/x/log'); } } });
  await assert.rejects(read(tool, { seq: 2 }, { signal: controller.signal }), error => error === controller.signal.reason);
  const already = new AbortController();
  already.abort();
  const second = mountHost({ logs: LOGS });
  await assert.rejects(read(second.tool, { seq: 2 }, { signal: already.signal }), error => error === already.signal.reason);
  for (const args of [{ seq: -1 }, { seq: 1.5 }, { seq: 2, before: -1 }, { seq: 2, after: 0.5 }]) {
    await assert.rejects(read(second.tool, args), /non-negative/);
  }
  ctx.dispose();
  second.ctx.dispose();
});

test('a read needs no watcher: a caller the table never observed reads its own session', async () => {
  const { ctx, tool } = mountHost({ logs: { 's-unwatched': { header: headerOf('s-unwatched'), events: RICH } } });
  assert.match(await read(tool, { seq: 2 }, { id: 's-unwatched' }), /^Session s-unwatched — untitled\n/);
  ctx.dispose();
});

// A window over the three bodies this host keeps out of a neighbor line: a handoff payload with its file excerpts, an inner-seal carrier and a compaction checkpoint, each beside ordinary messages.
const CARRIER_BODIES = ['payload-body', 'excerpt-body', 'seal-body', 'checkpoint-body'];
function carrierLog() {
  const events = sessionLog([
    userMessage({ text: 'ordinary before' }),
    loadPayload({ text: 'payload-body' }),
    loadReads({ files: [{ path: '/repo/a.js', ranges: [{ offset: 1, limit: 1 }], text: 'excerpt-body', totalLines: 1, windows: [{ offset: 1, lines: [{ number: 1, text: 'a' }] }] }] }),
    innerSealCarrier({ sourceEventSeqs: [0], text: 'seal-body' }),
    compactCheckpoint({ text: 'checkpoint-body' }),
    userMessage({ text: 'ordinary after' }),
  ]);
  return { 's-caller': { header: headerOf('s-caller'), events } };
}

test('a neighbor that carries a handoff, its file excerpts, a seal or a checkpoint is its identity alone, and the window is the raw one', async () => {
  const { ctx, tool } = mountHost({ logs: carrierLog() });
  const text = await read(tool, { seq: 0, after: 5 });
  const lines = text.split('\n').filter(line => line.startsWith('- seq '));
  assert.deepEqual(lines.map(line => line.replace(/ \| \d{4}-\S+/, '')), [
    '- seq 1 | user/message', '- seq 2 | user/message', '- seq 3 | user/message', '- seq 4 | user/message', '- seq 5 | user/message',
  ]);
  for (const body of CARRIER_BODIES) assert.ok(!text.includes(body), `${body} stays out of a neighbor`);
  assert.ok(text.includes('ordinary after'), 'an ordinary neighbor keeps its text');
  assert.ok(!/\(no semantic text\)/.test(lines.slice(0, 4).join('\n')), 'a hidden neighbor is no empty-text neighbor');

  const before = await read(tool, { seq: 5, before: 2 });
  assert.deepEqual(before.split('\n').filter(line => line.startsWith('- seq ')).map(line => /^- seq (\d+)/.exec(line)[1]), ['3', '4'], 'no event outside the window is added');
  ctx.dispose();
});

test('a carrier read as the target keeps its verbatim body', async () => {
  const { ctx, tool } = mountHost({ logs: carrierLog() });
  const bodies = [];
  for (const seq of [1, 2, 3, 4]) bodies.push(jsonOf(await read(tool, { seq })).data.content.map(block => block.text).join(''));
  assert.ok(bodies[0].includes('payload-body') && bodies[1].includes('excerpt-body') && bodies[2] === 'seal-body' && bodies[3] === 'checkpoint-body', JSON.stringify(bodies));
  ctx.dispose();
});

test('an event of the caller\'s own session held in its context is refused, with or without a window, before any read', async () => {
  const reads = fakeSessionLogs(LOGS);
  const calls = [];
  const asked = [];
  const ctx = { sessionQuery: { ...reads, async readEvent(...args) { calls.push(args[0]); return reads.readEvent(...args); } } };
  const tool = createEventReadTool({
    defineTool: definition => definition, ctx, extractSessionEventText, HarnessError,
    heldInContext: (sessionId, seq) => { asked.push([sessionId, seq]); return seq === 2; },
  });
  for (const args of [{ seq: 2 }, { seq: 2, before: 1, after: 1 }, { session_id: 's-caller', seq: 2 }]) {
    await assert.rejects(read(tool, args), { code: 'SW_EVENT_CARRIED', message: 'Event seq 2 is already in your context word for word; reading it gives the same text. Use it.' }, JSON.stringify(args));
  }
  assert.deepEqual(calls, [], 'a refused read reaches no service');
  assert.match(await read(tool, { seq: 4 }), /^Session s-caller — /, 'an event not held reads');
  assert.match(await read(tool, { session_id: 's-peer', seq: 2 }), /^Session s-peer — /, 'another session is never held');
  assert.deepEqual(asked, [['s-caller', 2], ['s-caller', 2], ['s-caller', 2], ['s-caller', 4]]);
});

test('a held check that throws reads the event as not held, its failure one stderr line', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', line => lines.push(line));
  const tool = createEventReadTool({
    defineTool: definition => definition, ctx: { sessionQuery: fakeSessionLogs(LOGS) }, extractSessionEventText, HarnessError,
    heldInContext: () => { throw new Error('monitor state unreadable'); },
  });
  assert.match(await read(tool, { seq: 2 }), /^Session s-caller — /);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('monitor state unreadable'));
});
