import {
  ALPHA_EMA, G_DELTA_CAP, G_FLOOR, RESERVED_OUTPUT, CTX_SAFETY_MARGIN,
} from '../constants.js';
import { classifyMiss } from '../l-measure.js';
import { settleDeferred } from '../settle.js';
import { nucleus } from '../landmarks.js';
import { computeMovableFrac, computeBr, computePp, isInDeepWater, BR_AMBER } from '../bill-regret.js';
import { computeFullCarryBurnRate } from '../rate-lamp.js';
import { createResidentLedger, resourceTokensOf } from './resident-ledger.js';

// Portable Measurement Engine: calls, turns, epochs, resident content, resource overrides, residuals,
// g estimation, named reads, and model-neutral segment closure. It consumes only the MeasurementRecord
// discriminants and opaque model identity, so its dependency closure holds no Node built-in, no I/O, no
// persistence, no HTTP, and nothing a Harness owns. Model and resource policy arrive as injected
// resolvers; both run after an accepted core transition and cannot roll one back.

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Settlement works in fractional token estimates, so the surplus/attribution comparison needs a floor
// below which a difference is float dust rather than unattributed resident growth.
const SETTLEMENT_EPSILON = 1e-6;

function invariant(ok, message) {
  if (!ok) throw new Error(`measurement engine invariant: ${message}`);
}

function isTokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// g's smoothing step. β = 0 by construction: the output is a convex combination of prevG and the input,
// so g can never leave the range of its inputs — no trend momentum to overshoot a settling burst and
// drive g below the arrival rate it tracks. G_DELTA_CAP bounds |Δg| per call, which suppresses the
// one-off spikes a level filter alone would forecast forward.
function emaStep(prevG, gInput) {
  const level = ALPHA_EMA * gInput + (1 - ALPHA_EMA) * prevG;
  return Math.max(prevG - G_DELTA_CAP, Math.min(prevG + G_DELTA_CAP, level));
}

// Every measurement read applies the same floor: it prevents a dhat division by zero and gives cold start
// its silence.
function effectiveG(gEma) {
  return Math.max(Number.isFinite(gEma) ? gEma : G_FLOOR, G_FLOOR);
}

// The br-family read, shared by every named read and by segment finalization so a closed segment's exit
// values are the same quantities the live reads showed. `bDefault` is the position basis; it falls back to
// the full belief when every resource is excluded.
function deriveQuantities({ L, bFull, bDefault, cRatio, g }) {
  const baselineValid = bFull > 0 && cRatio > 0;
  const bPos = bDefault > 0 ? bDefault : bFull;
  const x = baselineValid ? L / bPos : 1;
  const dhat = baselineValid ? nucleus(cRatio, g, bPos) : null;
  const xSweet = dhat != null ? 1 + dhat : null;
  const burnRate = baselineValid
    ? computeFullCarryBurnRate({ L_read: L, B_post: bPos, B_rebuild: bPos, cRatio })
    : null;
  const mf = baselineValid ? computeMovableFrac(cRatio, bPos, g) : null;
  const br = (dhat > 0 && Number.isFinite(mf)) ? computeBr(x, dhat, mf) : null;
  return { baselineValid, bPos, x, dhat, xSweet, burnRate, mf, br };
}

function diagnostic(code, message) {
  return { scope: 'measurement-engine', code, message };
}

export function createMeasurementEngine({ resolveModelPolicy, resolveResourcePolicy } = {}) {
  invariant(typeof resolveModelPolicy === 'function', 'resolveModelPolicy must be a function');
  invariant(typeof resolveResourcePolicy === 'function', 'resolveResourcePolicy must be a function');

  // Process-local authorities: they survive every epoch in this Engine's lifetime.
  let segmentSeq = 0;
  let turnSeq = 0;
  let pendingTurn = false;
  let foldedSeq = 0;
  let calls = [];

  // Current-epoch authorities.
  let epochModel = null;
  let latestMeasuredModel = null;
  let epochPolicy = null;
  let stepsById = new Map();
  let segmentSteps = [];
  let pendingResiduals = [];
  let gEma = null;
  let ledger = createResidentLedger();
  let dead = 0;
  let sessionFloor = 0;
  // The previous accepted new step's L, total stock, and uncapped resident total. It exists only from the
  // first positive-stock step of the epoch, which is also what anchors `dead` and `sessionFloor`.
  let settlementCursor = null;
  let deferred = { total: 0, byPath: new Map() };
  let resourceGrowth = new Map();
  let resourceOverrides = new Map();
  let resourcePolicyByKey = new Map();

  // Segment accumulators and extrema. Anything derivable from these is derived at close, not stored.
  let segmentStartTurn = 0;
  let segmentOutputSum = 0;
  let segmentUsageCount = 0;
  let segmentInputSum = 0;
  let segmentFirstTs = null;
  let segmentLastTs = null;
  let segmentLPeak = 0;
  let segmentBrPeak = 0;
  let segmentPpPeak = 0;
  let segmentGMin = Infinity;
  let segmentTurnAtBrAmber = null;

  function openFreshSegment() {
    segmentSeq += 1;
    epochModel = null;
    latestMeasuredModel = null;
    epochPolicy = null;
    stepsById = new Map();
    segmentSteps = [];
    pendingResiduals = [];
    gEma = G_FLOOR;
    ledger = createResidentLedger();
    dead = 0;
    sessionFloor = 0;
    settlementCursor = null;
    deferred = { total: 0, byPath: new Map() };
    resourceGrowth = new Map();
    resourceOverrides = new Map();
    resourcePolicyByKey = new Map();
    segmentStartTurn = turnSeq;
    segmentOutputSum = 0;
    segmentUsageCount = 0;
    segmentInputSum = 0;
    segmentFirstTs = null;
    segmentLastTs = null;
    segmentLPeak = 0;
    segmentBrPeak = 0;
    segmentPpPeak = 0;
    segmentGMin = Infinity;
    segmentTurnAtBrAmber = null;
  }

  // ── Policy resolution ──────────────────────────────────────────────────────

  function readModelPolicy(raw) {
    if (raw === null || typeof raw !== 'object') return null;
    const { cRatio, contextCapacity } = raw;
    if (!(typeof cRatio === 'number' && Number.isFinite(cRatio) && cRatio > 0)) return null;
    if (!(typeof contextCapacity === 'number' && Number.isFinite(contextCapacity) && contextCapacity > 0)) return null;
    return { cRatio, contextCapacity };
  }

  // Resolves the epoch model's policy once per epoch and on refresh. An unusable result falls back to the
  // resolver's own default policy — the composition owns every value, so the Engine asks the same resolver
  // rather than carrying a second table. A default that is also unusable leaves the reads unreliable.
  function resolveEpochPolicy(modelId, diagnostics) {
    let raw = null;
    try {
      raw = resolveModelPolicy(modelId);
    } catch (error) {
      diagnostics.push(diagnostic('model_policy_failed', `model policy resolver threw: ${error.message}`));
    }
    const policy = readModelPolicy(raw);
    if (policy) return policy;
    diagnostics.push(diagnostic('model_policy_invalid',
      `model policy for ${String(modelId)} is unusable; falling back to the resolver default`));
    let fallback = null;
    try {
      fallback = readModelPolicy(resolveModelPolicy(null));
    } catch (error) {
      diagnostics.push(diagnostic('model_policy_failed', `default model policy resolver threw: ${error.message}`));
    }
    return fallback;
  }

  function resolveResourceEntry(resourceKey, diagnostics) {
    let raw = null;
    try {
      raw = resolveResourcePolicy(resourceKey);
    } catch (error) {
      diagnostics.push(diagnostic('resource_policy_failed', `resource policy resolver threw: ${error.message}`));
    }
    if (raw === null || typeof raw !== 'object' || typeof raw.selectedByDefault !== 'boolean') {
      diagnostics.push(diagnostic('resource_policy_invalid',
        `resource policy for ${String(resourceKey)} is unusable; defaulting to selected`));
      return { selectedByDefault: true, defaultDiscardReason: null };
    }
    const reason = raw.defaultDiscardReason;
    return {
      selectedByDefault: raw.selectedByDefault,
      defaultDiscardReason: (typeof reason === 'string' && reason.length > 0) ? reason : null,
    };
  }

  // Every policy input a named read can show: the two model values, plus each resource's selection and
  // discard reason. A refresh that leaves this unchanged changes no read.
  function policySignature() {
    const parts = [epochPolicy ? epochPolicy.cRatio : null, epochPolicy ? epochPolicy.contextCapacity : null];
    for (const [resourceKey, entry] of resourcePolicyByKey) {
      parts.push(resourceKey, entry.selectedByDefault, entry.defaultDiscardReason);
    }
    for (const [resourceKey, value] of resourceOverrides) parts.push(resourceKey, value);
    return JSON.stringify(parts);
  }

  function isSelected(resourceKey) {
    const override = resourceOverrides.get(resourceKey);
    if (override === 'include') return true;
    if (override === 'exclude') return false;
    const entry = resourcePolicyByKey.get(resourceKey);
    return entry ? entry.selectedByDefault : true;
  }

  function bDefaultOf(totals) {
    let sum = dead;
    for (const { resourceKey, tokens } of totals) if (isSelected(resourceKey)) sum += tokens;
    return sum;
  }

  function residentTotalOf(totals) {
    let sum = dead;
    for (const { tokens } of totals) sum += tokens;
    return sum;
  }

  // ── Record ingest ──────────────────────────────────────────────────────────

  function readUsage(raw) {
    invariant(raw !== null && typeof raw === 'object', 'step usage must be an object');
    for (const key of USAGE_KEYS) {
      invariant(isTokenCount(raw[key]), `step usage ${key} must be a non-negative finite number`);
    }
    return { input: raw.input, output: raw.output, cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite };
  }

  function readTimestamp(raw) {
    if (raw === undefined || raw === null) return null;
    invariant(typeof raw === 'number' && Number.isFinite(raw), 'step timestamp must be a finite number or null');
    return raw;
  }

  function ingestResidual(record) {
    invariant(typeof record.groupKey === 'string' && record.groupKey.length > 0,
      'residual groupKey must be a non-empty string');
    invariant(isTokenCount(record.weight), 'residual weight must be a non-negative finite number');
    pendingResiduals.push({
      groupKey: record.groupKey,
      weight: record.weight,
      hadError: record.hadError === true,
      meta: record.meta ?? null,
      turn: turnSeq,
      foldedSeq,
    });
  }

  function ingestEffect(record, result) {
    const applied = ledger.applyEffect(record, { turn: turnSeq, foldedSeq });
    for (const { resourceKey, growth } of applied.positiveResourceDeltas) {
      resourceGrowth.set(resourceKey, (resourceGrowth.get(resourceKey) || 0) + growth);
    }
    for (const resourceKey of applied.newResourceKeys) {
      result.newResourceKeys.push(resourceKey);
      resourcePolicyByKey.set(resourceKey, resolveResourceEntry(resourceKey, result.diagnostics));
    }
    for (const entry of applied.diagnostics) result.diagnostics.push(entry);
  }

  function reviseStep(existing, record, usage, usageTotal, timestamp, result) {
    if (record.model !== undefined && record.model !== existing.model) {
      result.diagnostics.push(diagnostic('step_model_conflict',
        `step ${existing.id} keeps its accepted model ${String(existing.model)}`));
    }
    if (usageTotal < existing.usageTotal) {
      result.diagnostics.push(diagnostic('usage_revision_ignored',
        `step ${existing.id} keeps its higher-total usage`));
      return;
    }
    // Aggregates take the complete signed component delta; the fixed measurement point does not move.
    segmentOutputSum += usage.output - existing.usage.output;
    segmentInputSum += usage.input - existing.usage.input;
    existing.usage = usage;
    existing.usageTotal = usageTotal;
    existing.timestamp = timestamp;
    if (Number.isFinite(timestamp)) segmentLastTs = timestamp;
    result.revisedCalls += 1;
  }

  function settle({ L, totalStock, residentTotal }) {
    const cursor = settlementCursor;
    const deltaResident = residentTotal - cursor.residentTotal;
    let deltaL = L - cursor.L;
    // Warm-up floor: while the cursor's L sits below `sessionFloor`, part of its growth is the session
    // prompt arriving in cacheRead, which the belief already carries as `dead`. Only growth above the
    // floor is new content.
    if (cursor.L < sessionFloor && deltaL > 0) deltaL = Math.max(0, L - sessionFloor);

    // Settle against a copy of the deferred ledger, so the invariant below decides before any state has
    // moved: on a shortfall the ledger, the per-resource delta map, g and the pending residuals are all
    // still what they were, and the record that raised it moved nothing.
    const pathDeltas = resourceGrowth;
    let attributable = 0;
    for (const d of pathDeltas.values()) if (d > 0) attributable += d;
    const trialDeferred = { total: deferred.total, byPath: new Map(deferred.byPath) };
    const settled = settleDeferred(deltaL, deltaResident, pathDeltas, trialDeferred);
    // Every accepted effect contributes each affected resource's positive growth, so what settlement banks
    // this interval is always placeable on the resources that grew. A shortfall means resident content grew
    // through some path that recorded no growth — an internal failure, not a tolerance to absorb.
    const escaped = settled.banked - attributable;
    invariant(escaped <= SETTLEMENT_EPSILON,
      `resident growth of ${escaped} escaped per-resource attribution and cannot be banked`);
    deferred = trialDeferred;
    resourceGrowth = new Map();

    // Both growth readers — g and the residual candidates — take ΔtotalStock − Δresident rather than the
    // settled ΔL: cacheRead only advances when the cache prefix advances, so new content parks in
    // cacheWrite first and ΔcacheRead arrives in blocks. Total stock has no such lag, so the candidates
    // completed in this interval meet the growth this interval produced. Δresident is
    // subtracted because rebuildable growth enters the br family through the belief itself, and charging
    // either reader for it would double-count.
    let deltaStock = totalStock - cursor.totalStock;
    if (cursor.totalStock < sessionFloor && deltaStock > 0) deltaStock = Math.max(0, totalStock - sessionFloor);
    const unplacedGrowth = Math.max(0, deltaStock - deltaResident);
    gEma = emaStep(gEma, unplacedGrowth);

    distributeResidual(unplacedGrowth);
  }

  function distributeResidual(residual) {
    if (pendingResiduals.length === 0) return;
    const candidates = pendingResiduals;
    pendingResiduals = [];
    if (!(residual > 0)) return;   // a zero-growth interval only clears the pending set
    let totalWeight = 0;
    for (const candidate of candidates) totalWeight += candidate.weight;
    for (const candidate of candidates) {
      const tokens = totalWeight > 0
        ? residual * (candidate.weight / totalWeight)
        : residual / candidates.length;
      if (!(tokens > 0)) continue;
      ledger.applyResidualAllocation({
        groupKey: candidate.groupKey,
        tokens,
        turn: candidate.turn,
        foldedSeq: candidate.foldedSeq,
        hadError: candidate.hadError,
        meta: candidate.meta,
      });
    }
  }

  function updateSegmentExtrema(L, residentTotal, bDefault) {
    segmentLPeak = Math.max(segmentLPeak, L);
    const g = effectiveG(gEma);
    segmentGMin = Math.min(segmentGMin, g);
    // The same derivation the named reads use, so an extremum and its exit value are one expression apart.
    // Pre-baseline it yields no br and no pp, which leaves those extrema alone while the L peak still moves.
    const { x, dhat, br } = deriveQuantities({
      L, bFull: residentTotal, bDefault, cRatio: epochPolicy ? epochPolicy.cRatio : 0, g,
    });
    const pp = computePp(x, dhat);
    if (Number.isFinite(br)) {
      segmentBrPeak = Math.max(segmentBrPeak, br);
      if (br >= BR_AMBER && segmentTurnAtBrAmber === null) segmentTurnAtBrAmber = turnSeq - segmentStartTurn;
    }
    if (Number.isFinite(pp)) segmentPpPeak = Math.max(segmentPpPeak, pp);
  }

  function acceptNewStep(record, usage, usageTotal, timestamp, result) {
    const totalStock = usage.input + usage.cacheRead + usage.cacheWrite;
    const model = record.model ?? null;
    const firstOfEpoch = segmentSteps.length === 0;

    // The first positive-stock step of an unanchored epoch fixes the belief floor and the session floor
    // before anything reads the belief: `dead` is part of the resident total the cursor snapshots. On a
    // true cold start cacheRead is 0 while the system prompt arrives as input, so the anchor is the
    // largest bucket, not cacheRead.
    if (settlementCursor === null && totalStock > 0) {
      dead = Math.max(usage.input, usage.cacheRead, usage.cacheWrite);
      sessionFloor = totalStock;
    }

    const totals = ledger.residentTotals();
    const residentTotal = residentTotalOf(totals);

    const miss = settlementCursor !== null && classifyMiss({
      cacheRead: usage.cacheRead,
      totalStock,
      prevL: settlementCursor.L,
      prevTotalStock: settlementCursor.totalStock,
    });
    const L = miss ? totalStock : usage.cacheRead;

    if (settlementCursor !== null) {
      settle({ L, totalStock, residentTotal });
    } else {
      if (gEma === null) gEma = G_FLOOR;
      resourceGrowth = new Map();   // pre-cursor growth belongs to no settlement interval
    }

    if (pendingTurn || turnSeq === 0) { turnSeq += 1; pendingTurn = false; }
    foldedSeq += 1;
    if (firstOfEpoch) {
      epochModel = model;
      epochPolicy = resolveEpochPolicy(model, result.diagnostics);
    }
    latestMeasuredModel = model;

    const step = {
      id: record.id,
      model,
      timestamp,
      usage,
      usageTotal,
      segment: segmentSeq,
      L,
      miss,
      // Read-time cap for the display point: the belief may lead total stock during the cache-warm lag,
      // and the invariant-safe value is what a chart may show. The cursor below keeps the uncapped belief
      // so the next step's Δresident stays correct.
      bAtCall: Math.min(residentTotal, totalStock),
      gAtCall: effectiveG(gEma),
      turn: turnSeq,
      foldedSeq,
    };
    stepsById.set(step.id, step);
    segmentSteps.push(step);
    calls.push(step);

    segmentOutputSum += usage.output;
    segmentUsageCount += 1;
    segmentInputSum += usage.input;
    if (Number.isFinite(timestamp)) {
      if (segmentFirstTs === null) segmentFirstTs = timestamp;
      segmentLastTs = timestamp;
    }
    updateSegmentExtrema(L, residentTotal, bDefaultOf(totals));

    if (totalStock > 0) settlementCursor = { L, totalStock, residentTotal };
    result.newCalls += 1;
  }

  function ingestStep(record, result) {
    invariant(typeof record.id === 'string' && record.id.length > 0, 'step id must be a non-empty string');
    const usage = readUsage(record.usage);
    const timestamp = readTimestamp(record.timestamp);
    let usageTotal = 0;
    for (const key of USAGE_KEYS) usageTotal += usage[key];
    const existing = stepsById.get(record.id);
    if (existing) {
      reviseStep(existing, record, usage, usageTotal, timestamp, result);
      return;
    }
    acceptNewStep(record, usage, usageTotal, timestamp, result);
  }

  function ingest(records) {
    invariant(Array.isArray(records), 'ingest requires an array of records');
    const result = {
      newCalls: 0, revisedCalls: 0, newResourceKeys: [], closedSegments: [], diagnostics: [],
    };
    for (const record of records) {
      invariant(record !== null && typeof record === 'object', 'record must be an object');
      switch (record.type) {
        case 'turn-boundary':
          pendingTurn = true;
          break;
        case 'epoch': {
          const closed = finalizeSegment();
          if (closed) result.closedSegments.push(closed);
          break;
        }
        case 'residual':
          ingestResidual(record);
          break;
        case 'effect':
          ingestEffect(record, result);
          break;
        case 'step':
          ingestStep(record, result);
          break;
        default:
          invariant(false, `unsupported record type: ${String(record.type)}`);
      }
    }
    return result;
  }

  // ── Segment closure ────────────────────────────────────────────────────────

  // The one finalizer behind both `epoch` and `closeCurrentSegment()`. It resolves every correction and
  // derived metric on a detached closing snapshot, so a failure anywhere in it throws before any live
  // state moves and the open segment survives intact.
  function finalizeSegment() {
    if (segmentSteps.length === 0) {
      openFreshSegment();
      return null;
    }
    const closing = ledger.snapshot();
    const corrections = new Map(deferred.byPath);
    const steps = segmentSteps.map(step => ({
      id: step.id, foldedSeq: step.foldedSeq, timestamp: step.timestamp, usage: { ...step.usage },
    }));
    const closingDead = dead;

    // Credit that L never confirmed is a genuine estimate overshoot: correct the resources down by the
    // un-retired per-resource remainder, then read the belief from the corrected totals.
    const paths = [];
    const correctedTotals = [];
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource, corrections.get(resource.resourceKey) || 0);
      if (!(tokens > 0)) continue;
      paths.push({ path: resource.resourceKey, tokens });
      correctedTotals.push({ resourceKey: resource.resourceKey, tokens });
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    let bTotal = closingDead;
    for (const { tokens } of correctedTotals) bTotal += tokens;

    const cRatio = epochPolicy ? epochPolicy.cRatio : null;
    const g = effectiveG(gEma);
    const exitL = segmentSteps[segmentSteps.length - 1].L;
    const q = deriveQuantities({
      L: exitL, bFull: bTotal, bDefault: bDefaultOf(correctedTotals), cRatio: cRatio ?? 0, g,
    });
    const oAvg = segmentUsageCount > 0 ? segmentOutputSum / segmentUsageCount : null;
    const durationMs = (Number.isFinite(segmentFirstTs) && Number.isFinite(segmentLastTs))
      ? segmentLastTs - segmentFirstTs
      : null;

    const closed = {
      segment: segmentSeq,
      epochModel,
      steps,
      metrics: {
        lFloor: closingDead,
        bTotal,
        lPeak: segmentLPeak,
        gFinal: g,
        oAvg,
        cRatio,
        turns: turnSeq - segmentStartTurn,
        durationMs,
        totalTokensRead: Number.isFinite(segmentInputSum) ? segmentInputSum : null,
        mf: q.mf,
        ppExit: computePp(q.x, q.dhat),
        brExit: q.br,
        brPeak: segmentBrPeak,
        ppPeak: segmentPpPeak,
        p0: (cRatio > 0 && g > 0) ? closingDead / (cRatio * g) : null,
        bAxis: (g > 0 && segmentUsageCount > 0) ? 2 * oAvg / g : null,
        xAxis: closingDead > 0 ? segmentLPeak / closingDead : null,
        gMin: Number.isFinite(segmentGMin) ? segmentGMin : null,
        turnAtBrAmber: segmentTurnAtBrAmber,
      },
      paths,
    };
    openFreshSegment();
    return closed;
  }

  function closeCurrentSegment() {
    const closed = finalizeSegment();
    return { closedSegments: closed ? [closed] : [], diagnostics: [] };
  }

  // ── Named reads ────────────────────────────────────────────────────────────

  // One coherent view behind every named read: the same resident totals, the same L, the same g, and the
  // same epoch-model policy.
  function readView() {
    const totals = ledger.residentTotals();
    const residentTotal = residentTotalOf(totals);
    const bDefault = bDefaultOf(totals);
    const lastStep = segmentSteps.length ? segmentSteps[segmentSteps.length - 1] : null;
    const L = lastStep ? lastStep.L : 0;
    const g = effectiveG(gEma);
    const cRatio = epochPolicy ? epochPolicy.cRatio : null;
    // The physical invariant is that the belief is a subset of the stock, so the reported value is capped
    // by the settlement cursor's stock while the buckets keep their full belief. The cap self-releases as
    // total stock catches up.
    const B = settlementCursor ? Math.min(residentTotal, settlementCursor.totalStock) : residentTotal;
    const q = deriveQuantities({ L, bFull: residentTotal, bDefault, cRatio: cRatio ?? 0, g });
    const lCap = epochPolicy ? epochPolicy.contextCapacity - RESERVED_OUTPUT - CTX_SAFETY_MARGIN : null;
    const rateLamp = q.baselineValid
      ? {
        reliable: true, basis: 'fullCarry',
        L_read: L, L_cap: lCap, B_post: B, B_rebuild: B, B_default: bDefault, lBase: B, C_RATIO: cRatio,
        x_display: q.x, burnRate: q.burnRate, hBreak: q.burnRate > 0 ? 1 / q.burnRate : Infinity,
        dhat: q.dhat, xSweet: q.xSweet, mf: q.mf, br: q.br, gEma: g,
        inDeepWater: isInDeepWater(q.x, q.xSweet, q.br),
      }
      // Physical unavailability the Engine can see. Whether the application ever observed a Source is its
      // own fact, so it owns the `no_transcript` case.
      : { reliable: false, unavailableReason: 'insufficient_data' };
    return {
      ...q, L, B, residentTotal, bDefault, g, cRatio, rateLamp,
      totalStock: settlementCursor ? settlementCursor.totalStock : 0,
      usage: lastStep ? { ...lastStep.usage } : null,
    };
  }

  function getStatus() {
    const view = readView();
    return {
      L: view.L, B: view.B, bDefault: view.bDefault, g: view.g,
      x: view.x, dhat: view.dhat, xSweet: view.xSweet, burnRate: view.burnRate,
      mf: view.mf, br: view.br,
      model: epochModel, latestMeasuredModel, cRatio: view.cRatio,
      segment: segmentSeq, apiCalls: segmentSteps.length, turnSeq,
      usage: view.usage, rateLamp: view.rateLamp,
    };
  }

  // A history point is a pure read of one folded step: appending a later step never changes an earlier
  // point.
  function getHistory() {
    return calls.map((step) => {
      const B = Number.isFinite(step.bAtCall) ? step.bAtCall : 0;
      // Total stock, not the fixed L: it is the true context volume of the row, so a parallel-tool
      // plateau or a cacheWrite-less miss does not flatten the curve. A revision moves this point.
      const L = step.usage.input + step.usage.cacheRead + step.usage.cacheWrite;
      return {
        ts: step.timestamp, segment: step.segment, L, B, x: B > 0 ? L / B : 1,
        g: Number.isFinite(step.gAtCall) ? step.gAtCall : 0,
        miss: step.miss === true,
        cacheRead: step.usage.cacheRead, cacheWrite: step.usage.cacheWrite,
        turnSeq: step.turn, foldedSeq: step.foldedSeq,
      };
    });
  }

  function lineNumbersOf(resource) {
    const out = [];
    for (const key of resource.fragments.keys()) if (typeof key === 'number' && Number.isFinite(key)) out.push(key);
    return out.sort((a, b) => a - b);
  }

  function getBucketData() {
    const view = readView();
    const closing = ledger.snapshot();
    const paths = [];
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource);
      if (!(tokens > 0)) continue;
      // Invariant: churn >= 1 and efficiency <= 100. A first observation with no accumulated spend reads
      // as churn exactly one; rounding drift can never push it below.
      const totalSpent = Math.max(tokens, Math.round(resource.accumulatedSpend));
      const entry = resourcePolicyByKey.get(resource.resourceKey);
      paths.push({
        path: resource.resourceKey,
        tokens,
        lastTurn: resource.lastTurn,
        lastCallSeq: resource.lastCallSeq,
        totalSpent,
        churn: totalSpent / tokens,
        efficiency: Math.round(tokens / totalSpent * 100),
        readCount: resource.readCount,
        editCount: resource.editCount,
        touchSeqs: resource.touches,
        pureRereads: resource.pureRereads,
        defaultSelected: entry ? entry.selectedByDefault : true,
        defaultDiscardReason: entry ? entry.defaultDiscardReason : null,
        userOverride: resourceOverrides.get(resource.resourceKey) || null,
        lineNumbers: lineNumbersOf(resource),
        fullSnapshot: resource.fullSnapshot,
      });
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    const residual = closing.residuals.map(group => ({
      groupKey: group.groupKey,
      tokens: group.tokens,
      count: group.count,
      lastTurn: group.lastTurn,
      lastCallSeq: group.lastCallSeq,
      touchSeqs: group.touches,
      meta: group.meta,
    })).sort((a, b) => b.tokens - a.tokens);
    return {
      dead,
      paths,
      residual,
      totalB: view.B,
      totalL: view.L,
      bDefault: view.bDefault,
      // Read off the same cursor stock the residual candidates are drawn from, not off L: the
      // remainder a consumer derives by subtracting the allocated groups from this total then sits
      // on the channel those groups came from, where a cacheRead-channel total would fall short by
      // a tool result the stock already carries.
      totalResidualRaw: view.totalStock - view.B,
      totalResidual: Math.max(0, view.totalStock - view.B),
      currentTurnSeq: turnSeq,
      segment: segmentSeq,
    };
  }

  function getHandoffMeasurement() {
    const view = readView();
    const closing = ledger.snapshot();
    const paths = [];
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource);
      if (!(tokens > 0)) continue;
      paths.push({
        path: resource.resourceKey,
        tokens,
        lastTurn: resource.lastTurn,
        fullSnapshot: resource.fullSnapshot,
        lineNumbers: lineNumbersOf(resource),
      });
    }
    paths.sort((a, b) => b.tokens - a.tokens);
    return {
      segment: segmentSeq,
      turnSeq,
      epochModel,
      measurement: {
        L: view.L, B: view.B, bDefault: view.bDefault, g: view.g, mf: view.mf, br: view.br,
        x: view.x, dhat: view.dhat, cRatio: view.cRatio, dead, sessionFloor,
      },
      paths,
    };
  }

  // One coherent frame for the rate lamp: the same status the named reads show, how far measurement has
  // advanced, and each folded call after `sinceFoldedSeq` with its own burn rate under one basis. Stream
  // continuity is process-local to the application, so no revision counter appears here.
  function readRateLampFrame(sinceFoldedSeq) {
    const view = readView();
    const samples = [];
    for (const step of segmentSteps) {
      if (!(step.foldedSeq > sinceFoldedSeq)) continue;
      const sample = { seq: step.foldedSeq, reliable: view.rateLamp.reliable, turnSeq: step.turn, L_read: step.L };
      if (view.rateLamp.reliable) {
        // Every sample integrates under the same frozen basis, so per-call integration stays exact.
        sample.burnRate = computeFullCarryBurnRate({
          L_read: step.L, B_post: view.bPos, B_rebuild: view.bPos, cRatio: view.cRatio,
        });
      } else {
        sample.unavailableReason = view.rateLamp.unavailableReason;
      }
      samples.push(sample);
    }
    return {
      status: view.rateLamp,
      progress: { segment: segmentSeq, measuredCalls: segmentSteps.length, sinceFoldedSeq },
      samples,
      turnSeq,
      foldedCallSeq: foldedSeq,
    };
  }

  // Whole-set replacement over the current epoch's override set; manual and inferred entries share it.
  // An entry naming a resource the epoch has never seen, or a value outside the pair, is warned and
  // dropped, so `changed` reports the effective set rather than the request.
  function replaceResourceOverrides(overrides) {
    invariant(overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides),
      'resource overrides must be a plain object');
    const warnings = [];
    const known = new Set(ledger.residentTotals().map(total => total.resourceKey));
    const next = new Map();
    for (const [resourceKey, value] of Object.entries(overrides)) {
      if (!resourceKey || !known.has(resourceKey)) {
        warnings.push({ code: 'unknown_resource', resourceKey, value });
        continue;
      }
      if (value !== 'include' && value !== 'exclude') {
        warnings.push({ code: 'invalid_override_value', resourceKey, value });
        continue;
      }
      next.set(resourceKey, value);
    }
    let changed = next.size !== resourceOverrides.size;
    if (!changed) {
      for (const [resourceKey, value] of next) {
        if (resourceOverrides.get(resourceKey) !== value) { changed = true; break; }
      }
    }
    resourceOverrides = next;
    return { changed, warnings, diagnostics: [] };
  }

  function refreshReadPolicies() {
    const diagnostics = [];
    const before = policySignature();
    if (segmentSteps.length > 0) epochPolicy = resolveEpochPolicy(epochModel, diagnostics);
    for (const resourceKey of [...resourcePolicyByKey.keys()]) {
      resourcePolicyByKey.set(resourceKey, resolveResourceEntry(resourceKey, diagnostics));
    }
    return { changed: policySignature() !== before, diagnostics };
  }

  return {
    ingest,
    closeCurrentSegment,
    getStatus,
    getHistory,
    getBucketData,
    getHandoffMeasurement,
    readRateLampFrame,
    replaceResourceOverrides,
    refreshReadPolicies,
  };
}
