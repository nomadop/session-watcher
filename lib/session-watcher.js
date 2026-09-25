// lib/session-watcher.js — the shared SessionWatcher application.
//
// One Module owns frame application, the product operations, resource-policy flush scheduling, enriched-read
// composition, persistence coordination and handoff composition. It is shared: it imports nothing under
// `lib/harness/`, holds no native tool name and no row shape, and receives the concrete Measurement
// Projection factory from host composition. The record and observation vocabularies cross that seam as plain
// discriminant strings, because the Interface between the two owners is local trusted data and a shared
// constant would only re-couple them.
//
// Source mutation is one-way. `applyHarnessFrame` is the only operation that moves source state; it never
// calls back into host wiring and never asks a Harness to switch Source. Everything else is a read, a
// product operation, or the one ratio mutation.
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { SKILL_RESOURCE_PREFIX } from './resource-policy.js';
import { captureCurrentEpochTurns, captureIsPersistable, collectNoteIssues, buildTurnNoteRows } from './turn-note.js';
import {
  buildSkeleton, parseNoteSections, renderNoteSections, slotKeysOf, snapshotDigest, TURN_NOTE_PROTOCOL,
} from './turn.js';
import { HANDOFF_HOOK_TTL_DAYS } from './constants.js';

const DIAGNOSTIC_SCOPE = 'session-watcher';

function invariant(ok, message) {
  if (!ok) throw new Error(`session watcher invariant: ${message}`);
}

function diagnostic(code, message) {
  return { scope: DIAGNOSTIC_SCOPE, code, message };
}

// One filename segment, never a path: a `/`, a `\`, a NUL or a `..` in an identity would let the Turn Note
// directory escape the injected root. The sentinel reaches a consumer inside `skeleton_path` and
// `notes_path`, so it is the exact text those wire fields have always carried.
function safeSegment(value) {
  const text = String(value ?? '');
  if (!text || text === '.' || text === '..' || /[/\\\0]/.test(text) || text.includes('..')) return '__invalid_session__';
  return text;
}

// One model policy, or null when the resolver's answer cannot be used. The CTP pair is validated together
// with its calibration version, so a stored measurement always records which calibration produced it.
function readPolicy(modelPolicyFor, modelId) {
  let raw = null;
  try { raw = modelPolicyFor(modelId); } catch { return null; }
  if (raw === null || typeof raw !== 'object') return null;
  const { ctp } = raw;
  if (ctp === null || typeof ctp !== 'object') return null;
  for (const key of ['ascii', 'cjk', 'version']) {
    if (!(typeof ctp[key] === 'number' && Number.isFinite(ctp[key]))) return null;
  }
  return raw;
}

// The residual families the shared application names. The Engine stores each candidate's metadata without
// interpreting it, so mapping a normalized `meta.kind` onto a display family is this layer's own step; a
// kind outside the set names no family and reaches no bucket.
const RESIDUAL_FAMILIES = new Set(['bash', 'mcp', 'agent']);

export class SessionWatcher {
  constructor({
    sessionId = null,
    sourceLocator = null,
    projectId = null,
    projectRoot = null,
    turnNotesRoot,
    resourcePolicy,
    resourceEnrichment,
    handoffComposition,
    loaderVersion,
    store,
    dialogueSource,
    dialogueProjection,
    createEngine,
    createMeasurementProjection,
    modelPolicyFor,
    now = () => Date.now(),
  } = {}) {
    invariant(store !== null && typeof store === 'object', 'store is required');
    invariant(dialogueProjection !== null && typeof dialogueProjection === 'object', 'dialogueProjection is required');
    invariant(dialogueSource !== null && typeof dialogueSource === 'object'
      && typeof dialogueSource.read === 'function',
    'dialogueSource is required and exposes read');
    invariant(resourcePolicy !== null && typeof resourcePolicy === 'object'
      && typeof resourcePolicy.resolve === 'function' && typeof resourcePolicy.infer === 'function',
    'resourcePolicy is required and exposes resolve and infer');
    invariant(resourceEnrichment !== null && typeof resourceEnrichment === 'object', 'resourceEnrichment is required');
    invariant(handoffComposition !== null && typeof handoffComposition === 'object', 'handoffComposition is required');
    invariant(typeof loaderVersion === 'string' && loaderVersion.length > 0, 'loaderVersion is required');
    invariant(typeof turnNotesRoot === 'string' && turnNotesRoot.length > 0, 'turnNotesRoot is required and has no fallback');
    invariant(typeof createEngine === 'function', 'createEngine must be a function');
    invariant(typeof createMeasurementProjection === 'function', 'createMeasurementProjection must be a function');
    invariant(typeof modelPolicyFor === 'function', 'modelPolicyFor must be a function');
    invariant(typeof now === 'function', 'now must be a function');

    // Immutable construction inputs.
    this._projectId = projectId;
    this._projectRoot = projectRoot;
    this._turnNotesRoot = turnNotesRoot;
    this._loaderVersion = loaderVersion;
    this._store = store;
    this._dialogueSource = dialogueSource;
    this._dialogueProjection = dialogueProjection;
    this._policy = resourcePolicy;
    this._enrichment = resourceEnrichment;
    this._handoff = handoffComposition;
    this._createEngine = createEngine;
    this._createProjection = createMeasurementProjection;
    this._modelPolicyFor = modelPolicyFor;
    this._now = now;
    this._startMs = now();

    // Mutable application state. `_ratioOverride` is the one nullable runtime ratio; the effective resolver
    // below is created once and closes over it, so the Engine and every Projection see a later
    // `setRatioOverride` without being rebuilt.
    this._sessionId = sessionId;
    this._sourceLocator = sourceLocator;
    this._ratioOverride = null;
    this._hasObservedSource = false;
    this._streamRevision = 0;
    this._pendingNewResourceKeys = new Set();
    this._applying = false;

    // The one effective model-policy resolver. It copies the default policy and replaces only `cRatio`, so
    // the CTP pair, the context capacity and the pricing data stay the composition's own values.
    this._resolveModelPolicy = (modelId) => {
      let policy = readPolicy(this._modelPolicyFor, modelId);
      // Unusable policy data — including a CTP pair with no calibration version — falls back to the default
      // policy. A consumer supplies no version of its own, and the Engine's resolver contract already
      // reports an unusable result through its own diagnostic path.
      if (policy === null) policy = readPolicy(this._modelPolicyFor, null) ?? this._modelPolicyFor(null);
      if (this._ratioOverride == null) return policy;
      return { ...policy, cRatio: this._ratioOverride };
    };
    this._resolveResourcePolicy = (resourceKey) => this._policy.resolve(resourceKey);

    this._engine = this._createEngine({
      resolveModelPolicy: this._resolveModelPolicy,
      resolveResourcePolicy: this._resolveResourcePolicy,
    });
    this._projection = this._createProjection(this._sourceLocator, this._resolveModelPolicy);
  }

  // ── Frame application ──────────────────────────────────────────────────────

  /**
   * Apply one HarnessFrame. The only source-state mutation Interface.
   *
   * @param {{ transition: 'append'|'replace'|'rotate', batches: object[][], sourceObserved: boolean,
   *           captureMode: 'live'|'replay', sourceLocator?: *, sessionId?: string }} frame
   * @returns {{ changed: boolean, diagnostics: object[] }}
   */
  applyHarnessFrame(frame) {
    invariant(frame !== null && typeof frame === 'object', 'frame must be an object');
    // One frame application is serialized and non-reentrant: a nested call would interleave two frames'
    // batches over one Engine, and the Engine is serial by contract.
    invariant(this._applying === false, 'reentrant applyHarnessFrame is not supported');
    this._applying = true;
    try {
      const diagnostics = [];
      const captureMode = frame.captureMode === 'replay' ? 'replay' : 'live';
      let runtimeReplaced = false;

      // The transition applies before its batches.
      if (frame.transition === 'replace') {
        this._installFreshRuntime(frame.sourceLocator);
        runtimeReplaced = true;
        this._hasObservedSource = this._hasObservedSource || frame.sourceObserved === true;
        this._streamRevision += 1;
      } else if (frame.transition === 'rotate') {
        this._rotate(frame, captureMode, diagnostics);
        this._hasObservedSource = frame.sourceObserved === true;
        this._streamRevision += 1;
      } else {
        invariant(frame.transition === 'append', `unsupported frame transition: ${String(frame.transition)}`);
        const observedBefore = this._hasObservedSource;
        this._hasObservedSource = observedBefore || frame.sourceObserved === true;
        // The Rate Lamp stream restarts when the application first has a Source to measure against; a later
        // append changes nothing about that continuity.
        if (!observedBefore && this._hasObservedSource) this._streamRevision += 1;
      }

      let newCalls = 0;
      let revisedCalls = 0;
      for (const batch of frame.batches ?? []) {
        for (const observation of batch) {
          // A Projection exception is an invariant failure: it propagates, and no later observation of this
          // frame is projected.
          const projected = this._projection.project(observation);
          for (const entry of projected.diagnostics) diagnostics.push(entry);
          for (const record of projected.records) {
            // Sibling inference batches follow Engine epochs, so the open epoch's keys are inferred while
            // its resident set still exists.
            if (record.type === 'epoch') this._flushResourcePolicy(diagnostics);
            const result = this._engine.ingest([record]);
            for (const entry of result.diagnostics) diagnostics.push(entry);
            newCalls += result.newCalls;
            revisedCalls += result.revisedCalls;
            for (const key of result.newResourceKeys) this._pendingNewResourceKeys.add(key);
            if (record.type === 'epoch') this._consumeClosedSegment(result, captureMode, diagnostics);
          }
        }
      }

      this._flushResourcePolicy(diagnostics);
      return { changed: newCalls > 0 || revisedCalls > 0 || runtimeReplaced, diagnostics };
    } finally {
      this._applying = false;
    }
  }

  /**
   * Close the current segment as a terminal application operation. It is not a Source transition and
   * synthesizes no epoch record.
   *
   * @param {{ captureMode?: 'live'|'replay' }} [options]
   * @returns {{ diagnostics: object[] }}
   */
  closeCurrentSegment({ captureMode = 'live' } = {}) {
    const diagnostics = [];
    this._flushResourcePolicy(diagnostics);
    // A blocking finalization failure throws: the open segment survives, the closing sidecar stays with the
    // Projection, and no artifact exists to lose.
    const result = this._engine.closeCurrentSegment();
    for (const entry of result.diagnostics) diagnostics.push(entry);
    this._consumeClosedSegment(result, captureMode, diagnostics);
    return { diagnostics };
  }

  _installFreshRuntime(sourceLocator) {
    // Stale measurement state is invalidated before the frame's batches reach anything, and the pending
    // resource keys go with the Engine that reported them.
    this._pendingNewResourceKeys = new Set();
    this._sourceLocator = sourceLocator ?? null;
    this._engine = this._createEngine({
      resolveModelPolicy: this._resolveModelPolicy,
      resolveResourcePolicy: this._resolveResourcePolicy,
    });
    this._projection = this._createProjection(this._sourceLocator, this._resolveModelPolicy);
  }

  // The candidate Projection is bound to the new locator BEFORE the old segment closes, so the closing
  // segment's telemetry is joined by the Projection that collected it while the replacement already exists.
  // A blocking finalization failure discards the candidate and leaves the old identity and runtime intact.
  _rotate(frame, captureMode, diagnostics) {
    const candidate = this._createProjection(frame.sourceLocator ?? null, this._resolveModelPolicy);
    this._flushResourcePolicy(diagnostics);
    const result = this._engine.closeCurrentSegment();
    for (const entry of result.diagnostics) diagnostics.push(entry);
    // Still the OLD session and locator: the dying segment belongs to the identity that produced it.
    this._consumeClosedSegment(result, captureMode, diagnostics);
    this._projection = candidate;
    this._sessionId = frame.sessionId ?? this._sessionId;
    this._sourceLocator = frame.sourceLocator ?? null;
  }

  // The one closed-segment consumer behind a successful epoch, a rotate and an explicit close.
  _consumeClosedSegment(result, captureMode, diagnostics) {
    const closedSegment = result.closedSegments[0] ?? null;
    // Exactly once per successful transition, whether or not a segment was closed: the Projection installs a
    // fresh sidecar on this call, and a segment that closed empty must not leave its facts to be joined onto
    // the next one.
    const finished = this._projection.finishSegment(closedSegment, { captureMode });
    for (const entry of finished.diagnostics) diagnostics.push(entry);
    if (closedSegment == null) return;
    // A watcher with no session identity has nothing to key an archive row on.
    if (!this._sessionId) return;

    const archivedAt = captureMode === 'replay'
      ? (lastValidStepTimestamp(closedSegment) ?? this._now())
      : this._now();
    const snapshot = {
      ...closedSegment.metrics,
      model: closedSegment.epochModel,
      projectId: this._projectId,
      archiveSource: captureMode,
      archivedAt,
    };

    let profile;
    try {
      profile = this._store.archiveSegmentProfile(this._sessionId, closedSegment.segment, snapshot, closedSegment.paths);
    } catch (error) {
      // Profile archival failure is non-blocking after the Engine transition.
      diagnostics.push(diagnostic('segment_profile_persist_failed',
        `segment ${closedSegment.segment} profile persistence failed: ${error.message}`));
      return;
    }
    if (profile?.status !== 'archived' && profile?.status !== 'already_archived') return;
    if (!finished.artifact) return;
    try {
      const telemetry = this._store.archiveSegmentTelemetry(this._sessionId, closedSegment.segment, finished.artifact);
      if (telemetry?.status === 'failed_retryable') {
        diagnostics.push(diagnostic('segment_telemetry_persist_failed',
          `segment ${closedSegment.segment} telemetry persistence is retryable`));
      }
    } catch (error) {
      diagnostics.push(diagnostic('segment_telemetry_persist_failed',
        `segment ${closedSegment.segment} telemetry persistence failed: ${error.message}`));
    }
  }

  // ── Resource-policy flush ──────────────────────────────────────────────────

  // One complete resource snapshot per flush, taken while the epoch that created the pending keys is still
  // open. Baseline inference read the resident set once per newly created path, which made a batch of
  // siblings order-dependent against itself; one snapshot per flush is what the approved delta names.
  _flushResourcePolicy(diagnostics) {
    if (this._pendingNewResourceKeys.size === 0) return;
    const pendingKeys = [...this._pendingNewResourceKeys];
    const bucket = this._engine.getBucketData();
    const resourceKeys = [];
    const overrides = {};
    for (const row of bucket.paths) {
      resourceKeys.push(row.path);
      if (row.userOverride) overrides[row.path] = row.userOverride;
    }
    const inferred = this._policy.infer({ newResourceKeys: pendingKeys, resourceKeys, overrides });
    const merged = { ...overrides, ...inferred };
    const replaced = this._engine.replaceResourceOverrides(merged);
    for (const entry of replaced.diagnostics ?? []) diagnostics.push(entry);
    // The set was built from the Engine's own snapshot, so a warning here means the two disagree about which
    // resources exist. It is reported rather than dropped; the wording a route shows is host-owned.
    if (replaced.warnings?.length > 0) {
      diagnostics.push(diagnostic('resource_override_merge_warned',
        `${replaced.warnings.length} inferred resource override entries were not applied`));
    }
    this._enrichment.warm(pendingKeys);
    this._pendingNewResourceKeys = new Set();
  }

  // ── Named reads ────────────────────────────────────────────────────────────

  // The C ratio a read reports. The Engine holds no epoch policy until the epoch's first measured step, so
  // it answers null until then; a read model resolves a policy for the model it is displaying, which is what
  // makes the ratio finite from the first poll and a runtime override visible before any step has landed.
  // The effective resolver already substitutes the override's ratio, so one call covers both. It fires ONLY
  // on a null, so a resolved epoch policy is never masked.
  _readCRatio(engineCRatio, modelId) {
    if (engineCRatio != null) return engineCRatio;
    return this._resolveModelPolicy(modelId ?? '').cRatio;
  }

  getStatus() {
    const status = this._engine.getStatus();
    // The Engine reports only the unavailability it can see. Whether a Source was ever observed is the
    // application's own fact, so `no_transcript` is decided here.
    const rateLamp = status.rateLamp.reliable
      ? status.rateLamp
      : {
        ...status.rateLamp,
        unavailableReason: (status.apiCalls === 0 && !this._hasObservedSource) ? 'no_transcript' : 'insufficient_data',
      };
    return {
      L: status.L, B: status.B, bDefault: status.bDefault, g: status.g,
      x: status.x, dhat: status.dhat, xSweet: status.xSweet, u: status.u, pp: status.pp,
      mf: status.mf, br: status.br,
      // The displayed model identity is the latest measured step's, while every policy value the reads
      // derive comes from the epoch model.
      model: status.latestMeasuredModel ?? '',
      cRatio: this._readCRatio(status.cRatio, status.latestMeasuredModel),
      segment: status.segment, apiCalls: status.apiCalls,
      uptime: Math.floor((this._now() - this._startMs) / 1000),
      rateLamp,
      sourceLocator: this._sourceLocator,
    };
  }

  getHistory() {
    return this._engine.getHistory().map(point => ({
      // The Engine holds normalized integers so nothing but a number crosses the Harness seam; the retained
      // wire form is the source's own ISO text, which round-trips through this conversion.
      ts: point.ts == null ? null : new Date(point.ts).toISOString(),
      segment: point.segment, L: point.L, B: point.B, g: point.g,
      bDefault: point.bDefault, u: point.u, pp: point.pp,
      miss: point.miss, cacheRead: point.cacheRead, cacheCreation: point.cacheWrite,
      turnSeq: point.turnSeq, foldedSeq: point.foldedSeq,
    }));
  }

  // The only bucket/resource query. It reads the Engine first, then passes only default-selected file rows
  // to Resource Enrichment — a row the position basis excludes buys no symbols, and a Skill has no file.
  getBucketData({ includeSymbols = false } = {}) {
    const bucket = this._engine.getBucketData();
    const skills = [];
    const paths = [];
    for (const row of bucket.paths) {
      // `lineNumbers` and `fullSnapshot` exist for the enrichment composition below and are internal.
      const { path, lineNumbers, fullSnapshot, ...common } = row;
      if (path.startsWith(SKILL_RESOURCE_PREFIX)) {
        skills.push({ name: path.slice(SKILL_RESOURCE_PREFIX.length), ...common });
        continue;
      }
      const entry = { path, ...common };
      if (includeSymbols && row.defaultSelected) {
        const activeSymbols = this._enrichment.activeSymbols({ path, lineNumbers, fullSnapshot });
        if (activeSymbols) entry.activeSymbols = activeSymbols;
      }
      paths.push(entry);
    }
    const residual = { bash: [], mcp: [], agent: [] };
    for (const group of bucket.residual) {
      const family = group.meta?.kind;
      if (!RESIDUAL_FAMILIES.has(family)) continue;
      const tokens = Math.round(group.tokens);
      if (tokens <= 0) continue;
      const common = { tokens, count: group.count, lastTurn: group.lastTurn, lastCallSeq: group.lastCallSeq, touchSeqs: group.touchSeqs };
      if (family === 'mcp') residual.mcp.push({ tool: group.groupKey, ...common });
      else residual[family].push({ name: group.groupKey, detail: group.meta.detail || '', ...common });
    }
    for (const family of Object.keys(residual)) residual[family].sort((a, b) => b.tokens - a.tokens);
    return {
      dead: bucket.dead,
      skills, paths, residual,
      totalB: bucket.totalB, totalL: bucket.totalL, bDefault: bucket.bDefault,
      totalResidualRaw: bucket.totalResidualRaw, totalResidual: bucket.totalResidual,
      currentTurnSeq: bucket.currentTurnSeq, segment: bucket.segment,
    };
  }

  // The value host wiring persists unchanged as `profile_snapshot`. `b_total` is the UNCAPPED resident total:
  // the read-time cap belongs to the live dashboard, while persistence needs the belief its own path rows sum
  // into, or `dead + Σ paths` would exceed the total it is stored beside.
  getTerminalSnapshot() {
    const status = this._engine.getStatus();
    const bucket = this._engine.getBucketData();
    const paths = bucket.paths.map(({ path, tokens }) => ({ path, tokens }));
    let bTotal = bucket.dead;
    for (const { tokens } of paths) bTotal += tokens;
    return {
      b_total: bTotal,
      g_final: status.g,
      l_peak: status.L,
      c_ratio: this._readCRatio(status.cRatio, status.latestMeasuredModel),
      turns: status.turnSeq,
      mf: status.mf,
      br_exit: status.br,
      paths,
      model: status.latestMeasuredModel ?? '',
      segment: status.segment,
    };
  }

  getCurrentModel() {
    return this._engine.getStatus().latestMeasuredModel;
  }

  // The EPOCH model: the first measured step's model in the current epoch, which is what every
  // model-DEPENDENT value resolves its policy from. Distinct from `getCurrentModel()`, the latest measured
  // step's identity, which is what a status display shows. The two genuinely differ within one epoch, and a
  // consumer that keys persistent state on the model needs this one — keying on the latest identity would
  // move the key mid-epoch. Deliberately NOT a member of `getStatus()`: that result's shape is compared
  // key-for-key, so widening it would itself be a wire change.
  getEpochModel() {
    return this._engine.getStatus().model;
  }

  getCurrentCtp() {
    return this._resolveModelPolicy(this.getCurrentModel()).ctp;
  }

  readRateLampFrame(sinceFoldedSeq) {
    return { ...this._engine.readRateLampFrame(sinceFoldedSeq), streamRevision: this._streamRevision };
  }

  replaceUserOverrides(entries) {
    return this._engine.replaceResourceOverrides(entries);
  }

  // The same fold under a CANDIDATE override set. It validates through the same parse Apply does and mutates
  // nothing, so the position a consumer previews is the position the Apply it may follow with then reads.
  readScenario(overrides) {
    return this._engine.readScenario(overrides);
  }

  // The only runtime ratio mutation. It moves the policy signature, so the Engine re-stamps every step of the
  // open segment under the new price. It recomputes no closed segment's extremum, leaves the Rate Lamp
  // ledger's integral as it stands and does not move `streamRevision`, so the ledger keeps what it already
  // integrated and the re-stamped increments reach it with the frames drained after the change. The Engine
  // finalizer freezes the effective close-time ratio in the closed segment.
  setRatioOverride(value) {
    this._ratioOverride = (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : null;
    return this._engine.refreshReadPolicies();
  }

  // ── Handoff operations ─────────────────────────────────────────────────────

  prepareHandoff({ pathsToKeep, skillsToKeep, summary, nextTask, observedSegment, loadToken } = {}) {
    const engineMeasurement = this._engine.getHandoffMeasurement();
    // The composition gates `preparedStats` on a positive ratio, and an accepted effect can make a resource
    // resident before the epoch's first measured step resolves a policy — so the ratio reaches it through the
    // same read model every other read uses.
    const measurement = {
      ...engineMeasurement,
      measurement: {
        ...engineMeasurement.measurement,
        cRatio: this._readCRatio(engineMeasurement.measurement.cRatio, engineMeasurement.epochModel),
      },
    };
    if (typeof observedSegment === 'number' && observedSegment !== measurement.segment) {
      return {
        status: 'error', error: 'stale_bucket_summary',
        instruction: 'Call get_bucket_summary again before preparing handoff.',
      };
    }
    // Only file resources take part in kept-path binding and in the discarded-token total; a Skill carries
    // no path a consumer could re-read.
    const filePaths = measurement.paths.filter(row => !row.path.startsWith(SKILL_RESOURCE_PREFIX));
    const composed = this._handoff.composePrepared({
      input: { pathsToKeep, skillsToKeep, summary, nextTask },
      measurement,
      filePaths,
      ctp: this._resolveModelPolicy(measurement.epochModel).ctp,
      projectRoot: this._projectRoot,
      symbolRangesFor: (request) => this._enrichment.symbolRanges(request),
      // The kept scenario: every file resource the handoff keeps is carried, every other one is left out
      // as excess. Skills keep their default selection — the kept-token total counts files alone.
      rateForKept: (keptKeys) => {
        const kept = new Set(keptKeys);
        const overrides = {};
        for (const row of filePaths) overrides[row.path] = kept.has(row.path) ? 'include' : 'exclude';
        const scenario = this._engine.readScenario(overrides);
        return scenario.reliable ? scenario.gBar : 0;
      },
    });
    if (composed.status === 'error') return composed;

    const row = {
      ...composed.row,
      sessionId: this._sessionId,
      segment: measurement.segment,
      projectId: this._projectId || null,
      transcriptPath: this._sourceLocator ?? null,
    };
    const written = this._writeHandoffRow(row, loadToken, composed);
    if (written.status === 'error') return written;
    const out = {
      status: 'ready',
      load_token: written.loadToken,
      ...composed.response,
      instruction: this._handoff.instructionFor(written.loadToken),
    };
    if (composed.resolvedPaths.length > 0) out.resolved_paths = composed.resolvedPaths;
    return out;
  }

  // Update in place when the caller named a token, else mint one. A token that exists but was already
  // DELIVERED has immutable telemetry, so it falls through to a fresh insert rather than being rewritten at
  // a different instant than its recorded delivery.
  _writeHandoffRow(row, existingToken, composed) {
    if (typeof existingToken === 'string' && existingToken.length > 0) {
      if (this._store.updateHandoff(existingToken, row)) return { loadToken: existingToken };
      if (!this._store.hasHandoff(existingToken)) {
        return {
          status: 'error', error: 'token_not_found',
          instruction: 'The provided load_token does not exist. Omit it to create a new handoff.',
        };
      }
    }
    for (const candidate of this._handoff.candidateTokens(composed.tokenSeed)) {
      try {
        this._store.insertHandoff({ ...row, loadToken: candidate, createdAt: this._handoff.createdAt() });
        return { loadToken: candidate };
      } catch (error) {
        if (error.errcode !== 2067) throw error;   // 2067 is the UNIQUE collision this retry exists for
      }
    }
    return { status: 'error', error: 'token_collision' };
  }

  searchHandoffs({ query, queryMode } = {}) {
    if (!this._store.ftsAvailable) return { status: 'error', error: 'search_unavailable' };
    let results;
    try { results = this._store.searchHandoff(this._handoff.searchExpression(query, queryMode), { projectId: this._projectId }); }
    catch { return { status: 'error', error: 'invalid_query' }; }
    return this._handoff.searchResponse(results);
  }

  // One session, segment and project captured at entry: the response is composed after the delivery
  // transaction commits, and it must describe the consumer that actually claimed the row.
  async deliverHandoff({ loadToken } = {}) {
    const sessionId = this._sessionId;
    const projectId = this._projectId;
    const consumerSegment = this._engine.getStatus().segment;

    let token = loadToken;
    if (typeof token !== 'string' || token.length === 0) {
      if (!projectId) return { found: false };
      const pending = this._store.findPendingHandoffsByProject(projectId, sessionId, {
        ttlMs: HANDOFF_HOOK_TTL_DAYS * 24 * 3600 * 1000,
      });
      if (pending.status === 'none') return { found: false };
      // Nobody should be stamped while more than one candidate matches: the caller names one instead.
      if (pending.status === 'ambiguous') return this._handoff.ambiguityResponse(pending.rows);
      token = pending.row.loadToken;
    }

    const delivered = this._store.deliverHandoffByToken(token, {
      sessionId, loaderVersion: this._loaderVersion, consumerSegment,
    });
    if (!delivered) return { found: false };
    if (delivered.ok === false) return delivered;
    this._stampLoadHashes(delivered, sessionId);
    return this._handoff.projectDelivered(delivered, {
      resolveSymbols: (request) => this._enrichment.resolveSymbols(request),
    });
  }

  // Re-hash each kept path on THIS machine so a consumer can tell a carried file that moved from one that
  // did not. Only the bound primary stamps, so a duplicate consumer can never clobber the primary's record,
  // and a failure is a display loss rather than a delivery one.
  _stampLoadHashes(delivered, sessionId) {
    const isBoundPrimary = delivered.deliveredSessionId != null && delivered.deliveredSessionId === sessionId;
    if (!delivered.claimedNow && !isBoundPrimary) return;
    try {
      const stamped = this._handoff.stampLoadHashes(delivered, {
        projectRoot: this._projectRoot,
        force: delivered.claimedNow === true,
      });
      if (stamped) this._store.stampContentHashLoad(delivered.handoffId, stamped);
    } catch (error) {
      if (process.env.SW_DEBUG) console.error('[content_hash_load]', error.message);
    }
  }

  // ── Turn Notes ─────────────────────────────────────────────────────────────

  // One capture behind both entry points, so the skeleton and the submission can never see different Turns.
  // The read status travels with it: an unavailable Source has an empty capture, which is otherwise
  // indistinguishable from a genuinely empty epoch whose submission would commit nothing.
  _captureTurns() {
    const read = this._dialogueSource.read(this._sourceLocator);
    if (read.status !== 'ok') return { status: read.status, turns: [] };
    return { status: 'ok', ...captureCurrentEpochTurns({ observations: read.observations, dialogueProjection: this._dialogueProjection }) };
  }

  // The two files' one address, derived here and nowhere else. The key is the Context Epoch — this session
  // plus the epoch's first anchor — so a re-fetch after the epoch grew still finds the notes already
  // written, where a content fingerprint would rename the file on every new Turn.
  _turnNotePaths(turns) {
    const dir = join(this._turnNotesRoot,
      `${safeSegment(this._sessionId)}-${safeSegment(turns[0]?.sourceEntryId ?? 'empty')}`);
    return { dir, skeletonPath: join(dir, 'skeleton.txt'), notesPath: join(dir, 'notes.md') };
  }

  // This session's Turn Records by anchor. The Store is the durable copy of a committed epoch's notes: the
  // notes file is retired the moment those rows land, while the next handoff in the same session keeps the
  // epoch key and therefore lands on that same, now absent, path.
  _storedNotes() {
    return new Map(this._store.listTurnNotes(this._sessionId).map(row => [row.anchorUuid, row.note]));
  }

  getTurnSkeleton() {
    const { status, turns } = this._captureTurns();
    // Throwing rather than reporting: the success shape has no way to say "the source could not be read",
    // and a zero-turn skeleton reads as a legitimate empty epoch whose submission would commit nothing.
    if (status !== 'ok') throw new Error('transcript is not readable; no turn skeleton can be captured');
    // Ahead of every write and of the directory itself: a capture whose heads carry no persistable identity
    // or time can never commit, so its files would be an unredacted projection nothing could retire.
    if (!captureIsPersistable(turns)) {
      throw new Error('captured turn heads carry no persistable identity; no turn skeleton can be captured');
    }
    const { dir, skeletonPath, notesPath } = this._turnNotePaths(turns);
    mkdirSync(dir, { recursive: true });
    // Both reads happen before any write. Every write refreshes an mtime and the stale-notes sweep ages a
    // directory by the newest mtime inside it, so a fetch that threw after rewriting would make an
    // already-expired directory unreapable.
    let existing = null;
    try { existing = readFileSync(notesPath, 'utf8'); }
    catch (error) {
      // ENOENT is the only read failure that means "no notes yet".
      if (error?.code !== 'ENOENT') throw new Error(`turn notes file cannot be read: ${notesPath}`);
    }
    const stored = this._storedNotes();
    // The skeleton is entirely this operation's own output, so it is rewritten whole.
    writeFileSync(skeletonPath, buildSkeleton(turns, this._sessionId));
    // The notes file is not. It is APPEND-ONLY from here: a heading is added for a slot that has none, and
    // nothing already in the file is rewritten or reordered, so a re-fetch costs the producer nothing.
    const slots = slotKeysOf(turns);
    const { sections } = parseNoteSections(existing, slots);
    const missing = slots.filter(key => !sections.has(key));
    // A slot the file has no section for is prefilled with its Turn's stored note, so a fetch after a commit
    // hands the producer back what is already durable rather than an empty heading.
    const prefill = new Map(turns
      .filter(turn => stored.get(turn.sourceEntryId))
      .map(turn => [String(turn.sourceOrdinal), stored.get(turn.sourceEntryId)]));
    if (existing == null) writeFileSync(notesPath, renderNoteSections(missing, prefill));
    else if (missing.length > 0) {
      appendFileSync(notesPath, `${existing.endsWith('\n') ? '' : '\n'}\n${renderNoteSections(missing, prefill)}`);
    }
    return {
      snapshot_id: snapshotDigest(turns),
      skeleton_path: skeletonPath,
      notes_path: notesPath,
      protocol: TURN_NOTE_PROTOCOL,
    };
  }

  submitTurnNotes({ snapshot_id: snapshotId } = {}) {
    const { status, turns } = this._captureTurns();
    // Ahead of the fingerprint on purpose: an unreadable source has an empty capture whose digest a caller
    // can reproduce, so checking identity first would let the empty submission through.
    if (status !== 'ok') return { committed: false, error: 'invalid_snapshot' };
    if (snapshotDigest(turns) !== snapshotId) return { committed: false, error: 'stale_snapshot' };
    if (!captureIsPersistable(turns)) return { committed: false, error: 'invalid_snapshot' };

    const slots = slotKeysOf(turns);
    const { dir, notesPath } = this._turnNotePaths(turns);
    let raw = null;
    try { raw = readFileSync(notesPath, 'utf8'); } catch { /* absent or unreadable yields no section */ }
    const { sections, issues } = parseNoteSections(raw, slots);
    let stored;
    // Guarded, unlike the skeleton's read of the same thing: this operation's failure set is closed, so a
    // read failure takes the retryable class the write failure already takes.
    try { stored = this._storedNotes(); }
    catch (error) {
      if (process.env.SW_DEBUG) console.error('[turn-note-read]', error?.message || error);
      return { committed: false, error: 'storage_unavailable', retryable: true };
    }
    issues.push(...collectNoteIssues({ turns, sections, storedNotes: stored }));
    if (issues.length > 0) return { committed: false, error: 'invalid_notes', issues };

    const rows = buildTurnNoteRows({ turns, sections, storedNotes: stored, sessionId: this._sessionId });
    try { this._store.upsertTurnNotes(rows); }
    catch (error) {
      if (process.env.SW_DEBUG) console.error('[turn-note-write]', error?.message || error);
      return { committed: false, error: 'storage_unavailable', retryable: true };
    }
    // Only after the rows are in. A skeleton is an unredacted Turn History projection, and because
    // storage_unavailable is retryable, deleting any earlier would destroy the notes the retry has to read.
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (error) { if (process.env.SW_DEBUG) console.error('[turn-note-cleanup]', error?.message || error); }
    return { committed: true };
  }
}

// The replay archive time: the last step time the closing segment actually carries. A segment whose steps
// carry no usable time falls back to the injected clock.
function lastValidStepTimestamp(closedSegment) {
  for (let i = closedSegment.steps.length - 1; i >= 0; i--) {
    const timestamp = closedSegment.steps[i].timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  }
  return null;
}
