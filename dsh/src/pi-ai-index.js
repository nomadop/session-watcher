// dsh/src/pi-ai-index.js — the opt-in pi-ai adapter entry of the DSH package (`@nomadop/session-watcher-dsh/pi-ai`): the Harness's `llm-pi-ai` plugin, vendored under `dsh/vendor/dsh-llm-pi-ai`, mounted with the carrier cache point (`carrier-cache.js`) added to each route's pi-ai provider.
// The one module besides `index.js` that imports a DSH package, through the vendored bootstrap; the host entry never loads it, and a profile that mounts it disables the original `llm-pi-ai` row (`dsh/README.md`).
// The entry takes no configuration: its routes are the original row's, read once at startup from the Loader's composed entry for that row, so the profile holds the dictionary once and an edit of it takes effect at the next start.
import { CARRIER_WORDING } from '../../lib/harness/dsh/inner-seal-message.js';
import { resolveProfiles } from '../vendor/dsh-llm-pi-ai/src/config.ts';
import { bootstrap, Config, name } from '../vendor/dsh-llm-pi-ai/src/index.ts';
import { createCarrierCache } from './carrier-cache.js';
import { CARRIER_EVIDENCE_SERVICE, ORIGINAL_ROW, PI_AI_SERVICE } from './pi-ai-integration.js';

export { name };
export const inject = ['llm', 'loader'];

// What each cause is told as, with nothing of the configuration in it.
const FAILURE_LOGS = {
  'source-missing': `llm-pi-ai carrier cache: the Loader has no readable row ${ORIGINAL_ROW}, so no route is served`,
  'source-enabled': `llm-pi-ai carrier cache: the row ${ORIGINAL_ROW} is not switched off, so the original adapter serves and this entry serves no route`,
  'source-invalid': `llm-pi-ai carrier cache: the configuration of the row ${ORIGINAL_ROW} is not a usable profile dictionary, so no route is served`,
};

// The validated configuration of the original row, or the cause it cannot be used. The row is read from the Loader without waiting for it: this entry is itself one of the Loader's tasks, and the composed entries exist before any of them applies.
// A row's `!!js` nodes are no value of the dictionary and fail its schema; the Loader evaluates them for a running entry only.
function readSource(ctx) {
  let row;
  let disabled;
  try {
    row = ctx.loader.resolve(ORIGINAL_ROW);
    ({ disabled } = row);
  } catch {
    return { cause: 'source-missing' };
  }
  if (disabled !== true) return { cause: 'source-enabled' };
  try {
    const config = Config(structuredClone(row.options.config ?? {}));
    // The adapter's own resolution of the dictionary, so a scalar error is a cause and no throw out of the bootstrap.
    resolveProfiles(structuredClone(config.providers.get()), 'deferred');
    return { config };
  } catch {
    return { cause: 'source-invalid' };
  }
}

export function apply(ctx) {
  const source = readSource(ctx);
  if (source.cause !== undefined) {
    ctx.logger.error(FAILURE_LOGS[source.cause]);
    ctx.provide(PI_AI_SERVICE, { failure: { cause: source.cause } });
    return;
  }
  // The host's service is read at each call: it stands only while the host entry does, and a call with none reports nowhere and finds the Responses switch off.
  const cache = createCarrierCache({
    carrierPrefix: CARRIER_WORDING.addresses,
    report: message => ctx.logger.warn(message),
    observe: result => ctx.get(CARRIER_EVIDENCE_SERVICE)?.record(result),
    responsesBreakpoint: () => ctx.get(CARRIER_EVIDENCE_SERVICE)?.responsesBreakpoint?.(),
  });
  const registration = bootstrap(ctx, source.config, cache.decorateProfiles);
  ctx.provide(PI_AI_SERVICE, {
    failure: null,
    cacheRetention: route => source.config.providers.get()[route]?.cacheRetention ?? null,
    routes: () => registration.registeredRoutes(),
  });
}
