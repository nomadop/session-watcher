// lib/model-policy.js — the sole owner of model-derived measurement policy.
// One lookup composes the CTP pair and its version, the C ratio, the context capacity, and the pricing
// data that a model identity — together with the prompt-cache TTL the host requests, the lifetime the
// provider prices a cache write under — implies. The tables stay in constants.js; this module is where
// a model id becomes a detached policy value. Every consumer — Measurement Projection, the Engine's
// injected resolver, the pricing route — reads its model-dependent values here and nowhere else.

import {
  C_RATIO_TABLE, DEFAULT_C_RATIO, DEFAULT_CACHE_TTL,
  CONTEXT_WINDOW_TABLE, DEFAULT_CONTEXT_WINDOW,
  CTP_TABLE, DEFAULT_CTP,
  MODEL_PRICING_PRESETS,
} from './constants.js';

// The CTP calibration generation. Every entry and the fallback carry it, so a stored measurement records
// which calibration produced it and a consumer never supplies a version of its own. Bump it when a
// CTP_TABLE row's numbers change, so an older persisted snapshot stays attributable to the numbers it
// was measured under.
const CTP_VERSION = 1;

// Prefix match rather than regex: real ids are 'claude-opus-4-8', 'deepseek-v4-flash'. An uncalibrated
// model falls back to DEFAULT_CTP, the conservative middle ground between the calibrated providers.
function ctpFor(modelId) {
  const id = String(modelId || '');
  const prefix = Object.keys(CTP_TABLE).find(p => id.startsWith(p));
  const ctp = prefix ? CTP_TABLE[prefix] : DEFAULT_CTP;
  return { ascii: ctp.ascii, cjk: ctp.cjk, version: CTP_VERSION };
}

// C_m/C_h = cache-write price ÷ cache-read price, for the model AND the prompt-cache lifetime the host
// declared. A scalar row states one price for every cache lifetime, so the lifetime plays no part; a
// keyed row answers the declared lifetime where it prices one, and DEFAULT_CACHE_TTL otherwise. The
// keyed lookup reads own properties only, so a declaration naming an inherited Object member is a
// lifetime the row prices no write under. That single fallback is the whole undeclared path too, which
// is what lets the harness report a declaration verbatim and name no price of its own. An unrecognised
// model falls back by tier substring and then to DEFAULT_C_RATIO, never to zero — a zero ratio would
// collapse every ratio-fed landmark.
function cRatioFor(modelId, ttl) {
  const hit = C_RATIO_TABLE.find(r => r.match.test(modelId));
  if (!hit) return DEFAULT_C_RATIO;
  if (typeof hit.ratio === 'number') return hit.ratio;
  return Object.hasOwn(hit.ratio, ttl) ? hit.ratio[ttl] : hit.ratio[DEFAULT_CACHE_TTL];
}

function contextCapacityFor(modelId) {
  const hit = CONTEXT_WINDOW_TABLE.find(r => r.match.test(modelId));
  return hit ? hit.window : DEFAULT_CONTEXT_WINDOW;
}

// Model-default prices are absent from the preset table: a preset is chosen by the operator and saved,
// so the default policy reports the presets it can choose from and no per-model price of its own.
function pricingFor() {
  return {
    readPrice: null,
    writePrice: null,
    presets: MODEL_PRICING_PRESETS.map(preset => ({ ...preset })),
  };
}

// The default policy for a model identity under one prompt-cache lifetime. Each call returns detached
// values so runtime overrides cannot change the tables or another consumer's policy. Absent identity
// resolves the fallback policy; an absent or unpriced lifetime resolves through the fallback inside
// `cRatioFor`, so a declared lifetime is passed on as the host stated it and substituted nowhere else.
// `pricing` is an own enumerable getter; reading it creates detached pricing data, including preset
// entries. Spreading or serializing a policy reads that getter.
export function modelPolicyFor(modelId, ttl) {
  const id = String(modelId ?? '');
  return {
    ctp: ctpFor(id),
    cRatio: cRatioFor(id, ttl),
    contextCapacity: contextCapacityFor(id),
    get pricing() { return pricingFor(); },
  };
}
