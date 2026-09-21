// lib/harness/claude-code/measurement-projection.js — Claude Code Measurement Projection.
// Turns one ordered normalized observation into MeasurementRecords, and owns the two pieces of state that
// are nobody else's: the native tool correlation (which tool use is still waiting for which result) and the
// Segment Telemetry sidecar for the current segment. Both are Projection-local — a pending correlation
// reaches no Engine record, and no telemetry fact alters measurement.
//
// It speaks the Engine's record vocabulary as plain discriminant strings and imports nothing from
// `lib/measurement/`: the record Interface is local, trusted, unversioned data, so a shared constant would
// only re-couple the two owners. Native interpretation arrives as injected functions, so this module holds
// no tool name, adapter, or result-parsing rule of its own.

import nodePath from 'node:path';
import { homedir } from 'node:os';

const DIAGNOSTIC_SCOPE = 'claude-code-measurement-projection';

function invariant(ok, message) {
  if (!ok) throw new Error(`claude code measurement projection invariant: ${message}`);
}

function diagnostic(code, message) {
  return { scope: DIAGNOSTIC_SCOPE, code, message };
}

// ─── Segment Telemetry sidecar ───────────────────────────────────────────────

function emptyFacts() {
  return { toolUseIds: new Set(), loadToken: null, pathEvents: [] };
}

// The archived storage shape, per closed step. `cacheCreation` is the stored name for the cacheWrite bucket.
function stepRowFor(step, facts) {
  return {
    foldedSeq: step.foldedSeq,
    ts: step.timestamp,
    input: step.usage.input,
    output: step.usage.output,
    cacheRead: step.usage.cacheRead,
    cacheCreation: step.usage.cacheWrite,
    toolCalls: facts ? facts.toolUseIds.size : 0,
    loadToken: facts ? facts.loadToken : null,
  };
}

// One join of the detached closing facts to the closed segment's steps, by step id. `eventOrdinal` restarts
// per step and follows the order the events arrived in, which is the only order that exists: the sidecar
// records arrival, not any native position.
function joinFacts(factsByStepId, closedSegment) {
  const steps = [];
  const events = [];
  for (const step of closedSegment.steps) {
    const facts = factsByStepId.get(step.id) ?? null;
    steps.push(stepRowFor(step, facts));
    if (!facts) continue;
    let eventOrdinal = 0;
    for (const event of facts.pathEvents) {
      events.push({
        foldedSeq: step.foldedSeq,
        eventOrdinal: eventOrdinal++,
        path: event.path,
        rawPath: event.rawPath,
        toolType: event.toolType,
        isFullRead: event.isFullRead,
      });
    }
  }
  return { steps, events };
}

// ─── Projection ──────────────────────────────────────────────────────────────

export function createClaudeCodeMeasurementProjection({
  cwd = null,
  projectRoot = null,
  sourceLocator = null,
  resolveModelPolicy,
  interpretToolUse,
  completeToolResult,
  interpretSkillPayload,
  interpretTaskNotification,
} = {}) {
  invariant(typeof resolveModelPolicy === 'function', 'resolveModelPolicy must be a function');
  invariant(typeof interpretToolUse === 'function', 'interpretToolUse must be a function');
  invariant(typeof completeToolResult === 'function', 'completeToolResult must be a function');
  invariant(typeof interpretSkillPayload === 'function', 'interpretSkillPayload must be a function');
  invariant(typeof interpretTaskNotification === 'function', 'interpretTaskNotification must be a function');

  // The immutable session directory native target resolution falls back to when a row names none of its own.
  // An empty session directory falls through to the project root: the composition supplied no directory, and
  // the layer below this one sees only the value that survives here.
  const sessionCwd = cwd || projectRoot || null;
  // The transcript's own directory is the last resort of native target resolution. A null locator has no
  // directory, so the Projection resolves none rather than naming the host process's working directory.
  const transcriptDir = typeof sourceLocator === 'string' && sourceLocator.length > 0
    ? nodePath.dirname(sourceLocator)
    : null;
  // The path and home-directory capabilities native interpretation reaches the filesystem namespace
  // through; it holds no implementation of its own, so the Projection supplies one and the target
  // resolution order below is the whole of this Harness's ambient directory knowledge.
  const context = { path: nodePath, homedir, sessionCwd, transcriptDir, resolveModelPolicy };

  let correlationByToolUseId = new Map();
  let sidecarByStepId = new Map();

  function factsFor(stepId) {
    let facts = sidecarByStepId.get(stepId);
    if (!facts) { facts = emptyFacts(); sidecarByStepId.set(stepId, facts); }
    return facts;
  }

  // Native facts arrive independently of usage acceptance, so an entry may exist before its step's usage
  // observation and may be filled by a revision the Engine ignores. A fact with no issuing step names no
  // archive row and is dropped here rather than joined to an arbitrary one.
  function mergeTelemetry(telemetry, diagnostics) {
    if (!telemetry) return;
    const stepId = telemetry.issuingStepId;
    if (typeof stepId !== 'string' || stepId.length === 0) return;
    const facts = factsFor(stepId);
    if (telemetry.toolUseId != null) facts.toolUseIds.add(telemetry.toolUseId);
    if (typeof telemetry.loadToken === 'string' && telemetry.loadToken.length > 0) {
      if (facts.loadToken === null) facts.loadToken = telemetry.loadToken;
      else if (facts.loadToken !== telemetry.loadToken) {
        // One step carries one load: the first token is the one whose handoff this step actually loaded, and
        // a second one is reported rather than silently replacing it.
        diagnostics.push(diagnostic('multiple_load_tokens',
          `step ${stepId} keeps its first load token`));
      }
    }
    for (const event of telemetry.pathEvents ?? []) facts.pathEvents.push(event);
  }

  // Native interpretation returns effects and residuals in the Engine's own shape minus its discriminant,
  // and they are forwarded unchanged: the Projection interprets no fragment key, reprices nothing, and
  // classifies no completion.
  function pushRecords(interpreted, records) {
    for (const effect of interpreted.effects) records.push({ type: 'effect', ...effect });
    for (const residual of interpreted.residuals) records.push({ type: 'residual', ...residual });
  }

  function projectToolUse(observation, records, diagnostics) {
    const interpreted = interpretToolUse(observation, context);
    mergeTelemetry(interpreted.telemetry, diagnostics);
    if (interpreted.pending) {
      correlationByToolUseId.set(observation.toolUseId, { phase: 'await-result', pending: interpreted.pending });
    }
    pushRecords(interpreted, records);
  }

  function projectToolResult(observation, records, diagnostics) {
    const entry = correlationByToolUseId.get(observation.toolUseId);
    // A missing `await-result` entry is a duplicate result, a use whose epoch closed, or a use that carried
    // no correlation at all — each of which completes nothing.
    if (!entry || entry.phase !== 'await-result') return;
    correlationByToolUseId.delete(observation.toolUseId);
    const completed = completeToolResult(entry.pending, observation, context);
    mergeTelemetry(completed.telemetry, diagnostics);
    if (completed.skillContinuation) {
      correlationByToolUseId.set(observation.toolUseId, {
        phase: 'await-skill-payload',
        resourceKey: completed.skillContinuation.resourceKey,
        issuingPolicy: completed.skillContinuation.issuingPolicy,
      });
    }
    pushRecords(completed, records);
  }

  function projectSkillPayload(observation, records, diagnostics) {
    const entry = correlationByToolUseId.get(observation.toolUseId);
    if (!entry || entry.phase !== 'await-skill-payload') return;
    correlationByToolUseId.delete(observation.toolUseId);
    const interpreted = interpretSkillPayload(
      { resourceKey: entry.resourceKey, issuingPolicy: entry.issuingPolicy }, observation,
    );
    mergeTelemetry(interpreted.telemetry, diagnostics);
    pushRecords(interpreted, records);
  }

  function project(observation) {
    invariant(observation !== null && typeof observation === 'object', 'observation must be an object');
    const records = [];
    const diagnostics = [];
    switch (observation.type) {
      case 'epoch-boundary':
        // Every pending correlation belonged to the epoch that is closing, so clearing the map is also what
        // discards a result whose issuing epoch is gone: there is no entry left for it to complete.
        correlationByToolUseId = new Map();
        records.push({ type: 'epoch' });
        break;
      case 'turn-boundary':
        records.push({ type: 'turn-boundary' });
        break;
      case 'usage':
        records.push({
          type: 'step',
          id: observation.messageId,
          model: observation.model ?? null,
          timestamp: observation.timestamp ?? null,
          usage: {
            input: observation.usage.input,
            output: observation.usage.output,
            cacheRead: observation.usage.cacheRead,
            cacheWrite: observation.usage.cacheWrite,
          },
        });
        break;
      case 'tool-use':
        projectToolUse(observation, records, diagnostics);
        break;
      case 'tool-result':
        projectToolResult(observation, records, diagnostics);
        break;
      case 'skill-payload':
        projectSkillPayload(observation, records, diagnostics);
        break;
      case 'task-notification':
        // A sub-agent completion notice is residual evidence on its own, with no tool use to correlate and
        // no step whose telemetry it belongs to.
        pushRecords(interpretTaskNotification(observation), records);
        break;
      case 'text':
        break;
      default:
        invariant(false, `unsupported observation type: ${String(observation.type)}`);
    }
    return { records, diagnostics };
  }

  // The sidecar's whole lifecycle: every successful epoch, rotate, or explicit close calls this once. The
  // new sidecar is installed before the join runs, so a join failure loses only the closing facts and later
  // observations keep accumulating into a live sidecar. The correlation map goes with it: a segment boundary
  // that arrives as this call rather than as an `epoch` record ends the epoch every armed correlation was
  // issued in, and a result completed afterwards would grow the new segment's belief.
  function finishSegment(closedSegment, { captureMode = 'live' } = {}) {
    const closing = sidecarByStepId;
    sidecarByStepId = new Map();
    correlationByToolUseId = new Map();
    const diagnostics = [];
    if (closedSegment == null) return { artifact: null, diagnostics };
    let payload;
    try {
      payload = joinFacts(closing, closedSegment);
    } catch (error) {
      // Telemetry is archival, and the Engine transition it follows already completed: the failure is
      // reported and the flow continues without it.
      diagnostics.push(diagnostic('segment_telemetry_join_failed', `telemetry join failed: ${error.message}`));
      return { artifact: null, diagnostics };
    }
    return {
      artifact: { captureSource: captureMode === 'replay' ? 'cc-replay' : 'cc-live', payload },
      diagnostics,
    };
  }

  return { project, finishSegment };
}
