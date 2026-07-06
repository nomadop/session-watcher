import { CONSTANTS } from './constants.js';
import { median } from './stats.js';

// Knee = end of warmup: the first t >= kneeMinTurn where the next up-to-4 deltas are all
// below kneeBgMult × the median of the LATER (stable-region) deltas. Relative,
// self-scaling — never an absolute token threshold (spec: absolute → ±75% drift).
export function detectKnee(cacheReadSeq, opts = {}) {
  const kneeBgMult = opts.kneeBgMult ?? CONSTANTS.KNEE_BG_MULT;
  const kneeMinTurn = opts.kneeMinTurn ?? CONSTANTS.KNEE_MIN_TURN;
  const dead = cacheReadSeq[0] ?? 0;
  const deltas = [];
  for (let i = 1; i < cacheReadSeq.length; i++) deltas.push(Math.max(0, cacheReadSeq[i] - cacheReadSeq[i - 1]));

  // stable-region estimate = median of the back half of deltas (post-warmup)
  const backHalf = deltas.slice(Math.floor(deltas.length / 2));
  const stableMedian = median(backHalf.length ? backHalf : deltas) || 1;
  const bg = kneeBgMult * stableMedian;

  const LOOKAHEAD = 4;
  // Minimum-evidence bar: a knee must be corroborated by at least MIN_EVIDENCE consecutive
  // below-bg deltas so a single small final delta can't spuriously declare a knee. Away from
  // the tail this is a no-op (a full LOOKAHEAD=4 window is available); only near the end does
  // the window shrink — down to MIN_EVIDENCE, never below (#12: the old guard used
  // `deltas.length - t + 1`, one too many, so it broke on the FIRST short window and a genuine
  // knee in the final <4 deltas was never checked → early fallback pinned the baseline).
  const MIN_EVIDENCE = 2;
  for (let t = kneeMinTurn; t < cacheReadSeq.length; t++) {
    const window = deltas.slice(t, t + LOOKAHEAD); // deltas leaving turn t (shrinks near tail)
    // Stop once too few deltas remain to meet the evidence bar (also covers the empty window
    // at t === deltas.length). The genuine no-knee case (no all-below-bg window) still falls
    // through to the fallback below.
    if (window.length < MIN_EVIDENCE) break;
    if (window.every(d => d < bg)) {
      return { kneeTurn: t, taskCtx: Math.max(0, cacheReadSeq[t] - dead), isRealKnee: true };
    }
  }
  const fallback = Math.min(kneeMinTurn, cacheReadSeq.length - 1);
  return { kneeTurn: fallback, taskCtx: Math.max(0, (cacheReadSeq[fallback] ?? dead) - dead), isRealKnee: false };
}
