// lib/measurement/usage.js — the two sums of a call's canonical usage `{ input, output, cacheRead, cacheWrite }` that every consumer reads: the Engine's history and totals, the Source facts and the inner monitor.

/** The stock a call's request carried: its input and cache buckets, summed. */
export const stockOf = ({ input, cacheRead, cacheWrite }) => input + cacheRead + cacheWrite;

/** The tokens of a call the cache did not serve: under the exclusive usage fields, the uncached input and what the call wrote to the cache. */
export const uncachedOf = ({ input, cacheWrite }) => input + cacheWrite;
