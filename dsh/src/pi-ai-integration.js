// dsh/src/pi-ai-integration.js — the seam between the host entry and the opt-in pi-ai entry (`pi-ai-index.js`): the name of the service the pi-ai entry provides and the causes it reports.
// It imports nothing: the two entries are separate bundles, and a mounted pi-ai entry and the host meet only through the service the host reads at each use with `ctx.get`, which leaves with the pi-ai entry's fiber.

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
 * The service the host entry provides for the pi-ai entry's wrapped `onPayload` hook to report to and ask: `{ record(result), responsesBreakpoint() }`.
 * Each call of the hook reports the closed result it reached (`carrier-evidence.js` states the shapes), and the service files it under the summary request whose stream is being iterated, none when the call belongs to no such request.
 * `responsesBreakpoint()` answers whether the owner's saved switch for the OpenAI Responses breakpoint is on, asked once for each OpenAI Responses request; the entry takes anything but `true`, a service with no such member and one that throws included, as off.
 * A context where no such service stands has no host mounted, and the hook then reports nothing and finds the switch off.
 */
export const CARRIER_EVIDENCE_SERVICE = 'sessionWatcherCarrierEvidence';

/** What one invocation of the wrapped hook did about the last carrier of the request it was handed: `added` its own cache point, `native` the request's own point already ends the carrier at that position, `skipped` it checked the request and added none, with one of `SKIP_REASONS`. */
export const CARRIER_RESULTS = ['added', 'native', 'skipped'];

/**
 * Why a checked request got no point of its own for its carrier: `no-carrier` the request holds none, `no-native-point` the route's serializer wrote no cache point of its own for the carrier's to follow (caching is off for the route, or the model takes none), `points-full` the route's point limit is already met, `responses-off` the request is an OpenAI Responses one and the owner's switch for its breakpoint is off, and `unsupported` the protocol is none the writer handles or the request is one it does not (an input of another shape, the ChatGPT sign-in lane).
 */
export const SKIP_REASONS = ['no-carrier', 'no-native-point', 'points-full', 'responses-off', 'unsupported'];
