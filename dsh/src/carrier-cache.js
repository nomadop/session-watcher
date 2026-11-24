// dsh/src/carrier-cache.js — the pi-ai injection of the carrier cache point, in the opt-in pi-ai adapter entry (`pi-ai-index.js`): a resolved profile's pi-ai provider whose `streamSimple` has its `onPayload` hook run the carrier point writer (`lib/llm-adapter/carrier-point.js`) over the payload pi-ai's own serializer built.
// It knows no Cordis and imports no DSH or pi-ai package: the carrier's opening text, the Responses switch and the diagnostic sink reach it by parameter, and the writer reads only the payload, the model pi-ai hands the hook and the options the request was made with.
// A request the writer gives no point reaches the endpoint exactly as the native serializer wrote it.
// Each call of the hook ends in one closed result (`lib/llm-adapter/carrier-results.js`), which `observe` is handed; the result describes the payload the hook saw, so it claims nothing of what the endpoint did with it.
import { createCarrierPointWriter } from '../../lib/llm-adapter/carrier-point.js';

/**
 * @param {{ carrierPrefix: () => (string|undefined), report: (message: string) => void, observe: (result: object) => void, responsesBreakpoint: () => boolean }} parameters
 *   `carrierPrefix` answers the text every carrier's top-level text starts with, asked at each call of the hook: an answer of `undefined`, the host having none to give, leaves the request without a point (`unsupported`) and no report; an answer that is no non-empty text, or a throw, leaves it so with one report; `report` receives the one-line diagnostic of a request whose carrier could not be given a cache point, of a result `observe` could not take and of a switch that could not be read; `observe` is told the closed result of each hook call and may throw, which leaves the request as it is.
 *   `responsesBreakpoint` is the owner's Responses switch, which the writer reads once for each Responses request and takes as off unless it answers `true`; one that throws is off, with one diagnostic.
 */
export function createCarrierCache({ carrierPrefix, report, observe, responsesBreakpoint }) {
  const writeCarrierPoint = createCarrierPointWriter({ report, responsesBreakpoint });

  // The result goes to `observe` after the writer ran, whatever the writer concluded; a throw from `observe` is a warning and leaves the request as the writer made it.
  const observed = (outcome) => {
    try {
      observe(outcome);
    } catch {
      report('llm-pi-ai carrier cache: the cache evidence of a request could not be recorded');
    }
  };

  // The prefix as the owner answers it now; one it cannot answer is reported here and is none to the writer.
  const prefixNow = () => {
    try {
      return carrierPrefix();
    } catch {
      report('carrier cache: the prefix to tell a carrier by could not be read, so the request is sent without a cache point');
      return undefined;
    }
  };

  // The `onPayload` hook of one request: the hook the caller set, when it did, runs first and its replacement payload is the one written to.
  const hookOf = (earlier, options) => async (payload, model) => {
    const replaced = await earlier?.(payload, model);
    const body = replaced ?? payload;
    const outcome = writeCarrierPoint({ prefix: prefixNow(), payload: body, model, options });
    observed(outcome);
    return outcome.result === 'added' ? body : replaced;
  };

  // The provider with its `streamSimple` replaced; every other member, its auth included, is the original's, and the original runs as the receiver of the call.
  const wrapProvider = provider => Object.create(provider, {
    streamSimple: {
      value: (model, context, options) => provider.streamSimple(model, context, { ...options, onPayload: hookOf(options?.onPayload, options) }),
      enumerable: true, writable: true, configurable: true,
    },
  });

  return {
    /** The resolved profiles with each route's pi-ai provider wrapped; a route that resolved none is left as it is. */
    decorateProfiles: profiles => new Map([...profiles].map(([route, profile]) => [
      route, profile.piProvider === undefined ? profile : { ...profile, piProvider: wrapProvider(profile.piProvider) },
    ])),
  };
}
