// lib/line-calibrator.js
/**
 * Runtime line-offset calibrator using pair-level SPRT.
 *
 * Detects whether a tool's reported line numbers need an offset to align with
 * Read's 1-based numbering. Locks within 3 informative pairs. After lock,
 * serves as a debug assertion (counts post-lock mismatches for SW_DEBUG logging).
 *
 * Corpus-validated defaults:
 *   serena_find_symbol: +1 (0-based, n=353, 86.7% match)
 *   bash_grep_n:        +0 (1-based, n=6316, 98.4% match)
 */

const DEFAULT_OFFSETS = {
  serena_find_symbol: 1,
  bash_grep_n: 0,
};

const CANDIDATE_OFFSETS = [0, 1, -1];

// SPRT parameters (pair-level)
const ALPHA = 0.05;  // false positive rate
const BETA = 0.05;   // false negative rate
const P0 = 0.05;     // match rate under wrong offset (noise)
const P1 = 0.30;     // match rate under correct offset (conservative)
const UPPER_BOUND = Math.log((1 - BETA) / ALPHA);
const LOWER_BOUND = Math.log(BETA / (1 - ALPHA));

export class LineCalibrator {
  constructor() {
    // Per-tool state: { llr: Map<offset, number>, decision: offset|null, mismatchCount }
    this._tools = new Map();
  }

  _ensure(toolId) {
    let state = this._tools.get(toolId);
    if (!state) {
      state = {
        llr: new Map(CANDIDATE_OFFSETS.map(o => [o, 0])),
        decided: null,        // the offset that won
        rejected: new Set(),  // offsets ruled out
        mismatchCount: 0,     // post-lock contradictions
      };
      this._tools.set(toolId, state);
    }
    return state;
  }

  /**
   * Feed one calibration pair (one tool invocation on a file with Read ground truth).
   * @param {string} toolId - e.g. 'serena_find_symbol'
   * @param {Array<{num: number, content: string}>} toolLines - lines as reported by the tool
   * @param {Map<number, string>} truthMap - Read ground truth: lineNum → content
   */
  observePair(toolId, toolLines, truthMap) {
    const state = this._ensure(toolId);

    // Score each candidate offset for this pair
    const scores = new Map();
    for (const offset of CANDIDATE_OFFSETS) {
      let hits = 0, total = 0;
      for (const { num, content } of toolLines) {
        const truthContent = truthMap.get(num + offset);
        if (truthContent == null) continue;
        total++;
        if (truthContent === content) hits++;
      }
      scores.set(offset, { hits, total, rate: total > 0 ? hits / total : 0 });
    }

    // Determine winner
    const bestRate = Math.max(...[...scores.values()].map(s => s.rate));
    if (bestRate < 0.05) return; // uninformative pair

    // Post-lock mismatch detection
    if (state.decided != null) {
      const decidedScore = scores.get(state.decided);
      if (decidedScore && decidedScore.total > 0 && decidedScore.rate < 0.1) {
        state.mismatchCount++;
      }
      return; // don't update SPRT after lock
    }

    // Update SPRT for each offset
    for (const offset of CANDIDATE_OFFSETS) {
      if (state.rejected.has(offset)) continue;
      const { rate } = scores.get(offset);
      const isWinner = rate >= bestRate * 0.8 && rate > 0.1;
      const llr = state.llr.get(offset) + (isWinner
        ? Math.log(P1 / P0)
        : Math.log((1 - P1) / (1 - P0)));
      state.llr.set(offset, llr);

      if (llr >= UPPER_BOUND) {
        state.decided = offset;
        return;
      } else if (llr <= LOWER_BOUND) {
        state.rejected.add(offset);
      }
    }
  }

  /** Get the offset to apply for a tool. Uses decided value, or falls back to default. */
  getOffset(toolId) {
    const state = this._tools.get(toolId);
    if (state?.decided != null) return state.decided;
    return DEFAULT_OFFSETS[toolId] ?? 0;
  }

  /** Whether the calibrator has locked on an offset for this tool. */
  isLocked(toolId) {
    return this._tools.get(toolId)?.decided != null;
  }

  /** Post-lock mismatch count (for debug logging). */
  getMismatchCount(toolId) {
    return this._tools.get(toolId)?.mismatchCount ?? 0;
  }
}
