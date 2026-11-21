// dsh/src/carrier-evidence.js — the host's record of what the opt-in pi-ai entry's wrapped `onPayload` hook did for one summary request of the inner seal.
// The seal opens a scope around the stream it iterates; the hook, which pi-ai calls from inside that iteration, reports through the service the host provides to the pi-ai entry, and the service files each report under the scope its call runs in. An `AsyncLocalStorage` carries the scope across the two bundles, so neither imports the other; a hook call outside every scope, a main request's among them, is filed nowhere.
// It files each hook call's closed result (the vocabulary of `lib/llm-adapter/carrier-results.js`, checked here once) and claims nothing of what the endpoint did with the request.
import { AsyncLocalStorage } from 'node:async_hooks';
import { MAX_CARRIER_EVIDENCE } from '../../lib/inner-seal/call-record.js';
import { isCarrierResult } from '../../lib/llm-adapter/carrier-results.js';

/**
 * @returns {{ service: { record: (result: object) => void },
 *   scope: () => { run: <T>(body: () => T) => T, evidence: () => ({ results: object[], omitted: number }|null) } }}
 *   `service` is what the pi-ai entry reports to: it files each hook result that is a closed result and counts what the bound leaves out; `scope()` makes one scope, whose `run(body)` calls `body` with the scope in force for everything `body` starts, and whose `evidence()` answers the results filed under it in the order they were reported, `null` when none was.
 */
export function createCarrierEvidence() {
  const store = new AsyncLocalStorage();
  return {
    service: Object.freeze({
      record(result) {
        const scope = store.getStore();
        if (scope === undefined || !isCarrierResult(result)) return;
        if (scope.results.length < MAX_CARRIER_EVIDENCE) scope.results.push(result);
        else scope.omitted += 1;
      },
    }),
    scope() {
      const own = { results: [], omitted: 0 };
      return {
        run: body => store.run(own, body),
        evidence: () => (own.results.length === 0 ? null : { results: [...own.results], omitted: own.omitted }),
      };
    },
  };
}
