// The provider wrapper of the carrier cache (`dsh/src/carrier-cache.js`), the pi-ai injection of the carrier point writer (`lib/llm-adapter/carrier-point.js`), driven through its public method, `decorateProfiles`, over a pi-ai provider double that records what `streamSimple` is called with: how a provider is wrapped, the order of the caller's `onPayload` hook, the writer and `observe`, what the hook answers and what `observe` is told. The payload shapes the writers read are `llm-adapter.carrier-point.test.js`'s, and the same writers over the real pi-ai serializers are exercised in `dsh.pi-ai-carrier-cache.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCarrierCache } from '../dsh/src/carrier-cache.js';
import { isCarrierResult } from '../lib/llm-adapter/carrier-results.js';
import { assembleCarrierSource, carrierPrefixOf, renderCarrier } from '../lib/inner-seal/carrier.js';
import { CARRIER_TABLE } from '../lib/harness/dsh/carrier-table.js';

const PREFIX = 'These summaries stand in for the earlier turns.';

// A route's pi-ai provider: the members the wrapper must leave alone, and a `streamSimple` that answers its receiver and what it was handed.
function providerDouble() {
  const provider = {
    id: 'openai', name: 'OpenAI', auth: { apiKey: { name: 'fixture' } }, getModels() { return ['gpt-fixture']; },
    streamSimple(...args) { return { receiver: this, args }; },
  };
  return provider;
}

// `carrierPrefix` is what the host answers at each call of the hook, the prefix of `PREFIX` unless a test says otherwise; `responsesBreakpoint` is the owner's switch the wrapper hands the writer, on unless a test says otherwise; `observe` is told each result.
const decorated = (provider, { report = () => {}, observe = () => {}, responsesBreakpoint = () => true, carrierPrefix = () => PREFIX } = {}) => {
  const { decorateProfiles } = createCarrierCache({ carrierPrefix, report, observe, responsesBreakpoint });
  return decorateProfiles(new Map([['openai', { displayName: 'OpenAI', piProvider: provider }], ['bare', { displayName: 'Bare' }]]));
};

const responsesPayload = () => ({
  model: 'gpt-fixture',
  input: [
    { role: 'user', content: [{ type: 'input_text', text: `${PREFIX}\nseq 1: a summary` }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'a step' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'a follow-up' }] },
  ],
});
const EXPLICIT_MODEL = { api: 'openai-responses', provider: 'openai', id: 'gpt-fixture', baseUrl: 'https://api.openai.com/v1', compat: { supportsExplicitPromptCacheMode: true } };
const KEYED = { apiKey: 'sk-fixture' };

// The hook the wrapped provider hands pi-ai for one request with `options`.
function hookFor(wrapped, options) {
  const { args } = wrapped.streamSimple(EXPLICIT_MODEL, { messages: [] }, options);
  return args[2].onPayload;
}

test('a route that resolved no pi-ai provider keeps its profile, and every other member of a wrapped provider is the original\'s', () => {
  const provider = providerDouble();
  const profiles = decorated(provider);
  assert.deepEqual(profiles.get('bare'), { displayName: 'Bare' });
  const wrapped = profiles.get('openai').piProvider;
  assert.equal(profiles.get('openai').displayName, 'OpenAI');
  assert.equal(wrapped.id, 'openai');
  assert.equal(wrapped.auth, provider.auth);
  assert.deepEqual(wrapped.getModels(), ['gpt-fixture']);
});

test('the original provider runs the call as its own receiver, handed the model, the context and the options it was given besides the hook', () => {
  const provider = providerDouble();
  const wrapped = decorated(provider).get('openai').piProvider;
  const context = { messages: [] };
  const options = { apiKey: 'sk-fixture', cacheRetention: 'short' };
  const { receiver, args } = wrapped.streamSimple(EXPLICIT_MODEL, context, options);
  assert.equal(receiver, provider);
  assert.equal(args[0], EXPLICIT_MODEL);
  assert.equal(args[1], context);
  const { onPayload, ...rest } = args[2];
  assert.equal(typeof onPayload, 'function');
  assert.deepEqual(rest, options);
});

test('a hook the caller set runs first: its replacement payload is the one the point is written to and the one the hook answers, and a request given none answers what the caller\'s hook answered', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  const seen = [];
  const replacement = responsesPayload();
  const earlier = (payload, model) => { seen.push([payload, model]); return replacement; };
  const original = responsesPayload();
  const hook = hookFor(wrapped, { ...KEYED, onPayload: earlier });
  assert.equal(await hook(original, EXPLICIT_MODEL), replacement);
  assert.deepEqual(seen, [[original, EXPLICIT_MODEL]]);
  assert.deepEqual(replacement.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(original.input[0].content[0].prompt_cache_breakpoint, undefined);

  const none = () => ({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'no carrier here' }] }, { role: 'assistant', content: [] }] });
  assert.equal(await hookFor(wrapped, { ...KEYED, onPayload: () => undefined })(none(), EXPLICIT_MODEL), undefined);
  assert.equal(await hookFor(wrapped, KEYED)(none(), EXPLICIT_MODEL), undefined);
  const kept = none();
  assert.equal(await hookFor(wrapped, { ...KEYED, onPayload: () => kept })(none(), EXPLICIT_MODEL), kept);
});

test('a throw from the caller\'s hook reaches pi-ai as it is', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  const hook = hookFor(wrapped, { ...KEYED, onPayload: () => { throw new Error('the caller\'s hook failed'); } });
  await assert.rejects(async () => hook(responsesPayload(), EXPLICIT_MODEL), /the caller's hook failed/);
});

test('`observe` is told the closed result of each hook call after the caller\'s hook and the writer ran, and only an `added` result gives the payload back', async () => {
  const log = [];
  const wrapped = decorated(providerDouble(), { observe: result => log.push(result) }).get('openai').piProvider;
  const earlier = () => { log.push('earlier'); };
  const onlyCarrier = { ...responsesPayload(), input: responsesPayload().input.slice(0, 1) };
  const noCarrier = { ...responsesPayload(), input: responsesPayload().input.slice(1) };
  const added = responsesPayload();
  assert.equal(await hookFor(wrapped, { ...KEYED, onPayload: earlier })(added, EXPLICIT_MODEL), added);
  assert.equal(await hookFor(wrapped, KEYED)(onlyCarrier, EXPLICIT_MODEL), undefined);
  assert.equal(await hookFor(wrapped, KEYED)(noCarrier, EXPLICIT_MODEL), undefined);
  assert.equal(await hookFor(wrapped, KEYED)(responsesPayload(), { ...EXPLICIT_MODEL, api: 'google-generative-ai' }), undefined);
  assert.deepEqual(log, [
    'earlier', { result: 'added' },
    { result: 'native' },
    { result: 'skipped', reason: 'no-carrier' },
    { result: 'skipped', reason: 'unsupported' },
  ]);
  assert.ok(log.filter(entry => typeof entry === 'object').every(isCarrierResult));
});

test('an `observe` that throws is one report and leaves the request as the writer made it', async () => {
  const reports = [];
  const wrapped = decorated(providerDouble(), { report: message => reports.push(message), observe: () => { throw new Error('the evidence store is gone'); } }).get('openai').piProvider;
  const added = responsesPayload();
  assert.equal(await hookFor(wrapped, KEYED)(added, EXPLICIT_MODEL), added);
  assert.deepEqual(added.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(reports.length, 1);
  assert.match(reports[0], /cache evidence of a request could not be recorded/);
  const unchanged = responsesPayload();
  assert.equal(await hookFor(wrapped, { ...KEYED, cacheRetention: 'none' })(unchanged, EXPLICIT_MODEL), undefined);
  assert.deepEqual(unchanged, responsesPayload());
  assert.equal(reports.length, 2);
});

test('the owner\'s switch and the diagnostic sink are the writer\'s: an off switch is `responses-off` and an unreadable one is off with one report', async () => {
  const results = [];
  const reports = [];
  const observe = result => results.push(result);
  const report = message => reports.push(message);
  const off = decorated(providerDouble(), { observe, report, responsesBreakpoint: () => false }).get('openai').piProvider;
  const payload = responsesPayload();
  assert.equal(await hookFor(off, KEYED)(payload, EXPLICIT_MODEL), undefined);
  assert.deepEqual(payload, responsesPayload());
  const unreadable = decorated(providerDouble(), { observe, report, responsesBreakpoint: () => { throw new Error('the settings are gone'); } }).get('openai').piProvider;
  assert.equal(await hookFor(unreadable, KEYED)(responsesPayload(), EXPLICIT_MODEL), undefined);
  assert.deepEqual(results, [{ result: 'skipped', reason: 'responses-off' }, { result: 'skipped', reason: 'responses-off' }]);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Responses breakpoint setting could not be read/);
});

test('the prefix is asked of the host at each call of the hook, so a carrier is told by what the host answers then', async () => {
  let prefix = PREFIX;
  const asked = [];
  const wrapped = decorated(providerDouble(), { carrierPrefix: () => { asked.push(prefix); return prefix; } }).get('openai').piProvider;
  const first = responsesPayload();
  assert.equal(await hookFor(wrapped, KEYED)(first, EXPLICIT_MODEL), first);
  prefix = 'A reworded opening.';
  const second = responsesPayload();
  assert.equal(await hookFor(wrapped, KEYED)(second, EXPLICIT_MODEL), undefined, 'a carrier the host no longer opens with is none');
  assert.deepEqual(second, responsesPayload());
  const reworded = responsesPayload();
  reworded.input[0].content[0].text = `${prefix}\nseq 1: a summary`;
  assert.equal(await hookFor(wrapped, KEYED)(reworded, EXPLICIT_MODEL), reworded);
  assert.deepEqual(asked, [PREFIX, 'A reworded opening.', 'A reworded opening.']);
});

test('a carrier whose user\'s own text follows its reminder is told by its first block and given the point at the end of its message, after that text', async () => {
  const source = assembleCarrierSource({
    slots: [{ seqs: [4] }, { seqs: [5], step: { turn: 1, step: 1 } }], summaries: ['user: Stop and wait.', 'A note.'], questions: [[], []], attachments: [[], []],
    verbatimSeqs: [4], changes: { paths: [] }, state: null,
  });
  const blocks = renderCarrier(source, CARRIER_TABLE);
  assert.ok(blocks.length > 1, 'the user\'s text is a block of its own');
  const payload = {
    model: 'gpt-fixture',
    input: [
      { role: 'user', content: blocks.map(({ text }) => ({ type: 'input_text', text })) },
      { role: 'assistant', content: [{ type: 'output_text', text: 'a step' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'a follow-up' }] },
    ],
  };
  const results = [];
  const wrapped = decorated(providerDouble(), { carrierPrefix: () => carrierPrefixOf(CARRIER_TABLE), observe: result => results.push(result) }).get('openai').piProvider;
  assert.equal(await hookFor(wrapped, KEYED)(payload, EXPLICIT_MODEL), payload);
  assert.deepEqual(results, [{ result: 'added' }]);
  assert.deepEqual(payload.input[0].content.map(part => part.prompt_cache_breakpoint !== undefined), blocks.map((_, at) => at === blocks.length - 1), 'the point is on the last block alone');
});

// Each result and report of two requests sent through a wrapper whose host answers `carrierPrefix`; the payload of each is the serializer's.
async function twoRequestsOver(carrierPrefix) {
  const results = [];
  const reports = [];
  const wrapped = decorated(providerDouble(), { carrierPrefix, observe: result => results.push(result), report: message => reports.push(message) }).get('openai').piProvider;
  for (let at = 0; at < 2; at += 1) {
    const payload = responsesPayload();
    assert.equal(await hookFor(wrapped, KEYED)(payload, EXPLICIT_MODEL), undefined);
    assert.deepEqual(payload, responsesPayload(), 'the payload is the serializer\'s');
  }
  return { results, reports };
}

test('a host that answers no prefix leaves the request as the serializer wrote it with the result `unsupported` and no report: a service the host does not provide is not a failure', async () => {
  const { results, reports } = await twoRequestsOver(() => undefined);
  assert.deepEqual(results, [{ result: 'skipped', reason: 'unsupported' }, { result: 'skipped', reason: 'unsupported' }]);
  assert.deepEqual(reports, []);
});

test('a host that answers a prefix that is no text, or that throws, leaves the request as the serializer wrote it with the result `unsupported` and one report for each request', async () => {
  const answers = { 'an answer that is no text': () => 42, 'an empty text': () => '', 'a throw': () => { throw new Error('the host is gone'); } };
  for (const [why, carrierPrefix] of Object.entries(answers)) {
    const { results, reports } = await twoRequestsOver(carrierPrefix);
    assert.deepEqual(results, [{ result: 'skipped', reason: 'unsupported' }, { result: 'skipped', reason: 'unsupported' }], why);
    assert.equal(reports.length, 2, `${why}: one report for each request`);
  }
});
