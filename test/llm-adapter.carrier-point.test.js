// The carrier cache point writers of `lib/llm-adapter/carrier-point.js` driven through `writeCarrierPoint` over payloads shaped as each wire protocol's serializer writes them: the closed result of every branch a protocol can reach, the payload an `added` result changes and the one every other result leaves alone, and the Responses switch, which only a Responses request asks. The same writers over the real pi-ai serializers are exercised in `dsh.pi-ai-carrier-cache.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCarrierPointWriter } from '../lib/llm-adapter/carrier-point.js';
import { CARRIER_RESULTS, SKIP_REASONS, isCarrierResult } from '../lib/llm-adapter/carrier-results.js';

const PREFIX = 'These summaries stand in for the earlier turns.';
const carrierOf = at => `${PREFIX}\nseq ${at}: a summary`;

// A writer over the switch `responsesBreakpoint` and the diagnostics it reports, on unless a case says otherwise.
function writerOver(responsesBreakpoint = () => true) {
  const reports = [];
  return { reports, write: createCarrierPointWriter({ report: message => reports.push(message), responsesBreakpoint }) };
}

const without = (body, key, index) => ({ ...body, [key]: body[key].filter((_, at) => at !== index) });

// ── Anthropic Messages: `cache_control` on a content block ──
const ANTHROPIC = { api: 'anthropic-messages', provider: 'sw-anthropic', id: 'fixture-claude' };
const text = value => ({ type: 'text', text: value });
const mark = () => ({ type: 'ephemeral', ttl: '1h' });
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content });
const HEAD = () => user([text('head')]);
const STEP = () => assistant([text('a step')]);
const markedTail = () => user([{ ...text('a follow-up'), cache_control: mark() }]);
const anthropic = (messages, system = [{ ...text('the system prompt'), cache_control: mark() }]) => ({ system, messages });

// ── Chat Completions: the same marker on a tool definition or a text part ──
const COMPLETIONS = { api: 'openai-completions', provider: 'sw-completions', id: 'fixture-chat' };
const tool = marked => ({ type: 'function', function: { name: 'read_file' }, ...(marked ? { cache_control: mark() } : {}) });
const completions = (messages, tools = [tool(false)]) => ({ messages: [{ role: 'system', content: 'the system prompt' }, ...messages], tools });

// ── Bedrock Converse: a standalone `cachePoint` block closing the message ──
const BEDROCK = { api: 'bedrock-converse-stream', provider: 'amazon-bedrock', id: 'anthropic.claude-fixture' };
const point = () => ({ cachePoint: { type: 'default', ttl: '1h' } });
const converse = (role, ...blocks) => ({ role, content: blocks });
const bedrock = (messages, system = [{ text: 'the system prompt' }, point()]) => ({ system, messages });

// ── OpenAI Responses: `prompt_cache_breakpoint` on an `input_text` block ──
const OFFICIAL = { api: 'openai-responses', provider: 'openai', id: 'gpt-fixture', baseUrl: 'https://api.openai.com/v1' };
const inputText = value => ({ type: 'input_text', text: value });
const item = (role, ...content) => ({ role, content });
const input = () => [item('user', inputText('head')), item('user', inputText(carrierOf(1))), item('user', inputText(carrierOf(2))), item('assistant', { type: 'output_text', text: 'a step' }), item('user', inputText('a follow-up'))];
const responses = (items, rest = {}) => ({ model: 'gpt-fixture', input: items, ...rest });
const KEYED = { apiKey: 'sk-fixture' };
const RETAINED = { prompt_cache_retention: '24h' };
const breakpointAt = (body, at) => body.input[at].content.findLast(part => part.type === 'input_text').prompt_cache_breakpoint;

// Each case is one request: `payload()` builds a fresh body, `expected` is the closed result, `check` states what an `added` result wrote, and a result of any other kind leaves the payload as it was. `reports` are the diagnostics the writer gives, each as the pattern of its text.
const CASES = [
  { label: 'anthropic-messages: the last carrier ends in a copy of the request\'s own point, and the earlier carrier and the rest of the request are left as they are',
    model: ANTHROPIC, payload: () => anthropic([HEAD(), user([text(carrierOf(1))]), user([text(carrierOf(2))]), STEP(), markedTail()]), expected: { result: 'added' },
    check: (payload, before) => {
      assert.deepEqual(payload.messages[2].content.at(-1).cache_control, mark());
      assert.notEqual(payload.messages[2].content.at(-1).cache_control, payload.messages[4].content[0].cache_control);
      assert.deepEqual(without(payload, 'messages', 2), without(before, 'messages', 2));
    } },
  { label: 'anthropic-messages: a carrier written as a string becomes one text block ending in the point',
    model: ANTHROPIC, payload: () => anthropic([HEAD(), user(carrierOf(1)), user(carrierOf(2)), STEP(), markedTail()]), expected: { result: 'added' },
    check: payload => assert.deepEqual(payload.messages[2].content, [{ ...text(carrierOf(2)), cache_control: mark() }]) },
  { label: 'anthropic-messages: the carrier the request\'s own point already ends is `native`',
    model: ANTHROPIC, payload: () => anthropic([HEAD(), user([text(carrierOf(1))]), user([{ ...text(carrierOf(2)), cache_control: mark() }])]), expected: { result: 'native' } },
  { label: 'anthropic-messages: a request the serializer wrote no point for has none to follow',
    model: ANTHROPIC, payload: () => anthropic([HEAD(), user([text(carrierOf(1))]), STEP(), user([text('a follow-up')])], [text('the system prompt')]), expected: { result: 'skipped', reason: 'no-native-point' } },
  { label: 'anthropic-messages: a request whose route already sends every point it may carry is given none, and one report names the route',
    model: ANTHROPIC, reports: [/"sw-anthropic\/fixture-claude" \(anthropic-messages\) already sends 4 cache points/],
    payload: () => anthropic([HEAD(), user([text(carrierOf(1))]), STEP(), user([{ ...text('a'), cache_control: mark() }, { ...text('b'), cache_control: mark() }])], [{ ...text('first'), cache_control: mark() }, { ...text('second'), cache_control: mark() }]),
    expected: { result: 'skipped', reason: 'points-full' } },
  { label: 'anthropic-messages: a request holding no carrier is skipped',
    model: ANTHROPIC, payload: () => anthropic([HEAD(), STEP(), markedTail()]), expected: { result: 'skipped', reason: 'no-carrier' } },
  { label: 'anthropic-messages: a carrier is told by the opening of its text alone, and only a user message is one',
    model: ANTHROPIC, payload: () => anthropic([user([text(`quoted: ${carrierOf(1)}`)]), assistant([text(carrierOf(2))]), markedTail()]), expected: { result: 'skipped', reason: 'no-carrier' } },
  { label: 'anthropic-messages: a request whose messages are no list is unsupported',
    model: ANTHROPIC, payload: () => ({ system: [], messages: 'not a list' }), expected: { result: 'skipped', reason: 'unsupported' } },

  { label: 'openai-completions: a carrier of string content becomes one text part ending in a copy of the point the tail text part has',
    model: COMPLETIONS, payload: () => completions([user('head'), user(carrierOf(1)), user(carrierOf(2)), assistant('a step'), user([{ ...text('a follow-up'), cache_control: mark() }])]), expected: { result: 'added' },
    check: (payload) => {
      assert.deepEqual(payload.messages[3].content, [{ ...text(carrierOf(2)), cache_control: mark() }]);
      assert.equal(payload.messages[2].content, carrierOf(1));
    } },
  { label: 'openai-completions: the point is copied from a tool definition when no message part has one, and goes to the carrier\'s last text part',
    model: COMPLETIONS, payload: () => completions([user('head'), user([text(carrierOf(1)), { type: 'image_url', image_url: { url: 'file:///fixture.png' } }]), assistant('a step'), user('a follow-up')], [tool(true)]), expected: { result: 'added' },
    check: payload => assert.deepEqual(payload.messages[2].content, [{ ...text(carrierOf(1)), cache_control: mark() }, { type: 'image_url', image_url: { url: 'file:///fixture.png' } }]) },
  { label: 'openai-completions: the carrier the request\'s own point already ends is `native`',
    model: COMPLETIONS, payload: () => completions([user('head'), user([{ ...text(carrierOf(1)), cache_control: mark() }])]), expected: { result: 'native' } },
  { label: 'openai-completions: an endpoint whose serializer wrote no marker has none to follow',
    model: COMPLETIONS, payload: () => completions([user('head'), user(carrierOf(1)), assistant('a step'), user('a follow-up')]), expected: { result: 'skipped', reason: 'no-native-point' } },
  { label: 'openai-completions: a request whose route already sends every point it may carry is given none, and one report names the route',
    model: COMPLETIONS, reports: [/"sw-completions\/fixture-chat" \(openai-completions\) already sends 4 cache points/],
    payload: () => completions([user('head'), user(carrierOf(1)), user([{ ...text('a'), cache_control: mark() }, { ...text('b'), cache_control: mark() }])], [tool(true), tool(true)]),
    expected: { result: 'skipped', reason: 'points-full' } },
  { label: 'openai-completions: a request holding no carrier is skipped',
    model: COMPLETIONS, payload: () => completions([user('head'), assistant('a step'), user([{ ...text('a follow-up'), cache_control: mark() }])]), expected: { result: 'skipped', reason: 'no-carrier' } },
  { label: 'openai-completions: a request whose messages are no list is unsupported',
    model: COMPLETIONS, payload: () => ({ messages: {}, tools: [] }), expected: { result: 'skipped', reason: 'unsupported' } },

  { label: 'bedrock-converse-stream: a standalone point block closes the last carrier, a copy of the first point the request holds, the carrier\'s text read as its text blocks joined',
    model: BEDROCK, payload: () => bedrock([converse('user', { text: 'head' }), converse('user', { text: carrierOf(1) }), converse('user', { text: PREFIX }, { text: '\nseq 2: a summary' }), converse('assistant', { text: 'a step' }), converse('user', { text: 'a follow-up' }, point())]),
    expected: { result: 'added' },
    check: (payload, before) => {
      assert.deepEqual(payload.messages[2].content, [{ text: PREFIX }, { text: '\nseq 2: a summary' }, point()]);
      assert.notEqual(payload.messages[2].content.at(-1).cachePoint, payload.system[1].cachePoint);
      assert.deepEqual(without(payload, 'messages', 2), without(before, 'messages', 2));
    } },
  { label: 'bedrock-converse-stream: the carrier the request\'s own point block already closes is `native`',
    model: BEDROCK, payload: () => bedrock([converse('user', { text: 'head' }), converse('user', { text: carrierOf(1) }, point())]), expected: { result: 'native' } },
  { label: 'bedrock-converse-stream: a request holding no point block has none to follow',
    model: BEDROCK, payload: () => bedrock([converse('user', { text: 'head' }), converse('user', { text: carrierOf(1) }), converse('assistant', { text: 'a step' })], [{ text: 'the system prompt' }]), expected: { result: 'skipped', reason: 'no-native-point' } },
  { label: 'bedrock-converse-stream: a request holding no carrier is skipped',
    model: BEDROCK, payload: () => bedrock([converse('user', { text: 'head' }), converse('assistant', { text: 'a step' }), converse('user', { text: 'a follow-up' }, point())]), expected: { result: 'skipped', reason: 'no-carrier' } },
  { label: 'bedrock-converse-stream: a request whose messages are no list is unsupported',
    model: BEDROCK, payload: () => ({ system: [], messages: null }), expected: { result: 'skipped', reason: 'unsupported' } },

  { label: 'openai-responses: the last carrier\'s last input_text block takes the explicit breakpoint and nothing else of the request changes',
    model: OFFICIAL, options: KEYED, payload: () => responses(input()), expected: { result: 'added' },
    check: (payload, before) => {
      assert.deepEqual(breakpointAt(payload, 2), { mode: 'explicit' });
      assert.deepEqual(Object.keys(payload).sort(), ['input', 'model']);
      assert.deepEqual(without(payload, 'input', 2), without(before, 'input', 2));
      assert.deepEqual(payload.input[2].content, [{ ...inputText(carrierOf(2)), prompt_cache_breakpoint: { mode: 'explicit' } }]);
    } },
  { label: 'openai-responses: a carrier ending in a block of another kind takes the breakpoint on its last input_text block',
    model: OFFICIAL, options: KEYED, payload: () => responses([item('user', inputText('head')), item('user', inputText(carrierOf(1)), { type: 'input_image', image_url: 'file:///fixture.png' }), item('assistant', { type: 'output_text', text: 'a step' })]), expected: { result: 'added' },
    check: payload => assert.deepEqual(payload.input[1].content, [{ ...inputText(carrierOf(1)), prompt_cache_breakpoint: { mode: 'explicit' } }, { type: 'input_image', image_url: 'file:///fixture.png' }]) },
  ...[['declares nothing', undefined], ['declares the capability false', { supportsExplicitPromptCacheMode: false }], ['declares the capability', { supportsExplicitPromptCacheMode: true }]].map(([declares, compat]) => ({
    label: `openai-responses: a model that ${declares} is given the breakpoint all the same`,
    model: { ...OFFICIAL, compat }, options: KEYED, payload: () => responses(input()), expected: { result: 'added' }, check: payload => assert.deepEqual(breakpointAt(payload, 2), { mode: 'explicit' }),
  })),
  { label: 'openai-responses: a long route\'s retention gives way to the lifetime option in the step that writes the breakpoint',
    model: OFFICIAL, options: KEYED, payload: () => responses(input(), RETAINED), expected: { result: 'added' },
    check: (payload) => {
      assert.deepEqual(breakpointAt(payload, 2), { mode: 'explicit' });
      assert.equal(Object.hasOwn(payload, 'prompt_cache_retention'), false);
      assert.deepEqual(payload.prompt_cache_options, { ttl: '30m' });
    } },
  { label: 'openai-responses: the options a payload already holds stay when the breakpoint is written',
    model: OFFICIAL, options: KEYED, payload: () => responses(input(), { prompt_cache_options: { ttl: '30m' } }), expected: { result: 'added' },
    check: (payload) => {
      assert.deepEqual(breakpointAt(payload, 2), { mode: 'explicit' });
      assert.deepEqual(payload.prompt_cache_options, { ttl: '30m' });
    } },
  ...[['a gateway with a key that is no `sk-` key', { ...OFFICIAL, baseUrl: 'https://gateway.example/v1' }, { apiKey: 'gateway-token' }],
    ['the official endpoint under an API key', OFFICIAL, KEYED],
    ['the official endpoint with no key stated', OFFICIAL, undefined]].map(([lane, model, options]) => ({
    label: `openai-responses: ${lane} is no ChatGPT sign-in lane and is given the breakpoint`,
    model, options, payload: () => responses(input(), RETAINED), expected: { result: 'added' }, check: payload => assert.deepEqual(breakpointAt(payload, 2), { mode: 'explicit' }),
  })),
  { label: 'openai-responses: the carrier that is the last input item is `native`, the latest message\'s implicit breakpoint ending it, and the retention stays',
    model: OFFICIAL, options: KEYED, payload: () => responses(input().slice(0, 3), RETAINED), expected: { result: 'native' } },
  { label: 'openai-responses: a request sent with caching off has none to follow, whatever it holds',
    model: OFFICIAL, options: { ...KEYED, cacheRetention: 'none' }, payload: () => responses(input(), RETAINED), expected: { result: 'skipped', reason: 'no-native-point' } },
  { label: 'openai-responses: a request holding no carrier is skipped',
    model: OFFICIAL, options: KEYED, payload: () => responses([item('user', inputText('head')), item('assistant', { type: 'output_text', text: 'a step' }), item('user', inputText('a follow-up'))], RETAINED), expected: { result: 'skipped', reason: 'no-carrier' } },
  { label: 'openai-responses: the ChatGPT sign-in lane, the official endpoint reached with a key that is no `sk-` key, is unsupported and keeps its retention',
    model: OFFICIAL, options: { apiKey: 'chatgpt-session-token' }, payload: () => responses(input(), RETAINED), expected: { result: 'skipped', reason: 'unsupported' } },
  { label: 'openai-responses: an input that is no list is unsupported',
    model: OFFICIAL, options: KEYED, payload: () => responses('a prompt'), expected: { result: 'skipped', reason: 'unsupported' } },
  { label: 'openai-responses: with the switch off a request is `responses-off` whatever it holds, one that would be unsupported included',
    model: OFFICIAL, options: KEYED, responsesBreakpoint: () => false, payload: () => responses('a prompt', RETAINED), expected: { result: 'skipped', reason: 'responses-off' } },
  { label: 'openai-responses: a switch that answers anything but `true` is off, and silently',
    model: OFFICIAL, options: KEYED, responsesBreakpoint: () => 'yes', payload: () => responses(input(), RETAINED), expected: { result: 'skipped', reason: 'responses-off' } },
  { label: 'openai-responses: a switch that answers nothing is off, and silently',
    model: OFFICIAL, options: KEYED, responsesBreakpoint: () => undefined, payload: () => responses(input(), RETAINED), expected: { result: 'skipped', reason: 'responses-off' } },
  { label: 'openai-responses: a switch that cannot answer is off, with one report',
    model: OFFICIAL, options: KEYED, responsesBreakpoint: () => { throw new Error('the settings are gone'); }, reports: [/the Responses breakpoint setting could not be read/],
    payload: () => responses(input(), RETAINED), expected: { result: 'skipped', reason: 'responses-off' } },

  ...['azure-openai-responses', 'openai-codex-responses', 'mistral-conversations', 'google-generative-ai', undefined].map(api => ({
    label: `${api ?? 'no protocol'}: a protocol no writer serves is unsupported whatever the payload holds`,
    model: { ...OFFICIAL, api }, options: KEYED, payload: () => responses(input()), expected: { result: 'skipped', reason: 'unsupported' },
  })),
];

for (const { label, model, options, responsesBreakpoint, payload: build, expected, reports = [], check } of CASES) {
  test(label, () => {
    const { write, reports: reported } = writerOver(responsesBreakpoint);
    const payload = build();
    const before = structuredClone(payload);
    assert.deepEqual(write({ prefix: PREFIX, payload, model, options }), expected);
    if (expected.result === 'added') check(payload, before);
    else assert.deepEqual(payload, before, 'only an `added` result changes the payload');
    assert.equal(reported.length, reports.length, JSON.stringify(reported));
    reports.forEach((pattern, at) => assert.match(reported[at], pattern));
  });
}

test('the writer produces only the closed vocabulary, and every value of it is produced by some branch', () => {
  const produced = CASES.map(({ model, options, responsesBreakpoint, payload }) => writerOver(responsesBreakpoint).write({ prefix: PREFIX, payload: payload(), model, options }));
  for (const result of produced) assert.equal(isCarrierResult(result), true, JSON.stringify(result));
  assert.deepEqual([...new Set(produced.map(({ result }) => result))].sort(), [...CARRIER_RESULTS].sort());
  assert.deepEqual([...new Set(produced.filter(({ result }) => result === 'skipped').map(({ reason }) => reason))].sort(), [...SKIP_REASONS].sort());
});

test('the writer asks the Responses switch once for each Responses request and not at all for any other protocol, an unreadable one included', () => {
  let reads = 0;
  const { write, reports } = writerOver(() => { reads += 1; throw new Error('the settings are gone'); });
  const others = [[ANTHROPIC, anthropic([HEAD(), user([text(carrierOf(1))]), markedTail()])], [COMPLETIONS, completions([user(carrierOf(1))])], [BEDROCK, bedrock([converse('user', { text: carrierOf(1) })])], [{ ...OFFICIAL, api: 'azure-openai-responses' }, responses(input())]];
  for (const [model, payload] of others) write({ prefix: PREFIX, payload, model });
  assert.equal(reads, 0);
  assert.deepEqual(reports, []);
  write({ prefix: PREFIX, payload: responses(input()), model: OFFICIAL, options: KEYED });
  assert.equal(reads, 1);
  write({ prefix: PREFIX, payload: responses(input()), model: OFFICIAL, options: KEYED });
  assert.equal(reads, 2, 'the next request asks again');
  assert.equal(reports.length, 2);
});

test('the writer reads the prefix it is handed at each request: a writer holds none of its own', () => {
  const { write } = writerOver();
  const request = () => anthropic([user([text('Another opening.\nseq 1')]), STEP(), markedTail()]);
  assert.deepEqual(write({ prefix: PREFIX, payload: request(), model: ANTHROPIC }), { result: 'skipped', reason: 'no-carrier' });
  const payload = request();
  assert.deepEqual(write({ prefix: 'Another opening.', payload, model: ANTHROPIC }), { result: 'added' });
  assert.deepEqual(payload.messages[0].content.at(-1).cache_control, mark());
});

// A request of each protocol whose last user message an empty prefix would take for the carrier.
const plainRequests = [
  [ANTHROPIC, () => anthropic([HEAD(), STEP(), user([text('a follow-up')])]), undefined],
  [COMPLETIONS, () => completions([user('head'), user('a follow-up')], [tool(true)]), undefined],
  [BEDROCK, () => bedrock([converse('user', { text: 'head' }), converse('user', { text: 'a follow-up' })]), undefined],
  [OFFICIAL, () => responses([item('user', inputText('head')), item('user', inputText('a follow-up')), item('assistant', { type: 'output_text', text: 'a step' })]), KEYED],
];

// What a prefix the writer cannot use does to each protocol's request: the payload as it was, the result `unsupported` and as many reports as `reports`.
function assertNoPoint(prefixes, reports) {
  for (const prefix of prefixes) {
    for (const [model, payload, options] of plainRequests) {
      const written = writerOver();
      const body = payload();
      assert.deepEqual(written.write({ prefix, payload: body, model, options }), { result: 'skipped', reason: 'unsupported' }, `${model.api}, ${String(prefix)}`);
      assert.deepEqual(body, payload(), `${model.api}, ${String(prefix)}: the payload is as it was`);
      assert.equal(written.reports.length, reports, `${model.api}, ${String(prefix)}`);
    }
  }
}

test('a request handed a prefix that is none is given no point on any protocol, with no report', () => {
  assertNoPoint([undefined], 0);
});

test('a request handed a prefix that is given and no usable text, null, an empty text or a value that is no text, is given no point on any protocol: one report, the payload as it was and the result `unsupported`, where an empty prefix would have matched every user message', () => {
  assertNoPoint([null, '', 42, {}], 1);
});
