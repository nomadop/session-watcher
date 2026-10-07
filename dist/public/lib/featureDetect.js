// public/lib/featureDetect.js — unified capabilities snapshot
// Capability flags the elements gate on. Landmarks follow the server contract: the reference skeleton
// either exists with every landmark finite or every landmark is null.
export function buildCapabilities(status) {
  const rl = status?.rateLamp;
  const reliable = rl?.reliable === true;
  const hasBillProgress = rl?.billProgress != null && Number.isFinite(rl.billProgress);
  const landmarks = reliable && rl.xSweet != null;
  const landmarkReason = !reliable ? 'calibrating' : !landmarks ? 'reference unavailable' : null;
  return {
    eoqLandmarks: { available: landmarks, reason: landmarkReason },
    billingLedger: { available: hasBillProgress, reason: !hasBillProgress ? 'billing ledger unavailable' : null },
  };
}
