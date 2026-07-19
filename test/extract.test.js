import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage, providerOf, cRatioFor, contextWindowFor, ctpForModel } from '../lib/extract.js';

const claudeLine = {
  type: 'assistant', uuid: 'u1', isSidechain: false, timestamp: '2026-07-01T00:00:00Z',
  message: { id: 'msg_1', model: 'claude-opus-4-8', usage: {
    input_tokens: 2, output_tokens: 110,
    cache_creation_input_tokens: 2446, cache_read_input_tokens: 137000 } },
};

test('extractUsage reads the five token fields + model + messageId', () => {
  const u = extractUsage(claudeLine);
  assert.equal(u.model, 'claude-opus-4-8');
  assert.equal(u.messageId, 'msg_1');
  assert.equal(u.cacheRead, 137000);
  assert.equal(u.cacheCreation, 2446);
  assert.equal(u.input, 2);
  assert.equal(u.output, 110);
  assert.equal(u.isSidechain, false);
});

test('extractUsage sums the cache_creation OBJECT form', () => {
  const objForm = { ...claudeLine, message: { ...claudeLine.message, usage: {
    input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 500 } } } };
  assert.equal(extractUsage(objForm).cacheCreation, 1500);
});

test('extractUsage returns null for non-usage / non-assistant lines', () => {
  assert.equal(extractUsage({ type: 'user', message: { content: 'hi' } }), null);
  assert.equal(extractUsage({ type: 'assistant', message: { id: 'x' } }), null);
});

test('extractUsage skips a line with an explicit null on a known field', () => {
  const nulled = { type: 'assistant', uuid: 'n', isSidechain: false, timestamp: 't',
    message: { id: 'mn', model: 'claude-opus-4-8', usage: {
      input_tokens: 2, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: 100 } } };
  assert.equal(extractUsage(nulled), null, 'explicit null on cache_creation_input_tokens → skip');
});

test('v3: extractUsage no longer emits gField', () => {
  const u = extractUsage({ type: 'assistant', message: { id: 'm', model: 'claude-opus-4-8',
    usage: { cache_read_input_tokens: 100, output_tokens: 5 } } });
  assert.equal(u.gField, undefined);
});

test('extractUsage skips a <synthetic>-model all-zero no-op turn', () => {
  const syn = { type: 'assistant', uuid: 's', isSidechain: false, timestamp: 't',
    message: { id: 'msg_syn', model: '<synthetic>', usage: {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  assert.equal(extractUsage(syn), null, '<synthetic> all-zero turn → skip (no false L-drop)');
});

test('extractUsage skips an all-zero-usage turn on a normal model', () => {
  const allZero = { type: 'assistant', uuid: 'z', isSidechain: false, timestamp: 't',
    message: { id: 'msg_zero', model: 'deepseek-v4-pro', usage: {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  assert.equal(extractUsage(allZero), null, 'all four token fields zero → skip (no measurement)');
});

test('extractUsage KEEPS a real zero-cacheRead deepseek cold-start/resume call', () => {
  const coldStart = { type: 'assistant', uuid: 'c', isSidechain: false, timestamp: 't',
    message: { id: 'msg_cold', model: 'deepseek-v4-pro', usage: {
      input_tokens: 32351, output_tokens: 716, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } };
  const u = extractUsage(coldStart);
  assert.notEqual(u, null, 'legit zero-cacheRead call (nonzero input/output) MUST be kept');
  assert.equal(u.input, 32351);
  assert.equal(u.cacheRead, 0);
});

test('provider + ratio + window lookups', () => {
  assert.equal(providerOf('claude-opus-4-8'), 'claude');
  assert.equal(providerOf('deepseek-v4-pro'), 'deepseek');
  assert.equal(providerOf('gpt-5'), 'unknown');
  assert.equal(cRatioFor('claude-opus-4-6'), 12.5);
  assert.equal(cRatioFor('deepseek-v4-flash'), 50);
  assert.equal(cRatioFor('deepseek-v4-pro'), 120);
  assert.equal(cRatioFor('some-new-model'), 10); // conservative default, never 0
  assert.equal(contextWindowFor('deepseek-v4-pro'), 1000000);
  assert.equal(contextWindowFor('claude-sonnet-4-6'), 1000000);
});

test('ctpForModel: prefix-matches calibrated models, falls back to default', () => {
  assert.deepEqual(ctpForModel('claude-opus-4-8'), { ascii: 2.45, cjk: 0.59 });
  assert.deepEqual(ctpForModel('deepseek-v4-flash'), { ascii: 3.24, cjk: 0.94 });
  assert.deepEqual(ctpForModel('gpt-5'), { ascii: 3.0, cjk: 1.0 }); // uncalibrated → DEFAULT_CTP
  assert.deepEqual(ctpForModel(''), { ascii: 3.0, cjk: 1.0 });
  assert.deepEqual(ctpForModel(undefined), { ascii: 3.0, cjk: 1.0 });
});
