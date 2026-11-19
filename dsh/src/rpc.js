// dsh/src/rpc.js — the `/session-watcher` RPC channel: the DSH tab's endpoints, answered from the watcher table.
// Every payload but `handoff/list`'s comes from the shapers and reads the express routes call, so a live session answers what its route answers; the handoff catalog has no route.
import { getLiveLedger } from '../../lib/rate-lamp-manager.js';
import {
  statusWire, statusWireWithLedger, bucketsPayload, overrideWarnings, pricingResponse, isOverrideMap, INVALID_OVERRIDES_MESSAGE,
} from '../../lib/wire.js';
import { buildTurnBrowse } from '../../lib/turn-browse.js';
import { forLoadedHandoff } from '../../lib/lineage.js';
import { formatAge } from '../../lib/handoff-discovery.js';
import {
  loadPricingOverride, savePricingOverride, deletePricingOverride, validatePricingInput, sanitizePresetId, NO_MODEL_MESSAGE,
} from '../../lib/pricing-store.js';
import { modelPolicyFor } from '../../lib/model-policy.js';
import { DEFAULT_CACHE_TTL } from '../../lib/constants.js';
import { writeDiagnostic, handlerFailed, hostDiagnostic } from './watcher-table.js';

const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const live = payload => ({ ok: true, value: { state: 'live', payload } });
const MODE_UNAVAILABLE = failure('inner_mode_unavailable', 'The inner compaction mode is not available in this host.');
const MONITOR_UNAVAILABLE = failure('inner_monitor_unavailable', 'The inner compaction monitor is not available in this host.');
const FORBIDDEN = failure('forbidden', 'Only the owner of this host can manage the carrier cache.');
const CARRIER_CACHE_UNAVAILABLE = failure('carrier_cache_unavailable', 'The carrier cache switch is not available in this host.');
const MONITOR_NOT_COMMITTED = failure('inner_monitor_not_committed', 'The inner compaction attempt has no committed seal, so it has no slots.');

/**
 * The channel's handler over `table`.
 * Every payload carries `sessionId`; a session whose entry is not `live` answers its state, and a `failed` one its diagnostic, without reaching a watcher.
 * A session the table has not observed goes through `resolvePersisted(sessionId)`, which ensures the persisted record it finds and answers it or null; the request answers what the table then holds for the id, `bootstrapping` for the entry just ensured and `unobserved` when no record was found.
 * A throw from that call is written as a `handler_failed` line under the session and answered as `{ ok: false }` under `handler_failed`, leaving no entry.
 * A `live` entry answers its endpoint's payload, or the route's 4xx as a failure under the route's code and message.
 * A pricing save or delete under the caller's epoch model refreshes the read policies of every live watcher, writes each refresh diagnostic to stderr under its session and publishes each session whose read policies changed.
 * A user-overrides apply publishes the caller's session; no other endpoint publishes.
 * `inner-mode` and `inner-mode/select` answer from the session mode's access (`innerMode()`, null while none is published) straight after the body check, before the table and the persisted listing, so a bootstrapping, failed or unobserved measurement changes neither: `inner-mode` awaits the access's `display` and answers `{ mode, locked }`, and `inner_mode_unavailable` when no access is published or the session is neither held nor stored with a turn started; a throw or a rejection from the read is one `inner_mode_read_failed` line under the session and the same failure as an envelope, never a failed request. `inner-mode/select` with a boolean `enabled` answers from the held instance alone, synchronously, `{}` once it has appended the record, `inner_mode_locked` once a turn has started, and `inner_mode_unavailable` at once when no access is published or the host holds no such live session. Their notification is the session/event listener's, so neither publishes.
 * `inner-monitor` answers from the monitor's access (`innerMonitor()`, null while none is published) at the same place, so the measurement's state changes nothing there either: it answers the access's `rows` as `{ attempts, handoffs }`, and `inner_monitor_unavailable` when no access is published or the access answers `undefined` for a session that is neither held nor stored. Every method of the access is awaited, and a throw or a rejection from it is one `inner_monitor_read_failed` line under the session and the same failure as an envelope, never a failed request. It publishes nothing.
 * `inner-monitor/call`, `inner-monitor/slots`, `inner-monitor/slot` and `inner-monitor/handoff` answer the access's `call`, `slots`, `slot` and `handoff` the same way, an `attempt`, `slot` or `handoff` (the seq of the handoff's payload message, the `id` of its row) that is not a non-negative safe integer being `invalid_body` with the access not consulted. The access's closed `{ kind: 'not_committed' }` for an attempt with no carrier is `inner_monitor_not_committed`; an address or a fact the access cannot find is its throw, so `inner_monitor_read_failed`, and only an absent access or a session neither held nor stored is `inner_monitor_unavailable`.
 * `pi-ai/status` names no session and answers before any session is looked up: `{ failure }`, null or the `{ cause }` of the opt-in pi-ai entry (`pi-ai-integration.js`) that `piAiFailure()` reads at each call, null while that entry is not mounted or serves its routes.
 * `carrier-cache/status` and `carrier-cache/set` name no session and answer for the owner of the host alone: the fourth argument of the channel's handler is the `PeerScope` the connection layer admitted the call for, and a call whose `peer.principal.kind` is not `owner` (or that has no peer) is `forbidden` before the switch (`carrierCache()`, null where the host holds none, `carrier_cache_unavailable`) is read. The bundles the switch acts on and the one package it may install are fixed in the switch; the body of `set` is `{ enabled: boolean, confirmInstall?: boolean }` and nothing else is read, `confirmInstall` counting only as the literal `true`.
 * `store` is the store the lineage and the turn browse read; `now` stamps the buckets payload; `publish(sessionId)` signals that a session's readings changed.
 *
 * @param {{ table: { get: Function, live: Function }, store: object, now?: () => number, publish?: (sessionId: string) => void,
 *   piAiFailure?: () => ({ cause: string }|null),
 *   carrierCache?: () => ({ status: () => Promise<object>, set: (enabled: boolean, options: { confirmInstall: boolean }) => Promise<object> } | null),
 *   resolvePersisted?: (sessionId: string) => Promise<object|null>,
 *   innerMode?: () => ({ display: (sessionId: string) => Promise<object|undefined>, select: (sessionId: string, enabled: boolean) => string } | null),
 *   innerMonitor?: () => ({ rows: (sessionId: string) => Reply, call: (sessionId: string, attempt: number) => Reply, slots: (sessionId: string, attempt: number) => Reply,
 *     slot: (sessionId: string, attempt: number, slot: number) => Reply, handoff: (sessionId: string, handoff: number) => Reply } | null) }} options `Reply` is `(object|undefined|Promise<object|undefined>)`, the payload of the endpoint, `{ kind: 'not_committed' }` or `undefined`
 * @returns {(endpoint: string, payload: unknown, signal?: AbortSignal, peer?: { principal: { kind: string } }) => Promise<object>}
 */
export function createRpcHandler({
  table, store, now = Date.now, publish = () => {}, resolvePersisted = async () => null, innerMode = () => null, innerMonitor = () => null,
  piAiFailure = () => null, carrierCache = () => null,
}) {
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
    // A Store failure rejects the call, which the carrier answers as a transport failure; no empty catalog stands in for it.
    // The Host shapes each item's age, since the Client imports no `lib/`.
    'handoff/list': ({ watcher }) => live({
      items: watcher.listHandoffCandidates().map(({ loadToken, createdAt, nextTask, deliveredAt }) => ({
        loadToken, age: formatAge(createdAt), nextTask, deliveredAt,
      })),
    }),
  };

  // The selection answers synchronously from the call, so its lock check and append share one stretch; the read awaits, which no selection waits on.
  const modeEndpoints = {
    'inner-mode': async ({ sessionId }) => {
      try {
        const state = await innerMode()?.display(sessionId);
        return state === undefined ? MODE_UNAVAILABLE : { ok: true, value: { mode: state.mode, locked: state.locked } };
      } catch (error) {
        const diagnostic = hostDiagnostic('inner_mode_read_failed', error);
        writeDiagnostic(sessionId, diagnostic);
        return failure(diagnostic.code, diagnostic.message);
      }
    },
    'inner-mode/select': ({ sessionId, enabled }) => {
      if (typeof enabled !== 'boolean') return failure('invalid_body', 'Body must contain { sessionId: string, enabled: boolean }');
      const outcome = innerMode()?.select(sessionId, enabled);
      if (outcome === 'selected') return { ok: true, value: {} };
      if (outcome === 'locked') return failure('inner_mode_locked', 'The inner compaction mode can no longer be chosen once the session has started a turn.');
      return MODE_UNAVAILABLE;
    },
  };

  // Each names the addresses its body carries and reads its access method. `undefined` is what the access answers for a session that is neither held nor stored, and what no published access amounts to.
  const monitorEndpoints = {
    'inner-monitor': { addresses: [], read: (access, { sessionId }) => access?.rows(sessionId) },
    'inner-monitor/call': { addresses: ['attempt'], read: (access, { sessionId, attempt }) => access?.call(sessionId, attempt) },
    'inner-monitor/slots': { addresses: ['attempt'], read: (access, { sessionId, attempt }) => access?.slots(sessionId, attempt) },
    'inner-monitor/slot': { addresses: ['attempt', 'slot'], read: (access, { sessionId, attempt, slot }) => access?.slot(sessionId, attempt, slot) },
    'inner-monitor/handoff': { addresses: ['handoff'], read: (access, { sessionId, handoff }) => access?.handoff(sessionId, handoff) },
  };
  const isAddress = value => Number.isSafeInteger(value) && value >= 0;

  // Awaited whatever the access method is, so a throw and a rejection take the one conversion.
  async function answerMonitor(endpoint, body) {
    const { addresses, read } = monitorEndpoints[endpoint];
    if (!addresses.every(name => isAddress(body[name]))) {
      return failure('invalid_body', `Body must contain { sessionId: string${addresses.map(name => `, ${name}: non-negative integer`).join('')} }`);
    }
    try {
      const value = await read(innerMonitor(), body);
      if (value === undefined) return MONITOR_UNAVAILABLE;
      return value.kind === 'not_committed' ? MONITOR_NOT_COMMITTED : { ok: true, value };
    } catch (error) {
      const diagnostic = hostDiagnostic('inner_monitor_read_failed', error);
      writeDiagnostic(body.sessionId, diagnostic);
      return failure(diagnostic.code, diagnostic.message);
    }
  }

  // Each reads the switch and answers its value; a throw from it is one line and the failure envelope, never a failed request.
  const carrierEndpoints = {
    'carrier-cache/status': (access) => access.status(),
    'carrier-cache/set': (access, body) => access.set(body.enabled, { confirmInstall: body.confirmInstall === true }),
  };

  async function answerCarrierCache(endpoint, payload, peer) {
    if (peer?.principal?.kind !== 'owner') return FORBIDDEN;
    const body = payload || {};
    if (endpoint === 'carrier-cache/set' && typeof body.enabled !== 'boolean') return failure('invalid_body', 'Body must contain { enabled: boolean }');
    const access = carrierCache();
    if (access === null) return CARRIER_CACHE_UNAVAILABLE;
    try {
      return { ok: true, value: await carrierEndpoints[endpoint](access, body) };
    } catch (error) {
      const diagnostic = hostDiagnostic('carrier_cache_failed', error);
      writeDiagnostic(null, diagnostic);
      return failure(diagnostic.code, diagnostic.message);
    }
  }

  return async (endpoint, payload, _signal, peer) => {
    if (endpoint === 'pi-ai/status') return { ok: true, value: { failure: piAiFailure() } };
    if (Object.hasOwn(carrierEndpoints, endpoint)) return answerCarrierCache(endpoint, payload, peer);
    if (!Object.hasOwn(endpoints, endpoint) && !Object.hasOwn(modeEndpoints, endpoint) && !Object.hasOwn(monitorEndpoints, endpoint)) {
      return failure('unknown_endpoint', `unknown endpoint ${endpoint}`);
    }
    const body = payload || {};
    if (typeof body.sessionId !== 'string') return failure('invalid_body', 'Body must contain { sessionId: string }');
    if (Object.hasOwn(modeEndpoints, endpoint)) return modeEndpoints[endpoint](body);
    if (Object.hasOwn(monitorEndpoints, endpoint)) return answerMonitor(endpoint, body);
    let entry = table.get(body.sessionId);
    if (entry.state === 'unobserved') {
      // A rejected handler reaches the client as a transport failure, so a failure here is answered as an envelope.
      try {
        await resolvePersisted(body.sessionId);
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
