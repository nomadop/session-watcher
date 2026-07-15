// server.js
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname as dirname2, join as join4, resolve, basename } from "node:path";
import { readdirSync as readdirSync3, statSync as statSync2, mkdirSync as mkdirSync2, unlinkSync as unlinkSync3, openSync as openSync2, writeSync, closeSync as closeSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";

// lib/constants.js
var CONSTANTS = {
  EFFICIENCY_MULT: 2,
  FIT_WINDOW_DEFAULT: 20,
  KNEE_BG_MULT: 1.75,
  KNEE_MIN_TURN: 3,
  RESIDUAL_MAX: 0.3,
  BASELINE_CONF_MIN: 0.75,
  // Cache-miss denoise (v1.1) — dimensionless ratios ONLY, cross-project/cross-environment stable.
  // A miss row: cacheRead collapses below MISS_READ_RESIDUAL of both its own total and the segment's
  // established read peak, while total stock stays >= MISS_TOTAL_KEEP of the segment peak. Empirical:
  // real miss read/total ≡ 0.0; normal p5 = 0.926 — a wide gap, any 0.05–0.5 splits them (spec §3.1.1).
  MISS_READ_RESIDUAL: 0.5,
  MISS_TOTAL_KEEP: 0.7,
  // k_stable static clamp (spec §3.4 / §10.1#6). PROVISIONAL, tunable (§9 non-core UX knob):
  // K_FLOOR stops k_stable→0 (which would make empty_burn near-impossible and collapse xExit→1);
  // K_CEIL stops a knee-adjacent code-dump from freezing k_stable absurdly high (→ every normal
  // small step reads <k_stable → chronic false empty_burn). Static clamp ONLY — no behavioral decay
  // (rejected: reintroduces drift into a frozen quantity). Typical stable delta ≈ 940 tok/call.
  K_FLOOR: 50,
  K_CEIL: 5e3,
  DW_TURN_BACKSTOP: 2
  // ΔW_turn ≥ 2 single-turn backstop threshold (§2.8), tunable
};
var SETTLED_SUMMARY_HARD_LIMIT = 512;
var RECENT_STOP_EVENTS_LIMIT = 32;
var RECENT_PROCESSED_HOOK_IDS_LIMIT = 128;
var PENDING_STOP_EVALUATIONS_LIMIT = 64;
var PENDING_STOP_TTL_MS = 6e5;
var PENDING_MAX_TURN_DISTANCE = 2;
var C_RATIO_TABLE = [
  { match: /claude|opus|sonnet|haiku/i, ratio: 12.5 },
  { match: /deepseek.*pro/i, ratio: 120 },
  { match: /deepseek/i, ratio: 50 }
];
var DEFAULT_C_RATIO = 10;
var MODEL_PRICING_PRESETS = [
  {
    id: "opus-4.8",
    label: "Claude Opus 4.8",
    readPrice: 0.5,
    writePrice: 6.25
  },
  { id: "sonnet-5", label: "Claude Sonnet 5", readPrice: 0.2, writePrice: 2.5 },
  {
    id: "sonnet-4.6",
    label: "Claude Sonnet 4.6",
    readPrice: 0.3,
    writePrice: 3.75
  },
  {
    id: "haiku-4.5",
    label: "Claude Haiku 4.5",
    readPrice: 0.1,
    writePrice: 1.25
  },
  { id: "fable-5", label: "Claude Fable 5", readPrice: 1, writePrice: 12.5 },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek v4 Flash",
    readPrice: 0.02,
    writePrice: 1
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek v4 Pro",
    readPrice: 0.025,
    writePrice: 3
  }
];
var CONTEXT_WINDOW_TABLE = [
  { match: /test-short-window/i, window: 2e5 },
  // test-only vehicle for cap-binding tests
  { match: /1m|-1m|opus-4-8/i, window: 1e6 },
  { match: /claude|opus|sonnet|haiku/i, window: 1e6 },
  { match: /deepseek/i, window: 1e6 }
];
var DEFAULT_CONTEXT_WINDOW = 1e6;
var RESERVED_OUTPUT = 32e3;
var CTX_SAFETY_MARGIN = 8e3;
var PRECHECK_LONG_LINE_BYTES = 1048576;
var PRECHECK_HEAD_CAP_BYTES = 8192;
var STOP_ADVANCE_MAX_MS = 150;
var STOP_ADVANCE_MAX_BYTES = 524288;
var COALESCED_PERSIST_MS = 2e3;
var IDLE_HEARTBEAT_MS = 5e3;

// lib/extract.js
var KNOWN_USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
function providerOf(model = "") {
  if (/claude|opus|sonnet|haiku/i.test(model)) return "claude";
  if (/deepseek/i.test(model)) return "deepseek";
  return "unknown";
}
function cRatioFor(model = "") {
  const hit = C_RATIO_TABLE.find((r) => r.match.test(model));
  return hit ? hit.ratio : DEFAULT_C_RATIO;
}
function contextWindowFor(model = "") {
  const hit = CONTEXT_WINDOW_TABLE.find((r) => r.match.test(model));
  return hit ? hit.window : DEFAULT_CONTEXT_WINDOW;
}
function cacheCreationTotal(usage) {
  const cc = usage.cache_creation;
  if (cc && typeof cc === "object") {
    return (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0);
  }
  return usage.cache_creation_input_tokens || 0;
}
function hasNullKnownField(entry) {
  const u = entry?.message?.usage;
  if (!u) return false;
  return KNOWN_USAGE_FIELDS.some((f) => u[f] === null);
}
function isUserTurnBoundary(entry) {
  if (!entry || entry.type !== "user") return false;
  if (entry.isSidechain === true) return false;
  const msg = entry.message;
  if (!msg) return false;
  const c = msg.content;
  if (typeof c === "string") {
    if (c.trimStart().startsWith("<task-notification>")) return false;
    return true;
  }
  if (Array.isArray(c)) return !c.some((b) => b && b.type === "tool_result");
  return false;
}
function extractUsage(entry) {
  if (!entry || entry.type !== "assistant") return null;
  const msg = entry.message;
  if (!msg || !msg.usage || typeof msg.usage !== "object") return null;
  if (hasNullKnownField(entry)) return null;
  const u = msg.usage;
  const model = msg.model || "";
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreation = cacheCreationTotal(u);
  if (model === "<synthetic>" || input === 0 && output === 0 && cacheRead === 0 && cacheCreation === 0) {
    return null;
  }
  const gField = providerOf(model) === "claude" ? cacheCreation + output : input + output;
  return {
    model,
    messageId: msg.id || null,
    requestId: entry.requestId || entry.request_id || null,
    isSidechain: entry.isSidechain === true,
    ts: entry.timestamp || null,
    input,
    output,
    cacheRead,
    cacheCreation,
    gField
  };
}

// lib/stats.js
function median(nums) {
  if (!Array.isArray(nums) || !nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length;
  return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

// lib/baseline.js
function detectKnee(cacheReadSeq, opts = {}) {
  const kneeBgMult = opts.kneeBgMult ?? CONSTANTS.KNEE_BG_MULT;
  const kneeMinTurn = opts.kneeMinTurn ?? CONSTANTS.KNEE_MIN_TURN;
  const dead = cacheReadSeq[0] ?? 0;
  const deltas = [];
  for (let i = 1; i < cacheReadSeq.length; i++) deltas.push(Math.max(0, cacheReadSeq[i] - cacheReadSeq[i - 1]));
  const backHalf = deltas.slice(Math.floor(deltas.length / 2));
  const stableMedian = median(backHalf.length ? backHalf : deltas) || 1;
  const bg = kneeBgMult * stableMedian;
  const LOOKAHEAD = 4;
  const MIN_EVIDENCE = 2;
  for (let t = kneeMinTurn; t < cacheReadSeq.length; t++) {
    const window = deltas.slice(t, t + LOOKAHEAD);
    if (window.length < MIN_EVIDENCE) break;
    if (window.every((d) => d < bg)) {
      return { kneeTurn: t, taskCtx: Math.max(0, cacheReadSeq[t] - dead), isRealKnee: true, stableMedian };
    }
  }
  const fallback = Math.min(kneeMinTurn, cacheReadSeq.length - 1);
  return { kneeTurn: fallback, taskCtx: Math.max(0, (cacheReadSeq[fallback] ?? dead) - dead), isRealKnee: false, stableMedian };
}

// lib/metrics.js
function nStar(cRatio, lBase, g) {
  if (g <= 0) return Infinity;
  return Math.sqrt(2 * cRatio * lBase / g);
}
function lStar(lBase, cRatio, kAvg, M = CONSTANTS.EFFICIENCY_MULT) {
  if (kAvg <= 0) return lBase;
  return lBase + M * Math.sqrt(2 * cRatio * lBase * kAvg);
}
function rho(cRatio, kAvg, lBase) {
  if (lBase <= 0) return 0;
  return cRatio * kAvg / lBase;
}
function phi(L, lBase, cRatio, kAvg) {
  const denom = lBase + cRatio * kAvg;
  if (denom <= 0) return 1;
  return Math.max(1, (L + cRatio * kAvg) / denom);
}
function paybackP(L, lBase) {
  if (lBase <= 0) return 0;
  return Math.max(0, L / lBase - 1);
}
function timingWeight(rhoVal) {
  if (rhoVal <= 0) return 0;
  const s = Math.sqrt(2 * rhoVal);
  return s / (s + 1 + rhoVal);
}
function regret(nNow, nStarVal) {
  if (!Number.isFinite(nNow) || !Number.isFinite(nStarVal)) return 0;
  if (nNow <= 0 || nStarVal <= 0) return 0;
  const u = nNow / nStarVal;
  return (u + 1 / u) / 2 - 1;
}

// lib/l-measure.js
function effectiveL(c) {
  return Number.isFinite(c?.L) ? c.L : c?.cacheRead ?? 0;
}
function classifyMiss({ cacheRead, cacheCreation, peakTotalBefore, peakReadBefore }) {
  const total = cacheRead + cacheCreation;
  return total > 0 && cacheRead < total * CONSTANTS.MISS_READ_RESIDUAL && peakTotalBefore > 0 && total >= peakTotalBefore * CONSTANTS.MISS_TOTAL_KEEP && peakReadBefore > 0 && cacheRead < peakReadBefore * CONSTANTS.MISS_READ_RESIDUAL;
}

// lib/latch.js
function computeCalibrationGate({ confidence, postKneeGrowthCalls, baselineTotal, L }) {
  if (confidence < CONSTANTS.BASELINE_CONF_MIN) return { passed: false, reason: "low_confidence" };
  if (postKneeGrowthCalls < 3 || baselineTotal <= 0 || L <= baselineTotal) return { passed: false, reason: "insufficient_data" };
  return { passed: true, reason: null };
}
function callIdentity(c) {
  return c?.messageId ?? c?.message?.id ?? c?.id ?? null;
}
function applyFrozen(entry) {
  return {
    dead: entry.dead,
    task: entry.taskCtx,
    total: entry.dead + entry.taskCtx,
    source: "latched",
    confidence: 0.92,
    kneeTurn: entry.kneeTurn,
    isRealKnee: true,
    stableMedian: entry.stableMedian
  };
}
function makeLatchEntry(live, prefixSlice) {
  const segmentStartCallId = callIdentity(prefixSlice[0]);
  const latchIndex = prefixSlice.length - 1;
  const latchCallId = callIdentity(prefixSlice[latchIndex]);
  if (!segmentStartCallId || !latchCallId) return null;
  return {
    dead: live.baseline.dead,
    taskCtx: live.baseline.task,
    kneeTurn: live.baseline.kneeTurn,
    stableMedian: live.baseline.stableMedian,
    latchIndex,
    latchCallId,
    segmentStartCallId
  };
}
function validateLatch(entry, prefix) {
  if (!entry) return null;
  if (entry.segmentStartCallId !== callIdentity(prefix[0])) return null;
  if (!(entry.latchIndex < prefix.length)) return null;
  if (entry.latchCallId !== callIdentity(prefix[entry.latchIndex])) return null;
  return entry;
}
function baselineFingerprint(entry) {
  if (!entry) return null;
  const teeth = Array.isArray(entry.teeth) ? entry.teeth.join(",") : "";
  return `d${entry.dead}|t${entry.taskCtx}|k${entry.kneeTurn}|T${teeth}`;
}

// lib/rate-lamp.js
function clampKStable(raw) {
  if (!Number.isFinite(raw)) return CONSTANTS.K_FLOOR;
  return Math.min(CONSTANTS.K_CEIL, Math.max(CONSTANTS.K_FLOOR, raw));
}
var EXIT_NUCLEUS = 2;
function computeXExitFromKStable(cRatio, kStable, lBase) {
  if (cRatio <= 0 || kStable <= 0 || lBase <= 0) return 1;
  return 1 + EXIT_NUCLEUS * Math.sqrt(2 * cRatio * kStable / lBase);
}
function deriveFrozenExit(cRatio, kStable, lBase) {
  const xExit = computeXExitFromKStable(cRatio, kStable, lBase);
  const L_exit_fullCarry = xExit * lBase;
  return { xExit, L_exit_fullCarry };
}
function computeFullCarryBurnRate({ L_read, B_post, B_rebuild, cRatio }) {
  if (!(B_rebuild > 0) || !(cRatio > 0)) return NaN;
  return Math.max(0, L_read - B_post) / (cRatio * B_rebuild);
}
function computeRateWall({ B_post, B_rebuild, cRatio, lCap }) {
  const L = B_post + cRatio * B_rebuild;
  const reachable = L < lCap;
  return {
    L,
    x_display: B_rebuild > 0 ? L / B_rebuild : 0,
    // display axis; wall x = 1 + cRatio for fullCarry
    reachableBeforeContextCap: reachable,
    reasonIfNotReachable: reachable ? null : "context_cap"
  };
}
function detectStockStep(prefix, frozenKStable, { stepMult = 8, sinceFoldedSeq = -Infinity } = {}) {
  if (!Array.isArray(prefix) || !(frozenKStable > 0)) return false;
  const idx = prefix.findIndex((c) => (c.foldedSeq ?? 0) > sinceFoldedSeq);
  if (idx === -1) return false;
  const window = idx === 0 ? prefix : prefix.slice(idx - 1);
  if (window.length < 2) return false;
  const threshold = stepMult * frozenKStable;
  for (let i = 1; i < window.length; i++) {
    const totalNow = (window[i].cacheRead ?? 0) + (window[i].cacheCreation ?? 0);
    const totalPrev = (window[i - 1].cacheRead ?? 0) + (window[i - 1].cacheCreation ?? 0);
    if (totalNow - totalPrev >= threshold) return true;
  }
  return false;
}
function computeRateLampInstant(snap, { scenario }) {
  const { L_read, lBase, lDead, cRatio, lCap, kStable, kStableReliable, baselineValid } = snap;
  if (baselineValid === false || !(lBase > 0) || !(cRatio > 0)) {
    return { reliable: false, unavailableReason: "invalid_baseline" };
  }
  if (!kStableReliable || !(kStable > 0)) {
    return { reliable: false, unavailableReason: "insufficient_data" };
  }
  const B = scenario === "deadOnly" ? lDead : lBase;
  if (!(B > 0)) return { reliable: false, unavailableReason: "invalid_baseline" };
  const burnRate = computeFullCarryBurnRate({ L_read, B_post: B, B_rebuild: B, cRatio });
  if (!Number.isFinite(burnRate)) return { reliable: false, unavailableReason: "invalid_baseline" };
  const hBreak2 = burnRate > 0 ? 1 / burnRate : Infinity;
  const { xExit, L_exit_fullCarry } = deriveFrozenExit(cRatio, kStable, lBase);
  return {
    reliable: true,
    basis: scenario,
    L_read,
    L_cap: lCap,
    B_post: B,
    B_rebuild: B,
    C_RATIO: cRatio,
    x_display: lBase > 0 ? L_read / lBase : 1,
    // display axis only (§10.1#14)
    burnRate,
    hBreak: hBreak2,
    xExit,
    L_exit_fullCarry,
    rateWall: computeRateWall({ B_post: B, B_rebuild: B, cRatio, lCap })
  };
}

// lib/fold.js
import { readSync, openSync, closeSync, fstatSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
function boundaryPrecheck(raw) {
  if (typeof raw !== "string" || raw.length === 0) return false;
  const scan = raw.length > PRECHECK_LONG_LINE_BYTES ? raw.slice(0, PRECHECK_HEAD_CAP_BYTES) : raw;
  return scan.includes('"user"') && scan.includes('"type"');
}
function readNewText(w) {
  let fd;
  try {
    fd = openSync(w.path, "r");
  } catch {
    return "";
  }
  w._transcriptSeen = true;
  try {
    const st = fstatSync(fd);
    const size = st.size;
    if (size < w._offset || w._ino != null && st.ino !== w._ino) {
      w._offset = 0;
      w._partial = "";
      if (w._decoder) w._decoder = new StringDecoder("utf8");
      resetFoldState(w, { bumpSegment: true, clearCalls: false });
    }
    w._ino = st.ino;
    if (size === w._offset) return "";
    const len = size - w._offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, w._offset);
    w._offset += read;
    if (!w._decoder) w._decoder = new StringDecoder("utf8");
    return w._decoder.write(buf.slice(0, read));
  } finally {
    closeSync(fd);
  }
}
function foldCall(w, u) {
  const foldKey = u.messageId ?? u.requestId ?? null;
  if (foldKey != null && w._byId.has(foldKey)) {
    const idx = w._byId.get(foldKey);
    const totalTok2 = u.input + u.output + u.cacheRead + u.cacheCreation;
    let changed = false;
    if (totalTok2 >= w._calls[idx]._total) {
      const prev = w._calls[idx];
      const crCcChanged = u.cacheRead !== prev.cacheRead || u.cacheCreation !== prev.cacheCreation;
      const miss2 = crCcChanged ? classifyMiss({
        cacheRead: u.cacheRead,
        cacheCreation: u.cacheCreation,
        peakTotalBefore: prev._peakTotalBefore,
        peakReadBefore: prev._peakReadBefore
      }) : prev.miss;
      const L2 = miss2 ? u.cacheRead + u.cacheCreation : u.cacheRead;
      w._calls[idx] = {
        ...prev,
        cacheRead: u.cacheRead,
        output: u.output,
        input: u.input,
        cacheCreation: u.cacheCreation,
        gField: u.gField,
        ts: u.ts,
        _total: totalTok2,
        miss: miss2,
        L: L2
      };
      changed = true;
      w._foldRev++;
      const mutatedSeg = w._calls[idx].segment;
      for (const segId of [...w._latchedBaseline.keys()]) {
        if (segId >= mutatedSeg) w._latchedBaseline.delete(segId);
      }
    }
    return { isNew: false, changed };
  }
  const total = u.cacheRead + u.cacheCreation;
  const peakTotalBefore = w._segmentMaxTotal;
  const peakReadBefore = w._segmentMaxRead;
  const miss = classifyMiss({ cacheRead: u.cacheRead, cacheCreation: u.cacheCreation, peakTotalBefore, peakReadBefore });
  const startsNewSegment = !miss && w._segmentMaxTotal > 0 && total < w._segmentMaxTotal;
  if (startsNewSegment) {
    w._segment++;
    w._byId.clear();
    w._segmentModel = u.model;
    w._segmentMaxTotal = total;
    w._segmentMaxRead = u.cacheRead;
  } else {
    if (w._segmentMaxTotal === 0) w._segmentModel = w._segmentModel || u.model;
    w._segmentMaxTotal = Math.max(w._segmentMaxTotal, total);
    w._segmentMaxRead = Math.max(w._segmentMaxRead, u.cacheRead);
  }
  const L = miss ? total : u.cacheRead;
  const totalTok = u.input + u.output + u.cacheRead + u.cacheCreation;
  const rec = {
    messageId: u.messageId,
    cacheRead: u.cacheRead,
    output: u.output,
    input: u.input,
    cacheCreation: u.cacheCreation,
    gField: u.gField,
    model: u.model,
    ts: u.ts,
    segment: w._segment,
    _total: totalTok,
    L,
    miss,
    // Peaks-before are stored so an in-place fold that later rewrites cr/cc can re-run classifyMiss
    // for THIS record deterministically (spec §3.6; used by Task 5's scoped invalidation).
    _peakTotalBefore: peakTotalBefore,
    _peakReadBefore: peakReadBefore
  };
  if (w._pendingTurnBump || w._turnSeq === 0) {
    w._turnSeq++;
    w._pendingTurnBump = false;
  }
  if (foldKey != null) w._byId.set(foldKey, w._calls.length);
  w._foldedCallSeq++;
  rec.foldedSeq = w._foldedCallSeq;
  rec.turnSeq = w._turnSeq;
  w._calls.push(rec);
  return { isNew: true, changed: true };
}
function readCompleteJsonlEventsFromBuffer(chunk, { baseOffset = 0, maxBytes, atEof = false } = {}) {
  const limit = Math.min(chunk.length, maxBytes ?? chunk.length);
  const events = [];
  let pos = 0;
  while (pos < limit) {
    let nlIdx = -1;
    for (let i = pos; i < limit; i++) {
      if (chunk[i] === 10) {
        nlIdx = i;
        break;
      }
    }
    if (nlIdx === -1) break;
    let lineEnd = nlIdx;
    if (lineEnd > pos && chunk[lineEnd - 1] === 13) lineEnd--;
    const lineBytes = chunk.slice(pos, lineEnd);
    const lineStr = lineBytes.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(lineStr);
    } catch {
    }
    if (parsed !== void 0) events.push(parsed);
    pos = nlIdx + 1;
  }
  if (atEof && pos < limit) {
    const trailing = chunk.slice(pos, limit);
    const trailingStr = trailing.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(trailingStr);
    } catch {
    }
    if (parsed !== void 0) {
      events.push(parsed);
      pos = limit;
    }
  }
  const caughtUp = pos >= chunk.length && (maxBytes == null || maxBytes >= chunk.length);
  return { events, nextOffset: baseOffset + pos, caughtUp };
}
function indexRow(w, entry) {
  if (!entry || !entry.uuid) return;
  if (entry.isSidechain) return;
  w._uuidToParent.set(entry.uuid, entry.parentUuid ?? null);
  if (entry.parentUuid) {
    if (!w._uuidChildren.has(entry.parentUuid)) w._uuidChildren.set(entry.parentUuid, /* @__PURE__ */ new Set());
    w._uuidChildren.get(entry.parentUuid).add(entry.uuid);
  }
  w._latestUuid = entry.uuid;
}
function detectActiveLeaf(w) {
  const visited = /* @__PURE__ */ new Set();
  let leaf = w._latestUuid;
  while (leaf && w._uuidChildren.has(leaf)) {
    if (visited.has(leaf)) break;
    visited.add(leaf);
    const children = w._uuidChildren.get(leaf);
    leaf = [...children].pop();
  }
  return leaf;
}
function resolveActivePath(w, leafUuid) {
  const path = /* @__PURE__ */ new Set();
  let current = leafUuid;
  while (current != null) {
    if (path.has(current)) break;
    path.add(current);
    current = w._uuidToParent.get(current) ?? null;
  }
  return path;
}
function isAncestorOf(w, ancestor, descendant) {
  const visited = /* @__PURE__ */ new Set();
  let current = descendant;
  while (current != null) {
    if (current === ancestor) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = w._uuidToParent.get(current) ?? null;
  }
  return false;
}
function resetFoldState(w, { bumpSegment = false, bumpFoldRev = true, clearCalls = true } = {}) {
  if (clearCalls) w._calls.length = 0;
  w._byId.clear();
  if (bumpSegment) w._segment++;
  else w._segment = 0;
  w._segmentMaxTotal = 0;
  w._segmentMaxRead = 0;
  w._segmentModel = null;
  if (clearCalls) {
    w._foldedCallSeq = 0;
    w._turnSeq = 0;
    w._pendingTurnBump = false;
  }
  if (bumpFoldRev) w._foldRev++;
  w._latchedBaseline.clear();
  w._uuidToParent.clear();
  w._uuidChildren.clear();
  w._latestUuid = null;
  w._activeLeafUuid = null;
}
function replayActivePath(w) {
  let fd;
  try {
    fd = openSync(w.path, "r");
  } catch {
    return;
  }
  resetFoldState(w);
  try {
    const st = fstatSync(fd);
    const buf = Buffer.allocUnsafe(st.size);
    const bytesRead = readSync(fd, buf, 0, st.size, 0);
    const safeBuf = buf.subarray(0, bytesRead);
    const { events } = readCompleteJsonlEventsFromBuffer(safeBuf, { atEof: true });
    for (const entry of events) indexRow(w, entry);
    w._activeLeafUuid = detectActiveLeaf(w);
    const activePath = w._uuidChildren.size > 0 ? resolveActivePath(w, w._activeLeafUuid) : null;
    for (const entry of events) {
      if (activePath && entry.uuid && !activePath.has(entry.uuid)) continue;
      if (isUserTurnBoundary(entry)) {
        w._pendingTurnBump = true;
        continue;
      }
      const u = extractUsage(entry);
      if (!u || u.isSidechain) continue;
      foldCall(w, u);
    }
  } finally {
    closeSync(fd);
  }
}
function poll(w) {
  const chunk = readNewText(w);
  const text = w._partial + chunk;
  const nl = text.lastIndexOf("\n");
  if (nl < 0) {
    w._partial = text;
    return { newCalls: 0, changed: false };
  }
  w._partial = text.slice(nl + 1);
  const complete = text.slice(0, nl);
  const batch = [];
  for (const raw of complete.split("\n")) {
    if (!raw) continue;
    let entry = null;
    const head = raw.length > PRECHECK_LONG_LINE_BYTES ? raw.slice(0, PRECHECK_HEAD_CAP_BYTES) : raw;
    if (head.includes('"uuid"') || raw.includes('"usage"') || boundaryPrecheck(raw)) {
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (!entry) continue;
    indexRow(w, entry);
    batch.push(entry);
  }
  if (batch.length === 0) return { newCalls: 0, changed: false };
  const hasTree = w._uuidChildren.size > 0;
  const prevLeaf = w._activeLeafUuid;
  const currentLeaf = hasTree ? detectActiveLeaf(w) : null;
  w._activeLeafUuid = currentLeaf;
  const needsReplay = hasTree && prevLeaf && currentLeaf && !isAncestorOf(w, prevLeaf, currentLeaf);
  if (needsReplay) {
    replayActivePath(w);
    return { newCalls: w._calls.length, changed: true };
  }
  const activePath = hasTree && currentLeaf ? resolveActivePath(w, currentLeaf) : null;
  let newCalls = 0, changed = false;
  for (const entry of batch) {
    if (activePath && entry.uuid && !activePath.has(entry.uuid)) continue;
    if (isUserTurnBoundary(entry)) {
      w._pendingTurnBump = true;
      continue;
    }
    const u = extractUsage(entry);
    if (!u || u.isSidechain) continue;
    const r = foldCall(w, u);
    if (r.isNew) newCalls++;
    if (r.changed) changed = true;
  }
  return { newCalls, changed };
}

// lib/history.js
function computeHistoryPoint(w, c, arr, lockedModel, fitWindow, latchStore) {
  const { baseline, L, kAvg } = w._baselineAndKavg(arr, { latchStore });
  const total = baseline.total;
  const cRatio = w.ratioOverride ?? cRatioFor(lockedModel);
  const Lstar = lStar(total, cRatio, kAvg);
  const Lcap = contextWindowFor(lockedModel) - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;
  const Lthreshold = Math.min(Lstar, Lcap);
  return {
    ts: c.ts,
    segment: c.segment,
    L,
    Lstar,
    Lthreshold,
    kAvg,
    paybackP: paybackP(L, total),
    phi: phi(L, total, cRatio, kAvg),
    miss: c.miss === true,
    cacheRead: c.cacheRead,
    cacheCreation: c.cacheCreation
  };
}
function getHistory(w, fitWindowOverride) {
  const fitWindow = fitWindowOverride ?? w.fitWindow;
  const cache = w._historyCache;
  const canReuse = cache !== null && cache.fitWindow === fitWindow && cache.foldRev === w._foldRev && w._calls.length >= cache.count;
  let out, bySeg, lockedModelBySeg, latchBySeg, start;
  if (canReuse) {
    out = cache.points;
    bySeg = cache.bySeg;
    lockedModelBySeg = cache.lockedModelBySeg;
    latchBySeg = cache.latchBySeg;
    start = cache.count;
  } else {
    out = [];
    bySeg = /* @__PURE__ */ new Map();
    lockedModelBySeg = /* @__PURE__ */ new Map();
    latchBySeg = /* @__PURE__ */ new Map();
    start = 0;
  }
  for (let i = start; i < w._calls.length; i++) {
    const c = w._calls[i];
    if (!bySeg.has(c.segment)) bySeg.set(c.segment, []);
    if (!lockedModelBySeg.has(c.segment)) lockedModelBySeg.set(c.segment, c.model);
    const arr = bySeg.get(c.segment);
    arr.push(c);
    out.push(computeHistoryPoint(w, c, arr, lockedModelBySeg.get(c.segment), fitWindow, latchBySeg));
  }
  w._historyCache = {
    points: out,
    count: w._calls.length,
    fitWindow,
    foldRev: w._foldRev,
    bySeg,
    lockedModelBySeg,
    latchBySeg
  };
  return out.slice();
}

// lib/watcher.js
var SessionWatcher = class {
  constructor(jsonlPath, lbase = null, opts = {}) {
    this.path = jsonlPath;
    this.injectedDead = lbase;
    this.fitWindow = opts.fitWindow ?? CONSTANTS.FIT_WINDOW_DEFAULT;
    this.ratioOverride = opts.ratioOverride ?? null;
    this._offset = 0;
    this._partial = "";
    this._decoder = null;
    this._calls = [];
    this._byId = /* @__PURE__ */ new Map();
    this._segment = 0;
    this._foldedCallSeq = 0;
    this._turnSeq = 0;
    this._pendingTurnBump = false;
    this._segmentMaxTotal = 0;
    this._segmentMaxRead = 0;
    this._segmentModel = null;
    this._ino = null;
    this._transcriptSeen = false;
    this._foldRev = 0;
    this._historyCache = null;
    this._latchedBaseline = /* @__PURE__ */ new Map();
    this._uuidToParent = /* @__PURE__ */ new Map();
    this._uuidChildren = /* @__PURE__ */ new Map();
    this._latestUuid = null;
    this._activeLeafUuid = null;
    this._startMs = this._nowMs();
  }
  // JSONL ingest + fold + segmentation live in fold.js (readNewText/foldCall/poll take this instance
  // and mutate its private state identically). poll() delegates so the public method surface and all
  // `w._calls/_segment/_foldRev` post-poll reads are unchanged.
  poll() {
    return poll(this);
  }
  _currentSegmentCalls() {
    return this._calls.filter((c) => c.segment === this._segment);
  }
  // v2.1: reducer samples for current-segment folded calls newer than sinceSeq (A1). Each call's
  // burnRate is computed from the SAME frozen baseline (B_post/B_rebuild) so per-call integration is
  // exact; L_read is effectiveL (never raw cacheRead). turnSeq is per-RECORD (Task 2.7 real boundary),
  // so a multi-turn poll integrates each call under its own turn. `reliable` is segment-level (a
  // genuinely unreliable segment is gated out before this is called).
  rateLampSamplesSince(sinceSeq, { B_post, B_rebuild, cRatio, reliable }) {
    return this._currentSegmentCalls().filter((c) => (c.foldedSeq ?? 0) > sinceSeq).sort((a, b) => a.foldedSeq - b.foldedSeq).map((c) => {
      const L_read = effectiveL(c);
      return {
        seq: c.foldedSeq,
        reliable,
        turnSeq: c.turnSeq,
        L_read,
        burnRate: computeFullCarryBurnRate({ L_read, B_post, B_rebuild, cRatio })
      };
    });
  }
  // final-review GPT#1: seq-only UNRELIABLE samples. When a segment is unreliable the instant bundle
  // has no B_post/B_rebuild/cRatio, so we cannot compute burnRate — but the ledger MUST still advance
  // its seq cursor per call (A2) or recovery hits a false folded_seq_gap. These carry NO burnRate/L_read
  // (the reducer's unreliable branch ignores them and only advances lastAppliedFoldedCallSeq). turnSeq
  // is still per-RECORD so the reducer's per-turn ΔW reset stays correct across an unreliable stretch.
  rateLampSeqSamplesSince(sinceSeq, { unavailableReason }) {
    return this._currentSegmentCalls().filter((c) => (c.foldedSeq ?? 0) > sinceSeq).sort((a, b) => a.foldedSeq - b.foldedSeq).map((c) => ({ seq: c.foldedSeq, reliable: false, unavailableReason, turnSeq: c.turnSeq }));
  }
  // Build the cacheRead sequence knee-detection runs on. If a dead bottom is injected, PREPEND it
  // as a synthetic point WITHOUT dropping any real call (the old `[dead, ...seq.slice(1)]` silently
  // lost the first real cacheRead — GPT review). kneeTurn is then an index into this same array,
  // and callers must use it consistently (seq[0] is the synthetic/real dead point).
  _baselineSeq(seg) {
    const seq = seg.map((c) => effectiveL(c));
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
    const { kneeTurn, taskCtx, isRealKnee, stableMedian } = detectKnee(seq.length ? seq : [dead]);
    const source = this.injectedDead != null ? "carried" : "current_cold_start";
    const confidence = source === "carried" ? 0.6 : 0.92;
    const segKnee = this.injectedDead != null ? Math.max(0, kneeTurn - 1) : kneeTurn;
    const baseline = { dead, task: taskCtx, total: dead + taskCtx, source, confidence, kneeTurn: segKnee, isRealKnee: isRealKnee === true, stableMedian };
    const L = prefix.length ? effectiveL(prefix[prefix.length - 1]) : baseline.total;
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
    if (!state) {
      state = { entry: null, scannedThrough: 0 };
      latchStore.set(segmentId, state);
    }
    const valid = validateLatch(state.entry, prefix);
    if (valid) return valid;
    if (state.entry) {
      state.entry = null;
      state.scannedThrough = 0;
    }
    for (let n = Math.max(1, state.scannedThrough + 1); n <= prefix.length; n++) {
      const slice = prefix.slice(0, n);
      const live = this._baselineAndKavgLive(slice);
      if (!live.baseline.isRealKnee) continue;
      const postKneeGrowthCalls = Math.max(0, slice.length - live.baseline.kneeTurn - 1);
      const gate = computeCalibrationGate({
        confidence: live.baseline.confidence,
        postKneeGrowthCalls,
        baselineTotal: live.baseline.total,
        L: live.L
      });
      if (gate.passed) {
        const entry = makeLatchEntry(live, slice);
        if (entry) {
          state.entry = entry;
          state.scannedThrough = n;
          return entry;
        }
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
    if (!latchStore || !prefix.length) {
      const live = this._baselineAndKavgLive(prefix);
      return { ...live, latched: false };
    }
    const entry = this.ensureLatchForPrefix(prefix, latchStore);
    if (!entry) {
      const live = this._baselineAndKavgLive(prefix);
      return { ...live, latched: false };
    }
    const baseline = applyFrozen(entry);
    const L = effectiveL(prefix[prefix.length - 1]);
    const apiCalls = Math.max(1, prefix.length - baseline.kneeTurn - 1);
    const kAvg = Math.max(0, (L - baseline.total) / apiCalls);
    return { baseline, L, kAvg, apiCalls, latched: true };
  }
  getStatus(fitWindowOverride) {
    const fitWindow = fitWindowOverride ?? this.fitWindow;
    const seg = this._currentSegmentCalls();
    const model = this._segmentModel || (seg.length ? seg[0].model : "");
    const cRatio = this.ratioOverride ?? cRatioFor(model);
    const latchRes = this._baselineAndKavg(seg, { latchStore: this._latchedBaseline });
    const { baseline, L, apiCalls, kAvg } = latchRes;
    const { isRealKnee, ...baselineRest } = baseline;
    const baselineOut = { ...baselineRest, fingerprint: latchRes.latched ? baselineFingerprint({ dead: baseline.dead, taskCtx: baseline.task, kneeTurn: baseline.kneeTurn }) : null };
    const Lstar = lStar(baseline.total, cRatio, kAvg);
    const Lcap = contextWindowFor(model) - RESERVED_OUTPUT - CTX_SAFETY_MARGIN;
    const Lthreshold = Math.min(Lstar, Lcap);
    const kStableReliable = latchRes.latched && Number.isFinite(baseline.stableMedian);
    const kStable = kStableReliable ? clampKStable(baseline.stableMedian) : null;
    const lDead = baseline.dead;
    const rateSnap = {
      L_read: L,
      lBase: baseline.total,
      lDead,
      cRatio,
      lCap: Lcap,
      kStable,
      kStableReliable,
      baselineValid: baseline.total > 0 && cRatio > 0
    };
    const rateLampInstant = computeRateLampInstant(rateSnap, { scenario: "fullCarry" });
    if (rateLampInstant.reliable) rateLampInstant.kStable = kStable;
    const crossed = L >= Lthreshold;
    const postKneeGrowthCalls = Math.max(0, seg.length - baseline.kneeTurn - 1);
    let calibratingReason;
    if (latchRes.latched) calibratingReason = null;
    else if (seg.length === 0 && !this._transcriptSeen) calibratingReason = "no_transcript";
    else calibratingReason = computeCalibrationGate({
      confidence: baseline.confidence,
      postKneeGrowthCalls,
      baselineTotal: baseline.total,
      L
    }).reason;
    const restart = crossed && calibratingReason === null;
    const restartReason = !restart ? null : Lcap < Lstar ? "context_cap" : "cost";
    const rhoVal = rho(cRatio, kAvg, baseline.total);
    const P = paybackP(L, baseline.total);
    const sumOut = seg.reduce((a, c) => a + c.output, 0);
    const paybackOutP = baseline.total > 0 ? sumOut / baseline.total : 0;
    const nNow = seg.length;
    const nStarVal = nStar(cRatio, baseline.total, kAvg);
    return {
      L,
      Lstar,
      Lcap,
      Lthreshold,
      restart,
      restartReason,
      calibratingReason,
      model,
      kAvg,
      growth: seg.length ? Math.max(0, L - (seg.length >= 2 ? effectiveL(seg[seg.length - 2]) : L)) : 0,
      apiCalls,
      segment: this._segment,
      uptime: this._uptimeSec(),
      phi: phi(L, baseline.total, cRatio, kAvg),
      paybackP: P,
      paybackOutP,
      rho: rhoVal,
      timingWeight: timingWeight(rhoVal),
      sweetP: 1 + rhoVal,
      regret: regret(nNow, nStarVal),
      baseline: baselineOut,
      metricsReliable: true,
      // hardcoded for API backward compat (v2.2: _metricsReliable retired from gate pipeline)
      rateLamp: rateLampInstant
    };
  }
  // DIAGNOSTIC ONLY — removed from latch/gate pipeline (v2.2 hotfix: gField formula is
  // provider-specific, confidence gate covers data quality)
  _metricsReliable(seg) {
    if (seg.length < 3) return true;
    const rates = [];
    for (let i = 1; i < seg.length; i++) {
      if (seg[i].miss || seg[i - 1].miss) continue;
      const raw = seg[i].cacheRead - seg[i - 1].cacheRead;
      if (raw < 0) continue;
      const dL = raw;
      const gFieldPrev = seg[i - 1].gField;
      rates.push(Math.abs(dL - gFieldPrev) / Math.max(1, dL));
    }
    if (rates.length < 2) return true;
    return median(rates) < CONSTANTS.RESIDUAL_MAX;
  }
  _uptimeSec() {
    if (this._startMs == null) return 0;
    return Math.floor((this._nowMs() - this._startMs) / 1e3);
  }
  _nowMs() {
    return Date.now();
  }
  // getHistory endpoint memoization (H1) lives in history.js (getHistory takes this instance and calls
  // this._baselineAndKavg — the SAME pipeline getStatus uses — so the current segment's last point
  // still matches getStatus, QF1). Thin delegator keeps the public method surface unchanged.
  getHistory(fitWindowOverride) {
    return getHistory(this, fitWindowOverride);
  }
};

// lib/store.js
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
var SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  model       TEXT,
  project_id  TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS state (
  session_id TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS lines (
  session_id TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  line_num   INTEGER NOT NULL,
  chars      INTEGER NOT NULL,
  PRIMARY KEY (session_id, path, line_num)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS paths (
  session_id TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  edit_delta  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS profile (
  session_id   TEXT PRIMARY KEY,
  archived_at  INTEGER NOT NULL,
  model        TEXT,
  project_id   TEXT,
  l_floor      REAL,
  b_total      REAL,
  l_peak       REAL,
  g_final      REAL,
  o_avg        REAL,
  c_ratio      REAL,
  turns        INTEGER,
  duration_ms  INTEGER,
  total_tokens_read REAL,
  mf           REAL,
  pp_exit      REAL,
  br_exit      REAL,
  br_peak      REAL,
  pp_peak      REAL,
  p0           REAL,
  b_axis       REAL,
  x_axis       REAL,
  g_min        REAL,
  turn_at_br_amber INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_profile_archived_at ON profile(archived_at DESC);
CREATE INDEX IF NOT EXISTS idx_profile_project_id ON profile(project_id);
`;
function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const version = row ? parseInt(row.value) : 0;
    if (version < 1) {
      db.exec(SCHEMA_V1_SQL);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
var Store = class _Store {
  constructor(db) {
    this._db = db;
    this._closed = false;
    this._stmts = {
      touchSession: db.prepare(`INSERT INTO sessions (session_id, created_at, updated_at, model, project_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at, model = COALESCE(excluded.model, sessions.model), project_id = COALESCE(excluded.project_id, sessions.project_id)`),
      load: db.prepare("SELECT value FROM state WHERE session_id = ? AND key = ?"),
      save: db.prepare(`INSERT INTO state (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`),
      delete: db.prepare("DELETE FROM state WHERE session_id = ? AND key = ?"),
      loadAll: db.prepare("SELECT key, value FROM state WHERE session_id = ?"),
      deleteSessionState: db.prepare("DELETE FROM state WHERE session_id = ?"),
      deleteSessionPaths: db.prepare("DELETE FROM paths WHERE session_id = ?"),
      deleteSessionLines: db.prepare("DELETE FROM lines WHERE session_id = ?"),
      deleteSessionRecord: db.prepare("DELETE FROM sessions WHERE session_id = ?"),
      // Config CRUD
      loadConfig: db.prepare("SELECT value FROM config WHERE key = ?"),
      saveConfig: db.prepare(`INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      deleteConfig: db.prepare("DELETE FROM config WHERE key = ?"),
      // Profile archival
      archiveSession: db.prepare(`INSERT INTO profile (session_id, archived_at, model, project_id,
        l_floor, b_total, l_peak, g_final, o_avg, c_ratio, turns, duration_ms, total_tokens_read,
        mf, pp_exit, br_exit, br_peak, pp_peak,
        p0, b_axis, x_axis, g_min, turn_at_br_amber)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET
          archived_at = excluded.archived_at, model = excluded.model,
          project_id = excluded.project_id,
          l_floor = excluded.l_floor, b_total = excluded.b_total,
          l_peak = excluded.l_peak, g_final = excluded.g_final,
          o_avg = excluded.o_avg, c_ratio = excluded.c_ratio,
          turns = excluded.turns, duration_ms = excluded.duration_ms,
          total_tokens_read = excluded.total_tokens_read,
          mf = excluded.mf, pp_exit = excluded.pp_exit, br_exit = excluded.br_exit,
          br_peak = excluded.br_peak, pp_peak = excluded.pp_peak,
          p0 = excluded.p0, b_axis = excluded.b_axis, x_axis = excluded.x_axis,
          g_min = excluded.g_min, turn_at_br_amber = excluded.turn_at_br_amber`),
      loadProfile: db.prepare("SELECT * FROM profile WHERE session_id = ?"),
      loadAllProfiles: db.prepare("SELECT * FROM profile ORDER BY archived_at DESC"),
      // Sweep (GC)
      expiredSessions: db.prepare("SELECT session_id FROM sessions WHERE updated_at < ?"),
      loadSessionMeta: db.prepare("SELECT model, project_id FROM sessions WHERE session_id = ?"),
      // Line-level operations (paths + lines tables)
      clearLines: db.prepare("DELETE FROM lines WHERE session_id = ? AND path = ?"),
      insertLine: db.prepare(`INSERT INTO lines (session_id, path, line_num, chars) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path, line_num) DO UPDATE SET chars = excluded.chars`),
      upsertPath: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, 0, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET updated_at = excluded.updated_at`),
      setDelta: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET edit_delta = excluded.edit_delta, updated_at = excluded.updated_at`),
      addDelta: db.prepare(`INSERT INTO paths (session_id, path, edit_delta, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, path) DO UPDATE SET edit_delta = edit_delta + excluded.edit_delta, updated_at = excluded.updated_at`),
      pathTotal: db.prepare(`SELECT COALESCE(SUM(l.chars), 0) + COALESCE(p.edit_delta, 0) as total
        FROM paths p LEFT JOIN lines l ON l.session_id = p.session_id AND l.path = p.path
        WHERE p.session_id = ? AND p.path = ?`),
      allTotals: db.prepare(`SELECT p.path, COALESCE(SUM(l.chars), 0) + COALESCE(p.edit_delta, 0) as total
        FROM paths p LEFT JOIN lines l ON l.session_id = p.session_id AND l.path = p.path
        WHERE p.session_id = ? GROUP BY p.path`),
      clearPathMeta: db.prepare("DELETE FROM paths WHERE session_id = ? AND path = ?"),
      clearAllLines: db.prepare("DELETE FROM lines WHERE session_id = ?"),
      clearAllPathsMeta: db.prepare("DELETE FROM paths WHERE session_id = ?")
    };
  }
  load(sessionId, key) {
    const row = this._stmts.load.get(sessionId, key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  save(sessionId, key, value, { model, projectId } = {}) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.save.run(sessionId, key, JSON.stringify(value), now);
      this._stmts.touchSession.run(sessionId, now, now, model || null, projectId || null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  saveBatch(sessionId, entries, { model, projectId } = {}) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) {
        this._stmts.save.run(sessionId, key, JSON.stringify(value), now);
      }
      this._stmts.touchSession.run(sessionId, now, now, model || null, projectId || null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  delete(sessionId, key) {
    this._stmts.delete.run(sessionId, key);
  }
  loadSession(sessionId) {
    const rows = this._stmts.loadAll.all(sessionId);
    const map = /* @__PURE__ */ new Map();
    for (const row of rows) {
      try {
        map.set(row.key, JSON.parse(row.value));
      } catch {
      }
    }
    return map;
  }
  deleteSession(sessionId) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.deleteSessionState.run(sessionId);
      this._stmts.deleteSessionPaths.run(sessionId);
      this._stmts.deleteSessionLines.run(sessionId);
      this._stmts.deleteSessionRecord.run(sessionId);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  // --- Config CRUD ---
  loadConfig(key) {
    const row = this._stmts.loadConfig.get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  saveConfig(key, value) {
    this._stmts.saveConfig.run(key, JSON.stringify(value));
  }
  deleteConfig(key) {
    this._stmts.deleteConfig.run(key);
  }
  // --- Profile archival ---
  archiveSession(sessionId, snapshot) {
    const now = Date.now();
    this._stmts.archiveSession.run(
      sessionId,
      now,
      snapshot.model || null,
      snapshot.projectId || null,
      snapshot.lFloor ?? null,
      snapshot.bTotal ?? null,
      snapshot.lPeak ?? null,
      snapshot.gFinal ?? null,
      snapshot.oAvg ?? null,
      snapshot.cRatio ?? null,
      snapshot.turns ?? null,
      snapshot.durationMs ?? null,
      snapshot.totalTokensRead ?? null,
      snapshot.mf ?? null,
      snapshot.ppExit ?? null,
      snapshot.brExit ?? null,
      snapshot.brPeak ?? null,
      snapshot.ppPeak ?? null,
      snapshot.p0 ?? null,
      snapshot.bAxis ?? null,
      snapshot.xAxis ?? null,
      snapshot.gMin ?? null,
      snapshot.turnAtBrAmber ?? null
    );
  }
  // #21: camelize profile rows from DB (snake_case columns -> camelCase JS API)
  static _camelizeProfile(row) {
    if (!row) return null;
    return {
      sessionId: row.session_id,
      archivedAt: row.archived_at,
      model: row.model,
      projectId: row.project_id,
      lFloor: row.l_floor,
      bTotal: row.b_total,
      lPeak: row.l_peak,
      gFinal: row.g_final,
      oAvg: row.o_avg,
      cRatio: row.c_ratio,
      turns: row.turns,
      durationMs: row.duration_ms,
      totalTokensRead: row.total_tokens_read,
      mf: row.mf,
      ppExit: row.pp_exit,
      brExit: row.br_exit,
      brPeak: row.br_peak,
      ppPeak: row.pp_peak,
      p0: row.p0,
      bAxis: row.b_axis,
      xAxis: row.x_axis,
      gMin: row.g_min,
      turnAtBrAmber: row.turn_at_br_amber
    };
  }
  getProfile(sessionId) {
    return _Store._camelizeProfile(this._stmts.loadProfile.get(sessionId));
  }
  getAllProfiles() {
    return this._stmts.loadAllProfiles.all().map(_Store._camelizeProfile);
  }
  // --- Sweep (GC): archive-then-delete expired sessions ---
  sweep(maxAgeMs, { now = Date.now(), isLiveSession } = {}) {
    const cutoff = now - maxAgeMs;
    const expired = this._stmts.expiredSessions.all(cutoff);
    let count = 0;
    for (const { session_id } of expired) {
      if (isLiveSession && isLiveSession(session_id)) continue;
      this._db.exec("BEGIN IMMEDIATE");
      try {
        const sessRow = this._stmts.loadSessionMeta.get(session_id);
        this.archiveSession(session_id, { model: sessRow?.model || null, projectId: sessRow?.project_id || null });
        this._stmts.deleteSessionState.run(session_id);
        this._stmts.deleteSessionPaths.run(session_id);
        this._stmts.deleteSessionLines.run(session_id);
        this._stmts.deleteSessionRecord.run(session_id);
        this._db.exec("COMMIT");
        count++;
      } catch (e) {
        this._db.exec("ROLLBACK");
        console.error("[store] sweep: failed to archive/delete session", session_id, e.message);
        continue;
      }
    }
    if (count > 0) this._db.exec("PRAGMA incremental_vacuum");
    return count;
  }
  // --- Line-level operations (paths + lines tables) ---
  setLines(sessionId, path, entries) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.setDelta.run(sessionId, path, 0, now);
      this._stmts.clearLines.run(sessionId, path);
      for (const [lineNum, chars] of entries) {
        this._stmts.insertLine.run(sessionId, path, lineNum, chars);
      }
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  updateLines(sessionId, path, entries) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.upsertPath.run(sessionId, path, now);
      for (const [lineNum, chars] of entries) {
        this._stmts.insertLine.run(sessionId, path, lineNum, chars);
      }
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  addEditDelta(sessionId, path, delta) {
    const now = Date.now();
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.addDelta.run(sessionId, path, delta, now);
      this._stmts.touchSession.run(sessionId, now, now, null, null);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  getPathTotal(sessionId, path) {
    const row = this._stmts.pathTotal.get(sessionId, path);
    return row ? row.total : 0;
  }
  getAllPathTotals(sessionId) {
    const rows = this._stmts.allTotals.all(sessionId);
    const map = /* @__PURE__ */ new Map();
    for (const row of rows) map.set(row.path, row.total);
    return map;
  }
  clearPath(sessionId, path) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.clearLines.run(sessionId, path);
      this._stmts.clearPathMeta.run(sessionId, path);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  clearAllPaths(sessionId) {
    this._db.exec("BEGIN IMMEDIATE");
    try {
      this._stmts.clearAllLines.run(sessionId);
      this._stmts.clearAllPathsMeta.run(sessionId);
      this._db.exec("COMMIT");
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }
  resetForTesting() {
    closeStoreGlobal();
  }
};
function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 3e3 });
  try {
    const walResult = db.prepare("PRAGMA journal_mode=WAL").get();
    const actualMode = String(walResult.journal_mode ?? "").toLowerCase();
    if (actualMode !== "wal") {
      console.error(`[store] WAL unavailable (got ${actualMode}). Check local filesystem.`);
    }
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    migrate(db);
    return new Store(db);
  } catch (err) {
    try {
      db.close();
    } catch {
    }
    throw err;
  }
}
function closeStore(store) {
  if (store._closed) return;
  store._closed = true;
  store._db.close();
}
var _instance = null;
function defaultDbPath() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".session-watcher");
  return join(base, "store.sqlite");
}
function initStore(dbPath) {
  if (_instance) closeStore(_instance);
  _instance = openStore(dbPath || defaultDbPath());
  return _instance;
}
function getStore() {
  if (!_instance) throw new Error("Store not initialized");
  return _instance;
}
function closeStoreGlobal() {
  if (_instance) {
    closeStore(_instance);
    _instance = null;
  }
}

// lib/ledger-schema.js
var numFields = [
  "billProgress",
  "billCycleCount",
  "billAnchorLRead",
  "billAnchorTurnSeq",
  "billAnchorFoldedCallSeq",
  "lastAppliedFoldedCallSeq",
  "currentTurnSeq",
  "currentTurnDeltaW",
  "pendingBillCountSinceBoundary",
  "cacheExpiryCount",
  "kStableFrozen"
];
var intFields = [
  "billCycleCount",
  "billAnchorTurnSeq",
  "billAnchorFoldedCallSeq",
  "lastAppliedFoldedCallSeq",
  "currentTurnSeq",
  "pendingBillCountSinceBoundary",
  "cacheExpiryCount",
  // v2.2-C (schema v2): monotonic settlement cursors + mutation counter, all non-negative ints.
  "settledThroughTurnSeq",
  "alertEvaluatedThroughTurnSeq",
  "ledgerRevision"
];
var SUMMARY_BILL_KINDS = /* @__PURE__ */ new Set([null, "empty_burn", "non_idle_burn", "cache_unstable"]);
function isNaNOrUnitInterval(x) {
  return Number.isNaN(x) || Number.isFinite(x) && x >= 0 && x < 1;
}
var PAUSE_REASONS = /* @__PURE__ */ new Set([
  null,
  "folded_seq_gap",
  "metrics_unreliable",
  "invalid_baseline",
  "insufficient_data",
  "cache_unstable",
  "seq_history_mismatch",
  "invalid_sample",
  "folded_call_mutated"
]);
function validateLedgerState(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.schemaVersion !== 2) return null;
  if (typeof obj.stateKey !== "string") return null;
  if (obj.billingBasis !== "fullCarry") return null;
  if (obj.settledThroughTurnSeq === void 0) obj.settledThroughTurnSeq = 0;
  if (obj.alertEvaluatedThroughTurnSeq === void 0) obj.alertEvaluatedThroughTurnSeq = obj.settledThroughTurnSeq;
  if (obj.ledgerRevision === void 0) obj.ledgerRevision = 0;
  if (obj.pendingStopEvaluations === void 0) obj.pendingStopEvaluations = [];
  if (obj.settledTurnSummaries === void 0) obj.settledTurnSummaries = [];
  if (obj.recentStopEvents === void 0) obj.recentStopEvents = [];
  if (obj.recentProcessedHookEventIds === void 0) obj.recentProcessedHookEventIds = [];
  if (typeof obj.deepWaterDisplayLatched !== "boolean") obj.deepWaterDisplayLatched = false;
  for (const f of numFields) if (!Number.isFinite(obj[f])) return null;
  if (!(obj.billProgress >= 0 && obj.billProgress < 1)) return null;
  for (const f of intFields) if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  for (const f of ["billAnchorLRead", "currentTurnDeltaW", "kStableFrozen"]) if (obj[f] < 0) return null;
  if (!PAUSE_REASONS.has(obj.pausedReason)) return null;
  if (obj.lastBurnRate !== null && !(Number.isFinite(obj.lastBurnRate) && obj.lastBurnRate >= 0)) return null;
  if (obj.lastAppliedLRead != null && !(Number.isFinite(obj.lastAppliedLRead) && obj.lastAppliedLRead >= 0)) return null;
  if (obj.lastBillEvent != null && typeof obj.lastBillEvent !== "object") return null;
  if (obj.lastStopEvent != null && typeof obj.lastStopEvent !== "object") return null;
  if (!Array.isArray(obj.settledTurnSummaries) || obj.settledTurnSummaries.length > SETTLED_SUMMARY_HARD_LIMIT) return null;
  for (const e of obj.settledTurnSummaries) {
    if (!e || typeof e !== "object") return null;
    if (!Number.isInteger(e.turnSeq) || e.turnSeq < 0) return null;
    if (!Number.isInteger(e.foldedCallSeqStart) || e.foldedCallSeqStart < 0) return null;
    if (!Number.isInteger(e.foldedCallSeqEnd) || e.foldedCallSeqEnd < e.foldedCallSeqStart) return null;
    if (!Number.isFinite(e.deltaW)) return null;
    if (!Number.isInteger(e.billCycleCountIncrement) || e.billCycleCountIncrement < 0) return null;
    if (typeof e.inDeepWaterAtBoundary !== "boolean") return null;
    if (!SUMMARY_BILL_KINDS.has(e.billKindAtBoundary)) return null;
    if (!isNaNOrUnitInterval(e.billProgressBefore)) e.billProgressBefore = NaN;
    if (!isNaNOrUnitInterval(e.billProgressAfter)) e.billProgressAfter = NaN;
    if (!(e.hBreakAtBoundary === null || e.hBreakAtBoundary > 0)) e.hBreakAtBoundary = null;
  }
  if (!Array.isArray(obj.pendingStopEvaluations) || obj.pendingStopEvaluations.length > PENDING_STOP_EVALUATIONS_LIMIT) return null;
  for (const e of obj.pendingStopEvaluations) {
    if (!e || typeof e !== "object") return null;
    if (typeof e.hookEventId !== "string") return null;
    if (!Number.isInteger(e.beforeSettledThroughTurnSeq) || e.beforeSettledThroughTurnSeq < 0) return null;
    if (!Number.isFinite(e.requestedAtWallMs)) return null;
    if (!Number.isInteger(e.enqueueSeq) || e.enqueueSeq < 0) return null;
    if (e.status !== "pending") return null;
  }
  if (!Array.isArray(obj.recentStopEvents) || obj.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) return null;
  for (const e of obj.recentStopEvents) {
    if (!e || typeof e !== "object") return null;
    if (typeof e.kind !== "string") return null;
    if (!Number.isInteger(e.turnSeq) || e.turnSeq < 0) return null;
  }
  if (!Array.isArray(obj.recentProcessedHookEventIds) || obj.recentProcessedHookEventIds.length > RECENT_PROCESSED_HOOK_IDS_LIMIT) return null;
  for (const id of obj.recentProcessedHookEventIds) if (typeof id !== "string") return null;
  return obj;
}
function validateRateLampSample(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (typeof obj.reliable !== "boolean") return false;
  if (!Number.isInteger(obj.seq) || obj.seq < 0) return false;
  if (!Number.isInteger(obj.turnSeq) || obj.turnSeq < 0) return false;
  if (obj.reliable) {
    if (!(Number.isFinite(obj.burnRate) && obj.burnRate >= 0)) return false;
    if (!(Number.isFinite(obj.L_read) && obj.L_read >= 0)) return false;
  }
  return true;
}

// lib/stop-message.js
var WALL = "Rate wall: one more call costs at least one full restart in avoidable context rent. Finish the current small step, then restart unless continuity is unusually valuable.";
var DW = "Rate bill: this step triggered several underlying calls; accumulated avoidable rent \u2248 multiple full restarts. Consider restarting at the next natural checkpoint.";
var EMPTY = "Rate idle-burn: about one billing cycle passed with little new context, yet high-position rent \u2248 one full restart. Consider restarting after the current small step.";
var NON_IDLE = "Rate bill: this cycle's high-position rent \u2248 one full restart; context is still growing. Consider tidying up, compacting, or restarting at a natural checkpoint.";
var CACHE_UNSTABLE = "Calibrating: context stock dropped (cache expiry / boundary); rate metering paused for this step.";
var merge = (msg, gate) => gate?.notify && gate.message ? `${gate.message} \xB7 ${msg}` : msg;
function resolveStopMessage({ gateResult, bill, burnRate, dwTurn, stockStep }) {
  if (burnRate >= 1) {
    if (stockStep) return { kind: "non_idle_burn", delivery: "statusline_pulse", message: NON_IDLE, billCount: bill?.billCount ?? 0 };
    return { kind: "wall", delivery: "stop_hook", message: merge(WALL, gateResult), billCount: bill?.billCount ?? 0 };
  }
  if (dwTurn >= CONSTANTS.DW_TURN_BACKSTOP) {
    if (stockStep) return { kind: "non_idle_burn", delivery: "statusline_pulse", message: NON_IDLE, billCount: bill?.billCount ?? 0 };
    return { kind: "dw_backstop", delivery: "stop_hook", message: merge(DW, gateResult), billCount: bill?.billCount ?? 0 };
  }
  if (bill?.kind === "empty_burn" && bill.delivery === "stop_hook") {
    return { kind: "empty_burn", delivery: "stop_hook", message: merge(EMPTY, gateResult), billCount: bill.billCount };
  }
  if (gateResult?.notify) {
    return { kind: "gate", delivery: "stop_hook", message: gateResult.message, billCount: bill?.billCount ?? 0 };
  }
  if (bill?.kind === "non_idle_burn") {
    return { kind: "non_idle_burn", delivery: "statusline_pulse", message: NON_IDLE, billCount: bill.billCount };
  }
  if (bill?.kind === "cache_unstable") {
    return { kind: "cache_unstable", delivery: "statusline_pulse", message: CACHE_UNSTABLE, billCount: bill.billCount };
  }
  return null;
}

// lib/rate-lamp-store.js
var SCHEMA_VERSION = 2;
function stateKeyOf({ segmentId, model, cRatio, baselineFingerprint: baselineFingerprint2, contextCap, schemaVersion = SCHEMA_VERSION }) {
  return JSON.stringify([segmentId, model, cRatio, baselineFingerprint2, contextCap, schemaVersion]);
}
function stateKeyForStatus(status) {
  return stateKeyOf({
    segmentId: status.segment,
    model: status.model,
    cRatio: status.rateLamp.C_RATIO,
    baselineFingerprint: status.baseline?.fingerprint ?? null,
    contextCap: status.rateLamp.L_cap,
    schemaVersion: 1
  });
}
function freshLedger(stateKey, kStableFrozen = 0) {
  return {
    schemaVersion: SCHEMA_VERSION,
    stateKey,
    billingBasis: "fullCarry",
    billProgress: 0,
    billCycleCount: 0,
    billAnchorLRead: 0,
    billAnchorTurnSeq: 0,
    billAnchorFoldedCallSeq: 0,
    lastBurnRate: null,
    lastAppliedFoldedCallSeq: 0,
    lastAppliedLRead: null,
    currentTurnSeq: 0,
    currentTurnDeltaW: 0,
    pendingBillCountSinceBoundary: 0,
    pausedReason: null,
    cacheExpiryCount: 0,
    kStableFrozen,
    // GPT#11: frozen at segment establishment; same-key restart reuses it (no xExit drift)
    lastBillEvent: null,
    // round-2 GPT#7: TTL pulse channel for statusline (kind/billCount/deltaL/delivery/turnSeq)
    lastStopEvent: null,
    // final-review GPT#2: full resolved Stop-message channel (only UI home w/ no OS notify)
    // v2.2-C fields (schema v2). All serialized EXCEPT lastPersistedRevision (process-only, set in hydrate).
    // `schemaVersion` above IS the version field (spec's `ledgerSchemaVersion` = same concept, one name).
    // No field here is READ by settle/alert this sub-batch (C1-1): behavior/metric output byte-identical.
    settledThroughTurnSeq: 0,
    alertEvaluatedThroughTurnSeq: 0,
    ledgerRevision: 0,
    pendingStopEvaluations: [],
    settledTurnSummaries: [],
    recentStopEvents: [],
    recentProcessedHookEventIds: [],
    deepWaterDisplayLatched: false
    // DEPRECATED: kept for schema compat, not consumed by display/gate logic
  };
}
function invalidPausedLedger(prev) {
  const stateKey = prev && typeof prev === "object" && typeof prev.stateKey === "string" ? prev.stateKey : "__invalid__";
  const kStable = prev && Number.isFinite(prev.kStableFrozen) && prev.kStableFrozen >= 0 ? prev.kStableFrozen : 0;
  const s = freshLedger(stateKey, kStable);
  s.pausedReason = "invalid_sample";
  return s;
}
function pushStopEventRing(ledgerOrDraft, evt) {
  if (!ledgerOrDraft.recentStopEvents) ledgerOrDraft.recentStopEvents = [];
  ledgerOrDraft.recentStopEvents.push(evt);
  if (ledgerOrDraft.recentStopEvents.length > RECENT_STOP_EVENTS_LIMIT) {
    ledgerOrDraft.recentStopEvents.splice(0, ledgerOrDraft.recentStopEvents.length - RECENT_STOP_EVENTS_LIMIT);
  }
}
function applyFoldedCallSample(prev, sample) {
  if (!validateLedgerState(prev)) return invalidPausedLedger(prev);
  const s = { ...prev };
  if (!validateRateLampSample(sample)) {
    s.pausedReason = "invalid_sample";
    return s;
  }
  if (sample.seq === s.lastAppliedFoldedCallSeq && sample.reliable && Number.isFinite(s.lastAppliedLRead) && Number.isFinite(sample.L_read) && sample.L_read !== s.lastAppliedLRead) {
    s.pausedReason = "folded_call_mutated";
    return s;
  }
  if (sample.seq <= s.lastAppliedFoldedCallSeq) return s;
  if (s.lastAppliedFoldedCallSeq !== 0 && sample.seq !== s.lastAppliedFoldedCallSeq + 1) {
    s.pausedReason = "folded_seq_gap";
    s.lastAppliedFoldedCallSeq = sample.seq;
    if (sample.reliable && Number.isFinite(sample.L_read)) s.lastAppliedLRead = sample.L_read;
    return s;
  }
  if (sample.turnSeq !== s.currentTurnSeq) {
    s.currentTurnSeq = sample.turnSeq;
    s.currentTurnDeltaW = 0;
  }
  if (!sample.reliable) {
    s.pausedReason = sample.unavailableReason || "insufficient_data";
    s.lastBurnRate = null;
    s.lastAppliedFoldedCallSeq = sample.seq;
    return s;
  }
  const br = Number.isFinite(sample.burnRate) ? Math.max(0, sample.burnRate) : 0;
  const recovering = s.pausedReason != null || s.lastBurnRate == null;
  if (recovering) {
    s.pausedReason = null;
    s.lastBurnRate = br;
    s.lastAppliedFoldedCallSeq = sample.seq;
    s.lastAppliedLRead = sample.L_read;
    if (s.billAnchorFoldedCallSeq === 0) {
      s.billAnchorLRead = sample.L_read;
      s.billAnchorFoldedCallSeq = sample.seq;
      s.billAnchorTurnSeq = sample.turnSeq;
    }
    return s;
  }
  const trap = 0.5 * (s.lastBurnRate + br);
  let next = s.billProgress + trap;
  while (next >= 1) {
    next -= 1;
    s.pendingBillCountSinceBoundary += 1;
    s.billCycleCount += 1;
  }
  s.billProgress = Math.floor(next * 1e6) / 1e6;
  s.currentTurnDeltaW = Math.floor((s.currentTurnDeltaW + trap) * 1e6) / 1e6;
  s.lastBurnRate = br;
  s.lastAppliedFoldedCallSeq = sample.seq;
  s.lastAppliedLRead = sample.L_read;
  return s;
}
function settleMeterAtBoundary(prev, { L_readNow, kStable, foldedSeqNow, turnSeqNow, endedTurnSeq, inDeepWater }) {
  if (!validateLedgerState(prev)) return { state: invalidPausedLedger(prev), summary: null };
  if (endedTurnSeq <= prev.settledThroughTurnSeq) return { state: prev, summary: null };
  const s = { ...prev };
  const anchorBefore = s.billAnchorLRead;
  const foldedCallSeqStart = s.billAnchorFoldedCallSeq;
  const foldedCallSeqEnd = Number.isFinite(foldedSeqNow) ? foldedSeqNow : s.lastAppliedFoldedCallSeq;
  const deltaW = L_readNow - anchorBefore;
  const deltaL = deltaW;
  const billProgressBefore = s.billProgress;
  const billCycleCountIncrement = s.pendingBillCountSinceBoundary;
  const reanchor = () => {
    s.billAnchorLRead = L_readNow;
    if (Number.isFinite(foldedSeqNow)) s.billAnchorFoldedCallSeq = foldedSeqNow;
    if (Number.isFinite(turnSeqNow)) s.billAnchorTurnSeq = turnSeqNow;
    s.pendingBillCountSinceBoundary = 0;
  };
  let billKindAtBoundary;
  if (deltaL < 0) {
    billKindAtBoundary = "cache_unstable";
    s.pausedReason = "cache_unstable";
    s.cacheExpiryCount += 1;
  } else if (deltaL < kStable) {
    billKindAtBoundary = "empty_burn";
  } else {
    billKindAtBoundary = "non_idle_burn";
  }
  if (foldedCallSeqStart === foldedCallSeqEnd) billKindAtBoundary = null;
  if (!Number.isFinite(kStable) || kStable <= 0) billKindAtBoundary = null;
  reanchor();
  s.currentTurnDeltaW = 0;
  const hBreakAtBoundary = Number.isFinite(s.lastBurnRate) ? s.lastBurnRate > 0 ? 1 / s.lastBurnRate : Infinity : null;
  const summary = {
    turnSeq: endedTurnSeq,
    foldedCallSeqStart,
    foldedCallSeqEnd,
    deltaW,
    billProgressBefore,
    billProgressAfter: s.billProgress,
    // settle never touches billProgress → equal to before (byte-identical)
    billCycleCountIncrement,
    inDeepWaterAtBoundary: inDeepWater === true,
    // F4 snapshot of the caller-derived boundary flag (strict bool for the validator)
    hBreakAtBoundary,
    billKindAtBoundary
  };
  const state = appendSettledTurnSummary(s, summary);
  return { state, summary };
}
function appendSettledTurnSummary(ledger, summary) {
  const summaries = [...ledger.settledTurnSummaries, summary];
  if (summaries.length > SETTLED_SUMMARY_HARD_LIMIT) {
    summaries.splice(0, summaries.length - SETTLED_SUMMARY_HARD_LIMIT);
  }
  return { ...ledger, settledTurnSummaries: summaries };
}
function loadRateLampState(sessionId) {
  try {
    return validateLedgerState(getStore().load(sessionId, "ledger"));
  } catch {
    return null;
  }
}
function saveRateLampState(sessionId, state) {
  getStore().save(sessionId, "ledger", state);
}
function settleableDistanceAfterWatermark(summaries, watermarkTurnSeq, candidateTurnSeq) {
  const between = summaries.filter((s) => s.turnSeq > watermarkTurnSeq && s.turnSeq < candidateTurnSeq);
  const expectedCount = candidateTurnSeq - watermarkTurnSeq - 1;
  if (between.length < expectedCount) return Infinity;
  const settleableBetween = between.filter((s) => s.foldedCallSeqStart !== s.foldedCallSeqEnd).length;
  const candidateSummary = summaries.find((s) => s.turnSeq === candidateTurnSeq);
  const candidateSettleable = candidateSummary && candidateSummary.foldedCallSeqStart !== candidateSummary.foldedCallSeqEnd ? 1 : 0;
  return settleableBetween + candidateSettleable;
}
function matchPendingToSummary(ledger) {
  const pending = [...ledger.pendingStopEvaluations || []];
  const summaries = [...ledger.settledTurnSummaries || []];
  pending.sort((a, b) => a.requestedAtWallMs - b.requestedAtWallMs || a.enqueueSeq - b.enqueueSeq || a.hookEventId.localeCompare(b.hookEventId));
  summaries.sort((a, b) => a.turnSeq - b.turnSeq || a.foldedCallSeqEnd - b.foldedCallSeqEnd);
  const assigned = [];
  const expired = [];
  const remainingPending = [];
  const usedSummaryKeys = /* @__PURE__ */ new Set();
  const usedWatermarks = /* @__PURE__ */ new Set();
  for (const p of pending) {
    if (usedWatermarks.has(p.beforeSettledThroughTurnSeq)) {
      expired.push(p);
      continue;
    }
    let matched = false;
    for (const s of summaries) {
      if (s.turnSeq <= p.beforeSettledThroughTurnSeq) continue;
      const key = s.turnSeq;
      if (usedSummaryKeys.has(key)) continue;
      const dist = settleableDistanceAfterWatermark(summaries, p.beforeSettledThroughTurnSeq, s.turnSeq);
      if (dist > PENDING_MAX_TURN_DISTANCE) {
        expired.push(p);
        matched = true;
        break;
      }
      assigned.push({ hookEventId: p.hookEventId, summaryTurnSeq: s.turnSeq });
      usedSummaryKeys.add(key);
      usedWatermarks.add(p.beforeSettledThroughTurnSeq);
      matched = true;
      break;
    }
    if (!matched) {
      remainingPending.push(p);
    }
  }
  return { assigned, remainingPending, expired };
}
function enqueuePending(ledger, { hookEventId, requestedAtWallMs, requestedAtMonoMs, processNonce: processNonce2, beforeSettledThroughTurnSeq }) {
  const arr = ledger.pendingStopEvaluations || [];
  if (arr.length >= PENDING_STOP_EVALUATIONS_LIMIT) return { ok: false };
  const enqueueSeq = 1 + Math.max(-1, ...arr.map((p) => p.enqueueSeq));
  arr.push({
    hookEventId,
    requestedAtWallMs,
    requestedAtMonoMs,
    processNonce: processNonce2,
    beforeSettledThroughTurnSeq,
    assignedTurnSeq: null,
    status: "pending",
    enqueueSeq
  });
  return { ok: true };
}
function hasProcessedHookId(ledger, id) {
  return (ledger.recentProcessedHookEventIds || []).includes(id);
}
function appendProcessedHookId(ledger, id) {
  if (!ledger.recentProcessedHookEventIds) ledger.recentProcessedHookEventIds = [];
  const arr = ledger.recentProcessedHookEventIds;
  if (arr.includes(id)) return;
  arr.push(id);
  if (arr.length > RECENT_PROCESSED_HOOK_IDS_LIMIT) arr.splice(0, arr.length - RECENT_PROCESSED_HOOK_IDS_LIMIT);
}
function alreadyAccepted(hookEventId, ledger) {
  if (hasProcessedHookId(ledger, hookEventId)) return true;
  return (ledger.pendingStopEvaluations || []).some((p) => p.hookEventId === hookEventId);
}
function expirePending(ledger, { nowMono, nowWall, processNonce: processNonce2 }) {
  const arr = ledger.pendingStopEvaluations || [];
  const removed = [];
  const kept = [];
  for (const p of arr) {
    let expired = false;
    if (p.processNonce === processNonce2) {
      if (Number.isFinite(p.requestedAtMonoMs) && nowMono - p.requestedAtMonoMs > PENDING_STOP_TTL_MS) expired = true;
    } else {
      if (nowWall - p.requestedAtWallMs >= PENDING_STOP_TTL_MS) expired = true;
    }
    if (expired) removed.push(p);
    else kept.push(p);
  }
  ledger.pendingStopEvaluations = kept;
  return removed;
}
function chooseCurrentStopSummary(draft) {
  const summaries = draft.settledTurnSummaries || [];
  const pending = draft.pendingStopEvaluations || [];
  let maxEvaluated = draft.alertEvaluatedThroughTurnSeq || 0;
  for (const s of summaries) {
    if (s.turnSeq <= maxEvaluated) continue;
    const hasPending = pending.some((p) => s.turnSeq > p.beforeSettledThroughTurnSeq);
    if (!hasPending) {
      maxEvaluated = s.turnSeq;
    } else {
      break;
    }
  }
  draft.alertEvaluatedThroughTurnSeq = maxEvaluated;
}
function resolveStopMessageFromSummary(summary) {
  if (!summary || summary.billKindAtBoundary == null) return null;
  const kind = summary.billKindAtBoundary;
  const inDeepWater = summary.inDeepWaterAtBoundary === true;
  const delivery = kind === "empty_burn" && inDeepWater ? "stop_hook" : "statusline_pulse";
  const bill = { kind, delivery, billCount: summary.billCycleCountIncrement || 0, deltaL: summary.deltaW };
  return resolveStopMessage({ gateResult: null, bill, burnRate: 0, dwTurn: 0, stockStep: false });
}

// lib/landmarks.js
function nucleus(cRatio, kAvg, lBase) {
  if (cRatio <= 0 || kAvg <= 0 || lBase <= 0) return 0;
  return Math.sqrt(2 * cRatio * kAvg / lBase);
}
function landmarksFor(cRatio, kAvg, lBase, bRebuild) {
  const b = bRebuild > 0 && lBase > 0 ? bRebuild / lBase : 0;
  const dhat = nucleus(cRatio, kAvg, lBase) * Math.sqrt(b);
  const M = CONSTANTS.EFFICIENCY_MULT;
  return { dhat, xEntry: b + 0.5 * dhat, xSweet: b + dhat, xStar: b + M * dhat };
}
function hBreak(cRatio, bRebuild, L) {
  const avoidable = L - bRebuild;
  if (avoidable <= 0) return Infinity;
  return cRatio * bRebuild / avoidable;
}
function bandOf(x, { xEntry, xSweet, xStar }) {
  if (x < xEntry) return "below_entry";
  if (x < xSweet) return "entry_to_sweet";
  if (x < xStar) return "sweet_to_exit";
  return "above_exit";
}
function landmarks(cRatio, kAvg, lBase, lDead, L) {
  const x = lBase > 0 ? L / lBase : 1;
  const full = landmarksFor(cRatio, kAvg, lBase, lBase);
  const dead = landmarksFor(cRatio, kAvg, lBase, lDead);
  return {
    x,
    fullCarry: { ...full, hBreak: hBreak(cRatio, lBase, L), band: bandOf(x, full) },
    deadOnly: { ...dead, hBreak: hBreak(cRatio, lDead, L), band: bandOf(x, dead) }
  };
}

// lib/bill-regret.js
var BR_AMBER = 0.1;
var BR_RED = 0.25;
function computeMovableFrac(cRatio, lBase, kStable) {
  if (!(cRatio > 0) || !(lBase > 0) || !(kStable > 0)) return NaN;
  const arm = Math.sqrt(2 * cRatio * lBase * kStable);
  return arm / (arm + lBase + cRatio * kStable);
}
function computeBr(x, dhat, mf) {
  const d = x - 1;
  if (!(d > 0) || !(dhat > 0) || !(mf >= 0)) return NaN;
  const u = d / dhat;
  const ppFrac = (u - 1) * (u - 1) / (2 * u);
  return mf * ppFrac;
}
function xRightFromBr(brTarget, dhat, mf) {
  if (!(brTarget >= 0) || !(dhat > 0) || !(mf > 0)) return NaN;
  const p = brTarget / mf;
  const disc = p * p + 2 * p;
  const uRight = 1 + p + Math.sqrt(disc);
  return 1 + uRight * dhat;
}
function xLeftFromBr(brTarget, dhat, mf) {
  if (!(brTarget >= 0) || !(dhat > 0) || !(mf > 0)) return NaN;
  const p = brTarget / mf;
  const disc = p * p + 2 * p;
  const uLeft = 1 + p - Math.sqrt(disc);
  return 1 + uLeft * dhat;
}

// lib/rate-lamp-manager.js
var EMA_ALPHA = 0.5;
var _perCallEma = /* @__PURE__ */ new Map();
function updatePerCallEma(state, { L }) {
  if (!Number.isFinite(L)) return state.ema;
  if (state.prevL === null) {
    state.prevL = L;
    state.callsSinceAnchor = 1;
    return null;
  }
  const delta = Math.max(0, L - state.prevL);
  state.prevL = L;
  state.callsSinceAnchor++;
  if (state.ema === null) {
    state.ema = delta;
  } else {
    state.ema = EMA_ALPHA * delta + (1 - EMA_ALPHA) * state.ema;
  }
  return state.ema;
}
var _ledgers = /* @__PURE__ */ new Map();
var _ledgerLastAccess = /* @__PURE__ */ new Map();
var LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var _lastSaved = /* @__PURE__ */ new Map();
var _lastPersistedRevision = /* @__PURE__ */ new Map();
var _pendingPersistSids = /* @__PURE__ */ new Set();
var _enospcPaused = /* @__PURE__ */ new Set();
var _counters = {
  diskWrites: 0,
  coalesceHits: 0,
  // schedulePersist calls that joined an existing pending
  coalesceMisses: 0,
  // schedulePersist calls that added a new pending
  revisionGateBlocks: 0,
  // writes refused by the revision gate
  enospcEngagements: 0,
  enospcRecoveries: 0,
  // Step 4 counters (spec-required):
  stopAdvanceAttemptCount: 0,
  // boundedIncrementalAdvance entries
  stopAdvanceCaughtUpCount: 0,
  // advance completed (caughtUp === true)
  stopAdvanceTimeoutCount: 0,
  // advance broke on maxMs budget
  stopAdvanceMaxBytesHitCount: 0,
  // not applicable in poll-based mode (always 0)
  pendingCreatedCount: 0,
  // enqueuePending calls that succeeded
  pendingDrainedCount: 0,
  // assigned matches in drainPendingStopEvaluations
  pendingExpiredCount: 0
  // expired entries in drainPendingStopEvaluations
};
var _testWriter = null;
var _testScheduler = null;
var _testNowMono = null;
function _nowMono() {
  return _testNowMono ? _testNowMono() : performance.now();
}
var _coalescedTimer = null;
function _startCoalescedTimer() {
  if (_coalescedTimer) return;
  const schedulerFn = _testScheduler || setInterval;
  _coalescedTimer = schedulerFn(_flushCoalescedPersist, COALESCED_PERSIST_MS);
  if (_coalescedTimer && typeof _coalescedTimer.unref === "function") _coalescedTimer.unref();
}
function _flushCoalescedPersist() {
  for (const sid of _pendingPersistSids) {
    if (_enospcPaused.has(sid)) continue;
    try {
      const ledger = _ledgers.get(sid);
      if (!ledger) {
        _pendingPersistSids.delete(sid);
        continue;
      }
      persistLedger(sid, ledger);
    } catch (e) {
      _enospcPaused.add(sid);
      _counters.enospcEngagements++;
      if (process.env.SW_DEBUG) console.error(`[rate-lamp] ENOSPC pause engaged for ${sid}:`, e.message);
    }
  }
  _pendingPersistSids.clear();
}
function schedulePersist(sessionId) {
  if (_enospcPaused.has(sessionId)) return;
  if (_pendingPersistSids.has(sessionId)) {
    _counters.coalesceHits++;
  } else {
    _counters.coalesceMisses++;
    _pendingPersistSids.add(sessionId);
  }
  _startCoalescedTimer();
}
function cancelCoalescedPersist(sessionId) {
  _pendingPersistSids.delete(sessionId);
}
function isEnospcPaused(sessionId) {
  return _enospcPaused.has(sessionId);
}
function clearEnospcPause(sessionId) {
  _enospcPaused.delete(sessionId);
  _counters.enospcRecoveries++;
}
function engageEnospcPause(sessionId) {
  _enospcPaused.add(sessionId);
  _counters.enospcEngagements++;
}
function persistLedger(sessionId, ledger, { force = false } = {}) {
  const ledgerRev = ledger.ledgerRevision ?? 0;
  const lastPersistedRev = _lastPersistedRevision.get(sessionId) ?? 0;
  if (!force && ledgerRev < lastPersistedRev) {
    _counters.revisionGateBlocks++;
    if (process.env.SW_DEBUG) console.error(`[rate-lamp] revision gate: refusing rev ${ledgerRev} <= last-persisted ${lastPersistedRev} for ${sessionId}`);
    return;
  }
  if (ledgerRev === lastPersistedRev && !force) {
    const savedContent = _lastSaved.get(sessionId);
    if (savedContent !== void 0) {
      if (JSON.stringify(ledger) !== savedContent) {
        _counters.revisionGateBlocks++;
        console.error(`[rate-lamp] DEAD-LETTER: escaped mutation for ${sessionId} \u2014 content differs at same revision ${ledgerRev}. mutateLedger was bypassed (invariant breach).`);
      }
      return;
    }
  }
  const serialized = JSON.stringify(ledger);
  if (!force && _lastSaved.get(sessionId) === serialized) return;
  if (_testWriter) {
    _testWriter(sessionId, ledger);
  } else {
    saveRateLampState(sessionId, ledger);
  }
  _lastSaved.set(sessionId, serialized);
  _lastPersistedRevision.set(sessionId, ledgerRev);
  _counters.diskWrites++;
}
function syncLedgerTurn(ledger, watcherTurnSeq) {
  const prev = ledger.currentTurnSeq ?? 0;
  if (watcherTurnSeq > prev) return { ...ledger, currentTurnSeq: watcherTurnSeq, currentTurnDeltaW: 0 };
  return { ...ledger, currentTurnSeq: Math.max(prev, watcherTurnSeq) };
}
function syncTurnCursorOnDraft(l, targetTurnSeq) {
  const prev = l.currentTurnSeq ?? 0;
  if (targetTurnSeq > prev) {
    l.currentTurnSeq = targetTurnSeq;
    l.currentTurnDeltaW = 0;
  } else {
    l.currentTurnSeq = Math.max(prev, targetTurnSeq);
  }
}
function reanchorOnMismatch(persisted, { watcherFoldedSeq, watcherTurnSeq, lReadNow }) {
  if (process.env.SW_DEBUG) console.error("[rate-lamp] seq mismatch \u2192 re-anchored, cycleCount preserved");
  return {
    ...persisted,
    // PRESERVED: billCycleCount (lifetime/dashboard) + billProgress (remainder continuity) + kStableFrozen + stateKey.
    lastAppliedFoldedCallSeq: watcherFoldedSeq,
    // from-now integration, no catch-up (P0-5)
    billAnchorFoldedCallSeq: watcherFoldedSeq,
    billAnchorLRead: lReadNow,
    billAnchorTurnSeq: watcherTurnSeq,
    pendingBillCountSinceBoundary: 0,
    // pending across a seq break is untrustworthy → drop it (no phantom Stop bill)
    // Null lastBurnRate AND lastAppliedLRead, exactly as anchorFresh/freshLedger leave them: the next call
    // then takes the reducer's recovering first-frame (re-anchor only, no stale-rate trapezoid → P0-5),
    // and nulling lastAppliedLRead also makes any same-seq robustness re-feed a clean idempotent no-op
    // rather than a spurious folded_call_mutated pause against an L that belonged to the pre-break seq.
    lastBurnRate: null,
    lastAppliedLRead: null,
    pausedReason: null
    // the deadlock break itself
  };
}
function resolveLedgerForKey(persisted, { currentKey, watcherFoldedSeq, watcherTurnSeq, kStableFrozen, lReadNow }) {
  const anchorFresh = () => {
    const s = freshLedger(currentKey, kStableFrozen);
    s.lastAppliedFoldedCallSeq = watcherFoldedSeq;
    s.billAnchorFoldedCallSeq = watcherFoldedSeq;
    s.billAnchorLRead = lReadNow;
    s.billAnchorTurnSeq = watcherTurnSeq;
    s.currentTurnSeq = watcherTurnSeq;
    return s;
  };
  if (!persisted || persisted.stateKey !== currentKey) return anchorFresh();
  if (watcherFoldedSeq < persisted.lastAppliedFoldedCallSeq) {
    const reanchored = reanchorOnMismatch(persisted, { watcherFoldedSeq, watcherTurnSeq, lReadNow });
    return syncLedgerTurn(reanchored, watcherTurnSeq);
  }
  return { ...persisted };
}
function mergeLedgerIntoStatus(status, ledger, currentKey) {
  if (status.rateLamp?.reliable && ledger && ledger.stateKey === currentKey) {
    if (ledger.kStableFrozen > 0 && status.baseline?.total > 0) {
      const { xExit, L_exit_fullCarry } = deriveFrozenExit(
        status.rateLamp.C_RATIO,
        ledger.kStableFrozen,
        status.baseline.total
      );
      status.rateLamp.kStable = ledger.kStableFrozen;
      status.rateLamp.xExit = xExit;
      status.rateLamp.L_exit_fullCarry = L_exit_fullCarry;
    }
    status.rateLamp.billProgress = ledger.billProgress;
    status.rateLamp.billingCycle = { progress: ledger.billProgress };
    status.rateLamp.billCycleCount = ledger.billCycleCount ?? 0;
    const lBase = status.baseline?.total;
    const cRatio = status.rateLamp.C_RATIO;
    if (lBase > 0 && cRatio > 0) {
      const x = status.rateLamp.L_read / lBase;
      status.rateLamp.mf = computeMovableFrac(cRatio, lBase, ledger.kStableFrozen);
      const kS = ledger.kStableFrozen;
      const dhat = kS > 0 ? nucleus(cRatio, kS, lBase) : null;
      status.rateLamp.dhat = dhat;
      const br = dhat > 0 ? computeBr(x, dhat, status.rateLamp.mf) : NaN;
      status.rateLamp.br = br;
      status.rateLamp.inDeepWater = Number.isFinite(br) && br >= BR_AMBER;
      const mfVal = status.rateLamp.mf;
      if (dhat > 0 && mfVal > 0) {
        status.rateLamp.xBrAmberR = xRightFromBr(BR_AMBER, dhat, mfVal);
        status.rateLamp.xBrAmberL = xLeftFromBr(BR_AMBER, dhat, mfVal);
        status.rateLamp.xBrRedR = xRightFromBr(BR_RED, dhat, mfVal);
      }
      status.rateLamp.xSweet = dhat != null ? 1 + dhat : null;
      const kAvg = status.kAvg;
      if (kAvg > 0) {
        const lm = landmarksFor(cRatio, kAvg, lBase, lBase);
        status.rateLamp.xEntry = lm.xEntry;
      }
      status.rateLamp.wallP = 1 + cRatio;
      status.rateLamp.lBase = lBase;
    }
    status.rateLamp.currentTurnSeq = ledger.currentTurnSeq;
    if (ledger.lastBillEvent) status.rateLamp.lastBillEvent = ledger.lastBillEvent;
    if (ledger.lastStopEvent) status.rateLamp.lastStopEvent = ledger.lastStopEvent;
    status.rateLamp.kAvg = status.kAvg ?? null;
    let emaState = _perCallEma.get(currentKey);
    if (!emaState) {
      emaState = { prevL: null, ema: null, callsSinceAnchor: 0, lastSeq: 0 };
      _perCallEma.set(currentKey, emaState);
    }
    const seq = ledger.lastAppliedFoldedCallSeq ?? 0;
    if (seq > emaState.lastSeq) {
      updatePerCallEma(emaState, { L: status.rateLamp.L_read });
      emaState.lastSeq = seq;
    }
    status.rateLamp.gEma = emaState.ema;
  } else {
    status.rateLamp = status.rateLamp || {};
    status.rateLamp.kAvg = null;
    status.rateLamp.dhat = null;
    status.rateLamp.xEntry = null;
  }
  return status;
}
function mutateLedger(ledger, reason, fn) {
  const before = JSON.stringify(ledger);
  const draft = structuredClone(ledger);
  fn(draft);
  const after = JSON.stringify(draft);
  if (after === before) return ledger;
  draft.ledgerRevision = (ledger.ledgerRevision ?? 0) + 1;
  return draft;
}
function hydrateLedger(watcher, sessionId) {
  const live = _ledgers.get(sessionId);
  if (live) return live;
  const disk = loadRateLampState(sessionId);
  if (!disk) return null;
  if (Number.isInteger(disk.currentTurnSeq)) {
    watcher._turnSeq = Math.max(watcher._turnSeq ?? 0, disk.currentTurnSeq);
  }
  const cleaned = { ...disk, lastBillEvent: null, lastStopEvent: null };
  _lastPersistedRevision.set(sessionId, cleaned.ledgerRevision ?? 0);
  _ledgers.set(sessionId, cleaned);
  return cleaned;
}
function settleEndedTurnBoundary(l, { endedTurnSeq, status }) {
  const lReadAtBoundary = Number.isFinite(l.lastAppliedLRead) ? l.lastAppliedLRead : l.billAnchorLRead;
  const seqAtBoundary = l.lastAppliedFoldedCallSeq;
  const lBaseB = status.baseline?.total;
  const cRatioB = Number.isFinite(status.rateLamp?.C_RATIO) ? status.rateLamp.C_RATIO : cRatioFor(status.model);
  const inDeepWaterAtBoundary = (() => {
    if (!(l.kStableFrozen > 0) || !(lBaseB > 0) || !(cRatioB > 0)) return false;
    const mf = computeMovableFrac(cRatioB, lBaseB, l.kStableFrozen);
    const dhat = nucleus(cRatioB, l.kStableFrozen, lBaseB);
    const x = lReadAtBoundary / lBaseB;
    const br = computeBr(x, dhat, mf);
    return Number.isFinite(br) && br >= BR_AMBER;
  })();
  const { state } = settleMeterAtBoundary(l, {
    L_readNow: lReadAtBoundary,
    kStable: l.kStableFrozen,
    foldedSeqNow: seqAtBoundary,
    turnSeqNow: endedTurnSeq + 1,
    endedTurnSeq,
    inDeepWater: inDeepWaterAtBoundary
  });
  Object.assign(l, state);
  l.settledThroughTurnSeq = endedTurnSeq;
  l.currentTurnSeq = endedTurnSeq + 1;
}
function _advanceCore(watcher, sessionId, { doPoll, persist, loopOpts }) {
  if (doPoll) watcher.poll();
  const status = watcher.getStatus();
  const reliableLatched = status.rateLamp?.reliable === true;
  if (!reliableLatched) {
    let ledger2 = hydrateLedger(watcher, sessionId);
    if (ledger2) {
      const reason = status.rateLamp?.unavailableReason || "insufficient_data";
      const seqSamples = watcher.rateLampSeqSamplesSince(ledger2.lastAppliedFoldedCallSeq, { unavailableReason: reason });
      ledger2 = mutateLedger(ledger2, "unreliable-drain", (l) => {
        for (const s of seqSamples) Object.assign(l, applyFoldedCallSample(l, s));
        syncTurnCursorOnDraft(l, watcher._turnSeq);
      });
      _ledgers.set(sessionId, ledger2);
      persist(sessionId, ledger2);
    }
    return { ledger: ledger2 ?? null, status, budgetExhausted: false };
  }
  const currentKey = stateKeyForStatus(status);
  const kStableFrozen = status.rateLamp.kStable ?? 0;
  let ledger = hydrateLedger(watcher, sessionId);
  ledger = resolveLedgerForKey(ledger, {
    currentKey,
    watcherFoldedSeq: watcher._foldedCallSeq,
    watcherTurnSeq: watcher._turnSeq,
    kStableFrozen,
    lReadNow: status.rateLamp.L_read
  });
  const samples = watcher.rateLampSamplesSince(ledger.lastAppliedFoldedCallSeq, {
    B_post: status.rateLamp.B_post,
    B_rebuild: status.rateLamp.B_rebuild,
    cRatio: status.rateLamp.C_RATIO,
    reliable: true
  });
  const startMs = loopOpts ? performance.now() : 0;
  let budgetExhausted = false;
  ledger = mutateLedger(ledger, "advance-events", (l) => {
    for (const s of samples) {
      if (loopOpts && performance.now() - startMs > loopOpts.maxMs) {
        budgetExhausted = true;
        break;
      }
      while (l.currentTurnSeq < s.turnSeq && l.currentTurnSeq > l.settledThroughTurnSeq) {
        settleEndedTurnBoundary(l, { endedTurnSeq: l.currentTurnSeq, status });
      }
      Object.assign(l, applyFoldedCallSample(l, s));
    }
    if (!budgetExhausted) syncTurnCursorOnDraft(l, watcher._turnSeq);
  });
  _ledgers.set(sessionId, ledger);
  persist(sessionId, ledger);
  mergeLedgerIntoStatus(status, ledger, currentKey);
  return { ledger, status, budgetExhausted };
}
function advanceRateLampToCurrent(watcher, sessionId, { forcePoll = false } = {}) {
  const { ledger, status } = _advanceCore(watcher, sessionId, {
    doPoll: forcePoll,
    persist: (sid, _l) => schedulePersist(sid),
    // C5a: write-behind (async); flush re-reads at timer tick
    loopOpts: null
    // no budget cap
  });
  return { ledger, status, bill: null };
}
function boundedIncrementalAdvance(watcher, sessionId, { maxMs = STOP_ADVANCE_MAX_MS, maxBytes = STOP_ADVANCE_MAX_BYTES } = {}) {
  _counters.stopAdvanceAttemptCount++;
  const { status, budgetExhausted } = _advanceCore(watcher, sessionId, {
    doPoll: true,
    // always poll (single-read architecture)
    persist: (sid, l) => persistLedger(sid, l),
    // synchronous persist
    loopOpts: { maxMs }
  });
  if (budgetExhausted) _counters.stopAdvanceTimeoutCount++;
  else _counters.stopAdvanceCaughtUpCount++;
  return { caughtUp: !budgetExhausted, status };
}
function getLiveLedger(sessionId) {
  const ledger = _ledgers.get(sessionId) ?? null;
  if (ledger) _ledgerLastAccess.set(sessionId, _nowMono());
  return ledger;
}
function setLiveLedger(sessionId, ledger) {
  _ledgers.set(sessionId, ledger);
  _ledgerLastAccess.set(sessionId, _nowMono());
  persistLedger(sessionId, ledger, { force: true });
  if (_enospcPaused.has(sessionId)) {
    clearEnospcPause(sessionId);
  }
}
function commitLedgerMutationSync(sessionId, reason, fn) {
  const current = _ledgers.get(sessionId);
  const draft = mutateLedger(current, reason, fn);
  if (draft === current) return current;
  const validated = validateLedgerState(draft);
  if (!validated) throw new Error(`commitLedgerMutationSync: validateLedgerState rejected draft (reason: ${reason})`);
  cancelCoalescedPersist(sessionId);
  persistLedger(sessionId, validated, { force: true });
  _ledgers.set(sessionId, validated);
  return validated;
}
var processNonce = performance.now();
function drainPendingStopEvaluations(sessionId) {
  const ledger = _ledgers.get(sessionId);
  if (!ledger) return;
  commitLedgerMutationSync(sessionId, "drain-pending-stop", (draft) => {
    const nowMono = _nowMono();
    const nowWall = Date.now();
    const ttlExpired = expirePending(draft, { nowMono, nowWall, processNonce });
    const { assigned, remainingPending, expired: matchExpired } = matchPendingToSummary(draft);
    _counters.pendingDrainedCount += assigned.length;
    _counters.pendingExpiredCount += ttlExpired.length + (matchExpired?.length || 0);
    const summaries = draft.settledTurnSummaries || [];
    let alertCursor = draft.alertEvaluatedThroughTurnSeq || 0;
    for (const a of assigned) {
      const summary = summaries.find((s) => s.turnSeq === a.summaryTurnSeq);
      if (!summary) continue;
      const resolved = resolveStopMessageFromSummary(summary);
      if (resolved && resolved.delivery === "stop_hook") {
        const stopEvt = { kind: resolved.kind, delivery: resolved.delivery, message: resolved.message, billCount: resolved.billCount ?? 0, turnSeq: a.summaryTurnSeq };
        draft.lastStopEvent = stopEvt;
        pushStopEventRing(draft, stopEvt);
      }
      alertCursor = Math.max(alertCursor, a.summaryTurnSeq);
    }
    draft.alertEvaluatedThroughTurnSeq = alertCursor;
    draft.pendingStopEvaluations = remainingPending;
  });
}
function getDebugCounters() {
  return { ..._counters };
}
function incrementCounter(name) {
  if (name in _counters) _counters[name]++;
}
function flushAll() {
  for (const [sid, l] of _ledgers) {
    try {
      saveRateLampState(sid, l);
    } catch {
    }
  }
}

// lib/notify-gate.js
function fresh(segment) {
  return { segment, turnSeq: 0, maxTierFired: 0, pendingCount: 0 };
}
function messageFor(tier) {
  if (tier === 2) return "Session Watcher: far past the full-carry exit (+1\u0394). Consider a restart/compact at the next natural boundary \u2014 no more alerts this segment. Ask session-restart-advisor for details.";
  return "Session Watcher: crossed the full-carry cost-optimal exit. Consider restarting at the next natural boundary. Ask session-restart-advisor for details.";
}
var finite = (...xs) => xs.every((v) => Number.isFinite(v));
function rawTierFor(x, fc) {
  const { xStar, dhat } = fc || {};
  if (!Number.isFinite(x) || !Number.isFinite(xStar) || !Number.isFinite(dhat) || dhat <= 0 || xStar <= 0) return 0;
  return x >= xStar + dhat ? 2 : x >= xStar ? 1 : 0;
}
function evaluateGate(snapshot, prevState) {
  let state = !prevState || prevState.segment !== snapshot.segment ? fresh(snapshot.segment) : { ...prevState };
  const done = (notify, tier, reason, message = null) => ({ notify, tier, reason, message, nextState: state });
  if (snapshot.turnSeq <= state.turnSeq) return done(false, 0, "duplicate_turn");
  const advance = () => {
    state.turnSeq = snapshot.turnSeq;
  };
  if (snapshot.reliable === false) {
    advance();
    state.pendingCount = 0;
    return done(false, 0, "not_reliable");
  }
  const fc = snapshot.landmarks?.fullCarry || {};
  const { xStar, dhat } = fc;
  if (!finite(snapshot.x, xStar, dhat) || dhat <= 0 || xStar <= 0) {
    advance();
    state.pendingCount = 0;
    return done(false, 0, "invalid_landmarks");
  }
  const rawTier = rawTierFor(snapshot.x, snapshot.landmarks?.fullCarry);
  if (rawTier <= state.maxTierFired) {
    advance();
    state.pendingCount = 0;
    return done(false, rawTier, "below_or_fired");
  }
  if (rawTier === 1 && state.maxTierFired < 1) {
    state.pendingCount += 1;
    advance();
    if (state.pendingCount < 2) return done(false, 1, "pending_confirm");
  }
  state.maxTierFired = rawTier;
  state.pendingCount = 0;
  advance();
  return done(true, rawTier, "fire", messageFor(rawTier));
}
function validateGateState(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const f of ["segment", "turnSeq", "maxTierFired", "pendingCount"]) {
    if (!Number.isInteger(obj[f]) || obj[f] < 0) return null;
  }
  if (obj.maxTierFired > 2) return null;
  if (obj.pendingCount > 2) return null;
  return obj;
}

// lib/gate-store.js
function loadGateState(sessionId) {
  try {
    const raw = getStore().load(sessionId, "gate");
    if (!raw) return null;
    return validateGateState(raw);
  } catch {
    return null;
  }
}
function saveGateState(sessionId, state) {
  getStore().save(sessionId, "gate", state);
}

// lib/legacy-cleanup.js
import { readdirSync, unlinkSync, rmdirSync, existsSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var LEGACY_DIRS = ["rate-lamp", "rate-lamp-state", "gate", "gate-state", "pricing"];
function cleanupLegacyJson(baseDir) {
  for (const name of LEGACY_DIRS) {
    const dir = join2(baseDir, name);
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        unlinkSync(join2(dir, f));
      } catch {
      }
    }
    try {
      rmdirSync(dir);
    } catch {
    }
  }
}
function defaultBaseDir() {
  return process.env.CLAUDE_PLUGIN_DATA || join2(homedir2(), ".session-watcher");
}

// lib/pricing-store.js
function tryGetStore() {
  try {
    return getStore();
  } catch {
    return null;
  }
}
function validatePricingInput({ readPrice, writePrice }) {
  if (!Number.isFinite(readPrice) || !Number.isFinite(writePrice))
    throw new Error("readPrice and writePrice must be finite numbers");
  if (readPrice <= 0) throw new Error("readPrice must be > 0");
  if (writePrice <= 0) throw new Error("writePrice must be > 0");
  const ratio = writePrice / readPrice;
  if (ratio < 1) throw new Error("ratio (write/read) must be >= 1");
  return ratio;
}
function savePricingOverride(model, { readPrice, writePrice, presetId }) {
  const ratio = validatePricingInput({ readPrice, writePrice });
  const record = { readPrice, writePrice, ratio, savedAt: (/* @__PURE__ */ new Date()).toISOString() };
  if (presetId != null) record.presetId = presetId;
  getStore().saveConfig(`pricing:${model}`, record);
  return record;
}
function loadPricingOverride(model) {
  const store = tryGetStore();
  if (!store) return null;
  const data = store.loadConfig(`pricing:${model}`);
  if (!data) return null;
  if (!Number.isFinite(data.ratio) || data.ratio < 1) return null;
  if (!Number.isFinite(data.readPrice) || data.readPrice <= 0) return null;
  if (!Number.isFinite(data.writePrice) || data.writePrice <= 0) return null;
  return data;
}
function deletePricingOverride(model) {
  getStore().deleteConfig(`pricing:${model}`);
}

// lib/state-reaper.js
import { readdirSync as readdirSync2, statSync, unlinkSync as unlinkSync2, readFileSync } from "node:fs";
import { join as join3 } from "node:path";
var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH";
  }
}
function isLivePortFile(sessionId, portDir) {
  if (!portDir) return false;
  if (!sessionId || /[/\\\0]/.test(sessionId) || sessionId === ".." || sessionId === ".") return false;
  try {
    const p = join3(portDir, `${sessionId}.json`);
    const record = JSON.parse(readFileSync(p, "utf8"));
    return record.pid && isPidAlive(record.pid);
  } catch {
    return false;
  }
}
function sweepStaleState({ maxAgeMs = MAX_AGE_MS, now = Date.now(), portDir = null } = {}) {
  const store = getStore();
  return store.sweep(maxAgeMs, {
    now,
    isLiveSession: portDir ? (sid) => isLivePortFile(sid, portDir) : void 0
  });
}
function sweepStalePortFiles(portDir, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync2(portDir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const p = join3(portDir, f);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > maxAgeMs) {
        try {
          const record = JSON.parse(readFileSync(p, "utf8"));
          if (record.pid && isPidAlive(record.pid)) continue;
        } catch {
        }
        unlinkSync2(p);
        removed++;
      }
    } catch {
    }
  }
  return removed;
}

// lib/statusline-format.js
var tagOf = (model) => {
  const m = model || "";
  return m ? m.match(/opus|sonnet|haiku|deepseek/i)?.[0] || m : "model";
};
var kFmt = (n) => {
  if (!Number.isFinite(n)) return "\u2014";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
};
function renderLamp(br, opts) {
  if (opts?.calibrating) return "\u26AA";
  if (!Number.isFinite(br)) return "\u26AA";
  if (opts?.x != null && opts?.xSweet != null && opts.x < opts.xSweet) {
    if (opts.xBrAmberL != null && opts.x >= opts.xBrAmberL) return "\u{1F7E2}";
    return "\u26AA";
  }
  if (br >= BR_RED) return "\u{1F534}";
  if (br >= BR_AMBER) return "\u{1F7E1}";
  return "\u{1F7E2}";
}
function renderBr(br) {
  if (!Number.isFinite(br) || br < 0) return "b---%";
  const pct = Math.floor(br * 100);
  if (pct > 99) return "b+99%";
  return `b+${String(pct).padStart(2, "0")}%`;
}
function renderMeterV3(billProgress) {
  const bp = Math.min(0.999999, Math.max(0, billProgress ?? 0));
  const pct = Math.floor(bp * 100);
  const filled = Math.floor(bp * 10);
  const bar = "\u2593".repeat(filled) + "\u2591".repeat(10 - filled);
  return `${bar}${(pct + "%").padEnd(3)}`;
}
function renderBillCount(count) {
  const n = Math.min(count ?? 0, 99);
  return `\xD7${n}`.padEnd(3);
}
function renderU(rl) {
  const x = rl?.x_display;
  const dhat = rl?.dhat;
  if (!Number.isFinite(x) || !Number.isFinite(dhat) || dhat <= 0) return "u---";
  const u = (x - 1) / dhat;
  if (!Number.isFinite(u)) return "u---";
  return `u${u.toFixed(1)}`;
}
function renderDelta(gEma, kAvgFallback) {
  const d = Number.isFinite(gEma) && gEma >= 1 ? gEma : Number.isFinite(kAvgFallback) && kAvgFallback >= 1 ? kAvgFallback : null;
  if (d === null) return "\u0394----";
  let val;
  if (d >= 1e3) {
    const k = d / 1e3;
    val = k >= 100 ? `${Math.min(Math.round(k), 999)}k` : `${k.toFixed(1)}k`;
  } else {
    val = String(Math.round(d));
  }
  return `\u0394${val}`.padEnd(5);
}
function renderLB(L, baseline) {
  return `L${kFmt(L)}/b${kFmt(baseline)}`.padEnd(11);
}
function renderAlertLine(rl) {
  const stop = rl?.lastStopEvent;
  if (!stop || stop.turnSeq !== rl.currentTurnSeq) return null;
  return stop.message;
}
var CAROUSEL_FRAMES = ["\u26AA", "\u{1F7E2}", "\u{1F7E1}"];
var _carouselFrame = 2;
var _lastFrameTime = -Infinity;
function getCarouselLamp(now) {
  if (now - _lastFrameTime >= 2e3) {
    _lastFrameTime = now;
    _carouselFrame = (_carouselFrame + 1) % CAROUSEL_FRAMES.length;
  }
  return CAROUSEL_FRAMES[_carouselFrame];
}
function renderCalibratingV3(s, gate, { now } = {}) {
  const timestamp = now ?? Date.now();
  const tag = tagOf(s.model);
  if (gate.hardUnavailable || gate.reason === "no_transcript") {
    return `\u26A0\uFE0F no transcript found ${tag}`;
  }
  const lamp = getCarouselLamp(timestamp);
  const meter = renderMeterV3(0);
  const bill = renderBillCount(0);
  const countdown = "b---%";
  const u = "u---";
  const delta = Number.isFinite(s.kAvg) ? renderDelta(null, s.kAvg) : "\u0394----";
  const lb = Number.isFinite(s.L) ? renderLB(s.L, s.baseline?.total) : "";
  let line = `${lamp} ${meter} ${bill} \xB7 ${countdown} ${u} \xB7 ${delta} ${lb} \xB7 ${tag}`;
  return line;
}
var _wasCalibrating = true;
var _prevTurnSeq = null;
var _baseBillCount = 0;
function perTurnBillCount(currentTurnSeq, billCycleCount) {
  if (_prevTurnSeq === null) {
    _prevTurnSeq = currentTurnSeq;
    _baseBillCount = billCycleCount;
    return 0;
  }
  if (currentTurnSeq !== _prevTurnSeq) {
    _prevTurnSeq = currentTurnSeq;
    _baseBillCount = billCycleCount;
    return 0;
  }
  if (billCycleCount < _baseBillCount) {
    _baseBillCount = billCycleCount;
    return 0;
  }
  return billCycleCount - _baseBillCount;
}
function renderReliability(s) {
  const cr = s.calibratingReason ?? null;
  return {
    hardUnavailable: cr === "no_transcript",
    reason: cr
  };
}
function formatLine(s) {
  const gate = renderReliability(s);
  if (gate.hardUnavailable) {
    _wasCalibrating = true;
    return renderCalibratingV3(s, gate, { now: Date.now() });
  }
  if (gate.reason != null) {
    _wasCalibrating = true;
    return renderCalibratingV3(s, gate, { now: Date.now() });
  }
  if (!s.rateLamp?.reliable) {
    _wasCalibrating = true;
    return renderCalibratingV3(s, gate, { now: Date.now() });
  }
  if (_wasCalibrating) {
    _wasCalibrating = false;
  }
  const rl = s.rateLamp;
  const lamp = renderLamp(rl.br, { calibrating: !rl.reliable, x: rl.x_display, xSweet: rl.xSweet, xBrAmberL: rl.xBrAmberL });
  const meter = renderMeterV3(rl.billProgress);
  const turnBill = perTurnBillCount(rl.currentTurnSeq, rl.billCycleCount ?? 0);
  const bill = renderBillCount(turnBill);
  const br = renderBr(rl.br);
  const u = renderU(rl);
  const delta = renderDelta(rl.gEma, s.kAvg);
  const lb = renderLB(s.L, s.baseline?.total);
  const tag = tagOf(s.model);
  let line = `${lamp} ${meter} ${bill} \xB7 ${br} ${u} \xB7 ${delta} ${lb} \xB7 ${tag}`;
  const alertMsg = renderAlertLine(rl);
  if (alertMsg) {
    line += `
\u21BB ${alertMsg}`;
  }
  return line;
}

// server.js
var [_major, _minor] = process.versions.node.split(".").map(Number);
if (_major < 22 || _major === 22 && _minor < 16) {
  console.error("Session Watcher requires Node >=22.16.0 (node:sqlite)");
  process.exit(1);
}
var __dirname = dirname2(fileURLToPath(import.meta.url));
function safeSessionId(sessionId) {
  const s = String(sessionId ?? "");
  if (!s || s === "." || s === ".." || /[/\\\0]/.test(s) || s.includes("..")) return "__invalid_session__";
  return s;
}
var PORT_DIR = join4(homedir3(), ".session-watcher");
var stateFileFor = (sessionId) => join4(PORT_DIR, `${safeSessionId(sessionId || "default")}.json`);
function writeStateFileExclusive(path, record) {
  const fd = openSync2(path, "wx");
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync2(fd);
  }
}
function resolveJsonl(target) {
  let targetStat;
  try {
    targetStat = statSync2(target);
  } catch {
    return target;
  }
  if (!targetStat.isDirectory()) return target;
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const e of readdirSync3(dir, { withFileTypes: true })) {
      const p = join4(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl")) found.push(p);
    }
  };
  try {
    walk(target, 0);
  } catch {
  }
  const decorated = found.map((p) => {
    let mtime = -Infinity;
    try {
      mtime = statSync2(p).mtimeMs;
    } catch {
    }
    return { p, mtime };
  }).filter((d) => d.mtime !== -Infinity);
  decorated.sort((a, b) => b.mtime - a.mtime);
  return decorated.length ? decorated[0].p : target;
}
function resolveBySessionId(projectsRoot, sessionId) {
  if (!sessionId || sessionId === "default") return null;
  const wanted = `${sessionId}.jsonl`;
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync3(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join4(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === wanted) hits.push(p);
    }
  };
  walk(projectsRoot, 0);
  return hits.length ? hits[0] : null;
}
var _globalTestClockMono = null;
var _idleEnv = Number(process.env.SW_IDLE_TTL_MS);
var IDLE_SHUTDOWN_MS = Number.isFinite(_idleEnv) ? _idleEnv : 24 * 60 * 60 * 1e3;
function shouldIdleShutdown({ sseClientsSize, lastRequestMono, now }) {
  return sseClientsSize === 0 && now - lastRequestMono > IDLE_SHUTDOWN_MS;
}
function createServer({ watcher, pollIntervalMs = 1e3, sessionId, onIdleShutdown = null }) {
  const app = express();
  const startMs = Date.now();
  const sseClients = /* @__PURE__ */ new Set();
  const server = createHttpServer(app);
  let lastRequestMono = performance.now();
  app.use((req, res, next) => {
    lastRequestMono = performance.now();
    next();
  });
  try {
    watcher.poll();
  } catch {
  }
  app.get("/api/health", (req, res) => {
    res.json({ ok: true, port: server.address()?.port ?? null, uptime: Math.floor((Date.now() - startMs) / 1e3), pid: process.pid, startedAt: startMs });
  });
  const parseFitWindow = (q) => {
    const n = parseInt(q, 10);
    return [10, 20, 40].includes(n) ? n : void 0;
  };
  app.get("/api/status", (req, res, next) => {
    try {
      const status = watcher.getStatus(parseFitWindow(req.query.fitWindow));
      const currentKey = status.rateLamp?.reliable ? stateKeyForStatus(status) : null;
      const ledger = getLiveLedger(sessionId);
      mergeLedgerIntoStatus(status, ledger, currentKey);
      if (req.query.debug && status.rateLamp?.billingCycle) {
        status.rateLamp.billingCycle.cycleCountInSegment = ledger?.billCycleCount ?? 0;
      }
      if (req.query.fmt === "line") {
        status.port = server.address()?.port ?? null;
        const line = formatLine(status);
        const port = status.port ?? "";
        const url = port ? ` http://127.0.0.1:${port}` : "";
        const firstNewline = line.indexOf("\n");
        if (firstNewline === -1) {
          return res.type("text/plain").send(line + url);
        }
        return res.type("text/plain").send(line.slice(0, firstNewline) + url + line.slice(firstNewline));
      }
      res.json(status);
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/history", (req, res) => {
    let h = watcher.getHistory(parseFitWindow(req.query.fitWindow));
    if (req.query.since) {
      const t = Date.parse(req.query.since);
      if (!Number.isNaN(t)) h = h.filter((p) => Date.parse(p.ts) >= t);
    }
    res.json(h);
  });
  app.get("/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    sseClients.add(res);
    const del = () => sseClients.delete(res);
    req.on("close", del);
    req.on("aborted", del);
    res.on("close", del);
    res.on("error", del);
    if (req.socket) req.socket.setTimeout(3e4, () => req.socket.destroy());
  });
  app.use(express.json({ limit: "4kb" }));
  const cliRatioAtStartup = watcher.ratioOverride;
  const buildPricingResponse = () => {
    const model = watcher._segmentModel || "";
    const saved = loadPricingOverride(model);
    const modelRatio = cRatioFor(model);
    let effectiveRatio, source, effectiveRead = null, effectiveWrite = null;
    if (saved) {
      effectiveRatio = saved.ratio;
      source = "saved";
      effectiveRead = saved.readPrice;
      effectiveWrite = saved.writePrice;
      if (saved.presetId) {
        const preset = MODEL_PRICING_PRESETS.find((p) => p.id === saved.presetId);
        if (preset && preset.readPrice === saved.readPrice && preset.writePrice === saved.writePrice) {
          source = "preset";
        }
      }
    } else if (cliRatioAtStartup != null) {
      effectiveRatio = cliRatioAtStartup;
      source = "cli";
    } else {
      effectiveRatio = modelRatio;
      source = "model_default";
    }
    return {
      effective: { ratio: effectiveRatio, readToWrite: 1 / effectiveRatio, source, readPrice: effectiveRead, writePrice: effectiveWrite },
      saved: saved || null,
      modelDefault: { model, ratio: modelRatio, readPrice: null, writePrice: null },
      presets: MODEL_PRICING_PRESETS
    };
  };
  const applyEffectiveRatio = () => {
    const model = watcher._segmentModel || "";
    const saved = loadPricingOverride(model);
    watcher.ratioOverride = saved ? saved.ratio : cliRatioAtStartup;
    watcher._historyCache = null;
  };
  applyEffectiveRatio();
  app.get("/api/pricing", (req, res) => {
    res.json(buildPricingResponse());
  });
  app.post("/api/pricing", (req, res, next) => {
    try {
      const { readPrice, writePrice } = req.body || {};
      validatePricingInput({ readPrice, writePrice });
    } catch (e) {
      return res.status(400).json({ error: "invalid_input", message: e.message });
    }
    try {
      const { readPrice, writePrice, presetId } = req.body || {};
      const safePresetId = typeof presetId === "string" && presetId.length > 0 && presetId.length <= 80 ? presetId : null;
      const model = watcher._segmentModel || "";
      if (!model) return res.status(409).json({ error: "no_model", message: "Model not yet detected; retry after first API call" });
      savePricingOverride(model, { readPrice, writePrice, presetId: safePresetId });
      applyEffectiveRatio();
      res.json(buildPricingResponse());
    } catch (e) {
      next(e);
    }
  });
  app.delete("/api/pricing", (req, res) => {
    const model = watcher._segmentModel || "";
    if (!model) return res.status(409).json({ error: "no_model", message: "Model not yet detected; retry after first API call" });
    deletePricingOverride(model);
    applyEffectiveRatio();
    res.json(buildPricingResponse());
  });
  const gateSnapshotFor = (turnSeq, st) => {
    const br = st.rateLamp?.br;
    if (st.rateLamp?.reliable === true && Number.isFinite(br)) {
      return {
        segment: st.segment,
        turnSeq,
        reliable: true,
        x: br,
        landmarks: { fullCarry: { xStar: BR_AMBER, dhat: BR_RED - BR_AMBER } }
      };
    }
    const lm = landmarks(st.rateLamp?.C_RATIO ?? cRatioFor(st.model), st.kAvg, st.baseline?.total ?? 0, st.baseline?.dead ?? 0, st.L);
    return {
      segment: st.segment,
      turnSeq,
      reliable: st.rateLamp?.reliable === true,
      x: lm.x,
      landmarks: { fullCarry: { xStar: lm.fullCarry.xStar, dhat: lm.fullCarry.dhat } }
    };
  };
  const sessionMismatch = (req, res) => {
    const bodySid = req.body?.session_id;
    if (bodySid && bodySid !== sessionId) {
      res.status(409).json({ error: "session_mismatch" });
      return true;
    }
    return false;
  };
  let _internalEventSeq = 0;
  const mintInternalEventId = () => `internal-${Date.now()}-${++_internalEventSeq}`;
  app.post("/api/notify-gate", (req, res, next) => {
    try {
      if (sessionMismatch(req, res)) return;
      const hookEventId = req.body?.hook_event_id ?? mintInternalEventId();
      let ledger = getLiveLedger(sessionId);
      if (ledger && alreadyAccepted(hookEventId, ledger)) {
        const snap2 = gateSnapshotFor(watcher._turnSeq, watcher.getStatus());
        const gateResult2 = evaluateGate(snap2, loadGateState(sessionId));
        res.json({
          ok: true,
          notify: false,
          tier: gateResult2?.tier ?? 0,
          kind: null,
          delivery: null,
          message: null,
          gate: { notify: false, tier: gateResult2?.tier ?? 0, reason: "already_accepted" },
          bill: null
        });
        return;
      }
      if (isEnospcPaused(sessionId)) {
        try {
          const currentLedger = getLiveLedger(sessionId);
          if (currentLedger) setLiveLedger(sessionId, currentLedger);
          try {
            if (getLiveLedger(sessionId)) drainPendingStopEvaluations(sessionId);
          } catch (drainErr) {
            engageEnospcPause(sessionId);
            res.status(503).json({ ok: false, degraded: "persist_failed" });
            return;
          }
          res.json({ ok: true, recovered: true, accepted: false });
          return;
        } catch (probeErr) {
          res.status(503).json({ ok: false, degraded: "persist_failed" });
          return;
        }
      }
      const { caughtUp, status: st } = boundedIncrementalAdvance(watcher, sessionId, { maxMs: STOP_ADVANCE_MAX_MS, maxBytes: STOP_ADVANCE_MAX_BYTES });
      try {
        if (getLiveLedger(sessionId)) drainPendingStopEvaluations(sessionId);
      } catch (e) {
        if (process.env.SW_DEBUG) console.error("[rate-lamp] drain throw (non-fatal):", e.message);
      }
      try {
        if (getLiveLedger(sessionId)) commitLedgerMutationSync(sessionId, "choose-current-stop", (draft) => chooseCurrentStopSummary(draft));
      } catch (e) {
        if (process.env.SW_DEBUG) console.error("[rate-lamp] choose throw (non-fatal):", e.message);
      }
      ledger = getLiveLedger(sessionId);
      const snap = gateSnapshotFor(watcher._turnSeq, st);
      const gateResult = evaluateGate(snap, loadGateState(sessionId));
      let dwTurn = 0, stockStep = false;
      const currentKey = st.rateLamp?.reliable ? stateKeyForStatus(st) : null;
      const matchingKeyLedger = st.rateLamp?.reliable && ledger && ledger.stateKey === currentKey;
      if (matchingKeyLedger && ledger.pausedReason == null) {
        dwTurn = st.rateLamp?.inDeepWater ? ledger.currentTurnDeltaW : 0;
        stockStep = detectStockStep(watcher._currentSegmentCalls(), ledger.kStableFrozen, { sinceFoldedSeq: ledger.billAnchorFoldedCallSeq });
      }
      const inlineMsg = resolveStopMessage({ gateResult, bill: null, burnRate: st.rateLamp?.burnRate ?? 0, dwTurn, stockStep });
      const firesInline = inlineMsg && inlineMsg.delivery === "stop_hook" && ["wall", "dw_backstop", "gate"].includes(inlineMsg.kind);
      if (ledger && (ledger.pendingStopEvaluations || []).length >= PENDING_STOP_EVALUATIONS_LIMIT) {
        res.status(503).json({ ok: false, degraded: "pending_backpressure" });
        return;
      }
      cancelCoalescedPersist(sessionId);
      try {
        if (ledger && validateLedgerState(ledger)) {
          commitLedgerMutationSync(sessionId, "stop-enqueue", (draft) => {
            appendProcessedHookId(draft, hookEventId);
            enqueuePending(draft, {
              hookEventId,
              requestedAtWallMs: Date.now(),
              requestedAtMonoMs: performance.now(),
              processNonce,
              beforeSettledThroughTurnSeq: draft.settledThroughTurnSeq
            });
            incrementCounter("pendingCreatedCount");
            if (firesInline) {
              const stopEvt = { kind: inlineMsg.kind, delivery: inlineMsg.delivery, message: inlineMsg.message, billCount: inlineMsg.billCount ?? 0, turnSeq: draft.currentTurnSeq };
              draft.lastStopEvent = stopEvt;
              pushStopEventRing(draft, stopEvt);
              draft.alertEvaluatedThroughTurnSeq = Math.max(draft.currentTurnSeq, draft.alertEvaluatedThroughTurnSeq || 0);
            }
          });
        }
      } catch (writeErr) {
        res.status(503).json({ ok: false, degraded: "persist_failed" });
        return;
      }
      saveGateState(sessionId, gateResult.nextState);
      res.json({
        ok: true,
        notify: firesInline === true,
        tier: gateResult?.tier ?? 0,
        kind: inlineMsg?.kind ?? null,
        delivery: inlineMsg?.delivery ?? null,
        message: firesInline ? inlineMsg.message : null,
        gate: { notify: gateResult.notify, tier: gateResult.tier, reason: gateResult.reason },
        bill: null
        // H-A: Stop settles NOTHING — no bill
      });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/notify-gate/peek", (req, res, next) => {
    try {
      const st = watcher.getStatus();
      const snap = gateSnapshotFor(watcher._turnSeq, st);
      const prev = loadGateState(sessionId);
      const rawTier = rawTierFor(snap.x, snap.landmarks.fullCarry);
      res.json({ rawTier, maxTierFired: prev?.maxTierFired ?? 0, reliable: snap.reliable });
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/debug/rate-lamp/:sid", (req, res) => {
    const remote = req.socket.remoteAddress || "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback && !process.env.SW_DEBUG) {
      res.status(403).json({ error: "forbidden", reason: "non-loopback without SW_DEBUG" });
      return;
    }
    const sid = req.params.sid;
    const ledger = getLiveLedger(sid);
    const counters = getDebugCounters();
    const sizes = {
      pendingStopEvaluations: (ledger?.pendingStopEvaluations || []).length,
      settledTurnSummaries: (ledger?.settledTurnSummaries || []).length,
      recentStopEvents: (ledger?.recentStopEvents || []).length
    };
    res.json({ ledger, counters, sizes, enospcPaused: isEnospcPaused(sid) });
  });
  app.use(express.static(join4(__dirname, "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-cache");
    }
  }));
  app.get("/", (req, res) => res.sendFile(join4(__dirname, "public", "index.html")));
  app.use((err, req, res, next) => {
    if (process.env.SW_DEBUG) console.error("[route error]", err);
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ error: status === 413 ? "payload_too_large" : status === 400 ? "bad_request" : "internal" });
  });
  let pollTimer = null;
  let lastAdvanceMono = -Infinity;
  const _nowMono2 = () => _globalTestClockMono != null ? _globalTestClockMono : performance.now();
  function startPolling() {
    if (pollIntervalMs <= 0) return;
    pollTimer = setInterval(() => {
      const now = _nowMono2();
      if (sseClients.size === 0 && now - lastAdvanceMono < IDLE_HEARTBEAT_MS) {
        return;
      }
      try {
        const { changed } = watcher.poll();
        lastAdvanceMono = _nowMono2();
        const { ledger } = advanceRateLampToCurrent(watcher, sessionId, { forcePoll: false });
        if (process.env.SW_DEBUG && ledger) console.error("[rate-lamp shadow]", JSON.stringify({ billProgress: ledger.billProgress, cycles: ledger.billCycleCount, paused: ledger.pausedReason, applied: ledger.lastAppliedFoldedCallSeq }));
        if (sseClients.size > 0) {
          const tick = JSON.stringify({ type: "tick", uptime: watcher._uptimeSec() });
          for (const c of sseClients) {
            try {
              c.write(`data: ${tick}

`);
            } catch {
              sseClients.delete(c);
            }
          }
        }
        if (changed) for (const c of sseClients) {
          try {
            c.write(`data: ${JSON.stringify({ type: "scan" })}

`);
          } catch {
            sseClients.delete(c);
          }
        }
        if (onIdleShutdown && shouldIdleShutdown({ sseClientsSize: sseClients.size, lastRequestMono, now: performance.now() })) {
          onIdleShutdown();
        }
      } catch (e) {
        if (process.env.SW_DEBUG) console.error("[poll]", e);
      }
    }, pollIntervalMs);
    pollTimer.unref?.();
  }
  const pingTimer = setInterval(() => {
    for (const c of sseClients) {
      try {
        c.write(": ping\n\n");
      } catch {
        sseClients.delete(c);
      }
    }
  }, 15e3);
  pingTimer.unref?.();
  return { app, server, sseClients, startPolling, startedAt: startMs, applyEffectiveRatio, stopTimers: () => {
    clearInterval(pollTimer);
    clearInterval(pingTimer);
  } };
}
function _inspectSseClientsForTest(serverHandle) {
  return serverHandle.sseClients.size;
}
function _setServerTestClock(nowMono) {
  _globalTestClockMono = nowMono;
}
function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const warnings = [];
  const lbaseRaw = get("--lbase");
  let lbase = null;
  if (lbaseRaw != null) {
    const n = parseInt(lbaseRaw, 10);
    if (Number.isFinite(n) && n >= 0) lbase = n;
    else warnings.push(`ignoring invalid --lbase ${JSON.stringify(lbaseRaw)} (must be >= 0; using auto baseline)`);
  }
  const ratioRaw = get("--ratio");
  let ratioOverride = null;
  if (ratioRaw != null) {
    const n = parseFloat(ratioRaw);
    if (Number.isFinite(n) && n > 0) ratioOverride = n;
    else warnings.push(`ignoring invalid --ratio ${JSON.stringify(ratioRaw)} (must be a number > 0; using model default)`);
  }
  const portRaw = get("--port");
  let wantPort = 0;
  if (portRaw != null) {
    const n = parseInt(portRaw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 65535) wantPort = n;
    else warnings.push(`ignoring invalid --port ${JSON.stringify(portRaw)} (using ephemeral port 0)`);
  }
  return {
    transcript: get("--transcript"),
    project: get("--project"),
    session: get("--session"),
    lbase,
    ratioOverride,
    wantPort,
    open: argv.includes("--open"),
    warnings
  };
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const { transcript, project, session, lbase, ratioOverride, wantPort, open, warnings } = parseArgs(argv);
  for (const w of warnings) console.error(`session-watcher: ${w}`);
  const projectsRoot = join4(homedir3(), ".claude", "projects");
  const byId = resolveBySessionId(projectsRoot, session);
  const jsonlPath = transcript ? resolve(transcript) : byId || resolveJsonl(resolve(project || projectsRoot));
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, "") || session;
  const watcher = new SessionWatcher(jsonlPath, lbase, { ratioOverride });
  const STATE_FILE = stateFileFor(sessionId);
  let shutdown;
  const { server, startPolling, sseClients, stopTimers, startedAt, applyEffectiveRatio } = createServer({ watcher, pollIntervalMs: 1e3, sessionId, onIdleShutdown: () => shutdown() });
  server.listen(wantPort, "127.0.0.1", () => {
    const port = server.address().port;
    mkdirSync2(PORT_DIR, { recursive: true });
    try {
      initStore();
    } catch (e) {
      console.error("[session-watcher] fatal: store init failed \u2014", e.message);
      process.exit(1);
    }
    cleanupLegacyJson(defaultBaseDir());
    applyEffectiveRatio();
    try {
      writeStateFileExclusive(STATE_FILE, { port, pid: process.pid, transcriptPath: jsonlPath, sessionId, startedAt });
    } catch (e) {
      if (e.code === "EEXIST") {
        console.error(
          `session-watcher: ${sessionId} already owned \u2014 refusing to start. If no live owner (e.g. a prior crash left a stale file), restart via the normal startWatcher entry (it health-probes and auto-clears a dead-port state file), or manually delete ${STATE_FILE}.`
        );
        process.exit(1);
      }
      throw e;
    }
    console.log(`PORT=${port}`);
    sweepStaleState({ portDir: PORT_DIR });
    sweepStalePortFiles(PORT_DIR);
    startPolling();
    if (open && !process.env.SW_NO_OPEN) {
      import("node:child_process").then(({ spawn }) => {
        const cmd = process.env.BROWSER || (process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open");
        const opener = spawn(cmd, [`http://127.0.0.1:${port}`], { detached: true, stdio: "ignore" });
        opener.on("error", () => {
        });
        opener.unref();
      }).catch(() => {
      });
    }
  });
  shutdown = function shutdown2() {
    stopTimers();
    for (const c of sseClients) {
      try {
        c.end();
      } catch {
      }
    }
    try {
      flushAll();
    } catch {
    }
    closeStoreGlobal();
    try {
      unlinkSync3(STATE_FILE);
    } catch {
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2e3).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("uncaughtException", (e) => {
    if (process.env.SW_DEBUG) console.error("[uncaught]", e);
  });
  process.on("unhandledRejection", (e) => {
    if (process.env.SW_DEBUG) console.error("[unhandled]", e);
  });
}
export {
  IDLE_SHUTDOWN_MS,
  PORT_DIR,
  _inspectSseClientsForTest,
  _setServerTestClock,
  createServer,
  formatLine,
  parseArgs,
  resolveBySessionId,
  resolveJsonl,
  shouldIdleShutdown,
  stateFileFor,
  writeStateFileExclusive
};
