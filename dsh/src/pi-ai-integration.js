// dsh/src/pi-ai-integration.js — the seam between the host entry and the opt-in pi-ai entry (`pi-ai-index.js`): the names of the services each provides for the other and the causes the pi-ai entry reports.
// It imports nothing: the two entries are separate bundles, and a mounted pi-ai entry and the host meet only through services the other reads at each use with `ctx.get`, which leave with their provider's fiber.

/**
 * The service the pi-ai entry provides once it has settled its source: `{ failure: null, cacheRetention, routes }` while the entry serves the original `llm-pi-ai` row's routes, and `{ failure: { cause } }` when it serves none.
 * `routes()` answers the routes the llm registry accepted from the entry's adapter, as of its last registration that returned: the entry's own evidence of what it serves, standing only as long as the entry's fiber does, and `[]` for a dormant entry whose row holds no provider.
 * `cacheRetention(route)` answers the retention (`none`, `short` or `long`) the entry's startup configuration declares for `route`, null for none; a failed entry has no such member, since it holds no authority over a lifetime (with `source-enabled` the original adapter serves, and its profiles are in Settings).
 * A context where no such service stands has no pi-ai entry mounted.
 */
export const PI_AI_SERVICE = 'sessionWatcherPiAi';

/**
 * Why the pi-ai entry serves no route, each a cause of its source, the original `llm-pi-ai` row's composed configuration that the entry reads once at startup:
 * `source-missing` the Loader holds no row to read, `source-enabled` the row is not switched off, so the original adapter serves it, and `source-invalid` its configuration is no usable profile dictionary.
 */
export const SOURCE_FAILURES = ['source-missing', 'source-enabled', 'source-invalid'];

/** The Loader path of the original `llm-pi-ai` row: the root include's pinned id and the row's id in the base bundle. The pi-ai entry reads its configuration from it, and the carrier cache switch reads whether it is off and mounted. */
export const ORIGINAL_ROW = 'include:llm-pi-ai';

/**
 * The service the host entry provides for the pi-ai entry's wrapped `onPayload` hook to report to: `{ record(result) }`.
 * Each call of the hook reports the closed result it reached (`lib/llm-adapter/carrier-results.js` states the shapes), and the service files it under the summary request whose stream is being iterated, none when the call belongs to no such request.
 * A context where no such service stands has no host mounted, and the hook then reports nothing.
 */
export const CARRIER_EVIDENCE_SERVICE = 'sessionWatcherCarrierEvidence';

/**
 * The service the host entry provides for the pi-ai entry to ask what a carrier opens with: `{ carrierPrefix() }`, the text the first text block of every inner-seal carrier the host writes starts with, asked at each call of the payload hook, so a reworded carrier needs no new release of the entry.
 * A context where no such service stands has no host mounted, or one from before it; the entry then tells no carrier and gives no request a point and reports nothing.
 */
export const CARRIER_PREFIX_SERVICE = 'sessionWatcherCarrierPrefix';

/**
 * The service the host entry provides for the pi-ai entry to ask: `{ responsesBreakpoint() }`, whether the owner's saved switch for the OpenAI Responses breakpoint is on, asked once for each OpenAI Responses request; the entry takes anything but `true`, a service with no such member and one that throws included, as off.
 * A context where no such service stands has no host mounted, and the entry then finds the switch off.
 */
export const CARRIER_SETTINGS_SERVICE = 'sessionWatcherCarrierSettings';
