import {
  ALPHA_EMA, G_DELTA_CAP, G_FLOOR, RESERVED_OUTPUT, CTX_SAFETY_MARGIN,
} from '../constants.js';
import { classifyMiss } from '../l-measure.js';
import { settleDeferred } from '../settle.js';
import { nucleus } from '../landmarks.js';
import { BR_AMBER, wallPositionFor } from '../bill-regret.js';
import { createPathFold, fitAffine, landmarksOf } from './position.js';
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

// Every read of the smoothed g applies the same floor, so the Δ readout is finite from the first step. The
// position fold and dhat run on the scenario's realized mean growth and never see it.
function effectiveG(gEma) {
  return Math.max(Number.isFinite(gEma) ? gEma : G_FLOOR, G_FLOOR);
}

// The instantaneous read behind `x_display` and the diagnostics `dhat`/`uInst`. `bDefault` is the position
// basis.
function deriveQuantities({ L, bDefault, cRatio, g }) {
  const baselineValid = bDefault > 0 && cRatio > 0;
  const x = baselineValid ? L / bDefault : 1;
  const dhat = baselineValid ? nucleus(cRatio, g, bDefault) : null;
  return { baselineValid, x, dhat };
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
  // The previous accepted new step's L, total stock, uncapped resident total and the per-resource totals
  // behind it. It exists only from the first positive-stock step of the epoch, which is also what anchors
  // `dead` and `sessionFloor`.
  let settlementCursor = null;
  let deferred = { total: 0, byPath: new Map() };
  let resourceGrowth = new Map();
  let resourceOverrides = new Map();
  let resourcePolicyByKey = new Map();
  // Position ledger: one frame per accepted step from the anchoring step on — the interval it closes and the
  // resource totals that changed — and the tokens each frame last recorded per resource so a frame carries
  // only what changed.
  let frames = [];
  let recordedTokens = new Map();
  // The default scenario's live fold, advanced one interval per accepted step. Null while the epoch policy
  // has resolved no positive ratio; Apply and refresh rebuild it over the recorded frames.
  let defaultFold = null;

  // Segment accumulators and extrema. Anything derivable from these is derived at close, not stored.
  let segmentStartTurn = 0;
  let segmentOutputSum = 0;
  let segmentUsageCount = 0;
  let segmentInputSum = 0;
  let segmentFirstTs = null;
  let segmentLastTs = null;
  let segmentLPeak = 0;
  let segmentGMin = Infinity;

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
    frames = [];
    recordedTokens = new Map();
    defaultFold = null;
    segmentStartTurn = turnSeq;
    segmentOutputSum = 0;
    segmentUsageCount = 0;
    segmentInputSum = 0;
    segmentFirstTs = null;
    segmentLastTs = null;
    segmentLPeak = 0;
    segmentGMin = Infinity;
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

  function selectedUnder(overrides, resourceKey) {
    const override = overrides.get(resourceKey);
    if (override === 'include') return true;
    if (override === 'exclude') return false;
    const entry = resourcePolicyByKey.get(resourceKey);
    return entry ? entry.selectedByDefault : true;
  }

  function selectorOf(overrides) {
    return (resourceKey) => selectedUnder(overrides, resourceKey);
  }

  // Reads the live `resourceOverrides` binding per call: a fold carries this by reference across every
  // frame it pushes, and both `openFreshSegment` and `replaceResourceOverrides` rebind the Map rather
  // than mutating it, so a selector closed over one Map would answer from a replaced policy.
  function isSelected(resourceKey) {
    return selectedUnder(resourceOverrides, resourceKey);
  }

  function recordFrame(step, growth) {
    const resourceTokens = new Map();
    const totals = ledger.residentTotals();
    const present = new Set();
    for (const { resourceKey, tokens } of totals) {
      present.add(resourceKey);
      if (recordedTokens.get(resourceKey) === tokens) continue;
      resourceTokens.set(resourceKey, tokens);
      recordedTokens.set(resourceKey, tokens);
    }
    // A resource read down past zero leaves the resident totals entirely, and that departure is itself a
    // change the frame has to carry: recorded as zero, it stops every later fold charging its last value.
    for (const [resourceKey, tokens] of recordedTokens) {
      if (!(tokens > 0) || present.has(resourceKey)) continue;
      resourceTokens.set(resourceKey, 0);
      recordedTokens.set(resourceKey, 0);
    }
    const frame = { seq: step.foldedSeq, L: step.L, growth, resourceTokens };
    frames.push(frame);
    return frame;
  }

  function foldFor(selector) {
    return epochPolicy ? createPathFold({ dead, R: epochPolicy.cRatio, selector }) : null;
  }

  function stampOf(point) {
    return {
      bDefault: point.bDefault, x: point.x, u: point.u, pp: point.pp, mf: point.mf, mfLocal: point.mfLocal, br: point.br,
      deltaW: point.deltaW,
    };
  }

  function scenarioPoints(selector) {
    const fold = foldFor(selector);
    return fold ? { points: frames.map(frame => fold.push(frame)), gBar: fold.rate() } : { points: [], gBar: 0 };
  }

  // The live fold prices the new frame's interval only; the first frame of the segment creates it under the
  // epoch policy in force. A step before the anchor, or a segment whose epoch policy resolved no positive
  // ratio, carries no stamp.
  function stampNewFrame(step, frame) {
    if (frames.length === 1) defaultFold = foldFor(isSelected);
    step.stamp = defaultFold ? stampOf(defaultFold.push(frame)) : null;
  }

  // Every step of the segment takes the default scenario's point of its own seq under the current selector
  // and epoch policy. The rebuilt fold is pushed every recorded frame and then stays as the live fold, so the
  // next accepted step continues from the segment tail.
  function restampSegment() {
    defaultFold = foldFor(isSelected);
    const bySeq = new Map(segmentSteps.map(step => [step.foldedSeq, step]));
    for (const step of segmentSteps) step.stamp = null;
    if (!defaultFold) return;
    for (const frame of frames) bySeq.get(frame.seq).stamp = stampOf(defaultFold.push(frame));
  }

  function stampedPoints() {
    const points = [];
    for (const step of segmentSteps) if (step.stamp) points.push(step.stamp);
    return points;
  }

  // The read-side summary of one scenario's points: the last point's quantities, the whole-trajectory
  // reference and the landmarks it implies. Arm state is read from u_T, never inferred from the pp roots.
  function describeScenario(points) {
    const last = points[points.length - 1];
    // The reference is a current-frame object: every point's excess is read in the last frame's baseline,
    // so a baseline arrival rescales every earlier coordinate by the same factor instead of stepping the
    // frames after it left of the ones before, and the slope stays the segment's dq/du in that unit.
    const relabelled = points.map(p => ({ u: p.u, pp: p.pp, x: 1 + (p.x - 1) * p.bDefault / last.bDefault }));
    const fit = fitAffine(relabelled);
    return {
      u: last.u, pp: last.pp, mf: last.mf, mfLocal: last.mfLocal, br: last.br, bDefault: last.bDefault,
      reference: fit ? { a: fit.a, d: fit.d, provisional: last.u < 1 } : null,
      ...landmarksOf(fit, last.mf),
    };
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

  function settle({ L, totalStock, residentTotal, totals }) {
    const cursor = settlementCursor;
    const deltaResident = residentTotal - cursor.residentTotal;
    // The same delta by resource, for the frame: a scenario fold takes out the growth of the resources it
    // carries and leaves the rest as excess, so the frame has to say which resource grew by how much.
    const resourceDeltas = new Map();
    const present = new Set();
    for (const { resourceKey, tokens } of totals) {
      present.add(resourceKey);
      const delta = tokens - (cursor.resourceTotals.get(resourceKey) ?? 0);
      if (delta !== 0) resourceDeltas.set(resourceKey, delta);
    }
    for (const [resourceKey, tokens] of cursor.resourceTotals) {
      if (!present.has(resourceKey)) resourceDeltas.set(resourceKey, -tokens);
    }
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

    // Every growth reader — the smoothed g, the residual candidates and the frame — takes ΔtotalStock rather
    // than the settled ΔL: cacheRead only advances when the cache prefix advances, so new content parks in
    // cacheWrite first and ΔcacheRead arrives in blocks. Total stock has no such lag, so the candidates
    // completed in this interval meet the growth this interval produced. The smoothed g and the candidates
    // subtract the whole Δresident, because rebuildable growth enters the br family through the belief
    // itself and charging either for it would double-count; the frame carries the stock increment and the
    // per-resource deltas apart, so each scenario's fold subtracts only the resources it carries.
    let deltaStock = totalStock - cursor.totalStock;
    if (cursor.totalStock < sessionFloor && deltaStock > 0) deltaStock = Math.max(0, totalStock - sessionFloor);
    const unplacedGrowth = Math.max(0, deltaStock - deltaResident);
    gEma = emaStep(gEma, unplacedGrowth);

    distributeResidual(unplacedGrowth);
    return { stock: deltaStock, resources: resourceDeltas };
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

  function updateSegmentExtrema(L) {
    segmentLPeak = Math.max(segmentLPeak, L);
    segmentGMin = Math.min(segmentGMin, effectiveG(gEma));
  }

  function acceptNewStep(record, usage, usageTotal, timestamp, result) {
    const totalStock = usage.input + usage.cacheRead + usage.cacheWrite;
    const model = record.model ?? null;
    const firstOfEpoch = segmentSteps.length === 0;

    // The first positive-stock step of an unanchored epoch fixes the belief floor and the session floor
    // before anything reads the belief: `dead` is part of the resident total the cursor snapshots. Everything
    // present at the epoch's first measured call is its rebuild floor — the session prompt however the buckets
    // split it (a cold start carries it as input; a prefix cached across sessions arrives as cacheRead beside
    // the cacheWrite of the rest) and, after a compact, the summary the harness carried over — so a single
    // bucket would leave the other part in q for the whole epoch.
    if (settlementCursor === null && totalStock > 0) {
      dead = totalStock;
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

    let growth = null;
    if (settlementCursor !== null) {
      growth = settle({ L, totalStock, residentTotal, totals });
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
      stamp: null,
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
    updateSegmentExtrema(L);

    // One gate, because a frame prices the interval the cursor closes: a step whose own stock is zero moves
    // no cursor, so it has no interval to carry and takes no stamp.
    if (totalStock > 0) {
      settlementCursor = { L, totalStock, residentTotal, resourceTotals: new Map(totals.map(t => [t.resourceKey, t.tokens])) };
      stampNewFrame(step, recordFrame(step, growth));
    }
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
    // Summed in ledger order, before the sort: tokens can be fractional, so a reordered addition would
    // move the belief's last bit.
    let bTotal = closingDead;
    for (const resource of closing.resources) {
      const tokens = resourceTokensOf(resource, corrections.get(resource.resourceKey) || 0);
      if (!(tokens > 0)) continue;
      paths.push({ path: resource.resourceKey, tokens });
      bTotal += tokens;
    }
    paths.sort((a, b) => b.tokens - a.tokens);

    const cRatio = epochPolicy ? epochPolicy.cRatio : null;
    const g = effectiveG(gEma);
    // The exit values are the last stamp's own reading, and the peaks span both arms. The amber turn is
    // narrower: it records the first right-arm step whose stamped br reaches BR_AMBER, so the stamped u
    // picks the arm the way `reference.provisional` does and the left arm's cold-start br is not that crossing.
    let brPeak = 0, ppPeak = 0, turnAtBrAmber = null, last = null;
    for (const step of segmentSteps) {
      if (!step.stamp) continue;
      last = step.stamp;
      brPeak = Math.max(brPeak, step.stamp.br);
      if (turnAtBrAmber === null && step.stamp.u >= 1 && step.stamp.br >= BR_AMBER) {
        turnAtBrAmber = step.turn - segmentStartTurn;
      }
      ppPeak = Math.max(ppPeak, step.stamp.pp);
    }
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
        mf: last ? last.mf : null,
        ppExit: last ? last.pp : null,
        brExit: last ? last.br : null,
        brPeak,
        ppPeak,
        p0: (cRatio > 0 && g > 0) ? closingDead / (cRatio * g) : null,
        bAxis: (g > 0 && segmentUsageCount > 0) ? 2 * oAvg / g : null,
        xAxis: closingDead > 0 ? segmentLPeak / closingDead : null,
        gMin: Number.isFinite(segmentGMin) ? segmentGMin : null,
        turnAtBrAmber,
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

  // One coherent view behind every named read: the last step's L, its capped belief and its stamps, the
  // current g and the epoch-model policy. Resident totals are read live only by getBucketData.
  function readView() {
    const lastStep = segmentSteps.length ? segmentSteps[segmentSteps.length - 1] : null;
    const stamp = lastStep ? lastStep.stamp : null;
    const L = lastStep ? lastStep.L : 0;
    const B = lastStep ? lastStep.bAtCall : 0;
    const bDefault = stamp ? stamp.bDefault : 0;
    const g = effectiveG(gEma);
    const cRatio = epochPolicy ? epochPolicy.cRatio : null;
    // The characteristic scale reads the default fold's rate against the default baseline, the same pair the
    // position runs on; the smoothed g reaches the wire as `g` and `gEma` for the readout alone.
    const q = deriveQuantities({ L, bDefault, cRatio: cRatio ?? 0, g: defaultFold ? defaultFold.rate() : 0 });
    const lCap = epochPolicy ? epochPolicy.contextCapacity - RESERVED_OUTPUT - CTX_SAFETY_MARGIN : null;
    const scenario = (q.baselineValid && stamp) ? describeScenario(stampedPoints()) : null;
    const rateLamp = scenario
      ? {
        reliable: true, basis: 'fullCarry',
        L_read: L, L_cap: lCap, B_post: B, B_rebuild: B, B_default: bDefault, C_RATIO: cRatio,
        x_display: q.x, dhat: q.dhat, uInst: q.dhat > 0 ? (q.x - 1) / q.dhat : null, gEma: g,
        ...scenario,
      }
      // Physical unavailability the Engine can see. Whether the application ever observed a Source is its
      // own fact, so it owns the `no_transcript` case.
      : { reliable: false, unavailableReason: 'insufficient_data' };
    return {
      x: q.x, dhat: q.dhat, L, B, bDefault, g, cRatio, rateLamp,
      u: scenario ? scenario.u : null, pp: scenario ? scenario.pp : null,
      mf: scenario ? scenario.mf : null, br: scenario ? scenario.br : null,
      xSweet: scenario ? scenario.xSweet : null,
      totalStock: settlementCursor ? settlementCursor.totalStock : 0,
      usage: lastStep ? { ...lastStep.usage } : null,
    };
  }

  function getStatus() {
    const view = readView();
    return {
      L: view.L, B: view.B, bDefault: view.bDefault, g: view.g,
      x: view.x, dhat: view.dhat, xSweet: view.xSweet,
      u: view.u, pp: view.pp, mf: view.mf, br: view.br,
      model: epochModel, latestMeasuredModel, cRatio: view.cRatio,
      segment: segmentSeq, apiCalls: segmentSteps.length, turnSeq,
      usage: view.usage, rateLamp: view.rateLamp,
    };
  }

  // A history point is a pure read of one folded step: appending a later step never changes an earlier
  // point.
  function getHistory() {
    return calls.map((step) => {
      const B = step.bAtCall;
      // Total stock, not the fixed L: it is the true context volume of the row, so a parallel-tool
      // plateau or a cacheWrite-less miss does not flatten the curve. A revision moves this point.
      const L = step.usage.input + step.usage.cacheRead + step.usage.cacheWrite;
      return {
        ts: step.timestamp, segment: step.segment, L, B,
        x: step.stamp ? step.stamp.x : 1,
        bDefault: step.stamp ? step.stamp.bDefault : null,
        u: step.stamp ? step.stamp.u : null,
        pp: step.stamp ? step.stamp.pp : null,
        g: step.gAtCall,
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
    const totals = ledger.residentTotals();
    const residentTotal = residentTotalOf(totals);
    const totalStock = settlementCursor ? settlementCursor.totalStock : 0;
    // The physical invariant is that the belief is a subset of the stock, so the reported total is capped by
    // the settlement cursor's stock while the per-resource rows keep their full belief. The cap self-releases
    // as total stock catches up.
    const B = settlementCursor ? Math.min(residentTotal, totalStock) : residentTotal;
    const lastStep = segmentSteps.length ? segmentSteps[segmentSteps.length - 1] : null;
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
      totalB: B,
      totalL: lastStep ? lastStep.L : 0,
      bDefault: bDefaultOf(totals),
      // Read off the same cursor stock the residual candidates are drawn from, not off L: the
      // remainder a consumer derives by subtracting the allocated groups from this total then sits
      // on the channel those groups came from, where a cacheRead-channel total would fall short by
      // a tool result the stock already carries.
      totalResidualRaw: totalStock - B,
      totalResidual: Math.max(0, totalStock - B),
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
        L: view.L, B: view.B, bDefault: view.bDefault, g: view.g, gBar: defaultFold ? defaultFold.rate() : 0, mf: view.mf, br: view.br,
        u: view.u, pp: view.pp, x: view.x, dhat: view.dhat, cRatio: view.cRatio, dead, sessionFloor,
      },
      paths,
    };
  }

  // One coherent frame for the rate lamp: the same status the named reads show, how far measurement has
  // advanced, and each folded call after `sinceFoldedSeq` with the rent increment and movable fraction its
  // own interval was stamped with. Stream continuity is process-local to the application, so no revision
  // counter appears here.
  function readRateLampFrame(sinceFoldedSeq) {
    const view = readView();
    const samples = [];
    for (const step of segmentSteps) {
      if (!(step.foldedSeq > sinceFoldedSeq)) continue;
      const sample = { seq: step.foldedSeq, reliable: view.rateLamp.reliable, turnSeq: step.turn, L_read: step.L };
      if (view.rateLamp.reliable) {
        sample.deltaW = step.stamp ? step.stamp.deltaW : null;
        // The ledger's `mf` is the sample's own exchange rate: the interval's local fraction, not the
        // path-weighted mf the lamp reads.
        sample.mf = step.stamp ? step.stamp.mfLocal : null;
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

  // One validation for Apply and Preview: an entry naming a resource the epoch has never seen, or a value
  // outside the pair, is warned and dropped.
  function parseOverrides(overrides) {
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
    return { next, warnings };
  }

  // Whole-set replacement over the current epoch's override set; manual and inferred entries share it, and
  // `changed` reports the effective set rather than the request. Stamps are a function of the frames, the
  // selector and the epoch policy, so a changed effective set re-stamps every step and an unchanged one
  // — the resource-policy flush after a batch of new resources sends the same map back — keeps them as
  // they are.
  function replaceResourceOverrides(overrides) {
    const { next, warnings } = parseOverrides(overrides);
    let changed = next.size !== resourceOverrides.size;
    if (!changed) {
      for (const [resourceKey, value] of next) {
        if (resourceOverrides.get(resourceKey) !== value) { changed = true; break; }
      }
    }
    resourceOverrides = next;
    if (changed) restampSegment();
    return { changed, warnings, diagnostics: [] };
  }

  // The policy signature covers the ratio and every resource's selection, so an unchanged signature leaves
  // the stamps as they are and a resolved ratio stamps a segment recorded without one.
  function refreshReadPolicies() {
    const diagnostics = [];
    const before = policySignature();
    if (segmentSteps.length > 0) epochPolicy = resolveEpochPolicy(epochModel, diagnostics);
    for (const resourceKey of [...resourcePolicyByKey.keys()]) {
      resourcePolicyByKey.set(resourceKey, resolveResourceEntry(resourceKey, diagnostics));
    }
    const changed = policySignature() !== before;
    if (changed) restampSegment();
    return { changed, diagnostics };
  }

  // The same fold under a candidate selector. It mutates nothing; L and R are the same in every scenario,
  // and the rate is the scenario's own.
  function readScenario(overrides) {
    const { next, warnings } = parseOverrides(overrides);
    const view = readView();
    if (!view.rateLamp.reliable) return { reliable: false };
    const { points, gBar } = scenarioPoints(selectorOf(next));
    return {
      reliable: true,
      gBar,
      trajectory: points.filter(p => p.pp !== null).map(p => ({ seq: p.seq, x: p.x, u: p.u, pp: p.pp })),
      ...describeScenario(points),
      wallP: wallPositionFor(view.cRatio),
      warnings,
    };
  }

  return {
    ingest,
    closeCurrentSegment,
    getStatus,
    getHistory,
    getBucketData,
    getHandoffMeasurement,
    readRateLampFrame,
    readScenario,
    replaceResourceOverrides,
    refreshReadPolicies,
  };
}
