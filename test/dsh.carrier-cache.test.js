// The provider wrapper of the carrier cache (`dsh/src/carrier-cache.js`) driven through its public method, `decorateProfiles`, over a pi-ai provider double that records what `streamSimple` is called with: the contract of the wrapper itself and the one rule no loopback endpoint can show, the ChatGPT sign-in lane, which exists only at `api.openai.com`. The payload shapes the writers read are exercised over the real pi-ai serializers in `dsh.pi-ai-carrier-cache.test.js`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCarrierCache } from '../dsh/src/carrier-cache.js';

const PREFIX = 'These summaries stand in for the earlier turns.';

// A route's pi-ai provider: the members the wrapper must leave alone, and a `streamSimple` that answers its receiver and what it was handed.
function providerDouble() {
  const provider = {
    id: 'openai', name: 'OpenAI', auth: { apiKey: { name: 'fixture' } }, getModels() { return ['gpt-fixture']; },
    streamSimple(...args) { return { receiver: this, args }; },
  };
  return provider;
}

// `responsesBreakpoint` is the owner's switch the wrapper reads at each request, on unless a test says otherwise.
const decorated = (provider, report = () => {}, responsesBreakpoint = () => true) => {
  const { decorateProfiles } = createCarrierCache({ carrierPrefix: PREFIX, report, responsesBreakpoint });
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

test('a hook the caller set runs first: its replacement payload is the one the breakpoint is written to, and a request with no carrier answers what the hook answered', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  const seen = [];
  const replacement = responsesPayload();
  const earlier = (payload, model) => { seen.push([payload, model]); return replacement; };
  const original = responsesPayload();
  const hook = hookFor(wrapped, { apiKey: 'sk-fixture', onPayload: earlier });
  assert.equal(await hook(original, EXPLICIT_MODEL), replacement);
  assert.deepEqual(seen, [[original, EXPLICIT_MODEL]]);
  assert.deepEqual(replacement.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(original.input[0].content[0].prompt_cache_breakpoint, undefined);

  const none = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'no carrier here' }] }, { role: 'assistant', content: [] }] };
  assert.equal(await hookFor(wrapped, { apiKey: 'sk-fixture', onPayload: () => undefined })(none, EXPLICIT_MODEL), undefined);
  assert.equal(await hookFor(wrapped, { apiKey: 'sk-fixture' })(none, EXPLICIT_MODEL), undefined);
});

test('a throw from the caller\'s hook reaches pi-ai as it is', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  const hook = hookFor(wrapped, { apiKey: 'sk-fixture', onPayload: () => { throw new Error('the caller\'s hook failed'); } });
  await assert.rejects(async () => hook(responsesPayload(), EXPLICIT_MODEL), /the caller's hook failed/);
});

test('the ChatGPT sign-in lane, an official OpenAI endpoint reached with a key that is no `sk-` key, gets no breakpoint and none of the options that go with one, with the switch on and whatever its model declares, where the same request under an API key does', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  const signedIn = responsesPayload();
  assert.equal(await hookFor(wrapped, { apiKey: 'chatgpt-session-token' })(signedIn, EXPLICIT_MODEL), undefined);
  assert.deepEqual(signedIn, responsesPayload());
  const plain = { ...EXPLICIT_MODEL, compat: undefined };
  const retained = { ...responsesPayload(), prompt_cache_retention: '24h' };
  assert.equal(await hookFor(wrapped, { apiKey: 'chatgpt-session-token' })(retained, plain), undefined);
  assert.deepEqual(retained, { ...responsesPayload(), prompt_cache_retention: '24h' });
  const keyed = responsesPayload();
  assert.equal(await hookFor(wrapped, { apiKey: 'sk-fixture' })(keyed, EXPLICIT_MODEL), keyed);
  assert.deepEqual(keyed.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  // Another endpoint with such a key is not that lane.
  const gateway = responsesPayload();
  assert.equal(await hookFor(wrapped, { apiKey: 'gateway-token' })(gateway, { ...EXPLICIT_MODEL, baseUrl: 'https://gateway.example/v1' }), gateway);
});

test('a Responses request is given its breakpoint whatever its model declares about explicit prompt-cache mode, nothing or `false` as well, and the model reaches pi-ai as the caller made it', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  for (const compat of [undefined, { supportsExplicitPromptCacheMode: false }]) {
    const model = { ...EXPLICIT_MODEL, compat };
    const payload = responsesPayload();
    assert.equal(await hookFor(wrapped, { apiKey: 'sk-fixture' })(payload, model), payload, JSON.stringify(compat));
    assert.deepEqual(payload.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' }, JSON.stringify(compat));
    const { args: [handed] } = wrapped.streamSimple(model, { messages: [] }, { apiKey: 'sk-fixture' });
    assert.equal(handed, model, JSON.stringify(compat));
  }
});

test('the options that go with the breakpoint are written in the same step as the breakpoint and in no other: a long route\'s retention gives way to its lifetime option when the request gets the breakpoint, and a request that gets none keeps its payload whole whatever its retention', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  const long = () => ({ ...responsesPayload(), prompt_cache_retention: '24h' });
  const keyed = { apiKey: 'sk-fixture' };
  const given = long();
  assert.equal(await hookFor(wrapped, keyed)(given, EXPLICIT_MODEL), given);
  assert.deepEqual(given.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
  assert.equal(Object.hasOwn(given, 'prompt_cache_retention'), false);
  assert.deepEqual(given.prompt_cache_options, { ttl: '30m' });
  // A short route has neither to give way, and the options of a payload that already holds them stay.
  const short = responsesPayload();
  await hookFor(wrapped, keyed)(short, EXPLICIT_MODEL);
  assert.deepEqual(Object.keys(short).sort(), ['input', 'model']);
  const declared = { ...responsesPayload(), prompt_cache_options: { ttl: '30m' } };
  await hookFor(wrapped, keyed)(declared, EXPLICIT_MODEL);
  assert.deepEqual(declared.prompt_cache_options, { ttl: '30m' });
  // Each way a request is left without a breakpoint leaves its payload as it came: the carrier ends the request, none is in it, caching is off, the switch is off.
  const tail = { ...long(), input: responsesPayload().input.slice(0, 1) };
  const noCarrier = { ...long(), input: responsesPayload().input.slice(1) };
  const off = decorated(providerDouble(), () => {}, () => false).get('openai').piProvider;
  const cases = [
    ['the carrier is the last item', tail, hookFor(wrapped, keyed)],
    ['no carrier', noCarrier, hookFor(wrapped, keyed)],
    ['caching off', long(), hookFor(wrapped, { ...keyed, cacheRetention: 'none' })],
    ['the switch off', long(), hookFor(off, keyed)],
  ];
  for (const [label, payload, hook] of cases) {
    const before = structuredClone(payload);
    assert.equal(await hook(payload, EXPLICIT_MODEL), undefined, label);
    assert.deepEqual(payload, before, label);
  }
});

test('a request whose protocol no writer serves, the other Responses protocols and the Codex lane among them, reaches pi-ai unchanged whatever its payload holds', async () => {
  const wrapped = decorated(providerDouble()).get('openai').piProvider;
  for (const api of ['azure-openai-responses', 'openai-codex-responses', 'mistral-conversations', 'google-generative-ai']) {
    const payload = responsesPayload();
    const model = { ...EXPLICIT_MODEL, api, compat: undefined };
    assert.equal(await hookFor(wrapped, { apiKey: 'sk-fixture' })(payload, { ...EXPLICIT_MODEL, api }), undefined, api);
    assert.deepEqual(payload, responsesPayload(), api);
    // With the switch on, the model of such a request reaches pi-ai as the caller made it.
    const { args: [handed] } = wrapped.streamSimple(model, { messages: [] }, { apiKey: 'sk-fixture' });
    assert.equal(handed, model, api);
  }
});
