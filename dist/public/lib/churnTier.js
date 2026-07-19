// public/lib/churnTier.js — Pure churn-tier helper (no DOM access at module scope).
// Importable by node:test without a document. Spec §2.3 struggling detection.
import { CHURN_ELEVATED_THRESHOLD, CHURN_STRUGGLING_THRESHOLD, CHURN_STRUGGLING_REREADS, WASTE_FLOOR } from './uiConstants.js';

// Churn tier for path-name + minibar color (spec §2.3). Two struggling signals, both gated by
// WASTE_FLOOR so a tiny high-overhead file (20-token config) never reads as struggling or propagates
// coral to its parent: (1) pure re-reads >= CHURN_STRUGGLING_REREADS, (2) high churn > threshold.
// pureRereads signal is checked FIRST (priority per brief).
export function churnTier({ churn, waste, pureRereads } = {}) {
  const w = waste ?? 0;
  if (w >= WASTE_FLOOR && (pureRereads ?? 0) >= CHURN_STRUGGLING_REREADS) return 'coral';
  if (Number.isFinite(churn) && churn > CHURN_STRUGGLING_THRESHOLD && w >= WASTE_FLOOR) return 'coral';
  if (Number.isFinite(churn) && churn >= CHURN_ELEVATED_THRESHOLD) return 'amber';
  return 'mint';
}

// Tier ordering for max-propagation: mint < amber < coral
const TIER_RANK = { mint: 0, amber: 1, coral: 2 };

/**
 * Compute the max churn tier from an array of BucketNode children.
 * Directory-level tier: the highest tier among children that would individually
 * return coral (WASTE_FLOOR-gated). For amber this propagates as-is.
 * @param {Array} children — flat or nested; iterates own tier field if present
 * @returns {'mint'|'amber'|'coral'}
 */
export function maxChildTier(children) {
  let max = 'mint';
  for (const child of children) {
    const t = child.churnTier ?? 'mint';
    if (TIER_RANK[t] > TIER_RANK[max]) max = t;
    if (max === 'coral') return 'coral'; // short-circuit
  }
  return max;
}
