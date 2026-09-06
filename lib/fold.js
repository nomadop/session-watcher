import { readSync, openSync, closeSync, fstatSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { extractUsage, isUserTurnBoundary, ctpForModel } from './extract.js';
import { classifyMiss } from './l-measure.js';
import { PRECHECK_LONG_LINE_BYTES, PRECHECK_HEAD_CAP_BYTES, DEFAULT_CTP, SEGMENT_DROP_EPSILON, SEGMENT_DROP_FRACTION, PENDING_MAX_TURN_DISTANCE, TOOL_OVERHEAD } from './constants.js';
import { matchAdapter, extractToolResultText, emaStep, gEffective, bashFeature, mcpDisplay, charsToTokens, countsToTokens, CJK_RE } from './measure.js';
import { resolveToolUse, classifyResolvedToolOutcome } from './tool-outcome.js';
import { getStore } from './store.js';
import { computePp } from './bill-regret.js';
import { settleDeferred } from './settle.js';
import { buildTelemetryPayload } from './carry-outcome.js';
import { isGrammarLoaded, isSupported, REGEX_EXTS, loadGrammar } from './symbol-outline.js';
import {
  readCompleteJsonlEventsFromBuffer,
  createTopologyState,
  resetTopologyState,
  indexTopologyEntry,
  detectActiveLeaf as detectActiveLeafShared,
  resolveActivePath as resolveActivePathShared,
  isTopologyAncestor,
  selectCanonicalBranchPaths,
} from './canonical-fold.js';

// Loose, ReDoS-immune boundary precheck (spec §4.3). Double includes on head-resident markers ONLY.
// ALLOWS false positives (an extra JSON.parse); NEVER a false negative on pretty JSON or a giant payload.
// HEAD-CAP ASSUMPTION, scoped to the two boundary markers ONLY: PRECHECK_HEAD_CAP_BYTES (8192) must be >=
// the max byte offset of `"type"` / `"user"`, which for CC transcripts is the line's first field
// (base64/tool payloads are in the tail). That holds on every real transcript measured. It does NOT hold
// for `uuid` or `usage`, which sit after `message.content` and are therefore probed over the whole line in
// poll — do not re-introduce a cap there. If a real transcript ever moves a boundary marker out of the
// head, raise the cap rather than adding a fall-through. `test/fold.precheck.test.js` (the `C4b-1` case)
// pins head-first scanning; the offsets themselves are re-measured against real corpora, not asserted.
export function boundaryPrecheck(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const scan = raw.length > PRECHECK_LONG_LINE_BYTES
    ? raw.slice(0, PRECHECK_HEAD_CAP_BYTES) // head-first: markers are in the line head, base64 is tail
    : raw;
  return scan.includes('"user"') && scan.includes('"type"');
}

// JSONL ingest + fold + segmentation, extracted from SessionWatcher (spec §3). These are the
// measurement-layer functions that turn raw transcript bytes into the folded `w._calls` records the
// baseline/latch/status/history layers consume. They take the watcher instance `w` and mutate its
// private state exactly as the original methods did — SessionWatcher keeps thin delegators so `this`
// dispatch and every test's `w._calls/_segment/_foldRev` access are byte-identical. No behavior change.

export function readNewText(w) {
  let fd;
  try { fd = openSync(w.path, 'r'); } catch { return ''; }
  w._transcriptSeen = true; // openSync succeeded → path is (was) readable, even if the file is empty (#13)
  try {
    const st = fstatSync(fd);
    const size = st.size;
    // Rotation/truncation guard: reset if the file shrank OR the inode changed (new file at same path).
    if (size < w._offset || (w._ino != null && st.ino !== w._ino)) {
      // I/O-layer reset (not in resetFoldState — these are read-level, not fold-level)
      w._offset = 0; w._partial = '';
      if (w._decoder) w._decoder = new StringDecoder('utf8');
      // Archive the dying segment before rotation clears it.
      handleSegmentBoundary(w, { replayMode: false });
      // Reset branch/topology state (segment already bumped by handleSegmentBoundary's segmentReset).
      // clearCalls:false — rotation preserves old-segment calls for getHistory.
      resetFoldState(w, { bumpSegment: false, clearCalls: false });
    }
    w._ino = st.ino;
    // Replay valve: when _replayByteLimit is set, cap how far we read into the file.
    const effectiveSize = (w._replayByteLimit != null) ? Math.min(size, w._replayByteLimit) : size;
    if (effectiveSize <= w._offset) return '';
    const len = effectiveSize - w._offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, w._offset);
    w._offset += read;
    // H3: use StringDecoder to handle multi-byte codepoints split across read boundaries.
    // StringDecoder buffers incomplete trailing bytes and emits them on the next write().
    if (!w._decoder) w._decoder = new StringDecoder('utf8');
    return w._decoder.write(buf.slice(0, read));
  } finally { closeSync(fd); }
}

// Display-only (spec §3.3): the tool events observed since the previous usage fold, for the bucket panel.
// Best-effort — reads the B_rebuild paths touched this turn is deferred; here we drain a per-turn buffer
// populated by processToolEvents. Empty array is acceptable (panel degrades gracefully).
function extractTurnToolEvents(w) {
  const evs = w._turnToolEvents || [];
  w._turnToolEvents = [];
  return evs;
}

// R1-C: The SINGLE source of truth for a segment snapshot. All archival paths call this.
function buildSegmentSnapshot(w, { source, terminal = false, archivedAt } = {}) {
  const s = w.getStatus();
  const safeNum = v => Number.isFinite(v) ? v : null;
  const segTurns = w._turnSeq - w._segmentStartTurn;
  const oAvg = w._segmentUsageCount > 0 ? w._segmentOutputSum / w._segmentUsageCount : null;
  const f = w._segmentFirstTs ? Date.parse(w._segmentFirstTs) : NaN;
  const l = w._segmentLastTs ? Date.parse(w._segmentLastTs) : NaN;
  const durationMs = (Number.isFinite(f) && Number.isFinite(l)) ? l - f : null;
  const at = archivedAt ?? (source === 'replay'
    ? (Number.isFinite(l) ? l : Date.now())
    : Date.now());
  return {
    archivedAt: at, archiveSource: source, model: s.model, projectId: w._projectId || null,
    // #2 archive-口径: b_total must equal the belief the paths sum to (dead + Σpaths), i.e. the UNCAPPED
    // B_full. The read-time cap (getStatus().B = Breported) is for the live dashboard only; persistence
    // and carry-over need the paths-consistent value or dead+Σpaths > b_total. See plan Global Constraints.
    bTotal: w._bRebuild.B(), gFinal: s.g, cRatio: s.cRatio, turns: segTurns, durationMs,
    totalTokensRead: safeNum(w._segmentInputTokens),  // R1-C: accumulated per-call, NOT s.L - start
    mf: s.mf, ppExit: computePp(s.x, s.dhat), brExit: s.br,
    lPeak: w._segmentLPeak, brPeak: w._segmentBrPeak, ppPeak: w._segmentPpPeak,
    gMin: safeNum(w._segmentGMin), turnAtBrAmber: w._segmentTurnAtBrAmber,
    lFloor: w._bRebuild.dead,
    p0: (s.cRatio > 0 && s.g > 0) ? w._bRebuild.dead / (s.cRatio * s.g) : null,
    bAxis: (s.g > 0 && w._segmentUsageCount > 0) ? 2 * oAvg / s.g : null,
    xAxis: (w._bRebuild.dead > 0) ? w._segmentLPeak / w._bRebuild.dead : null,
    oAvg,
  };
}

// Extracted from foldCall's three-branch detection + replayActivePath inter-subtree reset.
// Archives the DYING segment (idempotency-guarded), then delegates to the existing reset path.
// R1-D: sets _lastArchivedSegment ONLY on success; on failure just logs (sweep will retry).
function handleSegmentBoundary(w, { replayMode = false } = {}) {
  // PROFILE-D1: skip archival for segments with zero API calls (boundary fired before any fold work).
  // _segmentStepUsage is the authoritative buffer — it grows with each foldCall and is cleared on
  // segmentReset. Empty buffer → nothing to archive; still reset so the new segment starts clean.
  if (!w._segmentStepUsage || w._segmentStepUsage.length === 0) {
    w.segmentReset();
    return;
  }
  // §2.4c leftover finalization: overshoot still deferred when this segment ends was never confirmed
  // by L → it IS a genuine CTP overestimate. Correct the buckets down by exactly the un-retired
  // per-path remainder BEFORE the snapshot is archived, so the archived profile reflects corrected B.
  // (Telemetry write-back is intentionally NOT done here — see PLC-D2 / Task 2 note.)
  // Take the ledger before applying any of it. A throw part-way through the finalization leaves the
  // segment un-rotated — segmentReset never runs, so `_prevTotalStock` keeps its pre-drop value and every
  // following low-stock row re-enters this boundary. A ledger that still held the corrections already
  // applied would re-apply them on each re-entry and drift B down cumulatively; taking first costs the
  // un-applied tail of one segment's corrections instead, once.
  // Pinned by test/fold.boundary-durability.test.js.
  if (w._bLagLedger.total > 0) {
    const pending = w._bLagLedger.byPath;
    w._bLagLedger = { total: 0, byPath: new Map() };
    for (const [p, amt] of pending) {
      if (amt > 0) w._bRebuild.addCorrection(p, amt);
    }
  }
  if (w._sessionId && w._segment !== w._lastArchivedSegment) {
    const archivedSegment = w._segment;                        // capture before segmentReset (== w._segment here)
    const segCalls = (w._segmentStepUsage || []).slice();      // snapshot telemetry buffers before segmentReset clears them
    const segEvents = (w._segmentPathEvents || []).slice();
    try {   // every archival failure degrades to "segment still rotates, sweep retries" — the fold
            // must not lose the rest of the batch, which _offset already consumed (readNewText).
            // Pinned by test/fold.boundary-durability.test.js.
      // Task 9 replay provenance: honor a watcher-level `_replayMode` in ADDITION to the per-call arg.
      // The carry-sweep drives to EOF via poll() — whose internal fast-path boundaries (foldCall's
      // compact/stock-drop detection) hardcode replayMode:false — plus a terminal boundary. Setting
      // w._replayMode makes EVERY one of those boundaries replay-flavored, so no swept segment is ever
      // mis-stamped 'live'/'cc-live'. In production the live poll ticks leave _replayMode false, while
      // createServer's startup whole-file fold and `replayActivePath` each set it for their own duration.
      const replaying = replayMode || w._replayMode;
      // Task 9 store injection: archive to the watcher's injected store if set (the sweep's reconciled
      // connection), else the global getStore() singleton (production). Resolve ONCE so TXN1 + TXN2 hit
      // the SAME DB — a split would archive the profile to one connection and telemetry to another.
      const store = w._store || getStore();
      const snap = buildSegmentSnapshot(w, { source: replaying ? 'replay' : 'live' });
      const paths = w._bRebuild.snapshot().map(({ path, tokens }) => ({ path, tokens }));
      const result = store.archiveSegmentProfile(w._sessionId, archivedSegment, snap, paths);
      if (result.status === 'archived' || result.status === 'already_archived') {
        w._lastArchivedSegment = archivedSegment;
        // TXN2 gate: (re)write telemetry only when this boundary owns fresh data. A fresh 'archived'
        // always writes; an 'already_archived' writes only when telemetry is not yet captured
        // (pending/failed_retryable/NULL). Skip on already_archived + complete/complete_empty so a
        // lower-priority replay with empty/partial buffers doesn't DELETE-then-INSERT over good rows.
        // This pre-read is a cheap FAST-PATH skip; the AUTHORITATIVE anti-clobber guard is the in-txn
        // re-check inside archiveSegmentTelemetry (Task 7).
        const tstatus = store.getTelemetryStatus(w._sessionId, archivedSegment);
        const shouldWriteTelemetry = result.status === 'archived'
          || tstatus == null || tstatus === 'pending' || tstatus === 'failed_retryable';
        if (shouldWriteTelemetry) {
          try {   // TXN2 (telemetry) — separate txn, best-effort, never blocks the profile path (TXN1).
            const payload = buildTelemetryPayload(segCalls, segEvents);
            // capture_source follows replay-mode: the reused sweep replay (Task 9/10) records
            // 'cc-replay', live records 'cc-live' — one code path, two provenances.
            store.archiveSegmentTelemetry(w._sessionId, archivedSegment, payload, replaying ? 'cc-replay' : 'cc-live');
          } catch (e) {
            if (process.env.SW_DEBUG) console.error('[segment-telemetry]', e.message);
          }
        }
      }
    } catch (e) {
      if (process.env.SW_DEBUG) console.error('[segment-archive]', e.message);
    }
  }
  w.segmentReset();  // existing reset: _bRebuild.clear(), _segment++, _segmentEpoch++, peak resets (Task 5)
}

export function foldCall(w, u, stepMeta = { toolUseCount: 0, loadToken: null }) {
  const foldKey = u.messageId ?? u.requestId ?? null;

  // Snapshot folding FIRST (unchanged): a late snapshot of an existing call must not be seen as a boundary.
  if (foldKey != null && w._byId.has(foldKey)) {
    const idx = w._byId.get(foldKey);
    const totalTok = u.input + u.output + u.cacheRead + u.cacheCreation;
    let changed = false;
    if (totalTok >= w._calls[idx]._total) {
      const prev = w._calls[idx];
      // Delta accumulation for segment totals (revision path)
      const outputDelta = u.output - prev.output;
      const inputDelta = u.input - prev.input;
      if (outputDelta > 0) w._segmentOutputSum += outputDelta;
      if (inputDelta > 0) w._segmentInputTokens += inputDelta;
      w._calls[idx] = { ...prev, cacheRead: u.cacheRead, output: u.output, input: u.input,
        cacheCreation: u.cacheCreation, ts: u.ts, _total: totalTok };
      changed = true;
      w._foldRev++;
      // Update timestamp (revision may carry a later ts)
      if (u.ts) w._segmentLastTs = u.ts;
      // Carry-staleness telemetry: keep the buffered step_usage row in sync with the ACCEPTED revision.
      // This branch returns before the new-call push, so without this a revised step keeps its
      // pre-revision token values AND a load_token / tool_use that only appears in a later revision is
      // lost (the revised row lives only in w._calls, never in _segmentStepUsage). foldedSeq is stable
      // across a revision (no _foldedCallSeq bump here), so locate the row by foldedSeq and refresh its
      // token classes + ts; fill loadToken/toolCalls from this revision's stepMeta when the buffered row
      // lacks them. loadToken is STICKY — never overwrite a non-null with null.
      if (Array.isArray(w._segmentStepUsage)) {
        const seq = w._calls[idx].foldedSeq;
        const buf = w._segmentStepUsage.find(s => s.foldedSeq === seq);
        if (buf) {
          buf.cacheRead = u.cacheRead; buf.cacheCreation = u.cacheCreation;
          buf.input = u.input; buf.output = u.output;
          if (u.ts) buf.ts = Date.parse(u.ts) || buf.ts;
          if (stepMeta && stepMeta.toolUseCount) buf.toolCalls = stepMeta.toolUseCount;   // later revision's tool_use
          if (stepMeta && stepMeta.loadToken && buf.loadToken == null) buf.loadToken = stepMeta.loadToken; // sticky
        }
      }
    }
    return { isNew: false, changed };
  }

  const totalStock = u.cacheRead + u.cacheCreation + u.input;

  if (!w._segmentModel) w._segmentModel = u.model;

  // Segment boundary: topology signal (non-first null-parent root = /compact or /continue).
  // Detected by indexRow; consumed here before folding this row (it is the new segment's first call).
  // Fallback when the topology carries no such root: `totalStock` falling past a floor relative to
  // itself. "Was the conversation prefix replaced?" is one physical question, so one field
  // answers it — a /clear or /compact leaves at most `dead` shared with the previous request, while the
  // dips this floor rejects are sub-1% shrinks from a smaller cache_creation on an untouched prefix.
  // An eviction that re-carries the WHOLE context in cache_creation keeps the stock inside the floor,
  // and classifyMiss then rebuilds L from cacheRead + cacheCreation — but only while the stock stays
  // within its own absolute SEGMENT_DROP_EPSILON, which is far narrower than this floor. A PARTIAL
  // re-carry inside the floor is therefore neither a boundary nor a miss: the epoch correctly stays
  // open while L collapses to the evicted cacheRead. A partial re-carry past the floor opens an epoch.
  if (w._compactDetected) {
    handleSegmentBoundary(w, { replayMode: false });
    w._segmentModel = u.model;
    w._compactDetected = false;
  } else if (w._prevTotalStock > 0
             && totalStock < w._prevTotalStock - Math.max(SEGMENT_DROP_EPSILON, w._prevTotalStock * SEGMENT_DROP_FRACTION)) {
    handleSegmentBoundary(w, { replayMode: false });
    w._segmentModel = u.model;
  }

  // dead: first call of a segment establishes the floor (system prompt + tool defs).
  // Use max(cacheRead, cacheCreation, input) — on a true cold start the first row has cr=0 but
  // input≈42k (the system prompt is sent as input, not yet cached). Using only cr would anchor
  // dead=0, making B undercount and g_ema spike on the second row when cr suddenly appears.
  if (w._bRebuild.dead === 0) {
    w._bRebuild.setDead(Math.max(u.cacheRead, u.cacheCreation, u.input));
    // §2.4b warm-up ceiling: totalStock at anchor = everything that will eventually appear in
    // cacheRead once the cache is fully warm. On partial-cache Claude starts (cr=15k, cc=29k),
    // dead=29k but totalStock=44k; the ceiling absorbs the full warm-up, not just the cold portion.
    w._warmupCeiling = totalStock;
  }

  // B(t) reflects all tool events Stream A processed BEFORE this usage row (spec §3.2). prevB is the
  // snapshot from the PREVIOUS usage row — stable, unambiguous, no circular dependency.
  let B_current = w._bRebuild.B();
  const prevB = w._prevB;

  // v3.1 miss detection against prevL (spec §4): cacheRead dropped while totalStock preserved.
  const miss = classifyMiss({ cacheRead: u.cacheRead, totalStock, prevL: w._prevL, prevTotalStock: w._prevTotalStock });
  const L = miss ? (u.cacheRead + u.cacheCreation) : u.cacheRead;

  // g = EMA(ΔResidual) (spec §2.4). ΔB = B_current − prevB; ΔL = L − prevL. Clamp negative ΔResidual.
  let residual = 0; // hoisted for rec metadata — stores the CLAMPED max(0, ΔL−ΔB), not raw ΔL.
  if (w._prevL != null) {
    // §2.4b Dead-zone warm-up guard: when prevL < warmupCeiling, a portion of deltaL is the
    // system prompt appearing in cacheRead (cache warming up) — it's already in B as dead, so
    // it would produce a spurious residual spike (inflating g_ema and misattributing to residual
    // tools). Only count L growth ABOVE the ceiling as genuine. The ceiling is totalStock at the
    // segment anchor (= what will fill cacheRead once fully warm). Once prevL >= ceiling this
    // never fires again (structural).
    let deltaL = L - w._prevL;
    const ceiling = w._warmupCeiling || 0;
    if (ceiling > 0 && w._prevL < ceiling && deltaL > 0) {
      deltaL = Math.max(0, L - ceiling);
    }
    // §2.4c DEFERRED SETTLEMENT (replaces §2.5's immediate correction). When ΔB > ΔL, B has been
    // credited for content that has not yet materialized in L (the cc→cr / input→cr cache-warm lag).
    // At credit time this is INDISTINGUISHABLE from a genuine CTP overestimate — the current-row
    // `uncached = totalStock − L` lags B-crediting by several rows. The old §2.5 deleted the buckets
    // here and thereby destroyed real content 99.2% of the time (see plan). settleDeferred instead
    // matches this row's ΔB against this row's ΔL ONCE, banks only the leftover B-surplus per-path,
    // and retires the historical ledger only with the leftover L-surplus — so the catch-up ΔL is
    // netted (not charged to a co-located tool, not allowed to spike g_ema) and cannot be double-
    // counted (report #1). The buckets are UNTOUCHED here: B keeps its full belief; only the never-
    // retired remainder is corrected out at the segment boundary (handleSegmentBoundary) as true CTP.
    const deltaB = B_current - prevB;              // full uncapped credit — B_current is NOT modified
    const pathDeltas = w._intervalPathDeltas;
    w._intervalPathDeltas = new Map();
    const st = settleDeferred(deltaL, deltaB, pathDeltas, w._bLagLedger);
    residual = st.residual;
    // Telemetry: only the same-row B-surplus that NO path can explain is genuine drift now; banked
    // lag is excluded (it is either retired later, or finalized at the boundary — Task 2). Note
    // ctpOvershoot has no live consumer today (see PLC-D2); this keeps it correct regardless.
    w._ctpOvershoot += st.ctpImmediate;
    // g's input channel is ΔtotalStock − ΔB, NOT the settled ΔL residual above. cacheRead only
    // advances when the cache prefix advances, so new content parks in cacheCreation first and
    // ΔcacheRead arrives in blocks; max(0,·) clips the negative side only, so that blockiness is
    // rectified into a ~11% upward bias in g (input mean 1406 vs 1270 across the corpus). totalStock
    // has no such lag — `computeHistoryPoint` already switched the chart to it for the same reason. ΔB
    // is still subtracted: B enters landmarksFor twice on its own (as the floor offset b and as the √b
    // factor on dhat), so charging g for rebuildable growth would double-count it.
    // _prevTotalStock is g's prevStock: the new-call path snapshots it from this same expression at
    // foldCall's tail, the revision path returns before that and leaves it naming the previous NEW
    // call, and `resetFoldState` plus `segmentReset` clear it. Its semantics must stay "totalStock at
    // the previous usage row" — repointing it at, say, the pre-miss stock would silently move g.
    let dStock = totalStock - w._prevTotalStock;
    // Recovery above the anchor only: a stock drop that stays inside the segment floor
    // keeps the segment alive with _prevTotalStock BELOW the ceiling — a released cache_creation is
    // the shape that does it — and re-warming back up to the anchor is not growth.
    if (ceiling > 0 && w._prevTotalStock < ceiling && dStock > 0) dStock = Math.max(0, totalStock - ceiling);
    const gInput = Math.max(0, dStock - deltaB);
    w._g_ema = emaStep(w._g_ema, gInput);   // never null: the cold-start arm below seeded it via gEffective
    // Distribute this call's clamped deltaResidual across the turn's unmatched Bash/MCP tools by weight
    // (spec §11.3.2). 91% of intervals have exactly 1 tool → it takes all. Σweight=0 → split evenly.
    const resTools = w._turnResidualTools || [];
    if (resTools.length && residual > 0) {
      const totalW = resTools.reduce((s, t) => s + t.weight, 0);
      for (const t of resTools) {
        const share = totalW > 0 ? residual * (t.weight / totalW) : residual / resTools.length;
        const prev = w._residualByTool.get(t.key) || { tokens: 0, lastTurn: 0, lastCallSeq: 0, count: 0, kind: t.kind, detail: t.detail, touchSeqs: [] };
        prev.tokens += share; prev.lastTurn = w._turnSeq; prev.lastCallSeq = w._foldedCallSeq; prev.count += 1; prev.kind = t.kind; prev.detail = t.detail;
        prev.touchSeqs.push({ seq: w._foldedCallSeq, mode: t.hadError ? 'e' : 'w' }); // 'e' reserved for future error-specific coloring
        if (prev.touchSeqs.length > 128) prev.touchSeqs = prev.touchSeqs.slice(-64);
        w._residualByTool.set(t.key, prev);
      }
    }
    w._turnResidualTools = [];
    // Drop residual tool_use whose tool_result never arrived (interrupted/errored) — bounded by turn distance.
    if (w._pendingResidual?.size) {
      for (const [id, p] of w._pendingResidual) {
        if (w._turnSeq - (p.turn ?? 0) > PENDING_MAX_TURN_DISTANCE) w._pendingResidual.delete(id);
      }
    }
  } else if (w._g_ema == null) {
    w._g_ema = gEffective(null); // cold start → G_FLOOR
    w._turnResidualTools = [];
    w._intervalPathDeltas = new Map();
  }

  if (w._pendingTurnBump || w._turnSeq === 0) { w._turnSeq++; w._pendingTurnBump = false; }
  if (foldKey != null) w._byId.set(foldKey, w._calls.length);
  w._foldedCallSeq++;

  const toolEvents = extractTurnToolEvents(w); // display metadata (spec §3.3)
  const rec = {
    messageId: u.messageId, cacheRead: u.cacheRead, output: u.output, input: u.input,
    cacheCreation: u.cacheCreation, model: u.model, ts: u.ts,
    segment: w._segment, _total: u.input + u.output + u.cacheRead + u.cacheCreation,
    L, miss,
    foldedSeq: w._foldedCallSeq, turnSeq: w._turnSeq,
    // v3 per-call metadata (display layer):
    // §I read-time cap: history/display reads the invariant-safe value; reconciliation (_prevB, set
    // below) keeps the uncapped belief so the next row's ΔB is correct.
    B_at_call: Math.min(B_current, totalStock), g_at_call: gEffective(w._g_ema), deltaResidual: residual, toolEvents,
  };
  w._calls.push(rec);

  // Carry-staleness telemetry: one raw step_usage record per folded API step (spec profile_step_usage).
  // tool_calls + load_token come from THIS entry's stepMeta (entry-local) — a sidechain entry's stepMeta
  // never reaches here (foldEntries skips its foldCall), so its count/token cannot leak. No pending
  // watcher fields, no post-push reset. toolCalls uses stepMeta.toolUseCount (EVERY tool_use block), NOT
  // rec.toolEvents.length (file-adapter successes only → under-counts Bash/MCP fan-out + failed reads).
  (w._segmentStepUsage ||= []).push({
    foldedSeq: w._foldedCallSeq,
    ts: u.ts ? Date.parse(u.ts) || null : null,
    cacheRead: u.cacheRead, cacheCreation: u.cacheCreation,
    input: u.input, output: u.output,
    toolCalls: stepMeta.toolUseCount || 0,
    loadToken: stepMeta.loadToken || null,
  });

  // post-v3 §3.2: per-foldCall segment accumulation (new-call path only — snapshot path returns earlier).
  w._segmentOutputSum += u.output;
  w._segmentUsageCount++;
  w._segmentInputTokens += u.input;  // R1-C: accumulated per-call → total_tokens_read
  if (u.ts) { if (!w._segmentFirstTs) w._segmentFirstTs = u.ts; w._segmentLastTs = u.ts; }
  w._updateSegmentPeaks(L, B_current);

  // §2.4 Provider-safety breaker: reasoning tokens never enter L (physical invariant), so the
  // REASONING-ONLY sum must stay bounded by L. If it exceeds L, the attribution has drifted
  // (e.g., provider mislabeled content as thinking). Compare reasoning sum alone — cumulative
  // content-spent legitimately exceeds instantaneous L in any high-churn session (not drift).
  if (!w._reasoningAttributionDisabled && w._bRebuild._totalSpentReasoning.size > 0) {
    const reasoningSum = w._bRebuild.totalReasoningSpentSum();
    if (reasoningSum > L) {
      w._bRebuild.dropReasoningSpent();
      w._reasoningAttributionDisabled = true;
      console.warn('bucket reasoning drift → content-only mode');
    }
  }

  // Snapshot for the NEXT usage row.
  w._prevB = B_current;
  w._prevL = L;
  w._prevTotalStock = totalStock;
  return { isNew: true, changed: true };
}

// Re-export the byte reader from canonical-fold.js for backward compatibility.
// Consumers that only need the reader can import from either module.
export { readCompleteJsonlEventsFromBuffer } from './canonical-fold.js';

// --- Branch indexer (M9) — delegated to canonical-fold.js shared topology ---

function indexRow(w, entry) {
  indexTopologyEntry(w._topology, entry);
  // Mirror the topology compact signal to a watcher-level field. Its readers are foldCall, which opens a
  // segment on it, and poll's first-poll branch, which replays all subtrees when the file already contains
  // compact boundaries at the first read.
  w._compactDetected = w._topology.compactDetected;
}

function detectActiveLeaf(w) {
  return detectActiveLeafShared(w._topology);
}

function resolveActivePath(w, leafUuid) {
  return resolveActivePathShared(w._topology, leafUuid);
}

function isAncestorOf(w, ancestor, descendant) {
  return isTopologyAncestor(w._topology, ancestor, descendant);
}

// Unified reset helper — rotation/fork/replay paths go through this.
// Prevents state field drift by centralizing the reset list.
// `clearCalls`: true for full replay (fork/rewind — re-fold from file); false for rotation
//   (rotation keeps old-segment calls for getHistory, only clears per-segment state).
function resetFoldState(w, { bumpSegment = false, bumpFoldRev = true, clearCalls = true } = {}) {
  if (clearCalls) w._calls.length = 0;
  w._byId.clear();
  if (bumpSegment) w._segment++;
  else if (clearCalls) w._segment = 0;  // full replay resets to 0; partial reset (rotation) preserves
  w._segmentModel = null;
  if (clearCalls) { w._foldedCallSeq = 0; w._turnSeq = 0; w._pendingTurnBump = false; }
  if (bumpFoldRev) w._foldRev++;
  // M9 branch state — shared topology
  resetTopologyState(w._topology);
  w._activeLeafUuid = null;
  w._compactDetected = false;
  // v3: rebuild B/g from scratch on a full reset OR a segment rotation (new segment re-derives
  // B/g from the new transcript content; stale _prevTotalStock would trigger a false boundary).
  if (clearCalls || bumpSegment) {
    w._bRebuild.clear(); w._bRebuild.setDead(0); w._warmupCeiling = 0;
    // `_ctp` belongs to this set because `foldEntries` assigns it only while null: a replay
    // that carries it folds the whole re-read under the pre-replay model's CTP, which flows through
    // `classifyResolvedToolOutcome` into every measure.js adapter and so sets B itself. No test pins
    // this line. Divergence needs a branch whose first usage row resolves to a different `CTP_TABLE`
    // row, and every `claude-*` id shares one, so only a `<synthetic>`-first branch qualifies: 5 such
    // branches in the deepseek fixtures, none in the claude corpus.
    w._g_ema = null; w._prevB = 0; w._prevL = null; w._prevTotalStock = 0; w._ctp = null; w._ctpOvershoot = 0;
    w._bLagLedger = { total: 0, byPath: new Map() };
    w._pendingTool.clear(); w._segmentEpoch++; w._turnToolEvents = [];
    w._residualByTool = new Map(); w._turnResidualTools = []; w._pendingResidual = new Map();
    w._intervalPathDeltas = new Map();
    w._completedSkills = new Map();
    w._reasoningAttributionDisabled = false; // §2.4 reset: new segment starts fresh
    w._userOverrides.clear(); // F4: fork/rewind must not carry stale overrides into replayed subtree
    // post-v3 §3.2: segment accumulator reset (full wipe — rotation or replay start)
    w._resetSegmentAccumulators();
    w._lastArchivedSegment = -1;
  }
}

// Shared entry-processing loop used by both foldSubset (replay) and poll (live).
// pathFilter: a Set of active-path uuids, or null to accept all entries.
// Returns { newCalls, changed } for poll; foldSubset ignores the return.
function foldEntries(w, entries, pathFilter) {
  let newCalls = 0, changed = false;
  for (const entry of entries) {
    if (pathFilter && entry.uuid && !pathFilter.has(entry.uuid)) continue;
    // readNewText advanced `_offset` over this whole batch before any of it folded, so nothing here is
    // ever re-read: an escaping throw costs every entry behind it, permanently. Confine the loss to the
    // entry that threw — `newCalls`/`changed` never see it, and `w._foldErrors` reports it. Rewinding
    // `_offset` to re-read the batch is not the alternative: the entries already folded would re-apply
    // their tool events through processToolEvents and double-count B.
    // Pinned by test/fold.boundary-durability.test.js.
    try {
      if (w._ctp == null && entry.type === 'assistant' && entry.message?.usage && entry.message?.model) {
        w._ctp = ctpForModel(entry.message.model);
      }
      // Carry-staleness telemetry: processToolEvents RETURNS entry-local stepMeta {toolUseCount,
      // loadToken}; capture it and pass into foldCall below. isSidechain gates the path-event capture and
      // is read from the NATIVE top-level marker (entry.isSidechain === true) — the same field
      // extractUsage and isUserTurnBoundary in lib/extract.js read — NOT extractUsage(entry)
      // ?.isSidechain: path events fire in the tool_result branch, which runs on a `user` entry where
      // extractUsage returns null (isSidechain would be a false-negative → a sidechain touch would leak).
      const stepMeta = processToolEvents(w, entry, w._turnSeq, { isSidechain: entry.isSidechain === true });
      if (entry.isMeta === true && entry.sourceToolUseID && w._completedSkills?.has(entry.sourceToolUseID)) {
        const sk = w._completedSkills.get(entry.sourceToolUseID);
        if (sk.epoch === w._segmentEpoch) {
          const text = extractSkillText(entry);
          if (text) {
            const tokens = charsToTokens(text, w._ctp || DEFAULT_CTP);
            w._bRebuild.apply({ type: 'fullSet', lines: [[1, tokens]], overhead: TOOL_OVERHEAD.Read }, sk.path, w._turnSeq, w._foldedCallSeq);
          }
        }
        w._completedSkills.delete(entry.sourceToolUseID);
        continue;
      }
      // Agent task-notification: type=user with string content starting with <task-notification>.
      // Track in residualByTool (kind='agent') so it appears in the tools bucket alongside bash/mcp.
      if (entry.type === 'user' && typeof entry.message?.content === 'string'
          && entry.message.content.trimStart().startsWith('<task-notification>')) {
        const content = entry.message.content;
        const tidMatch = content.match(/<task-id>([^<]+)<\/task-id>/);
        const tidPrefix = tidMatch ? tidMatch[1].slice(0, 8) : '';
        const summaryMatch = content.match(/<summary>([^<]*)<\/summary>/);
        const detail = summaryMatch ? summaryMatch[1].replace(/^Agent "(.+)" finished$/, '$1') : tidPrefix;
        (w._turnResidualTools ||= []).push({ key: 'agent:' + tidPrefix, detail, kind: 'agent', weight: content.length, hadError: false });
        continue;
      }
      if (isUserTurnBoundary(entry)) { w._pendingTurnBump = true; continue; }
      const u = extractUsage(entry);
      if (!u || u.isSidechain) continue;   // sidechain stepMeta is discarded here — cannot leak
      const r = foldCall(w, u, stepMeta);
      if (r.isNew) newCalls++;
      if (r.changed) changed = true;
    } catch (e) {
      w._foldErrors++;
      if (process.env.SW_DEBUG) console.error('[fold-entry]', e.message);
    }
  }
  return { newCalls, changed };
}

// Fold a subset of events filtered by pathSet into the current segment.
function foldSubset(w, events, pathSet) {
  foldEntries(w, events, pathSet);
}

function replayActivePath(w) {
  // Re-read and re-index the full file, then fold active-path rows.
  // Multiple null-parent roots → fold each subtree into its own segment (one per root, in file
  // order) so the history chart can page through all of them. That question is settled by the
  // branches this replay just built, never by w._compactDetected: the first replay CONSUMES that
  // signal, so a later ordinary rewind would read false and re-fold a multi-root file as a single
  // segment, taking every pre-compact segment with it.
  let fd;
  try { fd = openSync(w.path, 'r'); } catch { return; }
  // Reset AFTER successful open — if open fails, preserve existing state (#1 review fix)
  resetFoldState(w);
  w._partial = '';
  // Every boundary raised below reconstructs an epoch that already ended — this re-folds a transcript
  // already written, so nothing it crosses is being observed. The two boundaries in this function pass
  // `replayMode: true` themselves, but `foldCall`'s stock-drop fallback fires from inside `foldSubset`
  // and hardcodes false, so the watcher-level flag is what stamps that one 'replay'/'cc-replay' as well
  // (`handleSegmentBoundary` ORs the two). Restored in `finally` AHEAD of `closeSync`, so a throwing
  // close cannot leave the flag set and stamp every later boundary on this watcher a replay — the poll
  // ticks after this ARE live, the same contract `createServer`'s startup fold keeps.
  const wasReplayMode = w._replayMode;
  w._replayMode = true;
  try {
    const st = fstatSync(fd);
    // Replay valve: respect _replayByteLimit during replay (same as readNewText)
    const readSize = (w._replayByteLimit != null) ? Math.min(st.size, w._replayByteLimit) : st.size;
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, 0);
    const safeBuf = buf.subarray(0, bytesRead);
    const { events, observations } = readCompleteJsonlEventsFromBuffer(safeBuf, { atEof: w._replayByteLimit == null });

    // Each branch arrives with the path its observations were filtered by — no second derivation.
    const branches = selectCanonicalBranchPaths(observations);

    // Rebuild topology from the full raw-observation scan BEFORE folding, so the active leaf below and
    // the topology the fold itself consults describe the whole file rather than one batch of it.
    resetTopologyState(w._topology);
    for (const obs of observations) {
      indexTopologyEntry(w._topology, obs.entry);
    }
    w._activeLeafUuid = detectActiveLeafShared(w._topology);
    // Suppress compact signal — we handle boundaries manually during replay.
    // Clear both the mirror AND the topology state so a subsequent incremental poll
    // does not re-fire the consumed compact signal.
    w._topology.compactDetected = false;
    w._compactDetected = false;

    if (branches.length > 1) {
      // Compact replay: fold each branch into its own segment.
      for (let i = 0; i < branches.length; i++) {
        if (i > 0) { handleSegmentBoundary(w, { replayMode: true }); w._pendingTurnBump = false; }
        foldSubset(w, branches[i].observations.map(obs => obs.entry), branches[i].path);
      }
      // The newest write is normally in the newest root, so the segment left current above is the
      // live one and this is a no-op. A rewind INTO a pre-compact root breaks that: folding onward
      // would file the live epoch's next calls into the segment an abandoned root owns, leaving one
      // segment measuring two epochs. Open a fresh one instead — a live epoch split across segments
      // is a paging artefact, whereas two epochs inside one segment is a measurement error.
      const liveBranch = branches.findIndex(b => b.path && b.path.has(w._activeLeafUuid));
      if (liveBranch !== -1 && liveBranch !== branches.length - 1) {
        handleSegmentBoundary(w, { replayMode: true });
        w._pendingTurnBump = false;
      }
    } else {
      // Plain rewind/fork or no tree: single-pass fold against the one branch's own path. Taking the
      // path from the branch rather than re-resolving it from the whole-file newest write is what
      // keeps an unreachable island out of the fold: an entry whose parentUuid was never written adds
      // no root, so it never becomes a branch of its own, yet it CAN be the newest write — and its
      // ancestor chain holds no part of the conversation, so folding against it would replace the
      // whole folded history with the island. `path` is null exactly when there is no tree.
      foldSubset(w, events, branches[0]?.path ?? null);
    }
  } finally { w._replayMode = wasReplayMode; closeSync(fd); }
}

// Extract concatenated text from an isMeta skill content message.
function extractSkillText(entry) {
  const c = entry.message?.content;
  if (!Array.isArray(c)) return null;
  let text = '';
  for (const block of c) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text || null;
}

// Stream A (spec §3.1): process tool_use / tool_result blocks in batch order, applying adapter B updates
// on SUCCESS only (unified deferred model — no pre-update, no rollback). Epoch-bounded: a tool_result
// whose pending tool_use was issued in a PRIOR segment epoch is discarded (spec invariant 9).
export function processToolEvents(w, entry, turn, { isSidechain = false } = {}) {
  const msg = entry?.message;
  if (!msg) return { toolUseCount: 0, loadToken: null };
  const blocks = Array.isArray(msg.content) ? msg.content : null;
  if (!blocks) return { toolUseCount: 0, loadToken: null };

  // Carry-staleness telemetry, ENTRY-LOCAL (returned; never stashed on w). stepToolUseCount is the
  // precise per-entry tool_use-block count (file/Bash/MCP alike); stepLoadToken is the first
  // load_handoff token seen in THIS entry. Returned so foldEntries can pass them to foldCall — a
  // sidechain entry's stepMeta is discarded (its foldCall is skipped), so it can never leak.
  let stepToolUseCount = 0;
  let stepLoadToken = null;

  // §2.4 Same-path reasoning attribution: track last resolved tool path and accumulate
  // reasoning chars between consecutive tool_use blocks targeting the same path.
  // Use integer counters (chars + CJK chars) instead of string accumulation to avoid
  // building large intermediate strings solely for their .length.
  let lastToolPath = null;
  let accReasoningChars = 0;
  let accReasoningCjk = 0;

  for (const block of blocks) {
    // Accumulate text/thinking block chars for reasoning attribution (§2.4).
    if (block?.type === 'text' || block?.type === 'thinking') {
      if (!w._reasoningAttributionDisabled) {
        const chunk = block.text || block.thinking || '';
        accReasoningChars += chunk.length;
        accReasoningCjk += (chunk.match(CJK_RE) || []).length;
      }
      continue;
    }
    if (block?.type === 'tool_use') {
      // Telemetry (entry-local): count EVERY tool_use block — file, Bash, MCP alike — BEFORE adapter
      // matching, so tool_calls matches the spec's "tool_use blocks in this step" (not the file-only
      // rec.toolEvents count, which under-counts Bash/MCP fan-out + failed reads).
      stepToolUseCount++;
      // Capture the load_handoff token so it can be stamped onto this step's step_usage row. The token
      // comes from the tool INPUT when the agent passed one explicitly (a token-driven /clear load).
      if (typeof block.name === 'string' && block.name.endsWith('load_handoff')) {
        if (block.input && typeof block.input.load_token === 'string') {
          if (stepLoadToken == null) stepLoadToken = block.input.load_token;   // our own id, no privacy surface
          else if (stepLoadToken !== block.input.load_token && process.env.SW_DEBUG) {
            console.error('[telemetry] multiple load_handoff tokens in one step; keeping first');
          }
        } else {
          // AUTO-MATCH / query load: NO input.load_token. Remember this tool_use_id so the resolved
          // token can be back-filled onto the ISSUING step from the matching tool_result (which arrives
          // in a LATER user entry — see the tool_result branch). Cross-entry, so it lives on w._* (same
          // lifetime pattern as w._pendingTool), keyed by tool_use_id → no leak risk.
          (w._pendingLoadHandoff ||= new Set()).add(block.id);
        }
      }
      const cwd = entry.cwd || w.cwd || dirname(w.path);
      const resolved = resolveToolUse({ name: block.name, input: block.input || {} }, cwd);
      if (!resolved.adapter || resolved.extractError) {
        // Residual display tracking (spec §2.6, §11.3.2): tag unmatched Bash + MCP tools so the bucket
        // panel can show them. Bash name = raw command; MCP name = tool name. Everything else → text residual.
        const isBash = block.name === 'Bash';
        const isMcp = typeof block.name === 'string' && block.name.startsWith('mcp__');
        if (isBash || isMcp) {
          // Task 0b: extract a SAFE display key server-side — raw command (with secrets in args) is
          // never stored. bash → { name, detail }; mcp → prettified tool name.
          let key, detail = '';
          if (isBash) { const f = bashFeature(block.input?.command); key = f.name || '(bash)'; detail = f.detail || ''; }
          else { key = mcpDisplay(block.name); }
          const inputLen = JSON.stringify(block.input || {}).length;  // weight component; raw input NOT stored (secrets)
          w._pendingResidual ||= new Map();
          w._pendingResidual.set(block.id, { key, detail, kind: isBash ? 'bash' : 'mcp', inputLen, epoch: w._segmentEpoch, turn: w._turnSeq });
        }
        // No adapter → break reasoning chain (non-file tool interrupts same-path sequence)
        lastToolPath = null; accReasoningChars = 0; accReasoningCjk = 0;
        continue; // no adapter or extractPath error → residual (B unchanged)
      }
      // Bash adapter matches on name but returns null path for non-file-read commands (npm test, git log, etc.).
      // Those are residual — they don't update B but DO consume context. Track them the same as unmatched tools.
      if (resolved.path == null && block.name === 'Bash') {
        const f = bashFeature(block.input?.command);
        const key = f.name || '(bash)';
        const detail = f.detail || '';
        const inputLen = JSON.stringify(block.input || {}).length;
        w._pendingResidual ||= new Map();
        w._pendingResidual.set(block.id, { key, detail, kind: 'bash', inputLen, epoch: w._segmentEpoch, turn: w._turnSeq });
        // Break reasoning chain (non-file tool interrupts same-path sequence)
        lastToolPath = null; accReasoningChars = 0; accReasoningCjk = 0;
        continue;
      }
      w._pendingTool.set(block.id, { adapter: resolved.adapter, input: block.input || {}, path: resolved.path, cwd, epoch: w._segmentEpoch });
      // §2.4 Same-path reasoning attribution: if this tool_use targets the same path as the previous
      // tool_use AND there were intermediate thinking/text chars, attribute those to the path.
      if (!w._reasoningAttributionDisabled && resolved.path != null && accReasoningChars > 0 && resolved.path === lastToolPath) {
        const reasoningTokens = countsToTokens({ chars: accReasoningChars, cjk: accReasoningCjk }, w._ctp || DEFAULT_CTP);
        w._bRebuild.addReasoningSpent(resolved.path, reasoningTokens);
      }
      // Update tracking state for next iteration
      lastToolPath = resolved.path;
      accReasoningChars = 0; accReasoningCjk = 0;
    } else if (block?.type === 'tool_result') {
      // Auto-match load-token back-fill (runs FIRST, before the residual `continue` below — an MCP
      // load_handoff tool_use is tracked in _pendingResidual, so its tool_result takes that branch).
      // An auto-match / query load carries no input.load_token, so the step_usage row was pushed with
      // loadToken=null during the load entry's foldCall. The load_handoff tool_result returns the
      // resolved token (formatHandoffFull), so recover it and stamp it onto the ISSUING step. At
      // tool_result time w._foldedCallSeq === that step's foldedSeq (correct-by-construction: no
      // foldCall runs between a tool_use and its result), so the target is the buffered row whose
      // foldedSeq === w._foldedCallSeq and loadToken is still null.
      if (w._pendingLoadHandoff && w._pendingLoadHandoff.has(block.tool_use_id)) {
        w._pendingLoadHandoff.delete(block.tool_use_id);
        const resultText = extractToolResultText(block);
        let resolved = null;
        try { const parsed = JSON.parse(resultText); if (parsed && typeof parsed.load_token === 'string') resolved = parsed.load_token; }
        catch { /* non-JSON / partial result → leave null, no throw */ }
        if (resolved && Array.isArray(w._segmentStepUsage)) {
          const buf = w._segmentStepUsage.find(s => s.foldedSeq === w._foldedCallSeq && s.loadToken == null);
          if (buf) buf.loadToken = resolved;
        }
      }
      const pendResidual = w._pendingResidual?.get(block.tool_use_id);
      if (pendResidual) {
        w._pendingResidual.delete(block.tool_use_id);
        if (pendResidual.epoch === w._segmentEpoch) {
          // Errored tool_results also attribute (external review DS#12): failed Bash/MCP output
          // should appear as a selectable leaf, not silently merge into `others`.
          const resultText = extractToolResultText(block);
          const weight = pendResidual.inputLen + resultText.length;
          (w._turnResidualTools ||= []).push({ key: pendResidual.key, detail: pendResidual.detail, kind: pendResidual.kind, weight, hadError: block.is_error === true });
        }
        continue;
      }
      const pending = w._pendingTool.get(block.tool_use_id);
      if (!pending) continue;
      w._pendingTool.delete(block.tool_use_id);
      if (pending.epoch !== w._segmentEpoch) continue; // stale epoch (segment reset between use/result) → discard
      // Unified tool outcome classification (Task 3): single decision point for Path/Skill/Residual.
      // classifyResolvedToolOutcome handles: is_error, adapter exceptions, ineffective updates.
      // Failed/error/no-update/exception paths never call BRebuild.apply (safe direction).
      const outcome = classifyResolvedToolOutcome(pending, block, w._ctp || DEFAULT_CTP);
      if (outcome.kind === 'residual') {
        if (process.env.SW_DEBUG && outcome.reason === 'adapter_exception') {
          console.error('[adapter]', pending.adapter?.name, 'classification residual:', outcome.reason);
        }
        continue;
      }
      const update = outcome.update;
      // §6 inference: track which paths exist BEFORE apply for new-path detection.
      // For grepMultiFile (pending.path is null), capture all file keys from the update.
      const hadPath = pending.path ? w._bRebuild.paths.has(pending.path) : true;
      const hadGrepPaths = (!pending.path && update && update.type === 'grepMultiFile' && update.files)
        ? new Set(Object.keys(update.files).filter(p => w._bRebuild.paths.has(p)))
        : null;
      // §2.5 CTP correction: track per-path delta for overshoot distribution in foldCall.
      const beforeTotal = pending.path ? w._bRebuild.pathTotal(pending.path) : 0;
      w._bRebuild.apply(update, pending.path, turn, w._foldedCallSeq);
      // Fire-and-forget warmup: loadGrammar chains on initParser internally (single-flight)
      if (pending.path && !pending.path.startsWith('skill:')) {
        const ext = extname(pending.path).toLowerCase();
        if (isSupported(ext) && !REGEX_EXTS.has(ext) && !isGrammarLoaded(ext)) {
          loadGrammar(ext).catch(() => {}); // chains initParser → loadGrammar; retry-safe
        }
      }
      // §6 inference: single-path tool — infer if path is genuinely new
      if (pending.path && !hadPath) w._tryInferOverride(pending.path);
      // §6 inference: grepMultiFile — infer for each genuinely new path
      // (G5 fix: grep can introduce new paths that break unanimity for future Reads)
      // H2 note: sequential inference is ORDER-DEPENDENT when multiple new paths are siblings.
      // A batch-mate at default state breaks unanimity. This is intentionally conservative —
      // under-inference (null) is safe; wrong-inference would not be. Accepted behavior.
      if (hadGrepPaths && update.files) {
        // F11: hoist key snapshot outside loop to avoid O(M×N) repeated allocation
        const grepKeys = w._bRebuild.pathTokenPairs().map(p => p.path);
        for (const gp of Object.keys(update.files)) {
          if (!hadGrepPaths.has(gp)) w._tryInferOverride(gp, grepKeys);
        }
      }
      (w._turnToolEvents ||= []).push({ name: pending.adapter.name, path: pending.path || null, isError: false });
      // Carry-staleness telemetry: capture path event(s) for MAIN-CHAIN entries ONLY. A sidechain
      // (sub-agent) tool_result must NOT be recorded as a main-segment touch at the main chain's
      // _foldedCallSeq — B-rebuild's own sidechain handling is unchanged; only this telemetry push
      // is gated. foldedSeq is correct-by-construction (issuing step); see foldEntries hoist note.
      if (!isSidechain) {
        if (update.type === 'grepMultiFile' && update.files) {
          // Grep: extractPath returns null (pending.path is null), so a single `if (pending.path)`
          // push would drop ALL grep touches. Fan out one event per matched file (partial read).
          // Per-file rawPath equals the resolved path — the original tool arg was a pattern, not a path.
          for (const fpath of Object.keys(update.files)) {
            (w._segmentPathEvents ||= []).push({
              foldedSeq: w._foldedCallSeq, path: fpath, rawPath: fpath,
              toolType: pending.adapter.name, isFullRead: 0,
            });
          }
        } else if (pending.path) {
          const isFullRead = update.type === 'fullSet' ? 1
            : update.type === 'lineUpdate' ? 0
            : null;   // write/editDelta: not a read → n/a
          (w._segmentPathEvents ||= []).push({
            foldedSeq: w._foldedCallSeq,
            path: pending.path,
            rawPath: (pending.input && (pending.input.file_path || pending.input.path)) || pending.path,
            toolType: pending.adapter.name,
            isFullRead,
          });
        }
      }
      // Track completed Skill calls so the subsequent isMeta content message can overwrite B
      // with the real payload size (tool_result only contains "Launching skill: ..." confirmation).
      if (pending.adapter.name === 'Skill' && pending.path) {
        (w._completedSkills ||= new Map()).set(block.tool_use_id, { path: pending.path, epoch: pending.epoch });
      }
      // Track positive path growth for interval correction (negative deltas = file shrank, not correctable).
      if (pending.path) {
        const delta = w._bRebuild.pathTotal(pending.path) - beforeTotal;
        if (delta > 0) {
          if (!w._intervalPathDeltas) w._intervalPathDeltas = new Map();
          w._intervalPathDeltas.set(pending.path, (w._intervalPathDeltas.get(pending.path) || 0) + delta);
        }
      }
    }
  }
  // Entry-local step metadata for foldEntries → foldCall (a sidechain entry's is discarded upstream).
  return { toolUseCount: stepToolUseCount, loadToken: stepLoadToken };
}

// Public API for rotation callers (doRotation in server.js). Wraps the internal
// handleSegmentBoundary so server.js doesn't depend on fold's private state-machine API.
export function archiveCurrentSegment(w) {
  handleSegmentBoundary(w, { replayMode: false });
}

// Exported for the Task 8 wiring test (drives the real boundary with empty buffers on an
// already-complete segment to pin the TXN2 skip). The named-export form buys no encapsulation — the
// symbol is reachable either way, and only ever pinned the shape of a declaration. What keeps callers
// off it is that segment archiving is reached through archiveCurrentSegment.
export { handleSegmentBoundary };

export function poll(w) {
  // IMPORTANT: call readNewText FIRST, then read w._partial. If readNewText detects
  // rotation/truncate it clears w._partial — reading _partial before the call would
  // capture the stale value and prepend old-session garbage to new-session content.
  const chunk = readNewText(w);
  const text = w._partial + chunk;
  const nl = text.lastIndexOf('\n');
  if (nl < 0) { w._partial = text; return { newCalls: 0, changed: false }; }
  w._partial = text.slice(nl + 1);
  const complete = text.slice(0, nl);

  // --- Phase A: parse batch, build branch index ---
  const batch = [];
  for (const raw of complete.split('\n')) {
    if (!raw) continue;
    let entry = null;
    // Parse rows that contain uuid (branch tracking) or usage/boundary (fold), scanned over the WHOLE
    // line. CC does not keep uuid in the line head: 24 real rows over 1MB carry it past 500KB, and they
    // reach the fold today only because they are `type:"user"`, so boundaryPrecheck happens to match.
    // A row missing all three probes is skipped whole, so indexRow never registers its uuid and every
    // later entry parented to it goes unreachable — which truncates the resolved path to that tail and
    // drops the conversation before it. The scan the cap saved is ~0.02ms on the largest real row, and
    // the JSON.parse it was avoiding (~0.62ms) already ran on all 24.
    if (raw.includes('"uuid"') || raw.includes('"usage"') || boundaryPrecheck(raw)) {
      try { entry = JSON.parse(raw); } catch { continue; }
    }
    if (!entry) continue;
    indexRow(w, entry);
    batch.push(entry);
  }

  if (batch.length === 0) return { newCalls: 0, changed: false };

  // --- Phase B: determine active leaf, decide fast-path vs replay ---
  // Active-path filtering is only meaningful when a connected tree exists (at least one
  // parent-child edge). Legacy/test JSONL with uuid but no parentUuid forms disconnected roots
  // — no branching to filter, fold everything (graceful degradation).
  const hasTree = w._topology.uuidChildren.size > 0;
  const prevLeaf = w._activeLeafUuid;
  const currentLeaf = hasTree ? detectActiveLeaf(w) : null;
  w._activeLeafUuid = currentLeaf;

  // Fork/rewind detection: old leaf is NOT an ancestor of new leaf.
  // Linear append: old leaf IS an ancestor (or null on first poll) → fast path.
  const needsReplay = hasTree && prevLeaf && currentLeaf && !isAncestorOf(w, prevLeaf, currentLeaf);

  if (needsReplay) {
    replayActivePath(w);
    return { newCalls: w._calls.length, changed: true };
  }

  // First-poll compact: file already contains compact boundaries. Replay all subtrees.
  if (!prevLeaf && w._compactDetected && w._topology.firstRootUuid && currentLeaf) {
    replayActivePath(w);
    return { newCalls: w._calls.length, changed: true };
  }

  // Fast path: fold only new batch rows that are on the active path
  const activePath = (hasTree && currentLeaf) ? resolveActivePath(w, currentLeaf) : null;

  return foldEntries(w, batch, activePath);
}
