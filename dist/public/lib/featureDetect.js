// public/lib/featureDetect.js — unified capabilities snapshot (§5.6)
import { validateLandmarks } from './xScale.js';

export function buildCapabilities(status) {
  const rl = status?.rateLamp;
  const reliable = rl?.reliable === true;
  const hasBillProgress = rl?.billProgress != null && Number.isFinite(rl.billProgress);
  const hBreakFinite = Number.isFinite(rl?.hBreak);
  const hasLandmarks = rl && Number.isFinite(rl.xSweet) && Number.isFinite(rl.xBrAmberR) && Number.isFinite(rl.wallP);
  const landmarksValid = hasLandmarks ? validateLandmarks(rl) : { ok: false, reason: 'landmarks missing' };

  return {
    pricing: { available: true, reason: null },
    eoqLandmarks: { available: reliable && landmarksValid.ok, reason: !reliable ? 'calibrating' : !landmarksValid.ok ? landmarksValid.reason : null },
    billingLedger: { available: hasBillProgress, reason: !hasBillProgress ? 'billing ledger unavailable' : null },
    breakEvenTurns: { available: reliable && hBreakFinite, reason: !reliable ? 'calibrating' : !hBreakFinite ? 'break-even not computable' : null },
    paretoBand: { available: reliable && landmarksValid.ok, reason: !reliable ? 'calibrating' : !landmarksValid.ok ? landmarksValid.reason : null },
    buckets: { available: false, reason: 'v3 snapshot buckets missing' },
  };
}
