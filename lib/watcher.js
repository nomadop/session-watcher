import nodePath from 'node:path';
import { readFileSync } from 'node:fs';
import { cRatioFor, contextWindowFor } from './extract.js';
import { canExtract, activeSymbolsForPath, loadGrammar } from './symbol-outline.js';
import { RESERVED_OUTPUT, CTX_SAFETY_MARGIN, G_FLOOR } from './constants.js';
import { effectiveL } from './l-measure.js';
import { computeFullCarryBurnRate } from './rate-lamp.js';
import { poll } from './fold.js';
import { getHistory } from './history.js';
import { BRebuild, gEffective } from './measure.js';
import { ctpForModel } from './extract.js';
import { nucleus } from './landmarks.js';
import { computeMovableFrac, computeBr, computePp, isInDeepWater, BR_AMBER } from './bill-regret.js';
import { discardReason } from './gitignore.js';
import { inferOverride } from './override.js';
import { createTopologyState, resetTopologyState } from './canonical-fold.js';

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
    // Carry-staleness telemetry buffers (spec §Capture). Filled during folding (processToolEvents +
    // foldCall), drained + reset per segment by _resetSegmentAccumulators. One step_usage row per folded
    // API step; one path_event per MAIN-CHAIN file touch. NO watcher-global pending fields — step
    // metadata is entry-local (returned by processToolEvents, passed as foldCall's stepMeta arg).
    this._segmentStepUsage = [];   // telemetry: one per folded API step in the current segment
    this._segmentPathEvents = [];  // telemetry: one per file touch in the current segment
    // RV-C7: fold-pipeline sequence counters (Task 2.7). `_foldedCallSeq` = monotonic count of genuinely
    // NEW folded calls (the ledger idempotency key); `_turnSeq` = monotonic count of REAL transcript turns
    // (user↔assistant boundaries, NOT per-poll). `_pendingTurnBump` defers the bump to the NEXT assistant
    // call, so a `user` line with no following assistant call yet does not create an empty turn.
    this._foldedCallSeq = 0;
    this._turnSeq = 0;
    this._pendingTurnBump = false;
    this._segmentModel = null;               // model/ratio locked at segment creation
    this._ino = null;                        // inode of the watched file (rotation guard)
    // #13: has the transcript path EVER been opened successfully? A never-openable path (bad
    // --transcript/--project) otherwise looks identical to healthy warmup (both yield zero calls →
    // 'insufficient_data'). Flag-on-first-successful-open (not existsSync-at-status): survives a
    // file that appears later — once seen it never reverts to no_transcript — and needs no extra
    // syscall at status time.
    this._transcriptSeen = false;
    // H1: getHistory memoization. `_foldRev` is a monotonic counter bumped in foldCall on every
    // MUTATING (in-place) fold — the one invalidation hazard a length-only check misses, because an
    // in-place fold leaves _calls.length unchanged while rewriting a call an earlier point depends on.
    // `_historyCache` holds the last emitted points plus the exact inputs they were computed from
    // (fitWindow, _calls consumed, _foldRev snapshot) and the running per-segment accumulators, so a
    // later getHistory can reuse a still-valid prefix and compute only the appended tail. Any mismatch
    // → full rebuild (today's proven code path). See getHistory for the reuse/invalidate decision.
    this._foldRev = 0;
    this._historyCache = null;
    // Fold failures, cumulative for the process lifetime. Never reset — a boundary or replay that
    // cleared it would hide the degradation it exists to report. It is a LOWER BOUND on lost
    // measurement, not a count of distinct entries: a replay re-folds the active path, so one
    // persistently faulting entry increments once per replay, and a throw part-way through a
    // multi-block entry loses that entry's remaining blocks (and the tool_results those blocks would
    // have matched) for one increment.
    // Pinned by test/fold.boundary-durability.test.js.
    this._foldErrors = 0;
    // M9: branch indexer state — shared topology object (canonical-fold.js)
    this._topology = createTopologyState();
    this._activeLeafUuid = null;
    // Mirror of _topology.compactDetected. Its readers are foldCall, which opens a segment on it, and poll's
    // first-poll branch, which replays all subtrees when the file already contains compact boundaries at the
    // first read.
    this._compactDetected = false;
    // v3 continuous-B measurement layer (spec §2). B_rebuild is in-memory only, rebuilt from transcript
    // on restart (Stream A replay). CTP is resolved once from the first usage row's model.
    this.cwd = opts.cwd || null;
    this._isIgnored = typeof opts.isIgnored === 'function' ? opts.isIgnored : null;  // injected; null → all kept
    this._bRebuild = new BRebuild();
    this._ctp = null;                 // resolved lazily on first usage row (ctpForModel)
    this._segmentEpoch = 0;           // bumped on segment reset; stale-epoch tool_results are discarded
    this._pendingTool = new Map();    // tool_use_id → { adapter, input, path, epoch }
    this._g_ema = null;               // set on the first g sample (Stream B, Task 11); floored via gEffective
    this._prevB = 0;                  // B snapshot at the previous usage row (for ΔB and classifyMiss)
    this._prevL = null;               // L at the previous usage row (for ΔL)
    this._ctpOvershoot = 0;           // accumulated CTP overestimate (tokens); reset on segment boundary
    this._bLagLedger = { total: 0, byPath: new Map() }; // §2.4c: overshoot banked pending L catch-up
                                                        // (cc/input→cr lag); retired as L grows. total === Σ byPath (settleDeferred).
    this._prevTotalStock = 0;         // for segment-boundary detection (Task 11)
    this._residualByTool = new Map();  // name → { tokens, lastTurn, kind, detail } — display-layer residual breakdown (spec §11.3.2)
    this._turnResidualTools = [];      // per-turn buffer of { key, kind, detail, weight }; drained into _residualByTool by foldCall
    this._pendingResidual = new Map(); // tool_use_id → { key, kind, detail, inputLen, epoch, turn } for unmatched Bash/MCP
    this._intervalPathDeltas = new Map(); // §2.5: per-path B deltas accumulated between usage rows; consumed by foldCall for CTP correction
    this._completedSkills = new Map();    // tool_use_id → { path, epoch }; for isMeta skill content attribution
    this._startMs = this._nowMs();
    this._userOverrides = new Map();  // §6: path → 'include'|'exclude' (user/inferred override)
    // post-v3 §3.2: identity opts
    this._sessionId = opts.sessionId || null;
    this._projectId = opts.projectId || process.env.CLAUDE_PROJECT_ID || null;
    // Carry-sweep injection hooks. Live folding touches neither: the fold-archival boundary
    // resolves `w._store || getStore()` → the global singleton, and `replayMode || w._replayMode`
    // → false → source='live'/capture_source='cc-live'. Three folds that reconstruct history instead of
    // observing it flip `_replayMode` on — the crash-recovery sweep (lib/carry-sweep.js), which also
    // sets `_store` so replayed boundaries archive to the RECONCILED connection rather than the global;
    // createServer's startup whole-file poll, which restores the flag before live polling begins; and
    // `replayActivePath`, which re-folds from byte 0 on a rewind or fork and restores it the same way.
    // Under any of the three, EVERY segment archived — the fast-path foldCall boundaries AND the
    // terminal one — is stamped replay-origin / cc-replay, not just the compact-replay subtrees.
    this._store = null;
    this._replayMode = false;
    // Segment-level archival counters (post-v3 §3.2)
    this._lastArchivedSegment = -1;      // idempotency guard
    // Segment-local peak accumulators (reset at each boundary)
    this._resetSegmentAccumulators();
  }

  // JSONL ingest + fold + segmentation live in fold.js (readNewText/foldCall/poll take this instance
  // and mutate its private state identically). poll() delegates so the public method surface and all
  // `w._calls/_segment/_foldRev` post-poll reads are unchanged.
  poll() { return poll(this); }

  getSegmentIndex() { return this._segment; }

  // Carry-sweep store injection (Task 9). Point this watcher's fold-archival boundary at a specific
  // store connection instead of the global getStore() singleton. Used ONLY by the crash-recovery sweep
  // (lib/carry-sweep.js) so a replayed session's boundaries write to the DB the sweep is reconciling.
  // Minimal by design: it stores the handle; fold.js's handleSegmentBoundary reads `w._store || getStore()`.
  setStore(store) { this._store = store; }

  // Single source of truth for the segment-local accumulator fields (11 peak/sum scalars + the two
  // carry-staleness telemetry buffers + the auto-match _pendingLoadHandoff set).
  // Called from: constructor, segmentReset(), and resetFoldState() in fold.js.
  // NOTE: _lastArchivedSegment is intentionally NOT here (different semantics per call site).
  _resetSegmentAccumulators() {
    this._segmentStartTurn = this._turnSeq;
    this._segmentLPeak = 0;
    this._segmentBrPeak = 0;
    this._segmentPpPeak = 0;
    this._segmentGMin = Infinity;
    this._segmentTurnAtBrAmber = null;
    this._segmentOutputSum = 0;
    this._segmentUsageCount = 0;
    this._segmentInputTokens = 0;
    this._segmentFirstTs = null;
    this._segmentLastTs = null;
    // Carry-staleness telemetry: drain per-segment buffers here so BOTH the segment-rotation path
    // (segmentReset → _resetSegmentAccumulators) AND the full replay/wipe path (resetFoldState →
    // _resetSegmentAccumulators) clear them. With the entry-local step-metadata design there is no
    // pending step token/count to survive a boundary; only the two buffers plus the tool_use_id-keyed
    // auto-match set need clearing. _pendingLoadHandoff is keyed by tool_use_id, so even without this
    // reset it could not misattribute — the reset only prevents an unbounded straggler if a load's
    // tool_result never arrives.
    this._segmentStepUsage = [];
    this._segmentPathEvents = [];
    this._pendingLoadHandoff = null;
  }

  // Per-call segment peak update (post-v3 §3.2). Called from foldCall with the current call's
  // effectiveL and B_current. Recomputes only the scalars needed — no _calls scan (replay-safe).
  _updateSegmentPeaks(L, B) {
    this._segmentLPeak = Math.max(this._segmentLPeak, L);
    const cRatio = this.ratioOverride ?? cRatioFor(this._segmentModel || '');
    const g = gEffective(this._g_ema);
    this._segmentGMin = Math.min(this._segmentGMin, g);
    const bPos = this._computeBDefault() || B;  // position basis, same as getStatus
    if (!(bPos > 0) || !(cRatio > 0)) return;   // pre-baseline: L peak still tracked, br/pp skipped
    const x = L / bPos;
    const dhat = nucleus(cRatio, g, bPos);
    const mf = computeMovableFrac(cRatio, bPos, g);
    const br = (dhat > 0 && Number.isFinite(mf)) ? computeBr(x, dhat, mf) : null;
    const pp = computePp(x, dhat);
    if (Number.isFinite(br)) {
      this._segmentBrPeak = Math.max(this._segmentBrPeak, br);
      if (br >= BR_AMBER && this._segmentTurnAtBrAmber === null) {
        this._segmentTurnAtBrAmber = this._turnSeq - this._segmentStartTurn;
      }
    }
    if (Number.isFinite(pp)) this._segmentPpPeak = Math.max(this._segmentPpPeak, pp);
  }

  // v3 segment boundary (spec §6.6): compact = clear = reset. B's state follows the API's state.
  segmentReset() {
    // Reset segment-local accumulators (post-v3 §3.2). Archival already happened in handleSegmentBoundary.
    this._resetSegmentAccumulators();

    this._bRebuild.clear();
    this._bRebuild.setDead(0);   // re-anchored from the next call's max(cr, cc, input)
    this._g_ema = G_FLOOR;
    this._ctpOvershoot = 0;
    this._bLagLedger = { total: 0, byPath: new Map() };
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
    this._userOverrides.clear();
  }

  // In-process rotation: reset file-reading state to point at a new transcript.
  // Caller (doRotation) handles archival BEFORE calling this.
  // _calls preserved (cross-segment history for getHistory).
  switchTranscript(newPath) {
    this.path = newPath;
    this._offset = 0;
    this._partial = '';
    if (this._decoder && typeof this._decoder.end === 'function') {
      this._decoder.end();
    }
    this._decoder = null;
    this._ino = null;
    this._transcriptSeen = false;
    // Reset branch-index state so fold.js does not see stale topology from the
    // previous transcript and trigger a spurious replayActivePath(clearCalls:true).
    resetTopologyState(this._topology);
    this._activeLeafUuid = null;
    this._compactDetected = false;
    // Attempt immediate poll. readNewText handles ENOENT internally (returns '').
    // This try/catch guards against other poll() errors (e.g., foldCall throw on
    // corrupt data in a pre-existing file).
    try {
      this.poll();
    } catch (e) {
      if (process.env.SW_DEBUG) console.error('[switchTranscript]', e.message);
    }
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
      // H3: override check BEFORE skill short-circuit so skill exclude works
      const override = this._userOverrides.get(path0);
      if (override === 'include') { sum += tokens; continue; }
      if (override === 'exclude') { continue; }
      if (path0.startsWith('skill:')) { sum += tokens; continue; }
      // fallback: auto judgment
      if (this._discardReasonFor(path0).reason === null) sum += tokens;
    }
    return sum;
  }

  // F13: shared path resolution + discard predicate (DRY for _computeBDefault, _tryInferOverride, getBucketData)
  _discardReasonFor(path0) {
    const abs = nodePath.isAbsolute(path0) ? path0 : (this.cwd ? nodePath.resolve(this.cwd, path0) : path0);
    const rel = this.cwd ? nodePath.relative(this.cwd, abs) : path0;
    return { abs, rel, reason: discardReason(rel, this._isIgnored, this.cwd, abs) };
  }

  /** §6 §2.2: infer override for a newly-added path based on unanimous sibling state.
   *  Skills excluded from inference intentionally — skill override is manual-only (H3).
   *  @param {string[]} [bRebuildKeys] - optional pre-computed key list (F11: avoids O(M×N) in grep loops) */
  _tryInferOverride(newPath, bRebuildKeys) {
    if (newPath.startsWith('skill:')) return;
    const keys = bRebuildKeys || this._bRebuild.pathTokenPairs().map(p => p.path);
    const discardFn = (path) => this._discardReasonFor(path).reason;
    const result = inferOverride(newPath, keys, this._userOverrides, discardFn, this.cwd);
    if (result) this._userOverrides.set(newPath, result);
  }

  getStatus() {
    const seg = this._currentSegmentCalls();
    // WHY _ctp: when CTP is resolved (first usage row), use the last call's model (most recent);
    // otherwise fall back to the first call's model (segment-locked model for cold start).
    const model = this._ctp ? (seg.length ? seg[seg.length - 1].model : '') : (seg.length ? seg[0].model : '');
    const cRatio = this.ratioOverride ?? cRatioFor(model);
    const L = seg.length ? effectiveL(seg[seg.length - 1]) : 0;
    const Bfull = this._bRebuild.B();             // uncapped belief — drives decisions, ΔResidual, archival
    // §I read-time cap: min(B, totalStock) so the physical invariant B ⊆ totalStock holds during the
    // cc→cr lag window (B is credited before totalStock accounts for it). This is a DISPLAY value ONLY.
    // The bucket keeps Bfull; the cap self-releases once totalStock catches up. Reconciliation (_prevB)
    // and the decision math below are unaffected (they read Bfull).
    const Breported = this._prevTotalStock > 0 ? Math.min(Bfull, this._prevTotalStock) : Bfull;
    const bDefault = this._computeBDefault();      // position basis (spec §2.1)
    const g = gEffective(this._g_ema);
    const Lcap = contextWindowFor(model) - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;

    const baselineValid = Bfull > 0 && cRatio > 0;    // gate stays on B_full existence
    const bPos = bDefault > 0 ? bDefault : Bfull;      // guard: if everything is excluded, fall back to B_full
    const x = baselineValid ? L / bPos : 1;
    const dhat = baselineValid ? nucleus(cRatio, g, bPos) : null;       // = sqrt(2*cRatio*g/B) (spec section 2.2)
    const xSweet = dhat != null ? 1 + dhat : null;
    const burnRate = baselineValid ? Math.max(0, L - bPos) / (cRatio * bPos) : null;
    const mf = baselineValid ? computeMovableFrac(cRatio, bPos, g) : null;
    const br = (dhat > 0 && Number.isFinite(mf)) ? computeBr(x, dhat, mf) : null;
    const ctpOvershootRatio = L > 0 ? this._ctpOvershoot / L : 0;

    const rateLamp = baselineValid ? {
      reliable: true, basis: 'fullCarry',
      L_read: L, L_cap: Lcap, B_post: Breported, B_rebuild: Breported, B_default: bDefault, lBase: Breported, C_RATIO: cRatio,
      x_display: x, burnRate, hBreak: burnRate > 0 ? 1 / burnRate : Infinity,
      dhat, xSweet, mf, br, gEma: g,
      inDeepWater: isInDeepWater(x, xSweet, br),
    } : { reliable: false, unavailableReason: seg.length === 0 && !this._transcriptSeen ? 'no_transcript' : 'insufficient_data' };

    return {
      L, B: Breported, bDefault, g, x, dhat, xSweet, burnRate, mf, br,
      model, cRatio, segment: this._segment, apiCalls: seg.length,
      uptime: this._uptimeSec(), ctpOvershootRatio, foldErrors: this._foldErrors,
      rateLamp, transcriptPath: this.path,
    };
  }

  // Profile snapshot for GC archival (spec section 6.7). Called on each fold completion by server.js.
  getTerminalSnapshot() {
    const s = this.getStatus();
    return {
      // #2 archive-口径: b_total must equal the belief the paths sum to (dead + Σpaths), i.e. the UNCAPPED
      // B_full. The read-time cap (getStatus().B = Breported) is for the live dashboard only; persistence
      // and carry-over need the paths-consistent value or dead+Σpaths > b_total. See plan Global Constraints.
      b_total: this._bRebuild.B(), g_final: s.g, l_peak: s.L, c_ratio: s.cRatio,
      turns: this._turnSeq, mf: s.mf, br_exit: s.br, ctp_overshoot_ratio: s.ctpOvershootRatio,
      paths: this._bRebuild.snapshot().map(({ path, tokens }) => ({ path, tokens })),
      model: s.model,
      segment: this._segment,
    };
  }

  // Bucket panel data (spec §7.1 / §11.3.1). Read-only; residual tags are best-effort display metadata.
  getBucketData({ includeSymbols = false } = {}) {
    const s = this.getStatus();
    const skills = [];
    const paths = [];
    for (const { path: path0, tokens, lastActiveTurn, lastActiveCallSeq, totalSpent, churn, efficiency, readCount, editCount, touchSeqs, pureRereads } of this._bRebuild.snapshot()) {
      const common = { tokens, lastTurn: lastActiveTurn, lastCallSeq: lastActiveCallSeq, totalSpent, churn, efficiency, readCount, editCount, touchSeqs, pureRereads };
      if (path0.startsWith('skill:')) {
        skills.push({ name: path0.slice('skill:'.length), ...common, defaultSelected: true, defaultDiscardReason: null, userOverride: this._userOverrides.get(path0) || null });
      } else {
        const { abs, reason } = this._discardReasonFor(path0);
        const pathEntry = { path: path0, ...common, defaultSelected: reason === null, defaultDiscardReason: reason, userOverride: this._userOverrides.get(path0) || null };

        // Symbol computation (only when includeSymbols requested — MCP get_bucket_summary only)
        if (includeSymbols && reason === null) {
          const ext = nodePath.extname(path0);
          if (canExtract(ext)) {
            try {
              const code = readFileSync(abs, 'utf8');
              const bEntry = this._bRebuild.paths.get(path0);
              const bucketLineNumbers = bEntry ? [...bEntry.lines.keys()] : [];
              const hasFullSnapshot = this._bRebuild._hasFullSnapshot.get(path0) || false;
              const { activeSymbols } = activeSymbolsForPath(code, ext, bucketLineNumbers, hasFullSnapshot);
              if (activeSymbols) pathEntry.activeSymbols = activeSymbols;
            } catch { /* file unreadable — skip symbols */ }
          }
        }

        paths.push(pathEntry);
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
