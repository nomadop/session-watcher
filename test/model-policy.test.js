import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPolicyFor } from '../lib/model-policy.js';
import { MODEL_PRICING_PRESETS, DEFAULT_CACHE_TTL } from '../lib/constants.js';

const CLAUDE_CTP = { ascii: 2.45, cjk: 0.59, version: 1 };
const DEEPSEEK_CTP = { ascii: 3.24, cjk: 0.94, version: 1 };
const FALLBACK_CTP = { ascii: 3.0, cjk: 1.0, version: 1 };
const NO_MODEL_PRICES = { readPrice: null, writePrice: null };

function pricing() {
  return { ...NO_MODEL_PRICES, presets: MODEL_PRICING_PRESETS };
}

// A cRatio magnitude is the provider's to set, so the cases below take the ratio out of the compared policy
// and assert only that one arrived usable. Which ratio a model and lifetime resolve is the Cache TTL block's.
const withoutRatio = (modelId) => {
  const { cRatio, ...rest } = modelPolicyFor(modelId);
  assert.ok(Number.isFinite(cRatio) && cRatio > 0, `${String(modelId)} carries a usable ratio: ${cRatio}`);
  return rest;
};

test('modelPolicyFor: claude prefix resolves the calibrated CTP, ratio, and capacity', () => {
  assert.deepEqual(withoutRatio('claude-opus-4-8'), {
    ctp: CLAUDE_CTP,
    contextCapacity: 1_000_000,
    pricing: pricing(),
  });
});

test('modelPolicyFor: every calibrated and fallback model prefix', () => {
  const cases = [
    ['claude-sonnet-4-6', CLAUDE_CTP, 1_000_000],
    ['claude-haiku-4-5', CLAUDE_CTP, 1_000_000],
    ['deepseek-v4-flash', DEEPSEEK_CTP, 1_000_000],
    ['deepseek-v4-pro', DEEPSEEK_CTP, 1_000_000],
    ['gpt-5', FALLBACK_CTP, 1_000_000],
    ['some-new-model', FALLBACK_CTP, 1_000_000],
    ['test-short-window', FALLBACK_CTP, 200_000],
  ];
  for (const [modelId, ctp, contextCapacity] of cases) {
    assert.deepEqual(withoutRatio(modelId), { ctp, contextCapacity, pricing: pricing() }, modelId);
  }
});

test('modelPolicyFor: absent model identity resolves the fallback policy', () => {
  for (const modelId of ['', null, undefined]) {
    assert.deepEqual(withoutRatio(modelId), {
      ctp: FALLBACK_CTP,
      contextCapacity: 1_000_000,
      pricing: pricing(),
    }, String(modelId));
  }
});

test('modelPolicyFor: the C ratio is never zero for an unrecognised model', () => {
  assert.ok(modelPolicyFor('a-model-nobody-has-heard-of').cRatio > 0);
});

test('modelPolicyFor: every known model and the fallback carry a valid CTP version', () => {
  for (const modelId of ['claude-opus-4-8', 'deepseek-v4-pro', 'gpt-5', '', null]) {
    const { version } = modelPolicyFor(modelId).ctp;
    assert.equal(typeof version, 'number', String(modelId));
    assert.ok(Number.isInteger(version) && version > 0, `${String(modelId)} → ${version}`);
  }
});

test('modelPolicyFor: returned policies are detached — a mutated result never leaks into the next', () => {
  const ratioBefore = modelPolicyFor('claude-opus-4-8').cRatio;
  const first = modelPolicyFor('claude-opus-4-8');
  first.ctp.ascii = 99;
  first.ctp.version = 99;
  first.cRatio = 99;
  first.pricing.presets.length = 0;
  first.pricing.readPrice = 99;
  const { cRatio, ...rest } = modelPolicyFor('claude-opus-4-8');
  assert.deepEqual(rest, {
    ctp: CLAUDE_CTP,
    contextCapacity: 1_000_000,
    pricing: pricing(),
  });
  assert.equal(cRatio, ratioBefore, 'the mutated ratio did not reach the next policy');
  assert.ok(MODEL_PRICING_PRESETS.length > 0, 'the preset table itself is untouched');
});

test('modelPolicyFor: a returned pricing preset is detached from the table', () => {
  const preset = modelPolicyFor('claude-opus-4-8').pricing.presets[0];
  preset.readPrice = 999;
  assert.notEqual(MODEL_PRICING_PRESETS[0].readPrice, 999);
});

test('modelPolicyFor: default policy values carry no runtime override', () => {
  const policy = modelPolicyFor('claude-opus-4-8');
  assert.equal(policy.pricing.readPrice, null);
  assert.equal(policy.pricing.writePrice, null);
  assert.deepEqual(Object.keys(policy).sort(), ['cRatio', 'contextCapacity', 'ctp', 'pricing']);
});

// ── Cache TTL ────────────────────────────────────────────────────────────────
// Whether the C ratio depends on the cache TTL is itself a per-model fact: a provider that prices the
// longer TTL above the shorter one keys its ratio by TTL, and a provider that charges one cache-write
// price carries a single ratio. The table expresses the second case as a scalar, so TTL-invariance is
// carried by the row's shape rather than by two numbers that happen to be equal and that no mechanism
// keeps in step. No case below pins either TTL's magnitude — the numbers are the table's to state.

test('modelPolicyFor: a TTL-keyed model resolves a distinct ratio per cache TTL', () => {
  const short = modelPolicyFor('claude-opus-4-8', DEFAULT_CACHE_TTL).cRatio;
  const long = modelPolicyFor('claude-opus-4-8', '1h').cRatio;
  assert.ok(long > short, `the longer TTL's write premium exceeds the shorter one's: ${long} vs ${short}`);
});

test('modelPolicyFor: a TTL-invariant model resolves one ratio across every cache TTL', () => {
  for (const modelId of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const short = modelPolicyFor(modelId, '5m').cRatio;
    const long = modelPolicyFor(modelId, '1h').cRatio;
    // Usable as well as equal: a keyed read of a scalar row answers nothing on either lifetime, and two
    // absent answers are equal to each other.
    assert.ok(Number.isFinite(short) && short > 0, `${modelId} carries a usable ratio: ${short}`);
    assert.equal(long, short, modelId);
  }
});

// The prototype-member tokens are here because a lookup that asks whether a key merely RESOLVES finds
// them on every object: a row prices a cache lifetime only where it carries the key itself, so a
// declaration naming an inherited member is a lifetime that row prices no write under.
test('modelPolicyFor: an unresolvable cache TTL resolves the default-TTL ratio', () => {
  const expected = modelPolicyFor('claude-opus-4-8', DEFAULT_CACHE_TTL).cRatio;
  const unresolvable = ['bogus', '10m', '1H', '', null, undefined,
    'toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];
  for (const ttl of unresolvable) {
    assert.equal(modelPolicyFor('claude-opus-4-8', ttl).cRatio, expected, String(ttl));
  }
});

test('modelPolicyFor: an unrecognised model carries one ratio on every cache TTL', () => {
  const expected = modelPolicyFor('gpt-5', DEFAULT_CACHE_TTL).cRatio;
  for (const ttl of ['5m', '1h', 'bogus', null]) {
    assert.equal(modelPolicyFor('gpt-5', ttl).cRatio, expected, String(ttl));
  }
});

test('modelPolicyFor: the C ratio stays finite and positive on every model and cache TTL', () => {
  for (const modelId of ['claude-opus-4-8', 'deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5', '', null]) {
    for (const ttl of ['5m', '1h', 'bogus', null, undefined]) {
      const { cRatio } = modelPolicyFor(modelId, ttl);
      assert.ok(Number.isFinite(cRatio) && cRatio > 0, `${String(modelId)} @ ${String(ttl)} → ${cRatio}`);
    }
  }
});

// The lookup takes the first match, so a row whose ids a broader pattern also matches earns nothing unless it
// precedes that pattern. Because the ratio divides out the base input price, a family billed at one pair of
// cache multipliers shares a row and only a differing multiplier earns a separate one — which makes an equal
// answer the signal that the separate row was shadowed, reordered away or dropped, rather than a price change.
test('modelPolicyFor: a row outranks the broader pattern that also matches its model', () => {
  for (const ttl of [DEFAULT_CACHE_TTL, '1h']) {
    const own = modelPolicyFor('claude-fable-5-1', ttl).cRatio;
    const broader = modelPolicyFor('claude-fable-5', ttl).cRatio;
    assert.ok(Number.isFinite(own) && own > 0, `claude-fable-5-1 @ ${ttl} → ${own}`);
    assert.notEqual(own, broader, `claude-fable-5-1 resolved the broader pattern's ratio at ${ttl}`);
  }
});
