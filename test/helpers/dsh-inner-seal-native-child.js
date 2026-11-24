// test/helpers/dsh-inner-seal-native-child.js — the inner seal of the shipped host entry over the real DSH loop (`dsh-shipped-loop.js`) with the checkout's `llm-pi-ai` adapter, run in a fresh Node process by `test/dsh.inner-seal.integration.test.js`.
// The adapter's endpoints are loopback `node:http` fixtures of this process that record each request body: the Responses one answers a minimal successful stream, the Bedrock one an HTTP error. The process starts with `HOME`, `DSH_HOME` and `TMPDIR` inside the fixture the parent made, and the Bedrock switches the parent passes; credentials are placeholders. A scenario that fails an assertion exits non-zero with it on stderr; what it writes to stdout is the evidence the case reports.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

import { composeWatcher, nodeWorkingTree } from '../../dsh/src/composition.js';
import { INNER_QUOTE } from '../../lib/inner-seal/quote.js';
import { ATTRIBUTION_LIMITS } from '../../lib/constants.js';
import { CARRIER_WORDING } from '../../lib/inner-seal/carrier.js';
import { carriedNote, foldCarried } from '../../lib/carried-evidence.js';
import { CARRIER_TABLE } from '../../lib/harness/dsh/carrier-table.js';
import { EVENT_READ_TOOL } from '../../lib/harness/dsh/event-read.js';
import { closeStore, openStore } from '../../lib/store.js';
import { readTreeWindows, renderFileEvidence } from '../../lib/working-tree-text.js';
import { CARRIER_KIND, INNER_ATTEMPT_RECORD_TYPE, INNER_CALL_RECORD_TYPE, mountShippedLoop, REPLY_PADDING, SEAL_STEPS, SEAL_WAIT_TURNS } from './dsh-shipped-loop.js';

const [scenario] = process.argv.slice(2);
const ROOT = realpathSync(process.env.TMPDIR);

// The lines the host writes to stderr from here on; its diagnostics arrive as `console.error` lines.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => { stderrLines.push(args.map(String).join(' ')); realConsoleError(...args); };

const lines = (label, count) => Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`);
const textOf = rows => `${rows.join('\n')}\n`;
// A user text the fixture endpoint answers with a tool call, or with one step of several, `inOneStep(...)`.
const directive = (name, args) => `tool:${name} ${JSON.stringify(args)}`;
const inOneStep = (...calls) => `tools:${JSON.stringify(calls.map(([name, args]) => ({ name, args })))}`;
const textsIn = message => (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
// The quote of the attempt that a seal's call record names: the seal is the quote's permission, not a step count's, so its savings stand over the C estimate and the fee and its arm is the one the decision names.
function assertQuoted(session, record) {
  const attempt = session.snapshotEvents()[record.data.attempt];
  assert.equal(attempt.type, INNER_ATTEMPT_RECORD_TYPE, 'the call record names the attempt record');
  const { quote } = attempt.data;
  assert.ok(quote.trigger === 'quote' && quote.sEst > 0 && (quote.arm === 'right' || quote.q < quote.kappa) && quote.n >= INNER_QUOTE.minSteps, `the quote permits the seal: ${JSON.stringify(quote)}`);
}

const isCarrierEvent = event => event?.type === 'user/message' && event.data?.source?.kind === CARRIER_KIND;

// A valid opaque 8-bit RGB PNG of `width` x `height`: attachment normalization re-encodes a wide one as JPEG.
function makePng(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) rows.push((x * 50) & 255, (y * 80) & 255, ((x + y) * 30) & 255);
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── The fixture endpoints ───────────────────────────────────────────────────
// The usage every Responses answer reports: OpenAI counts cached and cache-written input inside `input_tokens`.
const RESPONSES_USAGE = { input_tokens: 1_000, output_tokens: 10, total_tokens: 1_010, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 50 } };

// A text answer; with `padding`, the padding follows the text in the same block, as the answer of a model that wrote more.
function textEvents(n, text, padding = '') {
  const id = `msg_${n}`;
  const full = `${text}${padding}`;
  return [
    { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: id, delta: full },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] } },
    { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: [], usage: RESPONSES_USAGE } },
  ];
}

// A response the output ceiling cut inside a tool call: the loop drops the cut call and settles an assistant message with no block, and a completed response with no output at all is an error of the adapter instead.
function cutEvents(n) {
  const item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'read' };
  return [
    { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: `fc_${n}`, delta: '{"file_pa' },
    { type: 'response.incomplete', response: { id: `resp_${n}`, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [], usage: RESPONSES_USAGE } },
  ];
}

// A response calling each of `calls` (`{ name, args }`, `args` the JSON text) in one step; with `padding`, a message of that text comes first and the calls follow it, their ids and arguments as they are.
function toolEvents(n, calls, padding) {
  const lead = padding === undefined ? 0 : 1;
  const id = `msg_${n}`;
  const message = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: id, delta: padding },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: padding, annotations: [] }] } },
  ];
  const items = calls.map(({ name, args }, index) => ({ item: { type: 'function_call', id: `fc_${n}_${index + 1}`, call_id: `call_${n}_${index + 1}`, name }, args }));
  return [
    { type: 'response.created', response: { id: `resp_${n}`, status: 'in_progress', output: [] } },
    ...(lead === 1 ? message : []),
    ...items.flatMap(({ item, args }, position) => {
      const index = position + lead;
      return [
        { type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: args },
        { type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: args },
        { type: 'response.output_item.done', output_index: index, item: { ...item, arguments: args, status: 'completed' } },
      ];
    }),
    { type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', output: [], usage: RESPONSES_USAGE } },
  ];
}

const partText = part => part.text ?? (typeof part.output === 'string' ? part.output : undefined);
// A Responses input item's content parts; a plain string is one text part.
const partsOf = item => (Array.isArray(item.content) ? item.content : typeof item.content === 'string' ? [{ text: item.content }] : []);

// The text parts of a recorded body in request order, whichever protocol serialized it: each `{ index, role, text }`, `index` the message's position.
function bodyTexts(route, body) {
  if (route === 'responses') {
    return body.input.flatMap((item, index) => (item.type === 'function_call_output'
      ? [{ index, role: 'tool', text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) }]
      : partsOf(item).map(partText).filter(text => text !== undefined).map(text => ({ index, role: item.role ?? item.type, text }))));
  }
  return body.messages.flatMap((message, index) => message.content.flatMap(block => (block.text !== undefined ? [block.text]
    : (block.toolResult?.content ?? []).map(part => part.text).filter(text => text !== undefined))).map(text => ({ index, role: message.role, text })));
}

// What a main request asks of the model: the calls of the last directive among the trailing user-side messages, unless a tool result answered it.
function askedOf(input) {
  for (let at = input.length - 1; at >= 0; at -= 1) {
    const item = input[at];
    if (item.type === 'function_call_output' || item.type === 'function_call' || item.role === 'assistant') return null;
    const text = partsOf(item).map(partText).filter(Boolean).join('\n');
    const match = /^tool:(\w+) (.*)$/s.exec(text);
    if (match !== null) return [{ name: match[1], args: match[2] }];
    const together = /^tools:(.*)$/s.exec(text);
    if (together !== null) return JSON.parse(together[1]).map(({ name, args }) => ({ name, args: JSON.stringify(args) }));
  }
  return null;
}

// The slot count the C request's tail names, which the summary reply is keyed to.
const SLOT_COUNT = /slot numbers "1" to "(\d+)"/;

// The loopback endpoints: each request's JSON body is recorded with its route; Responses answers a summary request with its slots' strings, a directive with its tool call and anything else with text, the last two carrying `padding` where one is given while the output ceiling's cut answer, which stays empty, and the summary are as they are; Bedrock refuses with an HTTP error.
async function fixtureEndpoints({ padding } = {}) {
  const bodies = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (data) => { raw += data; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      if (request.url.includes('/converse-stream')) {
        bodies.push({ route: 'bedrock', url: request.url, httpVersion: request.httpVersion, body });
        response.writeHead(400, { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' });
        response.end(JSON.stringify({ message: 'the fixture endpoint records the request and refuses it' }));
        return;
      }
      bodies.push({ route: 'responses', url: request.url, httpVersion: request.httpVersion, body });
      const n = bodies.length;
      const tail = partsOf(body.input.at(-1) ?? {}).map(partText).filter(Boolean).join('\n');
      const count = SLOT_COUNT.exec(tail)?.[1];
      const asked = count === undefined ? askedOf(body.input) : null;
      const events = count !== undefined
        ? textEvents(n, JSON.stringify(Object.fromEntries(Array.from({ length: Number(count) }, (_, index) => [String(index + 1), `summary of slot ${index + 1}`]))))
        : asked !== null ? toolEvents(n, asked, padding) : tail.startsWith('cut') ? cutEvents(n) : textEvents(n, `reply ${n}`, padding);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { bodies, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

const RESPONSES = { provider: 'sw-responses', model: 'fixture-vision' };
const BEDROCK = { provider: 'amazon-bedrock', model: 'fixture-bedrock-vision' };
const STATIC_MODEL = { contextWindow: 200_000, maxTokens: 4_096, input: ['text', 'image'], reasoningEfforts: false };

function piAiOf(port) {
  return {
    placeholders: { SW_FIXTURE_RESPONSES_KEY: 'sw-fixture-placeholder-key', SW_FIXTURE_BEDROCK_KEY: 'sw-fixture-placeholder-key' },
    config: { providers: {
      'sw-responses': { api: 'openai-responses', baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'SW_FIXTURE_RESPONSES_KEY', models: [{ id: RESPONSES.model, ...STATIC_MODEL }] },
      'amazon-bedrock': { baseURL: `http://127.0.0.1:${port}`, apiKeyEnv: 'SW_FIXTURE_BEDROCK_KEY', models: [{ id: BEDROCK.model, ...STATIC_MODEL }] },
    } },
  };
}

// The serialized text a carrier takes in a request: the adapter joins a user message's text blocks, and the llm service has made each file block its handle text.
const carrierText = (llm, content) => content.map(block => (block.type === 'file' ? llm.fileRequestText(block.attachment) : block.text)).join('');
const HANDLE = /verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")/;
// The read path in the handle of the file named `name` within `text`.
function handlePath(text, name) {
  const at = text.indexOf(`[File "${name}"`);
  return at < 0 ? undefined : JSON.parse(HANDLE.exec(text.slice(at))[1]);
}

// Consecutive line numbers as the `{ offset, limit }` ranges a read asks for.
function rangesOf(numbers) {
  const ranges = [];
  for (const number of numbers) {
    const last = ranges.at(-1);
    if (last !== undefined && last.offset + last.limit === number) last.limit += 1;
    else ranges.push({ offset: number, limit: 1 });
  }
  return ranges;
}

// The held view's own size: what the production composition's `heldView` holds of the raw slice at a cutoff, its held
// file windows read from the shared Working Tree through the shared read module and rendered as compact evidence,
// and its skill texts; `tokens` is the token meter's estimate of all of it as one user text message. Beside it, the
// lines the resident carriers still carry, which a read between two seals can leave behind the held view.
function heldSizeOf({ composed, tree, meter, createUserMessage, events, sources }) {
  const held = composed.heldView(events);
  const paths = {};
  const unreadable = {};
  const texts = [];
  for (const [key, keys] of held.paths) {
    paths[key] = [...keys].sort((a, b) => a - b);
    const read = readTreeWindows(tree, key, rangesOf(paths[key]), { fileBytes: ATTRIBUTION_LIMITS.fileBytes });
    if (read.status !== 'readable') {
      unreadable[key] = read.reason;
      continue;
    }
    texts.push(renderFileEvidence(key, { totalLines: read.totalLines, runs: read.windows }).text);
  }
  texts.push(...held.skills.values());
  const text = texts.join('\n\n');
  const carriedLines = [...foldCarried(sources).paths.values()].reduce((sum, path) => sum + path.lines.size, 0);
  return {
    paths, unreadable, skills: [...held.skills.keys()],
    heldLines: Object.values(paths).reduce((sum, keys) => sum + keys.length, 0),
    chars: text.length,
    tokens: meter.estimateMessage(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })),
    carriedLines,
  };
}

// What later carriers no longer carry of an earlier one's entries: its lines a later entry withdraws or rewrites, and its paths a later one removes.
function supersededOf(sources, index) {
  const later = sources.slice(index + 1);
  const withdrawn = [];
  const rewritten = [];
  for (const entry of sources[index].paths) {
    const lines = new Set((entry.write ?? []).map(([number]) => number));
    for (const each of later.flatMap(source => source.paths).filter(other => other.path === entry.path)) {
      for (const number of each.withdraw ?? []) if (lines.has(number)) withdrawn.push(`${entry.path.split('/').at(-1)}:${number}`);
      for (const [number] of each.write ?? []) if (lines.has(number)) rewritten.push(`${entry.path.split('/').at(-1)}:${number}`);
    }
  }
  const removed = sources[index].paths.filter(entry => later.some(source => (source.removed ?? []).includes(entry.path))).map(entry => entry.path);
  return { withdrawn, rewritten, removed };
}

const SCENARIOS = {
  // A fresh mode-on session whose first act is `/sw-load`, over the real Responses adapter with the real workspace-instructions, time and skill-catalog plugins and the driver's own runtime context: the load's payload, read message and follow-up are admitted before the contexts prepared for the first request, and all of them are the initial prefix the first seal leaves resident, the kept lines the load showed being the baseline its B is built against.
  async 'loop-fresh-load'() {
    const endpoints = await fixtureEndpoints({ padding: REPLY_PADDING });
    const rig = await mountShippedLoop({ skills: true, contexts: true, tools: true, commands: true, persistence: true, piAi: piAiOf(endpoints.port) });
    const { ctx, llm } = rig;
    const dir = join(ROOT, 'fresh-load');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'Workspace rule: answer in one short line.\n');
    writeFileSync(join(dir, 'kept.txt'), textOf(lines('kept', 12)));
    const turnOf = async (agent, text) => {
      const at0 = agent.session.seq;
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await agent.whenIdle();
      return agent.session.snapshotEvents().slice(at0);
    };

    // A session of mode off reads a file and prepares a handoff keeping it.
    const author = await rig.harness.create(`fresh-author-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
    await turnOf(author, directive('read', { file_path: join(dir, 'kept.txt') }));
    await turnOf(author, directive('prepare_handoff', { summary: 'The work so far.', paths_to_keep: [{ path: 'kept.txt' }] }));
    const prepared = author.session.snapshotEvents().findLast(event => event.type === 'tool/result' && textsIn(event.data.message).includes('Handoff prepared'));
    assert.ok(prepared !== undefined, 'fixture: the model prepared a handoff');
    const token = /Token: (\S+)\. /.exec(textsIn(prepared.data.message))[1];

    // The blank session B opts in, then starts with `/sw-load`.
    const agent = await rig.harness.create(`fresh-load-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
    const { session } = agent;
    const sessionId = session.id;
    assert.deepEqual(await rig.call('inner-mode/select', { sessionId, enabled: true }), { ok: true, value: {} });
    const bodiesAt = endpoints.bodies.length;
    const loaded = await ctx.commands.execute(agent, `/sw-load ${token}`, [], new AbortController().signal);
    await agent.whenIdle();
    assert.equal(loaded?.result?.kind, 'success', `fixture: /sw-load: ${JSON.stringify(loaded?.result)}`);
    // The first request has been made: its stock less what the load put resident is the dead the epoch is anchored on.
    const bucketsOf = async () => (await rig.call('buckets', { sessionId })).value.payload;
    const historyOf = async () => (await rig.call('history', { sessionId })).value.payload;
    const firstStock = (await historyOf())[0].L;
    const deadBefore = (await bucketsOf()).dead;
    assert.ok(deadBefore > 0 && deadBefore < firstStock, `the load's kept content is deducted from the first stock: dead ${deadBefore} of ${firstStock}`);
    // One of the lines the load showed is rewritten on disk before the seal reads the held files.
    const REWRITTEN = 'kept line 5 rewritten after the load';
    writeFileSync(join(dir, 'kept.txt'), textOf(lines('kept', 12).map((row, index) => (index === 4 ? REWRITTEN : row))));

    // The native log before the first request's header, as each message was admitted.
    const events = session.snapshotEvents();
    const firstHeader = events.find(event => event.type === 'request/header');
    const labelOf = (event) => {
      if (event.type === 'system/message') return 'system-prompt';
      const { kind, calls } = event.data.source;
      return kind === 'session-watcher-load' ? (calls[0].name === 'load_handoff' ? 'load-payload' : 'load-read') : kind;
    };
    const admitted = session.surface.nodes.filter(seq => seq < firstHeader.seq).map(seq => ({ seq, label: labelOf(events[seq]) }));
    const labels = admitted.map(each => each.label);
    console.log(JSON.stringify({ admittedBeforeFirstHeader: admitted, firstHeader: firstHeader.seq }));
    const contexts = ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context'];
    assert.ok(contexts.every(kind => labels.includes(kind)) && ['load-payload', 'load-read'].every(label => labels.includes(label)),
      `fixture: the first request carries the real contexts and the load's two messages: ${labels.join(', ')}`);
    const payloadAt = labels.indexOf('load-payload');
    assert.deepEqual(labels.slice(0, payloadAt + 3), ['system-prompt', 'load-payload', 'load-read', 'user'], `the load batch is admitted first: ${labels.join(', ')}`);
    assert.deepEqual(labels.slice(payloadAt + 3).sort(), [...contexts].sort(), `the contexts prepared for the first request come after the load batch: ${labels.join(', ')}`);
    const [, payloadSeq, readSeq, followSeq] = admitted.slice(0, payloadAt + 3).map(each => each.seq);
    const kindsInLog = kind => session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === kind).length;
    assert.deepEqual(contexts.map(kindsInLog), [1, 1, 1, 1], 'each context is admitted once for the first request');

    // The first seal: the payload, the read, the follow-up and the contexts the first request carried are the initial prefix, so the range opens with the first model step. The held view is the real attribution's, read at the seal's cutoff.
    const store = openStore(join(process.env.HOME, '.session-watcher', 'store.sqlite'));
    const composed = composeWatcher({
      sessionId, cwd: dir, store, turnNotesRoot: join(ROOT, 'turn-notes'), readSession: async () => ({ events: [] }),
      isIgnored: null, cacheTtl: () => null, workingTree: nodeWorkingTree(),
    });
    const untilSeal = async (label) => {
      for (let index = 0; index < SEAL_WAIT_TURNS; index += 1) {
        const appended = await turnOf(agent, `${label} ${index + 1}`);
        const recordAt = appended.findIndex(event => event.type === INNER_CALL_RECORD_TYPE);
        if (recordAt >= 0) {
          assert.deepEqual(appended.slice(recordAt, recordAt + 3).map(event => event.type), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message']);
          const [record, prune, carrier] = appended.slice(recordAt, recordAt + 3);
          assertQuoted(agent.session, record);
          return { record, prune, carrier, range: record.data.range };
        }
      }
      throw new Error(`${label}: no seal within ${SEAL_WAIT_TURNS} turns`);
    };
    const first = await untilSeal('before the first seal');
    const resident = admitted.map(each => each.seq);
    const named = (seal, seqs) => seqs.every(seq => !seal.range.includes(seq) && !seal.prune.data.shadowedSeqs.includes(seq) && !seal.carrier.sourceEventSeqs.includes(seq)
      && seal.carrier.data.source.slots.every(slot => !slot.seqs.includes(seq)));
    assert.ok(named(first, resident), `the system prompt, the load batch and the contexts are in no range, prune, slot or cited source: range ${first.range.join(', ')}`);
    assert.equal(session.snapshotEvents()[first.range[0]].type, 'assistant/message', 'the range opens with the first model step');
    assert.ok(first.range[0] > followSeq, 'behind the whole prefix');
    assert.deepEqual(session.surface.nodes.slice(0, resident.length + 1), [...resident, first.carrier.seq], 'the prefix stays resident in its order and the carrier follows it');

    // B: the kept lines the load showed and the file still holds are carried by the load's read message, so the carrier writes the rewritten line alone.
    const events1 = session.snapshotEvents();
    const held = composed.heldView(events1.slice(0, first.record.seq));
    const keptKey = join(dir, 'kept.txt');
    assert.deepEqual([...held.paths.get(keptKey)].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1), 'fixture: the load\'s read is held');
    assert.deepEqual(first.carrier.data.source.paths.map(entry => [entry.path, entry.write]), [[keptKey, [[5, REWRITTEN]]]], 'the carrier carries the rewritten line alone');

    // The requests: the first body, the sealed session's auxiliary call and its next main request carry the whole prefix as the same bytes, the carrier after it.
    const firstBody = endpoints.bodies[bodiesAt];
    const auxIndex = endpoints.bodies.findIndex((each, at) => at >= bodiesAt && SLOT_COUNT.test(partsOf(each.body.input.at(-1)).map(partText).join('')));
    const aux = endpoints.bodies[auxIndex];
    const post = endpoints.bodies[auxIndex + 1];
    const k = resident.length;
    const residentBytes = JSON.stringify(firstBody.body.input.slice(0, k));
    for (const text of ['Workspace rule: answer in one short line.', '<available_skills>']) assert.ok(residentBytes.includes(text), `fixture: the first request's resident items hold ${text}`);
    // The load's read reaches the first request as one compact block: the file's path once, its rows.
    const keptHeader = `${keptKey} (total lines: 12)\n`;
    assert.equal(firstBody.body.input.map(item => partsOf(item).map(partText).join('')).find(text => text.startsWith(keptHeader)),
      `${keptHeader}${lines('kept', 12).map((row, index) => `${index + 1}: ${row}`).join('\n')}\n`, 'the first request carries the load\'s read as one compact block, as it showed the file then');
    assert.equal(partsOf(firstBody.body.input[resident.indexOf(followSeq)]).map(partText).join(''), events1[followSeq].data.content.map(block => block.text).join(''), 'fixture: the follow-up is the load batch\'s last item, ahead of the contexts');
    for (const [name, each] of [['auxiliary call', aux], ['next main request', post]]) {
      assert.equal(JSON.stringify(each.body.input.slice(0, k)), residentBytes, `the ${name} carries the whole prefix as the first request did`);
    }
    assert.ok(partsOf(post.body.input[k]).map(partText).join('').includes(CARRIER_TABLE.addresses), 'the carrier follows the prefix in the next main request');

    // A second seal over the same session: the prefix stays H, the first carrier is the frontier, and nothing was admitted again for being hidden.
    const second = await untilSeal('before the second seal');
    assert.ok(named(second, [...resident, first.carrier.seq]), `the second range holds neither the prefix nor the first carrier: ${second.range.join(', ')}`);
    assert.deepEqual(second.carrier.data.source.paths, [], 'the load and the first carrier are its baseline: nothing of the kept file is new');
    assert.deepEqual(contexts.map(kindsInLog), [1, 1, 1, 1], 'no context is admitted again after either seal');
    const after = endpoints.bodies.at(-1);
    assert.equal(JSON.stringify(after.body.input.slice(0, k)), residentBytes, 'every later request carries the prefix as the first did');
    // The seals replaced the first request's call among the rest of the range, and that call stays as the epoch's first point with the dead it observed.
    const firstCall = session.snapshotEvents().find(event => event.type === 'assistant/message' && event.data.usage !== undefined);
    assert.equal(Date.parse((await historyOf())[0].ts), firstCall.time, 'the first request is still the epoch\'s first point');
    assert.equal((await bucketsOf()).dead, deadBefore, 'the seals leave the dead the first request observed');
    console.log(JSON.stringify({ order: labels, payload: payloadSeq, read: readSeq, followUp: followSeq, ranges: [[first.range[0], first.range.at(-1), first.range.length], [second.range[0], second.range.at(-1), second.range.length]], carriedPaths: first.carrier.data.source.paths.map(each => [each.path.split('/').at(-1), (each.write ?? []).length]), heldLines: [...held.paths.values()].map(each => each.length), contextCounts: contexts.map(kindsInLog) }));
    closeStore(store);
    await ctx.fiber.dispose();
    await endpoints.close();
  },

  // A mode-on session cleared by `/sw-continue`, over the real Responses adapter with the real contexts: the cleared epoch has the initial prefix a new session has, the load's payload, read message and follow-up and the contexts admitted before the first request's header, whether that header changes any content or only starts the series, and the first seal builds B against the kept lines the load showed.
  async 'loop-continue-prefix'() {
    const endpoints = await fixtureEndpoints({ padding: REPLY_PADDING });
    const rig = await mountShippedLoop({ skills: true, contexts: true, tools: true, commands: true, persistence: true, piAi: piAiOf(endpoints.port) });
    const { ctx, llm } = rig;
    const dir = join(ROOT, 'continue-prefix');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'Workspace rule: answer in one short line.\n');
    writeFileSync(join(dir, 'kept.txt'), textOf(lines('kept', 12)));
    const turnOf = async (agent, text) => {
      const at0 = agent.session.seq;
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await agent.whenIdle();
      return agent.session.snapshotEvents().slice(at0);
    };

    // A mode-on session reads a file, prepares a handoff keeping it, and is cleared and resumed from it.
    const agent = await rig.harness.create(`continue-prefix-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
    const { session } = agent;
    const sessionId = session.id;
    assert.deepEqual(await rig.call('inner-mode/select', { sessionId, enabled: true }), { ok: true, value: {} });
    await turnOf(agent, directive('read', { file_path: join(dir, 'kept.txt') }));
    await turnOf(agent, directive('prepare_handoff', { summary: 'The work so far.', paths_to_keep: [{ path: 'kept.txt' }] }));
    const bodiesAt = endpoints.bodies.length;
    const continued = await ctx.commands.execute(agent, '/sw-continue', [], new AbortController().signal);
    await agent.whenIdle();
    assert.equal(continued?.result?.kind, 'success', `fixture: /sw-continue: ${JSON.stringify(continued?.result)}`);
    // One of the lines the load showed is rewritten on disk before the seal reads the held files.
    const REWRITTEN = 'kept line 5 rewritten after the load';
    writeFileSync(join(dir, 'kept.txt'), textOf(lines('kept', 12).map((row, index) => (index === 4 ? REWRITTEN : row))));

    // The cleared epoch's log: the checkpoint, what was admitted, and the header the first request after the clear logged.
    const events = session.snapshotEvents();
    const checkpoint = events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint');
    const header = events.find(event => event.type === 'request/header' && event.seq > checkpoint.seq);
    assert.ok(header !== undefined, 'fixture: the first request after the clear logged a header');
    assert.ok(events.some(event => event.type === 'request/header' && event.seq < checkpoint.seq), 'fixture: the session logged a header before the clear');
    assert.equal(header.data.reason, 'series', 'the clear changed no header content: the first request after it only starts the series');
    const labelOf = (event) => {
      if (event.type === 'system/message') return 'system-prompt';
      const { kind, calls } = event.data.source;
      return kind === 'session-watcher-load' ? (calls[0].name === 'load_handoff' ? 'load-payload' : 'load-read') : kind;
    };
    const prefix = session.surface.nodes.filter(seq => seq < header.seq && (seq === session.surface.nodes[0] || seq >= checkpoint.seq));
    const labels = prefix.map(seq => labelOf(events[seq]));
    console.log(JSON.stringify({ checkpoint: checkpoint.seq, header: header.seq, prefix: labels }));
    const contexts = ['agent-instructions', 'runtime-context', 'skill-catalog'];
    for (const label of ['load-payload', 'load-read', 'user', ...contexts]) assert.ok(labels.includes(label), `fixture: the cleared epoch admitted ${label} before its first header: ${labels.join(', ')}`);
    const [payloadSeq, readSeq] = ['load-payload', 'load-read'].map(label => prefix[labels.indexOf(label)]);
    assert.ok(readSeq === payloadSeq + 1, 'fixture: the read message follows the payload');

    const store = openStore(join(process.env.HOME, '.session-watcher', 'store.sqlite'));
    const composed = composeWatcher({
      sessionId, cwd: dir, store, turnNotesRoot: join(ROOT, 'turn-notes'), readSession: async () => ({ events: [] }),
      isIgnored: null, cacheTtl: () => null, workingTree: nodeWorkingTree(),
    });
    const untilSeal = async (label) => {
      for (let index = 0; index < SEAL_WAIT_TURNS; index += 1) {
        const appended = await turnOf(agent, `${label} ${index + 1}`);
        const recordAt = appended.findIndex(event => event.type === INNER_CALL_RECORD_TYPE);
        if (recordAt >= 0) {
          assert.deepEqual(appended.slice(recordAt, recordAt + 3).map(event => event.type), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message']);
          const [record, prune, carrier] = appended.slice(recordAt, recordAt + 3);
          assertQuoted(agent.session, record);
          return { record, prune, carrier, range: record.data.range };
        }
      }
      throw new Error(`${label}: no seal within ${SEAL_WAIT_TURNS} turns`);
    };
    const first = await untilSeal('before the first seal');
    const after = session.snapshotEvents();
    assert.ok(prefix.every(seq => !first.range.includes(seq) && !first.prune.data.shadowedSeqs.includes(seq) && !first.carrier.sourceEventSeqs.includes(seq)
      && first.carrier.data.source.slots.every(slot => !slot.seqs.includes(seq))), `the whole prefix is in no range, prune, slot or cited source: range ${first.range.join(', ')}`);
    assert.equal(after[first.range[0]].type, 'assistant/message', 'the range opens with the cleared epoch\'s first model step');
    assert.ok(first.range[0] > header.seq, 'behind the first request after the clear');
    assert.deepEqual(session.surface.nodes.slice(0, prefix.length + 1), [...prefix, first.carrier.seq], 'the prefix stays resident in its order and the carrier follows it');

    // B: the kept lines the load showed are the baseline, the rewritten line is what the carrier writes.
    const keptKey = join(dir, 'kept.txt');
    const held = composed.heldView(after.slice(checkpoint.seq, first.record.seq));
    assert.deepEqual([...held.paths.get(keptKey)].sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1), 'fixture: the load\'s read is held');
    assert.deepEqual(first.carrier.data.source.paths.map(entry => [entry.path, entry.write]), [[keptKey, [[5, REWRITTEN]]]], 'the carrier carries the rewritten line alone');

    // The requests: the first one after the clear, the auxiliary call and the next main request carry the prefix as the same bytes, the carrier after it.
    const afterClear = endpoints.bodies.slice(bodiesAt).filter(each => each.route === 'responses');
    const auxIndex = afterClear.findIndex(each => SLOT_COUNT.test(partsOf(each.body.input.at(-1)).map(partText).join('')));
    const [firstBody, aux, post] = [afterClear[0], afterClear[auxIndex], afterClear[auxIndex + 1]];
    const k = prefix.length;
    const residentBytes = JSON.stringify(firstBody.body.input.slice(0, k));
    for (const text of ['Workspace rule: answer in one short line.', '<available_skills>']) assert.ok(residentBytes.includes(text), `fixture: the first request's resident items hold ${text}`);
    const keptHeader = `${keptKey} (total lines: 12)\n`;
    assert.equal(firstBody.body.input.map(item => partsOf(item).map(partText).join('')).find(text => text.startsWith(keptHeader)),
      `${keptHeader}${lines('kept', 12).map((row, index) => `${index + 1}: ${row}`).join('\n')}\n`, 'the first request after the clear carries the load\'s read as one compact block');
    for (const [name, each] of [['auxiliary call', aux], ['next main request', post]]) {
      assert.equal(JSON.stringify(each.body.input.slice(0, k)), residentBytes, `the ${name} carries the whole prefix as the first request after the clear did`);
    }
    assert.ok(partsOf(post.body.input[k]).map(partText).join('').includes(CARRIER_TABLE.addresses), 'the carrier follows the prefix in the next main request');
    closeStore(store);
    await ctx.fiber.dispose();
    await endpoints.close();
  },

  // The wire after a step the loop settled empty: the assistant message with no block keeps its place on the surface and reaches the request as no item, so the questions around it are adjacent in the body.
  async 'loop-empty-step-wire'() {
    const endpoints = await fixtureEndpoints();
    const rig = await mountShippedLoop({ piAi: piAiOf(endpoints.port) });
    const { ctx, llm } = rig;
    const dir = join(ROOT, 'empty-wire');
    mkdirSync(dir, { recursive: true });
    const agent = await rig.harness.create(`empty-wire-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
    const turn = async (text) => {
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await agent.whenIdle();
    };
    await turn('first question');
    await turn('cut answer please');
    await turn('third question');

    const events = agent.session.snapshotEvents();
    const empties = events.filter(event => event.type === 'assistant/message' && event.data.message.content.length === 0 && event.data.usage !== undefined);
    assert.equal(empties.length, 1, 'the loop settled the cut step as an assistant message with usage and no block');
    assert.ok(events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'max-tokens'), 'its turn ended at the output ceiling');
    assert.ok(agent.session.surface.nodes.includes(empties[0].seq), 'the empty message keeps its position on the surface');
    assert.ok(agent.session.deriveMessages().every(message => message.id !== empties[0].data.message.id), 'and derives no message');
    const bodies = endpoints.bodies.filter(each => each.route === 'responses');
    assert.equal(bodies.length, 3);
    const after = bodies[2].body.input;
    const at = text => after.findIndex(item => partsOf(item).map(partText).join('').includes(text));
    assert.equal(at('third question') - at('cut answer please'), 1, 'the questions around the empty step are adjacent in the request body');
    assert.equal(after.filter(item => item.role === 'assistant').length, 1, 'only the first answer reaches the body as an assistant item');
    console.log(JSON.stringify({ emptyStepWire: { items: after.length, emptySeq: empties[0].seq } }));
    await ctx.fiber.dispose();
    await endpoints.close();
  },

  // A held block the real Engine moved down a file when two lines were put above it: the next seal writes every held line, leaves out of its body the lines whose text an earlier carrier on the request already shows and shows the two new ones, over the real Responses adapter. The earlier carrier's bytes in the request are what they were, the carriers' fold still holds the left-out lines, and the host's resources after the seal are the off-mode run's.
  async 'loop-relocation'() {
    const endpoints = await fixtureEndpoints({ padding: REPLY_PADDING });
    const rig = await mountShippedLoop({ tools: true, persistence: true, piAi: piAiOf(endpoints.port) });
    const { llm, call } = rig;
    const FILE = lines('alpha', 20);
    const INSERTED = ['inserted line A', 'inserted line B'];
    const MOVED = [...INSERTED, ...FILE];
    const turn = async (run, content) => {
      const at0 = run.session.seq;
      run.agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } }));
      await run.agent.whenIdle();
      return run.session.snapshotEvents().slice(at0);
    };
    const sealIn = (run, appended) => {
      const recordAt = appended.findIndex(event => event.type === INNER_CALL_RECORD_TYPE);
      if (recordAt < 0) return null;
      assert.deepEqual(appended.slice(recordAt, recordAt + 3).map(event => event.type), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message']);
      const [record, , carrier] = appended.slice(recordAt, recordAt + 3);
      assertQuoted(run.session, record);
      return { record, carrier };
    };
    // Plain turns until one seals, or, for the run that never seals, as many as the sealed run needed.
    const untilSeal = async (run, label) => {
      for (let index = 0; index < SEAL_WAIT_TURNS; index += 1) {
        const seal = sealIn(run, await turn(run, `${label} ${index + 1}`));
        if (seal !== null) return { ...seal, turns: index + 1 };
      }
      throw new Error(`${label}: no seal within ${SEAL_WAIT_TURNS} turns`);
    };
    // Directory names of one length, so a path's text weighs the same in both runs.
    const runs = {};
    for (const [name, enabled] of [['sealed', true], ['control', false]]) {
      const dir = join(ROOT, name === 'sealed' ? 'sealed' : 'unseal');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.txt'), textOf(FILE));
      const agent = await rig.harness.create(`relocation-${name}-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
      assert.deepEqual(await rig.call('inner-mode/select', { sessionId: agent.session.id, enabled }), { ok: true, value: {} });
      runs[name] = { dir, agent, session: agent.session, path: join(dir, 'a.txt') };
    }
    // The host's resources of a run as the off-mode comparison reads them, paths relative to the run's directory.
    const resourcesOf = async run => (await call('buckets', { sessionId: run.session.id })).value.payload.paths
      .filter(row => row.path.startsWith(run.dir))
      .map(({ path, tokens, readCount, editCount, pureRereads }) => ({ path: path.slice(run.dir.length), tokens, readCount, editCount, pureRereads }));

    const seals = {};
    const marks = {};
    const states = {};
    for (const run of [runs.sealed, runs.control]) {
      const sealed = run === runs.sealed;
      await turn(run, 'the original task');
      await turn(run, directive('read', { file_path: run.path }));
      const first = sealed ? await untilSeal(run, 'before the first seal') : null;
      if (!sealed) for (let index = 0; index < seals.first.turns; index += 1) await turn(run, `before the first seal ${index + 1}`);
      // Two lines above the held block: the next read of the file, of its first two lines, is where the Engine finds the block moved.
      writeFileSync(run.path, textOf(MOVED));
      await turn(run, directive('read', { file_path: run.path, offset: 1, limit: INSERTED.length }));
      if (sealed) {
        seals.first = first;
        marks.afterRead = endpoints.bodies.length;
        states.before = await resourcesOf(run);
        seals.second = await untilSeal(run, 'before the second seal');
        states.after = await resourcesOf(run);
      } else {
        for (let index = 0; index < seals.second.turns; index += 1) await turn(run, `before the second seal ${index + 1}`);
        states.control = await resourcesOf(run);
      }
    }
    const { first, second } = seals;
    const { sealed } = runs;

    // The block moved in the real Engine: the held view of the sealed run at the second seal holds the file's 22 lines, the old ones at their new numbers.
    const store = openStore(join(process.env.HOME, '.session-watcher', 'store.sqlite'));
    const composed = composeWatcher({
      sessionId: sealed.session.id, cwd: sealed.dir, store, turnNotesRoot: join(ROOT, 'turn-notes'), readSession: async () => ({ events: [] }),
      isIgnored: null, cacheTtl: () => null, workingTree: nodeWorkingTree(),
    });
    const events = sealed.session.snapshotEvents();
    const held = composed.heldView(events.slice(0, second.record.seq));
    assert.deepEqual([...(held.paths.get(sealed.path) ?? [])].sort((a, b) => a - b), MOVED.map((_, index) => index + 1), `fixture: the Engine holds the block at its new lines and the two new ones: ${JSON.stringify([...held.paths])} ${JSON.stringify(second.carrier.data.source.paths.map(each => [each.path, each.write?.length, each.omit?.length]))}`);

    // The source writes every held line; the lines of the old block, whose text the first carrier shows, are the ones left out.
    const [entry] = second.carrier.data.source.paths;
    assert.equal(entry.path, sealed.path);
    assert.deepEqual(entry.write, MOVED.map((text, index) => [index + 1, text]), 'the second carrier writes every held line at its new number');
    assert.deepEqual(entry.omit, FILE.map((_, index) => index + 3), 'and leaves out the lines the first carrier shows');
    assert.equal(entry.withdraw, undefined);
    const fold = foldCarried([first.carrier.data.source, second.carrier.data.source]).paths.get(sealed.path);
    assert.deepEqual([...fold.lines].sort(([a], [b]) => a - b), MOVED.map((text, index) => [index + 1, text]), 'the carried chain holds the left-out lines too: it is the disk on the held lines');

    // The bytes: the request before the seal's auxiliary call, that call and the next main request.
    const items = body => body.input.map(item => partsOf(item).map(partText).join(''));
    const auxAt = marks.afterRead + endpoints.bodies.slice(marks.afterRead).findIndex(each => SLOT_COUNT.test(partsOf(each.body.input.at(-1)).map(partText).join('')));
    assert.ok(auxAt >= marks.afterRead, 'fixture: the second seal made its auxiliary call');
    const [before, aux, post] = [auxAt - 1, auxAt, auxAt + 1].map(at => endpoints.bodies[at]);
    const firstText = carrierText(llm, first.carrier.data.content);
    const secondText = carrierText(llm, second.carrier.data.content);
    const firstAt = items(before.body).indexOf(firstText);
    assert.ok(firstAt >= 0, 'fixture: the first carrier is in the request before the seal');
    const prefixOf = each => JSON.stringify(each.body.input.slice(0, firstAt + 1));
    assert.equal(prefixOf(aux), prefixOf(before), 'the auxiliary call carries the items through the first carrier as the request before it did');
    assert.equal(prefixOf(post), prefixOf(before), 'and so does the next main request');
    const secondAt = items(post.body).indexOf(secondText);
    assert.ok(secondAt > firstAt, 'the second carrier follows the first in that request');
    const header = `${entry.displayPath} (total lines: ${MOVED.length})`;
    assert.ok(secondText.includes(`${header}\n${INSERTED.map((text, index) => `${index + 1}: ${text}`).join('\n')}`), 'the second carrier shows the two new lines under the path');
    assert.ok(!secondText.includes('alpha line'), 'and no line of the moved block');
    assert.equal(JSON.stringify(post.body).split('alpha line 5').length - 1, 1, 'a line of the moved block is in that request once, in the first carrier');
    assert.ok(firstText.includes('5: alpha line 5'));

    // The host's consumption of the replaced events: the sealed run's resources are what they were before the seal and the off-mode run's, the block held at its new lines.
    const control = states.control.map(row => ({ ...row }));
    assert.deepEqual(states.after, states.before, 'the seal leaves the resources as they stood');
    assert.deepEqual(states.after, control, 'and they are the off-mode run\'s');
    assert.ok(states.after.some(row => row.path === '/a.txt' && row.tokens > 0), 'fixture: the file is a resource of the host');
    // The held lines after the seal, read from the sealed run's whole log, are the off-mode run's.
    const linesOf = (view, path) => [...view.paths.get(path)].sort((a, b) => a - b);
    const heldControl = composeWatcher({
      sessionId: runs.control.session.id, cwd: runs.control.dir, store, turnNotesRoot: join(ROOT, 'turn-notes'), readSession: async () => ({ events: [] }),
      isIgnored: null, cacheTtl: () => null, workingTree: nodeWorkingTree(),
    }).heldView(runs.control.session.snapshotEvents());
    const heldSealed = composed.heldView(sealed.session.snapshotEvents());
    assert.deepEqual(linesOf(heldSealed, sealed.path), MOVED.map((_, index) => index + 1), 'the seal leaves the held lines as they stood');
    assert.deepEqual(linesOf(heldControl, runs.control.path), linesOf(heldSealed, sealed.path), 'and they are the off-mode run\'s');
    console.log(JSON.stringify({ relocation: { held: held.paths.get(sealed.path).length, written: entry.write.length, omitted: entry.omit.length, shown: entry.write.length - entry.omit.length, firstAt, secondAt, resources: states.after } }));
    closeStore(store);
    await rig.ctx.fiber.dispose();
    await endpoints.close();
  },

  // The first seal of a session whose first request carried, besides the user's task, the contexts the real workspace-instructions, time and skill-catalog plugins admit ahead of it, over the real llm-pi-ai Responses adapter: the seal's range opens with the first model step, and the bytes of the initial prefix are what every later request carries first.
  async 'loop-initial-prefix'() {
    const endpoints = await fixtureEndpoints({ padding: REPLY_PADDING });
    const rig = await mountShippedLoop({ skills: true, contexts: true, piAi: piAiOf(endpoints.port) });
    const { ctx, llm } = rig;
    const dir = join(ROOT, 'prefix');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), 'Workspace rule: answer in one short line.\n');
    const agent = await rig.harness.create(`prefix-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
    const sessionId = agent.session.id;
    assert.deepEqual(await rig.call('inner-mode/select', { sessionId, enabled: true }), { ok: true, value: {} });
    const turn = async (text) => {
      const at0 = agent.session.seq;
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await agent.whenIdle();
      return agent.session.snapshotEvents().slice(at0);
    };

    await turn('the original task');
    const events = () => agent.session.snapshotEvents();
    const firstHeader = events().find(event => event.type === 'request/header');
    const preSurface = [...agent.session.surface.nodes];
    const prefix = preSurface.filter(seq => seq < firstHeader.seq);
    const kindOf = seq => (events()[seq].type === 'system/message' ? 'system-prompt' : events()[seq].data.source.kind);
    const kinds = prefix.map(kindOf);
    // The fixture is the native pattern: the system prompt, the task, then the harness contexts, all before the first request's header.
    assert.equal(kinds[0], 'system-prompt');
    assert.ok(kinds.includes('user') && kinds.includes('skill-catalog') && kinds.includes('time-context') && kinds.includes('agent-instructions'),
      `the first request carries the task and the harness contexts: ${kinds.join(', ')}`);
    const firstBody = endpoints.bodies[0];

    let sealed = null;
    for (let index = 0; index < SEAL_WAIT_TURNS && sealed === null; index += 1) {
      const appended = await turn(`work ${index + 1}`);
      const recordAt = appended.findIndex(event => event.type === INNER_CALL_RECORD_TYPE);
      if (recordAt >= 0) sealed = appended.slice(recordAt, recordAt + 3);
    }
    assert.ok(sealed !== null, 'the session sealed');
    const [record, prune, carrier] = sealed;
    assert.deepEqual(sealed.map(event => event.type), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message']);
    assertQuoted(agent.session, record);
    const { range } = record.data;
    assert.ok(range[0] > firstHeader.seq && prefix.every(seq => !range.includes(seq) && !prune.data.shadowedSeqs.includes(seq) && !carrier.sourceEventSeqs.includes(seq)),
      `the initial prefix ${prefix.join(', ')} is in no range, prune or cited source: range ${range.join(', ')}`);
    assert.ok(carrier.data.source.slots.every(slot => slot.seqs.every(seq => !prefix.includes(seq))), 'no slot names the prefix');
    assert.deepEqual(agent.session.surface.nodes.slice(0, prefix.length + 1), [...prefix, carrier.seq], 'the prefix is on the surface ahead of the carrier');

    // The bytes: the first request's whole body is the initial prefix (system prompt as instructions, then the task and the contexts), and the sealed session's auxiliary call and next main request carry the same items first, the carrier after them.
    const auxIndex = endpoints.bodies.findIndex(each => SLOT_COUNT.test(partsOf(each.body.input.at(-1)).map(partText).join('')));
    const aux = endpoints.bodies[auxIndex];
    const post = endpoints.bodies[auxIndex + 1];
    const n = firstBody.body.input.length;
    assert.ok(n >= prefix.length - 1, `the first body holds the prefix items: ${n}`);
    const prefixBytes = JSON.stringify(firstBody.body.input);
    for (const text of ['the original task', 'Workspace rule: answer in one short line.', '<available_skills>']) {
      assert.ok(prefixBytes.includes(text), `fixture: the first request's input holds ${text}`);
    }
    for (const [name, each] of [['auxiliary call', aux], ['next main request', post]]) {
      assert.equal(JSON.stringify(each.body.input.slice(0, n)), prefixBytes, `the ${name} carries the first request's input bytes verbatim first`);
      assert.equal(each.body.instructions, firstBody.body.instructions, `the ${name} carries the system prompt verbatim`);
    }
    assert.ok(partsOf(post.body.input[n]).map(partText).join('').includes(carriedNote()) || partsOf(post.body.input[n]).map(partText).join('').includes(carrier.data.source.slots[0].text),
      'the carrier follows the prefix in the next main request');
    console.log(JSON.stringify({ prefixKinds: kinds, firstHeader: firstHeader.seq, prefix, range: [range[0], range.at(-1)], firstBodyItems: n, auxItems: aux.body.input.length, postItems: post.body.input.length }));
    await ctx.fiber.dispose();
    await endpoints.close();
  },

  // One mode-on session over the real llm-pi-ai adapter: consecutive seals through the Responses route, the mounted tools reading back what they sealed, the Bedrock route serializing the session's main and auxiliary requests against an endpoint that refuses them, then a fresh context resuming the session from its own JSONL log; every recorded body matched against the carriers resident when it was dispatched.
  async 'loop-native'() {
    const endpoints = await fixtureEndpoints({ padding: REPLY_PADDING });
    // compaction-basic under a threshold the session never reaches, so only the region the case asks for compacts.
    const stock = { compaction: { thresholdRatio: 0.5, retainRatio: 0.2, headroomTokens: 0, maxTokens: 1_000 } };
    const mount = () => mountShippedLoop({ tools: true, commands: true, persistence: true, stock, piAi: piAiOf(endpoints.port) });
    const evidence = {};
    let rig = await mount();
    let { ctx, llm } = rig;
    const dir = join(ROOT, 'native');
    mkdirSync(dir, { recursive: true });
    const at = file => join(dir, file);
    writeFileSync(at('a.txt'), textOf(lines('alpha', 20)));
    writeFileSync(at('b.txt'), textOf(lines('bravo', 10)));
    writeFileSync(at('gone.txt'), textOf(lines('gone', 5)));
    writeFileSync(at('c.txt'), textOf(lines('charlie', 8)));
    let agent = await rig.harness.create(`native-${Date.now().toString(16)}`, RESPONSES, { cwd: dir });
    const sessionId = agent.session.id;
    assert.deepEqual(await rig.call('inner-mode/select', { sessionId, enabled: true }), { ok: true, value: {} });
    // The production composition bound to the tested session: its id and directory, the host's own Store (a second connection to its file) and the process's shared Node Working Tree; its held view recalls the session's records and writes none.
    const store = openStore(join(process.env.HOME, '.session-watcher', 'store.sqlite'));
    const tree = nodeWorkingTree();
    const composed = composeWatcher({
      sessionId, cwd: dir, store, turnNotesRoot: join(ROOT, 'turn-notes'), readSession: async () => ({ events: [] }),
      isIgnored: null, cacheTtl: () => null, workingTree: tree,
    });

    // Each adapter request of the session as the llm service dispatches it: its purpose, route and the carriers resident on the surface then, each priced by the meter.
    const dispatches = [];
    const watchDispatch = (context) => {
      context.on('llm/stream', (options, next) => {
        if (options.sessionId === sessionId) {
          const { session } = agent;
          const events = session.snapshotEvents();
          const nodes = context.tokenMeter.measure(session).nodes;
          dispatches.push({
            purpose: options.purpose ?? 'main', provider: options.provider,
            carriers: session.surface.nodes.map(seq => events[seq]).filter(isCarrierEvent).map((event) => {
              const { tokens, heuristicTokens } = nodes.find(node => node.seq === event.seq);
              const handles = new Map(event.data.content.filter(block => block.type === 'file').map(block => [block.attachment.attachmentId + block.attachment.name, context.llm.fileRequestText(block.attachment)]));
              return { seq: event.seq, source: event.data.source, text: carrierText(context.llm, event.data.content), handles, tokens, heuristicTokens };
            }),
            view: heldSizeOf({
              composed, tree, meter: context.tokenMeter, createUserMessage: llm.createUserMessage, events,
              sources: session.surface.nodes.map(seq => events[seq]).filter(isCarrierEvent).map(event => event.data.source),
            }),
          });
        }
        return next();
      });
    };
    watchDispatch(ctx);

    const turn = async (content) => {
      const at0 = agent.session.seq;
      agent.followup(llm.createUserMessage({ content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, source: { kind: 'user' } }));
      await agent.whenIdle();
      return agent.session.snapshotEvents().slice(at0);
    };
    const sealIn = (appended) => {
      const recordAt = appended.findIndex(event => event.type === INNER_CALL_RECORD_TYPE);
      if (recordAt < 0) return null;
      assert.deepEqual(appended.slice(recordAt, recordAt + 3).map(event => event.type), [INNER_CALL_RECORD_TYPE, 'compaction/prune', 'user/message'], 'the three appends, adjacent and in order');
      const [record, prune, carrier] = appended.slice(recordAt, recordAt + 3);
      assertQuoted(agent.session, record);
      assert.deepEqual(record.data.selection, RESPONSES);
      assert.equal(record.data.thrown, undefined);
      assert.deepEqual(carrier.surfaceOp, { op: 'replace', startSeq: record.data.range[0], endSeq: record.data.range.at(-1) });
      // The seal runs at the pre-step, before the step starts and admits the turn's own user message.
      const userMessage = appended.find(event => event.type === 'user/message' && event.data.source.kind === 'user');
      assert.ok(userMessage.seq > carrier.seq && appended.find(event => event.type === 'step/start').seq > carrier.seq, 'the turn\'s user message is admitted after the carrier');
      return { record, prune, carrier, range: record.data.range };
    };
    const untilSeal = async (label, limit = SEAL_WAIT_TURNS) => {
      for (let index = 0; index < limit; index += 1) {
        const seal = sealIn(await turn(`${label} ${index + 1}`));
        if (seal !== null) return seal;
      }
      throw new Error(`${label}: no seal within ${limit} turns`);
    };
    // The result message of each tool a turn called, by tool name.
    const resultsOf = (appended) => {
      const names = new Map(appended.filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.filter(block => block.type === 'tool-call').map(block => [block.id, block.name])));
      return new Map(appended.filter(event => event.type === 'tool/result').map(event => [names.get(event.data.message.toolCallId), event.data.message]));
    };

    // The session's first request, its original task, is the initial prefix and stays out of every range; the first range opens after it.
    await turn('the original task');
    // The first range: a user message with a text file and a PNG the attachment store normalizes to JPEG under its `.png` name, then reads.
    const notes = textOf(lines('note', 6));
    const fileRef = await ctx.attachments.saveFile({ data: new TextEncoder().encode(notes), name: 'notes.txt' });
    const imageRef = await ctx.attachments.saveImage({ data: makePng(9000, 4), mediaType: 'image/png', name: 'wide-screenshot.png' });
    assert.equal(imageRef.mediaType, 'image/jpeg', `fixture: the upload is normalized to JPEG: ${JSON.stringify(imageRef)}`);
    assert.equal(imageRef.name, 'wide-screenshot.png', 'fixture: under its .png display name');
    const attached = await turn([{ type: 'text', text: 'the attached notes and screenshot' }, { type: 'file', attachment: fileRef }, { type: 'image', attachment: imageRef }]);
    const attachmentMessage = attached.find(event => event.type === 'user/message' && event.data.source.kind === 'user');
    const imageBody = endpoints.bodies.at(-1).body;
    assert.ok(imageBody.input.some(item => partsOf(item).some(part => part.type === 'input_image')), 'the image-capable route sends the image itself');
    await turn(directive('read', { file_path: at('a.txt') }));
    await turn(directive('read', { file_path: at('b.txt') }));
    await turn(directive('read', { file_path: at('gone.txt') }));
    const first = await untilSeal('before the first seal');
    assert.ok(first.range.includes(attachmentMessage.seq), 'the attachment message is sealed');
    const anchorSlot = first.carrier.data.source.slots.find(slot => slot.seqs.includes(attachmentMessage.seq));
    const savedImage = anchorSlot.attachments.find(each => each.image !== undefined).file;

    // The second range: a held line changes, a held file goes, a handoff is loaded mid-epoch keeping a.txt, and another file is read.
    writeFileSync(at('a.txt'), textOf(lines('alpha', 20).map((row, index) => (index === 2 ? 'alpha line 3, changed on disk' : row))));
    rmSync(at('gone.txt'));
    await turn(directive('prepare_handoff', { summary: 'The work so far.', paths_to_keep: [{ path: 'a.txt' }] }));
    const prepared = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result' && textsIn(event.data.message).includes('Handoff prepared'));
    assert.ok(prepared !== undefined, 'the model prepared a handoff');
    const token = /Token: (\S+)\. /.exec(textsIn(prepared.data.message))[1];
    const loaded = await ctx.commands.execute(agent, `/sw-load ${token}`, [], new AbortController().signal);
    await agent.whenIdle();
    assert.equal(loaded?.result?.kind, 'success', `/sw-load: ${JSON.stringify(loaded?.result)}`);
    await turn(directive('read', { file_path: at('c.txt') }));
    // The request answering that read: c.txt is held, and no carrier carries it yet.
    const betweenSeals = endpoints.bodies.at(-1);
    const second = await untilSeal('before the second seal');
    const entryOf = (source, file) => source.paths.find(each => each.path === at(file));
    assert.deepEqual(entryOf(second.carrier.data.source, 'a.txt').write, [[3, 'alpha line 3, changed on disk']], 'the second carries a.txt\'s changed line alone against the first');
    assert.deepEqual(entryOf(second.carrier.data.source, 'gone.txt').withdraw, [1, 2, 3, 4, 5], 'and withdraws what the first carried of the deleted file');
    const postSeal = endpoints.bodies.at(-1);

    // Read-back through the mounted tools, called by the model: the shadowed source behind a carrier anchor, the carried text file and the saved image.
    const carriedText = carrierText(ctx.llm, first.carrier.data.content);
    const notesPath = handlePath(carriedText, 'notes.txt');
    const imagePath = handlePath(carriedText, savedImage.name);
    assert.ok(notesPath !== undefined && imagePath !== undefined, 'the carrier hands both files over as read paths');
    assert.ok(!agent.session.surface.nodes.includes(attachmentMessage.seq), 'the anchor is shadowed');
    // A source the first carrier summarizes rather than quotes: an assistant message of its range.
    const summarized = agent.session.snapshotEvents().find(event => event.type === 'assistant/message' && first.range.includes(event.seq));
    assert.ok(summarized !== undefined && !agent.session.surface.nodes.includes(summarized.seq), 'a summarized source is shadowed');
    // The calls in one step: the steps from the second carrier to the load below stay under the seal's step count, so that the load's payload, not a seal, becomes the frontier the next range starts after.
    // The first call reads an event the log lacks and the second the anchor, whose text the carrier quotes word for word; the runtime records each failure under its fixed code, a result sharing the tool's name with the read below them, which answers last and is the one `readBack` holds.
    const readTurn = await turn(inOneStep(
      [EVENT_READ_TOOL, { seq: 1_000_000 }],
      [EVENT_READ_TOOL, { seq: attachmentMessage.seq }],
      [EVENT_READ_TOOL, { seq: summarized.seq, before: 1, after: 1 }],
      ['read', { file_path: notesPath }],
      ['read_image', { file_path: imagePath }],
    ));
    const readBack = resultsOf(readTurn);
    const missingRead = readTurn.find(event => event.type === 'tool/result' && event.data.error?.code === 'SESSION_QUERY_EVENT_NOT_FOUND');
    assert.ok(missingRead !== undefined, `the failed read carries the code of its failure through the tool runtime: ${JSON.stringify(readTurn.filter(event => event.type === 'tool/result').map(event => event.data.error))}`);
    const heldRead = readTurn.find(event => event.type === 'tool/result' && event.data.error?.code === 'SW_EVENT_CARRIED');
    assert.ok(heldRead !== undefined, 'the read of the quoted anchor is refused');
    const eventRead = readBack.get(EVENT_READ_TOOL);
    assert.equal(eventRead.isError ?? false, false, JSON.stringify(eventRead));
    const eventJson = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(textsIn(eventRead))[1]);
    // The window counts raw events: the one before and the one after the target are each listed, whatever they hold, by the service's own extraction.
    for (const neighbor of [summarized.seq - 1, summarized.seq + 1]) {
      assert.match(textsIn(eventRead), new RegExp(`^- seq ${neighbor} \\| `, 'm'), `the neighbor at seq ${neighbor} is listed`);
    }
    assert.deepEqual({ seq: eventJson.seq, type: eventJson.type, content: eventJson.data.message.content.filter(block => block.type !== 'reasoning') }, { seq: summarized.seq, type: 'assistant/message', content: summarized.data.message.content.filter(block => block.type !== 'reasoning') },
      'the event read on a summarized source answers the shadowed source event');
    const textRead = readBack.get('read');
    assert.equal(textRead.isError ?? false, false, JSON.stringify(textRead));
    assert.equal(textsIn(textRead), `<path>${realpathSync(notesPath)}</path>\n<type>file</type>\n<content>\n${lines('note', 6).map((row, index) => `${index + 1}: ${row}`).join('\n')}\n\n(End of file - total 6 lines)\n</content>`,
      'read on the text file handle answers its stored text in the native read format');
    const imageRead = readBack.get('read_image');
    assert.equal(imageRead.isError ?? false, false, `read_image on the saved image answers an image: ${textsIn(imageRead)}`);
    const image = imageRead.content.find(block => block.type === 'image');
    assert.deepEqual({ mediaType: image?.attachment.mediaType, width: image?.attachment.width, height: image?.attachment.height }, { mediaType: 'image/jpeg', width: imageRef.width, height: imageRef.height });
    // BC#26 over the native read-back: the normalized bytes saved under the extension of their media type, the original attachment's identity beside them.
    assert.deepEqual(anchorSlot.attachments, [
      { file: fileRef },
      { file: { attachmentId: imageRef.attachmentId, name: 'wide-screenshot.jpg', bytes: imageRef.bytes }, image: { attachmentId: imageRef.attachmentId, name: 'wide-screenshot.png' } },
    ], 'the file moves as it is; the normalized JPEG is saved under its own extension beside the original attachment\'s identity');

    evidence.readBack = { anchor: attachmentMessage.seq, notesPath: notesPath.split('/').slice(-4).join('/'), imagePath: imagePath.split('/').slice(-4).join('/'), image: image.attachment };

    // A native region compaction, through the compaction service's own `compactRegion` at a pre-step, keeps the second carrier at the head of its kept tail and opens the next Context Epoch; a handoff loaded after it makes its payload the frontier, so the second carrier stays on the surface outside the next range, the baseline, while the new epoch holds none of its paths.
    let region = null;
    ctx.on('agent/pre-step', async (payload, next) => {
      if (region !== null && payload.agent.session.id === sessionId) {
        const { start, end } = region;
        region = null;
        await ctx.compaction.compactRegion(start, end, payload.agent, payload.signal);
      }
      return next();
    });
    const loadKeeping = async (path) => {
      await turn(directive('prepare_handoff', { summary: 'The work since.', paths_to_keep: [{ path }] }));
      const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result' && textsIn(event.data.message).includes('Handoff prepared'));
      const loading = await ctx.commands.execute(agent, `/sw-load ${/Token: (\S+)\. /.exec(textsIn(result.data.message))[1]}`, [], new AbortController().signal);
      await agent.whenIdle();
      assert.equal(loading?.result?.kind, 'success', `/sw-load: ${JSON.stringify(loading?.result)}`);
    };
    {
      const { session } = agent;
      const nodes = session.surface.nodes;
      assert.equal(session.snapshotEvents()[nodes[0]].type, 'system/message');
      region = { start: nodes[1], end: nodes[nodes.indexOf(second.carrier.seq) - 1] };
    }
    const compacted = await turn('the region compaction turn');
    const checkpoint = compacted.find(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint');
    assert.ok(checkpoint !== undefined && !compacted.some(event => event.type === INNER_CALL_RECORD_TYPE), `the region compacted and nothing sealed: ${compacted.map(event => event.type).join(', ')}`);
    assert.deepEqual(agent.session.surface.nodes.slice(1, 3), [checkpoint.seq, second.carrier.seq], 'the kept tail starts at the second carrier');
    await loadKeeping('b.txt');
    const third = await untilSeal('after the region compaction');
    assert.ok(!third.range.includes(second.carrier.seq) && agent.session.surface.nodes.includes(second.carrier.seq), 'the second carrier stays outside the range');
    assert.deepEqual(third.carrier.data.source.removed, [at('a.txt'), at('gone.txt'), at('c.txt')], 'the new epoch holds none of the second carrier\'s paths, so the third removes them');
    assert.deepEqual(third.carrier.data.source.paths.map(each => [each.path, each.write?.length]), [[at('b.txt'), 10]], 'and writes what the load kept');
    const postRemoval = endpoints.bodies.at(-1);

    // Bedrock: the main request after the seals, then, once the range counts a seal's steps, the auxiliary call; the endpoint refuses each with an HTTP error.
    const countedSinceCarrier = () => {
      const { session } = agent;
      const events = session.snapshotEvents();
      const nodes = session.surface.nodes;
      const after = nodes.slice(nodes.findLastIndex(seq => isCarrierEvent(events[seq])) + 1).map(seq => events[seq]);
      return new Set(after.filter(event => event.type === 'assistant/message' && event.data.message.content.length > 0).map(event => `${event.data.turn}:${event.data.step}`)).size;
    };
    agent.model.select(BEDROCK);
    const bedrockMain = await turn('the bedrock turn');
    assert.equal(bedrockMain.findLast(event => event.type === 'turn/end').data.reason.kind, 'error', 'the refused main request ends its turn');
    agent.model.select(RESPONSES);
    while (countedSinceCarrier() < SEAL_STEPS) await turn('towards the bedrock seal');
    agent.model.select(BEDROCK);
    const bedrockSeal = await turn('the bedrock sealing turn');
    agent.model.select(RESPONSES);
    const failedRecord = bedrockSeal.find(event => event.type === INNER_CALL_RECORD_TYPE);
    assert.ok(failedRecord !== undefined && !bedrockSeal.some(event => event.type === 'compaction/prune' || isCarrierEvent(event)), 'the refused summary leaves its call record and no prune or carrier: no successful seal');
    assert.deepEqual(failedRecord.data.selection, BEDROCK);
    const sealEnd = bedrockSeal.findLast(event => event.type === 'turn/end').data.reason;
    assert.equal(sealEnd.kind, 'error');
    assert.match(sealEnd.error.message, /inner seal of session .* failed: the summary stream finished with error/);
    const bedrockBodies = endpoints.bodies.filter(each => each.route === 'bedrock');
    assert.equal(bedrockBodies.length, 2, 'one body per Bedrock request, the refusal not retried');
    evidence.bedrock = bedrockBodies.map((each, index) => ({
      request: index === 0 ? 'main after the seals' : 'auxiliary', url: each.url, httpVersion: each.httpVersion,
      roles: each.body.messages.map(message => message.role).join(' '), system: each.body.system !== undefined, tools: each.body.toolConfig?.tools?.length ?? 0,
    }));
    evidence.bedrockFailure = sealEnd.error.message.replace(sessionId, '<session>');

    // A fresh context resumes the session from its own JSONL log; its follow-up turn seals again and crosses the Responses adapter.
    await ctx.sessions.flush(agent.session);
    await ctx.fiber.dispose();
    rig = await mount();
    ({ ctx, llm } = rig);
    watchDispatch(ctx);
    agent = (await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: RESPONSES })).agent;
    assert.ok(agent.session.snapshotEvents().some(event => event.seq === second.carrier.seq && isCarrierEvent(event)), 'the resumed log holds the carriers');
    const fourth = sealIn(await turn('after the resume'));
    assert.ok(fourth !== null, 'the resumed session seals at its first step');
    const resumedBodies = endpoints.bodies.slice(-2);
    assert.deepEqual(resumedBodies.map(each => each.route), ['responses', 'responses']);

    // Every body against the carriers resident when its request was dispatched: each one there once, whole, in surface order; every file handle a readable path; no synthetic result repair.
    assert.equal(dispatches.length, endpoints.bodies.length, `one body per dispatched request: ${dispatches.length} vs ${endpoints.bodies.length}`);
    const report = [];
    for (const [index, { route, body }] of endpoints.bodies.entries()) {
      const dispatch = dispatches[index];
      const texts = bodyTexts(route, body).map(each => each.text);
      const json = JSON.stringify(body);
      assert.ok(!json.includes('No result provided'), `body ${index}: no synthetic tool-result repair`);
      // A stock summary request sends its selected region, not the surface: it is recorded, not matched against the resident carriers.
      if (dispatch.purpose === 'compaction') {
        report.push({ body: index, route, request: dispatch.purpose, regionCarriers: dispatch.carriers.filter(carrier => texts.includes(carrier.text)).map(carrier => carrier.seq) });
        continue;
      }
      let last = -1;
      for (const carrier of dispatch.carriers) {
        const found = texts.indexOf(carrier.text);
        assert.ok(found > last, `body ${index} (${route} ${dispatch.purpose}): carrier ${carrier.seq} is serialized whole, after the carriers before it`);
        assert.equal(texts.lastIndexOf(carrier.text), found, `body ${index}: carrier ${carrier.seq} once`);
        last = found;
        // The adapter sends the carrier as one string, so each meaning the body keeps apart is a line of its own there: every slot line, every file handle, every saved image's sentence, and the B section after a blank line.
        const rows = texts[found].split('\n');
        for (const slot of carrier.source.slots) {
          // A slot's note may run over several lines, a user's own message kept word for word: it begins a line and ends one.
          assert.ok(`\n${texts[found]}\n`.includes(`\n${CARRIER_WORDING.slotLine(slot.seqs)}${slot.text}\n`), `body ${index}: carrier ${carrier.seq}'s slot ${slot.seqs.join(', ')} is a line of its own: ${JSON.stringify(texts[found].slice(0, 600))}`);
          for (const { file, image } of slot.attachments ?? []) {
            assert.ok(rows.includes(carrier.handles.get(file.attachmentId + file.name)), `body ${index}: the handle of ${file.name} is a line of its own`);
            if (image !== undefined) assert.ok(rows.includes(CARRIER_WORDING.imageSaved(image.name ?? image.attachmentId, CARRIER_TABLE.imageReadTool)), `body ${index}: the sentence of ${file.name} is a line of its own`);
          }
        }
        const heading = rows.indexOf(carriedNote());
        const showsLine = entry => (entry.write ?? []).some(([number]) => !(entry.omit ?? []).includes(number));
        if (carrier.source.paths.some(showsLine)) assert.ok(heading > 0, `body ${index}: carrier ${carrier.seq} has a B section`);
        if (heading >= 0) assert.ok(heading > 0 && rows[heading - 1] === '', `body ${index}: carrier ${carrier.seq}'s B section opens after a blank line`);
        // Each file with a line to show reaches the request as one block under its path, once, a line of its own, and a file with none is not named by one; the request carries no read envelope.
        for (const entry of carrier.source.paths.filter(each => (each.write ?? []).length > 0)) {
          const header = `${entry.displayPath} (total lines: ${entry.totalLines})`;
          assert.equal(rows.filter(row => row === header).length, showsLine(entry) ? 1 : 0, `body ${index}: carrier ${carrier.seq} names ${entry.displayPath} once: ${JSON.stringify(texts[found].slice(0, 600))}`);
        }
        assert.ok(!texts[found].includes('<type>file</type>'), `body ${index}: carrier ${carrier.seq} carries no read envelope`);
        for (const block of carrier.source.slots.flatMap(slot => slot.attachments ?? [])) {
          const path = handlePath(carrier.text, block.file.name);
          assert.ok(path !== undefined && existsSync(path), `body ${index}: ${block.file.name} is handed over as a readable path`);
        }
      }
      const sources = dispatch.carriers.map(carrier => carrier.source);
      report.push({
        body: index, route, request: dispatch.purpose, ...(route === 'bedrock' ? { roles: body.messages.map(message => message.role).join(' ') } : {}),
        carriers: dispatch.carriers.map((carrier, at) => ({ seq: carrier.seq, tokens: carrier.tokens, heuristicTokens: carrier.heuristicTokens, ...supersededOf(sources, at) })),
        carrierTokens: dispatch.carriers.reduce((sum, carrier) => sum + carrier.tokens, 0), heldView: dispatch.view,
      });
    }
    // The bodies the stage names: the Responses auxiliary call with a prior carrier, the main request after a seal and the follow-up after the resume; the Bedrock main and auxiliary requests.
    const named = {
      responsesAuxWithCarrier: report.find(row => row.route === 'responses' && row.request === 'inner-compaction' && row.carriers.length > 0),
      responsesBetweenSeals: report[endpoints.bodies.indexOf(betweenSeals)],
      responsesPostSeal: report[endpoints.bodies.indexOf(postSeal)],
      responsesPostRemoval: report[endpoints.bodies.indexOf(postRemoval)],
      bedrockMain: report.find(row => row.route === 'bedrock' && row.request === 'main'),
      bedrockAux: report.find(row => row.route === 'bedrock' && row.request === 'inner-compaction'),
      resumedAux: report.at(-2),
      resumedMain: report.at(-1),
    };
    for (const [name, row] of Object.entries(named)) assert.ok(row !== undefined && row.carriers.length > 0, `${name}: a body with resident carriers`);
    assert.deepEqual(named.responsesBetweenSeals.carriers.map(row => row.seq), [first.carrier.seq]);
    assert.ok(!first.carrier.data.source.paths.some(entry => entry.path === at('c.txt')), 'fixture: the resident carrier does not carry c.txt');
    assert.deepEqual(named.responsesBetweenSeals.heldView.paths[at('c.txt')], [1, 2, 3, 4, 5, 6, 7, 8], 'between the seals the held view holds the lines the accepted read added, which no resident carrier carries yet');
    assert.deepEqual(named.responsesPostSeal.carriers.map(row => row.seq), [first.carrier.seq, second.carrier.seq]);
    assert.deepEqual(named.responsesPostRemoval.carriers.map(row => row.seq), [second.carrier.seq, third.carrier.seq]);
    assert.deepEqual(named.bedrockAux.carriers.map(row => row.seq), [second.carrier.seq, third.carrier.seq]);
    assert.deepEqual(named.resumedMain.carriers.map(row => row.seq), [second.carrier.seq, third.carrier.seq, fourth.carrier.seq]);
    assert.ok(named.responsesPostSeal.carriers[0].withdrawn.length > 0 && named.responsesPostSeal.carriers[0].rewritten.length > 0, 'the old carrier whose entries a later one withdraws or rewrites is priced whole while resident');
    for (const row of [named.responsesPostRemoval, named.bedrockMain, named.bedrockAux]) assert.ok(row.carriers[0].removed.length > 0, `body ${row.body}: the old carrier whose paths a later one removes is priced whole while resident`);
    evidence.g6 = Object.fromEntries(Object.entries(named).map(([name, row]) => [name, row]));
    evidence.bodies = report.length;
    // The Responses usage carries all three input fields and its shares stay under the alert; the refused Bedrock call reported none, so its consumed record has the gap.
    evidence.innerDiagnostics = stderrLines.filter(line => line.includes('inner_')).map(line => line.replaceAll(sessionId, '<session>'));
    assert.deepEqual(evidence.innerDiagnostics, [`<session> [dsh-host] inner_usage_gap: record seq ${failedRecord.seq}: the auxiliary call reported no cacheReadTokens, cacheWriteTokens, so its uncached share is unknown`]);
    evidence.responsesHttpVersion = [...new Set(endpoints.bodies.filter(each => each.route === 'responses').map(each => each.httpVersion))];
    console.log(JSON.stringify(evidence));
    await ctx.fiber.dispose();
    await endpoints.close();
    closeStore(store);
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
