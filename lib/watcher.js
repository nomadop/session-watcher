import nodePath from 'node:path';
import { cRatioFor, contextWindowFor } from './extract.js';
import { RESERVED_OUTPUT, CTX_SAFETY_MARGIN, G_FLOOR } from './constants.js';
import { effectiveL } from './l-measure.js';
import { computeFullCarryBurnRate } from './rate-lamp.js';
import { poll } from './fold.js';
import { getHistory } from './history.js';
import { BRebuild, gEffective } from './measure.js';
import { ctpForModel } from './extract.js';
import { nucleus } from './landmarks.js';
import { computeMovableFrac, computeBr, isInDeepWater, BR_AMBER } from './bill-regret.js';
import { discardReason } from './gitignore.js';

// Re-exported so existing importers (server.js, tests) keep a single entry point while the
// implementations live in focused modules.
export { effectiveL, classifyMiss } from './l-measure.js';

export class SessionWatcher {
  constructor(jsonlPath, lbase = null, opts = {}) {
    this.path = jsonlPath;
    this.injectedDead = lbase;              // dead bottom from launcher, or null to detect
    this.fitWindow = opts.fitWindow ?? 20;
    this.ratioOverride = opts.ratioOverride ?? null;  // --ratio manual override (model price may change)
    this._offset = 0;                        // byte offset of last complete line consumed
    this._partial = '';                      // buffered trailing partial line
    this._decoder = null; // initialized lazily in readNewText (H3: StringDecoder)
    this._calls = [];                        // folded API-call records (all segments)
    this._byId = new Map();                  // messageId → index into _calls (current segment)
    this._segment = 0;
    // RV-C7: fold-pipeline sequence counters (Task 2.7). `_foldedCallSeq` = monotonic count of genuinely
    // NEW folded calls (the ledger idempotency key); `_turnSeq` = monotonic count of REAL transcript turns
    // (user↔assistant boundaries, NOT per-poll). `_pendingTurnBump` defers the bump to the NEXT assistant
    // call, so a `user` line with no following assistant call yet does not create an empty turn.
    this._foldedCallSeq = 0;
    this._turnSeq = 0;
    this._pendingTurnBump = false;
    // Running per-segment max of the CONTEXT STOCK = cacheRead + cacheCreation. Segmentation triggers
    // on a drop in this TOTAL, not on cacheRead alone: a mid-session cache EXPIRY (cacheRead≈0 while
    // cache_creation re-carries the full context) leaves total unchanged → no false L=0 segment; a
    // real /clear|/compact shrinks the whole context → total drops → segment (see _foldCall for the
    // one residual false-negative this trades away). L itself (every metric/status/history field)
    // stays cacheRead — only the segmentation TRIGGER changed.
    this._segmentModel = null;               // model/ratio locked at segment creation
    this._ino = null;                        // inode of the watched file (rotation guard)
    // #13: has the transcript path EVER been opened successfully? A never-openable path (bad
    // --transcript/--project) otherwise looks identical to healthy warmup (both yield zero calls →
    // 'insufficient_data'). Flag-on-first-successful-open (not existsSync-at-status): survives a
    // file that appears later — once seen it never reverts to no_transcript — and needs no extra
    // syscall at status time.
    this._transcriptSeen = false;
    // H1: getHistory memoization. `_foldRev` is a monotonic counter bumped in _foldCall on every
    // MUTATING (in-place) fold — the one invalidation hazard a length-only check misses, because an
    // in-place fold leaves _calls.length unchanged while rewriting a call an earlier point depends on.
    // `_historyCache` holds the last emitted points plus the exact inputs they were computed from
    // (fitWindow, _calls consumed, _foldRev snapshot) and the running per-segment accumulators, so a
    // later getHistory can reuse a still-valid prefix and compute only the appended tail. Any mismatch
    // → full rebuild (today's proven code path). See getHistory for the reuse/invalidate decision.
    this._foldRev = 0;
    this._historyCache = null;
    // M9: branch indexer state
    this._uuidToParent = new Map();  // uuid → parentUuid
    this._uuidChildren = new Map();  // uuid → Set<child uuid>
    this._latestUuid = null;
    this._activeLeafUuid = null;
    this._firstRootUuid = null;      // first null-parent uuid seen (session origin)
    this._compactDetected = false;   // topology signal: non-first null-parent root arrived
    // v3 continuous-B measurement layer (spec §2). B_rebuild is in-memory only, rebuilt from transcript
    // on restart (Stream A replay). CTP is resolved once from the first usage row's model.
    this.cwd = opts.cwd || null;
    this._isIgnored = typeof opts.isIgnored === 'function' ? opts.isIgnored : null;  // injected; null → all kept
    this._bRebuild = new BRebuild();
    this._ctp = null;                 // resolved lazily on first usage row (ctpForModel)
    this._segmentEpoch = 0;           // bumped on segment reset; stale-epoch tool_results are discarded
    this._pendingTool = new Map();    // tool_use_id → { adapter, input, path, epoch }
    this._g_ema = null;               // set on first ΔResidual (Stream B, Task 11); floored via gEffective
    this._prevB = 0;                  // B snapshot at the previous usage row (for ΔB and classifyMiss)
    this._prevL = null;               // L at the previous usage row (for ΔL)
    this._ctpOvershoot = 0;           // accumulated CTP overestimate (tokens); reset on segment boundary
    this._prevTotalStock = 0;         // for segment-boundary detection (Task 11)
    this._residualByTool = new Map();  // name → { tokens, lastTurn, kind, detail } — display-layer residual breakdown (spec §11.3.2)
    this._turnResidualTools = [];      // per-turn buffer of { key, kind, detail, weight }; drained into _residualByTool by foldCall
    this._pendingResidual = new Map(); // tool_use_id → { key, kind, detail, inputLen, epoch, turn } for unmatched Bash/MCP
    this._intervalPathDeltas = new Map(); // §2.5: per-path B deltas accumulated between usage rows; consumed by foldCall for CTP correction
    this._completedSkills = new Map();    // tool_use_id → { path, epoch }; for isMeta skill content attribution
    this._startMs = this._nowMs();
  }

  // JSONL ingest + fold + segmentation live in fold.js (readNewText/foldCall/poll take this instance
  // and mutate its private state identically). poll() delegates so the public method surface and all
  // `w._calls/_segment/_foldRev` post-poll reads are unchanged.
  poll() { return poll(this); }

  // v3 segment boundary (spec §6.6): compact = clear = reset. B's state follows the API's state.
  segmentReset() {
    this._bRebuild.clear();
    this._bRebuild.setDead(0);   // re-anchored from the next call's max(cr, cc, input)
    this._g_ema = G_FLOOR;
    this._ctpOvershoot = 0;
    this._prevB = 0;
    this._prevL = null;
    this._prevTotalStock = 0;
    this._ctp = null;
    this._segmentEpoch++;        // pending tool_use from prior epoch discarded on match
    this._segment++;
    this._byId.clear();
    this._pendingTool.clear();
    this._residualByTool.clear();
    this._turnResidualTools = [];
    this._pendingResidual.clear();
    this._intervalPathDeltas = new Map();
    if (this._completedSkills) this._completedSkills.clear();
    this._reasoningAttributionDisabled = false; // §2.4 reset: new segment starts fresh
  }

  _currentSegmentCalls() {
    return this._calls.filter(c => c.segment === this._segment);
  }

  // v2.1: reducer samples for current-segment folded calls newer than sinceSeq (A1). Each call's
  // burnRate is computed from the SAME frozen baseline (B_post/B_rebuild) so per-call integration is
  // exact; L_read is effectiveL (never raw cacheRead). turnSeq is per-RECORD (Task 2.7 real boundary),
  // so a multi-turn poll integrates each call under its own turn. `reliable` is segment-level (a
  // genuinely unreliable segment is gated out before this is called).
  rateLampSamplesSince(sinceSeq, { B_post, B_rebuild, cRatio, reliable }) {
    return this._currentSegmentCalls()
      .filter(c => (c.foldedSeq ?? 0) > sinceSeq)
      .sort((a, b) => a.foldedSeq - b.foldedSeq)
      .map(c => {
        const L_read = effectiveL(c);
        return { seq: c.foldedSeq, reliable, turnSeq: c.turnSeq, L_read,
          burnRate: computeFullCarryBurnRate({ L_read, B_post, B_rebuild, cRatio }) };
      });
  }

  // final-review GPT#1: seq-only UNRELIABLE samples. When a segment is unreliable the instant bundle
  // has no B_post/B_rebuild/cRatio, so we cannot compute burnRate — but the ledger MUST still advance
  // its seq cursor per call (A2) or recovery hits a false folded_seq_gap. These carry NO burnRate/L_read
  // (the reducer's unreliable branch ignores them and only advances lastAppliedFoldedCallSeq). turnSeq
  // is still per-RECORD so the reducer's per-turn ΔW reset stays correct across an unreliable stretch.
  rateLampSeqSamplesSince(sinceSeq, { unavailableReason }) {
    return this._currentSegmentCalls()
      .filter(c => (c.foldedSeq ?? 0) > sinceSeq)
      .sort((a, b) => a.foldedSeq - b.foldedSeq)
      .map(c => ({ seq: c.foldedSeq, reliable: false, unavailableReason, turnSeq: c.turnSeq }));
  }

  // Sum of the default-selected B basis (spec §2.1): dead + selected file-path tokens + all skill tokens.
  // Uses the SAME discardReason predicate as getBucketData so the panel and the position basis never diverge.
  _computeBDefault() {
    let sum = this._bRebuild.dead;
    for (const { path: path0, tokens } of this._bRebuild.pathTokenPairs()) {
      if (path0.startsWith('skill:')) { sum += tokens; continue; }
      const abs = nodePath.isAbsolute(path0) ? path0 : (this.cwd ? nodePath.resolve(this.cwd, path0) : path0);
      const rel = this.cwd ? nodePath.relative(this.cwd, abs) : path0;
      if (discardReason(rel, this._isIgnored, this.cwd, abs) === null) sum += tokens;
    }
    return sum;
  }

  getStatus() {
    const seg = this._currentSegmentCalls();
    // WHY _ctp: when CTP is resolved (first usage row), use the last call's model (most recent);
    // otherwise fall back to the first call's model (segment-locked model for cold start).
    const model = this._ctp ? (seg.length ? seg[seg.length - 1].model : '') : (seg.length ? seg[0].model : '');
    const cRatio = this.ratioOverride ?? cRatioFor(model);
    const L = seg.length ? effectiveL(seg[seg.length - 1]) : 0;
    const B = this._bRebuild.B();                 // B_full — unchanged; drives g/ΔResidual
    const bDefault = this._computeBDefault();      // position basis (spec §2.1)
    const g = gEffective(this._g_ema);
    const Lcap = contextWindowFor(model) - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;

    const baselineValid = B > 0 && cRatio > 0;    // gate stays on B_full existence
    const bPos = bDefault > 0 ? bDefault : B;      // guard: if everything is excluded, fall back to B_full
    const x = baselineValid ? L / bPos : 1;
    const dhat = baselineValid ? nucleus(cRatio, g, bPos) : null;       // = sqrt(2*cRatio*g/B) (spec section 2.2)
    const xSweet = dhat != null ? 1 + dhat : null;
    const burnRate = baselineValid ? Math.max(0, L - bPos) / (cRatio * bPos) : null;
    const mf = baselineValid ? computeMovableFrac(cRatio, bPos, g) : null;
    const br = (dhat > 0 && Number.isFinite(mf)) ? computeBr(x, dhat, mf) : null;
    const ctpOvershootRatio = L > 0 ? this._ctpOvershoot / L : 0;

    const rateLamp = baselineValid ? {
      reliable: true, basis: 'fullCarry',
      L_read: L, L_cap: Lcap, B_post: B, B_rebuild: B, B_default: bDefault, lBase: B, C_RATIO: cRatio,
      x_display: x, burnRate, hBreak: burnRate > 0 ? 1 / burnRate : Infinity,
      dhat, xSweet, mf, br, gEma: g,
      inDeepWater: isInDeepWater(x, xSweet, br),
    } : { reliable: false, unavailableReason: seg.length === 0 && !this._transcriptSeen ? 'no_transcript' : 'insufficient_data' };

    return {
      L, B, g, x, dhat, xSweet, burnRate, mf, br,
      model, cRatio, segment: this._segment, apiCalls: seg.length,
      uptime: this._uptimeSec(), ctpOvershootRatio,
      rateLamp, transcriptPath: this.path,
    };
  }

  // Profile snapshot for GC archival (spec section 6.7). Called on each fold completion by server.js.
  getTerminalSnapshot() {
    const s = this.getStatus();
    return {
      b_total: s.B, g_final: s.g, l_peak: s.L, c_ratio: s.cRatio,
      turns: this._turnSeq, mf: s.mf, br_exit: s.br, ctp_overshoot_ratio: s.ctpOvershootRatio,
      paths: this._bRebuild.snapshot().map(({ path, tokens }) => ({ path, tokens })),
      model: s.model,
    };
  }

  // Bucket panel data (spec §7.1 / §11.3.1). Read-only; residual tags are best-effort display metadata.
  getBucketData() {
    const s = this.getStatus();
    const skills = [];
    const paths = [];
    for (const { path: path0, tokens, lastActiveTurn, lastActiveCallSeq, totalSpent, churn, efficiency, readCount, editCount, touchSeqs, pureRereads } of this._bRebuild.snapshot()) {
      const common = { tokens, lastTurn: lastActiveTurn, lastCallSeq: lastActiveCallSeq, totalSpent, churn, efficiency, readCount, editCount, touchSeqs, pureRereads };
      if (path0.startsWith('skill:')) {
        skills.push({ name: path0.slice('skill:'.length), ...common, defaultSelected: true, defaultDiscardReason: null });
      } else {
        const abs = nodePath.isAbsolute(path0) ? path0 : (this.cwd ? nodePath.resolve(this.cwd, path0) : path0);
        const rel = this.cwd ? nodePath.relative(this.cwd, abs) : path0;
        const reason = discardReason(rel, this._isIgnored, this.cwd, abs);
        paths.push({ path: path0, ...common, defaultSelected: reason === null, defaultDiscardReason: reason });
      }
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    skills.sort((a, b) => b.tokens - a.tokens);

    const bash = [];
    const mcp = [];
    const agent = [];
    // key is already the SAFE server-extracted feature name (Task 0b bashFeature/mcpDisplay); raw command
    // never stored. `detail` is a redacted disambiguator (bash only). Agent uses taskId prefix.
    for (const [key, r] of this._residualByTool) {
      const tokens = Math.round(r.tokens);
      if (tokens <= 0) continue;
      if (r.kind === 'bash') bash.push({ name: key, detail: r.detail || '', tokens, count: r.count || 1, lastTurn: r.lastTurn, lastCallSeq: r.lastCallSeq, touchSeqs: r.touchSeqs || [] });
      else if (r.kind === 'mcp') mcp.push({ tool: key, tokens, count: r.count || 1, lastTurn: r.lastTurn, lastCallSeq: r.lastCallSeq, touchSeqs: r.touchSeqs || [] });
      else if (r.kind === 'agent') agent.push({ name: key, detail: r.detail || '', tokens, count: r.count || 1, lastTurn: r.lastTurn, lastCallSeq: r.lastCallSeq, touchSeqs: r.touchSeqs || [] });
    }
    bash.sort((a, b) => b.tokens - a.tokens);
    mcp.sort((a, b) => b.tokens - a.tokens);
    agent.sort((a, b) => b.tokens - a.tokens);

    // B_default = dead (always retained) + selected file-path tokens + all skill tokens.
    // DRY: single implementation shared with getStatus (position basis).
    const bDefault = this._computeBDefault();

    return {
      dead: this._bRebuild.dead,
      skills, paths,
      residual: { bash, mcp, agent },
      totalB: s.B, totalL: s.L,
      bDefault,
      totalResidualRaw: s.L - s.B,               // signed — Task 4 drift-warn source (review GPT#7)
      totalResidual: Math.max(0, s.L - s.B),     // clamped — UI display value
      ctpOvershootRatio: s.ctpOvershootRatio,
      currentTurnSeq: this._turnSeq,
      segment: this._segment,
    };
  }

  _uptimeSec() {
    if (this._startMs == null) return 0;
    return Math.floor((this._nowMs() - this._startMs) / 1000);
  }
  _nowMs() { return Date.now(); }

  // getHistory endpoint memoization (H1) lives in history.js (getHistory takes this instance and calls
  // this._baselineAndKavg — the SAME pipeline getStatus uses — so the current segment's last point
  // still matches getStatus, QF1). Thin delegator keeps the public method surface unchanged.
  getHistory(fitWindowOverride) { return getHistory(this, fitWindowOverride); }
}
