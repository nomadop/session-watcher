// lib/llm-adapter/carrier-results.js — the closed vocabulary of one carrier cache point result, whatever protocol wrote it and whichever adapter injected the writer.
// The vocabulary and its closed shape belong to the adapter side: a record that carries results holds them as opaque values and shares no enum with this file.

/** What one request did about the last carrier it holds: `added` its own cache point, `native` the request's own point already ends the carrier at that position, `skipped` the request was checked and none was added, with one of `SKIP_REASONS`. */
export const CARRIER_RESULTS = ['added', 'native', 'skipped'];

/**
 * Why a checked request got no point of its own for its carrier: `no-carrier` the request holds none, `no-native-point` the route's serializer wrote no cache point of its own for the carrier's to follow (caching is off for the route, or the model takes none), `points-full` the route's point limit is already met, `responses-off` the request is an OpenAI Responses one and the owner's switch for its breakpoint is off, and `unsupported` the protocol is none the writer handles or the request is one it does not (an input of another shape, the ChatGPT sign-in lane, a request made with no prefix to tell a carrier by).
 */
export const SKIP_REASONS = ['no-carrier', 'no-native-point', 'points-full', 'responses-off', 'unsupported'];

/** Whether `value` is one closed result: `{ result: 'added' | 'native' }` or `{ result: 'skipped', reason }`, with no other member. */
export function isCarrierResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !CARRIER_RESULTS.includes(value.result)) return false;
  const keys = Object.keys(value);
  return value.result === 'skipped' ? keys.length === 2 && SKIP_REASONS.includes(value.reason) : keys.length === 1;
}
