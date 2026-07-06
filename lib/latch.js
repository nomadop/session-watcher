import { CONSTANTS } from './constants.js';

// Restart-credibility gate as a pure function (spec §2.3) — shared by getStatus's calibratingReason
// and the latch's "may we freeze?" decision, so the two can never drift. Reason order matches the
// pre-refactor getStatus ladder. NOTE: 'no_transcript' is NOT here — it needs _transcriptSeen and is
// applied by getStatus only (it never affects the latch, which scans non-empty warmup prefixes).
export function computeCalibrationGate({ metricsReliable, confidence, postKneeGrowthCalls, baselineTotal, L }) {
  if (!metricsReliable) return { passed: false, reason: 'metrics_unreliable' };
  if (confidence < CONSTANTS.BASELINE_CONF_MIN) return { passed: false, reason: 'low_confidence' };
  if (postKneeGrowthCalls < 3 || baselineTotal <= 0 || L <= baselineTotal) return { passed: false, reason: 'insufficient_data' };
  return { passed: true, reason: null };
}

// Call identity for latch fingerprints (spec §2.1, fail-closed). Field name varies by shape.
export function callIdentity(c) { return c?.messageId ?? c?.message?.id ?? c?.id ?? null; }

// The frozen baseline object. total is DERIVED from dead+taskCtx, never stored on the entry
// (spec §2.2 / §10.7) so downstream baseline.total can never diverge from L_base.
export function applyFrozen(entry) {
  return { dead: entry.dead, task: entry.taskCtx, total: entry.dead + entry.taskCtx,
    source: 'latched', confidence: 0.92, kneeTurn: entry.kneeTurn, isRealKnee: true };
}

// Build a fingerprinted entry from a LIVE baseline computed on prefix[0..latchIndex]. Returns null
// (do not latch) if either fingerprint id is unavailable — fail-closed, no unfingerprinted entry.
export function makeLatchEntry(live, prefixSlice) {
  const segmentStartCallId = callIdentity(prefixSlice[0]);
  const latchIndex = prefixSlice.length - 1;
  const latchCallId = callIdentity(prefixSlice[latchIndex]);
  if (!segmentStartCallId || !latchCallId) return null;
  return { dead: live.baseline.dead, taskCtx: live.baseline.task, kneeTurn: live.baseline.kneeTurn,
    latchIndex, latchCallId, segmentStartCallId };
}

// Validate a cached entry against the current prefix (spec §2.1 fingerprint check). Any failure →
// discard (return null) → re-calibrate live. Guards segment-id reuse after replay/reset.
export function validateLatch(entry, prefix) {
  if (!entry) return null;
  if (entry.segmentStartCallId !== callIdentity(prefix[0])) return null;
  if (!(entry.latchIndex < prefix.length)) return null;
  if (entry.latchCallId !== callIdentity(prefix[entry.latchIndex])) return null;
  return entry;
}
