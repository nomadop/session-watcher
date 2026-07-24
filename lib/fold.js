import { readSync, openSync, closeSync, fstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { extractUsage, isUserTurnBoundary, ctpForModel } from './extract.js';
import { classifyMiss } from './l-measure.js';
import { PRECHECK_LONG_LINE_BYTES, PRECHECK_HEAD_CAP_BYTES, DEFAULT_CTP, SEGMENT_DROP_EPSILON, MISS_CR_DROP, PENDING_MAX_TURN_DISTANCE, TOOL_OVERHEAD } from './constants.js';
import { matchAdapter, extractToolResultText, emaStep, gEffective, bashFeature, mcpDisplay, charsToTokens, countsToTokens, CJK_RE } from './measure.js';
import { getStore } from './store.js';
import { computePp } from './bill-regret.js';
import { settleDeferred } from './settle.js';
import { buildTelemetryPayload } from './carry-outcome.js';

// Loose, ReDoS-immune boundary precheck (spec §4.3). Double includes on head-resident markers ONLY.
// ALLOWS false positives (an extra JSON.parse); NEVER a false negative on pretty JSON or a giant payload.
// HEAD-CAP ASSUMPTION: PRECHECK_HEAD_CAP_BYTES (8192) must be >= the max byte offset of a boundary marker
// (`"type"`/`"user"`), which for CC transcripts is the line's first field (base64/tool payloads are in the
// tail). If a real transcript ever violates this, raise the cap — do NOT add a "fall through to parse on
// cap" fallback (that would re-parse the exact >1MB lines the precheck exists to skip). The A25 test pins it.
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
  if (w._bLagLedger.total > 0) {
    for (const [p, amt] of w._bLagLedger.byPath) {
      if (amt > 0) w._bRebuild.addCorrection(p, amt);
    }
    w._bLagLedger = { total: 0, byPath: new Map() };
  }
  if (w._sessionId && w._segment !== w._lastArchivedSegment) {
    // Task 9 replay provenance: honor a watcher-level `_replayMode` in ADDITION to the per-call arg.
    // The carry-sweep drives to EOF via poll() — whose internal fast-path boundaries (foldCall's
    // compact/stock-drop detection) hardcode replayMode:false — plus a terminal boundary. Setting
    // w._replayMode makes EVERY one of those boundaries replay-flavored, so no swept segment is ever
    // mis-stamped 'live'/'cc-live'. Production leaves _replayMode false → identical to before.
    const replaying = replayMode || w._replayMode;
    // Task 9 store injection: archive to the watcher's injected store if set (the sweep's reconciled
    // connection), else the global getStore() singleton (production). Resolve ONCE so TXN1 + TXN2 hit
    // the SAME DB — a split would archive the profile to one connection and telemetry to another.
    const store = w._store || getStore();
    const source = replaying ? 'replay' : 'live';
    const snap = buildSegmentSnapshot(w, { source });
    const paths = w._bRebuild.snapshot().map(({ path, tokens }) => ({ path, tokens }));
    const archivedSegment = w._segment;                        // capture before segmentReset (== w._segment here)
    const segCalls = (w._segmentStepUsage || []).slice();      // snapshot telemetry buffers before segmentReset clears them
    const segEvents = (w._segmentPathEvents || []).slice();
    try {
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
  // Fallback for uuid-bearing sessions: totalStock drop guarded by eviction detection.
  // Fallback for uuid-less sessions (legacy/test): raw totalStock drop (old behavior).
  if (w._compactDetected) {
    handleSegmentBoundary(w, { replayMode: false });
    w._segmentModel = u.model;
    w._compactDetected = false;
  } else if (w._prevTotalStock > 0 && totalStock < w._prevTotalStock - SEGMENT_DROP_EPSILON) {
    if (w._firstRootUuid) {
      // UUID-bearing session: suppress if this looks like a cache eviction (cr dropped but context preserved).
      const looksLikeEviction = w._prevL > 0 && u.cacheRead < w._prevL * MISS_CR_DROP;
      if (!looksLikeEviction) { handleSegmentBoundary(w, { replayMode: false }); w._segmentModel = u.model; }
    } else {
      // UUID-less session (legacy/test): no topology available, use raw heuristic.
      handleSegmentBoundary(w, { replayMode: false }); w._segmentModel = u.model;
    }
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
    w._g_ema = emaStep(w._g_ema == null ? residual : w._g_ema, residual);
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

// C4-1 (B8): Pure byte-layer JSONL line reader. Locates '\n' in the Buffer and decodes ONLY each
// complete line's byte slice — never string-converts the whole read span then splits (V8 may copy a
// huge line). `chunk` is the incremental read buffer filled FROM INDEX 0 (production: readSync(fd,
// chunk, 0, maxBytes, watcher._offset)). `baseOffset` is the ABSOLUTE file position of chunk[0] —
// used only to make nextOffset absolute: nextOffset = baseOffset + committedBytesWithinChunk.
// `maxBytes` is the HARD bound (R7): only bytes within chunk[0..maxBytes-1] are scanned.
// `atEof` (default false) is a SEALED-file flag: only when true does a trailing newline-less line
// count as complete (F5 — live tail path passes atEof:false UNCONDITIONALLY).
export function readCompleteJsonlEventsFromBuffer(chunk, { baseOffset = 0, maxBytes, atEof = false } = {}) {
  const limit = Math.min(chunk.length, maxBytes ?? chunk.length);
  const events = [];
  let pos = 0; // in-chunk cursor (bytes consumed so far)

  while (pos < limit) {
    // Find the next newline within the budget
    let nlIdx = -1;
    for (let i = pos; i < limit; i++) {
      if (chunk[i] === 0x0a) { nlIdx = i; break; } // '\n'
    }
    if (nlIdx === -1) break; // no complete line within budget

    // The line is chunk[pos..nlIdx] (inclusive of \n). Handle \r\n: strip trailing \r from content.
    let lineEnd = nlIdx; // exclusive end of content (before \n)
    if (lineEnd > pos && chunk[lineEnd - 1] === 0x0d) lineEnd--; // strip \r

    const lineBytes = chunk.slice(pos, lineEnd);
    const lineStr = lineBytes.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(lineStr); } catch { /* skip malformed lines */ }
    if (parsed !== undefined) events.push(parsed);

    pos = nlIdx + 1; // advance past \n
  }

  // F5: atEof — if sealed and there's a trailing chunk with no newline, treat it as one final event
  if (atEof && pos < limit) {
    const trailing = chunk.slice(pos, limit);
    const trailingStr = trailing.toString('utf8');
    let parsed;
    try { parsed = JSON.parse(trailingStr); } catch { /* skip malformed */ }
    if (parsed !== undefined) { events.push(parsed); pos = limit; }
  }

  const caughtUp = (pos >= chunk.length) && (maxBytes == null || maxBytes >= chunk.length);
  return { events, nextOffset: baseOffset + pos, caughtUp };
}

// --- Branch indexer (M9) ---

function indexRow(w, entry) {
  if (!entry || !entry.uuid) return;
  if (entry.isSidechain) return; // sidechain rows must not influence active-leaf detection
  w._uuidToParent.set(entry.uuid, entry.parentUuid ?? null);
  if (entry.parentUuid) {
    if (!w._uuidChildren.has(entry.parentUuid)) w._uuidChildren.set(entry.parentUuid, new Set());
    w._uuidChildren.get(entry.parentUuid).add(entry.uuid);
  } else if (!w._firstRootUuid) {
    w._firstRootUuid = entry.uuid; // first null-parent uuid = session origin
  } else {
    // Non-first null-parent root = compact (topology signal). Multiple sets are idempotent;
    // one consumption in foldCall = one segment boundary (only the final active segment matters).
    w._compactDetected = true;
  }
  w._latestUuid = entry.uuid;
}

// Deepest leaf reachable from a given root (for old-subtree history reconstruction).
function deepestLeafFrom(w, rootUuid) {
  const visited = new Set();
  let leaf = rootUuid;
  while (leaf && w._uuidChildren.has(leaf)) {
    if (visited.has(leaf)) break;
    visited.add(leaf);
    const children = w._uuidChildren.get(leaf);
    leaf = [...children].pop();
  }
  return leaf;
}

// Active leaf: the last-written uuid is always on the active branch (CC writes linearly).
// Follow its children downward to find the deepest leaf.
function detectActiveLeaf(w) {
  const visited = new Set(); // cycle guard (defense-in-depth)
  let leaf = w._latestUuid;
  while (leaf && w._uuidChildren.has(leaf)) {
    if (visited.has(leaf)) break;
    visited.add(leaf);
    const children = w._uuidChildren.get(leaf);
    leaf = [...children].pop(); // last-added child = most recent write
  }
  return leaf;
}

function resolveActivePath(w, leafUuid) {
  const path = new Set();
  let current = leafUuid;
  while (current != null) {
    if (path.has(current)) break; // cycle guard — should never happen in valid JSONL
    path.add(current);
    current = w._uuidToParent.get(current) ?? null;
  }
  return path;
}

// Ancestor check: returns true if `ancestor` is on the path from `descendant` to root.
// Used to distinguish linear append (old leaf is ancestor of new leaf) from fork/rewind.
function isAncestorOf(w, ancestor, descendant) {
  const visited = new Set();
  let current = descendant;
  while (current != null) {
    if (current === ancestor) return true;
    if (visited.has(current)) return false; // cycle guard
    visited.add(current);
    current = w._uuidToParent.get(current) ?? null;
  }
  return false;
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
  // M9 branch state
  w._uuidToParent.clear();
  w._uuidChildren.clear();
  w._latestUuid = null;
  w._activeLeafUuid = null;
  w._firstRootUuid = null;
  w._compactDetected = false;
  // v3: rebuild B/g from scratch on a full reset OR a segment rotation (new segment re-derives
  // B/g from the new transcript content; stale _prevTotalStock would trigger a false boundary).
  if (clearCalls || bumpSegment) {
    w._bRebuild.clear(); w._bRebuild.setDead(0); w._warmupCeiling = 0;
    w._g_ema = null; w._prevB = 0; w._prevL = null; w._prevTotalStock = 0; w._ctpOvershoot = 0;
    w._bLagLedger = { total: 0, byPath: new Map() };
    w._pendingTool.clear(); w._segmentEpoch++; w._turnToolEvents = [];
    w._residualByTool = new Map(); w._turnResidualTools = []; w._pendingResidual = new Map();
    w._intervalPathDeltas = new Map();
    w._completedSkills = new Map();
    w._reasoningAttributionDisabled = false; // §2.4 reset: new segment starts fresh
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
    if (w._ctp == null && entry.type === 'assistant' && entry.message?.usage && entry.message?.model) {
      w._ctp = ctpForModel(entry.message.model);
    }
    // Carry-staleness telemetry: processToolEvents RETURNS entry-local stepMeta {toolUseCount,
    // loadToken}; capture it and pass into foldCall below. isSidechain gates the path-event capture and
    // is read from the NATIVE top-level marker (entry.isSidechain === true) — the same field
    // extractUsage (extract.js:101) and isUserTurnBoundary (extract.js:58) read — NOT extractUsage(entry)
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
  }
  return { newCalls, changed };
}

// Fold a subset of events filtered by pathSet into the current segment.
function foldSubset(w, events, pathSet) {
  foldEntries(w, events, pathSet);
}

function replayActivePath(w, { isCompact = false } = {}) {
  // Re-read and re-index the full file, then fold active-path rows.
  // isCompact: multiple disconnected subtrees exist. Fold each subtree into its own segment
  // (one per null-parent root, in file order) so the history chart can page through all of them.
  let fd;
  try { fd = openSync(w.path, 'r'); } catch { return; }
  // Reset AFTER successful open — if open fails, preserve existing state (#1 review fix)
  resetFoldState(w);
  w._partial = '';
  try {
    const st = fstatSync(fd);
    // Replay valve: respect _replayByteLimit during replay (same as readNewText)
    const readSize = (w._replayByteLimit != null) ? Math.min(st.size, w._replayByteLimit) : st.size;
    const buf = Buffer.allocUnsafe(readSize);
    const bytesRead = readSync(fd, buf, 0, readSize, 0);
    const safeBuf = buf.subarray(0, bytesRead);
    const { events } = readCompleteJsonlEventsFromBuffer(safeBuf, { atEof: w._replayByteLimit == null });

    // Rebuild branch index from scratch
    for (const entry of events) indexRow(w, entry);
    w._activeLeafUuid = detectActiveLeaf(w);

    // Resolve active path AFTER full index is built
    const activePath = w._uuidChildren.size > 0
      ? resolveActivePath(w, w._activeLeafUuid)
      : null;

    if (isCompact && activePath) {
      // Collect all null-parent roots in file order (= subtree boundaries).
      const roots = [];
      for (const entry of events) {
        if (entry.uuid && w._uuidToParent.get(entry.uuid) === null) roots.push(entry.uuid);
      }

      w._compactDetected = false; // suppress — we handle boundaries manually

      // Fold each subtree into its own segment. For each root, resolve its leaf's path
      // and fold the subset of events on that path. Insert segmentReset between subtrees.
      for (let i = 0; i < roots.length; i++) {
        if (i > 0) { handleSegmentBoundary(w, { replayMode: true }); w._ctp = null; w._pendingTurnBump = false; }
        const leaf = deepestLeafFrom(w, roots[i]);
        const path = resolveActivePath(w, leaf);
        foldSubset(w, events, path);
      }
    } else {
      // Plain rewind/fork or no tree: single-pass fold on active path
      w._compactDetected = false;
      foldSubset(w, events, activePath);
    }
  } finally { closeSync(fd); }
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
      const adapter = matchAdapter(block.name);
      if (!adapter) {
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
        continue; // no adapter → residual (B unchanged)
      }
      const cwd = entry.cwd || w.cwd || dirname(w.path);
      const path = adapter.extractPath(block.input || {}, cwd);
      // Bash adapter matches on name but returns null path for non-file-read commands (npm test, git log, etc.).
      // Those are residual — they don't update B but DO consume context. Track them the same as unmatched tools.
      if (path == null && block.name === 'Bash') {
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
      w._pendingTool.set(block.id, { adapter, input: block.input || {}, path, cwd, epoch: w._segmentEpoch });
      // §2.4 Same-path reasoning attribution: if this tool_use targets the same path as the previous
      // tool_use AND there were intermediate thinking/text chars, attribute those to the path.
      if (!w._reasoningAttributionDisabled && path != null && accReasoningChars > 0 && path === lastToolPath) {
        const reasoningTokens = countsToTokens({ chars: accReasoningChars, cjk: accReasoningCjk }, w._ctp || DEFAULT_CTP);
        w._bRebuild.addReasoningSpent(path, reasoningTokens);
      }
      // Update tracking state for next iteration
      lastToolPath = path;
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
      if (block.is_error === true) continue;            // tool failed → B unchanged (file didn't change on disk)
      // Adapter exception safety: malformed JSONL / unexpected tool_result shape must not crash poll().
      // On failure the tool event flows into residual (safe direction — B unchanged → x stays high).
      try {
        const resultText = extractToolResultText(block);
        const update = pending.adapter.computeUpdate(pending.input, resultText, pending.cwd, w._ctp || DEFAULT_CTP);
        if (update) {
          // §2.5 CTP correction: track per-path delta for overshoot distribution in foldCall.
          const beforeTotal = pending.path ? w._bRebuild.pathTotal(pending.path) : 0;
          w._bRebuild.apply(update, pending.path, turn, w._foldedCallSeq);
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
      } catch (e) {
        if (process.env.SW_DEBUG) console.error('[adapter]', pending.adapter.name, e.message);
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
// already-complete segment to pin the TXN2 skip). Named-export form — NOT `export function
// handleSegmentBoundary` — so the "internal API is not a public function export" guard
// (test/feature-flag.test.js) still holds: server.js uses archiveCurrentSegment, not this.
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
    // Parse rows that contain uuid (branch tracking) or usage/boundary (fold).
    // Head-cap the "uuid" check: CC writes uuid as a top-level field early in the JSON,
    // so it's always in the first PRECHECK_HEAD_CAP_BYTES — avoids triggering JSON.parse
    // on multi-MB tool_use/base64 lines that happen to contain "uuid" deep in payload.
    const head = raw.length > PRECHECK_LONG_LINE_BYTES
      ? raw.slice(0, PRECHECK_HEAD_CAP_BYTES)
      : raw;
    if (head.includes('"uuid"') || head.includes('"usage"') || boundaryPrecheck(raw)) {
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
  const hasTree = w._uuidChildren.size > 0;
  const prevLeaf = w._activeLeafUuid;
  const currentLeaf = hasTree ? detectActiveLeaf(w) : null;
  w._activeLeafUuid = currentLeaf;

  // Fork/rewind detection: old leaf is NOT an ancestor of new leaf.
  // Linear append: old leaf IS an ancestor (or null on first poll) → fast path.
  const needsReplay = hasTree && prevLeaf && currentLeaf && !isAncestorOf(w, prevLeaf, currentLeaf);

  if (needsReplay) {
    // Compact-fork: disconnected subtrees. Replay all subtrees into separate segments.
    // Plain rewind/fork (same tree, different branch): single-pass re-derive.
    replayActivePath(w, { isCompact: !!w._compactDetected });
    return { newCalls: w._calls.length, changed: true };
  }

  // First-poll compact: file already contains compact boundaries. Replay all subtrees.
  if (!prevLeaf && w._compactDetected && w._firstRootUuid && currentLeaf) {
    replayActivePath(w, { isCompact: true });
    return { newCalls: w._calls.length, changed: true };
  }

  // Fast path: fold only new batch rows that are on the active path
  const activePath = (hasTree && currentLeaf) ? resolveActivePath(w, currentLeaf) : null;

  return foldEntries(w, batch, activePath);
}
