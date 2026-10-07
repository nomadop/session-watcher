// The host's model names: the catalog `name` each (provider, id) pair resolves to, the warm-up that fills them, the pairs a log names, and the `assistant/message` mapped onto its name.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelNames } from '../dsh/src/model-names.js';
import { assistantMessage, requestHeader, stepStart, turnStart } from './helpers/dsh-events.js';

const PROVIDER = 'deepseek';
const MODEL = 'deepseek-v4-pro';
const OTHER_MODEL = 'deepseek-v4-flash';

// A resolver over a `(provider, id) → name` table that records every call; an id the table lacks rejects as the llm service does for a route with no adapter.
function tableResolver(table) {
  const calls = [];
  const resolve = async (provider, id) => {
    calls.push([provider, id]);
    const name = table[`${provider}/${id}`];
    if (name === undefined) throw Object.assign(new Error(`no adapter for provider "${provider}"`), { code: 'NO_ADAPTER' });
    return { provider, id, name };
  };
  return { resolve, calls };
}

// A resolver whose every call stays pending until the test settles it.
function deferredResolver() {
  const calls = [];
  const resolve = (provider, id) => {
    const deferred = Promise.withResolvers();
    calls.push({ provider, id, ...deferred });
    return deferred.promise;
  };
  return { resolve, calls };
}

const settledYet = async promise => {
  let settled = false;
  promise.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  return settled;
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('nameOf answers undefined before a warm-up', () => {
  const names = createModelNames(tableResolver({ [`${PROVIDER}/${MODEL}`]: 'DeepSeek V4 Pro' }));
  assert.equal(names.nameOf(PROVIDER, MODEL), undefined);
});

test('warm resolves a pair once when a header and a message name it together and stores the fulfilled name', async () => {
  const { resolve, calls } = tableResolver({ [`${PROVIDER}/${MODEL}`]: 'DeepSeek V4 Pro' });
  const names = createModelNames({ resolve });
  await names.warm(names.pairsOf([requestHeader(), assistantMessage()]));
  assert.deepEqual(calls, [[PROVIDER, MODEL]]);
  assert.equal(names.nameOf(PROVIDER, MODEL), 'DeepSeek V4 Pro');
});

test('a second warm naming a pair the first left in flight settles only after that resolve settles', async () => {
  const { resolve, calls } = deferredResolver();
  const names = createModelNames({ resolve });
  const first = names.warm([{ provider: PROVIDER, model: MODEL }]);
  const second = names.warm([{ provider: PROVIDER, model: MODEL }]);
  assert.equal(await settledYet(second), false);
  assert.equal(calls.length, 1);

  calls[0].resolve({ provider: PROVIDER, id: MODEL, name: 'DeepSeek V4 Pro' });
  await second;
  assert.equal(names.nameOf(PROVIDER, MODEL), 'DeepSeek V4 Pro');
  await first;
  assert.equal(calls.length, 1);
});

test('a rejected resolve settles the warm-up and leaves nameOf undefined', async () => {
  const names = createModelNames(tableResolver({}));
  await names.warm([{ provider: PROVIDER, model: MODEL }]);
  assert.equal(names.nameOf(PROVIDER, MODEL), undefined);
});

test('a later warm resolves again a pair whose earlier resolve rejected', async () => {
  const table = {};
  const { resolve, calls } = tableResolver(table);
  const names = createModelNames({ resolve });
  await names.warm([{ provider: PROVIDER, model: MODEL }]);
  table[`${PROVIDER}/${MODEL}`] = 'DeepSeek V4 Pro';
  await names.warm([{ provider: PROVIDER, model: MODEL }]);
  assert.equal(calls.length, 2);
  assert.equal(names.nameOf(PROVIDER, MODEL), 'DeepSeek V4 Pro');
});

test('a fulfilled resolve with an empty name stores nothing', async () => {
  const names = createModelNames(tableResolver({ [`${PROVIDER}/${MODEL}`]: '' }));
  await names.warm([{ provider: PROVIDER, model: MODEL }]);
  assert.equal(names.nameOf(PROVIDER, MODEL), undefined);
});

test('pairsOf reads header and message pairs, skips any other event and a malformed one, and answers distinct pairs', () => {
  const names = createModelNames(tableResolver({}));
  const modelless = assistantMessage();
  const malformed = {
    ...modelless,
    data: { ...modelless.data, message: { ...modelless.data.message, source: { kind: 'model', provider: PROVIDER, model: 7 } } },
  };
  const otherProvider = requestHeader();
  const otherRoute = {
    ...otherProvider,
    data: { ...otherProvider.data, header: { config: { provider: 'openai', model: MODEL } } },
  };
  const configless = { type: 'request/header', seq: 0, time: 0, data: { header: {} } };
  const events = [
    turnStart(), requestHeader(), stepStart(), assistantMessage(), malformed, configless,
    assistantMessage({ model: OTHER_MODEL }), otherRoute, requestHeader({ model: OTHER_MODEL }),
  ];
  assert.deepEqual(names.pairsOf(events), [
    { provider: PROVIDER, model: MODEL },
    { provider: PROVIDER, model: OTHER_MODEL },
    { provider: 'openai', model: MODEL },
  ]);
});

test('mapEvent on a frozen known assistant message answers a path copy carrying the name', async () => {
  const names = createModelNames(tableResolver({ [`${PROVIDER}/${MODEL}`]: 'DeepSeek V4 Pro' }));
  await names.warm([{ provider: PROVIDER, model: MODEL }]);
  const built = assistantMessage({ text: 'Done.', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
  const replayState = { response: { responseId: 'resp-1' } };
  const event = deepFreeze({
    ...built,
    data: { ...built.data, message: { ...built.data.message, source: { ...built.data.message.source, replayState } } },
  });

  const mapped = names.mapEvent(event);
  assert.notEqual(mapped, event);
  assert.equal(mapped.data.message.source.model, 'DeepSeek V4 Pro');
  assert.equal(mapped.data.message.source.provider, PROVIDER);
  assert.equal(mapped.data.message.source.replayState, replayState);
  assert.equal(mapped.data.message.content, event.data.message.content);
  assert.equal(mapped.data.usage, event.data.usage);
  assert.equal(mapped.seq, event.seq);
  assert.equal(event.data.message.source.model, MODEL);
});

test('mapEvent answers the same object for an unknown pair, a request header and any other type', async () => {
  const names = createModelNames(tableResolver({ [`${PROVIDER}/${MODEL}`]: 'DeepSeek V4 Pro' }));
  await names.warm([{ provider: PROVIDER, model: MODEL }]);
  for (const event of [assistantMessage({ model: OTHER_MODEL }), requestHeader(), turnStart()]) {
    assert.equal(names.mapEvent(event), event);
  }
});
