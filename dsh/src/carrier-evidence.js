// dsh/src/carrier-evidence.js — the host's record of what the opt-in pi-ai entry's wrapped `onPayload` hook did for one summary request of the inner seal.
// The seal opens a scope around the stream it iterates; the hook, which pi-ai calls from inside that iteration, reports through the service the host provides to the pi-ai entry, and the service files each report under the scope its call runs in. An `AsyncLocalStorage` carries the scope across the two bundles, so neither imports the other; a hook call outside every scope, a main request's among them, is filed nowhere.
// It reports each hook call as one closed result and claims nothing of what the endpoint did with the request.
import { AsyncLocalStorage } from 'node:async_hooks';
import { CARRIER_RESULTS, SKIP_REASONS } from './pi-ai-integration.js';

/** The most results one scope keeps; the ones after it are counted in `omitted`. */
export const MAX_CARRIER_EVIDENCE = 8;

/** Whether `value` is one closed result: `{ result: 'added' | 'native' }` or `{ result: 'skipped', reason }`, with no other member. */
export function isCarrierResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !CARRIER_RESULTS.includes(value.result)) return false;
  const keys = Object.keys(value);
  return value.result === 'skipped' ? keys.length === 2 && SKIP_REASONS.includes(value.reason) : keys.length === 1;
}

/** Whether `value` is the evidence of one summary request in the closed shape the call record keeps: `{ results, omitted }`, one to `MAX_CARRIER_EVIDENCE` closed results and a count of those left out, and no other member. */
export function isCarrierEvidence(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return false;
  const { results, omitted } = value;
  return Array.isArray(results) && results.length > 0 && results.length <= MAX_CARRIER_EVIDENCE && results.every(isCarrierResult) && Number.isSafeInteger(omitted) && omitted >= 0;
}

// The result as the closed shape alone, so a caller's extra member never reaches the record.
const closed = ({ result, reason }) => (result === 'skipped' ? { result, reason } : { result });

/**
 * @param {{ responsesBreakpoint?: () => boolean }} [options] `responsesBreakpoint` is the owner's switch for the OpenAI Responses breakpoint, read at each call of the service's member of that name; off where none is given.
 * @returns {{ service: { record: (result: object) => void, responsesBreakpoint: () => boolean },
 *   scope: () => { run: <T>(body: () => T) => T, evidence: () => ({ results: object[], omitted: number }|null) } }}
 *   `service` is what the pi-ai entry reads: it records each hook result and answers whether the owner's switch is on; `scope()` makes one scope, whose `run(body)` calls `body` with the scope in force for everything `body` starts, and whose `evidence()` answers the results filed under it in the order they were reported, `null` when none was.
 */
export function createCarrierEvidence({ responsesBreakpoint = () => false } = {}) {
  const store = new AsyncLocalStorage();
  return {
    service: Object.freeze({
      responsesBreakpoint,
      record(result) {
        const scope = store.getStore();
        if (scope === undefined || !isCarrierResult(result)) return;
        if (scope.results.length < MAX_CARRIER_EVIDENCE) scope.results.push(closed(result));
        else scope.omitted += 1;
      },
    }),
    scope() {
      const own = { results: [], omitted: 0 };
      return {
        run: body => store.run(own, body),
        evidence: () => (own.results.length === 0 ? null : { results: own.results.map(closed), omitted: own.omitted }),
      };
    },
  };
}
