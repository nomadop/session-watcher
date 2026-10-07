// lib/harness/dsh/cache-ttl.js — pi-ai's `cacheRetention` vocabulary mapped onto the TTL keys `C_RATIO_TABLE` prices.
// The host reads the declaration from the route's pi-ai profile and hands it here; this module reads no service and no setting.
// `long` is the one declaration naming a lifetime the table keys apart from its default, so every other declaration, an absent one included, maps to `null` and the model policy prices the call under `DEFAULT_CACHE_TTL`.
import { LONG_CACHE_TTL } from '../../constants.js';

export function cacheTtlForRetention(retention) {
  return retention === 'long' ? LONG_CACHE_TTL : null;
}
