// lib/pricing-store.js
import { getStore } from './store.js';

// Returns the store instance or null if not yet initialized (for graceful no-op reads).
// tryGetStore: applyEffectiveRatio() is called during createServer() setup,
// before initStore() runs in the CLI bootstrap. Return null gracefully.
function tryGetStore() {
  try { return getStore(); } catch { return null; }
}

/** The longest `presetId` a pricing save stores. */
export const PRESET_ID_MAX_CHARS = 80;

/** The message both hosts answer `no_model` with when a pricing write meets an epoch with no model yet. */
export const NO_MODEL_MESSAGE = 'Model not yet detected; retry after first API call';

/** `presetId` when it is a non-empty string of at most `PRESET_ID_MAX_CHARS`, else `null`. */
export function sanitizePresetId(presetId) {
  return (typeof presetId === 'string' && presetId.length > 0 && presetId.length <= PRESET_ID_MAX_CHARS)
    ? presetId : null;
}

export function validatePricingInput({ readPrice, writePrice }) {
  if (!Number.isFinite(readPrice) || !Number.isFinite(writePrice))
    throw new Error('readPrice and writePrice must be finite numbers');
  if (readPrice <= 0) throw new Error('readPrice must be > 0');
  if (writePrice <= 0) throw new Error('writePrice must be > 0');
  const ratio = writePrice / readPrice;
  if (ratio < 1) throw new Error('ratio (write/read) must be >= 1');
  return ratio;
}

export function savePricingOverride(model, { readPrice, writePrice, presetId }) {
  const ratio = validatePricingInput({ readPrice, writePrice });
  const record = { readPrice, writePrice, ratio, savedAt: new Date().toISOString() };
  if (presetId != null) record.presetId = presetId;
  getStore().saveConfig(`pricing:${model}`, record);
  return record;
}

export function loadPricingOverride(model) {
  const store = tryGetStore();
  if (!store) return null;  // store not initialized — treat as no saved override
  const data = store.loadConfig(`pricing:${model}`);
  if (!data) return null;
  if (!Number.isFinite(data.ratio) || data.ratio < 1) return null;
  if (!Number.isFinite(data.readPrice) || data.readPrice <= 0) return null;
  if (!Number.isFinite(data.writePrice) || data.writePrice <= 0) return null;
  return data;
}

export function deletePricingOverride(model) {
  getStore().deleteConfig(`pricing:${model}`);
}
