// dsh/src/rpc.js — the `/session-watcher` RPC channel: the DSH tab's endpoints, answered from the watcher table.
// Every payload comes from the shapers and reads the express routes call, so a live session answers what its route answers.
import { getLiveLedger } from '../../lib/rate-lamp-manager.js';
import {
  statusWire, statusWireWithLedger, bucketsPayload, overrideWarnings, pricingResponse, isOverrideMap, INVALID_OVERRIDES_MESSAGE,
} from '../../lib/wire.js';
import { buildTurnBrowse } from '../../lib/turn-browse.js';
import { forLoadedHandoff } from '../../lib/lineage.js';
import {
  loadPricingOverride, savePricingOverride, deletePricingOverride, validatePricingInput, sanitizePresetId, NO_MODEL_MESSAGE,
} from '../../lib/pricing-store.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../../lib/constants.js';
import { writeDiagnostic, handlerFailed } from './watcher-table.js';

const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const live = payload => ({ ok: true, value: { state: 'live', payload } });

/**
 * The channel's handler over `table`.
 * Every payload carries `sessionId`; a session whose entry is not `live` answers its state, and a `failed` one its diagnostic, without reaching a watcher.
 * A session the table has not observed is looked up through `resolvePersisted(sessionId)`: a record it answers is ensured from its header, and the request answers what the table then holds for the id, `bootstrapping` for the entry just ensured and `unobserved` when no record was found.
 * A throw from that lookup or from the ensure is written as a `handler_failed` line under the session and answered as `{ ok: false }` under `handler_failed`, leaving no entry.
 * A `live` entry answers its endpoint's payload, or the route's 4xx as a failure under the route's code and message.
 * A pricing save or delete under the caller's epoch model refreshes the read policies of every live watcher, writes each refresh diagnostic to stderr under its session and publishes each session whose read policies changed.
 * A user-overrides apply publishes the caller's session; no other endpoint publishes.
 * `store` is the store the lineage and the turn browse read; `now` stamps the buckets payload; `publish(sessionId)` signals that a session's readings changed.
 *
 * @param {{ table: { get: Function, live: Function, ensure: Function }, store: object, now?: () => number, publish?: (sessionId: string) => void,
 *   resolvePersisted?: (sessionId: string) => Promise<{ header: { id: string, cwd?: string } }|null> }} options
 * @returns {(endpoint: string, payload: unknown) => Promise<object>}
 */
export function createRpcHandler({ table, store, now = Date.now, publish = () => {}, resolvePersisted = async () => null }) {
  // The policy is the one the watcher meters under, priced at the lifetime its entry declares.
  function pricing({ watcher, cacheTtl }) {
    const model = watcher.getEpochModel() ?? '';
    return pricingResponse({
      model, saved: loadPricingOverride(model), policy: modelPolicyFor(model, cacheTtl ?? DEFAULT_CACHE_TTL), cliRatio: null,
    });
  }

  function refreshLive() {
    for (const { sessionId, watcher } of table.live()) {
      const { changed, diagnostics } = watcher.refreshReadPolicies();
      for (const diagnostic of diagnostics) writeDiagnostic(sessionId, diagnostic);
      if (changed) publish(sessionId);
    }
  }

  function writePricing(entry, write) {
    const model = entry.watcher.getEpochModel() ?? '';
    if (!model) return failure('no_model', NO_MODEL_MESSAGE);
    write(model);
    refreshLive();
    return live(pricing(entry));
  }

  const endpoints = {
    status: ({ watcher }, { sessionId }) => live(statusWireWithLedger(watcher.getStatus(), getLiveLedger(sessionId))),
    history: ({ watcher }) => live(watcher.getHistory()),
    buckets: ({ watcher }, { sessionId }) => live(bucketsPayload({
      bucketData: watcher.getBucketData({ includeSymbols: false }), status: watcher.getStatus(), sessionId, now: now(),
    })),
    'turn/browse': (_entry, { sessionId }) => {
      const { sections } = buildTurnBrowse({ store, lineage: forLoadedHandoff({ store, sessionId }) });
      return live({ sections });
    },
    'user-overrides': ({ watcher }, { sessionId, overrides }) => {
      if (!isOverrideMap(overrides)) return failure('invalid_body', INVALID_OVERRIDES_MESSAGE);
      const warnings = overrideWarnings(watcher.replaceUserOverrides(overrides).warnings);
      const response = statusWire(watcher.getStatus());
      if (warnings.length > 0) response.warnings = warnings;
      const reply = live(response);
      publish(sessionId);
      return reply;
    },
    preview: ({ watcher }, { overrides }) => {
      if (!isOverrideMap(overrides)) return failure('invalid_body', INVALID_OVERRIDES_MESSAGE);
      return live({ scenario: watcher.readScenario(overrides) });
    },
    pricing: entry => live(pricing(entry)),
    'pricing/save': (entry, { readPrice, writePrice, presetId }) => {
      try {
        validatePricingInput({ readPrice, writePrice });
      } catch (error) {
        return failure('invalid_input', error.message);
      }
      return writePricing(entry, model => savePricingOverride(model, { readPrice, writePrice, presetId: sanitizePresetId(presetId) }));
    },
    'pricing/delete': entry => writePricing(entry, deletePricingOverride),
  };

  return async (endpoint, payload) => {
    if (!Object.hasOwn(endpoints, endpoint)) return failure('unknown_endpoint', `unknown endpoint ${endpoint}`);
    const body = payload || {};
    if (typeof body.sessionId !== 'string') return failure('invalid_body', 'Body must contain { sessionId: string }');
    let entry = table.get(body.sessionId);
    if (entry.state === 'unobserved') {
      // A rejected handler reaches the client as a transport failure, so a failure here is answered as an envelope.
      try {
        const record = await resolvePersisted(body.sessionId);
        if (record != null) table.ensure({ id: record.header.id, header: record.header });
      } catch (error) {
        const diagnostic = handlerFailed(error);
        writeDiagnostic(body.sessionId, diagnostic);
        return failure(diagnostic.code, diagnostic.message);
      }
      entry = table.get(body.sessionId);
    }
    if (entry.state !== 'live') return { ok: true, value: entry };
    return endpoints[endpoint](entry, body);
  };
}
