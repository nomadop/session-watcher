// lib/measurement-projection.js — shared Measurement Projection.
// Turns one ordered normalized observation into MeasurementRecords, and owns the two pieces of state that
// are nobody else's: the native tool correlation (which tool use is still waiting for which result) and the
// Segment Telemetry sidecar for the current segment. Both are Projection-local — a pending correlation
// reaches no Engine record, and no telemetry fact alters measurement.
//
// It speaks the Engine's record vocabulary as plain discriminant strings and imports nothing from
// `lib/measurement/`: the record Interface is local, trusted, unversioned data, so a shared constant would
// only re-couple the two owners. Native interpretation arrives as injected functions, so this module holds
// no tool name, adapter, or result-parsing rule of its own.

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

export function createMeasurementProjection({
  scope,
  context,
  captureSources,
  interpretToolUse,
  completeToolResult,
  interpretSkillPayload,
}) {
  const invariantPrefix = `${scope.replaceAll('-', ' ')} invariant`;

  function invariant(ok, message) {
    if (!ok) throw new Error(`${invariantPrefix}: ${message}`);
  }

  function diagnostic(code, message) {
    return { scope, code, message };
  }

  // One call per tool use id per epoch, charged at its first result, with one phase per id: `held` (a
  // result seen before any use — the Source does not order a result after its use), `issued` (a use with
  // nothing to await), `await-result`, `await-skill-payload`, `completed`. A use whose call is past its
  // result is a revision of that call and arms nothing.
  let callByToolUseId = new Map();
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
    const id = observation.toolUseId;
    const entry = callByToolUseId.get(id);
    if (entry && (entry.phase === 'await-skill-payload' || entry.phase === 'completed')) return;
    const interpreted = interpretToolUse(observation, context);
    mergeTelemetry(interpreted.telemetry, diagnostics);
    callByToolUseId.set(id, interpreted.pending
      ? { phase: 'await-result', pending: interpreted.pending }
      : { phase: 'issued' });
    pushRecords(interpreted, records);
    if (entry && entry.phase === 'held') projectToolResult(entry.result, records, diagnostics);
  }

  function projectToolResult(observation, records, diagnostics) {
    const id = observation.toolUseId;
    const entry = callByToolUseId.get(id);
    if (!entry) { callByToolUseId.set(id, { phase: 'held', result: observation }); return; }
    // The answer to a use that carried no correlation completes its call and charges nothing.
    if (entry.phase === 'issued') { callByToolUseId.set(id, { phase: 'completed' }); return; }
    // Every other phase but `await-result` makes this a duplicate result, which completes nothing.
    if (entry.phase !== 'await-result') return;
    const completed = completeToolResult(entry.pending, observation, context);
    mergeTelemetry(completed.telemetry, diagnostics);
    callByToolUseId.set(id, completed.skillContinuation
      ? {
        phase: 'await-skill-payload',
        resourceKey: completed.skillContinuation.resourceKey,
        issuingPolicy: completed.skillContinuation.issuingPolicy,
      }
      : { phase: 'completed' });
    pushRecords(completed, records);
  }

  function projectSkillPayload(observation, records, diagnostics) {
    const entry = callByToolUseId.get(observation.toolUseId);
    if (!entry || entry.phase !== 'await-skill-payload') return;
    callByToolUseId.set(observation.toolUseId, { phase: 'completed' });
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
        // Clearing ends every call the closing epoch issued: a result arriving afterwards finds no use and is
        // held, completing nothing unless its use comes again in this epoch.
        callByToolUseId = new Map();
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
      case 'text':
        break;
      default:
        invariant(false, `unsupported observation type: ${String(observation.type)}`);
    }
    return { records, diagnostics };
  }

  // The sidecar's whole lifecycle: every successful epoch, rotate, or explicit close calls this once. The
  // new sidecar is installed before the join runs, so a join failure loses only the closing facts and later
  // observations keep accumulating into a live sidecar. The call state goes with it: a segment boundary
  // that arrives as this call rather than as an `epoch` record ends the epoch every armed correlation was
  // issued in, and a result completed afterwards would grow the new segment's belief.
  function finishSegment(closedSegment, { captureMode = 'live' } = {}) {
    const closing = sidecarByStepId;
    sidecarByStepId = new Map();
    callByToolUseId = new Map();
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
      artifact: {
        captureSource: captureMode === 'replay' ? captureSources.replay : captureSources.live,
        payload,
      },
      diagnostics,
    };
  }

  return { project, finishSegment };
}
