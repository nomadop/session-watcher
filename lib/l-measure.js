import { MISS_CR_DROP } from './constants.js';

// Cache-miss detection against prevL, the previous step's measured L: cacheRead falling below
// prevL·MISS_CR_DROP means the cached prefix was evicted and the context was re-read as fresh input.
// Total stock is not consulted: topology alone opens an epoch, and the Engine classifies no epoch's
// first step, so a stock drop inside an epoch says nothing against an eviction — a rebuild that also
// sheds content still collapses cacheRead. prevL<=0 (cold start) → never a miss.
export function classifyMiss({ cacheRead, prevL }) {
  if (!(prevL > 0)) return false;
  return cacheRead < prevL * MISS_CR_DROP;
}
