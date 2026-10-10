// lib/wire.js — the wire payload shapers that depend only on `SessionWatcher` reads and injected values.
// The Claude Code host and the DSH host both call them, so each payload shape, a turn page and a delivered load package included, has one home and both hosts answer it byte for byte.
// Selecting the ledger (live or replay), reading the watcher, parsing `?symbols=1`, the 409/400 gates and SSE all stay with their caller.
import { mergeLedgerIntoStatus } from './rate-lamp-manager.js';
import { lampZone } from './bill-regret.js';
import { stateKeyForStatus } from './rate-lamp-store.js';
import { fromHandoff } from './lineage.js';
import { lineageHeadlines } from './turn-browse.js';

/**
 * `POST /api/user-overrides`'s response shape: rename the application's opaque `sourceLocator` to
 * the retained `transcriptPath` wire field and stamp `lamp`, the statusline lamp's `lampZone` of a
 * reliable `rateLamp` and null while measuring — no ledger merge, no `rateLamp` field this status
 * did not already carry.
 */
export function statusWire(status) {
  const { sourceLocator, ...rest } = status;
  const rateLamp = status.rateLamp;
  const lamp = rateLamp?.reliable ? lampZone(rateLamp.br, { u: rateLamp.u, mf: rateLamp.mf }) : null;
  return { ...rest, transcriptPath: sourceLocator ?? null, lamp };
}

/**
 * `GET /api/status`'s own two steps, in the same order: `statusWire`'s rename and lamp, then merge the
 * given ledger in under the reliable status's own stateKey; the merge leaves `br`, `u` and `mf` as
 * they were, so the lamp agrees with the statusline. `ledger` is required and null is allowed —
 * that route merges whatever ledger it selected, a null one included, and a null ledger still stamps
 * the wallet defaults `mergeLedgerIntoStatus` always attaches.
 */
export function statusWireWithLedger(status, ledger) {
  const payload = statusWire(status);
  const currentKey = payload.rateLamp?.reliable ? stateKeyForStatus(payload) : null;
  mergeLedgerIntoStatus(payload, ledger, currentKey);
  return payload;
}

/**
 * The reading `watcher_status` answers: the quantities `formatLine` (`lib/statusline-format.js`) draws the
 * statusline from, each taken the way `formatLine` takes it — `lamp` is the zone `statusWire` stamped, `phase`
 * the wallet clock's `depthProgress` while `rentMeter.depthActive` and null otherwise, `B` is `bDefault ?? B`,
 * `alert` the stop event's message or null. A measuring payload (`reliable` false) nulls `lamp`, `phase`, `br`,
 * `u`, `gEma` and `alert`; `model`, `L` and `B` stay. `mf` only decides the lamp, so it is not in the reading.
 * `payload` is a `statusWireWithLedger` result. `rateLamp.reliable` is read bare: a body
 * that is no status payload, a route's `{ error }` included, throws instead of passing for a measuring reading.
 * Every key is present, null where it has no value, so a JSON round trip keeps the key set.
 */
export function statusDigest(payload) {
  const rl = payload.rateLamp;
  const reliable = Boolean(rl.reliable);
  const base = { reliable, model: payload.model, L: payload.L, B: payload.bDefault ?? payload.B };
  if (!reliable) return { ...base, lamp: null, phase: null, br: null, u: null, gEma: null, alert: null };
  return {
    ...base,
    lamp: payload.lamp,
    phase: rl.rentMeter?.depthActive ? rl.rentMeter.depthProgress : null,
    br: rl.br, u: rl.u, gEma: rl.gEma,
    alert: rl.lastStopEvent?.message ?? null,
  };
}

/**
 * `GET /api/buckets`'s body: the bucket data spread with each path row's `lastTurn` also under the
 * wire's snake_case `last_active_turn`, beside the session identity and the metrics `/api/status`
 * already carries.
 */
export function bucketsPayload({ bucketData, status, sessionId, now }) {
  const paths = bucketData.paths.map(p => ({ ...p, last_active_turn: p.lastTurn }));
  return {
    ...bucketData, paths,
    session_id: sessionId,
    segment: bucketData.segment,
    current_turn: bucketData.currentTurnSeq,
    generated_at: now,
    metrics: { br: status.br, mf: status.mf, pp: status.pp, g: status.g, b_total: status.B, c_ratio: status.cRatio },
  };
}

/**
 * `get_bucket_summary`'s body: the handoff decision's view of a `bucketsPayload`. A row keeps the fields the
 * keep/discard choice reads — its identity, size, read and edit counts, default selection with the reason where
 * one applies, the user's override and the active symbols — beside the session identity, the segment the
 * prepare step echoes back and the `br` the skill's light-context note reads. The per-touch history, spend
 * ratios, totals, residual groups and the other metrics the dashboard panels render stay on `/api/buckets`;
 * sizes round to whole tokens.
 */
export function bucketSummaryPayload(payload) {
  const row = ({ tokens, readCount, editCount, defaultSelected, defaultDiscardReason, userOverride, activeSymbols }) => ({
    tokens: Math.round(tokens), readCount, editCount, defaultSelected,
    ...(defaultDiscardReason ? { defaultDiscardReason } : {}),
    userOverride,
    ...(activeSymbols ? { activeSymbols } : {}),
  });
  return {
    skills: payload.skills.map(s => ({ name: s.name, ...row(s) })),
    paths: payload.paths.map(p => ({ path: p.path, ...row(p) })),
    session_id: payload.session_id, segment: payload.segment,
    metrics: { br: payload.metrics.br },
  };
}

/**
 * `POST /api/user-overrides`'s baseline warning strings: the wording is a wire fact and the Engine
 * has no wire, so this is the one place a rejected entry's structure becomes the sentence a
 * consumer reads.
 */
export function overrideWarnings(warnings) {
  return (warnings ?? []).map(w => (w.code === 'unknown_resource'
    ? `ignored: path "${w.resourceKey}" not in current bRebuild`
    : `ignored: invalid value "${w.value}" for path "${w.resourceKey}"`));
}

/** The message both hosts answer `invalid_body` with when an override or preview body's `overrides` fails `isOverrideMap`. */
export const INVALID_OVERRIDES_MESSAGE = 'Body must contain { overrides: { path: "include"|"exclude" } }';

/** Whether `overrides` is the path-keyed object an override or preview body carries: an object, not an array or null. */
export function isOverrideMap(overrides) {
  return Boolean(overrides) && typeof overrides === 'object' && !Array.isArray(overrides);
}

/**
 * `GET /api/pricing`'s body: saved > preset-drift > cli > model_default precedence over the
 * effective ratio, beside the model default and the preset table the policy already resolved.
 */
export function pricingResponse({ model, saved, policy, cliRatio }) {
  const modelRatio = policy.cRatio;
  const presets = policy.pricing.presets;

  let effectiveRatio, source, effectiveRead = null, effectiveWrite = null;
  if (saved) {
    effectiveRatio = saved.ratio; source = 'saved';
    effectiveRead = saved.readPrice; effectiveWrite = saved.writePrice;

    if (saved.presetId) {
      const preset = presets.find(p => p.id === saved.presetId);
      if (preset && preset.readPrice === saved.readPrice && preset.writePrice === saved.writePrice) {
        source = 'preset';
      }
    }
  } else if (cliRatio != null) {
    effectiveRatio = cliRatio; source = 'cli';
  } else {
    effectiveRatio = modelRatio; source = 'model_default';
  }

  return {
    effective: { ratio: effectiveRatio, readToWrite: 1 / effectiveRatio, source, readPrice: effectiveRead, writePrice: effectiveWrite },
    saved: saved || null,
    modelDefault: { model, ratio: modelRatio, readPrice: policy.pricing.readPrice, writePrice: policy.pricing.writePrice },
    presets,
  };
}

/**
 * Maps `buildTurnPage`'s internal `{ turnPage, nextBefore }` to the wire shape. The cursor travels bare: load injection, `GET /api/turn/page` and the `turn_page` tool all call this, so all three are byte-identical for one head and one persisted state.
 */
export function turnPageWire({ turnPage, nextBefore }) {
  return {
    turn_page: turnPage,
    ...(nextBefore ? { next_before: nextBefore } : {}),
  };
}

/**
 * Enrich a delivered package with its lineage headlines and its turn page, or attach `turn_page_error` on failure. Both projections sit inside the same try and share its error name, so a fault in either drops both: the reply keeps the core handoff and carries neither. `store` is the instance, resolved by the caller.
 */
export async function loadedHandoffPayload(core, { store, turnPageBuilder, dialogueSource, dialogueProjection, notice }) {
  try {
    const sessions = fromHandoff({ store, handoffId: core.handoff_id });
    return {
      ...core,
      lineage: lineageHeadlines({ store, lineage: sessions }),
      ...turnPageWire(await turnPageBuilder({ store, lineage: sessions, dialogueSource, dialogueProjection, notice })),
    };
  } catch (err) {
    if (process.env.SW_DEBUG) console.error('[turn_page_load]', err);
    return { ...core, turn_page_error: 'turn_page_unavailable' };
  }
}
