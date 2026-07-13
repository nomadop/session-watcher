// lib/pricing-store.js
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { writeJsonAtomic, safeSessionId } from './atomic-store.js';

function pathFor(sessionId) {
  const base = process.env.CLAUDE_PLUGIN_DATA
    ? join(process.env.CLAUDE_PLUGIN_DATA, 'pricing')
    : join(homedir(), '.session-watcher', 'pricing');
  return join(base, `${safeSessionId(sessionId || 'default')}.json`);
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

export function savePricing(sessionId, { readPrice, writePrice, presetId }) {
  const ratio = validatePricingInput({ readPrice, writePrice });
  const record = { readPrice, writePrice, ratio, savedAt: new Date().toISOString() };
  if (presetId != null) record.presetId = presetId;
  writeJsonAtomic(pathFor(sessionId), record);
  return record;
}

export function loadPricing(sessionId) {
  try {
    const data = JSON.parse(readFileSync(pathFor(sessionId), 'utf8'));
    if (!Number.isFinite(data.ratio) || data.ratio < 1) return null;
    if (!Number.isFinite(data.readPrice) || data.readPrice <= 0) return null;
    if (!Number.isFinite(data.writePrice) || data.writePrice <= 0) return null;
    return data;
  } catch { return null; }
}

export function deletePricing(sessionId) {
  try { rmSync(pathFor(sessionId), { force: true }); } catch { /* no-op */ }
}
