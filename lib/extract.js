import { C_RATIO_TABLE, DEFAULT_C_RATIO, CONTEXT_WINDOW_TABLE, DEFAULT_CONTEXT_WINDOW } from './constants.js';

const KNOWN_USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

export function providerOf(model = '') {
  if (/claude|opus|sonnet|haiku/i.test(model)) return 'claude';
  if (/deepseek/i.test(model)) return 'deepseek';
  return 'unknown';
}

export function cRatioFor(model = '') {
  const hit = C_RATIO_TABLE.find(r => r.match.test(model));
  return hit ? hit.ratio : DEFAULT_C_RATIO;
}

export function contextWindowFor(model = '') {
  const hit = CONTEXT_WINDOW_TABLE.find(r => r.match.test(model));
  return hit ? hit.window : DEFAULT_CONTEXT_WINDOW;
}

function cacheCreationTotal(usage) {
  const cc = usage.cache_creation;
  if (cc && typeof cc === 'object') {
    return (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
  }
  return usage.cache_creation_input_tokens || 0;
}

export function hasNullKnownField(entry) {
  const u = entry?.message?.usage;
  if (!u) return false;
  return KNOWN_USAGE_FIELDS.some(f => u[f] === null);
}

export function extractUsage(entry) {
  if (!entry || entry.type !== 'assistant') return null;
  const msg = entry.message;
  if (!msg || !msg.usage || typeof msg.usage !== 'object') return null;
  if (hasNullKnownField(entry)) return null; // explicit null on a known field → skip line
  const u = msg.usage;
  const model = msg.model || '';
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreation = cacheCreationTotal(u);
  // No-op / aborted-turn artifact: a `<synthetic>` model or an all-zero-usage row carries no
  // measurement and is NOT a real API call. Skipping it prevents a false L-drop segmentation
  // (cacheRead=0 would otherwise open a spurious segment at L=0). NOTE: skip only on the all-zero
  // CONJUNCTION — never on cacheRead===0 alone, which would drop legit cold-start/resume calls
  // (nonzero input/output, e.g. input=32351,output=716,cacheRead=0).
  if (model === '<synthetic>' || (input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0)) {
    return null;
  }
  const gField = providerOf(model) === 'claude' ? cacheCreation + output : input + output;
  return {
    model,
    messageId: msg.id || null,
    requestId: entry.requestId || entry.request_id || null,
    isSidechain: entry.isSidechain === true,
    ts: entry.timestamp || null,
    input, output, cacheRead, cacheCreation, gField,
  };
}
