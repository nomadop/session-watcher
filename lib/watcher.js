import { cRatioFor, contextWindowFor } from './extract.js';
import { detectKnee } from './baseline.js';
import { CONSTANTS, RESERVED_OUTPUT, CTX_SAFETY_MARGIN } from './constants.js';
import { lStar, rho, phi, paybackP, timingWeight, regret, nStar } from './metrics.js';
import { median } from './stats.js';
import { effectiveL } from './l-measure.js';
import { computeCalibrationGate, callIdentity, applyFrozen, makeLatchEntry, validateLatch, baselineFingerprint } from './latch.js';
import { clampKStable, computeRateLampInstant, computeFullCarryBurnRate } from './rate-lamp.js';
import { poll } from './fold.js';
import { getHistory } from './history.js';

// Re-exported so existing importers (server.js, tests) keep a single entry point while the
// implementations live in focused modules: L measurement (l-measure.js), latch lifecycle (latch.js),
// JSONL ingest/fold (fold.js). Pure code motion — no behavior change.
export { effectiveL, classifyMiss } from './l-measure.js';
export { computeCalibrationGate, callIdentity, applyFrozen, makeLatchEntry, validateLatch } from './latch.js';

export class SessionWatcher {
  constructor(jsonlPath, lbase = null, opts = {}) {
    this.path = jsonlPath;
    this.injectedDead = lbase;              // dead bottom from launcher, or null to detect
    this.fitWindow = opts.fitWindow ?? CONSTANTS.FIT_WINDOW_DEFAULT;
    this.ratioOverride = opts.ratioOverride ?? null;  // --ratio manual override (model price may change)
    this._offset = 0;                        // byte offset of last complete line consumed
    this._partial = '';                      // buffered trailing partial line
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
    this._segmentMaxTotal = 0;
    // Running per-segment max of REAL cacheRead (not total). The established-read discriminator for
    // miss detection (spec §3.1 criterion 3): a segment-first / cold-start row has 0 here (cc is
    // "being written", not "read back"), so it can never be reconstructed. Same lifecycle as
    // _segmentMaxTotal (init/reset/update in lockstep).
    this._segmentMaxRead = 0;
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
    // L_base latch (v1.1): segmentId → { entry: LatchEntry|null, scannedThrough }. Instance-level,
    // spans polls, used by getStatus. getHistory uses a SEPARATE store on _historyCache.latchBySeg
    // (store isolation) — both hold the same deterministic function value, different containers.
    this._latchedBaseline = new Map();
    this._startMs = this._nowMs();
  }

  // JSONL ingest + fold + segmentation live in fold.js (readNewText/foldCall/poll take this instance
  // and mutate its private state identically). poll() delegates so the public method surface and all
  // `w._calls/_segment/_foldRev` post-poll reads are unchanged.
  poll() { return poll(this); }

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

  // Build the cacheRead sequence knee-detection runs on. If a dead bottom is injected, PREPEND it
  // as a synthetic point WITHOUT dropping any real call (the old `[dead, ...seq.slice(1)]` silently
  // lost the first real cacheRead — GPT review). kneeTurn is then an index into this same array,
  // and callers must use it consistently (seq[0] is the synthetic/real dead point).
  _baselineSeq(seg) {
    const seq = seg.map(c => effectiveL(c));
    if (this.injectedDead != null) return [this.injectedDead, ...seq];
    return seq;
  }

  // Single per-point metrics pipeline shared by getStatus (full current segment) and getHistory
  // (each segment prefix). For a given array of current-segment call records it computes the SAME
  // baselineSeq → detectKnee → segKnee → dead/task/total → kAvg, so the history chart's L*/kAvg can
  // never drift from the status L*/kAvg (the two used to keep independent, divergent copies — QF1).
  _baselineAndKavgLive(prefix) {
    const seq = this._baselineSeq(prefix);
    const dead = seq[0] ?? 0;
    // Empty-seq guard: an empty prefix with no injected dead → feed [dead] so detectKnee never reads
    // undefined. getHistory now inherits this guard via the shared helper (it previously lacked it).
    const { kneeTurn, taskCtx, isRealKnee, stableMedian } = detectKnee(seq.length ? seq : [dead]);
    const source = this.injectedDead != null ? 'carried' : 'current_cold_start';
    const confidence = source === 'carried' ? 0.6 : 0.92;
    // kneeTurn indexes _baselineSeq; when dead was prepended, shift back to a seg index (>=0).
    const segKnee = this.injectedDead != null ? Math.max(0, kneeTurn - 1) : kneeTurn;
    // isRealKnee is carried as metadata (Task 2's flag threaded through). Nothing reads it in this
    // task; Task 4's latch consumes it to distinguish a genuine knee from the min-turn fallback.
    // stableMedian carried additively (v2.1): the frozen baseline exposes it for k_stable (§0′-A2).
    const baseline = { dead, task: taskCtx, total: dead + taskCtx, source, confidence, kneeTurn: segKnee, isRealKnee: isRealKnee === true, stableMedian };

    const L = prefix.length ? effectiveL(prefix[prefix.length - 1]) : baseline.total;
    // k_avg accumulated AFTER the knee (exclude warmup).
    // baseline.total == cacheRead[kneeTurn], so growth (L - baseline.total) accrued over the
    // DELTAS from segKnee to end = (prefix.length - segKnee - 1) steps — NOT including the knee call
    // itself (off-by-one would under-count kAvg and distort L*).
    // growthSteps stays a LOCAL only (apiCalls derives from it); no caller destructures it
    // off the returned object (getStatus uses {baseline,L,apiCalls,kAvg} + recomputes its own
    // postKneeGrowthCalls; getHistory uses {baseline,L,kAvg}), so it is not returned.
    const growthSteps = Math.max(0, prefix.length - segKnee - 1);
    const apiCalls = Math.max(1, growthSteps);
    const kAvg = Math.max(0, (L - baseline.total) / apiCalls);
    return { baseline, L, kAvg, apiCalls };
  }

  // Return the frozen entry for this prefix's segment, latching at the EARLIEST gate-passing,
  // real-knee prefix if not already latched. latchStore value per segment is {entry, scannedThrough};
  // scannedThrough makes the scan incremental so a batch poll that skips intermediate prefixes still
  // converges to the same earliest point getHistory reaches by walking prefix-by-prefix (QF1).
  //
  // COST (GPT-plan-review #9 / gemini #2): the scan returns as soon as it finds the earliest passing
  // prefix, so for a segment that DOES latch, cost is O(latchPoint²) where latchPoint ≈ warmup length
  // (a handful to low-tens of calls) — the per-slice _baselineAndKavgLive/_metricsReliable are O(n)
  // each, run over slices up to latchPoint. True O(n²) only occurs for a segment that NEVER passes the
  // gate (fallback-only steep growth) AND is very long: then every poll re-scans from scannedThrough
  // to the end. That is the same class of session where v1 already runs O(n²) getHistory pre-H1, and
  // it never hard-signals anyway. Acceptable for v1.1; if a pathological multi-thousand-call
  // never-latching segment appears, revisit with an incremental knee detector (out of scope). No
  // async yield is added — the architecture is synchronous by design.
  ensureLatchForPrefix(prefix, latchStore) {
    if (!prefix.length) return null;
    const segmentId = prefix[prefix.length - 1].segment;
    let state = latchStore.get(segmentId);
    if (!state) { state = { entry: null, scannedThrough: 0 }; latchStore.set(segmentId, state); }
    const valid = validateLatch(state.entry, prefix);
    if (valid) return valid;
    // Stale fingerprint (segment-id reuse after replay/reset for DIFFERENT content) → drop the entry
    // AND reset the scan cursor, so we re-scan this now-different sequence from scratch. (No-release
    // only means "don't unfreeze within one valid identity"; a fingerprint change is a new identity.)
    if (state.entry) { state.entry = null; state.scannedThrough = 0; }
    for (let n = Math.max(1, state.scannedThrough + 1); n <= prefix.length; n++) {
      const slice = prefix.slice(0, n);
      const live = this._baselineAndKavgLive(slice);
      if (!live.baseline.isRealKnee) continue;
      const postKneeGrowthCalls = Math.max(0, slice.length - live.baseline.kneeTurn - 1);
      const gate = computeCalibrationGate({
        metricsReliable: this._metricsReliable(slice), confidence: live.baseline.confidence,
        postKneeGrowthCalls, baselineTotal: live.baseline.total, L: live.L,
      });
      if (gate.passed) {
        const entry = makeLatchEntry(live, slice); // null if a fingerprint id is missing → keep scanning
        if (entry) { state.entry = entry; state.scannedThrough = n; return entry; }
      }
    }
    state.scannedThrough = prefix.length;
    return null;
  }

  // Latch-aware baseline. With no latchStore (or an empty prefix) it is IDENTICAL to
  // _baselineAndKavgLive (latched:false) — so any caller without a store keeps the live path. When a
  // store IS passed, it latches at the earliest gate-passing/real-knee prefix and returns the FROZEN
  // baseline (via applyFrozen), recomputing kAvg with the frozen kneeTurn as denominator (spec §2.5).
  _baselineAndKavg(prefix, opts = {}) {
    const latchStore = opts.latchStore;
    if (!latchStore || !prefix.length) { const live = this._baselineAndKavgLive(prefix); return { ...live, latched: false }; }
    const entry = this.ensureLatchForPrefix(prefix, latchStore);
    if (!entry) { const live = this._baselineAndKavgLive(prefix); return { ...live, latched: false }; }
    // ER-4: latched → L is the O(1) effectiveL of the last call; skip the O(n·log n) live recompute.
    const baseline = applyFrozen(entry);
    const L = effectiveL(prefix[prefix.length - 1]);
    const apiCalls = Math.max(1, prefix.length - baseline.kneeTurn - 1);
    const kAvg = Math.max(0, (L - baseline.total) / apiCalls);
    return { baseline, L, kAvg, apiCalls, latched: true };
  }

  getStatus(fitWindowOverride) {
    const fitWindow = fitWindowOverride ?? this.fitWindow;
    const seg = this._currentSegmentCalls();
    // C_RATIO is segment-locked: use the model captured at segment creation, not the last call's
    // model (a mid-segment model change must not make historical + current L* jump).
    const model = this._segmentModel || (seg.length ? seg[0].model : '');
    const cRatio = this.ratioOverride ?? cRatioFor(model);
    // Shared per-point pipeline (baseline + kAvg) — identical math to getHistory's last point.
    const latchRes = this._baselineAndKavg(seg, { latchStore: this._latchedBaseline });
    const { baseline, L, apiCalls, kAvg } = latchRes;
    // ER-7: isRealKnee is a latch-gate INTERNAL (ensureLatchForPrefix reads live.baseline.isRealKnee);
    // it is NOT part of the /api/status.baseline contract (always true once latched, undocumented, and
    // a client validating additionalProperties:false would reject it). Drop it from the EMITTED payload
    // only — the internal `baseline` above (and detectKnee/applyFrozen) still carry it for the latch scan.
    const { isRealKnee, ...baselineRest } = baseline;
    const baselineOut = { ...baselineRest, fingerprint: latchRes.latched ? baselineFingerprint({ dead: baseline.dead, taskCtx: baseline.task, kneeTurn: baseline.kneeTurn }) : null };

    // ER-2 (Task 10): the k_fit / LstarFit / etaCalls extrapolation chain is retired. burnRate/hBreak
    // (rate-lamp) own the "rounds-remaining / extrapolation" role now, and §17.3 forbids surfacing
    // rounds-remaining on a plateau. theilSen stays EXPORTED from metrics.js (still unit-tested / possible
    // v1.2 reuse) but is no longer imported or used here.
    const Lstar = lStar(baseline.total, cRatio, kAvg);
    const Lcap = contextWindowFor(model) - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;
    const Lthreshold = Math.min(Lstar, Lcap);

    // v2.1 rate-lamp snapshot (§4.1/§4.2). k_stable from the FROZEN baseline's stableMedian (spec
    // §0′-A2), clamped (§3.4). reliable gate = LATCHED state (spec §0′-A3 — reuses the latch's own
    // computeCalibrationGate: latchRes.latched is true only AFTER ensureLatchForPrefix ran the gate,
    // so this IS the shared gate, NOT a hand-rolled second copy), NOT the per-turn _metricsReliable.
    // (Block placed after Lcap so `lCap: Lcap` is in scope — Lcap is computed just above.)
    const kStableReliable = latchRes.latched && Number.isFinite(baseline.stableMedian);
    const kStable = kStableReliable ? clampKStable(baseline.stableMedian) : null;
    const lDead = baseline.dead;
    const rateSnap = {
      L_read: L, lBase: baseline.total, lDead, cRatio, lCap: Lcap,
      kStable, kStableReliable, baselineValid: baseline.total > 0 && cRatio > 0,
    };
    const rateLampInstant = computeRateLampInstant(rateSnap, { scenario: 'fullCarry' });
    if (rateLampInstant.reliable) rateLampInstant.kStable = kStable; // emit frozen k_stable for the ledger's kStableFrozen (GPT#11)

    // metricsReliable first — it gates restart.
    const metricsReliable = this._metricsReliable(seg);

    // Hard restart signal is L >= min(Lstar, Lcap) AND passes the credibility gate.
    // Without gating, empty/warmup data (L=0,Lstar=0) makes L>=Lthreshold trivially true.
    const crossed = L >= Lthreshold;
    const postKneeGrowthCalls = Math.max(0, seg.length - baseline.kneeTurn - 1);
    // calibratingReason is factored through the shared computeCalibrationGate so getStatus and the
    // latch can never drift. Reason ordering is UNCHANGED from the pre-refactor ladder:
    // metrics_unreliable → no_transcript → low_confidence → insufficient_data. Only the last two
    // (low_confidence/insufficient_data) live in the gate; the first two are applied here.
    let calibratingReason;
    if (latchRes.latched) calibratingReason = null;          // no-release: latched ⟹ never calibrating (spec §10.1)
    else if (!metricsReliable) calibratingReason = 'metrics_unreliable';
    // #13: zero calls in this segment AND the transcript was NEVER openable → a bad --transcript/
    // --project path, distinct from a genuinely just-started (empty-but-present) session. More
    // specific than the generic insufficient_data. Cannot mask metrics_unreliable: that requires
    // seg.length >= 3, so with an empty segment metricsReliable is always true. An empty-but-present
    // file sets _transcriptSeen=true on open → falls through to insufficient_data (the distinction).
    else if (seg.length === 0 && !this._transcriptSeen) calibratingReason = 'no_transcript';
    else calibratingReason = computeCalibrationGate({
      metricsReliable, confidence: baseline.confidence, postKneeGrowthCalls,
      baselineTotal: baseline.total, L,
    }).reason;
    const restart = crossed && calibratingReason === null;
    const restartReason = !restart ? null : (Lcap < Lstar ? 'context_cap' : 'cost');

    const rhoVal = rho(cRatio, kAvg, baseline.total);
    const P = paybackP(L, baseline.total);
    const sumOut = seg.reduce((a, c) => a + c.output, 0);
    const paybackOutP = baseline.total > 0 ? sumOut / baseline.total : 0;
    const nNow = seg.length;
    const nStarVal = nStar(cRatio, baseline.total, kAvg);

    return {
      L, Lstar, Lcap, Lthreshold, restart, restartReason, calibratingReason,
      model,
      kAvg, growth: seg.length ? Math.max(0, L - (seg.length >= 2 ? effectiveL(seg[seg.length - 2]) : L)) : 0,
      apiCalls, segment: this._segment,
      uptime: this._uptimeSec(),
      phi: phi(L, baseline.total, cRatio, kAvg),
      paybackP: P, paybackOutP,
      rho: rhoVal,
      timingWeight: timingWeight(rhoVal),
      sweetP: 1 + rhoVal,
      regret: regret(nNow, nStarVal),
      baseline: baselineOut,
      metricsReliable,
      rateLamp: rateLampInstant,
    };
  }

  _metricsReliable(seg) {
    if (seg.length < 3) return true; // insufficient data → don't cry wolf
    // ONE-ROUND LAG alignment: tokens SENT in call t-1 become the cached stock READ in call t.
    // Compare ΔL[t] against gField[t-1], NOT gField[t]. Verified on real deepseek fixture:
    // same-index median residual = 0.883 (false-alarm); one-round-lag = 0.185 (passes).
    // Also skip L-drop rows (ΔL<0 = segment boundary, not real growth).
    const rates = [];
    for (let i = 1; i < seg.length; i++) {
      if (seg[i].miss || seg[i - 1].miss) continue; // miss = known measurement artifact (spec §3.4)
      const raw = seg[i].cacheRead - seg[i - 1].cacheRead;
      if (raw < 0) continue; // L-drop → segment boundary, exclude
      const dL = raw;
      const gFieldPrev = seg[i - 1].gField;
      rates.push(Math.abs(dL - gFieldPrev) / Math.max(1, dL));
    }
    if (rates.length < 2) return true;
    return median(rates) < CONSTANTS.RESIDUAL_MAX;
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
